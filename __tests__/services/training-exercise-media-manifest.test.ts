// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES,
  buildCompiledTrainingExerciseMediaPackage,
  sha256TrainingExerciseMedia,
  validateCompiledTrainingExerciseMediaPackage,
} from '../../src/services/training-exercise-media-manifest';
import {
  computeStoredTrainingExerciseMediaFrozenPackageHash,
  seedCompiledTrainingExerciseMediaPackage,
} from '../../src/services/training-exercise-media-seed';
import { runMigrationsForTest } from '../../src/services/database';
import {
  compileTrainingExerciseMediaPackage,
  findForbiddenMediaBinaries,
  loadTrainingExerciseMediaPackageSources,
  readCompiledTrainingExerciseMediaPackage,
} from '../../scripts/lib/training-exercise-media-package';

function buildActivationReadyPackage() {
  const base = loadTrainingExerciseMediaPackageSources();
  const exerciseIds = base.manifest.expectedExerciseIds;
  const createdAt = '2026-07-12T00:00:00.000Z';
  const activatedAt = '2026-07-12T01:00:00.000Z';
  const integritySha256 = 'c'.repeat(64);
  const assets = exerciseIds.map((exerciseId) => ({
    assetId: `asset-${exerciseId}`,
    exerciseId,
    viewRole: 'PRIMARY' as const,
    ordinal: 0,
    mediaKind: 'IMAGE' as const,
    contentType: 'image/png',
    deliveryUrl: `https://media.nexushub.test/v1/${exerciseId}.png`,
    integritySha256,
    widthPixels: 390,
    heightPixels: 390,
    byteSize: 4096,
    publicationState: 'APPROVED' as const,
    createdAt,
  }));
  return buildCompiledTrainingExerciseMediaPackage({
    manifest: {
      ...base.manifest,
      manifestId: 'activation-ready-v1',
      manifestVersion: 'activation-ready.v1',
      publicationState: 'ACTIVE',
      validationStatus: 'PASSED',
      allowedOrigins: ['https://media.nexushub.test'],
      ownerApprovalRef: 'owner-approval:activation-ready-v1',
      activatedAt,
    },
    exercises: exerciseIds.map((exerciseId) => ({
      exerciseId,
      canonicalName: `Reviewed ${exerciseId}`,
      aliases: [],
      requiredViews: ['PRIMARY'],
      exerciseContentHash: sha256TrainingExerciseMedia({ exerciseId }),
      publicationState: 'APPROVED',
      exclusionReason: null,
      globalExerciseId: null,
      equivalenceHash: null,
      createdAt,
    })),
    assets,
    instructions: exerciseIds.flatMap((exerciseId) => (
      TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => ({
        exerciseId,
        locale,
        displayName: `Reviewed ${exerciseId}`,
        steps: ['Set a stable position.', 'Move with control.'],
        cues: ['Keep a neutral spine.'],
        cautions: ['Stop if the movement is painful.'],
        textFallback: 'Use the complete written instructions when media is unavailable.',
        contentHash: sha256TrainingExerciseMedia({ exerciseId, locale, kind: 'instruction' }),
        createdAt,
      }))
    )),
    mediaLocalizations: assets.flatMap((asset) => (
      TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => ({
        assetId: asset.assetId,
        locale,
        caption: 'Primary movement position',
        accessibilityDescription: 'Person demonstrating the reviewed primary movement position.',
        contentHash: sha256TrainingExerciseMedia({ assetId: asset.assetId, locale, kind: 'media' }),
        createdAt,
      }))
    )),
    provenance: assets.map((asset) => ({
      assetId: asset.assetId,
      sourceKind: 'GENERATED' as const,
      sourceReference: `fixture:${asset.assetId}`,
      generatorModel: 'fixture-model',
      promptHash: sha256TrainingExerciseMedia({ assetId: asset.assetId, kind: 'prompt' }),
      generatedOrAcquiredAt: createdAt,
      licenseIdentifier: 'fixture-owned-license-v1',
      licenseUrl: 'https://nexushub.test/licenses/fixture',
      rightsHolderRef: 'fixture-rights-owner',
      rightsExpiresAt: '2030-01-01T00:00:00.000Z',
      territories: ['worldwide'],
      transformations: [],
      provenanceHash: sha256TrainingExerciseMedia({ assetId: asset.assetId, kind: 'provenance' }),
      publicationAllowed: true,
      createdAt,
    })),
    reviews: assets.flatMap((asset) => (
      TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES.map((reviewType, index) => ({
        reviewId: `${asset.assetId}-review-${reviewType}`,
        assetId: asset.assetId,
        reviewType,
        status: 'APPROVED' as const,
        reviewerRef: `fixture-reviewer:${reviewType.toLowerCase()}`,
        subjectContentHash: asset.integritySha256,
        reasonCodes: [],
        reviewedAt: `2026-07-12T00:0${index + 1}:00.000Z`,
        expiresAt: '2030-01-01T00:00:00.000Z',
        createdAt: `2026-07-12T00:0${index + 1}:00.000Z`,
      }))
    )),
    takedowns: [],
  });
}

