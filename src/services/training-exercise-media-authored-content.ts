// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  sha256TrainingExerciseMedia,
  type TrainingExerciseMediaLocale,
} from './training-exercise-media-manifest';

export const TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION =
  'training-exercise-media-authored-content-manifest.v1' as const;
export const TRAINING_EXERCISE_MEDIA_INSTRUCTION_CONTENT_SCHEMA_VERSION =
  'training-exercise-media-instruction-content.v1' as const;
export const TRAINING_EXERCISE_MEDIA_ACCESSIBILITY_CONTENT_SCHEMA_VERSION =
  'training-exercise-media-accessibility-content.v1' as const;
export const TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS =
  'AUTHORING_COMPLETE_UNAPPROVED' as const;
export const TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_INSTRUCTIONS = 158 * 3;
export const TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_ACCESSIBILITY = 200 * 3;

export type TrainingExerciseMediaCandidateRole = 'primary' | 'supplemental';

export interface TrainingExerciseMediaAuthoredContentManifest {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION;
  status: 'DRAFT_AWAITING_FINAL_CONTENT' | 'AUTHORING_COMPLETE_UNAPPROVED';
  catalogVersion: string;
  catalogSourceHash: string;
  eligibilityManifestSha256: string;
  artifactIndexSha256: string;
  requiredLocales: TrainingExerciseMediaLocale[];
  expectedExerciseCount: number;
  expectedAssetMappingCount: number;
  contentCreatedAt: string | null;
  instructionChunks: string[];
  accessibilityChunks: string[];
}

export interface TrainingExerciseMediaAuthoredInstruction {
  exerciseId: string;
  locale: TrainingExerciseMediaLocale;
  displayName: string;
  steps: string[];
  cues: string[];
  cautions: string[];
  textFallback: string;
  authoringStatus: typeof TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS;
  contentHash: string;
}

export interface TrainingExerciseMediaAuthoredAccessibility {
  exerciseId: string;
  role: TrainingExerciseMediaCandidateRole;
  ordinal: number;
  locale: TrainingExerciseMediaLocale;
  caption: string | null;
  accessibilityDescription: string;
  authoringStatus: typeof TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS;
  contentHash: string;
}

export interface TrainingExerciseMediaAuthoredContent {
  manifest: TrainingExerciseMediaAuthoredContentManifest;
  instructions: TrainingExerciseMediaAuthoredInstruction[];
  accessibility: TrainingExerciseMediaAuthoredAccessibility[];
}

export interface TrainingExerciseMediaExpectedAssetMapping {
  exerciseId: string;
  role: TrainingExerciseMediaCandidateRole;
  ordinal: number;
}

export interface TrainingExerciseMediaAuthoredContentValidation {
  valid: boolean;
  errors: string[];
  authoredContentPackageHash: string;
  counts: {
    expectedExercises: number;
    instructionRecords: number;
    accessibilityRecords: number;
    instructionExerciseCoverage: number;
    accessibilityAssetCoverage: number;
  };
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const FORBIDDEN_INSTRUCTION_COPY = /(?:\bdraft\b|\bplaceholder\b|\bpending\b|\btbd\b|\btodo\b|lorem ipsum|candidate image|final technique|prepare the equipment listed|follow the workout'?s prescribed|do not infer technique from the image|\brascunho\b|\bpendente(?:s)?\b|imagem candidata|indica(?:ç|c)ões técnicas finais|orienta(?:ç|c)ões técnicas finais|não deduza a técnica)/iu;
const FORBIDDEN_ACCESSIBILITY_COPY = /(?:\bdraft\b|\bplaceholder\b|\bpending\b|\btbd\b|\btodo\b|candidate image|visual accuracy and final wording|person demonstrating the exercise|\brascunho\b|\bpendente(?:s)?\b|imagem candidata|descri(?:ç|c)ão final aguarda)/iu;

export function trainingExerciseMediaAssetMappingKey(
  mapping: TrainingExerciseMediaExpectedAssetMapping,
): string {
  return `${mapping.exerciseId}:${mapping.role}:${mapping.ordinal}`;
}

export function buildTrainingExerciseInstructionContentHash(
  instruction: Omit<TrainingExerciseMediaAuthoredInstruction, 'authoringStatus' | 'contentHash'>,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_INSTRUCTION_CONTENT_SCHEMA_VERSION,
    exerciseId: instruction.exerciseId,
    locale: instruction.locale,
    displayName: instruction.displayName,
    steps: instruction.steps,
    cues: instruction.cues,
    cautions: instruction.cautions,
    textFallback: instruction.textFallback,
  });
}

