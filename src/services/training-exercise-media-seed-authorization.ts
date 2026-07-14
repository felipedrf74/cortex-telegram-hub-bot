// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type TrainingExerciseMediaSeedTarget = 'staging' | 'production';
export type TrainingExerciseMediaSeedAction = 'stage' | 'activate' | 'stage-and-activate';

export interface TrainingExerciseMediaSeedReleaseSubject {
  manifestId: string;
  packageHash: string;
  releaseSubjectHash: string;
  finalOwnerApprovalHash: string;
}

export interface TrainingExerciseMediaSeedAuthorization {
  target: TrainingExerciseMediaSeedTarget;
  action: TrainingExerciseMediaSeedAction;
}

/**
 * Authorizes the operator command before the database is opened. Production is
 * deliberately a two-command first-release path: stage, inspect/read back,
 * then activate. Every production acknowledgement is bound to all immutable
 * release identifiers; the staging acknowledgement cannot be reused.
 */
export function authorizeTrainingExerciseMediaSeed(input: {
  apply: boolean;
  requestedTarget?: string;
  requestedAction?: string;
  legacyActivate: boolean;
  env: NodeJS.ProcessEnv;
  subject: TrainingExerciseMediaSeedReleaseSubject;
}): TrainingExerciseMediaSeedAuthorization | null {
  if (!input.apply) return null;
  assertReleaseSubject(input.subject);

  const target = input.requestedTarget ?? (input.env.NEXUS_STAGING === '1' ? 'staging' : undefined);
  if (target !== 'staging' && target !== 'production') {
    throw new Error('Media seed apply requires explicit --target=staging or --target=production.');
  }

  if (target === 'staging') {
    if (input.requestedAction != null) {
      throw new Error('Staging uses the existing --activate switch; --action is production-only.');
    }
    if (input.env.NEXUS_STAGING !== '1'
      || input.env.TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK !== 'staging-only-reviewed-manifest') {
      throw new Error(
        'Staging media seeding requires NEXUS_STAGING=1 plus '
        + 'TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK=staging-only-reviewed-manifest.',
      );
    }
    return { target, action: input.legacyActivate ? 'stage-and-activate' : 'stage' };
  }

  if (input.legacyActivate) {
    throw new Error(
      'Production rejects combined --apply --activate; use separate --action=stage and --action=activate commands.',
    );
  }
  if (input.requestedAction !== 'stage' && input.requestedAction !== 'activate') {
    throw new Error('Production media seeding requires --action=stage or --action=activate.');
  }
  if (input.env.NODE_ENV !== 'production' || input.env.NEXUS_STAGING === '1') {
    throw new Error('Production media seeding requires NODE_ENV=production and NEXUS_STAGING must not be 1.');
  }
  assertGlobalMediaFlagOff(input.env.TRAINING_EXERCISE_MEDIA_V1_ENABLED);

  const expected = input.subject;
  const supplied = {
    manifestId: input.env.TRAINING_EXERCISE_MEDIA_PRODUCTION_MANIFEST_ID,
    packageHash: input.env.TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH,
    releaseSubjectHash: input.env.TRAINING_EXERCISE_MEDIA_PRODUCTION_RELEASE_SUBJECT_HASH,
    finalOwnerApprovalHash: input.env.TRAINING_EXERCISE_MEDIA_PRODUCTION_FINAL_APPROVAL_HASH,
  };
  if (supplied.manifestId !== expected.manifestId
    || supplied.packageHash !== expected.packageHash
    || supplied.releaseSubjectHash !== expected.releaseSubjectHash
    || supplied.finalOwnerApprovalHash !== expected.finalOwnerApprovalHash) {
    throw new Error('Production media seed release identifiers do not match the checked-in reviewed package.');
  }

  const action = input.requestedAction;
  const ackName = action === 'stage'
    ? 'TRAINING_EXERCISE_MEDIA_PRODUCTION_STAGE_ACK'
    : 'TRAINING_EXERCISE_MEDIA_PRODUCTION_ACTIVATE_ACK';
  const expectedAck = productionSeedAcknowledgement(action, expected);
  if (input.env[ackName] !== expectedAck) {
    throw new Error(`${ackName} is missing or is not bound to the exact reviewed release subject.`);
  }
  return { target, action };
}

export function productionSeedAcknowledgement(
  action: 'stage' | 'activate',
  subject: TrainingExerciseMediaSeedReleaseSubject,
): string {
  assertReleaseSubject(subject);
  return [
    `production-${action}`,
    subject.manifestId,
    subject.packageHash,
    subject.releaseSubjectHash,
    subject.finalOwnerApprovalHash,
  ].join(':');
}

