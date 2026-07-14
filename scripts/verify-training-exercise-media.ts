// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { runTrainingExerciseMediaActivationGate } from './lib/training-exercise-media-publication-gate';
import { verifyTrainingExerciseMediaPackage } from './lib/training-exercise-media-verifier';

const requireActivation = process.argv.includes('--activation');
const verification = requireActivation
  ? runTrainingExerciseMediaActivationGate(() => verifyTrainingExerciseMediaPackage(true))
  : verifyTrainingExerciseMediaPackage(false);

process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
if (!verification.passed) process.exitCode = 1;
