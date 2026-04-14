// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic fast-path for the iOS chat endpoint.
 *
 * Token-zero principle: data-lookup actions MUST NEVER hit the AI pipeline.
 * This module intercepts known quick-action commands and answers them by
 * calling the underlying services directly, then returns formatted text
 * the iOS chat view renders natively.
 *
 * If the action isn't recognized, returns null and the caller falls through
 * to the AI router for free-form questions or AI-only operations.
 */

import * as msTodo from '../../services/microsoft-todo';
import { getEvents, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { isOutlookMailConfigured, getUnreadCount as getOutlookUnread } from '../../services/outlook-mail';
import { getActiveReminders } from '../../state/reminders';
import {
  formatMsTodoLists,
  formatMsTodoTasks,
  formatMsTodoSummary,
  formatAllTasks,
  splitMessage,
  escapeHtml,
} from '../../utils/telegram-formatter';
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  now,
  formatTime,
  formatDate,
  formatDateTime,
} from '../../utils/date-parser';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';
import { getUserLanguage } from '../../services/user-service';
import type { InlineButton } from '../../adapters/message-adapter';
import {
  buildListSelectionButtons,
  buildSecretaryQuickActionButtons,
  buildTaskActionButtons,
  labelsForLanguage,
} from './chat-inline-buttons';

// MS Graph getAllPendingTasks() takes ~10-12s. Cache the raw result so the
// second command in a session reuses it instead of paying the latency twice.
// Short TTL keeps the data fresh enough that completed/created tasks show up
// quickly when the user mutates them via the dashboard or task views.
const PENDING_TASKS_TTL = 60; // seconds

function getPendingTasksCacheKey(): string {
  try {
    const { getCurrentContext } = require('../../utils/request-context');
    const uid = getCurrentContext()?.userId;
    return uid ? `u:${uid}:fastpath:pending-tasks` : 'fastpath:pending-tasks';
  } catch { return 'fastpath:pending-tasks'; }
}

async function getPendingTasksCached(): Promise<msTodo.ServiceResult<msTodo.TodoTask[]>> {
  const key = getPendingTasksCacheKey();
  const cached = getCached<msTodo.TodoTask[]>(key);
  if (cached) {
    return { success: true, data: cached };
  }
  const result = await msTodo.getAllPendingTasks();
  if (result.success) {
    setCache(key, result.data, PENDING_TASKS_TTL);
  }
  return result;
}

export interface FastPathResult {
  text: string;
  domain: 'secretary';
  buttons?: InlineButton[][];
}

function getFastPathLabels(userId?: number): ReturnType<typeof labelsForLanguage> {
  try {
    return labelsForLanguage(getUserLanguage(userId ?? 0));
  } catch (err) {
    logger.debug({ err, userId }, 'fast-path language lookup unavailable, falling back to English labels');
    return labelsForLanguage('en-US');
  }
}

/**
 * Try to handle a chat message via the deterministic fast-path.
 *
 * Returns null if the message:
 *   - is not a slash command, OR
 *   - is a slash command that requires AI parsing (e.g. /todo Buy milk, /due X | tomorrow)
 *
 * Returns formatted text if the message is a recognized data-lookup command.
 */
export async function tryDeterministicChatCommand(
  text: string,
  userId?: number,
): Promise<FastPathResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const labels = getFastPathLabels(userId);

  // Split into command + remainder
  const spaceIdx = trimmed.indexOf(' ');
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  try {
    switch (cmd) {
      // ── Bare task list commands (no args means "show me my tasks") ──
      case '/todo':
      case '/todos':
      case '/tasks':
        // If user passes args, the AI handler should parse it (create task etc.)
        if (args) return null;
        return await handleTodos(labels);

      case '/lists':
        return await handleLists(labels);

      case '/duetoday':
      case '/due_today':
        return await handleDueToday(labels);

      case '/overdue':
        return await handleOverdue(labels);

      case '/dueweek':
      case '/due_week':
        return await handleDueWeek(labels);

      case '/alltasks':
      case '/all_tasks':
        return await handleAllTasks(labels);

      case '/todosummary':
      case '/todo_summary':
        return await handleTodoSummary(labels);

      case '/day':
      case '/today':
        return await handleDayOverview(labels);

      case '/week':
        return await handleWeekOverview(labels);

      case '/status':
        return await handleStatus(labels);

      default:
        return null;
    }
  } catch (err) {
    logger.warn({ err, cmd }, 'fast-path command failed, falling back to AI');
    return null;
  }
}

