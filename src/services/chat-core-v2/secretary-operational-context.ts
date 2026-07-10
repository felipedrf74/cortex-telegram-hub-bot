// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';

import type {
  ChatContextItem,
  ChatContextSource,
  ChatContextSourceDiagnostic,
} from '../chat-context-engine';
import { DEFAULT_CHAT_VISIBILITY_SCOPE } from '../chat-tenant-scope';
import { getTaskProviderForUser } from '../task-store/task-router';
import { getEventsWithDiagnostics, type UnifiedCalendarEvent } from '../unified-calendar';
import { getUnreadMailSummaryForUser, isAnyMailConfiguredForUser } from '../unified-mail-pressure';
import { getRemindersForWindow } from '../../state/reminders';
import {
  getActivitiesByDateForUser,
  isGarminConfiguredForUser,
  type GarminActivity,
} from '../garmin';
import { getLatestReadinessEvent, type ReadinessEventRow } from '../readiness-events';
import { getUserTimezone } from '../user-service';
import { isSubmoduleEnabled } from '../../skills/registry';
import { analyzeIntent } from '../secretary-tools';
import { sanitizeForPromptInterpolation } from '../../utils/prompt-sanitizer';
import { withTimeout } from '../../utils/timeout';
import { composeDailyBrief } from '../daily-brief-orchestrator';
import { getAICallTimeoutMs } from '../runtime-flags';

const COLLECTOR_TIMEOUT_MS = 5_000;
const MAX_TASK_ITEMS = 5;
const MAX_CALENDAR_ITEMS = 6;
const MAX_REMINDER_ITEMS = 5;
// Evidence must remain usable for the initial model call plus the one allowed
// schema-repair call. Keep a small coordination margin for provider handoff.
const LIVE_STALE_AFTER_MS = Math.max(2 * 60_000, (2 * getAICallTimeoutMs()) + 15_000);

const OPERATIONAL_SOURCES: readonly ChatContextSource[] = [
  'tasks',
  'calendar',
  'mail',
  'reminders',
  'readiness',
  'garmin',
  'daily_context',
] as const;

export interface SecretaryOperationalContextCollection {
  items: ChatContextItem[];
  diagnostics: ChatContextSourceDiagnostic[];
}

export interface CollectSecretaryOperationalContextInput {
  message: string;
  userId: number;
  tenantId: number;
  planning?: boolean;
  now?: Date;
}

interface CollectorResult {
  source: ChatContextSource;
  items: ChatContextItem[];
  diagnostic: ChatContextSourceDiagnostic;
}

interface OperationalCalendarWindow {
  start: DateTime;
  end: DateTime;
  label: string;
  sourceRef: string;
}

/**
 * Collect authoritative, user-scoped operational evidence for Secretary.
 *
 * Provider bodies, descriptions, locations, attendees, mail subjects, raw
 * health metrics, and credentials are deliberately excluded. Text labels that
 * are needed to identify a task/event/reminder are sanitized and bounded.
 */
export async function collectSecretaryOperationalContext(
  input: CollectSecretaryOperationalContextInput,
): Promise<SecretaryOperationalContextCollection> {
  const observedAt = (input.now ?? new Date()).toISOString();
  if (!isValidScope(input.userId, input.tenantId)) {
    return {
      items: [],
      diagnostics: OPERATIONAL_SOURCES.map((source) => ({
        source,
        status: 'permission_denied',
        observedAt,
        reasonCode: 'authenticated_scope_unavailable',
      })),
    };
  }

  const intent = analyzeIntent(input.message);
  const planning = input.planning === true;
  const requested = {
    tasks: intent.ambiguous || intent.tasks || planning,
    calendar: intent.ambiguous || intent.calendar || planning,
    mail: intent.ambiguous || intent.email || planning,
    reminders: intent.ambiguous || intent.reminders || intent.tasks || planning,
    readiness: intent.ambiguous || intent.garmin || planning,
    garmin: intent.ambiguous || intent.garmin || planning,
  };

  const runs: Array<Promise<CollectorResult>> = [
    requested.tasks
      ? collectTasks(input, observedAt)
      : Promise.resolve(notRequested('tasks', observedAt)),
    requested.calendar
      ? collectCalendar(input, observedAt)
      : Promise.resolve(notRequested('calendar', observedAt)),
    requested.mail
      ? collectMail(input, observedAt)
      : Promise.resolve(notRequested('mail', observedAt)),
    requested.reminders
      ? collectReminders(input, observedAt)
      : Promise.resolve(notRequested('reminders', observedAt)),
    requested.readiness
      ? collectReadiness(input, observedAt)
      : Promise.resolve(notRequested('readiness', observedAt)),
    requested.garmin
      ? collectGarmin(input, observedAt)
      : Promise.resolve(notRequested('garmin', observedAt)),
  ];
  if (planning) runs.push(collectDailyCoordination(input, observedAt));
  const results = await Promise.all(runs);
  return {
    items: results.flatMap((result) => result.items),
    diagnostics: results.map((result) => result.diagnostic),
  };
}

