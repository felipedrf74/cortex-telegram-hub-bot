// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  validateCompiledTrainingExerciseMediaPackage,
} from '../../src/services/training-exercise-media-manifest';
import {
  TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS,
  TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION,
  buildTrainingExerciseAccessibilityContentHash,
  buildTrainingExerciseAuthoredContentPackageHash,
  buildTrainingExerciseInstructionContentHash,
  validateTrainingExerciseMediaAuthoredContent,
  type TrainingExerciseMediaAuthoredContent,
  type TrainingExerciseMediaExpectedAssetMapping,
} from '../../src/services/training-exercise-media-authored-content';
import { loadTrainingExerciseMediaAuthoredContent } from '../../scripts/lib/training-exercise-media-authored-content';
import {
  TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN,
  TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256,
  TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
  TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
  finalizeMaterializedTrainingExerciseMediaPackage,
  materializeTrainingExerciseMediaPackage,
  type TrainingExerciseMediaPhase0Evidence,
} from '../../scripts/lib/training-exercise-media-materializer';
import {
  loadTrainingExerciseMediaPackageSources,
  readCompiledTrainingExerciseMediaPackage,
} from '../../scripts/lib/training-exercise-media-package';
import {
  TRAINING_EXERCISE_MEDIA_FINAL_RELEASE_REASON,
  TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF,
  TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION,
  buildTrainingExerciseMediaSupplementalApprovalStatement,
  expectedTrainingExerciseMediaFinalApprovalId,
  expectedTrainingExerciseMediaSupplementalApprovalId,
  sha256TrainingExerciseMediaRawBytes,
  validateTrainingExerciseMediaMaterializationAttestation,
} from '../../scripts/lib/training-exercise-media-release-attestation';

const createdAt = '2026-07-13T12:00:00.000Z';
const approvalStatement = 'I approve the Training exercise-media v6 review subjects for publication preparation: eligibility manifest 45eb4a62d83417dbe5cb797940e21bbf2567c1b1b5a1d1c489c2533cd1072e10 and artifact index 29e3d9becd6d02a815c17496b5fb5aaba451d698be753ba30fbe14bb26372481, covering 158 canonical exercises, 200 selected mappings, and 196 unique selected binaries. All six reviews—domain, legal/license, accessibility, owner publication, localization (en-US, pt-PT, pt-BR), and approved host—are complete for these exact subjects. Approved host: https://media.nexushub.me. This authorizes publication preparation only; final activation will still bind the compiled package hash.';

