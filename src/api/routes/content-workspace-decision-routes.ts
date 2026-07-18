// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response, Router } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { asyncHandler, sendError, sendInternalError, sendSuccess } from '../response-helpers';
import {
  CONTENT_REVIEW_DECISION_PROJECTION_VERSION,
  ensureContentWorkspaceReviewDecision,
} from '../../services/content-workspace-decision-projection';
import { logger } from '../../utils/logger';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

/** Explicit retry/reconciliation surface for the Content → Decision Center projection. */
export function registerContentWorkspaceDecisionRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  router.post('/workspace/items/:itemId/review-decision', asyncHandler(async (req, res: Response) => {
    const auth = req as unknown as AuthenticatedRequest;
    if (!ensureValidContentRouteScope(
      res,
      auth.userId,
      'content_workspace_review_decision_project',
      { itemId: req.params.itemId },
    )) return;
    if (!Number.isSafeInteger(auth.tenantId) || Number(auth.tenantId) <= 0) {
      sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
      return;
    }
    if (Number(auth.tenantId) !== auth.userId) {
      sendError(res, 'CONTENT_TENANT_SCOPE_MISMATCH', 'The active tenant does not match the authenticated session.', 403);
      return;
    }
    const itemId = Number(req.params.itemId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      sendError(res, 'CONTENT_ITEM_ID_INVALID', 'Content item id must be a positive integer.', 400);
      return;
    }

    try {
      const decisionProjection = await ensureContentWorkspaceReviewDecision({
        tenantId: Number(auth.tenantId),
        userId: auth.userId,
      }, itemId);
      sendSuccess(res, {
        schemaVersion: CONTENT_REVIEW_DECISION_PROJECTION_VERSION,
        decisionProjection,
      });
    } catch (error) {
      logger.error({
        operation: 'content_workspace_review_decision_project',
        itemId,
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'Content review decision projection failed');
      sendInternalError(res, 'The content item is still safe in review, but Decision Center could not be updated. Retry from the content item.');
    }
  }));
}