async function collectDailyCoordination(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  try {
    const timezone = safeTimezone(input.userId);
    const window = resolveOperationalCalendarWindow(input.message, timezone, input.now ?? new Date());
    const brief = await withTimeout(composeDailyBrief({
      userId: input.userId,
      tenantId: input.tenantId,
      date: window.start.toISODate() ?? undefined,
    }), COLLECTOR_TIMEOUT_MS);
    const coordination = brief.coordination;
    const projection = {
      topPriority: coordination.topPriority ? safeLabel(coordination.topPriority, 160) : null,
      executionOrder: coordination.executionOrder.slice(0, 5).map((value) => safeLabel(value, 160)),
      watchouts: coordination.watchouts.slice(0, 4).map((value) => safeLabel(value, 160)),
      handoffs: coordination.handoffs.slice(0, 4).map((value) => safeLabel(value, 160)),
      blockers: coordination.blockers.slice(0, 4).map((value) => safeLabel(value.title, 160)),
      suggestedMoves: coordination.suggestedMoves.slice(0, 4).map((value) => safeLabel(value.title, 160)),
      protectedBlocks: coordination.protectedBlocks.slice(0, 4).map((value) => safeLabel(value.title, 160)),
      nextBestAction: coordination.nextBestAction?.title
        ? safeLabel(coordination.nextBestAction.title, 160)
        : null,
      confidence: coordination.confidence,
      degraded: brief.degraded,
      gated: brief.gated,
    };
    const staleAfter = staleAfterFrom(observedAt);
    const item = operationalItem({
      id: 'secretary-daily-coordination',
      source: 'daily_context',
      sourceRef: `daily_context:${brief.date}`,
      entityVersion: opaqueRef(JSON.stringify(projection)),
      content: `Deterministic daily coordination: ${JSON.stringify(projection)}.`,
      input,
      observedAt: safeIso(brief.generatedAt) ?? observedAt,
      staleAfter,
      reason: 'Deterministic Secretary orchestration projection; bounded to priorities, execution order, blockers, suggested moves, protections, and handoffs.',
      permission: 'secretary:read',
      confidence: brief.degraded ? 0.55 : 0.9,
      relevanceScore: 0.96,
      priority: 90,
    });
    if (brief.degraded) {
      return {
        source: 'daily_context',
        items: [item],
        diagnostic: {
          source: 'daily_context',
          status: 'unknown',
          observedAt,
          staleAfter,
          reasonCode: 'daily_coordination_degraded',
        },
      };
    }
    return available('daily_context', observedAt, [item], staleAfter, 'daily_coordination_bounded_projection');
  } catch {
    return failed('daily_context', observedAt, 'daily_coordination_unavailable');
  }
}