describe('training exercise media authored content', () => {
  it('keeps the checked-in authoring package red until its manifest is explicitly completed', () => {
    const loaded = loadTrainingExerciseMediaAuthoredContent();
    const base = loadTrainingExerciseMediaPackageSources();
    const mappings = base.assets.map((asset) => ({
      exerciseId: asset.exerciseId,
      role: asset.viewRole === 'PRIMARY' ? 'primary' as const : 'supplemental' as const,
      ordinal: asset.ordinal,
    }));
    const result = validateTrainingExerciseMediaAuthoredContent(
      loaded.content,
      base.manifest.expectedExerciseIds,
      mappings,
      {
        catalogVersion: base.manifest.catalogVersion,
        catalogSourceHash: base.manifest.catalogSourceHash,
        eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
        artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
      },
    );

    if (loaded.content.manifest.status === 'DRAFT_AWAITING_FINAL_CONTENT') {
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Authored-content manifest is not AUTHORING_COMPLETE_UNAPPROVED.');
    } else {
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.counts.instructionRecords).toBe(474);
      expect(result.counts.accessibilityRecords).toBe(600);
    }
  });

  it('requires exact 158 by three instruction and 200 by three accessibility coverage', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    const result = validateTrainingExerciseMediaAuthoredContent(content, exerciseIds, mappings, {
      catalogVersion: base.manifest.catalogVersion,
      catalogSourceHash: base.manifest.catalogSourceHash,
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
    });

    expect(result.valid).toBe(true);
    expect(result.counts).toMatchObject({
      expectedExercises: 158,
      instructionRecords: 474,
      accessibilityRecords: 600,
      instructionExerciseCoverage: 158,
      accessibilityAssetCoverage: 200,
    });

    const missing = structuredClone(content);
    missing.instructions.pop();
    const missingResult = validateTrainingExerciseMediaAuthoredContent(missing, exerciseIds, mappings, {
      catalogVersion: base.manifest.catalogVersion,
      catalogSourceHash: base.manifest.catalogSourceHash,
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
    });
    expect(missingResult.valid).toBe(false);
    expect(missingResult.errors.some((error) => error.includes('473/474'))).toBe(true);
  });

  it('rejects placeholder copy, generic cross-exercise copy, and hash drift', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    content.instructions[0].steps[0] = 'Placeholder technique will be written after review.';
    content.instructions[1] = {
      ...content.instructions[1],
      steps: [...content.instructions[2].steps],
      cues: [...content.instructions[2].cues],
      cautions: [...content.instructions[2].cautions],
      textFallback: content.instructions[2].textFallback,
      contentHash: content.instructions[2].contentHash,
    };
    content.accessibility[0].contentHash = '0'.repeat(64);
    const result = validateTrainingExerciseMediaAuthoredContent(content, exerciseIds, mappings, {
      catalogVersion: base.manifest.catalogVersion,
      catalogSourceHash: base.manifest.catalogSourceHash,
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('placeholder copy'))).toBe(true);
    expect(result.errors.some((error) => error.includes('content hash mismatch'))).toBe(true);
  });
});

