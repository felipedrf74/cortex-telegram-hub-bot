// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Secretary mesh adapter. */

import { DateTime } from 'luxon';
import {
  getFocusBlockRecommendation,
  type FocusBusyInterval,
  type FocusPlanningWindow,
} from '../focus-planner';
import { getPendingTasks } from '../task-store/unified-task-store';
import type { NormalizedTask } from '../task-store/types';
import {
  getEventsWithDiagnostics,
  hasWritableCalendarForUser,
  type UnifiedCalendarEvent,
} from '../unified-calendar';
import { getUnreadMailSummaryForUser } from '../unified-mail-pressure';
import { getUserTimezoneById } from '../user-service';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../tenant-scope-observability';
import { getDb } from '../database';
import {
  degradedPlanSource,
  readyPlanSource,
  unavailablePlanSource,
  type PlanSourceHealth,
} from '../secretary-planning-context';
import {
  getSecretaryRoutineProfile,
  type SecretaryProtectedRoutine,
  type SecretaryRoutineProfile,
} from '../secretary-routine-profile';
import type { MeshSignalDraft, SecretaryMeshAgendaItem, SecretaryMeshContext } from './types';
import {
  endOfDayIso,
  reportInvalidMeshScope,
  resolveWeekWindow,
  roundTo,
  uniqueStrings,
} from './mesh-common';

interface ScheduleObservation {
  summary: string;
  start: string;
  routineKind?: SecretaryMeshAgendaItem['routineKind'];
}

