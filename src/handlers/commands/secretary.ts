// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary command handlers — extracted from bot.ts Phase 3.
 *
 * Registers all MS ToDo and secretary-related bot commands:
 * /lists, /tasks, /newtask, /done, /undone, /newlist, /deletelist,
 * /deletetask, /due, /remind, /priority, /search, /todosummary,
 * /overdue, /duetoday, /dueweek, /alltasks, /completed, /movetask,
 * /edittask, /notetask, /addstep, /steps, /todo, /todos,
 * /status, /day, /week
 */

import { Bot, Context, InlineKeyboard } from 'grammy';
import { config } from '../../config';
import { storeCallback } from '../../utils/callback-store';
import { enqueue } from '../shared-state';
import {
  buildTaskListKeyboard, handleUndone, handleDeleteTask,
  handleTodoSummary, handleStatus, handleDayOverview, handleWeekOverview,
  getTelegramTaskScope, replyTaskProviderUnavailable,
} from './secretary-helpers';
import { handleDomainMessage } from '../message';
import {
  formatMsTodoLists, formatMsTodoTasks, formatMsTodoTaskCreated,
  splitMessage, escapeHtml, formatChecklistItems, formatAllTasks, formatCompletedTasks,
} from '../../utils/telegram-formatter';
import { startOfDay, endOfDay, startOfWeek, endOfWeek, formatDateTime } from '../../utils/date-parser';
import { getUserLanguage } from '../../services/user-service';
import { t } from '../../utils/i18n';
import { logger } from '../../utils/logger';
import type { DomainHandlerFn } from '../photo';

async function requireTelegramTaskScope(ctx: Context) {
  const taskScope = getTelegramTaskScope(ctx);
  if (!taskScope) {
    await replyTaskProviderUnavailable(ctx);
    return null;
  }
  return taskScope;
}

/**
 * Register all secretary / MS ToDo command handlers on the bot.
 *
 * @param bot - The Grammy bot instance
 * @param domainHandlers - The DOMAIN_HANDLERS map (injected to avoid circular deps)
 */
