import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DateTime } from 'luxon';

let testDb: Database.Database;
const mockGetEvents = vi.fn();
const mockGetEventsForSources = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
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

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getEventsForSources: (...args: unknown[]) => mockGetEventsForSources(...args),
}));

import {
  buildPomodoroDescription,
  buildPomodoroIntervals,
  pomodoroDurationMinutes,
  precheckFocusCalendarConflict,
  roundUpToNextQuarterHour,
} from '../../src/services/focus-blocks';
import { buildSecretarySummary } from '../../src/api/routes/dashboard-home-input';
import { withGoogleCategoryTags } from '../../src/services/google-calendar';
import { setCacheSWR } from '../../src/services/cache-store';
import { fetchTasks } from '../../src/api/routes/dashboard-data-fetchers';
import { ensureDecisionCenterTables, getDecisionSummary } from '../../src/services/decision-center';
import { initializeDecisionCenterSchemaForTests } from '../../src/testing/decision-center-test-schema';
import { getAppleHealthSleepAgendaEvents, getAppleHealthSleepSegments } from '../../src/services/health-sleep-agenda';
import { buildHomeDayDial } from '../../src/services/home-day-dial';
import {
  ensureProviderPreferencesTables,
  getProviderPreferences,
  normalizePrimaryCalendarProvider,
  normalizePrimaryMailProvider,
  resolveCalendarWritePreference,
  resolveMailReadPreference,
  setProviderPreferences,
} from '../../src/services/provider-preferences';

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetEvents.mockResolvedValue([]);
  mockGetEventsForSources.mockReset();
  mockGetEventsForSources.mockResolvedValue([]);
  testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE apple_health_data (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      source TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE user_oauth_tokens (
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      refresh_token TEXT,
      scopes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE api_cache (
      cache_key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
});

describe('Home orchestration focus helpers', () => {
  it.each([
    ['2026-05-17T14:27:00.000Z', '2026-05-17T14:30:00.000Z'],
    ['2026-05-17T16:42:00.000Z', '2026-05-17T16:45:00.000Z'],
    ['2026-05-17T16:45:00.000Z', '2026-05-17T16:45:00.000Z'],
  ])('rounds %s to the next 15-minute boundary', (input, expected) => {
    expect(roundUpToNextQuarterHour(new Date(input), 'UTC').toISOString()).toBe(expected);
  });

  it.each([
    [1, 30],
    [2, 60],
    [4, 130],
    [5, 160],
    [8, 260],
  ])('computes Pomodoro duration for %i blocks', (blocks, expectedMinutes) => {
    expect(pomodoroDurationMinutes(blocks)).toBe(expectedMinutes);
  });

  it('builds a grouped Pomodoro sequence with long rest after the fourth block', () => {
    const intervals = buildPomodoroIntervals({
      start: new Date('2026-05-17T09:00:00.000Z'),
      blocks: 4,
      timezone: 'UTC',
    });

    expect(intervals).toHaveLength(8);
    expect(intervals[0]).toMatchObject({ kind: 'focus', index: 1, durationMinutes: 25 });
    expect(intervals[7]).toMatchObject({ kind: 'rest', index: 4, durationMinutes: 15 });
    expect(buildPomodoroDescription(intervals, 'UTC')).toContain('Rest after block 4');
  });

  it('keeps Gmail mail and Google Calendar agenda preferences distinct', () => {
    ensureProviderPreferencesTables();
    const saved = setProviderPreferences(42, 7, {
      primaryMailProvider: 'gmail',
      primaryCalendarProvider: 'google',
    });

    expect(saved.primaryMailProvider).toBe('gmail');
    expect(saved.primaryCalendarProvider).toBe('google');
    expect(getProviderPreferences(42, 7).primaryCalendarProvider).toBe('google');
    expect(normalizePrimaryMailProvider('google')).toBeNull();
    expect(normalizePrimaryCalendarProvider('gmail')).toBeNull();
  });

  it('does not silently switch calendar providers when an explicit preference is unavailable', () => {
    ensureProviderPreferencesTables();
    setProviderPreferences(42, 7, {
      primaryCalendarProvider: 'google',
    });

    const resolution = resolveCalendarWritePreference(42, 7);

    expect(resolution.requested).toBe('google');
    expect(resolution.source).toBeNull();
    expect(resolution.warningCode).toBe('GOOGLE_CALENDAR_PREFERENCE_UNAVAILABLE');
  });

  it('uses the explicit mail provider for Secretary inbox reads without falling back to another mail account', () => {
    ensureProviderPreferencesTables();
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, refresh_token, scopes)
      VALUES (?, ?, ?, ?)
    `).run(42, 'google', 'rt-google', JSON.stringify(['https://www.googleapis.com/auth/gmail.readonly']));
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, refresh_token, scopes)
      VALUES (?, ?, ?, ?)
    `).run(42, 'outlook', 'rt-outlook', JSON.stringify(['Mail.Read']));

    setProviderPreferences(42, 7, { primaryMailProvider: 'gmail' });

    expect(resolveMailReadPreference(42, 7)).toMatchObject({
      requested: 'gmail',
      sources: ['gmail'],
      warningCode: null,
    });
  });

  it('warns instead of silently switching mail providers when the explicit mail preference is unavailable', () => {
    ensureProviderPreferencesTables();
    testDb.prepare(`
      INSERT INTO user_oauth_tokens (user_id, provider, refresh_token, scopes)
      VALUES (?, ?, ?, ?)
    `).run(42, 'outlook', 'rt-outlook', JSON.stringify(['Mail.Read']));

    setProviderPreferences(42, 7, { primaryMailProvider: 'gmail' });

    expect(resolveMailReadPreference(42, 7)).toMatchObject({
      requested: 'gmail',
      sources: [],
      warningCode: 'PREFERRED_GMAIL_UNAVAILABLE',
    });
  });

  it('does not call the day all-clear when task or calendar status is stale', () => {
    expect(buildSecretarySummary({
      events: [],
      tasksDue: 0,
      overdueTasks: 0,
      hasCalendarUnavailable: false,
      calendarStatus: 'stale',
      tasksStatus: 'ready',
      language: 'en',
    })).toContain('still confirming');

    expect(buildSecretarySummary({
      events: [],
      tasksDue: 0,
      overdueTasks: 0,
      hasCalendarUnavailable: false,
      calendarStatus: 'ready',
      tasksStatus: 'stale',
      language: 'en',
    })).toContain('still confirming');
  });

  it('does not duplicate Google Nexus category tags when route metadata already appended one', () => {
    const description = withGoogleCategoryTags('Deep work\n\nNexus category: focus', ['focus']);
    expect(description?.match(/Nexus category:/g)).toHaveLength(1);
    expect(description).toBe('Deep work\n\nNexus category: focus');
  });

  it('builds day dial totals with focus categories and clipped sleep intervals', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        intervals: [
          {
            stage: 'asleepDeep',
            start: '2026-05-16T23:00:00.000Z',
            end: '2026-05-17T06:30:00.000Z',
          },
        ],
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-17',
      timezone: 'UTC',
      calendarEvents: [
        {
          id: 'focus-1',
          title: 'Pomodoro focus',
          start: '2026-05-17T10:00:00.000Z',
          end: '2026-05-17T11:00:00.000Z',
          categories: ['pomodoro', 'focus'],
        } as any,
        {
          id: 'meet-1',
          title: 'Team sync',
          start: '2026-05-17T12:00:00.000Z',
          end: '2026-05-17T12:30:00.000Z',
        } as any,
      ],
    });

    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(390);
    expect(dial.totals.find((total) => total.kind === 'focus')?.minutes).toBe(60);
    expect(dial.totals.find((total) => total.kind === 'meet')?.minutes).toBe(30);
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('keeps all-day calendar markers out of day dial occupied minutes', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-06-18',
      JSON.stringify({
        intervals: [
          {
            stage: 'asleepCore',
            start: '2026-06-18T00:00:00.000Z',
            end: '2026-06-18T04:00:00.000Z',
          },
        ],
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-06-18',
      timezone: 'UTC',
      calendarEvents: [
        {
          id: 'outlook-checkin',
          title: 'Check-in',
          start: '00:00',
          end: '00:00',
          rawStart: '2026-06-18T00:00:00.0000000',
          rawEnd: '2026-06-19T00:00:00.0000000',
          isAllDay: true,
          source: 'outlook',
        } as any,
        {
          id: 'meet-1',
          title: 'Timed meeting',
          start: '2026-06-18T10:00:00.000Z',
          end: '2026-06-18T10:30:00.000Z',
          source: 'outlook',
        } as any,
      ],
    });

    expect(dial.totals.find((total) => total.kind === 'meet')?.minutes).toBe(30);
    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(240);
    expect(dial.totals.find((total) => total.kind === 'open')?.minutes).toBe(1170);
    expect(dial.segments.some((segment) => segment.title === 'Check-in')).toBe(false);
  });

  it('normalizes overlapping day dial intervals so totals never exceed the day', () => {
    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-06-18',
      timezone: 'UTC',
      calendarEvents: [
        {
          id: 'focus-1',
          title: 'Focus block',
          start: '2026-06-18T10:00:00.000Z',
          end: '2026-06-18T12:00:00.000Z',
          category: 'focus',
        } as any,
        {
          id: 'meet-1',
          title: 'Team sync',
          start: '2026-06-18T11:00:00.000Z',
          end: '2026-06-18T13:00:00.000Z',
        } as any,
      ],
    });

    const occupied = dial.totals
      .filter((total) => total.kind !== 'open' && total.unavailable !== true)
      .reduce((sum, total) => sum + total.minutes, 0);

    expect(dial.totals.find((total) => total.kind === 'focus')?.minutes).toBe(120);
    expect(dial.totals.find((total) => total.kind === 'meet')?.minutes).toBe(60);
    expect(dial.totals.find((total) => total.kind === 'open')?.minutes).toBe(1260);
    expect(occupied + (dial.totals.find((total) => total.kind === 'open')?.minutes ?? 0)).toBe(1440);
  });

  it('builds day dial sleep totals from HealthKit sleepIntervals payloads', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        sleepIntervals: [
          {
            stage: 'asleepCore',
            start: '2026-05-17T00:15:00.000Z',
            end: '2026-05-17T06:45:00.000Z',
          },
        ],
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-17',
      timezone: 'UTC',
      calendarEvents: [],
    });

    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(390);
    expect(dial.totals.find((total) => total.kind === 'sleep')?.unavailable).toBeUndefined();
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('falls back to HealthKit sleepIntervals when legacy intervals are empty', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        intervals: [],
        sleepIntervals: [
          {
            stage: 'asleepDeep',
            start: '2026-05-17T01:00:00.000Z',
            end: '2026-05-17T07:00:00.000Z',
          },
        ],
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-17',
      timezone: 'UTC',
      calendarEvents: [],
    });

    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(360);
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('builds day dial sleep totals from HealthKit daily totals when stage intervals are absent', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-25',
      JSON.stringify({
        totalSleepSeconds: 7.5 * 60 * 60,
        deepSleepSeconds: 90 * 60,
        remSleepSeconds: 110 * 60,
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-25',
      timezone: 'UTC',
      calendarEvents: [],
    });

    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(420);
    expect(dial.totals.find((total) => total.kind === 'sleep')?.unavailable).toBeUndefined();
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('builds day dial sleep totals from daily_summary rows when the sleep row is missing', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'daily_summary', ?, 'apple_health')
    `).run(
      42,
      '2026-05-25',
      JSON.stringify({
        steps: 6400,
        totalSleepMinutes: 405,
      }),
    );

    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-25',
      timezone: 'UTC',
      calendarEvents: [],
    });

    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(405);
    expect(dial.totals.find((total) => total.kind === 'sleep')?.unavailable).toBeUndefined();
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('falls back to best-available wearable sleep when Apple Health agenda sleep is blank', () => {
    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-25',
      timezone: 'UTC',
      calendarEvents: [],
      wearableSleep: {
        provider: 'garmin',
        date: '2026-05-25',
        totalSleepSeconds: 7 * 60 * 60,
        deepSleepSeconds: null,
        lightSleepSeconds: null,
        remSleepSeconds: null,
        awakeSleepSeconds: null,
        sleepScore: 81,
        bedTimeStart: '2026-05-25T00:10:00.000Z',
        bedTimeEnd: '2026-05-25T07:10:00.000Z',
      },
    });

    expect(dial.segments).toContainEqual(expect.objectContaining({
      kind: 'sleep',
      start: '2026-05-25T00:10:00.000Z',
      end: '2026-05-25T07:10:00.000Z',
      minutes: 420,
    }));
    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(420);
    expect(dial.totals.find((total) => total.kind === 'sleep')?.unavailable).toBeUndefined();
    expect(dial.warningCodes).not.toContain('SLEEP_DATA_UNAVAILABLE');
  });

  it('projects Apple Health sleep into read-only agenda blocks', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        intervals: [
          {
            stage: 'asleepCore',
            start: '2026-05-16T23:30:00.000Z',
            end: '2026-05-17T06:45:00.000Z',
          },
          {
            stage: 'awake',
            start: '2026-05-17T02:00:00.000Z',
            end: '2026-05-17T02:05:00.000Z',
          },
        ],
      }),
    );

    const events = getAppleHealthSleepAgendaEvents({
      userId: 42,
      start: '2026-05-17T00:00:00.000Z',
      end: '2026-05-18T00:00:00.000Z',
      timezone: 'UTC',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Sleep',
      source: 'apple_health',
      category: 'sleep',
      categories: ['sleep'],
      start: '2026-05-17T00:00:00.000Z',
      end: '2026-05-17T06:45:00.000Z',
    });
  });

  it('merges Apple Health sleep-stage fragments into one agenda window without inflating day-ring sleep', () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        intervals: [
          { stage: 'asleepCore', start: '2026-05-17T01:12:00.000Z', end: '2026-05-17T01:15:00.000Z' },
          { stage: 'asleepDeep', start: '2026-05-17T01:21:00.000Z', end: '2026-05-17T01:23:00.000Z' },
          { stage: 'asleepREM', start: '2026-05-17T01:23:00.000Z', end: '2026-05-17T01:24:00.000Z' },
          { stage: 'asleepCore', start: '2026-05-17T01:25:00.000Z', end: '2026-05-17T01:52:00.000Z' },
          { stage: 'awake', start: '2026-05-17T01:52:00.000Z', end: '2026-05-17T01:58:00.000Z' },
          { stage: 'asleepCore', start: '2026-05-17T01:58:00.000Z', end: '2026-05-17T02:06:00.000Z' },
          // Duplicate sample from a repeated HealthKit sync must not double count.
          { stage: 'asleepDeep', start: '2026-05-17T01:21:00.000Z', end: '2026-05-17T01:23:00.000Z' },
        ],
      }),
    );

    const segments = getAppleHealthSleepSegments({
      userId: 42,
      start: '2026-05-17T00:00:00.000Z',
      end: '2026-05-18T00:00:00.000Z',
      timezone: 'UTC',
    });
    const events = getAppleHealthSleepAgendaEvents({
      userId: 42,
      start: '2026-05-17T00:00:00.000Z',
      end: '2026-05-18T00:00:00.000Z',
      timezone: 'UTC',
    });
    const dial = buildHomeDayDial({
      userId: 42,
      date: '2026-05-17',
      timezone: 'UTC',
      calendarEvents: [],
    });

    expect(segments).toEqual([expect.objectContaining({
      start: '2026-05-17T01:12:00.000Z',
      end: '2026-05-17T02:06:00.000Z',
      minutes: 41,
    })]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      start: '2026-05-17T01:12:00.000Z',
      end: '2026-05-17T02:06:00.000Z',
    });
    expect(dial.totals.find((total) => total.kind === 'sleep')?.minutes).toBe(41);
    expect(dial.totals.find((total) => total.kind === 'open')?.minutes).toBe(1399);
  });

  it('treats Apple Health sleep as agenda occupancy for focus conflict checks', async () => {
    testDb.prepare(`
      INSERT INTO apple_health_data (user_id, date, data_type, data_json, source)
      VALUES (?, ?, 'sleep', ?, 'apple_health')
    `).run(
      42,
      '2026-05-17',
      JSON.stringify({
        intervals: [
          {
            stage: 'asleepDeep',
            start: '2026-05-17T09:00:00.000Z',
            end: '2026-05-17T10:00:00.000Z',
          },
        ],
      }),
    );

    const result = await precheckFocusCalendarConflict({
      userId: 42,
      source: 'google',
      start: '2026-05-17T09:30:00.000Z',
      end: '2026-05-17T10:00:00.000Z',
      timezone: 'UTC',
    });

    expect(mockGetEvents).toHaveBeenCalledWith(
      '2026-05-17T07:30:00.000Z',
      '2026-05-17T22:00:00.000Z',
      42,
    );
    expect(mockGetEventsForSources).not.toHaveBeenCalled();
    expect(result.status).toBe('conflicted');
    expect(result.conflicts[0]).toMatchObject({
      title: 'Sleep',
      source: 'apple_health',
    });
    expect(result.nextFreeSlot).toMatchObject({
      start: '2026-05-17T10:00:00.000Z',
      end: '2026-05-17T10:30:00.000Z',
    });
  });

  it('lets dashboard task summaries paint from the shared working-set snapshot', async () => {
    setCacheSWR('u:42:tasks-working-set', {
      smartCounts: { overdue: 2, dueToday: 3 },
      activeCountsByList: { inbox: 4, deepWork: 2 },
      activePage: {
        tasks: [
          { id: 'task-1', title: 'Review proposal', importance: 'high', status: 'notStarted' },
          { id: 'task-2', title: 'Send invoice', importance: 'normal', status: 'notStarted' },
        ],
      },
      freshness: {
        state: 'degraded',
        generatedAt: '2026-05-17T10:00:00.000Z',
        reasonCodes: ['TASK_PROVIDER_STALE'],
      },
    }, 120, 600);

    const tasks = await fetchTasks(42);

    expect(tasks).toMatchObject({
      overdue: 2,
      dueToday: 3,
      totalPending: 6,
      status: 'degraded',
      warningCodes: ['TASK_PROVIDER_STALE'],
      snapshot: {
        source: 'tasks-working-set',
        cached: true,
      },
    });
    expect(tasks.topTasks.map((task: any) => task.title)).toEqual([
      'Review proposal',
      'Send invoice',
    ]);
  });

  it('computes decision streak gamification from tenant-scoped daily rollups', () => {
    initializeDecisionCenterSchemaForTests();
    ensureDecisionCenterTables();
    const today = DateTime.now().setZone('UTC').toISODate()!;
    const yesterday = DateTime.now().setZone('UTC').minus({ days: 1 }).toISODate()!;
    const twoDaysAgo = DateTime.now().setZone('UTC').minus({ days: 2 }).toISODate()!;
    const insert = testDb.prepare(`
      INSERT INTO decision_queue_daily_rollups (
        user_id, tenant_id, local_date, timezone, reached_zero_at,
        final_open_count, best_observed_open_count
      ) VALUES (?, ?, ?, 'UTC', ?, 0, 0)
    `);
    insert.run(42, 7, twoDaysAgo, `${twoDaysAgo}T22:00:00.000Z`);
    insert.run(42, 7, yesterday, `${yesterday}T22:00:00.000Z`);

    const summary = getDecisionSummary(42, 7);

    expect(summary.openCount).toBe(0);
    expect(summary.gamification).toMatchObject({
      decisionsLeft: 0,
      atRisk: false,
    });
    expect(summary.gamification?.currentStreakDays).toBeGreaterThanOrEqual(3);
    expect(summary.gamification?.bestStreakDays).toBeGreaterThanOrEqual(3);
    expect(summary.gamification?.last14Days.at(-1)).toMatchObject({
      date: today,
      cleared: true,
    });
  });
});
