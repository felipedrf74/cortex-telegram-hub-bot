/**
 * QA Validation Tests — Per-User Data Isolation + AES-256-GCM Encryption
 *
 * Validates:
 * - Encryption round-trip integrity (encrypt → decrypt = original)
 * - Per-user key isolation (user A cannot decrypt user B's data)
 * - Dual-write pattern (encrypted + plaintext columns both populated)
 * - Graceful fallback when encryption is disabled
 * - GDPR export returns decrypted data
 * - GDPR erasure removes all user data without affecting others
 * - GCM tamper detection
 * - Migration adds required encrypted columns
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql') && !f.includes(' 2')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

// ── Test DB & Mocks ─────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const TEST_MASTER_KEY = 'qa-validation-master-key-32chars!!';

vi.mock('../../src/config', () => ({
  config: {
    financeEncryption: {
      enabled: true,
      masterKey: 'qa-validation-master-key-32chars!!',
    },
  },
}));

import {
  addTransaction,
  getTransactions,
  calculateAndStoreTax,
  getTaxEvents,
  deleteTransaction,
  markTaxPaid,
} from '../../src/services/finance-tracker';
import {
  exportUserFinanceData,
  deleteUserFinanceData,
  countUserFinanceData,
} from '../../src/services/user-data-export';
import {
  deriveUserKey,
  encryptValue,
  decryptValue,
  encryptNumber,
  decryptNumber,
} from '../../src/utils/encryption';

// ── Migration Validation ─────────────────────────────────────────

describe('QA: Migration 025 — finance encryption columns', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('finance_transactions has encrypted_amount and encrypted_description columns', () => {
    const cols = testDb.prepare("PRAGMA table_info(finance_transactions)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('encrypted_amount');
    expect(colNames).toContain('encrypted_description');
  });

  it('finance_tax_events has all encrypted columns', () => {
    const cols = testDb.prepare("PRAGMA table_info(finance_tax_events)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('encrypted_gross_income');
    expect(colNames).toContain('encrypted_deductions');
    expect(colNames).toContain('encrypted_taxable_income');
    expect(colNames).toContain('encrypted_tax_due');
    expect(colNames).toContain('encrypted_inss_due');
    expect(colNames).toContain('encrypted_notes');
  });

  it('user_encryption_meta table exists with expected schema', () => {
    const cols = testDb.prepare("PRAGMA table_info(user_encryption_meta)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('key_version');
    expect(colNames).toContain('encrypted_at');
    expect(colNames).toContain('updated_at');
  });
});

// ── Encryption Core Validation ────────────────────────────────────

describe('QA: Encryption — per-user key isolation', () => {
  const MASTER = 'qa-test-master-key-for-validation!';

  it('different users derive different 32-byte keys', () => {
    const userIds = [100, 200, 300, 400, 500];
    const keys = userIds.map(id => deriveUserKey(MASTER, id));
    // All keys should be unique
    const hexKeys = keys.map(k => k.toString('hex'));
    const uniqueKeys = new Set(hexKeys);
    expect(uniqueKeys.size).toBe(userIds.length);
    // All 32 bytes
    keys.forEach(k => expect(k.length).toBe(32));
  });

  it('user A cannot decrypt user B data', () => {
    const userA = 1001;
    const userB = 1002;
    const secret = 'R$ 50.000,00 — salary';

    const encrypted = encryptValue(secret, MASTER, userA);
    // User A can decrypt
    expect(decryptValue(encrypted, MASTER, userA)).toBe(secret);
    // User B cannot
    expect(() => decryptValue(encrypted, MASTER, userB)).toThrow();
  });

  it('different master keys cannot decrypt each other', () => {
    const masterA = 'master-key-aaa-for-testing-12345';
    const masterB = 'master-key-bbb-for-testing-12345';
    const userId = 1;

    const encrypted = encryptValue('confidential', masterA, userId);
    expect(() => decryptValue(encrypted, masterB, userId)).toThrow();
  });

  it('GCM detects bit-flip tampering in ciphertext', () => {
    const encrypted = encryptValue('financial data', MASTER, 1);
    const buf = Buffer.from(encrypted, 'hex');
    // Flip last byte
    buf[buf.length - 1] ^= 0x01;
    expect(() => decryptValue(buf.toString('hex'), MASTER, 1)).toThrow();
  });

  it('GCM detects tampering in auth tag region', () => {
    const encrypted = encryptValue('secret amount', MASTER, 1);
    const buf = Buffer.from(encrypted, 'hex');
    // Flip byte in auth tag (bytes 12-27)
    buf[15] ^= 0xff;
    expect(() => decryptValue(buf.toString('hex'), MASTER, 1)).toThrow();
  });

  it('encrypts numbers with currency precision', () => {
    const amounts = [0.01, 1.99, 999.99, 12345.67, 100000.00];
    for (const amt of amounts) {
      const enc = encryptNumber(amt, MASTER, 1);
      expect(decryptNumber(enc, MASTER, 1)).toBe(amt);
    }
  });

  it('each encryption produces unique ciphertext (random IV)', () => {
    const results = new Set<string>();
    for (let i = 0; i < 10; i++) {
      results.add(encryptValue('same-plaintext', MASTER, 1));
    }
    expect(results.size).toBe(10);
  });
});

// ── Dual-Write Pattern Validation ─────────────────────────────────

describe('QA: Dual-write pattern — encrypted + plaintext', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('addTransaction writes both plaintext and encrypted columns', () => {
    addTransaction(1, '2024-07-01', 'income', 5000, { description: 'Consulting fee' });

    const row = testDb.prepare('SELECT * FROM finance_transactions WHERE user_id = 1').get() as any;
    // Plaintext columns still populated (backward compat)
    expect(row.amount).toBe(5000);
    expect(row.description).toBe('Consulting fee');
    // Encrypted columns populated
    expect(row.encrypted_amount).toBeTruthy();
    expect(row.encrypted_description).toBeTruthy();
    // Encrypted values are hex strings, not plaintext
    expect(row.encrypted_amount).not.toBe('5000');
    expect(row.encrypted_description).not.toBe('Consulting fee');
  });

  it('calculateAndStoreTax writes encrypted tax fields', () => {
    addTransaction(1, '2024-07-01', 'income', 8000);
    calculateAndStoreTax(1, '2024-07');

    const row = testDb.prepare('SELECT * FROM finance_tax_events WHERE user_id = 1').get() as any;
    expect(row.encrypted_gross_income).toBeTruthy();
    expect(row.encrypted_deductions).toBeTruthy();
    expect(row.encrypted_taxable_income).toBeTruthy();
    expect(row.encrypted_tax_due).toBeTruthy();
    expect(row.encrypted_inss_due).toBeTruthy();
  });

  it('getTransactions returns decrypted values transparently', () => {
    addTransaction(1, '2024-07-01', 'income', 7777.88, { description: 'Test payment' });
    const txs = getTransactions(1);
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(7777.88);
    expect(txs[0].description).toBe('Test payment');
  });

  it('getTaxEvents returns decrypted tax values', () => {
    addTransaction(1, '2024-07-01', 'income', 10000);
    calculateAndStoreTax(1, '2024-07');
    const events = getTaxEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0].gross_income).toBe(10000);
    expect(typeof events[0].tax_due).toBe('number');
    expect(events[0].tax_due).toBeGreaterThanOrEqual(0);
  });
});

// ── Per-User Data Isolation (multi-user) ──────────────────────────

describe('QA: Per-user data isolation — multi-user scenario', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('user A transactions are invisible to user B queries', () => {
    addTransaction(100, '2024-07-01', 'income', 20000, { description: 'User 100 salary' });
    addTransaction(200, '2024-07-01', 'income', 15000, { description: 'User 200 salary' });
    addTransaction(300, '2024-07-01', 'expense', 500, { description: 'User 300 expense' });

    const txA = getTransactions(100);
    const txB = getTransactions(200);
    const txC = getTransactions(300);

    expect(txA).toHaveLength(1);
    expect(txB).toHaveLength(1);
    expect(txC).toHaveLength(1);
    expect(txA[0].amount).toBe(20000);
    expect(txB[0].amount).toBe(15000);
    expect(txC[0].amount).toBe(500);
  });

  it('deleting user A data leaves user B intact', () => {
    addTransaction(100, '2024-07-01', 'income', 10000);
    addTransaction(200, '2024-07-01', 'income', 20000);
    calculateAndStoreTax(100, '2024-07');
    calculateAndStoreTax(200, '2024-07');

    deleteUserFinanceData(100);

    expect(countUserFinanceData(100).transactions).toBe(0);
    expect(countUserFinanceData(100).taxEvents).toBe(0);
    expect(countUserFinanceData(200).transactions).toBe(1);
    expect(countUserFinanceData(200).taxEvents).toBe(1);
  });

  it('deleteTransaction enforces user_id ownership', () => {
    addTransaction(100, '2024-07-01', 'income', 5000);
    const txs = getTransactions(100);
    const txId = txs[0].id;

    // User 200 cannot delete user 100's transaction
    const deleted = deleteTransaction(200, txId);
    expect(deleted).toBe(false);

    // User 100 can delete their own
    const deletedOwn = deleteTransaction(100, txId);
    expect(deletedOwn).toBe(true);
  });

  it('encrypted columns from different users are cryptographically different', () => {
    addTransaction(100, '2024-07-01', 'income', 5000, { description: 'Same description' });
    addTransaction(200, '2024-07-01', 'income', 5000, { description: 'Same description' });

    const rows = testDb.prepare('SELECT * FROM finance_transactions ORDER BY user_id').all() as any[];
    // Same plaintext but different encrypted values (different keys + random IVs)
    expect(rows[0].encrypted_amount).not.toBe(rows[1].encrypted_amount);
    expect(rows[0].encrypted_description).not.toBe(rows[1].encrypted_description);
  });

  it('tax events are isolated per user', () => {
    addTransaction(100, '2024-06-01', 'income', 3000);
    addTransaction(200, '2024-06-01', 'income', 50000);
    calculateAndStoreTax(100, '2024-06');
    calculateAndStoreTax(200, '2024-06');

    const tax100 = getTaxEvents(100);
    const tax200 = getTaxEvents(200);

    expect(tax100).toHaveLength(1);
    expect(tax200).toHaveLength(1);
    expect(tax100[0].gross_income).toBe(3000);
    expect(tax200[0].gross_income).toBe(50000);
  });
});

// ── GDPR Data Portability & Erasure ──────────────────────────────

describe('QA: GDPR — data export and erasure', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('exportUserFinanceData returns complete decrypted dataset', () => {
    addTransaction(1, '2024-06-01', 'income', 12000, { description: 'Freelance' });
    addTransaction(1, '2024-06-15', 'expense', 500, { description: 'Office supplies' });
    addTransaction(1, '2024-07-01', 'income', 13000);
    calculateAndStoreTax(1, '2024-06');
    calculateAndStoreTax(1, '2024-07');

    const exported = exportUserFinanceData(1);

    expect(exported.userId).toBe(1);
    expect(exported.exportedAt).toBeTruthy();
    expect(exported.transactions).toHaveLength(3);
    expect(exported.taxEvents).toHaveLength(2);
    // Values are decrypted
    expect(exported.transactions.find(t => t.description === 'Freelance')).toBeTruthy();
    expect(exported.transactions.find(t => t.amount === 12000)).toBeTruthy();
    // Annual summaries cover both years
    expect(exported.annualSummaries).toHaveLength(1); // Both months in 2024
    expect(exported.annualSummaries[0].year).toBe(2024);
  });

  it('deleteUserFinanceData removes all records and returns counts', () => {
    addTransaction(1, '2024-06-01', 'income', 8000);
    addTransaction(1, '2024-06-10', 'expense', 200);
    addTransaction(1, '2024-07-01', 'income', 9000);
    calculateAndStoreTax(1, '2024-06');

    const result = deleteUserFinanceData(1);
    expect(result.transactionsDeleted).toBe(3);
    expect(result.taxEventsDeleted).toBeGreaterThanOrEqual(1);

    // Verify zero records remain
    const counts = countUserFinanceData(1);
    expect(counts.transactions).toBe(0);
    expect(counts.taxEvents).toBe(0);
  });

  it('export for non-existent user returns empty arrays', () => {
    const exported = exportUserFinanceData(99999);
    expect(exported.transactions).toHaveLength(0);
    expect(exported.taxEvents).toHaveLength(0);
    expect(exported.annualSummaries).toHaveLength(0);
  });

  it('erasure for non-existent user returns zero counts safely', () => {
    const result = deleteUserFinanceData(99999);
    expect(result.transactionsDeleted).toBe(0);
    expect(result.taxEventsDeleted).toBe(0);
  });

  it('export does not include other users data', () => {
    addTransaction(1, '2024-06-01', 'income', 10000);
    addTransaction(2, '2024-06-01', 'income', 99999);

    const export1 = exportUserFinanceData(1);
    expect(export1.transactions).toHaveLength(1);
    expect(export1.transactions[0].amount).toBe(10000);
    // No trace of user 2's data
    expect(export1.transactions.every(t => t.user_id === 1)).toBe(true);
  });
});

// ── Source Code Architecture Validation ───────────────────────────

describe('QA: Architecture — encryption module structure', () => {
  it('encryption.ts uses AES-256-GCM with 12-byte IV', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/utils/encryption.ts'), 'utf-8',
    );
    expect(source).toContain("'aes-256-gcm'");
    expect(source).toContain('IV_LENGTH = 12');
    expect(source).toContain('TAG_LENGTH = 16');
    expect(source).toContain('KEY_LENGTH = 32');
  });

  it('HKDF uses sha256 with domain-specific salt', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/utils/encryption.ts'), 'utf-8',
    );
    expect(source).toContain("crypto.hkdfSync('sha256'");
    expect(source).toContain('nexushub-finance-v1');
  });

  it('finance-tracker uses tryEncrypt helpers for dual-write', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/finance-tracker.ts'), 'utf-8',
    );
    expect(source).toContain('tryEncryptNum');
    expect(source).toContain('tryEncryptStr');
    expect(source).toContain('readEncryptedNum');
    expect(source).toContain('readEncryptedStr');
  });

  it('finance-tracker gracefully falls back when encryption key is absent', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/finance-tracker.ts'), 'utf-8',
    );
    // getEncryptionKey returns null when disabled
    expect(source).toContain('if (!enabled || !masterKey) return null');
    // readEncrypted* falls back to plaintext
    expect(source).toContain('if (!encrypted) return plaintext');
  });

  it('user-data-export enforces user_id filtering on all queries', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/services/user-data-export.ts'), 'utf-8',
    );
    // All SQL queries include WHERE user_id = ?
    expect(source).toContain('WHERE user_id = ?');
    // Delete operations enforce user_id
    expect(source).toContain("DELETE FROM finance_transactions WHERE user_id = ?");
    expect(source).toContain("DELETE FROM finance_tax_events WHERE user_id = ?");
  });

  it('config includes financeEncryption settings', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/config.ts'), 'utf-8',
    );
    expect(source).toContain('financeEncryption');
    expect(source).toContain('FINANCE_ENCRYPTION_ENABLED');
    expect(source).toContain('FINANCE_ENCRYPTION_KEY');
  });

  it('migration 025 adds encrypted columns without dropping plaintext', () => {
    const migration = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/025_finance_encryption.sql'), 'utf-8',
    );
    // Adds encrypted columns
    expect(migration).toContain('ALTER TABLE finance_transactions ADD COLUMN encrypted_amount');
    expect(migration).toContain('ALTER TABLE finance_transactions ADD COLUMN encrypted_description');
    expect(migration).toContain('ALTER TABLE finance_tax_events ADD COLUMN encrypted_gross_income');
    // Does NOT drop plaintext columns (dual-write pattern)
    expect(migration).not.toContain('DROP COLUMN');
    // Creates metadata table
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS user_encryption_meta');
  });
});
