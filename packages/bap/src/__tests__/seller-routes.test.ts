/**
 * Integration tests for Seller Routes
 * Tests offer creation, management, and seller order handling
 */

import request from 'supertest';
import express, { Express } from 'express';

// Mock shared module
jest.mock('@p2p/shared', () => ({
  prisma: {
    user: { findUnique: jest.fn(), update: jest.fn() },
    provider: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    offer: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    order: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  },
  getSession: jest.fn(),
  refreshSession: jest.fn(),
  config: {
    bap: { id: 'test-bap', uri: 'http://test-bap.com' },
    bpp: { id: 'test-bpp', uri: 'http://test-bpp.com' },
    external: { enableLedgerWrites: false },
  },
}));

const { prisma, getSession } = require('@p2p/shared');

describe('Seller Routes', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    
    app = express();
    app.use(express.json());

    // Register as seller (create provider) - NO provider check required
    app.post('/api/seller/register', async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      
      const token = authHeader.replace('Bearer ', '');
      const session = await getSession(token);
      
      if (!session) {
        return res.status(401).json({ error: 'Invalid session' });
      }
      
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }
      
      if (user.providerId) {
        return res.status(400).json({ error: 'Already registered as seller', code: 'ALREADY_SELLER' });
      }
      
      try {
        const { providerName, meterNumber, capacityKW, sourceType } = req.body;
        
        if (!providerName || providerName.length < 2) {
          return res.status(400).json({ error: 'Provider name required', code: 'INVALID_NAME' });
        }
        
        if (!capacityKW || capacityKW <= 0) {
          return res.status(400).json({ error: 'Capacity required', code: 'INVALID_CAPACITY' });
        }
        
        const provider = await prisma.provider.create({
          data: {
            name: providerName,
            meterNumber,
            capacityKW,
            sourceType,
            trustScore: 0.5, // Default trust score
          },
        });
        
        await prisma.user.update({
          where: { id: user.id },
          data: { providerId: provider.id },
        });
        
        res.status(201).json({ success: true, provider });
      } catch (error) {
        res.status(500).json({ error: 'Failed to register as seller' });
      }
    });

    // Mock authentication middleware with provider check - applies to other seller endpoints
    app.use('/api/seller', async (req, res, next) => {
      // Skip if already handled (register endpoint)
      if (req.path === '/register') {
        return next();
      }
      
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }
      
      const token = authHeader.replace('Bearer ', '');
      const session = await getSession(token);
      
      if (!session) {
        return res.status(401).json({ error: 'Invalid session', code: 'SESSION_INVALID' });
      }
      
      const user = await prisma.user.findUnique({ 
        where: { id: session.userId },
        include: { provider: true },
      });
      
      if (!user) {
        return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      
      if (!user.providerId) {
        return res.status(403).json({ error: 'Seller profile required', code: 'PROVIDER_REQUIRED' });
      }
      
      (req as any).user = user;
      (req as any).provider = user.provider;
      next();
    });

    // Get seller offers
    app.get('/api/seller/offers', async (req, res) => {
      try {
        const provider = (req as any).provider;
        const { status } = req.query;
        
        const where: any = { providerId: provider.id };
        if (status) {
          where.status = status;
        }
        
        const offers = await prisma.offer.findMany({ where });
        res.json({ success: true, offers });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch offers' });
      }
    });

    // Create offer
    app.post('/api/seller/offers', async (req, res) => {
      try {
        const provider = (req as any).provider;
        const { price, maxQuantity, sourceType, timeWindow } = req.body;
        
        // Validation
        if (!price || price <= 0) {
          return res.status(400).json({ error: 'Invalid price', code: 'INVALID_PRICE' });
        }
        
        if (!maxQuantity || maxQuantity <= 0) {
          return res.status(400).json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY' });
        }
        
        if (!sourceType) {
          return res.status(400).json({ error: 'Source type required', code: 'MISSING_SOURCE_TYPE' });
        }
        
        const validSourceTypes = ['SOLAR', 'WIND', 'HYDRO', 'BIOMASS', 'OTHER'];
        if (!validSourceTypes.includes(sourceType)) {
          return res.status(400).json({ error: 'Invalid source type', code: 'INVALID_SOURCE_TYPE' });
        }
        
        const offer = await prisma.offer.create({
          data: {
            providerId: provider.id,
            price,
            maxQuantity,
            sourceType,
            timeWindow,
            status: 'ACTIVE',
          },
        });
        
        res.status(201).json({ success: true, offer });
      } catch (error) {
        res.status(500).json({ error: 'Failed to create offer' });
      }
    });

    // Update offer
    app.put('/api/seller/offers/:offerId', async (req, res) => {
      try {
        const { offerId } = req.params;
        const provider = (req as any).provider;
        const { price, maxQuantity, status } = req.body;
        
        const offer = await prisma.offer.findUnique({ where: { id: offerId } });
        
        if (!offer) {
          return res.status(404).json({ error: 'Offer not found', code: 'OFFER_NOT_FOUND' });
        }
        
        if (offer.providerId !== provider.id) {
          return res.status(403).json({ error: 'Access denied', code: 'ACCESS_DENIED' });
        }
        
        const updateData: any = {};
        if (price !== undefined) {
          if (price <= 0) {
            return res.status(400).json({ error: 'Invalid price', code: 'INVALID_PRICE' });
          }
          updateData.price = price;
        }
        if (maxQuantity !== undefined) {
          if (maxQuantity <= 0) {
            return res.status(400).json({ error: 'Invalid quantity', code: 'INVALID_QUANTITY' });
          }
          updateData.maxQuantity = maxQuantity;
        }
        if (status !== undefined) {
          const validStatuses = ['ACTIVE', 'INACTIVE', 'SOLD_OUT'];
          if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status', code: 'INVALID_STATUS' });
          }
          updateData.status = status;
        }
        
        const updated = await prisma.offer.update({
          where: { id: offerId },
          data: updateData,
        });
        
        res.json({ success: true, offer: updated });
      } catch (error) {
        res.status(500).json({ error: 'Failed to update offer' });
      }
    });

    // Delete offer
    app.delete('/api/seller/offers/:offerId', async (req, res) => {
      try {
        const { offerId } = req.params;
        const provider = (req as any).provider;
        
        const offer = await prisma.offer.findUnique({ where: { id: offerId } });
        
        if (!offer) {
          return res.status(404).json({ error: 'Offer not found', code: 'OFFER_NOT_FOUND' });
        }
        
        if (offer.providerId !== provider.id) {
          return res.status(403).json({ error: 'Access denied', code: 'ACCESS_DENIED' });
        }
        
        await prisma.offer.delete({ where: { id: offerId } });
        
        res.json({ success: true, message: 'Offer deleted' });
      } catch (error) {
        res.status(500).json({ error: 'Failed to delete offer' });
      }
    });

    // Get seller orders
    app.get('/api/seller/orders', async (req, res) => {
      try {
        const provider = (req as any).provider;
        const { status } = req.query;
        
        const where: any = { providerId: provider.id };
        if (status) {
          where.status = status;
        }
        
        const orders = await prisma.order.findMany({ where });
        res.json({ success: true, orders });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch orders' });
      }
    });

    // Update order status (for seller to mark as delivered, etc.)
    app.put('/api/seller/orders/:orderId', async (req, res) => {
      try {
        const { orderId } = req.params;
        const provider = (req as any).provider;
        const { status } = req.body;
        
        const order = await prisma.order.findUnique({ where: { id: orderId } });
        
        if (!order) {
          return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }
        
        if (order.providerId !== provider.id) {
          return res.status(403).json({ error: 'Access denied', code: 'ACCESS_DENIED' });
        }
        
        // Validate status transitions
        const validTransitions: Record<string, string[]> = {
          'ACTIVE': ['DELIVERING', 'CANCELLED'],
          'DELIVERING': ['DELIVERED', 'CANCELLED'],
          'DELIVERED': ['COMPLETED'],
        };
        
        const allowedNext = validTransitions[order.status] || [];
        if (!allowedNext.includes(status)) {
          return res.status(400).json({ 
            error: `Cannot transition from ${order.status} to ${status}`, 
            code: 'INVALID_TRANSITION' 
          });
        }
        
        const updated = await prisma.order.update({
          where: { id: orderId },
          data: { status },
        });
        
        res.json({ success: true, order: updated });
      } catch (error) {
        res.status(500).json({ error: 'Failed to update order' });
      }
    });

    // Get seller profile/stats
    app.get('/api/seller/profile', async (req, res) => {
      try {
        const provider = (req as any).provider;
        
        const orders = await prisma.order.findMany({ where: { providerId: provider.id } });
        const completedOrders = orders.filter((o: any) => o.status === 'COMPLETED');
        
        res.json({
          success: true,
          provider,
          stats: {
            totalOrders: orders.length,
            completedOrders: completedOrders.length,
            successRate: orders.length > 0 ? completedOrders.length / orders.length : 0,
          },
        });
      } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' });
      }
    });
  });

  describe('Seller Authentication', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app).get('/api/seller/offers');
      
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTH_REQUIRED');
    });

    it('should return 403 when user is not a seller', async () => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        providerId: null, // Not a seller
      });
      
      const response = await request(app)
        .get('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PROVIDER_REQUIRED');
    });
  });

  describe('GET /api/seller/offers', () => {
    const sellerUser = {
      id: 'seller-123',
      providerId: 'provider-456',
      provider: { id: 'provider-456', name: 'Test Provider', trustScore: 0.8 },
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'seller-123' });
      prisma.user.findUnique.mockResolvedValue(sellerUser);
    });

    it('should return seller offers', async () => {
      prisma.offer.findMany.mockResolvedValue([
        { id: 'offer-1', price: 6, maxQuantity: 100, status: 'ACTIVE' },
        { id: 'offer-2', price: 5.5, maxQuantity: 50, status: 'ACTIVE' },
      ]);
      
      const response = await request(app)
        .get('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(200);
      expect(response.body.offers).toHaveLength(2);
    });

    it('should filter by status', async () => {
      prisma.offer.findMany.mockResolvedValue([
        { id: 'offer-1', status: 'ACTIVE' },
      ]);
      
      await request(app)
        .get('/api/seller/offers?status=ACTIVE')
        .set('Authorization', 'Bearer valid-token');
      
      expect(prisma.offer.findMany).toHaveBeenCalledWith({
        where: { providerId: 'provider-456', status: 'ACTIVE' },
      });
    });
  });

  describe('POST /api/seller/offers', () => {
    const sellerUser = {
      id: 'seller-123',
      providerId: 'provider-456',
      provider: { id: 'provider-456', name: 'Test Provider' },
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'seller-123' });
      prisma.user.findUnique.mockResolvedValue(sellerUser);
    });

    it('should return 400 for invalid price', async () => {
      const response = await request(app)
        .post('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 0, maxQuantity: 100, sourceType: 'SOLAR' });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_PRICE');
    });

    it('should return 400 for invalid quantity', async () => {
      const response = await request(app)
        .post('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 6, maxQuantity: 0, sourceType: 'SOLAR' });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_QUANTITY');
    });

    it('should return 400 for missing source type', async () => {
      const response = await request(app)
        .post('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 6, maxQuantity: 100 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('MISSING_SOURCE_TYPE');
    });

    it('should return 400 for invalid source type', async () => {
      const response = await request(app)
        .post('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 6, maxQuantity: 100, sourceType: 'NUCLEAR' });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_SOURCE_TYPE');
    });

    it('should create offer successfully', async () => {
      prisma.offer.create.mockResolvedValue({
        id: 'new-offer-1',
        providerId: 'provider-456',
        price: 6,
        maxQuantity: 100,
        sourceType: 'SOLAR',
        status: 'ACTIVE',
      });
      
      const response = await request(app)
        .post('/api/seller/offers')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 6, maxQuantity: 100, sourceType: 'SOLAR' });
      
      expect(response.status).toBe(201);
      expect(response.body.offer.id).toBe('new-offer-1');
    });

    it('should accept valid source types', async () => {
      const sourceTypes = ['SOLAR', 'WIND', 'HYDRO', 'BIOMASS', 'OTHER'];
      
      for (const sourceType of sourceTypes) {
        prisma.offer.create.mockResolvedValue({ id: 'offer', sourceType });
        
        const response = await request(app)
          .post('/api/seller/offers')
          .set('Authorization', 'Bearer valid-token')
          .send({ price: 6, maxQuantity: 100, sourceType });
        
        expect(response.status).toBe(201);
      }
    });
  });

  describe('PUT /api/seller/offers/:offerId', () => {
    const sellerUser = {
      id: 'seller-123',
      providerId: 'provider-456',
      provider: { id: 'provider-456' },
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'seller-123' });
      prisma.user.findUnique.mockResolvedValue(sellerUser);
    });

    it('should return 404 when offer not found', async () => {
      prisma.offer.findUnique.mockResolvedValue(null);
      
      const response = await request(app)
        .put('/api/seller/offers/nonexistent')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 7 });
      
      expect(response.status).toBe(404);
    });

    it('should return 403 when offer belongs to different provider', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        providerId: 'other-provider',
      });
      
      const response = await request(app)
        .put('/api/seller/offers/offer-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 7 });
      
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ACCESS_DENIED');
    });

    it('should update price successfully', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        providerId: 'provider-456',
        price: 6,
      });
      prisma.offer.update.mockResolvedValue({
        id: 'offer-1',
        price: 7,
      });
      
      const response = await request(app)
        .put('/api/seller/offers/offer-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ price: 7 });
      
      expect(response.status).toBe(200);
      expect(response.body.offer.price).toBe(7);
    });

    it('should update status successfully', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        providerId: 'provider-456',
      });
      prisma.offer.update.mockResolvedValue({
        id: 'offer-1',
        status: 'INACTIVE',
      });
      
      const response = await request(app)
        .put('/api/seller/offers/offer-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'INACTIVE' });
      
      expect(response.status).toBe(200);
    });

    it('should return 400 for invalid status', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        providerId: 'provider-456',
      });
      
      const response = await request(app)
        .put('/api/seller/offers/offer-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'INVALID_STATUS' });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_STATUS');
    });
  });

  describe('DELETE /api/seller/offers/:offerId', () => {
    const sellerUser = {
      id: 'seller-123',
      providerId: 'provider-456',
      provider: { id: 'provider-456' },
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'seller-123' });
      prisma.user.findUnique.mockResolvedValue(sellerUser);
    });

    it('should delete offer successfully', async () => {
      prisma.offer.findUnique.mockResolvedValue({
        id: 'offer-1',
        providerId: 'provider-456',
      });
      prisma.offer.delete.mockResolvedValue({ id: 'offer-1' });
      
      const response = await request(app)
        .delete('/api/seller/offers/offer-1')
        .set('Authorization', 'Bearer valid-token');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('POST /api/seller/register', () => {
    it('should return 400 if already a seller', async () => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        providerId: 'existing-provider',
      });
      
      const response = await request(app)
        .post('/api/seller/register')
        .set('Authorization', 'Bearer valid-token')
        .send({ providerName: 'New Provider', capacityKW: 100 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('ALREADY_SELLER');
    });

    it('should register new seller successfully', async () => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        providerId: null,
      });
      prisma.provider.create.mockResolvedValue({
        id: 'new-provider',
        name: 'Solar Farm',
        trustScore: 0.5,
      });
      prisma.user.update.mockResolvedValue({ id: 'user-123' });
      
      const response = await request(app)
        .post('/api/seller/register')
        .set('Authorization', 'Bearer valid-token')
        .send({
          providerName: 'Solar Farm',
          capacityKW: 500,
          sourceType: 'SOLAR',
        });
      
      expect(response.status).toBe(201);
      expect(response.body.provider.name).toBe('Solar Farm');
    });

    it('should return 400 for invalid provider name', async () => {
      getSession.mockResolvedValue({ userId: 'user-123' });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        providerId: null,
      });
      
      const response = await request(app)
        .post('/api/seller/register')
        .set('Authorization', 'Bearer valid-token')
        .send({ providerName: 'A', capacityKW: 100 });
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_NAME');
    });
  });

  describe('PUT /api/seller/orders/:orderId', () => {
    const sellerUser = {
      id: 'seller-123',
      providerId: 'provider-456',
      provider: { id: 'provider-456' },
    };

    beforeEach(() => {
      getSession.mockResolvedValue({ userId: 'seller-123' });
      prisma.user.findUnique.mockResolvedValue(sellerUser);
    });

    it('should validate status transitions', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        providerId: 'provider-456',
        status: 'ACTIVE',
      });
      
      const response = await request(app)
        .put('/api/seller/orders/order-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'COMPLETED' }); // Invalid: ACTIVE cannot go to COMPLETED
      
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_TRANSITION');
    });

    it('should allow valid status transition', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        providerId: 'provider-456',
        status: 'ACTIVE',
      });
      prisma.order.update.mockResolvedValue({
        id: 'order-1',
        status: 'DELIVERING',
      });
      
      const response = await request(app)
        .put('/api/seller/orders/order-1')
        .set('Authorization', 'Bearer valid-token')
        .send({ status: 'DELIVERING' });
      
      expect(response.status).toBe(200);
      expect(response.body.order.status).toBe('DELIVERING');
    });
  });
});
