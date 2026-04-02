import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';

// Mock logger before importing modules
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock config
vi.mock('../../src/config', () => ({
  config: {
    app: { databasePath: ':memory:' },
  },
}));

// We need a real in-memory DB for these tests
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  initEncryption,
  clearEncryption,
} from '../../src/services/encryption';

import {
  DEFAULT_OWNER_ID,
  getOwnerInvoiceFilings,
  getOwnerApiUsage,
  encryptInvoiceData,
  decryptInvoiceRow,
  exportOwnerData,
  purgeOwnerData,
} from '../../src/services/data-isolation';

const TEST_KEY = crypto.randomBytes(32).toString('hex');

function setupSchema(): void {
  testDb.exec(`
    CREATE TABLE invoice_filings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor TEXT NOT NULL,
      amount TEXT,
      document_date TEXT,
      invoice_number TEXT,
      source TEXT NOT NULL,
      source_ref TEXT,
      remote_path TEXT,
      folder_path TEXT,
      filename TEXT,
      file_size_bytes INTEGER,
      compressed_size_bytes INTEGER,
      status TEXT DEFAULT 'filed',
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      owner_id TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      category TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE email_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      error_message TEXT,
      source TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      owner_id TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      headers TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      error_message TEXT,
      idempotency_key TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT,
      owner_id TEXT NOT NULL DEFAULT 'default'
    );

    CREATE TABLE invoice_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'image',
      local_path TEXT NOT NULL,
      media_type TEXT,
      analysis_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'photo',
      status TEXT NOT NULL DEFAULT 'pending',
      retries INTEGER NOT NULL DEFAULT 0,
      last_retry_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      filed_at TEXT,
      owner_id TEXT NOT NULL DEFAULT 'default'
    );
  `);
}

