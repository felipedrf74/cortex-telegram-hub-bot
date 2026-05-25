// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import {
  getEvents,
  type CalendarSource,
  type UnifiedCalendarEvent,
} from '../../services/unified-calendar';
import * as trainingPlans from '../../services/training-plans';
import { clearStoredPlansForAthlete } from '../../services/coach-plan-registry';
import { deleteReportsByType } from '../../services/report-document-store';
import { clearLastCoachState } from '../../domains/domain-handler';
import {
  findOwnershipsForPlan,
  markCalendarOwnershipDeleted,
} from '../../services/training-plan-lifecycle';
import { reconcileOrphanedTrainingAgendaEvents } from '../../services/training-agenda-reconciliation';
import {
  cancelTrainingPlanCrossSkillDependents,
  findSecretaryAgendaCalendarEventsForPlan,
} from '../../services/training-plan-cancellation-cascade';
import { getTrainingCalendarEventOwners } from '../../services/training-calendar-scope';
import {
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
  parseTrainingIdentityMarker,
} from '../../services/training-session-identity';
import { isProviderEventNotFoundError } from '../../services/training-calendar-errors';
import { deleteTrainingCalendarEventWithRetry } from '../../services/training-calendar-provider-retry';
import { withTrainingCalendarOperationLock } from '../../services/training-operation-locks';

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
  planIds?: number[];
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
  day_of_week?: string | null;
  session_type?: string | null;
  title?: string | null;
  duration_minutes?: number | null;
  intensity_text?: string | null;
  exercises_json?: string | null;
  description_json?: string | null;
  calendar_event_id?: string | null;
  calendar_source?: CalendarSource | string | null;
  session_identity_key?: string | null;
  session_shape_hash?: string | null;
}

interface TrainingWeekForCancellation {
  id: number;
  week_number?: number | null;
}

interface CalendarDeletionTarget {
  eventId: string;
  source: CalendarSource;
  planId: number;
}

interface MatchableTrainingSessionIdentity {
  session: TrainingSessionForCancellation;
  sessionDate: Date;
  sessionIdentityKey: string;
  sessionShapeHash: string;
}

const cancellationLocks = new Map<string, Promise<void>>();
const SERIAL_PROVIDER_DELETE_THRESHOLD = 20;

async function withTrainingCancellationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = cancellationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = previous
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    }));

  cancellationLocks.set(key, current);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (cancellationLocks.get(key) === current) {
      cancellationLocks.delete(key);
    }
  }
}

export async function cancelTrainingPlanForUser(
  userId: number,
  requestedPlanId?: unknown,
): Promise<TrainingPlanCancellationResult> {
  return withTrainingCalendarOperationLock(
    {
      userId,
      tenantId: userId,
      planId: typeof requestedPlanId === 'number' ? requestedPlanId : null,
      operation: 'calendar_cancel',
    },
    () => withTrainingCancellationLock(`training-plan-cancel:${userId}`, () =>
      cancelTrainingPlanForUserLocked(userId, requestedPlanId)),
  );
}

