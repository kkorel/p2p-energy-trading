/**
 * Chat Routes — Express endpoints for the Oorja web chat.
 *
 * POST /chat/send      — Send a text message, get agent reply
 * POST /chat/upload    — Upload a PDF (base64), get agent reply
 * POST /chat/voice     — Upload audio (base64), transcribe and get agent reply
 * GET  /chat/history   — Get message history for a session
 * POST /chat/reset     — Delete session and start fresh
 */

import { Router, Request, Response } from 'express';
import { prisma, createLogger } from '@p2p/shared';
import { optionalAuthMiddleware } from './middleware';
import { processMessage, FileData, VoiceInputOptions } from './chat/agent';
import { transcribeBase64Audio, isSTTAvailable, STTError } from './chat/sarvam-stt';
import { synthesizeSpeech, synthesizeLongText, isTTSAvailable, TTSError, type TTSSpeaker, type TTSResult } from './chat/sarvam-tts';
import { transliterateToNativeScript, type SarvamLangCode } from './chat/sarvam';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('ChatRoutes');
const router = Router();

/**
 * Convert a number to Hindi words for TTS
 * Handles numbers up to 99,99,999 (Indian numbering system)
 */
function numberToHindiWords(num: number): string {
  if (num === 0) return 'शून्य';

  const ones = ['', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ', 'दस',
    'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस'];
  const tens = ['', '', 'बीस', 'तीस', 'चालीस', 'पचास', 'साठ', 'सत्तर', 'अस्सी', 'नब्बे'];

  function twoDigit(n: number): string {
    if (n < 20) return ones[n];
    const t = Math.floor(n / 10);
    const o = n % 10;
    if (o === 0) return tens[t];
    // Hindi has special forms for 21-99
    return tens[t] + ' ' + ones[o];
  }

  let result = '';

  // Lakhs (1,00,000)
  if (num >= 100000) {
    const lakhs = Math.floor(num / 100000);
    result += twoDigit(lakhs) + ' लाख ';
    num %= 100000;
  }

  // Thousands (1,000 - 99,999)
  if (num >= 1000) {
    const thousands = Math.floor(num / 1000);
    result += twoDigit(thousands) + ' हज़ार ';
    num %= 1000;
  }

  // Hundreds
  if (num >= 100) {
    const hundreds = Math.floor(num / 100);
    result += ones[hundreds] + ' सौ ';
    num %= 100;
  }

  // Remaining two digits
  if (num > 0) {
    result += twoDigit(num);
  }

  return result.trim();
}

/**
 * Preprocess text for TTS to make it more natural-sounding.
 * Handles: URLs, emoji, markdown, bullets, newlines, punctuation,
 * symbols, number ranges, parentheticals, and Hindi number words.
 */
