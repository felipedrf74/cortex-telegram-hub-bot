// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type { Request, Router, Response } from 'express';
import type { AuthenticatedRequest } from '../auth-middleware';
import { sendError, sendInternalError, sendSuccess } from '../response-helpers';
import { requireTenantIdParam } from '../../services/tenant-scope';
import {
  getTrainingAdaptationV1Mode,
  getTrainingPlanRevisionV1Mode,
  isTrainingDecisionFlowV1EnforceEnabled,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  isTrainingTypedWorkoutV1Enabled,
  isTrainingM4ExplicitUserCapacityEnabled,
  getTrainingM4Allowlist,
} from '../../services/runtime-flags';
import type { TrainingAdaptationScope } from '../../services/training-adaptation-types';
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
import {
  refreshTrainingM4AuthoritativeCapacityContext,
  TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS,
  TRAINING_M4_CAPACITY_TTL_MINUTES,
  type TrainingM4CapacityRefreshRequest,
} from '../../services/training-m4-capacity-snapshots';
import { getTrainingCapabilityMetadata } from '../../services/capability-manifest';
import {
  recordTrainingCompatibilityRegression,
  recordTrainingPlanCorrectionObservations,
} from '../../services/training-learning-producers';

interface RevisionApiMeta {
  schemaVersion: typeof TRAINING_PLAN_REVISION_API_SCHEMA;
  mode: 'active';
}

const TRAINING_CAPABILITY_METADATA = getTrainingCapabilityMetadata();
export const TRAINING_REVISION_CAPABILITIES_PATH = TRAINING_CAPABILITY_METADATA.capacity.capabilitiesPath as '/plan/revision-capabilities';
export const TRAINING_M4_CAPACITY_REFRESH_METHOD = TRAINING_CAPABILITY_METADATA.capacity.refreshMethod as 'POST';
export const TRAINING_M4_CAPACITY_REFRESH_PATH = TRAINING_CAPABILITY_METADATA.capacity.refreshPath as '/plan/capacity-context/refresh';
export const TRAINING_M4_CAPACITY_REFRESH_API_SCHEMA = TRAINING_CAPABILITY_METADATA.capacity.refreshApiSchema as 'training_m4_capacity_refresh.v1';
// One reviewed recovery can require: initial refresh, explicitly narrowed
// confirmation, then the submit-time JIT refresh. The five-minute ceiling
// remains the outer abuse bound.
export const TRAINING_M4_CAPACITY_REFRESH_BURST_LIMIT = 3;
export const TRAINING_M4_CAPACITY_REFRESH_FIVE_MINUTE_LIMIT = 6;
const TRAINING_M4_CAPACITY_REFRESH_BURST_WINDOW_MS = 60_000;
const TRAINING_M4_CAPACITY_REFRESH_TOTAL_WINDOW_MS = 5 * 60_000;
const trainingM4CapacityRefreshRequestLog = new Map<string, number[]>();
const trainingM4CapacityRefreshInFlight = new Map<string, {
  idempotencyKey: string;
  requestHash: string;
  promise: Promise<TrainingM4AuthoritativeCapacityContext>;
}>();

/** Test-only reset for the process-local, per-person capacity refresh limiter. */
export function resetTrainingM4CapacityRefreshRateLimitForTests(): void {
  trainingM4CapacityRefreshRequestLog.clear();
  trainingM4CapacityRefreshInFlight.clear();
}

/** Deterministic test seam for the dual-window refresh budget. */
export function consumeTrainingM4CapacityRefreshRateLimitForTests(
  scope: { userId: number; tenantId: number },
  now: number,
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  return consumeTrainingM4CapacityRefreshRateLimit(scope, now);
}

