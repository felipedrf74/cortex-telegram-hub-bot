import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
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

import { resolveDueReportTargets } from '../../src/services/report-schedule-dispatcher';
import {
  getOrCreateNotificationProfile,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';

// 2026-07-10 is a Friday. Lisbon runs UTC+1 (WEST) in July, so 06:00 local
// = 05:00 UTC. All fixtures pin explicit UTC instants — no wall-clock reads.
const FRIDAY = '2026-07-10';
const utc = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' });

const USER = { tenantId: 42 };
const OTHER = { tenantId: 43 };

describe('report-schedule-dispatcher', () => {
  const OLD_ENV = process.env.REPORT_SCHEDULE_CATCHUP_MINUTES;

  beforeEach(() => {
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
    if (OLD_ENV === undefined) delete process.env.REPORT_SCHEDULE_CATCHUP_MINUTES;
    else process.env.REPORT_SCHEDULE_CATCHUP_MINUTES = OLD_ENV;
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
    const sameTickAgain = resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:07:00Z`));
    expect(sameTickAgain).toEqual([]);
    const nextDay = resolveDueReportTargets('morning_briefing', [USER], utc('2026-07-11T05:02:00Z'));
    expect(nextDay).toEqual([USER]);
  });

  it('honors an explicit per-user time preference', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, { morningBriefingTime: '07:15' });
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T06:16:00Z`))).toEqual([USER]);
  });

  it('evaluates the preference in the profile timezone', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, {
      timezone: 'America/Sao_Paulo', // UTC-3 in July
      morningBriefingTime: '07:00',
    });
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T06:05:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T10:03:00Z`))).toEqual([USER]);
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

  it('catches up across local midnight and books the ledger on the fire date', () => {
    updateNotificationProfile(USER.tenantId, USER.tenantId, { endOfDayTime: '23:30' });
    // Saturday 00:15 Lisbon = Friday 23:15 UTC: Friday's 23:30 Lisbon slot
    // (22:30 UTC) is 45 minutes old — inside the window, previous local day.
    const due = resolveDueReportTargets('end_of_day', [USER], utc(`${FRIDAY}T23:15:00Z`));
    expect(due).toEqual([USER]);
    const ledger = testDb.prepare(
      'SELECT fired_for_local_date FROM report_schedule_ledger WHERE user_id = ? AND job_type = ?',
    ).get(USER.tenantId, 'end_of_day') as { fired_for_local_date: string };
    expect(ledger.fired_for_local_date).toBe(FRIDAY);
  });

  it('coach briefing uses the GARMIN_COACH_TIME default (21:00)', () => {
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T19:30:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:04:00Z`))).toEqual([USER]);
  });

  it('isolates per-user failures so one bad profile cannot stall the tick', () => {
    // tenantId 0 fails scope assertion inside getOrCreateNotificationProfile.
    const bad = { tenantId: 0 };
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
    const SP_USER = { tenantId: 77 };
    // No profile row: resolution is read-only against users.timezone
    // (America/Sao_Paulo, UTC-3 in July). Default 06:00 → 09:00 UTC.
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T05:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T09:02:00Z`))).toEqual([SP_USER]);
  });

  it('a newly-created profile inherits users.timezone, so a 07:00 preference fires Sao Paulo-local', () => {
    const SP_USER = { tenantId: 77 };
    const created = getOrCreateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId);
    expect(created.timezone).toBe('America/Sao_Paulo');
    updateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId, { morningBriefingTime: '07:00' });
    // 07:00 Sao Paulo = 10:00 UTC. Lisbon-local 07:00 (06:00 UTC) must NOT fire.
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T06:02:00Z`))).toEqual([]);
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T10:02:00Z`))).toEqual([SP_USER]);
  });

  it('an explicit profile timezone preference is not overridden by users.timezone', () => {
    const SP_USER = { tenantId: 77 };
    getOrCreateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId);
    updateNotificationProfile(SP_USER.tenantId, SP_USER.tenantId, {
      timezone: 'Europe/Lisbon',
      morningBriefingTime: '07:00',
    });
    expect(resolveDueReportTargets('morning_briefing', [SP_USER], utc(`${FRIDAY}T06:02:00Z`))).toEqual([SP_USER]);
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
    // ...and again on the next tick with the ledger row already claimed.
    resolveDueReportTargets('morning_briefing', [USER], utc(`${FRIDAY}T05:07:00Z`));

    const profileInserts = prepared.filter((sql) => /INSERT\s+INTO\s+notification_profiles/i.test(sql));
    expect(profileInserts).toEqual([]);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM notification_profiles').get()).toMatchObject({ n: 0 });
    vi.restoreAllMocks();
  });

  // ── QA finding 3: eligibility gates run BEFORE the ledger claim ──

  it('an ineligible due user is not claimed and still fires when eligible inside the window', () => {
    let healthy = false;
    const eligible = () => healthy;
    // Due at 06:02 Lisbon but ineligible: no claim consumed.
    expect(resolveDueReportTargets('coach_briefing', [USER], utc(`${FRIDAY}T20:04:00Z`), { eligible })).toEqual([]);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM report_schedule_ledger').get()).toMatchObject({ n: 0 });
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
    const ledger = testDb.prepare(
      "SELECT fired_for_local_date AS d FROM report_schedule_ledger WHERE job_type = 'morning_briefing'",
    ).get() as { d: string };
    expect(ledger.d).toBe('2026-03-29');
  });

  it('fall-back: an ambiguous preference fires exactly once for that local date', () => {
    // Europe/Lisbon 2026-10-25: clocks fall back 02:00 → 01:00; 01:30 local
    // happens twice (00:30Z in WEST, then 01:30Z in WET). Luxon resolves the
    // wall clock to the FIRST occurrence; the ledger absorbs the second.
    updateNotificationProfile(USER.tenantId, USER.tenantId, { endOfDayTime: '01:30' });
    const ambiguous = DateTime.fromObject(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      { zone: 'Europe/Lisbon' },
    );
    expect(ambiguous.toUTC().toISO()).toBe('2026-10-25T00:30:00.000Z');

    expect(resolveDueReportTargets('end_of_day', [USER], utc('2026-10-25T00:32:00Z'))).toEqual([USER]);
    // Second occurrence of the same wall clock, same local date: no re-fire.
    expect(resolveDueReportTargets('end_of_day', [USER], utc('2026-10-25T01:32:00Z'))).toEqual([]);
    const rows = testDb.prepare(
      "SELECT COUNT(*) AS n FROM report_schedule_ledger WHERE job_type = 'end_of_day' AND fired_for_local_date = '2026-10-25'",
    ).get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
