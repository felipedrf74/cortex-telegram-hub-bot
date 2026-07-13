// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES,
  sha256TrainingExerciseMedia,
  type TrainingExerciseInstructionLocalizationSource,
  type TrainingExerciseMediaExerciseSource,
  type TrainingExerciseMediaLocale,
  type TrainingExerciseMediaReviewType,
  type TrainingExerciseMediaViewRole,
} from './training-exercise-media-manifest';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
  buildTrainingExerciseIdentityCatalogSnapshot,
} from './training-exercise-identity';

export const TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_SCHEMA_VERSION =
  'training-exercise-media-review-bundle.v1' as const;
export const TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_STATUS =
  'DRAFT_PENDING_ALL_APPROVALS' as const;
export const TRAINING_EXERCISE_MEDIA_DRAFT_CREATED_AT = '2026-07-12T00:00:00.000Z' as const;

export interface TrainingExerciseMediaCandidateEligibilityManifest {
  manifestId: string;
  status: string;
  productionReleaseEligible: boolean;
  authority: {
    catalogVersion: string;
    catalogSourceHash: string;
    expectedExerciseCount: number;
  };
  requiredLocales: string[];
  requiredReviewTypes: string[];
  entries: Array<{
    exerciseId: string;
    canonicalName: string;
    identitySource: string;
    active: boolean;
    mediaEligibility: string;
    mediaStatus: string;
    requiredViewPolicyStatus: string;
    domainReviewStatus: string;
    legalReviewStatus: string;
    accessibilityReviewStatus: string;
    ownerReviewStatus: string;
    candidateAssets: Array<{
      role: 'primary' | 'supplemental';
      ordinal: number;
      path: string;
      selectionSource: string;
      selectionStatus: string;
      provenanceLedger: string;
      sha256: string;
      width: number;
      height: number;
      byteSize: number;
      format: string;
      reviewStatus: string;
      visualAuditStatus: string;
    }>;
  }>;
}

export interface TrainingExerciseMediaCandidateArtifactIndex {
  schemaVersion: string;
  status: string;
  manifestId: string;
  catalogVersion: string;
  catalogSourceHash: string;
  storage: {
    absoluteRootRecorded: boolean;
    publishableURLsPresent: boolean;
  };
  counts: {
    exerciseMappings: number;
    assetMappings: number;
    uniqueBinaryObjects: number;
    externalizedRootObjectCount: number;
    externalizedRootObjectBytes: number;
  };
  objects: TrainingExerciseMediaReviewBundleObject[];
  mappings: Array<{
    exerciseId: string;
    role: 'primary' | 'supplemental';
    ordinal: number;
    candidatePath: string;
    provenanceLedger: string;
    provenanceSidecar: string | null;
    sha256: string;
    objectKey: string;
    reviewStatus: string;
    visualAuditStatus: string;
    selectionStatus: string;
  }>;
}

export interface TrainingExerciseMediaReviewBundleObject {
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  format: 'PNG';
  objectKey: string;
}

export interface TrainingExerciseMediaInstructionScaffold extends TrainingExerciseInstructionLocalizationSource {
  status: 'DRAFT_SCAFFOLD_PENDING_DOMAIN_AUTHORING';
  sourceBasis: 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY';
  sourceReferences: {
    candidatePath: string;
    sha256: string;
    provenanceLedger: string;
    visualAuditStatus: string;
  };
}

export interface TrainingExerciseMediaAccessibilityScaffold {
  locale: TrainingExerciseMediaLocale;
  caption: string;
  accessibilityDescription: string;
  contentHash: string;
  status: 'DRAFT_SCAFFOLD_PENDING_ACCESSIBILITY_AUTHORING';
  sourceBasis: 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY';
}

export interface TrainingExerciseMediaReviewBundleAsset {
  assetDraftId: string;
  exerciseId: string;
  candidateRole: 'primary' | 'supplemental';
  proposedViewRole: TrainingExerciseMediaViewRole;
  ordinal: number;
  candidatePath: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  format: 'PNG';
  selectionSource: string;
  selectionStatus: 'DRAFT_SELECTED';
  visualAuditStatus: string;
  provenanceLedger: string;
  provenanceSidecar: string | null;
  publicationState: 'DRAFT';
  accessibilityScaffolds: TrainingExerciseMediaAccessibilityScaffold[];
  reviewRequirements: Array<{
    reviewType: TrainingExerciseMediaReviewType;
    status: 'PENDING';
    subjectContentHashBasis: 'ASSET_SHA256' | 'ACCESSIBILITY_BUNDLE_HASH_AFTER_APPROVED_LOCALIZATION';
  }>;
}

