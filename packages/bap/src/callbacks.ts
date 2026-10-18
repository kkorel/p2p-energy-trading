/**
 * BAP Callback Endpoints - Receives async responses from CDS/BPP
 */

import { Router, Request, Response } from 'express';
import {
  OnDiscoverMessage,
  OnSelectMessage,
  OnInitMessage,
  OnConfirmMessage,
  OnStatusMessage,
  createLogger,
  CatalogOffer,
  Provider,
  matchOffers,
  MatchingCriteria,
  config,
  parseWireOrderResponse,
} from '@p2p/shared';
import { logEvent, isDuplicateMessage } from './events';
import { updateTransaction, getTransaction, createTransaction } from './state';
import {
  notifyOrderConfirmed,
  notifyOrderCompleted,
  notifyDeliveryUpdate,
  checkAndNotifyMilestones,
} from './chat/notifications';

const router = Router();
const logger = createLogger('BAP');

/**
 * Transform external CDS catalog format (beckn: prefixed) to our internal format
 * External format uses:
 * - catalogs[] instead of catalog.providers[]
 * - beckn:id, beckn:items, beckn:offers with beckn: prefix
 * - offers at catalog level instead of nested in items
 */
function transformExternalCatalog(rawMessage: any): { providers: any[] } {
  // Check if it's already in our internal format
  if (rawMessage.catalog?.providers) {
    logger.debug('Catalog already in internal format');
    return rawMessage.catalog;
  }
  
  // Check for external format with catalogs array
  const catalogs = rawMessage.catalogs || rawMessage.message?.catalogs || [];
  
  if (!catalogs.length) {
    logger.warn('No catalogs found in response');
    return { providers: [] };
  }
  
  logger.info(`Transforming ${catalogs.length} external catalogs to internal format`);
  
  const providers: any[] = [];
  
  for (const catalog of catalogs) {
    // Extract provider ID - try multiple possible locations
    const providerId = catalog['beckn:providerId'] || catalog.providerId || catalog['beckn:id'] || catalog.id;

    // IMPORTANT: Extract BPP routing info for proper Beckn flows
    const bppId = catalog['beckn:bppId'] || catalog.bppId || providerId;
    const bppUri = catalog['beckn:bppUri'] || catalog.bppUri || null;

    // Extract items - handle beckn: prefix
    const rawItems = catalog['beckn:items'] || catalog.items || [];

    // Extract provider name from items if available (where actual seller name is stored)
    let providerName = 'Unknown Provider';
    if (rawItems.length > 0) {
      const firstItem = rawItems[0];
      const itemProvider = firstItem['beckn:provider'] || firstItem.provider || {};
      const itemProviderDescriptor = itemProvider['beckn:descriptor'] || itemProvider.descriptor || {};
      providerName = itemProviderDescriptor['schema:name'] || itemProviderDescriptor.name || providerName;
    }
    // Fall back to catalog descriptor if no item provider name
    if (providerName === 'Unknown Provider') {
      providerName = catalog['beckn:descriptor']?.['schema:name'] ||
        catalog.descriptor?.name ||
        catalog['beckn:bppId'] ||
        'Unknown Provider';
    }
    
    // Extract offers - can be at catalog level or in items
    const catalogOffers = catalog['beckn:offers'] || catalog.offers || [];
    
    logger.debug('Raw catalog data', {
      providerId,
      itemCount: rawItems.length,
      offerCount: catalogOffers.length,
    });
    
    const transformedItems: any[] = [];
    
    // Helper function to extract offer data
    const extractOfferData = (offer: any, itemId: string, itemAttrs: any = {}) => {
      const offerId = offer['beckn:id'] || offer.id;
      const offerAttrs = offer['beckn:offerAttributes'] || offer.offerAttributes || {};
      
      // Extract price from multiple possible formats
      const offerPrice = offer['beckn:price'] || {};
      const attrPrice = offerAttrs['beckn:price'] || offerAttrs.price || {};
      const priceValue = attrPrice.value ?? offerPrice['schema:price'] ?? attrPrice['schema:price'] ?? offerPrice.value ?? 0;
      const priceCurrency = attrPrice.currency || offerPrice['schema:priceCurrency'] || attrPrice['schema:priceCurrency'] || offerPrice.currency || 'INR';
      
      const timeWindow = offerAttrs['beckn:timeWindow'] || offerAttrs.timeWindow || offerAttrs.validityWindow || {};
      // Extract max quantity from multiple possible sources including price.applicableQuantity
      const priceApplicableQty = offerPrice.applicableQuantity || offerPrice['schema:applicableQuantity'] || {};
      const maxQty = offerAttrs['beckn:maxQuantity'] || offerAttrs.maxQuantity || priceApplicableQty || {};

      return {
        id: offerId,
        item_id: itemId,
        provider_id: providerId,
        // BPP routing info for proper Beckn flows
        bpp_id: bppId,
        bpp_uri: bppUri,
        price: {
          value: typeof priceValue === 'number' ? priceValue : parseFloat(priceValue) || 0,
          currency: priceCurrency,
        },
        maxQuantity: maxQty.unitQuantity || priceApplicableQty.unitQuantity || offerAttrs.maximumQuantity || itemAttrs.availableQuantity || 10,
        timeWindow: {
          startTime: timeWindow['schema:startTime'] || timeWindow.startTime,
          endTime: timeWindow['schema:endTime'] || timeWindow.endTime,
        },
      };
    };
    
    // Process items if they exist
    if (rawItems.length > 0) {
      for (const item of rawItems) {
        const itemId = item['beckn:id'] || item.id;
        const itemAttrs = item['beckn:itemAttributes'] || item.itemAttributes || {};
        
        const itemOffers: any[] = [];
        
        // If offers are at catalog level, filter by item reference
        for (const offer of catalogOffers) {
          const offerItems = offer['beckn:items'] || offer.items || [];
          
          // Check if this offer is for this item
          if (offerItems.includes(itemId) || offerItems.length === 0) {
            itemOffers.push(extractOfferData(offer, itemId, itemAttrs));
          }
        }
        
        transformedItems.push({
          id: itemId,
          offers: itemOffers,
          itemAttributes: {
            sourceType: itemAttrs.sourceType || 'MIXED',
            availableQuantity: itemAttrs.availableQuantity || 100,
            deliveryMode: itemAttrs.deliveryMode || 'GRID_INJECTION',
            meterId: itemAttrs.meterId,
          },
        });
      }
    } else if (catalogOffers.length > 0) {
      // FALLBACK: If no items but offers exist, extract offers with their referenced item IDs
      logger.info('No items found but offers exist, extracting directly', {
        providerId,
        offerCount: catalogOffers.length,
      });
      
      const offersByItem = new Map<string, any[]>();
      
      for (const offer of catalogOffers) {
        const offerItemIds = offer['beckn:items'] || offer.items || [];
        const itemId = offerItemIds[0] || `synthetic-item-${providerId}`;
        
        if (!offersByItem.has(itemId)) {
          offersByItem.set(itemId, []);
        }
        offersByItem.get(itemId)!.push(extractOfferData(offer, itemId, {}));
      }
      
      for (const [itemId, offers] of offersByItem) {
        transformedItems.push({
          id: itemId,
          offers,
          itemAttributes: {
            sourceType: 'MIXED',
            availableQuantity: 100,
            deliveryMode: 'GRID_INJECTION',
          },
        });
      }
    }
    
    providers.push({
      id: providerId,
      descriptor: {
        name: providerName,
      },
      // BPP routing info at provider level
      bpp_id: bppId,
      bpp_uri: bppUri,
      items: transformedItems,
    });
  }
  
  logger.info(`Transformed catalog: ${providers.length} providers`);
  return { providers };
}

