// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { ensureActiveProvider, getActiveProvider } from '../services/provider-registry';
import { callDomain as directCallDomain, continueWithToolResults as directContinueWithToolResults } from '../services/anthropic';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { getActiveReminders, getRemindersForToday } from '../state/reminders';
import { getEvents, hasConnectedCalendarForUser } from '../services/unified-calendar';
import type { TodoTask } from '../services/microsoft-todo';
import { formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getSharedMemorySummary } from '../state/shared-memory';
import {
  getActivitiesByDateForUser,
  getBodyBatteryEventsForUser,
  isGarminConfiguredForUser,
  GarminActivity,
} from '../services/garmin';
import { logger } from '../utils/logger';
import { isSubmoduleEnabled } from '../skills/registry';
import { tryFastpath } from '../services/secretary-fastpath';
import { analyzeIntent } from '../services/secretary-tools';
import type { AIToolResultMessage } from '../services/ai-provider';
import { buildAIUnavailableResponse, canUseDirectAnthropicFallback } from './ai-unavailable';
import { normalizeReplyForUserLanguage } from '../services/reply-language-normalizer';
import {
  buildSharedDecisionContext,
  buildSharedDecisionContracts,
  type SharedDecisionContracts,
} from '../services/shared-decision-context';
import { getTaskProviderForUser } from '../services/task-store/task-router';
import { composeDailyBrief } from '../services/daily-brief-orchestrator';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../services/unified-mail-pressure';
import { getUserLanguage, getUserTimezone } from '../services/user-service';
import { DateTime } from 'luxon';
import { buildChatPromptContextBlock } from '../services/chat-context-engine';

const DOMAIN: DomainName = 'secretary';

// Short-lived cache for state context — avoids redundant API calls on rapid messages.
// SECURITY FIX (April 2026): cache is now keyed by userId + context shape to prevent
// cross-user context leakage. Previously, the cache was keyed only by shape, which
// meant user B could receive user A's cached context within the 30s TTL window.
const _stateContextCache: Map<string, { value: string; expiresAt: number }> = new Map();
const STATE_CONTEXT_TTL = 30_000; // 30 seconds
const MAX_CACHE_ENTRIES = 50; // Prevent unbounded growth

function addScopedConversation(
  userId: number,
  role: 'user' | 'assistant',
  content: string,
  tenantId?: number,
): void {
  if (typeof tenantId === 'number') {
    addToConversation(userId, DOMAIN, role, content, tenantId);
    return;
  }
  addToConversation(userId, DOMAIN, role, content);
}

function executeScopedToolCall(
  name: string,
  input: Record<string, any>,
  userId?: number,
  tenantId?: number,
): Promise<unknown> {
  if (typeof tenantId === 'number') {
    return executeToolCall(name, input, userId, tenantId);
  }
  return executeToolCall(name, input, userId);
}

/**
 * Test-only: clear the in-process state context cache so each test starts
 * with a fresh fetch path. Production code never needs this — the cache
 * naturally expires after STATE_CONTEXT_TTL or when the shape changes.
 */
export function _resetStateContextCacheForTesting(): void {
  _stateContextCache.clear();
}

/**
 * Layer 2: Smart Context Selection.
 *
 * Instead of fetching ALL six data sources on every message, analyze the
 * message intent and only fetch what's needed. The keyword classifier is
 * the same one Layer 3 uses for tool selection (single source of truth).
 *
 * Token economics:
 *   - Before: ~2,500 tokens of state context on every call
 *   - After:  ~300-1,500 tokens depending on which sources were needed
 *   - Saving: ~1,000-2,000 tokens per call
 *
 * Cache shape key: when an ambiguous message loads everything, the cache
 * value is reusable for any subsequent intent. When a specific intent
 * loads only one source, the cache is only valid for the same shape — so
 * a "show tasks" cache hit on a follow-up "what's my week" would miss
 * (calendar wasn't loaded the first time) and re-run with calendar.
 */
