// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Secretary domain helper handlers — extracted from bot.ts Phase 2.
 *
 * Contains: task keyboard builder, undo/delete/edit task handlers,
 * todo summary, status overview, day/week overview.
 */

import { Context, InlineKeyboard } from 'grammy';
import { storeCallback } from '../../utils/callback-store';
import { logger } from '../../utils/logger';
import * as msTodo from '../../services/microsoft-todo';
import { getActiveReminders } from '../../state/reminders';
import { getEvents, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount as getOutlookUnread } from '../../services/outlook-mail';
import {
  formatMsTodoSummary, splitMessage, escapeHtml,
} from '../../utils/telegram-formatter';
import {
  startOfDay, endOfDay, startOfWeek, endOfWeek,
  now, formatTime, formatDateTime, parseNaturalDate,
} from '../../utils/date-parser';
import { pendingEdits, type PendingEdit } from '../shared-state';

// ── Task List Keyboard ────────────────────────────────────────────

export function buildTaskListKeyboard(tasks: msTodo.TodoTask[], listId: string): InlineKeyboard {
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

// ── Task Action Handlers ──────────────────────────────────────────

export async function handleUndone(ctx: Context, query: string): Promise<void> {
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

export async function handleDeleteTask(ctx: Context, query: string): Promise<void> {
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

export async function handlePendingEdit(ctx: Context, pending: PendingEdit, value: string): Promise<void> {
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

// ── Summary / Overview Handlers ───────────────────────────────────

export async function handleTodoSummary(ctx: Context): Promise<void> {
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

export async function handleStatus(ctx: Context): Promise<void> {
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

  const reminders = getActiveReminders(ctx.from?.id ?? 0);
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

export async function handleDayOverview(ctx: Context): Promise<void> {
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

export async function handleWeekOverview(ctx: Context): Promise<void> {
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
