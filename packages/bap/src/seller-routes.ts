/**
 * Seller (BPP) Routes - Select, Init, Confirm, Status + Seller Management APIs
 * With concurrency-safe operations using distributed locks
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  SelectMessage,
  OnSelectMessage,
  InitMessage,
  OnInitMessage,
  ConfirmMessage,
  OnConfirmMessage,
  StatusMessage,
  OnStatusMessage,
  createAck,
  createNack,
  createCallbackContext,
  createLogger,
  config,
  ErrorCodes,
  OrderItem,
  Quote,
  updateTrustAfterSellerCancel,
  withOrderLock,
  withTransactionLock,
  InsufficientBlocksError,
  createIdempotencyMiddleware,
  syncProviderToCDS,
  syncItemToCDS,
  syncOfferToCDS,
  syncCompleteOfferToCDS,
  syncBlocksToCDS,
  deleteOfferFromCDS,
  publishOfferToCDS,
  publishCatalogToCDS,
  isValidTimeWindow,
  validateQuantity,
  roundQuantity,
  snapTimeWindow,
  checkTradeWindow,
  // Beckn v2 wire-format parsers/builders
  parseWireSelectMessage,
  parseWireConfirmMessage,
  parseWireStatusMessage,
  buildWireResponseOrder,
  buildWireOrder,
  getBppKeyPair,
  isSigningEnabled,
  // Weather module
  getWeatherAdjustedCapacity,
  getMaintenanceAlert,
  extractMaintenanceData,
  getWeatherForecast,
  geocodeAddress,
  type SourceType,
} from '@p2p/shared';
import {
  getOfferById,
  getItemAvailableQuantity,
  getProvider,
  updateProviderStats,
  registerProvider,
  getAllProviders,
  addCatalogItem,
  getProviderItems,
  getAllItems,
  addOffer,
  getProviderOffers,
  getAllOffers,
  updateItemQuantity,
  deleteOffer,
  claimBlocks,
  claimBlocksStrict,
  markBlocksAsSold,
  releaseBlocks,
  releaseBlocksByOrderId,
  getBlockStats,
  getAvailableBlockCount,
  getBlocksForOrder,
  updateBlocksOrderId,
} from './seller-catalog';
import {
  getOrderByTransactionId,
  getOrderById,
  createOrder,
  updateOrderStatus,
  updateOrderStatusByTransactionId,
  getOrdersByProviderId,
  getOrdersForSeller,
  getAllOrders,
} from './seller-orders';
import { logEvent, isDuplicateMessage } from './events';
import { authMiddleware } from './middleware/auth';
import { prisma } from './db';
import { getTransaction } from './state';

const router = Router();
const logger = createLogger('BPP');

/**
 * Middleware: Require Generation or Storage VC to access seller operations
 */
