// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
  assertTrainingExerciseIdentityCatalogIntegrity,
  buildTrainingExerciseIdentityCatalogSnapshot,
} from './training-exercise-identity';

export const TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION = 'training-exercise-media-package.v1' as const;
export const TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION = 'training_exercise_media_api.v1' as const;
export const TRAINING_EXERCISE_MEDIA_VALIDATION_ATTESTATION_SCHEMA_VERSION =
  'training-exercise-media-validation-attestation.v1' as const;
export const TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION =
  'training-exercise-media-approval-ledger.v1' as const;
export const TRAINING_EXERCISE_MEDIA_ACCESSIBILITY_BUNDLE_SCHEMA_VERSION =
  'training-exercise-media-accessibility-bundle.v1' as const;
export const TRAINING_EXERCISE_MEDIA_ORIGINS_APPROVAL_SCHEMA_VERSION =
  'training-exercise-media-origins-approval.v1' as const;
export const TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES = ['en-US', 'pt-PT', 'pt-BR'] as const;
export const TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES = [
  'DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER',
] as const;

export type TrainingExerciseMediaLocale = typeof TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES[number];
export type TrainingExerciseMediaReviewType = typeof TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES[number];
export type TrainingExerciseMediaPublicationState = 'DRAFT' | 'STAGED' | 'ACTIVE' | 'DEPRECATED' | 'REVOKED';
export type TrainingExerciseMediaExerciseState = 'DRAFT' | 'APPROVED' | 'EXCLUDED' | 'REMOVED';
export type TrainingExerciseMediaAssetState = 'DRAFT' | 'APPROVED' | 'REJECTED' | 'REMOVED';
export type TrainingExerciseMediaViewRole = 'PRIMARY' | 'START' | 'END' | 'PHASE' | 'ALTERNATE';
export type TrainingExerciseMediaLocalizationReviewTarget = 'INSTRUCTION' | 'MEDIA_ACCESSIBILITY';
export type TrainingExerciseMediaApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface TrainingExerciseMediaApprovedAssetBinding {
  assetId: string;
  exerciseId: string;
  viewRole: TrainingExerciseMediaViewRole;
  ordinal: number;
  integritySha256: string;
}

