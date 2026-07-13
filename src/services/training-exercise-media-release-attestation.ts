// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import {
  sha256TrainingExerciseMedia,
  stableTrainingExerciseMediaJson,
  type CompiledTrainingExerciseMediaPackage,
  type TrainingExerciseMediaPackageSources,
} from './training-exercise-media-manifest';
import {
  buildTrainingExerciseAuthoredContentPackageHash,
  type TrainingExerciseMediaAuthoredContent,
} from './training-exercise-media-authored-content';
import type { TrainingExerciseMediaMaterializationPolicy } from './training-exercise-media-authored-content-files';

export const TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION =
  'training-exercise-media-materialization-attestation.v2' as const;
export const TRAINING_EXERCISE_MEDIA_RELEASE_SUBJECT_SCHEMA_VERSION =
  'training-exercise-media-release-subject.v2' as const;
export const TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION =
  'training-exercise-media-final-owner-approval.v1' as const;
export const TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION =
  'training-exercise-media-release-subject-owner-approval.v2' as const;
export const TRAINING_EXERCISE_MEDIA_FINAL_APPROVAL_CHAIN_SCHEMA_VERSION =
  'training-exercise-media-final-owner-approval-chain.v2' as const;
export const TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF = 'owner:felipe-dominguez' as const;
export const TRAINING_EXERCISE_MEDIA_FINAL_PACKAGE_REASON = 'FINAL_PACKAGE_HASH_REVIEWED' as const;
export const TRAINING_EXERCISE_MEDIA_FINAL_RELEASE_REASON =
  'FINAL_RELEASE_SUBJECT_HASH_REVIEWED' as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface TrainingExerciseMediaReleaseSubject {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_RELEASE_SUBJECT_SCHEMA_VERSION;
  compiledPackageHash: string;
  authoredContentPackageHash: string;
  rawMaterializationPolicySha256: string;
  canonicalPreOwnerGovernanceLedgerHash: string;
  phase0Subjects: {
    eligibilityManifestSha256: string;
    artifactIndexSha256: string;
    approvalPackageSha256: string;
    publicationEvidenceSha256: string;
  };
  approvedOrigin: string;
  activationPolicyHash: string;
}

export interface TrainingExerciseMediaFinalOwnerApproval {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION;
  status: 'APPROVED';
  approvalId: string;
  reviewerRef: string;
  subjectPackageHash: string;
  reasonCodes: string[];
  reviewedAt: string;
  expiresAt: string | null;
  activatedAt: string;
}

export interface TrainingExerciseMediaSupplementalOwnerApproval {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION;
  status: 'APPROVED';
  approvalId: string;
  reviewerRef: string;
  subjectPackageHash: string;
  subjectReleaseHash: string;
  priorFinalOwnerApprovalRef: string;
  reasonCodes: string[];
  statement: string;
  reviewedAt: string;
  expiresAt: string | null;
  activatedAt: string;
}

export interface TrainingExerciseMediaMaterializationAttestation {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION;
  status:
    | 'MATERIALIZED_PENDING_FINAL_OWNER_APPROVAL'
    | 'MATERIALIZED_PENDING_SUPPLEMENTAL_OWNER_APPROVAL'
    | 'MATERIALIZED_FINAL_OWNER_APPROVED';
  catalogVersion: string;
  catalogSourceHash: string;
  releaseSubject: TrainingExerciseMediaReleaseSubject;
  releaseSubjectHash: string;
  compiledPackageHash: string;
  manifestId: string;
  counts: {
    exercises: number;
    assets: number;
    instructions: number;
    mediaLocalizations: number;
    provenance: number;
    assetReviews: number;
    localizationReviews: number;
    hostApprovals: number;
    ownerApprovals: number;
  };
  finalOwnerApprovalRequired: true;
  supplementalOwnerApprovalRequired: true;
  finalOwnerApprovalRef: string | null;
  finalPackageOwnerApproval: TrainingExerciseMediaFinalOwnerApproval | null;
  supplementalOwnerApproval: TrainingExerciseMediaSupplementalOwnerApproval | null;
  finalOwnerApprovalHash: string | null;
}

