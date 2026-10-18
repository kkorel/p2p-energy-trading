/**
 * Balance Concurrency Tests
 * Tests race conditions and concurrent access for user balance operations
 */

import { v4 as uuidv4 } from 'uuid';
import {
  prisma,
  cleanupTestData,
  runConcurrently,
} from '../setup';
import { redis } from '../../db/redis';

const PLATFORM_FEE_RATE = 0.025;

interface PaymentResult {
  success: boolean;
  error?: string;
}

/**
 * Create a test user with specified balance
 */
async function createTestUser(balance: number = 10000): Promise<{
  id: string;
  phone: string;
  balance: number;
}> {
  const id = uuidv4();
  const phone = `+9199${Date.now().toString().slice(-8)}${Math.random().toString(36).substring(7)}`;

  const user = await prisma.user.create({
    data: { id, phone, balance },
  });

  return { id: user.id, phone: user.phone, balance: user.balance };
}

/**
 * Process payment with proper locking using Redis
 */
async function processPaymentWithLock(
  buyerId: string,
  sellerId: string,
  amount: number,
  platformFee: number
): Promise<PaymentResult> {
  const lockKey = `payment:${buyerId}`;
  const lockValue = uuidv4();
  const lockTTL = 5000; // 5 seconds
  
  // Acquire lock
  const acquired = await redis.set(lockKey, lockValue, 'PX', lockTTL, 'NX');
  if (!acquired) {
    return { success: false, error: 'LOCK_FAILED' };
  }
  
  try {
    // Check balance
    const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
    if (!buyer || buyer.balance < amount + platformFee) {
      return { success: false, error: 'INSUFFICIENT_BALANCE' };
    }
    
    // Process payment atomically
    await prisma.$transaction([
      prisma.user.update({
        where: { id: buyerId },
        data: { balance: { decrement: amount + platformFee } },
      }),
      prisma.user.update({
        where: { id: sellerId },
        data: { balance: { increment: amount } },
      }),
    ]);
    
    return { success: true };
  } finally {
    // Release lock (only if we still own it)
    const currentValue = await redis.get(lockKey);
    if (currentValue === lockValue) {
      await redis.del(lockKey);
    }
  }
}

/**
 * Process payment WITHOUT locking (for demonstrating race conditions)
 */
async function processPaymentUnsafe(
  buyerId: string,
  sellerId: string,
  amount: number,
  platformFee: number
): Promise<PaymentResult> {
  // Check balance (race window here!)
  const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
  if (!buyer || buyer.balance < amount + platformFee) {
    return { success: false, error: 'INSUFFICIENT_BALANCE' };
  }
  
  // Small delay to increase chance of race condition
  await new Promise(r => setTimeout(r, 10));
  
  // Process payment
  await prisma.$transaction([
    prisma.user.update({
      where: { id: buyerId },
      data: { balance: { decrement: amount + platformFee } },
    }),
    prisma.user.update({
      where: { id: sellerId },
      data: { balance: { increment: amount } },
    }),
  ]);
  
  return { success: true };
}