export interface TrainingExerciseMediaManifestSource {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION;
  manifestId: string;
  manifestVersion: string;
  scopeKey: string;
  catalogVersion: typeof TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION;
  catalogSourceHash: string;
  publicationState: TrainingExerciseMediaPublicationState;
  validationStatus: 'PENDING' | 'PASSED' | 'FAILED';
  expectedExerciseCount: number;
  expectedExerciseIds: string[];
  requiredLocales: TrainingExerciseMediaLocale[];
  requiredReviewTypes: TrainingExerciseMediaReviewType[];
  allowedOrigins: string[];
  approvedHostRef: string | null;
  ownerApprovalRef: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface TrainingExerciseMediaExerciseSource {
  exerciseId: string;
  canonicalName: string;
  aliases: string[];
  requiredViews: TrainingExerciseMediaViewRole[];
  exerciseContentHash: string;
  publicationState: TrainingExerciseMediaExerciseState;
  exclusionReason: string | null;
  globalExerciseId: string | null;
  equivalenceHash: string | null;
  createdAt: string;
}

export interface TrainingExerciseMediaAssetSource {
  assetId: string;
  exerciseId: string;
  viewRole: TrainingExerciseMediaViewRole;
  ordinal: number;
  mediaKind: 'IMAGE';
  contentType: string;
  deliveryUrl: string;
  integritySha256: string;
  widthPixels: number;
  heightPixels: number;
  byteSize: number;
  publicationState: TrainingExerciseMediaAssetState;
  createdAt: string;
}

export interface TrainingExerciseInstructionLocalizationSource {
  exerciseId: string;
  locale: TrainingExerciseMediaLocale;
  displayName: string;
  steps: string[];
  cues: string[];
  cautions: string[];
  textFallback: string;
  contentHash: string;
  createdAt: string;
}

export interface TrainingExerciseMediaLocalizationSource {
  assetId: string;
  locale: TrainingExerciseMediaLocale;
  caption: string | null;
  accessibilityDescription: string;
  contentHash: string;
  createdAt: string;
}

export interface TrainingExerciseMediaProvenanceSource {
  assetId: string;
  sourceKind: 'GENERATED' | 'LICENSED' | 'OWNED' | 'COMMISSIONED';
  sourceReference: string;
  generatorModel: string | null;
  promptHash: string | null;
  generatedOrAcquiredAt: string;
  licenseIdentifier: string;
  licenseUrl: string | null;
  rightsHolderRef: string;
  rightsExpiresAt: string | null;
  territories: string[];
  transformations: string[];
  provenanceHash: string;
  publicationAllowed: boolean;
  createdAt: string;
}

export interface TrainingExerciseMediaReviewSource {
  reviewId: string;
  assetId: string;
  reviewType: TrainingExerciseMediaReviewType;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  reviewerRef: string;
  subjectContentHash: string;
  reasonCodes: string[];
  reviewedAt: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TrainingExerciseMediaLocalizationReviewSource {
  reviewId: string;
  targetKind: TrainingExerciseMediaLocalizationReviewTarget;
  targetId: string;
  locale: TrainingExerciseMediaLocale;
  status: TrainingExerciseMediaApprovalStatus;
  reviewerRef: string;
  subjectContentHash: string;
  reasonCodes: string[];
  reviewedAt: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TrainingExerciseMediaHostApprovalSource {
  approvalId: string;
  status: TrainingExerciseMediaApprovalStatus;
  reviewerRef: string;
  subjectOrigins: string[];
  subjectOriginsHash: string;
  reasonCodes: string[];
  reviewedAt: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface TrainingExerciseMediaOwnerApprovalSource {
  approvalId: string;
  status: TrainingExerciseMediaApprovalStatus;
  reviewerRef: string;
  subjectPackageHash: string;
  reasonCodes: string[];
  reviewedAt: string;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * Human approval evidence lives separately from generated catalog sources so
 * candidate-sync reruns cannot erase or rewrite it. The compiler imports this
 * ledger, merges asset reviews, and pins the selected host/owner approval refs
 * into the compiled manifest. Empty arrays/null refs are the only checked-in
 * DRAFT defaults.
 */
export interface TrainingExerciseMediaApprovalLedgerSource {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_APPROVAL_LEDGER_SCHEMA_VERSION;
  approvedHostRef: string | null;
  ownerApprovalRef: string | null;
  assetReviews: TrainingExerciseMediaReviewSource[];
  localizationReviews: TrainingExerciseMediaLocalizationReviewSource[];
  hostApprovals: TrainingExerciseMediaHostApprovalSource[];
  ownerApprovals: TrainingExerciseMediaOwnerApprovalSource[];
}

export interface TrainingExerciseMediaTakedownSource {
  eventId: string;
  assetId: string;
  action: 'REMOVE' | 'REINSTATE';
  reasonCode: string;
  authorityRef: string;
  replacementAssetId: string | null;
  evidenceHash: string;
  effectiveAt: string;
  createdAt: string;
}

export interface TrainingExerciseMediaPackageSources {
  manifest: TrainingExerciseMediaManifestSource;
  exercises: TrainingExerciseMediaExerciseSource[];
  assets: TrainingExerciseMediaAssetSource[];
  instructions: TrainingExerciseInstructionLocalizationSource[];
  mediaLocalizations: TrainingExerciseMediaLocalizationSource[];
  provenance: TrainingExerciseMediaProvenanceSource[];
  reviews: TrainingExerciseMediaReviewSource[];
  localizationReviews: TrainingExerciseMediaLocalizationReviewSource[];
  hostApprovals: TrainingExerciseMediaHostApprovalSource[];
  ownerApprovals: TrainingExerciseMediaOwnerApprovalSource[];
  takedowns: TrainingExerciseMediaTakedownSource[];
}

export interface TrainingExerciseMediaCoverageSummary {
  expectedExercises: number;
  listedExercises: number;
  approvedExercises: number;
  approvedAssets: number;
  instructionLocalizations: number;
  mediaLocalizations: number;
  provenanceRecords: number;
  approvedReviews: number;
  activeTakedowns: number;
}

export interface CompiledTrainingExerciseMediaPackage extends TrainingExerciseMediaPackageSources {
  compiledSchemaVersion: typeof TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION;
  packageHash: string;
  coverage: TrainingExerciseMediaCoverageSummary;
}

export interface TrainingExerciseMediaValidationResult {
  structurallyValid: boolean;
  activationReady: boolean;
  errors: string[];
  activationBlockers: string[];
  coverage: TrainingExerciseMediaCoverageSummary;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MANIFEST_STATES = new Set(['DRAFT', 'STAGED', 'ACTIVE', 'DEPRECATED', 'REVOKED']);
const EXERCISE_STATES = new Set(['DRAFT', 'APPROVED', 'EXCLUDED', 'REMOVED']);
const ASSET_STATES = new Set(['DRAFT', 'APPROVED', 'REJECTED', 'REMOVED']);
const VIEW_ROLES = new Set(['PRIMARY', 'START', 'END', 'PHASE', 'ALTERNATE']);
const MEDIA_KINDS = new Set(['IMAGE']);
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);
const REVIEW_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']);

export function stableTrainingExerciseMediaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTrainingExerciseMediaJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableTrainingExerciseMediaJson(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256TrainingExerciseMedia(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : stableTrainingExerciseMediaJson(value),
  ).digest('hex');
}

export function buildTrainingExerciseMediaApprovedAssetBindings(
  assets: readonly TrainingExerciseMediaAssetSource[],
): TrainingExerciseMediaApprovedAssetBinding[] {
  return assets
    .filter((asset) => asset.publicationState === 'APPROVED')
    .map((asset) => ({
      assetId: asset.assetId,
      exerciseId: asset.exerciseId,
      viewRole: asset.viewRole,
      ordinal: asset.ordinal,
      integritySha256: asset.integritySha256,
    }))
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
}

export function buildTrainingExerciseMediaValidationAttestationHash(
  manifestId: string,
  scopeKey: string,
  packageHash: string,
  expectedApprovedAssetBindings: readonly TrainingExerciseMediaApprovedAssetBinding[],
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_VALIDATION_ATTESTATION_SCHEMA_VERSION,
    manifestId,
    scopeKey,
    packageHash,
    expectedApprovedAssetBindings,
  });
}

export function buildTrainingExerciseMediaAccessibilityBundleHash(
  assetId: string,
  localizations: readonly TrainingExerciseMediaLocalizationSource[],
): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_ACCESSIBILITY_BUNDLE_SCHEMA_VERSION,
    assetId,
    localizations: localizations
      .filter((entry) => entry.assetId === assetId)
      .map((entry) => ({ locale: entry.locale, contentHash: entry.contentHash }))
      .sort((left, right) => left.locale.localeCompare(right.locale)),
  });
}