export function createEmptySecretaryMeshContext(opts: {
  userId: number;
  weekStart?: string;
  timezone?: string;
}): SecretaryMeshContext {
  const window = resolveWeekWindow(opts.weekStart, opts.timezone);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events: [],
    focusBlock: null,
    dueToday: [],
    dueThisWeek: [],
    overdue: [],
    pending: [],
    writableCalendar: false,
    localAgendaItems: [],
    sourceHealth: {
      calendar: unavailablePlanSource('CALENDAR_STATE_UNAVAILABLE', 'Calendar state is unavailable.'),
      tasks: unavailablePlanSource('TASK_STATE_UNAVAILABLE', 'Task state is unavailable.'),
      mail: unavailablePlanSource('MAIL_STATE_UNAVAILABLE', 'Mail state is unavailable.'),
      focus: unavailablePlanSource('FOCUS_STATE_UNAVAILABLE', 'Focus-window state is unavailable.'),
    },
    warningCodes: [
      'CALENDAR_STATE_UNAVAILABLE',
      'TASK_STATE_UNAVAILABLE',
      'MAIL_STATE_UNAVAILABLE',
      'FOCUS_STATE_UNAVAILABLE',
    ],
    warnings: [
      'Calendar state is unavailable.',
      'Task state is unavailable.',
      'Mail state is unavailable.',
      'Focus-window state is unavailable.',
    ],
    derivedSignals: [],
  };
}
export async function readSecretaryMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
  timezone?: string;
  /** Captured request-local date used for "today" when it falls in this week. */
  referenceDate?: string;
}): Promise<SecretaryMeshContext> {
  const tenantId = opts.tenantId ?? opts.userId;
  if (!isValidTenantUserId(opts.userId)
      || !isValidTenantUserId(tenantId)
      || tenantId !== opts.userId) {
    reportInvalidMeshScope('read_secretary_mesh_context', opts.userId, opts.weekStart);
    recordTenantScopeAnomaly({
      layer: 'mesh_context',
      operation: 'read_secretary_mesh_context',
      reason: 'tenant_mismatch',
      userId: opts.userId,
      details: { tenantId: opts.tenantId ?? null, weekStart: opts.weekStart ?? null },
    });
    return createEmptySecretaryMeshContext(opts);
  }

  const requestedTimezone = opts.timezone ?? readUserTimezone(opts.userId);
  const window = resolveWeekWindow(opts.weekStart, requestedTimezone);
  const timezone = window.start.zoneName || requestedTimezone || 'UTC';
  const capturedNowUtc = DateTime.utc();
  const routineResult = readRoutineProfile({ userId: opts.userId, tenantId });
  const routineExpansion = routineResult.ok && routineResult.profile.status === 'configured'
    ? expandProtectedRoutines(routineResult.profile.protectedRoutines, window.start, window.end, timezone)
    : { items: [] as SecretaryMeshAgendaItem[], skippedDstWindows: false };
  const focusAvailability = routineResult.ok && routineResult.profile.status === 'configured'
    ? explicitFocusAvailability(routineResult.profile)
    : [];
  const [calendarResult, mailPressureResult, localAgendaResult] = await Promise.allSettled([
    getEventsWithDiagnostics(window.start.toUTC().toISO()!, window.end.endOf('day').toUTC().toISO()!, opts.userId),
    getUnreadMailSummaryForUser(opts.userId),
    Promise.resolve().then(() => readLocalAgendaItems({
      userId: opts.userId,
      tenantId,
      start: window.start,
      end: window.end,
    })),
  ]);

  const calendarFetch = calendarResult.status === 'fulfilled' ? calendarResult.value : null;
  const events = calendarFetch?.events ?? [];
  const localAgendaItems = [
    ...(localAgendaResult.status === 'fulfilled' ? localAgendaResult.value : []),
    ...routineExpansion.items,
  ].filter((item) => !isRepresentedByProvider(item, events) && !matchesProviderObservation(item, events));
  const routineScheduleAvailable = routineResult.ok && !routineExpansion.skippedDstWindows;
  const calendarHealth = resolveCalendarHealth(
    calendarFetch,
    localAgendaResult.status === 'fulfilled',
    routineScheduleAvailable,
  );
  let focusResult: PromiseSettledResult<Awaited<ReturnType<typeof getFocusBlockRecommendation>>> = {
    status: 'fulfilled',
    value: null,
  };
  if (calendarHealth.status === 'ready'
      && routineResult.ok
      && routineResult.profile.status === 'configured'
      && focusAvailability.length > 0) {
    try {
      focusResult = {
        status: 'fulfilled',
        value: await getFocusBlockRecommendation(opts.userId, {
          tenantId,
          horizonDays: 7,
          startDate: window.weekStart,
          timezone,
          availabilityWindows: focusAvailability,
          additionalBusyIntervals: routineExpansion.items.map((item) => ({
            start: item.startAt,
            end: item.endAt,
          } satisfies FocusBusyInterval)),
          // One canonical calendar read feeds both source health and focus
          // placement. A second read could disagree or fail and falsely turn
          // a busy period into a free recommendation.
          calendarEvents: events,
        }),
      };
    } catch (reason) {
      focusResult = { status: 'rejected', reason };
    }
  }
  const focusHealth = resolveFocusHealth({
    calendarHealth,
    routineResult,
    focusResult,
    skippedDstWindows: routineExpansion.skippedDstWindows,
  });
  // A focus recommendation is not safe capacity evidence unless calendar reads
  // are complete. Suppress it instead of presenting a false clean window.
  const focusBlock = focusHealth.status !== 'unavailable' && focusResult.status === 'fulfilled'
    ? focusResult.value
    : null;
  const mailPressure = mailPressureResult.status === 'fulfilled' ? mailPressureResult.value : null;
  // Task projections must use the requested weekly snapshot, not SQLite's
  // process-global `date('now')`. For an explicitly requested date within the
  // week, that date owns "due today"; normalized callers pass the Monday.
  const requestedDate = requestedDateWithinWindow(
    opts.referenceDate,
    opts.weekStart,
    capturedNowUtc,
    window,
    timezone,
  );
  const mailHealth = resolveMailHealth(mailPressureResult);
  const taskResult = readTaskState({
    userId: opts.userId,
    tenantId,
    requestedDate,
    weekEnd: window.weekEnd,
    timezone,
  });
  const { dueToday, dueThisWeek, overdue, pending } = taskResult;
  const writableCalendar = readWritableCalendar(opts.userId);

  const observations: ScheduleObservation[] = [
    ...events.map((event) => ({ summary: String(event.summary ?? ''), start: String(event.start ?? '') })),
    ...localAgendaItems.map((item) => ({
      summary: item.title,
      start: item.startAt,
      routineKind: item.routineKind,
    })),
  ];
  const busyDates = summarizeBusyObservationDates(observations, timezone);
  const travelDates = extractTravelObservationDates(observations, timezone);
  const fragmentation = summarizeObservationFragmentation(observations, timezone);
  const criticalMeetings = summarizeMeetingCriticality(observations, timezone);
  const portability = summarizeTaskPortability(pending);
  const deadlinePressure = summarizeDeadlinePressure({
    overdueCount: overdue.length,
    dueTodayCount: dueToday.length,
    dueThisWeekCount: dueThisWeek.length,
    pendingCount: pending.length,
    mailUnreadTotal: mailPressure?.totalUnread ?? 0,
  });
  const workloadPressureReady = taskResult.health.status === 'ready'
    && mailHealth.status === 'ready';
  const derivedSignals: MeshSignalDraft[] = [];

  if (busyDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_busy_blocks',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: busyDates,
        totalEvents: observations.length,
      },
    });
  }

  if (travelDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'travel_window',
      meshPriority: 1,
      priority: 'urgent',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: travelDates,
      },
    });
  }

  // Consumers use absence as "unknown" and numeric zero as confirmed empty.
  // Do not publish a zero-filled workload signal when either backing source is
  // partial or unavailable: that would silently turn a failed read into normal
  // capacity in Training and Decision Center orchestration.
  if (workloadPressureReady) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'inbox_pressure',
      meshPriority: deadlinePressure.level === 'high' ? 2 : 4,
      priority: deadlinePressure.level === 'high' ? 'urgent' : overdue.length > 0 ? 'normal' : 'background',
      expiresAt: endOfDayIso(window.start),
      payload: {
        overdueCount: overdue.length,
        dueTodayCount: dueToday.length,
        dueThisWeekCount: dueThisWeek.length,
        pendingCount: pending.length,
        mailUnreadTotal: mailPressure!.totalUnread,
        mailProviders: mailPressure!.configuredProviders,
        outlookUnread: mailPressure!.outlookUnread,
        gmailUnread: mailPressure!.gmailUnread,
      },
    });
  }

  if (fragmentation.fragmentedDates.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'calendar_fragmentation',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: fragmentation.fragmentedDates,
        fragmentedDayCount: fragmentation.fragmentedDates.length,
        maxEventsInDay: fragmentation.maxEventsInDay,
      },
    });
  }

  if (criticalMeetings.criticalEventCount > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'meeting_criticality',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        criticalEventCount: criticalMeetings.criticalEventCount,
        dates: criticalMeetings.dates,
        examples: criticalMeetings.examples,
      },
    });
  }

  if (workloadPressureReady && deadlinePressure.level !== 'low') {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'deadline_pressure',
      meshPriority: deadlinePressure.level === 'high' ? 1 : 2,
      priority: deadlinePressure.level === 'high' ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.start),
      payload: deadlinePressure,
    });
  }

  if (taskResult.health.status === 'ready'
      && (portability.fixedCount > 0 || portability.portableCount > 0)) {
    derivedSignals.push({
      sourceAgent: 'mesh.secretary-context',
      signalType: 'task_portability',
      meshPriority: 3,
      priority: 'background',
      expiresAt: endOfDayIso(window.start),
      payload: portability,
    });
  }

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    events,
    focusBlock,
    dueToday,
    dueThisWeek,
    overdue,
    pending,
    writableCalendar,
    mailPressure,
    localAgendaItems,
    sourceHealth: {
      calendar: calendarHealth,
      tasks: taskResult.health,
      mail: mailHealth,
      focus: focusHealth,
    },
    warningCodes: uniqueStrings([
      ...calendarHealth.warningCodes,
      ...taskResult.health.warningCodes,
      ...mailHealth.warningCodes,
      ...focusHealth.warningCodes,
    ]),
    warnings: uniqueStrings([
      ...calendarHealth.warnings,
      ...taskResult.health.warnings,
      ...mailHealth.warnings,
      ...focusHealth.warnings,
    ]),
    derivedSignals,
  };
}

