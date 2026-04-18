import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';

const mockGetEvents = vi.fn();
const mockCalculateReadiness = vi.fn();
const mockReadTrainingContextAll = vi.fn();
const mockReadScheduledTrainingSessions = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
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

import { getFocusBlockRecommendation } from '../../src/services/focus-planner';

describe('focus-planner', () => {
  beforeEach(() => {
    mockGetEvents.mockReset();
    mockCalculateReadiness.mockReset();
    mockReadTrainingContextAll.mockReset();
    mockReadScheduledTrainingSessions.mockReset();
    mockGetActivePlans.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();

    mockCalculateReadiness.mockResolvedValue({ score: 71 });
    mockReadTrainingContextAll.mockReturnValue({
      signals: [],
      flags: {
        lowSleep: false,
        lowHrv: false,
        lowReadiness: false,
        highLegLoad: false,
      },
    });
    mockReadScheduledTrainingSessions.mockReturnValue([]);
    mockGetWeeksForPlan.mockReturnValue([{ id: 701, week_number: 1 }]);
  });

  it('prefers the next actionable day over a slightly cleaner later day', async () => {
    const zone = 'Europe/Lisbon';
    const today = DateTime.now().setZone(zone).startOf('day');
    const tomorrow = today.plus({ days: 1 });
    const dayAfter = today.plus({ days: 2 });

    mockGetActivePlans.mockReturnValue([
      {
        id: 81,
        user_id: 7,
        start_date: today.startOf('week').toISODate(),
        duration_weeks: 1,
        status: 'active',
      },
    ]);
    mockGetSessionsForWeek.mockImplementation(() => [
      {
        id: 1,
        week_id: 701,
        day_of_week: tomorrow.toFormat('EEEE'),
        session_type: 'strength',
        title: 'Gym strength',
        intensity_text: 'steady',
        description: '',
      },
    ]);

    mockGetEvents.mockResolvedValue([
      {
        summary: 'Today blocked',
        start: today.set({ hour: 8, minute: 0 }).toUTC().toISO(),
        end: today.set({ hour: 18, minute: 30 }).toUTC().toISO(),
      },
      {
        summary: 'Lunch check-in',
        start: tomorrow.set({ hour: 13, minute: 0 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 13, minute: 30 }).toUTC().toISO(),
      },
    ]);

    const recommendation = await getFocusBlockRecommendation(7, { durationMinutes: 90, horizonDays: 4 });

    expect(recommendation).toBeTruthy();
    expect(recommendation?.date).toBe(tomorrow.toISODate());
    expect(recommendation?.trainingLoad).toBe('moderate');
    expect(recommendation?.calendarLoad).toBe('light');
    expect(recommendation?.date).not.toBe(dayAfter.toISODate());
  });

  it('skips the next day when it is already too busy and recommends the following clean day', async () => {
    const zone = 'Europe/Lisbon';
    const today = DateTime.now().setZone(zone).startOf('day');
    const tomorrow = today.plus({ days: 1 });
    const dayAfter = today.plus({ days: 2 });

    mockGetActivePlans.mockReturnValue([]);
    mockGetEvents.mockResolvedValue([
      {
        summary: 'Today blocked',
        start: today.set({ hour: 8, minute: 0 }).toUTC().toISO(),
        end: today.set({ hour: 18, minute: 30 }).toUTC().toISO(),
      },
      {
        summary: 'Standup',
        start: tomorrow.set({ hour: 8, minute: 30 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 9, minute: 30 }).toUTC().toISO(),
      },
      {
        summary: 'Planning',
        start: tomorrow.set({ hour: 10, minute: 0 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 11, minute: 0 }).toUTC().toISO(),
      },
      {
        summary: '1:1',
        start: tomorrow.set({ hour: 13, minute: 0 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 14, minute: 0 }).toUTC().toISO(),
      },
      {
        summary: 'Review',
        start: tomorrow.set({ hour: 15, minute: 0 }).toUTC().toISO(),
        end: tomorrow.set({ hour: 16, minute: 0 }).toUTC().toISO(),
      },
    ]);

    const recommendation = await getFocusBlockRecommendation(7, { durationMinutes: 90, horizonDays: 4 });

    expect(recommendation).toBeTruthy();
    expect(recommendation?.date).toBe(dayAfter.toISODate());
    expect(recommendation?.calendarLoad).toBe('light');
  });
});