export function buildTrainingExerciseMediaOriginsHash(origins: readonly string[]): string {
  return sha256TrainingExerciseMedia({
    schemaVersion: TRAINING_EXERCISE_MEDIA_ORIGINS_APPROVAL_SCHEMA_VERSION,
    origins: [...origins].sort(),
  });
}

export function buildCompiledTrainingExerciseMediaPackage(
  sources: TrainingExerciseMediaPackageSources,
): CompiledTrainingExerciseMediaPackage {
  const canonicalSources = canonicalizeSources(sources);
  return {
    compiledSchemaVersion: TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION,
    packageHash: sha256TrainingExerciseMedia(frozenPackageProjection(canonicalSources)),
    ...canonicalSources,
    coverage: buildCoverageSummary(
      canonicalSources,
      isIsoInstant(canonicalSources.manifest.createdAt)
        ? new Date(canonicalSources.manifest.createdAt)
        : new Date(0),
    ),
  };
}

/**
 * Recomputes the immutable package hash from source-shaped records. Mutable
 * lifecycle fields and append-only review/takedown ledgers are intentionally
 * excluded: staging attests the frozen exercise/content rows once, while later
 * governance events may change delivery eligibility without rewriting the
 * reviewed package identity.
 */
export function computeTrainingExerciseMediaFrozenPackageHash(
  sources: TrainingExerciseMediaPackageSources,
): string {
  return sha256TrainingExerciseMedia(frozenPackageProjection(canonicalizeSources(sources)));
}