function requestedDateWithinWindow(
  referenceDate: string | undefined,
  requestedWeekDate: string | undefined,
  capturedNowUtc: DateTime,
  window: ReturnType<typeof resolveWeekWindow>,
  timezone: string,
): string {
  for (const candidate of [
    referenceDate,
    capturedNowUtc.setZone(timezone).toISODate() ?? undefined,
    requestedWeekDate,
  ]) {
    if (!candidate) continue;
    const requested = DateTime.fromISO(candidate, { zone: timezone }).toISODate();
    if (requested && requested >= window.weekStart && requested <= window.weekEnd) return requested;
  }
  return window.weekStart;
}

function taskDueDateInZone(value: string | null | undefined, timezone: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const hasExplicitZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
  const parsed = dateOnly || !hasExplicitZone
    ? DateTime.fromISO(raw, { zone: timezone })
    : DateTime.fromISO(raw, { setZone: true }).setZone(timezone);
  return parsed.isValid ? parsed.toISODate() : null;
}

function summarizeMeetingCriticality(events: ScheduleObservation[], timezone: string): {
  criticalEventCount: number;
  dates: string[];
  examples: string[];
} {
  const regex = /\b(client|cliente|interview|entrevista|doctor|m[eé]dico|meeting|reuni[aã]o|call|sponsor|patroc[ií]nio|filming|shoot|flight|voo|deadline)\b/i;
  const critical = events.filter((event) => regex.test(String(event.summary ?? '')));
  return {
    criticalEventCount: critical.length,
    dates: uniqueStrings(critical.map((event) => localDate(event.start, timezone))),
    examples: critical
      .slice(0, 3)
      .map((event) => String(event.summary ?? '').trim())
      .filter(Boolean),
  };
}

