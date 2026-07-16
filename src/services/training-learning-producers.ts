// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TrainingExerciseMediaBatchDto } from './training-exercise-media';
import type { TrainingPlanRevisionReviewReadModel } from './training-plan-revision-read-model';
import {
  recordTrainingLearningObservation,
  trainingLearningExpectedContract,
  type LearningCase,
  type TrainingLearningKind,
} from './product-learning';

export const TRAINING_LEARNING_PRODUCER_VERSION = 'training-learning-producers.v2' as const;

export interface TrainingLearningScope {
  tenantId: number;
  userId: number;
}

export type PhysicalDeviceCheckCode =
  | 'availability_refresh'
  | 'review_availability'
  | 'install'
  | 'launch'
  | 'training_smoke'
  | 'media_smoke';

export interface PhysicalDeviceLearningObservation {
  observationId: string;
  tenantId: number;
  userId: number;
  buildNumber: string;
  checkCode: PhysicalDeviceCheckCode;
  result: 'passed' | 'failed';
  evidenceReference: string;
  observedAt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_OBSERVATION_ID = /^[a-z0-9][a-z0-9_.:-]{0,119}$/;
const CAPACITY_EDIT_FIELDS = new Set([
  'availableDays',
  'horizonWeeks',
  'sessionDurationMinutes',
  'sessionsPerWeek',
]);
const PHYSICAL_DEVICE_CHECK_CODES = new Set<PhysicalDeviceCheckCode>([
  'availability_refresh',
  'review_availability',
  'install',
  'launch',
  'training_smoke',
  'media_smoke',
]);

function assertScope(scope: TrainingLearningScope): void {
  if (!Number.isInteger(scope.tenantId) || scope.tenantId <= 0
      || !Number.isInteger(scope.userId) || scope.userId <= 0) {
    throw new Error('training learning producer requires an exact positive tenant and user scope');
  }
}

function digest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function opaqueEvidenceReference(surface: string, fingerprint: string): string {
  return `outcome://training/${surface}/${fingerprint}`;
}

function recordClosedObservation(input: {
  scope: TrainingLearningScope;
  kind: TrainingLearningKind;
  outcomeCode: string;
  subjectFingerprint: string;
  evidenceReference: string;
  observedAt: string;
  producerVersion?: string;
  confidence?: number;
  idSeed?: string;
}, db?: Database.Database): LearningCase {
  assertScope(input.scope);
  const expectedContractId = trainingLearningExpectedContract(input.kind, input.outcomeCode);
  if (!expectedContractId || !SHA256.test(input.subjectFingerprint)) {
    throw new Error('training learning producer observation is outside the governed taxonomy');
  }
  const caseDigest = digest([
    input.scope.tenantId,
    input.scope.userId,
    input.kind,
    input.outcomeCode,
    input.idSeed ?? input.subjectFingerprint,
  ]);
  return recordTrainingLearningObservation({
    id: `training-${input.kind.replaceAll('_', '-')}-${caseDigest.slice(0, 32)}`,
    tenantId: input.scope.tenantId,
    userId: input.scope.userId,
    kind: input.kind,
    outcomeCode: input.outcomeCode,
    expectedContractId,
    evidenceReferences: [input.evidenceReference],
    producerVersion: input.producerVersion ?? TRAINING_LEARNING_PRODUCER_VERSION,
    confidence: input.confidence ?? 1,
    observedAt: input.observedAt,
    subjectFingerprint: input.subjectFingerprint,
  }, db);
}

/**
 * Converts an explicit user edit into bounded observations. Only field names
 * influence the capacity classification; values and rationale never enter the
 * learning store.
 */
export function recordTrainingPlanCorrectionObservations(input: {
  scope: TrainingLearningScope;
  currentContentHash: string;
  proposedContentHash: string;
  changedFields: readonly string[];
  observedAt: string;
}, db?: Database.Database): LearningCase[] {
  assertScope(input.scope);
  if (!SHA256.test(input.currentContentHash) || !SHA256.test(input.proposedContentHash)) {
    throw new Error('training plan correction requires immutable content hashes');
  }
  const normalizedFields = [...new Set(input.changedFields.filter((field) => typeof field === 'string'))]
    .sort();
  const subjectFingerprint = digest([
    input.scope.tenantId,
    input.scope.userId,
    input.currentContentHash,
    input.proposedContentHash,
    normalizedFields,
  ]);
  const evidenceReference = opaqueEvidenceReference('plan-correction', subjectFingerprint);
  const cases = [recordClosedObservation({
    scope: input.scope,
    kind: 'plan_correction',
    outcomeCode: 'user_corrected',
    subjectFingerprint,
    evidenceReference,
    observedAt: input.observedAt,
  }, db)];
  if (normalizedFields.some((field) => CAPACITY_EDIT_FIELDS.has(field))) {
    cases.push(recordClosedObservation({
      scope: input.scope,
      kind: 'capacity_conflict_accuracy',
      outcomeCode: 'corrected',
      subjectFingerprint,
      evidenceReference,
      observedAt: input.observedAt,
    }, db));
  }
  return cases;
}

/** Records only detected compatibility fallback; normal reads do not create noise. */
export function recordTrainingCompatibilityRegression(input: {
  scope: TrainingLearningScope;
  revisionId: string;
  contentHash: string;
  reviewModel: TrainingPlanRevisionReviewReadModel;
  observedAt: string;
}, db?: Database.Database): LearningCase | null {
  assertScope(input.scope);
  if (!SHA256.test(input.contentHash)) {
    throw new Error('training compatibility observation requires an immutable content hash');
  }
  const fallbackCount = input.reviewModel.weeks.reduce(
    (count, week) => count + week.workouts.filter((workout) => workout.fallbackUsed).length,
    0,
  );
  if (input.reviewModel.presentationMode !== 'UNKNOWN_FALLBACK' && fallbackCount === 0) return null;
  const subjectFingerprint = digest([
    input.scope.tenantId,
    input.scope.userId,
    input.revisionId,
    input.contentHash,
    input.reviewModel.presentationMode,
    fallbackCount,
  ]);
  return recordClosedObservation({
    scope: input.scope,
    kind: 'compatibility_regression',
    outcomeCode: 'detected',
    subjectFingerprint,
    evidenceReference: opaqueEvidenceReference('compatibility', subjectFingerprint),
    observedAt: input.observedAt,
  }, db);
}

/**
 * Derives daily, idempotent media observations from the already-sanitized
 * media availability contract. Requested exercise identifiers are never
 * persisted; only a scoped digest of the response identity is retained.
 */
export function recordTrainingMediaLookupObservations(input: {
  scope: TrainingLearningScope;
  result: TrainingExerciseMediaBatchDto;
  observedAt?: string;
}, db?: Database.Database): LearningCase[] {
  assertScope(input.scope);
  const clock = input.observedAt ? new Date(input.observedAt) : new Date();
  if (!Number.isFinite(clock.getTime())) throw new Error('training media observation clock is invalid');
  const observedAt = `${clock.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const conditions = new Map<string, { kind: TrainingLearningKind; outcomeCode: string }>();
  const addCondition = (kind: TrainingLearningKind, outcomeCode: string): void => {
    conditions.set(`${kind}:${outcomeCode}`, { kind, outcomeCode });
  };
  for (const item of input.result.items) {
    if (item.kind === 'UNAVAILABLE') {
      if (item.reason === 'UNKNOWN_EXERCISE' || item.reason === 'AMBIGUOUS_ALIAS') {
        addCondition('media_missing_mapping', 'mapping_missing');
      }
      if (item.reason === 'MEDIA_UNAVAILABLE' && input.result.requestedLocale !== 'en-US') {
        addCondition('media_fallback', 'fallback_failed');
      }
      continue;
    }
    if (item.instruction.fallbackFromLocale != null
        || item.assets.some((asset) => asset.fallbackFromLocale != null)) {
      addCondition('media_fallback', 'fallback_used');
    }
  }
  return [...conditions.values()].map(({ kind, outcomeCode }) => {
    const subjectFingerprint = digest([
      input.scope.tenantId,
      input.scope.userId,
      input.result.schemaVersion,
      input.result.manifestVersion,
      input.result.eTag,
      observedAt,
      kind,
      outcomeCode,
    ]);
    return recordClosedObservation({
      scope: input.scope,
      kind,
      outcomeCode,
      subjectFingerprint,
      evidenceReference: opaqueEvidenceReference('media', subjectFingerprint),
      observedAt,
    }, db);
  });
}

/**
 * Physical-device evidence cannot be inferred by the server. This explicit,
 * closed contract accepts only a reviewed TestFlight build/check/result tuple;
 * it has no free-form note or raw device/calendar payload.
 */
export function recordPhysicalDeviceLearningObservation(
  input: PhysicalDeviceLearningObservation,
  db?: Database.Database,
): LearningCase {
  const scope = { tenantId: input.tenantId, userId: input.userId };
  assertScope(scope);
  if (input.tenantId !== input.userId
      || !SAFE_OBSERVATION_ID.test(input.observationId)
      || !/^[0-9]{1,9}$/.test(input.buildNumber)
      || !PHYSICAL_DEVICE_CHECK_CODES.has(input.checkCode)
      || !['passed', 'failed'].includes(input.result)
      || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error('physical-device learning observation contract is invalid');
  }
  const expectedEvidence = `testflight://build/${input.buildNumber}/${input.checkCode.replaceAll('_', '-')}`;
  if (input.evidenceReference !== expectedEvidence) {
    throw new Error('physical-device evidence must bind the exact TestFlight build and check');
  }
  const subjectFingerprint = digest([
    input.tenantId,
    input.userId,
    input.observationId,
    input.buildNumber,
    input.checkCode,
    input.result,
  ]);
  return recordClosedObservation({
    scope,
    kind: 'physical_device_observation',
    outcomeCode: input.result,
    subjectFingerprint,
    evidenceReference: input.evidenceReference,
    observedAt: new Date(input.observedAt).toISOString(),
    idSeed: input.observationId,
  }, db);
}
