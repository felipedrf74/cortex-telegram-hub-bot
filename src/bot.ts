import { Bot, Context, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { config } from './config';
import { logger } from './utils/logger';
import { routeMessage, isSystemCommand } from './router';
import { DomainName } from './domains/types';
import { handleSecretary } from './domains/secretary';
import { handleTriathlon } from './domains/triathlon';
import { handleContent } from './domains/content-creator';
import { handleQlikSense } from './domains/qliksense';
import { handleAws } from './domains/aws-expert';
import { getActiveReminders } from './state/reminders';
import { clearConversation, clearAllConversations } from './state/conversation';
import {
  formatMsTodoLists, formatMsTodoTasks, formatMsTodoTaskCreated, formatMsTodoSummary,
  formatReminders, splitMessage, escapeHtml,
  formatChecklistItems, formatAllTasks, formatCompletedTasks,
} from './utils/telegram-formatter';
import * as msTodo from './services/microsoft-todo';
import { getEvents, isAnyCalendarConfigured } from './services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount as getOutlookUnread } from './services/outlook-mail';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, now, formatTime, formatDateTime } from './utils/date-parser';
import { extractImageContent } from './services/anthropic';
import { runContentDiscovery } from './services/content-discovery';

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
  qliksense: handleQlikSense,
  aws: handleAws,
};

// ─── Processing Queue (sequential per user) ─────────────────────────

const processingQueue = new Map<number, Promise<void>>();

