/**
 * Voice Transcript Normalizer
 * 
 * Preprocesses voice transcripts to:
 * 1. Merge split phone numbers (e.g., "98765, 43210" → "9876543210")
 * 2. Handle filler words and corrections
 * 3. Extract clean, actionable user intent
 */

import axios from 'axios';
import { createLogger } from '@p2p/shared';

const logger = createLogger('VoiceNormalizer');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

const NORMALIZE_PROMPT = `You are a speech-to-text post-processor. Clean up voice transcripts into clear, actionable text.

Rules:
1. PHONE NUMBERS: Merge digit sequences split by pauses/punctuation into continuous numbers.
   Examples:
   - "98765, 43210" → "9876543210"
   - "9-8-7-6 5-4-3-2-1-0" → "9876543210"
   - "ninety eight seven six five, four three two one oh" → "9876543210"

2. FILLER WORDS: Remove "uh", "um", "like", "you know", etc.

3. CORRECTIONS: If the user says "no wait", "I mean", "actually", keep only the correction.
   Example: "20 kWh no wait 30 kWh" → "30 kWh"

4. PRESERVE INTENT: Keep the core meaning. Don't add or remove important details.

5. KEEP IT SHORT: Return only the cleaned-up message, nothing else.

Examples:
- Input: "Uh, my phone number is 98765, 43210"
  Output: "my phone number is 9876543210"

- Input: "I want to buy, um, 20 kWh, no wait, 30 kWh at Rs 6"
  Output: "I want to buy 30 kWh at Rs 6"

- Input: "Sign me, uh, sign me out please"
  Output: "sign me out please"

Return ONLY the cleaned transcript, no explanation.`;

/**
 * Normalize a voice transcript using LLM.
 * Returns the original if LLM is unavailable.
 */
export async function normalizeVoiceInput(transcript: string): Promise<string> {
    // Skip if empty or LLM not configured
    if (!transcript || !transcript.trim()) return transcript;
    if (!OPENROUTER_API_KEY) {
        logger.debug('OpenRouter not configured — skipping voice normalization');
        return transcript;
    }

    // Quick check: if no digits or obvious filler words, skip LLM call
    const hasDigits = /\d/.test(transcript);
    const hasSplitDigits = /\d[\s,.-]+\d/.test(transcript);
    const hasFillerWords = /\b(uh|um|like|you know|wait|actually|no wait|i mean)\b/i.test(transcript);

    if (!hasFillerWords && (!hasDigits || !hasSplitDigits)) {
        logger.debug('Transcript looks clean, skipping normalization');
        return transcript;
    }

    try {
        const response = await axios.post(
            `${OPENROUTER_BASE_URL}/chat/completions`,
            {
                model: OPENROUTER_MODEL,
                messages: [
                    { role: 'system', content: NORMALIZE_PROMPT },
                    { role: 'user', content: transcript },
                ],
                temperature: 0.1,
                max_tokens: 200,
            },
            {
                headers: {
                    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://p2p-energy-trading.local',
                    'X-Title': 'Oorja Voice Normalizer',
                },
                timeout: 5000,
            }
        );

        const normalized = response.data?.choices?.[0]?.message?.content?.trim();
        if (normalized && normalized.length > 0) {
            logger.debug(`Normalized: "${transcript.substring(0, 40)}..." → "${normalized.substring(0, 40)}..."`);
            return normalized;
        }

        return transcript;
    } catch (error: any) {
        logger.warn(`Voice normalization failed: ${error.message}`);
        return transcript;
    }
}
