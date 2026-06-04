// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Database Backup Service — SQLite backup with integrity checks,
 * optional AES-256-GCM encryption, and automated weekly restore test.
 *
 * Uses SQLite's Online Backup API (via better-sqlite3's db.backup()) for
 * crash-safe copies under WAL mode — no risk of copying mid-write.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Encryption constants ───────────────────────────────────────────

const BACKUP_ALGORITHM = 'aes-256-gcm';
const BACKUP_IV_LENGTH = 16;
const BACKUP_TAG_LENGTH = 16;

export function assertBackupEncryptionConfiguredForRuntime(): void {
  if (
    process.env.NODE_ENV === 'production'
    && config.backup.enabled
    && (!config.backup.encrypt || !config.backup.encryptionKey)
  ) {
    throw new Error(
      'BACKUP_ENABLED=true requires BACKUP_ENCRYPT=true and BACKUP_KEY in production. Generate BACKUP_KEY with: openssl rand -hex 32',
    );
  }
}

// ─── Main backup function ───────────────────────────────────────────

/**
 * Runs a full SQLite database backup:
 *  1. Copies the DB using SQLite's Online Backup API (WAL-safe)
 *  2. Verifies integrity of the backup file
 *  3. Compresses to .tar.gz
 *  4. Optionally encrypts with AES-256-GCM
 *  5. Rotates old backups beyond retention period
 *
 * Returns the path to the created backup file.
 */
export async function runDatabaseBackup(): Promise<string> {
  assertBackupEncryptionConfiguredForRuntime();

  const dbPath = path.resolve(config.app.databasePath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const backupDir = path.resolve(config.backup.dir);
  fs.mkdirSync(backupDir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.T]/g, '-').slice(0, 19);
  const backupFile = path.join(backupDir, `nexushub-backup-${ts}.sqlite3`);

  // Step 1: SQLite backup API (safe under WAL)
  const sourceDb = getDb();
  await (sourceDb as any).backup(backupFile);

  // Step 2: Verify integrity
  const integrity = verifyBackupIntegrity(backupFile);
  if (!integrity.ok) {
    safeUnlink(backupFile);
    throw new Error(`Backup integrity check failed: ${integrity.details}`);
  }

  // Step 3: Compress
  const tarFile = `${backupFile}.tar.gz`;
  try {
    execSync(
      `tar czf ${JSON.stringify(path.basename(tarFile))} ${JSON.stringify(path.basename(backupFile))}`,
      { cwd: backupDir, timeout: 60_000 },
    );
  } finally {
    safeUnlink(backupFile);
  }

  // Step 4: Encrypt if configured
  let finalPath = tarFile;
  if (config.backup.encrypt && config.backup.encryptionKey) {
    finalPath = encryptBackupFile(tarFile, config.backup.encryptionKey);
  }

  const stat = fs.statSync(finalPath);
  logger.info(
    { path: finalPath, sizeBytes: stat.size, encrypted: config.backup.encrypt, integrity: integrity.details },
    'Database backup created',
  );

  // Step 5: Rotate old local backups
  rotateBackups(backupDir, config.backup.retentionDays);

  // Step 6: Off-site upload to Google Drive (non-blocking — local backup
  // is the source of truth; Drive is the disaster-recovery replica).
  //
  // The upload goes through google-drive.ts → google-auth.ts bridge →
  // oauth-store, so it automatically picks up whatever the latest Google
  // refresh token is. If Google is disconnected (e.g. before /connect
  // google completes), the upload silently no-ops and runDatabaseBackup
  // still returns the local path unchanged. See uploadBackupToDrive() for
  // retention + error handling. Audit ref: Weeks 2-4 off-site backup.
  try {
    const { uploadBackupToDrive, isGoogleDriveEnabled } = await import('./google-drive');
    const { getOwnerBootstrapUserRefs } = await import('./user-service');
    const ownerUserId = getOwnerBootstrapUserRefs()[0];
    if (ownerUserId != null && isGoogleDriveEnabled(ownerUserId)) {
      if (!finalPath.endsWith('.enc')) {
        logger.warn(
          { backup: path.basename(finalPath) },
          'Refusing to upload unencrypted database backup to Google Drive',
        );
        return finalPath;
      }

      const driveFileId = await uploadBackupToDrive(ownerUserId, finalPath, path.basename(finalPath));
      if (driveFileId) {
        logger.info(
          { driveFileId, backup: path.basename(finalPath) },
          'Backup replicated to Google Drive',
        );
      } else {
        logger.info(
          'Google Drive backup upload returned null — check Drive credentials or run /connect google',
        );
      }
    } else {
      logger.warn(
        config.backup.encrypt
          ? 'Google Drive not enabled; encrypted backup is local-only'
          : 'Google Drive not enabled; unencrypted backup is local-only',
      );
    }
  } catch (err: any) {
    // Never fail the whole backup flow because Drive failed. Local backup
    // is the source of truth; Drive is just the off-site replica.
    logger.warn({ err: err.message }, 'Drive upload failed; local backup retained');
  }

  return finalPath;
}

// ─── Integrity check ────────────────────────────────────────────────

/**
 * Verify a SQLite database file is valid and not corrupted.
 * Opens a separate read-only connection to the backup file.
 */
