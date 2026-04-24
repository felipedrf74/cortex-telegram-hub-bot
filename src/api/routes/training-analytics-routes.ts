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
  publishAdherenceSignalsForUser,
  publishPlanDriftSignalForUser,
} from '../../services/adherence-signals';

export type TrainingLanguageResolver = (
  req: Pick<AuthenticatedRequest, 'header'>,
  userId: number,
) => Lang;

function invalidCardioSportMessage(language: Lang): string {
  if (language === 'pt-BR') return 'o parâmetro sport deve ser "running" ou "cycling"';
  if (language.startsWith('pt')) return 'o parâmetro sport tem de ser "running" ou "cycling"';
  return 'sport query param must be "running" or "cycling"';
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
    const { userId } = req as AuthenticatedRequest;
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

    const cacheKey = `cardio-progression:${userId}:${sport}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const report = getCardioProgression(userId, sport, weeks);
      setCache(cacheKey, report, 120);
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, sport, weeks }, 'GET /progression/cardio failed');
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
    const { userId } = req as AuthenticatedRequest;
    const weeksRaw = Number(req.query.weeks);
    const weeks = Number.isFinite(weeksRaw)
      ? Math.min(52, Math.max(1, Math.floor(weeksRaw)))
      : 8;

    const cacheKey = `strength-progression:${userId}:${weeks}`;
    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const report = getStrengthProgression(userId, weeks);
      setCache(cacheKey, report, 120);
      sendSuccess(res, report);
    } catch (err: any) {
      logger.error({ err, userId, weeks }, 'GET /progression/strength failed');
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
    const { userId } = req as AuthenticatedRequest;
    const cacheKey = `training-activity-weekly:${userId}`;

    const cached = getCached(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const summary = await getUnifiedWeeklyActivitySummary(userId);

      try {
        publishAdherenceSignalsForUser(userId);
      } catch (err) {
        logger.warn({ err, userId }, 'adherence signal publish failed — summary still returned');
      }

      try {
        publishPlanDriftSignalForUser(userId);
      } catch (err) {
        logger.warn({ err, userId }, 'plan drift signal publish failed — summary still returned');
      }

      setCache(cacheKey, summary, 60);
      sendSuccess(res, summary);
    } catch (err: any) {
      logger.error({ err, userId }, 'GET /activity/weekly failed');
      sendInternalError(res, 'Failed to load weekly activity');
    }
  });
}
