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
import { getUserById, getUserByTelegramId, getUserLanguage } from '../../services/user-service';
import { getDailyQuotaStatus } from '../../services/cost-guardrail';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import {
  buildDashboardHomeViewState,
  type DashboardHomeBuildInput,
  type DashboardHomeOrchestrationSummary,
  type HomeImpactDomain,
  type SecretaryPreviewItemModel,
  type SkillAvailabilityModel,
} from '../../services/dashboard-home-view-state';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';
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
import { checkTierAccess } from '../../services/skill-tiers';
import { isSkillEnabled } from '../../services/user-skill-access';

type DashboardSectionStatus = 'ready' | 'degraded' | 'unavailable';

interface DashboardSectionHealth {
  status: DashboardSectionStatus;
  warningCodes: string[];
  warnings: string[];
}

const DASHBOARD_CACHE_TTL = 60;
const DASHBOARD_SWR_STALE = 300;
const DASHBOARD_READINESS_CACHE_TTL = 60;
const DASHBOARD_HOME_CACHE_TTL = 60;
const DASHBOARD_HOME_SWR_STALE = 300;
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

  router.get('/home', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidDashboardRouteScope(res, userId, 'dashboard_route_home')) return;
    const language = resolveDashboardLanguage(req, userId);

    try {
      const cacheKey = dashboardHomeCacheKeyFor(userId, language);
      const swr = getCachedSWR<any>(cacheKey);

      if (swr) {
        const envelope = apiSuccess(swr.value, { cached: true });
        const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined });
        const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.status(304).end();
          return;
        }
        res.setHeader('ETag', etag);
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.json(envelope);

        if (!swr.fresh) {
          swrRefresh(cacheKey, async () => {
            const home = await buildDashboardHomePayload(userId, language);
            setCacheSWR(cacheKey, home, DASHBOARD_HOME_CACHE_TTL, DASHBOARD_HOME_SWR_STALE);
          });
        }
        return;
      }

      const home = await buildDashboardHomePayload(userId, language);
      setCacheSWR(cacheKey, home, DASHBOARD_HOME_CACHE_TTL, DASHBOARD_HOME_SWR_STALE);

      const envelope = apiSuccess(home);
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
      logger.error({ err, platform: 'ios' }, 'Dashboard home aggregation failed');
      sendError(res, 'INTERNAL', err?.message || 'Dashboard home aggregation failed', 500);
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

function dashboardHomeCacheKeyFor(userId: number, language: Lang): string {
  return `dashboard-home:${userId}:${language}`;
}

function dashboardReadinessCacheKeyFor(userId: number): string {
  return `dashboard-readiness:${userId}`;
}

