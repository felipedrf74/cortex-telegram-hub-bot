/**
 * Slice A0b — adaptation ledger.
 *
 * Pins the six hard invariants for the ledger:
 *
 *   1. Every `adaptation_revision` bump has exactly one ledger row.
 *   2. Adaptive writes are atomic (transaction wraps bump + insert).
 *   3. Previews do NOT bump the revision counter.
 *   4. Rollback is append-only (original preserved).
 *   5. Rollback requires latest-revision (optimistic lock).
 *   6. Health-sensitive payloads are redacted for non-admin readers.
 *
 * Plus auxiliary coverage:
 *   - UNIQUE(plan_id, adaptation_revision) DB backstop
 *   - UNIQUE(plan_id, idempotency_key) DB backstop
 *   - `findAdaptationByIdempotencyKey` returns existing row
 *   - `getAdaptationsForPlan` filters + orders correctly
 *   - `purgeSensitivePayloadsForUser` redacts only sensitive triggers
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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
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
      } catch {
        /* skip deps */
      }
    }
  }
}

import {
  AdaptationAlreadyRolledBackError,
  AdaptationIdempotencyConflictError,
  AdaptationPlanNotFoundError,
  AdaptationPreviewNotRollbackableError,
  AdaptationRollbackNotLatestError,
  findAdaptationByIdempotencyKey,
  getAdaptationByRevision,
  getAdaptationsForPlan,
  purgeSensitivePayloadsForUser,
  recordAdaptation,
  recordPreviewAdaptation,
  rollbackAdaptation,
} from '../../src/services/training-plan-adaptations';
import {
  getAdaptationRevision,
} from '../../src/services/training-plan-lifecycle';

