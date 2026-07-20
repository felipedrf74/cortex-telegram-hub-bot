// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, type Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import {
  CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
  CONTENT_EDITORIAL_WORKFLOW_EXIT,
  ContentEditorialCompatibilityError,
  decideContentApproval,
  getContentEditorialCompatibility,
  getContentWorkflowObject,
  listContentApprovalRecords,
  listContentWorkflowEvents,
  repurposeContentWorkflowObject,
  reviewContentSources,
  transitionContentWorkflow,
  type ContentApprovalType,
  type ContentWorkflowObject,
  type ContentWorkflowAction,
  type ContentWorkflowReplacement,
} from '../../services/content-editorial-workflow';
import { ContentWorkspaceWriteDisabledError } from '../../services/content-workspace-capabilities';
import { logger } from '../../utils/logger';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

const ACTIONS = new Set<ContentWorkflowAction>([
  'convert_radar_to_idea',
  'convert_radar_to_script',
  'convert_idea_to_outline',
  'convert_outline_to_script',
  'refine_script',
  'approve_draft',
  'schedule_content',
  'mark_published',
  'archive',
  'reject',
  'repurpose_content',
  'delete_draft',
  'mark_stale',
]);

export function registerContentEditorialRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** Deprecated read adapter. Canonical ids are preserved; legacy ledgers are history only. */
  router.get('/workflow/:id', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_route_workflow_get');
    if (!scope) return;
    const { id } = req.params;
    try {
      const object = getContentWorkflowObject(scope.userId, id, scope.tenantId);
      if (!object) {
        sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404);
        return;
      }
      const historicalApprovals = listContentApprovalRecords({
        userId: scope.userId,
        tenantId: scope.tenantId,
        objectId: object.id,
      });
      sendSuccess(res, {
        schemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
        compatibility: getContentEditorialCompatibility(object.id),
        object: presentContentObject(object),
        events: listContentWorkflowEvents({ userId: scope.userId, tenantId: scope.tenantId, objectId: object.id })
          .map(presentWorkflowEvent),
        approvals: historicalApprovals.map(presentHistoricalApproval),
        historicalApprovals: historicalApprovals.map(presentHistoricalApproval),
      });
    } catch (error) {
      sendEditorialError(res, error, scope, 'content workflow compatibility read failed');
    }
  });

  /** Deprecated mutation adapter. Only canonical review approval/archive/reject can mutate. */
  router.post('/workflow/:id/actions', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_route_workflow_action');
    if (!scope) return;
    const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
    if (!ACTIONS.has(action as ContentWorkflowAction)) {
      sendError(res, 'CONTENT_WORKFLOW_ACTION_INVALID', 'A supported action is required.', 400, {
        compatibilitySchemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
      });
      return;
    }
    try {
      const result = transitionContentWorkflow({
        userId: scope.userId,
        tenantId: scope.tenantId,
        objectId: req.params.id,
        action: action as ContentWorkflowAction,
        actorUserId: scope.userId,
        approvalConfirmed: req.body?.approvalConfirmed === true,
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      if (!result.ok) {
        sendTransitionResult(res, result.status, result.reasonCodes, result.replacement, {
          fromState: result.fromState,
          toState: result.toState,
          object: presentContentObject(result.object),
        });
        return;
      }
      invalidateContentDerivedCaches(scope.userId);
      sendSuccess(res, {
        schemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
        compatibility: getContentEditorialCompatibility(result.object!.id),
        workflow: { ...result, object: presentContentObject(result.object) },
        object: presentContentObject(result.object),
        approval: result.approval,
      });
    } catch (error) {
      sendEditorialError(res, error, scope, 'content workflow compatibility action failed');
    }
  });

  /** Raw legacy references cannot be attached to an unpinned output anymore. */
  router.post('/workflow/:id/source-review', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_route_workflow_source_review');
    if (!scope) return;
    try {
      const result = reviewContentSources({
        userId: scope.userId,
        tenantId: scope.tenantId,
        objectId: req.params.id,
        objectType: typeof req.body?.objectType === 'string' ? req.body.objectType : undefined,
        references: Array.isArray(req.body?.references) ? req.body.references : undefined,
        claims: Array.isArray(req.body?.claims) ? req.body.claims : undefined,
      });
      if (result.status === 'not_found') {
        sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      if (result.status === 'unauthorized_reference') {
        sendError(res, 'CONTENT_SOURCE_SCOPE_FORBIDDEN', 'A source is outside the active private scope.', 403, { reasonCodes: result.reasonCodes });
        return;
      }
      sendReplacement(res, result.replacement!, result.reasonCodes);
    } catch (error) {
      sendEditorialError(res, error, scope, 'content source lineage compatibility action failed');
    }
  });

  /** Decision Center may bridge explicit content_review decisions with CAS/idempotency. */
  router.post('/workflow/:id/approval', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_route_workflow_approval');
    if (!scope) return;
    const decision = req.body?.decision === 'approved' || req.body?.decision === 'rejected'
      ? req.body.decision
      : null;
    if (!decision) {
      sendError(res, 'CONTENT_APPROVAL_DECISION_INVALID', 'decision must be approved or rejected.', 400);
      return;
    }
    if (typeof req.body?.approvalType !== 'string' || !req.body.approvalType.trim()) {
      sendError(res, 'CONTENT_APPROVAL_TYPE_REQUIRED', 'approvalType must be explicit.', 400, {
        supportedApprovalType: 'content_review',
        publicationExecution: 'not_performed',
      });
      return;
    }
    try {
      const result = decideContentApproval({
        userId: scope.userId,
        tenantId: scope.tenantId,
        objectId: req.params.id,
        approvalType: req.body.approvalType as ContentApprovalType,
        decision,
        actorUserId: scope.userId,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
        expectedWorkflowVersion: req.body?.expectedWorkflowVersion,
        idempotencyKey: readIdempotencyKey(req),
      });
      if (!result.ok) {
        sendTransitionResult(res, result.status, result.reasonCodes, result.replacement, {
          object: presentContentObject(result.object),
        });
        return;
      }
      invalidateContentDerivedCaches(scope.userId);
      sendSuccess(res, {
        schemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
        compatibility: getContentEditorialCompatibility(result.object!.id),
        approval: { ...result, object: presentContentObject(result.object), approvalRecords: undefined },
        object: presentContentObject(result.object),
        historicalApprovalRecords: result.approvalRecords.map(presentHistoricalApproval),
      });
    } catch (error) {
      sendEditorialError(res, error, scope, 'content approval compatibility action failed');
    }
  });

  /** Old repurpose payloads cannot pin a source revision or preserve edits safely. */
  router.post('/workflow/:id/repurpose', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res, ensureValidContentRouteScope, 'content_route_workflow_repurpose');
    if (!scope) return;
    try {
      const result = repurposeContentWorkflowObject({
        userId: scope.userId,
        tenantId: scope.tenantId,
        sourceObjectId: req.params.id,
        title: typeof req.body?.title === 'string' ? req.body.title : '',
        transformationType: typeof req.body?.transformationType === 'string' ? req.body.transformationType : 'legacy_unspecified',
      });
      if (result.status === 'not_found') {
        sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      sendReplacement(res, result.replacement!, result.reasonCodes);
    } catch (error) {
      sendEditorialError(res, error, scope, 'content repurpose compatibility action failed');
    }
  });
}