export interface TrainingExerciseMediaReviewBundleExercise {
  exerciseId: string;
  canonicalName: string;
  identitySource: string;
  active: true;
  publicationState: 'DRAFT';
  requiredViewPolicyStatus: 'PROVISIONAL_PENDING_CONTENT_OWNER_REVIEW';
  requiredViews: ['PRIMARY'];
  instructionScaffolds: TrainingExerciseMediaInstructionScaffold[];
  candidateAssets: TrainingExerciseMediaReviewBundleAsset[];
}

export interface TrainingExerciseMediaReviewBundle {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_SCHEMA_VERSION;
  status: typeof TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_STATUS;
  productionReleaseEligible: false;
  generatedDate: '2026-07-12';
  source: {
    candidateManifestId: string;
    candidateManifestSha256: string;
    artifactIndexSchemaVersion: string;
    artifactIndexSha256: string;
    catalogVersion: typeof TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION;
    catalogSourceHash: typeof TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH;
    externalArtifactRootRecorded: false;
  };
  coverage: {
    canonicalExercises: 158;
    draftExercises: 158;
    candidateAssetMappings: 200;
    uniqueExternalObjects: 202;
    instructionScaffolds: 474;
    accessibilityScaffolds: 600;
    completeLocalizedExercises: 0;
    approvedExercises: 0;
    approvedAssets: 0;
    approvedReviews: 0;
  };
  gateRequirements: Array<{
    gate: 'DOMAIN' | 'LEGAL' | 'ACCESSIBILITY' | 'OWNER' | 'LOCALIZATION' | 'APPROVED_HOST';
    status: 'PENDING';
    evidenceRequired: string[];
  }>;
  objects: TrainingExerciseMediaReviewBundleObject[];
  exercises: TrainingExerciseMediaReviewBundleExercise[];
  bundleHash: string;
}

