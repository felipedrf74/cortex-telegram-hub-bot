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
  // Slice 4.D — the lifecycle module hits the real DB; mocked for
  // this route-level unit test. The lifecycle module's own logic is
  // exercised by training-plan-lifecycle.test.ts.
  findOwnershipsForPlan: vi.fn(),
  markCalendarOwnershipDeleted: vi.fn(),
  getTrainingCalendarEventOwners: vi.fn(),
  cancelTrainingPlanCrossSkillDependents: vi.fn(),
  // 2026-05-25 Bug #1 fix — buildCalendarDeletionTargetsForPlan now
  // also reads Secretary-owned events from secretary_agenda_items.
  // Test default: no extra events. Specific tests can override.
  findSecretaryAgendaCalendarEventsForPlan: vi.fn(() => []),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  deleteEvent: mocks.deleteEvent,
  getEvents: mocks.getEvents,
  getEventsForSources: mocks.getEvents,
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

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findOwnershipsForPlan: mocks.findOwnershipsForPlan,
  markCalendarOwnershipDeleted: mocks.markCalendarOwnershipDeleted,
}));

vi.mock('../../src/services/training-calendar-scope', () => ({
  getTrainingCalendarEventOwners: mocks.getTrainingCalendarEventOwners,
}));

vi.mock('../../src/services/training-plan-cancellation-cascade', () => ({
  cancelTrainingPlanCrossSkillDependents: mocks.cancelTrainingPlanCrossSkillDependents,
  findSecretaryAgendaCalendarEventsForPlan: mocks.findSecretaryAgendaCalendarEventsForPlan,
}));

import { cancelTrainingPlanForUser } from '../../src/api/routes/training-plan-cancellation';
import {
  appendTrainingIdentityMarker,
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
} from '../../src/services/training-session-identity';

