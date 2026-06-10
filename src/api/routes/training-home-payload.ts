// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../../utils/logger';
import type { Lang } from '../../utils/i18n';
import { buildScreenContractMeta } from '../../services/screen-contract-meta';
import {
  buildTrainingHomeViewState,
  type ReadinessInput,
  type TrainingHomeViewState,
  type TrainingPrescriptionSummary,
  type TrainingSessionInput,
  type TrainingSignalInput,
  type WeekSessionInput,
} from '../../services/training-home-view-state';
import { getStoredPlanCoveringDate } from '../../services/coach-plan-registry';
import { adjustForFatigue } from '../../services/coach-kernel/planner-engine';
import { resolveTrainingDay, trainingWeekdayMatches } from '../../services/training-date-utils';
import type {
  AthleteState,
  ReadinessLevel,
  ReadinessSnapshot,
  Session,
  WeeklyPlan,
} from '../../services/coach-kernel/types';
import type { CoachBriefingSnapshot } from './training-coach-briefing';
import { isGarminActivelyIntegrated } from '../../services/integration-status';

export interface TrainingHomePayloadDependencies {
  getTodaySession: (userId: number, tenantId: number) => Promise<{ session: TrainingSessionInput | null; plan: unknown | null }>;
  getWeekPlan: (userId: number, tenantId: number) => Promise<{
    plan: unknown | null;
    sessions: WeekSessionInput[];
    adherence: number;
    weekNumber?: number;
    completedCount?: number;
    totalCount?: number;
  }>;
  getReadiness: (userId: number) => Promise<(ReadinessInput & { reasonCode?: string | null }) | null>;
  buildActiveSignalsResponse: (userId: number) => Promise<{ signals: TrainingSignalInput[] }> | { signals: TrainingSignalInput[] };
  getCoachBriefingSnapshot: (userId: number) => CoachBriefingSnapshot | null;
}

interface KernelTodayContext {
  kernelGuardrails?: {
    ruleId: string;
    status: 'pass' | 'warn' | 'block';
    message: string;
    adjusted?: boolean;
  }[];
  originalPrescription: TrainingPrescriptionSummary | null;
  adaptedPrescription: TrainingPrescriptionSummary | null;
}

export async function buildTrainingHomePayload(
  userId: number,
  tenantId: number,
  language: Lang,
  dependencies: TrainingHomePayloadDependencies,
): Promise<TrainingHomeViewState> {
  const [todayResult, weekResult, readinessResult, signalResult] = await Promise.allSettled([
    dependencies.getTodaySession(userId, tenantId),
    dependencies.getWeekPlan(userId, tenantId),
    dependencies.getReadiness(userId),
    Promise.resolve(dependencies.buildActiveSignalsResponse(userId)),
  ]);

  const today = todayResult.status === 'fulfilled' ? todayResult.value : { session: null, plan: null };
  const week = weekResult.status === 'fulfilled'
    ? weekResult.value
    : { plan: null, sessions: [], adherence: 0, weekNumber: 0, completedCount: 0, totalCount: 0 };
  const readiness = readinessResult.status === 'fulfilled'
    ? readinessResult.value
    : { score: 0, factors: {}, recommendation: null };
  const activeSignals = signalResult.status === 'fulfilled'
    ? signalResult.value
    : { signals: [] };

  const coachBriefing = dependencies.getCoachBriefingSnapshot(userId);
  const reasonCodes = [
    ...(todayResult.status === 'rejected' ? ['TODAY_UNAVAILABLE'] : []),
    ...(weekResult.status === 'rejected' ? ['WEEK_UNAVAILABLE'] : []),
    ...(readinessResult.status === 'rejected' ? ['READINESS_UNAVAILABLE'] : []),
    ...(readinessResult.status === 'fulfilled' && typeof readinessResult.value?.reasonCode === 'string'
      ? [readinessResult.value.reasonCode]
      : []),
    ...(signalResult.status === 'rejected' ? ['SIGNALS_UNAVAILABLE'] : []),
    ...(coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true ? ['COACH_STALE'] : []),
  ];
  const tomorrow = resolveTrainingDay({ offsetDays: 1 });
  const tomorrowSession = (week.sessions || []).find((session) => trainingWeekdayMatches(session.day, tomorrow)) || null;
  const kernelContext = resolveKernelTodayContext(
    userId,
    readinessResult.status === 'fulfilled' ? readinessResult.value : null,
  );

  return buildTrainingHomeViewState({
    todaySession: today.session ?? null,
    readiness,
    coachBriefing,
    signals: activeSignals.signals || [],
    weekSessions: week.sessions || [],
    weeklyAdherence: typeof week.adherence === 'number' ? week.adherence : 0,
    tomorrowSession,
    hasActivePlan: !!(today.plan || week.plan),
    // Gap 6: only flag `isGarminStale` when Garmin is actually a data source
    // for this user. The old logic tied the flag to any briefing degradation,
    // so a Gmail-only user who never connected Garmin would still see the
    // "Today's read is partial, waiting for Garmin to sync again" copy — a
    // lie about an integration that was never there. `coachBriefing.degraded`
    // can still flip from other signals (weather, Gemini outage, etc.) — see
    // handoff note for Agent 4 on how to render non-Garmin degraded copy.
    isGarminStale:
      isGarminActivelyIntegrated(userId)
      && (coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true),
    kernelGuardrails: kernelContext.kernelGuardrails,
    todayOriginalPrescription: kernelContext.originalPrescription,
    todayAdaptedPrescription: kernelContext.adaptedPrescription,
    meta: buildScreenContractMeta({
      source: 'server',
      isFallback: reasonCodes.length > 0,
      isPartial: todayResult.status === 'rejected'
        || weekResult.status === 'rejected'
        || readinessResult.status === 'rejected'
        || (readinessResult.status === 'fulfilled' && typeof readinessResult.value?.reasonCode === 'string')
        || signalResult.status === 'rejected',
      isStale: coachBriefing?.degraded === true || coachBriefing?.cachedOnlyMiss === true,
      generatedAt: new Date().toISOString(),
      reasonCodes,
    }),
  }, language);
}