export function buildTrainingExerciseMediaReviewBundle(input: {
  eligibilityManifest: TrainingExerciseMediaCandidateEligibilityManifest;
  artifactIndex: TrainingExerciseMediaCandidateArtifactIndex;
  candidateManifestSha256: string;
  artifactIndexSha256: string;
}): TrainingExerciseMediaReviewBundle {
  assertCandidateSources(input);
  const identity = buildTrainingExerciseIdentityCatalogSnapshot();
  const objectByHash = new Map(input.artifactIndex.objects.map((entry) => [entry.sha256, entry]));
  const mappingByPath = new Map(input.artifactIndex.mappings.map((entry) => [entry.candidatePath, entry]));
  const exerciseById = new Map(input.eligibilityManifest.entries.map((entry) => [entry.exerciseId, entry]));

  const exercises = identity.entries.map((identityEntry): TrainingExerciseMediaReviewBundleExercise => {
    const source = exerciseById.get(identityEntry.exerciseId);
    if (!source || source.canonicalName !== identityEntry.canonicalName || source.active !== true) {
      throw new Error(`Candidate identity mismatch: ${identityEntry.exerciseId}`);
    }
    const candidateAssets = source.candidateAssets.map((candidate): TrainingExerciseMediaReviewBundleAsset => {
      const mapping = mappingByPath.get(candidate.path);
      const object = objectByHash.get(candidate.sha256);
      if (!mapping || !object
          || mapping.exerciseId !== source.exerciseId
          || mapping.sha256 !== candidate.sha256
          || mapping.role !== candidate.role
          || mapping.ordinal !== candidate.ordinal
          || object.objectKey !== mapping.objectKey) {
        throw new Error(`Candidate artifact mapping mismatch: ${source.exerciseId}:${candidate.path}`);
      }
      const proposedViewRole = candidate.role === 'primary' ? 'PRIMARY' : 'ALTERNATE';
      const assetDraftId = `draft_${sha256TrainingExerciseMedia({
        exerciseId: source.exerciseId,
        candidatePath: candidate.path,
        sha256: candidate.sha256,
      }).slice(0, 24)}`;
      return {
        assetDraftId,
        exerciseId: source.exerciseId,
        candidateRole: candidate.role,
        proposedViewRole,
        ordinal: candidate.ordinal,
        candidatePath: candidate.path,
        objectKey: object.objectKey,
        sha256: object.sha256,
        byteSize: object.byteSize,
        width: object.width,
        height: object.height,
        format: object.format,
        selectionSource: candidate.selectionSource,
        selectionStatus: 'DRAFT_SELECTED',
        visualAuditStatus: candidate.visualAuditStatus,
        provenanceLedger: mapping.provenanceLedger,
        provenanceSidecar: mapping.provenanceSidecar,
        publicationState: 'DRAFT',
        accessibilityScaffolds: TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => (
          draftAccessibility(assetDraftId, source.canonicalName, proposedViewRole, locale)
        )),
        reviewRequirements: TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES.map((reviewType) => ({
          reviewType,
          status: 'PENDING',
          subjectContentHashBasis: reviewType === 'ACCESSIBILITY'
            ? 'ACCESSIBILITY_BUNDLE_HASH_AFTER_APPROVED_LOCALIZATION'
            : 'ASSET_SHA256',
        })),
      };
    });
    const primary = candidateAssets.find((asset) => asset.candidateRole === 'primary');
    if (!primary) throw new Error(`Candidate primary asset is missing: ${source.exerciseId}`);
    return {
      exerciseId: source.exerciseId,
      canonicalName: source.canonicalName,
      identitySource: source.identitySource,
      active: true,
      publicationState: 'DRAFT',
      requiredViewPolicyStatus: 'PROVISIONAL_PENDING_CONTENT_OWNER_REVIEW',
      requiredViews: ['PRIMARY'],
      instructionScaffolds: TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => (
        draftInstruction(source.exerciseId, source.canonicalName, locale, primary)
      )),
      candidateAssets,
    };
  });

  const withoutHash = {
    schemaVersion: TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_SCHEMA_VERSION,
    status: TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_STATUS,
    productionReleaseEligible: false as const,
    generatedDate: '2026-07-12' as const,
    source: {
      candidateManifestId: input.eligibilityManifest.manifestId,
      candidateManifestSha256: input.candidateManifestSha256,
      artifactIndexSchemaVersion: input.artifactIndex.schemaVersion,
      artifactIndexSha256: input.artifactIndexSha256,
      catalogVersion: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
      catalogSourceHash: TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
      externalArtifactRootRecorded: false as const,
    },
    coverage: {
      canonicalExercises: 158 as const,
      draftExercises: 158 as const,
      candidateAssetMappings: 200 as const,
      uniqueExternalObjects: 202 as const,
      instructionScaffolds: 474 as const,
      accessibilityScaffolds: 600 as const,
      completeLocalizedExercises: 0 as const,
      approvedExercises: 0 as const,
      approvedAssets: 0 as const,
      approvedReviews: 0 as const,
    },
    gateRequirements: gateRequirements(),
    objects: [...input.artifactIndex.objects].sort((left, right) => left.sha256.localeCompare(right.sha256)),
    exercises,
  };
  return { ...withoutHash, bundleHash: sha256TrainingExerciseMedia(withoutHash) };
}