function sendTransitionResult(
  res: Response,
  status: string,
  reasonCodes: string[],
  replacement?: ContentWorkflowReplacement,
  details: Record<string, unknown> = {},
): void {
  if (status === 'not_found') {
    sendError(res, 'CONTENT_ITEM_NOT_FOUND', 'Content item not found.', 404, { reasonCodes });
    return;
  }
  if (status === 'version_conflict') {
    sendError(res, 'CONTENT_WORKFLOW_VERSION_CONFLICT', 'This item changed after it was loaded.', 409, {
      ...details,
      reasonCodes,
      recovery: 'reload_and_retry',
      publicationExecution: 'not_performed',
    });
    return;
  }
  if (status === 'approval_required') {
    sendError(res, 'CONTENT_APPROVAL_REQUIRED', 'Explicit confirmation is required for this destructive Content action.', 409, {
      ...details,
      reasonCodes,
      recovery: 'review_then_retry_with_approvalConfirmed',
      publicationExecution: 'not_performed',
    });
    return;
  }
  if (replacement) {
    sendReplacement(res, replacement, reasonCodes, details);
    return;
  }
  sendError(res, 'CONTENT_STATE_TRANSITION_INVALID', 'This Content state transition is not allowed.', 409, {
    ...details,
    reasonCodes,
    publicationExecution: 'not_performed',
  });
}

