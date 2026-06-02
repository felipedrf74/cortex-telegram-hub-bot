// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Usage routes — token-zero read of the user's API usage and quota state.
 *
 * Both endpoints are pure SQL reads against the usage_metering and
 * usage_quotas tables. NO AI involvement. The data they expose lets the
 * iOS client render a "messages used today" indicator and warn the user
 * before they hit a limit.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import {
  getDailyUsage,
  getUsageRange,
  checkQuota,
} from '../../services/usage-metering';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

type UsageLevel = 'ok' | 'near_limit' | 'exhausted';

function quotaFraction(used: number, limit: number | null | undefined): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(Number(limit)) || Number(limit) <= 0) return null;
  return Math.max(0, Math.min(1, used / Number(limit)));
}

function usageLevelFor(fraction: number, allowed: boolean): UsageLevel {
  if (!allowed || fraction >= 1) return 'exhausted';
  if (fraction >= 0.8) return 'near_limit';
  return 'ok';
}

function buildSafeUsageQuotaPayload(status: ReturnType<typeof checkQuota>) {
  const usage = status.usage;
  const quota = status.quota;
  const fractions = [
    quotaFraction(usage.messageCount, quota?.dailyMessageLimit),
    quotaFraction(usage.totalTokens, quota?.dailyTokenLimit),
    // Cost remains an internal input to the qualitative meter only. Never
    // expose raw USD spend/caps on customer-facing usage endpoints.
    quotaFraction(usage.costUsd, quota?.dailyCostLimitUsd),
  ].filter((value): value is number => value != null);
  const usageFraction = fractions.length > 0 ? Math.round(Math.max(...fractions) * 10_000) / 10_000 : 0;
  return {
    usageLevel: usageLevelFor(usageFraction, status.allowed),
    usageFraction,
    usagePercent: Math.round(usageFraction * 100),
    isOverLimit: !status.allowed || status.exceeded.length > 0,
  };
}

export function usageRoutes(): Router {
  const router = Router();

  router.use((req, res, next) => {
    const { userId } = req as AuthenticatedRequest;
    if (!ensureValidTenantRouteScope(res as Response, userId, 'usage_route', {
      method: req.method,
      path: req.path,
    })) return;
    next();
  });

  /**
   * GET /api/v1/usage
   * Returns today's usage and quota state for the authenticated user.
   * The response shape is intentionally flat so SwiftUI can bind directly.
   */
  router.get('/', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;

    try {
      const status = checkQuota(userId);
      const usage = status.usage;
      const quota = status.quota;
      const safeQuota = buildSafeUsageQuotaPayload(status);

      sendSuccess(res, {
        date: usage.date,
        messagesUsed: usage.messageCount,
        messagesLimit: quota?.dailyMessageLimit ?? null,
        tokensUsed: usage.totalTokens,
        tokensLimit: quota?.dailyTokenLimit ?? null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        apiCalls: usage.apiCalls,
        ...safeQuota,
        allowed: status.allowed,
        exceeded: status.exceeded,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS usage fetch failed');
      sendInternalError(res, 'Failed to fetch usage');
    }
  }));

  /**
   * GET /api/v1/usage/range?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
   * Returns daily usage records in a date range (inclusive).
   * Useful for the iOS settings screen to render a 30-day usage chart.
   */
  router.get('/range', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    if (!startDate || !endDate) {
      sendError(res, 'BAD_REQUEST', 'startDate and endDate are required (YYYY-MM-DD)');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      sendError(res, 'BAD_REQUEST', 'startDate and endDate must be in YYYY-MM-DD format');
      return;
    }

    try {
      const records = getUsageRange(userId, startDate, endDate);
      sendSuccess(res, {
        startDate,
        endDate,
        records: records.map((r) => ({
          date: r.date,
          messagesUsed: r.messageCount,
          tokensUsed: r.totalTokens,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          apiCalls: r.apiCalls,
        })),
        totalDays: records.length,
      });
    } catch (err: any) {
      logger.error({ err, userId, startDate, endDate }, 'iOS usage range fetch failed');
      sendInternalError(res, 'Failed to fetch usage range');
    }
  }));

  /**
   * GET /api/v1/usage/today
   * Lighter version of `/` that skips quota lookups — useful for quick polls.
   */
  router.get('/today', asyncHandler(async (req, res: Response) => {
    const { userId } = req as AuthenticatedRequest;
    try {
      const usage = getDailyUsage(userId);
      sendSuccess(res, {
        date: usage.date,
        messagesUsed: usage.messageCount,
        tokensUsed: usage.totalTokens,
        apiCalls: usage.apiCalls,
      });
    } catch (err: any) {
      logger.error({ err, userId }, 'iOS usage/today fetch failed');
      sendInternalError(res, 'Failed to fetch today usage');
    }
  }));

  return router;
}
