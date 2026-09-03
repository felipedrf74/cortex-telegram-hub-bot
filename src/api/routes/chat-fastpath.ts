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
import { getTaskProviderForUser } from '../../services/task-store/task-router';
import {
  getProviderAwarePendingTodoTasks,
  getProviderAwareTodoTasksDueInRange,
} from '../../services/task-store/provider-aware-read-model';
import {
  formatMsTodoLists,
  formatMsTodoTasks,
  formatMsTodoSummary,
  formatAllTasks,
  splitMessage,
  escapeHtml,
} from '../../utils/chat-html-formatter';
import {
  startOfWeek,
  endOfWeek,
  formatDate,
  formatDateTime,
} from '../../utils/date-parser';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getCached, setCache } from '../../services/cache-store';
import { getUserLanguageById } from '../../services/user-service';
import { tryFastpath as trySecretaryFastpath } from '../../services/secretary-fastpath';
import { assertSecretaryPlanningScope } from '../../services/secretary-planning-context';
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

export function getPendingTasksCacheKey(userId?: number, tenantId?: number): string {
  if (userId != null && tenantId != null) {
    return `u:${userId}:t:${tenantId}:fastpath:pending-tasks`;
  }
  try {
    const { getCurrentContext } = require('../../utils/request-context');
    const context = getCurrentContext();
    const uid = context?.userId;
    const tid = context?.tenantId;
    return uid && tid ? `u:${uid}:t:${tid}:fastpath:pending-tasks` : 'fastpath:pending-tasks';
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

function getCallbackScope(userId?: number, tenantId?: number): { userId: number; tenantId?: number } | undefined {
  return typeof userId === 'number' ? { userId, tenantId } : undefined;
}

async function getPendingTasksCached(
  taskProvider: FastPathTaskProvider,
  userId?: number,
  tenantId?: number,
): Promise<msTodo.ServiceResult<msTodo.TodoTask[]>> {
  const key = getPendingTasksCacheKey(userId, tenantId);
  const cached = getCached<msTodo.TodoTask[]>(key);
  if (cached) {
    return { success: true, data: cached };
  }
  const result = userId != null
    ? await getProviderAwarePendingTasksWithFallback(userId, taskProvider)
    : await taskProvider.getAllPendingTasks();
  if (result.success) {
    setCache(key, result.data, PENDING_TASKS_TTL);
  }
  return result;
}

async function getProviderAwarePendingTasksWithFallback(
  userId: number,
  taskProvider: FastPathTaskProvider,
): Promise<msTodo.ServiceResult<msTodo.TodoTask[]>> {
  const providerAware = await getProviderAwarePendingTodoTasks(userId);
  return providerAware.success ? providerAware : taskProvider.getAllPendingTasks();
}

async function getProviderAwareDueRangeWithFallback(
  userId: number | undefined,
  taskProvider: FastPathTaskProvider,
  startDate: string,
  endDate: string,
): Promise<msTodo.ServiceResult<msTodo.TodoTask[]>> {
  if (userId == null) return taskProvider.getTasksDueInRange(startDate, endDate);
  const providerAware = await getProviderAwareTodoTasksDueInRange(userId, startDate, endDate);
  return providerAware.success ? providerAware : taskProvider.getTasksDueInRange(startDate, endDate);
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
    return labelsForLanguage(getUserLanguageById(userId));
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
    return getUserLanguageById(userId);
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
  tenantId?: number,
): Promise<FastPathResult | null> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  if (userId != null) {
    assertSecretaryPlanningScope(userId, tenantId ?? userId);
  }
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
        return await handleTodos(labels, userId, tenantId);

      case '/lists':
        return await handleLists(labels, userId, tenantId);

      case '/duetoday':
      case '/due_today':
        return await handleDueToday(labels, userId, tenantId);

      case '/overdue':
        return await handleOverdue(labels, userId, tenantId);

      case '/dueweek':
      case '/due_week':
        return await handleDueWeek(labels, userId, tenantId);

      case '/alltasks':
      case '/all_tasks':
        return await handleAllTasks(labels, userId, tenantId);

      case '/todosummary':
      case '/todo_summary':
        return await handleTodoSummary(labels, userId, tenantId);

      case '/day':
      case '/today':
        return await handleCanonicalOverview('/day', labels, userId, tenantId);

      case '/week':
        return await handleCanonicalOverview('/week', labels, userId, tenantId);

      case '/status':
        return await handleCanonicalOverview('/status', labels, userId, tenantId);

      default:
        return null;
    }
  } catch (err) {
    logger.warn({ err, cmd }, 'fast-path command failed, falling back to AI');
    return null;
  }
}

