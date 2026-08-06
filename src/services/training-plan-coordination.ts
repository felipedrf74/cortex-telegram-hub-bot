// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ContentMeshContext,
  CookingMeshContext,
  FinanceMeshContext,
  SecretaryMeshContext,
  TrainingMeshContext,
} from './cross-agent-learning';
import type {
  TrainingDecisionReason,
  TrainingProfileFollowUpQuestion,
  TrainingProfileMissingData,
} from './coach-kernel/types';
import { materializeCanonicalTrainingExercise } from './training-exercise-identity';
import {
  getTrainingExerciseIdentityV1Mode,
  type RuntimeFlagScope,
  type TrainingExerciseIdentityV1Mode,
} from './runtime-flags';

export interface CoordinatedTrainingSession {
  dayOfWeek: string;
  sessionType: string;
  title: string;
  durationMinutes: number;
  description?: string;
  exercises?: any[];
  preferredStartTime?: string | null;
  /** Structured marker for safety-pause shaped sessions — the pause gate
   *  checks this flag, not the display title. */
  safetyPause?: boolean;
  scheduleState?: string;
  scheduleAdjustments?: string[];
  scheduleReason?: string;
  decisionReasons?: TrainingDecisionReason[];
  originalDayOfWeek?: string | null;
  sessionRole?: string;
  sessionRoleLabel?: string;
  sessionRoleSummary?: string;
  keySessionLabel?: string;
  intensitySummary?: unknown;
  intensityProfile?: unknown;
}

/**
 * F10 (Phase 3): a structured record of every gap between what the athlete
 * asked for and what the volume enforcer could actually place. Previously
 * the fill loops broke silently and the response simply under-delivered.
 */
export interface TrainingPlanVolumeShortfall {
  weekNumber: number;
  kind: 'active' | 'strength';
  requested: number;
  achieved: number;
  reason: 'no_available_day' | 'two_a_day_cap' | 'engine_output_shortfall';
  /** The shortfall compares the finalized plan with the coach engine's
   * output; the volume enforcer never manufactures substitute workouts. */
  provenance: 'coach_kernel_output';
}

export interface CoordinatedTrainingWeek {
  weekNumber: number;
  focus?: string;
  intensityPct?: number;
  sessions?: CoordinatedTrainingSession[];
  /**
   * Durable, user-readable coach explanations for this week. These remain a
   * string array and are intentionally distinct from structured
   * `decisionReasons`, which power typed response/audit consumers.
   */
  notes?: string[];
  decisionReasons?: TrainingDecisionReason[];
  /** Set by the plan generator when the week falls inside the pre-race
   *  strength cutoff window; the volume enforcer must not refill strength
   *  into such weeks. */
  strengthCutoffActive?: boolean;
}

export interface CoordinatedTrainingProfileQuality {
  completenessScore: number;
  confidenceScore: number;
  confidenceBand: 'high' | 'medium' | 'low';
  planQualityLimited: boolean;
  planningRiskFlags: string[];
  missingCriticalData: TrainingProfileMissingData[];
  followUpPrompts: TrainingProfileFollowUpQuestion[];
}

export interface CoordinatedTrainingPlan {
  planName?: string;
  sport?: string;
  periodization?: string;
  weeks?: CoordinatedTrainingWeek[];
  profileQuality?: CoordinatedTrainingProfileQuality;
  decisionReasons?: TrainingDecisionReason[];
  /** F10 (Phase 3): populated by the volume enforcer; see the type's doc. */
  volumeShortfalls?: TrainingPlanVolumeShortfall[];
}

export interface TrainingPlanCoordinationInput {
  sessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  longWorkoutDay?: string | null;
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  runProfile?: Record<string, any> | null;
  training: TrainingMeshContext | null;
  cooking: CookingMeshContext | null;
  finance: FinanceMeshContext | null;
  content: ContentMeshContext | null;
  secretary: SecretaryMeshContext | null;
  sharedDecisionContext?: string;
  env?: NodeJS.ProcessEnv;
  scope?: RuntimeFlagScope;
}

export interface TrainingPlanCoordination {
  promptBlock: string;
  sharedDecisionContext: string;
  weeklySessionTarget: number;
  strengthSessionTarget: number;
  resolvedLongWorkoutDay: string | null;
  protectFilmingDay: string | null;
  maxHardSessionsPerWeek: number;
  conservativeFirstWeek: boolean;
  firstWeekIntensityReductionPct: number;
  lowCostBias: boolean;
  progressionRampCapPct: number;
  maxConsecutiveActiveDays: number;
  protectImpactSpacing: boolean;
  protectLowerBodySpacing: boolean;
  protectRecoveryAfterLongSession: boolean;
  modularSessionBias: boolean;
  protectFocusDay: string | null;
  selectiveTrainingSpend: boolean;
}

export interface TrainingPlanCoordinationApplyOptions {
  exerciseIdentityMode?: TrainingExerciseIdentityV1Mode;
}

const COORDINATION_EMITTER_CANONICAL_IDS: Readonly<Record<string, string>> = Object.freeze({
  'Push-Up / DB Floor Press': 'dumbbell_floor_press',
  'One-Arm Row': 'one_arm_dumbbell_row',
});

// Runtime-only rollout context must not become part of the enumerable
// coordination contract (which is serialized/compared by legacy callers).
const COORDINATION_IDENTITY_MODES = new WeakMap<TrainingPlanCoordination, TrainingExerciseIdentityV1Mode>();

const VALID_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

type AthleteConstraintProfile = {
  experienceBand: 'beginner' | 'intermediate' | 'advanced';
  beginner: boolean;
  impactSensitive: boolean;
  lowerBodySensitive: boolean;
  injuryNotes: string[];
};

