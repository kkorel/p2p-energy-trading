/**
 * Oorja Agent — Core conversational state machine.
 * Flow: Name → Phone → OTP → Utility Cred (mandatory) → Optional Creds → Trading → Chat
 * Messages are kept short and farmer-friendly.
 */

import {
  prisma,
  createLogger,
  sendOtp,
  verifyOtpAndAuthenticate,
  createSession,
  validatePhoneNumber,
  normalizePhone,
  calculateAllowedLimit,
  verifyCredential as verifyVCStructure,
  detectCredentialType,
  extractCapacity,
  extractNormalizedGenerationClaims,
  extractNormalizedUtilityCustomerClaims,
  extractNormalizedConsumptionProfileClaims,
  extractNormalizedStorageProfileClaims,
  extractNormalizedProgramEnrollmentClaims,
  getIssuerId,
  analyzeInstallation,
  getHeatmapImageUrl,
  type SolarAnalysis,
} from '@p2p/shared';
import { knowledgeBase } from './knowledge-base';
import { mockTradingAgent, parseTimePeriod, getWelcomeBackData, executePurchase, discoverBestOffer, completePurchase, generateDashboard, generateDashboardData, getMarketInsights, getActivitySummary, getTopDeals, getBrowseMarketTable, getActiveListingsData, type ListingsCardData } from './trading-agent';
import { askLLM, classifyIntent, composeResponse, extractNameWithLLM, extractPhoneWithLLM, extractOtpWithLLM, matchDiscomWithLLM } from './llm-fallback';
import { detectLanguage, translateToEnglish, translateFromEnglish, isTranslationAvailable, type SarvamLangCode } from './sarvam';
import { extractVCFromPdf } from '../vc-pdf-analyzer';
import { sendProactiveMessage, isWhatsAppConnected, getWhatsAppBotNumber } from './whatsapp';
import { normalizeVoiceInput } from './voice-normalizer';

const logger = createLogger('OorjaAgent');

// --- Types ---

export interface FileData {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

/** Dashboard data for structured UI rendering */
export interface DashboardData {
  userName: string;
  balance: number;
  trustScore: number;
  trustTier: { name: string; nameHi: string; emoji: string };
  tradeLimit: number;
  productionCapacity?: number;
  seller?: {
    activeListings: number;
    totalListedKwh: number;
    weeklyEarnings: number;
    weeklyKwh: number;
    totalEarnings: number;
    totalKwh: number;
  };
  buyer?: {
    totalOrders: number;
    totalBoughtKwh: number;
    totalSpent: number;
  };
}

export interface AgentMessage {
  text: string;
  buttons?: Array<{ text: string; callbackData?: string }>;
  delay?: number;
  /** Structured offers for premium buy UI */
  offers?: Array<{
    id: string;
    sellerName: string;
    sellerTrustScore: number;
    energyType: 'solar' | 'wind' | 'grid';
    pricePerUnit: number;
    quantity: number;
    totalPrice: number;
    timeWindow: string;
    savingsPercent?: number;
  }>;
  /** Structured dashboard for card UI rendering */
  dashboard?: DashboardData;
  /** Structured listings for card UI rendering */
  listings?: ListingsCardData;
  /** Structured offer created data for card UI rendering */
  offerCreated?: {
    quantity: number;
    pricePerKwh: number;
    startTime: string;
    endTime: string;
    energyType?: string;
  };
  /** Structured top deals for buyer flow */
  topDeals?: {
    deals: Array<{
      offerId: string;
      providerName: string;
      trustScore: number;
      energyType: string;
      quantity: number;
      pricePerKwh: number;
      savingsPercent: number;
    }>;
    discomRate: number;
  };
  /** Structured matched offers for buyer flow */
  matchedOffers?: {
    selectionType: 'single' | 'multiple';
    offers: Array<{
      offerId: string;
      providerId: string;
      providerName: string;
      trustScore: number;
      energyType: string;
      quantity: number;
      pricePerKwh: number;
      subtotal: number;
      timeWindow: string;
    }>;
    summary: {
      totalQuantity: number;
      totalPrice: number;
      averagePrice: number;
      fullyFulfilled: boolean;
      shortfall: number;
      offersUsed: number;
    };
    timeWindow: string;
    transactionId: string;
  };
  /** Structured order confirmation for buyer flow */
  orderConfirmation?: {
    success: boolean;
    orderId?: string;
    offers: Array<{
      providerName: string;
      quantity: number;
      pricePerKwh: number;
      subtotal: number;
    }>;
    summary: {
      totalQuantity: number;
      totalPrice: number;
      averagePrice: number;
      ordersConfirmed: number;
    };
    timeWindow: string;
  };
  /** Structured earnings data for EarningsCard */
  earnings?: {
    userName: string;
    hasStartedSelling: boolean;
    totalOrders: number;
    totalEnergySold: number;
    totalEarnings: number;
    walletBalance: number;
  };
  /** Structured auto-trade status for AutoTradeStatusCard */
  autoTradeStatus?: {
    seller?: {
      enabled: boolean;
      capacityKwh: number;
      pricePerKwh: number;
      energyType: string;
      lastRun?: {
        executedAt: string;
        status: string;
        listedQuantity: number;
        weatherMultiplier: number;
      };
    };
    buyer?: {
      enabled: boolean;
      targetQuantity: number;
      maxPrice: number;
      preferredTime: string | null;
      lastRun?: {
        executedAt: string;
        status: string;
        quantityBought: number;
        pricePerUnit: number;
        totalSpent: number;
        error?: string;
      };
    };
  };
  /** Slider UI for numeric input selection */
  slider?: {
    type: 'quantity' | 'price';
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    unit: string;  // 'units', '₹/unit', etc.
    callbackPrefix: string;  // e.g., 'listing_qty', 'autobuy_price'
  };
}

export interface AgentResponse {
  messages: AgentMessage[];
  newState?: string;
  contextUpdate?: Partial<SessionContext>;
  authToken?: string;
  /** Language used for the response (for TTS) */
  responseLanguage?: string;
  /** User's voice output preference (for auto-play) */
  voiceOutputEnabled?: boolean;
  /** Auto-play voice response (set when input was voice) */
  autoVoice?: boolean;
}

/**
 * Options for voice input processing
 */
export interface VoiceInputOptions {
  /** Language detected from voice input (e.g., 'hi-IN', 'ta-IN') */
  detectedLanguage?: string;
  /** Whether this message came from voice input */
  isVoiceInput?: boolean;
}

interface PendingListing {
  pricePerKwh?: number;
  quantity?: number;
  timeDesc?: string;
  energyType?: string;
  awaitingField?: 'energy_type' | 'quantity' | 'price' | 'timeframe' | 'confirm' | 'choose_mode';
  quickSellMode?: boolean; // True for simplified one-question flow
}

interface PendingPurchase {
  quantity?: number;
  maxPrice?: number;
  timeDesc?: string;
  awaitingField?: 'choose_mode' | 'quantity' | 'timeframe' | 'confirm' | 'confirm_offer' | 'top_deals';
  topDealsShown?: boolean; // Whether we've already shown top deals
  selectedDealId?: string; // If user selects from top deals
  // Populated after discovery — single offer (legacy)
  discoveredOffer?: {
    offerId: string;
    providerId: string;
    providerName: string;
    price: number;
    quantity: number;
    timeWindow: string;
  };
  // Smart buy multi-offer
  discoveredOffers?: Array<{
    offerId: string;
    providerId: string;
    providerName: string;
    price: number;
    quantity: number;
    subtotal: number;
    timeWindow: string;
  }>;
  selectionType?: 'single' | 'multiple';
  summary?: {
    totalQuantity: number;
    totalPrice: number;
    averagePrice: number;
    fullyFulfilled: boolean;
    shortfall: number;
    offersUsed: number;
  };
  transactionId?: string;
}

interface PendingAutoBuy {
  quantity?: number;
  maxPrice?: number;
  preferredTime?: 'morning' | 'afternoon' | 'auto';
  awaitingField?: 'quantity' | 'max_price' | 'time_preference';
  suggestedQuantities?: number[]; // Based on sanctioned load
}

interface SessionContext {
  phone?: string;
  name?: string;
  otpAttempts?: number;
  userId?: string;
  authToken?: string;
  providerId?: string;
  vcVerified?: boolean;
  tradingActive?: boolean;
  productionCapacity?: number;
  tradeLimit?: number;
  discom?: string;
  askedDiscom?: boolean;
  language?: SarvamLangCode;
  intent?: 'sell' | 'buy' | 'learn';
  langPicked?: boolean;
  /** Flag to skip name question in WAITING_NAME.onEnter if already asked */
  nameAsked?: boolean;
  expectedCredType?: string;
  verifiedCreds?: string[];
  pendingListing?: PendingListing;
  pendingPurchase?: PendingPurchase;
  pendingAutoBuy?: PendingAutoBuy;
  /** User's preference for voice output (TTS auto-play) */
  voiceOutputEnabled?: boolean;
  /** Whether user has been asked about voice preferences */
  voicePromptShown?: boolean;
  // Runtime-only — not serialized to contextJson
  _sessionId?: string;
  _platform?: 'TELEGRAM' | 'WEB' | 'WHATSAPP';
  _helpShortcut?: string;
  _resetPending?: boolean;
}

type ChatState =
  | 'GREETING'
  | 'WAITING_NAME'
  | 'WAITING_PHONE'
  | 'WAITING_OTP'
  | 'AUTHENTICATED'
  | 'ASK_DISCOM'
  | 'WAITING_UTILITY_CRED'
  | 'ASK_INTENT'
  | 'OFFER_OPTIONAL_CREDS'
  | 'WAITING_OPTIONAL_CRED'
  | 'CONFIRM_TRADING'
  | 'GENERAL_CHAT'
  // Legacy states (kept for backward compat with existing sessions)
  | 'ASK_VOICE_PREF' // Deprecated: voice toggle now in header UI
  | 'OTP_VERIFIED'
  | 'EXPLAIN_VC'
  | 'WAITING_VC_UPLOAD'
  | 'VC_VERIFIED'
  | 'TRADING_ACTIVE';

interface StateHandler {
  onEnter: (ctx: SessionContext) => Promise<AgentResponse>;
  onMessage: (ctx: SessionContext, message: string, fileData?: FileData) => Promise<AgentResponse>;
}

// --- Credential mapping ---

const CRED_DISPLAY_NAMES: Record<string, string> = {
  UtilityCustomerCredential: 'Electricity Connection ID',
  GenerationProfileCredential: 'Solar Panel ID',
  ConsumptionProfileCredential: 'Consumption ID',
  StorageProfileCredential: 'Battery Storage ID',
  UtilityProgramEnrollmentCredential: 'Program Enrollment ID',
};

// --- Credential processing helper ---

// Localized credential display names for error messages
const CRED_DISPLAY_NAMES_HI: Record<string, string> = {
  'Electricity Connection ID': 'बिजली कनेक्शन आईडी',
  'Solar Panel ID': 'सोलर पैनल आईडी',
  'Consumption ID': 'खपत आईडी',
  'Battery Storage ID': 'बैटरी स्टोरेज आईडी',
  'Program Enrollment ID': 'प्रोग्राम एनरोलमेंट आईडी',
};

async function processCredentialUpload(
  userId: string,
  fileData: FileData,
  expectedType?: string,
  language?: string
): Promise<{ success: boolean; credType: string; summary: string; error?: string; claims?: any }> {
  const isHindi = language === 'hi-IN';
  let credential: any;

  if (fileData.mimeType === 'application/json') {
    try {
      credential = JSON.parse(fileData.buffer.toString('utf-8'));
    } catch {
      return {
        success: false,
        credType: '',
        summary: '',
        error: isHindi
          ? 'यह JSON फ़ाइल पढ़ नहीं पाई। कृपया जाँच करें और दोबारा कोशिश करें।'
          : 'Could not read this JSON file. Please check and try again.',
      };
    }
  } else {
    const extraction = await extractVCFromPdf(fileData.buffer);
    if (!extraction.success || !extraction.credential) {
      return {
        success: false,
        credType: '',
        summary: '',
        error: isHindi
          ? 'यह PDF पढ़ नहीं पाई। कृपया जाँच करें और दोबारा कोशिश करें।'
          : 'Could not read this PDF. Please check and try again.',
      };
    }
    credential = extraction.credential;
  }

  // Detect type
  const detectedType = detectCredentialType(credential);
  if (!detectedType) {
    return {
      success: false,
      credType: '',
      summary: '',
      error: isHindi
        ? 'यह सही दस्तावेज़ नहीं लग रहा। कृपया अपना सोलर आईडी या बिजली कनेक्शन आईडी (PDF) अपलोड करें।'
        : 'This does not look like a valid ID document. Please upload your Solar ID or Electricity Connection ID (PDF from your electricity company).',
    };
  }

  // Check expected type
  if (expectedType && detectedType !== expectedType) {
    const expectedName = CRED_DISPLAY_NAMES[expectedType] || expectedType;
    const actualName = CRED_DISPLAY_NAMES[detectedType] || detectedType;
    const expectedNameHi = CRED_DISPLAY_NAMES_HI[expectedName] || expectedName;
    const actualNameHi = CRED_DISPLAY_NAMES_HI[actualName] || actualName;
    return {
      success: false,
      credType: detectedType,
      summary: '',
      error: isHindi
        ? `यह ${actualNameHi} है, लेकिन मुझे आपका ${expectedNameHi} चाहिए। सही दस्तावेज़ अपलोड करें।`
        : `This is a ${actualName}, but I need your ${expectedName}. Please upload the right document.`,
    };
  }

  // Verify structure
  await verifyVCStructure(credential);

  // Extract claims based on type
  let claims: any = {};
  let summary = '';
  const dbCredType = degTypeToDbType(detectedType);

  switch (detectedType) {
    case 'UtilityCustomerCredential': {
      claims = extractNormalizedUtilityCustomerClaims(credential);
      summary = `Consumer: ${claims.consumerNumber || 'N/A'}, Meter: ${claims.meterNumber || 'N/A'}`;
      if (claims.fullName) summary = `${claims.fullName} — ${summary}`;
      break;
    }
    case 'GenerationProfileCredential': {
      claims = extractNormalizedGenerationClaims(credential);
      const kw = claims.capacityKW || extractCapacity(credential);
      summary = `${kw || '?'} kW ${claims.sourceType || 'Solar'}`;
      if (claims.fullName) summary = `${claims.fullName} — ${summary}`;
      break;
    }
    case 'ConsumptionProfileCredential': {
      claims = extractNormalizedConsumptionProfileClaims(credential);
      summary = `Load: ${claims.sanctionedLoadKW || '?'} kW, Type: ${claims.premisesType || claims.connectionType || 'N/A'}`;
      break;
    }
    case 'StorageProfileCredential': {
      claims = extractNormalizedStorageProfileClaims(credential);
      summary = `${claims.storageCapacityKWh || '?'} units ${claims.storageType || 'Battery'}`;
      break;
    }
    case 'UtilityProgramEnrollmentCredential': {
      claims = extractNormalizedProgramEnrollmentClaims(credential);
      summary = `Program: ${claims.programName || claims.programCode || 'N/A'}`;
      break;
    }
  }

  // Upsert into userCredential table
  await prisma.userCredential.upsert({
    where: {
      userId_credentialType: {
        userId,
        credentialType: dbCredType,
      },
    },
    create: {
      userId,
      credentialType: dbCredType,
      rawJson: JSON.stringify(credential),
      verified: true,
      verifiedAt: new Date(),
      extractedClaims: JSON.stringify(claims),
      issuerId: claims.issuer || getIssuerId(credential.issuer),
    },
    update: {
      rawJson: JSON.stringify(credential),
      verified: true,
      verifiedAt: new Date(),
      extractedClaims: JSON.stringify(claims),
      issuerId: claims.issuer || getIssuerId(credential.issuer),
    },
  });

  // Update user fields based on credential type
  if (detectedType === 'UtilityCustomerCredential') {
    // Save Utility VC claims to user record
    const userUpdate: Record<string, any> = {};
    if (claims.fullName) userUpdate.name = claims.fullName;
    if (claims.consumerNumber) userUpdate.consumerNumber = claims.consumerNumber;
    if (claims.meterNumber) userUpdate.meterNumber = claims.meterNumber;
    if (claims.installationAddress) userUpdate.installationAddress = claims.installationAddress;
    if (claims.serviceConnectionDate) {
      const parsedDate = parseDate(claims.serviceConnectionDate);
      if (parsedDate) userUpdate.serviceConnectionDate = parsedDate;
    }

    if (Object.keys(userUpdate).length > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: userUpdate,
      });
      logger.info(`[Chat] Updated user ${userId} with Utility VC claims`, { address: claims.installationAddress?.substring(0, 40) });
    }
  } else if (detectedType === 'GenerationProfileCredential' || detectedType === 'StorageProfileCredential') {
    const capacityKW = claims.capacityKW || extractCapacity(credential);
    if (capacityKW && capacityKW > 0) {
      const AVG_PEAK_SUN_HOURS = 4.5;
      const DAYS_PER_MONTH = 30;
      const monthlyKWh = roundTo500(capacityKW * AVG_PEAK_SUN_HOURS * DAYS_PER_MONTH);
      await prisma.user.update({
        where: { id: userId },
        data: { productionCapacity: monthlyKWh },
      });
    }

    // Auto-create Provider for Generation/Storage VCs (required for auto-trade)
    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { providerId: true, name: true, consumerNumber: true, installationAddress: true },
    });

    if (!currentUser?.providerId) {
      const providerId = `provider-${userId}`;
      try {
        await prisma.provider.create({
          data: {
            id: providerId,
            name: currentUser?.name || 'Energy Provider',
            generationType: claims.generationType || claims.sourceType || null,
            capacityKW: claims.capacityKW || null,
            generationMeterNumber: claims.meterNumber || null,
            commissioningDate: parseDate(claims.commissioningDate),
            storageCapacityKWh: claims.storageCapacityKWh || null,
            storageType: claims.storageType || null,
            consumerNumber: currentUser?.consumerNumber || null,
            installationAddress: currentUser?.installationAddress || null,
          },
        });

        await prisma.user.update({
          where: { id: userId },
          data: { providerId },
        });

        logger.info(`Auto-created Provider ${providerId} for user ${userId} from ${detectedType}`);
      } catch (err: any) {
        // Provider might already exist (race condition) - try to link it
        logger.warn(`Provider creation failed, trying to link: ${err.message}`);
        const existingProvider = await prisma.provider.findUnique({ where: { id: providerId } });
        if (existingProvider) {
          await prisma.user.update({
            where: { id: userId },
            data: { providerId },
          });
        }
      }
    }
  }

  // Trigger solar analysis for address-based trading limits
  // Run in background (fire-and-forget) for fast response
  if (detectedType === 'UtilityCustomerCredential' && claims.installationAddress) {
    logger.info(`[Chat] Triggering solar analysis for user ${userId} (UtilityCustomerCredential with address)`);
    runSolarAnalysisForUser(userId, claims.installationAddress);
  } else if (detectedType === 'GenerationProfileCredential' || detectedType === 'StorageProfileCredential') {
    // Fallback: trigger if user has address from prior Utility VC but no solar analysis yet
    const userWithAddress = await prisma.user.findUnique({
      where: { id: userId },
      select: { installationAddress: true, solarAnalysis: true },
    });
    if (userWithAddress?.installationAddress && !userWithAddress.solarAnalysis) {
      logger.info(`[Chat] Triggering solar analysis for user ${userId} (${detectedType} with existing address)`);
      runSolarAnalysisForUser(userId, userWithAddress.installationAddress);
    }
  }

  return { success: true, credType: detectedType, summary, claims };
}

/**
 * Run solar analysis in background (fire-and-forget).
 * Updates UserSolarAnalysis and sets allowedTradeLimit (7-15%).
 */
async function runSolarAnalysisForUser(userId: string, address: string): Promise<void> {
  try {
    const analysis = await analyzeInstallation(address);

    // Get heatmap image URL if we have coordinates
    let satelliteImageUrl: string | null = null;
    if (analysis.location?.lat && analysis.location?.lon) {
      satelliteImageUrl = await getHeatmapImageUrl(analysis.location.lat, analysis.location.lon);
    }

    // Upsert UserSolarAnalysis record
    await prisma.userSolarAnalysis.upsert({
      where: { userId },
      create: {
        userId,
        available: analysis.available,
        latitude: analysis.location?.lat || null,
        longitude: analysis.location?.lon || null,
        formattedAddress: analysis.location?.formattedAddress || null,
        maxSunshineHours: analysis.maxSunshineHours || null,
        maxPanelCount: analysis.maxPanelCount || null,
        yearlyEnergyKwh: analysis.yearlyEnergyKwh || null,
        roofAreaM2: analysis.roofAreaM2 || null,
        imageryQuality: analysis.imageryQuality || null,
        carbonOffsetKg: analysis.carbonOffsetKg || null,
        installationScore: analysis.installationScore,
        tradingLimitPercent: analysis.tradingLimitPercent,
        verificationMethod: analysis.verificationMethod,
        errorReason: analysis.errorReason || null,
        satelliteImageUrl,
        analyzedAt: analysis.analyzedAt,
      },
      update: {
        available: analysis.available,
        latitude: analysis.location?.lat || null,
        longitude: analysis.location?.lon || null,
        formattedAddress: analysis.location?.formattedAddress || null,
        maxSunshineHours: analysis.maxSunshineHours || null,
        maxPanelCount: analysis.maxPanelCount || null,
        yearlyEnergyKwh: analysis.yearlyEnergyKwh || null,
        roofAreaM2: analysis.roofAreaM2 || null,
        imageryQuality: analysis.imageryQuality || null,
        carbonOffsetKg: analysis.carbonOffsetKg || null,
        installationScore: analysis.installationScore,
        tradingLimitPercent: analysis.tradingLimitPercent,
        verificationMethod: analysis.verificationMethod,
        errorReason: analysis.errorReason || null,
        satelliteImageUrl,
        analyzedAt: analysis.analyzedAt,
      },
    });

    // Update user's allowedTradeLimit
    await prisma.user.update({
      where: { id: userId },
      data: { allowedTradeLimit: analysis.tradingLimitPercent },
    });

    logger.info(`[Chat] ✓ Solar analysis complete for user ${userId}: limit=${analysis.tradingLimitPercent}%, score=${analysis.installationScore.toFixed(2)}`);
  } catch (error: any) {
    logger.warn(`[Chat] Solar analysis failed for user ${userId}: ${error.message}`);
  }
}

function degTypeToDbType(degType: string): any {
  const map: Record<string, string> = {
    UtilityCustomerCredential: 'UTILITY_CUSTOMER',
    GenerationProfileCredential: 'GENERATION_PROFILE',
    ConsumptionProfileCredential: 'CONSUMPTION_PROFILE',
    StorageProfileCredential: 'STORAGE_PROFILE',
    UtilityProgramEnrollmentCredential: 'PROGRAM_ENROLLMENT',
  };
  return map[degType] || 'UTILITY_CUSTOMER';
}

/**
 * Safely parse a date string, returning null if invalid
 */
function parseDate(dateStr: string | undefined | null): Date | null {
  if (!dateStr) return null;
  const parsed = Date.parse(dateStr);
  if (isNaN(parsed)) return null;
  return new Date(parsed);
}

async function getVerifiedCredentials(userId: string): Promise<string[]> {
  const creds = await prisma.userCredential.findMany({
    where: { userId, verified: true },
    select: { credentialType: true },
  });
  return creds.map((c) => c.credentialType);
}

// Returns alt (Hindi) text for ANY non-English language.
// translateResponse() later converts this to native script (Devanagari, Tamil, etc.).
function h(ctx: SessionContext | { language?: string }, en: string, alt: string): string {
  if (!ctx.language || ctx.language === 'en-IN') return en;
  return alt;
}

/** Localize common API error messages for Hindi users */
function localizeError(ctx: SessionContext | { language?: string }, error: string | undefined): string {
  if (!error) return h(ctx, 'Unknown error', 'अज्ञात समस्या');
  if (!ctx.language || ctx.language === 'en-IN') return error;
  // Map common English errors to Hindi
  const lower = error.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out')) return 'सर्वर से जवाब नहीं आया। दोबारा कोशिश करो।';
  if (lower.includes('no energy offers found') || lower.includes('no matching offer')) return 'कोई ऑफ़र नहीं मिला। अलग समय या मात्रा आज़माओ।';
  if (lower.includes('no offers match the requested time')) return 'इस समय के लिए कोई ऑफ़र नहीं है। अलग समय आज़माओ।';
  if (lower.includes('session has expired') || lower.includes('log in again')) return 'आपका सेशन समाप्त हो गया। /start से दोबारा लॉगिन करो।';
  if (lower.includes('discovery failed')) return 'ऑफ़र ढूंढने में समस्या हुई। दोबारा कोशिश करो।';
  if (lower.includes('order creation timed out')) return 'ऑर्डर बनने में समय लग रहा है। दोबारा कोशिश करो।';
  if (lower.includes('no valid session')) return 'सेशन नहीं मिला। /start से लॉगिन करो।';
  if (lower.includes('gate closed') || lower.includes('trade not allowed')) return 'इस समय के लिए ट्रेड बंद है। बाद का समय चुनो।';
  if (lower.includes('not allowed') || lower.includes('not permitted')) return 'यह कार्य अभी संभव नहीं है।';
  // Fallback: return the English error as-is (better than nothing)
  return error;
}

/** Localize auto-trade warning/info messages based on result data */
function localizeTradeWarning(
  ctx: SessionContext | { language?: string },
  result: { status: string; warningMessage?: string; effectiveCapacity: number; listedQuantity: number },
): string {
  const msg = result.warningMessage || '';
  // "Already have X units listed for tomorrow (target: Y units)"
  const alreadyMatch = msg.match(/Already have ([\d.]+) (?:kWh|units) listed.*target: ([\d.]+) (?:kWh|units)/);
  if (alreadyMatch) {
    return h(ctx,
      `Already have ${alreadyMatch[1]} units listed for tomorrow (target: ${alreadyMatch[2]} units)`,
      `कल के लिए पहले से ${alreadyMatch[1]} यूनिट लिस्टेड हैं (लक्ष्य: ${alreadyMatch[2]} यूनिट)`
    );
  }
  // "Added X units (already had Y units listed)"
  const addedMatch = msg.match(/Added ([\d.]+) (?:kWh|units).*already had ([\d.]+) (?:kWh|units)/);
  if (addedMatch) {
    return h(ctx,
      `Added ${addedMatch[1]} units (already had ${addedMatch[2]} units listed)`,
      `${addedMatch[1]} यूनिट जोड़ी (पहले से ${addedMatch[2]} यूनिट लिस्टेड थीं)`
    );
  }
  // "Warning: Total commitment (X units) exceeds daily capacity (Y units)."
  const oversellMatch = msg.match(/Total commitment \(([\d.]+) (?:kWh|units)\).*daily capacity \(([\d.]+) (?:kWh|units)\)/);
  if (oversellMatch) {
    return h(ctx,
      `Warning: Total commitment (${oversellMatch[1]} units) exceeds daily capacity (${oversellMatch[2]} units)`,
      `चेतावनी: कुल लिस्टिंग (${oversellMatch[1]} यूनिट) रोज़ की क्षमता (${oversellMatch[2]} यूनिट) से ज़्यादा है`
    );
  }
  // "Effective capacity too low to list (< 1 kWh)"
  if (msg.includes('too low')) {
    return h(ctx,
      'Effective capacity too low to list (< 1 unit)',
      'क्षमता बहुत कम है, लिस्ट नहीं कर सकते (< 1 यूनिट)'
    );
  }
  // "User is not registered as a provider"
  if (msg.includes('not registered')) {
    return h(ctx,
      'You are not registered as a seller yet',
      'आप अभी बेचने वाले के रूप में रजिस्टर नहीं हैं'
    );
  }
  // Fallback: return as-is (shouldn't happen often)
  return msg;
}

/**
 * Extract a valid Indian phone number from messy voice transcriptions.
 * Handles: "Plus 44 7700900123", "07700900123", "91 9876543210", etc.
 */
