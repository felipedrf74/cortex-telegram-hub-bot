// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import { deleteEvent, getEvents, updateEvent, type CalendarSource, type UnifiedCalendarEvent } from '../../services/unified-calendar';
import {
  buildBusyWindows,
  normalizePreferredTime,
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
} from './training-schedule-utils';
import { createTrainingCalendarEvent } from './training-calendar-event-writer';
import { logger } from '../../utils/logger';
import { isTrainingCalendarEventUnclaimed } from '../../services/training-calendar-scope';
import {
  findExistingOwnership,
  findReusableOwnershipBySessionIdentity,
  getPlanVersion,
  markCalendarOwnershipDeleted,
  recordCalendarOwnership,
} from '../../services/training-plan-lifecycle';
import {
  appendTrainingIdentityMarker,
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
  parseTrainingIdentityMarker,
} from '../../services/training-session-identity';
import {
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
} from '../../services/secretary-scheduling-arbitrator';
import {
  resolveTrainingCalendarSource,
  withTrainingCalendarSourcePreference,
} from '../../services/training-calendar-source';

export type TrainingPlanCalendarSyncResult =
  | {
      status: 'no_active_plan';
      data: {
        eventsCreated: 0;
        sessionsAttempted: 0;
        sessionsAlreadySynced: 0;
        message: string;
      };
    }
  | {
      status: 'no_calendar';
      data: {
        eventsCreated: 0;
        sessionsAttempted: number;
        sessionsAlreadySynced: number;
        message: string;
      };
    }
  | {
      status: 'synced';
      data: {
        eventsCreated: number;
        sessionsAttempted: number;
        sessionsAlreadySynced: number;
        sessionsLinked: number;
        sessionsFailed: number;
        message: string;
      };
    };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const DAY_INDEX_FROM_NAME: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

interface PlanPreferences {
  preferredTime: string;
  preferredCardioTime: string;
  preferredStrengthTime: string;
}

function readPlanPreferences(plan: trainingPlans.TrainingPlan): PlanPreferences {
  // Defaults mirror generateTrainingPlanForUser's defaults so a plan
  // created before preferences_json was populated still gets the same
  // schedule cadence on backfill.
  const fallback: PlanPreferences = {
    preferredTime: '12:00',
    preferredCardioTime: '12:00',
    preferredStrengthTime: '12:00',
  };
  if (!plan.preferences_json) return fallback;
  try {
    const parsed = JSON.parse(plan.preferences_json) as Record<string, unknown>;
    return {
      preferredTime: normalizePreferredTime(parsed.preferredTime, fallback.preferredTime),
      preferredCardioTime: normalizePreferredTime(parsed.preferredCardioTime, fallback.preferredCardioTime),
      preferredStrengthTime: normalizePreferredTime(parsed.preferredStrengthTime, fallback.preferredStrengthTime),
    };
  } catch {
    return fallback;
  }
}

function emojiForTrainingSession(sessionType: string | null | undefined): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return '💪';
    case 'run':
      return '🏃';
    case 'ride':
    case 'bike':
    case 'cycling':
      return '🚴';
    case 'swim':
      return '🏊';
    default:
      return '🏋️';
  }
}

function sessionDateFor(planStart: Date, weekNumber: number, dayOfWeek: string): Date | null {
  const dayIndex = DAY_INDEX_FROM_NAME[dayOfWeek.trim().toLowerCase()];
  if (dayIndex == null) return null;
  // The original generation logic anchors week N at planStart + (N-1)*7
  // and then walks forward to the requested day-of-week. We replicate
  // that here so backfill lands the session on the SAME calendar date
  // it would have if the original createEvent hadn't failed.
  const weekStart = new Date(planStart);
  weekStart.setDate(weekStart.getDate() + (weekNumber - 1) * 7);
  const currentDay = weekStart.getDay();
  let daysUntil = dayIndex - currentDay;
  if (daysUntil < 0) daysUntil += 7;
  const sessionDate = new Date(weekStart);
  sessionDate.setDate(sessionDate.getDate() + daysUntil);
  return sessionDate;
}

