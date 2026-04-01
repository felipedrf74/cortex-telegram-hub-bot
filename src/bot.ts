// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { storeCallback, getCallback } from './utils/callback-store';
import { Bot, Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config';
import { getDb } from './services/database';
import { logger } from './utils/logger';
import { routeMessage, isSystemCommand, keywordMatch } from './router';
import { DomainName } from './domains/types';
import { handleSecretary } from './domains/secretary';
import { handleTriathlon } from './domains/triathlon';
import { handleContent } from './domains/content-creator';
import { handleFinance } from './domains/finance';
import { handleCooking } from './domains/cooking';
import * as onboarding from './services/onboarding';
import { getActiveReminders } from './state/reminders';
import { clearConversation, clearAllConversations, addToConversation, getLastAssistantMessage } from './state/conversation';
import {
  formatMsTodoLists, formatMsTodoTasks, formatMsTodoTaskCreated, formatMsTodoSummary,
  formatReminders, splitMessage, escapeHtml,
  formatChecklistItems, formatAllTasks, formatCompletedTasks,
} from './utils/telegram-formatter';
import * as msTodo from './services/microsoft-todo';
import { getEvents, createEvent as createCalendarEvent, updateEvent as updateCalendarEvent, deleteEvent as deleteCalendarEvent, isAnyCalendarConfigured, CalendarSource } from './services/unified-calendar';
import { getCategoryNameForColor, getMasterCategories } from './services/outlook-calendar';
import { isOutlookMailConfigured, getUnreadCount as getOutlookUnread } from './services/outlook-mail';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, now, formatTime, formatDateTime, parseNaturalDate } from './utils/date-parser';
import { classifyAndExtractImage, ImageInvoiceResult, ImageCalendarResult, ImageTaskResult } from './services/anthropic';
import { runContentDiscovery } from './services/content-discovery';
import { saveIdea, getSavedIdeas, markIdeaUsed, deleteIdea } from './state/saved-ideas';
import { InvoiceAnalysis, fileInvoice, isInvoiceFilingConfigured, testSshConnection, PT_MONTHS } from './services/invoice-filer';
import { addTransaction, parseReceiptAmount } from './services/finance-tracker';
import { enqueueInvoice, getPendingCount } from './services/invoice-queue';
import { collectMonthlyInvoices, formatCollectionNotification, getBuiltinVendors, getAllVendors } from './services/invoice-collector';
import {
  addAndAnalyzeChannel,
  processAllChannels,
} from './services/channel-learner';
import {
  getAllChannels,
  removeChannel as removeRefChannel,
  buildKnowledgePromptBlock,
} from './state/content-references';
import { studyVideo, getTranscript, formatStudyResult, formatTranscriptMessage, saveTranscriptAsDocx, saveStudyAsDocx, saveScriptAsDocx } from './services/video-study';
import { recordFiling, deleteAmazonFilings, deleteUberFilings } from './state/invoice-filings';
import { addVendor, removeVendorByName, getActiveVendors as getCustomVendors } from './state/invoice-vendors';
import {
  collectAmazonInvoices, formatAmazonNotification, isAmazonConfigured,
  resolveReply as resolveAmazonReply, registerReplyWaiter as registerAmazonReplyWaiter,
} from './services/amazon-collector';
import {
  collectUberInvoices, formatUberNotification, isUberConfigured,
  resolveReply as resolveUberReply, registerReplyWaiter as registerUberReplyWaiter,
} from './services/uber-collector';
import { generateCoachBriefing, CoachRecommendation } from './services/garmin-coach';
import {
  sendTopicCandidates, sendWeeklyPackage,
  updateFeedback, markScriptGenerated, getTopicById,
  generateReelScript, generateYouTubeScript,
} from './services/content-workflow';
import { setLastCoachState } from './domains/domain-handler';
import {
  deepSearch, getSources, getHotNews, isContentEngineConfigured,
  formatDeepSearch, formatSources, formatHotNews,
  getTrending, getReaction, getHooks, getScript, getTitles,
  getThumbnail, getCaption, getCompetitor, getGaps, getSeo,
  getRepurpose, logFeedback, getReport,
  formatTrending, formatReaction, formatHooks, formatScript, formatTitles,
  formatThumbnail, formatCaption, formatCompetitor, formatGaps, formatSeo,
  formatRepurpose, formatFeedback, formatReport,
  maybeSaveToFile, saveContentAsDocx,
} from './services/content-engine';
import { isGarminConfigured, setMfaNotifier, isMfaPending, submitMfaCode } from './services/garmin';
import { recordMessageProcessed } from './portal/telemetry';
import { handlePipelineStatus, handleFilmedStage, handleEditingStage, handlePublishedStage } from './commands/pipeline';
import { handleAddBook, handleBookNote, handleListBooks, handleBookIdea } from './commands/books';
import { handleAddSEOKeyword, handleSEORank } from './agents/seo-agent';
import { handleAutoresearch, handleEvalScore } from './commands/autoresearch';
import { getAllSkillStatuses, getSkillStatus, type SkillStatus } from './skills/skill-manager';
import { handleSkillsList, handleSkillCommand } from './commands/skills';
import fs from 'fs';
import path from 'path';

// ─── Content Engine: send inline OR save to file ─────────────────────

/**
 * If the formatted message is too long, save full output to ~/Desktop/IDEAS
 * and send a short summary + file path in Telegram. Otherwise send inline.
 *
 * @param forceFile - commands like genscript/competitor always save a file
 */
async function sendOrSave(
  ctx: Context,
  msg: string,
  command: string,
  topic: string,
  forceFile = false,
): Promise<void> {
  // Always try to save as DOCX and send as downloadable file
  const result = await saveContentAsDocx(msg, command, topic, forceFile);
  if (result) {
    // Send a clean short summary + the file + Drive link
    const plain = msg.replace(/<[^>]*>/g, '');
    const firstLine = plain.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 120) || topic;
    const driveLink = result.driveUrl ? `\n\n📂 <a href="${escapeHtml(result.driveUrl)}">Open in Google Drive</a>` : '';
    const caption = `📄 <b>${escapeHtml(command.toUpperCase())}</b> — ${escapeHtml(topic)}\n\n${escapeHtml(firstLine)}${firstLine.length >= 120 ? '...' : ''}${driveLink}`;

    try {
      await ctx.replyWithDocument(new InputFile(result.filePath), {
        caption,
        parse_mode: 'HTML',
      });
    } catch (err) {
      // Fallback: send file path if document upload fails
      logger.error({ err }, `Failed to send ${command} DOCX via Telegram`);
      await ctx.reply(`📁 Saved to: <code>${escapeHtml(result.filePath)}</code>`, { parse_mode: 'HTML' });
    }
  } else {
    // Short enough — send inline
    for (const chunk of splitMessage(msg)) {
      try { await ctx.reply(chunk, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }); }
      catch (err) { if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, '')); else throw err; }
    }
  }
}

// ─── Shared Command Handlers ────────────────────────────────────────

/**
 * Unified script handler — used by both /script and /genscript (alias).
 * Always includes research + intelligence bus signal injection.
 */
async function handleScriptCommand(ctx: Context): Promise<void> {
  if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
  const topic = ctx.match?.toString().trim();
  if (!topic) {
    await ctx.reply(
      '📝 <b>Usage:</b> <code>/script &lt;topic&gt;</code>\n\n' +
      'Generates a full video script with research + intelligence.\n\n' +
      'Examples:\n' +
      '  <code>/script dieta carnívora 30 dias resultados</code>\n' +
      '  <code>/script por que o estado é seu inimigo</code>\n' +
      '  <code>/script reaction to trending topic about AI</code>',
      { parse_mode: 'HTML' },
    );
    return;
  }
  await ctx.reply('📝 Generating script… this takes 30-60s (research + writing).', { parse_mode: 'HTML' });
  const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
  try {
    const result = await getScript(topic);
    clearInterval(typingInterval);
    const msg = formatScript(result);
    await sendOrSave(ctx, msg, 'script', topic, true);
  } catch (err: any) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Script generation failed');
    await ctx.reply(`❌ Script failed: ${escapeHtml(err.message || 'Unknown error')}`);
  }
}

/**
 * Unified discover handler — used by /discover, /hotnews (alias), /trending (alias).
 * Flags: --news (hotnews only), --platform (cross-platform trending), default (full discovery).
 */
async function handleDiscoverCommand(ctx: Context, mode: 'full' | 'news' | 'platform' = 'full'): Promise<void> {
  if (mode === 'news') {
    // /hotnews behavior
    if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await getHotNews();
      clearInterval(typingInterval);
      const msg = formatHotNews(result);
      await sendOrSave(ctx, msg, 'discover', 'trending-news', true);
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Hot news failed');
      await ctx.reply(`❌ Discover (news) failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  } else if (mode === 'platform') {
    // /trending behavior
    if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
    const niche = ctx.match?.toString().replace(/--platform\s*/i, '').trim() || undefined;
    await ctx.replyWithChatAction('typing');
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await getTrending(niche);
      clearInterval(typingInterval);
      const msg = formatTrending(result);
      await sendOrSave(ctx, msg, 'discover', niche || 'general', true);
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Trending failed');
      await ctx.reply(`❌ Discover (platform) failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  } else {
    // Full discovery (original /discover behavior)
    await ctx.replyWithChatAction('typing');
    await ctx.reply('🔍 Running content discovery… this takes ~2 minutes.', { parse_mode: 'HTML' });
    const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
    try {
      const result = await runContentDiscovery();
      clearInterval(typingInterval);
      const dateStr = now().toFormat('yyyy-MM-dd');
      let msg = `🎬 <b>Content Ideas Ready</b>\n\n`;
      if (result.ideas.length > 0) {
        for (let i = 0; i < result.ideas.length; i++) {
          msg += `${i + 1}. ${escapeHtml(result.ideas[i])}\n`;
        }
      } else {
        msg += `Ideas generated but couldn't parse titles — check the file.\n`;
      }
      msg += `\n📁 <code>${escapeHtml(result.filePath)}</code>`;
      msg += `\n🔍 ${result.searchCount} web searches used`;
      for (const chunk of splitMessage(msg)) {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      }
      if (result.ideas.length > 0) {
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < Math.min(result.ideas.length, 10); i++) {
          const ref = storeCallback({ title: result.ideas[i], date: dateStr });
          keyboard.text(`💾 ${i + 1}`, `ci:save:${ref}`);
          if ((i + 1) % 5 === 0) keyboard.row();
        }
        await ctx.reply('Tap to save ideas you want to pursue:', { reply_markup: keyboard });
      }
    } catch (err: any) {
      clearInterval(typingInterval);
      logger.error({ err }, 'Content discovery failed');
      await ctx.reply(`❌ Content discovery failed: ${escapeHtml(err.message || 'Unknown error')}`);
    }
  }
}

// ─── Rate Limiter ────────────────────────────────────────────────────

const rateLimitMap = new Map<number, number[]>();

function isRateLimited(userId: number): boolean {
  const ts = Date.now();
  const window = 60_000; // 1 minute
  const max = config.rateLimit.maxMessagesPerMinute;

  let timestamps = rateLimitMap.get(userId) || [];
  timestamps = timestamps.filter((t) => ts - t < window);

  if (timestamps.length >= max) {
    rateLimitMap.set(userId, timestamps); // update pruned list, but don't record blocked msg
    return true;
  }

  timestamps.push(ts);
  rateLimitMap.set(userId, timestamps);
  return false;
}

// ─── Domain Handler Map ──────────────────────────────────────────────

const DOMAIN_HANDLERS: Record<string, (message: string, userId?: number) => Promise<{ text: string; domain: DomainName }>> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
  finance: handleFinance,
  cooking: handleCooking,
};

// ─── Processing Queue (sequential per user) ─────────────────────────

const processingQueue = new Map<number, Promise<void>>();

function enqueue(userId: number, fn: () => Promise<void>): void {
  const prev = processingQueue.get(userId) || Promise.resolve();
  const next = prev
    .then(fn)
    .catch((err) => { logger.error({ err, userId }, 'Queued handler failed'); })
    .finally(() => {
      // Clean up Map entry when the chain settles (only if still the latest)
      if (processingQueue.get(userId) === next) processingQueue.delete(userId);
    });
  processingQueue.set(userId, next);
}

// ─── Inline Keyboard Callback Store (shared from utils/callback-store.ts) ───

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

// ─── HTML Parse Error Guard ──────────────────────────────────────────

/**
 * Checks whether a Telegram API error is specifically an HTML parse failure.
 * grammY wraps these as GrammyError with description "Bad Request: can't parse entities…"
 * Only these should trigger a plaintext fallback; other errors (network, rate-limit) must propagate.
 */
function isHtmlParseError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const msg = ((err as any).message || (err as any).description || '').toLowerCase();
    return msg.includes("can't parse entities") || msg.includes('parse entities');
  }
  return false;
}

// ─── Coach Recommendation → Calendar Update ────────────────────────

/**
 * Apply a single coach recommendation to the calendar.
 * - MODIFY / SWAP → updateEvent with new title/times
 * - REST → updateEvent with cancelled title (keeps the slot visible but marked)
 * - KEEP → no-op (shouldn't be called for KEEP)
 */
async function applyCoachRecommendation(rec: CoachRecommendation): Promise<void> {
  if (rec.action === 'KEEP') return; // No change needed

  if (rec.action === 'REST') {
    // Mark the event as cancelled (don't delete — athlete sees it on calendar)
    await updateCalendarEvent(
      {
        event_id: rec.eventId,
        new_title: rec.newTitle || `❌ CANCELLED — ${rec.originalTitle}`,
      },
      rec.source,
    );
    return;
  }

  // MODIFY or SWAP — update title and optionally times
  const updateData: { event_id: string; new_title?: string; new_start?: string; new_end?: string } = {
    event_id: rec.eventId,
  };
  if (rec.newTitle && rec.newTitle !== rec.originalTitle) {
    updateData.new_title = rec.newTitle;
  }
  if (rec.newStart) updateData.new_start = rec.newStart;
  if (rec.newEnd) updateData.new_end = rec.newEnd;

  await updateCalendarEvent(updateData, rec.source);
}

// ─── Caption → Outlook Calendar Category ────────────────────────────

interface CalendarCaptionInfo {
  categories: string[];
  prefix: string;     // "SMS - ", "EC - ", or ""
  label: string;      // "SMS", "EC", or "Pessoal"
}

/**
 * Resolves caption keywords to Outlook category names by querying
 * the user's master categories (cached after first fetch).
 * SMS → blue preset, EC → green preset, default → red preset.
 */
async function parseCaptionInfo(caption: string): Promise<CalendarCaptionInfo> {
  if (caption) {
    const upper = caption.toUpperCase().trim();
    if (upper.includes('SMS')) {
      const cat = await getCategoryNameForColor('blue');
      return { categories: [cat], prefix: 'SMS - ', label: 'SMS' };
    }
    if (upper.includes('EC')) {
      const cat = await getCategoryNameForColor('green');
      return { categories: [cat], prefix: 'EC - ', label: 'EC' };
    }
  }
  const cat = await getCategoryNameForColor('red');
  return { categories: [cat], prefix: '', label: 'Pessoal' };
}

// ─── Pending Edit State (per user) ──────────────────────────────────

interface PendingEdit {
  listId: string;
  taskId: string;
  title: string;
  listName: string;
  field: string;
  expires: number;
}

const pendingEdits = new Map<number, PendingEdit>();

// ─── Pending Onboarding Text Input (per user) ──────────────────────

interface PendingOnboarding {
  questionnaire: string;
  step: onboarding.QuestionStep;
  expires: number;
}

const pendingOnboarding = new Map<number, PendingOnboarding>();

// ─── Last Active Domain (per user) ──────────────────────────────────

interface LastDomainState {
  domain: DomainName;
  timestamp: number;
}

const lastActiveDomain = new Map<number, LastDomainState>();

/** Tracks the last pending calendar callback ref per user, so text follow-ups can reference it */
const pendingCalendarRef = new Map<number, { ref: string; timestamp: number }>();