export interface TrainingExerciseMediaReleaseAttestationValidation {
  valid: boolean;
  activationReady: boolean;
  errors: string[];
  releaseSubjectHash: string;
  finalOwnerApprovalHash: string | null;
}

export function sha256TrainingExerciseMediaRawBytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function buildTrainingExerciseMediaActivationPolicyHash(
  policy: TrainingExerciseMediaMaterializationPolicy,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: policy.schemaVersion,
    status: policy.status,
    phase0Subjects: { ...policy.phase0Subjects },
    approvedOrigin: policy.approvedOrigin,
    phase0ReviewImport: { ...policy.phase0ReviewImport },
    contentReview: { ...policy.contentReview },
    rights: {
      ...policy.rights,
      territories: [...policy.rights.territories].sort(),
    },
  });
}

export function buildTrainingExerciseMediaPreOwnerGovernanceLedgerHash(
  sources: Pick<TrainingExerciseMediaPackageSources,
  'manifest' | 'reviews' | 'localizationReviews' | 'hostApprovals'>,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: 'training-exercise-media-pre-owner-governance-ledger.v2',
    approvedHostRef: sources.manifest.approvedHostRef,
    ownerApprovalRef: null,
    assetReviews: [...sources.reviews]
      .map((entry) => ({ ...entry, reasonCodes: [...entry.reasonCodes].sort() }))
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
    localizationReviews: [...sources.localizationReviews]
      .map((entry) => ({ ...entry, reasonCodes: [...entry.reasonCodes].sort() }))
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
    hostApprovals: [...sources.hostApprovals]
      .map((entry) => ({
        ...entry,
        subjectOrigins: [...entry.subjectOrigins].sort(),
        reasonCodes: [...entry.reasonCodes].sort(),
      }))
      .sort((left, right) => left.approvalId.localeCompare(right.approvalId)),
    ownerApprovals: [],
  });
}

export function buildTrainingExerciseMediaReleaseSubject(input: {
  compiledPackageHash: string;
  authoredContentPackageHash: string;
  rawMaterializationPolicySha256: string;
  canonicalPreOwnerGovernanceLedgerHash: string;
  phase0Subjects: TrainingExerciseMediaReleaseSubject['phase0Subjects'];
  approvedOrigin: string;
  activationPolicyHash: string;
}): TrainingExerciseMediaReleaseSubject {
  return {
    schemaVersion: TRAINING_EXERCISE_MEDIA_RELEASE_SUBJECT_SCHEMA_VERSION,
    compiledPackageHash: input.compiledPackageHash,
    authoredContentPackageHash: input.authoredContentPackageHash,
    rawMaterializationPolicySha256: input.rawMaterializationPolicySha256,
    canonicalPreOwnerGovernanceLedgerHash: input.canonicalPreOwnerGovernanceLedgerHash,
    phase0Subjects: { ...input.phase0Subjects },
    approvedOrigin: input.approvedOrigin,
    activationPolicyHash: input.activationPolicyHash,
  };
}

export function buildTrainingExerciseMediaReleaseSubjectHash(
  subject: TrainingExerciseMediaReleaseSubject,
): string {
  return sha256TrainingExerciseMedia(subject);
}

export function expectedTrainingExerciseMediaFinalApprovalId(
  packageHash: string,
  reviewedAt: string,
): string {
  return `training-media-final-owner-approval-${reviewedAt.slice(0, 10)}-${packageHash.slice(0, 8)}`;
}

export function expectedTrainingExerciseMediaSupplementalApprovalId(
  releaseSubjectHash: string,
  reviewedAt: string,
): string {
  return `training-media-release-subject-owner-approval-${reviewedAt.slice(0, 10)}-${releaseSubjectHash.slice(0, 8)}`;
}

export function buildTrainingExerciseMediaSupplementalApprovalStatement(
  subject: TrainingExerciseMediaReleaseSubject,
  releaseSubjectHash = buildTrainingExerciseMediaReleaseSubjectHash(subject),
): string {
  return `I approve final activation of Training exercise-media release subject ${releaseSubjectHash}, binding compiled package ${subject.compiledPackageHash}, authored content ${subject.authoredContentPackageHash}, raw materialization policy ${subject.rawMaterializationPolicySha256}, canonical pre-owner governance ledger ${subject.canonicalPreOwnerGovernanceLedgerHash}, Phase 0 eligibility manifest ${subject.phase0Subjects.eligibilityManifestSha256}, artifact index ${subject.phase0Subjects.artifactIndexSha256}, approval package ${subject.phase0Subjects.approvalPackageSha256}, publication evidence ${subject.phase0Subjects.publicationEvidenceSha256}, approved origin ${subject.approvedOrigin}, and activation policy ${subject.activationPolicyHash}.`;
}

