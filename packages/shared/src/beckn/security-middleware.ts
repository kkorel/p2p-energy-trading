/**
 * Beckn Protocol Security Middleware
 * 
 * Implements security measures as per Beckn sandbox and protocol specifications:
 * - Helmet for HTTP security headers
 * - CORS configuration
 * - Rate limiting to prevent abuse
 * - Request validation
 * - Logging of security events
 */

import { Request, Response, NextFunction, Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createLogger } from '../utils/logger';

const logger = createLogger('SECURITY');

// Configuration interface
export interface SecurityConfig {
  // CORS
  corsOrigins?: string[] | string;
  corsCredentials?: boolean;
  
  // Rate limiting
  rateLimitWindowMs?: number;  // Time window in ms
  rateLimitMax?: number;       // Max requests per window
  rateLimitMessage?: string;
  
  // Helmet
  helmetOptions?: Parameters<typeof helmet>[0];
  
  // Request size
  maxRequestSize?: string;
  
  // Beckn-specific
  enableBecknValidation?: boolean;
  trustedProxies?: number;
}

const defaultConfig: SecurityConfig = {
  corsOrigins: '*',
  corsCredentials: true,
  rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
  rateLimitMax: 1000,                 // 1000 requests per 15 minutes
  rateLimitMessage: 'Too many requests, please try again later',
  maxRequestSize: '5mb',
  enableBecknValidation: true,
  trustedProxies: 1,
};

/**
 * Configure CORS middleware
 */
export function configureCors(config: SecurityConfig = {}): ReturnType<typeof cors> {
  const origins = config.corsOrigins || defaultConfig.corsOrigins;
  
  return cors({
    origin: origins,
    credentials: config.corsCredentials ?? defaultConfig.corsCredentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Gateway-Authorization',
      'Digest',
      'X-Request-ID',
      'X-Correlation-ID',
    ],
    exposedHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 86400, // 24 hours
  });
}

/**
 * Configure Helmet middleware for HTTP security headers
 * Matches the Beckn sandbox configuration
 */
export function configureHelmet(config: SecurityConfig = {}): ReturnType<typeof helmet> {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com', 'https://www.googleapis.com'],
        frameSrc: ["'self'", 'https://accounts.google.com'],
      },
    },
    crossOriginEmbedderPolicy: false, // Allow embedding
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    ...config.helmetOptions,
  });
}

/**
 * Configure rate limiting middleware
 */
export function configureRateLimit(config: SecurityConfig = {}): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: config.rateLimitWindowMs || defaultConfig.rateLimitWindowMs!,
    max: config.rateLimitMax || defaultConfig.rateLimitMax!,
    message: {
      error: {
        type: 'RATE_LIMIT_EXCEEDED',
        code: 'TOO_MANY_REQUESTS',
        message: config.rateLimitMessage || defaultConfig.rateLimitMessage,
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Use default keyGenerator (handles IPv6 correctly)
    skip: (req: Request) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
    handler: (req: Request, res: Response) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        method: req.method,
      });
      res.status(429).json({
        error: {
          type: 'RATE_LIMIT_EXCEEDED',
          code: 'TOO_MANY_REQUESTS',
          message: config.rateLimitMessage || defaultConfig.rateLimitMessage,
        },
      });
    },
    // Disable validation for custom keyGenerator since we're using default
    validate: { xForwardedForHeader: false },
  });
}

/**
 * Stricter rate limit for authentication endpoints
 */
export function configureAuthRateLimit(): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,                   // 10 attempts per 15 minutes
    message: {
      error: {
        type: 'RATE_LIMIT_EXCEEDED',
        code: 'TOO_MANY_AUTH_ATTEMPTS',
        message: 'Too many authentication attempts. Please try again in 15 minutes.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      // Rate limit by phone/email + IP
      const identifier = req.body?.phoneNumber || req.body?.email || '';
      return `${identifier}:${req.ip}`;
    },
    handler: (req: Request, res: Response) => {
      logger.warn('Auth rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        identifier: req.body?.phoneNumber || req.body?.email,
      });
      res.status(429).json({
        error: {
          type: 'RATE_LIMIT_EXCEEDED',
          code: 'TOO_MANY_AUTH_ATTEMPTS',
          message: 'Too many authentication attempts. Please try again in 15 minutes.',
        },
      });
    },
  });
}

