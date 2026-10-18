/**
 * Integration tests for Buyer Routes
 * Tests discover, select, init, confirm, status, and cancel endpoints
 */

import request from 'supertest';
import express, { Express } from 'express';

// Mock shared module
jest.mock('@p2p/shared', () => ({
  prisma: {
    user: { findUnique: jest.fn() },
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    offer: { findMany: jest.fn(), findUnique: jest.fn() },
    provider: { findMany: jest.fn() },
    transaction: { create: jest.fn() },
  },
  getSession: jest.fn(),
  refreshSession: jest.fn(),
  config: {
    bap: { id: 'test-bap', uri: 'http://test-bap.com' },
    bpp: { id: 'test-bpp', uri: 'http://test-bpp.com' },
    external: { enableLedgerWrites: false },
  },
  matchOffers: jest.fn(),
  createContext: jest.fn(),
}));

const { prisma, getSession, matchOffers, createContext } = require('@p2p/shared');

describe('Buyer Routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    
    app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use(async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      
      const token = authHeader.replace('Bearer ', '');
      const session = await getSession(token);
      
      if (!session) {
        return res.status(401).json({ error: 'Invalid session', code: 'SESSION_INVALID' });
      }
      
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) {
        return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      
      if (!user.profileComplete) {
        return res.status(403).json({ error: 'Profile incomplete', code: 'PROFILE_INCOMPLETE' });
      }
      
      (req as any).user = user;
      next();
    });

    // Discover endpoint
    app.post('/api/discover', async (req, res) => {
      try {
        const { quantity, maxPrice, timeWindow, sourceType } = req.body;
        
        if (!quantity || quantity <= 0) {
          return res.status(400).json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY' });
        }
        
        const offers = await prisma.offer.findMany({ where: { status: 'ACTIVE' } });
        const providers = await prisma.provider.findMany();
        const providerMap = new Map(providers.map((p: any) => [p.id, p]));
        
        const result = matchOffers(offers, providerMap, { requestedQuantity: quantity, maxPrice });
        
        res.json({
          success: true,
          offers: result.allOffers,
          eligibleCount: result.eligibleCount,
        });
      } catch (error) {
        res.status(500).json({ error: 'Discovery failed', code: 'DISCOVER_FAILED' });
      }
    });

    // Select endpoint
    app.post('/api/select', async (req, res) => {
      try {
        const { offerId, quantity } = req.body;
        
        if (!offerId) {
          return res.status(400).json({ error: 'Offer ID required', code: 'MISSING_OFFER_ID' });
        }
        
        const offer = await prisma.offer.findUnique({ where: { id: offerId } });
        
        if (!offer) {
          return res.status(404).json({ error: 'Offer not found', code: 'OFFER_NOT_FOUND' });
        }
        
        if (offer.status !== 'ACTIVE') {
          return res.status(400).json({ error: 'Offer not available', code: 'OFFER_UNAVAILABLE' });
        }
        
        if (quantity > offer.maxQuantity) {
          return res.status(400).json({ error: 'Quantity exceeds available', code: 'QUANTITY_EXCEEDED' });
        }
        
        const totalPrice = offer.price * quantity;
        
        res.json({
          success: true,
          quote: {
            price: { value: totalPrice, currency: 'INR' },
            totalQuantity: quantity,
          },
          offer,
        });
      } catch (error) {
        res.status(500).json({ error: 'Selection failed', code: 'SELECT_FAILED' });
      }
    });

    // Init endpoint
    app.post('/api/init', async (req, res) => {
      try {
        const { offerId, quantity } = req.body;
        const user = (req as any).user;
        
        const offer = await prisma.offer.findUnique({ where: { id: offerId } });
        
        if (!offer) {
          return res.status(404).json({ error: 'Offer not found' });
        }
        
        const totalPrice = offer.price * quantity;
        
        // Check balance
        if ((user.balance || 0) < totalPrice) {
          return res.status(400).json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' });
        }
        
        res.json({
          success: true,
          orderId: `preview-${Date.now()}`,
          quote: {
            price: { value: totalPrice, currency: 'INR' },
            totalQuantity: quantity,
          },
        });
      } catch (error) {
        res.status(500).json({ error: 'Init failed', code: 'INIT_FAILED' });
      }
    });

    // Confirm endpoint
    app.post('/api/confirm', async (req, res) => {
      try {
        const { offerId, quantity } = req.body;
        const user = (req as any).user;
        
        const offer = await prisma.offer.findUnique({ where: { id: offerId } });
        
        if (!offer) {
          return res.status(404).json({ error: 'Offer not found' });
        }
        
        if (offer.status !== 'ACTIVE') {
          return res.status(400).json({ error: 'Offer no longer available', code: 'OFFER_UNAVAILABLE' });
        }
        
        const totalPrice = offer.price * quantity;
        
        if ((user.balance || 0) < totalPrice) {
          return res.status(400).json({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' });
        }
        
        const order = await prisma.order.create({
          data: {
            buyerId: user.id,
            providerId: offer.providerId,
            offerId: offer.id,
            quantity,
            totalPrice,
            status: 'ACTIVE',
          },
        });
        
        res.json({
          success: true,
          order,
        });
      } catch (error) {
        res.status(500).json({ error: 'Confirmation failed', code: 'CONFIRM_FAILED' });
      }
    });

    // Status endpoint
    app.get('/api/orders/:orderId/status', async (req, res) => {
      try {
        const { orderId } = req.params;
        const user = (req as any).user;
        
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        
        if (!order) {
          return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }
        
        if (order.buyerId !== user.id) {
          return res.status(403).json({ error: 'Access denied', code: 'ACCESS_DENIED' });
        }
        
        res.json({ success: true, order });
      } catch (error) {
        res.status(500).json({ error: 'Status check failed' });
      }
    });

    // Cancel endpoint
    app.post('/api/orders/:orderId/cancel', async (req, res) => {
      try {
        const { orderId } = req.params;
        const user = (req as any).user;
        
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        
        if (!order) {
          return res.status(404).json({ error: 'Order not found' });
        }
        
        if (order.buyerId !== user.id) {
          return res.status(403).json({ error: 'Access denied' });
        }
        
        if (order.status !== 'ACTIVE') {
          return res.status(400).json({ error: 'Order cannot be cancelled', code: 'CANNOT_CANCEL' });
        }
        
        const updated = await prisma.order.update({
          where: { id: orderId },
          data: { status: 'CANCELLED' },
        });
        
        res.json({ success: true, order: updated });
      } catch (error) {
        res.status(500).json({ error: 'Cancellation failed' });
      }
    });

    // Orders list endpoint
    app.get('/api/orders', async (req, res) => {
      try {
        const user = (req as any).user;
        const { status } = req.query;
        
        const where: any = { buyerId: user.id };
        if (status) {
          where.status = status;
        }
        
        const orders = await prisma.order.findMany({ where });
        res.json({ success: true, orders });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch orders' });
      }
    });
  });

  describe('POST /api/discover', () => {
    const authUser = {
      id: 'user-123',
      phone: '+919876543210',
      name: 'Test Buyer',
      profileComplete: true,
      balance: 1000,
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue(authUser);
    });

    it('should return 401 without authentication', async () => {
      getSession.mockResolvedValue(null);
      
      const response = await request(app)
        .post('/api/discover')
        .send({ quantity: 10 });
      
      expect(response.status).toBe(401);
    });

    it('should return 400 for invalid quantity (0)', async () => {
      const response = await request(app)
        .post('/api/discover')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: 0 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_QUANTITY');
    });

    it('should return 400 for negative quantity', async () => {
      const response = await request(app)
        .post('/api/discover')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: -5 });
      
      expect(response.status).toBe(400);
    });

    it('should return matched offers', async () => {
      prisma.offer.findMany.mockResolvedValue([
        { id: 'offer-1', price: 6, maxQuantity: 100, status: 'ACTIVE', providerId: 'prov-1' },
      ]);
      prisma.provider.findMany.mockResolvedValue([
        { id: 'prov-1', name: 'Provider 1', trustScore: 0.8 },
      ]);
      matchOffers.mockReturnValue({
        allOffers: [{ offer: { id: 'offer-1' }, score: 0.9, matchesFilters: true }],
        eligibleCount: 1,
      });
      
      const response = await request(app)
        .post('/api/discover')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: 10 });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.offers).toHaveLength(1);
    });

    it('should return empty array when no offers match', async () => {
      prisma.offer.findMany.mockResolvedValue([]);
      prisma.provider.findMany.mockResolvedValue([]);
      matchOffers.mockReturnValue({ allOffers: [], eligibleCount: 0 });
      
      const response = await request(app)
        .post('/api/discover')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: 10 });
      
      expect(response.status).toBe(200);
      expect(response.body.offers).toHaveLength(0);
    });

    it('should respect maxPrice filter', async () => {
      prisma.offer.findMany.mockResolvedValue([]);
      prisma.provider.findMany.mockResolvedValue([]);
      matchOffers.mockReturnValue({ allOffers: [], eligibleCount: 0 });
      
      await request(app)
        .post('/api/discover')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: 10, maxPrice: 5 });
      
      expect(matchOffers).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Map),
        expect.objectContaining({ maxPrice: 5 })
      );
    });
  });

  describe('POST /api/select', () => {
    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
      });
    });

    it('should return 400 when offerId is missing', async () => {
      const response = await request(app)
        .post('/api/select')
        .set('Authorization', 'Bearer valid-token')
        .send({ quantity: 10 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MISSING_OFFER_ID');
    });

    it('should return 404 when offer not found', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      
      const response = await request(app)
        .post('/api/select')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'nonexistent', quantity: 10 });
      
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('OFFER_NOT_FOUND');
    });

    it('should return 400 when offer is not active', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'INACTIVE',
      });
      
      const response = await request(app)
        .post('/api/select')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'offer-1', quantity: 10 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('OFFER_UNAVAILABLE');
    });

    it('should return 400 when quantity exceeds available', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'ACTIVE',
        maxQuantity: 50,
        price: 6,
      });
      
      const response = await request(app)
        .post('/api/select')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'offer-1', quantity: 100 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('QUANTITY_EXCEEDED');
    });

    it('should return quote for valid selection', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'ACTIVE',
        maxQuantity: 100,
        price: 6,
      });
      
      const response = await request(app)
        .post('/api/select')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'offer-1', quantity: 10 });
      
      expect(response.status).toBe(200);
      expect(response.body.quote.price.value).toBe(60);
      expect(response.body.quote.totalQuantity).toBe(10);
    });
  });

  describe('POST /api/confirm', () => {
    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
        balance: 1000,
      });
    });

    it('should return 404 when offer not found', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      
      const response = await request(app)
        .post('/api/confirm')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'nonexistent', quantity: 10 });
      
      expect(response.status).toBe(404);
    });

    it('should return 400 when insufficient balance', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
        balance: 10,
      });
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'ACTIVE',
        price: 6,
        providerId: 'prov-1',
      });
      
      const response = await request(app)
        .post('/api/confirm')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'offer-1', quantity: 10 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should create order successfully', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        status: 'ACTIVE',
        price: 6,
        providerId: 'prov-1',
      });
      prisma.order.create.mockResolvedValue({
        id: 'order-123',
        buyerId: 'user-123',
        status: 'ACTIVE',
        quantity: 10,
        totalPrice: 60,
      });
      
      const response = await request(app)
        .post('/api/confirm')
        .set('Authorization', 'Bearer valid-token')
        .send({ offerId: 'offer-1', quantity: 10 });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.order.id).toBe('order-123');
    });
  });

  describe('GET /api/orders/:orderId/status', () => {
    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
      });
    });

    it('should return 404 when order not found', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      
      const response = await request(app)
        .get('/api/orders/nonexistent/status')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('ORDER_NOT_FOUND');
    });

    it('should return 403 when order belongs to different user', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-123',
        buyerId: 'other-user',
      });
      
      const response = await request(app)
        .get('/api/orders/order-123/status')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ACCESS_DENIED');
    });

    it('should return order status', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-123',
        buyerId: 'user-123',
        status: 'ACTIVE',
      });
      
      const response = await request(app)
        .get('/api/orders/order-123/status')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('ACTIVE');
    });
  });

  describe('POST /api/orders/:orderId/cancel', () => {
    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
      });
    });

    it('should return 404 when order not found', async () => {
      prisma.order.findUnique.mockResolvedValue(null);
      
      const response = await request(app)
        .post('/api/orders/nonexistent/cancel')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(404);
    });

    it('should return 400 when order cannot be cancelled', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-123',
        buyerId: 'user-123',
        status: 'COMPLETED',
      });
      
      const response = await request(app)
        .post('/api/orders/order-123/cancel')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('CANNOT_CANCEL');
    });

    it('should cancel order successfully', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-123',
        buyerId: 'user-123',
        status: 'ACTIVE',
      });
      prisma.order.update.mockResolvedValue({
        id: 'order-123',
        status: 'CANCELLED',
      });
      
      const response = await request(app)
        .post('/api/orders/order-123/cancel')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('CANCELLED');
    });
  });

  describe('GET /api/orders', () => {
    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        profileComplete: true,
      });
    });

    it('should return all user orders', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-1', status: 'ACTIVE' },
        { id: 'order-2', status: 'COMPLETED' },
      ]);
      
      const response = await request(app)
        .get('/api/orders')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(200);
      expect(response.body.orders).toHaveLength(2);
    });

    it('should filter by status', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-1', status: 'ACTIVE' },
      ]);
      
      await request(app)
        .get('/api/orders?status=ACTIVE')
        .set('Authorization', 'Bearer valid-token');
      
      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { buyerId: 'user-123', status: 'ACTIVE' },
      });
    });
  });
});
