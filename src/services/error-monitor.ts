// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Error Monitor — persistent error tracking, operator alerting, and trend queries.
 *
 * Captures:
 *  - Unhandled promise rejections
 *  - Uncaught exceptions
 *  - Explicit error reports from jobs, API calls, and the portal
 *
 * Alertable errors flow through recordOperatorAlert (durable operator_alerts
 * queue → OPERATOR_ALERT_WEBHOOK_URL delivery, see operator-alerts.ts) plus
 * an optional in-process alert callback (rate-limited to avoid spam).
 * Persists to SQLite for trend analysis via the portal.
 */

import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';
import {
  captureException as sentryCaptureException,
  isEnabled as isSentryEnabled,
} from './error-tracker';
import { recordOperatorAlert } from './operator-alerts';
import {
  sanitizeLogText,
  sanitizeLogValue,
  stringifySanitizedLogContext,
} from '../utils/log-sanitizer';
import { getCurrentContext } from '../utils/request-context';
import { linkIssueAlert, upsertIssue } from './issue-tracker';

// ── Types ────────────────────────────────────────────────────────

export type ErrorLevel = 'error' | 'fatal' | 'warning';
export type ErrorSource = 'bot' | 'job' | 'api' | 'unhandled' | 'portal' | 'process';

export interface ErrorRecord {
  level: ErrorLevel;
  source: ErrorSource;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
}

export interface ErrorLogEntry {
  id: number;
  ts: string;
  level: ErrorLevel;
  source: ErrorSource;
  message: string;
  stack: string | null;
  context: string | null;
  alerted: number;
  user_id?: number | null;
  tenant_id?: number | null;
}

export interface ErrorTrends {
  today: number;
  last7d: number;
  last30d: number;
  bySource: { source: string; count: number }[];
  byLevel: { level: string; count: number }[];
  recent: ErrorLogEntry[];
}

// ── Database Provider ────────────────────────────────────────────

type DbProvider = () => any;
let _getDb: DbProvider | null = null;
let _errorLogHasScopeColumns: boolean | null = null;

// ── Boot Buffer ──────────────────────────────────────────────────
// Errors that fire BEFORE setDbProvider() is called (e.g. config validation
// throws, EADDRINUSE on portal port, missing env vars) cannot be persisted
// to error_log because the DB connection isn't ready yet. Without buffering,
// these errors only land in PM2's stderr file — invisible to the admin
// portal which queries the error_log table. Production data showed
// error_log stuck at 10 rows (all April 3 EADDRINUSE) while file logs
// continued growing for 4 days afterwards. See audit P0-6.
//
// We hold up to 100 entries in memory; once setDbProvider() runs, we flush
// them all to error_log in a single transaction-friendly loop.
const _bootBuffer: ErrorRecord[] = [];
const BOOT_BUFFER_MAX = 100;

export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
  _errorLogHasScopeColumns = null;
  // Flush any errors that were buffered before the DB came online.
  if (_bootBuffer.length > 0) {
    const buffered = _bootBuffer.splice(0);
    let flushed = 0;
    for (const record of buffered) {
      try {
        persistToDb(record);
        flushed++;
      } catch (err) {
        logger.warn({ err }, 'Error monitor: failed to flush boot-buffered error');
      }
    }
    logger.info({ count: flushed }, 'Error monitor: flushed boot-buffered errors to error_log');
  }
}

/** Internal: write a record to error_log. Caller guarantees _getDb is set. */
let _errorLogHasIssueColumns: boolean | null = null;

/** Insert the error row, then link it to its grouped issue (migration 315). */
function persistToDb(record: ErrorRecord): { errorId: number | null; issueId: number | null } {
  if (!_getDb) return { errorId: null, issueId: null };
  const db = _getDb();
  if (_errorLogHasIssueColumns == null) {
    try {
      const columns = db.prepare("PRAGMA table_info('error_log')").all() as Array<{ name: string }>;
      _errorLogHasIssueColumns = columns.some((column) => column.name === 'issue_id') &&
        columns.some((column) => column.name === 'req_id');
    } catch {
      _errorLogHasIssueColumns = false;
    }
  }
  const inserted = insertErrorRow(db, record);
  if (!_errorLogHasIssueColumns || inserted == null) return { errorId: inserted, issueId: null };
  try {
    const reqId = getCurrentContext()?.requestId ?? null;
    const issue = upsertIssue({
      kind: 'server',
      source: record.source,
      level: record.level,
      message: record.message,
      stack: record.stack ?? null,
      reqId,
      userId: getCurrentContext()?.userId ?? null,
    });
    db.prepare('UPDATE error_log SET req_id = ?, issue_id = ? WHERE id = ?').run(reqId, issue?.issueId ?? null, inserted);
    return { errorId: inserted, issueId: issue?.issueId ?? null };
  } catch {
    return { errorId: inserted, issueId: null };
  }
}