export function buildTrainingPlanCoordination(input: TrainingPlanCoordinationInput): TrainingPlanCoordination {
  const requestedSessions = clamp(Math.round(input.sessionsPerWeek || 5), 3, 7);
  const requestedStrength = clamp(Math.round(input.strengthSessionsPerWeek || 0), 0, 6);

  const recoveryState = extractRecoveryState(input.training);
  const cookingRisk = extractCookingRisk(input.cooking);
  const budget = extractBudget(input.finance);
  const filmingDay = extractFilmingDay(input.content);
  const athlete = extractAthleteConstraintProfile(input.fitnessProfile, input.gymProfile, input.runProfile);
  const secretary = extractSecretaryConstraints(input.secretary);
  const secretaryFeedback = input.training?.secretaryFeedback ?? null;
  const secretaryPlacementUncertain = secretaryFeedback != null
    && ['deferred', 'unscheduled', 'needs_more_context'].includes(secretaryFeedback.status);
  const secretaryCapacityPressure = secretaryPlacementUncertain || secretaryFeedback?.status === 'compressed';
  const selectiveTrainingSpend = budget?.trainingSpendMode === 'selective';

  const conservativeFirstWeek = recoveryState === 'critical'
    || recoveryState === 'strained'
    || cookingRisk.fuelingSupportStatus === 'at_risk'
    || cookingRisk.mealExecutionStatus === 'at_risk'
    || budget?.budgetMode === 'tight'
    || athlete.beginner
    || secretaryCapacityPressure;

  const firstWeekIntensityReductionPct = clamp(
    (recoveryState === 'critical'
      ? 12
      : recoveryState === 'strained' || cookingRisk.fuelingSupportStatus === 'at_risk' || cookingRisk.mealExecutionStatus === 'at_risk'
        ? 8
        : budget?.budgetMode === 'controlled'
          ? 4
          : 0)
      + (athlete.beginner ? 4 : 0)
      + (athlete.impactSensitive ? 4 : 0)
      + (secretaryFeedback?.status === 'compressed' ? 4 : secretaryPlacementUncertain ? 6 : 0),
    0,
    18,
  );

  const maxHardSessionsPerWeek = athlete.beginner
    ? 1
    : recoveryState === 'critical' || recoveryState === 'strained'
    ? 1
    : cookingRisk.fuelingSupportStatus === 'at_risk' || cookingRisk.mealExecutionStatus === 'partial' || budget?.budgetMode === 'tight'
      ? 2
      : selectiveTrainingSpend
        ? 2
      : requestedSessions >= 6
        ? 3
        : 2;

  const baseWeeklySessionTarget = athlete.beginner
    ? Math.min(requestedSessions, 5)
    : budget?.budgetMode === 'tight'
      ? Math.min(requestedSessions, 4)
    // Missing meal execution is an advisory recovery/fueling signal, not
    // evidence that the athlete has one fewer usable training day. Keep the
    // explicit frequency and apply the conservative-week + hard-session
    // safeguards above; genuine Secretary capacity can still lower this cap.
    : selectiveTrainingSpend
      ? Math.min(requestedSessions, 5)
      : requestedSessions;

  const lowCostBias = budget?.budgetMode === 'tight' || budget?.budgetMode === 'controlled' || selectiveTrainingSpend;
  const resolvedLongWorkoutDay = resolveLongWorkoutDay(input.longWorkoutDay ?? null, filmingDay);
  const progressionRampCapPct = athlete.beginner || recoveryState === 'critical'
    ? 4
    : recoveryState === 'strained' || athlete.impactSensitive || athlete.lowerBodySensitive
      ? 6
      : 8;
  const maxConsecutiveActiveDays = recoveryState === 'critical'
    ? 2
    : athlete.beginner || athlete.impactSensitive || athlete.lowerBodySensitive
      ? 3
      : 4;
  const protectImpactSpacing = athlete.impactSensitive || recoveryState === 'critical' || recoveryState === 'strained';
  const protectLowerBodySpacing = athlete.lowerBodySensitive;
  const protectRecoveryAfterLongSession = athlete.beginner || athlete.impactSensitive || recoveryState === 'critical' || recoveryState === 'strained';
  const modularSessionBias = secretary.adminPressure === 'high'
    || secretary.travelWeekdays.length > 0
    || secretaryCapacityPressure;
  const protectFocusDay = secretary.focusDay;

  const weeklySessionTarget = modularSessionBias
    ? Math.min(baseWeeklySessionTarget, 5)
    : baseWeeklySessionTarget;
  // The Secretary limit is final capacity truth. Strength coverage cannot
  // retain a pre-limit target and then add sessions back after the weekly cap.
  const strengthSessionTarget = athlete.beginner
    ? Math.min(requestedStrength, 2, weeklySessionTarget)
    : selectiveTrainingSpend
      ? Math.min(requestedStrength, 2, weeklySessionTarget)
      : Math.min(requestedStrength, weeklySessionTarget);
  const secretaryScheduleHardCap = secretary.adminPressure === 'high'
    ? Math.min(maxHardSessionsPerWeek, 1)
    : secretary.travelWeekdays.length > 0
      ? Math.min(maxHardSessionsPerWeek, 2)
      : maxHardSessionsPerWeek;
  const secretaryHardCap = secretaryPlacementUncertain
    ? Math.min(secretaryScheduleHardCap, 1)
    : secretaryFeedback?.status === 'compressed'
      ? Math.min(secretaryScheduleHardCap, 2)
      : secretaryScheduleHardCap;

  const guidance = compact([
    conservativeFirstWeek
      ? `Start week 1 conservatively and only progress once recovery, fueling, and schedule capacity look stable.`
      : null,
    athlete.beginner
      ? `Treat the athlete like a beginner for progression: prioritize repeatability, controlled RPE, and clean movement over aggressive overload.`
      : null,
    `Cap truly hard sessions at ${secretaryHardCap} per week until the plan earns more load.`,
    `Keep week-to-week intensity jumps within ${progressionRampCapPct} points unless there is a clear deload or race-specific reason not to.`,
    resolvedLongWorkoutDay
      ? `Anchor the longest session on ${capitalizeDay(resolvedLongWorkoutDay)} unless the calendar makes the adjacent day clearly safer.`
      : null,
    filmingDay
      ? `Keep ${capitalizeDay(filmingDay)} lower-fatigue when possible because Content currently prefers that day for filming.`
      : null,
    lowCostBias
      ? `Avoid recommending new paid equipment, premium classes, or supplement-dependent strategies; prefer current equipment and lower-friction execution.`
      : null,
    selectiveTrainingSpend
      ? `Keep non-key training locally executable and stripped of optional spend-heavy complexity while training spend mode stays selective.`
      : null,
    budget?.supplementMode
      ? `Treat supplements as ${budget.supplementMode} rather than as a requirement for the plan to work.`
      : null,
    cookingRisk.fuelingSupportStatus === 'at_risk'
      ? `Do not stack multiple hard sessions until meal support exists for the hardest training days.`
      : null,
    cookingRisk.mealExecutionStatus === 'partial'
      ? `Favor repeatable session structure because meal execution still needs cleanup this week.`
      : null,
    protectImpactSpacing
      ? `Avoid back-to-back impact-heavy run days; use lower-impact aerobic support or mobility between them when needed.`
      : null,
    protectLowerBodySpacing
      ? `Keep lower-body strength at least one easier day away from the longest or hardest impact session whenever possible.`
      : null,
    protectRecoveryAfterLongSession
      ? `Protect the day after the longest session as recovery-biased unless the plan has a compelling reason to do otherwise.`
      : null,
    trainingSecretaryFeedbackGuidance(secretaryFeedback),
    secretary.travelWeekdays.length > 0
      ? `Travel is currently flagged on ${secretary.travelWeekdays.map(capitalizeDay).join(', ')}, so keep the plan modular and avoid placing the biggest session on those days.`
      : null,
    modularSessionBias
      ? `Bias toward modular sub-60-minute sessions on non-key days because Secretary shows real calendar or admin pressure this week.`
      : null,
    protectFocusDay
      ? `Keep ${capitalizeDay(protectFocusDay)} lighter when possible because Secretary is protecting that day for focus or admin work.`
      : null,
    athlete.injuryNotes.length > 0
      ? `Respect current or recent injury constraints: ${athlete.injuryNotes.join(', ')}.`
      : null,
  ]);

  const coordination: TrainingPlanCoordination = {
    promptBlock: guidance.length > 0
      ? guidance.map((line) => `- ${line}`).join('\n')
      : '- No extra cross-skill coaching constraints detected.',
    sharedDecisionContext: input.sharedDecisionContext?.trim() || '',
    weeklySessionTarget,
    strengthSessionTarget,
    resolvedLongWorkoutDay,
    protectFilmingDay: filmingDay,
    maxHardSessionsPerWeek: secretaryHardCap,
    conservativeFirstWeek,
    firstWeekIntensityReductionPct,
    lowCostBias,
    progressionRampCapPct,
    maxConsecutiveActiveDays,
    protectImpactSpacing,
    protectLowerBodySpacing,
    protectRecoveryAfterLongSession,
    modularSessionBias,
    protectFocusDay,
    selectiveTrainingSpend,
  };
  const exerciseIdentityMode = getTrainingExerciseIdentityV1Mode(input.env ?? process.env, input.scope);
  if (exerciseIdentityMode !== 'off') {
    COORDINATION_IDENTITY_MODES.set(coordination, exerciseIdentityMode);
  }
  return coordination;
}