/**
 * Backfill calendar events for an active training plan's sessions that
 * don't have a verified live calendar event. This is the recovery path for
 * plans that were generated while the user's calendar provider was in
 * `invalid_grant` (or any other error state) — at generation time every
 * `createEvent` failed and the plan landed with `eventsCreated: 0`. After
 * the user reauths, this call walks the plan and creates the missing
 * calendar events so the workouts actually show up on Google/Outlook.
 *
 * - Only future sessions are synced. Past sessions are skipped (you can't
 *   put yesterday's workout on the calendar — it's already history).
 * - Completed / skipped sessions are skipped (no point creating an event
 *   for a session the user already closed out).
 * - Sessions with a `calendar_event_id` are only reported as
 *   `sessionsAlreadySynced` when that provider event is still visible and
 *   matches the generated training block. Missing/stale links are repaired.
 * - Schedule preferences are read from the plan's `preferences_json` so
 *   the times are consistent with the original generation pass.
 */
export async function syncTrainingPlanCalendar(
  userId: number,
  now: Date = new Date(),
  requestedCalendarSource?: CalendarSource | null,
): Promise<TrainingPlanCalendarSyncResult> {
  const plan = trainingPlans.getActivePlan(userId);
  if (!plan) {
    return {
      status: 'no_active_plan',
      data: {
        eventsCreated: 0,
        sessionsAttempted: 0,
        sessionsAlreadySynced: 0,
        message: 'No active training plan to sync.',
      },
    };
  }

  const preferences = readPlanPreferences(plan);
  const planStart = new Date(plan.start_date);
  const planVersion = getPlanVersion(plan.id) ?? 1;

  // Walk every week / session up front so we can skip past or finished
  // sessions, then verify existing calendar links against the provider.
  type SyncCandidate = {
    sessionId: number;
    sessionIdentityKey: string;
    sessionShapeHash: string;
    dayOfWeek: string;
    sessionType: string;
    title: string;
    durationMinutes: number;
    description: string;
    sessionDate: Date;
    calendarEventId: string | null;
    calendarSource: string | null;
    staleLinkedEvent?: UnifiedCalendarEvent | null;
  };
  const candidates: SyncCandidate[] = [];
  const weeks = trainingPlans.getWeeksForPlan(plan.id);
  for (const week of weeks) {
    const sessions = trainingPlans.getSessionsForWeek(week.id);
    const ordinals = new Map<string, number>();
    for (const session of sessions) {
      const status = String(session.status || '').toLowerCase();
      if (status === 'completed' || status === 'skipped' || isInactiveScheduleStatus(status)) continue;
      const sessionType = String(session.session_type || '').toLowerCase();
      if (sessionType === 'rest') continue;
      const sessionDate = sessionDateFor(planStart, week.week_number, session.day_of_week);
      if (!sessionDate) continue;
      // Only sync today and forward — don't put past workouts on the calendar.
      const dayStart = new Date(sessionDate);
      dayStart.setHours(0, 0, 0, 0);
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      if (dayStart.getTime() < todayStart.getTime()) continue;
      const ordinalKey = [
        String(session.day_of_week || '').trim().toLowerCase(),
        String(session.session_type || 'training').trim().toLowerCase(),
      ].join('|');
      const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1;
      ordinals.set(ordinalKey, ordinal);
      const sessionIdentityKey = session.session_identity_key || buildTrainingSessionIdentityKey({
        planId: plan.id,
        weekNumber: week.week_number,
        dayOfWeek: session.day_of_week,
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
      candidates.push({
        sessionId: session.id,
        sessionIdentityKey,
        sessionShapeHash,
        dayOfWeek: session.day_of_week,
        sessionType: session.session_type || 'training',
        title: session.title || 'Training session',
        durationMinutes: session.duration_minutes || 60,
        description: session.description || '',
        sessionDate,
        calendarEventId: session.calendar_event_id || null,
        calendarSource: session.calendar_source || null,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      status: 'synced',
      data: {
        eventsCreated: 0,
        sessionsAttempted: 0,
        sessionsAlreadySynced: 0,
        sessionsLinked: 0,
        sessionsFailed: 0,
        message: 'No future sessions left to sync.',
      },
    };
  }

  const calendarSource = resolveTrainingCalendarSource({
    userId,
    requestedSource: requestedCalendarSource ?? undefined,
    planPreferencesJson: plan.preferences_json,
    linkedSources: candidates.map((candidate) => candidate.calendarSource),
  });
  if (!calendarSource) {
    return {
      status: 'no_calendar',
      data: {
        eventsCreated: 0,
        sessionsAttempted: candidates.length,
        sessionsAlreadySynced: 0,
        message: 'No calendar provider is connected. Reconnect Google or Microsoft, then try again.',
      },
    };
  }

  // Fetch busy windows ONCE for the entire span so each scheduling pass
  // sees the same calendar state. If the calendar fetch itself throws
  // (provider still degraded), we proceed with empty busy windows — the
  // user explicitly asked for the sync and a wrong-but-present time is
  // strictly better than another silent failure.
  const earliest = candidates[0].sessionDate;
  const latest = candidates[candidates.length - 1].sessionDate;
  const startStr = earliest.toISOString().slice(0, 10);
  const endStr = new Date(latest.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let busyWindows: BusyWindow[] = [];
  let calendarEvents: UnifiedCalendarEvent[] = [];
  let calendarFetchSucceeded = false;
  try {
    const events = await getEvents(startStr, endStr, userId);
    calendarEvents = events || [];
    const replacedLinkedEventKeys = new Set(
      candidates
        .filter((candidate) =>
          candidate.calendarEventId
          && candidate.calendarSource
          && candidate.calendarSource !== calendarSource
        )
        .map((candidate) => `${candidate.calendarSource}:${candidate.calendarEventId}`),
    );
    busyWindows = buildBusyWindows(calendarEvents.filter((event) =>
      !replacedLinkedEventKeys.has(`${event.source}:${event.id}`)
    ));
    calendarFetchSucceeded = true;
  } catch (err) {
    logger.debug({ err, userId }, 'syncTrainingPlanCalendar: getEvents failed — scheduling without busy-window constraints');
  }

  const scheduledWindows: BusyWindow[] = [];
  const consumedExistingEventKeys = new Set<string>();
  const pending: SyncCandidate[] = [];
  let alreadySynced = 0;
  let ownershipRelinked = 0;
  for (const item of candidates) {
    const existingOwnership = findExistingOwnership({
      planId: plan.id,
      planVersion,
      sessionId: item.sessionId,
      tenantId: userId,
      userId,
    });
    const reusableOwnership = existingOwnership
      ? null
      : findReusableOwnershipBySessionIdentity({
        planId: plan.id,
        tenantId: userId,
        userId,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
    const ownershipToRelink = existingOwnership ?? reusableOwnership;

    if (!item.calendarEventId && ownershipToRelink) {
      if (ownershipToRelink.calendar_source !== calendarSource) {
        pending.push(item);
        continue;
      }
      if (!calendarFetchSucceeded) {
        trainingPlans.linkSessionToCalendar(
          item.sessionId,
          ownershipToRelink.calendar_event_id,
          ownershipToRelink.calendar_source,
        );
        ownershipRelinked += 1;
        continue;
      }

      const ownedEvent = calendarEvents.find((event) =>
        event.id === ownershipToRelink.calendar_event_id
        && event.source === ownershipToRelink.calendar_source
      );
      if (ownedEvent && isMatchingGeneratedTrainingEvent(item, ownedEvent, plan.id, { allowLegacyTitleMatch: true })) {
        await updateSameShapeEventIfNeeded({
          planId: plan.id,
          planVersion,
          item,
          event: ownedEvent,
          preferences,
          userId,
        });
        trainingPlans.linkSessionToCalendar(item.sessionId, ownedEvent.id, ownedEvent.source);
        recordTrainingCalendarOwnership({
          planId: plan.id,
          planVersion,
          sessionId: item.sessionId,
          tenantId: userId,
          userId,
          eventId: ownedEvent.id,
          source: ownedEvent.source,
          sessionIdentityKey: item.sessionIdentityKey,
          sessionShapeHash: item.sessionShapeHash,
        });
        ownershipRelinked += 1;
        const eventStart = new Date(ownedEvent.start);
        const eventEnd = new Date(ownedEvent.end);
        if (Number.isFinite(eventStart.getTime()) && Number.isFinite(eventEnd.getTime())) {
          scheduledWindows.push({
            startMs: eventStart.getTime(),
            endMs: eventEnd.getTime(),
            title: item.title,
          });
          consumedExistingEventKeys.add(`${ownedEvent.source}:${ownedEvent.id}`);
        }
        continue;
      }
    }

    if (!item.calendarEventId) {
      pending.push(item);
      continue;
    }

    if (!calendarFetchSucceeded) {
      alreadySynced += 1;
      continue;
    }

    const linkedEvent = findLinkedCalendarEvent(item, calendarEvents);
    if (linkedEvent && linkedEvent.source !== calendarSource) {
      pending.push({ ...item, staleLinkedEvent: linkedEvent });
      continue;
    }
    if (linkedEvent && isMatchingGeneratedTrainingEvent(item, linkedEvent, plan.id, { allowLegacyTitleMatch: true })) {
      await updateSameShapeEventIfNeeded({
        planId: plan.id,
        planVersion,
        item,
        event: linkedEvent,
        preferences,
        userId,
      });
      recordTrainingCalendarOwnership({
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        tenantId: userId,
        userId,
        eventId: linkedEvent.id,
        source: linkedEvent.source,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
      alreadySynced += 1;
      const eventStart = new Date(linkedEvent.start);
      const eventEnd = new Date(linkedEvent.end);
      if (Number.isFinite(eventStart.getTime()) && Number.isFinite(eventEnd.getTime())) {
        scheduledWindows.push({
          startMs: eventStart.getTime(),
          endMs: eventEnd.getTime(),
          title: item.title,
        });
        consumedExistingEventKeys.add(`${linkedEvent.source}:${linkedEvent.id}`);
      }
      continue;
    }

    pending.push({ ...item, staleLinkedEvent: linkedEvent });
    logger.warn(
      {
        userId,
        sessionId: item.sessionId,
        calendarEventId: item.calendarEventId,
        calendarSource: item.calendarSource,
        reason: linkedEvent ? 'mismatched_linked_event' : 'missing_linked_event',
      },
      'syncTrainingPlanCalendar: repairing stale training calendar link',
    );
  }

  if (pending.length === 0) {
    if (requestedCalendarSource) {
      persistPlanTrainingCalendarSourcePreference(plan, requestedCalendarSource);
    }
    return {
      status: 'synced',
      data: {
        eventsCreated: 0,
        sessionsAttempted: 0,
        sessionsAlreadySynced: alreadySynced,
        sessionsLinked: ownershipRelinked,
        sessionsFailed: 0,
        message:
          ownershipRelinked > 0
            ? `${ownershipRelinked} existing ${ownershipRelinked === 1 ? 'session was' : 'sessions were'} linked to your calendar.`
            : alreadySynced > 0
            ? 'Your plan is already on the calendar.'
            : 'No future sessions left to sync.',
      },
    };
  }

  let eventsCreated = 0;
  let sessionsLinked = ownershipRelinked;
  let sessionsFailed = 0;
  let firstError: Error | null = null;

  for (const item of pending) {
    const existingEvent = consumeMatchingExistingTrainingEvent(item, plan.id, calendarEvents, consumedExistingEventKeys, calendarSource);
    if (existingEvent) {
      trainingPlans.linkSessionToCalendar(item.sessionId, existingEvent.id, existingEvent.source);
      recordTrainingCalendarOwnership({
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        tenantId: userId,
        userId,
        eventId: existingEvent.id,
        source: existingEvent.source,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
      sessionsLinked += 1;
      const eventStart = new Date(existingEvent.start);
      const eventEnd = new Date(existingEvent.end);
      if (Number.isFinite(eventStart.getTime()) && Number.isFinite(eventEnd.getTime())) {
        scheduledWindows.push({
          startMs: eventStart.getTime(),
          endMs: eventEnd.getTime(),
          title: item.title,
        });
      }
      await deleteStaleLinkedTrainingEvent({
        userId,
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        staleEvent: item.staleLinkedEvent,
      });
      continue;
    }

    const preferredTime = preferredTimeForSessionType(
      item.sessionType,
      preferences.preferredTime,
      preferences.preferredCardioTime,
      preferences.preferredStrengthTime,
    );
    const window = scheduleSessionWindow(
      item.sessionDate,
      item.durationMinutes,
      preferredTime,
      busyWindows,
      scheduledWindows,
    );
    if (window.noAvailableSlot) {
      trainingPlans.updateSession(item.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      sessionsFailed += 1;
      logger.warn(
        {
          userId,
          planId: plan.id,
          planVersion,
          sessionId: item.sessionId,
          title: item.title,
          reason: window.unavailableReason,
        },
        'syncTrainingPlanCalendar: session left unscheduled because no valid calendar slot remained',
      );
      continue;
    }
    let secretaryWindow: { start: string; end: string } | null = null;
    try {
      const secretaryDecision = submitSecretarySchedulingIntent(
        buildTrainingSyncSecretaryIntent({
          userId,
          tenantId: Number((plan as any).tenant_id ?? userId),
          planId: plan.id,
          planVersion,
          item,
          start: window.start,
          end: window.end,
        }),
        { now: now.toISOString() },
      );
      secretaryWindow = selectedTrainingSyncSecretaryWindow(secretaryDecision);
      if (!secretaryWindow) {
        trainingPlans.updateSession(item.sessionId, {
          status: 'unscheduled',
          calendar_event_id: null,
          calendar_source: null,
        });
        sessionsFailed += 1;
        logger.warn(
          {
            userId,
            planId: plan.id,
            planVersion,
            sessionId: item.sessionId,
            secretaryStatus: secretaryDecision.status,
            reasonCodes: secretaryDecision.reasonCodes,
          },
          'syncTrainingPlanCalendar: Secretary did not return a schedulable Training slot',
        );
        continue;
      }
    } catch (err) {
      sessionsFailed += 1;
      if (!firstError) firstError = err as Error;
      logger.warn(
        { err, userId, planId: plan.id, planVersion, sessionId: item.sessionId },
        'syncTrainingPlanCalendar: Secretary scheduling intent failed for session',
      );
      continue;
    }

    scheduledWindows.push({
      startMs: Date.parse(secretaryWindow.start),
      endMs: Date.parse(secretaryWindow.end),
      title: item.title,
    });

    try {
      const event = await createTrainingCalendarEvent(
        {
          title: `${emojiForTrainingSession(item.sessionType)} ${item.title} (${item.durationMinutes}min)`,
          start: secretaryWindow.start,
          end: secretaryWindow.end,
          description: appendTrainingIdentityMarker(item.description, {
            planId: plan.id,
            planVersion,
            sessionId: item.sessionId,
            sessionIdentityKey: item.sessionIdentityKey,
            sessionShapeHash: item.sessionShapeHash,
          }),
        },
        calendarSource,
        userId,
        {
          userId,
          sessionId: item.sessionId,
          title: item.title,
        },
      );
      trainingPlans.linkSessionToCalendar(item.sessionId, event.id, event.source);
      recordTrainingCalendarOwnership({
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        tenantId: userId,
        userId,
        eventId: event.id,
        source: event.source,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
      await deleteStaleLinkedTrainingEvent({
        userId,
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        staleEvent: item.staleLinkedEvent,
      });
      eventsCreated += 1;
    } catch (err) {
      sessionsFailed += 1;
      if (!firstError) firstError = err as Error;
      logger.warn(
        { err, userId, sessionId: item.sessionId, day: item.dayOfWeek },
        'syncTrainingPlanCalendar: createEvent failed for session',
      );
    }
  }

  if (requestedCalendarSource) {
    persistPlanTrainingCalendarSourcePreference(plan, requestedCalendarSource);
  }

  // Detect "no calendar provider connected" specifically — that's the
  // signal we want to give the iOS UI a clear "go reconnect" message
  // instead of a generic "some events failed" toast.
  if (eventsCreated === 0 && sessionsLinked === 0 && sessionsFailed === pending.length) {
    const noCalendar = firstError?.message?.toLowerCase().includes('no calendar provider');
    if (noCalendar) {
      return {
        status: 'no_calendar',
        data: {
          eventsCreated: 0,
          sessionsAttempted: pending.length,
          sessionsAlreadySynced: alreadySynced,
          message:
            'No calendar provider is connected. Reconnect Google or Microsoft, then try again.',
        },
      };
    }
  }

  const linkedFromPending = sessionsLinked - ownershipRelinked;
  const resolvedPendingCount = eventsCreated + linkedFromPending;
  const resolvedCount = eventsCreated + sessionsLinked;
  const remainingDay = pending.length - resolvedPendingCount;
  let message: string;
  if (resolvedCount === 0) {
    message = 'Could not create any calendar events. Check your calendar connection and try again.';
  } else if (remainingDay === 0 && eventsCreated === 0) {
    message = `${sessionsLinked} existing ${sessionsLinked === 1 ? 'session was' : 'sessions were'} linked to your calendar.`;
  } else if (remainingDay === 0 && sessionsLinked === 0) {
    message = `${eventsCreated} ${eventsCreated === 1 ? 'session' : 'sessions'} added to your calendar.`;
  } else if (remainingDay === 0) {
    message = `${resolvedCount} ${resolvedCount === 1 ? 'session' : 'sessions'} synced to your calendar.`;
  } else if (sessionsLinked === 0) {
    message = `${eventsCreated} of ${pending.length} sessions added to your calendar; ${remainingDay} could not be created.`;
  } else {
    message = `${resolvedCount} of ${pending.length} sessions synced to your calendar; ${remainingDay} could not be created.`;
  }

  return {
    status: 'synced',
    data: {
      eventsCreated,
      sessionsAttempted: pending.length,
      sessionsAlreadySynced: alreadySynced,
      sessionsLinked,
      sessionsFailed,
      message,
    },
  };
}

async function deleteStaleLinkedTrainingEvent(input: {
  userId: number;
  planId: number;
  planVersion: number;
  sessionId: number;
  staleEvent?: UnifiedCalendarEvent | null;
}): Promise<void> {
  const stale = input.staleEvent;
  if (!stale || !stale.id || !isWritableCalendarSource(stale.source)) return;

  try {
    await deleteEvent(stale.id, stale.source, input.userId);
    markCalendarOwnershipDeleted({
      eventId: stale.id,
      source: stale.source,
      reason: 'training_sync_replaced_stale_event',
      status: 'deleted',
      userId: input.userId,
      planId: input.planId,
    });
    logger.info(
      {
        userId: input.userId,
        planId: input.planId,
        planVersion: input.planVersion,
        sessionId: input.sessionId,
        staleEventId: stale.id,
        source: stale.source,
      },
      'syncTrainingPlanCalendar: deleted stale linked calendar event after repair',
    );
  } catch (err) {
    markCalendarOwnershipDeleted({
      eventId: stale.id,
      source: stale.source,
      reason: 'training_sync_stale_event_delete_failed',
      status: 'orphaned',
      userId: input.userId,
      planId: input.planId,
    });
    logger.warn(
      {
        err,
        userId: input.userId,
        planId: input.planId,
        planVersion: input.planVersion,
        sessionId: input.sessionId,
        staleEventId: stale.id,
        source: stale.source,
      },
      'syncTrainingPlanCalendar: failed to delete stale linked calendar event after repair',
    );
  }
}

function isWritableCalendarSource(value: unknown): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}

function recordTrainingCalendarOwnership(input: {
  planId: number;
  planVersion: number;
  sessionId: number;
  tenantId?: number;
  userId: number;
  eventId: string;
  source: string;
  sessionIdentityKey?: string | null;
  sessionShapeHash?: string | null;
}): void {
  const result = recordCalendarOwnership(input);
  if (!result.ok) {
    logger.warn(
      {
        planId: input.planId,
        planVersion: input.planVersion,
        sessionId: input.sessionId,
        eventId: input.eventId,
        source: input.source,
      },
      'syncTrainingPlanCalendar: failed to record agenda ownership',
    );
  }
}

function buildTrainingSyncSecretaryIntent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  item: {
    sessionId: number;
    sessionIdentityKey: string;
    sessionShapeHash: string;
    title: string;
    durationMinutes: number;
  };
  start: Date;
  end: Date;
}): SecretarySchedulingIntent {
  return {
    intentId: `training:${input.planId}:${input.planVersion}:${input.item.sessionId}`,
    sourceSkill: 'training',
    sourceAction: 'sync_training_session_calendar',
    sourceEntityId: input.item.sessionId,
    sourceEntityType: 'training_session',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    title: input.item.title,
    requestedDurationMinutes: Math.max(1, input.item.durationMinutes),
    minimumDurationMinutes: Math.min(Math.max(20, Math.round(input.item.durationMinutes * 0.75)), input.item.durationMinutes),
    preferredWindows: [{
      start: input.start.toISOString(),
      end: input.end.toISOString(),
      label: 'training calendar sync slot',
      hard: true,
    }],
    priority: 'high',
    flexibility: 'fixed',
    reason: 'Training calendar sync requested Secretary-owned agenda placement.',
    context: `plan_id=${input.planId}; plan_version=${input.planVersion}; session_identity_key=${input.item.sessionIdentityKey}; session_shape_hash=${input.item.sessionShapeHash}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function selectedTrainingSyncSecretaryWindow(decision: SecretarySchedulingDecision): { start: string; end: string } | null {
  if (!['scheduled', 'reflowed', 'compressed'].includes(decision.status)) return null;
  if (!decision.selectedSlot?.start || !decision.selectedSlot?.end) return null;
  return { start: decision.selectedSlot.start, end: decision.selectedSlot.end };
}

function consumeMatchingExistingTrainingEvent(
  item: {
    sessionIdentityKey: string;
    sessionShapeHash: string;
    sessionType: string;
    title: string;
    durationMinutes: number;
    sessionDate: Date;
  },
  planId: number,
  events: UnifiedCalendarEvent[],
  consumedKeys: Set<string>,
  calendarSource: CalendarSource,
): UnifiedCalendarEvent | null {
  for (const event of events) {
    if (event.source !== calendarSource) continue;
    const key = `${event.source}:${event.id}`;
    if (consumedKeys.has(key)) continue;
    if (!isMatchingGeneratedTrainingEvent(item, event, planId, { allowLegacyTitleMatch: false })) continue;
    if (!isTrainingCalendarEventUnclaimed(event.id, event.source)) continue;
    consumedKeys.add(key);
    return event;
  }
  return null;
}

function persistPlanTrainingCalendarSourcePreference(
  plan: trainingPlans.TrainingPlan,
  calendarSource: CalendarSource,
): void {
  const preferencesJson = withTrainingCalendarSourcePreference(plan.preferences_json, calendarSource);
  try {
    trainingPlans.updatePlanPreferences?.(plan.id, preferencesJson);
  } catch (err) {
    logger.warn(
      { err, userId: plan.user_id, planId: plan.id, calendarSource },
      'syncTrainingPlanCalendar: failed to persist requested training calendar source preference',
    );
  }
}

function findLinkedCalendarEvent(
  item: {
    calendarEventId: string | null;
    calendarSource: string | null;
  },
  events: UnifiedCalendarEvent[],
): UnifiedCalendarEvent | null {
  if (!item.calendarEventId) return null;
  return events.find((event) => {
    if (event.id !== item.calendarEventId) return false;
    if (!item.calendarSource) return true;
    return event.source === item.calendarSource;
  }) ?? null;
}

function isMatchingGeneratedTrainingEvent(
  item: {
    sessionIdentityKey: string;
    sessionShapeHash: string;
    sessionType: string;
    title: string;
    durationMinutes: number;
    sessionDate: Date;
  },
  event: UnifiedCalendarEvent,
  planId: number,
  options: { allowLegacyTitleMatch: boolean },
): boolean {
  if (!event.id || (event.source !== 'google' && event.source !== 'outlook')) return false;
  const marker = parseTrainingIdentityMarker(event.description);
  if (marker?.sessionIdentityKey && marker?.sessionShapeHash) {
    return marker.planId === planId
      && marker.sessionIdentityKey === item.sessionIdentityKey
      && marker.sessionShapeHash === item.sessionShapeHash;
  }
  if (!options.allowLegacyTitleMatch) return false;

  const expectedTitle = normalizeTrainingEventTitle(
    `${emojiForTrainingSession(item.sessionType)} ${item.title} (${item.durationMinutes}min)`,
  );
  if (normalizeTrainingEventTitle(event.summary) !== expectedTitle) return false;

  const eventStart = new Date(event.start);
  const eventEnd = new Date(event.end);
  if (!Number.isFinite(eventStart.getTime()) || !Number.isFinite(eventEnd.getTime())) return false;
  if (eventStart.toISOString().slice(0, 10) !== item.sessionDate.toISOString().slice(0, 10)) return false;

  const durationMinutes = Math.round((eventEnd.getTime() - eventStart.getTime()) / 60000);
  return Math.abs(durationMinutes - item.durationMinutes) <= 2;
}

async function updateSameShapeEventIfNeeded(input: {
  planId: number;
  planVersion: number;
  item: {
    sessionId: number;
    sessionIdentityKey: string;
    sessionShapeHash: string;
    sessionType: string;
    title: string;
    durationMinutes: number;
    sessionDate: Date;
    description: string;
  };
  event: UnifiedCalendarEvent;
  preferences: PlanPreferences;
  userId: number;
}): Promise<void> {
  const { item, event, preferences, userId, planId, planVersion } = input;
  if (!isWritableCalendarSource(event.source)) return;
  const currentStart = new Date(event.start);
  const currentEnd = new Date(event.end);
  if (!Number.isFinite(currentStart.getTime()) || !Number.isFinite(currentEnd.getTime())) return;

  const desired = preferredWindowForItem(item, preferences);
  const currentDurationMinutes = Math.round((currentEnd.getTime() - currentStart.getTime()) / 60000);
  const currentDate = currentStart.toISOString().slice(0, 10);
  const desiredDate = desired.start.toISOString().slice(0, 10);
  const startMatches = Math.abs(currentStart.getTime() - desired.start.getTime()) <= 2 * 60_000;
  const durationMatches = Math.abs(currentDurationMinutes - item.durationMinutes) <= 2;
  if (currentDate === desiredDate && startMatches && durationMatches) return;

  try {
    await updateEvent(
      {
        event_id: event.id,
        new_title: `${emojiForTrainingSession(item.sessionType)} ${item.title} (${item.durationMinutes}min)`,
        new_start: desired.start.toISOString(),
        new_end: desired.end.toISOString(),
        new_description: appendTrainingIdentityMarker(item.description, {
          planId,
          planVersion,
          sessionId: item.sessionId,
          sessionIdentityKey: item.sessionIdentityKey,
          sessionShapeHash: item.sessionShapeHash,
        }),
      },
      event.source,
      userId,
    );
    logger.info(
      {
        userId,
        eventId: event.id,
        source: event.source,
        currentDate,
        desiredDate,
        currentDurationMinutes,
        desiredDurationMinutes: item.durationMinutes,
      },
      'syncTrainingPlanCalendar: updated same-shape training event after regeneration',
    );
  } catch (err) {
    logger.warn(
      { err, userId, eventId: event.id, source: event.source },
      'syncTrainingPlanCalendar: failed to update same-shape training event; leaving existing event linked',
    );
  }
}

function isInactiveScheduleStatus(status: string): boolean {
  return status === 'unscheduled'
    || status === 'deferred'
    || status === 'dropped'
    || status === 'cancelled'
    || status === 'superseded';
}

function preferredWindowForItem(
  item: {
    sessionType: string;
    durationMinutes: number;
    sessionDate: Date;
  },
  preferences: PlanPreferences,
): { start: Date; end: Date } {
  const preferredTime = preferredTimeForSessionType(
    item.sessionType,
    preferences.preferredTime,
    preferences.preferredCardioTime,
    preferences.preferredStrengthTime,
  );
  const [hour, minute] = preferredTime.split(':').map((value) => Number(value));
  const start = new Date(item.sessionDate);
  start.setHours(
    Number.isFinite(hour) ? hour : 12,
    Number.isFinite(minute) ? minute : 0,
    0,
    0,
  );
  const end = new Date(start.getTime() + item.durationMinutes * 60_000);
  return { start, end };
}

function normalizeTrainingEventTitle(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
