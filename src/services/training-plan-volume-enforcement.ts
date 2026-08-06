// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CoordinatedTrainingPlan, CoordinatedTrainingSession, TrainingPlanVolumeShortfall } from './training-plan-coordination';
import { loadCoachKnowledge } from './coach-kernel/knowledge-loader';
import { buildStrengthSupportVariant } from './coach-kernel/support-session-builder';
import type { CoachKnowledgeBase } from './coach-kernel/types';
import {
  inferTrainingSessionIsLongRun,
  inferTrainingSessionIsLowerHeavy,
} from './training-session-classification';

const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const DAY_LABEL: Record<string, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};
const MAX_STRENGTH_SESSIONS_PER_WEEK = 6;

export interface TrainingPlanVolumeRequest {
  sessionsPerWeek: number;
  runSessionsPerWeek?: number | null;
  bikeSessionsPerWeek?: number | null;
  swimSessionsPerWeek?: number | null;
  strengthSessionsPerWeek: number;
  preferredCardioTime: string;
  preferredStrengthTime: string;
  startDate: string;
  longWorkoutDay?: string | null;
  /**
   * F7 (Phase 3): the athlete's two-a-day stance. 'never' is a hard per-day
   * cap enforced HERE, after every kernel/repair pass — the kernel receives
   * the preference as guidance, but this enforcer is the guarantee.
   */
  twoADayPreference?: string | null;
}

export interface FinalTrainingPlanTwoADayCapRequest {
  startDate: string;
  twoADayPreference?: string | null;
}

function positiveSessionRequest(value: number | null | undefined): number {
  return typeof value === 'number' && value > 0
    ? clamp(Math.round(value), 1, 7)
    : 0;
}

function requestedPrimarySessionsForSport(
  planSport: string,
  input: {
    requestedTrainingDays: number;
    requestedRunSessions: number;
    requestedBikeSessions: number;
    requestedSwimSessions: number;
  },
): number {
  if (planSport === 'running') return input.requestedRunSessions || input.requestedTrainingDays;
  if (planSport === 'cycling') return input.requestedBikeSessions || input.requestedTrainingDays;
  if (planSport === 'swimming') return input.requestedSwimSessions || input.requestedTrainingDays;
  return input.requestedTrainingDays;
}

function requestedTrainingDayBudgetForSport(
  planSport: string,
  input: {
    requestedTrainingDays: number;
    requestedPrimarySessions: number;
    requestedRunSessions: number;
    requestedBikeSessions: number;
    requestedSwimSessions: number;
    explicitEnduranceTotal: number;
  },
): number {
  if (planSport === 'running' && input.requestedRunSessions > 0) return input.requestedRunSessions;
  if (planSport === 'cycling' && input.requestedBikeSessions > 0) return input.requestedBikeSessions;
  if (planSport === 'swimming' && input.requestedSwimSessions > 0) return input.requestedSwimSessions;
  if (input.explicitEnduranceTotal > 0) {
    return Math.min(input.requestedTrainingDays, Math.max(1, input.explicitEnduranceTotal));
  }
  return input.requestedPrimarySessions;
}

interface NormalizedTrainingPlanVolumeRequest {
  planSport: string;
  requestedTrainingDays: number;
  requestedRunSessions: number;
  requestedBikeSessions: number;
  requestedSwimSessions: number;
  requestedStrength: number;
  requestedTotal: number;
  requestedDayBudget: number;
  defaultStrengthForGymPlan: number;
  hasExplicitEnduranceRequest: boolean;
  singleSessionPerDay: boolean;
}

type TrainingPlanVolumeSessionShape = Partial<CoordinatedTrainingSession>;

interface TrainingPlanVolumeWeekShape {
  weekNumber?: number;
  strengthCutoffActive?: boolean;
  sessions?: TrainingPlanVolumeSessionShape[];
}

interface TrainingPlanVolumeShape {
  sport?: string;
  weeks?: TrainingPlanVolumeWeekShape[];
  volumeShortfalls?: TrainingPlanVolumeShortfall[];
}

export interface TrainingPlanWeekVolumeTargetSnapshot {
  readonly weekNumber: number;
  readonly allowedDays: readonly string[];
  readonly weekTotalBudget: number;
  readonly activeTarget: number;
  /** Athlete-visible request target, before placement-capacity constraints. */
  readonly requestedStrengthTarget: number;
  /** Feasible target used only to trim/shape the schedule. */
  readonly strengthTrimTarget: number;
  readonly cyclingTarget: number | null;
  readonly swimmingTarget: number | null;
  readonly singleSessionPerDay: boolean;
}

export interface TrainingPlanVolumeTargetSnapshot {
  readonly planSport: string;
  readonly weeks: readonly TrainingPlanWeekVolumeTargetSnapshot[];
}

