/**
 * WhatsApp Bot — Oorja agent on WhatsApp via Baileys.
 * Uses multi-device protocol. Only starts if WHATSAPP_ENABLED=true.
 * Supports text, documents (PDF/JSON), and voice messages.
 * 
 * Setup: On first run, scan the QR code displayed in terminal with your
 * WhatsApp app (Settings → Linked Devices → Link a Device).
 * After linking, credentials are saved and no re-scan is needed.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  downloadMediaMessage,
  AnyMessageContent,
  WAMessage,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import * as path from 'path';
import * as fs from 'fs';
import { createLogger, prisma } from '@p2p/shared';
import { processMessage, FileData } from './agent';
import { transcribeAudio, isSTTAvailable, STTError } from './sarvam-stt';

const logger = createLogger('WhatsAppBot');

let sock: WASocket | null = null;
let connectionState: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
const AUTH_FOLDER = path.join(__dirname, '../../.whatsapp-auth');

// Ensure auth folder exists
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

/**
 * Start the WhatsApp bot using Baileys.
 * Displays QR code in terminal for first-time linking.
 */
export async function startWhatsAppBot(): Promise<void> {
  const enabled = process.env.WHATSAPP_ENABLED === 'true';

  if (!enabled) {
    logger.info('WHATSAPP_ENABLED not set to true — WhatsApp bot disabled');
    return;
  }

  if (connectionState === 'connecting') {
    logger.info('WhatsApp bot already connecting, skipping...');
    return;
  }

  connectionState = 'connecting';

  try {
    logger.info('Starting WhatsApp bot with Baileys...');

    // Load or create auth state (persists across restarts)
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

    // Create WhatsApp socket connection with minimal logging
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // We'll handle QR display ourselves
      browser: ['Oorja Energy Bot', 'Chrome', '120.0.0'],
      syncFullHistory: false,
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('');
        logger.info('='.repeat(50));
        logger.info('WHATSAPP: Scan this QR code with your phone');
        logger.info('Go to WhatsApp → Settings → Linked Devices → Link a Device');
        logger.info('='.repeat(50));
        qrcode.generate(qr, { small: true });
        logger.info('='.repeat(50));
        logger.info('');
      }

      if (connection === 'close') {
        connectionState = 'disconnected';
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logger.info(`WhatsApp connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          // Wait a bit before reconnecting
          setTimeout(() => {
            startWhatsAppBot();
          }, 3000);
        } else {
          logger.info('WhatsApp logged out. Delete .whatsapp-auth folder and restart to re-link.');
        }
      } else if (connection === 'open') {
        connectionState = 'connected';
        logger.info('WhatsApp bot connected successfully!');
        logger.info(`Bot number: ${process.env.WHATSAPP_BOT_NUMBER || '(set WHATSAPP_BOT_NUMBER)'}`);
        logger.info('Users can now message this number to interact with Oorja.');
      }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // Only process new messages (not history sync)
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Skip our own messages
        if (msg.key.fromMe) continue;

        // Skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const chatId = msg.key.remoteJid;
        if (!chatId) continue;

        try {
          await handleIncomingMessage(msg, chatId);
        } catch (err: any) {
          logger.error(`Error handling WhatsApp message: ${err.message}\n${err.stack}`);
          await sendWhatsAppMessage(chatId, 'Something went wrong. Please try again.');
        }
      }
    });

  } catch (err: any) {
    connectionState = 'disconnected';
    logger.error(`Failed to start WhatsApp bot: ${err.message}`);
    sock = null;
  }
}

/**
 * Extract phone number from various WhatsApp message formats.
 * Handles both standard JID (@s.whatsapp.net) and LID (@lid) formats.
 */
function extractPhoneFromMessage(msg: proto.IWebMessageInfo, chatId: string): string | null {
  // Standard format: 447700900123@s.whatsapp.net
  if (chatId.includes('@s.whatsapp.net')) {
    return chatId.replace('@s.whatsapp.net', '');
  }
  
  // LID format: Check participant or verifiedBizName or pushName for context
  // The actual phone might be in msg.pushName or we need to use the chat ID as-is
  
  // Check if there's a participant field (used in groups, but might have info)
  const participant = msg.key.participant;
  if (participant && participant.includes('@s.whatsapp.net')) {
    return participant.replace('@s.whatsapp.net', '');
  }
  
  // For LID format, the number before @lid is NOT the phone number
  // We need to check if the message has verifiedBizName context or use pushName
  // For now, strip the @lid suffix but mark it specially
  if (chatId.includes('@lid')) {
    // LID is a WhatsApp internal ID, not a phone number
    // We'll use it as platformId but can't match to user phone directly
    logger.warn(`LID format detected: ${chatId} - cannot extract phone number directly`);
    return null;
  }
  
  // Fallback: return as-is (might be a different format)
  return chatId.replace(/@.*$/, '');
}

/**
 * Handle incoming WhatsApp message based on type.
 */
async function handleIncomingMessage(
  msg: proto.IWebMessageInfo,
  chatId: string
): Promise<void> {
  const message = msg.message;
  if (!message) return;

  // Extract phone number for logging
  const phoneNumber = extractPhoneFromMessage(msg, chatId);
  const isLidFormat = chatId.includes('@lid');
  
  logger.info(`WhatsApp message from ${isLidFormat ? 'LID:' : '+'}${phoneNumber || chatId}${isLidFormat ? ' (LID format - user lookup may fail)' : ''}`);

  // Text message (regular or extended)
  if (message.conversation || message.extendedTextMessage?.text) {
    const text = message.conversation || message.extendedTextMessage?.text || '';
    await handleTextMessage(chatId, text);
    return;
  }

  // Document (PDF/JSON)
  if (message.documentMessage) {
    await handleDocumentMessage(chatId, msg);
    return;
  }

  // Voice/Audio message
  if (message.audioMessage) {
    await handleVoiceMessage(chatId, msg);
    return;
  }

  // Image with caption (treat caption as text)
  if (message.imageMessage?.caption) {
    await handleTextMessage(chatId, message.imageMessage.caption);
    return;
  }

  // Button response
  if (message.buttonsResponseMessage) {
    const selectedId = message.buttonsResponseMessage.selectedButtonId || '';
    await handleTextMessage(chatId, selectedId);
    return;
  }

  // List response
  if (message.listResponseMessage) {
    const selectedId = message.listResponseMessage.singleSelectReply?.selectedRowId || '';
    await handleTextMessage(chatId, selectedId);
    return;
  }

  // Unsupported message type - send helpful response
  await sendWhatsAppMessage(
    chatId,
    "I can help with text messages, voice messages, and PDF/JSON file uploads. How can I assist you today?"
  );
}

/**
 * Handle text messages.
 */
async function handleTextMessage(chatId: string, text: string): Promise<void> {
  // Normalize text
  const normalized = text.toLowerCase().trim();

  // Detect "start", "hi", "hello" as /start equivalent (WhatsApp doesn't have commands)
  const isStart = ['start', 'hi', 'hello', 'hey', 'help', 'menu', 'begin'].includes(normalized);

  // Handle reset command
  if (['reset', 'restart', 'start over', 'clear'].includes(normalized)) {
    try {
      const session = await prisma.chatSession.findUnique({
        where: { platform_platformId: { platform: 'WHATSAPP', platformId: chatId } },
      });

      if (session) {
        await prisma.chatMessage.deleteMany({ where: { sessionId: session.id } });
        await prisma.chatSession.delete({ where: { id: session.id } });
      }

      await sendWhatsAppMessage(chatId, 'Session reset! Send "hi" to start again.');
      return;
    } catch (err: any) {
      logger.error(`WhatsApp reset error: ${err.message}`);
    }
  }

  // Process through agent
  const response = await processMessage(
    'WHATSAPP',
    chatId,
    isStart ? '/start' : text
  );

  // Send responses
  for (const msg of response.messages) {
    await sendWhatsAppMessage(chatId, msg.text, msg.buttons);
    // Add delay between multiple messages
    if (response.messages.length > 1 && msg.delay) {
      await sleep(msg.delay);
    }
  }
}

/**
 * Handle voice messages - transcribe and process.
 */
async function handleVoiceMessage(
  chatId: string,
  msg: proto.IWebMessageInfo
): Promise<void> {
  if (!isSTTAvailable()) {
    await sendWhatsAppMessage(
      chatId,
      "Voice messages aren't available right now. Please type your message instead."
    );
    return;
  }

  try {
    // Ensure sock is still connected
    if (!sock) {
      logger.warn('WhatsApp disconnected while handling voice message');
      return;
    }
    
    // Download audio (cast to WAMessage for type compatibility)
    const buffer = await downloadMediaMessage(
      msg as WAMessage,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (!buffer || !(buffer instanceof Buffer)) {
      throw new Error('Failed to download voice message');
    }

    const mimeType = msg.message?.audioMessage?.mimetype || 'audio/ogg; codecs=opus';

    logger.info(`Received WhatsApp voice: ${(buffer.length / 1024).toFixed(1)}KB, mime: ${mimeType}`);

    // Let user know we're processing
    await sendWhatsAppMessage(chatId, '🎤 Processing your voice message...');

    // Transcribe using Sarvam
    let transcript: string;
    let languageName: string;
    let detectedLanguageCode: string | undefined;
    try {
      const result = await transcribeAudio(buffer, mimeType);
      transcript = result.transcript;
      languageName = result.languageName;
      detectedLanguageCode = result.languageCode;
      logger.info(`WhatsApp voice transcription [${languageName}]: "${transcript.substring(0, 50)}..."`);
    } catch (error) {
      if (error instanceof STTError) {
        logger.warn(`WhatsApp STT error: ${error.type} - ${error.message}`);
        await sendWhatsAppMessage(
          chatId,
          error.retryable
            ? `${error.message} Please try again.`
            : error.message
        );
        return;
      }
      throw error;
    }

    // Process through agent (pass detected voice language so agent responds in same language)
    const response = await processMessage('WHATSAPP', chatId, transcript, undefined, undefined, {
      isVoiceInput: true,
      detectedLanguage: detectedLanguageCode,
    });

    for (const msg of response.messages) {
      await sendWhatsAppMessage(chatId, msg.text, msg.buttons);
    }
  } catch (err: any) {
    logger.error(`WhatsApp voice error: ${err.message}\n${err.stack}`);
    await sendWhatsAppMessage(
      chatId,
      "I had trouble understanding that voice message. Please try again or type your message."
    );
  }
}

/**
 * Handle document uploads (PDF/JSON).
 */
async function handleDocumentMessage(
  chatId: string,
  msg: proto.IWebMessageInfo
): Promise<void> {
  const doc = msg.message?.documentMessage;
  if (!doc) return;

  const fileName = doc.fileName || '';
  const mimeType = doc.mimetype || '';

  const isPdf = mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
  const isJson = mimeType.includes('json') || fileName.toLowerCase().endsWith('.json');

  if (!isPdf && !isJson) {
    await sendWhatsAppMessage(chatId, 'Please upload your ID document (PDF or JSON file from your electricity company).');
    return;
  }

  try {
    // Ensure sock is still connected
    if (!sock) {
      logger.warn('WhatsApp disconnected while handling document');
      return;
    }
    
    // Let user know we're processing
    await sendWhatsAppMessage(chatId, '📄 Processing your document...');

    // Download document (cast to WAMessage for type compatibility)
    const buffer = await downloadMediaMessage(
      msg as WAMessage,
      'buffer',
      {},
      {
        logger: logger as any,
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    if (!buffer || !(buffer instanceof Buffer)) {
      throw new Error('Failed to download document');
    }

    logger.info(`Received WhatsApp document: ${fileName}, ${(buffer.length / 1024).toFixed(1)}KB`);

    const fileData: FileData = {
      buffer,
      mimeType: isJson ? 'application/json' : 'application/pdf',
      fileName: fileName || (isJson ? 'upload.json' : 'upload.pdf'),
    };

    const label = isJson ? '[JSON credential uploaded]' : '[PDF uploaded]';
    const response = await processMessage('WHATSAPP', chatId, label, fileData);

    for (const msg of response.messages) {
      await sendWhatsAppMessage(chatId, msg.text, msg.buttons);
    }
  } catch (err: any) {
    logger.error(`WhatsApp document error: ${err.message}\n${err.stack}`);
    await sendWhatsAppMessage(
      chatId,
      "I had trouble processing that document. Please try again."
    );
  }
}

/**
 * Send a message with optional buttons.
 * WhatsApp's native buttons via Baileys are unreliable (often don't render),
 * so we always show options as numbered text for consistency.
 */
async function sendWhatsAppMessage(
  to: string,
  text: string,
  buttons?: Array<{ text: string; callbackData?: string }>
): Promise<void> {
  if (!sock || !text) return;

  // Add small delay to seem more human-like and avoid rate limits
  await sleep(300 + Math.random() * 500);

  try {
    if (buttons && buttons.length > 0) {
      // Always show buttons as numbered text options (more reliable than native buttons)
      const buttonText = buttons.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
      const fullText = `${text}\n\nReply with a number:\n${buttonText}`;
      
      await sock.sendMessage(to, { text: fullText });
    } else {
      await sock.sendMessage(to, { text });
    }
  } catch (err: any) {
    logger.error(`Failed to send WhatsApp message: ${err.message}`);
  }
}

/**
 * Stop the WhatsApp bot gracefully.
 */
export function stopWhatsAppBot(): void {
  if (sock) {
    sock.end(undefined);
    connectionState = 'disconnected';
    logger.info('WhatsApp bot stopped');
    sock = null;
  }
}

/**
 * Check if WhatsApp bot is connected.
 */
export function isWhatsAppConnected(): boolean {
  return connectionState === 'connected';
}

/**
 * Get WhatsApp connection state.
 */
export function getWhatsAppState(): 'disconnected' | 'connecting' | 'connected' {
  return connectionState;
}

/**
 * Send a proactive message to a user by phone number.
 * Used for notifications (order updates, welcome messages, etc.)
 * 
 * @param phoneNumber - Phone number (with or without + prefix, e.g., "919876543210" or "+919876543210")
 * @param text - Message text
 * @param buttons - Optional buttons (will be shown as numbered text options)
 * @returns true if sent successfully, false otherwise
 */
export async function sendProactiveMessage(
  phoneNumber: string,
  text: string,
  buttons?: Array<{ text: string; callbackData?: string }>
): Promise<boolean> {
  if (!sock || connectionState !== 'connected') {
    logger.warn(`Cannot send proactive message: WhatsApp not connected (state: ${connectionState})`);
    return false;
  }

  if (!phoneNumber || !text) {
    logger.warn('Cannot send proactive message: missing phone number or text');
    return false;
  }

  // Normalize phone number to WhatsApp JID format
  // Remove any non-digit characters except leading +
  let normalized = phoneNumber.replace(/[^\d+]/g, '');
  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1);
  }
  
  // Validate phone number is not empty and has reasonable length
  if (!normalized || normalized.length < 7) {
    logger.warn(`Cannot send proactive message: invalid phone number "${phoneNumber}"`);
    return false;
  }
  
  // Create WhatsApp JID (phone@s.whatsapp.net)
  const jid = `${normalized}@s.whatsapp.net`;

  logger.info(`Sending proactive message to ${normalized}`);

  try {
    await sendWhatsAppMessage(jid, text, buttons);
    logger.info(`Proactive message sent successfully to ${normalized}`);
    return true;
  } catch (err: any) {
    logger.error(`Failed to send proactive message to ${normalized}: ${err.message}`);
    return false;
  }
}

/**
 * Get the bot's WhatsApp number (for deep links).
 */
export function getWhatsAppBotNumber(): string | null {
  // Linked phone number in international format without '+', e.g. 447700900123
  if (connectionState === 'connected' && process.env.WHATSAPP_BOT_NUMBER) {
    return process.env.WHATSAPP_BOT_NUMBER;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
