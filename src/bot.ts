// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { storeCallback, getCallback } from './utils/callback-store';
import { Bot, Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config';
import { logger } from './utils/logger';
import { DomainName } from './domains/types';
import { handleSecretary } from './domains/secretary';
import { handleTriathlon } from './domains/triathlon';
import { handleContent } from './domains/content-creator';
import { handleFinance } from './domains/finance';
import { handleCooking } from './domains/cooking';
import * as onboarding from './services/onboarding';
import { splitMessage, escapeHtml } from './utils/telegram-formatter';
import * as msTodo from './services/microsoft-todo';
import { createEvent as createCalendarEvent, deleteEvent as deleteCalendarEvent, isAnyCalendarConfigured } from './services/unified-calendar';
import { getMasterCategories } from './services/outlook-calendar';
import { classifyAndExtractImage } from './services/anthropic';
import {
  resolveReply as resolveAmazonReply,
} from './services/amazon-collector';
import {
  resolveReply as resolveUberReply,
} from './services/uber-collector';
import { saveScriptAsDocx } from './services/video-study';
import { isGarminConfigured, setMfaNotifier } from './services/garmin';
import { recordMessageProcessed } from './portal/telemetry';
import { handleContent as handleContentDomain } from './domains/content-creator';

// ─── Shared State (extracted to handlers/shared-state.ts) ────────────
import {
  isRateLimited, pendingEdits as _pendingEdits, pendingOnboarding as _pendingOnboarding,
  lastActiveDomain as _lastActiveDomain, pendingCalendarRef as _pendingCalendarRef,
  CONTINUITY_WINDOW_MS as _CONTINUITY_WINDOW_MS, enqueue as _enqueue,
  isHtmlParseError as _isHtmlParseError,
  setLastActiveDomain as _setLastActiveDomainFn,
  type PendingEdit, type PendingOnboarding,
} from './handlers/shared-state';
import { HELP_TEXT as _HELP_TEXT } from './handlers/help-text';
import {
  buildTaskListKeyboard, handleUndone, handleDeleteTask, handlePendingEdit,
  handleTodoSummary, handleStatus, handleDayOverview, handleWeekOverview,
} from './handlers/commands/secretary-helpers';
import { sendOnboardingStep } from './handlers/onboarding';
import {
  handlePhotoMessage, handleInvoiceFiling, handleCalendarExtraction, handleTaskExtraction,
} from './handlers/photo';
import { handleDomainMessage } from './handlers/message';
import { registerSecretaryCommands } from './handlers/commands/secretary';
import { registerSystemCommands } from './handlers/commands/system';
import { registerSkillCommands } from './handlers/commands/skills-commands';
import { registerContentCommands } from './handlers/commands/content';
import { registerFinanceCommands } from './handlers/commands/finance';
import { registerTriathlonCommands } from './handlers/commands/triathlon';

// Re-alias for backward compatibility within this file
const pendingEdits = _pendingEdits;
const pendingOnboarding = _pendingOnboarding;
const lastActiveDomain = _lastActiveDomain;
const pendingCalendarRef = _pendingCalendarRef;
const CONTINUITY_WINDOW_MS = _CONTINUITY_WINDOW_MS;

// ─── Domain Handler Map ──────────────────────────────────────────────

const DOMAIN_HANDLERS: Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

// Processing queue imported from shared-state
const enqueue = _enqueue;

/** Re-export setLastActiveDomain for scheduler.ts */
export { setLastActiveDomain } from './handlers/shared-state';
const isHtmlParseError = _isHtmlParseError;
const HELP_TEXT = _HELP_TEXT;

// ─── Bot Setup ───────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // ── Auth Middleware (DB-backed with legacy whitelist fallback) ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Allow /start through for unregistered users (registration flow)
    const text = (ctx.message && 'text' in ctx.message ? ctx.message.text : '') ?? '';
    if (text.startsWith('/start')) {
      await next();
      return;
    }

    // Check DB-registered user
    let authorized = false;
    try {
      const { getUserByTelegramId, touchUser: touch } = require('./services/user-service');
      const { t } = require('./utils/i18n');
      const user = getUserByTelegramId(userId);

      if (user) {
        if (user.status !== 'active') {
          await ctx.reply(t('suspended', user.language));
          return;
        }
        authorized = true;
        touch(userId); // Update last_active_at (non-blocking)
      }
    } catch {
      // user-service not loaded yet (startup race) — fall through to legacy
    }

    // Legacy fallback: TELEGRAM_ALLOWED_USER_IDS still works
    if (!authorized && config.telegram.allowedUserIds.includes(userId)) {
      authorized = true;
    }

    if (!authorized) {
      const { t, detectLanguageFromTelegram } = require('./utils/i18n');
      const lang = detectLanguageFromTelegram(ctx.from?.language_code);
      await ctx.reply(t('need_invite', lang));
      return;
    }

    await next();
  });

  // ── Rate Limit Middleware ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && isRateLimited(userId)) {
      await ctx.reply('⚠️ Slow down! Max 30 messages per minute.');
      return;
    }
    await next();
  });

  // ── Telemetry Middleware ──
  bot.use(async (ctx, next) => {
    recordMessageProcessed();
    await next();
  });

  // ── Register Garmin MFA notifier (sends Telegram message when MFA needed) ──
  setMfaNotifier(async (message: string) => {
    for (const userId of config.telegram.allowedUserIds) {
      try {
        await bot.api.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch (err) {
        logger.error({ err, userId }, 'Failed to send Garmin MFA notification');
      }
    }
  });

  // ── Register command handler modules ──
  registerSystemCommands(bot);
  registerSkillCommands(bot);
  registerSecretaryCommands(bot, DOMAIN_HANDLERS);
  registerContentCommands(bot);
  registerFinanceCommands(bot);
  registerTriathlonCommands(bot);

  // ── Inline Keyboard Callback Handlers ──

  bot.callbackQuery(/^td:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore if callback query is too old
    }

    if (action === 'dn') {
      // Cancel action
      await ctx.editMessageText('Cancelled.', { parse_mode: 'HTML' });
      return;
    }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('⚠️ This action has expired. Please try again.');
      return;
    }

    switch (action) {
      case 'ls': {
        // List selected — show tasks
        await ctx.editMessageText('Loading tasks...', { parse_mode: 'HTML' });
        const result = await msTodo.getTasks(cbData.listId, cbData.listName, { status: 'notStarted' });
        if (!result.success) {
          await ctx.editMessageText(`⚠️ Failed to fetch tasks: ${result.error}`);
          return;
        }
        const { formatMsTodoTasks } = require('./utils/telegram-formatter');
        const msg = formatMsTodoTasks(result.data, cbData.listName);
        const keyboard = buildTaskListKeyboard(result.data, cbData.listId);
        await ctx.editMessageText(msg, {
          parse_mode: 'HTML',
          reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
        });
        break;
      }

      case 'tc': {
        // Complete task
        const result = await msTodo.completeTask(cbData.listId, cbData.taskId);
        if (result.success) {
          await ctx.editMessageText(
            `✅ Completed: "<b>${escapeHtml(cbData.title)}</b>" [${escapeHtml(cbData.listName)}]`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.editMessageText(`⚠️ Failed to complete: ${result.error}`);
        }
        break;
      }

      case 'tx': {
        // Delete task — show confirmation
        const confirmRef = storeCallback({ ...cbData, type: 'task' });
        const keyboard = new InlineKeyboard()
          .text('Yes, delete', `td:dy:${confirmRef}`)
          .text('Cancel', `td:dn:${confirmRef}`);

        await ctx.editMessageText(
          `🗑 Delete "<b>${escapeHtml(cbData.title)}</b>"?`,
          { parse_mode: 'HTML', reply_markup: keyboard }
        );
        break;
      }

      case 'te': {
        // Edit task — show edit options
        const editKeyboard = new InlineKeyboard();
        const titleRef = storeCallback({ ...cbData, field: 'title' });
        const dueRef = storeCallback({ ...cbData, field: 'due' });
        const remRef = storeCallback({ ...cbData, field: 'reminder' });
        const prioRef = storeCallback({ ...cbData, field: 'priority' });

        editKeyboard
          .text('📝 Title', `td:ef:${titleRef}`)
          .text('📅 Due Date', `td:ef:${dueRef}`)
          .row()
          .text('⏰ Reminder', `td:ef:${remRef}`)
          .text('⚡ Priority', `td:ef:${prioRef}`)
          .row()
          .text('Cancel', 'td:dn:0');

        await ctx.editMessageText(
          `📝 Edit "<b>${escapeHtml(cbData.title)}</b>" — what do you want to change?`,
          { parse_mode: 'HTML', reply_markup: editKeyboard }
        );
        break;
      }

      case 'ef': {
        // Edit field — prompt user to type, then capture next message
        const field = cbData.field;
        const fieldLabels: Record<string, string> = {
          title: 'new title',
          due: 'due date (e.g., "tomorrow 5pm")',
          reminder: 'reminder time (e.g., "today 2pm")',
          priority: 'priority (low, normal, or high)',
        };
        const userId = ctx.from?.id;
        if (userId) {
          pendingEdits.set(userId, {
            listId: cbData.listId,
            taskId: cbData.taskId,
            title: cbData.title,
            listName: cbData.listName,
            field,
            expires: Date.now() + 120_000, // 2 min TTL
          });
        }
        await ctx.editMessageText(
          `📝 Send me the ${fieldLabels[field] || field} for "<b>${escapeHtml(cbData.title)}</b>":`,
          { parse_mode: 'HTML' }
        );
        break;
      }

      case 'dy': {
        // Confirm delete
        if (cbData.type === 'list') {
          const result = await msTodo.deleteList(cbData.listId);
          if (result.success) {
            await ctx.editMessageText(`🗑 List "<b>${escapeHtml(cbData.listName)}</b>" deleted.`, { parse_mode: 'HTML' });
          } else {
            await ctx.editMessageText(`⚠️ Failed to delete list: ${result.error}`);
          }
        } else {
          const result = await msTodo.deleteTask(cbData.listId, cbData.taskId);
          if (result.success) {
            await ctx.editMessageText(`🗑 Task "<b>${escapeHtml(cbData.title)}</b>" deleted.`, { parse_mode: 'HTML' });
          } else {
            await ctx.editMessageText(`⚠️ Failed to delete task: ${result.error}`);
          }
        }
        break;
      }

      case 'ep': {
        // Set priority from inline keyboard
        const level = cbData.level;
        const result = await msTodo.updateTask(cbData.listId, cbData.taskId, { importance: level });
        if (result.success) {
          await ctx.editMessageText(
            `⚡ Priority set to <b>${level}</b> for "${escapeHtml(cbData.title)}"`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.editMessageText(`⚠️ Failed to update priority: ${result.error}`);
        }
        break;
      }

      default:
        await ctx.editMessageText('⚠️ Unknown action.');
    }
  });

  // ── Calendar Callback Handler (create / cancel / undo) ──
  bot.callbackQuery(/^cal:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('⚠️ Ação expirada. Envie a foto novamente.');
      return;
    }

    if (action === 'create') {
      // ── Create the confirmed calendar events ──
      await ctx.editMessageText('⏳ Criando eventos no calendário...');

      const events = cbData.events as { title: string; start: string; end: string; description?: string }[];
      const categories = cbData.categories as string[];
      let successCount = 0;
      const createdTitles: string[] = [];

      for (const event of events) {
        try {
          const created = await createCalendarEvent({
            title: event.title,
            start: event.start,
            end: event.end,
            description: event.description,
            categories,
          });
          successCount++;
          createdTitles.push(created.summary);
        } catch (err) {
          logger.error({ err, eventTitle: event.title }, 'Failed to create calendar event from image');
        }
      }

      if (successCount === 0) {
        await ctx.editMessageText('⚠️ Falha ao criar os eventos. Tente novamente.');
        return;
      }

      let msg = `📅✅ <b>${successCount} evento${successCount > 1 ? 's' : ''} criado${successCount > 1 ? 's' : ''}:</b>\n`;
      for (const title of createdTitles) {
        msg += `\n  📌 ${escapeHtml(title)}`;
      }
      msg += `\n\n🏷️ ${escapeHtml(categories[0])}`;

      try {
        await ctx.editMessageText(msg, { parse_mode: 'HTML' });
      } catch (err) {
        if (isHtmlParseError(err)) await ctx.editMessageText(msg.replace(/<[^>]*>/g, ''));
        else throw err;
      }

    } else if (action === 'cancel') {
      await ctx.editMessageText('❌ Criação de eventos cancelada.');

    } else if (action === 'undo') {
      // ── Reprocess as task instead ──
      await ctx.editMessageText('🔄 Reprocessando como tarefa...');
      // Re-download image from Telegram (stored fileId instead of base64 to save memory)
      const { base64: reBase64, mediaType: reMT } = await downloadTelegramFile(bot, cbData.fileId);
      const reClassified = await classifyAndExtractImage(reBase64, reMT, (cbData.caption || '') + ' [TASK LIST]');
      if (reClassified.type === 'task') {
        await handleTaskExtraction(ctx as any, reClassified, cbData.caption || '');
      } else {
        const evtTitles = reClassified.type === 'calendar' ? reClassified.events.map(e => e.title) : [];
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: evtTitles.length > 0 ? 'Items from image' : 'Photo', subtasks: evtTitles },
          cbData.caption || '');
      }
    }
  });

  // ── Photo handler: Vision → Unified classification (invoice / calendar / task) ──
  bot.on('message:photo', async (ctx) => {
    enqueue(ctx.from.id, async () => {
      await handlePhotoMessage(ctx, DOMAIN_HANDLERS);
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

          const contentResponse = await handleContentDomain(repurposePrompt, 8192);

          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '📄 Saving as Word document...');

          const topic = (doc.file_name || 'repurposed')
            .replace(/^script_/, '').replace(/\.docx$/, '').replace(/_/g, ' ').trim();

          const filePath = await saveScriptAsDocx(`Repurpose — ${topic}`, contentResponse.text);

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

  // ── Catch-all: Route to domain ──
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;

    // Check for pending scraper 2FA reply (OTP code or CAPTCHA answer)
    if (resolveAmazonReply(ctx.chat.id, text)) return;
    if (resolveUberReply(ctx.chat.id, text)) return;

    // Check for pending inline edit (td:ef flow)
    const userId = ctx.from.id;
    const pending = pendingEdits.get(userId);
    if (pending && Date.now() < pending.expires) {
      pendingEdits.delete(userId);
      enqueue(userId, async () => {
        await handlePendingEdit(ctx, pending, text);
      });
      return;
    }
    pendingEdits.delete(userId); // clean up expired

    // Check for pending onboarding text input
    const pendingOb = pendingOnboarding.get(userId);
    if (pendingOb && Date.now() < pendingOb.expires) {
      pendingOnboarding.delete(userId);
      enqueue(userId, async () => {
        try {
          const result = onboarding.answerStep(userId, pendingOb.questionnaire, text);
          if (!result.nextStep) {
            const profile = onboarding.getProfile(userId, pendingOb.questionnaire);
            const entries = profile ? Object.entries(profile.data).map(([k, v]) =>
              `  <code>${k}</code>: ${escapeHtml(String(v))}`
            ).join('\n') : '';
            await ctx.reply(
              `✅ <b>Profile Complete!</b>\n\n${entries}\n\nYour ${pendingOb.questionnaire} profile is saved.`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply('✅ Got it!');
            const def = onboarding.getQuestionnaire(pendingOb.questionnaire)!;
            await sendOnboardingStep(ctx, pendingOb.questionnaire, result.nextStep, result.session.current_step, def.steps.length);
          }
        } catch (err: any) {
          await ctx.reply(`⚠️ ${escapeHtml(err.message)}. Please try again.`);
          // Re-set pending so user can retry
          pendingOnboarding.set(userId, pendingOb);
        }
      });
      return;
    }
    pendingOnboarding.delete(userId);

    enqueue(userId, async () => {
      await handleDomainMessage(ctx, text, DOMAIN_HANDLERS);
    });
  });

  // ── Error Handler ──
  bot.catch((err) => {
    const ctx = err.ctx;
    logger.error({ err: err.error }, 'Bot error');

    if (err.error instanceof GrammyError) {
      logger.error({ code: err.error.error_code }, 'Telegram API error');
    } else if (err.error instanceof HttpError) {
      logger.error('Network error');
    }

    ctx.reply('⚠️ Something went wrong. Please try again.').catch(() => {});
  });

  // ── Pre-load Outlook master categories (for calendar event colors) ──
  if (isAnyCalendarConfigured()) {
    getMasterCategories().catch((err) => logger.warn({ err }, 'Failed to pre-load master categories'));
  }

  return bot;
}

// ─── Telegram File Re-download Helper ────────────────────────────────

/** Re-download a photo from Telegram by file_id. Returns { base64, mediaType }. */
async function downloadTelegramFile(bot: Bot, fileId: string): Promise<{ base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }> {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
  const mediaType = (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp';
  return { base64: buffer.toString('base64'), mediaType };
}
