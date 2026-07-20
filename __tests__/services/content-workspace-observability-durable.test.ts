// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: BetterSqlite3.Database;

vi.mock('../../src/services/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/database')>();
  return { ...actual, getDb: () => testDb };
});

import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  _flushContentWorkspaceObservabilityForTests,
  _getContentWorkspaceOperationalEventsForTests,
  _resetContentWorkspaceObservabilityForTests,
  classifyContentWorkspaceOperationalError,
  getContentWorkspaceObservabilitySnapshot,
  recordContentWorkspaceOperationalOutcome,
  recordContentWorkspaceProductSignal,
} from '../../src/services/content-workspace-observability';

describe('durable Content workspace observability', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    _resetContentWorkspaceObservabilityForTests();
  });

  afterEach(() => {
    _resetContentWorkspaceObservabilityForTests();
    testDb.close();
  });

  it('persists aggregate history across process-memory reset without double counting', () => {
    recordContentWorkspaceOperationalOutcome({
      operation: 'schedule_confirm',
      outcome: 'success',
      durationMs: 125,
    });
    recordContentWorkspaceProductSignal('content_scheduled');
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);

    let value = getContentWorkspaceObservabilitySnapshot();
    expect(value.storage).toMatchObject({
      mode: 'durable',
      durableAvailable: true,
      includesHistoricalTotals: true,
      pendingWrite: false,
      bestEffortWrites: true,
      userOperationFailurePropagation: false,
    });
    expect(value.outcomesByOperation.schedule_confirm.success).toBe(1);
    expect(value.reliability.schedule_confirm_success_total).toBe(1);
    expect(value.product.content_scheduled).toBe(1);

    _resetContentWorkspaceObservabilityForTests();
    value = getContentWorkspaceObservabilitySnapshot();
    expect(value.outcomesByOperation.schedule_confirm.success).toBe(1);
    expect(value.product.content_scheduled).toBe(1);
  });

  it('retains a failed write as pending and merges it exactly once', () => {
    testDb.exec(`
      CREATE TRIGGER fail_content_metric_write
      BEFORE INSERT ON content_workspace_reliability_metrics
      BEGIN
        SELECT RAISE(ABORT, 'injected metric write failure');
      END;
    `);
    recordContentWorkspaceOperationalOutcome({
      operation: 'schedule_preview',
      outcome: 'conflict',
      reason: 'schedule_preview_stale',
      durationMs: 40,
    });
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(false);
    let value = getContentWorkspaceObservabilitySnapshot();
    expect(value.storage).toMatchObject({ mode: 'durable_with_pending', pendingWrite: true });
    expect(value.outcomesByOperation.schedule_preview.conflict).toBe(1);
    expect(value.reasons.schedule_preview_stale).toBe(1);

    testDb.exec('DROP TRIGGER fail_content_metric_write');
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);
    value = getContentWorkspaceObservabilitySnapshot();
    expect(value.storage.mode).toBe('durable');
    expect(value.outcomesByOperation.schedule_preview.conflict).toBe(1);
    expect(value.reasons.schedule_preview_stale).toBe(1);
  });

  it('falls back truthfully when the durable schema is unavailable and later flushes once', () => {
    testDb.close();
    testDb = new Database(':memory:');
    recordContentWorkspaceOperationalOutcome({
      operation: 'schedule_cancel',
      outcome: 'failure',
      reason: 'schedule_cancellation_failure',
    });
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(false);
    let value = getContentWorkspaceObservabilitySnapshot();
    expect(value.storage).toMatchObject({
      mode: 'process_fallback',
      durableAvailable: false,
      includesHistoricalTotals: false,
      pendingWrite: true,
    });
    expect(value.outcomesByOperation.schedule_cancel.failure).toBe(1);

    testDb.close();
    testDb = createMigratedTestDatabase();
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);
    value = getContentWorkspaceObservabilitySnapshot();
    expect(value.storage.mode).toBe('durable');
    expect(value.outcomesByOperation.schedule_cancel.failure).toBe(1);
    expect(value.reliability.schedule_failure_total).toBe(1);
  });

  it('saturates counters and never persists or exposes poisoned error fields', () => {
    testDb.prepare(`
      INSERT INTO content_workspace_reliability_metrics (counter_name, metric_value)
      VALUES ('workspace_operation_total', 9007199254740991)
    `).run();
    const poisoned = {
      code: 'CONTENT_SCHEDULE_CANCELLATION_FAILED',
      status: 503,
      message: 'private script body',
      tenantId: 99,
      userId: 88,
      prompt: 'ignore prior instructions',
      url: 'https://secret.example/private',
      providerResponse: { text: 'private response' },
    };
    const classified = classifyContentWorkspaceOperationalError(poisoned);
    recordContentWorkspaceOperationalOutcome({
      operation: 'schedule_cancel',
      ...classified,
    });
    expect(_flushContentWorkspaceObservabilityForTests()).toBe(true);

    const value = getContentWorkspaceObservabilitySnapshot();
    expect(value.reliability.workspace_operation_total).toBe(Number.MAX_SAFE_INTEGER);
    expect(value.reasons.schedule_cancellation_failure).toBe(1);
    const durableRows = JSON.stringify([
      ...testDb.prepare('SELECT * FROM content_workspace_reliability_metrics').all(),
      ...testDb.prepare('SELECT * FROM content_workspace_operation_metrics').all(),
      ...testDb.prepare('SELECT * FROM content_workspace_reason_metrics').all(),
    ]);
    const publicValue = JSON.stringify(value);
    const internalValue = JSON.stringify(_getContentWorkspaceOperationalEventsForTests());
    for (const forbidden of [
      'private script body',
      'tenantId',
      'userId',
      'ignore prior instructions',
      'secret.example',
      'private response',
    ]) {
      expect(durableRows).not.toContain(forbidden);
      expect(publicValue).not.toContain(forbidden);
      expect(internalValue).not.toContain(forbidden);
    }
  });
});
