/**
 * QA Validation Tests — Finance Tracker (per-user data isolation + tax calculation)
 *
 * Validates the finance-tracker.ts module, migration 022_finance_tables,
 * Portugal tax estimate, per-user isolation, and edge cases.
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
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  calculateMonthlyTax,
  calculatePortugueseMonthlyTax,
  addTransaction,
  getTransactions,
  deleteTransaction,
  getMonthlySummary,
  calculateAndStoreTax,
  getTaxEvents,
  markTaxPaid,
  IRPF_BRACKETS,
} from '../../src/services/finance-tracker';

describe('Finance Tracker — QA Validation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // ── Migration Schema Validation ─────────────────────────────────

  describe('migration 022: finance tables schema', () => {
    it('finance_transactions table has correct columns', () => {
      const info = testDb.prepare("PRAGMA table_info('finance_transactions')").all() as any[];
      const colNames = info.map((c: any) => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('user_id');
      expect(colNames).toContain('date');
      expect(colNames).toContain('category');
      expect(colNames).toContain('subcategory');
      expect(colNames).toContain('amount');
      expect(colNames).toContain('currency');
      expect(colNames).toContain('description');
      expect(colNames).toContain('receipt_ref');
      expect(colNames).toContain('created_at');
      expect(colNames).toContain('updated_at');
    });

    it('finance_tax_events has UNIQUE(tenant_id, user_id, month) constraint', () => {
      testDb.prepare(`
        INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
        VALUES (1, 1, '2024-01', 5000, 0, 5000, 500, 100)
      `).run();

      // Inserting same tenant_id + user_id + month should fail.
      expect(() => {
        testDb.prepare(`
          INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
          VALUES (1, 1, '2024-01', 6000, 0, 6000, 600, 120)
        `).run();
      }).toThrow();
    });

    it('has indexes on finance tables', () => {
      const indexes = testDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_finance%'"
      ).all() as any[];
      const names = indexes.map((i: any) => i.name);
      expect(names).toContain('idx_finance_tx_user_date');
      expect(names).toContain('idx_finance_tx_category');
      expect(names).toContain('idx_finance_tax_user_month');
    });

    it('finance_transactions defaults currency to EUR after Portugal migration', () => {
      testDb.prepare(`
        INSERT INTO finance_transactions (tenant_id, user_id, date, category, amount)
        VALUES (1, 1, '2024-01-15', 'income', 5000)
      `).run();
      const row = testDb.prepare('SELECT currency FROM finance_transactions WHERE id = 1').get() as any;
      expect(row.currency).toBe('EUR');
    });

    it('finance tables carry tenant scope and tenant-unique tax months', () => {
      const txColumns = testDb.prepare("PRAGMA table_info('finance_transactions')").all() as any[];
      const taxColumns = testDb.prepare("PRAGMA table_info('finance_tax_events')").all() as any[];
      expect(txColumns.map((col) => col.name)).toContain('tenant_id');
      expect(taxColumns.map((col) => col.name)).toContain('tenant_id');

      testDb.prepare(`
        INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
        VALUES (10, 1, '2026-05', 1000, 0, 1000, 100, 0)
      `).run();
      testDb.prepare(`
        INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
        VALUES (11, 1, '2026-05', 1000, 0, 1000, 100, 0)
      `).run();
      expect(() => testDb.prepare(`
        INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
        VALUES (10, 1, '2026-05', 1000, 0, 1000, 100, 0)
      `).run()).toThrow();
    });

    it('finance_tax_events defaults status to pending', () => {
      testDb.prepare(`
        INSERT INTO finance_tax_events (tenant_id, user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due)
        VALUES (1, 1, '2024-01', 5000, 0, 5000, 500, 100)
      `).run();
      const row = testDb.prepare('SELECT status FROM finance_tax_events WHERE id = 1').get() as any;
      expect(row.status).toBe('pending');
    });
  });

  // ── Portugal Tax Calculation ───────────────────────────────────

  describe('Portugal tax calculation', () => {
    it('legacy Brazilian monthly tax entry point throws instead of serving runtime calculations', () => {
      expect(() => calculateMonthlyTax()).toThrow(/Brazilian tax engine removed; see finance-tax-pt/);
    });

    it('zero income results in zero tax', () => {
      const result = calculatePortugueseMonthlyTax(0);
      expect(result.taxDue).toBe(0);
      expect(result.inssDue).toBe(0);
      expect(result.effectiveRate).toBe(0);
      expect(result.bracket).toBe('Isento');
    });

    it('Portugal monthly estimate uses annualized brackets and no Brazilian INSS', () => {
      const result = calculatePortugueseMonthlyTax(2000);
      expect(result.ruleset).toBe('pt-irs-2026-mainland-estimate');
      expect(result.taxDue).toBe(364.27);
      expect(result.bracket).toBe('31.1%');
      expect(result.inssDue).toBe(0);
      expect(result.ptInvoiceCode).toBe('PT-IRS-ESTIMATE');
    });

    it('Portugal estimate includes IVA while leaving taxable income as IRS base', () => {
      const result = calculatePortugueseMonthlyTax(3000);
      expect(result.inssDue).toBe(0);
      expect(result.taxableIncome).toBe(3000);
      expect(result.ivaDue).toBe(690);
      expect(result.taxDue).toBeGreaterThan(0);
    });

    it('high income uses highest Portugal bracket (48%)', () => {
      const result = calculatePortugueseMonthlyTax(20000);
      expect(result.bracket).toBe('48.0%');
      expect(result.taxDue).toBeGreaterThan(0);
      expect(result.effectiveRate).toBeGreaterThan(0);
    });

    it('deductions reduce taxable income', () => {
      const withoutDeductions = calculatePortugueseMonthlyTax(5000, 0);
      const withDeductions = calculatePortugueseMonthlyTax(5000, 1000);
      expect(withDeductions.taxableIncome).toBeLessThan(withoutDeductions.taxableIncome);
      expect(withDeductions.taxDue).toBeLessThan(withoutDeductions.taxDue);
    });

    it('deductions cannot make taxable income negative', () => {
      const result = calculatePortugueseMonthlyTax(1000, 5000);
      expect(result.taxableIncome).toBe(0);
      expect(result.taxDue).toBe(0);
    });

    it('legacy Brazilian bracket constants are quarantined and not used by calculatePortugueseMonthlyTax', () => {
      expect(IRPF_BRACKETS.length).toBe(5);
      expect(IRPF_BRACKETS[0].rate).toBe(0);
      expect(IRPF_BRACKETS[IRPF_BRACKETS.length - 1].upTo).toBe(Infinity);
      expect(calculatePortugueseMonthlyTax(3000).bracket).not.toBe('7.5%');
    });

    it('effective rate increases with income (progressive taxation)', () => {
      const low = calculatePortugueseMonthlyTax(3000);
      const mid = calculatePortugueseMonthlyTax(8000);
      const high = calculatePortugueseMonthlyTax(20000);
      expect(high.effectiveRate).toBeGreaterThan(mid.effectiveRate);
      expect(mid.effectiveRate).toBeGreaterThan(low.effectiveRate);
    });
  });

  // ── Per-User Data Isolation ─────────────────────────────────────

  describe('per-user data isolation', () => {
    it('user 1 cannot see user 2 transactions', () => {
      addTransaction(1, '2024-01-15', 'income', 5000);
      addTransaction(2, '2024-01-15', 'income', 8000);

      const user1Txs = getTransactions(1);
      const user2Txs = getTransactions(2);

      expect(user1Txs.length).toBe(1);
      expect(user1Txs[0].amount).toBe(5000);
      expect(user2Txs.length).toBe(1);
      expect(user2Txs[0].amount).toBe(8000);
    });

    it('user cannot delete another user transaction', () => {
      const tx = addTransaction(1, '2024-01-15', 'income', 5000);
      const deleted = deleteTransaction(2, tx.id);
      expect(deleted).toBe(false);
      // Original user can still see it
      expect(getTransactions(1).length).toBe(1);
    });

    it('monthly summaries are per-user', () => {
      addTransaction(1, '2024-01-15', 'income', 5000);
      addTransaction(2, '2024-01-15', 'income', 8000);

      const summary1 = getMonthlySummary(1, '2024-01');
      const summary2 = getMonthlySummary(2, '2024-01');

      expect(summary1.totalIncome).toBe(5000);
      expect(summary2.totalIncome).toBe(8000);
    });

    it('tax events are per-user', () => {
      addTransaction(1, '2024-01-15', 'income', 5000);
      addTransaction(2, '2024-01-15', 'income', 8000);

      calculateAndStoreTax(1, '2024-01');
      calculateAndStoreTax(2, '2024-01');

      const tax1 = getTaxEvents(1);
      const tax2 = getTaxEvents(2);

      expect(tax1.length).toBe(1);
      expect(tax2.length).toBe(1);
      expect(tax1[0].gross_income).toBe(5000);
      expect(tax2[0].gross_income).toBe(8000);
    });
  });

  // ── Transaction CRUD Edge Cases ─────────────────────────────────

  describe('transaction CRUD edge cases', () => {
    it('addTransaction stores all optional fields', () => {
      const tx = addTransaction(1, '2024-03-15', 'expense', 150, {
        subcategory: 'software',
        description: 'GitHub subscription',
        currency: 'USD',
        receiptRef: 'photo_123',
      });
      expect(tx.subcategory).toBe('software');
      expect(tx.description).toBe('GitHub subscription');
      expect(tx.currency).toBe('USD');
      expect(tx.receipt_ref).toBe('photo_123');
    });

    it('getTransactions filters by date range', () => {
      addTransaction(1, '2024-01-10', 'income', 1000);
      addTransaction(1, '2024-02-15', 'income', 2000);
      addTransaction(1, '2024-03-20', 'income', 3000);

      const txs = getTransactions(1, { startDate: '2024-02-01', endDate: '2024-02-28' });
      expect(txs.length).toBe(1);
      expect(txs[0].amount).toBe(2000);
    });

    it('getTransactions filters by category', () => {
      addTransaction(1, '2024-01-15', 'income', 5000);
      addTransaction(1, '2024-01-15', 'expense', 200);
      addTransaction(1, '2024-01-15', 'deduction', 500);

      const expenses = getTransactions(1, { category: 'expense' });
      expect(expenses.length).toBe(1);
      expect(expenses[0].category).toBe('expense');
    });

    it('getTransactions respects limit', () => {
      for (let i = 0; i < 10; i++) {
        addTransaction(1, '2024-01-15', 'expense', i * 100);
      }
      const txs = getTransactions(1, { limit: 3 });
      expect(txs.length).toBe(3);
    });

    it('getTransactions default limit is 50', () => {
      for (let i = 0; i < 55; i++) {
        addTransaction(1, '2024-01-15', 'expense', i * 10);
      }
      const txs = getTransactions(1);
      expect(txs.length).toBe(50);
    });

    it('deleteTransaction returns true for own transaction', () => {
      const tx = addTransaction(1, '2024-01-15', 'income', 5000);
      expect(deleteTransaction(1, tx.id)).toBe(true);
      expect(getTransactions(1).length).toBe(0);
    });

    it('deleteTransaction returns false for non-existent id', () => {
      expect(deleteTransaction(1, 9999)).toBe(false);
    });
  });

  // ── Monthly Summary Edge Cases ──────────────────────────────────

  describe('monthly summary edge cases', () => {
    it('empty month returns zeroes', () => {
      const summary = getMonthlySummary(1, '2024-06');
      expect(summary.totalIncome).toBe(0);
      expect(summary.totalExpenses).toBe(0);
      expect(summary.totalDeductions).toBe(0);
      expect(summary.netIncome).toBe(0);
      expect(summary.transactionCount).toBe(0);
    });

    it('correctly separates income, expenses, and deductions', () => {
      addTransaction(1, '2024-03-05', 'income', 10000);
      addTransaction(1, '2024-03-10', 'expense', 2000);
      addTransaction(1, '2024-03-15', 'expense', 500);
      addTransaction(1, '2024-03-20', 'deduction', 1000);

      const summary = getMonthlySummary(1, '2024-03');
      expect(summary.totalIncome).toBe(10000);
      expect(summary.totalExpenses).toBe(2500);
      expect(summary.totalDeductions).toBe(1000);
      expect(summary.netIncome).toBe(7500); // 10000 - 2500
      expect(summary.transactionCount).toBe(4);
    });

    it('handles December to January boundary', () => {
      addTransaction(1, '2024-12-15', 'income', 5000);
      addTransaction(1, '2025-01-05', 'income', 6000);

      const dec = getMonthlySummary(1, '2024-12');
      const jan = getMonthlySummary(1, '2025-01');
      expect(dec.totalIncome).toBe(5000);
      expect(jan.totalIncome).toBe(6000);
    });
  });

  // ── Tax Event Persistence ───────────────────────────────────────

  describe('tax event persistence', () => {
    it('calculateAndStoreTax creates a tax event', () => {
      addTransaction(1, '2024-03-15', 'income', 8000);
      const taxEvent = calculateAndStoreTax(1, '2024-03');
      expect(taxEvent.user_id).toBe(1);
      expect(taxEvent.month).toBe('2024-03');
      expect(taxEvent.gross_income).toBe(8000);
      expect(taxEvent.status).toBe('pending');
    });

    it('calculateAndStoreTax uses UPSERT (updates on conflict)', () => {
      addTransaction(1, '2024-03-15', 'income', 5000);
      calculateAndStoreTax(1, '2024-03');

      // Add more income and recalculate
      addTransaction(1, '2024-03-20', 'income', 3000);
      const updated = calculateAndStoreTax(1, '2024-03');

      expect(updated.gross_income).toBe(8000);

      // Should still be one event, not two
      const events = getTaxEvents(1);
      expect(events.length).toBe(1);
    });

    it('getTaxEvents filters by year', () => {
      addTransaction(1, '2024-01-15', 'income', 5000);
      addTransaction(1, '2024-06-15', 'income', 5000);
      addTransaction(1, '2025-01-15', 'income', 5000);

      calculateAndStoreTax(1, '2024-01');
      calculateAndStoreTax(1, '2024-06');
      calculateAndStoreTax(1, '2025-01');

      const events2024 = getTaxEvents(1, { year: 2024 });
      expect(events2024.length).toBe(2);
      expect(events2024.every(e => e.month.startsWith('2024'))).toBe(true);
    });

    it('markTaxPaid updates status and paid_at', () => {
      addTransaction(1, '2024-03-15', 'income', 5000);
      calculateAndStoreTax(1, '2024-03');

      const result = markTaxPaid(1, '2024-03');
      expect(result).toBe(true);

      const events = getTaxEvents(1);
      expect(events[0].status).toBe('paid');
      expect(events[0].paid_at).toBeTruthy();
    });

    it('markTaxPaid returns false for non-existent month', () => {
      expect(markTaxPaid(1, '2024-99')).toBe(false);
    });

    it('user 1 cannot markTaxPaid for user 2', () => {
      addTransaction(2, '2024-03-15', 'income', 5000);
      calculateAndStoreTax(2, '2024-03');
      expect(markTaxPaid(1, '2024-03')).toBe(false);
    });
  });

  // ── Skill Config Integration ────────────────────────────────────

  describe('skill config: finance domain', () => {
    it('finance skill definition exists with correct structure', async () => {
      const { DEFAULT_SKILLS } = await import('../../src/skills/skill-config');
      expect(DEFAULT_SKILLS.finance).toBeDefined();
      expect(DEFAULT_SKILLS.finance.name).toBe('finance');
      expect(DEFAULT_SKILLS.finance.subSkills.length).toBeGreaterThanOrEqual(2);
    });

    it('finance skill has expenses and tax sub-skills', async () => {
      const { DEFAULT_SKILLS } = await import('../../src/skills/skill-config');
      const subNames = DEFAULT_SKILLS.finance.subSkills.map(s => s.name);
      expect(subNames).toContain('expenses');
      expect(subNames).toContain('tax');
    });

    it('finance routing has pattern and keyword routes', async () => {
      const { DEFAULT_SKILLS } = await import('../../src/skills/skill-config');
      expect(DEFAULT_SKILLS.finance.routing.patternRoutes.length).toBeGreaterThan(0);
      expect(DEFAULT_SKILLS.finance.routing.keywordRoute).not.toBeNull();
      expect(DEFAULT_SKILLS.finance.routing.classificationHint.label).toBe('finance');
    });
  });
});
