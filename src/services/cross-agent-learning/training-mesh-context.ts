// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Training mesh adapter. */

import { DateTime } from 'luxon';
import type { MeshPriority, SignalPriority } from '../intelligence-bus';
import { getLatestByType } from '../report-document-store';
import { getCurrentCoachPhase } from '../coach-phase-memory';
import { readTrainingContextAll, type TrainingContext } from '../training-signals';
import {
  listCurrentTrainingSecretaryFeedbackDecisionsForPlan,
  type TrainingSecretaryFeedbackDecision,
} from '../training-secretary-feedback-consumer';
import { filterKnownReasonCodes } from '../secretary-reason-codes';
import {
  getActivePlans,
  getLatestCompletionForPlan,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingCompletion,
  type TrainingSession,
  type TrainingWeek,
} from '../training-plans';
import { resolveTrainingPlanTimezone, resolveTrainingTimezone } from '../training-date-utils';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type {
  MeshSignalDraft,
  TrainingMeshContext,
  TrainingSecretaryFeedbackForContext,
} from './types';
import {
  endOfDayIso,
  reportInvalidMeshScope,
  resolveWeekWindow,
  safely,
  weekIsoDates,
} from './mesh-common';

const SAFE_SKIPPED_REASON_CODES = new Set([
  'not_enough_time',
  'fatigue',
  'soreness',
  'pain',
  'equipment',
  'schedule_conflict',
  'motivation',
  'other',
]);

const SAFE_SECRETARY_FEEDBACK_STATUSES = new Set<TrainingSecretaryFeedbackForContext['status']>([
  'scheduled',
  'reflowed',
  'compressed',
  'deferred',
  'unscheduled',
  'rejected',
  'needs_more_context',
]);

const SAFE_SECRETARY_FEEDBACK_TYPES = new Set<TrainingSecretaryFeedbackForContext['feedbackType']>([
  'compressed_session',
  'reflowed_session',
  'schedule_attention',
  'needs_context',
  'schedule_confirmed',
]);

const SAFE_SECRETARY_FEEDBACK_HINTS = new Set([
  'recovery_debt',
  'refresh_user_facing_time_copy',
  'refresh_training_plan_context',
  'adapt_workload_to_capacity',
]);