/**
 * POST /callbacks/on_discover - Receive catalog from CDS
 */
router.post('/on_discover', async (req: Request, res: Response) => {
  const message = req.body;
  // Handle different message formats - external CDS uses 'ack' wrapper
  const context = message.context || message.ack?.context;
  const content = message.message || message.ack?.message || message;
  
  if (!context) {
    logger.error('No context found in on_discover callback', { body: JSON.stringify(message).slice(0, 500) });
    return res.status(400).json({ status: 'error', message: 'Missing context' });
  }
  
  logger.info('Received on_discover callback', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
    hasAckWrapper: !!message.ack,
  });
  
  // Check for duplicate
  if (await isDuplicateMessage(context.message_id)) {
    logger.warn('Duplicate on_discover callback ignored', { message_id: context.message_id });
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }
  
  // Log event
  await logEvent(context.transaction_id, context.message_id, 'on_discover', 'INBOUND', JSON.stringify(message));
  
  // Update transaction state
  let txState = await getTransaction(context.transaction_id);
  if (!txState) {
    txState = await createTransaction(context.transaction_id);
  }
  
  // Transform external catalog format to internal format
  const catalog = transformExternalCatalog(content);
  
  // Get the provider ID to exclude (user's own provider)
  const excludeProviderId = txState.excludeProviderId;
  
  // Filter out user's own provider from catalog
  const filteredProviders = catalog.providers.filter(p => p.id !== excludeProviderId);
  
  // Extract providers and offers for matching (excluding user's own)
  const providers = new Map<string, Provider>();
  const allOffers: CatalogOffer[] = [];
  
  for (const providerCatalog of filteredProviders) {
    // Create basic provider entry (trust scores would come from a real provider registry)
    providers.set(providerCatalog.id, {
      id: providerCatalog.id,
      name: providerCatalog.descriptor?.name || 'Unknown',
      trust_score: config.matching.defaultTrustScore,
      total_orders: 0,
      successful_orders: 0,
    });
    
    for (const item of providerCatalog.items) {
      allOffers.push(...item.offers);
    }
  }
  
  // Update catalog with filtered providers
  const filteredCatalog = {
    ...catalog,
    providers: filteredProviders,
  };
  
  // Always run matching algorithm on all offers to calculate scores
  let matchingResults = null;
  if (allOffers.length > 0) {
    const criteria: MatchingCriteria = {
      requestedQuantity: txState.discoveryCriteria?.minQuantity || 1, // Default to 1 if not specified
      requestedTimeWindow: txState.discoveryCriteria?.timeWindow, // Can be undefined
      maxPrice: txState.discoveryCriteria?.maxPrice, // Can be undefined
    };
    
    try {
      matchingResults = matchOffers(allOffers, providers, criteria);
      
      logger.info(`Matching algorithm scored ${matchingResults.allOffers.length} offers, ${matchingResults.eligibleCount} eligible`, {
        transaction_id: context.transaction_id,
        criteria: {
          requestedQuantity: criteria.requestedQuantity,
          hasTimeWindow: !!criteria.requestedTimeWindow,
          maxPrice: criteria.maxPrice,
        },
      });
      
      if (matchingResults.selectedOffer) {
        logger.info(`Best matching offer: ${matchingResults.selectedOffer.offer.id} with score ${matchingResults.selectedOffer.score.toFixed(3)}`, {
          transaction_id: context.transaction_id,
          breakdown: matchingResults.selectedOffer.breakdown,
          matchesFilters: matchingResults.selectedOffer.matchesFilters,
        });
      }
    } catch (matchError: any) {
      logger.error(`Matching algorithm error: ${matchError.message}`, {
        transaction_id: context.transaction_id,
        offers: allOffers.map(o => ({ id: o.id, hasTimeWindow: !!o.timeWindow })),
      });
      // Continue without matching results
    }
  }
  
  await updateTransaction(context.transaction_id, {
    catalog: filteredCatalog,
    providers,
    matchingResults,
    status: 'SELECTING',
  });
  
  const itemCount = filteredCatalog.providers.reduce((sum, p) => sum + p.items.length, 0);
  const offerCount = allOffers.length;
  
  if (excludeProviderId) {
    logger.info(`Filtered out user's own provider ${excludeProviderId} from catalog`, {
      transaction_id: context.transaction_id,
    });
  }
  
  logger.info(`Catalog received: ${filteredCatalog.providers.length} providers, ${itemCount} items, ${offerCount} offers`, {
    transaction_id: context.transaction_id,
  });
  
  res.json({ 
    status: 'ok', 
    providers: filteredCatalog.providers.length, 
    items: itemCount, 
    offers: offerCount,
    bestMatch: matchingResults?.selectedOffer ? {
      offer_id: matchingResults.selectedOffer.offer.id,
      score: matchingResults.selectedOffer.score,
      breakdown: matchingResults.selectedOffer.breakdown,
    } : null,
  });
});

