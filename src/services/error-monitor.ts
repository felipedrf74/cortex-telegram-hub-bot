// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Error Monitor — persistent error tracking, Telegram alerting, and trend queries.
 *
 * Captures:
 *  - Unhandled promise rejections
 *  - Uncaught exceptions
 *  - Explicit error reports from bot, jobs, and API calls
 *
 * Alerts via Telegram on critical errors (rate-limited to avoid spam).
 * Persists to SQLite for trend analysis via the portal.
 */

import { logger } from '../utils/logger';
import { pushEvent } from '../portal/telemetry';
import { captureException as sentryCaptureException, isEnabled as isSentryEnabled } from './error-tracker';

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

export function setDbProvider(fn: DbProvider): void {
  _getDb = fn;
}

// ── Telegram Alert Callback ──────────────────────────────────────

type AlertCallback = (message: string) => Promise<void>;
let _alertFn: AlertCallback | null = null;

/** Register Telegram alert sender. Called once during startup. */
export function setAlertCallback(fn: AlertCallback): void {
  _alertFn = fn;
}

// ── Rate Limiter (suppress duplicate alerts within 60s) ──────────

const _alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 60_000;

function shouldAlert(key: string): boolean {
  const last = _alertCooldowns.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  _alertCooldowns.set(key, Date.now());
  return true;
}

// ── Core: Record Error ───────────────────────────────────────────

/**
 * Record an error to the persistent log and optionally alert via Telegram.
 *
 * @param record - Error details
 * @param alert - Whether to send a Telegram alert (default: true for error/fatal)
 */
export function captureError(record: ErrorRecord, alert?: boolean): void {
  const shouldSendAlert = alert ?? (record.level !== 'warning');

  // Persist to SQLite
  let alerted = 0;
  if (_getDb) {
    try {
      const contextJson = record.context ? JSON.stringify(record.context) : null;
      _getDb().prepare(`
        INSERT INTO error_log (level, source, message, stack, context, alerted)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.level,
        record.source,
        record.message.slice(0, 2000),
        record.stack?.slice(0, 4000) ?? null,
        contextJson,
        shouldSendAlert && _alertFn ? 1 : 0,
      );
      alerted = shouldSendAlert ? 1 : 0;
    } catch (err) {
      logger.warn({ err }, 'Error monitor: failed to persist error');
    }
  }

  // Forward to Sentry (if configured)
  if (isSentryEnabled()) {
    const sentryLevel = record.level === 'fatal' ? 'fatal' : record.level === 'warning' ? 'warning' : 'error';
    sentryCaptureException(
      record.stack ? Object.assign(new Error(record.message), { stack: record.stack }) : record.message,
      {
        level: sentryLevel,
        source: record.source,
        extra: record.context,
        tags: { source: record.source, level: record.level },
      },
    );
  }

  // Push to in-memory telemetry ring buffer
  pushEvent({
    ts: new Date().toISOString(),
    type: 'error',
    summary: `[${record.source}] ${record.message.slice(0, 80)}`,
    detail: record.stack?.slice(0, 300),
  });

  // Log
  logger.error({ source: record.source, level: record.level }, record.message);

  // Send Telegram alert (rate-limited)
  if (shouldSendAlert && alerted && _alertFn) {
    const alertKey = `${record.source}:${record.message.slice(0, 100)}`;
    if (shouldAlert(alertKey)) {
      const icon = record.level === 'fatal' ? '🔴' : '🟠';
      const msg = `${icon} <b>${escapeHtml(record.level.toUpperCase())}</b> [${escapeHtml(record.source)}]\n\n<code>${escapeHtml(record.message.slice(0, 300))}</code>`;
      _alertFn(msg).catch(() => {});
    }
  }
}

// ── Process-Level Handlers ───────────────────────────────────────

let _handlersInstalled = false;

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
  });

  process.on('uncaughtException', (err: Error) => {
    captureError({
      level: 'fatal',
      source: 'process',
      message: `Uncaught exception: ${err.message}`,
      stack: err.stack,
    });
    // For uncaught exceptions, log and exit after a brief delay to allow the alert to send
    logger.fatal({ err }, 'Uncaught exception — exiting');
    setTimeout(() => process.exit(1), 2000);
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