export function buildTrainingExerciseAccessibilityContentHash(
  accessibility: Omit<TrainingExerciseMediaAuthoredAccessibility, 'authoringStatus' | 'contentHash'>,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_ACCESSIBILITY_CONTENT_SCHEMA_VERSION,
    exerciseId: accessibility.exerciseId,
    role: accessibility.role,
    ordinal: accessibility.ordinal,
    locale: accessibility.locale,
    caption: accessibility.caption,
    accessibilityDescription: accessibility.accessibilityDescription,
  });
}

export function buildTrainingExerciseAuthoredContentPackageHash(
  content: TrainingExerciseMediaAuthoredContent,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION,
    catalogVersion: content.manifest.catalogVersion,
    catalogSourceHash: content.manifest.catalogSourceHash,
    eligibilityManifestSha256: content.manifest.eligibilityManifestSha256,
    artifactIndexSha256: content.manifest.artifactIndexSha256,
    requiredLocales: content.manifest.requiredLocales,
    contentCreatedAt: content.manifest.contentCreatedAt,
    instructions: [...content.instructions]
      .map((entry) => ({ exerciseId: entry.exerciseId, locale: entry.locale, contentHash: entry.contentHash }))
      .sort((left, right) => `${left.exerciseId}:${left.locale}`.localeCompare(`${right.exerciseId}:${right.locale}`)),
    accessibility: [...content.accessibility]
      .map((entry) => ({
        exerciseId: entry.exerciseId,
        role: entry.role,
        ordinal: entry.ordinal,
        locale: entry.locale,
        contentHash: entry.contentHash,
      }))
      .sort((left, right) => (
        `${left.exerciseId}:${left.role}:${left.ordinal}:${left.locale}`
          .localeCompare(`${right.exerciseId}:${right.role}:${right.ordinal}:${right.locale}`)
      )),
  });
}