/** Conversation continuity window — if user replies within this time, prefer sticking with the same domain */
const CONTINUITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── Periodic Memory Cleanup ─────────────────────────────────────────
// Prevent unbounded growth of per-user Maps over long-running sessions.
setInterval(() => {
  const now = Date.now();

  // Clean up stale rate-limit entries (no timestamps within the last minute)
  for (const [userId, timestamps] of rateLimitMap) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) rateLimitMap.delete(userId);
    else rateLimitMap.set(userId, fresh);
  }

  // Clean up expired lastActiveDomain entries (older than continuity window)
  for (const [userId, state] of lastActiveDomain) {
    if (now - state.timestamp > CONTINUITY_WINDOW_MS) lastActiveDomain.delete(userId);
  }

  // Clean up expired pending edits (2-min TTL)
  for (const [userId, edit] of pendingEdits) {
    if (now > edit.expires) pendingEdits.delete(userId);
  }
}, 10 * 60 * 1000); // every 10 minutes

/** Set last active domain for a user (used by scheduler for cron-triggered messages) */
export function setLastActiveDomain(userId: number, domain: DomainName): void {
  lastActiveDomain.set(userId, { domain, timestamp: Date.now() });
}

// ─── Bot Setup ───────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // ── Auth Middleware ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.telegram.allowedUserIds.includes(userId)) {
      logger.warn({ userId, username: ctx.from?.username }, 'Unauthorized access attempt');
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

  // ── System Commands ──
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 Hey Felipe! Your command hub is online.\n\nType /help to see all available commands.',
      { parse_mode: 'HTML' }
    );
  });

  bot.command('version', async (ctx) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    const commitHash = process.env.GIT_COMMIT || 'dev';
    const nodeVersion = process.version;
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
    await ctx.reply(
      `<b>Nexus Hub</b> v${pkg.version}\n` +
      `Commit: <code>${commitHash}</code>\n` +
      `Node: ${nodeVersion}\n` +
      `Uptime: ${uptimeStr}`,
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
  });

  bot.command('skills', async (ctx) => {
    await handleSkillsList(ctx);
  });

  bot.command('skill', async (ctx) => {
    await handleSkillCommand(ctx);
  });

  bot.command('status', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await handleStatus(ctx);
    });
  });

  bot.command('clear', async (ctx) => {
    const domain = ctx.match?.trim();
    if (domain && ['secretary', 'triathlon', 'content'].includes(domain)) {
      clearConversation(domain as DomainName);
      await ctx.reply(`🗑 Cleared conversation history for <b>${domain}</b>.`, { parse_mode: 'HTML' });
    } else if (domain === 'all') {
      clearAllConversations();
      await ctx.reply('🗑 Cleared all conversation histories.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Usage: /clear [secretary|triathlon|content|all]');
    }
  });

  // ── Microsoft To Do Commands ──

  bot.command('lists', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured. Set Outlook credentials first.');
        return;
      }
      await ctx.replyWithChatAction('typing');
      const result = await msTodo.getLists();
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch lists: ${result.error}`);
        return;
      }

      const msg = formatMsTodoLists(result.data);
      const keyboard = new InlineKeyboard();
      for (const list of result.data) {
        const ref = storeCallback({ listId: list.id, listName: list.displayName });
        keyboard.text(list.displayName, `td:ls:${ref}`).row();
      }

      await ctx.reply(msg + '\n\nTap a list to see its tasks:', {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });
  });

  bot.command('tasks', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const listName = ctx.match?.trim() || config.todo.defaultList;
      const list = await msTodo.findListByName(listName);
      if (!list) {
        await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found. Use /lists to see available lists.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await msTodo.getTasks(list.id, list.displayName, { status: 'notStarted' });
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
        return;
      }

      const msg = formatMsTodoTasks(result.data, list.displayName);
      const keyboard = buildTaskListKeyboard(result.data, list.id);

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
    });
  });

  bot.command('newtask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const text = ctx.match?.trim();
      if (!text) {
        await ctx.reply('Usage: /newtask Buy coffee\nor: /newtask Work | Review PR #42');
        return;
      }
      await ctx.replyWithChatAction('typing');

      // Parse: "/newtask ListName | Task Title" or "/newtask Task Title"
      let listName = config.todo.defaultList;
      let title = text;

      if (text.includes('|')) {
        const parts = text.split('|', 2);
        listName = parts[0].trim();
        title = parts[1].trim();
      }

      const list = await msTodo.findListByName(listName);
      if (!list) {
        await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found. Use /lists to see available lists.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await msTodo.createTask(list.id, list.displayName, { title });
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to create task: ${result.error}`);
        return;
      }

      await ctx.reply(formatMsTodoTaskCreated(result.data), { parse_mode: 'HTML' });
    });
  });

  bot.command('done', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /done Buy coffee');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const searchResult = await msTodo.searchTasks(query);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(query)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      // Filter to non-completed tasks
      const pending = searchResult.data.filter((t) => t.status !== 'completed');
      if (pending.length === 0) {
        await ctx.reply(`✅ "${escapeHtml(query)}" is already completed.`, { parse_mode: 'HTML' });
        return;
      }

      if (pending.length === 1) {
        const task = pending[0];
        const result = await msTodo.completeTask(task.listId, task.id);
        if (result.success) {
          await ctx.reply(`✅ Completed: "<b>${escapeHtml(task.title)}</b>" [${escapeHtml(task.listName)}]`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`⚠️ Failed to complete task: ${result.error}`);
        }
        return;
      }

      // Multiple matches — show selection keyboard
      const keyboard = new InlineKeyboard();
      for (const task of pending.slice(0, 8)) {
        const ref = storeCallback({ listId: task.listId, taskId: task.id, title: task.title, listName: task.listName });
        keyboard.text(`${task.title} [${task.listName}]`.slice(0, 50), `td:tc:${ref}`).row();
      }
      keyboard.text('Cancel', 'td:dn:0').row();

      await ctx.reply(`Multiple tasks match "<b>${escapeHtml(query)}</b>". Which one?`, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });
  });

  bot.command('undone', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /undone Buy coffee');
        return;
      }
      await ctx.replyWithChatAction('typing');
      await handleUndone(ctx, query);
    });
  });

  bot.command('newlist', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('Usage: /newlist Groceries');
        return;
      }
      await ctx.replyWithChatAction('typing');
      const result = await msTodo.createList(name);
      if (result.success) {
        await ctx.reply(`📋 List created: "<b>${escapeHtml(result.data.displayName)}</b>"`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Failed to create list: ${result.error}`);
      }
    });
  });

  bot.command('deletelist', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('Usage: /deletelist Old Projects');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const list = await msTodo.findListByName(name);
      if (!list) {
        await ctx.reply(`⚠️ List "${escapeHtml(name)}" not found.`, { parse_mode: 'HTML' });
        return;
      }

      const ref = storeCallback({ listId: list.id, listName: list.displayName, type: 'list' });
      const keyboard = new InlineKeyboard()
        .text('Yes, delete', `td:dy:${ref}`)
        .text('Cancel', `td:dn:${ref}`);

      await ctx.reply(`🗑 Are you sure you want to delete list "<b>${escapeHtml(list.displayName)}</b>"? This cannot be undone.`, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    });
  });

  bot.command('deletetask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /deletetask Old reminder');
        return;
      }
      await ctx.replyWithChatAction('typing');
      await handleDeleteTask(ctx, query);
    });
  });

  bot.command('due', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /due Review PR | tomorrow 5pm');
        return;
      }
      // Route to secretary domain for intelligent handling
      await handleDomainMessage(ctx, `/due ${text}`);
    });
  });

  bot.command('remind', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /remind Meeting prep | today 2pm');
        return;
      }
      await handleDomainMessage(ctx, `/remind ${text}`);
    });
  });

  bot.command('priority', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /priority Review PR | high');
        return;
      }
      await handleDomainMessage(ctx, `/priority ${text}`);
    });
  });

  bot.command('search', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /search coffee');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const result = await msTodo.searchTasks(query);
      if (!result.success) {
        await ctx.reply(`⚠️ Search failed: ${result.error}`);
        return;
      }

      if (result.data.length === 0) {
        await ctx.reply(`🔍 No tasks matching "${escapeHtml(query)}".`, { parse_mode: 'HTML' });
        return;
      }

      let msg = `<b>🔍 Search: "${escapeHtml(query)}" (${result.data.length} results)</b>\n\n`;
      for (const task of result.data.slice(0, 15)) {
        const status = task.status === 'completed' ? '✅' : '⬜';
        msg += `${status} ${escapeHtml(task.title)} <i>[${escapeHtml(task.listName)}]</i>\n`;
      }
      if (result.data.length > 15) msg += `\n... and ${result.data.length - 15} more`;

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });
  });

  bot.command('todosummary', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');
      await handleTodoSummary(ctx);
    });
  });

  // ── Extended To Do Commands ──

  bot.command('overdue', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const pendingResult = await msTodo.getAllPendingTasks();
      if (!pendingResult.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${pendingResult.error}`);
        return;
      }

      const nowDate = new Date();
      const overdue = pendingResult.data.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);

      if (overdue.length === 0) {
        await ctx.reply('✅ No overdue tasks. You\'re on track!');
        return;
      }

      let msg = `<b>⚠️ Overdue Tasks (${overdue.length})</b>\n\n`;
      for (const t of overdue) {
        msg += `⚠️ ${escapeHtml(t.title)} — was due ${formatDateTime(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }

      await ctx.reply(msg.trim(), { parse_mode: 'HTML' });
    });
  });

  bot.command('duetoday', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const result = await msTodo.getTasksDueInRange(startOfDay(), endOfDay());
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
        return;
      }

      if (result.data.length === 0) {
        await ctx.reply('📅 No tasks due today.');
        return;
      }

      let msg = `<b>📅 Due Today (${result.data.length})</b>\n\n`;
      for (const t of result.data) {
        const imp = t.importance !== 'normal' ? ` ${t.importance === 'high' ? '🔴' : '🟢'}` : '';
        msg += `⬜${imp} ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }

      await ctx.reply(msg.trim(), { parse_mode: 'HTML' });
    });
  });

  bot.command('dueweek', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const result = await msTodo.getTasksDueInRange(startOfWeek(), endOfWeek());
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
        return;
      }

      if (result.data.length === 0) {
        await ctx.reply('📅 No tasks due this week.');
        return;
      }

      let msg = `<b>📅 Due This Week (${result.data.length})</b>\n\n`;
      for (const t of result.data) {
        const imp = t.importance !== 'normal' ? ` ${t.importance === 'high' ? '🔴' : '🟢'}` : '';
        msg += `⬜${imp} ${escapeHtml(t.title)} — due ${formatDateTime(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
      }

      const parts = splitMessage(msg.trim());
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('alltasks', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const result = await msTodo.getAllPendingTasks();
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
        return;
      }

      const msg = formatAllTasks(result.data);
      const parts = splitMessage(msg);
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('completed', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const listName = ctx.match?.trim();

      if (listName) {
        // Completed tasks from a specific list
        const list = await msTodo.findListByName(listName);
        if (!list) {
          await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found.`, { parse_mode: 'HTML' });
          return;
        }
        const result = await msTodo.getTasks(list.id, list.displayName, { status: 'completed' });
        if (!result.success) {
          await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
          return;
        }
        await ctx.reply(formatCompletedTasks(result.data, list.displayName), { parse_mode: 'HTML' });
      } else {
        // Completed tasks across all lists (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = await msTodo.getCompletedTasksInRange(sevenDaysAgo, new Date().toISOString());
        if (!result.success) {
          await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
          return;
        }
        await ctx.reply(formatCompletedTasks(result.data), { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('movetask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /movetask Buy milk | Groceries');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, targetListName] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await msTodo.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data.find((t) => t.status !== 'completed') || searchResult.data[0];

      const targetList = await msTodo.findListByName(targetListName);
      if (!targetList) {
        await ctx.reply(`⚠️ List "${escapeHtml(targetListName)}" not found.`, { parse_mode: 'HTML' });
        return;
      }

      if (task.listId === targetList.id) {
        await ctx.reply(`📋 "${escapeHtml(task.title)}" is already in <b>${escapeHtml(targetList.displayName)}</b>.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await msTodo.moveTask(task.listId, task.id, targetList.id, targetList.displayName);
      if (result.success) {
        await ctx.reply(`📦 Moved "<b>${escapeHtml(task.title)}</b>" from ${escapeHtml(task.listName)} → <b>${escapeHtml(targetList.displayName)}</b>`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Failed to move task: ${result.error}`);
      }
    });
  });

  bot.command('edittask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /edittask Buy milk | Buy oat milk');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, newTitle] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await msTodo.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await msTodo.updateTask(task.listId, task.id, { title: newTitle });
      if (result.success) {
        await ctx.reply(`📝 Renamed: "${escapeHtml(task.title)}" → "<b>${escapeHtml(newTitle)}</b>" [${escapeHtml(task.listName)}]`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Failed to rename task: ${result.error}`);
      }
    });
  });

  bot.command('notetask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /notetask Buy milk | Get the organic brand from Lidl');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, note] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await msTodo.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await msTodo.updateTask(task.listId, task.id, { body: note });
      if (result.success) {
        await ctx.reply(`📝 Note added to "<b>${escapeHtml(task.title)}</b>": ${escapeHtml(note)}`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Failed to add note: ${result.error}`);
      }
    });
  });

  bot.command('addstep', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /addstep Buy milk | Check fridge first');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, stepTitle] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await msTodo.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await msTodo.addChecklistItem(task.listId, task.id, stepTitle);
      if (result.success) {
        await ctx.reply(`☑️ Step added to "<b>${escapeHtml(task.title)}</b>": ${escapeHtml(stepTitle)}`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Failed to add step: ${result.error}`);
      }
    });
  });

  bot.command('steps', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /steps Buy milk');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const searchResult = await msTodo.searchTasks(query);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(query)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await msTodo.getChecklistItems(task.listId, task.id);
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch steps: ${result.error}`);
        return;
      }

      await ctx.reply(formatChecklistItems(result.data, task.title), { parse_mode: 'HTML' });
    });
  });

  // Legacy commands that now route to secretary domain for MS Todo handling
  bot.command('todo', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply('Usage: /todo Buy new running shoes\nor: /newtask Work | Review PR');
      return;
    }
    enqueue(ctx.from!.id, async () => {
      await handleDomainMessage(ctx, `/todo ${text}`);
    });
  });

  bot.command('todos', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!msTodo.isOutlookTodoConfigured()) {
        await ctx.reply('⚠️ Microsoft To Do is not configured.');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const defaultList = await msTodo.getDefaultList();
      if (!defaultList) {
        await ctx.reply('⚠️ Default list not found. Use /lists to see available lists.');
        return;
      }

      const result = await msTodo.getTasks(defaultList.id, defaultList.displayName, { status: 'notStarted' });
      if (!result.success) {
        await ctx.reply(`⚠️ Failed to fetch tasks: ${result.error}`);
        return;
      }

      const msg = formatMsTodoTasks(result.data, defaultList.displayName);
      const keyboard = buildTaskListKeyboard(result.data, defaultList.id);

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
    });
  });

  // ── Day/Week Quick Commands ──
  bot.command('day', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await handleDayOverview(ctx);
    });
  });

  bot.command('week', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await handleWeekOverview(ctx);
    });
  });

  // ── Content Discovery (unified: /discover, /discover --news, /discover --platform) ──
  bot.command('discover', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const input = ctx.match?.toString().trim() || '';
      if (input.startsWith('--news')) {
        await handleDiscoverCommand(ctx, 'news');
      } else if (input.startsWith('--platform')) {
        await handleDiscoverCommand(ctx, 'platform');
      } else {
        await handleDiscoverCommand(ctx, 'full');
      }
    });
  });

  bot.command('ideas', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const dateArg = ctx.match?.trim();

      // /ideas saved — show saved content ideas
      if (dateArg === 'saved') {
        const saved = getSavedIdeas();
        if (saved.length === 0) {
          await ctx.reply('📭 No saved ideas. Use /discover and tap 💾 to save ideas.');
          return;
        }
        let msg = `💾 <b>Saved Ideas</b> (${saved.length})\n\n`;
        for (const idea of saved) {
          msg += `• ${escapeHtml(idea.title)} <i>(${idea.source_date})</i>\n`;
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      const dateStr = dateArg || now().toFormat('yyyy-MM-dd');

      const dir = path.resolve(config.app.databasePath, '../content-ideas');
      const filePath = path.join(dir, `${dateStr}.md`);

      if (!fs.existsSync(filePath)) {
        const available: string[] = [];
        if (fs.existsSync(dir)) {
          available.push(
            ...fs.readdirSync(dir)
              .filter((f) => f.endsWith('.md'))
              .map((f) => f.replace('.md', ''))
              .sort()
              .slice(-5)
          );
        }
        let msg = `📭 No content ideas found for <b>${escapeHtml(dateStr)}</b>.`;
        if (available.length > 0) {
          msg += `\n\nAvailable dates:\n${available.map((d) => `• /ideas ${d}`).join('\n')}`;
        } else {
          msg += '\n\nRun /discover to generate ideas first.';
        }
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      for (const chunk of splitMessage(content)) {
        try {
          await ctx.reply(chunk, { parse_mode: 'HTML' });
        } catch (err) {
          if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
          else throw err;
        }
      }
    });
  });

  // ── Content Engine Commands (Python microservice) ──

  bot.command('deepsearch', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) {
        await ctx.reply('⚠️ Content Engine not enabled. Set CONTENT_ENGINE_ENABLED=true and start the Python service.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /deepsearch <topic>\nExample: /deepsearch Lula economia reação');
        return;
      }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await deepSearch(query);
        clearInterval(typingInterval);
        const msg = formatDeepSearch(result);
        await sendOrSave(ctx, msg, 'deepsearch', query);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Deep search failed');
        await ctx.reply(`❌ Deep search failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('sources', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) {
        await ctx.reply('⚠️ Content Engine not enabled.');
        return;
      }
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /sources <topic>\nExample: /sources fitness trends 2026');
        return;
      }
      await ctx.replyWithChatAction('typing');
      try {
        const result = await getSources(query);
        const msg = formatSources(result);
        await sendOrSave(ctx, msg, 'sources', query, true);
      } catch (err: any) {
        logger.error({ err }, 'Sources fetch failed');
        await ctx.reply(`❌ Sources failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // /hotnews → alias for /discover --news
  bot.command('hotnews', async (ctx) => {
    logger.info('Deprecated /hotnews used — forwarding to /discover --news');
    enqueue(ctx.from!.id, async () => { await handleDiscoverCommand(ctx, 'news'); });
  });

  // ── Phase 2: Visual + Social ──

  // /trending → alias for /discover --platform
  bot.command('trending', async (ctx) => {
    logger.info('Deprecated /trending used — forwarding to /discover --platform');
    enqueue(ctx.from!.id, async () => { await handleDiscoverCommand(ctx, 'platform'); });
  });

  bot.command('reaction', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /reaction <topic>\nExample: /reaction Lula cortou verbas'); return; }

      // Check Reaction Radar signals first
      const { readSignals } = await import('./services/intelligence-bus');
      const radarSignals = readSignals('reaction-command', ['reaction_opportunity']);
      const topicLower = topic.toLowerCase();
      const matching = radarSignals.filter((s: any) => {
        const p = s.payload as any;
        const text = `${p.title || ''} ${p.topic || ''} ${p.description || ''}`.toLowerCase();
        return topicLower.split(/\s+/).some((w: string) => w.length > 3 && text.includes(w));
      });

      if (matching.length > 0) {
        let radarMsg = `🔍 <b>Reaction Radar found ${matching.length} match${matching.length > 1 ? 'es' : ''}:</b>\n\n`;
        for (const sig of matching.slice(0, 3)) {
          const p = sig.payload as any;
          radarMsg += `📺 <b>${escapeHtml(p.title || p.topic || '')}</b>\n`;
          if (p.scores) {
            const s = p.scores;
            radarMsg += `   🎯 Audience: ${s.audience_trigger}/10 · 🔥 Controversy: ${s.controversy}/10 · ⏰ Timely: ${s.timeliness}/10\n`;
            radarMsg += `   📹 Visual: ${s.visual_reactability}/10 · 🏷 Pillars: ${s.pillar_alignment}/10 · <b>Total: ${p.total_score || 'N/A'}/50</b>\n`;
          }
          if (p.reaction_angle) radarMsg += `   💡 Angle: ${escapeHtml(p.reaction_angle)}\n`;
          if (p.source_url) radarMsg += `   🔗 ${escapeHtml(p.source_url)}\n`;
          radarMsg += '\n';
        }
        radarMsg += `<i>Running fresh scan for more angles...</i>`;
        await ctx.reply(radarMsg, { parse_mode: 'HTML' });
      }

      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getReaction(topic);
        clearInterval(typingInterval);
        const msg = formatReaction(result);
        await sendOrSave(ctx, msg, 'reaction', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Reaction search failed');
        await ctx.reply(`❌ Reaction search failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Phase 3: Creative Intelligence ──

  bot.command('hooks', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /hooks <topic>\nExample: /hooks corrida 5k iniciante'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getHooks(topic);
        clearInterval(typingInterval);
        const msg = formatHooks(result);
        await sendOrSave(ctx, msg, 'hooks', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Hooks generation failed');
        await ctx.reply(`❌ Hooks failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // /genscript → alias for /script (deprecated, forwards silently)
  bot.command('genscript', async (ctx) => {
    logger.info('Deprecated /genscript used — forwarding to /script handler');
    enqueue(ctx.from!.id, async () => {
      await handleScriptCommand(ctx);
    });
  });

  bot.command('titles', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /titles <topic>\nExample: /titles como perder gordura sem cardio'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getTitles(topic);
        clearInterval(typingInterval);
        const msg = formatTitles(result);
        await sendOrSave(ctx, msg, 'titles', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Titles generation failed');
        await ctx.reply(`❌ Titles failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('genthumbnail', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const title = ctx.match?.trim();
      if (!title) { await ctx.reply('Usage: /genthumbnail <video title>\nExample: /genthumbnail PERDI 10KG EM 30 DIAS'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getThumbnail(title);
        clearInterval(typingInterval);
        const msg = formatThumbnail(result);
        await sendOrSave(ctx, msg, 'genthumbnail', title);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Thumbnail generation failed');
        await ctx.reply(`❌ Thumbnail failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('gencaption', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const topic = ctx.match?.trim();
      if (!topic) { await ctx.reply('Usage: /gencaption <topic>\nExample: /gencaption treino de peito e tríceps'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getCaption(topic);
        clearInterval(typingInterval);
        const msg = formatCaption(result);
        await sendOrSave(ctx, msg, 'gencaption', topic);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Caption generation failed');
        await ctx.reply(`❌ Caption failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Phase 4: Strategic Intelligence ──

  bot.command('competitor', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const channel = ctx.match?.trim();
      if (!channel) { await ctx.reply('Usage: /competitor <channel URL or handle>\nExample: /competitor @RenatoCariani'); return; }
      await ctx.reply('🔎 Analyzing competitor… this may take 30-60s.', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getCompetitor(channel);
        clearInterval(typingInterval);
        const msg = formatCompetitor(result);
        await sendOrSave(ctx, msg, 'competitor', channel, true); // always save
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Competitor analysis failed');
        await ctx.reply(`❌ Competitor analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('gaps', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const niche = ctx.match?.trim() || 'fitness';
      await ctx.reply(`🔍 Finding content gaps for <b>${escapeHtml(niche)}</b>…`, { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getGaps(niche);
        clearInterval(typingInterval);
        const msg = formatGaps(result);
        await sendOrSave(ctx, msg, 'gaps', niche);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Gap analysis failed');
        await ctx.reply(`❌ Gap analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('seo', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const input = ctx.match?.trim() || '';

      // /seo (no args) → dashboard of tracked keywords
      if (!input) {
        const db = getDb();
        const keywords = db.prepare(`
          SELECT keyword, last_rank, previous_rank, trend, last_checked
          FROM seo_keywords ORDER BY last_rank ASC NULLS LAST, keyword ASC
        `).all() as any[];

        if (keywords.length === 0) {
          await ctx.reply(
            '📊 <b>SEO Dashboard</b>\n\nNo keywords tracked yet.\n\n' +
            '<code>/seo track [keyword]</code> — Track a keyword\n' +
            '<code>/seo [topic]</code> — Research keywords for a topic',
            { parse_mode: 'HTML' },
          );
          return;
        }

        let msg = `📊 <b>SEO Dashboard</b> (${keywords.length} keywords)\n\n`;
        for (const kw of keywords) {
          const arrow = kw.trend === 'up' ? '📈' : kw.trend === 'down' ? '📉' : '➡️';
          const rank = kw.last_rank ? `#${kw.last_rank}` : 'N/R';
          const delta = (kw.previous_rank && kw.last_rank)
            ? ` (was #${kw.previous_rank})`
            : '';
          msg += `${arrow} <b>${escapeHtml(kw.keyword)}</b> — ${rank}${delta}\n`;
        }
        msg += `\n<i>Updated: ${keywords[0]?.last_checked || 'never'}</i>`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
        return;
      }

      // /seo track [keyword] → add keyword to tracking
      if (input.startsWith('track ')) {
        const keyword = input.replace('track ', '').trim();
        if (!keyword) { await ctx.reply('Usage: <code>/seo track [keyword]</code>', { parse_mode: 'HTML' }); return; }

        const db = getDb();
        db.prepare(`
          INSERT OR IGNORE INTO seo_keywords (keyword, pillar, last_checked)
          VALUES (?, 'manual', datetime('now'))
        `).run(keyword);

        // Immediately check ranking
        const { checkKeywordRanking } = await import('./services/youtube-analytics');
        const channelId = config.youtube?.channelId;
        if (channelId) {
          const result = await checkKeywordRanking(keyword, channelId);
          if (result.position) {
            db.prepare('UPDATE seo_keywords SET last_rank = ? WHERE keyword = ?')
              .run(result.position, keyword);
            await ctx.reply(
              `✅ Now tracking: <b>${escapeHtml(keyword)}</b>\nCurrent rank: <b>#${result.position}</b>` +
              (result.topCompetitor ? `\nTop competitor: ${escapeHtml(result.topCompetitor)}` : ''),
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.reply(`✅ Now tracking: <b>${escapeHtml(keyword)}</b>\nNo ranking found yet (not in top 20).`, { parse_mode: 'HTML' });
          }
        } else {
          await ctx.reply(`✅ Now tracking: <b>${escapeHtml(keyword)}</b>\n⚠️ Set YOUTUBE_CHANNEL_ID to enable rank checking.`, { parse_mode: 'HTML' });
        }
        return;
      }

      // /seo [topic] → keyword research via content engine
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getSeo(input);
        clearInterval(typingInterval);
        const msg = formatSeo(result);
        await sendOrSave(ctx, msg, 'seo', input);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'SEO analysis failed');
        await ctx.reply(`❌ SEO failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Phase 5: Learning System ──

  bot.command('feedback', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const args = ctx.match?.trim();
      if (!args) {
        await ctx.reply(
          '📊 <b>Usage:</b>\n' +
          '<code>/feedback &lt;url&gt;</code> — Auto-fetch from YouTube API\n' +
          '<code>/feedback &lt;url&gt; &lt;views&gt; &lt;ret%&gt; [likes] [comments] [subs]</code> — Manual\n\n' +
          'Example: <code>/feedback https://youtu.be/abc</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      const parts = args.split(/\s+/);
      const videoUrl = parts[0];

      // Auto-fetch mode: URL only (no manual numbers)
      if (parts.length === 1 && (videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be'))) {
        await ctx.reply('📊 Fetching stats from YouTube API...', { parse_mode: 'HTML' });
        const { extractVideoId, getVideoStats } = await import('./services/youtube-analytics');
        const videoId = extractVideoId(videoUrl);
        if (!videoId) { await ctx.reply('❌ Could not extract video ID from URL.'); return; }

        const stats = await getVideoStats(videoId);
        if (!stats) { await ctx.reply('❌ Could not fetch stats. Video may be private or API key issue.'); return; }

        await ctx.replyWithChatAction('typing');
        try {
          const result = await logFeedback({
            video_url: videoUrl,
            views: stats.views,
            retention_pct: stats.retentionPct || 0,
            likes: stats.likes,
            comments: stats.comments,
            subs_gained: stats.subscribersGained || 0,
          });
          const msg = formatFeedback(result);
          const autoNote = `\n\n<i>📡 Auto-fetched from YouTube API: ${stats.views.toLocaleString()} views, ${stats.likes.toLocaleString()} likes, ${stats.comments.toLocaleString()} comments</i>`;
          await sendOrSave(ctx, msg + autoNote, 'feedback', videoUrl);
        } catch (err: any) {
          logger.error({ err }, 'Feedback logging failed');
          await ctx.reply(`❌ Feedback failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
        return;
      }

      // Manual mode: URL + numbers
      if (parts.length < 3) {
        await ctx.reply('❌ Need at least: URL, views, retention%. Or just URL for auto-fetch.');
        return;
      }
      const [, viewsStr, retStr, likesStr, commentsStr, subsStr] = parts;
      const views = parseInt(viewsStr, 10);
      const retention = parseFloat(retStr);
      if (isNaN(views) || isNaN(retention)) {
        await ctx.reply('❌ Views and retention must be numbers.');
        return;
      }
      await ctx.replyWithChatAction('typing');
      try {
        const result = await logFeedback({
          video_url: videoUrl,
          views,
          retention_pct: retention,
          likes: likesStr ? parseInt(likesStr, 10) || 0 : 0,
          comments: commentsStr ? parseInt(commentsStr, 10) || 0 : 0,
          subs_gained: subsStr ? parseInt(subsStr, 10) || 0 : 0,
        });
        const msg = formatFeedback(result);
        await sendOrSave(ctx, msg, 'feedback', videoUrl);
      } catch (err: any) {
        logger.error({ err }, 'Feedback logging failed');
        await ctx.reply(`❌ Feedback failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('report', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const period = ctx.match?.trim() || 'week';
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getReport(period);
        clearInterval(typingInterval);
        const msg = formatReport(result);
        await sendOrSave(ctx, msg, 'report', period, true); // always save
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Report generation failed');
        await ctx.reply(`❌ Report failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Content Learning Commands ──────────────────────────────

  bot.command('learnfrom', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url || !url.includes('youtube.com')) {
        await ctx.reply(
          '📚 <b>Usage:</b> <code>/learnfrom https://www.youtube.com/@ChannelHandle</code>\n\n' +
          'Analyzes a YouTube channel and extracts content creation patterns (hooks, titles, storytelling, etc.) ' +
          'to improve your content AI.',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.replyWithChatAction('typing');
      await ctx.reply(
        '🔍 Analyzing channel… this takes 30-60s (fetching videos + Claude analysis).',
        { parse_mode: 'HTML' },
      );
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);
      try {
        const result = await addAndAnalyzeChannel(url, 'bot');
        clearInterval(typingInterval);

        if (result.analysis.success) {
          let msg = `📚 <b>Channel Learned!</b>\n\n`;
          msg += `📺 <b>${escapeHtml(result.channel.channel_name || url)}</b>\n`;
          msg += `🎬 ${result.analysis.videosAnalyzed} videos analyzed\n`;
          msg += `🧠 ${result.analysis.patternsFound} patterns extracted\n`;
          if (result.analysis.summary) {
            msg += `\n📝 <i>${escapeHtml(result.analysis.summary.substring(0, 300))}${result.analysis.summary.length > 300 ? '...' : ''}</i>\n`;
          }
          msg += `\n✅ Knowledge has been synthesized and will be used in future content suggestions.`;
          await ctx.reply(msg, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(
            `⚠️ Failed to analyze channel: ${escapeHtml(result.analysis.error || 'Unknown error')}\n\n` +
            `Make sure the URL is correct and YOUTUBE_API_KEY is set.`,
            { parse_mode: 'HTML' },
          );
        }
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Channel learning failed');
        await ctx.reply(`❌ Analysis failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  bot.command('references', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const channels = getAllChannels();
      if (channels.length === 0) {
        await ctx.reply(
          '📚 No reference channels configured.\n\nUse <code>/learnfrom https://www.youtube.com/@Channel</code> to add one.',
          { parse_mode: 'HTML' },
        );
        return;
      }

      let msg = `📚 <b>Content Reference Channels</b> (${channels.length})\n\n`;
      for (const ch of channels) {
        const statusEmoji = ch.status === 'active' ? '✅' :
                           ch.status === 'analyzing' ? '🔄' :
                           ch.status === 'pending' ? '⏳' : '❌';
        msg += `${statusEmoji} <b>${escapeHtml(ch.channel_name || ch.channel_url)}</b>\n`;
        msg += `   ${escapeHtml(ch.channel_url)}\n`;
        if (ch.video_count_analyzed > 0) {
          msg += `   📊 ${ch.video_count_analyzed} videos · Last: ${ch.last_analyzed_at?.split('T')[0] || 'never'}\n`;
        }
        if (ch.error_message) {
          msg += `   ⚠️ <i>${escapeHtml(ch.error_message.substring(0, 80))}</i>\n`;
        }
        msg += '\n';
      }

      const knowledge = buildKnowledgePromptBlock();
      if (knowledge) {
        msg += `\n🧠 <b>Active knowledge:</b> ${knowledge.split('\n').filter(l => l.trim()).length} lines injected into content AI`;
      } else {
        msg += `\n⏳ <i>No knowledge synthesized yet. Add channels and wait for analysis.</i>`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });
  });

  bot.command('relearn', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await ctx.reply('🔄 Re-analyzing all reference channels… this may take a few minutes.', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);
      try {
        const result = await processAllChannels(true);
        clearInterval(typingInterval);
        let msg = `🔄 <b>Re-learning Complete</b>\n\n`;
        msg += `✅ Analyzed: ${result.analyzed} channel(s)\n`;
        if (result.failed > 0) msg += `❌ Failed: ${result.failed}\n`;
        msg += `🧠 Knowledge ${result.synthesized ? 'updated' : 'unchanged'}`;
        await ctx.reply(msg, { parse_mode: 'HTML' });
      } catch (err: any) {
        clearInterval(typingInterval);
        await ctx.reply(`❌ Re-learning failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /contenttopic — Manual trigger for trending topics ────────────
  bot.command('contenttopic', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const arg = ctx.match?.trim().toLowerCase();
      if (arg === 'tuesday' || arg === 'reels') {
        await sendTopicCandidates(bot, ctx.from!.id, 'reel', 'tuesday_reels');
      } else if (arg === 'thursday' || arg === 'youtube') {
        await sendTopicCandidates(bot, ctx.from!.id, 'youtube', 'thursday_youtube');
      } else {
        await ctx.reply(
          '📋 <b>Usage:</b>\n\n' +
          '<code>/contenttopic tuesday</code> — 5 trending Reel topics\n' +
          '<code>/contenttopic thursday</code> — 5 trending YouTube topics',
          { parse_mode: 'HTML' },
        );
      }
    });
  });

  // ─── /contentretro — Manual trigger for weekly content package ─────
  bot.command('contentretro', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await sendWeeklyPackage(bot, ctx.from!.id);
    });
  });

  // ─── Book Commands ────────────────────────────────────────────────
  bot.command('addbook', async (ctx) => { enqueue(ctx.from!.id, () => handleAddBook(ctx)); });
  bot.command('booknote', async (ctx) => { enqueue(ctx.from!.id, () => handleBookNote(ctx)); });
  bot.command('books', async (ctx) => { enqueue(ctx.from!.id, () => handleListBooks(ctx)); });
  bot.command('bookidea', async (ctx) => { enqueue(ctx.from!.id, () => handleBookIdea(ctx)); });

  // ─── SEO Commands ──────────────────────────────────────────────────
  bot.command('seokeyword', async (ctx) => { enqueue(ctx.from!.id, () => handleAddSEOKeyword(ctx)); });
  bot.command('seorank', async (ctx) => { enqueue(ctx.from!.id, () => handleSEORank(ctx)); });

  // ─── Pipeline Commands ─────────────────────────────────────────────
  bot.command('pipeline', async (ctx) => { enqueue(ctx.from!.id, () => handlePipelineStatus(ctx)); });
  bot.command('filmed', async (ctx) => { enqueue(ctx.from!.id, () => handleFilmedStage(ctx)); });
  bot.command('editing', async (ctx) => { enqueue(ctx.from!.id, () => handleEditingStage(ctx)); });
  bot.command('published', async (ctx) => { enqueue(ctx.from!.id, () => handlePublishedStage(ctx)); });

  // ─── Autoresearch Commands ──────────────────────────────────────────
  bot.command('autoresearch', async (ctx) => { enqueue(ctx.from!.id, () => handleAutoresearch(ctx)); });
  bot.command('evalscore', async (ctx) => { enqueue(ctx.from!.id, () => handleEvalScore(ctx)); });

  // ─── /transcribe — Quick transcript fetch → save as DOCX ───────────
  bot.command('transcribe', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url) {
        await ctx.reply('Usage: /transcribe <youtube-url>\n\nFetches the transcript and sends it as a Word file.', { parse_mode: 'HTML' });
        return;
      }

      const statusMsg = await ctx.reply('⏳ Fetching transcript...');

      try {
        const transcript = await getTranscript(url);
        if (!transcript) {
          await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
            '❌ No transcript available for this video. It may not have captions enabled.');
          return;
        }

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '📄 Generating Word document...');

        const filePath = await saveTranscriptAsDocx(transcript);

        // Send summary + file
        let caption = `📝 <b>${escapeHtml(transcript.title)}</b>\n`;
        caption += `📺 ${escapeHtml(transcript.channelName)} · ${transcript.language}${transcript.isAutoGenerated ? ' (auto)' : ''}\n`;
        caption += `⏱ ${Math.floor(transcript.durationSeconds / 60)}:${(transcript.durationSeconds % 60).toString().padStart(2, '0')} · ${transcript.segments.length} segments · ${Math.round(transcript.fullText.length / 1000)}K chars`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        // Clean up status message
        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err, url }, '/transcribe failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `❌ Failed to fetch transcript: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /studyvideo — Deep video analysis → save as DOCX ───────────────
  bot.command('studyvideo', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const url = ctx.match?.trim();
      if (!url) {
        await ctx.reply(
          'Usage: /studyvideo <youtube-url>\n\n' +
          'Deep-analyzes a video and sends the result as a Word file:\n' +
          '• 🎣 Hook breakdown (first 30s)\n' +
          '• 🏗️ Content structure with timestamps\n' +
          '• ⭐ Key moments (quotable/viral)\n' +
          '• 💡 Content ideas (PT-BR, your niches)\n' +
          '• 🎬 Reel/Short cut suggestions',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const statusMsg = await ctx.reply('🔬 Studying video... (fetching transcript + running analysis, ~30s)');

      try {
        const result = await studyVideo(url);

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '📄 Generating Word document...');

        const filePath = await saveStudyAsDocx(result);

        let caption = `🔬 <b>Video Study: ${escapeHtml(result.title)}</b>\n`;
        caption += `📺 ${escapeHtml(result.channelName)}\n`;
        caption += `🎣 Hook · 🏗️ Structure · ⭐ Key Moments · 💡 Ideas · 🎬 Reel Cuts`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err, url }, '/studyvideo failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `❌ Video study failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /script — Full video script (research + intelligence bus) ──────
  bot.command('script', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await handleScriptCommand(ctx);
    });
  });

  // ─── /reel — Generate a Reel/Short script with SFX + editing cues ──
  bot.command('reel', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const topic = ctx.match?.toString().trim();
      if (!topic) {
        await ctx.reply(
          '🎬 <b>Usage:</b> <code>/reel &lt;topic&gt;</code>\n\n' +
          'Generates a 30-60s Reel/Short script with [SFX:] markers, [EDIT:] cues, and timing marks.\n\n' +
          'Examples:\n' +
          '  <code>/reel 3 erros no jejum intermitente</code>\n' +
          '  <code>/reel por que acordar às 5h é golpe</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.reply('🎬 Generating Reel script… ~30s (research + writing).', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getScript(topic, 'general', 1, 'Reel');
        clearInterval(typingInterval);
        const msg = formatScript(result);
        await sendOrSave(ctx, msg, 'reel', topic, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Reel script generation failed');
        await ctx.reply(`❌ Reel script failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /buildscript — Generate a Build Log script for tech/AI projects ──
  bot.command('buildscript', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isContentEngineConfigured()) { await ctx.reply('⚠️ Content Engine not enabled.'); return; }
      const project = ctx.match?.toString().trim();
      if (!project) {
        await ctx.reply(
          '🛠️ <b>Usage:</b> <code>/buildscript &lt;project&gt;</code>\n\n' +
          'Generates a Build Log script (Hook → Problem → Build → Result) with screen recording cues.\n\n' +
          'Examples:\n' +
          '  <code>/buildscript telegram bot que agenda treinos</code>\n' +
          '  <code>/buildscript AI agent que analisa concorrentes</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }
      await ctx.reply('🛠️ Generating Build Log script… ~30-60s (research + writing).', { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const result = await getScript(project, 'general', 2, 'Build');
        clearInterval(typingInterval);
        const msg = formatScript(result);
        await sendOrSave(ctx, msg, 'buildscript', project, true);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Build script generation failed');
        await ctx.reply(`❌ Build script failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /calendar — Generate a content calendar for the next week/month ──
  bot.command('calendar', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const period = ctx.match?.toString().trim() || 'week';
      const days = period.toLowerCase().startsWith('month') ? 30 : 7;
      await ctx.reply(`📅 Generating ${days}-day content calendar…`, { parse_mode: 'HTML' });
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const calendarPrompt =
          `Generate a content calendar for the next ${days} days for a Brazilian creator named Felipe "The Operator" Dominguez.\n\n` +
          `PILLARS (rotate evenly across all days):\n` +
          `🤖 AI/Tech — builds, automations, AI tools\n` +
          `🗣️ Commentary — politics, culture, hot takes\n` +
          `💪 Training — triathlon, carnivore diet, fitness\n` +
          `🎮 Gaming — Helldivers, game reviews\n` +
          `🃏 Wild Card — memes, personal stories, collabs\n\n` +
          `For each day provide EXACTLY this format (one line per day):\n` +
          `DAY | PILLAR_EMOJI | TOPIC | FORMAT | TIME_SENSITIVITY\n\n` +
          `FORMAT must be one of: Reel, YouTube, Both\n` +
          `TIME_SENSITIVITY must be: 🔥 (urgent/trending) or ⏳ (evergreen)\n\n` +
          `Rules:\n` +
          `- Each pillar appears at least once per week\n` +
          `- Mix Reels and YouTube formats (not all the same)\n` +
          `- Topics should be specific and actionable, not generic\n` +
          `- Start from tomorrow's date\n` +
          `- Output as HTML table with <b> tags for headers\n` +
          `- Language: PT-BR for topics`;

        const contentResponse = await handleContent(calendarPrompt, 4096);
        clearInterval(typingInterval);
        const msg = `📅 <b>CONTENT CALENDAR — Next ${days} days</b>\n\n${contentResponse.text}`;
        await sendOrSave(ctx, msg, 'calendar', `${days}-day-plan`);
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Calendar generation failed');
        await ctx.reply(`❌ Calendar failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /brandcheck — Analyze recent content for pillar balance ──────
  bot.command('brandcheck', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
      try {
        const db = getDb();
        // Query last 30 days of content topics by niche
        const rows = db.prepare(`
          SELECT niche, COUNT(*) as cnt, sentiment,
                 GROUP_CONCAT(topic, ' | ') as topics
          FROM content_topic_feedback
          WHERE created_at > datetime('now', '-30 days')
          GROUP BY niche, sentiment
          ORDER BY cnt DESC
        `).all() as Array<{ niche: string; cnt: number; sentiment: string; topics: string }>;

        if (rows.length === 0) {
          clearInterval(typingInterval);
          await ctx.reply(
            '📊 <b>Brand Check</b>\n\nNo content topics found in the last 30 days.\n' +
            'Use <code>/contenttopic</code> to generate topic candidates first.',
            { parse_mode: 'HTML' },
          );
          return;
        }

        // Build a summary for Claude to analyze
        let dataSummary = 'Content topics from the last 30 days by niche and sentiment:\n\n';
        for (const row of rows) {
          dataSummary += `- ${row.niche || 'unknown'} (${row.sentiment}): ${row.cnt} topics\n`;
          dataSummary += `  Examples: ${row.topics.split(' | ').slice(0, 3).join(', ')}\n`;
        }

        const analysisPrompt =
          `You are a content strategist analyzing pillar balance for Felipe "The Operator" Dominguez.\n\n` +
          `His 5 pillars are:\n` +
          `🤖 AI/Tech\n🗣️ Commentary/Politics\n💪 Training/Fitness\n🎮 Gaming\n🃏 Wild Card\n\n` +
          `Here is the actual data from the last 30 days:\n${dataSummary}\n\n` +
          `Provide:\n` +
          `1. A brief analysis of which pillars are OVER-represented and which are UNDER-represented\n` +
          `2. A "balance score" from 1-10 (10 = perfectly balanced)\n` +
          `3. Exactly 3 specific topic suggestions for each underrepresented pillar\n\n` +
          `Format as clean HTML with <b> tags for headers. Be direct and actionable. Language: PT-BR.`;

        const contentResponse = await handleContent(analysisPrompt, 4096);
        clearInterval(typingInterval);
        const msg = `📊 <b>BRAND CHECK — Pillar Balance (30 days)</b>\n\n${contentResponse.text}`;
        await sendOrSave(ctx, msg, 'brandcheck', 'pillar-analysis');
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Brand check failed');
        await ctx.reply(`❌ Brand check failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ─── /repurpose — Upload a script .docx → multi-format content ─────
  bot.command('repurpose', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      // Check if replying to a document message
      const replyMsg = ctx.message?.reply_to_message;
      const doc = replyMsg?.document || ctx.message?.document;
      const textTopic = ctx.match?.trim();

      // Text-based: /repurpose <topic> (no document)
      if (!doc && textTopic) {
        await ctx.replyWithChatAction('typing');
        const typingInterval = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4000);
        try {
          const repurposePrompt = `Repurpose the following content topic into these formats:\n\n` +
            `1. **3 REELS/SHORTS** (30-60s each) — complete scripts with hook, body, CTA. Each one takes a different angle.\n` +
            `2. **1 STORIES SEQUENCE** (5-7 stories) — text + poll/question stickers suggestions.\n\n` +
            `Everything in PT-BR. Make each format self-contained and optimized for its platform.\n\n` +
            `Topic: ${textTopic}`;
          const contentResponse = await handleContent(repurposePrompt, 8192);
          clearInterval(typingInterval);
          const filePath = await saveScriptAsDocx(`Repurpose — ${textTopic}`, contentResponse.text);
          await ctx.replyWithDocument(new InputFile(filePath), {
            caption: `♻️ <b>Repurposed: ${escapeHtml(textTopic)}</b>\n🎬 3 Reels · 📖 Stories`,
            parse_mode: 'HTML',
          });
        } catch (err: any) {
          clearInterval(typingInterval);
          logger.error({ err }, '/repurpose (text) failed');
          await ctx.reply(`❌ Repurpose failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
        return;
      }

      if (!doc) {
        await ctx.reply(
          '♻️ <b>Usage:</b>\n\n' +
          '▸ Reply to a .docx script file with /repurpose\n' +
          '▸ Or: <code>/repurpose topic here</code>\n\n' +
          'Generates from your script:\n' +
          '  ▸ 3 Reels/Shorts scripts (30-60s)\n' +
          '  ▸ 1 Stories sequence',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const fileName = doc.file_name || '';
      if (!fileName.endsWith('.docx')) {
        await ctx.reply('❌ Please send a .docx file. Other formats are not supported.');
        return;
      }

      const statusMsg = await ctx.reply('📥 Reading script...');

      try {
        // Download the file from Telegram
        const file = await ctx.api.getFile(doc.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());

        // Extract text from .docx using mammoth
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

        // Send to content domain with high token limit
        const repurposePrompt = `I have the following YouTube video script. Repurpose it into these formats:\n\n` +
          `1. **3 REELS/SHORTS** (30-60s each) — complete scripts with hook, body, CTA. Each one takes a different angle from the original.\n` +
          `2. **1 STORIES SEQUENCE** (5-7 stories) — text + poll/question stickers suggestions.\n\n` +
          `Everything in PT-BR. Make each format self-contained and optimized for its platform.\n\n` +
          `━━━ ORIGINAL SCRIPT ━━━\n\n${scriptText}`;

        const contentResponse = await handleContent(repurposePrompt, 8192);

        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          '📄 Saving as Word document...');

        // Extract topic from filename
        const topic = fileName
          .replace(/^script_/, '').replace(/\.docx$/, '').replace(/_/g, ' ').trim()
          || 'repurposed content';

        const filePath = await saveScriptAsDocx(`Repurpose — ${topic}`, contentResponse.text);

        const caption = `♻️ <b>Repurposed: ${escapeHtml(topic)}</b>\n` +
          `🎬 3 Reels · 📖 Stories`;

        await ctx.replyWithDocument(new InputFile(filePath), {
          caption,
          parse_mode: 'HTML',
        });

        await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      } catch (err: any) {
        logger.error({ err }, '/repurpose failed');
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id,
          `❌ Repurpose failed: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    });
  });

  // ── Invoice Collection Commands ──

  // /invoices [YYYY-MM] — Manual trigger for monthly invoice collection
  bot.command('invoices', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isInvoiceFilingConfigured()) {
        await ctx.reply('⚠️ Arquivamento de faturas não configurado.');
        return;
      }

      const arg = ctx.match?.trim();
      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('⚠️ Mês inválido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        // Default: previous month
        const prev = now().minus({ months: 1 });
        year = prev.year;
        month = prev.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;
      await ctx.reply(`📊 A recolher faturas de <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        const result = await collectMonthlyInvoices(year, month);
        const notification = formatCollectionNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]+>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual invoice collection failed');
        await ctx.reply('⚠️ Recolha de faturas falhou. Verificar logs.');
      }
    });
  });

  // /addfatura <name> | <sender> — Register a new invoice vendor
  bot.command('addfatura', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const arg = ctx.match?.trim();
      if (!arg || !arg.includes('|')) {
        await ctx.reply(
          '📝 <b>Uso:</b> <code>/addfatura Nome | sender@domain.pt</code>\n\n' +
          'Exemplo: <code>/addfatura MEO | meo.pt</code>\n' +
          'Exemplo: <code>/addfatura Vodafone | vodafone.pt</code>',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const [namePart, senderPart] = arg.split('|').map((s) => s.trim());
      if (!namePart || !senderPart) {
        await ctx.reply('⚠️ Nome e sender são obrigatórios. Exemplo: <code>/addfatura MEO | meo.pt</code>', { parse_mode: 'HTML' });
        return;
      }

      try {
        const vendor = addVendor(namePart, senderPart);
        await ctx.reply(
          `✅ <b>${escapeHtml(vendor.name)}</b> adicionado.\n` +
          `📧 Emails de <code>${escapeHtml(vendor.sender_pattern)}</code> serão recolhidos no próximo mês.`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error({ err, name: namePart, sender: senderPart }, 'Failed to add vendor');
        await ctx.reply('⚠️ Erro ao adicionar fornecedor.');
      }
    });
  });

  // /rmfatura <name> — Remove/disable a custom vendor
  bot.command('rmfatura', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('📝 <b>Uso:</b> <code>/rmfatura Nome</code>', { parse_mode: 'HTML' });
        return;
      }

      const removed = removeVendorByName(name);
      if (removed) {
        await ctx.reply(`🗑 <b>${escapeHtml(name)}</b> desativado. Não será recolhido nos próximos meses.`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`⚠️ Fornecedor "${escapeHtml(name)}" não encontrado. Usa /faturas para ver a lista.`, { parse_mode: 'HTML' });
      }
    });
  });

  // /faturas — List all configured vendors (builtin + custom)
  bot.command('faturas', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const builtins = getBuiltinVendors();
      const customs = getCustomVendors();

      let msg = `📋 <b>Fornecedores de Faturas</b>\n\n`;
      msg += `<b>📌 Fixos:</b>\n`;
      for (const v of builtins) {
        msg += `• ${escapeHtml(v.name)} — <code>${v.senderPatterns.join(', ')}</code>\n`;
      }

      if (customs.length > 0) {
        msg += `\n<b>👤 Personalizados:</b>\n`;
        for (const v of customs) {
          msg += `• ${escapeHtml(v.name)} — <code>${escapeHtml(v.sender_pattern)}</code>\n`;
        }
        msg += `\n<i>Remover com:</i> <code>/rmfatura Nome</code>`;
      } else {
        msg += `\n<i>Nenhum fornecedor personalizado. Adicionar com:</i>\n<code>/addfatura Nome | sender@domain.pt</code>`;
      }

      await ctx.reply(msg, { parse_mode: 'HTML' });
    });
  });

  // /amazon [YYYY-MM] [--force] — Manual trigger for Amazon.es invoice collection (with 2FA support)
  // --force: clears previous filing records for the target month and re-downloads all invoices
  bot.command('amazon', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isAmazonConfigured()) {
        await ctx.reply(
          '⚠️ Amazon não configurado.\n' +
          'Defina <code>AMAZON_EMAIL</code>, <code>AMAZON_PASSWORD</code> e <code>AMAZON_COLLECTION_ENABLED=true</code> no .env',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const rawArg = ctx.match?.trim() || '';
      const force = /--force/i.test(rawArg);
      const arg = rawArg.replace(/--force/gi, '').trim();

      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('⚠️ Mês inválido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        // Default: current month (Amazon invoices are available immediately)
        const current = now();
        year = current.year;
        month = current.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;

      // If --force, delete stale filing records for this month first
      if (force) {
        const deleted = deleteAmazonFilings(year, month);
        if (deleted > 0) {
          await ctx.reply(
            `🗑 <b>--force</b>: ${deleted} registo(s) anterior(es) removido(s) para ${monthLabel}.`,
            { parse_mode: 'HTML' },
          );
        }
      }

      await ctx.reply(`🛒 A recolher faturas Amazon.es para <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        // Interactive Telegram callbacks for 2FA
        const chatId = ctx.chat.id;
        const sendMessage = async (text: string) => {
          await ctx.reply(text, { parse_mode: 'HTML' });
        };
        const sendScreenshot = async (buffer: Buffer) => {
          await ctx.replyWithPhoto(new InputFile(buffer, 'amazon-2fa.jpg'));
        };
        const waitForReply = (timeoutMs: number) => registerAmazonReplyWaiter(chatId, timeoutMs);

        const result = await collectAmazonInvoices(year, month, sendMessage, sendScreenshot, waitForReply);
        const notification = formatAmazonNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual Amazon invoice collection failed');
        await ctx.reply('⚠️ Recolha Amazon falhou. Verificar logs.');
      }
    });
  });

  // /uber [YYYY-MM] [--force] — Manual Uber invoice collection (rides + eats, with 2FA support)
  bot.command('uber', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isUberConfigured()) {
        await ctx.reply(
          '⚠️ Uber não configurado.\n' +
          'Defina <code>UBER_EMAIL</code>, <code>UBER_PASSWORD</code> e <code>UBER_COLLECTION_ENABLED=true</code> no .env',
          { parse_mode: 'HTML' },
        );
        return;
      }

      const rawArg = ctx.match?.trim() || '';
      const force = /--force/i.test(rawArg);
      const arg = rawArg.replace(/--force/gi, '').trim();

      let year: number, month: number;

      if (arg && /^\d{4}-\d{2}$/.test(arg)) {
        const [y, m] = arg.split('-').map(Number);
        if (m < 1 || m > 12) {
          await ctx.reply('⚠️ Mês inválido. Use formato YYYY-MM (ex: 2026-02).');
          return;
        }
        year = y;
        month = m;
      } else {
        const current = now();
        year = current.year;
        month = current.month;
      }

      const monthLabel = `${PT_MONTHS[month]}-${year}`;

      if (force) {
        const deleted = deleteUberFilings(year, month);
        if (deleted > 0) {
          await ctx.reply(
            `🗑 <b>--force</b>: ${deleted} registo(s) anterior(es) removido(s) para ${monthLabel}.`,
            { parse_mode: 'HTML' },
          );
        }
      }

      await ctx.reply(`🚗 A recolher faturas Uber para <b>${monthLabel}</b>...`, { parse_mode: 'HTML' });

      try {
        const chatId = ctx.chat.id;
        const sendMessage = async (text: string) => {
          await ctx.reply(text, { parse_mode: 'HTML' });
        };
        const sendScreenshot = async (buffer: Buffer) => {
          await ctx.replyWithPhoto(new InputFile(buffer, 'uber-2fa.jpg'));
        };
        const waitForReply = (timeoutMs: number) => registerUberReplyWaiter(chatId, timeoutMs);

        const result = await collectUberInvoices(year, month, sendMessage, sendScreenshot, waitForReply);
        const notification = formatUberNotification(result);

        for (const chunk of splitMessage(notification)) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
      } catch (err) {
        logger.error({ err }, 'Manual Uber invoice collection failed');
        await ctx.reply('⚠️ Recolha Uber falhou. Verificar logs.');
      }
    });
  });

  // ── Garmin MFA Code Submission ──
  bot.command('garminmfa', async (ctx) => {
    const code = ctx.message?.text?.replace(/^\/garminmfa\s*/, '').trim();
    if (!code || !/^\d{4,8}$/.test(code)) {
      await ctx.reply('⚠️ Usage: <code>/garminmfa 123456</code>\n\nProvide the numeric code from your email.', { parse_mode: 'HTML' });
      return;
    }
    if (!isMfaPending()) {
      await ctx.reply('ℹ️ No MFA challenge pending. Garmin may not need a code right now.');
      return;
    }
    const accepted = submitMfaCode(code);
    if (accepted) {
      await ctx.reply('✅ MFA code submitted — Garmin login completing…');
    } else {
      await ctx.reply('⚠️ MFA code was not accepted — the challenge may have expired.');
    }
  });

  // ── Garmin Daily Coach ──
  bot.command('coach', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      if (!isGarminConfigured()) {
        await ctx.reply('⚠️ Garmin not configured. Set GARMIN_EMAIL and GARMIN_PASSWORD.');
        return;
      }

      await ctx.replyWithChatAction('typing');
      await ctx.reply('🏋️ Running coach analysis… collecting Garmin data + Claude analysis (~30s).', { parse_mode: 'HTML' });

      // Keep typing indicator alive during the long-running analysis
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);

      try {
        const result = await generateCoachBriefing();
        clearInterval(typingInterval);

        // Store recommendations so triathlon domain can reference them in follow-up chat
        if (result.recommendations.length > 0) {
          setLastCoachState(ctx.from!.id, result.recommendations, result.message.substring(0, 500));
        }

        // Set conversation continuity to triathlon so follow-up replies stay in context
        if (ctx.from?.id) {
          lastActiveDomain.set(ctx.from.id, { domain: 'triathlon', timestamp: Date.now() });
        }

        // Save to triathlon conversation history so follow-ups have context
        addToConversation('triathlon', 'assistant', result.message);

        // Send the human-readable briefing
        const chunks = splitMessage(result.message);
        for (const chunk of chunks) {
          try {
            await ctx.reply(chunk, { parse_mode: 'HTML' });
          } catch (err) {
            // If HTML parsing fails, send without formatting
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }

        // Send interactive recommendation buttons (if any non-KEEP recommendations exist)
        const actionableRecs = result.recommendations.filter((r) => r.action !== 'KEEP');
        if (actionableRecs.length > 0) {
          const keyboard = new InlineKeyboard();
          const recRefs: string[] = [];
          for (const rec of actionableRecs) {
            const ref = storeCallback({ recommendation: rec });
            recRefs.push(ref);
            const emoji = rec.action === 'MODIFY' ? '⚠️' : rec.action === 'SWAP' ? '🔄' : '❌';
            const label = `${emoji} ${rec.summary}`.substring(0, 60);
            keyboard.text(label, `coach:apply:${ref}`).row();
          }
          // Add "Apply all" if more than one
          if (actionableRecs.length > 1) {
            const allRef = storeCallback({ recommendations: actionableRecs });
            keyboard.text('✅ Aplicar todas as alterações', `coach:all:${allRef}`).row();
          }
          // Add dismiss button
          keyboard.text('👍 Manter tudo como está', `coach:dismiss`);

          await ctx.reply(
            '🏋️ <b>Ações do Coach:</b>\n\nQueres aplicar alguma destas alterações ao calendário de amanhã?',
            { parse_mode: 'HTML', reply_markup: keyboard },
          );
        }
      } catch (err: any) {
        clearInterval(typingInterval);
        logger.error({ err }, 'Coach briefing failed (manual)');
        await ctx.reply(`⚠️ Coach briefing failed: ${escapeHtml(err.message || 'Unknown error')}`, { parse_mode: 'HTML' });
      }
    });
  });

  // ── Onboarding Command ──
  bot.command('onboard', async (ctx) => {
    const args = (ctx.message?.text || '').replace(/^\/onboard\s*/i, '').trim();
    const userId = ctx.from?.id;
    if (!userId) return;

    const available = onboarding.getAvailableQuestionnaires();

    if (!args) {
      // Show available questionnaires
      const keyboard = new InlineKeyboard();
      for (const qId of available) {
        const def = onboarding.getQuestionnaire(qId)!;
        const ref = storeCallback({ action: 'start', questionnaire: qId }, 300_000);
        keyboard.text(`${def.title}`, `ob:start:${ref}`).row();
      }
      await ctx.reply(
        '📋 <b>Onboarding Questionnaires</b>\n\nChoose a profile to set up:',
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
      return;
    }

    // Start a specific questionnaire
    const qId = args.toLowerCase();
    if (!available.includes(qId)) {
      await ctx.reply(`Unknown questionnaire: ${escapeHtml(qId)}. Available: ${available.join(', ')}`);
      return;
    }

    const session = onboarding.startOrResume(userId, qId);
    const def = onboarding.getQuestionnaire(qId)!;
    const step = def.steps[session.current_step];
    if (!step) return;

    await sendOnboardingStep(ctx, qId, step, session.current_step, def.steps.length);
  });

  bot.command('profile', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const profiles = onboarding.getAllProfiles(userId);
    if (profiles.length === 0) {
      await ctx.reply('No profiles set up yet. Use /onboard to get started.');
      return;
    }

    const lines = profiles.map(p => {
      const data = p.data;
      const entries = Object.entries(data).map(([k, v]) => `  <code>${k}</code>: ${escapeHtml(String(v))}`);
      return `<b>${escapeHtml(p.profile_type)}</b>\n${entries.join('\n')}`;
    });
    await ctx.reply(`📋 <b>Your Profiles</b>\n\n${lines.join('\n\n')}`, { parse_mode: 'HTML' });
  });

  // ── Inline Keyboard Callback Handlers ──

  // Onboarding questionnaire callbacks
  bot.callbackQuery(/^ob:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];
    const userId = ctx.from?.id;
    if (!userId) return;

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.editMessageText('⚠️ This action has expired. Use /onboard to start again.');
      return;
    }

    switch (action) {
      case 'start': {
        const qId = cbData.questionnaire;
        const session = onboarding.startOrResume(userId, qId);
        const def = onboarding.getQuestionnaire(qId)!;
        const step = def.steps[session.current_step];
        if (!step) return;

        await ctx.editMessageText(
          `${def.title}\n\n${def.description}\n\nLet's begin! (${def.steps.length} questions)`,
          { parse_mode: 'HTML' },
        );
        await sendOnboardingStep(ctx, qId, step, session.current_step, def.steps.length);
        break;
      }
      case 'answer': {
        const { questionnaire: qId, answer } = cbData;
        try {
          const result = onboarding.answerStep(userId, qId, answer);
          if (!result.nextStep) {
            // Questionnaire complete
            const profile = onboarding.getProfile(userId, qId);
            const entries = profile ? Object.entries(profile.data).map(([k, v]) =>
              `  <code>${k}</code>: ${escapeHtml(String(v))}`
            ).join('\n') : '';
            await ctx.editMessageText(
              `✅ <b>Profile Complete!</b>\n\n${entries}\n\nYour ${qId} profile is saved. The AI will use this for personalized responses.`,
              { parse_mode: 'HTML' },
            );
          } else {
            await ctx.editMessageText(`✅ Got it!`);
            await sendOnboardingStep(ctx, qId, result.nextStep, result.session.current_step, onboarding.getQuestionnaire(qId)!.steps.length);
          }
        } catch (err: any) {
          await ctx.editMessageText(`⚠️ ${escapeHtml(err.message)}`);
        }
        break;
      }
      case 'cancel': {
        const qId = cbData.questionnaire;
        onboarding.abandonSession(userId, qId);
        await ctx.editMessageText('❌ Onboarding cancelled. Use /onboard to start again.');
        break;
      }
    }
  });

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

  // ── Content Idea Callback Handler ──
  bot.callbackQuery(/^ci:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore if callback query is too old
    }

    const cbData = getCallback(ref);
    if (!cbData) {
      await ctx.answerCallbackQuery({ text: '⚠️ Expired. Run /discover again.' });
      return;
    }

    if (action === 'save') {
      saveIdea(cbData.title, cbData.date);
      await ctx.answerCallbackQuery({ text: `💾 Saved: ${cbData.title.slice(0, 40)}` });
    }
  });

  // ── Content Workflow Callback Handler ──
  bot.callbackQuery(/^cw:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1]; // approve | skip | reject
    const feedbackId = parseInt(parts[2], 10);

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (isNaN(feedbackId)) {
      await ctx.answerCallbackQuery({ text: '⚠️ Invalid topic reference.' });
      return;
    }

    const topic = getTopicById(feedbackId);
    if (!topic) {
      await ctx.answerCallbackQuery({ text: '⚠️ Topic not found.' });
      return;
    }

    if (action === 'approve') {
      updateFeedback(feedbackId, 'approved');
      await ctx.answerCallbackQuery({ text: `✅ ${topic.title.slice(0, 40)}` });

      enqueue(ctx.from!.id, async () => {
        const statusMsg = await ctx.reply(
          `✍️ Generating ${topic.format} script for: <b>${escapeHtml(topic.title)}</b>...`,
          { parse_mode: 'HTML' },
        );

        try {
          const scriptText = topic.format === 'reel'
            ? await generateReelScript(topic)
            : await generateYouTubeScript(topic);

          const filePath = await saveScriptAsDocx(topic.title, scriptText);
          markScriptGenerated(feedbackId);

          const emoji = topic.format === 'reel' ? '🎬' : '🎥';
          await ctx.replyWithDocument(new InputFile(filePath), {
            caption: `${emoji} <b>${topic.format === 'reel' ? 'Reel' : 'YT'} Script: ${escapeHtml(topic.title)}</b>\n✅ Ready to record`,
            parse_mode: 'HTML',
          });

          await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id).catch(() => {});
        } catch (err: any) {
          logger.error({ err, feedbackId }, 'Content workflow script generation failed');
          await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id,
            `❌ Script failed: ${escapeHtml(err.message || 'Unknown error')}`);
        }
      });

    } else if (action === 'skip') {
      updateFeedback(feedbackId, 'skipped');
      await ctx.answerCallbackQuery({ text: `⏭ Skipped: ${topic.title.slice(0, 40)}` });

    } else if (action === 'reject') {
      updateFeedback(feedbackId, 'rejected');
      await ctx.answerCallbackQuery({ text: `👎 Noted — won't suggest similar` });
    }
  });

  // ── Invoice Correction Callback Handler ──
  bot.callbackQuery(/^nf:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1];
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (action === 'undo') {
      const cbData = getCallback(ref);
      if (!cbData) {
        await ctx.editMessageText('⚠️ Ação expirada. Envie a foto novamente.');
        return;
      }
      // Delete auto-logged finance transaction if one was created
      if (cbData.txId && ctx.from?.id) {
        const { deleteTransaction } = await import('./services/finance-tracker');
        deleteTransaction(ctx.from.id, cbData.txId);
        logger.info({ txId: cbData.txId }, 'Undid auto-logged finance transaction (not an invoice)');
      }
      await ctx.editMessageText('🔄 Reprocessando como tarefa...');
      // Re-download image from Telegram (stored fileId instead of base64 to save memory)
      const { base64: reBase64, mediaType: reMT } = await downloadTelegramFile(bot, cbData.fileId);
      // Re-classify with task hint — if still not task, force conversion
      const reClassified = await classifyAndExtractImage(reBase64, reMT, (cbData.caption || '') + ' [TASK LIST]');
      if (reClassified.type === 'task') {
        await handleTaskExtraction(ctx as any, reClassified, cbData.caption || '');
      } else if (reClassified.type === 'calendar') {
        // Force calendar events into task format
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: 'Items from image', subtasks: reClassified.events.map(e => e.title) },
          cbData.caption || '');
      } else {
        await handleTaskExtraction(ctx as any,
          { type: 'task', title: reClassified.vendor || 'Document', subtasks: [] },
          cbData.caption || '');
      }
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

  // ── Coach Recommendation Callback Handler (apply / all / dismiss) ──
  bot.callbackQuery(/^coach:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    const action = parts[1]; // 'apply' | 'all' | 'dismiss'
    const ref = parts[2];

    try { await ctx.answerCallbackQuery(); } catch { /* expired */ }

    if (action === 'dismiss') {
      await ctx.editMessageText('👍 <b>Calendário mantido como está.</b> Bom treino amanhã!', { parse_mode: 'HTML' });
      return;
    }

    if (action === 'apply') {
      // Apply a single recommendation
      const cbData = getCallback(ref);
      if (!cbData?.recommendation) {
        await ctx.editMessageText('⚠️ Ação expirada. Usa /coach novamente.');
        return;
      }
      const rec = cbData.recommendation as CoachRecommendation;
      await ctx.editMessageText(`⏳ Aplicando: ${escapeHtml(rec.summary)}...`, { parse_mode: 'HTML' });
      try {
        await applyCoachRecommendation(rec);
        await ctx.editMessageText(
          `✅ <b>Alteração aplicada:</b>\n${escapeHtml(rec.summary)}\n\n📅 O evento <b>${escapeHtml(rec.originalTitle)}</b> foi atualizado no calendário.`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        logger.error({ err, rec }, 'Coach: failed to apply recommendation');
        await ctx.editMessageText(`⚠️ Falha ao aplicar: ${escapeHtml((err as Error).message)}`, { parse_mode: 'HTML' });
      }
      return;
    }

    if (action === 'all') {
      // Apply all actionable recommendations
      const cbData = getCallback(ref);
      if (!cbData?.recommendations) {
        await ctx.editMessageText('⚠️ Ação expirada. Usa /coach novamente.');
        return;
      }
      const recs = cbData.recommendations as CoachRecommendation[];
      await ctx.editMessageText(`⏳ Aplicando ${recs.length} alterações ao calendário...`, { parse_mode: 'HTML' });

      let successCount = 0;
      const appliedSummaries: string[] = [];
      for (const rec of recs) {
        try {
          await applyCoachRecommendation(rec);
          successCount++;
          appliedSummaries.push(rec.summary);
        } catch (err) {
          logger.error({ err, rec }, 'Coach: failed to apply recommendation (batch)');
        }
      }

      if (successCount === 0) {
        await ctx.editMessageText('⚠️ Nenhuma alteração aplicada. Verifica o calendário.', { parse_mode: 'HTML' });
      } else {
        let msg = `✅ <b>${successCount}/${recs.length} alterações aplicadas:</b>\n`;
        for (const s of appliedSummaries) {
          msg += `\n  • ${escapeHtml(s)}`;
        }
        msg += '\n\n📅 Calendário de amanhã atualizado.';
        try {
          await ctx.editMessageText(msg, { parse_mode: 'HTML' });
        } catch (err) {
          if (isHtmlParseError(err)) await ctx.editMessageText(msg.replace(/<[^>]*>/g, ''));
          else throw err;
        }
      }
      return;
    }
  });

  // ── Photo handler: Vision → Unified classification (invoice / calendar / task) ──
  bot.on('message:photo', async (ctx) => {
    enqueue(ctx.from.id, async () => {
      await handlePhotoMessage(ctx);
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

          const contentResponse = await handleContent(repurposePrompt, 8192);

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

  // ── Skill Management Commands ──

  bot.command('skills', async (ctx) => {
    const skills = getAllSkillStatuses();
    if (skills.length === 0) {
      await ctx.reply(
        '<b>🔧 Skills</b>\n\n' +
        'No skills installed yet.\n\n' +
        'Skills are domain modules that give me capabilities like task management, ' +
        'calendar access, email, and more. They are installed automatically when the bot starts.\n\n' +
        'Try restarting the bot or check the <b>Status Portal</b> at port 8200.',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const SKILL_ICONS: Record<string, string> = { secretary: '📋', triathlon: '🏊', content: '🎬' };
    const lines: string[] = ['<b>🔧 Installed Skills</b>', ''];

    for (const skill of skills) {
      const icon = SKILL_ICONS[skill.name] || '📦';
      const status = skill.enabled ? '✅ Enabled' : '❌ Disabled';
      const activeSubs = skill.subSkills.filter(s => s.enabled).length;
      const totalSubs = skill.subSkills.length;
      const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);
      const activeTools = skill.subSkills.filter(s => s.enabled).reduce((sum, s) => sum + s.toolCount, 0);

      lines.push(`${icon} <b>${escapeHtml(skill.name)}</b> — ${status}`);
      lines.push(`   ${escapeHtml(skill.description)}`);
      lines.push(`   Sub-modules: ${activeSubs}/${totalSubs} active · Tools: ${activeTools}/${totalTools}`);
      lines.push('');
    }

    lines.push('Use /skill &lt;name&gt; for detail view.');
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('skill', async (ctx) => {
    const name = ctx.match?.trim().toLowerCase();
    if (!name) {
      await ctx.reply('Usage: /skill &lt;name&gt;\nExample: /skill secretary', { parse_mode: 'HTML' });
      return;
    }

    const validDomains = ['secretary', 'triathlon', 'content'];
    if (!validDomains.includes(name)) {
      await ctx.reply(
        `Unknown skill "<b>${escapeHtml(name)}</b>".\n\nAvailable skills: ${validDomains.join(', ')}`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    const skill = getSkillStatus(name as DomainName);
    const SKILL_ICONS: Record<string, string> = { secretary: '📋', triathlon: '🏊', content: '🎬' };
    const icon = SKILL_ICONS[skill.name] || '📦';
    const status = skill.enabled ? '✅ Enabled' : '❌ Disabled';

    const lines: string[] = [
      `${icon} <b>${escapeHtml(skill.name)}</b> — ${status}`,
      escapeHtml(skill.description),
      '',
      '<b>Sub-modules:</b>',
    ];

    for (const sub of skill.subSkills) {
      const subStatus = sub.enabled ? '🟢' : '🔴';
      lines.push(`  ${subStatus} <b>${escapeHtml(sub.name)}</b> — ${escapeHtml(sub.description)} (${sub.toolCount} tools)`);
    }

    const activeSubs = skill.subSkills.filter(s => s.enabled).length;
    const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);
    const activeTools = skill.subSkills.filter(s => s.enabled).reduce((sum, s) => sum + s.toolCount, 0);

    lines.push('');
    lines.push(`<b>Summary:</b> ${activeSubs}/${skill.subSkills.length} sub-modules active, ${activeTools}/${totalTools} tools available`);
    lines.push('');
    lines.push('Toggle sub-modules from the <b>Status Portal</b> at port 8200.');

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
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
      await handleDomainMessage(ctx, text);
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

// ─── Task List Keyboard Builder ──────────────────────────────────────

function buildTaskListKeyboard(tasks: msTodo.TodoTask[], listId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const task of tasks.slice(0, 5)) {
    const completeRef = storeCallback({ listId, taskId: task.id, title: task.title, listName: task.listName });
    const editRef = storeCallback({ listId, taskId: task.id, title: task.title, listName: task.listName });
    const deleteRef = storeCallback({ listId, taskId: task.id, title: task.title, listName: task.listName });

    keyboard
      .text(`✅ ${task.title.slice(0, 20)}`, `td:tc:${completeRef}`)
      .text('📝', `td:te:${editRef}`)
      .text('🗑', `td:tx:${deleteRef}`)
      .row();
  }

  return keyboard;
}

// ─── Handlers ────────────────────────────────────────────────────────

async function sendOnboardingStep(
  ctx: Context,
  questionnaireId: string,
  step: onboarding.QuestionStep,
  stepIdx: number,
  totalSteps: number,
): Promise<void> {
  const progress = `(${stepIdx + 1}/${totalSteps})`;
  const prompt = `${progress} ${step.prompt}`;

  if (step.type === 'choice' && step.options) {
    const keyboard = new InlineKeyboard();
    for (const option of step.options) {
      const ref = storeCallback({ questionnaire: questionnaireId, answer: option }, 300_000);
      keyboard.text(option, `ob:answer:${ref}`).row();
    }
    const cancelRef = storeCallback({ questionnaire: questionnaireId }, 300_000);
    keyboard.text('❌ Cancel', `ob:cancel:${cancelRef}`);
    await ctx.reply(prompt, { reply_markup: keyboard });
  } else if (step.type === 'multi_choice' && step.options) {
    // For multi_choice, present as individual buttons; user selects each
    const keyboard = new InlineKeyboard();
    for (const option of step.options) {
      const ref = storeCallback({ questionnaire: questionnaireId, answer: option }, 300_000);
      keyboard.text(option, `ob:answer:${ref}`).row();
    }
    const cancelRef = storeCallback({ questionnaire: questionnaireId }, 300_000);
    keyboard.text('❌ Cancel', `ob:cancel:${cancelRef}`);
    await ctx.reply(`${prompt}\n<i>(select one — you can update this later)</i>`, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } else {
    // Text or number input — set up pending onboarding input
    const userId = ctx.from?.id;
    if (userId) {
      pendingOnboarding.set(userId, {
        questionnaire: questionnaireId,
        step,
        expires: Date.now() + 300_000,
      });
    }
    await ctx.reply(`${prompt}\n<i>(type your answer)</i>`, { parse_mode: 'HTML' });
  }
}

async function handleDomainMessage(ctx: Context, text: string): Promise<void> {
  const systemCmd = isSystemCommand(text);
  if (systemCmd) return; // Already handled by command handlers

  try {
    await ctx.replyWithChatAction('typing');

    const userId = ctx.from?.id;

    // ── Calendar follow-up detection ──
    // If user recently received a calendar preview and sends a text about creating/adjusting events,
    // auto-trigger the calendar creation instead of routing to a domain that lacks context.
    if (userId) {
      const pending = pendingCalendarRef.get(userId);
      if (pending && Date.now() - pending.timestamp < 10 * 60 * 1000) {
        const lower = text.toLowerCase();
        const isCalendarFollowUp = /\b(cri[ae]|create|adjust|add|confirm|yes|sim|manda|vai|go ahead)\b/.test(lower)
          && /\b(event|evento|calendar|calend[aá]rio|outlook|agenda)\b/.test(lower);
        if (isCalendarFollowUp) {
          const cbData = getCallback(pending.ref);
          if (cbData) {
            pendingCalendarRef.delete(userId);
            await ctx.reply('⏳ Criando eventos no calendário...');
            const events = cbData.events as { title: string; start: string; end: string; description?: string }[];
            const categories = cbData.categories as string[];
            let successCount = 0;
            const createdTitles: string[] = [];
            for (const event of events) {
              try {
                const created = await createCalendarEvent({
                  title: event.title, start: event.start, end: event.end,
                  description: event.description, categories,
                });
                successCount++;
                createdTitles.push(created.summary);
              } catch (err) {
                logger.error({ err, eventTitle: event.title }, 'Failed to create calendar event from text follow-up');
              }
            }
            if (successCount === 0) {
              await ctx.reply('⚠️ Falha ao criar os eventos. Tente novamente.');
              return;
            }
            let msg = `📅✅ <b>${successCount} evento${successCount > 1 ? 's' : ''} criado${successCount > 1 ? 's' : ''}:</b>\n`;
            for (const title of createdTitles) msg += `\n  📌 ${escapeHtml(title)}`;
            msg += `\n\n🏷️ ${escapeHtml(categories[0])}`;
            try {
              await ctx.reply(msg, { parse_mode: 'HTML' });
            } catch (err) {
              if (isHtmlParseError(err)) await ctx.reply(msg.replace(/<[^>]*>/g, ''));
              else throw err;
            }
            return;
          }
        }
      }
    }

    // ── Build active conversation context for the classifier ──
    // If the user recently interacted with a domain and the bot's last message
    // is still unanswered, pass that context to the classifier so it can
    // intelligently decide: is this a follow-up or a new topic?
    let activeContext: { domain: DomainName; lastAssistantMessage: string } | null = null;
    if (userId && !text.startsWith('/')) {
      const lastState = lastActiveDomain.get(userId);
      if (lastState && Date.now() - lastState.timestamp < CONTINUITY_WINDOW_MS) {
        const lastMsg = getLastAssistantMessage(lastState.domain);
        if (lastMsg) {
          activeContext = { domain: lastState.domain, lastAssistantMessage: lastMsg };
        }
      }
    }

    const route = await routeMessage(text, activeContext);
    logger.info({ domain: route.domain, method: route.method, confidence: route.confidence }, 'Message routed');

    // Track last active domain for photo routing and conversation continuity
    if (userId) lastActiveDomain.set(userId, { domain: route.domain, timestamp: Date.now() });

    const handler = DOMAIN_HANDLERS[route.domain];
    const response = await handler(route.strippedMessage, ctx.from?.id);

    const parts = splitMessage(response.text);
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'HTML' });
      } catch (err) {
        if (isHtmlParseError(err)) await ctx.reply(part.replace(/<[^>]*>/g, ''));
        else throw err;
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to handle domain message');
    await ctx.reply('⚠️ Something went wrong processing your message. Please try again.');
  }
}

async function handlePhotoMessage(ctx: Context): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing');
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const caption = ctx.message?.caption || '';
    const userId = ctx.from?.id;

    // ── Branch 1: Caption explicitly targets a non-secretary domain ──
    // Only route to non-secretary if the caption has a clear keyword match.
    // Never fall back to lastActiveDomain for photos — they are self-contained
    // (invoices, screenshots, etc.) and should be classified on their own merit.
    if (caption) {
      const domainFromCaption = keywordMatch(caption) as DomainName | null;

      if (domainFromCaption && domainFromCaption !== 'secretary') {
        const handler = DOMAIN_HANDLERS[domainFromCaption];
        const photoContext = `[Photo attached] ${caption}`;
        const response = await handler(photoContext, userId);
        if (userId) lastActiveDomain.set(userId, { domain: domainFromCaption, timestamp: Date.now() });
        const parts = splitMessage(response.text);
        for (const part of parts) {
          try {
            await ctx.reply(part, { parse_mode: 'HTML' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(part.replace(/<[^>]*>/g, ''));
            else throw err;
          }
        }
        return;
      }
    }

    // ── Download image (needed for both invoice filing and task extraction) ──
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    // SECURITY: fileUrl contains bot token — never log this variable
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
    logger.debug({ filePath: file.file_path }, 'Downloading Telegram file');

    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');
    const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
    const mediaType = (
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    ) as 'image/jpeg' | 'image/png' | 'image/webp';

    // ── Branch 2: Unified image classification (invoice / calendar / task) ──
    const classification = await classifyAndExtractImage(base64, mediaType as any, caption || undefined);

    switch (classification.type) {
      case 'invoice':
        await handleInvoiceFiling(ctx, buffer, mediaType, classification, photo.file_id, caption);
        break;

      case 'calendar':
        await handleCalendarExtraction(ctx, classification, caption, photo.file_id, mediaType);
        break;

      case 'task':
        await handleTaskExtraction(ctx, classification, caption);
        break;

      default:
        await ctx.reply('📷 Não foi possível classificar esta imagem. Tente adicionar uma legenda.');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to process photo message');
    await ctx.reply('⚠️ Falha ao processar a imagem. Tente novamente.');
  }
}

/**
 * Handle invoice filing when unified classifier detects an invoice.
 */
async function handleInvoiceFiling(
  ctx: Context,
  buffer: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  analysis: ImageInvoiceResult,
  fileId: string,
  caption: string
): Promise<void> {
  if (!isInvoiceFilingConfigured() || analysis.confidence < config.invoices.minConfidence) {
    logger.info({ confidence: analysis.confidence }, 'Invoice detected but low confidence or filing not configured');
    // Fall through to task extraction as fallback
    await handleTaskExtraction(ctx, { type: 'task', title: analysis.vendor || 'Document', subtasks: [] }, caption);
    return;
  }

  logger.info(
    { vendor: analysis.vendor, date: analysis.documentDate, confidence: analysis.confidence },
    'Invoice detected — filing via SCP'
  );

  // Map unified result to InvoiceAnalysis format expected by fileInvoice
  const invoiceAnalysis: InvoiceAnalysis = {
    isInvoice: true,
    confidence: analysis.confidence,
    documentDate: analysis.documentDate,
    documentDateRaw: analysis.documentDateRaw,
    vendor: analysis.vendor,
    totalAmount: analysis.totalAmount,
    invoiceNumber: analysis.invoiceNumber,
  };

  const filingResult = await fileInvoice(buffer, mediaType, invoiceAnalysis);

  if (filingResult.success) {
    recordFiling({
      vendor: analysis.vendor || 'Unknown',
      amount: analysis.totalAmount,
      document_date: analysis.documentDate,
      invoice_number: analysis.invoiceNumber,
      source: 'photo',
      source_ref: 'telegram_photo',
      remote_path: filingResult.filePath,
      folder_path: filingResult.folderPath,
      filename: filingResult.filename,
      file_size_bytes: filingResult.originalSizeKB ? filingResult.originalSizeKB * 1024 : null,
      compressed_size_bytes: filingResult.compressedSizeKB ? filingResult.compressedSizeKB * 1024 : null,
      status: 'filed',
    });

    // ── Auto-log receipt as finance expense transaction ──
    const userId = ctx.from?.id;
    const parsedAmount = parseReceiptAmount(analysis.totalAmount);
    let txId: number | null = null;

    if (userId && parsedAmount) {
      const txDate = analysis.documentDate || new Date().toISOString().split('T')[0];
      const tx = addTransaction(userId, txDate, 'expense', parsedAmount, {
        subcategory: 'receipt',
        description: analysis.vendor ? `Receipt: ${analysis.vendor}` : 'Receipt from photo',
        receiptRef: filingResult.filename || undefined,
      });
      txId = tx.id;
      logger.info({ userId, amount: parsedAmount, vendor: analysis.vendor }, 'Receipt auto-logged as finance transaction');
    }

    let msg = `🧾 <b>Nota fiscal arquivada!</b>\n\n`;
    if (analysis.vendor) msg += `🏢 ${escapeHtml(analysis.vendor)}\n`;
    if (analysis.documentDateRaw) msg += `📅 ${escapeHtml(analysis.documentDateRaw)}\n`;
    if (analysis.totalAmount) msg += `💰 ${escapeHtml(analysis.totalAmount)}\n`;
    if (analysis.invoiceNumber) msg += `🔢 ${escapeHtml(analysis.invoiceNumber)}\n`;
    msg += `\n📁 <code>${escapeHtml(filingResult.folderPath!)}</code>`;
    msg += `\n📄 <code>${escapeHtml(filingResult.filename!)}</code>`;

    if (filingResult.originalSizeKB && filingResult.compressedSizeKB && filingResult.originalSizeKB !== filingResult.compressedSizeKB) {
      const savings = Math.round((1 - filingResult.compressedSizeKB / filingResult.originalSizeKB) * 100);
      msg += `\n📦 ${filingResult.originalSizeKB}KB → ${filingResult.compressedSizeKB}KB (-${savings}%)`;
    }

    if (txId && parsedAmount) {
      msg += `\n\n💳 <b>Despesa registrada:</b> R$ ${parsedAmount.toFixed(2)}`;
    }

    // Store fileId instead of base64 to reduce memory (~500KB-2MB per entry)
    const ref = storeCallback({ fileId, caption, txId });
    const keyboard = new InlineKeyboard()
      .text('❌ Não é nota fiscal', `nf:undo:${ref}`);

    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  // Filing failed — check if it's an SSH/connectivity issue and queue for retry
  const isSshError = filingResult.error && (
    filingResult.error.includes('Connection') ||
    filingResult.error.includes('timed out') ||
    filingResult.error.includes('No route') ||
    filingResult.error.includes('Connection refused') ||
    filingResult.error.includes('Host is down') ||
    filingResult.error.includes('Permission denied') ||
    filingResult.error.includes('ssh') ||
    filingResult.error.includes('scp')
  );

  if (isSshError) {
    logger.warn({ error: filingResult.error }, 'Invoice filing failed (SSH) — queuing for retry');
    const queueId = enqueueInvoice(
      buffer,
      'image',
      mediaType,
      JSON.stringify(invoiceAnalysis),
      'photo',
    );
    const pendingCount = getPendingCount();

    let msg = `📥 <b>Nota fiscal na fila de envio</b>\n\n`;
    msg += `O Mac parece estar indisponível (a dormir ou sem túnel SSH).\n`;
    msg += `A fatura foi guardada localmente e será enviada automaticamente quando a ligação voltar.\n\n`;
    if (analysis.vendor) msg += `🏢 ${escapeHtml(analysis.vendor)}\n`;
    if (analysis.totalAmount) msg += `💰 ${escapeHtml(analysis.totalAmount)}\n`;
    if (analysis.documentDateRaw) msg += `📅 ${escapeHtml(analysis.documentDateRaw)}\n`;
    msg += `\n🔄 Fila: ${pendingCount} fatura${pendingCount > 1 ? 's' : ''} pendente${pendingCount > 1 ? 's' : ''}`;
    msg += `\n⏱️ Tentativa automática a cada 15 minutos`;

    await ctx.reply(msg, { parse_mode: 'HTML' });
    return;
  }

  logger.error({ error: filingResult.error }, 'Invoice filing failed');
  await ctx.reply(
    `⚠️ Nota fiscal detectada mas falhou ao arquivar: ${escapeHtml(filingResult.error || 'Erro desconhecido')}`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle calendar event creation when unified classifier detects a schedule/timetable.
 */
async function handleCalendarExtraction(
  ctx: Context,
  result: ImageCalendarResult,
  caption: string,
  fileId: string,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
): Promise<void> {
  if (!isAnyCalendarConfigured()) {
    await ctx.reply('📅 Conteúdo de calendário detectado, mas nenhum calendário está configurado.');
    return;
  }

  if (!result.events || result.events.length === 0) {
    await ctx.reply('📅 Parece ser um calendário, mas não foi possível extrair eventos. Tente com uma imagem mais clara.');
    return;
  }

  const info = await parseCaptionInfo(caption);

  // ── Shift past events forward to next occurrence of same weekday ──
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const allInPast = result.events.every((e) => new Date(e.start) < todayStart);
  if (allInPast && result.events.length > 0) {
    const earliest = new Date(Math.min(...result.events.map((e) => new Date(e.start).getTime())));
    const daysDiff = Math.ceil((todayStart.getTime() - earliest.getTime()) / (24 * 60 * 60 * 1000));
    const weeksToShift = Math.ceil(daysDiff / 7);
    const msShift = weeksToShift * 7 * 24 * 60 * 60 * 1000;
    logger.info({ weeksShifted: weeksToShift, originalStart: earliest.toISOString() },
      'Calendar events are in the past — shifting forward to preserve weekdays');
    for (const e of result.events) {
      e.start = new Date(new Date(e.start).getTime() + msShift).toISOString().replace('Z', '').split('.')[0];
      e.end = new Date(new Date(e.end).getTime() + msShift).toISOString().replace('Z', '').split('.')[0];
    }
  }

  // ── Apply prefix to event titles (SMS - / EC - ) ──
  const prefixedEvents = result.events.map((e) => ({
    ...e,
    title: info.prefix ? `${info.prefix}${e.title}` : e.title,
  }));

  // ── Fetch existing calendar events to detect conflicts ──
  const starts = prefixedEvents.map((e) => new Date(e.start).getTime());
  const ends = prefixedEvents.map((e) => new Date(e.end).getTime());
  const rangeStart = new Date(Math.min(...starts));
  const rangeEnd = new Date(Math.max(...ends));
  // Add 1 day buffer at end
  rangeEnd.setDate(rangeEnd.getDate() + 1);

  let existingEvents: { summary: string; start: string; end: string }[] = [];
  try {
    existingEvents = await getEvents(rangeStart.toISOString(), rangeEnd.toISOString());
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch existing calendar events for conflict check');
  }

  // ── Detect conflicts (overlapping time slots) ──
  interface Conflict {
    newEvent: string;
    newTime: string;
    existingEvent: string;
    existingTime: string;
  }
  const conflicts: Conflict[] = [];

  for (const newEvt of prefixedEvents) {
    const nStart = new Date(newEvt.start).getTime();
    const nEnd = new Date(newEvt.end).getTime();

    for (const existing of existingEvents) {
      const eStart = new Date(existing.start).getTime();
      const eEnd = new Date(existing.end).getTime();

      // Two events overlap if one starts before the other ends
      if (nStart < eEnd && nEnd > eStart) {
        conflicts.push({
          newEvent: newEvt.title,
          newTime: `${formatTime(newEvt.start)}-${formatTime(newEvt.end)}`,
          existingEvent: existing.summary,
          existingTime: `${formatTime(existing.start)}-${formatTime(existing.end)}`,
        });
      }
    }
  }

  // ── Build preview message ──
  let msg = `📅 <b>${prefixedEvents.length} evento${prefixedEvents.length > 1 ? 's' : ''} detectado${prefixedEvents.length > 1 ? 's' : ''} (${escapeHtml(info.label)}):</b>\n`;
  for (const evt of prefixedEvents) {
    const day = new Date(evt.start).toLocaleDateString('pt-PT', { weekday: 'short', day: 'numeric' });
    msg += `\n  📌 ${escapeHtml(evt.title)} — ${day} ${formatTime(evt.start)}-${formatTime(evt.end)}`;
  }

  msg += `\n\n🏷️ Categoria: <b>${escapeHtml(info.categories[0])}</b>`;

  if (conflicts.length > 0) {
    msg += `\n\n⚠️ <b>${conflicts.length} conflito${conflicts.length > 1 ? 's' : ''} com eventos existentes:</b>`;
    // Deduplicate and limit display
    const shown = new Set<string>();
    for (const c of conflicts) {
      const key = `${c.newEvent}|${c.existingEvent}`;
      if (shown.has(key)) continue;
      shown.add(key);
      msg += `\n  🔴 <b>${escapeHtml(c.newEvent)}</b> (${c.newTime}) ↔ <b>${escapeHtml(c.existingEvent)}</b> (${c.existingTime})`;
      if (shown.size >= 15) { msg += '\n  ...'; break; }
    }
  } else {
    msg += '\n\n✅ Sem conflitos com eventos existentes.';
  }

  // ── Store pending events and show confirmation buttons ──
  // Store fileId instead of base64 to reduce memory (~500KB-2MB per entry)
  const ref = storeCallback({
    events: prefixedEvents,
    categories: info.categories,
    fileId,
    caption,
  }, 10 * 60 * 1000); // 10 min TTL for calendar follow-ups

  // Track pending calendar ref so text follow-ups can trigger creation
  const calUserId = ctx.from?.id;
  if (calUserId) pendingCalendarRef.set(calUserId, { ref, timestamp: Date.now() });

  const keyboard = new InlineKeyboard()
    .text(`✅ Criar ${prefixedEvents.length} evento${prefixedEvents.length > 1 ? 's' : ''}`, `cal:create:${ref}`)
    .text('❌ Cancelar', `cal:cancel:${ref}`)
    .row()
    .text('🔄 Não é calendário', `cal:undo:${ref}`);

  await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
}

/**
 * Handle task creation when unified classifier detects a task/checklist.
 * Preserved from the original handlePhotoTaskExtraction logic.
 */
async function handleTaskExtraction(
  ctx: Context,
  extracted: ImageTaskResult,
  caption: string,
): Promise<void> {
  if (!msTodo.isOutlookTodoConfigured()) {
    await ctx.reply('📷 Foto recebida, mas o Microsoft To Do não está configurado.');
    return;
  }

  if (!extracted.title) {
    await ctx.reply('📷 Não foi possível extrair tarefas desta imagem. Tente adicionar uma legenda.');
    return;
  }

  let targetList: msTodo.TodoList | null = null;
  if (extracted.listHint) targetList = await msTodo.findListByName(extracted.listHint);
  if (!targetList) targetList = await msTodo.getDefaultList();
  if (!targetList) {
    const lists = await msTodo.getLists();
    if (lists.success && lists.data.length > 0) targetList = lists.data[0];
  }
  if (!targetList) {
    await ctx.reply('⚠️ Nenhuma lista de tarefas encontrada.');
    return;
  }

  const taskResult = await msTodo.createTask(targetList.id, targetList.displayName, {
    title: extracted.title,
  });
  if (!taskResult.success) {
    await ctx.reply(`⚠️ Falha ao criar tarefa: ${taskResult.error}`);
    return;
  }

  let addedSubtasks = 0;
  if (extracted.subtasks.length > 0) {
    const subResults = await Promise.all(
      extracted.subtasks.map((sub) => msTodo.addChecklistItem(targetList!.id, taskResult.data.id, sub))
    );
    addedSubtasks = subResults.filter((r) => r.success).length;
  }

  let msg = `📷✅ Tarefa criada da imagem:\n\n<b>${escapeHtml(extracted.title)}</b>\n📋 ${escapeHtml(targetList.displayName)}`;
  if (addedSubtasks > 0) {
    msg += `\n\n📝 ${addedSubtasks} subtarefa${addedSubtasks > 1 ? 's' : ''}:`;
    for (const sub of extracted.subtasks.slice(0, addedSubtasks)) {
      msg += `\n  ⬜ ${escapeHtml(sub)}`;
    }
  }
  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleUndone(ctx: Context, query: string): Promise<void> {
  const searchResult = await msTodo.searchTasks(query);
  if (!searchResult.success || searchResult.data.length === 0) {
    await ctx.reply(`❌ No task matching "${escapeHtml(query)}" found.`, { parse_mode: 'HTML' });
    return;
  }

  const completed = searchResult.data.filter((t) => t.status === 'completed');
  if (completed.length === 0) {
    await ctx.reply(`⬜ "${escapeHtml(query)}" is not completed — nothing to reopen.`, { parse_mode: 'HTML' });
    return;
  }

  const task = completed[0];
  const result = await msTodo.uncompleteTask(task.listId, task.id);
  if (result.success) {
    await ctx.reply(`⬜ Reopened: "<b>${escapeHtml(task.title)}</b>" [${escapeHtml(task.listName)}]`, { parse_mode: 'HTML' });
  } else {
    await ctx.reply(`⚠️ Failed to reopen task: ${result.error}`);
  }
}

async function handleDeleteTask(ctx: Context, query: string): Promise<void> {
  const searchResult = await msTodo.searchTasks(query);
  if (!searchResult.success || searchResult.data.length === 0) {
    await ctx.reply(`❌ No task matching "${escapeHtml(query)}" found.`, { parse_mode: 'HTML' });
    return;
  }

  const task = searchResult.data[0];
  const ref = storeCallback({ listId: task.listId, taskId: task.id, title: task.title, listName: task.listName, type: 'task' });
  const keyboard = new InlineKeyboard()
    .text('Yes, delete', `td:dy:${ref}`)
    .text('Cancel', `td:dn:${ref}`);

  await ctx.reply(`🗑 Delete "<b>${escapeHtml(task.title)}</b>" from ${escapeHtml(task.listName)}?`, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

async function handlePendingEdit(ctx: Context, pending: PendingEdit, value: string): Promise<void> {
  try {
    await ctx.replyWithChatAction('typing');
    const { listId, taskId, title, listName, field } = pending;

    switch (field) {
      case 'title': {
        const result = await msTodo.updateTask(listId, taskId, { title: value });
        if (result.success) {
          await ctx.reply(`📝 Renamed: "${escapeHtml(title)}" → "<b>${escapeHtml(value)}</b>" [${escapeHtml(listName)}]`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`⚠️ Failed to rename: ${result.error}`);
        }
        break;
      }
      case 'due': {
        const parsed = parseNaturalDate(value);
        if (!parsed) {
          await ctx.reply(`⚠️ Couldn't parse date: "${escapeHtml(value)}". Try "tomorrow 5pm" or "2026-03-15".`);
          return;
        }
        const result = await msTodo.updateTask(listId, taskId, { dueDateTime: parsed });
        if (result.success) {
          await ctx.reply(`📅 Due date set for "<b>${escapeHtml(title)}</b>": ${formatDateTime(parsed)}`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`⚠️ Failed to set due date: ${result.error}`);
        }
        break;
      }
      case 'reminder': {
        const parsed = parseNaturalDate(value);
        if (!parsed) {
          await ctx.reply(`⚠️ Couldn't parse time: "${escapeHtml(value)}". Try "today 2pm" or "2026-03-15T14:00".`);
          return;
        }
        const result = await msTodo.updateTask(listId, taskId, { reminderDateTime: parsed });
        if (result.success) {
          await ctx.reply(`⏰ Reminder set for "<b>${escapeHtml(title)}</b>": ${formatDateTime(parsed)}`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`⚠️ Failed to set reminder: ${result.error}`);
        }
        break;
      }
      case 'priority': {
        const level = value.toLowerCase().trim();
        if (!['low', 'normal', 'high'].includes(level)) {
          await ctx.reply('⚠️ Priority must be: low, normal, or high');
          return;
        }
        const result = await msTodo.updateTask(listId, taskId, { importance: level as 'low' | 'normal' | 'high' });
        if (result.success) {
          await ctx.reply(`⚡ Priority set to <b>${level}</b> for "${escapeHtml(title)}"`, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(`⚠️ Failed to update priority: ${result.error}`);
        }
        break;
      }
      default:
        await ctx.reply('⚠️ Unknown edit field.');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to handle pending edit');
    await ctx.reply('⚠️ Failed to apply the edit. Please try again.');
  }
}

async function handleTodoSummary(ctx: Context): Promise<void> {
  const pendingResult = await msTodo.getAllPendingTasks();
  if (!pendingResult.success) {
    await ctx.reply(`⚠️ Failed to fetch tasks: ${pendingResult.error}`);
    return;
  }

  const pending = pendingResult.data;
  const nowDate = new Date();
  const todayStart = new Date(startOfDay()).getTime();
  const todayEnd = new Date(endOfDay()).getTime();

  const overdue = pending.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
  const highPriority = pending.filter((t) => t.importance === 'high');
  // Derive due-today from pending data — no second API call needed
  const dueToday = pending.filter((t) => {
    if (!t.dueDateTime) return false;
    const due = new Date(t.dueDateTime).getTime();
    return due >= todayStart && due <= todayEnd;
  });

  const msg = formatMsTodoSummary({
    pendingCount: pending.length,
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    highPriorityCount: highPriority.length,
    overdueTasks: overdue,
    dueTodayTasks: dueToday,
  });

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleStatus(ctx: Context): Promise<void> {
  let msg = '<b>📊 Status Overview</b>\n\n';

  // Microsoft To Do
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const pendingResult = await msTodo.getAllPendingTasks();
      if (pendingResult.success) {
        const highPriority = pendingResult.data.filter((t) => t.importance === 'high');
        msg += `📋 Microsoft To Do: ${pendingResult.data.length} pending tasks\n`;
        if (highPriority.length > 0) {
          msg += `🔴 High priority: ${highPriority.length}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Status: failed to fetch MS Todo tasks');
      msg += '📋 Microsoft To Do: unavailable\n';
    }
  } else {
    msg += '📋 Microsoft To Do: not configured\n';
  }

  const reminders = getActiveReminders();
  msg += `⏰ Active reminders: ${reminders.length}\n`;

  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay());
      msg += `📅 Events today: ${events.length}\n`;
    } catch (err) {
      logger.warn({ err }, 'Status: failed to fetch calendar events');
      msg += '📅 Calendar: unavailable\n';
    }
  } else {
    msg += '📅 Calendar: not configured\n';
  }

  if (isOutlookMailConfigured()) {
    try {
      const unread = await getOutlookUnread();
      msg += `📧 Outlook unread: ${unread}\n`;
    } catch (err) {
      logger.warn({ err }, 'Status: failed to fetch Outlook unread');
      msg += '📧 Outlook: unavailable\n';
    }
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleDayOverview(ctx: Context): Promise<void> {
  let msg = `<b>📅 ${now().toFormat('cccc, LLLL dd yyyy')}</b>\n\n`;

  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay());
      if (events.length === 0) {
        msg += 'No events scheduled today.\n';
      } else {
        for (const e of events) {
          const src = (e as any).source === 'outlook' ? ' 📧' : '';
          msg += `${formatTime(e.start)} - ${formatTime(e.end)}  ${escapeHtml(e.summary)}${src}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Day overview: failed to fetch calendar events');
      msg += 'Calendar unavailable.\n';
    }
  } else {
    msg += 'Calendar not configured.\n';
  }

  // Microsoft To Do — due today
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const dueTodayResult = await msTodo.getTasksDueInRange(startOfDay(), endOfDay());
      if (dueTodayResult.success && dueTodayResult.data.length > 0) {
        msg += `\n📋 Due today (${dueTodayResult.data.length}):\n`;
        for (const t of dueTodayResult.data) {
          msg += `- ${escapeHtml(t.title)} [${escapeHtml(t.listName)}]\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Day overview: failed to fetch due tasks');
    }
  }

  await ctx.reply(msg, { parse_mode: 'HTML' });
}

async function handleWeekOverview(ctx: Context): Promise<void> {
  let msg = `<b>📅 Week Overview</b>\n`;
  msg += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfWeek(), endOfWeek());
      if (events.length === 0) {
        msg += 'No events this week.\n';
      } else {
        let currentDay = '';
        for (const e of events) {
          const day = formatDateTime(e.start).split(',')[0];
          if (day !== currentDay) {
            currentDay = day;
            msg += `\n<b>${day}</b>\n`;
          }
          const src = (e as any).source === 'outlook' ? ' 📧' : '';
          msg += `  ${formatTime(e.start)} - ${formatTime(e.end)}  ${escapeHtml(e.summary)}${src}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Week overview: failed to fetch calendar events');
      msg += 'Calendar unavailable.\n';
    }
  } else {
    msg += 'Calendar not configured.\n';
  }

  // Microsoft To Do — pending tasks count
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const pendingResult = await msTodo.getAllPendingTasks();
      if (pendingResult.success && pendingResult.data.length > 0) {
        msg += `\n📋 Pending tasks: ${pendingResult.data.length}\n`;
      }
    } catch (err) {
      logger.warn({ err }, 'Week overview: failed to fetch pending tasks');
    }
  }

  const parts = splitMessage(msg);
  for (const part of parts) {
    await ctx.reply(part, { parse_mode: 'HTML' });
  }
}

// ─── Help Text ───────────────────────────────────────────────────────

const HELP_TEXT = `<b>🤖 Felipe's Command Hub</b>

<b>📋 MICROSOFT TO DO</b>
/lists — Show all task lists
/tasks [list] — Tasks in a list
/alltasks — All tasks across all lists
/newtask [task] — Create task
/newtask [list] | [task] — Create in specific list
/done [task] — Complete a task
/undone [task] — Reopen a task
/edittask [task] | [new title] — Rename a task
/notetask [task] | [note] — Add description
/movetask [task] | [list] — Move to another list
/addstep [task] | [step] — Add checklist step
/steps [task] — Show checklist steps
/newlist [name] — Create a list
/deletelist [name] — Delete a list
/deletetask [task] — Delete a task
/due [task] | [date] — Set due date
/remind [task] | [time] — Set reminder
/priority [task] | [level] — Set importance
/search [query] — Search tasks
/todosummary — Task summary
/overdue — All overdue tasks
/duetoday — Tasks due today
/dueweek — Tasks due this week
/completed [list] — Recently completed tasks

<b>📅 SCHEDULE &amp; SECRETARY</b>
/day — Today's schedule
/week — Week overview
/plan — Tomorrow's plan
/review — Weekly review

<b>🏋️ TRIATHLON &amp; COACH</b>
/coach — Daily training analysis (Garmin data + calendar)
/checkin — How I feel today
/gym — Gym program
/run — Running plan
/bike — Cycling plan
/meal — Carnivore meal plan
/macros — Macros tracking
/deload — Deload recommendations
/pain — Pain/injury report

<b>📹 CONTENT — Quick Guide</b>
• Want ideas? → Wait for Tue/Thu/Fri auto-delivery or /contenttopic
• Research trends? → /discover (--news or --platform)
• Reaction angles? → /reaction [topic]
• Ready to write? → /script [topic]
• Have a script? → /repurpose to multiply
• Published? → /published [URL] to close pipeline
• Track performance? → /feedback [URL]

<b>🔍 DISCOVER &amp; RESEARCH</b>
/discover — Full content discovery (trending + ideas)
/discover --news — Hot news scan
/discover --platform — Cross-platform trends
/deepsearch [topic] — Deep research pipeline
/sources [topic] — Curated source list
/reaction [topic] — Find reaction-worthy content

<b>✍️ CREATE</b>
/script [topic] — Full video script (research + AI intelligence)
/hooks [topic] — Generate scroll-stopping hooks
/titles [topic] — A/B title variants
/genthumbnail [title] — Thumbnail concepts
/gencaption [topic] — Instagram caption + hashtags
/repurpose [topic] — 1 video → Reels + Stories + Tweets

<b>📊 ANALYZE</b>
/competitor [channel] — Reverse-engineer a channel
/gaps [niche] — Find content gaps
/seo [topic] — Keyword analysis
/feedback [url] [views] [ret%] — Log performance
/report [week|month] — Content performance report

<b>📚 KNOWLEDGE</b>
/learnfrom [url] — Learn from a YouTube channel
/references — List reference channels
/relearn — Re-analyze all channels
/addbook Title | Author — Add book to library
/books — View book library
/bookidea [topic] — Search books for ideas

<b>📝 VIDEO TOOLS</b>
/transcribe [url] — Extract YouTube transcript
/studyvideo [url] — Deep study: hooks, structure, reel cuts
/ideas [date] — View ideas by date
/ideas saved — View saved ideas

<b>📄 FATURAS</b>
/amazon [YYYY-MM] [--force] — Recolher faturas Amazon
/uber [YYYY-MM] [--force] — Recolher faturas Uber
📸 Send photo of invoice → Auto-files

<b>🔬 AUTORESEARCH</b>
/autoresearch [target] [rounds] [--dry] — Run prompt optimization
/evalscore [target] — Score current prompt without mutation

<b>🧩 SKILLS</b>
/skills — List installed skills with status
/skill [name] — Detail view of a skill
/skill [name] enable|disable — Toggle a skill on/off
/skill [name] modules — List sub-modules
/skill [name] module [sub] enable|disable — Toggle a sub-module

<b>🔧 SYSTEM</b>
/help — This menu
/status — Current state overview
/skills — List installed skills
/skill [name] — Skill detail view
/clear [domain] — Clear conversation history
/garminmfa [code] — Submit Garmin MFA code

💡 Just type naturally — I'll route to the right domain.
🌐 Portal: http://your-server:8200`;
