// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type {
  AthleteState,
  DayOfWeek,
  Exercise,
  ExercisePrescription,
  ExerciseSelectionReason,
  Session,
  SessionType,
  StrengthExerciseCompletionSignal,
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
import { selectStrengthExercisesFromCatalog, type StrengthSelectorTrace } from '../strength-selector';
import { attachTrainingSessionRole } from '../endurance-session-classifier';
import {
  decideStrengthProgression,
  type ProgressionDecision,
  type StrengthProgressionSessionSignal,
} from '../strength-progression';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { recordTrainingProgressionState } from '../../training-generation-observability';

// 'hybrid' added 2026-05-23 (Layer-3 goal→split mapping audit closeout):
// dedicated profile for concurrent endurance + strength athletes. Mapped
// from `Goals.strengthGoal === 'hybrid'` via `resolveStrengthProfile`; routed
// to Full×N posterior-chain + single-leg variants that respect endurance
// volume and protect key cardio sessions.
type StrengthProfile = 'maintenance' | 'hypertrophy' | 'max_strength' | 'athletic' | 'hybrid';
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
    case 'hybrid':
      return 'hybrid';
    default:
      return 'athletic';
  }
}

function preferredSessionType(profile: StrengthProfile): SessionType {
  if (profile === 'maintenance') return 'strength_maintenance';
  if (profile === 'hypertrophy') return 'strength_hypertrophy';
  // 'hybrid' routes to `strength_max` so we don't have to extend the
  // SessionType union — the actual variant catalog encodes the hybrid
  // character (Full×N + posterior chain + single-leg). If telemetry ever
  // needs to distinguish hybrid sessions from max-strength sessions,
  // adding `'strength_hybrid'` to the SessionType union is a follow-up.
  return 'strength_max';
}

