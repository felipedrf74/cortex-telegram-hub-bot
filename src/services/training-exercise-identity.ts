// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { logger } from '../utils/logger';
import { buildRepoTrainingCatalogSnapshot } from './coach-kernel/training-catalog';
import {
  buildTrainingExerciseIdentityLibrary,
  type ExerciseDefinition,
} from './coach-kernel/training-taxonomy';
import type { Exercise } from './coach-kernel/types';
import {
  getTrainingExerciseIdentityV1Mode,
  type RuntimeFlagScope,
  type TrainingExerciseIdentityV1Mode,
} from './runtime-flags';
import { getTrainingCapabilityMetadata } from './capability-manifest';

export const TRAINING_EXERCISE_IDENTITY_POLICY_VERSION = 'training-exercise-identity-policy.v1' as const;
export const TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION = getTrainingCapabilityMetadata().catalog.catalogVersion as 'training-exercise-identity-catalog.v1';

/**
 * Pin for the immutable v1 identity catalog. It is intentionally updated only
 * together with TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION after reviewed
 * catalog/alias changes. A mismatch fails closed only in active mode.
 */
export const TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH = '50ed5bdd523af02dcd36cd258f195d144e3a4ee86aaed8dcf057fe45532e0ed8' as const;

export type TrainingExerciseIdentityUsage = 'new_prescription' | 'historical_read';
export type TrainingExerciseIdentityMatch = 'id' | 'id_alias' | 'canonical_name' | 'reviewed_name_alias';
export type TrainingExerciseIdentitySource = 'repo_seed' | 'promoted_emergency' | 'resolved_template';

export interface TrainingExerciseIdentityCatalogEntry {
  exerciseId: string;
  canonicalName: string;
  source: TrainingExerciseIdentitySource;
  active: true;
}

export interface TrainingExerciseIdentityCatalogSnapshot {
  catalogVersion: typeof TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION;
  policyVersion: typeof TRAINING_EXERCISE_IDENTITY_POLICY_VERSION;
  baseCatalogVersion: string;
  baseCatalogSourceHash: string;
  sourceHash: string;
  entries: TrainingExerciseIdentityCatalogEntry[];
  promotedEmergencyIds: string[];
}

interface TrainingExerciseIdentityResolutionBase {
  policyVersion: typeof TRAINING_EXERCISE_IDENTITY_POLICY_VERSION;
  catalogVersion: typeof TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION;
  catalogSourceHash: string;
  rawExerciseId: string | null;
  rawName: string | null;
  newlyPrescribable: boolean;
  mediaEligible: boolean;
}

export type CanonicalTrainingExerciseIdentityResolution = TrainingExerciseIdentityResolutionBase & {
  kind: 'canonical';
  canonicalId: string;
  canonicalName: string;
  source: TrainingExerciseIdentitySource;
  matchedBy: TrainingExerciseIdentityMatch;
  prescriptionPatch?: { tempo: string };
  newlyPrescribable: true;
  mediaEligible: true;
};

export type AmbiguousTrainingExerciseIdentityResolution = TrainingExerciseIdentityResolutionBase & {
  kind: 'ambiguous';
  candidateIds: string[];
  reason: 'ambiguous_name' | 'id_name_mismatch';
  newlyPrescribable: false;
  mediaEligible: false;
};

export type UnknownTrainingExerciseIdentityResolution = TrainingExerciseIdentityResolutionBase & {
  kind: 'unknown';
  reason: 'missing_identity' | 'unknown_id' | 'unknown_name';
  newlyPrescribable: false;
  mediaEligible: false;
};

export type HistoricalTextTrainingExerciseIdentityResolution = TrainingExerciseIdentityResolutionBase & {
  kind: 'historical_text';
  displayText: string;
  newlyPrescribable: false;
  mediaEligible: false;
};

export type TrainingExerciseIdentityResolution =
  | CanonicalTrainingExerciseIdentityResolution
  | AmbiguousTrainingExerciseIdentityResolution
  | UnknownTrainingExerciseIdentityResolution
  | HistoricalTextTrainingExerciseIdentityResolution;

export interface ResolveTrainingExerciseIdentityInput {
  exerciseId?: unknown;
  name?: unknown;
  usage?: TrainingExerciseIdentityUsage;
}

export interface TrainingExerciseIdentityRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  scope?: RuntimeFlagScope;
  source?: string;
}

export const TRAINING_NON_CATALOG_INSTRUCTIONAL_TEXT_POLICY = Object.freeze({
  newlyPrescribable: false as const,
  mediaEligible: false as const,
});

export const JUMPING_LUNGE_EXERCISE: Readonly<Exercise> = Object.freeze({
  id: 'jumping_lunge',
  name: 'Jumping Lunge',
  movementPattern: 'single_leg',
  equipment: [],
  fatigueCost: 'high',
  substitutions: ['split_squat', 'walking_lunge'],
  complexity: 'intermediate',
  spinalLoading: 'low',
  unilateral: true,
  primaryPurpose: 'power',
  contraindicationFlags: ['high_impact', 'knee_pain'],
  warmupNeeds: ['hip_mobility', 'ankle_mobility'],
  progressionFamily: 'single_leg_power',
  progressionLevel: 3,
});

const JUMPING_LUNGE_DEFINITION = Object.freeze({
  id: JUMPING_LUNGE_EXERCISE.id,
  name: JUMPING_LUNGE_EXERCISE.name,
  equipment: ['bodyweight'],
  primaryMuscles: ['quads', 'glutes'],
  secondaryMuscles: ['hamstrings'],
  movementPattern: 'lunge_split_squat',
  difficulty: 'intermediate',
  axialLoad: 'low',
  jointStress: { knee: 'high', lowerBack: 'low' },
  suitableGoals: ['strength', 'hypertrophy', 'general_fitness'],
} satisfies ExerciseDefinition);

const REVIEWED_ID_ALIASES = Object.freeze({
  floor_press: 'dumbbell_floor_press',
} as const);

const REVIEWED_NAME_ALIASES = Object.freeze({
  'Band Face Pull': 'face_pull',
  'Band Lat Pulldown': 'band_pulldown',
  'Banded Row': 'band_row',
  'Barbell Row': 'barbell_bent_row',
  'DB Overhead Triceps Extension': 'dumbbell_triceps_extension',
  'DB Romanian Deadlift': 'romanian_deadlift',
  'Front Plank': 'plank',
  'One-Arm DB Row': 'one_arm_dumbbell_row',
  'Single-Leg RDL': 'single_leg_rdl',
  'Slider Hamstring Curl': 'slider_leg_curl',
  'Table Row': 'inverted_row',
  'Incline DB Press': 'incline_dumbbell_press',
} as const);

const REVIEWED_TEMPO_ALIASES = Object.freeze({
  'Tempo Air Squat': { exerciseId: 'bodyweight_squat', tempo: '3-1-1-0' },
  'Tempo Split Squat': { exerciseId: 'split_squat', tempo: '3-1-1-0' },
} as const);

const AMBIGUOUS_NAME_CANDIDATES = Object.freeze({
  'One-Arm Row': ['one_arm_dumbbell_row', 'one_arm_ring_row'],
  'Hip Thrust': ['hip_thrust', 'barbell_hip_thrust', 'dumbbell_hip_thrust'],
  'Leg Curl': ['seated_leg_curl', 'slider_leg_curl'],
  'Lateral Raise': ['dumbbell_lateral_raise', 'side_lying_y_raise'],
  'Pull-Up / Inverted Row': ['pull_up', 'inverted_row'],
  'Push-Up / DB Floor Press': ['push_up', 'dumbbell_floor_press'],
  'Push-Up / DB Press': ['push_up', 'dumbbell_bench_press'],
  'Lat Pulldown / Pull-Up': ['lat_pulldown', 'pull_up'],
  'Cable / Band Triceps Pressdown': ['cable_triceps_pressdown', 'close_grip_push_up'],
} as const);

let catalogCache: TrainingExerciseIdentityCatalogSnapshot | null = null;

export class TrainingExerciseIdentityError extends Error {
  constructor(
    public readonly code:
      | 'TRAINING_EXERCISE_IDENTITY_AMBIGUOUS'
      | 'TRAINING_EXERCISE_IDENTITY_UNKNOWN'
      | 'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID'
      | 'TRAINING_EXERCISE_IDENTITY_CATALOG_DRIFT',
    message: string,
  ) {
    super(message);
    this.name = 'TrainingExerciseIdentityError';
  }
}

