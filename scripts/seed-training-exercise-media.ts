// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { initDatabase } from '../src/services/database';
import { seedCompiledTrainingExerciseMediaPackage } from '../src/services/training-exercise-media-seed';
import {
  assertCompiledTrainingExerciseMediaPackage,
} from '../src/services/training-exercise-media-manifest';
import { readCompiledTrainingExerciseMediaPackage } from './lib/training-exercise-media-package';

const apply = process.argv.includes('--apply');
const activate = process.argv.includes('--activate');
const compiled = readCompiledTrainingExerciseMediaPackage();
assertCompiledTrainingExerciseMediaPackage(compiled, { requireActivation: activate });

if (!apply) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    manifestId: compiled.manifest.manifestId,
    packageHash: compiled.packageHash,
    publicationState: compiled.manifest.publicationState,
    activate,
    databaseOpened: false,
  })}\n`);
} else {
  if (process.env.NEXUS_STAGING !== '1'
    || process.env.TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK !== 'staging-only-reviewed-manifest') {
    throw new Error(
      'Media seeding is staging-only and requires NEXUS_STAGING=1 plus '
      + 'TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK=staging-only-reviewed-manifest.',
    );
  }
  const db = initDatabase();
  const result = seedCompiledTrainingExerciseMediaPackage(db, compiled, { activate });
  process.stdout.write(`${JSON.stringify({ dryRun: false, ...result })}\n`);
}