function resolveCalendarHealth(
  calendar: Awaited<ReturnType<typeof getEventsWithDiagnostics>> | null,
  localAgendaAvailable: boolean,
  routineScheduleAvailable: boolean,
): PlanSourceHealth {
  if (!calendar) {
    return localAgendaAvailable && routineScheduleAvailable
      ? degradedPlanSource('CALENDAR_PROVIDER_UNAVAILABLE', 'Provider calendar state is unavailable; Nexus-owned commitments are still included.')
      : unavailablePlanSource('CALENDAR_STATE_UNAVAILABLE', 'Calendar state is unavailable.');
  }
  if (calendar.status === 'ready' && localAgendaAvailable && routineScheduleAvailable) {
    return readyPlanSource();
  }
  if (calendar.status === 'unavailable' && (!localAgendaAvailable || !routineScheduleAvailable)) {
    return {
      status: 'unavailable',
      warningCodes: calendar.warningCodes.length > 0 ? calendar.warningCodes : ['CALENDAR_STATE_UNAVAILABLE'],
      warnings: calendar.warnings.length > 0 ? calendar.warnings : ['Calendar state is unavailable.'],
    };
  }
  return {
    status: 'degraded',
    warningCodes: uniqueStrings([
      ...calendar.warningCodes,
      ...(localAgendaAvailable ? [] : ['SECRETARY_AGENDA_UNAVAILABLE']),
      ...(routineScheduleAvailable ? [] : ['SECRETARY_ROUTINE_SCHEDULE_UNAVAILABLE']),
    ]),
    warnings: uniqueStrings([
      ...calendar.warnings,
      ...(localAgendaAvailable ? [] : ['Nexus-owned agenda commitments are unavailable.']),
      ...(routineScheduleAvailable ? [] : ['Protected routine commitments are unavailable.']),
    ]),
  };
}