export function registerSecretaryCommands(
  bot: Bot,
  domainHandlers: Record<string, DomainHandlerFn>,
): void {

  // ── Microsoft To Do Commands ──

  bot.command('lists', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');
      const result = await taskScope.provider.getLists();
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch lists');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      const msg = formatMsTodoLists(result.data, getUserLanguage(ctx.from!.id));
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
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const listName = ctx.match?.trim() || config.todo.defaultList;
      const list = await taskScope.provider.findListByName(listName);
      if (!list) {
        await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found. Use /lists to see available lists.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await taskScope.provider.getTasks(list.id, list.displayName, { status: 'notStarted' });
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      const msg = formatMsTodoTasks(result.data, list.displayName, getUserLanguage(ctx.from!.id));
      const keyboard = buildTaskListKeyboard(result.data, list.id);

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
    });
  });

  bot.command('newtask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
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

      const list = await taskScope.provider.findListByName(listName);
      if (!list) {
        await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found. Use /lists to see available lists.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await taskScope.provider.createTask(list.id, list.displayName, { title });
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to create task');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      await ctx.reply(formatMsTodoTaskCreated(result.data, getUserLanguage(ctx.from!.id)), { parse_mode: 'HTML' });
    });
  });

  bot.command('done', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /done Buy coffee');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const searchResult = await taskScope.provider.searchTasks(query);
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
        const result = await taskScope.provider.completeTask(task.listId, task.id);
        if (result.success) {
          await ctx.reply(`✅ Completed: "<b>${escapeHtml(task.title)}</b>" [${escapeHtml(task.listName)}]`, { parse_mode: 'HTML' });
        } else {
          logger.warn({ err: result.error }, 'Failed to complete task');
          await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
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
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
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
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('Usage: /newlist Groceries');
        return;
      }
      await ctx.replyWithChatAction('typing');
      const result = await taskScope.provider.createList(name);
      if (result.success) {
        await ctx.reply(`📋 List created: "<b>${escapeHtml(result.data.displayName)}</b>"`, { parse_mode: 'HTML' });
      } else {
        logger.warn({ err: result.error }, 'Failed to create list');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
      }
    });
  });

  bot.command('deletelist', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const name = ctx.match?.trim();
      if (!name) {
        await ctx.reply('Usage: /deletelist Old Projects');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const list = await taskScope.provider.findListByName(name);
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
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
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
      await handleDomainMessage(ctx, `/due ${text}`, domainHandlers);
    });
  });

  bot.command('remind', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /remind Meeting prep | today 2pm');
        return;
      }
      await handleDomainMessage(ctx, `/remind ${text}`, domainHandlers);
    });
  });

  bot.command('priority', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /priority Review PR | high');
        return;
      }
      await handleDomainMessage(ctx, `/priority ${text}`, domainHandlers);
    });
  });

  bot.command('search', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /search coffee');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const result = await taskScope.provider.searchTasks(query);
      if (!result.success) {
        logger.warn({ err: result.error }, 'Search failed');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
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

      const parts = splitMessage(msg);
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('todosummary', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');
      await handleTodoSummary(ctx);
    });
  });

  // ── Extended To Do Commands ──

  bot.command('overdue', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const pendingResult = await taskScope.provider.getAllPendingTasks();
      if (!pendingResult.success) {
        logger.warn({ err: pendingResult.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
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

      const parts = splitMessage(msg.trim());
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('duetoday', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const result = await taskScope.provider.getTasksDueInRange(startOfDay(), endOfDay());
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
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

      const parts = splitMessage(msg.trim());
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('dueweek', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const result = await taskScope.provider.getTasksDueInRange(startOfWeek(), endOfWeek());
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
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
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const result = await taskScope.provider.getAllPendingTasks();
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      const msg = formatAllTasks(result.data, getUserLanguage(ctx.from!.id));
      const parts = splitMessage(msg);
      for (const part of parts) {
        await ctx.reply(part, { parse_mode: 'HTML' });
      }
    });
  });

  bot.command('completed', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const listName = ctx.match?.trim();

      if (listName) {
        // Completed tasks from a specific list
        const list = await taskScope.provider.findListByName(listName);
        if (!list) {
          await ctx.reply(`⚠️ List "${escapeHtml(listName)}" not found.`, { parse_mode: 'HTML' });
          return;
        }
        const result = await taskScope.provider.getTasks(list.id, list.displayName, { status: 'completed' });
        if (!result.success) {
          logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
          return;
        }
        const msgSpecific = formatCompletedTasks(result.data, list.displayName, getUserLanguage(ctx.from!.id));
        const partsSpecific = splitMessage(msgSpecific);
        for (const part of partsSpecific) {
          await ctx.reply(part, { parse_mode: 'HTML' });
        }
      } else {
        // Completed tasks across all lists (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const result = await taskScope.provider.getCompletedTasksInRange(sevenDaysAgo, new Date().toISOString());
        if (!result.success) {
          logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
          return;
        }
        const msgAll = formatCompletedTasks(result.data, undefined, getUserLanguage(ctx.from!.id));
        const partsAll = splitMessage(msgAll);
        for (const part of partsAll) {
          await ctx.reply(part, { parse_mode: 'HTML' });
        }
      }
    });
  });

  bot.command('movetask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /movetask Buy milk | Groceries');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, targetListName] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await taskScope.provider.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data.find((t) => t.status !== 'completed') || searchResult.data[0];

      const targetList = await taskScope.provider.findListByName(targetListName);
      if (!targetList) {
        await ctx.reply(`⚠️ List "${escapeHtml(targetListName)}" not found.`, { parse_mode: 'HTML' });
        return;
      }

      if (task.listId === targetList.id) {
        await ctx.reply(`📋 "${escapeHtml(task.title)}" is already in <b>${escapeHtml(targetList.displayName)}</b>.`, { parse_mode: 'HTML' });
        return;
      }

      const result = await taskScope.provider.moveTask(task.listId, task.id, targetList.id, targetList.displayName);
      if (result.success) {
        await ctx.reply(`📦 Moved "<b>${escapeHtml(task.title)}</b>" from ${escapeHtml(task.listName)} → <b>${escapeHtml(targetList.displayName)}</b>`, { parse_mode: 'HTML' });
      } else {
        logger.warn({ err: result.error }, 'Failed to move task');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
      }
    });
  });

  bot.command('edittask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /edittask Buy milk | Buy oat milk');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, newTitle] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await taskScope.provider.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await taskScope.provider.updateTask(task.listId, task.id, { title: newTitle });
      if (result.success) {
        await ctx.reply(`📝 Renamed: "${escapeHtml(task.title)}" → "<b>${escapeHtml(newTitle)}</b>" [${escapeHtml(task.listName)}]`, { parse_mode: 'HTML' });
      } else {
        logger.warn({ err: result.error }, 'Failed to rename task');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
      }
    });
  });

  bot.command('notetask', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /notetask Buy milk | Get the organic brand from Lidl');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, note] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await taskScope.provider.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await taskScope.provider.updateTask(task.listId, task.id, { body: note });
      if (result.success) {
        await ctx.reply(`📝 Note added to "<b>${escapeHtml(task.title)}</b>": ${escapeHtml(note)}`, { parse_mode: 'HTML' });
      } else {
        logger.warn({ err: result.error }, 'Failed to add note');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
      }
    });
  });

  bot.command('addstep', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const text = ctx.match?.trim();
      if (!text || !text.includes('|')) {
        await ctx.reply('Usage: /addstep Buy milk | Check fridge first');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const [taskQuery, stepTitle] = text.split('|', 2).map((s) => s.trim());

      const searchResult = await taskScope.provider.searchTasks(taskQuery);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(taskQuery)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await taskScope.provider.addChecklistItem(task.listId, task.id, stepTitle);
      if (result.success) {
        await ctx.reply(`☑️ Step added to "<b>${escapeHtml(task.title)}</b>": ${escapeHtml(stepTitle)}`, { parse_mode: 'HTML' });
      } else {
        logger.warn({ err: result.error }, 'Failed to add step');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
      }
    });
  });

  bot.command('steps', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('Usage: /steps Buy milk');
        return;
      }
      await ctx.replyWithChatAction('typing');

      const searchResult = await taskScope.provider.searchTasks(query);
      if (!searchResult.success || searchResult.data.length === 0) {
        await ctx.reply(`❌ No task matching "${escapeHtml(query)}" found.`, { parse_mode: 'HTML' });
        return;
      }

      const task = searchResult.data[0];
      const result = await taskScope.provider.getChecklistItems(task.listId, task.id);
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch steps');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      await ctx.reply(formatChecklistItems(result.data, task.title, getUserLanguage(ctx.from!.id)), { parse_mode: 'HTML' });
    });
  });

  // Legacy commands that route to secretary domain for MS Todo handling
  bot.command('todo', async (ctx) => {
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply('Usage: /todo Buy new running shoes\nor: /newtask Work | Review PR');
      return;
    }
    enqueue(ctx.from!.id, async () => {
      await handleDomainMessage(ctx, `/todo ${text}`, domainHandlers);
    });
  });

  bot.command('todos', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      const taskScope = await requireTelegramTaskScope(ctx);
      if (!taskScope) return;
      await ctx.replyWithChatAction('typing');

      const defaultList = await taskScope.provider.getDefaultList();
      if (!defaultList) {
        await ctx.reply('⚠️ Default list not found. Use /lists to see available lists.');
        return;
      }

      const result = await taskScope.provider.getTasks(defaultList.id, defaultList.displayName, { status: 'notStarted' });
      if (!result.success) {
        logger.warn({ err: result.error }, 'Failed to fetch tasks');
        await ctx.reply(t('generic_error', getUserLanguage(ctx.from!.id)));
        return;
      }

      const msg = formatMsTodoTasks(result.data, defaultList.displayName, getUserLanguage(ctx.from!.id));
      const keyboard = buildTaskListKeyboard(result.data, defaultList.id);

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: keyboard.inline_keyboard.length > 0 ? keyboard : undefined,
      });
    });
  });

  // ── Status & Overview Commands ──

  bot.command('status', async (ctx) => {
    enqueue(ctx.from!.id, async () => {
      await ctx.replyWithChatAction('typing');
      await handleStatus(ctx);
    });
  });

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
}
