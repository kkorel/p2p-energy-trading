'use client';

import { useState, useCallback, useRef, useEffect, useId } from 'react';
import { chatApi } from '@/lib/api';
import { stopGlobalAudio, playGlobalAudio, isPlayerActive } from '@/lib/audio-manager';
import { getCached, setCached } from '@/lib/tts-cache';

/**
 * Audio player state
 */
export type AudioPlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

/**
 * Speaker voice options
 */
export type Speaker = 'anushka' | 'manisha' | 'vidya' | 'arya' | 'abhilash' | 'karun' | 'hitesh';

/**
 * Audio player options
 */
export interface AudioPlayerOptions {
  /** Default speaker voice */
  defaultSpeaker?: Speaker;
  /** Default speech pace (0.3 - 3.0) */
  defaultPace?: number;
  /** Callback when playback completes */
  onComplete?: () => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

/**
 * Cached audio entry - store the data URL, not the audio element
 */
interface CachedAudio {
  dataUrl: string;
  text: string;
  languageCode: string;
}

/**
 * Hook for playing text-to-speech audio with caching
 * Uses global audio manager to ensure only one audio plays at a time across the app
 */
export function useAudioPlayer(options: AudioPlayerOptions = {}) {
  const {
    defaultSpeaker = 'anushka',
    defaultPace = 1.0,
    onComplete,
    onError,
  } = options;

  // Unique ID for this player instance (for global audio coordination)
  const playerId = useId();

  const [state, setState] = useState<AudioPlayerState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentText, setCurrentText] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cacheRef = useRef<Map<string, CachedAudio>>(new Map());
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  // Lock to prevent multiple simultaneous play calls
  const isPlayingLockRef = useRef(false);
  // Track pending promise reject function to cancel previous play
  const pendingRejectRef = useRef<((reason?: Error) => void) | null>(null);

  // Clean up on unmount
  useEffect(() => {
    const currentPlayerId = playerId;
    return () => {
      // Only stop global audio if this player was the one playing
      if (isPlayerActive(currentPlayerId)) {
        stopGlobalAudio();
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, [playerId]);

  /**
   * Generate cache key for text + language
   * Uses a simple hash to avoid collisions for texts that start the same
   */
  const getCacheKey = (text: string, languageCode: string) => {
    // Simple hash function for cache key
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `${languageCode}:${hash}:${text.length}`;
  };

  /**
   * Start progress tracking
   */
  const startProgressTracking = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }
    progressIntervalRef.current = setInterval(() => {
      if (audioRef.current) {
        setProgress(audioRef.current.currentTime);
        setDuration(audioRef.current.duration || 0);
      }
    }, 100);
  }, []);

