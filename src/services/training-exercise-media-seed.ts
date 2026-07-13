// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import {
  TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION,
  assertCompiledTrainingExerciseMediaPackage,
  buildTrainingExerciseMediaApprovedAssetBindings,
  buildTrainingExerciseMediaAccessibilityBundleHash,
  buildTrainingExerciseMediaValidationAttestationHash,
  computeTrainingExerciseMediaFrozenPackageHash,
  validateCompiledTrainingExerciseMediaPackage,
  type CompiledTrainingExerciseMediaPackage,
  type TrainingExerciseMediaApprovedAssetBinding,
  type TrainingExerciseMediaPackageSources,
  type TrainingExerciseMediaViewRole,
} from './training-exercise-media-manifest';

export interface TrainingExerciseMediaSeedResult {
  manifestId: string;
  packageHash: string;
  publicationState: string;
  inserted: boolean;
  staged: boolean;
  activated: boolean;
  validationAttestationHash: string | null;
}

/**
 * Inserts one immutable, Git-reviewed metadata package. This operator helper
 * does not download or persist binary media. Retries with the same manifest ID
 * and package hash are idempotent; reusing an ID for different content fails.
 */
export function seedCompiledTrainingExerciseMediaPackage(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
  options: { activate?: boolean; now?: Date } = {},
): TrainingExerciseMediaSeedResult {
  const activate = options.activate === true;
  const shouldStage = compiled.manifest.publicationState !== 'DRAFT';
  assertCompiledTrainingExerciseMediaPackage(compiled, {
    now: options.now,
    requireActivation: activate,
  });
  if (activate && compiled.manifest.publicationState !== 'ACTIVE') {
    throw new Error('Only a package explicitly authored as ACTIVE may be activated.');
  }
  if (!['DRAFT', 'STAGED', 'ACTIVE'].includes(compiled.manifest.publicationState)) {
    throw new Error('A new media package must be authored as DRAFT, STAGED, or ACTIVE.');
  }
  if (shouldStage && compiled.manifest.validationStatus !== 'PASSED') {
    throw new Error('A reviewed media package must be validation-passed before staging.');
  }
  if (shouldStage) {
    const stagingValidation = validateCompiledTrainingExerciseMediaPackage(compiled, {
      now: options.now,
    });
    const stagingBlockers = stagingValidation.activationBlockers.filter((blocker) => ![
      'Manifest publication state is not ACTIVE.',
      'Manifest has no activation timestamp.',
    ].includes(blocker));
    if (!stagingValidation.structurallyValid || stagingBlockers.length > 0) {
      throw new Error(`Exercise media package is not staging-ready: ${[
        ...stagingValidation.errors,
        ...stagingBlockers,
      ].join(' ')}`);
    }
  }
  const expectedApprovedAssetBindings = buildTrainingExerciseMediaApprovedAssetBindings(compiled.assets);

  const existing = db.prepare(`
    SELECT package_hash, publication_state, validation_attestation_hash
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(compiled.manifest.manifestId) as {
    package_hash: string;
    publication_state: string;
    validation_attestation_hash: string | null;
  } | undefined;
  if (existing) {
    if (existing.package_hash !== compiled.packageHash) {
      throw new Error('Manifest ID already exists with a different immutable package hash.');
    }
    const result = db.transaction(() => {
      updateDraftApprovalReferences(db, compiled);
      insertAppendOnlyGovernanceRows(db, compiled);
      assertStoredTrainingExerciseMediaPackageMatches(db, compiled);
      if (shouldStage && existing.publication_state === 'DRAFT') {
        attestAndStageTrainingExerciseMediaPackage(
          db, compiled, expectedApprovedAssetBindings, options.now,
        );
      }
      if (activate) activateStagedTrainingExerciseMediaPackage(db, compiled.manifest.manifestId);
      return readSeedResult(db, compiled, false);
    })();
    return result;
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO training_exercise_media_manifests (
        manifest_id, manifest_version, scope_key, catalog_version,
        catalog_source_hash, package_hash, publication_state, validation_status,
        expected_exercise_count, expected_exercise_ids_json,
        expected_approved_asset_bindings_json, required_locales_json,
        required_review_types_json, allowed_origins_json, approved_host_ref,
        owner_approval_ref,
        created_at, activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      compiled.manifest.manifestId,
      compiled.manifest.manifestVersion,
      compiled.manifest.scopeKey,
      compiled.manifest.catalogVersion,
      compiled.manifest.catalogSourceHash,
      compiled.packageHash,
      compiled.manifest.expectedExerciseCount,
      JSON.stringify(compiled.manifest.expectedExerciseIds),
      JSON.stringify(expectedApprovedAssetBindings),
      JSON.stringify(compiled.manifest.requiredLocales),
      JSON.stringify(compiled.manifest.requiredReviewTypes),
      JSON.stringify(compiled.manifest.allowedOrigins),
      compiled.manifest.approvedHostRef,
      compiled.manifest.ownerApprovalRef,
      compiled.manifest.createdAt,
      compiled.manifest.activatedAt,
    );

    const insertExercise = db.prepare(`
      INSERT INTO training_exercise_media_exercises (
        manifest_id, scope_key, exercise_id, canonical_name, aliases_json,
        required_views_json, exercise_content_hash, publication_state,
        exclusion_reason, global_exercise_id, equivalence_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const exercise of compiled.exercises) {
      insertExercise.run(
        compiled.manifest.manifestId, compiled.manifest.scopeKey,
        exercise.exerciseId, exercise.canonicalName, JSON.stringify(exercise.aliases),
        JSON.stringify(exercise.requiredViews), exercise.exerciseContentHash,
        exercise.publicationState, exercise.exclusionReason, exercise.globalExerciseId,
        exercise.equivalenceHash, exercise.createdAt,
      );
    }

    const insertAsset = db.prepare(`
      INSERT INTO training_exercise_media_assets (
        asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
        media_kind, content_type, delivery_url, integrity_sha256,
        width_pixels, height_pixels, byte_size, accessibility_bundle_hash,
        publication_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const asset of compiled.assets) {
      insertAsset.run(
        asset.assetId, compiled.manifest.manifestId, compiled.manifest.scopeKey,
        asset.exerciseId, asset.viewRole, asset.ordinal, asset.mediaKind,
        asset.contentType, asset.deliveryUrl, asset.integritySha256,
        asset.widthPixels, asset.heightPixels, asset.byteSize,
        buildTrainingExerciseMediaAccessibilityBundleHash(asset.assetId, compiled.mediaLocalizations),
        asset.publicationState, asset.createdAt,
      );
    }

    const insertInstruction = db.prepare(`
      INSERT INTO training_exercise_instruction_localizations (
        manifest_id, scope_key, exercise_id, locale, display_name, steps_json,
        cues_json, cautions_json, text_fallback, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const instruction of compiled.instructions) {
      insertInstruction.run(
        compiled.manifest.manifestId, compiled.manifest.scopeKey,
        instruction.exerciseId, instruction.locale, instruction.displayName,
        JSON.stringify(instruction.steps), JSON.stringify(instruction.cues),
        JSON.stringify(instruction.cautions), instruction.textFallback,
        instruction.contentHash, instruction.createdAt,
      );
    }

    const insertMediaLocalization = db.prepare(`
      INSERT INTO training_exercise_media_localizations (
        asset_id, manifest_id, scope_key, locale, caption,
        accessibility_description, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const localization of compiled.mediaLocalizations) {
      insertMediaLocalization.run(
        localization.assetId, compiled.manifest.manifestId, compiled.manifest.scopeKey,
        localization.locale, localization.caption,
        localization.accessibilityDescription, localization.contentHash,
        localization.createdAt,
      );
    }

    const insertProvenance = db.prepare(`
      INSERT INTO training_exercise_media_provenance (
        asset_id, manifest_id, scope_key, source_kind, source_reference,
        generator_model, prompt_hash, generated_or_acquired_at,
        license_identifier, license_url, rights_holder_ref, rights_expires_at,
        territories_json, transformations_json, provenance_hash,
        publication_allowed, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const provenance of compiled.provenance) {
      insertProvenance.run(
        provenance.assetId, compiled.manifest.manifestId, compiled.manifest.scopeKey,
        provenance.sourceKind, provenance.sourceReference, provenance.generatorModel,
        provenance.promptHash, provenance.generatedOrAcquiredAt,
        provenance.licenseIdentifier, provenance.licenseUrl,
        provenance.rightsHolderRef, provenance.rightsExpiresAt,
        JSON.stringify(provenance.territories), JSON.stringify(provenance.transformations),
        provenance.provenanceHash, provenance.publicationAllowed ? 1 : 0,
        provenance.createdAt,
      );
    }

    insertAppendOnlyGovernanceRows(db, compiled);

    assertStoredTrainingExerciseMediaPackageMatches(db, compiled);
    if (shouldStage) {
      attestAndStageTrainingExerciseMediaPackage(
        db, compiled, expectedApprovedAssetBindings, options.now,
      );
    }
    if (activate) activateStagedTrainingExerciseMediaPackage(db, compiled.manifest.manifestId);
  })();

  return readSeedResult(db, compiled, true);
}

export function computeStoredTrainingExerciseMediaFrozenPackageHash(
  db: Database.Database,
  manifestId: string,
): string {
  return computeTrainingExerciseMediaFrozenPackageHash(readStoredPackageSources(db, manifestId));
}

function updateDraftApprovalReferences(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
): void {
  const current = db.prepare(`
    SELECT approved_host_ref, owner_approval_ref
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(compiled.manifest.manifestId) as {
    approved_host_ref: string | null;
    owner_approval_ref: string | null;
  } | undefined;
  if (!current
    || (current.approved_host_ref != null
      && current.approved_host_ref !== compiled.manifest.approvedHostRef)
    || (current.owner_approval_ref != null
      && current.owner_approval_ref !== compiled.manifest.ownerApprovalRef)) {
    throw new Error('Stored exercise media approvals cannot be replaced or erased by catalog synchronization.');
  }
  db.prepare(`
    UPDATE training_exercise_media_manifests
       SET approved_host_ref = COALESCE(approved_host_ref, ?),
           owner_approval_ref = COALESCE(owner_approval_ref, ?)
     WHERE manifest_id = ? AND publication_state = 'DRAFT'
  `).run(
    compiled.manifest.approvedHostRef,
    compiled.manifest.ownerApprovalRef,
    compiled.manifest.manifestId,
  );
  const row = db.prepare(`
    SELECT approved_host_ref, owner_approval_ref
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(compiled.manifest.manifestId) as {
    approved_host_ref: string | null;
    owner_approval_ref: string | null;
  } | undefined;
  if (!row || row.approved_host_ref !== compiled.manifest.approvedHostRef
    || row.owner_approval_ref !== compiled.manifest.ownerApprovalRef) {
    throw new Error('Stored exercise media approval references do not match the durable approval ledger.');
  }
}

function insertAppendOnlyGovernanceRows(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
): void {
  const manifestId = compiled.manifest.manifestId;
  const scopeKey = compiled.manifest.scopeKey;
  const insertReview = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_media_reviews (
      review_id, manifest_id, scope_key, asset_id, review_type, status,
      reviewer_ref, subject_content_hash, reason_codes_json,
      reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const review of compiled.reviews) {
    const expected = {
      manifest_id: manifestId,
      scope_key: scopeKey,
      asset_id: review.assetId,
      review_type: review.reviewType,
      status: review.status,
      reviewer_ref: review.reviewerRef,
      subject_content_hash: review.subjectContentHash,
      reason_codes_json: JSON.stringify(review.reasonCodes),
      reviewed_at: review.reviewedAt,
      expires_at: review.expiresAt,
      created_at: review.createdAt,
    };
    insertReview.run(review.reviewId, ...Object.values(expected));
    assertAppendOnlyRow(db, 'training_exercise_media_reviews', 'review_id', review.reviewId, expected);
  }

  const insertInstructionReview = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_instruction_localization_reviews (
      review_id, manifest_id, scope_key, exercise_id, locale, status,
      reviewer_ref, subject_content_hash, reason_codes_json,
      reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMediaReview = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_media_localization_reviews (
      review_id, manifest_id, scope_key, asset_id, locale, status,
      reviewer_ref, subject_content_hash, reason_codes_json,
      reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const review of compiled.localizationReviews) {
    const idColumn = review.targetKind === 'INSTRUCTION' ? 'exercise_id' : 'asset_id';
    const table = review.targetKind === 'INSTRUCTION'
      ? 'training_exercise_instruction_localization_reviews'
      : 'training_exercise_media_localization_reviews';
    const expected = {
      manifest_id: manifestId,
      scope_key: scopeKey,
      [idColumn]: review.targetId,
      locale: review.locale,
      status: review.status,
      reviewer_ref: review.reviewerRef,
      subject_content_hash: review.subjectContentHash,
      reason_codes_json: JSON.stringify(review.reasonCodes),
      reviewed_at: review.reviewedAt,
      expires_at: review.expiresAt,
      created_at: review.createdAt,
    };
    const statement = review.targetKind === 'INSTRUCTION' ? insertInstructionReview : insertMediaReview;
    statement.run(review.reviewId, ...Object.values(expected));
    assertAppendOnlyRow(db, table, 'review_id', review.reviewId, expected);
  }

  const insertHostApproval = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_media_host_approvals (
      approval_id, manifest_id, scope_key, status, reviewer_ref,
      subject_origins_json, subject_origins_hash, reason_codes_json,
      reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const approval of compiled.hostApprovals) {
    const expected = {
      manifest_id: manifestId,
      scope_key: scopeKey,
      status: approval.status,
      reviewer_ref: approval.reviewerRef,
      subject_origins_json: JSON.stringify(approval.subjectOrigins),
      subject_origins_hash: approval.subjectOriginsHash,
      reason_codes_json: JSON.stringify(approval.reasonCodes),
      reviewed_at: approval.reviewedAt,
      expires_at: approval.expiresAt,
      created_at: approval.createdAt,
    };
    insertHostApproval.run(approval.approvalId, ...Object.values(expected));
    assertAppendOnlyRow(db, 'training_exercise_media_host_approvals', 'approval_id', approval.approvalId, expected);
  }

  const insertOwnerApproval = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_media_owner_approvals (
      approval_id, manifest_id, scope_key, status, reviewer_ref,
      subject_package_hash, reason_codes_json, reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const approval of compiled.ownerApprovals) {
    const expected = {
      manifest_id: manifestId,
      scope_key: scopeKey,
      status: approval.status,
      reviewer_ref: approval.reviewerRef,
      subject_package_hash: approval.subjectPackageHash,
      reason_codes_json: JSON.stringify(approval.reasonCodes),
      reviewed_at: approval.reviewedAt,
      expires_at: approval.expiresAt,
      created_at: approval.createdAt,
    };
    insertOwnerApproval.run(approval.approvalId, ...Object.values(expected));
    assertAppendOnlyRow(db, 'training_exercise_media_owner_approvals', 'approval_id', approval.approvalId, expected);
  }

  const insertTakedown = db.prepare(`
    INSERT OR IGNORE INTO training_exercise_media_takedown_events (
      event_id, manifest_id, scope_key, asset_id, action, reason_code,
      authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of compiled.takedowns) {
    const expected = {
      manifest_id: manifestId,
      scope_key: scopeKey,
      asset_id: event.assetId,
      action: event.action,
      reason_code: event.reasonCode,
      authority_ref: event.authorityRef,
      replacement_asset_id: event.replacementAssetId,
      evidence_hash: event.evidenceHash,
      effective_at: event.effectiveAt,
      created_at: event.createdAt,
    };
    insertTakedown.run(event.eventId, ...Object.values(expected));
    assertAppendOnlyRow(db, 'training_exercise_media_takedown_events', 'event_id', event.eventId, expected);
  }
}

function assertAppendOnlyRow(
  db: Database.Database,
  table: string,
  idColumn: string,
  id: string,
  expected: Record<string, unknown>,
): void {
  const columns = Object.keys(expected);
  const row = db.prepare(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${idColumn} = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row || columns.some((column) => row[column] !== expected[column])) {
    throw new Error(`Append-only exercise media governance ID collision: ${id}`);
  }
}

function assertStoredTrainingExerciseMediaPackageMatches(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
): void {
  const storedHash = computeStoredTrainingExerciseMediaFrozenPackageHash(
    db, compiled.manifest.manifestId,
  );
  if (storedHash !== compiled.packageHash) {
    throw new Error('Stored exercise media rows do not match the immutable reviewed package hash.');
  }
  const row = db.prepare(`
    SELECT package_hash, expected_approved_asset_bindings_json
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(compiled.manifest.manifestId) as {
    package_hash: string;
    expected_approved_asset_bindings_json: string;
  } | undefined;
  const expectedBindings = buildTrainingExerciseMediaApprovedAssetBindings(compiled.assets);
  if (!row || row.package_hash !== compiled.packageHash
    || JSON.stringify(parseApprovedAssetBindings(row.expected_approved_asset_bindings_json))
      !== JSON.stringify(expectedBindings)) {
    throw new Error('Stored exercise media asset bindings do not match the reviewed package.');
  }
}

function attestAndStageTrainingExerciseMediaPackage(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
  expectedApprovedAssetBindings: readonly TrainingExerciseMediaApprovedAssetBinding[],
  now?: Date,
): void {
  assertStoredTrainingExerciseMediaPackageMatches(db, compiled);
  const attestationHash = buildTrainingExerciseMediaValidationAttestationHash(
    compiled.manifest.manifestId,
    compiled.manifest.scopeKey,
    compiled.packageHash,
    expectedApprovedAssetBindings,
  );
  const result = db.prepare(`
    UPDATE training_exercise_media_manifests
       SET publication_state = 'STAGED',
           validation_status = 'PASSED',
           validation_attested_package_hash = ?,
           validation_attestation_hash = ?,
           validation_attested_at = ?
     WHERE manifest_id = ? AND publication_state = 'DRAFT'
  `).run(
    compiled.packageHash,
    attestationHash,
    (now ?? new Date()).toISOString(),
    compiled.manifest.manifestId,
  );
  if (result.changes !== 1) {
    throw new Error('Exercise media package could not transition from DRAFT to STAGED.');
  }
}

function activateStagedTrainingExerciseMediaPackage(
  db: Database.Database,
  manifestId: string,
): void {
  const result = db.prepare(`
    UPDATE training_exercise_media_manifests
       SET publication_state = 'ACTIVE'
     WHERE manifest_id = ? AND publication_state = 'STAGED'
  `).run(manifestId);
  if (result.changes === 1) return;
  const row = db.prepare(`
    SELECT publication_state FROM training_exercise_media_manifests WHERE manifest_id = ?
  `).get(manifestId) as { publication_state: string } | undefined;
  if (row?.publication_state !== 'ACTIVE') {
    throw new Error('Only an attested STAGED media package may be activated.');
  }
}

function readSeedResult(
  db: Database.Database,
  compiled: CompiledTrainingExerciseMediaPackage,
  inserted: boolean,
): TrainingExerciseMediaSeedResult {
  const row = db.prepare(`
    SELECT publication_state, validation_attestation_hash
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(compiled.manifest.manifestId) as {
    publication_state: string;
    validation_attestation_hash: string | null;
  } | undefined;
  if (!row) throw new Error('Seeded exercise media manifest is missing.');
  return {
    manifestId: compiled.manifest.manifestId,
    packageHash: compiled.packageHash,
    publicationState: row.publication_state,
    inserted,
    staged: row.publication_state === 'STAGED' || row.publication_state === 'ACTIVE',
    activated: row.publication_state === 'ACTIVE',
    validationAttestationHash: row.validation_attestation_hash,
  };
}

function readStoredPackageSources(
  db: Database.Database,
  manifestId: string,
): TrainingExerciseMediaPackageSources {
  const manifest = db.prepare(`
    SELECT manifest_id, manifest_version, scope_key, catalog_version,
           catalog_source_hash, publication_state, validation_status,
           expected_exercise_count, expected_exercise_ids_json,
           required_locales_json, required_review_types_json,
           allowed_origins_json, approved_host_ref, owner_approval_ref,
           created_at, activated_at
      FROM training_exercise_media_manifests
     WHERE manifest_id = ?
  `).get(manifestId) as Record<string, unknown> | undefined;
  if (!manifest) throw new Error('Stored exercise media manifest is missing.');
  const scopeKey = String(manifest.scope_key);
  const rows = <T extends Record<string, unknown>>(sql: string): T[] => (
    db.prepare(sql).all(manifestId, scopeKey) as T[]
  );
  const exercises = rows<Record<string, unknown>>(`
    SELECT exercise_id, canonical_name, aliases_json, required_views_json,
           exercise_content_hash, publication_state, exclusion_reason,
           global_exercise_id, equivalence_hash, created_at
      FROM training_exercise_media_exercises
     WHERE manifest_id = ? AND scope_key = ?
  `).map((row) => ({
    exerciseId: String(row.exercise_id),
    canonicalName: String(row.canonical_name),
    aliases: parseStringArray(String(row.aliases_json)),
    requiredViews: parseStringArray(String(row.required_views_json)) as TrainingExerciseMediaViewRole[],
    exerciseContentHash: String(row.exercise_content_hash),
    publicationState: row.publication_state as TrainingExerciseMediaPackageSources['exercises'][number]['publicationState'],
    exclusionReason: nullableString(row.exclusion_reason),
    globalExerciseId: nullableString(row.global_exercise_id),
    equivalenceHash: nullableString(row.equivalence_hash),
    createdAt: String(row.created_at),
  }));
  const assets = rows<Record<string, unknown>>(`
    SELECT asset_id, exercise_id, view_role, ordinal, media_kind, content_type,
           delivery_url, integrity_sha256, width_pixels, height_pixels,
           byte_size, publication_state, created_at
      FROM training_exercise_media_assets
     WHERE manifest_id = ? AND scope_key = ?
  `).map((row) => ({
    assetId: String(row.asset_id),
    exerciseId: String(row.exercise_id),
    viewRole: row.view_role as TrainingExerciseMediaViewRole,
    ordinal: Number(row.ordinal),
    mediaKind: row.media_kind as 'IMAGE',
    contentType: String(row.content_type),
    deliveryUrl: String(row.delivery_url),
    integritySha256: String(row.integrity_sha256),
    widthPixels: Number(row.width_pixels),
    heightPixels: Number(row.height_pixels),
    byteSize: Number(row.byte_size),
    publicationState: row.publication_state as TrainingExerciseMediaPackageSources['assets'][number]['publicationState'],
    createdAt: String(row.created_at),
  }));
  const instructions = rows<Record<string, unknown>>(`
    SELECT exercise_id, locale, display_name, steps_json, cues_json,
           cautions_json, text_fallback, content_hash, created_at
      FROM training_exercise_instruction_localizations
     WHERE manifest_id = ? AND scope_key = ?
  `).map((row) => ({
    exerciseId: String(row.exercise_id),
    locale: row.locale as TrainingExerciseMediaPackageSources['instructions'][number]['locale'],
    displayName: String(row.display_name),
    steps: parseStringArray(String(row.steps_json)),
    cues: parseStringArray(String(row.cues_json)),
    cautions: parseStringArray(String(row.cautions_json)),
    textFallback: String(row.text_fallback),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  }));
  const mediaLocalizations = rows<Record<string, unknown>>(`
    SELECT asset_id, locale, caption, accessibility_description,
           content_hash, created_at
      FROM training_exercise_media_localizations
     WHERE manifest_id = ? AND scope_key = ?
  `).map((row) => ({
    assetId: String(row.asset_id),
    locale: row.locale as TrainingExerciseMediaPackageSources['mediaLocalizations'][number]['locale'],
    caption: nullableString(row.caption),
    accessibilityDescription: String(row.accessibility_description),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
  }));
  const provenance = rows<Record<string, unknown>>(`
    SELECT asset_id, source_kind, source_reference, generator_model, prompt_hash,
           generated_or_acquired_at, license_identifier, license_url,
           rights_holder_ref, rights_expires_at, territories_json,
           transformations_json, provenance_hash, publication_allowed, created_at
      FROM training_exercise_media_provenance
     WHERE manifest_id = ? AND scope_key = ?
  `).map((row) => ({
    assetId: String(row.asset_id),
    sourceKind: row.source_kind as TrainingExerciseMediaPackageSources['provenance'][number]['sourceKind'],
    sourceReference: String(row.source_reference),
    generatorModel: nullableString(row.generator_model),
    promptHash: nullableString(row.prompt_hash),
    generatedOrAcquiredAt: String(row.generated_or_acquired_at),
    licenseIdentifier: String(row.license_identifier),
    licenseUrl: nullableString(row.license_url),
    rightsHolderRef: String(row.rights_holder_ref),
    rightsExpiresAt: nullableString(row.rights_expires_at),
    territories: parseStringArray(String(row.territories_json)),
    transformations: parseStringArray(String(row.transformations_json)),
    provenanceHash: String(row.provenance_hash),
    publicationAllowed: Number(row.publication_allowed) === 1,
    createdAt: String(row.created_at),
  }));
  return {
    manifest: {
      schemaVersion: TRAINING_EXERCISE_MEDIA_PACKAGE_SCHEMA_VERSION,
      manifestId: String(manifest.manifest_id),
      manifestVersion: String(manifest.manifest_version),
      scopeKey,
      catalogVersion: manifest.catalog_version as TrainingExerciseMediaPackageSources['manifest']['catalogVersion'],
      catalogSourceHash: String(manifest.catalog_source_hash),
      publicationState: manifest.publication_state as TrainingExerciseMediaPackageSources['manifest']['publicationState'],
      validationStatus: manifest.validation_status as TrainingExerciseMediaPackageSources['manifest']['validationStatus'],
      expectedExerciseCount: Number(manifest.expected_exercise_count),
      expectedExerciseIds: parseStringArray(String(manifest.expected_exercise_ids_json)),
      requiredLocales: parseStringArray(String(manifest.required_locales_json)) as TrainingExerciseMediaPackageSources['manifest']['requiredLocales'],
      requiredReviewTypes: parseStringArray(String(manifest.required_review_types_json)) as TrainingExerciseMediaPackageSources['manifest']['requiredReviewTypes'],
      allowedOrigins: parseStringArray(String(manifest.allowed_origins_json)),
      approvedHostRef: nullableString(manifest.approved_host_ref),
      ownerApprovalRef: nullableString(manifest.owner_approval_ref),
      createdAt: String(manifest.created_at),
      activatedAt: nullableString(manifest.activated_at),
    },
    exercises,
    assets,
    instructions,
    mediaLocalizations,
    provenance,
    reviews: [],
    localizationReviews: [],
    hostApprovals: [],
    ownerApprovals: [],
    takedowns: [],
  };
}

function parseApprovedAssetBindings(raw: string): TrainingExerciseMediaApprovedAssetBinding[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => entry as TrainingExerciseMediaApprovedAssetBinding)
      .sort((left, right) => left.assetId.localeCompare(right.assetId));
  } catch {
    return [];
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed : [];
  } catch {
    return [];
  }
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
