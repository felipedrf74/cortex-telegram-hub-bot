// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { getDb } from '../database';
import {
  CANONICAL_EQUIPMENT_ITEMS,
  EQUIPMENT_VOCABULARY_VERSION,
  type EquipmentItem,
  type ExerciseEquipmentRequirement,
} from '../training-equipment-vocabulary';
import { loadCoachKnowledge } from './knowledge-loader';
import type { CoachKnowledgeBase, Exercise, ExerciseComplexity, FatigueCost, SpinalLoading } from './types';

export type CatalogFieldConfidence = 'curated' | 'inferred' | 'unknown';
export type TrainingCatalogSource = 'repo_seed' | 'coach_curated' | 'admin_added' | 'tenant_override' | 'imported';
export type TrainingCatalogStatus = 'draft' | 'staged' | 'active' | 'deprecated' | 'rolled_back';
export type CatalogValidationStatus = 'passed' | 'failed';

export type TrainingDataPresentationLevel = 'user_facing' | 'support_debug' | 'backend_internal';

export const GLOBAL_CATALOG_SCOPE = '__global__';
export const SELECTOR_POLICY_VERSION = 'selector-policy-v2';
export const GENERATION_PIPELINE_VERSION = 'training-generation-pipeline-v1';

export interface ExerciseCatalogEntry {
  id: string;
  canonicalName: string;
  displayNames: Record<string, string>;
  aliases: string[];
  modality:
    | 'strength'
    | 'mobility'
    | 'warmup'
    | 'cooldown'
    | 'prehab'
    | 'run'
    | 'bike'
    | 'swim'
    | 'cardio'
    | 'skill'
    | 'recovery';
  movementPattern:
    | 'squat'
    | 'hinge'
    | 'lunge'
    | 'step_up'
    | 'horizontal_push'
    | 'vertical_push'
    | 'horizontal_pull'
    | 'vertical_pull'
    | 'carry'
    | 'rotation'
    | 'anti_rotation'
    | 'anti_extension'
    | 'core_flexion'
    | 'core_lateral_flexion'
    | 'calf_ankle'
    | 'hip_abduction'
    | 'hip_adduction'
    | 'shoulder_stability'
    | 'scapular_control'
    | 'mobility'
    | 'locomotion'
    | 'conditioning'
    | 'breathing'
    | 'other';
  primaryMuscles: string[];
  secondaryMuscles: string[];
  jointActions: string[];
  planeOfMotion: 'sagittal' | 'frontal' | 'transverse' | 'multi';
  equipmentRequirements: ExerciseEquipmentRequirement;
  difficulty: 1 | 2 | 3 | 4 | 5;
  complexity: 1 | 2 | 3 | 4 | 5;
  fatigueCost: 1 | 2 | 3 | 4 | 5;
  spinalLoading: 'none' | 'low' | 'moderate' | 'high';
  impact: 'none' | 'low' | 'moderate' | 'high';
  unilateral: boolean;
  balanceDemand: 'low' | 'medium' | 'high';
  mobilityDemand: 'low' | 'medium' | 'high';
  contraindicationFlags: string[];
  cautionFlags: string[];
  regressionIds: string[];
  progressionIds: string[];
  substitutionIds: string[];
  warmupNeedTags: string[];
  progressionFamily?: string;
  progressionLevel?: number;
  progressionPrerequisites?: string[];
  defaultPrescription?: {
    sets?: number;
    reps?: string;
    durationSec?: number;
    distanceMeters?: number;
    restSec?: number;
    tempo?: string;
    rpeRange?: [number, number];
    rirRange?: [number, number];
  };
  compatibleSessionRoles: string[];
  metadataConfidence: {
    muscles: CatalogFieldConfidence;
    equipment: CatalogFieldConfidence;
    contraindications: CatalogFieldConfidence;
    progressions: CatalogFieldConfidence;
  };
  source: TrainingCatalogSource;
  active: boolean;
  catalogVersion: string;
  globalCanonicalId?: string;
  tenantOverrideScope?: string;
}

export interface TrainingCatalogSnapshot {
  catalogVersion: string;
  scopeKey: string;
  source: TrainingCatalogSource;
  sourceHash: string;
  sciencePolicyVersion: string;
  selectorPolicyVersion: string;
  equipmentVocabularyVersion: string;
  generationPipelineVersion: string;
  status: TrainingCatalogStatus;
  exercises: ExerciseCatalogEntry[];
  equipment: EquipmentItem[];
  loadedFrom: 'repo' | 'db';
}

