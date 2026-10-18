/**
 * Catalog data access for Seller (BPP) functionality
 * Using Prisma ORM for PostgreSQL persistence
 * With concurrency-safe block claiming using distributed locks and row-level locking
 */

import { v4 as uuidv4 } from 'uuid';
import { Prisma } from '@p2p/shared/src/generated/prisma';
import { prisma } from './db';
import { 
  CatalogOffer, 
  Provider, 
  TimeWindow, 
  SourceType, 
  DeliveryMode,
  withOfferLock,
  withOrderLock,
  InsufficientBlocksError,
} from '@p2p/shared';

export interface CatalogItem {
  id: string;
  provider_id: string;
  source_type: SourceType;
  delivery_mode: DeliveryMode;
  available_qty: number;
  production_windows: TimeWindow[];
  meter_id: string;
}

/**
 * Get an offer by ID (with available blocks)
 */
export async function getOfferById(offerId: string): Promise<(CatalogOffer & { availableBlocks?: number }) | null> {
  const offer = await prisma.catalogOffer.findUnique({
    where: { id: offerId },
  });
  
  if (!offer) {
    return null;
  }
  
  // Get available blocks count
  const availableBlocks = await getAvailableBlockCount(offerId);
  
  return {
    id: offer.id,
    item_id: offer.itemId,
    provider_id: offer.providerId,
    offerAttributes: {
      pricingModel: offer.pricingModel as 'PER_KWH' | 'FLAT_RATE',
      settlementType: offer.settlementType as 'DAILY' | 'WEEKLY' | 'MONTHLY',
    },
    price: {
      value: offer.priceValue,
      currency: offer.currency,
    },
    maxQuantity: offer.maxQty,
    timeWindow: {
      startTime: offer.timeWindowStart.toISOString(),
      endTime: offer.timeWindowEnd.toISOString(),
    },
    availableBlocks: availableBlocks > 0 ? availableBlocks : offer.maxQty,
  };
}

/**
 * Get item available quantity
 */
export async function getItemAvailableQuantity(itemId: string): Promise<number | null> {
  const item = await prisma.catalogItem.findUnique({
    where: { id: itemId },
    select: { availableQty: true },
  });
  
  return item?.availableQty ?? null;
}

/**
 * Get provider by ID
 */
export async function getProvider(providerId: string): Promise<Provider | null> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  });
  
  if (!provider) {
    return null;
  }
  
  return {
    id: provider.id,
    name: provider.name,
    trust_score: provider.trustScore,
    total_orders: provider.totalOrders,
    successful_orders: provider.successfulOrders,
  };
}

/**
 * Update provider statistics after order completion
 */
export async function updateProviderStats(providerId: string, wasSuccessful: boolean): Promise<void> {
  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
  });
  
  if (!provider) return;
  
  const newTotalOrders = provider.totalOrders + 1;
  const newSuccessfulOrders = provider.successfulOrders + (wasSuccessful ? 1 : 0);
  
  // Calculate new trust score
  const successRate = newSuccessfulOrders / newTotalOrders;
  const baseRating = 0.5;
  const newTrustScore = successRate * 0.7 + baseRating * 0.3;
  
  await prisma.provider.update({
    where: { id: providerId },
    data: {
      totalOrders: newTotalOrders,
      successfulOrders: newSuccessfulOrders,
      trustScore: newTrustScore,
    },
  });
}

// ==================== SELLER APIs ====================

/**
 * Register a new provider (seller)
 */
export async function registerProvider(name: string): Promise<Provider> {
  const id = `provider-${uuidv4().substring(0, 8)}`;
  
  const provider = await prisma.provider.create({
    data: {
      id,
      name,
      trustScore: 0.5,
      totalOrders: 0,
      successfulOrders: 0,
    },
  });
  
  return {
    id: provider.id,
    name: provider.name,
    trust_score: provider.trustScore,
    total_orders: provider.totalOrders,
    successful_orders: provider.successfulOrders,
  };
}

/**
 * Get all providers
 */
