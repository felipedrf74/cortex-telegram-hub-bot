/**
 * Tests for src/services/finance-tracker.ts
 *
 * Validates:
 * - Portuguese IRS/IVA estimate calculation
 * - Transaction CRUD (add, get, delete)
 * - Monthly summary aggregation
 * - Tax event persistence and marking as paid
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
// ── Mocks ────────────────────────────────────────────────────────

let testDb: Database.Database;
let mockConfig = {
  financeEncryption: {
    enabled: true,
    masterKey: 'test-master-key-for-finance-tests!',
  },
  financePlanning: {
    allowStaticFxEstimate: false,
  },
};

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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/config', () => ({
  get config() { return mockConfig; },
}));

import { logger } from '../../src/utils/logger';
import {
  assertFinanceEncryptionConfigured,
  calculateMonthlyTax,
  calculatePortugueseMonthlyTax,
  addTransaction,
  encryptPlaintextFinanceRows,
  getTransactions,
  deleteTransaction,
  updateTransactionCategory,
  updateTransaction,
  getMonthlyBudgetView,
  getMonthlySummary,
  calculateAndStoreTax,
  getTaxEvents,
  markTaxPaid,
  getAnnualTaxSummary,
  parseReceiptAmount,
  normalizeFinanceCategory,
  convertPlanningEstimateFromBrl,
  getPreferredCurrencyForUser,
  IRPF_BRACKETS,
} from '../../src/services/finance-tracker';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';

const originalNodeEnv = process.env.NODE_ENV;

beforeAll(() => {
  testDb = createMigratedTestDatabase();
});

beforeEach(() => {
  testDb.exec('SAVEPOINT finance_test_case');
  mockConfig = {
    financeEncryption: {
      enabled: true,
      masterKey: 'test-master-key-for-finance-tests!',
    },
    financePlanning: {
      allowStaticFxEstimate: false,
    },
  };
});

afterEach(() => {
  testDb.exec('ROLLBACK TO finance_test_case');
  testDb.exec('RELEASE finance_test_case');
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

afterAll(() => {
  testDb.close();
});

// ═══════════════════════════════════════════════════════════════════
// TAX CALCULATION TESTS (pure functions, no DB needed)
// ═══════════════════════════════════════════════════════════════════

describe('calculatePortugueseMonthlyTax — Portugal IRS/IVA estimate', () => {
  it('keeps the old Brazilian tax entry point quarantined behind a throwing guard', () => {
    expect(() => calculateMonthlyTax()).toThrow(/Brazilian tax engine removed; see finance-tax-pt/);
  });

  it('uses the Portugal ruleset instead of Brazilian INSS/DARF math', () => {
    const result = calculatePortugueseMonthlyTax(1000);
    expect(result.ruleset).toBe('pt-irs-2026-mainland-estimate');
    expect(result.inssDue).toBe(0);
    expect(result.ptInvoiceCode).toBe('PT-IRS-ESTIMATE');
    expect(result.ivaDue).toBe(0);
    expect(result.taxDue).toBeGreaterThan(0);
  });

  it('uses annualized Portuguese brackets for monthly estimates', () => {
    const result = calculatePortugueseMonthlyTax(1500);
    expect(result.taxableIncome).toBe(1500);
    expect(result.bracket).toBe('24.1%');
    expect(result.taxDue).toBe(238.46);
  });

  it('applies deductions to reduce taxable income', () => {
    const noDeductions = calculatePortugueseMonthlyTax(5000, 0);
    const withDeductions = calculatePortugueseMonthlyTax(5000, 500);
    expect(withDeductions.taxDue).toBeLessThan(noDeductions.taxDue);
    expect(withDeductions.deductions).toBe(500);
  });

  it('returns zero tax for zero income', () => {
    const result = calculatePortugueseMonthlyTax(0);
    expect(result.taxDue).toBe(0);
    expect(result.inssDue).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it('calculates effective rate as tax/gross ratio', () => {
    const result = calculatePortugueseMonthlyTax(10000);
    expect(result.effectiveRate).toBeGreaterThan(0);
    expect(result.effectiveRate).toBeLessThan(48);
    // Verify: effectiveRate = taxDue / grossIncome * 100
    const expected = Math.round((result.taxDue / 10000) * 10000) / 100;
    expect(result.effectiveRate).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TRANSACTION CRUD TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Transaction CRUD', () => {
  it('adds a transaction and returns it', () => {
    const tx = addTransaction(1, '2024-06-15', 'income', 5000, {
      subcategory: 'freelance',
      description: 'June contract payment',
    });
    expect(tx.id).toBeDefined();
    expect(tx.user_id).toBe(1);
    expect(tx.date).toBe('2024-06-15');
    expect(tx.category).toBe('income');
    expect(tx.amount).toBe(5000);
    expect(tx.amount_cents).toBe(500000);
    expect(tx.subcategory).toBe('freelance');
    expect(tx.description).toBe('June contract payment');
    expect(tx.currency).toBe('EUR');
    const row = testDb.prepare('SELECT amount, amount_cents, description, encrypted_description FROM finance_transactions WHERE id = ?').get(tx.id) as {
      amount: number;
      amount_cents: number;
      description: string | null;
      encrypted_description: string | null;
    };
    expect(row).toMatchObject({ amount: 5000, amount_cents: 500000, description: null });
    expect(row.encrypted_description).toMatch(/^[0-9a-f]{56,}$/i);
  });

  it('backfills encrypted shadows for legacy plaintext finance rows', () => {
    testDb.prepare(`
      INSERT INTO finance_transactions (
        user_id, tenant_id, date, category, subcategory, amount, amount_cents,
        currency, description, receipt_ref, encrypted_amount, encrypted_description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      1,
      1,
      '2024-06-15',
      'expense',
      'medical',
      2400,
      240000,
      'EUR',
      'Private appointment',
      null,
    );
    testDb.prepare(`
      INSERT INTO finance_tax_events (
        user_id, tenant_id, month, gross_income, deductions, taxable_income,
        tax_due, inss_due, status, notes, encrypted_gross_income,
        encrypted_deductions, encrypted_taxable_income, encrypted_tax_due,
        encrypted_inss_due, encrypted_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(
      1,
      1,
      '2024-06',
      5000,
      500,
      4500,
      800,
      0,
      'estimated',
      'legacy tax note',
    );

    const result = encryptPlaintextFinanceRows();

    expect(result).toMatchObject({
      scannedTransactions: 1,
      encryptedTransactions: 1,
      scannedTaxEvents: 1,
      encryptedTaxEvents: 1,
    });
    const txRaw = testDb.prepare(`
      SELECT encrypted_amount, encrypted_description
      FROM finance_transactions
      WHERE user_id = 1
    `).get() as { encrypted_amount: string | null; encrypted_description: string | null };
    expect(txRaw.encrypted_amount).toMatch(/^[0-9a-f]{56,}$/i);
    expect(txRaw.encrypted_description).toMatch(/^[0-9a-f]{56,}$/i);
    expect(txRaw.encrypted_description).not.toContain('Private appointment');
    expect(getTransactions(1)[0]).toMatchObject({
      amount: 2400,
      description: 'Private appointment',
    });

    const taxRaw = testDb.prepare(`
      SELECT encrypted_gross_income, encrypted_notes
      FROM finance_tax_events
      WHERE user_id = 1
    `).get() as { encrypted_gross_income: string | null; encrypted_notes: string | null };
    expect(taxRaw.encrypted_gross_income).toMatch(/^[0-9a-f]{56,}$/i);
    expect(taxRaw.encrypted_notes).toMatch(/^[0-9a-f]{56,}$/i);
    expect(taxRaw.encrypted_notes).not.toContain('legacy tax note');
    const taxEvent = getTaxEvents(1)[0];
    expect(taxEvent).toMatchObject({
      gross_income: 5000,
      notes: 'legacy tax note',
    });
    expect(Object.keys(taxEvent).some((key) => key.startsWith('encrypted_'))).toBe(false);
  });

  it('fails closed in production when finance encryption is missing a key', () => {
    process.env.NODE_ENV = 'production';
    mockConfig = {
      financeEncryption: {
        enabled: true,
        masterKey: '',
      },
      financePlanning: {
        allowStaticFxEstimate: false,
      },
    };

    expect(() => assertFinanceEncryptionConfigured()).toThrow(
      'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production.',
    );
    delete process.env.NODE_ENV;
  });

  it('fails closed in production when finance encryption is disabled', () => {
    process.env.NODE_ENV = 'production';
    mockConfig = {
      financeEncryption: {
        enabled: false,
        masterKey: 'test-master-key-for-finance-tests!',
      },
      financePlanning: {
        allowStaticFxEstimate: false,
      },
    };

    expect(() => assertFinanceEncryptionConfigured()).toThrow(
      'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production.',
    );
    delete process.env.NODE_ENV;
  });

  it('writes an audit row when creating a transaction', () => {
    const tx = addTransaction(1, '2024-06-15', 'income', 5000, {
      subcategory: 'freelance',
      description: 'June contract payment',
      currency: 'EUR',
    });

    const row = testDb.prepare(`
      SELECT action, resource, details FROM audit_trail
      WHERE user_id = 1 AND tenant_id = 1 AND resource = 'finance.transaction'
    `).get() as { action: string; resource: string; details: string };
    const details = JSON.parse(row.details);

    expect(row.action).toBe('create');
    expect(row.resource).toBe('finance.transaction');
    expect(details).toEqual({
      source: 'finance_tracker',
      transactionId: tx.id,
      changedFields: ['amount', 'category', 'currency', 'date', 'description', 'subcategory'],
    });
    const serialized = JSON.stringify(details);
    for (const privateValue of [
      '2024-06-15', 'income', 'freelance', '5000', '500000', 'EUR', 'June contract payment',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('does not log raw category or amount when adding a transaction', () => {
    vi.mocked(logger.info).mockClear();

    const tx = addTransaction(1, '2024-06-15', 'medical', 2400, {
      description: 'Private appointment',
      currency: 'EUR',
    });

    expect(tx.id).toBeDefined();
    const logCalls = vi.mocked(logger.info).mock.calls;
    expect(logCalls).toHaveLength(1);
    const metadata = logCalls[0][0] as Record<string, unknown>;
    expect(metadata).toMatchObject({ userId: 1, tenantId: 1, txId: tx.id });
    expect(metadata).not.toHaveProperty('category');
    expect(metadata).not.toHaveProperty('amount');
    expect(metadata).not.toHaveProperty('currency');
  });

  it('does not log raw database errors when preferred-currency lookup falls back', () => {
    const workingDb = testDb;
    const privateMarker = 'private-finance-database-marker';
    vi.mocked(logger.debug).mockClear();
    try {
      testDb = {
        prepare: () => { throw new Error(privateMarker); },
      } as unknown as Database.Database;

      expect(getPreferredCurrencyForUser(1)).toBe('EUR');
    } finally {
      testDb = workingDb;
    }

    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      { errorName: 'Error', userId: 1 },
      'Finance tracker: preferred currency lookup fell back to timezone',
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(privateMarker);
  });

  it('normalizes allowed categories and rejects unsupported categories or negative amounts', () => {
    expect(normalizeFinanceCategory(' Food ')).toBe('food');
    expect(() => addTransaction(1, '2024-06-01', 'not-a-real-category', 10)).toThrow(
      /Unsupported finance transaction category/,
    );
    expect(() => addTransaction(1, '2024-06-01', 'expense', -10)).toThrow(
      /non-negative/,
    );
  });

  it('fails closed for static non-BRL planning FX unless explicitly enabled', () => {
    expect(convertPlanningEstimateFromBrl(100, 'BRL')).toBe(100);
    expect(() => convertPlanningEstimateFromBrl(100, 'EUR')).toThrow(/Static BRL planning FX estimates are disabled/);

    mockConfig.financePlanning.allowStaticFxEstimate = true;
    expect(convertPlanningEstimateFromBrl(100, 'EUR')).toBe(18);
  });

  it('gets transactions for a user', () => {
    addTransaction(1, '2024-06-01', 'income', 5000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    addTransaction(2, '2024-06-01', 'income', 3000); // different user

    const txs = getTransactions(1);
    expect(txs).toHaveLength(2);
    expect(txs.every(t => t.user_id === 1)).toBe(true);
  });

  it('filters transactions by date range', () => {
    addTransaction(1, '2024-05-15', 'income', 4000);
    addTransaction(1, '2024-06-15', 'income', 5000);
    addTransaction(1, '2024-07-15', 'income', 6000);

    const txs = getTransactions(1, { startDate: '2024-06-01', endDate: '2024-06-30' });
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(5000);
  });

  it('filters transactions by category', () => {
    addTransaction(1, '2024-06-01', 'income', 5000);
    addTransaction(1, '2024-06-10', 'expense', 200);

    const expenses = getTransactions(1, { category: 'expense' });
    expect(expenses).toHaveLength(1);
    expect(expenses[0].amount).toBe(200);
  });

  it('deletes a transaction', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100);
    expect(deleteTransaction(1, tx.id)).toBe(true);
    expect(getTransactions(1)).toHaveLength(0);
    const tombstone = testDb.prepare('SELECT deleted_at, delete_reason FROM finance_transactions WHERE id = ?').get(tx.id) as {
      deleted_at: string | null;
      delete_reason: string | null;
    };
    expect(tombstone.deleted_at).toBeTruthy();
    expect(tombstone.delete_reason).toBe('user_requested');
  });

  it('writes content-free mutation evidence when updating and deleting a transaction', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100, { subcategory: 'food' });

    const updated = updateTransactionCategory(1, tx.id, 'deduction', { subcategory: 'health' });
    expect(updated?.category).toBe('deduction');
    expect(deleteTransaction(1, tx.id)).toBe(true);

    const rows = testDb.prepare(`
      SELECT action, details FROM audit_trail
      WHERE user_id = 1 AND tenant_id = 1 AND resource = 'finance.transaction'
      ORDER BY id ASC
    `).all() as { action: string; details: string }[];

    expect(rows.map((row) => row.action)).toEqual(['create', 'update', 'delete']);
    const updateDetails = JSON.parse(rows[1].details);
    expect(updateDetails).toEqual({
      source: 'finance_tracker',
      transactionId: tx.id,
      changedFields: ['category', 'subcategory'],
    });
    const deleteDetails = JSON.parse(rows[2].details);
    expect(deleteDetails).toEqual({
      source: 'finance_tracker',
      transactionId: tx.id,
      changedFields: ['deleteReason', 'deletedAt'],
    });
    const serialized = JSON.stringify(rows);
    for (const privateValue of ['2024-06-01', 'expense', 'deduction', 'food', 'health', '100']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('records every mutable transaction field without embedding values in audit evidence', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100);
    const updated = updateTransaction(1, tx.id, {
      date: '2024-06-02',
      category: 'deduction',
      subcategory: 'health',
      amount: 120,
      currency: 'EUR',
      description: 'updated description',
      receiptRef: 'updated receipt',
    });
    expect(updated?.id).toBe(tx.id);

    const row = testDb.prepare(`
      SELECT details FROM audit_trail
      WHERE user_id = 1 AND tenant_id = 1 AND resource = 'finance.transaction'
        AND action = 'update'
      ORDER BY id DESC LIMIT 1
    `).get() as { details: string };
    expect(JSON.parse(row.details)).toEqual({
      source: 'finance_tracker',
      transactionId: tx.id,
      changedFields: [
        'amount', 'category', 'currency', 'date', 'description', 'receiptRef', 'subcategory',
      ],
    });
  });

  it('delete returns false for wrong user', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100);
    expect(deleteTransaction(2, tx.id)).toBe(false); // user 2 can't delete user 1's tx
  });

  it('excludes soft-deleted transactions from summaries and future category updates', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100);
    addTransaction(1, '2024-06-02', 'income', 500);

    expect(deleteTransaction(1, tx.id)).toBe(true);
    expect(updateTransactionCategory(1, tx.id, 'deduction')).toBeNull();

    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.transactionCount).toBe(1);
    expect(summary.totalExpenses).toBe(0);
    expect(summary.totalIncome).toBe(500);
  });

  it('isolates transactions between users', () => {
    addTransaction(1, '2024-06-01', 'income', 5000);
    addTransaction(2, '2024-06-01', 'income', 3000);

    expect(getTransactions(1)).toHaveLength(1);
    expect(getTransactions(2)).toHaveLength(1);
    expect(getTransactions(1)[0].amount).toBe(5000);
    expect(getTransactions(2)[0].amount).toBe(3000);
  });

  it('isolates same-user transactions between tenants', () => {
    addTransaction(1, '2024-06-01', 'income', 5000, { tenantId: 10 });
    addTransaction(1, '2024-06-02', 'income', 3000, { tenantId: 11 });

    expect(getTransactions(1, { tenantId: 10 })).toHaveLength(1);
    expect(getTransactions(1, { tenantId: 10 })[0].amount).toBe(5000);
    expect(getTransactions(1, { tenantId: 11 })).toHaveLength(1);
    expect(getTransactions(1, { tenantId: 11 })[0].amount).toBe(3000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MONTHLY SUMMARY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('getMonthlySummary', () => {
  it('aggregates income, expenses, and deductions for a month', () => {
    addTransaction(1, '2024-06-01', 'income', 10000, { subcategory: 'freelance' });
    addTransaction(1, '2024-06-05', 'expense', 1500, { subcategory: 'rent' });
    addTransaction(1, '2024-06-10', 'expense', 300, { subcategory: 'software' });
    addTransaction(1, '2024-06-15', 'deduction', 800, { subcategory: 'health' });

    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.month).toBe('2024-06');
    expect(summary.totalIncome).toBe(10000);
    expect(summary.totalExpenses).toBe(1800);
    expect(summary.totalDeductions).toBe(800);
    expect(summary.netIncome).toBe(8200);
    expect(summary.transactionCount).toBe(4);
    expect(summary.currencies).toEqual(['EUR']);
    expect(summary.mixedCurrency).toBe(false);
  });

  it('returns zeros for a month with no transactions', () => {
    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.totalIncome).toBe(0);
    expect(summary.totalExpenses).toBe(0);
    expect(summary.transactionCount).toBe(0);
    expect(summary.currencies).toEqual([]);
    expect(summary.mixedCurrency).toBe(false);
  });

  it('only includes transactions from the specified month', () => {
    addTransaction(1, '2024-05-15', 'income', 4000);
    addTransaction(1, '2024-06-15', 'income', 5000);
    addTransaction(1, '2024-07-15', 'income', 6000);

    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.totalIncome).toBe(5000);
    expect(summary.transactionCount).toBe(1);
  });

  it('marks mixed-currency months so tax code can refuse blended bases', () => {
    addTransaction(1, '2024-06-01', 'income', 1000, { currency: 'EUR' });
    addTransaction(1, '2024-06-02', 'income', 1000, { currency: 'USD' });

    const summary = getMonthlySummary(1, '2024-06');

    expect(summary.currencies).toEqual(['EUR', 'USD']);
    expect(summary.mixedCurrency).toBe(true);
    expect(() => calculateAndStoreTax(1, '2024-06')).toThrow(/mixed-currency month/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TAX EVENT TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Tax event persistence', () => {
  it('calculates and stores tax for a month', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'deduction', 500);

    const taxEvent = calculateAndStoreTax(1, '2024-06');
    expect(taxEvent.user_id).toBe(1);
    expect(taxEvent.month).toBe('2024-06');
    expect(taxEvent.gross_income).toBe(8000);
    expect(taxEvent.deductions).toBe(500);
    expect(taxEvent.tax_due).toBeGreaterThan(0);
    expect(taxEvent.inss_due).toBe(0);
    expect(taxEvent.status).toBe('pending');
    expect(taxEvent.darf_code).toBeNull();
    expect(taxEvent.pt_invoice_code).toBe('PT-IRS-ESTIMATE');
    expect(taxEvent.iva_due).toBe(0);
    expect(taxEvent.withholding_due).toBe(0);
    expect(taxEvent.ruleset).toBe('pt-irs-2026-mainland-estimate');
  });

  it('upserts tax event on recalculation', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    calculateAndStoreTax(1, '2024-06');

    // Add more income and recalculate
    addTransaction(1, '2024-06-20', 'income', 2000);
    const updated = calculateAndStoreTax(1, '2024-06');
    expect(updated.gross_income).toBe(10000);

    // Should still be one event, not two
    const events = getTaxEvents(1);
    const juneEvents = events.filter(e => e.month === '2024-06');
    expect(juneEvents).toHaveLength(1);
  });

  it('retrieves tax events filtered by year', () => {
    addTransaction(1, '2024-01-01', 'income', 5000);
    calculateAndStoreTax(1, '2024-01');

    addTransaction(1, '2024-06-01', 'income', 8000);
    calculateAndStoreTax(1, '2024-06');

    addTransaction(1, '2025-01-01', 'income', 9000);
    calculateAndStoreTax(1, '2025-01');

    const events2024 = getTaxEvents(1, { year: 2024 });
    expect(events2024).toHaveLength(2);
    expect(events2024.every(e => e.month.startsWith('2024'))).toBe(true);
  });

  it('marks tax as paid', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    calculateAndStoreTax(1, '2024-06');

    const result = markTaxPaid(1, '2024-06');
    expect(result).toBe(true);

    const events = getTaxEvents(1);
    const june = events.find(e => e.month === '2024-06')!;
    expect(june.status).toBe('paid');
    expect(june.paid_at).toBeTruthy();
  });

  it('markTaxPaid returns false for non-existent event', () => {
    expect(markTaxPaid(1, '2099-01')).toBe(false);
  });

  it('isolates same-user tax events between tenants', () => {
    addTransaction(1, '2024-06-15', 'income', 5000, { tenantId: 10 });
    addTransaction(1, '2024-06-15', 'income', 3000, { tenantId: 11 });

    const tenant10 = calculateAndStoreTax(1, '2024-06', { tenantId: 10 });
    const tenant11 = calculateAndStoreTax(1, '2024-06', { tenantId: 11 });

    expect(tenant10.gross_income).toBe(5000);
    expect(tenant11.gross_income).toBe(3000);
    expect(getTaxEvents(1, { year: 2024, tenantId: 10 })).toHaveLength(1);
    expect(getTaxEvents(1, { year: 2024, tenantId: 11 })).toHaveLength(1);
    expect(markTaxPaid(1, '2024-06', { tenantId: 10 })).toBe(true);
    expect(getTaxEvents(1, { year: 2024, tenantId: 11 })[0].status).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ANNUAL TAX SUMMARY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('getAnnualTaxSummary', () => {
  it('aggregates all monthly tax events for a year', () => {
    addTransaction(1, '2024-01-15', 'income', 8000);
    calculateAndStoreTax(1, '2024-01');
    addTransaction(1, '2024-02-15', 'income', 10000);
    calculateAndStoreTax(1, '2024-02');
    addTransaction(1, '2024-03-15', 'income', 6000);
    addTransaction(1, '2024-03-20', 'deduction', 500);
    calculateAndStoreTax(1, '2024-03');

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.year).toBe(2024);
    expect(summary.totalGrossIncome).toBe(24000);
    expect(summary.totalDeductions).toBe(500);
    expect(summary.totalInssDue).toBe(0);
    expect(summary.totalTaxDue).toBeGreaterThan(0);
    expect(summary.monthsPending).toBe(3);
    expect(summary.monthsPaid).toBe(0);
    expect(summary.months).toHaveLength(3);
  });

  it('tracks paid vs pending months', () => {
    addTransaction(1, '2024-01-15', 'income', 8000);
    calculateAndStoreTax(1, '2024-01');
    markTaxPaid(1, '2024-01');

    addTransaction(1, '2024-02-15', 'income', 10000);
    calculateAndStoreTax(1, '2024-02');

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.monthsPaid).toBe(1);
    expect(summary.monthsPending).toBe(1);
    expect(summary.totalPaid).toBeGreaterThan(0);
    expect(summary.totalPending).toBeGreaterThan(0);
  });

  it('returns zeros for year with no data', () => {
    const summary = getAnnualTaxSummary(1, 2099);
    expect(summary.totalGrossIncome).toBe(0);
    expect(summary.totalTaxDue).toBe(0);
    expect(summary.monthsPaid).toBe(0);
    expect(summary.monthsPending).toBe(0);
    expect(summary.effectiveAnnualRate).toBe(0);
  });

  it('calculates effective annual rate correctly', () => {
    addTransaction(1, '2024-06-15', 'income', 15000);
    calculateAndStoreTax(1, '2024-06');

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.effectiveAnnualRate).toBeGreaterThan(0);
    expect(summary.effectiveAnnualRate).toBeLessThan(48);
    const expected = Math.round((summary.totalTaxDue / summary.totalGrossIncome) * 10000) / 100;
    expect(summary.effectiveAnnualRate).toBe(expected);
  });

  it('isolates data between users', () => {
    addTransaction(1, '2024-06-15', 'income', 15000);
    calculateAndStoreTax(1, '2024-06');
    addTransaction(2, '2024-06-15', 'income', 5000);
    calculateAndStoreTax(2, '2024-06');

    const s1 = getAnnualTaxSummary(1, 2024);
    const s2 = getAnnualTaxSummary(2, 2024);
    expect(s1.totalGrossIncome).toBe(15000);
    expect(s2.totalGrossIncome).toBe(5000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MONTHLY BUDGET VIEW TESTS
// ═══════════════════════════════════════════════════════════════════

describe('getMonthlyBudgetView', () => {
  it('marks mixed-currency months as provisional instead of inventing a fake budget ratio', () => {
    addTransaction(1, '2024-06-02', 'income', 3200, { currency: 'EUR' });
    addTransaction(1, '2024-06-05', 'expense', 187, { currency: 'EUR', description: 'Groceries' });
    addTransaction(1, '2024-06-08', 'expense', 240, { currency: 'BRL', description: 'Taxi Brasil' });

    const view = getMonthlyBudgetView(1, '2024-06');

    expect(view.integrity).toBe('mixed_currency');
    expect(view.currentRemainingRatio).toBeNull();
    expect(view.projectedRemainingRatio).toBeNull();
    expect(view.currencies).toEqual(expect.arrayContaining(['EUR', 'BRL']));
    expect(view.notes.join(' ')).toContain('Mixed currencies');
  });

  it('projects still-missing recurring commitments into remaining budget', () => {
    addTransaction(1, '2024-03-01', 'income', 3000, { currency: 'EUR' });
    addTransaction(1, '2024-03-04', 'expense', 45, {
      currency: 'EUR',
      subcategory: 'software',
      description: 'Spotify Subscription',
    });
    addTransaction(1, '2024-04-01', 'income', 3000, { currency: 'EUR' });
    addTransaction(1, '2024-04-04', 'expense', 45, {
      currency: 'EUR',
      subcategory: 'software',
      description: 'Spotify Subscription',
    });
    addTransaction(1, '2024-05-01', 'income', 3000, { currency: 'EUR' });
    addTransaction(1, '2024-05-04', 'expense', 45, {
      currency: 'EUR',
      subcategory: 'software',
      description: 'Spotify Subscription',
    });
    addTransaction(1, '2024-06-01', 'income', 3000, { currency: 'EUR' });
    addTransaction(1, '2024-06-08', 'expense', 600, {
      currency: 'EUR',
      subcategory: 'groceries',
      description: 'Groceries',
    });

    const view = getMonthlyBudgetView(1, '2024-06');

    expect(view.integrity).toBe('reliable');
    expect(view.currentRemainingRatio).toBe(0.8);
    expect(view.recurringExpenseCount).toBe(1);
    expect(view.recurringExpenseEstimate).toBe(45);
    expect(view.projectedRemainingRatio).toBe(0.79);
    expect(view.notes.join(' ')).toContain('Recurring expense pressure');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RECEIPT AMOUNT PARSING TESTS
// ═══════════════════════════════════════════════════════════════════

describe('parseReceiptAmount', () => {
  it('parses BRL format: R$ 45,90', () => {
    expect(parseReceiptAmount('R$ 45,90')).toBe(45.90);
  });

  it('parses BRL with thousands: R$ 1.234,56', () => {
    expect(parseReceiptAmount('R$ 1.234,56')).toBe(1234.56);
  });

  it('parses euro format: € 45.90', () => {
    expect(parseReceiptAmount('€ 45.90')).toBe(45.90);
  });

  it('parses plain number: 123.45', () => {
    expect(parseReceiptAmount('123.45')).toBe(123.45);
  });

  it('parses BRL without spaces: R$500,00', () => {
    expect(parseReceiptAmount('R$500,00')).toBe(500.00);
  });

  it('parses large BRL: R$ 12.345,67', () => {
    expect(parseReceiptAmount('R$ 12.345,67')).toBe(12345.67);
  });

  it('returns null for null/undefined', () => {
    expect(parseReceiptAmount(null)).toBeNull();
    expect(parseReceiptAmount(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseReceiptAmount('')).toBeNull();
  });

  it('returns null for zero or negative', () => {
    expect(parseReceiptAmount('R$ 0,00')).toBeNull();
    expect(parseReceiptAmount('-50')).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    expect(parseReceiptAmount('abc')).toBeNull();
  });
});

describe('Finance schema and Portugal boundary contracts', () => {
  it('keeps finance columns and performance indexes complete', () => {
    const transactionColumns = testDb.prepare("PRAGMA table_info('finance_transactions')").all() as Array<{ name: string }>;
    expect(transactionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'id', 'tenant_id', 'user_id', 'date', 'category', 'subcategory', 'amount',
      'currency', 'description', 'receipt_ref', 'created_at', 'updated_at',
    ]));
    const taxColumns = testDb.prepare("PRAGMA table_info('finance_tax_events')").all() as Array<{ name: string }>;
    expect(taxColumns.map((column) => column.name)).toContain('tenant_id');

    const indexes = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_finance%'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_finance_tx_user_date', 'idx_finance_tx_category', 'idx_finance_tax_user_month',
    ]));
  });

  it('enforces tenant-unique tax months while allowing the same user/month in another tenant', () => {
    const insert = testDb.prepare(`
      INSERT INTO finance_tax_events (
        tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due
      ) VALUES (?, 1, '2026-05', 1000, 0, 1000, 100, 0)
    `);
    insert.run(10);
    insert.run(11);
    expect(() => insert.run(10)).toThrow();
  });

  it('defaults transaction currency to EUR and tax status to pending', () => {
    testDb.prepare(`
      INSERT INTO finance_transactions (tenant_id, user_id, date, category, amount)
      VALUES (1, 1, '2024-01-15', 'income', 5000)
    `).run();
    testDb.prepare(`
      INSERT INTO finance_tax_events (
        tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due
      ) VALUES (1, 1, '2024-01', 5000, 0, 5000, 500, 0)
    `).run();
    expect(testDb.prepare('SELECT currency FROM finance_transactions').get()).toMatchObject({ currency: 'EUR' });
    expect(testDb.prepare('SELECT status FROM finance_tax_events').get()).toMatchObject({ status: 'pending' });
  });

  it('covers IVA, highest-bracket, and deduction-floor boundaries', () => {
    const withIva = calculatePortugueseMonthlyTax(3000, 0, { ivaRate: 0.23 });
    expect(withIva).toMatchObject({ taxableIncome: 3000, ivaDue: 690, inssDue: 0 });

    const highest = calculatePortugueseMonthlyTax(20000);
    expect(highest.bracket).toBe('48.0%');
    expect(highest.taxDue).toBeGreaterThan(0);

    const floored = calculatePortugueseMonthlyTax(1000, 5000);
    expect(floored.taxableIncome).toBe(0);
    expect(floored.taxDue).toBe(0);
  });

  it('quarantines Brazilian brackets and remains progressively taxed', () => {
    expect(IRPF_BRACKETS).toHaveLength(5);
    expect(IRPF_BRACKETS[0].rate).toBe(0);
    expect(IRPF_BRACKETS.at(-1)?.upTo).toBe(Infinity);
    expect(calculatePortugueseMonthlyTax(3000).bracket).not.toBe('7.5%');

    const rates = [3000, 8000, 20000].map((income) => calculatePortugueseMonthlyTax(income).effectiveRate);
    expect(rates[2]).toBeGreaterThan(rates[1]);
    expect(rates[1]).toBeGreaterThan(rates[0]);
  });

  it('round-trips optional fields and enforces explicit/default list limits', () => {
    const optional = addTransaction(1, '2024-03-15', 'expense', 150, {
      subcategory: 'software',
      description: 'GitHub subscription',
      currency: 'USD',
      receiptRef: 'photo_123',
    });
    expect(optional).toMatchObject({
      subcategory: 'software',
      description: 'GitHub subscription',
      currency: 'USD',
      receipt_ref: 'photo_123',
    });

    for (let index = 0; index < 55; index += 1) {
      addTransaction(1, '2024-04-15', 'expense', index);
    }
    expect(getTransactions(1, { limit: 3 })).toHaveLength(3);
    expect(getTransactions(1)).toHaveLength(50);
  });

  it('keeps December and January summaries isolated', () => {
    addTransaction(1, '2024-12-15', 'income', 5000);
    addTransaction(1, '2025-01-05', 'income', 6000);
    expect(getMonthlySummary(1, '2024-12').totalIncome).toBe(5000);
    expect(getMonthlySummary(1, '2025-01').totalIncome).toBe(6000);
  });

  it('keeps the finance skill routing and sub-skill contract complete', () => {
    const finance = DEFAULT_SKILLS.finance;
    expect(finance.name).toBe('finance');
    expect(finance.subSkills.map((subSkill) => subSkill.name)).toEqual(expect.arrayContaining(['expenses', 'tax']));
    expect(finance.routing.patternRoutes.length).toBeGreaterThan(0);
    expect(finance.routing.keywordRoute).not.toBeNull();
    expect(finance.routing.classificationHint.label).toBe('finance');
  });
});