async function buildStateContext(message: string = '', userId?: number, tenantId?: number): Promise<string> {
  const scopedUserId = typeof userId === 'number' ? userId : null;
  const hasUserScope = scopedUserId !== null;
  const contextLanguage = resolveSecretaryContextLanguage(scopedUserId);
  const copy = secretaryStateContextCopy(contextLanguage);
  // Check which sub-skills are enabled to skip unnecessary API calls
  const tasksEnabled = isSubmoduleEnabled('secretary', 'tasks');
  const calendarEnabled = isSubmoduleEnabled('secretary', 'calendar');
  const emailEnabled = isSubmoduleEnabled('secretary', 'email');
  const remindersEnabled = isSubmoduleEnabled('secretary', 'reminders');

  // Layer 2: figure out which data sources the message actually needs.
  // Ambiguous queries (short follow-ups, freeform questions) load everything
  // — same behavior as before the optimization. Specific queries load just
  // their slice. Garmin always loads if Garmin is configured because the
  // training context is cheap and useful for cross-domain reasoning.
  const intent = analyzeIntent(message);
  const needs = {
    tasks: intent.ambiguous || intent.tasks,
    calendar: intent.ambiguous || intent.calendar,
    email: intent.ambiguous || intent.email,
    reminders: intent.ambiguous || intent.reminders || intent.tasks, // reminders are cheap, often paired with tasks
    garmin: intent.ambiguous || intent.garmin,
    planner: intent.ambiguous || /\b(plan|prioriti[sz]e|priority|first|focus|fit|reschedul|schedule|organi[sz]e|tradeoff|handoff|what should i do|what do i do first|how do i fit|o que faço primeiro|o que devo fazer primeiro|o que devo priorizar(?: hoje)?|o que priorizo(?: hoje)?|qual(?: é| a)? prioridade(?: hoje)?|prioriza o meu dia|priorizar o meu dia|prioriza meu dia|priorizar meu dia|organiza o meu dia|organiza meu dia|como encaixo)\b/i.test(message),
  };
  const needsSharedDecisionContext = hasUserScope && needs.planner;
  const promptBudgetChars = needs.planner
    ? 2000
    : intent.ambiguous
      ? 1500
      : 700;
  const taskProvider = hasUserScope && needs.tasks && tasksEnabled
    ? getTaskProviderForUser(scopedUserId)
    : null;
  const hasCalendar = hasUserScope && needs.calendar && calendarEnabled
    ? hasConnectedCalendarForUser(scopedUserId)
    : false;
  const hasMail = hasUserScope && needs.email && emailEnabled
    ? isAnyMailConfiguredForUser(scopedUserId)
    : false;
  const hasGarmin = hasUserScope && needs.garmin
    ? isGarminConfiguredForUser(scopedUserId)
    : false;

  // Cache key = userId + context shape — prevents cross-user leakage
  const shape = `${needs.tasks ? 't' : ''}${needs.calendar ? 'c' : ''}${needs.email ? 'e' : ''}${needs.reminders ? 'r' : ''}${needs.garmin ? 'g' : ''}${needs.planner ? 'p' : ''}`;
  const scopedTenantKey = hasUserScope ? (typeof tenantId === 'number' && tenantId > 0 ? tenantId : scopedUserId) : 'anon';
  const appendPromptContext = async (baseContext: string, cacheHit: boolean): Promise<string> => {
    if (!hasUserScope) return baseContext;
    if (!needs.planner) {
      logger.debug({
        userId: scopedUserId,
        tenantId: scopedTenantKey,
        cacheShape: shape,
        cacheHit,
        promptBudgetChars: 0,
        promptContextAttached: false,
        estimatedContextChars: baseContext.length,
        estimatedInputTokens: Math.ceil(baseContext.length / 4),
      }, 'Secretary state context assembled without broad prompt context');
      return baseContext;
    }
    const promptContext = await buildChatPromptContextBlock({
      domain: DOMAIN,
      message,
      userId: scopedUserId,
      tenantId,
      budgetChars: promptBudgetChars,
    });
    const combined = promptContext ? `${baseContext}\n${promptContext}` : baseContext;
    logger.debug({
      userId: scopedUserId,
      tenantId: scopedTenantKey,
      cacheShape: shape,
      cacheHit,
      promptBudgetChars,
      promptContextAttached: !!promptContext,
      estimatedContextChars: combined.length,
      estimatedInputTokens: Math.ceil(combined.length / 4),
    }, 'Secretary state context assembled from cache');
    return combined;
  };

  const cacheKey = `${scopedTenantKey}:${hasUserScope ? scopedUserId : 'anon'}:${shape}:${contextLanguage}`;

  const cached = _stateContextCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return appendPromptContext(cached.value, true);
  }

  const timezone = getUserTimezone(scopedUserId);
  const localNow = DateTime.now().setZone(timezone);
  const parts: string[] = [];
  parts.push(`${copy.todayLabel}: ${localNow.toFormat('cccc, LLLL dd yyyy, HH:mm')} (${timezone})`);

  // Build date range for Garmin: last 3 days
  const today = localNow;
  const threeDaysAgo = today.minus({ days: 3 }).toFormat('yyyy-MM-dd');
  const todayStr = today.toFormat('yyyy-MM-dd');

  // Fetch only what `needs` says we need (skip disabled sub-skills + skip unneeded sources)
  const [todoResult, reminders, calendarResult, unreadMail, garminActivities, garminBodyBattery, plannerBrief, decisionCtx, decisionContracts] = await Promise.all([
    taskProvider
      ? taskProvider.getAllPendingTasks().catch(() => ({ success: false as const, data: [], error: 'API error' }))
      : Promise.resolve(null),
    hasUserScope && needs.reminders && remindersEnabled ? Promise.resolve(getRemindersForToday(scopedUserId)) : Promise.resolve([]),
    hasCalendar && scopedUserId !== null
      ? getEvents(localNow.startOf('day').toISO()!, localNow.endOf('day').toISO()!, scopedUserId).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
    hasMail && scopedUserId !== null
      ? getUnreadMailSummaryForUser(scopedUserId).catch(() => null)
      : Promise.resolve(null),
    hasGarmin && scopedUserId !== null
      ? getActivitiesByDateForUser(scopedUserId, threeDaysAgo, todayStr).catch(() => [] as GarminActivity[])
      : Promise.resolve([] as GarminActivity[]),
    hasGarmin && scopedUserId !== null
      ? getBodyBatteryEventsForUser(scopedUserId, todayStr).catch(() => null)
      : Promise.resolve(null),
    hasUserScope && needs.planner
      ? composeDailyBrief({ userId: scopedUserId, language: contextLanguage }).catch(() => null)
      : Promise.resolve(null),
    needsSharedDecisionContext ? buildSharedDecisionContext(DOMAIN, scopedUserId, tenantId).catch(() => '') : Promise.resolve(''),
    needsSharedDecisionContext ? buildSharedDecisionContracts(DOMAIN, scopedUserId, tenantId).catch(() => ({} as SharedDecisionContracts)) : Promise.resolve({} as SharedDecisionContracts),
  ]);

  // Microsoft To Do — compact summary (details available via tools)
  if (todoResult) {
    if (todoResult.success && todoResult.data.length > 0) {
      const tasks: TodoTask[] = todoResult.data;
      // Date-only comparison in the configured timezone. A task "due April 6"
      // should be treated as due TODAY at any moment on April 6, NOT marked
      // overdue at 00:01 just because the timestamp is < now. This matches
      // MS Todo's own UI behavior and avoids double-counting today's tasks
      // as both "overdue" and "due today".
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
      const dueDateStr = (t: typeof tasks[number]): string | null => {
        if (!t.dueDateTime) return null;
        return new Date(t.dueDateTime).toLocaleDateString('en-CA', { timeZone: timezone });
      };
      const overdue = tasks.filter((t: TodoTask) => {
        const d = dueDateStr(t);
        return d !== null && d < todayStr;
      });
      const dueToday = tasks.filter((t: TodoTask) => dueDateStr(t) === todayStr);

      // Group by list with IDs (so model can skip ms_todo_get_lists)
      const byList = new Map<string, { id: string; count: number }>();
      for (const t of tasks) {
        const entry = byList.get(t.listName) || { id: t.listId, count: 0 };
        entry.count++;
        byList.set(t.listName, entry);
      }
      const listSummary = [...byList.entries()]
        .map(([name, { id, count }]) => `${name}(${count}) list_id:${id}`)
        .join(' | ');

      parts.push(
        `\n${copy.todoLabel}: ${copy.pendingLabel(tasks.length)}, ${copy.overdueLabel(overdue.length)}, ${copy.dueTodayLabel(dueToday.length)}.\n${copy.listsLabel}: ${listSummary}`,
      );
      if (overdue.length > 0) {
        parts.push(`${copy.overdueOnlyLabel}: ${overdue.slice(0, 5).map((t: TodoTask) => t.title).join(', ')}`);
      }
    } else if (!todoResult.success) {
      parts.push(`\n${copy.todoLabel}: ${copy.apiErrorLabel}`);
    }
  }

  // Reminders & calendar — compact
  if (reminders.length > 0) {
    parts.push(`\n${copy.remindersTodayLabel}: ${reminders.map((r) => `${r.message} (${formatDateTime(r.remind_at)})`).join(', ')}`);
  }
  if (calendarResult.length > 0) {
    parts.push(`\n${copy.calendarTodayLabel(calendarResult.length)}: ${calendarResult.map((e) => `${formatDateTime(e.start)}-${formatDateTime(e.end)} ${e.summary}`).join(' | ')}`);
  }
  if (unreadMail) {
    const providerDetails = [
      unreadMail.outlookUnread != null ? `Outlook ${unreadMail.outlookUnread}` : null,
      unreadMail.gmailUnread != null ? `Gmail ${unreadMail.gmailUnread}` : null,
    ].filter(Boolean).join(' | ');
    parts.push(`\n${copy.mailLabel}: ${copy.unreadMailLabel(unreadMail.totalUnread)}${providerDetails ? ` (${providerDetails})` : ''}`);
  }

  // Garmin training summary (last 3 days)
  if (garminActivities.length > 0 || garminBodyBattery) {
    parts.push(`\n${copy.garminTrainingHeader}`);

    if (garminActivities.length > 0) {
      // Group by date
      const byDate = new Map<string, GarminActivity[]>();
      for (const a of garminActivities) {
        const date = a.startTimeLocal?.substring(0, 10) || 'unknown';
        const list = byDate.get(date) || [];
        list.push(a);
        byDate.set(date, list);
      }

      for (const [date, activities] of [...byDate.entries()].sort()) {
        const summaries = activities.map((a) => {
          const type = a.activityType?.typeKey || a.activityName || 'activity';
          const dur = a.duration ? `${Math.round(a.duration / 60)}min` : '';
          const dist = a.distance ? `${(a.distance / 1000).toFixed(1)}km` : '';
          const hr = a.averageHR ? `avgHR:${a.averageHR}` : '';
          const cal = a.calories ? `${a.calories}cal` : '';
          return `${type} ${[dur, dist, hr, cal].filter(Boolean).join(' ')}`;
        });
        parts.push(`  ${date}: ${summaries.join(' | ')}`);
      }

      // Check for missing training days
      const activityDates = new Set(byDate.keys());
      for (let i = 0; i < 3; i++) {
        const d = today.minus({ days: i }).toFormat('yyyy-MM-dd');
        if (!activityDates.has(d)) {
          parts.push(`  ${d}: ${copy.noTrainingLogged}`);
        }
      }
    } else {
      parts.push(`  ${copy.noActivitiesLast3Days}`);
    }

    // Body battery
    if (garminBodyBattery && typeof garminBodyBattery === 'object') {
      const bb = garminBodyBattery as Record<string, unknown>;
      const events = bb.bodyBatteryValuesArray ?? bb.bodyBatteryEvents;
      if (Array.isArray(events) && events.length > 0) {
        // Get the latest value
        const latest = events[events.length - 1];
        const val = Array.isArray(latest) ? latest[1] : (latest as Record<string, unknown>)?.bodyBatteryLevel;
        if (val != null) parts.push(`  ${copy.bodyBatteryLabel}: ${val}/100`);
      }
      // Try charged/drained from daily summary fields
      const charged = bb.bodyBatteryChargedValue ?? bb.totalCharged;
      const drained = bb.bodyBatteryDrainedValue ?? bb.totalDrained;
      if (charged != null || drained != null) {
        parts.push(`  ${copy.chargedLabel}: ${charged ?? '?'} | ${copy.drainedLabel}: ${drained ?? '?'}`);
      }
    }
  }

  // Cross-domain shared context — SECURITY FIX: now uses actual userId
  const sharedCtx = hasUserScope ? getSharedMemorySummary(scopedUserId, tenantId) : '';
  if (sharedCtx) parts.push(sharedCtx);

  if (plannerBrief) {
    const coordination = plannerBrief.coordination;
    const plannerParts: string[] = [];
    if (coordination?.topPriority) plannerParts.push(`${copy.plannerTopPriorityLabel}: ${coordination.topPriority}`);
    if (coordination?.dayOrchestration?.title) plannerParts.push(`${copy.plannerDayPostureLabel}: ${coordination.dayOrchestration.title}`);
    if (coordination?.weekOrchestration?.title) plannerParts.push(`${copy.plannerWeekPostureLabel}: ${coordination.weekOrchestration.title}`);
    if (coordination?.nextBestAction?.summary) plannerParts.push(`${copy.plannerNextBestActionLabel}: ${coordination.nextBestAction.summary}`);
    if ((coordination?.executionOrder?.length ?? 0) > 0) plannerParts.push(`${copy.plannerExecutionOrderLabel}: ${coordination!.executionOrder.join(' → ')}`);
    if ((coordination?.blockers?.length ?? 0) > 0) plannerParts.push(`${copy.plannerBlockersLabel}: ${coordination!.blockers.map((blocker) => blocker.summary).join(' | ')}`);
    if ((coordination?.suggestedMoves?.length ?? 0) > 0) plannerParts.push(`${copy.plannerSuggestedMovesLabel}: ${coordination!.suggestedMoves.map((move) => move.title).join(' | ')}`);
    if ((coordination?.watchouts?.length ?? 0) > 0) plannerParts.push(`${copy.plannerWatchoutsLabel}: ${coordination!.watchouts.join(' | ')}`);
    if ((coordination?.handoffs?.length ?? 0) > 0) plannerParts.push(`${copy.plannerHandoffsLabel}: ${coordination!.handoffs.join(' | ')}`);
    if (plannerBrief.day.secretary.tradeoffNote) plannerParts.push(`${copy.plannerTradeoffLabel}: ${plannerBrief.day.secretary.tradeoffNote}`);
    if (plannerParts.length > 0) {
      parts.push(`\n${copy.plannerCoordinationHeader}`);
      parts.push(...plannerParts.map((entry) => `  ${entry}`));
    }
  }

  if (decisionCtx) parts.push(`\n${decisionCtx}`);
  const contractBlock = renderSharedDecisionContracts(decisionContracts);
  if (contractBlock) parts.push(`\n${contractBlock}`);

  const result = parts.join('\n');

  // Evict oldest entries if cache grows too large
  if (_stateContextCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = _stateContextCache.keys().next().value;
    if (oldest) _stateContextCache.delete(oldest);
  }
  _stateContextCache.set(cacheKey, { value: result, expiresAt: Date.now() + STATE_CONTEXT_TTL });
  const finalContext = await appendPromptContext(result, false);
  logger.debug({
    userId: scopedUserId,
    tenantId: scopedTenantKey,
    cacheShape: shape,
    cacheHit: false,
    promptBudgetChars,
    selectedSources: {
      tasks: !!taskProvider,
      calendar: hasCalendar,
      email: hasMail,
      reminders: hasUserScope && needs.reminders && remindersEnabled,
      garmin: hasGarmin,
      planner: hasUserScope && needs.planner,
      sharedDecisionContext: needsSharedDecisionContext,
    },
    estimatedContextChars: finalContext.length,
    estimatedInputTokens: Math.ceil(finalContext.length / 4),
  }, 'Secretary state context assembled');
  return finalContext;
}

