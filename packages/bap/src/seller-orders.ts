/**
 * Order management for Seller (BPP) functionality
 * Using Prisma ORM for PostgreSQL persistence
 * With optimistic locking for concurrent update safety
 */

import { v4 as uuidv4 } from 'uuid';
import { prisma } from './db';
import { Order, OrderStatus, OrderItem, Quote, withOrderLock } from '@p2p/shared';

/**
 * Extended Order type with cancellation and payment fields
 */
export type ExtendedOrder = Order & {
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  cancelPenalty?: number;
  cancelRefund?: number;
  paymentStatus?: string;
  providerId?: string | null;
  bulkGroupId?: string | null;
};

/**
 * Error thrown when optimistic locking fails
 */
export class OptimisticLockError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} was modified by another process`);
    this.name = 'OptimisticLockError';
  }
}

/**
 * Convert Prisma order to Order type (with extra fields for UI)
 */
function toOrder(dbOrder: any): ExtendedOrder {
  const items = JSON.parse(dbOrder.itemsJson || '[]');
  const quote = JSON.parse(dbOrder.quoteJson || '{}');

  return {
    id: dbOrder.id,
    transaction_id: dbOrder.transactionId,
    status: dbOrder.status as OrderStatus,
    items: items,
    quote: quote.price ? quote : {
      price: { value: dbOrder.totalPrice || 0, currency: dbOrder.currency || 'INR' },
      totalQuantity: dbOrder.totalQty || 0,
    },
    created_at: dbOrder.createdAt.toISOString(),
    updated_at: dbOrder.updatedAt.toISOString(),
    // Cancellation and payment fields
    cancelledAt: dbOrder.cancelledAt?.toISOString(),
    cancelledBy: dbOrder.cancelledBy,
    cancelReason: dbOrder.cancelReason,
    cancelPenalty: dbOrder.cancelPenalty,
    cancelRefund: dbOrder.cancelRefund,
    paymentStatus: dbOrder.paymentStatus,
    providerId: dbOrder.providerId,
    bulkGroupId: dbOrder.bulkGroupId,
  };
}

/**
 * Get order by transaction ID
 */
export async function getOrderByTransactionId(transactionId: string): Promise<Order | null> {
  const order = await prisma.order.findUnique({
    where: { transactionId },
  });
  
  if (!order) {
    return null;
  }
  
  return toOrder(order);
}

/**
 * Get order by ID
 */
export async function getOrderById(orderId: string): Promise<Order | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });
  
  if (!order) {
    return null;
  }
  
  return toOrder(order);
}

/**
 * Create a new order (draft/pending state)
 * Handles external providers by setting providerId to null if provider doesn't exist locally
 */
export async function createOrder(
  transactionId: string,
  providerId: string,
  offerId: string,
  items: OrderItem[],
  quote: Quote,
  status: OrderStatus = 'PENDING',
  buyerId?: string | null,
  bulkGroupId?: string | null
): Promise<Order> {
  const orderId = uuidv4();

  // Check if provider exists locally - if not, set to null (external provider)
  let validProviderId: string | null = providerId;
  if (providerId) {
    const providerExists = await prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true },
    });

    if (!providerExists) {
      // External provider - set providerId to null to avoid FK constraint
      // Store the external provider ID in the items JSON for reference
      console.log(`[ORDER] External provider ${providerId} - setting providerId to null`);
      validProviderId = null;
    }
  }

  // Also check if selected offer exists locally
  let validOfferId: string | null = offerId;
  if (offerId) {
    const offerExists = await prisma.catalogOffer.findUnique({
      where: { id: offerId },
      select: { id: true },
    });

    if (!offerExists) {
      // External offer - set to null to avoid FK constraint
      console.log(`[ORDER] External offer ${offerId} - setting selectedOfferId to null`);
      validOfferId = null;
    }
  }

  const order = await prisma.order.create({
    data: {
      id: orderId,
      transactionId,
      status,
      providerId: validProviderId,
      selectedOfferId: validOfferId,
      buyerId: buyerId || undefined,
      bulkGroupId: bulkGroupId || undefined,
      totalQty: quote.totalQuantity,
      totalPrice: quote.price.value,
      currency: quote.price.currency,
      itemsJson: JSON.stringify(items),
      quoteJson: JSON.stringify(quote),
    },
  });

  return {
    id: order.id,
    transaction_id: order.transactionId,
    status: order.status as OrderStatus,
    items,
    quote,
    created_at: order.createdAt.toISOString(),
    updated_at: order.updatedAt.toISOString(),
    bulkGroupId: order.bulkGroupId || undefined,
  };
}

/**
 * Update order status
 */
export async function updateOrderStatus(orderId: string, status: OrderStatus): Promise<Order | null> {
  await prisma.order.update({
    where: { id: orderId },
    data: { 
      status,
      version: { increment: 1 }, // Increment version for tracking
    },
  });
  
  return getOrderById(orderId);
}

/**
 * Update order status with optimistic locking
 * Only updates if the version matches, preventing concurrent modification
 */
export async function updateOrderStatusWithVersion(
  orderId: string, 
  status: OrderStatus,
  expectedVersion: number
): Promise<Order | null> {
  const result = await prisma.order.updateMany({
    where: { 
      id: orderId,
      version: expectedVersion,
    },
    data: { 
      status,
      version: { increment: 1 },
    },
  });
  
  if (result.count === 0) {
    throw new OptimisticLockError(orderId);
  }
  
  return getOrderById(orderId);
}

/**
 * Update order by transaction ID
 */
export async function updateOrderStatusByTransactionId(transactionId: string, status: OrderStatus): Promise<Order | null> {
  await prisma.order.update({
    where: { transactionId },
    data: { 
      status,
      version: { increment: 1 },
    },
  });
  
  return getOrderByTransactionId(transactionId);
}

/**
 * Safe order status update with distributed lock
 * Use this when you need to ensure exclusive access to an order
 */
export async function updateOrderStatusSafely(
  orderId: string, 
  status: OrderStatus
): Promise<Order | null> {
  return withOrderLock(orderId, async () => {
    return updateOrderStatus(orderId, status);
  });
}

/**
 * Get all orders for a provider
 */
export async function getOrdersByProviderId(providerId: string): Promise<ExtendedOrder[]> {
  const orders = await prisma.order.findMany({
    where: { providerId },
    orderBy: { createdAt: 'desc' },
  });
  
  return orders.map(toOrder);
}

/**
 * Get all orders for a seller (by providerId OR sellerId OR blocks)
 * This handles:
 * - Local orders (providerId set on order)
 * - External orders (providerId null but sellerId in payment record)
 * - Bulk orders (multiple providers - check if any block belongs to this provider)
 */
export async function getOrdersForSeller(providerId: string | null, userId: string): Promise<ExtendedOrder[]> {
  // Query orders where user is the seller through providerId OR sellerId OR blocks
  const orders = await prisma.order.findMany({
    where: {
      OR: [
        // Local orders: providerId matches on order
        ...(providerId ? [{ providerId }] : []),
        // Check if there's a payment record where this user is the seller
        {
          payments: {
            some: { sellerId: userId }
          }
        },
        // Bulk orders: check if any block in this order belongs to this provider
        ...(providerId ? [{
          blocks: {
            some: { providerId }
          }
        }] : []),
      ]
    },
    orderBy: { createdAt: 'desc' },
  });

  return orders.map(toOrder);
}

/**
 * Get all orders
 */
export async function getAllOrders(): Promise<Order[]> {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: 'desc' },
  });
  
  return orders.map(toOrder);
}
