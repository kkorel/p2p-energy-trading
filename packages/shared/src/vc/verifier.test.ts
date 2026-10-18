/**
 * Comprehensive unit tests for Verifiable Credentials Verifier
 * Tests structure validation, date checking, proof validation, and claim extraction
 */

import {
  validateVCStructure,
  validateProofStructure,
  checkExpiration,
  checkIssuanceDate,
  checkTrustedIssuer,
  checkCredentialTypes,
  verifyCredential,
  parseAndVerifyCredential,
  verifyGenerationProfile,
  getIssuerId,
  getIssuanceDate,
  getExpirationDate,
  extractProviderId,
  extractCapacity,
  extractSourceType,
  extractFullName,
  extractNormalizedGenerationClaims,
} from './verifier';
import { VerifiableCredential } from './types';

// Helper to create a valid test VC
function createValidVC(overrides: Partial<VerifiableCredential> = {}): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'GenerationProfileCredential'],
    issuer: 'did:example:issuer123',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:example:subject456',
      providerId: 'provider-123',
      capacityKW: 500,
      generationType: 'SOLAR',
    },
    proof: {
      type: 'Ed25519Signature2020',
      created: '2024-01-01T00:00:00Z',
      proofPurpose: 'assertionMethod',
      verificationMethod: 'did:example:issuer123#key-1',
      proofValue: 'base64encodedproof',
    },
    ...overrides,
  };
}