function assertCandidateSources(input: {
  eligibilityManifest: TrainingExerciseMediaCandidateEligibilityManifest;
  artifactIndex: TrainingExerciseMediaCandidateArtifactIndex;
  candidateManifestSha256: string;
  artifactIndexSha256: string;
}): void {
  const eligibility = input.eligibilityManifest;
  const artifacts = input.artifactIndex;
  if (eligibility.status !== 'DRAFT_CANDIDATE_MAPPING_COMPLETE_PRODUCTION_GATES_PENDING'
      || eligibility.productionReleaseEligible !== false
      || eligibility.authority.catalogVersion !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION
      || eligibility.authority.catalogSourceHash !== TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH
      || eligibility.authority.expectedExerciseCount !== 158
      || eligibility.entries.length !== 158) {
    throw new Error('Candidate eligibility source is not the frozen 158-exercise DRAFT inventory.');
  }
  if (!sameSet(eligibility.requiredLocales, TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES)
      || !sameSet(eligibility.requiredReviewTypes, TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES)) {
    throw new Error('Candidate eligibility source has incomplete locale or review requirements.');
  }
  if (eligibility.entries.some((entry) => entry.domainReviewStatus !== 'pending'
    || entry.legalReviewStatus !== 'pending'
    || entry.accessibilityReviewStatus !== 'pending'
    || entry.ownerReviewStatus !== 'pending'
    || entry.mediaEligibility !== 'DRAFT_CANDIDATE_ONLY'
    || entry.requiredViewPolicyStatus !== 'PROVISIONAL_PENDING_CONTENT_OWNER_REVIEW')) {
    throw new Error('Candidate eligibility source contains non-pending approval state.');
  }
  if (artifacts.schemaVersion !== 'training-exercise-media-artifact-index.v2'
      || artifacts.status !== 'DRAFT_NOT_PRODUCTION_APPROVED'
      || artifacts.manifestId !== eligibility.manifestId
      || artifacts.catalogVersion !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION
      || artifacts.catalogSourceHash !== TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH
      || artifacts.storage.absoluteRootRecorded !== false
      || artifacts.storage.publishableURLsPresent !== false
      || artifacts.counts.exerciseMappings !== 158
      || artifacts.counts.assetMappings !== 200
      || artifacts.counts.uniqueBinaryObjects !== 202
      || artifacts.counts.externalizedRootObjectCount !== 202
      || artifacts.objects.length !== 202
      || artifacts.mappings.length !== 200) {
    throw new Error('Candidate artifact index is not the frozen metadata-only DRAFT inventory.');
  }
  if (!/^[a-f0-9]{64}$/.test(input.candidateManifestSha256)
      || !/^[a-f0-9]{64}$/.test(input.artifactIndexSha256)
      || JSON.stringify(input).includes('/Users/')
      || JSON.stringify(input).includes('file://')) {
    throw new Error('Candidate sources contain invalid hashes or a forbidden absolute artifact path.');
  }
  for (const object of artifacts.objects) {
    if (!/^[a-f0-9]{64}$/.test(object.sha256)
        || object.objectKey !== `objects/sha256/${object.sha256.slice(0, 2)}/${object.sha256}.png`
        || object.format !== 'PNG'
        || !Number.isInteger(object.byteSize) || object.byteSize <= 0
        || !Number.isInteger(object.width) || object.width <= 0
        || !Number.isInteger(object.height) || object.height <= 0) {
      throw new Error(`Candidate object metadata is invalid: ${object.sha256}`);
    }
  }
  if (artifacts.mappings.some((mapping) => mapping.selectionStatus !== 'DRAFT_SELECTED'
    || !mapping.candidatePath.startsWith('images/')
    || mapping.candidatePath.includes('..')
    || mapping.objectKey.includes('..'))) {
    throw new Error('Candidate artifact mapping contains a non-draft or unsafe path.');
  }
}