function resolveDashboardLanguage(req: Request, userId: number): Lang {
  // `normalizeLangHeader` always returns a value ('pt-BR' default) so a
  // truthy check would never fall back to the user's stored preference.
  // Check the raw header for presence before normalizing so the DB
  // language wins when the client didn't send x-language.
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
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

async function buildDashboardHomePayload(userId: number, language: Lang) {
  const skillAvailability = buildHomeSkillAvailability(userId);
  const [dashboardResult, briefResult] = await Promise.allSettled([
    buildDashboardPayload(userId, language),
    composeDailyBrief({ userId, language }),
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

  return buildDashboardHomeViewState(buildDashboardHomeInput(dashboard, brief, language, buildScreenContractMeta({
    source: 'server',
    isFallback: reasonCodes.length > 0,
    isPartial: reasonCodes.length > 0,
    isStale: false,
    generatedAt: new Date().toISOString(),
    reasonCodes,
  }), skillAvailability), language);
}

function buildDashboardHomeInput(
  dashboard: Awaited<ReturnType<typeof buildDashboardPayload>>,
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
  meta: DashboardHomeBuildInput['meta'],
  skillAvailability: SkillAvailabilityModel,
): DashboardHomeBuildInput {
  const nextEvent = selectNextEvent(dashboard.calendar?.today ?? []);
  const secretaryItems = buildSecretaryPreviewItems(dashboard.calendar?.today ?? [], language);
  const tasksDue = dashboard.tasks?.dueToday ?? 0;
  const overdueTasks = dashboard.tasks?.overdue ?? 0;
  const calendarUnavailable = dashboard.calendar?.status === 'unavailable';

  return {
    readinessScore: dashboard.training?.readinessScore ?? null,
    bodyBattery: dashboard.training?.bodyBattery ?? null,
    tasksDue,
    overdueTasks,
    eventsCount: calendarUnavailable ? 0 : (dashboard.calendar?.today?.length ?? 0),
    nextEventTitle: localizeTrainingTitle(nextEvent?.title, null, language),
    nextEventTime: nextEvent?.start ?? null,
    nextEventSource: nextEvent?.source ?? null,
    hasCalendarUnavailable: calendarUnavailable,
    trainingTitle: localizeTrainingTitle(brief?.day.training.title, dashboard.training?.todaySession?.type, language),
    trainingTime: dashboard.training?.todaySession?.time ?? null,
    trainingDurationMinutes: dashboard.training?.todaySession?.duration ?? brief?.day.training.durationMinutes ?? null,
    trainingStatus: dashboard.training?.status ?? 'unavailable',
    contentHeadline: buildContentHeadline(dashboard, brief, language),
    contentSubline: buildContentSubline(brief, language),
    cookingHeadline: buildCookingHeadline(brief, language),
    cookingSubline: buildCookingSubline(brief, language),
    financeHeadline: buildFinanceHeadline(brief, language),
    financeSubline: buildFinanceSubline(brief),
    orchestrationSummary: buildHomeOrchestrationSummary(brief, language),
    skillAvailability,
    warningMessages: buildDashboardHomeWarningMessages(dashboard, language),
    secretaryItems,
    secretarySummary: buildSecretarySummary({
      events: dashboard.calendar?.today ?? [],
      tasksDue,
      overdueTasks,
      hasCalendarUnavailable: calendarUnavailable,
      language,
    }),
    meta,
  };
}

function buildHomeSkillAvailability(userId: number): SkillAvailabilityModel {
  const user = getUserById(userId) || getUserByTelegramId(userId);
  const skills: HomeImpactDomain[] = ['secretary', 'training', 'cooking', 'content', 'finance'];
  const availableSkills = skills.filter((skill) => hasHomeSkillAccess(userId, user, skill));
  const hiddenSkills = skills.filter((skill) => !availableSkills.includes(skill));

  return {
    availableSkills,
    hiddenSkills,
    capabilityFlags: {
      secretary: availableSkills.includes('secretary'),
      training: availableSkills.includes('training'),
      cooking: availableSkills.includes('cooking'),
      content: availableSkills.includes('content'),
      finance: availableSkills.includes('finance'),
    },
  };
}

function hasHomeSkillAccess(
  userId: number,
  user: { id: number; tier: string } | null | undefined,
  skill: HomeImpactDomain,
): boolean {
  const skillId = skill === 'training' ? 'triathlon' : skill;
  return checkTierAccess(user as any, skillId).allowed && isSkillEnabled(userId, skillId);
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

function selectNextEvent(events: Array<{ start?: string; end?: string } & Record<string, any>>) {
  const nowMinutes = currentLocalMinutes();
  const ongoing = events.find((event) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    return start != null && end != null && start <= nowMinutes && nowMinutes < end;
  });
  if (ongoing) return ongoing;

  const upcoming = events.find((event) => {
    const start = timeToMinutes(event.start);
    return start != null && start > nowMinutes;
  });
  return upcoming ?? events[0] ?? null;
}

function buildSecretaryPreviewItems(
  events: Array<{ id?: string; start?: string; end?: string; title?: string; source?: string | null }>,
  language: Lang,
): SecretaryPreviewItemModel[] {
  const nowMinutes = currentLocalMinutes();
  return events.slice(0, 3).map((event, index) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    const isNow = start != null && end != null && start <= nowMinutes && nowMinutes < end;
    const isPast = end != null && nowMinutes >= end;
    return {
      id: String(event.id ?? `event-${index}`),
      time: formatEventRange(event.start, event.end),
      title: localizeTrainingTitle(event.title, null, language) ?? String(event.title ?? '(No title)'),
      source: event.source ?? null,
      isNow,
      isPast,
    };
  });
}

function buildSecretarySummary(opts: {
  events: Array<{ title?: string; start?: string; end?: string }>;
  tasksDue: number;
  overdueTasks: number;
  hasCalendarUnavailable: boolean;
  language: Lang;
}): string {
  if (opts.hasCalendarUnavailable) {
    return localizePT(
      opts.language,
      'A agenda precisa de integração antes de coordenar o resto do dia.',
      'Your calendar needs integration before the rest of the day can coordinate.',
    );
  }

  const nowMinutes = currentLocalMinutes();
  const ongoing = opts.events.find((event) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    return start != null && end != null && start <= nowMinutes && nowMinutes < end;
  });
  if (ongoing?.title) {
    const ongoingTitle = localizeTrainingTitle(ongoing.title, null, opts.language) ?? ongoing.title;
    return localizePT(
      opts.language,
      `Agora: ${ongoingTitle}. ${opts.tasksDue} tarefas ainda pedem atenção hoje.`,
      `Now: ${ongoingTitle}. ${opts.tasksDue} tasks still need attention today.`,
    );
  }

  const upcoming = opts.events.find((event) => {
    const start = timeToMinutes(event.start);
    return start != null && start > nowMinutes;
  });
  if (upcoming?.start) {
    const taskCount = Math.max(0, opts.tasksDue + opts.overdueTasks);
    return localizePT(
      opts.language,
      `Próximo bloco às ${upcoming.start}. ${taskCount} tarefas continuam no radar.`,
      `Next block starts at ${upcoming.start}. ${taskCount} tasks remain on the radar.`,
    );
  }

  if (opts.tasksDue + opts.overdueTasks > 0) {
    return localizePT(
      opts.language,
      'A agenda está leve; o próximo peso do dia está nas tarefas em aberto.',
      'The calendar is light; the next weight of the day is in open tasks.',
    );
  }

  return localizePT(
    opts.language,
    'A agenda está controlada e o dia tem margem para seguir o plano sem ruído.',
    'The schedule is under control and the day has room to follow the plan without noise.',
  );
}

export function buildHomeOrchestrationSummary(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
): DashboardHomeOrchestrationSummary | null {
  if (!brief) return null;
  const coordination = brief.coordination;

  const coordinationImpacts: DashboardHomeOrchestrationSummary['impacts'] = (coordination?.crossSkillImpacts ?? [])
    .map((impact): DashboardHomeOrchestrationSummary['impacts'][number] => ({
      id: impact.id,
      domain: impact.skillId === 'secretary' ? 'secretary' : impact.skillId,
      detail: impact.summary,
    }))
    .slice(0, 4);

  const impacts: DashboardHomeOrchestrationSummary['impacts'] = (
    coordinationImpacts.length > 0
      ? coordinationImpacts
      : compactStrings([
        secretaryImpact(brief, language),
        trainingImpact(brief, language),
        cookingImpact(brief, language),
        contentImpact(brief, language),
        financeImpact(brief, language),
      ])
  ).slice(0, 4);

  if (impacts.length === 0) return null;

  const weeklyHeadline = firstRenderable([
    coordination?.weekOrchestration?.title ?? null,
    coordination?.dayOrchestration?.title ?? null,
    preferredFallbackWeeklyHeadline(brief),
    brief.day.headline,
    brief.creativeCopy.headline,
    coordination?.topPriority ?? null,
  ]) ?? localizePT(language, 'O dia já foi coordenado para proteger o que importa agora.', 'The day was already coordinated to protect what matters now.');

  const heroHeadline = firstRenderable([
    coordination?.dayOrchestration?.title ?? null,
    coordination?.nextBestAction?.title ?? null,
    coordination?.topPriority ?? null,
    brief.day.headline,
    weeklyHeadline,
  ]);

  const heroDetail = firstRenderable([
    coordination?.nextBestAction?.summary ?? null,
    coordination?.blockers?.[0]?.summary ?? null,
    coordination?.dayOrchestration?.summary ?? null,
    brief.conflicts[0]?.message ?? null,
    brief.day.secretary.tradeoffNote,
    coordination?.watchouts?.[0] ?? null,
    brief.day.training.reason,
    brief.creativeCopy.note,
  ]) ?? localizePT(language, 'A coordenação está a alinhar agenda, treino e execução para reduzir atrito.', 'Coordination is aligning schedule, training, and execution to reduce friction.');

  const weeklyDetail = firstRenderable([
    coordination?.weekOrchestration?.summary ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.handoffs?.[0] ?? null,
    brief.creativeCopy.note,
    heroDetail,
  ]) ?? localizePT(language, 'A coordenação está a alinhar agenda, treino e execução para reduzir atrito.', 'Coordination is aligning schedule, training, and execution to reduce friction.');

  const insightSummary = firstRenderable([
    coordination?.blockers?.[0]?.summary ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.watchouts?.[0] ?? null,
    brief.conflicts[0]?.message ?? null,
  ]);

  const protectedLater = firstRenderable([
    coordination?.nextBestAction?.whyNow ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.handoffs?.[0] ?? null,
    brief.day.content?.note?.trim() ?? null,
  ]);

  return {
    headline: weeklyHeadline,
    detail: weeklyDetail,
    protectedLater,
    heroHeadline,
    heroDetail,
    insightSummary,
    weeklyHeadline,
    weeklyDetail,
    impacts,
    watchouts: compactStrings([
      ...(coordination?.watchouts ?? []),
      ...((coordination?.blockers ?? []).map((blocker) => blocker.title)),
    ]).slice(0, 2),
  };
}

function preferredFallbackWeeklyHeadline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
): string | null {
  const dayHeadline = brief.day.headline?.trim() ?? '';
  const creativeHeadline = brief.creativeCopy.headline?.trim() ?? '';
  const topPriority = brief.coordination.topPriority?.trim() ?? '';

  if (!creativeHeadline) return dayHeadline || topPriority || null;
  if (!dayHeadline) return creativeHeadline || topPriority || null;

  const dayKey = normalizedHomeCopyKey(dayHeadline);
  const creativeKey = normalizedHomeCopyKey(creativeHeadline);
  const priorityKey = normalizedHomeCopyKey(topPriority);
  const creativeExpandsDay =
    dayKey.length > 0
      && creativeKey.startsWith(dayKey)
      && creativeHeadline.length > dayHeadline.length + 12;
  const creativeExpandsPriority =
    priorityKey.length > 0
      && creativeKey.startsWith(priorityKey)
      && creativeHeadline.length > topPriority.length + 12;

  return creativeExpandsDay || creativeExpandsPriority ? creativeHeadline : dayHeadline;
}

function normalizedHomeCopyKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildDashboardHomeWarningMessages(
  dashboard: Awaited<ReturnType<typeof buildDashboardPayload>>,
  language: Lang,
): string[] {
  const codes = dedupeStrings([
    ...(dashboard.calendar?.warningCodes ?? []),
    ...(dashboard.tasks?.warningCodes ?? []),
    ...(dashboard.training?.warningCodes ?? []),
    ...(dashboard.content?.warningCodes ?? []),
  ]);

  return compactStrings(codes.map((code) => localizedDashboardWarningMessage(code, language))).slice(0, 2);
}

function localizedDashboardWarningMessage(code: string, language: Lang): string | null {
  switch (code) {
    case 'OUTLOOK_CALENDAR_UNAVAILABLE':
      return localizePT(language, 'O Outlook Calendar está indisponível agora.', 'Outlook Calendar is unavailable right now.');
    case 'GOOGLE_CALENDAR_UNAVAILABLE':
      return localizePT(language, 'O Google Calendar está indisponível agora.', 'Google Calendar is unavailable right now.');
    case 'CALENDAR_INTEGRATION_MISSING':
      return localizePT(language, 'Liga o Google Calendar ou o Outlook para preencher o plano do dia.', 'Connect Google Calendar or Outlook to fill your day plan.');
    case 'WEARABLE_INTEGRATION_MISSING':
      return localizePT(language, 'Liga o Garmin ou o Apple Health para personalizar a prontidão.', 'Connect Garmin or Apple Health to personalize readiness.');
    case 'TASKS_UNAVAILABLE':
      return localizePT(language, 'As tarefas estão indisponíveis agora.', 'Tasks are unavailable right now.');
    case 'READINESS_UNAVAILABLE':
      return localizePT(language, 'A prontidão está indisponível agora.', 'Readiness data is unavailable right now.');
    case 'BODY_BATTERY_UNAVAILABLE':
      return localizePT(language, 'A Body Battery está indisponível agora.', 'Body Battery is unavailable right now.');
    case 'CALENDAR_UNAVAILABLE':
      return localizePT(language, 'Os dados de calendário estão indisponíveis agora.', 'Calendar data is unavailable right now.');
    case 'CONTENT_UNAVAILABLE':
      return localizePT(language, 'O conteúdo está indisponível agora.', 'Content is unavailable right now.');
    default:
      return null;
  }
}

