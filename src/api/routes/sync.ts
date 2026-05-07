// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendSuccess, sendInternalError } from '../response-helpers';
import { listDeltaChanges } from '../../services/delta-sync';
import { capSyncPageSize, consumeResourceBudget } from '../../services/resource-budgets';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { logger } from '../../utils/logger';

export function syncRoutes(): Router {
  const router = Router();

  router.get('/changes', (req, res: Response) => {
    const { userId, tenantId = userId, deviceId } = req as AuthenticatedRequest;
    if (!ensureScope(res, userId, tenantId, 'sync_route_changes')) return;
    const limit = capSyncPageSize(req.query.limit);
    const budget = consumeResourceBudget({
      tenantId,
      userId,
      budgetKey: 'sync_changes',
      limit: 120,
      windowSeconds: 60,
    });
    if (!budget.allowed) {
      sendError(res, 'RATE_LIMITED', 'Too many sync requests. Try again shortly.', 429, {
        resetAt: budget.resetAt,
        budgetKey: budget.budgetKey,
      });
      return;
    }

    try {
      const response = listDeltaChanges({
        tenantId,
        userId,
        since: typeof req.query.since === 'string' ? req.query.since : null,
        deviceId: typeof req.query.deviceId === 'string' ? req.query.deviceId : deviceId,
        limit,
        skill: typeof req.query.skill === 'string' ? req.query.skill : null,
      });
      sendSuccess(res, response);
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'Delta sync changes failed');
      sendInternalError(res, 'Unable to sync changes right now.');
    }
  });

  return router;
}

function ensureScope(
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
): userId is number {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return true;
  recordTenantScopeAnomaly({
    layer: 'delivery',
    operation,
    reason: 'invalid_user_scope',
    userId: typeof userId === 'number' ? userId : null,
  });
  sendError(res, 'UNAUTHORIZED', 'Invalid authenticated user scope', 401);
  return false;
}
