// API base is empty since we use Next.js rewrites to proxy to the backend
const API_BASE = '';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

function getAuthHeaders(): HeadersInit {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('authToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const authHeaders = getAuthHeaders();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...authHeaders,
    ...options.headers,
  };

  // Debug: log auth status
  if (typeof window !== 'undefined') {
    const hasToken = !!localStorage.getItem('authToken');
    console.log(`[API] ${options.method || 'GET'} ${endpoint} - Token: ${hasToken ? 'present' : 'MISSING'}`);
  }

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    // Clear auth and trigger re-auth
    if (typeof window !== 'undefined') {
      localStorage.removeItem('authToken');
      window.dispatchEvent(new CustomEvent('auth:logout'));
    }
    throw new ApiError('Unauthorized', 401);
  }

  if (!res.ok) {
    const errorBody = await res.text();
    let errorMessage = 'Request failed';
    try {
      const error = JSON.parse(errorBody);
      errorMessage = error.error || error.message || 'Request failed';
    } catch {
      errorMessage = errorBody || 'Request failed';
    }
    console.error(`API Error [${res.status}] ${endpoint}:`, errorMessage);
    throw new ApiError(errorMessage, res.status);
  }

  return res.json();
}

// Auth APIs
export const authApi = {
  checkPhone: (phone: string) =>
    request<{
      success: boolean;
      exists: boolean;
      name: string | null;
      profileComplete: boolean;
    }>(`/auth/check-phone/${encodeURIComponent(phone)}`),

  sendOtp: (phone: string) =>
    request<{ success: boolean; message: string }>('/auth/send-otp', {
      method: 'POST',
      body: JSON.stringify({ phone }),
    }),

  verifyOtp: async (phone: string, otp: string, name?: string): Promise<VerifyOtpResponse> => {
    const res = await fetch('/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp, name }),
    });

    const data = await res.json();

    // Handle 403 - requires VCs for signup
    if (res.status === 403 && data.requiresVC) {
      return {
        success: false,
        requiresVC: data.requiresVC,
        userId: data.userId,
        isNewUser: data.isNewUser,
        message: data.message,
      };
    }

    if (!res.ok) {
      throw new ApiError(data.error || data.message || 'Verification failed', res.status);
    }

    return {
      success: true,
      token: data.token,
      user: data.user,
      isNewUser: data.isNewUser,
    };
  },

  // Pre-auth VC upload (for signup flow before user has a session)
  verifyCredentialPreauth: (userId: string, pdfBase64?: string, credential?: any) =>
    request<{
      success: boolean;
      credentialType: string;
      verification: { verified: boolean; checks: any[]; extractionMethod: string };
      extractedClaims: any;
      credentials: Array<{ type: string; verified: boolean; verifiedAt: string | null }>;
      signupReady: boolean;
      missing: { utilityVC: boolean; roleVC: boolean };
    }>('/auth/verify-credential-preauth', {
      method: 'POST',
      body: JSON.stringify({ userId, pdfBase64, credential }),
    }),

  // Complete signup after VCs uploaded (no OTP needed)
  completeSignup: (userId: string) =>
    request<{
      success: boolean;
      token: string;
      user: User;
    }>('/auth/complete-signup', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  getMe: () =>
    request<{ user: User }>('/auth/me'),

  updateProfile: (data: { name?: string; productionCapacity?: number }) =>
    request<{ success: boolean; user: User }>('/auth/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  analyzeMeter: (pdfBase64: string) =>
    request<{
      success: boolean;
      message: string;
      analysis: {
        extractedCapacity: number | null;
        declaredCapacity: number;
        quality: 'HIGH' | 'MEDIUM' | 'LOW';
        matchesDeclaration: boolean;
        insights: string;
      };
      trustBonus: string | null;
      user: User;
    }>('/auth/analyze-meter', {
      method: 'POST',
      body: JSON.stringify({ pdfBase64 }),
    }),

  resetMeter: () =>
    request<{ success: boolean; message: string }>('/auth/reset-meter', {
      method: 'POST',
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  getBalance: () =>
    request<{ success: boolean; balance: number }>('/auth/balance'),

  updateBalance: (balance: number) =>
    request<{ success: boolean; balance: number }>('/auth/balance', {
      method: 'PUT',
      body: JSON.stringify({ balance }),
    }),

  processPayment: (params: { orderId: string; amount: number; sellerId?: string }) =>
    request<{
      success: boolean;
      message: string;
      payment: {
        orderId: string;
        amount: number;
        platformFee: number;
        totalDeducted: number;
        sellerReceived: number;
      };
      newBalance: number;
    }>('/auth/payment', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Verifiable Credentials API
  getCredentials: () =>
    request<{
      success: boolean;
      credentials: VCCredential[];
      totalVerified: number;
      totalPending: number;
    }>('/auth/me/credentials'),

  verifyVcPdf: (pdfBase64: string) =>
    request<{
      success: boolean;
      verification: {
        verified: boolean;
        checks: VCCheck[];
        extractionMethod: 'json' | 'llm' | 'direct';
      };
      generationProfile: {
        fullName?: string;
        capacityKW?: number;
        sourceType?: string;
        meterNumber?: string;
        consumerNumber?: string;
      };
      user: User;
    }>('/auth/verify-vc-pdf', {
      method: 'POST',
      body: JSON.stringify({ pdfBase64 }),
    }),

  verifyVcJson: (credential: object) =>
    request<{
      success: boolean;
      verification: {
        verified: boolean;
        checks: VCCheck[];
        extractionMethod: 'json' | 'llm' | 'direct';
      };
      generationProfile: {
        fullName?: string;
        capacityKW?: number;
        sourceType?: string;
        meterNumber?: string;
        consumerNumber?: string;
      };
      user: User;
    }>('/auth/verify-vc-pdf', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),

  verifyVC: (params: { credential?: object; vcId?: string; options?: object }) =>
    request<{
      success: boolean;
      verified: boolean;
      credentialId: string;
      credentialType: string[];
      issuer: string;
      subject: string;
      fetchedFromPortal: boolean;
      checks: VCCheck[];
      error?: string;
    }>('/auth/vc/verify', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Multi-credential onboarding (Beckn DEG)
  verifyCredential: (params: { credential?: object; pdfBase64?: string }) =>
    request<VerifyCredentialResponse>('/auth/verify-credential', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  completeOnboarding: () =>
    request<CompleteOnboardingResponse>('/auth/complete-onboarding', {
      method: 'POST',
    }),

  getCredentialsList: () =>
    request<{
      success: boolean;
      credentials: CredentialInfo[];
      totalVerified: number;
      totalPending: number;
    }>('/auth/me/credentials'),
};

// Chat APIs (Oorja agent)
export const chatApi = {
  send: (message: string, sessionId?: string, displayText?: string) =>
    request<{
      success: boolean;
      sessionId: string;
      messages: Array<{ role: 'agent'; content: string; buttons?: Array<{ text: string; callbackData?: string }> }>;
      authToken?: string;
      voiceOutputEnabled?: boolean;
      responseLanguage?: string;
    }>('/chat/send', {
      method: 'POST',
      body: JSON.stringify({ message, sessionId, displayText }),
    }),

  upload: (pdfBase64: string, sessionId?: string, fileName?: string) =>
    request<{
      success: boolean;
      sessionId: string;
      messages: Array<{ role: 'agent'; content: string; buttons?: Array<{ text: string; callbackData?: string }> }>;
      authToken?: string;
      responseLanguage?: string;
    }>('/chat/upload', {
      method: 'POST',
      body: JSON.stringify({ pdfBase64, sessionId, fileName }),
    }),

  /**
   * Send voice audio for transcription and agent response
   */
  voice: (audio: string, mimeType: string, sessionId?: string) =>
    request<{
      success: boolean;
      sessionId: string;
      transcript: string;
      language: string;
      languageName: string;
      processingTimeMs: number;
      messages: Array<{ role: 'agent'; content: string; buttons?: Array<{ text: string; callbackData?: string }> }>;
      authToken?: string;
      responseLanguage?: string;
      voiceOutputEnabled?: boolean;
    }>('/chat/voice', {
      method: 'POST',
      body: JSON.stringify({ audio, mimeType, sessionId }),
    }),

  /**
   * Convert text to speech using Sarvam Bulbul model
   */
  tts: (text: string, languageCode: string, speaker?: string, pace?: number) =>
    request<{
      success: boolean;
      audio: string; // base64 WAV
      mimeType: string;
      durationMs: number;
      languageCode: string;
    }>('/chat/tts', {
      method: 'POST',
      body: JSON.stringify({ text, languageCode, speaker, pace }),
    }),

  getHistory: (sessionId?: string) =>
    request<{
      success: boolean;
      messages: Array<{ role: 'agent' | 'user'; content: string; buttons?: Array<{ text: string; callbackData?: string }>; createdAt: string }>;
      state: string | null;
      responseLanguage?: string;
    }>(`/chat/history${sessionId ? `?sessionId=${sessionId}` : ''}`),

  reset: (sessionId?: string) =>
    request<{ success: boolean }>('/chat/reset', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    }),
};

// Buyer APIs
export const buyerApi = {
  discover: (params: DiscoverParams) =>
    request<{
      status: string;
      transaction_id: string;
      message_id: string;
    }>('/api/discover', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  createTransaction: () =>
    request<{ transaction_id: string }>('/api/transactions', {
      method: 'POST',
    }),

  getTransaction: (transactionId: string) =>
    request<TransactionState>(`/api/transactions/${transactionId}`),

  select: (params: SelectParams) =>
    request<{
      status: string;
      transaction_id: string;
      selected_offer: any;
    }>('/api/select', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  bulkSelect: (params: BulkSelectParams) =>
    request<BulkSelectResponse>('/api/select', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  smartBuy: (params: SmartBuyParams) =>
    request<SmartBuyResponse>('/api/select', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  init: (transactionId: string) =>
    request<{ status: string }>('/api/init', {
      method: 'POST',
      body: JSON.stringify({ transaction_id: transactionId }),
    }),

  confirm: (transactionId: string, orderId?: string) =>
    request<{ status: string }>('/api/confirm', {
      method: 'POST',
      body: JSON.stringify({ transaction_id: transactionId, order_id: orderId }),
    }),

  getMyOrders: () =>
    request<{ orders: BuyerOrder[] }>('/api/my-orders'),

  cancelOrder: (params: { transaction_id: string; order_id: string; reason?: string }) =>
    request<{ status: string; message?: string }>('/api/cancel', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};

// Settlement/Payment APIs
export const settlementApi = {
  getSettlement: (tradeId: string) =>
    request<SettlementResponse>(`/api/settlement/${tradeId}`),

  initiate: (params: { tradeId?: string; order_id?: string; transaction_id?: string }) =>
    request<SettlementResponse>('/api/settlement/initiate', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  confirmFunded: (tradeId: string, receipt: string) =>
    request<SettlementResponse>('/api/settlement/confirm-funded', {
      method: 'POST',
      body: JSON.stringify({ tradeId, receipt }),
    }),

  verifyOutcome: (tradeId: string, outcome: 'RELEASE' | 'REFUND') =>
    request<SettlementResponse>('/api/settlement/verify-outcome', {
      method: 'POST',
      body: JSON.stringify({ tradeId, outcome }),
    }),

  confirmPayout: (tradeId: string, receipt: string) =>
    request<SettlementResponse>('/api/settlement/confirm-payout', {
      method: 'POST',
      body: JSON.stringify({ tradeId, receipt }),
    }),

  autoRun: (tradeId: string) =>
    request<SettlementResponse>('/api/settlement/auto-run', {
      method: 'POST',
      body: JSON.stringify({ tradeId }),
    }),

  reset: () =>
    request<{ status: string }>('/api/settlement/reset', { method: 'POST' }),
};

// Demo Account APIs
export const demoApi = {
  getAccounts: () =>
    request<{ accounts: DemoAccount[]; transactions: DemoTransaction[] }>('/api/demo/accounts'),

  getAccount: (id: string) =>
    request<{ account: DemoAccount }>(`/api/demo/accounts/${id}`),

  getTransactions: () =>
    request<{ transactions: DemoTransaction[] }>('/api/demo/transactions'),

  resetAccounts: () =>
    request<{ status: string; accounts: DemoAccount[] }>('/api/demo/accounts/reset', { method: 'POST' }),

  resetAll: () =>
    request<{ status: string; accounts: DemoAccount[] }>('/api/demo/reset-all', { method: 'POST' }),
};

// Seller APIs
export const sellerApi = {
  getMyProfile: () =>
    request<{
      success: boolean;
      provider: Provider;
      items: CatalogItem[];
      offers: Offer[];
      quotaStats?: {
        totalSold: number;
        totalUnsoldInOffers: number;
        totalCommitted: number;
      };
    }>('/seller/my-profile'),

  getMyOrders: () =>
    request<{ orders: Order[] }>('/seller/my-orders'),

  addItem: (data: AddItemParams) =>
    request<{ status: string; item: CatalogItem }>('/seller/items', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  addOffer: (data: AddOfferParams) =>
    request<{ status: string; offer: Offer }>('/seller/offers', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  addOfferDirect: (data: AddOfferDirectParams) =>
    request<{ status: string; offer: Offer }>('/seller/offers/direct', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteOffer: (id: string) =>
    request<{ status: string }>(`/seller/offers/${id}`, { method: 'DELETE' }),

  cancelOrder: (orderId: string, reason?: string) =>
    request<{ status: string; orderId: string; refundTotal?: number; sellerPenalty?: number }>(
      `/seller/orders/${orderId}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }
    ),

  getWeatherCapacity: () =>
    request<WeatherCapacityResponse>('/seller/weather/capacity'),

  getWeatherAlert: () =>
    request<WeatherAlertResponse>('/seller/weather/alert'),
};

// Types
export interface SolarAnalysis {
  available: boolean;
  latitude?: number | null;
  longitude?: number | null;
  formattedAddress?: string | null;
  maxSunshineHours?: number | null;
  maxPanelCount?: number | null;
  yearlyEnergyKwh?: number | null;
  roofAreaM2?: number | null;
  imageryQuality?: string | null;  // 'HIGH' | 'MEDIUM' | 'LOW'
  carbonOffsetKg?: number | null;
  installationScore: number;       // 0.0-1.0
  tradingLimitPercent: number;     // 7-15%
  verificationMethod: string;      // 'SOLAR_API' or 'DEFAULT'
  errorReason?: string | null;
  satelliteImageUrl?: string | null;
  analyzedAt: string;
}

export interface User {
  id: string;
  phone: string;
  name: string | null;
  profileComplete: boolean;
  balance: number;
  providerId: string | null;
  trustScore?: number;
  allowedTradeLimit?: number;
  meterDataAnalyzed?: boolean;
  productionCapacity?: number | null;
  meterVerifiedCapacity?: number | null;
  solarAnalysis?: SolarAnalysis | null;
}

// Response type for verifyOtp - can be success or requiresVC
export type VerifyOtpResponse =
  | { success: true; token: string; user: User; isNewUser: boolean }
  | { success: false; requiresVC: string[]; userId: string; isNewUser: boolean; message: string };

export interface Provider {
  id: string;
  name: string;
  trust_score: number;
  total_orders: number;
  successful_orders: number;
}

export interface CatalogItem {
  id: string;
  provider_id: string;
  source_type: 'SOLAR' | 'WIND' | 'HYDRO' | 'MIXED';
  delivery_mode: string;
  available_qty: number;
  meter_id: string;
}

export interface Offer {
  id: string;
  item_id: string;
  provider_id: string;
  source_type?: string;
  price: { value: number; currency: string };
  maxQuantity: number;
  timeWindow: { startTime: string; endTime: string } | null;
  blockStats?: {
    total: number;
    available: number;
    sold?: number;
    delivered?: number;
    activeCommitment?: number; // What counts against trade limit
  };
}

export interface Order {
  id: string;
  status: string;
  paymentStatus?: string;
  quote?: { price: { value: number }; totalQuantity: number };
  created_at: string;
  itemInfo?: {
    item_id: string;
    offer_id: string;
    sold_quantity: number;
    source_type?: string;
    price_per_kwh?: number;
  };
  cancellation?: {
    cancelledAt?: string;
    cancelledBy?: string;
    reason?: string;
    penalty?: number | null;
    refund?: number | null;
    compensation?: number | null;
  };
  // DISCOM fulfillment verification
  fulfillment?: {
    verified: boolean;
    deliveredQty: number;
    expectedQty: number;
    deliveryRatio: number;
    status: 'FULL' | 'PARTIAL' | 'FAILED';
    trustImpact: number;
    verifiedAt: string;
  } | null;
}

export interface BuyerOrder {
  id: string;
  status: string;
  created_at: string;
  paymentStatus?: string;
  quote?: { price: { value: number }; totalQuantity: number };
  provider?: { id: string; name: string };
  providers?: Array<{ id: string; name: string }>; // For bulk orders
  itemInfo: {
    item_id: string;
    offer_id: string;
    source_type: string;
    price_per_kwh: number;
    quantity: number;
  };
  cancellation?: {
    cancelledAt?: string;
    cancelledBy?: string;
    reason?: string;
    penalty?: number | null;
    refund?: number | null;
  };
  // Bulk order info
  isBulkOrder?: boolean;
  isPartOfBulkPurchase?: boolean; // This order is one of multiple from a bulk buy
  bulkGroupId?: string; // Links orders from the same bulk purchase
  totalItemCount?: number;
  totalProviderCount?: number;
}

export interface DiscoverParams {
  sourceType?: string;
  minQuantity?: number;
  timeWindow?: { startTime: string; endTime: string };
}

export interface SelectParams {
  transaction_id: string;
  offer_id?: string;
  quantity: number;
  autoMatch?: boolean;
  requestedTimeWindow?: { start: string; end: string };
}

// Bulk buy mode
export interface BulkSelectParams {
  transaction_id: string;
  bulkBuy: true;
  targetQuantity: number;
  maxOffers?: number;
  requestedTimeWindow: { startTime: string; endTime: string };
}

export interface BulkSelectedOffer {
  offer_id: string;
  item_id: string;
  provider_id: string;
  provider_name: string;
  quantity: number;
  unit_price: number;
  currency: string;
  subtotal: number;
  score: number;
  timeWindow: { startTime: string; endTime: string } | null;
}

export interface BulkSelectResponse {
  status: string;
  transaction_id: string;
  bulkMode: true;
  selectedOffers: BulkSelectedOffer[];
  summary: {
    totalQuantity: number;
    totalPrice: number;
    averagePrice: number;
    currency: string;
    fullyFulfilled: boolean;
    shortfall: number;
    offersUsed: number;
    offersAvailable: number;
  };
  message: string;
}

// Smart buy mode - auto determines single vs multiple offers
export interface SmartBuyParams {
  transaction_id: string;
  smartBuy: true;
  quantity: number;
  maxOffers?: number;
  requestedTimeWindow: { startTime: string; endTime: string };
}

export interface SmartBuyResponse {
  status: string;
  transaction_id: string;
  smartBuy: true;
  selectionType?: 'single' | 'multiple';
  selectedOffers: BulkSelectedOffer[];
  summary: {
    totalQuantity: number;
    totalPrice: number;
    averagePrice?: number;
    currency?: string;
    fullyFulfilled: boolean;
    shortfall: number;
    offersUsed: number;
    offersAvailable?: number;
  };
  message?: string;
  // Returned when no offers match
  error?: string;
  offersAvailable?: number;
  eligibleOffers?: number;
  filterReasons?: string[];
  availableWindows?: Array<{ startTime: string; endTime: string }>;
}

export interface AddItemParams {
  source_type: string;
  available_qty: number;
  meter_id?: string;
}

export interface AddOfferParams {
  item_id: string;
  price_per_kwh: number;
  currency?: string;
  max_qty: number;
  time_window: { startTime: string; endTime: string };
}

export interface AddOfferDirectParams {
  source_type: string;
  price_per_kwh: number;
  currency?: string;
  max_qty: number;
  time_window: { startTime: string; endTime: string };
}

export interface WeatherCapacityResponse {
  baseCapacity: number;
  effectiveCapacity: number;
  condition: string;           // "Slightly sunny ☀️", "Cloudy ☁️", etc.
  bestWindow?: {
    start: string;             // "10:00"
    end: string;               // "14:00"
  };
  totalCommitted: number;
  remainingCapacity: number;
  sourceType: string;
}

export interface WeatherAlertResponse {
  alert: string | null;
  weather?: {
    precipitation24h: number;
    maxWindSpeed: number;
    hadThunderstorm: boolean;
    hadHail: boolean;
  };
  location?: string;
  reason?: string;
}

export interface SettlementRecord {
  tradeId: string;
  orderId: string | null;
  transactionId: string | null;
  buyerId: string | null;
  sellerId: string | null;
  principal: number;
  fee: number;
  total: number;
  expiresAt: string | null;
  status: string;
  verificationOutcome: string | null;
  fundedReceipt: string | null;
  payoutReceipt: string | null;
  fundedAt: string | null;
  verifiedAt: string | null;
  payoutAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PaymentStep {
  id: number;
  label: string;
  status: 'pending' | 'complete' | 'error';
  time: string | null;
}

export interface EscrowInstruction {
  bankName: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  branch: string;
  amount: number;
  currency: string;
  reference: string;
  expiresAt: string;
}

export interface PayoutInstruction {
  instruction: string;
  amount: number;
  currency: string;
}

export interface SettlementResponse {
  status: string;
  record: SettlementRecord;
  steps: PaymentStep[];
  escrow?: EscrowInstruction;
  payout?: PayoutInstruction;
}

export interface DemoAccount {
  id: string;
  name: string;
  type: 'buyer' | 'seller' | 'escrow' | 'platform';
  balance: number;
  currency: string;
}

export interface DemoTransaction {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  amount: number;
  description: string;
  timestamp: string;
}

export interface TransactionState {
  transaction_id: string;
  status: string;
  error?: string;
  catalog?: {
    providers: Array<{
      id: string;
      descriptor?: { name: string };
      items: Array<{
        id: string;
        offers: Offer[];
        itemAttributes?: {
          sourceType: string;
          availableQuantity: number;
        };
      }>;
    }>;
  };
  selectedOffer?: Offer;
  order?: Order;
  matchingResults?: {
    selectedOffer?: {
      offer: Offer;
      score: number;
      matchesFilters?: boolean;
      filterReasons?: string[];
      breakdown?: {
        priceScore: number;
        trustScore: number;
        timeWindowFitScore: number;
      };
    };
    allOffers: Array<{
      offer: Offer;
      score: number;
      matchesFilters?: boolean;
      filterReasons?: string[];
      breakdown?: {
        priceScore: number;
        trustScore: number;
        timeWindowFitScore: number;
      };
    }>;
    eligibleCount?: number;
  };
  trustWarning?: {
    score: number;
    percentage: string;
    message: string;
  };
  // Bulk buy mode
  bulkMode?: boolean;
  selectedOffers?: BulkSelectedOffer[];
  bulkSelection?: {
    totalQuantity: number;
    totalPrice: number;
    fullyFulfilled: boolean;
    shortfall: number;
    targetQuantity: number;
  };
}

// Verifiable Credentials Types
export interface VCCredential {
  type: string;
  status: 'verified' | 'pending' | 'not_submitted';
  description: string;
  verifiedAt?: string;
  details?: Record<string, any>;
}

export interface VCCheck {
  check: string;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
}

// Multi-credential onboarding types (Beckn DEG)
export type DEGCredentialType =
  | 'UtilityCustomerCredential'
  | 'ConsumptionProfileCredential'
  | 'GenerationProfileCredential'
  | 'StorageProfileCredential'
  | 'UtilityProgramEnrollmentCredential';

export interface CredentialInfo {
  type: string;
  verified: boolean;
  verifiedAt: string | null;
}

export interface VerifyCredentialResponse {
  success: boolean;
  credentialType: DEGCredentialType;
  verification: {
    verified: boolean;
    checks: VCCheck[];
    extractionMethod: 'json' | 'llm' | 'direct';
  };
  extractedClaims: Record<string, any>;
  user: User;
  credentials: CredentialInfo[];
}

export interface CompleteOnboardingResponse {
  success: boolean;
  user: User;
  credentials: CredentialInfo[];
}
