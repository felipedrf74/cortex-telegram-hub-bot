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
import { getEvents, hasConnectedCalendarForUser, isAnyCalendarConfigured } from '../../services/unified-calendar';
import { getActiveReminders } from '../../state/reminders';
import { getTaskProviderForUser } from '../../services/task-store/task-router';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../../services/unified-mail-pressure';
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

type FastPathTaskProvider = {
  getDefaultList: typeof msTodo.getDefaultList;
  getTasks: typeof msTodo.getTasks;
  getLists: typeof msTodo.getLists;
  getAllPendingTasks: typeof msTodo.getAllPendingTasks;
  getTasksDueInRange: typeof msTodo.getTasksDueInRange;
};

function getPendingTasksCacheKey(userId?: number): string {
  if (userId != null) {
    return `u:${userId}:fastpath:pending-tasks`;
  }
  try {
    const { getCurrentContext } = require('../../utils/request-context');
    const uid = getCurrentContext()?.userId;
    return uid ? `u:${uid}:fastpath:pending-tasks` : 'fastpath:pending-tasks';
  } catch { return 'fastpath:pending-tasks'; }
}

function getFastPathTaskProvider(userId?: number): FastPathTaskProvider | null {
  if (userId != null) {
    return getTaskProviderForUser(userId);
  }
  if (!msTodo.isOutlookTodoConfigured()) {
    return null;
  }
  return msTodo;
}

async function getPendingTasksCached(
  taskProvider: FastPathTaskProvider,
  userId?: number,
): Promise<msTodo.ServiceResult<msTodo.TodoTask[]>> {
  const key = getPendingTasksCacheKey(userId);
  const cached = getCached<msTodo.TodoTask[]>(key);
  if (cached) {
    return { success: true, data: cached };
  }
  const result = await taskProvider.getAllPendingTasks();
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
  if (userId == null) {
    return labelsForLanguage('en-US');
  }
  try {
    return labelsForLanguage(getUserLanguage(userId));
  } catch (err) {
    logger.debug({ err, userId }, 'fast-path language lookup unavailable, falling back to English labels');
    return labelsForLanguage('en-US');
  }
}

function getFastPathLanguage(userId?: number): string {
  if (userId == null) {
    return 'en-US';
  }
  try {
    return getUserLanguage(userId);
  } catch (err) {
    logger.debug({ err, userId }, 'fast-path language lookup unavailable, falling back to English copy');
    return 'en-US';
  }
}

function fastPathCopy(userId: number | undefined, pt: string, en: string): string {
  return getFastPathLanguage(userId).toLowerCase().startsWith('pt') ? pt : en;
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
        return await handleTodos(labels, userId);

      case '/lists':
        return await handleLists(labels, userId);

      case '/duetoday':
      case '/due_today':
        return await handleDueToday(labels, userId);

      case '/overdue':
        return await handleOverdue(labels, userId);

      case '/dueweek':
      case '/due_week':
        return await handleDueWeek(labels, userId);

      case '/alltasks':
      case '/all_tasks':
        return await handleAllTasks(labels, userId);

      case '/todosummary':
      case '/todo_summary':
        return await handleTodoSummary(labels, userId);

      case '/day':
      case '/today':
        return await handleDayOverview(labels, userId);

      case '/week':
        return await handleWeekOverview(labels, userId);

      case '/status':
        return await handleStatus(labels, userId);

      default:
        return null;
    }
  } catch (err) {
    logger.warn({ err, cmd }, 'fast-path command failed, falling back to AI');
    return null;
  }
}

// ── Handlers (mirror the Telegram bot's deterministic command handlers) ──