export function buildTrainingExerciseIdentityCatalogSnapshot(): TrainingExerciseIdentityCatalogSnapshot {
  if (catalogCache) return cloneCatalogSnapshot(catalogCache);

  const baseCatalog = buildRepoTrainingCatalogSnapshot();
  const exerciseIdentityLibrary = buildTrainingExerciseIdentityLibrary();
  const repoIds = new Set(baseCatalog.exercises.filter((entry) => entry.active).map((entry) => entry.id));
  const libraryEntries = exerciseIdentityLibrary.map((definition) => ({
    exerciseId: canonicalizeStableId(definition.id),
    canonicalName: definition.name,
    source: repoIds.has(definition.id) ? 'repo_seed' as const : 'promoted_emergency' as const,
    active: true as const,
  }));
  const byId = new Map<string, TrainingExerciseIdentityCatalogEntry>();
  for (const entry of libraryEntries) {
    if (!byId.has(entry.exerciseId)) byId.set(entry.exerciseId, entry);
  }
  byId.set(JUMPING_LUNGE_DEFINITION.id, {
    exerciseId: JUMPING_LUNGE_DEFINITION.id,
    canonicalName: JUMPING_LUNGE_DEFINITION.name,
    source: 'resolved_template',
    active: true,
  });
  const entries = [...byId.values()].sort((left, right) => left.exerciseId.localeCompare(right.exerciseId));
  const promotedEmergencyIds = entries
    .filter((entry) => entry.source === 'promoted_emergency')
    .map((entry) => entry.exerciseId);
  const promotedDefinitions = exerciseIdentityLibrary
    .filter((definition) => !repoIds.has(definition.id))
    .map((definition) => ({ ...definition }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const hashInput = {
    catalogVersion: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
    policyVersion: TRAINING_EXERCISE_IDENTITY_POLICY_VERSION,
    baseCatalogVersion: baseCatalog.catalogVersion,
    baseCatalogSourceHash: baseCatalog.sourceHash,
    entries,
    promotedDefinitions,
    resolvedTemplateDefinitions: [JUMPING_LUNGE_DEFINITION],
    idAliases: REVIEWED_ID_ALIASES,
    nameAliases: REVIEWED_NAME_ALIASES,
    tempoAliases: REVIEWED_TEMPO_ALIASES,
    ambiguousNames: AMBIGUOUS_NAME_CANDIDATES,
    instructionalTextPolicy: TRAINING_NON_CATALOG_INSTRUCTIONAL_TEXT_POLICY,
  };
  catalogCache = {
    catalogVersion: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
    policyVersion: TRAINING_EXERCISE_IDENTITY_POLICY_VERSION,
    baseCatalogVersion: baseCatalog.catalogVersion,
    baseCatalogSourceHash: baseCatalog.sourceHash,
    sourceHash: createHash('sha256').update(stableStringify(hashInput)).digest('hex'),
    entries,
    promotedEmergencyIds,
  };
  return cloneCatalogSnapshot(catalogCache);
}

export function assertTrainingExerciseIdentityCatalogIntegrity(
  snapshot: TrainingExerciseIdentityCatalogSnapshot = buildTrainingExerciseIdentityCatalogSnapshot(),
  expectedSourceHash: string = TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
): void {
  const ids = new Set(snapshot.entries.map((entry) => entry.exerciseId));
  const structurallyInvalid = snapshot.entries.length !== 158
    || ids.size !== snapshot.entries.length
    || snapshot.promotedEmergencyIds.length !== 26
    || ids.has('floor_press')
    || !ids.has('dumbbell_floor_press')
    || !ids.has('jumping_lunge')
    || snapshot.catalogVersion !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION
    || snapshot.policyVersion !== TRAINING_EXERCISE_IDENTITY_POLICY_VERSION;
  if (structurallyInvalid || snapshot.sourceHash !== expectedSourceHash) {
    throw new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_CATALOG_DRIFT',
      'The authoritative Training exercise identity catalog changed without a reviewed version/hash update.',
    );
  }
}

export function resolveTrainingExerciseIdentity(
  input: ResolveTrainingExerciseIdentityInput,
): TrainingExerciseIdentityResolution {
  const catalog = buildTrainingExerciseIdentityCatalogSnapshot();
  const rawExerciseId = stringOrNull(input.exerciseId);
  const rawName = stringOrNull(input.name);
  const usage = input.usage ?? 'new_prescription';
  const base = resolutionBase(catalog, rawExerciseId, rawName);
  const byId = new Map(catalog.entries.map((entry) => [entry.exerciseId, entry]));
  const resolvedId = rawExerciseId
    ? byId.get(canonicalizeStableId(rawExerciseId)) ?? null
    : null;
  const nameResolution = resolveExactName(rawName, catalog, byId);

  if (rawExerciseId) {
    if (!resolvedId) {
      return usage === 'historical_read'
        ? historicalResolution(base, rawName ?? rawExerciseId)
        : unknownResolution(base, 'unknown_id');
    }
    if (nameResolution?.kind === 'canonical' && nameResolution.entry.exerciseId !== resolvedId.exerciseId) {
      return ambiguousResolution(base, 'id_name_mismatch', [resolvedId.exerciseId, nameResolution.entry.exerciseId]);
    }
    return canonicalResolution(
      base,
      resolvedId,
      Object.prototype.hasOwnProperty.call(REVIEWED_ID_ALIASES, rawExerciseId) ? 'id_alias' : 'id',
      nameResolution?.kind === 'canonical' ? nameResolution.prescriptionPatch : undefined,
    );
  }

  if (nameResolution?.kind === 'ambiguous') {
    return ambiguousResolution(base, 'ambiguous_name', nameResolution.candidateIds);
  }
  if (nameResolution?.kind === 'canonical') {
    return canonicalResolution(base, nameResolution.entry, nameResolution.matchedBy, nameResolution.prescriptionPatch);
  }
  if (usage === 'historical_read') return historicalResolution(base, rawName ?? '');
  return unknownResolution(base, rawName ? 'unknown_name' : 'missing_identity');
}

export function materializeCanonicalTrainingExercise<T extends Record<string, unknown>>(
  exercise: T,
  options: TrainingExerciseIdentityRuntimeOptions & { canonicalId?: string } = {},
): T | (T & { exerciseId: string; name: string; tempo?: string }) {
  const mode = identityMode(options);
  if (mode === 'off') return exercise;
  const resolution = resolveTrainingExerciseIdentity({
    exerciseId: options.canonicalId ?? exercise.exerciseId ?? exercise.exercise_id,
    name: exercise.name,
    usage: 'new_prescription',
  });
  if (mode === 'shadow') {
    observeShadowResolution(resolution, options.source);
    return exercise;
  }
  assertTrainingExerciseIdentityCatalogIntegrity();
  if (resolution.kind !== 'canonical') throw resolutionError(resolution);
  const normalized = {
    ...exercise,
    exerciseId: resolution.canonicalId,
    name: resolution.canonicalName,
    ...(resolution.prescriptionPatch ?? {}),
  } as T & { exerciseId: string; name: string; tempo?: string };
  delete (normalized as Record<string, unknown>).exercise_id;
  return normalized;
}

export function normalizeTrainingExerciseArrayForWrite(
  exercises: unknown,
  options: TrainingExerciseIdentityRuntimeOptions = {},
): unknown {
  const mode = identityMode(options);
  if (mode === 'off') return exercises;
  if (!Array.isArray(exercises)) {
    if (mode === 'shadow') {
      observeShadowFailure('invalid_payload', options.source);
      return exercises;
    }
    throw new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID',
      'Training exercises must be a JSON array.',
    );
  }
  if (exercises.length > 100) {
    if (mode === 'shadow') {
      observeShadowFailure('payload_too_large', options.source);
      return exercises;
    }
    throw new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID',
      'Training exercise payload exceeds the bounded exercise count.',
    );
  }
  if (mode === 'active') assertTrainingExerciseIdentityCatalogIntegrity();
  return exercises.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (mode === 'shadow') {
        observeShadowFailure('invalid_entry', options.source);
        return raw;
      }
      throw new TrainingExerciseIdentityError(
        'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID',
        'Every Training exercise must be an object.',
      );
    }
    return materializeCanonicalTrainingExercise(raw as Record<string, unknown>, options);
  });
}

