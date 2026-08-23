// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  StructuredGenerationBatchControl,
  StructuredGenerationBatchState,
  StructuredGenerationBatchStatus,
} from './ai-provider';
import { logger } from '../utils/logger';

interface BatchRow {
  request_digest: string;
  custom_id: string;
  status: StructuredGenerationBatchStatus;
  input_file_id: string | null;
  provider_batch_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  last_error_code: string | null;
}

const TERMINAL_BATCH_STATUSES = new Set<StructuredGenerationBatchStatus>([
  'completed', 'cancelled', 'failed', 'expired',
]);

function immutableValue(current: string | null, next: string | undefined, field: string): string | null {
  if (current && next && current !== next) {
    throw new Error(`content_script_batch_${field}_immutable`);
  }
  return current ?? next ?? null;
}

function mapBatchState(row: BatchRow): StructuredGenerationBatchState {
  return {
    requestDigest: row.request_digest,
    customId: row.custom_id,
    status: row.status,
    ...(row.input_file_id ? { inputFileId: row.input_file_id } : {}),
    ...(row.provider_batch_id ? { providerBatchId: row.provider_batch_id } : {}),
    ...(row.output_file_id ? { outputFileId: row.output_file_id } : {}),
    ...(row.error_file_id ? { errorFileId: row.error_file_id } : {}),
    ...(row.last_error_code ? { errorCode: row.last_error_code } : {}),
  };
}

