// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
  buildTrainingExerciseIdentityCatalogSnapshot,
} from './training-exercise-identity';
import {
  TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION,
  TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES,
  buildTrainingExerciseMediaValidationAttestationHash,
  sha256TrainingExerciseMedia,
  type TrainingExerciseMediaApprovedAssetBinding,
  type TrainingExerciseMediaLocale,
  type TrainingExerciseMediaReviewType,
  type TrainingExerciseMediaViewRole,
} from './training-exercise-media-manifest';

export type TrainingExerciseMediaUnavailableReason =
  | 'UNKNOWN_EXERCISE'
  | 'AMBIGUOUS_ALIAS'
  | 'MEDIA_UNAVAILABLE';

export interface TrainingExerciseMediaInstructionDto {
  locale: TrainingExerciseMediaLocale;
  fallbackFromLocale: TrainingExerciseMediaLocale | null;
  displayName: string;
  steps: string[];
  cues: string[];
  cautions: string[];
  textFallback: string;
}

export interface TrainingExerciseMediaAssetDto {
  assetId: string;
  exerciseId: string;
  version: 1;
  viewRole: TrainingExerciseMediaViewRole;
  ordinal: number;
  mediaKind: 'IMAGE';
  contentType: string;
  url: string;
  integritySha256: string;
  widthPixels: number;
  heightPixels: number;
  byteSize: number;
  accessibilityDescription: string;
  caption: string | null;
  locale: TrainingExerciseMediaLocale;
  fallbackFromLocale: TrainingExerciseMediaLocale | null;
  immutableCacheKey: string;
  governance: {
    publicationState: 'PUBLISHED';
    reviewState: 'APPROVED';
    safetyState: 'APPROVED';
    approvalReference: string;
    reviewedAt: string;
    licenseIdentifier: string;
    licenseTermsURL: string | null;
    rightsExpiresAt: string | null;
    provenanceSource: 'GENERATED' | 'LICENSED' | 'OWNED' | 'COMMISSIONED';
  };
}

export interface AvailableTrainingExerciseMediaDto {
  kind: 'AVAILABLE';
  requestedExerciseId: string;
  exerciseId: string;
  canonicalName: string;
  resolvedBy: 'CANONICAL_ID' | 'REVIEWED_ALIAS';
  instruction: TrainingExerciseMediaInstructionDto;
  requiredViews: TrainingExerciseMediaViewRole[];
  assets: TrainingExerciseMediaAssetDto[];
}

export interface UnavailableTrainingExerciseMediaDto {
  kind: 'UNAVAILABLE';
  requestedExerciseId: string;
  rawIdentifier: string;
  reason: TrainingExerciseMediaUnavailableReason;
  textFallbackRequired: true;
}

export type TrainingExerciseMediaItemDto =
  | AvailableTrainingExerciseMediaDto
  | UnavailableTrainingExerciseMediaDto;

export interface TrainingExerciseMediaBatchDto {
  schemaVersion: typeof TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION;
  manifestVersion: string;
  catalogVersion: typeof TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION;
  catalogSourceHash: string;
  requestedLocale: TrainingExerciseMediaLocale;
  items: TrainingExerciseMediaItemDto[];
  eTag: string;
}

interface ManifestRow {
  manifest_id: string;
  manifest_version: string;
  scope_key: string;
  catalog_version: string;
  catalog_source_hash: string;
  package_hash: string;
  expected_approved_asset_bindings_json: string;
  validation_attested_package_hash: string | null;
  validation_attestation_hash: string | null;
  expected_exercise_count: number;
  expected_exercise_ids_json: string;
  required_review_types_json: string;
  allowed_origins_json: string;
}

interface ExerciseRow {
  exercise_id: string;
  canonical_name: string;
  aliases_json: string;
  required_views_json: string;
  publication_state: 'DRAFT' | 'APPROVED' | 'EXCLUDED' | 'REMOVED';
}

interface AssetRow {
  asset_id: string;
  exercise_id: string;
  view_role: TrainingExerciseMediaViewRole;
  ordinal: number;
  media_kind: 'IMAGE';
  content_type: string;
  delivery_url: string;
  integrity_sha256: string;
  width_pixels: number;
  height_pixels: number;
  byte_size: number;
}

interface InstructionRow {
  exercise_id: string;
  locale: TrainingExerciseMediaLocale;
  display_name: string;
  steps_json: string;
  cues_json: string;
  cautions_json: string;
  text_fallback: string;
}

