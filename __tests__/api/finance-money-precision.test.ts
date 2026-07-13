import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: { enabled: false },
  },
}));

import { addTransaction, getMonthlySummary } from '../../src/services/finance-tracker';
import { toCents } from '../../src/services/money';

function applyMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime(\'now\')))');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file)) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}

describe('finance money precision', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
  });

  it('sums many decimal transactions through integer cents without drift', () => {
    let expectedCents = 0n;
    for (let index = 0; index < 1000; index += 1) {
      const amount = index % 2 === 0 ? 0.1 : 0.2;
      expectedCents += toCents(amount);
      addTransaction(77, '2026-05-10', 'income', amount, { currency: 'EUR' });
    }

    const summary = getMonthlySummary(77, '2026-05');

    expect(summary.totalIncome).toBe(Number(expectedCents) / 100);
    expect(summary.totalIncome).toBe(150);
  });
});