async function requireSellerVC(req: Request, res: Response, next: () => void): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    const sellerVC = await prisma.userCredential.findFirst({
      where: {
        userId,
        credentialType: { in: ['GENERATION_PROFILE', 'STORAGE_PROFILE'] },
        verified: true,
      },
    });

    if (!sellerVC) {
      res.status(403).json({
        success: false,
        error: 'Seller credential required',
        requiresVC: ['GENERATION_PROFILE', 'STORAGE_PROFILE'],
        message: 'Upload a Generation Profile or Storage Profile VC to sell energy',
      });
      return;
    }

    next();
  } catch (error: any) {
    logger.error(`requireSellerVC middleware error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to verify seller credentials',
    });
  }
}

/**
 * Helper: Look up provider's user utility info for CDS publishing
 */
async function getProviderUtilityInfo(providerId: string): Promise<{ utilityId: string; utilityCustomerId: string }> {
  try {
    const user = await prisma.user.findFirst({
      where: { providerId },
      select: { consumerNumber: true, meterNumber: true },
    });
    return {
      utilityId: config.utility.id,
      utilityCustomerId: user?.consumerNumber || 'UNKNOWN',
    };
  } catch {
    return { utilityId: config.utility.id, utilityCustomerId: 'UNKNOWN' };
  }
}

/**
 * Helper: Enrich a SyncItem array with utility info from DB
 */
async function enrichSyncItems(items: Array<{ id: string; provider_id: string; source_type: string; delivery_mode: string; available_qty: number; production_windows: any[]; meter_id: string }>, providerId: string) {
  const utilityInfo = await getProviderUtilityInfo(providerId);
  return items.map(item => ({
    ...item,
    utility_id: utilityInfo.utilityId,
    utility_customer_id: utilityInfo.utilityCustomerId,
  }));
}

/**
 * Helper: Get buyer ID from transaction state
 * Handles bulk sub-transactions (e.g. "main-uuid_0") by trying the parent transaction,
 * and falls back to looking up the Order record in the database.
 */
async function getBuyerIdFromTransaction(transactionId: string, orderId?: string): Promise<string | null> {
  try {
    // 1. Direct Redis lookup
    const txState = await getTransaction(transactionId);
    if (txState?.buyerId) return txState.buyerId;

    // 2. For sub-transactions (bulk mode: "main-uuid_0"), try parent transaction
    const underscoreIdx = transactionId.lastIndexOf('_');
    if (underscoreIdx > 0) {
      const parentTxnId = transactionId.slice(0, underscoreIdx);
      const parentState = await getTransaction(parentTxnId);
      if (parentState?.buyerId) return parentState.buyerId;
    }

    // 3. Fallback: look up from the Order record in DB
    if (orderId) {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        select: { buyerId: true },
      });
      if (order?.buyerId) return order.buyerId;
    }

    // 4. Last resort: find any order with this transactionId
    const orderByTxn = await prisma.order.findFirst({
      where: { transactionId },
      select: { buyerId: true },
    });
    return orderByTxn?.buyerId || null;
  } catch {
    return null;
  }
}

/**
 * Helper: Get seller user ID from provider ID
 */
async function getSellerIdFromProvider(providerId: string): Promise<string | null> {
  if (!providerId) return null;
  try {
    const user = await prisma.user.findFirst({
      where: { providerId },
      select: { id: true },
    });
    return user?.id || null;
  } catch {
    return null;
  }
}

/**
 * POST /select - Handle offer selection
 */
router.post('/select', async (req: Request, res: Response) => {
  const message = req.body as SelectMessage;
  const { context, message: content } = message;

  logger.info('Received select request', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });

  // Check for duplicate message
  if (await isDuplicateMessage(context.message_id)) {
    logger.warn('Duplicate message detected, returning ACK', {
      transaction_id: context.transaction_id,
      message_id: context.message_id,
    });
    return res.json(createAck(context));
  }

  // Log inbound event
  await logEvent(context.transaction_id, context.message_id, 'select', 'INBOUND', JSON.stringify(message));

  // Parse both Beckn v2 wire format and internal format
  const parsed = parseWireSelectMessage(content);
  const wireOrder = (content as any).order; // Keep original wire order for response

  // Validate offers and quantities
  const validationErrors: string[] = [];
  const orderItems: OrderItem[] = [];
  let totalPrice = 0;
  let totalQuantity = 0;
  let currency = 'INR';
  let providerId = '';

  for (const item of parsed.items) {
    const offer = await getOfferById(item.offer_id);

    if (!offer) {
      validationErrors.push(`Offer ${item.offer_id} not found`);
      continue;
    }

    providerId = offer.provider_id;

    // Resolve item_id: prefer request value, fall back to offer's own item_id from DB
    const resolvedItemId = item.item_id || offer.item_id;

    // Check available blocks instead of max quantity
    const availableBlocks = await getAvailableBlockCount(item.offer_id);
    if (item.quantity > availableBlocks) {
      validationErrors.push(`Requested quantity ${item.quantity} exceeds available blocks ${availableBlocks}`);
    }

    // Also check item-level availability as a safety check
    if (resolvedItemId) {
      const availableQty = await getItemAvailableQuantity(resolvedItemId);
      if (availableQty !== null && item.quantity > availableQty) {
        validationErrors.push(`Requested quantity ${item.quantity} exceeds item available ${availableQty}`);
      }
    }

    // Calculate prices
    const itemPrice = offer.price.value * item.quantity;
    totalPrice += itemPrice;
    totalQuantity += item.quantity;
    currency = offer.price.currency;

    // Get source_type from item
    const catalogItem = resolvedItemId ? await prisma.catalogItem.findUnique({
      where: { id: resolvedItemId },
      select: { sourceType: true },
    }) : null;

    orderItems.push({
      item_id: resolvedItemId || item.item_id,
      offer_id: item.offer_id,
      provider_id: offer.provider_id,
      quantity: item.quantity,
      price: { value: itemPrice, currency },
      timeWindow: offer.timeWindow,
      source_type: catalogItem?.sourceType || 'UNKNOWN',
    });
  }

  if (validationErrors.length > 0) {
    return res.json(createNack(context, {
      code: ErrorCodes.INVALID_REQUEST,
      message: validationErrors.join('; '),
    }));
  }

  // Send ACK
  res.json(createAck(context));

  // Send callback asynchronously
  setTimeout(async () => {
    try {
      const callbackContext = createCallbackContext(context, 'on_select');
      const provider = await getProvider(providerId);

      const quote: Quote = {
        price: { value: totalPrice, currency },
        totalQuantity,
      };

      // Build Beckn v2 wire-format response
      // Echo back the wire order from the request, or build a new one
      const onSelectWireOrder = wireOrder
        ? { ...wireOrder, 'beckn:orderStatus': 'CREATED' }
        : buildWireResponseOrder({ status: 'CREATED' }, null);

      const onSelectMessage = {
        context: callbackContext,
        message: { order: onSelectWireOrder },
      };

      await logEvent(context.transaction_id, callbackContext.message_id, 'on_select', 'OUTBOUND', JSON.stringify(onSelectMessage));

      const callbackUrl = `${context.bap_uri}/callbacks/on_select`;
      logger.info(`Sending on_select callback to ${callbackUrl}`, {
        transaction_id: context.transaction_id,
        action: 'on_select',
      });

      await axios.post(callbackUrl, onSelectMessage);
      logger.info('on_select callback sent successfully', { transaction_id: context.transaction_id });
    } catch (error: any) {
      logger.error(`Failed to send on_select callback: ${error.message}`, { transaction_id: context.transaction_id });
    }
  }, config.callbackDelay);
});

/**
 * POST /init - Initialize order (create draft)
 */
router.post('/init', async (req: Request, res: Response) => {
  const message = req.body as any; // Accept both Beckn v2 and internal format
  const { context, message: content } = message;
  // Parse wire format to get items in internal format
  const parsedInit = parseWireSelectMessage(content);
  const wireInitOrder = content.order; // Keep for response echoing

  logger.info('Received init request', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });

  if (await isDuplicateMessage(context.message_id)) {
    logger.warn('Duplicate message detected', { transaction_id: context.transaction_id });
    return res.json(createAck(context));
  }

  await logEvent(context.transaction_id, context.message_id, 'init', 'INBOUND', JSON.stringify(message));

  // Check if order already exists for this transaction
  const existingOrder = await getOrderByTransactionId(context.transaction_id);
  if (existingOrder) {
    logger.info('Order already exists for transaction', { transaction_id: context.transaction_id });
    res.json(createAck(context));

    // CRITICAL FIX: Check if blocks are claimed for this order
    // If init is called multiple times, blocks may not be associated with the order yet
    setTimeout(async () => {
      try {
        // Check if blocks exist for this order
        const existingBlocks = await getBlocksForOrder(existingOrder.id);

        if (existingBlocks.length === 0 && existingOrder.items && existingOrder.items.length > 0) {
          // No blocks claimed - this can happen when init is called twice
          // Try to claim blocks for each item in the order
          logger.warn('Order exists but has no blocks - attempting to claim blocks', {
            transaction_id: context.transaction_id,
            order_id: existingOrder.id,
          });

          for (const item of existingOrder.items) {
            // Only claim for local offers (not external)
            const localOffer = await getOfferById(item.offer_id);
            if (localOffer) {
              const claimedBlocks = await claimBlocks(
                item.offer_id,
                item.quantity,
                existingOrder.id,
                context.transaction_id
              );

              logger.info(`Claimed ${claimedBlocks.length} blocks for existing order`, {
                transaction_id: context.transaction_id,
                order_id: existingOrder.id,
                offer_id: item.offer_id,
                requested: item.quantity,
                claimed: claimedBlocks.length,
              });
            }
          }
        }

        const callbackContext = createCallbackContext(context, 'on_init');
        const onInitMessage: OnInitMessage = {
          context: callbackContext,
          message: { order: existingOrder },
        };

        await logEvent(context.transaction_id, callbackContext.message_id, 'on_init', 'OUTBOUND', JSON.stringify(onInitMessage));
        await axios.post(`${context.bap_uri}/callbacks/on_init`, onInitMessage);
      } catch (error: any) {
        logger.error(`Failed to send on_init callback: ${error.message}`, { transaction_id: context.transaction_id });
      }
    }, config.callbackDelay);

    return;
  }

  res.json(createAck(context));

  setTimeout(async () => {
    try {
      // Get buyer ID from transaction state
      const { getTransactionState, updateTransactionState } = await import('@p2p/shared');
      const txState = await getTransactionState(context.transaction_id);
      const buyerId = txState?.buyerId || parsedInit.buyerId || null;
      const initItems = parsedInit.items;
      const isBulkMode = txState?.bulkMode && initItems.length > 1;

      // Check buyer trust score - advisory warning if below 20% (no longer blocks)
      if (buyerId) {
        const buyer = await prisma.user.findUnique({
          where: { id: buyerId },
          select: { trustScore: true },
        });

        if (buyer && buyer.trustScore < 0.2) {
          logger.warn(`Buyer trust score low (advisory): ${(buyer.trustScore * 100).toFixed(1)}%`, {
            transaction_id: context.transaction_id,
            buyerId,
            advisory: true,
          });

          // Store warning in transaction state for UI to display
          await updateTransactionState(context.transaction_id, {
            trustWarning: {
              score: buyer.trustScore,
              percentage: (buyer.trustScore * 100).toFixed(0),
              message: `Your trust score (${(buyer.trustScore * 100).toFixed(0)}%) is low. Sellers may be cautious. Complete trades successfully to improve your reputation.`,
            },
          });

          // Continue with trade (advisory only, no longer blocks)
        }
      }

      // ==================== BULK MODE: Create separate orders ====================
      if (isBulkMode) {
        logger.info(`Bulk mode: Creating ${initItems.length} separate orders`, {
          transaction_id: context.transaction_id,
          itemCount: initItems.length,
        });

        const bulkGroupId = context.transaction_id;
        const createdOrders: any[] = [];
        const failedItems: Array<{ offer_id: string; reason: string }> = [];

        for (let i = 0; i < initItems.length; i++) {
          const item = initItems[i];
          const subTransactionId = `${context.transaction_id}_${i}`;

          try {
            const localOffer = await getOfferById(item.offer_id);
            if (!localOffer) {
              failedItems.push({ offer_id: item.offer_id, reason: 'Offer not found' });
              continue;
            }

            const itemPrice = localOffer.price.value * item.quantity;
            const currency = localOffer.price.currency;

            // Get source_type from catalog item
            const catalogItem = await prisma.catalogItem.findUnique({
              where: { id: item.item_id },
              select: { sourceType: true },
            });

            const orderItem: OrderItem = {
              item_id: item.item_id,
              offer_id: item.offer_id,
              provider_id: localOffer.provider_id,
              quantity: item.quantity,
              price: { value: itemPrice, currency },
              timeWindow: localOffer.timeWindow,
              source_type: catalogItem?.sourceType || 'UNKNOWN',
            };

            const quote: Quote = {
              price: { value: itemPrice, currency },
              totalQuantity: item.quantity,
            };

            // Create order in DRAFT state
            const order = await createOrder(
              subTransactionId,
              localOffer.provider_id,
              localOffer.id,
              [orderItem],
              quote,
              'DRAFT',
              buyerId,
              bulkGroupId // Pass bulk group ID
            );

            // Claim blocks for this order
            const claimedBlocks = await claimBlocks(item.offer_id, item.quantity, order.id, subTransactionId);

            if (claimedBlocks.length < item.quantity) {
              // Not enough blocks - release and skip this item
              await releaseBlocks(subTransactionId);
              failedItems.push({
                offer_id: item.offer_id,
                reason: claimedBlocks.length === 0
                  ? 'Sold out'
                  : `Only ${claimedBlocks.length}/${item.quantity} kWh available`,
              });
              continue;
            }

            // Sync reserved blocks to CDS (non-blocking)
            syncBlocksToCDS({
              offer_id: item.offer_id,
              block_ids: claimedBlocks.map(b => b.id),
              status: 'RESERVED',
              order_id: order.id,
              transaction_id: subTransactionId,
            }).catch(syncError =>
              logger.error('Failed to sync reserved blocks to CDS', {
                offerId: item.offer_id,
                blockCount: claimedBlocks.length,
                error: syncError.message
              })
            );

            // Update order status to PENDING
            const finalOrder = await updateOrderStatus(order.id, 'PENDING') || order;
            createdOrders.push(finalOrder);

            logger.info(`Bulk order ${i + 1}/${initItems.length} created`, {
              order_id: order.id,
              offer_id: item.offer_id,
              quantity: item.quantity,
              transaction_id: subTransactionId,
            });
          } catch (itemError: any) {
            logger.error(`Failed to create bulk order for item ${i}`, {
              offer_id: item.offer_id,
              error: itemError.message,
            });
            failedItems.push({ offer_id: item.offer_id, reason: itemError.message });
          }
        }

        // Store bulk orders info in transaction state
        await updateTransactionState(context.transaction_id, {
          bulkOrders: createdOrders.map(o => ({
            id: o.id,
            transactionId: o.transactionId || o.transaction_id,
            status: o.status,
          })),
        });

        // Send callback with first order (for compatibility) but include all orders
        if (createdOrders.length > 0) {
          const callbackContext = createCallbackContext(context, 'on_init');
          const onInitMessage = {
            context: callbackContext,
            message: {
              order: createdOrders[0], // Primary order for compatibility
              bulkOrders: createdOrders, // All orders for bulk mode
              bulkGroupId,
              failedItems: failedItems.length > 0 ? failedItems : undefined,
            },
          };

          await logEvent(context.transaction_id, callbackContext.message_id, 'on_init', 'OUTBOUND', JSON.stringify(onInitMessage));
          await axios.post(`${context.bap_uri}/callbacks/on_init`, onInitMessage);

          logger.info(`Bulk init complete: ${createdOrders.length} orders created, ${failedItems.length} failed`, {
            transaction_id: context.transaction_id,
          });
        } else {
          // All items failed
          const errorCallbackContext = createCallbackContext(context, 'on_init');
          const errorCallback = {
            context: errorCallbackContext,
            error: {
              code: 'BULK_ORDER_FAILED',
              message: `All ${initItems.length} items failed to process`,
              failedItems,
            },
          };

          await axios.post(`${context.bap_uri}/callbacks/on_init`, errorCallback);
        }

        return; // Exit for bulk mode
      }

      // ==================== SINGLE ORDER MODE (original logic) ====================
      // Build order items and quote
      const orderItems: OrderItem[] = [];
      let totalPrice = 0;
      let totalQuantity = 0;
      let currency = 'INR';
      let providerId = parsedInit.sellerId || content.order?.provider?.id || '';
      let selectedOfferId = '';
      let isExternalOffer = false;

      // First pass: calculate prices and validate offers exist
      for (const item of initItems) {
        // Try to get offer from local database first
        const localOffer = await getOfferById(item.offer_id);

        if (localOffer) {
          // Local offer - use local data
          selectedOfferId = localOffer.id;
          const itemPrice = localOffer.price.value * item.quantity;
          totalPrice += itemPrice;
          totalQuantity += item.quantity;
          currency = localOffer.price.currency;

          // Get source_type from catalog item
          const catalogItem = await prisma.catalogItem.findUnique({
            where: { id: item.item_id },
            select: { sourceType: true },
          });

          orderItems.push({
            item_id: item.item_id,
            offer_id: item.offer_id,
            provider_id: localOffer.provider_id,
            quantity: item.quantity,
            price: { value: itemPrice, currency },
            timeWindow: localOffer.timeWindow,
            source_type: catalogItem?.sourceType || 'UNKNOWN',
          });
        } else {
          // External offer - try to get data from transaction state
          isExternalOffer = true;
          selectedOfferId = item.offer_id;

          // Get offer details from transaction state (populated during discovery)
          const selectedOffer = txState?.selectedOffer;

          if (selectedOffer && selectedOffer.id === item.offer_id) {
            const itemPrice = selectedOffer.price.value * item.quantity;
            totalPrice += itemPrice;
            totalQuantity += item.quantity;
            currency = selectedOffer.price.currency || 'INR';

            orderItems.push({
              item_id: item.item_id,
              offer_id: item.offer_id,
              provider_id: providerId,
              quantity: item.quantity,
              price: { value: itemPrice, currency },
              timeWindow: selectedOffer.timeWindow || undefined,
              source_type: 'EXTERNAL',
            });

            logger.info('Processing external offer from transaction state', {
              transaction_id: context.transaction_id,
              offer_id: item.offer_id,
              price: selectedOffer.price.value,
            });
          } else {
            // No offer data available - log error but continue
            logger.warn('External offer not found in transaction state', {
              transaction_id: context.transaction_id,
              offer_id: item.offer_id,
            });

            // Use default values from request
            totalQuantity += item.quantity;
            orderItems.push({
              item_id: item.item_id,
              offer_id: item.offer_id,
              provider_id: providerId,
              quantity: item.quantity,
              price: { value: 0, currency },
              timeWindow: undefined,
              source_type: 'EXTERNAL',
            });
          }
        }
      }

      const quote: Quote = {
        price: { value: totalPrice, currency },
        totalQuantity,
      };

      // Create order first in DRAFT state (so we have a valid order ID for FK constraint)
      const order = await createOrder(context.transaction_id, providerId, selectedOfferId, orderItems, quote, 'DRAFT', buyerId);

      // Only claim blocks for local offers (external offers don't have local blocks)
      if (!isExternalOffer) {
        // Now claim blocks using the real order ID
        for (const item of initItems) {
          const claimedBlocks = await claimBlocks(item.offer_id, item.quantity, order.id, context.transaction_id);

          if (claimedBlocks.length < item.quantity) {
            // Not enough blocks available - release any claimed blocks and send error callback
            await releaseBlocks(context.transaction_id);
            const errorMsg = claimedBlocks.length === 0
              ? 'This offer is sold out. Please try a different offer.'
              : `Only ${claimedBlocks.length} kWh available, but you requested ${item.quantity} kWh.`;

            logger.error(`Not enough blocks available: requested ${item.quantity}, got ${claimedBlocks.length}`, {
              transaction_id: context.transaction_id,
              offer_id: item.offer_id,
            });

            // Send error callback
            const errorCallbackContext = createCallbackContext(context, 'on_init');
            const errorCallback = {
              context: errorCallbackContext,
              error: {
                code: 'INSUFFICIENT_INVENTORY',
                message: errorMsg,
              },
            };

            try {
              await axios.post(`${context.bap_uri}/callbacks/on_init`, errorCallback);
            } catch (e) {
              logger.error('Failed to send error callback');
            }

            return; // Exit the setTimeout callback
          }

          // Sync reserved blocks to CDS (non-blocking)
          syncBlocksToCDS({
            offer_id: item.offer_id,
            block_ids: claimedBlocks.map(b => b.id),
            status: 'RESERVED',
            order_id: order.id,
            transaction_id: context.transaction_id,
          }).catch(syncError =>
            logger.error('Failed to sync reserved blocks to CDS', {
              offerId: item.offer_id,
              blockCount: claimedBlocks.length,
              error: syncError.message
            })
          );
        }
      } else {
        logger.info('Skipping block claiming for external offer', {
          transaction_id: context.transaction_id,
          providerId,
        });
      }

      // Update order status to PENDING now that blocks are claimed (or immediately for external)
      const finalOrder = await updateOrderStatus(order.id, 'PENDING') || order;

      const callbackContext = createCallbackContext(context, 'on_init');
      // Build wire-format response: echo the incoming order with assigned ID
      const onInitWireOrder = wireInitOrder
        ? { ...wireInitOrder, 'beckn:id': finalOrder.id, 'beckn:orderStatus': 'CREATED' }
        : buildWireResponseOrder(finalOrder, null, finalOrder.id);

      const onInitMessage = {
        context: callbackContext,
        message: { order: onInitWireOrder, _internalOrder: finalOrder },
      };

      await logEvent(context.transaction_id, callbackContext.message_id, 'on_init', 'OUTBOUND', JSON.stringify(onInitMessage));

      const callbackUrl = `${context.bap_uri}/callbacks/on_init`;
      logger.info(`Sending on_init callback to ${callbackUrl}`, {
        transaction_id: context.transaction_id,
        action: 'on_init',
      });

      await axios.post(callbackUrl, onInitMessage);
      logger.info('on_init callback sent successfully', { transaction_id: context.transaction_id });
    } catch (error: any) {
      logger.error(`Failed to send on_init callback: ${error.message}`, { transaction_id: context.transaction_id });
    }
  }, config.callbackDelay);
});

/**
 * POST /confirm - Confirm order (make it active)
 * CONCURRENCY SAFE: Uses distributed lock on order to prevent double-confirmation
 */
router.post('/confirm', async (req: Request, res: Response) => {
  const message = req.body as ConfirmMessage;
  const { context, message: content } = message;

  logger.info('Received confirm request', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });

  if (await isDuplicateMessage(context.message_id)) {
    logger.warn('Duplicate message detected', { transaction_id: context.transaction_id });
    return res.json(createAck(context));
  }

  await logEvent(context.transaction_id, context.message_id, 'confirm', 'INBOUND', JSON.stringify(message));

  // Parse wire format (supports both beckn:id and internal id)
  const confirmOrderId = parseWireConfirmMessage(content);

  // Get existing order
  let order = await getOrderById(confirmOrderId) || await getOrderByTransactionId(context.transaction_id);

  if (!order) {
    return res.json(createNack(context, {
      code: ErrorCodes.ORDER_NOT_FOUND,
      message: `Order ${confirmOrderId} not found`,
    }));
  }

  res.json(createAck(context));

  setTimeout(async () => {
    try {
      // Use distributed lock to prevent concurrent confirmations
      await withOrderLock(order!.id, async () => {
        // Re-fetch order inside lock to get current status
        const currentOrder = await getOrderById(order!.id);

        // Idempotent confirm: only update if not already ACTIVE
        if (currentOrder && currentOrder.status !== 'ACTIVE') {
          order = await updateOrderStatus(order!.id, 'ACTIVE');
          logger.info('Order status updated to ACTIVE', { transaction_id: context.transaction_id, order_id: order!.id });

          // Mark reserved blocks as SOLD (also uses lock internally)
          const soldCount = await markBlocksAsSold(order!.id);
          const soldBlocks = await getBlocksForOrder(order!.id);
          logger.info(`Marked ${soldCount} blocks as SOLD for order ${order!.id}`, { transaction_id: context.transaction_id });

          // Sync block status to CDS (non-blocking)
          if (soldBlocks.length > 0 && order!.items && order!.items.length > 0) {
            const firstItem = order!.items[0];
            syncBlocksToCDS({
              offer_id: firstItem.offer_id,
              block_ids: soldBlocks.map(b => b.id),
              status: 'SOLD',
              order_id: order!.id,
              transaction_id: context.transaction_id,
            }).catch(syncError =>
              logger.error('Failed to sync block status to CDS', {
                offerId: firstItem.offer_id,
                blockCount: soldBlocks.length,
                error: syncError.message
              })
            );

            // NOTE: We no longer auto-delete offers when fully sold
            // This ensures "total offered" tracking remains accurate for trade limit calculations
            // Sold-out offers are hidden from discovery (CDS filters by available > 0)
            const offerStats = await getBlockStats(firstItem.offer_id);
            if (offerStats.available === 0) {
              logger.info(
                `Offer ${firstItem.offer_id} is now sold out (${offerStats.sold} blocks sold)`,
                { transaction_id: context.transaction_id }
              );
            }
          }

          // Reduce item available quantity when order is confirmed (for item-level tracking)
          if (order!.items && order!.items.length > 0) {
            for (const orderItem of order!.items) {
              const currentQty = await getItemAvailableQuantity(orderItem.item_id);
              if (currentQty !== null) {
                const soldQty = orderItem.quantity; // This is the actual purchased quantity from blocks
                const newQty = Math.max(0, currentQty - soldQty);

                await updateItemQuantity(orderItem.item_id, newQty);
                logger.info(`Item ${orderItem.item_id} quantity reduced: ${currentQty} → ${newQty} kWh (sold: ${soldQty} kWh)`, {
                  transaction_id: context.transaction_id,
                });

              }
            }

            // Republish catalog to CDS in background (non-blocking, fire-and-forget)
            // This ensures order confirmation + escrow + on_confirm are not blocked by CDS issues
            if (order!.items && order!.items.length > 0) {
              const sellerProviderId = order!.items[0].provider_id;
              if (sellerProviderId) {
                (async () => {
                  try {
                    const providerInfo = await getProvider(sellerProviderId);
                    const providerName = providerInfo?.name || 'Energy Provider';
                    const allItems = await getProviderItems(sellerProviderId);
                    const allOffers = await getProviderOffers(sellerProviderId);

                    const rawSyncItems = allItems.map(item => ({
                      id: item.id,
                      provider_id: item.provider_id,
                      source_type: item.source_type,
                      delivery_mode: item.delivery_mode,
                      available_qty: item.available_qty,
                      production_windows: item.production_windows,
                      meter_id: item.meter_id,
                    }));
                    const syncItems = await enrichSyncItems(rawSyncItems, sellerProviderId);

                    const syncOffers = await Promise.all(allOffers.map(async (offer) => {
                      const availableBlocks = await getAvailableBlockCount(offer.id);
                      return {
                        id: offer.id,
                        item_id: offer.item_id,
                        provider_id: offer.provider_id,
                        price_value: offer.price.value,
                        currency: offer.price.currency,
                        max_qty: availableBlocks,
                        time_window: offer.timeWindow,
                        pricing_model: offer.offerAttributes.pricingModel,
                        settlement_type: offer.offerAttributes.settlementType,
                      };
                    }));

                    const activeOffers = syncOffers.filter(o => o.max_qty > 0);
                    const publishSuccess = await publishCatalogToCDS(
                      { id: sellerProviderId, name: providerName },
                      syncItems,
                      activeOffers,
                      activeOffers.length > 0
                    );

                    if (publishSuccess) {
                      logger.info(`Catalog republished to CDS after order ${order!.id}`, {
                        providerId: sellerProviderId,
                        remainingOffers: activeOffers.length,
                        transaction_id: context.transaction_id,
                      });
                    }
                  } catch (syncError: any) {
                    logger.error(`Failed to republish catalog after order: ${syncError.message}`, {
                      transaction_id: context.transaction_id,
                    });
                  }
                })().catch(() => {}); // Ensure no unhandled rejection
              }
            }
          }
          // ESCROW: Deduct payment from buyer (funds held until delivery verification)
          try {
            const rawOrderTotal = order!.quote?.price?.value;
            const orderTotal = Number(rawOrderTotal) || 0; // Ensure numeric
            const platformFeeRate = 0.025; // 2.5% platform fee
            const platformFee = Math.round(orderTotal * platformFeeRate * 100) / 100;
            const totalDeduction = orderTotal + platformFee; // Total to deduct from buyer
            const buyerId = await getBuyerIdFromTransaction(context.transaction_id, order!.id);

            if (buyerId && orderTotal > 0) {
              await prisma.$transaction(async (tx) => {
                // 1. Deduct from buyer's balance (energy cost + platform fee)
                await tx.user.update({
                  where: { id: buyerId },
                  data: { balance: { decrement: totalDeduction } },
                });

                // 2. Update order payment status to ESCROWED
                await tx.order.update({
                  where: { id: order!.id },
                  data: {
                    paymentStatus: 'ESCROWED',
                    escrowedAt: new Date(),
                    totalPrice: orderTotal, // Store energy cost
                  },
                });

                // 3. Create payment record
                const sellerId = await getSellerIdFromProvider(order!.items?.[0]?.provider_id || '');
                await tx.paymentRecord.create({
                  data: {
                    type: 'ESCROW',
                    orderId: order!.id,
                    buyerId,
                    sellerId,
                    totalAmount: totalDeduction,
                    platformFee: platformFee,
                    status: 'COMPLETED',
                    completedAt: new Date(),
                  },
                });
              });

              logger.info(`Payment escrowed for order ${order!.id}`, {
                energyCost: orderTotal,
                platformFee: platformFee,
                totalDeducted: totalDeduction,
                buyerId,
                transaction_id: context.transaction_id,
              });
            } else {
              logger.warn(`Escrow skipped: buyerId=${buyerId}, orderTotal=${orderTotal}`, {
                transaction_id: context.transaction_id,
                order_id: order!.id,
                rawOrderTotal: rawOrderTotal,
              });
            }
          } catch (escrowError: any) {
            logger.error(`Failed to escrow payment: ${escrowError.message}`, { transaction_id: context.transaction_id, order_id: order!.id });
            // Don't fail the order confirmation if escrow fails - can be handled manually
          }
        } else {
          logger.info('Order already ACTIVE, idempotent confirm', { transaction_id: context.transaction_id });
        }
      }); // End withOrderLock

      const callbackContext = createCallbackContext(context, 'on_confirm');

      // Build Beckn v2 wire-format response with order ID
      const wireResponseOrder = buildWireResponseOrder(
        order!,
        (content as any).order || null,  // Echo back request order if present
        order!.id,
      );
      const onConfirmMessage = {
        context: callbackContext,
        message: {
          order: wireResponseOrder,
          _internalOrder: order!, // Include internal order for BAP callbacks
        },
      };

      await logEvent(context.transaction_id, callbackContext.message_id, 'on_confirm', 'OUTBOUND', JSON.stringify(onConfirmMessage));

      const callbackUrl = `${context.bap_uri}/callbacks/on_confirm`;
      logger.info(`Sending on_confirm callback to ${callbackUrl}`, {
        transaction_id: context.transaction_id,
        action: 'on_confirm',
      });

      await axios.post(callbackUrl, onConfirmMessage);
      logger.info('on_confirm callback sent successfully', { transaction_id: context.transaction_id });
    } catch (error: any) {
      logger.error(`Failed to send on_confirm callback: ${error.message}`, { transaction_id: context.transaction_id });
    }
  }, config.callbackDelay);
});

/**
 * POST /status - Get order status
 */
router.post('/status', async (req: Request, res: Response) => {
  const message = req.body as StatusMessage;
  const { context, message: content } = message;

  logger.info('Received status request', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });

  if (await isDuplicateMessage(context.message_id)) {
    return res.json(createAck(context));
  }

  await logEvent(context.transaction_id, context.message_id, 'status', 'INBOUND', JSON.stringify(message));

  // Parse wire format (supports both beckn:id and internal order_id)
  const statusOrderId = parseWireStatusMessage(content);

  // Get order
  const order = await getOrderById(statusOrderId) || await getOrderByTransactionId(context.transaction_id);

  if (!order) {
    return res.json(createNack(context, {
      code: ErrorCodes.ORDER_NOT_FOUND,
      message: `Order not found`,
    }));
  }

  res.json(createAck(context));

  setTimeout(async () => {
    try {
      const callbackContext = createCallbackContext(context, 'on_status');

      // Build Beckn v2 wire-format response with fulfillment data
      const wireResponseOrder = buildWireResponseOrder(order, null, order.id);
      // Add fulfillment to the wire order
      wireResponseOrder['beckn:fulfillment'] = {
        '@type': 'beckn:Fulfillment',
        'beckn:id': uuidv4(),
        'beckn:type': 'ENERGY_DELIVERY',
        'beckn:state': {
          code: order.status === 'ACTIVE' ? 'IN_PROGRESS' : 'PENDING',
          name: order.status === 'ACTIVE' ? 'Energy delivery in progress' : 'Awaiting confirmation',
        },
      };

      const onStatusMessage = {
        context: callbackContext,
        message: {
          order: wireResponseOrder,
          _internalOrder: order, // Include internal order for BAP callbacks
          fulfillment: {
            id: wireResponseOrder['beckn:fulfillment']['beckn:id'],
            type: 'ENERGY_DELIVERY',
            state: {
              descriptor: {
                code: order.status === 'ACTIVE' ? 'IN_PROGRESS' : 'PENDING',
                name: order.status === 'ACTIVE' ? 'Energy delivery in progress' : 'Awaiting confirmation',
              },
            },
          },
        },
      };

      await logEvent(context.transaction_id, callbackContext.message_id, 'on_status', 'OUTBOUND', JSON.stringify(onStatusMessage));

      const callbackUrl = `${context.bap_uri}/callbacks/on_status`;
      logger.info(`Sending on_status callback to ${callbackUrl}`, {
        transaction_id: context.transaction_id,
        action: 'on_status',
      });

      await axios.post(callbackUrl, onStatusMessage);
      logger.info('on_status callback sent successfully', { transaction_id: context.transaction_id });
    } catch (error: any) {
      logger.error(`Failed to send on_status callback: ${error.message}`, { transaction_id: context.transaction_id });
    }
  }, config.callbackDelay);
});

/**
 * POST /cancel - Cancel an order (buyer initiated)
 * Cancellation is only allowed within the configured window after order confirmation
 */
router.post('/cancel', async (req: Request, res: Response) => {
  const { context, message: content } = req.body as {
    context: any;
    message: { order_id: string; reason?: string }
  };

  logger.info('Received cancel request', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    order_id: content.order_id,
  });

  if (await isDuplicateMessage(context.message_id)) {
    return res.json(createAck(context));
  }

  await logEvent(context.transaction_id, context.message_id, 'cancel', 'INBOUND', JSON.stringify(req.body));

  // Get order
  const order = await getOrderById(content.order_id) || await getOrderByTransactionId(context.transaction_id);

  if (!order) {
    return res.json(createNack(context, {
      code: ErrorCodes.ORDER_NOT_FOUND,
      message: 'Order not found',
    }));
  }

  // Check if order is in a cancellable state
  if (order.status !== 'ACTIVE' && order.status !== 'PENDING') {
    return res.json(createNack(context, {
      code: 'CANCEL_NOT_ALLOWED',
      message: `Order in status ${order.status} cannot be cancelled`,
    }));
  }

  // Check if we're within 30 minutes of delivery start time
  let deliveryStartTime: Date | null = null;

  // Get delivery start time from order items
  if (order.items && order.items.length > 0) {
    const firstItem = order.items[0];
    if (firstItem.timeWindow?.startTime) {
      deliveryStartTime = new Date(firstItem.timeWindow.startTime);
    }
  }

  // Prevent cancellation within 30 minutes of delivery start
  if (deliveryStartTime) {
    const minCancelBufferMs = 30 * 60 * 1000; // 30 minutes
    const timeUntilDelivery = deliveryStartTime.getTime() - Date.now();

    if (timeUntilDelivery < minCancelBufferMs && timeUntilDelivery > 0) {
      const minutesRemaining = Math.max(0, Math.floor(timeUntilDelivery / 60000));
      return res.json(createNack(context, {
        code: 'CANCEL_WINDOW_EXPIRED',
        message: `Cancellation not allowed within 30 minutes of delivery start. Only ${minutesRemaining} minutes remaining until delivery.`,
      }));
    }
  }

  res.json(createAck(context));

  setTimeout(async () => {
    try {
      // Use distributed lock for cancellation
      await withOrderLock(order.id, async () => {
        // Re-check order status inside lock
        const currentOrder = await getOrderById(order.id);
        if (!currentOrder || currentOrder.status === 'CANCELLED') {
          return;
        }

        const buyerIdForCancel = await getBuyerIdFromTransaction(context.transaction_id, order.id);

        // 1. Update order status to CANCELLED
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: buyerIdForCancel ? `BUYER:${buyerIdForCancel}` : 'BUYER',
            cancelReason: content.reason,
          },
        });

        logger.info(`Order ${order.id} cancelled by buyer`, {
          transaction_id: context.transaction_id,
          reason: content.reason,
        });

        // 2. Release reserved blocks back to AVAILABLE
        const releasedCount = await releaseBlocksByOrderId(order.id);
        logger.info(`Released ${releasedCount} blocks for cancelled order ${order.id}`);

        // 3. Republish catalog to CDS with increased availability
        if (order.items && order.items.length > 0) {
          const sellerProviderId = order.items[0].provider_id;
          if (sellerProviderId) {
            try {
              const providerInfo = await getProvider(sellerProviderId);
              const providerName = providerInfo?.name || 'Energy Provider';
              const allItems = await getProviderItems(sellerProviderId);
              const allOffers = await getProviderOffers(sellerProviderId);

              // Convert to sync format with updated availability
              const rawCancelSyncItems = allItems.map(item => ({
                id: item.id,
                provider_id: item.provider_id,
                source_type: item.source_type,
                delivery_mode: item.delivery_mode,
                available_qty: item.available_qty,
                production_windows: item.production_windows,
                meter_id: item.meter_id,
              }));
              const cancelSyncItems = await enrichSyncItems(rawCancelSyncItems, sellerProviderId);

              // For offers, use the available block count
              const syncOffers = await Promise.all(allOffers.map(async (offer) => {
                const availableBlocks = await getAvailableBlockCount(offer.id);
                return {
                  id: offer.id,
                  item_id: offer.item_id,
                  provider_id: offer.provider_id,
                  price_value: offer.price.value,
                  currency: offer.price.currency,
                  max_qty: availableBlocks,
                  time_window: offer.timeWindow,
                  pricing_model: offer.offerAttributes.pricingModel,
                  settlement_type: offer.offerAttributes.settlementType,
                };
              }));

              const activeOffers = syncOffers.filter(o => o.max_qty > 0);

              await publishCatalogToCDS(
                { id: sellerProviderId, name: providerName },
                cancelSyncItems,
                activeOffers,
                activeOffers.length > 0
              );

              logger.info(`Catalog republished to CDS after order cancellation`, {
                providerId: sellerProviderId,
                releasedBlocks: releasedCount,
              });
            } catch (syncError: any) {
              logger.error(`Failed to republish catalog after cancellation: ${syncError.message}`);
            }
          }
        }

        // 4. Update buyer trust (proportional to cancelled quantity)
        // Get buyerId from database (not in Order type)
        const dbOrder = await prisma.order.findUnique({ where: { id: order.id }, select: { buyerId: true } });
        const buyerId = dbOrder?.buyerId;
        if (buyerId) {
          const { updateTrustAfterCancel } = await import('@p2p/shared');
          const buyer = await prisma.user.findUnique({ where: { id: buyerId } });

          if (buyer) {
            const cancelledQty = order.quote?.totalQuantity || 0;
            const { newScore, newLimit, trustImpact } = updateTrustAfterCancel(
              buyer.trustScore,
              cancelledQty,
              cancelledQty, // Using same value as this is full order cancel
              true // within window
            );

            await prisma.user.update({
              where: { id: buyerId },
              data: {
                trustScore: newScore,
                allowedTradeLimit: newLimit,
              },
            });

            await prisma.trustScoreHistory.create({
              data: {
                userId: buyerId,
                previousScore: buyer.trustScore,
                newScore,
                previousLimit: buyer.allowedTradeLimit,
                newLimit,
                reason: 'BUYER_CANCEL',
                orderId: order.id,
                metadata: JSON.stringify({
                  cancelledQty,
                  trustImpact,
                  cancelReason: content.reason,
                }),
              },
            });

            logger.info(`Buyer trust updated after cancellation`, {
              buyerId,
              previousScore: buyer.trustScore.toFixed(3),
              newScore: newScore.toFixed(3),
              trustImpact: trustImpact.toFixed(3),
            });
          }
        }
      });

      // 5. Send on_cancel callback
      const callbackContext = createCallbackContext(context, 'on_cancel');
      const updatedOrder = await getOrderById(order.id);

      const onCancelMessage = {
        context: callbackContext,
        message: {
          order: updatedOrder || { ...order, status: 'CANCELLED' },
          cancellation: {
            cancelled_by: 'BUYER',
            reason: content.reason,
            refund_status: 'NONE', // No payment processing in current phase
          },
        },
      };

      await logEvent(context.transaction_id, callbackContext.message_id, 'on_cancel', 'OUTBOUND', JSON.stringify(onCancelMessage));

      const callbackUrl = `${context.bap_uri}/callbacks/on_cancel`;
      logger.info(`Sending on_cancel callback to ${callbackUrl}`, {
        transaction_id: context.transaction_id,
        action: 'on_cancel',
      });

      await axios.post(callbackUrl, onCancelMessage);
      logger.info('on_cancel callback sent successfully', { transaction_id: context.transaction_id });
    } catch (error: any) {
      logger.error(`Failed to process cancel: ${error.message}`, { transaction_id: context.transaction_id });
    }
  }, config.callbackDelay);
});

/**
 * POST /publish - Beckn catalog publish (BPP publishes catalog to CDS)
 * Handles Beckn v2 wire format catalog_publish action
 *
 * Used by:
 * - BPP to push catalog updates to the network CDS
 * - Testing via Postman BPP collection
 */
router.post('/publish', async (req: Request, res: Response) => {
  const { context, message } = req.body;

  logger.info('Received catalog publish request', {
    action: context?.action,
    message_id: context?.message_id,
    bpp_id: context?.bpp_id,
    catalog_count: message?.catalogs?.length || 0,
  });

  if (!context || !message) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing context or message in request body',
    });
  }

  // Check for duplicate
  if (context.message_id && await isDuplicateMessage(context.message_id)) {
    logger.warn('Duplicate publish message ignored', { message_id: context.message_id });
    return res.json(createAck(context));
  }

  // Log the event
  if (context.transaction_id && context.message_id) {
    await logEvent(context.transaction_id, context.message_id, 'catalog_publish', 'INBOUND', JSON.stringify(req.body));
  }

  // Extract catalogs from message
  const catalogs = message.catalogs || [];

  if (catalogs.length === 0) {
    return res.json(createNack(context, {
      code: 'INVALID_REQUEST',
      message: 'No catalogs provided in publish request',
    }));
  }

  res.json(createAck(context));

  // Process catalogs asynchronously
  setTimeout(async () => {
    try {
      for (const catalog of catalogs) {
        const catalogId = catalog['beckn:id'] || catalog.id;
        const isActive = catalog['beckn:isActive'] !== false; // Default to active

        const rawItems = catalog['beckn:items'] || catalog.items || [];
        const rawOffers = catalog['beckn:offers'] || catalog.offers || [];

        logger.info(`Processing catalog ${catalogId}`, {
          items_count: rawItems.length,
          offers_count: rawOffers.length,
          is_active: isActive,
        });

        // Extract provider info from first item
        const firstItem = rawItems[0];
        if (!firstItem) {
          logger.warn(`No items in catalog ${catalogId}, skipping`);
          continue;
        }

        const providerInfo = firstItem['beckn:provider'] || firstItem.provider || {};
        const providerAttrs = providerInfo['beckn:providerAttributes'] || providerInfo.providerAttributes || {};
        const providerId = providerInfo['beckn:id'] || providerInfo.id || 'unknown-provider';
        const providerName = providerInfo['beckn:descriptor']?.['schema:name'] ||
          providerInfo.descriptor?.name || 'Energy Provider';

        // Build SyncProvider
        const syncProvider = {
          id: providerId,
          name: providerName,
          trust_score: 0.5,
        };

        // Build SyncItems
        const syncItems = rawItems.map((item: any) => {
          const itemId = item['beckn:id'] || item.id;
          const itemAttrs = item['beckn:itemAttributes'] || item.itemAttributes || {};
          const itemProvider = item['beckn:provider'] || item.provider || {};
          const itemProviderAttrs = itemProvider['beckn:providerAttributes'] || itemProvider.providerAttributes || {};

          // Extract available quantity from item attributes
          const availableQty = itemAttrs.availableQuantity || itemAttrs['beckn:availableQuantity'] ||
            itemAttrs.quantity?.value || 10; // Default to 10, not 100

          return {
            id: itemId,
            provider_id: providerId,
            source_type: itemAttrs.sourceType || 'SOLAR',
            delivery_mode: 'GRID_INJECTION',
            available_qty: availableQty,
            production_windows: [],
            meter_id: itemAttrs.meterId || itemProviderAttrs.meterId || 'unknown-meter',
            utility_id: itemProviderAttrs.utilityId,
            utility_customer_id: itemProviderAttrs.utilityCustomerId,
          };
        });

        // Build SyncOffers
        const syncOffers = rawOffers.map((offer: any) => {
          const offerId = offer['beckn:id'] || offer.id;
          const offerProviderId = offer['beckn:provider'] || offer.provider || providerId;
          const offerItemIds = offer['beckn:items'] || offer.items || [];
          const price = offer['beckn:price'] || offer.price || {};
          const offerAttrs = offer['beckn:offerAttributes'] || offer.offerAttributes || {};
          const deliveryWindow = offerAttrs.deliveryWindow || {};

          // Extract max quantity from multiple possible sources
          const maxQty = price.applicableQuantity?.unitQuantity ||
            offerAttrs.maxQuantity || offerAttrs['beckn:maxQuantity'] ||
            offerAttrs.applicableQuantity?.unitQuantity || 10; // Default to 10, not 100

          return {
            id: offerId,
            item_id: offerItemIds[0] || syncItems[0]?.id,
            provider_id: offerProviderId,
            price_value: price['schema:price'] || price.value || 0,
            currency: price['schema:priceCurrency'] || price.currency || 'INR',
            max_qty: maxQty,
            time_window: {
              startTime: deliveryWindow['schema:startTime'] || deliveryWindow.startTime,
              endTime: deliveryWindow['schema:endTime'] || deliveryWindow.endTime,
            },
            pricing_model: offerAttrs.pricingModel || 'PER_KWH',
          };
        });

        // Publish or revoke catalog
        try {
          const success = await publishCatalogToCDS(syncProvider, syncItems, syncOffers, isActive);
          if (success) {
            logger.info(`${isActive ? 'Published' : 'Revoked'} catalog ${catalogId}`, {
              provider_id: providerId,
              items: syncItems.length,
              offers: syncOffers.length,
            });
          } else {
            logger.warn(`Failed to ${isActive ? 'publish' : 'revoke'} catalog ${catalogId}`);
          }
        } catch (err: any) {
          logger.error(`Error ${isActive ? 'publishing' : 'revoking'} catalog ${catalogId}: ${err.message}`);
        }
      }

      logger.info('Catalog publish processing completed', {
        transaction_id: context.transaction_id,
        catalogs_processed: catalogs.length,
      });
    } catch (error: any) {
      logger.error(`Catalog publish processing failed: ${error.message}`, {
        transaction_id: context.transaction_id,
      });
    }
  }, config.callbackDelay);
});

// ==================== CDS SYNC HELPERS ====================
// Note: CDS sync functions now imported from @p2p/shared
// They automatically use secureAxios with Beckn signing when USE_EXTERNAL_CDS=true

// ==================== SELLER APIs (Authenticated) ====================

/**
 * GET /seller/my-profile - Get or create the authenticated user's seller profile
 * Auto-creates provider if user doesn't have one
 */
router.get('/seller/my-profile', authMiddleware, async (req: Request, res: Response) => {
  try {
    let providerId = req.user!.providerId;
    let provider;

    // If user doesn't have a provider, create one
    if (!providerId) {
      const providerName = req.user!.name || 'My Energy';
      provider = await registerProvider(providerName);
      providerId = provider.id;

      // Link provider to user
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { providerId: provider.id },
      });

      logger.info(`Auto-created provider ${provider.id} for user ${req.user!.id}`);

      // Sync to CDS
      await syncProviderToCDS(provider);
    } else {
      provider = await getProvider(providerId);
    }

    if (!provider) {
      return res.status(500).json({ success: false, error: 'Failed to get provider' });
    }

    const items = await getProviderItems(providerId);
    const offers = await getProviderOffers(providerId);

    // Debug: Log what we're finding
    logger.info('Seller profile data', {
      userId: req.user!.id,
      providerId,
      itemCount: items.length,
      offerCount: offers.length,
    });

    // Create a map of item_id to source_type for quick lookup
    const itemSourceMap = new Map(items.map(item => [item.id, item.source_type]));

    // Add block stats and source_type to offers
    const offersWithStats = await Promise.all(offers.map(async (offer) => {
      const blockStats = await getBlockStats(offer.id);
      const source_type = itemSourceMap.get(offer.item_id) || 'SOLAR';
      return { ...offer, blockStats, source_type };
    }));

    // Calculate quota stats for the seller
    // Total SOLD = orders that are PENDING, ACTIVE, or COMPLETED (excludes CANCELLED)
    const soldOrders = await prisma.order.findMany({
      where: {
        providerId: providerId,
        status: { in: ['PENDING', 'ACTIVE', 'COMPLETED'] },
      },
      select: { totalQty: true },
    });
    const totalSoldQty = soldOrders.reduce((sum, order) => sum + (order.totalQty || 0), 0);

    // Total unsold in active offers
    const totalUnsoldInOffers = offersWithStats.reduce((sum, offer) => {
      return sum + (offer.blockStats?.available ?? 0);
    }, 0);

    res.json({
      success: true,
      provider,
      items,
      offers: offersWithStats,
      quotaStats: {
        totalSold: totalSoldQty,
        totalUnsoldInOffers: totalUnsoldInOffers,
        totalCommitted: totalSoldQty + totalUnsoldInOffers,
      },
    });
  } catch (error: any) {
    logger.error('Failed to get seller profile:', error);
    res.status(500).json({ success: false, error: 'Failed to load seller profile' });
  }
});

/**
 * GET /seller/my-orders - Get orders for the authenticated user's provider
 */
router.get('/seller/my-orders', authMiddleware, async (req: Request, res: Response) => {
  try {
    const providerId = req.user?.providerId ?? null;
    const userId = req.user!.id;

    // Use enhanced query that finds orders by providerId OR by sellerId in payment records
    // This includes both local orders (providerId set) and external orders (providerId null)
    const orders = await getOrdersForSeller(providerId, userId);

    // Enrich orders with block and item information
    // For bulk orders, filter to only show items/blocks belonging to this seller
    const enrichedOrders = await Promise.all(orders.map(async (order) => {
      try {
        // Get DISCOM feedback for this order
        const discomFeedback = await prisma.discomFeedback.findUnique({
          where: { orderId: order.id },
        });

        if (order.items && order.items.length > 0) {
          // Get all blocks for this order that belong to this provider
          const allOrderBlocks = await getBlocksForOrder(order.id);
          const sellerBlocks = providerId
            ? allOrderBlocks.filter(b => b.provider_id === providerId)
            : allOrderBlocks;

          // If this is a bulk order (multiple items) and we have blocks, use block info
          // Otherwise fall back to first item
          const actualSoldQty = sellerBlocks.length || 0;

          // Find items that belong to this seller (via blocks or direct providerId match)
          const sellerOfferIds = new Set(sellerBlocks.map(b => b.offer_id));
          const sellerItems = order.items.filter(item =>
            sellerOfferIds.has(item.offer_id) || order.providerId === providerId
          );

          // Use first seller item, or fall back to first item
          const displayItem = sellerItems.length > 0 ? sellerItems[0] : order.items[0];
          const blockStats = await getBlockStats(displayItem.offer_id);

          // Fetch item and offer details
          const item = await prisma.catalogItem.findUnique({
            where: { id: displayItem.item_id },
          });
          const offer = await prisma.catalogOffer.findUnique({
            where: { id: displayItem.offer_id },
          });

          // Get price from blocks if offer is deleted, or from offer if it exists
          const pricePerKwh = offer?.priceValue ||
            (sellerBlocks.length > 0 ? sellerBlocks[0].price_value : 0) ||
            (allOrderBlocks.length > 0 ? allOrderBlocks[0].price_value : 0);

          // Calculate seller's portion of the order value
          const sellerTotal = sellerBlocks.reduce((sum, b) => sum + b.price_value, 0);

          // Get delivery time from offer
          const deliveryTime = offer?.timeWindowStart ? {
            start: offer.timeWindowStart.toISOString(),
            end: offer.timeWindowEnd?.toISOString(),
          } : undefined;

          const cancelledBy = order.cancelledBy;
          const sellerCancelled = cancelledBy?.startsWith('SELLER:');

          // If buyer cancels, seller receives 5% compensation (half of 10% penalty)
          // For bulk orders, this should be proportional to seller's share
          const cancellationCompensation = order.status === 'CANCELLED' && order.cancelPenalty && !sellerCancelled
            ? order.cancelPenalty * 0.5 * (actualSoldQty / (order.quote?.totalQuantity || actualSoldQty))
            : null;

          return {
            ...order,
            paymentStatus: order.paymentStatus || 'PENDING',
            // For bulk orders, show seller's portion
            isBulkOrder: order.items.length > 1,
            sellerItemCount: sellerItems.length,
            totalItemCount: order.items.length,
            itemInfo: {
              item_id: displayItem.item_id,
              offer_id: displayItem.offer_id,
              sold_quantity: actualSoldQty,
              block_stats: blockStats,
              source_type: item?.sourceType || 'UNKNOWN',
              price_per_kwh: pricePerKwh,
              seller_total: sellerTotal, // Total value for this seller's items
            },
            deliveryTime,
            // Cancellation info for seller
            cancellation: order.status === 'CANCELLED' ? {
              cancelledAt: order.cancelledAt,
              cancelledBy: order.cancelledBy,
              reason: order.cancelReason,
              penalty: sellerCancelled ? order.cancelPenalty : null,
              refund: sellerCancelled ? order.cancelRefund : null,
              compensation: cancellationCompensation,
            } : undefined,
            // DISCOM verification results
            fulfillment: discomFeedback ? {
              verified: true,
              deliveredQty: discomFeedback.deliveredQty,
              expectedQty: discomFeedback.expectedQty,
              deliveryRatio: discomFeedback.deliveryRatio,
              status: discomFeedback.status, // 'FULL' | 'PARTIAL' | 'FAILED'
              trustImpact: discomFeedback.trustImpact,
              verifiedAt: discomFeedback.verifiedAt.toISOString(),
            } : null,
          };
        }

        // Return order with just DISCOM feedback if no items
        return {
          ...order,
          paymentStatus: order.paymentStatus || 'PENDING',
          fulfillment: discomFeedback ? {
            verified: true,
            deliveredQty: discomFeedback.deliveredQty,
            expectedQty: discomFeedback.expectedQty,
            deliveryRatio: discomFeedback.deliveryRatio,
            status: discomFeedback.status,
            trustImpact: discomFeedback.trustImpact,
            verifiedAt: discomFeedback.verifiedAt.toISOString(),
          } : null,
        };
      } catch (error: any) {
        logger.error(`Error enriching order ${order.id}: ${error.message}`);
      }
      return order;
    }));

    res.json({ orders: enrichedOrders });
  } catch (error: any) {
    logger.error('Failed to get seller orders:', error);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// ==================== Legacy SELLER APIs (for backward compatibility) ====================

/**
 * POST /seller/register - Register as a new provider (legacy)
 */
router.post('/seller/register', async (req: Request, res: Response) => {
  const { name } = req.body as { name: string };

  if (!name) {
    return res.status(400).json({ error: 'Provider name is required' });
  }

  const provider = await registerProvider(name);
  logger.info(`New provider registered: ${provider.id} (${name})`);

  // Sync to CDS
  await syncProviderToCDS(provider);

  res.json({ status: 'ok', provider });
});

/**
 * GET /seller/providers - List all providers (legacy - now returns empty for privacy)
 */
router.get('/seller/providers', async (req: Request, res: Response) => {
  // Don't expose all providers for privacy
  res.json({ providers: [] });
});

/**
 * GET /seller/providers/:id - Get provider details (legacy)
 */
router.get('/seller/providers/:id', async (req: Request, res: Response) => {
  const provider = await getProvider(req.params.id);

  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const items = await getProviderItems(req.params.id);
  const offers = await getProviderOffers(req.params.id);

  res.json({ provider, items, offers });
});

/**
 * POST /seller/items - Add a new catalog item (energy listing)
 * Uses authenticated user's provider
 */
router.post('/seller/items', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  const {
    source_type,
    delivery_mode,
    available_qty,
    production_windows,
    meter_id
  } = req.body;

  // Use authenticated user's provider
  const provider_id = req.user!.providerId;

  if (!provider_id) {
    return res.status(400).json({ error: 'No seller profile found. Please set up your seller profile first.' });
  }

  if (!source_type || !available_qty) {
    return res.status(400).json({ error: 'source_type and available_qty are required' });
  }

  const provider = await getProvider(provider_id);
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const item = await addCatalogItem(
    provider_id,
    source_type,
    'SCHEDULED', // Always scheduled for P2P energy trading
    available_qty,
    production_windows || [],
    meter_id || `meter-${Date.now()}`
  );

  logger.info(`New item listed: ${item.id} by provider ${provider_id}`);

  // Sync to CDS
  await syncItemToCDS({
    id: item.id,
    provider_id: item.provider_id,
    source_type: item.source_type,
    delivery_mode: item.delivery_mode,
    available_qty: item.available_qty,
    production_windows: item.production_windows,
    meter_id: item.meter_id,
  });

  res.json({ status: 'ok', item });
});

/**
 * GET /seller/items - List all items
 */
router.get('/seller/items', async (req: Request, res: Response) => {
  const { provider_id } = req.query;

  const items = provider_id
    ? await getProviderItems(provider_id as string)
    : await getAllItems();

  res.json({ items });
});

/**
 * PUT /seller/items/:id/quantity - Update item quantity
 */
router.put('/seller/items/:id/quantity', async (req: Request, res: Response) => {
  const { quantity } = req.body;

  if (quantity === undefined || quantity < 0) {
    return res.status(400).json({ error: 'Valid quantity is required' });
  }

  await updateItemQuantity(req.params.id, quantity);
  logger.info(`Item ${req.params.id} quantity updated to ${quantity}`);

  res.json({ status: 'ok', item_id: req.params.id, new_quantity: quantity });
});

/**
 * POST /seller/offers - Add a new offer for an item
 * Uses authenticated user's provider
 */
router.post('/seller/offers', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  const {
    item_id,
    price_per_kwh,
    currency,
    max_qty,
    time_window
  } = req.body;

  // Use authenticated user's provider
  const provider_id = req.user!.providerId;

  if (!provider_id) {
    return res.status(400).json({ error: 'No seller profile found. Please set up your seller profile first.' });
  }

  if (!item_id || !price_per_kwh || !max_qty || !time_window) {
    return res.status(400).json({
      error: 'item_id, price_per_kwh, max_qty, and time_window are required'
    });
  }

  // Trade rules: validate quantity (min 1 kWh, round to 2 decimals)
  const qtyErr = validateQuantity(max_qty);
  if (qtyErr) {
    return res.status(400).json({ error: qtyErr });
  }
  const roundedQty = roundQuantity(max_qty);

  // Trade rules: snap time window to 1-hour blocks within 06:00-18:00
  let effectiveTw = time_window;
  if (time_window?.startTime && time_window?.endTime) {
    effectiveTw = snapTimeWindow(time_window.startTime, time_window.endTime);

    // Trade rules: gate closure check (T-4h before delivery)
    const tradeCheck = checkTradeWindow(effectiveTw.startTime);
    if (!tradeCheck.allowed) {
      return res.status(400).json({ error: tradeCheck.reason });
    }
  }

  // Verify the item belongs to this provider
  const items = await getProviderItems(provider_id);
  const itemExists = items.some(i => i.id === item_id);
  if (!itemExists) {
    return res.status(403).json({ error: 'Item does not belong to your seller profile' });
  }

  const offer = await addOffer(
    item_id,
    provider_id,
    price_per_kwh,
    currency || 'INR',
    roundedQty,
    effectiveTw
  );

  logger.info(`New offer created: ${offer.id} for item ${item_id}`);

  // Get provider info for CDS publishing (reuse items from validation above)
  const providerInfo = await getProvider(provider_id);
  const providerName = providerInfo?.name || req.user!.name || 'Energy Provider';
  const itemInfo = items.find(i => i.id === item_id);

  // Publish to CDS using proper Beckn catalog_publish format (non-blocking)
  if (itemInfo) {
    const utilityInfo = await getProviderUtilityInfo(provider_id);
    publishOfferToCDS(
      {
        id: provider_id,
        name: providerName,
        trust_score: providerInfo?.trust_score || 0.5,
      },
      {
        id: itemInfo.id,
        provider_id: itemInfo.provider_id,
        source_type: itemInfo.source_type,
        delivery_mode: itemInfo.delivery_mode,
        available_qty: itemInfo.available_qty,
        production_windows: itemInfo.production_windows,
        meter_id: itemInfo.meter_id,
        utility_id: utilityInfo.utilityId,
        utility_customer_id: utilityInfo.utilityCustomerId,
      },
      {
        id: offer.id,
        item_id: offer.item_id,
        provider_id: offer.provider_id,
        price_value: offer.price.value,
        currency: offer.price.currency,
        max_qty: offer.maxQuantity,
        time_window: offer.timeWindow,
        pricing_model: offer.offerAttributes.pricingModel,
        settlement_type: offer.offerAttributes.settlementType,
      }
    ).then(success => {
      if (success) {
        logger.info('Offer published to external CDS', { offerId: offer.id });
      }
    }).catch(err => logger.error('Failed to publish offer to CDS', { offerId: offer.id, error: err.message }));
  }

  res.json({ status: 'ok', offer });
});

/**
 * POST /seller/offers/direct - Create an offer directly (auto-creates item)
 * Simplified flow for prosumers - no need to create a listing first
 */
router.post('/seller/offers/direct', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  const {
    source_type,
    price_per_kwh,
    currency,
    max_qty,
    time_window
  } = req.body;

  // Use authenticated user's provider
  const provider_id = req.user!.providerId;

  if (!provider_id) {
    return res.status(400).json({ error: 'No seller profile found. Please set up your seller profile first.' });
  }

  // Check if user has set production capacity
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { productionCapacity: true, allowedTradeLimit: true },
  });

  if (!user?.productionCapacity || user.productionCapacity <= 0) {
    return res.status(400).json({
      error: 'Please set your production capacity in Profile before creating offers.'
    });
  }

  // Calculate trade limit
  const tradeLimit = (user.productionCapacity * (user.allowedTradeLimit ?? 10)) / 100;

  // Get total SOLD quantity from orders (not offers)
  // Once energy is sold, it counts towards quota permanently - even if offer is deleted
  // This includes: PENDING (escrowed), ACTIVE (awaiting delivery), COMPLETED orders
  // Excludes: CANCELLED orders (those were refunded)
  const soldOrders = await prisma.order.findMany({
    where: {
      providerId: provider_id,
      status: { in: ['PENDING', 'ACTIVE', 'COMPLETED'] },
    },
    select: { totalQty: true },
  });

  const totalSoldQty = soldOrders.reduce((sum, order) => sum + (order.totalQty || 0), 0);

  // Also count currently active offers (unsold blocks that are reserved)
  const activeOffers = await prisma.catalogOffer.findMany({
    where: { providerId: provider_id },
    include: {
      blocks: {
        where: { status: 'AVAILABLE' }, // Only unsold blocks
      },
    },
  });

  const totalUnsoldInOffers = activeOffers.reduce((sum, offer) => sum + offer.blocks.length, 0);

  // Total committed = sold + unsold in active offers
  const totalCommitted = totalSoldQty + totalUnsoldInOffers;
  const remainingCapacity = tradeLimit - totalCommitted;

  // Check if new offer quantity exceeds remaining capacity
  if (max_qty > remainingCapacity) {
    return res.status(400).json({
      error: `Offer quantity (${max_qty} kWh) exceeds your remaining capacity (${remainingCapacity.toFixed(1)} kWh). You have ${totalSoldQty.toFixed(1)} kWh sold + ${totalUnsoldInOffers.toFixed(1)} kWh in active offers = ${totalCommitted.toFixed(1)} kWh committed out of ${tradeLimit.toFixed(1)} kWh limit.`
    });
  }

  if (!source_type || !price_per_kwh || !max_qty || !time_window) {
    return res.status(400).json({
      error: 'source_type, price_per_kwh, max_qty, and time_window are required'
    });
  }

  // Trade rules: validate quantity (min 1 kWh)
  const directQtyErr = validateQuantity(max_qty);
  if (directQtyErr) {
    return res.status(400).json({ error: directQtyErr });
  }
  const directRoundedQty = roundQuantity(max_qty);

  // Validate time window (startTime must be before endTime)
  if (!isValidTimeWindow(time_window)) {
    return res.status(400).json({
      error: 'Invalid time window: "Available Until" must be after "Available From"'
    });
  }

  // Trade rules: snap time window to 1-hour blocks within 06:00-18:00
  let directEffectiveTw = time_window;
  if (time_window?.startTime && time_window?.endTime) {
    directEffectiveTw = snapTimeWindow(time_window.startTime, time_window.endTime);

    // Trade rules: gate closure check (T-4h before delivery)
    const directTradeCheck = checkTradeWindow(directEffectiveTw.startTime);
    if (!directTradeCheck.allowed) {
      return res.status(400).json({ error: directTradeCheck.reason });
    }
  }

  // Auto-create an item for this offer
  const item = await addCatalogItem(
    provider_id,
    source_type.toUpperCase() as any,
    'SCHEDULED',
    directRoundedQty,
    [], // No production windows needed
    '' // No meter ID needed
  );

  logger.info(`Auto-created item ${item.id} for direct offer`);

  // Create the offer
  const offer = await addOffer(
    item.id,
    provider_id,
    price_per_kwh,
    currency || 'INR',
    directRoundedQty,
    directEffectiveTw
  );

  logger.info(`New direct offer created: ${offer.id}`);

  // Get provider name for CDS publishing
  const providerInfo = await getProvider(provider_id);
  const providerName = providerInfo?.name || req.user!.name || 'Energy Provider';

  // Publish to CDS using proper Beckn catalog_publish format (non-blocking)
  const directUtilityInfo = await getProviderUtilityInfo(provider_id);
  publishOfferToCDS(
    {
      id: provider_id,
      name: providerName,
      trust_score: providerInfo?.trust_score || 0.5,
    },
    {
      id: item.id,
      provider_id: item.provider_id,
      source_type: item.source_type,
      delivery_mode: item.delivery_mode,
      available_qty: item.available_qty,
      production_windows: item.production_windows,
      meter_id: item.meter_id,
      utility_id: directUtilityInfo.utilityId,
      utility_customer_id: directUtilityInfo.utilityCustomerId,
    },
    {
      id: offer.id,
      item_id: offer.item_id,
      provider_id: offer.provider_id,
      price_value: offer.price.value,
      currency: offer.price.currency,
      max_qty: offer.maxQuantity,
      time_window: offer.timeWindow,
      pricing_model: offer.offerAttributes.pricingModel,
      settlement_type: offer.offerAttributes.settlementType,
    }
  ).then(success => {
    if (success) {
      logger.info('Offer published to external CDS', { offerId: offer.id });
    } else {
      logger.warn('Offer publishing returned false', { offerId: offer.id });
    }
  }).catch(err => logger.error('Failed to publish offer to CDS', { offerId: offer.id, error: err.message }));

  // Add source_type to the response
  res.json({
    status: 'ok',
    offer: {
      ...offer,
      source_type: source_type.toUpperCase(),
    }
  });
});

/**
 * GET /seller/offers - List all offers
 */
router.get('/seller/offers', async (req: Request, res: Response) => {
  const { provider_id } = req.query;

  const offers = provider_id
    ? await getProviderOffers(provider_id as string)
    : await getAllOffers();

  res.json({ offers });
});

/**
 * DELETE /seller/offers/:id - Delete an offer
 * Only allows deleting own offers
 */
router.delete('/seller/offers/:id', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  const provider_id = req.user!.providerId;

  if (!provider_id) {
    return res.status(403).json({ error: 'No seller profile found' });
  }

  // Verify offer belongs to user's provider
  const offer = await getOfferById(req.params.id);
  if (!offer) {
    return res.status(404).json({ error: 'Offer not found' });
  }

  if (offer.provider_id !== provider_id) {
    return res.status(403).json({ error: 'You can only delete your own offers' });
  }

  await deleteOffer(req.params.id);
  logger.info(`Offer ${req.params.id} deleted by provider ${provider_id}`);

  // Republish the full catalog without the deleted offer (non-blocking)
  // This updates the CDS with the current catalog state
  // If all offers are deleted, revoke the catalog entirely
  (async () => {
    try {
      const providerInfo = await getProvider(provider_id);
      const providerName = providerInfo?.name || 'Energy Provider';
      const items = await getProviderItems(provider_id);
      const offers = await getProviderOffers(provider_id);

      // Convert to sync format
      const rawDelSyncItems = items.map(item => ({
        id: item.id,
        provider_id: item.provider_id,
        source_type: item.source_type,
        delivery_mode: item.delivery_mode,
        available_qty: item.available_qty,
        production_windows: item.production_windows,
        meter_id: item.meter_id,
      }));
      const delSyncItems = await enrichSyncItems(rawDelSyncItems, provider_id);

      const syncOffers = offers.map(offer => ({
        id: offer.id,
        item_id: offer.item_id,
        provider_id: offer.provider_id,
        price_value: offer.price.value,
        currency: offer.price.currency,
        max_qty: offer.maxQuantity,
        time_window: offer.timeWindow,
        pricing_model: offer.offerAttributes.pricingModel,
        settlement_type: offer.offerAttributes.settlementType,
      }));

      // If no offers remain, revoke the catalog (set isActive: false)
      // Otherwise republish with remaining offers
      const isActive = syncOffers.length > 0;

      await publishCatalogToCDS(
        { id: provider_id, name: providerName },
        delSyncItems,
        syncOffers,
        isActive
      );

      if (isActive) {
        logger.info('Catalog republished to CDS after offer deletion', {
          providerId: provider_id,
          remainingOffers: syncOffers.length
        });
      } else {
        logger.info('Catalog revoked from CDS (no offers remaining)', { providerId: provider_id });
      }
    } catch (err: any) {
      logger.error('Failed to republish catalog after deletion', { error: err.message });
    }
  })();

  res.json({ status: 'ok', deleted: req.params.id });
});

/**
 * GET /seller/orders - Get orders for a provider
 */
router.get('/seller/orders', async (req: Request, res: Response) => {
  const { provider_id } = req.query;

  const orders = provider_id
    ? await getOrdersByProviderId(provider_id as string)
    : await getAllOrders();

  // Enrich orders with block information
  const enrichedOrders = await Promise.all(orders.map(async (order) => {
    try {
      if (order.items && order.items.length > 0) {
        const firstItem = order.items[0];
        const itemId = firstItem.item_id;
        const offerId = firstItem.offer_id;

        // Get actual purchased quantity from blocks (not from offer max)
        const orderBlocks = await getBlocksForOrder(order.id);
        const actualSoldQty = orderBlocks.length; // Each block = 1 unit

        // Get item-level available quantity
        const availableQty = await getItemAvailableQuantity(itemId);

        // Get offer block stats
        const blockStats = await getBlockStats(offerId);

        return {
          ...order,
          itemInfo: {
            item_id: itemId,
            offer_id: offerId,
            available_quantity: availableQty,
            sold_quantity: actualSoldQty, // Actual purchased quantity from blocks
            remaining_quantity: availableQty !== null ? availableQty - actualSoldQty : null,
            block_stats: blockStats,
          },
        };
      }
    } catch (error: any) {
      logger.error(`Error enriching order ${order.id}: ${error.message}`);
    }
    return order;
  }));

  res.json({ orders: enrichedOrders });
});

/**
 * POST /seller/orders/:orderId/cancel - Seller-initiated cancellation
 * - Full refund to buyer (order total + platform fee)
 * - Seller pays 5% penalty to platform
 * - Seller trust penalized (stricter than buyer)
 */
router.post('/seller/orders/:orderId/cancel', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body as { reason?: string };
    const providerId = req.user!.providerId;
    const sellerUserId = req.user!.id;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Check ownership: either providerId matches OR seller has a payment record for this order
    const isOwnerByProvider = providerId && order.providerId === providerId;
    const isOwnerByPayment = order.payments.some((p) => p.sellerId === sellerUserId);

    if (!isOwnerByProvider && !isOwnerByPayment) {
      return res.status(403).json({ error: 'You can only cancel orders for your provider' });
    }

    const cancelableStatuses = ['ACTIVE', 'PENDING', 'INITIALIZED'];
    if (!cancelableStatuses.includes(order.status)) {
      return res.status(400).json({
        error: `Cannot cancel order with status: ${order.status}. Only ACTIVE, PENDING, or INITIALIZED orders can be cancelled.`,
      });
    }

    const cancelWindowMinutes = config.cancellation.windowMinutes;
    const cancelWindowMs = cancelWindowMinutes * 60 * 1000;
    const orderAge = Date.now() - new Date(order.createdAt).getTime();

    if (orderAge > cancelWindowMs) {
      return res.status(400).json({
        error: `Cancellation window (${cancelWindowMinutes} minutes) has expired. Order cannot be cancelled.`,
      });
    }

    const cancellationResult = await withOrderLock(order.id, async () => {
      const currentOrder = await prisma.order.findUnique({
        where: { id: orderId },
        include: { payments: true },
      });

      if (!currentOrder) {
        throw new Error('Order not found during cancellation');
      }

      if (currentOrder.status === 'CANCELLED') {
        return { status: 'already_cancelled' as const, refundTotal: 0, sellerPenalty: 0 };
      }

      if (!cancelableStatuses.includes(currentOrder.status)) {
        return { status: 'not_cancelable' as const, refundTotal: 0, sellerPenalty: 0 };
      }

      const orderTotal = currentOrder.totalPrice || 0;
      const platformFee = Math.round(orderTotal * config.fees.platformRate * 100) / 100;
      const escrowPayment = currentOrder.payments.find((payment) => payment.type === 'ESCROW');
      const refundTotal = escrowPayment?.totalAmount ?? orderTotal + platformFee;
      const sellerPenalty = Math.round(orderTotal * config.fees.sellerCancellationPenalty * 100) / 100;

      const buyerId = currentOrder.buyerId || await getBuyerIdFromTransaction(currentOrder.transactionId, currentOrder.id);

      await prisma.$transaction(async (tx) => {
        // 1. Update order status to CANCELLED with refund/penalty info
        await tx.order.update({
          where: { id: currentOrder.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledBy: `SELLER:${sellerUserId}`,
            cancelReason: reason || 'Seller cancelled',
            cancelPenalty: sellerPenalty,
            cancelRefund: refundTotal,
          },
        });

        // 2. Refund buyer fully if payment was escrowed
        if (currentOrder.paymentStatus === 'ESCROWED' && buyerId && refundTotal > 0) {
          await tx.user.update({
            where: { id: buyerId },
            data: { balance: { increment: refundTotal } },
          });

          if (escrowPayment) {
            await tx.paymentRecord.update({
              where: { id: escrowPayment.id },
              data: { status: 'REFUNDED' },
            });
          }

          await tx.order.update({
            where: { id: currentOrder.id },
            data: { paymentStatus: 'REFUNDED' },
          });

          await tx.paymentRecord.create({
            data: {
              type: 'SELLER_CANCEL_REFUND',
              orderId: currentOrder.id,
              buyerId,
              sellerId: sellerUserId,
              totalAmount: refundTotal,
              platformFee: 0,
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });
        }

        // 3. Deduct seller penalty (platform fee)
        if (sellerPenalty > 0) {
          await tx.user.update({
            where: { id: sellerUserId },
            data: { balance: { decrement: sellerPenalty } },
          });

          await tx.paymentRecord.create({
            data: {
              type: 'SELLER_CANCEL_PENALTY',
              orderId: currentOrder.id,
              buyerId: buyerId || undefined,
              sellerId: sellerUserId,
              totalAmount: sellerPenalty,
              platformFee: sellerPenalty,
              status: 'COMPLETED',
              completedAt: new Date(),
            },
          });
        }

        // 4. Update seller trust score (stricter penalty)
        const seller = await tx.user.findUnique({ where: { id: sellerUserId } });
        if (seller) {
          const cancelledQty = currentOrder.totalQty || 0;
          const { newScore, newLimit, trustImpact } = updateTrustAfterSellerCancel(
            seller.trustScore,
            cancelledQty,
            cancelledQty,
            true
          );

          await tx.user.update({
            where: { id: sellerUserId },
            data: {
              trustScore: newScore,
              allowedTradeLimit: newLimit,
            },
          });

          await tx.trustScoreHistory.create({
            data: {
              userId: sellerUserId,
              previousScore: seller.trustScore,
              newScore,
              previousLimit: seller.allowedTradeLimit,
              newLimit,
              reason: 'SELLER_CANCEL',
              orderId: currentOrder.id,
              metadata: JSON.stringify({
                cancelledQty,
                trustImpact,
                cancelReason: reason,
              }),
            },
          });
        }
      });

      return { status: 'cancelled' as const, refundTotal, sellerPenalty };
    });

    if (cancellationResult.status === 'already_cancelled') {
      return res.json({ status: 'already_cancelled', orderId });
    }

    if (cancellationResult.status === 'not_cancelable') {
      return res.status(409).json({ error: 'Order status changed; cancellation not allowed' });
    }

    // Release reserved blocks back to AVAILABLE
    const releasedCount = await releaseBlocksByOrderId(order.id);
    logger.info(`Released ${releasedCount} blocks for seller-cancelled order ${order.id}`);

    // Republish catalog to CDS with increased availability
    try {
      const providerInfo = await getProvider(providerId);
      const providerName = providerInfo?.name || 'Energy Provider';
      const allItems = await getProviderItems(providerId);
      const allOffers = await getProviderOffers(providerId);

      const rawSellerCancelSyncItems = allItems.map(item => ({
        id: item.id,
        provider_id: item.provider_id,
        source_type: item.source_type,
        delivery_mode: item.delivery_mode,
        available_qty: item.available_qty,
        production_windows: item.production_windows,
        meter_id: item.meter_id,
      }));
      const sellerCancelSyncItems = await enrichSyncItems(rawSellerCancelSyncItems, providerId);

      const syncOffers = await Promise.all(allOffers.map(async (offer) => {
        const availableBlocks = await getAvailableBlockCount(offer.id);
        return {
          id: offer.id,
          item_id: offer.item_id,
          provider_id: offer.provider_id,
          price_value: offer.price.value,
          currency: offer.price.currency,
          max_qty: availableBlocks,
          time_window: offer.timeWindow,
          pricing_model: offer.offerAttributes.pricingModel,
          settlement_type: offer.offerAttributes.settlementType,
        };
      }));

      const activeOffers = syncOffers.filter(o => o.max_qty > 0);

      await publishCatalogToCDS(
        { id: providerId, name: providerName },
        sellerCancelSyncItems,
        activeOffers,
        activeOffers.length > 0
      );

      logger.info(`Catalog republished to CDS after seller cancellation`, {
        providerId,
        releasedBlocks: releasedCount,
      });
    } catch (syncError: any) {
      logger.error(`Failed to republish catalog after seller cancellation: ${syncError.message}`);
    }

    return res.json({
      status: 'cancelled',
      orderId,
      refundTotal: cancellationResult.refundTotal,
      sellerPenalty: cancellationResult.sellerPenalty,
    });
  } catch (error: any) {
    logger.error(`Failed to cancel order as seller: ${error.message}`);
    return res.status(500).json({ error: 'Failed to cancel order' });
  }
});

/**
 * GET /seller/cds-status - Check CDS publishing status
 * Useful for debugging whether offers are being published
 */
router.get('/seller/cds-status', async (req: Request, res: Response) => {
  const signingOn = isSigningEnabled();
  const bppKeys = getBppKeyPair();

  res.json({
    cds: {
      publishingEnabled: true, // Always enabled - no toggle
      externalCdsUrl: config.external.cds,
      envCheck: {
        EXTERNAL_CDS_URL: process.env.EXTERNAL_CDS_URL || 'NOT SET (using default)',
      },
    },
    signing: {
      enabled: signingOn,
      bppKeysConfigured: !!bppKeys,
      bppKeyId: bppKeys?.keyId || 'NOT CONFIGURED',
      envCheck: {
        BECKN_SIGNING_ENABLED: process.env.BECKN_SIGNING_ENABLED || 'NOT SET',
        BPP_KEY_ID: process.env.BPP_KEY_ID ? 'SET' : 'NOT SET',
        BPP_PUBLIC_KEY: process.env.BPP_PUBLIC_KEY ? 'SET' : 'NOT SET',
        BPP_PRIVATE_KEY: process.env.BPP_PRIVATE_KEY ? 'SET' : 'NOT SET',
      },
    },
    message: signingOn && bppKeys
      ? 'CDS publishing is ENABLED with BPP signing - offers will be published to external CDS'
      : !signingOn
        ? 'CDS publishing enabled but SIGNING is OFF - set BECKN_SIGNING_ENABLED=true'
        : 'CDS publishing enabled but BPP keys missing - set BPP_KEY_ID, BPP_PUBLIC_KEY, BPP_PRIVATE_KEY',
  });
});

/**
 * GET /seller/debug-data - Debug endpoint to check data consistency
 * Shows offers and blocks for the authenticated user's provider
 */
router.get('/seller/debug-data', authMiddleware, async (req: Request, res: Response) => {
  const providerId = req.user!.providerId;
  const userId = req.user!.id;

  // Get all offers for this provider
  const offers = await prisma.catalogOffer.findMany({
    where: { providerId: providerId || undefined },
    include: {
      blocks: {
        select: { id: true, status: true },
      },
    },
  });

  // Get all blocks for this provider (regardless of offer)
  const allBlocks = await prisma.offerBlock.findMany({
    where: { providerId: providerId || undefined },
    select: { id: true, offerId: true, status: true },
  });

  // Get orphaned blocks (blocks without a valid offer)
  const offerIds = offers.map(o => o.id);
  const orphanedBlocks = allBlocks.filter(b => !offerIds.includes(b.offerId));

  // Get orders for this provider
  const orders = await prisma.order.findMany({
    where: { providerId: providerId || undefined },
    select: { id: true, status: true, totalQty: true },
  });

  res.json({
    user: {
      id: userId,
      providerId,
      name: req.user!.name,
    },
    offers: offers.map(o => ({
      id: o.id,
      maxQty: o.maxQty,
      priceValue: o.priceValue,
      blocksCount: o.blocks.length,
      availableBlocks: o.blocks.filter(b => b.status === 'AVAILABLE').length,
      soldBlocks: o.blocks.filter(b => b.status === 'SOLD').length,
    })),
    blocksTotal: allBlocks.length,
    blocksAvailable: allBlocks.filter(b => b.status === 'AVAILABLE').length,
    blocksSold: allBlocks.filter(b => b.status === 'SOLD').length,
    orphanedBlocks: orphanedBlocks.length,
    orders: orders.map(o => ({
      id: o.id,
      status: o.status,
      totalQty: o.totalQty,
    })),
    summary: {
      offersCount: offers.length,
      totalBlocksInOffers: offers.reduce((sum, o) => sum + o.blocks.length, 0),
      availableInOffers: offers.reduce((sum, o) => sum + o.blocks.filter(b => b.status === 'AVAILABLE').length, 0),
      soldInOrders: orders.filter(o => ['PENDING', 'ACTIVE', 'COMPLETED'].includes(o.status)).reduce((sum, o) => sum + (o.totalQty || 0), 0),
    },
  });
});

/**
 * POST /seller/cds-test-publish - Test CDS publishing with a test offer
 * Only available with authentication
 */
router.post('/seller/cds-test-publish', authMiddleware, async (req: Request, res: Response) => {
  const provider_id = req.user!.providerId;

  if (!provider_id) {
    return res.status(400).json({ error: 'No seller profile found' });
  }

  const providerInfo = await getProvider(provider_id);
  const providerName = providerInfo?.name || req.user!.name || 'Test Provider';

  // Create test data
  const testItemId = `test-item-${Date.now()}`;
  const testOfferId = `test-offer-${Date.now()}`;
  const testTimeWindow = {
    startTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    endTime: new Date(Date.now() + 7200000).toISOString(),   // 2 hours from now
  };

  try {
    const testUtilityInfo = await getProviderUtilityInfo(provider_id);
    const success = await publishOfferToCDS(
      {
        id: provider_id,
        name: providerName,
        trust_score: providerInfo?.trust_score || 0.5,
      },
      {
        id: testItemId,
        provider_id: provider_id,
        source_type: 'SOLAR',
        delivery_mode: 'GRID_INJECTION',
        available_qty: 10,
        production_windows: [testTimeWindow],
        meter_id: `der://meter/test-${Date.now()}`,
        utility_id: testUtilityInfo.utilityId,
        utility_customer_id: testUtilityInfo.utilityCustomerId,
      },
      {
        id: testOfferId,
        item_id: testItemId,
        provider_id: provider_id,
        price_value: 5.0,
        currency: 'INR',
        max_qty: 10,
        time_window: testTimeWindow,
        pricing_model: 'PER_KWH',
        settlement_type: 'INSTANT',
      }
    );

    res.json({
      success,
      message: success
        ? 'Test offer published successfully! It should appear in discover results.'
        : 'Publishing returned false - check server logs for details',
      testData: {
        providerId: provider_id,
        providerName,
        itemId: testItemId,
        offerId: testOfferId,
        timeWindow: testTimeWindow,
      },
    });
  } catch (error: any) {
    logger.error('Test CDS publish failed', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check if the external CDS is reachable and accepting requests',
    });
  }
});

