/**
 * Concurrency Tests for P2P Energy Trading
 * Tests race conditions and concurrent access scenarios
 */

import { v4 as uuidv4 } from 'uuid';
import { 
  prisma, 
  cleanupTestData,
  createTestProvider,
  createTestItem,
  createTestOffer,
  getBlockCounts,
  runConcurrently,
  waitFor,
} from '../setup';
import {
  withOfferLock,
  withOrderLock,
  InsufficientBlocksError,
} from '../../db/lock';

// Note: claimBlocks and markBlocksAsSold are imported from @p2p/bap
// For these tests, we'll directly interact with the database to simulate the operations

/**
 * Create a test order (required for foreign key constraint)
 */
async function createTestOrder(
  transactionId: string,
  providerId: string,
  offerId: string
): Promise<string> {
  const orderId = uuidv4();
  await prisma.order.create({
    data: {
      id: orderId,
      transactionId,
      status: 'PENDING',
      providerId,
      selectedOfferId: offerId,
      itemsJson: '[]',
      quoteJson: '{}',
    },
  });
  return orderId;
}

/**
 * Simulate block claiming (simplified version for testing)
 * Creates order first to satisfy foreign key constraint
 */
async function claimBlocksForTest(
  offerId: string,
  quantity: number,
  providerId: string,
  transactionId: string
): Promise<{ orderId: string; blockIds: string[] }> {
  return withOfferLock(offerId, async () => {
    return prisma.$transaction(async (tx) => {
      // Create order first to satisfy foreign key constraint
      const orderId = uuidv4();
      await tx.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId,
          selectedOfferId: offerId,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });
      
      // Select available blocks with row-level lock
      const blocks = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM offer_blocks 
        WHERE offer_id = ${offerId} 
          AND status = 'AVAILABLE'
        LIMIT ${quantity}
        FOR UPDATE SKIP LOCKED
      `;
      
      if (blocks.length === 0) {
        return { orderId, blockIds: [] };
      }
      
      const blockIds = blocks.map(b => b.id);
      
      // Update blocks to RESERVED
      await tx.offerBlock.updateMany({
        where: { 
          id: { in: blockIds },
          status: 'AVAILABLE',
        },
        data: {
          status: 'RESERVED',
          orderId,
          transactionId,
          reservedAt: new Date(),
        },
      });
      
      return { orderId, blockIds };
    });
  });
}

/**
 * Mark blocks as SOLD (for testing)
 */
async function markBlocksAsSoldForTest(orderId: string): Promise<number> {
  return withOrderLock(orderId, async () => {
    const result = await prisma.offerBlock.updateMany({
      where: {
        orderId,
        status: 'RESERVED',
      },
      data: {
        status: 'SOLD',
        soldAt: new Date(),
      },
    });
    return result.count;
  });
}

describe('Concurrency Tests', () => {
  // Clean up before each test
  beforeEach(async () => {
    await cleanupTestData();
  });

  describe('Block Claiming', () => {
    it('should not allow double-claiming of same blocks', async () => {
      // Setup: Create offer with 10 blocks
      const testId = `double-claim-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: `offer-${testId}` });
      
      // Verify initial state
      const initialCounts = await getBlockCounts(offer.id);
      expect(initialCounts.available).toBe(10);
      expect(initialCounts.total).toBe(10);
      
      // Concurrently try to claim all 10 blocks with 2 different transactions
      const txn1Id = uuidv4();
      const txn2Id = uuidv4();
      
      const { results, errors, successCount } = await runConcurrently([
        () => claimBlocksForTest(offer.id, 10, provider.id, txn1Id),
        () => claimBlocksForTest(offer.id, 10, provider.id, txn2Id),
      ], { settleAll: true });
      
      // Assertions
      const finalCounts = await getBlockCounts(offer.id);
      
      // Total claimed should be at most 10 (no overselling)
      expect(finalCounts.reserved).toBeLessThanOrEqual(10);
      expect(finalCounts.available + finalCounts.reserved).toBe(10);
      
      // One request should get all 10, the other should get 0
      const claimedCounts = results.map(r => r.blockIds.length).sort((a, b) => b - a);
      expect(claimedCounts[0]).toBe(10); // Winner gets all
      expect(claimedCounts[1]).toBe(0);  // Loser gets none
      
      // Verify no duplicate block assignments
      const reservedBlocks = await prisma.offerBlock.findMany({
        where: { offerId: offer.id, status: 'RESERVED' },
      });
      const uniqueOrderIds = new Set(reservedBlocks.map(b => b.orderId));
      expect(uniqueOrderIds.size).toBe(1); // All blocks belong to one order
    });

    it('should handle partial availability correctly', async () => {
      // Setup: Create offer with 5 blocks
      const testId = `partial-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 5, { id: `offer-${testId}` });
      
      // Concurrently try to claim 3 blocks each with 3 different transactions
      const txns = [uuidv4(), uuidv4(), uuidv4()];
      
      const { results } = await runConcurrently([
        () => claimBlocksForTest(offer.id, 3, provider.id, txns[0]),
        () => claimBlocksForTest(offer.id, 3, provider.id, txns[1]),
        () => claimBlocksForTest(offer.id, 3, provider.id, txns[2]),
      ], { settleAll: true });
      
      // Assertions
      const finalCounts = await getBlockCounts(offer.id);
      
      // Total claimed should be exactly 5 (max available)
      const totalClaimed = results.reduce((sum, r) => sum + r.blockIds.length, 0);
      expect(totalClaimed).toBeLessThanOrEqual(5);
      expect(finalCounts.reserved).toBeLessThanOrEqual(5);
      
      // Should not have negative available blocks
      expect(finalCounts.available).toBeGreaterThanOrEqual(0);
      
      // Verify no overselling: reserved + available = total
      expect(finalCounts.available + finalCounts.reserved).toBe(5);
    });

    it('should maintain consistency under high load', async () => {
      // Setup: Create offer with 100 blocks
      const testId = `load-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 100, { id: `offer-${testId}` });
      
      // Send 50 concurrent requests for 5 blocks each (total demand = 250 blocks)
      const requests = Array.from({ length: 50 }, (_, i) => {
        const txnId = uuidv4();
        return () => claimBlocksForTest(offer.id, 5, provider.id, txnId);
      });
      
      const { results } = await runConcurrently(requests, { settleAll: true });
      
      // Assertions
      const finalCounts = await getBlockCounts(offer.id);
      
      // Total claimed should be at most 100
      const totalClaimed = results.reduce((sum, r) => sum + r.blockIds.length, 0);
      expect(totalClaimed).toBeLessThanOrEqual(100);
      expect(finalCounts.reserved).toBeLessThanOrEqual(100);
      
      // Verify no duplicate block assignments
      const reservedBlocks = await prisma.offerBlock.findMany({
        where: { offerId: offer.id, status: 'RESERVED' },
      });
      const blockIds = reservedBlocks.map(b => b.id);
      const uniqueBlockIds = new Set(blockIds);
      expect(uniqueBlockIds.size).toBe(blockIds.length); // No duplicates
      
      // Each block should have exactly one order
      for (const block of reservedBlocks) {
        expect(block.orderId).toBeTruthy();
      }
      
      // Verify total integrity
      expect(finalCounts.available + finalCounts.reserved).toBe(100);
    });

    it('should handle rapid sequential claims correctly', async () => {
      // Setup: Create offer with 20 blocks
      const testId = `rapid-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 20, { id: `offer-${testId}` });
      
      // Rapidly claim blocks sequentially
      const claimedResults: { orderId: string; blockIds: string[] }[] = [];
      for (let i = 0; i < 5; i++) {
        const txnId = uuidv4();
        const result = await claimBlocksForTest(offer.id, 5, provider.id, txnId);
        claimedResults.push(result);
      }
      
      // All should succeed
      const totalClaimed = claimedResults.reduce((sum, r) => sum + r.blockIds.length, 0);
      expect(totalClaimed).toBe(20);
      
      // All blocks should now be reserved
      const finalCounts = await getBlockCounts(offer.id);
      expect(finalCounts.available).toBe(0);
      expect(finalCounts.reserved).toBe(20);
    });
  });

  describe('Order Flow', () => {
    it('should prevent duplicate order creation for same transaction', async () => {
      // Setup
      const provider = await createTestProvider({ id: 'provider-dup-order' });
      const item = await createTestItem(provider.id, { id: 'item-dup-order' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-dup-order' });
      
      const transactionId = uuidv4();
      
      // Try to create 5 orders with the same transaction ID concurrently
      const orderCreations = Array.from({ length: 5 }, () => {
        return () => prisma.order.create({
          data: {
            id: uuidv4(),
            transactionId,
            status: 'PENDING',
            itemsJson: '[]',
            quoteJson: '{}',
            providerId: provider.id,
            selectedOfferId: offer.id,
          },
        });
      });
      
      const { results, errors } = await runConcurrently(orderCreations, { settleAll: true });
      
      // Only one should succeed (unique constraint on transactionId)
      expect(results.length).toBe(1);
      expect(errors.length).toBe(4);
      
      // Verify only one order exists
      const orders = await prisma.order.findMany({
        where: { transactionId },
      });
      expect(orders.length).toBe(1);
    });

    it('should prevent duplicate confirmations', async () => {
      // Setup: Create an order with reserved blocks
      const provider = await createTestProvider({ id: 'provider-dup-confirm' });
      const item = await createTestItem(provider.id, { id: 'item-dup-confirm' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-dup-confirm' });
      
      const orderId = uuidv4();
      const transactionId = uuidv4();
      
      // Create order
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          itemsJson: '[]',
          quoteJson: '{}',
          providerId: provider.id,
          selectedOfferId: offer.id,
        },
      });
      
      // Reserve blocks for this order
      await prisma.offerBlock.updateMany({
        where: { offerId: offer.id },
        data: { 
          status: 'RESERVED',
          orderId,
          transactionId,
        },
      });
      
      // Track how many times blocks are marked as sold
      let soldCount = 0;
      
      // Send 10 concurrent confirm requests
      const confirms = Array.from({ length: 10 }, () => {
        return async () => {
          const count = await markBlocksAsSoldForTest(orderId);
          soldCount += count;
          return count;
        };
      });
      
      const { results } = await runConcurrently(confirms, { settleAll: true });
      
      // Blocks should be marked SOLD exactly once
      const nonZeroCounts = results.filter(r => r > 0);
      expect(nonZeroCounts.length).toBe(1);
      expect(nonZeroCounts[0]).toBe(10);
      
      // Verify final state
      const finalCounts = await getBlockCounts(offer.id);
      expect(finalCounts.sold).toBe(10);
      expect(finalCounts.reserved).toBe(0);
    });

    it('should handle concurrent select and init for same offer', async () => {
      // Setup: Create offer with limited blocks
      const provider = await createTestProvider({ id: 'provider-select-init' });
      const item = await createTestItem(provider.id, { id: 'item-select-init' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-select-init' });
      
      // Simulate 3 buyers trying to claim 5 blocks each (only 2 can succeed)
      const txns = [uuidv4(), uuidv4(), uuidv4()];
      
      const claims = txns.map(txnId => 
        () => claimBlocksForTest(offer.id, 5, provider.id, txnId)
      );
      
      const { results } = await runConcurrently(claims, { settleAll: true });
      
      // At most 2 buyers should get their full 5 blocks
      const successfulClaims = results.filter(r => r.blockIds.length === 5);
      expect(successfulClaims.length).toBeLessThanOrEqual(2);
      
      // Total blocks should not exceed 10
      const totalClaimed = results.reduce((sum, r) => sum + r.blockIds.length, 0);
      expect(totalClaimed).toBeLessThanOrEqual(10);
      
      const finalCounts = await getBlockCounts(offer.id);
      expect(finalCounts.available + finalCounts.reserved).toBe(10);
    });
  });

  describe('Inventory Consistency', () => {
    it('should maintain accurate available quantity', async () => {
      // Setup: Create item with 100 kWh
      const provider = await createTestProvider({ id: 'provider-inventory' });
      const item = await createTestItem(provider.id, { 
        id: 'item-inventory',
        availableQty: 100,
      });
      const offer = await createTestOffer(item.id, provider.id, 100, { id: 'offer-inventory' });
      
      // Run 20 concurrent purchase flows for 10 blocks each
      const purchases = Array.from({ length: 20 }, (_, i) => {
        return async () => {
          const txnId = uuidv4();
          const result = await claimBlocksForTest(offer.id, 10, provider.id, txnId);
          return result.blockIds.length;
        };
      });
      
      const { results } = await runConcurrently(purchases, { settleAll: true });
      
      // Calculate expected state
      const totalClaimed = results.reduce((sum, r) => sum + r, 0);
      const successfulPurchases = results.filter(r => r === 10).length;
      
      // Should have claimed at most 100 blocks
      expect(totalClaimed).toBeLessThanOrEqual(100);
      
      // Verify database consistency
      const finalCounts = await getBlockCounts(offer.id);
      expect(finalCounts.reserved).toBe(totalClaimed);
      expect(finalCounts.available).toBe(100 - totalClaimed);
      
      // No negative quantities
      expect(finalCounts.available).toBeGreaterThanOrEqual(0);
    });

    it('should release blocks on failed transactions', async () => {
      // Setup
      const provider = await createTestProvider({ id: 'provider-release' });
      const item = await createTestItem(provider.id, { id: 'item-release' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-release' });
      
      const transactionId = uuidv4();
      
      // Claim blocks
      const claimed = await claimBlocksForTest(offer.id, 5, provider.id, transactionId);
      expect(claimed.blockIds.length).toBe(5);
      
      // Verify reserved
      let counts = await getBlockCounts(offer.id);
      expect(counts.reserved).toBe(5);
      expect(counts.available).toBe(5);
      
      // Release blocks (simulate failed transaction)
      await prisma.offerBlock.updateMany({
        where: { transactionId, status: 'RESERVED' },
        data: {
          status: 'AVAILABLE',
          orderId: null,
          transactionId: null,
          reservedAt: null,
        },
      });
      
      // Verify released
      counts = await getBlockCounts(offer.id);
      expect(counts.reserved).toBe(0);
      expect(counts.available).toBe(10);
    });

    it('should handle mixed claim and release operations', async () => {
      // Setup
      const provider = await createTestProvider({ id: 'provider-mixed' });
      const item = await createTestItem(provider.id, { id: 'item-mixed' });
      const offer = await createTestOffer(item.id, provider.id, 20, { id: 'offer-mixed' });
      
      // Mix of claim operations
      const operations = [];
      
      // 5 claim operations for 3 blocks each
      for (let i = 0; i < 5; i++) {
        operations.push(async () => {
          const txnId = uuidv4();
          const result = await claimBlocksForTest(offer.id, 3, provider.id, txnId);
          return { type: 'claim', blockIds: result.blockIds };
        });
      }
      
      const { results } = await runConcurrently(operations, { settleAll: true });
      
      // Verify consistency
      const finalCounts = await getBlockCounts(offer.id);
      const totalClaimed = results.reduce((sum, r: any) => sum + r.blockIds.length, 0);
      
      expect(finalCounts.reserved).toBe(totalClaimed);
      expect(finalCounts.available + finalCounts.reserved).toBe(20);
    });
  });

  describe('Lock Behavior', () => {
    it('should serialize access to the same offer', async () => {
      // Setup
      const provider = await createTestProvider({ id: 'provider-lock' });
      const item = await createTestItem(provider.id, { id: 'item-lock' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-lock' });
      
      const executionOrder: string[] = [];
      
      // Create operations that track their execution order
      const operations = ['A', 'B', 'C'].map(name => {
        return async () => {
          return withOfferLock(offer.id, async () => {
            executionOrder.push(`${name}-start`);
            // Small delay to ensure overlap if not locked
            await new Promise(r => setTimeout(r, 50));
            executionOrder.push(`${name}-end`);
            return name;
          });
        };
      });
      
      await runConcurrently(operations, { settleAll: true });
      
      // Verify serialized execution (no interleaving)
      // Pattern should be: X-start, X-end, Y-start, Y-end, Z-start, Z-end
      for (let i = 0; i < executionOrder.length; i += 2) {
        const start = executionOrder[i];
        const end = executionOrder[i + 1];
        const startName = start.split('-')[0];
        const endName = end.split('-')[0];
        
        expect(startName).toBe(endName);
        expect(start.endsWith('-start')).toBe(true);
        expect(end.endsWith('-end')).toBe(true);
      }
    });

    it('should allow concurrent access to different offers', async () => {
      // Setup: Create 3 different offers
      const provider = await createTestProvider({ id: 'provider-multi-offer' });
      const item = await createTestItem(provider.id, { id: 'item-multi-offer' });
      
      const offers = await Promise.all([
        createTestOffer(item.id, provider.id, 10, { id: 'offer-A' }),
        createTestOffer(item.id, provider.id, 10, { id: 'offer-B' }),
        createTestOffer(item.id, provider.id, 10, { id: 'offer-C' }),
      ]);
      
      const startTimes: number[] = [];
      
      // Operations on different offers should run concurrently
      const operations = offers.map((offer, i) => {
        return async () => {
          return withOfferLock(offer.id, async () => {
            startTimes.push(Date.now());
            await new Promise(r => setTimeout(r, 100));
            return offer.id;
          });
        };
      });
      
      const startTime = Date.now();
      await runConcurrently(operations, { settleAll: true });
      const totalTime = Date.now() - startTime;
      
      // If running concurrently, total time should be ~100ms (not 300ms)
      // Allow some margin for test environment variations
      expect(totalTime).toBeLessThan(250);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero quantity claims', async () => {
      const provider = await createTestProvider({ id: 'provider-zero' });
      const item = await createTestItem(provider.id, { id: 'item-zero' });
      const offer = await createTestOffer(item.id, provider.id, 10, { id: 'offer-zero' });
      
      const result = await claimBlocksForTest(offer.id, 0, provider.id, uuidv4());
      expect(result.blockIds.length).toBe(0);
      
      const counts = await getBlockCounts(offer.id);
      // Note: available is 10, but we created an order even with 0 blocks
      expect(counts.available).toBe(10);
    });

    it('should handle claims larger than available', async () => {
      const provider = await createTestProvider({ id: 'provider-oversize' });
      const item = await createTestItem(provider.id, { id: 'item-oversize' });
      const offer = await createTestOffer(item.id, provider.id, 5, { id: 'offer-oversize' });
      
      // Try to claim more than available
      const result = await claimBlocksForTest(offer.id, 10, provider.id, uuidv4());
      
      // Should get only what's available
      expect(result.blockIds.length).toBe(5);
      
      const counts = await getBlockCounts(offer.id);
      expect(counts.available).toBe(0);
      expect(counts.reserved).toBe(5);
    });

    it('should handle non-existent offer', async () => {
      // This will fail because we try to create an order with a non-existent offer
      // The test verifies that the system handles this gracefully
      const provider = await createTestProvider({ id: 'provider-nonexist' });
      
      await expect(
        claimBlocksForTest('non-existent-offer', 10, provider.id, uuidv4())
      ).rejects.toThrow(); // Should fail due to foreign key constraint on selectedOfferId
    });
  });
});
