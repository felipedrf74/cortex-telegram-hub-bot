// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Runs a full SQLite database backup:
 *  1. Copies the DB file (safe in WAL mode when idle at 3am)
 *  2. Compresses to .tar.gz
 *  3. Removes the uncompressed copy
 *  4. Rotates old backups beyond retention period
 *
 * Returns the path to the created backup file.
 */
export async function runDatabaseBackup(): Promise<string> {
  const dbPath = path.resolve(config.app.databasePath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found: ${dbPath}`);
  }

  const backupDir = path.resolve(config.backup.dir);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const baseName = `nexushub_${timestamp}`;
  const tmpCopy = path.join(backupDir, `${baseName}.db`);
  const tarFile = path.join(backupDir, `${baseName}.tar.gz`);

  // Step 1: Copy DB file (and WAL/SHM if present)
  fs.copyFileSync(dbPath, tmpCopy);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  if (fs.existsSync(walPath)) fs.copyFileSync(walPath, `${tmpCopy}-wal`);
  if (fs.existsSync(shmPath)) fs.copyFileSync(shmPath, `${tmpCopy}-shm`);

  // Step 2: Compress to tar.gz
  try {
    execSync(
      `tar czf ${JSON.stringify(path.basename(tarFile))} ${JSON.stringify(path.basename(tmpCopy))}` +
        (fs.existsSync(`${tmpCopy}-wal`) ? ` ${JSON.stringify(path.basename(tmpCopy) + '-wal')}` : '') +
        (fs.existsSync(`${tmpCopy}-shm`) ? ` ${JSON.stringify(path.basename(tmpCopy) + '-shm')}` : ''),
      { cwd: backupDir, timeout: 60_000 },
    );
  } finally {
    // Step 3: Clean up uncompressed copies
    safeUnlink(tmpCopy);
    safeUnlink(`${tmpCopy}-wal`);
    safeUnlink(`${tmpCopy}-shm`);
  }

  const stat = fs.statSync(tarFile);
  logger.info(
    { path: tarFile, sizeBytes: stat.size },
    'Database backup created',
  );

  // Step 4: Rotate old backups
  rotateBackups(backupDir, config.backup.retentionDays);

  return tarFile;
}

/**
 * Removes backup files older than `retentionDays` from the backup directory.
 * Only deletes files matching the nexushub_*.tar.gz pattern.
 */
export function rotateBackups(backupDir: string, retentionDays: number): number {
  if (!fs.existsSync(backupDir)) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('nexushub_') && f.endsWith('.tar.gz'));
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

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup
  }
}
