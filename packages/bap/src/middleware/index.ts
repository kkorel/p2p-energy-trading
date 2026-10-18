/**
 * Middleware Exports
 */

export {
  authMiddleware,
  optionalAuthMiddleware,
  requireCompleteProfile,
  requireProvider,
} from './auth';

import { Request, Response, NextFunction } from 'express';
import { config } from '@p2p/shared';

/**
 * Middleware to protect endpoints that should only be available in development/demo mode
 */
export function devModeOnly(req: Request, res: Response, next: NextFunction) {
  if (!config.env.isDevMode) {
    return res.status(403).json({
      error: 'This endpoint is only available in development mode',
      hint: 'Set DEV_MODE=true in your environment to enable demo features',
    });
  }
  next();
}

/**
 * Middleware to protect admin/dangerous endpoints
 */
export function adminOnly(req: Request, res: Response, next: NextFunction) {
  // In production, these endpoints should require admin authentication
  // For now, we just disable them in production unless DEV_MODE is explicitly true
  if (config.env.isProduction && !config.env.isDevMode) {
    return res.status(403).json({
      error: 'This endpoint is not available in production',
    });
  }
  next();
}
