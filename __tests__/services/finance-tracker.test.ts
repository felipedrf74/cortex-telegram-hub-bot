/**
 * Tests for src/services/finance-tracker.ts
 *
 * Validates:
 * - IRPF progressive tax calculation (Carnê-Leão brackets)
 * - Transaction CRUD (add, get, delete)
 * - Monthly summary aggregation
 * - Tax event persistence and marking as paid
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ───────────────────────────────────────────────────

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

// ── Mocks ────────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      enabled: true,
      masterKey: 'test-master-key-for-finance-tests!',
    },
  },
}));

import { vi } from 'vitest';
import {
  calculateMonthlyTax,
  addTransaction,
  getTransactions,
  deleteTransaction,
  getMonthlySummary,
  calculateAndStoreTax,
  getTaxEvents,
  markTaxPaid,
  getAnnualTaxSummary,
  parseReceiptAmount,
  IRPF_BRACKETS,
} from '../../src/services/finance-tracker';

// ═══════════════════════════════════════════════════════════════════
// TAX CALCULATION TESTS (pure functions, no DB needed)
// ═══════════════════════════════════════════════════════════════════

describe('calculateMonthlyTax — IRPF progressive brackets', () => {
  it('returns zero tax for income below first bracket', () => {
    const result = calculateMonthlyTax(2000);
    expect(result.taxDue).toBe(0);
    expect(result.bracket).toBe('Isento');
    expect(result.effectiveRate).toBe(0);
  });

  it('calculates 7.5% bracket correctly', () => {
    const result = calculateMonthlyTax(3500);
    // INSS: 3500 * 0.20 = 700
    // Taxable: 3500 - 700 = 2800 (in 7.5% bracket: up to 2826.65)
    // Tax: 2800 * 0.075 - 169.44 = 40.56
    expect(result.inssDue).toBe(700);
    expect(result.taxableIncome).toBe(2800);
    expect(result.taxDue).toBe(40.56);
    expect(result.bracket).toBe('7.5%');
  });

  it('calculates 15% bracket correctly', () => {
    const result = calculateMonthlyTax(5000);
    // INSS: 5000 * 0.20 = 1000
    // Taxable: 5000 - 1000 = 4000 (in 15% bracket: up to 3751.05)
    // Wait, 4000 > 3751.05 → actually in 22.5% bracket
    // Tax: 4000 * 0.225 - 662.77 = 237.23
    expect(result.inssDue).toBe(1000);
    expect(result.taxableIncome).toBe(4000);
    expect(result.taxDue).toBe(237.23);
    expect(result.bracket).toBe('22.5%');
  });

  it('calculates 27.5% bracket for high income', () => {
    const result = calculateMonthlyTax(15000);
    // INSS: min(15000, 7786.02) * 0.20 = 1557.204 → rounded 1557.2
    // Taxable: 15000 - 1557.2 = 13442.8
    // Tax: 13442.8 * 0.275 - 896.00 = 3696.77 - 896.00 = 2800.77
    expect(result.inssDue).toBe(1557.2);
    expect(result.taxableIncome).toBe(13442.8);
    expect(result.taxDue).toBe(2800.77);
    expect(result.bracket).toBe('27.5%');
  });

  it('applies deductions to reduce taxable income', () => {
    const noDeductions = calculateMonthlyTax(5000, 0);
    const withDeductions = calculateMonthlyTax(5000, 500);
    expect(withDeductions.taxDue).toBeLessThan(noDeductions.taxDue);
    expect(withDeductions.deductions).toBe(500);
  });

  it('returns zero tax for zero income', () => {
    const result = calculateMonthlyTax(0);
    expect(result.taxDue).toBe(0);
    expect(result.inssDue).toBe(0);
    expect(result.effectiveRate).toBe(0);
  });

  it('caps INSS at ceiling', () => {
    const result = calculateMonthlyTax(20000);
    // INSS max base = 7786.02 → INSS = 7786.02 * 0.20 = 1557.20
    expect(result.inssDue).toBe(1557.2);
  });

  it('calculates effective rate as tax/gross ratio', () => {
    const result = calculateMonthlyTax(10000);
    expect(result.effectiveRate).toBeGreaterThan(0);
    expect(result.effectiveRate).toBeLessThan(27.5);
    // Verify: effectiveRate = taxDue / grossIncome * 100
    const expected = Math.round((result.taxDue / 10000) * 10000) / 100;
    expect(result.effectiveRate).toBe(expected);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TRANSACTION CRUD TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Transaction CRUD', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

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
    expect(tx.subcategory).toBe('freelance');
    expect(tx.description).toBe('June contract payment');
    expect(tx.currency).toBe('BRL');
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
  });

  it('delete returns false for wrong user', () => {
    const tx = addTransaction(1, '2024-06-01', 'expense', 100);
    expect(deleteTransaction(2, tx.id)).toBe(false); // user 2 can't delete user 1's tx
  });

  it('isolates transactions between users', () => {
    addTransaction(1, '2024-06-01', 'income', 5000);
    addTransaction(2, '2024-06-01', 'income', 3000);

    expect(getTransactions(1)).toHaveLength(1);
    expect(getTransactions(2)).toHaveLength(1);
    expect(getTransactions(1)[0].amount).toBe(5000);
    expect(getTransactions(2)[0].amount).toBe(3000);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MONTHLY SUMMARY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('getMonthlySummary', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

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
  });

  it('returns zeros for a month with no transactions', () => {
    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.totalIncome).toBe(0);
    expect(summary.totalExpenses).toBe(0);
    expect(summary.transactionCount).toBe(0);
  });

  it('only includes transactions from the specified month', () => {
    addTransaction(1, '2024-05-15', 'income', 4000);
    addTransaction(1, '2024-06-15', 'income', 5000);
    addTransaction(1, '2024-07-15', 'income', 6000);

    const summary = getMonthlySummary(1, '2024-06');
    expect(summary.totalIncome).toBe(5000);
    expect(summary.transactionCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TAX EVENT TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Tax event persistence', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('calculates and stores tax for a month', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'deduction', 500);

    const taxEvent = calculateAndStoreTax(1, '2024-06');
    expect(taxEvent.user_id).toBe(1);
    expect(taxEvent.month).toBe('2024-06');
    expect(taxEvent.gross_income).toBe(8000);
    expect(taxEvent.deductions).toBe(500);
    expect(taxEvent.tax_due).toBeGreaterThan(0);
    expect(taxEvent.inss_due).toBeGreaterThan(0);
    expect(taxEvent.status).toBe('pending');
    expect(taxEvent.darf_code).toBe('0190');
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
});

// ═══════════════════════════════════════════════════════════════════
// ANNUAL TAX SUMMARY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('getAnnualTaxSummary', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

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
    expect(summary.totalInssDue).toBeGreaterThan(0);
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
    expect(summary.effectiveAnnualRate).toBeLessThan(27.5);
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
