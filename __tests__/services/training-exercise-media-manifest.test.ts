// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES,
  TRAINING_EXERCISE_MEDIA_REQUIRED_REVIEW_TYPES,
  buildTrainingExerciseMediaAccessibilityBundleHash,
  buildTrainingExerciseMediaOriginsHash,
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
  const instructions = exerciseIds.flatMap((exerciseId) => (
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
  ));
  const mediaLocalizations = assets.flatMap((asset) => (
    TRAINING_EXERCISE_MEDIA_REQUIRED_LOCALES.map((locale) => ({
      assetId: asset.assetId,
      locale,
      caption: 'Primary movement position',
      accessibilityDescription: 'Person demonstrating the reviewed primary movement position.',
      contentHash: sha256TrainingExerciseMedia({ assetId: asset.assetId, locale, kind: 'media' }),
      createdAt,
    }))
  ));
  const sources = {
    manifest: {
      ...base.manifest,
      manifestId: 'activation-ready-v1',
      manifestVersion: 'activation-ready.v1',
      publicationState: 'ACTIVE',
      validationStatus: 'PASSED',
      allowedOrigins: ['https://media.nexushub.test'],
      approvedHostRef: 'host-approval:activation-ready-v1',
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
    instructions,
    mediaLocalizations,
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
        subjectContentHash: reviewType === 'ACCESSIBILITY'
          ? buildTrainingExerciseMediaAccessibilityBundleHash(asset.assetId, mediaLocalizations)
          : asset.integritySha256,
        reasonCodes: [],
        reviewedAt: `2026-07-12T00:0${index + 1}:00.000Z`,
        expiresAt: '2030-01-01T00:00:00.000Z',
        createdAt: `2026-07-12T00:0${index + 1}:00.000Z`,
      }))
    )),
    localizationReviews: [
      ...instructions.map((instruction) => ({
        reviewId: `instruction-${instruction.exerciseId}-${instruction.locale}`,
        targetKind: 'INSTRUCTION' as const,
        targetId: instruction.exerciseId,
        locale: instruction.locale,
        status: 'APPROVED' as const,
        reviewerRef: 'fixture-reviewer:localization',
        subjectContentHash: instruction.contentHash,
        reasonCodes: [],
        reviewedAt: '2026-07-12T00:05:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        createdAt: '2026-07-12T00:05:00.000Z',
      })),
      ...mediaLocalizations.map((localization) => ({
        reviewId: `media-${localization.assetId}-${localization.locale}`,
        targetKind: 'MEDIA_ACCESSIBILITY' as const,
        targetId: localization.assetId,
        locale: localization.locale,
        status: 'APPROVED' as const,
        reviewerRef: 'fixture-reviewer:localization',
        subjectContentHash: localization.contentHash,
        reasonCodes: [],
        reviewedAt: '2026-07-12T00:05:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
        createdAt: '2026-07-12T00:05:00.000Z',
      })),
    ],
    hostApprovals: [{
      approvalId: 'host-approval:activation-ready-v1',
      status: 'APPROVED' as const,
      reviewerRef: 'fixture-reviewer:host',
      subjectOrigins: ['https://media.nexushub.test'],
      subjectOriginsHash: buildTrainingExerciseMediaOriginsHash(['https://media.nexushub.test']),
      reasonCodes: [],
      reviewedAt: '2026-07-12T00:06:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-07-12T00:06:00.000Z',
    }],
    ownerApprovals: [],
    takedowns: [],
  };
  const preflight = buildCompiledTrainingExerciseMediaPackage(sources);
  return buildCompiledTrainingExerciseMediaPackage({
    ...sources,
    ownerApprovals: [{
      approvalId: 'owner-approval:activation-ready-v1',
      status: 'APPROVED',
      reviewerRef: 'fixture-reviewer:owner',
      subjectPackageHash: preflight.packageHash,
      reasonCodes: [],
      reviewedAt: '2026-07-12T00:07:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      createdAt: '2026-07-12T00:07:00.000Z',
    }],
  });
}

