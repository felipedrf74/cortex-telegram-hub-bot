import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionFilterFingerprint, type DecisionRankTuple } from '../../src/services/decision-center/cursor';
import {
  DecisionRankSnapshotRepository,
} from '../../src/services/decision-center/rank-snapshot-repository';

const SCOPE = { userId: 11, tenantId: 101 } as const;
const OTHER_TENANT_SCOPE = { userId: 11, tenantId: 202 } as const;
const OTHER_USER_SCOPE = { userId: 22, tenantId: 101 } as const;
const FILTER_FINGERPRINT = decisionFilterFingerprint({ status: ['unread'], sourceSkill: 'secretary' });
const RANKING_AS_OF = '2026-08-30T09:00:00.000Z';

let db: Database.Database;
let now: Date;
let nextSnapshot: number;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE decision_center_rank_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      ranking_as_of TEXT NOT NULL,
      ranking_version INTEGER NOT NULL,
      filter_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      entry_count INTEGER NOT NULL
    );
    CREATE TABLE decision_center_rank_snapshot_entries (
      snapshot_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      decision_id TEXT NOT NULL,
      priority_tier TEXT NOT NULL,
      priority_score REAL NOT NULL,
      decision_created_at TEXT NOT NULL,
      projection_json TEXT,
      PRIMARY KEY (snapshot_id, ordinal),
      UNIQUE (snapshot_id, decision_id),
      FOREIGN KEY (snapshot_id) REFERENCES decision_center_rank_snapshots(snapshot_id) ON DELETE CASCADE
    );
    CREATE TABLE live_decision_ranks (
      decision_id TEXT PRIMARY KEY,
      priority_score REAL NOT NULL
    );
  `);
}

function repository(): DecisionRankSnapshotRepository {
  return new DecisionRankSnapshotRepository(db, {
    now: () => new Date(now),
    createSnapshotId: () => `snapshot_${nextSnapshot++}`,
  });
}

function rank(decisionId: string, priorityScore: number, minute: number): DecisionRankTuple {
  return {
    priorityTier: priorityScore >= 90 ? 'critical' : priorityScore >= 70 ? 'high' : 'normal',
    priorityScore,
    createdAt: `2026-08-30T08:${String(minute).padStart(2, '0')}:00.000Z`,
    decisionId,
  };
}

function createSnapshot(repo: DecisionRankSnapshotRepository, scope = SCOPE, ranks = [
  rank('decision_a', 95, 59),
  rank('decision_b', 82, 58),
  rank('decision_c', 68, 57),
  rank('decision_d', 55, 56),
]) {
  return repo.createSnapshot({
    scope,
    rankingAsOf: RANKING_AS_OF,
    rankingVersion: 3,
    filterFingerprint: FILTER_FINGERPRINT,
    expiresAt: '2026-08-30T10:00:00.000Z',
    ranks,
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  now = new Date('2026-08-30T09:00:00.000Z');
  nextSnapshot = 1;
});

afterEach(() => db.close());

describe('DecisionRankSnapshotRepository', () => {
  it('persists immutable ordinals and keeps pagination stable while live ranks change', () => {
    db.exec(`
      INSERT INTO live_decision_ranks VALUES ('decision_a', 95), ('decision_b', 82), ('decision_c', 68), ('decision_d', 55);
    `);
    const repo = repository();
    const snapshot = createSnapshot(repo);
    const first = repo.readPage({ scope: SCOPE, binding: snapshot.binding, limit: 2 });

    expect(first.ranks.map((entry) => entry.decisionId)).toEqual(['decision_a', 'decision_b']);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursorRank).toEqual(first.ranks[1]);

    // A live rerank reverses the source order after page one. Snapshot page two stays frozen.
    db.exec(`
      UPDATE live_decision_ranks SET priority_score = CASE decision_id
        WHEN 'decision_a' THEN 10 WHEN 'decision_b' THEN 20 WHEN 'decision_c' THEN 90 ELSE 100 END;
    `);
    const reopened = repository();
    const second = reopened.readPage({
      scope: SCOPE,
      binding: snapshot.binding,
      after: first.nextCursorRank,
      limit: 2,
    });

    expect(second.ranks.map((entry) => entry.decisionId)).toEqual(['decision_c', 'decision_d']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursorRank).toBeNull();
    expect([...first.ranks, ...second.ranks].map((entry) => entry.decisionId))
      .toEqual(['decision_a', 'decision_b', 'decision_c', 'decision_d']);
  });

  it('persists scope on both snapshot metadata and every ordered rank tuple', () => {
    const snapshot = createSnapshot(repository());
    const metadata = db.prepare(`
      SELECT user_id, tenant_id, entry_count FROM decision_center_rank_snapshots WHERE snapshot_id = ?
    `).get(snapshot.binding.snapshotId);
    const entries = db.prepare(`
      SELECT user_id, tenant_id, ordinal, decision_id
        FROM decision_center_rank_snapshot_entries
       WHERE snapshot_id = ? ORDER BY ordinal
    `).all(snapshot.binding.snapshotId);

    expect(metadata).toEqual({ user_id: 11, tenant_id: 101, entry_count: 4 });
    expect(entries).toEqual([
      { user_id: 11, tenant_id: 101, ordinal: 0, decision_id: 'decision_a' },
      { user_id: 11, tenant_id: 101, ordinal: 1, decision_id: 'decision_b' },
      { user_id: 11, tenant_id: 101, ordinal: 2, decision_id: 'decision_c' },
      { user_id: 11, tenant_id: 101, ordinal: 3, decision_id: 'decision_d' },
    ]);
  });

  it.each([
    ['tenant', OTHER_TENANT_SCOPE],
    ['user', OTHER_USER_SCOPE],
  ] as const)('rejects cross-%s snapshot access without returning rank tuples', (_boundary, scope) => {
    const repo = repository();
    const snapshot = createSnapshot(repo);

    expect(() => repo.readPage({ scope, binding: snapshot.binding, limit: 20 })).toThrow(expect.objectContaining({
      code: 'DECISION_SCOPE_INVALID',
      status: 403,
      details: { reason: 'snapshot_scope' },
    }));
  });

  it('rejects missing and expired snapshots with typed stale-cursor errors', () => {
    const repo = repository();
    const snapshot = createSnapshot(repo);
    const missingBinding = { ...snapshot.binding, snapshotId: 'snapshot_missing' };

    expect(() => repo.readPage({ scope: SCOPE, binding: missingBinding, limit: 20 })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'snapshot_missing' },
    }));

    now = new Date('2026-08-30T10:00:00.000Z');
    expect(() => repo.readPage({ scope: SCOPE, binding: snapshot.binding, limit: 20 })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'snapshot_expired' },
    }));
  });

  it('binds reads to the persisted filter fingerprint, ranking version, and ranking instant', () => {
    const repo = repository();
    const snapshot = createSnapshot(repo);
    const cases = [
      [{ ...snapshot.binding, filterFingerprint: decisionFilterFingerprint({ status: ['all'] }) }, 'filters'],
      [{ ...snapshot.binding, rankingVersion: 4 }, 'ranking_version'],
      [{ ...snapshot.binding, rankingAsOf: '2026-08-30T09:01:00.000Z' }, 'ranking_as_of'],
    ] as const;

    for (const [binding, reason] of cases) {
      expect(() => repo.readPage({ scope: SCOPE, binding, limit: 20 })).toThrow(expect.objectContaining({
        code: 'DECISION_CURSOR_STALE',
        status: 409,
        details: { reason },
      }));
    }
  });

  it('rejects a cursor rank tuple that was changed or did not belong to the snapshot', () => {
    const repo = repository();
    const snapshot = createSnapshot(repo);

    expect(() => repo.readPage({
      scope: SCOPE,
      binding: snapshot.binding,
      after: { ...rank('decision_b', 82, 58), priorityScore: 999 },
      limit: 2,
    })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'rank_tuple' },
    }));
  });

  it('does not create or repair its own schema', () => {
    const emptyDb = new Database(':memory:');
    try {
      const repo = new DecisionRankSnapshotRepository(emptyDb, {
        now: () => new Date(now),
        createSnapshotId: () => 'snapshot_without_schema',
      });
      expect(() => createSnapshot(repo)).toThrow(/no such table: decision_center_rank_snapshots/);
      expect(emptyDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).toEqual([]);
    } finally {
      emptyDb.close();
    }
  });
});