function hasPersistedListItems(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function safeCompletionSummary(completion: TrainingCompletion): Record<string, unknown> | null {
  const completionState = completion.completion_state;
  if (!['completed', 'partial', 'skipped'].includes(completionState)) return null;
  const rawReason = typeof completion.missed_reason === 'string'
    ? completion.missed_reason.trim().toLowerCase()
    : '';
  const skippedReasonCode = completionState === 'skipped' && rawReason
    ? (SAFE_SKIPPED_REASON_CODES.has(rawReason) ? rawReason : 'other')
    : null;

  return {
    completionState,
    hasDiscomfort: completion.discomfort_flag === 1
      || completion.pain_score != null
      || Boolean(completion.pain_location)
      || Boolean(completion.discomfort_details)
      || hasPersistedListItems(completion.discomfort_flags_json)
      || hasPersistedListItems(completion.discomfort_locations_json),
    hasReadiness: completion.readiness_level != null,
    skippedReasonCode,
  };
}

function safeSecretaryFeedbackForContext(
  planId: number,
  decisions: TrainingSecretaryFeedbackDecision[],
): TrainingSecretaryFeedbackForContext | null {
  const safeDecisions = decisions.flatMap((decision, index) => {
    const status = decision.status as TrainingSecretaryFeedbackForContext['status'];
    const feedbackType = decision.feedbackType as TrainingSecretaryFeedbackForContext['feedbackType'];
    if (!Number.isSafeInteger(decision.agendaVersion)
        || decision.agendaVersion <= 0
        || !SAFE_SECRETARY_FEEDBACK_STATUSES.has(status)
        || !SAFE_SECRETARY_FEEDBACK_TYPES.has(feedbackType)
        || feedbackType !== expectedSecretaryFeedbackType(status)) {
      return [];
    }
    return [{
      index,
      status,
      feedbackType,
      reasonCodes: filterKnownReasonCodes(decision.reasonCodes),
      shouldRefreshSource: decision.shouldRefreshSource,
      hints: decision.hints.filter((hint) => SAFE_SECRETARY_FEEDBACK_HINTS.has(hint)),
      scheduledDurationMinutes: safeScheduledDurationMinutes(decision.scheduledStart, decision.scheduledEnd),
    }];
  }).sort((left, right) => {
    const priorityDelta = secretaryFeedbackStatusPriority(left.status)
      - secretaryFeedbackStatusPriority(right.status);
    return priorityDelta !== 0 ? priorityDelta : left.index - right.index;
  });
  if (safeDecisions.length === 0) return null;

  const attentionDecisions = safeDecisions.filter((decision) =>
    ['unscheduled', 'needs_more_context', 'deferred', 'compressed'].includes(decision.status),
  );
  const reflowDecisions = safeDecisions.filter((decision) => decision.status === 'reflowed');
  const relevantDecisions = attentionDecisions.length > 0
    ? attentionDecisions
    : reflowDecisions.length > 0
      ? reflowDecisions
      : [safeDecisions[0]];
  const representative = relevantDecisions[0];
  const compressedDurations = relevantDecisions
    .filter((decision) => decision.status === 'compressed' && decision.scheduledDurationMinutes != null)
    .map((decision) => decision.scheduledDurationMinutes as number);

  return {
    planId,
    feedbackType: representative.feedbackType,
    status: representative.status,
    reasonCodes: [...new Set(relevantDecisions.flatMap((decision) => decision.reasonCodes))].slice(0, 8),
    shouldRefreshSource: relevantDecisions.some((decision) => decision.shouldRefreshSource),
    hints: [...new Set(relevantDecisions.flatMap((decision) => decision.hints))].slice(0, 8),
    scheduledDurationMinutes: representative.status === 'compressed' && compressedDurations.length > 0
      ? Math.min(...compressedDurations)
      : null,
  };
}

function secretaryFeedbackStatusPriority(status: TrainingSecretaryFeedbackForContext['status']): number {
  if (status === 'unscheduled') return 0;
  if (status === 'needs_more_context') return 1;
  if (status === 'deferred') return 2;
  if (status === 'compressed') return 3;
  if (status === 'reflowed') return 4;
  if (status === 'scheduled') return 5;
  return 6;
}

function expectedSecretaryFeedbackType(
  status: TrainingSecretaryFeedbackForContext['status'],
): TrainingSecretaryFeedbackForContext['feedbackType'] {
  if (status === 'compressed') return 'compressed_session';
  if (status === 'reflowed') return 'reflowed_session';
  if (status === 'unscheduled' || status === 'deferred') return 'schedule_attention';
  if (status === 'needs_more_context') return 'needs_context';
  return 'schedule_confirmed';
}

function safeScheduledDurationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const durationMs = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60_000) return null;
  return Math.round(durationMs / 60_000);
}