/**
 * Binds the selected target to the deployed checkout and its own data root.
 * This runs before initDatabase so staging credentials cannot be pointed at
 * the production database (or the reverse), including through symlinks.
 */
export function assertTrainingExerciseMediaSeedFilesystemBoundary(input: {
  target: TrainingExerciseMediaSeedTarget;
  workingDirectory: string;
  databasePath: string | undefined;
}): void {
  if (!path.isAbsolute(input.workingDirectory) || !input.databasePath) {
    throw new Error('Media seed requires an absolute checkout and a configured DATABASE_PATH value.');
  }

  const expectedCheckoutName = input.target === 'staging'
    ? 'telegram-hub-bot-staging'
    : 'telegram-hub-bot';
  const checkout = requireNonSymlinkDirectory(input.workingDirectory, 'media seed checkout');
  if (path.basename(checkout) !== expectedCheckoutName) {
    throw new Error(`Media seed ${input.target} target does not match the deployed checkout identity.`);
  }

  const dataRoot = requireNonSymlinkDirectory(path.join(checkout, 'data'), 'media seed data root');
  const configuredDatabase = path.isAbsolute(input.databasePath)
    ? input.databasePath
    : path.resolve(checkout, input.databasePath);
  const database = requireNonSymlinkFile(configuredDatabase, 'media seed database');
  if (!isStrictChild(dataRoot, database)) {
    throw new Error(`Media seed ${input.target} DATABASE_PATH escapes its deployed data root.`);
  }
}

/**
 * Protects the first production publication from silently rotating an existing
 * active package. The activation command is valid only after the exact package
 * has already reached STAGED in a separate invocation.
 */
export function assertTrainingExerciseMediaProductionDatabasePrecondition(
  db: Database.Database,
  subject: TrainingExerciseMediaSeedReleaseSubject,
  action: 'stage' | 'activate',
): void {
  const active = db.prepare(`
    SELECT manifest_id, package_hash
      FROM training_exercise_media_manifests
     WHERE scope_key = '__global__' AND publication_state = 'ACTIVE'
  `).all() as Array<{ manifest_id: string; package_hash: string }>;
  if (active.some((row) => row.manifest_id !== subject.manifestId
    || row.package_hash !== subject.packageHash)) {
    throw new Error('A different global media manifest is already ACTIVE; first-release seeding refuses rotation.');
  }

  const current = db.prepare(`
    SELECT package_hash, publication_state
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(subject.manifestId) as { package_hash: string; publication_state: string } | undefined;
  if (current && current.package_hash !== subject.packageHash) {
    throw new Error('The reviewed media manifest ID already exists with a different package hash.');
  }
  if (action === 'stage' && current?.publication_state === 'ACTIVE') {
    throw new Error('The reviewed media package is already ACTIVE; the stage command is no longer valid.');
  }
  if (action === 'stage' && current
    && current.publication_state !== 'DRAFT' && current.publication_state !== 'STAGED') {
    throw new Error('Production stage requires the exact package to be absent, DRAFT, or STAGED.');
  }
  if (action === 'activate' && current?.publication_state !== 'STAGED'
    && current?.publication_state !== 'ACTIVE') {
    throw new Error('Production activation requires the exact package to be STAGED by a prior command.');
  }
}

function requireNonSymlinkDirectory(value: string, label: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(value);
  } catch {
    throw new Error(`${label} is missing or unreadable.`);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  return fs.realpathSync(value);
}

function requireNonSymlinkFile(value: string, label: string): string {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(value);
  } catch {
    throw new Error(`${label} is missing or unreadable.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1) {
    throw new Error(`${label} must be a single-link, non-symlink regular file.`);
  }
  return fs.realpathSync(value);
}

function isStrictChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..'
    && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertReleaseSubject(subject: TrainingExerciseMediaSeedReleaseSubject): void {
  if (!subject.manifestId.trim()
    || !HASH_PATTERN.test(subject.packageHash)
    || !HASH_PATTERN.test(subject.releaseSubjectHash)
    || !HASH_PATTERN.test(subject.finalOwnerApprovalHash)) {
    throw new Error('Media seed release subject is incomplete or contains a non-canonical hash.');
  }
}

function assertGlobalMediaFlagOff(raw: string | undefined): void {
  const normalized = raw?.trim().toLowerCase();
  if (normalized == null || normalized === ''
    || normalized === 'false' || normalized === 'off'
    || normalized === '0' || normalized === 'disabled') return;
  throw new Error('TRAINING_EXERCISE_MEDIA_V1_ENABLED must remain globally off during production seeding.');
}
