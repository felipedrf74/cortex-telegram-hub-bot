// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../../config';
import { DateTime } from 'luxon';
import { getCached, getCachedSWR, setCache } from '../../services/cache-store';
import {
  getEvents as getGoogleCalendarEvents,
  isGoogleCalendarConfigured,
} from '../../services/google-calendar';
import {
  getEvents as getOutlookCalendarEvents,
  isOutlookCalendarConfigured,
} from '../../services/outlook-calendar';
import { getUserTimezoneById } from '../../services/user-service';
import { getAppleHealthSleepAgendaEvents } from '../../services/health-sleep-agenda';
import { filterCalendarEventsForTrainingScope } from '../../services/training-calendar-scope';
import { requireTenantIdParam } from '../../services/tenant-scope';

// Phase 17 hostile-QA fix (2026-05-18): 'stale' added so the dashboard
// can distinguish "snapshot last fetch failed; serving cached data"
// from fully-ready data. Secretary's all-clear gate (dashboard-home-
// input.ts:200) treats anything != 'ready' as "still confirming".
export type DashboardSectionStatus = 'ready' | 'stale' | 'degraded' | 'unavailable';

export interface DashboardSectionHealth {
  status: DashboardSectionStatus;
  warningCodes: string[];
  warnings: string[];
}

interface FetchTrainingDeps {
  calculateReadiness?: (userId: number) => Promise<any>;
  getEvents?: (start: string, end: string, userId: number) => Promise<any[]>;
}

const DASHBOARD_READINESS_CACHE_TTL = 300;

function dashboardReadinessCacheKeyFor(userId: number): string {
  return `dashboard-readiness:${userId}`;
}

function extractTime(dateInput: any, timezone = config.app.timezone || 'Europe/Lisbon'): string {
  if (!dateInput) return '';
  const raw = typeof dateInput === 'string' ? dateInput : dateInput.dateTime || dateInput.date || String(dateInput);
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone });
    }
  } catch {}
  const match = raw.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function extractRawDateTime(dateInput: any): string | null {
  if (!dateInput) return null;
  if (typeof dateInput === 'string') return dateInput;
  if (typeof dateInput === 'object') {
    return coerceNullableString(dateInput.dateTime || dateInput.date);
  }
  return coerceNullableString(dateInput);
}

function extractTitle(e: any): string {
  return e.subject || e.summary || e.title || e.displayName || e.name || '(No title)';
}

function coerceString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function coerceNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function coerceTaskImportance(value: unknown): 'low' | 'normal' | 'high' {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : '') {
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    default:
      return 'normal';
  }
}

function coerceTaskStatus(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : 'notStarted';
}

function normalizeBodyBattery(bb: any): number | null {
  if (bb === null || bb === undefined) return null;
  if (typeof bb === 'number') {
    const rounded = Math.round(bb);
    return rounded > 0 ? rounded : null;
  }
  if (typeof bb === 'object') {
    const val = bb.current !== undefined ? bb.current
      : bb.charged !== undefined ? bb.charged
      : bb.score !== undefined ? bb.score
      : null;
    if (val === null || val === undefined) return null;
    const rounded = Math.round(Number(val));
    return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
  }
  return null;
}

export function mapCalendarEvent(e: any, source: string, timezone = config.app.timezone || 'Europe/Lisbon') {
  const title = coerceString(extractTitle(e), '(No title)');
  const start = extractTime(e?.start, timezone);
  const end = extractTime(e?.end, timezone);
  const rawStart = extractRawDateTime(e?.start);
  const rawEnd = extractRawDateTime(e?.end);
  const explicitId = coerceNullableString(e?.id);

  return {
    id: explicitId ?? `${source}:${title}:${start}:${end}`,
    title,
    start,
    end,
    ...(rawStart ? { rawStart } : {}),
    ...(rawEnd ? { rawEnd } : {}),
    source,
    category: coerceNullableString(e?.category ?? (Array.isArray(e?.categories) ? e.categories[0] : null)),
    color: coerceNullableString(e?.color),
    isAllDay: !!e?.isAllDay,
  };
}

