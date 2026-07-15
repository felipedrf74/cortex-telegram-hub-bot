import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
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


describe('finance money precision', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
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