/**
 * GET /seller/weather/capacity - Get weather-adjusted capacity for a seller
 * Returns effective capacity limit based on weather conditions
 */
router.get('/seller/weather/capacity', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const providerId = req.user!.providerId;

    if (!providerId) {
      return res.status(400).json({ error: 'No seller profile found' });
    }

    // Get user's production capacity, trust limit, address, and provider's generation type
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        productionCapacity: true,
        allowedTradeLimit: true,
        installationAddress: true,
      },
    });

    // Query provider with raw SQL to get all fields
    const providerResult = await prisma.$queryRaw<Array<{ installation_address: string | null; generation_type: string | null }>>`
      SELECT installation_address, generation_type FROM providers WHERE id = ${providerId} LIMIT 1
    `;
    const providerData = providerResult[0];

    if (!user?.productionCapacity || user.productionCapacity <= 0) {
      return res.status(400).json({
        error: 'Production capacity not set. Please update your profile.',
      });
    }

    // Use provider's address first, fall back to user's address
    const installationAddress = providerData?.installation_address || user.installationAddress;

    if (!installationAddress) {
      return res.status(400).json({
        error: 'Installation address not found. Required for weather data.',
      });
    }

    // Calculate base trade limit
    const baseCapacity = (user.productionCapacity * (user.allowedTradeLimit ?? 10)) / 100;

    // Map database generation type to SourceType (normalize to UPPERCASE)
    const dbGenType = (providerData?.generation_type || 'SOLAR').toUpperCase();
    const sourceType = ['SOLAR', 'WIND', 'HYDRO', 'OTHER'].includes(dbGenType)
      ? dbGenType as 'SOLAR' | 'WIND' | 'HYDRO' | 'OTHER'
      : 'SOLAR' as const;

    // Get weather-adjusted capacity
    const weatherCapacity = await getWeatherAdjustedCapacity(
      baseCapacity,
      installationAddress,
      sourceType
    );

    // Get currently committed capacity (sold + active offers)
    const soldOrders = await prisma.order.findMany({
      where: {
        providerId,
        status: { in: ['PENDING', 'ACTIVE', 'COMPLETED'] },
      },
      select: { totalQty: true },
    });

    const totalSoldQty = soldOrders.reduce((sum, order) => sum + (order.totalQty || 0), 0);

    const activeOffers = await prisma.catalogOffer.findMany({
      where: { providerId },
      include: {
        blocks: {
          where: { status: 'AVAILABLE' },
        },
      },
    });

    const totalUnsoldInOffers = activeOffers.reduce((sum, offer) => sum + offer.blocks.length, 0);
    const totalCommitted = totalSoldQty + totalUnsoldInOffers;

    res.json({
      baseCapacity: Math.round(baseCapacity * 10) / 10,
      effectiveCapacity: Math.round(weatherCapacity.effectiveCapacity * 10) / 10,
      condition: weatherCapacity.condition,
      bestWindow: weatherCapacity.bestWindow,
      totalCommitted: Math.round(totalCommitted * 10) / 10,
      remainingCapacity: Math.round((weatherCapacity.effectiveCapacity - totalCommitted) * 10) / 10,
      sourceType,
    });
  } catch (error: any) {
    logger.error('Weather capacity endpoint error', { error: error.message });
    res.status(500).json({ error: 'Failed to get weather capacity' });
  }
});