export async function getAllProviders(): Promise<Provider[]> {
  const providers = await prisma.provider.findMany();
  
  return providers.map(p => ({
    id: p.id,
    name: p.name,
    trust_score: p.trustScore,
    total_orders: p.totalOrders,
    successful_orders: p.successfulOrders,
  }));
}

/**
 * Add a catalog item (energy listing)
 */
export async function addCatalogItem(
  providerId: string,
  sourceType: SourceType,
  deliveryMode: DeliveryMode = 'SCHEDULED',
  availableQty: number,
  productionWindows: TimeWindow[],
  meterId: string
): Promise<CatalogItem> {
  const id = `item-${sourceType.toLowerCase()}-${uuidv4().substring(0, 6)}`;
  
  const item = await prisma.catalogItem.create({
    data: {
      id,
      providerId,
      sourceType,
      deliveryMode,
      availableQty,
      meterId,
      productionWindowsJson: JSON.stringify(productionWindows),
    },
  });
  
  return {
    id: item.id,
    provider_id: item.providerId,
    source_type: item.sourceType as SourceType,
    delivery_mode: item.deliveryMode as DeliveryMode,
    available_qty: item.availableQty,
    production_windows: productionWindows,
    meter_id: item.meterId || '',
  };
}

/**
 * Get all items for a provider
 */
export async function getProviderItems(providerId: string): Promise<CatalogItem[]> {
  const items = await prisma.catalogItem.findMany({
    where: { providerId },
  });
  
  return items.map(item => ({
    id: item.id,
    provider_id: item.providerId,
    source_type: item.sourceType as SourceType,
    delivery_mode: item.deliveryMode as DeliveryMode,
    available_qty: item.availableQty,
    production_windows: JSON.parse(item.productionWindowsJson || '[]'),
    meter_id: item.meterId || '',
  }));
}

/**
 * Get all items
 */
export async function getAllItems(): Promise<CatalogItem[]> {
  const items = await prisma.catalogItem.findMany();
  
  return items.map(item => ({
    id: item.id,
    provider_id: item.providerId,
    source_type: item.sourceType as SourceType,
    delivery_mode: item.deliveryMode as DeliveryMode,
    available_qty: item.availableQty,
    production_windows: JSON.parse(item.productionWindowsJson || '[]'),
    meter_id: item.meterId || '',
  }));
}

/**
 * Add an offer for an item
 * Creates the offer and generates individual 1-unit blocks
 */
export async function addOffer(
  itemId: string,
  providerId: string,
  pricePerKwh: number,
  currency: string,
  maxQty: number,
  timeWindow: TimeWindow
): Promise<CatalogOffer> {
  const id = `offer-${uuidv4().substring(0, 8)}`;
  
  const offer = await prisma.catalogOffer.create({
    data: {
      id,
      itemId,
      providerId,
      priceValue: pricePerKwh,
      currency,
      maxQty,
      timeWindowStart: new Date(timeWindow.startTime),
      timeWindowEnd: new Date(timeWindow.endTime),
      pricingModel: 'PER_KWH',
      settlementType: 'DAILY',
    },
  });
  
  // Create individual blocks (1 block = 1 unit)
  await createBlocksForOffer(id, itemId, providerId, pricePerKwh, currency, maxQty);
  
  return {
    id: offer.id,
    item_id: offer.itemId,
    provider_id: offer.providerId,
    offerAttributes: {
      pricingModel: 'PER_KWH',
      settlementType: 'DAILY',
    },
    price: { value: offer.priceValue, currency: offer.currency },
    maxQuantity: offer.maxQty,
    timeWindow,
  };
}

export interface BlockStats {
  total: number;
  available: number;
  reserved: number;
  sold: number;
  delivered: number; // Sold blocks whose orders are completed + verified
  activeCommitment: number; // What counts against trade limit (available + reserved + undelivered sold)
}

/**
 * Get all offers for a provider (with block stats)
 */
