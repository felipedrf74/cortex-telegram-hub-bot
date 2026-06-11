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
   * `training_completions` merged with skipped sessions. Drives the
   * Progress-zone history list in the iOS Training redesign. First
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
}