export interface CatalogValidationIssue {
  code:
    | 'missing_required_field'
    | 'duplicate_exercise_id'
    | 'bad_equipment_id'
    | 'inactive_reference'
    | 'unknown_substitution_target'
    | 'unknown_progression_target'
    | 'circular_progression_chain'
    | 'invalid_contraindication_flag'
    | 'missing_movement_or_muscle_coverage'
    | 'tenant_override_safety_weakening';
  severity: 'error' | 'warning';
  exerciseId?: string;
  field?: string;
  message: string;
}

export interface CatalogValidationResult {
  status: CatalogValidationStatus;
  issues: CatalogValidationIssue[];
}

export interface TrainingCatalogSeedResult {
  snapshot: TrainingCatalogSnapshot;
  validation: CatalogValidationResult;
  inserted: boolean;
  activated: boolean;
}

const VALID_CONTRAINDICATION_FLAGS = new Set([
  'low_back',
  'wrist_mobility',
  'knee_pain',
  'achilles',
  'shoulder_impingement',
  'shoulder_pain',
  'elbow_pain',
  'ankle_pain',
  'hip_pain',
  'neck_pain',
  'pregnancy_postpartum',
  'high_impact',
]);

export function loadTrainingCatalogSnapshot(options: {
  tenantId?: number | null;
  scopeKey?: string;
} = {}): TrainingCatalogSnapshot {
  if (!config.coaching.trainingCatalogDbEnabled) {
    return buildRepoTrainingCatalogSnapshot();
  }

  const scopeKey = options.scopeKey ?? GLOBAL_CATALOG_SCOPE;
  try {
    const dbSnapshot = loadActiveDbCatalogSnapshot(scopeKey);
    if (dbSnapshot) return dbSnapshot;
  } catch (err) {
    logger.warn(
      { err, tenantId: options.tenantId ?? null, scopeKey },
      'training_catalog.load_active_db_catalog_failed; falling back to repo seed',
    );
  }
  return buildRepoTrainingCatalogSnapshot();
}

export function buildRepoTrainingCatalogSnapshot(
  knowledge: CoachKnowledgeBase = loadCoachKnowledge(),
): TrainingCatalogSnapshot {
  const sciencePolicyVersion = typeof knowledge.principles.sciencePolicyVersion === 'string'
    ? knowledge.principles.sciencePolicyVersion
    : 'unknown';
  const catalogVersion = `repo-seed-${sciencePolicyVersion}`;
  const sourceHash = hashStable({
    exercises: knowledge.exercises,
    sciencePolicyVersion,
    equipmentVocabularyVersion: EQUIPMENT_VOCABULARY_VERSION,
  });
  return {
    catalogVersion,
    scopeKey: GLOBAL_CATALOG_SCOPE,
    source: 'repo_seed',
    sourceHash,
    sciencePolicyVersion,
    selectorPolicyVersion: SELECTOR_POLICY_VERSION,
    equipmentVocabularyVersion: EQUIPMENT_VOCABULARY_VERSION,
    generationPipelineVersion: GENERATION_PIPELINE_VERSION,
    status: 'active',
    exercises: knowledge.exercises.map((exercise) => normalizeRepoExercise(exercise, catalogVersion)),
    equipment: CANONICAL_EQUIPMENT_ITEMS.map((item) => ({ ...item, aliases: [...item.aliases] })),
    loadedFrom: 'repo',
  };
}

