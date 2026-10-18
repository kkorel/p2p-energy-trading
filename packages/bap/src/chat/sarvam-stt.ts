/**
 * Sarvam AI Speech-to-Text Integration
 * 
 * Uses Sarvam's Saarika model for speech-to-text (native script).
 * Saarika auto-detects the input language and outputs transcript in the original language,
 * so Hindi speech appears as देवनागरी, not English.
 * 
 * Supported languages: Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam,
 * Marathi, Gujarati, Punjabi, Odia, and English.
 * 
 * API Documentation: https://docs.sarvam.ai/api-reference-docs/endpoints/speech-to-text
 */

import axios from 'axios';
import FormData from 'form-data';
import { createLogger } from '@p2p/shared';

const logger = createLogger('SarvamSTT');

// Configuration
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const MAX_AUDIO_SIZE_BYTES = 10 * 1024 * 1024; // 10MB max
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Transcription result from Sarvam STT
 */
export interface TranscriptionResult {
  /** Transcript in original language (native script) */
  transcript: string;
  /** Detected source language code (e.g., 'hi-IN', 'ta-IN') */
  languageCode: string;
  /** Human-readable language name */
  languageName: string;
  /** Processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Error types for STT operations
 */
export type STTErrorType = 
  | 'api_key_missing'
  | 'audio_too_large'
  | 'invalid_audio'
  | 'transcription_failed'
  | 'network_error'
  | 'rate_limited'
  | 'empty_transcript';

/**
 * STT Error with detailed information
 */
export class STTError extends Error {
  type: STTErrorType;
  retryable: boolean;
  
  constructor(type: STTErrorType, message: string, retryable = false) {
    super(message);
    this.name = 'STTError';
    this.type = type;
    this.retryable = retryable;
  }
}

/**
 * Language code to human-readable name mapping
 */
const LANGUAGE_NAMES: Record<string, string> = {
  'hi-IN': 'Hindi',
  'bn-IN': 'Bengali',
  'ta-IN': 'Tamil',
  'te-IN': 'Telugu',
  'kn-IN': 'Kannada',
  'ml-IN': 'Malayalam',
  'mr-IN': 'Marathi',
  'gu-IN': 'Gujarati',
  'pa-IN': 'Punjabi',
  'od-IN': 'Odia',
  'en-IN': 'English',
  'en': 'English',
};

/**
 * Check if STT is available (API key is configured)
 */
export function isSTTAvailable(): boolean {
  return !!SARVAM_API_KEY;
}

/**
 * Supported MIME types for audio input
 */
const SUPPORTED_MIME_TYPES = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/flac',
  'audio/aac',
]);

/**
 * Get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType: string): string {
  const baseMime = mimeType.split(';')[0].trim();
  const extensions: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'mp4',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/aac': 'aac',
  };
  return extensions[baseMime] || 'webm';
}

/**
 * Validate audio input
 */
function validateAudio(audioBuffer: Buffer, mimeType: string): void {
  // Check size
  if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
    throw new STTError(
      'audio_too_large',
      `Audio file too large (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
      false
    );
  }
  
  // Check minimum size (likely too short or corrupted)
  if (audioBuffer.length < 1000) {
    throw new STTError(
      'invalid_audio',
      'Audio file too small. Recording may have failed.',
      true
    );
  }
  
  // Check MIME type
  const baseMime = mimeType.split(';')[0].trim();
  if (!SUPPORTED_MIME_TYPES.has(mimeType) && !SUPPORTED_MIME_TYPES.has(baseMime)) {
    logger.warn(`Unsupported MIME type: ${mimeType}, proceeding anyway`);
  }
}

/**
 * Transcribe audio using Sarvam Saaras model
 * 
 * @param audioBuffer - Audio data as Buffer
 * @param mimeType - MIME type of the audio (e.g., 'audio/webm')
 * @returns Transcription result with native-script text and detected language
 * @throws STTError on failure
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string
): Promise<TranscriptionResult> {
  const startTime = Date.now();
  
  // Check API key
  if (!SARVAM_API_KEY) {
    throw new STTError(
      'api_key_missing',
      'Sarvam API key not configured. Voice input is unavailable.',
      false
    );
  }
  
  // Validate input
  validateAudio(audioBuffer, mimeType);
  
  // Prepare form data
  const extension = getExtensionFromMimeType(mimeType);
  const filename = `audio.${extension}`;
  
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename,
    contentType: mimeType.split(';')[0].trim(),
  });
  formData.append('model', 'saarika:v2.5');
  
  logger.info(`Transcribing audio: ${(audioBuffer.length / 1024).toFixed(1)}KB, ${mimeType}`);
  
  try {
    // Make API request with axios
    const response = await axios.post(SARVAM_STT_URL, formData, {
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        ...formData.getHeaders(),
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true, // Don't throw on HTTP errors
    });
    
    // Handle HTTP errors
    if (response.status !== 200) {
      const errorText = typeof response.data === 'string' 
        ? response.data 
        : JSON.stringify(response.data) || 'Unknown error';
      
      if (response.status === 429) {
        throw new STTError(
          'rate_limited',
          'Too many requests. Please wait a moment and try again.',
          true
        );
      }
      
      if (response.status >= 500) {
        throw new STTError(
          'network_error',
          'Sarvam service temporarily unavailable. Please try again.',
          true
        );
      }
      
      logger.error(`Sarvam STT error [${response.status}]: ${errorText}`);
      throw new STTError(
        'transcription_failed',
        'Could not transcribe audio. Please try speaking more clearly.',
        true
      );
    }
    
    // Parse response
    const data = response.data;
    
    const transcript = data.transcript?.trim() || '';
    const languageCode = data.language_code || 'en-IN';
    
    // Check for empty transcript
    if (!transcript) {
      throw new STTError(
        'empty_transcript',
        'No speech detected. Please speak clearly and try again.',
        true
      );
    }
    
    const processingTimeMs = Date.now() - startTime;
    
    logger.info(`Transcription complete in ${processingTimeMs}ms: "${transcript.substring(0, 50)}..." [${languageCode}]`);
    
    return {
      transcript,
      languageCode,
      languageName: LANGUAGE_NAMES[languageCode] || languageCode,
      processingTimeMs,
    };
    
  } catch (error: unknown) {
    // Re-throw STTError as-is
    if (error instanceof STTError) {
      throw error;
    }
    
    // Handle axios errors
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new STTError(
          'network_error',
          'Request timed out. Please check your connection and try again.',
          true
        );
      }
      
      if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        throw new STTError(
          'network_error',
          'Network error. Please check your connection.',
          true
        );
      }
    }
    
    // Unknown error
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Unexpected STT error: ${message}`);
    throw new STTError(
      'transcription_failed',
      'Something went wrong. Please try again.',
      true
    );
  }
}

/**
 * Transcribe audio from base64 string
 * 
 * @param base64Audio - Base64 encoded audio data
 * @param mimeType - MIME type of the audio
 * @returns Transcription result
 */
export async function transcribeBase64Audio(
  base64Audio: string,
  mimeType: string
): Promise<TranscriptionResult> {
  const audioBuffer = Buffer.from(base64Audio, 'base64');
  return transcribeAudio(audioBuffer, mimeType);
}
