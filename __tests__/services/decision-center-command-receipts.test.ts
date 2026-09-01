import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import { createDecisionMutationCommand } from '../../src/services/decision-center/contracts';
import { executeDecisionMutationWithReceipt } from '../../src/services/decision-center/command-receipts';

function command(payload: Readonly<Record<string, unknown>> = { pushEnabled: true }) {
  return createDecisionMutationCommand({
    commandId: 'command-preferences-1',
    decisionId: 'decision-preferences',
    operation: 'update_preferences',
    actionId: 'update_preferences',
    scope: { userId: 7, tenantId: 11 },
    channel: 'rest',
    idempotencyKey: 'preferences-attempt-1',
    recordVersion: null,
    contextVersion: null,
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision-center.update_preferences',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: true,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'decision-center.update_preferences.readback',
      entityType: 'decision_center_preferences',
      entityId: 'decision-preferences',
      mode: 'exact',
      expectedState: {},
    },
    payload,
    requestedAt: '2026-08-31T10:00:00.000Z',
  });
}

describe('Decision Center command receipts', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE decision_lifecycle_events (
        event_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        event TEXT NOT NULL,
        action_id TEXT,
        reason TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE mutation_effects (value TEXT NOT NULL);
    `);
  });

  afterEach(() => testDb.close());

  it('persists the exact readback once and replays it without executing again', () => {
    let executions = 0;
    const first = executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: true };
    });
    const replay = executeDecisionMutationWithReceipt(command(), () => {
      executions += 1;
      return { pushEnabled: false };
    });

    expect(first).toEqual({ result: { pushEnabled: true }, idempotent: false });
    expect(replay).toEqual({ result: { pushEnabled: true }, idempotent: true });
    expect(executions).toBe(1);
    expect(testDb.prepare("SELECT COUNT(*) AS count FROM decision_lifecycle_events WHERE event = 'mutation_receipt'").get())
      .toEqual({ count: 1 });
  });

  it('rejects reuse of a key for a different command payload', () => {
    executeDecisionMutationWithReceipt(command(), () => ({ pushEnabled: true }));

    expect(() => executeDecisionMutationWithReceipt(command({ pushEnabled: false }), () => ({ pushEnabled: false })))
      .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it('rolls back both the domain effect and receipt when the mutation fails', () => {
    expect(() => executeDecisionMutationWithReceipt(command(), () => {
      testDb.prepare('INSERT INTO mutation_effects (value) VALUES (?)').run('written');
      throw new Error('rollback');
    })).toThrow('rollback');

    expect(testDb.prepare('SELECT COUNT(*) AS count FROM mutation_effects').get()).toEqual({ count: 0 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM decision_lifecycle_events').get()).toEqual({ count: 0 });
  });
});