function secretaryImpact(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const secretary = brief.day.secretary;
  const focusNote = secretary.focusBlock?.note?.trim();
  if (focusNote) {
    return { id: 'secretary', domain: 'secretary', detail: focusNote };
  }
  if (secretary.overdueTasks > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: quantifiedLabel(secretary.overdueTasks, language, 'atrasada', 'atrasadas', 'overdue task', 'overdue tasks'),
    };
  }
  if (secretary.pendingTasks > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: quantifiedLabel(secretary.pendingTasks, language, 'tarefa ativa', 'tarefas ativas', 'active task', 'active tasks'),
    };
  }
  if (secretary.busy || secretary.travel || secretary.sequence.length > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: localizePT(language, 'Agenda reajustada', 'Calendar adjusted'),
    };
  }
  return null;
}

function trainingImpact(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const training = brief.day.training;
  if (training.title?.trim()) {
    return { id: 'training', domain: 'training', detail: localizeTrainingTitle(training.title, null, language) ?? training.title };
  }
  if (training.durationMinutes && training.durationMinutes > 0) {
    return {
      id: 'training',
      domain: 'training',
      detail: localizePT(language, `${training.durationMinutes} min de treino`, `${training.durationMinutes} min session`),
    };
  }
  if (training.reason?.trim()) {
    return { id: 'training', domain: 'training', detail: training.reason.trim() };
  }
  return null;
}

