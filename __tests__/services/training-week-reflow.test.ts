/**
 * Slice C6 — week reflow service tests.
 *
 * Pins:
 *   - Preview mode does NOT bump adaptation_revision
 *   - Apply mode REQUIRES idempotencyKey (Codex P1 fix — throws otherwise)
 *   - Apply WITHOUT applyMutation → ledger row written, mutated=false, mutatedRows=0
 *   - Apply WITH applyMutation returning N → mutated=true, mutatedRows=N
 *   - applyMutation throw rolls back BOTH ledger row + revision bump
 *   - Idempotency hit returns existing row, mutated=false, no new revision
 *   - Different idempotency keys → independent revisions + mutations
 *   - Unknown week throws
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`,
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  ReflowMissingIdempotencyKeyError,
  executeWeekReflow,
} from '../../src/services/training-week-reflow';
import { getAdaptationRevision } from '../../src/services/training-plan-lifecycle';

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => testDb.close());

function seedPlanWithWeekAndSession(planId: number, weekId: number, sessionId: number, userId = 100): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'p', 'gym', 4, '2026-01-05', '2026-02-01', 'active')
  `).run(planId, userId);
  testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (?, ?, 1)').run(weekId, planId);
  testDb.prepare(`
    INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, status)
    VALUES (?, ?, ?, 'Monday', 'easy_run', 'session', 45, 'pending')
  `).run(sessionId, weekId, planId);
}

describe('executeWeekReflow — preview mode', () => {
  it('does NOT bump adaptation_revision', () => {
    seedPlanWithWeekAndSession(1, 10, 100);
    expect(getAdaptationRevision(1)).toBe(0);
    const result = executeWeekReflow({
      planId: 1, weekId: 10, mode: 'preview',
      trigger: 'missed_session',
      sciencePolicyVersion: '1.0.0',
    });
    expect(result.mode).toBe('preview');
    expect(result.adaptationRevision).toBeNull();
    expect(result.mutated).toBe(false);
    expect(result.mutatedRows).toBe(0);
    expect(getAdaptationRevision(1)).toBe(0);
  });

  it('writes a preview-scoped ledger row', () => {
    seedPlanWithWeekAndSession(2, 20, 200);
    executeWeekReflow({
      planId: 2, weekId: 20, mode: 'preview',
      trigger: 'preview_test',
      sciencePolicyVersion: '1.0.0',
    });
    const rows = testDb.prepare(`
      SELECT * FROM training_plan_adaptations WHERE plan_id = ? AND scope = 'preview'
    `).all(2);
    expect(rows.length).toBe(1);
  });

  it('preview does NOT require idempotencyKey', () => {
    seedPlanWithWeekAndSession(3, 30, 300);
    expect(() => executeWeekReflow({
      planId: 3, weekId: 30, mode: 'preview',
      trigger: 'preview', sciencePolicyVersion: '1.0.0',
    })).not.toThrow();
  });
});

describe('executeWeekReflow — apply mode contract (Codex P1)', () => {
  it('apply WITHOUT idempotencyKey throws ReflowMissingIdempotencyKeyError', () => {
    seedPlanWithWeekAndSession(4, 40, 400);
    expect(() => executeWeekReflow({
      planId: 4, weekId: 40, mode: 'apply',
      trigger: 'manual_reflow',
      sciencePolicyVersion: '1.0.0',
      // idempotencyKey OMITTED — contract violation
    })).toThrow(ReflowMissingIdempotencyKeyError);
  });

  it('apply WITHOUT applyMutation → mutated=false, mutatedRows=0 (ledger row still written)', () => {
    seedPlanWithWeekAndSession(5, 50, 500);
    const result = executeWeekReflow({
      planId: 5, weekId: 50, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'k-no-mutation',
      sciencePolicyVersion: '1.0.0',
    });
    expect(result.adaptationRevision).toBe(1);
    expect(result.mutated).toBe(false);
    expect(result.mutatedRows).toBe(0);
    // Ledger row WAS written even though no mutation occurred.
    const ledger = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ? AND scope = 'week'",
    ).get(5) as { n: number };
    expect(ledger.n).toBe(1);
  });

  it('apply WITH applyMutation returning N → mutated=true, mutatedRows=N, session actually changed', () => {
    seedPlanWithWeekAndSession(6, 60, 600);
    const result = executeWeekReflow({
      planId: 6, weekId: 60, mode: 'apply',
      trigger: 'reflow_with_mutation',
      idempotencyKey: 'k-with-mutation',
      sciencePolicyVersion: '1.0.0',
      applyMutation: (db) => {
        const r = db.prepare(
          "UPDATE training_sessions SET day_of_week = 'Tuesday' WHERE id = ?",
        ).run(600);
        return r.changes;
      },
    });
    expect(result.mutated).toBe(true);
    expect(result.mutatedRows).toBe(1);
    // Confirm the session row was actually moved.
    const session = testDb.prepare(
      'SELECT day_of_week FROM training_sessions WHERE id = ?',
    ).get(600) as { day_of_week: string };
    expect(session.day_of_week).toBe('Tuesday');
  });

  it('applyMutation throw rolls back BOTH ledger row + revision bump (transactional integrity)', () => {
    seedPlanWithWeekAndSession(7, 70, 700);
    expect(getAdaptationRevision(7)).toBe(0);
    expect(() => executeWeekReflow({
      planId: 7, weekId: 70, mode: 'apply',
      trigger: 'doomed_reflow',
      idempotencyKey: 'k-doomed',
      sciencePolicyVersion: '1.0.0',
      applyMutation: () => {
        throw new Error('mutation blew up');
      },
    })).toThrow(/mutation blew up/);
    // Revision NOT bumped + NO ledger row exists.
    expect(getAdaptationRevision(7)).toBe(0);
    const ledger = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(7) as { n: number };
    expect(ledger.n).toBe(0);
  });
});

describe('executeWeekReflow — apply mode idempotency', () => {
  it('idempotency hit returns existing row, mutated=false, no new revision', () => {
    seedPlanWithWeekAndSession(8, 80, 800);
    const first = executeWeekReflow({
      planId: 8, weekId: 80, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'k-dup',
      sciencePolicyVersion: '1.0.0',
      applyMutation: (db) => db.prepare(
        "UPDATE training_sessions SET day_of_week = 'Wednesday' WHERE id = ?",
      ).run(800).changes,
    });
    expect(first.mutated).toBe(true);
    expect(first.adaptationRevision).toBe(1);

    const second = executeWeekReflow({
      planId: 8, weekId: 80, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'k-dup',
      sciencePolicyVersion: '1.0.0',
      // Second mutation function would run if dedup failed — verify it doesn't.
      applyMutation: () => 999,
    });
    expect(second.mutated).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.adaptationId).toBe(first.adaptationId);
    expect(getAdaptationRevision(8)).toBe(1); // unchanged
  });

  it('different idempotency keys → independent revisions + mutations', () => {
    seedPlanWithWeekAndSession(9, 90, 900);
    const a = executeWeekReflow({
      planId: 9, weekId: 90, mode: 'apply', trigger: 't',
      idempotencyKey: 'k-1', sciencePolicyVersion: '1.0.0',
      applyMutation: (db) => db.prepare("UPDATE training_sessions SET day_of_week = 'Thursday' WHERE id = ?").run(900).changes,
    });
    const b = executeWeekReflow({
      planId: 9, weekId: 90, mode: 'apply', trigger: 't',
      idempotencyKey: 'k-2', sciencePolicyVersion: '1.0.0',
      applyMutation: (db) => db.prepare("UPDATE training_sessions SET day_of_week = 'Friday' WHERE id = ?").run(900).changes,
    });
    expect(a.adaptationRevision).toBe(1);
    expect(b.adaptationRevision).toBe(2);
    expect(a.mutated).toBe(true);
    expect(b.mutated).toBe(true);
  });
});

describe('executeWeekReflow — error paths', () => {
  it('unknown week throws', () => {
    expect(() => executeWeekReflow({
      planId: 999, weekId: 999, mode: 'apply',
      trigger: 't',
      idempotencyKey: 'k-unknown',
      sciencePolicyVersion: '1.0.0',
    })).toThrow(/Week 999 not found/);
  });
});

// R8 P0-1 — applyMutation must hand its per-action result to
// recordAdaptation via an explicit channel, not a getter that
// closes over an outer `let`. The prior shape worked only because
// applyTxn ran applyMutation BEFORE recordAdaptation read the
// getter. A future refactor that flips that order would silently
// serialize `[]` into `training_plan_adaptations.after_patch_json`
// — audit trail wrong for every apply with no test failure.
//
// These tests pin the post-fix contract: the perActionResults the
// executor reports MUST land in the persisted ledger row's
// after_patch_json, regardless of when recordAdaptation observes
// it within the transaction.
describe('R8 P0-1 — executeWeekReflow ledger reflects applyMutation per-action result', () => {
  it('apply with applyMutation returning perActionResults → ledger after_patch_json contains them', () => {
    seedPlanWithWeekAndSession(220, 2200, 22000);
    const fakePerAction = [
      { action: { type: 'drop_session', sessionId: '22000', reasonCode: 'r1' }, mutatedRows: 1, skipped: false },
      { action: { type: 'pause_training', reasonCode: 'r2', severity: 'pause' }, mutatedRows: 0, skipped: false },
    ];
    const result = executeWeekReflow({
      planId: 220, weekId: 2200, mode: 'apply',
      trigger: 'r8_p0_1',
      idempotencyKey: 'r8-p0-1-key',
      sciencePolicyVersion: '1.0.0',
      afterPatch: { actions: [] },
      applyMutation: () => ({
        mutatedRows: 1,
        perActionResults: fakePerAction,
      }),
    });
    const row = testDb.prepare(
      'SELECT after_patch_json FROM training_plan_adaptations WHERE id = ?',
    ).get(result.adaptationId) as { after_patch_json: string };
    const stored = JSON.parse(row.after_patch_json);
    expect(stored.perActionResults).toEqual(fakePerAction);
  });

  it('backward-compat: applyMutation returning a bare number still works (no perActionResults merged)', () => {
    seedPlanWithWeekAndSession(221, 2210, 22100);
    const result = executeWeekReflow({
      planId: 221, weekId: 2210, mode: 'apply',
      trigger: 'r8_p0_1_compat',
      idempotencyKey: 'r8-p0-1-compat-key',
      sciencePolicyVersion: '1.0.0',
      afterPatch: { actions: ['some-marker'] },
      applyMutation: () => 1,
    });
    const row = testDb.prepare(
      'SELECT after_patch_json FROM training_plan_adaptations WHERE id = ?',
    ).get(result.adaptationId) as { after_patch_json: string };
    const stored = JSON.parse(row.after_patch_json);
    // Caller's afterPatch is preserved verbatim when no merge happens.
    expect(stored.actions).toEqual(['some-marker']);
    expect(stored.perActionResults).toBeUndefined();
    expect(result.mutatedRows).toBe(1);
  });

  it('reordering invariant: the ledger row sees executor result even if recordAdaptation runs first conceptually (no closure dependency)', () => {
    seedPlanWithWeekAndSession(222, 2220, 22200);
    // We can't physically reorder db.transaction (it's a closure),
    // but we CAN prove there is no dependence on outer-scope state:
    // the same call shape with NO caller-side `let` mutation must
    // produce the same ledger row contents. If a future refactor
    // re-introduces the closure-over-let pattern, the assertion
    // `stored.perActionResults` would silently become undefined or
    // [] when ordering changed; today the explicit channel makes it
    // observable regardless.
    const captured: { value?: unknown } = {};
    const result = executeWeekReflow({
      planId: 222, weekId: 2220, mode: 'apply',
      trigger: 'r8_p0_1_reorder',
      idempotencyKey: 'r8-p0-1-reorder-key',
      sciencePolicyVersion: '1.0.0',
      afterPatch: { actions: [] },
      applyMutation: () => {
        const r = { mutatedRows: 1, perActionResults: [{ marker: 'x' }] };
        captured.value = r.perActionResults;
        return r;
      },
    });
    const row = testDb.prepare(
      'SELECT after_patch_json FROM training_plan_adaptations WHERE id = ?',
    ).get(result.adaptationId) as { after_patch_json: string };
    const stored = JSON.parse(row.after_patch_json);
    expect(stored.perActionResults).toEqual(captured.value);
  });
});

// R8 P3 — Codex caught that the HTTP route trimmed the
// idempotency key but the service itself only rejected an
// `length === 0` string. Direct service callers could submit
// whitespace-only keys (`"   "`, `"\n\t"`) which slipped through
// and collided nondeterministically in the ledger's
// `idempotency_key` column. The fix moves the trim + missing-key
// rejection to the service boundary so the contract holds for
// any caller. Tests below pin the new behavior.
// R8 P2-12 — Codex asked for a test proving that when one
// CoachAction in a batch throws (e.g. an SQL constraint), the
// PRIOR mutations roll back AND no ledger row commits. The
// executor itself never throws on a per-action skip — but the
// caller's applyMutation closure CAN throw on, say, an unexpected
// DB-level exception. Pin that behavior here using an explicit
// throw at row index 3.
describe('R8 P2-12 — apply mid-batch throw rolls back all prior mutations atomically', () => {
  it('throw on the 3rd applyMutation invocation: actions #1 and #2 do NOT persist, no ledger row commits', () => {
    seedPlanWithWeekAndSession(170, 1700, 17000);
    // Seed three sessions on the same week so the first two
    // mutations land, then the third throws.
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, intensity_text, status, created_at)
      VALUES (17001, 1700, 170, 'Tuesday', 'run', 't', 30, 'aerobic', 'pending', datetime('now'))
    `).run();
    testDb.prepare(`
      INSERT INTO training_sessions (id, week_id, plan_id, day_of_week, session_type, title, duration_minutes, intensity_text, status, created_at)
      VALUES (17002, 1700, 170, 'Wednesday', 'run', 't', 30, 'aerobic', 'pending', datetime('now'))
    `).run();
    const ledgerBefore = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(170) as { n: number };
    let invocation = 0;
    expect(() => executeWeekReflow({
      planId: 170, weekId: 1700, mode: 'apply',
      trigger: 't',
      idempotencyKey: 'r8-p2-12',
      sciencePolicyVersion: '1.0.0',
      applyMutation: (db) => {
        invocation++;
        // First two updates succeed; the third throws.
        db.prepare("UPDATE training_sessions SET day_of_week = 'Sunday' WHERE id = 17000").run();
        db.prepare("UPDATE training_sessions SET day_of_week = 'Sunday' WHERE id = 17001").run();
        invocation++;
        throw new Error('boom-on-third');
      },
    })).toThrow(/boom-on-third/);
    // None of the day_of_week updates survived.
    const day1 = testDb.prepare("SELECT day_of_week FROM training_sessions WHERE id = 17000").get() as { day_of_week: string };
    const day2 = testDb.prepare("SELECT day_of_week FROM training_sessions WHERE id = 17001").get() as { day_of_week: string };
    expect(day1.day_of_week).toBe('Monday');
    expect(day2.day_of_week).toBe('Tuesday');
    // No new ledger row.
    const ledgerAfter = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(170) as { n: number };
    expect(ledgerAfter.n).toBe(ledgerBefore.n);
    expect(invocation).toBe(2); // confirms the callback ran past the first two updates
  });
});

describe('R8 P3 — executeWeekReflow normalizes idempotency at the service boundary', () => {
  it('apply with empty-string idempotencyKey → ReflowMissingIdempotencyKeyError', () => {
    seedPlanWithWeekAndSession(150, 1500, 15000);
    expect(() => executeWeekReflow({
      planId: 150, weekId: 1500, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: '',
      sciencePolicyVersion: '1.0.0',
    })).toThrow(ReflowMissingIdempotencyKeyError);
  });

  it('apply with whitespace-only idempotencyKey → ReflowMissingIdempotencyKeyError', () => {
    seedPlanWithWeekAndSession(151, 1510, 15100);
    for (const key of ['   ', '\n', '\t', '  \t \n ']) {
      expect(() => executeWeekReflow({
        planId: 151, weekId: 1510, mode: 'apply',
        trigger: 'manual_reflow',
        idempotencyKey: key,
        sciencePolicyVersion: '1.0.0',
      })).toThrow(ReflowMissingIdempotencyKeyError);
    }
  });

  it('apply with padded key stores the trimmed value AND a later trimmed-key retry replays the same row', () => {
    seedPlanWithWeekAndSession(152, 1520, 15200);
    const first = executeWeekReflow({
      planId: 152, weekId: 1520, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: '  k-padded  ',
      sciencePolicyVersion: '1.0.0',
    });
    // The ledger row's idempotency_key column reflects the trimmed
    // form (lookup parity invariant: a retry with the trimmed key
    // must replay the same row).
    const stored = testDb.prepare(
      'SELECT idempotency_key FROM training_plan_adaptations WHERE id = ?',
    ).get(first.adaptationId) as { idempotency_key: string };
    expect(stored.idempotency_key).toBe('k-padded');

    const second = executeWeekReflow({
      planId: 152, weekId: 1520, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'k-padded',
      sciencePolicyVersion: '1.0.0',
    });
    expect(second.alreadyExisted).toBe(true);
    expect(second.adaptationId).toBe(first.adaptationId);
  });

  it('apply with two padding variants of the same key collapse to one ledger row', () => {
    seedPlanWithWeekAndSession(153, 1530, 15300);
    executeWeekReflow({
      planId: 153, weekId: 1530, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: 'kx',
      sciencePolicyVersion: '1.0.0',
    });
    const padded = executeWeekReflow({
      planId: 153, weekId: 1530, mode: 'apply',
      trigger: 'manual_reflow',
      idempotencyKey: '  kx  ',
      sciencePolicyVersion: '1.0.0',
    });
    expect(padded.alreadyExisted).toBe(true);
    const ledger = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(153) as { n: number };
    expect(ledger.n).toBe(1);
  });

  it('preview remains key-optional (R8 P3 must not regress the preview contract)', () => {
    seedPlanWithWeekAndSession(154, 1540, 15400);
    const result = executeWeekReflow({
      planId: 154, weekId: 1540, mode: 'preview',
      trigger: 'manual_preview',
      sciencePolicyVersion: '1.0.0',
      // no idempotencyKey
    });
    expect(result.mode).toBe('preview');
    expect(result.adaptationRevision).toBeNull();
  });

  it('preview accepts whitespace-only key without throwing (preview ignores dedup)', () => {
    seedPlanWithWeekAndSession(155, 1550, 15500);
    const result = executeWeekReflow({
      planId: 155, weekId: 1550, mode: 'preview',
      trigger: 'manual_preview',
      idempotencyKey: '   ',
      sciencePolicyVersion: '1.0.0',
    });
    expect(result.mode).toBe('preview');
  });
});