async function collectTasks(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  if (!submoduleEnabled('tasks')) return permissionDenied('tasks', observedAt, 'secretary_tasks_disabled');
  try {
    const result = await withTimeout(
      getTaskProviderForUser(input.userId).getAllPendingTasks(),
      COLLECTOR_TIMEOUT_MS,
    ) as { success?: boolean; data?: any[] };
    if (!result?.success || !Array.isArray(result.data)) {
      return failed('tasks', observedAt, 'tasks_live_read_failed');
    }
    const tasks = result.data.slice(0, MAX_TASK_ITEMS);
    if (result.data.length === 0) {
      const staleAfter = staleAfterFrom(observedAt);
      return empty('tasks', observedAt, 'no_pending_tasks', [operationalItem({
        id: 'live-task-aggregate',
        source: 'tasks',
        sourceRef: 'tasks:pending-aggregate',
        entityVersion: opaqueRef('pending_tasks:0'),
        content: 'Pending task coverage: total=0; detailed=0; omitted=0; high_importance=0.',
        input,
        observedAt,
        staleAfter,
        reason: 'Successful scoped task-provider read returned no pending tasks.',
        permission: 'tasks:read',
      })]);
    }
    const staleAfter = staleAfterFrom(observedAt);
    const items: ChatContextItem[] = tasks.map((task: any) => {
      const stableRef = opaqueRef(`${task.listId ?? ''}:${task.id ?? ''}`);
      const due = safeIso(task.dueDateTime);
      return operationalItem({
        id: `live-task-${stableRef}`,
        source: 'tasks',
        sourceRef: `task:${stableRef}`,
        entityVersion: safeVersion(task.providerVersion ?? task.providerUpdatedAt ?? task.createdDateTime, task),
        content: `Pending task: ${safeLabel(task.title, 140)}; importance=${safeEnum(task.importance, 'normal')}; due=${due ?? 'unscheduled'}.`,
        input,
        observedAt,
        staleAfter,
        reason: 'Live scoped task-provider read; body and checklist content omitted.',
        permission: 'tasks:read',
      });
    });
    items.push(operationalItem({
      id: 'live-task-aggregate',
      source: 'tasks',
      sourceRef: 'tasks:pending-aggregate',
      entityVersion: opaqueRef(JSON.stringify(result.data.map((task: any) => ({
        id: task.id ?? null,
        listId: task.listId ?? null,
        importance: task.importance ?? null,
        due: task.dueDateTime ?? null,
      })))),
      content: `Pending task coverage: total=${result.data.length}; detailed=${tasks.length}; omitted=${Math.max(0, result.data.length - tasks.length)}; high_importance=${result.data.filter((task: any) => String(task.importance ?? '').toLowerCase() === 'high').length}.`,
      input,
      observedAt,
      staleAfter,
      reason: 'Complete aggregate for the bounded live task sample; task bodies and omitted titles excluded.',
      permission: 'tasks:read',
    }));
    return available('tasks', observedAt, items, staleAfter, result.data.length > MAX_TASK_ITEMS ? 'tasks_result_bounded' : undefined);
  } catch {
    return failed('tasks', observedAt, 'tasks_live_read_failed');
  }
}

