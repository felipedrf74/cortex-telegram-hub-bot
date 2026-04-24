import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  auditInvoiceVendorRows,
  normalizeInvoiceVendorSenderPattern,
  repairInvoiceVendorRows,
} from '../../src/services/invoice-vendor-cleanup';

let db: Database.Database;

function createSchema(): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      email TEXT
    );

    CREATE TABLE invoice_vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sender_pattern TEXT NOT NULL,
      subject_patterns TEXT,
      enabled INTEGER DEFAULT 1,
      user_id INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function insertVendor(
  name: string,
  senderPattern: string,
  userId: number,
  enabled = 1,
): number {
  const result = db.prepare(`
    INSERT INTO invoice_vendors (name, sender_pattern, subject_patterns, enabled, user_id)
    VALUES (?, ?, 'fatura,recibo', ?, ?)
  `).run(name, senderPattern, enabled, userId);
  return Number(result.lastInsertRowid);
}

describe('invoice vendor cleanup', () => {
  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('normalizes sender patterns consistently with invoice-vendor state writes', () => {
    expect(normalizeInvoiceVendorSenderPattern('  ViaVerde.PT  ')).toBe('viaverde.pt');
  });

  it('returns a schema-not-ready report when invoice_vendors is unavailable', () => {
    const report = auditInvoiceVendorRows(db);

    expect(report.schemaReady).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.safeActions).toEqual([]);
  });

  it('reports apply mode honestly even when there is nothing safe to mutate', () => {
    const schemaMissingReport = repairInvoiceVendorRows(db, { apply: true });
    expect(schemaMissingReport.schemaReady).toBe(false);
    expect(schemaMissingReport.dryRun).toBe(false);

    createSchema();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(11, 'owner@example.com');
    insertVendor('Via Verde', 'viaverde.pt', 11);

    const report = repairInvoiceVendorRows(db, { apply: true });

    expect(report.schemaReady).toBe(true);
    expect(report.safeActions).toEqual([]);
    expect(report.appliedActions).toEqual([]);
    expect(report.dryRun).toBe(false);
  });

  it('audits ownerless, orphaned, and noncanonical legacy vendor rows without mutating by default', () => {
    createSchema();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(11, 'owner@example.com');
    const ownerlessId = insertVendor('Santander Consumer', 'santanderconsumer.pt', 0);
    const orphanedId = insertVendor('Old Tenant Vendor', 'old-vendor.pt', 999);
    const noncanonicalId = insertVendor('Via Verde', '  ViaVerde.PT  ', 11);

    const report = auditInvoiceVendorRows(db);

    expect(report.dryRun).toBe(true);
    expect(report.totalRows).toBe(3);
    expect(report.findings).toEqual([
      expect.objectContaining({
        type: 'ownerless_vendor',
        vendorId: ownerlessId,
        safeAction: 'disable_vendor',
      }),
      expect.objectContaining({
        type: 'orphaned_user',
        vendorId: orphanedId,
        safeAction: 'disable_vendor',
      }),
      expect.objectContaining({
        type: 'noncanonical_sender_pattern',
        vendorId: noncanonicalId,
        safeAction: 'normalize_sender_pattern',
        normalizedSenderPattern: 'viaverde.pt',
      }),
    ]);
    expect(report.safeActions).toEqual([
      expect.objectContaining({ type: 'disable_vendor', vendorId: ownerlessId }),
      expect.objectContaining({ type: 'disable_vendor', vendorId: orphanedId }),
      expect.objectContaining({
        type: 'normalize_sender_pattern',
        vendorId: noncanonicalId,
        from: '  ViaVerde.PT  ',
        to: 'viaverde.pt',
      }),
    ]);

    const rows = db.prepare('SELECT id, enabled, sender_pattern FROM invoice_vendors ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { id: ownerlessId, enabled: 1, sender_pattern: 'santanderconsumer.pt' },
      { id: orphanedId, enabled: 1, sender_pattern: 'old-vendor.pt' },
      { id: noncanonicalId, enabled: 1, sender_pattern: '  ViaVerde.PT  ' },
    ]);
  });

  it('applies only safe cleanup actions when explicitly requested', () => {
    createSchema();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(11, 'owner@example.com');
    const ownerlessId = insertVendor('Santander Consumer', 'santanderconsumer.pt', 0);
    const orphanedId = insertVendor('Old Tenant Vendor', 'old-vendor.pt', 999);
    const noncanonicalId = insertVendor('Via Verde', 'ViaVerde.PT', 11);

    const report = repairInvoiceVendorRows(db, { apply: true });

    expect(report.dryRun).toBe(false);
    expect(report.appliedActions).toEqual([
      expect.objectContaining({ type: 'disable_vendor', vendorId: ownerlessId }),
      expect.objectContaining({ type: 'disable_vendor', vendorId: orphanedId }),
      expect.objectContaining({ type: 'normalize_sender_pattern', vendorId: noncanonicalId }),
    ]);

    const rows = db.prepare('SELECT id, enabled, sender_pattern FROM invoice_vendors ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { id: ownerlessId, enabled: 0, sender_pattern: 'santanderconsumer.pt' },
      { id: orphanedId, enabled: 0, sender_pattern: 'old-vendor.pt' },
      { id: noncanonicalId, enabled: 1, sender_pattern: 'viaverde.pt' },
    ]);
  });

  it('does not auto-normalize sender patterns that would collide for the same user', () => {
    createSchema();
    db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run(11, 'owner@example.com');
    const canonicalId = insertVendor('Via Verde Canonical', 'viaverde.pt', 11);
    const collidingId = insertVendor('Via Verde Legacy', 'ViaVerde.PT', 11);

    const audit = auditInvoiceVendorRows(db);

    expect(audit.findings).toEqual([
      expect.objectContaining({
        type: 'normalization_collision',
        vendorId: collidingId,
      }),
    ]);
    expect(audit.safeActions).toEqual([]);

    const repair = repairInvoiceVendorRows(db, { apply: true });
    expect(repair.appliedActions).toEqual([]);

    const rows = db.prepare('SELECT id, sender_pattern FROM invoice_vendors ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { id: canonicalId, sender_pattern: 'viaverde.pt' },
      { id: collidingId, sender_pattern: 'ViaVerde.PT' },
    ]);
  });
});