function normalizedPlanVersion(plan: TrainingPlan): number {
  const value = Number(plan.plan_version ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function emptyTrainingFlags(): TrainingContext['flags'] {
  return {
    lowSleep: false,
    lowHrv: false,
    lowReadiness: false,
    highLegLoad: false,
    highShoulderLoad: false,
    raceThisWeek: false,
    lowAdherence: false,
    highAdherence: false,
    planDrift: false,
    fuelingGap: false,
    budgetConstraint: false,
    contentCommitment: false,
    otherSportRpeToday: 0,
  };
}

export function createEmptyTrainingMeshContext(opts: { userId: number; weekStart?: string }): TrainingMeshContext {
  const window = resolveWeekWindow(opts.weekStart);
  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    activePlan: null,
    activeWeek: null,
    sessions: [],
    trainingContext: {
      signals: [],
      flags: emptyTrainingFlags(),
    },
    coachBriefing: null,
    adherence: null,
    secretaryFeedback: null,
    coachPhaseMemory: null,
    derivedSignals: [],
  };
}

export async function readTrainingMeshContext(opts: {
  userId: number;
  tenantId?: number;
  weekStart?: string;
}): Promise<TrainingMeshContext> {
  if (!isValidTenantUserId(opts.userId)) {
    reportInvalidMeshScope('read_training_mesh_context', opts.userId, opts.weekStart);
    return createEmptyTrainingMeshContext(opts);
  }

  const tenantId = opts.tenantId ?? opts.userId;
  const activePlanMatch = findActivePlanForWeek(opts.userId, tenantId, opts.weekStart);
  const timezone = activePlanMatch?.timezone ?? resolveTrainingTimezone();
  const window = resolveWeekWindow(opts.weekStart, timezone);
  const trainingContext = readTrainingContextAll({ userId: opts.userId, tenantId });
  const coachBriefing = getLatestByType(opts.userId, 'coach_briefing');
  const latestCompletion = activePlanMatch
    ? safely(() => getLatestCompletionForPlan(activePlanMatch.plan.id), null)
    : null;
  const currentSecretaryFeedback = activePlanMatch
    ? safely(() => listCurrentTrainingSecretaryFeedbackDecisionsForPlan({
        userId: opts.userId,
        tenantId,
        planId: activePlanMatch.plan.id,
        planVersion: normalizedPlanVersion(activePlanMatch.plan),
      }), [] as TrainingSecretaryFeedbackDecision[])
    : [];
  const secretaryFeedback = activePlanMatch
    ? safeSecretaryFeedbackForContext(activePlanMatch.plan.id, currentSecretaryFeedback)
    : null;

  const sessions = activePlanMatch?.week ? getSessionsForWeek(activePlanMatch.week.id) : [];
  const adherence = activePlanMatch?.week
    ? getWeeklyAdherence(activePlanMatch.plan.id, activePlanMatch.week.id)
    : null;

  const scheduledSessions = sessions
    .map((session) => ({
      session,
      date: sessionDateForWeek(session, window.start),
      load: inferTrainingLoad(session),
    }))
    .filter((entry) => Boolean(entry.date));

  const hardDays = scheduledSessions
    .filter((entry) => entry.load === 'hard')
    .map((entry) => entry.date);
  const nextSession = nextScheduledSessionForWindow(scheduledSessions, timezone);
  const restDays = weekIsoDates(window.start).filter((date) => !scheduledSessions.some((entry) => entry.date === date));
  const recoverySignalIds = trainingContext.signals
    .filter((signal) => ['low_sleep', 'low_hrv', 'low_readiness'].includes(signal.signal_type))
    .map((signal) => signal.id);

  const recoveryState = recoverySignalIds.length >= 2
    ? 'critical'
    : recoverySignalIds.length === 1
      ? 'strained'
      : trainingContext.flags.highAdherence
        ? 'primed'
        : 'stable';

  const derivedSignals: MeshSignalDraft[] = [
    {
      sourceAgent: 'mesh.training-context',
      signalType: 'training_load_forecast',
      meshPriority: 3,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        weekStart: window.weekStart,
        weekEnd: window.weekEnd,
        totalSessions: scheduledSessions.length,
        hardDays,
        hardSessionCount: hardDays.length,
        focus: activePlanMatch?.week?.focus ?? null,
        adherenceRate: adherence?.adherenceRate ?? null,
      },
    },
    {
      sourceAgent: 'mesh.training-context',
      signalType: 'recovery_state',
      meshPriority: recoveryState === 'critical' || recoveryState === 'strained' ? 2 : 3,
      priority: recoveryState === 'critical' || recoveryState === 'strained' ? 'urgent' : 'normal',
      expiresAt: endOfDayIso(window.start),
      payload: {
        date: nextSession?.date ?? window.weekStart,
        state: recoveryState,
        lowSleep: trainingContext.flags.lowSleep,
        lowHrv: trainingContext.flags.lowHrv,
        lowReadiness: trainingContext.flags.lowReadiness,
        sourceSignalIds: recoverySignalIds,
        coachBriefingCreatedAt: coachBriefing?.createdAt ?? null,
      },
    },
  ];

  const completionSummary = latestCompletion ? safeCompletionSummary(latestCompletion) : null;
  if (completionSummary) {
    derivedSignals.push({
      sourceAgent: 'mesh.training-context',
      signalType: 'training_completion_summary',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: completionSummary,
    });
  }

  if (nextSession) {
    derivedSignals.push({
      sourceAgent: 'mesh.training-context',
      signalType: 'session_prescription',
      meshPriority: 3,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        date: nextSession.date,
        title: nextSession.session.title,
        sessionType: nextSession.session.session_type,
        durationMinutes: nextSession.session.duration_minutes,
        intensity: nextSession.session.intensity_text,
        description: nextSession.session.description,
      },
    });

    const immovability = deriveSessionImmovability(nextSession);
    if (immovability) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'session_immovability',
        meshPriority: immovability.level === 'high' ? 2 : 3,
        priority: immovability.level === 'high' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          level: immovability.level,
          reason: immovability.reason,
        },
      });
    }

    const fueling = deriveFuelingRequirements(nextSession);
    if (fueling) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'fueling_requirements',
        meshPriority: fueling.supportLevel === 'elevated' ? 2 : 3,
        priority: fueling.supportLevel === 'elevated' ? 'urgent' : 'normal',
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          supportLevel: fueling.supportLevel,
          carbFocus: fueling.carbFocus,
          hydrationFocus: fueling.hydrationFocus,
          proteinRecovery: fueling.proteinRecovery,
          timing: fueling.timing,
        },
      });
    }

    const storyOpportunity = deriveTrainingContentCaptureOpportunity({
      nextSession,
      adherenceRate: adherence?.adherenceRate ?? null,
      recoveryState,
      activeWeekFocus: activePlanMatch?.week?.focus ?? null,
    });
    if (storyOpportunity) {
      derivedSignals.push({
        sourceAgent: 'mesh.training-context',
        signalType: 'content_capture_opportunity',
        meshPriority: storyOpportunity.meshPriority,
        priority: storyOpportunity.priority,
        expiresAt: endOfDayIso(window.end),
        payload: {
          date: nextSession.date,
          title: nextSession.session.title,
          sessionType: nextSession.session.session_type,
          load: nextSession.load,
          angle: storyOpportunity.angle,
          reason: storyOpportunity.reason,
          focus: activePlanMatch?.week?.focus ?? null,
          adherenceRate: adherence?.adherenceRate ?? null,
          recoveryState,
        },
      });
    }
  }

  if (restDays.length > 0) {
    derivedSignals.push({
      sourceAgent: 'mesh.training-context',
      signalType: 'rest_day_scheduled',
      meshPriority: 2,
      priority: 'normal',
      expiresAt: endOfDayIso(window.end),
      payload: {
        dates: restDays,
      },
    });
  }

  // Load any persisted coach phase narrative (base / build / peak /
  // taper / recovery + adherence trend + recent deloads) so consumers
  // can interpret this week's signals in the context of the athlete's
  // arc rather than each week as an isolated snapshot.
  const coachPhase = safely(() => getCurrentCoachPhase(opts.userId), null);
  const coachPhaseMemory = coachPhase
    ? {
        phase: coachPhase.phase,
        weekInPhase: coachPhase.weekInPhase,
        phaseTotalWeeks: coachPhase.phaseTotalWeeks,
        narrative: coachPhase.narrative,
        adherenceTrend: coachPhase.adherenceTrend,
        recentDeloadDates: coachPhase.recentDeloadDates,
        activeConcern: coachPhase.activeConcern,
        nextExpectedShift: coachPhase.nextExpectedShift,
        writtenAt: coachPhase.writtenAt,
      }
    : null;

  return {
    userId: opts.userId,
    weekStart: window.weekStart,
    weekEnd: window.weekEnd,
    activePlan: activePlanMatch?.plan ?? null,
    activeWeek: activePlanMatch?.week ?? null,
    sessions,
    trainingContext,
    coachBriefing,
    adherence,
    secretaryFeedback,
    coachPhaseMemory,
    derivedSignals,
  };
}