describe('VC Verifier', () => {
  describe('validateVCStructure - @context', () => {
    it('should fail when @context is missing', () => {
      const vc = { type: ['VerifiableCredential'] };
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'context' && c.status === 'failed')).toBe(true);
      expect(checks.some(c => c.message?.includes('Missing @context'))).toBe(true);
    });

    it('should fail when @context is not an array', () => {
      const vc = { '@context': 'https://www.w3.org/2018/credentials/v1', type: ['VerifiableCredential'] };
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'context' && c.status === 'failed')).toBe(true);
      expect(checks.some(c => c.message?.includes('must be an array'))).toBe(true);
    });

    it('should pass when @context contains v1 context', () => {
      const vc = createValidVC({ '@context': ['https://www.w3.org/2018/credentials/v1'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'context' && c.status === 'passed')).toBe(true);
    });

    it('should pass when @context contains v2 context', () => {
      const vc = createValidVC({ '@context': ['https://www.w3.org/ns/credentials/v2'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'context' && c.status === 'passed')).toBe(true);
    });

    it('should warn for non-standard context', () => {
      const vc = createValidVC({ '@context': ['https://custom.context.com/v1'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'context' && c.status === 'warning')).toBe(true);
    });
  });

  describe('validateVCStructure - type', () => {
    it('should fail when type is missing', () => {
      const vc = { '@context': ['https://www.w3.org/2018/credentials/v1'] };
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'type' && c.status === 'failed')).toBe(true);
    });

    it('should fail when type is not an array', () => {
      const vc = { '@context': ['https://www.w3.org/2018/credentials/v1'], type: 'VerifiableCredential' };
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'type' && c.status === 'failed')).toBe(true);
    });

    it('should pass when type contains VerifiableCredential', () => {
      const vc = createValidVC({ type: ['VerifiableCredential'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'type' && c.status === 'passed')).toBe(true);
    });

    it('should fail when type does not contain VerifiableCredential', () => {
      const vc = createValidVC({ type: ['CustomCredential'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'type' && c.status === 'failed')).toBe(true);
    });

    it('should pass when type has extra types with VerifiableCredential', () => {
      const vc = createValidVC({ type: ['VerifiableCredential', 'GenerationProfileCredential', 'CustomType'] });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'type' && c.status === 'passed')).toBe(true);
    });
  });

  describe('validateVCStructure - issuer', () => {
    it('should fail when issuer is missing', () => {
      const vc = createValidVC();
      delete (vc as any).issuer;
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'issuer' && c.status === 'failed')).toBe(true);
    });

    it('should pass when issuer is a string', () => {
      const vc = createValidVC({ issuer: 'did:example:123' });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'issuer' && c.status === 'passed')).toBe(true);
    });

    it('should pass when issuer is an object with id', () => {
      const vc = createValidVC({ issuer: { id: 'did:example:123', name: 'Test Issuer' } });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'issuer' && c.status === 'passed')).toBe(true);
    });

    it('should fail when issuer object has no id', () => {
      const vc = createValidVC({ issuer: { name: 'Test Issuer' } as any });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'issuer' && c.status === 'failed')).toBe(true);
    });
  });

  describe('validateVCStructure - credentialSubject', () => {
    it('should fail when credentialSubject is missing', () => {
      const vc = createValidVC();
      delete (vc as any).credentialSubject;
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'credentialSubject' && c.status === 'failed')).toBe(true);
    });

    it('should fail when credentialSubject is not an object', () => {
      const vc = createValidVC({ credentialSubject: 'not an object' as any });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'credentialSubject' && c.status === 'failed')).toBe(true);
    });

    it('should pass when credentialSubject is an empty object', () => {
      const vc = createValidVC({ credentialSubject: {} });
      const checks = validateVCStructure(vc);

      expect(checks.some(c => c.check === 'credentialSubject' && c.status === 'passed')).toBe(true);
    });
  });

  describe('Date Validation', () => {
    describe('checkIssuanceDate', () => {
      it('should pass when issuance date is in the past', () => {
        const vc = createValidVC({ issuanceDate: '2020-01-01T00:00:00Z' });
        const check = checkIssuanceDate(vc);

        expect(check.status).toBe('passed');
      });

      it('should fail when issuance date is in the future', () => {
        const vc = createValidVC({ issuanceDate: '2099-01-01T00:00:00Z' });
        const check = checkIssuanceDate(vc);

        expect(check.status).toBe('failed');
        expect(check.message).toContain('in the future');
      });

      it('should warn when issuance date is missing', () => {
        const vc = createValidVC();
        delete (vc as any).issuanceDate;
        delete (vc as any).validFrom;
        const check = checkIssuanceDate(vc);

        expect(check.status).toBe('warning');
      });

      it('should accept validFrom as issuance date (VC 2.0)', () => {
        const vc = createValidVC({ validFrom: '2020-01-01T00:00:00Z' });
        delete (vc as any).issuanceDate;
        const check = checkIssuanceDate(vc);

        expect(check.status).toBe('passed');
      });
    });

    describe('checkExpiration', () => {
      it('should pass when expiration date is in the future', () => {
        const vc = createValidVC({ expirationDate: '2099-12-31T23:59:59Z' });
        const check = checkExpiration(vc);

        expect(check.status).toBe('passed');
      });

      it('should fail when expiration date is in the past', () => {
        const vc = createValidVC({ expirationDate: '2020-01-01T00:00:00Z' });
        const check = checkExpiration(vc);

        expect(check.status).toBe('failed');
        expect(check.message).toContain('expired');
      });

      it('should pass when there is no expiration date', () => {
        const vc = createValidVC();
        const check = checkExpiration(vc);

        expect(check.status).toBe('passed');
        expect(check.message).toContain('no expiration');
      });

      it('should accept validUntil as expiration date (VC 2.0)', () => {
        const vc = createValidVC({ validUntil: '2099-12-31T23:59:59Z' });
        const check = checkExpiration(vc);

        expect(check.status).toBe('passed');
      });
    });
  });

  describe('Trusted Issuer Check', () => {
    it('should pass when issuer is in trusted list', () => {
      const vc = createValidVC({ issuer: 'did:example:trusted' });
      const check = checkTrustedIssuer(vc, ['did:example:trusted']);

      expect(check.status).toBe('passed');
    });

    it('should fail when issuer is not in trusted list', () => {
      const vc = createValidVC({ issuer: 'did:example:untrusted' });
      const check = checkTrustedIssuer(vc, ['did:example:trusted']);

      expect(check.status).toBe('failed');
      expect(check.message).toContain('not in trusted list');
    });

    it('should warn when trusted list is empty', () => {
      const vc = createValidVC({ issuer: 'did:example:any' });
      const check = checkTrustedIssuer(vc, []);

      expect(check.status).toBe('warning');
      expect(check.message).toContain('No trusted issuers configured');
    });

    it('should handle issuer as object', () => {
      const vc = createValidVC({ issuer: { id: 'did:example:trusted' } });
      const check = checkTrustedIssuer(vc, ['did:example:trusted']);

      expect(check.status).toBe('passed');
    });
  });

  describe('Proof Validation', () => {
    it('should warn when proof is missing', () => {
      const check = validateProofStructure(null);

      expect(check.status).toBe('warning');
      expect(check.message).toContain('No proof attached');
    });

    it('should fail when proof type is missing', () => {
      const proof = { verificationMethod: 'did:example:key', proofValue: 'value' };
      const check = validateProofStructure(proof);

      expect(check.status).toBe('failed');
      expect(check.message).toContain('type');
    });

    it('should fail when verificationMethod is missing', () => {
      const proof = { type: 'Ed25519Signature2020', proofValue: 'value' };
      const check = validateProofStructure(proof);

      expect(check.status).toBe('failed');
      expect(check.message).toContain('verificationMethod');
    });

    it('should fail when both proofValue and jws are missing', () => {
      const proof = { type: 'Ed25519Signature2020', verificationMethod: 'did:example:key' };
      const check = validateProofStructure(proof);

      expect(check.status).toBe('failed');
      expect(check.message).toContain('proofValue or jws');
    });

    it('should pass with proofValue', () => {
      const proof = {
        type: 'Ed25519Signature2020',
        verificationMethod: 'did:example:key',
        proofValue: 'base64value',
      };
      const check = validateProofStructure(proof);

      expect(check.status).toBe('passed');
    });

    it('should pass with jws', () => {
      const proof = {
        type: 'JsonWebSignature2020',
        verificationMethod: 'did:example:key',
        jws: 'header.payload.signature',
      };
      const check = validateProofStructure(proof);

      expect(check.status).toBe('passed');
    });
  });

  describe('checkCredentialTypes', () => {
    it('should pass when all expected types are present', () => {
      const vc = createValidVC({ type: ['VerifiableCredential', 'GenerationProfileCredential'] });
      const check = checkCredentialTypes(vc, ['GenerationProfileCredential']);

      expect(check.status).toBe('passed');
    });

    it('should fail when expected types are missing', () => {
      const vc = createValidVC({ type: ['VerifiableCredential'] });
      const check = checkCredentialTypes(vc, ['GenerationProfileCredential']);

      expect(check.status).toBe('failed');
      expect(check.message).toContain('missing expected types');
    });

    it('should skip when no expected types specified', () => {
      const vc = createValidVC();
      const check = checkCredentialTypes(vc, []);

      expect(check.status).toBe('skipped');
    });
  });

  describe('verifyCredential - Full Integration', () => {
    it('should return verified=true for valid credential', async () => {
      const vc = createValidVC();
      const result = await verifyCredential(vc);

      expect(result.verified).toBe(true);
    });

    it('should return verified=false for invalid structure', async () => {
      const result = await verifyCredential({ invalid: 'structure' });

      expect(result.verified).toBe(false);
      expect(result.error).toContain('structure validation failed');
    });

    it('should include issuer in result', async () => {
      const vc = createValidVC({ issuer: 'did:example:issuer123' });
      const result = await verifyCredential(vc);

      expect(result.issuer).toBe('did:example:issuer123');
    });

    it('should include claims in result', async () => {
      const vc = createValidVC({
        credentialSubject: { providerId: 'test-provider', capacityKW: 500 },
      });
      const result = await verifyCredential(vc);

      expect(result.claims).toBeDefined();
      expect((result.claims as any).providerId).toBe('test-provider');
    });

    it('should check trusted issuers when provided', async () => {
      const vc = createValidVC({ issuer: 'did:example:untrusted' });
      const result = await verifyCredential(vc, {
        trustedIssuers: ['did:example:trusted'],
      });

      expect(result.verified).toBe(false);
      expect(result.checks.some(c => c.check === 'trustedIssuer' && c.status === 'failed')).toBe(true);
    });

    it('should check expected types when provided', async () => {
      const vc = createValidVC({ type: ['VerifiableCredential'] });
      const result = await verifyCredential(vc, {
        expectedTypes: ['GenerationProfileCredential'],
      });

      expect(result.checks.some(c => c.check === 'expectedTypes' && c.status === 'failed')).toBe(true);
    });
  });

  describe('parseAndVerifyCredential', () => {
    it('should parse and verify valid JSON', async () => {
      const vc = createValidVC();
      const json = JSON.stringify(vc);
      const result = await parseAndVerifyCredential(json);

      expect(result.verified).toBe(true);
    });

    it('should fail for invalid JSON', async () => {
      const result = await parseAndVerifyCredential('not valid json');

      expect(result.verified).toBe(false);
      expect(result.error).toBe('Invalid JSON');
    });

    it('should fail for empty JSON', async () => {
      const result = await parseAndVerifyCredential('{}');

      expect(result.verified).toBe(false);
    });
  });

  describe('Energy Credential Extraction', () => {
    describe('extractProviderId', () => {
      it('should extract providerId field', () => {
        const vc = createValidVC({ credentialSubject: { providerId: 'P123' } });
        expect(extractProviderId(vc)).toBe('P123');
      });

      it('should extract consumerNumber as fallback', () => {
        const vc = createValidVC({ credentialSubject: { consumerNumber: 'C456' } });
        expect(extractProviderId(vc)).toBe('C456');
      });

      it('should extract id as final fallback', () => {
        const vc = createValidVC({ credentialSubject: { id: 'did:example:789' } });
        expect(extractProviderId(vc)).toBe('did:example:789');
      });

      it('should return undefined when no identifier found', () => {
        const vc = createValidVC({ credentialSubject: {} });
        expect(extractProviderId(vc)).toBeUndefined();
      });
    });

    describe('extractCapacity', () => {
      it('should extract numeric capacityKW', () => {
        const vc = createValidVC({ credentialSubject: { capacityKW: 500 } });
        expect(extractCapacity(vc)).toBe(500);
      });

      it('should extract string capacityKW and parse', () => {
        const vc = createValidVC({ credentialSubject: { capacityKW: '750' } });
        expect(extractCapacity(vc)).toBe(750);
      });

      it('should extract installedCapacityKW as fallback', () => {
        const vc = createValidVC({ credentialSubject: { installedCapacityKW: 1000 } });
        expect(extractCapacity(vc)).toBe(1000);
      });

      it('should return undefined when no capacity found', () => {
        const vc = createValidVC({ credentialSubject: {} });
        expect(extractCapacity(vc)).toBeUndefined();
      });
    });

    describe('extractSourceType', () => {
      it('should extract generationType', () => {
        const vc = createValidVC({ credentialSubject: { generationType: 'SOLAR' } });
        expect(extractSourceType(vc)).toBe('SOLAR');
      });

      it('should extract sourceType as fallback', () => {
        const vc = createValidVC({ credentialSubject: { sourceType: 'WIND' } });
        expect(extractSourceType(vc)).toBe('WIND');
      });

      it('should return undefined when no source type found', () => {
        const vc = createValidVC({ credentialSubject: {} });
        expect(extractSourceType(vc)).toBeUndefined();
      });
    });

    describe('extractFullName', () => {
      it('should extract fullName', () => {
        const vc = createValidVC({ credentialSubject: { fullName: 'John Doe' } });
        expect(extractFullName(vc)).toBe('John Doe');
      });

      it('should extract providerName as fallback', () => {
        const vc = createValidVC({ credentialSubject: { providerName: 'Solar Co' } });
        expect(extractFullName(vc)).toBe('Solar Co');
      });
    });

    describe('extractNormalizedGenerationClaims', () => {
      it('should extract all normalized claims', () => {
        const vc = createValidVC({
          issuer: 'did:example:issuer',
          credentialSubject: {
            id: 'subject-1',
            fullName: 'Test User',
            capacityKW: 500,
            generationType: 'SOLAR',
            meterNumber: 'MTR-123',
            consumerNumber: 'CON-456',
            commissioningDate: '2023-06-01',
          },
        });

        const claims = extractNormalizedGenerationClaims(vc);

        expect(claims.id).toBe('subject-1');
        expect(claims.fullName).toBe('Test User');
        expect(claims.capacityKW).toBe(500);
        expect(claims.sourceType).toBe('SOLAR');
        expect(claims.meterNumber).toBe('MTR-123');
        expect(claims.consumerNumber).toBe('CON-456');
        expect(claims.commissioningDate).toBe('2023-06-01');
        expect(claims.issuer).toBe('did:example:issuer');
      });
    });
  });

  describe('Utility Functions', () => {
    describe('getIssuerId', () => {
      it('should return string issuer directly', () => {
        expect(getIssuerId('did:example:123')).toBe('did:example:123');
      });

      it('should return id from object issuer', () => {
        expect(getIssuerId({ id: 'did:example:456', name: 'Issuer' })).toBe('did:example:456');
      });
    });

    describe('getIssuanceDate', () => {
      it('should return issuanceDate when present', () => {
        const vc = createValidVC({ issuanceDate: '2024-01-01T00:00:00Z' });
        expect(getIssuanceDate(vc)).toBe('2024-01-01T00:00:00Z');
      });

      it('should return validFrom when issuanceDate is missing', () => {
        const vc = createValidVC({ validFrom: '2024-06-01T00:00:00Z' });
        delete (vc as any).issuanceDate;
        expect(getIssuanceDate(vc)).toBe('2024-06-01T00:00:00Z');
      });
    });

    describe('getExpirationDate', () => {
      it('should return expirationDate when present', () => {
        const vc = createValidVC({ expirationDate: '2025-01-01T00:00:00Z' });
        expect(getExpirationDate(vc)).toBe('2025-01-01T00:00:00Z');
      });

      it('should return validUntil when expirationDate is missing', () => {
        const vc = createValidVC({ validUntil: '2025-06-01T00:00:00Z' });
        expect(getExpirationDate(vc)).toBe('2025-06-01T00:00:00Z');
      });
    });
  });

  describe('verifyGenerationProfile', () => {
    it('should verify and extract generation profile', async () => {
      const vc = createValidVC({
        type: ['VerifiableCredential', 'GenerationProfileCredential'],
        credentialSubject: {
          providerId: 'P123',
          capacityKW: 500,
          generationType: 'SOLAR',
        },
      });

      const result = await verifyGenerationProfile(vc);

      expect(result.verified).toBe(true);
      expect(result.generationProfile).toBeDefined();
    });

    it('should fail when GenerationProfileCredential type is missing', async () => {
      const vc = createValidVC({
        type: ['VerifiableCredential'],
      });

      const result = await verifyGenerationProfile(vc);

      expect(result.checks.some(c => c.check === 'expectedTypes')).toBe(true);
    });
  });
});
