import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  getEvents: vi.fn(),
  getActivePlan: vi.fn(),
  getActivePlans: vi.fn(),
  getPlanById: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  deletePlanHard: vi.fn(),
  clearStoredPlansForAthlete: vi.fn(),
  deleteReportsByType: vi.fn(),
  clearLastCoachState: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
  getEvents: mocks.getEvents,
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: mocks.getActivePlan,
  getActivePlans: mocks.getActivePlans,
  getPlanById: mocks.getPlanById,
  getWeeksForPlan: mocks.getWeeksForPlan,
  getSessionsForWeek: mocks.getSessionsForWeek,
  deletePlanHard: mocks.deletePlanHard,
}));

vi.mock('../../src/services/coach-plan-registry', () => ({
  clearStoredPlansForAthlete: mocks.clearStoredPlansForAthlete,
}));

vi.mock('../../src/services/report-document-store', () => ({
  deleteReportsByType: mocks.deleteReportsByType,
}));

vi.mock('../../src/domains/domain-handler', () => ({
  clearLastCoachState: mocks.clearLastCoachState,
}));

import { cancelTrainingPlanForUser } from '../../src/api/routes/training-plan-cancellation';

describe('training-plan-cancellation (hard delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteEvent.mockResolvedValue({ ok: true });
    mocks.getEvents.mockResolvedValue([]);
    mocks.getActivePlan.mockReturnValue(null);
    mocks.getActivePlans.mockReturnValue([]);
    mocks.getPlanById.mockReturnValue(null);
    mocks.getWeeksForPlan.mockReturnValue([]);
    mocks.getSessionsForWeek.mockReturnValue([]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 0,
      removedSessions: 0,
      removedCompletions: 0,
    });
    mocks.clearStoredPlansForAthlete.mockReturnValue(0);
    mocks.deleteReportsByType.mockReturnValue(0);
    mocks.clearLastCoachState.mockReset();
  });

  it('deletes calendar events then hard-deletes the plan, returning row counts', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 44, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 7001 }, { id: 7002 }]);
    mocks.getSessionsForWeek
      .mockReturnValueOnce([
        { id: 321, status: 'completed', calendar_event_id: 'evt-completed', calendar_source: 'outlook' },
      ])
      .mockReturnValueOnce([
        { id: 322, status: 'planned', calendar_event_id: 'evt-planned', calendar_source: 'google' },
        { id: 323, status: 'pending', calendar_event_id: null, calendar_source: null },
      ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 2,
      removedSessions: 3,
      removedCompletions: 1,
    });

    const result = await cancelTrainingPlanForUser(12);

    expect(result).toEqual({
      status: 'cancelled',
      data: {
        cancelled: true,
        planId: 44,
        removedEvents: 2,
        removedSessions: 3,
        removedWeeks: 2,
        removedCompletions: 1,
        removedPlans: 1,
        totalSessions: 3,
        message: 'Plan cancelled. 2 scheduled workouts removed from the calendar; 3 sessions cleared from the plan.',
      },
    });
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-completed', 'outlook', 12);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-planned', 'google', 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(44, 12);
    // After hard-delete, every per-user coach narrative store must
    // be wiped so iOS Training Home doesn't keep rendering the
    // cancelled plan's day strip / coach card / week-protection
    // narrative from durable reports + in-memory caches.
    expect(mocks.deleteReportsByType).toHaveBeenCalledWith(12, ['coach_briefing', 'coach_phase']);
    expect(mocks.clearStoredPlansForAthlete).toHaveBeenCalledWith(12);
    expect(mocks.clearLastCoachState).toHaveBeenCalledWith(12);
  });

  it('deletes matching orphan generated calendar events before hard-delete', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 47,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8201, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 621,
        day_of_week: 'Monday',
        session_type: 'run',
        title: 'Recovery Run',
        duration_minutes: 30,
        status: 'pending',
        calendar_event_id: null,
        calendar_source: null,
      },
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'orphan-a',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
      {
        id: 'orphan-b',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T08:00:00.000Z',
        end: '2026-04-20T08:30:00.000Z',
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(2);
      expect(result.data.removedSessions).toBe(1);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('orphan-a', 'google', 12);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('orphan-b', 'google', 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(47, 12);
  });

  it('cancels every active plan when no specific plan id is provided', async () => {
    mocks.getActivePlans.mockReturnValue([
      { id: 70, user_id: 12, start_date: '2026-04-20T00:00:00.000Z' },
      { id: 71, user_id: 12, start_date: '2026-04-20T00:00:00.000Z' },
    ]);
    mocks.getWeeksForPlan
      .mockReturnValueOnce([{ id: 9001, week_number: 1 }])
      .mockReturnValueOnce([{ id: 9002, week_number: 1 }]);
    mocks.getSessionsForWeek
      .mockReturnValueOnce([
        { id: 701, day_of_week: 'Monday', session_type: 'gym', title: 'Lift', duration_minutes: 45, status: 'pending', calendar_event_id: 'evt-lift', calendar_source: 'google' },
      ])
      .mockReturnValueOnce([
        { id: 711, day_of_week: 'Tuesday', session_type: 'run', title: 'Run', duration_minutes: 30, status: 'pending', calendar_event_id: null, calendar_source: null },
      ]);
    mocks.deletePlanHard
      .mockReturnValueOnce({
        ok: true,
        removedPlans: 1,
        removedWeeks: 1,
        removedSessions: 1,
        removedCompletions: 0,
      })
      .mockReturnValueOnce({
        ok: true,
        removedPlans: 1,
        removedWeeks: 1,
        removedSessions: 1,
        removedCompletions: 0,
      });

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.planId).toBe(70);
      expect(result.data.planIds).toEqual([70, 71]);
      expect(result.data.removedPlans).toBe(2);
      expect(result.data.removedSessions).toBe(2);
    }
    expect(mocks.getActivePlan).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(70, 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(71, 12);
  });

  it('uses requested plan id when provided and rejects cross-user cancellation', async () => {
    mocks.getPlanById.mockReturnValue({ id: 99, user_id: 88 });

    const result = await cancelTrainingPlanForUser(12, 99);

    expect(result).toEqual({ status: 'forbidden' });
    expect(mocks.getPlanById).toHaveBeenCalledWith(99);
    expect(mocks.getActivePlan).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).not.toHaveBeenCalled();
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it('returns a stable no-op when there is no active plan', async () => {
    const result = await cancelTrainingPlanForUser(12);

    expect(result).toEqual({
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents: 0,
        removedSessions: 0,
        removedWeeks: 0,
        removedCompletions: 0,
        removedPlans: 0,
        totalSessions: 0,
        message: 'No active training plan to cancel.',
      },
    });
    expect(mocks.deletePlanHard).not.toHaveBeenCalled();
  });

  it('proceeds with the local hard delete when one calendar deletion fails', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 45, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8001 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 421, status: 'pending', calendar_event_id: 'evt-ok', calendar_source: 'outlook' },
      { id: 422, status: 'pending', calendar_event_id: 'evt-fail', calendar_source: 'google' },
    ]);
    mocks.deleteEvent
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('calendar unavailable'));
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 2,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.removedSessions).toBe(2);
      expect(result.data.message).toBe('Plan cancelled. 1 scheduled workout removed from the calendar; 2 sessions cleared from the plan.');
    }
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(45, 12);
  });

  it('does not call calendar deletion for an invalid stored provider source but still hard-deletes', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 46, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8101 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 521, status: 'pending', calendar_event_id: 'evt-icloud', calendar_source: 'icloud' },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(0);
      expect(result.data.totalSessions).toBe(1);
    }
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(46, 12);
  });

  it('idempotently reports not_found if the hard delete affects zero rows', async () => {
    // Race: another concurrent cancel removed the plan between lookup and delete.
    mocks.getActivePlan.mockReturnValue({ id: 50, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([]);
    mocks.getSessionsForWeek.mockReturnValue([]);
    mocks.deletePlanHard.mockReturnValue({
      ok: false,
      removedPlans: 0,
      removedWeeks: 0,
      removedSessions: 0,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('not_found');
    if (result.status === 'not_found') {
      expect(result.data.cancelled).toBe(false);
      expect(result.data.removedEvents).toBe(0);
    }
    // Don't wipe coach narrative state when the hard-delete didn't
    // actually remove a plan — another concurrent cancel got there
    // first, and clearing again would punish whoever just won.
    expect(mocks.deleteReportsByType).not.toHaveBeenCalled();
    expect(mocks.clearStoredPlansForAthlete).not.toHaveBeenCalled();
    expect(mocks.clearLastCoachState).not.toHaveBeenCalled();
  });
});