export function normalizeTrainingExercisesJsonForWrite(
  raw: string | null | undefined,
  options: TrainingExerciseIdentityRuntimeOptions = {},
): string | null | undefined {
  const mode = identityMode(options);
  if (mode === 'off' || raw == null || raw.trim() === '') return raw;
  if (Buffer.byteLength(raw, 'utf8') > 100_000) {
    if (mode === 'shadow') {
      observeShadowFailure('payload_bytes_exceeded', options.source);
      return raw;
    }
    throw new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID',
      'Training exercise payload exceeds the bounded byte size.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (mode === 'shadow') {
      observeShadowFailure('invalid_json', options.source);
      return raw;
    }
    throw new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_PAYLOAD_INVALID',
      'Training exercises must contain valid JSON.',
    );
  }
  const normalized = normalizeTrainingExerciseArrayForWrite(parsed, options);
  return mode === 'active' ? JSON.stringify(normalized) : raw;
}

export function authoritativeTrainingExerciseLibrary(
  library: Exercise[],
  options: TrainingExerciseIdentityRuntimeOptions = {},
): Exercise[] {
  const mode = identityMode(options);
  if (mode !== 'active' || library.some((exercise) => exercise.id === JUMPING_LUNGE_EXERCISE.id)) return library;
  assertTrainingExerciseIdentityCatalogIntegrity();
  return [...library, { ...JUMPING_LUNGE_EXERCISE, substitutions: [...JUMPING_LUNGE_EXERCISE.substitutions] }];
}

