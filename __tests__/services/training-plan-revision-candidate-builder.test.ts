// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildTrainingPlanRevisionCandidate,
  validateTrainingPlanRevisionDocument,
  type TrainingPlanCandidateRequest,
} from '../../src/services/training-plan-revision-candidate-builder';

const beginnerHome: TrainingPlanCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice',
    sessionsPerWeek: 3,
    sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: [],
    location: 'home',
    preferences: ['simple movements'],
    exclusions: [],
  },
};

const experiencedGym: TrainingPlanCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'advanced',
    sessionsPerWeek: 5,
    sessionDurationMinutes: 60,
    availableDays: ['monday', 'tuesday', 'thursday', 'friday', 'saturday'],
    equipmentIds: ['bodyweight', 'barbell', 'rack', 'bench', 'dumbbells', 'cable_stack', 'leg_press'],
    location: 'gym',
    preferences: ['compound lifts'],
    exclusions: [],
  },
};

describe('training-plan-revision-candidate-builder', () => {
  it('builds deterministic immutable-content candidates', () => {
    const first = buildTrainingPlanRevisionCandidate(beginnerHome);
    const second = buildTrainingPlanRevisionCandidate(beginnerHome);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.document).toEqual(second.document);
    expect(first.document.schemaVersion).toBe('training-plan-revision.v1');
    expect(first.document.phases.map((phase) => phase.phaseType)).toEqual([
      'FOUNDATION', 'BUILD', 'DELOAD',
    ]);
  });

  it('produces materially different plans from the causal profile inputs', () => {
    const beginner = buildTrainingPlanRevisionCandidate(beginnerHome);
    const experienced = buildTrainingPlanRevisionCandidate(experiencedGym);

    expect(beginner.contentHash).not.toBe(experienced.contentHash);
    expect(beginner.document.weeklyStructure.targetSessionsPerWeek).toBe(3);
    expect(experienced.document.weeklyStructure.targetSessionsPerWeek).toBe(5);
    expect(beginner.document.weeklyStructure.sessionDurationMinutes).toBe(30);
    expect(experienced.document.weeklyStructure.sessionDurationMinutes).toBe(60);
    expect(beginner.document.progression.direction).not.toBe(experienced.document.progression.direction);
    expect(beginner.document.recovery.strategy).not.toBe(experienced.document.recovery.strategy);

    const beginnerExerciseIds = beginner.document.weeks.flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks)
      .flatMap((block) => block.exercises ?? [])
      .map((exercise) => exercise.exerciseId);
    const experiencedExerciseIds = experienced.document.weeks.flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks)
      .flatMap((block) => block.exercises ?? [])
      .map((exercise) => exercise.exerciseId);
    expect(beginnerExerciseIds).not.toEqual(experiencedExerciseIds);
    expect(beginner.causalFactors.map((factor) => factor.inputKey)).toEqual(expect.arrayContaining([
      'profile.experienceLevel',
      'profile.sessionsPerWeek',
      'profile.sessionDurationMinutes',
      'profile.availableDays',
      'profile.equipmentIds',
      'profile.location',
    ]));
  });

  it('uses ordered priority-bearing workout blocks', () => {
    const candidate = buildTrainingPlanRevisionCandidate(beginnerHome);
    const strength = candidate.document.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.sessionType === 'strength_hypertrophy');
    expect(strength).toBeTruthy();
    expect(strength?.blocks.map((block) => block.position)).toEqual([1, 2, 3, 4]);
    expect(strength?.blocks.map((block) => block.priority)).toEqual([
      'ESSENTIAL', 'ESSENTIAL', 'RECOMMENDED', 'OPTIONAL',
    ]);
    expect(strength?.blocks[1].prescription.kind).toBe('strength');
  });

  it('generates every rest day and reconciles each week to the declared workout distribution', () => {
    for (const request of [beginnerHome, experiencedGym]) {
      const candidate = buildTrainingPlanRevisionCandidate(request);
      const targets = Object.fromEntries(candidate.document.weeklyStructure.targetWorkoutTypeDistribution
        .map((target) => [target.sessionType, target.targetPerWeek]));

      expect(targets.rest).toBe(7 - request.profile.sessionsPerWeek);
      for (const week of candidate.document.weeks) {
        const actual = week.workouts.reduce<Record<string, number>>((counts, workout) => {
          counts[workout.sessionType] = (counts[workout.sessionType] ?? 0) + 1;
          return counts;
        }, {});
        expect(week.workouts).toHaveLength(7);
        expect(actual).toEqual(targets);
      }
    }
  });

  it('rejects unsupported modes and malformed availability before generation', () => {
    expect(() => buildTrainingPlanRevisionCandidate({ ...beginnerHome, planMode: 'event_based' }))
      .toThrow(/MILESTONE_1_PLAN_MODE_UNSUPPORTED/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...beginnerHome,
      profile: { ...beginnerHome.profile, availableDays: ['monday'] },
    })).toThrow(/TRAINING_AVAILABILITY_DOES_NOT_MATCH_FREQUENCY/);
  });

  it('fails quality validation for duration drift or invalid block ordering', () => {
    const candidate = buildTrainingPlanRevisionCandidate(beginnerHome);
    const invalid = JSON.parse(JSON.stringify(candidate.document)) as typeof candidate.document;
    const workout = invalid.weeks[0].workouts.find((entry) => entry.sessionType === 'strength_hypertrophy')!;
    workout.blocks[0].position = 2;
    workout.blocks[0].plannedDurationMinutes += 1;
    expect(() => validateTrainingPlanRevisionDocument(invalid))
      .toThrow(/ORDERED_PRIORITY_BLOCKS|WORKOUT_DURATION_CONSERVATION/);
  });

  it('fails quality validation when declared per-type targets drift from concrete workouts', () => {
    const candidate = buildTrainingPlanRevisionCandidate(beginnerHome);
    const invalidTarget = JSON.parse(JSON.stringify(candidate.document)) as typeof candidate.document;
    invalidTarget.weeklyStructure.targetWorkoutTypeDistribution
      .find((target) => target.sessionType === 'rest')!.targetPerWeek -= 1;
    expect(() => validateTrainingPlanRevisionDocument(invalidTarget))
      .toThrow(/TARGET_WORKOUT_DISTRIBUTION_MATCH/);

    const invalidWorkout = JSON.parse(JSON.stringify(candidate.document)) as typeof candidate.document;
    invalidWorkout.weeks[0].workouts.find((workout) => workout.sessionType === 'rest')!.sessionType = 'mobility';
    expect(() => validateTrainingPlanRevisionDocument(invalidWorkout))
      .toThrow(/TARGET_WORKOUT_DISTRIBUTION_MATCH/);
  });
});