interface MediaLocalizationRow {
  asset_id: string;
  locale: TrainingExerciseMediaLocale;
  caption: string | null;
  accessibility_description: string;
}

interface ProvenanceRow {
  asset_id: string;
  source_kind: 'GENERATED' | 'LICENSED' | 'OWNED' | 'COMMISSIONED';
  license_identifier: string;
  license_url: string | null;
  rights_expires_at: string | null;
  publication_allowed: number;
}

interface ReviewRow {
  review_id: string;
  asset_id: string;
  review_type: TrainingExerciseMediaReviewType;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  subject_content_hash: string;
  reviewed_at: string;
  expires_at: string | null;
}

interface TakedownRow {
  event_id: string;
  asset_id: string;
  action: 'REMOVE' | 'REINSTATE';
  effective_at: string;
}

export interface TrainingExerciseMediaLookupOptions {
  db?: Database.Database;
  now?: Date;
  /** Deterministic test seam. Production callers always use the frozen catalog snapshot. */
  expectedExerciseIds?: readonly string[];
}

export function lookupTrainingExerciseMedia(
  tenantId: number,
  userId: number,
  requestedExerciseIds: readonly string[],
  requestedLocale: TrainingExerciseMediaLocale,
  options: TrainingExerciseMediaLookupOptions = {},
): TrainingExerciseMediaBatchDto | null {
  if (!Number.isInteger(tenantId) || tenantId <= 0 || tenantId !== userId) return null;
  if (requestedExerciseIds.length === 0 || requestedExerciseIds.length > 50) return null;
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const expectedExerciseIds = options.expectedExerciseIds
    ? [...options.expectedExerciseIds]
    : buildTrainingExerciseIdentityCatalogSnapshot().entries.map((entry) => entry.exerciseId);
  if (!isExactSafeIdentifierSet(expectedExerciseIds, expectedExerciseIds)) return null;
  const manifest = findActiveManifest(db, tenantId);
  if (!manifest) return null;
  if (manifest.catalog_version !== TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION
    || manifest.catalog_source_hash !== TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH) return null;
  const manifestExpectedExerciseIds = parseStringArray(manifest.expected_exercise_ids_json);
  if (manifest.expected_exercise_count !== expectedExerciseIds.length
    || !isExactSafeIdentifierSet(manifestExpectedExerciseIds, expectedExerciseIds)) return null;
  const expectedApprovedAssetBindings = parseApprovedAssetBindings(
    manifest.expected_approved_asset_bindings_json,
  );
  if (expectedApprovedAssetBindings.length === 0
    || manifest.validation_attested_package_hash !== manifest.package_hash
    || !manifest.validation_attestation_hash
    || manifest.validation_attestation_hash !== buildTrainingExerciseMediaValidationAttestationHash(
      manifest.manifest_id,
      manifest.scope_key,
      manifest.package_hash,
      expectedApprovedAssetBindings,
    )) return null;

  const rawAllowedOrigins = parseStringArray(manifest.allowed_origins_json);
  const allowedOrigins = rawAllowedOrigins
    .map(safeHttpsOrigin)
    .filter((origin): origin is string => origin != null);
  if (allowedOrigins.length === 0 || allowedOrigins.length !== rawAllowedOrigins.length
    || new Set(allowedOrigins).size !== allowedOrigins.length) return null;
  const requiredReviewTypes = parseStringArray(manifest.required_review_types_json)
    .filter((value): value is TrainingExerciseMediaReviewType => (
      (TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES as readonly string[]).includes(value)
    ));
  if (requiredReviewTypes.length !== TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES.length
    || new Set(requiredReviewTypes).size !== requiredReviewTypes.length
    || !TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES.every((value) => requiredReviewTypes.includes(value))) return null;

  const exercises = db.prepare(`
    SELECT exercise_id, canonical_name, aliases_json, required_views_json, publication_state
      FROM training_exercise_media_exercises
     WHERE manifest_id = ? AND scope_key = ?
     ORDER BY exercise_id ASC
  `).all(manifest.manifest_id, manifest.scope_key) as ExerciseRow[];
  if (exercises.some((exercise) => exercise.publication_state !== 'APPROVED')
    || !isExactSafeIdentifierSet(exercises.map((exercise) => exercise.exercise_id), expectedExerciseIds)) return null;
  const storedApprovedAssetBindings = db.prepare(`
    SELECT asset_id, exercise_id, view_role, ordinal, integrity_sha256
      FROM training_exercise_media_assets
     WHERE manifest_id = ? AND scope_key = ? AND publication_state = 'APPROVED'
     ORDER BY asset_id ASC
  `).all(manifest.manifest_id, manifest.scope_key).map((row) => {
    const value = row as {
      asset_id: string;
      exercise_id: string;
      view_role: TrainingExerciseMediaViewRole;
      ordinal: number;
      integrity_sha256: string;
    };
    return {
      assetId: value.asset_id,
      exerciseId: value.exercise_id,
      viewRole: value.view_role,
      ordinal: value.ordinal,
      integritySha256: value.integrity_sha256,
    } satisfies TrainingExerciseMediaApprovedAssetBinding;
  }).sort((left, right) => left.assetId.localeCompare(right.assetId));
  if (JSON.stringify(storedApprovedAssetBindings) !== JSON.stringify(expectedApprovedAssetBindings)) return null;
  const exerciseById = new Map(exercises.map((exercise) => [exercise.exercise_id, exercise]));
  const aliases = new Map<string, ExerciseRow[]>();
  for (const exercise of exercises) {
    for (const alias of parseStringArray(exercise.aliases_json)) {
      const owners = aliases.get(alias) ?? [];
      owners.push(exercise);
      aliases.set(alias, owners);
    }
  }

  const resolved = requestedExerciseIds.map((requestedExerciseId) => {
    const canonical = exerciseById.get(requestedExerciseId);
    if (canonical) return { requestedExerciseId, exercise: canonical, resolvedBy: 'CANONICAL_ID' as const };
    const aliasMatches = aliases.get(requestedExerciseId) ?? [];
    if (aliasMatches.length === 1) {
      return { requestedExerciseId, exercise: aliasMatches[0], resolvedBy: 'REVIEWED_ALIAS' as const };
    }
    return {
      requestedExerciseId,
      exercise: null,
      unavailableReason: aliasMatches.length > 1 ? 'AMBIGUOUS_ALIAS' as const : 'UNKNOWN_EXERCISE' as const,
    };
  });
  const canonicalIds = [...new Set(resolved.flatMap((entry) => entry.exercise ? [entry.exercise.exercise_id] : []))];
  const assets = queryForIds<AssetRow>(db, `
    SELECT asset_id, exercise_id, view_role, ordinal, media_kind, content_type,
           delivery_url, integrity_sha256, width_pixels, height_pixels, byte_size
      FROM training_exercise_media_assets
     WHERE manifest_id = ? AND scope_key = ? AND publication_state = 'APPROVED'
       AND exercise_id IN (__IDS__)
     ORDER BY exercise_id ASC, view_role ASC, ordinal ASC, asset_id ASC
  `, [manifest.manifest_id, manifest.scope_key], canonicalIds);
  const assetIds = assets.map((asset) => asset.asset_id);
  const instructions = queryForIds<InstructionRow>(db, `
    SELECT exercise_id, locale, display_name, steps_json, cues_json, cautions_json, text_fallback
      FROM training_exercise_instruction_localizations
     WHERE manifest_id = ? AND scope_key = ?
       AND exercise_id IN (__IDS__)
       AND locale IN (?, 'en-US')
  `, [manifest.manifest_id, manifest.scope_key], canonicalIds, [requestedLocale]);
  const mediaLocalizations = queryForIds<MediaLocalizationRow>(db, `
    SELECT asset_id, locale, caption, accessibility_description
      FROM training_exercise_media_localizations
     WHERE manifest_id = ? AND scope_key = ?
       AND asset_id IN (__IDS__) AND locale IN (?, 'en-US')
  `, [manifest.manifest_id, manifest.scope_key], assetIds, [requestedLocale]);
  const provenance = queryForIds<ProvenanceRow>(db, `
    SELECT asset_id, source_kind, license_identifier, license_url,
           rights_expires_at, publication_allowed
      FROM training_exercise_media_provenance
     WHERE manifest_id = ? AND scope_key = ? AND asset_id IN (__IDS__)
  `, [manifest.manifest_id, manifest.scope_key], assetIds);
  const reviews = queryForIds<ReviewRow>(db, `
    SELECT review_id, asset_id, review_type, status, subject_content_hash, reviewed_at, expires_at
      FROM training_exercise_media_reviews
     WHERE manifest_id = ? AND scope_key = ? AND asset_id IN (__IDS__)
     ORDER BY reviewed_at DESC, review_id DESC
  `, [manifest.manifest_id, manifest.scope_key], assetIds);
  const takedowns = queryForIds<TakedownRow>(db, `
    SELECT event_id, asset_id, action, effective_at
      FROM training_exercise_media_takedown_events
     WHERE manifest_id = ? AND scope_key = ? AND asset_id IN (__IDS__)
     ORDER BY effective_at DESC, event_id DESC
  `, [manifest.manifest_id, manifest.scope_key], assetIds);

  const instructionByKey = new Map(instructions.map((entry) => [`${entry.exercise_id}:${entry.locale}`, entry]));
  const mediaLocalizationByKey = new Map(mediaLocalizations.map((entry) => [`${entry.asset_id}:${entry.locale}`, entry]));
  const provenanceByAsset = new Map(provenance.map((entry) => [entry.asset_id, entry]));
  const latestReviewByKey = new Map<string, ReviewRow>();
  const invalidReviewKeys = new Set<string>();
  for (const review of reviews) {
    const key = `${review.asset_id}:${review.review_type}`;
    const reviewedAt = Date.parse(review.reviewed_at);
    if (!Number.isFinite(reviewedAt)
      || (review.expires_at != null && !Number.isFinite(Date.parse(review.expires_at)))) {
      invalidReviewKeys.add(key);
      continue;
    }
    if (reviewedAt > now.getTime()) continue;
    const current = latestReviewByKey.get(key);
    if (!current || isLaterDatedId(review.reviewed_at, review.review_id, current.reviewed_at, current.review_id)) {
      latestReviewByKey.set(key, review);
    }
  }
  const latestTakedownByAsset = new Map<string, TakedownRow>();
  const invalidTakedownAssets = new Set<string>();
  for (const event of takedowns) {
    const effectiveAt = Date.parse(event.effective_at);
    if (!Number.isFinite(effectiveAt)) {
      invalidTakedownAssets.add(event.asset_id);
      continue;
    }
    if (effectiveAt > now.getTime()) continue;
    const current = latestTakedownByAsset.get(event.asset_id);
    if (!current || isLaterDatedId(event.effective_at, event.event_id, current.effective_at, current.event_id)) {
      latestTakedownByAsset.set(event.asset_id, event);
    }
  }

  const validAssets = new Map<string, TrainingExerciseMediaAssetDto>();
  for (const asset of assets) {
    const url = validateDeliveryUrl(asset.delivery_url, new Set(allowedOrigins));
    if (!url || asset.media_kind !== 'IMAGE'
      || !['image/png', 'image/jpeg'].includes(asset.content_type)
      || !/^[0-9a-f]{64}$/.test(asset.integrity_sha256)) continue;
    const provenanceRow = provenanceByAsset.get(asset.asset_id);
    if (!provenanceRow || provenanceRow.publication_allowed !== 1
      || !isTrainingExerciseMediaProvenanceSource(provenanceRow.source_kind)
      || !provenanceRow.license_identifier.trim()
      || !isUnexpired(provenanceRow.rights_expires_at, now)) continue;
    const licenseTermsURL = optionalSafeHttpsUrl(provenanceRow.license_url);
    if (provenanceRow.license_url != null && licenseTermsURL == null) continue;
    if (invalidTakedownAssets.has(asset.asset_id)
      || latestTakedownByAsset.get(asset.asset_id)?.action === 'REMOVE') continue;
    const effectiveReviews = requiredReviewTypes.map((reviewType) => {
      const key = `${asset.asset_id}:${reviewType}`;
      const review = latestReviewByKey.get(key);
      return review?.status === 'APPROVED'
        && !invalidReviewKeys.has(key)
        && review.subject_content_hash === asset.integrity_sha256
        && isUnexpired(review.expires_at, now) ? review : null;
    });
    if (effectiveReviews.some((review) => review == null)) continue;
    const approvedReviews = effectiveReviews as ReviewRow[];
    const reviewedAt = approvedReviews.reduce((latest, review) => (
      Date.parse(review.reviewed_at) > Date.parse(latest) ? review.reviewed_at : latest
    ), approvedReviews[0].reviewed_at);
    const approvalReference = sha256TrainingExerciseMedia(approvedReviews
      .map((review) => ({
        reviewType: review.review_type,
        reviewId: review.review_id,
        status: review.status,
        subjectContentHash: review.subject_content_hash,
        reviewedAt: new Date(review.reviewed_at).toISOString(),
        expiresAt: review.expires_at == null ? null : new Date(review.expires_at).toISOString(),
      }))
      .sort((left, right) => left.reviewType.localeCompare(right.reviewType)));
    const requestedLocalization = mediaLocalizationByKey.get(`${asset.asset_id}:${requestedLocale}`);
    const fallbackLocalization = mediaLocalizationByKey.get(`${asset.asset_id}:en-US`);
    const localization = requestedLocalization ?? fallbackLocalization;
    if (!localization?.accessibility_description.trim()) continue;
    validAssets.set(asset.asset_id, {
      assetId: asset.asset_id,
      exerciseId: asset.exercise_id,
      version: 1,
      viewRole: asset.view_role,
      ordinal: asset.ordinal,
      mediaKind: asset.media_kind,
      contentType: asset.content_type,
      url: url.toString(),
      integritySha256: asset.integrity_sha256,
      widthPixels: asset.width_pixels,
      heightPixels: asset.height_pixels,
      byteSize: asset.byte_size,
      accessibilityDescription: localization.accessibility_description,
      caption: localization.caption,
      locale: localization.locale,
      fallbackFromLocale: localization.locale === requestedLocale ? null : requestedLocale,
      immutableCacheKey: `training-exercise-media:${manifest.manifest_version}:${asset.asset_id}:${asset.integrity_sha256}`,
      governance: {
        publicationState: 'PUBLISHED',
        reviewState: 'APPROVED',
        safetyState: 'APPROVED',
        approvalReference,
        reviewedAt: new Date(reviewedAt).toISOString(),
        licenseIdentifier: provenanceRow.license_identifier,
        licenseTermsURL,
        rightsExpiresAt: provenanceRow.rights_expires_at == null
          ? null : new Date(provenanceRow.rights_expires_at).toISOString(),
        provenanceSource: provenanceRow.source_kind,
      },
    });
  }

  const items: TrainingExerciseMediaItemDto[] = resolved.map((entry) => {
    if (!entry.exercise) return unavailable(entry.requestedExerciseId, entry.unavailableReason);
    const exercise = entry.exercise;
    const requestedInstruction = instructionByKey.get(`${exercise.exercise_id}:${requestedLocale}`);
    const fallbackInstruction = instructionByKey.get(`${exercise.exercise_id}:en-US`);
    const instruction = requestedInstruction ?? fallbackInstruction;
    const requiredViews = parseStringArray(exercise.required_views_json)
      .filter(isTrainingExerciseMediaViewRole);
    const exerciseAssets = assets
      .filter((asset) => asset.exercise_id === exercise.exercise_id)
      .map((asset) => validAssets.get(asset.asset_id))
      .filter((asset): asset is TrainingExerciseMediaAssetDto => asset != null);
    const requiredViewsPresent = requiredViews.length > 0
      && requiredViews.includes('PRIMARY')
      && requiredViews.every((role) => exerciseAssets.some((asset) => asset.viewRole === role));
    const steps = instruction ? parseStringArray(instruction.steps_json) : [];
    if (!instruction || steps.length === 0 || !instruction.text_fallback.trim() || !requiredViewsPresent) {
      return unavailable(entry.requestedExerciseId, 'MEDIA_UNAVAILABLE');
    }
    return {
      kind: 'AVAILABLE',
      requestedExerciseId: entry.requestedExerciseId,
      exerciseId: exercise.exercise_id,
      canonicalName: exercise.canonical_name,
      resolvedBy: entry.resolvedBy,
      instruction: {
        locale: instruction.locale,
        fallbackFromLocale: instruction.locale === requestedLocale ? null : requestedLocale,
        displayName: instruction.display_name,
        steps,
        cues: parseStringArray(instruction.cues_json),
        cautions: parseStringArray(instruction.cautions_json),
        textFallback: instruction.text_fallback,
      },
      requiredViews,
      assets: exerciseAssets,
    } satisfies AvailableTrainingExerciseMediaDto;
  });
  const eTagHash = sha256TrainingExerciseMedia({
    manifestVersion: manifest.manifest_version,
    packageHash: manifest.package_hash,
    requestedLocale,
    requestedExerciseIds,
    items,
  });
  return {
    schemaVersion: TRAINING_EXERCISE_MEDIA_API_SCHEMA_VERSION,
    manifestVersion: manifest.manifest_version,
    catalogVersion: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
    catalogSourceHash: manifest.catalog_source_hash,
    requestedLocale,
    items,
    eTag: `\"${eTagHash}\"`,
  };
}

