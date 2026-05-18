// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreatePlan = vi.fn();
const mockCreateWeek = vi.fn();
const mockCreateSession = vi.fn();
const mockLinkSessionToCalendar = vi.fn();
const mockCreateEvent = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
// Slice 4.D — the lifecycle module hits the real DB. Mocked here so
// the existing persistence-layer unit test can keep its in-memory
// stub shape. The pure logic of the lifecycle module is exercised by
// __tests__/services/training-plan-lifecycle.test.ts.
const mockGetPlanVersion = vi.fn();
const mockFindExistingOwnership = vi.fn();
const mockRecordCalendarOwnership = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();

vi.mock('../../src/services/training-plans', () => ({
  createPlan: (...args: unknown[]) => mockCreatePlan(...args),
  createWeek: (...args: unknown[]) => mockCreateWeek(...args),
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: (...args: unknown[]) => mockCreateEvent(...args),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  getPlanVersion: (...args: unknown[]) => mockGetPlanVersion(...args),
  findExistingOwnership: (...args: unknown[]) => mockFindExistingOwnership(...args),
  recordCalendarOwnership: (...args: unknown[]) => mockRecordCalendarOwnership(...args),
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  lintGeneratedTrainingPlanPreflight,
  persistGeneratedTrainingPlan,
} from '../../src/api/routes/training-plan-persistence';

describe('training-plan-persistence', () => {
  beforeEach(() => {
    delete process.env.TRAINING_ENGINE_ENABLED;
    delete process.env.TRAINING_ENGINE_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;

    mockCreatePlan.mockReset();
    mockCreateWeek.mockReset();
    mockCreateSession.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockCreateEvent.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerInfo.mockReset();
    mockGetPlanVersion.mockReset();
    mockFindExistingOwnership.mockReset();
    mockRecordCalendarOwnership.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();

    mockCreatePlan.mockReturnValue({ id: 901 });
    mockCreateWeek.mockImplementation(({ week_number }: any) => ({ id: 1000 + Number(week_number || 1) }));
    let sessionId = 2000;
    mockCreateSession.mockImplementation(() => ({ id: ++sessionId }));
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'outlook' });
    // Slice 4.D defaults: fresh plan_version=1, no prior ownership rows,
    // ownership recorder reports clean inserts.
    mockGetPlanVersion.mockReturnValue(1);
    mockFindExistingOwnership.mockReturnValue(null);
    mockRecordCalendarOwnership.mockReturnValue({ ok: true, created: true, ownershipId: 1 });
    mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: intent.preferredWindows[0].start,
        scheduledEnd: intent.preferredWindows[0].end,
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));
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
      // training-expert-coach-knowledge-engine (2026-05-03):
      // The persister now runs the deterministic plan-linter in advisor
      // mode. Healthy plans return `pass` with empty findings.
      lint: {
        status: 'pass',
        blockers: [],
        warnings: [],
        suggestedFixes: [],
      },
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
      volume_sessions: 2,
    }));
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Base Run',
      session_type: 'run',
      duration_minutes: 50,
      intensity_text: 'RPE 72%',
      status: 'scheduled',
      session_identity_key: expect.stringContaining('plan:901|week:1|day:monday|type:run|slot:1'),
      session_shape_hash: expect.any(String),
    }));
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledTimes(2);
    expect(mockSubmitSecretarySchedulingIntent.mock.invocationCallOrder[0])
      .toBeLessThan(mockCreateEvent.mock.invocationCallOrder[0]);
    expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSkill: 'training',
        sourceAction: 'schedule_training_session',
        sourceEntityType: 'training_session',
        ownerUserId: 12,
        tenantId: 12,
        preferredWindows: [expect.objectContaining({ hard: true })],
      }),
      expect.any(Object),
    );
    expect(mockCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('Base Run (50min)'),
        description: expect.stringContaining('EXERCISES:'),
      }),
      undefined,
      12,
      expect.objectContaining({ tenantId: 12 }),
    );
    expect(mockCreateEvent.mock.calls[0][0].description).toContain('[NEXUS_TRAINING_IDENTITY');
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
      expect.objectContaining({
        userId: 12,
        planId: 901,
        planVersion: 1,
        sessionId: 2001,
      }),
      'Failed to create calendar event for session',
    );
    expect(mockLoggerWarn.mock.calls[0]?.[0]).not.toHaveProperty('title');
  });

  it('does not persist standalone mobility sessions as calendar workouts', async () => {
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
              { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Lift', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
              { dayOfWeek: 'Tuesday', sessionType: 'mobility', title: 'Mobility + Recovery', durationMinutes: 30, exercises: [] },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Mobility Reset', durationMinutes: 25, exercises: [] },
            ],
          },
        ],
      },
    });

    expect(result.totalSessions).toBe(1);
    expect(result.eventsCreated).toBe(1);
    expect(result.weekSummaries).toEqual([{ weekNumber: 1, focus: undefined, sessionCount: 1 }]);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
  });

  it('persists deferred and unscheduled capacity-reconciliation sessions as inactive rows without calendar events', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Constrained week',
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
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Scheduled Lift',
                durationMinutes: 35,
                scheduleState: 'compressed',
                scheduleReason: 'Compressed from 45 to 35 minutes because only a short hotel-gym window was available.',
                exercises: [{ name: 'Goblet Squat' }],
              },
              { dayOfWeek: 'Tuesday', sessionType: 'rest', title: 'Unscheduled Lift', durationMinutes: 45, scheduleState: 'unscheduled', scheduleReason: 'No feasible slot remained.' },
              { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Deferred Run', durationMinutes: 0, scheduleState: 'deferred', scheduleReason: 'Deferred by capacity reconciliation.' },
            ],
          },
        ],
      },
    });

    expect(result.totalSessions).toBe(1);
    expect(result.eventsCreated).toBe(1);
    expect(result.weekSummaries).toEqual([{ weekNumber: 1, focus: undefined, sessionCount: 1 }]);
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled Lift',
      status: 'compressed',
      description: expect.stringContaining('Compressed from 45 to 35 minutes'),
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Unscheduled Lift',
      status: 'unscheduled',
      duration_minutes: 45,
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Deferred Run',
      status: 'deferred',
    }));
    expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent.mock.calls[0]?.[0]?.description).toContain('Compressed from 45 to 35 minutes');
  });

  it('persists reflowed/capped schedule adjustments as rich lifecycle states for iOS read models', async () => {
    await persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Travel week',
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
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Reflowed Run',
                durationMinutes: 30,
                scheduleAdjustments: ['reflowed', 'compressed'],
                scheduleReason: 'Moved around travel and compressed to fit the available window.',
              },
              {
                dayOfWeek: 'Thursday',
                sessionType: 'gym',
                title: 'Capped Lift',
                durationMinutes: 25,
                scheduleAdjustments: ['capped'],
                scheduleReason: 'Capped to the available hotel-gym window.',
              },
            ],
          },
        ],
      },
    });

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reflowed Run',
      status: 'reflowed',
      description: expect.stringContaining('Moved around travel'),
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Capped Lift',
      status: 'capped',
      description: expect.stringContaining('Capped to the available hotel-gym window'),
    }));
    expect(mockCreateEvent).toHaveBeenCalledTimes(2);
  });

  it('persists a session as unscheduled when real calendar busy windows leave no valid slot', async () => {
    const day = new Date('2026-04-20T00:00:00.000Z');
    const blockStart = new Date(day); blockStart.setHours(5, 0, 0, 0);
    const blockEnd = new Date(day); blockEnd.setHours(21, 0, 0, 0);

    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      objective: 'Calendar constrained week',
      durationWeeks: 1,
      startDate: '2026-04-20',
      endDate: '2026-04-27',
      now: day,
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [{ startMs: blockStart.getTime(), endMs: blockEnd.getTime(), title: 'Fully booked day' }],
      planData: {
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Lift', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
          ],
        }],
      },
    });

    expect(result.totalSessions).toBe(0);
    expect(result.eventsCreated).toBe(0);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Lift',
      status: 'unscheduled',
      duration_minutes: 45,
      preferred_time_unavailable: true,
      description: expect.stringContaining('No valid free calendar window remained'),
    }));
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();
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

  // training-expert-coach-knowledge-engine (2026-05-03):
  // mid-week-creation past-day floor. Before this fix, creating a plan on
  // Wednesday with a "week 1 Monday" session silently slid the session to
  // *next* Monday — users lost Mon/Tue of week 1 with no warning. The fix
  // marks past days as `unscheduled` with a clear `unavailableReason`
  // surfaced in the session description, leveraging the same plumbing as
  // the no-available-slot path.
  describe('mid-week creation past-day floor', () => {
    it('marks week 1 Monday as unscheduled when plan is generated on Wednesday', async () => {
      // 2026-04-22 is a Wednesday (UTC). A "week 1 Monday" session generated
      // on this day used to silently slide forward to the following Monday.
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Mid-week marathon block',
        durationWeeks: 1,
        startDate: '2026-04-22',
        endDate: '2026-04-29',
        now: new Date('2026-04-22T08:00:00.000Z'),
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
                { dayOfWeek: 'Monday', sessionType: 'run', title: 'Easy Run', durationMinutes: 50 },
                { dayOfWeek: 'Tuesday', sessionType: 'gym', title: 'Lift A', durationMinutes: 45 },
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Wed Run', durationMinutes: 40 },
                { dayOfWeek: 'Friday', sessionType: 'run', title: 'Fri Run', durationMinutes: 45 },
                { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 90 },
              ],
            },
          ],
        },
      });

      // 5 sessions persisted total; 2 unscheduled (Mon, Tue), 3 active.
      expect(result.totalSessions).toBe(3);
      expect(result.eventsCreated).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledTimes(5);

      // Mon — past day, unscheduled, reason mentions Monday + Wednesday.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Easy Run',
        status: 'unscheduled',
        preferred_time_unavailable: true,
        description: expect.stringMatching(/Monday[\s\S]*has already passed[\s\S]*Wednesday/),
      }));
      // Tue — past day, unscheduled, reason mentions Tuesday + Wednesday.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Lift A',
        status: 'unscheduled',
        description: expect.stringMatching(/Tuesday[\s\S]*has already passed[\s\S]*Wednesday/),
      }));
      // Wed — today, scheduled.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Wed Run',
        status: 'scheduled',
      }));
      // Fri/Sat — forward-looking, scheduled.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Fri Run',
        status: 'scheduled',
      }));
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Long Run',
        status: 'scheduled',
      }));

      // Calendar events created ONLY for the 3 forward-looking sessions.
      expect(mockCreateEvent).toHaveBeenCalledTimes(3);

      // No-available-slot warning telemetry emitted for both past-day rejects.
      const pastDayWarnings = mockLoggerWarn.mock.calls.filter(call =>
        String(call[1] || '').includes('no calendar slot was available'),
      );
      expect(pastDayWarnings.length).toBe(2);
    });

    it('keeps week 1 sessions on a Sunday-generated plan (no past-day rejects)', async () => {
      // 2026-04-19 is a Sunday — every weekday and Saturday/Sunday of week 1
      // are still in the future, so no past-day floor should fire.
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Sunday-start week',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
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
                { dayOfWeek: 'Monday', sessionType: 'run', title: 'Mon Run', durationMinutes: 40 },
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Wed Run', durationMinutes: 40 },
                { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Sat Long', durationMinutes: 80 },
              ],
            },
          ],
        },
      });

      expect(result.totalSessions).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledTimes(3);
      // None of these should be `unscheduled` — all forward-looking.
      const calls = mockCreateSession.mock.calls.map(call => (call[0] as any).status);
      expect(calls).toEqual(['scheduled', 'scheduled', 'scheduled']);
    });

    it('does not schedule a same-day session earlier than the plan creation time', async () => {
      const now = new Date(2026, 3, 22, 15, 15, 0, 0); // Wednesday 15:15 local
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Same-day floor',
        durationWeeks: 1,
        startDate: '2026-04-22',
        endDate: '2026-04-29',
        now,
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
                {
                  dayOfWeek: 'Wednesday',
                  sessionType: 'run',
                  title: 'Today Run',
                  durationMinutes: 40,
                },
              ],
            },
          ],
        },
      });

      expect(result.eventsCreated).toBe(1);
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Today Run',
        status: 'scheduled',
        preferred_time_unavailable: true,
      }));
      const eventStart = new Date(mockCreateEvent.mock.calls[0]?.[0]?.start);
      expect(eventStart.getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect(eventStart.getHours()).toBe(15);
      expect(eventStart.getMinutes()).toBe(30);
    });

    it('plan-linter strict preflight: catches equipment blockers without writing plan rows', () => {
      const lint = lintGeneratedTrainingPlanPreflight({
        userId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        equipmentProfile: 'bodyweight',
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'gym',
                  title: 'Lift A',
                  durationMinutes: 45,
                  exercises: [{ name: 'Barbell Back Squat' }],
                },
              ],
            },
          ],
        },
      });

      expect(lint.status).toBe('fail');
      expect(lint.blockers[0]?.ruleId).toBe('equipment_compatibility');
      expect(mockCreatePlan).not.toHaveBeenCalled();
      expect(mockCreateWeek).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.preflight_blocker_present',
          mode: 'strict_preflight',
          status: 'fail',
        }),
        'plan-linter: blocker(s) present before persistence; route must block writes',
      );
    });

    it('plan-linter advisor: surfaces equipment-incompatibility on bodyweight profile + barbell session', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        equipmentProfile: 'bodyweight',
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'gym',
                  title: 'Lift A',
                  durationMinutes: 45,
                  exercises: [
                    { name: 'Barbell Back Squat' }, // equipment violation
                  ],
                },
              ],
            },
          ],
        },
      });

      expect(result.lint.status).toBe('fail');
      expect(result.lint.blockers).toHaveLength(1);
      expect(result.lint.blockers[0]?.ruleId).toBe('equipment_compatibility');
      // Even with a blocker the plan still persisted (advisor mode).
      expect(result.totalSessions).toBe(1);
      // TR-EC-O13 (closed-beta-auth-hardening, 2026-05-04): the
      // dedicated `plan_linter.blocker_present` event fires for any
      // lint with `status === 'fail'`, separating fail-blockers from
      // non-blocking findings so operators can dashboard the rate.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.blocker_present',
          mode: 'advisor',
          status: 'fail',
        }),
        'plan-linter: blocker(s) present (advisor mode; surfaced on response)',
      );
    });

    it('plan-linter advisor: uses persisted dates to catch heavy lower before next-week long run', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Week-boundary long-run protection',
        durationWeeks: 2,
        startDate: '2026-04-19',
        endDate: '2026-05-03',
        now: new Date('2026-04-19T08:00:00.000Z'),
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
                {
                  dayOfWeek: 'Wednesday',
                  sessionType: 'run',
                  title: 'Bridge Run',
                  durationMinutes: 40,
                },
              ],
            },
            {
              weekNumber: 2,
              sessions: [
                {
                  dayOfWeek: 'Sunday',
                  sessionType: 'gym',
                  title: 'Lower Body Strength',
                  durationMinutes: 45,
                  exercises: [{ name: 'Barbell Back Squat' }],
                },
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'long_run',
                  title: 'Long Run',
                  durationMinutes: 90,
                },
              ],
            },
          ],
        },
      });

      expect(result.eventsCreated).toBe(3);
      expect(result.lint.status).toBe('fail');
      expect(result.lint.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no_heavy_lower_before_long_run',
            affectedSessions: [
              expect.objectContaining({
                weekNumber: 2,
                dayOfWeek: 'sunday',
                title: 'Lower Body Strength',
              }),
            ],
          }),
        ]),
      );
    });

    it('plan-linter advisor: warns on race-week label without race date', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Plan with stale taper label',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        // raceDate intentionally absent.
        planData: {
          weeks: [
            {
              weekNumber: 1,
              focus: 'race week',
              sessions: [
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Easy Run', durationMinutes: 30 },
              ],
            },
          ],
        },
      });

      expect(result.lint.status).toBe('pass_with_warnings');
      expect(result.lint.warnings.some((w) => w.ruleId === 'no_fake_taper_without_event')).toBe(true);
    });

    it('does NOT apply the past-day floor to week 2+ (rolling 7-day envelope is correct)', async () => {
      // Plan generated Wed 2026-04-22; the same Mon target in week 2 should
      // schedule successfully (5 days from Wed = next Mon, which is the
      // legitimate week-2 Monday).
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        objective: 'Week 2 still gets Monday',
        durationWeeks: 2,
        startDate: '2026-04-22',
        endDate: '2026-05-06',
        now: new Date('2026-04-22T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            { weekNumber: 1, sessions: [
              { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'W1 Wed', durationMinutes: 40 },
            ] },
            { weekNumber: 2, sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'W2 Mon', durationMinutes: 50 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'W2 Wed', durationMinutes: 45 },
            ] },
          ],
        },
      });

      // Week 1 Wed is today → scheduled.
      // Week 2 Mon is 5 days from now → scheduled (NOT unscheduled).
      // Week 2 Wed is 7 days from now → scheduled.
      expect(result.totalSessions).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'W2 Mon',
        status: 'scheduled',
      }));
    });
  });
});