async function collectCalendar(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  if (!submoduleEnabled('calendar')) return permissionDenied('calendar', observedAt, 'secretary_calendar_disabled');
  const timezone = safeTimezone(input.userId);
  const window = resolveOperationalCalendarWindow(input.message, timezone, input.now ?? new Date());
  try {
    const result = await withTimeout(
      getEventsWithDiagnostics(window.start.toISO()!, window.end.toISO()!, input.userId),
      COLLECTOR_TIMEOUT_MS,
    );
    if (result.status === 'unavailable') {
      return result.sources.configured.length === 0
        ? permissionDenied('calendar', observedAt, 'calendar_integration_not_connected')
        : failed('calendar', observedAt, 'calendar_live_read_failed');
    }
    const events = result.events.slice(0, MAX_CALENDAR_ITEMS);
    if (result.events.length === 0) {
      return result.status === 'degraded'
        ? unknown('calendar', observedAt, 'calendar_empty_with_partial_provider_failure')
        : empty('calendar', observedAt, 'calendar_empty_requested_window', [operationalItem({
            id: 'live-calendar-aggregate',
            source: 'calendar',
            sourceRef: window.sourceRef,
            entityVersion: opaqueRef(`calendar:${window.start.toISODate()}:${window.end.toISODate()}:0`),
            content: `Calendar coverage ${window.label}: total=0; detailed=0; omitted=0.`,
            input,
            observedAt,
            staleAfter: staleAfterFrom(observedAt),
            reason: `Successful scoped calendar read returned no commitments for ${window.label}.`,
            permission: 'secretary:read',
            critical: true,
          })]);
    }
    const staleAfter = staleAfterFrom(observedAt);
    const items = events.map((event: UnifiedCalendarEvent) => {
      const stableRef = opaqueRef(`${event.source}:${event.id}`);
      return operationalItem({
        id: `live-calendar-${stableRef}`,
        source: 'calendar',
        sourceRef: `calendar:${event.source}:${stableRef}`,
        entityVersion: opaqueRef(`${event.id}:${event.start}:${event.end}`),
        content: `Calendar commitment: ${safeLabel(event.summary, 140)}; start=${safeIso(event.start) ?? 'unknown'}; end=${safeIso(event.end) ?? 'unknown'}; provider=${event.source}.`,
        input,
        observedAt,
        staleAfter,
        reason: 'Live scoped calendar read; descriptions, locations, attendees, and provider URLs omitted.',
        permission: 'secretary:read',
        critical: true,
      });
    });
    items.push(operationalItem({
      id: 'live-calendar-aggregate',
      source: 'calendar',
      sourceRef: window.sourceRef,
      entityVersion: opaqueRef(JSON.stringify(result.events.map((event) => [event.source, event.id, event.start, event.end]))),
      content: `Calendar coverage ${window.label}: total=${result.events.length}; detailed=${events.length}; omitted=${Math.max(0, result.events.length - events.length)}; query_start=${window.start.toISO()}; query_end=${window.end.toISO()}; first_event_start=${safeIso(result.events[0]?.start) ?? 'unknown'}; last_event_end=${safeIso(result.events[result.events.length - 1]?.end) ?? 'unknown'}.`,
      input,
      observedAt,
      staleAfter,
      reason: 'Complete aggregate for the bounded live calendar sample; omitted titles, attendees, locations, and descriptions excluded.',
      permission: 'secretary:read',
      critical: true,
    }));
    const reasonCode = result.status === 'degraded'
      ? 'calendar_partial_provider_failure'
      : result.events.length > MAX_CALENDAR_ITEMS ? 'calendar_result_bounded' : undefined;
    return available('calendar', observedAt, items, staleAfter, reasonCode);
  } catch {
    return failed('calendar', observedAt, 'calendar_live_read_failed');
  }
}

/**
 * Resolve the evidence horizon from the current request before reading the
 * calendar. This deliberately supports a small deterministic vocabulary
 * rather than asking a model to choose provider query boundaries.
 */
