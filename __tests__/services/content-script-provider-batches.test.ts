// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  provider: {
    cancelStructuredGenerationBatch: vi.fn(),
    deleteStructuredGenerationBatchFiles: vi.fn(),
    reconcileStructuredGenerationBatchIntent: vi.fn(),
  },
  getProvider: vi.fn(),
}));

vi.mock('../../src/services/provider-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/provider-registry')>()),
  getProvider: (...args: unknown[]) => registryMocks.getProvider(...args),
}));

vi.mock('../../src/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/logger')>()),
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import {
  cleanupContentScriptProviderFilesForAccountDeletion,
  createContentScriptBatchControl,
  drainExpiredContentScriptBatchFiles,
  hasContentScriptProviderFileCleanupFence,
  markContentScriptBatchesCancellationRequested,
  pruneExpiredContentScriptBatchFiles,
  requestContentScriptBatchCancellationReconciliation,
} from '../../src/services/content-script-provider-batches';

const migrationSql = readFileSync(
  resolve(__dirname, '../../migrations/295_content_script_openai_batches.sql'),
  'utf8',
);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE content_script_jobs (
      job_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      lease_token TEXT,
      cancellation_requested_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
  db.exec(migrationSql);
  db.exec(`ALTER TABLE content_script_provider_batches
      ADD COLUMN provider_files_cleanup_started_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN provider_files_cleanup_claim TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN provider_files_cleanup_claimed_at TEXT;`);
  db.exec(`ALTER TABLE content_script_provider_batches
      ADD COLUMN input_file_intent_filename TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN input_file_intent_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN batch_create_intent_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN input_file_intent_absence_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN input_file_intent_absence_observed_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN input_file_intent_absence_confirmed_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN batch_create_intent_absence_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN batch_create_intent_absence_observed_at TEXT;
    ALTER TABLE content_script_provider_batches
      ADD COLUMN batch_create_intent_absence_confirmed_at TEXT;`);
  db.exec(`CREATE TABLE content_script_provider_retention_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_branch TEXT NOT NULL CHECK (next_branch IN ('intent', 'known_file')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO content_script_provider_retention_control (
      singleton, next_branch, updated_at
    ) VALUES (1, 'intent', '2026-08-23T00:00:00.000Z');`);
  return db;
}

function insertJob(
  db: Database.Database,
  jobId: string,
  input: { status?: string; leaseToken?: string | null; cancellationRequestedAt?: string | null } = {},
): void {
  db.prepare(`INSERT INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, status, lease_token, cancellation_requested_at
    ) VALUES (?, 42, 42, ?, ?, ?)`)
    .run(
      jobId,
      input.status ?? 'running',
      input.leaseToken === undefined ? 'lease-1' : input.leaseToken,
      input.cancellationRequestedAt ?? null,
    );
}

function control(db: Database.Database, jobId: string, stage = 'a'): ReturnType<typeof createContentScriptBatchControl> {
  return createContentScriptBatchControl({
    db,
    jobId,
    tenantId: 42,
    userId: 42,
    leaseToken: 'lease-1',
    stageKey: stage.repeat(64),
  });
}

function insertTerminalBatch(
  db: Database.Database,
  input: {
    jobId: string;
    stage: string;
    providerBatchId: string;
    completedAt?: string;
    jobCompletedAt?: string;
    batchCompletedAt?: string;
    files?: string[];
  },
): void {
  const jobCompletedAt = input.jobCompletedAt
    ?? input.completedAt ?? '2026-06-01T00:00:00.000Z';
  const batchCompletedAt = input.batchCompletedAt
    ?? input.completedAt ?? '2026-06-01T00:00:00.000Z';
  db.prepare(`INSERT OR IGNORE INTO content_script_jobs (
      job_id, tenant_id, owner_user_id, status, lease_token, cancellation_requested_at,
      completed_at, updated_at
    ) VALUES (?, 42, 42, 'completed', NULL, NULL, ?, ?)`)
    .run(
      input.jobId,
      jobCompletedAt,
      jobCompletedAt,
    );
  const [inputFileId = null, outputFileId = null, errorFileId = null] = input.files ?? [];
  db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_id, provider_batch_id, status, output_file_id, error_file_id,
      completed_at, updated_at
    ) VALUES (?, 42, 42, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
    .run(
      input.jobId,
      input.stage.repeat(64),
      'd'.repeat(64),
      `custom-${input.jobId}`,
      inputFileId,
      input.providerBatchId,
      outputFileId,
      errorFileId,
      batchCompletedAt,
      batchCompletedAt,
    );
}