function normalizeTrainingPlanVolumeRequest(
  planSport: string,
  request: TrainingPlanVolumeRequest,
): NormalizedTrainingPlanVolumeRequest {
  const requestedTrainingDays = clamp(Math.round(request.sessionsPerWeek || 5), 3, 7);
  const requestedRunSessions = positiveSessionRequest(request.runSessionsPerWeek);
  const requestedBikeSessions = positiveSessionRequest(request.bikeSessionsPerWeek);
  const requestedSwimSessions = positiveSessionRequest(request.swimSessionsPerWeek);
  const requestedPrimarySessions = requestedPrimarySessionsForSport(planSport, {
    requestedTrainingDays,
    requestedRunSessions,
    requestedBikeSessions,
    requestedSwimSessions,
  });
  const requestedStrength = clamp(
    Math.round(request.strengthSessionsPerWeek || 0),
    0,
    MAX_STRENGTH_SESSIONS_PER_WEEK,
  );
  const explicitEnduranceTotal = requestedRunSessions + requestedBikeSessions + requestedSwimSessions;
  const hasExplicitEnduranceRequest = explicitEnduranceTotal > 0;
  const requestedTotal = hasExplicitEnduranceRequest
    ? explicitEnduranceTotal + (requestedStrength > 0 ? requestedStrength : 0)
    : planSport === 'running'
      ? requestedPrimarySessions + requestedStrength
      : requestedPrimarySessions;
  const singleSessionPerDay = String(request.twoADayPreference || '').trim().toLowerCase() === 'never';
  const requestedDayBudget = singleSessionPerDay
    ? Math.min(requestedTrainingDays, Math.max(1, requestedTotal))
    : requestedTrainingDayBudgetForSport(planSport, {
        requestedTrainingDays,
        requestedPrimarySessions,
        requestedRunSessions,
        requestedBikeSessions,
        requestedSwimSessions,
        explicitEnduranceTotal,
      });
  return {
    planSport,
    requestedTrainingDays,
    requestedRunSessions,
    requestedBikeSessions,
    requestedSwimSessions,
    requestedStrength,
    requestedTotal,
    requestedDayBudget,
    defaultStrengthForGymPlan: planSport === 'gym'
      ? Math.min(MAX_STRENGTH_SESSIONS_PER_WEEK, requestedPrimarySessions)
      : 0,
    hasExplicitEnduranceRequest,
    singleSessionPerDay,
  };
}

function buildTrainingPlanWeekVolumeTargets(
  week: TrainingPlanVolumeWeekShape,
  referenceSessions: CoordinatedTrainingSession[],
  request: TrainingPlanVolumeRequest,
  normalized: NormalizedTrainingPlanVolumeRequest,
): TrainingPlanWeekVolumeTargetSnapshot {
  const weekNumber = typeof week.weekNumber === 'number' ? week.weekNumber : 1;
  const presentCardioModalities = new Set(
    referenceSessions
      .map((session) => cardioModality(session))
      .filter((modality): modality is 'running' | 'cycling' | 'swimming' => modality != null),
  );
  const explicitCardioAsk: Record<'running' | 'cycling' | 'swimming', number> = {
    running: normalized.requestedRunSessions,
    cycling: normalized.requestedBikeSessions,
    swimming: normalized.requestedSwimSessions,
  };
  // Multisport weeks where only SOME modality dials carry an explicit ask:
  // the zeroed dials mean "auto", so the week budget stays at the requested
  // training days instead of collapsing to the explicit sum.
  const partialExplicitMultisport = normalized.hasExplicitEnduranceRequest
    && presentCardioModalities.size >= 2
    && [...presentCardioModalities].some((modality) => explicitCardioAsk[modality] === 0);
  const weekRequestedTotal = partialExplicitMultisport
    ? Math.max(normalized.requestedTotal, normalized.requestedTrainingDays)
    : normalized.requestedTotal;
  const effectiveDayBudget = normalized.singleSessionPerDay
    ? Math.min(normalized.requestedTrainingDays, Math.max(1, weekRequestedTotal))
    : normalized.requestedDayBudget;
  const allowedDays = constrainTrainingDays(
    allowedDaysForWeek(request.startDate, weekNumber),
    effectiveDayBudget,
    request.longWorkoutDay,
  );
  const weekStrengthCutoffActive = week.strengthCutoffActive === true;
  const weekTotalBudget = weekStrengthCutoffActive
    ? Math.max(1, weekRequestedTotal - normalized.requestedStrength)
    : weekRequestedTotal;
  const maxSessionsPerDay = normalized.singleSessionPerDay ? 1 : 2;
  const activeTarget = Math.min(
    weekTotalBudget,
    Math.max(1, allowedDays.length * maxSessionsPerDay),
  );
  const requestedStrengthTarget = weekStrengthCutoffActive
    ? 0
    : normalized.requestedStrength > 0
      ? normalized.requestedStrength
      : normalized.defaultStrengthForGymPlan;
  const strengthTrimTarget = Math.min(
    activeTarget,
    requestedStrengthTarget,
    allowedDays.length,
  );
  const hasDefaultMultisportFloors = normalized.requestedBikeSessions === 0
    && normalized.requestedSwimSessions === 0
    && referenceSessions.some((session) => cardioModality(session) === 'cycling')
    && referenceSessions.some((session) => cardioModality(session) === 'swimming');
  return Object.freeze({
    weekNumber,
    allowedDays: Object.freeze([...allowedDays]),
    weekTotalBudget,
    activeTarget,
    requestedStrengthTarget,
    strengthTrimTarget,
    cyclingTarget: normalized.requestedBikeSessions > 0
      ? normalized.requestedBikeSessions
      : hasDefaultMultisportFloors
        ? 1
        : null,
    swimmingTarget: normalized.requestedSwimSessions > 0
      ? normalized.requestedSwimSessions
      : hasDefaultMultisportFloors
        ? 1
        : null,
    singleSessionPerDay: normalized.singleSessionPerDay,
  });
}

