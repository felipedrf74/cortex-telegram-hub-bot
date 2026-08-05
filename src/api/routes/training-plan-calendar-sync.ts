// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import * as trainingPlans from '../../services/training-plans';
import { getEventsForSources, type CalendarSource, type UnifiedCalendarEvent } from '../../services/unified-calendar';
import {
  buildBusyWindows,
  normalizePreferredTime,
  preferredTimeForSessionType,
  scheduleSessionWindow,
  type BusyWindow,
} from './training-schedule-utils';
import { emojiForTrainingSession } from '../../services/training-calendar-format';
import { logger } from '../../utils/logger';
import { isTrainingCalendarEventUnclaimed } from '../../services/training-calendar-scope';
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from '../../services/secretary-live-calendar-busy';
import {
  findExistingOwnership,
  findReusableOwnershipBySessionIdentity,
  getPlanVersion,
  markCalendarOwnershipDeleted,
} from '../../services/training-plan-lifecycle';
import {
  appendTrainingIdentityMarker,
  buildTrainingSessionIdentityKey,
  computeTrainingSessionShapeHash,
  parseTrainingIdentityMarker,
} from '../../services/training-session-identity';
import {
  markSecretaryAgendaProviderCleanupRequired,
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
import {
  withTrainingCalendarOperationLock,
  type TrainingOperationLockLease,
} from '../../services/training-operation-locks';
import {
  assertLegacyPlanMutationAllowed,
  assertLegacySessionMutationAllowed,
} from '../../services/training-plan-revision-legacy-guard';
import { hashOwnerIdForLog } from './_ownership-audit';
import { DateTime } from 'luxon';
import { getUserTimezoneById } from '../../services/user-service';
import {
  normalizeTrainingTimezone,
  resolveTrainingTimezone,
} from '../../services/training-date-utils';
import {
  cleanupTrainingSecretaryCalendarHandoff,
  syncTrainingSecretaryCalendarHandoff,
} from '../../services/training-secretary-calendar-handoff';
import {
  commitTrainingCalendarSessionMapping,
  retireTrainingCalendarSessionMapping,
} from '../../services/training-calendar-link-commit';

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
      status: 'synced' | 'partial_failure';
      data: {
        eventsCreated: number;
        sessionsAttempted: number;
        sessionsAlreadySynced: number;
        sessionsLinked: number;
        sessionsFailed: number;
        degraded?: boolean;
        warnings?: string[];
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
  calendarId: string | null;
  schedulingTimezone: string;
}

function tenantIdForTrainingPlan(plan: trainingPlans.TrainingPlan, fallbackTenantId: number): number {
  const rawTenantId = (plan as { tenant_id?: unknown }).tenant_id;
  const parsed = typeof rawTenantId === 'number' ? rawTenantId : Number(rawTenantId);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallbackTenantId;
}

function readPlanPreferences(
  plan: trainingPlans.TrainingPlan,
  currentUserTimezone: string,
): PlanPreferences {
  // Defaults mirror generateTrainingPlanForUser's defaults so a plan
  // created before preferences_json was populated still gets the same
  // schedule cadence on backfill.
  const fallback: PlanPreferences = {
    preferredTime: '12:00',
    preferredCardioTime: '12:00',
    preferredStrengthTime: '12:00',
    calendarId: null,
    schedulingTimezone: resolveTrainingTimezone(currentUserTimezone),
  };
  if (!plan.preferences_json) return fallback;
  try {
    const parsed = JSON.parse(plan.preferences_json) as Record<string, unknown>;
    const trainingPlanSpec = parsed.trainingPlanSpec && typeof parsed.trainingPlanSpec === 'object'
      ? parsed.trainingPlanSpec as { calendarPreference?: { calendarId?: unknown } }
      : null;
    return {
      preferredTime: normalizePreferredTime(parsed.preferredTime, fallback.preferredTime),
      preferredCardioTime: normalizePreferredTime(parsed.preferredCardioTime, fallback.preferredCardioTime),
      preferredStrengthTime: normalizePreferredTime(parsed.preferredStrengthTime, fallback.preferredStrengthTime),
      calendarId: normalizeCalendarId(parsed.calendarId)
        ?? normalizeCalendarId(trainingPlanSpec?.calendarPreference?.calendarId),
      schedulingTimezone: normalizeTrainingTimezone(
        typeof parsed.schedulingTimezone === 'string' ? parsed.schedulingTimezone : null,
      ) ?? fallback.schedulingTimezone,
    };
  } catch {
    return fallback;
  }
}

function normalizeCalendarId(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function sessionDateFor(
  planStart: string | Date,
  weekNumber: number,
  dayOfWeek: string,
  schedulingTimezone: string,
): Date | null {
  const dayIndex = DAY_INDEX_FROM_NAME[dayOfWeek.trim().toLowerCase()];
  if (dayIndex == null) return null;
  // The original generation logic anchors week N at planStart + (N-1)*7
  // and then walks forward to the requested day-of-week. We replicate
  // that here so backfill lands the session on the SAME calendar date
  // it would have if the original createEvent hadn't failed.
  const zone = resolveTrainingTimezone(schedulingTimezone);
  const rawDate = typeof planStart === 'string'
    ? /^\d{4}-\d{2}-\d{2}/.exec(planStart)?.[0] ?? ''
    : DateTime.fromJSDate(planStart, { zone }).toISODate() ?? '';
  const weekStart = DateTime.fromISO(rawDate, { zone })
    .startOf('day')
    .plus({ weeks: weekNumber - 1 });
  if (!weekStart.isValid) return null;
  const targetWeekday = dayIndex === 0 ? 7 : dayIndex;
  const daysUntil = (targetWeekday - weekStart.weekday + 7) % 7;
  return weekStart.plus({ days: daysUntil }).toUTC().toJSDate();
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
  /** Exact Secretary authority for prior-version/session-identity reuse. */
  sourceIntentId?: string;
  /** Exact local ownership row authorized for retirement after cleanup. */
  ownershipId?: number;
};

type ExistingTrainingCalendarHandoffResult =
  | { ok: true; event: UnifiedCalendarEvent }
  | { ok: false; reasonCode: string; retryable: boolean };

type TrainingCalendarSyncCandidate = {
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
  updatedAt?: string | null;
  preferredTimeUnavailable?: number;
};

const DEFAULT_MISSING_LINK_GRACE_MS = 15 * 60 * 1000;

function resolveOwnedSessionScope(
  userId: number,
  tenantId: number,
  sessionId: number,
): ReflowSessionScope | null | 'forbidden' {
  const session = trainingPlans.getSessionById(sessionId);
  if (!session) return null;
  const plan = trainingPlans.getPlanById(session.plan_id);
  const planTenantId = plan ? tenantIdForTrainingPlan(plan, Number.NaN) : Number.NaN;
  if (!plan || plan.user_id !== userId || planTenantId !== tenantId) {
    if (plan) {
      logger.warn(
        {
          actor: userId,
          sessionId,
          ownerIdHash: hashOwnerIdForLog(plan.user_id),
          tenantId,
          ownerTenantIdHash: hashOwnerIdForLog(planTenantId),
          reason: 'foreign_owner_or_tenant',
        },
        'training_reflow.ownership_denied',
      );
    }
    return 'forbidden';
  }
  const week = trainingPlans.getWeeksForPlan(plan.id).find((candidate) => candidate.id === session.week_id);
  if (!week) return null;
  const currentUserTimezone = getUserTimezoneById(userId);
  const preferences = readPlanPreferences(plan, currentUserTimezone);
  const sessionDate = sessionDateFor(
    plan.start_date,
    week.week_number,
    session.day_of_week,
    preferences.schedulingTimezone,
  );
  if (!sessionDate) return null;
  return {
    plan,
    week,
    session,
    sessionDate,
    preferences,
  };
}

async function sourceScopedBusyWindowsForReflow(input: {
  userId: number;
  source: CalendarSource;
  sessionDate: Date;
  existingEventId: string | null;
  notBefore: Date;
  searchDays: number;
  schedulingTimezone: string;
}): Promise<{ events: UnifiedCalendarEvent[]; busyWindows: BusyWindow[]; searchStartDate: Date }> {
  const sessionDayStart = startOfCalendarDay(input.sessionDate, input.schedulingTimezone);
  const nowDayStart = startOfCalendarDay(input.notBefore, input.schedulingTimezone);
  const searchStartDate = sessionDayStart.getTime() >= nowDayStart.getTime()
    ? sessionDayStart
    : nowDayStart;
  const searchStart = DateTime.fromJSDate(searchStartDate, { zone: input.schedulingTimezone });
  const fetchStart = searchStart.minus({ days: 1 });
  const fetchEnd = searchStart.plus({ days: Math.max(1, input.searchDays) + 1 });
  const events = await getEventsForSources(
    fetchStart.toISODate() ?? '',
    fetchEnd.toISODate() ?? '',
    input.userId,
    [input.source],
  );
  const busyEvents = (events || []).filter((event) => event.id !== input.existingEventId);
  return {
    events,
    busyWindows: buildBusyWindows(busyEvents, input.schedulingTimezone),
    searchStartDate,
  };
}

function startOfCalendarDay(date: Date, schedulingTimezone: string): Date {
  return DateTime.fromJSDate(date, { zone: schedulingTimezone }).startOf('day').toUTC().toJSDate();
}

function calendarDateForInstant(date: Date, schedulingTimezone: string): string | null {
  const local = DateTime.fromJSDate(date, { zone: schedulingTimezone });
  return local.isValid ? local.toISODate() : null;
}

function weekdayNameForInstant(date: Date, schedulingTimezone: string): string {
  const local = DateTime.fromJSDate(date, { zone: schedulingTimezone }).setLocale('en-US');
  return local.isValid ? local.toFormat('cccc') : '';
}

function findNextTrainingReflowWindow(input: {
  searchStartDate: Date;
  searchDays: number;
  durationMinutes: number;
  preferredTime: string;
  busyWindows: BusyWindow[];
  notBefore: Date;
  schedulingTimezone: string;
}) {
  let lastBlocked: ReturnType<typeof scheduleSessionWindow> | null = null;
  for (let offset = 0; offset <= Math.max(0, input.searchDays); offset += 1) {
    const candidateDate = DateTime.fromJSDate(input.searchStartDate, { zone: input.schedulingTimezone })
      .plus({ days: offset })
      .startOf('day')
      .toUTC()
      .toJSDate();
    const scheduled = scheduleSessionWindow(
      candidateDate,
      input.durationMinutes,
      input.preferredTime,
      input.busyWindows,
      [],
      { notBefore: input.notBefore, timezone: input.schedulingTimezone },
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
    { notBefore: input.notBefore, timezone: input.schedulingTimezone },
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
        dayOfWeek: weekdayNameForInstant(start, scope.preferences.schedulingTimezone),
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
  const scope = resolveOwnedSessionScope(userId, validatedTenantId, sessionId);
  if (scope === 'forbidden' || !scope) {
    return { status: 'not_found', data: { message: 'Training session not found.', sessionId } };
  }
  assertLegacySessionMutationAllowed({ userId, tenantId: validatedTenantId }, sessionId);

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
    schedulingTimezone: scope.preferences.schedulingTimezone,
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
    schedulingTimezone: scope.preferences.schedulingTimezone,
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
    calendarSource,
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
        dayOfWeek: weekdayNameForInstant(proposedStart, scope.preferences.schedulingTimezone),
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
  tenantId: number;
  sessionId: number;
  proposedStartAt?: string | null;
  proposedEndAt?: string | null;
  requestedCalendarSource?: CalendarSource | null;
  signal?: AbortSignal;
}): Promise<TrainingSessionReflowConfirmResult> {
  const tenantId = requireTenantIdParam(input.tenantId, 'confirmTrainingSessionReflow');
  return withTrainingCalendarOperationLock(
    {
      userId: input.userId,
      tenantId,
      operation: 'calendar_reflow',
    },
    (lease) => confirmTrainingSessionReflowLocked(input, lease),
  );
}

async function confirmTrainingSessionReflowLocked(input: {
  userId: number;
  tenantId: number;
  sessionId: number;
  proposedStartAt?: string | null;
  proposedEndAt?: string | null;
  requestedCalendarSource?: CalendarSource | null;
  signal?: AbortSignal;
}, lease: TrainingOperationLockLease): Promise<TrainingSessionReflowConfirmResult> {
  lease.assertActive();
  const validatedTenantId = requireTenantIdParam(input.tenantId, 'confirmTrainingSessionReflow');
  const preview = await previewTrainingSessionReflow(input.userId, input.sessionId, input.requestedCalendarSource, validatedTenantId);
  lease.assertActive();
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

  const scope = resolveOwnedSessionScope(input.userId, validatedTenantId, input.sessionId);
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

  let eventId = scope.session.calendar_event_id || null;
  const exactExistingEventId = eventId && scope.session.calendar_source === preview.data.provider
    ? eventId
    : null;
  let secretaryDecision: SecretarySchedulingDecision;
  try {
    lease.assertActive();
    const secretaryIntent = buildTrainingSyncSecretaryIntent({
      userId: input.userId,
      tenantId: effectiveTenantId,
      planId: scope.plan.id,
      planVersion: getPlanVersion(scope.plan.id) ?? 1,
      calendarSource: preview.data.provider,
      item: {
        sessionId: scope.session.id,
        sessionIdentityKey: scope.session.session_identity_key || `training:${scope.session.id}`,
        sessionShapeHash: scope.session.session_shape_hash || `shape:${scope.session.id}`,
        title: scope.session.title || 'Training session',
        durationMinutes: scope.session.duration_minutes || 60,
      },
      start: proposedStart,
      end: proposedEnd,
    });
    const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(secretaryIntent);
    lease.assertActive();
    if (liveBusyWindows.degraded) {
      throw new Error('TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
    }
    secretaryDecision = submitSecretarySchedulingIntent(secretaryIntent, {
      now: new Date().toISOString(),
      additionalBusyWindows: liveBusyWindows.windows,
      ...(eventId && scope.session.calendar_source === preview.data.provider
        ? { providerMappingTransfer: { providerEventId: eventId, providerSource: preview.data.provider } }
        : {}),
    });
    lease.assertActive();
    const selectedWindow = selectedTrainingSyncSecretaryWindow(secretaryDecision, { notBefore: new Date() });
    if (!selectedWindow
        || Date.parse(selectedWindow.start) !== proposedStart.getTime()
        || Date.parse(selectedWindow.end) !== proposedEnd.getTime()) {
      throw new Error('TRAINING_REFLOW_SECRETARY_SLOT_MISMATCH');
    }
    const handoff = await syncTrainingSecretaryCalendarHandoff({
      agendaItemId: secretaryDecision.agendaItem.agendaItemId,
      ownerUserId: input.userId,
      tenantId: effectiveTenantId,
      providerSource: preview.data.provider,
      trainingProjection: {
        title: eventPayload.title,
        startAt: selectedWindow.start,
        endAt: selectedWindow.end,
        description: eventPayload.description,
        existingProviderEventId: eventId,
      },
    });
    lease.assertActive();
    if (handoff.outcome !== 'ready' || !handoff.providerEventId || !handoff.providerSource) {
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
          message: `Nexus could not verify the Secretary calendar handoff for ${preview.data.title}. No local success was recorded.`,
          retryable: handoff.retryable,
        },
      };
    }
    if (exactExistingEventId && handoff.providerEventId !== exactExistingEventId) {
      return {
        status: 'partial_failure',
        data: {
          sessionId: input.sessionId,
          title: preview.data.title,
          provider: preview.data.provider,
          eventId: exactExistingEventId,
          movedFrom: preview.data.current,
          movedTo: preview.data.proposed,
          verified: false,
          message: `Nexus rejected a mismatched provider identity while moving ${preview.data.title}.`,
          retryable: false,
        },
      };
    }
    eventId = handoff.providerEventId;
  } catch (err) {
    // Never downgrade stale lock ownership into an ordinary provider partial
    // failure; the route-level typed 409 must stop the mutation flow.
    lease.assertActive();
    logger.warn({ err, userId: input.userId, sessionId: input.sessionId, provider: preview.data.provider }, 'Training session reflow Secretary handoff failed');
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
        message: `Nexus could not verify the calendar outcome for ${preview.data.title}. No local success was recorded.`,
        retryable: true,
      },
    };
  }

  const proposedDayOfWeek = weekdayNameForInstant(
    proposedStart,
    scope.preferences.schedulingTimezone,
  );
  let verified = false;
  try {
    lease.assertActive();
    commitTrainingCalendarSessionMapping({
      sessionId: input.sessionId,
      eventId: eventId!,
      source: preview.data.provider,
      sessionPatch: {
        day_of_week: proposedDayOfWeek,
        status: 'reflowed',
        calendar_event_id: eventId,
        calendar_source: preview.data.provider,
      },
      ownership: {
        planId: scope.plan.id,
        planVersion: getPlanVersion(scope.plan.id) ?? 1,
        sessionId: input.sessionId,
        tenantId: effectiveTenantId,
        userId: input.userId,
        eventId: eventId!,
        source: preview.data.provider,
        calendarId: scope.preferences.calendarId,
        sessionIdentityKey: scope.session.session_identity_key,
        sessionShapeHash: scope.session.session_shape_hash,
      },
    });
    lease.assertActive();
    verified = true;
  } catch (localError) {
    lease.assertActive();
    if (!exactExistingEventId && eventId) {
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: input.userId,
        tenantId: effectiveTenantId,
        providerEventId: eventId,
        providerSource: preview.data.provider,
        providerSyncState: 'delete_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_reflow_local_mapping_commit_failed',
        clearProviderMapping: false,
      });
      await syncTrainingSecretaryCalendarHandoff({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: input.userId,
        tenantId: effectiveTenantId,
        providerSource: preview.data.provider,
      });
      lease.assertActive();
    }
    logger.warn(
      { err: localError, userId: input.userId, sessionId: input.sessionId },
      'Training session reflow local mapping commit failed after durable Secretary handoff',
    );
  }

  lease.assertActive();

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
  requestedCalendarSource: CalendarSource | null | undefined,
  tenantId: number,
): Promise<TrainingPlanCalendarSyncResult> {
  const validatedTenantId = requireTenantIdParam(tenantId, 'syncTrainingPlanCalendar');
  return withTrainingCalendarOperationLock(
    {
      userId,
      tenantId: validatedTenantId,
      operation: 'calendar_sync',
    },
    (lease) => syncTrainingPlanCalendarLocked(
      userId,
      now,
      requestedCalendarSource,
      validatedTenantId,
      lease,
    ),
  );
}

