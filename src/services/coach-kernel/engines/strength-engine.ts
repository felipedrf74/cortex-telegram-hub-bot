// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { EngineContext, SportEngine } from './interfaces';
import type { Exercise, ExercisePrescription, Session, SessionType, WorkoutTemplate } from '../types';
import { clamp, createSessionId, durationToLoad } from '../utils';

function templateFor(templates: WorkoutTemplate[], sessionType: SessionType): WorkoutTemplate {
  const match = templates.find((template) => template.sessionType === sessionType);
  if (!match) throw new Error(`Missing strength template for ${sessionType}`);
  return match;
}

function resolveExercises(template: WorkoutTemplate, library: Exercise[], maintenance: boolean): ExercisePrescription[] {
  return (template.defaultExercises ?? [])
    .map((exerciseId) => library.find((exercise) => exercise.id === exerciseId))
    .filter((exercise): exercise is Exercise => Boolean(exercise))
    .map((exercise) => ({
      exerciseId: exercise.id,
      name: exercise.name,
      sets: maintenance ? 2 : 4,
      reps: maintenance ? '5-8' : exercise.movementPattern === 'core' ? '8-12' : '4-6',
      rir: maintenance ? 3 : 2,
    }));
}

function buildStrengthSession(
  template: WorkoutTemplate,
  dayOfWeek: 'monday' | 'thursday' | 'friday',
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
    const sessionType: SessionType = maintenance ? 'strength_maintenance' : 'strength_max';
    const duration = maintenance ? 40 : 55;
    const targetSessions = clamp(maintenance ? Math.min(requestedSessions, 2) : requestedSessions, 0, 4);
    const template = templateFor(templates, sessionType);
    const exercises = resolveExercises(template, context.knowledge.exercises, maintenance);
    const days: Array<'monday' | 'thursday' | 'friday'> = ['monday', 'thursday', 'friday'];

    return days.slice(0, targetSessions).map((dayOfWeek, index) =>
      buildStrengthSession(
        template,
        dayOfWeek,
        duration - index * 5,
        exercises,
        maintenance ? ['maintenance', 'lower_body', 'core'] : ['full_body', 'lower_body', 'core'],
      )
    );
  },
};

