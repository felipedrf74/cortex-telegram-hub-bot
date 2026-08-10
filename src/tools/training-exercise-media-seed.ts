// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../services/database-bootstrap';
import { seedCompiledTrainingExerciseMediaPackage } from '../services/training-exercise-media-seed';
import {
  assertCompiledTrainingExerciseMediaPackage,
} from '../services/training-exercise-media-manifest';
import type { CompiledTrainingExerciseMediaPackage } from '../services/training-exercise-media-manifest';
import { loadTrainingExerciseMediaAuthoredContent } from '../services/training-exercise-media-authored-content-files';
import {
  validateTrainingExerciseMediaMaterializationAttestation,
} from '../services/training-exercise-media-release-attestation';
import {
  assertTrainingExerciseMediaSeedFilesystemBoundary,
  assertTrainingExerciseMediaProductionDatabasePrecondition,
  authorizeTrainingExerciseMediaSeed,
} from '../services/training-exercise-media-seed-authorization';

const packageRoot = path.resolve(process.cwd(), 'catalog/training/exercise-media/v1');
const compiledPath = path.join(packageRoot, 'compiled-manifest.json');

const apply = process.argv.includes('--apply');
const legacyActivate = process.argv.includes('--activate');
const requestedTarget = argumentValue('target');
const requestedAction = argumentValue('action');
const compiled = JSON.parse(
  fs.readFileSync(compiledPath, 'utf8'),
) as CompiledTrainingExerciseMediaPackage;
const requireActivation = legacyActivate || requestedAction === 'activate';
assertCompiledTrainingExerciseMediaPackage(compiled, { requireActivation });
const materializationAttestationPath = path.join(packageRoot, 'materialization-attestation.json');
const materializationAttestation = JSON.parse(fs.readFileSync(materializationAttestationPath, 'utf8'));
const { content: authoredContent, policy, rawMaterializationPolicySha256 } =
  loadTrainingExerciseMediaAuthoredContent();
const releaseAttestation = validateTrainingExerciseMediaMaterializationAttestation({
  attestation: materializationAttestation,
  compiled,
  authoredContent,
  policy,
  rawMaterializationPolicySha256,
  requireActivation,
});
if (!releaseAttestation.valid || (requireActivation && !releaseAttestation.activationReady)
  || releaseAttestation.finalOwnerApprovalHash == null) {
  throw new Error(`Media release attestation is not valid for seeding: ${releaseAttestation.errors.join(' ')}`);
}
const releaseSubject = {
  manifestId: compiled.manifest.manifestId,
  packageHash: compiled.packageHash,
  releaseSubjectHash: releaseAttestation.releaseSubjectHash,
  finalOwnerApprovalHash: releaseAttestation.finalOwnerApprovalHash,
};
const authorization = authorizeTrainingExerciseMediaSeed({
  apply,
  requestedTarget,
  requestedAction,
  legacyActivate,
  env: process.env,
  subject: releaseSubject,
});

if (!apply) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    manifestId: compiled.manifest.manifestId,
    packageHash: compiled.packageHash,
    releaseSubjectHash: releaseAttestation.releaseSubjectHash,
    finalOwnerApprovalHash: releaseAttestation.finalOwnerApprovalHash,
    publicationState: compiled.manifest.publicationState,
    activate: requireActivation,
    databaseOpened: false,
  })}\n`);
} else {
  if (!authorization) throw new Error('Media seed authorization unexpectedly missing.');
  assertTrainingExerciseMediaSeedFilesystemBoundary({
    target: authorization.target,
    workingDirectory: process.cwd(),
    databasePath: process.env.DATABASE_PATH,
  });
  const db = initDatabase();
  const productionAction = authorization.target === 'production'
    ? authorization.action as 'stage' | 'activate'
    : null;
  if (productionAction) {
    assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, releaseSubject, productionAction,
    );
  }
  const activate = authorization.action === 'activate'
    || authorization.action === 'stage-and-activate';
  const result = seedCompiledTrainingExerciseMediaPackage(db, compiled, { activate });
  if (productionAction === 'stage'
    && (result.publicationState !== 'STAGED' || !result.staged || result.activated)) {
    throw new Error('Production media stage readback did not prove STAGED and inactive state.');
  }
  if (productionAction === 'activate'
    && (result.publicationState !== 'ACTIVE' || !result.activated)) {
    throw new Error('Production media activation readback did not prove ACTIVE state.');
  }
  process.stdout.write(`${JSON.stringify({
    dryRun: false,
    target: authorization.target,
    action: authorization.action,
    releaseSubjectHash: releaseAttestation.releaseSubjectHash,
    finalOwnerApprovalHash: releaseAttestation.finalOwnerApprovalHash,
    ...result,
  })}\n`);
}

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const matches = process.argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`Duplicate --${name} arguments are not allowed.`);
  const value = matches[0]?.slice(prefix.length);
  return value && value.trim() ? value.trim() : undefined;
}