export function trainingExerciseToolJsonDescription(env: NodeJS.ProcessEnv = process.env): string {
  if (getTrainingExerciseIdentityV1Mode(env) !== 'active') {
    return 'JSON array: [{name, sets, reps, weight, rpe, rest_sec, tempo}]';
  }
  return 'JSON array: [{exerciseId, name, sets, reps, weight, rpe, rest_sec, tempo}]. exerciseId must be a canonical active Training catalog ID; composite or free-text exercise names are rejected.';
}

function identityMode(options: TrainingExerciseIdentityRuntimeOptions): TrainingExerciseIdentityV1Mode {
  return getTrainingExerciseIdentityV1Mode(options.env ?? process.env, options.scope);
}

function resolveExactName(
  rawName: string | null,
  catalog: TrainingExerciseIdentityCatalogSnapshot,
  byId: Map<string, TrainingExerciseIdentityCatalogEntry>,
):
  | { kind: 'canonical'; entry: TrainingExerciseIdentityCatalogEntry; matchedBy: 'canonical_name' | 'reviewed_name_alias'; prescriptionPatch?: { tempo: string } }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | null {
  if (!rawName) return null;
  const normalized = normalizeExactName(rawName);
  const ambiguous = exactRecordLookup(AMBIGUOUS_NAME_CANDIDATES, normalized);
  if (ambiguous) return { kind: 'ambiguous', candidateIds: [...ambiguous] };
  const tempoAlias = exactRecordLookup(REVIEWED_TEMPO_ALIASES, normalized);
  if (tempoAlias) {
    const entry = byId.get(tempoAlias.exerciseId);
    return entry
      ? { kind: 'canonical', entry, matchedBy: 'reviewed_name_alias', prescriptionPatch: { tempo: tempoAlias.tempo } }
      : null;
  }
  const reviewedAliasId = exactRecordLookup(REVIEWED_NAME_ALIASES, normalized);
  if (reviewedAliasId) {
    const entry = byId.get(reviewedAliasId);
    return entry ? { kind: 'canonical', entry, matchedBy: 'reviewed_name_alias' } : null;
  }
  const matches = catalog.entries.filter((entry) => normalizeExactName(entry.canonicalName) === normalized);
  if (matches.length === 1) return { kind: 'canonical', entry: matches[0], matchedBy: 'canonical_name' };
  if (matches.length > 1) return { kind: 'ambiguous', candidateIds: matches.map((entry) => entry.exerciseId) };
  return null;
}

