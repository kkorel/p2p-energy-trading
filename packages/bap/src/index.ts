/**
 * Combined Prosumer Application - BAP (Consumer) + BPP (Provider)
 * Single Express server hosting both buyer and seller functionality
 * 
 * Implements Beckn Protocol v2 security measures:
 * - Helmet for HTTP security headers
 * - CORS configuration
 * - Rate limiting
 * - Request validation
 * - Cryptographic signing (optional, enabled via env)
 */

import express from 'express';
import path from 'path';
import {
  config,
  createLogger,
  validateEnv,
  applySecurityMiddleware,
  initializeSecureClient,
  initializeBppKeys,
  initializeVerification,
  validateBecknMessage,
  logBecknSignature,
} from '@p2p/shared';
import routes from './routes';
import callbacks from './callbacks';
import sellerRoutes from './seller-routes';
import authRoutes from './auth-routes';
import chatRoutes from './chat-routes';
import { initDb, closeDb, checkDbHealth } from './db';
import { startDiscomMockService, stopDiscomMockService } from './discom-mock';
import { startTelegramBot, stopTelegramBot } from './chat/telegram';
import { startWhatsAppBot, stopWhatsAppBot } from './chat/whatsapp';
import { initAutoTradeScheduler, isSchedulerInitialized } from './auto-trade';

const app = express();
const logger = createLogger('PROSUMER');
const PORT = config.ports.bap;

// Apply security middleware (helmet, cors, rate limiting)
applySecurityMiddleware(app, {
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || '*',
  corsCredentials: true,
  rateLimitWindowMs: 15 * 60 * 1000, // 15 minutes
  rateLimitMax: 1000,                 // 1000 requests per window
  trustedProxies: 1,
});

// JSON body parser with size limit
// Note: 10mb limit needed because 5MB PDF files become ~6.67MB after base64 encoding
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Authentication routes (public - no auth required for login/OTP)
app.use('/auth', authRoutes);

// Chat routes (Oorja agent — web chat interface)
app.use('/chat', chatRoutes);

// Consumer API routes (BAP)
app.use('/', routes);

// BAP Callback endpoints for receiving async responses from BPP/CDS
// Mount at BOTH root (for DeDi: bap.digioorga.org) and /callbacks (legacy)
app.use('/', callbacks);           // DeDi registration: bap.digioorga.org → /on_select, /on_init, etc.
app.use('/callbacks', callbacks);  // Legacy: /callbacks/on_select, etc.

// BPP Protocol routes - Beckn action handlers (select, init, confirm, etc.)
// Mount at BOTH /callbacks (for DeDi: bpp.digioorga.org/callbacks) and root (legacy)
app.use('/callbacks', sellerRoutes);  // DeDi registration: bpp.digioorga.org/callbacks → /callbacks/select
app.use('/', sellerRoutes);           // Legacy: /select, /init, etc.

// Health check - verifies database and cache connectivity
app.get('/health', async (req, res) => {
  try {
    const health = await checkDbHealth();
    const isHealthy = health.postgres && health.redis;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      service: 'prosumer',
      roles: ['bap', 'bpp'],
      postgres: health.postgres ? 'connected' : 'disconnected',
      redis: health.redis ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'error',
      service: 'prosumer',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    });
  }
});