function markerDescription(planId: number, planVersion: number, sessionId: number, session: {
  day_of_week: string;
  session_type: string;
  title: string;
  duration_minutes: number;
}, ordinal = 1): string {
  const sessionIdentityKey = buildTrainingSessionIdentityKey({
    planId,
    weekNumber: 1,
    dayOfWeek: session.day_of_week,
    sessionType: session.session_type,
    ordinal,
  });
  const sessionShapeHash = computeTrainingSessionShapeHash({
    sessionType: session.session_type,
    title: session.title,
    durationMinutes: session.duration_minutes,
  });
  return appendTrainingIdentityMarker('Training session', {
    planId,
    planVersion,
    sessionId,
    sessionIdentityKey,
    sessionShapeHash,
  });
}

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
    mocks.findOwnershipsForPlan.mockReturnValue([]);
    mocks.getTrainingCalendarEventOwners.mockReturnValue([]);
    mocks.cancelTrainingPlanCrossSkillDependents.mockReturnValue({
      canceledAgendaItems: 0,
      staleMemories: 0,
      signalId: null,
    });
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

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

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
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(44, 12, 12);
    expect(mocks.cancelTrainingPlanCrossSkillDependents).toHaveBeenCalledWith({
      userId: 12,
      tenantId: 12,
      planId: 44,
      planVersion: 1,
      sessionIds: [321, 322, 323],
      deletedCalendarEvents: [
        { eventId: 'evt-completed', source: 'outlook' },
        { eventId: 'evt-planned', source: 'google' },
      ],
      reason: 'training_plan_canceled',
    });
    expect(mocks.deletePlanHard.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.cancelTrainingPlanCrossSkillDependents.mock.invocationCallOrder[0]);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-completed',
      source: 'outlook',
      reason: 'plan_cancelled',
      status: 'deleted',
      userId: 12,
      tenantId: 12,
      planId: 44,
    });
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-planned',
      source: 'google',
      reason: 'plan_cancelled',
      status: 'deleted',
      userId: 12,
      tenantId: 12,
      planId: 44,
    });
    // After hard-delete, every per-user coach narrative store must
    // be wiped so iOS Training Home doesn't keep rendering the
    // cancelled plan's day strip / coach card / week-protection
    // narrative from durable reports + in-memory caches.
    expect(mocks.deleteReportsByType).toHaveBeenCalledWith(12, ['coach_briefing', 'coach_phase']);
    expect(mocks.clearStoredPlansForAthlete).toHaveBeenCalledWith(12);
    expect(mocks.clearLastCoachState).toHaveBeenCalledWith(12);
  });

  it('deletes matching orphan generated calendar events before hard-delete', async () => {
    const session = {
      id: 621,
      day_of_week: 'Monday',
      session_type: 'run',
      title: 'Recovery Run',
      duration_minutes: 30,
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    mocks.getActivePlan.mockReturnValue({
      id: 47,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8201, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      session,
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'orphan-a',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
        description: markerDescription(47, 1, 621, session),
      },
      {
        id: 'orphan-b',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T08:00:00.000Z',
        end: '2026-04-20T08:30:00.000Z',
        description: markerDescription(47, 1, 621, session),
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(2);
      expect(result.data.removedSessions).toBe(1);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('orphan-a', 'google', 12);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('orphan-b', 'google', 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(47, 12, 12);
  });

  it('deletes ownership-table events even when session calendar links are missing and calendar lookup fails', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 72,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 7201, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 720,
        day_of_week: 'Monday',
        session_type: 'gym',
        title: 'Lift',
        duration_minutes: 45,
        status: 'pending',
        calendar_event_id: null,
        calendar_source: null,
      },
    ]);
    mocks.findOwnershipsForPlan.mockReturnValue([
      {
        id: 9001,
        plan_id: 72,
        plan_version: 1,
        session_id: 720,
        user_id: 12,
        calendar_event_id: 'owned-but-unlinked',
        calendar_source: 'google',
        status: 'active',
        created_at: '2026-04-20T00:00:00Z',
        deleted_at: null,
        delete_reason: null,
      },
    ]);
    mocks.getEvents.mockRejectedValueOnce(new Error('calendar read unavailable'));
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('owned-but-unlinked', 'google', 12);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'owned-but-unlinked',
      source: 'google',
      reason: 'plan_cancelled',
      status: 'deleted',
      userId: 12,
      tenantId: 12,
      planId: 72,
    });
  });

  it('threads explicit tenant scope through ownership and hard delete', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 45, user_id: 12, tenant_id: 34 });
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 0,
      removedSessions: 0,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 34 });

    expect(result.status).toBe('cancelled');
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(45, 12, 34);
    expect(mocks.cancelTrainingPlanCrossSkillDependents).toHaveBeenCalledWith(expect.objectContaining({
      userId: 12,
      tenantId: 34,
      planId: 45,
    }));
  });

  it('routes requested plans from another tenant through the same no-op path', async () => {
    mocks.getPlanById.mockReturnValue({ id: 46, user_id: 12, tenant_id: 99 });

    const result = await cancelTrainingPlanForUser(12, 46, { tenantId: 34 });

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

  it('does not delete a title-matched calendar event owned by another active training plan', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 73,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 7301, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 731,
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
        id: 'other-plan-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
    ]);
    mocks.getTrainingCalendarEventOwners.mockReturnValue([
      {
        eventId: 'other-plan-run',
        source: 'google',
        sessionId: 999,
        planId: 999,
        userId: 12,
        planStatus: 'active',
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(0);
    }
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(73, 12, 12);
  });

  it('does not delete unowned title/date matches without a Nexus identity marker', async () => {
    mocks.getActivePlan.mockReturnValue({
      id: 74,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 7401, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      {
        id: 741,
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
        id: 'legacy-title-only-run',
        source: 'google',
        summary: '🏃 Recovery Run (30min)',
        start: '2026-04-20T07:00:00.000Z',
        end: '2026-04-20T07:30:00.000Z',
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(0);
    }
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it('deletes orphan generated events when titles drift but Nexus identity marker still identifies the plan', async () => {
    const session = {
      id: 631,
      day_of_week: 'Wednesday',
      session_type: 'gym',
      title: 'Upper Body Strength A',
      duration_minutes: 48,
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    mocks.getActivePlan.mockReturnValue({
      id: 48,
      user_id: 12,
      start_date: '2026-04-20T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8301, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      session,
    ]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'orphan-rich',
        source: 'google',
        summary: 'Strength Session',
        start: '2026-04-22T12:00:00.000Z',
        end: '2026-04-22T12:48:00.000Z',
        description: markerDescription(48, 1, 631, session),
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    expect(mocks.deleteEvent).toHaveBeenCalledWith('orphan-rich', 'google', 12);
  });

  it('deletes duplicate events identified only by Secretary training source markers', async () => {
    const session = {
      id: 970,
      day_of_week: 'Tuesday',
      session_type: 'gym',
      title: 'Runner Upper Body Strength A',
      duration_minutes: 48,
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    mocks.getActivePlan.mockReturnValue({
      id: 39,
      user_id: 12,
      start_date: '2026-05-25T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 3901, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.getEvents.mockResolvedValue([
      {
        id: 'secretary-training-duplicate',
        source: 'google',
        summary: 'Runner Upper Body Strength A',
        start: '2026-05-26T12:00:00.000Z',
        end: '2026-05-26T12:48:00.000Z',
        description: [
          'NEXUS_SECRETARY_AGENDA_ITEM:sec_agenda_e2844d0705b15920ff14ee2d',
          'NEXUS_SECRETARY_SOURCE_INTENT:training:39:1:970',
          'NEXUS_SECRETARY_SOURCE_SKILL:training',
          'NEXUS_SECRETARY_SOURCE_ENTITY:training_session:970',
          'NEXUS_SECRETARY_VERSION:1',
        ].join('\n'),
      },
    ]);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('secretary-training-duplicate', 'google', 12);
  });

  it('deletes matching generated training events from both Google and Outlook with provider-specific ids', async () => {
    const session = {
      id: 976,
      day_of_week: 'Tuesday',
      session_type: 'gym',
      title: 'Runner Upper Body Strength A',
      duration_minutes: 48,
      status: 'pending',
      calendar_event_id: null,
      calendar_source: null,
    };
    mocks.getActivePlan.mockReturnValue({
      id: 39,
      user_id: 12,
      start_date: '2026-05-25T00:00:00.000Z',
    });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 3901, week_number: 1 }]);
    mocks.getSessionsForWeek.mockReturnValue([session]);
    mocks.getEvents.mockImplementation(async (_start: string, _end: string, _userId: number, sources: string[]) => {
      if (sources.includes('google')) {
        return [{
          id: 'google-training-duplicate',
          source: 'google',
          summary: '💪 Runner Upper Body Strength A (48min)',
          start: '2026-05-26T12:00:00.000Z',
          end: '2026-05-26T12:48:00.000Z',
          description: markerDescription(39, 1, 976, session),
        }];
      }
      if (sources.includes('outlook')) {
        return [{
          id: 'outlook-training-duplicate',
          source: 'outlook',
          summary: '💪 Runner Upper Body Strength A (48min)',
          start: '2026-05-26T12:00:00.000Z',
          end: '2026-05-26T12:48:00.000Z',
          description: markerDescription(39, 1, 976, session),
        }];
      }
      return [];
    });
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(2);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('google-training-duplicate', 'google', 12);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('outlook-training-duplicate', 'outlook', 12);
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

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.planId).toBe(70);
      expect(result.data.planIds).toEqual([70, 71]);
      expect(result.data.removedPlans).toBe(2);
      expect(result.data.removedSessions).toBe(2);
    }
    expect(mocks.getActivePlan).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(70, 12, 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(71, 12, 12);
  });

  it('routes foreign requested plan ids through the same no-op path as missing ids', async () => {
    mocks.getPlanById.mockReturnValue({ id: 99, user_id: 88 });

    const foreign = await cancelTrainingPlanForUser(12, 99, { tenantId: 12 });
    vi.clearAllMocks();
    mocks.deleteEvent.mockResolvedValue({ ok: true });
    mocks.getEvents.mockResolvedValue([]);
    mocks.getActivePlan.mockReturnValue(null);
    mocks.getActivePlans.mockReturnValue([]);
    mocks.getPlanById.mockReturnValue(null);
    mocks.getWeeksForPlan.mockReturnValue([]);
    mocks.getSessionsForWeek.mockReturnValue([]);
    mocks.findOwnershipsForPlan.mockReturnValue([]);
    mocks.getTrainingCalendarEventOwners.mockReturnValue([]);
    mocks.findSecretaryAgendaCalendarEventsForPlan.mockReturnValue([]);

    const missing = await cancelTrainingPlanForUser(12, 9999, { tenantId: 12 });

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
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
    expect(mocks.getActivePlan).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).not.toHaveBeenCalled();
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it('returns a stable no-op when there is no active plan', async () => {
    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

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

  it('cleans Nexus-marked orphan calendar events even when no active plan remains', async () => {
    mocks.getEvents.mockImplementation(async (_start: string, _end: string, _userId: number, sources: string[]) => {
      if (!sources.includes('google')) return [];
      return [{
        id: 'post-cancel-orphan',
        source: 'google',
        summary: '💪 Strength + Core Support (40min)',
        start: '2026-05-26T07:00:00.000Z',
        end: '2026-05-26T07:40:00.000Z',
        description: appendTrainingIdentityMarker('Training session', {
          planId: 88,
          planVersion: 1,
          sessionId: 8801,
          sessionIdentityKey: 'plan:88|week:1|day:tuesday|type:gym|slot:1',
          sessionShapeHash: 'shape-post-cancel',
        }),
      }];
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('not_found');
    if (result.status === 'not_found') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.message).toContain('1 scheduled workout removed');
    }
    expect(mocks.deleteEvent).toHaveBeenCalledWith('post-cancel-orphan', 'google', 12);
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

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.removedSessions).toBe(2);
      expect(result.data.message).toBe('Plan cancelled. 1 scheduled workout removed from the calendar; 2 sessions cleared from the plan.');
    }
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(45, 12, 12);
  });

  it('retries provider rate limits before marking plan-owned events orphaned', async () => {
    mocks.getActivePlan.mockReturnValue({ id: 146, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8201 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1521, status: 'pending', calendar_event_id: 'evt-rate-limited', calendar_source: 'google' },
    ]);
    mocks.deleteEvent
      .mockRejectedValueOnce(Object.assign(new Error('Rate Limit Exceeded'), {
        status: 403,
        code: 403,
        reason: 'userRateLimitExceeded',
        errors: [{ reason: 'userRateLimitExceeded', message: 'Rate Limit Exceeded' }],
      }))
      .mockResolvedValueOnce({ ok: true });
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.message).toBe('Plan cancelled. 1 scheduled workout removed from the calendar; 1 session cleared from the plan.');
    }
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(2);
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-rate-limited',
      source: 'google',
      reason: 'plan_cancelled',
      status: 'deleted',
      userId: 12,
      tenantId: 12,
      planId: 146,
    });
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(146, 12, 12);
  });

  it('serializes large provider deletion batches to avoid calendar rate-limit storms', async () => {
    const sessions = Array.from({ length: 21 }, (_, idx) => ({
      id: 9_000 + idx,
      status: 'pending',
      calendar_event_id: `evt-large-${idx}`,
      calendar_source: 'google',
    }));
    let activeDeletes = 0;
    let maxActiveDeletes = 0;

    mocks.getActivePlan.mockReturnValue({ id: 147, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8301 }]);
    mocks.getSessionsForWeek.mockReturnValue(sessions);
    mocks.deleteEvent.mockImplementation(async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await Promise.resolve();
      activeDeletes -= 1;
      return { ok: true };
    });
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: sessions.length,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(21);
      expect(result.data.removedSessions).toBe(21);
    }
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(21);
    expect(maxActiveDeletes).toBe(1);
  });

  it.each([
    ['status 404', { status: 404, message: 'Not Found' }],
    ['status 410', { status: 410, message: 'Gone' }],
    ['provider code', { code: 'event_not_found' }],
    ['message only', new Error('Event not found')],
  ])('treats provider %s during cancellation as already deleted upstream', async (_label, providerError) => {
    mocks.getActivePlan.mockReturnValue({ id: 145, user_id: 12 });
    mocks.getWeeksForPlan.mockReturnValue([{ id: 8101 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 1421, status: 'pending', calendar_event_id: 'evt-gone', calendar_source: 'google' },
    ]);
    mocks.deleteEvent.mockRejectedValueOnce(providerError);
    mocks.deletePlanHard.mockReturnValue({
      ok: true,
      removedPlans: 1,
      removedWeeks: 1,
      removedSessions: 1,
      removedCompletions: 0,
    });

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(1);
      expect(result.data.message).toBe('Plan cancelled. 1 scheduled workout removed from the calendar; 1 session cleared from the plan.');
    }
    expect(mocks.markCalendarOwnershipDeleted).toHaveBeenCalledWith({
      eventId: 'evt-gone',
      source: 'google',
      reason: 'plan_cancelled',
      status: 'deleted',
      userId: 12,
      tenantId: 12,
      planId: 145,
    });
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

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

    expect(result.status).toBe('cancelled');
    if (result.status === 'cancelled') {
      expect(result.data.removedEvents).toBe(0);
      expect(result.data.totalSessions).toBe(1);
    }
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
    expect(mocks.deletePlanHard).toHaveBeenCalledWith(46, 12, 12);
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

    const result = await cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });

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

  it('serializes concurrent cancellation so provider events are not deleted twice', async () => {
    let planDeleted = false;
    let resolveDeleteEvent!: (value: { ok: true }) => void;
    const firstDeleteEvent = new Promise<{ ok: true }>((resolve) => {
      resolveDeleteEvent = resolve;
    });

    mocks.getActivePlan.mockImplementation(() => (planDeleted ? null : { id: 51, user_id: 12 }));
    mocks.getWeeksForPlan.mockReturnValue([{ id: 5101 }]);
    mocks.getSessionsForWeek.mockReturnValue([
      { id: 511, status: 'pending', calendar_event_id: 'evt-race', calendar_source: 'google' },
    ]);
    mocks.deleteEvent.mockReturnValueOnce(firstDeleteEvent);
    mocks.deletePlanHard.mockImplementation(() => {
      planDeleted = true;
      return {
        ok: true,
        removedPlans: 1,
        removedWeeks: 1,
        removedSessions: 1,
        removedCompletions: 0,
      };
    });

    const first = cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);

    const second = cancelTrainingPlanForUser(12, undefined, { tenantId: 12 });
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(mocks.getActivePlan).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);

    resolveDeleteEvent({ ok: true });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe('cancelled');
    expect(secondResult.status).toBe('not_found');
    expect(mocks.getActivePlan).toHaveBeenCalledTimes(2);
    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledWith('evt-race', 'google', 12);
    expect(mocks.deletePlanHard).toHaveBeenCalledTimes(1);
  });
});
