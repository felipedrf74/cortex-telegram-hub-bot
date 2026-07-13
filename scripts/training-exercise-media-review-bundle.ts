// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildTrainingExerciseMediaReviewBundle,
  validateTrainingExerciseMediaReviewBundle,
  type TrainingExerciseMediaCandidateArtifactIndex,
  type TrainingExerciseMediaCandidateEligibilityManifest,
  type TrainingExerciseMediaReviewBundle,
} from '../src/services/training-exercise-media-review-bundle';

const outputPath = path.resolve('catalog/training/exercise-media/v1/review-bundle.draft.json');
const candidateRoot = readAbsoluteArgument('--candidate-root');
const artifactRoot = readAbsoluteArgument('--artifact-root');
const write = process.argv.includes('--write');
const check = process.argv.includes('--check');
const metadataOnlyCheck = process.argv.includes('--metadata-only-check');
const validateCheckedIn = process.argv.includes('--validate-checked-in');

if (validateCheckedIn) {
  const bundle = readJson<TrainingExerciseMediaReviewBundle>(outputPath);
  const errors = validateTrainingExerciseMediaReviewBundle(bundle);
  printResult(bundle, errors, false, true, false, false);
  if (errors.length > 0) process.exitCode = 1;
} else {
  const selectedModes = [write, check, metadataOnlyCheck].filter(Boolean).length;
  if (!candidateRoot || selectedModes !== 1) {
    throw new Error('Usage: --candidate-root=/absolute/path --artifact-root=/absolute/path --write|--check, or --candidate-root=/absolute/path --metadata-only-check');
  }
  if ((write || check) && !artifactRoot) {
    throw new Error('--artifact-root is required for --write and --check so external PNG bytes are verified. Use --metadata-only-check for an explicit metadata-only comparison.');
  }
  if (metadataOnlyCheck && artifactRoot) {
    throw new Error('--metadata-only-check must not accept --artifact-root; use --check for full external-object verification.');
  }
  const candidateRealRoot = requireExternalDirectory(candidateRoot, 'candidate root');
  const eligibilityPath = safeChild(candidateRealRoot, 'eligibility-manifest.json');
  const artifactIndexPath = safeChild(candidateRealRoot, 'artifact-index.json');
  const eligibilityBytes = fs.readFileSync(eligibilityPath);
  const artifactIndexBytes = fs.readFileSync(artifactIndexPath);
  const eligibilityManifest = JSON.parse(eligibilityBytes.toString('utf8')) as
    TrainingExerciseMediaCandidateEligibilityManifest;
  const artifactIndex = JSON.parse(artifactIndexBytes.toString('utf8')) as
    TrainingExerciseMediaCandidateArtifactIndex;
  const bundle = buildTrainingExerciseMediaReviewBundle({
    eligibilityManifest,
    artifactIndex,
    candidateManifestSha256: sha256(eligibilityBytes),
    artifactIndexSha256: sha256(artifactIndexBytes),
  });
  const errors = validateTrainingExerciseMediaReviewBundle(bundle);
  if (artifactRoot) errors.push(...verifyExternalObjects(artifactIndex, artifactRoot));
  const expected = `${JSON.stringify(bundle, null, 2)}\n`;
  if (write && errors.length === 0) fs.writeFileSync(outputPath, expected, 'utf8');
  if (check || metadataOnlyCheck) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
    if (current !== expected) errors.push('Checked-in review bundle is missing or stale.');
  }
  printResult(bundle, errors, write, check || metadataOnlyCheck, !!artifactRoot, metadataOnlyCheck);
  if (errors.length > 0) process.exitCode = 1;
}

function verifyExternalObjects(
  index: TrainingExerciseMediaCandidateArtifactIndex,
  suppliedRoot: string,
): string[] {
  const errors: string[] = [];
  const root = requireExternalDirectory(suppliedRoot, 'artifact root');
  let totalBytes = 0;
  for (const object of index.objects) {
    const file = safeChild(root, object.objectKey);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      errors.push(`External object is missing: ${object.sha256}`);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      errors.push(`External object is not a regular file: ${object.sha256}`);
      continue;
    }
    const realFile = fs.realpathSync(file);
    if (!isChild(root, realFile)) {
      errors.push(`External object resolves outside the supplied root: ${object.sha256}`);
      continue;
    }
    const bytes = fs.readFileSync(realFile);
    totalBytes += bytes.length;
    if (sha256(bytes) !== object.sha256
        || bytes.length !== object.byteSize
        || bytes.length < 24
        || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(16) !== object.width
        || bytes.readUInt32BE(20) !== object.height) {
      errors.push(`External object bytes do not match metadata: ${object.sha256}`);
    }
  }
  const diskObjects = listPngs(safeChild(root, 'objects/sha256'));
  if (diskObjects.length !== index.counts.externalizedRootObjectCount
      || totalBytes !== index.counts.externalizedRootObjectBytes) {
    errors.push('External artifact root contains missing, stale, or unindexed PNG objects.');
  }
  return errors;
}

function listPngs(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Artifact tree contains a symlink: ${item}`);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() && entry.name.endsWith('.png')) result.push(item);
    }
  }
  return result;
}

function printResult(
  bundle: TrainingExerciseMediaReviewBundle,
  errors: string[],
  wrote: boolean,
  checked: boolean,
  externalObjectsVerified: boolean,
  metadataOnlyChecked: boolean,
): void {
  process.stdout.write(`${JSON.stringify({
    verdict: errors.length === 0 ? 'PASS_DRAFT_REVIEW_BUNDLE' : 'FAIL',
    status: bundle.status,
    productionReleaseEligible: bundle.productionReleaseEligible,
    bundleHash: bundle.bundleHash,
    coverage: bundle.coverage,
    externalObjectsVerified,
    metadataOnlyChecked,
    wrote,
    checked,
    errors,
  }, null, 2)}\n`);
}

function readAbsoluteArgument(name: string): string | null {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  if (!argument) return null;
  const value = argument.slice(name.length + 1);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

function requireExternalDirectory(value: string, label: string): string {
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} must be a directory.`);
  return real;
}

function safeChild(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error(`Unsafe portable path: ${relativePath}`);
  }
  const resolved = path.resolve(root, relativePath);
  if (!isChild(root, resolved)) throw new Error(`Path escapes supplied root: ${relativePath}`);
  return resolved;
}

function isChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