export function validateTrainingCatalogSnapshot(snapshot: TrainingCatalogSnapshot): CatalogValidationResult {
  const issues: CatalogValidationIssue[] = [];
  const exerciseIds = new Set<string>();
  const byId = new Map(snapshot.exercises.map((entry) => [entry.id, entry]));
  const activeExerciseIds = new Set(snapshot.exercises.filter((entry) => entry.active).map((entry) => entry.id));
  const equipmentIds = new Set(snapshot.equipment.map((item) => item.id));

  for (const entry of snapshot.exercises) {
    if (!entry.id.trim()) {
      issues.push(issue('missing_required_field', entry.id, 'id', 'Exercise ID is required.'));
    }
    if (exerciseIds.has(entry.id)) {
      issues.push(issue('duplicate_exercise_id', entry.id, 'id', `Duplicate exercise ID "${entry.id}".`));
    }
    exerciseIds.add(entry.id);

    if (!entry.canonicalName.trim()) {
      issues.push(issue('missing_required_field', entry.id, 'canonicalName', 'Canonical exercise name is required.'));
    }
    if (!entry.movementPattern || entry.movementPattern === 'other') {
      issues.push(issue('missing_movement_or_muscle_coverage', entry.id, 'movementPattern', 'Movement pattern must be specific enough for selector coverage.'));
    }
    if (entry.primaryMuscles.length === 0 || entry.metadataConfidence.muscles === 'unknown') {
      issues.push(issue('missing_movement_or_muscle_coverage', entry.id, 'primaryMuscles', 'Primary muscles are required for catalog-backed strength selection.'));
    }

    const requiredEquipment = [
      ...(entry.equipmentRequirements.requiredAllOf ?? []),
      ...(entry.equipmentRequirements.requiredAnyOf ?? []).flat(),
      ...(entry.equipmentRequirements.optional ?? []),
      ...(entry.equipmentRequirements.forbidden ?? []),
    ];
    for (const equipmentId of requiredEquipment) {
      if (!equipmentIds.has(equipmentId)) {
        issues.push(issue('bad_equipment_id', entry.id, 'equipmentRequirements', `Unknown equipment ID "${equipmentId}".`));
      }
    }

    for (const target of entry.substitutionIds) {
      const targetEntry = byId.get(target);
      if (!targetEntry) {
        issues.push(issue('unknown_substitution_target', entry.id, 'substitutionIds', `Substitution target "${target}" does not exist.`));
      } else if (!activeExerciseIds.has(target)) {
        issues.push(issue('inactive_reference', entry.id, 'substitutionIds', `Substitution target "${target}" is not active.`));
      }
    }
    for (const target of entry.progressionIds) {
      const targetEntry = byId.get(target);
      if (!targetEntry) {
        issues.push(issue('unknown_progression_target', entry.id, 'progressionIds', `Progression target "${target}" does not exist.`));
      } else if (!activeExerciseIds.has(target)) {
        issues.push(issue('inactive_reference', entry.id, 'progressionIds', `Progression target "${target}" is not active.`));
      }
    }
    for (const flag of entry.contraindicationFlags) {
      if (!VALID_CONTRAINDICATION_FLAGS.has(flag)) {
        issues.push(issue('invalid_contraindication_flag', entry.id, 'contraindicationFlags', `Contraindication flag "${flag}" is not in the canonical safety vocabulary.`));
      }
    }
    if (entry.source === 'tenant_override') {
      const globalCanonicalId = entry.globalCanonicalId;
      const global = globalCanonicalId ? byId.get(globalCanonicalId) : undefined;
      if (!globalCanonicalId || !global || !global.active || global.source === 'tenant_override') {
        issues.push(issue('inactive_reference', entry.id, 'globalCanonicalId', 'Tenant overrides must reference an active global canonical exercise.'));
      } else {
        const removedContraindications = global.contraindicationFlags.filter((flag) => !entry.contraindicationFlags.includes(flag));
        const removedCautions = global.cautionFlags.filter((flag) => !entry.cautionFlags.includes(flag));
        if (removedContraindications.length > 0 || removedCautions.length > 0) {
          issues.push(issue(
            'tenant_override_safety_weakening',
            entry.id,
            'contraindicationFlags',
            `Tenant override cannot remove safety flags from ${globalCanonicalId}: ${[...removedContraindications, ...removedCautions].join(', ')}.`,
          ));
        }
      }
    }
  }

  issues.push(...findCircularProgressions(snapshot.exercises));

  return {
    status: issues.some((item) => item.severity === 'error') ? 'failed' : 'passed',
    issues,
  };
}

export function assertCatalogPromotable(snapshot: TrainingCatalogSnapshot): CatalogValidationResult {
  const result = validateTrainingCatalogSnapshot(snapshot);
  if (result.status === 'failed') return result;
  return {
    status: 'passed',
    issues: result.issues,
  };
}

