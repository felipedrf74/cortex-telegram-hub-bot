// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import { deleteEvent, getEventsForSources, updateEvent, type CalendarSource, type UnifiedCalendarEvent } from '../../services/unified-calendar';
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
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../services/secretary-live-calendar-busy';
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
  previewSecretarySchedulingIntent,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingPreview,
  type SecretarySchedulingIntent,
} from '../../services/secretary-scheduling-arbitrator';
import {
  resolveTrainingCalendarSource,
  withTrainingCalendarSourcePreference,
} from '../../services/training-calendar-source';
import { requireTenantIdParam } from '../../services/tenant-scope';
import { withTrainingCalendarOperationLock } from '../../services/training-operation-locks';
import { hashOwnerIdForLog } from './_ownership-audit';

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
        sessionResults?: TrainingCalendarSessionSyncResult[];
      };
    };

export interface TrainingCalendarSessionSyncResult {
  sessionId: number;
  title: string;
  provider: CalendarSource | null;
  eventId: string | null;
  attemptedAt: string;
  status: 'already_synced' | 'linked' | 'created' | 'failed' | 'skipped';
  reason: string;
  retryable: boolean;
  start?: string;
  end?: string;
}

export type TrainingSessionReflowPreviewResult =
  | {
      status: 'not_found' | 'forbidden' | 'no_calendar' | 'blocked' | 'calendar_degraded';
      data: {
        message: string;
        reason?: string;
        sessionId?: number;
        provider?: CalendarSource | null;
        warningCodes?: string[];
      };
    }
  | {
      status: 'preview';
      data: {
        sessionId: number;
        title: string;
        provider: CalendarSource;
        current: { start: string; end: string; dayOfWeek: string; status: string };
        proposed: { start: string; end: string; dayOfWeek: string };
        whyThisSlot: string;
        whatThisProtects: string[];
        tradeoffs: string[];
        reasonCodes: string[];
        confidence: 'low' | 'medium' | 'high';
      };
    };

