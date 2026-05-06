// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { InvoiceVendor } from '../domains/types';

function normalizeSenderPattern(senderPattern: string): string {
  return senderPattern.trim().toLowerCase();
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
): InvoiceVendor {
  assertPositiveUserId(userId);
  const db = getDb();
  const normalizedSenderPattern = normalizeSenderPattern(senderPattern);
  const normalizedSubjectPatterns = normalizeSubjectPatterns(subjectPatterns);
  // Re-enable if the sender_pattern was previously disabled (per-user)
  const existing = db.prepare(
    'SELECT id FROM invoice_vendors WHERE sender_pattern = ? AND user_id = ?',
  ).get(normalizedSenderPattern, userId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE invoice_vendors
      SET name = ?, subject_patterns = ?, enabled = 1
      WHERE id = ? AND user_id = ?
    `).run(name, normalizedSubjectPatterns, existing.id, userId);
    return db.prepare('SELECT * FROM invoice_vendors WHERE id = ?')
      .get(existing.id) as InvoiceVendor;
  }

  const result = db.prepare(`
    INSERT INTO invoice_vendors (name, sender_pattern, subject_patterns, user_id)
    VALUES (?, ?, ?, ?)
  `).run(name, normalizedSenderPattern, normalizedSubjectPatterns, userId);

  return db.prepare('SELECT * FROM invoice_vendors WHERE id = ?')
    .get(result.lastInsertRowid) as InvoiceVendor;
}

/** Soft-delete: disable a vendor by ID (keeps history for audit trail). */
export function removeVendor(id: number, userId: number): boolean {
  assertPositiveUserId(userId);
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE id = ? AND user_id = ?',
  ).run(id, userId);
  return info.changes > 0;
}

/** Disable a vendor by name (case-insensitive). Returns true if found. */
export function removeVendorByName(name: string, userId: number): boolean {
  assertPositiveUserId(userId);
  const db = getDb();
  const info = db.prepare(
    'UPDATE invoice_vendors SET enabled = 0 WHERE LOWER(name) = LOWER(?) AND user_id = ?',
  ).run(name, userId);
  return info.changes > 0;
}

/** Get all enabled custom vendors (merged with builtins at runtime). */
export function getActiveVendors(userId: number): InvoiceVendor[] {
  assertPositiveUserId(userId);
  const db = getDb();
  return db.prepare(
    'SELECT * FROM invoice_vendors WHERE enabled = 1 AND user_id = ? ORDER BY name ASC',
  ).all(userId) as InvoiceVendor[];
}

/** Check if a sender pattern is already registered. */
export function vendorExists(senderPattern: string, userId: number): boolean {
  assertPositiveUserId(userId);
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM invoice_vendors WHERE sender_pattern = ? AND enabled = 1 AND user_id = ?',
  ).get(normalizeSenderPattern(senderPattern), userId) as { count: number };
  return row.count > 0;
}

/** Get all vendors including disabled ones (for admin listing). */
export function getAllVendors(userId: number): InvoiceVendor[] {
  assertPositiveUserId(userId);
  const db = getDb();
  return db.prepare(
    'SELECT * FROM invoice_vendors WHERE user_id = ? ORDER BY enabled DESC, name ASC',
  ).all(userId) as InvoiceVendor[];
}