export function validateCompiledTrainingExerciseMediaPackage(
  compiled: CompiledTrainingExerciseMediaPackage,
  options: { now?: Date; requireActivation?: boolean } = {},
): TrainingExerciseMediaValidationResult {
  const errors: string[] = [];
  const activationBlockers: string[] = [];
  const now = options.now ?? new Date();
  const canonical = canonicalizeSources(compiled);
  const expectedHash = sha256TrainingExerciseMedia(frozenPackageProjection(canonical));
  const coverage = buildCoverageSummary(canonical, now);
  const manifest = canonical.manifest;

  try {
    assertTrainingExerciseIdentityCatalogIntegrity();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Authoritative exercise identity catalog is invalid.');
  }

  if (compiled.compiledSchemaVersion !== TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION) {
    errors.push('Compiled media package schema version is unsupported.');
  }
  if (compiled.packageHash !== expectedHash) errors.push('Compiled media package hash does not match its canonical sources.');
  if (manifest.schemaVersion !== TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION) errors.push('Manifest schema version is unsupported.');
  if (!MANIFEST_STATES.has(manifest.publicationState)) errors.push('Manifest publication state is invalid.');
  if (!['PENDING', 'PASSED', 'FAILED'].includes(manifest.validationStatus)) errors.push('Manifest validation status is invalid.');
  if (!nonEmpty(manifest.manifestId) || !nonEmpty(manifest.manifestVersion)) errors.push('Manifest identity is missing.');
  if (manifest.scopeKey !== '__global__' && !/^tenant:[1-9][0-9]*$/.test(manifest.scopeKey)) {
    errors.push('Manifest scopeKey must be __global__ or tenant:<positive id>.');
  }
  if (manifest.catalogVersion !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION) {
    errors.push('Manifest catalog version does not match the authoritative identity catalog.');
  }
  if (manifest.catalogSourceHash !== TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH) {
    errors.push('Manifest catalog source hash does not match the authoritative identity catalog.');
  }
  if (!Number.isInteger(manifest.expectedExerciseCount) || manifest.expectedExerciseCount !== 158) {
    errors.push('Manifest expected exercise count must match the frozen 158-exercise catalog.');
  }
  if (!sameStringSet(manifest.requiredLocales, TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES)) {
    errors.push('Manifest required locales must be exactly en-US, pt-PT, and pt-BR.');
  }
  if (!sameStringSet(manifest.requiredReviewTypes, TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES)) {
    errors.push('Manifest required reviews must be exactly DOMAIN, LEGAL, ACCESSIBILITY, and OWNER.');
  }
  if (!isIsoInstant(manifest.createdAt) || (manifest.activatedAt != null && !isIsoInstant(manifest.activatedAt))) {
    errors.push('Manifest timestamps must be valid ISO-8601 instants.');
  }
  if (manifest.approvedHostRef != null && !nonEmpty(manifest.approvedHostRef)) {
    errors.push('Manifest approved host reference is invalid.');
  }
  if (manifest.ownerApprovalRef != null && !nonEmpty(manifest.ownerApprovalRef)) {
    errors.push('Manifest owner approval reference is invalid.');
  }

  const allowedOrigins = new Set<string>();
  for (const rawOrigin of manifest.allowedOrigins) {
    const origin = safeHttpsOrigin(rawOrigin);
    if (!origin) errors.push(`Manifest allowed origin is invalid: ${rawOrigin}`);
    else if (allowedOrigins.has(origin)) errors.push(`Manifest allowed origin is duplicated: ${origin}`);
    else allowedOrigins.add(origin);
  }

  const authoritative = buildTrainingExerciseIdentityCatalogSnapshot();
  const authoritativeById = new Map(authoritative.entries.map((entry) => [entry.exerciseId, entry]));
  const authoritativeExerciseIds = authoritative.entries.map((entry) => entry.exerciseId);
  if (!sameStringSet(manifest.expectedExerciseIds, authoritativeExerciseIds)) {
    errors.push('Manifest expected exercise IDs must exactly match the authoritative 158-exercise catalog snapshot.');
  }
  if (manifest.expectedExerciseIds.some((exerciseId) => !SAFE_ID_PATTERN.test(exerciseId))) {
    errors.push('Manifest expected exercise IDs contain an invalid identifier.');
  }
  const exerciseById = new Map<string, TrainingExerciseMediaExerciseSource>();
  const aliasOwner = new Map<string, string>();
  for (const exercise of canonical.exercises) {
    if (!SAFE_ID_PATTERN.test(exercise.exerciseId)) errors.push(`Exercise ID is invalid: ${exercise.exerciseId}`);
    if (exerciseById.has(exercise.exerciseId)) errors.push(`Exercise ID is duplicated: ${exercise.exerciseId}`);
    exerciseById.set(exercise.exerciseId, exercise);
    if (!authoritativeById.has(exercise.exerciseId)) errors.push(`Exercise is not in the authoritative catalog: ${exercise.exerciseId}`);
    if (!nonEmpty(exercise.canonicalName)) errors.push(`Exercise canonical name is missing: ${exercise.exerciseId}`);
    if (!EXERCISE_STATES.has(exercise.publicationState)) errors.push(`Exercise publication state is invalid: ${exercise.exerciseId}`);
    if (!HASH_PATTERN.test(exercise.exerciseContentHash)) errors.push(`Exercise content hash is invalid: ${exercise.exerciseId}`);
    if (!exercise.requiredViews.includes('PRIMARY')) errors.push(`Exercise PRIMARY view is required: ${exercise.exerciseId}`);
    if (exercise.requiredViews.some((role) => !VIEW_ROLES.has(role))) {
      errors.push(`Exercise required view is invalid: ${exercise.exerciseId}`);
    }
    if (new Set(exercise.requiredViews).size !== exercise.requiredViews.length) {
      errors.push(`Exercise required views contain duplicates: ${exercise.exerciseId}`);
    }
    if (new Set(exercise.aliases).size !== exercise.aliases.length) errors.push(`Exercise aliases contain duplicates: ${exercise.exerciseId}`);
    if (manifest.scopeKey !== '__global__' && (!exercise.globalExerciseId || !HASH_PATTERN.test(exercise.equivalenceHash ?? ''))) {
      errors.push(`Tenant exercise requires a reviewed global identity/equivalence hash: ${exercise.exerciseId}`);
    }
    for (const alias of exercise.aliases) {
      if (!SAFE_ID_PATTERN.test(alias)) errors.push(`Exercise alias is invalid: ${alias}`);
      const prior = aliasOwner.get(alias);
      if (prior && prior !== exercise.exerciseId) errors.push(`Exercise alias is ambiguous: ${alias}`);
      if (exerciseById.has(alias) && alias !== exercise.exerciseId) errors.push(`Exercise alias collides with a canonical ID: ${alias}`);
      aliasOwner.set(alias, exercise.exerciseId);
    }
  }
  for (const [alias, owner] of aliasOwner) {
    if (exerciseById.has(alias) && alias !== owner) errors.push(`Exercise alias collides with a canonical ID: ${alias}`);
  }

  const assetById = new Map<string, TrainingExerciseMediaAssetSource>();
  const assetSlot = new Set<string>();
  for (const asset of canonical.assets) {
    if (!nonEmpty(asset.assetId)) errors.push('Asset ID is missing.');
    if (assetById.has(asset.assetId)) errors.push(`Asset ID is duplicated: ${asset.assetId}`);
    assetById.set(asset.assetId, asset);
    if (!exerciseById.has(asset.exerciseId)) errors.push(`Asset references an unknown exercise: ${asset.assetId}`);
    if (!VIEW_ROLES.has(asset.viewRole)) errors.push(`Asset view role is invalid: ${asset.assetId}`);
    if (!MEDIA_KINDS.has(asset.mediaKind)) errors.push(`Asset media kind is invalid: ${asset.assetId}`);
    if (!IMAGE_CONTENT_TYPES.has(asset.contentType)) {
      errors.push(`Asset content type is unsupported by the v1 image contract: ${asset.assetId}`);
    }
    if (!ASSET_STATES.has(asset.publicationState)) errors.push(`Asset publication state is invalid: ${asset.assetId}`);
    const slot = `${asset.exerciseId}:${asset.viewRole}:${asset.ordinal}`;
    if (assetSlot.has(slot)) errors.push(`Asset view slot is duplicated: ${slot}`);
    assetSlot.add(slot);
    if (!Number.isInteger(asset.ordinal) || asset.ordinal < 0) errors.push(`Asset ordinal is invalid: ${asset.assetId}`);
    if (!HASH_PATTERN.test(asset.integritySha256)) errors.push(`Asset integrity hash is invalid: ${asset.assetId}`);
    if (!Number.isInteger(asset.widthPixels) || asset.widthPixels <= 0
      || !Number.isInteger(asset.heightPixels) || asset.heightPixels <= 0
      || !Number.isInteger(asset.byteSize) || asset.byteSize <= 0) {
      errors.push(`Asset dimensions or byte size are invalid: ${asset.assetId}`);
    }
    const url = safeDeliveryUrl(asset.deliveryUrl, allowedOrigins);
    if (!url) errors.push(`Asset delivery URL is not immutable HTTPS content on an approved origin: ${asset.assetId}`);
  }

  const instructionKey = new Set<string>();
  for (const localization of canonical.instructions) {
    const key = `${localization.exerciseId}:${localization.locale}`;
    if (instructionKey.has(key)) errors.push(`Instruction localization is duplicated: ${key}`);
    instructionKey.add(key);
    if (!exerciseById.has(localization.exerciseId)) errors.push(`Instruction references an unknown exercise: ${key}`);
    if (!(TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES as readonly string[]).includes(localization.locale)) {
      errors.push(`Instruction locale is unsupported: ${key}`);
    }
    if (!nonEmpty(localization.displayName) || localization.steps.length === 0
      || localization.steps.some((step) => !nonEmpty(step)) || !nonEmpty(localization.textFallback)) {
      errors.push(`Instruction localization is incomplete: ${key}`);
    }
    if (!HASH_PATTERN.test(localization.contentHash)) errors.push(`Instruction localization hash is invalid: ${key}`);
  }

  const mediaLocalizationKey = new Set<string>();
  for (const localization of canonical.mediaLocalizations) {
    const key = `${localization.assetId}:${localization.locale}`;
    if (mediaLocalizationKey.has(key)) errors.push(`Media localization is duplicated: ${key}`);
    mediaLocalizationKey.add(key);
    if (!assetById.has(localization.assetId)) errors.push(`Media localization references an unknown asset: ${key}`);
    if (!(TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES as readonly string[]).includes(localization.locale)) {
      errors.push(`Media localization locale is unsupported: ${key}`);
    }
    if (!nonEmpty(localization.accessibilityDescription)) errors.push(`Media accessibility description is missing: ${key}`);
    if (!HASH_PATTERN.test(localization.contentHash)) errors.push(`Media localization hash is invalid: ${key}`);
  }

  const provenanceByAsset = new Map<string, TrainingExerciseMediaProvenanceSource>();
  for (const provenance of canonical.provenance) {
    if (provenanceByAsset.has(provenance.assetId)) errors.push(`Asset provenance is duplicated: ${provenance.assetId}`);
    provenanceByAsset.set(provenance.assetId, provenance);
    if (!assetById.has(provenance.assetId)) errors.push(`Provenance references an unknown asset: ${provenance.assetId}`);
    if (!['GENERATED', 'LICENSED', 'OWNED', 'COMMISSIONED'].includes(provenance.sourceKind)) {
      errors.push(`Asset provenance source kind is invalid: ${provenance.assetId}`);
    }
    if (!nonEmpty(provenance.sourceReference) || !nonEmpty(provenance.licenseIdentifier)
      || !nonEmpty(provenance.rightsHolderRef) || !HASH_PATTERN.test(provenance.provenanceHash)) {
      errors.push(`Asset provenance is incomplete: ${provenance.assetId}`);
    }
    if (provenance.promptHash != null && !HASH_PATTERN.test(provenance.promptHash)) {
      errors.push(`Asset provenance prompt hash is invalid: ${provenance.assetId}`);
    }
    if (!isIsoInstant(provenance.generatedOrAcquiredAt)
      || (provenance.rightsExpiresAt != null && !isIsoInstant(provenance.rightsExpiresAt))) {
      errors.push(`Asset provenance timestamps are invalid: ${provenance.assetId}`);
    }
    if (provenance.licenseUrl != null && !safeHttpsUrl(provenance.licenseUrl)) {
      errors.push(`Asset license URL must be HTTPS: ${provenance.assetId}`);
    }
  }

  const reviewIds = new Set<string>();
  const latestReview = new Map<string, TrainingExerciseMediaReviewSource>();
  for (const review of canonical.reviews) {
    if (reviewIds.has(review.reviewId)) errors.push(`Review ID is duplicated: ${review.reviewId}`);
    reviewIds.add(review.reviewId);
    if (!assetById.has(review.assetId)) errors.push(`Review references an unknown asset: ${review.reviewId}`);
    if (!(TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES as readonly string[]).includes(review.reviewType)) {
      errors.push(`Review type is invalid: ${review.reviewId}`);
    }
    if (!REVIEW_STATUSES.has(review.status)) errors.push(`Review status is invalid: ${review.reviewId}`);
    if (!HASH_PATTERN.test(review.subjectContentHash)) errors.push(`Review subject hash is invalid: ${review.reviewId}`);
    if (!isIsoInstant(review.reviewedAt) || (review.expiresAt != null && !isIsoInstant(review.expiresAt))) {
      errors.push(`Review timestamps are invalid: ${review.reviewId}`);
    }
    if (isIsoInstant(review.reviewedAt) && Date.parse(review.reviewedAt) <= now.getTime()) {
      const key = `${review.assetId}:${review.reviewType}`;
      const prior = latestReview.get(key);
      if (!prior || compareDatedIds(review.reviewedAt, review.reviewId, prior.reviewedAt, prior.reviewId) > 0) {
        latestReview.set(key, review);
      }
    }
  }

  const localizationReviewIds = new Set<string>();
  const latestLocalizationReview = new Map<string, TrainingExerciseMediaLocalizationReviewSource>();
  for (const review of canonical.localizationReviews) {
    if (localizationReviewIds.has(review.reviewId)) {
      errors.push(`Localization review ID is duplicated: ${review.reviewId}`);
    }
    localizationReviewIds.add(review.reviewId);
    if (!['INSTRUCTION', 'MEDIA_ACCESSIBILITY'].includes(review.targetKind)) {
      errors.push(`Localization review target kind is invalid: ${review.reviewId}`);
    }
    if (review.targetKind === 'INSTRUCTION' && !exerciseById.has(review.targetId)) {
      errors.push(`Localization review references an unknown exercise: ${review.reviewId}`);
    }
    if (review.targetKind === 'MEDIA_ACCESSIBILITY' && !assetById.has(review.targetId)) {
      errors.push(`Localization review references an unknown asset: ${review.reviewId}`);
    }
    if (!(TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES as readonly string[]).includes(review.locale)) {
      errors.push(`Localization review locale is unsupported: ${review.reviewId}`);
    }
    if (!REVIEW_STATUSES.has(review.status)) errors.push(`Localization review status is invalid: ${review.reviewId}`);
    if (!nonEmpty(review.reviewerRef) || !HASH_PATTERN.test(review.subjectContentHash)) {
      errors.push(`Localization review evidence is invalid: ${review.reviewId}`);
    }
    if (!isIsoInstant(review.reviewedAt) || (review.expiresAt != null && !isIsoInstant(review.expiresAt))) {
      errors.push(`Localization review timestamps are invalid: ${review.reviewId}`);
    }
    if (isIsoInstant(review.reviewedAt) && Date.parse(review.reviewedAt) <= now.getTime()) {
      const key = `${review.targetKind}:${review.targetId}:${review.locale}`;
      const prior = latestLocalizationReview.get(key);
      if (!prior || compareDatedIds(review.reviewedAt, review.reviewId, prior.reviewedAt, prior.reviewId) > 0) {
        latestLocalizationReview.set(key, review);
      }
    }
  }

  const hostApprovalById = new Map<string, TrainingExerciseMediaHostApprovalSource>();
  for (const approval of canonical.hostApprovals) {
    if (hostApprovalById.has(approval.approvalId)) errors.push(`Host approval ID is duplicated: ${approval.approvalId}`);
    hostApprovalById.set(approval.approvalId, approval);
    if (!nonEmpty(approval.approvalId) || !nonEmpty(approval.reviewerRef)
      || !REVIEW_STATUSES.has(approval.status) || !HASH_PATTERN.test(approval.subjectOriginsHash)) {
      errors.push(`Host approval evidence is invalid: ${approval.approvalId}`);
    }
    const normalizedOrigins = approval.subjectOrigins.map(safeHttpsOrigin);
    if (normalizedOrigins.some((origin) => origin == null)
      || new Set(normalizedOrigins).size !== normalizedOrigins.length) {
      errors.push(`Host approval origins are invalid: ${approval.approvalId}`);
    } else if (approval.subjectOriginsHash !== buildTrainingExerciseMediaOriginsHash(
      normalizedOrigins as string[],
    )) {
      errors.push(`Host approval origins hash is invalid: ${approval.approvalId}`);
    }
    if (!isIsoInstant(approval.reviewedAt) || (approval.expiresAt != null && !isIsoInstant(approval.expiresAt))) {
      errors.push(`Host approval timestamps are invalid: ${approval.approvalId}`);
    }
  }

  const ownerApprovalById = new Map<string, TrainingExerciseMediaOwnerApprovalSource>();
  for (const approval of canonical.ownerApprovals) {
    if (ownerApprovalById.has(approval.approvalId)) errors.push(`Owner approval ID is duplicated: ${approval.approvalId}`);
    ownerApprovalById.set(approval.approvalId, approval);
    if (!nonEmpty(approval.approvalId) || !nonEmpty(approval.reviewerRef)
      || !REVIEW_STATUSES.has(approval.status) || !HASH_PATTERN.test(approval.subjectPackageHash)) {
      errors.push(`Owner approval evidence is invalid: ${approval.approvalId}`);
    }
    if (!isIsoInstant(approval.reviewedAt) || (approval.expiresAt != null && !isIsoInstant(approval.expiresAt))) {
      errors.push(`Owner approval timestamps are invalid: ${approval.approvalId}`);
    }
  }

  const takedownIds = new Set<string>();
  const latestTakedown = new Map<string, TrainingExerciseMediaTakedownSource>();
  for (const event of canonical.takedowns) {
    if (takedownIds.has(event.eventId)) errors.push(`Takedown event ID is duplicated: ${event.eventId}`);
    takedownIds.add(event.eventId);
    if (!assetById.has(event.assetId)) errors.push(`Takedown references an unknown asset: ${event.eventId}`);
    if (!['REMOVE', 'REINSTATE'].includes(event.action)) errors.push(`Takedown action is invalid: ${event.eventId}`);
    if (event.replacementAssetId != null && !assetById.has(event.replacementAssetId)) {
      errors.push(`Takedown replacement references an unknown asset: ${event.eventId}`);
    }
    if (!HASH_PATTERN.test(event.evidenceHash) || !isIsoInstant(event.effectiveAt)) {
      errors.push(`Takedown evidence or timestamp is invalid: ${event.eventId}`);
    }
    if (isIsoInstant(event.effectiveAt) && Date.parse(event.effectiveAt) <= now.getTime()) {
      const prior = latestTakedown.get(event.assetId);
      if (!prior || compareDatedIds(event.effectiveAt, event.eventId, prior.effectiveAt, prior.eventId) > 0) {
        latestTakedown.set(event.assetId, event);
      }
    }
  }

  if (manifest.publicationState !== 'ACTIVE') activationBlockers.push('Manifest publication state is not ACTIVE.');
  if (manifest.validationStatus !== 'PASSED') activationBlockers.push('Manifest validation status is not PASSED.');
  if (!manifest.activatedAt) activationBlockers.push('Manifest has no activation timestamp.');
  if (allowedOrigins.size === 0) activationBlockers.push('Manifest has no approved delivery origin.');
  if (!manifest.approvedHostRef) {
    activationBlockers.push('Manifest has no immutable approved host reference.');
  } else {
    const approval = hostApprovalById.get(manifest.approvedHostRef);
    if (!approval || approval.status !== 'APPROVED'
      || approval.subjectOriginsHash !== buildTrainingExerciseMediaOriginsHash([...allowedOrigins])
      || Date.parse(approval.reviewedAt) > now.getTime()
      || (approval.expiresAt != null && Date.parse(approval.expiresAt) <= now.getTime())) {
      activationBlockers.push('Manifest approved host reference is not valid for its exact delivery origins.');
    }
  }
  if (!manifest.ownerApprovalRef) {
    activationBlockers.push('Manifest has no immutable owner approval reference.');
  } else {
    const approval = ownerApprovalById.get(manifest.ownerApprovalRef);
    if (!approval || approval.status !== 'APPROVED'
      || approval.subjectPackageHash !== compiled.packageHash
      || Date.parse(approval.reviewedAt) > now.getTime()
      || (approval.expiresAt != null && Date.parse(approval.expiresAt) <= now.getTime())) {
      activationBlockers.push('Manifest owner approval is not valid for its exact package hash.');
    }
  }
  if (coverage.approvedExercises !== manifest.expectedExerciseCount) {
    activationBlockers.push(`Approved exercise coverage is ${coverage.approvedExercises}/${manifest.expectedExerciseCount}.`);
  }
  const missingCanonical = authoritative.entries
    .map((entry) => entry.exerciseId)
    .filter((exerciseId) => exerciseById.get(exerciseId)?.publicationState !== 'APPROVED');
  if (missingCanonical.length > 0) activationBlockers.push(`Authoritative exercise coverage is missing: ${missingCanonical.join(', ')}.`);

  for (const exercise of canonical.exercises.filter((entry) => entry.publicationState === 'APPROVED')) {
    for (const locale of manifest.requiredLocales) {
      const key = `${exercise.exerciseId}:${locale}`;
      const localization = canonical.instructions.find((entry) => (
        entry.exerciseId === exercise.exerciseId && entry.locale === locale
      ));
      if (!instructionKey.has(key) || !localization) {
        activationBlockers.push(`Missing ${locale} instruction text for ${exercise.exerciseId}.`);
      } else {
        const review = latestLocalizationReview.get(`INSTRUCTION:${key}`);
        if (!review || review.status !== 'APPROVED'
          || review.subjectContentHash !== localization.contentHash
          || (review.expiresAt != null && Date.parse(review.expiresAt) <= now.getTime())) {
          activationBlockers.push(`Latest ${locale} instruction localization review is not valid for ${exercise.exerciseId}.`);
        }
      }
    }
    for (const view of exercise.requiredViews) {
      const matchingAssets = canonical.assets.filter((asset) => asset.exerciseId === exercise.exerciseId
        && asset.viewRole === view && asset.publicationState === 'APPROVED');
      if (matchingAssets.length === 0) activationBlockers.push(`Missing approved ${view} asset for ${exercise.exerciseId}.`);
    }
  }

  for (const asset of canonical.assets.filter((entry) => entry.publicationState === 'APPROVED')) {
    const provenance = provenanceByAsset.get(asset.assetId);
    if (!provenance?.publicationAllowed) activationBlockers.push(`Asset provenance is not publication-approved: ${asset.assetId}.`);
    if (provenance?.rightsExpiresAt && Date.parse(provenance.rightsExpiresAt) <= now.getTime()) {
      activationBlockers.push(`Asset rights have expired: ${asset.assetId}.`);
    }
    for (const locale of manifest.requiredLocales) {
      const key = `${asset.assetId}:${locale}`;
      const localization = canonical.mediaLocalizations.find((entry) => (
        entry.assetId === asset.assetId && entry.locale === locale
      ));
      if (!mediaLocalizationKey.has(key) || !localization) {
        activationBlockers.push(`Missing ${locale} media accessibility description for ${asset.assetId}.`);
      } else {
        const review = latestLocalizationReview.get(`MEDIA_ACCESSIBILITY:${key}`);
        if (!review || review.status !== 'APPROVED'
          || review.subjectContentHash !== localization.contentHash
          || (review.expiresAt != null && Date.parse(review.expiresAt) <= now.getTime())) {
          activationBlockers.push(`Latest ${locale} media localization review is not valid for ${asset.assetId}.`);
        }
      }
    }
    const accessibilityBundleHash = buildTrainingExerciseMediaAccessibilityBundleHash(
      asset.assetId,
      canonical.mediaLocalizations,
    );
    for (const reviewType of manifest.requiredReviewTypes) {
      const review = latestReview.get(`${asset.assetId}:${reviewType}`);
      const expectedSubjectHash = reviewType === 'ACCESSIBILITY'
        ? accessibilityBundleHash
        : asset.integritySha256;
      if (!review || review.status !== 'APPROVED' || review.subjectContentHash !== expectedSubjectHash
        || (review.expiresAt != null && Date.parse(review.expiresAt) <= now.getTime())) {
        activationBlockers.push(`Latest ${reviewType} review is not valid for ${asset.assetId}.`);
      }
    }
    if (latestTakedown.get(asset.assetId)?.action === 'REMOVE') {
      activationBlockers.push(`Asset has an active takedown: ${asset.assetId}.`);
    }
  }

  const structurallyValid = errors.length === 0;
  const activationReady = structurallyValid && activationBlockers.length === 0;
  if (options.requireActivation && !activationReady && activationBlockers.length === 0) {
    activationBlockers.push('Media package is not activation-ready.');
  }
  return { structurallyValid, activationReady, errors, activationBlockers, coverage };
}