function seedData(): void {
  // Invoice filings for different owners
  testDb.prepare(`
    INSERT INTO invoice_filings (vendor, amount, invoice_number, source, owner_id)
    VALUES (?, ?, ?, ?, ?)
  `).run('Amazon.es', '€45.99', 'AMZ-001', 'amazon', 'default');

  testDb.prepare(`
    INSERT INTO invoice_filings (vendor, amount, invoice_number, source, owner_id)
    VALUES (?, ?, ?, ?, ?)
  `).run('Uber', '€12.50', 'UBR-001', 'uber', 'user-2');

  // API usage
  testDb.prepare(`
    INSERT INTO api_usage (category, model, input_tokens, output_tokens, cost_usd, duration_ms, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('classify', 'claude-haiku', 100, 50, 0.001, 200, 'default');

  testDb.prepare(`
    INSERT INTO api_usage (category, model, input_tokens, output_tokens, cost_usd, duration_ms, owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('chat', 'claude-sonnet', 500, 200, 0.01, 1000, 'user-2');

  // Email log
  testDb.prepare(`
    INSERT INTO email_log (recipient, subject, source, owner_id)
    VALUES (?, ?, ?, ?)
  `).run('test@example.com', 'Invoice filed', 'fossa_email', 'default');

  // Webhook events
  testDb.prepare(`
    INSERT INTO webhook_events (provider, event_type, payload, owner_id)
    VALUES (?, ?, ?, ?)
  `).run('google_calendar', 'event.created', '{"test":true}', 'default');

  // Invoice queue
  testDb.prepare(`
    INSERT INTO invoice_queue (local_path, analysis_json, owner_id)
    VALUES (?, ?, ?)
  `).run('/tmp/invoice.pdf', '{"vendor":"Test"}', 'default');
}

describe('data-isolation service', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    testDb.pragma('foreign_keys = ON');
    setupSchema();
    seedData();
  });

  afterEach(() => {
    clearEncryption();
    testDb.close();
  });

  describe('owner-scoped queries', () => {
    it('getOwnerInvoiceFilings returns only owner data', () => {
      const defaultFilings = getOwnerInvoiceFilings('default');
      expect(defaultFilings).toHaveLength(1);
      expect(defaultFilings[0].vendor).toBe('Amazon.es');

      const user2Filings = getOwnerInvoiceFilings('user-2');
      expect(user2Filings).toHaveLength(1);
      expect(user2Filings[0].vendor).toBe('Uber');
    });

    it('getOwnerInvoiceFilings respects limit and offset', () => {
      // Add more rows for default owner
      for (let i = 0; i < 5; i++) {
        testDb.prepare(`
          INSERT INTO invoice_filings (vendor, amount, source, owner_id)
          VALUES (?, ?, ?, ?)
        `).run(`Vendor-${i}`, `€${i}`, 'email', 'default');
      }

      const page1 = getOwnerInvoiceFilings('default', { limit: 3, offset: 0 });
      expect(page1).toHaveLength(3);

      const page2 = getOwnerInvoiceFilings('default', { limit: 3, offset: 3 });
      expect(page2).toHaveLength(3);
    });

    it('getOwnerApiUsage returns only owner data', () => {
      const usage = getOwnerApiUsage('default');
      expect(usage).toHaveLength(1);
      expect(usage[0].category).toBe('classify');

      const user2Usage = getOwnerApiUsage('user-2');
      expect(user2Usage).toHaveLength(1);
      expect(user2Usage[0].category).toBe('chat');
    });

    it('returns empty array for non-existent owner', () => {
      expect(getOwnerInvoiceFilings('nobody')).toHaveLength(0);
      expect(getOwnerApiUsage('nobody')).toHaveLength(0);
    });
  });

  describe('encryption helpers', () => {
    it('encryptInvoiceData encrypts sensitive fields when enabled', () => {
      initEncryption(TEST_KEY);

      const data = { vendor: 'Amazon.es', amount: '€45.99', invoice_number: 'AMZ-001', source: 'amazon' };
      const encrypted = encryptInvoiceData(data, 'default');

      expect(encrypted.vendor).not.toBe('Amazon.es');
      expect((encrypted.vendor as string).startsWith('v1:')).toBe(true);
      expect(encrypted.amount).not.toBe('€45.99');
      expect(encrypted.invoice_number).not.toBe('AMZ-001');
      // Non-sensitive fields unchanged
      expect(encrypted.source).toBe('amazon');
    });

    it('encryptInvoiceData is no-op when encryption disabled', () => {
      const data = { vendor: 'Amazon.es', amount: '€45.99', source: 'amazon' };
      const result = encryptInvoiceData(data, 'default');

      expect(result.vendor).toBe('Amazon.es');
      expect(result.amount).toBe('€45.99');
    });

    it('decryptInvoiceRow reverses encryptInvoiceData', () => {
      initEncryption(TEST_KEY);

      const original = { vendor: 'MEO', amount: '€29.99', invoice_number: 'MEO-2025-042', source: 'email' };
      const encrypted = encryptInvoiceData(original, 'default');
      const decrypted = decryptInvoiceRow(encrypted, 'default');

      expect(decrypted.vendor).toBe('MEO');
      expect(decrypted.amount).toBe('€29.99');
      expect(decrypted.invoice_number).toBe('MEO-2025-042');
    });

    it('does not mutate the input object', () => {
      initEncryption(TEST_KEY);

      const data = { vendor: 'Test', amount: '€10', invoice_number: null, source: 'photo' };
      const encrypted = encryptInvoiceData(data, 'default');

      expect(data.vendor).toBe('Test'); // original unchanged
      expect(encrypted).not.toBe(data); // different object
    });
  });

  describe('exportOwnerData', () => {
    it('exports all tables for the owner', () => {
      const exported = exportOwnerData('default');

      expect(exported.ownerId).toBe('default');
      expect(exported.exportedAt).toBeTruthy();
      expect(exported.tables.invoice_filings).toHaveLength(1);
      expect(exported.tables.api_usage).toHaveLength(1);
      expect(exported.tables.email_log).toHaveLength(1);
      expect(exported.tables.webhook_events).toHaveLength(1);
      expect(exported.tables.invoice_queue).toHaveLength(1);
    });

    it('only exports data for the specified owner', () => {
      const exported = exportOwnerData('user-2');

      expect(exported.tables.invoice_filings).toHaveLength(1);
      expect(exported.tables.invoice_filings[0].vendor).toBe('Uber');
      expect(exported.tables.api_usage).toHaveLength(1);
      expect(exported.tables.email_log).toHaveLength(0);
      expect(exported.tables.webhook_events).toHaveLength(0);
    });

    it('returns empty tables for unknown owner', () => {
      const exported = exportOwnerData('ghost');

      for (const [, rows] of Object.entries(exported.tables)) {
        expect(rows).toHaveLength(0);
      }
    });

    it('decrypts invoice fields in export when encryption enabled', () => {
      initEncryption(TEST_KEY);

      // Insert an encrypted invoice
      const enc = encryptInvoiceData(
        { vendor: 'Encrypted Co', amount: '€100', invoice_number: 'ENC-001' },
        'default',
      );
      testDb.prepare(`
        INSERT INTO invoice_filings (vendor, amount, invoice_number, source, owner_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(enc.vendor, enc.amount, enc.invoice_number, 'email', 'default');

      const exported = exportOwnerData('default');
      const encRow = exported.tables.invoice_filings.find(
        (r) => r.invoice_number === 'ENC-001',
      );
      expect(encRow).toBeTruthy();
      expect(encRow!.vendor).toBe('Encrypted Co');
      expect(encRow!.amount).toBe('€100');
    });
  });

  describe('purgeOwnerData', () => {
    it('deletes all data for a non-default owner', () => {
      const result = purgeOwnerData('user-2');

      expect(result.ownerId).toBe('user-2');
      expect(result.deletedCounts.invoice_filings).toBe(1);
      expect(result.deletedCounts.api_usage).toBe(1);

      // Verify data is gone
      const rows = testDb.prepare(
        "SELECT COUNT(*) as c FROM invoice_filings WHERE owner_id = 'user-2'",
      ).get() as { c: number };
      expect(rows.c).toBe(0);
    });

    it('does not affect other owners', () => {
      purgeOwnerData('user-2');

      const defaultFilings = testDb.prepare(
        "SELECT COUNT(*) as c FROM invoice_filings WHERE owner_id = 'default'",
      ).get() as { c: number };
      expect(defaultFilings.c).toBe(1);
    });

    it('throws when trying to purge default owner', () => {
      expect(() => purgeOwnerData('default')).toThrow('Cannot purge default owner');
    });

    it('is idempotent — purging twice returns zero counts', () => {
      purgeOwnerData('user-2');
      const second = purgeOwnerData('user-2');

      expect(second.deletedCounts.invoice_filings).toBe(0);
      expect(second.deletedCounts.api_usage).toBe(0);
    });
  });
});
