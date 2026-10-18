/**
 * Jest Test Setup
 * Runs before each test file
 */

import { prisma, connectPrisma, disconnectPrisma } from '../db/prisma';
import { redis, connectRedis, disconnectRedis } from '../db/redis';

// Increase default timeout for async operations
jest.setTimeout(30000);

// Suppress expected Prisma error logs during tests
// These are expected constraint violations that we're testing for
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeAll(async () => {
  // Filter out expected errors and noisy logs during tests
  console.log = (...args: any[]) => {
    const message = args[0]?.toString() || '';
    // Suppress Prisma constraint violation errors (they're expected in tests)
    // Also suppress Redis connection message during tests
    if (message.includes('prisma:error') || 
        message.includes('Unique constraint failed') ||
        message.includes('Foreign key constraint violated') ||
        message.includes('Redis connected')) {
      return;
    }
    originalConsoleLog.apply(console, args);
  };
  
  console.error = (...args: any[]) => {
    const message = args[0]?.toString() || '';
    // Suppress Prisma constraint violation errors (they're expected in tests)
    if (message.includes('prisma:error') || 
        message.includes('Unique constraint failed') ||
        message.includes('Foreign key constraint violated')) {
      return;
    }
    originalConsoleError.apply(console, args);
  };

  try {
    await connectPrisma();
    await connectRedis();
  } catch (error) {
    originalConsoleError('Failed to connect to databases:', error);
    throw error;
  }
});

// Disconnect after all tests and restore console
afterAll(async () => {
  // Restore original console methods
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  
  try {
    await disconnectPrisma();
    await disconnectRedis();
  } catch (error) {
    console.error('Failed to disconnect from databases:', error);
  }
});

// Export test utilities
export { prisma, redis };

/**
 * Clean up test data
 * Call this in beforeEach if you need a clean state for each test
 */
export async function cleanupTestData(): Promise<void> {
  // Delete in order to respect foreign key constraints
  await prisma.event.deleteMany({});
  await prisma.offerBlock.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.catalogOffer.deleteMany({});
  await prisma.catalogItem.deleteMany({});
  await prisma.provider.deleteMany({});
  
  // Clear Redis keys
  const keys = await redis.keys('test:*');
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  
  // Clear lock keys
  const lockKeys = await redis.keys('lock:*');
  if (lockKeys.length > 0) {
    await redis.del(...lockKeys);
  }
  
  // Clear transaction keys
  const txnKeys = await redis.keys('txn:*');
  if (txnKeys.length > 0) {
    await redis.del(...txnKeys);
  }
}

/**
 * Create test provider
 */
export async function createTestProvider(overrides: Partial<{
  id: string;
  name: string;
  trustScore: number;
}> = {}): Promise<{ id: string; name: string; trustScore: number }> {
  const provider = await prisma.provider.create({
    data: {
      id: overrides.id || `test-provider-${Date.now()}`,
      name: overrides.name || 'Test Provider',
      trustScore: overrides.trustScore ?? 0.8,
      totalOrders: 0,
      successfulOrders: 0,
    },
  });
  
  return {
    id: provider.id,
    name: provider.name,
    trustScore: provider.trustScore,
  };
}

/**
 * Create test catalog item
 */
export async function createTestItem(
  providerId: string,
  overrides: Partial<{
    id: string;
    sourceType: string;
    availableQty: number;
  }> = {}
): Promise<{ id: string; providerId: string; availableQty: number }> {
  const item = await prisma.catalogItem.create({
    data: {
      id: overrides.id || `test-item-${Date.now()}`,
      providerId,
      sourceType: overrides.sourceType || 'SOLAR',
      deliveryMode: 'SCHEDULED',
      availableQty: overrides.availableQty ?? 100,
      meterId: `MTR-TEST-${Date.now()}`,
      productionWindowsJson: JSON.stringify([{
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }]),
    },
  });
  
  return {
    id: item.id,
    providerId: item.providerId,
    availableQty: item.availableQty,
  };
}

/**
 * Create test offer with blocks
 */
export async function createTestOffer(
  itemId: string,
  providerId: string,
  maxQty: number,
  overrides: Partial<{
    id: string;
    priceValue: number;
  }> = {}
): Promise<{ id: string; itemId: string; providerId: string; maxQty: number }> {
  const offerId = overrides.id || `test-offer-${Date.now()}`;
  const priceValue = overrides.priceValue ?? 6.00;
  
  const offer = await prisma.catalogOffer.create({
    data: {
      id: offerId,
      itemId,
      providerId,
      priceValue,
      currency: 'INR',
      maxQty,
      timeWindowStart: new Date(),
      timeWindowEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
      pricingModel: 'PER_KWH',
      settlementType: 'DAILY',
    },
  });
  
  // Create blocks
  const blockData = Array.from({ length: maxQty }, (_, i) => ({
    id: `block-${offerId}-${i}`,
    offerId,
    itemId,
    providerId,
    status: 'AVAILABLE',
    priceValue,
    currency: 'INR',
  }));
  
  await prisma.offerBlock.createMany({ data: blockData });
  
  return {
    id: offer.id,
    itemId: offer.itemId,
    providerId: offer.providerId,
    maxQty: offer.maxQty,
  };
}

/**
 * Get block counts for an offer
 */
export async function getBlockCounts(offerId: string): Promise<{
  available: number;
  reserved: number;
  sold: number;
  total: number;
}> {
  const [available, reserved, sold] = await Promise.all([
    prisma.offerBlock.count({ where: { offerId, status: 'AVAILABLE' } }),
    prisma.offerBlock.count({ where: { offerId, status: 'RESERVED' } }),
    prisma.offerBlock.count({ where: { offerId, status: 'SOLD' } }),
  ]);
  
  return {
    available,
    reserved,
    sold,
    total: available + reserved + sold,
  };
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  return false;
}

/**
 * Execute multiple async functions concurrently and collect results
 */
export async function runConcurrently<T>(
  fns: (() => Promise<T>)[],
  options: { settleAll?: boolean } = {}
): Promise<{ 
  results: T[]; 
  errors: Error[];
  successCount: number;
  errorCount: number;
}> {
  const results: T[] = [];
  const errors: Error[] = [];
  
  if (options.settleAll) {
    const settled = await Promise.allSettled(fns.map(fn => fn()));
    
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        errors.push(result.reason);
      }
    }
  } else {
    await Promise.all(fns.map(async (fn) => {
      try {
        results.push(await fn());
      } catch (error) {
        errors.push(error as Error);
      }
    }));
  }
  
  return {
    results,
    errors,
    successCount: results.length,
    errorCount: errors.length,
  };
}
