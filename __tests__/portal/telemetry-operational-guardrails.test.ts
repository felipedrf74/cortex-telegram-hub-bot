import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const scheduledJobStateMigration = readFileSync(
  resolve(process.cwd(), 'migrations/275_scheduled_job_execution_state.sql'),
  'utf8',
);

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('portal telemetry operational guardrails', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_name TEXT NOT NULL,
        result TEXT NOT NULL,
        duration_ms INTEGER,
        error_message TEXT,
        ts TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(scheduledJobStateMigration);

    const telemetry = await import('../../src/portal/telemetry');
    telemetry._resetTelemetryForTests();
    telemetry.setDbProvider(() => db as any);
    telemetry.setJobEnabledChecker(() => true);
  });

  afterEach(async () => {
    db.close();
    const telemetry = await import('../../src/portal/telemetry');
    telemetry._resetTelemetryForTests();
    vi.clearAllMocks();
  });

  it('fails closed before an unregistered scheduled callback can execute', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const fn = vi.fn(async () => {});

    expect(() => telemetry.wrapJob('missing_registration', fn)).toThrow(
      'Cannot wrap unregistered scheduled job: missing_registration',
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips overlapping cron invocations instead of executing duplicate work', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const { logger } = await import('../../src/utils/logger');
    telemetry.registerJob('overlap_job', 'Overlap Job', '* * * * *', 'system');

    const gate = deferred<void>();
    const fn = vi.fn(async () => {
      await gate.promise;
    });

    const wrapped = telemetry.wrapJob('overlap_job', fn);
    const firstRun = wrapped();
    await Promise.resolve();

    await wrapped();
    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve();
    await firstRun;

    const rows = db.prepare(`SELECT job_name, result FROM job_history WHERE job_name = 'overlap_job'`).all() as Array<{ job_name: string; result: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('success');
    expect(telemetry.getRecentEvents().some((event) => event.summary.includes('skipped overlap'))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      { job: 'overlap_job' },
      'Cron job skipped — previous invocation still running',
    );
  });

  // Stronger guarantee: the overlap fence must be shared by scheduler
  // processes, not only by callbacks imported from the same module instance.
  it('holds one durable lease across isolated telemetry runtimes and releases it after completion', async () => {
    const firstTelemetry = await import('../../src/portal/telemetry');
    firstTelemetry.registerJob('cluster_job', 'Cluster Job', '* * * * *', 'system');

    const gate = deferred<void>();
    const firstFn = vi.fn(async () => {
      await gate.promise;
    });
    const firstRun = firstTelemetry.wrapJob('cluster_job', firstFn)();
    await Promise.resolve();
    expect(firstFn).toHaveBeenCalledTimes(1);

    // A fresh module graph models another scheduler runtime: it has a distinct
    // in-memory Set but shares the same durable database.
    vi.resetModules();
    const secondTelemetry = await import('../../src/portal/telemetry');
    secondTelemetry._resetTelemetryForTests();
    secondTelemetry.setDbProvider(() => db as any);
    secondTelemetry.setJobEnabledChecker(() => true);
    secondTelemetry.registerJob('cluster_job', 'Cluster Job', '* * * * *', 'system');
    const secondFn = vi.fn(async () => {});
    const secondRun = secondTelemetry.wrapJob('cluster_job', secondFn);

    await secondRun();
    expect(secondFn).not.toHaveBeenCalled();
    expect(secondTelemetry.getRecentEvents().some(
      (event) => event.summary.includes('skipped overlap'),
    )).toBe(true);

    gate.resolve();
    await firstRun;

    await secondRun();
    expect(secondFn).toHaveBeenCalledTimes(1);
    const completed = db.prepare(`
      SELECT result FROM job_history
      WHERE job_name = 'cluster_job' AND result = 'success'
    `).all();
    expect(completed).toHaveLength(2);
  });

  it('renews a long-running durable lease before its original expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    const firstTelemetry = await import('../../src/portal/telemetry');
    firstTelemetry.registerJob('long_cluster_job', 'Long Cluster Job', '* * * * *', 'system');
    const gate = deferred<void>();
    const firstFn = vi.fn(async () => gate.promise);
    const firstRun = firstTelemetry.wrapJob('long_cluster_job', firstFn)();
    try {
      await Promise.resolve();
      expect(firstFn).toHaveBeenCalledOnce();

      // The default lease is one hour. Move beyond its original expiry after
      // giving the owner enough timer turns to heartbeat the same fenced token.
      await vi.advanceTimersByTimeAsync(60 * 60_000 + 1_000);
      vi.resetModules();
      const secondTelemetry = await import('../../src/portal/telemetry');
      secondTelemetry._resetTelemetryForTests();
      secondTelemetry.setDbProvider(() => db);
      secondTelemetry.setJobEnabledChecker(() => true);
      secondTelemetry.registerJob('long_cluster_job', 'Long Cluster Job', '* * * * *', 'system');
      const secondFn = vi.fn(async () => {});

      await secondTelemetry.wrapJob('long_cluster_job', secondFn)();
      expect(secondFn).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await firstRun;
      vi.useRealTimers();
    }
  });

  it('aborts cooperative effects when a heartbeat loses the durable fencing token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));
    const telemetry = await import('../../src/portal/telemetry');
    const scheduledState = await import('../../src/services/scheduled-job-execution-state');
    telemetry.registerJob('fenced_effect_job', 'Fenced Effect Job', '* * * * *', 'system');

    const continueEffect = deferred<void>();
    const effects: string[] = [];
    let executionSignal: AbortSignal | null = null;
    const fn = vi.fn(async (execution: {
      signal: AbortSignal;
      assertLeaseActive(): void;
    }) => {
      executionSignal = execution.signal;
      execution.assertLeaseActive();
      effects.push('before-lease-loss');
      await continueEffect.promise;
      // Stronger guarantee: a provider fan-out can fence every next effect.
      // Losing the heartbeat must stop it before another mutation starts.
      execution.assertLeaseActive();
      effects.push('after-lease-loss');
    });

    const running = telemetry.wrapJob('fenced_effect_job', fn)();
    try {
      await Promise.resolve();
      expect(fn).toHaveBeenCalledOnce();

      db.prepare(`
        UPDATE scheduled_job_execution_state
           SET lease_owner = 'replacement-owner',
               lease_token = 'replacement-token',
               lease_expires_at = '2026-08-02T12:00:00.000Z'
         WHERE job_name = 'fenced_effect_job' AND scope_key = 'global'
      `).run();
      await vi.advanceTimersByTimeAsync(
        scheduledState.DEFAULT_SCHEDULED_JOB_LEASE_HEARTBEAT_MS + 1,
      );
      expect(executionSignal?.aborted).toBe(true);

      continueEffect.resolve();
      await expect(running).rejects.toMatchObject({
        code: 'SCHEDULED_JOB_LEASE_LOST',
        jobName: 'fenced_effect_job',
      });
      expect(effects).toEqual(['before-lease-loss']);
    } finally {
      continueEffect.resolve();
      await running.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('fails closed and records an operational failure when the durable lease store is unavailable', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const notifyFailure = vi.fn(async () => {});
    const fn = vi.fn(async () => {});
    telemetry.setJobFailureNotifier(notifyFailure);
    telemetry.registerJob('lease_store_failure', 'Lease Store Failure', '* * * * *', 'system');
    db.exec('DROP TABLE scheduled_job_execution_state');

    await expect(telemetry.wrapJob('lease_store_failure', fn)()).rejects.toThrow(
      /scheduled_job_execution_state/,
    );

    // F36's cluster fence is fail-closed: losing the fence must never permit
    // potentially duplicated provider or user-visible work to run unguarded.
    expect(fn).not.toHaveBeenCalled();
    expect(telemetry.getJobStatuses().find((job) => job.name === 'lease_store_failure'))
      .toMatchObject({ lastResult: 'failed' });
    expect(notifyFailure).toHaveBeenCalledWith(
      'Lease Store Failure',
      expect.stringContaining('scheduled_job_execution_state'),
    );
    expect(db.prepare(`
      SELECT result FROM job_history WHERE job_name = 'lease_store_failure'
    `).get()).toMatchObject({ result: 'failed' });
  });

  // Stronger guarantee: production job execution must never silently fall
  // back to an in-process overlap Set merely because boot forgot to inject the
  // durable database provider. A missing provider is the same fail-closed
  // safety condition as a missing lease table.
  it('fails closed before executing when the durable database provider was not injected', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const fn = vi.fn(async () => {});
    telemetry._resetTelemetryForTests();
    telemetry.setJobEnabledChecker(() => true);
    telemetry.registerJob('lease_provider_missing', 'Lease Provider Missing', '* * * * *', 'system');

    await expect(telemetry.wrapJob('lease_provider_missing', fn)()).rejects.toMatchObject({
      code: 'SCHEDULED_JOB_LEASE_STORE_UNAVAILABLE',
      jobName: 'lease_provider_missing',
    });

    expect(fn).not.toHaveBeenCalled();
    expect(telemetry.getJobStatuses().find((job) => job.name === 'lease_provider_missing'))
      .toMatchObject({ lastResult: 'failed' });
  });

  it('logs non-fatal persistence failures instead of swallowing them silently', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const { logger } = await import('../../src/utils/logger');
    telemetry._resetTelemetryForTests();
    db.exec(`
      CREATE TRIGGER reject_job_history_insert
      BEFORE INSERT ON job_history
      BEGIN
        SELECT RAISE(ABORT, 'disk full');
      END;
    `);
    telemetry.setDbProvider(() => db);
    telemetry.setJobEnabledChecker(() => true);
    telemetry.registerJob('persist_failure_job', 'Persist Failure Job', '* * * * *', 'system');

    const wrapped = telemetry.wrapJob('persist_failure_job', async () => {});
    await expect(wrapped()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      { jobName: 'persist_failure_job', result: 'success', err: 'disk full' },
      'job_history persist failed',
    );
  });
});