export function seedRepoTrainingCatalogVersion(options: {
  scopeKey?: string;
  catalogVersion?: string;
  createdBy?: string;
  activate?: boolean;
} = {}): TrainingCatalogSeedResult {
  const baseSnapshot = buildRepoTrainingCatalogSnapshot();
  const scopeKey = options.scopeKey ?? GLOBAL_CATALOG_SCOPE;
  const catalogVersion = options.catalogVersion ?? baseSnapshot.catalogVersion;
  const snapshot: TrainingCatalogSnapshot = {
    ...baseSnapshot,
    catalogVersion,
    scopeKey,
    exercises: baseSnapshot.exercises.map((entry) => ({
      ...entry,
      catalogVersion,
      tenantOverrideScope: entry.tenantOverrideScope ?? GLOBAL_CATALOG_SCOPE,
    })),
  };
  const validation = assertCatalogPromotable(snapshot);
  if (validation.status === 'failed') {
    return { snapshot, validation, inserted: false, activated: false };
  }

  const db = getDb();
  const existing = db.prepare(`
    SELECT status
      FROM training_catalog_versions
     WHERE scope_key = ?
       AND catalog_version = ?
     LIMIT 1
  `).get(scopeKey, catalogVersion) as { status: TrainingCatalogStatus } | undefined;

  if (existing) {
    const activated = options.activate === true
      ? activateTrainingCatalogVersion({ scopeKey, catalogVersion }).validation.status === 'passed'
      : existing.status === 'active';
    return { snapshot, validation, inserted: false, activated };
  }

  const inserted = db.transaction(() => {
    if (options.activate === true) {
      deprecateActiveCatalogVersion(scopeKey);
    }
    insertCatalogVersion(snapshot, {
      status: options.activate === true ? 'active' : 'staged',
      validation,
      createdBy: options.createdBy,
      activated: options.activate === true,
    });
    insertCatalogEquipment(snapshot);
    insertCatalogExercises(snapshot);
    insertCatalogValidationResult(snapshot, validation, 'repo_seed_validation');
    return true;
  })();

  return {
    snapshot,
    validation,
    inserted,
    activated: options.activate === true,
  };
}

export function activateTrainingCatalogVersion(input: {
  scopeKey?: string;
  catalogVersion: string;
}): { snapshot: TrainingCatalogSnapshot | null; validation: CatalogValidationResult } {
  const scopeKey = input.scopeKey ?? GLOBAL_CATALOG_SCOPE;
  const snapshot = loadDbCatalogSnapshotByVersion(scopeKey, input.catalogVersion);
  if (!snapshot) {
    return {
      snapshot: null,
      validation: {
        status: 'failed',
        issues: [issue('inactive_reference', input.catalogVersion, 'catalogVersion', 'Catalog version does not exist.')],
      },
    };
  }
  const validation = assertCatalogPromotable(snapshot);
  if (validation.status === 'failed') {
    insertCatalogValidationResult(snapshot, validation, 'activation_validation');
    return { snapshot, validation };
  }

  const db = getDb();
  db.transaction(() => {
    deprecateActiveCatalogVersion(scopeKey);
    db.prepare(`
      UPDATE training_catalog_versions
         SET status = 'active',
             validation_status = 'passed',
             validation_results_json = ?,
             immutable_after_activation = 1,
             activated_at = COALESCE(activated_at, datetime('now'))
       WHERE scope_key = ?
         AND catalog_version = ?
    `).run(JSON.stringify(validation), scopeKey, input.catalogVersion);
    insertCatalogValidationResult(snapshot, validation, 'activation_validation');
  })();
  return { snapshot, validation };
}

function loadActiveDbCatalogSnapshot(scopeKey: string): TrainingCatalogSnapshot | null {
  const db = getDb();
  const version = db.prepare(`
    SELECT *
      FROM training_catalog_versions
     WHERE scope_key = ?
       AND status = 'active'
       AND validation_status = 'passed'
     ORDER BY activated_at DESC, catalog_version DESC
     LIMIT 1
  `).get(scopeKey) as any | undefined;
  if (!version) return null;

  return loadDbCatalogSnapshotFromVersionRow(version);
}

