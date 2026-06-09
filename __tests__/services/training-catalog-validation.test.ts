import { describe, expect, it } from 'vitest';

import {
  buildRepoTrainingCatalogSnapshot,
  validateTrainingCatalogSnapshot,
  type ExerciseCatalogEntry,
  type TrainingCatalogSnapshot,
} from '../../src/services/coach-kernel/training-catalog';

function cloneSnapshot(): TrainingCatalogSnapshot {
  return JSON.parse(JSON.stringify(buildRepoTrainingCatalogSnapshot())) as TrainingCatalogSnapshot;
}

function firstExercise(snapshot: TrainingCatalogSnapshot): ExerciseCatalogEntry {
  const entry = snapshot.exercises[0];
  if (!entry) throw new Error('repo snapshot has no exercises');
  return entry;
}

describe('training catalog validation', () => {
  it('repo seed snapshot validates with explicit versions and source hash', () => {
    const snapshot = buildRepoTrainingCatalogSnapshot();
    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('passed');
    expect(snapshot.catalogVersion).toMatch(/^repo-seed-/);
    expect(snapshot.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sciencePolicyVersion).toBeTruthy();
    expect(snapshot.selectorPolicyVersion).toBe('selector-policy-v2');
    expect(snapshot.equipmentVocabularyVersion).toBeTruthy();
    expect(snapshot.generationPipelineVersion).toBeTruthy();
  });

  it('blocks duplicate exercise IDs', () => {
    const snapshot = cloneSnapshot();
    snapshot.exercises.push({ ...firstExercise(snapshot) });

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_exercise_id',
    }));
  });

  it('blocks unknown equipment IDs', () => {
    const snapshot = cloneSnapshot();
    snapshot.exercises[0] = {
      ...firstExercise(snapshot),
      equipmentRequirements: { requiredAllOf: ['imaginary_machine'] },
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'bad_equipment_id',
      field: 'equipmentRequirements',
    }));
  });

  it('blocks missing movement or muscle coverage', () => {
    const snapshot = cloneSnapshot();
    snapshot.exercises[0] = {
      ...firstExercise(snapshot),
      primaryMuscles: [],
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'missing_movement_or_muscle_coverage',
      field: 'primaryMuscles',
    }));
  });

  it('blocks unknown substitution targets', () => {
    const snapshot = cloneSnapshot();
    snapshot.exercises[0] = {
      ...firstExercise(snapshot),
      substitutionIds: ['missing_substitution'],
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'unknown_substitution_target',
    }));
  });

  it('blocks inactive substitution targets', () => {
    const snapshot = cloneSnapshot();
    const source = firstExercise(snapshot);
    const target = snapshot.exercises.find((entry) => entry.id !== source.id);
    if (!target) throw new Error('repo snapshot needs at least two exercises');
    snapshot.exercises[0] = {
      ...source,
      substitutionIds: [target.id],
    };
    snapshot.exercises[snapshot.exercises.findIndex((entry) => entry.id === target.id)] = {
      ...target,
      active: false,
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'inactive_reference',
      field: 'substitutionIds',
    }));
  });

  it('blocks circular progression chains', () => {
    const snapshot = cloneSnapshot();
    const a = firstExercise(snapshot);
    const b = snapshot.exercises.find((entry) => entry.id !== a.id);
    if (!b) throw new Error('repo snapshot needs at least two exercises');
    snapshot.exercises[0] = { ...a, progressionIds: [b.id] };
    snapshot.exercises[snapshot.exercises.findIndex((entry) => entry.id === b.id)] = {
      ...b,
      progressionIds: [a.id],
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'circular_progression_chain',
    }));
  });

  it('blocks invalid contraindication flags', () => {
    const snapshot = cloneSnapshot();
    snapshot.exercises[0] = {
      ...firstExercise(snapshot),
      contraindicationFlags: ['made_up_pain_flag'],
    };

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_contraindication_flag',
    }));
  });

  it('blocks tenant overrides that weaken global safety flags', () => {
    const snapshot = cloneSnapshot();
    const global = {
      ...firstExercise(snapshot),
      contraindicationFlags: ['low_back'],
      cautionFlags: ['wrist_mobility'],
    };
    snapshot.exercises[0] = global;
    snapshot.exercises.push({
      ...global,
      id: `${global.id}_tenant_override`,
      source: 'tenant_override',
      globalCanonicalId: global.id,
      tenantOverrideScope: 'tenant-123',
      contraindicationFlags: [],
      cautionFlags: [],
    });

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'tenant_override_safety_weakening',
    }));
  });

  it('blocks tenant overrides that reference inactive global exercises', () => {
    const snapshot = cloneSnapshot();
    const global = {
      ...firstExercise(snapshot),
      active: false,
    };
    snapshot.exercises[0] = global;
    snapshot.exercises.push({
      ...global,
      id: `${global.id}_tenant_override`,
      active: true,
      source: 'tenant_override',
      globalCanonicalId: global.id,
      tenantOverrideScope: 'tenant-123',
    });

    const result = validateTrainingCatalogSnapshot(snapshot);

    expect(result.status).toBe('failed');
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'inactive_reference',
      field: 'globalCanonicalId',
    }));
  });
});
