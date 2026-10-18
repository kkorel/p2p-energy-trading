/**
 * Redis Client Module
 * Provides connection management, transaction state caching, and message deduplication
 */

import Redis from 'ioredis';

// Declare global type for development hot-reload
declare global {
  // eslint-disable-next-line no-var
  var redis: Redis | undefined;
}

// Redis key patterns
export const REDIS_KEYS = {
  transaction: (id: string) => `txn:${id}`,
  allTransactions: 'txn:all',
  processedMessage: (messageId: string, direction: string) => `msg:${direction}:${messageId}`,
};

// TTL values in seconds
export const REDIS_TTL = {
  transaction: 24 * 60 * 60, // 24 hours
  processedMessage: 7 * 24 * 60 * 60, // 7 days
};

// Create Redis client singleton
const createRedisClient = () => {
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 10) {
        return null; // Stop retrying
      }
      return Math.min(times * 100, 3000);
    },
    lazyConnect: true,
  });

  client.on('error', (err) => {
    console.error('Redis connection error:', err);
  });

  client.on('connect', () => {
    console.log('Redis connected');
  });

  return client;
};

// Use global variable in development to prevent multiple instances during hot-reload
export const redis = globalThis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.redis = redis;
}

/**
 * Check if Redis is connected
 */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    console.error('Redis connection check failed:', error);
    return false;
  }
}

/**
 * Connect Redis client explicitly
 */
export async function connectRedis(): Promise<void> {
  if (redis.status !== 'ready') {
    await redis.connect();
  }
}

/**
 * Disconnect Redis client (for graceful shutdown)
 */
export async function disconnectRedis(): Promise<void> {
  await redis.quit();
}

// ==================== Transaction State Operations ====================

export interface TransactionState {
  transaction_id: string;
  catalog?: any;
  selectedOffer?: any;
  selectedQuantity?: number;
  providers?: Record<string, any>;
  order?: any;
  discoveryCriteria?: any;
  matchingResults?: any;
  excludeProviderId?: string | null;
  buyerId?: string | null;
  error?: string;
  trustWarning?: {
    score: number;
    percentage: string;
    message: string;
  };
  // Bulk buy mode
  bulkMode?: boolean;
  selectedOffers?: Array<{
    offer: any;
    provider: any;
    quantity: number;
    score: number;
    subtotal: number;
  }>;
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
  status: 'DISCOVERING' | 'SELECTING' | 'INITIALIZING' | 'CONFIRMING' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  created_at: string;
  updated_at: string;
}

/**
 * Create a new transaction state in Redis
 */
export async function createTransactionState(transactionId: string): Promise<TransactionState> {
  const now = new Date().toISOString();
  const state: TransactionState = {
    transaction_id: transactionId,
    status: 'DISCOVERING',
    created_at: now,
    updated_at: now,
  };

  const key = REDIS_KEYS.transaction(transactionId);
  await redis.set(key, JSON.stringify(state), 'EX', REDIS_TTL.transaction);
  await redis.sadd(REDIS_KEYS.allTransactions, transactionId);

  return state;
}

/**
 * Get transaction state from Redis
 */
export async function getTransactionState(transactionId: string): Promise<TransactionState | null> {
  const key = REDIS_KEYS.transaction(transactionId);
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as TransactionState;
}

/**
 * Update transaction state in Redis
 */
export async function updateTransactionState(
  transactionId: string,
  updates: Partial<Omit<TransactionState, 'transaction_id' | 'created_at'>>
): Promise<TransactionState | null> {
  const key = REDIS_KEYS.transaction(transactionId);
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  const state = JSON.parse(data) as TransactionState;
  const updatedState: TransactionState = {
    ...state,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  await redis.set(key, JSON.stringify(updatedState), 'EX', REDIS_TTL.transaction);

  return updatedState;
}

/**
 * Get all transaction states from Redis
 */
export async function getAllTransactionStates(): Promise<TransactionState[]> {
  const transactionIds = await redis.smembers(REDIS_KEYS.allTransactions);

  if (transactionIds.length === 0) {
    return [];
  }

  const keys = transactionIds.map(id => REDIS_KEYS.transaction(id));
  const values = await redis.mget(keys);

  const states: TransactionState[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value) {
      states.push(JSON.parse(value) as TransactionState);
    } else {
      // Clean up stale reference
      await redis.srem(REDIS_KEYS.allTransactions, transactionIds[i]);
    }
  }

  return states;
}

/**
 * Clear all transaction states from Redis
 */
export async function clearAllTransactionStates(): Promise<void> {
  const transactionIds = await redis.smembers(REDIS_KEYS.allTransactions);

  if (transactionIds.length > 0) {
    const keys = transactionIds.map(id => REDIS_KEYS.transaction(id));
    await redis.del(...keys);
  }

  await redis.del(REDIS_KEYS.allTransactions);
}

// ==================== Message Deduplication Operations ====================

/**
 * Check if a message has already been processed (for deduplication)
 */
export async function isMessageProcessed(messageId: string, direction: string = 'INBOUND'): Promise<boolean> {
  const key = REDIS_KEYS.processedMessage(messageId, direction);
  const exists = await redis.exists(key);
  return exists === 1;
}

/**
 * Mark a message as processed
 */
export async function markMessageProcessed(messageId: string, direction: string = 'INBOUND'): Promise<void> {
  const key = REDIS_KEYS.processedMessage(messageId, direction);
  await redis.set(key, '1', 'EX', REDIS_TTL.processedMessage);
}

export type { Redis };