function resolveKernelTodayContext(
  userId: number,
  liveReadiness: { score: number; factors?: any } | null,
): KernelTodayContext {
  const today = new Date().toISOString().slice(0, 10);
  const stored = getStoredPlanCoveringDate(userId, today);
  if (!stored) return { originalPrescription: null, adaptedPrescription: null };

  const todayDow = dayOfWeekForDate(today);
  const originalSession = stored.plan.sessions.find((session) => session.dayOfWeek === todayDow) ?? null;
  const liveLevel = classifyLiveReadinessLevel(liveReadiness?.score);
  const needsReadjust = liveLevel === 'orange' || liveLevel === 'red';

  const effectivePlan = needsReadjust
    ? readjustForTodayFatigue(stored.athleteState, stored.plan, liveReadiness, liveLevel)
    : stored.plan;
  const adaptedSession = effectivePlan.sessions.find((session) => session.dayOfWeek === todayDow) ?? null;

  return {
    kernelGuardrails: effectivePlan.guardrailResults.map((result) => ({
      ruleId: result.ruleId,
      status: result.status,
      message: result.message,
      adjusted: result.adjusted,
    })),
    originalPrescription: toPrescriptionSummary(originalSession),
    adaptedPrescription: toPrescriptionSummary(adaptedSession),
  };
}

function dayOfWeekForDate(isoDate: string): Session['dayOfWeek'] {
  const dow = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
  const mapping: Record<number, Session['dayOfWeek']> = {
    0: 'sunday',
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
  };
  return mapping[dow] ?? 'monday';
}

function toPrescriptionSummary(session: Session | null): TrainingPrescriptionSummary | null {
  if (!session) return null;
  const detailParts: string[] = [];
  if (typeof session.durationMinutes === 'number') detailParts.push(`${session.durationMinutes} min`);
  if (session.intensityZone) detailParts.push(String(session.intensityZone));
  return {
    title: session.title,
    detail: detailParts.join(' · '),
    durationMinutes: typeof session.durationMinutes === 'number' ? session.durationMinutes : null,
    sessionType: session.sessionType,
  };
}

function readjustForTodayFatigue(
  storedAthlete: AthleteState,
  storedPlan: WeeklyPlan,
  liveReadiness: { score: number; factors?: any } | null,
  liveLevel: ReadinessLevel,
): WeeklyPlan {
  if (!liveReadiness) return storedPlan;

  const patchedReadiness: ReadinessSnapshot = {
    ...storedAthlete.readiness,
    capturedAt: new Date().toISOString(),
    score: clampReadinessScoreForRoute(liveReadiness.score),
    level: liveLevel,
    hrvStatus: mapHrvTrendToStatus(liveReadiness.factors?.hrvStatus),
    energyReserve: typeof liveReadiness.factors?.bodyBattery === 'number'
      ? liveReadiness.factors.bodyBattery
      : storedAthlete.readiness.energyReserve,
  };

  const patchedAthlete: AthleteState = {
    ...storedAthlete,
    readiness: patchedReadiness,
  };

  try {
    return adjustForFatigue(patchedAthlete, storedPlan);
  } catch (err) {
    logger.debug({ err, athleteId: storedAthlete.profile.athleteId }, 'adjustForFatigue re-run failed — falling back to stored guardrails');
    return storedPlan;
  }
}

function classifyLiveReadinessLevel(score: number | undefined): ReadinessLevel {
  if (!score || !Number.isFinite(score)) return 'yellow';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

function clampReadinessScoreForRoute(score: number): number {
  if (!Number.isFinite(score)) return 70;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function mapHrvTrendToStatus(raw: unknown): ReadinessSnapshot['hrvStatus'] {
  if (raw === 'up' || raw === 'high') return 'high';
  if (raw === 'down' || raw === 'low') return 'low';
  if (raw === 'stable' || raw === 'normal') return 'normal';
  return undefined;
}
