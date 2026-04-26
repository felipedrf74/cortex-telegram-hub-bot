// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreatePlan = vi.fn();
const mockCreateWeek = vi.fn();
const mockCreateSession = vi.fn();
const mockLinkSessionToCalendar = vi.fn();
const mockCreateEvent = vi.fn();
const mockLoggerWarn = vi.fn();

vi.mock('../../src/services/training-plans', () => ({
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  createWeek: (...args: unknown[]) => mockCreateWeek(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

import { persistGeneratedTrainingPlan } from '../../src/api/routes/training-plan-persistence';

describe('training-plan-persistence', () => {
  beforeEach(() => {
    mockCreatePlan.mockReset();
    mockCreateWeek.mockReset();
    mockCreateSession.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockCreateEvent.mockReset();
    mockLoggerWarn.mockReset();

    mockCreatePlan.mockReturnValue({ id: 901 });
    mockCreateWeek.mockImplementation(({ week_number }: any) => ({ id: 1000 + Number(week_number || 1) }));
    let sessionId = 2000;
    mockCreateSession.mockImplementation(() => ({ id: ++sessionId }));
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
  });

  it('persists generated weeks and sessions, schedules events, and links created calendar events', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Marathon build',
      durationWeeks: 4,
      startDate: '2026-04-19',
      endDate: '2026-05-17',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{"preferredTime":"12:00"}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        planName: 'Marathon Plan',
        sport: 'running',
        periodization: 'block',
        weeks: [
          {
            weekNumber: 1,
            focus: 'base',
            intensityPct: 72,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Base Run',
                durationMinutes: 50,
                description: 'Easy aerobic work.',
                exercises: [{ name: 'Warm-up', distance_km: 1 }],
              },
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Runner Strength',
                durationMinutes: 40,
                description: 'Strength work.',
                exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, rpe: '7', restSec: 90 }],
              },
              {
                dayOfWeek: 'Tuesday',
                sessionType: 'rest',
                title: 'Rest',
                durationMinutes: 30,
              },
            ],
          },
        ],
      },
    });

    expect(result).toEqual({
      planId: 901,
      totalSessions: 2,
      eventsCreated: 2,
      weekSummaries: [{ weekNumber: 1, focus: 'base', sessionCount: 2 }],
    });
    expect(mockCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 12,
      name: 'Marathon Plan',
      sport: 'running',
      preferences_json: '{"preferredTime":"12:00"}',
    }));
    expect(mockCreateWeek).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 901,
      week_number: 1,
      volume_sessions: 3,
    }));
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Base Run',
      session_type: 'run',
      duration_minutes: 50,
      intensity_text: 'RPE 72%',
    }));
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Base Run (50min)'),
        description: expect.stringContaining('EXERCISES:'),
      }),
      undefined,
      12,
    );
    expect(mockLinkSessionToCalendar).toHaveBeenCalledTimes(2);
  });

  it('keeps plan persistence successful when individual calendar event creation fails', async () => {
    mockCreateEvent
      .mockRejectedValueOnce(new Error('calendar unavailable'))
      .mockResolvedValueOnce({ id: 'evt-2', source: 'google' });

    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Hybrid block',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run', durationMinutes: 35 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Lift', durationMinutes: 45 },
            ],
          },
        ],
      },
    });

    expect(result.totalSessions).toBe(2);
    expect(result.eventsCreated).toBe(1);
    expect(mockLinkSessionToCalendar).toHaveBeenCalledTimes(1);
    expect(mockLinkSessionToCalendar).toHaveBeenCalledWith(2002, 'evt-2', 'google');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('Run') }),
      'Failed to create calendar event for session',
    );
  });

  it('creates calendar events sequentially to avoid provider write bursts', async () => {
    let resolveFirst!: (value: { id: string; source: string }) => void;
    mockCreateEvent
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ id: 'evt-2', source: 'google' });

    const pending = persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Strength block',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Lift A', durationMinutes: 45 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Lift B', durationMinutes: 45 },
            ],
          },
        ],
      },
    });

    await Promise.resolve();
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);

    resolveFirst({ id: 'evt-1', source: 'google' });
    const result = await pending;

    expect(result.eventsCreated).toBe(2);
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    expect(mockLinkSessionToCalendar).toHaveBeenCalledWith(2001, 'evt-1', 'google');
    expect(mockLinkSessionToCalendar).toHaveBeenCalledWith(2002, 'evt-2', 'google');
  });
});