function availableEquipment(athlete: AthleteState): Set<string> {
  const equipment = new Set<string>();
  const hasFullGymCapabilities = athlete.equipment.hasGym
    && athlete.equipment.hasBarbell
    && athlete.equipment.hasDumbbells;
  if (athlete.equipment.hasGym) {
    equipment.add('bench');
    equipment.add('pullup_bar');
    if (hasFullGymCapabilities) {
      equipment.add('lat_pulldown');
      equipment.add('leg_press');
      equipment.add('cable_stack');
      equipment.add('chest_press_machine');
    }
  }
  if (athlete.equipment.hasBarbell) {
    equipment.add('barbell');
    equipment.add('rack');
  }
  if (athlete.equipment.hasDumbbells) {
    equipment.add('dumbbells');
    equipment.add('kettlebells');
  }
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
  const purpose = getExercisePrimaryPurpose(exercise);

  if (purpose === 'power') {
    return {
      sets: experience === 'advanced' ? 5 : 4,
      reps: '3-6',
      rir: 3,
      restSec: 105,
    };
  }

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
      const sets = supportPattern ? 3 : experience === 'novice' ? 3 : experience === 'advanced' && mainPattern ? 5 : mainPattern ? 4 : 3;
      return {
        sets,
        reps: supportPattern ? '10-15' : accessoryPattern ? '10-15' : experience === 'novice' ? '8-12' : '6-12',
        rir: experience === 'novice' ? 2 : 1,
        restSec: mainPattern ? 105 : 60,
      };
    }
    case 'max_strength': {
      const sets = mainPattern ? (experience === 'novice' ? 3 : experience === 'advanced' ? 5 : 4) : 3;
      return {
        sets,
        reps: mainPattern ? (experience === 'novice' ? '5-6' : '3-5') : '6-10',
        rir: experience === 'novice' ? 3 : 2,
        restSec: mainPattern ? 150 : 75,
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

function compactPrescriptionForWindow(
  prescription: Omit<ExercisePrescription, 'exerciseId' | 'name' | 'notes'>,
  exercise: Exercise,
  durationMinutes: number,
): Omit<ExercisePrescription, 'exerciseId' | 'name' | 'notes'> {
  if (durationMinutes >= 30) return prescription;

  const mainPattern = ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern);
  return {
    ...prescription,
    sets: Math.min(prescription.sets, 2),
    restSec: Math.min(prescription.restSec ?? (mainPattern ? 60 : 45), mainPattern ? 60 : 45),
  };
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
  leg_press: 'bodyweight_squat',
  machine_chest_press: 'dumbbell_floor_press',
  incline_dumbbell_press: 'dumbbell_floor_press',
  seated_cable_row: 'band_row',
  cable_pull_through: 'glute_bridge',
  dumbbell_overhead_press: 'push_up',
  dumbbell_reverse_lunge: 'lunging_iso_hold',
  kettlebell_swing: 'hip_hinge_band',
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
 * The fix shifts the slot by `weekIndex` modulo the **variant pool
 * size** (not `targetSessions`). For 4-session weeks with a 6-variant
 * pool (the size used by hypertrophy / max_strength / athletic / hybrid):
 *   week 0 → slots [0, 1, 2, 3]
 *   week 1 → slots [1, 2, 3, 4]    (variant 4 reachable)
 *   week 2 → slots [2, 3, 4, 5]    (variant 5 reachable)
 *   week 3 → slots [3, 4, 5, 0]
 *   week 4 → slots [4, 5, 0, 1]
 *   week 5 → slots [5, 0, 1, 2]
 *   week 6 → back to week-0 ordering
 *
 * This gives a 6-week macro-rotation when the pool has 6 variants
 * (extending the previous 4-week cycle), and any specific (slot,
 * week-mod-poolSize) pair produces a distinct variant. Pre-2026-05-23
 * the modulo was `targetSessions` rather than `variants.length`, so
 * the 5th and 6th variants in the existing 4-session pools were
 * unreachable at runtime — codex flagged this during the Layer-3
 * goal→split closeout review. Fixing it here also makes the new
 * hybrid pool's full Full×4 + 2 macro-rotation claim true.
 *
 * Weekly variety preserved (slice 4.B primary-pattern alternation)
 * and multi-week variety extended without tracking history in
 * AthleteState — pure deterministic rotation indexed on the
 * planner's existing `currentBlock.weekIndex`.
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
        : profile === 'hybrid'
          ? 'Hybrid'
          : 'Strength';
  // The slot is computed per-branch using `variants.length` rather than
  // `targetSessions` so every variant in each pool is reachable across
  // the macro-rotation. See the doc comment above for the new cycle.
  const safeWeekShift = Math.max(0, Math.trunc(weekIndex));
  const pickSlot = (poolSize: number): number =>
    (Math.max(0, index) + safeWeekShift) % Math.max(1, poolSize);

  if (targetSessions >= 4) {
    const variants: StrengthVariant[] = profile === 'hypertrophy'
      ? [
          {
            title: 'Lower Hypertrophy - Quad Bias',
            exerciseIds: ['front_squat', 'dumbbell_reverse_lunge', 'leg_press', 'calf_raise', 'pallof_press'],
            tags: ['lower_body', 'quad_bias', 'hypertrophy', 'core'],
          },
          {
            title: 'Upper Hypertrophy - Push/Pull',
            exerciseIds: ['incline_dumbbell_press', 'seated_cable_row', 'dumbbell_overhead_press', 'lat_pulldown', 'plank'],
            tags: ['upper_body', 'push', 'pull', 'hypertrophy'],
          },
          {
            title: 'Lower Hypertrophy - Posterior Chain',
            exerciseIds: ['romanian_deadlift', 'dumbbell_hip_thrust', 'single_leg_rdl', 'cable_pull_through', 'dead_bug'],
            tags: ['lower_body', 'posterior_chain', 'hypertrophy', 'carry'],
          },
          {
            title: 'Upper Hypertrophy - Pull/Trunk',
            exerciseIds: ['pull_up', 'machine_chest_press', 'seated_cable_row', 'suitcase_carry', 'side_plank'],
            tags: ['upper_body', 'pull', 'trunk', 'hypertrophy'],
          },
          {
            title: 'Upper Hypertrophy - Delts/Arms',
            exerciseIds: ['dumbbell_overhead_press', 'lat_pulldown', 'machine_chest_press', 'suitcase_carry', 'pallof_press'],
            tags: ['upper_body', 'delts', 'arms', 'hypertrophy', 'trunk'],
          },
          {
            title: 'Lower Hypertrophy - Glutes/Calves',
            exerciseIds: ['dumbbell_hip_thrust', 'single_leg_rdl', 'dumbbell_reverse_lunge', 'calf_raise', 'dead_bug'],
            tags: ['lower_body', 'glutes', 'calves', 'hypertrophy', 'core'],
          },
        ]
      : profile === 'max_strength'
        ? [
            {
              title: 'Lower Max Strength - Squat/Hinge',
              exerciseIds: ['front_squat', 'romanian_deadlift', 'split_squat', 'dead_bug', 'farmer_carry'],
              tags: ['lower_body', 'max_strength', 'posterior_chain', 'core'],
            },
            {
              title: 'Upper Max Strength - Press/Pull',
              exerciseIds: ['bench_press', 'pull_up', 'dumbbell_overhead_press', 'one_arm_dumbbell_row', 'side_plank'],
              tags: ['upper_body', 'max_strength', 'push', 'pull'],
            },
            {
              title: 'Lower Strength Support - Unilateral',
              exerciseIds: ['goblet_squat', 'single_leg_rdl', 'dumbbell_reverse_lunge', 'glute_bridge', 'bear_crawl'],
              tags: ['lower_body', 'single_leg', 'support', 'core'],
            },
            {
              title: 'Upper Strength Support - Volume',
              exerciseIds: ['lat_pulldown', 'dumbbell_bench_press', 'inverted_row', 'suitcase_carry', 'hollow_hold'],
              tags: ['upper_body', 'support', 'pull', 'carry'],
            },
            {
              title: 'Strength Technique - Speed/Trunk',
              exerciseIds: ['front_squat', 'bench_press', 'kettlebell_swing', 'pallof_press', 'farmer_carry'],
              tags: ['full_body', 'technique', 'speed', 'trunk'],
            },
            {
              title: 'Strength Support - Posterior/Carry',
              exerciseIds: ['romanian_deadlift', 'single_leg_rdl', 'lat_pulldown', 'suitcase_carry', 'side_plank'],
              tags: ['posterior_chain', 'support', 'carry', 'core'],
            },
          ]
        : profile === 'hybrid'
          // Hybrid 4-session: Full×4 + 2 macro-rotation variants. Added
          // 2026-05-23 as the Layer-3 goal→split mapping audit closeout.
          // Each session touches the primary patterns (squat/hinge/push/
          // pull/trunk) but biases the focus so two adjacent strength
          // sessions don't double-stress the same system the endurance
          // volume already loads.
          ? [
              {
                title: 'Full Body Hybrid - Durability',
                exerciseIds: ['single_leg_rdl', 'goblet_squat', 'one_arm_dumbbell_row', 'farmer_carry', 'dead_bug'],
                tags: ['full_body', 'durability', 'single_leg', 'posterior_chain', 'hybrid'],
              },
              {
                title: 'Full Body Hybrid - Pulling Emphasis',
                exerciseIds: ['romanian_deadlift', 'pull_up', 'one_arm_dumbbell_row', 'pallof_press', 'suitcase_carry'],
                tags: ['full_body', 'pulling', 'posterior_chain', 'trunk', 'hybrid'],
              },
              {
                title: 'Full Body Hybrid - Single-Leg Power',
                exerciseIds: ['split_squat', 'dumbbell_reverse_lunge', 'kettlebell_swing', 'one_arm_dumbbell_row', 'side_plank'],
                tags: ['full_body', 'single_leg', 'power', 'hybrid'],
              },
              {
                title: 'Full Body Hybrid - Posterior Chain',
                exerciseIds: ['romanian_deadlift', 'dumbbell_hip_thrust', 'goblet_squat', 'inverted_row', 'plank'],
                tags: ['full_body', 'posterior_chain', 'hinge', 'hybrid'],
              },
              {
                title: 'Full Body Hybrid - Athletic Trunk',
                exerciseIds: ['kettlebell_swing', 'goblet_squat', 'pallof_press', 'farmer_carry', 'side_plank'],
                tags: ['full_body', 'power', 'trunk', 'carry', 'hybrid'],
              },
              {
                title: 'Full Body Hybrid - Recovery Volume',
                exerciseIds: ['goblet_squat', 'dumbbell_floor_press', 'band_row', 'glute_bridge', 'dead_bug'],
                tags: ['full_body', 'recovery', 'low_fatigue', 'hybrid'],
              },
            ]
          : [
            {
              title: `Lower Body ${profileTitle} A`,
              exerciseIds: ['front_squat', 'romanian_deadlift', 'split_squat', 'dead_bug', 'farmer_carry'],
              tags: ['lower_body', 'posterior_chain', 'core'],
            },
            {
              title: `Upper Body ${profileTitle} A`,
              exerciseIds: ['bench_press', 'pull_up', 'dumbbell_overhead_press', 'one_arm_dumbbell_row', 'hollow_hold'],
              tags: ['upper_body', 'push', 'pull'],
            },
            {
              title: `Lower Body ${profileTitle} B`,
              exerciseIds: ['kettlebell_swing', 'goblet_squat', 'single_leg_rdl', 'lunging_iso_hold', 'bear_crawl'],
              tags: ['lower_body', 'power', 'single_leg', 'core'],
            },
            {
              title: `Upper Body ${profileTitle} B`,
              exerciseIds: ['lat_pulldown', 'dumbbell_bench_press', 'inverted_row', 'suitcase_carry', 'side_plank'],
              tags: ['upper_body', 'pull', 'carry'],
            },
            {
              title: `Athletic Strength ${profileTitle} - Power/Carry`,
              exerciseIds: ['kettlebell_swing', 'front_squat', 'pull_up', 'farmer_carry', 'pallof_press'],
              tags: ['full_body', 'power', 'carry', 'trunk'],
            },
            {
              title: `Durability Strength ${profileTitle} - Hips/Core`,
              exerciseIds: ['single_leg_rdl', 'dumbbell_reverse_lunge', 'glute_bridge', 'calf_raise', 'dead_bug'],
              tags: ['lower_body', 'durability', 'hips', 'core'],
            },
          ];
    return variants[pickSlot(variants.length)] ?? variants[0];
  }

  if (targetSessions === 3) {
    // Profile-specific 3-session variants added 2026-05-23 (Layer-3 goal→
    // split mapping audit closeout). Prior to this slice the 3-session
    // branch shared exerciseIds across profiles and only changed the title;
    // each profile now has its own exercise selection matching the audit's
    // (goal, days/week) → split shape requirement.
    const variants: StrengthVariant[] = profile === 'hypertrophy'
      ? [
          {
            title: 'Lower Hypertrophy - Volume',
            exerciseIds: ['front_squat', 'dumbbell_hip_thrust', 'dumbbell_reverse_lunge', 'leg_press', 'calf_raise'],
            tags: ['lower_body', 'hypertrophy', 'volume'],
          },
          {
            title: 'Upper Hypertrophy - Volume',
            exerciseIds: ['incline_dumbbell_press', 'lat_pulldown', 'seated_cable_row', 'dumbbell_overhead_press', 'pallof_press'],
            tags: ['upper_body', 'hypertrophy', 'volume'],
          },
          {
            title: 'Full Body Hypertrophy - Pump',
            exerciseIds: ['goblet_squat', 'dumbbell_bench_press', 'one_arm_dumbbell_row', 'glute_bridge', 'plank'],
            tags: ['full_body', 'hypertrophy', 'pump'],
          },
        ]
      : profile === 'max_strength'
        ? [
            {
              title: 'Lower Max Strength - Compound',
              exerciseIds: ['front_squat', 'romanian_deadlift', 'split_squat', 'farmer_carry', 'dead_bug'],
              tags: ['lower_body', 'max_strength', 'compound'],
            },
            {
              title: 'Upper Max Strength - Compound',
              exerciseIds: ['bench_press', 'pull_up', 'dumbbell_overhead_press', 'one_arm_dumbbell_row', 'side_plank'],
              tags: ['upper_body', 'max_strength', 'compound'],
            },
            {
              title: 'Full Body Strength - Technique',
              exerciseIds: ['front_squat', 'bench_press', 'pull_up', 'kettlebell_swing', 'pallof_press'],
              tags: ['full_body', 'max_strength', 'technique'],
            },
          ]
        : profile === 'maintenance'
          ? [
              {
                title: 'Full Body Maintenance - Compound',
                exerciseIds: ['goblet_squat', 'dumbbell_floor_press', 'band_row', 'pallof_press', 'hip_hinge_band'],
                tags: ['full_body', 'maintenance', 'compound'],
              },
              {
                title: 'Lower Maintenance + Mobility',
                exerciseIds: ['bodyweight_squat', 'single_leg_rdl', 'glute_bridge', 'calf_raise', 'dead_bug'],
                tags: ['lower_body', 'maintenance', 'mobility'],
              },
              {
                title: 'Upper Maintenance + Carry',
                exerciseIds: ['band_row', 'push_up', 'dumbbell_overhead_press', 'suitcase_carry', 'side_plank'],
                tags: ['upper_body', 'maintenance', 'carry'],
              },
            ]
          : profile === 'hybrid'
            ? [
                {
                  title: 'Full Body Hybrid - Posterior Chain',
                  exerciseIds: ['romanian_deadlift', 'goblet_squat', 'one_arm_dumbbell_row', 'farmer_carry', 'side_plank'],
                  tags: ['full_body', 'hybrid', 'posterior_chain', 'carry'],
                },
                {
                  title: 'Full Body Hybrid - Single-Leg Focus',
                  exerciseIds: ['split_squat', 'single_leg_rdl', 'dumbbell_reverse_lunge', 'inverted_row', 'pallof_press'],
                  tags: ['full_body', 'hybrid', 'single_leg', 'trunk'],
                },
                {
                  title: 'Full Body Hybrid - Power/Carry',
                  exerciseIds: ['kettlebell_swing', 'goblet_squat', 'pull_up', 'suitcase_carry', 'dead_bug'],
                  tags: ['full_body', 'hybrid', 'power', 'carry'],
                },
              ]
            : [
                // Athletic (default) 3-session: existing variants preserved
                // for the historical default path.
                {
                  title: `Full Body ${profileTitle} - Squat/Press`,
                  exerciseIds: ['front_squat', 'dumbbell_bench_press', 'romanian_deadlift', 'pull_up', 'side_plank'],
                  tags: ['full_body', 'squat', 'push', 'core'],
                },
                {
                  title: `Lower + Posterior Chain ${profileTitle}`,
                  exerciseIds: ['goblet_squat', 'single_leg_rdl', 'dumbbell_reverse_lunge', 'farmer_carry', 'pallof_press'],
                  tags: ['lower_body', 'posterior_chain', 'single_leg', 'core'],
                },
                {
                  title: `Upper + Athletic Trunk ${profileTitle}`,
                  exerciseIds: ['pull_up', 'dumbbell_overhead_press', 'one_arm_dumbbell_row', 'push_up', 'plank'],
                  tags: ['upper_body', 'trunk', 'push', 'pull'],
                },
              ];
    return variants[pickSlot(variants.length)] ?? variants[0];
  }

  if (targetSessions === 2) {
    // Profile-specific 2-session variants added 2026-05-23 (Layer-3 goal→
    // split mapping audit closeout). Prior to this slice the 2-session
    // branch shared exerciseIds across profiles.
    const variants: StrengthVariant[] = profile === 'hypertrophy'
      ? [
          {
            title: 'Full Body Hypertrophy - Lower Bias',
            exerciseIds: ['front_squat', 'dumbbell_hip_thrust', 'dumbbell_bench_press', 'lat_pulldown', 'plank'],
            tags: ['full_body', 'hypertrophy', 'lower_bias'],
          },
          {
            title: 'Full Body Hypertrophy - Upper Bias',
            exerciseIds: ['incline_dumbbell_press', 'seated_cable_row', 'goblet_squat', 'single_leg_rdl', 'pallof_press'],
            tags: ['full_body', 'hypertrophy', 'upper_bias'],
          },
        ]
      : profile === 'max_strength'
        ? [
            {
              title: 'Full Body Strength - Squat/Bench',
              exerciseIds: ['front_squat', 'bench_press', 'pull_up', 'farmer_carry', 'dead_bug'],
              tags: ['full_body', 'max_strength', 'compound'],
            },
            {
              title: 'Full Body Strength - Hinge/Press',
              exerciseIds: ['romanian_deadlift', 'dumbbell_overhead_press', 'one_arm_dumbbell_row', 'split_squat', 'side_plank'],
              tags: ['full_body', 'max_strength', 'hinge'],
            },
          ]
        : profile === 'maintenance'
          ? [
              {
                title: 'Full Body Maintenance - Main Lifts',
                exerciseIds: ['goblet_squat', 'dumbbell_floor_press', 'band_row', 'pallof_press', 'hip_hinge_band'],
                tags: ['full_body', 'maintenance', 'main_lifts'],
              },
              {
                title: 'Full Body Maintenance - Mobility + Carry',
                exerciseIds: ['bodyweight_squat', 'push_up', 'single_leg_rdl', 'suitcase_carry', 'dead_bug'],
                tags: ['full_body', 'maintenance', 'mobility', 'carry'],
              },
            ]
          : profile === 'hybrid'
            ? [
                {
                  title: 'Full Body Hybrid - Compound Base',
                  exerciseIds: ['goblet_squat', 'romanian_deadlift', 'one_arm_dumbbell_row', 'dumbbell_bench_press', 'farmer_carry'],
                  tags: ['full_body', 'hybrid', 'compound'],
                },
                {
                  title: 'Full Body Hybrid - Durability + Carry',
                  exerciseIds: ['single_leg_rdl', 'split_squat', 'inverted_row', 'suitcase_carry', 'dead_bug'],
                  tags: ['full_body', 'hybrid', 'durability', 'single_leg'],
                },
              ]
            : [
                // Athletic (default) 2-session: existing variants preserved.
                {
                  title: `Full Body ${profileTitle} - Main Lifts`,
                  exerciseIds: ['front_squat', 'dumbbell_bench_press', 'romanian_deadlift', 'pull_up', 'pallof_press'],
                  tags: ['full_body', 'main_lifts', 'squat', 'hinge'],
                },
                {
                  title: `Full Body ${profileTitle} - Unilateral Support`,
                  exerciseIds: ['goblet_squat', 'dumbbell_overhead_press', 'single_leg_rdl', 'band_row', 'suitcase_carry'],
                  tags: ['full_body', 'accessory', 'single_leg', 'trunk'],
                },
              ];
    return variants[pickSlot(variants.length)] ?? variants[0];
  }

  return {
    title: templateTitleForProfile(profile),
    exerciseIds: templateExerciseFallback(profile),
    tags: ['full_body', 'core'],
  };
}

function isLimitedStrengthSetup(athlete: AthleteState): boolean {
  const equipmentNotes = (athlete.equipment.notes ?? []).join(' ').toLowerCase();
  const constraintNotes = athlete.constraints.map((constraint) => constraint.description).join(' ').toLowerCase();
  return !athlete.equipment.hasGym
    || /hotel|travel|limited equipment|home/.test(`${equipmentNotes} ${constraintNotes}`);
}

function limitedEquipmentVariantFor(
  profile: StrengthProfile,
  targetSessions: number,
  index: number,
  weekIndex: number,
): StrengthVariant | null {
  const slot = (Math.max(0, index) + Math.max(0, weekIndex)) % Math.max(1, Math.min(targetSessions, 3));
  const label = profile === 'hypertrophy'
    ? 'Hypertrophy'
    : profile === 'max_strength'
      ? 'Strength'
      : profile === 'hybrid'
        ? 'Hybrid'
        : 'Strength';
  const variants: StrengthVariant[] = [
    {
      title: `Limited Equipment ${label} - Squat/Push`,
      exerciseIds: ['goblet_squat', 'dumbbell_bench_press', 'one_arm_dumbbell_row', 'glute_bridge', 'side_plank'],
      tags: ['limited_equipment', 'hotel_gym', 'full_body', 'squat', 'push'],
    },
    {
      title: `Limited Equipment ${label} - Hinge/Pull`,
      exerciseIds: ['single_leg_rdl', 'one_arm_dumbbell_row', 'split_squat', 'pallof_press', 'suitcase_carry'],
      tags: ['limited_equipment', 'hotel_gym', 'full_body', 'hinge', 'pull'],
    },
    {
      title: `Limited Equipment ${label} - Density`,
      exerciseIds: ['bodyweight_squat', 'push_up', 'lateral_lunge', 'band_row', 'plank'],
      tags: ['limited_equipment', 'hotel_gym', 'short_session', 'minimum_effective_dose'],
    },
  ];
  return variants[slot] ?? null;
}

function templateTitleForProfile(profile: StrengthProfile): string {
  if (profile === 'hypertrophy') return 'Full Body Hypertrophy';
  if (profile === 'max_strength') return 'Full Body Strength';
  if (profile === 'maintenance') return 'Strength Maintenance + Core';
  if (profile === 'hybrid') return 'Hybrid Full Body - Durability + Power';
  return 'Strength + Core Support';
}

function templateExerciseFallback(profile: StrengthProfile): string[] {
  if (profile === 'maintenance') {
    return ['bodyweight_squat', 'dumbbell_floor_press', 'band_row', 'pallof_press', 'hip_hinge_band'];
  }
  if (profile === 'hypertrophy') {
    return ['goblet_squat', 'dumbbell_floor_press', 'band_row', 'glute_bridge', 'side_plank'];
  }
  if (profile === 'hybrid') {
    // Hybrid fallback emphasizes posterior chain + single-leg + carry to
    // protect endurance volume and reduce spinal-loading risk before key
    // cardio sessions.
    return ['single_leg_rdl', 'goblet_squat', 'one_arm_dumbbell_row', 'farmer_carry', 'dead_bug'];
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
  selectionReasons?: Map<string, ExerciseSelectionReason>,
  selectorOptions: {
    allowTemplateDefaults?: boolean;
    allowHardcodedFillers?: boolean;
    selectorTrace?: StrengthSelectorTrace;
  } = {},
): ExercisePrescription[] {
  const equipment = availableEquipment(athlete);
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const usedIds = new Set<string>();
  const experience = athlete.profile.experienceLevel;
  const desiredExerciseIds = [
    ...variant.exerciseIds,
    ...(selectorOptions.allowTemplateDefaults === false ? [] : template.defaultExercises ?? []),
  ]
    .filter((exerciseId, index, all) => all.indexOf(exerciseId) === index);

  const basePrescriptions = desiredExerciseIds
    .map<ExercisePrescription | null>((exerciseId) => {
      const original = libraryById.get(exerciseId) ?? null;
      const resolved = resolveExerciseCandidate(exerciseId, libraryById, equipment, usedIds);
      if (!resolved) return null;
      usedIds.add(resolved.id);
      const prescription = compactPrescriptionForWindow(
        prescriptionFor(resolved, profile, experience),
        resolved,
        durationMinutes,
      );
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
        selectionReason: selectionReasons?.get(resolved.id),
        selectorTrace: selectorOptions.selectorTrace,
      };
    })
    .filter((exercise): exercise is ExercisePrescription => exercise !== null);

  const prescriptions: ExercisePrescription[] = [...basePrescriptions];

  const targetCount = targetExerciseCount(durationMinutes, experience);
  if (prescriptions.length >= targetCount) return prescriptions.slice(0, targetCount);
  if (selectorOptions.allowHardcodedFillers === false) return prescriptions;

  const fillerIds = [
    'bodyweight_squat',
    'pallof_press',
    'plank',
    'band_row',
    'leg_press',
    'seated_cable_row',
    'machine_chest_press',
    'cable_pull_through',
    'dumbbell_hip_thrust',
    'dumbbell_overhead_press',
    'glute_bridge',
    'dumbbell_floor_press',
    'push_up',
    'hip_hinge_band',
    'calf_raise',
    'lunging_iso_hold',
    'side_plank',
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
    const prescription = compactPrescriptionForWindow(
      prescriptionFor(filler, profile, experience),
      filler,
      durationMinutes,
    );
    prescriptions.push({
      exerciseId: filler.id,
      name: filler.name,
      sets: prescription.sets,
      reps: prescription.reps,
      rir: prescription.rir,
      restSec: prescription.restSec,
      notes: 'Fallback support movement added to keep the session complete with the athlete\'s current setup.',
      selectionReason: selectionReasons?.get(filler.id),
      selectorTrace: selectorOptions.selectorTrace,
    });
  }

  return prescriptions;
}

function normalizeExerciseKey(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function repsUpperBound(reps: string): number {
  const matches = reps.match(/\d+/g);
  if (!matches || matches.length === 0) return 8;
  return Math.max(...matches.map(Number));
}

function allStrengthSignals(athlete: AthleteState): StrengthExerciseCompletionSignal[] {
  return (athlete.recentSessions ?? [])
    .flatMap((session) => session.strengthExerciseSignals ?? [])
    .filter((signal) => typeof signal.completedAt === 'string')
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}

function matchingSignalsForPrescription(
  prescription: ExercisePrescription,
  signals: StrengthExerciseCompletionSignal[],
): StrengthExerciseCompletionSignal[] {
  const exerciseId = normalizeExerciseKey(prescription.exerciseId);
  const exerciseName = normalizeExerciseKey(prescription.name);
  return signals.filter((signal) => {
    const signalId = normalizeExerciseKey(signal.exerciseId);
    const signalName = normalizeExerciseKey(signal.exerciseName);
    return (!!exerciseId && signalId === exerciseId)
      || (!!exerciseName && signalName === exerciseName);
  });
}

function progressionSignalToGateSignal(
  signal: StrengthExerciseCompletionSignal | undefined,
  fallbackPrescribedReps: number,
): StrengthProgressionSessionSignal | undefined {
  if (!signal) return undefined;
  return {
    completedRepsTopSet: signal.completedRepsTopSet,
    prescribedRepsTopSet: signal.prescribedRepsTopSet || fallbackPrescribedReps,
    rpeTopSet: signal.rpeTopSet,
    rir: signal.rir,
    sorenessLevel: signal.sorenessLevel,
    technicalSuccessScore: signal.technicalSuccessScore,
  };
}

function progressionStateFromDecision(
  athlete: AthleteState,
  decision: ProgressionDecision,
): NonNullable<ExercisePrescription['progressionState']> {
  if (athlete.feedbackAnalysis?.progressionState === 'deload') return 'deload';
  if (athlete.feedbackAnalysis?.progressionState === 'reentry') return 'reentry';
  if (decision.vector === 'consistency_preservation') return 'hold';
  return 'build';
}

function applyDecisionToPrescription(
  prescription: ExercisePrescription,
  decision: ProgressionDecision,
  state: NonNullable<ExercisePrescription['progressionState']>,
): ExercisePrescription {
  recordTrainingProgressionState(state);
  const rationale = decision.rationale[0] ?? 'Progression was kept conservative from recent completion feedback.';
  const summary = (() => {
    if (state === 'deload') return 'Deload: reduced progression pressure this week.';
    if (state === 'reentry') return 'Re-entry: hold the prescription while consistency rebuilds.';
    if (decision.vector === 'load_progression') return 'Build: increase load about 2.5% if warm-up confirms readiness.';
    if (decision.vector === 'volume_then_load') return 'Build: add one clean rep before increasing load.';
    if (decision.vector === 'intent_then_load') return 'Build: use tempo intent before adding load.';
    return 'Hold: keep this prescription steady this week.';
  })();
  const next: ExercisePrescription = {
    ...prescription,
    progressionState: state,
    progressionSummary: summary,
    progressionReason: rationale,
    progressionConfidence: 'real_feedback',
  };
  if (decision.vector === 'intent_then_load' && !next.tempo) {
    next.tempo = '3-1-1-0';
  }
  if (decision.vector === 'volume_then_load' && decision.repsDelta) {
    next.notes = next.notes
      ? `${next.notes} Progression: add one clean top-set rep if form stays solid.`
      : 'Progression: add one clean top-set rep if form stays solid.';
  } else if (decision.vector === 'load_progression' && decision.loadDeltaPct) {
    next.notes = next.notes
      ? `${next.notes} Progression: add ~${Math.round(decision.loadDeltaPct * 1000) / 10}% load only if warm-up sets move well.`
      : `Progression: add ~${Math.round(decision.loadDeltaPct * 1000) / 10}% load only if warm-up sets move well.`;
  } else if (decision.vector === 'consistency_preservation') {
    next.notes = next.notes
      ? `${next.notes} Progression held: ${rationale}`
      : `Progression held: ${rationale}`;
  }
  return next;
}

function applyStrengthProgressionPolicy(
  prescriptions: ExercisePrescription[],
  template: WorkoutTemplate,
  athlete: AthleteState,
): ExercisePrescription[] {
  if (!config.coaching.trainingCompletionFeedbackV2Enabled) return prescriptions;

  const signals = allStrengthSignals(athlete);
  if (signals.length === 0) {
    return prescriptions.map((prescription) => {
      recordTrainingProgressionState('hold');
      return {
        ...prescription,
        progressionState: 'hold',
        progressionSummary: 'Cold start: keep the prescription steady until Nexus has completion feedback.',
        progressionReason: 'No recent per-exercise completion feedback is available yet.',
        progressionConfidence: 'cold_start',
      };
    });
  }

  return prescriptions.map((prescription) => {
    const matching = matchingSignalsForPrescription(prescription, signals);
    const targetReps = repsUpperBound(prescription.reps);
    const lastSignal = matching[0];
    if (!lastSignal) {
      recordTrainingProgressionState('hold');
      return {
        ...prescription,
        progressionState: 'hold',
        progressionSummary: 'Cold start: hold until this exercise has feedback.',
        progressionReason: 'Nexus has not seen this exact exercise completed recently.',
        progressionConfidence: 'cold_start',
      };
    }
    const priorSignal = matching[1];
    const painSameRegionLast7d = matching.some((signal) => {
      if ((signal.painScore ?? 0) < 4) return false;
      const completedMs = Date.parse(signal.completedAt);
      return Number.isFinite(completedMs) && Date.now() - completedMs <= 7 * 24 * 60 * 60 * 1000;
    });
    const decision = decideStrengthProgression({
      progressionTarget: template.progressionTarget,
      priorExposureCount: matching.length,
      lastSession: progressionSignalToGateSignal(lastSignal, targetReps),
      priorSession: progressionSignalToGateSignal(priorSignal, targetReps),
      painSameRegionLast7d,
    });
    const state = progressionStateFromDecision(athlete, decision);
    return applyDecisionToPrescription(prescription, decision, state);
  });
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
  // Hybrid athletes carry endurance volume in parallel, so the scoring
  // favors durability + stability + conditioning over raw maximal-strength
  // work and penalizes high spinal loading more than other non-maintenance
  // profiles do.
  if (profile === 'hybrid' && (purpose === 'strength' || purpose === 'conditioning' || purpose === 'stability')) score += 6;
  if (profile === 'hybrid' && getExerciseSpinalLoading(exercise) === 'high') score -= 4;
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
    {
      durationMinutes: session.durationMinutes,
      sessionRole: session.tags.join(' '),
    },
  );
  if (safetyResult.swappedFromIds.length > 0 || safetyResult.unresolvedConflictIds.length > 0) {
    logger.debug({
      athleteId: context.athlete.profile.athleteId,
      sessionId: session.id,
      sessionType: session.sessionType,
      surface: 'coherence_rebuild',
      swappedFromIds: safetyResult.swappedFromIds,
      unresolvedConflictIds: safetyResult.unresolvedConflictIds,
    }, 'coach-kernel strength safety substitutions evaluated');
  }
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
  return attachTrainingSessionRole({
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
  }, template);
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

  logger.debug({
    athleteId: context.athlete.profile.athleteId,
    sessionId: session.id,
    sessionType: session.sessionType,
    reason: verdict.reason,
    claimedMinutes: verdict.claimedMinutes,
    estimatedMinutes: verdict.estimatedMinutes,
    deviationPct: verdict.deviationPct,
  }, 'coach-kernel strength session coherence adjustment required');

  if (verdict.reason === 'underfilled') {
    const repaired = repairUnderfilledStrengthSession(session, template, context);
    const repairedVerdict = validateSessionCoherence(repaired, context.knowledge);
    if (repairedVerdict.ok) {
      logger.debug({
        athleteId: context.athlete.profile.athleteId,
        sessionId: repaired.id,
        sessionType: repaired.sessionType,
        claimedMinutes: repairedVerdict.claimedMinutes,
        estimatedMinutes: repairedVerdict.estimatedMinutes,
        exerciseCount: repaired.exercises?.length ?? 0,
      }, 'coach-kernel strength session coherence repaired');
      return repaired;
    }
  }

  const correction = suggestCorrection(verdict, session);
  logger.debug({
    athleteId: context.athlete.profile.athleteId,
    sessionId: session.id,
    sessionType: session.sessionType,
    correction: correction.type,
  }, 'coach-kernel strength session coherence fallback selected');

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
    const marathonStrengthBlock = context.athlete.goals.primaryFocus === 'marathon'
      && requestedSessions >= 5
      && !raceIsClose
      && context.phase !== 'peak'
      && context.phase !== 'taper';
    const enduranceMaintenance = context.athlete.goals.primaryFocus === 'triathlon'
      || (context.athlete.goals.primaryFocus === 'marathon' && !marathonStrengthBlock);
    const maintenance = context.phase === 'peak'
      || context.phase === 'taper'
      || raceIsClose
      || enduranceMaintenance;
    const strengthProfile = resolveStrengthProfile(context, maintenance);
    const sessionType = preferredSessionType(strengthProfile);
    const targetSessions = clamp(maintenance ? Math.min(requestedSessions, 2) : requestedSessions, 0, 6);
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
      const catalogSelection = config.coaching.trainingSelectorPolicyV2Enabled
        ? selectStrengthExercisesFromCatalog({
            library: context.knowledge.exercises,
            athlete: context.athlete,
            availableEquipment: availableEquipment(context.athlete),
            profile: strengthProfile,
            durationMinutes,
            targetCount: targetExerciseCount(durationMinutes, context.athlete.profile.experienceLevel),
            targetSessions,
            sessionIndex: index,
            weekIndex: weekIndexForRotation,
          })
        : null;
      const baseVariant = catalogSelection?.variant
        ?? (isLimitedStrengthSetup(context.athlete)
          ? limitedEquipmentVariantFor(strengthProfile, targetSessions, index, weekIndexForRotation)
            ?? strengthVariantFor(strengthProfile, targetSessions, index, weekIndexForRotation)
          : strengthVariantFor(strengthProfile, targetSessions, index, weekIndexForRotation));
      // Slice 2.A — beginner substitutions are applied to the variant
      // BEFORE equipment-aware resolution so the substituted exercise
      // (e.g. goblet_squat) still picks up its own equipment fallback
      // chain (e.g. bodyweight_squat) if the user has no dumbbells.
      const variant = catalogSelection
        ? baseVariant
        : applyBeginnerSubstitutions(baseVariant, context.athlete.profile.experienceLevel);
      const baseExercises = resolveExercises(
        template,
        context.knowledge.exercises,
        context.athlete,
        strengthProfile,
        variant,
        durationMinutes,
        catalogSelection?.selectionReasons,
        {
          allowTemplateDefaults: !catalogSelection,
          allowHardcodedFillers: !catalogSelection,
          selectorTrace: catalogSelection?.trace,
        },
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
        {
          durationMinutes,
          sessionRole: variant.tags.join(' '),
        },
      );
      if (safetyResult.swappedFromIds.length > 0 || safetyResult.unresolvedConflictIds.length > 0) {
        logger.debug({
          athleteId: context.athlete.profile.athleteId,
          sessionType,
          dayOfWeek,
          surface: 'initial_resolution',
          swappedFromIds: safetyResult.swappedFromIds,
          unresolvedConflictIds: safetyResult.unresolvedConflictIds,
        }, 'coach-kernel strength safety substitutions evaluated');
      }
      // Slice 4.H — sort the prescription list compound→accessory→
      // core→mobility so the heaviest work hits while the user is
      // freshest. Stable within each phase.
      const orderedExercises = orderExercisesForSession(
        safetyResult.prescriptions,
        context.knowledge.exercises,
      );
      const exercises = applyStrengthProgressionPolicy(
        orderedExercises,
        template,
        context.athlete,
      );
      const rawSession = buildStrengthSession(
        template,
        variant,
        dayOfWeek,
        durationMinutes,
        exercises,
        maintenance
          ? ['maintenance']
          : strengthProfile === 'hypertrophy'
            ? ['hypertrophy']
            : strengthProfile === 'max_strength'
              ? ['max_strength']
              : ['athletic_strength'],
      );
      // Slice 4.A — gate the produced session through the coherence
      // validator. Sessions whose claimed duration doesn't match
      // their content density are corrected (claim shrunk, or
      // trailing accessories trimmed) before surfacing.
      return applyCoherenceGate(rawSession, template, context);
    });
  },
};