export function buildTrainingExerciseMediaFinalOwnerApprovalHash(
  finalPackageApproval: TrainingExerciseMediaFinalOwnerApproval,
  supplementalApproval: TrainingExerciseMediaSupplementalOwnerApproval,
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_FINAL_APPROVAL_CHAIN_SCHEMA_VERSION,
    finalPackageApproval,
    supplementalApproval,
  });
}

export function validateTrainingExerciseMediaFinalPackageApproval(
  approval: TrainingExerciseMediaFinalOwnerApproval,
  packageHash: string,
  now = new Date(),
): string[] {
  const errors: string[] = [];
  const reasonCodes = Array.isArray(approval.reasonCodes) ? approval.reasonCodes : [];
  const reviewedAt = typeof approval.reviewedAt === 'string' ? approval.reviewedAt : '';
  if (!hasExactKeys(approval, [
    'schemaVersion', 'status', 'approvalId', 'reviewerRef', 'subjectPackageHash',
    'reasonCodes', 'reviewedAt', 'expiresAt', 'activatedAt',
  ])) errors.push('Final package approval contains unknown or missing fields.');
  if (approval.schemaVersion !== TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION
    || approval.status !== 'APPROVED') errors.push('Final package approval schema or status is invalid.');
  if (approval.reviewerRef !== TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF) {
    errors.push('Final package approval reviewer is not the accountable owner.');
  }
  if (!sameStrings(reasonCodes, [TRAINING_EXERCISE_MEDIA_FINAL_PACKAGE_REASON])) {
    errors.push('Final package approval reason is not the exact reviewed-package reason.');
  }
  if (approval.subjectPackageHash !== packageHash || !HASH_PATTERN.test(packageHash)) {
    errors.push('Final package approval is not bound to the exact compiled package hash.');
  }
  if (approval.approvalId !== expectedTrainingExerciseMediaFinalApprovalId(packageHash, reviewedAt)) {
    errors.push('Final package approval ID is not canonical for its review date and package hash.');
  }
  validateApprovalTimes(approval, now, errors, 'Final package approval');
  return errors;
}

export function validateTrainingExerciseMediaSupplementalApproval(
  approval: TrainingExerciseMediaSupplementalOwnerApproval,
  subject: TrainingExerciseMediaReleaseSubject,
  finalPackageApproval: TrainingExerciseMediaFinalOwnerApproval,
  now = new Date(),
): string[] {
  const errors: string[] = [];
  const releaseSubjectHash = buildTrainingExerciseMediaReleaseSubjectHash(subject);
  const reasonCodes = Array.isArray(approval.reasonCodes) ? approval.reasonCodes : [];
  const reviewedAt = typeof approval.reviewedAt === 'string' ? approval.reviewedAt : '';
  if (!hasExactKeys(approval, [
    'schemaVersion', 'status', 'approvalId', 'reviewerRef', 'subjectPackageHash',
    'subjectReleaseHash', 'priorFinalOwnerApprovalRef', 'reasonCodes', 'statement',
    'reviewedAt', 'expiresAt', 'activatedAt',
  ])) errors.push('Supplemental release approval contains unknown or missing fields.');
  if (approval.schemaVersion !== TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION
    || approval.status !== 'APPROVED') errors.push('Supplemental release approval schema or status is invalid.');
  if (approval.reviewerRef !== TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF) {
    errors.push('Supplemental release approval reviewer is not the accountable owner.');
  }
  if (!sameStrings(reasonCodes, [TRAINING_EXERCISE_MEDIA_FINAL_RELEASE_REASON])) {
    errors.push('Supplemental release approval reason is not the exact release-subject reason.');
  }
  if (approval.subjectPackageHash !== subject.compiledPackageHash
    || approval.subjectReleaseHash !== releaseSubjectHash) {
    errors.push('Supplemental release approval is not bound to the exact package and release-subject hashes.');
  }
  if (approval.priorFinalOwnerApprovalRef !== finalPackageApproval.approvalId) {
    errors.push('Supplemental release approval does not extend the exact final package approval.');
  }
  if (approval.approvalId !== expectedTrainingExerciseMediaSupplementalApprovalId(
    releaseSubjectHash, reviewedAt,
  )) errors.push('Supplemental release approval ID is not canonical for its review date and release hash.');
  if (approval.statement !== buildTrainingExerciseMediaSupplementalApprovalStatement(subject, releaseSubjectHash)) {
    errors.push('Supplemental release approval statement does not enumerate the exact release subject.');
  }
  validateApprovalTimes(approval, now, errors, 'Supplemental release approval');
  if (isIsoInstant(approval.reviewedAt) && isIsoInstant(finalPackageApproval.reviewedAt)
    && Date.parse(approval.reviewedAt) < Date.parse(finalPackageApproval.reviewedAt)) {
    errors.push('Supplemental release approval predates the final package approval it extends.');
  }
  if (isIsoInstant(approval.reviewedAt) && isIsoInstant(finalPackageApproval.activatedAt)
    && Date.parse(approval.reviewedAt) < Date.parse(finalPackageApproval.activatedAt)) {
    errors.push('Supplemental release approval predates final package activation.');
  }
  return errors;
}

