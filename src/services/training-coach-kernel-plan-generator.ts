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
  Session,
  Sport,
  TrainingHistory,
  WeeklyPlan,
} from './coach-kernel/types';
import { DAY_ORDER } from './coach-kernel/utils';
import { recordWeeklyPlan } from './coach-plan-registry';
import type { CoordinatedTrainingPlan, CoordinatedTrainingSession, CoordinatedTrainingWeek } from './training-plan-coordination';

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

  const weeks: CoordinatedTrainingWeek[] = Array.from({ length: input.durationWeeks }, (_, index) => {
    const weekNumber = index + 1;
    const weekStart = offsetDate(input.startDate, index * 7);
    const phase = resolveWeekPhase({
      weekNumber,
      durationWeeks: input.durationWeeks,
      weekStart,
      races: athlete.goals.raceCalendar,
    });

    const weekAthlete: AthleteState = {
      ...rollingAthlete,
      currentBlock: {
        ...rollingAthlete.currentBlock,
        phase,
        weekIndex: weekNumber,
        totalWeeks: input.durationWeeks,
      },
    };

    const weeklyPlan = buildWeekPlan(weekAthlete, weekStart);
    // Retain the raw WeeklyPlan (for guardrail reasoning) AND the
    // AthleteState that produced it (so the home-view route can re-run
    // `adjustForFatigue` with today's live readiness). The legacy
    // converter below discards both fields.
    recordWeeklyPlan(weeklyPlan, weekAthlete);
    rollingAthlete = rollAthleteStateForward(weekAthlete, weeklyPlan);
    return convertWeeklyPlanToLegacyWeek(weeklyPlan, weekNumber);
  });

  return {
    planName: `${input.objective.trim()} — Coach Plan`,
    sport: legacyPlanSport(athlete.goals.primaryFocus),
    periodization: 'block',
    weeks,
  };
}

