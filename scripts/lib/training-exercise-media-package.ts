// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import {
  TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION,
  buildCompiledTrainingExerciseMediaPackage,
  type CompiledTrainingExerciseMediaPackage,
  type TrainingExerciseMediaApprovalLedgerSource,
  type TrainingExerciseMediaPackageSources,
} from '../../src/services/training-exercise-media-manifest';

export const TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT = path.resolve(
  process.cwd(),
  'catalog/training/exercise-media/v1',
);
export const TRAINING_EXERCISE_MEDIA_COMPILED_PATH = path.join(
  TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
  'compiled-manifest.json',
);

const SOURCE_FILES = {
  manifest: 'manifest.json',
  exercises: 'exercises.json',
  assets: 'assets.json',
  instructions: 'instructions.json',
  mediaLocalizations: 'media-localizations.json',
  provenance: 'provenance.json',
  reviews: 'reviews.json',
  takedowns: 'takedowns.json',
} as const;
const APPROVAL_LEDGER_FILE = 'approval-ledger.json';

const FORBIDDEN_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.mp4', '.mov', '.pdf',
]);

export function loadTrainingExerciseMediaPackageSources(
  root = TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
): TrainingExerciseMediaPackageSources {
  const loaded = Object.fromEntries(Object.entries(SOURCE_FILES).map(([key, filename]) => (
    [key, readJson(path.join(root, filename))]
  ))) as unknown as TrainingExerciseMediaPackageSources;
  const approvalLedger = readJson(path.join(root, APPROVAL_LEDGER_FILE)) as TrainingExerciseMediaApprovalLedgerSource;
  if (!loaded.manifest || typeof loaded.manifest !== 'object') throw new Error('Media manifest must be an object.');
  for (const key of ['exercises', 'assets', 'instructions', 'mediaLocalizations', 'provenance', 'reviews', 'takedowns'] as const) {
    if (!Array.isArray(loaded[key])) throw new Error(`${SOURCE_FILES[key]} must contain a JSON array.`);
  }
  if (!approvalLedger || typeof approvalLedger !== 'object'
    || approvalLedger.schemaVersion !== TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION) {
    throw new Error(`${APPROVAL_LEDGER_FILE} must use ${TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION}.`);
  }
  for (const key of ['assetReviews', 'localizationReviews', 'hostApprovals', 'ownerApprovals'] as const) {
    if (!Array.isArray(approvalLedger[key])) {
      throw new Error(`${APPROVAL_LEDGER_FILE}.${key} must contain a JSON array.`);
    }
  }
  if (approvalLedger.approvedHostRef != null && typeof approvalLedger.approvedHostRef !== 'string') {
    throw new Error(`${APPROVAL_LEDGER_FILE}.approvedHostRef must be a string or null.`);
  }
  if (approvalLedger.ownerApprovalRef != null && typeof approvalLedger.ownerApprovalRef !== 'string') {
    throw new Error(`${APPROVAL_LEDGER_FILE}.ownerApprovalRef must be a string or null.`);
  }
  return {
    ...loaded,
    manifest: {
      ...loaded.manifest,
      approvedHostRef: approvalLedger.approvedHostRef,
      ownerApprovalRef: approvalLedger.ownerApprovalRef,
    },
    reviews: [...loaded.reviews, ...approvalLedger.assetReviews],
    localizationReviews: approvalLedger.localizationReviews,
    hostApprovals: approvalLedger.hostApprovals,
    ownerApprovals: approvalLedger.ownerApprovals,
  };
}

export function compileTrainingExerciseMediaPackage(
  root = TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
): CompiledTrainingExerciseMediaPackage {
  return buildCompiledTrainingExerciseMediaPackage(loadTrainingExerciseMediaPackageSources(root));
}

export function readCompiledTrainingExerciseMediaPackage(
  filePath = TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
): CompiledTrainingExerciseMediaPackage {
  return readJson(filePath) as CompiledTrainingExerciseMediaPackage;
}

export function formatCompiledTrainingExerciseMediaPackage(
  compiled: CompiledTrainingExerciseMediaPackage,
): string {
  return `${JSON.stringify(compiled, null, 2)}\n`;
}

export function findForbiddenMediaBinaries(root = TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT): string[] {
  const findings: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (FORBIDDEN_BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        findings.push(path.relative(root, entryPath));
      }
    }
  };
  visit(root);
  return findings.sort();
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
