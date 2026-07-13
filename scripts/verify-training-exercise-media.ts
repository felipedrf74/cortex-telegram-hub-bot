// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import {
  validateCompiledTrainingExerciseMediaPackage,
} from '../src/services/training-exercise-media-manifest';
import {
  TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
  compileTrainingExerciseMediaPackage,
  findForbiddenMediaBinaries,
  formatCompiledTrainingExerciseMediaPackage,
  readCompiledTrainingExerciseMediaPackage,
} from './lib/training-exercise-media-package';

const requireActivation = process.argv.includes('--activation');
const expected = compileTrainingExerciseMediaPackage();
const compiled = readCompiledTrainingExerciseMediaPackage();
const compiledFresh = fs.readFileSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH, 'utf8')
  === formatCompiledTrainingExerciseMediaPackage(expected);
const forbiddenBinaries = findForbiddenMediaBinaries();
const validation = validateCompiledTrainingExerciseMediaPackage(compiled, { requireActivation });
const passed = compiledFresh && forbiddenBinaries.length === 0
  && validation.structurallyValid && (!requireActivation || validation.activationReady);

process.stdout.write(`${JSON.stringify({
  passed,
  requireActivation,
  compiledFresh,
  forbiddenBinaries,
  structurallyValid: validation.structurallyValid,
  activationReady: validation.activationReady,
  coverage: validation.coverage,
  errors: validation.errors,
  activationBlockers: validation.activationBlockers,
}, null, 2)}\n`);
if (!passed) process.exitCode = 1;