export function mapDashboardTask(t: any, index = 0) {
  const title = coerceString(t?.title, '(Untitled task)');
  const dueDateTime = coerceNullableString(t?.dueDateTime?.dateTime || t?.dueDateTime);
  const createdDateTime = coerceNullableString(t?.createdDateTime);
  const explicitId = coerceNullableString(t?.id);

  return {
    id: explicitId ?? `task:${title}:${dueDateTime ?? createdDateTime ?? index}`,
    title,
    body: coerceNullableString(t?.body?.content),
    importance: coerceTaskImportance(t?.importance),
    status: coerceTaskStatus(t?.status),
    dueDateTime,
    listId: coerceNullableString(t?.listId),
    listName: coerceNullableString(t?.listName),
    checklistItems: null,
    createdDateTime,
  };
}

export async function fetchCalendar(userId?: number, tenantId?: number) {
  return fetchCalendarForUser(userId, tenantId);
}

async function fetchCalendarForUser(userId?: number, tenantId?: number) {
  const scopedTenantId = userId ? requireTenantIdParam(tenantId, 'fetchCalendar') : undefined;
  const zone = getUserTimezoneById(userId);
  const today = DateTime.now().setZone(zone);
  const actualStart = today.startOf('day');
  const actualEnd = today.endOf('day');
  const start = actualStart.minus({ days: 1 }).toUTC().toISO()!;
  const end = actualEnd.plus({ days: 1 }).toUTC().toISO()!;

  const fetchers: Array<{
    provider: 'outlook' | 'google';
    run: () => Promise<any[]>;
  }> = [];
  const warningCodes: string[] = [];
  const warnings: string[] = [];

  const googleConfigured = isGoogleCalendarConfigured(userId);
  if (googleConfigured) {
    fetchers.push({
      provider: 'google',
      run: async () => {
        const events = await getGoogleCalendarEvents(start, end, userId);
        return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'google', zone)) : [];
      },
    });
  }

  const outlookConfigured = isOutlookCalendarConfigured(userId);
  if (outlookConfigured) {
    fetchers.push({
      provider: 'outlook',
      run: async () => {
        const events = await getOutlookCalendarEvents(start, end, userId);
        return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'outlook', zone)) : [];
      },
    });
  }

  if (!googleConfigured && !outlookConfigured) {
    warningCodes.push('CALENDAR_INTEGRATION_MISSING');
    warnings.push('No calendar integration is connected yet.');
  }

  const results = await Promise.allSettled(fetchers.map((fetcher) => fetcher.run()));

  const allProviderEvents: any[] = [];
  let fulfilledProviders = 0;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      fulfilledProviders += 1;
      allProviderEvents.push(...result.value);
      return;
    }

    const provider = fetchers[index]?.provider;
    if (provider === 'google') {
      warningCodes.push('GOOGLE_CALENDAR_UNAVAILABLE');
      warnings.push('Google Calendar is unavailable right now.');
    } else if (provider === 'outlook') {
      warningCodes.push('OUTLOOK_CALENDAR_UNAVAILABLE');
      warnings.push('Outlook Calendar is unavailable right now.');
    } else {
      warningCodes.push('CALENDAR_UNAVAILABLE');
      warnings.push('Calendar data is unavailable right now.');
    }
  });

  const sleepEvents = userId
    ? getAppleHealthSleepAgendaEvents({
        userId,
        start: actualStart.toUTC().toISO()!,
        end: actualEnd.toUTC().toISO()!,
        timezone: zone,
      }).map((event) => mapCalendarEvent(event, 'apple_health', zone))
    : [];

  const visibleProviderEvents = userId
    ? filterCalendarEventsForTrainingScope(allProviderEvents, userId, scopedTenantId)
    : allProviderEvents;
  const allEvents = [...visibleProviderEvents, ...sleepEvents].sort((a, b) => a.start.localeCompare(b.start));
  const localHealthSources = sleepEvents.length > 0 ? 1 : 0;
  return {
    today: allEvents.filter((event) => eventOverlapsRange(event, actualStart, actualEnd, zone)),
    upcoming: [],
    ...buildSectionHealth(
      fulfilledProviders + localHealthSources,
      fetchers.length + localHealthSources,
      warningCodes,
      warnings,
      'CALENDAR_UNAVAILABLE',
      'Calendar data is unavailable right now.',
    ),
  };
}

