// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * F24 RED contract — a week-reflow apply commits desired schedule state,
 * adaptation audit, and a durable reconciliation request together. Provider
 * effects remain post-commit; the route-level orchestrator exposes that split
 * truthfully and invalidates Training reads only for a fresh mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const f24Mocks = vi.hoisted(() => ({
  withLock: vi.fn(),
  invalidateTraining: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database'
  )),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/training-operation-locks', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-operation-locks')>(
    '../../src/services/training-operation-locks',
  );
  return {
    ...actual,
    withTrainingCalendarOperationLock: (...args: unknown[]) => f24Mocks.withLock(...args),
  };
});

vi.mock('../../src/services/cache-coherence-registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  );
  return {
    ...actual,
    invalidateTrainingDerivedCaches: (...args: unknown[]) => f24Mocks.invalidateTraining(...args),
  };
});

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  executeWeekReflowUnderExistingAdaptLock,
  executeWeekReflowWithPropagation,
} from '../../src/services/training-week-reflow-propagation';

const USER_ID = 42;
const TENANT_ID = 42;
const PLAN_ID = 240;
const WEEK_ID = 241;
const SESSION_ID = 242;

function productionTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.ts') ? [candidate] : [];
  });
}

function seedScope(): void {
  testDb.prepare(`
    INSERT INTO fitness_training_plans
      (id, user_id, tenant_id, name, sport, status, start_date, end_date,
       duration_weeks, plan_version, adaptation_revision, created_at)
    VALUES (?, ?, ?, 'F24', 'running', 'active', '2026-03-02', '2026-03-16',
            2, 1, 0, datetime('now'))
  `).run(PLAN_ID, USER_ID, TENANT_ID);
  testDb.prepare(`
    INSERT INTO training_weeks
      (id, plan_id, week_number, focus, intensity_pct, auto_adjusted, created_at)
    VALUES (?, ?, 1, 'base', 70, 0, datetime('now'))
  `).run(WEEK_ID, PLAN_ID);
  testDb.prepare(`
    INSERT INTO training_sessions
      (id, week_id, plan_id, day_of_week, session_type, title,
       duration_minutes, status, scheduled_start_at, scheduled_end_at,
       schedule_status, calendar_event_id, calendar_source, created_at)
    VALUES (?, ?, ?, 'Tuesday', 'run', 'Tempo', 60, 'scheduled',
            '2026-03-03T07:00:00.000Z', '2026-03-03T08:00:00.000Z',
            'scheduled', 'evt-f24', 'google', datetime('now'))
  `).run(SESSION_ID, WEEK_ID, PLAN_ID);
}

function applyInput(idempotencyKey: string) {
  return {
    userId: USER_ID,
    tenantId: TENANT_ID,
    planId: PLAN_ID,
    planVersion: 1,
    weekId: WEEK_ID,
    mode: 'apply' as const,
    trigger: 'manual_reflow',
    idempotencyKey,
    sciencePolicyVersion: 'f24-test',
    syncTarget: 'google' as const,
    applyMutation: (db: Database.Database) => {
      const update = db.prepare(`
        UPDATE training_sessions
           SET day_of_week = 'Thursday', status = 'reflowed',
               schedule_status = 'reflowed',
               scheduled_start_at = '2026-03-05T07:00:00.000Z',
               scheduled_end_at = '2026-03-05T08:00:00.000Z'
         WHERE id = ? AND plan_id = ?
      `).run(SESSION_ID, PLAN_ID);
      return {
        mutatedRows: update.changes,
        affectedSessionIds: [SESSION_ID],
        perActionResults: [{ sessionId: SESSION_ID, mutatedRows: update.changes }],
      };
    },
  };
}

