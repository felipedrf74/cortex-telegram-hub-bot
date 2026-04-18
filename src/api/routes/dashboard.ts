// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getRuntimeStatus } from '../../services/runtime-status';
import { getCached, setCache, getCachedSWR, setCacheSWR } from '../../services/cache-store';
import { apiSuccess, sendError } from '../response-helpers';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getUserLanguage } from '../../services/user-service';
import { getDailyQuotaStatus } from '../../services/cost-guardrail';
import {
  getEvents as getGoogleCalendarEvents,
  isGoogleCalendarConfigured,
} from '../../services/google-calendar';
import {
  getEvents as getOutlookCalendarEvents,
  isOutlookCalendarConfigured,
} from '../../services/outlook-calendar';
import type { Lang } from '../../utils/i18n';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';

type DashboardSectionStatus = 'ready' | 'degraded' | 'unavailable';

interface DashboardSectionHealth {
  status: DashboardSectionStatus;
  warningCodes: string[];
  warnings: string[];
}

const DASHBOARD_CACHE_TTL = 60;
const DASHBOARD_SWR_STALE = 300;
const DASHBOARD_READINESS_CACHE_TTL = 60;
const swrInFlight = new Set<string>();

function ensureValidDashboardRouteScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId)) return true;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
    details,
  });
  sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  return false;
}

function swrRefresh(key: string, fn: () => Promise<void>): void {
  if (swrInFlight.has(key)) return;
  swrInFlight.add(key);
  fn()
    .catch((err) => logger.debug({ err, key }, 'Dashboard SWR background refresh failed'))
    .finally(() => swrInFlight.delete(key));
}

export function dashboardRoutes(): Router {
  const router = Router();

  /**
   * GET /api/v1/dashboard
   * Aggregated dashboard — single call for the home screen.
   * Supports ETag/If-None-Match for polling efficiency.
   * All external calls are parallel via Promise.allSettled (never sequential).
   */
  router.get('/', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidDashboardRouteScope(res, userId, 'dashboard_route_root')) return;
    const language = resolveDashboardLanguage(req, userId);

    try {
      const dashboardCacheKey = dashboardCacheKeyFor(userId, language);
      const swr = getCachedSWR<any>(dashboardCacheKey);

      if (swr) {
        // The ETag is computed over the wrapped envelope, so iOS clients
        // get a stable hash that includes the timestamp/cached flags.
        const envelope = apiSuccess(swr.value, { cached: true });
        const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined }); // hash is content-only
        const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.json(envelope);

        if (!swr.fresh) {
          swrRefresh(dashboardCacheKey, async () => {
            const dashboard = await buildDashboardPayload(userId, language);
            setCacheSWR(dashboardCacheKey, dashboard, DASHBOARD_CACHE_TTL, DASHBOARD_SWR_STALE);
          });
        }
        return;
      }

      const dashboard = await buildDashboardPayload(userId, language);
      setCacheSWR(dashboardCacheKey, dashboard, DASHBOARD_CACHE_TTL, DASHBOARD_SWR_STALE);

      const envelope = apiSuccess(dashboard);
      // ETag support — skip full response if nothing changed
      const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined });
      const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;

      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.json(envelope);
    } catch (err: any) {
      logger.error({ err, platform: 'ios' }, 'Dashboard aggregation failed');
      sendError(res, 'INTERNAL', err?.message || 'Dashboard aggregation failed', 500);
    }
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractTime(dateInput: any): string {
  if (!dateInput) return '';
  const raw = typeof dateInput === 'string' ? dateInput : dateInput.dateTime || dateInput.date || String(dateInput);
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: config.app.timezone });
    }
  } catch {}
  const match = raw.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : '';
}

function extractTitle(e: any): string {
  return e.subject || e.summary || e.title || e.displayName || e.name || '(No title)';
}

/**
 * Pre-warm dashboard cache in background so first load is instant.
 * Called on startup and periodically.
 */
