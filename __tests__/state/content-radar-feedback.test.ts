/**
 * CONTENT-UI-O2 (2026-05-04): per-signal Radar feedback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  recordRadarFeedback,
  revokeRadarFeedback,
  listRadarFeedback,
  radarFeedbackAggregateBySignal,
  isValidRadarFeedbackAction,
} from '../../src/state/content-radar-feedback';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch (err) {
        // Some migrations have FK deps not relevant to this test; skip.
      }
    }
  }
}

const USER_A = 2001;
const USER_B = 2002;

describe('content-radar-feedback (CONTENT-UI-O2)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });
  afterEach(() => { if (testDb) testDb.close(); });

  // ──────── action validation ────────

  it('isValidRadarFeedbackAction recognizes the 4 canonical actions', () => {
    expect(isValidRadarFeedbackAction('accept')).toBe(true);
    expect(isValidRadarFeedbackAction('reject')).toBe(true);
    expect(isValidRadarFeedbackAction('save')).toBe(true);
    expect(isValidRadarFeedbackAction('create_brief')).toBe(true);
  });

  it('isValidRadarFeedbackAction rejects unknown values', () => {
    expect(isValidRadarFeedbackAction('approve')).toBe(false);
    expect(isValidRadarFeedbackAction('')).toBe(false);
    expect(isValidRadarFeedbackAction(null as any)).toBe(false);
    expect(isValidRadarFeedbackAction(42 as any)).toBe(false);
  });

  it('throws when action is invalid', () => {
    expect(() => recordRadarFeedback(USER_A, USER_A, {
      signalId: 's-1', action: 'fake' as any,
    })).toThrow();
  });

  it('throws when signalId is empty', () => {
    expect(() => recordRadarFeedback(USER_A, USER_A, {
      signalId: '   ', action: 'accept',
    })).toThrow();
  });

  // ──────── round-trip ────────

  it('records and reads back a single feedback row', () => {
    const rec = recordRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-1',
      action: 'accept',
      reason: 'matches my pillar',
      signalTopic: 'AI tutorials',
      signalSummary: 'Trending on LinkedIn this week',
    });
    expect(rec.signalId).toBe('sig-1');
    expect(rec.action).toBe('accept');
    expect(rec.reason).toBe('matches my pillar');
    expect(rec.signalTopic).toBe('AI tutorials');

    const list = listRadarFeedback(USER_A, USER_A);
    expect(list).toHaveLength(1);
    expect(list[0].signalId).toBe('sig-1');
  });

  it('keeps one active feedback row per signal/action and updates snapshots on retry', () => {
    const first = recordRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-2',
      action: 'save',
      reason: 'first tap',
    });
    const second = recordRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-2',
      action: 'save',
      reason: 'retry with updated reason',
    });

    expect(second.id).toBe(first.id);
    const rows = listRadarFeedback(USER_A, USER_A, { signalId: 'sig-2' });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('retry with updated reason');
  });

  // ──────── filters ────────

  it('list filters by signalId', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-A', action: 'accept' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-B', action: 'reject' });
    const aOnly = listRadarFeedback(USER_A, USER_A, { signalId: 'sig-A' });
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].signalId).toBe('sig-A');
  });

  it('list filters by action', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-A', action: 'accept' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-B', action: 'reject' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-C', action: 'reject' });
    const rejects = listRadarFeedback(USER_A, USER_A, { action: 'reject' });
    expect(rejects).toHaveLength(2);
  });

  // ──────── tenant isolation ────────

  it('feedback by User A is invisible to User B', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-1', action: 'reject' });
    recordRadarFeedback(USER_B, USER_B, { signalId: 'sig-1', action: 'accept' });
    const a = listRadarFeedback(USER_A, USER_A, { signalId: 'sig-1' });
    const b = listRadarFeedback(USER_B, USER_B, { signalId: 'sig-1' });
    expect(a).toHaveLength(1);
    expect(a[0].action).toBe('reject');
    expect(b).toHaveLength(1);
    expect(b[0].action).toBe('accept');
  });

  it('aggregate counts by signal are scoped per user', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-X', action: 'reject' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-X', action: 'reject' });
    recordRadarFeedback(USER_B, USER_B, { signalId: 'sig-X', action: 'accept' });
    expect(radarFeedbackAggregateBySignal(USER_A, USER_A)['sig-X']).toEqual({ reject: 1 });
    expect(radarFeedbackAggregateBySignal(USER_B, USER_B)['sig-X']).toEqual({ accept: 1 });
  });

  it('revokes active feedback without deleting other actions for the same signal', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-revoke', action: 'reject' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-revoke', action: 'save' });

    expect(revokeRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-revoke',
      action: 'reject',
    })).toBe(1);

    const active = listRadarFeedback(USER_A, USER_A, { signalId: 'sig-revoke' });
    expect(active).toHaveLength(1);
    expect(active[0].action).toBe('save');
    expect(radarFeedbackAggregateBySignal(USER_A, USER_A)['sig-revoke']).toEqual({ save: 1 });
  });

  it('can recreate feedback after revoke', () => {
    const first = recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-again', action: 'accept' });
    expect(revokeRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-again',
      action: 'accept',
    })).toBe(1);
    const second = recordRadarFeedback(USER_A, USER_A, { signalId: 'sig-again', action: 'accept' });

    expect(second.id).not.toBe(first.id);
    expect(listRadarFeedback(USER_A, USER_A, { signalId: 'sig-again' })).toHaveLength(1);
  });

  // ──────── safety ────────

  it('caps reason and summary to defensive lengths', () => {
    const big = 'x'.repeat(5000);
    const rec = recordRadarFeedback(USER_A, USER_A, {
      signalId: 'sig-cap',
      action: 'save',
      reason: big,
      signalSummary: big,
    });
    // reason ≤ 600, summary ≤ 600
    expect(rec.reason!.length).toBeLessThanOrEqual(600);
    expect(rec.signalSummary!.length).toBeLessThanOrEqual(600);
  });

  it('rejects invalid userId', () => {
    expect(() => recordRadarFeedback(0, 1, { signalId: 's', action: 'accept' })).toThrow();
    expect(() => recordRadarFeedback(-5, 1, { signalId: 's', action: 'accept' })).toThrow();
  });

  it('list returns [] for invalid userId', () => {
    expect(listRadarFeedback(0)).toEqual([]);
    expect(listRadarFeedback(-1)).toEqual([]);
  });
});
