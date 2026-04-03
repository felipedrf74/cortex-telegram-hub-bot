// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Finance Tracker Service
 *
 * Provides expense tracking and Brazilian tax calculation (Carnê-Leão / DARF).
 * All data is per-user via user_id.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { encryptNumber, decryptNumber, encryptValue, decryptValue } from '../utils/encryption';

// ── Encryption Helpers ────────────────────────────────────────────

function getEncryptionKey(): string | null {
  const { enabled, masterKey } = config.financeEncryption;
  if (!enabled || !masterKey) return null;
  return masterKey;
}

function tryEncryptNum(value: number, userId: number): string | null {
  const key = getEncryptionKey();
  if (!key) return null;
  return encryptNumber(value, key, userId);
}

function tryEncryptStr(value: string | null, userId: number): string | null {
  const key = getEncryptionKey();
  if (!key || !value) return null;
  return encryptValue(value, key, userId);
}

function readEncryptedNum(encrypted: string | null, plaintext: number, userId: number): number {
  if (!encrypted) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  try {
    return decryptNumber(encrypted, key, userId);
  } catch {
    return plaintext;
  }
}

function readEncryptedStr(encrypted: string | null, plaintext: string | null, userId: number): string | null {
  if (!encrypted) return plaintext;
  const key = getEncryptionKey();
  if (!key) return plaintext;
  try {
    return decryptValue(encrypted, key, userId);
  } catch {
    return plaintext;
  }
}

/** Decrypt a transaction row's encrypted fields in place. */
function decryptTransaction(row: any): Transaction {
  if (!row) return row;
  const userId = row.user_id;
  return {
    ...row,
    amount: readEncryptedNum(row.encrypted_amount, row.amount, userId),
    description: readEncryptedStr(row.encrypted_description, row.description, userId),
  };
}

/** Decrypt a tax event row's encrypted fields in place. */
function decryptTaxEvent(row: any): TaxEvent {
  if (!row) return row;
  const userId = row.user_id;
  return {
    ...row,
    gross_income: readEncryptedNum(row.encrypted_gross_income, row.gross_income, userId),
    deductions: readEncryptedNum(row.encrypted_deductions, row.deductions, userId),
    taxable_income: readEncryptedNum(row.encrypted_taxable_income, row.taxable_income, userId),
    tax_due: readEncryptedNum(row.encrypted_tax_due, row.tax_due, userId),
    inss_due: readEncryptedNum(row.encrypted_inss_due, row.inss_due, userId),
    notes: readEncryptedStr(row.encrypted_notes, row.notes, userId),
  };
}

// ── Types ──────────────────────────────────────────────────────────

