// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
} from '../../src/services/training-generation-observability';
import { runTrainingPlanRevisionShadowForLegacyRequest } from '../../src/services/training-plan-revision-shadow';

describe('training plan revision shadow computation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    _resetTrainingGenerationObservabilityForTests();
  });

  it('computes only from a complete supported input and writes no revision state', () => {
    withDatabaseForTest(db, () => {
      const outcome = runTrainingPlanRevisionShadowForLegacyRequest({
        scope: { userId: 7, tenantId: 7 },
        env: { TRAINING_PLAN_REVISION_V1_MODE: 'shadow' },
        body: {
          planMode: 'continuous', goalMode: 'general_fitness', discipline: 'strength',
          durationWeeks: 4, experienceLevel: 'novice', sessionsPerWeek: 3,
          sessionDurationMinutes: 30, availableDays: ['monday', 'wednesday', 'friday'],
          equipmentIds: [], location: 'home',
        },
      });
      expect(outcome).toMatchObject({ computed: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_profile_snapshots').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM event_outbox').get()).toEqual({ count: 0 });
      expect(getTrainingGenerationObservabilitySnapshot().counters.revision_shadow_candidate_succeeded_total).toBe(1);
    });
  });

  it('does no new computation when the mode is off', () => {
    const outcome = runTrainingPlanRevisionShadowForLegacyRequest({
      scope: { userId: 7, tenantId: 7 }, body: {}, env: { TRAINING_PLAN_REVISION_V1_MODE: 'off' },
    });
    expect(outcome).toEqual({ computed: false, reason: 'mode' });
    expect(getTrainingGenerationObservabilitySnapshot().counters.revision_shadow_candidate_succeeded_total).toBe(0);
    expect(getTrainingGenerationObservabilitySnapshot().counters.revision_shadow_candidate_skipped_total).toBe(0);
  });
});
