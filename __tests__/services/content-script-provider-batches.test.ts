// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMocks = vi.hoisted(() => ({
  provider: {
    cancelStructuredGenerationBatch: vi.fn(),
    deleteStructuredGenerationBatchFiles: vi.fn(),
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
  createContentScriptBatchControl,
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
      cancellation_requested_at TEXT
    );
  `);
  db.exec(migrationSql);
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
  input: { jobId: string; stage: string; providerBatchId: string; completedAt?: string; files?: string[] },
): void {
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
      input.completedAt ?? '2026-06-01T00:00:00.000Z',
      input.completedAt ?? '2026-06-01T00:00:00.000Z',
    );
}

describe('content script provider Batch durability', () => {
  beforeEach(async () => {
    registryMocks.getProvider.mockReset();
    registryMocks.getProvider.mockReturnValue(registryMocks.provider);
    registryMocks.provider.cancelStructuredGenerationBatch.mockReset();
    registryMocks.provider.deleteStructuredGenerationBatchFiles.mockReset();
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

  it('allows a lost lease only for an explicit cancellation transition', () => {
    const db = database();
    insertJob(db, 'job-lease', {
      status: 'cancelled',
      leaseToken: null,
      cancellationRequestedAt: '2026-08-23T12:00:00.000Z',
    });
    const batch = control(db, 'job-lease', 'b');
    expect(() => batch.persist({
      requestDigest: 'd'.repeat(64),
      customId: 'custom-lease',
      status: 'completed',
      inputFileId: 'file-lease',
      providerBatchId: 'batch-lease',
    })).toThrow('content_script_batch_lease_lost');
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
    db.close();
  });
});