export function validateTrainingExerciseMediaReviewBundle(bundle: TrainingExerciseMediaReviewBundle): string[] {
  const errors: string[] = [];
  const identity = buildTrainingExerciseIdentityCatalogSnapshot();
  const { bundleHash, ...withoutHash } = bundle;
  if (bundle.schemaVersion !== TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_SCHEMA_VERSION) errors.push('Unsupported review-bundle schema.');
  if (bundle.status !== TRAINING_EXERCISE_MEDIA_REVIEW_BUNDLE_STATUS) errors.push('Review bundle must remain DRAFT_PENDING_ALL_APPROVALS.');
  if (bundle.productionReleaseEligible !== false) errors.push('Review bundle cannot be production eligible.');
  if (bundleHash !== sha256TrainingExerciseMedia(withoutHash)) errors.push('Review-bundle hash mismatch.');
  if (bundle.source.catalogVersion !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION
      || bundle.source.catalogSourceHash !== TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH) {
    errors.push('Review bundle is not pinned to the frozen exercise identity authority.');
  }
  if (bundle.source.externalArtifactRootRecorded !== false
      || JSON.stringify(bundle).includes('/Users/')
      || JSON.stringify(bundle).includes('file://')) {
    errors.push('Review bundle must not record a local artifact root.');
  }
  if (bundle.exercises.length !== 158 || bundle.objects.length !== 202) errors.push('Review-bundle coverage counts are incomplete.');
  if (bundle.coverage.approvedExercises !== 0
      || bundle.coverage.approvedAssets !== 0
      || bundle.coverage.approvedReviews !== 0
      || bundle.coverage.completeLocalizedExercises !== 0) {
    errors.push('Review bundle cannot claim approvals.');
  }
  const bundleById = new Map(bundle.exercises.map((entry) => [entry.exerciseId, entry]));
  for (const entry of identity.entries) {
    const candidate = bundleById.get(entry.exerciseId);
    if (!candidate || candidate.canonicalName !== entry.canonicalName) {
      errors.push(`Missing canonical review entry: ${entry.exerciseId}`);
      continue;
    }
    if (candidate.publicationState !== 'DRAFT'
        || candidate.requiredViewPolicyStatus !== 'PROVISIONAL_PENDING_CONTENT_OWNER_REVIEW') {
      errors.push(`Exercise is not safely draft-scoped: ${entry.exerciseId}`);
    }
    if (!sameSet(candidate.instructionScaffolds.map((draft) => draft.locale), TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES)) {
      errors.push(`Instruction scaffold locale coverage is incomplete: ${entry.exerciseId}`);
    }
    for (const draft of candidate.instructionScaffolds) {
      const primary = candidate.candidateAssets.find((asset) => asset.candidateRole === 'primary');
      if (draft.status !== 'DRAFT_SCAFFOLD_PENDING_DOMAIN_AUTHORING'
          || draft.contentHash !== instructionContentHash(draft)
          || !primary
          || draft.sourceReferences.candidatePath !== primary.candidatePath
          || draft.sourceReferences.sha256 !== primary.sha256
          || draft.sourceReferences.provenanceLedger !== primary.provenanceLedger
          || draft.sourceReferences.visualAuditStatus !== primary.visualAuditStatus) {
        errors.push(`Instruction scaffold is invalid: ${entry.exerciseId}:${draft.locale}`);
      }
    }
    for (const asset of candidate.candidateAssets) {
      if (asset.publicationState !== 'DRAFT' || asset.selectionStatus !== 'DRAFT_SELECTED') {
        errors.push(`Asset is not safely draft-scoped: ${asset.assetDraftId}`);
      }
      if (!sameSet(asset.accessibilityScaffolds.map((draft) => draft.locale), TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES)) {
        errors.push(`Accessibility scaffold locale coverage is incomplete: ${asset.assetDraftId}`);
      }
      for (const draft of asset.accessibilityScaffolds) {
        if (draft.status !== 'DRAFT_SCAFFOLD_PENDING_ACCESSIBILITY_AUTHORING'
            || draft.contentHash !== accessibilityContentHash(asset.assetDraftId, draft)) {
          errors.push(`Accessibility scaffold is invalid: ${asset.assetDraftId}:${draft.locale}`);
        }
      }
      if (!sameSet(asset.reviewRequirements.map((review) => review.reviewType), TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES)
          || asset.reviewRequirements.some((review) => review.status !== 'PENDING')) {
        errors.push(`Review requirements are incomplete or non-pending: ${asset.assetDraftId}`);
      }
    }
  }
  if (bundle.exercises.flatMap((entry) => entry.candidateAssets).length !== 200
      || bundle.exercises.flatMap((entry) => entry.instructionScaffolds).length !== 474
      || bundle.exercises.flatMap((entry) => entry.candidateAssets)
        .flatMap((asset) => asset.accessibilityScaffolds).length !== 600) {
    errors.push('Review-bundle scaffold counts are incomplete.');
  }
  const expectedGates = ['DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER', 'LOCALIZATION', 'APPROVED_HOST'];
  if (!sameSet(bundle.gateRequirements.map((entry) => entry.gate), expectedGates)
      || bundle.gateRequirements.some((entry) => entry.status !== 'PENDING')) {
    errors.push('All six release gates must remain explicitly pending.');
  }
  return errors;
}

