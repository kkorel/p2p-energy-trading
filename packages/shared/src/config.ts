/**
 * Shared Configuration
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root
const envPath = resolve(process.cwd(), '.env');
const dotenvResult = dotenvConfig({ path: envPath, override: true });
if (dotenvResult.error) {
  console.warn(`[config] Failed to load .env from ${envPath}:`, dotenvResult.error.message);
}

// Environment detection
export const isProduction = process.env.NODE_ENV === 'production';
export const isDevelopment = !isProduction;
export const isDevMode = process.env.DEV_MODE === 'true' || isDevelopment;

export const config = {
  // Environment
  env: {
    isProduction,
    isDevelopment,
    isDevMode,
    nodeEnv: process.env.NODE_ENV || 'development',
  },

  // Database configuration
  database: {
    url: process.env.DATABASE_URL ||
        'postgresql://p2p_user:p2p_password@localhost:5432/p2p_trading',
  },

  // Redis configuration
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Service ports
  ports: {
    bap: parseInt(process.env.BAP_PORT || '4000'),
    bpp: parseInt(process.env.BPP_PORT || '4002'),
    web: parseInt(process.env.WEB_PORT || '3000'),
  },

  // Service URLs (BAP and BPP now on same host)
  urls: {
    bap: process.env.BAP_URL || 'http://localhost:4000',
    bpp: process.env.BPP_URL || 'http://localhost:4000',
  },

  // External Beckn services (always uses external CDS - no toggle)
  external: {
    // Catalog Discovery Service (Beckn network CDS)
    // EXTERNAL_CDS_URL typically ends with /catalog for publish, /beckn for discover
    cds: process.env.EXTERNAL_CDS_URL || 'https://34.93.141.21.sslip.io/beckn/catalog',
    // DEG Ledger for immutable trade records
    ledger: process.env.LEDGER_URL || 'https://34.93.166.38.sslip.io',
    // Verifiable Credentials portal
    vcPortal: process.env.VC_PORTAL_URL || 'https://open-vcs.up.railway.app',
    // Enable ledger writes (disable for local dev)
    enableLedgerWrites: process.env.ENABLE_LEDGER_WRITES === 'true',
  },

  // Verifiable Credentials configuration
  vc: {
    // Trusted issuer DIDs for VC verification
    trustedIssuers: (process.env.VC_TRUSTED_ISSUERS || '').split(',').filter(Boolean),
    // Whether to require cryptographic proof verification
    requireProofVerification: process.env.VC_REQUIRE_PROOF === 'true',
    // VC Portal API key (if required)
    portalApiKey: process.env.VC_PORTAL_API_KEY || '',
  },

  // BAP identity
  bap: {
    id: process.env.BAP_ID || 'bap.p2p-trading.local',
    uri: process.env.BAP_URI || 'http://localhost:4000',
  },

  // BPP identity (now on same host as BAP)
  bpp: {
    id: process.env.BPP_ID || 'bpp.p2p-trading.local',
    uri: process.env.BPP_URI || 'http://localhost:4000',
  },

  // CDS identity (external Beckn network CDS)
  cds: {
    id: process.env.CDS_ID || 'cds.beckn-energy.network',
    uri: process.env.CDS_URI || 'https://34.93.141.21.sslip.io/beckn',
  },

  // Callback delay (ms) - simulates async processing
  callbackDelay: parseInt(process.env.CALLBACK_DELAY || '100'),

  // Matching algorithm configuration
  matching: {
    weights: {
      price: parseFloat(process.env.MATCH_WEIGHT_PRICE || '0.40'),
      trust: parseFloat(process.env.MATCH_WEIGHT_TRUST || '0.35'),
      timeWindowFit: parseFloat(process.env.MATCH_WEIGHT_TIME || '0.25'),
    },
    minTrustThreshold: parseFloat(process.env.MIN_TRUST_THRESHOLD || '0.2'),
    defaultTrustScore: parseFloat(process.env.DEFAULT_TRUST_SCORE || '0.5'),
  },

  // Platform fees
  fees: {
    platformRate: parseFloat(process.env.PLATFORM_FEE_RATE || '0.025'),
    cancellationPenalty: parseFloat(process.env.CANCELLATION_PENALTY_RATE || '0.10'),
    sellerCancellationPenalty: parseFloat(process.env.SELLER_CANCEL_PENALTY_RATE || '0.05'),
  },

  // Utility (DISCOM) identity for CDS publishing
  utility: {
    id: process.env.UTILITY_ID || 'BESCOM-KA',
  },

  // DISCOM configuration
  discom: {
    ratePerKwh: parseFloat(process.env.DISCOM_RATE_PER_KWH || '10'),
    checkIntervalMs: parseInt(process.env.DISCOM_CHECK_INTERVAL_MS || '60000'),
    successRate: parseFloat(process.env.DISCOM_SUCCESS_RATE || '0.85'),
  },

  // Cancellation settings
  cancellation: {
    windowMinutes: parseInt(process.env.CANCEL_WINDOW_MINUTES || '30'),
  },

  // Session configuration
  session: {
    expiryDays: parseInt(process.env.SESSION_EXPIRY_DAYS || '7'),
  },
};

/**
 * Validate required environment variables for production
 */
export function validateEnv(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (isProduction) {
    // Required in production
    if (!process.env.DATABASE_URL) errors.push('DATABASE_URL is required in production');
    if (!process.env.REDIS_URL) errors.push('REDIS_URL is required in production');
    // Warn about optional but recommended
    if (!process.env.OPENROUTER_API_KEY) {
      console.warn('Warning: OPENROUTER_API_KEY not set - meter PDF analysis will be disabled');
    }
  }

  return { valid: errors.length === 0, errors };
}
