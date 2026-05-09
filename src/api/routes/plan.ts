// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { apiSuccess, sendError, sendInternalError } from '../response-helpers';
import { config } from '../../config';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import { composeWeeklyPlan } from '../../services/weekly-plan-orchestrator';
import { invalidatePlanningCaches } from '../../services/cache-coherence-registry';
import { getUserById, getUserLanguageById } from '../../services/user-service';
import { getCachedSWR, setCacheSWR } from '../../services/cache-store';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { recordSWRRefreshFailure, recordSWRRefreshSuccess } from '../../services/swr-refresh-observability';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { timedAsync, type RouteTiming } from '../route-timing';
import { sendConditionalApiSuccess } from '../conditional-cache';

const PLAN_TODAY_TTL_SECONDS = 60;
const PLAN_TODAY_SWR_STALE_SECONDS = 300;
const PLAN_WEEK_TTL_SECONDS = 120;
const PLAN_WEEK_SWR_STALE_SECONDS = 600;
const swrInFlight = new Set<string>();

function ensureValidPlanRouteScope(
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

export function planRoutes(): Router {
  const router = Router();

  router.get('/week', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidPlanRouteScope(res, userId, 'plan_route_week', { weekStart: req.query.weekStart ?? null })) return;
    const weekStart = typeof req.query.weekStart === 'string' ? req.query.weekStart : undefined;
    const language = resolvePlanLanguage(req, userId);
    const cacheKey = planWeekRouteCacheKey(userId, weekStart, language);

    try {
      const swr = getCachedSWR<Awaited<ReturnType<typeof composeWeeklyPlan>>>(cacheKey);
      if (swr) {
        sendConditionalApiSuccess(res, req, swr.value, {
          cached: true,
          timings: [{ name: 'cache_hit', durationMs: 0 }],
        });
        if (!swr.fresh) {
          swrRefresh(cacheKey, async () => {
            const refreshed = await composeWeeklyPlan({ userId, weekStart });
            setCacheSWR(cacheKey, refreshed, PLAN_WEEK_TTL_SECONDS, PLAN_WEEK_SWR_STALE_SECONDS);
          });
        }
        return;
      }

      const timings: RouteTiming[] = [];
      const data = await timedAsync(timings, 'weekly_plan', () => composeWeeklyPlan({ userId, weekStart }));
      setCacheSWR(cacheKey, data, PLAN_WEEK_TTL_SECONDS, PLAN_WEEK_SWR_STALE_SECONDS);
      sendConditionalApiSuccess(res, req, data, { timings });
    } catch (err: any) {
      sendInternalError(res, 'Unable to load the weekly plan right now.');
    }
  });

  router.get('/today', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidPlanRouteScope(res, userId, 'plan_route_today', { date: req.query.date ?? null })) return;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    const language = resolvePlanLanguage(req, userId);
    const cacheKey = planTodayRouteCacheKey(userId, date, language);

    try {
      const swr = getCachedSWR<Awaited<ReturnType<typeof composeDailyBrief>>>(cacheKey);
      if (swr) {
        sendConditionalApiSuccess(res, req, swr.value, {
          cached: true,
          timings: [{ name: 'cache_hit', durationMs: 0 }],
        });
        if (!swr.fresh) {
          swrRefresh(cacheKey, async () => {
            const refreshed = await composeDailyBrief({ userId, date, language });
            setCacheSWR(cacheKey, refreshed, PLAN_TODAY_TTL_SECONDS, PLAN_TODAY_SWR_STALE_SECONDS);
          });
        }
        return;
      }

      const timings: RouteTiming[] = [];
      const data = await timedAsync(timings, 'daily_brief', () => composeDailyBrief({ userId, date, language }));
      setCacheSWR(cacheKey, data, PLAN_TODAY_TTL_SECONDS, PLAN_TODAY_SWR_STALE_SECONDS);
      sendConditionalApiSuccess(res, req, data, { timings });
    } catch (err: any) {
      sendInternalError(res, 'Unable to load the daily plan right now.');
    }
  });

  router.post('/recompute', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidPlanRouteScope(res, userId, 'plan_route_recompute', {
      weekStart: req.body?.weekStart ?? null,
      date: req.body?.date ?? null,
    })) return;
    const weekStart = typeof req.body?.weekStart === 'string' ? req.body.weekStart : undefined;
    const date = typeof req.body?.date === 'string' ? req.body.date : undefined;

    invalidatePlanningCaches(userId);

    try {
      const week = await composeWeeklyPlan({ userId, weekStart, forceRefresh: true });
      const today = await composeDailyBrief({ userId, date, forceRefresh: true });
      res.json(apiSuccess({ week, today }));
    } catch (err: any) {
      sendInternalError(res, 'Unable to recompute the plan right now.');
    }
  });

  router.get('/week/explain', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidPlanRouteScope(res, userId, 'plan_route_week_explain', { weekStart: req.query.weekStart ?? null })) return;
    const weekStart = typeof req.query.weekStart === 'string' ? req.query.weekStart : undefined;
    const user = getUserById(userId);

    if (!user || !['max', 'owner'].includes(user.tier)) {
      sendError(res, 'FORBIDDEN', 'Max tier required for explanation view', 403, {
        plan: user?.tier ?? 'free',
      });
      return;
    }

    try {
      const data = await composeWeeklyPlan({ userId, weekStart });
      res.json(apiSuccess({
        explanation: buildWeeklyExplanation(data),
        degraded: data.degraded,
        gated: data.gated,
        garmin_stale: data.garmin_stale,
        conflicts: data.conflicts,
      }));
    } catch (err: any) {
      sendInternalError(res, 'Unable to explain the weekly plan right now.');
    }
  });

  return router;
}