function insertErrorRow(db: any, record: ErrorRecord): number | null {
  if (_errorLogHasScopeColumns == null) {
    try {
      const columns = db.prepare("PRAGMA table_info('error_log')").all() as Array<{ name: string }>;
      _errorLogHasScopeColumns = columns.some((column) => column.name === 'user_id') &&
        columns.some((column) => column.name === 'tenant_id');
    } catch {
      _errorLogHasScopeColumns = false;
    }
  }
  const contextJson = record.context ? stringifySanitizedLogContext(record.context) : null;
  const message = sanitizeLogText(record.message);
  const stack = record.stack ? sanitizeLogText(record.stack) : null;
  const shouldAlertFlag = record.level !== 'warning';
  const ctx = getCurrentContext();
  if (_errorLogHasScopeColumns) {
    const scoped = db.prepare(`
      INSERT INTO error_log (level, source, message, stack, context, alerted, user_id, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.level,
      record.source,
      message.slice(0, 2000),
      stack?.slice(0, 4000) ?? null,
      contextJson,
      shouldAlertFlag && _alertFn ? 1 : 0,
      ctx?.userId ?? null,
      ctx?.tenantId ?? ctx?.userId ?? null,
    );
    return scoped?.lastInsertRowid != null ? Number(scoped.lastInsertRowid) : null;
  }
  const plain = db.prepare(`
    INSERT INTO error_log (level, source, message, stack, context, alerted)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    record.level,
    record.source,
    message.slice(0, 2000),
    stack?.slice(0, 4000) ?? null,
    contextJson,
    shouldAlertFlag && _alertFn ? 1 : 0,
  );
  return plain?.lastInsertRowid != null ? Number(plain.lastInsertRowid) : null;
}

// ── In-Process Alert Callback ────────────────────────────────────
// Legacy chat-delivery era hook; index.ts now wires it to a structured
// logger. The durable operator paging path is recordOperatorAlert below.

type AlertCallback = (message: string) => Promise<void>;
let _alertFn: AlertCallback | null = null;

/** Register the in-process alert callback. Called once during startup. */
export function setAlertCallback(fn: AlertCallback): void {
  _alertFn = fn;
}

// ── Rate Limiter (suppress duplicate alerts within 60s) ──────────
//
// LRU-bounded at 1000 unique alert keys. Without the bound, every unique
// error source+message combination would add a permanent entry here — and
// at multi-user scale with varied errors, that's unbounded memory growth.
// 1000 keys is plenty for a 60-second cooldown window because even at
// 100 errors/second the window rotates faster than the LRU eviction
// (~1000 unique keys in 60s would require 16 unique errors/sec, which
// is itself an alert-worthy condition). Audit Month 2 #3.

import { LRUMap } from '../utils/lru-map';

const _alertCooldowns = new LRUMap<string, number>(1000);
const ALERT_COOLDOWN_MS = 60_000;

function shouldAlert(key: string): boolean {
  const last = _alertCooldowns.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  _alertCooldowns.set(key, Date.now());
  return true;
}

// ── Core: Record Error ───────────────────────────────────────────

/**
 * Record an error to the persistent log and optionally raise operator alerts.
 *
 * @param record - Error details
 * @param alert - Whether to raise operator alerts (default: true for error/fatal)
 */
export function captureError(record: ErrorRecord, alert?: boolean): void {
  const shouldSendAlert = alert ?? (record.level !== 'warning');
  const safeMessage = sanitizeLogText(record.message);
  const safeStack = record.stack ? sanitizeLogText(record.stack) : undefined;
  const safeContext = record.context
    ? sanitizeLogValue(record.context) as Record<string, unknown>
    : undefined;

  // Persist to SQLite — or buffer if DB isn't ready yet (boot-time errors)
  let alerted = 0;
  let issueId: number | null = null;
  if (_getDb) {
    try {
      issueId = persistToDb(record).issueId;
      alerted = shouldSendAlert ? 1 : 0;
    } catch (err) {
      logger.warn({ err }, 'Error monitor: failed to persist error');
    }
  } else if (_bootBuffer.length < BOOT_BUFFER_MAX) {
    // Boot-phase: buffer the error so it can be persisted once setDbProvider runs.
    // Bounded at 100 to prevent memory bloat in catastrophic boot loops.
    _bootBuffer.push(record);
  }

  // Push to in-memory telemetry ring buffer
  pushEvent({
    ts: new Date().toISOString(),
    type: 'error',
    summary: `[${record.source}] ${safeMessage.slice(0, 80)}`,
    detail: safeStack?.slice(0, 300),
  });

  // Log
  logger.error({ source: record.source, level: record.level }, safeMessage);

  if (shouldSendAlert) {
    const alertResult = recordOperatorAlert({
      severity: record.level === 'fatal' ? 'critical' : 'warning',
      source: `error_monitor:${record.source}`,
      dedupeKey: `error:${record.source}:${safeMessage.slice(0, 160)}`,
      title: `${record.level.toUpperCase()} in ${record.source}`,
      detail: safeMessage.slice(0, 500),
      owner: 'ops',
      suspectedArea: record.source,
      userImpact: record.source === 'api'
        ? 'A backend API request failed and may have returned a degraded or failed response to the app.'
        : 'A backend runtime path failed and may need operator investigation.',
      runbookUrl: 'docs/OBSERVABILITY-ONCALL.md#error-monitor-alerts',
      metadata: {
        source: record.source,
        level: record.level,
        context: safeContext,
        issueId,
      },
    });
    if (issueId && alertResult?.alert?.id) linkIssueAlert(issueId, alertResult.alert.id);
  }

  // Invoke the in-process alert callback (rate-limited)
  if (shouldSendAlert && alerted && _alertFn) {
      const alertKey = `${record.source}:${safeMessage.slice(0, 100)}`;
      if (shouldAlert(alertKey)) {
        const icon = record.level === 'fatal' ? '🔴' : '🟠';
        const msg = `${icon} <b>${escapeHtml(record.level.toUpperCase())}</b> [${escapeHtml(record.source)}]\n\n<code>${escapeHtml(safeMessage.slice(0, 300))}</code>`;
        _alertFn(msg).catch(() => {});
      }
    }

  // Forward to Sentry (if SENTRY_DSN is configured). No-ops silently
  // when Sentry isn't initialized, so local/staging without a DSN just
  // keeps the SQLite + operator alerting behavior and nothing else.
  //
  // We map ErrorLevel → Sentry's SeverityLevel: 'fatal' stays 'fatal',
  // 'warning' stays 'warning', everything else is 'error'. The record's
  // context becomes Sentry `extra` data, and source/level become tags
  // so you can filter in the Sentry UI.
  if (isSentryEnabled()) {
    try {
      const sentryLevel: 'fatal' | 'warning' | 'error' =
        record.level === 'fatal' ? 'fatal' :
        record.level === 'warning' ? 'warning' : 'error';
      const errLike = safeStack
        ? Object.assign(new Error(safeMessage), { stack: safeStack })
        : new Error(safeMessage);
      sentryCaptureException(errLike, {
        level: sentryLevel,
        source: record.source,
        extra: safeContext,
        tags: { source: record.source, level: record.level },
      });
    } catch {
      // Never let Sentry forwarding break the local capture path.
    }
  }
}

// ── Process-Level Handlers ───────────────────────────────────────

let _handlersInstalled = false;

// Graceful shutdown callback registered by main() after the bot/portal/db
// have been wired up. boot.ts installs the process handlers BEFORE config
// import — at that moment there's nothing graceful to do, so the handlers
// fall back to a plain process.exit(1). Once main() registers the real
// shutdown via setShutdownCallback(), runtime errors get the full graceful
// path: bot.stop() → portalServer.close() → closeDatabase() → exit. This
// is essential to avoid the EADDRINUSE deploy race (audit P0-4): without
// portalServer.close(), the OS keeps port 8200 in TIME_WAIT for 60s after
// the process dies, and the next PM2 restart can't bind cleanly.
type ShutdownCallback = () => Promise<void>;
let _shutdownFn: ShutdownCallback | null = null;
let _shutdownInProgress = false;

/** Register a graceful shutdown function. Called once from main(). */
export function setShutdownCallback(fn: ShutdownCallback): void {
  _shutdownFn = fn;
}

async function gracefulOrAbort(reason: string): Promise<never> {
  if (_shutdownInProgress) {
    // Re-entry: original shutdown is already running. Don't deadlock —
    // exit hard. PM2 will restart us.
    logger.fatal({ reason }, 'Re-entrant shutdown — forcing exit');
    process.exit(1);
  }
  _shutdownInProgress = true;
  if (_shutdownFn) {
    try {
      logger.fatal({ reason }, 'Initiating graceful shutdown from error handler');
      // Bound the graceful path so a hung shutdown can't pin the process.
      // PM2's kill_timeout is 10s; we leave a 2s safety margin.
      await Promise.race([
        _shutdownFn(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Graceful shutdown timeout')), 8000),
        ),
      ]);
    } catch (err) {
      logger.fatal({ err }, 'Graceful shutdown failed — forcing exit');
    }
  }
  process.exit(1);
}

/** Install global process error handlers. Call once during startup. */
export function installProcessHandlers(): void {
  if (_handlersInstalled) return;
  _handlersInstalled = true;

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    captureError({
      level: 'error',
      source: 'unhandled',
      message: `Unhandled rejection: ${err.message}`,
      stack: err.stack,
    });
    // Previously this handler ONLY logged, leaving the bot running in a
    // corrupted state with no signal to PM2. We now treat unhandled
    // rejections as fatal — let PM2 restart us cleanly. See audit P0-4.
    void gracefulOrAbort('unhandledRejection');
  });

  process.on('uncaughtException', (err: Error) => {
    captureError({
      level: 'fatal',
      source: 'process',
      message: `Uncaught exception: ${err.message}`,
      stack: err.stack,
    });
    logger.fatal({ err }, 'Uncaught exception — initiating graceful shutdown');
    void gracefulOrAbort('uncaughtException');
  });

  logger.info('Error monitor: process handlers installed');
}