export interface RevisionCapabilitiesResource extends RevisionApiMeta {
  registryVersion: 'training-workout-capabilities.v1';
  canonicalSessionTypes: typeof CANONICAL_TRAINING_SESSION_TYPES;
  workoutCapabilities: typeof TRAINING_WORKOUT_CAPABILITY_REGISTRY;
  planModes: typeof TRAINING_PLAN_MODE_CAPABILITIES;
  milestone1GenerationSessionTypes: string[];
  adaptationMode: 'off' | 'shadow' | 'active';
  adaptationScopes: TrainingAdaptationScope[];
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
    authoritativeRefresh: {
      supported: boolean;
      method: typeof TRAINING_M4_CAPACITY_REFRESH_METHOD;
      path: typeof TRAINING_M4_CAPACITY_REFRESH_PATH;
      requiresIdempotencyKey: true;
      requiresAllConnectedProviders: true;
      providerWriteEffects: false;
      freshnessMinutes: number;
      requestConstraints: {
        maxWindows: number;
        uniqueWeekdays: true;
        singleTimezone: true;
      };
      rateLimit: {
        burstMaxRequests: number;
        burstWindowSeconds: 60;
        totalMaxRequests: number;
        totalWindowSeconds: 300;
      };
    };
    activeM4CapacityRequirement: 'AUTHORITATIVE_ONLY' | 'AUTHORITATIVE_OR_EXPLICIT_USER';
    explicitUserEntrySupported: boolean;
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

export interface TrainingPlanRevisionRouteDependencies {
  refreshCapacityContext?: typeof refreshTrainingM4AuthoritativeCapacityContext;
  recordCompatibility?: typeof recordTrainingCompatibilityRegression;
  recordPlanCorrection?: typeof recordTrainingPlanCorrectionObservations;
}

export function registerTrainingPlanRevisionRoutes(
  router: Router,
  dependencies: TrainingPlanRevisionRouteDependencies = {},
): void {
  const capabilities = (req: Request, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireCapabilityRoute(scope, res)) return;
    const data = trainingPlanRevisionCapabilitiesForScope(scope)!;
    sendSuccess(res, data);
  };
  router.get(TRAINING_REVISION_CAPABILITIES_PATH, capabilities);
  router.get('/capabilities', capabilities);

