// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
  executeChatDomainHandler: vi.fn(),
  rememberChatActiveDomain: vi.fn(),
  finalizeChatAnswerMetadata: vi.fn(),
  storeChatMessage: vi.fn(),
  withAiBudgetReservation: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../../src/api/routes/chat-message-context', async () => ({
  ...(await vi.importActual('../../src/api/routes/chat-message-context')),
  getChatDomainHandler: vi.fn(() => mocks.handler),
  rememberChatActiveDomain: (...args: unknown[]) => mocks.rememberChatActiveDomain(...args),
}));

vi.mock('../../src/api/routes/chat-message-execution', async () => ({
  ...(await vi.importActual('../../src/api/routes/chat-message-execution')),
  executeChatDomainHandler: (...args: unknown[]) => mocks.executeChatDomainHandler(...args),
}));

vi.mock('../../src/api/routes/chat-message-finalizer', async () => ({
  ...(await vi.importActual('../../src/api/routes/chat-message-finalizer')),
  finalizeChatAnswerMetadata: (...args: unknown[]) => mocks.finalizeChatAnswerMetadata(...args),
}));

vi.mock('../../src/services/chat-history-store', async () => ({
  ...(await vi.importActual('../../src/services/chat-history-store')),
  storeChatMessage: (...args: unknown[]) => mocks.storeChatMessage(...args),
}));

vi.mock('../../src/services/cost-guardrail', async () => ({
  ...(await vi.importActual('../../src/services/cost-guardrail')),
  withAiBudgetReservation: (...args: unknown[]) => mocks.withAiBudgetReservation(...args),
}));

vi.mock('../../src/services/apns-sender', async () => ({
  ...(await vi.importActual('../../src/services/apns-sender')),
  sendPushNotification: (...args: unknown[]) => mocks.push(...args),
}));

import { ensureBackgroundJobTables, type JobRecord } from '../../src/services/background-job-queue';
import {
  CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
  attachLateChatLegacyTimeoutResult,
  cancelChatLegacyTimeoutContinuationsForScope,
  enqueueChatLegacyTimeoutContinuation,
  markChatLegacyTimeoutForegroundFailure,
  processChatLegacyTimeoutContinuationJob,
} from '../../src/services/chat-legacy-timeout-continuation';

const NOW = new Date('2026-07-22T10:00:00.000Z');

function readJob(jobId: string): JobRecord {
  const row = testDb.prepare('SELECT * FROM background_jobs WHERE job_id = ?').get(jobId) as Record<string, unknown>;
  return {
    jobId: String(row.job_id),
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    jobType: String(row.job_type),
    payload: JSON.parse(String(row.payload_json)),
    priority: Number(row.priority),
    status: row.status as JobRecord['status'],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    notBefore: String(row.not_before),
    lockedAt: row.locked_at as string | null,
    lockOwner: row.lock_owner as string | null,
    idempotencyKey: String(row.idempotency_key),
    correlationId: row.correlation_id as string | null,
    causationEventId: row.causation_event_id as string | null,
    createdAt: String(row.created_at),
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    lastError: row.last_error as string | null,
  };
}

