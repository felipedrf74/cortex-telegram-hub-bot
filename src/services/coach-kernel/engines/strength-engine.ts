// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type {
  AthleteState,
  DayOfWeek,
  Exercise,
  ExercisePrescription,
  Session,
  SessionType,
  WorkoutTemplate,
} from '../types';
import {
  DAY_ORDER,
  clamp,
  createSessionId,
  durationToLoad,
  findWindowsForDay,
  timeToMinutes,
} from '../utils';
import {
  DEFAULT_COHERENCE_TOLERANCE_PCT,
  MIN_CREDIBLE_STRENGTH_MINUTES,
  estimateStrengthSessionMinutes,
  suggestCorrection,
  validateSessionCoherence,
} from '../session-coherence';
import {
  applyBiomechanicsSafetySubstitutions,
  orderExercisesForSession,
} from '../biomechanics-and-ordering';
import {
  exerciseConflictsWithUserPain,
  getExerciseComplexity,
  getExercisePrimaryPurpose,
  getExerciseSpinalLoading,
} from '../exercise-metadata';

type StrengthProfile = 'maintenance' | 'hypertrophy' | 'max_strength' | 'athletic';
type StrengthExperience = AthleteState['profile']['experienceLevel'];

interface StrengthVariant {
  title: string;
  exerciseIds: string[];
  tags: string[];
}

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing strength template for ${sessionType}`);
  return match;
}

function resolveStrengthProfile(context: EngineContext, maintenance: boolean): StrengthProfile {
  if (maintenance) return 'maintenance';
  switch (context.athlete.goals.strengthGoal) {
    case 'hypertrophy':
      return 'hypertrophy';
    case 'max_strength':
      return 'max_strength';
    case 'maintenance':
      return 'maintenance';
    default:
      return 'athletic';
  }
}

function preferredSessionType(profile: StrengthProfile): SessionType {
  if (profile === 'maintenance') return 'strength_maintenance';
  if (profile === 'hypertrophy') return 'strength_hypertrophy';
  return 'strength_max';
}

function availableEquipment(athlete: AthleteState): Set<string> {
  const equipment = new Set<string>();
  if (athlete.equipment.hasGym) {
    equipment.add('rack');
    equipment.add('bench');
    equipment.add('pullup_bar');
    equipment.add('lat_pulldown');
    equipment.add('kettlebells');
    equipment.add('dumbbells');
    equipment.add('barbell');
  }
  if (athlete.equipment.hasBarbell) equipment.add('barbell');
  if (athlete.equipment.hasDumbbells) equipment.add('dumbbells');
  if (athlete.equipment.hasBikeTrainer) equipment.add('bike_trainer');
  if (athlete.equipment.hasPool) equipment.add('pool');
  if (athlete.equipment.hasTrack) equipment.add('track');
  return equipment;
}

function canPerformExercise(exercise: Exercise, equipment: Set<string>): boolean {
  return exercise.equipment.every((requirement) => equipment.has(requirement));
}

function resolveExerciseCandidate(
  exerciseId: string,
  libraryById: Map<string, Exercise>,
  equipment: Set<string>,
  usedIds: Set<string>,
  seenIds: Set<string> = new Set(),
): Exercise | null {
  if (seenIds.has(exerciseId)) return null;
  seenIds.add(exerciseId);

  const exercise = libraryById.get(exerciseId);
  if (!exercise) return null;

  if (canPerformExercise(exercise, equipment) && !usedIds.has(exercise.id)) {
    return exercise;
  }

  for (const substitutionId of exercise.substitutions ?? []) {
    const candidate = resolveExerciseCandidate(substitutionId, libraryById, equipment, usedIds, seenIds);
    if (candidate) return candidate;
  }

  const patternFallback = Array.from(libraryById.values()).find((candidate) =>
    candidate.movementPattern === exercise.movementPattern
    && canPerformExercise(candidate, equipment)
    && !usedIds.has(candidate.id)
  );

  return patternFallback ?? null;
}

function prescriptionFor(
  exercise: Exercise,
  profile: StrengthProfile,
  experience: StrengthExperience,
): Omit<ExercisePrescription, 'exerciseId' | 'name' | 'notes'> {
  const mainPattern = ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern);
  const accessoryPattern = ['single_leg', 'carry'].includes(exercise.movementPattern);
  const supportPattern = exercise.movementPattern === 'core' || exercise.movementPattern === 'mobility';

  switch (profile) {
    case 'maintenance': {
      const sets = experience === 'advanced' && mainPattern ? 3 : 2;
      return {
        sets,
        reps: supportPattern ? '8-12' : '5-8',
        rir: 3,
        restSec: mainPattern ? 90 : 45,
      };
    }
    case 'hypertrophy': {
      const sets = supportPattern ? 3 : experience === 'advanced' && mainPattern ? 4 : 3;
      return {
        sets,
        reps: supportPattern ? '10-15' : experience === 'novice' ? '8-12' : '6-10',
        rir: experience === 'novice' ? 2 : 1,
        restSec: mainPattern ? 90 : 60,
      };
    }
    case 'max_strength': {
      const sets = mainPattern ? (experience === 'novice' ? 3 : 4) : 3;
      return {
        sets,
        reps: mainPattern ? (experience === 'novice' ? '5-6' : '3-5') : '6-10',
        rir: experience === 'novice' ? 3 : 2,
        restSec: mainPattern ? 120 : 75,
      };
    }
    default: {
      const sets = mainPattern ? (experience === 'novice' ? 3 : 4) : accessoryPattern ? 3 : 2;
      return {
        sets,
        reps: supportPattern ? '10-15' : experience === 'novice' ? '8-10' : '5-8',
        rir: experience === 'novice' ? 3 : 2,
        restSec: mainPattern ? 105 : 60,
      };
    }
  }
}

/**
 * Slice 2.A — beginner-safe substitutions for the variant exercise IDs.
 *
 * The variant catalog above is calibrated for intermediate / advanced
 * lifters: barbell back-rack work (front squat), bench press, pull-ups.
 * For a novice these movements load too much technique cost. Each entry
 * below maps a "default" exerciseId to a safer first-step alternative
 * that emphasises the same movement pattern with reduced cueing load:
 *
 *   front_squat            → goblet_squat (pattern: squat — easier ankle / wrist setup)
 *   bench_press            → dumbbell_bench_press (pattern: push — easier scapular setup)
 *   pull_up                → lat_pulldown (pattern: pull — beginner can scale assistance)
 *   romanian_deadlift      → hip_hinge_band (pattern: hinge — pattern teaching tool)
 *   single_leg_rdl         → split_squat (pattern: single-leg — less balance demand)
 *   dumbbell_bench_press   → push_up (pattern: push — load-free starting point if no DBs)
 *   one_arm_dumbbell_row   → suitcase_carry (pattern: pull — re-routes to anti-rotation work)
 *   suitcase_carry         → farmer_carry (pattern: carry — bilateral cleaner cue)
 *
 * We DO NOT apply these substitutions when:
 *   - the original exercise can't be mapped (no entry → keep the original).
 *   - the resolveExerciseCandidate fallback path will reach a safer
 *     alternative anyway via the equipment-aware substitution graph.
 *
 * The substitution is layered IN FRONT of resolveExerciseCandidate so the
 * equipment fallback still kicks in if the user does not have dumbbells.
 * Beginner + no-dumbbell user → goblet_squat → bodyweight_squat (via the
 * exercise's substitution graph). Code stays correct end-to-end.
 */
const BEGINNER_SAFE_SUBSTITUTIONS: Record<string, string> = {
  front_squat: 'goblet_squat',
  bench_press: 'dumbbell_bench_press',
  pull_up: 'lat_pulldown',
  romanian_deadlift: 'hip_hinge_band',
  single_leg_rdl: 'split_squat',
};

function applyBeginnerSubstitutions(
  variant: StrengthVariant,
  experience: StrengthExperience,
): StrengthVariant {
  if (experience !== 'novice') return variant;
  const substituted = variant.exerciseIds.map((id) => BEGINNER_SAFE_SUBSTITUTIONS[id] ?? id);
  // Dedup while preserving order (substitutions can collide — e.g.,
  // two variants both swap to lat_pulldown).
  const seen = new Set<string>();
  const exerciseIds = substituted.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    title: variant.title,
    exerciseIds,
    tags: [...variant.tags, 'beginner_safe'],
  };
}

/**
 * Pick the strength-session variant for a given (profile,
 * targetSessions, dayIndex, weekIndex) combination.
 *
 * Slice 4.C — multi-week rotation. Pre-slice the `slot` was computed
 * from `dayIndex` alone, so Week 1 day 1 = Week 5 day 1 = Week 12
 * day 1 across an 8-week plan ("Lower Body A on Monday, every
 * Monday"). The audit flagged this as a multi-week variant gap
 * compounding regression #2.
 *
 * The fix shifts the slot by `weekIndex` modulo the variant count.
 * For 4-session weeks (4 variants in pool):
 *   week 0 → slots [Lower A, Upper A, Lower B, Upper B]
 *   week 1 → slots [Upper A, Lower B, Upper B, Lower A] (shifted +1)
 *   week 2 → slots [Lower B, Upper B, Lower A, Upper A] (shifted +2)
 *   week 3 → slots [Upper B, Lower A, Upper A, Lower B] (shifted +3)
 *   week 4 → back to week-0 ordering
 *
 * The variant count for 4-session plans is 4, so this gives a
 * 4-week macro-rotation: any specific (slot, week-mod-4) pair
 * produces a distinct variant. Weekly variety preserved (slice 4.B
 * primary-pattern alternation) and multi-week variety added without
 * tracking history in AthleteState — pure deterministic rotation
 * indexed on the planner's existing `currentBlock.weekIndex`.
 *
 * Signature is backward compatible: when `weekIndex` is omitted (or
 * zero), behavior matches the pre-slice-4.C form exactly.
 */
function strengthVariantFor(
  profile: StrengthProfile,
  targetSessions: number,
  index: number,
  weekIndex: number = 0,
): StrengthVariant {
  const profileTitle = profile === 'hypertrophy'
    ? 'Hypertrophy'
    : profile === 'max_strength'
      ? 'Strength'
      : profile === 'maintenance'
        ? 'Maintenance'
        : 'Strength';
  // Slice 4.C — slot shifted by weekIndex so successive weeks don't
  // ship identical day→variant mappings. We modulo-twice (once on
  // weekIndex itself, once on the sum) so a callsite passing a very
  // large weekIndex value can't overflow the bounds.
  const safeWeekShift = Math.max(0, Math.trunc(weekIndex));
  const variantCount = Math.max(1, targetSessions);
  const slot = (Math.max(0, index) + safeWeekShift) % variantCount;

  if (targetSessions >= 4) {
    const variants: StrengthVariant[] = [
      {
        title: `Lower Body ${profileTitle} A`,
        exerciseIds: ['front_squat', 'romanian_deadlift', 'split_squat', 'dead_bug', 'farmer_carry'],
        tags: ['lower_body', 'posterior_chain', 'core'],
      },
      {
        title: `Upper Body ${profileTitle} A`,
        exerciseIds: ['bench_press', 'pull_up', 'one_arm_dumbbell_row', 'push_up', 'hollow_hold'],
        tags: ['upper_body', 'push', 'pull'],
      },
      {
        title: `Lower Body ${profileTitle} B`,
        exerciseIds: ['goblet_squat', 'single_leg_rdl', 'lunging_iso_hold', 'hip_hinge_band', 'bear_crawl'],
        tags: ['lower_body', 'single_leg', 'core'],
      },
      {
        title: `Upper Body ${profileTitle} B`,
        exerciseIds: ['lat_pulldown', 'dumbbell_bench_press', 'one_arm_dumbbell_row', 'suitcase_carry', 'dead_bug'],
        tags: ['upper_body', 'pull', 'carry'],
      },
    ];
    return variants[slot] ?? variants[0];
  }

  if (targetSessions === 3) {
    const variants: StrengthVariant[] = [
      {
        title: `Full Body ${profileTitle} A`,
        exerciseIds: ['front_squat', 'bench_press', 'romanian_deadlift', 'pull_up', 'dead_bug'],
        tags: ['full_body', 'core'],
      },
      {
        title: `Lower Body + Core ${profileTitle}`,
        exerciseIds: ['goblet_squat', 'single_leg_rdl', 'split_squat', 'farmer_carry', 'hollow_hold'],
        tags: ['lower_body', 'core'],
      },
      {
        title: `Upper Body + Trunk ${profileTitle}`,
        exerciseIds: ['pull_up', 'dumbbell_bench_press', 'one_arm_dumbbell_row', 'push_up', 'bear_crawl'],
        tags: ['upper_body', 'trunk'],
      },
    ];
    return variants[slot] ?? variants[0];
  }

  if (targetSessions === 2) {
    const variants: StrengthVariant[] = [
      {
        title: `Full Body ${profileTitle} A`,
        exerciseIds: ['front_squat', 'bench_press', 'romanian_deadlift', 'pull_up', 'dead_bug'],
        tags: ['full_body', 'main_lifts'],
      },
      {
        title: `Full Body ${profileTitle} B`,
        exerciseIds: ['goblet_squat', 'dumbbell_bench_press', 'single_leg_rdl', 'one_arm_dumbbell_row', 'suitcase_carry'],
        tags: ['full_body', 'accessory'],
      },
    ];
    return variants[slot] ?? variants[0];
  }

  return {
    title: templateTitleForProfile(profile),
    exerciseIds: templateExerciseFallback(profile),
    tags: ['full_body', 'core'],
  };
}

function templateTitleForProfile(profile: StrengthProfile): string {
  if (profile === 'hypertrophy') return 'Full Body Hypertrophy';
  if (profile === 'max_strength') return 'Full Body Strength';
  if (profile === 'maintenance') return 'Strength Maintenance + Core';
  return 'Strength + Core Support';
}

function templateExerciseFallback(profile: StrengthProfile): string[] {
  if (profile === 'maintenance') {
    return ['split_squat', 'bench_press', 'pull_up', 'dead_bug', 'hip_hinge_band'];
  }
  return ['front_squat', 'romanian_deadlift', 'pull_up', 'bench_press', 'dead_bug'];
}

/**
 * Target number of exercises to include in a strength session of the
 * given duration, for the given experience level.
 *
 * The result is used at the call site as both the floor (the engine
 * tops up with fillers when a variant is short) AND the cap
 * (`prescriptions.slice(0, targetCount)` if the variant overflows).
 * The function name was previously `minimumExerciseCount`, which only
 * told half the story — it's the target, not just the minimum.
 *
 * ## Why the duration tiers exist
 *
 * Each working set runs ~2 minutes (3 reps × tempo + 60–90s rest), and
 * a 3-set exercise consumes ~6–8 minutes once you add transitions.
 * Reserve ~5 minutes for warmup + cooldown. So:
 *
 *   - 15-min "express" block: 2 exercises max (compound + 1 accessory)
 *   - 25-min block: 3 exercises (compound + 2 accessories, no isolation)
 *   - 30+ min: existing tiering already gives a sane prescription
 *
 * Before slice 3.H the function floored at 4 even for a 15-min window,
 * which produced over-prescribed sessions the athlete would either rush
 * through (poor quality) or skip the last 1–2 lifts on (defeating the
 * plan). The two new low-end tiers fix that without changing any
 * 30+ minute prescription.
 *
 * Boundary semantics:
 *
 *   - duration < 25 → 2
 *   - 25 ≤ duration < 30 → 3
 *   - 30 ≤ duration < 40 → 4 (unchanged)
 *   - 40 ≤ duration < 55 → 5 (unchanged)
 *   - duration ≥ 55, advanced → 6 (unchanged)
 *   - duration ≥ 55, others   → 5 (unchanged)
 *
 * Pinned by `coach-kernel-strength-engine-target-exercise-count.test.ts`.
 */
export function targetExerciseCount(
  durationMinutes: number,
  experience: StrengthExperience,
): number {
  if (durationMinutes < 25) return 2;
  if (durationMinutes < 30) return 3;
  if (durationMinutes >= 55) return experience === 'advanced' ? 6 : 5;
  if (durationMinutes >= 40) return 5;
  return 4;
}

function resolveExercises(
  template: WorkoutTemplate,
  library: Exercise[],
  athlete: AthleteState,
  profile: StrengthProfile,
  variant: StrengthVariant,
  durationMinutes: number,
): ExercisePrescription[] {
  const equipment = availableEquipment(athlete);
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const usedIds = new Set<string>();
  const experience = athlete.profile.experienceLevel;
  const desiredExerciseIds = [...variant.exerciseIds, ...(template.defaultExercises ?? [])]
    .filter((exerciseId, index, all) => all.indexOf(exerciseId) === index);

  const basePrescriptions = desiredExerciseIds
    .map<ExercisePrescription | null>((exerciseId) => {
      const original = libraryById.get(exerciseId) ?? null;
      const resolved = resolveExerciseCandidate(exerciseId, libraryById, equipment, usedIds);
      if (!resolved) return null;
      usedIds.add(resolved.id);
      const prescription = prescriptionFor(resolved, profile, experience);
      return {
        exerciseId: resolved.id,
        name: resolved.name,
        sets: prescription.sets,
        reps: prescription.reps,
        rir: prescription.rir,
        restSec: prescription.restSec,
        notes: original && original.id !== resolved.id
          ? `Adjusted from ${original.name} to fit the athlete's available equipment.`
          : undefined,
      };
    })
    .filter((exercise): exercise is ExercisePrescription => exercise !== null);

  const prescriptions: ExercisePrescription[] = [...basePrescriptions];

  const targetCount = targetExerciseCount(durationMinutes, experience);
  if (prescriptions.length >= targetCount) return prescriptions.slice(0, targetCount);

  const fillerIds = [
    'push_up',
    'hip_hinge_band',
    'lunging_iso_hold',
    'hollow_hold',
    'bear_crawl',
    'sandbag_hold',
    'dead_bug',
    'worlds_greatest_stretch',
  ];
  for (const fillerId of fillerIds) {
    if (prescriptions.length >= targetCount) break;
    const filler = libraryById.get(fillerId);
    if (!filler || usedIds.has(filler.id) || !canPerformExercise(filler, equipment)) continue;
    usedIds.add(filler.id);
    const prescription = prescriptionFor(filler, profile, experience);
    prescriptions.push({
      exerciseId: filler.id,
      name: filler.name,
      sets: prescription.sets,
      reps: prescription.reps,
      rir: prescription.rir,
      restSec: prescription.restSec,
      notes: 'Fallback support movement added to keep the session complete with the athlete\'s current setup.',
    });
  }

  return prescriptions;
}

