// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import {
  deriveTrainingExerciseMediaDraftScaffolds,
  validateTrainingExerciseMediaReviewBundle,
  type TrainingExerciseMediaReviewBundle,
} from '../src/services/training-exercise-media-review-bundle';
import {
  TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
  TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
  compileTrainingExerciseMediaPackage,
  formatCompiledTrainingExerciseMediaPackage,
} from './lib/training-exercise-media-package';

const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
if (!write && !check) throw new Error('Usage: --write|--check');

const bundlePath = path.join(TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT, 'review-bundle.draft.json');
const bundle = readJson<TrainingExerciseMediaReviewBundle>(bundlePath);
const bundleErrors = validateTrainingExerciseMediaReviewBundle(bundle);
if (bundleErrors.length > 0) throw new Error(`Review bundle is invalid: ${bundleErrors.join(' ')}`);

assertDraftOnlyPackageBoundary();
const derived = deriveTrainingExerciseMediaDraftScaffolds(bundle);
const exercisesPath = path.join(TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT, 'exercises.json');
const instructionScaffoldsPath = path.join(
  TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
  'instruction-scaffolds.draft.json',
);
const accessibilityScaffoldsPath = path.join(
  TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT,
  'accessibility-scaffolds.draft.json',
);
const expectedExercises = formatJson(derived.exercises);
const expectedInstructionScaffolds = formatJson(derived.instructionScaffolds);
const expectedAccessibilityScaffolds = formatJson(derived.accessibilityScaffolds);
const errors: string[] = [];

if (write) {
  assertEmptyOrExact(exercisesPath, expectedExercises, 'exercises.json');
  assertEmptyOrExact(instructionScaffoldsPath, expectedInstructionScaffolds, 'instruction-scaffolds.draft.json');
  assertEmptyOrExact(accessibilityScaffoldsPath, expectedAccessibilityScaffolds, 'accessibility-scaffolds.draft.json');
  fs.writeFileSync(exercisesPath, expectedExercises, 'utf8');
  fs.writeFileSync(instructionScaffoldsPath, expectedInstructionScaffolds, 'utf8');
  fs.writeFileSync(accessibilityScaffoldsPath, expectedAccessibilityScaffolds, 'utf8');
  fs.writeFileSync(
    TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
    formatCompiledTrainingExerciseMediaPackage(compileTrainingExerciseMediaPackage()),
    'utf8',
  );
}

if (check) {
  if (readText(exercisesPath) !== expectedExercises) errors.push('exercises.json is missing or stale.');
  if (readText(instructionScaffoldsPath) !== expectedInstructionScaffolds) {
    errors.push('instruction-scaffolds.draft.json is missing or stale.');
  }
  if (readText(accessibilityScaffoldsPath) !== expectedAccessibilityScaffolds) {
    errors.push('accessibility-scaffolds.draft.json is missing or stale.');
  }
  const expectedCompiled = formatCompiledTrainingExerciseMediaPackage(compileTrainingExerciseMediaPackage());
  if (readText(TRAINING_EXERCISE_MEDIA_COMPILED_PATH) !== expectedCompiled) {
    errors.push('compiled-manifest.json is missing or stale.');
  }
}

process.stdout.write(`${JSON.stringify({
  verdict: errors.length === 0 ? 'PASS_DRAFT_IMPORT' : 'FAIL',
  status: bundle.status,
  productionReleaseEligible: false,
  exercises: derived.exercises.length,
  instructionScaffolds: derived.instructionScaffolds.length,
  accessibilityScaffolds: derived.accessibilityScaffolds.length,
  completeLocalizedExercises: 0,
  assetsImported: 0,
  instructionLocalizationsImported: 0,
  mediaLocalizationsImported: 0,
  approvalsImported: 0,
  deliveryOriginsImported: 0,
  wrote: write,
  checked: check,
  errors,
}, null, 2)}\n`);
if (errors.length > 0) process.exitCode = 1;

function assertDraftOnlyPackageBoundary(): void {
  const manifest = readJson<Record<string, unknown>>(path.join(TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT, 'manifest.json'));
  const ledger = readJson<Record<string, unknown>>(path.join(TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT, 'approval-ledger.json'));
  if (manifest.publicationState !== 'DRAFT'
      || manifest.validationStatus !== 'PENDING'
      || manifest.activatedAt != null
      || !Array.isArray(manifest.allowedOrigins) || manifest.allowedOrigins.length !== 0
      || manifest.approvedHostRef != null
      || manifest.ownerApprovalRef != null) {
    throw new Error('Draft importer refuses a manifest with activation, host, owner, or origin state.');
  }
  if (ledger.approvedHostRef != null || ledger.ownerApprovalRef != null
      || ['assetReviews', 'localizationReviews', 'hostApprovals', 'ownerApprovals']
        .some((key) => !Array.isArray(ledger[key]) || (ledger[key] as unknown[]).length !== 0)) {
    throw new Error('Draft importer refuses to modify a package containing human approval evidence.');
  }
  for (const file of [
    'assets.json',
    'instructions.json',
    'media-localizations.json',
    'provenance.json',
    'reviews.json',
    'takedowns.json',
  ]) {
    const value = readJson<unknown>(path.join(TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT, file));
    if (!Array.isArray(value) || value.length !== 0) {
      throw new Error(`Draft importer refuses non-empty publication source: ${file}`);
    }
  }
}

function assertEmptyOrExact(file: string, expected: string, label: string): void {
  if (!fs.existsSync(file)) return;
  const current = readText(file);
  if (current !== '[]\n' && current !== '[]' && current !== expected) {
    throw new Error(`Draft importer refuses to overwrite non-empty divergent ${label}.`);
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