export function contentScriptBatchStageKey(input: {
  jobId: string;
  tenantId: number;
  userId: number;
  taskType: string;
  prompt: string;
  schemaId: string;
  outputSchema?: unknown;
}): string {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createContentScriptBatchControl(input: {
  db: Database.Database;
  jobId: string;
  tenantId: number;
  userId: number;
  leaseToken: string;
  stageKey: string;
}): StructuredGenerationBatchControl {
  const load = (): StructuredGenerationBatchState | null => {
    const row = input.db.prepare(`SELECT request_digest, custom_id, status,
        input_file_id, provider_batch_id, output_file_id, error_file_id, last_error_code
      FROM content_script_provider_batches
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
      .get(input.jobId, input.tenantId, input.userId, input.stageKey) as BatchRow | undefined;
    return row ? mapBatchState(row) : null;
  };

  const persist = (state: StructuredGenerationBatchState): void => {
    input.db.transaction(() => {
      const parent = input.db.prepare(`SELECT status, lease_token, cancellation_requested_at
        FROM content_script_jobs
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?`)
        .get(input.jobId, input.tenantId, input.userId) as {
          status: string;
          lease_token: string | null;
          cancellation_requested_at: string | null;
        } | undefined;
      if (!parent) throw new Error('content_script_batch_scope_invalid');
      const owned = parent.status === 'running' && parent.lease_token === input.leaseToken;
      const cancellationUpdate = parent.cancellation_requested_at !== null
        && ['cancellation_requested', 'cancelling', 'cancelled'].includes(state.status);
      if (!owned && !cancellationUpdate) throw new Error('content_script_batch_lease_lost');

      const existing = input.db.prepare(`SELECT request_digest, custom_id, status,
          input_file_id, provider_batch_id, output_file_id, error_file_id, last_error_code
        FROM content_script_provider_batches
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
        .get(input.jobId, input.tenantId, input.userId, input.stageKey) as BatchRow | undefined;
      const now = new Date().toISOString();
      if (!existing) {
        input.db.prepare(`INSERT INTO content_script_provider_batches (
            job_id, tenant_id, owner_user_id, stage_key, request_digest,
            custom_id, input_file_id, provider_batch_id, status,
            output_file_id, error_file_id, last_error_code, submitted_at,
            completed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.jobId,
            input.tenantId,
            input.userId,
            input.stageKey,
            state.requestDigest,
            state.customId,
            state.inputFileId ?? null,
            state.providerBatchId ?? null,
            state.status,
            state.outputFileId ?? null,
            state.errorFileId ?? null,
            state.errorCode ?? null,
            state.providerBatchId ? now : null,
            TERMINAL_BATCH_STATUSES.has(state.status) ? now : null,
            now,
          );
        return;
      }
      if (existing.request_digest !== state.requestDigest || existing.custom_id !== state.customId) {
        throw new Error('content_script_batch_request_identity_mismatch');
      }
      if (TERMINAL_BATCH_STATUSES.has(existing.status) && existing.status !== state.status) {
        throw new Error('content_script_batch_terminal_state_immutable');
      }
      const inputFileId = immutableValue(existing.input_file_id, state.inputFileId, 'input_file_id');
      const providerBatchId = immutableValue(existing.provider_batch_id, state.providerBatchId, 'provider_batch_id');
      const outputFileId = immutableValue(existing.output_file_id, state.outputFileId, 'output_file_id');
      const errorFileId = immutableValue(existing.error_file_id, state.errorFileId, 'error_file_id');
      input.db.prepare(`UPDATE content_script_provider_batches
        SET input_file_id = ?, provider_batch_id = ?, status = ?,
            output_file_id = ?, error_file_id = ?, last_error_code = ?,
            submitted_at = CASE WHEN ? IS NOT NULL THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
            completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END,
            updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
        .run(
          inputFileId,
          providerBatchId,
          state.status,
          outputFileId,
          errorFileId,
          state.errorCode ?? null,
          providerBatchId,
          now,
          TERMINAL_BATCH_STATUSES.has(state.status) ? 1 : 0,
          now,
          now,
          input.jobId,
          input.tenantId,
          input.userId,
          input.stageKey,
        );
    }).immediate();
  };

  return { stageKey: input.stageKey, load, persist };
}

export function markContentScriptBatchesCancellationRequested(
  db: Database.Database,
  input: { jobId: string; tenantId: number; userId: number; timestamp: string },
): number {
  return db.prepare(`UPDATE content_script_provider_batches
    SET status = 'cancellation_requested', updated_at = ?
    WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?
      AND provider_batch_id IS NOT NULL
      AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')`)
    .run(input.timestamp, input.jobId, input.tenantId, input.userId).changes;
}

const cancellationReconciliationInFlight = new WeakSet<Database.Database>();

/**
 * Resume provider cancellation after process loss. The parent job is already
 * durably cancelled; this loop only settles external provider state and
 * exactly-once usage for a request that completed during cancellation.
 */
export function requestContentScriptBatchCancellationReconciliation(db: Database.Database): void {
  if (cancellationReconciliationInFlight.has(db)) return;
  const count = (db.prepare(`SELECT COUNT(*) AS count
    FROM content_script_provider_batches
    WHERE status IN ('cancellation_requested', 'cancelling')`)
    .get() as { count: number }).count;
  if (count === 0) return;
  cancellationReconciliationInFlight.add(db);
  setImmediate(() => {
    void (async () => {
      try {
        const { getProvider } = await import('./provider-registry');
        const provider = getProvider('openai');
        if (!provider?.cancelStructuredGenerationBatch) {
          throw new Error('openai_batch_cancellation_capability_unavailable');
        }
        const rows = db.prepare(`SELECT job_id, tenant_id, owner_user_id, stage_key,
            custom_id, provider_batch_id
          FROM content_script_provider_batches
          WHERE status IN ('cancellation_requested', 'cancelling')
            AND provider_batch_id IS NOT NULL
          ORDER BY updated_at ASC
          LIMIT 20`).all() as Array<{
            job_id: string;
            tenant_id: number;
            owner_user_id: number;
            stage_key: string;
            custom_id: string;
            provider_batch_id: string;
          }>;
        for (const row of rows) {
          try {
            const result = await provider.cancelStructuredGenerationBatch({
              providerBatchId: row.provider_batch_id,
              customId: row.custom_id,
              userId: row.owner_user_id,
              tenantId: row.tenant_id,
              category: 'cloud_local_reasoning',
            });
            db.prepare(`UPDATE content_script_provider_batches
              SET status = ?, output_file_id = COALESCE(output_file_id, ?),
                  error_file_id = COALESCE(error_file_id, ?), last_error_code = ?,
                  completed_at = CASE WHEN ? IN ('completed', 'cancelled', 'failed', 'expired')
                    THEN COALESCE(completed_at, ?) ELSE completed_at END,
                  updated_at = ?
              WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
                AND provider_batch_id = ?
                AND status IN ('cancellation_requested', 'cancelling')`)
              .run(
                result.status,
                result.outputFileId ?? null,
                result.errorFileId ?? null,
                result.errorCode ?? null,
                result.status,
                new Date().toISOString(),
                new Date().toISOString(),
                row.job_id,
                row.tenant_id,
                row.owner_user_id,
                row.stage_key,
                row.provider_batch_id,
              );
          } catch (error) {
            logger.warn({
              providerBatchId: row.provider_batch_id,
              errorName: error instanceof Error ? error.name : typeof error,
            }, 'OpenAI Batch cancellation reconciliation remains pending');
          }
        }
      } catch (error) {
        logger.warn({
          errorName: error instanceof Error ? error.name : typeof error,
        }, 'OpenAI Batch cancellation reconciliation could not start');
      } finally {
        cancellationReconciliationInFlight.delete(db);
      }
    })();
  });
}

/**
 * Delete OpenAI input/output files only after the plan's 30-day private-job
 * recovery window. Terminal database identity and exactly-once usage evidence
 * remain available without retaining prompt or result bytes at the provider.
 */
export async function pruneExpiredContentScriptBatchFiles(
  db: Database.Database,
  input: { now?: Date; retentionDays?: number; limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const now = input.now ?? new Date();
  const retentionDays = Math.max(1, Math.min(365, Math.floor(input.retentionDays ?? 30)));
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const rows = db.prepare(`SELECT job_id, tenant_id, owner_user_id, stage_key,
      provider_batch_id, input_file_id, output_file_id, error_file_id
    FROM content_script_provider_batches
    WHERE status IN ('completed', 'cancelled', 'failed', 'expired')
      AND completed_at IS NOT NULL AND completed_at <= ?
      AND provider_files_deleted_at IS NULL
    ORDER BY completed_at, job_id, stage_key
    LIMIT ?`).all(cutoff, limit) as Array<{
      job_id: string;
      tenant_id: number;
      owner_user_id: number;
      stage_key: string;
      provider_batch_id: string;
      input_file_id: string | null;
      output_file_id: string | null;
      error_file_id: string | null;
    }>;
  if (rows.length === 0) return { deleted: 0, failed: 0 };

  const { getProvider } = await import('./provider-registry');
  const provider = getProvider('openai');
  if (!provider?.deleteStructuredGenerationBatchFiles) {
    logger.warn('OpenAI Batch file cleanup capability is unavailable');
    return { deleted: 0, failed: rows.length };
  }

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await provider.deleteStructuredGenerationBatchFiles({
        providerBatchId: row.provider_batch_id,
        fileIds: [row.input_file_id, row.error_file_id, row.output_file_id]
          .filter((value): value is string => Boolean(value)),
      });
      deleted += db.prepare(`UPDATE content_script_provider_batches
        SET provider_files_deleted_at = ?, updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_batch_id = ? AND provider_files_deleted_at IS NULL`)
        .run(
          now.toISOString(),
          now.toISOString(),
          row.job_id,
          row.tenant_id,
          row.owner_user_id,
          row.stage_key,
          row.provider_batch_id,
        ).changes;
    } catch (error) {
      failed += 1;
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'OpenAI Batch provider-file retention cleanup remains pending');
    }
  }
  return { deleted, failed };
}
