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

export type BudgetViewIntegrity = 'reliable' | 'mixed_currency' | 'no_income';
export type BudgetAffordability = 'tight' | 'controlled' | 'comfortable' | 'unknown';

export interface RecurringExpenseForecast {
  fingerprint: string;
  label: string;
  currency: string;
  monthlyEstimate: number;
  monthCount: number;
  lastSeenDate: string;
  alreadyLoggedThisMonth: boolean;
}

export interface MonthlyBudgetView {
  month: string;
  basisCurrency: string;
  currencies: string[];
  integrity: BudgetViewIntegrity;
  affordability: BudgetAffordability;
  incomeInBasisCurrency: number;
  expensesInBasisCurrency: number;
  currentRemainingInBasisCurrency: number | null;
  currentRemainingRatio: number | null;
  projectedExpensesInBasisCurrency: number | null;
  projectedRemainingInBasisCurrency: number | null;
  projectedRemainingRatio: number | null;
  recurringExpenseEstimate: number;
  recurringExpenseCount: number;
  recurringExpenses: RecurringExpenseForecast[];
  notes: string[];
}

const PLANNING_CURRENCY_CONVERSION_FROM_BRL: Record<string, number> = {
  BRL: 1,
  EUR: 0.18,
  USD: 0.2,
  GBP: 0.16,
};

export function defaultCurrencyForTimezone(timezone?: string | null): string {
  const tz = timezone || 'Europe/Lisbon';
  if (tz.includes('Sao_Paulo') || tz.includes('Brazil') || tz.includes('Brasilia')) return 'BRL';
  if (tz.includes('America/New_York') || tz.includes('America/Los_Angeles') || tz.includes('America/Chicago')) return 'USD';
  if (tz.includes('London')) return 'GBP';
  return 'EUR';
}

export function getPreferredCurrencyForUser(userId: number): string {
  try {
    const db = getDb();
    const dominant = db.prepare(`
      SELECT currency, COUNT(*) as count, MAX(date) as last_date
      FROM finance_transactions
      WHERE user_id = ?
        AND currency IS NOT NULL
        AND TRIM(currency) != ''
      GROUP BY currency
      ORDER BY count DESC, last_date DESC
      LIMIT 1
    `).get(userId) as { currency?: string | null } | undefined;

    if (dominant?.currency && dominant.currency.trim().length > 0) {
      return dominant.currency.trim().toUpperCase();
    }
  } catch (err) {
    logger.debug({ err, userId }, 'Finance tracker: preferred currency lookup fell back to timezone');
  }

  try {
    const { getUserById } = require('./user-service');
    const user = getUserById?.(userId);
    return defaultCurrencyForTimezone(user?.timezone);
  } catch {
    return 'EUR';
  }
}

export function convertPlanningEstimateFromBrl(amountBrl: number, currency: string): number {
  const code = currency.toUpperCase();
  const rate = PLANNING_CURRENCY_CONVERSION_FROM_BRL[code] ?? 1;
  return Math.round(amountBrl * rate * 100) / 100;
}

export function formatCurrencyAmount(currency: string, amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  return `${currency.toUpperCase()} ${rounded.toFixed(2)}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function monthBounds(month: string): { startDate: string; endDate: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${String(monthNumber + 1).padStart(2, '0')}`;
  return {
    startDate: `${month}-01`,
    endDate: `${nextMonth}-01`,
  };
}

function normalizeCurrencyCode(currency: string | null | undefined): string {
  const normalized = currency?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : 'BRL';
}

function normalizeRecurringFingerprint(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length >= 3 ? normalized : null;
}

function looksLikeRecurringCommitment(label: string): boolean {
  return /\b(?:assinatura|subscription|rent|renda|aluguel|lease|mortgage|insurance|seguro|internet|wifi|phone|telecom|electric|electricity|water|gas|hosting|github|gym|academia|spotify|netflix|apple|icloud|google|workspace|software|saas|cloud|aws|azure|contador|accountant|contabilista|loan|prestacao)\b/i.test(label);
}