describe('content script provider Batch durability', () => {
  beforeEach(async () => {
    registryMocks.getProvider.mockReset();
    registryMocks.getProvider.mockReturnValue(registryMocks.provider);
    registryMocks.provider.cancelStructuredGenerationBatch.mockReset();
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockReset();
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockReset();
    await import('../../src/services/provider-registry');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('enforces parent scope, lease ownership, immutable provider identity, and terminal state', () => {
    const db = database();
    const batch = control(db, 'job-1');
    expect(batch.load()).toBeNull();
    expect(() => batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'preparing',
    })).toThrow('content_script_batch_scope_invalid');

    insertJob(db, 'job-1', { status: 'queued', leaseToken: null });
    expect(() => batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'preparing',
    })).toThrow('content_script_batch_lease_lost');
    db.prepare(`UPDATE content_script_jobs SET status = 'running', lease_token = 'lease-1'
      WHERE job_id = 'job-1'`).run();

    batch.persist({ requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'preparing' });
    expect(batch.load()).toEqual({
      requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'preparing',
    });
    batch.persist({
      requestDigest: 'd'.repeat(64),
      customId: 'custom-1',
      status: 'in_progress',
      inputFileId: 'file-input',
      providerBatchId: 'batch-1',
      outputFileId: 'file-output',
      errorFileId: 'file-error',
      errorCode: 'provider-warning',
    });
    expect(batch.load()).toEqual({
      requestDigest: 'd'.repeat(64),
      customId: 'custom-1',
      status: 'in_progress',
      inputFileId: 'file-input',
      providerBatchId: 'batch-1',
      outputFileId: 'file-output',
      errorFileId: 'file-error',
      errorCode: 'provider-warning',
    });
    batch.persist({ requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'in_progress' });

    expect(() => batch.persist({
      requestDigest: 'e'.repeat(64), customId: 'custom-1', status: 'in_progress',
    })).toThrow('content_script_batch_request_identity_mismatch');
    expect(() => batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'other', status: 'in_progress',
    })).toThrow('content_script_batch_request_identity_mismatch');
    for (const state of [
      { inputFileId: 'changed-input' },
      { providerBatchId: 'changed-batch' },
      { outputFileId: 'changed-output' },
      { errorFileId: 'changed-error' },
    ]) {
      expect(() => batch.persist({
        requestDigest: 'd'.repeat(64),
        customId: 'custom-1',
        status: 'in_progress',
        ...state,
      })).toThrow(/_immutable/);
    }

    db.prepare(`UPDATE content_script_jobs
      SET status = 'cancelled', lease_token = NULL, cancellation_requested_at = '2026-08-23T12:00:00.000Z'
      WHERE job_id = 'job-1'`).run();
    batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'cancelled',
    });
    db.prepare(`UPDATE content_script_jobs
      SET status = 'running', lease_token = 'lease-1' WHERE job_id = 'job-1'`).run();
    expect(() => batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-1', status: 'completed',
    })).toThrow('content_script_batch_terminal_state_immutable');
    db.close();
  });

  it('persists content-free upload and create intents before provider identities exist', () => {
    const db = database();
    const stageKey = 'f'.repeat(64);
    insertJob(db, 'job-intents');
    const batch = control(db, 'job-intents', 'f');
    batch.persist({
      requestDigest: 'd'.repeat(64),
      customId: stageKey,
      status: 'preparing',
      inputFileIntentFilename: `${stageKey}.jsonl`,
    });
    expect(batch.load()).toEqual({
      requestDigest: 'd'.repeat(64),
      customId: stageKey,
      status: 'preparing',
      inputFileIntentFilename: `${stageKey}.jsonl`,
    });
    batch.persist({
      ...batch.load()!,
      inputFileId: 'durable-input-file',
      batchCreateIntent: true,
    });
    expect(batch.load()).toMatchObject({
      inputFileIntentFilename: `${stageKey}.jsonl`,
      inputFileId: 'durable-input-file',
      batchCreateIntent: true,
    });
    expect(() => batch.persist({
      ...batch.load()!,
      inputFileIntentFilename: `${'e'.repeat(64)}.jsonl`,
    })).toThrow('content_script_batch_file_intent_identity_mismatch');
    db.close();
  });

  it('durably authorizes active-job upload and create retries only after independent absence proof', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
    const db = database();
    const stageKey = '7'.repeat(64);
    insertJob(db, 'job-runtime-absence');
    const batch = control(db, 'job-runtime-absence', '7');
    batch.persist({
      requestDigest: 'd'.repeat(64),
      customId: stageKey,
      status: 'preparing',
      inputFileIntentFilename: `${stageKey}.jsonl`,
    });

    expect(batch.observeIntentAbsence?.('input_file')).toMatchObject({
      mutationAuthorized: false,
    });
    vi.setSystemTime(new Date('2026-08-23T12:15:00.000Z'));
    expect(batch.observeIntentAbsence?.('input_file')).toEqual({
      state: expect.not.objectContaining({ inputFileIntentAbsenceConfirmed: true }),
      mutationAuthorized: true,
    });
    expect(db.prepare(`SELECT input_file_intent_at AS intentAt,
        input_file_intent_absence_count AS observations,
        input_file_intent_absence_observed_at AS observedAt,
        input_file_intent_absence_confirmed_at AS confirmedAt
      FROM content_script_provider_batches WHERE job_id = 'job-runtime-absence'`).get())
      .toEqual({
        intentAt: '2026-08-23T12:15:00.000Z',
        observations: 0,
        observedAt: null,
        confirmedAt: null,
      });

    batch.persist({
      ...batch.load()!,
      inputFileId: 'runtime-absence-input',
      batchCreateIntent: true,
    });
    expect(batch.observeIntentAbsence?.('batch_create')).toMatchObject({
      mutationAuthorized: false,
    });
    vi.setSystemTime(new Date('2026-08-23T12:30:00.000Z'));
    expect(batch.observeIntentAbsence?.('batch_create')).toEqual({
      state: expect.not.objectContaining({ batchCreateIntentAbsenceConfirmed: true }),
      mutationAuthorized: true,
    });
    expect(db.prepare(`SELECT batch_create_intent_at AS intentAt,
        batch_create_intent_absence_count AS observations,
        batch_create_intent_absence_observed_at AS observedAt,
        batch_create_intent_absence_confirmed_at AS confirmedAt
      FROM content_script_provider_batches WHERE job_id = 'job-runtime-absence'`).get())
      .toEqual({
        intentAt: '2026-08-23T12:30:00.000Z',
        observations: 0,
        observedAt: null,
        confirmedAt: null,
      });
    db.close();
  });

  it('allows a cancelled worker to preserve provider identity for cleanup', () => {
    const db = database();
    insertJob(db, 'job-lease', {
      status: 'cancelled',
      leaseToken: null,
      cancellationRequestedAt: '2026-08-23T12:00:00.000Z',
    });
    const batch = control(db, 'job-lease', 'b');
    batch.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-lease', status: 'preparing',
      inputFileId: 'file-lease',
    });
    batch.persist({
      requestDigest: 'd'.repeat(64),
      customId: 'custom-lease',
      status: 'cancellation_requested',
      inputFileId: 'file-lease',
      providerBatchId: 'batch-lease',
    });
    expect(batch.load()).toMatchObject({ status: 'cancellation_requested' });
    db.close();
  });

  it('marks only non-terminal submitted batches in the matching tenant scope', () => {
    const db = database();
    insertJob(db, 'job-mark');
    const submitted = control(db, 'job-mark', 'c');
    submitted.persist({
      requestDigest: 'd'.repeat(64), customId: 'custom-submitted', status: 'in_progress',
      inputFileId: 'file-submitted', providerBatchId: 'batch-submitted',
    });
    const preparing = control(db, 'job-mark', 'd');
    preparing.persist({ requestDigest: 'e'.repeat(64), customId: 'custom-preparing', status: 'preparing' });
    const timestamp = '2026-08-23T13:00:00.000Z';
    expect(markContentScriptBatchesCancellationRequested(db, {
      jobId: 'job-mark', tenantId: 42, userId: 42, timestamp,
    })).toBe(1);
    expect(markContentScriptBatchesCancellationRequested(db, {
      jobId: 'job-mark', tenantId: 99, userId: 42, timestamp,
    })).toBe(0);
    expect(submitted.load()).toMatchObject({ status: 'cancellation_requested' });
    expect(preparing.load()).toMatchObject({ status: 'preparing' });
    db.close();
  });

  it('reconciles cancellation once per database and keeps individual provider failures pending', async () => {
    const pending: Array<() => void> = [];
    const immediateSpy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      pending.push(() => callback(...args));
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate);
    const empty = database();
    requestContentScriptBatchCancellationReconciliation(empty);
    expect(immediateSpy).not.toHaveBeenCalled();
    expect(registryMocks.getProvider).not.toHaveBeenCalled();
    empty.close();

    const db = database();
    for (const [index, status] of ['cancellation_requested', 'cancelling'].entries()) {
      const jobId = `job-reconcile-${index}`;
      insertJob(db, jobId);
      db.prepare(`INSERT INTO content_script_provider_batches (
          job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
          input_file_id, provider_batch_id, status
        ) VALUES (?, 42, 42, ?, ?, ?, ?, ?, ?)`)
        .run(
          jobId,
          String(index + 1).repeat(64),
          'd'.repeat(64),
          `custom-${index}`,
          `file-${index}`,
          `batch-${index}`,
          status,
        );
    }
    registryMocks.provider.cancelStructuredGenerationBatch
      .mockResolvedValueOnce({
        status: 'completed', outputFileId: 'output-0', errorFileId: 'error-0', errorCode: 'late-complete',
      })
      .mockRejectedValueOnce('provider-offline');

    expect(db.prepare(`SELECT COUNT(*) AS count FROM content_script_provider_batches
      WHERE status IN ('cancellation_requested', 'cancelling')`).get()).toEqual({ count: 2 });

    requestContentScriptBatchCancellationReconciliation(db);
    requestContentScriptBatchCancellationReconciliation(db);
    expect(immediateSpy).toHaveBeenCalledOnce();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await vi.waitFor(() => {
      expect(registryMocks.getProvider).toHaveBeenCalledOnce();
      expect(registryMocks.provider.cancelStructuredGenerationBatch).toHaveBeenCalledTimes(2);
    });
    expect(db.prepare(`SELECT status, output_file_id, error_file_id, last_error_code
      FROM content_script_provider_batches WHERE provider_batch_id = 'batch-0'`).get()).toEqual({
      status: 'completed',
      output_file_id: 'output-0',
      error_file_id: 'error-0',
      last_error_code: 'late-complete',
    });
    expect(db.prepare(`SELECT status FROM content_script_provider_batches
      WHERE provider_batch_id = 'batch-1'`).get()).toEqual({ status: 'cancelling' });
    db.close();
  });

  it('settles reconciliation setup failures and permits a later retry', async () => {
    const pending: Array<() => void> = [];
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      pending.push(() => callback(...args));
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate);
    const db = database();
    insertJob(db, 'job-capability');
    db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_id, provider_batch_id, status
      ) VALUES ('job-capability', 42, 42, ?, ?, 'custom-capability',
        'file-capability', 'batch-capability', 'cancellation_requested')`)
      .run('e'.repeat(64), 'd'.repeat(64));

    registryMocks.getProvider.mockReturnValueOnce({});
    requestContentScriptBatchCancellationReconciliation(db);
    pending.shift()?.();
    await vi.waitFor(() => expect(registryMocks.getProvider).toHaveBeenCalledTimes(1));
    registryMocks.getProvider.mockImplementationOnce(() => { throw 'registry-offline'; });
    requestContentScriptBatchCancellationReconciliation(db);
    pending.shift()?.();
    await vi.waitFor(() => expect(registryMocks.getProvider).toHaveBeenCalledTimes(2));
    registryMocks.getProvider.mockReturnValue(registryMocks.provider);
    registryMocks.provider.cancelStructuredGenerationBatch.mockResolvedValueOnce({ status: 'cancelled' });
    requestContentScriptBatchCancellationReconciliation(db);
    pending.shift()?.();
    await vi.waitFor(() => {
      expect(db.prepare(`SELECT status FROM content_script_provider_batches
        WHERE provider_batch_id = 'batch-capability'`).get()).toEqual({ status: 'cancelled' });
    });
    db.close();
  });

  it('backfills cancellation for an active Batch whose parent was already terminal', async () => {
    const pending: Array<() => void> = [];
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) => {
      pending.push(() => callback(...args));
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate);
    const db = database();
    insertJob(db, 'job-preexisting-orphan', { status: 'failed', leaseToken: null });
    db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_id, provider_batch_id, status
      ) VALUES ('job-preexisting-orphan', 42, 42, ?, ?, 'custom-preexisting',
        'input-preexisting', 'batch-preexisting', 'in_progress')`)
      .run('a'.repeat(64), 'd'.repeat(64));
    registryMocks.provider.cancelStructuredGenerationBatch.mockResolvedValueOnce({ status: 'cancelled' });

    requestContentScriptBatchCancellationReconciliation(db);
    expect(db.prepare(`SELECT status FROM content_script_provider_batches
      WHERE job_id = 'job-preexisting-orphan'`).get()).toEqual({ status: 'cancellation_requested' });
    pending.shift()?.();
    await vi.waitFor(() => {
      expect(db.prepare(`SELECT status FROM content_script_provider_batches
        WHERE job_id = 'job-preexisting-orphan'`).get()).toEqual({ status: 'cancelled' });
    });
    db.close();
  });

  it('prunes expired provider files with bounded retention and isolates deletion failures', async () => {
    const empty = database();
    await expect(pruneExpiredContentScriptBatchFiles(empty)).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(registryMocks.getProvider).not.toHaveBeenCalled();
    empty.close();

    const unavailable = database();
    insertTerminalBatch(unavailable, {
      jobId: 'job-unavailable', stage: 'f', providerBatchId: 'batch-unavailable', files: ['input-unavailable'],
    });
    registryMocks.getProvider.mockReturnValueOnce({});
    await expect(pruneExpiredContentScriptBatchFiles(unavailable, {
      now: new Date('2026-08-23T12:00:00.000Z'), retentionDays: 0, limit: 200,
    })).resolves.toEqual({ deleted: 0, failed: 1 });
    unavailable.close();

    const db = database();
    insertTerminalBatch(db, {
      jobId: 'job-delete', stage: '1', providerBatchId: 'batch-delete',
      files: ['input-delete', 'output-delete', 'error-delete'],
      completedAt: '2025-01-01T00:00:00.000Z',
    });
    insertTerminalBatch(db, {
      jobId: 'job-fail', stage: '2', providerBatchId: 'batch-fail', files: ['input-fail'],
      completedAt: '2025-01-01T00:00:00.000Z',
    });
    registryMocks.getProvider.mockReturnValue(registryMocks.provider);
    registryMocks.provider.deleteStructuredGenerationBatchFiles
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('provider delete failed'));
    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), retentionDays: 400, limit: 0,
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenLastCalledWith({
      providerBatchId: 'batch-delete',
      fileIds: ['input-delete', 'error-delete', 'output-delete'],
    });
    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), retentionDays: 30, limit: 20,
    })).resolves.toEqual({ deleted: 0, failed: 1 });
    expect(db.prepare(`SELECT provider_files_deleted_at FROM content_script_provider_batches
      WHERE provider_batch_id = 'batch-delete'`).get()).toMatchObject({
      provider_files_deleted_at: '2026-08-23T12:00:00.000Z',
    });
    expect(db.prepare(`SELECT provider_files_deleted_at FROM content_script_provider_batches
      WHERE provider_batch_id = 'batch-fail'`).get()).toEqual({ provider_files_deleted_at: null });
    expect(db.prepare(`SELECT provider_files_cleanup_started_at,
        provider_files_cleanup_claim, provider_files_cleanup_claimed_at
      FROM content_script_provider_batches WHERE provider_batch_id = 'batch-fail'`).get())
      .toEqual({
        provider_files_cleanup_started_at: '2026-08-23T12:00:00.000Z',
        provider_files_cleanup_claim: null,
        provider_files_cleanup_claimed_at: null,
      });
    db.close();
  });

  it('fences retry and late Batch persistence before awaiting remote provider deletion', async () => {
    const db = database();
    insertTerminalBatch(db, {
      jobId: 'job-cleanup-race', stage: '9', providerBatchId: 'batch-cleanup-race',
      files: ['input-cleanup-race'], completedAt: '2025-01-01T00:00:00.000Z',
    });
    db.prepare(`UPDATE content_script_jobs SET cancellation_requested_at = ?
      WHERE job_id = 'job-cleanup-race'`).run('2026-08-23T11:59:59.000Z');
    let releaseDelete!: () => void;
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockImplementationOnce(
      () => new Promise<void>((resolveDelete) => { releaseDelete = resolveDelete; }),
    );

    const cleanup = pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    });
    await vi.waitFor(() => {
      expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledOnce();
    });
    expect(db.prepare(`SELECT provider_files_cleanup_started_at,
        provider_files_cleanup_claim IS NOT NULL AS claimed
      FROM content_script_provider_batches WHERE provider_batch_id = 'batch-cleanup-race'`).get())
      .toEqual({ provider_files_cleanup_started_at: '2026-08-23T12:00:00.000Z', claimed: 1 });
    expect(hasContentScriptProviderFileCleanupFence(db, {
      jobId: 'job-cleanup-race', tenantId: 42, userId: 42,
    })).toBe(true);
    const lateControl = control(db, 'job-cleanup-race', '9');
    expect(() => lateControl.load())
      .toThrow('content_script_batch_private_material_cleanup_started');
    expect(() => lateControl.persist({
      requestDigest: 'd'.repeat(64),
      customId: 'custom-job-cleanup-race',
      status: 'completed',
      inputFileId: 'input-cleanup-race',
      providerBatchId: 'batch-cleanup-race',
    })).toThrow('content_script_batch_private_material_cleanup_started');
    releaseDelete();
    await expect(cleanup).resolves.toEqual({ deleted: 1, failed: 0 });
    db.close();
  });

  it('keeps old Batch files until the parent job has its full 30-day retry window', async () => {
    const db = database();
    insertTerminalBatch(db, {
      jobId: 'job-recent-parent', stage: '7', providerBatchId: 'batch-old-stage',
      files: ['input-old-stage'],
      jobCompletedAt: '2026-08-10T12:00:00.000Z',
      batchCompletedAt: '2025-01-01T00:00:00.000Z',
    });

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).not.toHaveBeenCalled();
    db.close();
  });

  it('deletes a newly settled terminal Batch once the parent retry window is already over', async () => {
    const db = database();
    insertTerminalBatch(db, {
      jobId: 'job-old-parent', stage: '8', providerBatchId: 'batch-recent-stage',
      files: ['input-recent-stage'],
      jobCompletedAt: '2026-06-01T00:00:00.000Z',
      batchCompletedAt: '2026-08-22T12:00:00.000Z',
    });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      providerBatchId: 'batch-recent-stage',
      fileIds: ['input-recent-stage'],
    });
    db.close();
  });

  it('normalizes mixed SQLite and ISO timestamps when reporting backlog age', async () => {
    const db = database();
    insertTerminalBatch(db, {
      jobId: 'job-iso-oldest', stage: 'a', providerBatchId: 'batch-iso-oldest',
      files: ['input-iso-oldest'], completedAt: '2025-01-02T00:00:00.000Z',
    });
    insertTerminalBatch(db, {
      jobId: 'job-sqlite-later', stage: 'b', providerBatchId: 'batch-sqlite-later',
      files: ['input-sqlite-later'], completedAt: '2025-01-02 23:00:00',
    });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockRejectedValue(
      new Error('provider unavailable'),
    );

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), limit: 1, maxPages: 1,
    })).resolves.toMatchObject({
      backlog: {
        eligible: 2,
        oldestEligibleAt: '2025-01-02T00:00:00.000Z',
        oldestEligibleAgeDays: 598,
      },
    });
    db.close();
  });

  it('drains provider-file pages past failures and reports the remaining backlog', async () => {
    const db = database();
    for (const [jobId, stage] of [['job-a', '1'], ['job-b', '2'], ['job-c', '3']] as const) {
      insertTerminalBatch(db, {
        jobId,
        stage,
        providerBatchId: `batch-${jobId}`,
        files: [`input-${jobId}`],
        completedAt: '2025-01-01T00:00:00.000Z',
      });
    }
    registryMocks.provider.deleteStructuredGenerationBatchFiles
      .mockRejectedValueOnce(new Error('provider delete failed'))
      .mockResolvedValue(undefined);

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), limit: 1, maxPages: 3,
    })).resolves.toMatchObject({
      deleted: 2,
      failed: 1,
      pages: 3,
      backlog: { eligible: 1, oldestEligibleAt: '2025-01-01T00:00:00.000Z' },
    });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledTimes(3);

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), limit: 1,
    })).resolves.toMatchObject({ deleted: 1, failed: 0, backlog: { eligible: 0 } });
    db.close();
  });

  it('advances the aged-intent cursor past a failing leading page', async () => {
    const db = database();
    for (const [jobId, stage] of [
      ['job-intent-a', 'a'], ['job-intent-b', 'b'], ['job-intent-c', 'c'],
    ] as const) {
      const stageKey = stage.repeat(64);
      insertJob(db, jobId, { status: 'failed', leaseToken: null });
      db.prepare(`UPDATE content_script_jobs SET updated_at = '2026-06-01T00:00:00.000Z'
        WHERE job_id = ?`).run(jobId);
      db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_intent_filename, input_file_intent_at, status, updated_at
      ) VALUES (?, 42, 42, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z',
        'preparing', '2026-06-01T00:00:00.000Z')`)
        .run(jobId, stageKey, 'd'.repeat(64), stageKey, `${stageKey}.jsonl`);
    }
    registryMocks.provider.reconcileStructuredGenerationBatchIntent
      .mockRejectedValueOnce(new Error('leading provider inventory failure'))
      .mockResolvedValue({});

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), limit: 1, maxPages: 3,
    })).resolves.toMatchObject({
      deleted: 0,
      failed: 3,
      pages: 3,
      backlog: { blockedActive: 3 },
    });
    expect(registryMocks.provider.reconcileStructuredGenerationBatchIntent).toHaveBeenCalledTimes(3);
    expect(db.prepare(`SELECT job_id, input_file_intent_absence_count AS observations
      FROM content_script_provider_batches ORDER BY job_id`).all()).toEqual([
      { job_id: 'job-intent-a', observations: 0 },
      { job_id: 'job-intent-b', observations: 1 },
      { job_id: 'job-intent-c', observations: 1 },
    ]);
    db.close();
  });

  it('alternates one-page sweeps so unresolved intents cannot starve known files', async () => {
    const db = database();
    const stageKey = 'f'.repeat(64);
    insertJob(db, 'job-fair-intent', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-fair-intent'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_intent_filename, input_file_intent_at, status, updated_at
    ) VALUES (
      'job-fair-intent', 42, 42, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z',
      'preparing', '2026-06-01T00:00:00.000Z'
    )`).run(stageKey, 'd'.repeat(64), stageKey, `${stageKey}.jsonl`);
    insertTerminalBatch(db, {
      jobId: 'job-fair-file', stage: 'e', providerBatchId: 'batch-fair-file',
      files: ['input-fair-file'], completedAt: '2026-06-01T00:00:00.000Z',
    });
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockResolvedValue({});
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValue(undefined);

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'), limit: 1, maxPages: 1,
    })).resolves.toMatchObject({ deleted: 0, failed: 1, pages: 1 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).not.toHaveBeenCalled();

    await expect(drainExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:01:00.000Z'), limit: 1, maxPages: 1,
    })).resolves.toMatchObject({ deleted: 1, pages: 1 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT next_branch FROM content_script_provider_retention_control
      WHERE singleton = 1`).get()).toEqual({ next_branch: 'intent' });
    db.close();
  });

  it('deletes an uploaded input file when the parent became terminal before Batch creation', async () => {
    const db = database();
    insertJob(db, 'job-upload-only', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs
      SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-upload-only'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_id, status, updated_at
    ) VALUES (
      'job-upload-only', 42, 42, ?, ?, 'custom-upload-only',
      'input-upload-only', 'preparing', '2026-06-01T00:00:00.000Z'
    )`).run('a'.repeat(64), 'd'.repeat(64));
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      fileIds: ['input-upload-only'],
    });
    expect(db.prepare(`SELECT provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-upload-only'`).get()).toEqual({
      provider_files_deleted_at: '2026-08-23T12:00:00.000Z',
    });
    db.close();
  });

  it('reconciles an aged terminal upload intent before recording provider absence', async () => {
    const db = database();
    const stageKey = '6'.repeat(64);
    insertJob(db, 'job-aged-intent', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs
      SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-aged-intent'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_intent_filename, input_file_intent_at, status, updated_at
    ) VALUES (
      'job-aged-intent', 42, 42, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z',
      'preparing', '2026-06-01T00:00:00.000Z'
    )`).run(stageKey, 'd'.repeat(64), stageKey, `${stageKey}.jsonl`);
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockResolvedValue({});

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 0, failed: 1 });
    expect(db.prepare(`SELECT input_file_intent_absence_count, provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-aged-intent'`).get())
      .toEqual({ input_file_intent_absence_count: 1, provider_files_deleted_at: null });

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:01:00.000Z'),
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(db.prepare(`SELECT input_file_intent_absence_confirmed_at,
        provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-aged-intent'`).get())
      .toEqual({
        input_file_intent_absence_confirmed_at: '2026-08-23T12:01:00.000Z',
        provider_files_deleted_at: '2026-08-23T12:01:00.000Z',
      });
    expect(registryMocks.provider.reconcileStructuredGenerationBatchIntent).toHaveBeenCalledTimes(2);
    db.close();
  });

  it('deletes an eventually visible provider file instead of confirming prior absence', async () => {
    const db = database();
    const stageKey = '7'.repeat(64);
    insertJob(db, 'job-eventual-intent', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-eventual-intent'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_intent_filename, input_file_intent_at, status, updated_at
    ) VALUES ('job-eventual-intent', 42, 42, ?, ?, ?, ?,
      '2026-06-01T00:00:00.000Z', 'preparing', '2026-06-01T00:00:00.000Z')`)
      .run(stageKey, 'd'.repeat(64), stageKey, `${stageKey}.jsonl`);
    registryMocks.provider.reconcileStructuredGenerationBatchIntent
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ inputFileId: 'eventually-visible-input' });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 0, failed: 1 });
    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:01:00.000Z'),
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      fileIds: ['eventually-visible-input'],
    });
    expect(db.prepare(`SELECT input_file_intent_absence_count,
        input_file_intent_absence_confirmed_at, provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-eventual-intent'`).get())
      .toEqual({
        input_file_intent_absence_count: 0,
        input_file_intent_absence_confirmed_at: null,
        provider_files_deleted_at: '2026-08-23T12:01:00.000Z',
      });
    db.close();
  });

  it('does not delete a known input until an aged Batch-create intent has absence proof', async () => {
    const db = database();
    const stageKey = '8'.repeat(64);
    insertJob(db, 'job-aged-create-intent', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-aged-create-intent'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_intent_filename, input_file_intent_at, input_file_id,
      batch_create_intent_at, status, updated_at
    ) VALUES ('job-aged-create-intent', 42, 42, ?, ?, ?, ?,
      '2026-06-01T00:00:00.000Z', 'aged-create-input',
      '2026-06-01T00:01:00.000Z', 'preparing', '2026-06-01T00:01:00.000Z')`)
      .run(stageKey, 'd'.repeat(64), stageKey, `${stageKey}.jsonl`);
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockResolvedValue({
      inputFileId: 'aged-create-input',
    });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 0, failed: 1 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).not.toHaveBeenCalled();
    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:01:00.000Z'),
    })).resolves.toEqual({ deleted: 1, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      fileIds: ['aged-create-input'],
    });
    db.close();
  });

  it('does not prune files from a provider Batch that is still active after its parent became terminal', async () => {
    const db = database();
    insertJob(db, 'job-active-batch', { status: 'failed', leaseToken: null });
    db.prepare(`UPDATE content_script_jobs
      SET updated_at = '2026-06-01T00:00:00.000Z'
      WHERE job_id = 'job-active-batch'`).run();
    db.prepare(`INSERT INTO content_script_provider_batches (
      job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
      input_file_id, provider_batch_id, status, submitted_at, updated_at
    ) VALUES (
      'job-active-batch', 42, 42, ?, ?, 'custom-active-batch',
      'input-active-batch', 'batch-active', 'in_progress',
      '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z'
    )`).run('b'.repeat(64), 'd'.repeat(64));

    await expect(pruneExpiredContentScriptBatchFiles(db, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toEqual({ deleted: 0, failed: 0 });
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-active-batch'`).get()).toEqual({
      provider_files_deleted_at: null,
    });
    db.close();
  });

  it('reconciles crash-window intents before account-deletion cancellation and file deletion', async () => {
    const db = database();
    const stageKey = 'a'.repeat(64);
    insertJob(db, 'job-account-intent', { status: 'cancelled', leaseToken: null });
    db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_intent_filename, input_file_intent_at, batch_create_intent_at,
        status, updated_at
      ) VALUES ('job-account-intent', 42, 42, ?, ?, ?, ?, ?, ?, 'preparing', ?)`)
      .run(
        stageKey,
        'd'.repeat(64),
        stageKey,
        `${stageKey}.jsonl`,
        '2026-08-23T11:58:00.000Z',
        '2026-08-23T11:59:00.000Z',
        '2026-08-23T12:00:00.000Z',
      );
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockResolvedValueOnce({
      inputFileId: 'recovered-account-input',
      providerBatchId: 'recovered-account-batch',
      status: 'in_progress',
    });
    registryMocks.provider.cancelStructuredGenerationBatch.mockResolvedValueOnce({ status: 'cancelled' });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(cleanupContentScriptProviderFilesForAccountDeletion(db, 42, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toBe(1);
    expect(registryMocks.provider.reconcileStructuredGenerationBatchIntent).toHaveBeenCalledWith({
      stageKey,
      requestDigest: 'd'.repeat(64),
      customId: stageKey,
      inputFileIntentFilename: `${stageKey}.jsonl`,
      batchCreateIntent: true,
    });
    expect(registryMocks.provider.reconcileStructuredGenerationBatchIntent.mock.invocationCallOrder[0])
      .toBeLessThan(registryMocks.provider.cancelStructuredGenerationBatch.mock.invocationCallOrder[0]);
    expect(registryMocks.provider.cancelStructuredGenerationBatch.mock.invocationCallOrder[0])
      .toBeLessThan(registryMocks.provider.deleteStructuredGenerationBatchFiles.mock.invocationCallOrder[0]);
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      providerBatchId: 'recovered-account-batch',
      fileIds: ['recovered-account-input'],
    });
    db.close();
  });

  it('requires grace plus two independent absence observations before account deletion proof', async () => {
    const db = database();
    const stageKey = 'e'.repeat(64);
    insertJob(db, 'job-account-empty-intent', { status: 'cancelled', leaseToken: null });
    db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_intent_filename, input_file_intent_at, status, updated_at
      ) VALUES ('job-account-empty-intent', 42, 42, ?, ?, ?, ?, ?, 'preparing', ?)`)
      .run(
        stageKey,
        'd'.repeat(64),
        stageKey,
        `${stageKey}.jsonl`,
        '2026-08-23T11:30:00.000Z',
        '2026-08-23T12:00:00.000Z',
      );
    registryMocks.provider.reconcileStructuredGenerationBatchIntent.mockResolvedValue({});

    await expect(cleanupContentScriptProviderFilesForAccountDeletion(db, 42, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).rejects.toThrow('content_script_account_batch_intent_visibility_pending');
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT input_file_intent_absence_count,
        input_file_intent_absence_observed_at, provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-account-empty-intent'`).get())
      .toEqual({
        input_file_intent_absence_count: 1,
        input_file_intent_absence_observed_at: '2026-08-23T12:00:00.000Z',
        provider_files_deleted_at: null,
      });

    await expect(cleanupContentScriptProviderFilesForAccountDeletion(db, 42, {
      now: new Date('2026-08-23T12:01:00.000Z'),
    })).resolves.toBe(0);
    expect(db.prepare(`SELECT input_file_intent_absence_count,
        input_file_intent_absence_confirmed_at, provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-account-empty-intent'`).get())
      .toEqual({
        input_file_intent_absence_count: 2,
        input_file_intent_absence_confirmed_at: '2026-08-23T12:01:00.000Z',
        provider_files_deleted_at: '2026-08-23T12:01:00.000Z',
      });
    db.close();
  });

  it('cancels active account-owned Batches and proves file deletion before erasure', async () => {
    const db = database();
    insertJob(db, 'job-account-delete', { status: 'cancelled', leaseToken: null });
    db.prepare(`INSERT INTO content_script_provider_batches (
        job_id, tenant_id, owner_user_id, stage_key, request_digest, custom_id,
        input_file_id, provider_batch_id, status, updated_at
      ) VALUES ('job-account-delete', 42, 42, ?, ?, 'custom-account-delete',
        'input-account-delete', 'batch-account-delete', 'cancellation_requested',
        '2026-08-23T12:00:00.000Z')`)
      .run('c'.repeat(64), 'd'.repeat(64));
    registryMocks.provider.cancelStructuredGenerationBatch.mockResolvedValueOnce({
      status: 'cancelled', errorFileId: 'error-account-delete',
    });
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockResolvedValueOnce(undefined);

    await expect(cleanupContentScriptProviderFilesForAccountDeletion(db, 42, {
      now: new Date('2026-08-23T12:00:00.000Z'),
    })).resolves.toBe(1);
    expect(registryMocks.provider.cancelStructuredGenerationBatch).toHaveBeenCalledOnce();
    expect(registryMocks.provider.deleteStructuredGenerationBatchFiles).toHaveBeenCalledWith({
      providerBatchId: 'batch-account-delete',
      fileIds: ['input-account-delete', 'error-account-delete'],
    });
    expect(db.prepare(`SELECT status, provider_files_deleted_at
      FROM content_script_provider_batches WHERE job_id = 'job-account-delete'`).get()).toEqual({
      status: 'cancelled',
      provider_files_deleted_at: '2026-08-23T12:00:00.000Z',
    });
    db.close();
  });
});
