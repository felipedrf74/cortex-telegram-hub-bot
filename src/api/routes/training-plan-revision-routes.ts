// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request, Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  getTrainingPlanRevisionV1Mode,
  isDecisionFlowV1EnforceEnabled,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  isTrainingTypedWorkoutV1Enabled,
  getTrainingM4Allowlist,
} from '../../services/runtime-flags';
import {
  CANONICAL_TRAINING_SESSION_TYPES,
  TRAINING_PLAN_MODE_CAPABILITIES,
  TRAINING_WORKOUT_CAPABILITY_REGISTRY,
} from '../../services/training-workout-capability-registry';
import {
  TRAINING_PLAN_REVISION_API_SCHEMA,
  TrainingPlanRevisionError,
  createTrainingPlanCandidateRevision,
  editTrainingPlanRevisionPreview,
  getActiveTrainingPlanReference,
  getScopedTrainingPlanRevision,
  requirePersonalTrainingRevisionScope,
  supersedeTrainingPlanRevisionForBoundChild,
} from '../../services/training-plan-revisions';
import type { TrainingPlanCandidateRequest } from '../../services/training-plan-revision-candidate-builder';
import { buildTrainingPlanRevisionReviewReadModel } from '../../services/training-plan-revision-read-model';
import { logger } from '../../utils/logger';
import { bindTrainingPlanRevisionDecision } from '../../services/training-plan-revision-decision';
import { supersedeDecisionSourceStateForEntity } from '../../services/decision-center';
import { incrementTrainingGenerationCounter } from '../../services/training-generation-observability';
import {
  getTrainingM4AuthoritativeCapacityContext,
  type TrainingM4AuthoritativeCapacityContext,
} from '../../services/training-m4-capacity-context';

interface RevisionApiMeta {
  schemaVersion: typeof TRAINING_PLAN_REVISION_API_SCHEMA;
  mode: 'active';
}

export interface RevisionCapabilitiesResource extends RevisionApiMeta {
  registryVersion: 'training-workout-capabilities.v1';
  canonicalSessionTypes: typeof CANONICAL_TRAINING_SESSION_TYPES;
  workoutCapabilities: typeof TRAINING_WORKOUT_CAPABILITY_REGISTRY;
  planModes: typeof TRAINING_PLAN_MODE_CAPABILITIES;
  milestone1GenerationSessionTypes: string[];
  typedWorkoutGenerationEnabled: boolean;
  typedGenerationSessionTypes: string[];
  typedGenerationPlanModes: string[];
  m4AllowedPlanCombinations: Array<{
    planMode: 'event_based' | 'continuous' | 'maintenance' | 'return_to_training';
    discipline: 'running' | 'cycling' | 'swimming' | 'strength' | 'triathlon' | 'hybrid' | 'marathon';
  }>;
  m4CapacityContext?: TrainingM4AuthoritativeCapacityContext;
  m4CapacityPolicy: {
    authoritativeContextAvailable: boolean;
    authoritativeClientModification: 'NARROW_ONLY';
    explicitUserEntrySupported: true;
    explicitUserEntryProvisional: true;
    explicitUserCalendarConflictCoverage: 'UNAVAILABLE';
  };
  unknownFallback: {
    presentationFamily: 'unknown';
    presentationLabel: 'Unknown workout type';
    preservesRawIdentifier: true;
    newlyPrescribable: false;
  };
}

