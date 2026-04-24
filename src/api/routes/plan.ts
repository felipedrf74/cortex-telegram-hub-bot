// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { apiSuccess, sendError, sendInternalError } from '../response-helpers';
import { composeDailyBrief } from '../../services/daily-brief-orchestrator';
import { composeWeeklyPlan } from '../../services/weekly-plan-orchestrator';
import { invalidatePlanningCaches } from '../../services/plan-cache-invalidator';
import { getUserById } from '../../services/user-service';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';

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

    try {
      const data = await composeWeeklyPlan({ userId, weekStart });
      sendEtagged(res, req, data);
    } catch (err: any) {
      sendInternalError(res, 'Unable to load the weekly plan right now.');
    }
  });

  router.get('/today', async (req: Request, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidPlanRouteScope(res, userId, 'plan_route_today', { date: req.query.date ?? null })) return;
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;

    try {
      const data = await composeDailyBrief({ userId, date });
      sendEtagged(res, req, data);
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

function sendEtagged(res: Response, req: Request, data: unknown): void {
  const envelope = apiSuccess(data);
  const envelopeJson = JSON.stringify({ ...envelope, timestamp: undefined });
  const etag = `"${crypto.createHash('md5').update(envelopeJson).digest('hex')}"`;

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=30');
  res.json(envelope);
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
