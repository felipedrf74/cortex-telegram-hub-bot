// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-user data export service for financial data.
 *
 * Provides GDPR-style data portability: export all financial data for a user
 * as a structured JSON object with decrypted values. Also supports per-user
 * data deletion (right to erasure).
 */

import { getDb } from './database';
import { getTransactions, getTaxEvents, getAnnualTaxSummary } from './finance-tracker';
import type { Transaction, TaxEvent, AnnualTaxSummary } from './finance-tracker';

export interface UserFinanceExport {
  exportedAt: string;
  userId: number;
  transactions: Transaction[];
  taxEvents: TaxEvent[];
  annualSummaries: AnnualTaxSummary[];
}

/**
 * Export all financial data for a given user.
 * Returns decrypted data ready for download/portability.
 */
export function exportUserFinanceData(userId: number): UserFinanceExport {
  const transactions = getTransactions(userId, { limit: 100000 });
  const taxEvents = getTaxEvents(userId, { limit: 100000 });

  // Determine years with data for annual summaries
  const years = new Set<number>();
  for (const tx of transactions) {
    years.add(parseInt(tx.date.substring(0, 4), 10));
  }
  for (const te of taxEvents) {
    years.add(parseInt(te.month.substring(0, 4), 10));
  }

  const annualSummaries: AnnualTaxSummary[] = [];
  for (const year of Array.from(years).sort()) {
    annualSummaries.push(getAnnualTaxSummary(userId, year));
  }

  return {
    exportedAt: new Date().toISOString(),
    userId,
    transactions,
    taxEvents,
    annualSummaries,
  };
}

/**
 * Delete all financial data for a given user (right to erasure).
 * Returns counts of deleted records.
 */
export function deleteUserFinanceData(userId: number): { transactionsDeleted: number; taxEventsDeleted: number } {
  const db = getDb();
  const txResult = db.prepare('DELETE FROM finance_transactions WHERE user_id = ?').run(userId);
  const taxResult = db.prepare('DELETE FROM finance_tax_events WHERE user_id = ?').run(userId);
  const metaResult = db.prepare('DELETE FROM user_encryption_meta WHERE user_id = ?').run(userId);

  return {
    transactionsDeleted: txResult.changes,
    taxEventsDeleted: taxResult.changes + metaResult.changes,
  };
}

/**
 * Count all financial records for a user (quick audit).
 */
export function countUserFinanceData(userId: number): { transactions: number; taxEvents: number } {
  const db = getDb();
  const txCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_transactions WHERE user_id = ?').get(userId) as { cnt: number };
  const taxCount = db.prepare('SELECT COUNT(*) as cnt FROM finance_tax_events WHERE user_id = ?').get(userId) as { cnt: number };
  return {
    transactions: txCount.cnt,
    taxEvents: taxCount.cnt,
  };
}
