import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';

// We test the exported functions directly, mocking config and logger
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

// Dynamic config mock — override per test via `mockConfig`
let mockConfig: any = {
  app: { databasePath: '' },
  backup: { dir: '', retentionDays: 30, enabled: true, time: '03:00', encrypt: false, encryptionKey: '' },
  telegram: { allowedUserIds: [123] },
};
vi.mock('../../src/config', () => ({
  get config() { return mockConfig; },
}));

// Mock getDb to return a real in-memory database
let testSourceDb: Database.Database;
vi.mock('../../src/services/database', () => ({
  getDb: () => testSourceDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  runDatabaseBackup,
  rotateBackups,
  verifyBackupIntegrity,
  encryptBackupFile,
  decryptBackupFile,
  weeklyRestoreTest,
} from '../../src/services/backup';

describe('backup service', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexushub-backup-test-'));
    dbPath = path.join(tmpDir, 'bot.db');
    backupDir = path.join(tmpDir, 'backups');

    // Create a real SQLite database for backup API testing
    testSourceDb = new Database(dbPath);
    testSourceDb.pragma('journal_mode = WAL');
    testSourceDb.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, value TEXT)');
    testSourceDb.exec("INSERT INTO test_data VALUES (1, 'hello'), (2, 'world')");

    mockConfig = {
      app: { databasePath: dbPath },
      backup: { dir: backupDir, retentionDays: 30, enabled: true, time: '03:00', encrypt: false, encryptionKey: '' },
      telegram: { allowedUserIds: [123] },
    };
  });

  afterEach(() => {
    try { testSourceDb?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── runDatabaseBackup (SQLite backup API) ─────────────────────────

  describe('runDatabaseBackup', () => {
    it('creates a compressed tar.gz backup using SQLite backup API', async () => {
      const result = await runDatabaseBackup();

      expect(result).toMatch(/nexushub-backup-.*\.sqlite3\.tar\.gz$/);
      expect(fs.existsSync(result)).toBe(true);

      // Verify it's a valid gzip file (magic bytes: 1f 8b)
      const buf = Buffer.alloc(2);
      const fd = fs.openSync(result, 'r');
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it('backup file contains a valid SQLite database', async () => {
      const result = await runDatabaseBackup();

      // Extract and verify the sqlite3 file inside
      const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-'));
      execSync(`tar xzf ${JSON.stringify(result)} -C ${JSON.stringify(extractDir)}`);
      const dbFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.sqlite3'));
      expect(dbFiles.length).toBeGreaterThan(0);

      const integrity = verifyBackupIntegrity(path.join(extractDir, dbFiles[0]));
      expect(integrity.ok).toBe(true);
      fs.rmSync(extractDir, { recursive: true, force: true });
    });

    it('creates backup directory if it does not exist', async () => {
      expect(fs.existsSync(backupDir)).toBe(false);
      await runDatabaseBackup();
      expect(fs.existsSync(backupDir)).toBe(true);
    });

    it('cleans up uncompressed .sqlite3 copy after compression', async () => {
      await runDatabaseBackup();
      const files = fs.readdirSync(backupDir);
      const sqlite3Files = files.filter(f => f.endsWith('.sqlite3'));
      expect(sqlite3Files).toHaveLength(0);
    });

    it('throws if database file does not exist', async () => {
      mockConfig.app.databasePath = path.join(tmpDir, 'nonexistent.db');
      await expect(runDatabaseBackup()).rejects.toThrow('Database file not found');
    });

    it('filename matches nexushub-backup-YYYY-MM-DD-HHmmss pattern', async () => {
      const result = await runDatabaseBackup();
      const basename = path.basename(result);
      expect(basename).toMatch(/^nexushub-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.sqlite3\.tar\.gz$/);
    });
  });

  // ── verifyBackupIntegrity ─────────────────────────────────────────

  describe('verifyBackupIntegrity', () => {
    it('returns ok:true for a valid SQLite database', async () => {
      const validDb = path.join(tmpDir, 'valid.sqlite3');
      await (testSourceDb as any).backup(validDb);

      const result = verifyBackupIntegrity(validDb);
      expect(result.ok).toBe(true);
      expect(result.details).toBe('ok');
    });

    it('returns ok:false for a corrupted file', () => {
      const badPath = path.join(tmpDir, 'bad.sqlite3');
      fs.writeFileSync(badPath, 'this is not a sqlite database');

      const result = verifyBackupIntegrity(badPath);
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for a nonexistent file', () => {
      const result = verifyBackupIntegrity(path.join(tmpDir, 'nope.sqlite3'));
      expect(result.ok).toBe(false);
    });
  });

  // ── Encryption ────────────────────────────────────────────────────

  describe('backup encryption', () => {
    it('encrypts and decrypts a file correctly (round-trip)', () => {
      const original = path.join(tmpDir, 'test.tar.gz');
      const content = Buffer.from('fake tar.gz content for testing');
      fs.writeFileSync(original, content);

      const encPath = encryptBackupFile(original, 'test-encryption-key-32chars-long!');
      expect(encPath).toMatch(/\.enc$/);
      expect(fs.existsSync(original)).toBe(false); // original deleted

      const decPath = decryptBackupFile(encPath, 'test-encryption-key-32chars-long!');
      expect(fs.readFileSync(decPath)).toEqual(content);
    });

    it('encrypted file is NOT valid gzip (binary data)', () => {
      const original = path.join(tmpDir, 'test2.tar.gz');
      fs.writeFileSync(original, Buffer.from([0x1f, 0x8b, 0x08, 0x00])); // fake gzip header

      const encPath = encryptBackupFile(original, 'my-key-here');
      const buf = fs.readFileSync(encPath);
      // First bytes should NOT be gzip magic (they're IV bytes)
      expect(buf[0] === 0x1f && buf[1] === 0x8b).toBe(false);
    });

    it('encrypts backup when BACKUP_ENCRYPT=true', async () => {
      mockConfig.backup.encrypt = true;
      mockConfig.backup.encryptionKey = 'test-backup-encryption-key-long!';

      const result = await runDatabaseBackup();
      expect(result).toMatch(/\.tar\.gz\.enc$/);
    });

    it('skips encryption when BACKUP_ENCRYPT=false', async () => {
      mockConfig.backup.encrypt = false;

      const result = await runDatabaseBackup();
      expect(result).toMatch(/\.tar\.gz$/);
      expect(result).not.toMatch(/\.enc$/);
    });

    it('throws on decryption with wrong key', () => {
      const original = path.join(tmpDir, 'test3.tar.gz');
      fs.writeFileSync(original, Buffer.from('secret content'));

      const encPath = encryptBackupFile(original, 'correct-key-here-32-chars-long!');
      expect(() => decryptBackupFile(encPath, 'wrong-key-definitely-not-right!')).toThrow();
    });
  });

  // ── rotateBackups ─────────────────────────────────────────────────

  describe('rotateBackups', () => {
    it('removes backups older than retention period', () => {
      fs.mkdirSync(backupDir, { recursive: true });

      const oldFile = path.join(backupDir, 'nexushub_2025-01-01_00-00-00.tar.gz');
      fs.writeFileSync(oldFile, 'old-backup');
      const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

      const freshFile = path.join(backupDir, 'nexushub_2026-03-30_03-00-00.tar.gz');
      fs.writeFileSync(freshFile, 'fresh-backup');

      const removed = rotateBackups(backupDir, 30);
      expect(removed).toBe(1);
      expect(fs.existsSync(oldFile)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);
    });

    it('does not remove backups within retention period', () => {
      fs.mkdirSync(backupDir, { recursive: true });
      const recentFile = path.join(backupDir, 'nexushub_2026-03-30_03-00-00.tar.gz');
      fs.writeFileSync(recentFile, 'recent-backup');

      expect(rotateBackups(backupDir, 30)).toBe(0);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('only removes nexushub_* and nexushub-backup-* files', () => {
      fs.mkdirSync(backupDir, { recursive: true });
      const otherFile = path.join(backupDir, 'important-data.tar.gz');
      fs.writeFileSync(otherFile, 'keep-me');
      const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
      fs.utimesSync(otherFile, new Date(oldTime), new Date(oldTime));

      expect(rotateBackups(backupDir, 30)).toBe(0);
      expect(fs.existsSync(otherFile)).toBe(true);
    });

    it('returns 0 for non-existent directory', () => {
      expect(rotateBackups('/tmp/nonexistent-backup-dir-xyz', 30)).toBe(0);
    });

    it('rotates new format nexushub-backup-* files', () => {
      fs.mkdirSync(backupDir, { recursive: true });
      const oldFile = path.join(backupDir, 'nexushub-backup-2025-01-01-00-00-00.sqlite3.tar.gz');
      fs.writeFileSync(oldFile, 'old');
      const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

      expect(rotateBackups(backupDir, 30)).toBe(1);
    });

    it('rotates encrypted .tar.gz.enc files', () => {
      fs.mkdirSync(backupDir, { recursive: true });
      const oldFile = path.join(backupDir, 'nexushub-backup-2025-01-01-00-00-00.sqlite3.tar.gz.enc');
      fs.writeFileSync(oldFile, 'old-enc');
      const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

      expect(rotateBackups(backupDir, 30)).toBe(1);
    });
  });

  // ── weeklyRestoreTest ─────────────────────────────────────────────

  describe('weeklyRestoreTest', () => {
    it('returns success:false when no backups exist', async () => {
      fs.mkdirSync(backupDir, { recursive: true });
      const result = await weeklyRestoreTest();
      expect(result.success).toBe(false);
      expect(result.details).toContain('No backup files found');
    });

    it('returns success:false when backup dir does not exist', async () => {
      mockConfig.backup.dir = '/tmp/nonexistent-restore-test-dir';
      const result = await weeklyRestoreTest();
      expect(result.success).toBe(false);
    });

    it('restores latest backup and verifies integrity', async () => {
      // Create a real backup first
      const backupPath = await runDatabaseBackup();
      expect(fs.existsSync(backupPath)).toBe(true);

      const result = await weeklyRestoreTest();
      expect(result.success).toBe(true);
      expect(result.details).toContain('ok');
    });

    it('handles encrypted backups', async () => {
      mockConfig.backup.encrypt = true;
      mockConfig.backup.encryptionKey = 'test-restore-key-at-least-32chars!!';

      const backupPath = await runDatabaseBackup();
      expect(backupPath).toMatch(/\.enc$/);

      const result = await weeklyRestoreTest();
      expect(result.success).toBe(true);
    });

    it('cleans up temp directory after test', async () => {
      await runDatabaseBackup();
      await weeklyRestoreTest();

      // No leftover temp directories
      const tmpDirs = fs.readdirSync(os.tmpdir()).filter(d => d.startsWith('nexushub-restore-test-'));
      expect(tmpDirs).toHaveLength(0);
    });
  });
});