function recurringLabelForRow(row: {
  description?: string | null;
  subcategory?: string | null;
}): string | null {
  return normalizeRecurringFingerprint(row.description)
    ?? normalizeRecurringFingerprint(row.subcategory)
    ?? null;
}

function detectRecurringExpenses(opts: {
  userId: number;
  month: string;
  basisCurrency: string;
}): RecurringExpenseForecast[] {
  const db = getDb();
  const { endDate } = monthBounds(opts.month);
  const [year, monthNumber] = opts.month.split('-').map(Number);
  const historyStart = monthNumber <= 3
    ? `${year - 1}-${String(monthNumber + 9).padStart(2, '0')}-01`
    : `${year}-${String(monthNumber - 3).padStart(2, '0')}-01`;
  const rows = db.prepare(`
    SELECT date, amount, currency, subcategory, description
    FROM finance_transactions
    WHERE user_id = ?
      AND category = 'expense'
      AND date >= ?
      AND date < ?
  `).all(opts.userId, historyStart, endDate) as Array<{
    date: string;
    amount: number;
    currency: string | null;
    subcategory: string | null;
    description: string | null;
  }>;

  const byFingerprint = new Map<string, Array<{
    month: string;
    amount: number;
    date: string;
  }>>();

  for (const row of rows) {
    const currency = normalizeCurrencyCode(row.currency);
    if (currency !== opts.basisCurrency) continue;
    const fingerprint = recurringLabelForRow(row);
    if (!fingerprint) continue;
    const entries = byFingerprint.get(fingerprint) ?? [];
    entries.push({
      month: row.date.slice(0, 7),
      amount: row.amount,
      date: row.date,
    });
    byFingerprint.set(fingerprint, entries);
  }

  const recurring: RecurringExpenseForecast[] = [];
  for (const [fingerprint, entries] of byFingerprint.entries()) {
    const months = [...new Set(entries.map((entry) => entry.month))];
    if (months.length < 2) continue;
    const averageAmount = entries.reduce((sum, entry) => sum + entry.amount, 0) / entries.length;
    const maxDeviation = Math.max(...entries.map((entry) => Math.abs(entry.amount - averageAmount)));
    const stableAmount = maxDeviation <= Math.max(5, averageAmount * 0.15);
    const recurringSignal = looksLikeRecurringCommitment(fingerprint) || months.length >= 3;
    if (!stableAmount || !recurringSignal) continue;

    const label = fingerprint
      .split(' ')
      .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
      .join(' ');
    const lastSeenDate = entries
      .map((entry) => entry.date)
      .sort()
      .at(-1)!;
    recurring.push({
      fingerprint,
      label,
      currency: opts.basisCurrency,
      monthlyEstimate: roundMoney(averageAmount),
      monthCount: months.length,
      lastSeenDate,
      alreadyLoggedThisMonth: months.includes(opts.month),
    });
  }

  return recurring
    .sort((left, right) => right.monthlyEstimate - left.monthlyEstimate)
    .slice(0, 8);
}

