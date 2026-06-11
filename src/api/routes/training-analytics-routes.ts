// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import type { Lang } from '../../utils/i18n';
import { getCached, setCache } from '../../services/cache-store';
import { sendSuccess, sendError, sendInternalError } from '../response-helpers';
import {
  getCardioProgression,
  getStrengthProgression,
} from '../../services/progression-analytics';
import { getUnifiedWeeklyActivitySummary } from '../../services/session-analytics';
import {
  decodeTrainingHistoryCursor,
  getTrainingHistoryPage,
  type TrainingHistoryCursor,
} from '../../services/training-history';
import {
  publishAdherenceSignalsForUser,
  publishPlanDriftSignalForUser,
} from '../../services/adherence-signals';
import { assertTenantScope, TenantScopeError } from '../../services/tenant-scope';
import { getDb } from '../../services/database';
import { loadCoachKnowledge } from '../../services/coach-kernel/knowledge-loader';
import { getAcwrThresholds } from '../../services/coach-kernel/training-principles';
import { classifyAcwr, type LoadDimension } from '../../services/coach-kernel/load-model';
import { hydrateLoadModelByDimension } from './training-coach-v2-load-helper';

export type TrainingLanguageResolver = (
  req: Pick<AuthenticatedRequest, 'header'>,
  userId: number,
) => Lang;

function invalidCardioSportMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o parâmetro sport deve ser "running" ou "cycling"';
  if (language.startsWith('pt')) return 'o parâmetro sport tem de ser "running" ou "cycling"';
  return 'sport query param must be "running" or "cycling"';
}

const HISTORY_SPORTS = ['running', 'cycling', 'strength', 'swimming'] as const;
type HistorySport = (typeof HISTORY_SPORTS)[number];

function invalidHistorySportMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o parâmetro sport deve ser "running", "cycling", "strength" ou "swimming"';
  if (language.startsWith('pt')) return 'o parâmetro sport tem de ser "running", "cycling", "strength" ou "swimming"';
  return 'sport query param must be "running", "cycling", "strength" or "swimming"';
}