function renderSharedDecisionContracts(contracts: SharedDecisionContracts): string {
  const entries = Object.entries(contracts).filter(([, contract]) => contract);
  if (entries.length === 0) return '';

  const lines = ['<shared_decision_contracts domain="secretary">'];
  for (const [peer, contract] of entries) {
    if (!contract) continue;
    const details = [
      contract.nonNegotiables.length > 0 ? `nonNegotiables=${contract.nonNegotiables.join(' | ')}` : null,
      contract.preferredWindows.length > 0 ? `preferredWindows=${contract.preferredWindows.join(' | ')}` : null,
      contract.fallbackIfDeferred.length > 0 ? `fallbackIfDeferred=${contract.fallbackIfDeferred.join(' | ')}` : null,
      contract.budgetMode ? `budgetMode=${contract.budgetMode}` : null,
      contract.publishDeadline ? `publishDeadline=${contract.publishDeadline}` : null,
      contract.notes.length > 0 ? `notes=${contract.notes.join(' | ')}` : null,
    ].filter(Boolean).join('; ');
    if (details.length > 0) {
      lines.push(`- ${peer}: ${details}`);
    }
  }
  lines.push('</shared_decision_contracts>');
  return lines.length > 2 ? lines.join('\n') : '';
}

function resolveSecretaryContextLanguage(userId: number | null): string {
  if (typeof userId !== 'number') return 'en-US';
  try {
    return getUserLanguage(userId);
  } catch {
    return 'en-US';
  }
}