function enqueue(userId: number, fn: () => Promise<void>): void {
  const prev = processingQueue.get(userId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  processingQueue.set(userId, next);
}

// ─── Inline Keyboard Callback Store ─────────────────────────────────

interface CallbackEntry {
  data: any;
  expires: number;
}

const callbackStore = new Map<string, CallbackEntry>();
let callbackCounter = 0;

function storeCallback(data: any): string {
  // Cleanup expired entries periodically
  if (callbackCounter % 50 === 0) {
    const now = Date.now();
    for (const [key, entry] of callbackStore) {
      if (entry.expires < now) callbackStore.delete(key);
    }
  }

  const ref = `${++callbackCounter}`;
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
    await handleStatus(ctx);
  });

  bot.command('clear', async (ctx) => {
    const domain = ctx.match?.trim();
    if (domain && ['secretary', 'triathlon', 'content', 'qliksense', 'aws'].includes(domain)) {
      clearConversation(domain as DomainName);
      await ctx.reply(`🗑 Cleared conversation history for <b>${domain}</b>.`, { parse_mode: 'HTML' });
    } else if (domain === 'all') {
      clearAllConversations();
      await ctx.reply('🗑 Cleared all conversation histories.', { parse_mode: 'HTML' });
    } else {
      await ctx.reply('Usage: /clear [secretary|triathlon|content|qliksense|aws|all]');
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
    await handleDayOverview(ctx);
  });

  bot.command('week', async (ctx) => {
    await handleWeekOverview(ctx);
  });

  // ── Content Discovery ──
  bot.command('discover', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await ctx.reply('🔍 Running content discovery… this takes ~2 minutes.', { parse_mode: 'HTML' });
      try {
        const result = await runContentDiscovery();
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
      } catch (err: any) {
        logger.error({ err }, 'Content discovery failed (manual)');
        await ctx.reply(`❌ Content discovery failed: ${escapeHtml(err.message || 'Unknown error')}`);
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
        // Edit field — prompt user to type
        const field = cbData.field;
        const fieldLabels: Record<string, string> = {
          title: 'new title',
          due: 'due date (e.g., "tomorrow 5pm")',
          reminder: 'reminder time (e.g., "today 2pm")',
          priority: 'priority (low, normal, or high)',
        };
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

  // ── Photo handler: Vision → Task creation ──
  bot.on('message:photo', async (ctx) => {
    enqueue(ctx.from.id, async () => {
      await handlePhotoMessage(ctx);
    });
  });

  // ── Catch-all: Route to domain ──
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (!text) return;

    enqueue(ctx.from.id, async () => {
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

    const handler = DOMAIN_HANDLERS[route.domain];
    const response = await handler(route.strippedMessage);

    const parts = splitMessage(response.text);
    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'HTML' });
      } catch {
        // Fallback: send without HTML if formatting fails
        await ctx.reply(part.replace(/<[^>]*>/g, ''));
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to handle domain message');
    await ctx.reply('⚠️ Something went wrong processing your message. Please try again.');
  }
}

async function handlePhotoMessage(ctx: Context): Promise<void> {
  if (!msTodo.isOutlookTodoConfigured()) {
    await ctx.reply('📷 Photo received, but Microsoft To Do is not configured.');
    return;
  }

  try {
    await ctx.replyWithChatAction('typing');
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    // Get largest photo (last in array)
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;

    // Download image as buffer
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString('base64');
    const ext = file.file_path?.split('.').pop()?.toLowerCase() || 'jpg';
    const mediaType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

    const caption = ctx.message?.caption || '';
    logger.info({ caption, fileSize: buffer.length }, 'Processing photo for task extraction');

    // Use Haiku vision to extract task info (cheap!)
    const extracted = await extractImageContent(base64, mediaType as any, caption || undefined);

    if (!extracted.title) {
      await ctx.reply('📷 I couldn\'t extract any tasks from this image. Try adding a caption describing what to create.');
      return;
    }

    // Determine which list to use
    let targetList: msTodo.TodoList | null = null;
    if (extracted.listHint) {
      targetList = await msTodo.findListByName(extracted.listHint);
    }
    if (!targetList) {
      targetList = await msTodo.getDefaultList();
    }
    if (!targetList) {
      const lists = await msTodo.getLists();
      if (lists.success && lists.data.length > 0) {
        targetList = lists.data[0];
      }
    }

    if (!targetList) {
      await ctx.reply('⚠️ No task list found. Please create a list first.');
      return;
    }

    // Create the main task
    const taskResult = await msTodo.createTask(targetList.id, targetList.displayName, {
      title: extracted.title,
    });

    if (!taskResult.success) {
      await ctx.reply(`⚠️ Failed to create task: ${taskResult.error}`);
      return;
    }

    // Add subtasks as checklist items
    let addedSubtasks = 0;
    if (extracted.subtasks.length > 0) {
      for (const sub of extracted.subtasks) {
        const subResult = await msTodo.addChecklistItem(targetList.id, taskResult.data.id, sub);
        if (subResult.success) addedSubtasks++;
      }
    }

    // Format response
    let msg = `📷✅ Task created from image:\n\n<b>${escapeHtml(extracted.title)}</b>\n📋 List: ${escapeHtml(targetList.displayName)}`;
    if (addedSubtasks > 0) {
      msg += `\n\n📝 ${addedSubtasks} subtask${addedSubtasks > 1 ? 's' : ''} added:`;
      for (const sub of extracted.subtasks.slice(0, addedSubtasks)) {
        msg += `\n  ⬜ ${escapeHtml(sub)}`;
      }
    }

    await ctx.reply(msg, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err }, 'Failed to process photo message');
    await ctx.reply('⚠️ Failed to process the image. Please try again.');
  }
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

async function handleTodoSummary(ctx: Context): Promise<void> {
  const pendingResult = await msTodo.getAllPendingTasks();
  if (!pendingResult.success) {
    await ctx.reply(`⚠️ Failed to fetch tasks: ${pendingResult.error}`);
    return;
  }

  const pending = pendingResult.data;
  const nowDate = new Date();
  const overdue = pending.filter((t) => t.dueDateTime && new Date(t.dueDateTime) < nowDate);
  const highPriority = pending.filter((t) => t.importance === 'high');

  const dueTodayResult = await msTodo.getTasksDueInRange(startOfDay(), endOfDay());
  const dueToday = dueTodayResult.success ? dueTodayResult.data : [];

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
    } catch {
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
    } catch {
      msg += '📅 Calendar: unavailable\n';
    }
  } else {
    msg += '📅 Calendar: not configured\n';
  }

  if (isOutlookMailConfigured()) {
    try {
      const unread = await getOutlookUnread();
      msg += `📧 Outlook unread: ${unread}\n`;
    } catch {
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
    } catch {
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
    } catch {
      // skip
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
    } catch {
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
    } catch {
      // skip
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
/video [topic] — Video ideas
/script [topic] — Write a script
/reel [topic] — Reel concepts
/caption [type] — Write caption

<b>📊 QLIK SENSE</b>
/set [desc] — Build Set Analysis
/expression [calc] — Create expression
/datamodel [desc] — Design data model

<b>☁️ AWS / DEVOPS</b>
/aws [question] — AWS help
/terraform [resource] — Terraform code
/docker [app] — Docker setup
/pipeline [tool] — CI/CD pipeline

<b>🔧 SYSTEM</b>
/help — This menu
/status — Current state overview
/clear [domain] — Clear conversation history

💡 You can also just type naturally — I'll route to the right domain.`;
