// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendSuccess } from '../response-helpers';
import { getDb } from '../../services/database';
import { getContentWorkspaceItem, type ContentWorkspaceScope } from '../../services/content-workspace';
import {
  readContentCompatibilityProjection,
} from './content-home-route-utils';
import { recordContentWorkspaceProductSignal } from '../../services/content-workspace-observability';
import { logger } from '../../utils/logger';
import { safeContentLogErrorFields } from '../../services/content-log-safety';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentPipelineRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /**
   * GET /api/v1/content/pipeline
   *
   * Read-only compatibility projection over the canonical workspace. The
   * legacy filmed/editing buckets stay present for old clients but are marked
   * as not tracked; no parallel `content_ideas` store is queried or created.
   */
  router.get('/pipeline', async (req, res: Response) => {
    const scope = resolveScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_pipeline_compatibility_read',
    );
    if (!scope) return;
    recordContentWorkspaceProductSignal('legacy_pipeline_compatibility_read');
    try {
      const db = getDb();
      const projection = readContentCompatibilityProjection(db, scope.userId, scope.tenantId);

      sendSuccess(res, {
        schemaVersion: projection.schemaVersion,
        stages: projection.stages,
        stats: {
          totalIdeas: projection.stages.ideas.length + projection.stages.scripted.length,
          publishedThisMonth: null,
          publishedThisMonthStatus: projection.publicationTracking,
        },
        workspace: { source: 'content_workspace', canonical: true },
        compatibility: {
          projection: 'legacy_pipeline_read_only',
          coverage: projection.coverage,
          stages: {
            ideas: { tracking: 'derived', source: 'artifact_phase' },
            scripted: { tracking: 'derived', source: 'artifact_phase' },
            filmed: { tracking: 'not_tracked', reasonCode: 'CONTENT_FILMING_STATE_NOT_MODELED' },
            editing: { tracking: 'not_tracked', reasonCode: 'CONTENT_EDITING_STATE_NOT_MODELED' },
            published: {
              tracking: 'not_tracked',
              reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
            },
          },
          implicitAdvance: {
            supported: false,
            replacement: '/api/v1/content/workspace/items/:itemId/state',
          },
        },
      });
    } catch (err) {
      logger.error({ ...safeContentLogErrorFields(err), ...scope, reasonCode: 'CONTENT_PIPELINE_STORE_UNAVAILABLE' }, 'Content pipeline compatibility read failed');
      sendPipelineUnavailable(res);
    }
  });

  /**
   * GET /api/v1/content/ideas and /ideas/library — read-only projection over
   * canonical workspace items. The explicit library alias lets save callers
   * verify persistence without falling back to the retired saved_ideas store.
   */
  router.get(['/ideas', '/ideas/library'], async (req, res: Response) => {
    const scope = resolveScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_ideas_compatibility_read',
    );
    if (!scope) return;
    recordContentWorkspaceProductSignal('legacy_ideas_compatibility_read');
    try {
      const projection = readContentCompatibilityProjection(getDb(), scope.userId, scope.tenantId);
      sendSuccess(res, {
        schemaVersion: projection.schemaVersion,
        ideas: projection.items,
        count: projection.items.length,
        workspace: { source: 'content_workspace', canonical: true },
        compatibility: {
          projection: 'legacy_ideas_read_only',
          coverage: projection.coverage,
        },
      });
    } catch (err) {
      logger.error({ ...safeContentLogErrorFields(err), ...scope, reasonCode: 'CONTENT_IDEAS_STORE_UNAVAILABLE' }, 'Content ideas compatibility read failed');
      sendError(
        res,
        'CONTENT_IDEAS_UNAVAILABLE',
        'Content ideas are temporarily unavailable. Your saved ideas have not been reported as empty.',
        503,
        {
          availability: 'unavailable',
          retryable: true,
          reasonCode: 'CONTENT_IDEAS_STORE_UNAVAILABLE',
        },
      );
    }
  });

  /**
   * Legacy implicit advancement is deliberately disabled. Professional
   * workflow changes require an explicit target state, workflow version, and
   * idempotency key through the canonical workspace route.
   */
  router.post('/pipeline/:id/advance', async (req, res: Response) => {
    const scope = resolveScope(
      req as unknown as AuthenticatedRequest,
      res,
      ensureValidContentRouteScope,
      'content_pipeline_compatibility_advance',
      { itemId: req.params.id },
    );
    if (!scope) return;
    recordContentWorkspaceProductSignal('legacy_pipeline_compatibility_mutation');
    const itemId = positiveInteger(req.params.id);
    if (itemId === null) {
      sendItemNotFound(res);
      return;
    }
    try {
      const item = getContentWorkspaceItem(scope, itemId);
      if (!item) {
        // The scoped lookup deliberately makes foreign and nonexistent IDs
        // indistinguishable, preventing cross-tenant existence disclosure.
        sendItemNotFound(res);
        return;
      }
      sendError(
        res,
        'CONTENT_PIPELINE_ADVANCE_DEPRECATED',
        'Implicit pipeline advancement is no longer supported. Use an explicit workspace action.',
        409,
        {
          itemId: String(item.id),
          currentState: item.productionState,
          artifactPhase: item.artifactPhase,
          workflowVersion: item.workflowVersion,
          nextAction: item.nextAction,
          replacement: {
            method: 'POST',
            path: '/api/v1/content/workspace/items/:itemId/state',
            requiresExpectedWorkflowVersion: true,
            requiresIdempotencyKey: true,
          },
        },
      );
    } catch (err) {
      logger.error({ ...safeContentLogErrorFields(err), ...scope, itemId }, 'Content legacy advance compatibility lookup failed');
      sendPipelineUnavailable(res);
    }
  });
}

function resolveScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
  details?: Record<string, unknown>,
): ContentWorkspaceScope | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation, details)) return null;
  if (!Number.isSafeInteger(req.tenantId) || Number(req.tenantId) <= 0) {
    sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
    return null;
  }
  return { tenantId: Number(req.tenantId), userId: req.userId };
}

function positiveInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function sendItemNotFound(res: Response): void {
  sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
}

function sendPipelineUnavailable(res: Response): void {
  sendError(
    res,
    'CONTENT_PIPELINE_UNAVAILABLE',
    'Content pipeline is temporarily unavailable. Your saved content has not been reported as empty.',
    503,
    {
      availability: 'unavailable',
      retryable: true,
      reasonCode: 'CONTENT_PIPELINE_STORE_UNAVAILABLE',
    },
  );
}