  router.post(TRAINING_M4_CAPACITY_REFRESH_PATH, async (req, res: Response) => {
    const scope = resolveScope(req as unknown as AuthenticatedRequest, res);
    if (!scope || !requireCapacityRefreshRoute(scope, res)) return;
    const scopeKey = `${scope.tenantId}:${scope.userId}`;
    const idempotencyKey = req.header('idempotency-key') ?? '';
    const request = req.body as TrainingM4CapacityRefreshRequest;
    const requestHash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
    const inFlight = trainingM4CapacityRefreshInFlight.get(scopeKey);
    if (inFlight) {
      if (inFlight.idempotencyKey === idempotencyKey && inFlight.requestHash === requestHash) {
        try {
          const capacityContext = await inFlight.promise;
          sendCapacityRefreshSuccess(res, capacityContext);
        } catch (error) {
          sendRevisionError(res, error, 'refresh authoritative capacity');
        }
      } else {
        res.setHeader('Retry-After', '1');
        sendError(
          res,
          'TRAINING_M4_CAPACITY_REFRESH_IN_PROGRESS',
          'Another authoritative capacity refresh is already in progress for this profile.',
          409,
        );
      }
      return;
    }
    const refreshLimit = consumeTrainingM4CapacityRefreshRateLimit(scope);
    if (!refreshLimit.allowed) {
      res.setHeader('Retry-After', String(refreshLimit.retryAfterSeconds));
      sendError(
        res,
        'TRAINING_M4_CAPACITY_REFRESH_RATE_LIMITED',
        'Too many authoritative capacity refreshes. Retry after the current one-minute window.',
        429,
      );
      return;
    }
    const refreshPromise = (dependencies.refreshCapacityContext
      ?? refreshTrainingM4AuthoritativeCapacityContext)({
      scope,
      idempotencyKey,
      request,
    });
    trainingM4CapacityRefreshInFlight.set(scopeKey, {
      idempotencyKey,
      requestHash,
      promise: refreshPromise,
    });
    try {
      const capacityContext = await refreshPromise;
      sendCapacityRefreshSuccess(res, capacityContext);
    } catch (error) {
      sendRevisionError(res, error, 'refresh authoritative capacity');
    } finally {
      if (trainingM4CapacityRefreshInFlight.get(scopeKey)?.promise === refreshPromise) {
        trainingM4CapacityRefreshInFlight.delete(scopeKey);
      }
    }
  });

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
      const revision = candidateSet.candidates[0];
      try {
        (dependencies.recordCompatibility ?? recordTrainingCompatibilityRegression)({
          scope,
          revisionId: revision.revisionId,
          contentHash: revision.contentHash,
          reviewModel: buildTrainingPlanRevisionReviewReadModel(revision),
          observedAt: revision.createdAt,
        });
      } catch (learningError) {
        logger.warn(
          { err: learningError, tenantId: scope.tenantId, userId: scope.userId },
          'Training compatibility learning observation failed',
        );
      }
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
    const edits = isRecord(body.edits) ? body.edits : {};
    try {
      const editPreview = editTrainingPlanRevisionPreview({
        scope,
        revisionId: req.params.revisionId,
        expectedContentHash: stringValue(body.expectedContentHash),
        idempotencyKey,
        edits,
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
      try {
        (dependencies.recordPlanCorrection ?? recordTrainingPlanCorrectionObservations)({
          scope,
          currentContentHash: editPreview.currentRevision.contentHash,
          proposedContentHash: editPreview.proposedRevision.contentHash,
          changedFields: Object.keys(edits),
          observedAt: editPreview.proposedRevision.createdAt,
        });
        (dependencies.recordCompatibility ?? recordTrainingCompatibilityRegression)({
          scope,
          revisionId: editPreview.proposedRevision.revisionId,
          contentHash: editPreview.proposedRevision.contentHash,
          reviewModel: buildTrainingPlanRevisionReviewReadModel(editPreview.proposedRevision),
          observedAt: editPreview.proposedRevision.createdAt,
        });
      } catch (learningError) {
        logger.warn(
          { err: learningError, tenantId: scope.tenantId, userId: scope.userId },
          'Training plan correction learning observation failed',
        );
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
      || !isTrainingDecisionFlowV1EnforceEnabled(env, scope)
      || scope.userId !== scope.tenantId) return null;
  const typedWorkoutGenerationEnabled = isTrainingTypedWorkoutV1Enabled(env, scope);
  const configuredAdaptationMode = getTrainingAdaptationV1Mode(env, scope);
  const adaptationMode = configuredAdaptationMode === 'active' && !typedWorkoutGenerationEnabled
    ? 'off'
    : configuredAdaptationMode;
  const m4AllowedPlanCombinations = typedWorkoutGenerationEnabled
    ? getTrainingM4Allowlist(env, scope).map((entry) => {
      const [planMode, discipline] = entry.split(':');
      return {
        planMode: planMode as RevisionCapabilitiesResource['m4AllowedPlanCombinations'][number]['planMode'],
        discipline: discipline as RevisionCapabilitiesResource['m4AllowedPlanCombinations'][number]['discipline'],
      };
    })
    : [];
  const m4CapacityContext = typedWorkoutGenerationEnabled && m4AllowedPlanCombinations.length > 0
    ? getTrainingM4AuthoritativeCapacityContext(scope)
    : null;
  const explicitUserEntrySupported = m4AllowedPlanCombinations.length > 0
    && isTrainingM4ExplicitUserCapacityEnabled(env, scope);
  return {
    ...meta(),
    registryVersion: 'training-workout-capabilities.v1',
    canonicalSessionTypes: CANONICAL_TRAINING_SESSION_TYPES,
    workoutCapabilities: TRAINING_WORKOUT_CAPABILITY_REGISTRY,
    planModes: TRAINING_PLAN_MODE_CAPABILITIES,
    milestone1GenerationSessionTypes: TRAINING_WORKOUT_CAPABILITY_REGISTRY
      .filter((entry) => entry.milestone1GenerationEnabled)
      .map((entry) => entry.sessionType),
    adaptationMode,
    adaptationScopes: adaptationMode === 'active'
      ? ['SESSION', 'WEEK', 'PHASE', 'FULL_PLAN']
      : [],
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
      authoritativeRefresh: {
        supported: m4AllowedPlanCombinations.length > 0,
        method: TRAINING_M4_CAPACITY_REFRESH_METHOD,
        path: TRAINING_M4_CAPACITY_REFRESH_PATH,
        requiresIdempotencyKey: true,
        requiresAllConnectedProviders: true,
        providerWriteEffects: false,
        freshnessMinutes: TRAINING_M4_CAPACITY_TTL_MINUTES,
        requestConstraints: {
          maxWindows: TRAINING_M4_CAPACITY_REFRESH_MAX_WINDOWS,
          uniqueWeekdays: true,
          singleTimezone: true,
        },
        rateLimit: {
          burstMaxRequests: TRAINING_M4_CAPACITY_REFRESH_BURST_LIMIT,
          burstWindowSeconds: 60,
          totalMaxRequests: TRAINING_M4_CAPACITY_REFRESH_FIVE_MINUTE_LIMIT,
          totalWindowSeconds: 300,
        },
      },
      activeM4CapacityRequirement: explicitUserEntrySupported
        ? 'AUTHORITATIVE_OR_EXPLICIT_USER'
        : 'AUTHORITATIVE_ONLY',
      explicitUserEntrySupported,
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
      && isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)) {
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

function requireCapacityRefreshRoute(
  scope: { userId: number; tenantId: number },
  res: Response,
): boolean {
  if (!requireActiveRoute(scope, res)) return false;
  if (!isTrainingTypedWorkoutV1Enabled(process.env, scope)
      || getTrainingM4Allowlist(process.env, scope).length === 0) {
    sendError(res, 'NOT_FOUND', 'Route not found.', 404);
    return false;
  }
  return true;
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
  if (!isTrainingDecisionFlowV1EnforceEnabled(process.env, scope)) {
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

function sendCapacityRefreshSuccess(
  res: Response,
  capacityContext: TrainingM4AuthoritativeCapacityContext,
): void {
  sendSuccess(res, {
    schemaVersion: TRAINING_M4_CAPACITY_REFRESH_API_SCHEMA,
    mode: 'active' as const,
    capacityContext,
  }, { status: 201 });
}

function consumeTrainingM4CapacityRefreshRateLimit(
  scope: { userId: number; tenantId: number },
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const key = `${scope.tenantId}:${scope.userId}`;
  const cutoff = now - TRAINING_M4_CAPACITY_REFRESH_TOTAL_WINDOW_MS;
  const recent = (trainingM4CapacityRefreshRequestLog.get(key) ?? [])
    .filter((timestamp) => timestamp > cutoff);
  const burst = recent.filter((timestamp) => timestamp > now - TRAINING_M4_CAPACITY_REFRESH_BURST_WINDOW_MS);
  if (burst.length >= TRAINING_M4_CAPACITY_REFRESH_BURST_LIMIT
      || recent.length >= TRAINING_M4_CAPACITY_REFRESH_FIVE_MINUTE_LIMIT) {
    trainingM4CapacityRefreshRequestLog.set(key, recent);
    const burstRetryAt = burst.length >= TRAINING_M4_CAPACITY_REFRESH_BURST_LIMIT
      ? burst[0] + TRAINING_M4_CAPACITY_REFRESH_BURST_WINDOW_MS
      : now;
    const totalRetryAt = recent.length >= TRAINING_M4_CAPACITY_REFRESH_FIVE_MINUTE_LIMIT
      ? recent[0] + TRAINING_M4_CAPACITY_REFRESH_TOTAL_WINDOW_MS
      : now;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(
        (Math.max(burstRetryAt, totalRetryAt) - now) / 1000,
      )),
    };
  }
  recent.push(now);
  trainingM4CapacityRefreshRequestLog.set(key, recent);
  return { allowed: true };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
