import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteEvent: vi.fn(),
  getActivePlan: vi.fn(),
  getPlanById: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  updateSession: vi.fn(),
  updatePlanStatus: vi.fn(),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: mocks.getActivePlan,
  getPlanById: mocks.getPlanById,
  getWeeksForPlan: mocks.getWeeksForPlan,
  getSessionsForWeek: mocks.getSessionsForWeek,
  updateSession: mocks.updateSession,
  updatePlanStatus: mocks.updatePlanStatus,
}));

import { cancelTrainingPlanForUser } from '../../src/api/routes/training-plan-cancellation';

describe('training-plan-cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteEvent.mockResolvedValue({ ok: true });
    mocks.getActivePlan.mockReturnValue(null);
    mocks.getPlanById.mockReturnValue(null);
    mocks.getWeeksForPlan.mockReturnValue([]);
    mocks.getSessionsForWeek.mockReturnValue([]);
  });

  it('cancels an active plan, clears session calendar links, and preserves completed sessions', async () => {
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

    const result = await cancelTrainingPlanForUser(12);

    expect(result).toEqual({
      status: 'cancelled',
      data: {
        cancelled: true,
        planId: 44,
        removedEvents: 2,
        totalSessions: 3,
        message: 'Plan cancelled. 2 scheduled workouts removed from the calendar.',
      },
    });
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-completed', 'outlook', 12);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-planned', 'google', 12);
    expect(mocks.updateSession).toHaveBeenCalledWith(321, {
      status: 'completed',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(mocks.updateSession).toHaveBeenCalledWith(322, {
      status: 'skipped',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(mocks.updateSession).toHaveBeenCalledWith(323, {
      status: 'skipped',
      calendar_event_id: null,
      calendar_source: null,
    });
    expect(mocks.updatePlanStatus).toHaveBeenCalledWith(44, 'cancelled');
  });

  it('uses requested plan id when provided and rejects cross-user cancellation', async () => {
    mocks.getPlanById.mockReturnValue({ id: 99, user_id: 88 });

    const result = await cancelTrainingPlanForUser(12, 99);

    expect(result).toEqual({ status: 'forbidden' });
    expect(mocks.getPlanById).toHaveBeenCalledWith(99);
    expect(mocks.getActivePlan).not.toHaveBeenCalled();
    expect(mocks.updatePlanStatus).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it('returns a stable no-op when there is no active plan', async () => {
    const result = await cancelTrainingPlanForUser(12);

    expect(result).toEqual({
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents: 0,
        message: 'No active training plan to cancel.',
      },
    });
    expect(mocks.updatePlanStatus).not.toHaveBeenCalled();
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('still cancels the plan when one linked calendar deletion fails', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 45, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8001 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 421, status: 'pending', calendar_event_id: 'evt-ok', calendar_source: 'outlook' },
      { id: 422, status: 'pending', calendar_event_id: 'evt-fail', calendar_source: 'google' },
    ]);
    mocks.deleteEvent
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('calendar unavailable'));

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.message).toBe('Plan cancelled. 1 scheduled workout removed from the calendar.');
    }
    expect(mocks.updatePlanStatus).toHaveBeenCalledWith(45, 'cancelled');
    expect(mocks.updateSession).toHaveBeenCalledTimes(2);
  });

  it('does not call calendar deletion for an invalid stored provider source', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 46, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8101 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 521, status: 'pending', calendar_event_id: 'evt-icloud', calendar_source: 'icloud' },
    ]);

    const result = await cancelTrainingPlanForUser(12);

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(0);
      expect(result.data.totalSessions).toBe(1);
    }
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith(521, {
      status: 'skipped',
      calendar_event_id: null,
      calendar_source: null,
    });
  });
});
