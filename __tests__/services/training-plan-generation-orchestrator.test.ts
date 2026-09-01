// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  TRAINING_PLAN_GENERATION_CONTEXT_VERSION,
  TrainingPlanGenerationOrchestrator,
  type TrainingPlanGenerationContext,
} from '../../src/services/training-plan-generation-orchestrator';

interface Request {
  userId: number;
  tenantId: number;
  objective: string;
  nested?: { sessionsPerWeek: number };
}

describe('TrainingPlanGenerationOrchestrator', () => {
  it('keeps the coach kernel storage-blind and the API module as a thin facade', () => {
    const kernel = readFileSync(
      path.resolve('src/services/training-coach-kernel-plan-generator.ts'),
      'utf8',
    );
    const routeFacade = readFileSync(
      path.resolve('src/api/routes/training-plan-generation.ts'),
      'utf8',
    );
    const productionPipeline = readFileSync(
      path.resolve('src/services/training-plan-generation-pipeline.ts'),
      'utf8',
    );
    const candidateStage = productionPipeline.slice(
      productionPipeline.indexOf('async function buildTrainingPlanGenerationCandidate'),
      productionPipeline.indexOf('function buildTrainingPlanCreatedMessage'),
    );

    expect(kernel).not.toContain('readTrainingHistoryFromCompletions(');
    expect(kernel).not.toContain('readTrainingComplianceFromRecentHistory(');
    expect(routeFacade).toContain("export * from '../../services/training-plan-generation-pipeline'");
    expect(routeFacade).not.toMatch(/getDb\(|persistGeneratedTrainingPlan\(|buildCoachKernelTrainingPlan\(/);
    expect(candidateStage).toContain('context.snapshot.coordination');
    expect(candidateStage).toContain('context.snapshot.profileRequirements');
    expect(candidateStage).not.toMatch(
      /read(?:Training|Cooking|Finance|Content|Secretary)MeshContext\(|buildSharedDecisionContext\(|onboarding\.get(?:Profile|MissingProfileFields)\(|getEvents(?:ForSources)?\(|fetchCurrentReadinessForPlan\(|getEffectiveHealthSafetyOutput\(/,
    );
  });

  it('collects Secretary evidence once under the explicit tenant scope', async () => {
    const readSecretaryAgendaItems = vi.fn(() => [{
      startAt: '2026-08-31T08:00:00.000Z',
      endAt: '2026-08-31T10:00:00.000Z',
      lifecycleState: 'scheduled',
      sourceSkill: 'training',
      decisionAction: 'scheduled',
      title: 'Private event title',
    }]);
    const pipeline = vi.fn(async (context: TrainingPlanGenerationContext<Request>) => context);
    const orchestrator = new TrainingPlanGenerationOrchestrator(pipeline, {
      readSecretaryAgendaItems,
      now: () => new Date('2026-08-30T21:00:00.000Z'),
    });

    const context = await orchestrator.execute({
      userId: 41,
      tenantId: 9001,
      objective: 'Lisbon Marathon',
    });

    expect(readSecretaryAgendaItems).toHaveBeenCalledOnce();
    expect(readSecretaryAgendaItems).toHaveBeenCalledWith({
      ownerUserId: 41,
      tenantId: 9001,
      includeInactive: true,
    });
    expect(context).toMatchObject({
      version: TRAINING_PLAN_GENERATION_CONTEXT_VERSION,
      scope: { userId: 41, tenantId: 9001 },
      capturedAt: '2026-08-30T21:00:00.000Z',
    });
    expect(context.secretaryAgendaItems).toEqual([{
      startAt: '2026-08-31T08:00:00.000Z',
      endAt: '2026-08-31T10:00:00.000Z',
      lifecycleState: 'scheduled',
      sourceSkill: 'training',
      decisionAction: 'scheduled',
    }]);
    expect(context.secretaryAgendaItems[0]).not.toHaveProperty('title');
    expect(pipeline).toHaveBeenCalledOnce();
  });

  it('freezes the request, scope, and evidence before the pipeline runs', async () => {
    const request: Request = {
      userId: 7,
      tenantId: 77,
      objective: 'Cycling base',
      nested: { sessionsPerWeek: 5 },
    };
    const orchestrator = new TrainingPlanGenerationOrchestrator(
      async (context) => context,
      {
        readSecretaryAgendaItems: () => [],
        now: () => new Date('2026-08-30T21:00:00.000Z'),
      },
    );

    const context = await orchestrator.execute(request);
    request.objective = 'mutated after capture';
    request.nested!.sessionsPerWeek = 1;

    expect(context.request.objective).toBe('Cycling base');
    expect(context.request.nested?.sessionsPerWeek).toBe(5);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.scope)).toBe(true);
    expect(Object.isFrozen(context.request)).toBe(true);
    expect(Object.isFrozen(context.request.nested)).toBe(true);
    expect(Object.isFrozen(context.secretaryAgendaItems)).toBe(true);
  });

  it('captures and deep-freezes one domain snapshot before candidate generation', async () => {
    const captureSnapshot = vi.fn(async () => ({
      activePlanIds: [91],
      readiness: { score: 72, factors: { sleep: 'stable' } },
    }));
    const pipeline = vi.fn(async (context: TrainingPlanGenerationContext<
      Request,
      { activePlanIds: number[]; readiness: { score: number; factors: { sleep: string } } }
    >) => context);
    const orchestrator = new TrainingPlanGenerationOrchestrator<
      Request,
      TrainingPlanGenerationContext<
        Request,
        { activePlanIds: number[]; readiness: { score: number; factors: { sleep: string } } }
      >,
      never,
      { activePlanIds: number[]; readiness: { score: number; factors: { sleep: string } } }
    >(pipeline, {
      captureSnapshot,
      readSecretaryAgendaItems: () => [],
      now: () => new Date('2026-08-30T21:00:00.000Z'),
    });

    const context = await orchestrator.execute({
      userId: 7,
      tenantId: 77,
      objective: 'Immutable evidence',
    });

    expect(captureSnapshot).toHaveBeenCalledOnce();
    expect(captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      tenantId: 77,
    }));
    expect(Object.isFrozen(context.snapshot)).toBe(true);
    expect(Object.isFrozen(context.snapshot.activePlanIds)).toBe(true);
    expect(Object.isFrozen(context.snapshot.readiness.factors)).toBe(true);
    expect(pipeline).toHaveBeenCalledOnce();
  });

  it('fails closed when tenant scope is absent and never runs the pipeline', async () => {
    const pipeline = vi.fn();
    const orchestrator = new TrainingPlanGenerationOrchestrator(pipeline, {
      readSecretaryAgendaItems: vi.fn(() => []),
      now: () => new Date('2026-08-30T21:00:00.000Z'),
    });

    await expect(orchestrator.execute({
      userId: 7,
      tenantId: 0,
      objective: 'Invalid scope',
    })).rejects.toThrow(/TENANT_SCOPE_REQUIRED|tenant/i);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it('sequences candidate generation and preview signing without persistence', async () => {
    const order: string[] = [];
    const candidate = Object.freeze({ id: 'candidate-preview' });
    const signPreview = vi.fn(async () => {
      order.push('sign');
      return 'signed-preview';
    });
    const persist = vi.fn(async () => 'persisted');
    const orchestrator = new TrainingPlanGenerationOrchestrator<Request, string, typeof candidate>({
      generateCandidate: async (context) => {
        order.push(`generate:${context.scope.tenantId}`);
        return { kind: 'candidate', disposition: 'preview', candidate };
      },
      signPreview,
      persist,
    }, {
      readSecretaryAgendaItems: () => [],
      now: () => new Date('2026-08-30T21:00:00.000Z'),
    });

    await expect(orchestrator.execute({
      userId: 7,
      tenantId: 77,
      objective: 'Preview only',
    })).resolves.toBe('signed-preview');
    expect(order).toEqual(['generate:77', 'sign']);
    expect(signPreview).toHaveBeenCalledWith(expect.objectContaining({
      scope: { userId: 7, tenantId: 77 },
    }), candidate);
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists only a persist disposition and bypasses both terminal stages for early results', async () => {
    const persist = vi.fn(async () => 'persisted');
    const signPreview = vi.fn(async () => 'signed');
    const candidate = Object.freeze({ id: 'candidate-persist' });
    const generateCandidate = vi.fn()
      .mockResolvedValueOnce({ kind: 'complete', result: 'needs_profile' })
      .mockResolvedValueOnce({ kind: 'candidate', disposition: 'persist', candidate });
    const orchestrator = new TrainingPlanGenerationOrchestrator<Request, string, typeof candidate>({
      generateCandidate,
      signPreview,
      persist,
    }, {
      readSecretaryAgendaItems: () => [],
      now: () => new Date('2026-08-30T21:00:00.000Z'),
    });

    await expect(orchestrator.execute({
      userId: 7,
      tenantId: 77,
      objective: 'Incomplete',
    })).resolves.toBe('needs_profile');
    expect(signPreview).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();

    await expect(orchestrator.execute({
      userId: 7,
      tenantId: 77,
      objective: 'Ready',
    })).resolves.toBe('persisted');
    expect(persist).toHaveBeenCalledWith(expect.any(Object), candidate);
    expect(signPreview).not.toHaveBeenCalled();
  });
});
