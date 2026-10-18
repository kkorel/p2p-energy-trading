'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Voice input states for UI feedback
 */
export type VoiceState = 'idle' | 'requesting' | 'recording' | 'processing' | 'error';

/**
 * Error types with user-friendly messages
 */
export type VoiceErrorType =
  | 'permission_denied'
  | 'no_microphone'
  | 'not_supported'
  | 'recording_failed'
  | 'too_short'
  | 'network_error'
  | 'transcription_failed';

export interface VoiceError {
  type: VoiceErrorType;
  message: string;
  retryable: boolean;
}

const ERROR_MESSAGES: Record<VoiceErrorType, VoiceError> = {
  permission_denied: {
    type: 'permission_denied',
    message: 'Microphone access denied. Please allow access in your browser settings.',
    retryable: true,
  },
  no_microphone: {
    type: 'no_microphone',
    message: 'No microphone detected. Please connect a microphone and try again.',
    retryable: true,
  },
  not_supported: {
    type: 'not_supported',
    message: 'Voice input is not supported in this browser.',
    retryable: false,
  },
  recording_failed: {
    type: 'recording_failed',
    message: 'Recording failed. Please try again.',
    retryable: true,
  },
  too_short: {
    type: 'too_short',
    message: 'Recording was too short. Hold the button a bit longer.',
    retryable: true,
  },
  network_error: {
    type: 'network_error',
    message: 'Connection issue. Please check your internet and try again.',
    retryable: true,
  },
  transcription_failed: {
    type: 'transcription_failed',
    message: "Couldn't understand the audio. Please speak clearly and try again.",
    retryable: true,
  },
};

/**
 * Voice response from the server including agent messages
 */
export interface VoiceResult {
  transcript: string;
  language?: string;
  languageName?: string;
  sessionId?: string;
  messages?: Array<{ role: string; content: string; buttons?: Array<{ text: string; callbackData?: string }> }>;
  authToken?: string;
  responseLanguage?: string;
  voiceOutputEnabled?: boolean;
  /** Auto-play TTS when input was voice */
  autoVoice?: boolean;
}

/**
 * Configuration options for the voice input hook
 */
export interface UseVoiceInputOptions {
  /** Maximum recording duration in seconds (default: 30) */
  maxDuration?: number;
  /** Minimum recording duration in seconds (default: 1) */
  minDuration?: number;
  /** Session ID for chat continuity */
  sessionId?: string;
  /** Callback when transcription is ready (DEPRECATED: use onVoiceResult instead) */
  onTranscript?: (text: string, language?: string) => void;
  /** Callback when voice response is ready (includes agent messages - prevents double processing) */
  onVoiceResult?: (result: VoiceResult) => void;
  /** Callback for audio level updates (0-1) for visualization */
  onAudioLevel?: (level: number) => void;
  /** Callback when recording starts */
  onRecordingStart?: () => void;
  /** Callback when recording stops */
  onRecordingStop?: () => void;
  /** Callback when error occurs */
  onError?: (error: VoiceError) => void;
}

/**
 * Return type for the useVoiceInput hook
 */
export interface UseVoiceInputReturn {
  /** Current voice input state */
  state: VoiceState;
  /** Whether currently recording */
  isRecording: boolean;
  /** Whether processing (transcribing) */
  isProcessing: boolean;
  /** Current error if any */
  error: VoiceError | null;
  /** Recording duration in seconds */
  duration: number;
  /** Current audio level (0-1) for visualization */
  audioLevel: number;
  /** Whether browser supports voice input */
  isSupported: boolean;
  /** Start recording */
  startRecording: () => Promise<void>;
  /** Stop recording and process */
  stopRecording: () => void;
  /** Cancel recording without processing */
  cancelRecording: () => void;
  /** Clear error state */
  clearError: () => void;
  /** Get the recorded audio blob (for debugging/playback) */
  getAudioBlob: () => Blob | null;
}

