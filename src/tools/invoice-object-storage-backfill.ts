// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../config';
import {
  buildInvoiceObjectKey,
  isInvoiceObjectStorageConfigured,
  putInvoiceObject,
} from '../services/invoice-object-storage';

interface LegacyFilingRow {
  id: number;
  tenant_id: number;
  user_id: number;
  vendor: string;
  document_date: string | null;
  filename: string | null;
  remote_path: string | null;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp(): void {
  console.log(`
Invoice object storage backfill

Usage:
  node dist/tools/invoice-object-storage-backfill.js [--db ./data/bot.db] [--legacy-root /mounted/legacy/root] [--limit 100] [--apply] [--json]

Defaults to dry-run mode. Without --apply, no rows are changed and no objects are written.

The tool never opens SSH/SCP itself. Mount or mirror the legacy remote invoice root on the VPS,
then pass --legacy-root or INVOICE_LEGACY_REMOTE_MOUNT. Rows whose legacy file cannot be found are
marked orphaned only with --apply.
`);
}

function resolveDbPath(): string {
  return argValue('--db') || config.app.databasePath;
}

function resolveLegacyRoot(): string | null {
  const explicit = argValue('--legacy-root') || process.env.INVOICE_LEGACY_REMOTE_MOUNT;
  return explicit ? path.resolve(explicit) : null;
}

function parseLimit(): number {
  const raw = argValue('--limit');
  if (!raw) return 500;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 500;
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'xml') return 'application/xml';
  if (ext === 'p7m') return 'application/pkcs7-mime';
  if (ext === 'zip') return 'application/zip';
  return 'application/octet-stream';
}

function legacyFilePath(row: LegacyFilingRow, legacyRoot: string | null): string | null {
  if (!row.remote_path) return null;
  if (fs.existsSync(row.remote_path)) return row.remote_path;
  if (!legacyRoot) return null;

  const configuredRemoteRoot = config.invoices.remotePath;
  if (configuredRemoteRoot && row.remote_path.startsWith(configuredRemoteRoot)) {
    const relative = row.remote_path.slice(configuredRemoteRoot.length).replace(/^[/\\]+/, '');
    const candidate = path.resolve(legacyRoot, relative);
    if (candidate.startsWith(`${legacyRoot}${path.sep}`) && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const basenameCandidate = path.resolve(legacyRoot, path.basename(row.remote_path));
  if (basenameCandidate.startsWith(`${legacyRoot}${path.sep}`) && fs.existsSync(basenameCandidate)) {
    return basenameCandidate;
  }
  return null;
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp();
    return;
  }
  if (!isInvoiceObjectStorageConfigured()) {
    throw new Error('Invoice object storage is not configured.');
  }

  const dbPath = resolveDbPath();
  const legacyRoot = resolveLegacyRoot();
  const apply = hasFlag('--apply');
  const asJson = hasFlag('--json');
  const limit = parseLimit();
  const db = new Database(dbPath);

  const report = {
    database: dbPath,
    legacyRoot,
    apply,
    scanned: 0,
    migratable: 0,
    migrated: 0,
    missing: 0,
    orphaned: 0,
    errors: [] as Array<{ id: number; error: string }>,
  };

  try {
    const rows = db.prepare(`
      SELECT id, tenant_id, user_id, vendor, document_date, filename, remote_path
        FROM invoice_filings
       WHERE status = 'filed'
         AND object_key IS NULL
         AND remote_path IS NOT NULL
         AND remote_path <> ''
       ORDER BY id ASC
       LIMIT ?
    `).all(limit) as LegacyFilingRow[];
    report.scanned = rows.length;

    for (const row of rows) {
      const filePath = legacyFilePath(row, legacyRoot);
      if (!filePath) {
        report.missing += 1;
        if (apply) {
          db.prepare(`
            UPDATE invoice_filings
               SET status = 'orphaned',
                   error_message = COALESCE(error_message, 'Legacy remote invoice file missing during object storage backfill')
             WHERE id = ?
          `).run(row.id);
          report.orphaned += 1;
        }
        continue;
      }

      report.migratable += 1;
      if (!apply) continue;

      try {
        const filename = row.filename || path.basename(filePath);
        const buffer = fs.readFileSync(filePath);
        const objectKey = buildInvoiceObjectKey({
          tenantId: row.tenant_id || row.user_id,
          userId: row.user_id,
          documentDate: row.document_date,
          filename,
        });
        const stored = await putInvoiceObject(buffer, objectKey, guessMime(filename));
        db.prepare(`
          UPDATE invoice_filings
             SET object_key = ?,
                 checksum = ?,
                 mime = ?,
                 bytes = ?,
                 storage_backend = ?,
                 filename = COALESCE(filename, ?),
                 error_message = NULL
           WHERE id = ?
        `).run(
          stored.objectKey,
          stored.checksum,
          stored.mime,
          stored.bytes,
          stored.storageBackend,
          filename,
          row.id,
        );
        report.migrated += 1;
      } catch (err) {
        report.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    db.close();
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Invoice object storage backfill ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`- database: ${report.database}`);
  console.log(`- legacy root: ${report.legacyRoot || '(remote paths only)'}`);
  console.log(`- scanned: ${report.scanned}`);
  console.log(`- migratable: ${report.migratable}`);
  console.log(`- migrated: ${report.migrated}`);
  console.log(`- missing legacy files: ${report.missing}`);
  console.log(`- marked orphaned: ${report.orphaned}`);
  console.log(`- errors: ${report.errors.length}`);
  if (!apply) {
    console.log('');
    console.log('Dry-run only. Re-run with --apply after reviewing output and taking a DB backup.');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