export function assertCompiledTrainingExerciseMediaPackage(
  compiled: CompiledTrainingExerciseMediaPackage,
  options: { now?: Date; requireActivation?: boolean } = {},
): void {
  const result = validateCompiledTrainingExerciseMediaPackage(compiled, options);
  const failures = [
    ...result.errors,
    ...(options.requireActivation ? result.activationBlockers : []),
  ];
  if (failures.length > 0) throw new Error(`Training exercise media package is invalid: ${failures.join(' ')}`);
}

function canonicalizeSources(sources: TrainingExerciseMediaPackageSources): TrainingExerciseMediaPackageSources {
  return {
    manifest: {
      ...sources.manifest,
      expectedExerciseIds: [...sources.manifest.expectedExerciseIds].sort(),
      requiredLocales: [...sources.manifest.requiredLocales],
      requiredReviewTypes: [...sources.manifest.requiredReviewTypes],
      allowedOrigins: sources.manifest.allowedOrigins
        .map((origin) => safeHttpsOrigin(origin) ?? origin)
        .sort(),
    },
    exercises: [...sources.exercises].map((entry) => ({
      ...entry,
      aliases: [...entry.aliases].sort(),
      requiredViews: [...entry.requiredViews],
    })).sort((left, right) => left.exerciseId.localeCompare(right.exerciseId)),
    assets: [...sources.assets].sort((left, right) => left.assetId.localeCompare(right.assetId)),
    instructions: [...sources.instructions].map((entry) => ({
      ...entry, steps: [...entry.steps], cues: [...entry.cues], cautions: [...entry.cautions],
    })).sort((left, right) => `${left.exerciseId}:${left.locale}`.localeCompare(`${right.exerciseId}:${right.locale}`)),
    mediaLocalizations: [...sources.mediaLocalizations]
      .sort((left, right) => `${left.assetId}:${left.locale}`.localeCompare(`${right.assetId}:${right.locale}`)),
    provenance: [...sources.provenance].map((entry) => ({
      ...entry, territories: [...entry.territories].sort(), transformations: [...entry.transformations],
    })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
    reviews: [...sources.reviews].map((entry) => ({ ...entry, reasonCodes: [...entry.reasonCodes].sort() }))
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
    localizationReviews: [...sources.localizationReviews]
      .map((entry) => ({ ...entry, reasonCodes: [...entry.reasonCodes].sort() }))
      .sort((left, right) => left.reviewId.localeCompare(right.reviewId)),
    hostApprovals: [...sources.hostApprovals].map((entry) => ({
      ...entry,
      subjectOrigins: entry.subjectOrigins.map((origin) => safeHttpsOrigin(origin) ?? origin).sort(),
      reasonCodes: [...entry.reasonCodes].sort(),
    })).sort((left, right) => left.approvalId.localeCompare(right.approvalId)),
    ownerApprovals: [...sources.ownerApprovals]
      .map((entry) => ({ ...entry, reasonCodes: [...entry.reasonCodes].sort() }))
      .sort((left, right) => left.approvalId.localeCompare(right.approvalId)),
    takedowns: [...sources.takedowns].sort((left, right) => left.eventId.localeCompare(right.eventId)),
  };
}

function buildCoverageSummary(
  sources: TrainingExerciseMediaPackageSources,
  now: Date,
): TrainingExerciseMediaCoverageSummary {
  const latestTakedown = new Map<string, TrainingExerciseMediaTakedownSource>();
  for (const event of sources.takedowns) {
    if (!isIsoInstant(event.effectiveAt) || Date.parse(event.effectiveAt) > now.getTime()) continue;
    const prior = latestTakedown.get(event.assetId);
    if (!prior || compareDatedIds(event.effectiveAt, event.eventId, prior.effectiveAt, prior.eventId) > 0) {
      latestTakedown.set(event.assetId, event);
    }
  }
  return {
    expectedExercises: sources.manifest.expectedExerciseCount,
    listedExercises: sources.exercises.length,
    approvedExercises: sources.exercises.filter((entry) => entry.publicationState === 'APPROVED').length,
    approvedAssets: sources.assets.filter((entry) => entry.publicationState === 'APPROVED').length,
    instructionLocalizations: sources.instructions.length,
    mediaLocalizations: sources.mediaLocalizations.length,
    provenanceRecords: sources.provenance.length,
    approvedReviews: sources.reviews.filter((entry) => entry.status === 'APPROVED').length,
    activeTakedowns: [...latestTakedown.values()].filter((entry) => entry.action === 'REMOVE').length,
  };
}

function frozenPackageProjection(sources: TrainingExerciseMediaPackageSources): unknown {
  return {
    manifest: {
      schemaVersion: sources.manifest.schemaVersion,
      manifestId: sources.manifest.manifestId,
      manifestVersion: sources.manifest.manifestVersion,
      scopeKey: sources.manifest.scopeKey,
      catalogVersion: sources.manifest.catalogVersion,
      catalogSourceHash: sources.manifest.catalogSourceHash,
      expectedExerciseCount: sources.manifest.expectedExerciseCount,
      expectedExerciseIds: sources.manifest.expectedExerciseIds,
      requiredLocales: sources.manifest.requiredLocales,
      requiredReviewTypes: sources.manifest.requiredReviewTypes,
      allowedOrigins: sources.manifest.allowedOrigins,
      createdAt: sources.manifest.createdAt,
    },
    exercises: sources.exercises,
    assets: sources.assets,
    instructions: sources.instructions,
    mediaLocalizations: sources.mediaLocalizations,
    provenance: sources.provenance,
  };
}

function safeHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function safeDeliveryUrl(raw: string, allowedOrigins: ReadonlySet<string>): URL | null {
  const url = safeHttpsUrl(raw);
  if (!url || url.search || !allowedOrigins.has(url.origin)) return null;
  return url;
}

function compareDatedIds(leftDate: string, leftId: string, rightDate: string, rightId: string): number {
  const byDate = leftDate.localeCompare(rightDate);
  return byDate !== 0 ? byDate : leftId.localeCompare(rightId);
}

function isIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