export function validateTrainingExerciseMediaMaterializationAttestation(input: {
  attestation: unknown;
  compiled: CompiledTrainingExerciseMediaPackage;
  authoredContent: TrainingExerciseMediaAuthoredContent;
  policy: TrainingExerciseMediaMaterializationPolicy;
  rawMaterializationPolicySha256: string;
  requireActivation?: boolean;
  now?: Date;
}): TrainingExerciseMediaReleaseAttestationValidation {
  const errors: string[] = [];
  const now = input.now ?? new Date();
  const authoredContentPackageHash = buildTrainingExerciseAuthoredContentPackageHash(input.authoredContent);
  const expectedSubject = buildTrainingExerciseMediaReleaseSubject({
    compiledPackageHash: input.compiled.packageHash,
    authoredContentPackageHash,
    rawMaterializationPolicySha256: input.rawMaterializationPolicySha256,
    canonicalPreOwnerGovernanceLedgerHash:
      buildTrainingExerciseMediaPreOwnerGovernanceLedgerHash(input.compiled),
    phase0Subjects: requiredPolicySubjects(input.policy, errors),
    approvedOrigin: input.policy.approvedOrigin,
    activationPolicyHash: buildTrainingExerciseMediaActivationPolicyHash(input.policy),
  });
  const expectedReleaseSubjectHash = buildTrainingExerciseMediaReleaseSubjectHash(expectedSubject);
  if (!isAttestation(input.attestation)) {
    return {
      valid: false,
      activationReady: false,
      errors: ['Materialization attestation v2 is absent or malformed.'],
      releaseSubjectHash: expectedReleaseSubjectHash,
      finalOwnerApprovalHash: null,
    };
  }
  const attestation = input.attestation;
  if (!hasExactKeys(attestation, [
    'schemaVersion', 'status', 'catalogVersion', 'catalogSourceHash', 'releaseSubject',
    'releaseSubjectHash', 'compiledPackageHash', 'manifestId', 'counts',
    'finalOwnerApprovalRequired', 'supplementalOwnerApprovalRequired', 'finalOwnerApprovalRef',
    'finalPackageOwnerApproval', 'supplementalOwnerApproval', 'finalOwnerApprovalHash',
  ])) errors.push('Materialization attestation contains unknown or missing fields.');
  if (attestation.schemaVersion !== TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION) {
    errors.push('Materialization attestation schema version is not v2.');
  }
  if (stableTrainingExerciseMediaJson(attestation.releaseSubject)
    !== stableTrainingExerciseMediaJson(expectedSubject)) {
    errors.push('Materialization attestation release commitments drifted from current sources.');
  }
  if (attestation.releaseSubjectHash !== expectedReleaseSubjectHash
    || !HASH_PATTERN.test(attestation.releaseSubjectHash)) {
    errors.push('Materialization attestation releaseSubjectHash is invalid.');
  }
  if (attestation.compiledPackageHash !== input.compiled.packageHash
    || attestation.manifestId !== input.compiled.manifest.manifestId
    || attestation.catalogVersion !== input.compiled.manifest.catalogVersion
    || attestation.catalogSourceHash !== input.compiled.manifest.catalogSourceHash) {
    errors.push('Materialization attestation package or catalog identity drifted.');
  }
  const expectedCounts = countsFor(input.compiled);
  if (stableTrainingExerciseMediaJson(attestation.counts)
    !== stableTrainingExerciseMediaJson(expectedCounts)) {
    errors.push('Materialization attestation counts drifted from current sources.');
  }
  if (attestation.finalOwnerApprovalRequired !== true
    || attestation.supplementalOwnerApprovalRequired !== true) {
    errors.push('Materialization attestation does not require both owner approvals.');
  }

  let expectedFinalOwnerApprovalHash: string | null = null;
  const hasFinalPackageApproval = isRecord(attestation.finalPackageOwnerApproval);
  const hasSupplementalApproval = isRecord(attestation.supplementalOwnerApproval);
  if (attestation.finalPackageOwnerApproval != null && !hasFinalPackageApproval) {
    errors.push('Embedded final package approval is malformed.');
  }
  if (attestation.supplementalOwnerApproval != null && !hasSupplementalApproval) {
    errors.push('Embedded supplemental release approval is malformed.');
  }
  let finalPackageApprovalValid = false;
  let supplementalApprovalValid = false;
  if (hasFinalPackageApproval) {
    const finalPackageApprovalErrors = validateTrainingExerciseMediaFinalPackageApproval(
      attestation.finalPackageOwnerApproval!, input.compiled.packageHash, now,
    );
    errors.push(...finalPackageApprovalErrors);
    if (finalPackageApprovalErrors.length === 0) {
      finalPackageApprovalValid = true;
      if (attestation.finalOwnerApprovalRef !== attestation.finalPackageOwnerApproval!.approvalId
        || input.compiled.manifest.ownerApprovalRef !== attestation.finalPackageOwnerApproval!.approvalId
        || !compiledContainsFinalApproval(input.compiled, attestation.finalPackageOwnerApproval!)) {
        finalPackageApprovalValid = false;
        errors.push('Final package approval is not identical across attestation, manifest, and durable ledger.');
      }
    }
  } else if (attestation.finalOwnerApprovalRef != null || input.compiled.manifest.ownerApprovalRef != null) {
    errors.push('Manifest or attestation references final approval evidence that is not embedded.');
  }
  if (hasSupplementalApproval && hasFinalPackageApproval) {
    const supplementalApprovalErrors = validateTrainingExerciseMediaSupplementalApproval(
      attestation.supplementalOwnerApproval!, expectedSubject,
      attestation.finalPackageOwnerApproval!, now,
    );
    errors.push(...supplementalApprovalErrors);
    if (supplementalApprovalErrors.length === 0 && finalPackageApprovalValid) {
      supplementalApprovalValid = true;
      expectedFinalOwnerApprovalHash = buildTrainingExerciseMediaFinalOwnerApprovalHash(
        attestation.finalPackageOwnerApproval!, attestation.supplementalOwnerApproval!,
      );
      if (attestation.finalOwnerApprovalHash !== expectedFinalOwnerApprovalHash
        || !HASH_PATTERN.test(attestation.finalOwnerApprovalHash ?? '')) {
        supplementalApprovalValid = false;
        errors.push('Materialization attestation finalOwnerApprovalHash is invalid.');
      }
      if (input.compiled.manifest.activatedAt !== attestation.supplementalOwnerApproval!.activatedAt) {
        supplementalApprovalValid = false;
        errors.push('Manifest activation timestamp is not bound to the supplemental release approval.');
      }
    }
  } else if (hasSupplementalApproval) {
    errors.push('Supplemental release approval exists without its final package approval.');
  } else if (attestation.finalOwnerApprovalHash != null) {
    errors.push('Materialization attestation has a final approval hash without the complete approval chain.');
  }

  const approvalChainComplete = finalPackageApprovalValid && supplementalApprovalValid
    && expectedFinalOwnerApprovalHash != null;
  if (approvalChainComplete && attestation.status !== 'MATERIALIZED_FINAL_OWNER_APPROVED') {
    errors.push('Complete owner approval chain is not marked final-owner-approved.');
  }
  if (hasFinalPackageApproval && !hasSupplementalApproval
    && attestation.status !== 'MATERIALIZED_PENDING_SUPPLEMENTAL_OWNER_APPROVAL') {
    errors.push('Incomplete release approval chain is not marked pending supplemental approval.');
  }
  if (!hasFinalPackageApproval
    && attestation.status !== 'MATERIALIZED_PENDING_FINAL_OWNER_APPROVAL') {
    errors.push('Owner-approval-free attestation is not marked pending final package approval.');
  }
  if (input.requireActivation && !approvalChainComplete) {
    errors.push('Activation requires the exact supplemental release-subject owner approval.');
  }

  const valid = errors.length === 0;
  return {
    valid,
    activationReady: valid && approvalChainComplete,
    errors: unique(errors),
    releaseSubjectHash: expectedReleaseSubjectHash,
    finalOwnerApprovalHash: expectedFinalOwnerApprovalHash,
  };
}

