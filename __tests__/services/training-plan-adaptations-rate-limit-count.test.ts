/**
 * R5 P1 — `countNonSafetyAppliedAdaptations` correctly excludes
 * previews, rollbacks, and safety-pause rows so the anti-churn
 * rate-limit only counts user-initiated apply reflows.
 *
 * Codex caught (R5 P1 #1) that the rate-limit thresholds were
 * passed without the corresponding *counts*, so the limiter
 * defaulted to 0 and never tripped. The new helper hydrates the
 * counts from the ledger. These tests pin the filter semantics
 * the limiter depends on.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
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
  withDatabaseForTestAsync: vi.fn(),
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
      } catch { /* skip dependency-order failures */ }
    }
  }
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
  testDb.prepare(`
    INSERT INTO fitness_training_plans (id, user_id, name, sport, status, start_date, end_date, duration_weeks, created_at)
    VALUES (700, 999, 'Test', 'running', 'active', '2026-05-01', '2026-07-01', 8, datetime('now'))
  `).run();
});

afterEach(() => {
  testDb.close();
});

import {
  countNonSafetyAppliedAdaptations,
  recordAdaptation,
  recordPreviewAdaptation,
  rollbackAdaptation,
} from '../../src/services/training-plan-adaptations';

const POLICY = '1.0.0';

describe('R5 P1 — countNonSafetyAppliedAdaptations', () => {
  it('returns 0 when no adaptations exist', () => {
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(0);
  });

  it('returns 1 after a single applied user reflow', () => {
    recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(1);
  });

  it('excludes preview rows (no revision bump → no churn)', () => {
    recordPreviewAdaptation({
      planId: 700,
      triggerType: 'preview_reflow',
      sciencePolicyVersion: POLICY,
      actor: 'user',
    });
    recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(1);
  });

  it('excludes rollback rows (remediation, not user churn)', () => {
    const original = recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    rollbackAdaptation({
      adaptationId: original.adaptationId,
      actor: 'admin',
    });
    // Original counts; rollback doesn't.
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(1);
  });

  it('excludes safety-pause rows (medical_referral reason exempt by contract)', () => {
    recordAdaptation({
      planId: 700,
      scope: 'plan',
      triggerType: 'safety_pause',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'safety-1',
      actor: 'system',
      decisionReasonCodes: ['medical_referral'],
    });
    recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(1);
  });

  it('window cutoff excludes rows older than `hoursBack`', () => {
    recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    // Backdate the row outside the 24h window.
    testDb.prepare(
      `UPDATE training_plan_adaptations SET created_at = datetime('now', '-48 hours') WHERE plan_id = ?`,
    ).run(700);
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(0);
    expect(countNonSafetyAppliedAdaptations(700, 72)).toBe(1);
  });

  it('hoursBack ≤ 0 or non-finite → returns 0 (defensive)', () => {
    recordAdaptation({
      planId: 700,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'k1',
      actor: 'user',
    });
    expect(countNonSafetyAppliedAdaptations(700, 0)).toBe(0);
    expect(countNonSafetyAppliedAdaptations(700, -5)).toBe(0);
    expect(countNonSafetyAppliedAdaptations(700, Number.NaN)).toBe(0);
    expect(countNonSafetyAppliedAdaptations(700, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('scopes by plan_id (other plans do not bleed into the count)', () => {
    testDb.prepare(`
      INSERT INTO fitness_training_plans (id, user_id, name, sport, status, start_date, end_date, duration_weeks, created_at)
      VALUES (701, 999, 'Test 2', 'running', 'active', '2026-05-01', '2026-07-01', 8, datetime('now'))
    `).run();
    recordAdaptation({
      planId: 701,
      scope: 'week',
      triggerType: 'manual_reflow',
      sciencePolicyVersion: POLICY,
      idempotencyKey: 'plan701-k1',
      actor: 'user',
    });
    expect(countNonSafetyAppliedAdaptations(700, 24)).toBe(0);
    expect(countNonSafetyAppliedAdaptations(701, 24)).toBe(1);
  });
});
