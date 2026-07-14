// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TrainingExerciseMediaExerciseSource } from '../src/services/training-exercise-media-manifest';
import {
  TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT,
  loadTrainingExerciseMediaAuthoredContent,
} from './lib/training-exercise-media-authored-content';
import {
  buildTrainingExerciseMediaSupplementalApprovalStatement,
  finalizeMaterializedTrainingExerciseMediaPackage,
  materializeTrainingExerciseMediaPackage,
  type MaterializedTrainingExerciseMediaPackage,
  type TrainingExerciseMediaPhase0Evidence,
} from './lib/training-exercise-media-materializer';
import { TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT } from './lib/training-exercise-media-package';

const write = process.argv.includes('--write');
const phase0Root = argumentPath('phase0-root') ?? process.env.NEXUS_TRAINING_MEDIA_PHASE0_ROOT;
const authoredRoot = argumentPath('authored-root') ?? TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_ROOT;
const sourcePackageRoot = argumentPath('source-package-root') ?? TRAINING_EXERCISE_MEDIA_PACKAGE_ROOT;
const outputRoot = argumentPath('output-root');
const finalOwnerApprovalPath = argumentPath('final-owner-approval');
const supplementalOwnerApprovalPath = argumentPath('supplemental-owner-approval');

if (!phase0Root || !path.isAbsolute(phase0Root)) {
  fail('A trusted absolute --phase0-root (or NEXUS_TRAINING_MEDIA_PHASE0_ROOT) is required.', 2);
}
if (write && (!outputRoot || !path.isAbsolute(outputRoot))) {
  fail('--write requires an absolute --output-root.', 2);
}
if (!write && outputRoot) fail('--output-root is accepted only with --write.', 2);
if (supplementalOwnerApprovalPath && !finalOwnerApprovalPath) {
  fail('--supplemental-owner-approval requires --final-owner-approval.', 2);
}