describe('F24 — week reflow durable propagation boundary', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    f24Mocks.withLock.mockReset();
    f24Mocks.invalidateTraining.mockReset();
    f24Mocks.withLock.mockImplementation(async (_scope: unknown, run: (lease: unknown) => unknown) => {
      // Reflow now fences desired state and its outbox emission inside the
      // same transaction; mirror the production lease contract in tests.
      const signal = new AbortController().signal;
      return run(Object.assign(() => {}, { signal, assertActive: vi.fn() }));
    });
    seedScope();
  });

  afterEach(() => testDb.close());

  it('commits one sanitizer-safe, revision-fenced request with exact affected ids', async () => {
    const result = await executeWeekReflowWithPropagation(applyInput('f24-atomic-1'));

    expect(result).toMatchObject({
      mutated: true,
      alreadyExisted: false,
      adaptationRevision: 1,
      propagation: { state: 'not_synced', pending: true },
    });
    expect(f24Mocks.withLock).toHaveBeenCalledWith(
      {
        userId: USER_ID,
        tenantId: TENANT_ID,
        planId: PLAN_ID,
        operation: 'calendar_reflow',
      },
      expect.any(Function),
    );
    expect(f24Mocks.invalidateTraining).toHaveBeenCalledTimes(1);
    expect(f24Mocks.invalidateTraining).toHaveBeenCalledWith(USER_ID);

    const rows = testDb.prepare(`
      SELECT event_type, entity_version, payload_json, idempotency_key
      FROM event_outbox WHERE source_skill = 'training'
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'training.plan_calendar_sync.requested.v1',
      entity_version: 1,
      idempotency_key: `training.plan_reflow_sync.requested:${PLAN_ID}:1`,
    });
    expect(JSON.parse(String(rows[0]?.payload_json))).toEqual({
      operation: 'week_reflow',
      planId: PLAN_ID,
      planVersion: 1,
      adaptationRevision: 1,
      weekId: WEEK_ID,
      sessionIds: [SESSION_ID],
      // Ordinary session moves remain week-scoped; only a successfully
      // applied pause action may widen reconciliation to the whole plan.
      reflowScope: 'week',
      syncTarget: 'google',
    });
  });

  it('rolls back session, revision, ledger, and outbox when request insertion fails', async () => {
    testDb.exec(`
      CREATE TRIGGER f24_abort_reflow_outbox
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'training.plan_calendar_sync.requested.v1'
      BEGIN
        SELECT RAISE(ABORT, 'f24 forced outbox failure');
      END;
    `);

    await expect(
      executeWeekReflowWithPropagation(applyInput('f24-atomic-abort')),
    ).rejects.toThrow(/f24 forced outbox failure/);

    expect(testDb.prepare(`
      SELECT day_of_week, status, scheduled_start_at
      FROM training_sessions WHERE id = ?
    `).get(SESSION_ID)).toMatchObject({
      day_of_week: 'Tuesday',
      status: 'scheduled',
      scheduled_start_at: '2026-03-03T07:00:00.000Z',
    });
    expect(testDb.prepare(
      'SELECT adaptation_revision FROM fitness_training_plans WHERE id = ?',
    ).get(PLAN_ID)).toMatchObject({ adaptation_revision: 0 });
    expect(testDb.prepare(
      'SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = ?',
    ).get(PLAN_ID)).toMatchObject({ n: 0 });
    expect(testDb.prepare(
      'SELECT COUNT(*) AS n FROM event_outbox WHERE source_skill = ?',
    ).get('training')).toMatchObject({ n: 0 });
    expect(f24Mocks.invalidateTraining).not.toHaveBeenCalled();
  });

  it('replays the same idempotency key without a second mutation, request, or invalidation', async () => {
    const first = await executeWeekReflowWithPropagation(applyInput('f24-replay'));
    const replay = await executeWeekReflowWithPropagation(applyInput('f24-replay'));

    expect(first.mutated).toBe(true);
    expect(replay).toMatchObject({ alreadyExisted: true, mutated: false });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS n FROM event_outbox WHERE source_skill = 'training'",
    ).get()).toMatchObject({ n: 1 });
    expect(f24Mocks.invalidateTraining).toHaveBeenCalledTimes(1);
  });

  it('does not lock, enqueue, or invalidate a preview', async () => {
    const result = await executeWeekReflowWithPropagation({
      ...applyInput('unused-preview-key'),
      mode: 'preview' as const,
      applyMutation: undefined,
    });

    expect(result).toMatchObject({ mode: 'preview', mutated: false });
    expect(f24Mocks.withLock).not.toHaveBeenCalled();
    expect(f24Mocks.invalidateTraining).not.toHaveBeenCalled();
    expect(testDb.prepare(
      "SELECT COUNT(*) AS n FROM event_outbox WHERE source_skill = 'training'",
    ).get()).toMatchObject({ n: 0 });
  });

  it('rejects tenant scope mismatch before taking a lock or mutating', async () => {
    await expect(executeWeekReflowWithPropagation({
      ...applyInput('f24-foreign-scope'),
      tenantId: TENANT_ID + 1,
    })).rejects.toThrow(/scope/i);

    expect(f24Mocks.withLock).not.toHaveBeenCalled();
    expect(f24Mocks.invalidateTraining).not.toHaveBeenCalled();
    expect(testDb.prepare(
      'SELECT day_of_week FROM training_sessions WHERE id = ?',
    ).get(SESSION_ID)).toMatchObject({ day_of_week: 'Tuesday' });
  });

  it('uses an existing adapt lease and emits a plan-scoped request for an applied pause', () => {
    const lease = { assertActive: vi.fn() };
    const result = executeWeekReflowUnderExistingAdaptLock({
      ...applyInput('f24-existing-adapt-lock'),
      applyMutation: (db: Database.Database) => {
        const update = db.prepare(`
          UPDATE training_sessions SET status = 'canceled' WHERE id = ? AND plan_id = ?
        `).run(SESSION_ID, PLAN_ID);
        return {
          mutatedRows: update.changes,
          affectedSessionIds: [SESSION_ID],
          perActionResults: [{
            action: { type: 'pause_training' },
            skipped: false,
            mutatedRows: update.changes,
          }],
        };
      },
    }, lease);

    expect(result).toMatchObject({
      mutated: true,
      propagation: { state: 'not_synced', pending: true },
    });
    expect(lease.assertActive).toHaveBeenCalled();
    const row = testDb.prepare(`
      SELECT payload_json FROM event_outbox
      WHERE event_type = 'training.plan_calendar_sync.requested.v1'
    `).get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ reflowScope: 'plan' });
  });

  it('rejects preview mode at the existing-lock mutation seam', () => {
    expect(() => executeWeekReflowUnderExistingAdaptLock({
      ...applyInput('f24-existing-lock-preview'),
      mode: 'preview',
      applyMutation: undefined,
    }, { assertActive: vi.fn() })).toThrow(/REQUIRES_APPLY/);
  });

  it('does not enqueue propagation when an existing-lock apply has no affected sessions', () => {
    const result = executeWeekReflowUnderExistingAdaptLock({
      ...applyInput('f24-existing-lock-noop'),
      applyMutation: () => ({
        mutatedRows: 0,
        affectedSessionIds: [],
        perActionResults: [],
      }),
    }, { assertActive: vi.fn() });

    expect(result.propagation).toEqual({
      state: 'not_synced',
      pending: false,
      adaptationRevision: 1,
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS n FROM event_outbox
      WHERE event_type = 'training.plan_calendar_sync.requested.v1'
    `).get()).toMatchObject({ n: 0 });
  });

  it('keeps every production reflow entrypoint behind the durable propagation wrapper', () => {
    const sourceRoot = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    for (const file of productionTypeScriptFiles(sourceRoot)) {
      const relative = path.relative(sourceRoot, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!/\bexecuteWeekReflow\s*\(/.test(line)) return;
        if (relative === 'services/training-week-reflow-propagation.ts') return;
        if (relative === 'services/training-week-reflow.ts'
            && /export function executeWeekReflow\s*\(/.test(line)) return;
        offenders.push(`${relative}:${index + 1}`);
      });
    }

    expect(offenders, 'bare executeWeekReflow calls bypass atomic outbox propagation').toEqual([]);
  });
});
