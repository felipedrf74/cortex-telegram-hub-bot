// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Media message handlers — extracted from bot.ts Phase 5.
 *
 * Registers handlers for: photo, voice, video, document, sticker messages.
 */

import { Bot, InputFile } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { escapeHtml } from '../utils/telegram-formatter';
import { enqueue } from './shared-state';
import { handlePhotoMessage } from './photo';
import { saveScriptAsDocx } from '../services/video-study';
import { handleContent as handleContentDomain } from '../domains/content-creator';
import { resolveCanonicalUserId } from '../services/user-service';
import type { DomainHandlerFn } from './photo';

/**
 * Register media message handlers on the bot.
 *
 * @param bot - The Grammy bot instance
 * @param domainHandlers - The DOMAIN_HANDLERS map (injected for photo routing)
 */
export function registerMediaHandlers(
  bot: Bot,
  domainHandlers: Record<string, DomainHandlerFn>,
): void {

  // ── Photo handler: Vision → Unified classification (invoice / calendar / task) ──
  bot.on('message:photo', async (ctx) => {
    enqueue(ctx.from.id, async () => {
      await handlePhotoMessage(ctx, domainHandlers);
    });
  });

  // ── Unsupported media types ──
  bot.on('message:voice', async (ctx) => {
    await ctx.reply('🎤 Voice messages are not supported yet. Please type your message instead.');
  });

  bot.on('message:video', async (ctx) => {
    await ctx.reply('🎥 Video messages are not supported yet. You can send a photo or type a description.');
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    const caption = ctx.message?.caption?.trim() || '';

    // Handle /repurpose as caption on a document upload
    if (caption.startsWith('/repurpose') && doc?.file_name?.endsWith('.docx')) {
      enqueue(ctx.from!.id, async () => {
        const statusMsg = await ctx.reply('📥 Reading script...');
        try {
          const file = await ctx.api.getFile(doc.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
          const response = await fetch(fileUrl);
          const buffer = Buffer.from(await response.arrayBuffer());

          const mammoth = await import('mammoth');
          const result = await mammoth.default.extractRawText({ buffer });
          const scriptText = result.value;

          if (!scriptText || scriptText.trim().length < 50) {
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
              '❌ Could not extract enough text from the document.');
            return;
          }

          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '♻️ Repurposing script into multiple formats...');

          const repurposePrompt = `I have the following YouTube video script. Repurpose it into these formats:\n\n` +
            `1. **3 REELS/SHORTS** (30-60s each) — complete scripts with hook, body, CTA. Each one takes a different angle from the original.\n` +
            `2. **1 STORIES SEQUENCE** (5-7 stories) — text + poll/question stickers suggestions.\n\n` +
            `Everything in PT-BR. Make each format self-contained and optimized for its platform.\n\n` +
            `━━━ ORIGINAL SCRIPT ━━━\n\n${scriptText}`;

          const contentResponse = await handleContentDomain(repurposePrompt, ctx.from!.id, undefined, 8192);

          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '📄 Saving as Word document...');

          const topic = (doc.file_name || 'repurposed')
            .replace(/^script_/, '').replace(/\.docx$/, '').replace(/_/g, ' ').trim();

          const userId = resolveCanonicalUserId(ctx.from!.id) ?? undefined;
          const filePath = await saveScriptAsDocx(`Repurpose — ${topic}`, contentResponse.text, userId);

          await ctx.replyWithDocument(new InputFile(filePath), {
            caption: `♻️ <b>Repurposed: ${escapeHtml(topic)}</b>\n🎬 3 Reels · 📖 Stories`,
            parse_mode: 'HTML',
          });

          await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
        } catch (err: any) {
          logger.error({ err }, '/repurpose (document caption) failed');
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            `❌ Repurpose failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
      });
      return;
    }

    // Hint about /repurpose for .docx files
    if (doc?.file_name?.endsWith('.docx')) {
      await ctx.reply('📎 To repurpose a script, send the .docx file with <code>/repurpose</code> as caption.\n\nOr reply to the file with <code>/repurpose</code>.', { parse_mode: 'HTML' });
      return;
    }

    await ctx.reply('📎 File attachments are not supported yet. Please describe what you need in text.');
  });

  bot.on('message:sticker', async (ctx) => {
    await ctx.reply('😄 Stickers are fun, but I can only process text and photos!');
  });
}