export async function warmDashboardCache(userId: number): Promise<void> {
  const language = getUserLanguage(userId);
  const cacheKey = dashboardCacheKeyFor(userId, language);
  if (getCachedSWR(cacheKey)?.fresh) return; // Already warm enough

  try {
    const response = await buildDashboardPayload(userId, language);
    setCacheSWR(cacheKey, response, DASHBOARD_CACHE_TTL, DASHBOARD_SWR_STALE);
    logger.debug('Dashboard cache warmed');
  } catch (err) {
    logger.debug({ err }, 'Dashboard cache warming failed (non-critical)');
  }
}

function dashboardCacheKeyFor(userId: number, language: Lang): string {
  return `dashboard:${userId}:${language}`;
}

function dashboardReadinessCacheKeyFor(userId: number): string {
  return `dashboard-readiness:${userId}`;
}

function resolveDashboardLanguage(req: Request, userId: number): Lang {
  const headerLanguage = normalizeLangHeader(req.header?.('x-language'));
  if (headerLanguage) return headerLanguage;
  return getUserLanguage(userId);
}

function localizeGreeting(hour: number, language: Lang): string {
  const isPortuguese = language.startsWith('pt');
  if (isPortuguese) {
    if (hour < 12) return 'Bom dia';
    if (hour < 18) return 'Boa tarde';
    return 'Boa noite';
  }
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function localizedWeekday(date: Date, language: Lang): string {
  const locale = language === 'pt-BR'
    ? 'pt-BR'
    : language.startsWith('pt')
      ? 'pt-PT'
      : 'en-US';
  const weekday = date.toLocaleDateString(locale, {
    weekday: 'long',
    timeZone: config.app.timezone,
  });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

async function buildDashboardPayload(userId: number, language: Lang) {
  const [calendarResult, tasksResult, trainingResult, contentResult] = await Promise.allSettled([
    fetchCalendar(userId),
    fetchTasks(userId),
    fetchTraining(userId),
    fetchContent(userId),
  ]);

  const calendar = calendarResult.status === 'fulfilled'
    ? calendarResult.value
    : buildUnavailableSection(
      { today: [], upcoming: [] },
      ['CALENDAR_UNAVAILABLE'],
      ['Calendar data is unavailable right now.'],
    );
  const tasks = tasksResult.status === 'fulfilled'
    ? tasksResult.value
    : buildUnavailableSection(
      { overdue: 0, dueToday: 0, totalPending: 0, topTasks: [] },
      ['TASKS_UNAVAILABLE'],
      ['Task data is unavailable right now.'],
    );
  const training = trainingResult.status === 'fulfilled'
    ? trainingResult.value
    : {
      todaySession: null,
      weeklyAdherence: null,
      readinessScore: null,
      bodyBattery: null,
      status: 'unavailable' as const,
      readinessStatus: 'unavailable' as const,
      bodyBatteryStatus: 'unavailable' as const,
      warningCodes: ['READINESS_UNAVAILABLE', 'BODY_BATTERY_UNAVAILABLE'],
      warnings: ['Training recovery data is unavailable right now.'],
    };
  const content = contentResult.status === 'fulfilled'
    ? contentResult.value
    : buildUnavailableSection(
      { pipelineCount: { ideas: 0, scripted: 0, filmed: 0, editing: 0, published: 0 }, nextDeadline: null },
      ['CONTENT_UNAVAILABLE'],
      ['Content pipeline is unavailable right now.'],
    );

  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.app.timezone }), 10);
  const greeting = localizeGreeting(hour, language);

  let displayName = '';
  try {
    const { getPreferredDisplayName } = require('../../services/user-service');
    displayName = getPreferredDisplayName(userId);
  } catch { /* user-service not available */ }

  const startTime = (global as any).__startTime;
  const uptimeMs = startTime ? Date.now() - startTime : 0;
  const uptimeStr = uptimeMs > 86400000
    ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
    : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

  const runtime = getRuntimeStatus();
  const quota = getDailyQuotaStatus(userId);

  return {
    greeting: displayName ? `${greeting}, ${displayName}` : greeting,
    date: now.toISOString().slice(0, 10),
    dayOfWeek: localizedWeekday(now, language),
    calendar,
    tasks,
    training,
    content,
    quota: {
      used_usd: quota.usedUsd,
      limit_usd: quota.limitUsd,
      remaining_usd: quota.remainingUsd,
      plan: quota.plan,
      resetAt: quota.resetAt,
    },
    system: {
      version: getAppVersion(),
      uptime: uptimeStr,
      serviceStatus: runtime.serviceStatus,
      botStatus: runtime.botStatus,
      databaseStatus: runtime.databaseStatus,
      lastMessageAt: runtime.lastMessageAt,
    },
  };
}

