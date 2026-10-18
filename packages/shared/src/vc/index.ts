/**
 * Verifiable Credentials Module
 * Export all VC-related types, utilities, and clients
 */

// Export all types
export * from './types';

// Export verifier functions
export {
  // Core verification
  verifyCredential,
  parseAndVerifyCredential,
  
  // Structure validation
  validateVCStructure,
  validateProofStructure,
  
  // Individual checks
  checkExpiration,
  checkIssuanceDate,
  checkTrustedIssuer,
  checkCredentialTypes,
  
  // Proof verification (placeholder)
  verifyProof,
  
  // Utility functions
  getIssuerId,
  getIssuanceDate,
  getExpirationDate,
  
  // Energy credential helpers
  verifyGenerationProfile,
  verifyGridConnection,
  extractProviderId,
  extractCapacity,
  extractSourceType,
  extractFullName,
  extractNormalizedGenerationClaims,
  validateProviderMatch,

  // Multi-credential detection & extraction (Beckn DEG)
  detectCredentialType,
  extractNormalizedUtilityCustomerClaims,
  extractNormalizedConsumptionProfileClaims,
  extractNormalizedStorageProfileClaims,
  extractNormalizedProgramEnrollmentClaims,
} from './verifier';

// Export portal client
export {
  // Client class
  VCPortalClient,
  VCPortalError,
  
  // Singleton management
  getPortalClient,
  configurePortalClient,
  getPortalUrl,
  
  // Convenience functions
  verifyWithPortal,
  fetchAndVerify,
} from './portal';
