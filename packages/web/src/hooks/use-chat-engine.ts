'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { chatApi } from '@/lib/api';
import { prefetchTTS } from '@/lib/tts-cache';

const SESSION_KEY = 'oorja_chat_session';
const ANON_SESSION_KEY = 'oorja_anon_session'; // Temporary session for anonymous users

export interface OfferData {
  id: string;
  sellerId: string;
  sellerName: string;
  trustScore: number;
  energyType: 'SOLAR' | 'WIND' | 'HYDRO' | 'MIXED';
  quantityKWh: number;
  pricePerKwh: number;
  discomRate: number;
  startTime: string;
  endTime: string;
}

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

export interface ListingData {
  id: string;
  quantity: number;
  pricePerKwh: number;
  startTime: string;
  endTime: string;
  energyType: string;
}

export interface ListingsCardData {
  listings: ListingData[];
  totalListed: number;
  totalSold: number;
  userName: string;
}

export interface OfferCreatedData {
  quantity: number;
  pricePerKwh: number;
  startTime: string;
  endTime: string;
  energyType?: string;
}

// Top Deals Card (Step 4 - buyer flow)
export interface TopDealData {
  offerId: string;
  providerName: string;
  trustScore: number;
  energyType: string;
  quantity: number;
  pricePerKwh: number;
  savingsPercent: number;
}

export interface TopDealsCardData {
  deals: TopDealData[];
  discomRate: number;
}

// Matched Offers Card (Step 7 - buyer flow)
export interface MatchedOfferData {
  offerId: string;
  providerId: string;
  providerName: string;
  trustScore: number;
  energyType: string;
  quantity: number;
  pricePerKwh: number;
  subtotal: number;
  timeWindow: string;
}

export interface MatchedOffersCardData {
  selectionType: 'single' | 'multiple';
  offers: MatchedOfferData[];
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
}

// Order Confirmation Card (Step 8 - buyer flow)
export interface OrderConfirmationCardData {
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
}

// Earnings Card
export interface EarningsCardData {
  userName: string;
  hasStartedSelling: boolean;
  totalOrders: number;
  totalEnergySold: number;
  totalEarnings: number;
  walletBalance: number;
}

/** Slider input configuration */
export interface SliderData {
  type: 'quantity' | 'price';
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
  callbackPrefix: string;
}

/** Auto-trade status data */
export interface AutoTradeStatusData {
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
}

export interface ChatMessageData {
  role: 'agent' | 'user';
  content: string;
  buttons?: Array<{ text: string; callbackData?: string }>;
  offers?: OfferData[];
  dashboard?: DashboardData;
  listings?: ListingsCardData;
  offerCreated?: OfferCreatedData;
  topDeals?: TopDealsCardData;
  matchedOffers?: MatchedOffersCardData;
  orderConfirmation?: OrderConfirmationCardData;
  earnings?: EarningsCardData;
  slider?: SliderData;
  autoTradeStatus?: AutoTradeStatusData;
}

/** Get stored session - prioritize authenticated session, then anonymous. */
function getStoredSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  const hasAuth = !!localStorage.getItem('authToken');
  if (hasAuth) {
    // Authenticated - use permanent session
    return localStorage.getItem(SESSION_KEY);
  }
  // Anonymous - use temporary session
  return localStorage.getItem(ANON_SESSION_KEY);
}

/** Store session ID - always store immediately to prevent duplicates. */
function storeSessionId(id: string, isAuthenticated: boolean) {
  if (typeof window === 'undefined') return;
  if (isAuthenticated) {
    localStorage.setItem(SESSION_KEY, id);
    localStorage.removeItem(ANON_SESSION_KEY); // Clean up anon session
  } else {
    localStorage.setItem(ANON_SESSION_KEY, id);
  }
}

function clearStoredSession() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ANON_SESSION_KEY);
  }
}