// ── Handlers (mirror the Telegram bot's deterministic command handlers) ──

async function handleTodos(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
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
    buttons: buildTaskActionButtons(result.data, labels, 5, getCallbackScope(userId, tenantId)),
  };
}

async function handleLists(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
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
    buttons: buildListSelectionButtons(result.data, labels, 10, getCallbackScope(userId, tenantId)),
  };
}

async function handleDueToday(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  // Use date-portion comparison in the configured timezone to avoid MS Graph
  // timezone ambiguity (their dueDateTime is stored as a naked datetime).
  const tasksResult = await getPendingTasksCached(taskProvider, userId, tenantId);
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
    buttons: buildTaskActionButtons(dueToday, labels, 5, getCallbackScope(userId, tenantId)),
  };
}

async function handleOverdue(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const tasksResult = await getPendingTasksCached(taskProvider, userId, tenantId);
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
    buttons: buildTaskActionButtons(overdue, labels, 5, getCallbackScope(userId, tenantId)),
  };
}

async function handleDueWeek(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const result = await getProviderAwareDueRangeWithFallback(userId, taskProvider, startOfWeek(), endOfWeek());
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
    buttons: buildTaskActionButtons(result.data, labels, 5, getCallbackScope(userId, tenantId)),
  };
}

async function handleAllTasks(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const result = await getPendingTasksCached(taskProvider, userId, tenantId);
  if (!result.success) {
    return { text: `⚠️ ${copy('Falha ao obter tarefas', 'Failed to fetch tasks')}: ${escapeHtml(result.error || copy('erro desconhecido', 'unknown error'))}`, domain: 'secretary' };
  }

  return {
    text: formatAllTasks(result.data, getFastPathLanguage(userId)),
    domain: 'secretary',
    buttons: buildTaskActionButtons(result.data, labels, 5, getCallbackScope(userId, tenantId)),
  };
}

async function handleTodoSummary(labels: ReturnType<typeof labelsForLanguage>, userId?: number, tenantId?: number): Promise<FastPathResult | null> {
  const taskProvider = getFastPathTaskProvider(userId);
  if (!taskProvider) return null;
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);

  const pendingResult = await getPendingTasksCached(taskProvider, userId, tenantId);
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

async function handleCanonicalOverview(
  command: '/day' | '/week' | '/status',
  labels: ReturnType<typeof labelsForLanguage>,
  userId?: number,
  tenantId?: number,
): Promise<FastPathResult> {
  const copy = (pt: string, en: string) => fastPathCopy(userId, pt, en);
  if (userId != null) {
    const canonical = await trySecretaryFastpath(userId, command, undefined, tenantId ?? userId);
    if (canonical.matched && canonical.response) {
      return {
        text: canonical.response.text,
        domain: 'secretary',
        buttons: buildSecretaryQuickActionButtons(labels),
      };
    }
  }

  return {
    text: command === '/week'
      ? copy('⚠️ Não foi possível confirmar o plano desta semana.', '⚠️ This week\'s plan could not be confirmed.')
      : command === '/status'
        ? copy('⚠️ Não foi possível confirmar o estado do plano.', '⚠️ Plan status could not be confirmed.')
        : copy('⚠️ Não foi possível confirmar o plano de hoje.', '⚠️ Today\'s plan could not be confirmed.'),
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
