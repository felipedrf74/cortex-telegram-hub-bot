// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Queue observability for the operator portal.
 *
 * Reports depth by status for the durable background job queue
 * (`background_jobs`) and the event outbox (`event_outbox`), the age of the
 * oldest pending item, and a cross-tenant dead-letter listing. Replay and
 * cancel are not implemented here: they delegate to `background-job-queue` /
 * `event-outbox`, which own state transitions and tenant scoping.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';

export type DeadLetterKind = 'jobs' | 'events';
export const DEAD_LETTER_KINDS: readonly DeadLetterKind[] = Object.freeze(['jobs', 'events']);

export interface QueueDepth {
  byStatus: Record<string, number>;
  total: number;
  /** Seconds the oldest runnable pending item has been waiting; null when the queue is empty. */
  oldestPendingAgeSec: number | null;
  deadLetter: number;
  failedLast24h: number;
  byType: { type: string; pending: number; deadLetter: number; total: number }[];
}

export interface QueueSummary {
  generatedAt: string;
  backgroundJobs: QueueDepth;
  eventOutbox: QueueDepth;
}

export interface DeadLetterItem {
  kind: 'job' | 'event';
  id: string;
  tenantId: number;
  userId: number | null;
  type: string;
  attempts: number;
  maxAttempts: number | null;
  lastError: string | null;
  createdAt: string;
  failedAt: string | null;
  correlationId: string | null;
}

const LAST_ERROR_MAX_CHARS = 500;
const BY_TYPE_LIMIT = 15;
const DEAD_LETTER_DEFAULT_LIMIT = 50;
const DEAD_LETTER_MAX_LIMIT = 200;

/** Parses SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS") or ISO-8601 into epoch ms. */
export function parseSqliteTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(hasZone ? normalized : `${normalized}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

interface StatusRow { status: string; c: number }
interface TypeRow { type: string; pending: number; deadLetter: number; total: number }

function queueDepth(
  db: Database.Database,
  table: 'background_jobs' | 'event_outbox',
  typeColumn: 'job_type' | 'event_type',
  now: number,
): QueueDepth {
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of db.prepare(`SELECT status, COUNT(*) AS c FROM ${table} GROUP BY status`).all() as StatusRow[]) {
    byStatus[row.status] = Number(row.c) || 0;
    total += Number(row.c) || 0;
  }
  const oldest = db.prepare(`SELECT MIN(not_before) AS m FROM ${table} WHERE status = 'pending'`).get() as { m: string | null } | undefined;
  const oldestMs = parseSqliteTimestamp(oldest?.m);
  const failed = db.prepare(`
    SELECT COUNT(*) AS c FROM ${table}
    WHERE status IN ('failed', 'dead_letter') AND created_at >= datetime('now', '-24 hours')
  `).get() as { c: number } | undefined;
  const byType = (db.prepare(`
    SELECT ${typeColumn} AS type,
           SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS deadLetter,
           COUNT(*) AS total
    FROM ${table}
    GROUP BY ${typeColumn}
    ORDER BY total DESC, type ASC
    LIMIT ?
  `).all(BY_TYPE_LIMIT) as TypeRow[]).map((row) => ({
    type: String(row.type),
    pending: Number(row.pending) || 0,
    deadLetter: Number(row.deadLetter) || 0,
    total: Number(row.total) || 0,
  }));
  return {
    byStatus,
    total,
    oldestPendingAgeSec: oldestMs == null ? null : Math.max(0, Math.floor((now - oldestMs) / 1000)),
    deadLetter: byStatus.dead_letter ?? 0,
    failedLast24h: Number(failed?.c) || 0,
    byType,
  };
}

export function getQueueSummary(db: Database.Database = getDb(), now = Date.now()): QueueSummary {
  return {
    generatedAt: new Date(now).toISOString(),
    backgroundJobs: queueDepth(db, 'background_jobs', 'job_type', now),
    eventOutbox: queueDepth(db, 'event_outbox', 'event_type', now),
  };
}

export function isDeadLetterKind(value: unknown): value is DeadLetterKind {
  return typeof value === 'string' && (DEAD_LETTER_KINDS as readonly string[]).includes(value);
}

interface DeadLetterRow {
  id: string;
  tenant_id: number;
  user_id: number | null;
  type: string;
  attempts: number;
  max_attempts: number | null;
  last_error: string | null;
  created_at: string;
  failed_at: string | null;
  correlation_id: string | null;
}

export function listDeadLetterItems(
  input: { kind: DeadLetterKind; limit?: number },
  db: Database.Database = getDb(),
): DeadLetterItem[] {
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? DEAD_LETTER_DEFAULT_LIMIT), DEAD_LETTER_MAX_LIMIT));
  const sql = input.kind === 'jobs'
    ? `SELECT job_id AS id, tenant_id, user_id, job_type AS type, attempts, max_attempts, last_error,
              created_at, completed_at AS failed_at, correlation_id
       FROM background_jobs WHERE status = 'dead_letter'
       ORDER BY created_at DESC, job_id DESC LIMIT ?`
    : `SELECT event_id AS id, tenant_id, user_id, event_type AS type, attempts, NULL AS max_attempts, last_error,
              created_at, processed_at AS failed_at, correlation_id
       FROM event_outbox WHERE status = 'dead_letter'
       ORDER BY sequence DESC LIMIT ?`;
  return (db.prepare(sql).all(limit) as DeadLetterRow[]).map((row) => ({
    kind: input.kind === 'jobs' ? 'job' : 'event',
    id: String(row.id),
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    type: String(row.type),
    attempts: Number(row.attempts) || 0,
    maxAttempts: row.max_attempts == null ? null : Number(row.max_attempts),
    lastError: row.last_error == null ? null : String(row.last_error).slice(0, LAST_ERROR_MAX_CHARS),
    createdAt: String(row.created_at),
    failedAt: row.failed_at == null ? null : String(row.failed_at),
    correlationId: row.correlation_id == null ? null : String(row.correlation_id),
  }));
}

/** Tenant that owns a queued item, so replay/cancel can go through the tenant-scoped services. */
export function findDeadLetterTenant(kind: DeadLetterKind, id: string, db: Database.Database = getDb()): number | null {
  const row = kind === 'jobs'
    ? db.prepare('SELECT tenant_id FROM background_jobs WHERE job_id = ? AND status = ?').get(id, 'dead_letter') as { tenant_id: number } | undefined
    : db.prepare('SELECT tenant_id FROM event_outbox WHERE event_id = ? AND status = ?').get(id, 'dead_letter') as { tenant_id: number } | undefined;
  return row ? Number(row.tenant_id) : null;
}