function requiredPolicySubjects(
  policy: TrainingExerciseMediaMaterializationPolicy,
  errors: string[],
): TrainingExerciseMediaReleaseSubject['phase0Subjects'] {
  const phase0Subjects = policy.phase0Subjects;
  const values = {
    eligibilityManifestSha256: phase0Subjects.eligibilityManifestSha256,
    artifactIndexSha256: phase0Subjects.artifactIndexSha256,
    approvalPackageSha256: phase0Subjects.approvalPackageSha256 ?? '',
    publicationEvidenceSha256: phase0Subjects.publicationEvidenceSha256 ?? '',
  };
  if (Object.values(values).some((value) => !HASH_PATTERN.test(value))) {
    errors.push('Materialization policy does not contain four exact Phase 0 subject hashes.');
  }
  return values;
}

function countsFor(compiled: CompiledTrainingExerciseMediaPackage): TrainingExerciseMediaMaterializationAttestation['counts'] {
  return {
    exercises: compiled.exercises.length,
    assets: compiled.assets.length,
    instructions: compiled.instructions.length,
    mediaLocalizations: compiled.mediaLocalizations.length,
    provenance: compiled.provenance.length,
    assetReviews: compiled.reviews.length,
    localizationReviews: compiled.localizationReviews.length,
    hostApprovals: compiled.hostApprovals.length,
    ownerApprovals: compiled.ownerApprovals.length,
  };
}