export function deriveTrainingExerciseMediaDraftScaffolds(bundle: TrainingExerciseMediaReviewBundle): {
  exercises: TrainingExerciseMediaExerciseSource[];
  instructionScaffolds: TrainingExerciseMediaInstructionScaffold[];
  accessibilityScaffolds: Array<TrainingExerciseMediaAccessibilityScaffold & {
    assetDraftId: string;
    exerciseId: string;
  }>;
} {
  const errors = validateTrainingExerciseMediaReviewBundle(bundle);
  if (errors.length > 0) throw new Error(`Invalid Training media review bundle: ${errors.join(' ')}`);
  return {
    exercises: bundle.exercises.map((entry) => {
      const source = {
        exerciseId: entry.exerciseId,
        canonicalName: entry.canonicalName,
        aliases: [],
        requiredViews: entry.requiredViews,
        publicationState: 'DRAFT' as const,
        exclusionReason: null,
        globalExerciseId: null,
        equivalenceHash: null,
        createdAt: TRAINING_EXERCISE_MEDIA_DRAFT_CREATED_AT,
      };
      return {
        ...source,
        exerciseContentHash: sha256TrainingExerciseMedia(source),
      };
    }),
    instructionScaffolds: bundle.exercises.flatMap((entry) => entry.instructionScaffolds),
    accessibilityScaffolds: bundle.exercises.flatMap((entry) => entry.candidateAssets.flatMap((asset) => (
      asset.accessibilityScaffolds.map((scaffold) => ({
        assetDraftId: asset.assetDraftId,
        exerciseId: entry.exerciseId,
        ...scaffold,
      }))
    ))),
  };
}

function draftInstruction(
  exerciseId: string,
  canonicalName: string,
  locale: TrainingExerciseMediaLocale,
  primary: TrainingExerciseMediaReviewBundleAsset,
): TrainingExerciseMediaInstructionScaffold {
  const localized = instructionCopy(canonicalName, locale);
  const source = {
    exerciseId,
    locale,
    displayName: canonicalName,
    ...localized,
    createdAt: TRAINING_EXERCISE_MEDIA_DRAFT_CREATED_AT,
  };
  return {
    ...source,
    contentHash: sha256TrainingExerciseMedia(source),
    status: 'DRAFT_SCAFFOLD_PENDING_DOMAIN_AUTHORING',
    sourceBasis: 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY',
    sourceReferences: {
      candidatePath: primary.candidatePath,
      sha256: primary.sha256,
      provenanceLedger: primary.provenanceLedger,
      visualAuditStatus: primary.visualAuditStatus,
    },
  };
}

function draftAccessibility(
  assetDraftId: string,
  canonicalName: string,
  viewRole: TrainingExerciseMediaViewRole,
  locale: TrainingExerciseMediaLocale,
): TrainingExerciseMediaAccessibilityScaffold {
  const copy = accessibilityCopy(canonicalName, viewRole, locale);
  const source = { assetId: assetDraftId, locale, ...copy, createdAt: TRAINING_EXERCISE_MEDIA_DRAFT_CREATED_AT };
  return {
    locale,
    ...copy,
    contentHash: sha256TrainingExerciseMedia(source),
    status: 'DRAFT_SCAFFOLD_PENDING_ACCESSIBILITY_AUTHORING',
    sourceBasis: 'CANONICAL_NAME_AND_SELECTED_ASSET_METADATA_ONLY',
  };
}

function instructionContentHash(draft: TrainingExerciseMediaInstructionScaffold): string {
  return sha256TrainingExerciseMedia({
    exerciseId: draft.exerciseId,
    locale: draft.locale,
    displayName: draft.displayName,
    steps: draft.steps,
    cues: draft.cues,
    cautions: draft.cautions,
    textFallback: draft.textFallback,
    createdAt: draft.createdAt,
  });
}

function accessibilityContentHash(
  assetDraftId: string,
  draft: TrainingExerciseMediaAccessibilityScaffold,
): string {
  return sha256TrainingExerciseMedia({
    assetId: assetDraftId,
    locale: draft.locale,
    caption: draft.caption,
    accessibilityDescription: draft.accessibilityDescription,
    createdAt: TRAINING_EXERCISE_MEDIA_DRAFT_CREATED_AT,
  });
}