function eventOverlapsRange(
  event: { start?: any; end?: any; rawStart?: any; rawEnd?: any },
  rangeStart: DateTime,
  rangeEnd: DateTime,
  timezone?: string,
): boolean {
  const zone = timezone || config.app.timezone || 'Europe/Lisbon';
  const eventStart = parseCalendarBoundary(event.rawStart ?? event.start, zone);
  const eventEnd = parseCalendarBoundary(event.rawEnd ?? event.end, zone);
  if (!eventStart.isValid || !eventEnd.isValid) return true;
  return eventEnd > rangeStart.toUTC() && eventStart < rangeEnd.toUTC();
}

function parseCalendarBoundary(input: any, zone: string): DateTime {
  const raw = extractRawDateTime(input);
  if (!raw) return DateTime.invalid('missing calendar boundary');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return DateTime.fromISO(raw, { zone }).startOf('day').toUTC();
  }
  const hasExplicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  const parsed = DateTime.fromISO(raw, hasExplicitZone ? { setZone: true } : { zone });
  return parsed.isValid ? parsed.toUTC() : parsed;
}

export async function fetchTasks(userId: number) {
  const cachedWorkingSet = getCachedSWR<any>(`u:${userId}:tasks-working-set`);
  if (cachedWorkingSet?.value?.smartCounts) {
    const snapshot = cachedWorkingSet.value;
    const topTasks = Array.isArray(snapshot.activePage?.tasks)
      ? snapshot.activePage.tasks.slice(0, 5).map((t: any, index: number) => mapDashboardTask(t, index))
      : [];
    return {
      overdue: Number(snapshot.smartCounts.overdue || 0),
      dueToday: Number(snapshot.smartCounts.dueToday || 0),
      totalPending: Array.isArray(snapshot.activePage?.tasks)
        ? Math.max(Number(snapshot.activePage.tasks.length || 0), sumActiveCounts(snapshot.activeCountsByList))
        : sumActiveCounts(snapshot.activeCountsByList),
      topTasks,
      snapshot: {
        source: 'tasks-working-set',
        freshness: snapshot.freshness ?? null,
        cached: true,
      },
      // Phase 17 hostile-QA fix (2026-05-18): propagate 'stale' as a
      // first-class state, not collapsed into 'ready'. tasks.ts:248-256
      // sets state='stale' on provider failure; Secretary's gate at
      // dashboard-home-input.ts:200 must see that distinction to avoid
      // calling a day clear while tasks are stale.
      status: snapshot.freshness?.state === 'degraded'
        ? 'degraded' as const
        : snapshot.freshness?.state === 'stale'
          ? 'stale' as const
          : 'ready' as const,
      warningCodes: Array.isArray(snapshot.freshness?.reasonCodes)
        && (snapshot.freshness.state === 'degraded' || snapshot.freshness.state === 'stale')
        ? snapshot.freshness.reasonCodes
        : [],
      warnings: [],
    };
  }

  const { getTaskProviderForUser } = require('../../services/task-store/task-router');
  const todo = getTaskProviderForUser(userId);
  const allTasksResult = await todo.getAllPendingTasks();
  const tasks = allTasksResult?.data || allTasksResult || [];
  if (!allTasksResult?.success || !Array.isArray(tasks)) {
    return buildUnavailableSection(
      { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] },
      ['TASKS_UNAVAILABLE'],
      ['Task data is unavailable right now.'],
    );
  }

  const zone = getUserTimezoneById(userId);
  const now = new Date();
  // MS Graph stores due dates as T23:00:00 UTC for the "previous" day in European TZ.
  // Example: "due April 7" = "2026-04-06T23:00:00" in UTC = April 7 in Lisbon.
  // To compare correctly, use the DATE PORTION ONLY (first 10 chars of ISO string).
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: zone }); // "2026-04-06"

  function getDueDateStr(t: any): string | null {
    const raw = t.dueDateTime?.dateTime || t.dueDateTime;
    if (!raw) return null;
    // MS Graph: "2026-04-06T23:00:00.0000000" → add 1 hour to get Lisbon date
    const d = new Date(raw);
    return d.toLocaleDateString('en-CA', { timeZone: zone }); // "2026-04-07"
  }

  const overdue = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr && dueStr < todayStr;
  }).length;

  const dueToday = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr === todayStr;
  }).length;

  const topTasks = tasks.slice(0, 5).map((t: any, index: number) => mapDashboardTask(t, index));

  return {
    overdue,
    dueToday,
    totalPending: tasks.length,
    topTasks,
    snapshot: {
      source: 'provider-pending',
      freshness: { state: 'fresh', generatedAt: new Date().toISOString(), reasonCodes: [] },
      cached: false,
    },
    status: 'ready' as const,
    warningCodes: [],
    warnings: [],
  };
}

