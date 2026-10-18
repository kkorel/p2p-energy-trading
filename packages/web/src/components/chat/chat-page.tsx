'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Send, Paperclip, LayoutGrid, TrendingUp, Wallet, Volume2, VolumeX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { MessageList } from './message-list';
import { VoiceButton } from './voice-button';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { useAuth } from '@/contexts/auth-context';
import { useBalance } from '@/contexts/balance-context';
import { useP2PStats } from '@/contexts/p2p-stats-context';
import { useVoiceSettings } from '@/hooks/use-voice-settings';
import { useAudioPlayer } from '@/hooks/use-audio-player';
import { formatCurrency } from '@/lib/utils';

// Localized strings for header UI
const HEADER_TRANSLATIONS: Record<string, { name: string; subtitle: string; placeholder: string }> = {
  'en-IN': { name: 'Oorja', subtitle: 'Energy trading assistant', placeholder: 'Type or speak...' },
  'hi-IN': { name: 'ऊर्जा', subtitle: 'बिजली व्यापार सहायक', placeholder: 'लिखो या बोलो...' },
  'bn-IN': { name: 'ঊর্জা', subtitle: 'বিদ্যুৎ ব্যবসা সহায়ক', placeholder: 'লিখুন বা বলুন...' },
  'ta-IN': { name: 'ஊர்ஜா', subtitle: 'மின்சார வர்த்தக உதவியாளர்', placeholder: 'எழுதுங்கள் அல்லது பேசுங்கள்...' },
  'te-IN': { name: 'ఊర్జా', subtitle: 'విద్యుత్ వ్యాపార సహాయకుడు', placeholder: 'రాయండి లేదా మాట్లాడండి...' },
  'kn-IN': { name: 'ಊರ್ಜಾ', subtitle: 'ವಿದ್ಯುತ್ ವ್ಯಾಪಾರ ಸಹಾಯಕ', placeholder: 'ಬರೆಯಿರಿ ಅಥವಾ ಮಾತನಾಡಿ...' },
};