/**
 * Capture request semantics before any trim/equipment/quality pass can remove
 * the modality evidence used to interpret partial multisport dials.
 */
export function captureTrainingPlanVolumeTargetSnapshot(
  plan: TrainingPlanVolumeShape,
  request: TrainingPlanVolumeRequest,
): TrainingPlanVolumeTargetSnapshot {
  const planSport = String(plan?.sport || '').toLowerCase();
  const normalizedRequest = normalizeTrainingPlanVolumeRequest(planSport, request);
  const weeks = (Array.isArray(plan?.weeks) ? plan.weeks : []).map((week) => {
    const referenceSessions = normalizeTrainingPlanVolumeSessions(week.sessions ?? [])
      .filter(isScheduledSession);
    return buildTrainingPlanWeekVolumeTargets(week, referenceSessions, request, normalizedRequest);
  });
  return Object.freeze({
    planSport,
    weeks: Object.freeze(weeks),
  });
}

function buildTrainingPlanWeekVolumeShortfalls(
  sessions: CoordinatedTrainingSession[],
  targets: TrainingPlanWeekVolumeTargetSnapshot,
): TrainingPlanVolumeShortfall[] {
  const authoredSessions = sessions.filter(isScheduledSession);
  const activeSessions = authoredSessions.filter((session) => !isInactiveEnforcedSession(session));
  const shortfalls: TrainingPlanVolumeShortfall[] = [];
  const activeCount = activeSessions.length;
  if (activeCount < targets.weekTotalBudget) {
    shortfalls.push({
      weekNumber: targets.weekNumber,
      kind: 'active',
      requested: targets.weekTotalBudget,
      achieved: activeCount,
      reason: targets.singleSessionPerDay && targets.activeTarget < targets.weekTotalBudget
        ? 'two_a_day_cap'
        : authoredSessions.length < targets.activeTarget
          ? 'engine_output_shortfall'
          : 'no_available_day',
      provenance: 'coach_kernel_output',
    });
  }
  const strengthCount = activeSessions.filter(isStrengthSession).length;
  if (strengthCount < targets.requestedStrengthTarget) {
    const authoredStrengthCount = authoredSessions.filter(isStrengthSession).length;
    shortfalls.push({
      weekNumber: targets.weekNumber,
      kind: 'strength',
      requested: targets.requestedStrengthTarget,
      achieved: strengthCount,
      reason: authoredStrengthCount < targets.strengthTrimTarget
        ? 'engine_output_shortfall'
        : 'no_available_day',
      provenance: 'coach_kernel_output',
    });
  }
  return shortfalls;
}

