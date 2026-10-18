/**
 * Comprehensive unit tests for Authentication Middleware
 * Tests token extraction, session validation, and authorization checks
 */

import { Request, Response, NextFunction } from 'express';
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireCompleteProfile,
  requireProvider,
} from '../middleware/auth';
import { prisma, getSession, refreshSession } from '@p2p/shared';

// Mock the shared module
jest.mock('@p2p/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
    },
  },
  getSession: jest.fn(),
  refreshSession: jest.fn(),
}));

// Mock request, response, and next function
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    user: undefined,
    sessionToken: undefined,
    ...overrides,
  } as Request;
}

function createMockResponse(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

function createMockNext(): NextFunction {
  return jest.fn();
}

describe('Authentication Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Token Extraction', () => {
    it('should extract token from Bearer authorization header', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer abc123' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
        providerId: null,
        provider: null,
      });

      await authMiddleware(req, res, next);

      expect(getSession).toHaveBeenCalledWith('abc123');
    });

    it('should extract raw token when no Bearer prefix', async () => {
      const req = createMockRequest({
        headers: { authorization: 'raw-token-xyz' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
        providerId: null,
        provider: null,
      });

      await authMiddleware(req, res, next);

      expect(getSession).toHaveBeenCalledWith('raw-token-xyz');
    });

    it('should return null when authorization header is missing', async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
        })
      );
    });

    it('should return null when authorization header is empty', async () => {
      const req = createMockRequest({
        headers: { authorization: '' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should handle Bearer with no token after it', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer ' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue(null);

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('authMiddleware', () => {
    it('should populate req.user and call next() for valid session', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      const mockUser = {
        id: 'user-123',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
        providerId: 'provider-456',
        provider: {
          id: 'provider-456',
          name: 'Test Provider',
          trustScore: 0.85,
        },
      };

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-123' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      await authMiddleware(req, res, next);

      expect(req.user).toEqual({
        id: 'user-123',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
        providerId: 'provider-456',
        provider: {
          id: 'provider-456',
          name: 'Test Provider',
          trustScore: 0.85,
        },
      });
      expect(req.sessionToken).toBe('valid-token');
      expect(next).toHaveBeenCalled();
    });

    it('should return 401 when no token provided', async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 401 SESSION_INVALID when session not found', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue(null);

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or expired session',
        code: 'SESSION_INVALID',
      });
    });

    it('should return 401 USER_NOT_FOUND when user not in database', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'deleted-user' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    });

    it('should call refreshSession for valid session', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test',
        profileComplete: true,
        providerId: null,
        provider: null,
      });

      await authMiddleware(req, res, next);

      expect(refreshSession).toHaveBeenCalledWith('valid-token');
    });

    it('should return 500 AUTH_ERROR on internal error', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockRejectedValue(new Error('Database error'));

      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication error',
        code: 'AUTH_ERROR',
      });

      consoleSpy.mockRestore();
    });

    it('should include provider info when user has provider', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        phone: '+919876543210',
        name: 'Seller',
        profileComplete: true,
        providerId: 'prov-1',
        provider: {
          id: 'prov-1',
          name: 'Solar Provider',
          trustScore: 0.9,
        },
      });

      await authMiddleware(req, res, next);

      expect(req.user?.provider).toEqual({
        id: 'prov-1',
        name: 'Solar Provider',
        trustScore: 0.9,
      });
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should call next() without error when no token', async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const next = createMockNext();

      await optionalAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should populate req.user when valid token provided', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer valid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue({ userId: 'user-1' });
      (prisma.user.findUnique as jest.Mock).mockResolvedValue({
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test',
        profileComplete: true,
        providerId: null,
        provider: null,
      });

      await optionalAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeDefined();
      expect(req.user?.id).toBe('user-1');
    });

    it('should call next() and ignore errors for invalid token', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockResolvedValue(null);

      await optionalAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('should silently handle errors without failing', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer error-token' },
      });
      const res = createMockResponse();
      const next = createMockNext();

      (getSession as jest.Mock).mockRejectedValue(new Error('Redis error'));

      // Suppress console.warn for this test
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      await optionalAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
      expect(res.status).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('requireCompleteProfile', () => {
    it('should return 401 when req.user is undefined', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      requireCompleteProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should return 403 PROFILE_INCOMPLETE when profile not complete', () => {
      const req = createMockRequest();
      req.user = {
        id: 'user-1',
        phone: '+919876543210',
        name: null,
        profileComplete: false,
        providerId: null,
        provider: null,
      };
      const res = createMockResponse();
      const next = createMockNext();

      requireCompleteProfile(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Please complete your profile first',
        code: 'PROFILE_INCOMPLETE',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next() when profile is complete', () => {
      const req = createMockRequest();
      req.user = {
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test User',
        profileComplete: true,
        providerId: null,
        provider: null,
      };
      const res = createMockResponse();
      const next = createMockNext();

      requireCompleteProfile(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('requireProvider', () => {
    it('should return 401 when req.user is undefined', () => {
      const req = createMockRequest();
      const res = createMockResponse();
      const next = createMockNext();

      requireProvider(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    });

    it('should return 403 PROVIDER_REQUIRED when providerId is null', () => {
      const req = createMockRequest();
      req.user = {
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test',
        profileComplete: true,
        providerId: null,
        provider: null,
      };
      const res = createMockResponse();
      const next = createMockNext();

      requireProvider(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Seller profile required. Please set up your seller profile first.',
        code: 'PROVIDER_REQUIRED',
      });
    });

    it('should return 403 when provider object is null', () => {
      const req = createMockRequest();
      req.user = {
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test',
        profileComplete: true,
        providerId: 'prov-1', // Has providerId but no provider object
        provider: null,
      };
      const res = createMockResponse();
      const next = createMockNext();

      requireProvider(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should call next() when user has provider', () => {
      const req = createMockRequest();
      req.user = {
        id: 'user-1',
        phone: '+919876543210',
        name: 'Test',
        profileComplete: true,
        providerId: 'prov-1',
        provider: {
          id: 'prov-1',
          name: 'Test Provider',
          trustScore: 0.8,
        },
      };
      const res = createMockResponse();
      const next = createMockNext();

      requireProvider(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