export async function getProviderOffers(providerId: string): Promise<(CatalogOffer & { blockStats?: BlockStats })[]> {
  const offers = await prisma.catalogOffer.findMany({
    where: { providerId },
  });
  
  const result: (CatalogOffer & { blockStats?: BlockStats })[] = [];
  
  for (const offer of offers) {
    const blockStats = await getBlockStats(offer.id);
    
    result.push({
      id: offer.id,
      item_id: offer.itemId,
      provider_id: offer.providerId,
      offerAttributes: {
        pricingModel: offer.pricingModel as 'PER_KWH' | 'FLAT_RATE',
        settlementType: offer.settlementType as 'DAILY' | 'WEEKLY' | 'MONTHLY',
      },
      price: { value: offer.priceValue, currency: offer.currency },
      maxQuantity: offer.maxQty,
      timeWindow: {
        startTime: offer.timeWindowStart.toISOString(),
        endTime: offer.timeWindowEnd.toISOString(),
      },
      blockStats,
    });
  }
  
  return result;
}

/**
 * Get all offers (with block stats)
 */
export async function getAllOffers(): Promise<(CatalogOffer & { blockStats?: BlockStats })[]> {
  const offers = await prisma.catalogOffer.findMany();
  
  const result: (CatalogOffer & { blockStats?: BlockStats })[] = [];
  
  for (const offer of offers) {
    const blockStats = await getBlockStats(offer.id);
    
    result.push({
      id: offer.id,
      item_id: offer.itemId,
      provider_id: offer.providerId,
      offerAttributes: {
        pricingModel: offer.pricingModel as 'PER_KWH' | 'FLAT_RATE',
        settlementType: offer.settlementType as 'DAILY' | 'WEEKLY' | 'MONTHLY',
      },
      price: { value: offer.priceValue, currency: offer.currency },
      maxQuantity: offer.maxQty,
      timeWindow: {
        startTime: offer.timeWindowStart.toISOString(),
        endTime: offer.timeWindowEnd.toISOString(),
      },
      blockStats,
    });
  }
  
  return result;
}

/**
 * Update item available quantity
 */
export async function updateItemQuantity(itemId: string, newQuantity: number): Promise<void> {
  await prisma.catalogItem.update({
    where: { id: itemId },
    data: { availableQty: newQuantity },
  });
}

/**
 * Delete an offer
 */
export async function deleteOffer(offerId: string): Promise<boolean> {
  // Delete all blocks for this offer first (cascade should handle this, but being explicit)
  await prisma.offerBlock.deleteMany({
    where: { offerId },
  });
  
  await prisma.catalogOffer.delete({
    where: { id: offerId },
  });
  
  return true;
}

// ==================== BLOCK-BASED ORDER BOOK ====================

export interface OfferBlock {
  id: string;
  offer_id: string;
  item_id: string;
  provider_id: string;
  status: 'AVAILABLE' | 'RESERVED' | 'SOLD';
  order_id?: string;
  transaction_id?: string;
  price_value: number;
  currency: string;
  created_at: string;
  reserved_at?: string;
  sold_at?: string;
}

/**
 * Create blocks for an offer (1 block = 1 unit)
 */
export async function createBlocksForOffer(
  offerId: string,
  itemId: string,
  providerId: string,
  priceValue: number,
  currency: string,
  quantity: number
): Promise<OfferBlock[]> {
  const blocks: OfferBlock[] = [];
  const now = new Date();
  
  // Batch create blocks for better performance
  const blockData = Array.from({ length: quantity }, (_, i) => ({
    id: `block-${offerId}-${i}`,
    offerId,
    itemId,
    providerId,
    status: 'AVAILABLE',
    priceValue,
    currency,
  }));
  
  await prisma.offerBlock.createMany({
    data: blockData,
  });
  
  // Return the created blocks
  for (let i = 0; i < quantity; i++) {
    blocks.push({
      id: `block-${offerId}-${i}`,
      offer_id: offerId,
      item_id: itemId,
      provider_id: providerId,
      status: 'AVAILABLE',
      price_value: priceValue,
      currency,
      created_at: now.toISOString(),
    });
  }
  
  return blocks;
}

/**
 * Atomically claim available blocks for an offer using row-level locking
 * Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent race conditions
 * Returns the blocks successfully claimed
 * 
 * CONCURRENCY SAFE: Uses distributed lock + database row locking
 */
