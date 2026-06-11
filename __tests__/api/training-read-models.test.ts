import { beforeEach, describe, expect, it, vi } from 'vitest';

const cache = new Map<string, any>();
const hoisted = vi.hoisted(() => ({
  calculateReadiness: vi.fn(),
  getActivitiesByDateForUser: vi.fn(),
}));

let mockActivePlan: any = null;
let mockCurrentWeek: any = null;
let mockWeekSessions: any[] = [];
let mockWeeklyAdherence: any = null;
let mockCalendarLookup = new Map<any, any>();
let mockReadinessResult: any = null;
let mockGarminActivities: any[] = [];

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

import {
  adaptDtoSessionForReadiness,
  fetchCurrentReadinessForPlan,
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
    mockWeekSessions = [];
    mockWeeklyAdherence = null;
    mockCalendarLookup = new Map();
    mockReadinessResult = null;
    mockGarminActivities = [];
    hoisted.calculateReadiness.mockReset();
    hoisted.getActivitiesByDateForUser.mockReset();
    (buildCalendarEventLookup as any).mockReset();
    (buildCalendarEventLookup as any).mockImplementation(async () => mockCalendarLookup);
    hoisted.calculateReadiness.mockImplementation(async () => mockReadinessResult);
    hoisted.getActivitiesByDateForUser.mockImplementation(async () => mockGarminActivities);
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
    mockActivePlan = { id: 10, name: 'Marathon Build', periodization: 'build', start_date: '2026-04-20T00:00:00.000Z' };
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

    const result = await getTodaySession(42, 42);

    expect(result.plan).toMatchObject({
      name: 'Marathon Build',
      weekNumber: 1,
      phase: 'base',
    });
    expect(result.session).toMatchObject({
      id: '30',
      type: 'Tempo Run',
      sessionType: 'run',
      time: '07:00',
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
    mockActivePlan = { id: 99, name: 'Strength Block', periodization: 'build', start_date: '2026-04-20T00:00:00.000Z' };
    mockCurrentWeek = { id: 199, week_number: 1, focus: 'strength' };
    mockWeekSessions = [
      { id: 501, day_of_week: 'Monday', title: 'Strength + Core', session_type: 'gym', calendar_event_id: 'evt-mon', duration_minutes: 40, status: 'planned', description: 'Lifting day.', exercises_json: JSON.stringify([{ name: 'squat' }, { name: 'press' }]) },
      { id: 502, day_of_week: 'Wednesday', title: 'Tempo Run', session_type: 'run', calendar_event_id: 'evt-wed', duration_minutes: 35, status: 'planned', description: 'Threshold.', exercises_json: null },
    ];
    const calendarMod = await import('../../src/api/routes/training-calendar-lookup');
    (calendarMod.buildCalendarEventLookup as any).mockRejectedValueOnce(new Error('invalid_grant'));

    const result = await getWeekPlan(42, 42);

    expect(result.plan).toMatchObject({ name: 'Strength Block', weekNumber: 1 });
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

  it('marks stale stored calendar links as missing in the week plan read model', async () => {
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
    });
  });

  it('marks mismatched linked calendar events as missing in the week plan read model', async () => {
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
      factors: {
        sleep: { score: 88 },
        hrv: { trend: 'stable' },
        bodyBattery: { current: 64 },
        trainingLoad: { acwr: 1.12 },
      },
    };

    const first = await getReadiness(42);
    const second = await getReadiness(42);

    expect(first).toMatchObject({
      score: 72,
      recommendation: 'Good to train at normal intensity.',
      reasonCode: 'maintain',
      source: 'garmin',
      asOf: '2026-06-11T07:30:00.000Z',
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

  it('passes null source and asOf through when the scorer omits provenance', async () => {
    mockReadinessResult = {
      score: 60,
      recommendation: 'normal',
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      factors: {},
    };

    const result = await getReadiness(42);
    expect(result.source).toBeNull();
    expect(result.asOf).toBeNull();
  });

  it('maps readiness into coach-kernel plan input and returns null for missing useful data', async () => {
    mockReadinessResult = {
      score: 81,
      reasoning: 'Recovered well overnight.',
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
});