export function enforceRequestedTrainingPlanVolume(
  plan: CoordinatedTrainingPlan,
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;

  const targetSnapshot = captureTrainingPlanVolumeTargetSnapshot(cloned, request);
  const volumeShortfalls: TrainingPlanVolumeShortfall[] = [];

  cloned.weeks = cloned.weeks.map((week, index) => {
    let sessions = (week.sessions ?? [])
      .filter(isScheduledSession)
      .map((session) => normalizeSessionDay(session))
      .filter((session): session is CoordinatedTrainingSession => Boolean(session));
    const targets = targetSnapshot.weeks[index];
    if (!targets) return week;

    sessions = trimStrengthToTarget(sessions, targets.strengthTrimTarget);
    sessions = spreadSameTypeCollisions(sessions, targets.allowedDays);
    sessions = trimCardioModalitiesToTargets(sessions, {
      cycling: targets.cyclingTarget,
      swimming: targets.swimmingTarget,
    });
    sessions = trimToActiveTarget(sessions, targets.activeTarget, targets.strengthTrimTarget, {
      cycling: targets.cyclingTarget,
      swimming: targets.swimmingTarget,
    });
    sessions = protectHeavyLowerBeforeLongRun(sessions, request, cloned.sport, targets.weekNumber);
    if (targets.singleSessionPerDay) {
      // Runs LAST so doubles produced by any earlier pass (including
      // kernel output that arrived doubled) are relocated or, when no free
      // allowed day remains, honestly deferred — never silently kept.
      sessions = enforceSingleSessionPerDay(sessions, targets.allowedDays);
    }

    // F10: record the gap between the athlete's ask and what could be
    // placed, instead of letting the fill loops break silently.
    volumeShortfalls.push(...buildTrainingPlanWeekVolumeShortfalls(sessions, targets));

    return {
      ...week,
      sessions: sortSessions(applyPreferredTimes(sessions, request)),
    };
  });

  if (volumeShortfalls.length > 0) cloned.volumeShortfalls = volumeShortfalls;
  else delete cloned.volumeShortfalls;
  return cloned;
}

/**
 * Rebuild F10 metadata from the exact finalized schedule. Equipment,
 * quality, and persistence finalization run after the primary volume pass;
 * carrying its earlier counts forward can therefore report sessions that no
 * longer exist or hide engine-authored sessions added later. The immutable
 * target snapshot was captured before enforcement; achieved counts always
 * come from `plan`.
 */
export function recalculateFinalTrainingPlanVolumeShortfalls<T extends TrainingPlanVolumeShape>(
  plan: T,
  targetSnapshot: TrainingPlanVolumeTargetSnapshot,
): T {
  const cloned: T = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;

  const volumeShortfalls: TrainingPlanVolumeShortfall[] = [];

  targetSnapshot.weeks.forEach((targets, index) => {
    const week = cloned.weeks?.find((candidate) => candidate.weekNumber === targets.weekNumber)
      ?? cloned.weeks?.[index];
    volumeShortfalls.push(...buildTrainingPlanWeekVolumeShortfalls(
      normalizeTrainingPlanVolumeSessions(week?.sessions ?? []),
      targets,
    ));
  });

  if (volumeShortfalls.length > 0) cloned.volumeShortfalls = volumeShortfalls;
  else delete cloned.volumeShortfalls;
  return cloned;
}

/**
 * Final F7 invariant restoration. Quality enrichment and other late plan
 * mutators run after the main volume pass, so they can accidentally recreate
 * a doubled day. This pass is intentionally narrow: it never invents or
 * rewrites session content; it only relocates an active duplicate within the
 * same legal rolling week, or defers it with an honest shortfall when all
 * remaining days are occupied.
 */
export function enforceFinalTrainingPlanTwoADayCap(
  plan: CoordinatedTrainingPlan,
  request: FinalTrainingPlanTwoADayCapRequest,
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;
  if (String(request.twoADayPreference || '').trim().toLowerCase() !== 'never') return cloned;

  const shortfalls = [...(cloned.volumeShortfalls ?? [])];
  cloned.weeks = cloned.weeks.map((week) => {
    const weekNumber = typeof week.weekNumber === 'number' ? week.weekNumber : 1;
    const sessions = Array.isArray(week.sessions) ? week.sessions : [];
    const activeBefore = sessions.filter((session) => !isInactiveEnforcedSession(session)).length;
    const capped = enforceSingleSessionPerDay(
      sessions,
      allowedDaysForWeek(request.startDate, weekNumber),
    );
    const activeAfter = capped.filter((session) => !isInactiveEnforcedSession(session)).length;
    if (activeAfter < activeBefore) {
      const replacement: TrainingPlanVolumeShortfall = {
        weekNumber,
        kind: 'active',
        requested: activeBefore,
        achieved: activeAfter,
        reason: 'two_a_day_cap',
        provenance: 'coach_kernel_output',
      };
      const existingIndex = shortfalls.findIndex((item) => (
        item.weekNumber === weekNumber
        && item.kind === 'active'
        && item.reason === 'two_a_day_cap'
      ));
      if (existingIndex >= 0) shortfalls[existingIndex] = replacement;
      else shortfalls.push(replacement);
    }
    return { ...week, sessions: sortSessions(capped) };
  });
  if (shortfalls.length > 0) cloned.volumeShortfalls = shortfalls;
  return cloned;
}

function isInactiveEnforcedSession(session: CoordinatedTrainingSession): boolean {
  const state = String(session.scheduleState || '').toLowerCase();
  return state === 'deferred'
    || state === 'unscheduled'
    || state === 'dropped'
    || state === 'canceled'
    || state === 'cancelled';
}

