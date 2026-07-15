// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest } from '../../src/services/database';
import { lookupTrainingExerciseMedia as rawLookupTrainingExerciseMedia } from '../../src/services/training-exercise-media';
import { seedApprovedExerciseMedia } from '../fixtures/training-exercise-media';

function lookupTrainingExerciseMedia(
  tenantId: number,
  userId: number,
  exerciseIds: readonly string[],
  locale: Parameters<typeof rawLookupTrainingExerciseMedia>[3],
  options: Parameters<typeof rawLookupTrainingExerciseMedia>[4] = {},
) {
  return rawLookupTrainingExerciseMedia(tenantId, userId, exerciseIds, locale, {
    ...options,
    expectedExerciseIds: options.expectedExerciseIds ?? ['push_up'],
  });
}

describe('Training exercise media repository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => db.close());

  it('serves only approved active media and resolves a reviewed alias without changing its objective', () => {
    seedApprovedExerciseMedia(db, { alias: 'press_up' });
    const result = lookupTrainingExerciseMedia(
      7, 7, ['push_up', 'press_up'], 'pt-PT',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    );
    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(2);
    expect(result?.items[0]).toMatchObject({
      kind: 'AVAILABLE',
      requestedExerciseId: 'push_up',
      exerciseId: 'push_up',
      resolvedBy: 'CANONICAL_ID',
      instruction: { locale: 'en-US', fallbackFromLocale: 'pt-PT' },
      assets: [expect.objectContaining({
        exerciseId: 'push_up',
        version: 1,
        viewRole: 'PRIMARY',
        locale: 'en-US',
        fallbackFromLocale: 'pt-PT',
        integritySha256: 'c'.repeat(64),
        governance: {
          publicationState: 'PUBLISHED',
          reviewState: 'APPROVED',
          safetyState: 'APPROVED',
          approvalReference: expect.stringMatching(/^[0-9a-f]{64}$/),
          reviewedAt: '2026-07-12T00:09:00.000Z',
          licenseIdentifier: 'fixture-owned-license-v1',
          licenseTermsURL: 'https://nexushub.test/licenses/fixture',
          rightsExpiresAt: '2030-01-01T00:00:00.000Z',
          provenanceSource: 'GENERATED',
        },
      })],
    });
    expect(result?.items[1]).toMatchObject({
      kind: 'AVAILABLE',
      requestedExerciseId: 'press_up',
      exerciseId: 'push_up',
      resolvedBy: 'REVIEWED_ALIAS',
    });
    expect(result?.eTag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(JSON.stringify(result)).not.toContain('reviewer:');
    expect(JSON.stringify(result)).not.toContain('fixture:manifest-global-1-asset-primary');
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up', 'press_up'], 'pt-PT',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.eTag).toBe(result?.eTag);
  });

  it('rejects a partial active fixture when production uses the authoritative 158-ID snapshot', () => {
    seedApprovedExerciseMedia(db);
    expect(rawLookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )).toBeNull();
  });

  it('preserves an unknown identifier honestly instead of attaching unrelated media', () => {
    seedApprovedExerciseMedia(db);
    const result = lookupTrainingExerciseMedia(
      7, 7, ['future_modal_xyz'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    );
    expect(result?.items).toEqual([{
      kind: 'UNAVAILABLE',
      requestedExerciseId: 'future_modal_xyz',
      rawIdentifier: 'future_modal_xyz',
      reason: 'UNKNOWN_EXERCISE',
      textFallbackRequired: true,
    }]);
  });

  it('fails an asset closed when its URL origin is unapproved', () => {
    seedApprovedExerciseMedia(db, {
      deliveryUrl: `https://unapproved.example.test/${'c'.repeat(64)}.png`,
    });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
  });

  it('fails an otherwise valid asset closed after its rights or latest review expires', () => {
    seedApprovedExerciseMedia(db, {
      rightsExpiresAt: '2027-01-01T00:00:00.000Z',
      reviewExpiresAt: '2027-01-01T00:00:00.000Z',
    });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'AVAILABLE' });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2027-01-02T00:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
  });

  it('lets a newer rejection override an older approval without mutating review history', () => {
    const fixture = seedApprovedExerciseMedia(db);
    db.prepare(`
      INSERT INTO training_exercise_media_reviews (
        review_id, manifest_id, scope_key, asset_id, review_type, status,
        reviewer_ref, subject_content_hash, reason_codes_json,
        reviewed_at, expires_at, created_at
      ) VALUES ('domain-rejected-later', ?, '__global__', ?, 'DOMAIN', 'REJECTED',
        'domain-red-team', ?, '["ANATOMY_ANOMALY"]',
        '2026-07-12T03:00:00.000Z', NULL, '2026-07-12T03:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, fixture.integritySha256);
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM training_exercise_media_reviews
       WHERE asset_id = ? AND review_type = 'DOMAIN'
    `).get(fixture.assetId)).toEqual({ count: 2 });
  });

  it('rejects a latest approval that is bound to a different asset checksum', () => {
    const fixture = seedApprovedExerciseMedia(db);
    db.prepare(`
      INSERT INTO training_exercise_media_reviews (
        review_id, manifest_id, scope_key, asset_id, review_type, status,
        reviewer_ref, subject_content_hash, reason_codes_json,
        reviewed_at, expires_at, created_at
      ) VALUES ('legal-wrong-checksum', ?, '__global__', ?, 'LEGAL', 'APPROVED',
        'legal-red-team', ?, '[]', '2026-07-12T03:00:00.000Z',
        '2030-01-01T00:00:00.000Z', '2026-07-12T03:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, 'd'.repeat(64));
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
  });

  it('rejects accessibility approval bound only to the image binary instead of localized AX content', () => {
    const fixture = seedApprovedExerciseMedia(db);
    db.prepare(`
      INSERT INTO training_exercise_media_reviews (
        review_id, manifest_id, scope_key, asset_id, review_type, status,
        reviewer_ref, subject_content_hash, reason_codes_json,
        reviewed_at, expires_at, created_at
      ) VALUES ('accessibility-binary-only', ?, '__global__', ?, 'ACCESSIBILITY', 'APPROVED',
        'accessibility-red-team', ?, '[]', '2026-07-12T03:00:00.000Z',
        '2030-01-01T00:00:00.000Z', '2026-07-12T03:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, fixture.integritySha256);
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
  });

  it('rejects a localization approval whose evidence hash is stale', () => {
    const fixture = seedApprovedExerciseMedia(db);
    db.prepare(`
      INSERT INTO training_exercise_media_localization_reviews (
        review_id, manifest_id, scope_key, asset_id, locale, status,
        reviewer_ref, subject_content_hash, reason_codes_json,
        reviewed_at, expires_at, created_at
      ) VALUES ('media-localization-stale', ?, '__global__', ?, 'en-US', 'APPROVED',
        'localization-red-team', ?, '[]', '2026-07-12T03:00:00.000Z',
        '2030-01-01T00:00:00.000Z', '2026-07-12T03:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, 'f'.repeat(64));
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
  });

  it('ignores a future approval until its reviewedAt instant becomes effective', () => {
    const fixture = seedApprovedExerciseMedia(db);
    const insert = db.prepare(`
      INSERT INTO training_exercise_media_reviews (
        review_id, manifest_id, scope_key, asset_id, review_type, status,
        reviewer_ref, subject_content_hash, reason_codes_json,
        reviewed_at, expires_at, created_at
      ) VALUES (?, ?, '__global__', ?, 'DOMAIN', ?, 'domain-review', ?, '[]', ?, ?, ?)
    `);
    insert.run(
      'domain-rejected-current', fixture.manifestId, fixture.assetId, 'REJECTED',
      fixture.integritySha256, '2026-07-12T03:00:00.000Z', null, '2026-07-12T03:00:00.000Z',
    );
    insert.run(
      'domain-approved-scheduled', fixture.manifestId, fixture.assetId, 'APPROVED',
      fixture.integritySha256, '2027-01-01T00:00:00.000Z',
      '2029-01-01T00:00:00.000Z', '2026-07-12T04:00:00.000Z',
    );

    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2027-01-02T00:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'AVAILABLE', exerciseId: 'push_up' });
  });

  it('honors append-only takedown and later reinstatement events', () => {
    const fixture = seedApprovedExerciseMedia(db, { addTakedown: 'REMOVE' });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });

    db.prepare(`
      INSERT INTO training_exercise_media_takedown_events (
        event_id, manifest_id, scope_key, asset_id, action, reason_code,
        authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
      ) VALUES ('reinstate-later', ?, '__global__', ?, 'REINSTATE', 'REVIEW_CLEARED',
        'owner-review', NULL, ?, '2026-07-12T02:00:00.000Z', '2026-07-12T02:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, 'a'.repeat(64));
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'AVAILABLE', exerciseId: 'push_up' });
  });

  it('keeps a current takedown active until a scheduled reinstatement becomes effective', () => {
    const fixture = seedApprovedExerciseMedia(db, { addTakedown: 'REMOVE' });
    db.prepare(`
      INSERT INTO training_exercise_media_takedown_events (
        event_id, manifest_id, scope_key, asset_id, action, reason_code,
        authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
      ) VALUES ('reinstate-scheduled', ?, '__global__', ?, 'REINSTATE', 'REVIEW_CLEARED',
        'owner-review', NULL, ?, '2027-01-01T00:00:00.000Z', '2026-07-12T02:00:00.000Z')
    `).run(fixture.manifestId, fixture.assetId, 'a'.repeat(64));

    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2026-07-12T12:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'UNAVAILABLE', reason: 'MEDIA_UNAVAILABLE' });
    expect(lookupTrainingExerciseMedia(
      7, 7, ['push_up'], 'en-US',
      { db, now: new Date('2027-01-02T00:00:00.000Z') },
    )?.items[0]).toMatchObject({ kind: 'AVAILABLE', exerciseId: 'push_up' });
  });

  it('rejects non-personal or invalid tenant scopes before querying content', () => {
    seedApprovedExerciseMedia(db);
    expect(lookupTrainingExerciseMedia(8, 7, ['push_up'], 'en-US', { db })).toBeNull();
    expect(lookupTrainingExerciseMedia(0, 0, ['push_up'], 'en-US', { db })).toBeNull();
    expect(lookupTrainingExerciseMedia(7, 7, [], 'en-US', { db })).toBeNull();
    expect(lookupTrainingExerciseMedia(7, 7, Array.from({ length: 51 }, (_, index) => `id_${index}`), 'en-US', { db }))
      .toBeNull();
  });
});
