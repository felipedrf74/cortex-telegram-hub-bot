// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { apiSuccess, sendError, sendInternalError } from '../response-helpers';
import { config } from '../../config';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import { composeWeeklyPlan } from '../../services/weekly-plan-orchestrator';
import {
  PlanningRecomputeError,
  recomputePlanningSnapshot,
} from '../../services/planning-recompute-service';
import { getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import { createDecisionPlanningContext } from '../../services/decision-planning-context';
import { entitlementPlanToSkillTier, getEffectiveEntitlement } from '../../services/entitlement';
import { normalizeLangHeader } from '../../services/secretary-fastpath';
import { timedAsync, type RouteTiming } from '../route-timing';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';
import { isValidTenantUserId } from '../../services/tenant-scope-observability';

const PLAN_TODAY_TTL_SECONDS = 60;
const PLAN_TODAY_SWR_STALE_SECONDS = 300;
const PLAN_WEEK_TTL_SECONDS = 120;
const PLAN_WEEK_SWR_STALE_SECONDS = 600;

export function planRoutes(): Router {
  const router = Router();

  router.get('/week', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'plan_route_week', { weekStart: req.query.weekStart ?? null })) return;
    const tenantId = routeTenantId(req, userId);
    const weekStart = typeof req.query.weekStart === 'string' ? req.query.weekStart : undefined;

    try {
      const language = resolvePlanLanguage(req, userId);
      const timezone = resolvePlanTimezone(userId);
      const planningContext = createDecisionPlanningContext({
        userId,
        tenantId,
        timezone,
        locale: language,
      });
      const capturedWeekStart = weekStart ?? DateTime.fromISO(
        planningContext.localDate,
        { zone: planningContext.timezone },
      ).startOf('week').toISODate()!;
      const cacheKey = planWeekRouteCacheKey(
        userId,
        tenantId,
        capturedWeekStart,
        planningContext.locale,
        planningContext.timezone,
        planningContext.localDate,
      );
      const timings: RouteTiming[] = [];
      await handleCachedRoute<Awaited<ReturnType<typeof composeWeeklyPlan>>>({
        cacheKey,
        ttlSeconds: PLAN_WEEK_TTL_SECONDS,
        staleSeconds: PLAN_WEEK_SWR_STALE_SECONDS,
        refreshContext: { source: 'plan_route', operation: 'plan_swr_refresh', userId },
        fetchFresh: () => timedAsync(timings, 'weekly_plan', () => composeWeeklyPlan({
          userId,
          tenantId,
          weekStart: capturedWeekStart,
          timezone: planningContext.timezone,
          forceRefresh: true,
          cacheMode: 'bypass',
          planningContext,
        })),
        send: (data, meta) => {
          sendConditionalApiSuccess(res, req, data, {
            cached: meta.cached,
            timings: meta.cached ? [{ name: 'cache_hit', durationMs: 0 }] : timings,
          });
        },
      });
    } catch (err: any) {
      sendInternalError(res, 'Unable to load the weekly plan right now.');
    }
  });

  router.get('/today', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'plan_route_today', { date: req.query.date ?? null })) return;
    const tenantId = routeTenantId(req, userId);
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;

    try {
      const language = resolvePlanLanguage(req, userId);
      const timezone = resolvePlanTimezone(userId);
      const planningContext = createDecisionPlanningContext({
        userId,
        tenantId,
        timezone,
        locale: language,
      });
      const capturedDate = date ?? planningContext.localDate;
      const cacheKey = planTodayRouteCacheKey(
        userId,
        tenantId,
        capturedDate,
        planningContext.locale,
        planningContext.timezone,
        planningContext.localDate,
      );
      const timings: RouteTiming[] = [];
      await handleCachedRoute<Awaited<ReturnType<typeof composeDailyBrief>>>({
        cacheKey,
        ttlSeconds: PLAN_TODAY_TTL_SECONDS,
        staleSeconds: PLAN_TODAY_SWR_STALE_SECONDS,
        refreshContext: { source: 'plan_route', operation: 'plan_swr_refresh', userId },
        fetchFresh: () => timedAsync(timings, 'daily_brief', () => composeDailyBrief({
          userId,
          tenantId,
          date: capturedDate,
          language: planningContext.locale,
          timezone: planningContext.timezone,
          forceRefresh: true,
          cacheMode: 'bypass',
          planningContext,
        })),
        send: (data, meta) => {
          sendConditionalApiSuccess(res, req, data, {
            cached: meta.cached,
            timings: meta.cached ? [{ name: 'cache_hit', durationMs: 0 }] : timings,
          });
        },
      });
    } catch (err: any) {
      sendInternalError(res, 'Unable to load the daily plan right now.');
    }
  });

  router.post('/recompute', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'plan_route_recompute', {
      weekStart: req.body?.weekStart ?? null,
      date: req.body?.date ?? null,
    })) return;
    const tenantId = routeTenantId(req, userId);
    const headerIdempotencyKey = req.header?.('idempotency-key');

    try {
      const timezone = resolvePlanTimezone(userId);
      const locale = resolvePlanLanguage(req, userId);
      const result = await recomputePlanningSnapshot({
        userId,
        tenantId,
        timezone,
        locale,
        idempotencyKey: req.body?.idempotencyKey ?? headerIdempotencyKey,
        weekStart: req.body?.weekStart,
        date: req.body?.date,
      });
      res.json(apiSuccess(result));
    } catch (err: any) {
      if (err instanceof PlanningRecomputeError) {
        sendError(res, err.code, err.message, err.status);
        return;
      }
      sendInternalError(res, 'Unable to recompute the plan right now.');
    }
  });

  router.get('/week/explain', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureCachedRouteTenantScope(res, userId, 'plan_route_week_explain', { weekStart: req.query.weekStart ?? null })) return;
    const tenantId = routeTenantId(req, userId);
    const weekStart = typeof req.query.weekStart === 'string' ? req.query.weekStart : undefined;
    const effectiveTier = entitlementPlanToSkillTier(getEffectiveEntitlement(userId).plan);

    if (!['max', 'owner'].includes(effectiveTier)) {
      sendError(res, 'FORBIDDEN', 'Max tier required for explanation view', 403, {
        plan: effectiveTier,
      });
      return;
    }

    try {
      const timezone = resolvePlanTimezone(userId);
      const locale = resolvePlanLanguage(req, userId);
      const planningContext = createDecisionPlanningContext({ userId, tenantId, timezone, locale });
      const data = await composeWeeklyPlan({
        userId,
        tenantId,
        weekStart,
        timezone: planningContext.timezone,
        planningContext,
      });
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

function resolvePlanLanguage(req: Request, userId: number): string {
  const rawHeader = req.header?.('x-language');
  if (rawHeader) return normalizeLangHeader(rawHeader);
  return getUserLanguageById(userId);
}

function routeTenantId(req: Request, userId: number): number {
  const candidate = (req as AuthenticatedRequest).tenantId;
  return isValidTenantUserId(candidate) ? candidate : userId;
}

function planTodayRouteCacheKey(
  userId: number,
  tenantId: number,
  date: string | undefined,
  language: string,
  timezone: string,
  fallbackLocalDate?: string,
): string {
  const targetDate = resolveDateKey(date, timezone, fallbackLocalDate);
  return routeCacheKey('plan', 'today', 'u', userId, 'tenant', tenantId, targetDate, 'tz', timezone, 'route', languageBucket(language));
}

function planWeekRouteCacheKey(
  userId: number,
  tenantId: number,
  weekStart: string | undefined,
  language: string,
  timezone: string,
  fallbackLocalDate?: string,
): string {
  const targetWeek = resolveWeekKey(weekStart, timezone, fallbackLocalDate);
  return routeCacheKey('plan', 'week', 'u', userId, 'tenant', tenantId, targetWeek, 'tz', timezone, 'route', languageBucket(language));
}

function resolveDateKey(date: string | undefined, zone: string, fallbackLocalDate?: string): string {
  if (date) {
    const parsed = DateTime.fromISO(date, { zone });
    if (parsed.isValid) return parsed.toISODate()!;
  }
  const capturedFallback = DateTime.fromISO(fallbackLocalDate ?? '', { zone });
  return (capturedFallback.isValid ? capturedFallback : DateTime.now().setZone(zone)).toISODate()!;
}

function resolveWeekKey(
  weekStart: string | undefined,
  zone: string,
  fallbackLocalDate?: string,
): string {
  const parsed = weekStart
    ? DateTime.fromISO(weekStart, { zone })
    : DateTime.fromISO(fallbackLocalDate ?? '', { zone });
  const capturedFallback = DateTime.fromISO(fallbackLocalDate ?? '', { zone });
  const base = parsed.isValid
    ? parsed
    : capturedFallback.isValid
      ? capturedFallback
      : DateTime.now().setZone(zone);
  return base.startOf('week').toISODate()!;
}

function resolvePlanTimezone(userId: number): string {
  try {
    const timezone = getUserTimezoneById(userId);
    return DateTime.local().setZone(timezone).isValid
      ? timezone
      : config.app.timezone || 'Europe/Lisbon';
  } catch {
    return config.app.timezone || 'Europe/Lisbon';
  }
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
    lines.push('The plan is degraded because one or more planning sources or generation gates were unavailable.');
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