export function registerTrainingPlanRevisionRoutes(router: Router): void {
  const capabilities = (req: Request, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireCapabilityRoute(scope, res)) return;
    const data = trainingPlanRevisionCapabilitiesForScope(scope)!;
    sendSuccess(res, data);
  };
  router.get('/plan/revision-capabilities', capabilities);
  router.get('/capabilities', capabilities);

  router.post('/plan/candidates', async (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireActiveRoute(scope, res)) return;
    const idempotencyKey = req.header('idempotency-key') ?? '';
    try {
      const candidateSet = createTrainingPlanCandidateRevision({
        scope,
        idempotencyKey,
        request: req.body as TrainingPlanCandidateRequest,
      });
      candidateSet.candidates = [await bindTrainingPlanRevisionDecision({
        scope,
        revisionId: candidateSet.candidates[0].revisionId,
      })];
      incrementTrainingGenerationCounter('revision_candidate_succeeded_total');
      sendSuccess(res, { ...meta(), candidateSet }, { status: 201 });
    } catch (error) {
      incrementTrainingGenerationCounter('revision_candidate_failed_total');
      sendRevisionError(res, error, 'create candidate');
    }
  });

  router.get('/plan/revisions/:revisionId', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireActiveRoute(scope, res)) return;
    const revision = getScopedTrainingPlanRevision(scope, req.params.revisionId);
    if (!revision) {
      sendError(res, 'TRAINING_REVISION_NOT_FOUND', 'Training plan revision not found.', 404);
      return;
    }
    res.setHeader('ETag', `"${revision.contentHash}"`);
    sendSuccess(res, {
      ...meta(),
      revision,
      ...(isTrainingTypedWorkoutV1Enabled(process.env, scope)
        ? { reviewModel: buildTrainingPlanRevisionReviewReadModel(revision) }
        : {}),
    });
  });

  router.post('/plan/revisions/:revisionId/edit-preview', async (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireActiveRoute(scope, res)) return;
    const idempotencyKey = req.header('idempotency-key') ?? '';
    const body = isRecord(req.body) ? req.body : {};
    try {
      const editPreview = editTrainingPlanRevisionPreview({
        scope,
        revisionId: req.params.revisionId,
        expectedContentHash: stringValue(body.expectedContentHash),
        idempotencyKey,
        edits: isRecord(body.edits) ? body.edits : {},
        rationale: stringValue(body.rationale),
      });
      editPreview.proposedRevision = await bindTrainingPlanRevisionDecision({
        scope,
        revisionId: editPreview.proposedRevision.revisionId,
      });
      supersedeTrainingPlanRevisionForBoundChild({
        scope,
        parentRevisionId: editPreview.currentRevision.revisionId,
        childRevisionId: editPreview.proposedRevision.revisionId,
        expectedParentContentHash: editPreview.currentRevision.contentHash,
      });
      if (editPreview.currentRevision.decisionId) {
        supersedeDecisionSourceStateForEntity({
          userId: scope.userId,
          tenantId: scope.tenantId,
          sourceSkill: 'training',
          relatedEntityType: 'training_plan_revision',
          relatedEntityId: editPreview.currentRevision.revisionId,
        });
      }
      sendSuccess(res, { ...meta(), editPreview }, { status: 201 });
    } catch (error) {
      sendRevisionError(res, error, 'edit preview');
    }
  });

  router.get('/plan/active-revision', (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireActiveRoute(scope, res)) return;
    const familyId = typeof req.query.familyId === 'string' ? req.query.familyId : null;
    const activeReference = getActiveTrainingPlanReference(scope, familyId);
    if (activeReference) res.setHeader('ETag', `"pointer-${activeReference.pointerVersion}"`);
    sendSuccess(res, { ...meta(), activeReference });
  });
}