/**
 * F7: relocate same-day extras to a free allowed day, keeping the first
 * session of each day in place. When no free allowed day remains the extra
 * is deferred with a reason instead of silently violating the preference.
 */
function enforceSingleSessionPerDay(
  sessions: CoordinatedTrainingSession[],
  allowedDays: readonly string[],
): CoordinatedTrainingSession[] {
  const next = sessions.map((session) => ({ ...session }));
  const occupiedDays = new Set(
    next
      .filter((session) => !isInactiveEnforcedSession(session))
      .map((session) => normalizeDay(session.dayOfWeek))
      .filter((day): day is string => Boolean(day)),
  );
  const activeByDay = new Map<string, number[]>();
  next.forEach((session, index) => {
    if (isInactiveEnforcedSession(session)) return;
    const day = normalizeDay(session.dayOfWeek);
    if (!day) return;
    const indexes = activeByDay.get(day) ?? [];
    indexes.push(index);
    activeByDay.set(day, indexes);
  });
  for (const [day, indexes] of activeByDay) {
    if (indexes.length < 2) continue;
    const keeperIndex = [...indexes].sort((left, right) => (
      singleSessionKeeperScore(next[right]) - singleSessionKeeperScore(next[left])
    ))[0];
    for (const index of indexes) {
      if (index === keeperIndex) continue;
      const session = next[index];
    const freeDay = allowedDays.find(
        (candidate) => !occupiedDays.has(candidate),
    );
    if (freeDay) {
      session.originalDayOfWeek = session.originalDayOfWeek ?? session.dayOfWeek;
      session.dayOfWeek = DAY_LABEL[freeDay] ?? freeDay;
      session.scheduleAdjustments = [...(session.scheduleAdjustments ?? []), 'reflowed'];
      session.scheduleReason = session.scheduleReason
        ?? 'Moved to its own day because two-a-day sessions are turned off for this athlete.';
      occupiedDays.add(freeDay);
      continue;
    }
    session.scheduleState = 'deferred';
    session.scheduleAdjustments = [...(session.scheduleAdjustments ?? []), 'deferred'];
    session.scheduleReason = session.scheduleReason
      ?? 'Deferred because two-a-day sessions are turned off and no free training day remained this week.';
    }
  }
  return next;
}

function singleSessionKeeperScore(session: CoordinatedTrainingSession): number {
  const token = `${session.sessionType || ''} ${session.title || ''}`.toLowerCase();
  if (inferTrainingSessionIsLongRun(session)) return 100;
  if (/\brace\b/.test(token)) return 95;
  if (/\b(interval|threshold|tempo)\b/.test(token)) return 80;
  if (isStrengthSession(session)) return 60;
  return 40;
}

function allowedDaysForWeek(startDate: string, weekNumber: number): string[] {
  if (weekNumber !== 1) return [...DAY_ORDER];
  const startIndex = dayIndexFromIsoDate(startDate);
  if (startIndex < 0) return [...DAY_ORDER];
  return [...DAY_ORDER.slice(startIndex)];
}

function constrainTrainingDays(
  allowedDays: readonly string[],
  requestedTrainingDays: number,
  longWorkoutDay: unknown,
): string[] {
  const budget = clamp(Math.round(requestedTrainingDays || 5), 1, 7);
  const normalizedAllowed = allowedDays.filter((day) => DAY_ORDER.includes(day as typeof DAY_ORDER[number]));
  if (normalizedAllowed.length <= budget) return [...normalizedAllowed];

  const protectedLongDay = normalizeDay(longWorkoutDay);
  const restPreference = ['sunday', 'monday', 'friday', 'thursday', 'tuesday', 'wednesday', 'saturday'];
  const days = [...normalizedAllowed];
  for (const restDay of restPreference) {
    if (days.length <= budget) break;
    if (restDay === protectedLongDay) continue;
    const index = days.indexOf(restDay);
    if (index >= 0) days.splice(index, 1);
  }
  return days.slice(0, budget);
}

function dayIndexFromIsoDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return -1;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return -1;
  const mondayIndex = (parsed.getUTCDay() + 6) % 7;
  return mondayIndex >= 0 && mondayIndex < DAY_ORDER.length ? mondayIndex : -1;
}

function normalizeSessionDay(session: CoordinatedTrainingSession): CoordinatedTrainingSession | null {
  const day = normalizeDay(session.dayOfWeek);
  if (!day) return null;
  return {
    ...session,
    dayOfWeek: DAY_LABEL[day],
  };
}

function normalizeTrainingPlanVolumeSessions(
  sessions: TrainingPlanVolumeSessionShape[],
): CoordinatedTrainingSession[] {
  return sessions
    .map((session) => normalizeSessionDay({
      ...session,
      dayOfWeek: String(session.dayOfWeek || ''),
      sessionType: String(session.sessionType || ''),
      title: String(session.title || ''),
      durationMinutes: typeof session.durationMinutes === 'number' ? session.durationMinutes : 0,
    }))
    .filter((session): session is CoordinatedTrainingSession => Boolean(session));
}

