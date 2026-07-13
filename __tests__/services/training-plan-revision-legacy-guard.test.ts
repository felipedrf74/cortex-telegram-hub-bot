// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import {
  assertLegacyPlanGenerationAllowed,
  assertLegacyPlanMutationAllowed,
  assertLegacySessionMutationAllowed,
  assertLegacyWeekMutationAllowed,
} from '../../src/services/training-plan-revision-legacy-guard';

describe('training revision legacy mutation guard', () => {
  let db: Database.Database;
  let planId: number;
  let weekId: number;
  let sessionId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrationsForTest(db);
    planId = Number(db.prepare(`
      INSERT INTO fitness_training_plans (
        user_id, tenant_id, name, duration_weeks, start_date, end_date, status
      ) VALUES (7, 7, 'Plan', 4, '2026-07-01', '2026-07-28', 'active')
    `).run().lastInsertRowid);
    weekId = Number(db.prepare(`
      INSERT INTO training_weeks (plan_id, week_number) VALUES (?, 1)
    `).run(planId).lastInsertRowid);
    sessionId = Number(db.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, tenant_id, day_of_week, session_type, title
      ) VALUES (?, ?, 7, 'Monday', 'strength', 'Session')
    `).run(weekId, planId).lastInsertRowid);
  });

  it('does not query or alter legacy behavior in off and shadow modes', () => {
    withDatabaseForTest(db, () => {
      for (const mode of ['off', 'shadow']) {
        const env = { TRAINING_PLAN_REVISION_V1_MODE: mode };
        expect(() => assertLegacyPlanGenerationAllowed({ userId: 7, tenantId: 7 }, env)).not.toThrow();
        expect(() => assertLegacyPlanMutationAllowed({ userId: 7, tenantId: 7 }, planId, env)).not.toThrow();
      }
      expect(() => assertLegacyPlanMutationAllowed(
        { userId: 7, tenantId: 7 }, planId,
        { TRAINING_PLAN_REVISION_V1_MODE: 'active' },
      )).not.toThrow();
    });
  });

  it('blocks every legacy mutation target once a projection is revision-owned', () => {
    withDatabaseForTest(db, () => {
      const env = { TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active' };
      db.prepare("UPDATE fitness_training_plans SET source_revision_id = 'revision-1' WHERE id = ?").run(planId);
      for (const operation of [
        () => assertLegacyPlanGenerationAllowed({ userId: 7, tenantId: 7 }, env),
        () => assertLegacyPlanMutationAllowed({ userId: 7, tenantId: 7 }, planId, env),
        () => assertLegacyWeekMutationAllowed({ userId: 7, tenantId: 7 }, weekId, env),
        () => assertLegacySessionMutationAllowed({ userId: 7, tenantId: 7 }, sessionId, env),
      ]) {
        expect(operation).toThrowError(expect.objectContaining({
          code: 'TRAINING_REVISION_MANAGED_LEGACY_MUTATION_BLOCKED',
        }));
      }
    });
  });
});