function resolveOperationalCalendarWindow(message: string, timezone: string, now: Date): OperationalCalendarWindow {
  const base = DateTime.fromJSDate(now).setZone(timezone);
  const folded = message.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();

  const exactDate = folded.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (exactDate) {
    const parsed = DateTime.fromISO(exactDate, { zone: timezone });
    if (parsed.isValid) return dayWindow(parsed, exactDate);
  }

  if (/\b(day after tomorrow|depois de amanha|pasado manana)\b/.test(folded)) {
    return dayWindow(base.plus({ days: 2 }), 'the day after tomorrow');
  }
  const relativeDays = folded.match(/\b(?:in|daqui a|en)\s+(\d{1,2})\s+(?:days?|dias?)\b/);
  if (relativeDays) {
    const days = Number(relativeDays[1]);
    if (Number.isSafeInteger(days) && days >= 1 && days <= 31) {
      return dayWindow(base.plus({ days }), `in ${days} days`);
    }
  }
  if (/\b(next month|proximo mes|mes que vem)\b/.test(folded)) {
    const start = base.plus({ months: 1 }).startOf('month');
    return rangeWindow(start, start.endOf('month'), 'next month');
  }
  if (/\b(this month|este mes)\b/.test(folded)) {
    return rangeWindow(base.startOf('day'), base.endOf('month'), 'the rest of this month');
  }
  if (/\b(next week|proxima semana|semana que vem)\b/.test(folded)) {
    const start = base.plus({ weeks: 1 }).startOf('week');
    return rangeWindow(start, start.endOf('week'), 'next week');
  }
  if (/\b(this week|esta semana|plan my week|planeia a minha semana|planejar minha semana)\b/.test(folded)) {
    return rangeWindow(base.startOf('day'), base.endOf('week'), 'the rest of this week');
  }
  if (/\b(tomorrow|amanha|manana)\b/.test(folded)) {
    return dayWindow(base.plus({ days: 1 }), 'tomorrow');
  }

  const weekdayNames: Record<string, number> = {
    monday: 1, segunda: 1,
    tuesday: 2, terca: 2, martes: 2,
    wednesday: 3, quarta: 3, miercoles: 3,
    thursday: 4, quinta: 4, jueves: 4,
    friday: 5, sexta: 5, viernes: 5,
    saturday: 6, sabado: 6,
    sunday: 7, domingo: 7,
  };
  const weekdayMatch = folded.match(/\b(?:(next|proxima|proximo)\s+)?(monday|segunda|tuesday|terca|martes|wednesday|quarta|miercoles|thursday|quinta|jueves|friday|sexta|viernes|saturday|sabado|sunday|domingo)\b/);
  if (weekdayMatch) {
    const targetWeekday = weekdayNames[weekdayMatch[2]];
    let daysAhead = (targetWeekday - base.weekday + 7) % 7;
    if (daysAhead === 0 && weekdayMatch[1]) daysAhead = 7;
    return dayWindow(base.plus({ days: daysAhead }), weekdayMatch[2]);
  }

  return dayWindow(base, 'today');
}

function dayWindow(day: DateTime, label: string): OperationalCalendarWindow {
  return rangeWindow(day.startOf('day'), day.endOf('day'), label);
}

function rangeWindow(start: DateTime, end: DateTime, label: string): OperationalCalendarWindow {
  return {
    start,
    end,
    label,
    sourceRef: `calendar:${start.toISODate()}:${end.toISODate()}-aggregate`,
  };
}

async function collectMail(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  if (!submoduleEnabled('email')) return permissionDenied('mail', observedAt, 'secretary_email_disabled');
  try {
    if (!isAnyMailConfiguredForUser(input.userId)) {
      return permissionDenied('mail', observedAt, 'mail_integration_not_connected');
    }
    const summary = await withTimeout(getUnreadMailSummaryForUser(input.userId), COLLECTOR_TIMEOUT_MS);
    const providerCounts = [summary.outlookUnread, summary.gmailUnread];
    const availableCount = providerCounts.filter((count): count is number => typeof count === 'number' && count >= 0);
    if (summary.configuredProviders.length > 0 && availableCount.length === 0) {
      return failed('mail', observedAt, 'mail_unread_counts_unavailable');
    }
    const partial = availableCount.length < summary.configuredProviders.length;
    if (summary.totalUnread === 0) {
      return partial
        ? unknown('mail', observedAt, 'mail_empty_with_partial_provider_failure')
        : empty('mail', observedAt, 'no_unread_mail', [operationalItem({
            id: 'live-mail-pressure',
            source: 'mail',
            sourceRef: 'mail:unread-pressure',
            entityVersion: opaqueRef(JSON.stringify({ providers: summary.configuredProviders, counts: providerCounts })),
            content: `Unread mail pressure: total=0; providers=${summary.configuredProviders.join(',') || 'unknown'}.`,
            input,
            observedAt,
            staleAfter: staleAfterFrom(observedAt),
            reason: 'Successful scoped unread-count read returned zero; subjects, senders, recipients, and bodies omitted.',
            permission: 'mail:read',
          })]);
    }
    const staleAfter = staleAfterFrom(observedAt);
    const content = `Unread mail pressure: total=${summary.totalUnread}; providers=${summary.configuredProviders.join(',') || 'unknown'}.`;
    const item = operationalItem({
      id: 'live-mail-pressure',
      source: 'mail',
      sourceRef: 'mail:unread-pressure',
      entityVersion: opaqueRef(JSON.stringify({ providers: summary.configuredProviders, counts: providerCounts })),
      content,
      input,
      observedAt,
      staleAfter,
      reason: 'Live scoped unread-count read; subjects, senders, recipients, and message bodies omitted.',
      permission: 'mail:read',
    });
    return available('mail', observedAt, [item], staleAfter, partial ? 'mail_partial_provider_failure' : undefined);
  } catch {
    return failed('mail', observedAt, 'mail_live_read_failed');
  }
}

