// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { releaseContentScriptJobCreditsForTerminal } from './content-script-job-credits';

export interface ActiveContentScriptJobLease {
  leaseToken: string;
  controller: AbortController;
}

/** Shared by workers and account erasure without importing provider routing. */
export const activeContentScriptJobLeases = new Map<string, ActiveContentScriptJobLease>();

const ACCOUNT_DELETION_SCRIPT_DRAIN_TIMEOUT_MS = 15_000;
const ACCOUNT_DELETION_SCRIPT_DRAIN_POLL_MS = 25;

export async function waitForContentScriptJobsForAccountDeletionToDrain(
  userId: number,
  db: Database.Database = getDb(),
): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('A positive account owner id is required to drain script jobs.');
  }
  const ownedJobIds = new Set((db.prepare(`SELECT job_id FROM content_script_jobs
    WHERE owner_user_id = ?`).all(userId) as Array<{ job_id: string }>).map((row) => row.job_id));
  const deadline = Date.now() + ACCOUNT_DELETION_SCRIPT_DRAIN_TIMEOUT_MS;
  while ([...ownedJobIds].some((jobId) => activeContentScriptJobLeases.has(jobId))) {
    if (Date.now() >= deadline) {
      throw new Error('Active Content script work did not stop before account deletion.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ACCOUNT_DELETION_SCRIPT_DRAIN_POLL_MS));
  }
}

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
    db.prepare(`UPDATE content_script_provider_batches
      SET status = 'cancellation_requested', updated_at = ?
      WHERE owner_user_id = ? AND provider_batch_id IS NOT NULL
        AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')`)
      .run(timestamp, userId);
    for (const row of rows) {
      releaseContentScriptJobCreditsForTerminal({
        tenantId: row.tenant_id,
        userId,
        jobId: row.job_id,
      }, db);
    }
    return { changes: result.changes, rows };
  }).immediate();

  for (const row of cancelled.rows) {
    const activeLease = activeContentScriptJobLeases.get(row.job_id);
    if (!activeLease || activeLease.leaseToken !== row.lease_token) continue;
    activeLease.controller.abort(Object.assign(new Error('account_deleted'), {
      name: 'AbortError',
      code: 'SCRIPT_JOB_CANCELLED',
    }));
  }
  return cancelled.changes;
}
