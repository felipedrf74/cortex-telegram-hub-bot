// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  validateTrainingExerciseMediaAuthoredContent,
  type TrainingExerciseMediaExpectedAssetMapping,
} from '../src/services/training-exercise-media-authored-content';
import {
  TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT,
  loadTrainingExerciseMediaAuthoredContent,
} from './lib/training-exercise-media-authored-content';
import { TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT } from './lib/training-exercise-media-package';

const phase0Root = argumentPath('phase0-root') ?? process.env.NEXUS_TRAINING_MEDIA_PHASE0_ROOT;
const authoredRoot = argumentPath('authored-root') ?? TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT;
const sourcePackageRoot = argumentPath('source-package-root') ?? TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT;
if (!phase0Root || !path.isAbsolute(phase0Root)) {
  process.stderr.write('An absolute --phase0-root (or NEXUS_TRAINING_MEDIA_PHASE0_ROOT) is required.\n');
  process.exit(2);
}

const eligibilityBytes = fs.readFileSync(path.join(phase0Root, 'eligibility-manifest.json'));
const artifactBytes = fs.readFileSync(path.join(phase0Root, 'artifact-index.json'));
const artifact = JSON.parse(artifactBytes.toString('utf8'));
const backendManifest = JSON.parse(fs.readFileSync(path.join(sourcePackageRoot, 'manifest.json'), 'utf8'));
const { content } = loadTrainingExerciseMediaAuthoredContent(authoredRoot);
const expectedMappings: TrainingExerciseMediaExpectedAssetMapping[] = (artifact.mappings ?? []).map((mapping: any) => ({
  exerciseId: mapping.exerciseId,
  role: mapping.role,
  ordinal: mapping.ordinal,
}));
const validation = validateTrainingExerciseMediaAuthoredContent(
  content,
  backendManifest.expectedExerciseIds ?? [],
  expectedMappings,
  {
    catalogVersion: artifact.catalogVersion,
    catalogSourceHash: artifact.catalogSourceHash,
    eligibilityManifestSha256: sha256(eligibilityBytes),
    artifactIndexSha256: sha256(artifactBytes),
  },
);

process.stdout.write(`${JSON.stringify({
  verdict: validation.valid ? 'PASS_AUTHORING_COMPLETE_UNAPPROVED' : 'FAIL_AUTHORED_CONTENT',
  ...validation,
}, null, 2)}\n`);
if (!validation.valid) process.exitCode = 1;

function argumentPath(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value ? path.resolve(value) : undefined;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
