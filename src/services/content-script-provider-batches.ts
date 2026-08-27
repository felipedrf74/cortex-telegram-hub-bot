// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AIProvider,
  StructuredGenerationBatchControl,
  StructuredGenerationBatchState,
  StructuredGenerationBatchStatus,
} from './ai-provider';
import { logger } from '../utils/logger';

interface BatchRow {
  request_digest: string;
  custom_id: string;
  status: StructuredGenerationBatchStatus;
  input_file_intent_filename: string | null;
  input_file_intent_at: string | null;
  input_file_intent_absence_count: number;
  input_file_intent_absence_observed_at: string | null;
  input_file_intent_absence_confirmed_at: string | null;
  batch_create_intent_at: string | null;
  batch_create_intent_absence_count: number;
  batch_create_intent_absence_observed_at: string | null;
  batch_create_intent_absence_confirmed_at: string | null;
  input_file_id: string | null;
  provider_batch_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
  last_error_code: string | null;
}

const TERMINAL_BATCH_STATUSES = new Set<StructuredGenerationBatchStatus>([
  'completed', 'cancelled', 'failed', 'expired',
]);
const BATCH_FILE_CLEANUP_CLAIM_STALE_MS = 15 * 60 * 1_000;
const BATCH_INTENT_PROVIDER_VISIBILITY_GRACE_MS = 15 * 60 * 1_000;
const BATCH_INTENT_ABSENCE_RECHECK_MS = 60 * 1_000;

interface BatchIntentRow {
  job_id: string;
  tenant_id: number;
  owner_user_id: number;
  stage_key: string;
  request_digest: string;
  custom_id: string;
  status: StructuredGenerationBatchStatus;
  input_file_intent_filename: string | null;
  input_file_intent_at: string | null;
  input_file_intent_absence_count: number;
  input_file_intent_absence_observed_at: string | null;
  input_file_intent_absence_confirmed_at: string | null;
  batch_create_intent_at: string | null;
  batch_create_intent_absence_count: number;
  batch_create_intent_absence_observed_at: string | null;
  batch_create_intent_absence_confirmed_at: string | null;
  input_file_id: string | null;
  provider_batch_id: string | null;
  output_file_id: string | null;
  error_file_id: string | null;
}

interface IntentAbsenceState {
  count: number;
  observedAt: string | null;
  confirmedAt: string | null;
}

function observeIndependentProviderAbsence(input: {
  intentAt: string | null;
  count: number;
  observedAt: string | null;
  confirmedAt: string | null;
  now: Date;
}): IntentAbsenceState {
  if (input.confirmedAt) {
    return { count: input.count, observedAt: input.observedAt, confirmedAt: input.confirmedAt };
  }
  const intentMs = input.intentAt ? Date.parse(input.intentAt) : Number.NaN;
  const observedMs = input.observedAt ? Date.parse(input.observedAt) : Number.NaN;
  if (!Number.isFinite(intentMs)
      || !Number.isSafeInteger(input.count) || input.count < 0
      || (input.observedAt !== null && !Number.isFinite(observedMs))) {
    throw new Error('content_script_batch_intent_absence_state_invalid');
  }
  const independentlyObserved = input.observedAt === null
    || input.now.getTime() - observedMs >= BATCH_INTENT_ABSENCE_RECHECK_MS;
  if (!independentlyObserved) {
    return { count: input.count, observedAt: input.observedAt, confirmedAt: null };
  }
  const count = input.count + 1;
  const observedAt = input.now.toISOString();
  const graceElapsed = input.now.getTime() - intentMs >= BATCH_INTENT_PROVIDER_VISIBILITY_GRACE_MS;
  return {
    count,
    observedAt,
    confirmedAt: graceElapsed && count >= 2 ? observedAt : null,
  };
}