function loadDbCatalogSnapshotByVersion(scopeKey: string, catalogVersion: string): TrainingCatalogSnapshot | null {
  const db = getDb();
  const version = db.prepare(`
    SELECT *
      FROM training_catalog_versions
     WHERE scope_key = ?
       AND catalog_version = ?
     LIMIT 1
  `).get(scopeKey, catalogVersion) as any | undefined;
  if (!version) return null;
  return loadDbCatalogSnapshotFromVersionRow(version, { validateRuntime: false });
}

function loadDbCatalogSnapshotFromVersionRow(
  version: any,
  options: { validateRuntime?: boolean } = {},
): TrainingCatalogSnapshot | null {
  const db = getDb();
  const equipmentRows = db.prepare(`
    SELECT equipment_id, canonical_name, aliases_json, category
      FROM training_equipment_catalog_items
     WHERE catalog_version = ?
       AND scope_key = ?
       AND active = 1
     ORDER BY equipment_id ASC
  `).all(version.catalog_version, version.scope_key) as any[];

  const exerciseRows = db.prepare(`
    SELECT *
      FROM training_exercise_catalog_items
     WHERE catalog_version = ?
       AND scope_key = ?
       AND active = 1
       AND validation_status = 'validated'
     ORDER BY exercise_id ASC
  `).all(version.catalog_version, version.scope_key) as any[];

  const snapshot: TrainingCatalogSnapshot = {
    catalogVersion: version.catalog_version,
    scopeKey: version.scope_key,
    source: version.source_type,
    sourceHash: version.source_hash,
    sciencePolicyVersion: version.science_policy_version,
    selectorPolicyVersion: version.selector_policy_version,
    equipmentVocabularyVersion: version.equipment_vocabulary_version,
    generationPipelineVersion: version.generation_pipeline_version,
    status: version.status,
    equipment: equipmentRows.map((row) => ({
      id: row.equipment_id,
      canonicalName: row.canonical_name,
      aliases: parseJsonArray(row.aliases_json),
      category: row.category,
    })),
    exercises: exerciseRows.map(dbRowToExerciseCatalogEntry),
    loadedFrom: 'db',
  };
  if (options.validateRuntime !== false) {
    const validation = validateTrainingCatalogSnapshot(snapshot);
    if (validation.status === 'failed') {
      logger.warn(
        { catalogVersion: snapshot.catalogVersion, issues: validation.issues.slice(0, 5) },
        'training_catalog.active_db_catalog_failed_runtime_validation; falling back to repo seed',
      );
      return null;
    }
  }
  return snapshot;
}

function deprecateActiveCatalogVersion(scopeKey: string): void {
  getDb().prepare(`
    UPDATE training_catalog_versions
       SET status = 'deprecated',
           deprecated_at = COALESCE(deprecated_at, datetime('now'))
     WHERE scope_key = ?
       AND status = 'active'
  `).run(scopeKey);
}