describe('training exercise media materialization', () => {
  it('keeps the checked-in v2 release attestation activation-ready and source-bound', () => {
    const loaded = loadTrainingExerciseMediaAuthoredContent();
    const compiled = readCompiledTrainingExerciseMediaPackage();
    const attestation = JSON.parse(fs.readFileSync(path.resolve(
      process.cwd(), 'catalog/training/exercise-media/v1/materialization-attestation.json',
    ), 'utf8'));
    const result = validateTrainingExerciseMediaMaterializationAttestation({
      attestation,
      compiled,
      authoredContent: loaded.content,
      policy: loaded.policy,
      rawMaterializationPolicySha256: loaded.rawMaterializationPolicySha256,
      requireActivation: true,
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toEqual({
      valid: true,
      activationReady: true,
      errors: [],
      releaseSubjectHash: '27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3',
      finalOwnerApprovalHash: '1108f01773e9bac67a7d667989bfc8bf160ae338fef5520c239f2aa5569d6be5',
    });
  });

  it('materializes exact coverage but remains non-activatable pending final package-hash approval', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    const contentHash = buildTrainingExerciseAuthoredContentPackageHash(content);
    const fixture = syntheticMaterializationFixture(exerciseIds, mappings, contentHash);
    const result = materializeTrainingExerciseMediaPackage({
      existingExercises: base.exercises,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      phase0: fixture.phase0,
    });

    expect(result.valid).toBe(true);
    expect(result.materialized?.attestation.counts).toEqual({
      exercises: 158,
      assets: 200,
      instructions: 474,
      mediaLocalizations: 600,
      provenance: 200,
      assetReviews: 800,
      localizationReviews: 1074,
      hostApprovals: 1,
      ownerApprovals: 0,
    });
    expect(result.materialized?.compiled.manifest.ownerApprovalRef).toBeNull();
    expect(result.materialized?.sourceFiles.approvalLedger.ownerApprovals).toEqual([]);
    const validation = validateCompiledTrainingExerciseMediaPackage(result.materialized!.compiled, {
      now: new Date('2026-07-13T13:00:00.000Z'),
      requireActivation: true,
    });
    expect(validation.structurallyValid).toBe(true);
    expect(validation.activationReady).toBe(false);
    expect(validation.activationBlockers).toContain('Manifest has no immutable owner approval reference.');
  });

  it('emits no sources when a frozen subject hash or review package hash drifts', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    const fixture = syntheticMaterializationFixture(
      exerciseIds,
      mappings,
      buildTrainingExerciseAuthoredContentPackageHash(content),
    );
    fixture.phase0.artifactIndexSha256 = 'f'.repeat(64);
    fixture.policy.contentReview.subjectAuthoredContentPackageHash = 'e'.repeat(64);
    const result = materializeTrainingExerciseMediaPackage({
      existingExercises: base.exercises,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      phase0: fixture.phase0,
    });

    expect(result.valid).toBe(false);
    expect(result.materialized).toBeNull();
    expect(result.errors.some((error) => error.includes('artifactIndexSha256'))).toBe(true);
    expect(result.errors.some((error) => error.includes('different package hash'))).toBe(true);
  });

  it('rejects an imported review identity mismatch or missing artifact provenance', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    const contentHash = buildTrainingExerciseAuthoredContentPackageHash(content);

    const mismatchedReview = syntheticMaterializationFixture(exerciseIds, mappings, contentHash);
    mismatchedReview.policy.phase0ReviewImport.approvalId = 'different-approval-package';
    const mismatchedReviewResult = materializeTrainingExerciseMediaPackage({
      existingExercises: base.exercises,
      authoredContent: content,
      policy: mismatchedReview.policy,
      rawMaterializationPolicySha256: rawPolicyHash(mismatchedReview.policy),
      phase0: mismatchedReview.phase0,
    });
    expect(mismatchedReviewResult.valid).toBe(false);
    expect(mismatchedReviewResult.materialized).toBeNull();
    expect(mismatchedReviewResult.errors).toContain(
      'Phase 0 review-import approval ID does not match the frozen approval package.',
    );

    const missingProvenance = syntheticMaterializationFixture(exerciseIds, mappings, contentHash);
    missingProvenance.phase0.artifactIndex.mappings[0].provenanceLedger = null;
    missingProvenance.phase0.artifactIndex.mappings[0].provenanceSidecar = null;
    const missingProvenanceResult = materializeTrainingExerciseMediaPackage({
      existingExercises: base.exercises,
      authoredContent: content,
      policy: missingProvenance.policy,
      rawMaterializationPolicySha256: rawPolicyHash(missingProvenance.policy),
      phase0: missingProvenance.phase0,
    });
    expect(missingProvenanceResult.valid).toBe(false);
    expect(missingProvenanceResult.materialized).toBeNull();
    expect(missingProvenanceResult.errors.some((error) => error.includes('has no provenance reference'))).toBe(true);
  });

  it('accepts only the strict final package plus supplemental release-subject owner approval chain', () => {
    const base = loadTrainingExerciseMediaPackageSources();
    const exerciseIds = base.manifest.expectedExerciseIds;
    const mappings = syntheticMappings(exerciseIds);
    const content = syntheticAuthoredContent(exerciseIds, mappings, base.manifest.catalogVersion, base.manifest.catalogSourceHash);
    const fixture = syntheticMaterializationFixture(
      exerciseIds,
      mappings,
      buildTrainingExerciseAuthoredContentPackageHash(content),
    );
    const result = materializeTrainingExerciseMediaPackage({
      existingExercises: base.exercises,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      phase0: fixture.phase0,
    });
    const packageHash = result.materialized!.compiled.packageHash;
    const releaseSubject = result.materialized!.attestation.releaseSubject;
    const releaseSubjectHash = result.materialized!.attestation.releaseSubjectHash;
    const approval = {
      schemaVersion: TRAINING_EXERCISE_MEDIA_FINAL_OWNER_APPROVAL_SCHEMA_VERSION,
      status: 'APPROVED' as const,
      approvalId: expectedTrainingExerciseMediaFinalApprovalId(
        packageHash, '2026-07-13T12:30:00.000Z',
      ),
      reviewerRef: TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF,
      subjectPackageHash: packageHash,
      reasonCodes: ['FINAL_PACKAGE_HASH_REVIEWED'],
      reviewedAt: '2026-07-13T12:30:00.000Z',
      expiresAt: null,
      activatedAt: '2026-07-13T12:31:00.000Z',
    };
    const supplementalApproval = {
      schemaVersion: TRAINING_EXERCISE_MEDIA_SUPPLEMENTAL_OWNER_APPROVAL_SCHEMA_VERSION,
      status: 'APPROVED' as const,
      approvalId: expectedTrainingExerciseMediaSupplementalApprovalId(
        releaseSubjectHash, '2026-07-13T12:32:00.000Z',
      ),
      reviewerRef: TRAINING_EXERCISE_MEDIA_OWNER_REVIEWER_REF,
      subjectPackageHash: packageHash,
      subjectReleaseHash: releaseSubjectHash,
      priorFinalOwnerApprovalRef: approval.approvalId,
      reasonCodes: [TRAINING_EXERCISE_MEDIA_FINAL_RELEASE_REASON],
      statement: buildTrainingExerciseMediaSupplementalApprovalStatement(
        releaseSubject, releaseSubjectHash,
      ),
      reviewedAt: '2026-07-13T12:32:00.000Z',
      expiresAt: null,
      activatedAt: '2026-07-13T12:33:00.000Z',
    };
    expect(() => finalizeMaterializedTrainingExerciseMediaPackage(
      result.materialized!,
      { ...approval, subjectPackageHash: '0'.repeat(64) },
      supplementalApproval,
      new Date('2026-07-13T13:00:00.000Z'),
    )).toThrow(/exact compiled package hash/);
    expect(() => finalizeMaterializedTrainingExerciseMediaPackage(
      result.materialized!,
      approval,
      { ...supplementalApproval, reviewerRef: 'reviewer:anyone' },
      new Date('2026-07-13T13:00:00.000Z'),
    )).toThrow(/accountable owner/);
    expect(() => finalizeMaterializedTrainingExerciseMediaPackage(
      result.materialized!,
      approval,
      { ...supplementalApproval, reasonCodes: ['LOOKS_GOOD'] },
      new Date('2026-07-13T13:00:00.000Z'),
    )).toThrow(/exact release-subject reason/);
    expect(() => finalizeMaterializedTrainingExerciseMediaPackage(
      result.materialized!,
      approval,
      { ...supplementalApproval, approvalId: 'owner-approval:anything' },
      new Date('2026-07-13T13:00:00.000Z'),
    )).toThrow(/ID is not canonical/);

    const finalized = finalizeMaterializedTrainingExerciseMediaPackage(
      result.materialized!, approval, supplementalApproval,
      new Date('2026-07-13T13:00:00.000Z'),
    );
    expect(finalized.compiled.packageHash).toBe(result.materialized!.compiled.packageHash);
    expect(finalized.compiled.manifest.ownerApprovalRef).toBe(approval.approvalId);
    expect(finalized.sourceFiles.approvalLedger.ownerApprovals).toHaveLength(1);
    expect(finalized.attestation.status).toBe('MATERIALIZED_FINAL_OWNER_APPROVED');
    expect(finalized.attestation.releaseSubjectHash).toBe(releaseSubjectHash);
    expect(finalized.attestation.finalOwnerApprovalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(validateCompiledTrainingExerciseMediaPackage(finalized.compiled, {
      now: new Date('2026-07-13T13:00:00.000Z'), requireActivation: true,
    }).activationReady).toBe(true);
    const attestationValidation = validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    });
    expect(attestationValidation).toMatchObject({ valid: true, activationReady: true });

    const governanceDrift = structuredClone(finalized.compiled);
    governanceDrift.reviews[0].reviewerRef = 'reviewer:tampered';
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: governanceDrift,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).errors).toContain('Materialization attestation release commitments drifted from current sources.');

    const attestationDrift = structuredClone(finalized.attestation);
    attestationDrift.releaseSubject.rawMaterializationPolicySha256 = 'f'.repeat(64);
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: attestationDrift,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);

    const policyDrift = structuredClone(fixture.policy);
    policyDrift.rights.rightsHolderRef = 'owner:tampered';
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: policyDrift,
      rawMaterializationPolicySha256: rawPolicyHash(policyDrift),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);

    const phase0Drift = structuredClone(fixture.policy);
    phase0Drift.phase0Subjects.publicationEvidenceSha256 = 'a'.repeat(64);
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: phase0Drift,
      rawMaterializationPolicySha256: rawPolicyHash(phase0Drift),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);

    const originDrift = structuredClone(fixture.policy);
    originDrift.approvedOrigin = 'https://tampered.example.test';
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: originDrift,
      rawMaterializationPolicySha256: rawPolicyHash(originDrift),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);

    const authoredDrift = structuredClone(content);
    authoredDrift.instructions[0].contentHash = 'b'.repeat(64);
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalized.attestation,
      compiled: finalized.compiled,
      authoredContent: authoredDrift,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);

    const finalApprovalHashDrift = structuredClone(finalized.attestation);
    finalApprovalHashDrift.finalOwnerApprovalHash = 'c'.repeat(64);
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: finalApprovalHashDrift,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).errors).toContain('Materialization attestation finalOwnerApprovalHash is invalid.');

    const malformedApproval = structuredClone(finalized.attestation) as any;
    malformedApproval.finalPackageOwnerApproval = {};
    expect(() => validateTrainingExerciseMediaMaterializationAttestation({
      attestation: malformedApproval,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    })).not.toThrow();
    expect(validateTrainingExerciseMediaMaterializationAttestation({
      attestation: malformedApproval,
      compiled: finalized.compiled,
      authoredContent: content,
      policy: fixture.policy,
      rawMaterializationPolicySha256: rawPolicyHash(fixture.policy),
      requireActivation: true,
      now: new Date('2026-07-13T13:00:00.000Z'),
    }).valid).toBe(false);
  });
});

