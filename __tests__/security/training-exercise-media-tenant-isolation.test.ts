// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { lookupTrainingExerciseMedia } from '../../src/services/training-exercise-media';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { seedApprovedExerciseMedia } from '../fixtures/training-exercise-media';

describe('Training exercise media tenant isolation', () => {
  it('never merges a tenant override manifest into another authenticated scope', () => {
    const db = createMigratedTestDatabase();
    try {
      seedApprovedExerciseMedia(db, {
        manifestId: 'global-manifest',
        manifestVersion: 'global-manifest.v1',
        exerciseId: 'push_up',
      });
      seedApprovedExerciseMedia(db, {
        manifestId: 'tenant-7-manifest',
        manifestVersion: 'tenant-7-manifest.v1',
        scopeKey: 'tenant:7',
        exerciseId: 'bodyweight_squat',
      });

      const userSeven = lookupTrainingExerciseMedia(
        7, 7, ['bodyweight_squat', 'push_up'], 'en-US',
        {
          db,
          now: new Date('2026-07-12T12:00:00.000Z'),
          expectedExerciseIds: ['bodyweight_squat'],
        },
      );
      expect(userSeven?.items).toEqual([
        expect.objectContaining({ kind: 'AVAILABLE', exerciseId: 'bodyweight_squat' }),
        expect.objectContaining({ kind: 'UNAVAILABLE', rawIdentifier: 'push_up' }),
      ]);

      const userEight = lookupTrainingExerciseMedia(
        8, 8, ['bodyweight_squat', 'push_up'], 'en-US',
        { db, now: new Date('2026-07-12T12:00:00.000Z'), expectedExerciseIds: ['push_up'] },
      );
      expect(userEight?.items).toEqual([
        expect.objectContaining({
          kind: 'UNAVAILABLE', rawIdentifier: 'bodyweight_squat', reason: 'UNKNOWN_EXERCISE',
        }),
        expect.objectContaining({ kind: 'AVAILABLE', exerciseId: 'push_up' }),
      ]);
      expect(JSON.stringify(userEight)).not.toContain('tenant-7-manifest');
    } finally {
      db.close();
    }
  });

  it('rejects cross-scope review and takedown events before they can affect delivery', () => {
    const db = createMigratedTestDatabase();
    try {
      const global = seedApprovedExerciseMedia(db, {
        manifestId: 'global-manifest', manifestVersion: 'global-manifest.v1', exerciseId: 'push_up',
      });
      const tenant = seedApprovedExerciseMedia(db, {
        manifestId: 'tenant-7-manifest', manifestVersion: 'tenant-7-manifest.v1',
        scopeKey: 'tenant:7', exerciseId: 'bodyweight_squat',
      });
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_reviews (
          review_id, manifest_id, scope_key, asset_id, review_type, status,
          reviewer_ref, subject_content_hash, reason_codes_json,
          reviewed_at, expires_at, created_at
        ) VALUES ('tenant-review-of-global', ?, 'tenant:7', ?, 'DOMAIN', 'REJECTED',
          'tenant-reviewer', ?, '[]', '2026-07-12T11:00:00.000Z', NULL,
          '2026-07-12T11:00:00.000Z')
      `).run(tenant.manifestId, global.assetId, global.integritySha256))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(() => db.prepare(`
        INSERT INTO training_exercise_media_takedown_events (
          event_id, manifest_id, scope_key, asset_id, action, reason_code,
          authority_ref, replacement_asset_id, evidence_hash, effective_at, created_at
        ) VALUES ('tenant-takedown-of-global', ?, 'tenant:7', ?, 'REMOVE', 'TENANT_ONLY',
          'tenant-authority', NULL, ?, '2026-07-12T11:00:00.000Z',
          '2026-07-12T11:00:00.000Z')
      `).run(tenant.manifestId, global.assetId, 'a'.repeat(64)))
        .toThrow(/FOREIGN KEY constraint failed/i);
      expect(lookupTrainingExerciseMedia(
        8, 8, ['push_up'], 'en-US',
        { db, now: new Date('2026-07-12T12:00:00.000Z'), expectedExerciseIds: ['push_up'] },
      )?.items[0]).toMatchObject({ kind: 'AVAILABLE', exerciseId: 'push_up' });
    } finally {
      db.close();
    }
  });
});