function extractIndianPhone(text: string): string | null {
  // Remove common voice prefixes and format issues
  let cleaned = text
    .toLowerCase()
    .replace(/plus\s*/gi, '')        // "Plus 44" → "44"
    .replace(/\+/g, '')              // "+91" → "91"
    .replace(/^0+/, '')              // Leading zeros
    .replace(/^91\s*/, '')           // India country code
    .replace(/^44\s*/, '')           // UK code (common mistranscription)
    .replace(/^1\s*/, '')            // US code
    .replace(/[\s\-\(\)\.]/g, '')    // Spaces, dashes, parens, dots
    .replace(/[^\d]/g, '');          // Remove all non-digits

  // If more than 10 digits, take last 10 (handles "919876543210" → "9876543210")
  if (cleaned.length > 10) {
    cleaned = cleaned.slice(-10);
  }

  // Validate: Indian mobile starts with 6-9, exactly 10 digits
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

// --- App URL for registration redirects ---
const APP_URL = process.env.APP_URL || 'http://localhost:3000/';

/**
 * Generate response for unverified WhatsApp users.
 * These users must register on the app first.
 * Auto-detects language from user message.
 */
function getUnverifiedWhatsAppResponse(userMessage: string): AgentResponse {
  const detectedLang = detectLanguage(userMessage);
  const isHindi = detectedLang === 'hi-IN';

  const message = isHindi
    ? `नमस्ते! मैं ऊर्जा हूँ, आपका बिजली व्यापार सहायक।

मेरी सेवाएँ इस्तेमाल करने के लिए, पहले ऐप पर रजिस्टर करो:
${APP_URL}

रजिस्टर होने के बाद, मैं आपकी मदद कर सकता हूँ:
• सोलर बिजली बेचना
• सस्ती हरी बिजली खरीदना
• ऑर्डर और कमाई ट्रैक करना
• बाज़ार की जानकारी लेना

जल्दी मिलते हैं!`
    : `Namaste! I'm Oorja, your P2P energy trading assistant.

To use my services, please register on our app first:
${APP_URL}

Once you're registered, I can help you:
• Sell your solar energy
• Buy affordable green energy
• Track your orders and earnings
• Get market insights

See you soon!`;

  return {
    messages: [{ text: message }],
    responseLanguage: isHindi ? 'hi-IN' : 'en-IN',
  };
}

/**
 * Extract the actual name from common phrases like "My name is Jack" or "I'm Jack".
 * Returns just the name portion, or the full message if no pattern matches.
 */
function extractName(message: string): string {
  let text = message.trim();

  // Common patterns in English
  const englishPatterns = [
    /^(?:my name is|i'm|i am|call me|this is|it's|its)\s+(.+)$/i,
    /^(.+?)\s+(?:is my name|here)$/i,
    /^(?:name:?\s*)(.+)$/i,
  ];

  // Common patterns in Hindi
  const hindiPatterns = [
    /^(?:mera naam|mera name|naam|name)\s+(?:hai\s+)?(.+)$/i,
    /^(?:main|mai|me)\s+(.+?)\s+(?:hun|hoon|hu)$/i,
    /^(.+?)\s+(?:mera naam hai|hai mera naam)$/i,
  ];

  const allPatterns = [...englishPatterns, ...hindiPatterns];

  for (const pattern of allPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      // Clean up the extracted name
      let name = match[1].trim();
      // Remove trailing punctuation
      name = name.replace(/[.!?,;:]+$/, '').trim();
      if (name.length >= 2) {
        return name;
      }
    }
  }

  // No explicit pattern matched - try to extract a name from casual speech
  // Remove filler words and clean up
  const fillerWords = /^(uh+|um+|hmm+|well|ok|okay|hey|hi|hello|so|yeah|yes|no|oh)[,.\s]+/gi;
  text = text.replace(fillerWords, '').trim();

  // Remove trailing questions/phrases like "what's yours?", "and you?", "what about you?"
  text = text.replace(/[,.\s]+(what'?s?\s+yours|and\s+you|what\s+about\s+you|you\??)\s*\??$/i, '').trim();

  // Remove surrounding punctuation
  text = text.replace(/^[,.\s!?]+|[,.\s!?]+$/g, '').trim();

  // If the result looks like a reasonable name (1-3 words, starts with capital or is short)
  const words = text.split(/\s+/);
  if (words.length <= 3 && text.length >= 2 && text.length <= 50) {
    // Check if it looks like a name (not a full sentence)
    const hasVerb = /\b(is|am|are|was|were|have|has|do|does|can|will|would|should)\b/i.test(text);
    if (!hasVerb) {
      return text;
    }
  }

  // Last resort: try to find a capitalized word that looks like a name
  const capitalizedWords = text.match(/\b[A-Z][a-z]+\b/g);
  if (capitalizedWords && capitalizedWords.length > 0) {
    // Return the first capitalized word (likely a name)
    return capitalizedWords[0];
  }

  // Fallback: return first word if it's reasonable length
  const firstWord = words[0]?.replace(/[^a-zA-Z\u0900-\u097F]/g, '');
  if (firstWord && firstWord.length >= 2 && firstWord.length <= 20) {
    return firstWord;
  }

  // Ultimate fallback
  return text || message.trim();
}

// --- Listing creation helpers (multi-turn detail gathering) ---

/**
 * Check which listing detail is missing and ask the user for it.
 * Returns an AgentResponse if something is missing, or null if all details are present.
 */
// --- Market Price Insights ---

interface MarketPriceInsight {
  en: string;
  hi: string;
  low: number;
  recommended: number;
  high: number;
  discomRate: number;
}

/** Round a number to the nearest 500 (for user-friendly estimates). */
function roundTo500(n: number): number {
  return Math.round(n / 500) * 500;
}

/**
 * Get market price insights for an energy type.
 * In production, this would query actual market data.
 */
function getMarketPriceInsight(energyType: string): MarketPriceInsight {
  // Market data (in production, fetch from database/API)
  const marketData: Record<string, { avg: number; min: number; max: number; discom: number }> = {
    SOLAR: { avg: 4.5, min: 4.0, max: 5.5, discom: 7.5 },
    WIND: { avg: 4.2, min: 3.8, max: 5.0, discom: 7.5 },
    HYDRO: { avg: 4.8, min: 4.2, max: 5.8, discom: 7.5 },
    MIXED: { avg: 4.5, min: 4.0, max: 5.5, discom: 7.5 },
  };

  const data = marketData[energyType] || marketData.SOLAR;
  const savings = Math.round(((data.discom - data.avg) / data.discom) * 100);

  return {
    en: `Current market: ₹${data.min} to ₹${data.max} per unit. Average ₹${data.avg}.\n` +
      `DISCOM rate: ₹${data.discom} per unit.\n` +
      `Your buyers save around ${savings} percent versus DISCOM!`,
    hi: `मार्केट रेट: ₹${data.min} से ₹${data.max} प्रति यूनिट। औसत ₹${data.avg}।\n` +
      `DISCOM रेट: ₹${data.discom} प्रति यूनिट।\n` +
      `खरीदारों को DISCOM से लगभग ${savings} प्रतिशत बचत होती है!`,
    low: data.min,
    recommended: data.avg,
    high: data.max,
    discomRate: data.discom,
  };
}

// Quick sell smart defaults based on common market data
const QUICK_SELL_DEFAULTS = {
  energyType: 'SOLAR',
  pricePerKwh: 6.0, // Competitive market rate
  timeDesc: 'tomorrow 6AM-6PM',
};

function askNextListingDetail(ctx: SessionContext, pending: PendingListing): AgentResponse | null {
  // First interaction: Offer Auto-Trade vs One-time listing choice
  if (!pending.awaitingField && !pending.energyType && pending.quantity == null && pending.pricePerKwh == null && !pending.quickSellMode) {
    return {
      messages: [{
        text: h(ctx,
          '☀️ *Sell Your Energy*\n\nHow would you like to proceed?\n\n🤖 *Sell Automatically:* Daily auto-trade based on weather.\n📝 *One-time Listing:* Create a single offer.',
          '☀️ *बिजली बेचो*\n\nकैसे आगे बढ़ना चाहते हो?\n\n🤖 *ऑटोमैटिक:* रोज़ मौसम के हिसाब से।\n📝 *एक बार:* एक ऑफर बनाओ।'
        ),
        buttons: [
          { text: h(ctx, '🤖 Sell Automatically', '🤖 ऑटोमैटिक'), callbackData: 'action:setup_auto_sell' },
          { text: h(ctx, '📝 One-time Listing', '📝 एक बार'), callbackData: 'listing_mode:detailed' },
        ],
      }],
      contextUpdate: { pendingListing: { ...pending, awaitingField: 'choose_mode' } },
    };
  }

  // Quick Sell mode: Only ask for quantity
  if (pending.quickSellMode) {
    if (pending.quantity == null) {
      const marketInsight = getMarketPriceInsight(pending.energyType || 'SOLAR');
      return {
        messages: [{
          text: h(ctx,
            `⚡ *Sell Automatically*\n\n` +
            `Using smart defaults.\n` +
            `• Type: Solar.\n` +
            `• Price: ₹${QUICK_SELL_DEFAULTS.pricePerKwh}/unit, market recommended.\n` +
            `• Time: Tomorrow 6AM to 6PM.\n\n` +
            `📊 *Just tell me, how many units do you want to sell?*`,
            `⚡ *ऑटोमैटिक सेल*\n\n` +
            `स्मार्ट सेटिंग्स।\n` +
            `• प्रकार: सोलर।\n` +
            `• दाम: ₹${QUICK_SELL_DEFAULTS.pricePerKwh}/यूनिट, बाज़ार अनुसार।\n` +
            `• समय: कल सुबह 6 से शाम 6।\n\n` +
            `📊 *बस बताओ, कितने यूनिट बेचने हैं?*`
          ),
          buttons: [
            { text: '🔋 25 units', callbackData: 'listing_qty:25' },
            { text: '🔋 50 units', callbackData: 'listing_qty:50' },
            { text: '🔋 100 units', callbackData: 'listing_qty:100' },
          ],
        }],
        contextUpdate: { pendingListing: { ...pending, awaitingField: 'quantity' } },
      };
    }
    // All quick sell details are set, go to confirmation
    // (Price and time are from defaults)
    pending.pricePerKwh = pending.pricePerKwh || QUICK_SELL_DEFAULTS.pricePerKwh;
    pending.energyType = pending.energyType || QUICK_SELL_DEFAULTS.energyType;
    pending.timeDesc = pending.timeDesc || QUICK_SELL_DEFAULTS.timeDesc;
  }

  // Detailed mode: Ask for energy type
  if (!pending.energyType) {
    return {
      messages: [{
        text: h(ctx,
          'What type of energy do you want to sell?',
          'आप कौन सी एनर्जी बेचना चाहते हो?'
        ),
        buttons: [
          { text: h(ctx, '☀️ Solar', '☀️ सोलर'), callbackData: 'listing_type:SOLAR' },
          { text: h(ctx, '💨 Wind', '💨 विंड'), callbackData: 'listing_type:WIND' },
          { text: h(ctx, '💧 Hydro', '💧 हाइड्रो'), callbackData: 'listing_type:HYDRO' },
        ],
      }],
      contextUpdate: { pendingListing: { ...pending, awaitingField: 'energy_type' } },
    };
  }

  if (pending.quantity == null) {
    return {
      messages: [{
        text: h(ctx,
          `How many units do you want to sell?`,
          `कितने यूनिट बेचना चाहते हो?`
        ),
        slider: {
          type: 'quantity',
          min: 5,
          max: 200,
          step: 5,
          defaultValue: 25,
          unit: 'units',
          callbackPrefix: 'listing_qty',
        },
      }],
      contextUpdate: { pendingListing: { ...pending, awaitingField: 'quantity' } },
    };
  }

  if (pending.pricePerKwh == null) {
    // Get market pricing insights
    const marketInsight = getMarketPriceInsight(pending.energyType || 'SOLAR');

    return {
      messages: [{
        text: h(ctx,
          `💡 *Smart Pricing*\n` +
          `${marketInsight.en}\n\n` +
          `What price per unit would you like?`,

          `💡 *Smart Pricing*\n` +
          `${marketInsight.hi}\n\n` +
          `प्रति यूनिट कितने रुपये में बेचोगे?`
        ),
        slider: {
          type: 'price',
          min: marketInsight.low,
          max: marketInsight.high + 2,
          step: 0.5,
          defaultValue: marketInsight.recommended,
          unit: '₹/unit',
          callbackPrefix: 'listing_price',
        },
      }],
      contextUpdate: { pendingListing: { ...pending, awaitingField: 'price' } },
    };
  }

  if (!pending.timeDesc) {
    return {
      messages: [{
        text: h(ctx,
          'When do you want to sell?',
          'कब बेचना चाहते हो?'
        ),
        buttons: [
          { text: h(ctx, '🌅 Tomorrow 6AM-6PM', '🌅 कल सुबह 6 से शाम 6'), callbackData: 'listing_time:tomorrow' },
          { text: h(ctx, '📅 Today', '📅 आज'), callbackData: 'listing_time:today' },
        ],
      }],
      contextUpdate: { pendingListing: { ...pending, awaitingField: 'timeframe' } },
    };
  }

  // All details present — ask for confirmation
  const typeLabel = pending.energyType || 'Solar';
  const typeLabelHi = pending.energyType === 'WIND' ? 'विंड' : pending.energyType === 'HYDRO' ? 'हाइड्रो' : 'सोलर';
  const timeLabel = pending.timeDesc || 'tomorrow';
  const timeLabelHi = timeLabel === 'today' ? 'आज' : 'कल';
  return {
    messages: [{
      text: h(ctx,
        `Here's your listing:\n• ${pending.quantity} units of ${typeLabel} energy\n• ₹${pending.pricePerKwh}/unit\n• Time: ${timeLabel}\n\nShall I create it?`,
        `आपकी लिस्टिंग:\n• ${pending.quantity} यूनिट ${typeLabelHi} एनर्जी\n• ₹${pending.pricePerKwh}/यूनिट\n• समय: ${timeLabelHi}\n\nबना दूं?`
      ),
      buttons: [
        { text: h(ctx, '✅ Yes, create it!', '✅ हाँ, बना दो!'), callbackData: 'listing_confirm:yes' },
        { text: h(ctx, '❌ No, cancel', '❌ नहीं, रद्द करो'), callbackData: 'listing_confirm:no' },
      ],
    }],
    contextUpdate: { pendingListing: { ...pending, awaitingField: 'confirm' } },
  };
}

/**
 * Handle user input for a pending listing (multi-turn).
 * Returns AgentResponse if handled, null if not a pending-listing input.
 */
async function handlePendingListingInput(ctx: SessionContext, message: string): Promise<AgentResponse | null> {
  const pending = ctx.pendingListing;
  if (!pending?.awaitingField) return null;

  const lower = message.toLowerCase().trim();

  // Allow cancellation at any point (including button callbacks)
  if (lower === 'cancel' || lower === 'nahi' || lower === 'no' || lower === 'back' || lower === 'stop'
    || message === 'listing_confirm:no' || message === 'cmd:cancel') {
    return {
      messages: [{
        text: h(ctx, 'Listing cancelled.', 'लिस्टिंग रद्द हो गई।'),
        buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
      }],
      contextUpdate: { pendingListing: undefined },
    };
  }

  // Handle numeric input for WhatsApp - convert to callbacks based on current field
  const numInput = parseInt(message.trim(), 10);
  if (!isNaN(numInput) && numInput >= 1 && numInput <= 10) {
    if (pending.awaitingField === 'energy_type' && numInput <= 3) {
      const typeMap = ['SOLAR', 'WIND', 'HYDRO'];
      message = `listing_type:${typeMap[numInput - 1]}`;
    } else if (pending.awaitingField === 'price' && numInput <= 3) {
      // Prices are dynamically generated, so we can't map directly - let it parse as price
    } else if (pending.awaitingField === 'timeframe' && numInput <= 2) {
      const timeMap = ['tomorrow', 'today'];
      message = `listing_time:${timeMap[numInput - 1]}`;
    } else if (pending.awaitingField === 'confirm' && numInput <= 2) {
      const confirmMap = ['yes', 'no'];
      message = `listing_confirm:${confirmMap[numInput - 1]}`;
    }
  }

  switch (pending.awaitingField) {
    case 'choose_mode': {
      // Pass through ALL action: callbacks to the main action handler (e.g. setup_auto_sell, check_auto_trade, stop_auto_trade)
      if (message.startsWith('action:')) {
        // Clear pendingListing in context so the action handler starts clean
        ctx.pendingListing = undefined;
        return null;
      }
      // Handle mode selection: Quick sell vs Detailed
      if (message === 'listing_mode:quick' || lower.includes('quick') || numInput === 1) {
        // ONE-CLICK: Directly create a default offer without asking anything
        if (!ctx.userId) {
          return {
            messages: [{ text: h(ctx, 'Please log in first to sell energy.', 'बिजली बेचने के लिए पहले लॉग इन करो।') }],
            contextUpdate: { pendingListing: undefined },
          };
        }
        const result = await mockTradingAgent.createDefaultOffer(ctx.userId);
        if (result.success && result.offer) {
          const o = result.offer;
          return {
            messages: [{
              text: h(ctx,
                `Your energy is now on sale!`,
                `आपकी बिजली बिक्री के लिए तैयार!`
              ),
              offerCreated: {
                quantity: o.quantity,
                pricePerKwh: o.pricePerKwh,
                startTime: o.startTime,
                endTime: o.endTime,
                energyType: 'SOLAR',
              },
              buttons: [
                { text: h(ctx, '📋 My Listings', '📋 मेरी लिस्टिंग'), callbackData: 'action:show_listings' },
                { text: h(ctx, '🔋 Buy Energy', '🔋 बिजली खरीदो'), callbackData: 'action:buy_energy' },
                { text: h(ctx, '💰 My Earnings', '💰 मेरी कमाई'), callbackData: 'action:show_earnings' },
              ],
            }],
            contextUpdate: { pendingListing: undefined },
          };
        }
        return {
          messages: [{
            text: h(ctx, `Could not create listing: ${result.error || 'Unknown error'}. Please try again.`, `लिस्टिंग नहीं बन पाई: ${result.error || 'अज्ञात समस्या'}। दोबारा कोशिश करो।`),
            buttons: [
              { text: h(ctx, '☀️ Try Again', '☀️ फिर से कोशिश करो'), callbackData: 'action:create_listing' },
            ],
          }],
          contextUpdate: { pendingListing: undefined },
        };
      } else if (message === 'listing_mode:detailed' || lower.includes('detail') || lower.includes('vistar') || lower.includes('one') || lower.includes('once') || numInput === 2) {
        // One-time listing - set awaitingField to 'energy_type' to skip the initial menu and proceed
        const updated: PendingListing = {
          ...pending,
          quickSellMode: false,
          awaitingField: 'energy_type',
        };
        const next = askNextListingDetail(ctx, updated);
        return next || { messages: [], contextUpdate: { pendingListing: updated } };
      }
      // Invalid selection - re-prompt
      return {
        messages: [{
          text: h(ctx, 'Please select Automatic or Detailed:', 'ऑटोमैटिक या विस्तार से चुनो:'),
          buttons: [
            { text: h(ctx, '⚡ Automatic', '⚡ ऑटोमैटिक'), callbackData: 'listing_mode:quick' },
            { text: h(ctx, '📝 Detailed', '📝 विस्तार से'), callbackData: 'listing_mode:detailed' },
          ],
        }],
      };
    }

    case 'energy_type': {
      let energyType: string | undefined;
      if (message.startsWith('listing_type:')) {
        energyType = message.replace('listing_type:', '');
      } else if (lower.includes('solar')) {
        energyType = 'SOLAR';
      } else if (lower.includes('wind')) {
        energyType = 'WIND';
      } else if (lower.includes('hydro')) {
        energyType = 'HYDRO';
      } else if (lower.includes('mix')) {
        energyType = 'MIXED';
      }

      if (!energyType) {
        return {
          messages: [{
            text: h(ctx, 'Please select an energy type:', 'Energy type chuno:'),
            buttons: [
              { text: '☀️ Solar', callbackData: 'listing_type:SOLAR' },
              { text: '💨 Wind', callbackData: 'listing_type:WIND' },
              { text: '💧 Hydro', callbackData: 'listing_type:HYDRO' },
            ],
          }],
        };
      }

      const updated = { ...pending, energyType, awaitingField: undefined as any };
      const next = askNextListingDetail(ctx, updated);
      return next || { messages: [], contextUpdate: { pendingListing: updated } };
    }

    case 'quantity': {
      // Handle listing_qty callback
      let num: number;
      if (message.startsWith('listing_qty:')) {
        num = parseFloat(message.replace('listing_qty:', ''));
      } else {
        num = parseFloat(message.replace(/[^\d.]/g, ''));
      }

      if (!num || num <= 0) {
        return {
          messages: [{ text: h(ctx, 'Please enter a valid number of units.', 'Sahi unit number daalo.') }],
        };
      }
      const updated = { ...pending, quantity: Math.round(num), awaitingField: undefined as any };
      const next = askNextListingDetail(ctx, updated);
      return next || { messages: [], contextUpdate: { pendingListing: updated } };
    }

    case 'price': {
      let price: number | undefined;
      if (message.startsWith('listing_price:')) {
        price = parseFloat(message.replace('listing_price:', ''));
      } else {
        price = parseFloat(message.replace(/[^\d.]/g, ''));
      }

      if (!price || price <= 0) {
        return {
          messages: [{ text: h(ctx, 'Please enter a valid price in Rs.', 'Sahi price daalo (Rs mein).') }],
        };
      }
      const updated = { ...pending, pricePerKwh: price, awaitingField: undefined as any };
      const next = askNextListingDetail(ctx, updated);
      return next || { messages: [], contextUpdate: { pendingListing: updated } };
    }

    case 'timeframe': {
      let timeDesc: string | undefined;
      if (message.startsWith('listing_time:')) {
        timeDesc = message.replace('listing_time:', '');
      } else {
        timeDesc = message.trim();
      }

      if (!timeDesc || timeDesc.length < 2) {
        return {
          messages: [{ text: h(ctx, 'Please tell me when you want to sell (e.g. "tomorrow", "today").', 'कब बेचना है बताओ (जैसे "कल", "आज")।') }],
        };
      }
      const updated = { ...pending, timeDesc, awaitingField: undefined as any };
      const next = askNextListingDetail(ctx, updated);
      return next || { messages: [], contextUpdate: { pendingListing: updated } };
    }

    case 'confirm': {
      if (message.startsWith('listing_confirm:')) {
        const answer = message.replace('listing_confirm:', '');
        if (answer === 'no') {
          return {
            messages: [{ text: h(ctx, 'Listing cancelled.', 'लिस्टिंग रद्द हो गई।') }],
            contextUpdate: { pendingListing: undefined },
          };
        }
      }

      const isYes = ['yes', 'y', 'haan', 'ha', 'ok', 'sure', 'create', 'bana', 'listing_confirm:yes'].includes(lower)
        || message === 'listing_confirm:yes';
      const isNo = ['no', 'n', 'nahi', 'nope', 'cancel', 'listing_confirm:no'].includes(lower)
        || message === 'listing_confirm:no';

      if (isNo) {
        return {
          messages: [{ text: h(ctx, 'Listing cancelled.', 'लिस्टिंग रद्द हो गई।') }],
          contextUpdate: { pendingListing: undefined },
        };
      }

      if (isYes) {
        // Create the listing
        return await createListingFromPending(ctx, pending);
      }

      // Re-prompt
      return {
        messages: [{
          text: h(ctx, 'Create this listing?', 'Ye listing banaun?'),
          buttons: [
            { text: h(ctx, '✅ Yes', '✅ Haan'), callbackData: 'listing_confirm:yes' },
            { text: h(ctx, '❌ No', '❌ Nahi'), callbackData: 'listing_confirm:no' },
          ],
        }],
      };
    }
  }

  return null;
}

/**
 * Create a listing from the completed pending listing details.
 */
async function createListingFromPending(ctx: SessionContext, pending: PendingListing): Promise<AgentResponse> {
  if (!ctx.userId || !pending.pricePerKwh || !pending.quantity) {
    return {
      messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
      contextUpdate: { pendingListing: undefined },
    };
  }

  const result = await mockTradingAgent.createCustomOffer(ctx.userId, {
    pricePerKwh: pending.pricePerKwh,
    quantity: pending.quantity,
    timeDesc: pending.timeDesc,
  });

  if (result.success && result.offer) {
    const o = result.offer;
    return {
      messages: [{
        text: h(ctx,
          `Your listing is now live!`,
          `आपकी लिस्टिंग लाइव है!`
        ),
        offerCreated: {
          quantity: o.quantity,
          pricePerKwh: o.pricePerKwh,
          startTime: o.startTime,
          endTime: o.endTime,
          energyType: pending.energyType || 'SOLAR',
        },
        buttons: [
          { text: h(ctx, '📋 View My Listings', '📋 मेरी लिस्टिंग देखो'), callbackData: 'action:show_listings' },
          { text: h(ctx, '🔋 Buy Energy', '🔋 बिजली खरीदो'), callbackData: 'action:buy_energy' },
          { text: h(ctx, '💰 My Earnings', '💰 मेरी कमाई'), callbackData: 'action:show_earnings' },
        ],
      }],
      contextUpdate: { pendingListing: undefined },
    };
  }

  return {
    messages: [{
      text: h(ctx, `Could not create the listing: ${result.error || 'Unknown error'}. Please try again.`, `लिस्टिंग नहीं बन पाई: ${result.error || 'अज्ञात समस्या'}। दोबारा कोशिश करो।`),
      buttons: [
        { text: h(ctx, '☀️ Try Again', '☀️ फिर से कोशिश करो'), callbackData: 'action:create_listing' },
        { text: h(ctx, '🔋 Buy Energy', '🔋 बिजली खरीदो'), callbackData: 'action:buy_energy' },
      ],
    }],
    contextUpdate: { pendingListing: undefined },
  };
}

// --- Purchase (buyer) helpers (multi-turn detail gathering) ---

/**
 * Check which purchase detail is missing and ask the user for it.
 * Returns an AgentResponse if something is missing, or null if all details are present.
 */
async function askNextPurchaseDetail(ctx: SessionContext, pending: PendingPurchase): Promise<AgentResponse | null> {
  // First interaction: Offer Auto-Buy vs One-time purchase choice
  if (!pending.awaitingField && pending.quantity == null && !pending.timeDesc) {
    return {
      messages: [{
        text: h(ctx,
          '🔋 *Buy Energy*\n\nHow would you like to proceed?\n\n🤖 *Buy Automatically:* Daily auto-buy at best prices.\n📝 *One-time Purchase:* Buy energy once.',
          '🔋 *बिजली खरीदो*\n\nकैसे आगे बढ़ना चाहते हो?\n\n🤖 *ऑटोमैटिक:* रोज़ सबसे सस्ते दाम पर।\n📝 *एक बार:* एक बार खरीदो।'
        ),
        buttons: [
          { text: h(ctx, '🤖 Buy Automatically', '🤖 ऑटोमैटिक'), callbackData: 'action:setup_auto_buy' },
          { text: h(ctx, '📝 One-time Purchase', '📝 एक बार'), callbackData: 'purchase_mode:onetime' },
        ],
      }],
      contextUpdate: { pendingPurchase: { ...pending, awaitingField: 'choose_mode' } },
    };
  }

  // Ask for quantity (after mode choice or if already in one-time mode)
  if (pending.quantity == null) {
    return {
      messages: [{
        text: h(ctx,
          '📝 *How much energy do you need?*\n\n💡 Tip: 50 units = enough for 5 homes for 1 day',
          '📝 *कितनी बिजली चाहिए?*\n\n💡 टिप: 50 यूनिट = 5 घरों के लिए 1 दिन की बिजली'
        ),
        slider: {
          type: 'quantity',
          min: 5,
          max: 200,
          step: 5,
          defaultValue: 25,
          unit: 'units',
          callbackPrefix: 'purchase_qty',
        },
      }],
      contextUpdate: { pendingPurchase: { ...pending, awaitingField: 'quantity' } },
    };
  }

  // Ask for time SECOND (after quantity)
  if (!pending.timeDesc) {
    return {
      messages: [{
        text: h(ctx,
          '⏰ *When do you need it?*\n\nChoose when you want the energy delivered.',
          '⏰ *कब चाहिए?*\n\nबताओ बिजली कब डिलीवर करनी है।'
        ),
        buttons: [
          { text: h(ctx, '🌅 Tomorrow morning', '🌅 कल सुबह'), callbackData: 'purchase_time:tomorrow morning' },
          { text: h(ctx, '☀️ Tomorrow afternoon', '☀️ कल दोपहर'), callbackData: 'purchase_time:tomorrow afternoon' },
          { text: h(ctx, '🌇 Today evening', '🌇 आज शाम'), callbackData: 'purchase_time:today evening' },
        ],
      }],
      contextUpdate: { pendingPurchase: { ...pending, awaitingField: 'timeframe' } },
    };
  }

  // All details present — signal caller to proceed with discovery
  return null;
}

/**
 * Discover the best offer(s) and present them to the user for confirmation.
 * Uses smart buy to automatically find single or multi-seller deals.
 */
async function discoverAndShowOffer(ctx: SessionContext, pending: PendingPurchase): Promise<AgentResponse> {
  if (!ctx.userId || !pending.quantity) {
    return {
      messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
      contextUpdate: { pendingPurchase: undefined },
    };
  }

  const searchMsg: AgentMessage = {
    text: h(ctx,
      'Searching for the best deals...',
      'सबसे अच्छी डील ढूंढ रहा हूं...'
    ),
  };

  const result = await discoverBestOffer(ctx.userId, {
    quantity: pending.quantity,
    timeDesc: pending.timeDesc,
  });

  if (!result.success || !result.transactionId || (!result.discoveredOffer && !result.discoveredOffers?.length)) {
    // Auth expired — prompt re-login
    if (result.authExpired) {
      return {
        messages: [
          searchMsg,
          {
            text: h(ctx,
              'Your session has expired. Please log in again using /start.',
              'आपका सेशन समाप्त हो गया। /start से दोबारा लॉगिन करो।'
            )
          },
        ],
        contextUpdate: { pendingPurchase: undefined },
      };
    }

    // Build suggestion message with alternative time windows
    const messages: AgentMessage[] = [searchMsg];
    const localizedErr = localizeError(ctx, result.error) || h(ctx, 'No matching offers found.', 'कोई ऑफ़र नहीं मिला।');
    let errorText = localizedErr;

    if (result.availableWindows && result.availableWindows.length > 0) {
      const windowStrs = result.availableWindows.slice(0, 3).map(tw => {
        try {
          const s = new Date(tw.startTime);
          const e = new Date(tw.endTime);
          return `${s.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${s.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}-${e.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
        } catch { return ''; }
      }).filter(Boolean);

      if (windowStrs.length > 0) {
        errorText += h(ctx,
          `\n\nOffers are available at these times:\n${windowStrs.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\nWould you like to try a different time?`,
          `\n\nइन समय पर ऑफ़र उपलब्ध हैं:\n${windowStrs.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\nअलग समय पर कोशिश करोगे?`
        );
      }
    }

    messages.push({
      text: errorText,
      buttons: [
        { text: h(ctx, '🔄 Try different time', '🔄 अलग समय'), callbackData: 'purchase_time:retry' },
        { text: h(ctx, '❌ Cancel', '❌ रद्द करो'), callbackData: 'purchase_offer_confirm:no' },
      ],
    });

    return {
      messages,
      contextUpdate: { pendingPurchase: { ...pending, awaitingField: 'timeframe', timeDesc: undefined } },
    };
  }

  const offers = result.discoveredOffers || [];
  const summary = result.summary;
  const selectionType = result.selectionType || 'single';
  const timeWindow = offers[0]?.timeWindow || 'Flexible';

  // Build matchedOffers card data for both single and multi-offer displays
  // Round quantities and prices for cleaner display
  const matchedOffersCard = {
    selectionType: selectionType as 'single' | 'multiple',
    offers: offers.map(o => ({
      offerId: o.offerId,
      providerId: o.providerId,
      providerName: o.providerName,
      trustScore: 0.7, // Default trust score
      energyType: 'SOLAR', // Default to solar
      quantity: Math.round(o.quantity * 10) / 10, // Round to 1 decimal
      pricePerKwh: Math.round(o.price * 100) / 100, // Round to 2 decimals
      subtotal: Math.round(o.subtotal || (o.price * o.quantity)),
      timeWindow: o.timeWindow || timeWindow,
    })),
    summary: summary ? {
      totalQuantity: Math.round(summary.totalQuantity * 10) / 10,
      totalPrice: Math.round(summary.totalPrice),
      averagePrice: Math.round(summary.averagePrice * 100) / 100,
      fullyFulfilled: summary.fullyFulfilled,
      shortfall: Math.round((summary.shortfall || 0) * 10) / 10,
      offersUsed: summary.offersUsed,
    } : {
      totalQuantity: Math.round(offers.reduce((s, o) => s + o.quantity, 0) * 10) / 10,
      totalPrice: Math.round(offers.reduce((s, o) => s + (o.subtotal || o.price * o.quantity), 0)),
      averagePrice: offers.length > 0 ? Math.round((offers.reduce((s, o) => s + o.price, 0) / offers.length) * 100) / 100 : 0,
      fullyFulfilled: true,
      shortfall: 0,
      offersUsed: offers.length,
    },
    timeWindow,
    transactionId: result.transactionId || '',
  };

  // Build text message (fallback for WhatsApp/Telegram)
  const textMessage = selectionType === 'single' && offers.length === 1
    ? h(ctx,
        `Found a match!\n\n• Seller: ${offers[0].providerName}\n• ${offers[0].quantity} units at Rs ${offers[0].price}/unit\n• Total: Rs ${(offers[0].subtotal || offers[0].price * offers[0].quantity).toFixed(2)}\n• Time: ${offers[0].timeWindow}\n\nDo you want to buy this?`,
        `ऑफ़र मिल गया!\n\n• विक्रेता: ${offers[0].providerName}\n• ${offers[0].quantity} यूनिट ₹${offers[0].price}/यूनिट पर\n• कुल: ₹${(offers[0].subtotal || offers[0].price * offers[0].quantity).toFixed(2)}\n• समय: ${offers[0].timeWindow}\n\nये खरीदना है?`
      )
    : h(ctx,
        `Found best deals from ${offers.length} sellers!\n\n${offers.map((o, i) => `${i + 1}. ${o.providerName}\n   ${o.quantity} units × Rs ${o.price}/unit = Rs ${o.subtotal.toFixed(2)}`).join('\n\n')}\n\nTotal: ${matchedOffersCard.summary.totalQuantity} units | Rs ${matchedOffersCard.summary.totalPrice.toFixed(2)}\nTime: ${timeWindow}\n\nAccept this deal?`,
        `${offers.length} विक्रेताओं से बेस्ट डील मिली!\n\n${offers.map((o, i) => `${i + 1}. ${o.providerName}\n   ${o.quantity} यूनिट × ₹${o.price}/यूनिट = ₹${o.subtotal.toFixed(2)}`).join('\n\n')}\n\nकुल: ${matchedOffersCard.summary.totalQuantity} यूनिट | ₹${matchedOffersCard.summary.totalPrice.toFixed(2)}\nसमय: ${timeWindow}\n\nये डील मंज़ूर है?`
      );

  return {
    messages: [
      searchMsg,
      {
        text: textMessage,
        matchedOffers: matchedOffersCard, // Premium UI card for web
        buttons: [
          { text: h(ctx, selectionType === 'single' ? '✅ Yes, buy it!' : '✅ Yes, buy all!', selectionType === 'single' ? '✅ हाँ, खरीद लो!' : '✅ हाँ, सब खरीद लो!'), callbackData: 'purchase_offer_confirm:yes' },
          { text: h(ctx, '❌ No, cancel', '❌ नहीं, रद्द करो'), callbackData: 'purchase_offer_confirm:no' },
        ],
      },
    ],
    contextUpdate: {
      pendingPurchase: {
        ...pending,
        awaitingField: 'confirm_offer',
        discoveredOffer: selectionType === 'single' && offers.length === 1 ? {
          offerId: offers[0].offerId,
          providerId: offers[0].providerId,
          providerName: offers[0].providerName,
          price: offers[0].price,
          quantity: offers[0].quantity,
          timeWindow: offers[0].timeWindow,
        } : undefined,
        discoveredOffers: offers,
        selectionType,
        summary,
        transactionId: result.transactionId,
      },
    },
  };
}

/**
 * Handle user input for a pending purchase (multi-turn).
 * Returns AgentResponse if handled, null if not a pending-purchase input.
 */
async function handlePendingPurchaseInput(ctx: SessionContext, message: string): Promise<AgentResponse | null> {
  const pending = ctx.pendingPurchase;
  if (!pending?.awaitingField) return null;

  const lower = message.toLowerCase().trim();

  // Allow cancellation at any point (including button callbacks)
  if (lower === 'cancel' || lower === 'nahi' || lower === 'no' || lower === 'back' || lower === 'stop'
    || message === 'purchase_offer_confirm:no' || message === 'purchase_confirm:no' || message === 'cmd:cancel') {
    return {
      messages: [{ text: h(ctx, 'Purchase cancelled.', 'खरीदारी रद्द हो गई।') }],
      contextUpdate: { pendingPurchase: undefined },
    };
  }

  // Handle numeric input for WhatsApp - convert to callbacks based on current field
  const numInput = parseInt(message.trim(), 10);
  if (!isNaN(numInput) && numInput >= 1 && numInput <= 10) {
    if (pending.awaitingField === 'top_deals' && numInput <= 4) {
      // Handle deal selection from top deals view
      // numInput 4 = custom, handled below
      if (numInput === 4) {
        message = 'buy_custom';
      }
      // 1-3 are handled by the main message parsing below (buy_deal callback)
    } else if (pending.awaitingField === 'quantity' && numInput <= 3) {
      const qtyMap = [10, 25, 50];
      message = `purchase_qty:${qtyMap[numInput - 1]}`;
    } else if (pending.awaitingField === 'timeframe' && numInput <= 3) {
      const timeMap = ['tomorrow morning', 'tomorrow afternoon', 'today evening'];
      message = `purchase_time:${timeMap[numInput - 1]}`;
    } else if ((pending.awaitingField === 'confirm' || pending.awaitingField === 'confirm_offer') && numInput <= 2) {
      const confirmMap = ['yes', 'no'];
      if (pending.awaitingField === 'confirm') {
        message = `purchase_confirm:${confirmMap[numInput - 1]}`;
      } else {
        message = `purchase_offer_confirm:${confirmMap[numInput - 1]}`;
      }
    }
  }

  switch (pending.awaitingField) {
    case 'top_deals': {
      // Handle top deals selection
      if (message.startsWith('buy_deal:')) {
        // Format: buy_deal:offerId:quantity
        const parts = message.replace('buy_deal:', '').split(':');
        const offerId = parts[0];
        const quantity = parseInt(parts[1], 10);

        // Skip regular flow, go directly to purchase this specific deal
        const updated = {
          ...pending,
          selectedDealId: offerId,
          quantity: quantity,
          timeDesc: 'tomorrow', // Default time for quick deal purchase
          awaitingField: 'confirm_offer' as const,
        };

        return {
          messages: [{
            text: h(ctx,
              `✅ *Confirm Purchase*\n\nYou selected:\n• ${quantity} units\n• Time: Tomorrow\n\nProceed with purchase?`,
              `✅ *खरीदारी पक्की करें*\n\nआपने चुना:\n• ${quantity} यूनिट\n• समय: कल\n\nखरीदना है?`
            ),
            buttons: [
              { text: h(ctx, '✅ Yes, buy it!', '✅ हाँ, खरीद लो!'), callbackData: 'purchase_offer_confirm:yes' },
              { text: h(ctx, '❌ No, cancel', '❌ नहीं, रद्द करो'), callbackData: 'purchase_offer_confirm:no' },
            ],
          }],
          contextUpdate: { pendingPurchase: updated },
        };
      } else if (message === 'buy_custom' || lower.includes('custom')) {
        // User wants custom amount - skip top deals and go to quantity
        const updated = { ...pending, topDealsShown: true, awaitingField: undefined as any };
        const next = await askNextPurchaseDetail(ctx, updated);
        return next || { messages: [], contextUpdate: { pendingPurchase: updated } };
      } else {
        // Try to handle as a numeric deal selection (1, 2, 3)
        if (numInput >= 1 && numInput <= 3) {
          // Re-fetch deals and select
          const { deals } = await getTopDeals(3, ctx.language);
          if (numInput <= deals.length) {
            const deal = deals[numInput - 1];
            const updated = {
              ...pending,
              selectedDealId: deal.offerId,
              quantity: deal.quantity,
              timeDesc: 'tomorrow',
              awaitingField: 'confirm_offer' as const,
            };

            return {
              messages: [{
                text: h(ctx,
                  `✅ *Confirm Purchase*\n\nYou selected Deal #${numInput}:\n• ${deal.quantity} units @ ₹${deal.pricePerUnit}/unit\n• Total: ₹${(deal.quantity * deal.pricePerUnit).toFixed(0)}\n• Time: Tomorrow\n\nProceed with purchase?`,
                  `✅ *खरीदारी पक्की करें*\n\nआपने डील #${numInput} चुना:\n• ${deal.quantity} यूनिट @ ₹${deal.pricePerUnit}/यूनिट\n• कुल: ₹${(deal.quantity * deal.pricePerUnit).toFixed(0)}\n• समय: कल\n\nखरीदना है?`
                ),
                buttons: [
                  { text: h(ctx, '✅ Yes, buy it!', '✅ हाँ, खरीद लो!'), callbackData: 'purchase_offer_confirm:yes' },
                  { text: h(ctx, '❌ No, cancel', '❌ नहीं, रद्द करो'), callbackData: 'purchase_offer_confirm:no' },
                ],
              }],
              contextUpdate: { pendingPurchase: updated },
            };
          }
        }

        // Invalid selection - re-show deals
        const { deals, message: dealsMessage } = await getTopDeals(3, ctx.language);
        const buttons = deals.slice(0, 3).map((deal, i) => ({
          text: `${i + 1}️⃣ Buy ${deal.quantity} units @ ₹${deal.pricePerUnit}`,
          callbackData: `buy_deal:${deal.offerId}:${deal.quantity}`,
        }));
        buttons.push({ text: h(ctx, '📝 Custom amount', '📝 अपनी मात्रा'), callbackData: 'buy_custom' });

        return {
          messages: [{
            text: h(ctx, 'Please select a deal number (1-3) or choose Custom:', 'Deal number chuno (1-3) ya Custom chuno:') + '\n\n' + dealsMessage,
            buttons,
          }],
        };
      }
    }

    case 'choose_mode': {
      // Handle mode selection: Automatic vs One-time
      if (message === 'purchase_mode:onetime' || lower.includes('one') || lower.includes('once') || lower.includes('ek baar') || numInput === 2) {
        // One-time purchase - set to quantity to skip mode selection loop
        const updated: PendingPurchase = {
          ...pending,
          awaitingField: 'quantity',
        };
        const next = await askNextPurchaseDetail(ctx, updated);
        return next || { messages: [], contextUpdate: { pendingPurchase: updated } };
      }
      // Handle "Buy Automatically" selection - start auto-buy setup flow
      if (message === 'action:setup_auto_buy' || lower.includes('auto') || lower.includes('automatic') || numInput === 1) {
        // Start step-by-step auto-buy flow with buttons based on sanctioned load
        const userData = await prisma.user.findUnique({
          where: { id: ctx.userId! },
          select: { sanctionedLoadKW: true },
        });

        // Calculate suggested quantities based on sanctioned load
        const sanctionedKW = userData?.sanctionedLoadKW || 5; // Default 5 kW
        const dailyUsageEstimate = Math.round(sanctionedKW * 4); // ~4 hours peak usage estimate
        const suggestedQuantities = [
          Math.round(dailyUsageEstimate * 0.5), // Half usage
          dailyUsageEstimate,                    // Full estimate
          Math.round(dailyUsageEstimate * 1.5), // 1.5x
          Math.round(dailyUsageEstimate * 2),   // Double
        ].filter(q => q > 0);

        const quantities = suggestedQuantities.length >= 3
          ? suggestedQuantities.slice(0, 4)
          : [10, 20, 30, 50];

        const defaultQty = quantities.length > 1 ? quantities[1] : 20; // Use 2nd suggestion as default
        return {
          messages: [{
            text: h(ctx,
              `🤖 *Set Up Auto-Buy*\n\nI'll buy energy for you at the best prices!\n\nBased on your ${sanctionedKW} kW connection, how many units do you need daily?`,
              `🤖 *ऑटो-बाय सेटअप*\n\nमैं आपके लिए सबसे सस्ते दाम पर बिजली खरीदूंगा!\n\nआपके ${sanctionedKW} kW कनेक्शन के हिसाब से, रोज़ कितनी यूनिट चाहिए?`
            ),
            slider: {
              type: 'quantity',
              min: 5,
              max: Math.max(100, sanctionedKW * 10),
              step: 5,
              defaultValue: defaultQty,
              unit: 'units',
              callbackPrefix: 'autobuy_qty',
            },
          }],
          contextUpdate: {
            pendingPurchase: undefined,
            pendingAutoBuy: { awaitingField: 'quantity', suggestedQuantities: quantities },
          },
        };
      }
      // Invalid selection - re-prompt
      return {
        messages: [{
          text: h(ctx, 'Please select Automatic or One-time purchase:', 'ऑटोमैटिक या एक बार खरीदो चुनो:'),
          buttons: [
            { text: h(ctx, '🤖 Buy Automatically', '🤖 ऑटोमैटिक'), callbackData: 'action:setup_auto_buy' },
            { text: h(ctx, '📝 One-time Purchase', '📝 एक बार'), callbackData: 'purchase_mode:onetime' },
          ],
        }],
      };
    }

    case 'quantity': {
      let qty: number | undefined;
      if (message.startsWith('purchase_qty:')) {
        qty = parseFloat(message.replace('purchase_qty:', ''));
      } else {
        qty = parseFloat(message.replace(/[^\d.]/g, ''));
      }

      if (!qty || qty <= 0) {
        return {
          messages: [{ text: h(ctx, 'Please enter a valid number of units.', 'Sahi units number daalo.') }],
        };
      }
      const updated = { ...pending, quantity: Math.round(qty), awaitingField: undefined as any };
      const next = await askNextPurchaseDetail(ctx, updated);
      if (next) return next;
      return discoverAndShowOffer(ctx, updated);
    }

    case 'timeframe': {
      // "Try different time" retry button — re-prompt for time selection
      if (message === 'purchase_time:retry') {
        return {
          messages: [{
            text: h(ctx,
              'When do you need the energy?',
              'बिजली कब चाहिए?'
            ),
            buttons: [
              { text: h(ctx, '🌅 Tomorrow morning', '🌅 कल सुबह'), callbackData: 'purchase_time:tomorrow morning' },
              { text: h(ctx, '☀️ Tomorrow afternoon', '☀️ कल दोपहर'), callbackData: 'purchase_time:tomorrow afternoon' },
              { text: h(ctx, '🌆 Today evening', '🌆 आज शाम'), callbackData: 'purchase_time:today evening' },
            ],
          }],
        };
      }

      let timeDesc: string | undefined;
      if (message.startsWith('purchase_time:')) {
        timeDesc = message.replace('purchase_time:', '');
      } else {
        timeDesc = message.trim();
      }

      if (!timeDesc || timeDesc.length < 2) {
        return {
          messages: [{ text: h(ctx, 'Please tell me when you need the energy (e.g. "tomorrow", "today").', 'बिजली कब चाहिए? (जैसे "कल", "आज")') }],
        };
      }
      const updated = { ...pending, timeDesc, awaitingField: undefined as any };
      const next = await askNextPurchaseDetail(ctx, updated);
      if (next) return next;
      return discoverAndShowOffer(ctx, updated);
    }

    case 'confirm': {
      if (message.startsWith('purchase_confirm:')) {
        const answer = message.replace('purchase_confirm:', '');
        if (answer === 'no') {
          return {
            messages: [{ text: h(ctx, 'Purchase cancelled.', 'खरीदारी रद्द हो गई।') }],
            contextUpdate: { pendingPurchase: undefined },
          };
        }
      }

      const isYes = ['yes', 'y', 'haan', 'ha', 'ok', 'sure', 'buy', 'kharid', 'purchase_confirm:yes'].includes(lower)
        || message === 'purchase_confirm:yes';
      const isNo = ['no', 'n', 'nahi', 'nope', 'cancel', 'purchase_confirm:no'].includes(lower)
        || message === 'purchase_confirm:no';

      if (isNo) {
        return {
          messages: [{ text: h(ctx, 'Purchase cancelled.', 'खरीदारी रद्द हो गई।') }],
          contextUpdate: { pendingPurchase: undefined },
        };
      }

      if (isYes) {
        return await executeAndReportPurchase(ctx, pending);
      }

      // Re-prompt
      return {
        messages: [{
          text: h(ctx, 'Shall I proceed with the purchase?', 'Purchase karein?'),
          buttons: [
            { text: h(ctx, '✅ Yes', '✅ Haan'), callbackData: 'purchase_confirm:yes' },
            { text: h(ctx, '❌ No', '❌ Nahi'), callbackData: 'purchase_confirm:no' },
          ],
        }],
      };
    }

    case 'confirm_offer': {
      if (message.startsWith('purchase_offer_confirm:')) {
        const answer = message.replace('purchase_offer_confirm:', '');
        if (answer === 'no') {
          return {
            messages: [{ text: h(ctx, 'Purchase cancelled.', 'खरीदारी रद्द हो गई।') }],
            contextUpdate: { pendingPurchase: undefined },
          };
        }
      }

      const isYes = ['yes', 'y', 'haan', 'ha', 'ok', 'sure', 'buy', 'kharid', 'purchase_offer_confirm:yes'].includes(lower)
        || message === 'purchase_offer_confirm:yes';
      const isNo = ['no', 'n', 'nahi', 'nope', 'cancel', 'purchase_offer_confirm:no'].includes(lower)
        || message === 'purchase_offer_confirm:no';

      if (isNo) {
        return {
          messages: [{ text: h(ctx, 'Purchase cancelled.', 'खरीदारी रद्द हो गई।') }],
          contextUpdate: { pendingPurchase: undefined },
        };
      }

      if (isYes) {
        // Need userId, transactionId, quantity, and at least one offer
        const hasOffer = pending.discoveredOffer || (pending.discoveredOffers && pending.discoveredOffers.length > 0);
        if (!ctx.userId || !pending.transactionId || !hasOffer || !pending.quantity) {
          return {
            messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
            contextUpdate: { pendingPurchase: undefined },
          };
        }

        const confirmMsg: AgentMessage = {
          text: h(ctx,
            'Completing your purchase...',
            'आपकी खरीदारी पूरी कर रहा हूं...'
          ),
        };

        // Build the offer metadata for completePurchase (uses first offer for legacy fields)
        const primaryOffer = pending.discoveredOffer || (pending.discoveredOffers ? {
          offerId: pending.discoveredOffers[0].offerId,
          providerId: pending.discoveredOffers[0].providerId,
          providerName: pending.discoveredOffers[0].providerName,
          price: pending.discoveredOffers[0].price,
          quantity: pending.discoveredOffers[0].quantity,
          timeWindow: pending.discoveredOffers[0].timeWindow,
        } : undefined);

        const result = await completePurchase(
          ctx.userId,
          pending.transactionId,
          primaryOffer,
          pending.quantity
        );

        if (result.success) {
          // Multi-offer success display
          if (pending.selectionType === 'multiple' && pending.summary && pending.discoveredOffers) {
            const s = pending.summary;
            const offerList = pending.discoveredOffers.map((o, i) =>
              `${i + 1}. ${o.providerName}: ${o.quantity} units × Rs ${o.price}/unit`
            ).join('\n');
            const bulkInfo = result.bulkResult
              ? `\n• ${result.bulkResult.confirmedCount} order(s) confirmed`
              : '';

            // Build order confirmation card
            const orderConfirmationCard = {
              success: true,
              orderId: result.order?.orderId,
              offers: pending.discoveredOffers.map(o => ({
                providerName: o.providerName,
                quantity: o.quantity,
                pricePerKwh: o.price,
                subtotal: o.subtotal,
              })),
              summary: {
                totalQuantity: s.totalQuantity,
                totalPrice: s.totalPrice,
                averagePrice: s.averagePrice,
                ordersConfirmed: result.bulkResult?.confirmedCount || pending.discoveredOffers.length,
              },
              timeWindow: pending.discoveredOffers[0].timeWindow,
            };

            return {
              messages: [
                confirmMsg,
                {
                  text: h(ctx,
                    `Purchase successful!\n\n${offerList}\n\n• Total: ${s.totalQuantity} units at avg Rs ${s.averagePrice.toFixed(2)}/unit\n• Amount: Rs ${s.totalPrice.toFixed(2)}${bulkInfo}\n• Time: ${pending.discoveredOffers[0].timeWindow}\n\nYour energy will come through the grid. Your payment is safe with the platform - seller will get it after delivery is confirmed.`,
                    `खरीदारी हो गई!\n\n${offerList}\n\n• कुल: ${s.totalQuantity} यूनिट औसत ₹${s.averagePrice.toFixed(2)}/यूनिट\n• रकम: ₹${s.totalPrice.toFixed(2)}${bulkInfo}\n• समय: ${pending.discoveredOffers[0].timeWindow}\n\nआपकी बिजली ग्रिड से आएगी। आपका पैसा प्लेटफॉर्म पे सुरक्षित है - डिलीवरी के बाद सेलर को मिलेगा।`
                  ),
                  orderConfirmation: orderConfirmationCard,
                },
              ],
              contextUpdate: { pendingPurchase: undefined },
            };
          }

          // Single offer success display
          if (result.order) {
            const o = result.order;

            // Build order confirmation card
            const orderConfirmationCard = {
              success: true,
              orderId: o.orderId,
              offers: [{
                providerName: o.providerName,
                quantity: o.quantity,
                pricePerKwh: o.pricePerKwh,
                subtotal: o.totalPrice,
              }],
              summary: {
                totalQuantity: o.quantity,
                totalPrice: o.totalPrice,
                averagePrice: o.pricePerKwh,
                ordersConfirmed: 1,
              },
              timeWindow: o.timeWindow,
            };

            return {
              messages: [
                confirmMsg,
                {
                  text: h(ctx,
                    `Purchase successful!\n• ${o.quantity} units from ${o.providerName}\n• Rs ${o.pricePerKwh}/unit (Total: Rs ${o.totalPrice.toFixed(2)})\n• Time: ${o.timeWindow}\n\nYour energy will come through the grid. Your payment is safe with the platform - seller will get it after delivery is confirmed.`,
                    `खरीदारी हो गई!\n• ${o.quantity} यूनिट ${o.providerName} से\n• ₹${o.pricePerKwh}/यूनिट (कुल: ₹${o.totalPrice.toFixed(2)})\n• समय: ${o.timeWindow}\n\nआपकी बिजली ग्रिड से आएगी। आपका पैसा प्लेटफॉर्म पे सुरक्षित है - डिलीवरी के बाद सेलर को मिलेगा।`
                  ),
                  orderConfirmation: orderConfirmationCard,
                },
              ],
              contextUpdate: { pendingPurchase: undefined },
            };
          }
        }

        return {
          messages: [
            confirmMsg,
            {
              text: h(ctx,
                `Could not complete purchase: ${result.error || 'Unknown error'}. Please try again.`,
                `खरीदारी नहीं हो पाई: ${localizeError(ctx, result.error)}। दोबारा कोशिश करो।`
              )
            },
          ],
          contextUpdate: { pendingPurchase: undefined },
        };
      }

      // Re-prompt
      const isMulti = pending.selectionType === 'multiple';
      return {
        messages: [{
          text: h(ctx,
            isMulti ? 'Do you want to buy all these offers?' : 'Do you want to buy this offer?',
            isMulti ? 'Ye saari offers khareedni hain?' : 'Ye offer khareedna hai?'
          ),
          buttons: [
            { text: h(ctx, '✅ Yes', '✅ Haan'), callbackData: 'purchase_offer_confirm:yes' },
            { text: h(ctx, '❌ No', '❌ Nahi'), callbackData: 'purchase_offer_confirm:no' },
          ],
        }],
      };
    }
  }

  return null;
}