function syntheticMappings(exerciseIds: readonly string[]): TrainingExerciseMediaExpectedAssetMapping[] {
  return [
    ...exerciseIds.map((exerciseId) => ({ exerciseId, role: 'primary' as const, ordinal: 0 })),
    ...exerciseIds.slice(0, 42).map((exerciseId) => ({ exerciseId, role: 'supplemental' as const, ordinal: 1 })),
  ];
}

function syntheticAuthoredContent(
  exerciseIds: readonly string[],
  mappings: readonly TrainingExerciseMediaExpectedAssetMapping[],
  catalogVersion: string,
  catalogSourceHash: string,
): TrainingExerciseMediaAuthoredContent {
  const instructions = exerciseIds.flatMap((exerciseId, exerciseIndex) => (
    TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale, localeIndex) => {
      const base = {
        exerciseId,
        locale,
        displayName: `Reviewed ${exerciseId} ${locale}`,
        steps: [
          `Set up for ${exerciseId} using the reviewed position number ${exerciseIndex + 1}.`,
          `Complete the ${exerciseId} movement under control for sequence ${localeIndex + 1}.`,
        ],
        cues: [`Maintain the reviewed alignment cue ${exerciseIndex + 1}.`],
        cautions: [`Stop if controlled position ${exerciseIndex + 1} cannot be maintained.`],
        textFallback: `Written ${locale} guidance for ${exerciseId} remains available whenever its instructional image cannot load.`,
      };
      return {
        ...base,
        authoringStatus: TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS,
        contentHash: buildTrainingExerciseInstructionContentHash(base),
      };
    })
  ));
  const accessibility = mappings.flatMap((mapping, mappingIndex) => (
    TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => {
      const base = {
        ...mapping,
        locale,
        caption: `${mapping.exerciseId} ${mapping.role} view`,
        accessibilityDescription: `Reviewed ${locale} illustration ${mappingIndex + 1} showing the ${mapping.role} position for ${mapping.exerciseId}, with the equipment and body alignment visible.`,
      };
      return {
        ...base,
        authoringStatus: TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS,
        contentHash: buildTrainingExerciseAccessibilityContentHash(base),
      };
    })
  ));
  return {
    manifest: {
      schemaVersion: TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_SCHEMA_VERSION,
      status: TRAINING_EXERCISE_MEDIA_AUTHORED_CONTENT_COMPLETE_STATUS,
      catalogVersion,
      catalogSourceHash,
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
      requiredLocales: [...TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES],
      expectedExerciseCount: 158,
      expectedAssetMappingCount: 200,
      contentCreatedAt: createdAt,
      instructionChunks: [
        'instructions-000-039.json', 'instructions-040-079.json',
        'instructions-080-119.json', 'instructions-120-157.json',
      ],
      accessibilityChunks: [
        'accessibility-000-039.json', 'accessibility-040-079.json',
        'accessibility-080-119.json', 'accessibility-120-157.json',
      ],
    },
    instructions,
    accessibility,
  };
}