export function verifyBackupIntegrity(backupPath: string): { ok: boolean; details: string } {
  let db: Database.Database | null = null;
  try {
    db = new Database(backupPath, { readonly: true });
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const status = result[0]?.integrity_check ?? 'unknown';
    const ok = status === 'ok';
    if (!ok) {
      logger.error({ backupPath, status }, 'Backup integrity check FAILED');
    }
    return { ok, details: status };
  } catch (err: any) {
    logger.error({ err, backupPath }, 'Failed to verify backup integrity');
    return { ok: false, details: err.message };
  } finally {
    db?.close();
  }
}

// ─── Encryption ─────────────────────────────────────────────────────

/**
 * Encrypt a file using AES-256-GCM. Appends .enc extension.
 * Format: IV (16 bytes) + authTag (16 bytes) + ciphertext
 * Removes the unencrypted file after encryption.
 */
export function encryptBackupFile(filePath: string, key: string): string {
  const keyBuffer = crypto.scryptSync(key, 'nexushub-backup-salt', 32);
  const iv = crypto.randomBytes(BACKUP_IV_LENGTH);
  const cipher = crypto.createCipheriv(BACKUP_ALGORITHM, keyBuffer, iv, { authTagLength: BACKUP_TAG_LENGTH });

  const input = fs.readFileSync(filePath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();

  const outputPath = `${filePath}.enc`;
  fs.writeFileSync(outputPath, Buffer.concat([iv, tag, encrypted]));
  fs.unlinkSync(filePath);

  logger.info({ path: outputPath }, 'Backup encrypted');
  return outputPath;
}

/**
 * Decrypt an encrypted backup file.
 * Returns path to the decrypted file (removes .enc extension).
 */
export function decryptBackupFile(encPath: string, key: string): string {
  const keyBuffer = crypto.scryptSync(key, 'nexushub-backup-salt', 32);
  const data = fs.readFileSync(encPath);

  if (data.length < BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH) {
    throw new Error('Encrypted backup file too short');
  }

  const iv = data.subarray(0, BACKUP_IV_LENGTH);
  const tag = data.subarray(BACKUP_IV_LENGTH, BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH);
  const ciphertext = data.subarray(BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(BACKUP_ALGORITHM, keyBuffer, iv, { authTagLength: BACKUP_TAG_LENGTH });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const outputPath = encPath.replace(/\.enc$/, '');
  fs.writeFileSync(outputPath, decrypted);

  return outputPath;
}

// ─── Rotation ───────────────────────────────────────────────────────

/**
 * Removes backup files older than `retentionDays`.
 * Handles both old (nexushub_*) and new (nexushub-backup-*) formats + .enc files.
 */
export function rotateBackups(backupDir: string, retentionDays: number): number {
  if (!fs.existsSync(backupDir)) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupDir).filter((f) =>
    (f.startsWith('nexushub_') || f.startsWith('nexushub-backup-')) &&
    (f.endsWith('.tar.gz') || f.endsWith('.tar.gz.enc'))
  );
  let removed = 0;

  for (const file of files) {
    const filePath = path.join(backupDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      // Skip files we can't stat/delete
    }
  }

  if (removed > 0) {
    logger.info({ removed, retentionDays }, 'Rotated old database backups');
  }

  return removed;
}

// ─── Weekly restore test ────────────────────────────────────────────

/**
 * Weekly restore test — restores the latest backup to a temp file,
 * runs integrity check, then deletes the temp file.
 */
export async function weeklyRestoreTest(): Promise<{ success: boolean; details: string }> {
  const backupDir = path.resolve(config.backup.dir);
  if (!fs.existsSync(backupDir)) {
    return { success: false, details: 'Backup directory does not exist' };
  }

  const files = fs.readdirSync(backupDir)
    .filter(f => (f.startsWith('nexushub_') || f.startsWith('nexushub-backup-')) &&
                 (f.endsWith('.tar.gz') || f.endsWith('.tar.gz.enc')))
    .sort()
    .reverse();

  if (files.length === 0) {
    return { success: false, details: 'No backup files found' };
  }

  const latestBackup = path.join(backupDir, files[0]);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexushub-restore-test-'));

  try {
    let tarPath = latestBackup;

    // Decrypt if encrypted
    if (latestBackup.endsWith('.enc')) {
      if (!config.backup.encryptionKey) {
        return { success: false, details: 'Backup is encrypted but BACKUP_KEY not set' };
      }
      const tmpEncPath = path.join(tmpDir, path.basename(latestBackup));
      fs.copyFileSync(latestBackup, tmpEncPath);
      tarPath = decryptBackupFile(tmpEncPath, config.backup.encryptionKey);
    }

    // Extract tar.gz
    execSync(`tar xzf ${JSON.stringify(tarPath)} -C ${JSON.stringify(tmpDir)}`, { timeout: 60_000 });

    // Find the .sqlite3 or .db file
    const dbFiles = fs.readdirSync(tmpDir).filter(f => f.endsWith('.sqlite3') || f.endsWith('.db'));
    if (dbFiles.length === 0) {
      return { success: false, details: 'No database file found in backup archive' };
    }

    const restoredDb = path.join(tmpDir, dbFiles[0]);
    const integrity = verifyBackupIntegrity(restoredDb);

    logger.info(
      { backupFile: files[0], integrity: integrity.details, success: integrity.ok },
      'Weekly restore test completed',
    );

    return { success: integrity.ok, details: `Restored ${files[0]}: ${integrity.details}` };
  } catch (err: any) {
    logger.error({ err }, 'Weekly restore test failed');
    return { success: false, details: err.message };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}
