import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    throw new Error('No database in memory-mode idempotency test');
  },
}));

import {
  _resetTrainingPlanGenerationIdempotencyForTests,
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
} from '../../src/services/training-plan-generation-idempotency';

describe('training plan generation idempotency', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetTrainingPlanGenerationIdempotencyForTests();
  });

  it('does not replace stale automatic in-progress rows in memory mode', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:memory-slow-provider-request';
    const requestHash = 'same-plan-request-hash';

    const first = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);
    expect(first).toEqual({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:01:40.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(second).toEqual({ kind: 'in_progress', idempotencyKey: key });
  });

  it('preserves the original memory-mode created_at freshness anchor on completion', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:memory-created-at-anchor';
    const requestHash = 'same-plan-request-hash';

    const first = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);
    expect(first).toEqual({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:00:10.000Z'));
    completeTrainingPlanGenerationIdempotency(12, 34, key, requestHash, { planId: 901 }, 201);

    vi.setSystemTime(new Date('2026-04-15T12:01:35.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(second).toEqual({ kind: 'claimed', idempotencyKey: key, requestHash });
  });

  it('scopes memory-mode idempotency claims by tenant', () => {
    const key = 'manual:tenant-scoped-double-tap';
    const requestHash = 'same-plan-request-hash';
    const firstTenant = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);
    completeTrainingPlanGenerationIdempotency(12, 34, key, requestHash, { planId: 901 }, 201);

    const secondTenant = claimTrainingPlanGenerationIdempotency(12, 56, key, requestHash);
    const firstTenantReplay = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(firstTenant).toEqual({ kind: 'claimed', idempotencyKey: key, requestHash });
    expect(secondTenant).toEqual({ kind: 'claimed', idempotencyKey: key, requestHash });
    expect(firstTenantReplay).toEqual({
      kind: 'replay',
      idempotencyKey: key,
      responseData: { planId: 901 },
      statusCode: 201,
    });
  });

  it('includes generator policy version in request fingerprints', () => {
    const base = {
      objective: 'Build consistency',
      durationWeeks: 12,
      sessionsPerWeek: 5,
    };

    expect(fingerprintTrainingPlanGenerationRequest({
      ...base,
      generatorPolicyVersion: 'training-plan-shape-v1',
    })).not.toEqual(fingerprintTrainingPlanGenerationRequest({
      ...base,
      generatorPolicyVersion: 'training-plan-shape-v2',
    }));
  });
});
