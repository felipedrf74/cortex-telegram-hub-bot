/**
 * Tests for src/services/audit-trail.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
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

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { logAudit, getAuditTrail } from '../../src/services/audit-trail';

describe('audit-trail', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { testDb.close(); });

  it('logAudit creates entry in audit_trail table', () => {
    logAudit({
      userId: 1,
      actorId: 1,
      action: 'export',
      resource: 'all',
      details: { conversations: 5, todos: 3 },
    });

    const rows = testDb.prepare('SELECT * FROM audit_trail').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(1);
    expect(rows[0].actor_id).toBe(1);
    expect(rows[0].action).toBe('export');
    expect(rows[0].resource).toBe('all');
    expect(JSON.parse(rows[0].details)).toEqual({ conversations: 5, todos: 3 });
  });

  it('getAuditTrail returns entries for specific user', () => {
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });
    logAudit({ userId: 2, actorId: 2, action: 'export', resource: 'all' });
    logAudit({ userId: 1, actorId: 1, action: 'delete', resource: 'all' });

    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(2);
    expect(trail.every(e => e.actorId === 1)).toBe(true);
  });

  it('getAuditTrail respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      logAudit({ userId: 1, actorId: 1, action: 'access', resource: 'finance' });
    }

    const trail = getAuditTrail(1, 3);
    expect(trail).toHaveLength(3);
  });

  it('entries include timestamp, action, resource, details', () => {
    logAudit({
      userId: 1,
      actorId: 99,
      action: 'delete',
      resource: 'conversations',
      details: { count: 42 },
    });

    const trail = getAuditTrail(1);
    expect(trail[0].ts).toBeTruthy();
    expect(trail[0].action).toBe('delete');
    expect(trail[0].resource).toBe('conversations');
    expect(trail[0].actorId).toBe(99);
    expect(trail[0].details).toBe(JSON.stringify({ count: 42 }));
  });

  it('handles null details gracefully', () => {
    logAudit({ userId: 1, actorId: 1, action: 'access', resource: 'finance' });

    const trail = getAuditTrail(1);
    expect(trail[0].details).toBeNull();
  });

  it('stores ip_address when provided', () => {
    logAudit({
      userId: 1,
      actorId: 1,
      action: 'access',
      resource: 'finance',
      ipAddress: '192.168.1.1',
    });

    const rows = testDb.prepare('SELECT ip_address FROM audit_trail').all() as any[];
    expect(rows[0].ip_address).toBe('192.168.1.1');
  });
});
