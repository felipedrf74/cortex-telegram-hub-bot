/**
 * Invoice Queue Service
 *
 * When the Mac SSH tunnel is unavailable (Mac sleeping, network issues),
 * invoices are saved to local disk and queued in SQLite for later retry.
 *
 * A cron job runs every 15 minutes to flush the queue when the tunnel
 * comes back online. Users are notified via Telegram on queue and flush.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from './database';
import {
  InvoiceAnalysis,
  fileInvoice,
  filePdf,
  testSshConnection,
  isInvoiceFilingConfigured,
} from './invoice-filer';
import { recordFiling } from '../state/invoice-filings';
import { pushEvent } from '../portal/telemetry';
import { logger } from '../utils/logger';
import { config } from '../config';

// ─── Queue Directory ──────────────────────────────────────────────────

const QUEUE_DIR = path.join(config.app.databasePath.replace(/\/[^/]+$/, ''), 'invoice-queue');

function ensureQueueDir(): void {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

// ─── Prepared Statements ──────────────────────────────────────────────

import type BetterSqlite3 from 'better-sqlite3';

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;

function getStmts(): Record<string, BetterSqlite3.Statement> {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    enqueue: db.prepare(`
      INSERT INTO invoice_queue (type, local_path, media_type, analysis_json, source, status)
      VALUES (?, ?, ?, ?, ?, 'pending')`),
    pending: db.prepare(`
      SELECT * FROM invoice_queue WHERE status = 'pending' ORDER BY created_at ASC`),
    pendingCount: db.prepare(`
      SELECT COUNT(*) as c FROM invoice_queue WHERE status = 'pending'`),
    markFiled: db.prepare(`
      UPDATE invoice_queue SET status = 'filed', filed_at = datetime('now'), error_message = NULL
      WHERE id = ?`),
    markRetry: db.prepare(`
      UPDATE invoice_queue SET retries = retries + 1, last_retry_at = datetime('now'), error_message = ?
      WHERE id = ?`),
    markFailed: db.prepare(`
      UPDATE invoice_queue SET status = 'failed', error_message = ?
      WHERE id = ?`),
  };
  return _stmts;
}

// ─── Types ────────────────────────────────────────────────────────────

export interface QueuedInvoice {
  id: number;
  type: string;
  local_path: string;
  media_type: string | null;
  analysis_json: string;
  source: string;
  status: string;
  retries: number;
  last_retry_at: string | null;
  error_message: string | null;
  created_at: string;
  filed_at: string | null;
}

// ─── Queue Operations ─────────────────────────────────────────────────

/**
 * Save an invoice to local disk and queue it for later filing.
 * Returns the queue entry ID.
 */