/** Read version from package.json (works with PM2, not just npm start) */
function getAppVersion(): string {
  try {
    const pkg = require('../../../package.json');
    return pkg.version || '0.0.0';
  } catch {
    return process.env.npm_package_version || '0.0.0';
  }
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

function mapCalendarEvent(e: any, source: string) {
  return {
    id: e.id,
    title: extractTitle(e),
    start: extractTime(e.start),
    end: extractTime(e.end),
    source,
    category: e.categories?.[0] || null,
    color: null,
  };
}

// ── Data Fetchers (all independently failable) ──────────────────────

async function fetchCalendar(userId?: number) {
  return fetchCalendarForUser(userId);
}

async function fetchCalendarForUser(userId?: number) {
  const today = new Date();
  const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
  const start = startOfDay.toISOString();
  const end = endOfDay.toISOString();

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
        return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'google')) : [];
      },
    });
  }

  const outlookConfigured = isOutlookCalendarConfigured(userId);
  if (outlookConfigured) {
    fetchers.push({
      provider: 'outlook',
      run: async () => {
        const events = await getOutlookCalendarEvents(start, end, userId);
        return Array.isArray(events) ? events.map((e: any) => mapCalendarEvent(e, 'outlook')) : [];
      },
    });
  }

  if (!googleConfigured && !outlookConfigured) {
    warningCodes.push('CALENDAR_UNAVAILABLE');
    warnings.push('Calendar data is unavailable right now.');
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

  const allEvents = allProviderEvents.sort((a, b) => a.start.localeCompare(b.start));
  return {
    today: allEvents,
    upcoming: [],
    ...buildSectionHealth(
      fulfilledProviders,
      fetchers.length,
      warningCodes,
      warnings,
      'CALENDAR_UNAVAILABLE',
      'Calendar data is unavailable right now.',
    ),
  };
}

async function fetchTasks(userId: number) {
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

  const now = new Date();
  // MS Graph stores due dates as T23:00:00 UTC for the "previous" day in European TZ.
  // Example: "due April 7" = "2026-04-06T23:00:00" in UTC = April 7 in Lisbon.
  // To compare correctly, use the DATE PORTION ONLY (first 10 chars of ISO string).
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: config.app.timezone }); // "2026-04-06"

  function getDueDateStr(t: any): string | null {
    const raw = t.dueDateTime?.dateTime || t.dueDateTime;
    if (!raw) return null;
    // MS Graph: "2026-04-06T23:00:00.0000000" → add 1 hour to get Lisbon date
    const d = new Date(raw);
    return d.toLocaleDateString('en-CA', { timeZone: config.app.timezone }); // "2026-04-07"
  }

  const overdue = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr && dueStr < todayStr;
  }).length;

  const dueToday = tasks.filter((t: any) => {
    const dueStr = getDueDateStr(t);
    return dueStr === todayStr;
  }).length;

  const topTasks = tasks.slice(0, 5).map((t: any) => ({
    id: t.id, title: t.title, body: t.body?.content || null,
    importance: t.importance || 'normal', status: t.status || 'notStarted',
    dueDateTime: t.dueDateTime?.dateTime || t.dueDateTime || null,
    listId: t.listId || null, listName: t.listName || null,
    checklistItems: null, createdDateTime: t.createdDateTime || null,
  }));

  return {
    overdue,
    dueToday,
    totalPending: tasks.length,
    topTasks,
    status: 'ready' as const,
    warningCodes: [],
    warnings: [],
  };
}