function localizeSecretaryContext(language: string, ptPt: string, ptBr: string, en: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('pt-br')) return ptBr;
  if (normalized.startsWith('pt')) return ptPt;
  return en;
}

function secretaryStateContextCopy(language: string) {
  return {
    todayLabel: localizeSecretaryContext(language, 'Hoje', 'Hoje', 'Today'),
    todoLabel: localizeSecretaryContext(language, 'Tarefas', 'Tarefas', 'To Do'),
    listsLabel: localizeSecretaryContext(language, 'Listas', 'Listas', 'Lists'),
    overdueOnlyLabel: localizeSecretaryContext(language, 'Atrasadas', 'Atrasadas', 'Overdue'),
    remindersTodayLabel: localizeSecretaryContext(language, 'Lembretes de hoje', 'Lembretes de hoje', 'Reminders today'),
    calendarTodayLabel: (count: number) => localizeSecretaryContext(
      language,
      `Calendário de hoje (${count})`,
      `Calendário de hoje (${count})`,
      `Calendar today (${count})`,
    ),
    mailLabel: localizeSecretaryContext(language, 'Email', 'Email', 'Mail'),
    garminTrainingHeader: localizeSecretaryContext(language, '[RESUMO GARMIN DE TREINO]', '[RESUMO GARMIN DE TREINO]', '[GARMIN TRAINING SUMMARY]'),
    noTrainingLogged: localizeSecretaryContext(language, 'Sem treino registado', 'Sem treino registrado', 'No training logged'),
    noActivitiesLast3Days: localizeSecretaryContext(language, 'Sem atividades nos últimos 3 dias', 'Sem atividades nos últimos 3 dias', 'No activities in the last 3 days'),
    bodyBatteryLabel: localizeSecretaryContext(language, 'Body Battery', 'Body Battery', 'Body Battery'),
    chargedLabel: localizeSecretaryContext(language, 'Carregado', 'Carregado', 'Charged'),
    drainedLabel: localizeSecretaryContext(language, 'Gasto', 'Gasto', 'Drained'),
    apiErrorLabel: localizeSecretaryContext(language, 'erro de API', 'erro de API', 'API error'),
    plannerCoordinationHeader: localizeSecretaryContext(language, '[COORDENAÇÃO DO PLANNER]', '[COORDENAÇÃO DO PLANNER]', '[PLANNER COORDINATION]'),
    plannerTopPriorityLabel: localizeSecretaryContext(language, 'Prioridade principal', 'Prioridade principal', 'Top priority'),
    plannerDayPostureLabel: localizeSecretaryContext(language, 'Postura do dia', 'Postura do dia', 'Day posture'),
    plannerWeekPostureLabel: localizeSecretaryContext(language, 'Postura da semana', 'Postura da semana', 'Week posture'),
    plannerNextBestActionLabel: localizeSecretaryContext(language, 'Próxima melhor ação', 'Próxima melhor ação', 'Next best action'),
    plannerExecutionOrderLabel: localizeSecretaryContext(language, 'Sequência de execução', 'Sequência de execução', 'Execution order'),
    plannerBlockersLabel: localizeSecretaryContext(language, 'Bloqueios', 'Bloqueios', 'Blockers'),
    plannerSuggestedMovesLabel: localizeSecretaryContext(language, 'Movimentos sugeridos', 'Movimentos sugeridos', 'Suggested moves'),
    plannerWatchoutsLabel: localizeSecretaryContext(language, 'Atenções', 'Atenções', 'Watchouts'),
    plannerHandoffsLabel: localizeSecretaryContext(language, 'Passagens', 'Passagens', 'Handoffs'),
    plannerTradeoffLabel: localizeSecretaryContext(language, 'Trade-off', 'Trade-off', 'Tradeoff note'),
    pendingLabel: (count: number) => localizeSecretaryContext(language, `${count} pendentes`, `${count} pendentes`, `${count} pending`),
    overdueLabel: (count: number) => localizeSecretaryContext(language, `${count} atrasadas`, `${count} atrasadas`, `${count} overdue`),
    dueTodayLabel: (count: number) => localizeSecretaryContext(language, `${count} para hoje`, `${count} para hoje`, `${count} due today`),
    unreadMailLabel: (count: number) => localizeSecretaryContext(language, `${count} por ler`, `${count} não lidos`, `${count} unread`),
    // ── M8 PT-PT/PT-BR sweep over strings introduced in Wave 1 ──
    // M2 (agenda → provider sync): cron summary lines that may surface in
    // Daily Brief / Decision Center footers.
    syncedToCalendarLabel: localizeSecretaryContext(
      language,
      'Sincronizado ao calendário',
      'Sincronizado ao calendário',
      'Synced to calendar',
    ),
    awaitingCalendarSyncLabel: localizeSecretaryContext(
      language,
      'A aguardar sincronização do calendário',
      'Aguardando sincronização do calendário',
      'Awaiting calendar sync',
    ),
    calendarOfflineLabel: localizeSecretaryContext(
      language,
      'Calendário offline',
      'Calendário offline',
      'Calendar offline',
    ),
    // C2 (reasoning trail surface): user-facing rendering of trail nodes.
    secretaryReasoningHeader: localizeSecretaryContext(
      language,
      'Porque Secretary decidiu',
      'Porque Secretary decidiu',
      'Why Secretary decided',
    ),
    secretaryDecisionStatusLabel: localizeSecretaryContext(
      language,
      'Estado',
      'Estado',
      'Status',
    ),
    secretaryChoseLabel: localizeSecretaryContext(
      language,
      'Escolhido',
      'Escolhido',
      'Chosen',
    ),
    secretaryConsideredLabel: localizeSecretaryContext(
      language,
      'Considerado',
      'Considerado',
      'Considered',
    ),
    // C8 (weekly notes): one-line summary woven into coach-kernel notes.
    secretaryWeeklyContributionLabel: localizeSecretaryContext(
      language,
      'Secretary',
      'Secretary',
      'Secretary',
    ),
    secretaryCompressedSessionsLabel: (count: number) => localizeSecretaryContext(
      language,
      `comprimiu ${count} sessão${count === 1 ? '' : 'ões'}`,
      `comprimiu ${count} sessão${count === 1 ? '' : 'ões'}`,
      `compressed ${count} session${count === 1 ? '' : 's'}`,
    ),
    secretaryReflowedLabel: (count: number) => localizeSecretaryContext(
      language,
      `realocou ${count}`,
      `realocou ${count}`,
      `reflowed ${count}`,
    ),
    secretaryLongRunProtectedLabel: localizeSecretaryContext(
      language,
      'corrida longa protegida',
      'corrida longa protegida',
      'long run protected',
    ),
    // M5 (APNs anchoring): day-anchor words used by secretary-apns-anchoring.ts.
    apnsTodayAnchor: localizeSecretaryContext(language, 'Hoje', 'Hoje', 'Today'),
    apnsTomorrowAnchor: localizeSecretaryContext(language, 'Amanhã', 'Amanhã', 'Tomorrow'),
    apnsMinUnit: localizeSecretaryContext(language, 'min', 'min', 'min'),
  };
}

