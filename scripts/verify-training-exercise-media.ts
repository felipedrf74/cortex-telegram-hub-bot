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
import {
  runTrainingExerciseMediaActivationGate,
} from './lib/training-exercise-media-publication-gate';

const requireActivation = process.argv.includes('--activation');
const verification = requireActivation
  ? runTrainingExerciseMediaActivationGate(() => verifyPackage(true))
  : verifyPackage(false);

process.stdout.write(`${JSON.stringify({
  passed: verification.passed,
  requireActivation,
  compiledFresh: verification.compiledFresh,
  forbiddenBinaries: verification.forbiddenBinaries,
  structurallyValid: verification.validation.structurallyValid,
  activationReady: verification.validation.activationReady,
  coverage: verification.validation.coverage,
  errors: verification.validation.errors,
  activationBlockers: verification.validation.activationBlockers,
}, null, 2)}\n`);
if (!verification.passed) process.exitCode = 1;

function verifyPackage(activationRequired: boolean) {
  const expected = compileTrainingExerciseMediaPackage();
  const compiled = readCompiledTrainingExerciseMediaPackage();
  const compiledFresh = fs.readFileSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH, 'utf8')
    === formatCompiledTrainingExerciseMediaPackage(expected);
  const forbiddenBinaries = findForbiddenMediaBinaries();
  const validation = validateCompiledTrainingExerciseMediaPackage(
    compiled,
    { requireActivation: activationRequired },
  );
  const passed = compiledFresh && forbiddenBinaries.length === 0
    && validation.structurallyValid && (!activationRequired || validation.activationReady);
  return { passed, compiledFresh, forbiddenBinaries, validation };
}
