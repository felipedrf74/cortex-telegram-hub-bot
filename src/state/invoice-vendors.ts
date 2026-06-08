// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { InvoiceVendor } from '../domains/types';

function normalizeSenderPattern(senderPattern: string): string {
  return senderPattern.trim().toLowerCase();
}

function normalizeSenderPatternList(senderPatterns: string[]): string[] {
  return [...new Set(senderPatterns.map(normalizeSenderPattern).filter(Boolean))];
}

function normalizeSubjectPatterns(subjectPatterns?: string): string | null {
  if (!subjectPatterns) return null;
  const normalized = subjectPatterns
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .join(',');
  return normalized || null;
}

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

function hasVendorSenderTable(): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invoice_vendor_senders'",
  ).get();
  return !!row;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function findExistingVendorIdForSenderPatterns(
  senderPatterns: string[],
  userId: number,
  tenantId: number,
): number | null {
  const db = getDb();
  if (senderPatterns.length === 0) return null;

  if (hasVendorSenderTable()) {
    const row = db.prepare(`
      SELECT vendor_id AS id
        FROM invoice_vendor_senders
       WHERE tenant_id = ?
         AND user_id = ?
         AND sender_pattern IN (${placeholders(senderPatterns.length)})
       ORDER BY enabled DESC, id ASC
       LIMIT 1
    `).get(tenantId, userId, ...senderPatterns) as { id: number } | undefined;
    if (row) return row.id;
  }

  const row = db.prepare(`
    SELECT id
      FROM invoice_vendors
     WHERE sender_pattern IN (${placeholders(senderPatterns.length)})
       AND tenant_id = ?
       AND user_id = ?
     ORDER BY enabled DESC, id ASC
     LIMIT 1
  `).get(...senderPatterns, tenantId, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

function replaceVendorSenderPatterns(
  vendorId: number,
  userId: number,
  tenantId: number,
  senderPatterns: string[],
): void {
  if (!hasVendorSenderTable()) return;
  const db = getDb();
  db.prepare(
    'UPDATE invoice_vendor_senders SET enabled = 0 WHERE vendor_id = ? AND tenant_id = ? AND user_id = ?',
  ).run(vendorId, tenantId, userId);
  const insert = db.prepare(`
    INSERT INTO invoice_vendor_senders (vendor_id, tenant_id, user_id, sender_pattern, enabled)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(tenant_id, user_id, sender_pattern)
    DO UPDATE SET vendor_id = excluded.vendor_id, enabled = 1
  `);
  for (const senderPattern of senderPatterns) {
    insert.run(vendorId, tenantId, userId, senderPattern);
  }
}

function withSenderPatterns(rows: InvoiceVendor[], userId: number, tenantId: number): InvoiceVendor[] {
  if (rows.length === 0 || !hasVendorSenderTable()) {
    return rows.map((row) => ({ ...row, sender_patterns: [row.sender_pattern] }));
  }

  const db = getDb();
  const ids = rows.map((row) => row.id);
  const senderRows = db.prepare(`
    SELECT vendor_id, sender_pattern
      FROM invoice_vendor_senders
     WHERE tenant_id = ?
       AND user_id = ?
       AND enabled = 1
       AND vendor_id IN (${placeholders(ids.length)})
     ORDER BY id ASC
  `).all(tenantId, userId, ...ids) as Array<{ vendor_id: number; sender_pattern: string }>;

  const byVendor = new Map<number, string[]>();
  for (const senderRow of senderRows) {
    const current = byVendor.get(senderRow.vendor_id) ?? [];
    current.push(senderRow.sender_pattern);
    byVendor.set(senderRow.vendor_id, current);
  }

  return rows.map((row) => ({
    ...row,
    sender_patterns: byVendor.get(row.id) ?? [row.sender_pattern],
  }));
}

/**
 * Add a new custom vendor for monthly invoice collection.
 * Sender patterns are normalized to lowercase so vendor identity is stable
 * across UI/API callers and collector matching stays consistent.
 */
export function addVendor(
  name: string,
  senderPattern: string,
  userId: number,
  subjectPatterns?: string,
  tenantId = userId,
  senderPatterns?: string[],
): InvoiceVendor {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const normalizedSenderPatterns = normalizeSenderPatternList([
    senderPattern,
    ...(senderPatterns ?? []),
  ]);
  const normalizedSenderPattern = normalizedSenderPatterns[0] ?? normalizeSenderPattern(senderPattern);
  const normalizedSubjectPatterns = normalizeSubjectPatterns(subjectPatterns);
  // Re-enable if the sender_pattern was previously disabled (per-user)
  const existingId = findExistingVendorIdForSenderPatterns(normalizedSenderPatterns, userId, resolvedTenantId);

  const write = db.transaction(() => {
    if (existingId) {
      db.prepare(`
        UPDATE invoice_vendors
        SET name = ?, sender_pattern = ?, subject_patterns = ?, enabled = 1
        WHERE id = ? AND tenant_id = ? AND user_id = ?
      `).run(name, normalizedSenderPattern, normalizedSubjectPatterns, existingId, resolvedTenantId, userId);
      replaceVendorSenderPatterns(existingId, userId, resolvedTenantId, normalizedSenderPatterns);
      return existingId;
    }

    const result = db.prepare(`
      INSERT INTO invoice_vendors (name, sender_pattern, subject_patterns, tenant_id, user_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, normalizedSenderPattern, normalizedSubjectPatterns, resolvedTenantId, userId);
    const vendorId = Number(result.lastInsertRowid);
    replaceVendorSenderPatterns(vendorId, userId, resolvedTenantId, normalizedSenderPatterns);
    return vendorId;
  });

  const vendorId = write();
  const row = db.prepare('SELECT * FROM invoice_vendors WHERE id = ? AND tenant_id = ? AND user_id = ?')
    .get(vendorId, resolvedTenantId, userId) as InvoiceVendor;
  return withSenderPatterns([row], userId, resolvedTenantId)[0];
}

/** Soft-delete: disable a vendor by ID (keeps history for audit trail). */
export function removeVendor(id: number, userId: number, tenantId = userId): boolean {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE id = ? AND tenant_id = ? AND user_id = ?',
  ).run(id, resolvedTenantId, userId);
  return info.changes > 0;
}

/** Disable a vendor by name (case-insensitive). Returns true if found. */
export function removeVendorByName(name: string, userId: number, tenantId = userId): boolean {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE LOWER(name) = LOWER(?) AND tenant_id = ? AND user_id = ?',
  ).run(name, resolvedTenantId, userId);
  return info.changes > 0;
}

/** Get all enabled custom vendors (merged with builtins at runtime). */
export function getActiveVendors(userId: number, tenantId = userId): InvoiceVendor[] {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM invoice_vendors WHERE enabled = 1 AND tenant_id = ? AND user_id = ? ORDER BY name ASC',
  ).all(resolvedTenantId, userId) as InvoiceVendor[];
  return withSenderPatterns(rows, userId, resolvedTenantId);
}

/** Check if a sender pattern is already registered. */
export function vendorExists(senderPattern: string, userId: number, tenantId = userId): boolean {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const normalized = normalizeSenderPattern(senderPattern);
  if (hasVendorSenderTable()) {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM invoice_vendor_senders WHERE sender_pattern = ? AND enabled = 1 AND tenant_id = ? AND user_id = ?',
    ).get(normalized, resolvedTenantId, userId) as { count: number };
    return row.count > 0;
  }
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM invoice_vendors WHERE sender_pattern = ? AND enabled = 1 AND tenant_id = ? AND user_id = ?',
  ).get(normalized, resolvedTenantId, userId) as { count: number };
  return row.count > 0;
}

/** Get all vendors including disabled ones (for admin listing). */
export function getAllVendors(userId: number, tenantId = userId): InvoiceVendor[] {
  assertPositiveUserId(userId);
  const resolvedTenantId = effectiveTenantId(userId, tenantId);
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM invoice_vendors WHERE tenant_id = ? AND user_id = ? ORDER BY enabled DESC, name ASC',
  ).all(resolvedTenantId, userId) as InvoiceVendor[];
  return withSenderPatterns(rows, userId, resolvedTenantId);
}
