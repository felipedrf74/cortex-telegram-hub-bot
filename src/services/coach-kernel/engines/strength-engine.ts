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

function prescriptionFor(exercise: Exercise, profile: StrengthProfile): Omit<ExercisePrescription, 'exerciseId' | 'name' | 'notes'> {
  switch (profile) {
    case 'maintenance':
      return {
        sets: 2,
        reps: exercise.movementPattern === 'core' || exercise.movementPattern === 'mobility' ? '8-12' : '5-8',
        rir: 3,
      };
    case 'hypertrophy':
      return {
        sets: exercise.movementPattern === 'core' || exercise.movementPattern === 'mobility' ? 3 : 4,
        reps: exercise.movementPattern === 'core' || exercise.movementPattern === 'mobility' ? '8-12' : '6-10',
        rir: 1,
      };
    case 'max_strength':
      return {
        sets: ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern) ? 4 : 3,
        reps: ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern) ? '3-5' : '6-8',
        rir: 2,
      };
    default:
      return {
        sets: ['squat', 'hinge', 'push', 'pull'].includes(exercise.movementPattern) ? 4 : 3,
        reps: exercise.movementPattern === 'core' || exercise.movementPattern === 'mobility' ? '8-12' : '4-6',
        rir: 2,
      };
  }
}

function resolveExercises(template: WorkoutTemplate, library: Exercise[], athlete: AthleteState, profile: StrengthProfile): ExercisePrescription[] {
  const equipment = availableEquipment(athlete);
  const libraryById = new Map(library.map((exercise) => [exercise.id, exercise]));
  const usedIds = new Set<string>();
  const basePrescriptions = (template.defaultExercises ?? [])
    .map<ExercisePrescription | null>((exerciseId) => {
      const original = libraryById.get(exerciseId) ?? null;
      const resolved = resolveExerciseCandidate(exerciseId, libraryById, equipment, usedIds);
      if (!resolved) return null;
      usedIds.add(resolved.id);
      const prescription = prescriptionFor(resolved, profile);
      return {
        exerciseId: resolved.id,
        name: resolved.name,
        sets: prescription.sets,
        reps: prescription.reps,
        rir: prescription.rir,
        notes: original && original.id !== resolved.id
          ? `Adjusted from ${original.name} to fit the athlete's available equipment.`
          : undefined,
      };
    })
    .filter((exercise): exercise is ExercisePrescription => exercise !== null);

  const prescriptions: ExercisePrescription[] = [...basePrescriptions];

  if (prescriptions.length >= 4) return prescriptions;

  const fillerIds = ['dead_bug', 'hip_airplane', 'bear_crawl', 'worlds_greatest_stretch'];
  for (const fillerId of fillerIds) {
    if (prescriptions.length >= 4) break;
    const filler = libraryById.get(fillerId);
    if (!filler || usedIds.has(filler.id) || !canPerformExercise(filler, equipment)) continue;
    usedIds.add(filler.id);
    const prescription = prescriptionFor(filler, profile);
    prescriptions.push({
      exerciseId: filler.id,
      name: filler.name,
      sets: prescription.sets,
      reps: prescription.reps,
      rir: prescription.rir,
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
  const fallbackDays: DayOfWeek[] = ['monday', 'wednesday', 'friday'];
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
  dayOfWeek: DayOfWeek,
  durationMinutes: number,
  exercises: ExercisePrescription[],
  tags: string[],
): Session {
  return {
    id: createSessionId('strength', dayOfWeek, template.title),
    sport: 'strength',
    sessionType: template.sessionType,
    title: template.title,
    description: template.instructions.join(' '),
    dayOfWeek,
    durationMinutes,
    intensityZone: template.primaryZone,
    fatigueCost: template.fatigueCost,
    keySession: false,
    plannedLoad: durationToLoad(durationMinutes, template.primaryZone, template.fatigueCost),
    sourceTemplateId: template.id,
    tags,
    exercises,
    alternatives: ['Swap for lighter full-body support', 'Swap for core and mobility circuit'],
  };
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
    const exercises = resolveExercises(template, context.knowledge.exercises, context.athlete, strengthProfile);
    const days = resolveStrengthDays(context.athlete, targetSessions);

    return days.slice(0, targetSessions).map((dayOfWeek) =>
      buildStrengthSession(
        template,
        dayOfWeek,
        resolveDurationForDay(template, context.athlete, dayOfWeek),
        exercises,
        maintenance
          ? ['maintenance', 'lower_body', 'core']
          : strengthProfile === 'hypertrophy'
            ? ['hypertrophy', 'full_body', 'lower_body', 'core']
            : ['full_body', 'lower_body', 'core'],
      )
    );
  },
};