function cookingImpact(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  if (brief.day.meals.length === 0) return null;
  const firstMeal = brief.day.meals[0];
  const mealCount = brief.day.meals.length;
  return {
    id: 'cooking',
    domain: 'cooking',
    detail: firstMeal.title?.trim()
      || quantifiedLabel(mealCount, language, 'refeição alinhada', 'refeições alinhadas', 'meal aligned', 'meals aligned'),
  };
}

function contentImpact(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const content = brief.day.content;
  if (!content) return null;
  if (content.title?.trim()) {
    return { id: 'content', domain: 'content', detail: content.title.trim() };
  }
  if (content.note?.trim()) {
    return { id: 'content', domain: 'content', detail: content.note.trim() };
  }
  return {
    id: 'content',
    domain: 'content',
    detail: localizePT(language, 'Conteúdo alinhado', 'Content aligned'),
  };
}

function financeImpact(
  brief: Awaited<ReturnType<typeof composeDailyBrief>>,
  _language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const finance = brief.day.finance;
  if (!finance) return null;
  const detail = firstRenderable([
    finance.budgetNote,
    finance.taxNote,
    finance.subscriptionNote,
  ]);
  return detail ? { id: 'finance', domain: 'finance', detail } : null;
}

function buildContentHeadline(
  dashboard: Awaited<ReturnType<typeof buildDashboardPayload>>,
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
): string {
  const content = brief?.day.content;
  if (content?.title?.trim()) return content.title.trim();
  if (content?.status === 'blocked') return localizePT(language, 'Conteúdo bloqueado', 'Content blocked');
  const counts = dashboard.content?.pipelineCount;
  if (!counts) return localizePT(language, 'Nenhuma ideia ainda', 'No ideas yet');
  if ((counts.scripted ?? 0) > 0) {
    return localizePT(language, `${counts.scripted} roteiro${counts.scripted === 1 ? '' : 's'} em andamento`, `${counts.scripted} script${counts.scripted === 1 ? '' : 's'} in progress`);
  }
  if ((counts.ideas ?? 0) > 0) {
    return localizePT(language, `${counts.ideas} ideia${counts.ideas === 1 ? '' : 's'} no radar`, `${counts.ideas} idea${counts.ideas === 1 ? '' : 's'} on the radar`);
  }
  return localizePT(language, 'Nenhuma ideia ainda', 'No ideas yet');
}

