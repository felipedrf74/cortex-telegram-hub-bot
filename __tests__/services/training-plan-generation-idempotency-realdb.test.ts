import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  claimTrainingPlanGenerationIdempotency,
  completeTrainingPlanGenerationIdempotency,
  failTrainingPlanGenerationIdempotency,
  clearTrainingPlanGenerationIdempotency,
} from '../../src/services/training-plan-generation-idempotency';

const TABLE = 'training_plan_generation_idempotency_scoped';

function rowFor(userId: number, tenantId: number, key: string): any {
  return realDb.prepare(
    `SELECT * FROM ${TABLE} WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?`,
  ).get(userId, tenantId, key);
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
    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-fresh', 'hash-a');
    expect(claim).toEqual({ kind: 'claimed', idempotencyKey: 'key-fresh', requestHash: 'hash-a' });

    const row = rowFor(7, 7, 'key-fresh');
    expect(row).toMatchObject({ status: 'in_progress', request_hash: 'hash-a' });
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
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-replay', 'hash-a');
    completeTrainingPlanGenerationIdempotency(7, 7, 'key-replay', 'hash-a', { planId: 42 }, 201);

    const replay = claimTrainingPlanGenerationIdempotency(7, 7, 'key-replay', 'hash-a');
    expect(replay).toEqual({
      kind: 'replay',
      idempotencyKey: 'key-replay',
      responseData: { planId: 42 },
      statusCode: 201,
    });
  });

  it('re-claims a failed row with the same hash and resets it to in_progress', () => {
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-failed', 'hash-a');
    failTrainingPlanGenerationIdempotency(7, 7, 'key-failed', 'hash-a');
    expect(rowFor(7, 7, 'key-failed')).toMatchObject({ status: 'failed' });

    const reclaim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-failed', 'hash-a');
    expect(reclaim.kind).toBe('claimed');
    expect(rowFor(7, 7, 'key-failed')).toMatchObject({ status: 'in_progress', response_json: null });
  });

  it('treats a succeeded row with corrupted response JSON as in_progress instead of crashing', () => {
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-corrupt', 'hash-a');
    completeTrainingPlanGenerationIdempotency(7, 7, 'key-corrupt', 'hash-a', { planId: 1 }, 201);
    realDb.prepare(`UPDATE ${TABLE} SET response_json = '{not-json' WHERE idempotency_key = ?`)
      .run('key-corrupt');

    const claim = claimTrainingPlanGenerationIdempotency(7, 7, 'key-corrupt', 'hash-a');
    expect(claim.kind).toBe('in_progress');
  });

  it('replaces a stale auto-key row after the 90s window and claims fresh', () => {
    vi.useFakeTimers({ now: new Date('2026-07-01T10:00:00.000Z') });
    claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-a');
    completeTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-a', { planId: 1 }, 201);

    // Inside the window a different hash is still a conflict.
    vi.setSystemTime(new Date('2026-07-01T10:01:00.000Z'));
    expect(claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-B').kind).toBe('conflict');

    // Past the window the auto row is replaced and re-claimed.
    vi.setSystemTime(new Date('2026-07-01T10:02:00.000Z'));
    const reclaim = claimTrainingPlanGenerationIdempotency(7, 7, 'auto:draft-1', 'hash-B');
    expect(reclaim.kind).toBe('claimed');
    expect(rowFor(7, 7, 'auto:draft-1')).toMatchObject({ status: 'in_progress', request_hash: 'hash-B' });
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

  it('clears rows by key and optional hash', () => {
    claimTrainingPlanGenerationIdempotency(7, 7, 'key-clear', 'hash-a');
    expect(clearTrainingPlanGenerationIdempotency(7, 7, 'key-clear', 'hash-other')).toBe(0);
    expect(clearTrainingPlanGenerationIdempotency(7, 7, 'key-clear', 'hash-a')).toBe(1);
    expect(rowFor(7, 7, 'key-clear')).toBeUndefined();
  });
});