export function validateTrainingExerciseMediaAuthoredContent(
  content: TrainingExerciseMediaAuthoredContent,
  expectedExerciseIds: readonly string[],
  expectedAssetMappings: readonly TrainingExerciseMediaExpectedAssetMapping[],
  expectedSubjects: {
    catalogVersion: string;
    catalogSourceHash: string;
    eligibilityManifestSha256: string;
    artifactIndexSha256: string;
  },
): TrainingExerciseMediaAuthoredContentValidation {
  const errors: string[] = [];
  const manifest = content.manifest;
  const expectedExerciseSet = new Set(expectedExerciseIds);
  const expectedAssetKeys = new Set(expectedAssetMappings.map(trainingExerciseMediaAssetMappingKey));
  const requiredLocales = TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES as readonly string[];

  if (manifest.schemaVersion !== TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION) {
    errors.push('Authored-content manifest schema version is unsupported.');
  }
  if (manifest.status !== TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS) {
    errors.push('Authored-content manifest is not AUTHORING_COMPLETE_UNAPPROVED.');
  }
  if (manifest.catalogVersion !== expectedSubjects.catalogVersion
    || manifest.catalogSourceHash !== expectedSubjects.catalogSourceHash
    || manifest.eligibilityManifestSha256 !== expectedSubjects.eligibilityManifestSha256
    || manifest.artifactIndexSha256 !== expectedSubjects.artifactIndexSha256) {
    errors.push('Authored-content manifest does not match the frozen catalog and Phase 0 subjects.');
  }
  if (!sameStringSet(manifest.requiredLocales, requiredLocales)) {
    errors.push('Authored-content locales must be exactly en-US, pt-PT, and pt-BR.');
  }
  if (manifest.expectedExerciseCount !== 158 || expectedExerciseIds.length !== 158
    || expectedExerciseSet.size !== 158) {
    errors.push('Authored-content exercise authority must contain exactly 158 unique exercises.');
  }
  if (manifest.expectedAssetMappingCount !== 200 || expectedAssetMappings.length !== 200
    || expectedAssetKeys.size !== 200) {
    errors.push('Authored-content asset authority must contain exactly 200 unique mappings.');
  }
  if (!manifest.contentCreatedAt || !isIsoInstant(manifest.contentCreatedAt)) {
    errors.push('Authored-content creation timestamp is missing or invalid.');
  }
  if (manifest.instructionChunks.length !== 4 || manifest.accessibilityChunks.length !== 4
    || new Set([...manifest.instructionChunks, ...manifest.accessibilityChunks]).size !== 8) {
    errors.push('Authored-content manifest must name exactly four instruction and four accessibility chunks.');
  }

  const instructionKeys = new Set<string>();
  const instructionExercises = new Set<string>();
  const genericFingerprints = new Map<string, string>();
  for (const instruction of content.instructions) {
    const key = `${instruction.exerciseId}:${instruction.locale}`;
    if (instructionKeys.has(key)) errors.push(`Authored instruction is duplicated: ${key}.`);
    instructionKeys.add(key);
    instructionExercises.add(instruction.exerciseId);
    if (!expectedExerciseSet.has(instruction.exerciseId) || !SAFE_ID_PATTERN.test(instruction.exerciseId)) {
      errors.push(`Authored instruction references an unknown exercise: ${key}.`);
    }
    if (!requiredLocales.includes(instruction.locale)) errors.push(`Authored instruction locale is invalid: ${key}.`);
    if (instruction.authoringStatus !== TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS) {
      errors.push(`Authored instruction is not complete: ${key}.`);
    }
    const text = [instruction.displayName, ...instruction.steps, ...instruction.cues,
      ...instruction.cautions, instruction.textFallback].join(' ');
    if (!nonEmpty(instruction.displayName) || instruction.steps.length < 2
      || instruction.steps.some((step) => step.trim().length < 16)
      || instruction.cues.length < 1 || instruction.cues.some((cue) => cue.trim().length < 8)
      || instruction.cautions.some((caution) => caution.trim().length < 8)
      || instruction.textFallback.trim().length < 32) {
      errors.push(`Authored instruction is incomplete or too generic: ${key}.`);
    }
    if (FORBIDDEN_INSTRUCTION_COPY.test(text)) errors.push(`Authored instruction contains draft or placeholder copy: ${key}.`);
    const expectedHash = buildTrainingExerciseInstructionContentHash(instruction);
    if (!HASH_PATTERN.test(instruction.contentHash) || instruction.contentHash !== expectedHash) {
      errors.push(`Authored instruction content hash mismatch: ${key}.`);
    }
    const fingerprint = instructionFingerprint(instruction);
    const priorExercise = genericFingerprints.get(`${instruction.locale}:${fingerprint}`);
    if (fingerprint && priorExercise && priorExercise !== instruction.exerciseId) {
      errors.push(`Authored instruction reuses generic copy across exercises: ${priorExercise}, ${instruction.exerciseId} (${instruction.locale}).`);
    } else if (fingerprint) {
      genericFingerprints.set(`${instruction.locale}:${fingerprint}`, instruction.exerciseId);
    }
  }

  const accessibilityKeys = new Set<string>();
  const accessibilityAssets = new Set<string>();
  for (const accessibility of content.accessibility) {
    const assetKey = trainingExerciseMediaAssetMappingKey(accessibility);
    const key = `${assetKey}:${accessibility.locale}`;
    if (accessibilityKeys.has(key)) errors.push(`Authored accessibility record is duplicated: ${key}.`);
    accessibilityKeys.add(key);
    accessibilityAssets.add(assetKey);
    if (!expectedAssetKeys.has(assetKey)) errors.push(`Authored accessibility references an unknown mapping: ${key}.`);
    if (!requiredLocales.includes(accessibility.locale)) errors.push(`Authored accessibility locale is invalid: ${key}.`);
    if (accessibility.authoringStatus !== TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS) {
      errors.push(`Authored accessibility record is not complete: ${key}.`);
    }
    if (accessibility.caption != null && !nonEmpty(accessibility.caption)) {
      errors.push(`Authored accessibility caption is blank: ${key}.`);
    }
    if (accessibility.accessibilityDescription.trim().length < 40
      || FORBIDDEN_ACCESSIBILITY_COPY.test(accessibility.accessibilityDescription)) {
      errors.push(`Authored accessibility description is incomplete or generic: ${key}.`);
    }
    const expectedHash = buildTrainingExerciseAccessibilityContentHash(accessibility);
    if (!HASH_PATTERN.test(accessibility.contentHash) || accessibility.contentHash !== expectedHash) {
      errors.push(`Authored accessibility content hash mismatch: ${key}.`);
    }
  }

  const expectedInstructionKeys = new Set(expectedExerciseIds.flatMap((exerciseId) => (
    requiredLocales.map((locale) => `${exerciseId}:${locale}`)
  )));
  const expectedAccessibilityKeys = new Set(expectedAssetMappings.flatMap((mapping) => (
    requiredLocales.map((locale) => `${trainingExerciseMediaAssetMappingKey(mapping)}:${locale}`)
  )));
  const missingInstructionKeys = [...expectedInstructionKeys].filter((key) => !instructionKeys.has(key));
  const extraInstructionKeys = [...instructionKeys].filter((key) => !expectedInstructionKeys.has(key));
  const missingAccessibilityKeys = [...expectedAccessibilityKeys].filter((key) => !accessibilityKeys.has(key));
  const extraAccessibilityKeys = [...accessibilityKeys].filter((key) => !expectedAccessibilityKeys.has(key));
  if (content.instructions.length !== TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_INSTRUCTIONS
    || missingInstructionKeys.length > 0 || extraInstructionKeys.length > 0) {
    errors.push(`Authored instruction coverage is ${content.instructions.length}/${TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_INSTRUCTIONS}; missing ${missingInstructionKeys.length}, extra ${extraInstructionKeys.length}.`);
  }
  if (content.accessibility.length !== TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_ACCESSIBILITY
    || missingAccessibilityKeys.length > 0 || extraAccessibilityKeys.length > 0) {
    errors.push(`Authored accessibility coverage is ${content.accessibility.length}/${TRAINING_EXERCISE_MEDIA_EXPECTED_AUTHORED_ACCESSIBILITY}; missing ${missingAccessibilityKeys.length}, extra ${extraAccessibilityKeys.length}.`);
  }

  return {
    valid: errors.length === 0,
    errors: unique(errors),
    authoredContentPackageHash: buildTrainingExerciseAuthoredContentPackageHash(content),
    counts: {
      expectedExercises: expectedExerciseIds.length,
      instructionRecords: content.instructions.length,
      accessibilityRecords: content.accessibility.length,
      instructionExerciseCoverage: instructionExercises.size,
      accessibilityAssetCoverage: accessibilityAssets.size,
    },
  };
}

export function assertTrainingExerciseMediaAuthoredContent(
  content: TrainingExerciseMediaAuthoredContent,
  expectedExerciseIds: readonly string[],
  expectedAssetMappings: readonly TrainingExerciseMediaExpectedAssetMapping[],
  expectedSubjects: {
    catalogVersion: string;
    catalogSourceHash: string;
    eligibilityManifestSha256: string;
    artifactIndexSha256: string;
  },
): TrainingExerciseMediaAuthoredContentValidation {
  const result = validateTrainingExerciseMediaAuthoredContent(
    content, expectedExerciseIds, expectedAssetMappings, expectedSubjects,
  );
  if (!result.valid) throw new Error(`Authored exercise media content is invalid: ${result.errors.join(' ')}`);
  return result;
}

function instructionFingerprint(instruction: TrainingExerciseMediaAuthoredInstruction): string {
  const removable = [instruction.exerciseId, instruction.displayName]
    .map((value) => normalize(value)).filter(Boolean);
  let fingerprint = normalize([
    ...instruction.steps,
    ...instruction.cues,
    ...instruction.cautions,
    instruction.textFallback,
  ].join(' '));
  for (const value of removable) fingerprint = fingerprint.replaceAll(value, '<exercise>');
  return fingerprint;
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