function preprocessTextForTTS(text: string, languageCode: string): string {
  let processed = text;
  const isHindi = languageCode === 'hi-IN';

  // 1. Remove URLs
  processed = processed.replace(/https?:\/\/[^\s]+/gi, '');
  processed = processed.replace(/www\.[^\s]+/gi, '');

  // 2. Remove emoji characters (TTS can't speak pictographs)
  // eslint-disable-next-line no-control-regex
  processed = processed.replace(/[\u2600-\u27BF\uFE0F\u200D\u20E3]/g, '');
  // Remove supplementary plane emoji (surrogate pairs for U+1F000+)
  processed = processed.replace(/[\uD83C-\uD83E][\uDC00-\uDFFF]/g, '');

  // 3. Remove markdown formatting
  processed = processed.replace(/\*\*([^*]+)\*\*/g, '$1');
  processed = processed.replace(/\*([^*]+)\*/g, '$1');
  processed = processed.replace(/_([^_]+)_/g, '$1');       // _italic_
  processed = processed.replace(/`([^`]+)`/g, '$1');

  // 3b. Remove decorative lines and quotes around commands
  processed = processed.replace(/^[━═─—]+$/gm, '');        // ━━━━ separator lines
  processed = processed.replace(/"([^"]+)"/g, '$1');        // "sell" → sell

  // 4. Remove bullet and list markers
  processed = processed.replace(/^[•●▪\-]\s*/gm, '');
  processed = processed.replace(/^\d+[.)]\s*/gm, '');

  // 5. Ensure each non-empty line ends with punctuation for TTS pauses
  processed = processed.replace(/([^\.\?\!,।:\s])\s*$/gm, '$1.');

  // 6. Convert newlines to sentence breaks.
  //    If line already ends with punctuation, just add a space (not another period).
  processed = processed.replace(/([.!?।,:])\s*\n\n*/g, '$1 ');
  //    Any remaining newlines (lines that somehow lack punctuation)
  processed = processed.replace(/\n/g, '. ');

  // 7. Handle special characters
  processed = processed.replace(/~/g, isHindi ? 'लगभग ' : 'approximately ');
  processed = processed.replace(/≤/g, isHindi ? 'अधिकतम ' : 'at most ');
  processed = processed.replace(/≥/g, isHindi ? 'कम से कम ' : 'at least ');
  processed = processed.replace(/\s*@\s*/g, isHindi ? ' पर ' : ' at ');

  // 8. Handle number ranges: "4-6" → "4 to 6" (before slash/symbol replacement)
  processed = processed.replace(/(\d)\s*-\s*(\d)/g, isHindi ? '$1 से $2' : '$1 to $2');

  // 9. Replace forward slash with language-appropriate "per"
  const perWord: Record<string, string> = {
    'en-IN': ' per ',
    'hi-IN': ' प्रति ',
    'bn-IN': ' প্রতি ',
    'ta-IN': ' ஒரு ',
    'te-IN': ' కు ',
    'kn-IN': ' ಪ್ರತಿ ',
  };
  const perReplacement = perWord[languageCode] || ' per ';
  processed = processed.replace(/(\S)\/(\S)/g, `$1${perReplacement}$2`);

  // 10. Convert parenthetical asides to natural speech pauses
  processed = processed.replace(/\s*\(([^)]+)\)/g, ', $1,');

  // 11. Replace common symbols with words
  processed = processed.replace(/₹\s*/g, isHindi ? 'रुपये ' : 'Rupees ');
  processed = processed.replace(/Rs\.?\s*/gi, isHindi ? 'रुपये ' : 'Rupees ');
  processed = processed.replace(/kWh/gi, isHindi ? 'किलोवाट घंटा' : 'kilowatt hour');
  processed = processed.replace(/kW/gi, isHindi ? 'किलोवाट' : 'kilowatt');
  processed = processed.replace(/%/g, isHindi ? ' प्रतिशत' : ' percent');
  // AM/PM → spoken form
  processed = processed.replace(/(\d)\s*AM/gi, '$1 A M');
  processed = processed.replace(/(\d)\s*PM/gi, '$1 P M');

  // 12. Strip commas from formatted numbers (Indian style: 1,00,000 or 29,000)
  //     so "29,000" becomes "29000" before number-to-word conversion
  processed = processed.replace(/\d{1,3}(,\d{2,3})+/g, (match) => match.replace(/,/g, ''));

  // 13. Convert numbers to Hindi words for Hindi TTS
  if (isHindi) {
    processed = processed.replace(/\d+(\.\d+)?/g, (match) => {
      const num = parseFloat(match);
      if (Number.isInteger(num) && num > 0 && num < 10000000) {
        return numberToHindiWords(num);
      }
      // Decimal numbers: "7.5" → "सात दशमलव पांच"
      if (!Number.isInteger(num) && num > 0 && num < 10000000) {
        const parts = match.split('.');
        const intPart = parseInt(parts[0], 10);
        const decPart = parseInt(parts[1], 10);
        const intWord = intPart > 0 ? numberToHindiWords(intPart) : 'शून्य';
        const decWord = decPart > 0 ? numberToHindiWords(decPart) : '';
        return decWord ? `${intWord} दशमलव ${decWord}` : intWord;
      }
      return match;
    });
  }

  // 14. Clean up punctuation artifacts
  processed = processed.replace(/\.\s*\./g, '.');      // .. → .
  processed = processed.replace(/\?\s*\./g, '? ');     // ?. → ?
  processed = processed.replace(/!\s*\./g, '! ');      // !. → !
  processed = processed.replace(/,\s*\./g, '.');       // ,. → .
  processed = processed.replace(/\.\s*,/g, '. ');      // ., → .
  processed = processed.replace(/,\s*,/g, ',');        // ,, → ,
  processed = processed.replace(/:\s*\./g, '. ');      // :. → .
  processed = processed.replace(/\.\s*:/g, '. ');      // .: → .

  // 15. Clean up extra whitespace
  processed = processed.replace(/\s+/g, ' ').trim();

  return processed;
}

// All chat routes use optional auth — authenticated users get their userId-based
// platformId; anonymous users get a generated session ID.
router.use(optionalAuthMiddleware);

/**
 * Resolve the web platform ID for this request.
 * Priority: sessionId (for continuity after in-chat auth) > auth token > generate new.
 */
function resolvePlatformId(req: Request, sessionId?: string): string {
  // Prioritize sessionId for session continuity (user may have authenticated mid-chat)
  if (sessionId) return sessionId;
  if (req.user) return `web-${req.user.id}`;
  return `anon-${uuidv4()}`;
}

/**
 * POST /chat/send
 * Body: { message: string, sessionId?: string, displayText?: string }
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { message, sessionId, displayText } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }

    const platformId = resolvePlatformId(req, sessionId);
    const response = await processMessage('WEB', platformId, message.trim(), undefined, req.user?.id, undefined, displayText);

    // Map agent messages to a simpler shape for the frontend
    const messages = response.messages.map((m) => ({
      role: 'agent' as const,
      content: m.text,
      buttons: m.buttons || undefined,
      offers: m.offers || undefined,
      dashboard: m.dashboard || undefined,
      listings: m.listings || undefined,
      offerCreated: m.offerCreated || undefined,
      topDeals: m.topDeals || undefined,
      matchedOffers: m.matchedOffers || undefined,
      orderConfirmation: m.orderConfirmation || undefined,
      earnings: m.earnings || undefined,
      slider: m.slider || undefined,
      autoTradeStatus: m.autoTradeStatus || undefined,
    }));

    res.json({
      success: true,
      sessionId: platformId,
      messages,
      authToken: response.authToken || undefined,
      responseLanguage: response.responseLanguage,
      voiceOutputEnabled: response.voiceOutputEnabled,
    });
  } catch (error: any) {
    logger.error(`Chat send error: ${error.message}\n${error.stack}`);
    res.status(500).json({ success: false, error: 'Failed to process message' });
  }
});

/**
 * POST /chat/upload
 * Body: { pdfBase64: string, sessionId?: string, fileName?: string }
 * Accepts both PDF and JSON credential files.
 */
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const { pdfBase64, sessionId, fileName } = req.body;

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return res.status(400).json({ success: false, error: 'pdfBase64 is required' });
    }

    const platformId = resolvePlatformId(req, sessionId);
    const buffer = Buffer.from(pdfBase64, 'base64');

    // Detect mimeType from file extension
    const name = fileName || 'upload.pdf';
    const isJson = name.toLowerCase().endsWith('.json');
    const mimeType = isJson ? 'application/json' : 'application/pdf';

    const fileData: FileData = {
      buffer,
      mimeType,
      fileName: name,
    };

    const label = isJson ? '[JSON credential uploaded]' : '[PDF uploaded]';
    const displayLabel = isJson ? `📎 ${name}` : `📄 ${name}`;
    const response = await processMessage('WEB', platformId, label, fileData, req.user?.id, undefined, displayLabel);

    const messages = response.messages.map((m) => ({
      role: 'agent' as const,
      content: m.text,
      buttons: m.buttons || undefined,
      dashboard: m.dashboard || undefined,
      listings: m.listings || undefined,
      offerCreated: m.offerCreated || undefined,
      topDeals: m.topDeals || undefined,
      matchedOffers: m.matchedOffers || undefined,
      orderConfirmation: m.orderConfirmation || undefined,
      earnings: m.earnings || undefined,
      slider: m.slider || undefined,
      autoTradeStatus: m.autoTradeStatus || undefined,
    }));

    res.json({
      success: true,
      sessionId: platformId,
      messages,
      authToken: response.authToken || undefined,
      responseLanguage: response.responseLanguage,
      voiceOutputEnabled: response.voiceOutputEnabled,
    });
  } catch (error: any) {
    logger.error(`Chat upload error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to process upload' });
  }
});