export function hasContentScriptProviderFileCleanupFence(
  db: Database.Database,
  input: { jobId: string; tenantId: number; userId: number },
): boolean {
  return Boolean(db.prepare(`SELECT 1
    FROM content_script_provider_batches
    WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?
      AND (provider_files_cleanup_started_at IS NOT NULL
        OR provider_files_deleted_at IS NOT NULL)
    LIMIT 1`).get(input.jobId, input.tenantId, input.userId));
}

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
    ...(row.input_file_intent_filename
      ? { inputFileIntentFilename: row.input_file_intent_filename }
      : {}),
    ...(row.batch_create_intent_at ? { batchCreateIntent: true } : {}),
    ...(row.input_file_intent_absence_confirmed_at
      ? { inputFileIntentAbsenceConfirmed: true }
      : {}),
    ...(row.batch_create_intent_absence_confirmed_at
      ? { batchCreateIntentAbsenceConfirmed: true }
      : {}),
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
  generationAttempt: number;
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
    if (hasContentScriptProviderFileCleanupFence(input.db, input)) {
      throw new Error('content_script_batch_private_material_cleanup_started');
    }
    const row = input.db.prepare(`SELECT request_digest, custom_id, status,
        input_file_intent_filename, input_file_intent_at,
        input_file_intent_absence_count, input_file_intent_absence_observed_at,
        input_file_intent_absence_confirmed_at,
        batch_create_intent_at, batch_create_intent_absence_count,
        batch_create_intent_absence_observed_at, batch_create_intent_absence_confirmed_at,
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
      // A cancelled worker may still return from a provider upload/create call.
      // Persist its immutable provider identities so account deletion and the
      // cancellation reconciler can clean them instead of orphaning remote data.
      const cancellationUpdate = parent.cancellation_requested_at !== null
        && (state.inputFileId !== undefined
          || state.providerBatchId !== undefined
          || state.outputFileId !== undefined
          || state.errorFileId !== undefined
          || ['cancellation_requested', 'cancelling', 'cancelled'].includes(state.status));
      if (!owned && !cancellationUpdate) throw new Error('content_script_batch_lease_lost');
      // The cleanup fence is job-wide: once any stage begins remote deletion,
      // no late worker may persist a new stage or provider identifier for the
      // same parent after the cleanup snapshot was claimed.
      if (hasContentScriptProviderFileCleanupFence(input.db, input)) {
        throw new Error('content_script_batch_private_material_cleanup_started');
      }

      const existing = input.db.prepare(`SELECT request_digest, custom_id, status,
          input_file_intent_filename, input_file_intent_at,
          input_file_intent_absence_count, input_file_intent_absence_observed_at,
          input_file_intent_absence_confirmed_at,
          batch_create_intent_at, batch_create_intent_absence_count,
          batch_create_intent_absence_observed_at, batch_create_intent_absence_confirmed_at,
          input_file_id, provider_batch_id, output_file_id, error_file_id, last_error_code
        FROM content_script_provider_batches
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
        .get(input.jobId, input.tenantId, input.userId, input.stageKey) as BatchRow | undefined;
      const now = new Date().toISOString();
      const expectedIntentFilename = `${input.stageKey}.jsonl`;
      if ((state.inputFileIntentFilename || state.batchCreateIntent)
          && state.customId !== input.stageKey) {
        throw new Error('content_script_batch_intent_stage_identity_mismatch');
      }
      if (state.inputFileIntentFilename
          && state.inputFileIntentFilename !== expectedIntentFilename) {
        throw new Error('content_script_batch_file_intent_identity_mismatch');
      }
      if (!existing) {
        if (state.batchCreateIntent && !state.inputFileId) {
          throw new Error('content_script_batch_create_intent_input_missing');
        }
        input.db.prepare(`INSERT INTO content_script_provider_batches (
            job_id, tenant_id, owner_user_id, stage_key, request_digest,
            custom_id, input_file_intent_filename, input_file_intent_at,
            batch_create_intent_at, input_file_id, provider_batch_id, status,
            output_file_id, error_file_id, last_error_code, submitted_at,
            completed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.jobId,
            input.tenantId,
            input.userId,
            input.stageKey,
            state.requestDigest,
            state.customId,
            state.inputFileIntentFilename ?? null,
            state.inputFileIntentFilename ? now : null,
            state.batchCreateIntent ? now : null,
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
      const inputFileIntentFilename = immutableValue(
        existing.input_file_intent_filename,
        state.inputFileIntentFilename,
        'input_file_intent_filename',
      );
      const inputFileId = immutableValue(existing.input_file_id, state.inputFileId, 'input_file_id');
      if ((existing.batch_create_intent_at || state.batchCreateIntent) && !inputFileId) {
        throw new Error('content_script_batch_create_intent_input_missing');
      }
      const providerBatchId = immutableValue(existing.provider_batch_id, state.providerBatchId, 'provider_batch_id');
      const outputFileId = immutableValue(existing.output_file_id, state.outputFileId, 'output_file_id');
      const errorFileId = immutableValue(existing.error_file_id, state.errorFileId, 'error_file_id');
      input.db.prepare(`UPDATE content_script_provider_batches
        SET input_file_intent_filename = ?,
            input_file_intent_at = CASE WHEN ? IS NOT NULL
              THEN COALESCE(input_file_intent_at, ?) ELSE input_file_intent_at END,
            batch_create_intent_at = CASE WHEN ? = 1
              THEN COALESCE(batch_create_intent_at, ?) ELSE batch_create_intent_at END,
            input_file_id = ?, provider_batch_id = ?, status = ?,
            output_file_id = ?, error_file_id = ?, last_error_code = ?,
            submitted_at = CASE WHEN ? IS NOT NULL THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
            completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE completed_at END,
            updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
        .run(
          inputFileIntentFilename,
          inputFileIntentFilename,
          now,
          state.batchCreateIntent ? 1 : 0,
          now,
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

  const observeIntentAbsence = (
    intent: 'input_file' | 'batch_create',
  ): { state: StructuredGenerationBatchState; mutationAuthorized: boolean } => input.db.transaction(() => {
    const parent = input.db.prepare(`SELECT status, lease_token, cancellation_requested_at
      FROM content_script_jobs
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ?`)
      .get(input.jobId, input.tenantId, input.userId) as {
        status: string;
        lease_token: string | null;
        cancellation_requested_at: string | null;
      } | undefined;
    if (!parent || parent.status !== 'running' || parent.lease_token !== input.leaseToken
        || parent.cancellation_requested_at !== null) {
      throw new Error('content_script_batch_intent_absence_lease_lost');
    }
    if (hasContentScriptProviderFileCleanupFence(input.db, input)) {
      throw new Error('content_script_batch_private_material_cleanup_started');
    }
    const selectRow = (): BatchRow | undefined => input.db.prepare(`SELECT
        request_digest, custom_id, status,
        input_file_intent_filename, input_file_intent_at,
        input_file_intent_absence_count, input_file_intent_absence_observed_at,
        input_file_intent_absence_confirmed_at,
        batch_create_intent_at, batch_create_intent_absence_count,
        batch_create_intent_absence_observed_at, batch_create_intent_absence_confirmed_at,
        input_file_id, provider_batch_id, output_file_id, error_file_id, last_error_code
      FROM content_script_provider_batches
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?`)
      .get(input.jobId, input.tenantId, input.userId, input.stageKey) as BatchRow | undefined;
    const row = selectRow();
    if (!row) throw new Error('content_script_batch_intent_absence_state_missing');
    const observedAt = new Date();
    const observedAtIso = observedAt.toISOString();
    let mutationAuthorized = false;
    if (intent === 'input_file') {
      if (row.input_file_id) {
        return { state: mapBatchState(row), mutationAuthorized: false };
      }
      if (!row.input_file_intent_filename || !row.input_file_intent_at) {
        throw new Error('content_script_batch_file_intent_missing');
      }
      const absence = observeIndependentProviderAbsence({
        intentAt: row.input_file_intent_at,
        count: row.input_file_intent_absence_count,
        observedAt: row.input_file_intent_absence_observed_at,
        confirmedAt: row.input_file_intent_absence_confirmed_at,
        now: observedAt,
      });
      mutationAuthorized = absence.confirmedAt !== null;
      const changed = input.db.prepare(`UPDATE content_script_provider_batches
        SET input_file_intent_at = ?, input_file_intent_absence_count = ?,
          input_file_intent_absence_observed_at = ?,
          input_file_intent_absence_confirmed_at = ?, updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND input_file_id IS NULL
          AND input_file_intent_absence_count = ?
          AND input_file_intent_absence_observed_at IS ?
          AND input_file_intent_absence_confirmed_at IS ?`)
        .run(
          mutationAuthorized ? observedAtIso : row.input_file_intent_at,
          mutationAuthorized ? 0 : absence.count,
          mutationAuthorized ? null : absence.observedAt,
          mutationAuthorized ? null : absence.confirmedAt,
          observedAtIso,
          input.jobId,
          input.tenantId,
          input.userId,
          input.stageKey,
          row.input_file_intent_absence_count,
          row.input_file_intent_absence_observed_at,
          row.input_file_intent_absence_confirmed_at,
        ).changes;
      if (changed !== 1) throw new Error('content_script_batch_file_intent_absence_race');
    } else {
      if (row.provider_batch_id) {
        return { state: mapBatchState(row), mutationAuthorized: false };
      }
      if (!row.batch_create_intent_at || !row.input_file_id) {
        throw new Error('content_script_batch_create_intent_missing');
      }
      const absence = observeIndependentProviderAbsence({
        intentAt: row.batch_create_intent_at,
        count: row.batch_create_intent_absence_count,
        observedAt: row.batch_create_intent_absence_observed_at,
        confirmedAt: row.batch_create_intent_absence_confirmed_at,
        now: observedAt,
      });
      mutationAuthorized = absence.confirmedAt !== null;
      const changed = input.db.prepare(`UPDATE content_script_provider_batches
        SET batch_create_intent_at = ?, batch_create_intent_absence_count = ?,
          batch_create_intent_absence_observed_at = ?,
          batch_create_intent_absence_confirmed_at = ?, updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_batch_id IS NULL
          AND batch_create_intent_absence_count = ?
          AND batch_create_intent_absence_observed_at IS ?
          AND batch_create_intent_absence_confirmed_at IS ?`)
        .run(
          mutationAuthorized ? observedAtIso : row.batch_create_intent_at,
          mutationAuthorized ? 0 : absence.count,
          mutationAuthorized ? null : absence.observedAt,
          mutationAuthorized ? null : absence.confirmedAt,
          observedAtIso,
          input.jobId,
          input.tenantId,
          input.userId,
          input.stageKey,
          row.batch_create_intent_absence_count,
          row.batch_create_intent_absence_observed_at,
          row.batch_create_intent_absence_confirmed_at,
        ).changes;
      if (changed !== 1) throw new Error('content_script_batch_create_intent_absence_race');
    }
    const updated = selectRow();
    if (!updated) throw new Error('content_script_batch_intent_absence_state_missing');
    return { state: mapBatchState(updated), mutationAuthorized };
  }).immediate();

  return { stageKey: input.stageKey, load, persist, observeIntentAbsence };
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

function markTerminalParentBatchesCancellationRequested(
  db: Database.Database,
  timestamp = new Date().toISOString(),
): number {
  return db.prepare(`UPDATE content_script_provider_batches
    SET status = 'cancellation_requested', updated_at = ?
    WHERE provider_batch_id IS NOT NULL
      AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')
      AND EXISTS (
        SELECT 1 FROM content_script_jobs AS job
        WHERE job.job_id = content_script_provider_batches.job_id
          AND job.tenant_id = content_script_provider_batches.tenant_id
          AND job.owner_user_id = content_script_provider_batches.owner_user_id
          AND job.status IN ('completed', 'failed', 'cancelled')
      )`).run(timestamp).changes;
}

/**
 * Resume provider cancellation after process loss. The parent job is already
 * durably cancelled; this loop only settles external provider state and
 * exactly-once usage for a request that completed during cancellation.
 */
export function requestContentScriptBatchCancellationReconciliation(db: Database.Database): void {
  if (cancellationReconciliationInFlight.has(db)) return;
  // Backfill terminal parents that predate the terminal-transition hooks. The
  // durable state change makes an old active provider object visible to the
  // same restart-safe cancellation reconciler as new failures/cancellations.
  markTerminalParentBatchesCancellationRequested(db);
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

async function reconcileClaimedContentScriptBatchIntent(input: {
  db: Database.Database;
  provider: AIProvider;
  row: BatchIntentRow;
  now: Date;
}): Promise<{ absencePending: boolean; deletionProven: boolean; recoveredActive: boolean }> {
  if (!input.provider.reconcileStructuredGenerationBatchIntent) {
    throw new Error('content_script_batch_intent_reconciliation_unavailable');
  }
  const claim = crypto.randomUUID();
  const timestamp = input.now.toISOString();
  const staleClaimCutoff = new Date(
    input.now.getTime() - BATCH_FILE_CLEANUP_CLAIM_STALE_MS,
  ).toISOString();
  const claimed = input.db.prepare(`UPDATE content_script_provider_batches
    SET provider_files_cleanup_started_at = COALESCE(provider_files_cleanup_started_at, ?),
      provider_files_cleanup_claim = ?, provider_files_cleanup_claimed_at = ?, updated_at = ?
    WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
      AND input_file_id IS ? AND provider_batch_id IS ?
      AND provider_files_deleted_at IS NULL
      AND (provider_files_cleanup_claim IS NULL
        OR julianday(provider_files_cleanup_claimed_at) <= julianday(?))`)
    .run(
      timestamp,
      claim,
      timestamp,
      timestamp,
      input.row.job_id,
      input.row.tenant_id,
      input.row.owner_user_id,
      input.row.stage_key,
      input.row.input_file_id,
      input.row.provider_batch_id,
      staleClaimCutoff,
    ).changes;
  if (claimed !== 1) throw new Error('content_script_batch_intent_reconciliation_claimed');

  try {
    const recovered = await input.provider.reconcileStructuredGenerationBatchIntent({
      stageKey: input.row.stage_key,
      requestDigest: input.row.request_digest,
      customId: input.row.custom_id,
      ...(input.row.input_file_intent_filename
        ? { inputFileIntentFilename: input.row.input_file_intent_filename }
        : {}),
      ...(input.row.batch_create_intent_at ? { batchCreateIntent: true } : {}),
      ...(input.row.input_file_id ? { inputFileId: input.row.input_file_id } : {}),
    });
    if (recovered.providerBatchId && !recovered.status) {
      throw new Error('content_script_batch_intent_status_missing');
    }
    const inputFileId = input.row.input_file_id ?? recovered.inputFileId ?? null;
    const providerBatchId = input.row.provider_batch_id ?? recovered.providerBatchId ?? null;
    const outputFileId = input.row.output_file_id ?? recovered.outputFileId ?? null;
    const errorFileId = input.row.error_file_id ?? recovered.errorFileId ?? null;
    const status = recovered.status ?? input.row.status;

    let fileAbsence: IntentAbsenceState = {
      count: input.row.input_file_intent_absence_count,
      observedAt: input.row.input_file_intent_absence_observed_at,
      confirmedAt: input.row.input_file_intent_absence_confirmed_at,
    };
    if (recovered.inputFileId) {
      fileAbsence = { count: 0, observedAt: null, confirmedAt: null };
    } else if (input.row.input_file_intent_filename && !inputFileId
        && !fileAbsence.confirmedAt) {
      fileAbsence = observeIndependentProviderAbsence({
        intentAt: input.row.input_file_intent_at,
        ...fileAbsence,
        now: input.now,
      });
    }

    let batchAbsence: IntentAbsenceState = {
      count: input.row.batch_create_intent_absence_count,
      observedAt: input.row.batch_create_intent_absence_observed_at,
      confirmedAt: input.row.batch_create_intent_absence_confirmed_at,
    };
    if (recovered.providerBatchId) {
      batchAbsence = { count: 0, observedAt: null, confirmedAt: null };
    } else if (input.row.batch_create_intent_at && !providerBatchId
        && !batchAbsence.confirmedAt) {
      batchAbsence = observeIndependentProviderAbsence({
        intentAt: input.row.batch_create_intent_at,
        ...batchAbsence,
        now: input.now,
      });
    }

    const fileIntentSettled = !input.row.input_file_intent_filename
      || Boolean(inputFileId) || Boolean(fileAbsence.confirmedAt);
    const batchIntentSettled = !input.row.batch_create_intent_at
      || Boolean(providerBatchId) || Boolean(batchAbsence.confirmedAt);
    const deletionProven = !inputFileId && !providerBatchId && !outputFileId && !errorFileId
      && fileIntentSettled && batchIntentSettled;
    const absencePending = Boolean(
      (input.row.input_file_intent_filename && !inputFileId && !fileAbsence.confirmedAt)
      || (input.row.batch_create_intent_at && !providerBatchId && !batchAbsence.confirmedAt),
    );
    const updated = input.db.prepare(`UPDATE content_script_provider_batches
      SET input_file_id = ?, provider_batch_id = ?, status = ?,
        output_file_id = ?, error_file_id = ?,
        last_error_code = COALESCE(?, last_error_code),
        input_file_intent_absence_count = ?,
        input_file_intent_absence_observed_at = ?,
        input_file_intent_absence_confirmed_at = ?,
        batch_create_intent_absence_count = ?,
        batch_create_intent_absence_observed_at = ?,
        batch_create_intent_absence_confirmed_at = ?,
        submitted_at = CASE WHEN ? IS NOT NULL THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
        completed_at = CASE WHEN ? IN ('completed', 'cancelled', 'failed', 'expired')
          THEN COALESCE(completed_at, ?) ELSE completed_at END,
        provider_files_deleted_at = CASE WHEN ? = 1
          THEN COALESCE(provider_files_deleted_at, ?) ELSE provider_files_deleted_at END,
        provider_files_cleanup_claim = NULL,
        provider_files_cleanup_claimed_at = NULL,
        updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
        AND provider_files_cleanup_claim = ? AND provider_files_deleted_at IS NULL`)
      .run(
        inputFileId,
        providerBatchId,
        status,
        outputFileId,
        errorFileId,
        recovered.errorCode ?? null,
        fileAbsence.count,
        fileAbsence.observedAt,
        fileAbsence.confirmedAt,
        batchAbsence.count,
        batchAbsence.observedAt,
        batchAbsence.confirmedAt,
        providerBatchId,
        timestamp,
        status,
        timestamp,
        deletionProven ? 1 : 0,
        timestamp,
        timestamp,
        input.row.job_id,
        input.row.tenant_id,
        input.row.owner_user_id,
        input.row.stage_key,
        claim,
      ).changes;
    if (updated !== 1) throw new Error('content_script_batch_intent_reconciliation_race');
    return {
      absencePending,
      deletionProven,
      recoveredActive: Boolean(providerBatchId && !TERMINAL_BATCH_STATUSES.has(status)),
    };
  } catch (error) {
    input.db.prepare(`UPDATE content_script_provider_batches
      SET provider_files_cleanup_claim = NULL, provider_files_cleanup_claimed_at = NULL
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
        AND provider_files_cleanup_claim = ?`)
      .run(
        input.row.job_id,
        input.row.tenant_id,
        input.row.owner_user_id,
        input.row.stage_key,
        claim,
      );
    throw error;
  }
}

/**
 * Account erasure is stricter than age-based retention: cancel every owned
 * provider Batch and prove deletion of every known provider file before local
 * Batch identity may be erased. Any provider refusal fails the deletion request
 * closed so a later retry can resume from the durable identifiers.
 */
export async function cleanupContentScriptProviderFilesForAccountDeletion(
  db: Database.Database,
  userId: number,
  input: { now?: Date } = {},
): Promise<number> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('content_script_account_cleanup_user_invalid');
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('content_script_account_cleanup_now_invalid');
  const pending = (db.prepare(`SELECT COUNT(*) AS count
    FROM content_script_provider_batches
    WHERE owner_user_id = ? AND provider_files_deleted_at IS NULL
      AND (provider_batch_id IS NOT NULL OR input_file_id IS NOT NULL
        OR output_file_id IS NOT NULL OR error_file_id IS NOT NULL
        OR input_file_intent_filename IS NOT NULL
        OR batch_create_intent_at IS NOT NULL)`)
    .get(userId) as { count: number }).count;
  if (pending === 0) return 0;
  const { getProvider } = await import('./provider-registry');
  const provider = getProvider('openai');
  const intents = db.prepare(`SELECT job_id, tenant_id, owner_user_id, stage_key,
      request_digest, custom_id, status,
      input_file_intent_filename, input_file_intent_at,
      input_file_intent_absence_count, input_file_intent_absence_observed_at,
      input_file_intent_absence_confirmed_at,
      batch_create_intent_at, batch_create_intent_absence_count,
      batch_create_intent_absence_observed_at,
      batch_create_intent_absence_confirmed_at,
      input_file_id, provider_batch_id, output_file_id, error_file_id
    FROM content_script_provider_batches
    WHERE owner_user_id = ? AND provider_files_deleted_at IS NULL
      AND ((input_file_intent_filename IS NOT NULL AND input_file_id IS NULL
            AND input_file_intent_absence_confirmed_at IS NULL)
        OR (batch_create_intent_at IS NOT NULL AND provider_batch_id IS NULL
            AND batch_create_intent_absence_confirmed_at IS NULL))
    ORDER BY updated_at, job_id, stage_key`).all(userId) as BatchIntentRow[];
  if (intents.length > 0 && !provider?.reconcileStructuredGenerationBatchIntent) {
    throw new Error('content_script_account_batch_intent_reconciliation_unavailable');
  }
  let absencePending = false;
  for (const row of intents) {
    const result = await reconcileClaimedContentScriptBatchIntent({
      db,
      provider: provider!,
      row,
      now,
    });
    absencePending ||= result.absencePending;
  }
  if (absencePending) throw new Error('content_script_account_batch_intent_visibility_pending');
  const active = db.prepare(`SELECT job_id, tenant_id, owner_user_id, stage_key,
      custom_id, provider_batch_id, status
    FROM content_script_provider_batches
    WHERE owner_user_id = ? AND provider_batch_id IS NOT NULL
      AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')
    ORDER BY updated_at, job_id, stage_key`).all(userId) as Array<{
      job_id: string;
      tenant_id: number;
      owner_user_id: number;
      stage_key: string;
      custom_id: string;
      provider_batch_id: string;
      status: StructuredGenerationBatchStatus;
    }>;
  if (active.length > 0 && !provider?.cancelStructuredGenerationBatch) {
    throw new Error('content_script_account_batch_cancellation_unavailable');
  }
  for (const row of active) {
    const result = await provider!.cancelStructuredGenerationBatch!({
      providerBatchId: row.provider_batch_id,
      customId: row.custom_id,
      userId: row.owner_user_id,
      tenantId: row.tenant_id,
      category: 'cloud_local_reasoning',
    });
    const timestamp = now.toISOString();
    const updated = db.prepare(`UPDATE content_script_provider_batches
      SET status = ?, output_file_id = COALESCE(output_file_id, ?),
        error_file_id = COALESCE(error_file_id, ?), last_error_code = ?,
        completed_at = CASE WHEN ? IN ('completed', 'cancelled', 'failed', 'expired')
          THEN COALESCE(completed_at, ?) ELSE completed_at END,
        updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
        AND provider_batch_id = ?
        AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')`)
      .run(
        result.status,
        result.outputFileId ?? null,
        result.errorFileId ?? null,
        result.errorCode ?? null,
        result.status,
        timestamp,
        timestamp,
        row.job_id,
        row.tenant_id,
        row.owner_user_id,
        row.stage_key,
        row.provider_batch_id,
      ).changes;
    if (updated !== 1 || !TERMINAL_BATCH_STATUSES.has(result.status)) {
      throw new Error('content_script_account_batch_cancellation_pending');
    }
  }

  const files = db.prepare(`SELECT job_id, tenant_id, owner_user_id, stage_key,
      provider_batch_id, input_file_id, output_file_id, error_file_id
    FROM content_script_provider_batches
    WHERE owner_user_id = ? AND provider_files_deleted_at IS NULL
      AND (input_file_id IS NOT NULL OR output_file_id IS NOT NULL OR error_file_id IS NOT NULL)
      AND (provider_batch_id IS NULL
        OR status IN ('completed', 'cancelled', 'failed', 'expired'))
    ORDER BY job_id, stage_key`).all(userId) as Array<{
      job_id: string;
      tenant_id: number;
      owner_user_id: number;
      stage_key: string;
      provider_batch_id: string | null;
      input_file_id: string | null;
      output_file_id: string | null;
      error_file_id: string | null;
    }>;
  if (files.length > 0 && !provider?.deleteStructuredGenerationBatchFiles) {
    throw new Error('content_script_account_batch_file_cleanup_unavailable');
  }
  const staleClaimCutoff = new Date(now.getTime() - BATCH_FILE_CLEANUP_CLAIM_STALE_MS).toISOString();
  let deleted = 0;
  for (const row of files) {
    const claim = crypto.randomUUID();
    const claimed = db.transaction(() => db.prepare(`UPDATE content_script_provider_batches
      SET provider_files_cleanup_started_at = COALESCE(provider_files_cleanup_started_at, ?),
        provider_files_cleanup_claim = ?, provider_files_cleanup_claimed_at = ?, updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
        AND provider_batch_id IS ?
        AND input_file_id IS ? AND output_file_id IS ? AND error_file_id IS ?
        AND provider_files_deleted_at IS NULL
        AND (provider_files_cleanup_claim IS NULL
          OR julianday(provider_files_cleanup_claimed_at) <= julianday(?))`)
      .run(
        now.toISOString(),
        claim,
        now.toISOString(),
        now.toISOString(),
        row.job_id,
        row.tenant_id,
        row.owner_user_id,
        row.stage_key,
        row.provider_batch_id,
        row.input_file_id,
        row.output_file_id,
        row.error_file_id,
        staleClaimCutoff,
      ).changes).immediate();
    if (claimed !== 1) throw new Error('content_script_account_batch_file_cleanup_claimed');
    try {
      await provider!.deleteStructuredGenerationBatchFiles!({
        ...(row.provider_batch_id ? { providerBatchId: row.provider_batch_id } : {}),
        fileIds: [row.input_file_id, row.error_file_id, row.output_file_id]
          .filter((value): value is string => Boolean(value)),
      });
      const marked = db.prepare(`UPDATE content_script_provider_batches
        SET provider_files_deleted_at = ?, provider_files_cleanup_claim = NULL,
          provider_files_cleanup_claimed_at = NULL, updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_files_cleanup_claim = ? AND provider_files_deleted_at IS NULL`)
        .run(
          now.toISOString(),
          now.toISOString(),
          row.job_id,
          row.tenant_id,
          row.owner_user_id,
          row.stage_key,
          claim,
        ).changes;
      if (marked !== 1) throw new Error('content_script_account_batch_file_cleanup_confirmation_race');
      deleted += 1;
    } catch (error) {
      db.prepare(`UPDATE content_script_provider_batches
        SET provider_files_cleanup_claim = NULL, provider_files_cleanup_claimed_at = NULL
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_files_cleanup_claim = ?`)
        .run(row.job_id, row.tenant_id, row.owner_user_id, row.stage_key, claim);
      throw error;
    }
  }
  const remaining = (db.prepare(`SELECT COUNT(*) AS count
    FROM content_script_provider_batches
    WHERE owner_user_id = ? AND provider_files_deleted_at IS NULL
      AND (provider_batch_id IS NOT NULL OR input_file_id IS NOT NULL
        OR output_file_id IS NOT NULL OR error_file_id IS NOT NULL
        OR input_file_intent_filename IS NOT NULL
        OR batch_create_intent_at IS NOT NULL)`)
    .get(userId) as { count: number }).count;
  if (remaining !== 0) throw new Error('content_script_account_batch_cleanup_incomplete');
  return deleted;
}

/**
 * Delete OpenAI input/output files only after the plan's 30-day private-job
 * recovery window. Terminal Batch database identity and exactly-once usage
 * evidence remain through and after the governed local private-material pass,
 * without retaining prompt or result bytes at the provider.
 */
interface BatchFileRetentionCursor {
  retentionAt: string;
  jobId: string;
  stageKey: string;
}

type BatchIntentRetentionCursor = BatchFileRetentionCursor;

type BatchFileRetentionBranch = 'terminal' | 'upload_only';
type BatchRetentionSweepBranch = 'intent' | 'known_file';

function otherBatchRetentionSweepBranch(
  branch: BatchRetentionSweepBranch,
): BatchRetentionSweepBranch {
  return branch === 'intent' ? 'known_file' : 'intent';
}

/**
 * Rotate the first branch before provider work begins. The durable turn makes
 * maxPages=1 fair across scheduler invocations and remains safe if the worker
 * exits after claiming its turn; row-level cleanup claims still serialize the
 * provider mutations themselves.
 */
function claimBatchRetentionSweepStart(
  db: Database.Database,
  now: Date,
): BatchRetentionSweepBranch {
  return db.transaction(() => {
    const row = db.prepare(`SELECT next_branch
      FROM content_script_provider_retention_control
      WHERE singleton = 1`).get() as { next_branch: BatchRetentionSweepBranch } | undefined;
    if (!row || (row.next_branch !== 'intent' && row.next_branch !== 'known_file')) {
      throw new Error('content_script_provider_retention_control_invalid');
    }
    const changed = db.prepare(`UPDATE content_script_provider_retention_control
      SET next_branch = ?, updated_at = ?
      WHERE singleton = 1 AND next_branch = ?`)
      .run(otherBatchRetentionSweepBranch(row.next_branch), now.toISOString(), row.next_branch).changes;
    if (changed !== 1) throw new Error('content_script_provider_retention_control_race');
    return row.next_branch;
  }).immediate();
}

export interface BatchFileRetentionBacklog {
  eligible: number;
  oldestEligibleAt: string | null;
  oldestEligibleAgeDays: number | null;
  blockedActive: number;
  oldestBlockedAt: string | null;
  oldestBlockedAgeDays: number | null;
}

export interface BatchFileRetentionDrainResult {
  deleted: number;
  failed: number;
  pages: number;
  backlog: BatchFileRetentionBacklog;
}

async function reconcileExpiredContentScriptBatchIntentPage(
  db: Database.Database,
  input: {
    now: Date;
    retentionDays: number;
    limit: number;
    after: BatchIntentRetentionCursor | null;
  },
): Promise<{
  deletionProven: number;
  failed: number;
  selected: number;
  recoveredActive: number;
  cursor: BatchIntentRetentionCursor | null;
}> {
  const cutoff = batchFileRetentionCutoff(input.now, input.retentionDays);
  const staleClaimCutoff = new Date(
    input.now.getTime() - BATCH_FILE_CLEANUP_CLAIM_STALE_MS,
  ).toISOString();
  const cursorClause = input.after
    ? `AND (
        julianday(COALESCE(job.completed_at, job.updated_at)) > julianday(?)
        OR (
          julianday(COALESCE(job.completed_at, job.updated_at)) = julianday(?)
          AND (batch.job_id > ? OR (batch.job_id = ? AND batch.stage_key > ?))
        )
      )`
    : '';
  const cursorArgs = input.after
    ? [input.after.retentionAt, input.after.retentionAt,
      input.after.jobId, input.after.jobId, input.after.stageKey]
    : [];
  const rows = db.prepare(`SELECT batch.job_id, batch.tenant_id, batch.owner_user_id,
      batch.stage_key, batch.request_digest, batch.custom_id, batch.status,
      batch.input_file_intent_filename, batch.input_file_intent_at,
      batch.input_file_intent_absence_count,
      batch.input_file_intent_absence_observed_at,
      batch.input_file_intent_absence_confirmed_at,
      batch.batch_create_intent_at, batch.batch_create_intent_absence_count,
      batch.batch_create_intent_absence_observed_at,
      batch.batch_create_intent_absence_confirmed_at,
      batch.input_file_id, batch.provider_batch_id,
      batch.output_file_id, batch.error_file_id,
      strftime('%Y-%m-%dT%H:%M:%fZ',
        julianday(COALESCE(job.completed_at, job.updated_at))) AS retention_at
    FROM content_script_provider_batches AS batch
    JOIN content_script_jobs AS job ON job.job_id = batch.job_id
      AND job.tenant_id = batch.tenant_id AND job.owner_user_id = batch.owner_user_id
    WHERE batch.provider_files_deleted_at IS NULL
      AND job.status IN ('completed', 'failed', 'cancelled')
      AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
      AND ((batch.input_file_intent_filename IS NOT NULL
            AND batch.input_file_id IS NULL
            AND batch.input_file_intent_absence_confirmed_at IS NULL)
        OR (batch.batch_create_intent_at IS NOT NULL
            AND batch.provider_batch_id IS NULL
            AND batch.batch_create_intent_absence_confirmed_at IS NULL))
      AND (batch.provider_files_cleanup_claim IS NULL
        OR julianday(batch.provider_files_cleanup_claimed_at) <= julianday(?))
      ${cursorClause}
    ORDER BY julianday(COALESCE(job.completed_at, job.updated_at)), batch.job_id, batch.stage_key
    LIMIT ?`).all(cutoff, staleClaimCutoff, ...cursorArgs, input.limit) as Array<
      BatchIntentRow & { retention_at: string }
    >;
  if (rows.length === 0) {
    return {
      deletionProven: 0,
      failed: 0,
      selected: 0,
      recoveredActive: 0,
      cursor: input.after,
    };
  }
  const last = rows.at(-1)!;
  const cursor = { retentionAt: last.retention_at, jobId: last.job_id, stageKey: last.stage_key };
  const { getProvider } = await import('./provider-registry');
  const provider = getProvider('openai');
  if (!provider?.reconcileStructuredGenerationBatchIntent) {
    logger.warn('OpenAI Batch intent reconciliation capability is unavailable');
    return {
      deletionProven: 0,
      failed: rows.length,
      selected: rows.length,
      recoveredActive: 0,
      cursor,
    };
  }
  let deletionProven = 0;
  let failed = 0;
  let recoveredActive = 0;
  for (const row of rows) {
    try {
      const result = await reconcileClaimedContentScriptBatchIntent({ db, provider, row, now: input.now });
      if (result.deletionProven) deletionProven += 1;
      if (result.absencePending) failed += 1;
      if (result.recoveredActive) recoveredActive += 1;
    } catch (error) {
      failed += 1;
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'OpenAI Batch intent retention reconciliation remains pending');
    }
  }
  return { deletionProven, failed, selected: rows.length, recoveredActive, cursor };
}

function batchFileRetentionCutoff(now: Date, retentionDays: number): string {
  if (!Number.isFinite(now.getTime())) throw new Error('batch_file_retention_now_invalid');
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
}

function batchFileRetentionCandidatesCte(): string {
  // Keep the terminal-Batch and upload-before-Batch branches separate so each
  // is backed by its matching partial index. Retention always ages from the
  // parent job's terminal timestamp; Batch state is only a deletion-safety
  // condition. The branches cannot overlap.
  return `eligible_batches AS (
    SELECT batch.job_id, batch.stage_key, 'terminal' AS eligibility_branch,
      julianday(COALESCE(job.completed_at, job.updated_at)) AS retention_jd
    FROM content_script_provider_batches AS batch
    JOIN content_script_jobs AS job ON job.job_id = batch.job_id
      AND job.tenant_id = batch.tenant_id AND job.owner_user_id = batch.owner_user_id
    WHERE batch.provider_files_deleted_at IS NULL
      AND (batch.input_file_id IS NOT NULL OR batch.output_file_id IS NOT NULL
        OR batch.error_file_id IS NOT NULL)
      AND batch.status IN ('completed', 'cancelled', 'failed', 'expired')
      AND job.status IN ('completed', 'failed', 'cancelled')
      AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
    UNION ALL
    SELECT batch.job_id, batch.stage_key, 'upload_only' AS eligibility_branch,
      julianday(COALESCE(job.completed_at, job.updated_at)) AS retention_jd
    FROM content_script_provider_batches AS batch
    JOIN content_script_jobs AS job ON job.job_id = batch.job_id
      AND job.tenant_id = batch.tenant_id AND job.owner_user_id = batch.owner_user_id
    WHERE batch.provider_files_deleted_at IS NULL
      AND (batch.input_file_id IS NOT NULL OR batch.output_file_id IS NOT NULL
        OR batch.error_file_id IS NOT NULL)
      AND batch.provider_batch_id IS NULL
      AND (batch.batch_create_intent_at IS NULL
        OR batch.batch_create_intent_absence_confirmed_at IS NOT NULL)
      AND batch.status NOT IN ('completed', 'cancelled', 'failed', 'expired')
      AND job.status IN ('completed', 'failed', 'cancelled')
      AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
  )`;
}

function batchFileRetentionClaimEligibility(branch: BatchFileRetentionBranch): string {
  const batchEligibility = branch === 'terminal'
    ? `status IN ('completed', 'cancelled', 'failed', 'expired')`
    : `provider_batch_id IS NULL
      AND (batch_create_intent_at IS NULL
        OR batch_create_intent_absence_confirmed_at IS NOT NULL)
      AND status NOT IN ('completed', 'cancelled', 'failed', 'expired')`;
  return `${batchEligibility}
    AND EXISTS (
      SELECT 1 FROM content_script_jobs AS job
      WHERE job.job_id = content_script_provider_batches.job_id
        AND job.tenant_id = content_script_provider_batches.tenant_id
        AND job.owner_user_id = content_script_provider_batches.owner_user_id
        AND job.status IN ('completed', 'failed', 'cancelled')
        AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
    )`;
}

async function pruneExpiredContentScriptBatchFilePage(
  db: Database.Database,
  input: { now: Date; retentionDays: number; limit: number; after: BatchFileRetentionCursor | null },
): Promise<{ deleted: number; failed: number; selected: number; cursor: BatchFileRetentionCursor | null }> {
  const cutoff = batchFileRetentionCutoff(input.now, input.retentionDays);
  const staleClaimCutoff = new Date(input.now.getTime() - BATCH_FILE_CLEANUP_CLAIM_STALE_MS).toISOString();
  const cursorClause = input.after
    ? `AND (
        eligible.retention_jd > julianday(?)
        OR (
          eligible.retention_jd = julianday(?)
          AND (batch.job_id > ? OR (batch.job_id = ? AND batch.stage_key > ?))
        )
      )`
    : '';
  const cursorArgs = input.after
    ? [input.after.retentionAt, input.after.retentionAt,
      input.after.jobId, input.after.jobId, input.after.stageKey]
    : [];
  const rows = db.prepare(`WITH ${batchFileRetentionCandidatesCte()}
    SELECT batch.job_id, batch.tenant_id, batch.owner_user_id,
      batch.stage_key, batch.provider_batch_id, batch.input_file_id,
      batch.output_file_id, batch.error_file_id,
      eligible.eligibility_branch,
      strftime('%Y-%m-%dT%H:%M:%fZ', eligible.retention_jd) AS retention_at
    FROM eligible_batches AS eligible
    JOIN content_script_provider_batches AS batch
      ON batch.job_id = eligible.job_id AND batch.stage_key = eligible.stage_key
    WHERE (batch.provider_files_cleanup_claim IS NULL
        OR julianday(batch.provider_files_cleanup_claimed_at) <= julianday(?))
      ${cursorClause}
    ORDER BY eligible.retention_jd, batch.job_id, batch.stage_key
    LIMIT ?`).all(cutoff, cutoff, staleClaimCutoff, ...cursorArgs, input.limit) as Array<{
      job_id: string;
      tenant_id: number;
      owner_user_id: number;
      stage_key: string;
      provider_batch_id: string | null;
      input_file_id: string | null;
      output_file_id: string | null;
      error_file_id: string | null;
      eligibility_branch: BatchFileRetentionBranch;
      retention_at: string;
    }>;
  if (rows.length === 0) {
    return { deleted: 0, failed: 0, selected: 0, cursor: input.after };
  }
  const last = rows.at(-1)!;
  const cursor = { retentionAt: last.retention_at, jobId: last.job_id, stageKey: last.stage_key };

  const { getProvider } = await import('./provider-registry');
  const provider = getProvider('openai');
  if (!provider?.deleteStructuredGenerationBatchFiles) {
    logger.warn('OpenAI Batch file cleanup capability is unavailable');
    return { deleted: 0, failed: rows.length, selected: rows.length, cursor };
  }

  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    const claim = crypto.randomUUID();
    const claimed = db.transaction(() => db.prepare(`UPDATE content_script_provider_batches
      SET provider_files_cleanup_started_at = COALESCE(provider_files_cleanup_started_at, ?),
        provider_files_cleanup_claim = ?, provider_files_cleanup_claimed_at = ?, updated_at = ?
      WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
        AND provider_batch_id IS ?
        AND input_file_id IS ? AND output_file_id IS ? AND error_file_id IS ?
        AND provider_files_deleted_at IS NULL
        AND ${batchFileRetentionClaimEligibility(row.eligibility_branch)}
        AND (provider_files_cleanup_claim IS NULL
          OR julianday(provider_files_cleanup_claimed_at) <= julianday(?))`)
      .run(
        input.now.toISOString(),
        claim,
        input.now.toISOString(),
        input.now.toISOString(),
        row.job_id,
        row.tenant_id,
        row.owner_user_id,
        row.stage_key,
        row.provider_batch_id,
        row.input_file_id,
        row.output_file_id,
        row.error_file_id,
        cutoff,
        staleClaimCutoff,
      ).changes).immediate();
    if (claimed !== 1) {
      failed += 1;
      continue;
    }
    try {
      await provider.deleteStructuredGenerationBatchFiles({
        ...(row.provider_batch_id ? { providerBatchId: row.provider_batch_id } : {}),
        fileIds: [row.input_file_id, row.error_file_id, row.output_file_id]
          .filter((value): value is string => Boolean(value)),
      });
      const marked = db.prepare(`UPDATE content_script_provider_batches
        SET provider_files_deleted_at = ?, provider_files_cleanup_claim = NULL,
          provider_files_cleanup_claimed_at = NULL, updated_at = ?
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_batch_id IS ?
          AND input_file_id IS ? AND output_file_id IS ? AND error_file_id IS ?
          AND provider_files_deleted_at IS NULL AND provider_files_cleanup_claim = ?`)
        .run(
          input.now.toISOString(),
          input.now.toISOString(),
          row.job_id,
          row.tenant_id,
          row.owner_user_id,
          row.stage_key,
          row.provider_batch_id,
          row.input_file_id,
          row.output_file_id,
          row.error_file_id,
          claim,
        ).changes;
      if (marked !== 1) throw new Error('content_script_batch_cleanup_confirmation_race');
      deleted += 1;
    } catch (error) {
      db.prepare(`UPDATE content_script_provider_batches
        SET provider_files_cleanup_claim = NULL, provider_files_cleanup_claimed_at = NULL
        WHERE job_id = ? AND tenant_id = ? AND owner_user_id = ? AND stage_key = ?
          AND provider_files_cleanup_claim = ?`)
        .run(row.job_id, row.tenant_id, row.owner_user_id, row.stage_key, claim);
      failed += 1;
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
      }, 'OpenAI Batch provider-file retention cleanup remains pending');
    }
  }
  return { deleted, failed, selected: rows.length, cursor };
}

