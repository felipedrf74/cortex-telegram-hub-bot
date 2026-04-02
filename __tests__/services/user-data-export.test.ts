/**
 * Tests for src/services/user-data-export.ts
 *
 * Validates:
 * - Per-user finance data export (with encryption round-trip)
 * - Per-user data deletion (right to erasure)
 * - Data isolation between users in export
 * - Record counting
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
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && !f.includes(' 2')).sort();
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
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
import { exportUserFinanceData, deleteUserFinanceData, countUserFinanceData } from '../../src/services/user-data-export';

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
