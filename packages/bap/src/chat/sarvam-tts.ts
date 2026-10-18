/**
 * Sarvam AI Text-to-Speech Integration
 * 
 * Uses Sarvam's Bulbul model for high-quality Indian language TTS.
 * Bulbul supports natural-sounding speech with human-like prosody
 * across 11 Indian languages.
 * 
 * API Documentation: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
 */

import axios from 'axios';
import { createLogger } from '@p2p/shared';

const logger = createLogger('SarvamTTS');

// Configuration
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';
const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const MAX_TEXT_LENGTH = 1500; // Bulbul v2 limit
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Available voice speakers for Bulbul v2
 * Per Sarvam docs: https://docs.sarvam.ai/api-reference-docs/endpoints/text-to-speech
 */
export type TTSSpeaker =
  | 'anushka'  // Female
  | 'manisha'  // Female
  | 'vidya'    // Female
  | 'arya'     // Female
  | 'abhilash' // Male, North Indian (default)
  | 'karun'    // Male
  | 'hitesh';  // Male

// Default voice configuration
export const DEFAULT_SPEAKER: TTSSpeaker = 'abhilash'; // Male, North Indian voice
export const DEFAULT_PACE = 0.85; // Slightly slower for clarity

/**
 * Options for text-to-speech synthesis
 */
export interface TTSOptions {
  /** Text to synthesize (max 1500 characters) */
  text: string;
  /** Target language code (e.g., 'hi-IN', 'ta-IN', 'en-IN') */
  languageCode: string;
  /** Voice speaker (default: 'anushka' for female voice) */
  speaker?: TTSSpeaker;
  /** Speech pace: 0.3-3.0 (default: 1.0) */
  pace?: number;
  /** Pitch adjustment: -0.75 to 0.75 (default: 0) */
  pitch?: number;
  /** Loudness: 0.1-3.0 (default: 1.0) */
  loudness?: number;
  /** Sample rate in Hz (default: 22050) */
  sampleRate?: 8000 | 16000 | 22050 | 24000;
}

/**
 * Result from TTS synthesis
 */
export interface TTSResult {
  /** Base64 encoded WAV audio */
  audio: string;
  /** Audio duration in milliseconds (estimated) */
  durationMs: number;
  /** Language used for synthesis */
  languageCode: string;
  /** Request ID from Sarvam API */
  requestId?: string;
}

/**
 * TTS Error types
 */
export type TTSErrorType = 
  | 'api_key_missing'
  | 'text_too_long'
  | 'invalid_language'
  | 'synthesis_failed'
  | 'network_error'
  | 'rate_limited';

/**
 * TTS Error with detailed information
 */
export class TTSError extends Error {
  type: TTSErrorType;
  retryable: boolean;
  
  constructor(type: TTSErrorType, message: string, retryable = false) {
    super(message);
    this.name = 'TTSError';
    this.type = type;
    this.retryable = retryable;
  }
}

/**
 * Supported languages for TTS
 */
const SUPPORTED_LANGUAGES = new Set([
  'en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN',
  'kn-IN', 'ml-IN', 'mr-IN', 'gu-IN', 'pa-IN', 'od-IN'
]);

/**
 * Check if TTS is available (API key is configured)
 */
export function isTTSAvailable(): boolean {
  return !!SARVAM_API_KEY;
}

/**
 * Check if a language is supported for TTS
 */
export function isLanguageSupported(languageCode: string): boolean {
  return SUPPORTED_LANGUAGES.has(languageCode);
}

/**
 * Split text into chunks that fit within the character limit.
 * Tries to split on sentence boundaries for natural speech.
 */
function splitTextIntoChunks(text: string, maxLength: number = MAX_TEXT_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  
  const chunks: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    
    // Try to split at sentence boundary
    let splitPoint = maxLength;
    const sentenceEnd = remaining.substring(0, maxLength).lastIndexOf('। '); // Hindi sentence end
    const periodEnd = remaining.substring(0, maxLength).lastIndexOf('. ');
    const questionEnd = remaining.substring(0, maxLength).lastIndexOf('? ');
    
    const bestEnd = Math.max(sentenceEnd, periodEnd, questionEnd);
    if (bestEnd > maxLength * 0.5) {
      splitPoint = bestEnd + 2; // Include the punctuation and space
    } else {
      // Fall back to word boundary
      const spaceEnd = remaining.substring(0, maxLength).lastIndexOf(' ');
      if (spaceEnd > maxLength * 0.5) {
        splitPoint = spaceEnd + 1;
      }
    }
    
    chunks.push(remaining.substring(0, splitPoint).trim());
    remaining = remaining.substring(splitPoint).trim();
  }
  
  return chunks;
}

/**
 * Synthesize speech from text using Sarvam Bulbul model
 * 
 * @param options - TTS options including text and language
 * @returns TTS result with base64 audio
 * @throws TTSError on failure
 */