function compiledContainsFinalApproval(
  compiled: CompiledTrainingExerciseMediaPackage,
  approval: TrainingExerciseMediaFinalOwnerApproval,
): boolean {
  if (compiled.ownerApprovals.length !== 1) return false;
  const stored = compiled.ownerApprovals[0];
  return stableTrainingExerciseMediaJson(stored) === stableTrainingExerciseMediaJson({
    approvalId: approval.approvalId,
    status: approval.status,
    reviewerRef: approval.reviewerRef,
    subjectPackageHash: approval.subjectPackageHash,
    reasonCodes: [...approval.reasonCodes].sort(),
    reviewedAt: approval.reviewedAt,
    expiresAt: approval.expiresAt,
    createdAt: compiled.manifest.createdAt,
  });
}

function validateApprovalTimes(
  approval: { reviewedAt: string; expiresAt: string | null; activatedAt: string },
  now: Date,
  errors: string[],
  label: string,
): void {
  if (!isIsoInstant(approval.reviewedAt) || !isIsoInstant(approval.activatedAt)
    || Date.parse(approval.reviewedAt) > now.getTime()
    || Date.parse(approval.activatedAt) > now.getTime()
    || Date.parse(approval.activatedAt) < Date.parse(approval.reviewedAt)
    || (approval.expiresAt != null && (!isIsoInstant(approval.expiresAt)
      || Date.parse(approval.expiresAt) <= now.getTime()))) {
    errors.push(`${label} timestamps are invalid.`);
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return sameStrings(actual, expected);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isAttestation(value: unknown): value is TrainingExerciseMediaMaterializationAttestation {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
