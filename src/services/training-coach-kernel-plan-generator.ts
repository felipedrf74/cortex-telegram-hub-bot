// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildWeekPlan } from './coach-kernel/planner-engine';
import type {
  AthleteState,
  BlockPhase,
  CoachingDiscipline,
  Constraint,
  DayOfWeek,
  EquipmentAccess,
  Goals,
  RaceEvent,
  ReadinessLevel,
  ReadinessSnapshot,
  NormalizedTrainingProfile,
  Session,
  Sport,
  TrainingDecisionReason,
  TrainingDecisionReasonCode,
  TrainingHistory,
  TrainingProfileQuality,
  WeeklyPlan,
} from './coach-kernel/types';
import { DAY_ORDER } from './coach-kernel/utils';
import { recordWeeklyPlan } from './coach-plan-registry';
import type { CoordinatedTrainingPlan, CoordinatedTrainingSession, CoordinatedTrainingWeek } from './training-plan-coordination';
import {
  readTrainingHistoryFromCompletions,
  type RealTrainingHistory,
} from './training-history';
import {
  extractNormalizedTrainingProfile,
} from './training-profile-model';
import { logger } from '../utils/logger';

/** Current readiness measurements used to seed the planner's
 *  `AthleteState.readiness`. When provided the generator uses these real
 *  values (from `calculateReadiness`) instead of a hardcoded yellow/orange
 *  heuristic — that lets readiness-aware guardrails (e.g. volume progression
 *  cap on low HRV) fire with actual data at plan-generation time. */
export interface CoachKernelReadinessInput {
  /** 0..100 composite score from `calculateReadiness`. */
  score: number;
  /** Hours slept last night if known — the readiness-scorer exposes this
   *  via `factors.sleep.durationHours`. Leave undefined to keep the
   *  planner's default. */
  sleepHours?: number;
  /** HRV trend classification from the scorer (maps from 'up'/'stable'/
   *  'down' → 'high'/'normal'/'low'). */
  hrvStatus?: 'low' | 'normal' | 'high';
  /** Body-battery / energy-reserve 0..100. */
  energyReserve?: number;
  /** One-line reasoning from the scorer, surfaced as a planner note. */
  reasoning?: string | null;
}

export type TrainingGoalMode = 'event_based' | 'continuous' | 'maintenance' | 'return_to_training';
export type TrainingPriority = Sport | 'triathlon' | 'hybrid';

export interface CoachKernelTrainingPlanInput {
  userId: number;
  objective: string;
  durationWeeks: number;
  startDate: string;
  sessionsPerWeek: number;
  strengthSessionsPerWeek: number;
  preferredTime: string;
  preferredCardioTime: string;
  preferredStrengthTime: string;
  longWorkoutDay?: string | null;
  notes?: string | null;
  fitnessProfile?: Record<string, any> | null;
  gymProfile?: Record<string, any> | null;
  runProfile?: Record<string, any> | null;
  /** Optional real readiness snapshot. When omitted the generator falls
   *  back to a neutral yellow seed (70) so existing callers that don't
   *  pass readiness remain functional. */
  currentReadiness?: CoachKernelReadinessInput | null;
  /**
   * Slice 2.B (coach-engine refactor 2026-04-27) — explicit two-a-day
   * preference from the user. Drives `availability.maxSessionsPerDay`:
   *
   *   `'preferred'` → always allow 2 sessions/day. The planner will
   *                   schedule run AM + gym PM on the same day when the
   *                   weekly volume warrants it AND
   *                   `preferredCardioTime`/`preferredStrengthTime`
   *                   provide enough separation between sessions.
   *   `'optional'`  → existing volume-based inference (kicks in when the
   *                   weekly target hits ≥5 sessions with strength
   *                   present).
   *   `'never'`     → cap at 1 session/day. Volume that can't fit
   *                   within `7 * 1` slots gets compressed via the
   *                   guardrail layer.
   *
   * When omitted, the generator behaves exactly as before
   * (`'optional'` semantics) — additive change only.
   */
  twoADayPreference?: 'never' | 'optional' | 'preferred' | null;
  goalMode?: TrainingGoalMode | null;
  trainingPriority?: TrainingPriority | null;
  raceDate?: string | null;
  recentlyAskedFollowUpIds?: string[] | null;
  resolvedFollowUpIds?: string[] | null;
}

const DAY_NAME_MAP: Record<DayOfWeek, string> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

const PHASE_INTENSITY: Record<BlockPhase, number> = {
  base: 64,
  build: 72,
  peak: 78,
  taper: 60,
  race: 52,
  deload: 56,
  maintenance: 66,
};

const SESSION_TYPE_LABEL_MAP: Record<Session['sessionType'], string> = {
  easy_run: 'run',
  long_run: 'run',
  threshold_run: 'run',
  interval_run: 'run',
  recovery_run: 'run',
  endurance_ride: 'ride',
  tempo_ride: 'ride',
  threshold_ride: 'ride',
  vo2_ride: 'ride',
  recovery_ride: 'ride',
  technique_swim: 'swim',
  aerobic_swim: 'swim',
  threshold_swim: 'swim',
  speed_swim: 'swim',
  recovery_swim: 'swim',
  strength_hypertrophy: 'gym',
  strength_max: 'gym',
  strength_maintenance: 'gym',
  brick: 'run',
  mobility: 'gym',
  rest: 'rest',
};

export function buildCoachKernelTrainingPlan(input: CoachKernelTrainingPlanInput): CoordinatedTrainingPlan {
  const athlete = buildAthleteStateFromTrainingProfiles(input);
  let rollingAthlete = athlete;
  const rawWeeklyPlans: WeeklyPlan[] = [];

  const weeks: CoordinatedTrainingWeek[] = Array.from({ length: input.durationWeeks }, (_, index) => {
    const weekNumber = index + 1;
    const weekStart = offsetDate(input.startDate, index * 7);
    const phase = resolveWeekPhase({
      weekNumber,
      durationWeeks: input.durationWeeks,
      weekStart,
      races: athlete.goals.raceCalendar,
    });

    const weekReadiness = readinessForPlannedWeek(rollingAthlete.readiness, weekNumber);
    const weekAthlete: AthleteState = {
      ...rollingAthlete,
      readiness: weekReadiness,
      currentBlock: {
        ...rollingAthlete.currentBlock,
        phase,
        weekIndex: weekNumber,
        totalWeeks: input.durationWeeks,
      },
    };

    const weeklyPlan = buildWeekPlan(weekAthlete, weekStart);
    rawWeeklyPlans.push(weeklyPlan);
    // Retain the raw WeeklyPlan (for guardrail reasoning) AND the
    // AthleteState that produced it (so the home-view route can re-run
    // `adjustForFatigue` with today's live readiness). The legacy
    // converter below discards both fields.
    recordWeeklyPlan(weeklyPlan, weekAthlete);
    rollingAthlete = rollAthleteStateForward(weekAthlete, weeklyPlan);
    return convertWeeklyPlanToLegacyWeek(weeklyPlan, weekNumber);
  });

  // TR-EC-QA-O1 + TR-EC-QA-O2 (2026-05-03 hostile QA closeout):
  // Goal-mode reasons are derived from the RAW resolveWeeklyTargets
  // output (NOT the shaped targets on `athlete.goals`). Re-derive
  // primary focus + raw targets here for the reason collector — the
  // helpers are pure so the duplicate work is cheap, and dedupe at
  // line 203 collapses any duplicates that survive.
  const reasonPrimaryFocus = resolvePrimaryFocusWithSource(
    input.objective,
    input.sessionsPerWeek,
    input.strengthSessionsPerWeek,
  ).value;
  const reasonRawTargets = resolveWeeklyTargets(reasonPrimaryFocus, input);
  const goalModeReasons = collectGoalModeDecisionReasons({
    input,
    rawTargets: reasonRawTargets,
    raceCalendar: athlete.goals.raceCalendar,
  });

  return {
    planName: `${input.objective.trim()} — Coach Plan`,
    sport: legacyPlanSport(athlete.goals.primaryFocus),
    periodization: 'block',
    weeks,
    profileQuality: trainingPlanProfileQuality(athlete.profileQuality),
    decisionReasons: dedupeTrainingDecisionReasons([
      ...goalModeReasons,
      ...rawWeeklyPlans.flatMap((plan) => plan.decisionReasons ?? []),
    ]),
  };
}

function readinessForPlannedWeek(
  readiness: AthleteState['readiness'],
  weekNumber: number,
): AthleteState['readiness'] {
  if (weekNumber <= 1) return readiness;
  const hasMaterialPain = (readiness.painFlags ?? []).some((flag) =>
    flag.severity === 'moderate' || flag.severity === 'high'
  );
  if (hasMaterialPain) return readiness;
  if (readiness.level !== 'red' && readiness.level !== 'orange') return readiness;

  return {
    ...readiness,
    level: 'yellow',
    score: Math.max(readiness.score ?? 0, 70),
    notes: Array.from(new Set([
      ...(readiness.notes ?? []),
      'Future weeks use neutral readiness until new recovery data arrives.',
    ])),
  };
}

