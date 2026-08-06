// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildActiveWorkoutFloorCheck,
  buildTrainingPlanRevisionCandidate,
  countActiveWorkouts,
  deriveQualityStatus,
  validateTrainingPlanRevisionDocument,
  type TrainingPlanCandidateRequest,
  type TrainingPlanRevisionDocument,
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

  it('keeps flag-off candidate bytes stable and adds typed validation evidence only when enabled', () => {
    const defaultCandidate = buildTrainingPlanRevisionCandidate(beginnerHome);
    const explicitlyOff = buildTrainingPlanRevisionCandidate(beginnerHome, {
      typedWorkoutValidationEnabled: false,
    });
    const enabled = buildTrainingPlanRevisionCandidate(beginnerHome, {
      typedWorkoutValidationEnabled: true,
    });

    expect(explicitlyOff).toEqual(defaultCandidate);
    expect(enabled.document.schemaVersion).toBe('training-plan-revision.v2');
    expect(enabled.document).not.toEqual(defaultCandidate.document);
    expect(enabled.contentHash).not.toBe(defaultCandidate.contentHash);
    expect(enabled.creationContextVersion).not.toBe(defaultCandidate.creationContextVersion);
    expect(defaultCandidate.qualityReport.checks.some((check) =>
      check.code === 'TYPED_CANONICAL_SESSION_COVERAGE')).toBe(false);
    expect(enabled.qualityReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TYPED_CANONICAL_SESSION_COVERAGE' }),
      expect.objectContaining({ code: 'TYPED_BLOCK_AND_PRESCRIPTION_VALIDATION' }),
      expect.objectContaining({ code: 'TYPED_STANDALONE_PHASE_OMISSION' }),
      expect.objectContaining({ code: 'TYPED_UNKNOWN_FALLBACK' }),
      expect.objectContaining({ code: 'PHASE_SEQUENCE_FOR_PLAN_MODE' }),
      expect.objectContaining({ code: 'TYPED_REVISION_PHASE_DISTRIBUTION_MATCH' }),
    ]));
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

  it('keeps equipment and experience causal in the typed M2 strength generator', () => {
    const beginner = buildTrainingPlanRevisionCandidate(beginnerHome, { typedWorkoutValidationEnabled: true });
    const experienced = buildTrainingPlanRevisionCandidate(experiencedGym, { typedWorkoutValidationEnabled: true });
    const exerciseIds = (candidate: typeof beginner) => candidate.document.weeks
      .flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks)
      .flatMap((block) => block.exercises ?? [])
      .map((exercise) => exercise.exerciseId);
    expect(exerciseIds(beginner)).not.toEqual(exerciseIds(experienced));
    expect(beginner.contentHash).not.toBe(experienced.contentHash);
    expect(experienced.document.weeks.flatMap((week) => week.workouts)
      .some((workout) => workout.sessionType === 'strength_max')).toBe(true);
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

  it('runs the consolidated modality validator only behind its explicit option', () => {
    const candidate = buildTrainingPlanRevisionCandidate(beginnerHome);
    const invalid = structuredClone(candidate.document);
    const strength = invalid.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.sessionType === 'strength_hypertrophy')!;
    strength.blocks.find((block) => block.blockType === 'PRIMARY_WORK')!.prescription = {
      kind: 'unknown',
      rawPrescriptionType: 'strength_hypertrophy',
      summary: 'Incorrectly generic strength prescription.',
      newlyPrescribable: false,
    };

    expect(() => validateTrainingPlanRevisionDocument(invalid)).not.toThrow();
    expect(() => validateTrainingPlanRevisionDocument(invalid, {
      typedWorkoutValidationEnabled: true,
    })).toThrow(/TYPED_CANONICAL_UNKNOWN_PRESCRIPTION_FORBIDDEN|TYPED_SESSION_PRESCRIPTION_MISMATCH/);
  });

  // F3 (Phase 1A-1): the quality report must be able to fail.
  //
  // Both construction sites hardcoded `status: 'PASS'` and the type admitted
  // no other value, so `quality_report_json` was an attestation record rather
  // than a gate — it could not block a zero-workout candidate, or anything
  // else. These pin the primitives the gate is built from.
  describe('quality report — active workout floor', () => {
    function doc(weeks: TrainingPlanRevisionDocument['weeks']): TrainingPlanRevisionDocument {
      return { weeks } as TrainingPlanRevisionDocument;
    }

    function workout(sessionType: string, workoutKey: string) {
      return { workoutKey, sessionType } as TrainingPlanRevisionDocument['weeks'][number]['workouts'][number];
    }

    it('counts only non-rest workouts as active', () => {
      const document = doc([
        { weekKey: 'w1', weekNumber: 1, phaseKey: 'p', loadDirection: 'BASELINE', workouts: [
          workout('strength_hypertrophy', 'a'),
          workout('rest', 'b'),
        ] },
        { weekKey: 'w2', weekNumber: 2, phaseKey: 'p', loadDirection: 'BASELINE', workouts: [
          workout('rest', 'c'),
        ] },
      ]);
      expect(countActiveWorkouts(document)).toBe(1);
    });

    it('reports zero for a rest-only document', () => {
      const document = doc([
        { weekKey: 'w1', weekNumber: 1, phaseKey: 'p', loadDirection: 'BASELINE', workouts: [
          workout('rest', 'a'),
          workout('rest', 'b'),
        ] },
      ]);
      expect(countActiveWorkouts(document)).toBe(0);
    });

    it('reports zero for a document with no workouts at all', () => {
      expect(countActiveWorkouts(doc([]))).toBe(0);
    });

    it('emits a FAIL floor check when there are no active workouts', () => {
      const check = buildActiveWorkoutFloorCheck(0);
      expect(check.code).toBe('ACTIVE_WORKOUT_FLOOR');
      expect(check.status).toBe('FAIL');
    });

    it('emits a PASS floor check when active workouts exist', () => {
      expect(buildActiveWorkoutFloorCheck(3).status).toBe('PASS');
    });

    it('derives FAIL for the whole report when any check fails', () => {
      expect(deriveQualityStatus([
        { code: 'A', status: 'PASS', evidence: '' },
        { code: 'ACTIVE_WORKOUT_FLOOR', status: 'FAIL', evidence: '' },
      ])).toBe('FAIL');
    });

    it('derives PASS only when every check passes', () => {
      expect(deriveQualityStatus([
        { code: 'A', status: 'PASS', evidence: '' },
        { code: 'B', status: 'PASS', evidence: '' },
      ])).toBe('PASS');
      expect(deriveQualityStatus([])).toBe('PASS');
    });

    it('marks a real generated candidate PASS with a floor check present', () => {
      const built = buildTrainingPlanRevisionCandidate(beginnerHome);
      expect(built.qualityReport.status).toBe('PASS');
      expect(built.qualityReport.checks.map((check) => check.code)).toContain('ACTIVE_WORKOUT_FLOOR');
      expect(countActiveWorkouts(built.document)).toBeGreaterThan(0);
    });
  });
});