describe('Balance Concurrency Tests', () => {
  beforeEach(async () => {
    await cleanupTestData();
    // Clean up test users
    await prisma.user.deleteMany({
      where: { phone: { contains: '+9199' } },
    });
    // Clean up payment locks
    const lockKeys = await redis.keys('payment:*');
    if (lockKeys.length > 0) {
      await redis.del(...lockKeys);
    }
  });

  describe('Basic Balance Operations', () => {
    it('should correctly update balance atomically', async () => {
      const user = await createTestUser(1000);
      
      // Perform 10 sequential decrements of 50
      for (let i = 0; i < 10; i++) {
        await prisma.user.update({
          where: { id: user.id },
          data: { balance: { decrement: 50 } },
        });
      }
      
      const finalUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(finalUser?.balance).toBe(500);
    });

    it('should handle negative balance prevention in application layer', async () => {
      const user = await createTestUser(100);
      
      // Try to deduct more than available
      const currentBalance = (await prisma.user.findUnique({ 
        where: { id: user.id } 
      }))?.balance || 0;
      
      const amountToDeduct = 200;
      
      if (currentBalance >= amountToDeduct) {
        await prisma.user.update({
          where: { id: user.id },
          data: { balance: { decrement: amountToDeduct } },
        });
      }
      
      const finalUser = await prisma.user.findUnique({ where: { id: user.id } });
      expect(finalUser?.balance).toBe(100); // Should remain unchanged
    });
  });

  describe('Concurrent Balance Updates', () => {
    it('should handle concurrent decrements correctly with locking', async () => {
      const buyer = await createTestUser(1000);
      const seller = await createTestUser(0);
      
      // 10 concurrent payments of 100 each (total = 1000)
      const payments = Array.from({ length: 10 }, () => {
        return () => processPaymentWithLock(buyer.id, seller.id, 100, 2.5);
      });
      
      const { results } = await runConcurrently(payments, { settleAll: true });
      
      // Count successes and failures
      const typedResults = results as PaymentResult[];
      const successes = typedResults.filter(r => r.success).length;
      const lockFailures = typedResults.filter(r => r.error === 'LOCK_FAILED').length;
      
      // With proper locking, only sequential execution happens
      // Some might fail to acquire lock, which is expected
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      const finalSeller = await prisma.user.findUnique({ where: { id: seller.id } });
      
      // Verify consistency: buyer + seller + (platform fees from successful) = initial
      const buyerBalance = finalBuyer?.balance || 0;
      const sellerBalance = finalSeller?.balance || 0;
      const platformFees = successes * 2.5;
      
      expect(buyerBalance + sellerBalance + platformFees).toBe(1000);
      
      // Buyer should not go negative
      expect(buyerBalance).toBeGreaterThanOrEqual(0);
    });

    it('should prevent double-spending with distributed lock', async () => {
      const buyer = await createTestUser(100); // Only enough for 1 payment
      const seller = await createTestUser(0);
      
      // Try 5 concurrent payments of 100 each
      const payments = Array.from({ length: 5 }, () => {
        return () => processPaymentWithLock(buyer.id, seller.id, 100, 2.5);
      });
      
      const { results } = await runConcurrently(payments, { settleAll: true });
      
      // Count outcomes
      const typedResults = results as PaymentResult[];
      const successes = typedResults.filter(r => r.success).length;
      const insufficientBalance = typedResults.filter(r => r.error === 'INSUFFICIENT_BALANCE').length;
      const lockFailed = typedResults.filter(r => r.error === 'LOCK_FAILED').length;
      
      // At most ONE should succeed (buyer only has enough for 1)
      expect(successes).toBeLessThanOrEqual(1);
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      
      // Buyer should never go negative
      expect(finalBuyer?.balance).toBeGreaterThanOrEqual(0);
      
      // If one succeeded, buyer should have ~0 balance
      if (successes === 1) {
        expect(finalBuyer?.balance).toBeLessThan(5); // 100 - 100 - 2.5 = -2.5, but limited to 0 or slightly less
      }
    });

    it('should demonstrate race condition without locking', async () => {
      // This test demonstrates what happens WITHOUT proper locking
      // In a real system, this should FAIL - we're testing that our locking prevents this
      
      const buyer = await createTestUser(200); // Enough for 2 payments max
      const seller = await createTestUser(0);
      
      // Try 5 concurrent UNSAFE payments
      const payments = Array.from({ length: 5 }, () => {
        return () => processPaymentUnsafe(buyer.id, seller.id, 100, 2.5);
      });
      
      const { results, errors } = await runConcurrently(payments, { settleAll: true });
      
      // Without locking, race conditions can occur
      // Multiple payments might "see" sufficient balance before any deduct
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      
      // Note: This test documents the problem rather than asserting correct behavior
      // In production, use the locked version to prevent this
      const typedResults = results as PaymentResult[];
      console.log(`Unsafe payments - Final buyer balance: ${finalBuyer?.balance}`);
      console.log(`Successful payments: ${typedResults.filter(r => r.success).length}`);
      
      // The balance might go negative without proper locking!
      // This is a documentation of the problem, not an assertion of correct behavior
    });
  });

  describe('High-Load Balance Scenarios', () => {
    it('should maintain consistency under high concurrent load', async () => {
      const buyer = await createTestUser(5000);
      const seller = await createTestUser(0);
      
      // 50 concurrent small payments
      const payments = Array.from({ length: 50 }, () => {
        return () => processPaymentWithLock(buyer.id, seller.id, 10, 0.25);
      });
      
      const startTime = Date.now();
      const { results } = await runConcurrently(payments, { settleAll: true });
      const duration = Date.now() - startTime;
      
      const typedResults = results as PaymentResult[];
      const successes = typedResults.filter(r => r.success).length;
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      const finalSeller = await prisma.user.findUnique({ where: { id: seller.id } });
      
      // Verify consistency
      const buyerBalance = finalBuyer?.balance || 0;
      const sellerBalance = finalSeller?.balance || 0;
      const platformFees = successes * 0.25;
      
      // Total should equal initial buyer balance
      expect(buyerBalance + sellerBalance + platformFees).toBeCloseTo(5000, 1);
      
      // Performance check (should complete in reasonable time)
      expect(duration).toBeLessThan(30000); // 30 seconds max
      
      console.log(`High-load test: ${successes}/${payments.length} succeeded in ${duration}ms`);
    });

    it('should handle mixed buyers and sellers correctly', async () => {
      // Create multiple users
      const users = await Promise.all([
        createTestUser(1000), // User 0
        createTestUser(1000), // User 1
        createTestUser(1000), // User 2
      ]);
      
      // Random payments between users
      const payments = [];
      for (let i = 0; i < 30; i++) {
        const buyerIdx = i % 3;
        const sellerIdx = (i + 1) % 3;
        payments.push(() => 
          processPaymentWithLock(users[buyerIdx].id, users[sellerIdx].id, 50, 1.25)
        );
      }
      
      const { results } = await runConcurrently(payments, { settleAll: true });
      
      const typedResults = results as PaymentResult[];
      const successes = typedResults.filter(r => r.success).length;
      
      // Get final balances
      const finalUsers = await Promise.all(
        users.map(u => prisma.user.findUnique({ where: { id: u.id } }))
      );
      
      // Total balance in system should equal initial minus platform fees
      const totalBalance = finalUsers.reduce((sum, u) => sum + (u?.balance || 0), 0);
      const platformFees = successes * 1.25;
      const initialTotal = 3000;
      
      expect(totalBalance + platformFees).toBeCloseTo(initialTotal, 1);
      
      // No user should have negative balance
      for (const user of finalUsers) {
        expect(user?.balance).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero amount payments', async () => {
      const buyer = await createTestUser(100);
      const seller = await createTestUser(0);
      
      const result = await processPaymentWithLock(buyer.id, seller.id, 0, 0);
      
      // Zero amount should succeed (no-op)
      expect(result.success).toBe(true);
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      expect(finalBuyer?.balance).toBe(100);
    });

    it('should handle payment to self', async () => {
      const user = await createTestUser(1000);
      
      // Payment to self (edge case)
      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: { balance: { decrement: 100 } },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { balance: { increment: 100 } },
        }),
      ]);
      
      const finalUser = await prisma.user.findUnique({ where: { id: user.id } });
      // Balance should be unchanged (minus 100, plus 100)
      expect(finalUser?.balance).toBe(1000);
    });

    it('should handle very small amounts correctly', async () => {
      const buyer = await createTestUser(1.00);
      const seller = await createTestUser(0);
      
      const amount = 0.01;
      const fee = 0.00025; // 2.5% of 0.01
      
      const result = await processPaymentWithLock(buyer.id, seller.id, amount, fee);
      expect(result.success).toBe(true);
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      const finalSeller = await prisma.user.findUnique({ where: { id: seller.id } });
      
      expect(finalBuyer?.balance).toBeCloseTo(1 - amount - fee, 5);
      expect(finalSeller?.balance).toBeCloseTo(amount, 5);
    });

    it('should handle rapid sequential payments from same user', async () => {
      const buyer = await createTestUser(1000);
      const sellers = await Promise.all(
        Array.from({ length: 10 }, () => createTestUser(0))
      );
      
      // 10 rapid sequential payments to different sellers
      for (const seller of sellers) {
        await processPaymentWithLock(buyer.id, seller.id, 50, 1.25);
      }
      
      const finalBuyer = await prisma.user.findUnique({ where: { id: buyer.id } });
      const finalSellers = await Promise.all(
        sellers.map(s => prisma.user.findUnique({ where: { id: s.id } }))
      );
      
      // Buyer: 1000 - 10 * (50 + 1.25) = 1000 - 512.5 = 487.5
      expect(finalBuyer?.balance).toBeCloseTo(487.5, 1);
      
      // Each seller should have 50
      for (const seller of finalSellers) {
        expect(seller?.balance).toBe(50);
      }
    });
  });

  describe('Lock Behavior', () => {
    it('should timeout and release lock after TTL', async () => {
      const buyerId = uuidv4();
      const lockKey = `payment:${buyerId}`;
      const lockValue = uuidv4();
      
      // Set lock with 1 second TTL
      await redis.set(lockKey, lockValue, 'PX', 1000, 'NX');
      
      // Verify lock is set
      let lockStatus = await redis.get(lockKey);
      expect(lockStatus).toBe(lockValue);
      
      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 1100));
      
      // Verify lock is released
      lockStatus = await redis.get(lockKey);
      expect(lockStatus).toBeNull();
    });

    it('should prevent acquiring lock if already held', async () => {
      const buyerId = uuidv4();
      const lockKey = `payment:${buyerId}`;
      
      // First acquisition
      const lock1 = await redis.set(lockKey, 'holder1', 'PX', 5000, 'NX');
      expect(lock1).toBe('OK');
      
      // Second acquisition should fail
      const lock2 = await redis.set(lockKey, 'holder2', 'PX', 5000, 'NX');
      expect(lock2).toBeNull();
      
      // Clean up
      await redis.del(lockKey);
    });

    it('should allow different users to process payments concurrently', async () => {
      // Create 3 independent buyer-seller pairs
      const pairs = await Promise.all(
        Array.from({ length: 3 }, async () => ({
          buyer: await createTestUser(1000),
          seller: await createTestUser(0),
        }))
      );
      
      // Concurrent payments - each pair is independent
      const payments = pairs.map(pair => 
        () => processPaymentWithLock(pair.buyer.id, pair.seller.id, 100, 2.5)
      );
      
      const startTime = Date.now();
      const { results } = await runConcurrently(payments, { settleAll: true });
      const duration = Date.now() - startTime;
      
      // All should succeed (different locks)
      const typedResults = results as PaymentResult[];
      const successes = typedResults.filter(r => r.success).length;
      expect(successes).toBe(3);
      
      // Should complete quickly (parallel execution)
      expect(duration).toBeLessThan(500);
    });
  });
});
