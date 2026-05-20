// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Request, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { getRuntimeStatus } from '../../services/runtime-status';
import { getCachedSWR, setCacheSWR } from '../../services/cache-store';
import { sendInternalError } from '../response-helpers';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { getPreferredDisplayNameById, getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import { getDailyQuotaStatus } from '../../services/cost-guardrail';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import { buildDashboardHomeViewState } from '../../services/dashboard-home-view-state';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';
import type { Lang } from '../../utils/i18n';
import {
  buildUnavailableSection,
  fetchCalendar,
  fetchContent,
  fetchTasks,
  fetchTraining,
} from './dashboard-data-fetchers';
import { buildDashboardHomeInput } from './dashboard-home-input';
import { buildHomeDayDial } from '../../services/home-day-dial';
import {
  isDecisionStreakV1Enabled,
  isHomeDayDialV1Enabled,
  isHomeFocusPillV1Enabled,
  isProviderPreferencesV1Enabled,
  isSecretaryOrchestrationSnapshotV1Enabled,
} from '../../services/runtime-flags';
import { timedAsync, timedSync, type RouteTiming } from '../route-timing';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';

export { mapDashboardTask, queryContentPipelineCounts } from './dashboard-data-fetchers';
export { buildHomeOrchestrationSummary } from './dashboard-home-input';

const DASHBOARD_CACHE_TTL = 180;
const DASHBOARD_SWR_STALE = 300;
const DASHBOARD_HOME_CACHE_TTL = 180;
const DASHBOARD_HOME_SWR_STALE = 300;
const DASHBOARD_SECTION_TIMEOUT_MS = readPositiveIntEnv('DASHBOARD_SECTION_TIMEOUT_MS', 3000);
const DASHBOARD_HOME_BRIEF_TIMEOUT_MS = readPositiveIntEnv('DASHBOARD_HOME_BRIEF_TIMEOUT_MS', 2500);

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withDashboardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`dashboard_${label}_timeout_${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function dashboardRoutes(): Router {
  const router = Router();

  router.get('/home', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'dashboard_route_home')) return;
    const language = resolveDashboardLanguage(req, userId);

    try {
      const cacheKey = dashboardHomeCacheKeyFor(userId, language);
      const timings: RouteTiming[] = [];
      await handleCachedRoute<any>({
        cacheKey,
        ttlSeconds: DASHBOARD_HOME_CACHE_TTL,
        staleSeconds: DASHBOARD_HOME_SWR_STALE,
        refreshContext: { source: 'dashboard_route', operation: 'dashboard_swr_refresh', userId },
        fetchFresh: () => buildDashboardHomePayload(userId, language, timings),
        send: (home, meta) => {
          sendConditionalApiSuccess(res, req, home, {
            cached: meta.cached,
            timings: meta.cached ? [{ name: 'cache_hit', durationMs: 0 }] : timings,
          });
        },
      });
    } catch (err: any) {
      logger.error({ err, platform: 'ios' }, 'Dashboard home aggregation failed');
      sendInternalError(res, 'Unable to load the home briefing right now.');
    }
  });

  /**
   * GET /api/v1/dashboard
   * Aggregated dashboard — single call for the home screen.
   * Supports ETag/If-None-Match for polling efficiency.
   * All external calls are parallel via Promise.allSettled (never sequential).
   */
  router.get('/', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'dashboard_route_root')) return;
    const language = resolveDashboardLanguage(req, userId);

    try {
      const dashboardCacheKey = dashboardCacheKeyFor(userId, language);
      const timings: RouteTiming[] = [];
      await handleCachedRoute<any>({
        cacheKey: dashboardCacheKey,
        ttlSeconds: DASHBOARD_CACHE_TTL,
        staleSeconds: DASHBOARD_SWR_STALE,
        refreshContext: { source: 'dashboard_route', operation: 'dashboard_swr_refresh', userId },
        fetchFresh: () => buildDashboardPayload(userId, language, timings),
        send: (dashboard, meta) => {
          sendConditionalApiSuccess(res, req, dashboard, {
            cached: meta.cached,
            timings: meta.cached ? [{ name: 'cache_hit', durationMs: 0 }] : timings,
          });
        },
      });
    } catch (err: any) {
      logger.error({ err, platform: 'ios' }, 'Dashboard aggregation failed');
      sendInternalError(res, 'Unable to load the dashboard right now.');
    }
  });

  return router;
}

/**
 * Pre-warm dashboard cache in background so first load is instant.
 * Called on startup and periodically.
 */
export async function warmDashboardCache(userId: number): Promise<void> {
  const language = getUserLanguageById(userId);
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
  return routeCacheKey('dashboard', userId, language);
}

function dashboardHomeCacheKeyFor(userId: number, language: Lang): string {
  return routeCacheKey('dashboard-home', userId, language);
}

function resolveDashboardLanguage(req: Request, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) so a
  // truthy check would never fall back to the user's stored preference.
  // Check the raw header for presence before normalizing so the DB
  // language wins when the client didn't send x-language.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguageById(userId);
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

async function buildDashboardPayload(userId: number, language: Lang, timings: RouteTiming[] = []) {
  const [calendarResult, tasksResult, trainingResult, contentResult] = await Promise.allSettled([
    timedAsync(timings, 'calendar', () => withDashboardTimeout(fetchCalendar(userId), DASHBOARD_SECTION_TIMEOUT_MS, 'calendar')),
    timedAsync(timings, 'tasks', () => withDashboardTimeout(fetchTasks(userId), DASHBOARD_SECTION_TIMEOUT_MS, 'tasks')),
    timedAsync(timings, 'training', () => withDashboardTimeout(fetchTraining(userId), DASHBOARD_SECTION_TIMEOUT_MS, 'training')),
    timedAsync(timings, 'content', () => withDashboardTimeout(fetchContent(userId), DASHBOARD_SECTION_TIMEOUT_MS, 'content')),
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

  // Identity-safety: strict by-id resolver only. The legacy
  // require('../../services/user-service').getPreferredDisplayName path was
  // a fuzzy any-identifier lookup that could match a foreign user via
  // telegram_id collision; the *ById helper rejects that surface.
  const displayName = getPreferredDisplayNameById(userId);

  const startTime = (global as any).__startTime;
  const uptimeMs = startTime ? Date.now() - startTime : 0;
  const uptimeStr = uptimeMs > 86400000
    ? `${Math.floor(uptimeMs / 86400000)}d ${Math.floor((uptimeMs % 86400000) / 3600000)}h`
    : `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m`;

  const runtime = getRuntimeStatus();
  const quota = getDailyQuotaStatus(userId);
  const featureFlags = buildHomeFeatureFlags(userId);
  const timezone = getUserTimezoneById(userId);

  return {
    greeting: displayName ? `${greeting}, ${displayName}` : greeting,
    date: now.toISOString().slice(0, 10),
    dayOfWeek: localizedWeekday(now, language),
    calendar,
    tasks,
    featureFlags,
    dayDial: featureFlags.homeDayDialV1
      ? buildHomeDayDial({
          userId,
          calendarEvents: calendar.today ?? [],
          date: now.toLocaleDateString('en-CA', { timeZone: timezone }),
          timezone,
        })
      : null,
    training,
    content,
    quota: {
      used_usd: quota.usedUsd,
      limit_usd: quota.limitUsd,
      remaining_usd: quota.remainingUsd,
      included_remaining_usd: quota.includedRemainingUsd,
      nexus_points_balance: quota.nexusPointsBalance,
      nexus_points_remaining_usd: quota.nexusPointsRemainingUsd,
      nexus_points_expiring_soon: quota.nexusPointsExpiringSoon,
      total_remaining_usd: quota.totalRemainingUsd,
      points_purchase_available: quota.pointsPurchaseAvailable,
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

function buildHomeFeatureFlags(userId: number) {
  const scope = { userId, tenantId: userId };
  return {
    homeDayDialV1: isHomeDayDialV1Enabled(process.env, scope),
    providerPreferencesV1: isProviderPreferencesV1Enabled(process.env, scope),
    homeFocusPillV1: isHomeFocusPillV1Enabled(process.env, scope),
    decisionStreakV1: isDecisionStreakV1Enabled(process.env, scope),
    secretaryOrchestrationSnapshotV1: isSecretaryOrchestrationSnapshotV1Enabled(process.env, scope),
  };
}

async function buildDashboardHomePayload(userId: number, language: Lang, timings: RouteTiming[] = []) {
  const [dashboardResult, briefResult] = await Promise.allSettled([
    timedAsync(timings, 'dashboard', () => buildDashboardPayload(userId, language, timings)),
    timedAsync(timings, 'daily_brief', () => withDashboardTimeout(composeDailyBrief({ userId, language }), DASHBOARD_HOME_BRIEF_TIMEOUT_MS, 'daily_brief')),
  ]);

  if (dashboardResult.status !== 'fulfilled') {
    throw dashboardResult.reason;
  }

  const dashboard = dashboardResult.value;
  const brief = briefResult.status === 'fulfilled' ? briefResult.value : null;
  const sectionWarningCodes = [
    ...(dashboard.calendar?.status !== 'ready' ? dashboard.calendar?.warningCodes ?? [] : []),
    ...(dashboard.tasks?.status !== 'ready' ? dashboard.tasks?.warningCodes ?? [] : []),
    ...(dashboard.training?.status !== 'ready' ? dashboard.training?.warningCodes ?? [] : []),
    ...(dashboard.content?.status !== 'ready' ? dashboard.content?.warningCodes ?? [] : []),
  ];
  const reasonCodes = [
    ...sectionWarningCodes,
    ...(briefResult.status === 'rejected' ? ['DAILY_BRIEF_UNAVAILABLE'] : []),
  ];

  return timedSync(timings, 'home_view_state', () => buildDashboardHomeViewState(buildDashboardHomeInput({
      userId,
      dashboard,
      brief,
      language,
      meta: buildScreenContractMeta({
        source: 'server',
        isFallback: reasonCodes.length > 0,
        isPartial: reasonCodes.length > 0,
        isStale: false,
        generatedAt: new Date().toISOString(),
        reasonCodes,
      }),
    }), language));
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
