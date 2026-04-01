// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { InvoiceVendor } from '../domains/types';

/**
 * Add a new custom vendor for monthly invoice collection.
 * Uses INSERT OR REPLACE so re-adding the same sender_pattern updates the existing row.
 */
export function addVendor(
  name: string,
  senderPattern: string,
  subjectPatterns?: string,
): InvoiceVendor {
  const db = getDb();
  // Re-enable if the sender_pattern was previously disabled
  const existing = db.prepare(
    'SELECT id FROM invoice_vendors WHERE sender_pattern = ?',
  ).get(senderPattern) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE invoice_vendors
      SET name = ?, subject_patterns = ?, enabled = 1
      WHERE id = ?
    `).run(name, subjectPatterns ?? null, existing.id);
    return db.prepare('SELECT * FROM invoice_vendors WHERE id = ?')
      .get(existing.id) as InvoiceVendor;
  }

  const result = db.prepare(`
    INSERT INTO invoice_vendors (name, sender_pattern, subject_patterns)
    VALUES (?, ?, ?)
  `).run(name, senderPattern, subjectPatterns ?? null);

  return db.prepare('SELECT * FROM invoice_vendors WHERE id = ?')
    .get(result.lastInsertRowid) as InvoiceVendor;
}

/** Soft-delete: disable a vendor by ID (keeps history for audit trail). */
export function removeVendor(id: number): boolean {
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE id = ?',
  ).run(id);
  return info.changes > 0;
}

/** Disable a vendor by name (case-insensitive). Returns true if found. */
export function removeVendorByName(name: string): boolean {
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE LOWER(name) = LOWER(?)',
  ).run(name);
  return info.changes > 0;
}

/** Get all enabled custom vendors (merged with builtins at runtime). */
export function getActiveVendors(): InvoiceVendor[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM invoice_vendors WHERE enabled = 1 ORDER BY name ASC',
  ).all() as InvoiceVendor[];
}

/** Check if a sender pattern is already registered. */
export function vendorExists(senderPattern: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM invoice_vendors WHERE sender_pattern = ? AND enabled = 1',
  ).get(senderPattern) as { count: number };
  return row.count > 0;
}

/** Get all vendors including disabled ones (for admin listing). */
export function getAllVendors(): InvoiceVendor[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM invoice_vendors ORDER BY enabled DESC, name ASC',
  ).all() as InvoiceVendor[];
}