interface ActivePlanWeekMatch {
  plan: TrainingPlan;
  week: TrainingWeek | null;
  timezone: string;
}

export function findActivePlanForWeek(
  userId: number,
  tenantId: number,
  weekStart?: string,
): ActivePlanWeekMatch | null {
  const plans = getActivePlans(userId, tenantId);
  const now = DateTime.now();
  let fallback: ActivePlanWeekMatch | null = null;
  for (const plan of plans) {
    const timezone = resolveTrainingPlanTimezone(plan);
    const requestedTarget = weekStart
      ? DateTime.fromISO(weekStart, { zone: timezone })
      : now.setZone(timezone);
    const targetDate = (requestedTarget.isValid ? requestedTarget : now.setZone(timezone)).startOf('day');
    const week = resolveTrainingWeekForDate(plan, targetDate, timezone);
    fallback ??= { plan, week, timezone };
    if (week) {
      return { plan, week, timezone };
    }
  }
  return fallback;
}

function resolveTrainingWeekForDate(
  plan: TrainingPlan,
  targetDate: DateTime,
  timezone: string = resolveTrainingPlanTimezone(plan),
): TrainingWeek | null {
  const planStart = DateTime.fromISO(plan.start_date, { zone: timezone }).startOf('day');
  const localTargetDate = targetDate.setZone(timezone).startOf('day');
  const diffDays = Math.floor(localTargetDate.diff(planStart, 'days').days);
  if (diffDays < 0) return null;
  const weekNumber = Math.floor(diffDays / 7) + 1;
  const weeks = getWeeksForPlan(plan.id);
  return weeks.find((week) => week.week_number === weekNumber) ?? null;
}

