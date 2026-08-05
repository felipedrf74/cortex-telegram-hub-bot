import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cancelEvent,
  claimPendingEvents,
  emitDomainEvent,
  ensureEventOutboxTables,
  markEventFailed,
  markEventProcessed,
  processPendingEvents,
  replayEvent,
  renewEventLease,
} from '../../src/services/event-outbox';
import {
  BackgroundJobTerminalError,
  cancelJob,
  claimPendingJobs,
  enqueueJob,
  ensureBackgroundJobTables,
  isBackgroundJobTerminalError,
  markJobCompleted,
  markJobFailed,
  processPendingJobs,
  replayJob,
  renewJobLease,
} from '../../src/services/background-job-queue';

class TerminalJobProbeError extends BackgroundJobTerminalError {
  constructor() {
    super(
      'TERMINAL_PROBE_REQUIRES_REPAIR',
      'terminal probe requires manual repair',
    );
    this.name = 'TerminalJobProbeError';
  }
}

/** Exact claim SQL used by the c4195818 predecessor event worker. */
function predecessorClaimPendingEvents(
  db: Database.Database,
  lockOwner = 'predecessor-event-worker',
  limit = 1,
): unknown[] {
  return db.prepare(`
    UPDATE event_outbox
    SET status = 'processing',
        attempts = attempts + 1,
        locked_at = datetime('now'),
        lock_owner = ?
    WHERE sequence IN (
      SELECT sequence
      FROM event_outbox
      WHERE (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= datetime('now', ?)
        )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, created_at ASC, sequence ASC
      LIMIT ?
    )
    RETURNING *
  `).all(lockOwner, '-15 minutes', limit);
}

