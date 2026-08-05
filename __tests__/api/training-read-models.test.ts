import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = new Map<string, any>();
const hoisted = vi.hoisted(() => ({
  calculateReadiness: vi.fn(),
  getActivitiesByDateForUser: vi.fn(),
  findExistingOwnership: vi.fn(),
  isConnected: vi.fn(),
  readinessSnapshotSpy: vi.fn(),
}));

let mockActivePlan: any = null;
let mockCurrentWeek: any = null;
let mockPlanWeeks: any[] = [];
let mockWeekSessions: any[] = [];
let mockWeeklyAdherence: any = null;
let mockCalendarLookup = new Map<any, any>();
let mockReadinessResult: any = null;
let mockGarminActivities: any[] = [];
// Controls the calendar-cleanup dead-letter snapshot (secretary_agenda_items).
let mockAgendaDb: {
  hasTable: boolean;
  hasFailureCountColumn: boolean;
  deadLetteredCount: number;
  throwOnAccess: boolean;
  lastCountArgs: any[] | null;
} = { hasTable: true, hasFailureCountColumn: true, deadLetteredCount: 0, throwOnAccess: false, lastCountArgs: null };

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (mockAgendaDb.throwOnAccess) throw new Error('db unavailable');
    return {
      prepare: (sql: string) => ({
        get: (...args: any[]) => {
          if (sql.includes('sqlite_master')) {
            return mockAgendaDb.hasTable ? { name: 'secretary_agenda_items' } : undefined;
          }
          if (sql.includes('COUNT(*)')) {
            mockAgendaDb.lastCountArgs = args;
            return { deadLetteredCount: mockAgendaDb.deadLetteredCount };
          }
          return undefined;
        },
        all: () => (mockAgendaDb.hasFailureCountColumn
          ? [{ name: 'agenda_item_id' }, { name: 'provider_sync_failure_count' }]
          : [{ name: 'agenda_item_id' }]),
      }),
    };
  },
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (key: string) => cache.get(key),
  setCache: (key: string, value: any) => cache.set(key, value),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: () => mockActivePlan,
  getCurrentWeek: () => mockCurrentWeek,
  getWeeksForPlan: () => mockPlanWeeks,
  getSessionsForWeek: () => mockWeekSessions,
  getWeeklyAdherence: () => mockWeeklyAdherence,
}));

vi.mock('../../src/api/routes/training-calendar-lookup', () => ({
  buildCalendarEventLookup: vi.fn(async () => mockCalendarLookup),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: hoisted.calculateReadiness,
}));

vi.mock('../../src/services/garmin', () => ({
  getActivitiesByDateForUser: hoisted.getActivitiesByDateForUser,
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findExistingOwnership: hoisted.findExistingOwnership,
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: hoisted.isConnected,
}));

// Passthrough spy: keeps the real snapshot behavior while letting tests pin
// exactly which readiness fields reach the adaptation snapshot boundary.
vi.mock('../../src/services/coach-kernel/readiness-snapshot-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/coach-kernel/readiness-snapshot-adapter')>();
  return {
    ...actual,
    readinessResultToSnapshot: (input: any) => {
      hoisted.readinessSnapshotSpy(input);
      return actual.readinessResultToSnapshot(input);
    },
  };
});

import {
  adaptDtoSessionForReadiness,
  fetchCurrentReadinessForPlan,
  getAllPlanWeeks,
  getReadiness,
  getTodaySession,
  getWeekPlan,
} from '../../src/api/routes/training-read-models';
import { buildCalendarEventLookup } from '../../src/api/routes/training-calendar-lookup';

