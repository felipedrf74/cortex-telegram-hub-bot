// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import {
  TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
  compileTrainingExerciseMediaPackage,
  formatCompiledTrainingExerciseMediaPackage,
} from './lib/training-exercise-media-package';

const compiled = compileTrainingExerciseMediaPackage();
const expected = formatCompiledTrainingExerciseMediaPackage(compiled);
const check = process.argv.includes('--check');
const write = process.argv.includes('--write');

if (check) {
  const current = fs.existsSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH)
    ? fs.readFileSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH, 'utf8')
    : '';
  if (current !== expected) {
    process.stderr.write('Training exercise media compiled manifest is missing or stale.\n');
    process.exitCode = 1;
  }
} else if (write) {
  fs.writeFileSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH, expected, 'utf8');
}

process.stdout.write(`${JSON.stringify({
  manifestId: compiled.manifest.manifestId,
  packageHash: compiled.packageHash,
  publicationState: compiled.manifest.publicationState,
  coverage: compiled.coverage,
  wrote: write,
  checked: check,
})}\n`);
