'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/api';
import {
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sun,
  Battery,
  Gauge,
  ArrowRight,
  FileJson,
} from 'lucide-react';

type CredentialType = 'UTILITY_CUSTOMER' | 'GENERATION_PROFILE' | 'STORAGE_PROFILE' | 'CONSUMPTION_PROFILE';

// Progress steps for the status bar
const STEPS = [
  { id: 'utility', label: 'Utility VC' },
  { id: 'role', label: 'Select Role' },
  { id: 'credentials', label: 'Role VCs' },
];

interface UploadedVC {
  type: CredentialType;
  verified: boolean;
  claims?: any;
}

export default function CredentialsOnboarding() {
  const router = useRouter();

  // Pending auth state from login flow
  const [userId, setUserId] = useState<string | null>(null);

  // Credential state
  const [uploadedVCs, setUploadedVCs] = useState<UploadedVC[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isCompletingSignup, setIsCompletingSignup] = useState(false);

  // Role selection
  const [selectedRole, setSelectedRole] = useState<'seller' | 'buyer' | 'both' | null>(null);

  // Check status
  const hasUtilityVC = uploadedVCs.some(vc => vc.type === 'UTILITY_CUSTOMER' && vc.verified);
  const hasGenerationVC = uploadedVCs.some(vc => vc.type === 'GENERATION_PROFILE' && vc.verified);
  const hasStorageVC = uploadedVCs.some(vc => vc.type === 'STORAGE_PROFILE' && vc.verified);
  const hasConsumptionVC = uploadedVCs.some(vc => vc.type === 'CONSUMPTION_PROFILE' && vc.verified);
  const hasSellerVC = hasGenerationVC || hasStorageVC;
  const hasBuyerVC = hasConsumptionVC;

  // Can complete based on role
  const canComplete =
    hasUtilityVC &&
    ((selectedRole === 'seller' && hasSellerVC) ||
      (selectedRole === 'buyer' && hasBuyerVC) ||
      (selectedRole === 'both' && hasSellerVC && hasBuyerVC));

  // Determine current step for progress bar
  const getCurrentStep = () => {
    if (!hasUtilityVC) return 0;
    if (!selectedRole) return 1;
    return 2;
  };
  const currentStep = getCurrentStep();

  // Load pending auth data from session storage
  useEffect(() => {
    const storedUserId = sessionStorage.getItem('pendingUserId');

    if (!storedUserId) {
      // No pending auth, redirect to login
      router.push('/');
      return;
    }

    setUserId(storedUserId);
  }, [router]);

  // Handle file upload
  const handleFileUpload = useCallback(
    async (file: File, expectedType?: CredentialType) => {
      if (!userId) return;

      setIsUploading(true);
      setUploadError(null);

      try {
        // Read file as text and parse JSON
        const jsonText = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsText(file);
        });

        let credential: any;
        try {
          credential = JSON.parse(jsonText);
        } catch {
          setUploadError('Invalid JSON file. Please upload a valid credential JSON.');
          setIsUploading(false);
          return;
        }

        // Upload to pre-auth endpoint (send as JSON credential, not base64)
        const result = await authApi.verifyCredentialPreauth(userId, undefined, credential);

        if (result.success && result.verification.verified) {
          setUploadedVCs(prev => [
            ...prev.filter(vc => vc.type !== result.credentialType),
            {
              type: result.credentialType as CredentialType,
              verified: true,
              claims: result.extractedClaims,
            },
          ]);
        } else {
          setUploadError(
            `Credential verification failed. Please ensure you have a valid ${expectedType || 'credential'} JSON file.`
          );
        }
      } catch (err: any) {
        setUploadError(err.message || 'Failed to upload credential');
      } finally {
        setIsUploading(false);
      }
    },
    [userId]
  );

  // Complete signup (uses new endpoint that doesn't require OTP)
  const handleCompleteSignup = async () => {
    if (!userId || !canComplete) return;

    setIsCompletingSignup(true);
    try {
      // Use completeSignup endpoint instead of login (no OTP needed)
      const result = await authApi.completeSignup(userId);

      // Store token and trigger auth state update
      localStorage.setItem('authToken', result.token);
      window.dispatchEvent(new Event('auth:login'));

      // Clear session storage
      sessionStorage.removeItem('pendingUserId');
      sessionStorage.removeItem('pendingPhone');
      sessionStorage.removeItem('pendingOtp');
      sessionStorage.removeItem('pendingName');
      sessionStorage.removeItem('requiredVCs');

      // Redirect to home
      router.push('/');
    } catch (err: any) {
      setUploadError(err.message || 'Failed to complete signup. Please try again.');
      setIsCompletingSignup(false);
    }
  };

  // File input ref for triggering upload
  const createFileInput = (onUpload: (file: File) => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) onUpload(file);
    };
    input.click();
  };

  if (!userId) {
    return (
      <div className="min-h-screen bg-[var(--color-surface)] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--color-primary)]" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-surface)] flex flex-col items-center">
      <div className="max-w-[480px] mx-auto w-full min-h-screen flex flex-col px-4 py-8 bg-[var(--color-bg)] shadow-[var(--shadow-sm)]">
        {/* Progress Status Bar */}
        <div className="mb-6">
          <div className="flex items-center justify-center">
            {STEPS.map((step, index) => (
              <div key={step.id} className="flex items-center">
                <div className="flex flex-col items-center w-20">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                      index < currentStep
                        ? 'bg-[var(--color-success)] text-white'
                        : index === currentStep
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'bg-[var(--color-border)] text-[var(--color-text-muted)]'
                    }`}
                  >
                    {index < currentStep ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : (
                      index + 1
                    )}
                  </div>
                  <span
                    className={`text-[10px] mt-1 text-center ${
                      index <= currentStep
                        ? 'text-[var(--color-text)]'
                        : 'text-[var(--color-text-muted)]'
                    }`}
                  >
                    {step.label}
                  </span>
                </div>
                {index < STEPS.length - 1 && (
                  <div
                    className={`h-[2px] w-12 transition-colors ${
                      index < currentStep
                        ? 'bg-[var(--color-success)]'
                        : 'bg-[var(--color-border)]'
                    }`}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Header */}
        <div className="flex flex-col items-center pt-2 pb-6">
          <div className="w-14 h-14 bg-[var(--color-primary-light)] rounded-[16px] flex items-center justify-center mb-3">
            <Zap className="h-7 w-7 text-[var(--color-primary)]" />
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-text)] mb-1">Verify Your Credentials</h1>
          <p className="text-sm text-[var(--color-text-muted)] text-center">
            Upload your verifiable credentials to complete signup
          </p>
        </div>

        {/* Error message */}
        {uploadError && (
          <div className="mb-4 p-3 rounded-[12px] bg-[var(--color-danger-light)] flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-[var(--color-danger)] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[var(--color-danger)]">{uploadError}</p>
          </div>
        )}

        {/* Step 1: Utility VC */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                hasUtilityVC
                  ? 'bg-[var(--color-success)] text-white'
                  : 'bg-[var(--color-primary)] text-white'
              }`}
            >
              {hasUtilityVC ? <CheckCircle2 className="w-4 h-4" /> : '1'}
            </div>
            <h2 className="text-base font-medium text-[var(--color-text)]">Utility Customer Credential</h2>
          </div>

          {hasUtilityVC ? (
            <div className="p-4 rounded-[14px] bg-[var(--color-success-light)] border border-[var(--color-success)]/30">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-[var(--color-success)]" />
                <span className="text-sm font-medium text-[var(--color-success)]">
                  Utility credential verified
                </span>
              </div>
              {uploadedVCs.find(vc => vc.type === 'UTILITY_CUSTOMER')?.claims?.consumerNumber && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1 ml-7">
                  Consumer #: {uploadedVCs.find(vc => vc.type === 'UTILITY_CUSTOMER')?.claims?.consumerNumber}
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => createFileInput((file) => handleFileUpload(file, 'UTILITY_CUSTOMER'))}
              disabled={isUploading}
              className="w-full p-4 rounded-[14px] border-2 border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex flex-col items-center gap-2"
            >
              {isUploading ? (
                <Loader2 className="w-8 h-8 animate-spin text-[var(--color-primary)]" />
              ) : (
                <>
                  <FileJson className="w-8 h-8 text-[var(--color-text-muted)]" />
                  <span className="text-sm text-[var(--color-text-muted)]">
                    Upload Utility Customer VC (JSON)
                  </span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Step 2: Role Selection */}
        {hasUtilityVC && !selectedRole && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-full bg-[var(--color-primary)] flex items-center justify-center text-xs font-medium text-white">
                2
              </div>
              <h2 className="text-base font-medium text-[var(--color-text)]">What do you want to do?</h2>
            </div>

            <div className="flex flex-col gap-3">
              <button
                onClick={() => setSelectedRole('seller')}
                className="p-4 rounded-[14px] border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-[12px] bg-[var(--color-warning-light)] flex items-center justify-center">
                  <Sun className="w-5 h-5 text-[var(--color-warning)]" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-[var(--color-text)]">Sell Energy</p>
                  <p className="text-xs text-[var(--color-text-muted)]">I have solar/storage and want to sell</p>
                </div>
              </button>

              <button
                onClick={() => setSelectedRole('buyer')}
                className="p-4 rounded-[14px] border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-[12px] bg-[var(--color-primary-light)] flex items-center justify-center">
                  <Gauge className="w-5 h-5 text-[var(--color-primary)]" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-[var(--color-text)]">Buy Energy</p>
                  <p className="text-xs text-[var(--color-text-muted)]">I want to buy renewable energy</p>
                </div>
              </button>

              <button
                onClick={() => setSelectedRole('both')}
                className="p-4 rounded-[14px] border border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
              >
                <div className="w-10 h-10 rounded-[12px] bg-[var(--color-success-light)] flex items-center justify-center">
                  <Zap className="w-5 h-5 text-[var(--color-success)]" />
                </div>
                <div className="text-left">
                  <p className="text-sm font-medium text-[var(--color-text)]">Buy & Sell</p>
                  <p className="text-xs text-[var(--color-text-muted)]">I want to do both</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Role-specific VCs */}
        {hasUtilityVC && selectedRole && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
                  canComplete
                    ? 'bg-[var(--color-success)] text-white'
                    : 'bg-[var(--color-primary)] text-white'
                }`}
              >
                {canComplete ? <CheckCircle2 className="w-4 h-4" /> : '3'}
              </div>
              <h2 className="text-base font-medium text-[var(--color-text)]">
                {selectedRole === 'seller' && 'Seller Credentials'}
                {selectedRole === 'buyer' && 'Buyer Credentials'}
                {selectedRole === 'both' && 'Trading Credentials'}
              </h2>
            </div>

            {/* Seller VCs */}
            {(selectedRole === 'seller' || selectedRole === 'both') && (
              <div className="mb-4">
                <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">
                  For Selling (one required)
                </p>

                {/* Generation VC */}
                {hasGenerationVC ? (
                  <div className="p-3 rounded-[12px] bg-[var(--color-success-light)] border border-[var(--color-success)]/30 mb-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />
                      <span className="text-sm text-[var(--color-success)]">Generation Profile verified</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => createFileInput((file) => handleFileUpload(file, 'GENERATION_PROFILE'))}
                    disabled={isUploading}
                    className="w-full p-3 mb-2 rounded-[12px] border border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
                  >
                    <Sun className="w-5 h-5 text-[var(--color-text-muted)]" />
                    <span className="text-sm text-[var(--color-text-muted)]">Upload Generation Profile VC</span>
                  </button>
                )}

                {/* Storage VC */}
                {hasStorageVC ? (
                  <div className="p-3 rounded-[12px] bg-[var(--color-success-light)] border border-[var(--color-success)]/30">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />
                      <span className="text-sm text-[var(--color-success)]">Storage Profile verified</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => createFileInput((file) => handleFileUpload(file, 'STORAGE_PROFILE'))}
                    disabled={isUploading}
                    className="w-full p-3 rounded-[12px] border border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
                  >
                    <Battery className="w-5 h-5 text-[var(--color-text-muted)]" />
                    <span className="text-sm text-[var(--color-text-muted)]">Upload Storage Profile VC</span>
                  </button>
                )}
              </div>
            )}

            {/* Buyer VC */}
            {(selectedRole === 'buyer' || selectedRole === 'both') && (
              <div>
                <p className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">
                  For Buying (required)
                </p>

                {hasConsumptionVC ? (
                  <div className="p-3 rounded-[12px] bg-[var(--color-success-light)] border border-[var(--color-success)]/30">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />
                      <span className="text-sm text-[var(--color-success)]">Consumption Profile verified</span>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => createFileInput((file) => handleFileUpload(file, 'CONSUMPTION_PROFILE'))}
                    disabled={isUploading}
                    className="w-full p-3 rounded-[12px] border border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] transition-colors flex items-center gap-3"
                  >
                    <Gauge className="w-5 h-5 text-[var(--color-text-muted)]" />
                    <span className="text-sm text-[var(--color-text-muted)]">Upload Consumption Profile VC</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Complete Signup Button */}
        <div className="mt-auto pb-8">
          <button
            onClick={handleCompleteSignup}
            disabled={!canComplete || isCompletingSignup}
            className="h-[44px] w-full rounded-[12px] bg-[var(--color-primary)] text-white text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isCompletingSignup ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Completing signup...
              </>
            ) : (
              <>
                Complete Signup
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          {!canComplete && hasUtilityVC && selectedRole && (
            <p className="text-xs text-[var(--color-text-muted)] text-center mt-3">
              Upload the required credentials above to continue
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