function sumActiveCounts(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value as Record<string, unknown>)
    .reduce((sum: number, count: unknown) => sum + (Number.isFinite(Number(count)) ? Number(count) : 0), 0);
}

export async function fetchTraining(
  userId: number,
  tenantIdOrDeps: number | FetchTrainingDeps = userId,
  maybeDeps: FetchTrainingDeps = {},
) {
  const tenantId = typeof tenantIdOrDeps === 'number' ? tenantIdOrDeps : userId;
  const deps = typeof tenantIdOrDeps === 'number' ? maybeDeps : tenantIdOrDeps;
  let readinessScore: number | null = null;
  let bodyBattery: number | null = null;
  let readinessStatus: DashboardSectionStatus = 'ready';
  let bodyBatteryStatus: DashboardSectionStatus = 'ready';
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  const zone = getUserTimezoneById(userId);
  const today = DateTime.now().setZone(zone);
  const startOfDay = today.startOf('day');
  const endOfDay = today.endOf('day');

  // Provider-agnostic readiness: calculateReadiness() handles Garmin → Apple Health → neutral
  // fallback internally. No need for the dashboard to branch by provider.
  const cachedReadiness = getCached<{ score: number; bodyBattery: number | null; reasonCode?: string | null }>(
    dashboardReadinessCacheKeyFor(userId),
  );
  const shouldUseCachedReadiness = cachedReadiness
    && (cachedReadiness.bodyBattery != null || isSyntheticNeutralCachedReadiness(cachedReadiness));
  const readinessPromise = shouldUseCachedReadiness
    ? Promise.resolve({ source: 'cache' as const, readiness: cachedReadiness })
    : (async () => {
      const calculateReadiness = deps.calculateReadiness
        ?? require('../../services/readiness-scorer').calculateReadiness;
      const readiness = await calculateReadiness(userId, { tenantId });
      return { source: 'fresh' as const, readiness };
    })();
  const eventsPromise = (async () => {
    const getEvents = deps.getEvents
      ?? require('../../services/unified-calendar').getEvents;
    return await getEvents(
      startOfDay.minus({ days: 1 }).toUTC().toISO()!,
      endOfDay.plus({ days: 1 }).toUTC().toISO()!,
      userId,
    );
  })();

  const [readinessResult, eventsResult] = await Promise.allSettled([readinessPromise, eventsPromise]);
  if (readinessResult.status === 'fulfilled') {
    const { source, readiness } = readinessResult.value;
    if (source === 'cache') {
      if (isSyntheticNeutralCachedReadiness(readiness)) {
        readinessScore = null;
        bodyBattery = null;
        readinessStatus = 'unavailable';
        bodyBatteryStatus = 'unavailable';
        warningCodes.push('WEARABLE_INTEGRATION_MISSING', 'BODY_BATTERY_UNAVAILABLE');
        warnings.push(
          'Wearable integration is missing, so readiness is using a neutral fallback right now.',
          'Body Battery is unavailable right now.',
        );
      } else {
        readinessScore = readiness.score;
        bodyBattery = normalizeBodyBattery(readiness.bodyBattery);
      }
    } else if (isSyntheticNeutralReadiness(readiness)) {
      readinessScore = null;
      bodyBattery = null;
      readinessStatus = 'unavailable';
      bodyBatteryStatus = 'unavailable';
      warningCodes.push('WEARABLE_INTEGRATION_MISSING', 'BODY_BATTERY_UNAVAILABLE');
      warnings.push(
        'Wearable integration is missing, so readiness is using a neutral fallback right now.',
        'Body Battery is unavailable right now.',
      );
    } else {
      readinessScore = readiness?.score || null;
      bodyBattery = normalizeBodyBattery(readiness?.factors?.bodyBattery?.current);
    }

    if (readinessScore == null) {
      readinessStatus = 'unavailable';
      warningCodes.push('READINESS_UNAVAILABLE');
      warnings.push('Readiness data is unavailable right now.');
    }
    if (bodyBattery == null) {
      bodyBatteryStatus = 'unavailable';
      warningCodes.push('BODY_BATTERY_UNAVAILABLE');
      warnings.push('Body Battery is unavailable right now.');
    }

    if (source === 'fresh') {
      setCache(
        dashboardReadinessCacheKeyFor(userId),
        {
          score: readinessScore,
          bodyBattery,
          reasonCode: typeof readiness?.reasonCode === 'string' ? readiness.reasonCode : null,
        },
        DASHBOARD_READINESS_CACHE_TTL,
      );
    }
  } else {
    readinessStatus = 'unavailable';
    bodyBatteryStatus = 'unavailable';
    warningCodes.push('READINESS_UNAVAILABLE', 'BODY_BATTERY_UNAVAILABLE');
    warnings.push(
      'Readiness data is unavailable right now.',
      'Body Battery is unavailable right now.',
    );
  }

  let todaySession: any = null;
  try {
    const { getActivePlan, getCurrentWeek, getSessionsForWeek } = require('../../services/training-plans');
    const plan = getActivePlan(userId, tenantId);
    const currentWeek = plan ? getCurrentWeek(plan.id) : null;
    const sessions = currentWeek ? getSessionsForWeek(currentWeek.id) : null;
    if (Array.isArray(sessions) && sessions.length > 0) {
      const todayDow = today.toFormat('cccc');
      todaySession = sessions.find((s: any) => s?.day_of_week === todayDow) || null;
    }
  } catch {}

  if (!todaySession && eventsResult.status === 'fulfilled') {
    try {
      const events = eventsResult.value;
      const keywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength'];
      const trainingEvent = (events || []).find((e: any) => {
        if (!eventOverlapsRange(e, startOfDay, endOfDay, zone)) return false;
        const title = (e.subject || e.summary || e.title || '').toLowerCase();
        return keywords.some(kw => title.includes(kw));
      });
      if (trainingEvent) {
        const title = trainingEvent.subject || trainingEvent.summary || trainingEvent.title;
        const startRaw = trainingEvent.start?.dateTime || trainingEvent.start;
        const timeMatch = String(startRaw).match(/T(\d{2}:\d{2})/);
        todaySession = { type: title, time: timeMatch ? timeMatch[1] : null, duration: null, status: 'planned' };
      }
    } catch {}
  }

  const status = mergeSectionStatuses([readinessStatus, bodyBatteryStatus]);
  return {
    todaySession: todaySession ? {
      type: todaySession.type || todaySession.name,
      time: todaySession.time, duration: todaySession.duration, status: todaySession.status || 'planned',
    } : null,
    weeklyAdherence: null,
    readinessScore,
    bodyBattery,
    status,
    readinessStatus,
    bodyBatteryStatus,
    warningCodes: dedupeStrings(warningCodes),
    warnings: dedupeStrings(warnings),
  };
}