export function buildAthleteStateFromTrainingProfiles(input: CoachKernelTrainingPlanInput): AthleteState {
  const primaryFocus = resolvePrimaryFocus(input.objective, input.sessionsPerWeek, input.strengthSessionsPerWeek);
  const weeklyTargets = resolveWeeklyTargets(primaryFocus, input);
  const raceCalendar = resolveRaceCalendar(primaryFocus, input.objective, input.runProfile);
  const constraints = resolveConstraints(input.fitnessProfile, input.runProfile, input.notes);
  const equipment = resolveEquipmentAccess(input.fitnessProfile, input.gymProfile);
  const trainingHistory = resolveTrainingHistory(input, weeklyTargets);

  return {
    profile: {
      athleteId: input.userId,
      name: 'Nexus Hub Athlete',
      experienceLevel: resolveExperienceLevel(input.fitnessProfile, input.gymProfile),
      primaryDiscipline: primaryFocus,
      thresholdPaceSecondsPerKm: resolveThresholdPace(input.runProfile),
      cyclingFtpWatts: numericOrUndefined(input.runProfile?.ftp_watts ?? input.fitnessProfile?.ftp_watts),
      swimCssSecondsPer100m: numericOrUndefined(input.fitnessProfile?.swim_css_seconds_per_100m),
      maxHeartRate: numericOrUndefined(input.fitnessProfile?.max_heart_rate),
      thresholdHeartRate: numericOrUndefined(input.fitnessProfile?.threshold_heart_rate),
      restingHeartRate: numericOrUndefined(input.fitnessProfile?.resting_heart_rate),
      bodyWeightKg: numericOrUndefined(input.fitnessProfile?.weight_kg),
    },
    goals: {
      primaryFocus,
      secondaryFocus: weeklyTargets.strength ? 'strength' : undefined,
      strengthGoal: resolveStrengthGoal(input.gymProfile),
      raceCalendar,
      priorityOrder: resolvePriorityOrder(primaryFocus),
      weeklySessionsTarget: weeklyTargets,
      weeklyMinutesTarget: resolveWeeklyMinutesTarget(weeklyTargets, trainingHistory.lastWeekMinutesBySport),
    },
    constraints,
    availability: {
      weeklyWindows: buildAvailabilityWindows(input, weeklyTargets),
      preferredLongSessionDay: normalizeDayOfWeek(input.longWorkoutDay) ?? defaultLongSessionDay(primaryFocus),
      preferredTimesBySport: {
        running: normalizeTime(input.preferredCardioTime, input.preferredTime),
        cycling: normalizeTime(input.preferredCardioTime, input.preferredTime),
        swimming: normalizeTime(input.preferredCardioTime, input.preferredTime),
        strength: normalizeTime(input.preferredStrengthTime, input.preferredTime),
      },
      maxSessionsPerDay: weeklyTargets.strength && totalTargetSessions(weeklyTargets) >= 5 ? 2 : 1,
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
    recentSessions: [],
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

function resolvePrimaryFocus(objective: string, sessionsPerWeek: number, strengthSessionsPerWeek: number): CoachingDiscipline {
  const lowerObjective = objective.toLowerCase();
  if (/(triathlon|triatlo|70\\.3|ironman|half ironman)/i.test(lowerObjective)) return 'triathlon';
  if (/(marathon|meia maratona|half marathon)/i.test(lowerObjective)) return 'marathon';
  if (/(corrida|running|run|10k|5k|trail|ultra)/i.test(lowerObjective)) return 'running';
  if (/(cycling|bike|ride|ciclismo)/i.test(lowerObjective)) return 'cycling';
  if (/(swim|swimming|natacao|natação)/i.test(lowerObjective)) return 'swimming';
  if (/(hipertrofia|hypertrophy|strength|gym|massa|bodybuilding|força|muscula)/i.test(lowerObjective)) return 'strength';
  if (strengthSessionsPerWeek > 0 && sessionsPerWeek > strengthSessionsPerWeek) return 'hybrid';
  return 'hybrid';
}

function resolveWeeklyTargets(
  primaryFocus: CoachingDiscipline,
  input: CoachKernelTrainingPlanInput,
): Goals['weeklySessionsTarget'] {
  const total = clamp(Math.max(3, Math.min(7, input.sessionsPerWeek)), 3, 7);
  const strength = clamp(Math.max(0, Math.min(4, input.strengthSessionsPerWeek)), 0, 4);

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
      const running = clamp(Math.max(2, total), 2, runningCap ?? 7);
      return { running, strength: strength };
    }
    case 'cycling':
      return { cycling: total, strength: strength };
    case 'swimming':
      return { swimming: total, strength: strength };
    case 'strength':
      return { strength: Math.max(total, strength || total) };
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
): RaceEvent[] {
  const raceDate = normalizeRaceDate(runProfile?.target_race_date);
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

function resolveEquipmentAccess(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): EquipmentAccess {
  const raw = String(
    gymProfile?.equipment_access
      ?? fitnessProfile?.available_equipment
      ?? '',
  ).toLowerCase();

  const hasFullGym = raw.includes('full gym') || raw.includes('full commercial');
  const hasGarageGym = raw.includes('garage');
  const hasHomeBasic = raw.includes('home gym') || raw.includes('basic');
  const hasBodyweightOnly = raw.includes('bodyweight');

  return {
    hasGym: hasFullGym || hasGarageGym || hasHomeBasic,
    hasBarbell: hasFullGym || hasGarageGym,
    hasDumbbells: hasFullGym || hasGarageGym || hasHomeBasic,
    hasBikeTrainer: false,
    hasPool: false,
    hasTrack: true,
    notes: compact([
      hasBodyweightOnly ? 'Bodyweight-only setup.' : null,
      raw.includes('band') ? 'Resistance bands available.' : null,
    ]),
  };
}

function resolveTrainingHistory(
  input: CoachKernelTrainingPlanInput,
  weeklyTargets: Goals['weeklySessionsTarget'],
): TrainingHistory {
  const runningPace = resolveThresholdPace(input.runProfile) ?? 360;
  const runningMileageKm = numericOrUndefined(input.runProfile?.weekly_mileage_km);
  const runningMinutes = runningMileageKm
    ? Math.max(60, Math.round(runningMileageKm * (runningPace / 60)))
    : (weeklyTargets.running ?? 0) * 45;
  const strengthMinutes = (weeklyTargets.strength ?? 0) * 45;
  const cyclingMinutes = weeklyHoursToMinutes(input.runProfile?.weekly_hours) ?? (weeklyTargets.cycling ?? 0) * 55;
  const swimmingMinutes = (weeklyTargets.swimming ?? 0) * 40;

  return {
    lastWeekMinutesBySport: {
      running: runningMinutes || undefined,
      strength: strengthMinutes || undefined,
      cycling: cyclingMinutes || undefined,
      swimming: swimmingMinutes || undefined,
    },
    trailing4WeekMinutesBySport: {
      running: runningMinutes ? buildTrailingSeries(runningMinutes) : undefined,
      strength: strengthMinutes ? buildTrailingSeries(strengthMinutes) : undefined,
      cycling: cyclingMinutes ? buildTrailingSeries(cyclingMinutes) : undefined,
      swimming: swimmingMinutes ? buildTrailingSeries(swimmingMinutes) : undefined,
    },
  };
}

function resolveStrengthGoal(gymProfile?: Record<string, any> | null): Goals['strengthGoal'] {
  const goal = String(gymProfile?.primary_goal ?? '').toLowerCase();
  if (goal.includes('hypertrophy')) return 'hypertrophy';
  if (goal.includes('strength') || goal.includes('powerlifting')) return 'max_strength';
  if (goal.includes('support')) return 'maintenance';
  return 'athletic';
}

function resolvePriorityOrder(primaryFocus: CoachingDiscipline): Goals['priorityOrder'] {
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
) {
  const cardioStart = normalizeTime(input.preferredCardioTime, input.preferredTime);
  const strengthStart = normalizeTime(input.preferredStrengthTime, input.preferredTime);
  const windows: AthleteState['availability']['weeklyWindows'] = [];

  for (const dayOfWeek of DAY_ORDER) {
    if ((targets.running ?? 0) > 0 || (targets.cycling ?? 0) > 0 || (targets.swimming ?? 0) > 0) {
      windows.push({
        dayOfWeek,
        start: cardioStart,
        end: addMinutes(cardioStart, 135),
        sports: ['running', 'cycling', 'swimming'],
        label: 'Cardio window',
      });
    }
    if ((targets.strength ?? 0) > 0) {
      windows.push({
        dayOfWeek,
        start: strengthStart,
        end: addMinutes(strengthStart, 90),
        sports: ['strength'],
        label: 'Strength window',
      });
    }
  }

  return windows;
}

function resolveExperienceLevel(
  fitnessProfile?: Record<string, any> | null,
  gymProfile?: Record<string, any> | null,
): AthleteState['profile']['experienceLevel'] {
  const experience = String(fitnessProfile?.experience_level ?? gymProfile?.training_age ?? '').toLowerCase();
  if (experience.includes('advanced') || experience.includes('5+')) return 'advanced';
  if (experience.includes('intermediate') || experience.includes('1-3') || experience.includes('3-5')) return 'intermediate';
  return 'novice';
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
    })) ?? [],
    preferredStartTime: session.startTime ?? null,
  };
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