function buildContentSubline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
): string | null {
  const content = brief?.day.content;
  if (!content) return localizePT(language, 'Toque para planear', 'Tap to plan');
  if (content.note?.trim()) return content.note.trim();
  if (content.blockStart && content.blockEnd) return `${content.blockStart}–${content.blockEnd}`;
  switch (content.status) {
    case 'scheduled':
      return localizePT(language, 'Janela pronta para avançar', 'A slot is ready to move forward');
    case 'blocked':
      return localizePT(language, 'Há um bloqueio a resolver antes de avançar', 'There is a blocker to resolve before moving forward');
    default:
      return null;
  }
}

function buildCookingHeadline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
): string {
  if (!brief || brief.day.meals.length === 0) {
    return localizePT(language, 'Planejar refeições', 'Plan meals');
  }
  return brief.day.meals[0]?.title?.trim()
    || quantifiedLabel(brief.day.meals.length, language, 'refeição alinhada', 'refeições alinhadas', 'meal aligned', 'meals aligned');
}

function buildCookingSubline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  _language: Lang,
): string | null {
  if (!brief || brief.day.meals.length === 0) return null;
  return brief.day.meals[0]?.note?.trim() || null;
}

function buildFinanceHeadline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
  language: Lang,
): string {
  const finance = brief?.day.finance;
  const note = firstRenderable([
    finance?.budgetNote,
    finance?.taxNote,
    finance?.subscriptionNote,
  ]);
  return note ?? localizePT(language, 'Finanças sob controle', 'Finances under control');
}

function buildFinanceSubline(
  brief: Awaited<ReturnType<typeof composeDailyBrief>> | null,
): string | null {
  const finance = brief?.day.finance;
  return firstRenderable([
    finance?.taxNote,
    finance?.subscriptionNote,
  ]);
}