/**
 * Premium voice input hook with MediaRecorder, audio visualization,
 * and comprehensive state management.
 * 
 * Features:
 * - Smooth state transitions
 * - Real-time audio level monitoring
 * - Automatic duration limiting
 * - Graceful error handling
 * - Proper resource cleanup
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const {
    maxDuration = 30,
    minDuration = 1,
    sessionId,
    onTranscript,
    onVoiceResult,
    onAudioLevel,
    onRecordingStart,
    onRecordingStop,
    onError,
  } = options;

  // State
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<VoiceError | null>(null);
  const [duration, setDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  // Refs for cleanup
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioBlobRef = useRef<Blob | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const levelAnimationRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  // Check browser support - use state to avoid hydration mismatch
  const [isSupported, setIsSupported] = useState(false);
  
  // Check support on mount (client-side only)
  useEffect(() => {
    const supported = typeof navigator !== 'undefined' 
      && !!navigator.mediaDevices 
      && !!navigator.mediaDevices.getUserMedia
      && typeof MediaRecorder !== 'undefined';
    setIsSupported(supported);
  }, []);

  /**
   * Clean up all resources
   */
  const cleanup = useCallback(() => {
    // Stop duration timer
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }

    // Stop level animation
    if (levelAnimationRef.current) {
      cancelAnimationFrame(levelAnimationRef.current);
      levelAnimationRef.current = null;
    }

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore errors during cleanup
      }
    }
    mediaRecorderRef.current = null;

    // Close audio context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
    audioContextRef.current = null;
    analyserRef.current = null;

    // Stop media stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Reset state
    chunksRef.current = [];
    setAudioLevel(0);
  }, []);

  /**
   * Set error with callback
   */
  const handleError = useCallback((errorType: VoiceErrorType) => {
    const errorObj = ERROR_MESSAGES[errorType];
    setError(errorObj);
    setState('error');
    onError?.(errorObj);
    cleanup();
  }, [cleanup, onError]);

  /**
   * Start monitoring audio levels for visualization
   */
  const startLevelMonitoring = useCallback(() => {
    if (!analyserRef.current) return;

    const analyser = analyserRef.current;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateLevel = () => {
      if (!analyserRef.current) return;

      analyser.getByteFrequencyData(dataArray);
      
      // Calculate RMS (root mean square) for smoother level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      
      // Normalize to 0-1 range with some smoothing
      const normalizedLevel = Math.min(1, rms / 128);
      
      setAudioLevel(normalizedLevel);
      onAudioLevel?.(normalizedLevel);

      levelAnimationRef.current = requestAnimationFrame(updateLevel);
    };

    updateLevel();
  }, [onAudioLevel]);

  /**
   * Start recording
   */
  const startRecording = useCallback(async () => {
    if (!isSupported) {
      handleError('not_supported');
      return;
    }

    if (state === 'recording' || state === 'processing') {
      return;
    }

    setError(null);
    setState('requesting');

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000, // Optimal for speech recognition
        },
      });

      streamRef.current = stream;

      // Set up audio context for level monitoring
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      // Determine best supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/wav';

      // Create media recorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000,
      });

      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onerror = () => {
        handleError('recording_failed');
      };

      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms
      startTimeRef.current = Date.now();
      setState('recording');
      setDuration(0);
      onRecordingStart?.();

      // Start duration timer
      durationIntervalRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setDuration(elapsed);

        // Auto-stop at max duration
        if (elapsed >= maxDuration) {
          stopRecording();
        }
      }, 100);

      // Start level monitoring
      startLevelMonitoring();

    } catch (err: unknown) {
      const error = err as Error & { name?: string };
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        handleError('permission_denied');
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        handleError('no_microphone');
      } else {
        handleError('recording_failed');
      }
    }
  }, [isSupported, state, maxDuration, handleError, onRecordingStart, startLevelMonitoring]);

  /**
   * Stop recording and process the audio
   */
  const stopRecording = useCallback(() => {
    if (state !== 'recording' || !mediaRecorderRef.current) {
      return;
    }

    const recordedDuration = (Date.now() - startTimeRef.current) / 1000;

    // Check minimum duration
    if (recordedDuration < minDuration) {
      handleError('too_short');
      return;
    }

    onRecordingStop?.();

    // Stop the media recorder and wait for final data
    const mediaRecorder = mediaRecorderRef.current;

    mediaRecorder.onstop = async () => {
      setState('processing');

      // Create blob from chunks
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(chunksRef.current, { type: mimeType });
      audioBlobRef.current = audioBlob;

      // Clean up recording resources but keep the blob
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (levelAnimationRef.current) {
        cancelAnimationFrame(levelAnimationRef.current);
        levelAnimationRef.current = null;
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        try {
          await audioContextRef.current.close();
        } catch {
          // Ignore
        }
      }
      audioContextRef.current = null;
      analyserRef.current = null;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }

      setAudioLevel(0);

      // Send to server for transcription
      try {
        const base64Audio = await blobToBase64(audioBlob);
        
        const response = await fetch('/chat/voice', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            audio: base64Audio,
            mimeType: mimeType,
            sessionId: sessionId, // Include sessionId for chat continuity
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          if (response.status >= 500) {
            handleError('network_error');
          } else {
            handleError('transcription_failed');
          }
          return;
        }

        const data = await response.json();

        // Check for success and valid transcript
        if (data.success !== false && data.transcript) {
          setState('idle');
          setDuration(0);
          
          // Prefer onVoiceResult if provided (includes agent messages to avoid double processing)
          if (onVoiceResult) {
            onVoiceResult({
              transcript: data.transcript,
              language: data.language,
              languageName: data.languageName,
              sessionId: data.sessionId,
              messages: data.messages,
              authToken: data.authToken,
              responseLanguage: data.responseLanguage,
              voiceOutputEnabled: data.voiceOutputEnabled,
              autoVoice: data.autoVoice, // Auto-play TTS when input was voice
            });
          } else {
            // Fallback to onTranscript for backwards compatibility
            onTranscript?.(data.transcript, data.language);
          }
        } else {
          // Handle API-level failure or missing transcript
          console.warn('[VoiceInput] API returned failure or no transcript:', data.error || 'No transcript');
          handleError('transcription_failed');
        }
      } catch (err) {
        console.error('[VoiceInput] Transcription error:', err);
        handleError('network_error');
      }
    };

    mediaRecorder.stop();
  }, [state, minDuration, sessionId, handleError, onRecordingStop, onTranscript, onVoiceResult]);

  /**
   * Cancel recording without processing
   */
  const cancelRecording = useCallback(() => {
    cleanup();
    setState('idle');
    setDuration(0);
    setError(null);
    audioBlobRef.current = null;
  }, [cleanup]);

  /**
   * Clear error state
   */
  const clearError = useCallback(() => {
    setError(null);
    setState('idle');
  }, []);

  /**
   * Get the recorded audio blob (for debugging/playback)
   */
  const getAudioBlob = useCallback(() => {
    return audioBlobRef.current;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    state,
    isRecording: state === 'recording',
    isProcessing: state === 'processing',
    error,
    duration,
    audioLevel,
    isSupported,
    startRecording,
    stopRecording,
    cancelRecording,
    clearError,
    getAudioBlob,
  };
}

/**
 * Convert a Blob to base64 string
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:audio/webm;base64,")
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Get auth headers for API requests
 */
function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('authToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}
