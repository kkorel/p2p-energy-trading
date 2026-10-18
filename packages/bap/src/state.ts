/**
 * Transaction state management using Redis
 * Provides persistence and automatic expiration of transaction states
 */

import { Catalog, CatalogOffer, Provider, Order, TimeWindow, SourceType, DeliveryMode } from '@p2p/shared';
import {
  createTransactionState,
  getTransactionState,
  updateTransactionState,
  getAllTransactionStates,
  clearAllTransactionStates,
  TransactionState as RedisTransactionState,
} from '@p2p/shared';

interface DiscoveryCriteria {
  sourceType?: SourceType;
  deliveryMode?: DeliveryMode;
  minQuantity?: number;
  maxPrice?: number;
  timeWindow?: TimeWindow;
}

interface MatchingResult {
  selectedOffer: {
    offer: CatalogOffer;
    score: number;
    matchesFilters?: boolean;
    filterReasons?: string[];
    breakdown: {
      priceScore: number;
      trustScore: number;
      timeWindowFitScore: number;
    };
  } | null;
  allOffers: Array<{
    offer: CatalogOffer;
    score: number;
    matchesFilters?: boolean;
    filterReasons?: string[];
    breakdown: {
      priceScore: number;
      trustScore: number;
      timeWindowFitScore: number;
    };
  }>;
  eligibleCount?: number;
  reason?: string;
}

// Bulk mode selected offer with quantity
export interface BulkSelectedOffer {
  offer: CatalogOffer;
  provider: Provider;
  quantity: number;
  score: number;
  subtotal: number;
}

export interface TransactionState {
  transaction_id: string;
  catalog?: Catalog;
  selectedOffer?: CatalogOffer;
  selectedQuantity?: number;
  providers?: Map<string, Provider>;
  order?: Order;
  discoveryCriteria?: DiscoveryCriteria;

  // Bulk buy mode
  bulkMode?: boolean;
  selectedOffers?: BulkSelectedOffer[];
  bulkSelection?: {
    totalQuantity: number;
    totalPrice: number;
    fullyFulfilled: boolean;
    shortfall: number;
    targetQuantity: number;
  };
  // Bulk orders (separate orders from bulk purchase)
  bulkOrders?: Array<{
    id: string;
    transactionId: string;
    status: string;
  }>;
  bulkGroupId?: string;
  matchingResults?: MatchingResult | null;
  excludeProviderId?: string | null; // User's own provider to exclude from results
  buyerId?: string | null; // User ID of the buyer for order association
  error?: string; // Error message if the transaction failed
  trustWarning?: {
    score: number;
    percentage: string;
    message: string;
  }; // Advisory warning for low trust score buyers
  
  // Fulfillment tracking (from on_update callbacks)
  fulfillmentUpdates?: Array<{
    itemId: string;
    deliveryStatus: string;
    deliveredQty: number;
    curtailedQty: number;
    curtailmentReason?: string;
    meterReadings: any[];
    lastUpdated: string;
  }>;
  lastFulfillmentUpdate?: string;
  deliveryStatus?: string; // Overall delivery status from DISCOM updates
  totalDelivered?: number; // Aggregate kWh delivered
  totalCurtailed?: number; // Aggregate kWh curtailed

  // Payment tracking (from on_update with settlement)
  // Status lifecycle: PENDING → INITIATED → AUTHORIZED → ADJUSTED → SETTLED
  paymentStatus?: string;
  paymentAmount?: number;
  paymentCurrency?: string;
  paymentUrl?: string; // Tracking URL from seller platform
  billComponents?: Array<{
    type: string; // UNIT, FEE
    value: number;
    currency?: string;
    description?: string;
  }>;

  status: 'DISCOVERING' | 'SELECTING' | 'INITIALIZING' | 'CONFIRMING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  created_at: string;
  updated_at: string;
}

/**
 * Convert Redis state to local TransactionState
 * Handles Map reconstruction for providers
 */
function fromRedisState(redisState: RedisTransactionState): TransactionState {
  const state: TransactionState = {
    ...redisState,
    providers: redisState.providers
      ? new Map(Object.entries(redisState.providers))
      : undefined,
  };
  return state;
}

/**
 * Convert local TransactionState to Redis-compatible format
 * Handles Map serialization for providers
 */
function toRedisState(state: Partial<TransactionState>): Partial<RedisTransactionState> {
  const redisState: any = { ...state };
  if (state.providers instanceof Map) {
    redisState.providers = Object.fromEntries(state.providers);
  }
  return redisState;
}

/**
 * Create a new transaction state
 */
export async function createTransaction(transaction_id: string): Promise<TransactionState> {
  const redisState = await createTransactionState(transaction_id);
  return fromRedisState(redisState);
}

/**
 * Get transaction state by ID
 */
export async function getTransaction(transaction_id: string): Promise<TransactionState | undefined> {
  const redisState = await getTransactionState(transaction_id);
  if (!redisState) return undefined;
  return fromRedisState(redisState);
}

/**
 * Update transaction state
 */
export async function updateTransaction(
  transaction_id: string,
  updates: Partial<Omit<TransactionState, 'transaction_id' | 'created_at'>>
): Promise<TransactionState | undefined> {
  const redisUpdates = toRedisState(updates);
  const redisState = await updateTransactionState(transaction_id, redisUpdates as any);
  if (!redisState) return undefined;
  return fromRedisState(redisState);
}

/**
 * Get all transaction states
 */
export async function getAllTransactions(): Promise<TransactionState[]> {
  const redisStates = await getAllTransactionStates();
  return redisStates.map(fromRedisState);
}

/**
 * Clear all transaction states
 */
export async function clearAllTransactions(): Promise<void> {
  await clearAllTransactionStates();
}