try {
  const { content, policy, rawMaterializationPolicySha256 } =
    loadTrainingExerciseMediaAuthoredContent(authoredRoot);
  const exercises = readJsonArray(
    path.join(sourcePackageRoot, 'exercises.json'),
  ) as unknown as TrainingExerciseMediaExerciseSource[];
  const phase0 = loadPhase0Evidence(phase0Root);
  const result = materializeTrainingExerciseMediaPackage({
    existingExercises: exercises,
    authoredContent: content,
    policy,
    rawMaterializationPolicySha256,
    phase0,
  });
  if (!result.valid || !result.materialized) {
    process.stdout.write(`${JSON.stringify({
      verdict: 'FAIL_MATERIALIZATION_PREFLIGHT',
      materialized: false,
      authoredContentPackageHash: result.authoredContentPackageHash,
      errors: result.errors,
    }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    const finalOwnerApproval = finalOwnerApprovalPath
      ? JSON.parse(fs.readFileSync(finalOwnerApprovalPath, 'utf8'))
      : null;
    const supplementalOwnerApproval = supplementalOwnerApprovalPath
      ? JSON.parse(fs.readFileSync(supplementalOwnerApprovalPath, 'utf8'))
      : null;
    const output = finalOwnerApproval
      ? finalizeMaterializedTrainingExerciseMediaPackage(
        result.materialized,
        finalOwnerApproval,
        supplementalOwnerApproval,
      )
      : result.materialized;
    if (write) writeMaterializedPackage(outputRoot!, output);
    process.stdout.write(`${JSON.stringify({
      verdict: supplementalOwnerApproval
        ? (write ? 'PASS_MATERIALIZED_ACTIVATION_READY' : 'PASS_ACTIVATION_PREFLIGHT')
        : finalOwnerApproval
          ? (write
            ? 'PASS_MATERIALIZED_PENDING_SUPPLEMENTAL_OWNER_APPROVAL'
            : 'PASS_SUPPLEMENTAL_OWNER_APPROVAL_PREFLIGHT')
        : (write ? 'PASS_MATERIALIZED_PENDING_FINAL_OWNER_APPROVAL' : 'PASS_MATERIALIZATION_PREFLIGHT'),
      materialized: write,
      outputRoot: write ? outputRoot : null,
      authoredContentPackageHash: result.authoredContentPackageHash,
      compiledPackageHash: output.compiled.packageHash,
      releaseSubjectHash: output.attestation.releaseSubjectHash,
      finalOwnerApprovalHash: output.attestation.finalOwnerApprovalHash,
      manifestId: output.compiled.manifest.manifestId,
      counts: output.attestation.counts,
      ownerApprovalRef: output.compiled.manifest.ownerApprovalRef,
      activationReady: Boolean(supplementalOwnerApproval),
      nextGate: supplementalOwnerApproval
        ? null
        : finalOwnerApproval
          ? 'SUPPLEMENTAL_OWNER_APPROVAL_BOUND_TO_RELEASE_SUBJECT_HASH'
          : 'FINAL_OWNER_APPROVAL_BOUND_TO_COMPILED_PACKAGE_HASH',
      supplementalApprovalStatement: supplementalOwnerApproval
        ? null
        : buildTrainingExerciseMediaSupplementalApprovalStatement(
          output.attestation.releaseSubject,
          output.attestation.releaseSubjectHash,
        ),
    }, null, 2)}\n`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1);
}

function loadPhase0Evidence(root: string): TrainingExerciseMediaPhase0Evidence {
  const files = {
    eligibilityManifest: 'eligibility-manifest.json',
    artifactIndex: 'artifact-index.json',
    approvalPackage: 'approval-package.json',
    publicationEvidence: 'publication-evidence.json',
  } as const;
  const loaded = Object.fromEntries(Object.entries(files).map(([key, filename]) => {
    const filePath = path.join(root, filename);
    const bytes = fs.readFileSync(filePath);
    return [key, { value: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) }];
  })) as Record<keyof typeof files, { value: Record<string, any>; sha256: string }>;
  return {
    eligibilityManifestSha256: loaded.eligibilityManifest.sha256,
    artifactIndexSha256: loaded.artifactIndex.sha256,
    approvalPackageSha256: loaded.approvalPackage.sha256,
    publicationEvidenceSha256: loaded.publicationEvidence.sha256,
    eligibilityManifest: loaded.eligibilityManifest.value,
    artifactIndex: loaded.artifactIndex.value,
    approvalPackage: loaded.approvalPackage.value,
    publicationEvidence: loaded.publicationEvidence.value,
  };
}

function writeMaterializedPackage(root: string, materialized: MaterializedTrainingExerciseMediaPackage): void {
  if (fs.existsSync(root)) throw new Error(`Output root already exists; refusing to overwrite: ${root}`);
  fs.mkdirSync(root, { recursive: false });
  const fileValues: Record<string, unknown> = {
    'manifest.json': materialized.sourceFiles.manifest,
    'exercises.json': materialized.sourceFiles.exercises,
    'assets.json': materialized.sourceFiles.assets,
    'instructions.json': materialized.sourceFiles.instructions,
    'media-localizations.json': materialized.sourceFiles.mediaLocalizations,
    'provenance.json': materialized.sourceFiles.provenance,
    'reviews.json': materialized.sourceFiles.reviews,
    'takedowns.json': materialized.sourceFiles.takedowns,
    'approval-ledger.json': materialized.sourceFiles.approvalLedger,
    'compiled-manifest.json': materialized.compiled,
    'materialization-attestation.json': materialized.attestation,
  };
  for (const [filename, value] of Object.entries(fileValues)) {
    fs.writeFileSync(path.join(root, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  }
}

function argumentPath(name: string): string | undefined {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  return value ? path.resolve(value) : undefined;
}

function readJsonArray(filePath: string): unknown[] {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(value)) throw new Error(`${filePath} must contain a JSON array.`);
  return value;
}

function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fail(message: string, exitCode: number): never {
  process.stderr.write(`${JSON.stringify({ verdict: 'ERROR', error: message }, null, 2)}\n`);
  process.exit(exitCode);
}