export function sessionDateForWeek(session: TrainingSession, weekStart: DateTime): string {
  const normalized = session.day_of_week.trim().toLowerCase();
  const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const offset = weekdays.indexOf(normalized);
  return offset >= 0 ? weekStart.plus({ days: offset }).toISODate()! : weekStart.toISODate()!;
}

export function inferTrainingLoad(session: TrainingSession): 'hard' | 'moderate' | 'light' {
  const title = `${session.title} ${session.session_type} ${session.intensity_text ?? ''}`.toLowerCase();
  if (/\b(interval|tempo|threshold|ftp|race|track|hill|long run|long ride|vo2)\b/.test(title)) {
    return 'hard';
  }
  if (/\b(strength|brick|endurance|steady|build|moderate)\b/.test(title)) {
    return 'moderate';
  }
  return 'light';
}

function deriveSessionImmovability(
  entry: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' },
): { level: 'high' | 'medium'; reason: string } | null {
  if (entry.load === 'hard') {
    return {
      level: 'high',
      reason: 'Quality or high-cost session that should stay protected in the week.',
    };
  }
  if (entry.load === 'moderate') {
    return {
      level: 'medium',
      reason: 'Planned progression session that is movable only with care.',
    };
  }
  return null;
}

function deriveFuelingRequirements(
  entry: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' },
): {
  supportLevel: 'elevated' | 'steady';
  carbFocus: 'high' | 'moderate';
  hydrationFocus: 'elevated' | 'steady';
  proteinRecovery: boolean;
  timing: string;
} | null {
  if (entry.load === 'hard') {
    return {
      supportLevel: 'elevated',
      carbFocus: 'high',
      hydrationFocus: 'elevated',
      proteinRecovery: true,
      timing: 'Protect both pre-session and post-session fueling on this day.',
    };
  }
  if (entry.load === 'moderate') {
    return {
      supportLevel: 'steady',
      carbFocus: 'moderate',
      hydrationFocus: 'steady',
      proteinRecovery: true,
      timing: 'Keep the day fed consistently, especially after the session.',
    };
  }
  return null;
}

function deriveTrainingContentCaptureOpportunity(opts: {
  nextSession: { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' };
  adherenceRate: number | null;
  recoveryState: 'critical' | 'strained' | 'primed' | 'stable';
  activeWeekFocus: string | null;
}): {
  angle: 'coach_adjustment' | 'progress_checkpoint' | 'block_focus';
  reason: string;
  meshPriority: MeshPriority;
  priority: SignalPriority;
} | null {
  const adherenceRate = typeof opts.adherenceRate === 'number' ? opts.adherenceRate : null;

  if ((opts.recoveryState === 'critical' || opts.recoveryState === 'strained') && opts.nextSession.load !== 'light') {
    return {
      angle: 'coach_adjustment',
      reason: 'Recovery is under pressure, so the next key session shows how the coach is adapting the week instead of forcing the original prescription.',
      meshPriority: 2,
      priority: 'normal',
    };
  }

  if (adherenceRate != null && adherenceRate >= 90 && opts.nextSession.load === 'hard') {
    return {
      angle: 'progress_checkpoint',
      reason: 'Adherence is high and the next hard session is a strong progress checkpoint worth explaining or capturing.',
      meshPriority: 3,
      priority: 'normal',
    };
  }

  if (opts.activeWeekFocus && opts.nextSession.load !== 'light') {
    return {
      angle: 'block_focus',
      reason: `The current ${String(opts.activeWeekFocus).toLowerCase()} block is anchored by this session, which makes it a useful coaching story moment.`,
      meshPriority: 4,
      priority: 'background',
    };
  }

  return null;
}

function nextScheduledSessionForWindow(
  scheduledSessions: Array<{ session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' }>,
  timezone: string,
): { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' } | null {
  const today = DateTime.now().setZone(timezone).toISODate()!;
  return scheduledSessions
    .slice()
    .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
    .find((entry) => entry.date >= today)
    ?? scheduledSessions
      .slice()
      .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))[0]
    ?? null;
}