export async function synthesizeSpeech(options: TTSOptions): Promise<TTSResult> {
  const startTime = Date.now();
  
  // Check API key
  if (!SARVAM_API_KEY) {
    throw new TTSError(
      'api_key_missing',
      'Sarvam API key not configured. Voice output is unavailable.',
      false
    );
  }
  
  // Validate language
  if (!isLanguageSupported(options.languageCode)) {
    logger.warn(`Language ${options.languageCode} not officially supported, trying anyway`);
  }
  
  // Validate text length
  if (options.text.length > MAX_TEXT_LENGTH) {
    throw new TTSError(
      'text_too_long',
      `Text too long (${options.text.length} chars). Maximum is ${MAX_TEXT_LENGTH} characters.`,
      false
    );
  }
  
  // Prepare request body
  const requestBody: Record<string, any> = {
    text: options.text,
    target_language_code: options.languageCode,
    speaker: options.speaker || DEFAULT_SPEAKER,
    model: 'bulbul:v2',
    enable_preprocessing: true,
    // Apply default pace for slower, clearer speech
    pace: Math.max(0.3, Math.min(3.0, options.pace ?? DEFAULT_PACE)),
  };
  if (options.pitch !== undefined) {
    requestBody.pitch = Math.max(-0.75, Math.min(0.75, options.pitch));
  }
  if (options.loudness !== undefined) {
    requestBody.loudness = Math.max(0.1, Math.min(3.0, options.loudness));
  }
  if (options.sampleRate !== undefined) {
    requestBody.speech_sample_rate = options.sampleRate;
  }
  
  logger.info(`Synthesizing speech: ${options.text.substring(0, 50)}... [${options.languageCode}] [${options.speaker || DEFAULT_SPEAKER}]`);
  
  try {
    const response = await axios.post(SARVAM_TTS_URL, requestBody, {
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
    
    // Handle HTTP errors
    if (response.status !== 200) {
      const errorText = typeof response.data === 'string'
        ? response.data
        : JSON.stringify(response.data) || 'Unknown error';
      
      if (response.status === 429) {
        throw new TTSError(
          'rate_limited',
          'Too many requests. Please wait a moment and try again.',
          true
        );
      }
      
      if (response.status >= 500) {
        throw new TTSError(
          'network_error',
          'Sarvam service temporarily unavailable. Please try again.',
          true
        );
      }
      
      logger.error(`Sarvam TTS error [${response.status}]: ${errorText}`);
      throw new TTSError(
        'synthesis_failed',
        'Could not generate speech. Please try again.',
        true
      );
    }
    
    // Parse response
    const data = response.data;
    
    // Sarvam returns an array of audio base64 strings in 'audios' field
    const audioBase64 = data.audios?.[0];
    if (!audioBase64) {
      throw new TTSError(
        'synthesis_failed',
        'No audio generated. Please try again.',
        true
      );
    }
    
    const processingTimeMs = Date.now() - startTime;
    
    // Estimate duration based on text length and pace
    // Average speaking rate is ~150 words per minute, ~5 chars per word
    const wordsEstimate = options.text.length / 5;
    const pace = options.pace || 1.0;
    const durationMs = Math.round((wordsEstimate / 150) * 60 * 1000 / pace);
    
    logger.info(`TTS complete in ${processingTimeMs}ms, estimated duration: ${durationMs}ms`);
    
    return {
      audio: audioBase64,
      durationMs,
      languageCode: options.languageCode,
      requestId: data.request_id,
    };
    
  } catch (error: unknown) {
    // Re-throw TTSError as-is
    if (error instanceof TTSError) {
      throw error;
    }
    
    // Handle axios errors
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new TTSError(
          'network_error',
          'Request timed out. Please check your connection and try again.',
          true
        );
      }
      
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        throw new TTSError(
          'network_error',
          'Network error. Please check your connection.',
          true
        );
      }
    }
    
    // Unknown error
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Unexpected TTS error: ${message}`);
    throw new TTSError(
      'synthesis_failed',
      'Something went wrong. Please try again.',
      true
    );
  }
}

/**
 * Synthesize speech for long text by chunking and concatenating.
 * Returns multiple audio segments that should be played in sequence.
 * 
 * @param text - Full text to synthesize (can exceed MAX_TEXT_LENGTH)
 * @param languageCode - Target language code
 * @param options - Additional TTS options
 * @returns Array of TTS results, one per chunk
 */
export async function synthesizeLongText(
  text: string,
  languageCode: string,
  options?: Partial<Omit<TTSOptions, 'text' | 'languageCode'>>
): Promise<TTSResult[]> {
  const chunks = splitTextIntoChunks(text);
  
  logger.info(`Synthesizing long text: ${chunks.length} chunks, total ${text.length} chars`);
  
  const results: TTSResult[] = [];
  for (const chunk of chunks) {
    const result = await synthesizeSpeech({
      text: chunk,
      languageCode,
      ...options,
    });
    results.push(result);
  }
  
  return results;
}