function exactRecordLookup<T>(record: Readonly<Record<string, T>>, normalized: string): T | null {
  for (const [rawKey, value] of Object.entries(record)) {
    if (normalizeExactName(rawKey) === normalized) return value;
  }
  return null;
}

function canonicalResolution(
  base: TrainingExerciseIdentityResolutionBase,
  entry: TrainingExerciseIdentityCatalogEntry,
  matchedBy: TrainingExerciseIdentityMatch,
  prescriptionPatch?: { tempo: string },
): CanonicalTrainingExerciseIdentityResolution {
  return {
    ...base,
    kind: 'canonical',
    canonicalId: entry.exerciseId,
    canonicalName: entry.canonicalName,
    source: entry.source,
    matchedBy,
    ...(prescriptionPatch ? { prescriptionPatch } : {}),
    newlyPrescribable: true,
    mediaEligible: true,
  };
}

function ambiguousResolution(
  base: TrainingExerciseIdentityResolutionBase,
  reason: AmbiguousTrainingExerciseIdentityResolution['reason'],
  candidateIds: string[],
): AmbiguousTrainingExerciseIdentityResolution {
  return {
    ...base,
    kind: 'ambiguous',
    reason,
    candidateIds: [...new Set(candidateIds)].sort(),
    newlyPrescribable: false,
    mediaEligible: false,
  };
}

function unknownResolution(
  base: TrainingExerciseIdentityResolutionBase,
  reason: UnknownTrainingExerciseIdentityResolution['reason'],
): UnknownTrainingExerciseIdentityResolution {
  return { ...base, kind: 'unknown', reason, newlyPrescribable: false, mediaEligible: false };
}

function historicalResolution(
  base: TrainingExerciseIdentityResolutionBase,
  displayText: string,
): HistoricalTextTrainingExerciseIdentityResolution {
  return { ...base, kind: 'historical_text', displayText, newlyPrescribable: false, mediaEligible: false };
}

function resolutionBase(
  catalog: TrainingExerciseIdentityCatalogSnapshot,
  rawExerciseId: string | null,
  rawName: string | null,
): TrainingExerciseIdentityResolutionBase {
  return {
    policyVersion: TRAINING_EXERCISE_IDENTITY_POLICY_VERSION,
    catalogVersion: catalog.catalogVersion,
    catalogSourceHash: catalog.sourceHash,
    rawExerciseId,
    rawName,
    newlyPrescribable: false,
    mediaEligible: false,
  };
}

function resolutionError(resolution: Exclude<TrainingExerciseIdentityResolution, CanonicalTrainingExerciseIdentityResolution>): TrainingExerciseIdentityError {
  if (resolution.kind === 'ambiguous') {
    return new TrainingExerciseIdentityError(
      'TRAINING_EXERCISE_IDENTITY_AMBIGUOUS',
      'Training exercise identity is ambiguous; select one canonical exercise ID.',
    );
  }
  return new TrainingExerciseIdentityError(
    'TRAINING_EXERCISE_IDENTITY_UNKNOWN',
    'Training exercise identity is not an active canonical exercise and cannot be newly prescribed.',
  );
}

function observeShadowResolution(resolution: TrainingExerciseIdentityResolution, source = 'unknown'): void {
  if (resolution.kind === 'canonical') return;
  logger.warn(
    { source, resolutionKind: resolution.kind, policyVersion: TRAINING_EXERCISE_IDENTITY_POLICY_VERSION },
    'training.exercise_identity.shadow_unresolved',
  );
}

function observeShadowFailure(reason: string, source = 'unknown'): void {
  logger.warn(
    { source, reason, policyVersion: TRAINING_EXERCISE_IDENTITY_POLICY_VERSION },
    'training.exercise_identity.shadow_payload_invalid',
  );
}

function canonicalizeStableId(value: string): string {
  const trimmed = value.trim();
  return (REVIEWED_ID_ALIASES as Readonly<Record<string, string>>)[trimmed] ?? trimmed;
}

function normalizeExactName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cloneCatalogSnapshot(snapshot: TrainingExerciseIdentityCatalogSnapshot): TrainingExerciseIdentityCatalogSnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    promotedEmergencyIds: [...snapshot.promotedEmergencyIds],
  };
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}