export function applyTrainingPlanCoordination(
  plan: CoordinatedTrainingPlan,
  coordination: TrainingPlanCoordination,
  options: TrainingPlanCoordinationApplyOptions = {},
): CoordinatedTrainingPlan {
  const cloned: CoordinatedTrainingPlan = JSON.parse(JSON.stringify(plan ?? {}));
  if (!Array.isArray(cloned.weeks)) return cloned;

  cloned.weeks = cloned.weeks.map((week, index) => {
    const sessions = Array.isArray(week.sessions) ? week.sessions.map((session) => ({ ...session })) : [];

    if (coordination.resolvedLongWorkoutDay) {
      moveLongSessionToPreferredDay(sessions, coordination.resolvedLongWorkoutDay);
    }

    if (coordination.strengthSessionTarget >= 0) {
      rebalanceStrengthSessions(sessions, coordination.strengthSessionTarget);
    }

    if (coordination.protectFilmingDay) {
      lightenFilmingDay(sessions, coordination.protectFilmingDay);
    }

    if (coordination.protectFocusDay) {
      lightenFocusDay(sessions, coordination.protectFocusDay);
    }

    if (coordination.protectImpactSpacing) {
      reduceConsecutiveImpactDays(sessions);
    }

    if (coordination.protectLowerBodySpacing) {
      softenLowerBodyLoadNearImpactDays(sessions);
    }

    capHardSessions(sessions, coordination.maxHardSessionsPerWeek);

    if (coordination.protectRecoveryAfterLongSession) {
      protectRecoveryAfterLongestSession(sessions);
    }

    enforceWeeklySessionCap(
      sessions,
      coordination.weeklySessionTarget,
      coordination.strengthSessionTarget,
    );
    ensureStrengthSupportCoverage(sessions, coordination, cloned.sport);
    ensureWeeklyVolumeFloor(sessions, coordination, cloned.sport);
    // Coverage helpers may only fill genuinely free capacity, but keep the
    // final invariant explicit so later insertion strategies cannot regress it.
    enforceWeeklySessionCap(
      sessions,
      coordination.weeklySessionTarget,
      coordination.strengthSessionTarget,
    );
    enforceActiveDayStreakCap(sessions, coordination.maxConsecutiveActiveDays);

    if (coordination.lowCostBias) {
      applyLowCostBias(sessions);
    }

    if (coordination.modularSessionBias) {
      applyModularSessionBias(sessions);
    }

    return {
      ...week,
      intensityPct: index === 0 && coordination.firstWeekIntensityReductionPct > 0
        ? Math.max(50, Number(week.intensityPct || 70) - coordination.firstWeekIntensityReductionPct)
        : week.intensityPct,
      sessions,
    };
  });

  capWeekToWeekProgression(cloned.weeks, coordination.progressionRampCapPct);

  return normalizeCoordinatedExerciseIdentities(
    cloned,
    options.exerciseIdentityMode
      ?? COORDINATION_IDENTITY_MODES.get(coordination)
      ?? getTrainingExerciseIdentityV1Mode(process.env),
  );
}

function normalizeCoordinatedExerciseIdentities(
  plan: CoordinatedTrainingPlan,
  mode: TrainingExerciseIdentityV1Mode,
): CoordinatedTrainingPlan {
  if (mode === 'off' || !Array.isArray(plan.weeks)) return plan;
  plan.weeks = plan.weeks.map((week) => ({
    ...week,
    sessions: Array.isArray(week.sessions)
      ? week.sessions.map((session) => ({
          ...session,
          exercises: Array.isArray(session.exercises)
            ? session.exercises.map((exercise) => {
                if ((!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) && mode === 'shadow') {
                  materializeCanonicalTrainingExercise({ name: String(exercise ?? '') }, {
                    env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: mode },
                    source: 'training-plan-coordination',
                  });
                  return exercise;
                }
                const record = exercise && typeof exercise === 'object'
                  ? exercise as Record<string, unknown>
                  : { name: String(exercise ?? '') };
                const name = typeof record.name === 'string' ? record.name.trim() : '';
                return materializeCanonicalTrainingExercise(record, {
                  canonicalId: COORDINATION_EMITTER_CANONICAL_IDS[name],
                  env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: mode },
                  source: 'training-plan-coordination',
                });
              })
            : session.exercises,
        }))
      : week.sessions,
  }));
  return plan;
}

function moveLongSessionToPreferredDay(sessions: CoordinatedTrainingSession[], preferredDay: string): void {
  const longIndex = sessions.findIndex((session) => isLongSession(session));
  if (longIndex < 0) return;

  const normalizedPreferredDay = normalizeDay(preferredDay);
  if (!normalizedPreferredDay || normalizeDay(sessions[longIndex].dayOfWeek) === normalizedPreferredDay) return;

  const targetIndex = sessions.findIndex((session) => normalizeDay(session.dayOfWeek) === normalizedPreferredDay);
  if (targetIndex >= 0 && targetIndex !== longIndex) {
    const originalDay = sessions[longIndex].dayOfWeek;
    sessions[targetIndex].dayOfWeek = originalDay;
  }

  sessions[longIndex].dayOfWeek = normalizedPreferredDay;
}

