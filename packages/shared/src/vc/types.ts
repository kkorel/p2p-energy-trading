/**
 * Verifiable Credentials Types for P2P Energy Trading
 * Based on W3C VC Data Model and IES Energy Credentials schemas
 */

// =============================================================================
// W3C Verifiable Credentials Core Types
// =============================================================================

/**
 * JSON-LD Context - can be a string URI or an object with term definitions
 */
export type ContextEntry = string | Record<string, unknown>;

/**
 * Proof types supported for VC verification
 */
export type ProofType =
  | 'Ed25519Signature2020'
  | 'Ed25519Signature2018'
  | 'JsonWebSignature2020'
  | 'EcdsaSecp256k1Signature2019'
  | 'RsaSignature2018'
  | string; // Allow other proof types

/**
 * Cryptographic proof attached to a VC
 */
export interface VCProof {
  type: ProofType;
  created: string; // ISO 8601 datetime
  verificationMethod: string; // DID URL or key ID
  proofPurpose: 'assertionMethod' | 'authentication' | 'keyAgreement' | string;
  proofValue?: string; // Base64/Base58 encoded signature
  jws?: string; // JSON Web Signature (alternative to proofValue)
  challenge?: string; // For presentations
  domain?: string; // For presentations
}

/**
 * Credential Status for revocation checking
 */
export interface CredentialStatus {
  id: string;
  type: string;
  statusListIndex?: string;
  statusListCredential?: string;
}

/**
 * Issuer can be a simple DID string or an object with additional metadata
 */
export type VCIssuer = string | {
  id: string;
  name?: string;
  url?: string;
  image?: string;
  [key: string]: unknown;
};

/**
 * Base Verifiable Credential structure (W3C VC Data Model 2.0)
 */
export interface VerifiableCredential<T = Record<string, unknown>> {
  '@context': ContextEntry[];
  id?: string;
  type: string[];
  issuer: VCIssuer;
  issuanceDate?: string; // VC 1.1 (deprecated in 2.0)
  validFrom?: string; // VC 2.0
  validUntil?: string; // VC 2.0
  expirationDate?: string; // VC 1.1 (deprecated in 2.0)
  credentialSubject: T & { id?: string };
  credentialStatus?: CredentialStatus;
  credentialSchema?: {
    id: string;
    type: string;
  };
  proof?: VCProof | VCProof[];
}

/**
 * Verifiable Presentation wrapping one or more VCs
 */
export interface VerifiablePresentation {
  '@context': ContextEntry[];
  id?: string;
  type: string[];
  holder?: string;
  verifiableCredential: VerifiableCredential[];
  proof?: VCProof | VCProof[];
}

// =============================================================================
// IES Energy Credentials - Generation Profile
// =============================================================================

/**
 * Energy source types for generation profile
 */
export type EnergySourceType = 
  | 'SOLAR' | 'Solar' | 'solar'
  | 'WIND' | 'Wind' | 'wind'
  | 'HYDRO' | 'Hydro' | 'hydro' | 'MicroHydro'
  | 'BIOMASS' | 'Biomass' | 'biomass'
  | 'HYBRID' | 'Hybrid' | 'hybrid'
  | 'OTHER' | 'Other' | 'other'
  | string;

/**
 * Grid connection status
 */
export type GridConnectionStatus = 'CONNECTED' | 'DISCONNECTED' | 'PENDING' | string;

/**
 * Generation Profile Credential Subject (IES Format)
 * Matches the actual format from IES VC Portal
 * 
 * Example credentialSubject:
 * {
 *   "id": "did:example:generation-12345",
 *   "type": "GenerationProfileCredential",
 *   "fullName": "PRIYA SAMPLE",
 *   "capacityKW": "23",
 *   "generationType": "Solar",
 *   "meterNumber": "1234FGT",
 *   "consumerNumber": "12345",
 *   "commissioningDate": "2020-12-12"
 * }
 */
export interface GenerationProfileSubject {
  id?: string; // DID of the credential holder
  type?: string; // Credential type repeated in subject
  
  // IES Portal format fields
  fullName?: string;
  capacityKW?: string | number;
  generationType?: string;
  meterNumber?: string;
  consumerNumber?: string;
  commissioningDate?: string;
  assetId?: string;
  issuerName?: string;
  modelNumber?: string;
  manufacturer?: string;
  
  // Alternative field names (for flexibility)
  providerId?: string;
  providerName?: string;
  installedCapacityKW?: number;
  authorizedCapacityKW?: number;
  sourceType?: EnergySourceType;
  sourceDescription?: string;
  gridConnectionStatus?: GridConnectionStatus;
  meterId?: string;
  distributionUtility?: string;
  connectionVoltage?: string;
  
  // Location (optional)
  location?: {
    state?: string;
    district?: string;
    pincode?: string;
    coordinates?: {
      latitude: number;
      longitude: number;
    };
  };
  
  // Certifications
  certifications?: Array<{
    type: string;
    issuedBy: string;
    validUntil?: string;
  }>;
  
  // Allow additional fields
  [key: string]: unknown;
}

/**
 * Generation Profile Verifiable Credential
 */
export type GenerationProfileVC = VerifiableCredential<GenerationProfileSubject>;

// =============================================================================
// Beckn DEG Energy Credentials — Utility Customer
// =============================================================================

export interface UtilityCustomerSubject {
  id?: string;
  type?: string;
  consumerNumber?: string;
  fullName?: string;
  maskedIdNumber?: string;
  meterNumber?: string;
  serviceConnectionDate?: string;
  installationAddress?: string | {
    fullAddress?: string;
    city?: string;
    district?: string;
    stateProvince?: string;
    postalCode?: string;
    country?: string;
  };
  [key: string]: unknown;
}