export function buildAthleteStateFromTrainingProfiles(input: CoachKernelTrainingPlanInput): AthleteState {
  // Slice 3.K (Layer 1, audit follow-up): emit a structured warning
  // when the primary-focus resolver had to fall back. This is the
  // highest-leverage silent default in the file —
  // `resolveWeeklyTargets`, `resolveRaceCalendar`, and
  // `resolvePriorityOrder` all switch on `primaryFocus`, so a
  // silent fallback to 'hybrid' produces a globally different plan
  // shape than a recognized objective. The log distinguishes
  // 'missing' (empty objective string — onboarding probably
  // skipped the field) from 'unrecognized' (the user typed
  // something the keyword table doesn't yet cover; absorb new
  // vocabulary into OBJECTIVE_KEYWORDS in a follow-up slice).
  // The 'inferred_volume_split' source is INTENTIONAL hybrid
  // classification supported by volume signal — not a fallback,
  // so no log is emitted for that case.
  const primaryFocusResolution = resolvePrimaryFocusWithSource(
    input.objective,
    input.sessionsPerWeek,
    input.strengthSessionsPerWeek,
  );
  if (primaryFocusResolution.source === 'fallback') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.primaryFocus',
      userId: input.userId,
      reason: primaryFocusResolution.reason,
      rawInput: primaryFocusResolution.rawInput ?? null,
      sessionsPerWeek: input.sessionsPerWeek,
      strengthSessionsPerWeek: input.strengthSessionsPerWeek,
    }, primaryFocusResolution.reason === 'unrecognized'
      ? 'Primary-focus resolver fell back to hybrid — objective string contained vocabulary not yet in OBJECTIVE_KEYWORDS; weekly targets, race calendar, and priority order will all use the hybrid default'
      : 'Primary-focus resolver fell back to hybrid — objective string was empty; weekly targets, race calendar, and priority order will all use the hybrid default');
  }
  const primaryFocus = primaryFocusResolution.value;
  const rawWeeklyTargets = resolveWeeklyTargets(primaryFocus, input);
  const raceCalendar = resolveRaceCalendar(primaryFocus, input.objective, input.runProfile, input.raceDate);
  // TR-EC-QA-O1 + TR-EC-QA-O2 (2026-05-03 hostile QA closeout):
  // Apply goalMode-aware shaping. Before this pass goalMode was
  // accept-and-echo: maintenance only relabeled priorityOrder and
  // strengthGoal but did NOT throttle weekly volume. The shaping pass
  // now enforces deterministic caps (60% scale capped at 4 for
  // maintenance, 50% scale capped at 3 for return_to_training) AND
  // emits structured TrainingDecisionReasons for every goal-mode
  // signal — including continuous_plan_no_taper (so the user sees the
  // continuous mode actively prevented a fake taper) and
  // event_based_missing_race_date (so the user sees that picking
  // event_based without a date is incomplete intent).
  // `applyGoalModeVolumeShaping` is also called by
  // `collectGoalModeDecisionReasons` to populate decisionReasons. The
  // function is pure + idempotent under its own output, so emitting
  // both inside the AthleteState build (for shaped targets) and again
  // at the kernel level (for reasons) is safe — the dedupe pass at
  // line 198 collapses any duplicates.
  const { targets: weeklyTargets } =
    applyGoalModeVolumeShaping(rawWeeklyTargets, input, raceCalendar);
  const constraints = resolveConstraints(input.fitnessProfile, input.runProfile, input.notes);

  // Slice 3.J (Layer 1, audit follow-up): emit a structured warning
  // when the equipment-access resolver had to fall back. Before
  // slice 3.J a user typing "Crossfit box" or "Hotel gym" got
  // `hasGym/hasBarbell/hasDumbbells: false` silently, which forced
  // the strength engine into bodyweight/band-only patterns even
  // though they had a fully-equipped facility. The log now
  // distinguishes "missing" (prompt the user to fill in equipment)
  // from "unrecognized" (grow the matcher's keyword list).
  const equipmentResolution = resolveEquipmentAccessWithSource(input.fitnessProfile, input.gymProfile);
  if (equipmentResolution.source === 'fallback') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.equipmentAccess',
      userId: input.userId,
      reason: equipmentResolution.reason,
      rawInput: equipmentResolution.rawInput ?? null,
      rawGymProfile: typeof input.gymProfile?.equipment_access === 'string'
        ? input.gymProfile.equipment_access
        : null,
      rawFitnessProfile: typeof input.fitnessProfile?.available_equipment === 'string'
        ? input.fitnessProfile.available_equipment
        : null,
    }, equipmentResolution.reason === 'unrecognized'
      ? 'Equipment-access resolver fell back — profile contained vocabulary not yet in matchEquipmentKeywords; user may have lost barbell/dumbbell access in their plan'
      : 'Equipment-access resolver fell back — no equipment data on profile; planner will use fallback (no gym, no barbell, no dumbbells)');
  }
  const equipment = equipmentResolution.value;

  // Slice 3.M (Layer 1, audit follow-up): resolve per-sport
  // weekly-minutes with explicit provenance so the call site can
  // log when running or cycling volume was inferred from
  // `targets × constant` rather than read from real profile data.
  // Downstream `lastWeekMinutesBySport` feeds ACWR load math; if
  // the inferred number is wrong the ramp-up is mis-tuned. Before
  // slice 3.M the inference was silent — the planner assumed
  // 45min/running-session and 55min/cycling-session and operators
  // had no way to tell which users had real data and which were
  // running on heuristic. Strength and swimming use `targets ×
  // constant` always (no real-data field on input), so they're
  // not in scope for this slice's logging.
  const runningPaceForHistory = resolveThresholdPace(input.runProfile) ?? 360;
  const runningHistoryResolution = resolveRunningWeeklyMinutesWithSource(
    input.runProfile,
    weeklyTargets.running ?? 0,
    runningPaceForHistory,
  );
  const cyclingHistoryResolution = resolveCyclingWeeklyMinutesWithSource(
    input.runProfile,
    weeklyTargets.cycling ?? 0,
  );
  if (runningHistoryResolution.source === 'inferred_from_targets') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.runningWeeklyMinutes',
      userId: input.userId,
      weeklyTarget: runningHistoryResolution.weeklyTarget,
      minutesPerSession: runningHistoryResolution.minutesPerSession,
      inferredMinutes: runningHistoryResolution.value,
    }, 'Running weekly-minutes inferred from targets — no run_profile.weekly_mileage_km on profile; ACWR load math will use targets × 45min/session as the baseline');
  }
  if (cyclingHistoryResolution.source === 'inferred_from_targets') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.cyclingWeeklyMinutes',
      userId: input.userId,
      weeklyTarget: cyclingHistoryResolution.weeklyTarget,
      minutesPerSession: cyclingHistoryResolution.minutesPerSession,
      inferredMinutes: cyclingHistoryResolution.value,
    }, 'Cycling weekly-minutes inferred from targets — no run_profile.weekly_hours bucket on profile; ACWR load math will use targets × 55min/session as the baseline');
  }
  // Slice 4.E (audit Layer-8 Critical) — read REAL completion
  // history per sport per week so ACWR math runs against actual
  // adherence + duration, not 4 copies of one synthesized number.
  // Read failure (DB hiccup) degrades to undefined so the synthesis
  // fallback below keeps the planner alive.
  let realHistory: RealTrainingHistory | undefined;
  try {
    realHistory = readTrainingHistoryFromCompletions(input.userId);
  } catch (err) {
    logger.warn(
      { surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.realHistory', userId: input.userId, err },
      'Failed to read real training history; falling back to synthesis',
    );
    realHistory = undefined;
  }
  if (realHistory && realHistory.hasAnyHistory) {
    logger.info(
      {
        surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.realHistory',
        userId: input.userId,
        rawCompletionCount: realHistory.rawCompletionCount,
        hasRunningHistory: realHistory.lastWeekMinutesBySport.running !== undefined,
        hasStrengthHistory: realHistory.lastWeekMinutesBySport.strength !== undefined,
        hasCyclingHistory: realHistory.lastWeekMinutesBySport.cycling !== undefined,
        hasSwimmingHistory: realHistory.lastWeekMinutesBySport.swimming !== undefined,
      },
      'Real training history loaded; ACWR math will run against actual completion data',
    );
  }

  const trainingHistory = resolveTrainingHistory(
    weeklyTargets,
    runningHistoryResolution,
    cyclingHistoryResolution,
    realHistory,
  );

  // Slice 3.I (Layer 1, audit follow-up): emit a structured warning
  // when the experience-level resolver had to fall back to 'novice'
  // because the profile data couldn't produce a recognized answer.
  // Before slice 3.I a missing field was silently identical to a
  // confirmed novice, which mattered downstream because
  // slice 2.A's BEGINNER_SAFE_SUBSTITUTIONS layer keys on
  // `experienceLevel === 'novice'`. Carrying the raw inputs in the
  // log line lets operators see whether the cause was missing data
  // or a new vocabulary word the resolver should learn.
  const experienceResolution = resolveExperienceLevelWithSource(input.fitnessProfile, input.gymProfile);
  if (experienceResolution.source === 'fallback') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.experienceLevel',
      userId: input.userId,
      rawFitnessProfile: typeof input.fitnessProfile?.experience_level === 'string'
        ? input.fitnessProfile.experience_level
        : null,
      rawGymProfile: typeof input.gymProfile?.training_age === 'string'
        ? input.gymProfile.training_age
        : null,
      fallbackValue: experienceResolution.value,
    }, 'Experience-level resolver fell back to novice — profile fields missing or vocabulary unrecognized');
  }

  // Slice 3.L (Layer 1, audit follow-up): emit a structured warning
  // when the strength-goal resolver had to fall back. Strength goal
  // drives prescription template selection — `'hypertrophy'`,
  // `'max_strength'`, `'athletic'`, and `'maintenance'` produce
  // different rep ranges, intensity, and exercise selection. Before
  // slice 3.L every unrecognized goal silently collapsed to
  // `'athletic'`: the user typed something specific
  // ("powerbuilding", "general fitness", "tone") and got a generic
  // template. The log distinguishes 'missing' (prompt the user to
  // fill in) from 'unrecognized' (grow the matcher's keyword list).
  const strengthGoalResolution = resolveStrengthGoalWithSource(input.gymProfile);
  if (strengthGoalResolution.source === 'fallback') {
    logger.warn({
      surface: 'coach-kernel.buildAthleteStateFromTrainingProfiles.strengthGoal',
      userId: input.userId,
      reason: strengthGoalResolution.reason,
      rawInput: strengthGoalResolution.rawInput ?? null,
      rawGymProfile: typeof input.gymProfile?.primary_goal === 'string'
        ? input.gymProfile.primary_goal
        : null,
      fallbackValue: strengthGoalResolution.value,
    }, strengthGoalResolution.reason === 'unrecognized'
      ? 'Strength-goal resolver fell back to athletic — profile contained vocabulary not yet in STRENGTH_GOAL_KEYWORDS; user may receive a generic prescription template instead of the one they implied'
      : 'Strength-goal resolver fell back to athletic — no primary_goal data on profile; planner will use the generic athletic prescription template');
  }

  const resolvedStrengthGoal: NonNullable<Goals['strengthGoal']> =
    input.goalMode === 'maintenance'
      ? 'maintenance'
      : strengthGoalResolution.value;
  const priorityOrder = resolvePriorityOrder(primaryFocus, input.goalMode, input.trainingPriority);
  const modalityPriorityOrder = priorityOrder.filter(isModalityPriority);
  const maxSessionsPerDay = resolveMaxSessionsPerDay(input.twoADayPreference, weeklyTargets);
  const normalizedTrainingProfile = extractNormalizedTrainingProfile(input, {
    primaryFocus,
    priorityOrder: modalityPriorityOrder,
    weeklyTargets,
    strengthGoal: resolvedStrengthGoal,
    raceCalendar,
    equipment,
    equipmentSource: equipmentResolution.source === 'fallback' ? 'fallback' : 'provided',
    experienceLevel: experienceResolution.value,
    experienceSource: experienceResolution.source === 'fallback' ? 'fallback' : 'provided',
    constraints,
    maxSessionsPerDay,
  });

  return {
    profile: {
      athleteId: input.userId,
      name: 'Nexus Hub Athlete',
      experienceLevel: experienceResolution.value,
      primaryDiscipline: primaryFocus,
      thresholdPaceSecondsPerKm: resolveThresholdPace(input.runProfile),
      cyclingFtpWatts: numericOrUndefined(input.runProfile?.ftp_watts ?? input.fitnessProfile?.ftp_watts),
      swimCssSecondsPer100m: numericOrUndefined(input.fitnessProfile?.swim_css_seconds_per_100m),
      maxHeartRate: numericOrUndefined(input.fitnessProfile?.max_heart_rate),
      thresholdHeartRate: numericOrUndefined(input.fitnessProfile?.threshold_heart_rate),
      restingHeartRate: numericOrUndefined(input.fitnessProfile?.resting_heart_rate),
      bodyWeightKg: numericOrUndefined(input.fitnessProfile?.weight_kg),
    },
    normalizedTrainingProfile,
    profileQuality: normalizedTrainingProfile.quality,
    goals: {
      primaryFocus,
      secondaryFocus: weeklyTargets.strength ? 'strength' : undefined,
      strengthGoal: resolvedStrengthGoal,
      raceCalendar,
      priorityOrder,
      weeklySessionsTarget: weeklyTargets,
      weeklyMinutesTarget: resolveWeeklyMinutesTarget(weeklyTargets, trainingHistory.lastWeekMinutesBySport),
    },
    constraints,
    availability: {
      weeklyWindows: buildAvailabilityWindows(input, weeklyTargets, normalizedTrainingProfile),
      preferredLongSessionDay: normalizeDayOfWeek(input.longWorkoutDay) ?? defaultLongSessionDay(primaryFocus),
      preferredTimesBySport: {
        running: normalizeTime(input.preferredCardioTime, input.preferredTime),
        cycling: normalizeTime(input.preferredCardioTime, input.preferredTime),
        swimming: normalizeTime(input.preferredCardioTime, input.preferredTime),
        strength: normalizeTime(input.preferredStrengthTime, input.preferredTime),
      },
      maxSessionsPerDay,
    },
    equipment,
    trainingHistory,
    currentBlock: {
      discipline: primaryFocus,
      phase: resolveWeekPhase({
        weekNumber: 1,
        durationWeeks: input.durationWeeks,
        weekStart: input.startDate,
        races: raceCalendar,
      }),
      weekIndex: 1,
      totalWeeks: input.durationWeeks,
      volumeProgressionPct: 6,
      lastDeloadWeekIndex: undefined,
    },
    recentSessions: realHistory?.recentSessions ?? [],
    readiness: buildReadinessSnapshot(input, constraints),
    compliance: {
      trailing14DayCompliance: 0.82,
      bySport: {},
      missedKeySessions: 0,
      consecutiveMisses: 0,
    },
  };
}