function batchFileRetentionBacklog(
  db: Database.Database,
  now: Date,
  retentionDays: number,
): BatchFileRetentionBacklog {
  const cutoff = batchFileRetentionCutoff(now, retentionDays);
  const row = db.prepare(`WITH ${batchFileRetentionCandidatesCte()}
    SELECT COUNT(*) AS eligible, MIN(retention_jd) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ', MIN(retention_jd)) AS oldest
    FROM eligible_batches`)
    .get(cutoff, cutoff) as { eligible: number; oldest_jd: number | null; oldest: string | null };
  const oldestMs = row.oldest_jd === null
    ? Number.NaN
    : Math.round((row.oldest_jd - 2_440_587.5) * 86_400_000);
  const blocked = db.prepare(`WITH blocked_batches AS (
      SELECT julianday(COALESCE(job.completed_at, job.updated_at)) AS retention_jd
      FROM content_script_provider_batches AS batch
      JOIN content_script_jobs AS job ON job.job_id = batch.job_id
        AND job.tenant_id = batch.tenant_id AND job.owner_user_id = batch.owner_user_id
      WHERE batch.provider_files_deleted_at IS NULL
        AND batch.provider_batch_id IS NOT NULL
        AND (batch.input_file_id IS NOT NULL OR batch.output_file_id IS NOT NULL
          OR batch.error_file_id IS NOT NULL)
        AND batch.status NOT IN ('completed', 'cancelled', 'failed', 'expired')
        AND job.status IN ('completed', 'failed', 'cancelled')
        AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
      UNION ALL
      SELECT julianday(COALESCE(job.completed_at, job.updated_at)) AS retention_jd
      FROM content_script_provider_batches AS batch
      JOIN content_script_jobs AS job ON job.job_id = batch.job_id
        AND job.tenant_id = batch.tenant_id AND job.owner_user_id = batch.owner_user_id
      WHERE batch.provider_files_deleted_at IS NULL
        AND ((batch.input_file_intent_filename IS NOT NULL
              AND batch.input_file_id IS NULL
              AND batch.input_file_intent_absence_confirmed_at IS NULL)
          OR (batch.batch_create_intent_at IS NOT NULL
              AND batch.provider_batch_id IS NULL
              AND batch.batch_create_intent_absence_confirmed_at IS NULL))
        AND job.status IN ('completed', 'failed', 'cancelled')
        AND julianday(COALESCE(job.completed_at, job.updated_at)) <= julianday(?)
    )
    SELECT COUNT(*) AS count, MIN(retention_jd) AS oldest_jd,
      strftime('%Y-%m-%dT%H:%M:%fZ', MIN(retention_jd)) AS oldest
    FROM blocked_batches`)
    .get(cutoff, cutoff) as { count: number; oldest_jd: number | null; oldest: string | null };
  const oldestBlockedMs = blocked.oldest_jd === null
    ? Number.NaN
    : Math.round((blocked.oldest_jd - 2_440_587.5) * 86_400_000);
  return {
    eligible: row.eligible,
    oldestEligibleAt: row.oldest,
    oldestEligibleAgeDays: Number.isFinite(oldestMs)
      ? Math.max(0, Math.floor((now.getTime() - oldestMs) / 86_400_000))
      : null,
    blockedActive: blocked.count,
    oldestBlockedAt: blocked.oldest,
    oldestBlockedAgeDays: Number.isFinite(oldestBlockedMs)
      ? Math.max(0, Math.floor((now.getTime() - oldestBlockedMs) / 86_400_000))
      : null,
  };
}

