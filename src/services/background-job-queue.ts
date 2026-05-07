// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SQLite-backed background job queue.
 *
 * This queue is intentionally small: one table, leases, bounded retries, and
 * idempotency keys. It lets Nexus defer projections/delivery without adding
 * Redis/Kafka or making background jobs the source of truth.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { getCurrentContext } from '../utils/request-context';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { logger } from '../utils/logger';

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter' | 'canceled';

export interface JobInput {
  jobId?: string;
  tenantId: number;
  userId?: number | null;
  jobType: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  notBefore?: string | null;
  idempotencyKey: string;
  correlationId?: string | null;
  causationEventId?: string | null;
}

export interface JobRecord {
  jobId: string;
  tenantId: number;
  userId: number | null;
  jobType: string;
  payload: Record<string, unknown>;
  priority: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  notBefore: string;
  lockedAt: string | null;
  lockOwner: string | null;
  idempotencyKey: string;
  correlationId: string | null;
  causationEventId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface JobHandler {
  jobType: string;
  idempotent?: boolean;
  handle(job: JobRecord): Promise<void> | void;
}

const STALE_JOB_LEASE_MINUTES = 15;

export function ensureBackgroundJobTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_jobs (
      job_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      job_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter', 'canceled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      not_before TEXT NOT NULL DEFAULT (datetime('now')),
      locked_at TEXT,
      lock_owner TEXT,
      idempotency_key TEXT NOT NULL,
      correlation_id TEXT,
      causation_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_idempotency
      ON background_jobs(tenant_id, COALESCE(user_id, 0), job_type, idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_status_due
      ON background_jobs(status, not_before, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_background_jobs_scope_created
      ON background_jobs(tenant_id, user_id, created_at);
  `);
}

export function enqueueJob(input: JobInput, db: Database.Database = getDb()): JobRecord {
  assertJobScope(input);
  ensureBackgroundJobTables(db);
  const userScope = input.userId ?? null;
  const existing = db.prepare(`
    SELECT * FROM background_jobs
    WHERE tenant_id = ?
      AND COALESCE(user_id, 0) = COALESCE(?, 0)
      AND job_type = ?
      AND idempotency_key = ?
  `).get(input.tenantId, userScope, input.jobType, input.idempotencyKey) as any | undefined;
  if (existing) return mapJob(existing);

  const jobId = input.jobId ?? randomUUID();
  const context = getCurrentContext();
  db.prepare(`
    INSERT INTO background_jobs (
      job_id, tenant_id, user_id, job_type, payload_json, priority, max_attempts,
      not_before, idempotency_key, correlation_id, causation_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
  `).run(
    jobId,
    input.tenantId,
    userScope,
    input.jobType,
    JSON.stringify(input.payload ?? {}),
    clampInt(input.priority, 0, 100, 50),
    clampInt(input.maxAttempts, 1, 10, 3),
    input.notBefore ?? null,
    input.idempotencyKey,
    input.correlationId ?? context?.requestId ?? null,
    input.causationEventId ?? null,
  );
  return mapJob(db.prepare('SELECT * FROM background_jobs WHERE job_id = ?').get(jobId) as any);
}

export function claimPendingJobs(limit = 10, lockOwner = `worker-${process.pid}`, db: Database.Database = getDb()): JobRecord[] {
  ensureBackgroundJobTables(db);
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  return (db.prepare(`
    UPDATE background_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?,
        started_at = COALESCE(started_at, datetime('now'))
    WHERE job_id IN (
      SELECT job_id
      FROM background_jobs
      WHERE (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= datetime('now', ?)
        )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, priority ASC, created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all(lockOwner, `-${STALE_JOB_LEASE_MINUTES} minutes`, boundedLimit) as any[]).map(mapJob);
}

export async function processPendingJobs(
  handlers: JobHandler[],
  opts: { limit?: number; lockOwner?: string; db?: Database.Database; disabled?: boolean } = {},
): Promise<{ completed: number; failed: number; deadLetter: number; skipped: number }> {
  if (opts.disabled || process.env.EVENT_BACKBONE_JOBS_DISABLED === '1') {
    return { completed: 0, failed: 0, deadLetter: 0, skipped: 1 };
  }
  const db = opts.db ?? getDb();
  const startedAt = Date.now();
  const claimed = claimPendingJobs(opts.limit ?? 10, opts.lockOwner ?? `worker-${process.pid}`, db);
  const handlersByType = new Map(handlers.map((handler) => [handler.jobType, handler]));
  let completed = 0;
  let failed = 0;
  let deadLetter = 0;

  for (const job of claimed) {
    const handler = handlersByType.get(job.jobType) ?? handlersByType.get('*');
    try {
      if (handler) await handler.handle(job);
      markJobCompleted(job.jobId, db);
      completed += 1;
    } catch (err) {
      const status = markJobFailed(job.jobId, err, db);
      if (status === 'dead_letter') deadLetter += 1;
      else failed += 1;
    }
  }

  logger.info(
    {
      scope: 'background_jobs',
      claimed: claimed.length,
      completed,
      failed,
      deadLetter,
      durationMs: Date.now() - startedAt,
    },
    'background_job_batch',
  );
  return { completed, failed, deadLetter, skipped: 0 };
}

export function markJobCompleted(jobId: string, db: Database.Database = getDb()): void {
  db.prepare(`
    UPDATE background_jobs
    SET status = 'completed',
        completed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        last_error = NULL
    WHERE job_id = ?
      AND status != 'canceled'
  `).run(jobId);
}

export function markJobFailed(jobId: string, err: unknown, db: Database.Database = getDb()): JobStatus {
  const row = db.prepare('SELECT attempts, max_attempts, status FROM background_jobs WHERE job_id = ?').get(jobId) as { attempts: number; max_attempts: number; status: JobStatus } | undefined;
  if (row?.status === 'canceled') return 'canceled';
  const attempts = row?.attempts ?? 1;
  const maxAttempts = row?.max_attempts ?? 3;
  const dead = attempts >= maxAttempts;
  const baseDelaySeconds = Math.min(3600, 2 ** Math.max(0, attempts - 1) * 30);
  const delaySeconds = Math.min(3600, baseDelaySeconds + Math.floor(Math.random() * Math.max(1, baseDelaySeconds * 0.3)));
  db.prepare(`
    UPDATE background_jobs
    SET status = ?,
        not_before = datetime('now', ?),
        locked_at = NULL,
        lock_owner = NULL,
        last_error = ?
    WHERE job_id = ?
  `).run(dead ? 'dead_letter' : 'failed', dead ? '+0 seconds' : `+${delaySeconds} seconds`, safeError(err), jobId);
  if (dead) {
    logger.warn(
      { scope: 'background_jobs', jobId, attempts, maxAttempts, lastError: safeError(err) },
      'job_dead_lettered',
    );
  }
  return dead ? 'dead_letter' : 'failed';
}

export function cancelJob(jobId: string, dbOrTenantId: Database.Database | number = getDb(), maybeDb?: Database.Database): boolean {
  const tenantId = typeof dbOrTenantId === 'number' ? dbOrTenantId : null;
  const db = typeof dbOrTenantId === 'number' ? (maybeDb ?? getDb()) : dbOrTenantId;
  const tenantPredicate = tenantId ? 'AND tenant_id = ?' : '';
  const params: unknown[] = tenantId ? [jobId, tenantId] : [jobId];
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = 'canceled',
        completed_at = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL
    WHERE job_id = ?
      ${tenantPredicate}
      AND status IN ('pending', 'failed', 'processing', 'dead_letter')
  `).run(...params);
  return result.changes > 0;
}

export function listDeadLetterJobs(input: {
  tenantId: number;
  userId?: number | null;
  limit?: number;
}, db: Database.Database = getDb()): JobRecord[] {
  if (!isValidTenantUserId(input.tenantId)) throw new Error('tenantId required: must be a positive integer');
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 50), 200));
  const params: unknown[] = [input.tenantId];
  let userPredicate = '';
  if (input.userId != null) {
    if (!isValidTenantUserId(input.userId)) throw new Error('userId required: must be a positive integer when provided');
    userPredicate = 'AND user_id = ?';
    params.push(input.userId);
  }
  params.push(limit);
  ensureBackgroundJobTables(db);
  return (db.prepare(`
    SELECT * FROM background_jobs
    WHERE tenant_id = ?
      ${userPredicate}
      AND status = 'dead_letter'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(...params) as any[]).map(mapJob);
}

export function replayJob(jobId: string, tenantId: number, db: Database.Database = getDb()): boolean {
  if (!isValidTenantUserId(tenantId)) throw new Error('tenantId required: must be a positive integer');
  ensureBackgroundJobTables(db);
  const result = db.prepare(`
    UPDATE background_jobs
    SET status = 'pending',
        attempts = 0,
        not_before = datetime('now'),
        locked_at = NULL,
        lock_owner = NULL,
        completed_at = NULL,
        last_error = NULL
    WHERE job_id = ?
      AND tenant_id = ?
      AND status IN ('failed', 'dead_letter', 'canceled')
  `).run(jobId, tenantId);
  return result.changes > 0;
}

function assertJobScope(input: JobInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'background_job_enqueue',
      reason: 'invalid_user_scope',
      userId: typeof input.tenantId === 'number' ? input.tenantId : null,
      details: { jobType: input.jobType },
    });
    throw new Error('tenantId required: must be a positive integer');
  }
  if (input.userId != null && !isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'background_job_enqueue',
      reason: 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: { jobType: input.jobType },
    });
    throw new Error('userId required: must be a positive integer when provided');
  }
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value as number));
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return String(err).slice(0, 500);
}

function mapJob(row: any): JobRecord {
  return {
    jobId: row.job_id,
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    jobType: row.job_type,
    payload: parseJsonObject(row.payload_json),
    priority: Number(row.priority ?? 50),
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    notBefore: row.not_before,
    lockedAt: row.locked_at ?? null,
    lockOwner: row.lock_owner ?? null,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id ?? null,
    causationEventId: row.causation_event_id ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    lastError: row.last_error ?? null,
  };
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
