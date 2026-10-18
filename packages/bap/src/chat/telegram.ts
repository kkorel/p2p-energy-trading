/**
 * Telegram Bot — Oorja agent on Telegram.
 * Uses Telegraf for bot framework. Only starts if TELEGRAM_BOT_TOKEN is set.
 * Supports text, documents (PDF/JSON), and voice messages.
 */

import { createLogger, prisma } from '@p2p/shared';
import { processMessage, FileData } from './agent';
import { transcribeAudio, isSTTAvailable, STTError } from './sarvam-stt';

const logger = createLogger('TelegramBot');

let bot: any = null; // Telegraf instance (lazy-imported)

/**
 * Start the Telegram bot (long polling for dev, webhook for prod).
 * No-op if TELEGRAM_BOT_TOKEN is not set.
 */
export async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  logger.info(`Telegram bot init: token ${token ? 'present' : 'missing'}`);

  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
    return;
  }

  try {
    logger.info('Loading telegraf module...');
    const { Telegraf } = await import('telegraf');
    logger.info('Creating bot instance...');
    bot = new Telegraf(token);

    // /start command
    bot.start(async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);
        const response = await processMessage('TELEGRAM', chatId, '/start');
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram /start error: ${err.message}`);
        await ctx.reply('Something went wrong. Please try again.');
      }
    });

    // /reset command — deletes the session so the user starts fresh
    bot.command('reset', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);

        const session = await prisma.chatSession.findUnique({
          where: { platform_platformId: { platform: 'TELEGRAM', platformId: chatId } },
        });

        if (session) {
          await prisma.chatMessage.deleteMany({ where: { sessionId: session.id } });
          await prisma.chatSession.delete({ where: { id: session.id } });
        }

        await ctx.reply('Session reset! Send /start to begin again.');
      } catch (err: any) {
        logger.error(`Telegram /reset error: ${err.message}`);
        await ctx.reply('Something went wrong. Please try again.');
      }
    });

    // Text messages
    bot.on('text', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);
        const text = ctx.message.text;
        const response = await processMessage('TELEGRAM', chatId, text);
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram text error: ${err.message}`);
        await ctx.reply('Something went wrong. Please try again.');
      }
    });

    // Document uploads (PDF and JSON)
    bot.on('document', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);
        const doc = ctx.message.document;
        const fileName = doc.file_name || '';
        const mimeType = doc.mime_type || '';

        const isPdf = mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
        const isJson = mimeType.includes('json') || fileName.toLowerCase().endsWith('.json');

        if (!isPdf && !isJson) {
          await ctx.reply('Please upload your ID document (PDF or JSON file from your electricity company).');
          return;
        }

        // Download the file
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const axios = (await import('axios')).default;
        const fileResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(fileResponse.data);

        const resolvedMime = isJson ? 'application/json' : 'application/pdf';
        const fileData: FileData = {
          buffer,
          mimeType: resolvedMime,
          fileName: fileName || (isJson ? 'upload.json' : 'upload.pdf'),
        };

        const label = isJson ? '[JSON credential uploaded]' : '[PDF uploaded]';
        await ctx.reply('Processing your document...');

        const response = await processMessage('TELEGRAM', chatId, label, fileData);
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram document error: ${err.message}`);
        await ctx.reply('I had trouble processing that file. Please try again.');
      }
    });

    // Voice messages — transcribe and process as text
    bot.on('voice', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);
        const voice = ctx.message.voice;

        // Check if STT is available
        if (!isSTTAvailable()) {
          await ctx.reply(
            "Voice messages are not available right now. Please type your message instead.",
            { reply_to_message_id: ctx.message.message_id }
          );
          return;
        }

        // Show typing indicator while processing
        await ctx.sendChatAction('typing');

        // Download the voice file (Telegram uses OGG format)
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const axios = (await import('axios')).default;
        const fileResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(fileResponse.data);

        logger.info(`Received voice message: ${(audioBuffer.length / 1024).toFixed(1)}KB, duration: ${voice.duration}s`);

        // Transcribe the audio
        let transcript: string;
        let languageName: string;
        try {
          const result = await transcribeAudio(audioBuffer, 'audio/ogg');
          transcript = result.transcript;
          languageName = result.languageName;
          logger.info(`Voice transcription [${languageName}]: "${transcript.substring(0, 50)}..."`);
        } catch (error) {
          if (error instanceof STTError) {
            logger.warn(`Voice STT error: ${error.type} - ${error.message}`);
            await ctx.reply(
              error.retryable 
                ? `${error.message} Please try again.`
                : error.message,
              { reply_to_message_id: ctx.message.message_id }
            );
            return;
          }
          throw error;
        }

        // Process the transcript through the agent
        const response = await processMessage('TELEGRAM', chatId, transcript);
        
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram voice error: ${err.message}\n${err.stack}`);
        await ctx.reply('I had trouble understanding that. Please try again or type your message.');
      }
    });

    // Audio files (sent as documents with audio mime types)
    bot.on('audio', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat.id);
        const audio = ctx.message.audio;

        if (!isSTTAvailable()) {
          await ctx.reply(
            "Voice messages are not available right now. Please type your message instead.",
            { reply_to_message_id: ctx.message.message_id }
          );
          return;
        }

        await ctx.sendChatAction('typing');

        const fileLink = await ctx.telegram.getFileLink(audio.file_id);
        const axios = (await import('axios')).default;
        const fileResponse = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(fileResponse.data);

        const mimeType = audio.mime_type || 'audio/mpeg';
        logger.info(`Received audio file: ${(audioBuffer.length / 1024).toFixed(1)}KB, mime: ${mimeType}`);

        let transcript: string;
        try {
          const result = await transcribeAudio(audioBuffer, mimeType);
          transcript = result.transcript;
        } catch (error) {
          if (error instanceof STTError) {
            await ctx.reply(
              error.retryable ? `${error.message} Please try again.` : error.message,
              { reply_to_message_id: ctx.message.message_id }
            );
            return;
          }
          throw error;
        }

        const response = await processMessage('TELEGRAM', chatId, transcript);
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram audio error: ${err.message}`);
        await ctx.reply('I had trouble processing that audio. Please try again.');
      }
    });

    // Inline keyboard callback queries
    bot.on('callback_query', async (ctx: any) => {
      try {
        const chatId = String(ctx.chat?.id || ctx.callbackQuery.message?.chat?.id);
        const data = ctx.callbackQuery.data;
        await ctx.answerCbQuery();

        const response = await processMessage('TELEGRAM', chatId, data);
        for (const msg of response.messages) {
          await sendTelegramMessage(ctx, msg.text, msg.buttons);
        }
      } catch (err: any) {
        logger.error(`Telegram callback error: ${err.message}\n${err.stack}`);
        try {
          await ctx.reply('Something went wrong. Please try again.');
        } catch { /* ignore reply failure */ }
      }
    });

    // Catch unhandled telegraf errors
    bot.catch((err: any) => {
      logger.error(`Telegraf error: ${err.message}`);
    });

    // Launch bot (long polling) — drop pending updates to avoid conflicts.
    // Note: bot.launch() never resolves (infinite polling loop), so don't await it.
    bot.launch({ dropPendingUpdates: true }).catch((err: any) => {
      logger.error(`Telegram bot polling error: ${err.message}`);
      bot = null;
    });
    logger.info('Telegram bot started (long polling)');
  } catch (err: any) {
    logger.error(`Failed to start Telegram bot: ${err.message}`);
    bot = null;
  }
}

/**
 * Stop the Telegram bot gracefully.
 */
export function stopTelegramBot(): void {
  if (bot) {
    bot.stop('SIGTERM');
    logger.info('Telegram bot stopped');
    bot = null;
  }
}

/**
 * Send a message with optional inline keyboard buttons.
 */
async function sendTelegramMessage(
  ctx: any,
  text: string,
  buttons?: Array<{ text: string; callbackData?: string }>
): Promise<void> {
  if (!text) return;

  if (buttons && buttons.length > 0) {
    const keyboard = buttons.map((b) => [
      { text: b.text, callback_data: b.callbackData || b.text },
    ]);
    await ctx.reply(text, {
      reply_markup: { inline_keyboard: keyboard },
    });
  } else {
    await ctx.reply(text);
  }
}
