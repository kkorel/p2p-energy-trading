/**
 * Session Management Service
 * Handles session creation, validation, and cleanup
 */

import crypto from 'crypto';
import { prisma } from '../db/prisma';
import { redis } from '../db/redis';

// Session Configuration
export const SESSION_CONFIG = {
  tokenLength: 64, // 64 bytes = 128 hex chars
  expiryDays: parseInt(process.env.SESSION_EXPIRY_DAYS || '7'),
  refreshThresholdDays: 1, // Refresh if less than this many days left
};

// Redis key patterns
export const SESSION_REDIS_KEYS = {
  session: (token: string) => `session:${token}`,
  userSessions: (userId: string) => `user:sessions:${userId}`,
};

export interface SessionInfo {
  id: string;
  userId: string;
  token: string;
  deviceInfo?: string;
  ipAddress?: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateSessionOptions {
  userId: string;
  deviceInfo?: string;
  ipAddress?: string;
}

/**
 * Generate a secure session token
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_CONFIG.tokenLength).toString('hex');
}

/**
 * Create a new session
 */
export async function createSession(options: CreateSessionOptions): Promise<SessionInfo> {
  const { userId, deviceInfo, ipAddress } = options;
  
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_CONFIG.expiryDays * 24 * 60 * 60 * 1000);

  // Create session in database
  const session = await prisma.session.create({
    data: {
      userId,
      token,
      deviceInfo,
      ipAddress,
      expiresAt,
    },
  });

  // Cache session in Redis for fast lookups
  const sessionData = JSON.stringify({
    id: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt.toISOString(),
  });
  
  const ttlSeconds = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  await redis.setex(SESSION_REDIS_KEYS.session(token), ttlSeconds, sessionData);

  // Track user's sessions
  await redis.sadd(SESSION_REDIS_KEYS.userSessions(userId), token);

  return {
    id: session.id,
    userId: session.userId,
    token: session.token,
    deviceInfo: session.deviceInfo || undefined,
    ipAddress: session.ipAddress || undefined,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

/**
 * Validate and get session by token
 */
export async function getSession(token: string): Promise<SessionInfo | null> {
  // Try Redis first
  const cachedSession = await redis.get(SESSION_REDIS_KEYS.session(token));
  
  if (cachedSession) {
    const data = JSON.parse(cachedSession);
    const expiresAt = new Date(data.expiresAt);
    
    if (expiresAt > new Date()) {
      // Session is valid
      return {
        id: data.id,
        userId: data.userId,
        token,
        expiresAt,
        createdAt: new Date(), // Approximation for cached session
      };
    }
  }

  // Check database
  const session = await prisma.session.findUnique({
    where: { token },
  });

  if (!session) {
    return null;
  }

  // Check expiry
  if (session.expiresAt < new Date()) {
    // Session expired - clean up
    await deleteSession(token);
    return null;
  }

  // Re-cache in Redis
  const ttlSeconds = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
  if (ttlSeconds > 0) {
    const sessionData = JSON.stringify({
      id: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt.toISOString(),
    });
    await redis.setex(SESSION_REDIS_KEYS.session(token), ttlSeconds, sessionData);
  }

  return {
    id: session.id,
    userId: session.userId,
    token: session.token,
    deviceInfo: session.deviceInfo || undefined,
    ipAddress: session.ipAddress || undefined,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

/**
 * Refresh session if needed (extend expiry)
 */
export async function refreshSession(token: string): Promise<SessionInfo | null> {
  const session = await getSession(token);
  
  if (!session) {
    return null;
  }

  // Check if refresh is needed
  const remainingDays = (session.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
  
  if (remainingDays > SESSION_CONFIG.refreshThresholdDays) {
    // No refresh needed
    return session;
  }

  // Extend session
  const newExpiresAt = new Date(Date.now() + SESSION_CONFIG.expiryDays * 24 * 60 * 60 * 1000);

  await prisma.session.update({
    where: { token },
    data: { expiresAt: newExpiresAt },
  });

  // Update Redis cache
  const ttlSeconds = Math.floor((newExpiresAt.getTime() - Date.now()) / 1000);
  const sessionData = JSON.stringify({
    id: session.id,
    userId: session.userId,
    expiresAt: newExpiresAt.toISOString(),
  });
  await redis.setex(SESSION_REDIS_KEYS.session(token), ttlSeconds, sessionData);

  return {
    ...session,
    expiresAt: newExpiresAt,
  };
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(token: string): Promise<boolean> {
  // Get session to find user
  const session = await prisma.session.findUnique({
    where: { token },
  });

  // Delete from Redis
  await redis.del(SESSION_REDIS_KEYS.session(token));

  // Remove from user's sessions set
  if (session) {
    await redis.srem(SESSION_REDIS_KEYS.userSessions(session.userId), token);
  }

  // Delete from database
  const result = await prisma.session.deleteMany({
    where: { token },
  });

  return result.count > 0;
}

/**
 * Delete all sessions for a user (logout everywhere)
 */
export async function deleteAllUserSessions(userId: string): Promise<number> {
  // Get all user's sessions
  const sessions = await prisma.session.findMany({
    where: { userId },
    select: { token: true },
  });

  // Delete from Redis
  for (const session of sessions) {
    await redis.del(SESSION_REDIS_KEYS.session(session.token));
  }
  await redis.del(SESSION_REDIS_KEYS.userSessions(userId));

  // Delete from database
  const result = await prisma.session.deleteMany({
    where: { userId },
  });

  return result.count;
}

/**
 * Get all active sessions for a user
 */
export async function getUserSessions(userId: string): Promise<SessionInfo[]> {
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  return sessions.map(s => ({
    id: s.id,
    userId: s.userId,
    token: s.token,
    deviceInfo: s.deviceInfo || undefined,
    ipAddress: s.ipAddress || undefined,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
  }));
}

/**
 * Clean up expired sessions (call periodically)
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  return result.count;
}