export type UtilityCustomerVC = VerifiableCredential<UtilityCustomerSubject>;

// =============================================================================
// Beckn DEG Energy Credentials — Consumption Profile
// =============================================================================

export interface ConsumptionProfileSubject {
  id?: string;
  type?: string;
  consumerNumber?: string;
  fullName?: string;
  premisesType?: string;    // Residential/Commercial/Industrial/Agricultural
  connectionType?: string;  // Single-phase/Three-phase
  sanctionedLoadKW?: string | number;
  tariffCategoryCode?: string;
  meterNumber?: string;
  [key: string]: unknown;
}

export type ConsumptionProfileVC = VerifiableCredential<ConsumptionProfileSubject>;

// =============================================================================
// Beckn DEG Energy Credentials — Storage Profile
// =============================================================================

export interface StorageProfileSubject {
  id?: string;
  type?: string;
  consumerNumber?: string;
  fullName?: string;
  meterNumber?: string;
  assetId?: string;
  storageCapacityKWh?: string | number;
  powerRatingKW?: string | number;
  commissioningDate?: string;
  storageType?: string;     // LithiumIon/LeadAcid/FlowBattery/Other
  manufacturer?: string;
  modelNumber?: string;
  [key: string]: unknown;
}

export type StorageProfileVC = VerifiableCredential<StorageProfileSubject>;

// =============================================================================
// Beckn DEG Energy Credentials — Program Enrollment
// =============================================================================

export interface ProgramEnrollmentSubject {
  id?: string;
  type?: string;
  consumerNumber?: string;
  fullName?: string;
  programName?: string;
  programCode?: string;
  enrollmentDate?: string;
  validUntil?: string;
  [key: string]: unknown;
}

export type ProgramEnrollmentVC = VerifiableCredential<ProgramEnrollmentSubject>;

// =============================================================================
// DEG Credential Type Union
// =============================================================================

export type DEGCredentialType =
  | 'UtilityCustomerCredential'
  | 'ConsumptionProfileCredential'
  | 'GenerationProfileCredential'
  | 'StorageProfileCredential'
  | 'UtilityProgramEnrollmentCredential';

// =============================================================================
// IES Energy Credentials - Grid Connection
// =============================================================================

/**
 * Grid Connection Credential Subject
 */
export interface GridConnectionSubject {
  id?: string;
  
  // Connection details
  connectionId: string;
  meterId: string;
  sanctionedLoad: number;
  contractDemand?: number;
  
  // Utility information
  distributionUtility: string;
  division?: string;
  circle?: string;
  
  // Connection type
  connectionType: 'LT' | 'HT' | 'EHT';
  voltageLevel: string;
  phaseType: 'SINGLE' | 'THREE';
  
  // Billing
  tariffCategory: string;
  billingCycle?: string;
  
  // Status
  status: 'ACTIVE' | 'DISCONNECTED' | 'SUSPENDED';
  connectionDate?: string;
}

/**
 * Grid Connection Verifiable Credential
 */
export type GridConnectionVC = VerifiableCredential<GridConnectionSubject>;

// =============================================================================
// Verification Types
// =============================================================================

/**
 * Verification check result
 */
export interface VerificationCheck {
  check: string;
  status: 'passed' | 'failed' | 'warning' | 'skipped';
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Overall verification result
 */
export interface VerificationResult {
  verified: boolean;
  credentialId?: string;
  issuer?: string;
  issuanceDate?: string;
  expirationDate?: string;
  checks: VerificationCheck[];
  claims?: Record<string, unknown>;
  error?: string;
}

/**
 * Options for VC verification
 */
export interface VerificationOptions {
  /**
   * List of trusted issuer DIDs
   */
  trustedIssuers?: string[];
  
  /**
   * Whether to check credential status (revocation)
   */
  checkStatus?: boolean;
  
  /**
   * Whether to verify the cryptographic proof
   */
  verifyProof?: boolean;
  
  /**
   * Expected credential types
   */
  expectedTypes?: string[];
  
  /**
   * Current time for expiration check (defaults to now)
   */
  currentTime?: Date;
}

// =============================================================================
// VC Portal API Types
// =============================================================================

/**
 * VC Portal authentication
 */
export interface VCPortalAuth {
  type: 'bearer' | 'api_key';
  token?: string;
  apiKey?: string;
}

/**
 * VC Portal fetch options
 */
export interface VCPortalFetchOptions {
  vcId?: string;
  holderId?: string;
  type?: string;
  limit?: number;
}

/**
 * VC Portal verification request
 */
export interface VCPortalVerifyRequest {
  credential: VerifiableCredential;
  options?: VerificationOptions;
}

/**
 * VC Portal verification response
 */
export interface VCPortalVerifyResponse {
  verified: boolean;
  result: VerificationResult;
  timestamp: string;
}

// =============================================================================
// Settlement Integration Types
// =============================================================================

/**
 * VC-based settlement verification input
 */
export interface VCSettlementInput {
  tradeId: string;
  credential: VerifiableCredential;
  expectedProviderId?: string;
  minCapacity?: number;
}

/**
 * VC-based settlement verification output
 */
export interface VCSettlementResult {
  tradeId: string;
  outcome: 'SUCCESS' | 'FAIL';
  verificationResult: VerificationResult;
  vcId?: string;
  vcIssuer?: string;
  claims?: Record<string, unknown>;
}
