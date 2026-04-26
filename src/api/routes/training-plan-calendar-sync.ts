// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import { createEvent, getEvents } from '../../services/unified-calendar';
import {
  buildBusyWindows,
  normalizePreferredTime,
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
} from './training-schedule-utils';
import { logger } from '../../utils/logger';

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
 * don't yet have a `calendar_event_id`. This is the recovery path for
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
 * - Sessions that already have a `calendar_event_id` are reported as
 *   `sessionsAlreadySynced` and not touched (idempotent on retry).
 * - Schedule preferences are read from the plan's `preferences_json` so
 *   the times are consistent with the original generation pass.
 */
export async function syncTrainingPlanCalendar(
  userId: number,
  now: Date = new Date(),
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

  // Walk every week / session up front so we can: (a) tell the caller
  // how many sessions were already synced, (b) skip past or finished
  // sessions, and (c) decide if there's actually anything to do before
  // we go fetch busy-window data.
  type Pending = {
    sessionId: number;
    dayOfWeek: string;
    sessionType: string;
    title: string;
    durationMinutes: number;
    description: string;
    sessionDate: Date;
  };
  const pending: Pending[] = [];
  let alreadySynced = 0;
  const weeks = trainingPlans.getWeeksForPlan(plan.id);
  for (const week of weeks) {
    const sessions = trainingPlans.getSessionsForWeek(week.id);
    for (const session of sessions) {
      const status = String(session.status || '').toLowerCase();
      if (session.calendar_event_id) {
        alreadySynced += 1;
        continue;
      }
      if (status === 'completed' || status === 'skipped') continue;
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
      pending.push({
        sessionId: session.id,
        dayOfWeek: session.day_of_week,
        sessionType: session.session_type || 'training',
        title: session.title || 'Training session',
        durationMinutes: session.duration_minutes || 60,
        description: session.description || '',
        sessionDate,
      });
    }
  }

  if (pending.length === 0) {
    return {
      status: 'synced',
      data: {
        eventsCreated: 0,
        sessionsAttempted: 0,
        sessionsAlreadySynced: alreadySynced,
        sessionsFailed: 0,
        message:
          alreadySynced > 0
            ? 'Your plan is already on the calendar.'
            : 'No future sessions left to sync.',
      },
    };
  }

  // Fetch busy windows ONCE for the entire span so each scheduling pass
  // sees the same calendar state. If the calendar fetch itself throws
  // (provider still degraded), we proceed with empty busy windows — the
  // user explicitly asked for the sync and a wrong-but-present time is
  // strictly better than another silent failure.
  const earliest = pending[0].sessionDate;
  const latest = pending[pending.length - 1].sessionDate;
  const startStr = earliest.toISOString().slice(0, 10);
  const endStr = new Date(latest.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let busyWindows: BusyWindow[] = [];
  try {
    const events = await getEvents(startStr, endStr, userId);
    busyWindows = buildBusyWindows(events || []);
  } catch (err) {
    logger.debug({ err, userId }, 'syncTrainingPlanCalendar: getEvents failed — scheduling without busy-window constraints');
  }

  const scheduledWindows: BusyWindow[] = [];
  let eventsCreated = 0;
  let sessionsFailed = 0;
  let firstError: Error | null = null;

  for (const item of pending) {
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
    scheduledWindows.push({
      startMs: window.start.getTime(),
      endMs: window.end.getTime(),
      title: item.title,
    });

    try {
      const event = await createEvent(
        {
          title: `${emojiForTrainingSession(item.sessionType)} ${item.title} (${item.durationMinutes}min)`,
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          description: item.description,
        },
        undefined,
        userId,
      );
      trainingPlans.linkSessionToCalendar(item.sessionId, event.id, event.source);
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

  // Detect "no calendar provider connected" specifically — that's the
  // signal we want to give the iOS UI a clear "go reconnect" message
  // instead of a generic "some events failed" toast.
  if (eventsCreated === 0 && sessionsFailed === pending.length) {
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

  const remainingDay = pending.length - eventsCreated;
  let message: string;
  if (eventsCreated === 0) {
    message = 'Could not create any calendar events. Check your calendar connection and try again.';
  } else if (remainingDay === 0) {
    message = `${eventsCreated} ${eventsCreated === 1 ? 'session' : 'sessions'} added to your calendar.`;
  } else {
    message = `${eventsCreated} of ${pending.length} sessions added to your calendar; ${remainingDay} could not be created.`;
  }

  return {
    status: 'synced',
    data: {
      eventsCreated,
      sessionsAttempted: pending.length,
      sessionsAlreadySynced: alreadySynced,
      sessionsFailed,
      message,
    },
  };
}