function rebalanceStrengthSessions(sessions: CoordinatedTrainingSession[], targetStrengthSessions: number): void {
  const strengthSessions = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.sessionType === 'gym');

  if (strengthSessions.length <= targetStrengthSessions) return;

  for (const extra of strengthSessions.slice(targetStrengthSessions)) {
    sessions[extra.index] = toMobilitySession(
      extra.session,
      'Keep this slot as recovery-oriented work so the week does not become strength-heavy too early.',
    );
  }
}

function lightenFilmingDay(sessions: CoordinatedTrainingSession[], filmingDay: string): void {
  const targetDay = normalizeDay(filmingDay);
  if (!targetDay) return;

  const filmingIndex = sessions.findIndex((session) => normalizeDay(session.dayOfWeek) === targetDay && isHighDemandSession(session));
  if (filmingIndex < 0) return;

  const session = sessions[filmingIndex];
  sessions[filmingIndex] = session.sessionType === 'gym'
    ? toMobilitySession(session, 'Content filming is favored on this day, so keep the training demand low.')
    : toRecoveryCardioSession(session, 'Content filming is favored on this day, so keep the session smooth and non-taxing.');
}

function capHardSessions(sessions: CoordinatedTrainingSession[], maxHardSessions: number): void {
  const hardSessions = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => isHighDemandSession(session))
    .sort((a, b) => {
      const priorityDelta = hardSessionPriority(b.session) - hardSessionPriority(a.session);
      if (priorityDelta !== 0) return priorityDelta;
      return daySortIndex(normalizeDay(a.session.dayOfWeek)) - daySortIndex(normalizeDay(b.session.dayOfWeek));
    });

  if (hardSessions.length <= maxHardSessions) return;

  for (const extra of hardSessions.slice(maxHardSessions)) {
    const session = extra.session;
    sessions[extra.index] = session.sessionType === 'gym'
      ? toMobilitySession(session, 'This slot was softened so the week keeps only the highest-value hard work.')
      : toRecoveryCardioSession(session, 'This slot was softened so the week keeps only the highest-value hard work.');
  }
}

function enforceWeeklySessionCap(
  sessions: CoordinatedTrainingSession[],
  cap: number,
  protectedStrengthTarget = 0,
): void {
  const activeEntries = () => sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => session.sessionType !== 'rest');
  const groupActiveEntriesByDay = () => {
    const grouped = new Map<string, ReturnType<typeof activeEntries>>();
    for (const entry of activeEntries()) {
      const day = normalizeDay(entry.session.dayOfWeek);
      if (!day) continue;
      const entries = grouped.get(day) ?? [];
      entries.push(entry);
      grouped.set(day, entries);
    }
    return grouped;
  };
  let activeByDay = groupActiveEntriesByDay();

  // `weeklySessionTarget` is the requested training-DAY budget. Counting
  // physical rows here silently destroyed legal run+strength doubles before
  // the volume/two-a-day authority could apply the user's actual preference.
  if (activeByDay.size <= cap) return;

  // First collapse excess DAYS by moving a whole day group onto an already
  // active day with a free second slot. This preserves authored sessions and
  // lets the downstream two-a-day authority either keep, relocate, or defer
  // the double according to the actual request.
  while (activeByDay.size > cap) {
    const sourceDays = [...activeByDay.entries()].sort(([leftDay, left], [rightDay, right]) => {
      const leftScore = Math.max(...left.map(({ session }) => removableSessionScore(session)));
      const rightScore = Math.max(...right.map(({ session }) => removableSessionScore(session)));
      return leftScore - rightScore || daySortIndex(leftDay) - daySortIndex(rightDay);
    });
    let moved = false;
    for (const [sourceDay, sourceEntries] of sourceDays) {
      const target = [...activeByDay.entries()]
        .filter(([targetDay, targetEntries]) => (
          targetDay !== sourceDay && targetEntries.length + sourceEntries.length <= 2
        ))
        .sort(([leftDay], [rightDay]) => daySortIndex(leftDay) - daySortIndex(rightDay))[0];
      if (!target) continue;
      const [targetDay] = target;
      for (const entry of sourceEntries) {
        const originalDay = entry.session.dayOfWeek;
        sessions[entry.index] = {
          ...entry.session,
          originalDayOfWeek: entry.session.originalDayOfWeek ?? originalDay,
          dayOfWeek: capitalizeDay(targetDay),
          scheduleState: 'reflowed',
          scheduleAdjustments: [...(entry.session.scheduleAdjustments ?? []), 'reflowed'],
          scheduleReason: entry.session.scheduleReason
            ?? 'Moved onto an existing training day so the plan preserves its requested distinct-day budget.',
        };
      }
      moved = true;
      break;
    }
    if (!moved) break;
    activeByDay = groupActiveEntriesByDay();
  }
  if (activeByDay.size <= cap) return;

  const activeSessions = activeEntries();

  let protectedStrength = 0;
  const protectedStrengthIndexes = new Set<number>();
  // When strength alone consumes the entire distinct-day budget, protecting
  // every strength row would make the only removable day a key endurance
  // day (for example the anchored long run). The later strength-quality and
  // volume passes own that high-frequency split; reserve protection here for
  // support-strength mixes where another modality still has day capacity.
  const strengthProtectionLimit = protectedStrengthTarget < cap ? protectedStrengthTarget : 0;
  for (const { session, index } of activeSessions) {
    if (session.sessionType !== 'gym' || protectedStrength >= strengthProtectionLimit) continue;
    protectedStrength += 1;
    protectedStrengthIndexes.add(index);
  }

  const removableDays = [...activeByDay.entries()]
    // Removing only one row from a doubled day does not reduce the distinct
    // day count. A removable day must therefore contain no protected row.
    .filter(([, entries]) => entries.every(({ index }) => !protectedStrengthIndexes.has(index)))
    .sort(([leftDay, left], [rightDay, right]) => {
      const leftScore = Math.min(...left.map(({ session }) => removableSessionScore(session)));
      const rightScore = Math.min(...right.map(({ session }) => removableSessionScore(session)));
      return leftScore - rightScore || daySortIndex(leftDay) - daySortIndex(rightDay);
    });

  for (const [, entries] of removableDays.slice(0, activeByDay.size - cap)) {
    for (const extra of entries) {
      sessions[extra.index] = {
        dayOfWeek: extra.session.dayOfWeek,
        sessionType: 'rest',
        title: 'Rest / Recovery',
        durationMinutes: 0,
        description: 'Use this as full recovery, mobility, or an easy walk only if it helps you feel better.',
        exercises: [],
      };
    }
  }
}

