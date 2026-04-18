// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wearable routes — token-zero access to the unified wearable adapter layer.
 *
 * The wearable service abstracts Garmin, Whoop, Fitbit, Apple Health, Strava
 * behind a single interface and routes each request to the best available
 * provider for the user. The readiness scorer is pure math (no AI).
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import { getDailySummary, getReadiness, getSleep, getUserProviders } from '../../services/wearable';
import { getCached, setCache } from '../../services/cache-store';
import { sendSuccess, sendError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

// Wearable data updates a few times per day on most platforms; cache aggressively.
const SUMMARY_TTL = 30 * 60;    // 30 min
const READINESS_TTL = 30 * 60;  // 30 min
const SLEEP_TTL = 60 * 60;      // 1 hour (sleep data is usually finalized by mid-morning)

export function wearableRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'wearable_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/wearable/summary?date=YYYY-MM-DD
   * Returns the unified daily summary (steps, calories, sleep score, etc.)
   * from the best-available provider for this user. Defaults to today.
   */
  router.get('/summary', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const date = (req.query.date as string | undefined) || todayISODate();

    const cacheKey = `wearable:summary:${userId}:${date}`;
    const cached = getCached<any>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const summary = await getDailySummary(userId, date);
      if (!summary) {
        sendSuccess(res, { date, summary: null, message: 'No wearable data available for this date.' });
        return;
      }
      const payload = { date, summary };
      setCache(cacheKey, payload, SUMMARY_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId, date }, 'iOS wearable/summary failed');
      sendError(res, 'WEARABLE_FETCH_FAILED', err?.message || 'Failed to fetch wearable summary', 500);
    }
  }));

  /**
   * GET /api/v1/wearable/readiness?date=YYYY-MM-DD
   * Returns the recovery/readiness score from the best-available provider.
   * The scoring algorithm is pure math, NO AI is invoked.
   */
  router.get('/readiness', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const date = (req.query.date as string | undefined) || todayISODate();

    const cacheKey = `wearable:readiness:${userId}:${date}`;
    const cached = getCached<any>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const readiness = await getReadiness(userId, date);
      if (!readiness) {
        sendSuccess(res, { date, readiness: null, message: 'No readiness data available for this date.' });
        return;
      }
      const payload = { date, readiness };
      setCache(cacheKey, payload, READINESS_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId, date }, 'iOS wearable/readiness failed');
      sendError(res, 'WEARABLE_FETCH_FAILED', err?.message || 'Failed to fetch readiness', 500);
    }
  }));

  /**
   * GET /api/v1/wearable/sleep?date=YYYY-MM-DD
   * Returns sleep data from the best-available provider for the given date.
   */
  router.get('/sleep', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const date = (req.query.date as string | undefined) || todayISODate();

    const cacheKey = `wearable:sleep:${userId}:${date}`;
    const cached = getCached<any>(cacheKey);
    if (cached) {
      sendSuccess(res, cached, { cached: true });
      return;
    }

    try {
      const sleep = await getSleep(userId, date);
      if (!sleep) {
        sendSuccess(res, { date, sleep: null, message: 'No sleep data available for this date.' });
        return;
      }
      const payload = { date, sleep };
      setCache(cacheKey, payload, SLEEP_TTL);
      sendSuccess(res, payload);
    } catch (err: any) {
      logger.error({ err, userId, date }, 'iOS wearable/sleep failed');
      sendError(res, 'WEARABLE_FETCH_FAILED', err?.message || 'Failed to fetch sleep data', 500);
    }
  }));

  /**
   * GET /api/v1/wearable/providers
   * Returns the list of wearable providers connected for this user.
   * Useful for the iOS settings screen to render connection status.
   */
  router.get('/providers', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const providers = await getUserProviders(userId);
      sendSuccess(res, { providers });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS wearable/providers failed');
      sendError(res, 'WEARABLE_FETCH_FAILED', err?.message || 'Failed to fetch wearable providers', 500);
    }
  }));

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function todayISODate(): string {
  // Use UTC date — wearable APIs typically index by UTC calendar day.
  return new Date().toISOString().slice(0, 10);
}