function isScheduledSession(session: CoordinatedTrainingSession): boolean {
  const type = String(session.sessionType || '').toLowerCase();
  if (type === 'rest' || type === 'mobility') return false;
  if (isStandaloneMobilitySession(session)) return false;
  return true;
}

function isStandaloneMobilitySession(session: CoordinatedTrainingSession): boolean {
  const combined = `${session.sessionType || ''} ${session.title || ''}`.toLowerCase();
  const exerciseCount = Array.isArray(session.exercises) ? session.exercises.length : 0;
  return combined.includes('mobility') && exerciseCount === 0;
}

function trimStrengthToTarget(
  sessions: CoordinatedTrainingSession[],
  strengthTarget: number,
): CoordinatedTrainingSession[] {
  let keptStrength = 0;
  return sessions.filter((session) => {
    if (!isStrengthSession(session)) return true;
    if (keptStrength >= strengthTarget) return false;
    keptStrength += 1;
    return true;
  });
}

function trimToActiveTarget(
  sessions: CoordinatedTrainingSession[],
  activeTarget: number,
  strengthTarget: number,
  protectedCardioTargets: { cycling: number | null; swimming: number | null },
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  while (next.length > activeTarget) {
    // Sessions covering an explicit per-modality ask are protected from the
    // score-based trim — otherwise a low removableScore (e.g. swims) can
    // delete exactly the sessions the user asked for.
    const protectedIndexes = protectedCardioIndexes(next, protectedCardioTargets);
    const removableIndex = next
      .map((session, index) => ({ session, index }))
      .sort((left, right) => removableScore(left.session) - removableScore(right.session))
      .find(({ session, index }) =>
        !protectedIndexes.has(index)
        && (!isStrengthSession(session) || countStrength(next) > strengthTarget))
      ?.index;
    if (removableIndex == null) break;
    next.splice(removableIndex, 1);
  }
  return next;
}

function protectedCardioIndexes(
  sessions: CoordinatedTrainingSession[],
  targets: { cycling: number | null; swimming: number | null },
): Set<number> {
  const kept = { cycling: 0, swimming: 0 };
  const indexes = new Set<number>();
  sessions.forEach((session, index) => {
    const modality = cardioModality(session);
    if (modality !== 'cycling' && modality !== 'swimming') return;
    const target = targets[modality];
    if (target == null || target <= 0) return;
    if (kept[modality] < target) {
      kept[modality] += 1;
      indexes.add(index);
    }
  });
  return indexes;
}

function trimCardioModalitiesToTargets(
  sessions: CoordinatedTrainingSession[],
  targets: {
    cycling: number | null;
    swimming: number | null;
  },
): CoordinatedTrainingSession[] {
  const counts = {
    cycling: 0,
    swimming: 0,
  };
  return sessions.filter((session) => {
    const modality = cardioModality(session);
    if (modality !== 'cycling' && modality !== 'swimming') return true;
    const target = targets[modality];
    if (target == null) return true;
    if (counts[modality] >= target) return false;
    counts[modality] += 1;
    return true;
  });
}

function spreadSameTypeCollisions(
  sessions: CoordinatedTrainingSession[],
  allowedDays: readonly string[],
): CoordinatedTrainingSession[] {
  const next = [...sessions];
  const seen = new Set<string>();

  for (let index = 0; index < next.length; index += 1) {
    const session = next[index];
    const bucket = isStrengthSession(session) ? 'strength' : 'cardio';
    const currentDay = normalizeDay(session.dayOfWeek);
    const key = `${currentDay}:${bucket}`;
    if (currentDay && !seen.has(key)) {
      seen.add(key);
      continue;
    }

    const replacementDay = chooseDayWithoutBucket(next, allowedDays, bucket);
    if (!replacementDay) continue;
    next[index] = {
      ...session,
      dayOfWeek: DAY_LABEL[replacementDay] ?? replacementDay,
    };
    seen.add(`${replacementDay}:${bucket}`);
  }

  return next;
}

function chooseDayWithoutBucket(
  sessions: CoordinatedTrainingSession[],
  allowedDays: readonly string[],
  bucket: 'strength' | 'cardio',
): string | null {
  const candidates = allowedDays.length > 0 ? allowedDays : [...DAY_ORDER];
  return candidates.find((day) => {
    const daySessions = sessions.filter((session) => normalizeDay(session.dayOfWeek) === day);
    if (daySessions.length >= 2) return false;
    return !daySessions.some((session) => (isStrengthSession(session) ? 'strength' : 'cardio') === bucket);
  }) ?? null;
}