describe('Training exercise media manifest tooling', () => {
  it('keeps the checked-in approved package deterministic, binary-free, and activation-ready', () => {
    const generated = compileTrainingExerciseMediaPackage();
    const checkedIn = readCompiledTrainingExerciseMediaPackage();
    const validation = validateCompiledTrainingExerciseMediaPackage(checkedIn, {
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(checkedIn).toEqual(generated);
    expect(checkedIn.packageHash).toBe('51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb');
    expect(findForbiddenMediaBinaries()).toEqual([]);
    expect(validation.structurallyValid).toBe(true);
    expect(validation.activationReady).toBe(true);
    expect(validation.coverage).toMatchObject({
      expectedExercises: 158,
      listedExercises: 158,
      approvedExercises: 158,
      approvedAssets: 200,
      instructionLocalizations: 474,
      mediaLocalizations: 600,
      approvedReviews: 800,
    });
    expect(validation.activationBlockers).toEqual([]);
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

  it('imports human approvals from the durable ledger even when generated sources are rewritten', () => {
    const sourceRoot = path.resolve(process.cwd(), 'catalog/training/exercise-media/v1');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'training-media-ledger-'));
    try {
      fs.cpSync(sourceRoot, temporaryRoot, { recursive: true });
      const manifestPath = path.join(temporaryRoot, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(manifestPath, `${JSON.stringify({
        ...manifest,
        approvedHostRef: null,
        ownerApprovalRef: null,
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(temporaryRoot, 'reviews.json'), '[]\n');
      fs.writeFileSync(path.join(temporaryRoot, 'approval-ledger.json'), `${JSON.stringify({
        schemaVersion: 'training-exercise-media-approval-ledger.v1',
        approvedHostRef: 'durable-host-approval',
        ownerApprovalRef: 'durable-owner-approval',
        assetReviews: [],
        localizationReviews: [],
        hostApprovals: [{
          approvalId: 'durable-host-approval',
          status: 'PENDING',
          reviewerRef: 'reviewer:host',
          subjectOrigins: [],
          subjectOriginsHash: buildTrainingExerciseMediaOriginsHash([]),
          reasonCodes: [],
          reviewedAt: '2026-07-12T00:00:00.000Z',
          expiresAt: null,
          createdAt: '2026-07-12T00:00:00.000Z',
        }],
        ownerApprovals: [{
          approvalId: 'durable-owner-approval',
          status: 'PENDING',
          reviewerRef: 'reviewer:owner',
          subjectPackageHash: 'a'.repeat(64),
          reasonCodes: [],
          reviewedAt: '2026-07-12T00:00:00.000Z',
          expiresAt: null,
          createdAt: '2026-07-12T00:00:00.000Z',
        }],
      }, null, 2)}\n`);

      const loaded = loadTrainingExerciseMediaPackageSources(temporaryRoot);
      expect(loaded.manifest).toMatchObject({
        approvedHostRef: 'durable-host-approval',
        ownerApprovalRef: 'durable-owner-approval',
      });
      expect(loaded.hostApprovals.map((entry) => entry.approvalId)).toEqual(['durable-host-approval']);
      expect(loaded.ownerApprovals.map((entry) => entry.approvalId)).toEqual(['durable-owner-approval']);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('binds owner and host approvals to the exact immutable package and origin set', () => {
    const ready = buildActivationReadyPackage();
    const wrongOwner = buildCompiledTrainingExerciseMediaPackage({
      ...ready,
      ownerApprovals: ready.ownerApprovals.map((entry) => ({
        ...entry,
        subjectPackageHash: 'f'.repeat(64),
      })),
    });
    const wrongHost = buildCompiledTrainingExerciseMediaPackage({
      ...ready,
      hostApprovals: ready.hostApprovals.map((entry) => ({
        ...entry,
        subjectOrigins: ['https://unapproved.example.test'],
        subjectOriginsHash: buildTrainingExerciseMediaOriginsHash(['https://unapproved.example.test']),
      })),
    });
    expect(validateCompiledTrainingExerciseMediaPackage(wrongOwner, {
      now: new Date('2026-07-12T12:00:00.000Z'),
    }).activationBlockers).toContain('Manifest owner approval is not valid for its exact package hash.');
    expect(validateCompiledTrainingExerciseMediaPackage(wrongHost, {
      now: new Date('2026-07-12T12:00:00.000Z'),
    }).activationBlockers).toContain('Manifest approved host reference is not valid for its exact delivery origins.');
  });

  it('binds localization and accessibility approvals to localized content hashes', () => {
    const ready = buildActivationReadyPackage();
    const firstLocalizationReview = ready.localizationReviews[0];
    const staleLocalization = buildCompiledTrainingExerciseMediaPackage({
      ...ready,
      localizationReviews: ready.localizationReviews.map((entry) => (
        entry.reviewId === firstLocalizationReview.reviewId
          ? { ...entry, subjectContentHash: 'f'.repeat(64) }
          : entry
      )),
    });
    const firstAsset = ready.assets[0];
    const binaryBoundAccessibility = buildCompiledTrainingExerciseMediaPackage({
      ...ready,
      reviews: ready.reviews.map((entry) => (
        entry.assetId === firstAsset.assetId && entry.reviewType === 'ACCESSIBILITY'
          ? { ...entry, subjectContentHash: firstAsset.integritySha256 }
          : entry
      )),
    });
    const now = new Date('2026-07-12T12:00:00.000Z');
    expect(validateCompiledTrainingExerciseMediaPackage(staleLocalization, { now }).activationBlockers)
      .toContain(`Latest ${firstLocalizationReview.locale} instruction localization review is not valid for ${firstLocalizationReview.targetId}.`);
    expect(validateCompiledTrainingExerciseMediaPackage(binaryBoundAccessibility, { now }).activationBlockers)
      .toContain(`Latest ACCESSIBILITY review is not valid for ${firstAsset.assetId}.`);
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

  it('seeds the approved package idempotently without activating it', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = readCompiledTrainingExerciseMediaPackage();
      const first = seedCompiledTrainingExerciseMediaPackage(db, compiled);
      const replay = seedCompiledTrainingExerciseMediaPackage(db, compiled);
      expect(first).toMatchObject({ inserted: true, staged: true, activated: false });
      expect(replay).toMatchObject({ inserted: false, activated: false });
      expect(db.prepare(`
        SELECT publication_state, validation_status FROM training_exercise_media_manifests
         WHERE manifest_id = ?
      `).get(compiled.manifest.manifestId)).toEqual({
        publication_state: 'STAGED',
        validation_status: 'PASSED',
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
        .toThrow(/owner approval.*exact package hash|same manifest ID|already exists/i);
    } finally {
      db.close();
    }
  });

  it('never lets a generated catalog sync erase durable approval references', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = readCompiledTrainingExerciseMediaPackage();
      seedCompiledTrainingExerciseMediaPackage(db, compiled);
      expect(() => seedCompiledTrainingExerciseMediaPackage(db, compiled)).not.toThrow();
      expect(db.prepare(`
        SELECT approved_host_ref, owner_approval_ref
          FROM training_exercise_media_manifests WHERE manifest_id = ?
      `).get(compiled.manifest.manifestId)).toEqual({
        approved_host_ref: compiled.manifest.approvedHostRef,
        owner_approval_ref: compiled.manifest.ownerApprovalRef,
      });

      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests
           SET owner_approval_ref = 'collision:owner-approval'
         WHERE manifest_id = ?
      `).run(compiled.manifest.manifestId)).toThrow(/approval references freeze at staging/i);

      expect(() => db.prepare(`
        UPDATE training_exercise_media_manifests
           SET owner_approval_ref = NULL
         WHERE manifest_id = ?
      `).run(compiled.manifest.manifestId)).toThrow(/approval references freeze at staging/i);
    } finally {
      db.close();
    }
  });

  it('prevents a checked-in draft row from drifting below its package attestation', () => {
    const db = new Database(':memory:');
    try {
      runMigrationsForTest(db);
      const compiled = readCompiledTrainingExerciseMediaPackage();
      seedCompiledTrainingExerciseMediaPackage(db, compiled);
      expect(() => db.prepare(`
        UPDATE training_exercise_media_exercises
           SET canonical_name = 'Unattested Push Up', exercise_content_hash = ?
         WHERE manifest_id = ? AND scope_key = '__global__' AND exercise_id = 'push_up'
      `).run('a'.repeat(64), compiled.manifest.manifestId)).toThrow(/exercise rows are immutable/i);
      expect(() => seedCompiledTrainingExerciseMediaPackage(db, compiled)).not.toThrow();
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
          activatedAt: null,
          ownerApprovalRef: null,
        },
        exercises: sources.exercises.map((exercise) => ({
          ...exercise,
          publicationState: 'DRAFT' as const,
        })),
        assets: sources.assets.map((asset) => ({
          ...asset,
          publicationState: 'DRAFT' as const,
        })),
        ownerApprovals: [],
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