export function getMonthlyBudgetView(userId: number, month: string): MonthlyBudgetView {
  const db = getDb();
  const { startDate, endDate } = monthBounds(month);
  const preferredCurrency = getPreferredCurrencyForUser(userId);
  const rows = db.prepare(`
    SELECT category, amount, currency, date
    FROM finance_transactions
    WHERE user_id = ?
      AND date >= ?
      AND date < ?
  `).all(userId, startDate, endDate) as Array<{
    category: string;
    amount: number;
    currency: string | null;
    date: string;
  }>;

  const incomeCurrencies = new Set<string>();
  const expenseCurrencies = new Set<string>();
  for (const row of rows) {
    const currency = normalizeCurrencyCode(row.currency);
    if (row.category === 'income') incomeCurrencies.add(currency);
    else if (row.category !== 'deduction') expenseCurrencies.add(currency);
  }

  const relevantCurrencies = [...new Set([...incomeCurrencies, ...expenseCurrencies])];
  const basisCurrency = relevantCurrencies.length === 1
    ? relevantCurrencies[0]!
    : preferredCurrency;
  const incomeInBasisCurrency = roundMoney(rows
    .filter((row) => row.category === 'income' && normalizeCurrencyCode(row.currency) === basisCurrency)
    .reduce((sum, row) => sum + row.amount, 0));
  const expensesInBasisCurrency = roundMoney(rows
    .filter((row) => row.category !== 'income' && row.category !== 'deduction' && normalizeCurrencyCode(row.currency) === basisCurrency)
    .reduce((sum, row) => sum + row.amount, 0));
  const mixedCurrency = relevantCurrencies.length > 1;
  const recurringExpenses = detectRecurringExpenses({ userId, month, basisCurrency });
  const recurringExpenseEstimate = roundMoney(recurringExpenses
    .filter((entry) => !entry.alreadyLoggedThisMonth)
    .reduce((sum, entry) => sum + entry.monthlyEstimate, 0));
  const projectedExpensesInBasisCurrency = mixedCurrency
    ? null
    : roundMoney(expensesInBasisCurrency + recurringExpenseEstimate);
  const currentRemainingInBasisCurrency = mixedCurrency
    ? null
    : roundMoney(Math.max(incomeInBasisCurrency - expensesInBasisCurrency, 0));
  const projectedRemainingInBasisCurrency = mixedCurrency || projectedExpensesInBasisCurrency == null
    ? null
    : roundMoney(Math.max(incomeInBasisCurrency - projectedExpensesInBasisCurrency, 0));
  const currentRemainingRatio = !mixedCurrency && incomeInBasisCurrency > 0
    ? roundMoney(currentRemainingInBasisCurrency! / incomeInBasisCurrency)
    : null;
  const projectedRemainingRatio = !mixedCurrency && incomeInBasisCurrency > 0 && projectedRemainingInBasisCurrency != null
    ? roundMoney(projectedRemainingInBasisCurrency / incomeInBasisCurrency)
    : null;

  let integrity: BudgetViewIntegrity = 'reliable';
  let affordability: BudgetAffordability = 'unknown';
  const notes: string[] = [];

  if (mixedCurrency) {
    integrity = 'mixed_currency';
    notes.push(
      `Mixed currencies are logged this month (${relevantCurrencies.join(', ')}), so budget headroom is not reliable until those amounts are normalized.`,
    );
  } else if (incomeInBasisCurrency <= 0) {
    integrity = 'no_income';
    notes.push(`No income is logged in ${basisCurrency} for ${month}, so affordability stays provisional.`);
  }

  if (recurringExpenseEstimate > 0) {
    notes.push(
      `Recurring expense pressure still likely this month: ${formatCurrencyAmount(basisCurrency, recurringExpenseEstimate)} across ${recurringExpenses.filter((entry) => !entry.alreadyLoggedThisMonth).length} pending commitment(s).`,
    );
  }

  if (projectedRemainingRatio != null) {
    affordability = projectedRemainingRatio <= 0.15
      ? 'tight'
      : projectedRemainingRatio <= 0.3
        ? 'controlled'
        : 'comfortable';
  }

  return {
    month,
    basisCurrency,
    currencies: relevantCurrencies.length > 0 ? relevantCurrencies : [basisCurrency],
    integrity,
    affordability,
    incomeInBasisCurrency,
    expensesInBasisCurrency,
    currentRemainingInBasisCurrency,
    currentRemainingRatio,
    projectedExpensesInBasisCurrency,
    projectedRemainingInBasisCurrency,
    projectedRemainingRatio,
    recurringExpenseEstimate,
    recurringExpenseCount: recurringExpenses.filter((entry) => !entry.alreadyLoggedThisMonth).length,
    recurringExpenses,
    notes,
  };
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
  logger.info({ userId, txId: row.id, currency: opts?.currency ?? 'BRL' }, 'Finance transaction added');
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
