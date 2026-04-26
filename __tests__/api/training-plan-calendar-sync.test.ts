import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActivePlan: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  linkSessionToCalendar: vi.fn(),
  createEvent: vi.fn(),
  getEvents: vi.fn(),
  isConnected: vi.fn(),
  isTrainingCalendarEventUnclaimed: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: mocks.getActivePlan,
  getWeeksForPlan: mocks.getWeeksForPlan,
  getSessionsForWeek: mocks.getSessionsForWeek,
  linkSessionToCalendar: mocks.linkSessionToCalendar,
}));

vi.mock('../../src/services/unified-calendar', () => ({
  createEvent: mocks.createEvent,
  getEvents: mocks.getEvents,
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: mocks.isConnected,
}));

vi.mock('../../src/services/training-calendar-scope', () => ({
  isTrainingCalendarEventUnclaimed: mocks.isTrainingCalendarEventUnclaimed,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
  },
}));

import { syncTrainingPlanCalendar } from '../../src/api/routes/training-plan-calendar-sync';

describe('training-plan-calendar-sync', () => {
  // Pin "now" inside the plan window so future-day filtering is
  // deterministic. plan.start_date = 2026-04-20 (Monday), now = same day.
  const now = new Date('2026-04-20T05:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEvents.mockResolvedValue([]);
    mocks.linkSessionToCalendar.mockReturnValue(true);
    mocks.isConnected.mockImplementation((_userId: number, provider: string) => provider === 'google');
    mocks.isTrainingCalendarEventUnclaimed.mockReturnValue(true);
  });

  it('returns no_active_plan when the user has no plan', async () => {
    mocks.getActivePlan.mockReturnValue(null);

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('no_active_plan');
    expect(mocks.createEvent).not.toHaveBeenCalled();
  });

  it('creates calendar events for unsynced future sessions and links each one', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 7,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 70, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      // Monday today — should sync. Strength → 18:00.
      { id: 100, day_of_week: 'Monday', session_type: 'gym', title: 'Strength + Core', duration_minutes: 40, description: 'Lifting day.', status: 'pending', calendar_event_id: null },
      // Wednesday +2 — should sync. Run → 07:00.
      { id: 101, day_of_week: 'Wednesday', session_type: 'run', title: 'Tempo Run', duration_minutes: 35, description: 'Threshold.', status: 'pending', calendar_event_id: null },
      // Sunday → rest, skipped entirely.
      { id: 102, day_of_week: 'Sunday', session_type: 'rest', title: 'Rest', duration_minutes: 0, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockResolvedValueOnce({ id: 'evt-mon', source: 'google' })
      .mockResolvedValueOnce({ id: 'evt-wed', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(2);
      expect(result.data.sessionsAttempted).toBe(2);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('2 sessions added to your calendar.');
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.createEvent).toHaveBeenCalledWith(expect.any(Object), 'google', 42);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(100, 'evt-mon', 'google');
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(101, 'evt-wed', 'google');
    // Strength title prefix uses the dumbbell emoji + duration suffix.
    const monPayload = mocks.createEvent.mock.calls[0][0];
    expect(monPayload.title).toBe('💪 Strength + Core (40min)');
    // Run title uses the runner emoji.
    const wedPayload = mocks.createEvent.mock.calls[1][0];
    expect(wedPayload.title).toBe('🏃 Tempo Run (35min)');
  });

  it('retries Google rate-limit writes before reporting sync failure', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 17,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 170, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1700, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockRejectedValueOnce({
        response: {
          status: 403,
          data: {
            error: {
              code: 403,
              message: 'Rate Limit Exceeded',
              errors: [{ reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' }],
            },
          },
        },
      })
      .mockResolvedValueOnce({ id: 'evt-retry', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('1 session added to your calendar.');
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(2);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(1700, 'evt-retry', 'google');
  });

  it('keeps sessions with a verified calendar_event_id idempotent on retry', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 8,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 80, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 200, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: 'evt-existing', calendar_source: 'google' },
      { id: 201, day_of_week: 'Wednesday', session_type: 'run', title: 'Easy', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'evt-existing',
        source: 'google',
        summary: '💪 Lift (45min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:45:00.000Z',
      },
    ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-new', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAlreadySynced).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(201, 'evt-new', 'google');
  });

  it('repairs stale calendar_event_id links when the provider no longer returns the event', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 19,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 190, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 209, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: 'evt-stale', calendar_source: 'google' },
    ]);
    mocks.getEvents.mockResolvedValue([]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-repaired', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAlreadySynced).toBe(0);
      expect(result.data.sessionsAttempted).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(209, 'evt-repaired', 'google');
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 209, calendarEventId: 'evt-stale', reason: 'missing_linked_event' }),
      'syncTrainingPlanCalendar: repairing stale training calendar link',
    );
  });

  it('links matching orphan calendar events instead of creating duplicates', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 18,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: JSON.stringify({
        preferredTime: '12:00',
        preferredCardioTime: '07:00',
        preferredStrengthTime: '18:00',
      }),
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 180, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 208, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'orphan-recovery-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
    ]);

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsLinked).toBe(1);
      expect(result.data.sessionsFailed).toBe(0);
      expect(result.data.message).toBe('1 existing session was linked to your calendar.');
    }
    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(208, 'orphan-recovery-run', 'google');
  });

  it('does not claim a matching training event already linked to another plan', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 20,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 2000, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 210, day_of_week: 'Monday', session_type: 'run', title: 'Recovery Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'claimed-recovery-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T12:00:00.000Z',
        end: '2026-04-20T12:30:00.000Z',
      },
    ]);
    mocks.isTrainingCalendarEventUnclaimed.mockReturnValue(false);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-new-run', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsLinked).toBe(0);
    }
    expect(mocks.isTrainingCalendarEventUnclaimed).toHaveBeenCalledWith('claimed-recovery-run', 'google');
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(210, 'evt-new-run', 'google');
  });

  it('does not touch past, completed, or skipped sessions', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 9,
      user_id: 42,
      start_date: '2026-04-13T00:00:00.000Z', // started a week ago
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([
      { id: 90, week_number: 1 },
      { id: 91, week_number: 2 },
    ]);
    mocks.getSessionsForWeek
      .mockReturnValueOnce([
        // Week 1 (last week) — past date, must be skipped.
        { id: 300, day_of_week: 'Monday', session_type: 'gym', title: 'Past Lift', duration_minutes: 45, description: '', status: 'pending', calendar_event_id: null },
      ])
      .mockReturnValueOnce([
        // Week 2 — Wednesday is future. But this one is `completed`,
        // so we don't put a calendar event on a closed-out session.
        { id: 301, day_of_week: 'Wednesday', session_type: 'run', title: 'Done Run', duration_minutes: 30, description: '', status: 'completed', calendar_event_id: null },
        // Week 2 — Friday is future + still pending → should sync.
        { id: 302, day_of_week: 'Friday', session_type: 'run', title: 'Future Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
        // Week 2 — Saturday `skipped`, ignore.
        { id: 303, day_of_week: 'Saturday', session_type: 'gym', title: 'Skipped Lift', duration_minutes: 45, description: '', status: 'skipped', calendar_event_id: null },
      ]);
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt-fri', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsAttempted).toBe(1);
    }
    expect(mocks.linkSessionToCalendar).toHaveBeenCalledWith(302, 'evt-fri', 'google');
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(300, expect.anything(), expect.anything());
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(301, expect.anything(), expect.anything());
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalledWith(303, expect.anything(), expect.anything());
  });

  it('returns no_calendar when every createEvent throws "No calendar provider is connected"', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 10,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 100, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 400, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
      { id: 401, day_of_week: 'Wednesday', session_type: 'run', title: 'Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent.mockRejectedValue(new Error('No calendar provider is connected'));

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('no_calendar');
    if (result.status === 'no_calendar') {
      expect(result.data.eventsCreated).toBe(0);
      expect(result.data.sessionsAttempted).toBe(2);
      expect(result.data.message).toContain('Reconnect');
    }
    expect(mocks.linkSessionToCalendar).not.toHaveBeenCalled();
  });

  it('reports a partial-failure message when only some sessions sync', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 11,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 110, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 500, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
      { id: 501, day_of_week: 'Wednesday', session_type: 'run', title: 'Run', duration_minutes: 30, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.createEvent
      .mockResolvedValueOnce({ id: 'evt-mon', source: 'google' })
      .mockRejectedValueOnce(new Error('rate-limited'));

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
      expect(result.data.sessionsFailed).toBe(1);
      expect(result.data.message).toBe('1 of 2 sessions added to your calendar; 1 could not be created.');
    }
  });

  it('still tries to create events when getEvents (busy-window fetch) throws', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 12,
      user_id: 42,
      start_date: '2026-04-20T00:00:00.000Z',
      preferences_json: null,
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 120, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 600, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 40, description: '', status: 'pending', calendar_event_id: null },
    ]);
    mocks.getEvents.mockRejectedValue(new Error('calendar listing unavailable'));
    mocks.createEvent.mockResolvedValueOnce({ id: 'evt', source: 'google' });

    const result = await syncTrainingPlanCalendar(42, now);

    expect(result.status).toBe('synced');
    if (result.status === 'synced') {
      expect(result.data.eventsCreated).toBe(1);
    }
    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });
});