/**
 * Handle auto-buy setup step-by-step flow
 */
async function handlePendingAutoBuyInput(ctx: SessionContext, message: string): Promise<AgentResponse | null> {
  const pending = ctx.pendingAutoBuy;
  if (!pending?.awaitingField) return null;

  console.log(`[AutoBuy] Processing: field=${pending.awaitingField}, message="${message}", pending=${JSON.stringify(pending)}`);

  switch (pending.awaitingField) {
    case 'quantity': {
      // Parse quantity from button callback or text
      let qty: number | undefined;
      if (message.startsWith('autobuy_qty:')) {
        qty = parseFloat(message.replace('autobuy_qty:', ''));
      } else {
        qty = parseFloat(message.replace(/[^\d.]/g, ''));
      }

      if (!qty || qty <= 0) {
        // Re-show quantity options with slider
        return {
          messages: [{
            text: h(ctx, 'Please select or enter a valid quantity:', 'सही मात्रा चुनो या लिखो:'),
            slider: {
              type: 'quantity',
              min: 5,
              max: 200,
              step: 5,
              defaultValue: 20,
              unit: 'units',
              callbackPrefix: 'autobuy_qty',
            },
          }],
        };
      }

      // Move to max price step with slider - show DISCOM comparison
      const discomRate = 7.5; // DISCOM peak rate
      const recommendedMax = 6; // Recommended max price
      const savingsAtRecommended = Math.round(((discomRate - recommendedMax) / discomRate) * 100);

      return {
        messages: [{
          text: h(ctx,
            `📝 *${qty} units daily.*\n\n` +
            `💡 *Pricing Guide.*\n` +
            `• DISCOM rate is ₹${discomRate}/unit.\n` +
            `• Market range is ₹4-6/unit.\n` +
            `• Recommended max is ₹${recommendedMax}/unit, that's ~${savingsAtRecommended}% savings.\n\n` +
            `What's the maximum price per unit you're willing to pay?`,
            `📝 *${qty} यूनिट रोज़।*\n\n` +
            `💡 *प्राइसिंग गाइड।*\n` +
            `• DISCOM दर ₹${discomRate}/यूनिट है।\n` +
            `• मार्केट रेंज ₹4-6/यूनिट है।\n` +
            `• सुझाव ₹${recommendedMax}/यूनिट, यानी ~${savingsAtRecommended}% बचत।\n\n` +
            `प्रति यूनिट अधिकतम कितना दाम दोगे?`
          ),
          slider: {
            type: 'price',
            min: 4,
            max: 8,
            step: 0.5,
            defaultValue: recommendedMax,
            unit: '₹/unit',
            callbackPrefix: 'autobuy_price',
          },
        }],
        contextUpdate: {
          pendingAutoBuy: { ...pending, quantity: qty, awaitingField: 'max_price' },
        },
      };
    }

    case 'max_price': {
      // Parse price from button callback or text
      let price: number | undefined;
      if (message.startsWith('autobuy_price:')) {
        price = parseFloat(message.replace('autobuy_price:', ''));
      } else {
        price = parseFloat(message.replace(/[^\d.]/g, ''));
      }

      console.log(`[AutoBuy] max_price: parsed price=${price} from "${message}"`);

      if (!price || price <= 0 || isNaN(price)) {
        const discomRate = 7.5;
        const recommendedMax = 6;
        const savingsAtRecommended = Math.round(((discomRate - recommendedMax) / discomRate) * 100);
        return {
          messages: [{
            text: h(ctx,
              `Please enter a valid price.\n\n` +
              `💡 DISCOM rate: ₹${discomRate}/unit\n` +
              `Recommended: ₹${recommendedMax}/unit (~${savingsAtRecommended}% savings)`,
              `सही दाम डालो।\n\n` +
              `💡 DISCOM दर: ₹${discomRate}/यूनिट\n` +
              `सुझाव: ₹${recommendedMax}/यूनिट (~${savingsAtRecommended}% बचत)`
            ),
            slider: {
              type: 'price',
              min: 4,
              max: 8,
              step: 0.5,
              defaultValue: recommendedMax,
              unit: '₹/unit',
              callbackPrefix: 'autobuy_price',
            },
          }],
        };
      }

      // Move to time preference step
      const qty = pending.quantity!;
      return {
        messages: [{
          text: h(ctx,
            `📝 *${qty} units at ≤₹${price}/unit*\n\n⏰ When do you prefer to receive energy?`,
            `📝 *${qty} यूनिट ≤₹${price}/यूनिट*\n\n⏰ बिजली कब चाहिए?`
          ),
          buttons: [
            { text: h(ctx, '🌅 Morning (6AM-12PM)', '🌅 सुबह (6-12)'), callbackData: 'autobuy_time:morning' },
            { text: h(ctx, '☀️ Afternoon (12PM-6PM)', '☀️ दोपहर (12-6)'), callbackData: 'autobuy_time:afternoon' },
            { text: h(ctx, '🤖 Auto (Best price)', '🤖 ऑटो (सबसे सस्ता)'), callbackData: 'autobuy_time:auto' },
          ],
        }],
        contextUpdate: {
          pendingAutoBuy: { ...pending, maxPrice: price, awaitingField: 'time_preference' },
        },
      };
    }

    case 'time_preference': {
      // Parse time preference
      let timePreference: 'morning' | 'afternoon' | 'auto' = 'auto';
      if (message.startsWith('autobuy_time:')) {
        const timePart = message.replace('autobuy_time:', '');
        if (timePart === 'morning' || timePart === 'afternoon' || timePart === 'auto') {
          timePreference = timePart;
        }
      } else if (/morning|subah|सुबह/i.test(message)) {
        timePreference = 'morning';
      } else if (/afternoon|dopahar|दोपहर/i.test(message)) {
        timePreference = 'afternoon';
      }

      // Complete auto-buy setup
      const qty = pending.quantity!;
      const price = pending.maxPrice!;
      const { setupBuyerAutoTrade, runSingleBuyerAutoTrade, getBuyAdvice } = await import('../auto-trade');
      const setupResult = await setupBuyerAutoTrade(ctx.userId!, qty, price, { preferredTime: timePreference });

      if (setupResult.success) {
        const buyResult = await runSingleBuyerAutoTrade(ctx.userId!);
        const advice = await getBuyAdvice(ctx.userId!, ctx.language === 'hi-IN');

        const timeLabel = h(ctx,
          timePreference === 'morning' ? 'morning' : timePreference === 'afternoon' ? 'afternoon' : 'best price time',
          timePreference === 'morning' ? 'सुबह' : timePreference === 'afternoon' ? 'दोपहर' : 'सबसे सस्ते समय'
        );

        if (buyResult && buyResult.status === 'success') {
          return {
            messages: [{
              text: h(ctx,
                `✅ Auto-buy activated!\n\n🛒 Found a deal right now! Bought *${buyResult.quantityBought} units* at ₹${buyResult.pricePerUnit}/unit.\nTotal: ₹${buyResult.totalSpent.toFixed(0)}\n\nEvery day at 6:30 AM, I'll find the best deals and buy ${qty} units for you at ≤₹${price}/unit (${timeLabel}).\n\n${advice.advice}`,
                `✅ ऑटो-बाय चालू!\n\n🛒 अभी एक डील मिल गई! *${buyResult.quantityBought} यूनिट* ₹${buyResult.pricePerUnit}/यूनिट पर खरीद लिया।\nकुल: ₹${buyResult.totalSpent.toFixed(0)}\n\nरोज़ सुबह 6:30 बजे, मैं ${qty} यूनिट ≤₹${price}/यूनिट पर खरीदूंगा (${timeLabel})।\n\n${advice.advice}`
              ),
              buttons: [
                { text: h(ctx, '📋 View Orders', '📋 ऑर्डर देखो'), callbackData: 'action:show_orders' },
                { text: h(ctx, '📊 Status', '📊 स्टेटस'), callbackData: 'action:check_auto_trade' },
                { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
              ],
            }],
            contextUpdate: { pendingAutoBuy: undefined },
          };
        }

        // Enabled but no immediate deal
        return {
          messages: [{
            text: h(ctx,
              `✅ Auto-buy enabled!\n\nEvery day at 6:30 AM, I'll find the best deals and buy ${qty} units for you at ≤₹${price}/unit (${timeLabel}).\n\n${advice.advice}`,
              `✅ ऑटो-बाय चालू!\n\nरोज़ सुबह 6:30 बजे, मैं ${qty} यूनिट ≤₹${price}/यूनिट पर खरीदूंगा (${timeLabel})।\n\n${advice.advice}`
            ),
            buttons: [
              { text: h(ctx, '📊 Status', '📊 स्टेटस'), callbackData: 'action:check_auto_trade' },
              { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
            ],
          }],
          contextUpdate: { pendingAutoBuy: undefined },
        };
      }

      return {
        messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
        contextUpdate: { pendingAutoBuy: undefined },
      };
    }

    default: {
      // Unknown awaiting field - log and reset
      console.warn(`[AutoBuy] Unknown awaitingField: ${pending.awaitingField}`);
      return {
        messages: [{
          text: h(ctx, 'Something went wrong with auto-buy setup. Let me start again.', 'ऑटो-बाय सेटअप में कुछ गड़बड़ हो गई। चलो फिर से शुरू करते हैं।'),
          buttons: [
            { text: h(ctx, '🤖 Setup Auto-Buy', '🤖 ऑटो-बाय सेटअप'), callbackData: 'action:setup_auto_buy' },
          ],
        }],
        contextUpdate: { pendingAutoBuy: undefined },
      };
    }
  }
}

/**
 * Execute the purchase and return result to user.
 */
async function executeAndReportPurchase(ctx: SessionContext, pending: PendingPurchase): Promise<AgentResponse> {
  if (!ctx.userId || !pending.quantity) {
    return {
      messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
      contextUpdate: { pendingPurchase: undefined },
    };
  }

  // Show "searching" message
  const searchMsg = h(ctx,
    'Searching for the best offer and processing your purchase...',
    'सबसे अच्छा ऑफ़र ढूंढ रहा हूं और खरीदारी पूरी कर रहा हूं...'
  );

  const result = await executePurchase(ctx.userId, {
    quantity: pending.quantity,
    timeDesc: pending.timeDesc,
  });

  if (result.success && result.order) {
    const o = result.order;
    return {
      messages: [
        { text: searchMsg },
        {
          text: h(ctx,
            `Purchase successful!\n• ${o.quantity} units from ${o.providerName}\n• Rs ${o.pricePerKwh}/unit (Total: Rs ${o.totalPrice.toFixed(2)})\n• Time: ${o.timeWindow}\n\nYour energy will come through the grid. Your payment is safe with the platform - seller will get it after delivery is confirmed.`,
            `खरीदारी हो गई!\n• ${o.quantity} यूनिट ${o.providerName} से\n• ₹${o.pricePerKwh}/यूनिट (कुल: ₹${o.totalPrice.toFixed(2)})\n• समय: ${o.timeWindow}\n\nआपकी बिजली ग्रिड से आएगी। आपका पैसा प्लेटफॉर्म पे सुरक्षित है - डिलीवरी के बाद सेलर को मिलेगा।`
          ),
        },
      ],
      contextUpdate: { pendingPurchase: undefined },
    };
  }

  return {
    messages: [
      { text: searchMsg },
      { text: h(ctx, `Could not complete purchase: ${result.error || 'Unknown error'}. Please try again.`, `खरीदारी नहीं हो पाई: ${localizeError(ctx, result.error)}। दोबारा कोशिश करो।`) },
    ],
    contextUpdate: { pendingPurchase: undefined },
  };
}

// --- State Handlers ---

const LANG_BUTTONS = [
  { text: 'English', callbackData: 'lang:en-IN' },
  { text: 'हिंदी', callbackData: 'lang:hi-IN' },
  { text: 'বাংলা', callbackData: 'lang:bn-IN' },
  { text: 'தமிழ்', callbackData: 'lang:ta-IN' },
  { text: 'తెలుగు', callbackData: 'lang:te-IN' },
  { text: 'ಕನ್ನಡ', callbackData: 'lang:kn-IN' },
];

// Welcome messages translated for each supported language
const WELCOME_MESSAGES: Record<string, { greeting: string; voiceNote: string }> = {
  'en-IN': {
    greeting: 'Namaste! I am Oorja.\nI will help you earn money from the electricity you generate at home. And for those who want to buy electricity, I will help them get it at the right price.\n\nIf you have any questions at any time, just ask me!',
    voiceNote: '\n\n🔊 If you want to hear my messages, press the speaker button.',
  },
  'hi-IN': {
    greeting: 'नमस्ते! मैं ऊर्जा हूँ।\nमैं आपको अपने घर पे बनाई बिजली से पैसे कमाने में मदद करूँगा। और जिन्हें बिजली खरीदनी है, उन्हें सही दाम पे दिलाऊँगा।\n\nअगर आपको किसी भी समय कोई भी सवाल हो, तो मुझे पूछ लेना!',
    voiceNote: '\n\n🔊 अगर मेरी मैसेज सुनना चाहते हो, स्पीकर बटन दबाओ।',
  },
  'bn-IN': {
    greeting: 'নমস্কার! আমি ঊর্জা।\nআমি আপনাকে বাড়িতে তৈরি বিদ্যুৎ থেকে টাকা উপার্জন করতে সাহায্য করব। আর যাদের বিদ্যুৎ কিনতে হবে, তাদের সঠিক দামে পেতে সাহায্য করব।\n\nযেকোনো সময় কোনো প্রশ্ন থাকলে আমাকে জিজ্ঞাসা করুন!',
    voiceNote: '\n\n🔊 আমার মেসেজ শুনতে চাইলে স্পিকার বাটন টিপুন।',
  },
  'ta-IN': {
    greeting: 'வணக்கம்! நான் ஊர்ஜா.\nவீட்டில் உருவாக்கும் மின்சாரத்தில் இருந்து பணம் சம்பாதிக்க நான் உங்களுக்கு உதவுவேன். மின்சாரம் வாங்க விரும்புவோருக்கு சரியான விலையில் வாங்க உதவுவேன்.\n\nஎந்த நேரத்திலும் ஏதேனும் கேள்வி இருந்தால், என்னிடம் கேளுங்கள்!',
    voiceNote: '\n\n🔊 என் செய்திகளைக் கேட்க விரும்பினால், ஸ்பீக்கர் பட்டனை அழுத்தவும்.',
  },
  'te-IN': {
    greeting: 'నమస్కారం! నేను ఊర్జా.\nమీరు ఇంట్లో తయారు చేసిన విద్యుత్ నుండి డబ్బు సంపాదించడానికి నేను మీకు సహాయం చేస్తాను. విద్యుత్ కొనాలనుకునే వారికి సరైన ధరలో అందించడానికి సహాయం చేస్తాను.\n\nఎప్పుడైనా ఏదైనా ప్రశ్న ఉంటే, నన్ను అడగండి!',
    voiceNote: '\n\n🔊 నా సందేశాలు వినాలనుకుంటే, స్పీకర్ బటన్ నొక్కండి.',
  },
  'kn-IN': {
    greeting: 'ನಮಸ್ಕಾರ! ನಾನು ಊರ್ಜಾ.\nಮನೆಯಲ್ಲಿ ಉತ್ಪಾದಿಸಿದ ವಿದ್ಯುತ್‌ನಿಂದ ಹಣ ಗಳಿಸಲು ನಾನು ನಿಮಗೆ ಸಹಾಯ ಮಾಡುತ್ತೇನೆ. ವಿದ್ಯುತ್ ಖರೀದಿಸಲು ಬಯಸುವವರಿಗೆ ಸರಿಯಾದ ಬೆಲೆಗೆ ಪಡೆಯಲು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ.\n\nಯಾವುದೇ ಸಮಯದಲ್ಲಿ ಪ್ರಶ್ನೆ ಇದ್ದರೆ, ನನ್ನನ್ನು ಕೇಳಿ!',
    voiceNote: '\n\n🔊 ನನ್ನ ಸಂದೇಶಗಳನ್ನು ಕೇಳಲು ಬಯಸಿದರೆ, ಸ್ಪೀಕರ್ ಬಟನ್ ಒತ್ತಿ.',
  },
};

// DISCOM list with base (English) names - used for callback matching
const DISCOM_LIST = [
  { text: 'BSES Rajdhani', callbackData: 'discom:bses_rajdhani' },
  { text: 'BSES Yamuna', callbackData: 'discom:bses_yamuna' },
  { text: 'Tata Power Delhi', callbackData: 'discom:tata_power_delhi' },
  { text: 'BESCOM (Bangalore)', callbackData: 'discom:bescom' },
  { text: 'MSEDCL (Maharashtra)', callbackData: 'discom:msedcl' },
  { text: 'UPPCL (UP)', callbackData: 'discom:uppcl' },
  { text: 'TANGEDCO (TN)', callbackData: 'discom:tangedco' },
  { text: 'WBSEDCL (WB)', callbackData: 'discom:wbsedcl' },
  { text: 'Other', callbackData: 'discom:other' },
];

// Localized DISCOM names for display
const DISCOM_TRANSLATIONS: Record<string, Record<string, string>> = {
  'hi-IN': {
    'BSES Rajdhani': 'बीएसईएस राजधानी',
    'BSES Yamuna': 'बीएसईएस यमुना',
    'Tata Power Delhi': 'टाटा पावर दिल्ली',
    'BESCOM (Bangalore)': 'बेस्कॉम (बैंगलोर)',
    'MSEDCL (Maharashtra)': 'एमएसईडीसीएल (महाराष्ट्र)',
    'UPPCL (UP)': 'यूपीपीसीएल (उत्तर प्रदेश)',
    'TANGEDCO (TN)': 'टैंगेडको (तमिलनाडु)',
    'WBSEDCL (WB)': 'डब्ल्यूबीएसईडीसीएल (पश्चिम बंगाल)',
    'Other': 'अन्य',
  },
  'bn-IN': {
    'BSES Rajdhani': 'বিএসইএস রাজধানী',
    'BSES Yamuna': 'বিএসইএস যমুনা',
    'Tata Power Delhi': 'টাটা পাওয়ার দিল্লি',
    'BESCOM (Bangalore)': 'বেসকম (ব্যাঙ্গালোর)',
    'MSEDCL (Maharashtra)': 'এমএসইডিসিএল (মহারাষ্ট্র)',
    'UPPCL (UP)': 'ইউপিপিসিএল (উত্তর প্রদেশ)',
    'TANGEDCO (TN)': 'ট্যাঙ্গেডকো (তামিলনাড়ু)',
    'WBSEDCL (WB)': 'ডব্লিউবিএসইডিসিএল (পশ্চিমবঙ্গ)',
    'Other': 'অন্যান্য',
  },
  'ta-IN': {
    'BSES Rajdhani': 'பிஎஸ்இஎஸ் ராஜ்தானி',
    'BSES Yamuna': 'பிஎஸ்இஎஸ் யமுனா',
    'Tata Power Delhi': 'டாடா பவர் டெல்லி',
    'BESCOM (Bangalore)': 'பெஸ்காம் (பெங்களூர்)',
    'MSEDCL (Maharashtra)': 'எம்எஸ்இடிசிஎல் (மகாராஷ்டிரா)',
    'UPPCL (UP)': 'யுபிபிசிஎல் (உத்தரப்பிரதேசம்)',
    'TANGEDCO (TN)': 'டேன்ஜெட்கோ (தமிழ்நாடு)',
    'WBSEDCL (WB)': 'டபிள்யூபிஎஸ்இடிசிஎல் (மேற்கு வங்காளம்)',
    'Other': 'மற்றவை',
  },
  'te-IN': {
    'BSES Rajdhani': 'బిఎస్‌ఇఎస్ రాజధాని',
    'BSES Yamuna': 'బిఎస్‌ఇఎస్ యమునా',
    'Tata Power Delhi': 'టాటా పవర్ ఢిల్లీ',
    'BESCOM (Bangalore)': 'బెస్కామ్ (బెంగళూరు)',
    'MSEDCL (Maharashtra)': 'ఎంఎస్‌ఇడిసిఎల్ (మహారాష్ట్ర)',
    'UPPCL (UP)': 'యుపిపిసిఎల్ (ఉత్తర ప్రదేశ్)',
    'TANGEDCO (TN)': 'టాన్‌గెడ్కో (తమిళనాడు)',
    'WBSEDCL (WB)': 'డబ్ల్యుబిఎస్‌ఇడిసిఎల్ (పశ్చిమ బెంగాల్)',
    'Other': 'ఇతర',
  },
  'kn-IN': {
    'BSES Rajdhani': 'ಬಿಎಸ್‌ಇಎಸ್ ರಾಜಧಾನಿ',
    'BSES Yamuna': 'ಬಿಎಸ್‌ಇಎಸ್ ಯಮುನಾ',
    'Tata Power Delhi': 'ಟಾಟಾ ಪವರ್ ದೆಹಲಿ',
    'BESCOM (Bangalore)': 'ಬೆಸ್ಕಾಮ್ (ಬೆಂಗಳೂರು)',
    'MSEDCL (Maharashtra)': 'ಎಂಎಸ್‌ಇಡಿಸಿಎಲ್ (ಮಹಾರಾಷ್ಟ್ರ)',
    'UPPCL (UP)': 'ಯುಪಿಪಿಸಿಎಲ್ (ಉತ್ತರ ಪ್ರದೇಶ)',
    'TANGEDCO (TN)': 'ಟ್ಯಾಂಗೆಡ್ಕೊ (ತಮಿಳುನಾಡು)',
    'WBSEDCL (WB)': 'ಡಬ್ಲ್ಯುಬಿಎಸ್‌ಇಡಿಸಿಎಲ್ (ಪಶ್ಚಿಮ ಬಂಗಾಳ)',
    'Other': 'ಇತರೆ',
  },
};

// Get localized DISCOM list based on language
function getLocalizedDiscomList(language?: string): Array<{ text: string; callbackData: string }> {
  const translations = language ? DISCOM_TRANSLATIONS[language] : undefined;
  if (!translations) return DISCOM_LIST;

  return DISCOM_LIST.map(item => ({
    text: translations[item.text] || item.text,
    callbackData: item.callbackData,
  }));
}

const DISCOM_CRED_LINKS: Record<string, string> = {
  bses_rajdhani: 'https://creds.bsesdelhi.com/rajdhani',
  bses_yamuna: 'https://creds.bsesdelhi.com/yamuna',
  tata_power_delhi: 'https://creds.tatapower.com/delhi',
  bescom: 'https://creds.bescom.karnataka.gov.in',
  msedcl: 'https://creds.mahadiscom.in/credentials',
  uppcl: 'https://creds.uppcl.org',
  tangedco: 'https://creds.tangedco.tn.gov.in',
  wbsedcl: 'https://creds.wbsedcl.in',
  other: 'https://open-vcs.up.railway.app',
};

const CRED_FARMER_NAMES: Record<string, { en: string; hi: string }> = {
  GenerationProfileCredential: { en: 'solar generation ID', hi: 'सोलर जनरेशन आईडी' },
  ConsumptionProfileCredential: { en: 'electricity consumption ID', hi: 'बिजली खपत आईडी' },
  StorageProfileCredential: { en: 'battery storage ID', hi: 'बैटरी स्टोरेज आईडी' },
  UtilityProgramEnrollmentCredential: { en: 'program enrollment ID', hi: 'प्रोग्राम एनरोलमेंट आईडी' },
};

// --- Onboarding state set (for status/suggestion checks) ---

const ONBOARDING_STATES = new Set([
  'GREETING', 'WAITING_NAME', 'WAITING_PHONE', 'WAITING_OTP',
  'ASK_DISCOM', 'WAITING_UTILITY_CRED', 'ASK_INTENT',
]);

// Progress indicator disabled — clean conversational flow
function getProgressIndicator(_state: string, _ctx: SessionContext): string {
  return '';
}

// --- Universal Commands ---

const UNIVERSAL_COMMANDS: Record<string, string[]> = {
  help: ['help', 'madad', 'sahayata', 'menu', '?'],
  back: ['back', 'peeche', 'previous', 'wapas'],
  cancel: ['cancel', 'band', 'ruko', 'stop', 'abort'],
  status: ['status', 'sthiti', 'where', 'kahan'],
  language: ['language', 'bhasha', 'lang', 'change language', 'switch language', 'bhasha badlo', 'bhasha change', 'change lang', 'set language'],
  reset: ['reset', 'restart', 'start over', 'shuru', 'naya'],
  tips: ['tips', 'tip', 'sujhav', 'advice'],
  about: ['about', 'what is oorja', 'oorja kya hai', 'info'],
  support: ['support', 'contact', 'sampark', 'help contact'],
  voiceOn: ['voice on', 'voice enable', 'bolo', 'sunao', 'voice chalu'],
  voiceOff: ['voice off', 'voice disable', 'mat bolo', 'voice band'],
};

// Help menu number shortcuts - maps numbers to actions
const HELP_SHORTCUTS: Record<string, string> = {
  '1': 'action:create_listing',
  '2': 'action:buy_energy',
  '3': 'action:market_insights',
  '4': 'action:dashboard',
  '5': 'action:show_earnings',
  '6': 'action:show_orders',
  '7': 'action:show_balance',
};

// Map states to their previous state (for 'back' command)
const STATE_BACK_MAP: Record<string, string> = {
  WAITING_NAME: 'GREETING',
  WAITING_PHONE: 'WAITING_NAME',
  WAITING_OTP: 'WAITING_PHONE',
  ASK_DISCOM: 'WAITING_OTP',
  WAITING_UTILITY_CRED: 'ASK_DISCOM',
  ASK_INTENT: 'WAITING_UTILITY_CRED',
  OFFER_OPTIONAL_CREDS: 'ASK_INTENT',
  WAITING_OPTIONAL_CRED: 'OFFER_OPTIONAL_CREDS',
  CONFIRM_TRADING: 'ASK_INTENT',
};

/**
 * Handle universal commands that work in any state.
 * Returns null if not a universal command.
 */
async function handleUniversalCommand(
  command: string,
  ctx: SessionContext,
  currentState: string,
  sessionId: string
): Promise<AgentResponse | null> {
  const normalized = command.toLowerCase().trim();

  // Check for help command
  if (UNIVERSAL_COMMANDS.help.includes(normalized)) {
    const helpText = h(ctx,
      `📋 *Oorja Help Menu*\n\n` +
      `☀️ *Trading Commands.*\n` +
      `1. Say "sell" to sell your solar energy.\n` +
      `2. Say "buy" to buy green energy.\n` +
      `3. Say "market" to see current prices.\n` +
      `4. Say "dashboard" for your complete status.\n\n` +
      `💰 *Account Commands.*\n` +
      `5. Say "earnings" to view your earnings.\n` +
      `6. Say "orders" to track your orders.\n` +
      `7. Say "balance" to check wallet balance.\n\n` +
      `🛠️ *Navigation.*\n` +
      `• Say "help" for this menu.\n` +
      `• Say "back" for previous step.\n` +
      `• Say "cancel" to stop current action.\n` +
      `• Say "language" to change language.\n` +
      `• Say "reset" to start over.\n\n` +
      `💡 *Examples:* "sell 50 units at Rs 6" or "buy 30 units."\n\n` +
      `_Type a number 1 to 7, or a command!_`,

      `📋 *ऊर्जा मदद मेनू*\n\n` +
      `☀️ *ट्रेडिंग कमांड।*\n` +
      `1. "बेचो" बोलो, सोलर एनर्जी बेचने के लिए।\n` +
      `2. "खरीदो" बोलो, हरी बिजली खरीदने के लिए।\n` +
      `3. "बाज़ार" बोलो, मौजूदा दाम देखने के लिए।\n` +
      `4. "डैशबोर्ड" बोलो, पूरा स्टेटस देखने के लिए।\n\n` +
      `💰 *खाता कमांड।*\n` +
      `5. "कमाई" बोलो, अपनी कमाई देखने के लिए।\n` +
      `6. "ऑर्डर" बोलो, ऑर्डर ट्रैक करने के लिए।\n` +
      `7. "बैलेंस" बोलो, वॉलेट बैलेंस देखने के लिए।\n\n` +
      `🛠️ *नेविगेशन।*\n` +
      `• "मदद" बोलो, यह मेनू देखने के लिए।\n` +
      `• "पीछे" बोलो, पिछले स्टेप के लिए।\n` +
      `• "बंद" बोलो, मौजूदा एक्शन रोकने के लिए।\n` +
      `• "भाषा" बोलो, भाषा बदलने के लिए।\n` +
      `• "रीसेट" बोलो, नया शुरू करने के लिए।\n\n` +
      `💡 *उदाहरण:* "50 यूनिट ₹6 में बेचो" या "30 यूनिट खरीदो।"\n\n` +
      `_नंबर 1 से 7, या कमांड बोलो!_`
    );
    return {
      messages: [{
        text: helpText,
        buttons: [
          { text: '☀️ 1. Sell Energy', callbackData: 'action:create_listing' },
          { text: '⚡ 2. Buy Energy', callbackData: 'action:buy_energy' },
          { text: '📊 3. Market Prices', callbackData: 'action:market_insights' },
          { text: '📋 4. Dashboard', callbackData: 'action:dashboard' },
        ],
      }]
    };
  }

  // Check for help number shortcuts (1-7)
  if (HELP_SHORTCUTS[normalized]) {
    return { messages: [{ text: '' }], contextUpdate: { _helpShortcut: HELP_SHORTCUTS[normalized] } };
  }

  // Check for status command
  if (UNIVERSAL_COMMANDS.status.includes(normalized)) {
    const isOnboarding = ONBOARDING_STATES.has(currentState);
    let statusText: string;

    if (isOnboarding) {
      const progress = getProgressIndicator(currentState, ctx);
      statusText = h(ctx,
        `📍 *Your Status*\n\n${progress}` +
        `Name: ${ctx.name || 'Not set'}\n` +
        `Phone: ${ctx.phone || 'Not set'}\n` +
        `Verified: ${ctx.userId ? 'Yes ✓' : 'No'}`,

        `📍 *आपका स्टेटस*\n\n${progress}` +
        `नाम: ${ctx.name || 'नहीं है'}\n` +
        `फोन: ${ctx.phone || 'नहीं है'}\n` +
        `वेरिफाइड: ${ctx.userId ? 'हाँ ✓' : 'नहीं'}`
      );
    } else {
      statusText = h(ctx,
        `📍 *Your Status*\n\n` +
        `State: ${currentState}\n` +
        `Name: ${ctx.name || 'Not set'}\n` +
        `Phone: ${ctx.phone || 'Not set'}\n` +
        `Verified: ${ctx.userId ? 'Yes ✓' : 'No'}\n` +
        `Trading: ${ctx.tradingActive ? 'Active ✓' : 'Not started'}`,

        `📍 *आपका स्टेटस*\n\n` +
        `स्टेट: ${currentState}\n` +
        `नाम: ${ctx.name || 'नहीं है'}\n` +
        `फोन: ${ctx.phone || 'नहीं है'}\n` +
        `वेरिफाइड: ${ctx.userId ? 'हाँ ✓' : 'नहीं'}\n` +
        `ट्रेडिंग: ${ctx.tradingActive ? 'चालू ✓' : 'शुरू नहीं'}`
      );
    }
    return { messages: [{ text: statusText }] };
  }

  // Check for back command
  if (UNIVERSAL_COMMANDS.back.includes(normalized)) {
    const previousState = STATE_BACK_MAP[currentState];

    if (!previousState) {
      return {
        messages: [{
          text: h(ctx,
            "Can't go back from here. Type 'help' for options.",
            "यहाँ से पीछे नहीं जा सकते। विकल्पों के लिए 'मदद' टाइप करो।"
          ),
        }],
      };
    }

    // Transition to previous state
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { state: previousState as any },
    });

    const enterResp = await states[previousState as ChatState].onEnter(ctx);
    const backMsg = h(ctx, '⬅️ Going back...', '⬅️ पीछे जा रहे हैं...');

    return {
      messages: [{ text: backMsg }, ...enterResp.messages],
      newState: previousState,
    };
  }

  // Check for cancel command (cancel pending operations)
  if (UNIVERSAL_COMMANDS.cancel.includes(normalized)) {
    if (ctx.pendingListing || ctx.pendingPurchase) {
      const cancelText = h(ctx,
        '❌ Operation cancelled. What would you like to do?',
        '❌ रद्द हो गया। अब क्या करना है?'
      );
      return {
        messages: [{ text: cancelText }],
        contextUpdate: { pendingListing: undefined, pendingPurchase: undefined },
      };
    }

    return {
      messages: [{
        text: h(ctx,
          "Nothing to cancel. Type 'help' for options.",
          "रद्द करने के लिए कुछ नहीं है। विकल्पों के लिए 'मदद' टाइप करो।"
        ),
      }],
    };
  }

  // Check for reset command - confirm before resetting
  if (UNIVERSAL_COMMANDS.reset.includes(normalized)) {
    // If already in confirmation mode, this is handled elsewhere
    if (ctx._resetPending) {
      return null; // Let the state handler deal with it
    }

    const confirmText = h(ctx,
      `🔄 *Reset Confirmation*\n\n` +
      `This will:\n` +
      `• Cancel any pending actions\n` +
      `• Clear current conversation\n` +
      `• Start fresh\n\n` +
      `Are you sure?`,

      `🔄 *Reset Confirmation*\n\n` +
      `Ye hoga:\n` +
      `• Pending actions cancel\n` +
      `• Current conversation clear\n` +
      `• Naya shuru\n\n` +
      `Pakka hai?`
    );

    return {
      messages: [{
        text: confirmText,
        buttons: [
          { text: '✅ Yes, reset / Haan', callbackData: 'reset:confirm' },
          { text: '❌ No, cancel / Nahi', callbackData: 'reset:cancel' },
        ],
      }],
      contextUpdate: { _resetPending: true },
    };
  }

  // Check for tips command
  if (UNIVERSAL_COMMANDS.tips.includes(normalized)) {
    const tipsText = h(ctx,
      `💡 *Trading Tips.*\n\n` +
      `☀️ *For Sellers.*\n` +
      `• Price 10-20% below DISCOM for quick sales.\n` +
      `• List during morning hours, 6 to 10 AM.\n` +
      `• Consistent delivery builds your trust score.\n` +
      `• Higher trust means higher trade limits.\n\n` +
      `⚡ *For Buyers.*\n` +
      `• Prices are lowest in the afternoon, 12 to 4 PM.\n` +
      `• Buy in bulk for better rates.\n` +
      `• Check market prices before buying.\n` +
      `• Look for trusted sellers with high ratings.\n\n` +
      `📊 *General.*\n` +
      `• Complete your profile for higher limits.\n` +
      `• Add more credentials to unlock features.`,

      `💡 *ट्रेडिंग टिप्स।*\n\n` +
      `☀️ *विक्रेताओं के लिए।*\n` +
      `• DISCOM से 10-20% कम रेट रखो।\n` +
      `• सुबह 6 से 10 बजे लिस्ट करो।\n` +
      `• समय पर डिलीवरी से ट्रस्ट बढ़ता है।\n` +
      `• ज़्यादा ट्रस्ट मतलब ज़्यादा ट्रेड लिमिट।\n\n` +
      `⚡ *खरीदारों के लिए।*\n` +
      `• दोपहर में दाम कम होते हैं, 12 से 4 बजे।\n` +
      `• बल्क में खरीदो, डिस्काउंट मिलेगा।\n` +
      `• पहले मार्केट प्राइस चेक करो।\n` +
      `• ऊंची रेटिंग वाले विश्वसनीय विक्रेता चुनो।\n\n` +
      `📊 *सामान्य।*\n` +
      `• प्रोफाइल पूरा करो, लिमिट बढ़ेगी।\n` +
      `• ज़्यादा क्रेडेंशियल मतलब ज़्यादा फीचर्स।`
    );
    return { messages: [{ text: tipsText }] };
  }

  // Check for about command
  if (UNIVERSAL_COMMANDS.about.includes(normalized)) {
    const aboutText = h(ctx,
      `🌱 *About Oorja.*\n\n` +
      `Oorja is India's first peer-to-peer energy trading platform.\n\n` +
      `*What we do.*\n` +
      `We connect solar panel owners with buyers.\n` +
      `We enable direct energy trading.\n` +
      `We help you save money compared to DISCOM rates.\n` +
      `We support rural solar adoption.\n\n` +
      `*How it works.*\n` +
      `First, sellers list surplus solar energy.\n` +
      `Then, buyers find best prices.\n` +
      `DISCOM delivers through the grid.\n` +
      `And payment is released after delivery.\n\n` +
      `🌍 Empowering India's green energy future!`,

      `🌱 *ऊर्जा के बारे में।*\n\n` +
      `ऊर्जा भारत का पहला P2P एनर्जी ट्रेडिंग प्लेटफॉर्म है।\n\n` +
      `*हम क्या करते हैं।*\n` +
      `हम सोलर पैनल मालिकों को खरीदारों से जोड़ते हैं।\n` +
      `हम डायरेक्ट एनर्जी ट्रेडिंग करवाते हैं।\n` +
      `DISCOM से कम रेट पर बिजली मिलती है।\n` +
      `गाँव में सोलर अपनाने में सहायता करते हैं।\n\n` +
      `*कैसे काम करता है।*\n` +
      `पहले, विक्रेता अतिरिक्त सोलर एनर्जी लिस्ट करते हैं।\n` +
      `फिर, खरीदार बेस्ट प्राइस ढूंढते हैं।\n` +
      `DISCOM ग्रिड से डिलीवर करता है।\n` +
      `और डिलीवरी के बाद पेमेंट रिलीज़ होता है।\n\n` +
      `🌍 भारत का हरित ऊर्जा भविष्य!`
    );
    return { messages: [{ text: aboutText }] };
  }

  // Check for support command
  if (UNIVERSAL_COMMANDS.support.includes(normalized)) {
    const supportText = h(ctx,
      `📞 *Support and Contact.*\n\n` +
      `*Need help?*\n` +
      `Type "help" for commands.\n` +
      `Type "tips" for trading advice.\n\n` +
      `*Contact us.*\n` +
      `WhatsApp: This number!\n\n` +
      `*Common issues.*\n` +
      `Say "reset" to start over.\n` +
      `Say "cancel" to stop current action.\n` +
      `Say "status" to see where you are.\n\n` +
      `We're here to help! 🙏`,

      `📞 *सहायता और संपर्क।*\n\n` +
      `*मदद चाहिए?*\n` +
      `कमांड के लिए "मदद" बोलो।\n` +
      `ट्रेडिंग सलाह के लिए "टिप्स" बोलो।\n\n` +
      `*संपर्क।*\n` +
      `व्हाट्सएप: यही नंबर!\n\n` +
      `*सामान्य समस्याएं।*\n` +
      `"रीसेट" बोलो, नया शुरू करने के लिए।\n` +
      `"बंद" बोलो, मौजूदा एक्शन रोकने के लिए।\n` +
      `"स्टेटस" बोलो, कहाँ हो देखने के लिए।\n\n` +
      `हम मदद के लिए हैं! 🙏`
    );
    return { messages: [{ text: supportText }] };
  }

  // Check for voice on command
  if (UNIVERSAL_COMMANDS.voiceOn.includes(normalized)) {
    return {
      messages: [{
        text: h(ctx,
          `🔊 *Voice Enabled!*\n\nI'll read messages aloud for you. Say "voice off" to disable.`,
          `🔊 *Voice On!*\n\nMain messages bolke sunaunga. "voice off" bolo band karne ke liye.`
        ),
      }],
      contextUpdate: { voiceOutputEnabled: true, voicePromptShown: true },
      voiceOutputEnabled: true,
    };
  }

  // Check for voice off command
  if (UNIVERSAL_COMMANDS.voiceOff.includes(normalized)) {
    return {
      messages: [{
        text: h(ctx,
          `🔇 *Voice Disabled*\n\nI won't read messages aloud. Say "voice on" to enable.`,
          `🔇 *वॉइस बंद*\n\nमैं संदेश नहीं बोलूंगा। चालू करने के लिए "voice on" बोलो।`
        ),
      }],
      contextUpdate: { voiceOutputEnabled: false, voicePromptShown: true },
      voiceOutputEnabled: false,
    };
  }

  // Handle language selection callback (from buttons shown by "language" command)
  if (command.startsWith('lang:')) {
    // During GREETING state, let the state handler deal with it (proper transition)
    if (currentState === 'GREETING') return null;

    const lang = command.replace('lang:', '');
    const LANG_CONFIRM: Record<string, string> = {
      'en-IN': 'Language set to English.',
      'hi-IN': 'भाषा हिंदी में सेट हो गई।',
      'bn-IN': 'ভাষা বাংলায় সেট হয়েছে।',
      'ta-IN': 'மொழி தமிழில் அமைக்கப்பட்டது.',
      'te-IN': 'భాష తెలుగులో సెట్ చేయబడింది.',
      'kn-IN': 'ಭಾಷೆ ಕನ್ನಡಕ್ಕೆ ಬದಲಾಗಿದೆ.',
    };
    const confirmText = LANG_CONFIRM[lang] || 'Language updated!';

    // During onboarding: set language, show confirmation, re-prompt current step
    if (ONBOARDING_STATES.has(currentState)) {
      const updatedCtx = { ...ctx, language: lang as any };
      const enterResp = await states[currentState as ChatState].onEnter(
        { ...updatedCtx, nameAsked: false } // Reset so WAITING_NAME re-shows prompt
      );
      return {
        messages: [
          { text: confirmText },
          ...enterResp.messages,
        ],
        contextUpdate: { language: lang as any, nameAsked: false },
      };
    }

    // General chat: show confirmation with context-appropriate suggestions
    return {
      messages: [{
        text: confirmText,
        buttons: getSmartSuggestions({ ...ctx, language: lang as any }, currentState),
      }],
      contextUpdate: { language: lang as any },
    };
  }

  // Check for language command
  if (UNIVERSAL_COMMANDS.language.includes(normalized)) {
    return {
      messages: [{
        text: h(ctx, 'Choose your language:', 'अपनी भाषा चुनें:'),
        buttons: LANG_BUTTONS,
      }],
    };
  }

  return null;
}

