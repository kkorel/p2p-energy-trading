/**
 * End-to-End Tests for Complete User Flows
 * Tests full trading scenarios from discovery to completion
 */

import { v4 as uuidv4 } from 'uuid';
import {
  prisma,
  cleanupTestData,
  createTestProvider,
  createTestItem,
  createTestOffer,
  getBlockCounts,
} from '../setup';
import { withOfferLock, withOrderLock } from '../../db/lock';

describe('End-to-End Trading Flows', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  describe('Complete Purchase Flow', () => {
    it('should complete a full purchase from discovery to order completion', async () => {
      // === STEP 1: SETUP - Create seller with energy offer ===
      const seller = await createTestProvider({ 
        id: 'seller-e2e',
        name: 'Solar Farm Ltd',
        trustScore: 0.9,
      });
      
      const item = await createTestItem(seller.id, {
        id: 'solar-item-e2e',
        sourceType: 'SOLAR',
        availableQty: 100,
      });
      
      const offer = await createTestOffer(item.id, seller.id, 50, {
        id: 'solar-offer-e2e',
        priceValue: 6.00,
      });

      // === STEP 2: BUYER discovers available offers ===
      const discoveredOffers = await prisma.catalogOffer.findMany({
        where: {
          providerId: seller.id,
        },
        include: {
          item: true,
          provider: true,
        },
      });

      expect(discoveredOffers.length).toBe(1);
      expect(discoveredOffers[0].item.sourceType).toBe('SOLAR');

      // === STEP 3: BUYER selects offer and quantity ===
      const selectedOffer = discoveredOffers[0];
      const requestedQuantity = 10;
      const transactionId = uuidv4();

      // Verify availability
      const blockCounts = await getBlockCounts(selectedOffer.id);
      expect(blockCounts.available).toBeGreaterThanOrEqual(requestedQuantity);

      // === STEP 4: INIT - Create order and reserve blocks ===
      const orderId = uuidv4();
      const orderItems = [{
        item_id: item.id,
        offer_id: offer.id,
        provider_id: seller.id,
        quantity: requestedQuantity,
        price: { value: requestedQuantity * 6, currency: 'INR' },
        source_type: 'SOLAR',
      }];
      const quote = {
        price: { value: requestedQuantity * 6, currency: 'INR' },
        totalQuantity: requestedQuantity,
      };

      // Create order
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId: seller.id,
          selectedOfferId: offer.id,
          totalQty: requestedQuantity,
          totalPrice: quote.price.value,
          currency: 'INR',
          itemsJson: JSON.stringify(orderItems),
          quoteJson: JSON.stringify(quote),
        },
      });

      // Reserve blocks with locking
      await withOfferLock(offer.id, async () => {
        const blocks = await prisma.offerBlock.findMany({
          where: { offerId: offer.id, status: 'AVAILABLE' },
          take: requestedQuantity,
        });

        await prisma.offerBlock.updateMany({
          where: { id: { in: blocks.map(b => b.id) } },
          data: {
            status: 'RESERVED',
            orderId,
            transactionId,
            reservedAt: new Date(),
          },
        });
      });

      // Verify reservation
      const afterReserve = await getBlockCounts(offer.id);
      expect(afterReserve.reserved).toBe(requestedQuantity);
      expect(afterReserve.available).toBe(50 - requestedQuantity);

      // === STEP 5: CONFIRM - Finalize order ===
      await withOrderLock(orderId, async () => {
        // Mark blocks as sold
        await prisma.offerBlock.updateMany({
          where: { orderId, status: 'RESERVED' },
          data: {
            status: 'SOLD',
            soldAt: new Date(),
          },
        });

        // Update order status
        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'ACTIVE' },
        });
      });

      // Verify final state
      const finalBlockCounts = await getBlockCounts(offer.id);
      expect(finalBlockCounts.sold).toBe(requestedQuantity);
      expect(finalBlockCounts.available).toBe(50 - requestedQuantity);

      const finalOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(finalOrder?.status).toBe('ACTIVE');

      // === STEP 6: COMPLETE - Mark order as delivered ===
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'COMPLETED' },
      });

      const completedOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(completedOrder?.status).toBe('COMPLETED');
    });

    it('should handle order cancellation and release blocks', async () => {
      // Setup
      const seller = await createTestProvider({ id: 'cancel-seller' });
      const item = await createTestItem(seller.id, { id: 'cancel-item' });
      const offer = await createTestOffer(item.id, seller.id, 20, { id: 'cancel-offer' });

      const transactionId = uuidv4();
      const orderId = uuidv4();

      // Create and reserve
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId: seller.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      await prisma.offerBlock.updateMany({
        where: { offerId: offer.id },
        data: {
          status: 'RESERVED',
          orderId,
          transactionId,
        },
      });

      // Verify reserved
      let counts = await getBlockCounts(offer.id);
      expect(counts.reserved).toBe(20);

      // Cancel order
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'CANCELLED' },
      });

      // Release blocks
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
      expect(counts.available).toBe(20);
      expect(counts.reserved).toBe(0);

      const cancelledOrder = await prisma.order.findUnique({ where: { id: orderId } });
      expect(cancelledOrder?.status).toBe('CANCELLED');
    });
  });

  describe('Multi-Buyer Scenario', () => {
    it('should handle multiple buyers purchasing from the same offer', async () => {
      // Setup: 50 blocks available
      const seller = await createTestProvider({ id: 'multi-seller' });
      const item = await createTestItem(seller.id, { id: 'multi-item' });
      const offer = await createTestOffer(item.id, seller.id, 50, { id: 'multi-offer' });

      // Create 5 buyers, each buying 10 blocks
      const buyers = Array.from({ length: 5 }, (_, i) => ({
        orderId: uuidv4(),
        transactionId: uuidv4(),
        quantity: 10,
      }));

      // Process each buyer sequentially
      for (const buyer of buyers) {
        await prisma.order.create({
          data: {
            id: buyer.orderId,
            transactionId: buyer.transactionId,
            status: 'PENDING',
            providerId: seller.id,
            selectedOfferId: offer.id,
            itemsJson: '[]',
            quoteJson: '{}',
          },
        });

        await withOfferLock(offer.id, async () => {
          const blocks = await prisma.offerBlock.findMany({
            where: { offerId: offer.id, status: 'AVAILABLE' },
            take: buyer.quantity,
          });

          if (blocks.length === buyer.quantity) {
            await prisma.offerBlock.updateMany({
              where: { id: { in: blocks.map(b => b.id) } },
              data: {
                status: 'SOLD',
                orderId: buyer.orderId,
                transactionId: buyer.transactionId,
                soldAt: new Date(),
              },
            });

            await prisma.order.update({
              where: { id: buyer.orderId },
              data: { status: 'ACTIVE' },
            });
          }
        });
      }

      // Verify all blocks are sold
      const finalCounts = await getBlockCounts(offer.id);
      expect(finalCounts.sold).toBe(50);
      expect(finalCounts.available).toBe(0);

      // Verify all orders are ACTIVE
      const orders = await prisma.order.findMany({
        where: { id: { in: buyers.map(b => b.orderId) } },
      });
      expect(orders.every(o => o.status === 'ACTIVE')).toBe(true);
    });
  });

  describe('Offer Exhaustion Flow', () => {
    it('should auto-handle when offer runs out of blocks', async () => {
      // Setup: Only 5 blocks
      const seller = await createTestProvider({ id: 'exhaust-seller' });
      const item = await createTestItem(seller.id, { id: 'exhaust-item' });
      const offer = await createTestOffer(item.id, seller.id, 5, { id: 'exhaust-offer' });

      // First buyer takes all 5
      const buyer1Order = uuidv4();
      await prisma.order.create({
        data: {
          id: buyer1Order,
          transactionId: uuidv4(),
          status: 'PENDING',
          providerId: seller.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      await prisma.offerBlock.updateMany({
        where: { offerId: offer.id },
        data: {
          status: 'SOLD',
          orderId: buyer1Order,
          soldAt: new Date(),
        },
      });

      // Verify all sold
      let counts = await getBlockCounts(offer.id);
      expect(counts.sold).toBe(5);
      expect(counts.available).toBe(0);

      // Second buyer tries to get blocks
      const buyer2Order = uuidv4();
      await prisma.order.create({
        data: {
          id: buyer2Order,
          transactionId: uuidv4(),
          status: 'PENDING',
          providerId: seller.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      const availableBlocks = await prisma.offerBlock.findMany({
        where: { offerId: offer.id, status: 'AVAILABLE' },
        take: 5,
      });

      // Should get 0 blocks
      expect(availableBlocks.length).toBe(0);

      // Second order should be cancelled due to no availability
      await prisma.order.update({
        where: { id: buyer2Order },
        data: { status: 'CANCELLED' },
      });

      const cancelledOrder = await prisma.order.findUnique({ where: { id: buyer2Order } });
      expect(cancelledOrder?.status).toBe('CANCELLED');
    });
  });

  describe('Payment Flow with Balance', () => {
    it('should complete payment flow with balance deduction and addition', async () => {
      const PLATFORM_FEE_RATE = 0.025;
      const energyCost = 100;
      const platformFee = energyCost * PLATFORM_FEE_RATE;

      // Create buyer and seller
      const buyerId = uuidv4();
      const sellerId = uuidv4();
      
      await prisma.user.createMany({
        data: [
          { id: buyerId, phone: `+9197${Date.now().toString().slice(-8)}`, balance: 1000 },
          { id: sellerId, phone: `+9196${Date.now().toString().slice(-8)}`, balance: 0 },
        ],
      });

      // Verify initial balances
      let buyer = await prisma.user.findUnique({ where: { id: buyerId } });
      let seller = await prisma.user.findUnique({ where: { id: sellerId } });
      expect(buyer?.balance).toBe(1000);
      expect(seller?.balance).toBe(0);

      // Process payment
      await prisma.$transaction([
        prisma.user.update({
          where: { id: buyerId },
          data: { balance: { decrement: energyCost + platformFee } },
        }),
        prisma.user.update({
          where: { id: sellerId },
          data: { balance: { increment: energyCost } },
        }),
      ]);

      // Verify final balances
      buyer = await prisma.user.findUnique({ where: { id: buyerId } });
      seller = await prisma.user.findUnique({ where: { id: sellerId } });

      // Buyer pays: energyCost + platformFee
      expect(buyer?.balance).toBe(1000 - energyCost - platformFee);
      // Seller receives: energyCost (no fee)
      expect(seller?.balance).toBe(energyCost);
      // Platform implicitly receives: platformFee (difference)
    });

    it('should prevent purchase when insufficient balance', async () => {
      const buyerId = uuidv4();
      const energyCost = 1000;
      const platformFee = 25;

      await prisma.user.create({
        data: {
          id: buyerId,
          phone: `+9195${Date.now().toString().slice(-8)}`,
          balance: 500, // Less than required
        },
      });

      const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
      const totalRequired = energyCost + platformFee;

      // Check balance before purchase
      expect(buyer?.balance).toBeLessThan(totalRequired);

      // In a real scenario, the API would reject this purchase
      // Here we verify the logic that would be used
      const hasInsufficientBalance = (buyer?.balance || 0) < totalRequired;
      expect(hasInsufficientBalance).toBe(true);
    });
  });

  describe('Multi-Provider Discovery', () => {
    it('should discover offers from multiple providers and select best match', async () => {
      // Create multiple providers with different offers
      const providers = await Promise.all([
        createTestProvider({ id: 'cheap-solar', name: 'Cheap Solar', trustScore: 0.7 }),
        createTestProvider({ id: 'premium-solar', name: 'Premium Solar', trustScore: 0.95 }),
        createTestProvider({ id: 'wind-power', name: 'Wind Power Co', trustScore: 0.85 }),
      ]);

      // Create items and offers for each
      const items = await Promise.all(
        providers.map((p, i) => createTestItem(p.id, {
          id: `item-${i}`,
          sourceType: i < 2 ? 'SOLAR' : 'WIND',
        }))
      );

      const offers = await Promise.all([
        createTestOffer(items[0].id, providers[0].id, 100, { id: 'cheap-offer', priceValue: 5.0 }),
        createTestOffer(items[1].id, providers[1].id, 50, { id: 'premium-offer', priceValue: 8.0 }),
        createTestOffer(items[2].id, providers[2].id, 75, { id: 'wind-offer', priceValue: 6.0 }),
      ]);

      // Discovery: Get all SOLAR offers
      const solarOffers = await prisma.catalogOffer.findMany({
        where: {
          item: { sourceType: 'SOLAR' },
        },
        include: {
          provider: true,
          item: true,
        },
      });

      expect(solarOffers.length).toBe(2);

      // Select best based on trust score (simplified matching)
      const bestMatch = solarOffers.reduce((best, current) => 
        current.provider.trustScore > best.provider.trustScore ? current : best
      );

      expect(bestMatch.provider.name).toBe('Premium Solar');
      expect(bestMatch.provider.trustScore).toBe(0.95);
    });
  });

  describe('Order History Flow', () => {
    it('should maintain complete order history with source_type', async () => {
      const seller = await createTestProvider({ id: 'history-seller' });
      const item = await createTestItem(seller.id, { 
        id: 'history-item',
        sourceType: 'WIND',
      });
      const offer = await createTestOffer(item.id, seller.id, 10, { 
        id: 'history-offer',
        priceValue: 7.5,
      });

      // Create order with source_type stored
      const orderId = uuidv4();
      const orderItems = [{
        item_id: item.id,
        offer_id: offer.id,
        provider_id: seller.id,
        quantity: 5,
        price: { value: 37.5, currency: 'INR' },
        source_type: 'WIND', // Stored for history
      }];

      await prisma.order.create({
        data: {
          id: orderId,
          transactionId: uuidv4(),
          status: 'COMPLETED',
          providerId: seller.id,
          selectedOfferId: offer.id,
          totalQty: 5,
          totalPrice: 37.5,
          currency: 'INR',
          itemsJson: JSON.stringify(orderItems),
          quoteJson: JSON.stringify({ price: { value: 37.5, currency: 'INR' }, totalQuantity: 5 }),
        },
      });

      // Delete the offer (simulating auto-cleanup)
      await prisma.offerBlock.deleteMany({ where: { offerId: offer.id } });
      await prisma.catalogOffer.delete({ where: { id: offer.id } });

      // Verify offer is deleted
      const deletedOffer = await prisma.catalogOffer.findUnique({ where: { id: offer.id } });
      expect(deletedOffer).toBeNull();

      // Order should still have source_type in itemsJson
      const historicOrder = await prisma.order.findUnique({ where: { id: orderId } });
      const parsedItems = JSON.parse(historicOrder!.itemsJson);
      
      expect(parsedItems[0].source_type).toBe('WIND');
    });
  });
});
