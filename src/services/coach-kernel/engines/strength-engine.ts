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

function strengthVariantFor(profile: StrengthProfile, targetSessions: number, index: number): StrengthVariant {
  const profileTitle = profile === 'hypertrophy'
    ? 'Hypertrophy'
    : profile === 'max_strength'
      ? 'Strength'
      : profile === 'maintenance'
        ? 'Maintenance'
        : 'Strength';
  const slot = Math.max(0, index) % Math.max(1, targetSessions);

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

function minimumExerciseCount(durationMinutes: number, experience: StrengthExperience): number {
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

  const targetCount = minimumExerciseCount(durationMinutes, experience);
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

    return days.slice(0, targetSessions).map((dayOfWeek, index) => {
      const durationMinutes = resolveDurationForDay(template, context.athlete, dayOfWeek);
      const variant = strengthVariantFor(strengthProfile, targetSessions, index);
      const exercises = resolveExercises(
        template,
        context.knowledge.exercises,
        context.athlete,
        strengthProfile,
        variant,
        durationMinutes,
      );
      return buildStrengthSession(
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
    });
  },
};
