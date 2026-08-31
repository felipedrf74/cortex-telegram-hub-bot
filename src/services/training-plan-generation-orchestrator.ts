// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import type { SecretaryAgendaSummaryInput } from './coach-kernel/decision-trail';
import { listSecretaryAgendaItems } from './secretary-scheduling-arbitrator';
import { requireTenantIdParam } from './tenant-scope';

export const TRAINING_PLAN_GENERATION_CONTEXT_VERSION =
  'training_plan_generation_context.v1' as const;

export interface TenantScopedTrainingPlanGenerationRequest {
  userId: number;
  tenantId: number;
}

/**
 * One replayable snapshot for an entire Training plan generation attempt.
 *
 * The orchestrator captures cross-skill evidence once, strips it to the
 * privacy-light kernel contract, and freezes both request and evidence before
 * any validation/generation/preview/persistence work runs. The kernel never
 * receives a database handle or a tenant fallback.
 */
export interface TrainingPlanGenerationContext<
  Request extends TenantScopedTrainingPlanGenerationRequest,
  Snapshot = Readonly<Record<string, never>>,
> {
  readonly version: typeof TRAINING_PLAN_GENERATION_CONTEXT_VERSION;
  readonly scope: Readonly<{ userId: number; tenantId: number }>;
  readonly request: Readonly<Request>;
  readonly snapshot: Readonly<Snapshot>;
  readonly secretaryAgendaItems: ReadonlyArray<Readonly<SecretaryAgendaSummaryInput>>;
  readonly capturedAt: string;
}

export interface TrainingPlanGenerationOrchestratorDependencies<
  Request extends TenantScopedTrainingPlanGenerationRequest = TenantScopedTrainingPlanGenerationRequest,
  Snapshot = Readonly<Record<string, never>>,
> {
  readSecretaryAgendaItems?(scope: {
    ownerUserId: number;
    tenantId: number;
    includeInactive: boolean;
  }): ReadonlyArray<SecretaryAgendaSummaryInput>;
  captureSnapshot?(request: Readonly<Request>): Promise<Snapshot> | Snapshot;
  now?(): Date;
}

type LegacyTrainingPlanGenerationPipeline<
  Request extends TenantScopedTrainingPlanGenerationRequest,
  Result,
  Snapshot,
> = (context: TrainingPlanGenerationContext<Request, Snapshot>) => Promise<Result>;

export type TrainingPlanGenerationCandidateStageResult<Candidate, Result> =
  | Readonly<{ kind: 'complete'; result: Result }>
  | Readonly<{ kind: 'candidate'; candidate: Candidate; disposition: 'preview' | 'persist' }>;

/**
 * Explicit stage contract used by the production generator. Validation and
 * immutable context capture happen in `execute`; candidate construction is
 * side-effect free with respect to plan persistence; preview signing and
 * persistence are mutually exclusive terminal stages.
 */
export interface StagedTrainingPlanGenerationPipeline<
  Request extends TenantScopedTrainingPlanGenerationRequest,
  Candidate,
  Result,
  Snapshot = Readonly<Record<string, never>>,
> {
  generateCandidate(
    context: TrainingPlanGenerationContext<Request, Snapshot>,
  ): Promise<TrainingPlanGenerationCandidateStageResult<Candidate, Result>>;
  signPreview(
    context: TrainingPlanGenerationContext<Request, Snapshot>,
    candidate: Candidate,
  ): Promise<Result>;
  persist(
    context: TrainingPlanGenerationContext<Request, Snapshot>,
    candidate: Candidate,
  ): Promise<Result>;
}

const DEFAULT_DEPENDENCIES: TrainingPlanGenerationOrchestratorDependencies = {
  readSecretaryAgendaItems: (scope) => listSecretaryAgendaItems(scope),
  now: () => new Date(),
};

/**
 * Structural seam for the compatibility-plan pipeline. Routes hand it only an
 * authenticated DTO. The bound pipeline retains the released result contracts
 * while all generation stages share the same immutable scope/context.
 */
