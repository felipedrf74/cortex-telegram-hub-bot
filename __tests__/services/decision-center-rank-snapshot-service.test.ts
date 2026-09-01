import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionApiItem } from '../../src/services/decision-center';
import {
  materializeDecisionRankSnapshot,
  readDecisionRankSnapshotPage,
} from '../../src/services/decision-center/rank-snapshot-service';

const SCOPE = { userId: 7, tenantId: 17 } as const;
const FIRST_AT = new Date('2026-08-30T09:00:00.000Z');
let db: Database.Database;

function createSchema(): void {
  db.exec(`
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
      UNIQUE (snapshot_id, decision_id)
    );
  `);
}

function item(
  decisionId: string,
  priorityScore: number,
  sourceSkill = 'secretary',
  status = 'unread',
): DecisionApiItem {
  return {
    decisionId,
    sourceSkill,
    type: 'decision_required',
    status,
    urgency: priorityScore >= 80 ? 'urgent' : 'today',
    timingLabel: null,
    priorityScore,
    prioritySnapshot: {
      priorityTier: priorityScore >= 80 ? 'critical' : 'normal',
      priorityScore,
      reasonCodes: [],
      computedAt: FIRST_AT.toISOString(),
      rankingVersion: 1,
    },
    safePreviewTitle: `Decision ${decisionId}`,
    safePreviewBody: 'Privacy-safe summary.',
    recommendedActionLabel: 'Review',
    primaryActionLabel: 'Review',
    deadlineAt: null,
    expiresAt: null,
    badgeContribution: true,
    confidence: 0.8,
    requiredPermissions: [],
    approvalLevel: 'user_confirmation',
    reviewSupported: true,
    editableProposalFields: [],
    execution: { status: 'not_started', effects: [], recoveryActions: [] },
    refreshSupported: true,
    recordVersion: 1,
    decisionState: 'ready_for_review',
    groupKey: sourceSkill,
    sectionKey: 'today',
    displayMode: 'decision',
    frontendActionState: 'enabled',
    impactLevel: 'medium',
    analysis: { whyNow: 'Now', costOfDelay: 'Later is worse' },
    alternativeActions: [],
    createdAt: new Date(FIRST_AT.getTime() - priorityScore * 1_000).toISOString(),
  } as unknown as DecisionApiItem;
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema();
});

afterEach(() => db.close());

describe('Decision rank snapshot paging service', () => {
  it('keeps page two on the original immutable order after a newer rerank exists', () => {
    materializeDecisionRankSnapshot({
      db,
      scope: SCOPE,
      items: [item('a', 95), item('b', 85), item('c', 75), item('d', 65)],
      rankingVersion: 1,
      now: FIRST_AT,
    });
    const first = readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      pageSize: 2,
      now: FIRST_AT,
    });
    expect(first.kind).toBe('snapshot');
    if (first.kind !== 'snapshot') throw new Error('snapshot expected');
    expect(first.cards.map((card) => card.decisionId)).toEqual(['a', 'b']);

    materializeDecisionRankSnapshot({
      db,
      scope: SCOPE,
      items: [item('d', 99), item('c', 98), item('b', 20), item('a', 10)],
      rankingVersion: 1,
      now: new Date('2026-08-30T09:01:00.000Z'),
    });
    const second = readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      cursorRaw: first.nextCursor!,
      pageSize: 2,
      now: new Date('2026-08-30T09:02:00.000Z'),
    });
    expect(second.kind).toBe('snapshot');
    if (second.kind !== 'snapshot') throw new Error('snapshot expected');
    expect(second.cards.map((card) => card.decisionId)).toEqual(['c', 'd']);
  });

  it('binds the cursor to filters and performs no writes while reading pages', () => {
    materializeDecisionRankSnapshot({
      db,
      scope: SCOPE,
      items: [item('secretary', 90), item('finance', 80, 'finance'), item('secretary_later', 70)],
      rankingVersion: 1,
      now: FIRST_AT,
    });
    const before = {
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM decision_center_rank_snapshots').get(),
      entries: db.prepare('SELECT COUNT(*) AS n FROM decision_center_rank_snapshot_entries').get(),
    };
    const first = readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: { sourceSkill: 'secretary' },
      pageSize: 1,
      now: FIRST_AT,
    });
    expect(first.kind).toBe('snapshot');
    const after = {
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM decision_center_rank_snapshots').get(),
      entries: db.prepare('SELECT COUNT(*) AS n FROM decision_center_rank_snapshot_entries').get(),
    };
    expect(after).toEqual(before);

    if (first.kind !== 'snapshot' || !first.nextCursor) throw new Error('snapshot cursor expected');
    expect(() => readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: { sourceSkill: 'finance' },
      cursorRaw: first.nextCursor!,
      pageSize: 1,
      now: FIRST_AT,
    })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'filters' },
    }));
  });

  it('rejects invalid page sizes and cursors from an older ranking policy', () => {
    materializeDecisionRankSnapshot({
      db,
      scope: SCOPE,
      items: [item('a', 95), item('b', 85)],
      rankingVersion: 1,
      now: FIRST_AT,
    });
    expect(() => readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      pageSize: 0,
      now: FIRST_AT,
    })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_MALFORMED',
      status: 400,
      details: { reason: 'page_size' },
    }));

    const first = readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      pageSize: 1,
      now: FIRST_AT,
    });
    if (first.kind !== 'snapshot' || !first.nextCursor) throw new Error('snapshot cursor expected');
    expect(() => readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 2,
      filters: {},
      cursorRaw: first.nextCursor,
      pageSize: 1,
      now: FIRST_AT,
    })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'ranking_version' },
    }));
  });

  it('returns a typed stale-cursor conflict when the referenced snapshot expired', () => {
    materializeDecisionRankSnapshot({
      db,
      scope: SCOPE,
      items: [item('a', 95), item('b', 85)],
      rankingVersion: 1,
      now: FIRST_AT,
      ttlMs: 60_000,
    });
    const first = readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      pageSize: 1,
      now: FIRST_AT,
    });
    if (first.kind !== 'snapshot' || !first.nextCursor) throw new Error('snapshot cursor expected');

    expect(() => readDecisionRankSnapshotPage({
      db,
      scope: SCOPE,
      rankingVersion: 1,
      filters: {},
      cursorRaw: first.nextCursor,
      pageSize: 1,
      now: new Date(FIRST_AT.getTime() + 60_001),
    })).toThrow(expect.objectContaining({
      code: 'DECISION_CURSOR_STALE',
      status: 409,
      details: { reason: 'snapshot_missing_or_expired' },
    }));
  });
});