export async function pruneExpiredContentScriptBatchFiles(
  db: Database.Database,
  input: { now?: Date; retentionDays?: number; limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const now = input.now ?? new Date();
  const retentionDays = Math.max(1, Math.min(365, Math.floor(input.retentionDays ?? 30)));
  const pageLimit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
  const intents = await reconcileExpiredContentScriptBatchIntentPage(db, {
    now, retentionDays, limit: pageLimit, after: null,
  });
  if (intents.recoveredActive > 0) requestContentScriptBatchCancellationReconciliation(db);
  const page = await pruneExpiredContentScriptBatchFilePage(db, {
    now, retentionDays, limit: pageLimit, after: null,
  });
  return {
    deleted: intents.deletionProven + page.deleted,
    failed: intents.failed + page.failed,
  };
}

/**
 * Attempt eligible intent-reconciliation and known-file pages under one
 * bounded, alternating budget. Independent stable cursors advance past row
 * failures, while the durable start turn guarantees cross-run fairness even
 * when the scheduler permits only one page.
 */
export async function drainExpiredContentScriptBatchFiles(
  db: Database.Database,
  input: { now?: Date; retentionDays?: number; limit?: number; maxPages?: number } = {},
): Promise<BatchFileRetentionDrainResult> {
  const now = input.now ?? new Date();
  const retentionDays = Math.max(1, Math.min(365, Math.floor(input.retentionDays ?? 30)));
  const pageLimit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 100)));
  const pageCap = Math.max(1, Math.min(100, Math.floor(input.maxPages ?? 100)));
  let intentCursor: BatchIntentRetentionCursor | null = null;
  let fileCursor: BatchFileRetentionCursor | null = null;
  let intentExhausted = false;
  let filesExhausted = false;
  let nextBranch = claimBatchRetentionSweepStart(db, now);
  let deleted = 0;
  let failed = 0;
  let pages = 0;
  while (pages < pageCap && (!intentExhausted || !filesExhausted)) {
    let selectedPage = false;
    // If the scheduled branch is exhausted, try the other branch without
    // charging the shared page budget. A selected page always flips the next
    // in-memory turn, reserving bounded progress for both live backlogs.
    for (let attempt = 0; attempt < 2 && !selectedPage; attempt += 1) {
      const branch = attempt === 0
        ? nextBranch
        : otherBatchRetentionSweepBranch(nextBranch);
      if (branch === 'intent') {
        if (intentExhausted) continue;
        const page = await reconcileExpiredContentScriptBatchIntentPage(db, {
          now, retentionDays, limit: pageLimit, after: intentCursor,
        });
        if (page.selected === 0) {
          intentExhausted = true;
          continue;
        }
        pages += 1;
        deleted += page.deletionProven;
        failed += page.failed;
        intentCursor = page.cursor;
        intentExhausted = page.selected < pageLimit;
      } else {
        if (filesExhausted) continue;
        const page = await pruneExpiredContentScriptBatchFilePage(db, {
          now, retentionDays, limit: pageLimit, after: fileCursor,
        });
        if (page.selected === 0) {
          filesExhausted = true;
          continue;
        }
        pages += 1;
        deleted += page.deleted;
        failed += page.failed;
        fileCursor = page.cursor;
        filesExhausted = page.selected < pageLimit;
      }
      selectedPage = true;
      nextBranch = otherBatchRetentionSweepBranch(branch);
    }
    if (!selectedPage) break;
  }
  requestContentScriptBatchCancellationReconciliation(db);
  return {
    deleted,
    failed,
    pages,
    backlog: batchFileRetentionBacklog(db, now, retentionDays),
  };
}
