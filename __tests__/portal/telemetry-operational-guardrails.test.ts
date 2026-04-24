import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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

  it('logs non-fatal persistence failures instead of swallowing them silently', async () => {
    const telemetry = await import('../../src/portal/telemetry');
    const { logger } = await import('../../src/utils/logger');
    telemetry._resetTelemetryForTests();
    telemetry.setDbProvider(() => ({
      prepare: () => ({
        run: () => {
          throw new Error('disk full');
        },
      }),
    }) as any);
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
