// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import { validateCompiledTrainingExerciseMediaPackage } from '../../src/services/training-exercise-media-manifest';
import {
  TRAINING_EXERCISE_MEDIA_COMPILED_PATH,
  compileTrainingExerciseMediaPackage,
  findForbiddenMediaBinaries,
  formatCompiledTrainingExerciseMediaPackage,
  readCompiledTrainingExerciseMediaPackage,
} from './training-exercise-media-package';
import { loadTrainingExerciseMediaAuthoredContent } from './training-exercise-media-authored-content';
import { validateTrainingExerciseMediaMaterializationAttestation } from './training-exercise-media-release-attestation';

/**
 * Authoritative backend package verification without the independent catalog
 * gate. The standard activation CLI wraps this function with that external
 * gate. The independent catalog validator imports this function directly to
 * avoid recursively invoking its own parent gate.
 */
export function verifyTrainingExerciseMediaPackage(activationRequired: boolean) {
  const expected = compileTrainingExerciseMediaPackage();
  const compiled = readCompiledTrainingExerciseMediaPackage();
  const compiledFresh = fs.readFileSync(TRAINING_EXERCISE_MEDIA_COMPILED_PATH, 'utf8')
    === formatCompiledTrainingExerciseMediaPackage(expected);
  const forbiddenBinaries = findForbiddenMediaBinaries();
  const validation = validateCompiledTrainingExerciseMediaPackage(
    compiled,
    { requireActivation: activationRequired },
  );
  const materializationAttestationPath = TRAINING_EXERCISE_MEDIA_COMPILED_PATH
    .replace(/compiled-manifest\.json$/, 'materialization-attestation.json');
  const materializationAttestation = fs.existsSync(materializationAttestationPath)
    ? JSON.parse(fs.readFileSync(materializationAttestationPath, 'utf8'))
    : null;
  const { content: authoredContent, policy, rawMaterializationPolicySha256 } =
    loadTrainingExerciseMediaAuthoredContent();
  const attestationValidation = validateTrainingExerciseMediaMaterializationAttestation({
    attestation: materializationAttestation,
    compiled,
    authoredContent,
    policy,
    rawMaterializationPolicySha256,
    requireActivation: activationRequired,
  });
  const passed = compiledFresh && forbiddenBinaries.length === 0
    && validation.structurallyValid && attestationValidation.valid
    && (!activationRequired
      || (validation.activationReady && attestationValidation.activationReady));

  return {
    passed,
    requireActivation: activationRequired,
    manifestId: compiled.manifest.manifestId,
    manifestVersion: compiled.manifest.manifestVersion,
    packageHash: compiled.packageHash,
    manifest: compiled.manifest,
    counts: {
      exercises: compiled.exercises.length,
      assets: compiled.assets.length,
      instructions: compiled.instructions.length,
      mediaLocalizations: compiled.mediaLocalizations.length,
      provenance: compiled.provenance.length,
      reviews: compiled.reviews.length,
      localizationReviews: compiled.localizationReviews.length,
      hostApprovals: compiled.hostApprovals.length,
      ownerApprovals: compiled.ownerApprovals.length,
      takedowns: compiled.takedowns.length,
    },
    exercises: compiled.exercises.map(({ exerciseId, requiredViews, publicationState }) => ({
      exerciseId, requiredViews, publicationState,
    })),
    assets: compiled.assets.map(({
      assetId, exerciseId, viewRole, ordinal, deliveryUrl, integritySha256, publicationState,
    }) => ({
      assetId,
      exerciseId,
      viewRole,
      ordinal,
      deliveryUrl,
      integritySha256,
      publicationState,
    })),
    materializationAttestation,
    releaseAttestation: attestationValidation,
    compiledFresh,
    forbiddenBinaries,
    structurallyValid: validation.structurallyValid,
    activationReady: validation.activationReady,
    coverage: validation.coverage,
    errors: validation.errors,
    activationBlockers: validation.activationBlockers,
  };
}