// --- Smart Suggestions Helper ---

/**
 * Generate context-aware button suggestions based on user state and history.
 */
function getSmartSuggestions(ctx: SessionContext, currentState: string): Array<{ text: string; callbackData?: string }> {
  const suggestions: Array<{ text: string; callbackData?: string }> = [];
  const verifiedCreds = ctx.verifiedCreds || [];

  // For onboarding states, show help and relevant action
  if (ONBOARDING_STATES.has(currentState)) {
    suggestions.push({ text: h(ctx, 'Help', 'मदद'), callbackData: 'cmd:help' });
    if (STATE_BACK_MAP[currentState]) {
      suggestions.push({ text: h(ctx, 'Back', 'पीछे'), callbackData: 'cmd:back' });
    }
    return suggestions;
  }

  // For GENERAL_CHAT, provide trading-related suggestions based on credentials
  if (currentState === 'GENERAL_CHAT') {
    const hasGeneration = verifiedCreds.includes('GENERATION_PROFILE');
    const hasStorage = verifiedCreds.includes('STORAGE_PROFILE');
    const hasConsumption = verifiedCreds.includes('CONSUMPTION_PROFILE');

    // Common: Show electricity info (dashboard)
    suggestions.push({
      text: h(ctx, '📊 My Electricity Info', '📊 मेरी बिजली की जानकारी'),
      callbackData: 'action:dashboard'
    });

    // Seller suggestions (has generation or storage credential)
    if (hasGeneration || hasStorage) {
      suggestions.push({
        text: h(ctx, '☀️ Sell Electricity', '☀️ बिजली बेचो'),
        callbackData: 'action:create_listing'
      });
      suggestions.push({
        text: h(ctx, '💰 My Earnings', '💰 मेरी कमाई'),
        callbackData: 'action:show_earnings'
      });
    }

    // Universal: Buy energy option (for both sellers and buyers)
    suggestions.push({
      text: h(ctx, '🔋 Buy Energy', '🔋 बिजली खरीदो'),
      callbackData: 'action:buy_energy'
    });

    // Buyer-specific: My Orders
    if (hasConsumption && !hasGeneration && !hasStorage) {
      suggestions.push({
        text: h(ctx, '📦 My Orders', '📦 मेरे ऑर्डर'),
        callbackData: 'action:show_orders'
      });
    }

    // Cancel button for pending actions
    if (ctx.pendingListing || ctx.pendingPurchase) {
      suggestions.unshift({ text: h(ctx, '❌ Cancel', '❌ रद्द'), callbackData: 'cmd:cancel' });
    }

    // Limit to 4 suggestions
    return suggestions.slice(0, 4);
  }

  return suggestions;
}

/**
 * Convert numeric input (1, 2, 3...) to corresponding button callback data.
 * WhatsApp shows buttons as numbered text, so users reply with numbers.
 */
function convertNumericToCallback(
  input: string,
  buttons: Array<{ text: string; callbackData?: string }>
): string | null {
  const num = parseInt(input.trim(), 10);
  if (isNaN(num) || num < 1 || num > buttons.length) {
    return null;
  }
  const button = buttons[num - 1];
  return button.callbackData || button.text;
}

/**
 * Generate a friendly "I don't understand" response with context-aware suggestions.
 * This provides a better UX than a generic fallback by acknowledging confusion
 * and offering specific actions the user can take.
 */
function getConfusedResponse(ctx: SessionContext, userMessage: string): AgentResponse {
  const verifiedCreds = ctx.verifiedCreds || [];
  const hasGeneration = verifiedCreds.includes('GENERATION_PROFILE');
  const hasConsumption = verifiedCreds.includes('CONSUMPTION_PROFILE');

  // Build the friendly message
  const intro = h(ctx,
    "🤔 Hmm, I didn't quite get that.",
    "🤔 हम्म, मुझे समझ नहीं आया।"
  );

  // Context-aware suggestion based on user state
  let contextSuggestion = '';
  if (ctx.pendingListing) {
    contextSuggestion = h(ctx,
      "\n💡 You have a pending listing. Reply 'continue' to finish it or 'cancel' to start fresh.",
      "\n💡 आपकी एक लिस्टिंग पेंडिंग है। जारी रखने के लिए 'continue' या नया शुरू करने के लिए 'cancel' बोलो।"
    );
  } else if (ctx.pendingPurchase) {
    contextSuggestion = h(ctx,
      "\n💡 You have a pending purchase. Reply 'continue' to finish it or 'cancel' to start fresh.",
      "\n💡 आपकी एक खरीदारी पेंडिंग है। जारी रखने के लिए 'continue' या नया शुरू करने के लिए 'cancel' बोलो।"
    );
  } else if (hasGeneration && !hasConsumption) {
    contextSuggestion = h(ctx,
      "\n💡 As a solar producer, would you like to sell some energy today?",
      "\n💡 सोलर प्रोड्यूसर के तौर पर, क्या आप आज कुछ बिजली बेचना चाहेंगे?"
    );
  } else if (!hasGeneration && hasConsumption) {
    contextSuggestion = h(ctx,
      "\n💡 Looking to save on electricity? I can find you the best green energy deals!",
      "\n💡 बिजली पर बचाना चाहते हो? मैं आपके लिए बेस्ट हरित ऊर्जा डील ढूंढ सकता हूं!"
    );
  }

  const menuIntro = h(ctx,
    "\n\nHere's what I can help with:",
    "\n\nमैं यह मदद कर सकता हूं:"
  );

  // Quick numbered options with emojis
  const quickOptions = h(ctx,
    "\n1️⃣ Sell energy\n2️⃣ Buy energy\n3️⃣ Check prices\n4️⃣ My dashboard",
    "\n1️⃣ बिजली बेचो\n2️⃣ बिजली खरीदो\n3️⃣ दाम देखो\n4️⃣ डैशबोर्ड"
  );

  const helpHint = h(ctx,
    "\n\nType a number (1-4) or say 'help' for all commands!",
    "\n\nनंबर टाइप करो (1-4) या सभी कमांड के लिए 'मदद' बोलो!"
  );

  // Build buttons with emojis
  const buttons = [
    { text: h(ctx, '☀️ Sell Energy', '☀️ बिजली बेचो'), callbackData: 'action:create_listing' },
    { text: h(ctx, '⚡ Buy Energy', '⚡ बिजली खरीदो'), callbackData: 'action:buy_energy' },
    { text: h(ctx, '📊 Market Prices', '📊 दाम देखो'), callbackData: 'action:market_insights' },
    { text: h(ctx, '📊 My Electricity Info', '📊 मेरी बिजली की जानकारी'), callbackData: 'action:dashboard' },
  ];

  return {
    messages: [{
      text: intro + contextSuggestion + menuIntro + quickOptions + helpHint,
      buttons,
    }],
  };
}

