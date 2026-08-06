import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    throw new Error('No database in memory-mode idempotency test');
  },
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  _resetTrainingPlanGenerationIdempotencyForTests,
  assertTrainingPlanGenerationIdempotencyLease,
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  fingerprintTrainingPlanGenerationRequest,
  normalizeTrainingPlanGenerationAttemptLookupKey,
  renewTrainingPlanGenerationIdempotencyLease,
  startTrainingPlanGenerationIdempotencyHeartbeat,
  TrainingPlanGenerationLeaseLostError,
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

  it('reclaims an expired memory lease and fences the stale owner', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const first = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12,
      34,
      'manual:memory-expired-owner',
      'same-plan-request-hash',
    ));
    vi.setSystemTime(new Date('2026-04-15T12:31:00.000Z'));

    const replacement = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12,
      34,
      first.idempotencyKey,
      first.requestHash,
    ));

    expect(replacement.fencingToken).not.toBe(first.fencingToken);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, first, { planId: 900 }, 201,
    )).toBe(false);
    expect(failTrainingPlanGenerationIdempotency(
      12, 34, first, 'STALE_OWNER', 'retryable',
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, replacement, { planId: 901 }, 201,
    )).toBe(true);
  });

  it('rebinds only an expired fenced memory lease when the caller opts in', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));

    const first = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12,
      34,
      'ios:create:memory-repreview',
      'preview-hash-a',
    ));
    vi.setSystemTime(new Date('2026-04-15T12:31:00.000Z'));

    expect(claimTrainingPlanGenerationIdempotency(
      12, 34, first.idempotencyKey, 'preview-hash-b',
    )).toEqual({ kind: 'conflict', idempotencyKey: first.idempotencyKey });

    const rebound = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12,
      34,
      first.idempotencyKey,
      'preview-hash-b',
      { allowExpiredFencedRequestHashRebind: true },
    ));
    expect(rebound).toMatchObject({
      idempotencyKey: first.idempotencyKey,
      requestHash: 'preview-hash-b',
    });
    expect(rebound.fencingToken).not.toBe(first.fencingToken);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, first, { planId: 900 }, 201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, rebound, { planId: 901 }, 201,
    )).toBe(true);
  });

  it('retries memory failures but keeps terminal outcomes closed', () => {
    const retryable = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-retryable', 'hash-retryable',
    ));
    expect(failTrainingPlanGenerationIdempotency(
      12, 34, retryable, 'PROVIDER_UNAVAILABLE', 'retryable',
    )).toBe(true);
    const retried = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, retryable.idempotencyKey, retryable.requestHash,
    ));
    expect(retried.fencingToken).not.toBe(retryable.fencingToken);

    const terminal = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-terminal', 'hash-terminal',
    ));
    expect(failTrainingPlanGenerationIdempotency(
      12, 34, terminal, 'INVALID_PLAN', 'terminal',
    )).toBe(true);
    expect(claimTrainingPlanGenerationIdempotency(
      12, 34, terminal.idempotencyKey, terminal.requestHash,
    )).toEqual({ kind: 'conflict', idempotencyKey: terminal.idempotencyKey });
  });

  it('makes an identical memory completion retry idempotent', () => {
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-idempotent-completion', 'hash-complete',
    ));
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, claim, { planId: 901 }, 201,
    )).toBe(true);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, claim, { planId: 901 }, 201,
    )).toBe(true);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, { ...claim, requestHash: 'different-hash' }, { planId: 901 }, 201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, { ...claim, leaseOwner: 'different-owner' }, { planId: 901 }, 201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, { ...claim, fencingToken: 'different-token' }, { planId: 901 }, 201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, claim, { planId: 902 }, 201,
    )).toBe(false);
    expect(completeTrainingPlanGenerationIdempotency(
      12, 34, claim, { planId: 901 }, 200,
    )).toBe(false);
  });

  it('renews and asserts a live memory lease without resurrecting expiry', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-renew', 'hash-renew',
    ));

    expect(() => assertTrainingPlanGenerationIdempotencyLease(12, 34, claim)).not.toThrow();
    vi.setSystemTime(new Date('2026-04-15T12:05:00.000Z'));
    expect(renewTrainingPlanGenerationIdempotencyLease(12, 34, claim)).toBe(true);

    vi.setSystemTime(new Date('2026-04-15T12:36:00.000Z'));
    expect(renewTrainingPlanGenerationIdempotencyLease(12, 34, claim)).toBe(false);
    expect(() => assertTrainingPlanGenerationIdempotencyLease(12, 34, claim))
      .toThrow(TrainingPlanGenerationLeaseLostError);
  });

  it('reports heartbeat ownership loss and makes stop idempotent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-heartbeat', 'hash-heartbeat',
    ));

    vi.setSystemTime(new Date('2026-04-15T12:31:00.000Z'));
    const heartbeat = startTrainingPlanGenerationIdempotencyHeartbeat(12, 34, claim);
    expect(heartbeat.ownershipLost()).toBe(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(heartbeat.ownershipLost()).toBe(true);
    heartbeat.stop();
    heartbeat.stop();
  });

  it('keeps a live heartbeat owned until explicitly stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'manual:memory-live-heartbeat', 'hash-live-heartbeat',
    ));
    const heartbeat = startTrainingPlanGenerationIdempotencyHeartbeat(12, 34, claim);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(heartbeat.ownershipLost()).toBe(false);
    heartbeat.stop();
  });

  it('replaces only stale failed automatic memory receipts', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date('2026-04-15T12:00:00.000Z'));
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(
      12, 34, 'auto:memory-failed-window', 'hash-a',
    ));
    expect(failTrainingPlanGenerationIdempotency(
      12, 34, claim, 'PREVIEW_STALE', 'retryable',
    )).toBe(true);

    vi.setSystemTime(new Date('2026-04-15T12:01:00.000Z'));
    expect(claimTrainingPlanGenerationIdempotency(
      12, 34, claim.idempotencyKey, 'hash-b',
    )).toEqual({ kind: 'conflict', idempotencyKey: claim.idempotencyKey });

    vi.setSystemTime(new Date('2026-04-15T12:01:31.000Z'));
    expect(claimTrainingPlanGenerationIdempotency(
      12, 34, claim.idempotencyKey, 'hash-b',
    )).toMatchObject({ kind: 'claimed', requestHash: 'hash-b' });
  });

  it('normalizes attempt keys without truncation or cross-key aliasing', () => {
    expect(normalizeTrainingPlanGenerationAttemptLookupKey(undefined)).toBeNull();
    expect(normalizeTrainingPlanGenerationAttemptLookupKey('   ')).toBeNull();
    expect(normalizeTrainingPlanGenerationAttemptLookupKey(`k${'x'.repeat(200)}`)).toBeNull();
    expect(normalizeTrainingPlanGenerationAttemptLookupKey('  ios:create:attempt  '))
      .toBe('ios:create:attempt');
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