// ── Handlers (mirror the Telegram bot's deterministic command handlers) ──

async function handleTodos(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const defaultList = await msTodo.getDefaultList();
  if (!defaultList) {
    return { text: '⚠️ Default list not found. Use /lists to see available lists.', domain: 'secretary' };
  }

  const result = await msTodo.getTasks(defaultList.id, defaultList.displayName, { status: 'notStarted' });
  if (!result.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(result.error || 'unknown error')}`, domain: 'secretary' };
  }

  return {
    text: formatMsTodoTasks(result.data, defaultList.displayName),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleLists(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const result = await msTodo.getLists();
  if (!result.success) {
    return { text: `⚠️ Failed to fetch lists: ${escapeHtml(result.error || 'unknown error')}`, domain: 'secretary' };
  }

  return {
    text: formatMsTodoLists(result.data),
    domain: 'secretary',
    buttons: buildListSelectionButtons(result.data, labels),
  };
}

async function handleDueToday(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  // Use date-portion comparison in the configured timezone to avoid MS Graph
  // timezone ambiguity (their dueDateTime is stored as a naked datetime).
  const tasksResult = await getPendingTasksCached();
  if (!tasksResult.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(tasksResult.error || 'unknown error')}`, domain: 'secretary' };
  }

  const todayStr = nowDateInTimezone();
  const dueToday = tasksResult.data.filter((t) => {
    const dueStr = dueDateInTimezone(t.dueDateTime);
    return dueStr === todayStr;
  });

  if (dueToday.length === 0) {
    return { text: '📅 No tasks due today.', domain: 'secretary' };
  }

  let msg = `<b>📅 Due Today (${dueToday.length})</b>\n\n`;
  for (const t of dueToday) {
    const imp = t.importance !== 'normal' ? ` ${t.importance === 'high' ? '🔴' : '🟢'}` : '';
    msg += `⬜${imp} ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildTaskActionButtons(dueToday, labels),
  };
}

async function handleOverdue(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const tasksResult = await getPendingTasksCached();
  if (!tasksResult.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(tasksResult.error || 'unknown error')}`, domain: 'secretary' };
  }

  const todayStr = nowDateInTimezone();
  const overdue = tasksResult.data.filter((t) => {
    const dueStr = dueDateInTimezone(t.dueDateTime);
    return dueStr !== null && dueStr < todayStr;
  });

  if (overdue.length === 0) {
    return { text: "✅ No overdue tasks. You're on track!", domain: 'secretary' };
  }

  let msg = `<b>⚠️ Overdue Tasks (${overdue.length})</b>\n\n`;
  for (const t of overdue) {
    msg += `⚠️ ${escapeHtml(t.title)} — was due ${formatDate(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildTaskActionButtons(overdue, labels),
  };
}

async function handleDueWeek(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const result = await msTodo.getTasksDueInRange(startOfWeek(), endOfWeek());
  if (!result.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(result.error || 'unknown error')}`, domain: 'secretary' };
  }

  if (result.data.length === 0) {
    return { text: '📅 No tasks due this week.', domain: 'secretary' };
  }

  let msg = `<b>📅 Due This Week (${result.data.length})</b>\n\n`;
  for (const t of result.data) {
    const imp = t.importance !== 'normal' ? ` ${t.importance === 'high' ? '🔴' : '🟢'}` : '';
    msg += `⬜${imp} ${escapeHtml(t.title)} — due ${formatDateTime(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleAllTasks(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const result = await getPendingTasksCached();
  if (!result.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(result.error || 'unknown error')}`, domain: 'secretary' };
  }

  return {
    text: formatAllTasks(result.data),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleTodoSummary(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult | null> {
  if (!msTodo.isOutlookTodoConfigured()) return null;

  const pendingResult = await getPendingTasksCached();
  if (!pendingResult.success) {
    return { text: `⚠️ Failed to fetch tasks: ${escapeHtml(pendingResult.error || 'unknown error')}`, domain: 'secretary' };
  }

  const pending = pendingResult.data;
  const todayStr = nowDateInTimezone();

  const overdue = pending.filter((t) => {
    const dueStr = dueDateInTimezone(t.dueDateTime);
    return dueStr !== null && dueStr < todayStr;
  });
  const dueToday = pending.filter((t) => dueDateInTimezone(t.dueDateTime) === todayStr);
  const highPriority = pending.filter((t) => t.importance === 'high');

  return {
    text: formatMsTodoSummary({
      pendingCount: pending.length,
      overdueCount: overdue.length,
      dueTodayCount: dueToday.length,
      highPriorityCount: highPriority.length,
      overdueTasks: overdue,
      dueTodayTasks: dueToday,
    }),
    domain: 'secretary',
    buttons: buildSecretaryQuickActionButtons(labels),
  };
}

async function handleDayOverview(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult> {
  let msg = `<b>📅 ${now().toFormat('cccc, LLLL dd yyyy')}</b>\n\n`;

  // Calendar events today
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
      logger.warn({ err }, 'fast-path day overview: calendar fetch failed');
      msg += 'Calendar unavailable.\n';
    }
  }

  // MS Todo — due today (timezone-aware)
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const pendingResult = await getPendingTasksCached();
      if (pendingResult.success) {
        const todayStr = nowDateInTimezone();
        const dueToday = pendingResult.data.filter((t) => dueDateInTimezone(t.dueDateTime) === todayStr);
        if (dueToday.length > 0) {
          msg += `\n📋 Due today (${dueToday.length}):\n`;
          for (const t of dueToday) {
            msg += `- ${escapeHtml(t.title)} <i>[${escapeHtml(t.listName)}]</i>\n`;
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'fast-path day overview: todo fetch failed');
    }
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildSecretaryQuickActionButtons(labels),
  };
}

async function handleWeekOverview(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult> {
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
      logger.warn({ err }, 'fast-path week overview: calendar fetch failed');
      msg += 'Calendar unavailable.\n';
    }
  }

  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const pendingResult = await getPendingTasksCached();
      if (pendingResult.success && pendingResult.data.length > 0) {
        msg += `\n📋 Pending tasks: ${pendingResult.data.length}\n`;
      }
    } catch (err) {
      logger.warn({ err }, 'fast-path week overview: todo fetch failed');
    }
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildSecretaryQuickActionButtons(labels),
  };
}