function enqueue(overrides: Partial<Parameters<typeof enqueueChatLegacyTimeoutContinuation>[0]> = {}) {
  return enqueueChatLegacyTimeoutContinuation({
    tenantId: 42,
    userId: 42,
    sourceRunId: 'run-timeout-1',
    sourceMessageId: 'msg-user-1',
    sourceText: 'plan my day',
    domain: 'secretary',
    locale: 'en-US',
    completedTools: ['get_calendar_events'],
    now: NOW,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  ensureBackgroundJobTables(testDb);
  vi.clearAllMocks();
  mocks.withAiBudgetReservation.mockImplementation(async (_request: unknown, fn: () => Promise<unknown>) => fn());
  mocks.finalizeChatAnswerMetadata.mockImplementation((input: { responseText: string; existingMetadata: Record<string, unknown> }) => ({
    text: input.responseText,
    metadata: input.existingMetadata,
    contract: {},
  }));
  mocks.push.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
});

afterEach(() => {
  testDb.close();
});

describe('chat legacy timeout continuation', () => {
  it('durably enqueues one tenant-scoped APNs continuation without making it runnable while the foreground call is outstanding', () => {
    const first = enqueue();
    const replay = enqueue();
    expect(replay.jobId).toBe(first.jobId);

    const job = readJob(first.jobId);
    expect(job).toMatchObject({
      tenantId: 42,
      userId: 42,
      jobType: CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE,
      status: 'pending',
      maxAttempts: 2,
      correlationId: 'run-timeout-1',
    });
    expect(job.notBefore).toBe('2026-07-22 10:15:00');
    expect(job.payload).toMatchObject({
      sourceRunId: 'run-timeout-1',
      foregroundState: 'running',
      recoveryPolicy: 'late_result_or_fail_honestly',
      notificationPolicy: 'apns',
      destructiveResumePolicy: 'reconfirm',
      completedTools: ['get_calendar_events'],
    });
  });

  it('attaches a late foreground result only under the exact tenant/user/run scope', () => {
    const queued = enqueue();
    const wrongTenant = attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 99,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'late answer', domain: 'secretary' },
      now: NOW,
    });
    expect(wrongTenant).toBe(false);

    const attached = attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'late answer', domain: 'secretary' },
      now: NOW,
    });
    expect(attached).toBe(true);
    expect(readJob(queued.jobId).payload).toMatchObject({
      lateResult: { text: 'late answer', domain: 'secretary' },
    });
  });

  it('uses the late foreground result without another model call and persists/APNs once', async () => {
    const queued = enqueue();
    attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'late answer', domain: 'secretary' },
      now: NOW,
    });

    const result = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    });
    expect(result).toMatchObject({ source: 'late_foreground_result', apnsPushed: true });
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.storeChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 42,
      userId: 42,
      retryOfMessageId: 'msg-user-1',
      routeMethod: 'legacy-timeout-background',
      text: 'late answer',
    }));
    expect(mocks.push).toHaveBeenCalledWith(42, expect.objectContaining({
      collapseId: `${CHAT_LEGACY_TIMEOUT_CONTINUATION_JOB_TYPE}:run-timeout-1`,
      body: 'Open Nexus to view the completed answer.',
    }));
    expect(JSON.stringify(mocks.push.mock.calls[0]?.[1])).not.toContain('late answer');

    const retry = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:25.000Z'),
      pushNotification: mocks.push,
    });
    expect(retry).toMatchObject({ source: 'late_foreground_result', apnsPushed: false, apnsAlreadyDelivered: true });
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('leaves a pure transient APNs result undelivered and retries it under a new queue lease', async () => {
    const queued = enqueue({ sourceRunId: 'run-timeout-apns-retry' });
    attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-apns-retry',
      result: { text: 'private calendar result', domain: 'secretary' },
      now: NOW,
    });
    mocks.push.mockResolvedValueOnce({ sent: 0, failed: 0, skipped: 0, retriable: 1, unregistered: [] });

    await expect(processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    })).rejects.toThrow('chat_legacy_timeout_continuation_apns_retryable');
    expect(readJob(queued.jobId).payload).toMatchObject({
      delivery: { apnsState: 'retryable' },
    });
    expect((readJob(queued.jobId).payload.delivery as Record<string, unknown>).apnsDeliveredAt).toBeUndefined();

    testDb.prepare(`
      UPDATE background_jobs
         SET status = 'processing', attempts = 1,
             locked_at = '2026-07-22 10:00:30', lock_owner = 'retry-worker'
       WHERE job_id = ?
    `).run(queued.jobId);
    mocks.push.mockResolvedValueOnce({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    const retry = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:31.000Z'),
      pushNotification: mocks.push,
    });
    expect(retry).toMatchObject({ apnsPushed: true, apnsOutcome: 'sent' });
    expect(mocks.push).toHaveBeenCalledTimes(2);
    expect(mocks.storeChatMessage).toHaveBeenCalledTimes(1);
  });

  it('treats mixed accepted/transient APNs fan-out as terminal partial success to avoid duplicating accepted devices', async () => {
    const queued = enqueue({ sourceRunId: 'run-timeout-apns-mixed' });
    attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-apns-mixed',
      result: { text: 'late answer', domain: 'secretary' },
      now: NOW,
    });
    mocks.push.mockResolvedValueOnce({ sent: 1, failed: 0, skipped: 0, retriable: 1, unregistered: [] });

    const result = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    });
    expect(result).toMatchObject({
      apnsPushed: true,
      apnsOutcome: 'partial_sent_no_retry',
    });
    expect(readJob(queued.jobId).payload).toMatchObject({
      delivery: {
        apnsState: 'delivered',
        apnsOutcome: 'partial_sent_no_retry',
      },
    });

    await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:25.000Z'),
      pushNotification: mocks.push,
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('fences a stale APNs sender so lease recovery never starts a duplicate external send', async () => {
    const queued = enqueue({ sourceRunId: 'run-timeout-stale-fence' });
    attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-stale-fence',
      result: { text: 'late answer', domain: 'secretary' },
      now: NOW,
    });
    testDb.prepare(`
      UPDATE background_jobs
         SET status = 'processing', attempts = 1,
             locked_at = '2026-07-22 10:00:00', lock_owner = 'old-worker'
       WHERE job_id = ?
    `).run(queued.jobId);
    const firstSend = deferred<{ sent: number; failed: number; skipped: number; retriable: number; unregistered: string[] }>();
    mocks.push.mockImplementationOnce(() => firstSend.promise);
    const staleWorker = processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    });
    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));

    testDb.prepare(`
      UPDATE background_jobs
         SET status = 'processing', attempts = 2,
             locked_at = '2026-07-22 10:16:00', lock_owner = 'recovery-worker'
       WHERE job_id = ?
    `).run(queued.jobId);
    const recovery = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:16:01.000Z'),
      pushNotification: mocks.push,
    });
    expect(recovery).toMatchObject({
      apnsPushed: false,
      apnsOutcome: 'indeterminate_stale_attempt',
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.storeChatMessage).toHaveBeenCalledTimes(1);

    firstSend.resolve({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    await expect(staleWorker).resolves.toMatchObject({
      apnsPushed: true,
      apnsOutcome: 'indeterminate_stale_attempt',
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('does not re-run the model/provider or any completed operation while the detached foreground promise is outstanding', async () => {
    const queued = enqueue();
    await expect(processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    })).rejects.toThrow('chat_legacy_timeout_continuation_foreground_still_running');
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.storeChatMessage).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('fails honestly after a definitive foreground failure, naming completed work without repeating it', async () => {
    const queued = enqueue();
    expect(markChatLegacyTimeoutForegroundFailure({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      error: new Error('provider socket closed with secret details'),
      now: NOW,
    })).toBe(true);
    expect(attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'must not overwrite the terminal failure', domain: 'secretary' },
      now: NOW,
    })).toBe(false);

    const result = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    });
    expect(result).toMatchObject({ source: 'foreground_failed', apnsPushed: true });
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(mocks.storeChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('get calendar events'),
      metadata: expect.objectContaining({
        source: 'foreground_failed',
        completedTools: ['get_calendar_events'],
        destructiveResumePolicy: 'reconfirm',
      }),
    }));
    expect(JSON.stringify(readJob(queued.jobId).payload)).not.toContain('secret details');
  });

  it('fails honestly at the durable deadline instead of starting a second provider call', async () => {
    const queued = enqueue();
    const result = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:15:00.001Z'),
      pushNotification: mocks.push,
    });
    expect(result.source).toBe('foreground_abandoned');
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
    expect(mocks.withAiBudgetReservation).not.toHaveBeenCalled();
  });

  it('accepts a late result for a processing lease only under exact scope, then consumes it without a second call', async () => {
    const queued = enqueue();
    testDb.prepare("UPDATE background_jobs SET status = 'processing', locked_at = datetime('now'), lock_owner = 'test-worker' WHERE job_id = ?")
      .run(queued.jobId);
    expect(attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 99,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'wrong scope', domain: 'secretary' },
      now: NOW,
    })).toBe(false);
    expect(attachLateChatLegacyTimeoutResult({
      jobId: queued.jobId,
      tenantId: 42,
      userId: 42,
      sourceRunId: 'run-timeout-1',
      result: { text: 'leased late answer', domain: 'secretary' },
      now: NOW,
    })).toBe(true);

    const result = await processChatLegacyTimeoutContinuationJob(readJob(queued.jobId), {
      now: new Date('2026-07-22T10:00:20.000Z'),
      pushNotification: mocks.push,
    });
    expect(result.source).toBe('late_foreground_result');
    expect(mocks.executeChatDomainHandler).not.toHaveBeenCalled();
  });

  it('cancels only the requested tenant/user continuation scope', () => {
    const first = enqueue();
    const second = enqueue({ tenantId: 77, sourceRunId: 'run-timeout-2' });
    expect(cancelChatLegacyTimeoutContinuationsForScope({ tenantId: 42, userId: 42 })).toBe(1);
    expect(readJob(first.jobId).status).toBe('canceled');
    expect(readJob(second.jobId).status).toBe('pending');
  });
});
