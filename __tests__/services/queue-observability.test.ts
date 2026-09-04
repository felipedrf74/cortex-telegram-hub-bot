import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  findDeadLetterTenant,
  getQueueSummary,
  isDeadLetterKind,
  listDeadLetterItems,
  parseSqliteTimestamp,
} from '../../src/services/queue-observability';

let db: Database.Database;

function sqliteTs(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

function insertJob(input: {
  id: string; tenantId?: number; userId?: number | null; type?: string; status?: string;
  notBefore?: string; createdAt?: string; attempts?: number; lastError?: string | null; completedAt?: string | null;
}): void {
  db.prepare(`
    INSERT INTO background_jobs (job_id, tenant_id, user_id, job_type, idempotency_key, status, attempts, max_attempts,
                                 not_before, created_at, completed_at, last_error, correlation_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 3, ?, ?, ?, ?, ?)
  `).run(
    input.id, input.tenantId ?? 1, input.userId ?? null, input.type ?? 'digest', `idem-${input.id}`,
    input.status ?? 'pending', input.attempts ?? 0, input.notBefore ?? sqliteTs(0), input.createdAt ?? sqliteTs(0),
    input.completedAt ?? null, input.lastError ?? null, `corr-${input.id}`,
  );
}

function insertEvent(input: { id: string; tenantId?: number; type?: string; status?: string; attempts?: number; lastError?: string | null }): void {
  db.prepare(`
    INSERT INTO event_outbox (event_id, tenant_id, user_id, source_skill, event_type, entity_type, entity_id,
                              idempotency_key, status, attempts, last_error)
    VALUES (?, ?, NULL, 'secretary', ?, 'todo', ?, ?, ?, ?, ?)
  `).run(input.id, input.tenantId ?? 1, input.type ?? 'todo.created', input.id, `idem-${input.id}`, input.status ?? 'pending', input.attempts ?? 0, input.lastError ?? null);
}

beforeEach(() => {
  db = createMigratedTestDatabase();
});

afterEach(() => {
  db.close();
});

describe('parseSqliteTimestamp', () => {
  it('parses SQLite text and ISO-8601 as UTC', () => {
    expect(parseSqliteTimestamp('2026-09-04 10:00:00')).toBe(Date.UTC(2026, 8, 4, 10));
    expect(parseSqliteTimestamp('2026-09-04T10:00:00Z')).toBe(Date.UTC(2026, 8, 4, 10));
    expect(parseSqliteTimestamp('2026-09-04T12:00:00+02:00')).toBe(Date.UTC(2026, 8, 4, 10));
    expect(parseSqliteTimestamp('')).toBeNull();
    expect(parseSqliteTimestamp(null)).toBeNull();
    expect(parseSqliteTimestamp('not a date')).toBeNull();
  });
});

describe('getQueueSummary', () => {
  it('reports empty queues without throwing', () => {
    const summary = getQueueSummary(db);
    expect(summary.backgroundJobs).toMatchObject({ total: 0, deadLetter: 0, oldestPendingAgeSec: null, byType: [] });
    expect(summary.eventOutbox).toMatchObject({ total: 0, deadLetter: 0, oldestPendingAgeSec: null, byType: [] });
  });

  it('counts by status and type and ages the oldest runnable pending item', () => {
    insertJob({ id: 'j1', status: 'pending', notBefore: sqliteTs(3_600_000), type: 'digest' });
    insertJob({ id: 'j2', status: 'pending', notBefore: sqliteTs(60_000), type: 'digest' });
    insertJob({ id: 'j3', status: 'processing', type: 'sync' });
    insertJob({ id: 'j4', status: 'dead_letter', type: 'sync', lastError: 'boom', createdAt: sqliteTs(1_000) });
    insertJob({ id: 'j5', status: 'failed', type: 'sync', createdAt: sqliteTs(2 * 24 * 3_600_000) });
    insertEvent({ id: 'e1', status: 'pending' });
    insertEvent({ id: 'e2', status: 'dead_letter', lastError: 'handler threw' });
    insertEvent({ id: 'e3', status: 'processed' });

    const summary = getQueueSummary(db);
    expect(summary.backgroundJobs.byStatus).toEqual({ pending: 2, processing: 1, dead_letter: 1, failed: 1 });
    expect(summary.backgroundJobs.total).toBe(5);
    expect(summary.backgroundJobs.deadLetter).toBe(1);
    expect(summary.backgroundJobs.failedLast24h).toBe(1);
    expect(summary.backgroundJobs.oldestPendingAgeSec).toBeGreaterThanOrEqual(3_595);
    expect(summary.backgroundJobs.oldestPendingAgeSec).toBeLessThanOrEqual(3_610);
    expect(summary.backgroundJobs.byType).toEqual([
      { type: 'sync', pending: 0, deadLetter: 1, total: 3 },
      { type: 'digest', pending: 2, deadLetter: 0, total: 2 },
    ]);
    expect(summary.eventOutbox.byStatus).toEqual({ pending: 1, dead_letter: 1, processed: 1 });
    expect(summary.eventOutbox.deadLetter).toBe(1);
    expect(summary.eventOutbox.byType).toEqual([{ type: 'todo.created', pending: 1, deadLetter: 1, total: 3 }]);
  });

  it('never reports a negative age for a pending item scheduled in the future', () => {
    insertJob({ id: 'future', status: 'pending', notBefore: sqliteTs(-3_600_000) });
    expect(getQueueSummary(db).backgroundJobs.oldestPendingAgeSec).toBe(0);
  });
});

describe('listDeadLetterItems / findDeadLetterTenant', () => {
  it('lists dead-letter jobs newest first with truncated errors', () => {
    insertJob({ id: 'old', status: 'dead_letter', tenantId: 2, userId: 9, attempts: 3, lastError: 'x'.repeat(700), createdAt: sqliteTs(120_000), completedAt: sqliteTs(100_000) });
    insertJob({ id: 'new', status: 'dead_letter', tenantId: 3, attempts: 3, lastError: 'short', createdAt: sqliteTs(10_000) });
    insertJob({ id: 'live', status: 'pending' });

    const items = listDeadLetterItems({ kind: 'jobs' }, db);
    expect(items.map((item) => item.id)).toEqual(['new', 'old']);
    expect(items[1]).toMatchObject({ kind: 'job', tenantId: 2, userId: 9, type: 'digest', attempts: 3, maxAttempts: 3, correlationId: 'corr-old' });
    expect(items[1].lastError).toHaveLength(500);
    expect(items[1].failedAt).not.toBeNull();
    expect(listDeadLetterItems({ kind: 'jobs', limit: 1 }, db)).toHaveLength(1);
  });

  it('lists dead-letter events and resolves their tenant', () => {
    insertEvent({ id: 'e-dead', status: 'dead_letter', tenantId: 5, attempts: 4, lastError: 'handler threw' });
    insertEvent({ id: 'e-ok', status: 'pending', tenantId: 5 });

    const items = listDeadLetterItems({ kind: 'events' }, db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'event', id: 'e-dead', tenantId: 5, type: 'todo.created', attempts: 4, maxAttempts: null, lastError: 'handler threw' });

    expect(findDeadLetterTenant('events', 'e-dead', db)).toBe(5);
    expect(findDeadLetterTenant('events', 'e-ok', db)).toBeNull();
    expect(findDeadLetterTenant('jobs', 'missing', db)).toBeNull();
  });

  it('validates kinds', () => {
    expect(isDeadLetterKind('jobs')).toBe(true);
    expect(isDeadLetterKind('events')).toBe(true);
    expect(isDeadLetterKind('outbox')).toBe(false);
    expect(isDeadLetterKind(undefined)).toBe(false);
  });
});
