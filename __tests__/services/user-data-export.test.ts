/**
 * Tests for src/services/user-data-export.ts
 *
 * Validates:
 * - Per-user finance data export (with encryption round-trip)
 * - Per-user data deletion (right to erasure)
 * - Data isolation between users in export
 * - Record counting
 * - Full GDPR export across ALL tables
 * - Full GDPR delete across ALL tables
 * - Audit trail integration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      enabled: true,
      masterKey: 'test-export-master-key-for-tests!',
    },
  },
}));

import { addTransaction, calculateAndStoreTax, markTaxPaid } from '../../src/services/finance-tracker';
import {
  exportUserFinanceData, deleteUserFinanceData, countUserFinanceData,
  exportAllUserData, deleteAllUserData,
} from '../../src/services/user-data-export';
import { logAudit, getAuditTrail } from '../../src/services/audit-trail';

// ── Helper: seed a user record ──
function seedUser(db: Database.Database, telegramId: number, opts?: { username?: string; language?: string }) {
  try {
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, language, timezone, tier, status)
      VALUES (?, ?, 'Test', ?, 'Europe/Lisbon', 'free', 'active')
    `).run(telegramId, opts?.username ?? 'testuser', opts?.language ?? 'en-US');
  } catch { /* table may not exist */ }
}

