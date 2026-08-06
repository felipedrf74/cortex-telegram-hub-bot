import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Real-SQLite counterpart to training-plan-generation-idempotency.test.ts.
// The sibling suite pins the in-memory fallback; THIS suite exercises the
// real SQL paths (table creation, PK constraint, auto-window row
// replacement, legacy backfill) that the mocked suite cannot reach.
let realDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!realDb) throw new Error('test db not initialized');
    return realDb;
  },
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  renewTrainingPlanGenerationIdempotencyLease,
} from '../../src/services/training-plan-generation-idempotency';
import type { TrainingPlanGenerationLeaseIdentity } from '../../src/services/training-plan-generation-idempotency';

const TABLE = 'training_plan_generation_idempotency_scoped';

function rowFor(userId: number, tenantId: number, key: string): any {
  return realDb.prepare(
    `SELECT * FROM ${TABLE} WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?`,
  ).get(userId, tenantId, key);
}

function ownedClaim(claim: ReturnType<typeof claimTrainingPlanGenerationIdempotency>): TrainingPlanGenerationLeaseIdentity {
  expect(claim.kind).toBe('claimed');
  if (claim.kind !== 'claimed') throw new Error('expected owned claim');
  return claim;
}

describe('training plan generation idempotency — real SQLite', () => {
  beforeEach(() => {
    realDb = new Database(':memory:');
  });

  afterEach(() => {
    vi.useRealTimers();
    realDb.close();
  });

  it('claims a fresh key and persists a real in_progress row', () => {
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(7, 7, 'key-fresh', 'hash-a'));
    expect(claim).toMatchObject({
      kind: 'claimed',
      idempotencyKey: 'key-fresh',
      requestHash: 'hash-a',
      leaseOwner: expect.any(String),
      fencingToken: expect.any(String),
    });

    const row = rowFor(7, 7, 'key-fresh');
    expect(row).toMatchObject({
      status: 'in_progress',
      request_hash: 'hash-a',
      lease_owner: claim.leaseOwner,
      fencing_token: claim.fencingToken,
      lease_expires_at: expect.any(String),
      heartbeat_at: expect.any(String),
      attempt_count: 1,
    });
  });

  it('returns in_progress for repeated same-hash claims while the first is running', () => {
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-race', 'hash-a');
    const repeats = Array.from({ length: 10 }, () =>
      claimTrainingPlanGenerationIdempotency(7, 7, 'key-race', 'hash-a'));
    expect(repeats.every((claim) => claim.kind === 'in_progress')).toBe(true);
    expect(realDb.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toMatchObject({ n: 1 });
  });

  it('returns conflict for a different request hash on the same key', () => {
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-conflict', 'hash-a');
    const conflict = claimTrainingPlanGenerationIdempotency(7, 7, 'key-conflict', 'hash-B');
    expect(conflict.kind).toBe('conflict');
  });

  it('replays the stored response after completion', () => {
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(7, 7, 'key-replay', 'hash-a'));
    completeTrainingPlanGenerationIdempotency(7, 7, claim, { planId: 42 }, 201);

    const replay = claimTrainingPlanGenerationIdempotency(7, 7, 'key-replay', 'hash-a');
    expect(replay).toEqual({
      kind: 'replay',
      idempotencyKey: 'key-replay',
      responseData: { planId: 42 },
      statusCode: 201,
    });
  });

  it('re-claims a failed row with the same hash and resets it to in_progress', () => {
    const claim = ownedClaim(claimTrainingPlanGenerationIdempotency(7, 7, 'key-failed', 'hash-a'));
    failTrainingPlanGenerationIdempotency(7, 7, claim);
    expect(rowFor(7, 7, 'key-failed')).toMatchObject({ status: 'failed' });

    const reclaim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-failed', 'hash-a');
    expect(reclaim.kind).toBe('claimed');
    expect(rowFor(7, 7, 'key-failed')).toMatchObject({ status: 'in_progress', response_json: null });
  });

  it('preserves a succeeded row with corrupted response JSON for reconciliation', () => {
    // Stronger guarantee: unreadable replay data is not proof that plan
    // persistence failed. Reclaiming this receipt could create a second plan,
    // so the succeeded row remains immutable and the caller is blocked.
    const initialClaim = ownedClaim(claimTrainingPlanGenerationIdempotency(7, 7, 'key-corrupt', 'hash-a'));
    completeTrainingPlanGenerationIdempotency(7, 7, initialClaim, { planId: 1 }, 201);
    realDb.prepare(`UPDATE ${TABLE} SET response_json = '{not-json' WHERE idempotency_key = ?`)
      .run('key-corrupt');

    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-corrupt', 'hash-a');
    expect(claim.kind).toBe('reconciliation_required');

    const row = realDb.prepare(`SELECT status, response_json, last_error_code, attempt_count FROM ${TABLE} WHERE idempotency_key = ?`)
      .get('key-corrupt') as { status: string; response_json: string; last_error_code: string | null; attempt_count: number };
    expect(row).toEqual({
      status: 'succeeded',
      response_json: '{not-json',
      last_error_code: null,
      attempt_count: 1,
    });
  });

  it('reclaims an in_progress claim whose lease has expired', () => {
    // The core F1 fix: a claim orphaned by a process death (OOM, SIGKILL,
    // deploy restart) never records an outcome, so without an expiry it stays
    // `in_progress` forever and the deterministic key 409s permanently.
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-orphaned', 'hash-a');
    realDb.prepare(`UPDATE ${TABLE} SET lease_expires_at = ? WHERE idempotency_key = ?`)
      .run('2020-01-01T00:00:00.000Z', 'key-orphaned');

    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-orphaned', 'hash-a');
    expect(claim.kind).toBe('claimed');
  });

  it('does NOT reclaim an in_progress claim whose lease is still live', () => {
    // The concurrent-duplicate guarantee the original design got right must
    // survive: a live attempt still blocks a second one.
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-live', 'hash-a');

    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-live', 'hash-a');
    expect(claim.kind).toBe('in_progress');
  });

  it('atomically gives an expired claim to exactly one connection and fences the stale owner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'training-generation-lease-'));
    const databasePath = join(directory, 'lease.sqlite');
    realDb.close();
    const firstConnection = new Database(databasePath);
    const secondConnection = new Database(databasePath);
    try {
      realDb = firstConnection;
      const staleClaim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-two-connection', 'hash-a');
      expect(staleClaim.kind).toBe('claimed');
      if (staleClaim.kind !== 'claimed') return;
      firstConnection.prepare(`UPDATE ${TABLE} SET lease_expires_at = ? WHERE idempotency_key = ?`)
        .run('2020-01-01T00:00:00.000Z', 'key-two-connection');

      realDb = secondConnection;
      const winner = claimTrainingPlanGenerationIdempotency(7, 7, 'key-two-connection', 'hash-a');
      expect(winner.kind).toBe('claimed');
      if (winner.kind !== 'claimed') return;

      realDb = firstConnection;
      expect(claimTrainingPlanGenerationIdempotency(7, 7, 'key-two-connection', 'hash-a'))
        .toEqual({ kind: 'in_progress', idempotencyKey: 'key-two-connection' });
      // Stronger F1 guarantee: matching request hashes are not ownership.
      // Once the fencing token changes, the stale process cannot publish a
      // success or overwrite the winner with a failure.
      expect(completeTrainingPlanGenerationIdempotency(
        7, 7, staleClaim, { planId: 41 }, 201,
      )).toBe(false);
      expect(failTrainingPlanGenerationIdempotency(
        7, 7, staleClaim, 'STALE_WORKER_FAILURE', 'retryable',
      )).toBe(false);
      expect(rowFor(7, 7, 'key-two-connection')).toMatchObject({
        status: 'in_progress',
        lease_owner: winner.leaseOwner,
        fencing_token: winner.fencingToken,
      });
    } finally {
      secondConnection.close();
      firstConnection.close();
      realDb = new Database(':memory:');
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('renews only a live owner and never resurrects an expired lease', () => {
    vi.useFakeTimers({ now: new Date('2026-07-01T10:00:00.000Z') });
    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-heartbeat', 'hash-a');
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') return;

    const initialExpiry = String(rowFor(7, 7, 'key-heartbeat').lease_expires_at);
    vi.setSystemTime(new Date('2026-07-01T10:05:00.000Z'));
    expect(renewTrainingPlanGenerationIdempotencyLease(7, 7, claim)).toBe(true);
    expect(Date.parse(rowFor(7, 7, 'key-heartbeat').lease_expires_at))
      .toBeGreaterThan(Date.parse(initialExpiry));

    realDb.prepare(`UPDATE ${TABLE} SET lease_expires_at = ? WHERE idempotency_key = ?`)
      .run('2026-07-01T10:04:59.000Z', 'key-heartbeat');
    expect(renewTrainingPlanGenerationIdempotencyLease(7, 7, claim)).toBe(false);
  });

  it('never replaces a stale successful auto-key receipt after the 90s window', () => {
    vi.useFakeTimers({ now: new Date('2026-07-01T10:00:00.000Z') });
    const initialClaim = ownedClaim(claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-a'));
    completeTrainingPlanGenerationIdempotency(7, 7, initialClaim, { planId: 1 }, 201);

    // Inside the window a different hash is still a conflict.
    vi.setSystemTime(new Date('2026-07-01T10:01:00.000Z'));
    expect(claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-B').kind).toBe('conflict');

    // Stronger guarantee: time passing cannot convert a successful receipt
    // into authority to mutate a second plan, even for an automatic key.
    vi.setSystemTime(new Date('2026-07-01T10:02:00.000Z'));
    const reclaim = claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-B');
    expect(reclaim.kind).toBe('conflict');
    expect(rowFor(7, 7, 'auto:draft-1')).toMatchObject({ status: 'succeeded', request_hash: 'hash-a' });
  });

  it('scopes rows by tenant so identical keys do not collide across tenants', () => {
    const tenantOne = claimTrainingPlanGenerationIdempotency(7, 1, 'key-shared', 'hash-a');
    const tenantTwo = claimTrainingPlanGenerationIdempotency(7, 2, 'key-shared', 'hash-a');
    expect(tenantOne.kind).toBe('claimed');
    expect(tenantTwo.kind).toBe('claimed');
    expect(realDb.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toMatchObject({ n: 2 });
  });

  it('backfills replayable rows from the legacy table on first touch', () => {
    realDb.exec(`
      CREATE TABLE training_plan_generation_idempotency (
        user_id INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        response_json TEXT,
        status_code INTEGER,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (user_id, idempotency_key)
      );
      INSERT INTO training_plan_generation_idempotency
        (user_id, idempotency_key, request_hash, status, response_json, status_code, created_at, updated_at)
      VALUES
        (7, 'key-legacy', 'hash-a', 'succeeded', '{"planId":99}', 201, '2026-06-01 10:00:00', '2026-06-01 10:00:00');
    `);

    const replay = claimTrainingPlanGenerationIdempotency(7, 7, 'key-legacy', 'hash-a');
    expect(replay).toEqual({
      kind: 'replay',
      idempotencyKey: 'key-legacy',
      responseData: { planId: 99 },
      statusCode: 201,
    });
  });

});
