// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { decryptValue, encryptValue } from '../utils/encryption';
import { createHash } from 'node:crypto';
import type { TrainingPlanCandidateRequest } from './training-plan-revision-candidate-builder';
import type { TrainingRevisionAuthoritativeContextVersions } from './training-plan-revisions';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';

export const TRAINING_PROFILE_SNAPSHOT_KEY_VERSION = 'training-profile-snapshot-aes256gcm.v1' as const;

export interface TrainingProfileSnapshotCanonicalBody {
  profileKind: 'generated' | 'legacy';
  request: TrainingPlanCandidateRequest | null;
  legacySource?: {
    planId: number;
    planVersion: number;
    adaptationRevision: number;
    sourceHash: string;
  };
  catalogVersion: string;
  catalogSourceHash: string;
  policyVersion: string;
  authoritativeSourceVersions?: TrainingRevisionAuthoritativeContextVersions;
  consentContext: { optionalPermissionsUsed: string[] };
  missingInputs: string[];
}

export function encryptTrainingProfileSnapshot(input: {
  body: TrainingProfileSnapshotCanonicalBody;
  userId: number;
  env?: NodeJS.ProcessEnv;
}): { encryptedBody: string; keyVersion: string } {
  const masterKey = requireSnapshotEncryptionKey(input.env);
  return {
    encryptedBody: encryptValue(JSON.stringify(input.body), masterKey, input.userId),
    keyVersion: snapshotKeyVersion(masterKey),
  };
}

export function decryptTrainingProfileSnapshot(input: {
  encryptedBody: string;
  keyVersion: string;
  userId: number;
  env?: NodeJS.ProcessEnv;
}): TrainingProfileSnapshotCanonicalBody {
  const masterKey = requireSnapshotEncryptionKey(input.env);
  if (input.keyVersion !== snapshotKeyVersion(masterKey)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_KEY_VERSION_UNSUPPORTED',
      'The training profile snapshot encryption key version is unavailable.',
      409,
    );
  }
  try {
    return JSON.parse(decryptValue(input.encryptedBody, masterKey, input.userId)) as TrainingProfileSnapshotCanonicalBody;
  } catch {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_DECRYPTION_FAILED',
      'The training profile snapshot could not be revalidated.',
      409,
    );
  }
}

export function assertTrainingProfileSnapshotEncryptionAvailable(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = requireSnapshotEncryptionKey(env);
  return snapshotKeyVersion(key);
}

function requireSnapshotEncryptionKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_UNAVAILABLE',
      'Training plan revisions require snapshot encryption.',
      503,
    );
  }
  return key;
}

function snapshotKeyVersion(masterKey: string): string {
  const fingerprint = createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
  return `${TRAINING_PROFILE_SNAPSHOT_KEY_VERSION}:${fingerprint}`;
}