function protectHeavyLowerBeforeLongRun(
  sessions: CoordinatedTrainingSession[],
  request: TrainingPlanVolumeRequest,
  sport: string | undefined,
  weekNumber: number,
): CoordinatedTrainingSession[] {
  const longRunDay = resolveLongRunDayForWeek(sessions, request.longWorkoutDay);
  if (!longRunDay) return sessions;

  const dayBeforeLongRun = previousDay(longRunDay);
  const next = sessions.map((session) => ({ ...session }));

  for (let index = 0; index < next.length; index += 1) {
    const session = next[index];
    if (normalizeDay(session.dayOfWeek) !== dayBeforeLongRun) continue;
    if (!inferTrainingSessionIsLowerHeavy(session)) continue;

    const swapIndex = findUpperStrengthSwapTarget(next, index, dayBeforeLongRun, longRunDay);
    if (swapIndex >= 0) {
      const originalDay = next[index].dayOfWeek;
      const replacementDay = next[swapIndex].dayOfWeek;
      next[index] = withScheduleAdjustment({
        ...next[index],
        dayOfWeek: replacementDay,
      }, `Moved away from the day before the long run to avoid heavy lower-body work before ${DAY_LABEL[longRunDay]}.`);
      next[swapIndex] = withScheduleAdjustment({
        ...next[swapIndex],
        dayOfWeek: originalDay,
      }, 'Moved into the pre-long-run strength slot as an upper-body-safe replacement.');
      continue;
    }

    next[index] = buildUpperBodyReplacementSession(next[index], sport, request, weekNumber);
  }

  return next;
}

function resolveLongRunDayForWeek(
  sessions: CoordinatedTrainingSession[],
  requestedLongWorkoutDay: unknown,
): string | null {
  const requested = normalizeDay(requestedLongWorkoutDay);
  const longSessions = sessions
    .map((session) => ({ session, day: normalizeDay(session.dayOfWeek) }))
    .filter((entry): entry is { session: CoordinatedTrainingSession; day: string } =>
      Boolean(entry.day) && inferTrainingSessionIsLongRun(entry.session)
    );

  return longSessions.find((entry) => !requested || entry.day === requested)?.day
    ?? longSessions[0]?.day
    ?? null;
}

function findUpperStrengthSwapTarget(
  sessions: CoordinatedTrainingSession[],
  offenderIndex: number,
  dayBeforeLongRun: string,
  longRunDay: string,
): number {
  const candidates = sessions
    .map((session, index) => ({ session, index, day: normalizeDay(session.dayOfWeek) }))
    .filter((entry): entry is { session: CoordinatedTrainingSession; index: number; day: string } =>
      entry.index !== offenderIndex
      && Boolean(entry.day)
      && entry.day !== dayBeforeLongRun
      && entry.day !== longRunDay
      && isStrengthSession(entry.session)
      && !inferTrainingSessionIsLowerHeavy(entry.session)
    )
    .sort((left, right) => {
      const leftScore = longRunSwapScore(left.day, longRunDay);
      const rightScore = longRunSwapScore(right.day, longRunDay);
      if (leftScore !== rightScore) return rightScore - leftScore;
      return daySortIndex(left.day) - daySortIndex(right.day);
    });

  return candidates[0]?.index ?? -1;
}

function longRunSwapScore(day: string, longRunDay: string): number {
  if (day === longRunDay) return 0;
  if (previousDay(longRunDay) === day || nextDay(longRunDay) === day) return 1;
  return 3;
}

function buildUpperBodyReplacementSession(
  original: CoordinatedTrainingSession,
  sport: string | undefined,
  request: TrainingPlanVolumeRequest,
  weekNumber: number,
): CoordinatedTrainingSession {
  const knowledge = safeLoadCoachKnowledge();
  const weekShift = Math.max(0, weekNumber - 1);
  const upperVariant = [1, 3]
    .map((slot) => buildStrengthSupportVariant(slot, knowledge, weekShift))
    .find((variant) => !inferTrainingSessionIsLowerHeavy({
      sessionType: 'gym',
      title: variant.title,
      exercises: variant.exercises as Array<Record<string, any>>,
    }));

  const planSport = String(sport || '').toLowerCase();
  const replacement = upperVariant
    ? {
        title: planSport === 'running' ? `Runner ${upperVariant.title}` : upperVariant.title,
        durationMinutes: upperVariant.durationMinutes,
        exercises: upperVariant.exercises as Array<Record<string, any>>,
      }
    : {
        title: planSport === 'running' ? 'Runner Upper Body Strength' : 'Upper Body Strength',
        durationMinutes: Math.min(Math.max(original.durationMinutes || 45, 35), 50),
        exercises: [
          { name: 'Dumbbell Bench Press', sets: 3, reps: '8-10', rir: 2, restSec: 75 },
          { name: 'Lat Pulldown', sets: 3, reps: '8-10', rir: 2, restSec: 75 },
          { name: 'One-Arm Dumbbell Row', sets: 3, reps: '10 each side', rir: 2, restSec: 60 },
          { name: 'Dead Bug', sets: 3, reps: '10 each side', rir: 3, restSec: 30 },
        ],
      };

  return withScheduleAdjustment({
    ...original,
    sessionType: 'gym',
    title: replacement.title,
    durationMinutes: replacement.durationMinutes,
    preferredStartTime: original.preferredStartTime ?? request.preferredStrengthTime,
    description: 'Upper-body strength slot substituted to avoid heavy lower-body work the day before the long run.',
    exercises: replacement.exercises,
  }, 'Converted from lower-body strength to upper-body strength before the long run.');
}