/**
 * Fuzzy match common typos and abbreviations to commands.
 * Returns the corrected command/callback or null if no match.
 */
function fuzzyMatchCommand(input: string): string | null {
  const normalized = input.toLowerCase().trim();

  // Common typos and abbreviations
  const fuzzyMap: Record<string, string> = {
    // Sell variations
    'sel': 'action:create_listing',
    'sale': 'action:create_listing',
    'seel': 'action:create_listing',
    'slel': 'action:create_listing',
    'becho': 'action:create_listing',
    'bech': 'action:create_listing',
    'bechna': 'action:create_listing',
    'bikri': 'action:create_listing',

    // Buy variations
    'bye': 'action:buy_energy',
    'buye': 'action:buy_energy',
    'byu': 'action:buy_energy',
    'kharid': 'action:buy_energy',
    'khareed': 'action:buy_energy',
    'kharido': 'action:buy_energy',
    'lena': 'action:buy_energy',

    // Help variations
    'hep': 'cmd:help',
    'halp': 'cmd:help',
    'hlp': 'cmd:help',
    'madad': 'cmd:help',
    'madat': 'cmd:help',
    'sahayata': 'cmd:help',

    // Market/prices variations
    'price': 'action:market_insights',
    'prices': 'action:market_insights',
    'rate': 'action:market_insights',
    'rates': 'action:market_insights',
    'daam': 'action:market_insights',
    'dam': 'action:market_insights',
    'kimat': 'action:market_insights',
    'market': 'action:market_insights',
    'bazaar': 'action:market_insights',
    'bajar': 'action:market_insights',

    // Dashboard variations
    'dash': 'action:dashboard',
    'dashbord': 'action:dashboard',
    'overview': 'action:dashboard',
    'summary': 'action:dashboard',
    'status': 'action:dashboard',

    // Balance variations
    'bal': 'action:show_balance',
    'paise': 'action:show_balance',
    'paisa': 'action:show_balance',
    'wallet': 'action:show_balance',
    'rupee': 'action:show_balance',
    'rupay': 'action:show_balance',

    // Orders variations
    'ordres': 'action:show_orders',
    'ordr': 'action:show_orders',
    'order': 'action:show_orders',

    // Earnings variations
    'earn': 'action:show_earnings',
    'earnigs': 'action:show_earnings',
    'kamai': 'action:show_earnings',
    'munafa': 'action:show_earnings',
    'profit': 'action:show_earnings',

    // Cancel variations
    'cancle': 'cmd:cancel',
    'cansel': 'cmd:cancel',
    'ruko': 'cmd:cancel',
    'band': 'cmd:cancel',

    // Back variations
    'bak': 'cmd:back',
    'peeche': 'cmd:back',
    'wapas': 'cmd:back',
  };

  // Direct match
  if (fuzzyMap[normalized]) {
    return fuzzyMap[normalized];
  }

  // Partial match (for words that are part of a longer message)
  for (const [typo, command] of Object.entries(fuzzyMap)) {
    if (normalized === typo || normalized.startsWith(typo + ' ') || normalized.endsWith(' ' + typo)) {
      return command;
    }
  }

  return null;
}