/**
 * Build the `AthleteState.readiness` snapshot from the generator input.
 *
 * Priority order:
 *   1. If `input.currentReadiness` is provided, map the score → ReadinessLevel
 *      and use the real sleep/HRV/energy numbers from `calculateReadiness`.
 *   2. Otherwise fall back to a constraint-derived yellow/orange seed so
 *      existing callers (tests, older routes) keep working.
 *
 * Pain flags always come from the user's declared constraints — readiness
 * data from wearables doesn't know about pre-existing injuries.
 */
function buildReadinessSnapshot(input: CoachKernelTrainingPlanInput, constraints: Constraint[]): ReadinessSnapshot {
  const hasHighInjury = constraints.some((constraint) => constraint.type === 'injury' && constraint.severity === 'high');
  const painFlags: ReadinessSnapshot['painFlags'] = constraints
    .filter((constraint) => constraint.type === 'injury')
    .map((constraint) => ({
      area: constraint.description,
      severity: constraint.severity === 'high' ? 'moderate' : 'low',
      impact: [constraint.sport as Sport | 'strength'].filter(Boolean),
    }));

  const notes = compact([
    hasHighInjury ? 'Injury-aware progression enabled.' : null,
    typeof input.notes === 'string' && input.notes.trim().length > 0 ? input.notes.trim() : null,
    typeof input.currentReadiness?.reasoning === 'string' && input.currentReadiness.reasoning.trim().length > 0
      ? `Readiness: ${input.currentReadiness.reasoning.trim()}`
      : null,
  ]);

  if (input.currentReadiness && typeof input.currentReadiness.score === 'number') {
    const score = clampReadinessScore(input.currentReadiness.score);
    return {
      capturedAt: new Date().toISOString(),
      level: scoreToReadinessLevel(score, hasHighInjury),
      score,
      sleepHours: input.currentReadiness.sleepHours,
      hrvStatus: input.currentReadiness.hrvStatus,
      energyReserve: input.currentReadiness.energyReserve,
      painFlags,
      notes,
    };
  }

  // Neutral fallback — preserves prior behavior for callers that can't
  // supply readiness yet.
  return {
    capturedAt: new Date().toISOString(),
    level: hasHighInjury ? 'orange' : 'yellow',
    score: hasHighInjury ? 58 : 70,
    painFlags,
    notes,
  };
}

