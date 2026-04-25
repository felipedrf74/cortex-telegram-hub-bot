import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  getActivePlan: vi.fn(),
  getPlanById: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  deletePlanHard: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: mocks.getActivePlan,
  getPlanById: mocks.getPlanById,
  getWeeksForPlan: mocks.getWeeksForPlan,
  getSessionsForWeek: mocks.getSessionsForWeek,
  deletePlanHard: mocks.deletePlanHard,
}));

import { cancelTrainingPlanForUser } from '../../src/api/routes/training-plan-cancellation';

describe('training-plan-cancellation (hard delete)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteEvent.mockResolvedValue({ ok: true });
    mocks.getActivePlan.mockReturnValue(null);
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
  });
});