/**
 * POST /callbacks/on_select - Receive selection confirmation from BPP
 */
router.post('/on_select', async (req: Request, res: Response) => {
  const message = req.body as OnSelectMessage;
  const { context, message: content } = message;
  
  logger.info('Received on_select callback', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });
  
  if (await isDuplicateMessage(context.message_id)) {
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }
  
  await logEvent(context.transaction_id, context.message_id, 'on_select', 'INBOUND', JSON.stringify(message));
  
  // Parse both Beckn v2 wire format and internal format
  const parsed = parseWireOrderResponse(content);
  const internalOrder = (content as any)._internalOrder || content.order;

  await updateTransaction(context.transaction_id, {
    status: 'INITIALIZING',
  });

  const orderId = parsed.orderId || internalOrder?.id || 'unknown';
  const quotePrice = parsed.quote?.price?.value || internalOrder?.quote?.price?.value || 0;
  const quoteCurrency = parsed.quote?.price?.currency || internalOrder?.quote?.price?.currency || 'INR';

  logger.info(`Selection confirmed: order ${orderId}, quote: ${quotePrice} ${quoteCurrency}`, {
    transaction_id: context.transaction_id,
  });

  res.json({ status: 'ok', order_id: orderId });
});

/**
 * POST /callbacks/on_init - Receive order initialization from BPP
 * Supports both single order and bulk orders (multiple separate orders)
 */