export class TrainingPlanGenerationOrchestrator<
  Request extends TenantScopedTrainingPlanGenerationRequest,
  Result,
  Candidate = never,
  Snapshot = Readonly<Record<string, never>>,
> {
  constructor(
    private readonly pipeline:
      | LegacyTrainingPlanGenerationPipeline<Request, Result, Snapshot>
      | StagedTrainingPlanGenerationPipeline<Request, Candidate, Result, Snapshot>,
    private readonly dependencies: TrainingPlanGenerationOrchestratorDependencies<Request, Snapshot> =
      DEFAULT_DEPENDENCIES as TrainingPlanGenerationOrchestratorDependencies<Request, Snapshot>,
  ) {}

  async execute(request: Request): Promise<Result> {
    const tenantId = requireTenantIdParam(
      request.tenantId,
      'TrainingPlanGenerationOrchestrator.execute',
    );
    if (!Number.isSafeInteger(request.userId) || request.userId <= 0) {
      throw new Error('TrainingPlanGenerationOrchestrator requires a positive userId');
    }

    const context = await this.captureContext({ ...request, tenantId } as Request);
    if (typeof this.pipeline === 'function') {
      return this.pipeline(context);
    }

    const generated = await this.pipeline.generateCandidate(context);
    if (generated.kind === 'complete') return generated.result;
    if (generated.disposition === 'preview') {
      return this.pipeline.signPreview(context, generated.candidate);
    }
    return this.pipeline.persist(context, generated.candidate);
  }

  private async captureContext(
    request: Request,
  ): Promise<TrainingPlanGenerationContext<Request, Snapshot>> {
    let secretaryAgendaItems: ReadonlyArray<SecretaryAgendaSummaryInput> = [];
    try {
      secretaryAgendaItems = (
        this.dependencies.readSecretaryAgendaItems
        ?? DEFAULT_DEPENDENCIES.readSecretaryAgendaItems!
      )({
        ownerUserId: request.userId,
        tenantId: request.tenantId,
        includeInactive: true,
      });
    } catch (error) {
      // Secretary context is explanatory evidence, never generation
      // authority. A missing pre-migration table may omit the note but cannot
      // silently substitute a different tenant or block deterministic plans.
      logger.warn(
        {
          errorName: error instanceof Error ? error.name : 'unknown',
          userId: request.userId,
          tenantId: request.tenantId,
        },
        'Training plan generation Secretary context unavailable',
      );
    }

    const privacyLightAgenda = secretaryAgendaItems.map((item) => Object.freeze({
      startAt: item.startAt,
      endAt: item.endAt,
      lifecycleState: item.lifecycleState,
      sourceSkill: item.sourceSkill,
      decisionAction: item.decisionAction,
      // Titles are deliberately excluded. The kernel summary only needs
      // lifecycle, ownership, and duration evidence.
    }));
    const frozenRequest = freezePlainValue({ ...request }) as Readonly<Request>;
    const snapshot = this.dependencies.captureSnapshot
      ? await this.dependencies.captureSnapshot(frozenRequest)
      : {} as Snapshot;
    const capturedAt = (this.dependencies.now ?? DEFAULT_DEPENDENCIES.now!)().toISOString();

    return Object.freeze({
      version: TRAINING_PLAN_GENERATION_CONTEXT_VERSION,
      scope: Object.freeze({ userId: request.userId, tenantId: request.tenantId }),
      request: frozenRequest,
      snapshot: freezePlainValue(snapshot) as Readonly<Snapshot>,
      secretaryAgendaItems: Object.freeze(privacyLightAgenda),
      capturedAt,
    });
  }
}

function freezePlainValue<Value>(value: Value): Value {
  if (value instanceof Date) {
    return Object.freeze(new Date(value.getTime())) as Value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezePlainValue(item))) as Value;
  }
  if (value && typeof value === 'object') {
    const frozenEntries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, freezePlainValue(item)] as const);
    return Object.freeze(Object.fromEntries(frozenEntries)) as Value;
  }
  return value;
}