function resolveFocusHealth(input: {
  calendarHealth: PlanSourceHealth;
  routineResult: RoutineProfileRead;
  focusResult: PromiseSettledResult<Awaited<ReturnType<typeof getFocusBlockRecommendation>>>;
  skippedDstWindows: boolean;
}): PlanSourceHealth {
  if (input.calendarHealth.status !== 'ready') {
    return unavailablePlanSource(
      'FOCUS_BLOCKED_BY_CALENDAR_STATE',
      'Focus-window suggestions are unavailable until calendar state is current.',
    );
  }
  if (!input.routineResult.ok) {
    return unavailablePlanSource(
      'SECRETARY_ROUTINE_UNAVAILABLE',
      'Focus-window suggestions are unavailable because routine preferences could not be read.',
    );
  }
  if (input.routineResult.profile.status === 'unconfigured') {
    return unavailablePlanSource(
      'SECRETARY_ROUTINE_UNCONFIGURED',
      'Set up Secretary routine preferences before requesting a focus window.',
    );
  }
  if (input.focusResult.status === 'rejected') {
    return unavailablePlanSource('FOCUS_RECOMMENDATION_UNAVAILABLE', 'Focus-window state is unavailable.');
  }
  return input.skippedDstWindows
    ? degradedPlanSource(
        'SECRETARY_ROUTINE_DST_WINDOW_SKIPPED',
        'A routine window does not exist on this daylight-saving transition date and was skipped.',
      )
    : readyPlanSource();
}

function resolveMailHealth(
  result: PromiseSettledResult<Awaited<ReturnType<typeof getUnreadMailSummaryForUser>>>,
): PlanSourceHealth {
  if (result.status === 'rejected') {
    return unavailablePlanSource('MAIL_STATE_UNAVAILABLE', 'Mail state is unavailable.');
  }
  const summary = result.value;
  if (summary.configuredProviders.length === 0) {
    return unavailablePlanSource('MAIL_INTEGRATION_MISSING', 'No mail integration is connected yet.');
  }
  const fulfilled = [summary.outlookUnread, summary.gmailUnread]
    .filter((value) => typeof value === 'number').length;
  if (fulfilled === summary.configuredProviders.length) return readyPlanSource();
  if (fulfilled > 0) {
    return degradedPlanSource('MAIL_PROVIDER_DEGRADED', 'Some mail provider state is unavailable.');
  }
  return unavailablePlanSource('MAIL_STATE_UNAVAILABLE', 'Mail state is unavailable.');
}

function readTaskState(input: {
  userId: number;
  tenantId: number;
  requestedDate: string;
  weekEnd: string;
  timezone: string;
}): {
  dueToday: NormalizedTask[];
  dueThisWeek: NormalizedTask[];
  overdue: NormalizedTask[];
  pending: NormalizedTask[];
  health: PlanSourceHealth;
} {
  const read = readTaskList(() => getPendingTasks(input.userId, input.tenantId));
  const pending = read.value;
  const dueDate = (task: NormalizedTask) => taskDueDateInZone(task.dueDate, input.timezone);
  return {
    dueToday: pending.filter((task) => dueDate(task) === input.requestedDate),
    dueThisWeek: pending.filter((task) => {
      const date = dueDate(task);
      return date !== null && date >= input.requestedDate && date <= input.weekEnd;
    }),
    overdue: pending.filter((task) => {
      const date = dueDate(task);
      return date !== null && date < input.requestedDate;
    }),
    pending,
    health: read.ok
      ? readyPlanSource()
      : unavailablePlanSource('TASK_STATE_UNAVAILABLE', 'Task state is unavailable.'),
  };
}