describe('Training exercise media manifest tooling', () => {
  it('keeps the checked-in draft deterministic, binary-free, and explicitly non-activatable', () => {
    const generated = compileTrainingExerciseMediaPackage();
    const checkedIn = readCompiledTrainingExerciseMediaPackage();
    const validation = validateCompiledTrainingExerciseMediaPackage(checkedIn, {
      now: new Date('2026-07-12T12:00:00.000Z'),
    });

    expect(checkedIn).toEqual(generated);
    expect(checkedIn.packageHash).toBe('e621ee25a1d4210279cffa4c3c10ea94e40d86a257acd366778b15e2f6a8d8e7');
    expect(findForbiddenMediaBinaries()).toEqual([]);
    expect(validation.structurallyValid).toBe(true);
    expect(validation.activationReady).toBe(false);
    expect(validation.coverage).toMatchObject({
      expectedExercises: 158,
      approvedExercises: 0,
      approvedAssets: 0,
      instructionLocalizations: 0,
      mediaLocalizations: 0,
      approvedReviews: 0,
    });
    expect(validation.activationBlockers).toEqual(expect.arrayContaining([
      'Manifest publication state is not ACTIVE.',
      'Manifest has no approved delivery origin.',
      'Approved exercise coverage is 0/158.',
    ]));
  });

  it('detects compiled-package tampering and unsafe delivery origins', () => {
    const sources = loadTrainingExerciseMediaPackageSources();
    const compiled = buildCompiledTrainingExerciseMediaPackage({
      ...sources,
      manifest: {
        ...sources.manifest,
        allowedOrigins: ['http://insecure.example.test'],
      },
    });
    const tampered = { ...compiled, packageHash: '0'.repeat(64) };
    const validation = validateCompiledTrainingExerciseMediaPackage(tampered);
    expect(validation.structurallyValid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'Compiled media package hash does not match its canonical sources.',
      'Manifest allowed origin is invalid: http://insecure.example.test',
    ]));
  });

  it('pins the immutable expected-ID snapshot and the v1 image MIME contract', () => {
    const sources = loadTrainingExerciseMediaPackageSources();
    const compiled = buildCompiledTrainingExerciseMediaPackage({
      ...sources,
      manifest: {
        ...sources.manifest,
        expectedExerciseIds: sources.manifest.expectedExerciseIds.slice(1),
        allowedOrigins: ['https://media.nexushub.test'],
      },
      assets: [{
        assetId: 'unsupported-webp',
        exerciseId: 'push_up',
        viewRole: 'PRIMARY',
        ordinal: 0,
        mediaKind: 'IMAGE',
        contentType: 'image/webp',
        deliveryUrl: 'https://media.nexushub.test/unsupported.webp',
        integritySha256: 'a'.repeat(64),
        widthPixels: 390,
        heightPixels: 390,
        byteSize: 4096,
        publicationState: 'DRAFT',
        createdAt: '2026-07-12T00:00:00.000Z',
      }],
    });
    const validation = validateCompiledTrainingExerciseMediaPackage(compiled);
    expect(validation.structurallyValid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      'Manifest expected exercise IDs must exactly match the authoritative 158-exercise catalog snapshot.',
      'Asset content type is unsupported by the v1 image contract: unsupported-webp',
    ]));
  });

  it('counts only takedown events effective at the validation instant', () => {
    const sources = loadTrainingExerciseMediaPackageSources();
    const currentRemove = {
      eventId: 'current-remove',
      assetId: 'not-present',
      action: 'REMOVE' as const,
      reasonCode: 'TEST',
      authorityRef: 'test-authority',
      replacementAssetId: null,
      evidenceHash: 'a'.repeat(64),
      effectiveAt: '2026-07-12T11:00:00.000Z',
      createdAt: '2026-07-12T10:00:00.000Z',
    };
    const futureReinstate = {
      ...currentRemove,
      eventId: 'future-reinstate',
      action: 'REINSTATE' as const,
      effectiveAt: '2027-07-12T11:00:00.000Z',
    };
    const compiled = buildCompiledTrainingExerciseMediaPackage({
        ...sources,
        takedowns: [currentRemove, futureReinstate],
      });
    const validation = validateCompiledTrainingExerciseMediaPackage(
      compiled, { now: new Date('2026-07-12T12:00:00.000Z') },
    );
    expect(compiled.packageHash).toBe(buildCompiledTrainingExerciseMediaPackage(sources).packageHash);
    expect(validation.coverage.activeTakedowns).toBe(1);
    expect(validation.errors).toContain('Takedown references an unknown asset: current-remove');
  });

  it('seeds the draft idempotently without activating or serving it', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = readCompiledTrainingExerciseMediaPackage();
      const first = seedCompiledTrainingExerciseMediaPackage(db, compiled);
      const replay = seedCompiledTrainingExerciseMediaPackage(db, compiled);
      expect(first).toMatchObject({ inserted: true, activated: false });
      expect(replay).toMatchObject({ inserted: false, activated: false });
      expect(db.prepare(`
        SELECT publication_state, validation_status FROM training_exercise_media_manifests
         WHERE manifest_id = ?
      `).get(compiled.manifest.manifestId)).toEqual({
        publication_state: 'DRAFT',
        validation_status: 'PENDING',
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count FROM training_exercise_media_manifests
         WHERE publication_state = 'ACTIVE'
      `).get()).toEqual({ count: 0 });

      const changedSources = loadTrainingExerciseMediaPackageSources();
      const changed = buildCompiledTrainingExerciseMediaPackage({
        ...changedSources,
        manifest: { ...changedSources.manifest, manifestVersion: 'training-exercise-media.v1-draft.2' },
      });
      expect(() => seedCompiledTrainingExerciseMediaPackage(db, changed))
        .toThrow(/same manifest ID|already exists/i);
    } finally {
      db.close();
    }
  });

  it('refuses to attest a draft when stored frozen rows drift from its package hash', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = readCompiledTrainingExerciseMediaPackage();
      seedCompiledTrainingExerciseMediaPackage(db, compiled);
      db.prepare(`
        INSERT INTO training_exercise_media_exercises (
          manifest_id, scope_key, exercise_id, canonical_name, aliases_json,
          required_views_json, exercise_content_hash, publication_state,
          exclusion_reason, global_exercise_id, equivalence_hash, created_at
        ) VALUES (?, '__global__', 'push_up', 'Unattested Push Up', '[]',
          '["PRIMARY"]', ?, 'DRAFT', NULL, NULL, NULL, '2026-07-12T02:00:00.000Z')
      `).run(compiled.manifest.manifestId, 'a'.repeat(64));
      expect(() => seedCompiledTrainingExerciseMediaPackage(db, compiled))
        .toThrow(/do not match the immutable reviewed package hash/i);
    } finally {
      db.close();
    }
  });

  it('does not label an activation-incomplete package as validation-passed STAGED content', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const sources = loadTrainingExerciseMediaPackageSources();
      const incomplete = buildCompiledTrainingExerciseMediaPackage({
        ...sources,
        manifest: {
          ...sources.manifest,
          manifestId: 'incomplete-staged',
          manifestVersion: 'incomplete-staged.v1',
          publicationState: 'STAGED',
          validationStatus: 'PASSED',
          allowedOrigins: ['https://media.nexushub.test'],
          ownerApprovalRef: 'owner-approval:incomplete-staged',
        },
      });
      expect(() => seedCompiledTrainingExerciseMediaPackage(db, incomplete))
        .toThrow(/not staging-ready.*Approved exercise coverage is 0\/158/i);
    } finally {
      db.close();
    }
  });

  it('recomputes the full 158-exercise DB package before one-time staging and activation', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = buildActivationReadyPackage();
      const now = new Date('2026-07-12T12:00:00.000Z');
      expect(validateCompiledTrainingExerciseMediaPackage(compiled, { now }).activationReady).toBe(true);
      const staged = seedCompiledTrainingExerciseMediaPackage(db, compiled, { now });
      expect(staged).toMatchObject({ inserted: true, staged: true, activated: false });
      expect(staged.validationAttestationHash).toMatch(/^[0-9a-f]{64}$/);
      expect(computeStoredTrainingExerciseMediaFrozenPackageHash(
        db, compiled.manifest.manifestId,
      )).toBe(compiled.packageHash);
      expect(db.prepare(`
        SELECT publication_state, validation_status, validation_attested_package_hash
          FROM training_exercise_media_manifests WHERE manifest_id = ?
      `).get(compiled.manifest.manifestId)).toEqual({
        publication_state: 'STAGED',
        validation_status: 'PASSED',
        validation_attested_package_hash: compiled.packageHash,
      });
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_assets (
          asset_id, manifest_id, scope_key, exercise_id, view_role, ordinal,
          media_kind, content_type, delivery_url, integrity_sha256,
          width_pixels, height_pixels, byte_size, publication_state, created_at
        ) VALUES ('late-approved-extra', ?, '__global__', 'push_up', 'ALTERNATE', 0,
          'IMAGE', 'image/png', 'https://media.nexushub.test/v1/late.png', ?,
          390, 390, 4096, 'APPROVED', '2026-07-12T02:00:00.000Z')
      `).run(compiled.manifest.manifestId, 'a'.repeat(64)))
        .toThrow(/staged manifest content is frozen/i);

      const active = seedCompiledTrainingExerciseMediaPackage(db, compiled, { activate: true, now });
      expect(active).toMatchObject({ inserted: false, staged: true, activated: true });
    } finally {
      db.close();
    }
  });
});