async function collectReminders(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  if (!submoduleEnabled('reminders')) return permissionDenied('reminders', observedAt, 'secretary_reminders_disabled');
  try {
    const timezone = safeTimezone(input.userId);
    const window = resolveOperationalCalendarWindow(input.message, timezone, input.now ?? new Date());
    const reminders = await withTimeout(
      Promise.resolve(getRemindersForWindow(
        input.userId,
        input.tenantId,
        window.start.toISO()!,
        window.end.toISO()!,
        timezone,
      )),
      COLLECTOR_TIMEOUT_MS,
    );
    if (reminders.length === 0) {
      return empty('reminders', observedAt, 'no_reminders_requested_window', [operationalItem({
        id: 'live-reminder-aggregate',
        source: 'reminders',
        sourceRef: `reminders:${window.start.toISODate()}:${window.end.toISODate()}-aggregate`,
        entityVersion: opaqueRef(`reminders:${timezone}:${window.start.toISODate()}:${window.end.toISODate()}:0`),
        content: `Reminder coverage ${window.label}: total=0; detailed=0; omitted=0.`,
        input,
        observedAt,
        staleAfter: staleAfterFrom(observedAt),
        reason: `Successful tenant/user-scoped reminder read returned no active reminders for ${window.label}.`,
        permission: 'secretary:read',
      })]);
    }
    const staleAfter = staleAfterFrom(observedAt);
    const items = reminders.slice(0, MAX_REMINDER_ITEMS).map((reminder) => {
      const stableRef = opaqueRef(String(reminder.id));
      return operationalItem({
        id: `live-reminder-${stableRef}`,
        source: 'reminders',
        sourceRef: `reminder:${stableRef}`,
        entityVersion: safeVersion(reminder.created_at, reminder),
        content: `Active reminder: ${safeLabel(reminder.message, 140)}; remind_at=${safeIso(reminder.remind_at) ?? 'unknown'}; recurring=${safeEnum(reminder.recurring, 'none')}.`,
        input,
        observedAt,
        staleAfter,
        reason: 'Live tenant/user-scoped reminder read; message bounded and sanitized.',
        permission: 'secretary:read',
      });
    });
    return available('reminders', observedAt, items, staleAfter, reminders.length > MAX_REMINDER_ITEMS ? 'reminders_result_bounded' : undefined);
  } catch {
    return failed('reminders', observedAt, 'reminders_live_read_failed');
  }
}