router.post('/on_init', async (req: Request, res: Response) => {
  const message = req.body as any; // Can be OnInitMessage or error
  const { context, message: content, error } = message;

  logger.info('Received on_init callback', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
    hasError: !!error,
    hasBulkOrders: !!content?.bulkOrders,
  });

  if (await isDuplicateMessage(context.message_id)) {
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }

  await logEvent(context.transaction_id, context.message_id, 'on_init', 'INBOUND', JSON.stringify(message));

  // Handle error response
  if (error) {
    logger.error(`Order initialization failed: ${error.message}`, {
      transaction_id: context.transaction_id,
      error_code: error.code,
    });

    await updateTransaction(context.transaction_id, {
      status: 'DISCOVERING', // Reset status so user can try again
      error: error.message,
    });

    return res.json({ status: 'error', error: error.message });
  }

  // Parse both Beckn v2 wire format and internal format
  const parsedInit = parseWireOrderResponse(content);
  const internalOrder = (content as any)._internalOrder || content.order;

  // Handle bulk orders (multiple separate orders from bulk purchase)
  if (content.bulkOrders && content.bulkOrders.length > 0) {
    await updateTransaction(context.transaction_id, {
      order: internalOrder, // Primary order for compatibility
      bulkOrders: content.bulkOrders.map((o: any) => ({
        id: o['beckn:id'] || o.id,
        transactionId: o.transactionId || o.transaction_id,
        status: o.status,
      })), // Normalize field names to match TransactionState type
      bulkGroupId: content.bulkGroupId,
      status: 'CONFIRMING',
      error: undefined,
    });

    const primaryId = parsedInit.orderId || internalOrder?.id || 'unknown';
    logger.info(`Bulk orders initialized: ${content.bulkOrders.length} orders, group ${content.bulkGroupId}`, {
      transaction_id: context.transaction_id,
      orderIds: content.bulkOrders.map((o: any) => o['beckn:id'] || o.id),
    });

    return res.json({
      status: 'ok',
      order_id: primaryId,
      bulk_orders: content.bulkOrders.length,
      bulk_group_id: content.bulkGroupId,
    });
  }

  // Single order (original flow)
  const orderId = parsedInit.orderId || internalOrder?.id || 'unknown';
  const orderStatus = parsedInit.status || internalOrder?.status || 'DRAFT';

  await updateTransaction(context.transaction_id, {
    order: internalOrder,
    status: 'CONFIRMING',
    error: undefined, // Clear any previous error
  });

  logger.info(`Order initialized: ${orderId}, status: ${orderStatus}`, {
    transaction_id: context.transaction_id,
  });

  res.json({ status: 'ok', order_id: orderId, order_status: orderStatus });
});

