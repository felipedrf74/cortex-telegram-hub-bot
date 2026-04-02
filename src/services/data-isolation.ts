// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-User Data Isolation Service
 *
 * Provides:
 * 1. Owner-scoped queries — all sensitive data reads are filtered by owner_id
 * 2. Encrypted writes — sensitive fields are encrypted before storage
 * 3. Data export — GDPR-style export of all owner data as decrypted JSON
 * 4. Data purge — complete removal of all owner data
 *
 * Sensitive tables: invoice_filings, api_usage, email_log, webhook_events
 * Encrypted fields: invoice amount, invoice_number, vendor (in invoice_filings)
 */

import { getDb } from './database';
import { encryptField, decryptField, isEncryptionEnabled } from './encryption';
import { logger } from '../utils/logger';

// ─── Constants ─────────────────────────────────────────────────────

/** Default owner ID for the single-user deployment (Felipe's Telegram ID). */
export const DEFAULT_OWNER_ID = 'default';

/** Tables that contain sensitive/financial data requiring isolation. */
export const SENSITIVE_TABLES = [
  'invoice_filings',
  'api_usage',
  'email_log',
  'webhook_events',
  'invoice_queue',
  'skill_credentials',
] as const;

/** Fields in invoice_filings that are encrypted at rest. */
export const ENCRYPTED_FIELDS = {
  invoice_filings: ['amount', 'invoice_number', 'vendor'],
} as const;

// ─── Owner-Scoped Queries ──────────────────────────────────────────

/**
 * Get all invoice filings for an owner, with encrypted fields decrypted.
 */
export function getOwnerInvoiceFilings(
  ownerId: string = DEFAULT_OWNER_ID,
  opts?: { limit?: number; offset?: number },
): Record<string, unknown>[] {
  const db = getDb();
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  const rows = db.prepare(`
    SELECT * FROM invoice_filings
    WHERE owner_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(ownerId, limit, offset) as Record<string, unknown>[];

  return rows.map((row) => decryptInvoiceRow(row, ownerId));
}

/**
 * Get API usage records for an owner.
 */
export function getOwnerApiUsage(
  ownerId: string = DEFAULT_OWNER_ID,
  opts?: { limit?: number },
): Record<string, unknown>[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM api_usage
    WHERE owner_id = ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(ownerId, opts?.limit ?? 100) as Record<string, unknown>[];
}

// ─── Encrypted Write Helpers ───────────────────────────────────────

/**
 * Encrypt sensitive fields in an invoice filing record before storage.
 * Returns a new object with encrypted values — does not mutate input.
 */
export function encryptInvoiceData(
  data: Record<string, unknown>,
  ownerId: string = DEFAULT_OWNER_ID,
): Record<string, unknown> {
  if (!isEncryptionEnabled()) return { ...data };

  const encrypted = { ...data };
  for (const field of ENCRYPTED_FIELDS.invoice_filings) {
    const value = encrypted[field];
    if (typeof value === 'string' && value) {
      encrypted[field] = encryptField(value, ownerId);
    }
  }
  return encrypted;
}

/**
 * Decrypt sensitive fields in an invoice filing row after retrieval.
 */
export function decryptInvoiceRow(
  row: Record<string, unknown>,
  ownerId: string = DEFAULT_OWNER_ID,
): Record<string, unknown> {
  if (!isEncryptionEnabled()) return row;

  const decrypted = { ...row };
  for (const field of ENCRYPTED_FIELDS.invoice_filings) {
    const value = decrypted[field];
    if (typeof value === 'string' && value) {
      decrypted[field] = decryptField(value, ownerId);
    }
  }
  return decrypted;
}

// ─── Data Export (GDPR Portability) ────────────────────────────────

export interface DataExport {
  exportedAt: string;
  ownerId: string;
  encryptionEnabled: boolean;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * Export all data owned by a specific user as decrypted JSON.
 * Covers all sensitive tables. Suitable for GDPR data portability requests.
 */
export function exportOwnerData(ownerId: string = DEFAULT_OWNER_ID): DataExport {
  const db = getDb();
  const tables: Record<string, Record<string, unknown>[]> = {};

  // Invoice filings (decrypted)
  const invoices = db.prepare(
    'SELECT * FROM invoice_filings WHERE owner_id = ? ORDER BY created_at',
  ).all(ownerId) as Record<string, unknown>[];
  tables.invoice_filings = invoices.map((r) => decryptInvoiceRow(r, ownerId));

  // API usage
  tables.api_usage = db.prepare(
    'SELECT * FROM api_usage WHERE owner_id = ? ORDER BY ts',
  ).all(ownerId) as Record<string, unknown>[];

  // Email log
  tables.email_log = db.prepare(
    'SELECT * FROM email_log WHERE owner_id = ? ORDER BY ts',
  ).all(ownerId) as Record<string, unknown>[];

  // Webhook events
  tables.webhook_events = db.prepare(
    'SELECT * FROM webhook_events WHERE owner_id = ? ORDER BY received_at',
  ).all(ownerId) as Record<string, unknown>[];

  // Invoice queue
  tables.invoice_queue = db.prepare(
    'SELECT * FROM invoice_queue WHERE owner_id = ? ORDER BY created_at',
  ).all(ownerId) as Record<string, unknown>[];

  logger.info(
    {
      ownerId,
      tableCounts: Object.fromEntries(
        Object.entries(tables).map(([k, v]) => [k, v.length]),
      ),
    },
    'Data export completed',
  );

  return {
    exportedAt: new Date().toISOString(),
    ownerId,
    encryptionEnabled: isEncryptionEnabled(),
    tables,
  };
}

// ─── Data Purge ────────────────────────────────────────────────────

export interface PurgeResult {
  purgedAt: string;
  ownerId: string;
  deletedCounts: Record<string, number>;
}

/**
 * Permanently delete all data owned by a specific user.
 * Runs inside a transaction for atomicity.
 * WARNING: This is irreversible. Export data first.
 */
export function purgeOwnerData(ownerId: string): PurgeResult {
  if (ownerId === DEFAULT_OWNER_ID) {
    throw new Error('Cannot purge default owner — use a specific owner ID');
  }

  const db = getDb();
  const deletedCounts: Record<string, number> = {};

  const purge = db.transaction(() => {
    for (const table of SENSITIVE_TABLES) {
      // skill_credentials doesn't have owner_id — skip
      if (table === 'skill_credentials') continue;

      const result = db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).run(ownerId);
      deletedCounts[table] = result.changes;
    }
  });

  purge();

  logger.info({ ownerId, deletedCounts }, 'Owner data purged');

  return {
    purgedAt: new Date().toISOString(),
    ownerId,
    deletedCounts,
  };
}
