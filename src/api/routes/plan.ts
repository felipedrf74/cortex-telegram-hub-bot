// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { apiSuccess, sendError, sendInternalError } from '../response-helpers';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import { composeWeeklyPlan } from '../../services/weekly-plan-orchestrator';
import {
  PlanningRecomputeError,
  recomputePlanningSnapshot,
} from '../../services/planning-recompute-service';
import { entitlementPlanToSkillTier, getEffectiveEntitlement } from '../../services/entitlement';
import { timedAsync, type RouteTiming } from '../route-timing';
import { sendConditionalApiSuccess } from '../conditional-cache';
import { ensureCachedRouteTenantScope, handleCachedRoute, routeCacheKey } from '../route-helpers/cached-route-handler';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import {
  resolveSecretaryPlanningContext,
  SecretaryPlanningContextError,
  type SecretaryPlanningContext,
} from '../../services/secretary-planning-context';
import {
  markDailyPlanSourcesStale,
  markWeeklyPlanSourcesStale,
} from '../../services/secretary-planning-snapshot';

const PLAN_TODAY_TTL_SECONDS = 60;
const PLAN_TODAY_SWR_STALE_SECONDS = 300;
const PLAN_WEEK_TTL_SECONDS = 120;
const PLAN_WEEK_SWR_STALE_SECONDS = 600;

export function planRoutes(): Router {
  const router = Router();

  router.get('/week', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const context = resolveRoutePlanningContext(req, res, userId, 'plan_route_week', {
      weekStart: req.query.weekStart,
    });
    if (!context) return;
    const cacheKey = planWeekRouteCacheKey(context);

    try {
      const timings: RouteTiming[] = [];
      await handleCachedRoute<Awaited<ReturnType<typeof composeWeeklyPlan>>>({
        cacheKey,
        ttlSeconds: PLAN_WEEK_TTL_SECONDS,
        staleSeconds: PLAN_WEEK_SWR_STALE_SECONDS,
        refreshContext: { source: 'plan_route', operation: 'plan_swr_refresh', userId },
        fetchFresh: () => timedAsync(timings, 'weekly_plan', () => composeWeeklyPlan({
          userId,
          tenantId: context.tenantId,
          weekStart: context.weekStart,
          language: context.language,
          context,
        })),
        send: (data, meta) => {
          sendConditionalApiSuccess(res, req, meta.cached && !meta.fresh ? markWeeklyPlanSourcesStale(data) : data, {
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
    const context = resolveRoutePlanningContext(req, res, userId, 'plan_route_today', {
      date: req.query.date,
    });
    if (!context) return;
    const cacheKey = planTodayRouteCacheKey(context);

    try {
      const timings: RouteTiming[] = [];
      await handleCachedRoute<Awaited<ReturnType<typeof composeDailyBrief>>>({
        cacheKey,
        ttlSeconds: PLAN_TODAY_TTL_SECONDS,
        staleSeconds: PLAN_TODAY_SWR_STALE_SECONDS,
        refreshContext: { source: 'plan_route', operation: 'plan_swr_refresh', userId },
        fetchFresh: () => timedAsync(timings, 'daily_brief', () => composeDailyBrief({
          userId,
          tenantId: context.tenantId,
          date: context.targetDate,
          language: context.language,
          context,
        })),
        send: (data, meta) => {
          sendConditionalApiSuccess(res, req, meta.cached && !meta.fresh ? markDailyPlanSourcesStale(data) : data, {
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
    const context = resolveRoutePlanningContext(req, res, userId, 'plan_route_recompute', {
      weekStart: req.body?.weekStart,
      date: req.body?.date,
    });
    if (!context) return;
    const headerIdempotencyKey = req.header?.('idempotency-key');

    try {
      const result = await recomputePlanningSnapshot({
        userId,
        tenantId: context.tenantId,
        context,
        idempotencyKey: req.body?.idempotencyKey ?? headerIdempotencyKey,
        weekStart: context.weekStart,
        date: context.targetDate,
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
    const context = resolveRoutePlanningContext(req, res, userId, 'plan_route_week_explain', {
      weekStart: req.query.weekStart,
    });
    if (!context) return;
    const effectiveTier = entitlementPlanToSkillTier(getEffectiveEntitlement(userId).plan);

    if (!['max', 'owner'].includes(effectiveTier)) {
      sendError(res, 'FORBIDDEN', 'Max tier required for explanation view', 403, {
        plan: effectiveTier,
      });
      return;
    }

    try {
      const data = await composeWeeklyPlan({
        userId,
        tenantId: context.tenantId,
        weekStart: context.weekStart,
        language: context.language,
        context,
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

function resolveRoutePlanningContext(
  req: Request,
  res: Response,
  userId: number | undefined,
  operation: string,
  input: { date?: unknown; weekStart?: unknown },
): SecretaryPlanningContext | null {
  if (!ensureCachedRouteTenantScope(res, userId, operation, {
    date: input.date ?? null,
    weekStart: input.weekStart ?? null,
  })) return null;

  const tenantId = (req as AuthenticatedRequest).tenantId;
  if (!isValidTenantUserId(tenantId) || tenantId !== userId) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation,
      reason: 'tenant_mismatch',
      userId,
      details: {
        tenantId: typeof tenantId === 'number' ? tenantId : null,
        date: input.date ?? null,
        weekStart: input.weekStart ?? null,
      },
    });
    sendError(res, 'INVALID_INPUT', 'The active tenant must match the authenticated user.', 400);
    return null;
  }

  if ((input.date !== undefined && typeof input.date !== 'string')
    || (input.weekStart !== undefined && typeof input.weekStart !== 'string')) {
    sendError(res, 'INVALID_INPUT', 'Planning dates must be ISO calendar date strings.', 400);
    return null;
  }
  if (typeof input.weekStart === 'string') {
    const parsedWeekStart = DateTime.fromISO(input.weekStart, { zone: 'UTC' });
    if (parsedWeekStart.isValid && parsedWeekStart.toISODate() === input.weekStart
      && parsedWeekStart.weekday !== 1) {
      sendError(res, 'INVALID_INPUT', 'weekStart must be a Monday.', 400);
      return null;
    }
  }

  try {
    return resolveSecretaryPlanningContext({
      userId,
      tenantId,
      date: input.date as string | undefined,
      weekStart: input.weekStart as string | undefined,
      language: req.header?.('x-language'),
    });
  } catch (error) {
    if (error instanceof SecretaryPlanningContextError
      && ['INVALID_DATE', 'INVALID_WEEK_START', 'DATE_OUTSIDE_WEEK'].includes(error.code)) {
      sendError(res, 'INVALID_INPUT', error.message, 400);
      return null;
    }
    throw error;
  }
}

function planTodayRouteCacheKey(context: SecretaryPlanningContext): string {
  return routeCacheKey(
    'plan', 'today', 'u', context.userId, 'tenant', context.tenantId,
    context.targetDate, 'tz', context.timezone, 'route', languageBucket(context.language),
  );
}

function planWeekRouteCacheKey(context: SecretaryPlanningContext): string {
  return routeCacheKey(
    'plan', 'week', 'u', context.userId, 'tenant', context.tenantId,
    context.weekStart, 'tz', context.timezone, 'route', languageBucket(context.language),
  );
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
  if ((data.warningCodes ?? []).includes('AI_COPY_QUOTA_REACHED')) {
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