function findActiveManifest(db: Database.Database, tenantId: number): ManifestRow | null {
  const fields = `
    manifest_id, manifest_version, scope_key, catalog_version,
    catalog_source_hash, package_hash, expected_exercise_count,
    expected_exercise_ids_json, expected_approved_asset_bindings_json,
    validation_attested_package_hash, validation_attestation_hash,
    required_review_types_json, allowed_origins_json
  `;
  const tenantScoped = db.prepare(`
    SELECT ${fields}
      FROM training_exercise_media_manifests
     WHERE scope_key = ? AND publication_state = 'ACTIVE' AND validation_status = 'PASSED'
     LIMIT 1
  `).get(`tenant:${tenantId}`) as ManifestRow | undefined;
  if (tenantScoped) return tenantScoped;
  return (db.prepare(`
    SELECT ${fields}
      FROM training_exercise_media_manifests
     WHERE scope_key = '__global__' AND publication_state = 'ACTIVE' AND validation_status = 'PASSED'
     LIMIT 1
  `).get() as ManifestRow | undefined) ?? null;
}

function queryForIds<T>(
  db: Database.Database,
  sqlTemplate: string,
  prefixParams: readonly unknown[],
  ids: readonly string[],
  suffixParams: readonly unknown[] = [],
): T[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(sqlTemplate.replace('__IDS__', placeholders))
    .all(...prefixParams, ...ids, ...suffixParams) as T[];
}

