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
  fetchCurrentReadinessForPlan,
  getReadiness,
  getTodaySession,
  getWeekPlan,
} from '../../src/api/routes/training-read-models';

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
    hoisted.calculateReadiness.mockImplementation(async () => mockReadinessResult);
    hoisted.getActivitiesByDateForUser.mockImplementation(async () => mockGarminActivities);
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

    const result = await getTodaySession(42);

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

    const result = await getWeekPlan(42);

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

    const mapped = await fetchCurrentReadinessForPlan(42);
    expect(mapped).toEqual({
      score: 81,
      sleepHours: 7.5,
      hrvStatus: 'high',
      energyReserve: 78,
      reasoning: 'Recovered well overnight.',
    });

    mockReadinessResult = { score: 0, factors: {} };
    const missing = await fetchCurrentReadinessForPlan(42);
    expect(missing).toBeNull();
  });
});