export type TrainingSessionReflowConfirmResult =
  | Exclude<TrainingSessionReflowPreviewResult, { status: 'preview' }>
  | {
      status: 'confirmed' | 'partial_failure';
      data: {
        sessionId: number;
        title: string;
        provider: CalendarSource;
        eventId: string | null;
        movedFrom: { start: string; end: string; dayOfWeek: string; status: string };
        movedTo: { start: string; end: string; dayOfWeek: string };
        verified: boolean;
        message: string;
        retryable: boolean;
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

function tenantIdForTrainingPlan(plan: trainingPlans.TrainingPlan, fallbackTenantId: number): number {
  const rawTenantId = (plan as { tenant_id?: unknown }).tenant_id;
  const parsed = typeof rawTenantId === 'number' ? rawTenantId : Number(rawTenantId);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallbackTenantId;
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

type ReflowSessionScope = {
  plan: trainingPlans.TrainingPlan;
  week: trainingPlans.TrainingWeek;
  session: trainingPlans.TrainingSession;
  sessionDate: Date;
  preferences: PlanPreferences;
};

type StaleTrainingCalendarEventRef = {
  id: string;
  source: CalendarSource;
};

const TRAINING_CALENDAR_SOURCES: readonly CalendarSource[] = ['google', 'outlook'];

function resolveOwnedSessionScope(
  userId: number,
  sessionId: number,
): ReflowSessionScope | null | 'forbidden' {
  const session = trainingPlans.getSessionById(sessionId);
  if (!session) return null;
  const plan = trainingPlans.getPlanById(session.plan_id);
  if (!plan || plan.user_id !== userId) {
    if (plan) {
      logger.warn(
        { actor: userId, sessionId, ownerIdHash: hashOwnerIdForLog(plan.user_id), reason: 'foreign_owner' },
        'training_reflow.ownership_denied',
      );
    }
    return 'forbidden';
  }
  const week = trainingPlans.getWeeksForPlan(plan.id).find((candidate) => candidate.id === session.week_id);
  if (!week) return null;
  const sessionDate = sessionDateFor(new Date(plan.start_date), week.week_number, session.day_of_week);
  if (!sessionDate) return null;
  return {
    plan,
    week,
    session,
    sessionDate,
    preferences: readPlanPreferences(plan),
  };
}

async function sourceScopedBusyWindowsForReflow(input: {
  userId: number;
  source: CalendarSource;
  sessionDate: Date;
  existingEventId: string | null;
  notBefore: Date;
  searchDays: number;
}): Promise<{ events: UnifiedCalendarEvent[]; busyWindows: BusyWindow[]; searchStartDate: Date }> {
  const sessionDayStart = startOfCalendarDay(input.sessionDate);
  const nowDayStart = startOfCalendarDay(input.notBefore);
  const searchStartDate = sessionDayStart.getTime() >= nowDayStart.getTime()
    ? sessionDayStart
    : nowDayStart;
  const fetchStart = new Date(searchStartDate);
  fetchStart.setDate(fetchStart.getDate() - 1);
  const fetchEnd = new Date(searchStartDate);
  fetchEnd.setDate(fetchEnd.getDate() + Math.max(1, input.searchDays) + 1);
  const events = await getEventsForSources(
    fetchStart.toISOString().slice(0, 10),
    fetchEnd.toISOString().slice(0, 10),
    input.userId,
    [input.source],
  );
  const busyEvents = (events || []).filter((event) => event.id !== input.existingEventId);
  return {
    events,
    busyWindows: buildBusyWindows(busyEvents),
    searchStartDate,
  };
}

function startOfCalendarDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function findNextTrainingReflowWindow(input: {
  searchStartDate: Date;
  searchDays: number;
  durationMinutes: number;
  preferredTime: string;
  busyWindows: BusyWindow[];
  notBefore: Date;
}) {
  let lastBlocked: ReturnType<typeof scheduleSessionWindow> | null = null;
  for (let offset = 0; offset <= Math.max(0, input.searchDays); offset += 1) {
    const candidateDate = new Date(input.searchStartDate);
    candidateDate.setDate(candidateDate.getDate() + offset);
    const scheduled = scheduleSessionWindow(
      candidateDate,
      input.durationMinutes,
      input.preferredTime,
      input.busyWindows,
      [],
      { notBefore: input.notBefore },
    );
    if (!scheduled.noAvailableSlot) return scheduled;
    lastBlocked = scheduled;
  }
  return lastBlocked ?? scheduleSessionWindow(
    input.searchStartDate,
    input.durationMinutes,
    input.preferredTime,
    input.busyWindows,
    [],
    { notBefore: input.notBefore },
  );
}

function currentWindowForSession(
  scope: ReflowSessionScope,
  events: UnifiedCalendarEvent[],
): { start: Date; end: Date; dayOfWeek: string; status: string } {
  const linkedEvent = scope.session.calendar_event_id
    ? events.find((event) => event.id === scope.session.calendar_event_id)
    : null;
  if (linkedEvent) {
    const start = new Date(linkedEvent.start);
    const end = new Date(linkedEvent.end);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) {
      return {
        start,
        end,
        dayOfWeek: DAY_NAMES[start.getDay()],
        status: String(scope.session.status || 'scheduled'),
      };
    }
  }
  const fallback = preferredWindowForItem({
    sessionType: scope.session.session_type || 'training',
    durationMinutes: scope.session.duration_minutes || 60,
    sessionDate: scope.sessionDate,
  }, scope.preferences);
  return {
    ...fallback,
    dayOfWeek: scope.session.day_of_week,
    status: String(scope.session.status || 'scheduled'),
  };
}

function reasonCodesForReflowPreview(preferredTimeUnavailable: boolean): string[] {
  return preferredTimeUnavailable
    ? ['reflowed_to_available_window', 'preferred_time_unavailable']
    : ['scheduled_in_available_window'];
}

function reflowPreviewMessage(title: string, proposed: Date): string {
  return `${title} can move to ${proposed.toISOString()} before Nexus changes the plan or calendar.`;
}

export async function previewTrainingSessionReflow(
  userId: number,
  sessionId: number,
  requestedCalendarSource?: CalendarSource | null,
  tenantId?: number,
): Promise<TrainingSessionReflowPreviewResult> {
  const validatedTenantId = requireTenantIdParam(tenantId, 'previewTrainingSessionReflow');
  const scope = resolveOwnedSessionScope(userId, sessionId);
  if (scope === 'forbidden' || !scope) {
    return { status: 'not_found', data: { message: 'Training session not found.', sessionId } };
  }

  const effectiveTenantId = tenantIdForTrainingPlan(scope.plan, validatedTenantId);
  const calendarSource = resolveTrainingCalendarSource({
    userId,
    tenantId: effectiveTenantId,
    requestedSource: requestedCalendarSource ?? undefined,
    planPreferencesJson: scope.plan.preferences_json,
    linkedSources: [scope.session.calendar_source],
  });
  if (!calendarSource) {
    return {
      status: 'no_calendar',
      data: {
        message: 'No writable calendar provider is connected for this training session.',
        provider: null,
        sessionId,
      },
    };
  }

  const notBefore = new Date();
  const { events, busyWindows, searchStartDate } = await sourceScopedBusyWindowsForReflow({
    userId,
    source: calendarSource,
    sessionDate: scope.sessionDate,
    existingEventId: scope.session.calendar_event_id || null,
    notBefore,
    searchDays: 14,
  });
  const current = currentWindowForSession(scope, events);
  const preferredTime = preferredTimeForSessionType(
    scope.session.session_type || 'training',
    scope.preferences.preferredTime,
    scope.preferences.preferredCardioTime,
    scope.preferences.preferredStrengthTime,
  );
  const scheduled = findNextTrainingReflowWindow({
    searchStartDate,
    searchDays: 14,
    durationMinutes: scope.session.duration_minutes || 60,
    preferredTime,
    busyWindows,
    notBefore,
  });
  if (scheduled.noAvailableSlot) {
    return {
      status: 'blocked',
      data: {
        message: 'Nexus could not find a safe free slot for this training session.',
        reason: scheduled.unavailableReason || 'no_available_slot',
        provider: calendarSource,
        sessionId,
      },
    };
  }
  if (!isFutureWindow(scheduled.start, scheduled.end, notBefore)) {
    return {
      status: 'blocked',
      data: {
        message: 'Nexus could not find a future safe free slot for this training session. Refresh the recommendation and try again.',
        reason: 'no_future_slot',
        provider: calendarSource,
        sessionId,
      },
    };
  }

  const intent = buildTrainingSyncSecretaryIntent({
    userId,
    tenantId: effectiveTenantId,
    planId: scope.plan.id,
    planVersion: getPlanVersion(scope.plan.id) ?? 1,
    item: {
      sessionId: scope.session.id,
      sessionIdentityKey: scope.session.session_identity_key || buildTrainingSessionIdentityKey({
        planId: scope.plan.id,
        weekNumber: scope.week.week_number,
        dayOfWeek: scope.session.day_of_week,
        sessionType: scope.session.session_type || 'training',
        ordinal: 1,
      }),
      sessionShapeHash: scope.session.session_shape_hash || computeTrainingSessionShapeHash({
        sessionType: scope.session.session_type || 'training',
        title: scope.session.title || 'Training session',
        durationMinutes: scope.session.duration_minutes || 60,
        intensityText: scope.session.intensity_text || null,
        exercises: scope.session.exercises_json || [],
        descriptionSections: scope.session.description_json || null,
      }),
      title: scope.session.title || 'Training session',
      durationMinutes: scope.session.duration_minutes || 60,
    },
    start: scheduled.start,
    end: scheduled.end,
  });
  const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(intent);
  if (liveBusyWindows.degraded) {
    return {
      status: 'calendar_degraded',
      data: {
        message: 'Calendar availability could not be checked right now.',
        reason: 'TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED',
        provider: calendarSource,
        sessionId,
        warningCodes: liveBusyWindows.warningCodes,
      },
    };
  }
  const secretaryPreview = previewSecretarySchedulingIntent(intent, {
    now: notBefore.toISOString(),
    additionalBusyWindows: liveBusyWindows.windows,
  });
  const selected = selectedTrainingSyncSecretaryWindow(secretaryPreview, { notBefore });
  const proposedStart = selected ? new Date(selected.start) : scheduled.start;
  const proposedEnd = selected ? new Date(selected.end) : scheduled.end;
  if (!isFutureWindow(proposedStart, proposedEnd, notBefore)) {
    return {
      status: 'blocked',
      data: {
        message: 'Nexus could not find a future safe free slot for this training session. Refresh the recommendation and try again.',
        reason: 'no_future_slot',
        provider: calendarSource,
        sessionId,
      },
    };
  }

  return {
    status: 'preview',
    data: {
      sessionId,
      title: scope.session.title || 'Training session',
      provider: calendarSource,
      current: {
        start: current.start.toISOString(),
        end: current.end.toISOString(),
        dayOfWeek: current.dayOfWeek,
        status: current.status,
      },
      proposed: {
        start: proposedStart.toISOString(),
        end: proposedEnd.toISOString(),
        dayOfWeek: DAY_NAMES[proposedStart.getDay()],
      },
      whyThisSlot: reflowPreviewMessage(scope.session.title || 'Training session', proposedStart),
      whatThisProtects: ['calendar truth', 'weekly training consistency'],
      tradeoffs: scheduled.preferredTimeUnavailable
        ? ['This is outside your closest preferred time window.']
        : [],
      reasonCodes: secretaryPreview.reasonCodes.length > 0
        ? secretaryPreview.reasonCodes
        : reasonCodesForReflowPreview(scheduled.preferredTimeUnavailable),
      confidence: secretaryPreview.confidence,
    },
  };
}

export async function confirmTrainingSessionReflow(input: {
  userId: number;
  tenantId?: number;
  sessionId: number;
  proposedStartAt?: string | null;
  proposedEndAt?: string | null;
  requestedCalendarSource?: CalendarSource | null;
  signal?: AbortSignal;
}): Promise<TrainingSessionReflowConfirmResult> {
  return withTrainingCalendarOperationLock(
    {
      userId: input.userId,
      tenantId: input.tenantId ?? input.userId,
      operation: 'calendar_reflow',
    },
    () => confirmTrainingSessionReflowLocked(input),
  );
}

async function confirmTrainingSessionReflowLocked(input: {
  userId: number;
  tenantId?: number;
  sessionId: number;
  proposedStartAt?: string | null;
  proposedEndAt?: string | null;
  requestedCalendarSource?: CalendarSource | null;
  signal?: AbortSignal;
}): Promise<TrainingSessionReflowConfirmResult> {
  const validatedTenantId = requireTenantIdParam(input.tenantId, 'confirmTrainingSessionReflow');
  const preview = await previewTrainingSessionReflow(input.userId, input.sessionId, input.requestedCalendarSource, validatedTenantId);
  if (preview.status !== 'preview') return preview;

  const proposedStart = new Date(input.proposedStartAt || preview.data.proposed.start);
  const proposedEnd = new Date(input.proposedEndAt || preview.data.proposed.end);
  if (!Number.isFinite(proposedStart.getTime()) || !Number.isFinite(proposedEnd.getTime()) || proposedEnd <= proposedStart) {
    return {
      status: 'blocked',
      data: {
        message: 'The proposed reflow time is invalid.',
        reason: 'invalid_proposed_window',
        provider: preview.data.provider,
        sessionId: input.sessionId,
      },
    };
  }
  if (proposedStart.getTime() < Date.now()) {
    return {
      status: 'blocked',
      data: {
        message: 'The proposed reflow time is in the past. Refresh the recommendation and try again.',
        reason: 'proposed_window_in_past',
        provider: preview.data.provider,
        sessionId: input.sessionId,
      },
    };
  }

  const scope = resolveOwnedSessionScope(input.userId, input.sessionId);
  if (scope === 'forbidden' || !scope) {
    return { status: 'not_found', data: { message: 'Training session not found.', sessionId: input.sessionId } };
  }
  const effectiveTenantId = tenantIdForTrainingPlan(scope.plan, validatedTenantId);

  const eventPayload = {
    title: `${emojiForTrainingSession(scope.session.session_type)} ${scope.session.title || 'Training session'} (${scope.session.duration_minutes || 60}min)`,
    start: proposedStart.toISOString(),
    end: proposedEnd.toISOString(),
    description: appendTrainingIdentityMarker(scope.session.description || '', {
      planId: scope.plan.id,
      planVersion: getPlanVersion(scope.plan.id) ?? 1,
      sessionId: scope.session.id,
      sessionIdentityKey: scope.session.session_identity_key || `training:${scope.session.id}`,
      sessionShapeHash: scope.session.session_shape_hash || `shape:${scope.session.id}`,
    }),
  };

  const staleEventRef = staleLinkedEventRefForSession(scope.session, preview.data.provider);
  let eventId = scope.session.calendar_event_id || null;
  try {
    if (eventId && scope.session.calendar_source === preview.data.provider) {
      await updateEvent({
        event_id: eventId,
        new_title: eventPayload.title,
        new_start: eventPayload.start,
        new_end: eventPayload.end,
        new_description: eventPayload.description,
      }, preview.data.provider, input.userId, { signal: input.signal });
    } else {
      const created = await createTrainingCalendarEvent(eventPayload, preview.data.provider, input.userId, {
        userId: input.userId,
        tenantId: effectiveTenantId,
        sessionId: input.sessionId,
        title: scope.session.title || 'Training session',
      }, { signal: input.signal });
      eventId = created?.id || eventId;
      await deleteStaleLinkedTrainingEvent({
        userId: input.userId,
        planId: scope.plan.id,
        planVersion: getPlanVersion(scope.plan.id) ?? 1,
        sessionId: input.sessionId,
        staleEventRef,
      });
    }
  } catch (err) {
    logger.warn({ err, userId: input.userId, sessionId: input.sessionId, provider: preview.data.provider }, 'Training session reflow provider write failed');
    return {
      status: 'partial_failure',
      data: {
        sessionId: input.sessionId,
        title: preview.data.title,
        provider: preview.data.provider,
        eventId,
        movedFrom: preview.data.current,
        movedTo: preview.data.proposed,
        verified: false,
        message: `Nexus could not move ${preview.data.title} in your calendar. The session was left at its current time.`,
        retryable: true,
      },
    };
  }

  const updated = trainingPlans.updateSession(input.sessionId, {
    day_of_week: DAY_NAMES[proposedStart.getDay()],
    status: 'reflowed',
    calendar_event_id: eventId,
    calendar_source: preview.data.provider,
  });
  const readBack = trainingPlans.getSessionById(input.sessionId);
  const verified = Boolean(
    updated
    && readBack
    && readBack.day_of_week === DAY_NAMES[proposedStart.getDay()]
    && readBack.status === 'reflowed'
    && (!eventId || readBack.calendar_event_id === eventId)
  );

  if (eventId) {
    recordTrainingCalendarOwnership({
      planId: scope.plan.id,
      planVersion: getPlanVersion(scope.plan.id) ?? 1,
      sessionId: input.sessionId,
      tenantId: effectiveTenantId,
      userId: input.userId,
      eventId,
      source: preview.data.provider,
      sessionIdentityKey: scope.session.session_identity_key,
      sessionShapeHash: scope.session.session_shape_hash,
    });
  }

  return {
    status: verified ? 'confirmed' : 'partial_failure',
    data: {
      sessionId: input.sessionId,
      title: preview.data.title,
      provider: preview.data.provider,
      eventId,
      movedFrom: preview.data.current,
      movedTo: preview.data.proposed,
      verified,
      message: verified
        ? `Moved ${preview.data.title} to ${preview.data.proposed.start}.`
        : `Nexus updated what it could, but could not fully verify ${preview.data.title}.`,
      retryable: !verified,
    },
  };
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
  tenantId?: number,
): Promise<TrainingPlanCalendarSyncResult> {
  return withTrainingCalendarOperationLock(
    {
      userId,
      tenantId: tenantId ?? userId,
      operation: 'calendar_sync',
    },
    () => syncTrainingPlanCalendarLocked(userId, now, requestedCalendarSource, tenantId),
  );
}

async function syncTrainingPlanCalendarLocked(
  userId: number,
  now: Date = new Date(),
  requestedCalendarSource?: CalendarSource | null,
  tenantId?: number,
): Promise<TrainingPlanCalendarSyncResult> {
  const validatedTenantId = requireTenantIdParam(tenantId, 'syncTrainingPlanCalendar');
  const plan = trainingPlans.getActivePlan(userId, validatedTenantId);
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
  const effectiveTenantId = tenantIdForTrainingPlan(plan, validatedTenantId);

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
    status: string;
    sessionDate: Date;
    calendarEventId: string | null;
    calendarSource: string | null;
    staleLinkedEvent?: UnifiedCalendarEvent | null;
    staleEventRef?: StaleTrainingCalendarEventRef | null;
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
        status,
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
    tenantId: effectiveTenantId,
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
  let cleanupCalendarEvents: UnifiedCalendarEvent[] = [];
  let calendarFetchSucceeded = false;
  try {
    const events = await getEventsForSources(startStr, endStr, userId, [calendarSource]);
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
  try {
    const otherSources = TRAINING_CALENDAR_SOURCES.filter((source) => source !== calendarSource);
    const settled = await Promise.allSettled(otherSources.map((source) =>
      getEventsForSources(startStr, endStr, userId, [source]),
    ));
    cleanupCalendarEvents = settled.flatMap((result) =>
      result.status === 'fulfilled' ? result.value || [] : [],
    );
  } catch (err) {
    logger.debug({ err, userId, calendarSource }, 'syncTrainingPlanCalendar: duplicate cleanup provider read failed');
  }

  const scheduledWindows: BusyWindow[] = [];
  const consumedExistingEventKeys = new Set<string>();
  const pending: SyncCandidate[] = [];
  const sessionResults: TrainingCalendarSessionSyncResult[] = [];
  const attemptedAt = now.toISOString();
  let alreadySynced = 0;
  let ownershipRelinked = 0;
  for (const item of candidates) {
    const existingOwnership = findExistingOwnership({
      planId: plan.id,
      planVersion,
      sessionId: item.sessionId,
      tenantId: effectiveTenantId,
      userId,
    });
    const reusableOwnership = existingOwnership
      ? null
      : findReusableOwnershipBySessionIdentity({
        planId: plan.id,
        tenantId: effectiveTenantId,
        userId,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
    const ownershipToRelink = existingOwnership ?? reusableOwnership;

    if (!item.calendarEventId && ownershipToRelink) {
      if (ownershipToRelink.calendar_source !== calendarSource) {
        pending.push({
          ...item,
          staleEventRef: staleLinkedEventRef(
            ownershipToRelink.calendar_event_id,
            ownershipToRelink.calendar_source,
            calendarSource,
          ),
        });
        continue;
      }
      if (!calendarFetchSucceeded) {
        trainingPlans.linkSessionToCalendar(
          item.sessionId,
          ownershipToRelink.calendar_event_id,
          ownershipToRelink.calendar_source,
        );
        markSessionScheduledAfterCalendarLink(item);
        ownershipRelinked += 1;
        sessionResults.push(syncResult(item, ownershipToRelink.calendar_source as CalendarSource, 'linked', 'ownership_relinked_without_provider_read', false, ownershipToRelink.calendar_event_id, attemptedAt));
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
        markSessionScheduledAfterCalendarLink(item);
        recordTrainingCalendarOwnership({
          planId: plan.id,
          planVersion,
          sessionId: item.sessionId,
          tenantId: effectiveTenantId,
          userId,
          eventId: ownedEvent.id,
          source: ownedEvent.source,
          sessionIdentityKey: item.sessionIdentityKey,
          sessionShapeHash: item.sessionShapeHash,
        });
        await deleteDuplicateTrainingEventsForSession({
          userId,
          planId: plan.id,
          planVersion,
          item,
          keepEvent: ownedEvent,
          events: [...calendarEvents, ...cleanupCalendarEvents],
        });
        ownershipRelinked += 1;
        sessionResults.push(syncResult(item, ownedEvent.source, 'linked', 'existing_owned_event_relinked', false, ownedEvent.id, attemptedAt, ownedEvent.start, ownedEvent.end));
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

    if (isWritableCalendarSource(item.calendarSource) && item.calendarSource !== calendarSource) {
      pending.push({
        ...item,
        staleEventRef: staleLinkedEventRef(item.calendarEventId, item.calendarSource, calendarSource),
      });
      continue;
    }

    if (!calendarFetchSucceeded) {
      alreadySynced += 1;
      sessionResults.push(syncResult(item, item.calendarSource as CalendarSource | null, 'already_synced', 'provider_read_unavailable_existing_link_preserved', true, item.calendarEventId, attemptedAt));
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
        tenantId: effectiveTenantId,
        userId,
        eventId: linkedEvent.id,
        source: linkedEvent.source,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
      await deleteDuplicateTrainingEventsForSession({
        userId,
        planId: plan.id,
        planVersion,
        item,
        keepEvent: linkedEvent,
        events: [...calendarEvents, ...cleanupCalendarEvents],
      });
      markSessionScheduledAfterCalendarLink(item);
      alreadySynced += 1;
      sessionResults.push(syncResult(item, linkedEvent.source, 'already_synced', 'verified_existing_provider_event', false, linkedEvent.id, attemptedAt, linkedEvent.start, linkedEvent.end));
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
    persistPlanTrainingCalendarSourcePreference(plan, calendarSource);
    return {
      status: 'synced',
      data: {
        eventsCreated: 0,
        sessionsAttempted: 0,
        sessionsAlreadySynced: alreadySynced,
        sessionsLinked: ownershipRelinked,
        sessionsFailed: 0,
        sessionResults,
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
      markSessionScheduledAfterCalendarLink(item);
      recordTrainingCalendarOwnership({
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        tenantId: effectiveTenantId,
        userId,
        eventId: existingEvent.id,
        source: existingEvent.source,
        sessionIdentityKey: item.sessionIdentityKey,
        sessionShapeHash: item.sessionShapeHash,
      });
      sessionsLinked += 1;
      sessionResults.push(syncResult(item, existingEvent.source, 'linked', 'matching_existing_event_linked', false, existingEvent.id, attemptedAt, existingEvent.start, existingEvent.end));
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
        staleEventRef: item.staleEventRef,
      });
      await deleteDuplicateTrainingEventsForSession({
        userId,
        planId: plan.id,
        planVersion,
        item,
        keepEvent: existingEvent,
        events: [...calendarEvents, ...cleanupCalendarEvents],
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
      { notBefore: now },
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
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'no_available_slot', true, null, attemptedAt));
      continue;
    }
    let secretaryWindow: { start: string; end: string } | null = null;
    try {
      const secretaryIntent = buildTrainingSyncSecretaryIntent({
        userId,
        tenantId: effectiveTenantId,
        planId: plan.id,
        planVersion,
        item,
        start: window.start,
        end: window.end,
      });
      const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(secretaryIntent);
      if (liveBusyWindows.degraded) {
        throw new Error('TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
      }
      const secretaryPreview = previewSecretarySchedulingIntent(secretaryIntent, {
        now: now.toISOString(),
        additionalBusyWindows: liveBusyWindows.windows,
      });
      const previewWindow = selectedTrainingSyncSecretaryWindow(secretaryPreview, { notBefore: now });
      if (!previewWindow) {
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
            secretaryStatus: secretaryPreview.status,
            reasonCodes: secretaryPreview.reasonCodes,
          },
          'syncTrainingPlanCalendar: Secretary preview did not return a schedulable Training slot',
        );
        sessionResults.push(syncResult(item, calendarSource, 'failed', 'secretary_no_schedulable_slot', true, null, attemptedAt));
        continue;
      }
      const secretaryDecision = submitSecretarySchedulingIntent(secretaryIntent, {
        now: now.toISOString(),
        additionalBusyWindows: liveBusyWindows.windows,
      });
      secretaryWindow = selectedTrainingSyncSecretaryWindow(secretaryDecision, { notBefore: now });
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
        sessionResults.push(syncResult(item, calendarSource, 'failed', 'secretary_no_confirmed_slot', true, null, attemptedAt));
        continue;
      }
    } catch (err) {
      sessionsFailed += 1;
      if (!firstError) firstError = err as Error;
      logger.warn(
        { err, userId, planId: plan.id, planVersion, sessionId: item.sessionId },
        'syncTrainingPlanCalendar: Secretary scheduling intent failed for session',
      );
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'secretary_scheduling_failed', true, null, attemptedAt));
      continue;
    }
    const secretaryStart = new Date(secretaryWindow.start);
    const secretaryEnd = new Date(secretaryWindow.end);
    if (!isFutureWindow(secretaryStart, secretaryEnd, now)) {
      trainingPlans.updateSession(item.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      sessionsFailed += 1;
      logger.warn(
        { userId, planId: plan.id, planVersion, sessionId: item.sessionId, secretaryWindow },
        'syncTrainingPlanCalendar: Secretary returned a past Training slot',
      );
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'secretary_past_slot', true, null, attemptedAt));
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
          tenantId: effectiveTenantId,
          sessionId: item.sessionId,
          title: item.title,
        },
      );
      trainingPlans.linkSessionToCalendar(item.sessionId, event.id, event.source);
      markSessionScheduledAfterCalendarLink(item);
      recordTrainingCalendarOwnership({
        planId: plan.id,
        planVersion,
        sessionId: item.sessionId,
        tenantId: effectiveTenantId,
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
        staleEventRef: item.staleEventRef,
      });
      await deleteDuplicateTrainingEventsForSession({
        userId,
        planId: plan.id,
        planVersion,
        item,
        keepEvent: event,
        events: [...calendarEvents, ...cleanupCalendarEvents],
      });
      eventsCreated += 1;
      sessionResults.push(syncResult(item, event.source, 'created', 'provider_event_created', false, event.id, attemptedAt, secretaryWindow.start, secretaryWindow.end));
    } catch (err) {
      sessionsFailed += 1;
      if (!firstError) firstError = err as Error;
      logger.warn(
        { err, userId, sessionId: item.sessionId, day: item.dayOfWeek },
        'syncTrainingPlanCalendar: createEvent failed for session',
      );
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'provider_event_create_failed', true, null, attemptedAt, secretaryWindow.start, secretaryWindow.end));
    }
  }

  persistPlanTrainingCalendarSourcePreference(plan, calendarSource);

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
      sessionResults,
    },
  };
}