function instructionCopy(canonicalName: string, locale: TrainingExerciseMediaLocale) {
  if (locale === 'pt-PT') return {
    steps: [
      `Prepare o equipamento indicado para ${canonicalName} e siga a carga, repetições, tempo e descanso prescritos no treino.`,
      'Execute de forma controlada e use a imagem candidata apenas como referência de revisão; as indicações técnicas finais aguardam validação do domínio.',
    ],
    cues: ['Respeite a amplitude e o tempo prescritos; não deduza a técnica apenas a partir da imagem.'],
    cautions: ['Conteúdo em rascunho: interrompa se não conseguir executar o movimento de forma controlada e procure orientação qualificada.'],
    textFallback: `${canonicalName}. Instruções em rascunho, pendentes de revisão de domínio, acessibilidade, localização e proprietário. A imagem candidata é opcional.`,
  };
  if (locale === 'pt-BR') return {
    steps: [
      `Prepare o equipamento indicado para ${canonicalName} e siga a carga, repetições, ritmo e descanso prescritos no treino.`,
      'Execute de forma controlada e use a imagem candidata apenas como referência de revisão; as orientações técnicas finais aguardam validação do domínio.',
    ],
    cues: ['Respeite a amplitude e o ritmo prescritos; não deduza a técnica apenas pela imagem.'],
    cautions: ['Conteúdo em rascunho: interrompa se não conseguir executar o movimento de forma controlada e procure orientação qualificada.'],
    textFallback: `${canonicalName}. Instruções em rascunho, pendentes de revisão de domínio, acessibilidade, localização e proprietário. A imagem candidata é opcional.`,
  };
  return {
    steps: [
      `Prepare the equipment listed for ${canonicalName} and follow the workout's prescribed load, repetitions, tempo, and rest.`,
      'Use controlled execution and treat the candidate image only as review reference; final technique directions remain pending domain validation.',
    ],
    cues: ['Keep the prescribed range and tempo; do not infer technique from the image alone.'],
    cautions: ['Draft content: stop if the movement cannot be performed with control and seek qualified guidance.'],
    textFallback: `${canonicalName}. Draft instructions pending domain, accessibility, localization, and owner review. The candidate image is optional.`,
  };
}

function accessibilityCopy(
  canonicalName: string,
  viewRole: TrainingExerciseMediaViewRole,
  locale: TrainingExerciseMediaLocale,
) {
  const role = viewRole.toLowerCase();
  if (locale === 'pt-PT') return {
    caption: `${canonicalName} — vista candidata ${role}.`,
    accessibilityDescription: `Imagem candidata em rascunho para ${canonicalName}, identificada apenas como vista ${role}. A precisão visual e a descrição final aguardam revisão independente de domínio, acessibilidade e localização.`,
  };
  if (locale === 'pt-BR') return {
    caption: `${canonicalName} — vista candidata ${role}.`,
    accessibilityDescription: `Imagem candidata em rascunho para ${canonicalName}, identificada apenas como vista ${role}. A precisão visual e a descrição final aguardam revisão independente de domínio, acessibilidade e localização.`,
  };
  return {
    caption: `${canonicalName} — candidate ${role} view.`,
    accessibilityDescription: `Draft candidate image for ${canonicalName}, identified only as the ${role} view. Visual accuracy and final wording remain pending independent domain, accessibility, and localization review.`,
  };
}

function gateRequirements(): TrainingExerciseMediaReviewBundle['gateRequirements'] {
  return [
    { gate: 'DOMAIN', status: 'PENDING', evidenceRequired: ['Independent movement and equipment representation review for every selected asset.', 'Immutable review subject hash bound to the selected asset bytes.'] },
    { gate: 'LEGAL', status: 'PENDING', evidenceRequired: ['Rights-holder and license evidence for intended distribution.', 'Publication-allowed provenance bound to every selected asset.'] },
    { gate: 'ACCESSIBILITY', status: 'PENDING', evidenceRequired: ['Approved accessibility description in every required locale.', 'Accessibility review bound to the final localization bundle hash.'] },
    { gate: 'OWNER', status: 'PENDING', evidenceRequired: ['Asset-level owner review.', 'Immutable owner approval bound to the final compiled package hash.'] },
    { gate: 'LOCALIZATION', status: 'PENDING', evidenceRequired: ['Human-reviewed instructions and accessibility descriptions for en-US, pt-PT, and pt-BR.', 'Review hashes bound to each final localized record.'] },
    { gate: 'APPROVED_HOST', status: 'PENDING', evidenceRequired: ['Approved immutable HTTPS origin.', 'Host approval bound to the exact origin set and final delivery URLs.'] },
  ];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((entry, index) => entry === [...right].sort()[index]);
}