function clampReadinessScore(score: number): number {
  if (!Number.isFinite(score)) return 70;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Map a composite readiness score (0..100) onto the planner's discrete
 *  level. High-severity injuries can't return green regardless of score —
 *  the planner treats them as a ceiling. */
function scoreToReadinessLevel(score: number, hasHighInjury: boolean): ReadinessLevel {
  if (hasHighInjury && score > 65) return 'orange';
  if (score >= 80) return 'green';
  if (score >= 60) return 'yellow';
  if (score >= 40) return 'orange';
  return 'red';
}

/**
 * Vocabulary table for the objective-string matcher. Order matters
 * — earlier entries take precedence under
 * `String.includes`-based scanning. So "half ironman" must come
 * BEFORE "ironman" (substring), "running" BEFORE "run", and
 * "swimming" BEFORE "swim" so the more specific keyword wins.
 *
 * The legacy regex used `70\\.3` (a double-backslash typo that
 * matched a literal backslash followed by any character — so the
 * pattern never actually matched the user input "70.3"). The
 * substring approach here naturally fixes that: a user typing
 * just "70.3" now correctly maps to triathlon. This is a
 * byproduct improvement, not a deliberate behavior change.
 */
const OBJECTIVE_KEYWORDS: ReadonlyArray<{
  pattern: string;
  keyword: string;
  discipline: CoachingDiscipline;
}> = [
  // Triathlon — most specific first
  { pattern: 'half ironman', keyword: 'half ironman', discipline: 'triathlon' },
  { pattern: 'ironman', keyword: 'ironman', discipline: 'triathlon' },
  { pattern: '70.3', keyword: '70.3', discipline: 'triathlon' },
  { pattern: 'triathlon', keyword: 'triathlon', discipline: 'triathlon' },
  { pattern: 'triatlo', keyword: 'triatlo', discipline: 'triathlon' },
  // Marathon — most specific first
  { pattern: 'meia maratona', keyword: 'meia maratona', discipline: 'marathon' },
  { pattern: 'half marathon', keyword: 'half marathon', discipline: 'marathon' },
  { pattern: 'marathon', keyword: 'marathon', discipline: 'marathon' },
  // Running — most specific subdiscipline keywords first so a
  // user typing "Trail running" gets `matchedKeyword: 'trail'`,
  // not the more generic 'running'. Then 'running' before 'run'
  // so "Running training" wins on 'running'.
  { pattern: 'trail', keyword: 'trail', discipline: 'running' },
  { pattern: 'ultra', keyword: 'ultra', discipline: 'running' },
  { pattern: '10k', keyword: '10k', discipline: 'running' },
  { pattern: '5k', keyword: '5k', discipline: 'running' },
  { pattern: 'corrida', keyword: 'corrida', discipline: 'running' },
  { pattern: 'running', keyword: 'running', discipline: 'running' },
  { pattern: 'run', keyword: 'run', discipline: 'running' },
  // Cycling
  { pattern: 'cycling', keyword: 'cycling', discipline: 'cycling' },
  { pattern: 'ciclismo', keyword: 'ciclismo', discipline: 'cycling' },
  { pattern: 'bike', keyword: 'bike', discipline: 'cycling' },
  { pattern: 'ride', keyword: 'ride', discipline: 'cycling' },
  // Swimming — "swimming" before "swim"
  { pattern: 'swimming', keyword: 'swimming', discipline: 'swimming' },
  { pattern: 'swim', keyword: 'swim', discipline: 'swimming' },
  { pattern: 'natação', keyword: 'natação', discipline: 'swimming' },
  { pattern: 'natacao', keyword: 'natacao', discipline: 'swimming' },
  // Strength
  { pattern: 'hipertrofia', keyword: 'hipertrofia', discipline: 'strength' },
  { pattern: 'hypertrophy', keyword: 'hypertrophy', discipline: 'strength' },
  { pattern: 'bodybuilding', keyword: 'bodybuilding', discipline: 'strength' },
  { pattern: 'muscle', keyword: 'muscle', discipline: 'strength' },
  { pattern: 'strength', keyword: 'strength', discipline: 'strength' },
  { pattern: 'massa', keyword: 'massa', discipline: 'strength' },
  { pattern: 'força', keyword: 'força', discipline: 'strength' },
  { pattern: 'muscula', keyword: 'muscula', discipline: 'strength' },
  { pattern: 'gym', keyword: 'gym', discipline: 'strength' },
];

/**
 * Result of resolving the athlete's primary discipline from the
 * objective string and weekly volume. The discriminated union
 * exists so the caller can distinguish three runtime cases the
 * previous version silently produced as identical `'hybrid'`
 * outputs:
 *
 *   1. Recognized keyword in `objective` → `source: 'objective_keyword'`,
 *      `matchedKeyword` names which token in `OBJECTIVE_KEYWORDS`
 *      drove the answer.
 *   2. Volume-split inference fired (`strengthSessionsPerWeek > 0
 *      && sessionsPerWeek > strengthSessionsPerWeek`) →
 *      `source: 'inferred_volume_split'`. This is an INTENTIONAL
 *      hybrid classification supported by explicit volume signal.
 *   3. Neither path matched → `source: 'fallback'`, with
 *      `reason: 'missing'` (empty/whitespace objective) or
 *      `reason: 'unrecognized'` (non-empty but no keyword matched
 *      AND the volume split didn't fire). `rawInput` carries the
 *      raw objective so the call-site logger can flag new
 *      vocabulary for `OBJECTIVE_KEYWORDS` to absorb.
 *
 * Downstream consumers care a lot about `value` —
 * `resolveWeeklyTargets`, `resolveRaceCalendar`,
 * `resolvePriorityOrder` all switch on `primaryFocus`, so a
 * silent fallback to `'hybrid'` produces a *globally different
 * plan shape* compared to a recognized objective. The audit
 * flagged this as one of the highest-leverage Layer 1 silent
 * defaults; slice 3.K now makes it observable.
 */
export type PrimaryFocusResolution =
  | { value: CoachingDiscipline; source: 'objective_keyword'; matchedKeyword: string }
  | { value: 'hybrid'; source: 'inferred_volume_split' }
  | { value: 'hybrid'; source: 'fallback'; reason: 'missing' | 'unrecognized'; rawInput?: string };

/**
 * Pure, exported variant of `resolvePrimaryFocus` that carries
 * the resolution provenance. Pinned by
 * `__tests__/services/training-coach-kernel-primary-focus.test.ts`.
 */
export function resolvePrimaryFocusWithSource(
  objective: string,
  sessionsPerWeek: number,
  strengthSessionsPerWeek: number,
): PrimaryFocusResolution {
  const trimmed = objective.trim();
  const lower = trimmed.toLowerCase();

  // 1. Recognized keyword wins (most specific path).
  const matched = matchObjectiveKeyword(lower);
  if (matched) {
    return { value: matched.discipline, source: 'objective_keyword', matchedKeyword: matched.keyword };
  }

  // 2. Volume-split inference is an INTENTIONAL hybrid call.
  // Distinct from fallback because the planner has explicit
  // signal (the user asked for both endurance and strength
  // sessions) supporting the choice.
  if (strengthSessionsPerWeek > 0 && sessionsPerWeek > strengthSessionsPerWeek) {
    return { value: 'hybrid', source: 'inferred_volume_split' };
  }

  // 3. Silent fallback path — distinguish missing from unrecognized.
  if (trimmed.length === 0) {
    return { value: 'hybrid', source: 'fallback', reason: 'missing' };
  }
  return { value: 'hybrid', source: 'fallback', reason: 'unrecognized', rawInput: trimmed };
}

/**
 * Wrapper preserved for the existing call-site signature so other
 * consumers don't change. New callers (and the call site that
 * wants to log fallbacks) should use
 * `resolvePrimaryFocusWithSource` directly.
 */
function resolvePrimaryFocus(objective: string, sessionsPerWeek: number, strengthSessionsPerWeek: number): CoachingDiscipline {
  return resolvePrimaryFocusWithSource(objective, sessionsPerWeek, strengthSessionsPerWeek).value;
}

/**
 * Walk `OBJECTIVE_KEYWORDS` in order, returning the first match.
 * Order is significant — see the table comment.
 */
function matchObjectiveKeyword(lower: string): { discipline: CoachingDiscipline; keyword: string } | null {
  for (const entry of OBJECTIVE_KEYWORDS) {
    if (lower.includes(entry.pattern)) {
      return { discipline: entry.discipline, keyword: entry.keyword };
    }
  }
  return null;
}

/**
 * Resolve the per-sport weekly session counts for a given primary
 * focus + user-provided session/strength preferences.
 *
 * **Exported (May 2 2026)** so the May-2 marathon-minimum + strength-
 * cap expansion is directly testable. Internal callers continue to
 * use it via the same signature.
 *
 * Caps: strength 0–6 (was 0–4 before May 2, bumped to allow advanced
 * lifters who explicitly request 5+ strength sessions). Marathon
 * focus enforces a minimum of 4 running sessions/week (1 long +
 * 1 quality + 2 supports — the standard marathon-prep skeleton).
 */
export function resolveWeeklyTargets(
  primaryFocus: CoachingDiscipline,
  input: CoachKernelTrainingPlanInput,
): Goals['weeklySessionsTarget'] {
  const total = clamp(Math.max(3, Math.min(7, input.sessionsPerWeek)), 3, 7);
  // May 2 2026 (Felipe-reported): strength cap was 4 sessions/week,
  // silently capping advanced lifters who explicitly request 5+
  // strength sessions (with marathon prep on top, that's a totally
  // reasonable load for someone with 5+ years of gym experience).
  // Bumped cap to 6 — downstream guardrails (capacity-reconciliation,
  // session-coherence) still adjust if the resulting load is
  // unsustainable for the user's recovery state. The cap remains
  // because runaway values (10/week) would break the planner's
  // session-spacing math, but 5–6 is now allowed for users who
  // know what they're doing.
  const STRENGTH_CAP = 6;
  const strength = clamp(Math.max(0, Math.min(STRENGTH_CAP, input.strengthSessionsPerWeek)), 0, STRENGTH_CAP);

  switch (primaryFocus) {
    case 'triathlon': {
      const strengthTarget = Math.min(strength, 2);
      const enduranceTotal = Math.max(5, total);
      const running = clamp(Math.round(enduranceTotal * 0.4), 3, 4);
      const cycling = clamp(Math.round(enduranceTotal * 0.35), 2, 3);
      const swimming = clamp(Math.max(2, enduranceTotal - running - cycling), 2, 3);
      return { running, cycling, swimming, strength: strengthTarget };
    }
    case 'marathon':
    case 'running': {
      const runningCap = availabilityDaysCap(input.runProfile?.weekly_availability_days);
      // May 2 2026 (Felipe-reported): marathon prep needs at least
      // 4 running sessions/week (1 long + 1 quality + 2 supports).
      // The prior min of 2 was sufficient for casual jogging but
      // produced under-volume marathon plans. For "running" focus
      // (non-marathon, e.g. 5K/10K casual) the legacy minimum of
      // 2 still applies — marathon-specific minimum is gated on
      // primaryFocus.
      const minRunning = primaryFocus === 'marathon' ? 4 : 2;
      const running = clamp(Math.max(minRunning, total), minRunning, runningCap ?? 7);
      return { running, strength: strength };
    }
    case 'cycling':
      return { cycling: total, strength: strength };
    case 'swimming':
      return { swimming: total, strength: strength };
    case 'strength': {
      const strengthTarget = Math.min(strength || Math.min(total, STRENGTH_CAP), total, STRENGTH_CAP);
      const aerobicSupport = Math.max(0, total - strengthTarget);
      return aerobicSupport > 0
        ? { running: aerobicSupport, strength: strengthTarget }
        : { strength: strengthTarget };
    }
    case 'hybrid':
    default: {
      const strengthTarget = Math.max(1, Math.min(strength || 2, total - 2));
      const running = clamp(total - strengthTarget, 2, 5);
      return { running, strength: strengthTarget };
    }
  }
}

function resolveRaceCalendar(
  primaryFocus: CoachingDiscipline,
  objective: string,
  runProfile?: Record<string, any> | null,
  requestRaceDate?: string | null,
): RaceEvent[] {
  const raceDate = normalizeRaceDate(requestRaceDate)
    ?? normalizeRaceDate(runProfile?.target_race_date)
    ?? normalizeRaceDate(runProfile?.targetRaceDate)
    ?? normalizeRaceDate(runProfile?.race_date)
    ?? normalizeRaceDate(runProfile?.raceDate);
  if (!raceDate) return [];

  const subtype = normalizeRaceSubtype(runProfile?.target_race, objective);
  if (!subtype && primaryFocus !== 'triathlon' && primaryFocus !== 'marathon' && primaryFocus !== 'running') return [];

  return [{
    id: 'goal-race',
    name: String(runProfile?.target_race || objective).trim(),
    discipline: primaryFocus === 'triathlon' ? 'triathlon' : 'running',
    subtype,
    date: raceDate,
    priority: 'a',
  }];
}

function resolveConstraints(
  fitnessProfile?: Record<string, any> | null,
  runProfile?: Record<string, any> | null,
  notes?: string | null,
): Constraint[] {
  const constraints: Constraint[] = [];
  const injuryTexts = compact([
    cleanFreeText(fitnessProfile?.injuries),
    cleanFreeText(runProfile?.injury_history),
  ]);

  for (const [index, injury] of injuryTexts.entries()) {
    constraints.push({
      id: `injury-${index + 1}`,
      type: 'injury',
      severity: /high|serious|fracture|tear|rupture/i.test(injury) ? 'high' : /achilles|knee|shin|stress/i.test(injury) ? 'medium' : 'low',
      description: injury,
      sport: /upper/i.test(injury) ? 'strength' : 'running',
    });
  }

  const noteText = cleanFreeText(notes);
  if (noteText) {
    constraints.push({
      id: 'athlete-note',
      type: 'time',
      severity: 'low',
      description: noteText,
    });
  }

  return constraints;
}

/**
 * The fields the planner reads to decide what equipment the athlete
 * has access to. Both are loose JSON columns at the DB boundary, so
 * the resolver below treats them as `unknown` and tells the caller
 * exactly which source produced the answer (and which keywords
 * inside that source matched).
 */
type EquipmentProfileSource = 'gym_profile.equipment_access' | 'fitness_profile.available_equipment';

/**
 * The "user has nothing recognizable" equipment shape. Track is the
 * only field assumed-true (running outdoors is universally
 * available); everything else defaults false. Same shape as the
 * pre-slice-3.J fallback so the planner-output contract is
 * preserved.
 */
const FALLBACK_EQUIPMENT_ACCESS: EquipmentAccess = {
  hasGym: false,
  hasBarbell: false,
  hasDumbbells: false,
  hasBikeTrainer: false,
  hasPool: false,
  hasTrack: true,
  notes: [],
};

/**
 * Result of resolving the athlete's equipment access from loose
 * profile data. The discriminated union exists so the caller can
 * distinguish three runtime cases the previous version silently
 * conflated:
 *
 *   1. The profile records a recognized vocabulary string (e.g.
 *      "Full gym + bands") → `source` names the field that produced
 *      the answer and `matchedKeywords` lists every keyword inside
 *      the string that contributed.
 *   2. The profile records an UNRECOGNIZED string (e.g. "Crossfit
 *      box", "Hotel gym", "YMCA") → `source: 'fallback'`,
 *      `reason: 'unrecognized'`, `rawInput` carries the literal
 *      strings so the call-site logger can flag the new vocabulary
 *      for the matcher list to absorb. Before slice 3.J, a real
 *      gym user typing "Crossfit box" got their barbell and
 *      dumbbell access silently set to `false`, forcing the
 *      strength engine into bodyweight/band-only patterns even
 *      though they had a fully-equipped facility.
 *   3. The profile has nothing recognizable at all → `source: 'fallback'`,
 *      `reason: 'missing'`. This is the "fresh user with empty
 *      onboarding" case — distinct from (2) because the operator
 *      action is different (prompt to fill in equipment vs grow
 *      the keyword list).
 *
 * `value` is always the `EquipmentAccess` shape the planner
 * actually uses; the `source` separation gives the call site clean
 * material for structured logging and future telemetry / UX hooks.
 */
export type EquipmentAccessResolution =
  | {
      value: EquipmentAccess;
      source: EquipmentProfileSource;
      matchedKeywords: string[];
    }
  | {
      value: EquipmentAccess;
      source: 'fallback';
      reason: 'missing' | 'unrecognized';
      rawInput?: string;
    };

/**
 * Pure, exported variant of `resolveEquipmentAccess` that carries
 * the resolution provenance. Pinned by
 * `__tests__/services/training-coach-kernel-equipment-access.test.ts`.
 *
 * Source-preference order is `gym_profile.equipment_access` first,
 * then `fitness_profile.available_equipment` — same precedence the
 * pre-slice-3.J string-coalescing chain implied.
 */
export function resolveEquipmentAccessWithSource(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): EquipmentAccessResolution {
  const gymRaw = pickEquipmentString(gymProfile?.equipment_access);
  if (gymRaw !== null) {
    const matched = matchEquipmentKeywords(gymRaw);
    if (matched.matchedKeywords.length > 0) {
      return { value: matched.value, source: 'gym_profile.equipment_access', matchedKeywords: matched.matchedKeywords };
    }
  }

  const fitnessRaw = pickEquipmentString(fitnessProfile?.available_equipment);
  if (fitnessRaw !== null) {
    const matched = matchEquipmentKeywords(fitnessRaw);
    if (matched.matchedKeywords.length > 0) {
      return { value: matched.value, source: 'fitness_profile.available_equipment', matchedKeywords: matched.matchedKeywords };
    }
  }

  // Neither source matched. Distinguish "user typed something we
  // didn't recognize" from "user typed nothing" so the call-site
  // logger can prompt different operator actions.
  const presentInputs = [gymRaw, fitnessRaw].filter((s): s is string => s !== null);
  if (presentInputs.length === 0) {
    return { value: FALLBACK_EQUIPMENT_ACCESS, source: 'fallback', reason: 'missing' };
  }
  return {
    value: FALLBACK_EQUIPMENT_ACCESS,
    source: 'fallback',
    reason: 'unrecognized',
    rawInput: presentInputs.join(' | '),
  };
}

/**
 * Wrapper preserved for the existing call-site signature so other
 * consumers don't change. New callers (and the call site that wants
 * to log fallbacks) should use `resolveEquipmentAccessWithSource`
 * directly.
 */
function resolveEquipmentAccess(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): EquipmentAccess {
  return resolveEquipmentAccessWithSource(fitnessProfile, gymProfile).value;
}

/**
 * Trim and reject empty strings or non-strings. Returns the
 * normalized non-empty string, or `null` if the input doesn't carry
 * usable text.
 */
function pickEquipmentString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Walk the recognized vocabulary against `raw`. Returns both the
 * derived `EquipmentAccess` shape AND every keyword that matched,
 * so the resolver can report which tokens drove the answer.
 *
 * The keyword set is the same that the pre-slice-3.J implementation
 * used (`'full gym'`, `'full commercial'`, `'garage'`, `'home gym'`,
 * `'basic'`, `'bodyweight'`, `'band'`). Future vocabulary additions
 * (`'crossfit'`, `'hotel'`, `'university'`, `'ymca'`, `'box'`,
 * `'studio'`) should land here in their own slices, ideally after
 * the call-site fallback log surfaces them in production.
 */
function matchEquipmentKeywords(raw: string): { value: EquipmentAccess; matchedKeywords: string[] } {
  const lower = raw.toLowerCase();
  const matchedKeywords: string[] = [];

  // ── Full / commercial gym vocabulary ──────────────────────
  const hasFullGym = lower.includes('full gym');
  if (hasFullGym) matchedKeywords.push('full gym');
  const hasFullCommercial = lower.includes('full commercial');
  if (hasFullCommercial) matchedKeywords.push('full commercial');
  // Slice 3.J expansion (May 2 2026, Felipe-reported): users with
  // legitimate full-gym access were silently downgraded to
  // FALLBACK_EQUIPMENT_ACCESS (no barbell, no dumbbells) when their
  // profile string didn't include "full gym" or "full commercial".
  // Real-world strings observed during onboarding: "commercial gym",
  // "fitness center", "Crossfit box", "fully equipped", "academia"
  // (Portuguese for any gym), "ginásio" (Portuguese-PT). All of
  // these imply barbell + dumbbell access in practice.
  const hasCommercialGym = lower.includes('commercial gym') || lower.includes('commercial-gym');
  if (hasCommercialGym) matchedKeywords.push('commercial gym');
  const hasFitnessCenter = lower.includes('fitness center') || lower.includes('fitness centre') || lower.includes('fitness club');
  if (hasFitnessCenter) matchedKeywords.push('fitness center');
  const hasFullyEquipped = lower.includes('fully equipped') || lower.includes('fully-equipped') || lower.includes('well equipped') || lower.includes('well-equipped');
  if (hasFullyEquipped) matchedKeywords.push('fully equipped');
  const hasCompleteGym = lower.includes('complete gym') || lower.includes('complete-gym');
  if (hasCompleteGym) matchedKeywords.push('complete gym');
  const hasCrossfit = lower.includes('crossfit') || lower.includes('cross-fit') || lower.includes('cross fit');
  if (hasCrossfit) matchedKeywords.push('crossfit');
  // "gym membership", "gym member", "gym access" — common phrasing
  // when a user is describing what they have, not where they train.
  const hasGymMembership = /\bgym\s+(membership|member|access|subscription)\b/.test(lower);
  if (hasGymMembership) matchedKeywords.push('gym membership');
  // Portuguese (pt-BR / pt-PT) — Felipe is a pt user. "Academia"
  // in pt-BR and "ginásio" in pt-PT both mean a commercial gym
  // facility (barbells + dumbbells + machines). The accent-stripped
  // variant `ginasio` covers users who don't type the diacritic.
  // "Academia completa" / "ginásio completo" are the explicit
  // "full" variants.
  const hasAcademiaCompleta = lower.includes('academia completa') || lower.includes('ginásio completo') || lower.includes('ginasio completo');
  if (hasAcademiaCompleta) matchedKeywords.push('academia completa');
  // Word-boundary check on plain "academia"/"ginásio" so we don't
  // false-match phrases like "academia matemática" or part-of-word
  // matches. Tests pin every recognized variant.
  const hasAcademia = /\bacademia\b/.test(lower) || /\bgin[áa]sio\b/.test(lower);
  if (hasAcademia) matchedKeywords.push('academia');

  // ── Home / garage / partial vocabulary (existing) ─────────
  const hasGarageGym = lower.includes('garage');
  if (hasGarageGym) matchedKeywords.push('garage');
  const hasHomeGym = lower.includes('home gym');
  if (hasHomeGym) matchedKeywords.push('home gym');
  const hasBasic = lower.includes('basic');
  if (hasBasic) matchedKeywords.push('basic');

  // ── Bodyweight / resistance vocabulary ────────────────────
  // Includes pt-BR/pt-PT variants for users describing minimal
  // setups in their native language.
  const hasBodyweightOnly = lower.includes('bodyweight')
    || lower.includes('body weight')
    || lower.includes('peso corporal')
    || lower.includes('sem equipamento')
    || lower.includes('no equipment');
  if (hasBodyweightOnly) matchedKeywords.push('bodyweight');
  const hasBands = lower.includes('band')
    || lower.includes('elástico')
    || lower.includes('elastico')
    || lower.includes('faixa');
  if (hasBands) matchedKeywords.push('band');

  // Capability derivation. Any recognized "real gym" vocabulary
  // (commercial / full / Crossfit / fitness-center / fully-equipped
  // / academia[-completa] / ginásio[-completo] / gym-membership)
  // implies barbell + dumbbell access — those facilities have
  // them by definition. Garage gyms typically have barbells too;
  // home/basic gyms have dumbbells but not always barbells.
  const isFullCommercialOrGym =
    hasFullGym ||
    hasFullCommercial ||
    hasCommercialGym ||
    hasFitnessCenter ||
    hasFullyEquipped ||
    hasCompleteGym ||
    hasCrossfit ||
    hasGymMembership ||
    hasAcademia ||
    hasAcademiaCompleta;
  const hasHomeBasic = hasHomeGym || hasBasic;

  return {
    value: {
      hasGym: isFullCommercialOrGym || hasGarageGym || hasHomeBasic,
      hasBarbell: isFullCommercialOrGym || hasGarageGym,
      hasDumbbells: isFullCommercialOrGym || hasGarageGym || hasHomeBasic,
      hasBikeTrainer: false,
      hasPool: false,
      hasTrack: true,
      notes: compact([
        hasBodyweightOnly ? 'Bodyweight-only setup.' : null,
        hasBands ? 'Resistance bands available.' : null,
      ]),
    },
    matchedKeywords,
  };
}

/**
 * Per-sport weekly-minutes resolution provenance for endurance
 * sports (running and cycling). Distinguishes three runtime
 * cases the previous version silently conflated:
 *
 *   1. **`profile_data`** — the athlete's profile carried real
 *      volume data (running mileage in km, cycling weekly hours
 *      bucket). The minutes value came from converting that real
 *      data; ACWR / training-load math is grounded in user-
 *      supplied truth.
 *   2. **`inferred_from_targets`** — no real data on the profile,
 *      but the user has a non-zero weekly target. The resolver
 *      multiplies the target by a heuristic minutes-per-session
 *      constant (45 for running, 55 for cycling). Downstream
 *      consumers including the ACWR load math will operate on a
 *      synthesized number; if the heuristic is too high, ramp-up
 *      gets suppressed (overtraining concern); too low and ramp-
 *      up becomes too aggressive. Audit-flagged silent-default.
 *   3. **`no_volume`** — neither real data nor a non-zero target.
 *      `value: undefined` so the planner reads "no history at
 *      all" instead of synthesizing a number from zero.
 *
 * Slice 3.M splits the inline ternaries in `resolveTrainingHistory`
 * into pure exported functions that return this union. Strength
 * and swimming are NOT covered by this slice because they have no
 * real-data field on the input — every value is `targets ×
 * constant` always, so there's no silent-fallback to surface.
 */
export type EnduranceMinutesResolution =
  | {
      value: number;
      source: 'profile_data';
      rawInputField: string;
      rawInputValue: number;
    }
  | {
      value: number;
      source: 'inferred_from_targets';
      weeklyTarget: number;
      minutesPerSession: number;
    }
  | { value: undefined; source: 'no_volume' };

const RUNNING_INFERENCE_MINUTES_PER_SESSION = 45;
const CYCLING_INFERENCE_MINUTES_PER_SESSION = 55;
const RUNNING_MINIMUM_INFERRED_MINUTES = 60;

/**
 * Resolve the user's last-week running minutes from profile data
 * if available, otherwise infer from `weeklyRunningTarget × 45
 * min/session`. Pinned by
 * `__tests__/services/training-coach-kernel-training-history.test.ts`.
 */
export function resolveRunningWeeklyMinutesWithSource(
  runProfile: Record<string, any> | null | undefined,
  weeklyRunningTarget: number,
  runningPaceSecondsPerKm: number,
): EnduranceMinutesResolution {
  const mileage = numericOrUndefined(runProfile?.weekly_mileage_km);
  if (mileage !== undefined) {
    const minutes = Math.max(
      RUNNING_MINIMUM_INFERRED_MINUTES,
      Math.round(mileage * (runningPaceSecondsPerKm / 60)),
    );
    return {
      value: minutes,
      source: 'profile_data',
      rawInputField: 'run_profile.weekly_mileage_km',
      rawInputValue: mileage,
    };
  }
  if (weeklyRunningTarget > 0) {
    return {
      value: weeklyRunningTarget * RUNNING_INFERENCE_MINUTES_PER_SESSION,
      source: 'inferred_from_targets',
      weeklyTarget: weeklyRunningTarget,
      minutesPerSession: RUNNING_INFERENCE_MINUTES_PER_SESSION,
    };
  }
  return { value: undefined, source: 'no_volume' };
}

/**
 * Resolve the user's last-week cycling minutes from profile data
 * if available, otherwise infer from `weeklyCyclingTarget × 55
 * min/session`. The "real data" path is bucketed via
 * `weeklyHoursToMinutes` (`'< 3'` / `'3-6'` / `'6-10'` / `'10+'`).
 */
export function resolveCyclingWeeklyMinutesWithSource(
  runProfile: Record<string, any> | null | undefined,
  weeklyCyclingTarget: number,
): EnduranceMinutesResolution {
  const fromHours = weeklyHoursToMinutes(runProfile?.weekly_hours);
  if (fromHours !== undefined) {
    return {
      value: fromHours,
      source: 'profile_data',
      rawInputField: 'run_profile.weekly_hours',
      rawInputValue: fromHours,
    };
  }
  if (weeklyCyclingTarget > 0) {
    return {
      value: weeklyCyclingTarget * CYCLING_INFERENCE_MINUTES_PER_SESSION,
      source: 'inferred_from_targets',
      weeklyTarget: weeklyCyclingTarget,
      minutesPerSession: CYCLING_INFERENCE_MINUTES_PER_SESSION,
    };
  }
  return { value: undefined, source: 'no_volume' };
}

/**
 * Build the `TrainingHistory` from pre-resolved per-sport
 * minutes. Strength and swimming use `targets × constant` always
 * (no real-data field on input, no silent-fallback to surface).
 *
 * Slice 4.E (audit Layer-8 Critical) — when `realHistory` is
 * supplied AND has data for a sport, the real per-week series
 * REPLACES the synthesized 4-copy series. Sports without real
 * data fall back to the synthesis layer (brand-new user case).
 * Mixing real + synth is intentional: a runner who logged
 * running for 3 weeks but never logged a strength session gets
 * real running history and synthesized strength history rather
 * than no strength baseline at all.
 */
function resolveTrainingHistory(
  weeklyTargets: Goals['weeklySessionsTarget'],
  runningResolution: EnduranceMinutesResolution,
  cyclingResolution: EnduranceMinutesResolution,
  realHistory?: RealTrainingHistory,
): TrainingHistory {
  const runningMinutes = runningResolution.value;
  const cyclingMinutes = cyclingResolution.value;
  const strengthMinutes = (weeklyTargets.strength ?? 0) * 45;
  const swimmingMinutes = (weeklyTargets.swimming ?? 0) * 40;

  const realLast = realHistory?.lastWeekMinutesBySport ?? {};
  const realSeries = realHistory?.trailing4WeekMinutesBySport ?? {};

  return {
    lastWeekMinutesBySport: {
      running: realLast.running ?? (runningMinutes || undefined),
      strength: realLast.strength ?? (strengthMinutes || undefined),
      cycling: realLast.cycling ?? (cyclingMinutes || undefined),
      swimming: realLast.swimming ?? (swimmingMinutes || undefined),
    },
    trailing4WeekMinutesBySport: {
      running: realSeries.running ?? (runningMinutes ? buildTrailingSeries(runningMinutes) : undefined),
      strength: realSeries.strength ?? (strengthMinutes ? buildTrailingSeries(strengthMinutes) : undefined),
      cycling: realSeries.cycling ?? (cyclingMinutes ? buildTrailingSeries(cyclingMinutes) : undefined),
      swimming: realSeries.swimming ?? (swimmingMinutes ? buildTrailingSeries(swimmingMinutes) : undefined),
    },
  };
}

/**
 * Vocabulary table for the strength-goal matcher. Order matters
 * — earlier entries take precedence under `String.includes`-based
 * scanning. So `'powerlifting'` appears BEFORE `'strength'` even
 * though both map to `'max_strength'`: a user who typed
 * "Powerlifting strength" gets `matchedKeyword: 'powerlifting'`
 * (the more specific intent) rather than the generic `'strength'`.
 *
 * The keyword set is deliberately the same as the pre-slice-3.L
 * implementation (`'hypertrophy'`, `'powerlifting'`, `'strength'`,
 * `'support'`). Adding new tokens like `'maintenance'` or
 * `'powerbuilding'` would shift inputs that previously fell
 * through to `'athletic'` into a different bucket — that's a real
 * behavior change and belongs in a separate vocabulary-expansion
 * slice once the call-site fallback log surfaces what users
 * actually type.
 */
const STRENGTH_GOAL_KEYWORDS: ReadonlyArray<{
  pattern: string;
  keyword: string;
  goal: NonNullable<Goals['strengthGoal']>;
}> = [
  { pattern: 'hypertrophy', keyword: 'hypertrophy', goal: 'hypertrophy' },
  { pattern: 'powerlifting', keyword: 'powerlifting', goal: 'max_strength' },
  { pattern: 'strength', keyword: 'strength', goal: 'max_strength' },
  { pattern: 'support', keyword: 'support', goal: 'maintenance' },
];

/**
 * The "user has nothing recognizable" strength goal. Same
 * `'athletic'` value the pre-slice-3.L resolver returned so the
 * planner-output contract is preserved.
 */
const FALLBACK_STRENGTH_GOAL: NonNullable<Goals['strengthGoal']> = 'athletic';

/**
 * Result of resolving the athlete's strength goal from loose
 * profile data. The discriminated union exists so the caller can
 * distinguish three runtime cases the previous version silently
 * conflated:
 *
 *   1. The profile records a recognized vocabulary token (e.g.
 *      `"Hypertrophy block"`, `"powerlifting peak"`) → `source`
 *      names the field that produced the answer and
 *      `matchedKeyword` records which token in
 *      `STRENGTH_GOAL_KEYWORDS` matched.
 *   2. The profile records an UNRECOGNIZED token (e.g.
 *      `"powerbuilding"`, `"functional fitness"`, `"general
 *      fitness"`) → `source: 'fallback'`, `reason: 'unrecognized'`,
 *      `rawInput` carries the literal string so the call-site
 *      logger can flag the new vocabulary for the matcher list to
 *      absorb. Before slice 3.L every unrecognized goal silently
 *      collapsed to `'athletic'` — the user typed something
 *      specific, the planner picked a generic template.
 *   3. The profile has nothing → `source: 'fallback'`,
 *      `reason: 'missing'`. Different operator action: prompt the
 *      user to fill in their goal.
 *
 * `value` is always the strength goal the planner actually uses.
 * The `source` separation gives the call site clean material for
 * structured logging and future telemetry / UX hooks.
 *
 * Downstream impact: `Goals['strengthGoal']` drives strength
 * prescription template selection — `'hypertrophy'` produces
 * different rep ranges, intensity, and exercise selection than
 * `'max_strength'` / `'athletic'` / `'maintenance'`. So a
 * fallback to `'athletic'` for a user who typed "powerbuilding"
 * is a real plan-shape difference, not just a labeling concern.
 */
export type StrengthGoalResolution =
  | {
      value: NonNullable<Goals['strengthGoal']>;
      source: 'gym_profile.primary_goal';
      matchedKeyword: string;
    }
  | {
      value: NonNullable<Goals['strengthGoal']>;
      source: 'fallback';
      reason: 'missing' | 'unrecognized';
      rawInput?: string;
    };

/**
 * Pure, exported variant of `resolveStrengthGoal` that carries
 * the resolution provenance. Pinned by
 * `__tests__/services/training-coach-kernel-strength-goal.test.ts`.
 */
export function resolveStrengthGoalWithSource(
  gymProfile?: Record<string, any> | null,
): StrengthGoalResolution {
  const raw = pickStrengthGoalString(gymProfile?.primary_goal);
  if (raw === null) {
    return { value: FALLBACK_STRENGTH_GOAL, source: 'fallback', reason: 'missing' };
  }

  const lower = raw.toLowerCase();
  for (const entry of STRENGTH_GOAL_KEYWORDS) {
    if (lower.includes(entry.pattern)) {
      return { value: entry.goal, source: 'gym_profile.primary_goal', matchedKeyword: entry.keyword };
    }
  }

  return {
    value: FALLBACK_STRENGTH_GOAL,
    source: 'fallback',
    reason: 'unrecognized',
    rawInput: raw,
  };
}

/**
 * Wrapper preserved for the existing call-site signature so other
 * consumers don't change. New callers (and the call site that
 * wants to log fallbacks) should use
 * `resolveStrengthGoalWithSource` directly.
 */
function resolveStrengthGoal(gymProfile?: Record<string, any> | null): Goals['strengthGoal'] {
  return resolveStrengthGoalWithSource(gymProfile).value;
}

/**
 * Trim and reject empty/non-string inputs. Returns the trimmed
 * non-empty string, or `null` if the input doesn't carry usable
 * text. Mirrors `pickEquipmentString` in slice 3.J.
 */
function pickStrengthGoalString(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function resolvePriorityOrder(
  primaryFocus: CoachingDiscipline,
  goalMode?: TrainingGoalMode | null,
  trainingPriority?: TrainingPriority | null,
): Goals['priorityOrder'] {
  const base = resolveBasePriorityOrder(primaryFocus);
  const priorityLead = priorityToOrderToken(trainingPriority);
  const reordered = priorityLead ? [priorityLead, ...base.filter((item) => item !== priorityLead)] : base;
  if (goalMode === 'maintenance') return ['maintenance', ...reordered.filter((item) => item !== 'maintenance')];
  if (goalMode === 'return_to_training') return ['return', ...reordered.filter((item) => item !== 'return')];
  return reordered;
}

function resolveBasePriorityOrder(primaryFocus: CoachingDiscipline): Goals['priorityOrder'] {
  switch (primaryFocus) {
    case 'triathlon':
      return ['running', 'cycling', 'swimming', 'strength'];
    case 'marathon':
    case 'running':
      return ['running', 'strength'];
    case 'cycling':
      return ['cycling', 'strength'];
    case 'swimming':
      return ['swimming', 'strength'];
    case 'strength':
      return ['strength'];
    case 'hybrid':
    default:
      return ['strength', 'running'];
  }
}

function priorityToOrderToken(priority?: TrainingPriority | null): Goals['priorityOrder'][number] | null {
  switch (priority) {
    case 'running':
    case 'cycling':
    case 'swimming':
    case 'strength':
      return priority;
    case 'triathlon':
      return 'running';
    case 'hybrid':
    default:
      return null;
  }
}

function isModalityPriority(value: Goals['priorityOrder'][number]): value is Sport | 'strength' {
  return value === 'running' ||
    value === 'cycling' ||
    value === 'swimming' ||
    value === 'strength';
}

function resolveWeeklyMinutesTarget(
  targets: Goals['weeklySessionsTarget'],
  lastWeekMinutes: TrainingHistory['lastWeekMinutesBySport'],
): Goals['weeklyMinutesTarget'] {
  return {
    running: lastWeekMinutes.running ?? (targets.running ? targets.running * 45 : undefined),
    cycling: lastWeekMinutes.cycling ?? (targets.cycling ? targets.cycling * 55 : undefined),
    swimming: lastWeekMinutes.swimming ?? (targets.swimming ? targets.swimming * 40 : undefined),
    strength: lastWeekMinutes.strength ?? (targets.strength ? targets.strength * 45 : undefined),
  };
}

function buildAvailabilityWindows(
  input: CoachKernelTrainingPlanInput,
  targets: Goals['weeklySessionsTarget'],
  normalizedProfile?: NormalizedTrainingProfile,
) {
  const cardioStart = normalizeTime(input.preferredCardioTime, input.preferredTime);
  const strengthStart = normalizeTime(input.preferredStrengthTime, input.preferredTime);
  const weakProfile = normalizedProfile?.quality.planQualityLimited === true
    || (normalizedProfile?.quality.confidenceScore ?? 100) < 65;
  const cardioDuration = normalizedProfile?.availableSessionDurations.enduranceMinutes
    ?? normalizedProfile?.availableSessionDurations.genericMinutes
    ?? (weakProfile ? 45 : 135);
  const strengthDuration = normalizedProfile?.availableSessionDurations.strengthMinutes
    ?? normalizedProfile?.availableSessionDurations.genericMinutes
    ?? (weakProfile ? 35 : 90);
  const windows: AthleteState['availability']['weeklyWindows'] = [];

  for (const dayOfWeek of DAY_ORDER) {
    if ((targets.running ?? 0) > 0 || (targets.cycling ?? 0) > 0 || (targets.swimming ?? 0) > 0) {
      windows.push({
        dayOfWeek,
        start: cardioStart,
        end: addMinutes(cardioStart, cardioDuration),
        sports: ['running', 'cycling', 'swimming'],
        label: 'Cardio window',
      });
    }
    if ((targets.strength ?? 0) > 0) {
      windows.push({
        dayOfWeek,
        start: strengthStart,
        end: addMinutes(strengthStart, strengthDuration),
        sports: ['strength'],
        label: 'Strength window',
      });
    }
  }

  return windows;
}

function trainingPlanProfileQuality(quality: TrainingProfileQuality | undefined): CoordinatedTrainingPlan['profileQuality'] | undefined {
  if (!quality) return undefined;
  return {
    completenessScore: quality.completenessScore,
    confidenceScore: quality.confidenceScore,
    confidenceBand: quality.confidenceBand,
    planQualityLimited: quality.planQualityLimited,
    planningRiskFlags: [...quality.planningRiskFlags],
    missingCriticalData: [...quality.missingCriticalData],
    followUpPrompts: [...quality.followUpQuestions],
  };
}

/**
 * The fields the planner reads to decide whether an athlete is novice,
 * intermediate, or advanced. Both are loose JSON columns at the DB
 * boundary, so the resolver below treats them as `unknown` and tells
 * the caller exactly which source produced the answer.
 */
type ExperienceProfileSource = 'fitness_profile.experience_level' | 'gym_profile.training_age';

/**
 * Result of resolving the athlete's strength experience level from
 * loose profile data. The discriminated union exists so the caller
 * can distinguish two cases the previous version silently
 * conflated:
 *
 *   1. The profile has a recognized value → `source` names the
 *      field that produced the answer and `matchedKeyword` records
 *      which vocabulary token matched. Downstream slice 2.A
 *      (`BEGINNER_SAFE_SUBSTITUTIONS`) acts on a CONFIRMED novice.
 *   2. The profile has nothing recognizable → `source: 'fallback'`.
 *      Either both fields were absent / empty, or both contained
 *      strings we don't recognize (e.g. `"expert"`, `"semi-pro"`).
 *      The companion call-site logger captures the raw inputs so
 *      operators can tell missing-data from new-vocabulary at a
 *      glance and decide whether to absorb the new word into
 *      `matchExperienceFromString`. Before slice 3.I both subcases
 *      were silent; a fresh user with an empty profile was
 *      indistinguishable from a confirmed novice.
 *
 * `value` is always the experience level the planner actually uses
 * (the previous behavior of "default to novice on anything
 * unknown" is preserved at the planner-output layer), but the
 * `source` separation gives the call site clean material for
 * structured logging and future telemetry / UX hooks.
 */
export type ExperienceLevelResolution =
  | { value: AthleteState['profile']['experienceLevel']; source: ExperienceProfileSource; matchedKeyword: string }
  | { value: 'novice'; source: 'fallback' };

/**
 * Pure, exported variant of {@link resolveExperienceLevel} that
 * carries the resolution provenance. The companion
 * `resolveExperienceLevel` keeps the original return shape for
 * callers that don't care about the source.
 *
 * Pinned by `__tests__/services/training-coach-kernel-experience-level.test.ts`.
 */
export function resolveExperienceLevelWithSource(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): ExperienceLevelResolution {
  const fromFitness = matchExperienceFromString(fitnessProfile?.experience_level);
  if (fromFitness) {
    return { ...fromFitness, source: 'fitness_profile.experience_level' };
  }
  const fromGym = matchExperienceFromString(gymProfile?.training_age);
  if (fromGym) {
    return { ...fromGym, source: 'gym_profile.training_age' };
  }
  return { value: 'novice', source: 'fallback' };
}

/**
 * Wrapper preserved for the existing call-site signature so other
 * consumers don't change. New callers (and the call site that wants
 * to log fallbacks) should use `resolveExperienceLevelWithSource`
 * directly.
 */
function resolveExperienceLevel(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): AthleteState['profile']['experienceLevel'] {
  return resolveExperienceLevelWithSource(fitnessProfile, gymProfile).value;
}

/**
 * Match a single profile string against the known experience-level
 * vocabulary. Returns `null` for missing/empty/unrecognized inputs
 * so the caller can decide which source-tag to attach.
 *
 * The keyword list is the same set the previous string-includes
 * implementation used (`'advanced'`, `'5+'`, `'intermediate'`,
 * `'1-3'`, `'3-5'`) plus explicit recognition of `'novice'` /
 * `'beginner'` / `'<1'`. Before slice 3.I a profile literally
 * saying `"novice"` was indistinguishable from a missing field —
 * both fell through the if-chain and returned `'novice'` via
 * fallback. Now the explicit-match path tags the source so the
 * audit-trail log only fires on TRULY missing data.
 */
function matchExperienceFromString(
  raw: unknown,
): { value: AthleteState['profile']['experienceLevel']; matchedKeyword: string } | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return null;
  // ── Original vocabulary (preserved verbatim, same precedence) ──
  if (normalized.includes('advanced')) return { value: 'advanced', matchedKeyword: 'advanced' };
  if (normalized.includes('5+')) return { value: 'advanced', matchedKeyword: '5+' };
  if (normalized.includes('intermediate')) return { value: 'intermediate', matchedKeyword: 'intermediate' };
  if (normalized.includes('1-3')) return { value: 'intermediate', matchedKeyword: '1-3' };
  if (normalized.includes('3-5')) return { value: 'intermediate', matchedKeyword: '3-5' };
  if (normalized.includes('novice')) return { value: 'novice', matchedKeyword: 'novice' };
  if (normalized.includes('beginner')) return { value: 'novice', matchedKeyword: 'beginner' };
  if (normalized.includes('<1')) return { value: 'novice', matchedKeyword: '<1' };
  // ── EXPANSION (May 2 2026, Felipe-reported) ──
  // Felipe (3+ years running, 5+ years gym) was being treated as
  // novice because his profile string didn't match any of the
  // tokens above. Expanded with English synonyms for each level
  // plus Portuguese (pt-BR / pt-PT) variants since Felipe is a
  // pt user. New explicit-token recognitions:
  //   advanced     ← experienced, veteran, expert,
  //                  experiente, veterano, avançado, avancado
  //   intermediate ← intermediário, intermediario
  //   novice       ← iniciante, principiante, novato
  // Portuguese variants checked FIRST so they win when their
  // accent-stripped form is a substring of an English token
  // (e.g. "veterano".includes("veteran") would match the English
  // path first). Order matters: longer/more-specific PT tokens
  // before shorter EN.
  if (normalized.includes('experiente')) return { value: 'advanced', matchedKeyword: 'experiente' };
  if (normalized.includes('veterano')) return { value: 'advanced', matchedKeyword: 'veterano' };
  if (normalized.includes('experienced')) return { value: 'advanced', matchedKeyword: 'experienced' };
  if (normalized.includes('veteran')) return { value: 'advanced', matchedKeyword: 'veteran' };
  if (normalized.includes('expert')) return { value: 'advanced', matchedKeyword: 'expert' };
  if (normalized.includes('avançado') || normalized.includes('avancado')) {
    return { value: 'advanced', matchedKeyword: 'avançado' };
  }
  if (normalized.includes('intermediário') || normalized.includes('intermediario')) {
    return { value: 'intermediate', matchedKeyword: 'intermediário' };
  }
  if (normalized.includes('iniciante')) return { value: 'novice', matchedKeyword: 'iniciante' };
  if (normalized.includes('principiante')) return { value: 'novice', matchedKeyword: 'principiante' };
  if (normalized.includes('novato')) return { value: 'novice', matchedKeyword: 'novato' };
  // Numeric year patterns: "5 years", "10 anos", "3 yrs", "5 ano".
  // Caught AFTER explicit tokens so phrases like "advanced (5
  // years)" keep their explicit-token precedence. Maps:
  //   ≥5 years → advanced       (matches gym lifters with deep base)
  //   1–4 years → intermediate  (mid-cycle athletes)
  //   <1 year  → novice         (true beginners)
  // Word-boundary (`\b`) on the unit so "5 years" matches but
  // "5yearbookofficial" doesn't.
  const yearMatch = normalized.match(/(\d{1,2})\s*\+?\s*(?:years?|anos?|yrs?)\b/);
  if (yearMatch) {
    const years = parseInt(yearMatch[1], 10);
    if (Number.isFinite(years)) {
      if (years >= 5) return { value: 'advanced', matchedKeyword: `${years}+ years` };
      if (years >= 1) return { value: 'intermediate', matchedKeyword: `${years} years` };
      return { value: 'novice', matchedKeyword: `<1 year (${years})` };
    }
  }
  // Unrecognized vocabulary — let the caller fall through to the
  // `'fallback' / 'missing'` path so the audit-trail log captures
  // the new word and we can absorb it into this list later.
  return null;
}

function resolveThresholdPace(runProfile?: Record<string, any> | null): number | undefined {
  const easyPace = String(runProfile?.easy_pace_min_per_km ?? '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(easyPace)) return undefined;
  const [minutes, seconds] = easyPace.split(':').map(Number);
  const easySeconds = minutes * 60 + seconds;
  return Math.max(240, Math.round(easySeconds * 0.92));
}

function resolveWeekPhase(args: {
  weekNumber: number;
  durationWeeks: number;
  weekStart: string;
  races: RaceEvent[];
}): BlockPhase {
  const nextRace = [...args.races]
    .map((race) => ({
      ...race,
      diffDays: Math.round((Date.parse(race.date) - Date.parse(args.weekStart)) / (24 * 60 * 60 * 1000)),
    }))
    .filter((race) => Number.isFinite(race.diffDays) && race.diffDays >= 0)
    .sort((left, right) => left.diffDays - right.diffDays)[0];

  if (nextRace) {
    if (nextRace.diffDays <= 7) return 'race';
    if (nextRace.diffDays <= 21) return 'taper';
    if (nextRace.diffDays <= 42) return 'peak';
  }

  if (args.weekNumber === args.durationWeeks) return 'deload';
  if (args.weekNumber <= 2) return 'base';
  return 'build';
}

function rollAthleteStateForward(athlete: AthleteState, weeklyPlan: WeeklyPlan): AthleteState {
  const weeklyMinutes: Partial<Record<Sport, number>> = {
    running: sumMinutesForSport(weeklyPlan, 'running'),
    cycling: sumMinutesForSport(weeklyPlan, 'cycling'),
    swimming: sumMinutesForSport(weeklyPlan, 'swimming'),
    strength: sumMinutesForSport(weeklyPlan, 'strength'),
  };

  return {
    ...athlete,
    trainingHistory: {
      lastWeekMinutesBySport: {
        ...athlete.trainingHistory.lastWeekMinutesBySport,
        ...weeklyMinutes,
      },
      trailing4WeekMinutesBySport: {
        running: pushTrailingWeek(athlete.trainingHistory.trailing4WeekMinutesBySport.running, weeklyMinutes.running),
        cycling: pushTrailingWeek(athlete.trainingHistory.trailing4WeekMinutesBySport.cycling, weeklyMinutes.cycling),
        swimming: pushTrailingWeek(athlete.trainingHistory.trailing4WeekMinutesBySport.swimming, weeklyMinutes.swimming),
        strength: pushTrailingWeek(athlete.trainingHistory.trailing4WeekMinutesBySport.strength, weeklyMinutes.strength),
      },
    },
  };
}

function convertWeeklyPlanToLegacyWeek(weeklyPlan: WeeklyPlan, weekNumber: number): CoordinatedTrainingWeek {
  return {
    weekNumber,
    focus: weeklyPlan.phase,
    intensityPct: PHASE_INTENSITY[weeklyPlan.phase],
    sessions: weeklyPlan.sessions.map(convertSessionToLegacy),
    decisionReasons: weeklyPlan.decisionReasons,
  };
}

function convertSessionToLegacy(session: Session): CoordinatedTrainingSession {
  return {
    dayOfWeek: DAY_NAME_MAP[session.dayOfWeek],
    sessionType: SESSION_TYPE_LABEL_MAP[session.sessionType] ?? SESSION_TYPE_LABEL_MAP.rest,
    title: session.title,
    durationMinutes: session.durationMinutes,
    description: session.description,
    exercises: session.exercises?.map((exercise) => ({
      name: exercise.name,
      sets: exercise.sets,
      reps: exercise.reps,
      rpe: exercise.rir != null ? `RIR ${exercise.rir}` : undefined,
      rest_sec: exercise.restSec,
    })) ?? [],
    preferredStartTime: session.startTime ?? null,
    scheduleState: session.scheduleState,
    scheduleAdjustments: session.scheduleAdjustments,
    scheduleReason: session.scheduleReason,
    decisionReasons: session.decisionReasons,
    originalDayOfWeek: session.originalDayOfWeek ? DAY_NAME_MAP[session.originalDayOfWeek] : null,
  };
}

function dedupeTrainingDecisionReasons(reasons: TrainingDecisionReason[]): TrainingDecisionReason[] {
  const seen = new Set<string>();
  const output: TrainingDecisionReason[] = [];
  for (const reason of reasons) {
    const key = [
      reason.code,
      reason.affectedEntity.type,
      reason.affectedEntity.id ?? '',
      reason.text.trim().toLowerCase().replace(/\s+/g, ' '),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(reason);
  }
  return output;
}

// TR-EC-QA-O1 (2026-05-03 hostile QA closeout):
// Maintenance volume cap. A user who picks "Maintenance" should not
// receive 7 sessions/week regardless of what they typed in the
// stepper — that defeats the maintenance intent. Apply a deterministic
// scale + hard cap so the plan honors the goal-mode label.
//
// Constants chosen for closed beta:
//   maintenance      → 60% of requested, capped at 4 total
//   return_to_training → 50% of requested, capped at 3 total
//
// The shaping happens AFTER `resolveWeeklyTargets` so the per-modality
// proportions (running:strength split, etc.) are preserved; we just
// scale the totals down. If the resolver returned ≤ the cap already,
// the targets pass through unchanged.
const MAINTENANCE_SCALE = 0.6;
const MAINTENANCE_TOTAL_CAP = 4;
const RETURN_TO_TRAINING_SCALE = 0.5;
const RETURN_TO_TRAINING_TOTAL_CAP = 3;

export function applyGoalModeVolumeShaping(
  rawTargets: Goals['weeklySessionsTarget'],
  input: CoachKernelTrainingPlanInput,
  raceCalendar: RaceEvent[],
): { targets: Goals['weeklySessionsTarget']; decisionReasons: TrainingDecisionReason[] } {
  const reasons: TrainingDecisionReason[] = [];
  const goalMode = input.goalMode ?? null;

  // Sum the per-modality counts to compute the total volume.
  const sumTargets = (t: Goals['weeklySessionsTarget']): number =>
    Object.values(t).reduce<number>((sum, v) => sum + (v ?? 0), 0);

  // No throttling for non-volume-shaping modes — but signals are still
  // emitted in `collectGoalModeDecisionReasons`.
  if (goalMode !== 'maintenance' && goalMode !== 'return_to_training') {
    return { targets: rawTargets, decisionReasons: reasons };
  }

  const scale = goalMode === 'maintenance' ? MAINTENANCE_SCALE : RETURN_TO_TRAINING_SCALE;
  const cap = goalMode === 'maintenance' ? MAINTENANCE_TOTAL_CAP : RETURN_TO_TRAINING_TOTAL_CAP;

  const rawTotal = sumTargets(rawTargets);
  if (rawTotal <= cap) {
    // Already at or below the cap; no throttling needed.
    return { targets: rawTargets, decisionReasons: reasons };
  }

  // Scale each modality proportionally, then cap the total. We round
  // each modality first, then trim the highest-volume one if the sum
  // overshoots after rounding.
  const scaled: Goals['weeklySessionsTarget'] = {};
  let runningTotal = 0;
  for (const [sport, count] of Object.entries(rawTargets) as Array<[Sport, number | undefined]>) {
    if (!count || count <= 0) continue;
    // Strength stays at minimum 1 if it was originally requested in
    // either maintenance or return-to-training (otherwise the user
    // loses their gym work entirely).
    const minForSport = sport === 'strength' && count > 0 ? 1 : 0;
    const scaledCount = Math.max(minForSport, Math.round(count * scale));
    if (scaledCount > 0) {
      scaled[sport] = scaledCount;
      runningTotal += scaledCount;
    }
  }

  // Hard cap on total: trim the highest-count non-strength modality
  // (we keep the strength minimum as a recovery anchor).
  while (runningTotal > cap) {
    const candidates = (Object.entries(scaled) as Array<[Sport, number]>)
      .filter(([sport, _count]) => sport !== 'strength')
      .sort(([, a], [, b]) => b - a);
    if (candidates.length === 0) break;
    const [sport] = candidates[0];
    scaled[sport] = (scaled[sport] ?? 0) - 1;
    if ((scaled[sport] ?? 0) <= 0) delete scaled[sport];
    runningTotal -= 1;
  }

  const reasonCode: TrainingDecisionReasonCode =
    goalMode === 'maintenance' ? 'maintenance_volume_capped' : 'return_to_training_volume_capped';
  const reasonText =
    goalMode === 'maintenance'
      ? `Plan volume capped at ${cap} sessions/week because Goal Mode is "Maintenance" (you requested ${rawTotal}). Maintenance prioritises consistency over progression.`
      : `Plan volume capped at ${cap} sessions/week because Goal Mode is "Return to training" (you requested ${rawTotal}). The coach ramps up gradually after a layoff to protect against re-injury.`;

  reasons.push({
    code: reasonCode,
    text: reasonText,
    severity: 'notice',
    affectedEntity: { type: 'week' },
    sourceConstraint: { type: 'volume', label: goalMode },
    before: { weeklyTargets: rawTargets, totalSessions: rawTotal },
    after: { weeklyTargets: scaled, totalSessions: runningTotal, cap },
    preservedIntent: 'goal_mode_volume_alignment',
    evidence: [`requested=${rawTotal}`, `cap=${cap}`, `scale=${scale}`, `goalMode=${goalMode}`],
  });

  // Mark raceCalendar in evidence if present so downstream readers can
  // see the planner kept any race date despite shaping.
  if (raceCalendar.length > 0) {
    reasons[0].evidence!.push(`raceDate=${raceCalendar[0].date}`);
  }

  return { targets: scaled, decisionReasons: reasons };
}

// TR-EC-QA-O2 (2026-05-03 hostile QA closeout):
// Goal-mode reason collector. Codex's prior pass plumbed goalMode
// through but never emitted user-actionable signal when the field
// was inert. The collector now surfaces:
//   • maintenance/return_to_training cap (volume_capped reason from
//     applyGoalModeVolumeShaping — passed through)
//   • continuous + no-taper assertion (continuous_plan_no_taper) so
//     the iOS banner can confirm the coach intentionally avoided a
//     taper week
//   • event_based + no raceDate (event_based_missing_race_date) so
//     the iOS create-plan flow can prompt the user to add the date
function collectGoalModeDecisionReasons(args: {
  input: CoachKernelTrainingPlanInput;
  rawTargets: Goals['weeklySessionsTarget'];
  raceCalendar: RaceEvent[];
}): TrainingDecisionReason[] {
  const { input, rawTargets, raceCalendar } = args;
  const out: TrainingDecisionReason[] = [];
  const goalMode = input.goalMode ?? null;

  // Re-emit the shaping reason from the RAW resolveWeeklyTargets output
  // (not the already-shaped targets — passing the post-shape result
  // would short-circuit the cap-detection because the targets would
  // already be ≤ cap). The helper is pure + cheap so re-running it is
  // safe; dedupe at line 198 collapses any duplicate.
  const shaping = applyGoalModeVolumeShaping(rawTargets, input, raceCalendar);
  out.push(...shaping.decisionReasons);

  // Continuous plan — emit a reassuring signal that no fake taper
  // will be applied. The kernel `resolveWeekPhase` derives phase from
  // race calendar, so a continuous plan with empty raceCalendar will
  // never produce a 'taper' or 'race' phase. The decisionReason
  // documents this for users who might wonder why their plan looks
  // flat across weeks.
  if (goalMode === 'continuous') {
    out.push({
      code: 'continuous_plan_no_taper',
      text: 'Continuous mode — the coach maintains build/recovery cycles instead of a race taper. Your plan stays balanced week-over-week.',
      severity: 'info',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'volume', label: 'continuous' },
      preservedIntent: 'no_fake_taper_without_event',
      evidence: ['goalMode=continuous'],
    });
  }

  // Event-based without a race date — the request shape is
  // incomplete. The plan-linter rule
  // `race_specific_plan_requires_race_date` already catches the
  // most-egregious case (race-typed objective without date), but
  // the goal-mode signal is more direct: the user explicitly said
  // "event-based" without supplying a date. Surface as a warning
  // so iOS can prompt for the missing input on the same screen.
  if (goalMode === 'event_based' && raceCalendar.length === 0) {
    out.push({
      code: 'event_based_missing_race_date',
      text: 'You picked Event-based mode but no race date is set. Add a race date so the coach can structure build, peak, and taper around your event.',
      severity: 'warning',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'volume', label: 'event_based' },
      preservedIntent: 'race_specific_plan_requires_race_date',
      evidence: ['goalMode=event_based', 'raceCalendar=empty'],
    });
  }

  return out;
}

function legacyPlanSport(primaryFocus: CoachingDiscipline): CoordinatedTrainingPlan['sport'] {
  switch (primaryFocus) {
    case 'triathlon':
    case 'hybrid':
      return 'hybrid';
    case 'marathon':
    case 'running':
      return 'running';
    case 'cycling':
      return 'cycling';
    case 'swimming':
      return 'swimming';
    case 'strength':
    default:
      return 'gym';
  }
}

function normalizeRaceDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function normalizeRaceSubtype(targetRace: unknown, objective: string): RaceEvent['subtype'] | undefined {
  const source = String(targetRace || objective).toLowerCase();
  if (source.includes('marathon') && !source.includes('half')) return 'marathon';
  if (source.includes('half')) return 'half_marathon';
  if (source.includes('10k')) return '10k';
  if (source.includes('5k')) return '5k';
  if (source.includes('ultra')) return undefined;
  if (source.includes('70.3')) return '70.3';
  if (source.includes('ironman')) return 'ironman';
  return undefined;
}

function normalizeTime(preferredTime: string, fallback: string): string {
  const candidate = typeof preferredTime === 'string' ? preferredTime.trim() : '';
  if (/^\d{2}:\d{2}$/.test(candidate)) return candidate;
  return /^\d{2}:\d{2}$/.test(fallback) ? fallback : '12:00';
}

function addMinutes(time: string, minutesToAdd: number): string {
  const [hours, minutes] = time.split(':').map(Number);
  const totalMinutes = ((hours || 0) * 60) + (minutes || 0) + minutesToAdd;
  const safeMinutes = Math.max(0, Math.min(23 * 60 + 55, totalMinutes));
  const safeHours = Math.floor(safeMinutes / 60);
  const safeRemainder = safeMinutes % 60;
  return `${String(safeHours).padStart(2, '0')}:${String(safeRemainder).padStart(2, '0')}`;
}

function normalizeDayOfWeek(value: unknown): DayOfWeek | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return DAY_ORDER.includes(normalized as DayOfWeek) ? normalized as DayOfWeek : null;
}

