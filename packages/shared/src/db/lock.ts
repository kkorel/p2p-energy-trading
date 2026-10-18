/**
 * Distributed Locking Module using Redlock
 * Provides safe concurrent access to shared resources
 * 
 * Note: For single Redis instance, Redlock provides basic distributed locking.
 * For production with multiple Redis instances, configure additional clients.
 */

import Redlock, { Lock, ResourceLockedError, ExecutionError } from 'redlock';
import { redis } from './redis';

// Lock configuration
export const LOCK_CONFIG = {
  // Default lock TTL in milliseconds
  defaultTTL: 30000, // 30 seconds
  
  // Retry configuration - more lenient for single-instance Redis
  retryCount: 5,
  retryDelay: 100, // ms between retries
  retryJitter: 50, // random jitter added to retry delay
  
  // Auto-extend configuration
  autoExtendThreshold: 500, // Extend lock if less than this many ms remaining
};

// Lock key patterns
export const LOCK_KEYS = {
  offer: (id: string) => `lock:offer:${id}`,
  order: (id: string) => `lock:order:${id}`,
  transaction: (id: string) => `lock:txn:${id}`,
  block: (id: string) => `lock:block:${id}`,
};

// Create Redlock instance
let redlock: Redlock | null = null;

/**
 * Get or create the Redlock instance
 */
export function getRedlock(): Redlock {
  if (!redlock) {
    redlock = new Redlock(
      // Use the existing Redis client
      [redis],
      {
        // Retry configuration - reduced for single-instance
        retryCount: LOCK_CONFIG.retryCount,
        retryDelay: LOCK_CONFIG.retryDelay,
        retryJitter: LOCK_CONFIG.retryJitter,
        
        // Automatically extend locks
        automaticExtensionThreshold: LOCK_CONFIG.autoExtendThreshold,
        
        // For single-instance, we don't need strict quorum
        // driftFactor is used for clock drift compensation
      }
    );
    
    // Handle errors - don't log expected errors during normal operation
    redlock.on('error', (error) => {
      // Ignore resource locked errors - they're expected during contention
      if (error instanceof ResourceLockedError) {
        return;
      }
      // Log other errors but don't crash
      if (!(error instanceof ExecutionError)) {
        console.error('Redlock error:', error);
      }
    });
  }
  
  return redlock;
}

/**
 * Custom error for lock acquisition failures
 */
export class LockAcquisitionError extends Error {
  constructor(resource: string, cause?: Error) {
    super(`Failed to acquire lock for resource: ${resource}`);
    this.name = 'LockAcquisitionError';
    this.cause = cause;
  }
}

/**
 * Custom error for insufficient blocks
 */
export class InsufficientBlocksError extends Error {
  public requested: number;
  public available: number;
  
  constructor(requested: number, available: number) {
    super(`Insufficient blocks: requested ${requested}, available ${available}`);
    this.name = 'InsufficientBlocksError';
    this.requested = requested;
    this.available = available;
  }
}

/**
 * Acquire a lock for a resource
 */
export async function acquireLock(
  resource: string,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<Lock> {
  const lock = getRedlock();
  return lock.acquire([resource], ttl);
}

/**
 * Execute a function while holding a lock on a resource
 * Automatically handles lock acquisition and release
 */
export async function withLock<T>(
  resource: string,
  fn: () => Promise<T>,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<T> {
  const lock = getRedlock();
  
  return lock.using([resource], ttl, async (signal) => {
    // Check if lock was aborted before executing
    if (signal.aborted) {
      throw new LockAcquisitionError(resource);
    }
    
    return fn();
  });
}

/**
 * Execute a function while holding a lock on an offer
 * Use this when claiming or modifying offer blocks
 */
export async function withOfferLock<T>(
  offerId: string,
  fn: () => Promise<T>,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<T> {
  return withLock(LOCK_KEYS.offer(offerId), fn, ttl);
}

/**
 * Execute a function while holding a lock on an order
 * Use this when modifying order status
 */
export async function withOrderLock<T>(
  orderId: string,
  fn: () => Promise<T>,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<T> {
  return withLock(LOCK_KEYS.order(orderId), fn, ttl);
}

/**
 * Execute a function while holding a lock on a transaction
 * Use this for operations that span the entire transaction lifecycle
 */
export async function withTransactionLock<T>(
  transactionId: string,
  fn: () => Promise<T>,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<T> {
  return withLock(LOCK_KEYS.transaction(transactionId), fn, ttl);
}

/**
 * Try to acquire a lock, returning null if the resource is already locked
 * Useful for non-blocking lock attempts
 */
export async function tryAcquireLock(
  resource: string,
  ttl: number = LOCK_CONFIG.defaultTTL
): Promise<Lock | null> {
  try {
    const lock = getRedlock();
    // Use a single retry attempt for non-blocking
    const singleTryRedlock = new Redlock([redis], {
      retryCount: 0,
      retryDelay: 0,
    });
    return await singleTryRedlock.acquire([resource], ttl);
  } catch (error) {
    if (error instanceof ResourceLockedError) {
      return null;
    }
    throw error;
  }
}

/**
 * Check if a resource is currently locked (non-authoritative)
 * Note: This is a best-effort check and may have race conditions
 */
export async function isLocked(resource: string): Promise<boolean> {
  const lock = await tryAcquireLock(resource, 100);
  if (lock) {
    // We got the lock, release it and return false
    await lock.release();
    return false;
  }
  return true;
}

/**
 * Release all locks (for cleanup during shutdown)
 */
export async function releaseAllLocks(): Promise<void> {
  if (redlock) {
    // Redlock doesn't have a built-in release all, but we can
    // let existing locks expire naturally on shutdown
    redlock = null;
  }
}

// Export types
export type { Lock, ResourceLockedError };