async function handleTodos(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const defaultList = await taskProvider.getDefaultList();
  if (!defaultList) {
    return { text: copy('⚠️ Lista predefinida não encontrada. Usa /lists para ver as listas disponíveis.', '⚠️ Default list not found. Use /lists to see available lists.'), domain: 'secretary' };
  }

  const result = await taskProvider.getTasks(defaultList.id, defaultList.displayName, { status: 'notStarted' });
  if (!result.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(result.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  return {
    text: formatMsTodoTasks(result.data, defaultList.displayName, getFastPathLanguage(userId)),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleLists(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const result = await taskProvider.getLists();
  if (!result.success) {
    return { text: `⚠️ ${copy('Falha ao obter listas', 'Failed to fetch lists')}: ${escapeHtml(result.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  return {
    text: formatMsTodoLists(result.data, getFastPathLanguage(userId)),
    domain: 'secretary',
    buttons: buildListSelectionButtons(result.data, labels),
  };
}

async function handleDueToday(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  // Use date-portion comparison in the configured timezone to avoid MS Graph
  // timezone ambiguity (their dueDateTime is stored as a naked datetime).
  const tasksResult = await getPendingTasksCached(taskProvider, userId);
  if (!tasksResult.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(tasksResult.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  const todayStr = nowDateInTimezone();
  const dueToday = tasksResult.data.filter((t) => {
    const dueStr = dueDateInTimezone(t.dueDateTime);
    return dueStr === todayStr;
  });

  if (dueToday.length === 0) {
    return { text: copy('📅 Sem tarefas para hoje.', '📅 No tasks due today.'), domain: 'secretary' };
  }

  let msg = `${copy(`<b>📅 Para hoje (${dueToday.length})</b>`, `<b>📅 Due Today (${dueToday.length})</b>`)}\n\n`;
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

async function handleOverdue(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const tasksResult = await getPendingTasksCached(taskProvider, userId);
  if (!tasksResult.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(tasksResult.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  const todayStr = nowDateInTimezone();
  const overdue = tasksResult.data.filter((t) => {
    const dueStr = dueDateInTimezone(t.dueDateTime);
    return dueStr !== null && dueStr < todayStr;
  });

  if (overdue.length === 0) {
    return { text: copy('✅ Sem tarefas atrasadas. Está tudo em dia!', "✅ No overdue tasks. You're on track!"), domain: 'secretary' };
  }

  let msg = `${copy(`<b>⚠️ Tarefas atrasadas (${overdue.length})</b>`, `<b>⚠️ Overdue Tasks (${overdue.length})</b>`)}\n\n`;
  for (const t of overdue) {
    msg += `⚠️ ${escapeHtml(t.title)} — ${copy('estava prevista para', 'was due')} ${formatDate(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildTaskActionButtons(overdue, labels),
  };
}

async function handleDueWeek(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const result = await taskProvider.getTasksDueInRange(startOfWeek(), endOfWeek());
  if (!result.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(result.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  if (result.data.length === 0) {
    return { text: copy('📅 Sem tarefas previstas para esta semana.', '📅 No tasks due this week.'), domain: 'secretary' };
  }

  let msg = `${copy(`<b>📅 Esta semana (${result.data.length})</b>`, `<b>📅 Due This Week (${result.data.length})</b>`)}\n\n`;
  for (const t of result.data) {
    const imp = t.importance !== 'normal' ? ` ${t.importance === 'high' ? '🔴' : '🟢'}` : '';
    msg += `⬜${imp} ${escapeHtml(t.title)} — ${copy('vence', 'due')} ${formatDateTime(t.dueDateTime!)} <i>[${escapeHtml(t.listName)}]</i>\n`;
  }

  return {
    text: msg.trim(),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleAllTasks(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const result = await getPendingTasksCached(taskProvider, userId);
  if (!result.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(result.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  return {
    text: formatAllTasks(result.data, getFastPathLanguage(userId)),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels),
  };
}

async function handleTodoSummary(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const pendingResult = await getPendingTasksCached(taskProvider, userId);
  if (!pendingResult.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(pendingResult.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
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
    }, getFastPathLanguage(userId)),
    domain: 'secretary',
    buttons: buildSecretaryQuickActionButtons(labels),
  };
}

async function handleDayOverview(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult> {
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);
  let msg = `<b>📅 ${now().toFormat('cccc, LLLL dd yyyy')}</b>\n\n`;

  // Calendar events today
  if (userId != null ? hasConnectedCalendarForUser(userId) : isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay(), userId);
      if (events.length === 0) {
        msg += `${copy('Sem eventos agendados para hoje.', 'No events scheduled today.')}\n`;
      } else {
        for (const e of events) {
          const src = (e as any).source === 'outlook' ? ' 📧' : '';
          msg += `${formatTime(e.start)} - ${formatTime(e.end)}  ${escapeHtml(e.summary)}${src}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'fast-path day overview: calendar fetch failed');
      msg += `${copy('Calendário indisponível.', 'Calendar unavailable.')}\n`;
    }
  }

  // MS Todo — due today (timezone-aware)
  const taskProvider = getFastPathTaskProvider(userId);
  if (taskProvider) {
    try {
      const pendingResult = await getPendingTasksCached(taskProvider, userId);
      if (pendingResult.success) {
        const todayStr = nowDateInTimezone();
        const dueToday = pendingResult.data.filter((t) => dueDateInTimezone(t.dueDateTime) === todayStr);
        if (dueToday.length > 0) {
          msg += `\n${copy(`📋 Para hoje (${dueToday.length}):`, `📋 Due today (${dueToday.length}):`)}\n`;
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

async function handleWeekOverview(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult> {
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);
  let msg = `${copy('<b>📅 Vista da semana</b>', '<b>📅 Week Overview</b>')}\n`;
  msg += `${now().startOf('week').toFormat('LLL dd')} - ${now().endOf('week').toFormat('LLL dd yyyy')}\n\n`;

  if (userId != null ? hasConnectedCalendarForUser(userId) : isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfWeek(), endOfWeek(), userId);
      if (events.length === 0) {
        msg += `${copy('Sem eventos esta semana.', 'No events this week.')}\n`;
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
      msg += `${copy('Calendário indisponível.', 'Calendar unavailable.')}\n`;
    }
  }

  const taskProvider = getFastPathTaskProvider(userId);
  if (taskProvider) {
    try {
      const pendingResult = await getPendingTasksCached(taskProvider, userId);
      if (pendingResult.success && pendingResult.data.length > 0) {
        msg += `\n${copy(`📋 Tarefas pendentes: ${pendingResult.data.length}`, `📋 Pending tasks: ${pendingResult.data.length}`)}\n`;
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

async function handleStatus(labels: ReturnType<typeof labelsForLanguage>, userId?: number): Promise<FastPathResult> {
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);
  let msg = `${copy('<b>📊 Estado geral</b>', '<b>📊 Status Overview</b>')}\n\n`;

  // Microsoft To Do
  const taskProvider = getFastPathTaskProvider(userId);
  if (taskProvider) {
    try {
      const pendingResult = await getPendingTasksCached(taskProvider, userId);
      if (pendingResult.success) {
        const highPriority = pendingResult.data.filter((t) => t.importance === 'high');
        msg += `📋 Microsoft To Do: ${copy(`${pendingResult.data.length} tarefas pendentes`, `${pendingResult.data.length} pending tasks`)}\n`;
        if (highPriority.length > 0) {
          msg += `${copy(`🔴 Alta prioridade: ${highPriority.length}`, `🔴 High priority: ${highPriority.length}`)}\n`;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'fast-path status: todo fetch failed');
      msg += `${copy('📋 Microsoft To Do: indisponível', '📋 Microsoft To Do: unavailable')}\n`;
    }
  } else {
    msg += `${copy('📋 Microsoft To Do: não configurado', '📋 Microsoft To Do: not configured')}\n`;
  }

  const reminders = userId != null ? getActiveReminders(userId) : [];
  msg += `${copy(`⏰ Lembretes ativos: ${reminders.length}`, `⏰ Active reminders: ${reminders.length}`)}\n`;

  if (userId != null ? hasConnectedCalendarForUser(userId) : isAnyCalendarConfigured()) {
    try {
      const events = await getEvents(startOfDay(), endOfDay(), userId);
      msg += `${copy(`📅 Eventos hoje: ${events.length}`, `📅 Events today: ${events.length}`)}\n`;
    } catch (err) {
      logger.warn({ err }, 'fast-path status: calendar fetch failed');
      msg += `${copy('📅 Calendário: indisponível', '📅 Calendar: unavailable')}\n`;
    }
  } else {
    msg += `${copy('📅 Calendário: não configurado', '📅 Calendar: not configured')}\n`;
  }

  if (userId != null && isAnyMailConfiguredForUser(userId)) {
    try {
      const unread = await getUnreadMailSummaryForUser(userId);
      const providerBreakdown = [
        unread.outlookUnread != null ? `Outlook ${unread.outlookUnread}` : null,
        unread.gmailUnread != null ? `Gmail ${unread.gmailUnread}` : null,
      ].filter(Boolean).join(' | ');
      msg += `${copy(`📧 Inbox por ler: ${unread.totalUnread}`, `📧 Inbox unread: ${unread.totalUnread}`)}${providerBreakdown ? ` (${providerBreakdown})` : ''}\n`;
    } catch (err) {
      logger.warn({ err }, 'fast-path status: unified mail unread failed');
      msg += `${copy('📧 Inbox: indisponível', '📧 Inbox: unavailable')}\n`;
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
