import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// We test the exported functions directly, mocking config and logger
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Dynamic config mock — override per test via `mockConfig`
let mockConfig = {
  app: { databasePath: '' },
  backup: { dir: '', retentionDays: 30, enabled: true, time: '03:00' },
};
vi.mock('../../src/config', () => ({
  get config() { return mockConfig; },
}));

import { runDatabaseBackup, rotateBackups } from '../../src/services/backup';

describe('backup service', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexushub-backup-test-'));
    dbPath = path.join(tmpDir, 'bot.db');
    backupDir = path.join(tmpDir, 'backups');

    // Create a fake SQLite database file
    fs.writeFileSync(dbPath, 'SQLite format 3\x00fake-db-content');

    mockConfig = {
      app: { databasePath: dbPath },
      backup: { dir: backupDir, retentionDays: 30, enabled: true, time: '03:00' },
    };
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('runDatabaseBackup', () => {
    it('creates a compressed tar.gz backup', async () => {
      const result = await runDatabaseBackup();

      expect(result).toMatch(/nexushub_.*\.tar\.gz$/);
      expect(fs.existsSync(result)).toBe(true);

      // Verify it's a valid gzip file (magic bytes: 1f 8b)
      const buf = Buffer.alloc(2);
      const fd = fs.openSync(result, 'r');
      fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      expect(buf[0]).toBe(0x1f);
      expect(buf[1]).toBe(0x8b);
    });

    it('creates backup directory if it does not exist', async () => {
      expect(fs.existsSync(backupDir)).toBe(false);
      await runDatabaseBackup();
      expect(fs.existsSync(backupDir)).toBe(true);
    });

    it('includes WAL file in backup when present', async () => {
      const walPath = `${dbPath}-wal`;
      fs.writeFileSync(walPath, 'wal-data');

      const result = await runDatabaseBackup();

      // List tar contents and verify WAL is included
      const contents = execSync(`tar tzf ${JSON.stringify(result)}`).toString();
      expect(contents).toContain('-wal');
    });

    it('cleans up temporary .db copy after compression', async () => {
      await runDatabaseBackup();

      const files = fs.readdirSync(backupDir);
      const dbFiles = files.filter((f) => f.endsWith('.db'));
      expect(dbFiles).toHaveLength(0);
    });

    it('throws if database file does not exist', async () => {
      mockConfig.app.databasePath = path.join(tmpDir, 'nonexistent.db');
      await expect(runDatabaseBackup()).rejects.toThrow('Database file not found');
    });

    it('produces unique filenames for successive backups', async () => {
      const first = await runDatabaseBackup();
      // Tiny delay to get a different timestamp
      await new Promise((r) => setTimeout(r, 1100));
      const second = await runDatabaseBackup();

      expect(first).not.toBe(second);
      expect(fs.existsSync(first)).toBe(true);
      expect(fs.existsSync(second)).toBe(true);
    });
  });

  describe('rotateBackups', () => {
    it('removes backups older than retention period', () => {
      fs.mkdirSync(backupDir, { recursive: true });

      // Create an "old" backup and set its mtime to 31 days ago
      const oldFile = path.join(backupDir, 'nexushub_2025-01-01_00-00-00.tar.gz');
      fs.writeFileSync(oldFile, 'old-backup');
      const oldTime = Date.now() - 31 * 24 * 60 * 60 * 1000;
      fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

      // Create a "fresh" backup
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

      const removed = rotateBackups(backupDir, 30);

      expect(removed).toBe(0);
      expect(fs.existsSync(recentFile)).toBe(true);
    });

    it('only removes nexushub_*.tar.gz files', () => {
      fs.mkdirSync(backupDir, { recursive: true });

      // Create a non-matching file with old mtime
      const otherFile = path.join(backupDir, 'important-data.tar.gz');
      fs.writeFileSync(otherFile, 'keep-me');
      const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
      fs.utimesSync(otherFile, new Date(oldTime), new Date(oldTime));

      const removed = rotateBackups(backupDir, 30);

      expect(removed).toBe(0);
      expect(fs.existsSync(otherFile)).toBe(true);
    });

    it('returns 0 for non-existent directory', () => {
      const removed = rotateBackups('/tmp/nonexistent-backup-dir-xyz', 30);
      expect(removed).toBe(0);
    });

    it('handles custom retention days', () => {
      fs.mkdirSync(backupDir, { recursive: true });

      const file = path.join(backupDir, 'nexushub_2026-03-20_03-00-00.tar.gz');
      fs.writeFileSync(file, 'backup');
      // Set mtime to 8 days ago
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      fs.utimesSync(file, new Date(eightDaysAgo), new Date(eightDaysAgo));

      // With 7-day retention, this should be removed
      expect(rotateBackups(backupDir, 7)).toBe(1);
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});
