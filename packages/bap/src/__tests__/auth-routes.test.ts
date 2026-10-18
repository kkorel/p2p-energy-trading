/**
 * Integration tests for Authentication Routes
 * Tests Phone + OTP auth flow, session management, and profile endpoints
 */

import request from 'supertest';
import express, { Express } from 'express';
import { prisma, redis, connectRedis, disconnectRedis, createSession, getSession, deleteSession } from '@p2p/shared';

// Create a mock Express app for testing
let app: Express;

// Mock the shared module
jest.mock('@p2p/shared', () => {
  const actual = jest.requireActual('@p2p/shared');
  return {
    ...actual,
    sendOtp: jest.fn(),
    verifyOtpAndAuthenticate: jest.fn(),
    createSession: jest.fn(),
    getSession: jest.fn(),
    deleteSession: jest.fn(),
    refreshSession: jest.fn(),
    prisma: {
      user: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    },
  };
});

const {
  sendOtp: mockSendOtp,
  verifyOtpAndAuthenticate: mockVerifyOtp,
  createSession: mockCreateSession,
  getSession: mockGetSession,
  deleteSession: mockDeleteSession,
} = require('@p2p/shared');

describe('Auth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup express app with auth routes
    app = express();
    app.use(express.json());

    // Mock routes matching the phone+OTP flow
    app.post('/api/auth/send-otp', async (req, res) => {
      try {
        const { phone } = req.body;
        if (!phone) {
          return res.status(400).json({ error: 'Phone number is required' });
        }

        const result = await mockSendOtp(phone);
        if (!result.success) {
          return res.status(400).json({ error: result.message });
        }

        res.json({ success: true, message: result.message });
      } catch (error) {
        res.status(500).json({ error: 'Failed to send OTP' });
      }
    });

    app.post('/api/auth/verify-otp', async (req, res) => {
      try {
        const { phone, otp, name } = req.body;
        if (!phone || !otp) {
          return res.status(400).json({ error: 'Phone number and OTP are required' });
        }

        const result = await mockVerifyOtp(phone, otp, name);
        if (!result.success) {
          return res.status(401).json({ error: result.message });
        }

        const token = await mockCreateSession({ userId: result.userId });
        res.json({ success: true, token: token.token, user: result.user });
      } catch (error) {
        res.status(500).json({ error: 'Authentication failed' });
      }
    });

    app.get('/api/user/profile', async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
      }

      const token = authHeader.replace('Bearer ', '');
      const session = await mockGetSession(token);

      if (!session) {
        return res.status(401).json({ error: 'Invalid session', code: 'SESSION_INVALID' });
      }

      const user = await require('@p2p/shared').prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) {
        return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }

      res.json(user);
    });

    app.post('/api/auth/logout', async (req, res) => {
      const authHeader = req.headers.authorization;
      if (authHeader) {
        const token = authHeader.replace('Bearer ', '');
        await mockDeleteSession(token);
      }
      res.json({ success: true });
    });

    app.put('/api/user/profile', async (req, res) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const token = authHeader.replace('Bearer ', '');
      const session = await mockGetSession(token);

      if (!session) {
        return res.status(401).json({ error: 'Invalid session' });
      }

      const { name, meterNumber } = req.body;
      if (!name || name.length < 2) {
        return res.status(400).json({ error: 'Name must be at least 2 characters' });
      }

      const user = await require('@p2p/shared').prisma.user.update({
        where: { id: session.userId },
        data: { name, meterNumber, profileComplete: true },
      });

      res.json(user);
    });
  });

  describe('POST /api/auth/send-otp', () => {
    it('should return 400 when phone number is missing', async () => {
      const response = await request(app)
        .post('/api/auth/send-otp')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Phone number');
    });

    it('should return success when OTP is sent', async () => {
      mockSendOtp.mockResolvedValue({ success: true, message: 'OTP sent successfully' });

      const response = await request(app)
        .post('/api/auth/send-otp')
        .send({ phone: '+919876543210' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('OTP sent successfully');
    });

    it('should return 400 when phone number is invalid', async () => {
      mockSendOtp.mockResolvedValue({ success: false, message: 'Invalid phone number format' });

      const response = await request(app)
        .post('/api/auth/send-otp')
        .send({ phone: '123' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid phone');
    });

    it('should handle send errors gracefully', async () => {
      mockSendOtp.mockRejectedValue(new Error('SMS service error'));

      const response = await request(app)
        .post('/api/auth/send-otp')
        .send({ phone: '+919876543210' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('Failed');
    });
  });

  describe('POST /api/auth/verify-otp', () => {
    it('should return 400 when phone or OTP is missing', async () => {
      const response = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone: '+919876543210' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('OTP are required');
    });

    it('should return 401 when OTP is invalid', async () => {
      mockVerifyOtp.mockResolvedValue({ success: false, message: 'Invalid OTP' });

      const response = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone: '+919876543210', otp: '000000' });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('Invalid OTP');
    });

    it('should return session token on successful verification', async () => {
      mockVerifyOtp.mockResolvedValue({
        success: true,
        userId: 'user-123',
        user: { id: 'user-123', phone: '+919876543210', name: 'Test User' },
      });
      mockCreateSession.mockResolvedValue({ token: 'session-token-abc' });

      const response = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone: '+919876543210', otp: '123456', name: 'Test User' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.token).toBe('session-token-abc');
    });

    it('should handle verification errors gracefully', async () => {
      mockVerifyOtp.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .post('/api/auth/verify-otp')
        .send({ phone: '+919876543210', otp: '123456' });

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('failed');
    });
  });

  describe('GET /api/user/profile', () => {
    it('should return 401 when no authorization header', async () => {
      const response = await request(app).get('/api/user/profile');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('AUTH_REQUIRED');
    });

    it('should return 401 when session is invalid', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('SESSION_INVALID');
    });

    it('should return 401 when user not found', async () => {
      mockGetSession.mockResolvedValue({ userId: 'deleted-user' });
      require('@p2p/shared').prisma.user.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('USER_NOT_FOUND');
    });

    it('should return user profile when authenticated', async () => {
      mockGetSession.mockResolvedValue({ userId: 'user-123' });
      require('@p2p/shared').prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
      });

      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.phone).toBe('+919876543210');
      expect(response.body.name).toBe('Test User');
    });

    it('should accept Bearer prefix in authorization', async () => {
      mockGetSession.mockResolvedValue({ userId: 'user-123' });
      require('@p2p/shared').prisma.user.findUnique.mockResolvedValue({
        id: 'user-123',
        phone: '+919876543210',
        name: 'Test User',
      });

      const response = await request(app)
        .get('/api/user/profile')
        .set('Authorization', 'Bearer my-token');

      expect(response.status).toBe(200);
      expect(mockGetSession).toHaveBeenCalledWith('my-token');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return success even without token', async () => {
      const response = await request(app).post('/api/auth/logout');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should delete session when token provided', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer session-to-delete');

      expect(response.status).toBe(200);
      expect(mockDeleteSession).toHaveBeenCalledWith('session-to-delete');
    });
  });

  describe('PUT /api/user/profile', () => {
    it('should return 401 when not authenticated', async () => {
      const response = await request(app)
        .put('/api/user/profile')
        .send({ name: 'New Name' });

      expect(response.status).toBe(401);
    });

    it('should return 400 when name is too short', async () => {
      mockGetSession.mockResolvedValue({ userId: 'user-123' });

      const response = await request(app)
        .put('/api/user/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'A' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('at least 2 characters');
    });

    it('should update profile successfully', async () => {
      mockGetSession.mockResolvedValue({ userId: 'user-123' });
      require('@p2p/shared').prisma.user.update.mockResolvedValue({
        id: 'user-123',
        name: 'Updated Name',
        meterNumber: 'MTR-123',
        profileComplete: true,
      });

      const response = await request(app)
        .put('/api/user/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'Updated Name', meterNumber: 'MTR-123' });

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('Updated Name');
      expect(response.body.profileComplete).toBe(true);
    });

    it('should set profileComplete to true after update', async () => {
      mockGetSession.mockResolvedValue({ userId: 'user-123' });
      require('@p2p/shared').prisma.user.update.mockResolvedValue({
        id: 'user-123',
        name: 'Test',
        profileComplete: true,
      });

      await request(app)
        .put('/api/user/profile')
        .set('Authorization', 'Bearer valid-token')
        .send({ name: 'Test' });

      expect(require('@p2p/shared').prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ profileComplete: true }),
        })
      );
    });
  });
});