  /**
   * Stop progress tracking
   */
  const stopProgressTracking = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  /**
   * Play text as speech
   * Returns a Promise that resolves when playback COMPLETES (not when it starts)
   * Automatically stops any previous playback before starting (globally across all players)
   */
  const play = useCallback(async (
    text: string,
    languageCode: string,
    speaker?: Speaker,
    pace?: number
  ): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      // Cancel any pending previous play operation from this player
      if (pendingRejectRef.current) {
        pendingRejectRef.current(new Error('Cancelled by new play request'));
        pendingRejectRef.current = null;
      }
      
      // Store this reject function so it can be cancelled if needed
      pendingRejectRef.current = reject;
      
      // Stop any currently playing audio GLOBALLY (across all players)
      stopGlobalAudio();
      
      // Also clean up our local ref
      if (audioRef.current) {
        audioRef.current.onended = null;
        audioRef.current.onerror = null;
      }
      stopProgressTracking();
      isPlayingLockRef.current = true;

      setCurrentText(text);
      setError(null);
      setProgress(0);

      // Check local cache first, then shared (pre-fetch) cache
      const cacheKey = getCacheKey(text, languageCode);
      let cached = cacheRef.current.get(cacheKey);

      // Fall back to shared pre-fetch cache
      if (!cached) {
        const sharedDataUrl = getCached(text, languageCode);
        if (sharedDataUrl) {
          cached = { dataUrl: sharedDataUrl, text, languageCode };
          cacheRef.current.set(cacheKey, cached);
        }
      }

      if (cached) {
        // Create fresh audio element from cached data URL
        const audio = new Audio(cached.dataUrl);
        
        audio.onended = () => {
          setState('idle');
          stopProgressTracking();
          setProgress(0);
          isPlayingLockRef.current = false;
          pendingRejectRef.current = null;
          onComplete?.();
          resolve();
        };

        audio.onerror = () => {
          setState('error');
          setError('Failed to play cached audio');
          stopProgressTracking();
          isPlayingLockRef.current = false;
          pendingRejectRef.current = null;
          onError?.(new Error('Audio playback failed'));
          reject(new Error('Audio playback failed'));
        };

        audio.onloadedmetadata = () => {
          setDuration(audio.duration);
        };

        audioRef.current = audio;
        
        // Register with global audio manager (stops any other playing audio)
        playGlobalAudio(audio, playerId, () => {
          // Called when another player stops us - must also reject the pending promise
          setState('idle');
          stopProgressTracking();
          setProgress(0);
          isPlayingLockRef.current = false;
          // Reject the pending promise so it doesn't hang
          if (pendingRejectRef.current) {
            pendingRejectRef.current(new Error('Stopped by another player'));
            pendingRejectRef.current = null;
          }
        });
        
        try {
          setState('playing');
          startProgressTracking();
          await audio.play();
        } catch (err) {
          setState('error');
          setError('Failed to play audio');
          isPlayingLockRef.current = false;
          pendingRejectRef.current = null;
          onError?.(err as Error);
          reject(err);
        }
        return;
      }

      // Fetch new audio from TTS API
      setState('loading');

      try {
        const response = await chatApi.tts(
          text,
          languageCode,
          speaker || defaultSpeaker,
          pace || defaultPace
        );

        // Create data URL and audio element
        const dataUrl = `data:${response.mimeType};base64,${response.audio}`;
        const audio = new Audio(dataUrl);
        
        // Set up event handlers
        audio.onended = () => {
          setState('idle');
          stopProgressTracking();
          setProgress(0);
          isPlayingLockRef.current = false;
          pendingRejectRef.current = null;
          onComplete?.();
          resolve(); // Resolve when audio finishes
        };

        audio.onerror = () => {
          setState('error');
          setError('Audio playback failed');
          stopProgressTracking();
          isPlayingLockRef.current = false;
          pendingRejectRef.current = null;
          onError?.(new Error('Audio playback failed'));
          reject(new Error('Audio playback failed'));
        };

        audio.onloadedmetadata = () => {
          setDuration(audio.duration);
        };

        // Cache the data URL (not the audio element) for reuse
        cacheRef.current.set(cacheKey, { dataUrl, text, languageCode });
        setCached(text, languageCode, dataUrl);

        // Keep cache size reasonable (max 20 entries)
        if (cacheRef.current.size > 20) {
          const firstKey = cacheRef.current.keys().next().value;
          if (firstKey) {
            cacheRef.current.delete(firstKey);
          }
        }

        audioRef.current = audio;

        // Register with global audio manager (stops any other playing audio)
        playGlobalAudio(audio, playerId, () => {
          // Called when another player stops us - must also reject the pending promise
          setState('idle');
          stopProgressTracking();
          setProgress(0);
          isPlayingLockRef.current = false;
          // Reject the pending promise so it doesn't hang
          if (pendingRejectRef.current) {
            pendingRejectRef.current(new Error('Stopped by another player'));
            pendingRejectRef.current = null;
          }
        });

        // Play
        setState('playing');
        startProgressTracking();
        await audio.play();
        // Note: Don't resolve here - wait for onended

      } catch (err) {
        console.error('[AudioPlayer] TTS error:', err);
        setState('error');
        setError(err instanceof Error ? err.message : 'Failed to generate speech');
        isPlayingLockRef.current = false;
        pendingRejectRef.current = null;
        onError?.(err as Error);
        reject(err);
      }
    });
  }, [defaultSpeaker, defaultPace, onComplete, onError, startProgressTracking, stopProgressTracking, playerId]);

  /**
   * Pause playback
   */
  const pause = useCallback(() => {
    if (audioRef.current && state === 'playing') {
      audioRef.current.pause();
      setState('paused');
      stopProgressTracking();
    }
  }, [state, stopProgressTracking]);

  /**
   * Resume playback
   */
  const resume = useCallback(async () => {
    if (audioRef.current && state === 'paused') {
      try {
        await audioRef.current.play();
        setState('playing');
        startProgressTracking();
      } catch (err) {
        setState('error');
        setError('Failed to resume playback');
        onError?.(err as Error);
      }
    }
  }, [state, startProgressTracking, onError]);

  /**
   * Stop playback completely
   */
  const stop = useCallback(() => {
    // Clear pending promise reference without rejecting (silent cancellation)
    // The promise will just never resolve, which is fine for stop operations
    pendingRejectRef.current = null;
    
    // Stop globally (this will stop our audio and any other playing audio)
    stopGlobalAudio();
    
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
    }
    setState('idle');
    stopProgressTracking();
    setProgress(0);
    setCurrentText(null);
    isPlayingLockRef.current = false;
  }, [stopProgressTracking]);

  /**
   * Toggle play/pause
   */
  const toggle = useCallback(async (
    text: string,
    languageCode: string,
    speaker?: Speaker,
    pace?: number
  ) => {
    if (state === 'playing' && currentText === text) {
      pause();
    } else if (state === 'paused' && currentText === text) {
      await resume();
    } else {
      await play(text, languageCode, speaker, pace);
    }
  }, [state, currentText, pause, resume, play]);

  /**
   * Clear the cache
   */
  const clearCache = useCallback(() => {
    cacheRef.current.clear();
  }, []);

  return {
    state,
    error,
    currentText,
    progress,
    duration,
    isPlaying: state === 'playing',
    isLoading: state === 'loading',
    isPaused: state === 'paused',
    hasError: state === 'error',
    play,
    pause,
    resume,
    stop,
    toggle,
    clearCache,
  };
}
