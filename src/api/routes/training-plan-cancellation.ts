// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import { deleteEvent, type CalendarSource } from '../../services/unified-calendar';
import * as trainingPlans from '../../services/training-plans';
import { clearStoredPlansForAthlete } from '../../services/coach-plan-registry';
import { deleteReportsByType } from '../../services/report-document-store';
import { clearLastCoachState } from '../../domains/domain-handler';

/**
 * Successful plan-cancellation payload.
 *
 * The endpoint contract is "nothing left behind": all calendar events
 * are removed (best-effort across providers), then the plan + weeks +
 * sessions + completions rows are hard-deleted via FK CASCADE in one
 * transaction. The response counts let the iOS client and operators
 * audit exactly what was removed.
 */
export interface TrainingPlanCancellationSuccess {
  cancelled: true;
  planId: number;
  removedEvents: number;
  removedSessions: number;
  removedWeeks: number;
  removedCompletions: number;
  removedPlans: number;
  // Backwards-compatible alias for clients still reading the old field.
  totalSessions: number;
  message: string;
}

/**
 * "Nothing to cancel" payload. The counts are typed as numbers
 * (not literal `0`) so the late-stage race branch — where calendar
 * events were already deleted before the local hard-delete found
 * zero rows — can still report what it removed without fighting
 * the literal-zero type.
 */
export interface TrainingPlanCancellationNoop {
  cancelled: false;
  removedEvents: number;
  removedSessions: number;
  removedWeeks: number;
  removedCompletions: number;
  removedPlans: number;
  totalSessions: number;
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
        removedSessions: 0,
        removedWeeks: 0,
        removedCompletions: 0,
        removedPlans: 0,
        totalSessions: 0,
        message: 'No active training plan to cancel.',
      },
    };
  }

  // Step 1 — remove calendar events first, while the plan_id linkage is
  // still in the DB. We need the (event_id, source) tuple per session,
  // and once the plan rows are gone we can't recover those to retry.
  // External calendar deletes are best-effort: a transient Google/
  // Outlook 5xx must not block the local hard delete because that
  // would leave the plan orphaned with a tombstoned local copy and
  // the user unable to retry.
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

  if (removedEvents < deletableSessions.length) {
    logger.warn({
      userId,
      planId: plan.id,
      attempted: deletableSessions.length,
      succeeded: removedEvents,
    }, 'Some calendar events could not be deleted during plan cancellation; proceeding with local hard delete');
  }

  // Step 2 — hard-delete the plan row. FK CASCADE removes weeks,
  // sessions, and completions atomically. The user_id scope on the
  // DELETE is defense-in-depth in case the ownership gate above is
  // ever weakened or bypassed.
  const removal = trainingPlans.deletePlanHard(plan.id, userId);

  // Step 3 — wipe every per-user coach narrative store that survives
  // the DB hard-delete. Without this, the iOS Training Home keeps
  // rendering the cancelled plan's day strip, "Why the coach decided
  // this" card, week-protection narrative, and rest-day hero because
  // the durable `coach_briefing` / `coach_phase` reports + the
  // in-memory coach plan registry + the LRU of last coach states all
  // outlive the plan rows. Run after the hard delete so a transient
  // failure in step 2 doesn't leave us with cleared narrative + an
  // intact ghost plan.
  let removedReports = 0;
  let clearedRegistry = 0;
  if (removal.ok) {
    try {
      removedReports = deleteReportsByType(userId, ['coach_briefing', 'coach_phase']);
    } catch (err) {
      logger.warn({ err, userId, planId: plan.id }, 'Failed to purge coach reports during plan cancellation; UI may render stale coach copy');
    }
    try {
      clearedRegistry = clearStoredPlansForAthlete(userId);
    } catch (err) {
      logger.warn({ err, userId, planId: plan.id }, 'Failed to clear in-memory coach plan registry during plan cancellation');
    }
    try {
      clearLastCoachState(userId);
    } catch (err) {
      logger.warn({ err, userId, planId: plan.id }, 'Failed to clear last-coach-state during plan cancellation');
    }
  }

  if (!removal.ok) {
    // The plan was found above but hard delete didn't change any
    // rows — extremely unlikely (race with another cancel for the
    // same plan, or the plan was deleted between the read and the
    // write). Surface as not_found so the client treats it idempotently.
    logger.warn({ userId, planId: plan.id }, 'Plan hard delete affected zero rows after lookup succeeded');
    return {
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents,
        removedSessions: 0,
        removedWeeks: 0,
        removedCompletions: 0,
        removedPlans: 0,
        totalSessions: 0,
        message: 'No active training plan to cancel.',
      },
    };
  }

  logger.info({
    userId,
    planId: plan.id,
    removedEvents,
    removedSessions: removal.removedSessions,
    removedWeeks: removal.removedWeeks,
    removedCompletions: removal.removedCompletions,
    removedReports,
    clearedRegistry,
  }, 'Training plan cancelled and per-user coach state cleared');

  return {
    status: 'cancelled',
    data: {
      cancelled: true,
      planId: plan.id,
      removedEvents,
      removedSessions: removal.removedSessions,
      removedWeeks: removal.removedWeeks,
      removedCompletions: removal.removedCompletions,
      removedPlans: removal.removedPlans,
      totalSessions: removal.removedSessions,
      message: buildCancellationMessage(removedEvents, removal.removedSessions),
    },
  };
}

function buildCancellationMessage(removedEvents: number, removedSessions: number): string {
  const eventsCopy = `${removedEvents} scheduled workout${removedEvents === 1 ? '' : 's'} removed from the calendar`;
  const sessionsCopy = `${removedSessions} session${removedSessions === 1 ? '' : 's'} cleared from the plan`;
  return `Plan cancelled. ${eventsCopy}; ${sessionsCopy}.`;
}

function hasLinkedCalendarEvent(
  session: TrainingSessionForCancellation,
): session is TrainingSessionForCancellation & { calendar_event_id: string; calendar_source: CalendarSource } {
  return Boolean(session.calendar_event_id && isCalendarSource(session.calendar_source));
}

function isCalendarSource(value: unknown): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}