const POLICY_VERSION = '1.0.0-test';

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.pragma('foreign_keys = ON');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(id: number, userId = 100): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, 'Test plan', 'gym', 12, '2026-01-01', '2026-04-01', 'active')
  `).run(id, userId);
}

describe('migration 156 — training_plan_adaptations table', () => {
  it('creates the ledger table with expected columns', () => {
    const cols = testDb
      .prepare("PRAGMA table_info('training_plan_adaptations')")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('id')).toBe(true);
    expect(names.has('plan_id')).toBe(true);
    expect(names.has('adaptation_revision')).toBe(true);
    expect(names.has('scope')).toBe(true);
    expect(names.has('trigger_type')).toBe(true);
    expect(names.has('trigger_payload_json')).toBe(true);
    expect(names.has('before_patch_json')).toBe(true);
    expect(names.has('after_patch_json')).toBe(true);
    expect(names.has('decision_reason_codes_json')).toBe(true);
    expect(names.has('science_policy_version')).toBe(true);
    expect(names.has('feature_flag_snapshot')).toBe(true);
    expect(names.has('idempotency_key')).toBe(true);
    expect(names.has('rollback_of_adaptation_id')).toBe(true);
    expect(names.has('actor')).toBe(true);
    expect(names.has('created_at')).toBe(true);
  });

  it('enforces UNIQUE(plan_id, adaptation_revision) partial index', () => {
    seedPlan(1);
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version)
      VALUES (1, 5, 'week', 'manual_reflow', '1.0.0')
    `).run();
    expect(() => testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version)
      VALUES (1, 5, 'week', 'manual_reflow', '1.0.0')
    `).run()).toThrow(/UNIQUE constraint/);
  });

  it('allows multiple preview rows (adaptation_revision NULL excluded from UNIQUE)', () => {
    seedPlan(1);
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version)
      VALUES (1, NULL, 'preview', 'reflow_preview', '1.0.0')
    `).run();
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version)
      VALUES (1, NULL, 'preview', 'reflow_preview', '1.0.0')
    `).run();
    const count = testDb.prepare(
      "SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1 AND scope = 'preview'",
    ).get() as { n: number };
    expect(count.n).toBe(2);
  });

  it('enforces UNIQUE(plan_id, idempotency_key) partial index', () => {
    seedPlan(1);
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version, idempotency_key)
      VALUES (1, 1, 'week', 'manual_reflow', '1.0.0', 'abc-123')
    `).run();
    expect(() => testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version, idempotency_key)
      VALUES (1, 2, 'week', 'manual_reflow', '1.0.0', 'abc-123')
    `).run()).toThrow(/UNIQUE constraint/);
  });

  it('allows multiple rows with NULL idempotency_key', () => {
    seedPlan(1);
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version, idempotency_key)
      VALUES (1, 1, 'week', 'manual_reflow', '1.0.0', NULL)
    `).run();
    testDb.prepare(`
      INSERT INTO training_plan_adaptations
        (plan_id, adaptation_revision, scope, trigger_type, science_policy_version, idempotency_key)
      VALUES (1, 2, 'week', 'manual_reflow', '1.0.0', NULL)
    `).run();
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 1',
    ).get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe('recordAdaptation — invariants 1 & 2 (exactly-once, atomic)', () => {
  it('bumps revision and writes exactly one ledger row', () => {
    seedPlan(10);
    const result = recordAdaptation({
      planId: 10,
      scope: 'week',
      triggerType: 'manual_reflow',
      triggerPayload: { trigger: 'user_request' },
      beforePatch: { before: 'a' },
      afterPatch: { after: 'b' },
      decisionReasonCodes: ['reflow_applied'],
      sciencePolicyVersion: POLICY_VERSION,
    });
    expect(result.adaptationRevision).toBe(1);
    expect(result.alreadyExisted).toBe(false);
    expect(getAdaptationRevision(10)).toBe(1);
    const rows = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE plan_id = ?',
    ).all(10);
    expect(rows.length).toBe(1);
  });

  it('throws AdaptationPlanNotFoundError for missing plan and does not bump anything', () => {
    expect(() => recordAdaptation({
      planId: 9999,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY_VERSION,
    })).toThrow(AdaptationPlanNotFoundError);
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations',
    ).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('persists multiple adaptations monotonically', () => {
    seedPlan(11);
    const r1 = recordAdaptation({ planId: 11, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    const r2 = recordAdaptation({ planId: 11, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    const r3 = recordAdaptation({ planId: 11, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    expect([r1.adaptationRevision, r2.adaptationRevision, r3.adaptationRevision]).toEqual([1, 2, 3]);
    expect(getAdaptationRevision(11)).toBe(3);
  });

  it('persists the science_policy_version on the row for reproducibility', () => {
    seedPlan(12);
    recordAdaptation({
      planId: 12,
      scope: 'session',
      triggerType: 'scenario_classifier',
      sciencePolicyVersion: '2.3.4-experimental',
    });
    const row = testDb.prepare(
      'SELECT science_policy_version FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(12) as { science_policy_version: string };
    expect(row.science_policy_version).toBe('2.3.4-experimental');
  });
});

describe('recordAdaptation — invariant 5 (idempotency)', () => {
  it('collapses duplicate requests with the same idempotency key', () => {
    seedPlan(20);
    const r1 = recordAdaptation({
      planId: 20,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY_VERSION,
      idempotencyKey: 'key-1',
    });
    const r2 = recordAdaptation({
      planId: 20,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY_VERSION,
      idempotencyKey: 'key-1',
    });
    expect(r2.alreadyExisted).toBe(true);
    expect(r2.adaptationId).toBe(r1.adaptationId);
    expect(r2.adaptationRevision).toBe(r1.adaptationRevision);
    // Revision counter only bumped once.
    expect(getAdaptationRevision(20)).toBe(1);
    // Only one row.
    const rows = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE plan_id = ?',
    ).all(20);
    expect(rows.length).toBe(1);
  });

  it('treats NULL idempotency keys as independent (no collapse)', () => {
    seedPlan(21);
    recordAdaptation({ planId: 21, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 21, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    expect(getAdaptationRevision(21)).toBe(2);
    const rows = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE plan_id = ?',
    ).all(21);
    expect(rows.length).toBe(2);
  });

  it('isolates idempotency keys across plans', () => {
    seedPlan(22);
    seedPlan(23);
    recordAdaptation({
      planId: 22,
      scope: 'week',
      triggerType: 't',
      sciencePolicyVersion: POLICY_VERSION,
      idempotencyKey: 'shared-key',
    });
    // Same key on a different plan must NOT collapse.
    const r = recordAdaptation({
      planId: 23,
      scope: 'week',
      triggerType: 't',
      sciencePolicyVersion: POLICY_VERSION,
      idempotencyKey: 'shared-key',
    });
    expect(r.alreadyExisted).toBe(false);
    expect(r.adaptationRevision).toBe(1);
  });
});

describe('recordPreviewAdaptation — invariant 3 (no counter bump)', () => {
  it('writes a preview row without bumping adaptation_revision', () => {
    seedPlan(30);
    const result = recordPreviewAdaptation({
      planId: 30,
      triggerType: 'reflow_preview',
      afterPatch: { hypothetical: 'change' },
      sciencePolicyVersion: POLICY_VERSION,
    });
    expect(result.adaptationId).toBeGreaterThan(0);
    // Counter must remain at 0.
    expect(getAdaptationRevision(30)).toBe(0);
    const row = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(30) as { adaptation_revision: number | null; scope: string };
    expect(row.adaptation_revision).toBeNull();
    expect(row.scope).toBe('preview');
  });

  it('allows multiple previews to coexist', () => {
    seedPlan(31);
    recordPreviewAdaptation({ planId: 31, triggerType: 'p1', sciencePolicyVersion: POLICY_VERSION });
    recordPreviewAdaptation({ planId: 31, triggerType: 'p2', sciencePolicyVersion: POLICY_VERSION });
    recordPreviewAdaptation({ planId: 31, triggerType: 'p3', sciencePolicyVersion: POLICY_VERSION });
    const count = testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(31) as { n: number };
    expect(count.n).toBe(3);
    expect(getAdaptationRevision(31)).toBe(0);
  });

  it('throws AdaptationPlanNotFoundError for missing plan', () => {
    expect(() => recordPreviewAdaptation({
      planId: 9999,
      triggerType: 'p1',
      sciencePolicyVersion: POLICY_VERSION,
    })).toThrow(AdaptationPlanNotFoundError);
  });
});

describe('rollbackAdaptation — invariants 4 & latest-only (5)', () => {
  it('writes a NEW row, preserves the original, bumps revision', () => {
    seedPlan(40);
    const original = recordAdaptation({
      planId: 40,
      scope: 'week',
      triggerType: 'manual_reflow',
      beforePatch: { v: 'a' },
      afterPatch: { v: 'b' },
      sciencePolicyVersion: POLICY_VERSION,
    });
    const rollback = rollbackAdaptation({
      adaptationId: original.adaptationId,
      actor: 'admin',
    });
    expect(rollback.newAdaptationRevision).toBe(2);
    // Original row still exists, unchanged.
    const originalRow = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE id = ?',
    ).get(original.adaptationId) as {
      after_patch_json: string;
      rollback_of_adaptation_id: number | null;
    };
    expect(JSON.parse(originalRow.after_patch_json)).toEqual({ v: 'b' });
    expect(originalRow.rollback_of_adaptation_id).toBeNull();
    // New rollback row exists with swapped patches.
    const rollbackRow = testDb.prepare(
      'SELECT * FROM training_plan_adaptations WHERE id = ?',
    ).get(rollback.rollbackAdaptationId) as {
      trigger_type: string;
      before_patch_json: string;
      after_patch_json: string;
      rollback_of_adaptation_id: number;
      adaptation_revision: number;
    };
    expect(rollbackRow.trigger_type).toBe('rollback');
    expect(JSON.parse(rollbackRow.before_patch_json)).toEqual({ v: 'b' });
    expect(JSON.parse(rollbackRow.after_patch_json)).toEqual({ v: 'a' });
    expect(rollbackRow.rollback_of_adaptation_id).toBe(original.adaptationId);
    expect(rollbackRow.adaptation_revision).toBe(2);
  });

  it('refuses rollback when target is not the latest revision', () => {
    seedPlan(41);
    const r1 = recordAdaptation({ planId: 41, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 41, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    // r1 is now revision 1; current revision is 2. Rollback of r1 must fail.
    expect(() => rollbackAdaptation({ adaptationId: r1.adaptationId })).toThrow(AdaptationRollbackNotLatestError);
  });

  it('refuses to rollback a preview row', () => {
    seedPlan(42);
    const preview = recordPreviewAdaptation({
      planId: 42,
      triggerType: 'preview_only',
      sciencePolicyVersion: POLICY_VERSION,
    });
    expect(() => rollbackAdaptation({ adaptationId: preview.adaptationId })).toThrow(AdaptationPreviewNotRollbackableError);
  });

  it('refuses to double-rollback the same adaptation', () => {
    seedPlan(43);
    const original = recordAdaptation({ planId: 43, scope: 'week', triggerType: 't', sciencePolicyVersion: POLICY_VERSION });
    rollbackAdaptation({ adaptationId: original.adaptationId });
    // Roll back the rollback first to reset latest-revision check (we
    // want to test the already-rolled-back path, not the not-latest
    // path).
    // Actually: after the rollback, the original is no longer the
    // latest revision — the rollback row is. So attempting a second
    // rollback of the ORIGINAL will hit AdaptationAlreadyRolledBackError
    // OR AdaptationRollbackNotLatestError. We test that one of those
    // protective errors fires.
    expect(() => rollbackAdaptation({ adaptationId: original.adaptationId })).toThrow(
      // Either error is acceptable — they both block the wrong write.
      // Vitest's .toThrow() accepts an Error class; we use a union via instanceof in catch.
      Error,
    );
    // More specifically:
    try {
      rollbackAdaptation({ adaptationId: original.adaptationId });
    } catch (err) {
      expect(
        err instanceof AdaptationAlreadyRolledBackError ||
        err instanceof AdaptationRollbackNotLatestError,
      ).toBe(true);
    }
  });

  it('reuses the original science_policy_version on the rollback row (reproducibility)', () => {
    seedPlan(44);
    const original = recordAdaptation({
      planId: 44,
      scope: 'week',
      triggerType: 't',
      sciencePolicyVersion: '3.0.0',
    });
    const rollback = rollbackAdaptation({ adaptationId: original.adaptationId });
    const row = testDb.prepare(
      'SELECT science_policy_version FROM training_plan_adaptations WHERE id = ?',
    ).get(rollback.rollbackAdaptationId) as { science_policy_version: string };
    expect(row.science_policy_version).toBe('3.0.0');
  });
});

describe('reads — getAdaptationByRevision, getAdaptationsForPlan', () => {
  it('getAdaptationByRevision returns the exact row for a (plan, revision)', () => {
    seedPlan(50);
    recordAdaptation({ planId: 50, scope: 'week', triggerType: 'first', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 50, scope: 'week', triggerType: 'second', sciencePolicyVersion: POLICY_VERSION });
    const row = getAdaptationByRevision(50, 2);
    expect(row?.trigger_type).toBe('second');
    expect(row?.adaptation_revision).toBe(2);
  });

  it('getAdaptationByRevision returns null when no such revision exists', () => {
    seedPlan(51);
    expect(getAdaptationByRevision(51, 999)).toBeNull();
  });

  it('getAdaptationsForPlan returns rows newest-first', () => {
    seedPlan(52);
    recordAdaptation({ planId: 52, scope: 'week', triggerType: 'a', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 52, scope: 'week', triggerType: 'b', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 52, scope: 'week', triggerType: 'c', sciencePolicyVersion: POLICY_VERSION });
    const rows = getAdaptationsForPlan(52);
    expect(rows.map((r) => r.trigger_type)).toEqual(['c', 'b', 'a']);
  });

  it('getAdaptationsForPlan filters by scope', () => {
    seedPlan(53);
    recordAdaptation({ planId: 53, scope: 'week', triggerType: 'wk', sciencePolicyVersion: POLICY_VERSION });
    recordAdaptation({ planId: 53, scope: 'session', triggerType: 'sess', sciencePolicyVersion: POLICY_VERSION });
    recordPreviewAdaptation({ planId: 53, triggerType: 'preview', sciencePolicyVersion: POLICY_VERSION });
    const previews = getAdaptationsForPlan(53, { scope: 'preview' });
    expect(previews.length).toBe(1);
    expect(previews[0].trigger_type).toBe('preview');
  });
});

describe('privacy — invariant 6 (redaction for non-admin viewers)', () => {
  it('redacts trigger_payload_json for health-sensitive triggers when viewer is support', () => {
    seedPlan(60);
    recordAdaptation({
      planId: 60,
      scope: 'session',
      triggerType: 'safety_pause',
      triggerPayload: { painLocation: 'left knee', painScore: 8 },
      sciencePolicyVersion: POLICY_VERSION,
    });
    const ownerView = getAdaptationsForPlan(60, { viewerRole: 'owner' });
    expect(JSON.parse(ownerView[0].trigger_payload_json!)).toEqual({
      painLocation: 'left knee',
      painScore: 8,
    });
    const supportView = getAdaptationsForPlan(60, { viewerRole: 'support' });
    const redacted = JSON.parse(supportView[0].trigger_payload_json!);
    expect(redacted.redacted).toBe(true);
    expect(redacted.reason).toBe('health_sensitive');
    // R3 P2 — bucket the trigger type so the support view cannot
    // learn the original category (was 'safety_pause' here).
    expect(redacted.triggerType).toBe('health_sensitive');
    // R3 P2 — also bucket the row's trigger_type COLUMN.
    expect(supportView[0].trigger_type).toBe('health_sensitive');
    // The row itself is still returned — only its sensitive fields are redacted.
    expect(supportView[0].id).toBe(ownerView[0].id);
  });

  it('does NOT redact non-sensitive triggers for support viewer', () => {
    seedPlan(61);
    recordAdaptation({
      planId: 61,
      scope: 'week',
      triggerType: 'manual_reflow',
      triggerPayload: { reason: 'user requested' },
      sciencePolicyVersion: POLICY_VERSION,
    });
    const supportView = getAdaptationsForPlan(61, { viewerRole: 'support' });
    expect(JSON.parse(supportView[0].trigger_payload_json!)).toEqual({
      reason: 'user requested',
    });
  });

  it('admin viewer sees raw sensitive payloads', () => {
    seedPlan(62);
    recordAdaptation({
      planId: 62,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'shoulder', painScore: 7 },
      sciencePolicyVersion: POLICY_VERSION,
    });
    const adminView = getAdaptationsForPlan(62, { viewerRole: 'admin' });
    expect(JSON.parse(adminView[0].trigger_payload_json!)).toEqual({
      painLocation: 'shoulder',
      painScore: 7,
    });
  });

  it('purgeSensitivePayloadsForUser redacts only sensitive trigger types for that user', () => {
    seedPlan(70, 500);
    seedPlan(71, 500); // same user, second plan
    seedPlan(72, 501); // different user

    recordAdaptation({
      planId: 70,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'knee', painScore: 9 },
      sciencePolicyVersion: POLICY_VERSION,
    });
    recordAdaptation({
      planId: 70,
      scope: 'week',
      triggerType: 'manual_reflow',
      triggerPayload: { reason: 'rescheduled' },
      sciencePolicyVersion: POLICY_VERSION,
    });
    recordAdaptation({
      planId: 71,
      scope: 'session',
      triggerType: 'illness_flag',
      triggerPayload: { symptoms: ['fever'] },
      sciencePolicyVersion: POLICY_VERSION,
    });
    recordAdaptation({
      planId: 72,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'ankle', painScore: 6 },
      sciencePolicyVersion: POLICY_VERSION,
    });

    const affected = purgeSensitivePayloadsForUser(500);
    expect(affected).toBe(2); // pain_flag on plan 70 + illness_flag on plan 71.

    // User 500's pain row should be redacted. R3 P2 — both the JSON
    // payload AND the trigger_type COLUMN are bucketed to
    // 'health_sensitive' so post-deletion queries cannot enumerate
    // the original category. The query below filters by the new
    // bucket since the original 'pain_flag' value is gone.
    const userPain = testDb.prepare(`
      SELECT trigger_type, trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 70 AND trigger_type = 'health_sensitive'
    `).get() as { trigger_type: string; trigger_payload_json: string };
    expect(userPain.trigger_type).toBe('health_sensitive');
    const payload = JSON.parse(userPain.trigger_payload_json);
    expect(payload.redacted).toBe(true);
    expect(payload.reason).toBe('user_deletion');
    expect(payload.triggerType).toBe('health_sensitive');
    // Confirm the original 'pain_flag' is fully gone (R3 P2 column-level guard).
    const oldRow = testDb.prepare(`
      SELECT COUNT(*) AS n FROM training_plan_adaptations
      WHERE plan_id = 70 AND trigger_type = 'pain_flag'
    `).get() as { n: number };
    expect(oldRow.n).toBe(0);

    // User 500's non-sensitive row is untouched.
    const reflow = testDb.prepare(`
      SELECT trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 70 AND trigger_type = 'manual_reflow'
    `).get() as { trigger_payload_json: string };
    expect(JSON.parse(reflow.trigger_payload_json)).toEqual({ reason: 'rescheduled' });

    // User 501's pain row is untouched (different user).
    const otherUser = testDb.prepare(`
      SELECT trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 72 AND trigger_type = 'pain_flag'
    `).get() as { trigger_payload_json: string };
    expect(JSON.parse(otherUser.trigger_payload_json)).toEqual({
      painLocation: 'ankle',
      painScore: 6,
    });
  });
});

describe('R4 P3 — purgeSensitivePayloadsForUser uses parameterized SQL for the bucket name', () => {
  it('the source no longer interpolates ${REDACTED_TRIGGER_BUCKET} into the SQL string', () => {
    // Regression-by-search — Codex caught (R4 P3 #3) that the bucket
    // name was interpolated directly into the UPDATE statement.
    // Even though the constant is compile-time, the *pattern* is the
    // habit that grows into an injection vector when someone makes
    // the bucket configurable. We pin the source to confirm the
    // value is bound as a real SQL parameter.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/training-plan-adaptations.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/'\$\{REDACTED_TRIGGER_BUCKET\}'/);
    // The parameterized form (?) followed by `.run(REDACTED_TRIGGER_BUCKET, ...)`.
    expect(src).toMatch(/\.run\(REDACTED_TRIGGER_BUCKET,\s*REDACTED_TRIGGER_BUCKET/);
  });

  it('still bucket-redacts on purge (functional regression after parameterization)', () => {
    seedPlan(700, 1000);
    recordAdaptation({
      planId: 700,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'shoulder', painScore: 7 },
      sciencePolicyVersion: POLICY_VERSION,
    });
    purgeSensitivePayloadsForUser(1000);
    const row = testDb.prepare(`
      SELECT trigger_type, trigger_payload_json
      FROM training_plan_adaptations
      WHERE plan_id = 700 AND trigger_type = 'health_sensitive'
    `).get() as { trigger_type: string; trigger_payload_json: string };
    expect(row.trigger_type).toBe('health_sensitive');
    const payload = JSON.parse(row.trigger_payload_json);
    expect(payload.triggerType).toBe('health_sensitive');
    expect(payload.reason).toBe('user_deletion');
  });
});

describe('findAdaptationByIdempotencyKey', () => {
  it('returns the existing row when key matches', () => {
    seedPlan(80);
    const inserted = recordAdaptation({
      planId: 80,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY_VERSION,
      idempotencyKey: 'unique-key',
    });
    const found = findAdaptationByIdempotencyKey(80, 'unique-key');
    expect(found?.id).toBe(inserted.adaptationId);
  });

  it('returns null when no key matches', () => {
    seedPlan(81);
    expect(findAdaptationByIdempotencyKey(81, 'absent')).toBeNull();
  });
});
