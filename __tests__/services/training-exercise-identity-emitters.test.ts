// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import { buildDeterministicTrainingPlan } from '../../src/api/routes/training-fallback-plan';
import {
  applyTrainingPlanCoordination,
  buildTrainingPlanCoordination,
  type CoordinatedTrainingPlan,
} from '../../src/services/training-plan-coordination';
import {
  adaptTrainingPlanToAvailableEquipment,
  buildTrainingEquipmentAdaptation,
} from '../../src/services/training-plan-equipment-adaptation';
import { resolveTrainingExerciseIdentity } from '../../src/services/training-exercise-identity';

const activeEnv = { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'active' };

function exercisesIn(plan: CoordinatedTrainingPlan): Array<Record<string, unknown>> {
  return (plan.weeks ?? [])
    .flatMap((week) => week.sessions ?? [])
    .flatMap((session) => session.exercises ?? []) as Array<Record<string, unknown>>;
}

function expectIdentityClosed(
  exercises: Array<Record<string, unknown>>,
  options: { requireExercise?: boolean } = {},
): void {
  if (options.requireExercise !== false) expect(exercises.length).toBeGreaterThan(0);
  for (const exercise of exercises) {
    expect(typeof exercise.exerciseId).toBe('string');
    expect(typeof exercise.name).toBe('string');
    expect(resolveTrainingExerciseIdentity({
      exerciseId: exercise.exerciseId,
      name: exercise.name,
    })).toMatchObject({
      kind: 'canonical',
      canonicalId: exercise.exerciseId,
      canonicalName: exercise.name,
    });
  }
}

