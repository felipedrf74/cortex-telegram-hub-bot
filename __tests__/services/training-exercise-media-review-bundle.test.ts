// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTrainingExerciseMediaReviewBundle,
  deriveTrainingExerciseMediaDraftScaffolds,
  validateTrainingExerciseMediaReviewBundle,
  type TrainingExerciseMediaCandidateArtifactIndex,
  type TrainingExerciseMediaCandidateEligibilityManifest,
  type TrainingExerciseMediaReviewBundle,
} from '../../src/services/training-exercise-media-review-bundle';
import {
  validateCompiledTrainingExerciseMediaPackage,
} from '../../src/services/training-exercise-media-manifest';
import {
  compileTrainingExerciseMediaPackage,
  findForbiddenMediaBinaries,
} from '../../scripts/lib/training-exercise-media-package';

const root = path.resolve(process.cwd(), 'catalog/training/exercise-media/v1');
const bundle = readJson<TrainingExerciseMediaReviewBundle>('review-bundle.draft.json');

describe('Training exercise media DRAFT review bundle', () => {
  it('pins all candidate metadata while keeping every approval and production count at zero', () => {
    expect(validateTrainingExerciseMediaReviewBundle(bundle)).toEqual([]);
    expect(bundle).toMatchObject({
      schemaVersion: 'training-exercise-media-review-bundle.v1',
      status: 'DRAFT_PENDING_ALL_APPROVALS',
      productionReleaseEligible: false,
      source: {
        catalogVersion: 'training-exercise-identity-catalog.v1',
        catalogSourceHash: '50ed5bdd523af02dcd36cd258f195d144e3a4ee86aaed8dcf057fe45532e0ed8',
        externalArtifactRootRecorded: false,
      },
      coverage: {
        canonicalExercises: 158,
        draftExercises: 158,
        candidateAssetMappings: 200,
        uniqueExternalObjects: 202,
        instructionScaffolds: 474,
        accessibilityScaffolds: 600,
        completeLocalizedExercises: 0,
        approvedExercises: 0,
        approvedAssets: 0,
        approvedReviews: 0,
      },
    });
    expect(bundle.gateRequirements).toHaveLength(6);
    expect(bundle.gateRequirements.every((gate) => gate.status === 'PENDING')).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('/Users/');
    expect(JSON.stringify(bundle)).not.toContain('file://');
    expect(JSON.stringify(bundle)).not.toContain('deliveryUrl');
  });

  it('labels localized text as scaffolding and binds it only to canonical names and selected asset metadata', () => {
    const derived = deriveTrainingExerciseMediaDraftScaffolds(bundle);
    expect(derived.exercises).toHaveLength(158);
    expect(derived.instructionScaffolds).toHaveLength(474);
    expect(derived.accessibilityScaffolds).toHaveLength(600);
    expect(derived.exercises.every((exercise) => exercise.publicationState === 'DRAFT')).toBe(true);
    expect(derived.instructionScaffolds.every((entry) => (
      entry.status === 'DRAFT_SCAFFOLD_PENDING_DOMAIN_AUTHORING'
      && entry.sourceBasis === 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY'
      && (entry.textFallback.toLowerCase().includes('rascunho')
        || entry.textFallback.toLowerCase().includes('draft'))
    ))).toBe(true);
    expect(derived.accessibilityScaffolds.every((entry) => (
      entry.status === 'DRAFT_SCAFFOLD_PENDING_ACCESSIBILITY_AUTHORING'
      && entry.sourceBasis === 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY'
    ))).toBe(true);
  });

  it('keeps scaffolds outside production localization sources and leaves activation fail-closed', () => {
    expect(readJson<unknown[]>('instructions.json')).toEqual([]);
    expect(readJson<unknown[]>('media-localizations.json')).toEqual([]);
    expect(readJson<unknown[]>('assets.json')).toEqual([]);
    expect(readJson<unknown[]>('provenance.json')).toEqual([]);
    expect(readJson<unknown[]>('reviews.json')).toEqual([]);
    expect(readJson<unknown[]>('takedowns.json')).toEqual([]);
    expect(readJson<Record<string, unknown>>('approval-ledger.json')).toMatchObject({
      approvedHostRef: null,
      ownerApprovalRef: null,
      assetReviews: [],
      localizationReviews: [],
      hostApprovals: [],
      ownerApprovals: [],
    });
    const compiled = compileTrainingExerciseMediaPackage();
    const validation = validateCompiledTrainingExerciseMediaPackage(compiled, { requireActivation: true });
    expect(validation.structurallyValid).toBe(true);
    expect(validation.activationReady).toBe(false);
    expect(validation.coverage).toMatchObject({
      expectedExercises: 158,
      listedExercises: 158,
      approvedExercises: 0,
      approvedAssets: 0,
      instructionLocalizations: 0,
      mediaLocalizations: 0,
      approvedReviews: 0,
    });
    expect(findForbiddenMediaBinaries()).toEqual([]);
  });

  it('fails closed on hash, approval-state, and coverage drift', () => {
    const approved = structuredClone(bundle);
    approved.exercises[0].publicationState = 'APPROVED' as 'DRAFT';
    expect(validateTrainingExerciseMediaReviewBundle(approved)).toEqual(expect.arrayContaining([
      expect.stringContaining('not safely draft-scoped'),
      'Review-bundle hash mismatch.',
    ]));

    const missing = structuredClone(bundle);
    missing.exercises.pop();
    expect(validateTrainingExerciseMediaReviewBundle(missing)).toEqual(expect.arrayContaining([
      'Review-bundle hash mismatch.',
      'Review-bundle coverage counts are incomplete.',
    ]));
  });

  it('rebuilds deterministically from metadata-only sources and rejects source drift', () => {
    const eligibilityManifest = sourceEligibility(bundle);
    const artifactIndex = sourceArtifacts(bundle);
    expect(buildTrainingExerciseMediaReviewBundle({
      eligibilityManifest,
      artifactIndex,
      candidateManifestSha256: bundle.source.candidateManifestSha256,
      artifactIndexSha256: bundle.source.artifactIndexSha256,
    })).toEqual(bundle);

    const driftedEligibility = structuredClone(eligibilityManifest);
    driftedEligibility.authority.expectedExerciseCount = 157;
    expect(() => buildTrainingExerciseMediaReviewBundle({
      eligibilityManifest: driftedEligibility,
      artifactIndex,
      candidateManifestSha256: bundle.source.candidateManifestSha256,
      artifactIndexSha256: bundle.source.artifactIndexSha256,
    })).toThrow(/frozen 158-exercise DRAFT inventory/);

    const driftedArtifacts = structuredClone(artifactIndex);
    driftedArtifacts.mappings[0].sha256 = '0'.repeat(64);
    expect(() => buildTrainingExerciseMediaReviewBundle({
      eligibilityManifest,
      artifactIndex: driftedArtifacts,
      candidateManifestSha256: bundle.source.candidateManifestSha256,
      artifactIndexSha256: bundle.source.artifactIndexSha256,
    })).toThrow(/mapping mismatch/);
  });
});

