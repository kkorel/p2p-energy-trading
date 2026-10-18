/**
 * Authentication Middleware
 * Protects routes that require authentication
 */

import { Request, Response, NextFunction } from 'express';
import { prisma, getSession, refreshSession } from '@p2p/shared';

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        phone: string;
        name: string | null;
        profileComplete: boolean;
        providerId: string | null;
        provider?: {
          id: string;
          name: string;
          trustScore: number;
        } | null;
      };
      sessionToken?: string;
    }
  }
}

/**
 * Extract token from Authorization header
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return null;
  }

  // Support "Bearer <token>" format
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Support raw token
  return authHeader;
}

/**
 * Main authentication middleware
 * Validates session token and attaches user to request
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ 
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED' 
    });
    return;
  }

  try {
    // Validate session
    const session = await getSession(token);

    if (!session) {
      res.status(401).json({ 
        success: false,
        error: 'Invalid or expired session',
        code: 'SESSION_INVALID' 
      });
      return;
    }

    // Refresh session if needed (extends expiry)
    await refreshSession(token);

    // Get user with provider info
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            trustScore: true,
          },
        },
      },
    });

    if (!user) {
      res.status(401).json({ 
        success: false,
        error: 'User not found',
        code: 'USER_NOT_FOUND' 
      });
      return;
    }

    // Attach user to request
    req.user = {
      id: user.id,
      phone: user.phone,
      name: user.name,
      profileComplete: user.profileComplete,
      providerId: user.providerId,
      provider: user.provider,
    };
    req.sessionToken = token;

    next();
  } catch (error: any) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication error',
      code: 'AUTH_ERROR'
    });
  }
}

/**
 * Optional auth middleware
 * Attaches user if token present, but doesn't require it
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    next();
    return;
  }

  try {
    const session = await getSession(token);

    if (session) {
      await refreshSession(token);

      const user = await prisma.user.findUnique({
        where: { id: session.userId },
        include: {
          provider: {
            select: {
              id: true,
              name: true,
              trustScore: true,
            },
          },
        },
      });

      if (user) {
        req.user = {
          id: user.id,
          phone: user.phone,
          name: user.name,
          profileComplete: user.profileComplete,
          providerId: user.providerId,
          provider: user.provider,
        };
        req.sessionToken = token;
      }
    }
  } catch (error) {
    // Ignore errors in optional auth
    console.warn('Optional auth error (ignored):', error);
  }

  next();
}

/**
 * Require complete profile middleware
 * Must be used after authMiddleware
 */
export function requireCompleteProfile(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ 
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED' 
    });
    return;
  }

  if (!req.user.profileComplete) {
    res.status(403).json({ 
      success: false,
      error: 'Please complete your profile first',
      code: 'PROFILE_INCOMPLETE' 
    });
    return;
  }

  next();
}

/**
 * Require provider profile middleware
 * Ensures user has set up a provider (seller) profile
 */
export function requireProvider(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ 
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED' 
    });
    return;
  }

  if (!req.user.providerId || !req.user.provider) {
    res.status(403).json({ 
      success: false,
      error: 'Seller profile required. Please set up your seller profile first.',
      code: 'PROVIDER_REQUIRED' 
    });
    return;
  }

  next();
}

