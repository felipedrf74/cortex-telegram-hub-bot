// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomBytes } from 'crypto';
import type Database from 'better-sqlite3';

export const DEFAULT_SCHEDULED_JOB_LEASE_TTL_MS = 60 * 60_000;
export const DEFAULT_SCHEDULED_JOB_LEASE_HEARTBEAT_MS = Math.floor(
  DEFAULT_SCHEDULED_JOB_LEASE_TTL_MS / 3,
);

const PROCESS_LEASE_OWNER = `scheduler:${process.pid}:${randomBytes(8).toString('hex')}`;

type ScheduledJobExecutionRow = {
  lease_token: string | null;
  lease_expires_at: string | null;
  last_succeeded_at: string | null;
};

export type ScheduledJobExecutionClaim =
  | {
    kind: 'claimed';
    jobName: string;
    scopeKey: string;
    leaseToken: string;
    leaseExpiresAt: string;
  }
  | {
    kind: 'skipped_overlap' | 'skipped_checkpoint';
    lastSucceededAt: string | null;
    leaseExpiresAt: string | null;
  };

function boundedKey(
  value: string,
  field: 'jobName' | 'scopeKey' | 'leaseOwner',
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Invalid scheduled job ${field}`);
  }
  return normalized;
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid scheduled job ${field}`);
  }
  return value;
}

/**
 * Atomically claim a scheduled execution scope.
 *
 * `minimumSuccessIntervalMs` turns the same row into a durable checkpoint:
 * even after the lease is released, a recent successful run suppresses the
 * next claim until the interval elapses. Failed runs never advance it.
 */
export function claimScheduledJobExecution(
  input: {
    jobName: string;
    scopeKey?: string;
    leaseTtlMs?: number;
    minimumSuccessIntervalMs?: number;
    leaseOwner?: string;
    now?: Date;
  },
  db: Database.Database,
): ScheduledJobExecutionClaim {
  const jobName = boundedKey(input.jobName, 'jobName', 120);
  const scopeKey = boundedKey(input.scopeKey ?? 'global', 'scopeKey', 240);
  const leaseTtlMs = positiveDuration(
    input.leaseTtlMs ?? DEFAULT_SCHEDULED_JOB_LEASE_TTL_MS,
    'leaseTtlMs',
  );
  const minimumSuccessIntervalMs = input.minimumSuccessIntervalMs ?? 0;
  if (!Number.isSafeInteger(minimumSuccessIntervalMs) || minimumSuccessIntervalMs < 0) {
    throw new Error('Invalid scheduled job minimumSuccessIntervalMs');
  }
  const leaseOwner = boundedKey(input.leaseOwner ?? PROCESS_LEASE_OWNER, 'leaseOwner', 240);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const checkpointCutoffIso = new Date(now.getTime() - minimumSuccessIntervalMs).toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
  const leaseToken = randomBytes(24).toString('hex');

  return db.transaction(() => {
    const write = db.prepare(`
      INSERT INTO scheduled_job_execution_state (
        job_name, scope_key, lease_owner, lease_token, lease_expires_at,
        last_started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_name, scope_key) DO UPDATE SET
        lease_owner = excluded.lease_owner,
        lease_token = excluded.lease_token,
        lease_expires_at = excluded.lease_expires_at,
        last_started_at = excluded.last_started_at,
        updated_at = excluded.updated_at
      WHERE (
        scheduled_job_execution_state.lease_token IS NULL
        OR scheduled_job_execution_state.lease_expires_at <= excluded.last_started_at
      )
        AND (
          scheduled_job_execution_state.last_succeeded_at IS NULL
          OR scheduled_job_execution_state.last_succeeded_at <= ?
        )
    `).run(
      jobName,
      scopeKey,
      leaseOwner,
      leaseToken,
      leaseExpiresAt,
      nowIso,
      nowIso,
      checkpointCutoffIso,
    );

    if (write.changes === 1) {
      return {
        kind: 'claimed' as const,
        jobName,
        scopeKey,
        leaseToken,
        leaseExpiresAt,
      };
    }

    const row = db.prepare(`
      SELECT lease_token, lease_expires_at, last_succeeded_at
        FROM scheduled_job_execution_state
       WHERE job_name = ? AND scope_key = ?
    `).get(jobName, scopeKey) as ScheduledJobExecutionRow | undefined;
    const activeLease = Boolean(
      row?.lease_token
      && row.lease_expires_at
      && Date.parse(row.lease_expires_at) > now.getTime(),
    );
    return {
      kind: activeLease ? 'skipped_overlap' as const : 'skipped_checkpoint' as const,
      lastSucceededAt: row?.last_succeeded_at ?? null,
      leaseExpiresAt: row?.lease_expires_at ?? null,
    };
  }).immediate();
}

/** Release a matching fenced lease and record its terminal checkpoint. */
export function completeScheduledJobExecution(
  claim: Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }>,
  result: 'success' | 'skipped' | 'failed',
  db: Database.Database,
  now: Date = new Date(),
): boolean {
  const completedAt = now.toISOString();
  const write = db.prepare(`
    UPDATE scheduled_job_execution_state
       SET lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_completed_at = ?,
           last_succeeded_at = CASE
             WHEN ? IN ('success', 'skipped') THEN ?
             ELSE last_succeeded_at
           END,
           last_result = ?,
           updated_at = ?
     WHERE job_name = ?
       AND scope_key = ?
       AND lease_token = ?
  `).run(
    completedAt,
    result,
    completedAt,
    result,
    completedAt,
    claim.jobName,
    claim.scopeKey,
    claim.leaseToken,
  );
  return write.changes === 1;
}

/** Extend only the still-current fenced lease; an expired or replaced token
 * can never be resurrected by a delayed heartbeat from an older process. */
export function renewScheduledJobExecution(
  claim: Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }>,
  db: Database.Database,
  now: Date = new Date(),
  leaseTtlMs: number = DEFAULT_SCHEDULED_JOB_LEASE_TTL_MS,
): boolean {
  const ttl = positiveDuration(leaseTtlMs, 'leaseTtlMs');
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + ttl).toISOString();
  const write = db.prepare(`
    UPDATE scheduled_job_execution_state
       SET lease_expires_at = ?, updated_at = ?
     WHERE job_name = ?
       AND scope_key = ?
       AND lease_token = ?
       AND lease_expires_at > ?
  `).run(
    leaseExpiresAt,
    nowIso,
    claim.jobName,
    claim.scopeKey,
    claim.leaseToken,
    nowIso,
  );
  return write.changes === 1;
}

/**
 * Read-only fence check for a cooperative effect boundary.
 *
 * A heartbeat proves ownership only at its own cadence. Long fan-outs also
 * call this immediately before and after each provider effect so a replaced
 * or expired token cannot continue mutating the next tenant while waiting for
 * the next timer tick.
 */
export function isScheduledJobExecutionLeaseActive(
  claim: Extract<ScheduledJobExecutionClaim, { kind: 'claimed' }>,
  db: Database.Database,
  now: Date = new Date(),
): boolean {
  const row = db.prepare(`
    SELECT 1 AS active
      FROM scheduled_job_execution_state
     WHERE job_name = ?
       AND scope_key = ?
       AND lease_token = ?
       AND lease_expires_at > ?
     LIMIT 1
  `).get(
    claim.jobName,
    claim.scopeKey,
    claim.leaseToken,
    now.toISOString(),
  ) as { active: number } | undefined;
  return row?.active === 1;
}
