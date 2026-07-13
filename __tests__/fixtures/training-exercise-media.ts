// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
} from '../../src/services/training-exercise-identity';
import { buildTrainingExerciseMediaValidationAttestationHash } from '../../src/services/training-exercise-media-manifest';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);

export interface SeedApprovedExerciseMediaOptions {
  manifestId?: string;
  manifestVersion?: string;
  scopeKey?: string;
  exerciseId?: string;
  expectedExerciseIds?: string[];
  alias?: string;
  deliveryUrl?: string;
  allowedOrigin?: string;
  rightsExpiresAt?: string | null;
  reviewExpiresAt?: string | null;
  addTakedown?: 'REMOVE' | 'REINSTATE' | null;
  stage?: boolean;
  activate?: boolean;
}

export function seedApprovedExerciseMedia(
  db: Database.Database,
  options: SeedApprovedExerciseMediaOptions = {},
): {
  manifestId: string;
  exerciseId: string;
  assetId: string;
  integritySha256: string;
  expectedExerciseIds: string[];
} {
  const manifestId = options.manifestId ?? 'manifest-global-1';
  const manifestVersion = options.manifestVersion ?? manifestId;
  const scopeKey = options.scopeKey ?? '__global__';
  const exerciseId = options.exerciseId ?? 'push_up';
  const expectedExerciseIds = options.expectedExerciseIds ?? [exerciseId];
  const assetId = `${manifestId}-asset-primary`;
  const deliveryUrl = options.deliveryUrl ?? `https://media.nexushub.test/${HASH_C}.png`;
  const allowedOrigin = options.allowedOrigin ?? 'https://media.nexushub.test';
  const rightsExpiresAt = options.rightsExpiresAt === undefined ? '2030-01-01T00:00:00.000Z' : options.rightsExpiresAt;
  const reviewExpiresAt = options.reviewExpiresAt === undefined ? '2030-01-01T00:00:00.000Z' : options.reviewExpiresAt;
  const activate = options.activate !== false;
  const stage = options.stage !== false || activate;
  const approvedBindings = JSON.stringify([{
    assetId,
    exerciseId,
    viewRole: 'PRIMARY',
    ordinal: 0,
    integritySha256: HASH_C,
  }]);
  const attestationHash = buildTrainingExerciseMediaValidationAttestationHash(
    manifestId, scopeKey, HASH_A, JSON.parse(approvedBindings),
  );

  db.prepare(`
    INSERT INTO training_exercise_media_manifests (
      manifest_id, manifest_version, scope_key, catalog_version,
      catalog_source_hash, package_hash, publication_state, validation_status,
      expected_exercise_count, expected_exercise_ids_json,
      expected_approved_asset_bindings_json,
      required_locales_json, required_review_types_json,
      allowed_origins_json, owner_approval_ref, created_at, activated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    manifestId, manifestVersion, scopeKey, TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
    TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH, HASH_A,
    expectedExerciseIds.length,
    JSON.stringify(expectedExerciseIds),
    approvedBindings,
    JSON.stringify(['en-US']),
    JSON.stringify(['DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER']),
    JSON.stringify([allowedOrigin]),
    `owner-approval:${manifestId}`,
    '2026-07-12T00:00:00.000Z',
    '2026-07-12T00:10:00.000Z',
  );
  db.prepare(`
    INSERT INTO training_exercise_media_exercises (
      manifest_id, scope_key, exercise_id, canonical_name, aliases_json,
      required_views_json, exercise_content_hash, publication_state,
      exclusion_reason, global_exercise_id, equivalence_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, '["PRIMARY"]', ?, 'APPROVED', NULL, ?, ?, ?)
  `).run(
    manifestId, scopeKey, exerciseId, `Fixture ${exerciseId}`,
    JSON.stringify(options.alias ? [options.alias] : []), HASH_B,
    scopeKey === '__global__' ? null : exerciseId,
    scopeKey === '__global__' ? null : HASH_F,
    '2026-07-12T00:01:00.000Z',
  );
  db.prepare(`
    INSERT INTO training_exercise_media_assets (
      asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
      media_kind, content_type, delivery_url, integrity_sha256,
      width_pixels, height_pixels, byte_size, publication_state, created_at
    ) VALUES (?, ?, ?, ?, 'PRIMARY', 0, 'IMAGE', 'image/png', ?, ?, 390, 390, 4096, 'APPROVED', ?)
  `).run(assetId, manifestId, scopeKey, exerciseId, deliveryUrl, HASH_C, '2026-07-12T00:02:00.000Z');
  db.prepare(`
    INSERT INTO training_exercise_instruction_localizations (
      manifest_id, scope_key, exercise_id, locale, display_name, steps_json,
      cues_json, cautions_json, text_fallback, content_hash, created_at
    ) VALUES (?, ?, ?, 'en-US', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    manifestId, scopeKey, exerciseId, `Fixture ${exerciseId}`,
    JSON.stringify(['Set a stable position.', 'Move with control.']),
    JSON.stringify(['Keep a neutral spine.']),
    JSON.stringify(['Stop if the movement is painful.']),
    'Use the complete written instructions when media is unavailable.',
    HASH_D, '2026-07-12T00:03:00.000Z',
  );
  db.prepare(`
    INSERT INTO training_exercise_media_localizations (
      asset_id, manifest_id, scope_key, locale, caption,
      accessibility_description, content_hash, created_at
    ) VALUES (?, ?, ?, 'en-US', ?, ?, ?, ?)
  `).run(
    assetId, manifestId, scopeKey, 'Primary movement position',
    'Person demonstrating the approved primary position with anatomically consistent alignment.',
    HASH_E, '2026-07-12T00:04:00.000Z',
  );
  db.prepare(`
    INSERT INTO training_exercise_media_provenance (
      asset_id, manifest_id, scope_key, source_kind, source_reference,
      generator_model, prompt_hash, generated_or_acquired_at,
      license_identifier, license_url, rights_holder_ref, rights_expires_at,
      territories_json, transformations_json, provenance_hash,
      publication_allowed, created_at
    ) VALUES (?, ?, ?, 'GENERATED', ?, 'fixture-model', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    assetId, manifestId, scopeKey, `fixture:${assetId}`, HASH_A,
    '2026-07-12T00:00:00.000Z', 'fixture-owned-license-v1',
    'https://nexushub.test/licenses/fixture', 'fixture-rights-owner', rightsExpiresAt,
    JSON.stringify(['worldwide']), JSON.stringify([]), HASH_F,
    '2026-07-12T00:05:00.000Z',
  );
  const insertReview = db.prepare(`
    INSERT INTO training_exercise_media_reviews (
      review_id, manifest_id, scope_key, asset_id, review_type, status,
      reviewer_ref, subject_content_hash, reason_codes_json,
      reviewed_at, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?, '[]', ?, ?, ?)
  `);
  for (const [index, reviewType] of ['DOMAIN', 'LEGAL', 'ACCESSIBILITY', 'OWNER'].entries()) {
    const at = `2026-07-12T00:0${6 + index}:00.000Z`;
    insertReview.run(
      `${manifestId}-review-${reviewType}`, manifestId, scopeKey, assetId,
      reviewType, `reviewer:${reviewType.toLowerCase()}`, HASH_C,
      at, reviewExpiresAt, at,
    );
  }
  const insertTakedown = () => {
    if (!options.addTakedown) return;
    db.prepare(`
      INSERT INTO training_exercise_media_takedown_events (
        event_id, manifest_id, scope_key, asset_id, action, reason_code,
        authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'FIXTURE_REVIEW', 'fixture-authority', NULL, ?, ?, ?)
    `).run(
      `${manifestId}-takedown-${options.addTakedown}`,
      manifestId, scopeKey, assetId, options.addTakedown, HASH_A,
      '2026-07-12T01:00:00.000Z', '2026-07-12T01:00:00.000Z',
    );
  };
  if (stage) {
    db.prepare(`
      UPDATE training_exercise_media_manifests
         SET publication_state = 'STAGED', validation_status = 'PASSED',
             validation_attested_package_hash = ?, validation_attestation_hash = ?,
             validation_attested_at = '2026-07-12T00:10:00.000Z'
       WHERE manifest_id = ?
    `).run(HASH_A, attestationHash, manifestId);
  }
  if (!activate) insertTakedown();
  if (activate) {
    db.prepare(`
      UPDATE training_exercise_media_manifests
         SET publication_state = 'ACTIVE'
       WHERE manifest_id = ?
    `).run(manifestId);
    insertTakedown();
  }
  return { manifestId, exerciseId, assetId, integritySha256: HASH_C, expectedExerciseIds };
}