function readTaskList(read: () => NormalizedTask[]): { ok: boolean; value: NormalizedTask[] } {
  try {
    return { ok: true, value: read() };
  } catch {
    return { ok: false, value: [] };
  }
}

function readWritableCalendar(userId: number): boolean {
  try {
    return hasWritableCalendarForUser(userId);
  } catch {
    return false;
  }
}

function readUserTimezone(userId: number): string {
  try {
    return getUserTimezoneById(userId);
  } catch {
    return 'UTC';
  }
}

function readLocalAgendaItems(input: {
  userId: number;
  tenantId: number;
  start: import('luxon').DateTime;
  end: import('luxon').DateTime;
}): SecretaryMeshAgendaItem[] {
  const rows = getDb().prepare(`
    SELECT title, start_at, end_at, provider_event_id, provider_source
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
       AND start_at IS NOT NULL
       AND end_at IS NOT NULL
  `).all(input.userId, String(input.tenantId)) as Array<{
    title: string;
    start_at: string;
    end_at: string;
    provider_event_id: string | null;
    provider_source: 'google' | 'outlook' | null;
  }>;

  return rows.filter((row) => {
    const start = DateTime.fromISO(row.start_at, { setZone: true });
    const end = DateTime.fromISO(row.end_at, { setZone: true });
    return start.isValid && end.isValid && start < input.end && end > input.start;
  }).map((row) => ({
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    providerEventId: row.provider_event_id,
    providerSource: row.provider_source,
  }));
}

type RoutineProfileRead =
  | { ok: true; profile: SecretaryRoutineProfile }
  | { ok: false };

function readRoutineProfile(scope: { userId: number; tenantId: number }): RoutineProfileRead {
  try {
    return { ok: true, profile: getSecretaryRoutineProfile(scope) };
  } catch {
    return { ok: false };
  }
}

function explicitFocusAvailability(profile: SecretaryRoutineProfile): FocusPlanningWindow[] {
  const source = profile.preferredFocusWindows.length > 0
    ? profile.preferredFocusWindows
    : profile.workingWindows;
  return source.map((window) => ({
    weekdays: [...window.weekdays],
    start: window.start,
    end: window.end,
  }));
}

function expandProtectedRoutines(
  routines: SecretaryProtectedRoutine[],
  weekStart: DateTime,
  weekEnd: DateTime,
  timezone: string,
): { items: SecretaryMeshAgendaItem[]; skippedDstWindows: boolean } {
  const items: SecretaryMeshAgendaItem[] = [];
  let skippedDstWindows = false;
  for (let offset = 0; offset <= Math.floor(weekEnd.startOf('day').diff(weekStart.startOf('day'), 'days').days); offset += 1) {
    const day = weekStart.plus({ days: offset }).setZone(timezone).startOf('day');
    for (const routine of routines.filter((candidate) => candidate.weekdays.includes(day.weekday))) {
      const start = routineClockOnDay(day, routine.start);
      const end = routineClockOnDay(day, routine.end);
      if (!start || !end || start >= end) {
        skippedDstWindows = true;
        continue;
      }
      items.push({
        title: routine.label,
        startAt: start.toUTC().toISO()!,
        endAt: end.toUTC().toISO()!,
        providerEventId: null,
        providerSource: null,
        routineKind: routine.kind,
      });
    }
  }
  return { items, skippedDstWindows };
}

function routineClockOnDay(day: DateTime, clock: string): DateTime | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const value = day.set({
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: 0,
    millisecond: 0,
  });
  return value.isValid && value.toFormat('HH:mm') === clock ? value : null;
}

function isRepresentedByProvider(item: SecretaryMeshAgendaItem, events: UnifiedCalendarEvent[]): boolean {
  if (!item.providerEventId) return false;
  return events.some((event) => String(event.id ?? '') === item.providerEventId
    && (!item.providerSource || event.source === item.providerSource || event.syncedSources?.includes(item.providerSource)));
}

