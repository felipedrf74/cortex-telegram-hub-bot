import crypto from 'crypto';
import { Bot, Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { config } from './config';
import { logger } from './utils/logger';
import { routeMessage, isSystemCommand } from './router';
import { DomainName } from './domains/types';
import { handleSecretary } from './domains/secretary';
import { handleTriathlon } from './domains/triathlon';
import { handleContent } from './domains/content-creator';
import { getActiveReminders } from './state/reminders';
import { clearConversation, clearAllConversations } from './state/conversation';
import {
  formatMsTodoLists, formatMsTodoTasks, formatMsTodoTaskCreated, formatMsTodoSummary,
  formatReminders, splitMessage, escapeHtml,
  formatChecklistItems, formatAllTasks, formatCompletedTasks,
} from './utils/telegram-formatter';
import * as msTodo from './services/microsoft-todo';
import { getEvents, createEvent as createCalendarEvent, isAnyCalendarConfigured } from './services/unified-calendar';
import { getCategoryNameForColor, getMasterCategories } from './services/outlook-calendar';
import { isOutlookMailConfigured, getUnreadCount as getOutlookUnread } from './services/outlook-mail';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, now, formatTime, formatDateTime, parseNaturalDate } from './utils/date-parser';
import { classifyAndExtractImage, ImageInvoiceResult, ImageCalendarResult, ImageTaskResult } from './services/anthropic';
import { runContentDiscovery } from './services/content-discovery';
import { saveIdea, getSavedIdeas, markIdeaUsed, deleteIdea } from './state/saved-ideas';
import { InvoiceAnalysis, fileInvoice, isInvoiceFilingConfigured, PT_MONTHS } from './services/invoice-filer';
import { collectMonthlyInvoices, formatCollectionNotification, getBuiltinVendors, getAllVendors } from './services/invoice-collector';
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
import fs from 'fs';
import path from 'path';

// ─── Rate Limiter ────────────────────────────────────────────────────

const rateLimitMap = new Map<number, number[]>();

function isRateLimited(userId: number): boolean {
  const ts = Date.now();
  const window = 60_000; // 1 minute
  const max = config.rateLimit.maxMessagesPerMinute;

  let timestamps = rateLimitMap.get(userId) || [];
  timestamps = timestamps.filter((t) => ts - t < window);
  timestamps.push(ts);
  rateLimitMap.set(userId, timestamps);

  return timestamps.length > max;
}

// ─── Domain Handler Map ──────────────────────────────────────────────

const DOMAIN_HANDLERS: Record<DomainName, (message: string) => Promise<{ text: string; domain: DomainName }>> = {
  secretary: handleSecretary,
  triathlon: handleTriathlon,
  content: handleContent,
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

// ─── Inline Keyboard Callback Store ─────────────────────────────────

interface CallbackEntry {
  data: any;
  expires: number;
}

const callbackStore = new Map<string, CallbackEntry>();

// Time-based cleanup every 10 minutes (more reliable than counter-based)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of callbackStore) {
    if (entry.expires < now) callbackStore.delete(key);
  }
}, 10 * 60 * 1000);

function storeCallback(data: any): string {
  const ref = crypto.randomUUID().slice(0, 8);
  callbackStore.set(ref, { data, expires: Date.now() + 300_000 }); // 5 min TTL
  return ref;
}

function getCallback(ref: string): any | null {
  const entry = callbackStore.get(ref);
  if (!entry || entry.expires < Date.now()) {
    callbackStore.delete(ref);
    return null;
  }
  return entry.data;
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

// ─── Last Active Domain (per user) ──────────────────────────────────

const lastActiveDomain = new Map<number, DomainName>();

// ─── Bot Setup ───────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.botToken);

  // ── Auth Middleware ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.telegram.allowedUserIds.includes(userId)) {
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

  // ── System Commands ──
  bot.command('start', async (ctx) => {
    await ctx.reply(
      '👋 Hey Felipe! Your command hub is online.\n\nType /help to see all available commands.',
      { parse_mode: 'HTML' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'HTML' });
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

  // ── Content Discovery ──
  bot.command('discover', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await ctx.reply('🔍 Running content discovery… this takes ~2 minutes.', { parse_mode: 'HTML' });
      // Keep typing indicator alive during the long-running discovery
      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4000);
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
        // Inline save buttons for each idea
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
        logger.error({ err }, 'Content discovery failed (manual)');
        await ctx.reply(`❌ Content discovery failed: ${escapeHtml(err.message || 'Unknown error')}`);
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
            await ctx.reply(chunk, { parse_mode: 'Markdown' });
          } catch (err) {
            if (isHtmlParseError(err)) await ctx.reply(chunk.replace(/[*_`]/g, ''));
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

async function handleDomainMessage(ctx: Context, text: string): Promise<void> {
  const systemCmd = isSystemCommand(text);
  if (systemCmd) return; // Already handled by command handlers

  try {
    await ctx.replyWithChatAction('typing');

    const route = await routeMessage(text);
    logger.info({ domain: route.domain, method: route.method, confidence: route.confidence }, 'Message routed');

    // Track last active domain for photo routing
    if (ctx.from?.id) lastActiveDomain.set(ctx.from.id, route.domain);

    const handler = DOMAIN_HANDLERS[route.domain];
    const response = await handler(route.strippedMessage);

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

    // ── Branch 1: Caption-based non-secretary domain routing (unchanged) ──
    if (caption) {
      const { keywordMatch } = require('./router/classifier');
      const domainFromCaption = keywordMatch(caption) as DomainName | null;
      const activeDomain = domainFromCaption || (userId ? lastActiveDomain.get(userId) : null);

      if (activeDomain && activeDomain !== 'secretary') {
        const handler = DOMAIN_HANDLERS[activeDomain];
        const photoContext = `[Photo attached] ${caption}`;
        const response = await handler(photoContext);
        if (userId) lastActiveDomain.set(userId, activeDomain);
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

    // Store fileId instead of base64 to reduce memory (~500KB-2MB per entry)
    const ref = storeCallback({ fileId, caption });
    const keyboard = new InlineKeyboard()
      .text('❌ Não é nota fiscal', `nf:undo:${ref}`);

    await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
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
  });

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

<b>📅 SCHEDULE</b>
/day — Today's schedule
/week — Week overview

<b>🏋️ TRIATHLON</b>
/checkin — How I feel today
/gym — Gym program
/run — Running plan
/meal — Carnivore meal plan

<b>📹 CONTENT</b>
/discover — Run daily content discovery (trending topics)
/ideas [date] — View ideas by date (default: today)
/ideas saved — View saved ideas from discovery
/video [topic] — Video ideas
/script [topic] — Write a script
/reel [topic] — Reel concepts
/caption [type] — Write caption

<b>📄 FATURAS</b>
/amazon [YYYY-MM] [--force] — Recolher faturas Amazon
/uber [YYYY-MM] [--force] — Recolher faturas Uber (viagens + Eats)

<b>🔧 SYSTEM</b>
/help — This menu
/status — Current state overview
/clear [domain] — Clear conversation history

💡 You can also just type naturally — I'll route to the right domain.`;