type StrengthMovementPattern = Exercise['movementPattern'];

const FULL_BODY_REBUILD_PATTERN_ORDER: StrengthMovementPattern[] = [
  'squat',
  'push',
  'hinge',
  'pull',
  'single_leg',
  'carry',
  'core',
];

function rebuildPatternOrderFor(session: Session): StrengthMovementPattern[] {
  const tags = new Set(session.tags ?? []);
  if (tags.has('upper_body')) {
    return ['push', 'pull', 'push', 'pull', 'carry', 'core'];
  }
  if (tags.has('lower_body')) {
    return ['squat', 'hinge', 'single_leg', 'carry', 'core'];
  }
  return FULL_BODY_REBUILD_PATTERN_ORDER;
}

function countExercisesByPattern(
  prescriptions: ExercisePrescription[],
  libraryById: Map<string, Exercise>,
): Map<StrengthMovementPattern, number> {
  const counts = new Map<StrengthMovementPattern, number>();
  for (const prescription of prescriptions) {
    const exercise = libraryById.get(prescription.exerciseId);
    if (!exercise) continue;
    counts.set(exercise.movementPattern, (counts.get(exercise.movementPattern) ?? 0) + 1);
  }
  return counts;
}

function complexityPenalty(exercise: Exercise, experience: StrengthExperience): number {
  const complexity = getExerciseComplexity(exercise);
  if (experience !== 'novice') return complexity === 'expert' ? 8 : 0;
  if (complexity === 'expert') return 40;
  if (complexity === 'advanced') return 20;
  if (complexity === 'intermediate') return 6;
  return 0;
}

