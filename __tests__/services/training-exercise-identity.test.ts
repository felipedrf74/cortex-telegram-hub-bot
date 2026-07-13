// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  EXERCISE_LIBRARY,
  buildTrainingExerciseIdentityLibrary,
} from '../../src/services/coach-kernel/training-taxonomy';
import { getTrainingExerciseCandidateTiers } from '../../src/services/coach-kernel/training-plan-quality-gate';
import {
  assertTrainingExerciseIdentityCatalogIntegrity,
  buildTrainingExerciseIdentityCatalogSnapshot,
  normalizeTrainingExercisesJsonForWrite,
  resolveTrainingExerciseIdentity,
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
  TRAINING_EXERCISE_IDENTITY_POLICY_VERSION,
  trainingExerciseToolJsonDescription,
} from '../../src/services/training-exercise-identity';
import {
  buildTrainingPlanRevisionCandidate,
  type TrainingPlanCandidateRequest,
} from '../../src/services/training-plan-revision-candidate-builder';

const activeEnv = { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'active' };
const shadowEnv = { TRAINING_EXERCISE_IDENTITY_V1_MODE: 'shadow' };

const safeAliases: Array<[string, string]> = [
  ['Band Face Pull', 'face_pull'],
  ['Band Lat Pulldown', 'band_pulldown'],
  ['Banded Row', 'band_row'],
  ['Barbell Row', 'barbell_bent_row'],
  ['DB Overhead Triceps Extension', 'dumbbell_triceps_extension'],
  ['DB Romanian Deadlift', 'romanian_deadlift'],
  ['Front Plank', 'plank'],
  ['One-Arm DB Row', 'one_arm_dumbbell_row'],
  ['Single-Leg RDL', 'single_leg_rdl'],
  ['Slider Hamstring Curl', 'slider_leg_curl'],
  ['Table Row', 'inverted_row'],
  ['Incline DB Press', 'incline_dumbbell_press'],
];

const deliberatelyAmbiguousNames = [
  'One-Arm Row',
  'Hip Thrust',
  'Leg Curl',
  'Lateral Raise',
  'Pull-Up / Inverted Row',
  'Push-Up / DB Floor Press',
  'Push-Up / DB Press',
  'Lat Pulldown / Pull-Up',
  'Cable / Band Triceps Pressdown',
];

const candidateRequest: TrainingPlanCandidateRequest = {
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
  },
};