/**
 * POST /chat/voice
 * Body: { audio: string (base64), mimeType: string, sessionId?: string }
 * 
 * Transcribes audio using Sarvam AI and sends the transcript to the agent.
 * Returns both the transcript and the agent's response.
 */
router.post('/voice', async (req: Request, res: Response) => {
  try {
    const { audio, mimeType, sessionId } = req.body;

    // Validate input
    if (!audio || typeof audio !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'audio (base64) is required',
        errorType: 'invalid_input',
      });
    }

    if (!mimeType || typeof mimeType !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'mimeType is required',
        errorType: 'invalid_input',
      });
    }

    // Check if STT is available
    if (!isSTTAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Voice input is not available. Please type your message instead.',
        errorType: 'service_unavailable',
      });
    }

    const platformId = resolvePlatformId(req, sessionId);

    // Transcribe the audio
    let transcription;
    try {
      transcription = await transcribeBase64Audio(audio, mimeType);
    } catch (error) {
      if (error instanceof STTError) {
        logger.warn(`STT error: ${error.type} - ${error.message}`);
        return res.status(error.type === 'rate_limited' ? 429 : 400).json({
          success: false,
          error: error.message,
          errorType: error.type,
          retryable: error.retryable,
        });
      }
      throw error;
    }

    logger.info(`Voice transcription: "${transcription.transcript.substring(0, 50)}..." [${transcription.languageName}]`);

    // Get user's language preference from session (for transliteration)
    const existingSession = await prisma.chatSession.findUnique({
      where: { platform_platformId: { platform: 'WEB', platformId } },
    });
    const sessionCtx = existingSession?.contextJson ? JSON.parse(existingSession.contextJson) : {};
    const userLanguage = (sessionCtx.language || transcription.languageCode) as SarvamLangCode;

    // Transliterate transcript to user's selected language script
    // This converts Roman script names (e.g., "Ravi") to native script (e.g., "रवि")
    let displayTranscript = transcription.transcript;
    if (userLanguage !== 'en-IN' && userLanguage !== transcription.languageCode) {
      displayTranscript = await transliterateToNativeScript(transcription.transcript, userLanguage);
      if (displayTranscript !== transcription.transcript) {
        logger.info(`Transliterated transcript: "${transcription.transcript}" → "${displayTranscript}"`);
      }
    }

    // Send the transcript to the agent with voice language info
    const voiceOptions: VoiceInputOptions = {
      detectedLanguage: transcription.languageCode,
      isVoiceInput: true,
    };
    const response = await processMessage('WEB', platformId, transcription.transcript, undefined, req.user?.id, voiceOptions);

    // Map agent messages to frontend format
    const messages = response.messages.map((m) => ({
      role: 'agent' as const,
      content: m.text,
      buttons: m.buttons || undefined,
      dashboard: m.dashboard || undefined,
      listings: m.listings || undefined,
      offerCreated: m.offerCreated || undefined,
      topDeals: m.topDeals || undefined,
      matchedOffers: m.matchedOffers || undefined,
      orderConfirmation: m.orderConfirmation || undefined,
      earnings: m.earnings || undefined,
      slider: m.slider || undefined,
      autoTradeStatus: m.autoTradeStatus || undefined,
    }));

    res.json({
      success: true,
      sessionId: platformId,
      transcript: displayTranscript, // Use transliterated transcript for display
      language: transcription.languageCode,
      languageName: transcription.languageName,
      processingTimeMs: transcription.processingTimeMs,
      messages,
      authToken: response.authToken || undefined,
      responseLanguage: response.responseLanguage || userLanguage,
      voiceOutputEnabled: response.voiceOutputEnabled,
      autoVoice: response.autoVoice, // Auto-play voice when input was voice
    });
  } catch (error: any) {
    logger.error(`Chat voice error: ${error.message}\n${error.stack}`);
    res.status(500).json({
      success: false,
      error: 'Failed to process voice message',
      errorType: 'server_error',
      retryable: true,
    });
  }
});