async function collectReadiness(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  try {
    const event = await withTimeout(
      Promise.resolve(getLatestReadinessEvent(input.userId, input.tenantId)),
      COLLECTOR_TIMEOUT_MS,
    );
    if (!event) return empty('readiness', observedAt, 'no_consented_readiness_event', [operationalItem({
      id: 'live-readiness-empty',
      source: 'readiness',
      sourceRef: 'readiness:latest-consented',
      entityVersion: opaqueRef('readiness:none'),
      content: 'Readiness coverage: no consented readiness event is available.',
      input,
      observedAt,
      staleAfter: staleAfterFrom(observedAt),
      reason: 'Successful scoped readiness lookup returned no consented event.',
      permission: 'training:read',
    })]);
    const consent = new Set(event.consent_scope.split(',').map((scope) => scope.trim()).filter(Boolean));
    if (!consent.has('readiness_basic')) {
      return permissionDenied('readiness', observedAt, 'readiness_consent_unavailable');
    }
    const recoverySignal = coarseRecoverySignal(event, consent);
    const eventDate = DateTime.fromISO(event.date, { zone: safeTimezone(input.userId) });
    const staleAfter = eventDate.endOf('day').toUTC().toISO()
      ?? staleAfterFrom(observedAt);
    const isStale = Date.parse(staleAfter) <= Date.parse(observedAt);
    const item = operationalItem({
      id: `live-readiness-${opaqueRef(`${event.id}:${event.date}`)}`,
      source: 'readiness',
      sourceRef: `readiness:${opaqueRef(String(event.id))}`,
      entityVersion: safeVersion(event.created_at, event),
      content: `Readiness summary: observed_date=${event.date}; recovery_signal=${recoverySignal}; source=${safeEnum(event.source, 'consented_local')}.`,
      input,
      observedAt: normalizeObservedAt(event.created_at, observedAt),
      staleAfter,
      reason: 'Tenant/user-scoped consent-gated readiness projection; raw sleep, stress, HRV, and heart-rate values omitted.',
      permission: 'training:read',
      freshness: isStale ? 'stale' : 'fresh',
    });
    return isStale
      ? stale('readiness', observedAt, [item], staleAfter, 'readiness_event_stale')
      : available('readiness', observedAt, [item], staleAfter);
  } catch {
    return failed('readiness', observedAt, 'readiness_live_read_failed');
  }
}

async function collectGarmin(
  input: CollectSecretaryOperationalContextInput,
  observedAt: string,
): Promise<CollectorResult> {
  try {
    if (!isGarminConfiguredForUser(input.userId)) {
      return permissionDenied('garmin', observedAt, 'garmin_integration_not_connected');
    }
    const timezone = safeTimezone(input.userId);
    const local = DateTime.fromJSDate(input.now ?? new Date()).setZone(timezone);
    const activities = await withTimeout(
      getActivitiesByDateForUser(input.userId, local.minus({ days: 3 }).toFormat('yyyy-MM-dd'), local.toFormat('yyyy-MM-dd')),
      COLLECTOR_TIMEOUT_MS,
    );
    // Garmin's existing client intentionally collapses endpoint failure and a
    // genuine empty activity list to []. Keep that state unknown instead of
    // making the unsafe assertion that the user had no recent activity.
    if (activities.length === 0) return unknown('garmin', observedAt, 'garmin_empty_or_read_failed');
    const staleAfter = staleAfterFrom(observedAt);
    const safeTypes = [...new Set(activities.slice(0, 20).map(activityType).filter(Boolean))].slice(0, 5);
    const item = operationalItem({
      id: 'live-garmin-activity-summary',
      source: 'garmin',
      sourceRef: 'garmin:recent-activity-summary',
      entityVersion: opaqueRef(activities.map((activity) => `${activity.activityId}:${activity.startTimeLocal}`).join('|')),
      content: `Garmin activity summary: recent_count=${activities.length}; activity_types=${safeTypes.join(',') || 'unknown'}; window_days=3.`,
      input,
      observedAt,
      staleAfter,
      reason: 'Live user-scoped Garmin activity projection; names and raw health/performance metrics omitted.',
      permission: 'training:read',
    });
    return available('garmin', observedAt, [item], staleAfter, activities.length > 20 ? 'garmin_result_bounded' : undefined);
  } catch {
    return failed('garmin', observedAt, 'garmin_live_read_failed');
  }
}

function operationalItem(input: {
  id: string;
  source: ChatContextSource;
  sourceRef: string;
  entityVersion: string;
  content: string;
  input: CollectSecretaryOperationalContextInput;
  observedAt: string;
  staleAfter: string;
  reason: string;
  permission: string;
  critical?: boolean;
  freshness?: ChatContextItem['freshness'];
  confidence?: number;
  relevanceScore?: number;
  priority?: number;
}): ChatContextItem {
  return {
    id: input.id,
    tenantId: input.input.tenantId,
    userId: input.input.userId,
    ownerUserId: input.input.userId,
    scope: DEFAULT_CHAT_VISIBILITY_SCOPE,
    source: input.source,
    sourceRef: input.sourceRef,
    observedAt: input.observedAt,
    entityVersion: input.entityVersion,
    content: input.content,
    freshness: input.freshness ?? 'fresh',
    confidence: input.confidence ?? 0.95,
    relevanceScore: input.relevanceScore ?? 0.94,
    priority: input.priority ?? (input.critical ? 92 : 84),
    permissionRequirements: ['authenticated_user', 'active_tenant', input.permission],
    staleAfter: input.staleAfter,
    critical: input.critical,
    reason: input.reason,
  };
}