describe('training-read-models', () => {
  beforeEach(() => {
    cache.clear();
    mockActivePlan = null;
    mockCurrentWeek = null;
    mockPlanWeeks = [];
    mockWeekSessions = [];
    mockWeeklyAdherence = null;
    mockCalendarLookup = new Map();
    mockReadinessResult = null;
    mockGarminActivities = [];
    hoisted.calculateReadiness.mockReset();
    hoisted.getActivitiesByDateForUser.mockReset();
    hoisted.findExistingOwnership.mockReset();
    hoisted.isConnected.mockReset();
    hoisted.readinessSnapshotSpy.mockReset();
    (buildCalendarEventLookup as any).mockReset();
    (buildCalendarEventLookup as any).mockImplementation(async () => mockCalendarLookup);
    hoisted.calculateReadiness.mockImplementation(async () => mockReadinessResult);
    hoisted.getActivitiesByDateForUser.mockImplementation(async () => mockGarminActivities);
    hoisted.findExistingOwnership.mockReturnValue(null);
    hoisted.isConnected.mockReturnValue(true);
    mockAgendaDb = {
      hasTable: true,
      hasFailureCountColumn: true,
      deadLetteredCount: 0,
      throwOnAccess: false,
      lastCountArgs: null,
    };
  });

  it('surfaces an injury-safe swap for injury-affecting active sessions', () => {
    const adaptation = adaptDtoSessionForReadiness(
      { sessionType: 'run', status: 'planned' },
      {
        capturedAt: '2026-06-03T08:00:00.000Z',
        level: 'green',
        score: 88,
        painFlags: [
          { area: 'left_knee', severity: 'moderate', impact: ['running'] },
        ],
      } as any,
      true,
    );

    expect(adaptation).toMatchObject({
      intensityDownshiftPct: 0.5,
      originalSessionType: 'easy_run',
      reason: 'injury_safe_swap',
    });
    expect(adaptation?.explanation).toContain('Active injury');
  });

  it('returns today session from the active plan plus linked calendar time', async () => {
    const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    mockActivePlan = {
      id: 10,
      name: 'Marathon Build',
      periodization: 'build',
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'outlook' }),
    };
    mockCurrentWeek = { id: 20, week_number: 1, focus: 'base' };
    mockWeekSessions = [{
      id: 30,
      day_of_week: todayName,
      title: 'Tempo Run',
      session_type: 'run',
      calendar_event_id: 'evt-1',
      duration_minutes: 55,
      status: 'planned',
      description: 'Controlled threshold effort.',
      exercises_json: JSON.stringify([]),
    }];
    mockCalendarLookup = new Map([
      ['evt-1', { time: '07:00', event: { id: 'evt-1' } }],
    ]);
    hoisted.findExistingOwnership.mockReturnValue({
      calendar_event_id: 'evt-1',
      calendar_source: 'outlook',
      status: 'active',
    });

    const result = await getTodaySession(42, 42);

    expect(result.plan).toMatchObject({
      name: 'Marathon Build',
      weekNumber: 1,
      phase: 'base',
      calendarSource: 'outlook',
    });
    expect(result.session).toMatchObject({
      id: '30',
      type: 'Tempo Run',
      sessionType: 'run',
      time: '07:00',
      calendarEventId: 'evt-1',
      calendarSyncState: 'verified',
      duration: 55,
      status: 'planned',
      notes: 'Controlled threshold effort.',
      exercises: [],
    });
  });

  it('returns the SQLite week sessions even when calendar enrichment throws', async () => {
    // Repro of production bug 2026-04-26: Outlook tokens went bad
    // (`invalid_grant`), `buildCalendarEventLookup` threw, the outer try
    // swallowed the throw, and iOS Week 1 silently fell to "no sessions to
    // follow this week yet" even though the plan was real. Calendar
    // enrichment is decoration only (adds `time:`) and must never erase
    // session content.
    mockActivePlan = {
      id: 99,
      name: 'Strength Block',
      periodization: 'build',
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google' }),
    };
    mockCurrentWeek = { id: 199, week_number: 1, focus: 'strength' };
    mockWeekSessions = [
      { id: 501, day_of_week: 'Monday', title: 'Strength + Core', session_type: 'gym', calendar_event_id: 'evt-mon', duration_minutes: 40, status: 'planned', description: 'Lifting day.', exercises_json: JSON.stringify([{ name: 'squat' }, { name: 'press' }]) },
      { id: 502, day_of_week: 'Wednesday', title: 'Tempo Run', session_type: 'run', calendar_event_id: 'evt-wed', duration_minutes: 35, status: 'planned', description: 'Threshold.', exercises_json: null },
    ];
    const calendarMod = await import('../../src/api/routes/training-calendar-lookup');
    (calendarMod.buildCalendarEventLookup as any).mockRejectedValueOnce(new Error('invalid_grant'));

    const result = await getWeekPlan(42, 42);

    expect(result.plan).toMatchObject({ name: 'Strength Block', weekNumber: 1, calendarSource: 'google' });
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({ id: '501', title: 'Strength + Core', duration: 40 });
    // Time is null because calendar enrichment was unavailable, but the
    // structured session content (title/exercises/duration) is intact.
    expect(result.sessions[0].time).toBeNull();
    expect(result.sessions[0].exercises).toEqual([{ name: 'squat' }, { name: 'press' }]);
  });

  it('enriches Sunday-start plans using the plan-start anchored week range', async () => {
    mockActivePlan = { id: 11, name: 'Muscle Building', periodization: 'base', start_date: '2026-04-26' };
    mockCurrentWeek = { id: 211, week_number: 1, focus: 'base' };
    mockWeekSessions = [
      {
        id: 701,
        day_of_week: 'Monday',
        title: 'Strength + Core Support',
        session_type: 'gym',
        calendar_event_id: 'evt-mon',
        calendar_source: 'google',
        duration_minutes: 40,
        status: 'planned',
        description: 'Strength work.',
        exercises_json: JSON.stringify([]),
      },
    ];
    mockCalendarLookup = new Map([
      ['evt-mon', {
        time: '06:00',
        event: {
          id: 'evt-mon',
          summary: '💪 Strength + Core Support (40min)',
          start: '2026-04-27T06:00:00.000Z',
          end: '2026-04-27T06:40:00.000Z',
        },
      }],
    ]);
    hoisted.findExistingOwnership.mockReturnValue({
      calendar_event_id: 'evt-mon',
      calendar_source: 'google',
      status: 'active',
    });

    const result = await getWeekPlan(42, 42);
    const [rangeStart, rangeEnd] = (buildCalendarEventLookup as any).mock.calls[0];

    expect(rangeStart.toISOString()).toBe('2026-04-26T00:00:00.000Z');
    expect(rangeEnd.toISOString()).toBe('2026-05-02T23:59:59.999Z');
    expect(result.sessions[0]).toMatchObject({
      id: '701',
      time: '06:00',
      calendarEventId: 'evt-mon',
      calendarSource: 'google',
    });
  });

  it('marks stale stored calendar links as repair_needed in the week plan read model', async () => {
    mockActivePlan = { id: 12, name: 'Muscle Building', periodization: 'base', start_date: '2026-04-26' };
    mockCurrentWeek = { id: 212, week_number: 1, focus: 'base' };
    mockWeekSessions = [
      {
        id: 702,
        day_of_week: 'Monday',
        title: 'Strength Session',
        session_type: 'gym',
        calendar_event_id: 'evt-stale',
        calendar_source: 'google',
        duration_minutes: 60,
        status: 'planned',
        description: 'Strength work.',
        exercises_json: JSON.stringify([]),
      },
    ];
    mockCalendarLookup = new Map();

    const result = await getWeekPlan(42, 42);

    expect(result.sessions[0]).toMatchObject({
      id: '702',
      title: 'Strength Session',
      time: null,
      calendarEventId: null,
      calendarSource: null,
      calendarSyncState: 'repair_needed',
      legacyCalendarSyncState: 'stale',
    });
  });

  it('marks stored calendar links as provider_disconnected when OAuth was removed', async () => {
    mockActivePlan = {
      id: 14,
      name: 'Disconnected Calendar Block',
      periodization: 'base',
      start_date: '2026-04-26',
      preferences_json: JSON.stringify({ trainingCalendarSource: 'google' }),
    };
    mockCurrentWeek = { id: 214, week_number: 1, focus: 'base' };
    mockWeekSessions = [
      {
        id: 704,
        day_of_week: 'Monday',
        title: 'Strength Session',
        session_type: 'gym',
        calendar_event_id: 'evt-disconnected',
        calendar_source: 'google',
        duration_minutes: 60,
        status: 'planned',
        description: 'Strength work.',
        exercises_json: JSON.stringify([]),
      },
    ];
    mockCalendarLookup = new Map([
      ['evt-disconnected', {
        time: '12:00',
        event: {
          id: 'evt-disconnected',
          summary: '💪 Strength Session (60min)',
          start: '2026-04-27T12:00:00.000Z',
          end: '2026-04-27T13:00:00.000Z',
        },
      }],
    ]);
    hoisted.findExistingOwnership.mockReturnValue({
      calendar_event_id: 'evt-disconnected',
      calendar_source: 'google',
      status: 'active',
    });
    hoisted.isConnected.mockReturnValue(false);

    const result = await getWeekPlan(42, 42);

    expect(hoisted.isConnected).toHaveBeenCalledWith(42, 'google');
    expect(result.sessions[0]).toMatchObject({
      id: '704',
      title: 'Strength Session',
      time: null,
      calendarEventId: null,
      calendarSource: null,
      calendarSyncState: 'provider_disconnected',
      legacyCalendarSyncState: 'stale',
    });
    expect(result.syncedSessionCount).toBe(0);
    expect(result.missingSessionCount).toBe(1);
  });

  it('marks mismatched linked calendar events as repair_needed in the week plan read model', async () => {
    mockActivePlan = { id: 13, name: 'Muscle Building', periodization: 'base', start_date: '2026-04-26' };
    mockCurrentWeek = { id: 213, week_number: 1, focus: 'base' };
    mockWeekSessions = [
      {
        id: 703,
        day_of_week: 'Monday',
        title: 'Strength Session',
        session_type: 'gym',
        calendar_event_id: 'evt-old-plan',
        calendar_source: 'google',
        duration_minutes: 60,
        status: 'planned',
        description: 'Strength work.',
        exercises_json: JSON.stringify([]),
      },
    ];
    mockCalendarLookup = new Map([
      ['evt-old-plan', {
        time: '12:00',
        event: {
          id: 'evt-old-plan',
          summary: '🏋️ Mobility + Recovery (29min)',
          start: '2026-04-27T12:00:00.000Z',
          end: '2026-04-27T12:29:00.000Z',
        },
      }],
    ]);

    const result = await getWeekPlan(42, 42);

    expect(result.sessions[0]).toMatchObject({
      id: '703',
      title: 'Strength Session',
      time: null,
      calendarEventId: null,
      calendarSource: null,
      calendarSyncState: 'repair_needed',
      legacyCalendarSyncState: 'stale',
    });
  });

  it('returns todays SQLite session even when calendar enrichment throws', async () => {
    const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    mockActivePlan = { id: 100, name: 'Strength Block', periodization: 'build', start_date: '2026-04-20T00:00:00.000Z' };
    mockCurrentWeek = { id: 200, week_number: 1, focus: 'strength' };
    mockWeekSessions = [{
      id: 600,
      day_of_week: todayName,
      title: 'Strength + Core Support',
      session_type: 'gym',
      calendar_event_id: 'evt-today',
      duration_minutes: 40,
      status: 'planned',
      description: 'Recovery support day.',
      exercises_json: JSON.stringify([{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }]),
    }];
    const calendarMod = await import('../../src/api/routes/training-calendar-lookup');
    (calendarMod.buildCalendarEventLookup as any).mockRejectedValueOnce(new Error('invalid_grant'));

    const result = await getTodaySession(42, 42);

    expect(result.session).not.toBeNull();
    expect(result.session).toMatchObject({
      id: '600',
      type: 'Strength + Core Support',
      duration: 40,
    });
    expect(result.session?.time).toBeNull();
    expect(result.session?.exercises).toHaveLength(4);
  });

  it('falls back to calendar-built week sessions when the active week has no stored sessions', async () => {
    const now = new Date();
    const start = new Date(now);
    start.setHours(8, 0, 0, 0);
    const end = new Date(now);
    end.setHours(9, 0, 0, 0);

    mockActivePlan = { id: 11, name: 'Hybrid Build', periodization: 'build', start_date: '2026-04-20T00:00:00.000Z' };
    mockCurrentWeek = { id: 21, week_number: 1, focus: 'build' };
    mockWeekSessions = [];
    mockCalendarLookup = new Map([
      ['evt-2', {
        time: '08:00',
        event: {
          id: 'evt-2',
          subject: 'Morning Run',
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          description: 'Easy aerobic run.',
        },
      }],
    ]);

    const result = await getWeekPlan(42, 42);

    expect(result.plan).toMatchObject({
      name: 'Hybrid Build',
      weekNumber: 1,
      phase: 'build',
    });
    expect(result.sessions.some((session: any) => session.title === 'Morning Run')).toBe(true);
    expect(result.totalCount).toBeGreaterThan(0);
  });

  it('normalizes readiness fields and reuses cached values on repeated reads', async () => {
    mockReadinessResult = {
      score: 72,
      recommendation: 'normal',
      reasonCode: 'maintain',
      source: 'garmin',
      asOf: '2026-06-11T07:30:00.000Z',
      computedAt: '2026-06-11T07:30:00.000Z',
      dataAsOf: '2026-06-11T06:50:00.000Z',
      factors: {
        sleep: { score: 88, durationHours: 7.5 },
        hrv: { trend: 'stable' },
        bodyBattery: { current: 64 },
        trainingLoad: { acwr: 1.12 },
      },
      reasoning: '  Recovered well overnight.  ',
    };

    const first = await getReadiness(42);
    const second = await getReadiness(42);

    expect(first).toMatchObject({
      score: 72,
      recommendation: 'Good to train at normal intensity.',
      reasonCode: 'maintain',
      source: 'garmin',
      asOf: '2026-06-11T07:30:00.000Z',
      computedAt: '2026-06-11T07:30:00.000Z',
      dataAsOf: '2026-06-11T06:50:00.000Z',
      sleepDurationHours: 7.5,
      reasoning: 'Recovered well overnight.',
      factors: {
        sleepScore: 88,
        hrvStatus: 'stable',
        bodyBattery: 64,
        trainingLoad: 'ACWR 1.12',
      },
    });
    expect(second).toEqual(first);
    expect(hoisted.calculateReadiness).toHaveBeenCalledTimes(1);
  });

  it('keeps additive timestamp fields nullable when the scorer omits provenance', async () => {
    mockReadinessResult = {
      score: 60,
      recommendation: 'normal',
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      factors: {},
    };

    const result = await getReadiness(42);
    expect(result.source).toBeNull();
    expect(result.asOf).toBeNull();
    expect(result.computedAt).toBeNull();
    expect(result.dataAsOf).toBeNull();
    expect(result.sleepDurationHours).toBeNull();
    expect(result.reasoning).toBeNull();
  });

  it('passes sleep duration and reasoning through to the readiness adaptation snapshot', async () => {
    const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    mockActivePlan = {
      id: 11,
      name: 'Marathon Build',
      periodization: 'build',
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({}),
    };
    mockCurrentWeek = { id: 21, week_number: 1, focus: 'base' };
    mockWeekSessions = [{
      id: 31,
      day_of_week: todayName,
      title: 'Tempo Run',
      session_type: 'run',
      duration_minutes: 55,
      status: 'planned',
      description: 'Controlled threshold effort.',
      exercises_json: JSON.stringify([]),
    }];
    mockReadinessResult = {
      score: 41,
      recommendation: 'easy',
      reasonCode: 'poor_sleep',
      reasoning: 'Short sleep and suppressed HRV overnight.',
      factors: {
        sleep: { score: 40, durationHours: 4.5 },
        hrv: { trend: 'down' },
        bodyBattery: { current: 22 },
      },
    };

    await getTodaySession(42, 42);

    expect(hoisted.readinessSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
      score: 41,
      sleepHours: 4.5,
      hrvStatus: 'low',
      reasoning: 'Short sleep and suppressed HRV overnight.',
    }));
  });

  it('maps readiness into coach-kernel plan input and returns null for missing useful data', async () => {
    const freshDataAsOf = new Date().toISOString();
    mockReadinessResult = {
      score: 81,
      reasoning: 'Recovered well overnight.',
      computedAt: freshDataAsOf,
      asOf: freshDataAsOf,
      dataAsOf: freshDataAsOf,
      factors: {
        sleep: { durationHours: 7.5 },
        hrv: { trend: 'up' },
        bodyBattery: { current: 78 },
      },
    };

    const mapped = await fetchCurrentReadinessForPlan(42, 42);
    expect(mapped).toEqual({
      score: 81,
      confidence: 'fresh_wearable',
      dataSource: 'wearable',
      isStale: false,
      reasonCode: null,
      capturedAt: freshDataAsOf,
      sleepHours: 7.5,
      hrvStatus: 'high',
      energyReserve: 78,
      reasoning: 'Recovered well overnight.',
    });

    mockReadinessResult = { score: 0, factors: {} };
    const missing = await fetchCurrentReadinessForPlan(42, 42);
    expect(missing).toBeNull();
  });

  it('maps missing wearable integration into an honest no-data readiness input', async () => {
    mockReadinessResult = {
      score: 50,
      recommendation: 'normal',
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      reasoning: 'No wearable provider is connected; using neutral readiness.',
      factors: {},
    };

    const mapped = await fetchCurrentReadinessForPlan(42, 42);

    expect(mapped).toEqual({
      score: 50,
      confidence: 'no_data',
      dataSource: 'fallback',
      isStale: false,
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      sleepHours: undefined,
      hrvStatus: undefined,
      energyReserve: undefined,
      reasoning: 'No wearable provider is connected; using neutral readiness.',
    });
  });

  it('maps old wearable readiness provenance to stale_provider for planning', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    try {
      mockReadinessResult = {
        score: 62,
        recommendation: 'reduce_10pct',
        reasoning: 'Garmin readiness is available but old.',
        source: 'garmin',
        computedAt: '2026-07-08T12:00:00.000Z',
        asOf: '2026-07-08T12:00:00.000Z',
        dataAsOf: '2026-07-06T06:00:00.000Z',
        factors: {
          sleep: { durationHours: 6.2 },
          hrv: { trend: 'stable' },
          bodyBattery: { current: 55 },
        },
      };

      const mapped = await fetchCurrentReadinessForPlan(42, 42);

      expect(mapped).toEqual({
        score: 62,
        confidence: 'stale_provider',
        dataSource: 'wearable',
        isStale: true,
        reasonCode: 'wearable_sync_stale',
        capturedAt: '2026-07-06T06:00:00.000Z',
        sleepHours: 6.2,
        hrvStatus: 'normal',
        energyReserve: 55,
        reasoning: 'Garmin readiness is available but old.',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies source freshness conservatively without falling back to compute-time asOf', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const baseReadiness = {
      score: 70,
      recommendation: 'normal',
      reasoning: 'Edge-case readiness.',
      source: 'garmin',
      computedAt: '2026-07-08T12:00:00.000Z',
      asOf: '2026-07-08T12:00:00.000Z',
      factors: { sleep: { durationHours: 7 }, hrv: { trend: 'stable' }, bodyBattery: { current: 60 } },
    };
    try {
      // Recent same-day sync stays fresh.
      mockReadinessResult = { ...baseReadiness, dataAsOf: '2026-07-08T11:00:00.000Z' };
      expect(await fetchCurrentReadinessForPlan(42, 42)).toMatchObject({
        confidence: 'fresh_wearable',
        isStale: false,
        reasonCode: null,
        capturedAt: '2026-07-08T11:00:00.000Z',
      });

      // Exactly 36h is the boundary and stays fresh (strict '>' cutoff).
      mockReadinessResult = { ...baseReadiness, dataAsOf: '2026-07-07T00:00:00.000Z' };
      expect(await fetchCurrentReadinessForPlan(42, 42)).toMatchObject({
        confidence: 'fresh_wearable',
        isStale: false,
      });

      // Stronger F32 guarantee: a fresh computation/legacy alias cannot
      // upgrade missing source provenance, but absence is not evidence that
      // the provider data is old. Use the existing no-data confidence with a
      // wearable source and an explicit freshness-unknown reason instead of
      // fabricating `stale_provider`.
      mockReadinessResult = { ...baseReadiness };
      const unknownFreshness = await fetchCurrentReadinessForPlan(42, 42);
      expect(unknownFreshness).toMatchObject({
        confidence: 'no_data',
        dataSource: 'wearable',
        isStale: false,
        reasonCode: 'wearable_freshness_unknown',
      });
      expect(unknownFreshness).not.toHaveProperty('capturedAt');

      // Malformed and future provider timestamps are untrustworthy and must
      // degrade conservatively rather than becoming fresh or pretending old.
      mockReadinessResult = { ...baseReadiness, dataAsOf: 'not-a-date' };
      expect(await fetchCurrentReadinessForPlan(42, 42)).toMatchObject({
        confidence: 'no_data',
        isStale: false,
        reasonCode: 'wearable_freshness_unknown',
      });
      mockReadinessResult = { ...baseReadiness, dataAsOf: '2026-07-09T12:00:00.000Z' };
      expect(await fetchCurrentReadinessForPlan(42, 42)).toMatchObject({
        confidence: 'no_data',
        isStale: false,
        reasonCode: 'wearable_freshness_unknown',
      });

      // Missing integration outranks staleness: no_data wins over old source data.
      mockReadinessResult = {
        ...baseReadiness,
        score: 50,
        reasonCode: 'WEARABLE_INTEGRATION_MISSING',
        dataAsOf: '2026-07-05T00:00:00.000Z',
        factors: {},
      };
      expect(await fetchCurrentReadinessForPlan(42, 42)).toMatchObject({
        confidence: 'no_data',
        dataSource: 'fallback',
        isStale: false,
        reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Bug fix 2026-04-28 (no-plan create-CTA) ────────────────────────
  //
  // Regression pin for the user-reported bug where deleting a Training
  // plan still rendered "Today's workout completed" on iOS without any
  // way to create a new plan. The root cause was the calendar + Garmin
  // fallbacks in getTodaySession running unconditionally, so a Garmin-
  // recorded workout for the day got dressed up as a Nexus session
  // with `status: 'completed'`. With no active plan, that fallback
  // result is misleading — these tests pin that the fallback paths
  // now stay silent when no active plan exists.
  describe('getTodaySession — no-active-plan fallback gating', () => {
    it('returns null session when no active plan exists, even if Garmin recorded an activity today', async () => {
      mockActivePlan = null;
      mockGarminActivities = [{
        activityId: 12345,
        activityName: 'Cycling',
        activityType: { typeKey: 'cycling' },
        duration: 54 * 60, // 54 minutes — matches the user-reported screenshot duration
      }];
      hoisted.getActivitiesByDateForUser.mockResolvedValueOnce(mockGarminActivities);

      const result = await getTodaySession(42, 42);

      // Plan summary must be null since there's no active plan.
      expect(result.plan).toBeNull();
      // Session must be null even though Garmin had an activity — the
      // pre-fix behavior would have returned `{type: 'Cycling',
      // status: 'completed', duration: 54}` here.
      expect(result.session).toBeNull();
      // The Garmin call must not even have happened — the plan gate
      // short-circuits before we reach the Garmin fetch.
      expect(hoisted.getActivitiesByDateForUser).not.toHaveBeenCalled();
    });

    it('still returns Garmin fallback when an active plan exists but has no session today', async () => {
      // The fallback's legitimate use case: user has a plan but didn't
      // schedule a session for today, AND Garmin shows they trained
      // anyway. The hero card surfaces the activity so the user sees
      // their effort acknowledged in the planned context.
      mockActivePlan = {
        id: 7,
        name: 'Marathon Build',
        periodization: 'base',
        start_date: '2026-04-20T00:00:00.000Z',
      };
      mockCurrentWeek = { id: 70, week_number: 1, focus: 'base' };
      mockWeekSessions = []; // No plan-scheduled session for today
      mockGarminActivities = [{
        activityId: 99,
        activityName: 'Easy Run',
        activityType: { typeKey: 'running' },
        duration: 35 * 60,
      }];
      hoisted.getActivitiesByDateForUser.mockResolvedValueOnce(mockGarminActivities);

      const result = await getTodaySession(42, 42);

      expect(result.plan).toMatchObject({ id: 7, name: 'Marathon Build' });
      expect(result.session).not.toBeNull();
      expect(result.session).toMatchObject({
        type: 'Easy Run',
        sessionType: 'run',
        duration: 35,
        status: 'completed',
      });
    });

    it('returns null session when no active plan AND no Garmin data', async () => {
      mockActivePlan = null;
      hoisted.getActivitiesByDateForUser.mockResolvedValueOnce([]);

      const result = await getTodaySession(42, 42);

      expect(result.plan).toBeNull();
      expect(result.session).toBeNull();
      // Same short-circuit applies: don't call Garmin at all when no plan.
      expect(hoisted.getActivitiesByDateForUser).not.toHaveBeenCalled();
    });
  });

  describe('getAllPlanWeeks — canonical plan semantics from preferences_json', () => {
    it('exposes goal, raceDate, goalMode, and persisted scheduling timezone', async () => {
      mockActivePlan = {
        id: 14,
        name: 'Marathon Build',
        goal: 'marathon_endurance',
        plan_version: 3,
        duration_weeks: 12,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-07-12T00:00:00.000Z',
        periodization: 'build',
        preferences_json: JSON.stringify({
          preferredTime: 'morning',
          goalMode: 'race',
          raceDate: '2026-07-12',
          schedulingTimezone: 'Europe/Lisbon',
        }),
      };
      mockPlanWeeks = [{ id: 140, week_number: 1, focus: 'base', intensity_pct: 60 }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan).toMatchObject({
        id: 14,
        name: 'Marathon Build',
        goal: 'marathon_endurance',
        raceDate: '2026-07-12',
        goalMode: 'race',
        schedulingTimezone: 'Europe/Lisbon',
      });
      expect(result.weeks).toHaveLength(1);
    });

    it('surfaces whyThisPlan from the persisted full quality payload, trimmed and filtered', async () => {
      mockActivePlan = {
        id: 15,
        name: 'Quality Payload Plan',
        duration_weeks: 8,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-06-14T00:00:00.000Z',
        periodization: 'linear',
        preferences_json: JSON.stringify({
          trainingPlanQuality: {
            schemaVersion: 1,
            validation: { passed: true, score: 92, errors: [], warnings: [] },
            whyThisPlan: ['  Progressive overload matched to 4 days/week  ', '', 'Deload every 4th week', 42],
          },
        }),
      };
      mockPlanWeeks = [{ id: 150, week_number: 1, focus: 'base', intensity_pct: 60 }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan?.whyThisPlan).toEqual([
        'Progressive overload matched to 4 days/week',
        'Deload every 4th week',
        '42',
      ]);
    });

    it('returns an empty whyThisPlan for legacy plans persisted with the validation-only quality shape', async () => {
      mockActivePlan = {
        id: 17,
        name: 'Legacy Quality Plan',
        duration_weeks: 8,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-06-14T00:00:00.000Z',
        periodization: 'linear',
        preferences_json: JSON.stringify({
          // Pre-fix persisted shape: the bare validation result, no
          // schemaVersion/whyThisPlan. Readback must degrade gracefully.
          trainingPlanQuality: { passed: true, score: 88, errors: [], warnings: [] },
        }),
      };
      mockPlanWeeks = [{ id: 170, week_number: 1, focus: 'base', intensity_pct: 60 }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan?.whyThisPlan).toEqual([]);
    });

    it('exposes per-week learning focus from the persisted trainingLearningPath', async () => {
      mockActivePlan = {
        id: 16,
        name: 'Hybrid Learning Block',
        duration_weeks: 4,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-05-17T00:00:00.000Z',
        periodization: 'base',
        preferences_json: JSON.stringify({
          trainingLearningPath: {
            schemaVersion: 1,
            objective: 'Build hybrid fitness',
            planGoal: 'Create a repeatable training rhythm.',
            measurableOutcomes: ['Session completion and skip rate'],
            weeklyPath: [
              {
                weekNumber: 1,
                title: 'Week 1: Establish baseline and rhythm',
                phaseGoal: 'Establish baseline and rhythm',
                weeklyLearningFocus: 'Separate easy running from quality work.',
                whyThisMatters: 'Intent makes feedback useful.',
                techniqueCards: ['Run easy enough to repeat tomorrow.'],
                benchmarkSessionTitles: ['Threshold Run Benchmark'],
                assessmentPrompt: 'Was the benchmark controlled?',
              },
            ],
          },
        }),
      };
      mockPlanWeeks = [{ id: 160, week_number: 1, focus: 'base', intensity_pct: 60 }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.weeks[0]).toMatchObject({
        weekNumber: 1,
        learningFocus: {
          title: 'Week 1: Establish baseline and rhythm',
          phaseGoal: 'Establish baseline and rhythm',
          weeklyLearningFocus: 'Separate easy running from quality work.',
          whyThisMatters: 'Intent makes feedback useful.',
          techniqueCards: ['Run easy enough to repeat tomorrow.'],
          benchmarkSessionTitles: ['Threshold Run Benchmark'],
          assessmentPrompt: 'Was the benchmark controlled?',
        },
      });
    });

    it.each([
      ['null preferences_json', null],
      ['malformed preferences_json', '{not json'],
    ])('returns null raceDate/goalMode without throwing for %s', async (_label, preferencesJson) => {
      mockActivePlan = {
        id: 15,
        name: 'General Fitness',
        duration_weeks: 8,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-06-15T00:00:00.000Z',
        periodization: 'base',
        preferences_json: preferencesJson,
      };
      mockPlanWeeks = [{ id: 150, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan).toMatchObject({
        id: 15,
        raceDate: null,
        goalMode: null,
      });
      expect(result.weeks).toHaveLength(1);
    });

    it('exposes requested and scheduled weekly targets from preferences_json', async () => {
      mockActivePlan = {
        id: 17,
        name: 'Triathlon Base',
        duration_weeks: 12,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-07-12T00:00:00.000Z',
        periodization: 'base',
        preferences_json: JSON.stringify({
          // Flat keys = REALIZED targets, re-persisted from the finalized
          // plan; requestedTargets = the user's original ask.
          sessionsPerWeek: 5,
          runSessionsPerWeek: 2,
          bikeSessionsPerWeek: 2,
          swimSessionsPerWeek: 1,
          strengthSessionsPerWeek: 0,
          requestedTargets: {
            sessionsPerWeek: 6,
            runSessionsPerWeek: 3,
            bikeSessionsPerWeek: 2,
            swimSessionsPerWeek: 1,
            strengthSessionsPerWeek: 0,
          },
        }),
      };
      mockPlanWeeks = [{ id: 170, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan?.weeklyTargets).toEqual({
        requested: {
          sessionsPerWeek: 6,
          runSessionsPerWeek: 3,
          bikeSessionsPerWeek: 2,
          swimSessionsPerWeek: 1,
          strengthSessionsPerWeek: 0,
        },
        scheduled: {
          sessionsPerWeek: 5,
          runSessionsPerWeek: 2,
          bikeSessionsPerWeek: 2,
          swimSessionsPerWeek: 1,
          strengthSessionsPerWeek: 0,
        },
      });
    });

    it('returns null requested targets for legacy plans without requestedTargets', async () => {
      mockActivePlan = {
        id: 18,
        name: 'Legacy Plan',
        duration_weeks: 8,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-06-15T00:00:00.000Z',
        periodization: 'base',
        preferences_json: JSON.stringify({
          sessionsPerWeek: 4,
          runSessionsPerWeek: 3,
          strengthSessionsPerWeek: 1,
        }),
      };
      mockPlanWeeks = [{ id: 180, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan?.weeklyTargets).toEqual({
        requested: null,
        scheduled: {
          sessionsPerWeek: 4,
          runSessionsPerWeek: 3,
          bikeSessionsPerWeek: null,
          swimSessionsPerWeek: null,
          strengthSessionsPerWeek: 1,
        },
      });
    });

    it.each([
      ['null preferences_json', null],
      ['malformed preferences_json', '{not json'],
      ['junk-valued targets', JSON.stringify({
        sessionsPerWeek: 'five',
        runSessionsPerWeek: Number.NaN,
        requestedTargets: { sessionsPerWeek: '6', runSessionsPerWeek: [] },
      })],
    ])('returns null weeklyTargets without throwing for %s', async (_label, preferencesJson) => {
      mockActivePlan = {
        id: 19,
        name: 'Robustness Plan',
        duration_weeks: 8,
        status: 'active',
        start_date: '2026-04-20T00:00:00.000Z',
        end_date: '2026-06-15T00:00:00.000Z',
        periodization: 'base',
        preferences_json: preferencesJson,
      };
      mockPlanWeeks = [{ id: 190, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan?.weeklyTargets ?? null).toBeNull();
      expect(result.weeks).toHaveLength(1);
    });
  });

  describe('calendarCleanup — dead-lettered provider events (migration 220)', () => {
    const basePlan = {
      id: 20,
      name: 'Cleanup Plan',
      duration_weeks: 8,
      status: 'active',
      start_date: '2026-04-20T00:00:00.000Z',
      end_date: '2026-06-15T00:00:00.000Z',
      periodization: 'base',
      preferences_json: null,
    };

    it('exposes the dead-lettered count and scopes the query to the training user/tenant', async () => {
      mockActivePlan = { ...basePlan };
      mockPlanWeeks = [{ id: 200, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];
      mockAgendaDb.deadLetteredCount = 2;

      const result = await getAllPlanWeeks(42, 7);

      expect(result.calendarCleanup).toEqual({ deadLetteredCount: 2 });
      // user id, TEXT tenant id, dead-letter threshold — in bind order.
      expect(mockAgendaDb.lastCountArgs).toEqual([42, '7', 5]);
    });

    it('returns null calendarCleanup when nothing is dead-lettered', async () => {
      mockActivePlan = { ...basePlan };
      mockPlanWeeks = [{ id: 200, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];
      mockAgendaDb.deadLetteredCount = 0;

      const result = await getAllPlanWeeks(42, 42);

      expect(result.calendarCleanup).toBeNull();
    });

    it('still reports ghost events after the plan is gone (no-plan path)', async () => {
      mockActivePlan = null;
      mockAgendaDb.deadLetteredCount = 1;

      const result = await getAllPlanWeeks(42, 42);

      expect(result.plan).toBeNull();
      expect(result.calendarCleanup).toEqual({ deadLetteredCount: 1 });
    });

    it.each([
      ['pre-migration DB (column missing)', () => { mockAgendaDb.hasFailureCountColumn = false; }],
      ['agenda table missing', () => { mockAgendaDb.hasTable = false; }],
      ['db unavailable', () => { mockAgendaDb.throwOnAccess = true; }],
    ])('returns null without throwing when %s', async (_label, arrange) => {
      mockActivePlan = { ...basePlan };
      mockPlanWeeks = [{ id: 200, week_number: 1, focus: 'base' }];
      mockWeekSessions = [];
      mockAgendaDb.deadLetteredCount = 3;
      arrange();

      const result = await getAllPlanWeeks(42, 42);

      expect(result.calendarCleanup).toBeNull();
      expect(result.weeks).toHaveLength(1);
    });
  });
});
