'use client';

/**
 * Global Audio Manager
 * 
 * Ensures only one audio plays at a time across the entire app.
 * All audio playback should go through this manager.
 */

type AudioCallback = () => void;

interface AudioState {
  audio: HTMLAudioElement | null;
  isPlaying: boolean;
  currentId: string | null;
  onStopCallbacks: Map<string, AudioCallback>;
}

// Global singleton state
const state: AudioState = {
  audio: null,
  isPlaying: false,
  currentId: null,
  onStopCallbacks: new Map(),
};

/**
 * Stop any currently playing audio
 */
export function stopGlobalAudio(): void {
  if (state.audio) {
    state.audio.pause();
    state.audio.src = '';
    state.audio.onended = null;
    state.audio.onerror = null;
  }
  
  // Notify the previous player that it was stopped
  if (state.currentId) {
    const callback = state.onStopCallbacks.get(state.currentId);
    if (callback) {
      callback();
    }
  }
  
  state.isPlaying = false;
  state.currentId = null;
}

/**
 * Play audio through the global manager
 * Automatically stops any other playing audio first
 */
export function playGlobalAudio(
  audio: HTMLAudioElement,
  playerId: string,
  onStopped?: AudioCallback
): void {
  // Stop any currently playing audio first
  stopGlobalAudio();
  
  // Set up the new audio
  state.audio = audio;
  state.currentId = playerId;
  state.isPlaying = true;
  
  // Register the stop callback
  if (onStopped) {
    state.onStopCallbacks.set(playerId, onStopped);
  }
  
  // Clean up when this audio ends
  const originalOnEnded = audio.onended;
  audio.onended = (e) => {
    state.isPlaying = false;
    state.currentId = null;
    state.onStopCallbacks.delete(playerId);
    if (originalOnEnded) {
      (originalOnEnded as EventListener)(e);
    }
  };
  
  const originalOnError = audio.onerror;
  audio.onerror = (e) => {
    state.isPlaying = false;
    state.currentId = null;
    state.onStopCallbacks.delete(playerId);
    if (originalOnError) {
      (originalOnError as OnErrorEventHandler)?.(e as Event);
    }
  };
}

/**
 * Check if a specific player is currently playing
 */
export function isPlayerActive(playerId: string): boolean {
  return state.isPlaying && state.currentId === playerId;
}

/**
 * Check if any audio is currently playing
 */
export function isAnyAudioPlaying(): boolean {
  return state.isPlaying;
}

/**
 * Get the ID of the currently playing audio
 */
export function getCurrentPlayerId(): string | null {
  return state.currentId;
}

/**
 * Remove a player's stop callback (cleanup)
 */
export function unregisterPlayer(playerId: string): void {
  state.onStopCallbacks.delete(playerId);
}
