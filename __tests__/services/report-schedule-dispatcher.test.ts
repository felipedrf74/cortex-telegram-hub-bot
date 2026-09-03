import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTestAsync: vi.fn(),
}));

const mockGetUserTimezoneById = vi.fn((userId: number) =>
  userId === 77 ? 'America/Sao_Paulo' : 'Europe/Lisbon');

vi.mock('../../src/services/user-service', () => ({
  getUserTimezoneById: (userId: number) => mockGetUserTimezoneById(userId),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  _resetReportScheduleDispatcherForTests,
  completeReportScheduleTarget,
  getActiveReportScheduleExecutionIdentity,
  resolveDueReportTargets,
  runWithReportScheduleHeartbeat,
} from '../../src/services/report-schedule-dispatcher';
import {
  claimDueScheduledReportLeases,
  claimDueScheduledReportLeaseBatch,
  completeScheduledReportLease,
  failScheduledReportLease,
  getScheduledReportCompletionReceipt,
} from '../../src/services/report-schedule-jobs';
import {
  claimScheduledJobExecution,
  completeScheduledJobExecution,
} from '../../src/services/scheduled-job-execution-state';
import {
  getOrCreateNotificationProfile,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';
import { initializeDecisionCenterSchemaForTests } from '../../src/testing/decision-center-test-schema';

// 2026-07-10 is a Friday. Lisbon runs UTC+1 (WEST) in July, so 06:00 local
// = 05:00 UTC. All fixtures pin explicit UTC instants — no wall-clock reads.
const FRIDAY = '2026-07-10';
const utc = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

const USER = { tenantId: 42, userId: 42 };
const OTHER = { tenantId: 43, userId: 43 };

describe('report-schedule-dispatcher', () => {
  const OLD_ENV = process.env.REPORT_SCHEDULE_CATCHUP_MINUTES;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync(
      resolve(process.cwd(), 'migrations/275_scheduled_job_execution_state.sql'),
      'utf8',
    ));
    initializeDecisionCenterSchemaForTests();
    _resetReportScheduleDispatcherForTests();
  });

  afterEach(() => {
    _resetReportScheduleDispatcherForTests();
    testDb.close();
    if (OLD_ENV === undefined) delete process.env.REPORT_SCHEDULE_CATCHUP_MINUTES;
    else process.env.REPORT_SCHEDULE_CATCHUP_MINUTES = OLD_ENV;
  });

  it('claims the same user independently in two explicit tenant scopes', () => {
    const tenantA = { tenantId: 420, userId: 42 };
    const tenantB = { tenantId: 421, userId: 42 };

    expect(resolveDueReportTargets(
      'morning_briefing',
      [tenantA, tenantB],
      utc(`${FRIDAY}T05:02:00Z`),
    )).toEqual([tenantA, tenantB]);
    expect(resolveDueReportTargets(
      'morning_briefing',
      [tenantA, tenantB],
      utc(`${FRIDAY}T05:07:00Z`),
    )).toEqual([]);
    expect(testDb.prepare(`
      SELECT scope_key AS scopeKey
        FROM scheduled_job_execution_state
       WHERE job_name = 'report:morning_briefing'
       ORDER BY scope_key
    `).all()).toEqual([
      { scopeKey: `tenant:420:user:42:local-date:${FRIDAY}` },
      { scopeKey: `tenant:421:user:42:local-date:${FRIDAY}` },
    ]);
  });

  it('fires the morning briefing at the global default when no preference is set', () => {
    // Default TODO_DIGEST_TIME=06:00 in the profile default zone Europe/Lisbon.
    const due = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`));
    expect(due).toEqual([USER]);
  });

  it('does not fire before the preferred instant', () => {
    const due = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T04:55:00Z`));
    expect(due).toEqual([]);
  });

  it('claims at-most-once per user-local day, and fires again the next day', () => {
    const first = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`));
    expect(first).toEqual([USER]);
    expect(completeReportScheduleTarget(
      USER.tenantId,
      'morning_briefing',
      'success',
      new Date(`${FRIDAY}T05:03:00Z`),
    )).toBe(true);
    const sameTickAgain = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:07:00Z`));
    expect(sameTickAgain).toEqual([]);
    const nextDay = resolveDueReportTargets('morning_briefing', [USER], utc('2026-07-11T05:02:00Z'));
    expect(nextDay).toEqual([USER]);
  });

  it('releases failed work for the next tick and recovers an abandoned lease after expiry', () => {
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([USER]);
    expect(completeReportScheduleTarget(
      USER.tenantId,
      'morning_briefing',
      'failed',
      new Date(`${FRIDAY}T05:03:00Z`),
    )).toBe(true);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:07:00Z`))).toEqual([USER]);
    const beforeCrash = getActiveReportScheduleExecutionIdentity(USER.tenantId, 'morning_briefing');
    expect(beforeCrash).toEqual({
      executionKey: `report:morning_briefing:tenant:42:user:42:local-date:${FRIDAY}`,
      localDate: FRIDAY,
    });

    // Simulate a crash by clearing only process memory and leaving the lease.
    _resetReportScheduleDispatcherForTests();
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:12:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:23:00Z`))).toEqual([USER]);
    expect(getActiveReportScheduleExecutionIdentity(USER.tenantId, 'morning_briefing'))
      .toEqual(beforeCrash);
  });

  it('drops a stale process identity when another worker has replaced its fence', () => {
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([USER]);
    expect(getActiveReportScheduleExecutionIdentity(USER.tenantId, 'morning_briefing')).not.toBeNull();

    testDb.prepare(`
      UPDATE scheduled_job_execution_state
         SET lease_token = 'replacement-worker-token'
       WHERE job_name = 'report:morning_briefing'
         AND scope_key = ?
    `).run(`tenant:42:user:42:local-date:${FRIDAY}`);

    expect(completeReportScheduleTarget(
      USER.tenantId,
      'morning_briefing',
      'success',
      new Date(`${FRIDAY}T05:03:00Z`),
    )).toBe(false);
    expect(getActiveReportScheduleExecutionIdentity(USER.tenantId, 'morning_briefing')).toBeNull();
  });

  it('refuses to checkpoint a report whose fenced lease is replaced during work', async () => {
    const now = new Date();
    updateNotificationProfile(USER.tenantId, USER.tenantId, {
      morningBriefingTime: DateTime.fromJSDate(now).setZone('Europe/Lisbon').toFormat('HH:mm'),
    });
    expect(resolveDueReportTargets(
      'morning_briefing',
      [USER],
      DateTime.fromJSDate(now, { zone: 'utc' }),
    )).toEqual([USER]);

    await expect(runWithReportScheduleHeartbeat(
      USER.tenantId,
      'morning_briefing',
      async () => {
        testDb.prepare(`
          UPDATE scheduled_job_execution_state
             SET lease_token = 'replacement-worker-token'
           WHERE job_name = 'report:morning_briefing'
        `).run();
        return 'stored';
      },
    )).rejects.toThrow('REPORT_SCHEDULE_EXECUTION_LEASE_LOST');
    expect(completeReportScheduleTarget(USER.tenantId, 'morning_briefing', 'success')).toBe(false);
  });

  it('honors an explicit per-user time preference', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, { morningBriefingTime: '07:15' });
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T06:16:00Z`))).toEqual([USER]);
  });

  it('evaluates profile time preferences in the authoritative users.timezone', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, {
      timezone: 'America/Sao_Paulo', // UTC-3 in July
      morningBriefingTime: '07:00',
    });
    // USER is authoritative Europe/Lisbon (UTC+1 in July), so the stale
    // notification-profile timezone cannot move the report to 10:00 UTC.
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T06:03:00Z`))).toEqual([USER]);
  });

  it('catches up after downtime inside the window and skips beyond it', () => {
    // Preferred 06:00 Lisbon = 05:00 UTC. 90 minutes late → catch up.
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T06:30:00Z`))).toEqual([USER]);
    // A different user 150 minutes late → outside the 120-minute window.
    expect(resolveDueReportTargets('morning_briefing', [OTHER], utc(`${FRIDAY}T07:30:00Z`))).toEqual([]);
  });

  it('respects REPORT_SCHEDULE_CATCHUP_MINUTES override', () => {
    process.env.REPORT_SCHEDULE_CATCHUP_MINUTES = '30';
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:45:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [OTHER], utc(`${FRIDAY}T05:20:00Z`))).toEqual([OTHER]);
  });

  it('weekly review fires only on the preferred day (default Friday 17:00)', () => {
    // Thursday 16:03 UTC = 17:03 Lisbon — right time, wrong day.
    expect(resolveDueReportTargets('weekly_review', [USER], utc('2026-07-09T16:03:00Z'))).toEqual([]);
    // Friday 16:03 UTC = 17:03 Lisbon.
    expect(resolveDueReportTargets('weekly_review', [USER], utc(`${FRIDAY}T16:03:00Z`))).toEqual([USER]);
  });

  it('weekly review honors a custom day and time', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, {
      weeklyReviewReportDay: 0, // Sunday
      weeklyReviewReportTime: '09:30',
    });
    expect(resolveDueReportTargets('weekly_review', [USER], utc(`${FRIDAY}T16:03:00Z`))).toEqual([]);
    // Sunday 2026-07-12 09:32 Lisbon = 08:32 UTC.
    expect(resolveDueReportTargets('weekly_review', [USER], utc('2026-07-12T08:32:00Z'))).toEqual([USER]);
  });

  it('catches up across local midnight and scopes the lease to the fire date', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, { endOfDayTime: '23:30' });
    // Saturday 00:15 Lisbon = Friday 23:15 UTC: Friday's 23:30 Lisbon slot
    // (22:30 UTC) is 45 minutes old — inside the window, previous local day.
    const due = resolveDueReportTargets('end_of_day', [USER], utc(`${FRIDAY}T23:15:00Z`));
    expect(due).toEqual([USER]);
    const lease = testDb.prepare(
      "SELECT scope_key FROM scheduled_job_execution_state WHERE job_name = 'report:end_of_day'",
    ).get() as { scope_key: string };
    expect(lease.scope_key).toContain(`local-date:${FRIDAY}`);
  });

  it('coach briefing uses the GARMIN_COACH_TIME default (21:00)', () => {
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T19:30:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:04:00Z`))).toEqual([USER]);
  });

  it('isolates per-user failures so one bad profile cannot stall the tick', () => {
    // tenantId 0 fails scope assertion inside getOrCreateNotificationProfile.
    const bad = { tenantId: 0, userId: 0 };
    const due = resolveDueReportTargets('morning_briefing', [bad, USER], utc(`${FRIDAY}T05:02:00Z`));
    expect(due).toEqual([USER]);
  });

  it('an invalid stored preference falls back to the default instead of never firing', () => {
    // Profile row does not exist yet — create it first, then corrupt directly.
    resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T00:01:00Z`));
    testDb.prepare(
      'UPDATE notification_profiles SET morning_briefing_time = ? WHERE user_id = ?',
    ).run('garbage', USER.tenantId);
    const due = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`));
    expect(due).toEqual([USER]);
  });

  // ── QA finding 1: canonical user timezone, not the Lisbon schema default ──

  it('fires at the canonical users.timezone local time when no profile row exists', () => {
    const SP_USER = { tenantId: 77, userId: 77 };
    // No profile row: resolution is read-only against users.timezone
    // (America/Sao_Paulo, UTC-3 in July). Default 06:00 → 09:00 UTC.
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T09:02:00Z`))).toEqual([SP_USER]);
  });

  it('a newly-created profile inherits users.timezone, so a 07:00 preference fires Sao Paulo-local', () => {
    const SP_USER = { tenantId: 77, userId: 77 };
    const created = getOrCreateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId);
    expect(created.timezone).toBe('America/Sao_Paulo');
    updateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId, { morningBriefingTime: '07:00' });
    // 07:00 Sao Paulo = 10:00 UTC. Lisbon-local 07:00 (06:00 UTC) must NOT fire.
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T06:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T10:02:00Z`))).toEqual([SP_USER]);
  });

  it('an explicit profile timezone cannot override users.timezone', () => {
    const SP_USER = { tenantId: 77 };
    getOrCreateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId);
    updateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId, {
      timezone: 'Europe/Lisbon',
      morningBriefingTime: '07:00',
    });
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T06:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T10:02:00Z`))).toEqual([SP_USER]);
  });

  // ── QA finding 2: resolution must not attempt profile inserts ──

  it('due-resolution never attempts a notification_profiles insert', () => {
    // Once with no profile row (read-only synthesized defaults)...
    const prepared: string[] = [];
    const originalPrepare = testDb.prepare.bind(testDb);
    vi.spyOn(testDb, 'prepare').mockImplementation(((sql: string) => {
      prepared.push(String(sql));
      return originalPrepare(sql);
    }) as typeof testDb.prepare);

    resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`));
    // ...and again on the next tick with the durable lease already claimed.
    resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:07:00Z`));

    const profileInserts = prepared.filter((sql) => /INSERT\s+INTO\s+notification_profiles/i.test(sql));
    expect(profileInserts).toEqual([]);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM notification_profiles').get()).toMatchObject({ n: 0 });
    vi.restoreAllMocks();
  });

  // ── QA finding 3: eligibility gates run BEFORE the durable claim ──

  it('an ineligible due user is not claimed and still fires when eligible inside the window', () => {
    let healthy = false;
    const eligible = () => healthy;
    // Due at 06:02 Lisbon but ineligible: no claim consumed.
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:04:00Z`), { eligible })).toEqual([]);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM scheduled_job_execution_state').get()).toMatchObject({ n: 0 });
    // Apple Health syncs 40 minutes later — same catch-up window, fires.
    healthy = true;
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:44:00Z`), { eligible })).toEqual([USER]);
  });

  it('an eligibility check that throws counts as eligible (send path is the backstop)', () => {
    const eligible = () => { throw new Error('gate exploded'); };
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:04:00Z`), { eligible })).toEqual([USER]);
  });

  // ── QA finding 4: DST contract ──

  it('spring-forward: a preference in the nonexistent gap fires at the first valid local time', () => {
    // Europe/Lisbon 2026-03-29: clocks jump 01:00 → 02:00 local; 01:30 does
    // not exist. Luxon resolves the wall clock forward to 02:30 WEST, which
    // is 01:30 UTC — pin that as the contract.
    updateNotificationProfile(USER.tenantId, USER.tenantId, { morningBriefingTime: '01:30' });
    const gapInstant = DateTime.fromObject(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
      { zone: 'Europe/Lisbon' },
    );
    expect(gapInstant.isValid).toBe(true);
    expect(gapInstant.toUTC().toISO()).toBe('2026-03-29T01:30:00.000Z');

    // Before the resolved instant: not due. After: fires exactly once.
    expect(resolveDueReportTargets('morning_briefing', [USER], utc('2026-03-29T00:50:00Z'))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc('2026-03-29T01:32:00Z'))).toEqual([USER]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc('2026-03-29T01:37:00Z'))).toEqual([]);
    const lease = testDb.prepare(
      "SELECT scope_key AS scopeKey FROM scheduled_job_execution_state WHERE job_name = 'report:morning_briefing'",
    ).get() as { scopeKey: string };
    expect(lease.scopeKey).toContain('local-date:2026-03-29');
  });

  it('fall-back: an ambiguous preference fires exactly once for that local date', () => {
    // Europe/Lisbon 2026-10-25: clocks fall back 02:00 → 01:00; 01:30 local
    // happens twice (00:30Z in WEST, then 01:30Z in WET). Luxon resolves the
    // wall clock to the FIRST occurrence; the local-date lease absorbs the second.
    updateNotificationProfile(USER.tenantId, USER.tenantId, { endOfDayTime: '01:30' });
    const ambiguous = DateTime.fromObject(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      { zone: 'Europe/Lisbon' },
    );
    expect(ambiguous.toUTC().toISO()).toBe('2026-10-25T00:30:00.000Z');

    expect(resolveDueReportTargets('end_of_day', [USER], utc('2026-10-25T00:32:00Z'))).toEqual([USER]);
    expect(completeReportScheduleTarget(
      USER.tenantId,
      'end_of_day',
      'success',
      new Date('2026-10-25T00:33:00Z'),
    )).toBe(true);
    // Second occurrence of the same wall clock, same local date: no re-fire.
    expect(resolveDueReportTargets('end_of_day', [USER], utc('2026-10-25T01:32:00Z'))).toEqual([]);
    const rows = testDb.prepare(`
      SELECT COUNT(*) AS n FROM scheduled_job_execution_state
       WHERE job_name = 'report:end_of_day' AND scope_key LIKE '%local-date:2026-10-25'
    `).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('weekly review catches up for a full day (per-job window), dailies stay tight', () => {
    // Friday 17:00 Lisbon slot missed (e.g. deploy restart) — Saturday
    // 12:00 UTC is ~20h later: weekly still fires; a morning briefing that
    // stale would not.
    expect(resolveDueReportTargets('weekly_review', [USER], utc('2026-07-11T12:00:00Z'))).toEqual([USER]);
    expect(resolveDueReportTargets('morning_briefing', [OTHER], utc(`${FRIDAY}T12:00:00Z`))).toEqual([]);
  });

  it('leases a due report and persists a scoped completion receipt', () => {
    const target = { userId: 42, tenantId: 42 };
    const first = claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-a',
    );

    expect(first).toHaveLength(1);
    expect(first[0].jobRecord).toMatchObject({
      userId: 42,
      tenantId: 42,
      status: 'processing',
      attempts: 1,
    });
    expect(testDb.prepare(`
      SELECT scope_key AS scopeKey, lease_token AS leaseToken, last_result AS lastResult
        FROM scheduled_job_execution_state
       WHERE job_name = 'report:morning_briefing'
    `).get()).toEqual({
      scopeKey: `tenant:42:user:42:local-date:${FRIDAY}`,
      leaseToken: expect.any(String),
      lastResult: null,
    });
    expect(claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:07:00Z`),
      {},
      'report-worker-b',
    )).toEqual([]);

    expect(completeScheduledReportLease(first[0])).toBe(true);
    expect(testDb.prepare(`
      SELECT lease_token AS leaseToken, last_result AS lastResult,
             last_succeeded_at AS lastSucceededAt
        FROM scheduled_job_execution_state
       WHERE job_name = 'report:morning_briefing'
         AND scope_key = ?
    `).get(`tenant:42:user:42:local-date:${FRIDAY}`)).toEqual({
      leaseToken: null,
      lastResult: 'success',
      lastSucceededAt: expect.any(String),
    });
    expect(testDb.prepare(`
      SELECT COUNT(*) AS n FROM scheduled_report_completion_receipts
    `).get()).toEqual({ n: 1 });
    expect(getScheduledReportCompletionReceipt({
      userId: 42,
      tenantId: 42,
      job: 'morning_briefing',
      localDate: FRIDAY,
    })).toMatchObject({
      userId: 42,
      tenantId: 42,
      job: 'morning_briefing',
      localDate: FRIDAY,
      attempts: 1,
      completedAt: expect.any(String),
    });
    expect(claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:12:00Z`),
    )).toEqual([]);
  });

  it('rolls back job completion when its durable receipt cannot be written', () => {
    const target = { userId: 42, tenantId: 42 };
    const [lease] = claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-receipt-rollback',
    );
    testDb.exec('DROP TABLE scheduled_report_completion_receipts');

    expect(() => completeScheduledReportLease(lease)).toThrow();
    expect(testDb.prepare(`
      SELECT status, completed_at AS completedAt
        FROM background_jobs
       WHERE job_id = ?
    `).get(lease.jobRecord.jobId)).toEqual({
      status: 'processing',
      completedAt: null,
    });
  });

  it('retries a failed report and reclaims an expired lease', () => {
    const failedTarget = { userId: 42, tenantId: 42 };
    const [failedLease] = claimDueScheduledReportLeases(
      'morning_briefing',
      [failedTarget],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-failure',
    );
    expect(failScheduledReportLease(failedLease, new Error('transient generation failure'))).toBe('failed');
    expect(testDb.prepare(`
      SELECT lease_token AS leaseToken, last_result AS lastResult,
             last_succeeded_at AS lastSucceededAt
        FROM scheduled_job_execution_state
       WHERE job_name = 'report:morning_briefing'
         AND scope_key = ?
    `).get(`tenant:42:user:42:local-date:${FRIDAY}`)).toEqual({
      leaseToken: null,
      lastResult: 'failed',
      lastSucceededAt: null,
    });
    expect(testDb.prepare(`
      SELECT last_error AS lastError FROM background_jobs WHERE job_id = ?
    `).get(failedLease.jobRecord.jobId)).toEqual({
      lastError: 'Scheduled report generation failed (Error)',
    });
    testDb.prepare(`
      UPDATE background_jobs SET not_before = datetime('now', '-1 second') WHERE job_id = ?
    `).run(failedLease.jobRecord.jobId);

    const retry = claimDueScheduledReportLeases(
      'morning_briefing',
      [failedTarget],
      utc(`${FRIDAY}T05:07:00Z`),
      {},
      'report-worker-retry',
    );
    expect(retry).toHaveLength(1);
    expect(retry[0].jobRecord.attempts).toBe(2);
    expect(completeScheduledReportLease(retry[0])).toBe(true);

    const leaseTarget = { userId: 43, tenantId: 43 };
    const [staleLease] = claimDueScheduledReportLeases(
      'morning_briefing',
      [leaseTarget],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-stale',
    );
    testDb.prepare(`
      UPDATE background_jobs SET lease_expires_at = datetime('now', '-1 second') WHERE job_id = ?
    `).run(staleLease.jobRecord.jobId);
    testDb.prepare(`
      UPDATE scheduled_job_execution_state
         SET lease_expires_at = datetime('now', '-1 second')
       WHERE job_name = 'report:morning_briefing'
         AND scope_key = ?
    `).run(`tenant:43:user:43:local-date:${FRIDAY}`);
    const reclaimed = claimDueScheduledReportLeases(
      'morning_briefing',
      [leaseTarget],
      utc(`${FRIDAY}T05:07:00Z`),
      {},
      'report-worker-reclaimed',
    );
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].jobRecord.attempts).toBe(2);
    expect(reclaimed[0].jobRecord.fencingToken).not.toBe(staleLease.jobRecord.fencingToken);
  });

  it('defers an overlapping local-date fence without consuming the report retry budget', () => {
    const target = { userId: 45, tenantId: 45 };
    const scopeKey = `tenant:45:user:45:local-date:${FRIDAY}`;
    const existingFence = claimScheduledJobExecution({
      jobName: 'report:morning_briefing',
      scopeKey,
    }, testDb);
    expect(existingFence.kind).toBe('claimed');

    expect(claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-overlap',
    )).toEqual([]);
    expect(testDb.prepare(`
      SELECT status, attempts, lock_owner AS lockOwner
        FROM background_jobs
       WHERE user_id = 45 AND tenant_id = 45
    `).get()).toEqual({ status: 'pending', attempts: 0, lockOwner: null });

    if (existingFence.kind !== 'claimed') throw new Error('expected report fence claim');
    expect(completeScheduledJobExecution(existingFence, 'failed', testDb)).toBe(true);
    testDb.prepare(`
      UPDATE background_jobs SET not_before = datetime('now', '-1 second')
       WHERE user_id = 45 AND tenant_id = 45
    `).run();

    const retry = claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:07:00Z`),
      {},
      'report-worker-after-overlap',
    );
    expect(retry).toHaveLength(1);
    expect(retry[0].jobRecord.attempts).toBe(1);
  });

  it('keeps a durable failed report retryable after its schedule catch-up window closes', () => {
    const target = { userId: 44, tenantId: 44 };
    const [first] = claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-window-first',
    );
    expect(failScheduledReportLease(first, new Error('provider unavailable'))).toBe('failed');
    testDb.prepare(`
      UPDATE background_jobs SET not_before = datetime('now', '-1 second') WHERE job_id = ?
    `).run(first.jobRecord.jobId);

    // 12:00Z is well outside the daily two-hour catch-up window. The
    // already-enqueued job remains retryable; only first-time enqueueing is
    // constrained by the schedule window.
    const retry = claimDueScheduledReportLeases(
      'morning_briefing',
      [target],
      utc(`${FRIDAY}T12:00:00Z`),
      {},
      'report-worker-window-retry',
    );
    expect(retry).toHaveLength(1);
    expect(retry[0].jobRecord).toMatchObject({
      jobId: first.jobRecord.jobId,
      attempts: 2,
      status: 'processing',
    });
  });

  it('reports partial fan-out failures while leasing healthy user jobs', () => {
    const batch = claimDueScheduledReportLeaseBatch(
      'morning_briefing',
      [{ userId: 0, tenantId: 0 }, { userId: 42, tenantId: 42 }],
      utc(`${FRIDAY}T05:02:00Z`),
      {},
      'report-worker-partial',
    );

    expect(batch.leases).toHaveLength(1);
    expect(batch.leases[0].target).toEqual({ userId: 42, tenantId: 42 });
    expect(batch.failures).toEqual([{
      userId: 0,
      tenantId: 0,
      errorName: 'Error',
    }]);
  });
});
