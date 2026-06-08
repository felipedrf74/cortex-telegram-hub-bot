// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { InvoiceFiling } from '../domains/types';
import { DateTime } from 'luxon';

function assertPositiveUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('userId required: must be a positive integer');
  }
}

function assertPositiveTenantId(tenantId: number): void {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('tenantId required: must be a positive integer');
  }
}

function effectiveTenantId(userId: number, tenantId?: number): number {
  const resolved = tenantId ?? userId;
  assertPositiveTenantId(resolved);
  return resolved;
}

/** Insert a new filing record (photo, email, or amazon source). */
export function recordFiling(data: {
  tenant_id?: number;
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
  object_key?: string | null;
  checksum?: string | null;
  mime?: string | null;
  bytes?: number | null;
  storage_backend?: string | null;
  status?: 'filed' | 'failed' | 'duplicate' | 'orphaned';
  error_message?: string | null;
  user_id: number;
}): InvoiceFiling {
  assertPositiveUserId(data.user_id);
  const tenantId = effectiveTenantId(data.user_id, data.tenant_id);
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO invoice_filings
      (tenant_id, user_id, vendor, amount, document_date, invoice_number, source, source_ref,
       remote_path, folder_path, filename, file_size_bytes, compressed_size_bytes,
       object_key, checksum, mime, bytes, storage_backend, status, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fileSizeBytes = data.file_size_bytes ?? null;
  const compressedSizeBytes = data.compressed_size_bytes ?? null;
  const result = stmt.run(
    tenantId,
    data.user_id,
    data.vendor,
    data.amount ?? null,
    data.document_date ?? null,
    data.invoice_number ?? null,
    data.source,
    data.source_ref ?? null,
    data.remote_path ?? null,
    data.folder_path ?? null,
    data.filename ?? null,
    fileSizeBytes,
    compressedSizeBytes,
    data.object_key ?? null,
    data.checksum ?? null,
    data.mime ?? null,
    data.bytes ?? fileSizeBytes ?? compressedSizeBytes,
    data.storage_backend ?? null,
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
export function isDuplicate(vendor: string, invoiceNumber: string | null, userId: number, tenantId = userId): boolean {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  if (!invoiceNumber) return false;
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM invoice_filings
    WHERE vendor = ? AND invoice_number = ? AND status = 'filed'
      AND tenant_id = ? AND user_id = ?
  `).get(vendor, invoiceNumber, resolvedTenantId, userId) as { count: number };
  return row.count > 0;
}

/**
 * Check if an email message has already been processed (by source_ref = messageId).
 * This catches duplicates even when invoice_number is missing/null.
 */
export function isEmailAlreadyFiled(messageId: string, userId: number, tenantId = userId): boolean {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM invoice_filings
    WHERE source = 'email' AND source_ref = ? AND status = 'filed'
      AND tenant_id = ? AND user_id = ?
  `).get(messageId, resolvedTenantId, userId) as { count: number };
  return row.count > 0;
}

/** Get all filings for a specific year/month (for reporting). */
export function getFilingsForMonth(year: number, month: number, userId: number, tenantId = userId): InvoiceFiling[] {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const monthStr = month.toString().padStart(2, '0');
  const startDate = `${year}-${monthStr}-01`;
  const endDate = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${(month + 1).toString().padStart(2, '0')}-01`;

  return db.prepare(`
    SELECT * FROM invoice_filings
    WHERE document_date >= ? AND document_date < ? AND tenant_id = ? AND user_id = ?
    ORDER BY document_date ASC, vendor ASC
  `).all(startDate, endDate, resolvedTenantId, userId) as InvoiceFiling[];
}

export function getFilingsForPeriod(
  tenantId: number,
  userId: number,
  startIso: string,
  endIso: string,
): InvoiceFiling[] {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const startDate = isoToDate(startIso);
  const endDate = periodEndExclusiveDate(endIso);
  const db = getDb();
  return db.prepare(`
    SELECT * FROM invoice_filings
    WHERE tenant_id = ? AND user_id = ?
      AND status = 'filed'
      AND document_date IS NOT NULL
      AND document_date >= ? AND document_date < ?
    ORDER BY document_date ASC, vendor ASC, id ASC
  `).all(resolvedTenantId, userId, startDate, endDate) as InvoiceFiling[];
}

function isoToDate(iso: string): string {
  const parsed = DateTime.fromISO(iso, { zone: 'utc' });
  return parsed.isValid ? parsed.toUTC().toFormat('yyyy-MM-dd') : iso.slice(0, 10);
}

function periodEndExclusiveDate(endIso: string): string {
  const parsed = DateTime.fromISO(endIso, { zone: 'utc' });
  if (!parsed.isValid) return endIso.slice(0, 10);
  const endUtc = parsed.toUTC();
  const startsAtMidnight = endUtc.toMillis() === endUtc.startOf('day').toMillis();
  return (startsAtMidnight ? endUtc : endUtc.plus({ days: 1 })).toFormat('yyyy-MM-dd');
}

export function getFilingById(tenantId: number, userId: number, id: number): InvoiceFiling | null {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  return (
    db.prepare(`
      SELECT * FROM invoice_filings
      WHERE id = ? AND tenant_id = ? AND user_id = ?
    `).get(id, resolvedTenantId, userId) as InvoiceFiling | undefined
  ) ?? null;
}

/**
 * Delete all Amazon filings for a specific year/month.
 * Used by the /amazon --force flag to re-collect invoices after a bad run.
 * Returns the number of records deleted.
 */
export function deleteAmazonFilings(year: number, month: number, userId: number, tenantId = userId): number {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
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
      AND tenant_id = ?
      AND user_id = ?
      AND document_date >= ? AND document_date < ?
  `).run(resolvedTenantId, userId, startDate, endDate);

  return result.changes;
}

/**
 * Delete all Uber filings for a specific year/month.
 * Used by the /uber --force flag to re-collect invoices after a bad run.
 */
export function deleteUberFilings(year: number, month: number, userId: number, tenantId = userId): number {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
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
      AND tenant_id = ?
      AND user_id = ?
      AND document_date >= ? AND document_date < ?
  `).run(resolvedTenantId, userId, startDate, endDate);

  return result.changes;
}

/** Get recent filings for the /invoices-log display. */
export function getRecentFilings(userId: number, limit: number = 20, tenantId = userId): InvoiceFiling[] {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  return db.prepare(`
    SELECT * FROM invoice_filings WHERE tenant_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(resolvedTenantId, userId, limit) as InvoiceFiling[];
}
