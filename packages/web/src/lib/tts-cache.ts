'use client';

/**
 * Global TTS Cache
 *
 * Shared cache for pre-fetched TTS audio data URLs.
 * When a bot message arrives, we fire off a background TTS request
 * and store the result here. The useAudioPlayer hook checks this
 * cache first, so clicking the speaker button plays instantly.
 */

import { chatApi } from './api';

interface CachedEntry {
  dataUrl: string;
  timestamp: number;
}

const MAX_ENTRIES = 30;
const cache = new Map<string, CachedEntry>();
const inflight = new Set<string>();

/** Same hash used by useAudioPlayer */
function getCacheKey(text: string, languageCode: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${languageCode}:${hash}:${text.length}`;
}

/** Check if a given text+language is already cached */
export function hasCached(text: string, languageCode: string): boolean {
  return cache.has(getCacheKey(text, languageCode));
}

/** Get a cached data URL (or undefined) */
export function getCached(text: string, languageCode: string): string | undefined {
  return cache.get(getCacheKey(text, languageCode))?.dataUrl;
}

/** Store a data URL in the shared cache */
export function setCached(text: string, languageCode: string, dataUrl: string): void {
  const key = getCacheKey(text, languageCode);
  cache.set(key, { dataUrl, timestamp: Date.now() });

  // Evict oldest entries if over limit
  if (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

/**
 * Pre-fetch TTS audio in the background.
 * Silently stores the result in the shared cache.
 * Does nothing if already cached or already in-flight.
 */
export function prefetchTTS(
  text: string,
  languageCode: string,
  speaker: string = 'anushka',
  pace: number = 1.0,
): void {
  if (!text || text.length === 0) return;

  const key = getCacheKey(text, languageCode);
  if (cache.has(key) || inflight.has(key)) return;

  inflight.add(key);

  chatApi.tts(text, languageCode, speaker, pace)
    .then((res) => {
      const dataUrl = `data:${res.mimeType};base64,${res.audio}`;
      cache.set(key, { dataUrl, timestamp: Date.now() });

      if (cache.size > MAX_ENTRIES) {
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
    })
    .catch(() => {
      // Silently ignore – user can still fetch on click
    })
    .finally(() => {
      inflight.delete(key);
    });
}