function swrRefresh(key: string, fn: () => Promise<void>): void {
  if (swrInFlight.has(key)) return;
  swrInFlight.add(key);
  fn()
    .then(() => recordSWRRefreshSuccess(key))
    .catch((err) => recordSWRRefreshFailure(key, err, { source: 'plan_route', operation: 'plan_swr_refresh' }))
    .finally(() => swrInFlight.delete(key));
}

function resolvePlanLanguage(req: Request, userId: number): string {
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguageById(userId);
}

function planTodayRouteCacheKey(userId: number, date: string | undefined, language: string): string {
  const targetDate = resolveDateKey(date);
  return `plan:today:u:${userId}:${targetDate}:route:${languageBucket(language)}`;
}

function planWeekRouteCacheKey(userId: number, weekStart: string | undefined, language: string): string {
  const targetWeek = resolveWeekKey(weekStart);
  return `plan:week:u:${userId}:${targetWeek}:route:${languageBucket(language)}`;
}

function resolveDateKey(date: string | undefined): string {
  if (date) {
    const parsed = DateTime.fromISO(date, { zone: config.app.timezone || 'Europe/Lisbon' });
    if (parsed.isValid) return parsed.toISODate()!;
  }
  return DateTime.now().setZone(config.app.timezone || 'Europe/Lisbon').toISODate()!;
}

function resolveWeekKey(weekStart: string | undefined): string {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const parsed = weekStart
    ? DateTime.fromISO(weekStart, { zone })
    : DateTime.now().setZone(zone);
  const base = parsed.isValid ? parsed : DateTime.now().setZone(zone);
  return base.startOf('week').toISODate()!;
}

function languageBucket(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized.startsWith('pt-br')) return 'pt-br';
  if (normalized.startsWith('pt')) return 'pt';
  return normalized || 'en';
}

function buildWeeklyExplanation(data: Awaited<ReturnType<typeof composeWeeklyPlan>>): string {
  const lines: string[] = [];
  lines.push(`Variant: ${data.variant}.`);
  if (data.degraded) {
    lines.push('Creative copy was suppressed because the user is over the daily AI cap.');
  }
  if (data.garmin_stale) {
    lines.push('Garmin data is stale, so the plan leans on the latest coach briefing snapshot and active signals.');
  }
  if (data.conflicts.length > 0) {
    lines.push(`Conflicts surfaced: ${data.conflicts.map((conflict) => conflict.message).join(' | ')}.`);
  }
  for (const day of data.days) {
    const decisions = [
      ...day.training.decisions,
      ...day.secretary.decisions,
      ...(day.content?.decisions ?? []),
      ...(day.finance?.decisions ?? []),
      ...day.meals.flatMap((meal) => meal.decisions),
    ];
    if (decisions.length === 0) {
      lines.push(`${day.weekday}: ${day.headline}`);
      continue;
    }
    lines.push(`${day.weekday}: ${day.headline} Decisions -> ${decisions.map((decision) => `${decision.signalType}#${decision.signalId} (mp${decision.meshPriority})`).join(', ')}.`);
  }
  return lines.join('\n');
}