/** Exact claim SQL used by the c4195818 predecessor background-job worker. */
function predecessorClaimPendingJobs(
  db: Database.Database,
  lockOwner = 'predecessor-job-worker',
  limit = 1,
): unknown[] {
  return db.prepare(`
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
        (
          status IN ('pending', 'failed')
          AND not_before <= datetime('now')
        )
        OR (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND locked_at <= datetime('now', ?)
        )
      )
      ORDER BY CASE WHEN status = 'processing' THEN 1 ELSE 0 END, priority ASC, created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all(lockOwner, '-15 minutes', limit);
}

/** Exact terminal SQL used by the c4195818 predecessor event worker. */
function predecessorMarkEventProcessed(db: Database.Database, eventId: string): number {
  return db.prepare(`
    UPDATE event_outbox
       SET status = 'processed',
           processed_at = datetime('now'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = NULL
     WHERE event_id = ?
       AND status != 'canceled'
  `).run(eventId).changes;
}

/** Exact retryable-failure SQL shape used by the c4195818 predecessor event worker. */
function predecessorMarkEventFailed(db: Database.Database, eventId: string): number {
  return db.prepare(`
    UPDATE event_outbox
       SET status = 'failed',
           not_before = datetime('now', '+30 seconds'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = 'predecessor failure'
     WHERE event_id = ?
       AND status != 'canceled'
  `).run(eventId).changes;
}

/** Exact terminal SQL used by the c4195818 predecessor background-job worker. */
function predecessorMarkJobCompleted(db: Database.Database, jobId: string): number {
  return db.prepare(`
    UPDATE background_jobs
       SET status = 'completed',
           completed_at = datetime('now'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = NULL
     WHERE job_id = ?
       AND status != 'canceled'
  `).run(jobId).changes;
}

/** Exact retryable-failure SQL shape used by the c4195818 predecessor job worker. */
function predecessorMarkJobFailed(db: Database.Database, jobId: string): number {
  return db.prepare(`
    UPDATE background_jobs
       SET status = 'failed',
           not_before = datetime('now', '+30 seconds'),
           locked_at = NULL,
           lock_owner = NULL,
           last_error = 'predecessor failure'
     WHERE job_id = ?
  `).run(jobId).changes;
}

describe('event-backbone lease fencing across database connections', () => {
  let tempDir: string;
  let first: Database.Database;
  let second: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'nexus-event-fencing-'));
    const path = join(tempDir, 'queue.sqlite');
    first = new Database(path);
    first.pragma('journal_mode = WAL');
    first.pragma('busy_timeout = 5000');
    ensureEventOutboxTables(first);
    ensureBackgroundJobTables(first);
    second = new Database(path);
    second.pragma('journal_mode = WAL');
    second.pragma('busy_timeout = 5000');
  });

  afterEach(() => {
    if (second?.open) second.close();
    if (first?.open) first.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects stale event completion and failure after expiry and reclaim', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'fenced-event',
      idempotencyKey: 'fenced-event',
    }, first);
    const original = claimPendingEvents(1, 'event-worker-a', first)[0];
    expect(original).toMatchObject({
      eventId: event.eventId,
      lockOwner: 'event-worker-a',
    });
    expect(original.fencingToken).toEqual(expect.any(String));
    expect(original.leaseExpiresAt).toEqual(expect.any(String));

    second.prepare(`
      UPDATE event_outbox
         SET lease_expires_at = datetime('now', '-1 second')
       WHERE event_id = ?
    `).run(event.eventId);
    const replacement = claimPendingEvents(1, 'event-worker-b', second)[0];
    expect(replacement.fencingToken).not.toBe(original.fencingToken);

    expect(() => predecessorMarkEventProcessed(first, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorMarkEventFailed(first, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => markEventProcessed(original, first)).toThrow(/EVENT_OUTBOX_LEASE_LOST/);
    expect(() => markEventFailed(original, new Error('stale failure'), first))
      .toThrow(/EVENT_OUTBOX_LEASE_LOST/);

    expect(second.prepare(`
      SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken, last_error AS lastError
        FROM event_outbox WHERE event_id = ?
    `).get(event.eventId)).toEqual({
      status: 'processing',
      lockOwner: 'event-worker-b',
      fencingToken: replacement.fencingToken,
      lastError: null,
    });
    expect(markEventProcessed(replacement, second)).toBe(true);
    expect(() => predecessorMarkEventFailed(first, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(second.prepare(`
      SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken,
             lease_expires_at AS leaseExpiresAt
        FROM event_outbox WHERE event_id = ?
    `).get(event.eventId)).toEqual({
      status: 'processed',
      lockOwner: null,
      fencingToken: replacement.fencingToken,
      leaseExpiresAt: null,
    });
  });

  it('renews an event lease only for its current owner/token and prevents premature theft', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.probe',
      entityType: 'probe',
      entityId: 'event-heartbeat',
      idempotencyKey: 'event-heartbeat',
    }, first);
    const lease = claimPendingEvents(1, 'event-heartbeat-owner', first)[0];
    second.prepare(`
      UPDATE event_outbox
         SET locked_at = datetime('now', '-30 minutes'),
             lease_expires_at = datetime('now', '+1 minute')
       WHERE event_id = ?
    `).run(event.eventId);

    const renewedUntil = renewEventLease(lease, first);
    expect(renewedUntil).toEqual(expect.any(String));
    expect(claimPendingEvents(1, 'event-thief', second)).toEqual([]);

    second.prepare(`
      UPDATE event_outbox
         SET lease_expires_at = datetime('now', '-1 second')
       WHERE event_id = ?
    `).run(event.eventId);
    const replacement = claimPendingEvents(1, 'event-reaper', second)[0];
    expect(replacement.eventId).toBe(event.eventId);
    expect(() => renewEventLease(lease, first)).toThrow(/EVENT_OUTBOX_LEASE_LOST/);
  });

  it('heartbeats an event automatically while its async handler is in flight', async () => {
    const firstEvent = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.async_event',
      entityType: 'probe',
      entityId: 'async-event-heartbeat',
      idempotencyKey: 'async-event-heartbeat',
    }, first);
    const secondEvent = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.async_event',
      entityType: 'probe',
      entityId: 'queued-event-heartbeat',
      idempotencyKey: 'queued-event-heartbeat',
    }, first);
    const eventIds = [firstEvent.eventId, secondEvent.eventId];
    const seenFencingTokens: string[] = [];
    let queuedEventId = '';
    let invocation = 0;
    let signalStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseHandler = resolve; });

    const processing = processPendingEvents([{
      eventType: 'system.fencing.async_event',
      async handle(claimed) {
        seenFencingTokens.push(String(claimed.fencingToken));
        invocation += 1;
        if (invocation > 1) return;
        queuedEventId = eventIds.find((eventId) => eventId !== claimed.eventId) ?? '';
        second.prepare(`
          UPDATE event_outbox SET lease_expires_at = datetime('now', '+2 seconds')
           WHERE event_id = ?
        `).run(queuedEventId);
        signalStarted();
        await release;
      },
    }], {
      db: first,
      lockOwner: 'event-async-owner',
      heartbeatIntervalMs: 25,
      limit: 2,
    });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const remainingSeconds = second.prepare(`
      SELECT CAST((julianday(lease_expires_at) - julianday('now')) * 86400 AS INTEGER) AS seconds
        FROM event_outbox WHERE event_id = ?
    `).get(queuedEventId) as { seconds: number };
    const stolen = claimPendingEvents(1, 'event-async-thief', second);
    releaseHandler();
    const result = await processing;

    expect(remainingSeconds.seconds).toBeGreaterThan(10 * 60);
    expect(stolen).toEqual([]);
    expect(new Set(seenFencingTokens).size).toBe(2);
    expect(result).toEqual({ processed: 2, failed: 0, deadLetter: 0 });
  });

  it('rejects stale job completion and failure after expiry and reclaim', () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      idempotencyKey: 'fenced-job',
    }, first);
    const original = claimPendingJobs(1, 'job-worker-a', first)[0];
    expect(original).toMatchObject({ jobId: job.jobId, lockOwner: 'job-worker-a' });
    expect(original.fencingToken).toEqual(expect.any(String));
    expect(original.leaseExpiresAt).toEqual(expect.any(String));

    second.prepare(`
      UPDATE background_jobs
         SET lease_expires_at = datetime('now', '-1 second')
       WHERE job_id = ?
    `).run(job.jobId);
    const replacement = claimPendingJobs(1, 'job-worker-b', second)[0];
    expect(replacement.fencingToken).not.toBe(original.fencingToken);

    expect(() => predecessorMarkJobCompleted(first, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(() => predecessorMarkJobFailed(first, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(() => markJobCompleted(original, first)).toThrow(/BACKGROUND_JOB_LEASE_LOST/);
    expect(() => markJobFailed(original, new Error('stale failure'), first))
      .toThrow(/BACKGROUND_JOB_LEASE_LOST/);

    expect(second.prepare(`
      SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken, last_error AS lastError
        FROM background_jobs WHERE job_id = ?
    `).get(job.jobId)).toEqual({
      status: 'processing',
      lockOwner: 'job-worker-b',
      fencingToken: replacement.fencingToken,
      lastError: null,
    });
    expect(markJobCompleted(replacement, second)).toBe(true);
    expect(() => predecessorMarkJobFailed(first, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(second.prepare(`
      SELECT status, lock_owner AS lockOwner, fencing_token AS fencingToken,
             lease_expires_at AS leaseExpiresAt
        FROM background_jobs WHERE job_id = ?
    `).get(job.jobId)).toEqual({
      status: 'completed',
      lockOwner: null,
      fencingToken: replacement.fencingToken,
      leaseExpiresAt: null,
    });
  });

  it('renews a job lease only for its current owner/token and prevents premature theft', () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      idempotencyKey: 'job-heartbeat',
    }, first);
    const lease = claimPendingJobs(1, 'job-heartbeat-owner', first)[0];
    second.prepare(`
      UPDATE background_jobs
         SET locked_at = datetime('now', '-30 minutes'),
             lease_expires_at = datetime('now', '+1 minute')
       WHERE job_id = ?
    `).run(job.jobId);

    const renewedUntil = renewJobLease(lease, first);
    expect(renewedUntil).toEqual(expect.any(String));
    expect(claimPendingJobs(1, 'job-thief', second)).toEqual([]);

    second.prepare(`
      UPDATE background_jobs
         SET lease_expires_at = datetime('now', '-1 second')
       WHERE job_id = ?
    `).run(job.jobId);
    const replacement = claimPendingJobs(1, 'job-reaper', second)[0];
    expect(replacement.jobId).toBe(job.jobId);
    expect(() => renewJobLease(lease, first)).toThrow(/BACKGROUND_JOB_LEASE_LOST/);
  });

  it('preserves terminal-write grace for tokenless work already processing during migration', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.migration_grace_event',
      entityType: 'probe',
      entityId: 'migration-grace-event',
      idempotencyKey: 'migration-grace-event',
    }, first);
    claimPendingEvents(1, 'event-worker-before-migration', first);
    first.prepare(`
      UPDATE event_outbox
         SET fencing_token = NULL,
             lease_expires_at = datetime('now', '+15 minutes')
       WHERE event_id = ?
    `).run(event.eventId);

    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_migration_grace_job',
      idempotencyKey: 'migration-grace-job',
    }, first);
    claimPendingJobs(1, 'job-worker-before-migration', first);
    first.prepare(`
      UPDATE background_jobs
         SET fencing_token = NULL,
             lease_expires_at = datetime('now', '+15 minutes')
       WHERE job_id = ?
    `).run(job.jobId);

    // The claim guard must not strand rows that were already executing when
    // migration 279 landed. Their tokenless predecessor may finish once; the
    // non-processing terminal guard fences every later rewrite.
    expect(predecessorMarkEventProcessed(second, event.eventId)).toBe(1);
    expect(predecessorMarkJobCompleted(second, job.jobId)).toBe(1);
    expect(() => predecessorMarkEventFailed(second, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorMarkJobFailed(second, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
  });

  it('retains fenced tombstones for retryable and dead-letter failures in both queues', () => {
    const retryEvent = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.retry_event',
      entityType: 'probe',
      entityId: 'retry-event',
      idempotencyKey: 'retry-event',
    }, first);
    const retryEventLease = claimPendingEvents(1, 'retry-event-owner', first)[0];
    expect(markEventFailed(retryEventLease, new Error('retry'), first)).toBe('failed');
    expect(first.prepare(`
      SELECT status, fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt
        FROM event_outbox WHERE event_id = ?
    `).get(retryEvent.eventId)).toEqual({
      status: 'failed',
      fencingToken: retryEventLease.fencingToken,
      leaseExpiresAt: null,
    });
    expect(() => predecessorMarkEventProcessed(second, retryEvent.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);

    const deadEvent = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.dead_event',
      entityType: 'probe',
      entityId: 'dead-event',
      idempotencyKey: 'dead-event',
    }, first);
    const deadEventLease = claimPendingEvents(1, 'dead-event-owner', first)[0];
    first.prepare('UPDATE event_outbox SET attempts = 3 WHERE event_id = ?').run(deadEvent.eventId);
    expect(markEventFailed(deadEventLease, new Error('dead'), first)).toBe('dead_letter');
    expect(first.prepare(`
      SELECT status, fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt
        FROM event_outbox WHERE event_id = ?
    `).get(deadEvent.eventId)).toEqual({
      status: 'dead_letter',
      fencingToken: deadEventLease.fencingToken,
      leaseExpiresAt: null,
    });

    const retryJob = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_retry_job',
      idempotencyKey: 'retry-job',
    }, first);
    const retryJobLease = claimPendingJobs(1, 'retry-job-owner', first)[0];
    expect(markJobFailed(retryJobLease, new Error('retry'), first)).toBe('failed');
    expect(first.prepare(`
      SELECT status, fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt
        FROM background_jobs WHERE job_id = ?
    `).get(retryJob.jobId)).toEqual({
      status: 'failed',
      fencingToken: retryJobLease.fencingToken,
      leaseExpiresAt: null,
    });
    expect(() => predecessorMarkJobCompleted(second, retryJob.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);

    const deadJob = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_dead_job',
      maxAttempts: 1,
      idempotencyKey: 'dead-job',
    }, first);
    const deadJobLease = claimPendingJobs(1, 'dead-job-owner', first)[0];
    expect(markJobFailed(deadJobLease, new Error('dead'), first)).toBe('dead_letter');
    expect(first.prepare(`
      SELECT status, fencing_token AS fencingToken, lease_expires_at AS leaseExpiresAt
        FROM background_jobs WHERE job_id = ?
    `).get(deadJob.jobId)).toEqual({
      status: 'dead_letter',
      fencingToken: deadJobLease.fencingToken,
      leaseExpiresAt: null,
    });
  });

  it.each(['pending', 'failed'] as const)(
    'rejects a predecessor event worker claiming a %s row without a fresh token and lease',
    (initialStatus) => {
      const event = emitDomainEvent({
        tenantId: 7,
        userId: 7,
        sourceSkill: 'system',
        eventType: 'system.fencing.predecessor_claim_event',
        entityType: 'probe',
        entityId: `predecessor-claim-event-${initialStatus}`,
        idempotencyKey: `predecessor-claim-event-${initialStatus}`,
      }, first);
      if (initialStatus === 'failed') {
        const lease = claimPendingEvents(1, 'current-event-worker', first)[0];
        expect(markEventFailed(lease, new Error('retry'), first)).toBe('failed');
        first.prepare(`
          UPDATE event_outbox SET not_before = datetime('now') WHERE event_id = ?
        `).run(event.eventId);
      }

      expect(() => predecessorClaimPendingEvents(second))
        .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
      expect(first.prepare(`
        SELECT status, lock_owner AS lockOwner, lease_expires_at AS leaseExpiresAt
          FROM event_outbox WHERE event_id = ?
      `).get(event.eventId)).toMatchObject({
        status: initialStatus,
        lockOwner: null,
        leaseExpiresAt: null,
      });
    },
  );

  it.each(['pending', 'failed'] as const)(
    'rejects a predecessor job worker claiming a %s row without a fresh token and lease',
    (initialStatus) => {
      const job = enqueueJob({
        tenantId: 7,
        userId: 7,
        jobType: 'fencing_predecessor_claim_job',
        idempotencyKey: `predecessor-claim-job-${initialStatus}`,
      }, first);
      if (initialStatus === 'failed') {
        const lease = claimPendingJobs(1, 'current-job-worker', first)[0];
        expect(markJobFailed(lease, new Error('retry'), first)).toBe('failed');
        first.prepare(`
          UPDATE background_jobs SET not_before = datetime('now') WHERE job_id = ?
        `).run(job.jobId);
      }

      expect(() => predecessorClaimPendingJobs(second))
        .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
      expect(first.prepare(`
        SELECT status, lock_owner AS lockOwner, lease_expires_at AS leaseExpiresAt
          FROM background_jobs WHERE job_id = ?
      `).get(job.jobId)).toMatchObject({
        status: initialStatus,
        lockOwner: null,
        leaseExpiresAt: null,
      });
    },
  );

  it('keeps a replayed event pending against late predecessor terminal writes until a fenced claim', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.replay_gap_event',
      entityType: 'probe',
      entityId: 'replay-gap-event',
      idempotencyKey: 'replay-gap-event',
    }, first);
    expect(claimPendingEvents(1, 'current-event-worker', first)[0]?.eventId).toBe(event.eventId);
    expect(cancelEvent(event.eventId, 7, first)).toBe(true);
    expect(replayEvent(event.eventId, 7, first)).toBe(true);
    expect(first.prepare('SELECT status FROM event_outbox WHERE event_id = ?').get(event.eventId))
      .toEqual({ status: 'pending' });

    expect(() => predecessorMarkEventProcessed(second, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(() => predecessorMarkEventFailed(second, event.eventId))
      .toThrow(/EVENT_OUTBOX_FENCING_VIOLATION/);
    expect(first.prepare('SELECT status FROM event_outbox WHERE event_id = ?').get(event.eventId))
      .toEqual({ status: 'pending' });
    expect(claimPendingEvents(1, 'replayed-event-owner', first)[0]?.eventId).toBe(event.eventId);
  });

  it('keeps a replayed job pending against late predecessor terminal writes until a fenced claim', () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_replay_gap_job',
      idempotencyKey: 'replay-gap-job',
    }, first);
    expect(claimPendingJobs(1, 'current-job-worker', first)[0]?.jobId).toBe(job.jobId);
    expect(cancelJob(job.jobId, 7, first)).toBe(true);
    expect(replayJob(job.jobId, 7, first)).toBe(true);
    expect(first.prepare('SELECT status FROM background_jobs WHERE job_id = ?').get(job.jobId))
      .toEqual({ status: 'pending' });

    expect(() => predecessorMarkJobCompleted(second, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(() => predecessorMarkJobFailed(second, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(first.prepare('SELECT status FROM background_jobs WHERE job_id = ?').get(job.jobId))
      .toEqual({ status: 'pending' });
    expect(claimPendingJobs(1, 'replayed-job-owner', first)[0]?.jobId).toBe(job.jobId);
  });

  it('keeps cancellation authoritative and replay claimable under predecessor SQL', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'system',
      eventType: 'system.fencing.cancel_event',
      entityType: 'probe',
      entityId: 'cancel-event',
      idempotencyKey: 'cancel-event',
    }, first);
    claimPendingEvents(1, 'cancel-event-owner', first);
    expect(cancelEvent(event.eventId, 7, first)).toBe(true);
    expect(predecessorMarkEventFailed(second, event.eventId)).toBe(0);
    expect(replayEvent(event.eventId, 7, first)).toBe(true);
    expect(claimPendingEvents(1, 'replayed-event-owner', second)[0]?.eventId).toBe(event.eventId);

    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_cancel_job',
      idempotencyKey: 'cancel-job',
    }, first);
    claimPendingJobs(1, 'cancel-job-owner', first);
    expect(cancelJob(job.jobId, 7, first)).toBe(true);
    expect(() => predecessorMarkJobFailed(second, job.jobId))
      .toThrow(/BACKGROUND_JOB_FENCING_VIOLATION/);
    expect(replayJob(job.jobId, 7, first)).toBe(true);
    expect(claimPendingJobs(1, 'replayed-job-owner', second)[0]?.jobId).toBe(job.jobId);
  });

  it('dead-letters a typed terminal job error on its first fenced attempt', async () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'terminal_disposition_probe',
      idempotencyKey: 'terminal-disposition-probe',
      maxAttempts: 5,
    }, first);
    const terminal = new TerminalJobProbeError();
    const untypedImpostor = Object.assign(new Error('ordinary failure'), {
      code: 'LOOKS_TERMINAL_BUT_IS_NOT_TYPED',
      retryable: false,
    });
    let calls = 0;

    expect(isBackgroundJobTerminalError(terminal)).toBe(true);
    expect(isBackgroundJobTerminalError(untypedImpostor)).toBe(false);

    const firstDrain = await processPendingJobs([{
      jobType: 'terminal_disposition_probe',
      handle() {
        calls += 1;
        throw terminal;
      },
    }], { db: first, lockOwner: 'terminal-probe-worker' });

    expect(firstDrain).toEqual({ completed: 0, failed: 0, deadLetter: 1, skipped: 0 });
    expect(calls).toBe(1);
    expect(first.prepare(`
      SELECT status,
             attempts,
             max_attempts AS maxAttempts,
             lock_owner AS lockOwner,
             lease_expires_at AS leaseExpiresAt,
             fencing_token AS fencingToken,
             last_error AS lastError
        FROM background_jobs
       WHERE job_id = ?
    `).get(job.jobId)).toMatchObject({
      status: 'dead_letter',
      attempts: 1,
      maxAttempts: 5,
      lockOwner: null,
      leaseExpiresAt: null,
      fencingToken: expect.stringMatching(/^[0-9a-f]{32}$/),
      lastError: 'terminal probe requires manual repair',
    });

    const secondDrain = await processPendingJobs([{
      jobType: 'terminal_disposition_probe',
      handle() {
        calls += 1;
        throw terminal;
      },
    }], { db: first, lockOwner: 'terminal-probe-worker' });

    expect(secondDrain).toEqual({ completed: 0, failed: 0, deadLetter: 0, skipped: 0 });
    expect(calls).toBe(1);
  });

  it('keeps an ordinary job error retryable and completes on a later attempt', async () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'retryable_disposition_probe',
      idempotencyKey: 'retryable-disposition-probe',
      maxAttempts: 3,
    }, first);
    let calls = 0;
    const handler = {
      jobType: 'retryable_disposition_probe',
      handle() {
        calls += 1;
        if (calls === 1) throw new Error('ordinary retryable failure');
      },
    };

    const firstDrain = await processPendingJobs([handler], {
      db: first,
      lockOwner: 'retryable-probe-worker',
    });

    expect(firstDrain).toEqual({ completed: 0, failed: 1, deadLetter: 0, skipped: 0 });
    expect(first.prepare(`
      SELECT status, attempts, last_error AS lastError
        FROM background_jobs
       WHERE job_id = ?
    `).get(job.jobId)).toEqual({
      status: 'failed',
      attempts: 1,
      lastError: 'ordinary retryable failure',
    });

    first.prepare(`
      UPDATE background_jobs
         SET not_before = datetime('now')
       WHERE job_id = ?
    `).run(job.jobId);

    const secondDrain = await processPendingJobs([handler], {
      db: first,
      lockOwner: 'retryable-probe-worker',
    });

    expect(secondDrain).toEqual({ completed: 1, failed: 0, deadLetter: 0, skipped: 0 });
    expect(calls).toBe(2);
    expect(first.prepare(`
      SELECT status, attempts, last_error AS lastError
        FROM background_jobs
       WHERE job_id = ?
    `).get(job.jobId)).toEqual({
      status: 'completed',
      attempts: 2,
      lastError: null,
    });
  });

  it('heartbeats a job automatically while its async handler is in flight', async () => {
    const firstJob = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_async_job',
      idempotencyKey: 'async-job-heartbeat',
    }, first);
    const secondJob = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'fencing_async_job',
      idempotencyKey: 'queued-job-heartbeat',
    }, first);
    const jobIds = [firstJob.jobId, secondJob.jobId];
    const seenFencingTokens: string[] = [];
    let queuedJobId = '';
    let invocation = 0;
    let signalStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseHandler = resolve; });

    const processing = processPendingJobs([{
      jobType: 'fencing_async_job',
      async handle(claimed) {
        seenFencingTokens.push(String(claimed.fencingToken));
        invocation += 1;
        if (invocation > 1) return;
        queuedJobId = jobIds.find((jobId) => jobId !== claimed.jobId) ?? '';
        second.prepare(`
          UPDATE background_jobs SET lease_expires_at = datetime('now', '+2 seconds')
           WHERE job_id = ?
        `).run(queuedJobId);
        signalStarted();
        await release;
      },
    }], {
      db: first,
      lockOwner: 'job-async-owner',
      heartbeatIntervalMs: 25,
      limit: 2,
    });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const remainingSeconds = second.prepare(`
      SELECT CAST((julianday(lease_expires_at) - julianday('now')) * 86400 AS INTEGER) AS seconds
        FROM background_jobs WHERE job_id = ?
    `).get(queuedJobId) as { seconds: number };
    const stolen = claimPendingJobs(1, 'job-async-thief', second);
    releaseHandler();
    const result = await processing;

    expect(remainingSeconds.seconds).toBeGreaterThan(10 * 60);
    expect(stolen).toEqual([]);
    expect(new Set(seenFencingTokens).size).toBe(2);
    expect(result).toEqual({ completed: 2, failed: 0, deadLetter: 0, skipped: 0 });
  });
});