function matchesProviderObservation(item: SecretaryMeshAgendaItem, events: UnifiedCalendarEvent[]): boolean {
  const normalizedTitle = item.title.trim().toLocaleLowerCase();
  const itemStart = DateTime.fromISO(item.startAt, { setZone: true });
  const itemEnd = DateTime.fromISO(item.endAt, { setZone: true });
  if (!itemStart.isValid || !itemEnd.isValid) return false;
  return events.some((event) => {
    if (String(event.summary ?? '').trim().toLocaleLowerCase() !== normalizedTitle) return false;
    const eventStart = DateTime.fromISO(String(event.start ?? ''), { setZone: true });
    const eventEnd = DateTime.fromISO(String(event.end ?? ''), { setZone: true });
    return eventStart.isValid
      && eventEnd.isValid
      && eventStart.toUTC().toMillis() === itemStart.toUTC().toMillis()
      && eventEnd.toUTC().toMillis() === itemEnd.toUTC().toMillis();
  });
}

function summarizeBusyObservationDates(events: ScheduleObservation[], timezone: string): string[] {
  return datesMeetingThreshold(events, timezone, 3);
}

function summarizeObservationFragmentation(events: ScheduleObservation[], timezone: string): {
  fragmentedDates: string[];
  maxEventsInDay: number;
} {
  const counts = countByLocalDate(events, timezone);
  return {
    fragmentedDates: [...counts.entries()].filter(([, count]) => count >= 4).map(([date]) => date).sort(),
    maxEventsInDay: [...counts.values()].reduce((max, count) => Math.max(max, count), 0),
  };
}

function extractTravelObservationDates(events: ScheduleObservation[], timezone: string): string[] {
  const regex = /\b(flight|airport|hotel|travel|trip|voo|aeroporto|hotel|viagem)\b/i;
  return uniqueStrings(events
    .filter((event) => event.routineKind === 'travel' || regex.test(event.summary))
    .map((event) => localDate(event.start, timezone)));
}

function datesMeetingThreshold(events: ScheduleObservation[], timezone: string, threshold: number): string[] {
  return [...countByLocalDate(events, timezone).entries()]
    .filter(([, count]) => count >= threshold)
    .map(([date]) => date)
    .sort();
}

function countByLocalDate(events: ScheduleObservation[], timezone: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const date = localDate(event.start, timezone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

function localDate(value: string, timezone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const hasExplicitZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  const parsed = hasExplicitZone
    ? DateTime.fromISO(value, { setZone: true })
    : DateTime.fromISO(value, { zone: timezone });
  return parsed.isValid ? parsed.setZone(timezone).toISODate()! : String(value).slice(0, 10);
}

function summarizeTaskPortability(tasks: NormalizedTask[]): {
  fixedCount: number;
  portableCount: number;
  portableRatio: number;
} {
  const fixedCount = tasks.filter((task) => Boolean(task.dueDate)).length;
  const portableCount = Math.max(0, tasks.length - fixedCount);
  const portableRatio = tasks.length > 0 ? roundTo(portableCount / tasks.length, 2) : 0;
  return { fixedCount, portableCount, portableRatio };
}

function summarizeDeadlinePressure(opts: {
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
}): {
  level: 'low' | 'elevated' | 'high';
  overdueCount: number;
  dueTodayCount: number;
  dueThisWeekCount: number;
  pendingCount: number;
  mailUnreadTotal: number;
} {
  const level = opts.overdueCount > 0
    || opts.dueTodayCount >= 3
    || opts.mailUnreadTotal >= 20
    ? 'high'
    : opts.dueTodayCount > 0 || opts.dueThisWeekCount >= 4 || opts.mailUnreadTotal >= 8
      ? 'elevated'
      : 'low';
  return {
    level,
    overdueCount: opts.overdueCount,
    dueTodayCount: opts.dueTodayCount,
    dueThisWeekCount: opts.dueThisWeekCount,
    pendingCount: opts.pendingCount,
    mailUnreadTotal: opts.mailUnreadTotal,
  };
}