async function syncTrainingPlanCalendarLocked(
  userId: number,
  now: Date = new Date(),
  requestedCalendarSource: CalendarSource | null | undefined,
  tenantId: number,
  lease: TrainingOperationLockLease,
): Promise<TrainingPlanCalendarSyncResult> {
  lease.assertActive();
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
  assertLegacyPlanMutationAllowed({ userId, tenantId: validatedTenantId }, plan.id);

  const currentUserTimezone = getUserTimezoneById(userId);
  const preferences = readPlanPreferences(plan, currentUserTimezone);
  const planVersion = getPlanVersion(plan.id) ?? 1;
  const effectiveTenantId = tenantIdForTrainingPlan(plan, validatedTenantId);

  // Walk every week / session up front so we can skip past or finished
  // sessions, then verify existing calendar links against the provider.
  const candidates: TrainingCalendarSyncCandidate[] = [];
  const weeks = trainingPlans.getWeeksForPlan(plan.id);
  for (const week of weeks) {
    const sessions = trainingPlans.getSessionsForWeek(week.id);
    const ordinals = new Map<string, number>();
    for (const session of sessions) {
      const status = String(session.status || '').toLowerCase();
      if (status === 'completed' || status === 'skipped' || isInactiveScheduleStatus(status)) continue;
      const sessionType = String(session.session_type || '').toLowerCase();
      if (sessionType === 'rest') continue;
      const sessionDate = sessionDateFor(
        plan.start_date,
        week.week_number,
        session.day_of_week,
        preferences.schedulingTimezone,
      );
      if (!sessionDate) continue;
      // Only sync today and forward — don't put past workouts on the calendar.
      const dayStart = startOfCalendarDay(sessionDate, preferences.schedulingTimezone);
      const todayStart = startOfCalendarDay(now, preferences.schedulingTimezone);
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
        updatedAt: session.updated_at || null,
        preferredTimeUnavailable: Number(session.preferred_time_unavailable || 0),
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
  const startStr = calendarDateForInstant(earliest, preferences.schedulingTimezone) ?? '';
  const endStr = DateTime.fromJSDate(latest, { zone: preferences.schedulingTimezone })
    .plus({ days: 1 })
    .toISODate() ?? startStr;
  let busyWindows: BusyWindow[] = [];
  let calendarEvents: UnifiedCalendarEvent[] = [];
  let calendarFetchSucceeded = false;
  const warnings: string[] = [];
  try {
    lease.assertActive();
    const events = await getEventsForSources(startStr, endStr, userId, [calendarSource]);
    lease.assertActive();
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
    ), preferences.schedulingTimezone);
    calendarFetchSucceeded = true;
  } catch (err) {
    lease.assertActive();
    logger.debug({ err, userId }, 'syncTrainingPlanCalendar: getEvents failed — scheduling without busy-window constraints');
    warnings.push('calendar_provider_read_unavailable');
  }
  const scheduledWindows: BusyWindow[] = [];
  const consumedExistingEventKeys = new Set<string>();
  const pending: TrainingCalendarSyncCandidate[] = [];
  const sessionResults: TrainingCalendarSessionSyncResult[] = [];
  const attemptedAt = now.toISOString();
  let alreadySynced = 0;
  let ownershipRelinked = 0;
  let sessionsFailed = 0;
  for (const item of candidates) {
    lease.assertActive();
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
          currentPlanVersion: planVersion,
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
            {
              sourceIntentId: `training:${plan.id}:${ownershipToRelink.plan_version}:${ownershipToRelink.session_id ?? item.sessionId}`,
              ownershipId: ownershipToRelink.id,
            },
          ),
        });
        continue;
      }
      if (!calendarFetchSucceeded) {
        lease.assertActive();
        try {
          commitTrainingCalendarSessionMapping({
            sessionId: item.sessionId,
            eventId: ownershipToRelink.calendar_event_id,
            source: ownershipToRelink.calendar_source as CalendarSource,
            sessionPatch: String(item.status || '').toLowerCase() === 'unscheduled'
              ? { status: 'scheduled' }
              : undefined,
            ownership: {
              planId: plan.id,
              planVersion,
              sessionId: item.sessionId,
              tenantId: effectiveTenantId,
              userId,
              eventId: ownershipToRelink.calendar_event_id,
              source: ownershipToRelink.calendar_source,
              calendarId: preferences.calendarId,
              sessionIdentityKey: item.sessionIdentityKey,
              sessionShapeHash: item.sessionShapeHash,
            },
          });
        } catch {
          pending.push(item);
          continue;
        }
        ownershipRelinked += 1;
        sessionResults.push(syncResult(item, ownershipToRelink.calendar_source as CalendarSource, 'linked', 'ownership_relinked_without_provider_read', false, ownershipToRelink.calendar_event_id, attemptedAt));
        continue;
      }

      const ownedEvent = calendarEvents.find((event) =>
        event.id === ownershipToRelink.calendar_event_id
        && event.source === ownershipToRelink.calendar_source
      );
      if (ownedEvent && isMatchingGeneratedTrainingEvent(item, ownedEvent, plan.id, {
        allowLegacyTitleMatch: true,
        schedulingTimezone: preferences.schedulingTimezone,
      })) {
        lease.assertActive();
        const existingHandoff = await handoffExistingTrainingCalendarEvent({
          userId,
          tenantId: effectiveTenantId,
          planId: plan.id,
          planVersion,
          item,
          event: ownedEvent,
          preferences,
          now,
          additionalBusyWindows: busyWindows,
        });
        lease.assertActive();
        if (!existingHandoff.ok) {
          sessionsFailed += 1;
          sessionResults.push(syncResult(
            item,
            ownedEvent.source,
            'failed',
            existingHandoff.reasonCode,
            existingHandoff.retryable,
            ownedEvent.id,
            attemptedAt,
          ));
          continue;
        }
        const durableEvent = existingHandoff.event;
        commitTrainingCalendarSessionMapping({
          sessionId: item.sessionId,
          eventId: durableEvent.id,
          source: durableEvent.source,
          sessionPatch: calendarLinkedSessionPatch(item, durableEvent.start, preferences),
          ownership: {
            planId: plan.id,
            planVersion,
            sessionId: item.sessionId,
            tenantId: effectiveTenantId,
            userId,
            eventId: durableEvent.id,
            source: durableEvent.source,
            calendarId: preferences.calendarId,
            sessionIdentityKey: item.sessionIdentityKey,
            sessionShapeHash: item.sessionShapeHash,
          },
        });
        ownershipRelinked += 1;
        sessionResults.push(syncResult(item, durableEvent.source, 'linked', 'existing_owned_event_relinked', false, durableEvent.id, attemptedAt, durableEvent.start, durableEvent.end));
        const eventStart = new Date(durableEvent.start);
        const eventEnd = new Date(durableEvent.end);
        if (Number.isFinite(eventStart.getTime()) && Number.isFinite(eventEnd.getTime())) {
          scheduledWindows.push({
            startMs: eventStart.getTime(),
            endMs: eventEnd.getTime(),
            title: item.title,
          });
          consumedExistingEventKeys.add(`${durableEvent.source}:${durableEvent.id}`);
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
        staleEventRef: staleLinkedEventRef(
          item.calendarEventId,
          item.calendarSource,
          calendarSource,
          {
            sourceIntentId: `training:${plan.id}:${planVersion}:${item.sessionId}`,
            ...(existingOwnership
              && existingOwnership.calendar_event_id === item.calendarEventId
              && existingOwnership.calendar_source === item.calendarSource
              ? { ownershipId: existingOwnership.id }
              : {}),
          },
        ),
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
    if (linkedEvent && isMatchingGeneratedTrainingEvent(item, linkedEvent, plan.id, {
      allowLegacyTitleMatch: true,
      schedulingTimezone: preferences.schedulingTimezone,
    })) {
      lease.assertActive();
      const existingHandoff = await handoffExistingTrainingCalendarEvent({
        userId,
        tenantId: effectiveTenantId,
        planId: plan.id,
        planVersion,
        item,
        event: linkedEvent,
        preferences,
        now,
        additionalBusyWindows: busyWindows,
      });
      lease.assertActive();
      if (!existingHandoff.ok) {
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          linkedEvent.source,
          'failed',
          existingHandoff.reasonCode,
          existingHandoff.retryable,
          linkedEvent.id,
          attemptedAt,
        ));
        continue;
      }
      const durableEvent = existingHandoff.event;
      commitTrainingCalendarSessionMapping({
        sessionId: item.sessionId,
        eventId: durableEvent.id,
        source: durableEvent.source,
        sessionPatch: calendarLinkedSessionPatch(item, durableEvent.start, preferences),
        ownership: {
          planId: plan.id,
          planVersion,
          sessionId: item.sessionId,
          tenantId: effectiveTenantId,
          userId,
          eventId: durableEvent.id,
          source: durableEvent.source,
          calendarId: preferences.calendarId,
          sessionIdentityKey: item.sessionIdentityKey,
          sessionShapeHash: item.sessionShapeHash,
        },
      });
      alreadySynced += 1;
      sessionResults.push(syncResult(item, durableEvent.source, 'already_synced', 'verified_existing_provider_event', false, durableEvent.id, attemptedAt, durableEvent.start, durableEvent.end));
      const eventStart = new Date(durableEvent.start);
      const eventEnd = new Date(durableEvent.end);
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

    if (
      item.calendarEventId
      && item.calendarSource === calendarSource
      && isRecentCalendarLink(item, now)
    ) {
      sessionsFailed += 1;
      sessionResults.push(syncResult(
        item,
        calendarSource,
        'failed',
        'provider_read_missing_recent_link_unverified',
        true,
        item.calendarEventId,
        attemptedAt,
      ));
      logger.warn(
        {
          userId,
          sessionId: item.sessionId,
          calendarEventId: item.calendarEventId,
          calendarSource: item.calendarSource,
          reason: 'missing_recent_link_preserved',
        },
        'syncTrainingPlanCalendar: preserving fresh calendar link while provider read catches up',
      );
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
    lease.assertActive();
    persistPlanTrainingCalendarSourcePreference(plan, calendarSource);
    const failureReasons = sessionResults
      .filter((result) => result.status === 'failed')
      .map((result) => result.reason);
    const summaryWarnings = [...new Set([...warnings, ...failureReasons])];
    const degraded = summaryWarnings.length > 0;
    return {
      status: sessionsFailed > 0 ? 'partial_failure' : 'synced',
      data: {
        eventsCreated: 0,
        sessionsAttempted: sessionsFailed,
        sessionsAlreadySynced: alreadySynced,
        sessionsLinked: ownershipRelinked,
        sessionsFailed,
        sessionResults,
        degraded,
        warnings: degraded ? summaryWarnings : undefined,
        message:
          sessionsFailed > 0
            ? `${sessionsFailed} existing calendar ${sessionsFailed === 1 ? 'link could' : 'links could'} not be verified; retry the sync.`
            : ownershipRelinked > 0
            ? `${ownershipRelinked} existing ${ownershipRelinked === 1 ? 'session was' : 'sessions were'} linked to your calendar.`
            : alreadySynced > 0
            ? 'Your plan is already on the calendar.'
            : 'No future sessions left to sync.',
      },
    };
  }

  let eventsCreated = 0;
  let sessionsLinked = ownershipRelinked;
  const failuresBeforePending = sessionsFailed;
  let firstError: Error | null = null;

  for (const item of pending) {
    lease.assertActive();
    const staleProviderEventId = item.staleLinkedEvent?.id ?? item.staleEventRef?.id ?? null;
    const staleProviderSource = item.staleLinkedEvent?.source ?? item.staleEventRef?.source ?? null;
    if (staleProviderEventId && isWritableCalendarSource(staleProviderSource)) {
      const suppliedOwnershipId = item.staleEventRef?.ownershipId;
      const currentOwnership = suppliedOwnershipId == null
        ? findExistingOwnership({
            planId: plan.id,
            planVersion,
            sessionId: item.sessionId,
            tenantId: effectiveTenantId,
            userId,
          })
        : null;
      const exactOwnershipId = Number.isInteger(suppliedOwnershipId)
          && Number(suppliedOwnershipId) > 0
        ? Number(suppliedOwnershipId)
        : currentOwnership
          && currentOwnership.calendar_event_id === staleProviderEventId
          && currentOwnership.calendar_source === staleProviderSource
          ? currentOwnership.id
          : null;
      if (exactOwnershipId == null) {
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          staleProviderSource,
          'failed',
          'training_calendar_ownership_delete_fence_failed',
          true,
          staleProviderEventId,
          attemptedAt,
        ));
        continue;
      }
      let cleanupSourceIntentId = item.staleEventRef?.sourceIntentId
        ?? `training:${plan.id}:${planVersion}:${item.sessionId}`;
      let cleanup = await cleanupTrainingSecretaryCalendarHandoff({
        sourceIntentId: cleanupSourceIntentId,
        ownerUserId: userId,
        tenantId: effectiveTenantId,
        providerEventId: staleProviderEventId,
        providerSource: staleProviderSource,
        reason: 'training_sync_replaced_stale_provider',
        nowIso: attemptedAt,
      });
      if (cleanup.outcome === 'pending'
          && cleanup.reasonCode === 'secretary_stale_provider_mapping_authority_missing') {
        // Legacy/pre-handoff or prior-version ownership can exist before a
        // Secretary agenda mapping. Seed the exact old id through the guarded
        // adoption contract, then cleanup under the current intent. This does
        // not update or create provider state.
        const adoptionWindow = preferredWindowForItem(item, preferences);
        const adoptionIntent = buildTrainingSyncSecretaryIntent({
          userId,
          tenantId: effectiveTenantId,
          planId: plan.id,
          planVersion,
          calendarSource: staleProviderSource,
          item,
          start: adoptionWindow.start,
          end: adoptionWindow.end,
        });
        submitSecretarySchedulingIntent(adoptionIntent, {
          now: attemptedAt,
          additionalBusyWindows: [],
          providerMappingTransfer: {
            providerEventId: staleProviderEventId,
            providerSource: staleProviderSource,
          },
        });
        cleanupSourceIntentId = adoptionIntent.intentId;
        cleanup = await cleanupTrainingSecretaryCalendarHandoff({
          sourceIntentId: cleanupSourceIntentId,
          ownerUserId: userId,
          tenantId: effectiveTenantId,
          providerEventId: staleProviderEventId,
          providerSource: staleProviderSource,
          reason: 'training_sync_replaced_stale_provider',
          nowIso: attemptedAt,
        });
      }
      lease.assertActive();
      if (cleanup.outcome !== 'cleanup_complete') {
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          staleProviderSource,
          'failed',
          cleanup.reasonCode,
          cleanup.retryable,
          staleProviderEventId,
          attemptedAt,
        ));
        continue;
      }
      try {
        retireTrainingCalendarSessionMapping({
          sessionId: item.sessionId,
          eventId: staleProviderEventId,
          source: staleProviderSource,
          planId: plan.id,
          tenantId: effectiveTenantId,
          userId,
          ownershipId: exactOwnershipId,
          reason: 'training_sync_replaced_stale_event',
          allowAlreadyUnlinked: !item.calendarEventId && !item.calendarSource,
          secretaryTombstone: {
            agendaItemId: cleanup.agendaItemId,
            now: attemptedAt,
          },
        });
      } catch (error) {
        sessionsFailed += 1;
        if (!firstError) firstError = error as Error;
        sessionResults.push(syncResult(
          item,
          staleProviderSource,
          'failed',
          'training_calendar_ownership_delete_fence_failed',
          true,
          staleProviderEventId,
          attemptedAt,
        ));
        continue;
      }
      lease.assertActive();
    }
    const existingEvent = consumeMatchingExistingTrainingEvent(
      item,
      plan.id,
      calendarEvents,
      consumedExistingEventKeys,
      calendarSource,
      effectiveTenantId,
      preferences.schedulingTimezone,
    );
    if (existingEvent) {
      lease.assertActive();
      const existingHandoff = await handoffExistingTrainingCalendarEvent({
        userId,
        tenantId: effectiveTenantId,
        planId: plan.id,
        planVersion,
        item,
        event: existingEvent,
        preferences,
        now,
        additionalBusyWindows: busyWindows,
      });
      lease.assertActive();
      if (!existingHandoff.ok) {
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          existingEvent.source,
          'failed',
          existingHandoff.reasonCode,
          existingHandoff.retryable,
          existingEvent.id,
          attemptedAt,
        ));
        continue;
      }
      const durableEvent = existingHandoff.event;
      commitTrainingCalendarSessionMapping({
        sessionId: item.sessionId,
        eventId: durableEvent.id,
        source: durableEvent.source,
        sessionPatch: calendarLinkedSessionPatch(item, durableEvent.start, preferences),
        ownership: {
          planId: plan.id,
          planVersion,
          sessionId: item.sessionId,
          tenantId: effectiveTenantId,
          userId,
          eventId: durableEvent.id,
          source: durableEvent.source,
          calendarId: preferences.calendarId,
          sessionIdentityKey: item.sessionIdentityKey,
          sessionShapeHash: item.sessionShapeHash,
        },
      });
      sessionsLinked += 1;
      sessionResults.push(syncResult(item, durableEvent.source, 'linked', 'matching_existing_event_linked', false, durableEvent.id, attemptedAt, durableEvent.start, durableEvent.end));
      const eventStart = new Date(durableEvent.start);
      const eventEnd = new Date(durableEvent.end);
      if (Number.isFinite(eventStart.getTime()) && Number.isFinite(eventEnd.getTime())) {
        scheduledWindows.push({
          startMs: eventStart.getTime(),
          endMs: eventEnd.getTime(),
          title: item.title,
        });
      }
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
      { notBefore: now, timezone: preferences.schedulingTimezone },
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
    let secretaryDecision: SecretarySchedulingDecision | null = null;
    try {
      lease.assertActive();
      const secretaryIntent = buildTrainingSyncSecretaryIntent({
        userId,
        tenantId: effectiveTenantId,
        planId: plan.id,
        planVersion,
        calendarSource,
        item,
        start: window.start,
        end: window.end,
      });
      const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(secretaryIntent);
      lease.assertActive();
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
      secretaryDecision = submitSecretarySchedulingIntent(secretaryIntent, {
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
      lease.assertActive();
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
    if (!secretaryDecision?.agendaItem?.agendaItemId) {
      sessionsFailed += 1;
      logger.warn(
        { userId, planId: plan.id, planVersion, sessionId: item.sessionId },
        'syncTrainingPlanCalendar: Secretary decision missing agenda item after confirmed slot',
      );
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'secretary_agenda_item_missing', true, null, attemptedAt));
      continue;
    }

    scheduledWindows.push({
      startMs: Date.parse(secretaryWindow.start),
      endMs: Date.parse(secretaryWindow.end),
      title: item.title,
    });

    try {
      lease.assertActive();
      const projectedEvent = {
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
      };
      const handoff = await syncTrainingSecretaryCalendarHandoff({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId: effectiveTenantId,
        providerSource: calendarSource,
        trainingProjection: {
          title: projectedEvent.title,
          startAt: projectedEvent.start,
          endAt: projectedEvent.end,
          description: projectedEvent.description,
        },
      });
      lease.assertActive();
      if (handoff.outcome !== 'ready' || !handoff.providerEventId || !handoff.providerSource) {
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          handoff.providerSource ?? calendarSource,
          'failed',
          handoff.reasonCode,
          handoff.retryable,
          null,
          attemptedAt,
          secretaryWindow.start,
          secretaryWindow.end,
        ));
        continue;
      }
      const event = {
        id: handoff.providerEventId,
        source: handoff.providerSource,
        start: handoff.startAt ?? secretaryWindow.start,
        end: handoff.endAt ?? secretaryWindow.end,
      };
      try {
        commitTrainingCalendarSessionMapping({
          sessionId: item.sessionId,
          eventId: event.id,
          source: event.source,
          sessionPatch: calendarLinkedSessionPatch(item, event.start, preferences),
          ownership: {
            planId: plan.id,
            planVersion,
            sessionId: item.sessionId,
            tenantId: effectiveTenantId,
            userId,
            eventId: event.id,
            source: event.source,
            calendarId: preferences.calendarId,
            sessionIdentityKey: item.sessionIdentityKey,
            sessionShapeHash: item.sessionShapeHash,
          },
        });
      } catch (localCommitError) {
        // Ownership recording is an infrastructure failure (e.g. SQLITE_BUSY),
        // not a scheduling verdict: clear the calendar linkage but keep the
        // session's schedulable status so the next sync retries it — a
        // demotion to 'unscheduled' would drop it from candidate selection
        // permanently while the payload claims retryable:true.
        markSecretaryAgendaProviderCleanupRequired({
          agendaItemId: secretaryDecision.agendaItem.agendaItemId,
          ownerUserId: userId,
          tenantId: effectiveTenantId,
          providerEventId: event.id,
          providerSource: event.source,
          providerSyncState: 'delete_failed',
          lifecycleState: 'unscheduled',
          reason: 'training_provider_ownership_record_failed',
          clearProviderMapping: false,
          now: attemptedAt,
        });
        lease.assertActive();
        const cleanup = await syncTrainingSecretaryCalendarHandoff({
          agendaItemId: secretaryDecision.agendaItem.agendaItemId,
          ownerUserId: userId,
          tenantId: effectiveTenantId,
          providerSource: event.source,
        });
        sessionsFailed += 1;
        sessionResults.push(syncResult(
          item,
          event.source,
          'failed',
          'training_calendar_ownership_record_failed',
          true,
          cleanup.outcome === 'cleanup_complete' ? null : event.id,
          attemptedAt,
          secretaryWindow.start,
          secretaryWindow.end,
        ));
        continue;
      }
      eventsCreated += 1;
      sessionResults.push(syncResult(item, event.source, 'created', 'provider_event_created', false, event.id, attemptedAt, secretaryWindow.start, secretaryWindow.end));
    } catch (err) {
      lease.assertActive();
      sessionsFailed += 1;
      if (!firstError) firstError = err as Error;
      logger.warn(
        { err, userId, sessionId: item.sessionId, day: item.dayOfWeek },
        'syncTrainingPlanCalendar: createEvent failed for session',
      );
      sessionResults.push(syncResult(item, calendarSource, 'failed', 'provider_event_create_failed', true, null, attemptedAt, secretaryWindow.start, secretaryWindow.end));
    }
  }

  lease.assertActive();
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
  let message: string;
  if (resolvedCount === 0) {
    message = 'Could not sync any calendar sessions. Check your calendar connection and try again.';
  } else if (sessionsFailed > 0) {
    message = `${resolvedCount} ${resolvedCount === 1 ? 'session was' : 'sessions were'} synced; ${sessionsFailed} ${sessionsFailed === 1 ? 'session needs' : 'sessions need'} retry.`;
  } else if (resolvedPendingCount === pending.length && eventsCreated === 0) {
    message = `${sessionsLinked} existing ${sessionsLinked === 1 ? 'session was' : 'sessions were'} linked to your calendar.`;
  } else if (resolvedPendingCount === pending.length && sessionsLinked === 0) {
    message = `${eventsCreated} ${eventsCreated === 1 ? 'session' : 'sessions'} added to your calendar.`;
  } else if (resolvedPendingCount === pending.length) {
    message = `${resolvedCount} ${resolvedCount === 1 ? 'session' : 'sessions'} synced to your calendar.`;
  } else {
    // Defensive fallback: every unresolved pending session should already be
    // represented in sessionsFailed, but never fabricate a full-success copy.
    message = `${resolvedCount} sessions synced; some sessions still need retry.`;
  }

  const failureReasons = sessionResults
    .filter((result) => result.status === 'failed')
    .map((result) => result.reason);
  const summaryWarnings = [...new Set([...warnings, ...failureReasons])];
  return {
    status: sessionsFailed > 0 ? 'partial_failure' : 'synced',
    data: {
      eventsCreated,
      sessionsAttempted: pending.length + failuresBeforePending,
      sessionsAlreadySynced: alreadySynced,
      sessionsLinked,
      sessionsFailed,
      degraded: summaryWarnings.length > 0,
      warnings: summaryWarnings.length > 0 ? summaryWarnings : undefined,
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

function isWritableCalendarSource(value: unknown): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}

function staleLinkedEventRef(
  eventId: unknown,
  source: unknown,
  replacementSource: CalendarSource,
  authority: { sourceIntentId?: string; ownershipId?: number } = {},
): StaleTrainingCalendarEventRef | null {
  if (typeof eventId !== 'string' || !eventId.trim()) return null;
  if (!isWritableCalendarSource(source)) return null;
  if (source === replacementSource) return null;
  return { id: eventId, source, ...authority };
}

function calendarLinkedSessionPatch(
  item: {
    sessionId: number;
    sessionType: string;
    durationMinutes: number;
    status?: string | null;
    preferredTimeUnavailable?: number;
  },
  eventStart: string | undefined,
  preferences: PlanPreferences,
): Parameters<typeof trainingPlans.updateSession>[1] | undefined {
  const updates: Parameters<typeof trainingPlans.updateSession>[1] = {};
  if (String(item.status || '').toLowerCase() === 'unscheduled') {
    updates.status = 'scheduled';
  }
  const shifted = eventStart
    ? !calendarEventStartMatchesPreferredTime(item, eventStart, preferences)
    : Boolean(item.preferredTimeUnavailable);
  if (Number(item.preferredTimeUnavailable || 0) !== (shifted ? 1 : 0)) {
    updates.preferred_time_unavailable = shifted ? 1 : 0;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
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
  calendarSource?: CalendarSource | null;
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
    providerTarget: input.calendarSource ?? null,
    softPreferences: input.calendarSource ? { calendarProvider: input.calendarSource } : undefined,
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

async function handoffExistingTrainingCalendarEvent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  item: TrainingCalendarSyncCandidate;
  event: UnifiedCalendarEvent;
  preferences: PlanPreferences;
  now: Date;
  additionalBusyWindows: BusyWindow[];
}): Promise<ExistingTrainingCalendarHandoffResult> {
  if (!isWritableCalendarSource(input.event.source)) {
    return { ok: false, reasonCode: 'secretary_existing_provider_source_invalid', retryable: false };
  }
  const currentStart = new Date(input.event.start);
  const currentEnd = new Date(input.event.end);
  if (!Number.isFinite(currentStart.getTime()) || !Number.isFinite(currentEnd.getTime())) {
    return { ok: false, reasonCode: 'secretary_existing_provider_window_invalid', retryable: false };
  }
  const preferred = preferredWindowForItem(input.item, input.preferences);
  const usePreferred = Number(input.item.preferredTimeUnavailable || 0) !== 1;
  const start = usePreferred ? preferred.start : currentStart;
  const end = usePreferred ? preferred.end : currentEnd;
  const intent = buildTrainingSyncSecretaryIntent({
    userId: input.userId,
    tenantId: input.tenantId,
    planId: input.planId,
    planVersion: input.planVersion,
    calendarSource: input.event.source,
    item: input.item,
    start,
    end,
  });
  const decision = submitSecretarySchedulingIntent(intent, {
    now: input.now.toISOString(),
    additionalBusyWindows: input.additionalBusyWindows.map((window) => ({
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
      label: window.title,
    })),
    providerMappingTransfer: {
      providerEventId: input.event.id,
      providerSource: input.event.source,
    },
  });
  const selected = selectedTrainingSyncSecretaryWindow(decision, { notBefore: input.now });
  if (!selected) {
    return { ok: false, reasonCode: 'secretary_existing_event_no_schedulable_slot', retryable: true };
  }
  const title = `${emojiForTrainingSession(input.item.sessionType)} ${input.item.title} (${input.item.durationMinutes}min)`;
  const description = appendTrainingIdentityMarker(input.item.description, {
    planId: input.planId,
    planVersion: input.planVersion,
    sessionId: input.item.sessionId,
    sessionIdentityKey: input.item.sessionIdentityKey,
    sessionShapeHash: input.item.sessionShapeHash,
  });
  const handoff = await syncTrainingSecretaryCalendarHandoff({
    agendaItemId: decision.agendaItem.agendaItemId,
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    providerSource: input.event.source,
    trainingProjection: {
      title,
      startAt: selected.start,
      endAt: selected.end,
      description,
      existingProviderEventId: input.event.id,
    },
  });
  if (handoff.outcome !== 'ready') {
    return {
      ok: false,
      reasonCode: handoff.reasonCode,
      retryable: handoff.retryable,
    };
  }
  if (handoff.providerEventId !== input.event.id
      || handoff.providerSource !== input.event.source) {
    return {
      ok: false,
      reasonCode: 'secretary_existing_provider_identity_mismatch',
      retryable: false,
    };
  }
  return {
    ok: true,
    event: {
      ...input.event,
      start: handoff.startAt ?? selected.start,
      end: handoff.endAt ?? selected.end,
    },
  };
}

function isFutureWindow(start: Date, end: Date, notBefore: Date): boolean {
  return Number.isFinite(start.getTime())
    && Number.isFinite(end.getTime())
    && end > start
    && start.getTime() >= notBefore.getTime();
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
  tenantId: number,
  schedulingTimezone: string,
): UnifiedCalendarEvent | null {
  for (const event of events) {
    if (event.source !== calendarSource) continue;
    const key = `${event.source}:${event.id}`;
    if (consumedKeys.has(key)) continue;
    if (!isMatchingGeneratedTrainingEvent(item, event, planId, {
      allowLegacyTitleMatch: false,
      schedulingTimezone,
    })) continue;
    if (!isTrainingCalendarEventUnclaimed(event.id, event.source, tenantId)) continue;
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
  options: { allowLegacyTitleMatch: boolean; schedulingTimezone: string },
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
  const eventDate = calendarDateForInstant(eventStart, options.schedulingTimezone);
  const sessionDate = calendarDateForInstant(item.sessionDate, options.schedulingTimezone);
  if (!eventDate || eventDate !== sessionDate) return false;

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
  const sessionDay = DateTime.fromJSDate(item.sessionDate, {
    zone: preferences.schedulingTimezone,
  });
  const startLocal = DateTime.fromObject(
    {
      year: sessionDay.year,
      month: sessionDay.month,
      day: sessionDay.day,
      hour: Number.isFinite(hour) ? hour : 12,
      minute: Number.isFinite(minute) ? minute : 0,
      second: 0,
      millisecond: 0,
    },
    { zone: preferences.schedulingTimezone },
  );
  const start = startLocal.toUTC().toJSDate();
  const end = startLocal.plus({ minutes: item.durationMinutes }).toUTC().toJSDate();
  return { start, end };
}

function isRecentCalendarLink(
  item: { updatedAt?: string | null; calendarEventId?: string | null },
  now: Date,
): boolean {
  if (!item.calendarEventId || !item.updatedAt) return false;
  const updated = Date.parse(item.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now.getTime() - updated <= missingLinkedEventGraceMs();
}

function missingLinkedEventGraceMs(): number {
  const raw = Number(process.env.TRAINING_CALENDAR_MISSING_LINK_GRACE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MISSING_LINK_GRACE_MS;
  return Math.floor(raw);
}

function calendarEventStartMatchesPreferredTime(
  item: { sessionType: string; durationMinutes: number },
  eventStart: string,
  preferences: PlanPreferences,
): boolean {
  const preferredTime = preferredTimeForSessionType(
    item.sessionType,
    preferences.preferredTime,
    preferences.preferredCardioTime,
    preferences.preferredStrengthTime,
  );
  const local = DateTime.fromISO(eventStart, { setZone: true })
    .setZone(preferences.schedulingTimezone);
  return local.isValid && local.toFormat('HH:mm') === preferredTime;
}

function normalizeTrainingEventTitle(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
