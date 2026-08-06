import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let realDb: Database.Database;

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database'
  )),
  getDb: () => {
    if (!realDb) throw new Error('test db not initialized');
    return realDb;
  },
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  getTrainingPlanGenerationAttemptStatus,
  type TrainingPlanGenerationLeaseIdentity,
} from '../../src/services/training-plan-generation-idempotency';

function ownedClaim(
  claim: ReturnType<typeof claimTrainingPlanGenerationIdempotency>,
): TrainingPlanGenerationLeaseIdentity {
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('expected owned claim');
  return claim;
}

function seedActivePlanGraph(input: { planId: number; userId: number; tenantId: number }): void {
  realDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, tenant_id, status)
    VALUES (?, ?, ?, 'active')
  `).run(input.planId, input.userId, input.tenantId);
  realDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)')
    .run(input.planId + 1_000, input.planId);
  realDb.prepare(`
    INSERT INTO training_sessions (id, week_id, plan_id, day_of_week)
    VALUES (?, ?, ?, 'Monday')
  `).run(input.planId + 2_000, input.planId + 1_000, input.planId);
}

describe('Training plan generation attempt status', () => {
  beforeEach(() => {
    realDb = new Database(':memory:');
    realDb.exec(`
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE training_weeks (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL,
        week_number INTEGER NOT NULL
      );
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY,
        week_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        day_of_week TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
    realDb.close();
  });

  it('keeps live attempts bound and authorizes a fresh re-preview only after a newly fenced lease expires', () => {
    const key = 'ios:create:uncertain-live-attempt';
    claimTrainingPlanGenerationIdempotency(12, 12, key, 'private-request-hash');
    const before = realDb.prepare(`
      SELECT status, attempt_count, lease_owner, fencing_token
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(key);

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'in_progress',
      recovery: 'retry_same_attempt',
      canStartNew: false,
    });
    expect(realDb.prepare(`
      SELECT status, attempt_count, lease_owner, fencing_token
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(key)).toEqual(before);

    realDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(key);

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'expired',
      recovery: 'repreview_same_attempt',
      canStartNew: false,
    });
    expect(realDb.prepare(`
      SELECT status, attempt_count
        FROM training_plan_generation_idempotency_scoped
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).get(key)).toMatchObject({ status: 'in_progress', attempt_count: 1 });
  });

  it('keeps an unfenced legacy expired row fail-closed', () => {
    const key = 'ios:create:legacy-expired-attempt';
    claimTrainingPlanGenerationIdempotency(12, 12, key, 'legacy-request-hash');
    realDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_owner = NULL,
             fencing_token = NULL,
             lease_expires_at = '2020-01-01T00:00:00.000Z'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(key);

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'expired',
      recovery: 'retry_same_attempt',
      canStartNew: false,
    });
  });

  it('returns created only when the replay payload proves a scoped active plan graph', () => {
    const key = 'ios:create:active-proof';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, 'hash-a'));
    completeTrainingPlanGenerationIdempotency(12, 34, claim, { status: 'created', planId: 701 }, 201);

    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'unknown',
      // Stronger guarantee: incomplete replay proof never authorizes another
      // mutation; the client checks status again while operators reconcile.
      recovery: 'check_status_again',
      canStartNew: false,
    });

    seedActivePlanGraph({ planId: 701, userId: 12, tenantId: 34 });

    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'created',
      recovery: 'use_created_plan',
      canStartNew: false,
      planId: 701,
    });
  });

  it('returns a terminal created_inactive receipt for scoped canceled and superseded plan graphs', () => {
    for (const [offset, status] of ['canceled', 'superseded'].entries()) {
      const planId = 711 + offset;
      const key = `ios:create:${status}-proof`;
      const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, `hash-${status}`));
      completeTrainingPlanGenerationIdempotency(12, 34, claim, { status: 'created', planId }, 201);
      seedActivePlanGraph({ planId, userId: 12, tenantId: 34 });
      realDb.prepare('UPDATE fitness_training_plans SET status = ? WHERE id = ?').run(status, planId);

      expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toEqual({
        schemaVersion: 'training_plan_generation_attempt_status.v1',
        state: 'created_inactive',
        recovery: 'refresh_active_plan',
        canStartNew: false,
        planId,
      });
    }
  });

  it('does not reveal another tenant attempt that uses the same key', () => {
    const key = 'ios:create:tenant-bound';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, 'hash-a'));
    completeTrainingPlanGenerationIdempotency(12, 34, claim, { status: 'created', planId: 702 }, 201);
    seedActivePlanGraph({ planId: 702, userId: 12, tenantId: 34 });

    expect(getTrainingPlanGenerationAttemptStatus(12, 56, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'not_found',
      // Stronger guarantee: scope-local absence is not no-creation proof.
      recovery: 'check_status_again',
      canStartNew: false,
    });
    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({
      state: 'created',
      planId: 702,
    });
  });

  it('authorizes Start New for explicit pre-persist failures and current atomic-protocol failed claims', () => {
    const knownKey = 'ios:create:known-pre-persist';
    const genericKey = 'ios:create:generic-failure';
    const known = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 12, knownKey, 'hash-known'));
    const generic = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 12, genericKey, 'hash-generic'));
    failTrainingPlanGenerationIdempotency(12, 12, known, 'TRAINING_PLAN_NEEDS_CLARIFICATION');
    failTrainingPlanGenerationIdempotency(12, 12, generic, 'TRAINING_PLAN_GENERATION_FAILED');

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, knownKey)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'known_no_creation',
      recovery: 'start_new_allowed',
      canStartNew: true,
    });
    // The current protocol completes plan+receipt in one transaction. A
    // fenced row that this owner successfully moved to failed therefore
    // proves that transaction did not commit, even for an unexpected code.
    expect(getTrainingPlanGenerationAttemptStatus(12, 12, genericKey)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'known_no_creation',
      recovery: 'start_new_allowed',
      canStartNew: true,
    });
  });

  it('fails closed for corrupt succeeded payloads and absent rows', () => {
    const key = 'ios:create:corrupt-replay';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 12, key, 'hash-corrupt'));
    completeTrainingPlanGenerationIdempotency(12, 12, claim, { status: 'created', planId: 703 }, 201);
    realDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET response_json = '{not-json'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(key);

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, key)).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'unknown',
      recovery: 'check_status_again',
      canStartNew: false,
    });
    expect(getTrainingPlanGenerationAttemptStatus(12, 12, 'ios:create:missing')).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'not_found',
      recovery: 'check_status_again',
      canStartNew: false,
    });
  });

  it('fails closed for invalid keys and missing or malformed lease expiries', () => {
    expect(getTrainingPlanGenerationAttemptStatus(12, 12, '   ')).toEqual({
      schemaVersion: 'training_plan_generation_attempt_status.v1',
      state: 'not_found',
      recovery: 'check_status_again',
      canStartNew: false,
    });

    for (const [suffix, leaseExpiry] of [
      ['missing-expiry', null],
      ['invalid-expiry', 'not-a-date'],
    ] as const) {
      const key = `ios:create:${suffix}`;
      claimTrainingPlanGenerationIdempotency(12, 12, key, `hash-${suffix}`);
      realDb.prepare(`
        UPDATE training_plan_generation_idempotency_scoped
           SET lease_expires_at = ?
         WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
      `).run(leaseExpiry, key);
      expect(getTrainingPlanGenerationAttemptStatus(12, 12, key)).toMatchObject({
        state: 'unknown',
        recovery: 'check_status_again',
        canStartNew: false,
      });
    }

    const sqliteKey = 'ios:create:sqlite-live-expiry';
    claimTrainingPlanGenerationIdempotency(12, 12, sqliteKey, 'hash-sqlite-live');
    realDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_expires_at = '2099-01-01 00:00:00'
       WHERE user_id = 12 AND tenant_id = 12 AND idempotency_key = ?
    `).run(sqliteKey);
    expect(getTrainingPlanGenerationAttemptStatus(12, 12, sqliteKey)).toMatchObject({
      state: 'in_progress',
      recovery: 'retry_same_attempt',
    });
  });

  it('requires durable no-creation proof for unfenced failed rows', () => {
    const knownKey = 'ios:create:legacy-known-no-creation';
    const unknownKey = 'ios:create:legacy-unknown-failure';
    const known = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 12, knownKey, 'hash-known'));
    const unknown = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 12, unknownKey, 'hash-unknown'));
    failTrainingPlanGenerationIdempotency(12, 12, known, 'TRAINING_PLAN_NEEDS_PROFILE');
    failTrainingPlanGenerationIdempotency(12, 12, unknown, 'UNCLASSIFIED_LEGACY_FAILURE');
    realDb.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_owner = NULL, fencing_token = NULL
       WHERE idempotency_key IN (?, ?)
    `).run(knownKey, unknownKey);

    expect(getTrainingPlanGenerationAttemptStatus(12, 12, knownKey)).toMatchObject({
      state: 'known_no_creation',
      recovery: 'start_new_allowed',
      canStartNew: true,
    });
    expect(getTrainingPlanGenerationAttemptStatus(12, 12, unknownKey)).toMatchObject({
      state: 'unknown',
      recovery: 'check_status_again',
      canStartNew: false,
    });
  });

  it('accepts string and snake-case plan ids only with a complete scoped graph', () => {
    const key = 'ios:create:string-plan-id';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, 'hash-string-id'));
    completeTrainingPlanGenerationIdempotency(
      12, 34, claim, { status: 'created', plan_id: '721' }, 201,
    );
    seedActivePlanGraph({ planId: 721, userId: 12, tenantId: 34 });

    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({
      state: 'created',
      recovery: 'use_created_plan',
      planId: 721,
    });
  });

  it('rejects replay shapes that do not prove a completed created plan', () => {
    const key = 'ios:create:replay-shape-guard';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, 'hash-shape'));
    completeTrainingPlanGenerationIdempotency(12, 34, claim, { planId: 731 }, 201);
    seedActivePlanGraph({ planId: 731, userId: 12, tenantId: 34 });

    const assertUnknown = (responseJson: string): void => {
      realDb.prepare(`
        UPDATE training_plan_generation_idempotency_scoped
           SET response_json = ?
         WHERE user_id = 12 AND tenant_id = 34 AND idempotency_key = ?
      `).run(responseJson, key);
      expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({
        state: 'unknown',
        recovery: 'check_status_again',
        canStartNew: false,
      });
    };

    assertUnknown('null');
    assertUnknown('[]');
    assertUnknown('{"status":"pending","planId":731}');
    assertUnknown('{"status":"created","planId":""}');
    assertUnknown('{"status":"created","planId":"not-a-number"}');
    assertUnknown('{"status":"created","planId":"-7"}');
    assertUnknown('{"status":"created","planId":0}');
  });

  it('requires an eligible lifecycle, week, and session in the replay graph', () => {
    const key = 'ios:create:graph-completeness';
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(12, 34, key, 'hash-graph'));
    completeTrainingPlanGenerationIdempotency(12, 34, claim, { planId: 741 }, 201);
    realDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, tenant_id, status)
      VALUES (741, 12, 34, '')
    `).run();

    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({ state: 'unknown' });

    realDb.prepare("UPDATE fitness_training_plans SET status = 'active' WHERE id = 741").run();
    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({ state: 'unknown' });

    realDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (1741, 741, 1)').run();
    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({ state: 'unknown' });

    realDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week)
      VALUES (2741, 1741, 741, 'Monday')
    `).run();
    expect(getTrainingPlanGenerationAttemptStatus(12, 34, key)).toMatchObject({
      state: 'created',
      planId: 741,
    });
  });
});