function ensureStrengthSupportCoverage(
  sessions: CoordinatedTrainingSession[],
  coordination: TrainingPlanCoordination,
  sport?: string,
): void {
  const target = coordination.strengthSessionTarget;
  if (target <= 0) return;

  const currentStrengthCount = sessions.filter((session) => session.sessionType === 'gym').length;
  const missingStrength = target - currentStrengthCount;
  if (missingStrength <= 0) return;
  const remainingWeeklyCapacity = Math.max(
    0,
    coordination.weeklySessionTarget - sessions.filter(isActiveSession).length,
  );
  if (remainingWeeklyCapacity <= 0) return;

  const candidateDays = rankedFreeDaysForInsertion(sessions, coordination, 'strength');
  for (const day of candidateDays.slice(0, Math.min(missingStrength, remainingWeeklyCapacity))) {
    const support = buildStrengthSupportSession(day, sport);
    if (support) {
      sessions.push(support);
    }
  }
}

function ensureWeeklyVolumeFloor(
  sessions: CoordinatedTrainingSession[],
  coordination: TrainingPlanCoordination,
  sport?: string,
): void {
  const target = coordination.weeklySessionTarget;
  const currentActiveCount = sessions.filter(isActiveSession).length;
  const missingSessions = target - currentActiveCount;
  if (missingSessions <= 0) return;

  const candidateDays = rankedFreeDaysForInsertion(sessions, coordination, 'aerobic');
  for (const day of candidateDays.slice(0, missingSessions)) {
    const support = buildSupportSession(day, sport);
    if (support) {
      sessions.push(support);
    }
  }
}

function applyLowCostBias(sessions: CoordinatedTrainingSession[]): void {
  for (const session of sessions) {
    if (session.sessionType === 'rest') continue;
    const note = session.sessionType === 'gym'
      ? 'Use current equipment only and skip any optional spend-heavy add-ons.'
      : 'Prefer the simplest execution option you already have available.';
    if (!session.description?.includes(note)) {
      session.description = compact([session.description, note]).join(' ');
    }
  }
}

function applyModularSessionBias(sessions: CoordinatedTrainingSession[]): void {
  for (const session of sessions) {
    if (!isActiveSession(session) || isLongSession(session) || isHighDemandSession(session)) continue;
    session.durationMinutes = Math.min(session.durationMinutes || 45, 55);
    const note = 'Keep this session modular so it still fits on a high-friction day.';
    if (!session.description?.includes(note)) {
      session.description = compact([session.description, note]).join(' ');
    }
  }
}

function reduceConsecutiveImpactDays(sessions: CoordinatedTrainingSession[]): void {
  const ordered = orderedSessionEntries(sessions);

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!areAdjacentDays(previous.day, current.day)) continue;
    if (!isImpactSession(previous.session) || !isImpactSession(current.session)) continue;

    const soften = hardSessionPriority(previous.session) <= hardSessionPriority(current.session) ? previous : current;
    sessions[soften.index] = toLowImpactRecoverySession(
      soften.session,
      'Back-to-back impact days were softened to reduce injury-risk and improve recovery.',
    );
  }
}

function lightenFocusDay(sessions: CoordinatedTrainingSession[], focusDay: string): void {
  const targetDay = normalizeDay(focusDay);
  if (!targetDay) return;

  const focusIndex = sessions.findIndex((session) => normalizeDay(session.dayOfWeek) === targetDay && isHighDemandSession(session));
  if (focusIndex < 0) return;

  const session = sessions[focusIndex];
  sessions[focusIndex] = session.sessionType === 'gym'
    ? toMobilitySession(session, 'Secretary is protecting this day for focus or admin work, so training demand was softened.')
    : toRecoveryCardioSession(session, 'Secretary is protecting this day for focus or admin work, so training demand was softened.');
}

function softenLowerBodyLoadNearImpactDays(sessions: CoordinatedTrainingSession[]): void {
  const ordered = orderedSessionEntries(sessions);

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (!isLowerBodyLoadSession(current.session)) continue;

    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    const nearImpact = [previous, next].find((entry) => {
      if (!entry) return false;
      return areAdjacentDays(entry.day, current.day) && isImpactSession(entry.session) && isHighDemandSession(entry.session);
    });
    if (!nearImpact) continue;

    sessions[current.index] = toMobilitySession(
      current.session,
      'This lower-body slot was softened to keep more room around a nearby hard impact session.',
    );
  }
}

function protectRecoveryAfterLongestSession(sessions: CoordinatedTrainingSession[]): void {
  const ordered = orderedSessionEntries(sessions);
  const longIndex = ordered.findIndex((entry) => isLongSession(entry.session));
  if (longIndex < 0 || longIndex === ordered.length - 1) return;

  const next = ordered[longIndex + 1];
  if (!areAdjacentDays(ordered[longIndex].day, next.day) || !isActiveSession(next.session)) return;

  // Stronger guarantee: recovery bias may soften an explicitly requested
  // endurance session, but it must not erase that modality by relabelling a
  // technique swim or easy ride as standalone mobility. The volume pass
  // deliberately excludes standalone mobility and would otherwise report an
  // engine-output shortfall for a session the coach actually authored.
  sessions[next.index] = next.session.sessionType === 'gym'
    ? toMobilitySession(next.session, 'The day after the longest session should stay recovery-oriented.')
    : isEnduranceCardioSession(next.session)
      ? toRecoveryCardioSession(next.session, 'The day after the longest session should stay recovery-oriented.')
      : toLowImpactRecoverySession(next.session, 'The day after the longest session should stay recovery-oriented.');
}