function invalidHistoryCursorMessage(language: Lang): string {
  if (language.startsWith('pt')) return 'o parâmetro cursor é inválido';
  return 'cursor query param is invalid';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function requireTrainingAnalyticsScope(
  req: AuthenticatedRequest,
  res: Response,
  operation: string,
): { userId: number; tenantId: number } | null {
  try {
    return assertTenantScope(req, operation);
  } catch (err) {
    if (err instanceof TenantScopeError) {
      sendError(res, err.code, err.message, err.status);
      return null;
    }
    throw err;
  }
}

export function registerTrainingAnalyticsRoutes(
  router: Router,
  resolveTrainingLanguage: TrainingLanguageResolver,
): void {
  /**
   * GET /api/v1/training/progression/cardio
   *
   * Longitudinal cardio progression for running or cycling. Aggregates
   * by week rather than per-exercise, since cardio sessions do not have
   * per-lift 1RM trajectories.
   */
  router.get('/progression/cardio', async (req, res: Response) => {
    const scope = requireTrainingAnalyticsScope(req as AuthenticatedRequest, res, 'training.analytics.progression.cardio');
    if (!scope) return;
    const { userId, tenantId } = scope;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);
    const sportRaw = typeof req.query.sport === 'string' ? req.query.sport : '';
    if (sportRaw !== 'running' && sportRaw !== 'cycling') {
      sendError(res, 'BAD_REQUEST', invalidCardioSportMessage(language), 400);
      return;
    }
    const sport = sportRaw as 'running' | 'cycling';

    const weeksRaw = Number(req.query.weeks);
    const weeks = Number.isFinite(weeksRaw)
      ? Math.min(52, Math.max(1, Math.floor(weeksRaw)))
      : 8;

    const cacheKey = `cardio-progression:${tenantId}:${userId}:${sport}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const report = getCardioProgression(userId, tenantId, sport, weeks);
      setCache(cacheKey, report, 120);
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, tenantId, sport, weeks }, 'GET /progression/cardio failed');
      sendInternalError(res, 'Failed to load cardio progression');
    }
  });

  /**
   * GET /api/v1/training/progression/strength
   *
   * Longitudinal strength progression over the past N weeks. Drives the
   * iOS progression view and mirrors the shape the coach context consumes.
   */
  router.get('/progression/strength', async (req, res: Response) => {
    const scope = requireTrainingAnalyticsScope(req as AuthenticatedRequest, res, 'training.analytics.progression.strength');
    if (!scope) return;
    const { userId, tenantId } = scope;
    const weeksRaw = Number(req.query.weeks);
    const weeks = Number.isFinite(weeksRaw)
      ? Math.min(52, Math.max(1, Math.floor(weeksRaw)))
      : 8;

    const cacheKey = `strength-progression:${tenantId}:${userId}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const report = getStrengthProgression(userId, tenantId, weeks);
      setCache(cacheKey, report, 120);
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, tenantId, weeks }, 'GET /progression/strength failed');
      sendInternalError(res, 'Failed to load strength progression');
    }
  });

  /**
   * GET /api/v1/training/activity/weekly
   *
   * Weekly activity summary plus best-effort adherence/drift signal
   * publishing. Signal failures must never take down the read contract.
   */
  router.get('/activity/weekly', async (req, res: Response) => {
    const scope = requireTrainingAnalyticsScope(req as AuthenticatedRequest, res, 'training.analytics.activity.weekly');
    if (!scope) return;
    const { userId, tenantId } = scope;
    const cacheKey = `training-activity-weekly:${tenantId}:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const summary = await getUnifiedWeeklyActivitySummary(userId, tenantId);

      try {
        publishAdherenceSignalsForUser(userId, tenantId);
      } catch (err) {
        logger.warn({ err, userId, tenantId }, 'adherence signal publish failed — summary still returned');
      }

      try {
        publishPlanDriftSignalForUser(userId, tenantId);
      } catch (err) {
        logger.warn({ err, userId, tenantId }, 'plan drift signal publish failed — summary still returned');
      }

      setCache(cacheKey, summary, 60);
      sendSuccess(res, summary);
    } catch (err: any) {
      logger.error({ err, userId, tenantId }, 'GET /activity/weekly failed');
      sendInternalError(res, 'Failed to load weekly activity');
    }
  });

  /**
   * GET /api/v1/training/history
   *
   * Keyset-paginated unified training log: completed entries from
   * `training_completions`, bare completed sessions (marked done with
   * no feedback row), and skipped sessions. Drives the Progress-zone
   * history list in the iOS Training redesign. First
   * page (no cursor) is cached for 60s; cursor pages are never cached
   * so pagination always reads fresh keyset slices.
   */
  router.get('/history', async (req, res: Response) => {
    const scope = requireTrainingAnalyticsScope(req as AuthenticatedRequest, res, 'training.analytics.history');
    if (!scope) return;
    const { userId, tenantId } = scope;
    const language = resolveTrainingLanguage(req as AuthenticatedRequest, userId);

    const sportRaw = typeof req.query.sport === 'string' ? req.query.sport : '';
    if (sportRaw !== '' && !HISTORY_SPORTS.includes(sportRaw as HistorySport)) {
      sendError(res, 'BAD_REQUEST', invalidHistorySportMessage(language), 400);
      return;
    }
    const sport = sportRaw === '' ? null : (sportRaw as HistorySport);

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(50, Math.max(1, Math.floor(limitRaw)))
      : 20;

    const cursorRaw = typeof req.query.cursor === 'string' && req.query.cursor.length > 0
      ? req.query.cursor
      : null;
    let cursor: TrainingHistoryCursor | null = null;
    if (cursorRaw) {
      cursor = decodeTrainingHistoryCursor(cursorRaw);
      if (!cursor) {
        sendError(res, 'BAD_REQUEST', invalidHistoryCursorMessage(language), 400);
        return;
      }
    }

    const cacheKey = cursorRaw
      ? null
      : `training-history:${tenantId}:${userId}:${sport ?? 'all'}:${limit}`;
    if (cacheKey) {
      const cached = getCached(cacheKey);
      if (cached) {
        sendSuccess(res, cached, { cached: true });
        return;
      }
    }

    try {
      const page = getTrainingHistoryPage(userId, tenantId, { limit, cursor, sport });
      if (cacheKey) {
        setCache(cacheKey, page, 60);
      }
      sendSuccess(res, page);
    } catch (err: any) {
      logger.error({ err, userId, tenantId, sport, limit }, 'GET /history failed');
      sendInternalError(res, 'Failed to load training history');
    }
  });

  /**
   * GET /api/v1/training/load-snapshot
   *
   * Point-in-time multi-dimensional load-model snapshot (CTL/ATL/TSB
   * + ACWR + Gabbett zone). Drives the Progress-zone load card in the
   * iOS Training redesign. Shares the hydration path with the coach
   * V2 routes (`hydrateLoadModelByDimension`) so the snapshot can
   * never disagree with coach-analysis. Cache is invalidated through
   * the `training.changed` coherence event.
   */
  router.get('/load-snapshot', async (req, res: Response) => {
    const scope = requireTrainingAnalyticsScope(req as AuthenticatedRequest, res, 'training.analytics.load.snapshot');
    if (!scope) return;
    const { userId, tenantId } = scope;
    const cacheKey = `training-load-snapshot:${tenantId}:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const db = getDb();
      // The active plan's sport drives the primary-dimension pick
      // (strength plans track tonnage, not TSS). Tenant-scoped —
      // `user_id` alone is not unique across tenants. Null-safe: with
      // no active plan the empty sport string falls through to the
      // non-strength external/internal heuristic.
      const planRow = db.prepare(`
        SELECT sport FROM fitness_training_plans
        WHERE user_id = ? AND tenant_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `).get(userId, tenantId) as { sport: string | null } | undefined;

      const { loadModelByDimension, primaryDim } = hydrateLoadModelByDimension({
        db,
        userId,
        tenantId,
        planSport: planRow?.sport ?? '',
      });
      const loadModel = loadModelByDimension[primaryDim];

      const principles = loadCoachKnowledge().principles;
      // Same fallback bands as `recommendDeload` — principles without
      // acwrThresholds still classify against the Gabbett defaults.
      const acwrThresholds = getAcwrThresholds(principles) ?? {
        underTraining: { min: 0, max: 0.8 },
        lowRisk: { min: 0.8, max: 1.3 },
        moderateRisk: { min: 1.3, max: 1.5 },
        highRisk: { min: 1.5, max: 100 },
      };
      const zone = classifyAcwr(loadModel.acwrUncoupled, acwrThresholds);

      const dimensionSummary = (dim: LoadDimension): {
        ctl: number;
        atl: number;
        acwrUncoupled: number;
        status: string;
      } => ({
        ctl: round2(loadModelByDimension[dim].ctl),
        atl: round2(loadModelByDimension[dim].atl),
        acwrUncoupled: round2(loadModelByDimension[dim].acwrUncoupled),
        status: loadModelByDimension[dim].loadModelStatus,
      });

      const snapshot = {
        asOf: new Date().toISOString(),
        status: loadModel.loadModelStatus,
        primaryDimension: primaryDim,
        acwr: round2(loadModel.acwrUncoupled),
        acwrCoupled: round2(loadModel.acwrCoupled),
        zone,
        ctl: round2(loadModel.ctl),
        atl: round2(loadModel.atl),
        tsb: round2(loadModel.tsb),
        completionDays: loadModel.completionCount,
        perDimension: {
          external: dimensionSummary('external'),
          internal: dimensionSummary('internal'),
          strength: dimensionSummary('strength'),
          impact: dimensionSummary('impact'),
        },
      };

      setCache(cacheKey, snapshot, 300);
      sendSuccess(res, snapshot);
    } catch (err: any) {
      logger.error({ err, userId, tenantId }, 'GET /load-snapshot failed');
      sendInternalError(res, 'Failed to load training load snapshot');
    }
  });
}