export interface Transaction {
  id: number;
  user_id: number;
  date: string;
  category: string;
  subcategory: string | null;
  amount: number;
  currency: string;
  description: string | null;
  receipt_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxEvent {
  id: number;
  user_id: number;
  month: string;
  gross_income: number;
  deductions: number;
  taxable_income: number;
  tax_due: number;
  inss_due: number;
  status: string;
  darf_code: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxBreakdown {
  grossIncome: number;
  deductions: number;
  inssDue: number;
  taxableIncome: number;
  taxDue: number;
  effectiveRate: number;
  bracket: string;
}

export interface MonthlySummary {
  month: string;
  totalIncome: number;
  totalExpenses: number;
  totalDeductions: number;
  netIncome: number;
  transactionCount: number;
}

// ── Brazilian Tax Tables (2024 — Carnê-Leão / IRPF Progressivo) ───

/**
 * Progressive income tax brackets for monthly calculation.
 * Source: Receita Federal do Brasil — Tabela Progressiva Mensal 2024.
 */
export const IRPF_BRACKETS = [
  { upTo: 2259.20, rate: 0,     deduction: 0 },
  { upTo: 2826.65, rate: 0.075, deduction: 169.44 },
  { upTo: 3751.05, rate: 0.15,  deduction: 381.44 },
  { upTo: 4664.68, rate: 0.225, deduction: 662.77 },
  { upTo: Infinity, rate: 0.275, deduction: 896.00 },
];

/** INSS contribution ceiling for individual contributor (2024). */
export const INSS_CEILING = 908.86; // 20% of R$7,786.02 ceiling, capped

/** INSS rate for individual contributor (contribuinte individual). */
export const INSS_RATE = 0.20;

/** Maximum INSS contribution base. */
export const INSS_MAX_BASE = 7786.02;

// ── Tax Calculation ────────────────────────────────────────────────

/**
 * Calculate monthly IRPF (Carnê-Leão) tax breakdown.
 *
 * @param grossIncome  Total monthly income (freelance, rental, etc.)
 * @param deductions   Deductible expenses (health, education, dependents, etc.)
 * @returns Full tax breakdown with effective rate
 */
export function calculateMonthlyTax(grossIncome: number, deductions: number = 0): TaxBreakdown {
  // INSS for individual contributor: 20% of income, capped
  const inssBase = Math.min(grossIncome, INSS_MAX_BASE);
  const inssDue = Math.round(inssBase * INSS_RATE * 100) / 100;

  // Taxable income = gross - INSS - other deductions
  const taxableIncome = Math.max(0, grossIncome - inssDue - deductions);

  // Find the bracket
  let taxDue = 0;
  let bracketLabel = 'Isento';

  for (const bracket of IRPF_BRACKETS) {
    if (taxableIncome <= bracket.upTo) {
      taxDue = Math.max(0, taxableIncome * bracket.rate - bracket.deduction);
      taxDue = Math.round(taxDue * 100) / 100;
      bracketLabel = bracket.rate === 0
        ? 'Isento'
        : `${(bracket.rate * 100).toFixed(1)}%`;
      break;
    }
  }

  const effectiveRate = grossIncome > 0
    ? Math.round((taxDue / grossIncome) * 10000) / 100
    : 0;

  return {
    grossIncome,
    deductions,
    inssDue,
    taxableIncome,
    taxDue,
    effectiveRate,
    bracket: bracketLabel,
  };
}

// ── Transaction CRUD ───────────────────────────────────────────────

export function addTransaction(
  userId: number,
  date: string,
  category: string,
  amount: number,
  opts?: { subcategory?: string; description?: string; currency?: string; receiptRef?: string },
): Transaction {
  const db = getDb();
  const encAmt = tryEncryptNum(amount, userId);
  const encDesc = tryEncryptStr(opts?.description ?? null, userId);

  const stmt = db.prepare(`
    INSERT INTO finance_transactions
      (user_id, date, category, subcategory, amount, currency, description, receipt_ref, encrypted_amount, encrypted_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    userId, date, category,
    opts?.subcategory ?? null,
    amount,
    opts?.currency ?? 'BRL',
    opts?.description ?? null,
    opts?.receiptRef ?? null,
    encAmt,
    encDesc,
  );
  const row = db.prepare('SELECT * FROM finance_transactions WHERE rowid = last_insert_rowid()').get() as any;
  logger.info({ userId, category, amount }, 'Finance transaction added');
  return decryptTransaction(row);
}

export function getTransactions(
  userId: number,
  opts?: { startDate?: string; endDate?: string; category?: string; limit?: number },
): Transaction[] {
  const db = getDb();
  const conditions = ['user_id = ?'];
  const params: any[] = [userId];

  if (opts?.startDate) { conditions.push('date >= ?'); params.push(opts.startDate); }
  if (opts?.endDate) { conditions.push('date <= ?'); params.push(opts.endDate); }
  if (opts?.category) { conditions.push('category = ?'); params.push(opts.category); }

  const limit = opts?.limit ?? 50;
  const sql = `SELECT * FROM finance_transactions WHERE ${conditions.join(' AND ')} ORDER BY date DESC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(decryptTransaction);
}

export function deleteTransaction(userId: number, transactionId: number): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM finance_transactions WHERE id = ? AND user_id = ?').run(transactionId, userId);
  return result.changes > 0;
}

// ── Monthly Summary ────────────────────────────────────────────────

export function getMonthlySummary(userId: number, month: string): MonthlySummary {
  const db = getDb();
  const startDate = `${month}-01`;
  // End of month: use next month's first day
  const [y, m] = month.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const rows = db.prepare(`
    SELECT category, SUM(amount) as total, COUNT(*) as cnt
    FROM finance_transactions
    WHERE user_id = ? AND date >= ? AND date < ?
    GROUP BY category
  `).all(userId, startDate, endDate) as { category: string; total: number; cnt: number }[];

  let totalIncome = 0;
  let totalExpenses = 0;
  let totalDeductions = 0;
  let transactionCount = 0;

  for (const row of rows) {
    transactionCount += row.cnt;
    if (row.category === 'income') totalIncome += row.total;
    else if (row.category === 'deduction') totalDeductions += row.total;
    else totalExpenses += row.total;
  }

  return {
    month,
    totalIncome,
    totalExpenses,
    totalDeductions,
    netIncome: totalIncome - totalExpenses,
    transactionCount,
  };
}

// ── Tax Event Persistence ──────────────────────────────────────────

export function calculateAndStoreTax(userId: number, month: string): TaxEvent {
  const summary = getMonthlySummary(userId, month);
  const tax = calculateMonthlyTax(summary.totalIncome, summary.totalDeductions);

  const db = getDb();
  db.prepare(`
    INSERT INTO finance_tax_events
      (user_id, month, gross_income, deductions, taxable_income, tax_due, inss_due, darf_code,
       encrypted_gross_income, encrypted_deductions, encrypted_taxable_income, encrypted_tax_due, encrypted_inss_due)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET
      gross_income = excluded.gross_income,
      deductions = excluded.deductions,
      taxable_income = excluded.taxable_income,
      tax_due = excluded.tax_due,
      inss_due = excluded.inss_due,
      encrypted_gross_income = excluded.encrypted_gross_income,
      encrypted_deductions = excluded.encrypted_deductions,
      encrypted_taxable_income = excluded.encrypted_taxable_income,
      encrypted_tax_due = excluded.encrypted_tax_due,
      encrypted_inss_due = excluded.encrypted_inss_due,
      updated_at = datetime('now')
  `).run(
    userId, month,
    tax.grossIncome, tax.deductions, tax.taxableIncome, tax.taxDue, tax.inssDue,
    '0190',
    tryEncryptNum(tax.grossIncome, userId),
    tryEncryptNum(tax.deductions, userId),
    tryEncryptNum(tax.taxableIncome, userId),
    tryEncryptNum(tax.taxDue, userId),
    tryEncryptNum(tax.inssDue, userId),
  );

  const row = db.prepare('SELECT * FROM finance_tax_events WHERE user_id = ? AND month = ?').get(userId, month) as any;
  return decryptTaxEvent(row);
}

export function getTaxEvents(userId: number, opts?: { year?: number; limit?: number }): TaxEvent[] {
  const db = getDb();
  let rows: any[];
  if (opts?.year) {
    const start = `${opts.year}-01`;
    const end = `${opts.year}-12`;
    rows = db.prepare(
      'SELECT * FROM finance_tax_events WHERE user_id = ? AND month >= ? AND month <= ? ORDER BY month DESC',
    ).all(userId, start, end) as any[];
  } else {
    rows = db.prepare(
      'SELECT * FROM finance_tax_events WHERE user_id = ? ORDER BY month DESC LIMIT ?',
    ).all(userId, opts?.limit ?? 12) as any[];
  }
  return rows.map(decryptTaxEvent);
}

export function markTaxPaid(userId: number, month: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE finance_tax_events SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND month = ?",
  ).run(userId, month);
  return result.changes > 0;
}

// ── Annual Tax Summary ────────────────────────────────────────────

export interface AnnualTaxSummary {
  year: number;
  totalGrossIncome: number;
  totalDeductions: number;
  totalInssDue: number;
  totalTaxDue: number;
  totalPaid: number;
  totalPending: number;
  effectiveAnnualRate: number;
  monthsPaid: number;
  monthsPending: number;
  months: TaxEvent[];
}

/**
 * Get annual tax summary — aggregates all monthly tax events for IRPF declaration.
 * Returns totals for income, deductions, INSS, tax due, and payment status.
 */
export function getAnnualTaxSummary(userId: number, year: number): AnnualTaxSummary {
  const events = getTaxEvents(userId, { year });

  let totalGrossIncome = 0;
  let totalDeductions = 0;
  let totalInssDue = 0;
  let totalTaxDue = 0;
  let totalPaid = 0;
  let totalPending = 0;
  let monthsPaid = 0;
  let monthsPending = 0;

  for (const e of events) {
    totalGrossIncome += e.gross_income;
    totalDeductions += e.deductions;
    totalInssDue += e.inss_due;
    totalTaxDue += e.tax_due;
    if (e.status === 'paid') {
      totalPaid += e.tax_due;
      monthsPaid++;
    } else {
      totalPending += e.tax_due;
      monthsPending++;
    }
  }

  const effectiveAnnualRate = totalGrossIncome > 0
    ? Math.round((totalTaxDue / totalGrossIncome) * 10000) / 100
    : 0;

  return {
    year,
    totalGrossIncome: Math.round(totalGrossIncome * 100) / 100,
    totalDeductions: Math.round(totalDeductions * 100) / 100,
    totalInssDue: Math.round(totalInssDue * 100) / 100,
    totalTaxDue: Math.round(totalTaxDue * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    totalPending: Math.round(totalPending * 100) / 100,
    effectiveAnnualRate,
    monthsPaid,
    monthsPending,
    months: events,
  };
}

// ── Receipt Amount Parsing ────────────────────────────────────────

/**
 * Parse a currency string from a receipt into a numeric amount.
 * Handles formats: "R$ 45,90", "€ 45.90", "45.90", "1.234,56", "R$1234.56"
 */
export function parseReceiptAmount(amountStr: string | null | undefined): number | null {
  if (!amountStr) return null;

  // Strip currency symbols and whitespace
  let cleaned = amountStr.replace(/[R$€£¥\s]/g, '').trim();

  if (!cleaned) return null;

  // Detect Brazilian format: 1.234,56 (dots as thousands, comma as decimal)
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(cleaned) || /^\d+(,\d{1,2})$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  }

  const amount = parseFloat(cleaned);
  return isNaN(amount) || amount <= 0 ? null : Math.round(amount * 100) / 100;
}