// ── Query API (for portal) ───────────────────────────────────────

/** Get error trends for the portal dashboard. */
export function getErrorTrends(): ErrorTrends {
  if (!_getDb) {
    return { today: 0, last7d: 0, last30d: 0, bySource: [], byLevel: [], recent: [] };
  }

  try {
    const db = _getDb();

    const today = (db.prepare(
      "SELECT COUNT(*) as c FROM error_log WHERE ts >= date('now')"
    ).get() as any).c;

    const last7d = (db.prepare(
      "SELECT COUNT(*) as c FROM error_log WHERE ts >= date('now', '-7 days')"
    ).get() as any).c;

    const last30d = (db.prepare(
      "SELECT COUNT(*) as c FROM error_log WHERE ts >= date('now', '-30 days')"
    ).get() as any).c;

    const bySource = db.prepare(
      "SELECT source, COUNT(*) as count FROM error_log WHERE ts >= date('now', '-7 days') GROUP BY source ORDER BY count DESC"
    ).all() as { source: string; count: number }[];

    const byLevel = db.prepare(
      "SELECT level, COUNT(*) as count FROM error_log WHERE ts >= date('now', '-7 days') GROUP BY level ORDER BY count DESC"
    ).all() as { level: string; count: number }[];

    const recent = db.prepare(
      'SELECT * FROM error_log ORDER BY ts DESC LIMIT 20'
    ).all() as ErrorLogEntry[];

    return { today, last7d, last30d, bySource, byLevel, recent };
  } catch (err) {
    logger.warn({ err }, 'Error monitor: failed to query trends');
    return { today: 0, last7d: 0, last30d: 0, bySource: [], byLevel: [], recent: [] };
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