/**
 * POST /chat/tts
 * Body: { text: string, languageCode: string, speaker?: string, pace?: number }
 * 
 * Converts text to speech using Sarvam Bulbul model.
 * Returns base64 encoded WAV audio.
 */
router.post('/tts', async (req: Request, res: Response) => {
  try {
    const { text, languageCode, speaker, pace } = req.body;

    // Validate input
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'text is required',
        errorType: 'invalid_input',
      });
    }

    if (!languageCode || typeof languageCode !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'languageCode is required',
        errorType: 'invalid_input',
      });
    }

    // Check if TTS is available
    if (!isTTSAvailable()) {
      return res.status(503).json({
        success: false,
        error: 'Voice output is not available.',
        errorType: 'service_unavailable',
      });
    }

    // Preprocess text for TTS (remove URLs, handle symbols)
    const processedText = preprocessTextForTTS(text.trim(), languageCode);

    if (!processedText) {
      return res.status(400).json({
        success: false,
        error: 'No speakable content after preprocessing',
        errorType: 'invalid_input',
      });
    }

    // Synthesize speech (supports long text via chunking)
    let result: TTSResult;
    try {
      if (processedText.length <= 1500) {
        result = await synthesizeSpeech({
          text: processedText,
          languageCode,
          speaker: (speaker as TTSSpeaker) || 'anushka',
          pace: pace ? parseFloat(pace) : undefined,
        });
      } else {
        // Long text: synthesize in chunks and concatenate WAV audio
        const chunks = await synthesizeLongText(processedText, languageCode, {
          speaker: (speaker as TTSSpeaker) || 'anushka',
          pace: pace ? parseFloat(pace) : undefined,
        });

        if (chunks.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'No audio generated',
            errorType: 'synthesis_failed',
          });
        }

        if (chunks.length === 1) {
          result = chunks[0];
        } else {
          // Concatenate WAV chunks: keep header from first, append raw PCM from rest
          // Standard WAV header is 44 bytes
          const WAV_HEADER_SIZE = 44;
          const buffers = chunks.map(c => Buffer.from(c.audio, 'base64'));
          const totalPcmSize = buffers.reduce((sum, buf) => sum + Math.max(0, buf.length - WAV_HEADER_SIZE), 0);

          // Build new WAV: first chunk's header (updated with total size) + all PCM data
          const firstHeader = Buffer.from(buffers[0].subarray(0, WAV_HEADER_SIZE));
          // Update RIFF chunk size (bytes 4-7): total file size - 8
          const totalFileSize = WAV_HEADER_SIZE + totalPcmSize;
          firstHeader.writeUInt32LE(totalFileSize - 8, 4);
          // Update data sub-chunk size (bytes 40-43): total PCM size
          firstHeader.writeUInt32LE(totalPcmSize, 40);

          const combined = Buffer.concat([
            firstHeader,
            ...buffers.map((buf, i) => i === 0 ? buf.subarray(WAV_HEADER_SIZE) : buf.subarray(WAV_HEADER_SIZE)),
          ]);

          result = {
            audio: combined.toString('base64'),
            durationMs: chunks.reduce((sum, c) => sum + c.durationMs, 0),
            languageCode: chunks[0].languageCode,
          };
        }
      }
    } catch (error) {
      if (error instanceof TTSError) {
        logger.warn(`TTS error: ${error.type} - ${error.message}`);
        return res.status(error.type === 'rate_limited' ? 429 : 400).json({
          success: false,
          error: error.message,
          errorType: error.type,
          retryable: error.retryable,
        });
      }
      throw error;
    }

    res.json({
      success: true,
      audio: result.audio,
      mimeType: 'audio/wav',
      durationMs: result.durationMs,
      languageCode: result.languageCode,
    });
  } catch (error: any) {
    logger.error(`Chat TTS error: ${error.message}\n${error.stack}`);
    res.status(500).json({
      success: false,
      error: 'Failed to generate speech',
      errorType: 'server_error',
      retryable: true,
    });
  }
});

