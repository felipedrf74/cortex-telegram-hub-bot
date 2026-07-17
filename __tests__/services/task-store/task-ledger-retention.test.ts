// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Task ledger retention prune (M2B).
 *
 * The load-bearing contract is the NEGATIVE space: the job must delete
 * exactly the terminal, actionless classes and NEVER touch live repair
 * state — a 100-day-old conflict mutation is still a conflict the user must
 * resolve, and an open issue still backs a visible sync warning.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../../src/services/database', () => ({
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

import {
  TASK_LEDGER_RETENTION_POLICY,
  runTaskLedgerRetentionJob,
} from '../../../src/services/task-store/task-ledger-retention';

const USER_ID = 42;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE task_mutations (
      mutation_id TEXT PRIMARY KEY,
      client_mutation_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      operation TEXT NOT NULL,
      patch_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      locked_at TEXT,
      last_error_code TEXT,
      last_error_message TEXT
    );

    CREATE TABLE task_sync_issues (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      provider TEXT,
      code TEXT NOT NULL,
      message TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );

    CREATE TABLE task_sync_observability_events (
      id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      provider TEXT,
      event_type TEXT NOT NULL,
      operation TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedMutation(id: string, status: string, createdDaysAgo: number): void {
  testDb.prepare(
    `INSERT INTO task_mutations (
       mutation_id, client_mutation_id, idempotency_key, tenant_id, user_id,
       task_id, operation, created_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, 'task.update', ?, ?)`,
  ).run(id, `c-${id}`, `i-${id}`, USER_ID, USER_ID, `task-${id}`, daysAgo(createdDaysAgo), status);
}

function seedIssue(id: string, state: string, resolvedDaysAgo: number | null, createdDaysAgo = 200): void {
  testDb.prepare(
    `INSERT INTO task_sync_issues (
       id, task_id, tenant_id, user_id, code, state, created_at, resolved_at
     ) VALUES (?, ?, ?, ?, 'provider_conflict', ?, ?, ?)`,
  ).run(id, `task-${id}`, USER_ID, USER_ID, state, daysAgo(createdDaysAgo), resolvedDaysAgo == null ? null : daysAgo(resolvedDaysAgo));
}

function seedObservabilityEvent(id: string, createdDaysAgo: number): void {
  testDb.prepare(
    `INSERT INTO task_sync_observability_events (
       id, tenant_id, user_id, event_type, created_at
     ) VALUES (?, ?, ?, 'duplicate_prevention_hit', ?)`,
  ).run(id, USER_ID, USER_ID, daysAgo(createdDaysAgo));
}

function remainingMutationIds(): string[] {
  return (testDb.prepare('SELECT mutation_id FROM task_mutations ORDER BY mutation_id').all() as Array<{ mutation_id: string }>)
    .map((row) => row.mutation_id);
}

beforeEach(() => {
  testDb = createTestDb();
});

describe('runTaskLedgerRetentionJob', () => {
  it('deletes exactly the eligible classes and never live repair state (seed matrix)', () => {
    // Eligible: terminal, actionless, past their horizon.
    seedMutation('old-synced', 'synced', 100);
    seedMutation('old-dead-letter', 'dead_letter', 100);
    seedMutation('old-superseded', 'superseded', 100);
    // NEVER eligible regardless of age: live repair state.
    seedMutation('old-conflict', 'conflict', 100);
    seedMutation('old-failed', 'failed', 100);
    seedMutation('old-queued', 'queued', 100);
    seedMutation('old-syncing', 'syncing', 100);
    seedMutation('old-accepted-local', 'accepted_local', 100);
    // Terminal but inside the horizon.
    seedMutation('young-synced', 'synced', 10);
    seedMutation('young-superseded', 'superseded', 89);

    seedIssue('issue-old-resolved', 'resolved', 100);
    seedIssue('issue-young-resolved', 'resolved', 10);
    seedIssue('issue-open-ancient', 'open', null, 400);

    seedObservabilityEvent('evt-old', 40);
    seedObservabilityEvent('evt-young', 10);

    const result = runTaskLedgerRetentionJob();

    expect(result).toMatchObject({
      mutationsPruned: 3,
      resolvedIssuesPruned: 1,
      observabilityEventsPruned: 1,
      mutationsRemaining: 0,
      resolvedIssuesRemaining: 0,
      observabilityEventsRemaining: 0,
    });
    expect(remainingMutationIds()).toEqual([
      'old-accepted-local',
      'old-conflict',
      'old-failed',
      'old-queued',
      'old-syncing',
      'young-superseded',
      'young-synced',
    ]);
    expect(
      (testDb.prepare('SELECT id FROM task_sync_issues ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['issue-open-ancient', 'issue-young-resolved']);
    expect(
      (testDb.prepare('SELECT id FROM task_sync_observability_events').all() as Array<{ id: string }>).map((row) => row.id),
    ).toEqual(['evt-young']);
  });

  it('a 100-day-old conflict mutation survives every run (regression pin)', () => {
    seedMutation('ancient-conflict', 'conflict', 100);

    const first = runTaskLedgerRetentionJob();
    const second = runTaskLedgerRetentionJob();

    expect(first.mutationsPruned).toBe(0);
    expect(second.mutationsPruned).toBe(0);
    expect(remainingMutationIds()).toEqual(['ancient-conflict']);
  });

  it('prunes large terminal backlogs in bounded batches and reports the remainder', () => {
    for (let index = 0; index < 7; index += 1) {
      seedMutation(`bulk-${index}`, 'superseded', 120);
    }

    const capped = runTaskLedgerRetentionJob({ batchSize: 2, maxBatches: 2 });

    expect(capped.mutationsPruned).toBe(4);
    expect(capped.mutationsRemaining).toBe(3);
    expect(capped.batches).toBeGreaterThanOrEqual(2);

    const rest = runTaskLedgerRetentionJob({ batchSize: 2, maxBatches: 10 });
    expect(rest.mutationsPruned).toBe(3);
    expect(rest.mutationsRemaining).toBe(0);
  });

  it('exposes the declared horizons (90/90/30 days)', () => {
    expect(TASK_LEDGER_RETENTION_POLICY).toEqual({
      mutationRetentionDays: 90,
      resolvedIssueRetentionDays: 90,
      observabilityRetentionDays: 30,
    });
  });
});