/**
 * Beckn message structure validation middleware
 * Ensures incoming Beckn messages have required fields
 */
export function validateBecknMessage(req: Request, res: Response, next: NextFunction): void {
  const { context, message } = req.body;
  
  // Check for required context fields
  if (!context) {
    logger.warn('Missing context in Beckn message', { path: req.path });
    res.status(400).json({
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'PROTOCOL_ERROR',
        code: 'MISSING_CONTEXT',
        message: 'Beckn message must include context object',
      },
    });
    return;
  }
  
  // Required context fields per Beckn spec
  const requiredFields = ['action', 'transaction_id', 'message_id', 'timestamp'];
  const missingFields = requiredFields.filter(field => !context[field]);
  
  if (missingFields.length > 0) {
    logger.warn('Missing required context fields', { 
      path: req.path,
      missingFields,
    });
    res.status(400).json({
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'PROTOCOL_ERROR',
        code: 'INVALID_CONTEXT',
        message: `Missing required context fields: ${missingFields.join(', ')}`,
      },
    });
    return;
  }
  
  // Validate timestamp is ISO 8601
  const timestamp = new Date(context.timestamp);
  if (isNaN(timestamp.getTime())) {
    res.status(400).json({
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'PROTOCOL_ERROR',
        code: 'INVALID_TIMESTAMP',
        message: 'Context timestamp must be valid ISO 8601 format',
      },
    });
    return;
  }
  
  // Check timestamp is not too old (5 minutes) or in future (1 minute tolerance)
  const now = Date.now();
  const msgTime = timestamp.getTime();
  const maxAge = 5 * 60 * 1000; // 5 minutes
  const futureTolerance = 60 * 1000; // 1 minute
  
  if (msgTime < now - maxAge) {
    logger.warn('Beckn message timestamp too old', {
      path: req.path,
      messageTime: context.timestamp,
      age: now - msgTime,
    });
    res.status(400).json({
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'PROTOCOL_ERROR',
        code: 'STALE_MESSAGE',
        message: 'Message timestamp is too old (max 5 minutes)',
      },
    });
    return;
  }
  
  if (msgTime > now + futureTolerance) {
    res.status(400).json({
      message: {
        ack: { status: 'NACK' },
      },
      error: {
        type: 'PROTOCOL_ERROR',
        code: 'FUTURE_TIMESTAMP',
        message: 'Message timestamp is in the future',
      },
    });
    return;
  }
  
  next();
}

/**
 * Request ID middleware - adds unique ID to each request for tracing
 */
export function addRequestId(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers['x-request-id'] as string || 
                    `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  (req as any).requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  next();
}

/**
 * Security event logging middleware
 */
export function logSecurityEvents(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  
  // Log request
  logger.debug('Incoming request', {
    requestId: (req as any).requestId,
    method: req.method,
    path: req.path,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    hasAuth: !!req.headers.authorization,
  });
  
  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'debug';
    
    logger[logLevel]('Request completed', {
      requestId: (req as any).requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    });
  });
  
  next();
}

/**
 * Apply all security middleware to an Express app
 */
export function applySecurityMiddleware(app: Express, config: SecurityConfig = {}): void {
  // Trust proxy (important for rate limiting behind reverse proxy)
  app.set('trust proxy', config.trustedProxies || defaultConfig.trustedProxies);
  
  // Add request ID first
  app.use(addRequestId);
  
  // Security event logging
  app.use(logSecurityEvents);
  
  // Helmet security headers
  app.use(configureHelmet(config));
  
  // CORS
  app.use(configureCors(config));
  
  // Rate limiting
  app.use(configureRateLimit(config));
  
  logger.info('Security middleware applied', {
    helmet: true,
    cors: true,
    rateLimit: {
      windowMs: config.rateLimitWindowMs || defaultConfig.rateLimitWindowMs,
      max: config.rateLimitMax || defaultConfig.rateLimitMax,
    },
  });
}

/**
 * Export individual components for selective use
 */
export {
  helmet,
  cors,
  rateLimit,
};
