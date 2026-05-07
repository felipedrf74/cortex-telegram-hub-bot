// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendSuccess, sendInternalError } from '../response-helpers';
import { getAppSummary, projectSummaryReadModelsForUser, type SummaryType } from '../../services/app-summary-read-models';
import { consumeResourceBudget } from '../../services/resource-budgets';
import { isValidTenantUserId, recordTenantScopeAnomaly } from '../../services/tenant-scope-observability';
import { logger } from '../../utils/logger';

const SUMMARY_TYPES: SummaryType[] = ['home', 'week', 'training', 'content', 'notifications'];

export function summaryRoutes(): Router {
  const router = Router();

  router.get('/', (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureScope(res, userId, tenantId, 'summary_route_list')) return;
    if (!consumeSummaryBudget(res, tenantId, userId, 'summary_list', 240, 60)) return;
    try {
      const summaries = projectSummaryReadModelsForUser({ userId, tenantId });
      sendSuccess(res, {
        summaries: summaries.map(formatSummary),
        count: summaries.length,
      });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'App summaries list failed');
      sendInternalError(res, 'Unable to load summaries right now.');
    }
  });

  router.get('/:type', (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureScope(res, userId, tenantId, 'summary_route_get', { type: req.params.type })) return;
    if (!consumeSummaryBudget(res, tenantId, userId, 'summary_get', 300, 60)) return;
    const summaryType = normalizeSummaryType(req.params.type);
    if (!summaryType) {
      sendError(res, 'BAD_REQUEST', `summary type must be one of: ${SUMMARY_TYPES.join(', ')}`);
      return;
    }

    try {
      const summary = getAppSummary({ userId, tenantId, summaryType });
      sendSuccess(res, formatSummary(summary));
    } catch (err) {
      logger.error({ err, userId, tenantId, summaryType }, 'App summary get failed');
      sendInternalError(res, 'Unable to load summary right now.');
    }
  });

  router.post('/project', (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    if (!ensureScope(res, userId, tenantId, 'summary_route_project')) return;
    if (!consumeSummaryBudget(res, tenantId, userId, 'summary_project', 30, 60)) return;
    const requested = Array.isArray(req.body?.summaryTypes)
      ? req.body.summaryTypes.map(normalizeSummaryType).filter(Boolean) as SummaryType[]
      : undefined;
    try {
      const summaries = projectSummaryReadModelsForUser({ userId, tenantId, summaryTypes: requested });
      sendSuccess(res, { projected: summaries.map(formatSummary), count: summaries.length });
    } catch (err) {
      logger.error({ err, userId, tenantId }, 'App summary projection failed');
      sendInternalError(res, 'Unable to project summaries right now.');
    }
  });

  return router;
}

function normalizeSummaryType(value: unknown): SummaryType | null {
  return typeof value === 'string' && (SUMMARY_TYPES as string[]).includes(value) ? value as SummaryType : null;
}

function consumeSummaryBudget(
  res: Response,
  tenantId: number,
  userId: number,
  budgetKey: string,
  limit: number,
  windowSeconds: number,
): boolean {
  const budget = consumeResourceBudget({
    tenantId,
    userId,
    budgetKey,
    limit,
    windowSeconds,
  });
  if (budget.allowed) return true;

  setRetryAfter(res, budget.resetAt);
  sendError(res, 'RATE_LIMITED', 'Too many summary requests. Try again shortly.', 429, {
    resetAt: budget.resetAt,
    budgetKey: budget.budgetKey,
  });
  return false;
}

function setRetryAfter(res: Response, resetAt: string): void {
  const seconds = Math.max(1, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000));
  res.setHeader('Retry-After', String(Number.isFinite(seconds) ? seconds : 60));
}

function ensureScope(
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  if (isValidTenantUserId(userId) && isValidTenantUserId(tenantId)) return true;
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

function formatSummary(summary: ReturnType<typeof getAppSummary>): Record<string, unknown> {
  return {
    summaryId: summary.summaryId,
    summaryType: summary.summaryType,
    payload: summary.payload,
    version: summary.version,
    sourceEventSequence: summary.sourceEventSequence,
    isStale: summary.isStale,
    updatedAt: summary.updatedAt,
  };
}