describe('training exercise identity emitter closure', () => {
  it('keeps coordination rollout context non-enumerable and shadow string exercises shape-stable', () => {
    const input = {
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
    };
    const off = buildTrainingPlanCoordination({ ...input, env: {} });
    const active = buildTrainingPlanCoordination({ ...input, env: activeEnv });
    const shadow = buildTrainingPlanCoordination({
      ...input,
      env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'shadow' },
    });

    expect(Object.keys(active)).toEqual(Object.keys(off));
    expect(JSON.stringify(active)).toBe(JSON.stringify(off));
    expect(active).not.toHaveProperty('exerciseIdentityMode');

    const offEquipment = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: {},
    });
    const activeEquipment = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: activeEnv,
    });
    expect(Object.keys(activeEquipment)).toEqual(Object.keys(offEquipment));
    expect(JSON.stringify(activeEquipment)).toBe(JSON.stringify(offEquipment));
    expect(activeEquipment).not.toHaveProperty('exerciseIdentityMode');

    const legacyEquipmentPlan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Legacy bands',
          durationMinutes: 30,
          exercises: [{ name: 'Machine Mystery Fly', sets: 2, reps: 12 }],
        }],
      }],
    };
    const shadowEquipment = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'shadow' },
    });
    expect(adaptTrainingPlanToAvailableEquipment(legacyEquipmentPlan, shadowEquipment))
      .toEqual(adaptTrainingPlanToAvailableEquipment(legacyEquipmentPlan, offEquipment));

    const plan: CoordinatedTrainingPlan = {
      sport: 'strength',
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Legacy string session',
          durationMinutes: 35,
          exercises: ['Push-Up'] as any[],
        }],
      }],
    };
    const shadowResult = applyTrainingPlanCoordination(plan, shadow);
    expect(shadowResult).toEqual(applyTrainingPlanCoordination(plan, off));
    expect(shadowResult.weeks?.[0].sessions?.[0].exercises).toEqual(['Push-Up']);
  });

  it('keeps the equipment adapter legacy-compatible while off', () => {
    const plan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Upper Body',
          durationMinutes: 45,
          exercises: [{ name: 'Bench Press', sets: 3, reps: 8 }],
        }],
      }],
    };
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: {},
    });

    expect(adaptTrainingPlanToAvailableEquipment(plan, adaptation).weeks?.[0].sessions?.[0].exercises)
      .toEqual([{ name: 'Banded Push-Up', sets: 3, reps: 8 }]);
  });

  it('never keeps a stale exercise id after bodyweight substitution changes the movement', () => {
    const plan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Travel strength',
          durationMinutes: 35,
          exercises: [{ exerciseId: 'band_row', name: 'Band Row', sets: 3, reps: 12 }],
        }],
      }],
    };
    const adapt = (mode: 'off' | 'shadow' | 'active') => adaptTrainingPlanToAvailableEquipment(
      plan,
      buildTrainingEquipmentAdaptation({
        gymProfile: { equipment_access: 'Bodyweight only' },
        env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: mode },
      }),
    ).weeks?.[0].sessions?.[0].exercises?.[0] as Record<string, unknown>;

    expect(adapt('off')).toMatchObject({
      name: 'Prone Snow Angel',
      sets: 3,
      reps: 12,
      equipment: ['bodyweight'],
    });
    expect(adapt('off')).not.toHaveProperty('exerciseId');
    expect(adapt('shadow')).toMatchObject({
      name: 'Prone Snow Angel',
      sets: 3,
      reps: 12,
      equipment: ['bodyweight'],
    });
    expect(adapt('shadow')).not.toHaveProperty('exerciseId');
    expect(adapt('active')).toMatchObject({
      exerciseId: 'prone_lat_pulldown',
      name: 'Prone Lat Pulldown',
      sets: 3,
      reps: 12,
      equipment: ['bodyweight'],
    });
  });

  it('emits stable IDs for reviewed equipment substitutions and never persists dynamic Banded names', () => {
    const plan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Full Body',
          durationMinutes: 50,
          exercises: [
            { name: 'Bench Press', sets: 3, reps: 8 },
            { name: 'Lat Pulldown', sets: 3, reps: 10 },
            { name: 'Romanian Deadlift', sets: 3, reps: 8 },
          ],
        }],
      }],
    };
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: activeEnv,
    });
    const exercises = exercisesIn(adaptTrainingPlanToAvailableEquipment(plan, adaptation));

    expectIdentityClosed(exercises);
    expect(exercises.map((exercise) => exercise.exerciseId)).toEqual([
      'push_up',
      'band_pulldown',
      'hip_hinge_band',
    ]);
    expect(exercises.map((exercise) => exercise.name).join(' ')).not.toMatch(/Banded Banded|Banded Surprise/i);
  });

  it('preserves movement roles for exact active band substitutions', () => {
    const plan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Role-preserving strength',
          durationMinutes: 50,
          exercises: [
            { name: 'Overhead Press', sets: 3, reps: 8 },
            { name: 'Lat Pulldown', sets: 3, reps: 10 },
            { name: 'Seated Cable Row', sets: 3, reps: 10 },
            { name: 'Single-Leg RDL', sets: 3, reps: 8 },
          ],
        }],
      }],
    };
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: activeEnv,
    });
    const exercises = exercisesIn(adaptTrainingPlanToAvailableEquipment(plan, adaptation));

    expectIdentityClosed(exercises);
    expect(exercises.map((exercise) => exercise.exerciseId)).toEqual([
      'pike_push_up',
      'band_pulldown',
      'band_row',
      'single_leg_hip_hinge',
    ]);
  });

  it.each([
    'Machine Mystery Fly',
    'Cable Fly',
    'Upright Pull',
    'Arnold Press',
    'Hanging Knee Raise',
  ])('fails closed instead of guessing the active band movement role for %s', (exerciseName) => {
    const plan: CoordinatedTrainingPlan = {
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Accessory',
          durationMinutes: 30,
          exercises: [{ name: exerciseName, sets: 3, reps: 12 }],
        }],
      }],
    };
    const adaptation = buildTrainingEquipmentAdaptation({
      gymProfile: { equipment_access: 'Resistance bands' },
      env: activeEnv,
    });

    expect(() => adaptTrainingPlanToAvailableEquipment(plan, adaptation))
      .toThrow(/No reviewed movement-role-preserving resistance-band substitution/i);
  });

  it('closes coordination-created support exercises without persisting composite labels', () => {
    const coordination = buildTrainingPlanCoordination({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      training: null,
      cooking: null,
      finance: null,
      content: null,
      secretary: null,
      env: activeEnv,
    });
    const plan: CoordinatedTrainingPlan = {
      sport: 'running',
      weeks: [{
        weekNumber: 1,
        sessions: [{
          dayOfWeek: 'monday',
          sessionType: 'gym',
          title: 'Strength Support',
          durationMinutes: 40,
          exercises: [
            { name: 'Push-Up / DB Floor Press', sets: 3, reps: 10 },
            { name: 'One-Arm Row', sets: 3, reps: 10 },
          ],
        }],
      }],
    };
    const result = applyTrainingPlanCoordination(plan, coordination);
    const exercises = exercisesIn(result);

    expectIdentityClosed(exercises);
    expect(exercises.map((exercise) => exercise.name).join(' ')).not.toMatch(/\//);
  });

  it.each([
    'Hypertrophy phase',
    'Lisbon Marathon build',
    'Half Ironman prep',
    'General fitness',
  ])('closes every static fallback exercise for %s', (objective) => {
    const plan = buildDeterministicTrainingPlan(objective, 4, {
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      env: activeEnv,
    });
    const exercises = exercisesIn(plan);

    expectIdentityClosed(exercises, { requireExercise: objective !== 'Half Ironman prep' });
    expect(exercises.map((exercise) => exercise.name).join(' ')).not.toMatch(/\//);
  });

  it('keeps deterministic fallback output identical in shadow mode', () => {
    expect(buildDeterministicTrainingPlan('Hypertrophy phase', 4, {
      sessionsPerWeek: 4,
      env: { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'shadow' },
    })).toEqual(buildDeterministicTrainingPlan('Hypertrophy phase', 4, {
      sessionsPerWeek: 4,
      env: {},
    }));
  });
});
