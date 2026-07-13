// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES,
  buildCompiledTrainingExerciseMediaPackage,
  buildTrainingExerciseMediaAccessibilityBundleHash,
  buildTrainingExerciseMediaOriginsHash,
  sha256TrainingExerciseMedia,
  validateCompiledTrainingExerciseMediaPackage,
  type CompiledTrainingExerciseMediaPackage,
  type TrainingExerciseMediaApprovalLedgerSource,
  type TrainingExerciseMediaAssetSource,
  type TrainingExerciseMediaExerciseSource,
  type TrainingExerciseMediaHostApprovalSource,
  type TrainingExerciseMediaLocalizationReviewSource,
  type TrainingExerciseMediaLocalizationSource,
  type TrainingExerciseMediaOwnerApprovalSource,
  type TrainingExerciseMediaPackageSources,
  type TrainingExerciseMediaProvenanceSource,
  type TrainingExerciseMediaReviewSource,
} from '../../src/services/training-exercise-media-manifest';
import {
  assertTrainingExerciseMediaAuthoredContent,
  buildTrainingExerciseAuthoredContentPackageHash,
  trainingExerciseMediaAssetMappingKey,
  type TrainingExerciseMediaAuthoredContent,
  type TrainingExerciseMediaExpectedAssetMapping,
} from '../../src/services/training-exercise-media-authored-content';
import type { TrainingExerciseMediaMaterializationPolicy } from './training-exercise-media-authored-content';
import {
  TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION,
  buildTrainingExerciseMediaActivationPolicyHash,
  buildTrainingExerciseMediaFinalOwnerApprovalHash,
  buildTrainingExerciseMediaPreOwnerGovernanceLedgerHash,
  buildTrainingExerciseMediaReleaseSubject,
  buildTrainingExerciseMediaReleaseSubjectHash,
  validateTrainingExerciseMediaFinalPackageApproval,
  validateTrainingExerciseMediaSupplementalApproval,
  type TrainingExerciseMediaFinalOwnerApproval,
  type TrainingExerciseMediaMaterializationAttestation,
  type TrainingExerciseMediaSupplementalOwnerApproval,
} from './training-exercise-media-release-attestation';

export {
  TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION,
  buildTrainingExerciseMediaSupplementalApprovalStatement,
  expectedTrainingExerciseMediaSupplementalApprovalId,
  type TrainingExerciseMediaFinalOwnerApproval,
  type TrainingExerciseMediaMaterializationAttestation,
  type TrainingExerciseMediaSupplementalOwnerApproval,
} from './training-exercise-media-release-attestation';
export const TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256 =
  '45eb4a62d83417dbe5cb797940e21bbf2567c1b1b5a1d1c489c2533cd1072e10' as const;
export const TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256 =
  '29e3d9becd6d02a815c17496b5fb5aaba451d698be753ba30fbe14bb26372481' as const;
export const TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256 =
  'c7eaa1448b2259a75922a4782139e78429951c073a55c873498f65b8cf4aea3f' as const;
export const TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN = 'https://media.nexushub.me' as const;

const APPROVAL_STATEMENT = 'I approve the Training exercise-media v6 review subjects for publication preparation: eligibility manifest 45eb4a62d83417dbe5cb797940e21bbf2567c1b1b5a1d1c489c2533cd1072e10 and artifact index 29e3d9becd6d02a815c17496b5fb5aaba451d698be753ba30fbe14bb26372481, covering 158 canonical exercises, 200 selected mappings, and 196 unique selected binaries. All six reviews—domain, legal/license, accessibility, owner publication, localization (en-US, pt-PT, pt-BR), and approved host—are complete for these exact subjects. Approved host: https://media.nexushub.me. This authorizes publication preparation only; final activation will still bind the compiled package hash.';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export interface TrainingExerciseMediaPhase0Evidence {
  eligibilityManifestSha256: string;
  artifactIndexSha256: string;
  approvalPackageSha256: string;
  publicationEvidenceSha256: string;
  eligibilityManifest: Record<string, any>;
  artifactIndex: Record<string, any>;
  approvalPackage: Record<string, any>;
  publicationEvidence: Record<string, any>;
}