function syncResult(
  item: { sessionId: number; title: string },
  provider: CalendarSource | null,
  status: TrainingCalendarSessionSyncResult['status'],
  reason: string,
  retryable: boolean,
  eventId: string | null,
  attemptedAt: string,
  start?: string,
  end?: string,
): TrainingCalendarSessionSyncResult {
  return {
    sessionId: item.sessionId,
    title: item.title,
    provider,
    eventId,
    attemptedAt,
    status,
    reason,
    retryable,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

async function deleteStaleLinkedTrainingEvent(input: {
  userId: number;
  planId: number;
  planVersion: number;
  sessionId: number;
  staleEvent?: UnifiedCalendarEvent | null;
  staleEventRef?: StaleTrainingCalendarEventRef | null;
}): Promise<void> {
  const stale = input.staleEvent;
  const staleId = stale?.id || input.staleEventRef?.id || null;
  const staleSource = stale?.source || input.staleEventRef?.source || null;
  if (!staleId || !isWritableCalendarSource(staleSource)) return;

  try {
    await deleteEvent(staleId, staleSource, input.userId);
    markCalendarOwnershipDeleted({
      eventId: staleId,
      source: staleSource,
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
        staleEventId: staleId,
        source: staleSource,
      },
      'syncTrainingPlanCalendar: deleted stale linked calendar event after repair',
    );
  } catch (err) {
    markCalendarOwnershipDeleted({
      eventId: staleId,
      source: staleSource,
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
        staleEventId: staleId,
        source: staleSource,
      },
      'syncTrainingPlanCalendar: failed to delete stale linked calendar event after repair',
    );
  }
}

function isWritableCalendarSource(value: unknown): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}

function staleLinkedEventRef(
  eventId: unknown,
  source: unknown,
  replacementSource: CalendarSource,
): StaleTrainingCalendarEventRef | null {
  if (typeof eventId !== 'string' || !eventId.trim()) return null;
  if (!isWritableCalendarSource(source)) return null;
  if (source === replacementSource) return null;
  return { id: eventId, source };
}

function staleLinkedEventRefForSession(
  session: Pick<trainingPlans.TrainingSession, 'calendar_event_id' | 'calendar_source'>,
  replacementSource: CalendarSource,
): StaleTrainingCalendarEventRef | null {
  return staleLinkedEventRef(session.calendar_event_id, session.calendar_source, replacementSource);
}

function markSessionScheduledAfterCalendarLink(item: { sessionId: number; status?: string | null }): void {
  if (String(item.status || '').toLowerCase() !== 'unscheduled') return;
  trainingPlans.updateSession(item.sessionId, { status: 'scheduled' });
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

function selectedTrainingSyncSecretaryWindow(
  decision: SecretarySchedulingDecision | SecretarySchedulingPreview,
  options: { notBefore?: Date } = {},
): { start: string; end: string } | null {
  if (!['scheduled', 'reflowed', 'compressed'].includes(decision.status)) return null;
  const slot = 'selectedSlot' in decision ? decision.selectedSlot : decision.recommendedSlot;
  if (!slot?.start || !slot?.end) return null;
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (options.notBefore && start < options.notBefore.getTime()) return null;
  return { start: slot.start, end: slot.end };
}

function isFutureWindow(start: Date, end: Date, notBefore: Date): boolean {
  return Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && end > start
    && start.getTime() >= notBefore.getTime();
}

async function deleteDuplicateTrainingEventsForSession(input: {
  userId: number;
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
  };
  keepEvent: UnifiedCalendarEvent;
  events: UnifiedCalendarEvent[];
}): Promise<void> {
  const seen = new Set<string>([`${input.keepEvent.source}:${input.keepEvent.id}`]);
  for (const event of input.events) {
    if (!event.id || !isWritableCalendarSource(event.source)) continue;
    const key = `${event.source}:${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isMatchingGeneratedTrainingEvent(input.item, event, input.planId, { allowLegacyTitleMatch: false })) continue;

    try {
      await deleteEvent(event.id, event.source, input.userId);
      markCalendarOwnershipDeleted({
        eventId: event.id,
        source: event.source,
        reason: 'training_sync_deleted_duplicate_event',
        status: 'deleted',
        userId: input.userId,
        planId: input.planId,
      });
      logger.info(
        {
          userId: input.userId,
          planId: input.planId,
          planVersion: input.planVersion,
          sessionId: input.item.sessionId,
          eventId: event.id,
          source: event.source,
          keptEventId: input.keepEvent.id,
          keptSource: input.keepEvent.source,
        },
        'syncTrainingPlanCalendar: deleted duplicate generated training calendar event',
      );
    } catch (err) {
      markCalendarOwnershipDeleted({
        eventId: event.id,
        source: event.source,
        reason: 'training_sync_duplicate_delete_failed',
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
          sessionId: input.item.sessionId,
          eventId: event.id,
          source: event.source,
        },
        'syncTrainingPlanCalendar: failed to delete duplicate generated training calendar event',
      );
    }
  }
}

function consumeMatchingExistingTrainingEvent(
  item: {
    sessionId?: number;
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
    sessionId?: number;
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
  if (matchesSecretaryTrainingSourceIntent(item, planId, event.description)) {
    return true;
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

function matchesSecretaryTrainingSourceIntent(
  item: { sessionId?: number },
  planId: number,
  description: string | undefined,
): boolean {
  if (!Number.isFinite(item.sessionId) || Number(item.sessionId) <= 0) return false;
  const text = String(description || '');
  if (!/^NEXUS_SECRETARY_SOURCE_SKILL:training$/mi.test(text)) return false;
  const match = text.match(/^NEXUS_SECRETARY_SOURCE_INTENT:training:(\d+):(\d+):(\d+)$/mi);
  if (!match) return false;
  const sourcePlanId = Number(match[1]);
  const sourceSessionId = Number(match[3]);
  return sourcePlanId === planId && sourceSessionId === item.sessionId;
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
  return status === 'deferred'
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