export function ChatPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const { user, refreshUser } = useAuth();
  const { balance, refreshBalance } = useBalance();
  const { totalValue, isLoading: statsLoading, refresh: refreshStats } = useP2PStats();
  const { isAutoPlayActive, setAutoPlay, speaker, pace, isLoaded: settingsLoaded } = useVoiceSettings();
  const { play: playTTS, stop: stopTTS, isPlaying } = useAudioPlayer({
    defaultSpeaker: speaker,
    defaultPace: pace,
  });
  
  const {
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
    responseLanguage,
    setResponseLanguage,
  } = useChatEngine();

  // Track for auto-play
  const prevMsgCount = useRef(messages.length);
  const lastAutoPlayedIdx = useRef(-1);
  const isInitialized = useRef(false);
  
  // Queue for playing multiple messages sequentially
  const playQueueRef = useRef<string[]>([]);
  const isPlayingQueueRef = useRef(false);
  const queueTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Toast notification for voice toggle
  const [voiceToast, setVoiceToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Flag to skip auto-play effect when toggle just played a message
  const skipAutoPlayOnceRef = useRef(false);
  
  // Initialize: mark existing messages as "already played" to prevent auto-play on load
  useEffect(() => {
    if (!isInitialized.current && settingsLoaded) {
      lastAutoPlayedIdx.current = messages.length - 1;
      isInitialized.current = true;
    }
  }, [settingsLoaded, messages.length]);
  
  // Listen for voice:autoplay events (auto-play TTS when input was voice)
  useEffect(() => {
    const handleAutoVoice = (e: CustomEvent<{ text: string; language?: string }>) => {
      const { text, language } = e.detail;
      if (text) {
        playTTS(text, language || responseLanguage, speaker, pace).catch(() => {});
      }
    };

    window.addEventListener('voice:autoplay', handleAutoVoice as EventListener);
    return () => {
      window.removeEventListener('voice:autoplay', handleAutoVoice as EventListener);
    };
  }, [playTTS, responseLanguage, speaker, pace]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTTS();
      playQueueRef.current = [];
      isPlayingQueueRef.current = false;
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current);
      }
      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
      }
    };
  }, [stopTTS]);
  
  // Enhanced toggle handler with feedback
  const handleVoiceToggle = useCallback(() => {
    const turningOn = !isAutoPlayActive;
    
    // Stop any current playback first
    stopTTS();
    playQueueRef.current = [];
    isPlayingQueueRef.current = false;
    if (queueTimeoutRef.current) {
      clearTimeout(queueTimeoutRef.current);
      queueTimeoutRef.current = null;
    }
    
    // Use setAutoPlay with explicit value (not toggle) to avoid localStorage sync issues
    setAutoPlay(turningOn);
    
    // Show toast feedback
    const message = turningOn ? '🔊 Voice ON' : '🔇 Voice OFF';
    setVoiceToast(message);
    
    // Clear any existing timeout
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    
    // Hide toast after 2 seconds
    toastTimeoutRef.current = setTimeout(() => {
      setVoiceToast(null);
    }, 2000);
    
    // If turning ON and there are agent messages, play the most recent one
    if (turningOn && messages.length > 0) {
      const lastAgentMsg = [...messages].reverse().find(m => m.role === 'agent');
      if (lastAgentMsg && lastAgentMsg.content.length > 0) {
        // Mark messages as played so auto-play effect doesn't duplicate
        lastAutoPlayedIdx.current = messages.length - 1;
        skipAutoPlayOnceRef.current = true;
        
        // Play the latest message
        queueTimeoutRef.current = setTimeout(() => {
          playTTS(lastAgentMsg.content, responseLanguage, speaker, pace).catch(() => {});
        }, 300);
      }
    }
  }, [isAutoPlayActive, setAutoPlay, messages, responseLanguage, speaker, pace, playTTS, stopTTS]);
  
  // Debug: log responseLanguage changes
  useEffect(() => {
    console.log(`[ChatPage] responseLanguage changed to: "${responseLanguage}"`);
  }, [responseLanguage]);

  // Refresh balance + stats when new agent messages arrive (e.g. after auth, offer creation)
  useEffect(() => {
    if (messages.length > prevMsgCount.current && user) {
      refreshBalance();
      refreshStats();
    }
    prevMsgCount.current = messages.length;
  }, [messages.length, user, refreshBalance, refreshStats]);

  // Listen for voice preference sync from server (legacy - kept for backward compatibility)
  useEffect(() => {
    const handleVoicePref = (e: CustomEvent<{ enabled: boolean }>) => {
      if (e.detail?.enabled !== undefined) {
        setAutoPlay(e.detail.enabled);
      }
    };
    window.addEventListener('voice:preference', handleVoicePref as EventListener);
    return () => window.removeEventListener('voice:preference', handleVoicePref as EventListener);
  }, [setAutoPlay]);

  // Play queued messages sequentially
  const playNextInQueue = useCallback(async () => {
    if (playQueueRef.current.length === 0) {
      isPlayingQueueRef.current = false;
      return;
    }
    isPlayingQueueRef.current = true;
    const text = playQueueRef.current.shift()!;
    
    try {
      await playTTS(text, responseLanguage, speaker, pace);
      // Small delay between messages, then play next
      queueTimeoutRef.current = setTimeout(playNextInQueue, 300);
    } catch (err) {
      // Only log if it's not a cancellation or interruption
      const isExpectedError = err instanceof Error && (
        err.message.includes('Cancelled') || 
        err.message.includes('Stopped by')
      );
      if (!isExpectedError) {
        console.error('[AutoPlay] Failed to play:', err);
      }
      // Continue to next message even on error (unless stopped)
      if (!isExpectedError || err instanceof Error && err.message.includes('Cancelled')) {
        queueTimeoutRef.current = setTimeout(playNextInQueue, 100);
      } else {
        // Stopped by another player - don't continue auto-queue
        isPlayingQueueRef.current = false;
      }
    }
  }, [playTTS, responseLanguage, speaker, pace]);

  // Get localized header strings based on response language
  const headerStrings = useMemo(() => {
    return HEADER_TRANSLATIONS[responseLanguage] || HEADER_TRANSLATIONS['en-IN'];
  }, [responseLanguage]);

  // Auto-play TTS for new agent messages
  useEffect(() => {
    // Skip if settings not loaded or not initialized
    if (!settingsLoaded || !isInitialized.current) return;
    
    // Skip if auto-play not active
    if (!isAutoPlayActive) return;
    
    // Skip once if toggle handler just played a message
    if (skipAutoPlayOnceRef.current) {
      skipAutoPlayOnceRef.current = false;
      return;
    }
    
    // Find all new agent messages since last played
    const newAgentMessages: string[] = [];
    for (let i = lastAutoPlayedIdx.current + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'agent' && msg.content.length > 0) {
        newAgentMessages.push(msg.content);
      }
    }
    
    if (newAgentMessages.length === 0) return;
    
    // Update last played index
    lastAutoPlayedIdx.current = messages.length - 1;
    
    // Add to queue and start playing if not already
    playQueueRef.current.push(...newAgentMessages);
    if (!isPlayingQueueRef.current) {
      // Clear any pending timeout and start fresh
      if (queueTimeoutRef.current) {
        clearTimeout(queueTimeoutRef.current);
      }
      // Small delay to let UI update first
      queueTimeoutRef.current = setTimeout(playNextInQueue, 300);
    }
  }, [messages, isAutoPlayActive, settingsLoaded, playNextInQueue]);

  return (
    <div className="flex justify-center min-h-screen bg-gray-100">
      <div className="w-full max-w-[480px] flex flex-col min-h-screen bg-white">
        {/* Header — sticky */}
        <div className="sticky top-0 z-30 flex items-center justify-between px-3.5 py-2.5 bg-teal-600 text-white safe-top">
          {/* Logo and title */}
          <div className="flex items-center gap-2">
            <img src="/oorja-logo.png" alt="Oorja" className="w-9 h-9 rounded-full object-cover" />
            <h1 className="text-2xl font-bold tracking-tight">{headerStrings.name}</h1>
          </div>

          {/* Right side: stacked values + App button */}
          <div className="flex items-center gap-2">
            {/* Stacked currency badges */}
            {user && (
              <div className="flex flex-col gap-1 items-end">
                {!statsLoading && (
                  <div
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                      totalValue >= 0 ? 'bg-white/20' : 'bg-red-500/30'
                    }`}
                    title="P2P Earnings"
                  >
                    <TrendingUp size={11} />
                    <span>{totalValue > 0 ? '+' : ''}{formatCurrency(totalValue)}</span>
                  </div>
                )}
                <div
                  className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 text-xs font-medium"
                  title="Wallet Balance"
                >
                  <Wallet size={11} />
                  <span>{formatCurrency(balance)}</span>
                </div>
              </div>
            )}

            <button
              onClick={async () => {
                await refreshUser();
                router.push('/buy');
              }}
              className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-white/20 hover:bg-white/30 transition-colors text-xs font-medium shrink-0"
              title="Open App"
            >
              <LayoutGrid size={14} />
              <span>App</span>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto bg-gray-50/50">
          <MessageList
            messages={messages}
            onButtonClick={handleButtonClick}
            isLoading={isLoading}
            responseLanguage={responseLanguage}
          />
        </div>

        {/* Input area */}
        <div className="relative border-t border-gray-100 bg-white px-2.5 py-2 safe-bottom">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 rounded-full text-gray-400 hover:text-teal-600 hover:bg-teal-50 transition-colors"
              title="Upload file"
            >
              <Paperclip size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.json,application/pdf,application/json"
              onChange={handleFileUpload}
              className="hidden"
            />
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={headerStrings.placeholder}
              className="flex-1 py-2 px-3.5 bg-gray-100 rounded-full text-[15px] outline-none focus:ring-2 focus:ring-teal-200 transition-all"
              disabled={isLoading}
            />
            {/* Voice input button */}
            <VoiceButton
              sessionId={sessionId || undefined}
              onVoiceResult={(result) => {
                // Update response language for TTS
                if (result.responseLanguage) {
                  setResponseLanguage(result.responseLanguage);
                } else if (result.language) {
                  setResponseLanguage(result.language);
                }
                // Handle the full voice result (includes agent messages - no double processing)
                handleVoiceResult(result);
              }}
              onRecordingStart={() => {
                // Stop any playing TTS when user starts recording
                stopTTS();
                playQueueRef.current = [];
                isPlayingQueueRef.current = false;
                if (queueTimeoutRef.current) {
                  clearTimeout(queueTimeoutRef.current);
                  queueTimeoutRef.current = null;
                }
              }}
              disabled={isLoading}
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isLoading}
              className="p-2 rounded-full bg-teal-600 text-white disabled:opacity-40 hover:bg-teal-700 transition-colors"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
