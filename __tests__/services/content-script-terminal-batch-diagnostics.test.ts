import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '../../src/services/ai-provider';
import { inspectContentScriptTerminalBatchDiagnostics } from '../../src/services/content-script-terminal-batch-diagnostics';

const JOB_A = 'script_job_00000000-0000-4000-8000-00000000000a';
const JOB_B = 'script_job_00000000-0000-4000-8000-00000000000b';
const JOB_OTHER = 'script_job_00000000-0000-4000-8000-00000000000c';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE content_script_jobs (
      job_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      last_error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE content_script_provider_batches (
      job_id TEXT NOT NULL,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      provider_batch_id TEXT,
      status TEXT NOT NULL,
      last_error_code TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );`);
  return db;
}

function insertCandidate(db: Database.Database, jobId: string, batchId: string, timestamp: string): void {
  db.prepare(`INSERT INTO content_script_jobs
      (job_id, tenant_id, owner_user_id, status, last_error_code, completed_at, updated_at)
      VALUES (?, 42, 42, 'failed', 'OPENAI_BATCH_FAILED', ?, ?)`)
    .run(jobId, timestamp, timestamp);
  db.prepare(`INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES (?, 42, 42, ?, ?, 'failed', 'invalid_request', ?, ?)`)
    .run(jobId, 'a'.repeat(64), batchId, timestamp, timestamp);
}

describe('terminal content-script Batch diagnostics', () => {
  it('retrieves only the latest bounded candidates and returns content-free fields', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    insertCandidate(db, JOB_B, 'batch-b', '2026-08-28T16:01:00.000Z');
    insertCandidate(db, JOB_OTHER, 'batch-unrelated', '2026-08-28T16:02:00.000Z');
    db.prepare(`INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES (?, 42, 42, ?, 'batch-a-old', 'failed', 'invalid_request',
        '2026-08-28T15:00:00.000Z', '2026-08-28T15:00:00.000Z')`)
      .run(JOB_A, '0'.repeat(64));
    db.prepare(`INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES (?, 99, 42, ?, 'batch-cross-tenant', 'failed', 'invalid_request',
        '2026-08-28T17:00:00.000Z', '2026-08-28T17:00:00.000Z')`)
      .run(JOB_A, 'f'.repeat(64));
    db.prepare(`INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES (?, 42, 99, ?, 'batch-cross-owner', 'failed', 'invalid_request',
        '2026-08-28T17:01:00.000Z', '2026-08-28T17:01:00.000Z')`)
      .run(JOB_A, 'e'.repeat(64));
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        status: 'failed', errorCode: 'invalid_request', errorLine: 1,
        errorParam: 'body.messages[0].role', message: 'private',
      })
      .mockResolvedValueOnce({
        status: 'failed', errorCode: 'invalid_request', errorLine: 1,
        errorParam: 'body.response_format', message: 'private',
      });
    const result = await inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 2,
      jobIds: [JOB_A, JOB_B],
      since: new Date('2026-08-28T00:00:00.000Z'),
    });

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({ providerBatchId: 'batch-a-old' }));
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({ providerBatchId: 'batch-unrelated' }));
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({ providerBatchId: 'batch-cross-tenant' }));
    expect(inspect).not.toHaveBeenCalledWith(expect.objectContaining({ providerBatchId: 'batch-cross-owner' }));
    expect(result).toEqual({
      schema: 'nexus.content-script-terminal-batch-diagnostic.v1',
      selected: 2,
      diagnostics: [
        { errorCode: 'invalid_request', errorLine: 1, errorParam: 'body.messages[].role' },
        { errorCode: 'invalid_request', errorLine: 1, errorParam: 'body.response_format' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private');
    db.close();
  });

  it('fails closed before provider reads when the exact candidate count differs', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    const inspect = vi.fn();

    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 2,
      jobIds: [JOB_A, JOB_B],
      since: new Date('2026-08-28T00:00:00.000Z'),
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_candidate_count_mismatch');
    expect(inspect).not.toHaveBeenCalled();
    db.close();
  });

  it('fails closed when the latest same-scope provider row is not the target failure', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    db.prepare(`INSERT INTO content_script_provider_batches
      (job_id, tenant_id, owner_user_id, stage_key, provider_batch_id, status,
       last_error_code, completed_at, updated_at)
      VALUES (?, 42, 42, ?, 'batch-newer-other-failure', 'failed', 'rate_limit',
        '2026-08-28T17:00:00.000Z', '2026-08-28T17:00:00.000Z')`)
      .run(JOB_A, 'f'.repeat(64));
    const inspect = vi.fn();

    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('2026-08-28T00:00:00.000Z'),
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_candidate_count_mismatch');
    expect(inspect).not.toHaveBeenCalled();
    db.close();
  });

  it('rejects duplicate, padded, and out-of-bounds job selections before provider reads', async () => {
    const db = database();
    const inspect = vi.fn();
    const provider = { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider;
    const since = new Date('2026-08-28T00:00:00.000Z');

    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db, provider, expectedCount: 2, jobIds: [JOB_A, JOB_A], since,
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_job_identity_invalid');
    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db, provider, expectedCount: 1, jobIds: [` ${JOB_A}`], since,
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_job_identity_invalid');
    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db, provider, expectedCount: 0, jobIds: [], since,
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_expected_count_invalid');
    expect(inspect).not.toHaveBeenCalled();
    db.close();
  });

  it('rejects unsafe provider fields and status drift', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    const inspect = vi.fn().mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'invalid request with private text',
      errorLine: 0,
      errorParam: 'body.messages[0].content\nprivate',
    });
    const result = await inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('2026-08-28T00:00:00.000Z'),
    });
    expect(result.diagnostics).toEqual([{ errorCode: null, errorLine: null, errorParam: null }]);

    inspect.mockResolvedValueOnce({ status: 'completed', errorCode: 'invalid_request' });
    await expect(inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('2026-08-28T00:00:00.000Z'),
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_status_mismatch');
    db.close();
  });

  it('normalizes identifier-shaped provider fields into closed semantic categories', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    const inspect = vi.fn().mockResolvedValueOnce({
      status: 'failed',
      errorCode: 'batch_abc123',
      errorLine: 1,
      errorParam: 'body.messages[0].content.batch_abc123',
    });
    const result = await inspectContentScriptTerminalBatchDiagnostics({
      db,
      provider: { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('2026-08-28T00:00:00.000Z'),
    });

    expect(result.diagnostics).toEqual([{
      errorCode: null,
      errorLine: 1,
      errorParam: 'body.messages[].content',
    }]);
    expect(JSON.stringify(result)).not.toContain('batch_abc123');
    db.close();
  });

  it('normalizes absent and nested schema parameters without retaining provider text', async () => {
    const db = database();
    insertCandidate(db, JOB_A, 'batch-a', '2026-08-28T16:00:00.000Z');
    const inspect = vi.fn()
      .mockResolvedValueOnce({
        status: 'failed', errorCode: 'invalid_request', errorLine: 1,
      })
      .mockResolvedValueOnce({
        status: 'failed', errorCode: 'invalid_request', errorLine: 1,
        errorParam: 'body.response_format.json_schema.schema.properties.private_field',
      });
    const provider = { inspectStructuredGenerationBatch: inspect } as unknown as AIProvider;
    const request = {
      db,
      provider,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('2026-08-28T00:00:00.000Z'),
    };

    await expect(inspectContentScriptTerminalBatchDiagnostics(request)).resolves.toMatchObject({
      diagnostics: [{ errorParam: null }],
    });
    await expect(inspectContentScriptTerminalBatchDiagnostics(request)).resolves.toMatchObject({
      diagnostics: [{ errorParam: 'body.response_format.json_schema.schema' }],
    });
    db.close();
  });

  it('rejects an invalid recency clock and an unavailable inspection capability', async () => {
    const db = database();
    const request = {
      db,
      expectedCount: 1,
      jobIds: [JOB_A],
      since: new Date('invalid'),
    };

    await expect(inspectContentScriptTerminalBatchDiagnostics({
      ...request,
      provider: {} as AIProvider,
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_since_invalid');
    await expect(inspectContentScriptTerminalBatchDiagnostics({
      ...request,
      since: new Date('2026-08-28T00:00:00.000Z'),
      provider: {} as AIProvider,
    })).rejects.toThrow('content_script_terminal_batch_diagnostic_provider_unavailable');
    db.close();
  });
});