function localizeTrainingTitle(
  briefTitle: string | null | undefined,
  dashboardType: string | null | undefined,
  language: Lang,
): string | null {
  const preferred = briefTitle?.trim() || dashboardType?.trim() || null;
  if (!preferred || !language.startsWith('pt')) return preferred;

  const normalized = preferred.toLowerCase();
  if (normalized === 'rest' || normalized === 'rest day') return 'Descanso';
  if (normalized === 'recovery') return 'Recuperação';

  const trainingSignals = [
    /\blong\s+conditioning\s+session\b/i,
    /\bconditioning\s+session\b/i,
    /\bmobility\s*\+\s*recovery\b/i,
    /\bcore\s+support\b/i,
    /\bkey\s+session\b/i,
    /\bfitness\s+baseline\s+test\b/i,
    /\bno\s+training\b/i,
    /\bupper\s+body\s+strength\b/i,
    /\blower\s+body\s+strength\b/i,
    /\btrack\s+intervals\b/i,
    /\btempo\s+ride\b/i,
    /\btempo\s+run\b/i,
    /\blong\s+run\b/i,
    /\beasy\s+run\b/i,
    /\brecovery\s+swim\b/i,
    /\brecovery\s+ride\b/i,
    /\brecovery\s+run\b/i,
    /\bactive\s+recovery\b/i,
    /\bstrength\b/i,
    /\bgym\b/i,
    /\bcycling\b/i,
    /\bcycle\b/i,
    /\bbike\b/i,
    /\bride\b/i,
    /\bswim\b/i,
    /\brun\b/i,
    /\btraining\b/i,
    /\bworkout\b/i,
    /\bsession\b/i,
    /\bbrick\b/i,
  ];

  if (!trainingSignals.some((pattern) => pattern.test(preferred))) {
    return preferred;
  }

  const patterns: Array<[RegExp, string]> = [
    [/\blong\s+conditioning\s+session\b/gi, 'Sessão longa de condicionamento'],
    [/\bconditioning\s+session\b/gi, 'Sessão de condicionamento'],
    [/\bmobility\s*\+\s*recovery\b/gi, 'Mobilidade + recuperação'],
    [/\bcore\s+support\b/gi, 'Core de suporte'],
    [/\bkey\s+session\b/gi, 'Sessão-chave'],
    [/\bfitness\s+baseline\s+test\b/gi, 'Teste de base física'],
    [/\bno\s+training\b/gi, 'Sem treino'],
    [/\bupper\s+body\s+strength\b/gi, 'Força de tronco superior'],
    [/\blower\s+body\s+strength\b/gi, 'Força de pernas'],
    [/\btrack\s+intervals\b/gi, 'Intervalos de pista'],
    [/\btempo\s+ride\b/gi, 'Treino tempo de bicicleta'],
    [/\btempo\s+run\b/gi, 'Corrida tempo'],
    [/\blong\s+run\b/gi, 'Corrida longa'],
    [/\beasy\s+run\b/gi, 'Corrida fácil'],
    [/\brecovery\s+swim\b/gi, 'Natação de recuperação'],
    [/\brecovery\s+ride\b/gi, 'Bicicleta de recuperação'],
    [/\brecovery\s+run\b/gi, 'Corrida de recuperação'],
    [/\bactive\s+recovery\b/gi, 'Recuperação ativa'],
    [/\bbrick\s+session\b/gi, 'Sessão brick'],
    [/\bupper\s+body\b/gi, 'Tronco superior'],
    [/\blower\s+body\b/gi, 'Pernas'],
    [/\brest\s+day\b/gi, 'Descanso'],
    [/\bstrength\b/gi, 'Força'],
    [/\bgym\b/gi, 'Ginásio'],
    [/\bcycling\b/gi, 'Ciclismo'],
    [/\bcycle\b/gi, 'Ciclismo'],
    [/\bbike\b/gi, 'Bicicleta'],
    [/\bride\b/gi, 'Saída de bicicleta'],
    [/\bswim\b/gi, 'Natação'],
    [/\brun\b/gi, 'Corrida'],
    [/\btraining\b/gi, 'Treino'],
    [/\bworkout\b/gi, 'Treino'],
    [/\bsession\b/gi, 'Sessão'],
  ];

  let localized = preferred;
  for (const [pattern, replacement] of patterns) {
    localized = localized.replace(pattern, replacement);
  }
  return localized.replace(/\b(\d+)\s*[kK]\b/g, '$1 km').replace(/\s{2,}/g, ' ').trim();
}