export interface MaterializedTrainingExerciseMediaPackage {
  sourceFiles: {
    manifest: TrainingExerciseMediaPackageSources['manifest'];
    exercises: TrainingExerciseMediaPackageSources['exercises'];
    assets: TrainingExerciseMediaPackageSources['assets'];
    instructions: TrainingExerciseMediaPackageSources['instructions'];
    mediaLocalizations: TrainingExerciseMediaPackageSources['mediaLocalizations'];
    provenance: TrainingExerciseMediaPackageSources['provenance'];
    reviews: TrainingExerciseMediaPackageSources['reviews'];
    takedowns: TrainingExerciseMediaPackageSources['takedowns'];
    approvalLedger: TrainingExerciseMediaApprovalLedgerSource;
  };
  compiled: CompiledTrainingExerciseMediaPackage;
  attestation: TrainingExerciseMediaMaterializationAttestation;
}

export interface TrainingExerciseMediaMaterializationResult {
  valid: boolean;
  errors: string[];
  authoredContentPackageHash: string;
  materialized: MaterializedTrainingExerciseMediaPackage | null;
}

export function materializeTrainingExerciseMediaPackage(input: {
  existingExercises: readonly TrainingExerciseMediaExerciseSource[];
  authoredContent: TrainingExerciseMediaAuthoredContent;
  policy: TrainingExerciseMediaMaterializationPolicy;
  rawMaterializationPolicySha256: string;
  phase0: TrainingExerciseMediaPhase0Evidence;
}): TrainingExerciseMediaMaterializationResult {
  const errors: string[] = [];
  const { phase0, policy, authoredContent } = input;
  const artifactMappings = Array.isArray(phase0.artifactIndex.mappings)
    ? phase0.artifactIndex.mappings : [];
  const expectedMappings: TrainingExerciseMediaExpectedAssetMapping[] = artifactMappings.map((mapping: any) => ({
    exerciseId: mapping.exerciseId,
    role: mapping.role,
    ordinal: mapping.ordinal,
  }));
  const expectedExerciseIds = input.existingExercises.map((exercise) => exercise.exerciseId).sort();
  const authoredContentPackageHash = buildTrainingExerciseAuthoredContentPackageHash(authoredContent);

  validateFrozenSubjects(phase0, policy, errors);
  validatePhase0Evidence(phase0, errors);
  validatePolicy(
    policy,
    authoredContentPackageHash,
    input.rawMaterializationPolicySha256,
    errors,
  );
  try {
    assertTrainingExerciseMediaAuthoredContent(authoredContent, expectedExerciseIds, expectedMappings, {
      catalogVersion: phase0.artifactIndex.catalogVersion,
      catalogSourceHash: phase0.artifactIndex.catalogSourceHash,
      eligibilityManifestSha256: phase0.eligibilityManifestSha256,
      artifactIndexSha256: phase0.artifactIndexSha256,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (input.existingExercises.length !== 158) errors.push('Backend exercise source must contain exactly 158 rows.');
  if (artifactMappings.length !== 200) errors.push('Phase 0 artifact index must contain exactly 200 asset mappings.');

  if (errors.length > 0) {
    return { valid: false, errors: unique(errors), authoredContentPackageHash, materialized: null };
  }

  try {
    const materialized = buildMaterializedPackage(input, authoredContentPackageHash);
    return { valid: true, errors: [], authoredContentPackageHash, materialized };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      authoredContentPackageHash,
      materialized: null,
    };
  }
}

function buildMaterializedPackage(
  input: {
    existingExercises: readonly TrainingExerciseMediaExerciseSource[];
    authoredContent: TrainingExerciseMediaAuthoredContent;
    policy: TrainingExerciseMediaMaterializationPolicy;
    rawMaterializationPolicySha256: string;
    phase0: TrainingExerciseMediaPhase0Evidence;
  },
  authoredContentPackageHash: string,
): MaterializedTrainingExerciseMediaPackage {
  const { phase0, policy, authoredContent } = input;
  const createdAt = authoredContent.manifest.contentCreatedAt!;
  const objectByHash = new Map((phase0.artifactIndex.objects as any[])
    .map((object) => [object.sha256, object]));
  const publicationMappingByKey = new Map((phase0.publicationEvidence.mappings as any[])
    .map((mapping) => [trainingExerciseMediaAssetMappingKey(mapping), mapping]));
  const eligibilityEntryById = new Map((phase0.eligibilityManifest.entries as any[])
    .map((entry) => [entry.exerciseId, entry]));

  const assets: TrainingExerciseMediaAssetSource[] = (phase0.artifactIndex.mappings as any[])
    .map((mapping) => {
      const object = objectByHash.get(mapping.sha256);
      const published = publicationMappingByKey.get(trainingExerciseMediaAssetMappingKey(mapping));
      if (!object || !published) throw new Error(`Asset mapping is not backed by frozen object and publication evidence: ${trainingExerciseMediaAssetMappingKey(mapping)}.`);
      return {
        assetId: assetIdFor(mapping),
        exerciseId: mapping.exerciseId,
        viewRole: mapping.role === 'primary' ? 'PRIMARY' : 'ALTERNATE',
        ordinal: mapping.ordinal,
        mediaKind: 'IMAGE',
        contentType: 'image/png',
        deliveryUrl: published.url,
        integritySha256: mapping.sha256,
        widthPixels: object.width,
        heightPixels: object.height,
        byteSize: object.byteSize,
        publicationState: 'APPROVED',
        createdAt,
      } satisfies TrainingExerciseMediaAssetSource;
    });
  const assetByMappingKey = new Map((phase0.artifactIndex.mappings as any[])
    .map((mapping) => [trainingExerciseMediaAssetMappingKey(mapping), assetIdFor(mapping)]));
  const exercises = input.existingExercises.map((exercise) => ({
    ...exercise,
    requiredViews: ['PRIMARY'] as const,
    publicationState: 'APPROVED' as const,
    exclusionReason: null,
    createdAt,
  }));
  const instructions = authoredContent.instructions.map(({ authoringStatus: _status, ...instruction }) => ({
    ...instruction,
    createdAt,
  }));
  const mediaLocalizations: TrainingExerciseMediaLocalizationSource[] = authoredContent.accessibility.map((entry) => {
    const assetId = assetByMappingKey.get(trainingExerciseMediaAssetMappingKey(entry));
    if (!assetId) throw new Error(`Accessibility content has no asset mapping: ${trainingExerciseMediaAssetMappingKey(entry)}.`);
    return {
      assetId,
      locale: entry.locale,
      caption: entry.caption,
      accessibilityDescription: entry.accessibilityDescription,
      contentHash: entry.contentHash,
      createdAt,
    };
  });
  const provenance: TrainingExerciseMediaProvenanceSource[] = (phase0.artifactIndex.mappings as any[])
    .map((mapping) => {
      const entry = eligibilityEntryById.get(mapping.exerciseId);
      const candidate = entry?.candidateAssets?.find((asset: any) => (
        asset.role === mapping.role && asset.ordinal === mapping.ordinal && asset.sha256 === mapping.sha256
      ));
      if (!candidate) throw new Error(`Eligibility manifest does not contain exact selected candidate: ${trainingExerciseMediaAssetMappingKey(mapping)}.`);
      const provenanceReference = nonEmpty(mapping.provenanceSidecar)
        ? mapping.provenanceSidecar
        : mapping.provenanceLedger;
      if (!nonEmpty(provenanceReference)) {
        throw new Error(`Artifact mapping has no provenance reference: ${trainingExerciseMediaAssetMappingKey(mapping)}.`);
      }
      const sourceReference = `phase0:${provenanceReference}`;
      const projection = {
        assetId: assetIdFor(mapping),
        sourceKind: policy.rights.sourceKind,
        sourceReference,
        generatorModel: candidate.generationModel ?? null,
        promptHash: null,
        generatedOrAcquiredAt: `${candidate.generatedDate}T00:00:00.000Z`,
        licenseIdentifier: policy.rights.licenseIdentifier!,
        licenseUrl: policy.rights.licenseUrl,
        rightsHolderRef: policy.rights.rightsHolderRef!,
        rightsExpiresAt: policy.rights.rightsExpiresAt,
        territories: [...policy.rights.territories],
        transformations: [],
        publicationAllowed: policy.rights.publicationAllowed,
        createdAt,
      };
      return {
        ...projection,
        provenanceHash: sha256TrainingExerciseMedia({
          schemaVersion: 'training-exercise-media-provenance.v1',
          ...projection,
        }),
      };
    });

  const manifestId = `training-exercise-media-v1-materialized-${authoredContentPackageHash.slice(0, 12)}-${phase0.publicationEvidenceSha256.slice(0, 12)}`;
  const hostApprovalId = `host-${phase0.approvalPackage.approvalId}`;
  const manifest: TrainingExerciseMediaPackageSources['manifest'] = {
    schemaVersion: TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION,
    manifestId,
    manifestVersion: `training-exercise-media.v1-materialized.${authoredContentPackageHash.slice(0, 12)}`,
    scopeKey: '__global__',
    catalogVersion: authoredContent.manifest.catalogVersion as TrainingExerciseMediaPackageSources['manifest']['catalogVersion'],
    catalogSourceHash: authoredContent.manifest.catalogSourceHash,
    publicationState: 'DRAFT',
    validationStatus: 'PENDING',
    expectedExerciseCount: 158,
    expectedExerciseIds: input.existingExercises.map((exercise) => exercise.exerciseId),
    requiredLocales: [...TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES],
    requiredReviewTypes: [...TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES],
    allowedOrigins: [policy.approvedOrigin],
    approvedHostRef: hostApprovalId,
    ownerApprovalRef: null,
    createdAt,
    activatedAt: null,
  };

  const assetReviews = buildAssetReviews(assets, mediaLocalizations, policy, phase0.approvalPackage.approvalId, createdAt);
  const localizationReviews = buildLocalizationReviews(instructions, mediaLocalizations, policy, createdAt);
  const hostApprovals: TrainingExerciseMediaHostApprovalSource[] = [{
    approvalId: hostApprovalId,
    status: 'APPROVED',
    reviewerRef: policy.phase0ReviewImport.reviewerRef!,
    subjectOrigins: [policy.approvedOrigin],
    subjectOriginsHash: buildTrainingExerciseMediaOriginsHash([policy.approvedOrigin]),
    reasonCodes: ['ACCOUNTABLE_OWNER_ATTESTATION', 'LIVE_PUBLICATION_PROOF'],
    reviewedAt: policy.phase0ReviewImport.reviewedAt!,
    expiresAt: policy.phase0ReviewImport.expiresAt,
    createdAt,
  }];
  const approvalLedger: TrainingExerciseMediaApprovalLedgerSource = {
    schemaVersion: TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION,
    approvedHostRef: hostApprovalId,
    ownerApprovalRef: null,
    assetReviews,
    localizationReviews,
    hostApprovals,
    ownerApprovals: [],
  };
  const sourceFiles: MaterializedTrainingExerciseMediaPackage['sourceFiles'] = {
    manifest,
    exercises,
    assets,
    instructions,
    mediaLocalizations,
    provenance,
    reviews: [],
    takedowns: [],
    approvalLedger,
  };
  const sources: TrainingExerciseMediaPackageSources = {
    manifest,
    exercises,
    assets,
    instructions,
    mediaLocalizations,
    provenance,
    reviews: assetReviews,
    localizationReviews,
    hostApprovals,
    ownerApprovals: [],
    takedowns: [],
  };
  const compiled = buildCompiledTrainingExerciseMediaPackage(sources);
  const releaseSubject = buildTrainingExerciseMediaReleaseSubject({
    compiledPackageHash: compiled.packageHash,
    authoredContentPackageHash,
    rawMaterializationPolicySha256: input.rawMaterializationPolicySha256,
    canonicalPreOwnerGovernanceLedgerHash:
      buildTrainingExerciseMediaPreOwnerGovernanceLedgerHash(sources),
    phase0Subjects: {
      eligibilityManifestSha256: phase0.eligibilityManifestSha256,
      artifactIndexSha256: phase0.artifactIndexSha256,
      approvalPackageSha256: phase0.approvalPackageSha256,
      publicationEvidenceSha256: phase0.publicationEvidenceSha256,
    },
    approvedOrigin: policy.approvedOrigin,
    activationPolicyHash: buildTrainingExerciseMediaActivationPolicyHash(policy),
  });
  const attestation: TrainingExerciseMediaMaterializationAttestation = {
    schemaVersion: TRAINING_EXERCISE_MEDIA_MATERIALIZATION_ATTESTATION_SCHEMA_VERSION,
    status: 'MATERIALIZED_PENDING_FINAL_OWNER_APPROVAL',
    catalogVersion: manifest.catalogVersion,
    catalogSourceHash: manifest.catalogSourceHash,
    releaseSubject,
    releaseSubjectHash: buildTrainingExerciseMediaReleaseSubjectHash(releaseSubject),
    compiledPackageHash: compiled.packageHash,
    manifestId,
    counts: {
      exercises: exercises.length,
      assets: assets.length,
      instructions: instructions.length,
      mediaLocalizations: mediaLocalizations.length,
      provenance: provenance.length,
      assetReviews: assetReviews.length,
      localizationReviews: localizationReviews.length,
      hostApprovals: hostApprovals.length,
      ownerApprovals: 0,
    },
    finalOwnerApprovalRequired: true,
    supplementalOwnerApprovalRequired: true,
    finalOwnerApprovalRef: null,
    finalPackageOwnerApproval: null,
    supplementalOwnerApproval: null,
    finalOwnerApprovalHash: null,
  };
  return { sourceFiles, compiled, attestation };
}

/**
 * Imports a human-provided final approval only after the immutable compiled
 * package hash exists. It never manufactures reviewer identity or approval
 * timestamps. Mutable activation fields and the append-only owner ledger do
 * not alter the frozen package hash.
 */
export function finalizeMaterializedTrainingExerciseMediaPackage(
  materialized: MaterializedTrainingExerciseMediaPackage,
  approval: TrainingExerciseMediaFinalOwnerApproval,
  supplementalApproval: TrainingExerciseMediaSupplementalOwnerApproval | null = null,
  now = new Date(),
): MaterializedTrainingExerciseMediaPackage {
  const errors = validateTrainingExerciseMediaFinalPackageApproval(
    approval, materialized.compiled.packageHash, now,
  );
  if (supplementalApproval) {
    errors.push(...validateTrainingExerciseMediaSupplementalApproval(
      supplementalApproval, materialized.attestation.releaseSubject, approval, now,
    ));
  }
  if (materialized.sourceFiles.approvalLedger.ownerApprovalRef
    || materialized.sourceFiles.approvalLedger.ownerApprovals.length > 0) {
    errors.push('Materialized package already contains owner-approval evidence.');
  }
  if (errors.length > 0) throw new Error(`Final owner approval is invalid: ${errors.join(' ')}`);

  const createdAt = materialized.sourceFiles.manifest.createdAt;
  const ownerApproval: TrainingExerciseMediaOwnerApprovalSource = {
    approvalId: approval.approvalId,
    status: approval.status,
    reviewerRef: approval.reviewerRef,
    subjectPackageHash: approval.subjectPackageHash,
    reasonCodes: [...approval.reasonCodes],
    reviewedAt: approval.reviewedAt,
    expiresAt: approval.expiresAt,
    createdAt,
  };
  const manifest = {
    ...materialized.sourceFiles.manifest,
    publicationState: 'ACTIVE' as const,
    validationStatus: 'PASSED' as const,
    ownerApprovalRef: approval.approvalId,
    activatedAt: supplementalApproval?.activatedAt ?? approval.activatedAt,
  };
  const approvalLedger: TrainingExerciseMediaApprovalLedgerSource = {
    ...materialized.sourceFiles.approvalLedger,
    ownerApprovalRef: approval.approvalId,
    ownerApprovals: [ownerApproval],
  };
  const sourceFiles = { ...materialized.sourceFiles, manifest, approvalLedger };
  const compiled = buildCompiledTrainingExerciseMediaPackage({
    manifest,
    exercises: sourceFiles.exercises,
    assets: sourceFiles.assets,
    instructions: sourceFiles.instructions,
    mediaLocalizations: sourceFiles.mediaLocalizations,
    provenance: sourceFiles.provenance,
    reviews: approvalLedger.assetReviews,
    localizationReviews: approvalLedger.localizationReviews,
    hostApprovals: approvalLedger.hostApprovals,
    ownerApprovals: approvalLedger.ownerApprovals,
    takedowns: sourceFiles.takedowns,
  });
  if (compiled.packageHash !== materialized.compiled.packageHash) {
    throw new Error('Final owner approval unexpectedly changed the immutable compiled package hash.');
  }
  const validation = validateCompiledTrainingExerciseMediaPackage(compiled, { now, requireActivation: true });
  if (!validation.activationReady) {
    throw new Error(`Final owner approval did not produce an activation-ready package: ${[
      ...validation.errors, ...validation.activationBlockers,
    ].join(' ')}`);
  }
  return {
    sourceFiles,
    compiled,
    attestation: {
      ...materialized.attestation,
      status: supplementalApproval
        ? 'MATERIALIZED_FINAL_OWNER_APPROVED'
        : 'MATERIALIZED_PENDING_SUPPLEMENTAL_OWNER_APPROVAL',
      counts: { ...materialized.attestation.counts, ownerApprovals: 1 },
      finalOwnerApprovalRef: approval.approvalId,
      finalPackageOwnerApproval: { ...approval, reasonCodes: [...approval.reasonCodes] },
      supplementalOwnerApproval: supplementalApproval
        ? { ...supplementalApproval, reasonCodes: [...supplementalApproval.reasonCodes] }
        : null,
      finalOwnerApprovalHash: supplementalApproval
        ? buildTrainingExerciseMediaFinalOwnerApprovalHash(approval, supplementalApproval)
        : null,
    },
  };
}

function buildAssetReviews(
  assets: readonly TrainingExerciseMediaAssetSource[],
  mediaLocalizations: readonly TrainingExerciseMediaLocalizationSource[],
  policy: TrainingExerciseMediaMaterializationPolicy,
  phase0ApprovalId: string,
  createdAt: string,
): TrainingExerciseMediaReviewSource[] {
  return assets.flatMap((asset) => TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES.map((reviewType) => {
    const contentReview = reviewType === 'ACCESSIBILITY';
    return {
      reviewId: `review_${asset.assetId}_${reviewType.toLowerCase()}`,
      assetId: asset.assetId,
      reviewType,
      status: 'APPROVED',
      reviewerRef: contentReview ? policy.contentReview.reviewerRef! : policy.phase0ReviewImport.reviewerRef!,
      subjectContentHash: contentReview
        ? buildTrainingExerciseMediaAccessibilityBundleHash(asset.assetId, mediaLocalizations)
        : asset.integritySha256,
      reasonCodes: contentReview
        ? ['AUTHORED_CONTENT_REVIEW', policy.contentReview.approvalRef!]
        : ['PHASE0_ACCOUNTABLE_OWNER_ATTESTATION', phase0ApprovalId],
      reviewedAt: contentReview ? policy.contentReview.reviewedAt! : policy.phase0ReviewImport.reviewedAt!,
      expiresAt: contentReview ? policy.contentReview.expiresAt : policy.phase0ReviewImport.expiresAt,
      createdAt,
    } satisfies TrainingExerciseMediaReviewSource;
  }));
}

function buildLocalizationReviews(
  instructions: TrainingExerciseMediaPackageSources['instructions'],
  mediaLocalizations: TrainingExerciseMediaPackageSources['mediaLocalizations'],
  policy: TrainingExerciseMediaMaterializationPolicy,
  createdAt: string,
): TrainingExerciseMediaLocalizationReviewSource[] {
  const common = {
    status: 'APPROVED' as const,
    reviewerRef: policy.contentReview.reviewerRef!,
    reasonCodes: ['AUTHORED_CONTENT_REVIEW', policy.contentReview.approvalRef!],
    reviewedAt: policy.contentReview.reviewedAt!,
    expiresAt: policy.contentReview.expiresAt,
    createdAt,
  };
  return [
    ...instructions.map((entry) => ({
      reviewId: `localization_instruction_${entry.exerciseId}_${entry.locale}`,
      targetKind: 'INSTRUCTION' as const,
      targetId: entry.exerciseId,
      locale: entry.locale,
      subjectContentHash: entry.contentHash,
      ...common,
    })),
    ...mediaLocalizations.map((entry) => ({
      reviewId: `localization_media_${entry.assetId}_${entry.locale}`,
      targetKind: 'MEDIA_ACCESSIBILITY' as const,
      targetId: entry.assetId,
      locale: entry.locale,
      subjectContentHash: entry.contentHash,
      ...common,
    })),
  ];
}

function validateFrozenSubjects(
  phase0: TrainingExerciseMediaPhase0Evidence,
  policy: TrainingExerciseMediaMaterializationPolicy,
  errors: string[],
): void {
  const expected = {
    eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
    artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
    approvalPackageSha256: TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (phase0[key as keyof typeof expected] !== value
      || policy.phase0Subjects[key as keyof typeof expected] !== value) {
      errors.push(`Frozen Phase 0 subject hash mismatch: ${key}.`);
    }
  }
  if (!policy.phase0Subjects.publicationEvidenceSha256
    || phase0.publicationEvidenceSha256 !== policy.phase0Subjects.publicationEvidenceSha256) {
    errors.push('Publication-evidence hash is absent or does not match materialization policy.');
  }
  if (policy.phase0ReviewImport.approvalId !== phase0.approvalPackage.approvalId) {
    errors.push('Phase 0 review-import approval ID does not match the frozen approval package.');
  }
}

function validatePhase0Evidence(phase0: TrainingExerciseMediaPhase0Evidence, errors: string[]): void {
  const eligibility = phase0.eligibilityManifest;
  const artifact = phase0.artifactIndex;
  const approval = phase0.approvalPackage;
  const publication = phase0.publicationEvidence;
  if (eligibility.schemaVersion !== 'training-exercise-media-eligibility-manifest.v1'
    || eligibility.authority?.catalogVersion !== 'training-exercise-identity-catalog.v1'
    || eligibility.authority?.catalogSourceHash !== artifact.catalogSourceHash
    || eligibility.counts?.canonicalExerciseIds !== 158
    || eligibility.counts?.selectedAssetMappings !== 200
    || !Array.isArray(eligibility.entries) || eligibility.entries.length !== 158) {
    errors.push('Phase 0 eligibility manifest is not the complete frozen 158-exercise candidate authority.');
  }
  if (artifact.schemaVersion !== 'training-exercise-media-artifact-index.v2'
    || artifact.catalogVersion !== 'training-exercise-identity-catalog.v1'
    || artifact.counts?.assetMappings !== 200
    || artifact.counts?.uniqueCandidateBinaryObjects !== 196
    || !Array.isArray(artifact.mappings) || artifact.mappings.length !== 200
    || !Array.isArray(artifact.objects) || artifact.objects.length !== 202) {
    errors.push('Phase 0 artifact index does not contain the frozen 200 mappings and 202 evidence objects.');
  }
  if (approval.schemaVersion !== 'training-exercise-media-approval-package.v1'
    || approval.accountableOwner?.statement !== APPROVAL_STATEMENT
    || approval.subjects?.eligibilityManifest?.sha256 !== phase0.eligibilityManifestSha256
    || approval.subjects?.artifactIndex?.sha256 !== phase0.artifactIndexSha256
    || approval.subjects?.catalogAuthority?.canonicalExerciseIds !== 158
    || approval.reviewScope?.selectedAssetMappings !== 200
    || approval.reviewScope?.requiredViewPolicyDisposition !== 'APPROVED_AS_REVIEWED_IN_SUBJECT_MANIFEST'
    || approval.approvals?.domainReview?.status !== 'approved'
    || approval.approvals?.legalAndLicenseReview?.status !== 'approved'
    || approval.approvals?.accessibilityReview?.status !== 'approved'
    || approval.approvals?.ownerPublicationApproval?.status !== 'approved'
    || approval.approvals?.localizationReview?.['en-US'] !== 'approved'
    || approval.approvals?.localizationReview?.['pt-PT'] !== 'approved'
    || approval.approvals?.localizationReview?.['pt-BR'] !== 'approved'
    || approval.approvals?.approvedDeliveryHost?.origin !== TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN) {
    errors.push('Phase 0 approval package does not contain the exact accountable-owner review scope.');
  }
  const artifactMappingProjection = (artifact.mappings ?? []).map((mapping: any) => ({
    exerciseId: mapping.exerciseId,
    role: mapping.role,
    ordinal: mapping.ordinal,
    sha256: mapping.sha256,
    objectKey: mapping.objectKey,
    url: `${TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN}/${mapping.objectKey}`,
  }));
  const expectedPublishedObjects = Array.from(new Map((artifact.mappings ?? []).map((mapping: any) => [
    `${mapping.sha256}:${mapping.objectKey}`,
    { sha256: mapping.sha256, objectKey: mapping.objectKey },
  ])).values()).sort(comparePublishedObject);
  const actualPublishedObjects = Array.isArray(publication.objects)
    ? publication.objects.map((object: any) => ({
      sha256: object.sha256,
      objectKey: object.objectKey,
    })).sort(comparePublishedObject)
    : [];
  if (publication.schemaVersion !== 'training-exercise-media-publication-evidence.v1'
    || publication.approvalId !== approval.approvalId
    || publication.approvalPackageSha256 !== phase0.approvalPackageSha256
    || publication.eligibilityManifestSha256 !== phase0.eligibilityManifestSha256
    || publication.artifactIndexSha256 !== phase0.artifactIndexSha256
    || publication.origin !== TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN
    || publication.dnsVerified !== true || publication.tlsVerified !== true
    || publication.confirmedPublishedObjects !== 196
    || publication.confirmedAssetMappings !== 200
    || !Array.isArray(publication.objects) || publication.objects.length !== 196
    || publication.objects.some((object: any) => object.status !== 200 || object.redirected !== false
      || object.responseSha256 !== object.sha256)
    || JSON.stringify(actualPublishedObjects) !== JSON.stringify(expectedPublishedObjects)
    || !Array.isArray(publication.mappings)
    || JSON.stringify(publication.mappings) !== JSON.stringify(artifactMappingProjection)) {
    errors.push('Publication evidence does not prove the exact live 196-object/200-mapping set.');
  }
}

function comparePublishedObject(
  left: { sha256: string; objectKey: string },
  right: { sha256: string; objectKey: string },
): number {
  return left.sha256.localeCompare(right.sha256) || left.objectKey.localeCompare(right.objectKey);
}

function validatePolicy(
  policy: TrainingExerciseMediaMaterializationPolicy,
  authoredContentPackageHash: string,
  rawMaterializationPolicySha256: string,
  errors: string[],
): void {
  if (!HASH_PATTERN.test(rawMaterializationPolicySha256)) {
    errors.push('Raw materialization-policy SHA-256 is missing or invalid.');
  }
  if (policy.status !== 'READY_TO_MATERIALIZE') errors.push('Materialization policy is not READY_TO_MATERIALIZE.');
  if (policy.approvedOrigin !== TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN) errors.push('Materialization policy approved origin is invalid.');
  if (!nonEmpty(policy.phase0ReviewImport.approvalId) || !nonEmpty(policy.phase0ReviewImport.reviewerRef)
    || !isIsoInstant(policy.phase0ReviewImport.reviewedAt)
    || (policy.phase0ReviewImport.expiresAt != null && !isIsoInstant(policy.phase0ReviewImport.expiresAt))) {
    errors.push('Phase 0 review-import identity and timestamps are incomplete.');
  }
  if (!nonEmpty(policy.contentReview.approvalRef) || !nonEmpty(policy.contentReview.reviewerRef)
    || !isIsoInstant(policy.contentReview.reviewedAt)
    || policy.contentReview.subjectAuthoredContentPackageHash !== authoredContentPackageHash
    || (policy.contentReview.expiresAt != null && !isIsoInstant(policy.contentReview.expiresAt))) {
    errors.push('Authored-content review is incomplete or bound to a different package hash.');
  }
  if (policy.rights.status !== 'APPROVED' || policy.rights.publicationAllowed !== true
    || !nonEmpty(policy.rights.licenseIdentifier) || !nonEmpty(policy.rights.rightsHolderRef)
    || policy.rights.territories.length === 0
    || (policy.rights.licenseUrl != null && !safeHttpsUrl(policy.rights.licenseUrl))
    || (policy.rights.rightsExpiresAt != null && !isIsoInstant(policy.rights.rightsExpiresAt))) {
    errors.push('Rights policy is not complete and publication-approved.');
  }
}

function assetIdFor(mapping: { exerciseId: string; role: string; ordinal: number }): string {
  return `media_v1_${mapping.exerciseId}_${mapping.role}_${mapping.ordinal}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