function unavailable(
  requestedExerciseId: string,
  reason: TrainingExerciseMediaUnavailableReason,
): UnavailableTrainingExerciseMediaDto {
  return {
    kind: 'UNAVAILABLE',
    requestedExerciseId,
    rawIdentifier: requestedExerciseId,
    reason,
    textFallbackRequired: true,
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function parseApprovedAssetBindings(raw: string): TrainingExerciseMediaApprovedAssetBinding[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const bindings: TrainingExerciseMediaApprovedAssetBinding[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.assetId !== 'string' || value.assetId.trim().length === 0
        || typeof value.exerciseId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value.exerciseId)
        || typeof value.viewRole !== 'string' || !isTrainingExerciseMediaViewRole(value.viewRole)
        || !Number.isInteger(value.ordinal) || Number(value.ordinal) < 0
        || typeof value.integritySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.integritySha256)) {
        return [];
      }
      bindings.push({
        assetId: value.assetId,
        exerciseId: value.exerciseId,
        viewRole: value.viewRole,
        ordinal: Number(value.ordinal),
        integritySha256: value.integritySha256,
      });
    }
    if (new Set(bindings.map((binding) => binding.assetId)).size !== bindings.length) return [];
    return bindings.sort((left, right) => left.assetId.localeCompare(right.assetId));
  } catch {
    return [];
  }
}

function safeHttpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

function validateDeliveryUrl(raw: string, allowedOrigins: ReadonlySet<string>): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return allowedOrigins.has(url.origin) ? url : null;
  } catch {
    return null;
  }
}

function isTrainingExerciseMediaViewRole(value: string): value is TrainingExerciseMediaViewRole {
  return ['PRIMARY', 'START', 'END', 'PHASE', 'ALTERNATE'].includes(value);
}

function isUnexpired(value: string | null, now: Date): boolean {
  if (value == null) return true;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function isExactSafeIdentifierSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((value) => /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value))
    && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function isLaterDatedId(leftDate: string, leftId: string, rightDate: string, rightId: string): boolean {
  const byDate = Date.parse(leftDate) - Date.parse(rightDate);
  return byDate > 0 || (byDate === 0 && leftId > rightId);
}

function optionalSafeHttpsUrl(raw: string | null): string | null {
  if (raw == null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function isTrainingExerciseMediaProvenanceSource(
  value: string,
): value is 'GENERATED' | 'LICENSED' | 'OWNED' | 'COMMISSIONED' {
  return ['GENERATED', 'LICENSED', 'OWNED', 'COMMISSIONED'].includes(value);
}