function notRequested(source: ChatContextSource, observedAt: string): CollectorResult {
  return unknown(source, observedAt, 'source_not_requested_for_turn');
}

function available(
  source: ChatContextSource,
  observedAt: string,
  items: ChatContextItem[],
  staleAfter: string,
  reasonCode?: string,
): CollectorResult {
  return {
    source,
    items,
    diagnostic: { source, status: 'available', observedAt, staleAfter, ...(reasonCode ? { reasonCode } : {}) },
  };
}

function empty(
  source: ChatContextSource,
  observedAt: string,
  reasonCode: string,
  items: ChatContextItem[] = [],
): CollectorResult {
  return { source, items, diagnostic: { source, status: 'empty', observedAt, reasonCode } };
}

function failed(source: ChatContextSource, observedAt: string, reasonCode: string): CollectorResult {
  return { source, items: [], diagnostic: { source, status: 'failed', observedAt, reasonCode } };
}

function stale(
  source: ChatContextSource,
  observedAt: string,
  items: ChatContextItem[],
  staleAfter: string,
  reasonCode: string,
): CollectorResult {
  return { source, items, diagnostic: { source, status: 'stale', observedAt, staleAfter, reasonCode } };
}

function permissionDenied(source: ChatContextSource, observedAt: string, reasonCode: string): CollectorResult {
  return { source, items: [], diagnostic: { source, status: 'permission_denied', observedAt, reasonCode } };
}

function unknown(source: ChatContextSource, observedAt: string, reasonCode: string): CollectorResult {
  return { source, items: [], diagnostic: { source, status: 'unknown', observedAt, reasonCode } };
}

function coarseRecoverySignal(event: ReadinessEventRow, consent: Set<string>): 'normal' | 'caution' | 'unknown' {
  if (consent.has('hrv_status') && event.hrv_status && ['low', 'unbalanced', 'poor'].includes(event.hrv_status)) return 'caution';
  if (consent.has('resting_hr') && event.resting_hr_status === 'elevated') return 'caution';
  if ((consent.has('hrv_status') && event.hrv_status === 'balanced')
    || (consent.has('resting_hr') && event.resting_hr_status === 'normal')) return 'normal';
  return 'unknown';
}

function activityType(activity: GarminActivity): string {
  return safeEnum(activity.activityType?.typeKey, 'unknown').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
}

function safeLabel(value: unknown, maxChars: number): string {
  try {
    const parsed = JSON.parse(sanitizeForPromptInterpolation(value));
    return String(parsed || '(untitled)').slice(0, maxChars);
  } catch {
    return '(unavailable)';
  }
}

function safeEnum(value: unknown, fallback: string): string {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60);
  return normalized || fallback;
}

function safeIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeVersion(value: unknown, fallback: unknown): string {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : opaqueRef(JSON.stringify(fallback));
  return normalized.slice(0, 160);
}

function normalizeObservedAt(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const candidate = /Z$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function opaqueRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function staleAfterFrom(observedAt: string): string {
  return new Date(Date.parse(observedAt) + LIVE_STALE_AFTER_MS).toISOString();
}

function safeTimezone(userId: number): string {
  try {
    const timezone = getUserTimezone(userId);
    return DateTime.now().setZone(timezone).isValid ? timezone : 'UTC';
  } catch {
    return 'UTC';
  }
}

function submoduleEnabled(name: 'tasks' | 'calendar' | 'email' | 'reminders'): boolean {
  try {
    return isSubmoduleEnabled('secretary', name);
  } catch {
    return false;
  }
}

function isValidScope(userId: number, tenantId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0 && Number.isSafeInteger(tenantId) && tenantId > 0;
}
