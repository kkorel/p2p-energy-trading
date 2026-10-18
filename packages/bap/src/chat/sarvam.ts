/**
 * Sarvam AI — Indian language translation for Oorja chat agent.
 * Uses Sarvam's Mayura model for auto-detection + translation.
 * Supports 12 Indian languages with colloquial modes.
 */

import axios from 'axios';
import { createLogger } from '@p2p/shared';

const logger = createLogger('Sarvam');

const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';
const SARVAM_BASE_URL = 'https://api.sarvam.ai';
const MAX_CHARS = 900; // mayura:v1 limit is 1000, leave margin

// Supported language codes
export type SarvamLangCode =
  | 'en-IN' | 'hi-IN' | 'bn-IN' | 'gu-IN' | 'kn-IN'
  | 'ml-IN' | 'mr-IN' | 'od-IN' | 'pa-IN' | 'ta-IN' | 'te-IN';

/** Unicode script ranges for Indian languages */
const SCRIPT_RANGES: Array<{ lang: SarvamLangCode; ranges: Array<[number, number]> }> = [
  { lang: 'hi-IN', ranges: [[0x0900, 0x097F]] }, // Devanagari (Hindi, Marathi, Sanskrit)
  { lang: 'bn-IN', ranges: [[0x0980, 0x09FF]] }, // Bengali
  { lang: 'gu-IN', ranges: [[0x0A80, 0x0AFF]] }, // Gujarati
  { lang: 'pa-IN', ranges: [[0x0A00, 0x0A7F]] }, // Gurmukhi (Punjabi)
  { lang: 'ta-IN', ranges: [[0x0B80, 0x0BFF]] }, // Tamil
  { lang: 'te-IN', ranges: [[0x0C00, 0x0C7F]] }, // Telugu
  { lang: 'kn-IN', ranges: [[0x0C80, 0x0CFF]] }, // Kannada
  { lang: 'ml-IN', ranges: [[0x0D00, 0x0D7F]] }, // Malayalam
  { lang: 'od-IN', ranges: [[0x0B00, 0x0B7F]] }, // Odia
];




/**
 * Detect language from text using Unicode script analysis.
 * Returns the detected language code or 'en-IN' (default).
 * Note: Roman script text is detected as English. Users who want Hindi
 * should speak/type in Devanagari or use voice input.
 */
export function detectLanguage(text: string): SarvamLangCode {
  const counts: Record<string, number> = {};

  for (const char of text) {
    const code = char.codePointAt(0)!;
    for (const { lang, ranges } of SCRIPT_RANGES) {
      for (const [start, end] of ranges) {
        if (code >= start && code <= end) {
          counts[lang] = (counts[lang] || 0) + 1;
        }
      }
    }
  }

  // Find the script with the most characters
  let maxLang: SarvamLangCode = 'en-IN';
  let maxCount = 0;
  for (const [lang, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxLang = lang as SarvamLangCode;
    }
  }

  // Need at least 2 Indic characters to consider it a native script
  if (maxCount >= 2) return maxLang;

  return 'en-IN';
}

/**
 * Translate text using Sarvam AI's Mayura model.
 * Returns original text if translation fails or is not configured.
 */
async function translate(
  text: string,
  sourceLang: SarvamLangCode | 'auto',
  targetLang: SarvamLangCode,
  mode: 'formal' | 'modern-colloquial' = 'modern-colloquial'
): Promise<string> {
  if (!SARVAM_API_KEY) {
    logger.debug('Sarvam API key not set — skipping translation');
    return text;
  }

  // Don't translate if source and target are the same
  if (sourceLang === targetLang) return text;
  if (sourceLang !== 'auto' && sourceLang === targetLang) return text;

  // Truncate to max length
  const input = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;

  try {
    const response = await axios.post(
      `${SARVAM_BASE_URL}/translate`,
      {
        input,
        source_language_code: sourceLang,
        target_language_code: targetLang,
        speaker_gender: 'Male',
        mode,
        model: 'mayura:v1',
        enable_preprocessing: true,
      },
      {
        headers: {
          'api-subscription-key': SARVAM_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const translated = response.data?.translated_text;
    if (translated) {
      logger.debug(`Translated [${sourceLang} → ${targetLang}]: "${input.substring(0, 30)}..." → "${translated.substring(0, 30)}..."`);
      return translated;
    }

    return text;
  } catch (error: any) {
    logger.warn(`Translation failed [${sourceLang} → ${targetLang}]: ${error.message}`);
    return text;
  }
}

/**
 * Translate user message to English for processing by the state machine.
 */
export async function translateToEnglish(text: string, sourceLang: SarvamLangCode): Promise<string> {
  if (sourceLang === 'en-IN') return text;
  return translate(text, sourceLang, 'en-IN', 'formal');
}

/**
 * Translate agent response from English to user's language.
 * Uses modern-colloquial mode for a warm, natural tone.
 */
export async function translateFromEnglish(text: string, targetLang: SarvamLangCode): Promise<string> {
  if (targetLang === 'en-IN') return text;
  return translate(text, 'en-IN', targetLang, 'modern-colloquial');
}

/**
 * Check if Sarvam translation is available.
 */
export function isTranslationAvailable(): boolean {
  return !!SARVAM_API_KEY;
}

/**
 * Transliterate Roman script text to native Indic script.
 * Used to display names and English words in the user's selected language script.
 *
 * @param text - Text to transliterate (may contain Roman script words)
 * @param targetLang - Target language script (e.g., 'hi-IN' for Devanagari)
 * @returns Text with Roman words transliterated to target script
 */
export async function transliterateToNativeScript(
  text: string,
  targetLang: SarvamLangCode
): Promise<string> {
  // Skip if target is English or no API key
  if (targetLang === 'en-IN' || !SARVAM_API_KEY) {
    return text;
  }

  // Check if text has Roman characters that need transliteration
  const hasRomanChars = /[a-zA-Z]/.test(text);
  if (!hasRomanChars) {
    return text; // Already in native script
  }

  try {
    const response = await axios.post(
      `${SARVAM_BASE_URL}/transliterate`,
      {
        input: text,
        source_language_code: 'en-IN',
        target_language_code: targetLang,
      },
      {
        headers: {
          'api-subscription-key': SARVAM_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      }
    );

    const transliterated = response.data?.transliterated_text;
    if (transliterated) {
      logger.debug(`Transliterated [en-IN → ${targetLang}]: "${text}" → "${transliterated}"`);
      return transliterated;
    }

    return text;
  } catch (error: any) {
    logger.warn(`Transliteration failed [en-IN → ${targetLang}]: ${error.message}`);
    return text;
  }
}