/**
 * GET /chat/history?sessionId=...
 * Returns all messages for the session, oldest first.
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const platformId = resolvePlatformId(req, req.query.sessionId as string | undefined);

    const session = await prisma.chatSession.findUnique({
      where: { platform_platformId: { platform: 'WEB', platformId } },
      select: { id: true, state: true, contextJson: true },
    });

    if (!session) {
      return res.json({ success: true, messages: [], state: null });
    }

    // Extract language from session context
    let responseLanguage: string | undefined;
    if (session.contextJson) {
      try {
        const ctx = JSON.parse(session.contextJson);
        responseLanguage = ctx.language;
      } catch { /* ignore parse errors */ }
    }

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true, metadataJson: true, createdAt: true },
    });

    const formatted = messages.map((m) => {
      const meta = m.metadataJson ? JSON.parse(m.metadataJson) : undefined;
      return {
        role: m.role as 'agent' | 'user',
        content: m.content,
        buttons: meta?.buttons || undefined,
        dashboard: meta?.dashboard || undefined,
        listings: meta?.listings || undefined,
        offerCreated: meta?.offerCreated || undefined,
        topDeals: meta?.topDeals || undefined,
        matchedOffers: meta?.matchedOffers || undefined,
        orderConfirmation: meta?.orderConfirmation || undefined,
        earnings: meta?.earnings || undefined,
        slider: meta?.slider || undefined,
        autoTradeStatus: meta?.autoTradeStatus || undefined,
        createdAt: m.createdAt,
      };
    });

    res.json({ success: true, messages: formatted, state: session.state, responseLanguage });
  } catch (error: any) {
    logger.error(`Chat history error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

/**
 * POST /chat/reset
 * Deletes the current session so the user starts fresh.
 */
router.post('/reset', async (req: Request, res: Response) => {
  try {
    const platformId = resolvePlatformId(req, req.body?.sessionId);

    const session = await prisma.chatSession.findUnique({
      where: { platform_platformId: { platform: 'WEB', platformId } },
    });

    if (session) {
      await prisma.chatMessage.deleteMany({ where: { sessionId: session.id } });
      await prisma.chatSession.delete({ where: { id: session.id } });
    }

    res.json({ success: true });
  } catch (error: any) {
    logger.error(`Chat reset error: ${error.message}`);
    res.status(500).json({ success: false, error: 'Failed to reset chat' });
  }
});

export default router;