function insertCatalogVersion(
  snapshot: TrainingCatalogSnapshot,
  options: {
    status: TrainingCatalogStatus;
    validation: CatalogValidationResult;
    createdBy?: string;
    activated: boolean;
  },
): void {
  getDb().prepare(`
    INSERT INTO training_catalog_versions (
      catalog_version,
      scope_key,
      status,
      source_type,
      source_hash,
      science_policy_version,
      selector_policy_version,
      equipment_vocabulary_version,
      generation_pipeline_version,
      validation_status,
      validation_results_json,
      immutable_after_activation,
      created_by,
      activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.catalogVersion,
    snapshot.scopeKey,
    options.status,
    snapshot.source,
    snapshot.sourceHash,
    snapshot.sciencePolicyVersion,
    snapshot.selectorPolicyVersion,
    snapshot.equipmentVocabularyVersion,
    snapshot.generationPipelineVersion,
    options.validation.status,
    JSON.stringify(options.validation),
    options.activated ? 1 : 0,
    options.createdBy ?? null,
    options.activated ? new Date().toISOString() : null,
  );
}

function insertCatalogEquipment(snapshot: TrainingCatalogSnapshot): void {
  const stmt = getDb().prepare(`
    INSERT INTO training_equipment_catalog_items (
      catalog_version,
      scope_key,
      equipment_id,
      canonical_name,
      aliases_json,
      category,
      metadata_confidence,
      source,
      active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of snapshot.equipment) {
    stmt.run(
      snapshot.catalogVersion,
      snapshot.scopeKey,
      item.id,
      item.canonicalName,
      JSON.stringify(item.aliases),
      item.category,
      'curated',
      snapshot.source,
      1,
    );
  }
}

function insertCatalogExercises(snapshot: TrainingCatalogSnapshot): void {
  const stmt = getDb().prepare(`
    INSERT INTO training_exercise_catalog_items (
      catalog_version,
      scope_key,
      exercise_id,
      canonical_name,
      display_names_json,
      aliases_json,
      modality,
      movement_pattern,
      primary_muscles_json,
      secondary_muscles_json,
      joint_actions_json,
      plane_of_motion,
      equipment_requirements_json,
      difficulty,
      complexity,
      fatigue_cost,
      spinal_loading,
      impact,
      unilateral,
      balance_demand,
      mobility_demand,
      contraindication_flags_json,
      caution_flags_json,
      regression_ids_json,
      progression_ids_json,
      substitution_ids_json,
      warmup_need_tags_json,
      progression_family,
      progression_level,
      progression_prerequisites_json,
      default_prescription_json,
      compatible_session_roles_json,
      metadata_confidence_json,
      source,
      active,
      global_canonical_id,
      tenant_override_scope,
      validation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const entry of snapshot.exercises) {
    stmt.run(
      snapshot.catalogVersion,
      snapshot.scopeKey,
      entry.id,
      entry.canonicalName,
      JSON.stringify(entry.displayNames),
      JSON.stringify(entry.aliases),
      entry.modality,
      entry.movementPattern,
      JSON.stringify(entry.primaryMuscles),
      JSON.stringify(entry.secondaryMuscles),
      JSON.stringify(entry.jointActions),
      entry.planeOfMotion,
      JSON.stringify(entry.equipmentRequirements),
      entry.difficulty,
      entry.complexity,
      entry.fatigueCost,
      entry.spinalLoading,
      entry.impact,
      entry.unilateral ? 1 : 0,
      entry.balanceDemand,
      entry.mobilityDemand,
      JSON.stringify(entry.contraindicationFlags),
      JSON.stringify(entry.cautionFlags),
      JSON.stringify(entry.regressionIds),
      JSON.stringify(entry.progressionIds),
      JSON.stringify(entry.substitutionIds),
      JSON.stringify(entry.warmupNeedTags),
      entry.progressionFamily ?? null,
      entry.progressionLevel ?? null,
      JSON.stringify(entry.progressionPrerequisites ?? []),
      entry.defaultPrescription ? JSON.stringify(entry.defaultPrescription) : null,
      JSON.stringify(entry.compatibleSessionRoles),
      JSON.stringify(entry.metadataConfidence),
      entry.source,
      entry.active ? 1 : 0,
      entry.globalCanonicalId ?? null,
      entry.tenantOverrideScope ?? GLOBAL_CATALOG_SCOPE,
      'validated',
    );
  }
}

function insertCatalogValidationResult(
  snapshot: TrainingCatalogSnapshot,
  validation: CatalogValidationResult,
  validator: string,
): void {
  getDb().prepare(`
    INSERT INTO training_catalog_validation_results (
      catalog_version,
      scope_key,
      validator,
      status,
      issues_json
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    snapshot.catalogVersion,
    snapshot.scopeKey,
    validator,
    validation.status,
    JSON.stringify(validation.issues),
  );
}

function dbRowToExerciseCatalogEntry(row: any): ExerciseCatalogEntry {
  return {
    id: row.exercise_id,
    canonicalName: row.canonical_name,
    displayNames: parseJsonObject(row.display_names_json),
    aliases: parseJsonArray(row.aliases_json),
    modality: row.modality,
    movementPattern: row.movement_pattern,
    primaryMuscles: parseJsonArray(row.primary_muscles_json),
    secondaryMuscles: parseJsonArray(row.secondary_muscles_json),
    jointActions: parseJsonArray(row.joint_actions_json),
    planeOfMotion: row.plane_of_motion,
    equipmentRequirements: parseJsonObject(row.equipment_requirements_json) as ExerciseEquipmentRequirement,
    difficulty: row.difficulty,
    complexity: row.complexity,
    fatigueCost: row.fatigue_cost,
    spinalLoading: row.spinal_loading,
    impact: row.impact,
    unilateral: row.unilateral === 1,
    balanceDemand: row.balance_demand,
    mobilityDemand: row.mobility_demand,
    contraindicationFlags: parseJsonArray(row.contraindication_flags_json),
    cautionFlags: parseJsonArray(row.caution_flags_json),
    regressionIds: parseJsonArray(row.regression_ids_json),
    progressionIds: parseJsonArray(row.progression_ids_json),
    substitutionIds: parseJsonArray(row.substitution_ids_json),
    warmupNeedTags: parseJsonArray(row.warmup_need_tags_json),
    progressionFamily: row.progression_family ?? undefined,
    progressionLevel: row.progression_level ?? undefined,
    progressionPrerequisites: parseJsonArray(row.progression_prerequisites_json),
    defaultPrescription: row.default_prescription_json ? parseJsonObject(row.default_prescription_json) : undefined,
    compatibleSessionRoles: parseJsonArray(row.compatible_session_roles_json),
    metadataConfidence: parseJsonObject(row.metadata_confidence_json) as ExerciseCatalogEntry['metadataConfidence'],
    source: row.source,
    active: row.active === 1,
    catalogVersion: row.catalog_version,
    globalCanonicalId: row.global_canonical_id ?? undefined,
    tenantOverrideScope: row.tenant_override_scope ?? undefined,
  };
}

function normalizeRepoExercise(exercise: Exercise, catalogVersion: string): ExerciseCatalogEntry {
  const mappedPattern = mapMovementPattern(exercise);
  return {
    id: exercise.id,
    canonicalName: exercise.name,
    displayNames: { en: exercise.name },
    aliases: [],
    modality: mappedPattern === 'mobility' ? 'mobility' : 'strength',
    movementPattern: mappedPattern,
    primaryMuscles: inferPrimaryMuscles(exercise),
    secondaryMuscles: inferSecondaryMuscles(exercise),
    jointActions: inferJointActions(exercise),
    planeOfMotion: inferPlaneOfMotion(exercise),
    equipmentRequirements: {
      requiredAllOf: [...(exercise.equipment ?? [])],
      requiredAnyOf: [],
      optional: [],
    },
    difficulty: complexityToNumber(exercise.complexity),
    complexity: complexityToNumber(exercise.complexity),
    fatigueCost: fatigueToNumber(exercise.fatigueCost),
    spinalLoading: mapSpinalLoading(exercise.spinalLoading),
    impact: inferImpact(exercise),
    unilateral: exercise.unilateral === true,
    balanceDemand: exercise.unilateral ? 'medium' : 'low',
    mobilityDemand: (exercise.warmupNeeds ?? []).some((need) => need.includes('mobility')) ? 'medium' : 'low',
    contraindicationFlags: [...(exercise.contraindicationFlags ?? [])],
    cautionFlags: [],
    regressionIds: [...(exercise.substitutions ?? [])],
    progressionIds: [],
    substitutionIds: [...(exercise.substitutions ?? [])],
    warmupNeedTags: [...(exercise.warmupNeeds ?? [])],
    progressionFamily: exercise.progressionFamily,
    progressionLevel: exercise.progressionLevel,
    progressionPrerequisites: (exercise.progressionPrerequisites ?? []).map((item) => `${item.exerciseId}:${item.criterion}`),
    compatibleSessionRoles: ['strength_hypertrophy', 'strength_max', 'strength_maintenance'],
    metadataConfidence: {
      muscles: 'inferred',
      equipment: 'curated',
      contraindications: (exercise.contraindicationFlags ?? []).length > 0 ? 'curated' : 'unknown',
      progressions: exercise.progressionFamily ? 'curated' : 'unknown',
    },
    source: 'repo_seed',
    active: true,
    catalogVersion,
  };
}

function mapMovementPattern(exercise: Exercise): ExerciseCatalogEntry['movementPattern'] {
  switch (exercise.movementPattern) {
    case 'squat':
      return 'squat';
    case 'hinge':
      return 'hinge';
    case 'push':
      return /overhead|pike|vertical/i.test(exercise.name) ? 'vertical_push' : 'horizontal_push';
    case 'pull':
      return /pull[-\s]?up|pulldown|vertical/i.test(exercise.name) ? 'vertical_pull' : 'horizontal_pull';
    case 'single_leg':
      return /step/i.test(exercise.name) ? 'step_up' : 'lunge';
    case 'core':
      return /pallof|anti/i.test(exercise.name) ? 'anti_rotation' : 'anti_extension';
    case 'carry':
      return 'carry';
    case 'mobility':
      return 'mobility';
    default:
      return 'other';
  }
}

function inferPrimaryMuscles(exercise: Exercise): string[] {
  switch (exercise.movementPattern) {
    case 'squat':
    case 'single_leg':
      return ['quadriceps', 'glutes'];
    case 'hinge':
      return ['hamstrings', 'glutes'];
    case 'push':
      return /overhead|pike/i.test(exercise.name) ? ['shoulders', 'triceps'] : ['chest', 'triceps'];
    case 'pull':
      return ['lats', 'upper_back'];
    case 'core':
      return ['abdominals'];
    case 'carry':
      return ['grip', 'traps', 'core'];
    case 'mobility':
      return ['mobility'];
    default:
      return ['general'];
  }
}

function inferSecondaryMuscles(exercise: Exercise): string[] {
  switch (exercise.movementPattern) {
    case 'squat':
    case 'hinge':
    case 'single_leg':
      return ['core'];
    case 'push':
      return ['shoulders'];
    case 'pull':
      return ['biceps'];
    default:
      return [];
  }
}

function inferJointActions(exercise: Exercise): string[] {
  switch (exercise.movementPattern) {
    case 'squat':
    case 'single_leg':
      return ['knee_extension', 'hip_extension'];
    case 'hinge':
      return ['hip_extension'];
    case 'push':
      return ['shoulder_flexion_or_horizontal_adduction', 'elbow_extension'];
    case 'pull':
      return ['shoulder_extension_or_adduction', 'elbow_flexion'];
    case 'core':
      return ['trunk_stability'];
    case 'carry':
      return ['loaded_gait'];
    case 'mobility':
      return ['mobility'];
    default:
      return ['general'];
  }
}

function inferPlaneOfMotion(exercise: Exercise): ExerciseCatalogEntry['planeOfMotion'] {
  if (exercise.movementPattern === 'core' || exercise.movementPattern === 'carry') return 'multi';
  if (/lateral|cossack|side/i.test(exercise.name)) return 'frontal';
  if (/rotation|pallof/i.test(exercise.name)) return 'transverse';
  return 'sagittal';
}

function complexityToNumber(complexity?: ExerciseComplexity): 1 | 2 | 3 | 4 | 5 {
  switch (complexity) {
    case 'beginner':
      return 1;
    case 'intermediate':
      return 3;
    case 'advanced':
      return 4;
    case 'expert':
      return 5;
    default:
      return 2;
  }
}

function fatigueToNumber(fatigue: FatigueCost): 1 | 2 | 3 | 4 | 5 {
  switch (fatigue) {
    case 'low':
      return 1;
    case 'medium':
      return 3;
    case 'high':
      return 4;
    case 'very_high':
      return 5;
    default:
      return 3;
  }
}

function mapSpinalLoading(value?: SpinalLoading): ExerciseCatalogEntry['spinalLoading'] {
  if (value === 'low' || value === 'moderate' || value === 'high') return value;
  return 'none';
}

function inferImpact(exercise: Exercise): ExerciseCatalogEntry['impact'] {
  if (/jump|plyo|bound|hop/i.test(exercise.name)) return 'high';
  if (exercise.primaryPurpose === 'power') return 'moderate';
  return 'none';
}

function findCircularProgressions(exercises: ExerciseCatalogEntry[]): CatalogValidationIssue[] {
  const byId = new Map(exercises.map((entry) => [entry.id, entry]));
  const issues: CatalogValidationIssue[] = [];
  for (const entry of exercises) {
    const stack = new Set<string>();
    const visit = (id: string): boolean => {
      if (stack.has(id)) return true;
      const current = byId.get(id);
      if (!current) return false;
      stack.add(id);
      for (const next of current.progressionIds) {
        if (visit(next)) return true;
      }
      stack.delete(id);
      return false;
    };
    if (visit(entry.id)) {
      issues.push(issue('circular_progression_chain', entry.id, 'progressionIds', 'Progression chain contains a cycle.'));
    }
  }
  return issues;
}

function issue(
  code: CatalogValidationIssue['code'],
  exerciseId: string | undefined,
  field: string,
  message: string,
): CatalogValidationIssue {
  return { code, severity: 'error', exerciseId, field, message };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}
