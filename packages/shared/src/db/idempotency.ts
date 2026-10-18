/**
 * Idempotency Key Support
 * Stores idempotency keys in Redis with cached responses
 * Ensures duplicate requests return the same response
 */

import { redis } from './redis';

// Idempotency key configuration
export const IDEMPOTENCY_CONFIG = {
  // TTL for idempotency keys in seconds (24 hours)
  keyTTL: 24 * 60 * 60,
  
  // Key prefix
  keyPrefix: 'idem',
};

// Key patterns
export const IDEMPOTENCY_KEYS = {
  // idem:{endpoint}:{idempotency_key}
  key: (endpoint: string, idempotencyKey: string) => 
    `${IDEMPOTENCY_CONFIG.keyPrefix}:${endpoint}:${idempotencyKey}`,
  
  // For locking during processing
  lock: (endpoint: string, idempotencyKey: string) =>
    `${IDEMPOTENCY_CONFIG.keyPrefix}:lock:${endpoint}:${idempotencyKey}`,
};

/**
 * Stored idempotency response
 */
export interface IdempotencyResponse {
  statusCode: number;
  body: any;
  headers?: Record<string, string>;
  createdAt: string;
}

/**
 * Result of checking idempotency
 */
export interface IdempotencyCheckResult {
  found: boolean;
  response?: IdempotencyResponse;
  isProcessing?: boolean;
}

/**
 * Check if an idempotency key exists and get cached response
 */
export async function checkIdempotencyKey(
  endpoint: string,
  idempotencyKey: string
): Promise<IdempotencyCheckResult> {
  const key = IDEMPOTENCY_KEYS.key(endpoint, idempotencyKey);
  const lockKey = IDEMPOTENCY_KEYS.lock(endpoint, idempotencyKey);
  
  // Check if response exists
  const cached = await redis.get(key);
  if (cached) {
    try {
      const response = JSON.parse(cached) as IdempotencyResponse;
      return { found: true, response };
    } catch {
      // Invalid cached data, delete it
      await redis.del(key);
    }
  }
  
  // Check if another request is processing this key
  const isProcessing = await redis.exists(lockKey);
  if (isProcessing) {
    return { found: false, isProcessing: true };
  }
  
  return { found: false, isProcessing: false };
}

/**
 * Start processing an idempotent request
 * Returns true if we should process, false if another request is already processing
 */
export async function startIdempotentRequest(
  endpoint: string,
  idempotencyKey: string,
  lockTTL: number = 30 // Lock TTL in seconds
): Promise<boolean> {
  const lockKey = IDEMPOTENCY_KEYS.lock(endpoint, idempotencyKey);
  
  // Try to acquire the lock using SET NX (only set if not exists)
  const acquired = await redis.set(lockKey, '1', 'EX', lockTTL, 'NX');
  return acquired === 'OK';
}

/**
 * Store the response for an idempotent request
 */
export async function storeIdempotencyResponse(
  endpoint: string,
  idempotencyKey: string,
  statusCode: number,
  body: any,
  headers?: Record<string, string>
): Promise<void> {
  const key = IDEMPOTENCY_KEYS.key(endpoint, idempotencyKey);
  const lockKey = IDEMPOTENCY_KEYS.lock(endpoint, idempotencyKey);
  
  const response: IdempotencyResponse = {
    statusCode,
    body,
    headers,
    createdAt: new Date().toISOString(),
  };
  
  // Store the response and release the lock atomically
  await redis.multi()
    .set(key, JSON.stringify(response), 'EX', IDEMPOTENCY_CONFIG.keyTTL)
    .del(lockKey)
    .exec();
}

/**
 * Release the processing lock without storing a response
 * Use this when the request fails and shouldn't be cached
 */
export async function releaseIdempotencyLock(
  endpoint: string,
  idempotencyKey: string
): Promise<void> {
  const lockKey = IDEMPOTENCY_KEYS.lock(endpoint, idempotencyKey);
  await redis.del(lockKey);
}

/**
 * Delete an idempotency key (for testing or manual cleanup)
 */
export async function deleteIdempotencyKey(
  endpoint: string,
  idempotencyKey: string
): Promise<void> {
  const key = IDEMPOTENCY_KEYS.key(endpoint, idempotencyKey);
  const lockKey = IDEMPOTENCY_KEYS.lock(endpoint, idempotencyKey);
  await redis.del(key, lockKey);
}

/**
 * Express middleware for idempotency key handling
 * 
 * Usage:
 * router.post('/endpoint', idempotencyMiddleware('endpoint'), handler)
 * 
 * Client sends: X-Idempotency-Key header
 */
export function createIdempotencyMiddleware(endpoint: string) {
  return async (req: any, res: any, next: any) => {
    const idempotencyKey = req.headers['x-idempotency-key'];
    
    // If no idempotency key provided, proceed normally
    if (!idempotencyKey) {
      return next();
    }
    
    // Check if we have a cached response
    const check = await checkIdempotencyKey(endpoint, idempotencyKey);
    
    if (check.found && check.response) {
      // Return cached response
      if (check.response.headers) {
        for (const [key, value] of Object.entries(check.response.headers)) {
          res.setHeader(key, value);
        }
      }
      res.setHeader('X-Idempotency-Replay', 'true');
      return res.status(check.response.statusCode).json(check.response.body);
    }
    
    if (check.isProcessing) {
      // Another request is processing this key
      return res.status(409).json({
        error: 'Request is already being processed',
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
    
    // Try to start processing
    const canProcess = await startIdempotentRequest(endpoint, idempotencyKey);
    if (!canProcess) {
      // Race condition - another request just started
      return res.status(409).json({
        error: 'Request is already being processed',
        code: 'IDEMPOTENCY_CONFLICT',
      });
    }
    
    // Store original json method
    const originalJson = res.json.bind(res);
    
    // Override json to capture and cache the response
    res.json = async (body: any) => {
      await storeIdempotencyResponse(
        endpoint,
        idempotencyKey,
        res.statusCode,
        body
      );
      return originalJson(body);
    };
    
    // Continue to the handler
    next();
  };
}

/**
 * Helper to wrap an async handler with idempotency support
 * Ensures lock is released on errors
 */
export function withIdempotency<T>(
  endpoint: string,
  idempotencyKey: string,
  fn: () => Promise<T>
): Promise<T> {
  return fn().catch(async (error) => {
    // Release the lock on error
    await releaseIdempotencyLock(endpoint, idempotencyKey);
    throw error;
  });
}