async function handleStatus(labels: ReturnType<typeof labelsForLanguage>): Promise<FastPathResult> {
  let msg = '<b>📊 Status Overview</b>\n\n';

  // Microsoft To Do
  if (msTodo.isOutlookTodoConfigured()) {
    try {
      const pendingResult = await getPendingTasksCached();
      if (pendingResult.success) {
        const highPriority = pendingResult.data.filter((t) => t.importance === 'high');
        msg += `📋 Microsoft To Do: ${pendingResult.data.length} pending tasks\n`;
        if (highPriority.length > 0) {
          msg += `🔴 High priority: ${highPriority.length}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'fast-path status: todo fetch failed');
      msg += '📋 Microsoft To Do: unavailable\n';
    }
  } else {
    msg += '📋 Microsoft To Do: not configured\n';
  }

  const reminders = getActiveReminders(0);
  msg += `⏰ Active reminders: ${reminders.length}\n`;

  if (isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay());
      msg += `📅 Events today: ${events.length}\n`;
    } catch (err) {
      logger.warn({ err }, 'fast-path status: calendar fetch failed');
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
      logger.warn({ err }, 'fast-path status: outlook unread failed');
      msg += '📧 Outlook: unavailable\n';
    }
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildSecretaryQuickActionButtons(labels),
  };
}

// ── Timezone helpers ────────────────────────────────────────────────
//
// MS Graph stores task due dates as naked datetimes (no Z, no offset). We need
// to compare them by date-only in the configured timezone (Europe/Lisbon) so
// that "due April 6" tasks aren't classified as overdue when the user is on
// April 6 just because the underlying ISO string happens to start with "April 5".

function nowDateInTimezone(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: config.app.timezone });
}

function dueDateInTimezone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return new Date(raw).toLocaleDateString('en-CA', { timeZone: config.app.timezone });
}