function withScheduleAdjustment(
  session: CoordinatedTrainingSession,
  adjustment: string,
): CoordinatedTrainingSession {
  return {
    ...session,
    scheduleAdjustments: [...(session.scheduleAdjustments ?? []), adjustment],
    scheduleReason: session.scheduleReason ?? adjustment,
  };
}

/**
 * Defensive loader. The coach knowledge files ship with the package
 * so the happy path never fails, but if a constrained test
 * environment can't reach them we let `buildStrengthSupportVariant`
 * fall back to its `MIN_CREDIBLE_STRENGTH_MINUTES` floor instead of
 * crashing the volume-enforcement pass.
 */
function safeLoadCoachKnowledge(): CoachKnowledgeBase | undefined {
  try {
    return loadCoachKnowledge();
  } catch {
    return undefined;
  }
}

function sortSessions(sessions: CoordinatedTrainingSession[]): CoordinatedTrainingSession[] {
  return [...sessions].sort((left, right) => {
    const dayDelta = daySortIndex(normalizeDay(left.dayOfWeek)) - daySortIndex(normalizeDay(right.dayOfWeek));
    if (dayDelta !== 0) return dayDelta;
    return timeToMinutes(left.preferredStartTime) - timeToMinutes(right.preferredStartTime);
  });
}

function applyPreferredTimes(
  sessions: CoordinatedTrainingSession[],
  request: TrainingPlanVolumeRequest,
): CoordinatedTrainingSession[] {
  return sessions.map((session) => ({
    ...session,
    preferredStartTime: session.preferredStartTime
      ?? (isStrengthSession(session) ? request.preferredStrengthTime : request.preferredCardioTime),
  }));
}

function removableScore(session: CoordinatedTrainingSession): number {
  if (isStandaloneMobilitySession(session)) return -1;
  // Brick work is additive transition practice, not a replacement for the
  // standalone run/bike/swim frequencies the athlete explicitly requested.
  if (session.sessionRole === 'brick' || /\bbrick\b/i.test(session.title || '')) return 0;
  if (/recovery|easy|support/i.test(session.title || '')) return 1;
  if (isStrengthSession(session)) return 3;
  return 2;
}

function isStrengthSession(session: CoordinatedTrainingSession): boolean {
  return String(session.sessionType || '').toLowerCase() === 'gym';
}

function cardioModality(session: CoordinatedTrainingSession): 'running' | 'cycling' | 'swimming' | null {
  const type = String(session.sessionType || '').toLowerCase();
  const title = String(session.title || '').toLowerCase();
  const combined = `${type} ${title}`;
  if (/\b(swim|swimming)\b/.test(combined)) return 'swimming';
  if (/\b(ride|bike|cycling|cycle)\b/.test(combined)) return 'cycling';
  if (/\b(run|running|jog)\b/.test(combined)) return 'running';
  return null;
}

function countStrength(sessions: CoordinatedTrainingSession[]): number {
  return sessions.filter(isStrengthSession).length;
}

function normalizeDay(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return DAY_ORDER.includes(normalized as typeof DAY_ORDER[number]) ? normalized : null;
}

function previousDay(day: string): string {
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  if (index < 0) return day;
  return DAY_ORDER[(index + DAY_ORDER.length - 1) % DAY_ORDER.length];
}

function nextDay(day: string): string {
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  if (index < 0) return day;
  return DAY_ORDER[(index + 1) % DAY_ORDER.length];
}

function daySortIndex(day: string | null): number {
  if (!day) return 99;
  const index = DAY_ORDER.indexOf(day as typeof DAY_ORDER[number]);
  return index >= 0 ? index : 99;
}

function timeToMinutes(value: unknown): number {
  const text = typeof value === 'string' ? value : '';
  if (!/^\d{2}:\d{2}$/.test(text)) return 12 * 60;
  const [hours, minutes] = text.split(':').map(Number);
  return (hours * 60) + minutes;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
