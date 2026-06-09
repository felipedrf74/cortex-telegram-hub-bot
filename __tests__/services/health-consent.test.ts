/**
 * Slice A4p — privacy/consent orchestration tests.
 *
 * Pins:
 *   - Single delete primitive cascades across 3 storage layers
 *   - Returns counts per layer for audit
 *   - Validates consent scope names + dedupes
 *   - Consent explanation copy is non-empty for every known scope
 *   - Sensitive scopes flagged for support-view redaction
 *   - Retention defaults: sensitive = 365 days, non-sensitive = indefinite
 *   - RED-S explanation explicitly says "screening" not "diagnosis"
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
  CONSENT_EXPLANATIONS,
  DEFAULT_RETENTION_DAYS,
  SCOPE_SUPPORT_REDACTED,
  deleteAllHealthDataForUser as deleteAllHealthDataForUserRaw,
  validateConsentScopes,
} from '../../src/services/health-consent';
import { recordReadinessEvent as recordReadinessEventRaw } from '../../src/services/readiness-events';
import { recordHealthSignal as recordHealthSignalRaw } from '../../src/services/health-signals';
import { recordAdaptation } from '../../src/services/training-plan-adaptations';

type RecordReadinessEventTestInput =
  Omit<Parameters<typeof recordReadinessEventRaw>[0], 'tenantId'> & { tenantId?: number };

function recordReadinessEvent(input: RecordReadinessEventTestInput): ReturnType<typeof recordReadinessEventRaw> {
  return recordReadinessEventRaw({ ...input, tenantId: input.tenantId ?? input.userId });
}

type RecordHealthSignalTestInput =
  Omit<Parameters<typeof recordHealthSignalRaw>[0], 'tenantId'> & { tenantId?: number };

function recordHealthSignal(input: RecordHealthSignalTestInput): ReturnType<typeof recordHealthSignalRaw> {
  return recordHealthSignalRaw({ ...input, tenantId: input.tenantId ?? input.userId });
}

function deleteAllHealthDataForUser(
  userId: number,
  tenantId = userId,
): ReturnType<typeof deleteAllHealthDataForUserRaw> {
  return deleteAllHealthDataForUserRaw(userId, tenantId);
}

beforeEach(() => {
  testDb = new Database(':memory:');
  applyMigrations(testDb);
});

afterEach(() => {
  testDb.close();
});

function seedPlan(id: number, userId: number, tenantId = userId): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, duration_weeks, start_date, end_date, status)
    VALUES (?, ?, ?, 'p', 'gym', 4, '2026-01-01', '2026-02-01', 'active')
  `).run(id, userId, tenantId);
}

describe('consent scope explanations', () => {
  it('has explanation copy for every known scope', () => {
    for (const [scope, copy] of Object.entries(CONSENT_EXPLANATIONS)) {
      expect(copy.length).toBeGreaterThan(0);
      expect(copy.toLowerCase()).not.toContain('todo');
    }
  });

  it('RED-S explanation explicitly disclaims diagnosis', () => {
    const copy = CONSENT_EXPLANATIONS.red_s_screening.toLowerCase();
    expect(copy).toContain('screening');
    // The word "diagnosis" must appear ONLY in negation context (e.g.,
    // "not a diagnosis" or "never an automated diagnosis"). A positive
    // claim would be something like "we diagnose" or "this diagnoses".
    expect(copy).toMatch(/not a diagnosis|never an automated diagnosis|never a diagnosis/);
    expect(copy).not.toMatch(/we (will )?diagnose|this diagnoses?/);
  });

  it('menstrual explanation explicitly disclaims performance prediction', () => {
    const copy = CONSENT_EXPLANATIONS.menstrual.toLowerCase();
    // Same pattern — the word "predict" must appear only in a negation.
    expect(copy).toMatch(/not predict|does not predict|won't predict/);
    expect(copy).not.toMatch(/will predict|we predict|predicts/);
    expect(copy).toContain('symptom-aware');
  });
});

describe('validateConsentScopes', () => {
  it('passes valid scope set', () => {
    expect(validateConsentScopes(['pain', 'illness'])).toEqual([]);
  });

  it('flags unknown scopes', () => {
    const errors = validateConsentScopes(['pain', 'bogus_scope']);
    expect(errors.some((e) => /unknown/.test(e))).toBe(true);
  });

  it('flags duplicate scopes', () => {
    const errors = validateConsentScopes(['pain', 'pain']);
    expect(errors.some((e) => /duplicate/.test(e))).toBe(true);
  });
});

describe('SCOPE_SUPPORT_REDACTED', () => {
  it('marks pain/illness/injury/menstrual/red_s_screening as sensitive', () => {
    expect(SCOPE_SUPPORT_REDACTED.pain).toBe(true);
    expect(SCOPE_SUPPORT_REDACTED.illness).toBe(true);
    expect(SCOPE_SUPPORT_REDACTED.injury).toBe(true);
    expect(SCOPE_SUPPORT_REDACTED.menstrual).toBe(true);
    expect(SCOPE_SUPPORT_REDACTED.red_s_screening).toBe(true);
  });

  it('does NOT mark sleep / HRV / RHR as sensitive', () => {
    expect(SCOPE_SUPPORT_REDACTED.readiness_basic).toBe(false);
    expect(SCOPE_SUPPORT_REDACTED.hrv_status).toBe(false);
    expect(SCOPE_SUPPORT_REDACTED.resting_hr).toBe(false);
  });
});

describe('DEFAULT_RETENTION_DAYS', () => {
  it('sensitive scopes retain 365 days', () => {
    expect(DEFAULT_RETENTION_DAYS.pain).toBe(365);
    expect(DEFAULT_RETENTION_DAYS.illness).toBe(365);
    expect(DEFAULT_RETENTION_DAYS.injury).toBe(365);
    expect(DEFAULT_RETENTION_DAYS.menstrual).toBe(365);
    expect(DEFAULT_RETENTION_DAYS.red_s_screening).toBe(365);
  });

  it('non-sensitive scopes retain indefinitely (0 days = indefinite)', () => {
    expect(DEFAULT_RETENTION_DAYS.readiness_basic).toBe(0);
    expect(DEFAULT_RETENTION_DAYS.hrv_status).toBe(0);
    expect(DEFAULT_RETENTION_DAYS.resting_hr).toBe(0);
  });
});

describe('deleteAllHealthDataForUser — right-to-delete cascade', () => {
  it('cascades across readiness events, health signals, and ledger', () => {
    const userId = 500;
    seedPlan(100, userId);

    // Seed some data across the three layers.
    recordReadinessEvent({ userId, date: '2026-01-10', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId, date: '2026-01-15', sleepHours: 8, consentScope: ['readiness_basic'] });
    recordHealthSignal({ userId, date: '2026-01-12', painScore: 6, consentScope: ['pain'] });
    recordHealthSignal({ userId, date: '2026-01-16', illnessSymptoms: ['cough'], consentScope: ['illness'] });
    recordAdaptation({
      planId: 100,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'knee', painScore: 7 },
      sciencePolicyVersion: '1.0.0',
    });

    const result = deleteAllHealthDataForUser(userId);
    expect(result.tenantId).toBe(userId);
    expect(result.readinessEventsDeleted).toBe(2);
    expect(result.healthSignalsDeleted).toBe(2);
    expect(result.ledgerRowsRedacted).toBe(1);

    // Verify the readiness + health tables are empty for this user.
    const readinessRows = testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_readiness_events WHERE user_id = ?',
    ).get(userId) as { n: number };
    expect(readinessRows.n).toBe(0);

    const healthRows = testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_health_signals WHERE user_id = ?',
    ).get(userId) as { n: number };
    expect(healthRows.n).toBe(0);

    // Verify the ledger row is preserved but redacted. R3 P2 — the
    // trigger_type COLUMN is also bucketed on user deletion, so the
    // post-deletion query must filter by the bucket value not the
    // original category.
    const ledgerRow = testDb.prepare(`
      SELECT trigger_type, trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 100 AND trigger_type = 'health_sensitive'
    `).get() as { trigger_type: string; trigger_payload_json: string };
    expect(ledgerRow.trigger_type).toBe('health_sensitive');
    const payload = JSON.parse(ledgerRow.trigger_payload_json);
    expect(payload.redacted).toBe(true);
    expect(payload.reason).toBe('user_deletion');
    // No row with the original pain_flag category survives the delete.
    const oldRow = testDb.prepare(`
      SELECT COUNT(*) AS n FROM training_plan_adaptations
      WHERE plan_id = 100 AND trigger_type = 'pain_flag'
    `).get() as { n: number };
    expect(oldRow.n).toBe(0);
  });

  it('does not affect other users', () => {
    const userA = 600;
    const userB = 601;
    seedPlan(200, userA);

    recordReadinessEvent({ userId: userA, date: '2026-01-10', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId: userB, date: '2026-01-10', sleepHours: 8, consentScope: ['readiness_basic'] });

    const result = deleteAllHealthDataForUser(userA);
    expect(result.readinessEventsDeleted).toBe(1);

    const userBRows = testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_readiness_events WHERE user_id = ?',
    ).get(userB) as { n: number };
    expect(userBRows.n).toBe(1);
  });

  it('does not affect another tenant for the same user id', () => {
    const userId = 610;
    const tenantA = 1000;
    const tenantB = 2000;
    seedPlan(210, userId, tenantA);
    seedPlan(211, userId, tenantB);

    recordReadinessEvent({ userId, tenantId: tenantA, date: '2026-01-10', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordReadinessEvent({ userId, tenantId: tenantB, date: '2026-01-10', sleepHours: 8, consentScope: ['readiness_basic'] });
    recordHealthSignal({ userId, tenantId: tenantA, date: '2026-01-12', painScore: 6, consentScope: ['pain'] });
    recordHealthSignal({ userId, tenantId: tenantB, date: '2026-01-12', painScore: 4, consentScope: ['pain'] });
    recordAdaptation({
      planId: 210,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'knee', painScore: 6 },
      sciencePolicyVersion: '1.0.0',
    });
    recordAdaptation({
      planId: 211,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'hip', painScore: 4 },
      sciencePolicyVersion: '1.0.0',
    });

    const result = deleteAllHealthDataForUser(userId, tenantA);
    expect(result.readinessEventsDeleted).toBe(1);
    expect(result.healthSignalsDeleted).toBe(1);
    expect(result.ledgerRowsRedacted).toBe(1);

    expect(testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_readiness_events WHERE user_id = ? AND tenant_id = ?',
    ).get(userId, tenantB)).toEqual({ n: 1 });
    expect(testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_health_signals WHERE user_id = ? AND tenant_id = ?',
    ).get(userId, tenantB)).toEqual({ n: 1 });
    const tenantBLedger = testDb.prepare(
      'SELECT trigger_type FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(211) as { trigger_type: string };
    expect(tenantBLedger.trigger_type).toBe('pain_flag');
  });

  it('returns elapsedSeconds for SLA tracking', () => {
    const result = deleteAllHealthDataForUser(700);
    expect(typeof result.elapsedSeconds).toBe('number');
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(0);
  });

  it('handles users with no data (idempotent zero-delete)', () => {
    const result = deleteAllHealthDataForUser(9999);
    expect(result.readinessEventsDeleted).toBe(0);
    expect(result.healthSignalsDeleted).toBe(0);
    expect(result.ledgerRowsRedacted).toBe(0);
  });

  it('Codex P2 fix — transactional rollback on mid-flow failure', () => {
    // Seed data across all three layers.
    const userId = 900;
    seedPlan(900, userId);
    recordReadinessEvent({ userId, date: '2026-05-15', sleepHours: 7, consentScope: ['readiness_basic'] });
    recordHealthSignal({ userId, date: '2026-05-15', painScore: 6, consentScope: ['pain'] });
    recordAdaptation({
      planId: 900,
      scope: 'session',
      triggerType: 'pain_flag',
      triggerPayload: { painLocation: 'knee', painScore: 6 },
      sciencePolicyVersion: '1.0.0',
    });

    // Snapshot the ledger payload BEFORE the failed delete attempt.
    const beforePayload = testDb.prepare(`
      SELECT trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 900 AND trigger_type = 'pain_flag'
    `).get() as { trigger_payload_json: string };

    // Sabotage: drop the health_signals table mid-execution to force
    // a throw inside the transaction. We do this by replacing the
    // table after the delete-readiness step would have run BUT
    // before delete-health-signals does. Because the order now
    // redacts ledger FIRST, health_signals DELETE runs AFTER, and
    // dropping the table mid-transaction will cause the DELETE to
    // throw.
    const original = testDb.prepare(
      'DROP TABLE athlete_health_signals',
    );

    // Run delete in a way that triggers the throw: temporarily
    // simulate by dropping inside a transaction — easier: manually
    // sabotage one of the three primitives via a sentinel that we
    // construct outside.
    //
    // Simplest approach for this test: drop the table BEFORE calling
    // deleteAllHealthDataForUser so the inner deleteHealthHistoryForUser
    // throws. Then assert the ledger is UNCHANGED (rollback worked).
    original.run();

    expect(() => deleteAllHealthDataForUser(userId)).toThrow();

    // Ledger payload preserved — rollback worked.
    const afterPayload = testDb.prepare(`
      SELECT trigger_payload_json FROM training_plan_adaptations
      WHERE plan_id = 900 AND trigger_type = 'pain_flag'
    `).get() as { trigger_payload_json: string };
    expect(afterPayload.trigger_payload_json).toBe(beforePayload.trigger_payload_json);
    // Readiness rows preserved too.
    const readinessCount = testDb.prepare(
      'SELECT COUNT(*) AS n FROM athlete_readiness_events WHERE user_id = ?',
    ).get(userId) as { n: number };
    expect(readinessCount.n).toBe(1);
  });
});
