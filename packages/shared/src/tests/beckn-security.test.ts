/**
 * Beckn Protocol Security Tests
 * 
 * Tests for cryptographic signing and verification of Beckn messages.
 */

import {
  generateKeyPair,
  signMessage,
  verifySignature,
  createSignedHeaders,
  parseAuthorizationHeader,
  registerPublicKey,
  verifyMessageFromRegistry,
  BecknKeyPair,
  BECKN_ALGORITHM,
} from '../beckn/signing';
import {
  initializeSecureClient,
  getPublicKey,
  getKeyId,
  isSigningEnabled,
} from '../beckn/secure-client';

describe('Beckn Protocol Security', () => {
  describe('Key Generation', () => {
    it('should generate valid Ed25519 key pair', () => {
      const keyPair = generateKeyPair('test-subscriber');
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.keyId).toBe(`test-subscriber|key1|${BECKN_ALGORITHM}`);
      
      // Keys should be base64 encoded
      expect(() => Buffer.from(keyPair.publicKey, 'base64')).not.toThrow();
      expect(() => Buffer.from(keyPair.privateKey, 'base64')).not.toThrow();
    });

    it('should generate unique key IDs for different subscribers', () => {
      const keyPair1 = generateKeyPair('subscriber-1');
      const keyPair2 = generateKeyPair('subscriber-2');
      
      expect(keyPair1.keyId).not.toBe(keyPair2.keyId);
      expect(keyPair1.publicKey).not.toBe(keyPair2.publicKey);
    });

    it('should support custom unique key ID', () => {
      const keyPair = generateKeyPair('subscriber', 'custom-key');
      
      expect(keyPair.keyId).toBe(`subscriber|custom-key|${BECKN_ALGORITHM}`);
    });
  });

  describe('Message Signing', () => {
    let keyPair: BecknKeyPair;

    beforeEach(() => {
      keyPair = generateKeyPair('test-signer');
    });

    it('should sign a string message', () => {
      const message = JSON.stringify({ hello: 'world' });
      const signature = signMessage(message, keyPair);
      
      expect(signature).toBeDefined();
      expect(signature).toContain('Signature keyId=');
      expect(signature).toContain(keyPair.keyId);
    });

    it('should sign an object message', () => {
      const message = { 
        context: { action: 'discover' },
        message: { intent: {} }
      };
      const signature = signMessage(message, keyPair);
      
      expect(signature).toBeDefined();
      expect(signature).toContain('Signature keyId=');
    });

    it('should produce different signatures for different messages', () => {
      const sig1 = signMessage({ a: 1 }, keyPair);
      const sig2 = signMessage({ a: 2 }, keyPair);
      
      expect(sig1).not.toBe(sig2);
    });

    it('should include timestamp and expiry', () => {
      const signature = signMessage({ test: true }, keyPair, 60);
      const components = parseAuthorizationHeader(signature);
      
      expect(components).not.toBeNull();
      expect(components!.created).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      expect(components!.expires).toBe(components!.created + 60);
    });
  });

  describe('Signature Verification', () => {
    let keyPair: BecknKeyPair;

    beforeEach(() => {
      keyPair = generateKeyPair('test-verifier');
    });

    it('should verify a valid signature', () => {
      const message = { transaction_id: 'test-123', action: 'discover' };
      const authHeader = signMessage(message, keyPair);
      
      const result = verifySignature(authHeader, message, keyPair.publicKey);
      
      expect(result.valid).toBe(true);
      expect(result.keyId).toBe(keyPair.keyId);
      expect(result.error).toBeUndefined();
    });

    it('should reject tampered message', () => {
      const originalMessage = { amount: 100 };
      const authHeader = signMessage(originalMessage, keyPair);
      
      // Tamper with the message
      const tamperedMessage = { amount: 999 };
      
      const result = verifySignature(authHeader, tamperedMessage, keyPair.publicKey);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('verification failed');
    });

    it('should reject expired signature', async () => {
      const message = { test: true };
      // Sign with 1 second TTL
      const authHeader = signMessage(message, keyPair, 1);
      
      // Wait for expiration (2.5 seconds to be safe with clock skew)
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const result = verifySignature(authHeader, message, keyPair.publicKey);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    }, 10000); // Increase timeout for this test

    it('should reject wrong public key', () => {
      const message = { test: true };
      const authHeader = signMessage(message, keyPair);
      
      // Generate a different key pair
      const otherKeyPair = generateKeyPair('other-subscriber');
      
      const result = verifySignature(authHeader, message, otherKeyPair.publicKey);
      
      expect(result.valid).toBe(false);
    });

    it('should reject malformed authorization header', () => {
      const result = verifySignature('invalid-header', {}, keyPair.publicKey);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid');
    });
  });

  describe('Header Parsing', () => {
    it('should parse valid authorization header', () => {
      const keyPair = generateKeyPair('parser-test');
      const authHeader = signMessage({ test: true }, keyPair);
      
      const components = parseAuthorizationHeader(authHeader);
      
      expect(components).not.toBeNull();
      expect(components!.keyId).toBe(keyPair.keyId);
      expect(components!.algorithm).toBe(BECKN_ALGORITHM);
      expect(components!.headers).toBe('(created) (expires) digest');
      expect(components!.signature).toBeDefined();
    });

    it('should reject non-Signature header', () => {
      const result = parseAuthorizationHeader('Bearer some-token');
      
      expect(result).toBeNull();
    });

    it('should reject incomplete header', () => {
      const result = parseAuthorizationHeader('Signature keyId="test"');
      
      expect(result).toBeNull();
    });
  });

  describe('Signed Headers Creation', () => {
    it('should create complete signed headers', () => {
      const keyPair = generateKeyPair('headers-test');
      const body = { action: 'discover' };
      
      const headers = createSignedHeaders(body, keyPair);
      
      expect(headers['Authorization']).toBeDefined();
      expect(headers['Authorization']).toContain('Signature');
      expect(headers['X-Gateway-Authorization']).toBe(headers['Authorization']);
      expect(headers['Digest']).toContain('BLAKE-512=');
      expect(headers['Content-Type']).toBe('application/json');
    });
  });

  describe('Public Key Registry', () => {
    it('should register and retrieve public keys', () => {
      const keyPair = generateKeyPair('registry-test');
      
      registerPublicKey(keyPair.keyId, keyPair.publicKey);
      
      const message = { test: true };
      const authHeader = signMessage(message, keyPair);
      
      const result = verifyMessageFromRegistry(authHeader, message);
      
      expect(result.valid).toBe(true);
    });

    it('should fail for unregistered key', () => {
      const keyPair = generateKeyPair('unregistered-test');
      
      const message = { test: true };
      const authHeader = signMessage(message, keyPair);
      
      // Don't register the key
      const result = verifyMessageFromRegistry(authHeader, message);
      
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unknown keyId');
    });
  });

  describe('Secure Client', () => {
    it('should initialize with generated key pair', () => {
      const keyPair = initializeSecureClient({
        enabled: true,
        ttlSeconds: 60,
      });
      
      expect(keyPair).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(getPublicKey()).toBe(keyPair.publicKey);
      expect(getKeyId()).toBe(keyPair.keyId);
    });

    it('should use provided key pair', () => {
      const customKeyPair = generateKeyPair('custom-client');
      
      const result = initializeSecureClient({
        keyPair: customKeyPair,
        enabled: true,
      });
      
      expect(result.keyId).toBe(customKeyPair.keyId);
    });
  });

  describe('Real Beckn Message Scenarios', () => {
    let bapKeyPair: BecknKeyPair;
    let bppKeyPair: BecknKeyPair;

    beforeAll(() => {
      bapKeyPair = generateKeyPair('p2p-energy-bap');
      bppKeyPair = generateKeyPair('p2p-energy-bpp');
      
      // Register each other's keys
      registerPublicKey(bapKeyPair.keyId, bapKeyPair.publicKey);
      registerPublicKey(bppKeyPair.keyId, bppKeyPair.publicKey);
    });

    it('should sign and verify discover message', () => {
      const discoverMessage = {
        context: {
          domain: 'energy',
          action: 'discover',
          version: '1.0.0',
          bap_id: 'p2p-energy-bap',
          bap_uri: 'http://localhost:4000',
          transaction_id: 'txn-123',
          message_id: 'msg-123',
          timestamp: new Date().toISOString(),
        },
        message: {
          intent: {
            item: {
              itemAttributes: {
                sourceType: 'SOLAR',
              },
            },
          },
        },
      };

      // BAP signs the request
      const authHeader = signMessage(discoverMessage, bapKeyPair);
      
      // CDS/BPP verifies
      const result = verifyMessageFromRegistry(authHeader, discoverMessage);
      
      expect(result.valid).toBe(true);
      expect(result.keyId).toBe(bapKeyPair.keyId);
    });

    it('should sign and verify on_discover callback', () => {
      const onDiscoverMessage = {
        context: {
          domain: 'energy',
          action: 'on_discover',
          version: '1.0.0',
          bap_id: 'p2p-energy-bap',
          bpp_id: 'p2p-energy-bpp',
          transaction_id: 'txn-123',
          message_id: 'msg-456',
          timestamp: new Date().toISOString(),
        },
        message: {
          catalog: {
            providers: [
              {
                id: 'provider-1',
                items: [],
              },
            ],
          },
        },
      };

      // BPP signs the callback
      const authHeader = signMessage(onDiscoverMessage, bppKeyPair);
      
      // BAP verifies
      const result = verifyMessageFromRegistry(authHeader, onDiscoverMessage);
      
      expect(result.valid).toBe(true);
      expect(result.keyId).toBe(bppKeyPair.keyId);
    });

    it('should sign and verify confirm message', () => {
      const confirmMessage = {
        context: {
          domain: 'energy',
          action: 'confirm',
          version: '1.0.0',
          bap_id: 'p2p-energy-bap',
          bpp_id: 'p2p-energy-bpp',
          transaction_id: 'txn-123',
          message_id: 'msg-789',
          timestamp: new Date().toISOString(),
        },
        message: {
          order: {
            id: 'order-abc',
          },
        },
      };

      // BAP signs
      const authHeader = signMessage(confirmMessage, bapKeyPair);
      
      // BPP verifies
      const result = verifyMessageFromRegistry(authHeader, confirmMessage);
      
      expect(result.valid).toBe(true);
    });

    it('should detect MITM attack on order confirmation', () => {
      const originalConfirm = {
        context: {
          action: 'confirm',
          transaction_id: 'txn-123',
        },
        message: {
          order: { id: 'order-123' },
        },
      };

      // Attacker intercepts and modifies
      const tamperedConfirm = {
        ...originalConfirm,
        message: {
          order: { id: 'attacker-order' }, // Changed order ID
        },
      };

      // Original signature
      const authHeader = signMessage(originalConfirm, bapKeyPair);
      
      // Verification of tampered message should fail
      const result = verifyMessageFromRegistry(authHeader, tamperedConfirm);
      
      expect(result.valid).toBe(false);
    });

    it('should reject replay attack after signature expires', async () => {
      const message = {
        context: { action: 'confirm' },
        message: { order: { id: 'order-123' } },
      };

      // Sign with 1 second TTL
      const authHeader = signMessage(message, bapKeyPair, 1);
      
      // Initial verification should pass
      let result = verifyMessageFromRegistry(authHeader, message);
      expect(result.valid).toBe(true);
      
      // Wait for expiry (2.5 seconds to be safe with floor rounding)
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      // Replay should fail
      result = verifyMessageFromRegistry(authHeader, message);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    }, 10000); // Increase timeout for this test
  });
});
