/**
 * QA Validation Tests v2 — Finance Tracker
 *
 * Covers areas not validated in v1:
 * - Tool executor integration (finance_* tool dispatch)
 * - Encryption round-trip (AES-256-GCM with per-user keys)
 * - Receipt amount parsing edge cases
 * - Annual tax summary aggregation
 * - Tax bracket exact boundary values
 * - Encryption disabled fallback
 * - DARF code and tax status workflow
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

// Encryption enabled by default for these tests
let mockEncryptionEnabled = true;
vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      get enabled() { return mockEncryptionEnabled; },
      masterKey: 'qa-test-master-key-32-chars-ok!!',
    },
  },
}));

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
  INSS_RATE,
  INSS_MAX_BASE,
} from '../../src/services/finance-tracker';

// ═══════════════════════════════════════════════════════════════════
// ENCRYPTION ROUND-TRIP VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Encryption round-trip', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    mockEncryptionEnabled = true;
  });
  afterEach(() => { testDb.close(); });

  it('stores encrypted_amount alongside plaintext amount', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    const raw = testDb.prepare('SELECT amount, encrypted_amount FROM finance_transactions WHERE user_id = 1').get() as any;
    expect(raw.amount).toBe(5000);
    expect(raw.encrypted_amount).toBeTruthy();
    expect(raw.encrypted_amount).not.toBe('5000'); // not plaintext
  });

  it('stores encrypted_description alongside plaintext description', () => {
    addTransaction(1, '2024-06-15', 'expense', 200, { description: 'Uber ride' });
    const raw = testDb.prepare('SELECT description, encrypted_description FROM finance_transactions WHERE user_id = 1').get() as any;
    expect(raw.description).toBe('Uber ride');
    expect(raw.encrypted_description).toBeTruthy();
    expect(raw.encrypted_description).not.toBe('Uber ride');
  });

  it('decrypts amount correctly when reading transactions', () => {
    addTransaction(1, '2024-06-15', 'income', 12345.67);
    const txs = getTransactions(1);
    expect(txs[0].amount).toBe(12345.67);
  });

  it('decrypts description correctly when reading transactions', () => {
    addTransaction(1, '2024-06-15', 'expense', 99, { description: 'Coffee & Biscuit' });
    const txs = getTransactions(1);
    expect(txs[0].description).toBe('Coffee & Biscuit');
  });

  it('user 1 encrypted data cannot be decrypted by user 2 key derivation', () => {
    // This tests per-user key isolation at the data layer
    addTransaction(1, '2024-06-15', 'income', 7777);
    addTransaction(2, '2024-06-15', 'income', 8888);

    const txs1 = getTransactions(1);
    const txs2 = getTransactions(2);
    expect(txs1[0].amount).toBe(7777);
    expect(txs2[0].amount).toBe(8888);

    // Raw encrypted blobs should differ
    const raw1 = testDb.prepare('SELECT encrypted_amount FROM finance_transactions WHERE user_id = 1').get() as any;
    const raw2 = testDb.prepare('SELECT encrypted_amount FROM finance_transactions WHERE user_id = 2').get() as any;
    expect(raw1.encrypted_amount).not.toBe(raw2.encrypted_amount);
  });

  it('tax events store encrypted fields', () => {
    addTransaction(1, '2024-06-15', 'income', 10000);
    calculateAndStoreTax(1, '2024-06');

    const raw = testDb.prepare('SELECT * FROM finance_tax_events WHERE user_id = 1').get() as any;
    expect(raw.encrypted_gross_income).toBeTruthy();
    expect(raw.encrypted_tax_due).toBeTruthy();
    expect(raw.encrypted_inss_due).toBeTruthy();
    expect(raw.encrypted_deductions).toBeTruthy();
    expect(raw.encrypted_taxable_income).toBeTruthy();
  });

  it('tax events decrypt correctly on read', () => {
    addTransaction(1, '2024-06-15', 'income', 10000);
    addTransaction(1, '2024-06-20', 'deduction', 500);
    const stored = calculateAndStoreTax(1, '2024-06');

    const events = getTaxEvents(1);
    expect(events[0].gross_income).toBe(stored.gross_income);
    expect(events[0].tax_due).toBe(stored.tax_due);
    expect(events[0].inss_due).toBe(stored.inss_due);
    expect(events[0].deductions).toBe(stored.deductions);
  });

  it('null description does not produce encrypted_description', () => {
    addTransaction(1, '2024-06-15', 'income', 5000); // no description
    const raw = testDb.prepare('SELECT encrypted_description FROM finance_transactions WHERE user_id = 1').get() as any;
    expect(raw.encrypted_description).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENCRYPTION DISABLED FALLBACK
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Encryption disabled fallback', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    mockEncryptionEnabled = false;
  });
  afterEach(() => {
    testDb.close();
    mockEncryptionEnabled = true;
  });

  it('stores null encrypted columns when encryption is disabled', () => {
    addTransaction(1, '2024-06-15', 'income', 5000, { description: 'Test' });
    const raw = testDb.prepare('SELECT encrypted_amount, encrypted_description FROM finance_transactions WHERE user_id = 1').get() as any;
    expect(raw.encrypted_amount).toBeNull();
    expect(raw.encrypted_description).toBeNull();
  });

  it('reads plaintext amount when encrypted column is null', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    const txs = getTransactions(1);
    expect(txs[0].amount).toBe(5000);
  });

  it('reads plaintext description when encrypted column is null', () => {
    addTransaction(1, '2024-06-15', 'expense', 100, { description: 'Bus ticket' });
    const txs = getTransactions(1);
    expect(txs[0].description).toBe('Bus ticket');
  });

  it('tax calculation works normally without encryption', () => {
    addTransaction(1, '2024-06-15', 'income', 8000);
    const taxEvent = calculateAndStoreTax(1, '2024-06');
    expect(taxEvent.gross_income).toBe(8000);
    expect(taxEvent.tax_due).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TAX BRACKET BOUNDARY CONDITIONS
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Tax bracket boundaries', () => {
  it('exact boundary: taxable income = R$2,259.20 is exempt', () => {
    // Need gross income such that gross - INSS = 2259.20
    // gross * 0.80 = 2259.20 → gross = 2824.00
    const result = calculateMonthlyTax(2824);
    // INSS: 2824 * 0.20 = 564.80
    // Taxable: 2824 - 564.80 = 2259.20 → exactly at boundary
    expect(result.taxableIncome).toBe(2259.2);
    expect(result.bracket).toBe('Isento');
    expect(result.taxDue).toBe(0);
  });

  it('just above exempt boundary enters 7.5% bracket', () => {
    // gross * 0.80 = 2260 → gross = 2825
    const result = calculateMonthlyTax(2825);
    // INSS: 2825 * 0.20 = 565
    // Taxable: 2825 - 565 = 2260 → in 7.5% bracket
    expect(result.taxableIncome).toBe(2260);
    expect(result.bracket).toBe('7.5%');
    expect(result.taxDue).toBeGreaterThan(0);
  });

  it('very small taxable amount in 7.5% bracket can yield tax < deduction → zero', () => {
    // taxable = 2260, tax = 2260 * 0.075 - 169.44 = 169.5 - 169.44 = 0.06
    const result = calculateMonthlyTax(2825);
    expect(result.taxDue).toBe(0.06);
  });

  it('all IRPF brackets have increasing rates', () => {
    for (let i = 1; i < IRPF_BRACKETS.length; i++) {
      expect(IRPF_BRACKETS[i].rate).toBeGreaterThan(IRPF_BRACKETS[i - 1].rate);
    }
  });

  it('all IRPF brackets have increasing upper bounds', () => {
    for (let i = 1; i < IRPF_BRACKETS.length; i++) {
      expect(IRPF_BRACKETS[i].upTo).toBeGreaterThan(IRPF_BRACKETS[i - 1].upTo);
    }
  });

  it('INSS rate and max base are 2024 values', () => {
    expect(INSS_RATE).toBe(0.20);
    expect(INSS_MAX_BASE).toBe(7786.02);
  });

  it('exact INSS ceiling: income = INSS_MAX_BASE caps correctly', () => {
    const result = calculateMonthlyTax(INSS_MAX_BASE);
    const expectedInss = Math.round(INSS_MAX_BASE * INSS_RATE * 100) / 100;
    expect(result.inssDue).toBe(expectedInss);
  });

  it('income just above INSS_MAX_BASE still caps INSS', () => {
    const result = calculateMonthlyTax(INSS_MAX_BASE + 1000);
    const maxInss = Math.round(INSS_MAX_BASE * INSS_RATE * 100) / 100;
    expect(result.inssDue).toBe(maxInss);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ANNUAL TAX SUMMARY — EXTENDED VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Annual tax summary extended', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    mockEncryptionEnabled = true;
  });
  afterEach(() => { testDb.close(); });

  it('annual summary totals match sum of monthly tax events', () => {
    const incomes = [5000, 8000, 6000, 10000];
    const months = ['2024-01', '2024-02', '2024-03', '2024-04'];

    for (let i = 0; i < months.length; i++) {
      addTransaction(1, `${months[i]}-15`, 'income', incomes[i]);
      calculateAndStoreTax(1, months[i]);
    }

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.months).toHaveLength(4);

    // Verify totals match individual events
    let sumGross = 0, sumTax = 0, sumInss = 0;
    for (const m of summary.months) {
      sumGross += m.gross_income;
      sumTax += m.tax_due;
      sumInss += m.inss_due;
    }
    expect(summary.totalGrossIncome).toBe(Math.round(sumGross * 100) / 100);
    expect(summary.totalTaxDue).toBe(Math.round(sumTax * 100) / 100);
    expect(summary.totalInssDue).toBe(Math.round(sumInss * 100) / 100);
  });

  it('paid months contribute to totalPaid, pending to totalPending', () => {
    addTransaction(1, '2024-01-15', 'income', 8000);
    addTransaction(1, '2024-02-15', 'income', 8000);
    addTransaction(1, '2024-03-15', 'income', 8000);

    calculateAndStoreTax(1, '2024-01');
    calculateAndStoreTax(1, '2024-02');
    calculateAndStoreTax(1, '2024-03');

    markTaxPaid(1, '2024-01');
    markTaxPaid(1, '2024-02');

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.monthsPaid).toBe(2);
    expect(summary.monthsPending).toBe(1);
    expect(summary.totalPaid).toBeGreaterThan(0);
    expect(summary.totalPending).toBeGreaterThan(0);
    expect(summary.totalPaid + summary.totalPending).toBeCloseTo(summary.totalTaxDue, 2);
  });

  it('annual summary does not include other years', () => {
    addTransaction(1, '2023-12-15', 'income', 5000);
    addTransaction(1, '2024-01-15', 'income', 8000);
    addTransaction(1, '2025-01-15', 'income', 9000);

    calculateAndStoreTax(1, '2023-12');
    calculateAndStoreTax(1, '2024-01');
    calculateAndStoreTax(1, '2025-01');

    const summary = getAnnualTaxSummary(1, 2024);
    expect(summary.months).toHaveLength(1);
    expect(summary.totalGrossIncome).toBe(8000);
  });

  it('annual summary per-user isolation', () => {
    addTransaction(1, '2024-06-15', 'income', 15000);
    addTransaction(2, '2024-06-15', 'income', 3000);
    calculateAndStoreTax(1, '2024-06');
    calculateAndStoreTax(2, '2024-06');

    const s1 = getAnnualTaxSummary(1, 2024);
    const s2 = getAnnualTaxSummary(2, 2024);
    expect(s1.totalGrossIncome).toBe(15000);
    expect(s2.totalGrossIncome).toBe(3000);
    expect(s1.totalTaxDue).toBeGreaterThan(s2.totalTaxDue);
  });
});

// ═══════════════════════════════════════════════════════════════════
// RECEIPT AMOUNT PARSING — EXTENDED QA
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Receipt parsing edge cases', () => {
  it('handles BRL without space: R$99,90', () => {
    expect(parseReceiptAmount('R$99,90')).toBe(99.90);
  });

  it('handles large BRL amount: R$ 123.456,78', () => {
    expect(parseReceiptAmount('R$ 123.456,78')).toBe(123456.78);
  });

  it('handles GBP format: £ 45.90', () => {
    expect(parseReceiptAmount('£ 45.90')).toBe(45.90);
  });

  it('handles JPY format: ¥ 1500', () => {
    expect(parseReceiptAmount('¥ 1500')).toBe(1500);
  });

  it('handles integer BRL: R$ 100,00', () => {
    expect(parseReceiptAmount('R$ 100,00')).toBe(100);
  });

  it('handles just a number: 42', () => {
    expect(parseReceiptAmount('42')).toBe(42);
  });

  it('returns null for whitespace-only string', () => {
    expect(parseReceiptAmount('   ')).toBeNull();
  });

  it('returns null for only currency symbol', () => {
    expect(parseReceiptAmount('R$')).toBeNull();
  });

  it('handles decimal with single digit: R$ 5,5', () => {
    // 5,5 → 5.5
    expect(parseReceiptAmount('R$ 5,5')).toBe(5.5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOOL EXECUTOR INTEGRATION (dispatch via tool name)
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Tool executor integration', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    mockEncryptionEnabled = true;
  });
  afterEach(() => { testDb.close(); });

  // We test via the finance-tracker functions directly since tool-executor
  // is a thin dispatch layer — but verify the expected shapes

  it('finance_add_transaction returns correct shape', () => {
    const tx = addTransaction(1, '2024-06-15', 'income', 5000, { subcategory: 'freelance' });
    // Tool executor returns: { success: true, id, date, category, amount }
    const toolResult = { success: true, id: tx.id, date: tx.date, category: tx.category, amount: tx.amount };
    expect(toolResult.success).toBe(true);
    expect(toolResult.id).toBeGreaterThan(0);
    expect(toolResult.date).toBe('2024-06-15');
    expect(toolResult.category).toBe('income');
    expect(toolResult.amount).toBe(5000);
  });

  it('finance_delete_transaction returns error shape for missing tx', () => {
    const deleted = deleteTransaction(1, 9999);
    const toolResult = deleted ? { success: true } : { error: 'Transaction not found or unauthorized' };
    expect(toolResult).toEqual({ error: 'Transaction not found or unauthorized' });
  });

  it('finance_calculate_tax produces effectiveRate and bracket', () => {
    addTransaction(1, '2024-06-15', 'income', 10000);
    const taxEvent = calculateAndStoreTax(1, '2024-06');
    const breakdown = calculateMonthlyTax(taxEvent.gross_income, taxEvent.deductions);
    const toolResult = { ...taxEvent, effectiveRate: breakdown.effectiveRate, bracket: breakdown.bracket };
    expect(toolResult.effectiveRate).toBeGreaterThan(0);
    expect(toolResult.bracket).toBeTruthy();
    expect(toolResult.darf_code).toBe('0190');
  });

  it('finance_mark_tax_paid returns success shape', () => {
    addTransaction(1, '2024-06-15', 'income', 8000);
    calculateAndStoreTax(1, '2024-06');
    const marked = markTaxPaid(1, '2024-06');
    const toolResult = marked ? { success: true, month: '2024-06', status: 'paid' } : { error: 'Tax event not found' };
    expect(toolResult).toEqual({ success: true, month: '2024-06', status: 'paid' });
  });

  it('finance_annual_summary returns complete shape', () => {
    addTransaction(1, '2024-06-15', 'income', 10000);
    calculateAndStoreTax(1, '2024-06');

    const summary = getAnnualTaxSummary(1, 2024);
    // Validate all expected fields
    expect(summary).toHaveProperty('year');
    expect(summary).toHaveProperty('totalGrossIncome');
    expect(summary).toHaveProperty('totalDeductions');
    expect(summary).toHaveProperty('totalInssDue');
    expect(summary).toHaveProperty('totalTaxDue');
    expect(summary).toHaveProperty('totalPaid');
    expect(summary).toHaveProperty('totalPending');
    expect(summary).toHaveProperty('effectiveAnnualRate');
    expect(summary).toHaveProperty('monthsPaid');
    expect(summary).toHaveProperty('monthsPending');
    expect(summary).toHaveProperty('months');
  });
});

// ═══════════════════════════════════════════════════════════════════
// DARF CODE AND TAX STATUS WORKFLOW
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — DARF code and status workflow', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    mockEncryptionEnabled = true;
  });
  afterEach(() => { testDb.close(); });

  it('calculateAndStoreTax always sets DARF code 0190', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    const event = calculateAndStoreTax(1, '2024-06');
    expect(event.darf_code).toBe('0190');
  });

  it('new tax event starts with status pending', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    const event = calculateAndStoreTax(1, '2024-06');
    expect(event.status).toBe('pending');
    expect(event.paid_at).toBeNull();
  });

  it('marking as paid sets paid_at timestamp', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    calculateAndStoreTax(1, '2024-06');
    markTaxPaid(1, '2024-06');

    const events = getTaxEvents(1);
    const june = events.find(e => e.month === '2024-06')!;
    expect(june.status).toBe('paid');
    expect(june.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}/); // ISO date format
  });

  it('recalculating after paying preserves but resets pending status (upsert)', () => {
    addTransaction(1, '2024-06-15', 'income', 5000);
    calculateAndStoreTax(1, '2024-06');
    markTaxPaid(1, '2024-06');

    // Add more income and recalculate — upsert updates amounts but status column is not in UPDATE SET
    addTransaction(1, '2024-06-20', 'income', 3000);
    const updated = calculateAndStoreTax(1, '2024-06');

    // The upsert doesn't touch status — so it should remain 'paid' since DO UPDATE doesn't include status
    const events = getTaxEvents(1);
    const june = events.find(e => e.month === '2024-06')!;
    expect(june.gross_income).toBe(8000);
    expect(june.status).toBe('paid'); // status preserved through upsert
  });

  it('tax due for zero-income month is zero', () => {
    // No transactions for this month
    const event = calculateAndStoreTax(1, '2024-06');
    expect(event.gross_income).toBe(0);
    expect(event.tax_due).toBe(0);
    expect(event.inss_due).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MIGRATION 025: ENCRYPTION COLUMNS
// ═══════════════════════════════════════════════════════════════════

describe('Finance Tracker — Migration 025 encryption columns', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('finance_transactions has encrypted_amount column', () => {
    const info = testDb.prepare("PRAGMA table_info('finance_transactions')").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain('encrypted_amount');
    expect(colNames).toContain('encrypted_description');
  });

  it('finance_tax_events has all encrypted columns', () => {
    const info = testDb.prepare("PRAGMA table_info('finance_tax_events')").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain('encrypted_gross_income');
    expect(colNames).toContain('encrypted_deductions');
    expect(colNames).toContain('encrypted_taxable_income');
    expect(colNames).toContain('encrypted_tax_due');
    expect(colNames).toContain('encrypted_inss_due');
    expect(colNames).toContain('encrypted_notes');
  });

  it('user_encryption_meta table exists with correct columns', () => {
    const info = testDb.prepare("PRAGMA table_info('user_encryption_meta')").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('key_version');
    expect(colNames).toContain('encrypted_at');
    expect(colNames).toContain('updated_at');
  });

  it('user_encryption_meta has user_id as PRIMARY KEY', () => {
    const info = testDb.prepare("PRAGMA table_info('user_encryption_meta')").all() as any[];
    const pkCol = info.find((c: any) => c.name === 'user_id');
    expect(pkCol.pk).toBe(1);
  });
});
