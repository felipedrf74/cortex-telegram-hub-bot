// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import {
  TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION,
  type TrainingExerciseMediaAuthoredAccessibility,
  type TrainingExerciseMediaAuthoredContent,
  type TrainingExerciseMediaAuthoredContentManifest,
  type TrainingExerciseMediaAuthoredInstruction,
} from './training-exercise-media-authored-content';
import { sha256TrainingExerciseMediaRawBytes } from './training-exercise-media-release-attestation';

export const TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT = path.resolve(
  process.cwd(),
  'catalog/training/exercise-media/v1/authored-content',
);
export const TRAINING_EXERCISE_MEDIA_MATERIALIZATION_POLICY_SCHEMA_VERSION =
  'training-exercise-media-materialization-policy.v1' as const;

export interface TrainingExerciseMediaMaterializationPolicy {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_MATERIALIZATION_POLICY_SCHEMA_VERSION;
  status: 'DRAFT_AWAITING_EVIDENCE' | 'READY_TO_MATERIALIZE';
  phase0Subjects: {
    eligibilityManifestSha256: string;
    artifactIndexSha256: string;
    approvalPackageSha256: string | null;
    publicationEvidenceSha256: string | null;
  };
  approvedOrigin: string;
  phase0ReviewImport: {
    approvalId: string | null;
    reviewerRef: string | null;
    reviewedAt: string | null;
    expiresAt: string | null;
  };
  contentReview: {
    approvalRef: string | null;
    reviewerRef: string | null;
    reviewedAt: string | null;
    expiresAt: string | null;
    subjectAuthoredContentPackageHash: string | null;
  };
  rights: {
    status: 'PENDING' | 'APPROVED';
    sourceKind: 'GENERATED' | 'LICENSED' | 'OWNED' | 'COMMISSIONED';
    licenseIdentifier: string | null;
    licenseUrl: string | null;
    rightsHolderRef: string | null;
    rightsExpiresAt: string | null;
    territories: string[];
    publicationAllowed: boolean;
  };
}

export interface LoadedTrainingExerciseMediaAuthoredContent {
  content: TrainingExerciseMediaAuthoredContent;
  policy: TrainingExerciseMediaMaterializationPolicy;
  rawMaterializationPolicySha256: string;
}

const EXPECTED_INSTRUCTION_CHUNKS = [
  'instructions-000-039.json',
  'instructions-040-079.json',
  'instructions-080-119.json',
  'instructions-120-157.json',
] as const;
const EXPECTED_ACCESSIBILITY_CHUNKS = [
  'accessibility-000-039.json',
  'accessibility-040-079.json',
  'accessibility-080-119.json',
  'accessibility-120-157.json',
] as const;

export function loadTrainingExerciseMediaAuthoredContent(
  root = TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT,
): LoadedTrainingExerciseMediaAuthoredContent {
  const manifest = readJsonObject(
    path.join(root, 'manifest.json'),
    'authored-content manifest',
  ) as unknown as TrainingExerciseMediaAuthoredContentManifest;
  if (manifest.schemaVersion !== TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION) {
    throw new Error('Authored-content manifest schema version is unsupported.');
  }
  assertExactChunks(manifest.instructionChunks, EXPECTED_INSTRUCTION_CHUNKS, 'instruction');
  assertExactChunks(manifest.accessibilityChunks, EXPECTED_ACCESSIBILITY_CHUNKS, 'accessibility');

  const instructions = manifest.instructionChunks.flatMap((filename) => (
    readJsonArray(path.join(root, safeChunkFilename(filename)), filename)
  )) as unknown as TrainingExerciseMediaAuthoredInstruction[];
  const accessibility = manifest.accessibilityChunks.flatMap((filename) => (
    readJsonArray(path.join(root, safeChunkFilename(filename)), filename)
  )) as unknown as TrainingExerciseMediaAuthoredAccessibility[];
  const policyPath = path.join(root, 'materialization-policy.json');
  const rawMaterializationPolicy = fs.readFileSync(policyPath);
  const policy = parseJsonObject(
    rawMaterializationPolicy,
    policyPath,
    'materialization policy',
  ) as unknown as TrainingExerciseMediaMaterializationPolicy;
  if (policy.schemaVersion !== TRAINING_EXERCISE_MEDIA_MATERIALIZATION_POLICY_SCHEMA_VERSION) {
    throw new Error('Materialization-policy schema version is unsupported.');
  }

  return {
    content: { manifest, instructions, accessibility },
    policy,
    rawMaterializationPolicySha256: sha256TrainingExerciseMediaRawBytes(rawMaterializationPolicy),
  };
}

function assertExactChunks(
  actual: unknown,
  expected: readonly string[],
  kind: string,
): asserts actual is string[] {
  if (!Array.isArray(actual) || actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`Authored-content ${kind} chunks must be the exact frozen four-file partition.`);
  }
}

function safeChunkFilename(filename: string): string {
  if (path.basename(filename) !== filename || !/^[a-z0-9-]+\.json$/.test(filename)) {
    throw new Error(`Unsafe authored-content chunk filename: ${filename}.`);
  }
  return filename;
}

function readJsonArray(filePath: string, label: string): unknown[] {
  const value = readJson(filePath);
  if (!Array.isArray(value)) throw new Error(`${label} must contain a JSON array.`);
  return value;
}

function readJsonObject(filePath: string, label: string): Record<string, unknown> {
  const value = readJson(filePath);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(
  bytes: Buffer,
  filePath: string,
  label: string,
): Record<string, unknown> {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} must contain a JSON object.`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Unable to read authored-content JSON ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read authored-content JSON ${filePath}: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}