export async function fetchContent(userId?: number) {
  try {
    const db = require('../../services/database').getDb();
    const counts = queryContentPipelineCounts(db, userId);

    const pipelineCount = { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 };
    for (const row of counts) {
      const key = row.stage as keyof typeof pipelineCount;
      if (key in pipelineCount) pipelineCount[key] = row.count;
    }
    return {
      pipelineCount,
      nextDeadline: null,
      status: 'ready' as const,
      warningCodes: [],
      warnings: [],
    };
  } catch {
    return buildUnavailableSection(
      { pipelineCount: { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 }, nextDeadline: null },
      ['CONTENT_UNAVAILABLE'],
      ['Content pipeline is unavailable right now.'],
    );
  }
}

export function queryContentPipelineCounts(db: any, userId?: number): { stage: string; count: number }[] {
  try {
    return userId
      ? db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas WHERE status != 'archived' AND user_id = ? GROUP BY stage`).all(userId) as { stage: string; count: number }[]
      : db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas WHERE status != 'archived' GROUP BY stage`).all() as { stage: string; count: number }[];
  } catch (error: any) {
    const message = String(error?.message || '').toLowerCase();
    const missingStatusColumn = message.includes('no such column') && message.includes('status');
    const missingContentIdeasTable = message.includes('no such table') && message.includes('content_ideas');
    if (missingContentIdeasTable) {
      return [];
    }
    if (!missingStatusColumn) {
      throw error;
    }
    return userId
      ? db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas WHERE user_id = ? GROUP BY stage`).all(userId) as { stage: string; count: number }[]
      : db.prepare(`SELECT stage, COUNT(*) as count FROM content_ideas GROUP BY stage`).all() as { stage: string; count: number }[];
  }
}

function buildSectionHealth(
  fulfilledSources: number,
  totalSources: number,
  warningCodes: string[],
  warnings: string[],
  fallbackCode: string,
  fallbackWarning: string,
): DashboardSectionHealth {
  const uniqueCodes = dedupeStrings(warningCodes);
  const uniqueWarnings = dedupeStrings(warnings);

  if (fulfilledSources === 0 && totalSources === 0) {
    return {
      status: 'unavailable',
      warningCodes: uniqueCodes.length > 0 ? uniqueCodes : [fallbackCode],
      warnings: uniqueWarnings.length > 0 ? uniqueWarnings : [fallbackWarning],
    };
  }

  if (uniqueCodes.length === 0) {
    return { status: 'ready', warningCodes: [], warnings: [] };
  }

  return {
    status: fulfilledSources > 0 ? 'degraded' : 'unavailable',
    warningCodes: uniqueCodes,
    warnings: uniqueWarnings,
  };
}

export function buildUnavailableSection<T extends object>(
  data: T,
  warningCodes: string[],
  warnings: string[],
): T & DashboardSectionHealth {
  return {
    ...data,
    status: 'unavailable',
    warningCodes: dedupeStrings(warningCodes),
    warnings: dedupeStrings(warnings),
  };
}

export function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function mergeSectionStatuses(statuses: DashboardSectionStatus[]): DashboardSectionStatus {
  if (statuses.every((status) => status === 'ready')) return 'ready';
  if (statuses.some((status) => status === 'ready' || status === 'degraded')) return 'degraded';
  return 'unavailable';
}

function isSyntheticNeutralReadiness(readiness: any): boolean {
  if (readiness?.reasonCode === 'WEARABLE_INTEGRATION_MISSING') return true;
  const reasoning = String(readiness?.reasoning || '').toLowerCase();
  return reasoning.includes('no wearable connected');
}

function isSyntheticNeutralCachedReadiness(readiness: { score: number; bodyBattery: number | null; reasonCode?: string | null } | null): boolean {
  if (readiness?.reasonCode === 'WEARABLE_INTEGRATION_MISSING') return true;
  return readiness?.score === 60 && readiness?.bodyBattery === 0;
}
