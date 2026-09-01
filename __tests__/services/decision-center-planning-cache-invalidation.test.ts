import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mockInvalidatePlanningCaches = vi.fn();

vi.mock('../../src/services/cache-coherence-registry', () => ({
  invalidatePlanningCaches: (...args: unknown[]) => mockInvalidatePlanningCaches(...args),
}));

describe('Decision Center planning cache invalidation', () => {
  beforeEach(() => {
    mockInvalidatePlanningCaches.mockReset();
  });

  it.each([
    'approve_script',
    'request_rewrite',
    'accept_reflow',
    'choose_another_time',
    'undo_reflow',
    'mark_paid',
    'add_meal',
    'activate_training_plan_revision',
    'activate_training_coach_v2_proposal',
  ])('invalidates the authenticated user after verified source mutation %s', async (actionId) => {
    const { invalidatePlanningAfterVerifiedDecisionSourceMutation } = await import(
      '../../src/services/decision-center/planning-cache-invalidation'
    );
    expect(invalidatePlanningAfterVerifiedDecisionSourceMutation({
      actionId,
      userId: 42,
      status: 'succeeded',
      readBackOk: true,
      idempotent: false,
    })).toBe(true);
    expect(mockInvalidatePlanningCaches).toHaveBeenCalledWith(42);
  });

  it.each([
    { actionId: 'add_meal', status: 'failed', readBackOk: true, idempotent: false },
    { actionId: 'add_meal', status: 'succeeded', readBackOk: false, idempotent: false },
    { actionId: 'add_meal', status: 'idempotent', readBackOk: true, idempotent: true },
    { actionId: 'dismiss', status: 'succeeded', readBackOk: true, idempotent: false },
    { actionId: 'snooze', status: 'succeeded', readBackOk: true, idempotent: false },
    { actionId: 'open_detail', status: 'succeeded', readBackOk: true, idempotent: false },
  ] as const)('does not invalidate rejected, unverified, replayed, or lifecycle-only action %#', async (input) => {
    const { invalidatePlanningAfterVerifiedDecisionSourceMutation } = await import(
      '../../src/services/decision-center/planning-cache-invalidation'
    );
    expect(invalidatePlanningAfterVerifiedDecisionSourceMutation({ ...input, userId: 42 })).toBe(false);
    expect(mockInvalidatePlanningCaches).not.toHaveBeenCalled();
  });

  it('is wired after the success-ledger transition in both rewrite and emergency legacy engines', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/services/decision-center/command-service.ts'), 'utf8');
    const successWrites = [...source.matchAll(/markExecutionSucceeded\(/g)].length;
    const invalidations = [...source.matchAll(/invalidatePlanningAfterVerifiedDecisionSourceMutation\(\{/g)].length;
    expect(successWrites).toBeGreaterThanOrEqual(2);
    expect(invalidations).toBe(2);
  });
});