/**
 * POST /callbacks/on_confirm - Receive order confirmation from BPP
 * This is where we write the trade to the DEG Ledger
 */
router.post('/on_confirm', async (req: Request, res: Response) => {
  const message = req.body as OnConfirmMessage;
  const { context, message: content } = message;
  
  logger.info('Received on_confirm callback', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });
  
  if (await isDuplicateMessage(context.message_id)) {
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }
  
  await logEvent(context.transaction_id, context.message_id, 'on_confirm', 'INBOUND', JSON.stringify(message));
  
  // Parse both Beckn v2 wire format and internal format
  const parsedConfirm = parseWireOrderResponse(content);
  const internalOrder = (content as any)._internalOrder || content.order;

  // Get transaction state to retrieve buyer info
  const txState = await getTransaction(context.transaction_id);

  const orderId = parsedConfirm.orderId || internalOrder?.id || 'unknown';
  const orderStatus = parsedConfirm.status || internalOrder?.status || 'ACTIVE';

  await updateTransaction(context.transaction_id, {
    order: internalOrder,
    status: 'ACTIVE',
  });

  logger.info(`Order confirmed: ${orderId}, status: ${orderStatus}`, {
    transaction_id: context.transaction_id,
  });

  // Send WhatsApp notifications (async, don't block response)
  const orderItems = parsedConfirm.items || internalOrder?.items || [];
  const firstItem = orderItems[0] as any || {};
  const quote = parsedConfirm.quote || internalOrder?.quote as any || {};

  notifyOrderConfirmed({
    orderId,
    transactionId: context.transaction_id,
    buyerId: txState?.buyerId || undefined,
    sellerId: firstItem?.provider_id || parsedConfirm.providerId,
    quantity: quote?.breakup?.find((b: any) => b.title === 'energy')?.quantity || quote?.totalQuantity || 0,
    totalPrice: quote?.price?.value || 0,
    pricePerKwh: quote?.breakup?.find((b: any) => b.title === 'energy')?.price?.value || 0,
    timeWindow: firstItem?.fulfillment?.time?.range
      ? `${firstItem.fulfillment.time.range.start} - ${firstItem.fulfillment.time.range.end}`
      : undefined,
    energyType: firstItem?.descriptor?.name || 'solar',
  }).catch(err => {
    logger.warn(`Failed to send order notifications: ${err.message}`);
  });

  // Write trade to DEG Ledger (async, don't block response)
  // Import dynamically to avoid circular dependencies
  import('./ledger').then(async ({ writeTradeToLedger }) => {
    try {
      const buyerId = txState?.buyerId || 'unknown-buyer';
      const sellerId = firstItem?.provider_id || parsedConfirm.providerId || 'unknown-seller';

      const ledgerResult = await writeTradeToLedger(
        context.transaction_id,
        internalOrder,
        buyerId,
        sellerId
      );

      if (ledgerResult.success) {
        logger.info('Trade recorded in ledger', {
          transaction_id: context.transaction_id,
          ledger_record_id: ledgerResult.recordId,
        });
      } else {
        logger.warn('Failed to record trade in ledger (non-blocking)', {
          transaction_id: context.transaction_id,
          error: ledgerResult.error,
        });
      }
    } catch (ledgerError: any) {
      logger.error('Ledger write error (non-blocking)', {
        transaction_id: context.transaction_id,
        error: ledgerError.message,
      });
    }
  }).catch(err => {
    logger.error('Failed to load ledger module', { error: err.message });
  });

  res.json({ status: 'ok', order_id: orderId, order_status: orderStatus });
});