function quantifiedLabel(
  count: number,
  language: Lang,
  singularPT: string,
  pluralPT: string,
  singularEN: string,
  pluralEN: string,
): string {
  if (language.startsWith('pt')) {
    return `${count} ${count === 1 ? singularPT : pluralPT}`;
  }
  return `${count} ${count === 1 ? singularEN : pluralEN}`;
}

function formatEventRange(start?: string | null, end?: string | null): string {
  if (start && end) return `${start}–${end}`;
  return start ?? end ?? '';
}

function currentLocalMinutes(): number {
  const now = new Date();
  const localized = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: config.app.timezone,
  }).format(now);
  return timeToMinutes(localized) ?? 0;
}

function timeToMinutes(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function firstRenderable(values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim() ?? '').find((value) => value.length > 0) ?? null;
}

function localizePT(language: Lang, pt: string, en: string): string {
  return language.startsWith('pt') ? pt : en;
}

function compactStrings<T>(values: Array<T | null | undefined>): T[] {
  return values.filter((value): value is T => value != null);
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
    color: typeof e.color === 'string' ? e.color : null,
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
  const cachedReadiness = getCached<{ score: number; bodyBattery: number | null; reasonCode?: string | null }>(
    dashboardReadinessCacheKeyFor(userId),
  );
  if (cachedReadiness) {
    if (isSyntheticNeutralCachedReadiness(cachedReadiness)) {
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
        warningCodes.push('WEARABLE_INTEGRATION_MISSING', 'BODY_BATTERY_UNAVAILABLE');
        warnings.push(
          'Wearable integration is missing, so readiness is using a neutral fallback right now.',
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
        {
          score: readinessScore,
          bodyBattery,
          reasonCode: typeof readiness?.reasonCode === 'string' ? readiness.reasonCode : null,
        },
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

  // Get today's training — first try training plans, then calendar fallback.
  //
  // Bug fix (hardening audit 2026-04-20): the prior implementation called
  // `getSessionsForWeek(userId)` but that function's signature is
  // `getSessionsForWeek(weekId: number)` — it queries `training_sessions`
  // by `week_id` with no user scope. Passing `userId` meant we fetched
  // rows from whatever `week` row happened to have `id === userId`, which
  // in practice returned an empty array (silently defeating the primary
  // path and forcing the calendar fallback on every dashboard hit) and,
  // in the edge case of a userId↔weekId collision, would leak sessions
  // from another user's plan. Resolve the current week via the active
  // plan and derive "today" from `day_of_week` against the user's local
  // weekday.
  let todaySession: any = null;
  try {
    const { getActivePlan, getCurrentWeek, getSessionsForWeek } = require('../../services/training-plans');
    const plan = getActivePlan(userId);
    const currentWeek = plan ? getCurrentWeek(plan.id) : null;
    const sessions = currentWeek ? getSessionsForWeek(currentWeek.id) : null;
    if (Array.isArray(sessions) && sessions.length > 0) {
      const todayDow = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      todaySession = sessions.find((s: any) => s?.day_of_week === todayDow) || null;
    }
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
  if (readiness?.reasonCode === 'WEARABLE_INTEGRATION_MISSING') return true;
  const reasoning = String(readiness?.reasoning || '').toLowerCase();
  return reasoning.includes('no wearable connected');
}

function isSyntheticNeutralCachedReadiness(readiness: { score: number; bodyBattery: number | null; reasonCode?: string | null } | null): boolean {
  if (readiness?.reasonCode === 'WEARABLE_INTEGRATION_MISSING') return true;
  return readiness?.score === 60 && readiness?.bodyBattery === 0;
}