export function enqueueInvoice(
  buffer: Buffer,
  type: 'image' | 'pdf',
  mediaType: string | null,
  analysisJson: string,
  source: string,
): number {
  ensureQueueDir();

  const ext = type === 'pdf' ? 'pdf'
    : mediaType === 'image/png' ? 'png'
    : mediaType === 'image/webp' ? 'webp'
    : 'jpg';
  const filename = `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const localPath = path.join(QUEUE_DIR, filename);

  fs.writeFileSync(localPath, buffer);

  const stmts = getStmts();
  const result = stmts.enqueue.run(type, localPath, mediaType, analysisJson, source);

  logger.info({ id: result.lastInsertRowid, localPath, source }, 'Invoice queued for later filing');
  pushEvent({
    ts: new Date().toISOString(),
    type: 'job',
    summary: `Invoice queued (Mac unavailable) — ${JSON.parse(analysisJson).vendor || 'unknown'}`,
  });

  return Number(result.lastInsertRowid);
}

/**
 * Get count of pending invoices in the queue.
 */
export function getPendingCount(): number {
  try {
    const stmts = getStmts();
    return (stmts.pendingCount.get() as any).c;
  } catch {
    return 0;
  }
}

/**
 * Get all pending queue entries.
 */
export function getPendingInvoices(): QueuedInvoice[] {
  try {
    const stmts = getStmts();
    return stmts.pending.all() as QueuedInvoice[];
  } catch {
    return [];
  }
}

// ─── Queue Flush (Retry) ──────────────────────────────────────────────

const MAX_RETRIES = 20; // ~5 hours at 15min intervals

/**
 * Attempt to flush all pending invoices in the queue.
 * Called by the scheduler cron job every 15 minutes.
 *
 * Returns { flushed, failed, remaining } counts.
 */
export async function flushQueue(): Promise<{ flushed: number; failed: number; remaining: number }> {
  if (!isInvoiceFilingConfigured()) return { flushed: 0, failed: 0, remaining: 0 };

  const pending = getPendingInvoices();
  if (pending.length === 0) return { flushed: 0, failed: 0, remaining: 0 };

  // Quick SSH check before attempting any filing
  if (!testSshConnection()) {
    logger.debug({ pendingCount: pending.length }, 'Invoice queue flush: SSH tunnel still down');
    return { flushed: 0, failed: 0, remaining: pending.length };
  }

  logger.info({ pendingCount: pending.length }, 'Invoice queue flush: SSH tunnel is up, processing queue');

  const stmts = getStmts();
  let flushed = 0;
  let failed = 0;

  for (const item of pending) {
    // Check if local file still exists
    if (!fs.existsSync(item.local_path)) {
      stmts.markFailed.run('Local file missing', item.id);
      failed++;
      continue;
    }

    // Too many retries — give up
    if (item.retries >= MAX_RETRIES) {
      stmts.markFailed.run(`Exceeded ${MAX_RETRIES} retries`, item.id);
      failed++;
      // Clean up local file
      try { fs.unlinkSync(item.local_path); } catch { /* ignore */ }
      continue;
    }

    const buffer = fs.readFileSync(item.local_path);
    const analysis = JSON.parse(item.analysis_json);

    try {
      let result;

      if (item.type === 'image') {
        result = await fileInvoice(
          buffer,
          item.media_type as 'image/jpeg' | 'image/png' | 'image/webp',
          analysis as InvoiceAnalysis,
        );
      } else {
        result = await filePdf(
          buffer,
          analysis.vendor,
          analysis.documentDate,
          analysis.invoiceNumber,
          analysis.originalName,
        );
      }

      if (result.success) {
        stmts.markFiled.run(item.id);
        flushed++;

        // Record filing in invoice_filings table
        recordFiling({
          vendor: analysis.vendor || 'Unknown',
          amount: analysis.totalAmount || null,
          document_date: analysis.documentDate || null,
          invoice_number: analysis.invoiceNumber || null,
          source: item.source as 'photo' | 'email' | 'amazon' | 'uber',
          source_ref: `queue_${item.id}`,
          remote_path: result.filePath,
          folder_path: result.folderPath,
          filename: result.filename,
          file_size_bytes: result.originalSizeKB ? result.originalSizeKB * 1024 : null,
          compressed_size_bytes: result.compressedSizeKB ? result.compressedSizeKB * 1024 : null,
          status: 'filed',
        });

        // Clean up local file
        try { fs.unlinkSync(item.local_path); } catch { /* ignore */ }

        logger.info({ id: item.id, vendor: analysis.vendor }, 'Queued invoice filed successfully');
      } else {
        stmts.markRetry.run(result.error || 'Filing failed', item.id);
      }
    } catch (err: any) {
      stmts.markRetry.run(err?.message || 'Unknown error', item.id);
      // If SSH fails mid-flush, stop trying the rest
      if (err?.message?.includes('Connection') || err?.message?.includes('timed out')) {
        logger.warn('SSH connection lost mid-flush, stopping queue processing');
        break;
      }
    }
  }

  const remaining = getPendingCount();

  if (flushed > 0) {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'job',
      summary: `Invoice queue flushed: ${flushed} filed${failed > 0 ? `, ${failed} failed` : ''}${remaining > 0 ? `, ${remaining} remaining` : ''}`,
    });
  }

  return { flushed, failed, remaining };
}