/**
 * POST /callbacks/on_status - Receive order status from BPP
 */
router.post('/on_status', async (req: Request, res: Response) => {
  const message = req.body as OnStatusMessage;
  const { context, message: content } = message;
  
  logger.info('Received on_status callback', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
    action: context.action,
  });
  
  if (await isDuplicateMessage(context.message_id)) {
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }
  
  await logEvent(context.transaction_id, context.message_id, 'on_status', 'INBOUND', JSON.stringify(message));
  
  // Parse both Beckn v2 wire format and internal format
  const parsedStatus = parseWireOrderResponse(content);
  const internalOrder = (content as any)._internalOrder || content.order;

  await updateTransaction(context.transaction_id, {
    order: internalOrder,
  });

  const orderId = parsedStatus.orderId || internalOrder?.id || 'unknown';
  const orderStatus = parsedStatus.status || internalOrder?.status || 'unknown';
  const fulfillmentState = content.fulfillment?.state?.descriptor?.name || 'Unknown';

  logger.info(`Order status: ${orderId}, status: ${orderStatus}, fulfillment: ${fulfillmentState}`, {
    transaction_id: context.transaction_id,
  });

  res.json({
    status: 'ok',
    order_id: orderId,
    order_status: orderStatus,
    fulfillment: fulfillmentState,
  });
});

/**
 * POST /callbacks/on_update - Receive delivery updates from Utility BPP (DISCOM)
 *
 * This callback handles real-time delivery progress and curtailment notifications
 * as energy is being delivered during the order's time window.
 *
 * Schema Reference: EnergyTradeDelivery/v0.2
 * Payment Status Lifecycle: PENDING → INITIATED → AUTHORIZED → ADJUSTED → SETTLED
 *
 * Sender: Utility BPP (DISCOM) - based on meter readings and grid status
 *
 * Use Cases:
 * 1. Normal delivery progress (deliveredQuantity increasing)
 * 2. Curtailment due to grid outage → payment ADJUSTED
 * 3. Partial fulfillment (seller under-delivery) → payment ADJUSTED
 * 4. Completion notification with final invoice → payment SETTLED
 */