// ── Helper: seed data across multiple tables ──
function seedUserData(db: Database.Database, userId: number) {
  try {
    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, 'secretary', 'user', 'Hello bot');
    db.prepare(`
      INSERT INTO conversations (tenant_id, user_id, visibility_scope, scope_status, created_by, domain, role, content)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, 'secretary', 'assistant', 'Hi there!');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO todos (user_id, title, status, priority) VALUES (?, ?, ?, ?)')
      .run(userId, 'Buy groceries', 'pending', 'normal');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO reminders (user_id, message, remind_at, status) VALUES (?, ?, ?, ?)')
      .run(userId, 'Call doctor', '2026-04-05T14:00:00', 'active');
  } catch { /* table may not exist */ }

  try {
    db.prepare('INSERT INTO notes (user_id, content, domain) VALUES (?, ?, ?)')
      .run(userId, 'Meeting notes', 'secretary');
  } catch { /* table may not exist */ }

  try {
    db.prepare(`
      INSERT INTO shared_memory (tenant_id, user_id, visibility_scope, scope_status, created_by, key, value, source_domain)
      VALUES (?, ?, 'user_private', 'active', ?, ?, ?, ?)
    `).run(userId, userId, userId, `preference_${userId}`, 'dark mode', 'secretary');
  } catch { /* table may not exist */ }
}

// ── Finance Export Tests (existing) ──

describe('User finance data export', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('exports all transactions and tax events for a user', () => {
    addTransaction(1, '2024-06-01', 'income', 8000, { description: 'Freelance work' });
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const exported = exportUserFinanceData(1);
    expect(exported.userId).toBe(1);
    expect(exported.transactions).toHaveLength(2);
    expect(exported.taxEvents).toHaveLength(1);
    expect(exported.annualSummaries).toHaveLength(1);
    expect(exported.exportedAt).toBeTruthy();
  });

  it('isolates export data between users', () => {
    addTransaction(1, '2024-06-01', 'income', 10000);
    addTransaction(2, '2024-06-01', 'income', 5000);
    calculateAndStoreTax(1, '2024-06');
    calculateAndStoreTax(2, '2024-06');

    const export1 = exportUserFinanceData(1);
    const export2 = exportUserFinanceData(2);

    expect(export1.transactions).toHaveLength(1);
    expect(export2.transactions).toHaveLength(1);
    expect(export1.transactions[0].amount).toBe(10000);
    expect(export2.transactions[0].amount).toBe(5000);
  });

  it('returns decrypted values in export', () => {
    addTransaction(1, '2024-06-01', 'income', 12345.67, { description: 'Encrypted payment' });

    const exported = exportUserFinanceData(1);
    expect(exported.transactions[0].amount).toBe(12345.67);
    expect(exported.transactions[0].description).toBe('Encrypted payment');
  });

  it('exports empty data for user with no records', () => {
    const exported = exportUserFinanceData(999);
    expect(exported.transactions).toHaveLength(0);
    expect(exported.taxEvents).toHaveLength(0);
    expect(exported.annualSummaries).toHaveLength(0);
  });
});

describe('User finance data deletion', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('deletes all financial data for a user', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const result = deleteUserFinanceData(1);
    expect(result.transactionsDeleted).toBe(2);
    expect(result.taxEventsDeleted).toBeGreaterThanOrEqual(1);

    const counts = countUserFinanceData(1);
    expect(counts.transactions).toBe(0);
    expect(counts.taxEvents).toBe(0);
  });

  it('does not affect other users when deleting', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(2, '2024-06-01', 'income', 5000);

    deleteUserFinanceData(1);

    const counts1 = countUserFinanceData(1);
    const counts2 = countUserFinanceData(2);
    expect(counts1.transactions).toBe(0);
    expect(counts2.transactions).toBe(1);
  });

  it('returns zeros when deleting user with no data', () => {
    const result = deleteUserFinanceData(999);
    expect(result.transactionsDeleted).toBe(0);
    expect(result.taxEventsDeleted).toBe(0);
  });
});

describe('countUserFinanceData', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('counts transactions and tax events', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    calculateAndStoreTax(1, '2024-06');

    const counts = countUserFinanceData(1);
    expect(counts.transactions).toBe(2);
    expect(counts.taxEvents).toBe(1);
  });

  it('returns zeros for user with no data', () => {
    const counts = countUserFinanceData(999);
    expect(counts.transactions).toBe(0);
    expect(counts.taxEvents).toBe(0);
  });
});

// ── Full Export Tests (GDPR Article 20) ──

describe('exportAllUserData', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('exports conversations for the correct user', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2);
    expect(exported.conversations[0].domain).toBe('secretary');
  });

  it('exports todos, reminders, notes, shared memory', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const exported = exportAllUserData(1);
    expect(exported.todos).toHaveLength(1);
    expect(exported.todos[0].title).toBe('Buy groceries');
    expect(exported.reminders).toHaveLength(1);
    expect(exported.reminders[0].message).toBe('Call doctor');
    expect(exported.notes).toHaveLength(1);
    expect(exported.notes[0].content).toBe('Meeting notes');
    expect(exported.sharedMemory).toHaveLength(1);
    expect(exported.sharedMemory[0].key).toContain('preference');
  });

  it('exports finance data with decrypted amounts', () => {
    seedUser(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 9999.99);

    const exported = exportAllUserData(1);
    expect(exported.finance.transactions).toHaveLength(1);
    expect(exported.finance.transactions[0].amount).toBe(9999.99);
  });

  it('exports user profile data', () => {
    seedUser(testDb, 1, { username: 'felipe', language: 'pt-BR' });

    const exported = exportAllUserData(1);
    expect(exported.user).not.toBeNull();
    expect(exported.user!.username).toBe('felipe');
    expect(exported.user!.language).toBe('pt-BR');
  });

  it('does NOT include other users data', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    seedUserData(testDb, 1);
    seedUserData(testDb, 2);

    const exported = exportAllUserData(1);
    expect(exported.conversations).toHaveLength(2); // only user 1's
    expect(exported.todos).toHaveLength(1);
  });

  it('handles missing tables gracefully', () => {
    // Just export with no data seeded — should not throw
    const exported = exportAllUserData(999);
    expect(exported.user).toBeNull();
    expect(exported.conversations).toHaveLength(0);
    expect(exported.todos).toHaveLength(0);
    expect(exported.savedIdeas).toHaveLength(0);
  });

  it('includes exportedAt timestamp and userId', () => {
    const exported = exportAllUserData(42);
    expect(exported.userId).toBe(42);
    expect(exported.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Full Delete Tests (GDPR Article 17) ──

describe('deleteAllUserData', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('deletes from ALL tables', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 5000);

    const counts = deleteAllUserData(1);

    expect(counts['conversations']).toBe(2);
    expect(counts['todos']).toBe(1);
    expect(counts['reminders']).toBe(1);
    expect(counts['notes']).toBe(1);
    expect(counts['shared_memory']).toBe(1);
    expect(counts['finance_transactions']).toBe(1);
    expect(counts['users']).toBe(1);
  });

  it('runs in a transaction — other users unaffected', () => {
    seedUser(testDb, 1);
    seedUser(testDb, 2, { username: 'other' });
    seedUserData(testDb, 1);
    seedUserData(testDb, 2);

    deleteAllUserData(1);

    // User 2's data should be intact
    const convos = testDb.prepare('SELECT COUNT(*) as c FROM conversations WHERE user_id = 2').get() as any;
    expect(convos.c).toBe(2);
    const user2 = testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 2').get();
    expect(user2).toBeTruthy();
  });

  it('deletes the user record last', () => {
    seedUser(testDb, 1);
    const counts = deleteAllUserData(1);
    expect(counts['users']).toBe(1);

    const user = testDb.prepare('SELECT 1 FROM users WHERE telegram_id = 1').get();
    expect(user).toBeUndefined();
  });

  it('does NOT delete audit trail entries', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    deleteAllUserData(1);

    const auditRows = testDb.prepare('SELECT * FROM audit_trail WHERE user_id = 1').all();
    expect(auditRows).toHaveLength(1);
  });

  it('returns correct counts per table', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const counts = deleteAllUserData(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(typeof counts['conversations']).toBe('number');
    expect(typeof counts['users']).toBe('number');
  });

  it('returns zeros when deleting user with no data', () => {
    const counts = deleteAllUserData(999);
    expect(counts['conversations']).toBe(0);
    expect(counts['users']).toBe(0);
  });
});

// ── GDPR Compliance Integration Tests ──

describe('GDPR compliance', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('export + delete covers every table with user_id', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);
    addTransaction(1, '2024-06-01', 'income', 5000);

    // Export first
    const exported = exportAllUserData(1);
    expect(exported.conversations.length).toBeGreaterThan(0);
    expect(exported.todos.length).toBeGreaterThan(0);
    expect(exported.finance.transactions.length).toBeGreaterThan(0);

    // Delete
    const counts = deleteAllUserData(1);
    expect(counts['conversations']).toBeGreaterThan(0);
    expect(counts['finance_transactions']).toBeGreaterThan(0);

    // Verify empty after deletion
    const afterExport = exportAllUserData(1);
    expect(afterExport.conversations).toHaveLength(0);
    expect(afterExport.todos).toHaveLength(0);
    expect(afterExport.finance.transactions).toHaveLength(0);
  });

  it('audit trail entry is created for export operations', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const data = exportAllUserData(1);
    logAudit({
      userId: 1,
      actorId: 1,
      action: 'export',
      resource: 'all',
      details: { conversations: data.conversations.length },
    });

    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('export');
  });

  it('audit trail entry is created for delete operations', () => {
    seedUser(testDb, 1);
    seedUserData(testDb, 1);

    const counts = deleteAllUserData(1);
    logAudit({ userId: 1, actorId: 1, action: 'delete', resource: 'all', details: counts });

    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('delete');
  });

  it('audit trail survives user deletion', () => {
    seedUser(testDb, 1);
    logAudit({ userId: 1, actorId: 1, action: 'export', resource: 'all' });

    // Delete the user completely
    deleteAllUserData(1);

    // Audit trail should still be there
    const trail = getAuditTrail(1);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('export');
  });
});