export async function claimBlocks(
  offerId: string,
  quantity: number,
  orderId: string,
  transactionId: string
): Promise<OfferBlock[]> {
  const now = new Date();
  
  // Use distributed lock to prevent concurrent claims on same offer
  return withOfferLock(offerId, async () => {
    // Use database transaction with row-level locking
    return prisma.$transaction(async (tx) => {
      // Use raw SQL for SELECT ... FOR UPDATE SKIP LOCKED
      // This acquires row-level locks on selected rows, skipping already-locked rows
      const lockedBlocks = await tx.$queryRaw<{ id: string; item_id: string; provider_id: string; price_value: number; currency: string; created_at: Date }[]>`
        SELECT id, item_id, provider_id, price_value, currency, created_at
        FROM offer_blocks 
        WHERE offer_id = ${offerId} 
          AND status = 'AVAILABLE'
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED
      `;
      
      if (lockedBlocks.length === 0) {
        return [];
      }
      
      // If we got fewer blocks than requested, that's okay - we return what we got
      // The caller can decide whether to proceed with partial fulfillment or fail
      const blockIds = lockedBlocks.map(b => b.id);
      
      // Update blocks to RESERVED status atomically
      await tx.offerBlock.updateMany({
        where: {
          id: { in: blockIds },
          status: 'AVAILABLE', // Double-check status for safety
        },
        data: {
          status: 'RESERVED',
          orderId,
          transactionId,
          reservedAt: now,
        },
      });
      
      return lockedBlocks.map(block => ({
        id: block.id,
        offer_id: offerId,
        item_id: block.item_id,
        provider_id: block.provider_id,
        status: 'RESERVED' as const,
        order_id: orderId,
        transaction_id: transactionId,
        price_value: block.price_value,
        currency: block.currency,
        created_at: block.created_at.toISOString(),
        reserved_at: now.toISOString(),
      }));
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10000, // 10 second timeout
    });
  });
}

/**
 * Atomically claim blocks with strict quantity requirement
 * Throws InsufficientBlocksError if not enough blocks available
 * 
 * Use this when partial fulfillment is not acceptable
 */
export async function claimBlocksStrict(
  offerId: string,
  quantity: number,
  orderId: string,
  transactionId: string
): Promise<OfferBlock[]> {
  const blocks = await claimBlocks(offerId, quantity, orderId, transactionId);
  
  if (blocks.length < quantity) {
    // Release any blocks we did claim
    if (blocks.length > 0) {
      await releaseBlocksByOrderId(orderId);
    }
    throw new InsufficientBlocksError(quantity, blocks.length);
  }
  
  return blocks;
}

/**
 * Mark blocks as SOLD (when order is confirmed)
 * 
 * CONCURRENCY SAFE: The caller should hold the order lock.
 * This function uses database-level atomicity via updateMany.
 * Returns the number of blocks that were marked as SOLD.
 */
export async function markBlocksAsSold(orderId: string): Promise<number> {
  const result = await prisma.offerBlock.updateMany({
    where: {
      orderId,
      status: 'RESERVED', // Only mark RESERVED blocks as SOLD
    },
    data: {
      status: 'SOLD',
      soldAt: new Date(),
    },
  });
  return result.count;
}

/**
 * Mark blocks as SOLD with distributed lock
 * Use this when calling from outside a locked context
 */
export async function markBlocksAsSoldWithLock(orderId: string): Promise<number> {
  return withOrderLock(orderId, async () => {
    return markBlocksAsSold(orderId);
  });
}

/**
 * Check offers that have no available blocks
 * NOTE: We no longer delete sold-out offers - they're kept for trade limit tracking
 * Returns the IDs of sold-out offers (for logging purposes)
 */
export async function cleanupEmptyOffers(offerIds: string[]): Promise<string[]> {
  const soldOutOfferIds: string[] = [];
  
  for (const offerId of offerIds) {
    const stats = await getBlockStats(offerId);
    
    // Just log sold-out offers, don't delete them
    if (stats.available === 0) {
      soldOutOfferIds.push(offerId);
      console.log(`[CATALOG] Offer ${offerId} is sold out (${stats.sold} blocks sold, keeping for trade limit tracking)`);
    }
  }
  
  return soldOutOfferIds;
}

