// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Deterministic Training mesh adapter. */

import { DateTime } from 'luxon';
import { config } from '../../config';
import type { MeshPriority, SignalPriority } from '../intelligence-bus';
import { getLatestByType } from '../report-document-store';
import { getCurrentCoachPhase } from '../coach-phase-memory';
import { readTrainingContextAll, type TrainingContext } from '../training-signals';
import {
  getActivePlans,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
} from '../training-plans';
import { isValidTenantUserId } from '../tenant-scope-observability';
import type { MeshSignalDraft, TrainingMeshContext } from './types';
import {
  endOfDayIso,
  reportInvalidMeshScope,
  resolveWeekWindow,
  safely,
  weekIsoDates,
} from './mesh-common';

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
    calendarConflict: false,
    scheduleStale: false,
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

  const window = resolveWeekWindow(opts.weekStart);
  const trainingContext = readTrainingContextAll({ userId: opts.userId, tenantId: opts.tenantId });
  const coachBriefing = getLatestByType(opts.userId, 'coach_briefing');
  const activePlanMatch = findActivePlanForWeek(opts.userId, window.start);

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
  const nextSession = nextScheduledSessionForWindow(scheduledSessions);
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
    coachPhaseMemory,
    derivedSignals,
  };
}

interface ActivePlanWeekMatch {
  plan: TrainingPlan;
  week: TrainingWeek | null;
}

export function findActivePlanForWeek(userId: number, targetDate: DateTime): ActivePlanWeekMatch | null {
  const plans = getActivePlans(userId, userId);
  for (const plan of plans) {
    const week = resolveTrainingWeekForDate(plan, targetDate);
    if (week) {
      return { plan, week };
    }
  }
  if (plans[0]) {
    return { plan: plans[0], week: resolveTrainingWeekForDate(plans[0], targetDate) };
  }
  return null;
}

function resolveTrainingWeekForDate(plan: TrainingPlan, targetDate: DateTime): TrainingWeek | null {
  const zone = config.app.timezone || 'Europe/Lisbon';
  const planStart = DateTime.fromISO(plan.start_date, { zone }).startOf('day');
  const diffDays = Math.floor(targetDate.startOf('day').diff(planStart, 'days').days);
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
): { session: TrainingSession; date: string; load: 'hard' | 'moderate' | 'light' } | null {
  const today = DateTime.now().setZone(config.app.timezone || 'Europe/Lisbon').toISODate()!;
  return scheduledSessions
    .slice()
    .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))
    .find((entry) => entry.date >= today)
    ?? scheduledSessions
      .slice()
      .sort((lhs, rhs) => lhs.date.localeCompare(rhs.date))[0]
    ?? null;
}