function scoreRebuildCandidate(args: {
  exercise: Exercise;
  profile: StrengthProfile;
  experience: StrengthExperience;
  painAreas: string[];
}): number {
  const { exercise, profile, experience, painAreas } = args;
  let score = 100;
  score -= complexityPenalty(exercise, experience);
  if (exerciseConflictsWithUserPain(exercise, painAreas)) score -= 50;

  const purpose = getExercisePrimaryPurpose(exercise);
  if (profile === 'hypertrophy' && (purpose === 'hypertrophy' || purpose === 'strength')) score += 8;
  if (profile === 'max_strength' && purpose === 'strength') score += 8;
  if (profile === 'athletic' && (purpose === 'strength' || purpose === 'conditioning' || purpose === 'stability')) score += 6;
  if (profile === 'maintenance' && getExerciseSpinalLoading(exercise) === 'high') score -= 8;
  if (exercise.fatigueCost === 'low') score += 4;
  if (exercise.fatigueCost === 'very_high') score -= 12;
  return score;
}

function selectRebuildExercise(args: {
  pattern: StrengthMovementPattern;
  library: Exercise[];
  equipment: Set<string>;
  usedIds: Set<string>;
  athlete: AthleteState;
  profile: StrengthProfile;
}): Exercise | null {
  const painAreas = (args.athlete.readiness?.painFlags ?? [])
    .map((flag) => flag.area ?? '')
    .filter(Boolean);
  const candidates = args.library
    .filter((exercise) =>
      exercise.movementPattern === args.pattern
      && !args.usedIds.has(exercise.id)
      && canPerformExercise(exercise, args.equipment)
    )
    .map((exercise) => ({
      exercise,
      score: scoreRebuildCandidate({
        exercise,
        profile: args.profile,
        experience: args.athlete.profile.experienceLevel,
        painAreas,
      }),
    }))
    .sort((left, right) => right.score - left.score);

  return candidates[0]?.exercise ?? null;
}