function enforceActiveDayStreakCap(sessions: CoordinatedTrainingSession[], maxConsecutiveActiveDays: number): void {
  if (maxConsecutiveActiveDays >= VALID_DAYS.length) return;

  for (let attempt = 0; attempt < sessions.length; attempt += 1) {
    const activeEntries = orderedSessionEntries(sessions).filter(({ session }) => isActiveSession(session));
    const activeDays = new Set(activeEntries.map(({ day }) => day));
    const violatingRun = firstViolatingActiveDayRun(activeDays, maxConsecutiveActiveDays);
    if (!violatingRun) return;

    const activeEntriesByDay = new Map<string, typeof activeEntries>();
    for (const entry of activeEntries) {
      const entries = activeEntriesByDay.get(entry.day) ?? [];
      entries.push(entry);
      activeEntriesByDay.set(entry.day, entries);
    }
    const freeDays = VALID_DAYS.filter((day) => !activeDays.has(day));
    const candidateDays = violatingRun
      .map((day) => ({ day, entries: activeEntriesByDay.get(day) ?? [] }))
      .filter(({ entries }) => entries.length > 0)
      .sort((left, right) => {
        // Prefer moving low-value support groups and leave long/key work on
        // its anchored day whenever another whole-day reflow is feasible.
        const leftScore = Math.max(...left.entries.map(({ session }) => removableSessionScore(session)));
        const rightScore = Math.max(...right.entries.map(({ session }) => removableSessionScore(session)));
        return leftScore - rightScore || daySortIndex(left.day) - daySortIndex(right.day);
      });

    let reflowed = false;
    for (const candidate of candidateDays) {
      for (const freeDay of freeDays) {
        const simulatedDays = new Set(activeDays);
        simulatedDays.delete(candidate.day);
        simulatedDays.add(freeDay);
        if (longestActiveDayStreak(simulatedDays) > maxConsecutiveActiveDays) continue;

        const reason = 'Moved to preserve a recovery break without dropping the requested weekly modality mix.';
        for (const entry of candidate.entries) {
          const originalDay = entry.session.dayOfWeek;
          sessions[entry.index] = {
            ...entry.session,
            originalDayOfWeek: entry.session.originalDayOfWeek ?? originalDay,
            dayOfWeek: capitalizeDay(freeDay),
            scheduleState: 'reflowed',
            scheduleAdjustments: [...(entry.session.scheduleAdjustments ?? []), 'reflowed'],
            scheduleReason: entry.session.scheduleReason ?? reason,
          };
        }
        reflowed = true;
        break;
      }
      if (reflowed) break;
    }
    if (reflowed) continue;

    const fallbackDay = violatingRun[maxConsecutiveActiveDays] ?? violatingRun[violatingRun.length - 1];
    const fallbackEntries = activeEntriesByDay.get(fallbackDay) ?? [];
    if (fallbackEntries.length === 0) return;
    for (const fallback of fallbackEntries) {
      sessions[fallback.index] = toRestSession(
        fallback.session,
        'This slot was converted to recovery so the active-day streak stays manageable.',
      );
    }
  }
}

function firstViolatingActiveDayRun(
  activeDays: ReadonlySet<string>,
  maxConsecutiveActiveDays: number,
): string[] | null {
  let current: string[] = [];
  for (const day of VALID_DAYS) {
    if (activeDays.has(day)) {
      current.push(day);
      continue;
    }
    if (current.length > maxConsecutiveActiveDays) return current;
    current = [];
  }
  return current.length > maxConsecutiveActiveDays ? current : null;
}

