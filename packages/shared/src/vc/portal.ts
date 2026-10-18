/**
 * VC Portal API Client
 * Interacts with the external Verifiable Credentials portal for fetching and verifying VCs
 */

import { config } from '../config';
import {
  VerifiableCredential,
  VerificationResult,
  VerificationOptions,
  VCPortalAuth,
  VCPortalFetchOptions,
  VCPortalVerifyRequest,
  VCPortalVerifyResponse,
} from './types';
import { verifyCredential } from './verifier';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Get the VC Portal base URL from config
 */
export function getPortalUrl(): string {
  return config.external.vcPortal;
}

// =============================================================================
// HTTP Client Utilities
// =============================================================================

interface FetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

/**
 * Make an HTTP request to the VC Portal
 */
async function portalFetch<T>(
  endpoint: string,
  auth?: VCPortalAuth,
  options: FetchOptions = {}
): Promise<T> {
  const url = `${getPortalUrl()}${endpoint}`;
  const { method = 'GET', headers = {}, body, timeout = 30000 } = options;

  // Add authentication headers
  if (auth) {
    if (auth.type === 'bearer' && auth.token) {
      headers['Authorization'] = `Bearer ${auth.token}`;
    } else if (auth.type === 'api_key' && auth.apiKey) {
      headers['X-API-Key'] = auth.apiKey;
    }
  }

  // Add content type for POST/PUT
  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      throw new VCPortalError(
        `Portal request failed: ${response.status} ${response.statusText}`,
        response.status,
        errorBody
      );
    }

    return response.json() as Promise<T>;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error instanceof VCPortalError) {
      throw error;
    }
    
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        throw new VCPortalError('Portal request timed out', 408);
      }
      throw new VCPortalError(`Portal request failed: ${error.message}`, 0);
    }
    
    throw new VCPortalError('Unknown portal error', 0);
  }
}

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error class for VC Portal API errors
 */
export class VCPortalError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'VCPortalError';
  }
}

// =============================================================================
// Portal API Client
// =============================================================================

/**
 * VC Portal API Client class
 */
export class VCPortalClient {
  private auth?: VCPortalAuth;

  constructor(auth?: VCPortalAuth) {
    this.auth = auth;
  }

  /**
   * Set authentication credentials
   */
  setAuth(auth: VCPortalAuth): void {
    this.auth = auth;
  }

  /**
   * Check if portal is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      await portalFetch<{ status: string }>('/health', undefined, {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch a specific VC by ID
   */
  async fetchCredential(vcId: string): Promise<VerifiableCredential | null> {
    if (!this.auth) {
      throw new VCPortalError('Authentication required to fetch credentials', 401);
    }

    try {
      const response = await portalFetch<{ credential: VerifiableCredential }>(
        `/api/credentials/${encodeURIComponent(vcId)}`,
        this.auth
      );
      return response.credential;
    } catch (error) {
      if (error instanceof VCPortalError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * List credentials with optional filters
   */
  async listCredentials(options: VCPortalFetchOptions = {}): Promise<VerifiableCredential[]> {
    if (!this.auth) {
      throw new VCPortalError('Authentication required to list credentials', 401);
    }

    const params = new URLSearchParams();
    if (options.holderId) params.set('holder', options.holderId);
    if (options.type) params.set('type', options.type);
    if (options.limit) params.set('limit', options.limit.toString());

    const queryString = params.toString();
    const endpoint = `/api/credentials${queryString ? `?${queryString}` : ''}`;

    const response = await portalFetch<{ credentials: VerifiableCredential[] }>(
      endpoint,
      this.auth
    );
    return response.credentials;
  }

  /**
   * Submit a credential to the portal for verification
   * Uses the portal's verification service (may have access to DID resolvers, etc.)
   */
  async verifyWithPortal(
    credential: VerifiableCredential,
    options?: VerificationOptions
  ): Promise<VCPortalVerifyResponse> {
    const request: VCPortalVerifyRequest = {
      credential,
      options,
    };

    try {
      const response = await portalFetch<VCPortalVerifyResponse>(
        '/api/credentials/verify',
        this.auth,
        {
          method: 'POST',
          body: request,
        }
      );
      return response;
    } catch (error) {
      // If portal verification fails, fall back to local verification
      if (error instanceof VCPortalError) {
        console.warn('Portal verification failed, using local verification:', error.message);
      }
      
      const localResult = await verifyCredential(credential, options);
      return {
        verified: localResult.verified,
        result: localResult,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Fetch credentials for a specific order/trade
   * This is a convenience method for the settlement flow
   */
  async fetchCredentialsForTrade(
    tradeId: string,
    providerId?: string
  ): Promise<VerifiableCredential[]> {
    if (!this.auth) {
      throw new VCPortalError('Authentication required', 401);
    }

    const params = new URLSearchParams();
    params.set('tradeId', tradeId);
    if (providerId) params.set('providerId', providerId);

    try {
      const response = await portalFetch<{ credentials: VerifiableCredential[] }>(
        `/api/trades/${encodeURIComponent(tradeId)}/credentials?${params.toString()}`,
        this.auth
      );
      return response.credentials;
    } catch (error) {
      if (error instanceof VCPortalError && error.statusCode === 404) {
        return [];
      }
      throw error;
    }
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let defaultClient: VCPortalClient | null = null;

/**
 * Get the default VC Portal client instance
 */
export function getPortalClient(): VCPortalClient {
  if (!defaultClient) {
    defaultClient = new VCPortalClient();
  }
  return defaultClient;
}

/**
 * Configure the default VC Portal client with authentication
 */
export function configurePortalClient(auth: VCPortalAuth): VCPortalClient {
  const client = getPortalClient();
  client.setAuth(auth);
  return client;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Verify a credential using the portal (with fallback to local verification)
 */
export async function verifyWithPortal(
  credential: VerifiableCredential,
  options?: VerificationOptions,
  auth?: VCPortalAuth
): Promise<VerificationResult> {
  const client = auth ? new VCPortalClient(auth) : getPortalClient();
  
  try {
    const response = await client.verifyWithPortal(credential, options);
    return response.result;
  } catch (error) {
    // Fall back to local verification
    console.warn('Portal verification unavailable, using local verification');
    return verifyCredential(credential, options);
  }
}

/**
 * Fetch and verify a credential by ID
 */
export async function fetchAndVerify(
  vcId: string,
  options?: VerificationOptions,
  auth?: VCPortalAuth
): Promise<VerificationResult & { credential?: VerifiableCredential }> {
  const client = auth ? new VCPortalClient(auth) : getPortalClient();
  
  if (!auth && !defaultClient?.['auth']) {
    throw new VCPortalError('Authentication required to fetch credentials', 401);
  }

  const credential = await client.fetchCredential(vcId);
  
  if (!credential) {
    return {
      verified: false,
      checks: [{
        check: 'fetch',
        status: 'failed',
        message: `Credential not found: ${vcId}`,
      }],
      error: 'Credential not found',
    };
  }

  const result = await client.verifyWithPortal(credential, options);
  return {
    ...result.result,
    credential,
  };
}