function handleAuthToken(token: string) {
  if (typeof window === 'undefined') return;
  localStorage.setItem('authToken', token);
  window.dispatchEvent(new CustomEvent('auth:login'));
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function useChatEngine() {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [responseLanguage, setResponseLanguage] = useState<string>(() => {
    // Load saved language preference from localStorage
    if (typeof window !== 'undefined') {
      return localStorage.getItem('oorja_language') || 'en-IN';
    }
    return 'en-IN';
  });
  const [resetCounter, setResetCounter] = useState(0); // Triggers re-init after reset
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Use refs for initialization state (survives React StrictMode double-mount)
  const initializedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const isAuthenticatedRef = useRef(false);

  // Load history or trigger greeting on mount (or after reset)
  useEffect(() => {
    // Use ref to prevent double-initialization in React StrictMode
    if (initializedRef.current) return;
    initializedRef.current = true;

    const hasAuth = typeof window !== 'undefined' && !!localStorage.getItem('authToken');
    setIsAuthenticated(hasAuth);
    isAuthenticatedRef.current = hasAuth;

    // Anonymous users: clear stale session on load so reload starts fresh
    if (!hasAuth) {
      clearStoredSession();
    }

    // Check for existing session (authenticated only — anon cleared above)
    const storedSession = getStoredSessionId();
    if (storedSession) {
      setSessionId(storedSession);
      sessionIdRef.current = storedSession;
    }

    (async () => {
      try {
        // Try to restore history for any existing session (authenticated or anonymous)
        if (storedSession) {
          const history = await chatApi.getHistory(storedSession);
          if (history.messages && history.messages.length > 0) {
            setMessages(
              history.messages.map((m: any) => ({
                role: m.role,
                content: m.content,
                buttons: m.buttons,
                dashboard: m.dashboard,
                listings: m.listings,
                offerCreated: m.offerCreated,
                topDeals: m.topDeals,
                matchedOffers: m.matchedOffers,
                orderConfirmation: m.orderConfirmation,
                earnings: m.earnings,
                slider: m.slider,
                autoTradeStatus: m.autoTradeStatus,
              }))
            );
            // Restore language from session
            if (history.responseLanguage) {
              setResponseLanguage(history.responseLanguage);
              if (typeof window !== 'undefined') {
                localStorage.setItem('oorja_language', history.responseLanguage);
              }
            }
            return; // History loaded, don't trigger greeting
          }
        }
        // No session or no history — trigger greeting
        await sendMessageToAgentInternal('hi', true);
      } catch {
        await sendMessageToAgentInternal('hi', true);
      }
    })();
  }, [resetCounter]);

  // Internal send function that uses refs to avoid stale closure issues
  const sendMessageToAgentInternal = async (text: string, hideUserMessage = false, displayText?: string) => {
    setIsLoading(true);

    if (!hideUserMessage) {
      setMessages((prev) => [...prev, { role: 'user', content: text }]);
    }

    try {
      // Use ref for current sessionId to avoid stale closure
      const currentSessionId = sessionIdRef.current;
      const res = await chatApi.send(text, currentSessionId || undefined, displayText);

      if (res.sessionId) {
        // Update both state and ref immediately
        setSessionId(res.sessionId);
        sessionIdRef.current = res.sessionId;

        // Always store sessionId immediately to prevent duplicate sessions
        const willBeAuthenticated = !!res.authToken || isAuthenticatedRef.current;
        storeSessionId(res.sessionId, willBeAuthenticated);
      }

      if (res.authToken) {
        handleAuthToken(res.authToken);
        setIsAuthenticated(true);
        isAuthenticatedRef.current = true;
        // Re-store with auth flag
        if (res.sessionId) {
          storeSessionId(res.sessionId, true);
        }
      }

      if (res.messages && res.messages.length > 0) {
        setMessages((prev) => [
          ...prev,
          ...res.messages.map((m: any) => ({
            role: 'agent' as const,
            content: m.content,
            buttons: m.buttons,
            dashboard: m.dashboard,
            listings: m.listings,
            offerCreated: m.offerCreated,
            topDeals: m.topDeals,
            matchedOffers: m.matchedOffers,
            orderConfirmation: m.orderConfirmation,
            earnings: m.earnings,
            slider: m.slider,
            autoTradeStatus: m.autoTradeStatus,
          })),
        ]);
      }

      // Update response language and persist to localStorage
      if (res.responseLanguage) {
        console.log(`[sendMessageToAgent] Updating responseLanguage: ${res.responseLanguage}`);
        setResponseLanguage(res.responseLanguage);
        if (typeof window !== 'undefined') {
          localStorage.setItem('oorja_language', res.responseLanguage);
        }
      } else {
        console.log(`[sendMessageToAgent] No responseLanguage in response`);
      }

      // Pre-fetch TTS audio for agent messages so speaker button plays instantly
      const ttsLang = res.responseLanguage || responseLanguage;
      if (res.messages && res.messages.length > 0) {
        for (const m of res.messages) {
          if (m.content && m.content.length > 0) {
            prefetchTTS(m.content, ttsLang);
          }
        }
      }

      // Sync voice preference from server
      if (res.voiceOutputEnabled !== undefined) {
        window.dispatchEvent(new CustomEvent('voice:preference', {
          detail: { enabled: res.voiceOutputEnabled }
        }));
      }
    } catch (err: any) {
      console.error('[Chat] sendMessageToAgent error:', err);
      const errorMsg = responseLanguage === 'hi-IN'
        ? 'माफ़ करना, कुछ गड़बड़ हो गई। दोबारा कोशिश करो।'
        : 'Sorry, something went wrong. Please try again.';
      setMessages((prev) => [
        ...prev,
        { role: 'agent', content: errorMsg },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  // Stable callback wrapper for external use
  const sendMessageToAgent = useCallback(
    (text: string, hideUserMessage = false, displayText?: string) => sendMessageToAgentInternal(text, hideUserMessage, displayText),
    []
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    setInput('');
    sendMessageToAgent(trimmed);
  }, [input, isLoading, sendMessageToAgent]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleButtonClick = useCallback(
    (callbackData: string, displayText: string) => {
      if (isLoading) return;

      // Special handling: trigger file upload directly
      if (callbackData === 'action:trigger_file_upload') {
        fileInputRef.current?.click();
        return;
      }

      setMessages((prev) => [...prev, { role: 'user', content: displayText }]);
      sendMessageToAgent(callbackData, true, displayText);
    },
    [isLoading, sendMessageToAgent]
  );

  const handleReset = useCallback(async () => {
    // Preserve language preference across reset
    const savedLanguage = responseLanguage;
    if (typeof window !== 'undefined') {
      localStorage.setItem('oorja_language', savedLanguage);
    }

    try {
      const currentSessionId = sessionIdRef.current;
      await chatApi.reset(currentSessionId || undefined);
    } catch { /* ignore */ }
    setMessages([]);
    setSessionId(null);
    sessionIdRef.current = null;
    clearStoredSession();

    // Restore language preference
    setResponseLanguage(savedLanguage);

    // Reset initialization flag and trigger re-init
    initializedRef.current = false;
    setResetCounter(c => c + 1);
  }, [responseLanguage]);

  // Localized messages for file upload
  const getUploadMessages = useCallback((lang: string) => {
    const messages: Record<string, { invalidFile: string; uploaded: string; error: string }> = {
      'en-IN': { invalidFile: 'Please upload a PDF or JSON file.', uploaded: 'Uploaded:', error: 'Failed to process the file. Please try again.' },
      'hi-IN': { invalidFile: 'सिर्फ पीडीएफ या जेएसओएन फाइल अपलोड करो।', uploaded: 'अपलोड हो गया:', error: 'फाइल प्रोसेस नहीं हो पाई। दोबारा कोशिश करो।' },
      'bn-IN': { invalidFile: 'শুধুমাত্র PDF বা JSON ফাইল আপলোড করুন।', uploaded: 'আপলোড হয়েছে:', error: 'ফাইল প্রক্রিয়া করা যায়নি। আবার চেষ্টা করুন।' },
      'ta-IN': { invalidFile: 'PDF அல்லது JSON கோப்பை மட்டும் பதிவேற்றவும்।', uploaded: 'பதிவேற்றப்பட்டது:', error: 'கோப்பை செயலாக்க முடியவில்லை। மீண்டும் முயற்சிக்கவும்।' },
      'te-IN': { invalidFile: 'PDF లేదా JSON ఫైల్ మాత్రమే అప్‌లోడ్ చేయండి।', uploaded: 'అప్‌లోడ్ అయింది:', error: 'ఫైల్ ప్రాసెస్ కాలేదు. మళ్ళీ ప్రయత్నించండి.' },
      'kn-IN': { invalidFile: 'PDF ಅಥವಾ JSON ಫೈಲ್ ಮಾತ್ರ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ।', uploaded: 'ಅಪ್‌ಲೋಡ್ ಆಯಿತು:', error: 'ಫೈಲ್ ಪ್ರಕ್ರಿಯೆಗೊಳಿಸಲು ವಿಫಲವಾಯಿತು. ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.' },
    };
    return messages[lang] || messages['en-IN'];
  }, []);

  const handleFileUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');
      const isJson = file.type === 'application/json' || file.name.endsWith('.json');
      // Use localStorage as source of truth for language (more reliable than React state)
      const storedLang = typeof window !== 'undefined' ? localStorage.getItem('oorja_language') : null;
      const currentLang = storedLang || responseLanguage;
      console.log(`[Upload] Language: stored=${storedLang}, state=${responseLanguage}, using=${currentLang}`);
      const msgs = getUploadMessages(currentLang);

      if (!isPdf && !isJson) {
        setMessages((prev) => [
          ...prev,
          { role: 'agent', content: msgs.invalidFile },
        ]);
        return;
      }

      setIsLoading(true);
      setMessages((prev) => [...prev, { role: 'user', content: `${msgs.uploaded} ${file.name}` }]);

      try {
        const base64 = await fileToBase64(file);
        const currentSessionId = sessionIdRef.current;
        const res = await chatApi.upload(base64, currentSessionId || undefined, file.name);

        if (res.sessionId) {
          setSessionId(res.sessionId);
          sessionIdRef.current = res.sessionId;
          const willBeAuthenticated = !!res.authToken || isAuthenticatedRef.current;
          storeSessionId(res.sessionId, willBeAuthenticated);
        }

        if (res.authToken) {
          handleAuthToken(res.authToken);
          setIsAuthenticated(true);
          isAuthenticatedRef.current = true;
          if (res.sessionId) {
            storeSessionId(res.sessionId, true);
          }
        }

        if (res.messages && res.messages.length > 0) {
          setMessages((prev) => [
            ...prev,
            ...res.messages.map((m: any) => ({
              role: 'agent' as const,
              content: m.content,
              buttons: m.buttons,
              dashboard: m.dashboard,
              listings: m.listings,
              offerCreated: m.offerCreated,
              topDeals: m.topDeals,
              matchedOffers: m.matchedOffers,
              orderConfirmation: m.orderConfirmation,
              earnings: m.earnings,
              slider: m.slider,
              autoTradeStatus: m.autoTradeStatus,
            })),
          ]);
        }

        // Update response language from upload response
        if (res.responseLanguage) {
          setResponseLanguage(res.responseLanguage);
          if (typeof window !== 'undefined') {
            localStorage.setItem('oorja_language', res.responseLanguage);
          }
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          { role: 'agent', content: msgs.error },
        ]);
      } finally {
        setIsLoading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [responseLanguage, getUploadMessages]
  );

  // Handle voice result directly (avoids double processing)
  const handleVoiceResult = useCallback(
    (result: {
      transcript: string;
      language?: string;
      sessionId?: string;
      messages?: Array<{ role: string; content: string; buttons?: Array<{ text: string; callbackData?: string }> }>;
      authToken?: string;
      responseLanguage?: string;
      voiceOutputEnabled?: boolean;
      autoVoice?: boolean; // Auto-play TTS when input was voice
    }) => {
      // Validate transcript
      if (!result.transcript || !result.transcript.trim()) {
        console.warn('[Chat] Empty transcript received from voice input');
        return;
      }

      // Add user's voice transcript as a message
      setMessages((prev) => [...prev, { role: 'user', content: result.transcript }]);

      // Update session ID if provided
      if (result.sessionId) {
        setSessionId(result.sessionId);
        sessionIdRef.current = result.sessionId;
        const willBeAuthenticated = !!result.authToken || isAuthenticatedRef.current;
        storeSessionId(result.sessionId, willBeAuthenticated);
      }

      // Handle auth token
      if (result.authToken) {
        handleAuthToken(result.authToken);
        setIsAuthenticated(true);
        isAuthenticatedRef.current = true;
        if (result.sessionId) {
          storeSessionId(result.sessionId, true);
        }
      }

      // Add agent messages
      const agentMessages = result.messages;
      if (agentMessages && agentMessages.length > 0) {
        setMessages((prev) => [
          ...prev,
          ...agentMessages.map((m: any) => ({
            role: 'agent' as const,
            content: m.content,
            buttons: m.buttons,
            dashboard: m.dashboard,
            listings: m.listings,
            offerCreated: m.offerCreated,
            topDeals: m.topDeals,
            matchedOffers: m.matchedOffers,
            orderConfirmation: m.orderConfirmation,
            earnings: m.earnings,
            slider: m.slider,
            autoTradeStatus: m.autoTradeStatus,
          })),
        ]);
      }

      // Update response language and persist to localStorage
      if (result.responseLanguage) {
        setResponseLanguage(result.responseLanguage);
        if (typeof window !== 'undefined') {
          localStorage.setItem('oorja_language', result.responseLanguage);
        }
      }

      // Sync voice preference from server
      if (result.voiceOutputEnabled !== undefined) {
        window.dispatchEvent(new CustomEvent('voice:preference', {
          detail: { enabled: result.voiceOutputEnabled }
        }));
      }

      // Auto-play voice response when input was voice
      if (result.autoVoice && agentMessages && agentMessages.length > 0) {
        // Dispatch event to trigger TTS playback of the agent's response
        const textToSpeak = agentMessages.map(m => m.content).join('\n');
        window.dispatchEvent(new CustomEvent('voice:autoplay', {
          detail: { text: textToSpeak, language: result.responseLanguage }
        }));
      }
    },
    []
  );

  return {
    messages,
    input,
    setInput,
    isLoading,
    sessionId,
    fileInputRef,
    handleSend,
    handleKeyDown,
    handleButtonClick,
    handleReset,
    handleFileUpload,
    handleVoiceResult,
    sendMessageToAgent,
    responseLanguage,
    setResponseLanguage,
  };
}