/**
 * Release reserved blocks by transaction ID (if order fails or is cancelled)
 * 
 * CONCURRENCY SAFE: Uses transaction to ensure atomicity
 */
export async function releaseBlocks(transactionId: string): Promise<number> {
  const result = await prisma.offerBlock.updateMany({
    where: {
      transactionId,
      status: 'RESERVED',
    },
    data: {
      status: 'AVAILABLE',
      orderId: null,
      transactionId: null,
      reservedAt: null,
    },
  });
  return result.count;
}

/**
 * Release reserved blocks by order ID
 * Used when order creation fails after blocks were claimed
 * 
 * CONCURRENCY SAFE: Uses database-level atomicity
 */
export async function releaseBlocksByOrderId(orderId: string): Promise<number> {
  const result = await prisma.offerBlock.updateMany({
    where: {
      orderId,
      status: 'RESERVED',
    },
    data: {
      status: 'AVAILABLE',
      orderId: null,
      transactionId: null,
      reservedAt: null,
    },
  });
  return result.count;
}

/**
 * Release reserved blocks by order ID with distributed lock
 * Use this when calling from outside a locked context
 */
export async function releaseBlocksByOrderIdWithLock(orderId: string): Promise<number> {
  return withOrderLock(orderId, async () => {
    return releaseBlocksByOrderId(orderId);
  });
}

/**
 * Get block statistics for an offer
 */
export async function getBlockStats(offerId: string): Promise<BlockStats> {
  const [available, reserved, soldBlocks] = await Promise.all([
    prisma.offerBlock.count({ where: { offerId, status: 'AVAILABLE' } }),
    prisma.offerBlock.count({ where: { offerId, status: 'RESERVED' } }),
    // Get sold blocks with their order status to determine if delivered
    prisma.offerBlock.findMany({ 
      where: { offerId, status: 'SOLD' },
      include: {
        order: {
          select: { status: true, discomVerified: true },
        },
      },
    }),
  ]);
  
  const sold = soldBlocks.length;
  
  // Count sold blocks that are delivered (order completed + verified)
  const delivered = soldBlocks.filter(block => 
    block.order?.status === 'COMPLETED' && block.order?.discomVerified
  ).length;
  
  // Active commitment = available + reserved + sold (not yet delivered)
  const activeCommitment = available + reserved + (sold - delivered);
  
  return {
    total: available + reserved + sold,
    available,
    reserved,
    sold,
    delivered,
    activeCommitment, // This is what counts against trade limit
  };
}

/**
 * Get available block count for an offer (for catalog/discovery)
 */
export async function getAvailableBlockCount(offerId: string): Promise<number> {
  return prisma.offerBlock.count({
    where: {
      offerId,
      status: 'AVAILABLE',
    },
  });
}

/**
 * Get blocks for an order
 */
export async function getBlocksForOrder(orderId: string): Promise<OfferBlock[]> {
  const blocks = await prisma.offerBlock.findMany({
    where: { orderId },
  });
  
  return blocks.map(block => ({
    id: block.id,
    offer_id: block.offerId,
    item_id: block.itemId,
    provider_id: block.providerId,
    status: block.status as 'AVAILABLE' | 'RESERVED' | 'SOLD',
    order_id: block.orderId || undefined,
    transaction_id: block.transactionId || undefined,
    price_value: block.priceValue,
    currency: block.currency,
    created_at: block.createdAt.toISOString(),
    reserved_at: block.reservedAt?.toISOString(),
    sold_at: block.soldAt?.toISOString(),
  }));
}

/**
 * Update blocks order_id (used when order ID changes during init)
 */
export async function updateBlocksOrderId(
  oldOrderId: string,
  newOrderId: string,
  transactionId: string
): Promise<void> {
  await prisma.offerBlock.updateMany({
    where: {
      orderId: oldOrderId,
      transactionId,
    },
    data: {
      orderId: newOrderId,
    },
  });
}