export async function handleSecretary(message: string, userId?: number, tenantId?: number): Promise<DomainResponse> {
  const hasUserScope = typeof userId === 'number';

  // ── Layer 1: Command Fastpath ──────────────────────────────────
  // Intercept deterministic data-read patterns before any AI call.
  // Identical Telegram-HTML output to the AI path; users can't tell the
  // difference. Errors fall through to the AI path automatically.
  // See src/services/secretary-fastpath.ts for the pattern dictionary.
  const fastpath = hasUserScope ? await tryFastpath(userId, message, undefined, tenantId ?? userId) : { matched: false, response: null };
  if (fastpath.matched && fastpath.response && hasUserScope) {
    // Record in conversation history so the next AI turn has context
    // about what the user just asked. Tag the assistant message with the
    // pattern id so future debugging can spot fastpath responses in logs.
    addScopedConversation(userId, 'user', message, tenantId);
    addScopedConversation(userId, 'assistant', `[fastpath:${fastpath.patternId}]\n${fastpath.response.text}`, tenantId);
    return fastpath.response;
  }

  const history = hasUserScope ? getConversationHistory(userId, DOMAIN, tenantId) : [];
  // Layer 2: pass the message so buildStateContext can fetch only what
  // the message actually needs (saves ~1,000-2,000 input tokens on
  // intent-typed queries; ambiguous queries fall back to fetching all).
  const stateContext = await buildStateContext(message, userId, tenantId);

  // ── Provider routing — TASK-17 Option B fix ────────────────────
  //
  // Previously this handler imported callDomain/continueWithToolResults
  // directly from services/anthropic.ts, which BYPASSED the
  // TaskRoutingProvider entirely — meaning the Gemini migration we
  // shipped earlier never actually applied to secretary. Despite the
  // routing config saying "secretary → gemini", every secretary call
  // was still hitting Anthropic Sonnet because handleSecretary used
  // a different code path than handleSimpleDomain.
  //
  // Fix: route through getActiveProvider() like handleSimpleDomain
  // does, with the same fallback to direct Anthropic if the routing
  // provider isn't initialized. Now secretary participates in:
  //   - Gemini routing (config-driven, portal-toggleable)
  //   - TASK-17 Layers 3/4/5 (computed by TaskRoutingProvider once
  //     and passed to whichever provider runs)
  //   - Circuit breaker fallback (if Gemini fails, falls back to
  //     Anthropic Haiku — same fallback the chat domains get)
    const provider = getActiveProvider() || ensureActiveProvider();
    if (!provider) {
      if (!canUseDirectAnthropicFallback()) {
        return buildAIUnavailableResponse(DOMAIN, userId);
      }
    // Fallback to direct Anthropic — same call signatures the legacy
      // path used. The Anthropic SDK client is lazy-initialized inside
      // anthropic.ts so this static import is cheap; the test suites
      // can mock the imports normally without dynamic-require gotchas.
      return await handleSecretaryWithDirectAnthropic(
        userId, message, history, stateContext, directCallDomain, directContinueWithToolResults, userId, tenantId,
      );
    }

  // Provider-agnostic tool loop — same shape as handleSimpleDomain
  // but with secretary's iteration cap (4 instead of 5) and the
  // empty-response fallback message that secretary specifically needs
  // because its tool loop is more brittle than the chat domains.
  let result = await provider.callDomain(DOMAIN, history, message, stateContext, {
    userId,
    tenantId,
  });
  let finalText = result.text;

  logger.debug(
    { provider: provider.name, hasTools: result.toolCalls.length > 0 },
    'Secretary call dispatched via routing provider',
  );

  const toolConversation: AIToolResultMessage[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < 4) {
    iterations++;
    logger.debug({ iteration: iterations, toolCount: result.toolCalls.length }, 'Tool loop iteration');

    // Build assistant content (provider-agnostic format — matches
    // what handleSimpleDomain does for cooking/finance/etc.)
    const assistantContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      toolsUsed.push(tc.name);
    }

    // Execute all tool calls in parallel, truncate large results
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc) => {
        const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      })
    );

    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent as any },
      { role: 'user' as const, content: toolResults },
    );

    logger.debug({ iteration: iterations, msgCount: toolConversation.length }, 'Calling continueWithToolResults');
    result = await provider.continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation, {
      userId,
      tenantId,
    });
    finalText = result.text;
    logger.debug({ iteration: iterations, hasText: !!finalText, toolCalls: result.toolCalls.length }, 'Continue result');
  }

  // Guard against empty response (can happen after errors exhaust tool iterations)
  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  // CHAT-M4: detect max_tokens truncation — if the AI hit the output
  // ceiling, append a note so the user knows the response is incomplete.
  // This catches the common case where a busy day's briefing exceeds
  // the token budget and gets cut mid-sentence.
  if (result?.stopReason === 'max_tokens' || result?.stopReason === 'length') {
    logger.warn({ userId, domain: DOMAIN, stopReason: result.stopReason }, 'Secretary response was truncated by max_tokens');
    finalText += '\n\n_⚠️ Response was cut short due to length. Try asking about a specific area (e.g. "just show my tasks" or "just calendar")._';
  }

  finalText = normalizeReplyForUserLanguage(finalText, userId);

  // Store conversation — include tool summary so future turns have context
  if (hasUserScope) {
    addScopedConversation(userId, 'user', message, tenantId);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addScopedConversation(userId, 'assistant', storedText, tenantId);
  }

  return { text: finalText, domain: DOMAIN };
}

