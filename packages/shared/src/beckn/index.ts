/**
 * Beckn Protocol Security Module
 * 
 * Provides cryptographic signing and verification for Beckn protocol messages.
 * Implements security measures as per Beckn sandbox and protocol specifications.
 * 
 * Usage:
 * 
 * 1. Apply security middleware at app startup:
 *    import { applySecurityMiddleware } from '@p2p/shared';
 *    
 *    applySecurityMiddleware(app, { corsOrigins: ['http://localhost:3000'] });
 * 
 * 2. Initialize signing/verification:
 *    import { initializeSecureClient, initializeVerification } from '@p2p/shared';
 *    
 *    const keyPair = initializeSecureClient({ enabled: true });
 *    initializeVerification({ enabled: true });
 * 
 * 3. Use secure client for outgoing Beckn messages:
 *    import { signedPost } from '@p2p/shared';
 *    
 *    await signedPost('https://bpp.example/select', selectMessage);
 * 
 * 4. Add verification middleware to Beckn routes:
 *    import { verifyBecknSignature, validateBecknMessage } from '@p2p/shared';
 *    
 *    app.post('/discover', validateBecknMessage, verifyBecknSignature, handler);
 */

// Core signing utilities
export {
  BecknKeyPair,
  SignatureComponents,
  VerificationResult as BecknVerificationResult,  // Renamed to avoid conflict with VC module
  BECKN_ALGORITHM,
  generateKeyPair,
  signMessage,
  verifySignature,
  createSignedHeaders,
  parseAuthorizationHeader,
  registerPublicKey,
  getPublicKey,
  verifyMessageFromRegistry,
  createDigest,
  createSigningString,
  buildAuthorizationHeader,
} from './signing';

// Secure HTTP client
export {
  initializeSecureClient,
  initializeBppKeys,
  getPublicKey as getClientPublicKey,
  getKeyId,
  getKeyPair,
  getBapKeyPair,
  getBppKeyPair,
  isSigningEnabled,
  signedPost,
  signedPostAsBpp,
  signedPostWithKey,
  createSecureAxiosInstance,
  secureAxios,
  secureAxiosBpp,
} from './secure-client';

// Verification middleware
export {
  initializeVerification,
  registerSubscriberKey,
  getRegisteredKeys,
  verifyBecknSignature,
  logBecknSignature,
} from './verify-middleware';

// Security middleware (helmet, cors, rate limiting)
export {
  SecurityConfig,
  applySecurityMiddleware,
  configureCors,
  configureHelmet,
  configureRateLimit,
  configureAuthRateLimit,
  validateBecknMessage,
  addRequestId,
  logSecurityEvents,
  helmet,
  cors,
  rateLimit,
} from './security-middleware';

// Beckn v2 wire-format builders/parsers
export {
  buildWireOrder,
  buildWireStatusOrder,
  buildWireResponseOrder,
  parseWireSelectMessage,
  parseWireStatusMessage,
  parseWireConfirmMessage,
  parseWireOrderResponse,
} from './wire-format';
export type {
  WireOrder,
  WireOrderItem,
  BuildSelectOrderOptions,
  ParsedSelectItems,
} from './wire-format';