// Serve frontend for all non-API routes (SPA fallback)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/callbacks') ||
    req.path.startsWith('/auth') || req.path.startsWith('/seller') ||
    req.path.startsWith('/chat') ||
    req.path.startsWith('/select') || req.path.startsWith('/init') ||
    req.path.startsWith('/confirm') || req.path.startsWith('/status') ||
    req.path === '/health') {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start server after DB initialization
async function start() {
  try {
    // Validate environment configuration
    const envValidation = validateEnv();
    if (!envValidation.valid) {
      logger.error('Environment validation failed:');
      envValidation.errors.forEach(err => logger.error(`  - ${err}`));
      process.exit(1);
    }

    // Log environment mode
    logger.info(`Starting in ${config.env.nodeEnv} mode (DEV_MODE=${config.env.isDevMode})`);

    // Initialize Beckn signing (for outgoing requests)
    // Supports dual keys: BAP keys for buyer operations, BPP keys for seller operations
    const signingEnabled = process.env.BECKN_SIGNING_ENABLED === 'true';
    if (signingEnabled) {
      // Load BAP key pair from environment variables (BECKN_* vars)
      let bapKeyPair = undefined;
      if (process.env.BECKN_KEY_ID && process.env.BECKN_PUBLIC_KEY && process.env.BECKN_PRIVATE_KEY) {
        bapKeyPair = {
          keyId: process.env.BECKN_KEY_ID,
          publicKey: process.env.BECKN_PUBLIC_KEY,
          privateKey: process.env.BECKN_PRIVATE_KEY,
        };
        logger.info('Loaded BAP signing keys from environment', {
          keyId: bapKeyPair.keyId,
          publicKeyPreview: bapKeyPair.publicKey.substring(0, 20) + '...'
        });
      } else {
        logger.warn('BAP keys not found in environment, will generate new ones (NOT RECOMMENDED for production)');
      }

      const loadedBapKeyPair = initializeSecureClient({
        keyPair: bapKeyPair,
        enabled: true,
        ttlSeconds: parseInt(process.env.BECKN_SIGNATURE_TTL || '30', 10),
      });
      logger.info('BAP message signing enabled', { keyId: loadedBapKeyPair.keyId });

      // Load BPP key pair from environment variables (BPP_KEY_ID, BPP_PUBLIC_KEY, BPP_PRIVATE_KEY)
      // Used for catalog_publish and other seller operations
      if (process.env.BPP_KEY_ID && process.env.BPP_PUBLIC_KEY && process.env.BPP_PRIVATE_KEY) {
        const bppKeyPair = {
          keyId: process.env.BPP_KEY_ID,
          publicKey: process.env.BPP_PUBLIC_KEY,
          privateKey: process.env.BPP_PRIVATE_KEY,
        };
        initializeBppKeys(bppKeyPair);
        logger.info('Loaded BPP signing keys from environment', {
          keyId: bppKeyPair.keyId,
          publicKeyPreview: bppKeyPair.publicKey.substring(0, 20) + '...'
        });
      } else {
        logger.warn('BPP keys not found (BPP_KEY_ID, BPP_PUBLIC_KEY, BPP_PRIVATE_KEY) - catalog_publish will use BAP keys');
      }
    } else {
      logger.info('Beckn message signing disabled (set BECKN_SIGNING_ENABLED=true to enable)');
    }

    // Initialize Beckn signature verification (for incoming requests)
    const verificationEnabled = process.env.BECKN_VERIFY_SIGNATURES === 'true';
    initializeVerification({
      enabled: verificationEnabled,
      allowUnsigned: !verificationEnabled, // Allow unsigned in dev mode
    });
    logger.info(`Beckn signature verification: ${verificationEnabled ? 'ENABLED' : 'DISABLED (dev mode)'}`);

    await initDb();
    logger.info('Database and Redis connections initialized');

    const server = app.listen(PORT, () => {
      logger.info(`Prosumer app running on port ${PORT}`);
      logger.info(`CDS URL: ${config.external.cds}`);
      logger.info(`Roles: Consumer (BAP) + Provider (BPP)`);
      logger.info(`Matching weights: price=${config.matching.weights.price}, trust=${config.matching.weights.trust}, time=${config.matching.weights.timeWindowFit}`);
      logger.info(`Security: Helmet=ON, CORS=ON, RateLimit=ON`);

      // Start DISCOM mock service for trust score verification
      startDiscomMockService();

      // Start Telegram bot (only if token is configured)
      startTelegramBot().catch(err => logger.error(`Telegram bot startup error: ${err.message}`));

      // Start WhatsApp bot (only if WHATSAPP_ENABLED=true)
      startWhatsAppBot().catch(err => logger.error(`WhatsApp bot startup error: ${err.message}`));

      // Initialize auto-trade scheduler (daily seller/buyer auto-trades)
      initAutoTradeScheduler();
      if (isSchedulerInitialized()) {
        logger.info('Auto-trade scheduler initialized (6:00 AM seller, 6:30 AM buyer, 7:00 AM advisories)');
      }
    });

    // Graceful shutdown handler
    async function shutdown(signal: string) {
      logger.info(`${signal} received, shutting down gracefully...`);

      server.close(async () => {
        try {
          stopDiscomMockService();
          stopTelegramBot();
          stopWhatsAppBot();
          await closeDb();
          logger.info('Database connections closed');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown:', error);
          process.exit(1);
        }
      });

      // Force exit after timeout
      setTimeout(() => {
        logger.warn('Forcing shutdown after timeout');
        process.exit(1);
      }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error: any) {
    logger.error('Failed to initialize:', error?.message || error);
    if (error?.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

start().catch(err => {
  logger.error(`Failed to start: ${err.message}`);
  process.exit(1);
});

export default app;