function readJson<T>(filename: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, filename), 'utf8')) as T;
}

function sourceEligibility(
  value: TrainingExerciseMediaReviewBundle,
): TrainingExerciseMediaCandidateEligibilityManifest {
  return {
    manifestId: value.source.candidateManifestId,
    status: 'DRAFT_CANDIDATE_MAPPING_COMPLETE_PRODUCTION_GATES_PENDING',
    productionReleaseEligible: false,
    authority: {
      catalogVersion: value.source.catalogVersion,
      catalogSourceHash: value.source.catalogSourceHash,
      expectedExerciseCount: 158,
    },
    requiredLocales: ['en-US', 'pt-PT', 'pt-BR'],
    requiredReviewTypes: ['DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER'],
    entries: value.exercises.map((exercise) => ({
      exerciseId: exercise.exerciseId,
      canonicalName: exercise.canonicalName,
      identitySource: exercise.identitySource,
      active: true,
      mediaEligibility: 'DRAFT_CANDIDATE_ONLY',
      mediaStatus: 'CANDIDATE_MAPPING_COMPLETE_NOT_PRODUCTION_APPROVED',
      requiredViewPolicyStatus: 'PROVISIONAL_PENDING_CONTENT_OWNER_REVIEW',
      domainReviewStatus: 'pending',
      legalReviewStatus: 'pending',
      accessibilityReviewStatus: 'pending',
      ownerReviewStatus: 'pending',
      candidateAssets: exercise.candidateAssets.map((asset) => ({
        role: asset.candidateRole,
        ordinal: asset.ordinal,
        path: asset.candidatePath,
        selectionSource: asset.selectionSource,
        selectionStatus: 'DRAFT_SELECTED',
        provenanceLedger: asset.provenanceLedger,
        sha256: asset.sha256,
        width: asset.width,
        height: asset.height,
        byteSize: asset.byteSize,
        format: 'PNG',
        reviewStatus: 'DRAFT_REQUIRES_DOMAIN_LEGAL_ACCESSIBILITY_OWNER_REVIEW',
        visualAuditStatus: asset.visualAuditStatus,
      })),
    })),
  };
}

function sourceArtifacts(
  value: TrainingExerciseMediaReviewBundle,
): TrainingExerciseMediaCandidateArtifactIndex {
  const mappings = value.exercises.flatMap((exercise) => exercise.candidateAssets.map((asset) => ({
    exerciseId: exercise.exerciseId,
    role: asset.candidateRole,
    ordinal: asset.ordinal,
    candidatePath: asset.candidatePath,
    provenanceLedger: asset.provenanceLedger,
    provenanceSidecar: asset.provenanceSidecar,
    sha256: asset.sha256,
    objectKey: asset.objectKey,
    reviewStatus: 'DRAFT_REQUIRES_DOMAIN_LEGAL_ACCESSIBILITY_OWNER_REVIEW',
    visualAuditStatus: asset.visualAuditStatus,
    selectionStatus: 'DRAFT_SELECTED',
  })));
  return {
    schemaVersion: value.source.artifactIndexSchemaVersion,
    status: 'DRAFT_NOT_PRODUCTION_APPROVED',
    manifestId: value.source.candidateManifestId,
    catalogVersion: value.source.catalogVersion,
    catalogSourceHash: value.source.catalogSourceHash,
    storage: { absoluteRootRecorded: false, publishableURLsPresent: false },
    counts: {
      exerciseMappings: 158,
      assetMappings: 200,
      uniqueBinaryObjects: 202,
      externalizedRootObjectCount: 202,
      externalizedRootObjectBytes: value.objects.reduce((sum, object) => sum + object.byteSize, 0),
    },
    objects: value.objects,
    mappings,
  };
}