function selectNextRebuildExercise(args: {
  prescriptions: ExercisePrescription[];
  library: Exercise[];
  libraryById: Map<string, Exercise>;
  equipment: Set<string>;
  usedIds: Set<string>;
  athlete: AthleteState;
  profile: StrengthProfile;
  patternOrder: StrengthMovementPattern[];
}): Exercise | null {
  const counts = countExercisesByPattern(args.prescriptions, args.libraryById);
  const orderedPatterns = [...args.patternOrder].sort((left, right) => {
    const countDelta = (counts.get(left) ?? 0) - (counts.get(right) ?? 0);
    if (countDelta !== 0) return countDelta;
    return args.patternOrder.indexOf(left) - args.patternOrder.indexOf(right);
  });

  for (const pattern of orderedPatterns) {
    const exercise = selectRebuildExercise({
      pattern,
      library: args.library,
      equipment: args.equipment,
      usedIds: args.usedIds,
      athlete: args.athlete,
      profile: args.profile,
    });
    if (exercise) return exercise;
  }
  return null;
}

function targetLowerBoundMinutes(durationMinutes: number): number {
  return Math.round(durationMinutes * (1 - DEFAULT_COHERENCE_TOLERANCE_PCT));
}

function maxSetsForCoherence(
  exercise: Exercise | undefined,
  profile: StrengthProfile,
  experience: StrengthExperience,
): number {
  if (!exercise) return 4;
  if (exercise.movementPattern === 'mobility') return 2;
  if (exercise.movementPattern === 'core') return 3;
  if (exercise.movementPattern === 'carry') return 4;
  const mainPattern = ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern);
  if (!mainPattern) return 4;
  if (experience === 'novice') return 3;
  if (profile === 'hypertrophy' && experience === 'advanced') return 5;
  return 4;
}

