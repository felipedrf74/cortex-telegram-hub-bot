// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { InvoiceFiling } from '../domains/types';

/** Insert a new filing record (photo, email, or amazon source). */
export function recordFiling(data: {
  vendor: string;
  amount?: string | null;
  document_date?: string | null;
  invoice_number?: string | null;
  source: 'photo' | 'email' | 'amazon' | 'uber';
  source_ref?: string | null;
  remote_path?: string | null;
  folder_path?: string | null;
  filename?: string | null;
  file_size_bytes?: number | null;
  compressed_size_bytes?: number | null;
  status?: 'filed' | 'failed' | 'duplicate';
  error_message?: string | null;
}): InvoiceFiling {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO invoice_filings
      (vendor, amount, document_date, invoice_number, source, source_ref,
       remote_path, folder_path, filename, file_size_bytes, compressed_size_bytes,
       status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    data.vendor,
    data.amount ?? null,
    data.document_date ?? null,
    data.invoice_number ?? null,
    data.source,
    data.source_ref ?? null,
    data.remote_path ?? null,
    data.folder_path ?? null,
    data.filename ?? null,
    data.file_size_bytes ?? null,
    data.compressed_size_bytes ?? null,
    data.status ?? 'filed',
    data.error_message ?? null,
  );
  return db.prepare('SELECT * FROM invoice_filings WHERE id = ?')
    .get(result.lastInsertRowid) as InvoiceFiling;
}

/**
 * Check if an invoice has already been filed for a given vendor + invoice number.
 * Only considers successfully filed invoices (status = 'filed').
 */
export function isDuplicate(vendor: string, invoiceNumber: string | null): boolean {
  if (!invoiceNumber) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM invoice_filings
    WHERE vendor = ? AND invoice_number = ? AND status = 'filed'
  `).get(vendor, invoiceNumber) as { count: number };
  return row.count > 0;
}

/**
 * Check if an email message has already been processed (by source_ref = messageId).
 * This catches duplicates even when invoice_number is missing/null.
 */
export function isEmailAlreadyFiled(messageId: string): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM invoice_filings
    WHERE source = 'email' AND source_ref = ? AND status = 'filed'
  `).get(messageId) as { count: number };
  return row.count > 0;
}

/** Get all filings for a specific year/month (for reporting). */
export function getFilingsForMonth(year: number, month: number): InvoiceFiling[] {
  const db = getDb();
  const monthStr = month.toString().padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${(month + 1).toString().padStart(2, '0')}-01`;

  return db.prepare(`
    SELECT * FROM invoice_filings
    WHERE document_date >= ? AND document_date < ?
    ORDER BY document_date ASC, vendor ASC
  `).all(startDate, endDate) as InvoiceFiling[];
}

/**
 * Delete all Amazon filings for a specific year/month.
 * Used by the /amazon --force flag to re-collect invoices after a bad run.
 * Returns the number of records deleted.
 */
export function deleteAmazonFilings(year: number, month: number): number {
  const db = getDb();
  const monthStr = month.toString().padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${(month + 1).toString().padStart(2, '0')}-01`;

  const result = db.prepare(`
    DELETE FROM invoice_filings
    WHERE vendor = 'Amazon.es'
      AND source = 'amazon'
      AND document_date >= ? AND document_date < ?
  `).run(startDate, endDate);

  return result.changes;
}

/**
 * Delete all Uber filings for a specific year/month.
 * Used by the /uber --force flag to re-collect invoices after a bad run.
 */
export function deleteUberFilings(year: number, month: number): number {
  const db = getDb();
  const monthStr = month.toString().padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${(month + 1).toString().padStart(2, '0')}-01`;

  const result = db.prepare(`
    DELETE FROM invoice_filings
    WHERE vendor = 'Uber'
      AND source = 'uber'
      AND document_date >= ? AND document_date < ?
  `).run(startDate, endDate);

  return result.changes;
}

/** Get recent filings for the /invoices-log display. */
export function getRecentFilings(limit: number = 20): InvoiceFiling[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM invoice_filings
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as InvoiceFiling[];
}
