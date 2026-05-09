// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { invalidateContentDerivedCaches } from '../../services/cache-coherence-registry';
import {
  canTransitionContent,
  decideContentApproval,
  evaluateContentApprovalRequirements,
  getContentWorkflowObject,
  listContentApprovalRecords,
  listContentWorkflowEvents,
  repurposeContentWorkflowObject,
  requestContentScheduleThroughSecretary,
  reviewContentSources,
  transitionContentWorkflow,
  type ContentWorkflowAction,
} from '../../services/content-editorial-workflow';
import type { SecretaryIntentFlexibility, SecretaryIntentPriority, SecretaryTimeWindow } from '../../services/secretary-scheduling-arbitrator';
import { logger } from '../../utils/logger';

type EnsureValidContentRouteScope = (
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export function registerContentEditorialRoutes(
  router: Router,
  ensureValidContentRouteScope: EnsureValidContentRouteScope,
): void {
  /** GET /api/v1/content/workflow/:id — inspect an authorized editorial object */
  router.get('/workflow/:id', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_workflow_get', { objectId: id })) return;

    try {
      const object = getContentWorkflowObject(userId, id, tenantId);
      if (!object) {
        sendError(res, 'NOT_FOUND', 'Content object not found', 404);
        return;
      }
      sendSuccess(res, {
        object,
        events: listContentWorkflowEvents({ userId, tenantId, objectType: object.objectType, objectId: object.id }),
        approvals: listContentApprovalRecords({ userId, tenantId, objectType: object.objectType, objectId: object.id }),
      });
    } catch (err) {
      logger.error({ err, userId, objectId: id }, 'content workflow inspect failed');
      sendInternalError(res, 'Failed to inspect content workflow object');
    }
  });

  /** POST /api/v1/content/workflow/:id/actions — run a lifecycle/editorial action */
  router.post('/workflow/:id/actions', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_workflow_action', { objectId: id })) return;

    const action = typeof req.body?.action === 'string' ? req.body.action.trim() : '';
    if (!action) {
      sendError(res, 'BAD_REQUEST', 'action is required', 400);
      return;
    }

    try {
      if (action === 'schedule_content') {
        const object = getContentWorkflowObject(userId, id, tenantId);
        if (!object) {
          sendError(res, 'NOT_FOUND', 'Content object not found', 404);
          return;
        }
        if (object.editorialState !== 'scheduled' && !canTransitionContent(object.editorialState, 'scheduled')) {
          sendError(res, 'CONFLICT', 'Invalid content workflow transition', 409, {
            fromState: object.editorialState,
            toState: 'scheduled',
            reasonCodes: ['invalid_lifecycle_transition'],
          });
          return;
        }

        const approval = evaluateContentApprovalRequirements({
          action: 'schedule_content',
          targetState: 'scheduled',
          currentState: object.editorialState,
          visibilityScope: object.visibilityScope,
        });
        if (approval.approvalRequired && req.body?.approvalConfirmed !== true) {
          const result = transitionContentWorkflow({
            userId,
            tenantId,
            objectId: id,
            action: 'schedule_content',
            reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
            metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
          });
          sendSuccess(res, {
            workflow: result,
            object: result.object,
            approval: result.approval,
          }, { status: 202 });
          return;
        }

        const decision = requestContentScheduleThroughSecretary({
          userId,
          tenantId,
          objectId: id,
          title: object.title,
          durationMinutes: normalizePositiveNumber(req.body?.durationMinutes),
          minimumDurationMinutes: normalizePositiveNumber(req.body?.minimumDurationMinutes),
          preferredWindows: normalizeScheduleWindows(req.body?.preferredWindows),
          unavailableWindows: normalizeScheduleWindows(req.body?.unavailableWindows ?? (isRecord(req.body?.hardConstraints) ? req.body.hardConstraints.unavailableWindows : undefined)),
          protectedWindows: normalizeScheduleWindows(req.body?.protectedWindows ?? (isRecord(req.body?.hardConstraints) ? req.body.hardConstraints.protectedWindows : undefined)),
          deadline: typeof req.body?.deadline === 'string' ? req.body.deadline : null,
          priority: normalizeSchedulePriority(req.body?.priority),
          flexibility: normalizeScheduleFlexibility(req.body?.flexibility),
          reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
          approvalConfirmed: req.body?.approvalConfirmed === true,
        });
        const updated = getContentWorkflowObject(userId, id, tenantId);
        invalidateContentDerivedCaches(userId);
        sendSuccess(res, {
          workflow: {
            ok: ['scheduled', 'reflowed', 'compressed'].includes(decision.status),
            status: decision.status,
            object: updated,
            reasonCodes: decision.reasonCodes,
            secretaryIntentId: updated?.secretaryIntentId ?? `content:${id}:schedule`,
            secretaryAgendaItemId: updated?.secretaryAgendaItemId ?? decision.agendaItem.agendaItemId,
          },
          object: updated,
          scheduling: decision,
          agendaItem: decision.agendaItem,
          feedback: decision.feedback,
        }, { status: ['scheduled', 'reflowed', 'compressed'].includes(decision.status) ? 200 : 202 });
        return;
      }

      const result = transitionContentWorkflow({
        userId,
        tenantId,
        objectId: id,
        action: action as ContentWorkflowAction,
        targetState: typeof req.body?.targetState === 'string' ? req.body.targetState : undefined,
        approvalConfirmed: req.body?.approvalConfirmed === true,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
      });
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content object not found', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      if (result.status === 'invalid_transition') {
        sendError(res, 'CONFLICT', 'Invalid content workflow transition', 409, {
          fromState: result.fromState,
          toState: result.toState,
          reasonCodes: result.reasonCodes,
        });
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, {
        workflow: result,
        object: result.object,
        approval: result.approval,
      }, { status: result.status === 'approval_required' ? 202 : 200 });
    } catch (err) {
      logger.error({ err, userId, objectId: id, action }, 'content workflow action failed');
      sendInternalError(res, 'Failed to mutate content workflow object');
    }
  });

  /** POST /api/v1/content/workflow/:id/source-review — review sources/claims before approval or publish */
  router.post('/workflow/:id/source-review', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_workflow_source_review', { objectId: id })) return;

    try {
      const result = reviewContentSources({
        userId,
        tenantId,
        objectId: id,
        objectType: typeof req.body?.objectType === 'string' ? req.body.objectType : undefined,
        decision: normalizeSourceReviewDecision(req.body?.decision),
        references: Array.isArray(req.body?.references) ? req.body.references : undefined,
        claims: Array.isArray(req.body?.claims) ? req.body.claims : undefined,
        sourceSummaries: Array.isArray(req.body?.sourceSummaries) ? req.body.sourceSummaries.filter((value: unknown): value is string => typeof value === 'string') : undefined,
        notes: typeof req.body?.notes === 'string' ? req.body.notes : null,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
      });
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content object not found', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      if (result.status === 'unauthorized_reference') {
        sendError(res, 'FORBIDDEN', 'Source review includes an unauthorized reference', 403, { reasonCodes: result.reasonCodes });
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, {
        sourceReview: result,
        object: result.object,
        provenance: result.provenance,
        approval: result.approval,
      }, { status: result.ok ? 200 : 202 });
    } catch (err) {
      logger.error({ err, userId, objectId: id }, 'content source review failed');
      sendInternalError(res, 'Failed to review content sources');
    }
  });

  /** POST /api/v1/content/workflow/:id/approval — approve/reject a pending workflow gate */
  router.post('/workflow/:id/approval', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_workflow_approval', { objectId: id })) return;

    const decision = req.body?.decision === 'rejected' ? 'rejected' : req.body?.decision === 'approved' ? 'approved' : null;
    if (!decision) {
      sendError(res, 'BAD_REQUEST', 'decision must be approved or rejected', 400);
      return;
    }

    try {
      const result = decideContentApproval({
        userId,
        tenantId,
        objectId: id,
        approvalType: typeof req.body?.approvalType === 'string' ? req.body.approvalType : undefined,
        decision,
        reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
      });
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content object not found', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, {
        approval: result,
        object: result.object,
        approvalRecords: result.approvalRecords,
      });
    } catch (err) {
      logger.error({ err, userId, objectId: id }, 'content approval decision failed');
      sendInternalError(res, 'Failed to update content approval');
    }
  });

  /** POST /api/v1/content/workflow/:id/repurpose — create a derived content object with reuse lineage */
  router.post('/workflow/:id/repurpose', async (req, res: Response) => {
    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    const { id } = req.params;
    if (!ensureValidContentRouteScope(res, userId, 'content_route_workflow_repurpose', { objectId: id })) return;

    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const transformationType = typeof req.body?.transformationType === 'string' ? req.body.transformationType.trim() : '';
    if (!title || !transformationType) {
      sendError(res, 'BAD_REQUEST', 'title and transformationType are required', 400);
      return;
    }

    try {
      const result = repurposeContentWorkflowObject({
        userId,
        tenantId,
        sourceObjectId: id,
        title,
        summary: typeof req.body?.summary === 'string' ? req.body.summary : null,
        targetObjectType: typeof req.body?.targetObjectType === 'string' ? req.body.targetObjectType : undefined,
        transformationType,
        fromPlatformId: typeof req.body?.fromPlatformId === 'string' ? req.body.fromPlatformId : null,
        toPlatformId: typeof req.body?.toPlatformId === 'string' ? req.body.toPlatformId : null,
        referencesPreserved: Array.isArray(req.body?.referencesPreserved) ? req.body.referencesPreserved : [],
        referencesChanged: Array.isArray(req.body?.referencesChanged) ? req.body.referencesChanged : [],
        noveltyScore: typeof req.body?.noveltyScore === 'number' ? req.body.noveltyScore : undefined,
        reasonCodes: Array.isArray(req.body?.reasonCodes) ? req.body.reasonCodes.filter((value: unknown): value is string => typeof value === 'string') : undefined,
        approvalConfirmed: req.body?.approvalConfirmed === true,
        metadata: isRecord(req.body?.metadata) ? req.body.metadata : {},
      });
      if (result.status === 'not_found') {
        sendError(res, 'NOT_FOUND', 'Content object not found', 404, { reasonCodes: result.reasonCodes });
        return;
      }
      if (result.status === 'invalid_transition') {
        sendError(res, 'CONFLICT', 'Content object cannot be repurposed from its current state', 409, { reasonCodes: result.reasonCodes });
        return;
      }
      invalidateContentDerivedCaches(userId);
      sendSuccess(res, {
        repurpose: result,
        sourceObject: result.sourceObject,
        reusedObject: result.reusedObject,
        reuseRecord: result.reuseRecord,
      }, { status: 201 });
    } catch (err) {
      logger.error({ err, userId, objectId: id }, 'content repurpose failed');
      sendInternalError(res, 'Failed to repurpose content object');
    }
  });
}

function normalizeSourceReviewDecision(value: unknown): 'approved' | 'needs_revision' | 'rejected' {
  if (value === 'rejected') return 'rejected';
  if (value === 'needs_revision') return 'needs_revision';
  return 'approved';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
  return Math.round(numeric);
}

function normalizeSchedulePriority(value: unknown): SecretaryIntentPriority | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'urgent') return value;
  return undefined;
}

function normalizeScheduleFlexibility(value: unknown): SecretaryIntentFlexibility | undefined {
  if (value === 'fixed' || value === 'flexible' || value === 'compressible' || value === 'splittable') return value;
  return undefined;
}

function normalizeScheduleWindows(value: unknown): SecretaryTimeWindow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const windows = value.flatMap((entry): SecretaryTimeWindow[] => {
    if (!isRecord(entry)) return [];
    if (typeof entry.start !== 'string' || typeof entry.end !== 'string') return [];
    const startMs = Date.parse(entry.start);
    const endMs = Date.parse(entry.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    return [{
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      ...(entry.hard === true ? { hard: true } : {}),
    }];
  });
  return windows.length > 0 ? windows : undefined;
}