router.post('/on_update', async (req: Request, res: Response) => {
  const message = req.body;
  // Handle different message formats - external services may use wrapper
  const context = message.context || message.ack?.context;
  const content = message.message || message.ack?.message || message;

  if (!context) {
    logger.error('No context found in on_update callback', { body: JSON.stringify(message).slice(0, 500) });
    return res.status(400).json({ status: 'error', message: 'Missing context' });
  }

  logger.info('on_update received', {
    transaction_id: context.transaction_id,
    message_id: context.message_id,
  });

  // Check for duplicate
  if (await isDuplicateMessage(context.message_id)) {
    return res.json({ status: 'ok', message: 'duplicate ignored' });
  }

  // Log the raw event for audit trail
  await logEvent(context.transaction_id, context.message_id, 'on_update', 'INBOUND', JSON.stringify(message));

  // Extract order data from Beckn v2 format
  const order = content.order || content;
  const orderId = order['beckn:id'] || order.id;
  const orderStatus = order['beckn:orderStatus'] || order.status;
  const orderItems = order['beckn:orderItems'] || order.items || [];

  // Extract payment info (per DEG payment spec)
  const payment = order['beckn:payment'] || order.payment || {};
  const paymentStatus = payment['beckn:paymentStatus'] || payment.paymentStatus || payment.status;
  const paymentAmount = payment['beckn:amount'] || payment.amount || {};
  const paymentUrl = payment['beckn:paymentURL'] || payment.paymentURL || payment.uri;

  // Extract bill components (UNIT, FEE breakdown)
  const orderValue = order['beckn:orderValue'] || order.orderValue || order.quote || {};
  const billComponents = orderValue.components || orderValue['beckn:components'] || [];

  // Log payment status transition
  if (paymentStatus) {
    logger.info(`Payment status: ${paymentStatus}`, {
      transaction_id: context.transaction_id,
    });
  }

  // Log bill components if present
  if (billComponents.length > 0) {
    logger.info(`Bill components: ${billComponents.length} items`, {
      transaction_id: context.transaction_id,
    });
    for (const comp of billComponents) {
      const type = comp.type || comp['@type'];
      const value = comp.value || comp['schema:price'];
      const desc = comp.description || comp['schema:description'];
      logger.info(`  ${type}: ${value} - ${desc}`);
    }
  }

  // Process each order item's fulfillment data
  const fulfillmentUpdates: Array<{
    itemId: string;
    deliveryStatus: string;
    deliveredQty: number;
    curtailedQty: number;
    curtailmentReason?: string;
    meterReadings: any[];
    lastUpdated: string;
  }> = [];

  for (const item of orderItems) {
    const itemId = item['beckn:orderedItem'] || item.orderedItem || item.id;
    const itemAttrs = item['beckn:orderItemAttributes'] || item.orderItemAttributes || {};
    const fulfillmentAttrs = itemAttrs.fulfillmentAttributes || {};

    const update = {
      itemId,
      deliveryStatus: fulfillmentAttrs.deliveryStatus || 'UNKNOWN',
      deliveredQty: fulfillmentAttrs.deliveredQuantity || 0,
      curtailedQty: fulfillmentAttrs.curtailedQuantity || 0,
      curtailmentReason: fulfillmentAttrs.curtailmentReason,
      meterReadings: fulfillmentAttrs.meterReadings || [],
      lastUpdated: fulfillmentAttrs.lastUpdated || new Date().toISOString(),
    };

    fulfillmentUpdates.push(update);

    // Log curtailment events prominently
    if (update.curtailedQty > 0) {
      logger.warn('Curtailment detected', {
        transaction_id: context.transaction_id,
      });
    }
  }

  // Calculate aggregate totals
  const totalDelivered = fulfillmentUpdates.reduce((sum, u) => sum + u.deliveredQty, 0);
  const totalCurtailed = fulfillmentUpdates.reduce((sum, u) => sum + u.curtailedQty, 0);
  const hasCompletedItems = fulfillmentUpdates.some(u => u.deliveryStatus === 'COMPLETED');
  const hasFailedItems = fulfillmentUpdates.some(u => u.deliveryStatus === 'FAILED');

  // Determine overall delivery status based on items
  let effectiveStatus: string = orderStatus;
  if (hasFailedItems && hasCompletedItems) {
    effectiveStatus = 'PARTIALLYFULFILLED';
  } else if (hasCompletedItems && !hasFailedItems) {
    effectiveStatus = 'COMPLETED';
  }

  // Update transaction state with fulfillment and payment data
  await updateTransaction(context.transaction_id, {
    fulfillmentUpdates,
    lastFulfillmentUpdate: new Date().toISOString(),
    deliveryStatus: effectiveStatus,
    totalDelivered,
    totalCurtailed,
    paymentStatus,
    paymentAmount: paymentAmount.value,
    paymentCurrency: paymentAmount.currency,
    paymentUrl,
    billComponents,
  });

  logger.info(`on_update: order ${orderId}, delivery=${effectiveStatus}, payment=${paymentStatus || 'N/A'}, delivered=${totalDelivered} kWh`, {
    transaction_id: context.transaction_id,
  });

  // If order is completed or settled, verify allocation via ledger
  if (effectiveStatus === 'COMPLETED' || paymentStatus === 'SETTLED') {
    logger.info('Order completed/settled - verifying ledger allocation', {
      transaction_id: context.transaction_id,
    });

    // Verify allocation via ledger/get (async, don't block response)
    import('./ledger').then(async ({ getTradeFromLedger }) => {
      try {
        const ledgerResult = await getTradeFromLedger(context.transaction_id, orderId);

        if (ledgerResult.success && ledgerResult.records && ledgerResult.records.length > 0) {
          const record = ledgerResult.records[0];
          logger.info('Ledger allocation verified', {
            transaction_id: context.transaction_id,
          });

          // Check if DISCOM has recorded fulfillment metrics
          const buyerMetrics = record.buyerFulfillmentValidationMetrics || [];
          const sellerMetrics = record.sellerFulfillmentValidationMetrics || [];
          const buyerStatus = record.statusBuyerDiscom;
          const sellerStatus = record.statusSellerDiscom;

          if (buyerStatus || sellerStatus) {
            logger.info(`Ledger DISCOM status - buyer: ${buyerStatus || 'pending'}, seller: ${sellerStatus || 'pending'}`);
          }

          // Log actual metrics if present
          for (const metric of [...buyerMetrics, ...sellerMetrics]) {
            logger.info(`  ${metric.validationMetricType}: ${metric.validationMetricValue}`);
          }
        } else {
          logger.warn('No ledger record found for verification', {
            transaction_id: context.transaction_id,
          });
        }
      } catch (ledgerError: any) {
        logger.error('Ledger verification failed (non-blocking)', {
          transaction_id: context.transaction_id,
        });
      }
    }).catch(err => {
      logger.error('Failed to load ledger module', { error: err.message });
    });

    // Get transaction for buyer/seller info
    const txState = await getTransaction(context.transaction_id);
    const sellerId = (txState?.order as any)?.provider_id || txState?.selectedOffer?.provider_id || null;

    // Send completion notifications
    if (effectiveStatus === 'COMPLETED') {
      const orderPrice = paymentAmount.value || (txState?.order as any)?.quote?.price?.value || 0;

      notifyOrderCompleted({
        orderId,
        buyerId: txState?.buyerId || undefined,
        sellerId: sellerId || undefined,
        quantity: totalDelivered + totalCurtailed,
        totalPrice: orderPrice,
        deliveredQty: totalDelivered,
      }).catch(err => {
        logger.warn(`Failed to send completion notification: ${err.message}`);
      });

      // Check for milestone achievements (buyer)
      if (txState?.buyerId) {
        checkAndNotifyMilestones({
          userId: txState.buyerId,
          isSeller: false,
          orderQuantity: totalDelivered,
          orderAmount: orderPrice,
        }).catch(err => {
          logger.warn(`Failed to check buyer milestones: ${err.message}`);
        });
      }

      // Check for milestone achievements (seller)
      if (sellerId) {
        checkAndNotifyMilestones({
          userId: sellerId,
          isSeller: true,
          orderQuantity: totalDelivered,
          orderAmount: orderPrice,
        }).catch(err => {
          logger.warn(`Failed to check seller milestones: ${err.message}`);
        });
      }
    } else if (totalCurtailed > 0) {
      // Notify about partial delivery/curtailment
      notifyDeliveryUpdate({
        orderId,
        buyerId: txState?.buyerId || undefined,
        sellerId: sellerId || undefined,
        deliveredQty: totalDelivered,
        expectedQty: totalDelivered + totalCurtailed,
        curtailedQty: totalCurtailed,
        curtailmentReason: fulfillmentUpdates.find(u => u.curtailmentReason)?.curtailmentReason,
      }).catch(err => {
        logger.warn(`Failed to send delivery update notification: ${err.message}`);
      });
    }
  }

  res.json({
    status: 'ok',
    order_id: orderId,
    order_status: effectiveStatus,
    payment_status: paymentStatus || 'N/A',
    total_delivered: totalDelivered,
    total_curtailed: totalCurtailed,
    items_updated: fulfillmentUpdates.length,
  });
});

export default router;

