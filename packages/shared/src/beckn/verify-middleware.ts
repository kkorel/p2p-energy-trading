/**
 * Beckn Signature Verification Middleware
 * 
 * Express middleware to verify incoming Beckn messages are properly signed.
 * Implements the Beckn HTTP signature verification spec.
 */

import { Request, Response, NextFunction } from 'express';
import { verifySignature, parseAuthorizationHeader, registerPublicKey, getPublicKey } from './signing';
import { createLogger } from '../utils/logger';

const logger = createLogger('BECKN-VERIFY');

// Configuration
interface VerificationConfig {
  enabled: boolean;
  allowUnsigned: boolean;  // Allow unsigned requests (for development)
  trustAllKeys: boolean;   // Skip key lookup, trust any valid signature
  maxClockSkew: number;    // Maximum clock skew in seconds
}

// Registry of known public keys (subscriber_id -> public_key)
const knownPublicKeys: Map<string, string> = new Map();

let verificationConfig: VerificationConfig = {
  enabled: false,
  allowUnsigned: true,
  trustAllKeys: false,
  maxClockSkew: 60, // 1 minute
};

/**
 * Initialize the verification middleware
 */
export function initializeVerification(config: Partial<VerificationConfig> = {}): void {
  verificationConfig = {
    ...verificationConfig,
    ...config,
    enabled: config.enabled ?? (process.env.BECKN_VERIFY_SIGNATURES === 'true'),
    allowUnsigned: config.allowUnsigned ?? (process.env.BECKN_ALLOW_UNSIGNED !== 'false'),
  };
  
  logger.info('Beckn signature verification initialized', {
    enabled: verificationConfig.enabled,
    allowUnsigned: verificationConfig.allowUnsigned,
    trustAllKeys: verificationConfig.trustAllKeys,
  });
}

/**
 * Register a known subscriber's public key
 * In production, these would come from the Beckn registry
 */
export function registerSubscriberKey(subscriberId: string, publicKeyBase64: string): void {
  knownPublicKeys.set(subscriberId, publicKeyBase64);
  registerPublicKey(`${subscriberId}|key1|ed25519`, publicKeyBase64);
  logger.info('Registered subscriber public key', { subscriberId });
}

/**
 * Get registered public keys (for debugging)
 */
export function getRegisteredKeys(): string[] {
  return Array.from(knownPublicKeys.keys());
}

/**
 * Express middleware to verify Beckn message signatures
 * 
 * Usage:
 *   app.post('/callbacks/*', verifyBecknSignature, handler);
 */
export function verifyBecknSignature(req: Request, res: Response, next: NextFunction): void {
  // Skip if verification is disabled
  if (!verificationConfig.enabled) {
    next();
    return;
  }
  
  const authHeader = req.headers.authorization as string | undefined;
  const gatewayAuthHeader = req.headers['x-gateway-authorization'] as string | undefined;
  const digestHeader = req.headers.digest as string | undefined;
  
  // Check if request has signature headers
  const hasSignature = authHeader?.startsWith('Signature ');
  
  if (!hasSignature) {
    if (verificationConfig.allowUnsigned) {
      logger.debug('Unsigned request allowed (dev mode)', { 
        path: req.path,
        method: req.method 
      });
      next();
      return;
    }
    
    logger.warn('Request rejected: missing signature', { path: req.path });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'MISSING_SIGNATURE',
        message: 'Request must include Authorization header with Beckn signature',
      },
    });
    return;
  }
  
  // Parse the signature
  const components = parseAuthorizationHeader(authHeader);
  if (!components) {
    logger.warn('Request rejected: invalid signature format', { path: req.path });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'INVALID_SIGNATURE_FORMAT',
        message: 'Authorization header has invalid Beckn signature format',
      },
    });
    return;
  }
  
  // Check signature expiration with clock skew tolerance
  const now = Math.floor(Date.now() / 1000);
  if (now > components.expires + verificationConfig.maxClockSkew) {
    logger.warn('Request rejected: signature expired', { 
      path: req.path,
      expires: components.expires,
      now 
    });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'SIGNATURE_EXPIRED',
        message: 'Request signature has expired',
      },
    });
    return;
  }
  
  // Extract subscriber ID from keyId (format: subscriber_id|unique_key_id|algorithm)
  const keyIdParts = components.keyId.split('|');
  if (keyIdParts.length < 2) {
    logger.warn('Request rejected: invalid keyId format', { 
      path: req.path,
      keyId: components.keyId 
    });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'INVALID_KEY_ID',
        message: 'Key ID must be in format: subscriber_id|unique_key_id|algorithm',
      },
    });
    return;
  }
  
  const subscriberId = keyIdParts[0];
  
  // Look up public key
  let publicKey = getPublicKey(components.keyId);
  
  if (!publicKey && !verificationConfig.trustAllKeys) {
    // Try to look up by subscriber ID
    publicKey = knownPublicKeys.get(subscriberId) || undefined;
  }
  
  if (!publicKey) {
    if (verificationConfig.trustAllKeys) {
      // In trust-all mode, we can't verify but we don't reject
      logger.debug('Unknown subscriber, skipping verification (trust-all mode)', { 
        subscriberId 
      });
      next();
      return;
    }
    
    logger.warn('Request rejected: unknown subscriber', { 
      path: req.path,
      subscriberId,
      keyId: components.keyId 
    });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'UNKNOWN_SUBSCRIBER',
        message: `Public key for subscriber ${subscriberId} not registered`,
      },
    });
    return;
  }
  
  // Verify the signature
  const body = req.body;
  const result = verifySignature(authHeader, body, publicKey);
  
  if (!result.valid) {
    logger.warn('Request rejected: signature verification failed', { 
      path: req.path,
      keyId: components.keyId,
      error: result.error 
    });
    res.status(401).json({
      error: {
        type: 'AUTHENTICATION_ERROR',
        code: 'SIGNATURE_INVALID',
        message: result.error || 'Signature verification failed',
      },
    });
    return;
  }
  
  // Signature is valid - attach verification info to request
  (req as any).becknVerification = {
    verified: true,
    subscriberId,
    keyId: components.keyId,
    timestamp: components.created,
  };
  
  logger.debug('Signature verified', { 
    path: req.path,
    subscriberId,
    keyId: components.keyId 
  });
  
  next();
}

/**
 * Middleware that logs signature status but doesn't enforce
 * Useful for monitoring/debugging signature adoption
 */
export function logBecknSignature(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization as string | undefined;
  const hasSignature = authHeader?.startsWith('Signature ');
  
  if (hasSignature) {
    const components = parseAuthorizationHeader(authHeader);
    logger.info('Beckn request with signature', {
      path: req.path,
      keyId: components?.keyId,
      created: components?.created,
      expires: components?.expires,
    });
  } else {
    logger.debug('Beckn request without signature', { path: req.path });
  }
  
  next();
}
