// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Usage routes — token-zero read of the user's API usage and quota state.
 *
 * Both endpoints are token-zero SQL reads. `api_usage` is the canonical
 * blocking source for daily/monthly cost windows; `usage_metering` remains
 * calendar-aligned analytics for legacy message/token telemetry. The data
 * lets clients render current progress and reset-aware quota guidance.
 */

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { logger } from '../../utils/logger';
import {
  getDailyUsage,
  getUsageRange,
} from '../../services/usage-metering';
import { buildQuotaUsagePayload, getDailyQuotaStatus } from '../../services/cost-guardrail';
import { sendSuccess, sendError, sendInternalError, asyncHandler } from '../response-helpers';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

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
      const usage = getDailyUsage(userId);
      const quota = getDailyQuotaStatus(userId);
      const safeQuota = buildQuotaUsagePayload(quota);

      sendSuccess(res, {
        date: usage.date,
        messagesUsed: usage.messageCount,
        messagesLimit: null,
        tokensUsed: usage.totalTokens,
        tokensLimit: null,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        apiCalls: usage.apiCalls,
        ...safeQuota,
        allowed: !quota.over,
        exceeded: quota.blockReason
          ? ['plan']
          : [quota.dailyOver ? 'daily' : null, quota.monthlyOver ? 'monthly' : null].filter(Boolean),
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