function longestActiveDayStreak(activeDays: ReadonlySet<string>): number {
  let longest = 0;
  let current = 0;
  for (const day of VALID_DAYS) {
    current = activeDays.has(day) ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function capWeekToWeekProgression(weeks: CoordinatedTrainingWeek[], rampCapPct: number): void {
  let previousIntensity: number | null = null;

  for (const week of weeks) {
    const current: number = typeof week.intensityPct === 'number' ? week.intensityPct : (previousIntensity ?? 70);
    if (previousIntensity != null) {
      week.intensityPct = Math.min(current, previousIntensity + rampCapPct);
    } else {
      week.intensityPct = current;
    }
    previousIntensity = week.intensityPct ?? current;
  }
}

function toMobilitySession(session: CoordinatedTrainingSession, reason: string): CoordinatedTrainingSession {
  return {
    dayOfWeek: session.dayOfWeek,
    sessionType: 'mobility',
    title: 'Mobility + Recovery',
    durationMinutes: Math.min(Math.max(Math.round((session.durationMinutes || 30) * 0.6), 25), 40),
    description: `${reason} Use controlled mobility, easy core, and tissue-quality work.`,
    exercises: [],
  };
}

function toLowImpactRecoverySession(session: CoordinatedTrainingSession, reason: string): CoordinatedTrainingSession {
  return {
    dayOfWeek: session.dayOfWeek,
    sessionType: 'mobility',
    title: 'Low-Impact Recovery',
    durationMinutes: Math.min(Math.max(Math.round((session.durationMinutes || 35) * 0.65), 25), 40),
    description: `${reason} Prefer bike, rower, elliptical, or a brisk walk if available; otherwise keep it mobility-focused.`,
    exercises: [],
  };
}

function toRestSession(session: CoordinatedTrainingSession, reason: string): CoordinatedTrainingSession {
  return {
    dayOfWeek: session.dayOfWeek,
    sessionType: 'rest',
    title: 'Rest / Recovery',
    durationMinutes: 0,
    description: `${reason} Keep this day light so the rest of the week stays productive.`,
    exercises: [],
  };
}

function toRecoveryCardioSession(session: CoordinatedTrainingSession, reason: string): CoordinatedTrainingSession {
  return {
    dayOfWeek: session.dayOfWeek,
    sessionType: isEnduranceCardioSession(session) ? session.sessionType : 'run',
    title: 'Aerobic Support / Recovery',
    durationMinutes: Math.min(Math.max(Math.round((session.durationMinutes || 35) * 0.7), 30), 45),
    description: `${reason} Keep it conversational, short, and finish fresher than you started.`,
    exercises: [],
  };
}

function isEnduranceCardioSession(session: CoordinatedTrainingSession): boolean {
  return /^(?:run|running|ride|bike|cycle|cycling|swim|swimming)$/i.test(session.sessionType.trim());
}

function buildStrengthSupportSession(dayOfWeek: string, sport?: string): CoordinatedTrainingSession | null {
  const normalizedSport = String(sport || '').trim().toLowerCase();
  if (normalizedSport === 'gym') {
    return {
      dayOfWeek,
      sessionType: 'gym',
      title: 'Full Body Strength Support',
      durationMinutes: 45,
      description: 'Extra support slot added to hit the requested weekly strength frequency without turning it into a max-effort day.',
      exercises: [
        { name: 'Bulgarian Split Squat', sets: 3, reps: 8, rpe: '7', restSec: 75 },
        { name: 'DB Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 75 },
        { name: 'One-Arm DB Row', sets: 3, reps: 10, rpe: '7', restSec: 60 },
        { name: 'Push-Up / DB Floor Press', sets: 3, reps: 10, rpe: '7', restSec: 60 },
      ],
    };
  }

  if (normalizedSport === 'running') {
    return {
      dayOfWeek,
      sessionType: 'gym',
      title: 'Runner Strength Support',
      durationMinutes: 35,
      description: 'Short support lift added to protect tissue tolerance and keep strength work present without stealing recovery from key runs.',
      exercises: [
        { name: 'Split Squat', sets: 3, reps: 8, rpe: '7', restSec: 60 },
        { name: 'Single-Leg RDL', sets: 3, reps: 8, rpe: '7', restSec: 60 },
        { name: 'Standing Calf Raise', sets: 3, reps: 12, rpe: '7', restSec: 45 },
        { name: 'Dead Bug', sets: 3, reps: 10, rpe: '6', restSec: 30 },
      ],
    };
  }

  return {
    dayOfWeek,
    sessionType: 'gym',
    title: normalizedSport === 'hybrid' ? 'Strength + Core Support' : 'Strength Support',
    durationMinutes: 40,
    description: 'Support strength slot added to preserve basic force production and movement quality inside the requested weekly structure.',
    exercises: [
      { name: 'Step-Up', sets: 3, reps: 8, rpe: '7', restSec: 75 },
      { name: 'Romanian Deadlift', sets: 3, reps: 8, rpe: '7', restSec: 75 },
      { name: 'One-Arm Row', sets: 3, reps: 10, rpe: '7', restSec: 60 },
      { name: 'Front Plank', sets: 3, reps: 40, rpe: '6', restSec: 30 },
    ],
  };
}

function buildSupportSession(dayOfWeek: string, sport?: string): CoordinatedTrainingSession | null {
  const normalizedSport = String(sport || '').trim().toLowerCase();
  if (normalizedSport === 'running') {
    return {
      dayOfWeek,
      sessionType: 'run',
      title: 'Easy Aerobic Support',
      durationMinutes: 35,
      description: 'Extra easy aerobic work added to reach the requested weekly frequency without competing with the key sessions.',
      exercises: [],
    };
  }

  if (normalizedSport === 'gym') {
    return {
      dayOfWeek,
      sessionType: 'mobility',
      title: 'Mobility + Tissue Support',
      durationMinutes: 30,
      description: 'Low-friction support slot added so the training week has enough productive touches without forcing another hard lift.',
      exercises: [],
    };
  }

  if (normalizedSport === 'hybrid') {
    return {
      dayOfWeek,
      sessionType: 'ride',
      title: 'Aerobic Support Ride',
      durationMinutes: 40,
      description: 'Easy aerobic support added to keep the week complete without raising recovery cost too much.',
      exercises: [],
    };
  }

  return {
    dayOfWeek,
    sessionType: 'run',
    title: 'Aerobic Support / Recovery',
    durationMinutes: 35,
    description: 'Extra easy support session added so the week reaches the requested volume in a sustainable way.',
    exercises: [],
  };
}

function rankedFreeDaysForInsertion(
  sessions: CoordinatedTrainingSession[],
  coordination: TrainingPlanCoordination,
  insertionType: 'strength' | 'aerobic',
): string[] {
  const usedDays = new Set(
    sessions
      .map((session) => normalizeDay(session.dayOfWeek))
      .filter((value): value is string => Boolean(value)),
  );

  const longSessionDay = orderedSessionEntries(sessions).find((entry) => isLongSession(entry.session))?.day ?? null;

  return VALID_DAYS
    .filter((day) => !usedDays.has(day))
    .sort((left, right) => {
      const leftScore = insertionDayScore(left, sessions, coordination, insertionType, longSessionDay);
      const rightScore = insertionDayScore(right, sessions, coordination, insertionType, longSessionDay);
      return rightScore - leftScore;
    });
}

function insertionDayScore(
  day: string,
  sessions: CoordinatedTrainingSession[],
  coordination: TrainingPlanCoordination,
  insertionType: 'strength' | 'aerobic',
  longSessionDay: string | null,
): number {
  let score = 10;
  const ordered = orderedSessionEntries(sessions);

  if (coordination.protectFocusDay === day) score -= 4;
  if (coordination.protectFilmingDay === day) score -= 3;
  if (longSessionDay && areAdjacentDays(longSessionDay, day) && coordination.protectRecoveryAfterLongSession) score -= 4;

  for (const entry of ordered) {
    if (!areAdjacentDays(entry.day, day)) continue;
    if (coordination.protectImpactSpacing && insertionType === 'aerobic' && isImpactSession(entry.session)) score -= 3;
    if (coordination.protectLowerBodySpacing && insertionType === 'strength' && isHighDemandSession(entry.session)) score -= 2;
    if (isHighDemandSession(entry.session)) score -= 1;
  }

  return score;
}

function extractAthleteConstraintProfile(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
  runProfile?: Record<string, any> | null,
): AthleteConstraintProfile {
  const experience = String(
    fitnessProfile?.experience_level
    ?? fitnessProfile?.experienceLevel
    ?? gymProfile?.training_age
    ?? gymProfile?.trainingAge
    ?? '',
  ).toLowerCase();
  const injuryText = [
    fitnessProfile?.injuries,
    fitnessProfile?.injury_history,
    runProfile?.injury_history,
    runProfile?.injuryHistory,
  ]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0 && value.toLowerCase() !== 'none')
    .join(' | ')
    .toLowerCase();

  const beginner = /\bbeginner\b|<\s*1\s*year|\bnew\b/.test(experience);
  const advanced = /\badvanced\b|5\+\s*years|3\+\s*years/.test(experience);
  const experienceBand: AthleteConstraintProfile['experienceBand'] = beginner
    ? 'beginner'
    : advanced
      ? 'advanced'
      : 'intermediate';

  const impactSensitive = /\bknee\b|\bashilles\b|\bachilles\b|\bshin\b|\bcalf\b|\bplantar\b|\bfoot\b|\bankle\b|\bhip\b/.test(injuryText);
  const lowerBodySensitive = impactSensitive || /\bhamstring\b|\bquad\b|\bback\b|\blow back\b|\blumbar\b/.test(injuryText);
  const injuryNotes = compact(
    injuryText
      .split('|')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  return {
    experienceBand,
    beginner,
    impactSensitive,
    lowerBodySensitive,
    injuryNotes,
  };
}

function extractSecretaryConstraints(secretary: SecretaryMeshContext | null): {
  travelWeekdays: string[];
  focusDay: string | null;
  adminPressure: 'high' | 'normal';
} {
  const travelSignal = secretary?.derivedSignals.find((entry) => entry.signalType === 'travel_window');
  const inboxSignal = secretary?.derivedSignals.find((entry) => entry.signalType === 'inbox_pressure');
  const travelWeekdays = Array.isArray(travelSignal?.payload.dates)
    ? travelSignal.payload.dates
      .filter((value: unknown): value is string => typeof value === 'string')
      .map((date) => weekdayFromIsoDate(date))
      .filter((value): value is string => Boolean(value))
    : [];
  const overdueCount = typeof inboxSignal?.payload.overdueCount === 'number' ? inboxSignal.payload.overdueCount : 0;
  const dueTodayCount = typeof inboxSignal?.payload.dueTodayCount === 'number' ? inboxSignal.payload.dueTodayCount : 0;

  return {
    travelWeekdays: Array.from(new Set(travelWeekdays)),
    focusDay: weekdayFromIsoDate(secretary?.focusBlock?.date ?? null),
    adminPressure: overdueCount >= 3 || dueTodayCount >= 3 ? 'high' : 'normal',
  };
}

function extractRecoveryState(training: TrainingMeshContext | null): string | null {
  const signal = training?.derivedSignals.find((entry) => entry.signalType === 'recovery_state');
  return typeof signal?.payload.state === 'string' ? signal.payload.state : null;
}

function trainingSecretaryFeedbackGuidance(
  feedback: TrainingMeshContext['secretaryFeedback'],
): string | null {
  if (!feedback) return null;
  if (feedback.status === 'compressed') {
    const duration = feedback.scheduledDurationMinutes != null
      ? ` to ${feedback.scheduledDurationMinutes} minutes`
      : '';
    return `Secretary reports that at least one plan session was compressed${duration}; use that as a conservative capacity signal, keep non-key work modular, and do not invent the affected session identity or exact time.`;
  }
  if (feedback.status === 'reflowed') {
    return `Secretary reports that a plan session was reflowed; treat Secretary-owned calendar placement as authoritative, and do not infer or restate its exact time from this privacy-bounded context.`;
  }
  if (feedback.status === 'deferred' || feedback.status === 'unscheduled') {
    return `Secretary reports that at least one plan session remains ${feedback.status}; do not assume every session has calendar placement and keep the replacement plan easy to reflow.`;
  }
  if (feedback.status === 'needs_more_context') {
    return `Secretary reports that at least one plan session still needs scheduling context; do not assume calendar placement until the missing availability is resolved.`;
  }
  return null;
}

function extractCookingRisk(cooking: CookingMeshContext | null): {
  fuelingSupportStatus: string | null;
  mealExecutionStatus: string | null;
} {
  const fueling = cooking?.derivedSignals.find((entry) => entry.signalType === 'fueling_support_status');
  const readiness = cooking?.derivedSignals.find((entry) => entry.signalType === 'meal_execution_readiness');
  return {
    fuelingSupportStatus: typeof fueling?.payload.status === 'string' ? fueling.payload.status : null,
    mealExecutionStatus: typeof readiness?.payload.status === 'string' ? readiness.payload.status : null,
  };
}

function extractBudget(finance: FinanceMeshContext | null): {
  budgetMode: string | null;
  supplementMode: string | null;
  trainingSpendMode: string | null;
} | null {
  const signal = finance?.derivedSignals.find((entry) => entry.signalType === 'budget_remaining');
  if (!signal) return null;
  return {
    budgetMode: typeof signal.payload.budgetMode === 'string' ? signal.payload.budgetMode : null,
    supplementMode: typeof signal.payload.supplementMode === 'string' ? signal.payload.supplementMode : null,
    trainingSpendMode: typeof signal.payload.trainingSpendMode === 'string' ? signal.payload.trainingSpendMode : null,
  };
}

function extractFilmingDay(content: ContentMeshContext | null): string | null {
  const date = content?.filmingRecommendation?.date;
  if (!date) return null;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return VALID_DAYS[(day + 6) % 7] ?? null;
}

function resolveLongWorkoutDay(requestedLongWorkoutDay: string | null, filmingDay: string | null): string | null {
  const requested = normalizeRequestedLongWorkoutDay(requestedLongWorkoutDay);
  if (requested && requested !== filmingDay) return requested;
  if (requested === 'saturday' && filmingDay === 'saturday') return 'sunday';
  if (requested === 'sunday' && filmingDay === 'sunday') return 'saturday';
  if (requested) return requested;
  return filmingDay === 'saturday' ? 'sunday' : 'saturday';
}

function normalizeRequestedLongWorkoutDay(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'weekend') return 'saturday';
  return normalizeDay(normalized);
}

function orderedSessionEntries(sessions: CoordinatedTrainingSession[]): Array<{
  session: CoordinatedTrainingSession;
  index: number;
  day: string;
}> {
  return sessions
    .map((session, index) => ({ session, index, day: normalizeDay(session.dayOfWeek) }))
    .filter((entry): entry is { session: CoordinatedTrainingSession; index: number; day: string } => Boolean(entry.day))
    .sort((a, b) => daySortIndex(a.day) - daySortIndex(b.day));
}

function areAdjacentDays(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return Math.abs(daySortIndex(left) - daySortIndex(right)) === 1;
}

function normalizeDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return VALID_DAYS.includes(normalized as typeof VALID_DAYS[number]) ? normalized : null;
}

function weekdayFromIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return VALID_DAYS[(parsed.getUTCDay() + 6) % 7] ?? null;
}