/**
 * GET /seller/weather/alert - Check for maintenance alerts based on recent weather
 */
router.get('/seller/weather/alert', authMiddleware, requireSellerVC, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const providerId = req.user!.providerId;

    if (!providerId) {
      return res.status(400).json({ error: 'No seller profile found' });
    }

    // Get installation address from user first
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { installationAddress: true },
    });

    // Query provider with raw SQL to get installation address
    const providerResult = await prisma.$queryRaw<Array<{ installation_address: string | null }>>`
      SELECT installation_address FROM providers WHERE id = ${providerId} LIMIT 1
    `;
    const providerData = providerResult[0];

    const installationAddress = providerData?.installation_address || user?.installationAddress;

    if (!installationAddress) {
      return res.json({ alert: null, reason: 'No installation address' });
    }

    // Get location
    const location = await geocodeAddress(installationAddress);
    if (!location) {
      return res.json({ alert: null, reason: 'Could not geocode address' });
    }

    // Fetch weather with 48-hour history (to check last 24h)
    const forecast = await getWeatherForecast(location.lat, location.lon);
    if (!forecast) {
      return res.json({ alert: null, reason: 'Could not fetch weather' });
    }

    // Extract maintenance data from last 24 hours
    const maintenanceData = extractMaintenanceData(
      forecast.hourly.map(h => ({
        precipitation: h.precipitation,
        windSpeed: h.windSpeed,
        weatherCode: h.weatherCode,
      })),
      24
    );

    // Check for last alert date (could be stored in user prefs, for now just check without cooldown)
    // In a full implementation, you'd track lastAlertDate per user
    const alert = getMaintenanceAlert(maintenanceData);

    res.json({
      alert,
      weather: {
        precipitation24h: maintenanceData.precipitation24h,
        maxWindSpeed: maintenanceData.maxWindSpeed,
        hadThunderstorm: maintenanceData.hadThunderstorm,
        hadHail: maintenanceData.hadHail,
      },
      location: location.city,
    });
  } catch (error: any) {
    logger.error('Weather alert endpoint error', { error: error.message });
    res.status(500).json({ error: 'Failed to check weather alerts' });
  }
});

export default router;
