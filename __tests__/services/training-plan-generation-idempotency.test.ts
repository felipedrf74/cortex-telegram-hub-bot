import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    throw new Error('No database in memory-mode idempotency test');
  },
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  _resetTrainingPlanGenerationIdempotencyForTests,
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
} from '../../src/services/training-plan-generation-idempotency';
import type { TrainingPlanGenerationLeaseIdentity } from '../../src/services/training-plan-generation-idempotency';

function ownedClaim(claim: ReturnType<typeof claimTrainingPlanGenerationIdempotency>): TrainingPlanGenerationLeaseIdentity {
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('expected owned claim');
  return claim;
}

describe('training plan generation idempotency', () => {
  afterEach(() => {
    vi.useRealTimers();
    _resetTrainingPlanGenerationIdempotencyForTests();
  });

  it('retains stale automatic ownership and requires the memory lease fence for completion', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:memory-slow-provider-request';
    const requestHash = 'same-plan-request-hash';

    const first = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash));
    expect(first).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:01:40.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(second).toEqual({ kind: 'in_progress', idempotencyKey: key });

    const fencedKey = 'manual:memory-fenced-completion';
    const fencedOwner = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12,
      34,
      fencedKey,
      requestHash,
    ));
    expect(completeTrainingPlanGenerationIdempotency(
      12,
      34,
      { ...fencedOwner, leaseOwner: `${fencedOwner.leaseOwner}:foreign` },
      { planId: 901 },
      201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12,
      34,
      { ...fencedOwner, fencingToken: `${fencedOwner.fencingToken}:stale` },
      { planId: 901 },
      201,
    )).toBe(false);
    expect(claimTrainingPlanGenerationIdempotency(12, 34, fencedKey, requestHash)).toEqual({
      kind: 'in_progress',
      idempotencyKey: fencedKey,
    });
    expect(completeTrainingPlanGenerationIdempotency(
      12,
      34,
      fencedOwner,
      { planId: 901 },
      201,
    )).toBe(true);
    expect(claimTrainingPlanGenerationIdempotency(12, 34, fencedKey, requestHash)).toEqual({
      kind: 'replay',
      idempotencyKey: fencedKey,
      responseData: { planId: 901 },
      statusCode: 201,
    });
  });

  it('uses completion time as the auto-key replay freshness anchor after slow writes', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const key = 'auto:memory-created-at-anchor';
    const requestHash = 'same-plan-request-hash';

    const first = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);
    expect(first).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });

    vi.setSystemTime(new Date('2026-04-15T12:02:10.000Z'));
    completeTrainingPlanGenerationIdempotency(12, 34, ownedClaim(first), { planId: 901 }, 201);

    vi.setSystemTime(new Date('2026-04-15T12:03:35.000Z'));
    const second = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(second).toEqual({
      kind: 'replay',
      idempotencyKey: key,
      responseData: { planId: 901 },
      statusCode: 201,
    });
  });

  it('scopes memory-mode idempotency claims by tenant', () => {
    const key = 'manual:tenant-scoped-double-tap';
    const requestHash = 'same-plan-request-hash';
    const firstTenant = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);
    completeTrainingPlanGenerationIdempotency(12, 34, ownedClaim(firstTenant), { planId: 901 }, 201);

    const secondTenant = claimTrainingPlanGenerationIdempotency(12, 56, key, requestHash);
    const firstTenantReplay = claimTrainingPlanGenerationIdempotency(12, 34, key, requestHash);

    expect(firstTenant).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });
    expect(secondTenant).toMatchObject({ kind: 'claimed', idempotencyKey: key, requestHash });
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