export function trainingPlanRevisionCapabilitiesForScope(
  scope: { userId: number; tenantId: number },
  env: NodeJS.ProcessEnv = process.env,
): RevisionCapabilitiesResource | null {
  if (getTrainingPlanRevisionV1Mode(env, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(env, scope)
      || !isDecisionFlowV1EnforceEnabled(env, scope)
      || scope.userId !== scope.tenantId) return null;
  const typedWorkoutGenerationEnabled = isTrainingTypedWorkoutV1Enabled(env, scope);
  const m4AllowedPlanCombinations = typedWorkoutGenerationEnabled
    ? getTrainingM4Allowlist(env, scope).map((entry) => {
      const [planMode, discipline] = entry.split(':');
      return {
        planMode: planMode as RevisionCapabilitiesResource['m4AllowedPlanCombinations'][number]['planMode'],
        discipline: discipline as RevisionCapabilitiesResource['m4AllowedPlanCombinations'][number]['discipline'],
      };
    })
    : [];
  const m4CapacityContext = typedWorkoutGenerationEnabled
    ? getTrainingM4AuthoritativeCapacityContext(scope)
    : null;
  return {
    ...meta(),
    registryVersion: 'training-workout-capabilities.v1',
    canonicalSessionTypes: CANONICAL_TRAINING_SESSION_TYPES,
    workoutCapabilities: TRAINING_WORKOUT_CAPABILITY_REGISTRY,
    planModes: TRAINING_PLAN_MODE_CAPABILITIES,
    milestone1GenerationSessionTypes: TRAINING_WORKOUT_CAPABILITY_REGISTRY
      .filter((entry) => entry.milestone1GenerationEnabled)
      .map((entry) => entry.sessionType),
    typedWorkoutGenerationEnabled,
    typedGenerationSessionTypes: typedWorkoutGenerationEnabled
      ? [...CANONICAL_TRAINING_SESSION_TYPES]
      : [],
    typedGenerationPlanModes: typedWorkoutGenerationEnabled
      ? TRAINING_PLAN_MODE_CAPABILITIES.map((entry) => entry.planMode)
      : [],
    m4AllowedPlanCombinations,
    ...(m4CapacityContext ? { m4CapacityContext } : {}),
    m4CapacityPolicy: {
      authoritativeContextAvailable: Boolean(m4CapacityContext),
      authoritativeClientModification: 'NARROW_ONLY',
      explicitUserEntrySupported: true,
      explicitUserEntryProvisional: true,
      explicitUserCalendarConflictCoverage: 'UNAVAILABLE',
    },
    unknownFallback: {
      presentationFamily: 'unknown',
      presentationLabel: 'Unknown workout type',
      preservesRawIdentifier: true,
      newlyPrescribable: false,
    },
  };
}

function meta(): RevisionApiMeta {
  return { schemaVersion: TRAINING_PLAN_REVISION_API_SCHEMA, mode: 'active' };
}

function resolveScope(req: AuthenticatedRequest, res: Response): { userId: number; tenantId: number } | null {
  try {
    return {
      userId: req.userId,
      tenantId: requireTenantIdParam(req.tenantId, 'training.plan.revision'),
    };
  } catch {
    sendError(res, 'TENANT_SCOPE_REQUIRED', 'Training plan revisions require a validated tenant scope.', 400);
    return null;
  }
}

function requireActiveRoute(scope: { userId: number; tenantId: number }, res: Response): boolean {
  if (getTrainingPlanRevisionV1Mode(process.env, scope) === 'active'
      && isTrainingPlanRevisionV1ExplicitlyEnrolled(process.env, scope)
      && isDecisionFlowV1EnforceEnabled(process.env, scope)) {
    try {
      requirePersonalTrainingRevisionScope(scope);
      return true;
    } catch {
      // Personal-only enrollment fails closed as route absence in Milestone 1.
    }
  }
  sendError(res, 'NOT_FOUND', 'Route not found.', 404);
  return false;
}

/**
 * Capability discovery must distinguish an absent rollout from a partially
 * enabled one. Legacy writers are already blocked for active, enrolled
 * scopes, so returning the same hidden 404 when Decision Flow is disabled
 * would let clients incorrectly reopen a writer that is guaranteed to fail.
 */
function requireCapabilityRoute(scope: { userId: number; tenantId: number }, res: Response): boolean {
  if (getTrainingPlanRevisionV1Mode(process.env, scope) !== 'active'
      || !isTrainingPlanRevisionV1ExplicitlyEnrolled(process.env, scope)
      || scope.userId !== scope.tenantId) {
    sendError(res, 'NOT_FOUND', 'Route not found.', 404);
    return false;
  }
  if (!isDecisionFlowV1EnforceEnabled(process.env, scope)) {
    sendError(
      res,
      'TRAINING_REVISION_EXECUTION_DEPENDENCY_DISABLED',
      'Training plan revisions are enrolled, but Decision Flow execution is not enabled.',
      409,
    );
    return false;
  }
  return true;
}

function sendRevisionError(res: Response, error: unknown, operation: string): void {
  if (error instanceof TrainingPlanRevisionError) {
    sendError(res, error.code, error.message, error.statusCode);
    return;
  }
  if (error instanceof Error
      && (error.message.startsWith('TRAINING_') || error.message.startsWith('MILESTONE_1_'))) {
    sendError(res, error.message, 'The Training candidate request is invalid.', 400);
    return;
  }
  logger.error({ error, operation }, `Training plan revision ${operation} failed`);
  sendInternalError(res, `Training plan revision ${operation} failed`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