async function cancelTrainingPlanForUserLocked(
  userId: number,
  requestedPlanId?: unknown,
): Promise<TrainingPlanCancellationResult> {
  const parsedPlanId = Number(requestedPlanId);
  const hasRequestedPlan = Number.isFinite(parsedPlanId) && parsedPlanId > 0;
  const requestedPlan = hasRequestedPlan ? trainingPlans.getPlanById(parsedPlanId) : null;
  const activePlans = hasRequestedPlan
    ? []
    : trainingPlans.getActivePlans?.(userId) ?? [];
  const fallbackActivePlan = hasRequestedPlan || activePlans.length > 0
    ? null
    : trainingPlans.getActivePlan(userId);
  const plans = hasRequestedPlan
    ? (requestedPlan ? [requestedPlan] : [])
    : (activePlans.length > 0 ? activePlans : (fallbackActivePlan ? [fallbackActivePlan] : []));

  if (requestedPlan && requestedPlan.user_id !== userId) {
    return { status: 'forbidden' };
  }

  if (plans.length === 0) {
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
  const planIds = plans.map((plan) => plan.id);
  let removedEvents = 0;
  let removedSessions = 0;
  let removedWeeks = 0;
  let removedCompletions = 0;
  let removedPlans = 0;

  for (const plan of plans) {
    const weeks = trainingPlans.getWeeksForPlan(plan.id) as TrainingWeekForCancellation[];
    const sessionsByWeek = weeks.map((week) => ({
      week,
      sessions: trainingPlans.getSessionsForWeek(week.id) as TrainingSessionForCancellation[],
    }));
    const deletionTargets = await buildCalendarDeletionTargetsForPlan(userId, plan, sessionsByWeek);

    const deletionResults = await deleteCalendarDeletionTargets(deletionTargets, userId);
    const planRemovedEvents = deletionResults.filter(result =>
      result.status === 'fulfilled' || isProviderEventNotFoundError(result.reason),
    ).length;
    removedEvents += planRemovedEvents;

    // Slice 4.D — record the cancellation outcome on the audit table
    // so future reconcilers can distinguish events we intentionally
    // removed (status='deleted') from events that became orphaned
    // because their delete failed transiently (status='orphaned').
    // The local hard-delete still proceeds — orphan reconciliation
    // is a follow-up concern, not a blocker for cancellation success.
    deletionResults.forEach((result, idx) => {
      const target = deletionTargets[idx];
      if (!target) return;
      if (result.status === 'fulfilled' || isProviderEventNotFoundError(result.reason)) {
        markCalendarOwnershipDeleted({
          eventId: target.eventId,
          source: target.source,
          reason: result.status === 'fulfilled' ? 'plan_cancelled' : 'plan_cancelled_event_gone_upstream',
          status: 'deleted',
          userId,
          planId: target.planId,
        });
      } else {
        markCalendarOwnershipDeleted({
          eventId: target.eventId,
          source: target.source,
          reason: 'plan_cancelled_external_delete_failed',
          status: 'orphaned',
          userId,
          planId: target.planId,
        });
      }
    });

    if (planRemovedEvents < deletionTargets.length) {
      logger.warn({
        userId,
        planId: plan.id,
        attempted: deletionTargets.length,
        succeeded: planRemovedEvents,
      }, 'Some calendar events could not be deleted during plan cancellation; proceeding with local hard delete');
    }

    const sessionIdsForCascade = sessionsByWeek.flatMap(({ sessions }) => sessions.map((session) => session.id));
    const planVersionForCascade = Number((plan as any).plan_version ?? 1);

    // Step 2 — hard-delete the plan row. FK CASCADE removes weeks,
    // sessions, and completions atomically. The user_id scope on the
    // DELETE is defense-in-depth in case the ownership gate above is
    // ever weakened or bypassed.
    const removal = trainingPlans.deletePlanHard(plan.id, userId);

    if (!removal.ok) {
      // The plan was found above but hard delete didn't change any
      // rows — extremely unlikely (race with another cancel for the
      // same plan, or the plan was deleted between the read and the
      // write). Keep processing sibling active plans, then surface
      // not_found below if nothing was removed.
      logger.warn({ userId, planId: plan.id }, 'Plan hard delete affected zero rows after lookup succeeded');
      continue;
    }

    removedSessions += removal.removedSessions;
    removedWeeks += removal.removedWeeks;
    removedCompletions += removal.removedCompletions;
    removedPlans += removal.removedPlans;

    const cascade = cancelTrainingPlanCrossSkillDependents({
      userId,
      tenantId: Number((plan as any).tenant_id ?? userId),
      planId: plan.id,
      planVersion: planVersionForCascade,
      sessionIds: sessionIdsForCascade,
      reason: 'training_plan_canceled',
    });

    if (cascade.canceledAgendaItems > 0 || cascade.staleMemories > 0 || cascade.signalId != null) {
      logger.info({
        userId,
        planId: plan.id,
        planVersion: planVersionForCascade,
        canceledAgendaItems: cascade.canceledAgendaItems,
        staleMemories: cascade.staleMemories,
        signalId: cascade.signalId,
      }, 'Training cancellation cascaded to Secretary agenda and downstream skill context');
    }
  }

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
  if (removedPlans > 0) {
    try {
      removedReports = deleteReportsByType(userId, ['coach_briefing', 'coach_phase']);
    } catch (err) {
      logger.warn({ err, userId, planIds }, 'Failed to purge coach reports during plan cancellation; UI may render stale coach copy');
    }
    try {
      clearedRegistry = clearStoredPlansForAthlete(userId);
    } catch (err) {
      logger.warn({ err, userId, planIds }, 'Failed to clear in-memory coach plan registry during plan cancellation');
    }
    try {
      clearLastCoachState(userId);
    } catch (err) {
      logger.warn({ err, userId, planIds }, 'Failed to clear last-coach-state during plan cancellation');
    }
  }

  if (removedPlans === 0) {
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

  // 2026-05-02 (Felipe-reported "agenda residues"): retry any
  // ownership rows still flagged 'orphaned' after the deletion
  // pass above. This catches:
  //   - events whose external delete failed transiently in the
  //     for-loop (network blip / 5xx) and got marked 'orphaned'
  //   - events ORPHANED BY EARLIER cancellations that the user
  //     never followed with a plan-creation cycle (which is where
  //     the existing reconciler hook fires from)
  // Without this opportunistic call, an offline/5xx hiccup during
  // cancellation leaves stray events on the user's calendar
  // until they happen to create a new plan. Awaited so the
  // response payload's removedEvents count reflects the reconciled
  // total, but errors are caught so a failing reconciliation never
  // blocks cancellation success.
  let reconciledExtraEvents = 0;
  try {
    const reconciliation = await reconcileOrphanedTrainingAgendaEvents(userId);
    reconciledExtraEvents = reconciliation.deleted;
    if (reconciliation.attempted > 0) {
      logger.info(
        {
          userId,
          planIds,
          attemptedReconciled: reconciliation.attempted,
          deletedReconciled: reconciliation.deleted,
          failedReconciled: reconciliation.failed,
        },
        'Training plan cancellation reconciled orphaned calendar events',
      );
    }
  } catch (err) {
    logger.warn(
      { err, userId, planIds },
      'Post-cancellation orphan reconciliation failed; orphans remain in ownership table for next plan-creation cycle',
    );
  }
  removedEvents += reconciledExtraEvents;

  logger.info({
    userId,
    planIds,
    removedEvents,
    removedSessions,
    removedWeeks,
    removedCompletions,
    removedReports,
    clearedRegistry,
    reconciledExtraEvents,
  }, 'Training plan cancelled and per-user coach state cleared');

  return {
    status: 'cancelled',
    data: {
      cancelled: true,
      planId: planIds[0],
      ...(planIds.length > 1 ? { planIds } : {}),
      removedEvents,
      removedSessions,
      removedWeeks,
      removedCompletions,
      removedPlans,
      totalSessions: removedSessions,
      message: buildCancellationMessage(removedEvents, removedSessions),
    },
  };
}

async function deleteCalendarDeletionTargets(
  deletionTargets: CalendarDeletionTarget[],
  userId: number,
): Promise<Array<PromiseSettledResult<void>>> {
  const deleteTarget = (target: CalendarDeletionTarget) => deleteTrainingCalendarEventWithRetry(
    target.eventId,
    target.source,
    userId,
    {
      userId,
      planId: target.planId,
      eventId: target.eventId,
      source: target.source,
    },
  );

  if (deletionTargets.length <= SERIAL_PROVIDER_DELETE_THRESHOLD) {
    return Promise.allSettled(deletionTargets.map(deleteTarget));
  }

  const results: Array<PromiseSettledResult<void>> = [];
  for (const target of deletionTargets) {
    try {
      await deleteTarget(target);
      results.push({ status: 'fulfilled', value: undefined });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
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

async function buildCalendarDeletionTargetsForPlan(
  userId: number,
  plan: trainingPlans.TrainingPlan,
  sessionsByWeek: Array<{ week: TrainingWeekForCancellation; sessions: TrainingSessionForCancellation[] }>,
): Promise<CalendarDeletionTarget[]> {
  const targets = new Map<string, CalendarDeletionTarget>();

  for (const { sessions } of sessionsByWeek) {
    for (const session of sessions) {
      if (!hasLinkedCalendarEvent(session)) continue;
      const key = `${session.calendar_source}:${session.calendar_event_id}`;
      targets.set(key, {
        eventId: session.calendar_event_id,
        source: session.calendar_source,
        planId: plan.id,
      });
    }
  }

  for (const ownership of findOwnershipsForPlan(plan.id, userId)) {
    if (ownership.status === 'deleted') continue;
    if (!isCalendarSource(ownership.calendar_source)) continue;
    const key = `${ownership.calendar_source}:${ownership.calendar_event_id}`;
    targets.set(key, {
      eventId: ownership.calendar_event_id,
      source: ownership.calendar_source,
      planId: plan.id,
    });
  }

  // 2026-05-25 fix — Secretary-owned training calendar events live
  // in `secretary_agenda_items.provider_event_id` and are NOT
  // mirrored into `training_agenda_event_ownership`. Without this
  // sweep, cancelling a plan only deletes events the training skill
  // wrote directly; events the secretary arbitrator wrote on
  // training's behalf were left behind, then either had to wait for
  // the next `secretary_agenda_sync` cron tick (5 min) or sat as
  // permanent orphans if the cancellation cascade also failed to
  // match the agenda row (see prior `plan_version` drift fix in
  // training-plan-cancellation-cascade.ts).
  for (const secretaryEvent of findSecretaryAgendaCalendarEventsForPlan(plan.id, userId, plan.tenant_id ?? userId)) {
    if (!isCalendarSource(secretaryEvent.calendar_source)) continue;
    const key = `${secretaryEvent.calendar_source}:${secretaryEvent.calendar_event_id}`;
    if (targets.has(key)) continue;
    targets.set(key, {
      eventId: secretaryEvent.calendar_event_id,
      source: secretaryEvent.calendar_source,
      planId: plan.id,
    });
  }

  const matchableSessions = buildIdentityMatchableSessions(plan, sessionsByWeek);

  if (matchableSessions.length === 0) {
    return [...targets.values()];
  }

  const sortedDates = matchableSessions
    .map((entry) => entry.sessionDate)
    .sort((left, right) => left.getTime() - right.getTime());
  const startStr = sortedDates[0].toISOString().slice(0, 10);
  const endStr = new Date(sortedDates[sortedDates.length - 1].getTime() + 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  try {
    const events = await getEvents(startStr, endStr, userId);
    for (const event of events || []) {
      const matchingSession = matchableSessions.find((entry) =>
        isMatchingGeneratedTrainingEvent(entry, plan.id, event),
      );
      if (!matchingSession) continue;

      const sources = event.syncedSources?.length ? event.syncedSources : [event.source];
      for (const source of sources) {
        if (!isCalendarSource(source)) continue;
        if (isOwnedByAnotherTrainingPlan(event.id, source, userId, plan.id)) continue;
        const key = `${source}:${event.id}`;
        targets.set(key, { eventId: event.id, source, planId: plan.id });
      }
    }
  } catch (err) {
    logger.debug({ err, userId, planId: plan.id }, 'Plan cancellation calendar lookup failed — deleting only linked events');
  }

  return [...targets.values()];
}

function isOwnedByAnotherTrainingPlan(
  eventId: string,
  source: CalendarSource,
  userId: number,
  planId: number,
): boolean {
  const owners = getTrainingCalendarEventOwners(eventId, source);
  return owners.some((owner) => owner.userId !== userId || owner.planId !== planId);
}

function isMatchingGeneratedTrainingEvent(
  entry: MatchableTrainingSessionIdentity,
  planId: number,
  event: UnifiedCalendarEvent,
): boolean {
  if (!event.id || !isCalendarSource(event.source)) return false;
  const marker = parseTrainingIdentityMarker(event.description);
  const identityMatched = Boolean(
    marker?.sessionIdentityKey
      && marker?.sessionShapeHash
      && marker.planId === planId
      && marker.sessionIdentityKey === entry.sessionIdentityKey
      && marker.sessionShapeHash === entry.sessionShapeHash,
  );
  const secretaryIntentMatched = matchesSecretaryTrainingSourceIntent(entry, planId, event.description);
  if (!identityMatched && !secretaryIntentMatched) return false;

  const eventStart = new Date(event.start);
  const eventEnd = new Date(event.end);
  if (!Number.isFinite(eventStart.getTime()) || !Number.isFinite(eventEnd.getTime())) return false;
  if (eventStart.toISOString().slice(0, 10) !== entry.sessionDate.toISOString().slice(0, 10)) return false;

  const eventDurationMinutes = Math.round((eventEnd.getTime() - eventStart.getTime()) / 60000);
  const durationMinutes = entry.session.duration_minutes || 60;
  return Math.abs(eventDurationMinutes - durationMinutes) <= 2;
}

function matchesSecretaryTrainingSourceIntent(
  entry: MatchableTrainingSessionIdentity,
  planId: number,
  description: string | undefined,
): boolean {
  const text = String(description || '');
  if (!/^NEXUS_SECRETARY_SOURCE_SKILL:training$/mi.test(text)) return false;
  const match = text.match(/^NEXUS_SECRETARY_SOURCE_INTENT:training:(\d+):(\d+):(\d+)$/mi);
  if (!match) return false;
  const sourcePlanId = Number(match[1]);
  const sourceSessionId = Number(match[3]);
  return sourcePlanId === planId && sourceSessionId === entry.session.id;
}

function buildIdentityMatchableSessions(
  plan: trainingPlans.TrainingPlan,
  sessionsByWeek: Array<{ week: TrainingWeekForCancellation; sessions: TrainingSessionForCancellation[] }>,
): MatchableTrainingSessionIdentity[] {
  const result: MatchableTrainingSessionIdentity[] = [];
  for (const { week, sessions } of sessionsByWeek) {
    const ordinals = new Map<string, number>();
    for (const session of sessions) {
      if (String(session.session_type || '').toLowerCase() === 'rest') continue;
      const sessionDate = sessionDateFor(plan.start_date, week.week_number || 1, session.day_of_week || '');
      if (!sessionDate) continue;
      const ordinalKey = [
        String(session.day_of_week || '').trim().toLowerCase(),
        String(session.session_type || 'training').trim().toLowerCase(),
      ].join('|');
      const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1;
      ordinals.set(ordinalKey, ordinal);
      const sessionIdentityKey = session.session_identity_key || buildTrainingSessionIdentityKey({
        planId: plan.id,
        weekNumber: week.week_number || 1,
        dayOfWeek: session.day_of_week || '',
        sessionType: session.session_type || 'training',
        ordinal,
      });
      const sessionShapeHash = session.session_shape_hash || computeTrainingSessionShapeHash({
        sessionType: session.session_type || 'training',
        title: session.title || 'Training session',
        durationMinutes: session.duration_minutes || 60,
        intensityText: session.intensity_text || null,
        exercises: session.exercises_json || [],
        descriptionSections: session.description_json || null,
      });
      result.push({
        session,
        sessionDate,
        sessionIdentityKey,
        sessionShapeHash,
      });
    }
  }
  return result;
}

const DAY_INDEX_FROM_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function sessionDateFor(planStartIso: string, weekNumber: number, dayOfWeek: string): Date | null {
  const dayIndex = DAY_INDEX_FROM_NAME[dayOfWeek.trim().toLowerCase()];
  if (dayIndex == null) return null;
  const weekStart = new Date(planStartIso);
  if (!Number.isFinite(weekStart.getTime())) return null;
  weekStart.setDate(weekStart.getDate() + (weekNumber - 1) * 7);
  const currentDay = weekStart.getDay();
  let daysUntil = dayIndex - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  const sessionDate = new Date(weekStart);
  sessionDate.setDate(sessionDate.getDate() + daysUntil);
  return sessionDate;
}