function sendReplacement(
  res: Response,
  replacement: ContentWorkflowReplacement,
  reasonCodes: string[],
  details: Record<string, unknown> = {},
): void {
  const status = replacement.code === 'CONTENT_PUBLICATION_CONFIRMATION_REQUIRED'
    || replacement.code === 'CONTENT_WORKFLOW_CANONICAL_CONCURRENCY_REQUIRED'
    ? 409
    : 426;
  sendError(res, replacement.code, replacement.message, status, {
    ...details,
    compatibilitySchemaVersion: CONTENT_EDITORIAL_COMPATIBILITY_SCHEMA_VERSION,
    deprecated: true,
    reasonCodes,
    canonicalRoutes: replacement.canonicalRoutes,
    recovery: replacement.recovery,
    publicationExecution: 'not_performed',
  });
}

function resolveScope(
  req: AuthenticatedRequest,
  res: Response,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
  operation: string,
): { userId: number; tenantId: number } | null {
  if (!ensureValidContentRouteScope(res, req.userId, operation)) return null;
  if (!Number.isInteger(req.tenantId) || Number(req.tenantId) <= 0) {
    sendError(res, 'CONTENT_TENANT_SCOPE_REQUIRED', 'A valid tenant scope is required.', 401);
    return null;
  }
  return { userId: req.userId, tenantId: Number(req.tenantId) };
}

function readIdempotencyKey(req: { body?: any; header(name: string): string | undefined }): string {
  if (typeof req.body?.idempotencyKey === 'string') return req.body.idempotencyKey;
  return req.header('x-idempotency-key') ?? '';
}

function sendEditorialError(
  res: Response,
  error: unknown,
  scope: { userId: number; tenantId: number },
  message: string,
): void {
  if (error instanceof ContentEditorialCompatibilityError || error instanceof ContentWorkspaceWriteDisabledError) {
    sendError(res, error.code, error.message, error.status, error.details);
    return;
  }
  logger.error({ err: error, userId: scope.userId, tenantId: scope.tenantId }, message);
  sendInternalError(res, 'The Content workspace action could not be completed. Existing content was preserved.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function presentContentObject(object: ContentWorkflowObject | null): Omit<
  ContentWorkflowObject,
  'tenantId' | 'ownerUserId' | 'metadata'
> | null {
  if (!object) return null;
  const { tenantId: _tenantId, ownerUserId: _ownerUserId, metadata: _metadata, ...presentation } = object;
  return presentation;
}

function presentWorkflowEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    action: event.action,
    fromState: event.from_state ?? null,
    toState: event.to_state ?? null,
    reviewRequired: event.review_required === 1,
    reasonCodes: parseStringArray(event.reason_codes_json),
    occurredAt: event.created_at ?? null,
  };
}

function presentHistoricalApproval(record: Record<string, unknown>): Record<string, unknown> {
  return {
    historical: true,
    authoritative: false,
    approvalType: record.approval_type,
    historicalState: record.approval_state,
    reasonCodes: parseStringArray(record.required_reason_codes_json),
    requestedAt: record.requested_at ?? null,
    resolvedAt: record.approved_at ?? record.rejected_at ?? null,
  };
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

// Keep the exit contract referenced in the generated declaration surface.
void CONTENT_EDITORIAL_WORKFLOW_EXIT;
