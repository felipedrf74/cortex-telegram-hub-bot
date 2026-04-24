// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { deleteEvent, type CalendarSource } from '../../services/unified-calendar';
import * as trainingPlans from '../../services/training-plans';

export interface TrainingPlanCancellationSuccess {
  cancelled: true;
  planId: number;
  removedEvents: number;
  totalSessions: number;
  message: string;
}

export interface TrainingPlanCancellationNoop {
  cancelled: false;
  removedEvents: 0;
  message: string;
}

export type TrainingPlanCancellationResult =
  | { status: 'cancelled'; data: TrainingPlanCancellationSuccess }
  | { status: 'not_found'; data: TrainingPlanCancellationNoop }
  | { status: 'forbidden' };

interface TrainingSessionForCancellation {
  id: number;
  status?: string | null;
  calendar_event_id?: string | null;
  calendar_source?: CalendarSource | string | null;
}

export async function cancelTrainingPlanForUser(
  userId: number,
  requestedPlanId?: unknown,
): Promise<TrainingPlanCancellationResult> {
  const parsedPlanId = Number(requestedPlanId);
  const plan = Number.isFinite(parsedPlanId) && parsedPlanId > 0
    ? trainingPlans.getPlanById(parsedPlanId)
    : trainingPlans.getActivePlan(userId);

  if (plan && plan.user_id !== userId) {
    return { status: 'forbidden' };
  }

  if (!plan) {
    return {
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents: 0,
        message: 'No active training plan to cancel.',
      },
    };
  }

  const weeks = trainingPlans.getWeeksForPlan(plan.id);
  const sessions = weeks.flatMap((week: { id: number }) =>
    trainingPlans.getSessionsForWeek(week.id) as TrainingSessionForCancellation[],
  );
  const deletableSessions = sessions.filter(hasLinkedCalendarEvent);

  const deletionResults = await Promise.allSettled(
    deletableSessions.map((session) =>
      deleteEvent(session.calendar_event_id, session.calendar_source, userId),
    ),
  );
  const removedEvents = deletionResults.filter(result => result.status === 'fulfilled').length;

  for (const session of sessions) {
    trainingPlans.updateSession(session.id, {
      status: session.status === 'completed' ? 'completed' : 'skipped',
      calendar_event_id: null,
      calendar_source: null,
    });
  }

  trainingPlans.updatePlanStatus(plan.id, 'cancelled');

  return {
    status: 'cancelled',
    data: {
      cancelled: true,
      planId: plan.id,
      removedEvents,
      totalSessions: sessions.length,
      message: `Plan cancelled. ${removedEvents} scheduled workout${removedEvents === 1 ? '' : 's'} removed from the calendar.`,
    },
  };
}

function hasLinkedCalendarEvent(
  session: TrainingSessionForCancellation,
): session is TrainingSessionForCancellation & { calendar_event_id: string; calendar_source: CalendarSource } {
  return Boolean(session.calendar_event_id && isCalendarSource(session.calendar_source));
}

function isCalendarSource(value: unknown): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}