/**
 * Direct-Anthropic fallback for handleSecretary. Used only when the
 * routing provider isn't initialized — preserves the original
 * Anthropic-only flow as a safety net during startup or if routing
 * fails to init. Uses Anthropic SDK types directly.
 *
 * In normal operation this never runs because portal/server.ts calls
 * createRoutingProvider() at startup. It exists purely as a safety net
 * so a misconfigured deploy can never leave secretary completely
 * broken.
 */
async function handleSecretaryWithDirectAnthropic(
  uid: number | undefined,
  message: string,
  history: ReturnType<typeof getConversationHistory>,
  stateContext: string,
  callDomain: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  continueWithToolResults: (...args: any[]) => Promise<{ text: string; toolCalls: any[]; stopReason: string }>,
  userId: number | undefined,
  tenantId?: number,
): Promise<DomainResponse> {
  let result = await callDomain(DOMAIN, history, message, stateContext, undefined, userId);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < 4) {
    iterations++;
    const assistantContent: any[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
      toolsUsed.push(tc.name);
    }

    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc: any) => {
        const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
        let content = JSON.stringify(toolResult);
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      })
    );

    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );

    result = await continueWithToolResults(DOMAIN, history, message, stateContext, toolConversation, userId);
    finalText = result.text;
  }

  if (!finalText || !finalText.trim()) {
    finalText = '⚠️ I processed your request but encountered some issues. Some actions may have completed partially. Please check your task list and try again if needed.';
  }

  finalText = normalizeReplyForUserLanguage(finalText, uid);

  if (typeof uid === 'number') {
    addScopedConversation(uid, 'user', message, tenantId);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addScopedConversation(uid, 'assistant', storedText, tenantId);
  }

  return { text: finalText, domain: DOMAIN };
}
