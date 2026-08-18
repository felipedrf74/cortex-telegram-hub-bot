// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { settleContentScriptJobCredits } from './content-script-job-credits';

export interface ActiveContentScriptJobLease {
  leaseToken: string;
  controller: AbortController;
}

/** Shared by workers and account erasure without importing provider routing. */
export const activeContentScriptJobLeases = new Map<string, ActiveContentScriptJobLease>();

/**
 * Fence and abort every unfinished script operation owned by an account that
 * is about to be erased. Exact lease matching prevents an old cancellation
 * sweep from aborting a replacement worker.
 */
export function cancelContentScriptJobsForAccountDeletion(
  userId: number,
  db: Database.Database = getDb(),
): number {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('A positive account owner id is required to cancel script jobs.');
  }
  const timestamp = new Date().toISOString();
  const cancelled = db.transaction(() => {
    const rows = db.prepare(`SELECT job_id, tenant_id, lease_token
      FROM content_script_jobs
      WHERE owner_user_id = ?
        AND status IN ('queued', 'running', 'waiting_capacity')`)
      .all(userId) as Array<{ job_id: string; tenant_id: number; lease_token: string | null }>;
    if (rows.length === 0) return { changes: 0, rows };

    db.prepare(`UPDATE content_script_job_checkpoints
      SET state = 'cancelled', updated_at = ?
      WHERE state = 'generating'
        AND job_id IN (
          SELECT job_id FROM content_script_jobs
          WHERE owner_user_id = ?
            AND status IN ('queued', 'running', 'waiting_capacity')
        )`).run(timestamp, userId);
    const result = db.prepare(`UPDATE content_script_jobs
      SET status = 'cancelled', stage = 'cancelled',
          cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
          lease_token = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, updated_at = ?
      WHERE owner_user_id = ?
        AND status IN ('queued', 'running', 'waiting_capacity')`)
      .run(timestamp, timestamp, userId);
    return { changes: result.changes, rows };
  }).immediate();

  for (const row of cancelled.rows) {
    // Cancellation is a terminal transition: release each job's credit
    // reservation so account deletion never strands held credits.
    settleContentScriptJobCredits({
      tenantId: row.tenant_id,
      userId,
      jobId: row.job_id,
      outcome: 'released',
    });
    const activeLease = activeContentScriptJobLeases.get(row.job_id);
    if (!activeLease || activeLease.leaseToken !== row.lease_token) continue;
    activeLease.controller.abort(Object.assign(new Error('account_deleted'), {
      name: 'AbortError',
      code: 'SCRIPT_JOB_CANCELLED',
    }));
  }
  return cancelled.changes;
}
