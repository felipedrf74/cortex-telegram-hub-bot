import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  HealthDataLifecycleError,
  appendStructuredHealthCorrection,
  deleteAllStructuredHealthData,
  deleteStructuredHealthIntake,
  getEffectiveHealthSafetyOutput,
  getHealthConsent,
  listStructuredHealthIntakes,
  recordStructuredHealthIntake,
  reviseHealthConsent,
  sweepExpiredStructuredHealthData,
  validateStructuredHealthInput,
} from '../../src/services/health-data-lifecycle';
import { setDbProvider } from '../../src/services/intelligence-bus';
import {
  findIllnessSignalsInRange,
  findPainSignalsInRange,
} from '../../src/services/health-signals';

const DAY_MS = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

function intake(overrides: Record<string, unknown> = {}) {
  return recordStructuredHealthIntake({
    tenantId: 71,
    userId: 71,
    payload: { date: today(), painScore: 6, consentScope: ['pain'], ...overrides },
    idempotencyKey: `intake-${String(overrides.key ?? 'base')}`,
    db: testDb,
  });
}

describe('health data lifecycle authority', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    setDbProvider(() => testDb);
  });

  afterEach(() => testDb.close());

  it('rejects unclosed symptoms, out-of-range pain, future/expired input, and all new menstrual collection', () => {
    expect(() => validateStructuredHealthInput({
      date: today(), painScore: 11, consentScope: ['pain'],
    })).toThrowError(expect.objectContaining({ code: 'BAD_PAIN_SCORE' }));
    expect(() => validateStructuredHealthInput({
      date: today(), illnessSymptoms: ['unknown'], consentScope: ['illness'],
    })).toThrowError(expect.objectContaining({ code: 'BAD_SYMPTOM_CODE' }));
    expect(() => validateStructuredHealthInput({
      date: new Date(Date.now() + DAY_MS).toISOString().slice(0, 10),
      painScore: 1,
      consentScope: ['pain'],
    })).toThrowError(expect.objectContaining({ code: 'FUTURE_HEALTH_INPUT' }));
    expect(() => validateStructuredHealthInput({
      date: daysAgo(365), painScore: 1, consentScope: ['pain'],
    })).toThrowError(expect.objectContaining({ code: 'EXPIRED_HEALTH_INPUT' }));
    expect(() => validateStructuredHealthInput({
      date: today(), menstrualStatus: 'menses', consentScope: ['pain'], painScore: 1,
    })).toThrowError(expect.objectContaining({ code: 'MENSTRUAL_COLLECTION_UNAVAILABLE' }));
  });

  it('caps retention at report date plus 365 days and preserves intake idempotency', () => {
    const date = daysAgo(364);
    const first = intake({ date, key: 'retention' });
    const replay = intake({ date, key: 'retention' });
    const expectedBoundary = new Date(Date.parse(`${date}T00:00:00.000Z`) + 365 * DAY_MS).toISOString();

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.intake.id).toBe(first.intake.id);
    expect(first.intake.expiresAt).toBe(expectedBoundary);
    expect(Date.parse(first.intake.expiresAt)).toBeLessThan(Date.now() + 2 * DAY_MS);
    expect(() => intake({ date, painScore: 7, key: 'retention' }))
      .toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('keeps corrections append-only and consent revisions CAS/idempotency protected', () => {
    const created = intake({ key: 'correction' });
    const corrected = appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: 2 },
      reason: 'Entry was too high',
      idempotencyKey: 'correction-1',
      expectedVersion: 1,
      db: testDb,
    });
    const replay = appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: 2 },
      reason: 'Entry was too high',
      idempotencyKey: 'correction-1',
      expectedVersion: 1,
      db: testDb,
    });
    expect(corrected.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, correctionId: corrected.correctionId });
    expect(corrected.intake).toMatchObject({
      version: 2,
      correctionCount: 1,
      signal: { painScore: 2 },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM athlete_health_signal_corrections').get()).toEqual({ n: 1 });

    expect(() => appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: 3 },
      reason: 'stale edit',
      idempotencyKey: 'correction-stale-version',
      expectedVersion: 1,
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'HEALTH_INTAKE_VERSION_CONFLICT' }));

    const consent = getHealthConsent({ tenantId: 71, userId: 71, db: testDb });
    expect(() => reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: true,
      expectedRevision: consent.revision + 1,
      idempotencyKey: 'withdraw-wrong-version',
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_VERSION_CONFLICT' }));
    const withdrawn = reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: true,
      expectedRevision: consent.revision,
      idempotencyKey: 'withdraw-1',
      db: testDb,
    });
    const withdrawalReplay = reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: true,
      expectedRevision: consent.revision,
      idempotencyKey: 'withdraw-1',
      db: testDb,
    });
    expect(withdrawn.consent).toMatchObject({ withdrawn: true, activeScopes: [] });
    expect(withdrawalReplay.replayed).toBe(true);

    expect(() => reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: false,
      expectedRevision: withdrawn.consent.revision,
      idempotencyKey: 'empty-active-consent',
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'CONSENT_WITHDRAWAL_REQUIRED' }));
  });

  it('enforces tenant isolation in services while keeping the migration predecessor-compatible', () => {
    const created = intake({ key: 'isolation' });
    expect(listStructuredHealthIntakes({ tenantId: 72, userId: 71, db: testDb })).toEqual([]);
    expect(() => appendStructuredHealthCorrection({
      tenantId: 72,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: 1 },
      reason: 'foreign',
      idempotencyKey: 'foreign-correction',
      expectedVersion: 1,
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'HEALTH_INTAKE_NOT_FOUND' }));

    expect(testDb.pragma('foreign_key_list(athlete_health_signal_corrections)')).toEqual([]);
  });

  it('sweeps dormant expired rows in bounded batches, cascades corrections, and clears safety state', () => {
    const created = intake({ key: 'sweep' });
    appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: 8 },
      reason: 'Still painful',
      idempotencyKey: 'sweep-correction',
      expectedVersion: 1,
      db: testDb,
    });
    testDb.prepare(`
      UPDATE athlete_health_signals
      SET date = ?, expires_at = NULL
      WHERE id = ? AND tenant_id = 71 AND user_id = 71
    `).run(daysAgo(366), created.intake.id);

    const swept = sweepExpiredStructuredHealthData({ limit: 1, db: testDb });
    expect(swept).toEqual({ deleted: 1, scopesProcessed: 1, hasMore: false });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM athlete_health_signals').get()).toEqual({ n: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM athlete_health_signal_corrections').get()).toEqual({ n: 0 });
    expect(testDb.prepare(`
      SELECT disposition, source_signal_id FROM training_health_safety_state
      WHERE tenant_id = 71 AND user_id = 71
    `).get()).toEqual({ disposition: 'clear', source_signal_id: null });
  });

  it('uses the injected database for atomic delete-all instead of the process-global store', () => {
    const global = intake({ key: 'global' });
    const isolated = createMigratedTestDatabase();
    try {
      const local = recordStructuredHealthIntake({
        tenantId: 81,
        userId: 81,
        payload: { date: today(), illnessSymptoms: ['fever'], consentScope: ['illness'] },
        idempotencyKey: 'isolated',
        db: isolated,
      });
      const deleted = deleteAllStructuredHealthData({
        tenantId: 81,
        userId: 81,
        idempotencyKey: 'isolated-delete-all',
        db: isolated,
      });
      expect(deleted.healthSignalsDeleted).toBe(1);
      expect(deleted.replayed).toBe(false);
      expect(isolated.prepare('SELECT COUNT(*) AS n FROM athlete_health_signals').get()).toEqual({ n: 0 });
      expect(testDb.prepare('SELECT id FROM athlete_health_signals WHERE id = ?').get(global.intake.id)).toBeDefined();
      expect(local.intake.id).toBeGreaterThan(0);
    } finally {
      isolated.close();
    }
  });

  it('makes corrected, withdrawn, and deleted safety state authoritative and dismisses stale red flags', () => {
    const created = intake({
      key: 'effective-safety',
      painScore: null,
      illnessSymptoms: ['chest_pain'],
      consentScope: ['illness'],
    });
    expect(getEffectiveHealthSafetyOutput({
      tenantId: 71,
      userId: 71,
      affectedDate: today(),
      db: testDb,
    })).toMatchObject({ effectiveSeverity: 'block' });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS n FROM agent_signals
       WHERE tenant_id = 71 AND user_id = 71
         AND signal_type = 'safety_red_flag' AND status = 'active'
    `).get()).toEqual({ n: 1 });

    appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { illnessSymptoms: ['cough'] },
      reason: 'Chest pain was selected by mistake',
      idempotencyKey: 'effective-safety-correction',
      expectedVersion: 1,
      db: testDb,
    });
    expect(getEffectiveHealthSafetyOutput({
      tenantId: 71,
      userId: 71,
      affectedDate: today(),
      db: testDb,
    })?.effectiveSeverity).not.toBe('block');
    expect(testDb.prepare(`
      SELECT COUNT(*) AS n FROM agent_signals
       WHERE tenant_id = 71 AND user_id = 71
         AND signal_type = 'safety_red_flag' AND status = 'active'
    `).get()).toEqual({ n: 0 });

    const consent = getHealthConsent({ tenantId: 71, userId: 71, db: testDb });
    reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: true,
      expectedRevision: consent.revision,
      idempotencyKey: 'effective-safety-withdraw',
      db: testDb,
    });
    expect(getEffectiveHealthSafetyOutput({ tenantId: 71, userId: 71, db: testDb })).toBeUndefined();
    expect(testDb.prepare(`
      SELECT disposition, source_signal_id AS sourceSignalId
        FROM training_health_safety_state
       WHERE tenant_id = 71 AND user_id = 71
    `).get()).toEqual({ disposition: 'clear', sourceSignalId: null });

    expect(deleteStructuredHealthIntake({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      expectedVersion: 2,
      idempotencyKey: 'effective-safety-delete',
      db: testDb,
    })).toMatchObject({ deleted: true, replayed: false });
    expect(getEffectiveHealthSafetyOutput({ tenantId: 71, userId: 71, db: testDb })).toBeUndefined();
  });

  it('keeps coaching range reads behind current consent, retention, and append-only corrections', () => {
    const created = intake({
      key: 'coaching-authority',
      painScore: 7,
      illnessSymptoms: ['fever'],
      injuryStatus: 'none',
      consentScope: ['pain', 'illness', 'injury'],
    });
    expect(findPainSignalsInRange(71, 71, daysAgo(2), today())).toHaveLength(1);
    expect(findIllnessSignalsInRange(71, 71, daysAgo(2), today())).toHaveLength(1);

    appendStructuredHealthCorrection({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      patch: { painScore: null, illnessSymptoms: [] },
      reason: 'The symptoms were selected by mistake',
      idempotencyKey: 'coaching-authority-correction',
      expectedVersion: 1,
      db: testDb,
    });
    expect(findPainSignalsInRange(71, 71, daysAgo(2), today())).toEqual([]);
    expect(findIllnessSignalsInRange(71, 71, daysAgo(2), today())).toEqual([]);

    const consent = getHealthConsent({ tenantId: 71, userId: 71, db: testDb });
    reviseHealthConsent({
      tenantId: 71,
      userId: 71,
      activeScopes: [],
      withdraw: true,
      expectedRevision: consent.revision,
      idempotencyKey: 'coaching-authority-withdrawal',
      db: testDb,
    });
    expect(findPainSignalsInRange(71, 71, daysAgo(2), today())).toEqual([]);
    expect(findIllnessSignalsInRange(71, 71, daysAgo(2), today())).toEqual([]);
  });

  it('CAS-protects and idempotently replays delete-one and delete-all mutations', () => {
    const created = intake({ key: 'delete-cas' });
    expect(() => deleteStructuredHealthIntake({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      expectedVersion: 2,
      idempotencyKey: 'delete-one-stale',
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'HEALTH_INTAKE_VERSION_CONFLICT' }));

    const deleted = deleteStructuredHealthIntake({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      expectedVersion: 1,
      idempotencyKey: 'delete-one-ok',
      db: testDb,
    });
    const replay = deleteStructuredHealthIntake({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id,
      expectedVersion: 1,
      idempotencyKey: 'delete-one-ok',
      db: testDb,
    });
    expect(deleted).toMatchObject({ deleted: true, replayed: false, signalId: created.intake.id });
    expect(replay).toMatchObject({ deleted: true, replayed: true, signalId: created.intake.id });
    expect(() => deleteStructuredHealthIntake({
      tenantId: 71,
      userId: 71,
      signalId: created.intake.id + 1,
      expectedVersion: 1,
      idempotencyKey: 'delete-one-ok',
      db: testDb,
    })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));

    intake({ key: 'delete-all' });
    const all = deleteAllStructuredHealthData({
      tenantId: 71,
      userId: 71,
      idempotencyKey: 'delete-all-ok',
      db: testDb,
    });
    intake({ key: 'created-after-delete-all' });
    const allReplay = deleteAllStructuredHealthData({
      tenantId: 71,
      userId: 71,
      idempotencyKey: 'delete-all-ok',
      db: testDb,
    });
    expect(all).toMatchObject({ replayed: false, healthSignalsDeleted: 1 });
    expect(allReplay).toMatchObject({ replayed: true, healthSignalsDeleted: 1 });
    expect(listStructuredHealthIntakes({ tenantId: 71, userId: 71, db: testDb })).toHaveLength(1);
  });
});
