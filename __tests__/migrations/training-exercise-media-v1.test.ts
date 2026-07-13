// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrationFileForTest, runMigrationsForTest } from '../../src/services/database';
import { seedApprovedExerciseMedia } from '../fixtures/training-exercise-media';

const TABLES = [
  'training_exercise_media_manifests',
  'training_exercise_media_exercises',
  'training_exercise_media_assets',
  'training_exercise_media_provenance',
  'training_exercise_instruction_localizations',
  'training_exercise_media_localizations',
  'training_exercise_media_reviews',
  'training_exercise_instruction_localization_reviews',
  'training_exercise_media_localization_reviews',
  'training_exercise_media_host_approvals',
  'training_exercise_media_owner_approvals',
  'training_exercise_media_takedown_events',
];

describe('migration 229 — Training exercise media v1', () => {
  it('applies additively through the production migration runner', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('229_training_exercise_media_v1.sql'))
        .toEqual({ filename: '229_training_exercise_media_v1.sql' });
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'training_exercise%'
      `).all() as Array<{ name: string }>;
      expect(tables.map((entry) => entry.name)).toEqual(expect.arrayContaining(TABLES));
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('applies after the production-head schema and replays idempotently', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db, { excludeFiles: ['229_training_exercise_media_v1.sql'] });
      expect(() => applyMigrationFileForTest(db, '229_training_exercise_media_v1.sql')).not.toThrow();
      expect(() => applyMigrationFileForTest(db, '229_training_exercise_media_v1.sql')).not.toThrow();
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM _migrations
         WHERE filename = '229_training_exercise_media_v1.sql'
      `).get()).toEqual({ count: 1 });
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('requires seeding before activation and fails closed on incomplete coverage', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const hash = 'a'.repeat(64);
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_manifests (
          manifest_id, manifest_version, scope_key, catalog_version,
          catalog_source_hash, package_hash, publication_state, validation_status,
          expected_exercise_count, expected_exercise_ids_json,
          expected_approved_asset_bindings_json,
          required_locales_json, required_review_types_json,
          allowed_origins_json, owner_approval_ref, created_at, activated_at
        ) VALUES (
          'direct-active', 'direct-active', '__global__', 'training-exercise-identity-catalog.v1',
          ?, ?, 'ACTIVE', 'PASSED', 1, '["push_up"]', '[]', '["en-US"]',
          '["DOMAIN","LEGAL","ACCESSIBILITY","OWNER"]',
          '["https://media.nexushub.test"]', 'owner-approval',
          '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
        )
      `).run(hash, hash)).toThrow(/unattested drafts/i);

      db.prepare(`
        INSERT INTO training_exercise_media_manifests (
          manifest_id, manifest_version, scope_key, catalog_version,
          catalog_source_hash, package_hash, publication_state, validation_status,
          expected_exercise_count, expected_exercise_ids_json,
          expected_approved_asset_bindings_json,
          required_locales_json, required_review_types_json,
          allowed_origins_json, owner_approval_ref, created_at, activated_at
        ) VALUES (
          'incomplete', 'incomplete', '__global__', 'training-exercise-identity-catalog.v1',
          ?, ?, 'DRAFT', 'PENDING', 1, '["push_up"]', '[]', '["en-US"]',
          '["DOMAIN","LEGAL","ACCESSIBILITY","OWNER"]',
          '["https://media.nexushub.test"]', 'owner-approval',
          '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
        )
      `).run(hash, hash);
      db.prepare(`
        UPDATE training_exercise_media_manifests
           SET publication_state = 'STAGED', validation_status = 'PASSED',
               validation_attested_package_hash = ?, validation_attestation_hash = ?,
               validation_attested_at = '2026-07-12T00:00:00.000Z'
         WHERE manifest_id = 'incomplete'
      `).run(hash, hash);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests SET publication_state = 'ACTIVE'
         WHERE manifest_id = 'incomplete'
      `).run()).toThrow(/identity set is incomplete|coverage is incomplete/i);
    } finally {
      db.close();
    }
  });

  it('keeps activated metadata immutable while accepting append-only takedowns', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const fixture = seedApprovedExerciseMedia(db);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_assets SET delivery_url = 'https://evil.test/replaced.png'
         WHERE asset_id = ?
      `).run(fixture.assetId)).toThrow(/immutable/i);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_reviews SET status = 'REJECTED'
         WHERE review_id = 'manifest-global-1-review-DOMAIN'
      `).run()).toThrow(/append-only/i);
      expect(() => db.prepare(`
        UPDATE training_exercise_instruction_localization_reviews SET status = 'REJECTED'
         WHERE review_id = 'manifest-global-1-instruction-localization-review'
      `).run()).toThrow(/append-only/i);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_host_approvals SET status = 'REJECTED'
         WHERE approval_id = 'host-approval:manifest-global-1'
      `).run()).toThrow(/append-only/i);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_owner_approvals SET status = 'REJECTED'
         WHERE approval_id = 'owner-approval:manifest-global-1'
      `).run()).toThrow(/append-only/i);
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, evidence_hash, effective_at, created_at
        ) VALUES ('remove-1', ?, '__global__', ?, 'REMOVE', 'ANATOMY_REVIEW',
          'domain-review', ?, '2026-07-12T02:00:00.000Z', '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.assetId, 'f'.repeat(64))).not.toThrow();
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('freezes content inserts from STAGED while reviews and takedowns remain append-only', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const fixture = seedApprovedExerciseMedia(db, { activate: false, stage: false });
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES ('unsupported-webp', ?, '__global__', ?, 'ALTERNATE', 2,
          'IMAGE', 'image/webp', 'https://media.nexushub.test/unsupported.webp', ?,
          390, 390, 4096, 'DRAFT', '2026-07-12T00:08:00.000Z')
      `).run(fixture.manifestId, fixture.exerciseId, 'b'.repeat(64))).toThrow(/CHECK constraint failed/i);
      db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES ('draft-extra', ?, '__global__', ?, 'ALTERNATE', 1,
          'IMAGE', 'image/png', 'https://media.nexushub.test/draft-extra.png', ?,
          390, 390, 4096, 'DRAFT', '2026-07-12T00:09:00.000Z')
      `).run(fixture.manifestId, fixture.exerciseId, 'b'.repeat(64));
      db.prepare(`
        UPDATE training_exercise_media_manifests
           SET publication_state = 'STAGED', validation_status = 'PASSED',
               validation_attested_package_hash = ?, validation_attestation_hash = ?,
               validation_attested_at = '2026-07-12T00:10:00.000Z'
         WHERE manifest_id = ?
      `).run('a'.repeat(64), 'f'.repeat(64), fixture.manifestId);
      db.prepare(`
        UPDATE training_exercise_media_manifests SET publication_state = 'ACTIVE'
         WHERE manifest_id = ?
      `).run(fixture.manifestId);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_exercises (
          manifest_id, scope_key, exercise_id, canonical_name, aliases_json,
          required_views_json, exercise_content_hash, publication_state,
          exclusion_reason, global_exercise_id, equivalence_hash, created_at
        ) VALUES (?, '__global__', 'post_activation_exercise', 'Post activation', '[]',
          '["PRIMARY"]', ?, 'APPROVED', NULL, NULL, NULL, '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, 'a'.repeat(64))).toThrow(/content is frozen/i);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES ('post-activation-asset', ?, '__global__', ?, 'ALTERNATE', 2,
          'IMAGE', 'image/png', 'https://media.nexushub.test/post.png', ?,
          390, 390, 4096, 'DRAFT', '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.exerciseId, 'a'.repeat(64))).toThrow(/content is frozen/i);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_instruction_localizations (
          manifest_id, scope_key, exercise_id, locale, display_name, steps_json,
          cues_json, cautions_json, text_fallback, content_hash, created_at
        ) VALUES (?, '__global__', ?, 'pt-PT', 'Texto tardio', '["Passo"]',
          '[]', '[]', 'Texto tardio', ?, '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.exerciseId, 'a'.repeat(64))).toThrow(/content is frozen/i);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_localizations (
          asset_id, manifest_id, scope_key, locale, caption,
          accessibility_description, content_hash, created_at
        ) VALUES (?, ?, '__global__', 'pt-PT', NULL, 'Descrição tardia', ?,
          '2026-07-12T02:00:00.000Z')
      `).run(fixture.assetId, fixture.manifestId, 'a'.repeat(64))).toThrow(/content is frozen/i);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_provenance (
          asset_id, manifest_id, scope_key, source_kind, source_reference,
          generated_or_acquired_at, license_identifier, rights_holder_ref,
          territories_json, transformations_json, provenance_hash,
          publication_allowed, created_at
        ) VALUES ('draft-extra', ?, '__global__', 'OWNED', 'post-activation',
          '2026-07-12T00:00:00.000Z', 'owned-v1', 'owner', '["worldwide"]',
          '[]', ?, 0, '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, 'a'.repeat(64))).toThrow(/content is frozen/i);

      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_reviews (
          review_id, manifest_id, scope_key, asset_id, review_type, status,
          reviewer_ref, subject_content_hash, reason_codes_json,
          reviewed_at, expires_at, created_at
        ) VALUES ('post-active-review', ?, '__global__', ?, 'DOMAIN', 'PENDING',
          'domain-review', ?, '[]', '2026-07-12T02:00:00.000Z', NULL,
          '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.assetId, fixture.integritySha256)).not.toThrow();
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, evidence_hash, effective_at, created_at
        ) VALUES ('post-active-takedown', ?, '__global__', ?, 'REMOVE', 'DOMAIN_REVIEW',
          'domain-review', ?, '2026-07-12T02:00:00.000Z', '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.assetId, 'a'.repeat(64))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('does not let scheduled approvals or reinstatements satisfy the activation gate early', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const reviewFixture = seedApprovedExerciseMedia(db, {
        manifestId: 'scheduled-review',
        manifestVersion: 'scheduled-review.v1',
        activate: false,
        rightsExpiresAt: '2999-01-01T00:00:00.000Z',
        reviewExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      const insertReview = db.prepare(`
        INSERT INTO training_exercise_media_reviews (
          review_id, manifest_id, scope_key, asset_id, review_type, status,
          reviewer_ref, subject_content_hash, reason_codes_json,
          reviewed_at, expires_at, created_at
        ) VALUES (?, ?, '__global__', ?, 'DOMAIN', ?, 'domain-review', ?, '[]', ?, ?, ?)
      `);
      insertReview.run(
        'domain-current-rejection', reviewFixture.manifestId, reviewFixture.assetId,
        'REJECTED', reviewFixture.integritySha256, '2026-07-12T03:00:00.000Z',
        null, '2026-07-12T03:00:00.000Z',
      );
      insertReview.run(
        'domain-future-approval', reviewFixture.manifestId, reviewFixture.assetId,
        'APPROVED', reviewFixture.integritySha256, '2998-01-01T00:00:00.000Z',
        '2999-01-01T00:00:00.000Z', '2026-07-12T04:00:00.000Z',
      );
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests SET publication_state = 'ACTIVE'
         WHERE manifest_id = ?
      `).run(reviewFixture.manifestId)).toThrow(/review gate failed/i);

      const takedownFixture = seedApprovedExerciseMedia(db, {
        manifestId: 'scheduled-reinstatement',
        manifestVersion: 'scheduled-reinstatement.v1',
        activate: false,
        addTakedown: 'REMOVE',
        rightsExpiresAt: '2999-01-01T00:00:00.000Z',
        reviewExpiresAt: '2999-01-01T00:00:00.000Z',
      });
      db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, evidence_hash, effective_at, created_at
        ) VALUES ('future-reinstatement', ?, '__global__', ?, 'REINSTATE', 'SCHEDULED',
          'owner-review', ?, '2998-01-01T00:00:00.000Z', '2026-07-12T04:00:00.000Z')
      `).run(takedownFixture.manifestId, takedownFixture.assetId, 'a'.repeat(64));
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests SET publication_state = 'ACTIVE'
         WHERE manifest_id = ?
      `).run(takedownFixture.manifestId)).toThrow(/active takedown/i);
    } finally {
      db.close();
    }
  });

  it('blocks promotion when an approved asset already has an active takedown', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const fixture = seedApprovedExerciseMedia(db, {
        manifestId: 'takedown-before-active',
        manifestVersion: 'takedown-before-active.v1',
        addTakedown: 'REMOVE',
        activate: false,
      });
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests SET publication_state = 'ACTIVE'
         WHERE manifest_id = ?
      `).run(fixture.manifestId)).toThrow(/active takedown/i);
      expect(db.prepare(`
        SELECT publication_state FROM training_exercise_media_manifests WHERE manifest_id = ?
      `).get(fixture.manifestId)).toEqual({ publication_state: 'STAGED' });
    } finally {
      db.close();
    }
  });

  it('rejects extra or substituted approved asset bindings before staging attestation', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const fixture = seedApprovedExerciseMedia(db, { activate: false, stage: false });
      db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES ('unattested-extra', ?, '__global__', ?, 'ALTERNATE', 0,
          'IMAGE', 'image/png', 'https://media.nexushub.test/unattested-extra.png', ?,
          390, 390, 4096, 'APPROVED', '2026-07-12T02:00:00.000Z')
      `).run(fixture.manifestId, fixture.exerciseId, 'a'.repeat(64));
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests
           SET publication_state = 'STAGED', validation_status = 'PASSED',
               validation_attested_package_hash = ?, validation_attestation_hash = ?,
               validation_attested_at = '2026-07-12T02:00:00.000Z'
         WHERE manifest_id = ?
      `).run('a'.repeat(64), 'f'.repeat(64), fixture.manifestId))
        .toThrow(/approved asset binding/i);
      expect(db.prepare(`
        SELECT publication_state, validation_status
          FROM training_exercise_media_manifests WHERE manifest_id = ?
      `).get(fixture.manifestId)).toEqual({ publication_state: 'DRAFT', validation_status: 'PENDING' });
    } finally {
      db.close();
    }
  });

  it('binds append-only governance events to the owning manifest and tenant scope', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const global = seedApprovedExerciseMedia(db, {
        manifestId: 'global-owner', manifestVersion: 'global-owner.v1', exerciseId: 'push_up',
      });
      const tenant = seedApprovedExerciseMedia(db, {
        manifestId: 'tenant-owner', manifestVersion: 'tenant-owner.v1',
        scopeKey: 'tenant:7', exerciseId: 'bodyweight_squat',
      });
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_reviews (
          review_id, manifest_id, scope_key, asset_id, review_type, status,
          reviewer_ref, subject_content_hash, reason_codes_json,
          reviewed_at, expires_at, created_at
        ) VALUES ('cross-scope-review', ?, 'tenant:7', ?, 'DOMAIN', 'REJECTED',
          'tenant-reviewer', ?, '[]', '2026-07-12T11:00:00.000Z', NULL,
          '2026-07-12T11:00:00.000Z')
      `).run(tenant.manifestId, global.assetId, global.integritySha256))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
        ) VALUES ('cross-scope-takedown', ?, 'tenant:7', ?, 'REMOVE', 'TENANT_ONLY',
          'tenant-authority', NULL, ?, '2026-07-12T11:00:00.000Z',
          '2026-07-12T11:00:00.000Z')
      `).run(tenant.manifestId, global.assetId, 'a'.repeat(64)))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
        ) VALUES ('cross-scope-replacement', ?, '__global__', ?, 'REMOVE', 'REPLACED',
          'global-authority', ?, ?, '2026-07-12T11:00:00.000Z',
          '2026-07-12T11:00:00.000Z')
      `).run(global.manifestId, global.assetId, tenant.assetId, 'a'.repeat(64)))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests
           SET replaced_by_manifest_id = ?
         WHERE manifest_id = ?
      `).run(tenant.manifestId, global.manifestId))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('resolves the actual asset owner when freezing provenance at STAGED', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const owner = seedApprovedExerciseMedia(db, {
        manifestId: 'staged-owner', manifestVersion: 'staged-owner.v1',
        activate: false, stage: false,
      });
      const draftAssetId = 'staged-owner-draft-extra';
      db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES (?, ?, '__global__', ?, 'ALTERNATE', 0, 'IMAGE', 'image/png',
          'https://media.nexushub.test/draft-extra.png', ?, 390, 390, 4096,
          'DRAFT', '2026-07-12T01:00:00.000Z')
      `).run(draftAssetId, owner.manifestId, owner.exerciseId, 'a'.repeat(64));
      db.prepare(`
        UPDATE training_exercise_media_manifests
           SET publication_state = 'STAGED', validation_status = 'PASSED',
               validation_attested_package_hash = ?, validation_attestation_hash = ?,
               validation_attested_at = '2026-07-12T02:00:00.000Z'
         WHERE manifest_id = ?
      `).run('a'.repeat(64), 'f'.repeat(64), owner.manifestId);
      const other = seedApprovedExerciseMedia(db, {
        manifestId: 'other-draft', manifestVersion: 'other-draft.v1',
        scopeKey: 'tenant:7', exerciseId: 'bodyweight_squat',
        activate: false, stage: false,
      });
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_provenance (
          asset_id, manifest_id, scope_key, source_kind, source_reference,
          generated_or_acquired_at, license_identifier, rights_holder_ref,
          territories_json, transformations_json, provenance_hash,
          publication_allowed, created_at
        ) VALUES (?, ?, 'tenant:7', 'OWNED', 'cross-scope',
          '2026-07-12T02:00:00.000Z', 'owned-v1', 'owner', '["worldwide"]',
          '[]', ?, 0, '2026-07-12T02:00:00.000Z')
      `).run(draftAssetId, other.manifestId, 'a'.repeat(64)))
        .toThrow(/staged manifest content is frozen/i);
    } finally {
      db.close();
    }
  });

  it('applies the destructive inverse only in a disposable rehearsal database', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const downPath = path.resolve(process.cwd(), 'migrations/down/229_training_exercise_media_v1.sql');
      expect(fs.readFileSync(downPath, 'utf8')).toMatch(/STAGING REHEARSAL ONLY/i);
      db.exec(fs.readFileSync(downPath, 'utf8'));
      const remaining = db.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})
      `).all(...TABLES);
      expect(remaining).toEqual([]);
      expect(db.prepare('SELECT filename FROM _migrations WHERE filename = ?').get('229_training_exercise_media_v1.sql'))
        .toBeUndefined();
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally {
      db.close();
    }
  });
});
