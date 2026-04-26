import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { DateTime } from 'luxon';

const mockGetEvents = vi.fn();
const mockCreateEvent = vi.fn();
const mockIsAnyCalendarConfigured = vi.fn();
const mockCalculateReadiness = vi.fn();
const mockReadTrainingContextAll = vi.fn();
const mockReadScheduledTrainingSessions = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
  isAnyCalendarConfigured: (...args: unknown[]) => mockIsAnyCalendarConfigured(...args),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: (...args: unknown[]) => mockCalculateReadiness(...args),
}));

vi.mock('../../src/services/training-signals', () => ({
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
  readScheduledTrainingSessions: (...args: unknown[]) => mockReadScheduledTrainingSessions(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserTimezone: vi.fn(() => 'Europe/Lisbon'),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: vi.fn(() => null),
  setCache: vi.fn(),
  clearCache: vi.fn(),
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { timezone: 'Europe/Lisbon' },
  },
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
}));

import { calendarRoutes } from '../../src/api/routes/calendar';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
  setHeader(): MockRes;
  end(): MockRes;
}

function mockRes(): MockRes {
  const response: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { response.statusCode = code; return response; },
    json(body: any) { response.body = body; return response; },
    setHeader() { return response; },
    end() { return response; },
  };
  return response;
}

function mockReq(url: string): Request {
  const parsed = new URL(url, 'http://test.local');
  return {
    method: 'GET',
    url: parsed.pathname + parsed.search,
    originalUrl: parsed.pathname + parsed.search,
    baseUrl: '',
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams.entries()),
    params: {},
    headers: {},
    userId: 12,
  } as any;
}

async function dispatch(url: string): Promise<MockRes> {
  const router = calendarRoutes();
  const req = mockReq(url);
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('Calendar API — focus recommendation', () => {
  beforeEach(() => {
    mockGetEvents.mockReset();
    mockCreateEvent.mockReset();
    mockIsAnyCalendarConfigured.mockReset();
    mockCalculateReadiness.mockReset();
    mockReadTrainingContextAll.mockReset();
    mockReadScheduledTrainingSessions.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();

    mockIsAnyCalendarConfigured.mockReturnValue(true);
    mockReadTrainingContextAll.mockReturnValue({
      signals: [],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: false,
        highLegLoad: false,
        highShoulderLoad: false,
        raceThisWeek: false,
        lowAdherence: false,
        highAdherence: false,
        planDrift: false,
        otherSportRpeToday: 0,
      },
    });
    mockReadScheduledTrainingSessions.mockReturnValue([]);
    mockGetActivePlans.mockReturnValue([]);
    mockGetWeeksForPlan.mockReturnValue([]);
    mockGetSessionsForWeek.mockReturnValue([]);
  });

  it('prefers the cleaner next-day morning block when today is hard and fragmented', async () => {
    const zone = 'Europe/Lisbon';
    const today = DateTime.now().setZone(zone).startOf('day');
    const tomorrow = today.plus({ days: 1 });

    mockCalculateReadiness.mockResolvedValue({ score: 58 });
    mockGetActivePlans.mockReturnValue([
      {
        id: 77,
        user_id: 12,
        start_date: today.startOf('week').toISODate(),
        duration_weeks: 2,
        status: 'active',
      },
    ]);
    mockGetWeeksForPlan.mockReturnValue([
      { id: 501, week_number: 1 },
      { id: 502, week_number: 2 },
    ]);
    mockGetSessionsForWeek.mockImplementation((weekId: number) => {
      if (weekId !== 501) return [];
      return [
        {
          id: 1,
          week_id: 501,
          day_of_week: today.toFormat('EEEE'),
          session_type: 'running',
          title: 'Track intervals',
          intensity_text: 'VO2 intervals',
          description: '',
        },
      ];
    });
    mockGetEvents.mockResolvedValue([
      {
        summary: 'Leadership sync',
        start: today.set({ hour: 9, minute: 0 }).toUTC().toISO(),
        end: today.set({ hour: 10, minute: 0 }).toUTC().toISO(),
      },
      {
        summary: 'Client review',
        start: today.set({ hour: 10, minute: 30 }).toUTC().toISO(),
        end: today.set({ hour: 11, minute: 30 }).toUTC().toISO(),
      },
      {
        summary: 'Ops planning',
        start: today.set({ hour: 14, minute: 0 }).toUTC().toISO(),
        end: today.set({ hour: 15, minute: 30 }).toUTC().toISO(),
      },
      {
        summary: 'Quarterly prep',
        start: today.set({ hour: 16, minute: 0 }).toUTC().toISO(),
        end: today.set({ hour: 17, minute: 0 }).toUTC().toISO(),
      },
      {
        summary: 'Short check-in',
        start: tomorrow.set({ hour: 13, minute: 0 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 13, minute: 30 }).toUTC().toISO(),
      },
    ]);

    const res = await dispatch('/focus-recommendation?durationMinutes=90&horizonDays=3');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.focusRecommendation).toBeTruthy();
    expect(res.body.data.focusRecommendation.date).toBe(tomorrow.toISODate());
    expect(res.body.data.focusRecommendation.trainingLoad).toBe('rest');
    expect(res.body.data.focusRecommendation.calendarLoad).toBe('light');
    expect(res.body.data.focusRecommendation.trainingCoordination).toEqual({
      status: 'already_protected',
      sessionDate: today.toISODate(),
      sessionTitle: 'Track intervals',
      sessionLoad: 'hard',
    });

    const recommendedHour = DateTime.fromISO(res.body.data.focusRecommendation.start, { zone: 'utc' })
      .setZone(zone)
      .hour;
    expect(recommendedHour).toBeLessThanOrEqual(10);
  });

  it('moves the block away from today when readiness is poor', async () => {
    const zone = 'Europe/Lisbon';
    const today = DateTime.now().setZone(zone).startOf('day');

    mockCalculateReadiness.mockResolvedValue({ score: 42 });
    mockReadTrainingContextAll.mockReturnValue({
      signals: [{ signal_type: 'low_readiness' }],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: true,
        highLegLoad: false,
        highShoulderLoad: false,
        raceThisWeek: false,
        lowAdherence: false,
        highAdherence: false,
        planDrift: false,
        otherSportRpeToday: 0,
      },
    });
    mockGetEvents.mockResolvedValue([]);

    const res = await dispatch('/focus-recommendation');

    expect(res.statusCode).toBe(200);
    expect(res.body.data.focusRecommendation).toBeTruthy();
    expect(res.body.data.focusRecommendation.readinessScore).toBe(42);
    expect(res.body.data.focusRecommendation.date).not.toBe(today.toISODate());
    expect(['high', 'medium', 'low']).toContain(res.body.data.focusRecommendation.confidence);
    expect(res.body.data.focusRecommendation.trainingCoordination ?? null).toBeNull();
  });
});