function availabilityDaysCap(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (value.includes('6')) return 6;
  if (value.includes('5')) return 5;
  if (value.includes('4')) return 4;
  if (value.includes('3')) return 3;
  if (value.includes('2')) return 2;
  return null;
}

function weeklyHoursToMinutes(value: unknown): number | undefined {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  if (!text) return undefined;
  if (text.includes('10+')) return 660;
  if (text.includes('6-10')) return 480;
  if (text.includes('3-6')) return 270;
  if (text.includes('< 3')) return 120;
  return undefined;
}

function numericOrUndefined(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function defaultLongSessionDay(primaryFocus: CoachingDiscipline): DayOfWeek {
  return primaryFocus === 'triathlon' ? 'saturday' : 'sunday';
}

function totalTargetSessions(targets: Goals['weeklySessionsTarget']): number {
  return Object.values(targets).reduce((sum, value) => sum + (value ?? 0), 0);
}

/**
 * Slice 2.B — explicit two-a-day routing.
 *
 * Three-state preference maps to the planner's `maxSessionsPerDay`:
 *   - `'preferred'`: always allow 2 sessions/day. The planner will use
 *     the existing `preferredCardioTime` / `preferredStrengthTime` split
 *     (e.g. 07:00 cardio + 18:00 strength) to space the day's two
 *     sessions adequately.
 *   - `'optional'` or `null` / `undefined`: keep the existing volume-
 *     based inference — 2/day only when strength is in the mix AND
 *     total weekly sessions ≥ 5. This is the default so callers that
 *     don't pass a preference (legacy clients, tests, internal code)
 *     keep the previous behavior.
 *   - `'never'`: cap at 1 session/day. Volume that doesn't fit gets
 *     compressed via the guardrail layer.
 */
export function resolveMaxSessionsPerDay(
  preference: 'never' | 'optional' | 'preferred' | null | undefined,
  weeklyTargets: Goals['weeklySessionsTarget'],
): number {
  if (preference === 'preferred') return 2;
  if (preference === 'never') return 1;
  // optional / nullish — fall back to the volume-based inference that
  // was the existing default before slice 2.B added the explicit field.
  return weeklyTargets.strength && totalTargetSessions(weeklyTargets) >= 5 ? 2 : 1;
}

function offsetDate(startDate: string, offsetDays: number): string {
  const date = new Date(`${startDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function buildTrailingSeries(currentWeekMinutes: number): number[] {
  return [
    Math.max(30, Math.round(currentWeekMinutes * 0.82)),
    Math.max(30, Math.round(currentWeekMinutes * 0.9)),
    Math.max(30, Math.round(currentWeekMinutes * 0.96)),
    currentWeekMinutes,
  ];
}

function pushTrailingWeek(history: number[] | undefined, nextValue: number | undefined): number[] | undefined {
  if (nextValue == null || nextValue <= 0) return history;
  const base = [...(history ?? [])].slice(-3);
  return [...base, nextValue];
}

function sumMinutesForSport(weeklyPlan: WeeklyPlan, sport: Sport): number {
  return weeklyPlan.sessions
    .filter((session) => session.sport === sport)
    .reduce((sum, session) => sum + session.durationMinutes, 0);
}

function cleanFreeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /^none\b/i.test(trimmed)) return null;
  return trimmed;
}

function compact<T>(values: Array<T | null | undefined | false>): T[] {
  return values.filter(Boolean) as T[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