async function fetchTraining(userId: number) {
  let readinessScore: number | null = null;
  let bodyBattery: number | null = null;
  let readinessStatus: DashboardSectionStatus = 'ready';
  let bodyBatteryStatus: DashboardSectionStatus = 'ready';
  const warningCodes: string[] = [];
  const warnings: string[] = [];

  // Provider-agnostic readiness: calculateReadiness() handles Garmin → Apple Health → neutral
  // fallback internally. No need for the dashboard to branch by provider.
  const cachedReadiness = getCached<{ score: number; bodyBattery: number | null }>(
    dashboardReadinessCacheKeyFor(userId),
  );
  if (cachedReadiness) {
    if (isSyntheticNeutralCachedReadiness(cachedReadiness)) {
      readinessScore = null;
      bodyBattery = null;
      readinessStatus = 'unavailable';
      bodyBatteryStatus = 'unavailable';
      warningCodes.push('READINESS_UNAVAILABLE', 'BODY_BATTERY_UNAVAILABLE');
      warnings.push(
        'Readiness data is unavailable right now.',
        'Body Battery is unavailable right now.',
      );
    } else {
      readinessScore = cachedReadiness.score;
      bodyBattery = cachedReadiness.bodyBattery;
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
  } else {
    try {
      const { calculateReadiness } = require('../../services/readiness-scorer');
      const readiness = await calculateReadiness(userId);
      if (isSyntheticNeutralReadiness(readiness)) {
        readinessScore = null;
        bodyBattery = null;
        readinessStatus = 'unavailable';
        bodyBatteryStatus = 'unavailable';
        warningCodes.push('READINESS_UNAVAILABLE', 'BODY_BATTERY_UNAVAILABLE');
        warnings.push(
          'Readiness data is unavailable right now.',
          'Body Battery is unavailable right now.',
        );
      } else {
        readinessScore = readiness?.score || null;
        bodyBattery = normalizeBodyBattery(readiness?.factors?.bodyBattery?.current);

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
      }

      setCache(
        dashboardReadinessCacheKeyFor(userId),
        { score: readinessScore, bodyBattery },
        DASHBOARD_READINESS_CACHE_TTL,
      );
    } catch {
      readinessStatus = 'unavailable';
      bodyBatteryStatus = 'unavailable';
      warningCodes.push('READINESS_UNAVAILABLE', 'BODY_BATTERY_UNAVAILABLE');
      warnings.push(
        'Readiness data is unavailable right now.',
        'Body Battery is unavailable right now.',
      );
    }
  }

  // Get today's training — first try training plans, then calendar fallback
  let todaySession: any = null;
  try {
    const { getActivePlan, getSessionsForWeek } = require('../../services/training-plans');
    const plan = getActivePlan(userId);
    const sessions = plan ? getSessionsForWeek(userId) : null;
    todaySession = sessions?.find((s: any) => s.isToday) || null;
  } catch {}

  // Calendar fallback
  if (!todaySession) {
    try {
      const today = new Date();
      const startOfDay = new Date(today); startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today); endOfDay.setHours(23, 59, 59, 999);
      const { getEvents } = require('../../services/unified-calendar');
      const events = await getEvents(startOfDay.toISOString(), endOfDay.toISOString(), userId);
      const keywords = ['run', 'gym', 'swim', 'bike', 'cycle', 'training', 'workout', 'strength'];
      const trainingEvent = (events || []).find((e: any) => {
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

async function fetchContent(userId?: number) {
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

function buildUnavailableSection<T extends object>(
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

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function mergeSectionStatuses(statuses: DashboardSectionStatus[]): DashboardSectionStatus {
  if (statuses.every((status) => status === 'ready')) return 'ready';
  if (statuses.some((status) => status === 'ready' || status === 'degraded')) return 'degraded';
  return 'unavailable';
}

function isSyntheticNeutralReadiness(readiness: any): boolean {
  const reasoning = String(readiness?.reasoning || '').toLowerCase();
  return reasoning.includes('no wearable connected');
}

function isSyntheticNeutralCachedReadiness(readiness: { score: number; bodyBattery: number | null } | null): boolean {
  return readiness?.score === 60 && readiness?.bodyBattery === 0;
}
