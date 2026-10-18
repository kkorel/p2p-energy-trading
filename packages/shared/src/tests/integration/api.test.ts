/**
 * Integration Tests for API Endpoints
 * Tests the BAP API endpoints with database interactions
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

describe('API Integration Tests', () => {
  beforeEach(async () => {
    await cleanupTestData();
  });

  describe('Provider Management', () => {
    it('should create a provider with all required fields', async () => {
      const providerId = `provider-${Date.now()}`;
      
      const provider = await prisma.provider.create({
        data: {
          id: providerId,
          name: 'Test Energy Co',
          trustScore: 0.85,
          totalOrders: 0,
          successfulOrders: 0,
        },
      });

      expect(provider.id).toBe(providerId);
      expect(provider.name).toBe('Test Energy Co');
      expect(provider.trustScore).toBe(0.85);
    });

    it('should update trust score after successful orders', async () => {
      const provider = await createTestProvider({ id: 'trust-update-provider' });

      // Simulate 10 successful orders
      await prisma.provider.update({
        where: { id: provider.id },
        data: {
          totalOrders: 10,
          successfulOrders: 9,
          trustScore: 0.9, // 9/10 success rate
        },
      });

      const updated = await prisma.provider.findUnique({
        where: { id: provider.id },
      });

      expect(updated?.successfulOrders).toBe(9);
      expect(updated?.trustScore).toBe(0.9);
    });
  });

  describe('Catalog Item Management', () => {
    it('should create an item with production windows', async () => {
      const provider = await createTestProvider({ id: 'item-provider' });
      
      const productionWindows = [
        { startTime: '2024-01-01T08:00:00Z', endTime: '2024-01-01T16:00:00Z' },
        { startTime: '2024-01-02T08:00:00Z', endTime: '2024-01-02T16:00:00Z' },
      ];

      const item = await prisma.catalogItem.create({
        data: {
          id: 'item-with-windows',
          providerId: provider.id,
          sourceType: 'SOLAR',
          deliveryMode: 'SCHEDULED',
          availableQty: 100,
          meterId: 'MTR-001',
          productionWindowsJson: JSON.stringify(productionWindows),
        },
      });

      const parsed = JSON.parse(item.productionWindowsJson);
      expect(parsed.length).toBe(2);
      expect(parsed[0].startTime).toBe('2024-01-01T08:00:00Z');
    });

    it('should update available quantity', async () => {
      const provider = await createTestProvider({ id: 'qty-provider' });
      const item = await createTestItem(provider.id, { 
        id: 'qty-item',
        availableQty: 100,
      });

      await prisma.catalogItem.update({
        where: { id: item.id },
        data: { availableQty: 80 },
      });

      const updated = await prisma.catalogItem.findUnique({
        where: { id: item.id },
      });

      expect(updated?.availableQty).toBe(80);
    });
  });

  describe('Offer Management', () => {
    it('should create an offer with blocks', async () => {
      const provider = await createTestProvider({ id: 'offer-provider' });
      const item = await createTestItem(provider.id, { id: 'offer-item' });
      
      const offer = await createTestOffer(item.id, provider.id, 10, {
        id: 'offer-with-blocks',
        priceValue: 6.5,
      });

      const counts = await getBlockCounts(offer.id);
      expect(counts.total).toBe(10);
      expect(counts.available).toBe(10);
    });

    it('should delete offer and its blocks', async () => {
      const provider = await createTestProvider({ id: 'delete-provider' });
      const item = await createTestItem(provider.id, { id: 'delete-item' });
      const offer = await createTestOffer(item.id, provider.id, 5, {
        id: 'deletable-offer',
      });

      // Verify blocks exist
      let counts = await getBlockCounts(offer.id);
      expect(counts.total).toBe(5);

      // Delete blocks first (FK constraint)
      await prisma.offerBlock.deleteMany({ where: { offerId: offer.id } });
      await prisma.catalogOffer.delete({ where: { id: offer.id } });

      // Verify deletion
      const deletedOffer = await prisma.catalogOffer.findUnique({
        where: { id: offer.id },
      });
      expect(deletedOffer).toBeNull();

      counts = await getBlockCounts(offer.id);
      expect(counts.total).toBe(0);
    });
  });

  describe('Order Management', () => {
    it('should create an order with items and quote', async () => {
      const provider = await createTestProvider({ id: 'order-provider' });
      const item = await createTestItem(provider.id, { id: 'order-item' });
      const offer = await createTestOffer(item.id, provider.id, 10, {
        id: 'order-offer',
      });

      const orderId = uuidv4();
      const transactionId = uuidv4();
      const items = [
        {
          item_id: item.id,
          offer_id: offer.id,
          provider_id: provider.id,
          quantity: 5,
          price: { value: 30, currency: 'INR' },
          source_type: 'SOLAR',
        },
      ];
      const quote = {
        price: { value: 30, currency: 'INR' },
        totalQuantity: 5,
      };

      const order = await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: JSON.stringify(items),
          quoteJson: JSON.stringify(quote),
          totalQty: 5,
          totalPrice: 30,
          currency: 'INR',
        },
      });

      expect(order.status).toBe('PENDING');
      
      const parsedItems = JSON.parse(order.itemsJson);
      expect(parsedItems[0].source_type).toBe('SOLAR');
    });

    it('should transition order status correctly', async () => {
      const testId = `status-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 5, {
        id: `offer-${testId}`,
      });

      const orderId = uuidv4();
      
      // Create DRAFT order
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId: uuidv4(),
          status: 'DRAFT',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      // Transition to PENDING
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'PENDING' },
      });

      // Transition to ACTIVE
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'ACTIVE' },
      });

      const finalOrder = await prisma.order.findUnique({
        where: { id: orderId },
      });

      expect(finalOrder?.status).toBe('ACTIVE');
    });

    it('should enforce unique transaction ID constraint', async () => {
      const testId = `unique-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const provider = await createTestProvider({ id: `provider-${testId}` });
      const item = await createTestItem(provider.id, { id: `item-${testId}` });
      const offer = await createTestOffer(item.id, provider.id, 5, {
        id: `offer-${testId}`,
      });

      const transactionId = uuidv4();

      // First order
      await prisma.order.create({
        data: {
          id: uuidv4(),
          transactionId,
          status: 'PENDING',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      // Second order with same transaction ID should fail
      await expect(
        prisma.order.create({
          data: {
            id: uuidv4(),
            transactionId,
            status: 'PENDING',
            providerId: provider.id,
            selectedOfferId: offer.id,
            itemsJson: '[]',
            quoteJson: '{}',
          },
        })
      ).rejects.toThrow();
    });
  });

  describe('Block Operations', () => {
    it('should reserve blocks for an order', async () => {
      const provider = await createTestProvider({ id: 'reserve-provider' });
      const item = await createTestItem(provider.id, { id: 'reserve-item' });
      const offer = await createTestOffer(item.id, provider.id, 10, {
        id: 'reserve-offer',
      });

      const orderId = uuidv4();
      const transactionId = uuidv4();

      // Create order first
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      // Reserve 5 blocks
      const blocks = await prisma.offerBlock.findMany({
        where: { offerId: offer.id, status: 'AVAILABLE' },
        take: 5,
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

      const counts = await getBlockCounts(offer.id);
      expect(counts.reserved).toBe(5);
      expect(counts.available).toBe(5);
    });

    it('should mark blocks as sold on order confirmation', async () => {
      const provider = await createTestProvider({ id: 'sold-provider' });
      const item = await createTestItem(provider.id, { id: 'sold-item' });
      const offer = await createTestOffer(item.id, provider.id, 5, {
        id: 'sold-offer',
      });

      const orderId = uuidv4();
      
      // Create order
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId: uuidv4(),
          status: 'PENDING',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      // Reserve all blocks
      await prisma.offerBlock.updateMany({
        where: { offerId: offer.id },
        data: {
          status: 'RESERVED',
          orderId,
          reservedAt: new Date(),
        },
      });

      // Mark as sold
      await prisma.offerBlock.updateMany({
        where: { orderId, status: 'RESERVED' },
        data: {
          status: 'SOLD',
          soldAt: new Date(),
        },
      });

      const counts = await getBlockCounts(offer.id);
      expect(counts.sold).toBe(5);
      expect(counts.reserved).toBe(0);
    });

    it('should release blocks on order cancellation', async () => {
      const provider = await createTestProvider({ id: 'release-provider' });
      const item = await createTestItem(provider.id, { id: 'release-item' });
      const offer = await createTestOffer(item.id, provider.id, 10, {
        id: 'release-offer',
      });

      const orderId = uuidv4();
      const transactionId = uuidv4();

      // Create order
      await prisma.order.create({
        data: {
          id: orderId,
          transactionId,
          status: 'PENDING',
          providerId: provider.id,
          selectedOfferId: offer.id,
          itemsJson: '[]',
          quoteJson: '{}',
        },
      });

      // Reserve some blocks (first get the block IDs, then update)
      const blocksToReserve = await prisma.offerBlock.findMany({
        where: { offerId: offer.id, status: 'AVAILABLE' },
        take: 5,
        select: { id: true },
      });
      
      await prisma.offerBlock.updateMany({
        where: { id: { in: blocksToReserve.map(b => b.id) } },
        data: {
          status: 'RESERVED',
          orderId,
          transactionId,
        },
      });

      // Release blocks (simulating cancellation)
      await prisma.offerBlock.updateMany({
        where: { transactionId, status: 'RESERVED' },
        data: {
          status: 'AVAILABLE',
          orderId: null,
          transactionId: null,
          reservedAt: null,
        },
      });

      const counts = await getBlockCounts(offer.id);
      expect(counts.available).toBe(10);
      expect(counts.reserved).toBe(0);
    });
  });

  describe('User and Balance Management', () => {
    it('should create a user with default balance', async () => {
      const userId = uuidv4();
      const phone = `+9199${Date.now().toString().slice(-8)}`;

      const user = await prisma.user.create({
        data: {
          id: userId,
          phone,
          name: 'Test User',
          balance: 10000,
        },
      });

      expect(user.balance).toBe(10000);
      expect(user.phone).toBe(phone);
    });

    it('should update user balance', async () => {
      const userId = uuidv4();
      
      await prisma.user.create({
        data: {
          id: userId,
          phone: `+9198${Date.now().toString().slice(-8)}`,
          balance: 10000,
        },
      });

      // Deduct balance
      await prisma.user.update({
        where: { id: userId },
        data: { balance: { decrement: 500 } },
      });

      const user = await prisma.user.findUnique({ where: { id: userId } });
      expect(user?.balance).toBe(9500);
    });

    it('should handle balance transfer between users', async () => {
      const buyerId = uuidv4();
      const sellerId = uuidv4();
      const amount = 100;
      const platformFee = 2.5;

      // Create users
      await prisma.user.createMany({
        data: [
          { id: buyerId, phone: `+9197${Date.now().toString().slice(-8)}`, balance: 1000 },
          { id: sellerId, phone: `+9196${Date.now().toString().slice(-8)}`, balance: 500 },
        ],
      });

      // Transfer: buyer pays amount + fee, seller receives amount
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

      const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
      const seller = await prisma.user.findUnique({ where: { id: sellerId } });

      expect(buyer?.balance).toBe(1000 - amount - platformFee);
      expect(seller?.balance).toBe(500 + amount);
    });
  });

  describe('Event Logging', () => {
    it('should log events with proper structure', async () => {
      const transactionId = uuidv4();
      const messageId = uuidv4();

      const event = await prisma.event.create({
        data: {
          transactionId,
          messageId,
          action: 'init',
          direction: 'INBOUND',
          rawJson: JSON.stringify({ order_id: 'test-order' }),
        },
      });

      expect(event.action).toBe('init');
      expect(event.direction).toBe('INBOUND');
      expect(event.id).toBeGreaterThan(0);
    });

    it('should query events by transaction ID', async () => {
      const transactionId = uuidv4();

      // Create multiple events
      await prisma.event.createMany({
        data: [
          {
            transactionId,
            messageId: uuidv4(),
            action: 'init',
            direction: 'INBOUND',
            rawJson: '{}',
          },
          {
            transactionId,
            messageId: uuidv4(),
            action: 'confirm',
            direction: 'INBOUND',
            rawJson: '{}',
          },
        ],
      });

      const events = await prisma.event.findMany({
        where: { transactionId },
        orderBy: { createdAt: 'asc' },
      });

      expect(events.length).toBe(2);
      expect(events[0].action).toBe('init');
      expect(events[1].action).toBe('confirm');
    });
  });
});