function isActiveSession(session: CoordinatedTrainingSession): boolean {
  return session.sessionType !== 'rest';
}

function capitalizeDay(day: string): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

function isImpactSession(session: CoordinatedTrainingSession): boolean {
  if (session.sessionType !== 'run') return false;
  return !/walk|recovery/i.test(session.title);
}

function isLowerBodyLoadSession(session: CoordinatedTrainingSession): boolean {
  if (session.sessionType === 'run') return isHighDemandSession(session);
  if (session.sessionType !== 'gym') return false;

  const combined = [
    session.title,
    ...(Array.isArray(session.exercises) ? session.exercises.map((entry: any) => entry?.name) : []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /\bsquat\b|\bdeadlift\b|\blunge\b|\bleg\b|\bhamstring\b|\bglute\b|\bquad\b|\blower body\b|\bfull body\b/.test(combined);
}

function isLongSession(session: CoordinatedTrainingSession): boolean {
  return /\blong\b/i.test(session.title) || (session.durationMinutes || 0) >= 80;
}

function isHighDemandSession(session: CoordinatedTrainingSession): boolean {
  if (session.sessionType === 'rest' || session.sessionType === 'mobility') return false;
  if (
    session.sessionType === 'gym'
    && (session.sessionRole === 'strength_maintenance' || /maintenance|support/i.test(session.title))
  ) return false;
  if (isLongSession(session)) return true;
  if (/(interval|tempo|threshold|track|speed|upper body|lower body|strength|hypertrophy)/i.test(session.title)) return true;
  if (session.sessionType === 'gym' && (session.durationMinutes || 0) >= 55) return true;
  return false;
}

function removableSessionScore(session: CoordinatedTrainingSession): number {
  if (session.sessionType === 'rest') return -1;
  if (session.sessionType === 'mobility') return 0;
  // Brick work is additive transition practice. When the kernel emits one
  // row beyond an explicit multisport cap, trim it before a requested
  // aerobic/recovery modality session regardless of incidental array order.
  if (session.sessionRole === 'brick' || /\bbrick\b/i.test(session.title)) return 0.5;
  if (/recovery|easy|support/i.test(session.title)) return 1;
  if (session.sessionType === 'gym') return 2;
  if (isLongSession(session)) return 5;
  if (isHighDemandSession(session)) return 4;
  return 3;
}

function hardSessionPriority(session: CoordinatedTrainingSession): number {
  if (isLongSession(session)) return 100;
  if (/(tempo|interval|threshold|track|speed)/i.test(session.title)) return 90;
  if (session.sessionType === 'gym') return 70;
  return 60;
}

function daySortIndex(day: string | null): number {
  if (!day) return 99;
  const index = VALID_DAYS.indexOf(day as typeof VALID_DAYS[number]);
  return index >= 0 ? index : 99;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compact(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim().length > 0));
}
