/**
 * Beckn HTTP Signature Implementation
 * 
 * Implements Ed25519 signing for Beckn protocol messages.
 * Matches ONIX adapter implementation from beckn-onix.
 * 
 * Uses:
 * - Ed25519 signature scheme
 * - BLAKE2b-512 for digest hashing (via Node.js crypto)
 * - Authorization header format per RFC 7235
 * 
 * Reference: beckn-onix/core/module/handler/step.go
 */

import crypto from 'crypto';

// Algorithm designation - must match what's registered in DeDi keyId
// Note: xed25519 is used in the keyId (subscriber_id|unique_key_id|xed25519)
export const BECKN_ALGORITHM = 'xed25519';

// Key pair interface
export interface BecknKeyPair {
  publicKey: string;  // Base64 encoded
  privateKey: string; // Base64 encoded
  keyId: string;      // Unique key identifier (subscriber_id|unique_key_id|algorithm)
}

// Signature header components
export interface SignatureComponents {
  keyId: string;
  algorithm: string;
  created: number;
  expires: number;
  headers: string;
  signature: string;
}

// Verification result
export interface VerificationResult {
  valid: boolean;
  error?: string;
  keyId?: string;
  timestamp?: number;
}

/**
 * Generate a new Ed25519 key pair for Beckn signing
 * Uses XEd25519 algorithm designation as per Beckn spec
 */
export function generateKeyPair(subscriberId: string, uniqueKeyId: string = 'key1'): BecknKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    keyId: `${subscriberId}|${uniqueKeyId}|${BECKN_ALGORITHM}`,
  };
}

/**
 * Create the signing string from request components
 * Format: (created): <timestamp>\n(expires): <timestamp>\ndigest: BLAKE-512=<hash>
 */
export function createSigningString(
  created: number,
  expires: number,
  body: string | object
): string {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const digest = createDigest(bodyString);

  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
}

/**
 * Create BLAKE2b-512 digest of the request body
 * Uses Node.js built-in crypto (blake2b512 available since Node 12)
 * Matches ONIX implementation: signer.go hash() function
 */
export function createDigest(body: string): string {
  // BLAKE2b-512 per Beckn spec and ONIX implementation
  const hash = crypto.createHash('blake2b512').update(body).digest('base64');
  return hash;
}

/**
 * Sign a Beckn message
 * TTL matches ONIX: 5 minutes (step.go line 46)
 */
export function signMessage(
  body: string | object,
  keyPair: BecknKeyPair,
  ttlSeconds: number = 300 // 5 minutes, matching ONIX
): string {
  const now = Math.floor(Date.now() / 1000);
  const created = now;
  const expires = now + ttlSeconds;

  const signingString = createSigningString(created, expires, body);

  // Import the private key
  const privateKeyObj = crypto.createPrivateKey({
    key: Buffer.from(keyPair.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  // Sign the string
  const signature = crypto.sign(null, Buffer.from(signingString), privateKeyObj);
  const signatureBase64 = signature.toString('base64');

  // Build the Authorization header value
  return buildAuthorizationHeader({
    keyId: keyPair.keyId,
    algorithm: BECKN_ALGORITHM,
    created,
    expires,
    headers: '(created) (expires) digest',
    signature: signatureBase64,
  });
}

/**
 * Build the Authorization header value
 * Format per Beckn spec: Signature keyId="{subscriber_id}|{unique_key_id}|{algorithm}" algorithm="xed25519" ...
 */
export function buildAuthorizationHeader(components: SignatureComponents): string {
  return `Signature keyId="${components.keyId}",algorithm="${BECKN_ALGORITHM}",created="${components.created}",expires="${components.expires}",headers="${components.headers}",signature="${components.signature}"`;
}

/**
 * Parse an Authorization header into components
 */
export function parseAuthorizationHeader(header: string): SignatureComponents | null {
  if (!header.startsWith('Signature ')) {
    return null;
  }

  const signaturePart = header.substring('Signature '.length);
  const components: Partial<SignatureComponents> = {};

  // Parse key-value pairs
  const regex = /(\w+)="([^"]+)"/g;
  let match;

  while ((match = regex.exec(signaturePart)) !== null) {
    const [, key, value] = match;
    switch (key) {
      case 'keyId':
        components.keyId = value;
        break;
      case 'algorithm':
        components.algorithm = value;
        break;
      case 'created':
        components.created = parseInt(value, 10);
        break;
      case 'expires':
        components.expires = parseInt(value, 10);
        break;
      case 'headers':
        components.headers = value;
        break;
      case 'signature':
        components.signature = value;
        break;
    }
  }

  // Validate all required fields are present
  if (!components.keyId || !components.algorithm || !components.created ||
    !components.expires || !components.headers || !components.signature) {
    return null;
  }

  return components as SignatureComponents;
}

/**
 * Verify a Beckn message signature
 */
export function verifySignature(
  authHeader: string,
  body: string | object,
  publicKeyBase64: string
): VerificationResult {
  try {
    // Parse the Authorization header
    const components = parseAuthorizationHeader(authHeader);
    if (!components) {
      return { valid: false, error: 'Invalid Authorization header format' };
    }

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (now > components.expires) {
      return { valid: false, error: 'Signature has expired', keyId: components.keyId };
    }

    // Recreate the signing string
    const signingString = createSigningString(components.created, components.expires, body);

    // Import the public key
    const publicKeyObj = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });

    // Verify the signature
    const signatureBuffer = Buffer.from(components.signature, 'base64');
    const isValid = crypto.verify(null, Buffer.from(signingString), publicKeyObj, signatureBuffer);

    return {
      valid: isValid,
      keyId: components.keyId,
      timestamp: components.created,
      error: isValid ? undefined : 'Signature verification failed',
    };
  } catch (error: any) {
    return { valid: false, error: `Verification error: ${error.message}` };
  }
}

/**
 * Create headers for a signed Beckn request
 */
export function createSignedHeaders(
  body: object,
  keyPair: BecknKeyPair,
  ttlSeconds: number = 300  // 5 minutes, matching ONIX
): Record<string, string> {
  const bodyString = JSON.stringify(body);
  const authorization = signMessage(bodyString, keyPair, ttlSeconds);
  const digest = createDigest(bodyString);

  return {
    'Authorization': authorization,
    'X-Gateway-Authorization': authorization,
    'Digest': `BLAKE-512=${digest}`,
    'Content-Type': 'application/json',
  };
}

// Registry of known public keys (for verification)
const publicKeyRegistry: Map<string, string> = new Map();

/**
 * Register a public key for a subscriber
 */
export function registerPublicKey(keyId: string, publicKeyBase64: string): void {
  publicKeyRegistry.set(keyId, publicKeyBase64);
}

/**
 * Get a registered public key
 */
export function getPublicKey(keyId: string): string | undefined {
  return publicKeyRegistry.get(keyId);
}

/**
 * Verify a message using the key registry
 */
export function verifyMessageFromRegistry(
  authHeader: string,
  body: string | object
): VerificationResult {
  const components = parseAuthorizationHeader(authHeader);
  if (!components) {
    return { valid: false, error: 'Invalid Authorization header format' };
  }

  const publicKey = getPublicKey(components.keyId);
  if (!publicKey) {
    return { valid: false, error: `Unknown keyId: ${components.keyId}`, keyId: components.keyId };
  }

  return verifySignature(authHeader, body, publicKey);
}
