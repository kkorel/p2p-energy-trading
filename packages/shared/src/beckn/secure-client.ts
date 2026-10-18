/**
 * Secure Beckn HTTP Client
 *
 * Wraps axios with automatic message signing for Beckn protocol compliance.
 * All outgoing Beckn messages are signed using Ed25519.
 *
 * Supports dual key pairs:
 * - BAP keys for buyer operations (search, select, init, confirm)
 * - BPP keys for seller operations (catalog_publish, on_search callbacks)
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BecknKeyPair, createSignedHeaders, generateKeyPair } from './signing';
import { createLogger } from '../utils/logger';

const logger = createLogger('BECKN-CLIENT');

// Configuration for signing
interface SecureClientConfig {
  keyPair: BecknKeyPair;
  enabled: boolean;  // Allow disabling for testing
  ttlSeconds?: number;
}

// Dual key pairs - BAP for buyer operations, BPP for seller operations
let bapKeyPair: BecknKeyPair | null = null;
let bppKeyPair: BecknKeyPair | null = null;
// Default to BAP key pair for backward compatibility
let clientKeyPair: BecknKeyPair | null = null;
let signingEnabled = false;
let signatureTtl = 30; // seconds

/**
 * Initialize the secure client with a key pair (BAP keys - default)
 * Call this at service startup
 */
export function initializeSecureClient(config: Partial<SecureClientConfig> = {}): BecknKeyPair {
  if (config.keyPair) {
    clientKeyPair = config.keyPair;
    bapKeyPair = config.keyPair;
  } else if (!clientKeyPair) {
    // Generate a new key pair if none exists
    // In production, this should be loaded from secure storage/env
    const subscriberId = process.env.BECKN_SUBSCRIBER_ID || 'p2p-energy-bap';
    clientKeyPair = generateKeyPair(subscriberId);
    bapKeyPair = clientKeyPair;
    logger.info('Generated new Beckn signing key pair', {
      keyId: clientKeyPair.keyId,
      publicKey: clientKeyPair.publicKey.substring(0, 20) + '...'
    });
  }

  signingEnabled = config.enabled ?? (process.env.BECKN_SIGNING_ENABLED === 'true');
  signatureTtl = config.ttlSeconds ?? parseInt(process.env.BECKN_SIGNATURE_TTL || '30', 10);

  logger.info('Secure Beckn client initialized (BAP)', {
    signingEnabled,
    signatureTtl,
    keyId: clientKeyPair.keyId
  });

  return clientKeyPair;
}

/**
 * Initialize BPP key pair for seller operations (catalog_publish, etc.)
 * Call this at service startup after initializeSecureClient
 */
export function initializeBppKeys(keyPair: BecknKeyPair): void {
  bppKeyPair = keyPair;
  logger.info('BPP signing keys initialized', {
    keyId: keyPair.keyId,
    publicKeyPreview: keyPair.publicKey.substring(0, 20) + '...'
  });
}

/**
 * Get the BPP key pair for seller operations
 */
export function getBppKeyPair(): BecknKeyPair | null {
  return bppKeyPair;
}

/**
 * Get the BAP key pair for buyer operations
 */
export function getBapKeyPair(): BecknKeyPair | null {
  return bapKeyPair;
}

/**
 * Get the current public key for registration with Beckn registry
 */
export function getPublicKey(): string | null {
  return clientKeyPair?.publicKey || null;
}

/**
 * Get the current key ID
 */
export function getKeyId(): string | null {
  return clientKeyPair?.keyId || null;
}

/**
 * Get the current key pair for signing
 * Returns null if not initialized
 */
export function getKeyPair(): BecknKeyPair | null {
  return clientKeyPair;
}

/**
 * Check if signing is enabled
 */
export function isSigningEnabled(): boolean {
  return signingEnabled && clientKeyPair !== null;
}

/**
 * Make a signed POST request to a Beckn endpoint (uses BAP keys by default)
 */
export async function signedPost<T = any>(
  url: string,
  body: object,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  return signedPostWithKey<T>(url, body, clientKeyPair, config);
}

/**
 * Make a signed POST request using BPP keys (for catalog_publish, etc.)
 */
export async function signedPostAsBpp<T = any>(
  url: string,
  body: object,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  const keyPair = bppKeyPair || clientKeyPair; // Fall back to BAP keys if BPP not configured
  return signedPostWithKey<T>(url, body, keyPair, config);
}

/**
 * Make a signed POST request with a specific key pair
 */
export async function signedPostWithKey<T = any>(
  url: string,
  body: object,
  keyPair: BecknKeyPair | null,
  config?: AxiosRequestConfig
): Promise<AxiosResponse<T>> {
  // Build headers
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(config?.headers as Record<string, string> || {}),
  };

  // Add signature headers if signing is enabled
  if (signingEnabled && keyPair) {
    try {
      const signedHeaders = createSignedHeaders(body, keyPair, signatureTtl);
      headers = { ...headers, ...signedHeaders };
      logger.debug('Added signature headers to request', {
        url,
        keyId: keyPair.keyId
      });
    } catch (error: any) {
      logger.error('Failed to sign request, sending unsigned', {
        url,
        error: error.message
      });
    }
  }

  return axios.post<T>(url, body, { ...config, headers });
}

/**
 * Create a pre-configured axios instance with signing middleware
 * @param useBppKeys - If true, uses BPP keys for signing (for catalog_publish)
 */
export function createSecureAxiosInstance(useBppKeys: boolean = false): AxiosInstance {
  const instance = axios.create();

  // Add request interceptor for signing
  instance.interceptors.request.use(
    (config) => {
      const keyPair = useBppKeys ? (bppKeyPair || clientKeyPair) : clientKeyPair;
      if (!signingEnabled) {
        logger.warn(`[SIGNING-DISABLED] Request to ${config.url} sent WITHOUT signature`);
      } else if (!keyPair) {
        logger.warn(`[NO-KEYPAIR] Request to ${config.url} sent WITHOUT signature (no ${useBppKeys ? 'BPP' : 'BAP'} keys)`);
      }
      if (
        signingEnabled &&
        keyPair &&
        config.method?.toLowerCase() === 'post' &&
        config.data
      ) {
        try {
          const signedHeaders = createSignedHeaders(config.data, keyPair, signatureTtl);
          // Merge signed headers into existing headers
          Object.entries(signedHeaders).forEach(([key, value]) => {
            config.headers.set(key, value);
          });
          // Log headers for debugging
          logger.info(`[SIGNED-REQUEST] ${config.url}`);
          logger.info(`[SIGNED-REQUEST] Authorization: ${signedHeaders['Authorization']?.substring(0, 100)}...`);
          logger.info(`[SIGNED-REQUEST] keyId: ${keyPair.keyId}, role: ${useBppKeys ? 'BPP' : 'BAP'}`);
        } catch (error: any) {
          logger.error('Failed to sign request', { url: config.url, error: error.message });
        }
      }
      return config;
    },
    (error) => Promise.reject(error)
  );

  // Add response interceptor for logging
  instance.interceptors.response.use(
    (response) => {
      logger.debug('Response received', {
        url: response.config.url,
        status: response.status
      });
      return response;
    },
    (error) => {
      logger.error('Request failed', {
        url: error.config?.url,
        status: error.response?.status,
        message: error.message
      });
      return Promise.reject(error);
    }
  );

  return instance;
}

// Export default secure instances for BAP and BPP operations
export const secureAxios = createSecureAxiosInstance(false);     // BAP keys (default)
export const secureAxiosBpp = createSecureAxiosInstance(true);   // BPP keys (for catalog_publish)