describe('training-exercise-identity', () => {
  it('pins the immutable 158-entry identity catalog and 26 reviewed promotions', () => {
    const snapshot = buildTrainingExerciseIdentityCatalogSnapshot();

    expect(snapshot.catalogVersion).toBe(TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION);
    expect(snapshot.policyVersion).toBe(TRAINING_EXERCISE_IDENTITY_POLICY_VERSION);
    expect(snapshot.sourceHash).toBe(TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH);
    expect(snapshot.entries).toHaveLength(158);
    expect(snapshot.promotedEmergencyIds).toHaveLength(26);
    expect(new Set(snapshot.entries.map((entry) => entry.exerciseId)).size).toBe(158);
    expect(snapshot.entries.some((entry) => entry.exerciseId === 'floor_press')).toBe(false);
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      exerciseId: 'dumbbell_floor_press',
      active: true,
    }));
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      exerciseId: 'jumping_lunge',
      source: 'resolved_template',
    }));
    expect(() => assertTrainingExerciseIdentityCatalogIntegrity(snapshot)).not.toThrow();
  });

  it('returns defensive catalog snapshots and fails closed on version or hash drift', () => {
    const first = buildTrainingExerciseIdentityCatalogSnapshot();
    first.entries.pop();
    const second = buildTrainingExerciseIdentityCatalogSnapshot();

    expect(second.entries).toHaveLength(158);
    expect(() => assertTrainingExerciseIdentityCatalogIntegrity({
      ...second,
      sourceHash: 'unreviewed-drift',
    })).toThrow(/authoritative Training exercise identity catalog changed/i);
  });

  it('supports only the reviewed stable-ID alias for floor press', () => {
    const aliased = resolveTrainingExerciseIdentity({ exerciseId: 'floor_press' });
    const unknown = resolveTrainingExerciseIdentity({ exerciseId: 'db_floor_press' });

    expect(aliased).toMatchObject({
      kind: 'canonical',
      canonicalId: 'dumbbell_floor_press',
      matchedBy: 'id_alias',
      newlyPrescribable: true,
      mediaEligible: true,
    });
    expect(unknown).toMatchObject({ kind: 'unknown', reason: 'unknown_id' });
  });

  it.each(safeAliases)('resolves reviewed exact name alias %s to %s', (name, canonicalId) => {
    expect(resolveTrainingExerciseIdentity({ name })).toMatchObject({
      kind: 'canonical',
      canonicalId,
      matchedBy: 'reviewed_name_alias',
    });
  });

  it.each(deliberatelyAmbiguousNames)('does not globally guess the ambiguous name %s', (name) => {
    expect(resolveTrainingExerciseIdentity({ name })).toMatchObject({
      kind: 'ambiguous',
      reason: 'ambiguous_name',
      newlyPrescribable: false,
      mediaEligible: false,
    });
  });

  it('matches exact normalized text only and never performs fuzzy aliasing', () => {
    expect(resolveTrainingExerciseIdentity({ name: '  BAND   FACE PULL  ' })).toMatchObject({
      kind: 'canonical',
      canonicalId: 'face_pull',
    });
    expect(resolveTrainingExerciseIdentity({ name: 'Band Face Pulls' })).toMatchObject({
      kind: 'unknown',
      reason: 'unknown_name',
    });
  });

  it('turns reviewed tempo labels into canonical IDs plus structured tempo', () => {
    expect(resolveTrainingExerciseIdentity({ name: 'Tempo Air Squat' })).toMatchObject({
      kind: 'canonical',
      canonicalId: 'bodyweight_squat',
      prescriptionPatch: { tempo: '3-1-1-0' },
    });
    expect(resolveTrainingExerciseIdentity({ name: 'Tempo Split Squat' })).toMatchObject({
      kind: 'canonical',
      canonicalId: 'split_squat',
      prescriptionPatch: { tempo: '3-1-1-0' },
    });
  });

  it('preserves unknown historical text without making it newly prescribable', () => {
    expect(resolveTrainingExerciseIdentity({
      name: 'Coach custom cable pattern',
      usage: 'historical_read',
    })).toMatchObject({
      kind: 'historical_text',
      displayText: 'Coach custom cable pattern',
      newlyPrescribable: false,
      mediaEligible: false,
    });
  });

  it('keeps legacy writes byte-stable while off or shadow and canonicalizes only while active', () => {
    const raw = JSON.stringify([{ name: 'Tempo Split Squat', sets: 3, reps: 10 }]);

    expect(normalizeTrainingExercisesJsonForWrite(raw, { env: {} })).toBe(raw);
    expect(normalizeTrainingExercisesJsonForWrite(raw, { env: shadowEnv })).toBe(raw);
    expect(JSON.parse(normalizeTrainingExercisesJsonForWrite(raw, { env: activeEnv }) as string)).toEqual([{
      name: 'Split Squat',
      sets: 3,
      reps: 10,
      exerciseId: 'split_squat',
      tempo: '3-1-1-0',
    }]);
  });

  it('rejects ambiguous, unknown, composite, malformed, and oversized new prescriptions in active mode', () => {
    expect(() => normalizeTrainingExercisesJsonForWrite(
      JSON.stringify([{ name: 'Hip Thrust' }]),
      { env: activeEnv },
    )).toThrow(/ambiguous/i);
    expect(() => normalizeTrainingExercisesJsonForWrite(
      JSON.stringify([{ name: 'Banded Surprise Machine Pull' }]),
      { env: activeEnv },
    )).toThrow(/not an active canonical exercise/i);
    expect(() => normalizeTrainingExercisesJsonForWrite('{bad json', { env: activeEnv })).toThrow(/valid JSON/i);
    expect(() => normalizeTrainingExercisesJsonForWrite(
      JSON.stringify(Array.from({ length: 101 }, () => ({ name: 'Push-Up' }))),
      { env: activeEnv },
    )).toThrow(/bounded exercise count/i);
  });

  it('classifies every catalog mobility exercise before name heuristics and exposes real carry options', () => {
    const identityLibrary = buildTrainingExerciseIdentityLibrary();
    const mobility = identityLibrary.filter((exercise) => exercise.movementPattern === 'mobility');
    const carryNames = identityLibrary
      .filter((exercise) => exercise.movementPattern === 'loaded_carry')
      .map((exercise) => exercise.name);

    expect(EXERCISE_LIBRARY).toHaveLength(149);
    expect(EXERCISE_LIBRARY.some((exercise) => exercise.movementPattern === 'mobility')).toBe(false);
    expect(mobility.map((exercise) => exercise.id).sort()).toEqual([
      'cat_cow',
      'childs_pose',
      'cossack_squat',
      'couch_stretch',
      'hip_airplane',
      'hip_flexor_stretch',
      'jefferson_curl',
      'ninety_ninety_hip_switch',
      'thoracic_rotation_open',
      'worlds_greatest_stretch',
    ]);
    expect(carryNames).toEqual(expect.arrayContaining([
      'Farmer Carry',
      'Suitcase Carry',
      'Sandbag Hold',
      'Overhead Carry',
      'Yoke / Front-Rack Carry',
    ]));
    expect(carryNames).not.toContain('Pallof Press');
    expect(getTrainingExerciseCandidateTiers('loaded_carry')).toEqual([['Pallof Press']]);
    expect(getTrainingExerciseCandidateTiers('loaded_carry', { exerciseIdentityMode: 'shadow' }))
      .toEqual([['Pallof Press']]);
    expect(getTrainingExerciseCandidateTiers('loaded_carry', { exerciseIdentityMode: 'active' }))
      .toEqual([
        ['Farmer Carry', 'Suitcase Carry'],
        ['Sandbag Hold', 'Overhead Carry'],
        ['Yoke / Front-Rack Carry'],
      ]);
    expect(getTrainingExerciseCandidateTiers('mobility')).toEqual([]);
    expect(getTrainingExerciseCandidateTiers('mobility', { exerciseIdentityMode: 'active' })[0])
      .toEqual(['90/90 Hip Switch', 'Cat-Cow', 'Half-Kneeling Hip Flexor Stretch']);
  });

  it('pins M1 candidates to the identity catalog only in active mode', () => {
    const off = buildTrainingPlanRevisionCandidate(candidateRequest, { env: {} });
    const shadow = buildTrainingPlanRevisionCandidate(candidateRequest, { env: shadowEnv });
    const active = buildTrainingPlanRevisionCandidate(candidateRequest, { env: activeEnv });
    const activeExercises = active.document.weeks
      .flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks)
      .flatMap((block) => block.exercises ?? []);

    expect(off.catalogVersion).toMatch(/^repo-seed-/);
    expect(shadow).toEqual(off);
    expect(off.qualityReport.checks.some((check) => check.code === 'EXERCISE_IDENTITY_CLOSURE')).toBe(false);
    expect(active.catalogVersion).toBe(TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION);
    expect(active.catalogSourceHash).toBe(TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH);
    expect(active.qualityReport.checks).toContainEqual(expect.objectContaining({
      code: 'EXERCISE_IDENTITY_CLOSURE',
      status: 'PASS',
    }));
    expect(activeExercises.length).toBeGreaterThan(0);
    expect(activeExercises.every((exercise) => exercise.exerciseId && exercise.name)).toBe(true);
  });

  it('preserves identity closure when typed M2 generation is enabled', () => {
    const active = buildTrainingPlanRevisionCandidate(candidateRequest, {
      env: activeEnv,
      typedWorkoutValidationEnabled: true,
    });
    const activeExercises = active.document.weeks
      .flatMap((week) => week.workouts)
      .flatMap((workout) => workout.blocks)
      .flatMap((block) => block.exercises ?? []);

    expect(active.document.schemaVersion).toBe('training-plan-revision.v2');
    expect(active.catalogVersion).toBe(TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION);
    expect(active.catalogSourceHash).toBe(TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH);
    expect(active.qualityReport.checks).toContainEqual(expect.objectContaining({
      code: 'EXERCISE_IDENTITY_CLOSURE',
      status: 'PASS',
    }));
    expect(activeExercises.length).toBeGreaterThan(0);
    expect(activeExercises.every((exercise) => exercise.exerciseId && exercise.name)).toBe(true);
  });

  it('keeps the tool contract legacy-compatible while off and requires stable IDs only while active', () => {
    expect(trainingExerciseToolJsonDescription({})).toBe(
      'JSON array: [{name, sets, reps, weight, rpe, rest_sec, tempo}]',
    );
    expect(trainingExerciseToolJsonDescription(activeEnv)).toMatch(/exerciseId must be a canonical active/i);
  });
});