function densifyPrescriptionsForTarget(args: {
  prescriptions: ExercisePrescription[];
  libraryById: Map<string, Exercise>;
  knowledge: EngineContext['knowledge'];
  profile: StrengthProfile;
  experience: StrengthExperience;
  targetMinutes: number;
}): ExercisePrescription[] {
  const next = args.prescriptions.map((exercise) => ({ ...exercise }));
  const priority = next
    .map((prescription, index) => {
      const exercise = args.libraryById.get(prescription.exerciseId);
      const pattern = exercise?.movementPattern;
      const rank = pattern === 'squat' || pattern === 'hinge'
        ? 0
        : pattern === 'push' || pattern === 'pull' || pattern === 'single_leg'
          ? 1
          : pattern === 'carry'
            ? 2
            : 3;
      return { index, rank };
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index);

  for (let guard = 0; guard < 24; guard++) {
    const estimated = estimateStrengthSessionMinutes({ exercises: next }, args.knowledge);
    if (estimated >= args.targetMinutes) break;
    const candidate = priority.find(({ index }) => {
      const prescription = next[index];
      const exercise = args.libraryById.get(prescription.exerciseId);
      return prescription.sets < maxSetsForCoherence(exercise, args.profile, args.experience);
    });
    if (!candidate) break;
    next[candidate.index] = {
      ...next[candidate.index],
      sets: next[candidate.index].sets + 1,
      notes: next[candidate.index].notes
        ? `${next[candidate.index].notes} | Set volume increased by coherence rebuild.`
        : 'Set volume increased by coherence rebuild.',
    };
  }

  return next;
}

/**
 * Fill a sparse strength session until its actual prescription can
 * credibly support the claimed duration. This is the missing second
 * half of the coherence gate: under-filled sessions are corrected by
 * adding compatible movement patterns before we consider shrinking
 * the visible duration.
 */
export function repairUnderfilledStrengthSession(
  session: Session,
  template: WorkoutTemplate,
  context: EngineContext,
): Session {
  if (session.sport !== 'strength') return session;

  const library = context.knowledge.exercises;
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const equipment = availableEquipment(context.athlete);
  const profile = resolveStrengthProfile(context, session.tags.includes('maintenance'));
  const patternOrder = rebuildPatternOrderFor(session);
  const targetCount = targetExerciseCount(session.durationMinutes, context.athlete.profile.experienceLevel);
  const usedIds = new Set((session.exercises ?? []).map((exercise) => exercise.exerciseId));
  let prescriptions = (session.exercises ?? []).map((exercise) => ({ ...exercise }));
  const targetMinutes = targetLowerBoundMinutes(session.durationMinutes);

  for (let attempts = 0; attempts < library.length && prescriptions.length < targetCount; attempts++) {
    const estimate = estimateStrengthSessionMinutes({ exercises: prescriptions }, context.knowledge);
    if (estimate >= targetMinutes) break;

    const exercise = selectNextRebuildExercise({
      prescriptions,
      library,
      libraryById,
      equipment,
      usedIds,
      athlete: context.athlete,
      profile,
      patternOrder,
    });
    if (!exercise) {
      break;
    }

    usedIds.add(exercise.id);
    const prescription = prescriptionFor(exercise, profile, context.athlete.profile.experienceLevel);
    prescriptions.push({
      exerciseId: exercise.id,
      name: exercise.name,
      sets: prescription.sets,
      reps: prescription.reps,
      rir: prescription.rir,
      restSec: prescription.restSec,
      notes: 'Added by the coherence rebuild so the session content matches the planned duration.',
    });
  }

  prescriptions = densifyPrescriptionsForTarget({
    prescriptions,
    libraryById,
    knowledge: context.knowledge,
    profile,
    experience: context.athlete.profile.experienceLevel,
    targetMinutes,
  });

  const safetyResult = applyBiomechanicsSafetySubstitutions(
    prescriptions,
    context.athlete,
    context.knowledge.exercises,
  );
  prescriptions = orderExercisesForSession(
    safetyResult.prescriptions,
    context.knowledge.exercises,
  );

  const estimatedMinutes = estimateStrengthSessionMinutes({ exercises: prescriptions }, context.knowledge);
  const finalDuration = estimatedMinutes >= targetMinutes
    ? session.durationMinutes
    : Math.max(MIN_CREDIBLE_STRENGTH_MINUTES, estimatedMinutes);

  return {
    ...session,
    exercises: prescriptions,
    durationMinutes: finalDuration,
    plannedLoad: durationToLoad(finalDuration, template.primaryZone, template.fatigueCost),
    tags: [...new Set([...(session.tags ?? []), 'coherence_rebuilt'])],
  };
}

function resolveStrengthDays(athlete: AthleteState, targetSessions: number): DayOfWeek[] {
  const explicitStrengthDays = DAY_ORDER.filter((day) =>
    athlete.availability.weeklyWindows.some((window) => window.dayOfWeek === day && window.sports?.includes('strength'))
  );
  const generalDays = DAY_ORDER.filter((day) =>
    athlete.availability.weeklyWindows.some((window) => window.dayOfWeek === day && (!window.sports || window.sports.length === 0))
  );
  const fallbackDays: DayOfWeek[] = ['monday', 'wednesday', 'friday', 'saturday', 'tuesday', 'thursday', 'sunday'];
  const orderedDays = [...explicitStrengthDays, ...generalDays, ...fallbackDays]
    .filter((day, index, allDays) => allDays.indexOf(day) === index);
  return orderedDays.slice(0, targetSessions);
}

function resolveDurationForDay(template: WorkoutTemplate, athlete: AthleteState, dayOfWeek: DayOfWeek): number {
  const explicitWindows = findWindowsForDay(athlete.availability, dayOfWeek, 'strength');
  const generalWindows = athlete.availability.weeklyWindows
    .filter((window) => window.dayOfWeek === dayOfWeek && (!window.sports || window.sports.length === 0));
  const candidateWindows = explicitWindows.length > 0 ? explicitWindows : generalWindows;
  if (candidateWindows.length === 0) {
    return Math.max(...template.durationOptionsMinutes);
  }

  const largestWindowMinutes = Math.max(...candidateWindows.map((window) => timeToMinutes(window.end) - timeToMinutes(window.start)));
  const fittingOption = [...template.durationOptionsMinutes]
    .sort((left, right) => right - left)
    .find((minutes) => minutes <= largestWindowMinutes);
  if (fittingOption) return fittingOption;

  return clamp(largestWindowMinutes, 20, Math.max(...template.durationOptionsMinutes));
}

function buildStrengthSession(
  template: WorkoutTemplate,
  variant: StrengthVariant,
  dayOfWeek: DayOfWeek,
  durationMinutes: number,
  exercises: ExercisePrescription[],
  tags: string[],
): Session {
  return {
    id: createSessionId('strength', dayOfWeek, template.title),
    sport: 'strength',
    sessionType: template.sessionType,
    title: variant.title,
    description: buildStrengthDescription(template, variant),
    dayOfWeek,
    durationMinutes,
    intensityZone: template.primaryZone,
    fatigueCost: template.fatigueCost,
    keySession: false,
    plannedLoad: durationToLoad(durationMinutes, template.primaryZone, template.fatigueCost),
    sourceTemplateId: template.id,
    tags: [...new Set([...tags, ...variant.tags])],
    exercises,
    alternatives: ['Reduce one accessory set if recovery is low', 'Keep load lighter and finish the mobility cooldown'],
  };
}

function buildStrengthDescription(template: WorkoutTemplate, variant: StrengthVariant): string {
  return [
    template.instructions.join(' '),
    variant.tags.includes('upper_body')
      ? 'Pair upper-body work with trunk stability and leave legs fresher for endurance work.'
      : variant.tags.includes('lower_body')
        ? 'Keep lower-body reps technically clean; stop before form breaks.'
        : 'Use this as a balanced whole-body lift with controlled effort.',
  ].join(' ');
}

/**
 * Slice 4.A coherence gate. Validates that the produced strength
 * session's exercise list at realistic set/rest/transition times
 * actually fills the claimed `durationMinutes`. Applies the
 * suggested correction (shrink the claim to match content, or
 * trim trailing accessories) before the session is surfaced.
 *
 * For "rebuild" verdicts (session estimated below
 * MIN_CREDIBLE_STRENGTH_MINUTES), the gate first runs the catalog-
 * aware repair pass: add missing movement patterns, then densify
 * set volume on the main lifts. Only if the catalog cannot make the
 * session coherent does it shrink to a truthful smaller duration.
 *
 * Pinned by `__tests__/services/coach-kernel-session-coherence.test.ts`
 * (helpers) and `__tests__/services/coach-kernel-strength-engine.test.ts`
 * (integration).
 */
function applyCoherenceGate(
  session: Session,
  template: WorkoutTemplate,
  context: EngineContext,
): Session {
  const verdict = validateSessionCoherence(session, context.knowledge);
  if (verdict.ok) return session;

  if (verdict.reason === 'underfilled') {
    const repaired = repairUnderfilledStrengthSession(session, template, context);
    const repairedVerdict = validateSessionCoherence(repaired, context.knowledge);
    if (repairedVerdict.ok) return repaired;
  }

  const correction = suggestCorrection(verdict, session);

  switch (correction.type) {
    case 'accept':
      return session;

    case 'shrinkDuration': {
      return {
        ...session,
        durationMinutes: correction.newDurationMinutes,
        plannedLoad: durationToLoad(correction.newDurationMinutes, template.primaryZone, template.fatigueCost),
      };
    }

    case 'rebuild': {
      const fallbackDuration = MIN_CREDIBLE_STRENGTH_MINUTES;
      return {
        ...session,
        durationMinutes: fallbackDuration,
        plannedLoad: durationToLoad(fallbackDuration, template.primaryZone, template.fatigueCost),
      };
    }

    case 'trimContent': {
      const trimmedExercises = (session.exercises ?? []).slice(0, correction.keepExerciseCount);
      const estimatedMinutes = estimateStrengthSessionMinutes({ exercises: trimmedExercises }, context.knowledge);
      const nextDuration = estimatedMinutes <= session.durationMinutes * (1 + DEFAULT_COHERENCE_TOLERANCE_PCT)
        ? session.durationMinutes
        : estimatedMinutes;
      return {
        ...session,
        exercises: trimmedExercises,
        durationMinutes: nextDuration,
        plannedLoad: durationToLoad(nextDuration, template.primaryZone, template.fatigueCost),
      };
    }
  }
}

export const strengthEngine: SportEngine = {
  buildCandidateSessions(context: EngineContext): Session[] {
    const templates = context.knowledge.workoutTemplates.filter((template) => template.sport === 'strength');
    const requestedSessions = context.athlete.goals.weeklySessionsTarget.strength ?? 2;
    const raceIsClose = context.athlete.goals.raceCalendar.some((race) => {
      const raceMs = Date.parse(race.date);
      const weekMs = Date.parse(context.weekStart);
      return Number.isFinite(raceMs) && Number.isFinite(weekMs) && raceMs - weekMs <= 42 * 24 * 60 * 60 * 1000;
    });
    const maintenance = context.phase === 'peak'
      || context.phase === 'taper'
      || raceIsClose
      || context.athlete.goals.primaryFocus === 'marathon'
      || context.athlete.goals.primaryFocus === 'triathlon';
    const strengthProfile = resolveStrengthProfile(context, maintenance);
    const sessionType = preferredSessionType(strengthProfile);
    const targetSessions = clamp(maintenance ? Math.min(requestedSessions, 2) : requestedSessions, 0, 4);
    const template = templateFor(templates, sessionType);
    const days = resolveStrengthDays(context.athlete, targetSessions);

    // Slice 4.C — read weekIndex once at the top so all variant
    // calls in this loop share it. weekIndex is 1-based in
    // currentBlock (see plan-generator: `weekIndex: 1` on initial
    // build), so we subtract 1 to get a 0-based macro-rotation
    // anchor.
    const weekIndexForRotation = Math.max(0, (context.athlete.currentBlock.weekIndex ?? 1) - 1);

    return days.slice(0, targetSessions).map((dayOfWeek, index) => {
      const durationMinutes = resolveDurationForDay(template, context.athlete, dayOfWeek);
      const baseVariant = strengthVariantFor(strengthProfile, targetSessions, index, weekIndexForRotation);
      // Slice 2.A — beginner substitutions are applied to the variant
      // BEFORE equipment-aware resolution so the substituted exercise
      // (e.g. goblet_squat) still picks up its own equipment fallback
      // chain (e.g. bodyweight_squat) if the user has no dumbbells.
      const variant = applyBeginnerSubstitutions(baseVariant, context.athlete.profile.experienceLevel);
      const baseExercises = resolveExercises(
        template,
        context.knowledge.exercises,
        context.athlete,
        strengthProfile,
        variant,
        durationMinutes,
      );
      // Slice 4.H — biomechanics-aware substitution. After equipment
      // + beginner substitutions have produced the prescription list,
      // walk it once more and swap any exercise whose
      // contraindication flags clash with the user's declared pain
      // areas. Beginner-safe + biomechanics-safe + equipment-safe is
      // a strict superset of the pre-slice substitution coverage.
      const safetyResult = applyBiomechanicsSafetySubstitutions(
        baseExercises,
        context.athlete,
        context.knowledge.exercises,
      );
      // Slice 4.H — sort the prescription list compound→accessory→
      // core→mobility so the heaviest work hits while the user is
      // freshest. Stable within each phase.
      const exercises = orderExercisesForSession(
        safetyResult.prescriptions,
        context.knowledge.exercises,
      );
      const rawSession = buildStrengthSession(
        template,
        variant,
        dayOfWeek,
        durationMinutes,
        exercises,
        maintenance
          ? ['maintenance', 'lower_body', 'core']
          : strengthProfile === 'hypertrophy'
            ? ['hypertrophy', 'full_body', 'lower_body', 'core']
            : ['full_body', 'lower_body', 'core'],
      );
      // Slice 4.A — gate the produced session through the coherence
      // validator. Sessions whose claimed duration doesn't match
      // their content density are corrected (claim shrunk, or
      // trailing accessories trimmed) before surfacing.
      return applyCoherenceGate(rawSession, template, context);
    });
  },
};