const states: Record<ChatState, StateHandler> = {
  GREETING: {
    async onEnter(ctx) {
      // For web users, mention the speaker button in the greeting
      const voiceNote = ctx._platform === 'WEB'
        ? '\n\n🔊 Agar meri messages sunna chahte ho, speaker button dabao.'
        : '';

      const messages: AgentMessage[] = [
        { text: `Namaste! Main Oorja hun.\nMain aapko apne ghar pe banai bijli se paise kamane mein madad karunga. Aur jinhe bijli khareedni hai, unhe sahi daam pe dilaunga.\n\nAgar aapko kisi bhi samay koi bhi sawaal ho, to mujhe pooch lena!${voiceNote}` },
        {
          text: 'अपनी भाषा चुनें / Choose your language:',
          buttons: LANG_BUTTONS,
          delay: 300,
        },
      ];

      return { messages };
    },
    async onMessage(ctx, message) {
      // Helper to get translated welcome message
      const getWelcomeForLang = (lang: string, platform: string | undefined) => {
        const welcome = WELCOME_MESSAGES[lang] || WELCOME_MESSAGES['en-IN'];
        const voiceNote = platform === 'WEB' ? welcome.voiceNote : '';
        return welcome.greeting + voiceNote;
      };

      // Language selection from button callback
      if (message.startsWith('lang:')) {
        const lang = message.replace('lang:', '');
        const welcomeText = getWelcomeForLang(lang, ctx._platform);
        return {
          messages: [{ text: welcomeText }],
          newState: 'WAITING_NAME',
          contextUpdate: { language: lang as any, langPicked: true },
        };
      }

      // Handle numeric input (WhatsApp users reply with 1, 2, 3...)
      const numericCallback = convertNumericToCallback(message, LANG_BUTTONS);
      if (numericCallback && numericCallback.startsWith('lang:')) {
        const lang = numericCallback.replace('lang:', '');
        const welcomeText = getWelcomeForLang(lang, ctx._platform);
        return {
          messages: [{ text: welcomeText }],
          newState: 'WAITING_NAME',
          contextUpdate: { language: lang as any, langPicked: true },
        };
      }

      // Free-text that isn't a language selection — re-show language buttons
      return {
        messages: [{
          text: 'Please select a language to get started:\nआगे बढ़ने के लिए भाषा चुनें:',
          buttons: LANG_BUTTONS,
        }],
      };
    },
  },

  // Legacy: ASK_VOICE_PREF - voice toggle is now in header UI, but handle existing sessions
  ASK_VOICE_PREF: {
    async onEnter(ctx) {
      // Skip this state entirely - just transition to WAITING_NAME
      return {
        messages: [],
        newState: 'WAITING_NAME',
      };
    },
    async onMessage(ctx, message) {
      // If user somehow sends a message here, just move on
      return {
        messages: [],
        newState: 'WAITING_NAME',
      };
    },
  },

  WAITING_NAME: {
    async onEnter(ctx) {
      // Skip if name was already asked (from GREETING free-text flow)
      if (ctx.nameAsked) {
        return { messages: [] };
      }
      const progress = getProgressIndicator('WAITING_NAME', ctx);
      return {
        messages: [{ text: progress + h(ctx, 'What is your name?', 'आपका नाम क्या है?') }],
      };
    },
    async onMessage(ctx, message) {
      // Ignore callback-style inputs (e.g., action:buy_energy, cmd:help) — re-prompt
      if (message.includes(':') && !message.includes(' ')) {
        return {
          messages: [{ text: h(ctx, 'What is your name?', 'आपका नाम क्या है?') }],
        };
      }

      // Try LLM-powered name extraction first (handles casual speech like "Uh, Jack, what's yours?")
      let name = await extractNameWithLLM(message);

      // Fall back to regex extraction if LLM unavailable or fails
      if (!name) {
        name = extractName(message);
      }

      if (!name || name.length < 2) {
        return {
          messages: [{ text: h(ctx, 'Please enter your name.', 'Apna naam batao.') }],
        };
      }
      return {
        messages: [],
        newState: 'WAITING_PHONE',
        contextUpdate: { name },
      };
    },
  },

  WAITING_PHONE: {
    async onEnter(ctx) {
      const name = ctx.name || 'friend';
      const progress = getProgressIndicator('WAITING_PHONE', ctx);
      return {
        messages: [
          { text: progress + h(ctx, `Nice to meet you, ${name}! Your phone number?`, `${name}, आपसे मिलकर खुशी हुई! आपका फ़ोन नंबर?`) },
        ],
      };
    },
    async onMessage(ctx, message) {
      // First try LLM extraction to handle Hindi number words and spoken digits
      // Examples: "नौ आठ सात छः पाँच चार तीन दो एक शून्य" → "9876543210"
      let phone = await extractPhoneWithLLM(message, 'Your phone number?');

      // Fallback to regex extraction if LLM unavailable or fails
      if (!phone) {
        phone = extractIndianPhone(message);
      }

      if (!phone) {
        // Final fallback to basic cleaning for typed input
        phone = message.trim().replace(/[\s\-()]/g, '');
      }

      if (!validatePhoneNumber(phone)) {
        return {
          messages: [{ text: h(ctx, 'Please enter a valid 10-digit phone number.', 'सही 10 अंकों का फ़ोन नंबर डालो।') }],
        };
      }

      const normalized = normalizePhone(phone);
      const result = await sendOtp(normalized);

      if (!result.success) {
        return {
          messages: [{ text: h(ctx, 'Could not send OTP. Please try again.', 'कोड नहीं भेज पाए। दोबारा कोशिश करो।') }],
        };
      }

      return {
        messages: [],
        newState: 'WAITING_OTP',
        contextUpdate: { phone: normalized },
      };
    },
  },

  WAITING_OTP: {
    async onEnter(ctx) {
      const progress = getProgressIndicator('WAITING_OTP', ctx);
      return {
        messages: [
          { text: progress + h(ctx, `Code sent to ${ctx.phone}. Enter it:`, `${ctx.phone} पे कोड भेज दिया है। यहाँ डालो:`) },
        ],
      };
    },
    async onMessage(ctx, message) {
      const attempts = (ctx.otpAttempts || 0) + 1;

      // First try LLM extraction to handle Hindi number words
      // Examples: "एक दो तीन चार पाँच छः" → "123456"
      let otp = await extractOtpWithLLM(message, 'Enter the verification code');

      // Fallback to basic cleaning if LLM unavailable or fails
      if (!otp) {
        otp = message.trim().replace(/\s/g, '');
      }

      if (!/^\d{4,6}$/.test(otp)) {
        return {
          messages: [{ text: h(ctx, 'Enter the 6-digit code.', '6 अंकों का कोड डालो।') }],
          contextUpdate: { otpAttempts: attempts },
        };
      }

      const result = await verifyOtpAndAuthenticate(ctx.phone!, otp, ctx.name);

      if (!result.success) {
        if (attempts >= 3) {
          return {
            messages: [{ text: h(ctx, 'Too many wrong attempts. Let\'s try again.', 'बहुत गलत कोशिश। चलो फिर से शुरू करते हैं।') }],
            newState: 'WAITING_PHONE',
            contextUpdate: { otpAttempts: 0 },
          };
        }
        const left = 3 - attempts;
        return {
          messages: [{ text: h(ctx, `Wrong code. ${left} attempt(s) left.`, `Galat code. ${left} try baaki.`) }],
          contextUpdate: { otpAttempts: attempts },
        };
      }

      // Update name and language preference for new user
      if (result.isNewUser && result.userId) {
        await prisma.user.update({
          where: { id: result.userId },
          data: {
            name: ctx.name || undefined,
            languagePreference: ctx.language || undefined,
          },
        });
      } else if (!result.isNewUser && result.user?.name) {
        ctx.name = result.user.name;
      }

      // Create session token
      const authSession = await createSession({
        userId: result.userId!,
        deviceInfo: 'Oorja-Agent',
      });

      // Send WhatsApp welcome for new users who registered via web
      if (result.isNewUser && ctx._platform === 'WEB' && ctx.phone && isWhatsAppConnected()) {
        const userName = ctx.name || 'friend';
        const botNumber = getWhatsAppBotNumber();
        const welcomeMsg = h(ctx,
          `Hi ${userName}! Welcome to Oorja. You just registered on our website. You can continue chatting here on WhatsApp anytime! Just message me to pick up where you left off.`,
          `Namaste ${userName}! Oorja mein aapka swagat hai. Aapne website pe register kiya. Aap WhatsApp pe bhi baat kar sakte ho! Bas message bhejo.`
        );

        // Fire-and-forget - don't block the response
        sendProactiveMessage(ctx.phone, welcomeMsg).catch(err => {
          logger.warn(`Failed to send WhatsApp welcome: ${err.message}`);
        });

        logger.info(`Sent WhatsApp welcome to new web user: ${ctx.phone}`);
      }

      return {
        messages: [],
        newState: 'AUTHENTICATED',
        contextUpdate: {
          userId: result.userId,
          authToken: authSession.token,
          name: ctx.name || result.user?.name || undefined,
          otpAttempts: 0,
          language: ctx.language, // Explicitly preserve language through state transition
        },
        authToken: authSession.token,
      };
    },
  },

  AUTHENTICATED: {
    async onEnter(ctx) {
      logger.info(`[AUTHENTICATED.onEnter] ctx.language = "${ctx.language}", ctx.name = "${ctx.name}", ctx.userId = "${ctx.userId}"`);
      const name = ctx.name || 'friend';
      if (!ctx.userId) {
        logger.info(`[AUTHENTICATED.onEnter] No userId, returning welcome in language: ${ctx.language}`);
        return {
          messages: [{ text: h(ctx, `Welcome, ${name}!`, `स्वागत है, ${name}!`) }],
          newState: 'ASK_DISCOM',
        };
      }

      const verifiedCreds = await getVerifiedCredentials(ctx.userId);
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { id: true, name: true, profileComplete: true, languagePreference: true },
      });

      // Ensure language is set - use user's saved preference as fallback
      if (!ctx.language && user?.languagePreference) {
        ctx.language = user.languagePreference as any;
        logger.info(`[AUTHENTICATED] Restored language from user profile: ${ctx.language}`);
      }

      if (user?.profileComplete) {
        const n = ctx.name || user.name || 'friend';

        // Compose a welcome-back summary with LLM
        const summaryData = await getWelcomeBackData(ctx.userId);
        const credContext = 'User profile: Already onboarded and verified. Do NOT ask for credentials — they have already completed onboarding.';
        const composed = await composeResponse(
          'welcome back, give me a summary of my activity',
          `${credContext}\n\n${summaryData}`,
          ctx.language,
          n
        );

        return {
          messages: [{ text: composed || h(ctx, `Welcome back, ${n}!`, `वापस स्वागत, ${n}!`) }],
          newState: 'GENERAL_CHAT',
          contextUpdate: { verifiedCreds, tradingActive: true },
        };
      }

      if (verifiedCreds.includes('UTILITY_CUSTOMER')) {
        const n = ctx.name || user?.name || 'friend';
        return {
          messages: [{ text: h(ctx, `Welcome back, ${n}!`, `वापस स्वागत, ${n}!`) }],
          newState: 'ASK_INTENT',
          contextUpdate: { verifiedCreds },
        };
      }

      logger.info(`[AUTHENTICATED.onEnter] Final path - returning welcome in language: ${ctx.language}`);
      return {
        messages: [{ text: h(ctx, `Welcome, ${name}!`, `स्वागत है, ${name}!`) }],
        newState: 'ASK_DISCOM',
        contextUpdate: { verifiedCreds },
      };
    },
    async onMessage() {
      return { messages: [] };
    },
  },

  ASK_DISCOM: {
    async onEnter(ctx) {
      const progress = getProgressIndicator('ASK_DISCOM', ctx);
      const localizedList = getLocalizedDiscomList(ctx.language);
      return {
        messages: [
          {
            text: progress + h(ctx,
              'Which company do you get electricity from?',
              'आप किस कंपनी से बिजली लेते हो?'
            ),
            buttons: localizedList,
          },
        ],
      };
    },
    async onMessage(ctx, message) {
      // Handle numeric input (WhatsApp users reply with 1, 2, 3...)
      const numericCallback = convertNumericToCallback(message, DISCOM_LIST);
      if (numericCallback) {
        message = numericCallback;
      }

      // Try to match spoken/typed DISCOM name to options via LLM
      if (!message.startsWith('discom:')) {
        const matchedDiscom = await matchDiscomWithLLM(message, DISCOM_LIST);
        if (matchedDiscom) {
          message = matchedDiscom;
        }
      }

      if (message.startsWith('discom:')) {
        const discomKey = message.replace('discom:', '');

        if (discomKey === 'other') {
          return {
            messages: [
              {
                text: h(ctx,
                  'Please type your electricity company name:',
                  'अपनी बिजली कंपनी का नाम लिखो:'
                ),
              },
            ],
            contextUpdate: { askedDiscom: true },
          };
        }

        const discomEntry = DISCOM_LIST.find(d => d.callbackData === message);
        const discomName = discomEntry?.text || discomKey;
        return {
          messages: [],
          newState: 'WAITING_UTILITY_CRED',
          contextUpdate: { discom: discomName },
        };
      }

      // Free text — treat as manual DISCOM name entry
      const typed = message.trim();
      if (typed.length < 2) {
        return {
          messages: [
            {
              text: h(ctx,
                'Please select your electricity company or type the name:',
                'अपनी बिजली कंपनी चुनो या नाम लिखो:'
              ),
              buttons: getLocalizedDiscomList(ctx.language),
            },
          ],
        };
      }

      return {
        messages: [],
        newState: 'WAITING_UTILITY_CRED',
        contextUpdate: { discom: typed },
      };
    },
  },

  WAITING_UTILITY_CRED: {
    async onEnter(ctx) {
      const progress = getProgressIndicator('WAITING_UTILITY_CRED', ctx);
      const discomLabel = ctx.discom || 'your DISCOM';
      // Look up DISCOM-specific credential link
      const discomKey = Object.keys(DISCOM_CRED_LINKS).find(
        key => DISCOM_LIST.find(d => d.callbackData === `discom:${key}`)?.text === ctx.discom
      ) || 'other';
      const credLink = DISCOM_CRED_LINKS[discomKey] || DISCOM_CRED_LINKS['other'];

      // Get localized DISCOM name for display
      const localizedDiscom = ctx.language && DISCOM_TRANSLATIONS[ctx.language]
        ? (DISCOM_TRANSLATIONS[ctx.language][discomLabel] || discomLabel)
        : discomLabel;

      return {
        messages: [
          {
            text: progress + h(ctx,
              `I need your electricity account ID from ${discomLabel}. You can get it online here:\n${credLink}\n\nDownload and upload it here (PDF).`,
              `मुझे आपकी बिजली कंपनी (${localizedDiscom}) का आईडी चाहिए। वो आपको ऑनलाइन मिल जाएगा इस वेबसाइट पर:\n${credLink}\n\nडाउनलोड करके यहाँ अपलोड करो (पीडीएफ)।`
            ),
          },
        ],
      };
    },
    async onMessage(ctx, message, fileData) {
      if (!fileData) {
        const kbAnswer = knowledgeBase.findAnswer(message, ctx.language);
        if (kbAnswer) {
          return {
            messages: [
              { text: kbAnswer },
              { text: h(ctx, 'Upload your electricity account ID when ready (PDF).', 'जब तैयार हो तब बिजली कंपनी का आईडी अपलोड करो (पीडीएफ)।'), delay: 300 },
            ],
          };
        }

        const isQuestion = message.includes('?') || message.length > 15;
        if (isQuestion) {
          const llmAnswer = await askLLM(message, 'User needs to upload their electricity account ID to start P2P energy trading.');
          if (llmAnswer) {
            return {
              messages: [
                { text: llmAnswer },
                { text: h(ctx, 'Upload the ID when ready.', 'जब तैयार हो तब आईडी अपलोड करो।'), delay: 300 },
              ],
            };
          }
        }

        return {
          messages: [{ text: h(ctx, 'Please upload your electricity account ID (PDF).', 'अपनी बिजली कंपनी का आईडी अपलोड करो (पीडीएफ)।') }],
        };
      }

      try {
        const result = await processCredentialUpload(ctx.userId!, fileData, 'UtilityCustomerCredential', ctx.language);

        if (!result.success) {
          return {
            messages: [{ text: result.error || h(ctx, 'Could not verify this credential. Please try again.', 'दस्तावेज़ वेरिफाई नहीं हो पाया। दोबारा कोशिश करो।') }],
          };
        }

        // Mark profile as complete after mandatory utility cred — App button will work from here
        await prisma.user.update({
          where: { id: ctx.userId! },
          data: { profileComplete: true },
        });

        return {
          messages: [{ text: h(ctx, `Verified! ${result.summary}`, `वेरिफाई हो गया! ${result.summary}`) }],
          newState: 'ASK_INTENT',
          contextUpdate: {
            verifiedCreds: [...(ctx.verifiedCreds || []), 'UTILITY_CUSTOMER'],
          },
        };
      } catch (error: any) {
        logger.error(`Utility cred verification failed: ${error.message}`);
        return {
          messages: [{ text: h(ctx, 'Something went wrong verifying this. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
        };
      }
    },
  },

  ASK_INTENT: {
    async onEnter(ctx) {
      const progress = getProgressIndicator('ASK_INTENT', ctx);
      const intentButtons = [
        { text: h(ctx, 'Sell solar energy', '☀️ सोलर से बिजली बेचना'), callbackData: 'intent:solar' },
        { text: h(ctx, 'Battery storage', '🔋 बैटरी में स्टोर करना'), callbackData: 'intent:battery' },
        { text: h(ctx, 'Buy energy', '⚡ बिजली खरीदना'), callbackData: 'intent:buy' },
        { text: h(ctx, 'Just browse', '👀 बस देखना है'), callbackData: 'intent:skip' },
      ];
      return {
        messages: [
          {
            text: progress + h(ctx,
              'What would you like to do?',
              'अब बताओ, आपको क्या करना है?'
            ),
            buttons: intentButtons,
          },
        ],
      };
    },
    async onMessage(ctx, message) {
      // Handle numeric input (WhatsApp users reply with 1, 2, 3...)
      const intentButtons = [
        { text: 'Sell solar energy', callbackData: 'intent:solar' },
        { text: 'Battery storage', callbackData: 'intent:battery' },
        { text: 'Buy energy', callbackData: 'intent:buy' },
        { text: 'Just browse', callbackData: 'intent:skip' },
      ];
      const numericCallback = convertNumericToCallback(message, intentButtons);
      if (numericCallback) {
        message = numericCallback;
      }

      if (message.startsWith('intent:')) {
        const intent = message.replace('intent:', '');

        if (intent === 'skip') {
          return {
            messages: [],
            newState: 'CONFIRM_TRADING',
          };
        }

        if (intent === 'solar') {
          return {
            messages: [],
            newState: 'OFFER_OPTIONAL_CREDS',
            contextUpdate: { intent: 'sell', expectedCredType: 'GenerationProfileCredential' },
          };
        }

        if (intent === 'battery') {
          return {
            messages: [],
            newState: 'OFFER_OPTIONAL_CREDS',
            contextUpdate: { intent: 'sell', expectedCredType: 'StorageProfileCredential' },
          };
        }

        if (intent === 'buy') {
          return {
            messages: [],
            newState: 'OFFER_OPTIONAL_CREDS',
            contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
          };
        }
      }

      // Free text — try to detect intent
      const lower = message.toLowerCase();
      if (lower.includes('solar') || lower.includes('bech') || lower.includes('sell')) {
        return {
          messages: [],
          newState: 'OFFER_OPTIONAL_CREDS',
          contextUpdate: { intent: 'sell', expectedCredType: 'GenerationProfileCredential' },
        };
      }
      if (lower.includes('battery') || lower.includes('store') || lower.includes('storage')) {
        return {
          messages: [],
          newState: 'OFFER_OPTIONAL_CREDS',
          contextUpdate: { intent: 'sell', expectedCredType: 'StorageProfileCredential' },
        };
      }
      if (lower.includes('buy') || lower.includes('khareed') || lower.includes('kharid')) {
        return {
          messages: [],
          newState: 'OFFER_OPTIONAL_CREDS',
          contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
        };
      }
      if (lower.includes('skip') || lower.includes('nahi') || lower.includes('no') || lower.includes('aage') || lower.includes('dekh') || lower.includes('browse')) {
        return {
          messages: [],
          newState: 'CONFIRM_TRADING',
        };
      }

      // Re-prompt
      return {
        messages: [
          {
            text: h(ctx,
              'Please choose what you\'d like to do:',
              'चुनो, आपको क्या करना है:'
            ),
            buttons: [
              { text: h(ctx, '☀️ Sell solar energy', '☀️ सोलर से बिजली बेचना'), callbackData: 'intent:solar' },
              { text: h(ctx, '🔋 Battery storage', '🔋 बैटरी में स्टोर करना'), callbackData: 'intent:battery' },
              { text: h(ctx, '⚡ Buy energy', '⚡ बिजली खरीदना'), callbackData: 'intent:buy' },
              { text: h(ctx, '👀 Just browse', '👀 बस देखना है'), callbackData: 'intent:skip' },
            ],
          },
        ],
      };
    },
  },

  OFFER_OPTIONAL_CREDS: {
    async onEnter(ctx) {
      const verifiedCreds = ctx.verifiedCreds || [];
      const expectedType = ctx.expectedCredType;

      // No expected credential or already verified → move on
      if (!expectedType) {
        return { messages: [], newState: 'CONFIRM_TRADING' };
      }

      const dbType = degTypeToDbType(expectedType);
      if (verifiedCreds.includes(dbType)) {
        return { messages: [], newState: 'CONFIRM_TRADING' };
      }

      // Route to credential upload
      return {
        messages: [],
        newState: 'WAITING_OPTIONAL_CRED',
        contextUpdate: { expectedCredType: expectedType },
      };
    },
    async onMessage(ctx, message, fileData) {
      // Shouldn't normally receive messages (pass-through state), but handle gracefully
      if (fileData) {
        return states.WAITING_OPTIONAL_CRED.onMessage(ctx, message, fileData);
      }
      return {
        messages: [],
        newState: 'WAITING_OPTIONAL_CRED',
      };
    },
  },

  WAITING_OPTIONAL_CRED: {
    async onEnter(ctx) {
      const expectedType = ctx.expectedCredType || '';
      const farmerName = CRED_FARMER_NAMES[expectedType] || { en: 'ID', hi: 'ID' };

      // Get credential link based on DISCOM
      const discomKey = Object.keys(DISCOM_CRED_LINKS).find(
        key => DISCOM_LIST.find(d => d.callbackData === `discom:${key}`)?.text === ctx.discom
      ) || 'other';
      const credLink = DISCOM_CRED_LINKS[discomKey] || DISCOM_CRED_LINKS['other'];

      return {
        messages: [
          {
            text: h(ctx,
              `Your electricity company would have given you a ${farmerName.en} online. You can get it here:\n${credLink}\n\nUpload it here (PDF).`,
              `आपकी बिजली कंपनी ने आपको ${farmerName.hi} ऑनलाइन दिया होगा। इस लिंक पर मिल जाएगा:\n${credLink}\n\nअपलोड करो (पीडीएफ)।`
            ),
          },
        ],
      };
    },
    async onMessage(ctx, message, fileData) {
      if (!fileData) {
        const kbAnswer = knowledgeBase.findAnswer(message, ctx.language);
        if (kbAnswer) {
          return {
            messages: [
              { text: kbAnswer },
              { text: h(ctx, 'Upload the ID when ready.', 'जब तैयार हो तब आईडी अपलोड करो।'), delay: 300 },
            ],
          };
        }

        // Let user skip (including numeric "1" for the Skip button)
        if (message.toLowerCase().includes('skip') || message.toLowerCase().includes('back') || message.toLowerCase().includes('nahi') || message.trim() === '1') {
          return {
            messages: [],
            newState: 'CONFIRM_TRADING',
          };
        }

        const farmerName = CRED_FARMER_NAMES[ctx.expectedCredType || ''] || { en: 'ID', hi: 'आईडी' };
        return {
          messages: [
            {
              text: h(ctx,
                `Please upload your ${farmerName.en} (PDF).`,
                `अपना ${farmerName.hi} अपलोड करो (पीडीएफ)।`
              ),
              buttons: [{ text: h(ctx, '⏭️ Skip this', '⏭️ ये स्किप करो'), callbackData: 'skip' }],
            },
          ],
        };
      }

      try {
        const result = await processCredentialUpload(ctx.userId!, fileData, ctx.expectedCredType, ctx.language);

        if (!result.success) {
          return {
            messages: [{ text: result.error || h(ctx, 'Could not verify. Please try again.', 'वेरिफाई नहीं हो पाई। दोबारा कोशिश करो।') }],
          };
        }

        const dbType = degTypeToDbType(result.credType);
        const updatedCreds = [...new Set([...(ctx.verifiedCreds || []), dbType])];

        // Debug: log credential type and intent
        logger.info(`[WAITING_OPTIONAL_CRED] credType=${result.credType}, ctx.intent=${ctx.intent}, dbType=${dbType}`);

        // Special handling for consumption credential - show savings calculation for buyers
        if (result.credType === 'ConsumptionProfileCredential' && ctx.intent === 'buy') {
          // Extract sanctioned load from claims
          const claims = result.claims || {};
          const sanctionedLoad = claims.sanctionedLoadKW || 0;

          // Calculate monthly savings: sanctioned_load * 24 * 30 * 0.3 * 1.5
          // This assumes 30% usage pattern and Rs 1.5 savings per unit
          const monthlySavings = roundTo500(sanctionedLoad * 24 * 30 * 0.3 * 1.5);

          // Mark profile complete for buyers
          await prisma.user.update({
            where: { id: ctx.userId! },
            data: { profileComplete: true },
          });

          const savingsEn = monthlySavings > 0
            ? `With your ${sanctionedLoad} kW connection, you could save around Rs ${monthlySavings} per month by buying green energy at lower rates!`
            : `You're all set to buy green energy at lower rates and save money!`;
          const savingsHi = monthlySavings > 0
            ? `आपके ${sanctionedLoad} किलोवाट कनेक्शन से आप हर महीने करीब ₹${monthlySavings} बचा सकते हो सस्ती हरी बिजली खरीद कर!`
            : `आप अब सस्ती हरी बिजली खरीद कर पैसे बचा सकते हो!`;

          // Continue directly to buy flow instead of going back to GENERAL_CHAT
          return {
            messages: [
              { text: h(ctx, `Verified! ${result.summary}`, `वेरिफाई हो गया! ${result.summary}`) },
              { text: h(ctx, savingsEn, savingsHi), delay: 300 },
              {
                text: h(ctx,
                  '🔋 *Buy Energy*\n\nHow would you like to proceed?\n\n🤖 *Buy Automatically* - Daily auto-buy at best prices\n📝 *One-time Purchase* - Buy energy once',
                  '🔋 *बिजली खरीदो*\n\nकैसे आगे बढ़ना चाहते हो?\n\n🤖 *ऑटोमैटिक* - रोज़ सबसे सस्ते दाम पर\n📝 *एक बार* - एक बार खरीदो'
                ),
                buttons: [
                  { text: h(ctx, '🤖 Buy Automatically', '🤖 ऑटोमैटिक'), callbackData: 'action:setup_auto_buy' },
                  { text: h(ctx, '📝 One-time Purchase', '📝 एक बार'), callbackData: 'purchase_mode:onetime' },
                ],
                delay: 300,
              },
            ],
            newState: 'GENERAL_CHAT',
            contextUpdate: {
              verifiedCreds: updatedCreds,
              pendingPurchase: { awaitingField: 'choose_mode' },
            },
          };
        }

        return {
          messages: [{ text: h(ctx, `Verified! ${result.summary}`, `वेरिफाई हो गया! ${result.summary}`) }],
          newState: 'CONFIRM_TRADING',
          contextUpdate: {
            verifiedCreds: updatedCreds,
          },
        };
      } catch (error: any) {
        logger.error(`Optional cred verification failed: ${error.message}`);
        return {
          messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
        };
      }
    },
  },

  CONFIRM_TRADING: {
    async onEnter(ctx) {
      const verifiedCreds = ctx.verifiedCreds || [];
      const hasGeneration = verifiedCreds.includes('GENERATION_PROFILE');
      const hasStorage = verifiedCreds.includes('STORAGE_PROFILE');

      // IMPORTANT: Check intent FIRST - user may have switched from selling to buying
      // If they explicitly chose to buy, go to buyer flow even if they have selling credentials
      if (ctx.intent === 'buy') {
        await prisma.user.update({
          where: { id: ctx.userId! },
          data: { profileComplete: true },
        });

        return {
          messages: [
            {
              text: h(ctx,
                'I\'ll help you find the best energy deals from local producers at fair prices. Your profile is ready!',
                'Main aapko local producers se sahi daam pe bijli dilaunga. Aapka profile ready hai!'
              )
            },
          ],
          newState: 'GENERAL_CHAT',
        };
      }

      // Selling flow — explain what Oorja does, show expected earnings, ask to start
      if (hasGeneration || hasStorage) {
        const user = await prisma.user.findUnique({
          where: { id: ctx.userId! },
          select: { productionCapacity: true, trustScore: true },
        });

        const capacity = user?.productionCapacity || ctx.productionCapacity;
        const tradeLimitPct = calculateAllowedLimit(user?.trustScore ?? 0.3);
        let explainEn: string;
        let explainHi: string;

        if (hasGeneration) {
          const capEn = capacity ? `Your solar panel generates ~${capacity} units per month. ` : '';
          const capHi = capacity ? `आपका सोलर पैनल ~${capacity} किलोवाट घंटा प्रति महीना बिजली बनाता है। ` : '';

          // Calculate expected monthly earnings
          let earningsEn = '';
          let earningsHi = '';
          if (capacity) {
            const tradeableKwh = Math.floor(capacity * tradeLimitPct / 100);
            // Show range based on potential price variation (Rs 6-9 per unit)
            const minMonthly = roundTo500(tradeableKwh * 6);
            const maxMonthly = roundTo500(tradeableKwh * 9);
            earningsEn = `With your current ${tradeLimitPct}% trade limit, you can earn Rs ${minMonthly} to ${maxMonthly} per month. As you sell more successfully, your limit increases! `;
            earningsHi = `अभी आप ₹${minMonthly} से ₹${maxMonthly} महीना कमा सकते हो। जैसे-जैसे आप अच्छे से बेचते रहोगे, आप और ज़्यादा बेच पाओगे! `;
          }

          explainEn = `${capEn}I'll sell the extra energy from your solar panels at good prices to maximize your earnings. ${earningsEn}`;
          explainHi = `${capHi}मैं आपके सोलर से बनी बिजली को अच्छे दाम पर बाज़ार में बेचूँगा ताकि आपकी कमाई ज़्यादा हो। ${earningsHi}`;
        } else {
          explainEn = `I'll help you store energy in your battery and sell it at the best times for maximum returns.`;
          explainHi = `मैं आपकी बैटरी में जमा बिजली को सही समय पर बेचकर आपका मुनाफा बढ़ाऊंगा।`;
        }

        return {
          messages: [
            {
              text: h(ctx, `${explainEn}\n\nShall we start?`, `${explainHi}\n\nशुरू करें?`),
              buttons: [
                { text: h(ctx, '✅ Yes, start!', '✅ हाँ, शुरू करो!'), callbackData: 'yes' },
                { text: h(ctx, '⏸️ Not now', '⏸️ अभी नहीं'), callbackData: 'no' },
              ],
            },
          ],
        };
      }

      // Browser / no specific intent — just mark complete
      await prisma.user.update({
        where: { id: ctx.userId! },
        data: { profileComplete: true },
      });

      return {
        messages: [
          {
            text: h(ctx,
              'Your profile is set up! You can browse energy offers or ask me anything.',
              'Aapka profile ready hai! Energy offers dekh sakte ho ya mujhse kuch bhi poocho.'
            )
          },
        ],
        newState: 'GENERAL_CHAT',
      };
    },
    async onMessage(ctx, message) {
      // Handle numeric input (WhatsApp: 1 = Yes, 2 = No)
      if (message.trim() === '1') message = 'yes';
      else if (message.trim() === '2') message = 'no';

      const lower = message.toLowerCase().trim();
      const isYes = ['yes', 'y', 'haan', 'ha', 'ok', 'sure', 'start', 'yes, start!', 'haan, shuru karo!'].includes(lower);
      const isNo = ['no', 'n', 'nahi', 'nope', 'not now', 'later', 'baad mein', 'abhi nahi'].includes(lower);

      if (isYes) {
        try {
          await prisma.user.update({
            where: { id: ctx.userId! },
            data: { profileComplete: true },
          });

          // Get user's capacity from credentials
          const userData = await prisma.user.findUnique({
            where: { id: ctx.userId! },
            include: { provider: true },
          });

          const detectedCapacity = userData?.meterVerifiedCapacity
            || userData?.productionCapacity
            || userData?.provider?.capacityKW
            || 10;
          const smartPrice = 6; // ₹6/unit

          // Setup and run auto-trade agent
          const { setupSellerAutoTrade, runSingleSellerAutoTrade } = await import('../auto-trade');
          const setupResult = await setupSellerAutoTrade(ctx.userId!, detectedCapacity, smartPrice);

          if (setupResult.success) {
            const tradeResult = await runSingleSellerAutoTrade(ctx.userId!);

            if (tradeResult) {
              const weatherPercent = Math.round(tradeResult.weatherMultiplier * 100);
              // Show effective daily target (with trade limit applied), not raw capacity
              const effectiveDaily = tradeResult.effectiveCapacity;
              const effectiveMonthly = effectiveDaily * 30;

              // Handle skipped case (already have enough listed)
              if (tradeResult.status === 'skipped') {
                const skipWarning = tradeResult.warningMessage
                  ? localizeTradeWarning(ctx, tradeResult)
                  : h(ctx, 'Already have enough listed for tomorrow.', 'कल के लिए पहले से काफी लिस्टेड है।');
                return {
                  messages: [
                    {
                      text: h(ctx,
                        `✅ Auto-sell activated!\n\n🌤️ Looking at tomorrow's weather (${weatherPercent}% solar output):\n${skipWarning}\n\nTradeable capacity: ~${effectiveMonthly} units/month (~${effectiveDaily} units/day)\n\nEvery day at 6 AM, I'll check the next day's weather and add more listings if needed.`,
                        `✅ ऑटो-सेल चालू!\n\n🌤️ कल के मौसम (${weatherPercent}% सोलर आउटपुट) को देखते हुए:\n${skipWarning}\n\nबेचने योग्य क्षमता: ~${effectiveMonthly} यूनिट/माह (~${effectiveDaily} यूनिट/दिन)\n\nरोज़ सुबह 6 बजे मौसम देखकर ज़रूरत के हिसाब से और लिस्ट करूंगा।`
                      ),
                      buttons: [
                        { text: h(ctx, '📋 View Listings', '📋 लिस्टिंग देखो'), callbackData: 'action:show_listings' },
                        { text: h(ctx, '📊 Status', '📊 स्टेटस'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    },
                  ],
                  newState: 'GENERAL_CHAT',
                  contextUpdate: { tradingActive: true },
                };
              }

              if (tradeResult.status === 'success' || tradeResult.status === 'warning_oversell') {
                const listedQty = tradeResult.listedQuantity.toFixed(1);

                let infoText = '';
                if (tradeResult.warningMessage && tradeResult.status === 'success') {
                  // This is the delta info, not a warning
                  infoText = '\n\n📝 ' + localizeTradeWarning(ctx, tradeResult);
                } else if (tradeResult.status === 'warning_oversell' && tradeResult.warningMessage) {
                  infoText = '\n\n⚠️ ' + localizeTradeWarning(ctx, tradeResult);
                }

                // Calculate tomorrow's 6 AM - 6 PM for the offer card
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const offerStartTime = new Date(tomorrow);
                offerStartTime.setHours(6, 0, 0, 0);
                const offerEndTime = new Date(tomorrow);
                offerEndTime.setHours(18, 0, 0, 0);

                // Get user's trade limit percentage from trust score
                const userForLimit = await prisma.user.findUnique({
                  where: { id: ctx.userId! },
                  select: { trustScore: true },
                });
                const tradeLimitPct = calculateAllowedLimit(userForLimit?.trustScore ?? 0.3);

                return {
                  messages: [
                    // First message: Weather and trade limit explanation
                    {
                      text: h(ctx,
                        `🌤️ Tomorrow's weather forecast shows *${weatherPercent}%* solar efficiency. Based on this and your *${tradeLimitPct}%* trade limit, I'm placing an offer for *${listedQty} units* at ₹${smartPrice}/unit.`,
                        `🌤️ कल के मौसम में *${weatherPercent}%* सोलर एफिशिएंसी है। इसके और आपकी *${tradeLimitPct}%* ट्रेड लिमिट के हिसाब से, मैं *${listedQty} यूनिट* ₹${smartPrice}/यूनिट पर ऑफ़र लगा रहा हूं।`
                      ),
                    },
                    // Second message: Offer card with confirmation and buttons
                    {
                      text: h(ctx,
                        `✅ Auto-sell activated!\n\n📊 Tradeable capacity: ~${effectiveMonthly} units/month (~${effectiveDaily} units/day)\n\nEvery day at 6 AM, I'll check the weather and your existing listings, then add what's needed.${infoText}`,
                        `✅ ऑटो-सेल चालू!\n\n📊 बेचने योग्य क्षमता: ~${effectiveMonthly} यूनिट/माह (~${effectiveDaily} यूनिट/दिन)\n\nरोज़ सुबह 6 बजे मौसम और मौजूदा लिस्टिंग देखकर ज़रूरत के हिसाब से और लिस्ट करूंगा।${infoText}`
                      ),
                      offerCreated: {
                        quantity: tradeResult.listedQuantity,
                        pricePerKwh: smartPrice,
                        startTime: offerStartTime.toISOString(),
                        endTime: offerEndTime.toISOString(),
                        energyType: 'SOLAR',
                      },
                      buttons: [
                        { text: h(ctx, '📋 View Listing', '📋 लिस्टिंग देखो'), callbackData: 'action:show_listings' },
                        { text: h(ctx, '📊 Status', '📊 स्टेटस'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    },
                  ],
                  newState: 'GENERAL_CHAT',
                  contextUpdate: { tradingActive: true },
                };
              }
            }
          }

          // Fallback if auto-trade setup failed
          logger.warn(`Auto-trade setup failed for user ${ctx.userId}: ${setupResult.error}`);
          return {
            messages: [
              {
                text: h(ctx,
                  'Profile set up! You can create offers from the Sell tab or tell me here (e.g. "list 50 units at Rs 6").',
                  'प्रोफ़ाइल तैयार! Sell टैब से या मुझसे कहो (जैसे "50 यूनिट ₹6 पे डाल दो") और ऑफ़र बन जाएगा।'
                ),
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              },
            ],
            newState: 'GENERAL_CHAT',
            contextUpdate: { tradingActive: true },
          };
        } catch (error: any) {
          logger.error(`CONFIRM_TRADING yes handler failed: ${error.message}`);
          return {
            messages: [
              {
                text: h(ctx,
                  'Profile is set up! You can create offers by telling me (e.g. "list 50 units at Rs 6").',
                  'प्रोफ़ाइल तैयार है! मुझसे कहो (जैसे "50 यूनिट ₹6 पे डाल दो") और ऑफ़र बन जाएगा।'
                ),
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              },
            ],
            newState: 'GENERAL_CHAT',
            contextUpdate: { tradingActive: true },
          };
        }
      }

      if (isNo) {
        await prisma.user.update({
          where: { id: ctx.userId! },
          data: { profileComplete: true },
        }).catch(() => { });

        return {
          messages: [
            {
              text: h(ctx,
                'No problem. You can start selling anytime from the Sell tab or ask me here.',
                'कोई बात नहीं। कभी भी Sell टैब से या मुझसे पूछो, बेचना शुरू कर सकते हो।'
              ),
              buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
            },
          ],
          newState: 'GENERAL_CHAT',
        };
      }

      const kbAnswer = knowledgeBase.findAnswer(message, ctx.language);
      if (kbAnswer) {
        return {
          messages: [
            { text: kbAnswer },
            {
              text: h(ctx, 'Start selling your energy?', 'बिजली बेचना शुरू करें?'),
              buttons: [
                { text: h(ctx, '✅ Yes', '✅ हाँ'), callbackData: 'yes' },
                { text: h(ctx, '❌ No', '❌ नहीं'), callbackData: 'no' },
              ],
              delay: 300,
            },
          ],
        };
      }

      return {
        messages: [
          {
            text: h(ctx, 'Start selling?', 'Bechna shuru karein?'),
            buttons: [
              { text: h(ctx, '✅ Yes', '✅ Haan'), callbackData: 'yes' },
              { text: h(ctx, '❌ No', '❌ Nahi'), callbackData: 'no' },
            ],
          },
        ],
      };
    },
  },

  GENERAL_CHAT: {
    async onEnter(ctx) {
      const messages: AgentMessage[] = [];

      // Skip welcome message if there's a pending operation (user already has a prompt)
      if (ctx.pendingPurchase?.awaitingField || ctx.pendingListing?.awaitingField || ctx.pendingAutoBuy?.awaitingField) {
        return { messages: [] };
      }

      // Show smart suggestions when entering general chat
      const suggestions = getSmartSuggestions(ctx, 'GENERAL_CHAT');
      if (suggestions.length > 0) {
        messages.push({
          text: h(ctx,
            'How can I help you today?',
            'Aaj kya madad karun?'
          ),
          buttons: suggestions,
        });
      }

      return { messages };
    },
    async onMessage(ctx, message) {
      const verifiedCreds = ctx.verifiedCreds || (ctx.userId ? await getVerifiedCredentials(ctx.userId) : []);

      // --- Handle numeric input for smart suggestions ---
      const smartSuggestions = getSmartSuggestions(ctx, 'GENERAL_CHAT');
      const numericCallback = convertNumericToCallback(message, smartSuggestions);
      if (numericCallback) {
        message = numericCallback;
      }

      // --- Handle sync callbacks (cross-platform continuation) ---
      if (message.startsWith('sync:')) {
        const syncAction = message.replace('sync:', '');
        if (syncAction === 'continue') {
          // User wants to continue with synced pending operation
          if (ctx.pendingListing?.awaitingField) {
            const listing = ctx.pendingListing;
            const typeHi = listing.energyType === 'WIND' ? 'विंड' : listing.energyType === 'HYDRO' ? 'हाइड्रो' : listing.energyType ? 'सोलर' : 'सेट नहीं';
            return {
              messages: [{
                text: h(ctx,
                  `Great! Let's continue with your listing.\n\nSo far:\n• Type: ${listing.energyType || 'Not set'}\n• Quantity: ${listing.quantity ? listing.quantity + ' units' : 'Not set'}\n• Price: ${listing.pricePerKwh ? '₹' + listing.pricePerKwh + '/unit' : 'Not set'}\n\nWhat's next?`,
                  `बहुत बढ़िया! आपकी लिस्टिंग जारी रखते हैं।\n\nअब तक:\n• टाइप: ${typeHi}\n• मात्रा: ${listing.quantity ? listing.quantity + ' यूनिट' : 'सेट नहीं'}\n• दाम: ${listing.pricePerKwh ? '₹' + listing.pricePerKwh + '/unit' : 'सेट नहीं'}\n\nआगे क्या?`
                ),
              }],
            };
          } else if (ctx.pendingPurchase?.awaitingField) {
            const purchase = ctx.pendingPurchase;
            return {
              messages: [{
                text: h(ctx,
                  `Great! Let's continue with your purchase.\n\nSo far:\n• Quantity: ${purchase.quantity ? purchase.quantity + ' units' : 'Not set'}\n• Time: ${purchase.timeDesc || 'Not set'}\n\nWhat's next?`,
                  `बहुत बढ़िया! आपकी खरीदारी जारी रखते हैं।\n\nअब तक:\n• मात्रा: ${purchase.quantity ? purchase.quantity + ' यूनिट' : 'सेट नहीं'}\n• समय: ${purchase.timeDesc || 'सेट नहीं'}\n\nआगे क्या?`
                ),
              }],
            };
          }
          return {
            messages: [{ text: h(ctx, 'Nothing pending to continue. How can I help?', 'कुछ पेंडिंग नहीं है। क्या मदद करूं?') }],
          };
        } else if (syncAction === 'fresh') {
          // User wants to start fresh - clear pending operations
          return {
            messages: [{
              text: h(ctx, 'Starting fresh! How can I help you?', 'Naya shuru! Kya madad karun?'),
              buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
            }],
            contextUpdate: { pendingListing: undefined, pendingPurchase: undefined },
          };
        }
      }

      // --- Handle reset callbacks ---
      if (message.startsWith('reset:')) {
        const resetAction = message.replace('reset:', '');
        if (resetAction === 'confirm') {
          // User confirmed reset - clear everything and show fresh start
          return {
            messages: [{
              text: h(ctx,
                `🔄 *Reset Complete!*\n\nAll cleared. Let's start fresh!\n\nHow can I help you today?`,
                `🔄 *रीसेट हो गया!*\n\nसब क्लियर हो गया। नया शुरू!\n\nआज क्या मदद करूं?`
              ),
              buttons: [
                { text: '☀️ Sell Energy', callbackData: 'action:create_listing' },
                { text: '⚡ Buy Energy', callbackData: 'action:buy_energy' },
                { text: '📊 Market Prices', callbackData: 'action:market_insights' },
                { text: '📋 Dashboard', callbackData: 'action:dashboard' },
              ],
            }],
            contextUpdate: {
              pendingListing: undefined,
              pendingPurchase: undefined,
              _resetPending: undefined,
            },
          };
        } else if (resetAction === 'cancel') {
          // User cancelled reset
          return {
            messages: [{
              text: h(ctx,
                `✅ Reset cancelled. Continuing where we were.\n\nHow can I help?`,
                `✅ रीसेट रद्द। जहाँ थे वहीं से जारी।\n\nक्या मदद करूं?`
              ),
              buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
            }],
            contextUpdate: { _resetPending: undefined },
          };
        }
      }

      // --- Handle voice preference callbacks ---
      if (message.startsWith('voice:')) {
        const voiceAction = message.replace('voice:', '');
        if (voiceAction === 'enable') {
          return {
            messages: [{
              text: h(ctx,
                `🔊 *Voice Enabled!*\n\nI'll read messages aloud for you. You can say "voice off" anytime to disable.\n\nHow can I help you today?`,
                `🔊 *वॉइस चालू!*\n\nमैं संदेश बोलकर सुनाऊंगा। कभी भी "voice off" बोलो बंद करने के लिए।\n\nआज क्या मदद करूं?`
              ),
              buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
            }],
            contextUpdate: { voiceOutputEnabled: true },
            voiceOutputEnabled: true,
          };
        } else if (voiceAction === 'disable') {
          return {
            messages: [{
              text: h(ctx,
                `🔇 *Voice Disabled*\n\nNo problem! You can say "voice on" anytime to enable it.\n\nHow can I help you today?`,
                `🔇 *वॉइस बंद*\n\nकोई बात नहीं! कभी भी "voice on" बोलो चालू करने के लिए।\n\nआज क्या मदद करूं?`
              ),
              buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
            }],
            contextUpdate: { voiceOutputEnabled: false },
            voiceOutputEnabled: false,
          };
        }
      }

      // --- Handle quick action callbacks from smart suggestions ---
      if (message.startsWith('action:')) {
        const action = message.replace('action:', '');
        switch (action) {
          case 'dashboard':
            // Generate and return structured dashboard
            if (ctx.userId) {
              const dashboardData = await generateDashboardData(ctx.userId);
              if (dashboardData) {
                // Generate a brief intro text (for TTS)
                const introText = h(ctx,
                  `Here's your dashboard, ${dashboardData.userName}. Tap any field to learn more.`,
                  `${dashboardData.userName}, यह रहा आपका डैशबोर्ड। किसी भी फ़ील्ड पर टैप करके जानें।`
                );
                return {
                  messages: [{
                    text: introText,
                    dashboard: dashboardData,
                    buttons: [
                      { text: h(ctx, '💰 What is Balance?', '💰 बैलेंस क्या है?'), callbackData: 'explain:balance' },
                      { text: h(ctx, '🌟 What is Trust Score?', '🌟 ट्रस्ट स्कोर क्या है?'), callbackData: 'explain:trust' },
                      { text: h(ctx, '📈 What is Trade Limit?', '📈 ट्रेड लिमिट क्या है?'), callbackData: 'explain:tradelimit' },
                    ],
                  }],
                };
              }
            }
            message = 'show my dashboard';
            break;
          case 'create_listing':
            message = 'create a new listing';
            break;
          case 'show_listings': {
            // Directly return listings UI card
            if (ctx.userId) {
              const listingsData = await getActiveListingsData(ctx.userId);
              if (listingsData && listingsData.listings.length > 0) {
                const introText = h(ctx,
                  `Here are your active listings, ${listingsData.userName}. Total: ${listingsData.totalListed} units listed, ${listingsData.totalSold} units sold.`,
                  `${listingsData.userName}, यह रही आपकी लिस्टिंग। कुल: ${listingsData.totalListed} यूनिट लिस्टेड, ${listingsData.totalSold} यूनिट बिके।`
                );
                return {
                  messages: [{
                    text: introText,
                    listings: listingsData,
                    buttons: [
                      { text: h(ctx, '➕ Add Listing', '➕ नई लिस्टिंग'), callbackData: 'action:create_listing' },
                      { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                      { text: h(ctx, '💰 Earnings', '💰 कमाई'), callbackData: 'action:show_earnings' },
                    ],
                  }],
                };
              }
              // No listings
              return {
                messages: [{
                  text: h(ctx,
                    'You have no active listings yet. Would you like to create one?',
                    'आपकी कोई लिस्टिंग नहीं है। क्या एक बनाना चाहोगे?'
                  ),
                  buttons: [
                    { text: h(ctx, '☀️ Sell Energy', '☀️ बिजली बेचो'), callbackData: 'action:create_listing' },
                    { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                  ],
                }],
              };
            }
            message = 'show my listings';
            break;
          }
          case 'show_earnings':
            message = 'show my earnings';
            break;
          case 'buy_energy': {
            // Clear any pending purchase to avoid conflict with choose_mode handler
            ctx.pendingPurchase = undefined;
            ctx.pendingAutoBuy = undefined;

            // Credential gate: must have Consumption Profile to buy
            if (!verifiedCreds.includes('CONSUMPTION_PROFILE')) {
              return {
                messages: [
                  {
                    text: h(ctx,
                      'To buy electricity, I first need your electricity bill document. This shows your meter connection and how much power your home can use.\n\nYou can get this from your electricity company office.',
                      'बिजली खरीदने के लिए पहले आपका बिजली का कागज़ चाहिए। इससे पता चलता है कि आपके घर में कितनी बिजली आ सकती है।\n\nये आपको अपनी बिजली कंपनी से मिल जाएगा।'
                    ),
                    buttons: [
                      { text: h(ctx, '📄 Upload document', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                    ],
                  },
                ],
                newState: 'OFFER_OPTIONAL_CREDS',
                contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
              };
            }
            // Has credential - continue to buy flow
            message = 'buy energy';
            break;
          }
          case 'show_orders':
            message = 'show my orders';
            break;
          case 'browse':
            const browseTable = await getBrowseMarketTable(ctx.language);
            return {
              messages: [{
                text: browseTable,
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              }],
            };
          case 'market_insights':
            message = 'market insights';
            break;
          case 'show_balance':
            message = 'show my balance';
            break;
          case 'log_cleaning': {
            // Log panel cleaning
            if (ctx.userId) {
              const { logPanelCleaning } = await import('../auto-trade');
              await logPanelCleaning(ctx.userId);
              return {
                messages: [{
                  text: h(ctx,
                    '✅ Great! I\'ve logged your panel cleaning. I\'ll remind you again in about 30 days.',
                    '✅ बढ़िया! मैंने नोट कर लिया। 30 दिन बाद फिर याद दिलाऊंगा।'
                  ),
                  buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
                }],
              };
            }
            break;
          }
          case 'solar_tips': {
            const { getSolarTips } = await import('../auto-trade');
            const tips = getSolarTips(ctx.language === 'hi-IN');
            return {
              messages: [{
                text: h(ctx,
                  '☀️ *Solar Panel Tips*\n\n' + tips.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n'),
                  '☀️ *सोलर पैनल टिप्स*\n\n' + tips.map((t: string, i: number) => `${i + 1}. ${t}`).join('\n')
                ),
                buttons: [
                  { text: h(ctx, '✅ I cleaned them', '✅ साफ कर दिया'), callbackData: 'action:log_cleaning' },
                  { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                ],
              }],
            };
          }
        }
      }

      // --- Handle dashboard field explanations ---
      if (message.startsWith('explain:')) {
        const field = message.replace('explain:', '');
        const explanations: Record<string, { en: string; hi: string }> = {
          balance: {
            en: '💰 *Balance* is your wallet money on Oorja.\n\nWhen someone buys your energy, the payment first goes to the platform. After DISCOM confirms delivery, the platform gives the money to your wallet.\n\nYou can withdraw this anytime to your bank account.',
            hi: '💰 *बैलेंस* ऊर्जा ऐप पर आपका पैसा है।\n\nजब कोई आपकी बिजली खरीदता है, पैसा पहले प्लेटफॉर्म पे जाता है। बिजली कंपनी जब डिलीवरी पक्की करती है, तब प्लेटफॉर्म आपको पैसा दे देता है।\n\nआप इसे कभी भी अपने बैंक में निकाल सकते हो।'
          },
          trust: {
            en: '🌟 *Trust Score* shows how reliable you are.\n\nIt starts at 30% for new users. Each time you deliver energy properly, it goes up. Higher trust means you can sell more, and earn more!\n\nThe platform updates this by itself based on your deliveries.',
            hi: '🌟 *भरोसा* बताता है कि आप कितने भरोसेमंद हो।\n\nनए लोगों के लिए 30% से शुरू होता है। जब भी आप सही से बिजली देते हो, ये बढ़ता है। ज़्यादा भरोसा मतलब ज़्यादा बेच सकते हो, और ज़्यादा कमाई!\n\nप्लेटफॉर्म खुद से इसे देखता रहता है।'
          },
          tradelimit: {
            en: '📈 *Trade Limit* shows how much of your solar power you can sell.\n\nNew sellers start at 10%. As you deliver more successfully, this goes up to 90%!\n\nExample: If your panel makes 1000 units and limit is 10%, you can sell 100 units. At 50% limit, you can sell 500 units!',
            hi: '📈 *बेचने की सीमा* बताती है कि आप अपनी सोलर बिजली का कितना हिस्सा बेच सकते हो।\n\nनए लोग 10% से शुरू करते हैं। जैसे-जैसे सही से बेचते रहोगे, ये 90% तक बढ़ सकता है!\n\nमिसाल: अगर आपका पैनल 1000 यूनिट बनाता है और सीमा 10% है, तो 100 यूनिट बेच सकते हो। 50% सीमा पे 500 यूनिट बेच सकते हो!'
          },
          seller: {
            en: '📊 *Selling* shows your sales.\n\n• Listed means energy you put up for sale right now.\n• This Week shows how much you earned this week.\n• Total shows all your past sales.\n\nList more energy to earn more!',
            hi: '📊 *बिक्री* आपकी बिक्री दिखाता है।\n\n• लिस्टेड मतलब अभी बेचने के लिए रखी बिजली।\n• इस हफ्ते, यानी इस हफ्ते कितना कमाया।\n• कुल, मतलब अब तक की पूरी बिक्री।\n\nज़्यादा बिजली रखो, ज़्यादा कमाओ!'
          },
          buyer: {
            en: '🔋 *Buying* shows your purchases.\n\n• Orders means how many times you bought energy.\n• Units means how much energy you bought.\n• Spent means how much you paid.\n\nBuying from neighbors is often 20-40% cheaper than company rates!',
            hi: '🔋 *खरीदारी* आपकी खरीदारी दिखाती है।\n\n• ऑर्डर, यानी कितनी बार बिजली खरीदी।\n• यूनिट, यानी कितनी बिजली खरीदी।\n• खर्च, यानी कितना पैसा दिया।\n\nपड़ोसियों से बिजली लेना अक्सर कंपनी से 20-40% सस्ता होता है!'
          },
        };
        const explanation = explanations[field];
        if (explanation) {
          return {
            messages: [{
              text: h(ctx, explanation.en, explanation.hi),
              buttons: [
                { text: h(ctx, '📋 Back to Dashboard', '📋 डैशबोर्ड देखो'), callbackData: 'action:dashboard' },
              ],
            }],
          };
        }
      }

      // --- Handle universal command callbacks ---
      if (message.startsWith('cmd:')) {
        const cmd = message.replace('cmd:', '');
        return handleUniversalCommand(cmd, ctx, 'GENERAL_CHAT', ctx._sessionId || '') || { messages: [] };
      }

      // --- Build user profile context so LLM knows credentials are already verified ---
      let userProfileContext = '';
      if (verifiedCreds.length > 0) {
        const DB_TYPE_TO_DISPLAY: Record<string, string> = {
          UTILITY_CUSTOMER: 'Utility Customer',
          GENERATION_PROFILE: 'Generation Profile (Solar)',
          CONSUMPTION_PROFILE: 'Consumption Profile',
          STORAGE_PROFILE: 'Storage Profile (Battery)',
          PROGRAM_ENROLLMENT: 'Program Enrollment',
        };
        const credNames = verifiedCreds.map(c => DB_TYPE_TO_DISPLAY[c] || c).join(', ');
        userProfileContext = `User profile: Already onboarded and verified. Verified credentials: ${credNames}. Do NOT ask the user to upload or provide any credentials — they have already completed onboarding.`;
      }

      // --- Handle pending listing flow (multi-turn detail gathering) ---
      if (ctx.pendingListing?.awaitingField) {
        const result = await handlePendingListingInput(ctx, message);
        if (result) return result;
      }

      // --- Handle pending purchase flow (multi-turn detail gathering) ---
      if (ctx.pendingPurchase?.awaitingField) {
        const result = await handlePendingPurchaseInput(ctx, message);
        if (result) return result;
      }

      // --- Handle pending auto-buy setup flow ---
      if (ctx.pendingAutoBuy?.awaitingField) {
        const result = await handlePendingAutoBuyInput(ctx, message);
        if (result) return result;
      }

      // --- Step 1: Classify intent with LLM ---
      const intent = await classifyIntent(message);
      let dataContext = '';
      let fallbackText = '';

      // --- Step 2: Execute action and gather data ---
      if (ctx.userId && intent) {
        switch (intent.intent) {
          case 'show_listings': {
            const listingsData = await getActiveListingsData(ctx.userId);
            if (listingsData && listingsData.listings.length > 0) {
              const introText = h(ctx,
                `Here are your active listings, ${listingsData.userName}. Total: ${listingsData.totalListed} units listed, ${listingsData.totalSold} units sold.`,
                `${listingsData.userName}, यह रही आपकी लिस्टिंग। कुल: ${listingsData.totalListed} यूनिट लिस्टेड, ${listingsData.totalSold} यूनिट बिके।`
              );
              return {
                messages: [{
                  text: introText,
                  listings: listingsData,
                  buttons: [
                    { text: h(ctx, '➕ Add Listing', '➕ नई लिस्टिंग'), callbackData: 'action:create_listing' },
                    { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                    { text: h(ctx, '💰 Earnings', '💰 कमाई'), callbackData: 'action:show_earnings' },
                  ],
                }],
              };
            }
            // No listings - prompt to create
            return {
              messages: [{
                text: h(ctx,
                  'You have no active listings yet. Would you like to create one?',
                  'आपकी कोई लिस्टिंग नहीं है। क्या एक बनाना चाहोगे?'
                ),
                buttons: [
                  { text: h(ctx, '☀️ Sell Energy', '☀️ बिजली बेचो'), callbackData: 'action:create_listing' },
                  { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                ],
              }],
            };
          }

          case 'show_earnings': {
            const period = parseTimePeriod(message);
            if (period) {
              // Period-specific query - use text fallback
              dataContext = await mockTradingAgent.getSalesByPeriod(ctx.userId, period.startDate, period.endDate, period.label, 'en');
              fallbackText = dataContext;
              break;
            }
            // Get structured earnings data for card UI
            const earningsData = await mockTradingAgent.getEarningsData(ctx.userId);
            if (earningsData) {
              return {
                messages: [{
                  text: h(ctx,
                    earningsData.hasStartedSelling
                      ? `Here's your earnings summary, ${earningsData.userName}!`
                      : `${earningsData.userName}, start selling to see your earnings here!`,
                    earningsData.hasStartedSelling
                      ? `${earningsData.userName}, यह रही आपकी कमाई!`
                      : `${earningsData.userName}, बेचना शुरू करो और यहाँ कमाई देखो!`
                  ),
                  earnings: earningsData,
                  buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
                }],
              };
            }
            // Fallback to text
            dataContext = await mockTradingAgent.getEarningsSummary(ctx.userId, 'en');
            fallbackText = dataContext;
            break;
          }

          case 'show_sales': {
            const period = parseTimePeriod(message) || (intent.params?.time_period ? parseTimePeriod(intent.params.time_period) : null);
            if (period) {
              dataContext = await mockTradingAgent.getSalesByPeriod(ctx.userId, period.startDate, period.endDate, period.label, 'en');
            } else {
              dataContext = await mockTradingAgent.getEarningsSummary(ctx.userId, 'en');
            }
            fallbackText = dataContext;
            break;
          }

          case 'show_balance': {
            const user = await prisma.user.findUnique({
              where: { id: ctx.userId },
              select: { balance: true },
            });
            if (user) {
              dataContext = `Wallet balance: Rs ${user.balance.toFixed(2)}`;
              fallbackText = h(ctx, dataContext, `Aapka wallet balance: Rs ${user.balance.toFixed(2)}`);
            }
            break;
          }

          case 'show_orders': {
            dataContext = await mockTradingAgent.getOrdersSummary(ctx.userId, 'en');
            fallbackText = ctx.language === 'hi-IN'
              ? await mockTradingAgent.getOrdersSummary(ctx.userId, 'hi-IN')
              : dataContext;
            break;
          }

          case 'market_insights': {
            // Get personalized market data
            const insights = await getMarketInsights(ctx.language, ctx.userId);
            return {
              messages: [{
                text: insights,
                buttons: [
                  { text: h(ctx, '⚡ Buy Energy', '⚡ Energy Kharido'), callbackData: 'action:buy_energy' },
                  { text: h(ctx, '➕ Create Listing', '➕ Listing Banao'), callbackData: 'action:create_listing' },
                ],
              }],
            };
          }

          case 'show_dashboard': {
            const dashboardData = await generateDashboardData(ctx.userId);
            if (dashboardData) {
              const introText = h(ctx,
                `Here's your dashboard, ${dashboardData.userName}. Tap any field to learn more.`,
                `${dashboardData.userName}, यह रहा आपका डैशबोर्ड। किसी भी फ़ील्ड पर टैप करके जानें।`
              );
              return {
                messages: [{
                  text: introText,
                  dashboard: dashboardData,
                  buttons: [
                    { text: h(ctx, '💰 What is Balance?', '💰 बैलेंस क्या है?'), callbackData: 'explain:balance' },
                    { text: h(ctx, '🌟 What is Trust Score?', '🌟 ट्रस्ट स्कोर क्या है?'), callbackData: 'explain:trust' },
                    { text: h(ctx, '📈 What is Trade Limit?', '📈 ट्रेड लिमिट क्या है?'), callbackData: 'explain:tradelimit' },
                  ],
                }],
              };
            }
            // Fallback to text dashboard
            const dashboard = await generateDashboard(ctx.userId, ctx.language);
            return {
              messages: [{
                text: dashboard,
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              }],
            };
          }

          case 'track_activity': {
            const activitySummary = await getActivitySummary(ctx.userId, ctx.language);
            return {
              messages: [{
                text: activitySummary,
                buttons: [
                  { text: h(ctx, '📦 View Orders', '📦 Orders Dekho'), callbackData: 'action:show_orders' },
                  { text: h(ctx, '💰 View Earnings', '💰 Kamai Dekho'), callbackData: 'action:show_earnings' },
                  { text: h(ctx, '💸 Withdraw', '💸 Nikalo'), callbackData: 'action:withdraw' },
                ],
              }],
            };
          }

          case 'create_listing': {
            // --- Credential gate: must have Generation Profile to sell ---
            if (!verifiedCreds.includes('GENERATION_PROFILE')) {
              return {
                messages: [
                  {
                    text: h(ctx,
                      'To sell energy, I need your solar generation credential first. This proves your solar panel capacity.\n\nYou can get it from your DISCOM or download a sample from the credential portal.',
                      'बिजली बेचने के लिए पहले आपका सोलर जनरेशन का क्रेडेंशियल चाहिए। यह आपके सोलर पैनल की क्षमता प्रमाणित करता है।\n\nयह आपको अपनी DISCOM या क्रेडेंशियल पोर्टल से मिल जाएगा।'
                    ),
                    buttons: [
                      { text: h(ctx, '📄 Upload credential', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                    ],
                  },
                ],
                newState: 'OFFER_OPTIONAL_CREDS',
                contextUpdate: { expectedCredType: 'GenerationProfileCredential' },
              };
            }

            // --- Gather missing details interactively ---
            const pending: PendingListing = {
              pricePerKwh: intent.params?.price_per_kwh,
              quantity: intent.params?.quantity_kwh,
              timeDesc: intent.params?.time_description,
            };

            const askResult = askNextListingDetail(ctx, pending);
            if (askResult) return askResult;

            // All details provided — create the listing
            return await createListingFromPending(ctx, pending);
          }

          case 'buy_energy': {
            // --- Credential gate: must have Consumption Profile to buy ---
            if (!verifiedCreds.includes('CONSUMPTION_PROFILE')) {
              return {
                messages: [
                  {
                    text: h(ctx,
                      'To buy electricity, I first need your electricity bill document. This shows your meter connection and how much power your home can use.\n\nYou can get this from your electricity company office.',
                      'बिजली खरीदने के लिए पहले आपका बिजली का कागज़ चाहिए। इससे पता चलता है कि आपके घर में कितनी बिजली आ सकती है।\n\nये आपको अपनी बिजली कंपनी से मिल जाएगा।'
                    ),
                    buttons: [
                      { text: h(ctx, '📄 Upload document', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                    ],
                  },
                ],
                newState: 'OFFER_OPTIONAL_CREDS',
                contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
              };
            }

            // --- Gather missing details interactively ---
            const pendingBuy: PendingPurchase = {
              quantity: intent.params?.quantity_kwh,
              maxPrice: intent.params?.max_price,
              timeDesc: intent.params?.time_description,
            };

            const askBuyResult = await askNextPurchaseDetail(ctx, pendingBuy);
            if (askBuyResult) return askBuyResult;

            // All details provided — discover best offer and show to user
            return await discoverAndShowOffer(ctx, pendingBuy);
          }

          case 'change_language': {
            return {
              messages: [{
                text: h(ctx, 'Choose your language:', 'अपनी भाषा चुनें:'),
                buttons: LANG_BUTTONS,
              }],
            };
          }

          case 'discom_rates': {
            const name = ctx.discom || 'DISCOM';
            dataContext = `${name} electricity rates: Normal slab Rs 5.50/unit, Peak hours (6PM-10PM) Rs 7.50/unit. P2P trading rate on Oorja: Rs 6.00/unit — cheaper than peak DISCOM rates, better than net metering (Rs 2/unit).`;
            fallbackText = dataContext;
            break;
          }

          case 'trading_tips': {
            dataContext = 'Trading tips: 1) Trade regularly — more trades = better trust score = more buyers. 2) Keep solar panels clean for maximum generation. 3) List energy during peak hours (6PM-10PM) for higher demand and prices. 4) Price slightly below DISCOM rates (Rs 5-7/unit) for faster sales. 5) Upload all credentials for a verified profile that attracts more buyers.';
            fallbackText = dataContext;
            break;
          }

          case 'projected_earnings': {
            // Get user's production capacity and current trust score
            const projUser = await prisma.user.findUnique({
              where: { id: ctx.userId! },
              select: { productionCapacity: true, trustScore: true, name: true },
            });

            const capacity = projUser?.productionCapacity || ctx.productionCapacity;
            const trustScore = projUser?.trustScore ?? 0.3;
            const currentLimit = calculateAllowedLimit(trustScore);
            const projectionDays = intent.params?.projection_days || 30; // Default 1 month

            if (!capacity) {
              return {
                messages: [{
                  text: h(ctx,
                    'I need your solar generation credential to calculate projected earnings. Please upload it first.',
                    'कमाई का अनुमान लगाने के लिए पहले आपका सोलर जनरेशन क्रेडेंशियल चाहिए।'
                  ),
                  buttons: [
                    { text: h(ctx, '📄 Upload credential', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                  ],
                }],
              };
            }

            // Calculate projections
            const monthlyCapacity = capacity; // Already monthly
            const daysInMonth = 30;
            const dailyCapacity = monthlyCapacity / daysInMonth;

            // Current trade limit vs future potential (assuming trust improves)
            const currentTradeableDaily = dailyCapacity * (currentLimit / 100);
            const futureTradeableDaily = dailyCapacity * 0.8; // Assume 80% limit with good trading

            // Price assumptions (Rs per unit)
            const lowPrice = 6;
            const highPrice = 8;

            // Calculate earnings for the projection period
            const currentMinEarnings = roundTo500(currentTradeableDaily * lowPrice * projectionDays);
            const currentMaxEarnings = roundTo500(currentTradeableDaily * highPrice * projectionDays);
            const futureMinEarnings = roundTo500(futureTradeableDaily * lowPrice * projectionDays);
            const futureMaxEarnings = roundTo500(futureTradeableDaily * highPrice * projectionDays);

            // Format period for display
            let periodEn = `${projectionDays} days`;
            let periodHi = `${projectionDays} दिन`;
            if (projectionDays === 30) { periodEn = '1 month'; periodHi = '1 महीना'; }
            else if (projectionDays === 60) { periodEn = '2 months'; periodHi = '2 महीने'; }
            else if (projectionDays === 90) { periodEn = '3 months'; periodHi = '3 महीने'; }
            else if (projectionDays === 180) { periodEn = '6 months'; periodHi = '6 महीने'; }
            else if (projectionDays === 365) { periodEn = '1 year'; periodHi = '1 साल'; }

            return {
              messages: [{
                text: h(ctx,
                  `📊 *Projected Earnings for ${periodEn}*\n\n` +
                  `Your capacity: ${capacity} units per month.\n` +
                  `Current trade limit: ${currentLimit}%.\n\n` +
                  `💰 *At current level:*\n` +
                  `₹${currentMinEarnings.toLocaleString('en-IN')} to ₹${currentMaxEarnings.toLocaleString('en-IN')}\n\n` +
                  `🚀 *With consistent trading (80% limit):*\n` +
                  `₹${futureMinEarnings.toLocaleString('en-IN')} to ₹${futureMaxEarnings.toLocaleString('en-IN')}\n\n` +
                  `💡 Trade regularly to increase your limit and maximize earnings!`,
                  `📊 *${periodHi} की अनुमानित कमाई*\n\n` +
                  `आपकी क्षमता: ${capacity} यूनिट प्रति माह।\n` +
                  `अभी की सीमा: ${currentLimit}%।\n\n` +
                  `💰 *अभी के लेवल पर:*\n` +
                  `₹${currentMinEarnings.toLocaleString('en-IN')} से ₹${currentMaxEarnings.toLocaleString('en-IN')}\n\n` +
                  `🚀 *नियमित ट्रेडिंग से (80% सीमा पर):*\n` +
                  `₹${futureMinEarnings.toLocaleString('en-IN')} से ₹${futureMaxEarnings.toLocaleString('en-IN')}\n\n` +
                  `💡 नियमित बेचते रहो, सीमा बढ़ेगी और कमाई भी!`
                ),
                buttons: [
                  { text: h(ctx, '☀️ Start Selling', '☀️ बेचना शुरू करो'), callbackData: 'action:create_listing' },
                  { text: h(ctx, '🤖 Auto-Sell', '🤖 ऑटो-सेल'), callbackData: 'action:setup_auto_sell' },
                  { text: h(ctx, '📊 Dashboard', '📊 डैशबोर्ड'), callbackData: 'action:dashboard' },
                ],
              }],
            };
          }

          // ============ Auto-Trade Intents ============

          case 'setup_auto_sell': {
            // Clear any pending listing to avoid conflict with choose_mode handler
            ctx.pendingListing = undefined;
            // Credential gate
            if (!verifiedCreds.includes('GENERATION_PROFILE')) {
              return {
                messages: [{
                  text: h(ctx,
                    'To set up auto-selling, I first need your solar generation credential.',
                    'ऑटो-सेल सेटअप करने के लिए पहले आपका सोलर जनरेशन क्रेडेंशियल चाहिए।'
                  ),
                  buttons: [
                    { text: h(ctx, '📄 Upload credential', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                  ],
                }],
                newState: 'OFFER_OPTIONAL_CREDS',
                contextUpdate: { expectedCredType: 'GenerationProfileCredential', pendingListing: undefined },
              };
            }

            // Auto-detect capacity from user's credentials
            const userData = await prisma.user.findUnique({
              where: { id: ctx.userId! },
              include: { provider: true },
            });

            // Get capacity from: meter verified > user declared > provider credential > default
            const detectedCapacity = userData?.meterVerifiedCapacity
              || userData?.productionCapacity
              || userData?.provider?.capacityKW
              || 10; // Default 10 units if nothing found

            // Smart price: ₹6/unit (between DISCOM peak ₹7.50 and net metering ₹2)
            const smartPrice = 6;

            // Use user-provided values if available, otherwise use detected/smart defaults
            const capacity = intent.params?.capacity_kwh || detectedCapacity;
            const price = intent.params?.price_per_kwh || smartPrice;

            // Setup auto-trade and run immediately - no questions asked!
            const { setupSellerAutoTrade, runSingleSellerAutoTrade } = await import('../auto-trade');
            const setupResult = await setupSellerAutoTrade(ctx.userId!, capacity, price);

            if (setupResult.success) {
              // Run the first auto-trade immediately
              const tradeResult = await runSingleSellerAutoTrade(ctx.userId!);

              if (tradeResult && (tradeResult.status === 'success' || tradeResult.status === 'warning_oversell')) {
                const weatherPercent = Math.round(tradeResult.weatherMultiplier * 100);
                const listedQty = tradeResult.listedQuantity.toFixed(1);
                const effectiveDaily2 = tradeResult.effectiveCapacity;
                const effectiveMonthly2 = effectiveDaily2 * 30;

                // Get trade limit for explanation from trust score
                const userForLimit = await prisma.user.findUnique({
                  where: { id: ctx.userId! },
                  select: { trustScore: true },
                });
                const tradeLimitPct = calculateAllowedLimit(userForLimit?.trustScore ?? 0.3);

                let warningText = '';
                if (tradeResult.status === 'warning_oversell' && tradeResult.warningMessage) {
                  warningText = '\n\n⚠️ ' + localizeTradeWarning(ctx, tradeResult);
                }

                return {
                  messages: [
                    // First message: Weather and trade limit explanation
                    {
                      text: h(ctx,
                        `🌤️ Tomorrow's weather forecast shows *${weatherPercent}%* solar efficiency. Based on this and your *${tradeLimitPct}%* trade limit, I'm placing an offer for *${listedQty} units* at ₹${price}/unit.`,
                        `🌤️ कल के मौसम में *${weatherPercent}%* सोलर एफिशिएंसी है। इसके और आपकी *${tradeLimitPct}%* ट्रेड लिमिट के हिसाब से, मैं *${listedQty} यूनिट* ₹${price}/यूनिट पर ऑफ़र लगा रहा हूं।`
                      ),
                    },
                    // Second message: Confirmation with buttons
                    {
                      text: h(ctx,
                        `✅ Auto-sell activated!\n\n📊 Tradeable capacity: ~${effectiveMonthly2} units/month (~${effectiveDaily2} units/day)\n\nEvery day at 6 AM, I'll check the next day's weather and create listings automatically.${warningText}`,
                        `✅ ऑटो-सेल चालू!\n\n📊 बेचने योग्य क्षमता: ~${effectiveMonthly2} यूनिट/माह (~${effectiveDaily2} यूनिट/दिन)\n\nरोज़ सुबह 6 बजे अगले दिन का मौसम देखकर लिस्टिंग करूंगा।${warningText}`
                      ),
                      buttons: [
                        { text: h(ctx, '📋 View Listing', '📋 लिस्टिंग देखो'), callbackData: 'action:show_listings' },
                        { text: h(ctx, '📊 Status', '📊 स्टेटस'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    },
                  ],
                  contextUpdate: { pendingListing: undefined },
                };
              } else if (tradeResult && tradeResult.status === 'skipped') {
                const effectiveDailySkip = tradeResult.effectiveCapacity;
                const effectiveMonthlySkip = effectiveDailySkip * 30;
                const skipMsg = tradeResult.warningMessage
                  ? localizeTradeWarning(ctx, tradeResult)
                  : h(ctx, 'No listing created right now.', 'अभी कोई लिस्टिंग नहीं बनी।');
                return {
                  messages: [{
                    text: h(ctx,
                      `✅ Auto-sell enabled!\n\n⚠️ ${skipMsg}\n\nTradeable capacity: ~${effectiveMonthlySkip} units/month (~${effectiveDailySkip} units/day) at ₹${price}/unit\n\nEvery day at 6 AM, I'll check the weather and create listings when conditions are right.`,
                      `✅ ऑटो-सेल चालू!\n\n⚠️ ${skipMsg}\n\nबेचने योग्य क्षमता: ~${effectiveMonthlySkip} यूनिट/माह (~${effectiveDailySkip} यूनिट/दिन), दाम: ₹${price}/यूनिट\n\nरोज़ सुबह 6 बजे मौसम देखकर लिस्टिंग करूंगा।`
                    ),
                    buttons: [
                      { text: h(ctx, '📊 View Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                      { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                    ],
                  }],
                  contextUpdate: { pendingListing: undefined },
                };
              }

              // Error or no result - still enabled but first trade failed
              // Estimate tradeable capacity using trade limit (weather unknown)
              const userForLimitErr = await prisma.user.findUnique({
                where: { id: ctx.userId! },
                select: { trustScore: true },
              });
              const tradeLimitErr = calculateAllowedLimit(userForLimitErr?.trustScore ?? 0.3);
              const estDailyErr = Math.floor((tradeLimitErr / 100) * (capacity / 30));
              const estMonthlyErr = estDailyErr * 30;
              return {
                messages: [{
                  text: h(ctx,
                    `✅ Auto-sell enabled!\n\nCouldn't create today's listing (${tradeResult?.error || 'weather data unavailable'}), but I'll try again at 6 AM tomorrow.\n\nTradeable capacity: ~${estMonthlyErr} units/month (~${estDailyErr} units/day) at ₹${price}/unit`,
                    `✅ ऑटो-सेल चालू!\n\nआज की लिस्टिंग नहीं बन पाई (${tradeResult?.error || 'मौसम डेटा नहीं मिला'}), लेकिन कल सुबह 6 बजे कोशिश करूंगा।\n\nबेचने योग्य क्षमता: ~${estMonthlyErr} यूनिट/माह (~${estDailyErr} यूनिट/दिन), दाम: ₹${price}/यूनिट`
                  ),
                  buttons: [
                    { text: h(ctx, '📊 View Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                    { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                  ],
                }],
                contextUpdate: { pendingListing: undefined },
              };
            }
            return {
              messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
              contextUpdate: { pendingListing: undefined },
            };
          }

          case 'setup_auto_buy': {
            // Clear any pending purchase to avoid conflict
            ctx.pendingPurchase = undefined;
            // Credential gate
            if (!verifiedCreds.includes('CONSUMPTION_PROFILE')) {
              return {
                messages: [{
                  text: h(ctx,
                    'To set up auto-buying, I first need your consumption credential.',
                    'ऑटो-बाय सेटअप करने के लिए पहले आपका खपत क्रेडेंशियल चाहिए।'
                  ),
                  buttons: [
                    { text: h(ctx, '📄 Upload credential', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                  ],
                }],
                newState: 'OFFER_OPTIONAL_CREDS',
                contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
              };
            }

            const qty = intent.params?.quantity_kwh;
            const maxPrice = intent.params?.max_price;

            if (qty && maxPrice) {
              const { setupBuyerAutoTrade, runSingleBuyerAutoTrade, getBuyAdvice } = await import('../auto-trade');
              const setupResult = await setupBuyerAutoTrade(ctx.userId!, qty, maxPrice);

              if (setupResult.success) {
                // Try to buy immediately
                const buyResult = await runSingleBuyerAutoTrade(ctx.userId!);
                const advice = await getBuyAdvice(ctx.userId!, ctx.language === 'hi-IN');

                if (buyResult && buyResult.status === 'success') {
                  return {
                    messages: [{
                      text: h(ctx,
                        `✅ Auto-buy activated!\n\n🛒 Found a deal right now! Bought *${buyResult.quantityBought} units* at ₹${buyResult.pricePerUnit}/unit.\nTotal: ₹${buyResult.totalSpent.toFixed(0)}\n\nEvery day at 6:30 AM, I'll find the best deals and buy ${qty} units for you at ≤₹${maxPrice}/unit.\n\n${advice.advice}`,
                        `✅ ऑटो-बाय चालू!\n\n🛒 अभी एक डील मिल गई! *${buyResult.quantityBought} यूनिट* ₹${buyResult.pricePerUnit}/यूनिट पर खरीद लिया।\nकुल: ₹${buyResult.totalSpent.toFixed(0)}\n\nरोज़ सुबह 6:30 बजे, मैं ${qty} यूनिट ≤₹${maxPrice}/यूनिट पर खरीदूंगा।\n\n${advice.advice}`
                      ),
                      buttons: [
                        { text: h(ctx, '📋 View Orders', '📋 ऑर्डर देखो'), callbackData: 'action:show_orders' },
                        { text: h(ctx, '📊 Auto-Trade Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    }],
                  };
                } else if (buyResult && buyResult.status === 'no_deals') {
                  return {
                    messages: [{
                      text: h(ctx,
                        `✅ Auto-buy enabled!\n\n🔍 No deals available right now at ≤₹${maxPrice}/unit. I'll keep looking!\n\nEvery day at 6:30 AM, I'll find the best deals and buy ${qty} units for you.\n\n${advice.advice}`,
                        `✅ ऑटो-बाय चालू!\n\n🔍 अभी ≤₹${maxPrice}/यूनिट पर कोई डील नहीं है। देखता रहूंगा!\n\nरोज़ सुबह 6:30 बजे, मैं ${qty} यूनिट खरीदूंगा।\n\n${advice.advice}`
                      ),
                      buttons: [
                        { text: h(ctx, '📊 View Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop Auto-Trade', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    }],
                  };
                } else if (buyResult && buyResult.status === 'price_too_high') {
                  return {
                    messages: [{
                      text: h(ctx,
                        `✅ Auto-buy enabled!\n\n💰 Current prices are above your ₹${maxPrice}/unit limit (cheapest: ₹${buyResult.pricePerUnit}/unit). I'll wait for better prices!\n\nEvery day at 6:30 AM, I'll check for deals.\n\n${advice.advice}`,
                        `✅ ऑटो-बाय चालू!\n\n💰 अभी दाम आपकी ₹${maxPrice}/यूनिट सीमा से ज्यादा हैं (सबसे सस्ता: ₹${buyResult.pricePerUnit}/यूनिट)। बेहतर दाम का इंतज़ार करूंगा!\n\nरोज़ सुबह 6:30 बजे चेक करूंगा।\n\n${advice.advice}`
                      ),
                      buttons: [
                        { text: h(ctx, '📊 View Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                        { text: h(ctx, '🛑 Stop Auto-Trade', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                      ],
                    }],
                  };
                }

                // Fallback - enabled but couldn't check right now
                return {
                  messages: [{
                    text: h(ctx,
                      `✅ Auto-buy enabled!\n\nEvery day at 6:30 AM, I'll find the best deals and buy ${qty} units for you at ≤₹${maxPrice}/unit.\n\n${advice.advice}`,
                      `✅ ऑटो-बाय चालू!\n\nरोज़ सुबह 6:30 बजे, मैं ${qty} यूनिट ≤₹${maxPrice}/यूनिट पर खरीदूंगा।\n\n${advice.advice}`
                    ),
                    buttons: [
                      { text: h(ctx, '📊 View Status', '📊 स्टेटस देखो'), callbackData: 'action:check_auto_trade' },
                      { text: h(ctx, '🛑 Stop Auto-Trade', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                    ],
                  }],
                };
              }
              return {
                messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }],
              };
            }

            // Start step-by-step flow with buttons based on sanctioned load
            const userData = await prisma.user.findUnique({
              where: { id: ctx.userId! },
              select: { sanctionedLoadKW: true },
            });

            // Calculate suggested quantities based on sanctioned load
            const sanctionedKW = userData?.sanctionedLoadKW || 5; // Default 5 kW
            const dailyUsageEstimate = Math.round(sanctionedKW * 4); // ~4 hours peak usage estimate
            const suggestedQuantities = [
              Math.round(dailyUsageEstimate * 0.5), // Half usage
              dailyUsageEstimate,                    // Full estimate
              Math.round(dailyUsageEstimate * 1.5), // 1.5x
              Math.round(dailyUsageEstimate * 2),   // Double
            ].filter(q => q > 0);

            // Ensure reasonable defaults if calculation gives odd numbers
            const quantities = suggestedQuantities.length >= 3
              ? suggestedQuantities.slice(0, 4)
              : [10, 20, 30, 50];

            const defaultQty = quantities.length > 1 ? quantities[1] : 20;
            return {
              messages: [{
                text: h(ctx,
                  `🤖 *Set Up Auto-Buy*\n\nI'll buy energy for you at the best prices!\n\nBased on your ${sanctionedKW} kW connection, how many units do you need daily?`,
                  `🤖 *ऑटो-बाय सेटअप*\n\nमैं आपके लिए सबसे सस्ते दाम पर बिजली खरीदूंगा!\n\nआपके ${sanctionedKW} kW कनेक्शन के हिसाब से, रोज़ कितनी यूनिट चाहिए?`
                ),
                slider: {
                  type: 'quantity',
                  min: 5,
                  max: Math.max(100, sanctionedKW * 10),
                  step: 5,
                  defaultValue: defaultQty,
                  unit: 'units',
                  callbackPrefix: 'autobuy_qty',
                },
              }],
              contextUpdate: {
                pendingAutoBuy: { awaitingField: 'quantity', suggestedQuantities: quantities },
              },
            };
          }

          case 'check_auto_trade': {
            const { getSellerAutoTradeStatus, getBuyerAutoTradeStatus } = await import('../auto-trade');
            const sellerStatus = await getSellerAutoTradeStatus(ctx.userId!);
            const buyerStatus = await getBuyerAutoTradeStatus(ctx.userId!);

            const hasAnyConfig = sellerStatus.enabled || buyerStatus.enabled;

            if (!hasAnyConfig) {
              // No auto-trade configured - show setup options
              return {
                messages: [{
                  text: h(ctx,
                    'No auto-trade configured yet. Would you like to set it up?',
                    'अभी कोई ऑटो-ट्रेड सेटअप नहीं है। सेटअप करना है?'
                  ),
                  buttons: [
                    { text: h(ctx, '🔋 Setup Auto-Sell', '🔋 ऑटो-सेल सेटअप'), callbackData: 'action:setup_auto_sell' },
                    { text: h(ctx, '🛒 Setup Auto-Buy', '🛒 ऑटो-बाय सेटअप'), callbackData: 'action:setup_auto_buy' },
                  ],
                }],
              };
            }

            // Build structured auto-trade status card
            const autoTradeStatus: NonNullable<AgentMessage['autoTradeStatus']> = {};

            if (sellerStatus.enabled && sellerStatus.config) {
              autoTradeStatus.seller = {
                enabled: true,
                capacityKwh: sellerStatus.config.capacityKwh,
                pricePerKwh: sellerStatus.config.pricePerKwh,
                energyType: sellerStatus.config.energyType,
                lastRun: sellerStatus.lastExecution ? {
                  executedAt: sellerStatus.lastExecution.executedAt.toISOString(),
                  status: sellerStatus.lastExecution.status,
                  listedQuantity: sellerStatus.lastExecution.listedQuantity,
                  weatherMultiplier: sellerStatus.lastExecution.weatherMultiplier,
                } : undefined,
              };
            }

            if (buyerStatus.enabled && buyerStatus.config) {
              autoTradeStatus.buyer = {
                enabled: true,
                targetQuantity: buyerStatus.config.targetQuantity,
                maxPrice: buyerStatus.config.maxPrice,
                preferredTime: buyerStatus.config.preferredTime,
                lastRun: buyerStatus.lastExecution ? {
                  executedAt: buyerStatus.lastExecution.executedAt.toISOString(),
                  status: buyerStatus.lastExecution.status,
                  quantityBought: buyerStatus.lastExecution.quantityBought,
                  pricePerUnit: buyerStatus.lastExecution.pricePerUnit,
                  totalSpent: buyerStatus.lastExecution.totalSpent,
                  error: buyerStatus.lastExecution.error || undefined,
                } : undefined,
              };
            }

            return {
              messages: [{
                text: h(ctx,
                  'Here\'s your auto-trade status:',
                  'आपका ऑटो-ट्रेड स्टेटस:'
                ),
                autoTradeStatus,
                buttons: [
                  { text: h(ctx, '🔋 Setup Auto-Sell', '🔋 ऑटो-सेल सेटअप'), callbackData: 'action:setup_auto_sell' },
                  { text: h(ctx, '🛒 Setup Auto-Buy', '🛒 ऑटो-बाय सेटअप'), callbackData: 'action:setup_auto_buy' },
                  { text: h(ctx, '🛑 Stop Auto-Trade', '🛑 बंद करो'), callbackData: 'action:stop_auto_trade' },
                ],
              }],
            };
          }

          case 'stop_auto_trade': {
            const { disableSellerAutoTrade, disableBuyerAutoTrade } = await import('../auto-trade');
            await disableSellerAutoTrade(ctx.userId!);
            await disableBuyerAutoTrade(ctx.userId!);

            return {
              messages: [{
                text: h(ctx,
                  '🛑 Auto-trade disabled. I won\'t trade automatically anymore.',
                  '🛑 ऑटो-ट्रेड बंद हो गया। अब मैं खुद से ट्रेड नहीं करूंगा।'
                ),
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              }],
            };
          }

          case 'solar_advice': {
            const { getUserSolarAdvisory, getSolarTips } = await import('../auto-trade');
            const { classifyWeatherCondition } = await import('./llm-fallback');

            // Use LLM to classify weather condition (handles typos, Hindi variations, etc.)
            const weatherCondition = await classifyWeatherCondition(message);
            logger.debug(`Weather condition classified: ${weatherCondition} for message: "${message.substring(0, 50)}..."`);

            if (weatherCondition === 'dust_storm') {
              // Give specific dust storm advice - HIGH PRIORITY
              return {
                messages: [{
                  text: h(ctx,
                    '🌪️ *Dust Storm Alert - Clean Your Panels!*\n\n' +
                    'Dust storms deposit a layer of fine particles that can reduce output by 25 to 40 percent.\n\n' +
                    '⚠️ *Immediate Action Needed:*\n' +
                    '1. Wait for winds to settle completely.\n' +
                    '2. Gently rinse panels with water first.\n' +
                    '3. Use soft cloth or sponge. No abrasive materials.\n' +
                    '4. Clean early morning or evening when panels are cool.\n\n' +
                    '💡 After dust storm, cleaning can recover 25 percent or more of lost power.',
                    '🌪️ *आंधी की चेतावनी - पैनल साफ करो!*\n\n' +
                    'आंधी में महीन धूल जम जाती है, जो बिजली 25 से 40 प्रतिशत कम कर सकती है।\n\n' +
                    '⚠️ *तुरंत करो:*\n' +
                    '1. पहले हवा रुकने दो।\n' +
                    '2. पहले पानी से धीरे-धीरे धोओ।\n' +
                    '3. मुलायम कपड़ा या स्पंज इस्तेमाल करो। खुरदरा नहीं।\n' +
                    '4. सुबह या शाम साफ करो। पैनल ठंडे होने चाहिए।\n\n' +
                    '💡 आंधी के बाद सफाई से 25 प्रतिशत से ज़्यादा बिजली वापस मिलती है।'
                  ),
                  buttons: [
                    { text: h(ctx, '✅ I cleaned them', '✅ साफ कर दिया'), callbackData: 'action:log_cleaning' },
                    { text: h(ctx, '📋 More tips', '📋 और टिप्स'), callbackData: 'action:solar_tips' },
                  ],
                }],
              };
            }

            if (weatherCondition === 'rain') {
              // Give specific post-rain advice
              return {
                messages: [{
                  text: h(ctx,
                    '🌧️ *Post-Rain Panel Check*\n\nRain is nature\'s free panel cleaner! But sometimes residue remains.\n\n' +
                    '✅ *Quick Check:*\n' +
                    '1. Look for water spots or dried dirt patches\n' +
                    '2. Check edges where dust accumulates\n' +
                    '3. If residue visible, wipe with soft cloth\n\n' +
                    '💡 Clean panels = 10-15% more power generation!',
                    '🌧️ *बारिश के बाद पैनल चेक*\n\nबारिश मुफ्त में पैनल साफ करती है! लेकिन कभी-कभी गंदगी रह जाती है।\n\n' +
                    '✅ *जल्दी चेक करो:*\n' +
                    '1. पानी के धब्बे या सूखी मिट्टी देखो\n' +
                    '2. किनारों पर धूल जमा होती है\n' +
                    '3. गंदगी दिखे तो मुलायम कपड़े से पोंछो\n\n' +
                    '💡 साफ पैनल = 10-15% ज़्यादा बिजली!'
                  ),
                  buttons: [
                    { text: h(ctx, '✅ Panels look clean', '✅ पैनल साफ हैं'), callbackData: 'action:log_cleaning' },
                    { text: h(ctx, '📋 More tips', '📋 और टिप्स'), callbackData: 'action:solar_tips' },
                  ],
                }],
              };
            }

            // Regular advisory check
            const advisory = await getUserSolarAdvisory(ctx.userId!, ctx.language === 'hi-IN');

            if (advisory) {
              return {
                messages: [{
                  text: advisory.message,
                  buttons: [
                    { text: h(ctx, '✅ I cleaned them', '✅ साफ कर दिया'), callbackData: 'action:log_cleaning' },
                    { text: h(ctx, '📋 More tips', '📋 और टिप्स'), callbackData: 'action:solar_tips' },
                  ],
                }],
              };
            }

            // No advisory available, show tips
            const tips = getSolarTips(ctx.language === 'hi-IN');
            return {
              messages: [{
                text: h(ctx,
                  '☀️ *Solar Panel Tips*\n\n' + tips.slice(0, 3).map((t, i) => `${i + 1}. ${t}`).join('\n'),
                  '☀️ *सोलर पैनल टिप्स*\n\n' + tips.slice(0, 3).map((t, i) => `${i + 1}. ${t}`).join('\n')
                ),
              }],
            };
          }

          case 'best_time_to_buy': {
            const { getBuyAdvice } = await import('../auto-trade');
            const advice = await getBuyAdvice(ctx.userId!, ctx.language === 'hi-IN');

            return {
              messages: [{
                text: advice.advice,
                buttons: [
                  { text: h(ctx, '⚡ Buy Now', '⚡ अभी खरीदो'), callbackData: 'action:buy_energy' },
                  { text: h(ctx, '🤖 Auto-Buy', '🤖 ऑटो-बाय'), callbackData: 'action:setup_auto_buy' },
                ],
              }],
            };
          }

          case 'general_qa':
            // No data to fetch — compose from KB or general knowledge
            break;
        }
      }

      // Enrich with knowledge base if relevant
      const kbAnswer = knowledgeBase.findAnswer(message, ctx.language);
      if (kbAnswer) {
        if (!dataContext) dataContext = kbAnswer;
        else dataContext += `\n\nAdditional info: ${kbAnswer}`;
        if (!fallbackText) fallbackText = kbAnswer;
      }

      // --- Step 3: Compose natural response with LLM (with chat memory) ---
      if (dataContext || intent?.intent === 'general_qa' || !intent) {
        // Load recent chat history for short-term memory
        const chatHistory = ctx._sessionId ? await getRecentChatContext(ctx._sessionId) : '';
        const fullContext = [
          userProfileContext,
          chatHistory ? `Recent conversation:\n${chatHistory}` : '',
          dataContext || 'No specific data available. Answer based on general knowledge about Oorja P2P energy trading platform.',
        ].filter(Boolean).join('\n\n');
        const composed = await composeResponse(
          message,
          fullContext,
          ctx.language,
          ctx.name
        );
        if (composed) return { messages: [{ text: composed, buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };
      }

      if (fallbackText) return { messages: [{ text: fallbackText, buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };

      // --- Keyword fallback (when LLM completely unavailable) ---
      if (!intent && ctx.userId) {
        const lower = message.toLowerCase();

        if ((lower.includes('listing') || lower.includes('offer')) &&
          (lower.includes('my') || lower.includes('mere') || lower.includes('show') || lower.includes('dikha') || lower.includes('active') || lower.includes('kitna'))) {
          return { messages: [{ text: await mockTradingAgent.getActiveListings(ctx.userId, ctx.language), buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };
        }
        if (lower.includes('earn') || lower.includes('kamai') || lower.includes('kamaya') || lower.includes('income') || lower.includes('munafa')) {
          const earningsData = await mockTradingAgent.getEarningsData(ctx.userId);
          if (earningsData) {
            return {
              messages: [{
                text: h(ctx,
                  earningsData.hasStartedSelling
                    ? `Here's your earnings summary, ${earningsData.userName}!`
                    : `${earningsData.userName}, start selling to see your earnings here!`,
                  earningsData.hasStartedSelling
                    ? `${earningsData.userName}, यह रही आपकी कमाई!`
                    : `${earningsData.userName}, बेचना शुरू करो और यहाँ कमाई देखो!`
                ),
                earnings: earningsData,
                buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT'),
              }],
            };
          }
          return { messages: [{ text: await mockTradingAgent.getEarningsSummary(ctx.userId, ctx.language), buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };
        }
        if (lower.includes('balance') || lower.includes('wallet') || lower.includes('paise') || lower.includes('khata')) {
          const user = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { balance: true } });
          if (user) return { messages: [{ text: h(ctx, `Wallet balance: Rs ${user.balance.toFixed(2)}`, `Wallet balance: Rs ${user.balance.toFixed(2)}`), buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };
        }
        if (lower.includes('order') || lower.includes('status')) {
          return { messages: [{ text: await mockTradingAgent.getOrdersSummary(ctx.userId, ctx.language), buttons: getSmartSuggestions(ctx, 'GENERAL_CHAT') }] };
        }
        if ((lower.includes('new') || lower.includes('create') || lower.includes('naya') || lower.includes('daal') || lower.includes('bana') || lower.includes('sell') || lower.includes('bech')) &&
          (lower.includes('offer') || lower.includes('listing') || lower.includes('energy') || lower.includes('bijli'))) {
          // Credential gate for keyword fallback too
          if (!verifiedCreds.includes('GENERATION_PROFILE')) {
            return {
              messages: [
                {
                  text: h(ctx,
                    'To sell energy, I need your solar generation credential first. This proves your solar panel capacity.',
                    'बिजली बेचने के लिए पहले आपका सोलर जनरेशन का क्रेडेंशियल चाहिए।'
                  ),
                  buttons: [
                    { text: h(ctx, '📄 Upload credential', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                  ],
                },
              ],
              newState: 'OFFER_OPTIONAL_CREDS',
              contextUpdate: { expectedCredType: 'GenerationProfileCredential' },
            };
          }
          // Start interactive listing creation
          const pending: PendingListing = {};
          const askResult = askNextListingDetail(ctx, pending);
          if (askResult) return askResult;
        }
        // Buy keyword fallback (includes "best deal", "find deal")
        if (((lower.includes('buy') || lower.includes('kharid') || lower.includes('chahiye') || lower.includes('purchase') || lower.includes('leni')) &&
          (lower.includes('energy') || lower.includes('bijli') || lower.includes('unit') || lower.includes('kwh'))) ||
          (lower.includes('best') && lower.includes('deal')) ||
          (lower.includes('find') && (lower.includes('deal') || lower.includes('offer'))) ||
          (lower.includes('acch') && lower.includes('deal'))) {
          // Credential gate for keyword fallback too
          if (!verifiedCreds.includes('CONSUMPTION_PROFILE')) {
            return {
              messages: [
                {
                  text: h(ctx,
                    'To buy electricity, I first need your electricity bill document.',
                    'बिजली खरीदने के लिए पहले आपका बिजली का कागज़ चाहिए।'
                  ),
                  buttons: [
                    { text: h(ctx, '📄 Upload document', '📄 दस्तावेज़ अपलोड करो'), callbackData: 'action:trigger_file_upload' },
                  ],
                },
              ],
              newState: 'OFFER_OPTIONAL_CREDS',
              contextUpdate: { intent: 'buy', expectedCredType: 'ConsumptionProfileCredential' },
            };
          }
          // Start interactive purchase
          const pendingBuy: PendingPurchase = {};
          const askBuyResult = await askNextPurchaseDetail(ctx, pendingBuy);
          if (askBuyResult) return askBuyResult;
        }
      }

      // Try fuzzy matching for typos and abbreviations
      const fuzzyMatch = fuzzyMatchCommand(message);
      if (fuzzyMatch) {
        // Recursively process the corrected command
        logger.info(`[Agent] Fuzzy matched "${message}" -> "${fuzzyMatch}"`);
        return states.GENERAL_CHAT.onMessage(ctx, fuzzyMatch);
      }

      // Last resort - friendly "I don't understand" with smart suggestions
      logger.info(`[Agent] Unmatched message in GENERAL_CHAT: "${message.substring(0, 50)}..."`);
      return getConfusedResponse(ctx, message);
    },
  },

  // Legacy states — redirect to new flow
  OTP_VERIFIED: {
    async onEnter() {
      return { messages: [], newState: 'AUTHENTICATED' };
    },
    async onMessage() {
      return { messages: [], newState: 'AUTHENTICATED' };
    },
  },

  EXPLAIN_VC: {
    async onEnter() {
      return { messages: [], newState: 'WAITING_UTILITY_CRED' };
    },
    async onMessage() {
      return { messages: [], newState: 'WAITING_UTILITY_CRED' };
    },
  },

  WAITING_VC_UPLOAD: {
    async onEnter() {
      return { messages: [], newState: 'WAITING_UTILITY_CRED' };
    },
    async onMessage(ctx, message, fileData) {
      return states.WAITING_UTILITY_CRED.onMessage(ctx, message, fileData);
    },
  },

  VC_VERIFIED: {
    async onEnter() {
      return { messages: [], newState: 'OFFER_OPTIONAL_CREDS' };
    },
    async onMessage() {
      return { messages: [], newState: 'OFFER_OPTIONAL_CREDS' };
    },
  },

  TRADING_ACTIVE: {
    async onEnter() {
      return { messages: [], newState: 'GENERAL_CHAT' };
    },
    async onMessage() {
      return { messages: [], newState: 'GENERAL_CHAT' };
    },
  },
};

// --- Translation helpers ---

async function translateResponse(
  response: AgentResponse,
  targetLang: SarvamLangCode
): Promise<AgentResponse> {
  // For English or if translation is unavailable, pass through
  if (targetLang === 'en-IN' || !isTranslationAvailable()) {
    return { ...response, responseLanguage: targetLang };
  }

  // Check if text is already in target language (contains native script)
  // This prevents double-translation when h() already returns the correct text
  const isAlreadyInTargetLang = (text: string): boolean => {
    if (targetLang === 'hi-IN') {
      // Hindi: Devanagari script range
      return /[\u0900-\u097F]/.test(text);
    }
    if (targetLang === 'bn-IN') {
      // Bengali: Bengali script range
      return /[\u0980-\u09FF]/.test(text);
    }
    if (targetLang === 'ta-IN') {
      // Tamil: Tamil script range
      return /[\u0B80-\u0BFF]/.test(text);
    }
    if (targetLang === 'te-IN') {
      // Telugu: Telugu script range
      return /[\u0C00-\u0C7F]/.test(text);
    }
    if (targetLang === 'kn-IN') {
      // Kannada: Kannada script range
      return /[\u0C80-\u0CFF]/.test(text);
    }
    return false;
  };

  const translatedMessages: AgentMessage[] = [];
  for (const msg of response.messages) {
    // Skip translation if text is already in the target language
    const translatedText = isAlreadyInTargetLang(msg.text)
      ? msg.text
      : await translateFromEnglish(msg.text, targetLang);
    let translatedButtons = msg.buttons;
    if (msg.buttons && msg.buttons.length > 0) {
      translatedButtons = await Promise.all(
        msg.buttons.map(async (btn) => ({
          text: isAlreadyInTargetLang(btn.text)
            ? btn.text
            : await translateFromEnglish(btn.text, targetLang),
          callbackData: btn.callbackData,
        }))
      );
    }
    translatedMessages.push({
      ...msg,
      text: translatedText,
      buttons: translatedButtons,
    });
  }

  return { ...response, messages: translatedMessages, responseLanguage: targetLang };
}

// --- Main Entry Point ---

export async function processMessage(
  platform: 'TELEGRAM' | 'WEB' | 'WHATSAPP',
  platformId: string,
  userMessage: string,
  fileData?: FileData,
  authenticatedUserId?: string,
  voiceOptions?: VoiceInputOptions,
  displayText?: string,
): Promise<AgentResponse> {
  let session = await prisma.chatSession.findUnique({
    where: { platform_platformId: { platform, platformId } },
  });

  if (!session) {
    // --- Fast-track for authenticated users (logged in via app) ---
    if (authenticatedUserId) {
      const user = await prisma.user.findUnique({
        where: { id: authenticatedUserId },
        select: { id: true, name: true, profileComplete: true, providerId: true, phone: true, languagePreference: true },
      });

      if (user?.profileComplete) {
        // User already onboarded — skip straight to GENERAL_CHAT with welcome-back summary
        const verifiedCreds = await getVerifiedCredentials(user.id);
        const ctx: SessionContext = {
          userId: user.id,
          name: user.name || undefined,
          phone: user.phone || undefined,
          verifiedCreds,
          tradingActive: true,
          language: (user.languagePreference as any) || undefined,
        };

        session = await prisma.chatSession.upsert({
          where: { platform_platformId: { platform, platformId } },
          create: {
            platform,
            platformId,
            state: 'GENERAL_CHAT',
            contextJson: JSON.stringify(ctx),
            userId: user.id,
          },
          update: {
            state: 'GENERAL_CHAT',
            contextJson: JSON.stringify(ctx),
            userId: user.id,
          },
        });

        await storeMessage(session.id, 'user', displayText || userMessage);

        // Compose a welcome-back summary using LLM — respect saved language preference
        const savedLang = ctx.language;
        logger.info(`[Language] New session for user ${user.id}, saved preference: "${savedLang || 'none'}"`);
        const summaryData = await getWelcomeBackData(user.id);
        const credContext = 'User profile: Already onboarded and verified. Do NOT ask for credentials — they have already completed onboarding.';
        const welcomeMsg = await composeResponse(
          'welcome back, give me a summary of my activity',
          `${credContext}\n\n${summaryData}`,
          savedLang,
          user.name || undefined
        );

        const fallbackWelcome = savedLang === 'hi-IN'
          ? `Wapas aaye ${user.name || 'dost'}! Aaj kya madad karun?`
          : `Welcome back, ${user.name || 'friend'}! How can I help you today?`;
        const messages: AgentMessage[] = [{ text: welcomeMsg || fallbackWelcome }];
        await storeAgentMessages(session.id, messages);

        return { messages, responseLanguage: savedLang || 'en-IN' };
      }

      if (user) {
        // User exists but hasn't completed onboarding — check how far they got
        const verifiedCreds = await getVerifiedCredentials(user.id);
        const savedLang = (user.languagePreference as any) || undefined;
        const ctx: SessionContext = {
          userId: user.id,
          name: user.name || undefined,
          phone: user.phone || undefined,
          verifiedCreds,
          language: savedLang,
        };

        let startState: ChatState = 'ASK_DISCOM';
        if (verifiedCreds.includes('UTILITY_CUSTOMER')) {
          startState = 'ASK_INTENT';
        }

        session = await prisma.chatSession.upsert({
          where: { platform_platformId: { platform, platformId } },
          create: {
            platform,
            platformId,
            state: startState,
            contextJson: JSON.stringify(ctx),
            userId: user.id,
          },
          update: {
            state: startState,
            contextJson: JSON.stringify(ctx),
            userId: user.id,
          },
        });

        await storeMessage(session.id, 'user', displayText || userMessage);

        const welcomeMsg: AgentMessage = {
          text: h(ctx, `Welcome, ${user.name || 'friend'}! Let's finish setting up your profile.`, `स्वागत है, ${user.name || 'दोस्त'}! चलो प्रोफाइल पूरा करते हैं।`),
        };
        const enterResp = await states[startState].onEnter(ctx);
        const allMessages = [welcomeMsg, ...enterResp.messages];
        await storeAgentMessages(session.id, allMessages);

        // Chain through if onEnter triggers a state transition
        if (enterResp.newState && enterResp.newState !== startState) {
          await transitionState(session.id, enterResp.newState, enterResp.contextUpdate);
          const chainResp = await states[enterResp.newState as ChatState].onEnter({ ...ctx, ...enterResp.contextUpdate });
          await storeAgentMessages(session.id, chainResp.messages);
          return { messages: [...allMessages, ...chainResp.messages], responseLanguage: savedLang || 'en-IN' };
        }

        return { messages: allMessages, responseLanguage: savedLang || 'en-IN' };
      }
    }

    // --- WhatsApp: Require app verification before chatting ---
    const isWhatsAppMessage = platform === 'WHATSAPP' && (platformId.includes('@s.whatsapp.net') || platformId.includes('@lid'));

    if (isWhatsAppMessage) {
      // Extract phone number from WhatsApp JID (standard format)
      // For LID format, we need to look up by recent activity
      const isLidFormat = platformId.includes('@lid');
      const whatsappPhone = isLidFormat ? null : platformId.replace('@s.whatsapp.net', '');

      let existingUser: { id: string; name: string | null; profileComplete: boolean; phone: string | null; languagePreference: string | null } | null = null;

      if (whatsappPhone) {
        // Standard format: Try to find existing user by phone
        existingUser = await prisma.user.findFirst({
          where: {
            OR: [
              { phone: whatsappPhone },
              { phone: `+${whatsappPhone}` },
              // Handle various formats
              { phone: { endsWith: whatsappPhone.slice(-10) } },
            ],
          },
          select: { id: true, name: true, profileComplete: true, phone: true, languagePreference: true },
        });
      } else {
        // LID format: Check for existing session with this LID first
        const existingLidSession = await prisma.chatSession.findUnique({
          where: { platform_platformId: { platform: 'WHATSAPP', platformId } },
        });

        if (existingLidSession?.userId) {
          existingUser = await prisma.user.findUnique({
            where: { id: existingLidSession.userId },
            select: { id: true, name: true, profileComplete: true, phone: true, languagePreference: true },
          });
          if (existingUser) {
            logger.info(`Found existing LID session for user ${existingUser.id}`);
          }
        } else {
          // No existing session - try to find a user who recently got WhatsApp welcome
          // This is a heuristic for when user completes onboarding → gets welcome → replies
          const recentWelcomedUsers = await prisma.user.findMany({
            where: {
              profileComplete: true,
              whatsappWelcomeSent: true,
              // Look for users who were updated in the last 10 minutes (likely just completed onboarding)
              updatedAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
            },
            select: { id: true, name: true, profileComplete: true, phone: true, languagePreference: true },
            orderBy: { updatedAt: 'desc' },
            take: 5,
          });

          // Filter out users without phone (can't do NOT null in Prisma updateMany/findMany easily)
          const usersWithPhone = recentWelcomedUsers.filter(u => u.phone);

          if (usersWithPhone.length === 1) {
            // Only one recent user - high confidence this is them
            existingUser = usersWithPhone[0];
            logger.info(`LID heuristic: Matched to recent user ${existingUser.id} (phone: ${existingUser.phone})`);
          } else if (usersWithPhone.length > 1) {
            logger.warn(`LID heuristic: Found ${usersWithPhone.length} recent users, cannot determine which one - asking for verification`);
          } else {
            logger.info(`LID format detected but no recent welcomed users found`);
          }
        }
      }

      // VERIFIED USER: Has completed profile on the app
      if (existingUser?.profileComplete) {
        logger.info(`WhatsApp verified user: ${existingUser.id} for phone ${whatsappPhone || existingUser.phone || 'LID:' + platformId}`);

        const verifiedCreds = await getVerifiedCredentials(existingUser.id);

        // --- Cross-platform sync: Check for active sessions on other platforms ---
        const otherSessions = await prisma.chatSession.findMany({
          where: {
            userId: existingUser.id,
            platform: { not: 'WHATSAPP' },
            isActive: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        });

        let syncedContext: Partial<SessionContext> = {};
        let syncMessage: string | null = null;

        if (otherSessions.length > 0) {
          const otherSession = otherSessions[0];
          const otherCtx = JSON.parse(otherSession.contextJson) as SessionContext;

          // Sync pending operations
          if (otherCtx.pendingListing) {
            syncedContext.pendingListing = otherCtx.pendingListing;
            syncMessage = h({ language: existingUser.languagePreference as any },
              `I see you were creating a listing on ${otherSession.platform === 'WEB' ? 'the website' : 'another device'}. Want to continue here?`,
              `Maine dekha ${otherSession.platform === 'WEB' ? 'website' : 'dusre device'} pe aap listing bana rahe the. Yahan continue karein?`
            );
          } else if (otherCtx.pendingPurchase) {
            syncedContext.pendingPurchase = otherCtx.pendingPurchase;
            syncMessage = h({ language: existingUser.languagePreference as any },
              `I see you were buying energy on ${otherSession.platform === 'WEB' ? 'the website' : 'another device'}. Want to continue here?`,
              `Maine dekha ${otherSession.platform === 'WEB' ? 'website' : 'dusre device'} pe aap bijli khareed rahe the. Yahan continue karein?`
            );
          }

          // Sync language preference
          if (otherCtx.language && !existingUser.languagePreference) {
            syncedContext.language = otherCtx.language;
          }

          logger.info(`Cross-platform sync: Synced context from ${otherSession.platform} session`);
        }

        const ctx: SessionContext = {
          userId: existingUser.id,
          name: existingUser.name || undefined,
          phone: existingUser.phone || undefined,
          verifiedCreds,
          tradingActive: true,
          language: (existingUser.languagePreference as any) || undefined,
          ...syncedContext,
        };

        // Verified WhatsApp users go directly to GENERAL_CHAT - no onboarding
        session = await prisma.chatSession.create({
          data: {
            platform,
            platformId,
            state: 'GENERAL_CHAT',
            contextJson: JSON.stringify(ctx),
            userId: existingUser.id,
          },
        });

        await storeMessage(session.id, 'user', displayText || userMessage);

        // Welcome verified user with activity summary
        const savedLang = ctx.language;
        const summaryData = await getWelcomeBackData(existingUser.id);
        const credContext = 'User profile: Already onboarded and verified. Do NOT ask for credentials.';
        const welcomeMsg = await composeResponse(
          'welcome back on WhatsApp, give me a summary',
          `${credContext}\n\n${summaryData}`,
          savedLang,
          existingUser.name || undefined
        );

        const fallbackWelcome = savedLang === 'hi-IN'
          ? `Wapas aaye ${existingUser.name || 'dost'}! WhatsApp pe swagat hai. Aaj kya madad karun?`
          : `Welcome back, ${existingUser.name || 'friend'}! Great to see you on WhatsApp. How can I help?`;

        const messages: AgentMessage[] = [{ text: welcomeMsg || fallbackWelcome }];

        // Add sync message if there's a pending operation
        if (syncMessage) {
          messages.push({
            text: syncMessage,
            buttons: [
              { text: h(ctx, 'Yes, continue', 'Haan, continue'), callbackData: 'sync:continue' },
              { text: h(ctx, 'No, start fresh', 'Nahi, naya shuru'), callbackData: 'sync:fresh' },
            ],
          });
        }

        await storeAgentMessages(session.id, messages);
        return { messages, responseLanguage: ctx.language || 'en-IN' };
      }

      // UNVERIFIED USER: Either doesn't exist or hasn't completed profile
      // Redirect them to register on the app
      logger.info(`WhatsApp unverified user from ${whatsappPhone ? 'phone ' + whatsappPhone : 'LID ' + platformId} - redirecting to app`);
      return getUnverifiedWhatsAppResponse(userMessage);
    }

    // --- Default: anonymous or unrecognized user — start from greeting ---
    // Note: WhatsApp users never reach here - they get redirected above
    session = await prisma.chatSession.upsert({
      where: { platform_platformId: { platform, platformId } },
      create: { platform, platformId, state: 'GREETING', contextJson: '{}' },
      update: { state: 'GREETING', contextJson: '{}' },
    });

    await storeMessage(session.id, 'user', displayText || userMessage);

    const anonCtx: SessionContext = {};
    anonCtx._platform = platform; // Set platform for state handlers
    const enterResp = await states.GREETING.onEnter(anonCtx);
    await storeAgentMessages(session.id, enterResp.messages);

    return { messages: enterResp.messages, responseLanguage: 'en-IN' };
  }

  // Existing session
  await storeMessage(session.id, 'user', displayText || userMessage);
  const ctx = JSON.parse(session.contextJson) as SessionContext;
  ctx._sessionId = session.id; // Runtime-only, not persisted
  ctx._platform = platform; // Runtime-only, not persisted
  const currentState = session.state as ChatState;

  // --- WhatsApp verification check for existing sessions ---
  // If user isn't verified (profileComplete), redirect to app
  if (platform === 'WHATSAPP') {
    let isVerified = false;
    if (ctx.userId) {
      const user = await prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { profileComplete: true },
      });
      isVerified = user?.profileComplete === true;
    }

    if (!isVerified) {
      logger.info(`WhatsApp session exists but user not verified - redirecting to app`);
      // Clear the old session
      await prisma.chatSession.delete({ where: { id: session.id } }).catch(err => {
        logger.warn(`Failed to delete unverified WhatsApp session ${session.id}: ${err.message}`);
      });
      return getUnverifiedWhatsAppResponse(userMessage);
    }
  }

  const stateHandler = states[currentState];

  if (!stateHandler) {
    logger.error(`Unknown state: ${currentState}`);
    return { messages: [{ text: h(ctx, 'Something went wrong. Please try again.', 'कुछ गड़बड़ हो गई। दोबारा कोशिश करो।') }], responseLanguage: ctx.language || 'en-IN' };
  }

  // Check for universal commands (help, back, cancel, status, language)
  const universalResponse = await handleUniversalCommand(
    userMessage,
    ctx,
    currentState,
    session.id
  );

  if (universalResponse) {
    // Update context if needed
    if (universalResponse.contextUpdate) {
      const updatedCtx = { ...ctx, ...universalResponse.contextUpdate };
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { contextJson: serializeContext(updatedCtx) },
      });
    }
    await storeAgentMessages(session.id, universalResponse.messages);
    // Translate universal command responses to the user's language
    const ucLang = (universalResponse.contextUpdate?.language || ctx.language || 'en-IN') as SarvamLangCode;
    return translateResponse(universalResponse, ucLang);
  }

  // Per-message language detection — dynamically switch language mid-conversation
  // For voice input, use the language detected by STT (already translated to English)
  // For text input, detect language from the text itself
  const isStructuredInput = /^\d+$/.test(userMessage.trim()) || userMessage.trim().length <= 3;
  const isCallbackData = userMessage.includes(':') && !userMessage.includes(' ');

  let detectedLang: SarvamLangCode;
  let processedMessage = userMessage;

  if (voiceOptions?.isVoiceInput && voiceOptions.detectedLanguage) {
    // Voice input: STT already returns transcript in native script
    detectedLang = voiceOptions.detectedLanguage as SarvamLangCode;
    logger.info(`[Voice] Using STT-detected language: ${detectedLang}`);

    // Normalize voice transcript: merge split phone numbers, remove filler words
    const normalizedMessage = await normalizeVoiceInput(userMessage);
    if (normalizedMessage !== userMessage) {
      logger.info(`[Voice] Normalized: "${userMessage}" → "${normalizedMessage}"`);
      processedMessage = normalizedMessage;
    }
  } else {
    // Text input: detect language from the text
    detectedLang = detectLanguage(userMessage);
    // Translate native-script messages to English for processing
    if (detectedLang !== 'en-IN' && !isStructuredInput) {
      processedMessage = await translateToEnglish(userMessage, detectedLang as SarvamLangCode);
      logger.info(`Translated [${detectedLang} → en-IN]: "${userMessage}" → "${processedMessage}"`);
    }
  }

  // Determine effective language for this message:
  // 1. Structured input (numbers, callbacks) → keep existing preference
  // 2. Voice input → KEEP existing preference (don't switch based on detected language)
  // 3. File uploads → KEEP existing preference (label is always English)
  // 4. If language already set → KEEP it (don't switch to English for English input like names)
  // 5. Native Indic script detected in TEXT → switch to that language
  // 6. First message in English → default to English
  let userLang: SarvamLangCode;
  // IMPORTANT: Handle language selection callbacks FIRST, before any defaults
  if (userMessage.startsWith('lang:')) {
    // User explicitly selected a language via button (e.g., "lang:hi-IN")
    const selectedLang = userMessage.replace('lang:', '') as SarvamLangCode;
    userLang = selectedLang;
    logger.info(`[Language] User selected language via callback: ${selectedLang}`);
  } else if (isStructuredInput || isCallbackData) {
    // Don't change language on other button presses or numeric input
    userLang = (ctx.language || 'en-IN') as SarvamLangCode;
  } else if (fileData) {
    // File uploads: KEEP existing language preference
    // The label "[PDF uploaded]" is always English but user expects response in their chosen language
    userLang = (ctx.language || 'en-IN') as SarvamLangCode;
    logger.info(`[FileUpload] Keeping existing language preference: ${userLang}`);
  } else if (voiceOptions?.isVoiceInput) {
    // Voice input: KEEP existing language preference
    // User may say English words (like names) but expects response in their chosen language
    userLang = (ctx.language || 'en-IN') as SarvamLangCode;
    logger.info(`[Voice] Keeping existing language preference: ${userLang} (detected: ${detectedLang})`);
  } else if (ctx.language && ctx.language !== 'en-IN' && detectedLang === 'en-IN') {
    // IMPORTANT: If language is already set to non-English, KEEP it even if user types English
    // Users often type English words (names, numbers, addresses) while expecting response in their language
    userLang = ctx.language as SarvamLangCode;
    logger.info(`[Language] Keeping ${userLang} despite English input: "${userMessage.substring(0, 30)}"`);
  } else if (detectedLang !== 'en-IN') {
    // Native Indic script typed (Devanagari, Bengali, etc.) → switch to that language
    userLang = detectedLang;
  } else if (ctx.language) {
    // Language already set, keep it
    userLang = ctx.language as SarvamLangCode;
  } else {
    // First message, default to English
    userLang = 'en-IN';
  }

  // Update language preference if changed — persist to session and user profile
  if (userLang !== ctx.language) {
    logger.info(`[Language] Switching: "${ctx.language || 'none'}" → "${userLang}" (detected: ${detectedLang}, input: "${userMessage.substring(0, 40)}")`);
    ctx.language = userLang;
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { contextJson: serializeContext(ctx) },
    });
    // Persist language preference to user profile for cross-session continuity
    if (ctx.userId) {
      prisma.user.update({
        where: { id: ctx.userId },
        data: { languagePreference: userLang },
      }).catch(() => { }); // Fire-and-forget, non-critical
    }
  } else {
    logger.debug(`[Language] Kept: "${userLang}" (detected: ${detectedLang})`);
  }

  const response = await stateHandler.onMessage(ctx, processedMessage, fileData);
  await storeAgentMessages(session.id, response.messages);

  if (response.newState && response.newState !== currentState) {
    const mergedCtx = { ...ctx, ...response.contextUpdate };
    await transitionState(session.id, response.newState, response.contextUpdate);

    const enterResp = await states[response.newState as ChatState].onEnter(mergedCtx);
    await storeAgentMessages(session.id, enterResp.messages);

    let allMessages = [...response.messages, ...enterResp.messages];
    let chainState = response.newState as ChatState;
    let chainCtx = { ...mergedCtx, ...enterResp.contextUpdate };
    let authToken = response.authToken || enterResp.authToken;

    let nextResp = enterResp;
    while (nextResp.newState && nextResp.newState !== chainState) {
      await transitionState(session.id, nextResp.newState, nextResp.contextUpdate);
      chainState = nextResp.newState as ChatState;
      chainCtx = { ...chainCtx, ...nextResp.contextUpdate };
      nextResp = await states[chainState].onEnter(chainCtx);
      await storeAgentMessages(session.id, nextResp.messages);
      allMessages = [...allMessages, ...nextResp.messages];
      authToken = authToken || nextResp.authToken;
    }

    const effectiveLang = (response.contextUpdate?.language as any) || userLang;
    const voiceEnabled = chainCtx.voiceOutputEnabled;
    const autoVoice = voiceOptions?.isVoiceInput === true;
    return translateResponse({ messages: allMessages, authToken, voiceOutputEnabled: voiceEnabled, autoVoice }, effectiveLang);
  }

  if (response.contextUpdate) {
    const merged = { ...ctx, ...response.contextUpdate };
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { contextJson: serializeContext(merged) },
    });
  }

  const effectiveLang = (response.contextUpdate?.language as any) || userLang;
  const mergedCtx = { ...ctx, ...response.contextUpdate };
  const voiceEnabled = mergedCtx.voiceOutputEnabled;
  const autoVoice = voiceOptions?.isVoiceInput === true;
  return translateResponse({ ...response, voiceOutputEnabled: voiceEnabled, autoVoice }, effectiveLang);
}

// --- Helpers ---

/** Strip runtime-only fields (prefixed with _) before persisting */
function serializeContext(ctx: SessionContext): string {
  const { _sessionId, ...rest } = ctx;
  return JSON.stringify(rest);
}

async function transitionState(
  sessionId: string,
  newState: string,
  contextUpdate?: Partial<SessionContext>
) {
  const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const currentCtx = JSON.parse(session.contextJson);
  const merged = { ...currentCtx, ...contextUpdate };

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: {
      state: newState as any,
      contextJson: serializeContext(merged),
      ...(contextUpdate?.userId ? { userId: contextUpdate.userId } : {}),
      ...(contextUpdate?.authToken ? { authToken: contextUpdate.authToken } : {}),
    },
  });
}

async function storeMessage(sessionId: string, role: string, content: string, metadata?: any) {
  await prisma.chatMessage.create({
    data: {
      sessionId,
      role,
      content,
      metadataJson: metadata ? JSON.stringify(metadata) : null,
    },
  });
}

async function storeAgentMessages(sessionId: string, messages: AgentMessage[]) {
  for (const msg of messages) {
    const metadata: Record<string, unknown> = {};
    if (msg.buttons) metadata.buttons = msg.buttons;
    if (msg.dashboard) metadata.dashboard = msg.dashboard;
    if (msg.earnings) metadata.earnings = msg.earnings;
    if (msg.listings) metadata.listings = msg.listings;
    if (msg.offerCreated) metadata.offerCreated = msg.offerCreated;
    if (msg.topDeals) metadata.topDeals = msg.topDeals;
    if (msg.matchedOffers) metadata.matchedOffers = msg.matchedOffers;
    if (msg.orderConfirmation) metadata.orderConfirmation = msg.orderConfirmation;
    if (msg.slider) metadata.slider = msg.slider;
    if (msg.autoTradeStatus) metadata.autoTradeStatus = msg.autoTradeStatus;
    if (msg.offers) metadata.offers = msg.offers;

    await storeMessage(
      sessionId,
      'agent',
      msg.text,
      Object.keys(metadata).length > 0 ? metadata : undefined
    );
  }
}

/**
 * Load recent chat messages for short-term memory context.
 * Returns a formatted string of the last N messages (privacy-safe: no phone numbers or tokens).
 */
async function getRecentChatContext(sessionId: string, limit: number = 6): Promise<string> {
  try {
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { role: true, content: true },
    });

    if (messages.length === 0) return '';

    // Reverse to chronological order and format
    return messages.reverse().map(m => {
      const role = m.role === 'user' ? 'User' : 'Oorja';
      // Strip any sensitive data patterns (phone numbers, tokens)
      const safeContent = m.content
        .replace(/\b\d{10,12}\b/g, '[phone]')
        .replace(/Bearer\s+\S+/g, '[token]')
        .substring(0, 200);
      return `${role}: ${safeContent}`;
    }).join('\n');
  } catch {
    return '';
  }
}