function syntheticMaterializationFixture(
  exerciseIds: readonly string[],
  mappings: readonly TrainingExerciseMediaExpectedAssetMapping[],
  contentHash: string,
) {
  const uniqueHashes = Array.from({ length: 196 }, (_, index) => index.toString(16).padStart(64, '0'));
  const artifactMappings = mappings.map((mapping, index) => {
    const sha256 = uniqueHashes[index % uniqueHashes.length];
    return {
      ...mapping,
      candidatePath: `images/${mapping.exerciseId}-${mapping.role}-${mapping.ordinal}.png`,
      provenanceLedger: 'generation-reviewed.json',
      provenanceSidecar: null,
      sha256,
      objectKey: `objects/sha256/${sha256.slice(0, 2)}/${sha256}.png`,
      reviewStatus: 'REVIEWED',
      visualAuditStatus: 'PASS',
      selectionStatus: 'SELECTED',
    };
  });
  const candidateObjects = uniqueHashes.map((sha256) => ({
    sha256,
    byteSize: 4096,
    width: 1254,
    height: 1254,
    format: 'PNG',
    objectKey: `objects/sha256/${sha256.slice(0, 2)}/${sha256}.png`,
  }));
  const extraObjects = Array.from({ length: 6 }, (_, index) => ({
    sha256: `f${index.toString(16).padStart(63, '0')}`,
    byteSize: 2048,
    width: 390,
    height: 390,
    format: 'PNG',
    objectKey: `objects/sha256/ff/evidence-${index}.png`,
  }));
  const approvalId = 'training-media-owner-approval-2026-07-13-manifest-45eb4a62-artifacts-29e3d9be';
  const publicationMappings = artifactMappings.map((mapping) => ({
    exerciseId: mapping.exerciseId,
    role: mapping.role,
    ordinal: mapping.ordinal,
    sha256: mapping.sha256,
    objectKey: mapping.objectKey,
    url: `${TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN}/${mapping.objectKey}`,
  }));
  const publicationEvidenceSha256 = 'd'.repeat(64);
  const phase0: TrainingExerciseMediaPhase0Evidence = {
    eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
    artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
    approvalPackageSha256: TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256,
    publicationEvidenceSha256,
    eligibilityManifest: {
      schemaVersion: 'training-exercise-media-eligibility-manifest.v1',
      authority: {
        catalogVersion: 'training-exercise-identity-catalog.v1',
        catalogSourceHash: loadTrainingExerciseMediaPackageSources().manifest.catalogSourceHash,
      },
      counts: { canonicalExerciseIds: 158, selectedAssetMappings: 200 },
      entries: exerciseIds.map((exerciseId) => ({
        exerciseId,
        candidateAssets: artifactMappings.filter((mapping) => mapping.exerciseId === exerciseId).map((mapping) => ({
          role: mapping.role,
          ordinal: mapping.ordinal,
          sha256: mapping.sha256,
          generatedDate: '2026-07-11',
          generationModel: 'reviewed-generation-model',
        })),
      })),
    },
    artifactIndex: {
      schemaVersion: 'training-exercise-media-artifact-index.v2',
      catalogVersion: 'training-exercise-identity-catalog.v1',
      catalogSourceHash: loadTrainingExerciseMediaPackageSources().manifest.catalogSourceHash,
      counts: { assetMappings: 200, uniqueCandidateBinaryObjects: 196 },
      mappings: artifactMappings,
      objects: [...candidateObjects, ...extraObjects],
    },
    approvalPackage: {
      schemaVersion: 'training-exercise-media-approval-package.v1',
      approvalId,
      accountableOwner: { statement: approvalStatement },
      subjects: {
        eligibilityManifest: { sha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256 },
        artifactIndex: { sha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256 },
        catalogAuthority: { canonicalExerciseIds: 158 },
      },
      reviewScope: { selectedAssetMappings: 200, requiredViewPolicyDisposition: 'APPROVED_AS_REVIEWED_IN_SUBJECT_MANIFEST' },
      approvals: {
        domainReview: { status: 'approved' },
        legalAndLicenseReview: { status: 'approved' },
        accessibilityReview: { status: 'approved' },
        ownerPublicationApproval: { status: 'approved' },
        localizationReview: { 'en-US': 'approved', 'pt-PT': 'approved', 'pt-BR': 'approved' },
        approvedDeliveryHost: { origin: TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN },
      },
    },
    publicationEvidence: {
      schemaVersion: 'training-exercise-media-publication-evidence.v1',
      approvalId,
      approvalPackageSha256: TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256,
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
      origin: TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN,
      dnsVerified: true,
      tlsVerified: true,
      confirmedPublishedObjects: 196,
      confirmedAssetMappings: 200,
      objects: candidateObjects.map((object) => ({
        ...object,
        status: 200,
        redirected: false,
        responseSha256: object.sha256,
      })),
      mappings: publicationMappings,
    },
  };
  const policy = {
    schemaVersion: 'training-exercise-media-materialization-policy.v1' as const,
    status: 'READY_TO_MATERIALIZE' as const,
    phase0Subjects: {
      eligibilityManifestSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ELIGIBILITY_SHA256,
      artifactIndexSha256: TRAINING_EXERCISE_MEDIA_PHASE0_ARTIFACT_INDEX_SHA256,
      approvalPackageSha256: TRAINING_EXERCISE_MEDIA_PHASE0_APPROVAL_PACKAGE_SHA256,
      publicationEvidenceSha256,
    },
    approvedOrigin: TRAINING_EXERCISE_MEDIA_APPROVED_ORIGIN,
    phase0ReviewImport: {
      approvalId,
      reviewerRef: 'owner:felipe-dominguez',
      reviewedAt: '2026-07-13T10:00:00.000Z',
      expiresAt: null,
    },
    contentReview: {
      approvalRef: 'training-media-content-review-v1',
      reviewerRef: 'review-board:training-media-v1',
      reviewedAt: '2026-07-13T11:00:00.000Z',
      expiresAt: null,
      subjectAuthoredContentPackageHash: contentHash,
    },
    rights: {
      status: 'APPROVED' as const,
      sourceKind: 'GENERATED' as const,
      licenseIdentifier: 'nexus-owned-generated-media-v1',
      licenseUrl: null,
      rightsHolderRef: 'owner:nexus-hub',
      rightsExpiresAt: null,
      territories: ['WORLDWIDE'],
      publicationAllowed: true,
    },
  };
  return { phase0, policy };
}

function rawPolicyHash(policy: unknown): string {
  return sha256TrainingExerciseMediaRawBytes(`${JSON.stringify(policy, null, 2)}\n`);
}
