'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Speaker } from './use-audio-player';

/**
 * Voice settings stored in localStorage
 */
export interface VoiceSettings {
  /** Auto-play TTS responses when they arrive */
  autoPlay: boolean;
  /** Preferred TTS speaker voice */
  speaker: Speaker;
  /** Speech pace (0.3 - 3.0) */
  pace: number;
}

const STORAGE_KEY = 'oorja_voice_settings';

const DEFAULT_SETTINGS: VoiceSettings = {
  autoPlay: false,
  speaker: 'anushka',
  pace: 1.0,
};

/**
 * Load settings from localStorage
 */
function loadSettings(): VoiceSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
      };
    }
  } catch (e) {
    console.warn('[VoiceSettings] Failed to load settings:', e);
  }
  
  return DEFAULT_SETTINGS;
}

/**
 * Save settings to localStorage
 */
function saveSettings(settings: VoiceSettings) {
  if (typeof window === 'undefined') return;
  
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('[VoiceSettings] Failed to save settings:', e);
  }
}

/**
 * Hook for managing voice input/output settings with persistence
 * 
 * IMPORTANT: Auto-play only activates when user explicitly enables it in THIS session.
 * Even if autoPlay was true from a previous session, it won't auto-play until toggled.
 */
export function useVoiceSettings() {
  const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
  const [isLoaded, setIsLoaded] = useState(false);
  // Session-based tracking: auto-play only works after user explicitly enables it THIS session
  // This is NOT persisted - resets to false on every page load
  const [enabledInSession, setEnabledInSession] = useState(false);

  // Load settings on mount (but don't enable auto-play until user toggles it)
  useEffect(() => {
    setSettings(loadSettings());
    setIsLoaded(true);
    // Note: enabledInSession stays false until user explicitly toggles
  }, []);

  /**
   * Update a single setting
   */
  const updateSetting = useCallback(<K extends keyof VoiceSettings>(
    key: K,
    value: VoiceSettings[K]
  ) => {
    setSettings(prev => {
      const updated = { ...prev, [key]: value };
      saveSettings(updated);
      return updated;
    });
  }, []);

  /**
   * Update multiple settings at once
   */
  const updateSettings = useCallback((partial: Partial<VoiceSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...partial };
      saveSettings(updated);
      return updated;
    });
  }, []);

  /**
   * Toggle auto-play on/off
   * When turning ON, also marks as enabled in this session
   * When turning OFF, also resets session tracking
   */
  const toggleAutoPlay = useCallback(() => {
    setSettings(prev => {
      const newValue = !prev.autoPlay;
      const updated = { ...prev, autoPlay: newValue };
      saveSettings(updated);
      // Update session tracking
      setEnabledInSession(newValue);
      return updated;
    });
  }, []);

  /**
   * Set auto-play to a specific value (used for server sync)
   * Updates session tracking accordingly
   */
  const setAutoPlay = useCallback((value: boolean) => {
    setSettings(prev => {
      const updated = { ...prev, autoPlay: value };
      saveSettings(updated);
      // Update session tracking
      setEnabledInSession(value);
      return updated;
    });
  }, []);

  /**
   * Reset to defaults
   */
  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
    setEnabledInSession(false);
  }, []);

  return {
    ...settings,
    isLoaded,
    // Auto-play is only truly active when both settings say ON and user enabled it this session
    isAutoPlayActive: settings.autoPlay && enabledInSession,
    enabledInSession,
    updateSetting,
    updateSettings,
    toggleAutoPlay,
    setAutoPlay,
    resetSettings,
  };
}
