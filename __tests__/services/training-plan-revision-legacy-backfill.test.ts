// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import { runLegacyActivePlanBackfill } from '../../src/services/training-plan-revision-legacy-backfill';

describe('training-plan-revision legacy active backfill', () => {
  let db: Database.Database;
  const env = { TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001' };

  beforeEach(() => {
    db = createMigratedTestDatabase();
    const plan = db.prepare(`
      INSERT INTO fitness_training_plans (
        user_id, tenant_id, name, sport, goal, duration_weeks, status,
        start_date, end_date, preferences_json
      ) VALUES (7, 9, 'Existing active plan', 'strength', 'General fitness', 4, 'active',
        '2026-07-01', '2026-07-28', '{"availableDays":["Monday"]}')
    `).run();
    const week = db.prepare(`
      INSERT INTO training_weeks (plan_id, week_number, focus, volume_sessions, notes)
      VALUES (?, 1, 'base', 1, 'Do not change')
    `).run(plan.lastInsertRowid);
    const session = db.prepare(`
      INSERT INTO training_sessions (
        week_id, plan_id, tenant_id, day_of_week, session_type, title,
        exercises_json, duration_minutes, status
      ) VALUES (?, ?, 9, 'Monday', 'strength', 'Legacy session',
        '[{"name":"Bodyweight Squat","sets":3,"reps":"10"}]', 30, 'pending')
    `).run(week.lastInsertRowid, plan.lastInsertRowid);
    db.prepare(`
      INSERT INTO training_completions (
        session_id, plan_id, actual_exercises_json, rpe_overall, notes
      ) VALUES (?, ?, '[{"name":"Bodyweight Squat"}]', 7, 'Private completion note')
    `).run(session.lastInsertRowid, plan.lastInsertRowid);
    db.prepare(`
      INSERT INTO training_agenda_event_ownership (
        plan_id, plan_version, session_id, user_id, tenant_id,
        calendar_event_id, calendar_source, status
      ) VALUES (?, 1, ?, 7, 9, 'private-provider-event-id', 'google', 'active')
    `).run(plan.lastInsertRowid, session.lastInsertRowid);
    db.prepare(`
      INSERT INTO training_plan_adaptations (
        plan_id, adaptation_revision, scope, trigger_type,
        trigger_payload_json, science_policy_version
      ) VALUES (?, 1, 'plan', 'manual_test', '{"private":"health-context"}', 'test-policy')
    `).run(plan.lastInsertRowid);
  });

  it('rehearses without any writes and reports deterministic identities', () => {
    withDatabaseForTest(db, () => {
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      expect(rehearsal).toMatchObject({ mode: 'dry_run', total: 1, wouldApply: 1, applied: 0 });
      expect(rehearsal.plans[0]).toMatchObject({
        status: 'WOULD_APPLY',
        familyId: expect.stringMatching(/^trpf_legacy_/),
        revisionId: expect.stringMatching(/^trpr_legacy_/),
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get()).toEqual({ count: 0 });
    });
  });

  it('backfills LEGACY_ACTIVE records while leaving every legacy byte unchanged', () => {
    withDatabaseForTest(db, () => {
      const before = legacyRows();
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      const first = runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: rehearsal.digest,
      });
      expect(first).toMatchObject({ mode: 'apply', total: 1, wouldApply: 0, applied: 1 });
      expect(legacyRows()).toEqual(before);
      expect(db.prepare(`
        SELECT origin, lifecycle_state, approval_state FROM training_plan_revisions
      `).get()).toEqual({
        origin: 'LEGACY_BACKFILL', lifecycle_state: 'LEGACY_ACTIVE', approval_state: 'APPROVED',
      });
      expect(db.prepare(`
        SELECT projection_plan_id, pointer_version FROM training_active_plan_references
      `).get()).toEqual({ projection_plan_id: 1, pointer_version: 1 });
      expect(db.prepare('SELECT actor_type, approval_source FROM training_plan_revision_approvals').get()).toEqual({
        actor_type: 'system_migration', approval_source: 'LEGACY_EXISTING_COMMITMENT',
      });
      const revisionDocument = (db.prepare('SELECT revision_document_json AS document FROM training_plan_revisions')
        .get() as { document: string }).document;
      expect(revisionDocument).not.toContain('Private completion note');
      expect(revisionDocument).not.toContain('private-provider-event-id');
      expect(revisionDocument).not.toContain('health-context');
      expect(db.prepare('SELECT source_revision_id FROM fitness_training_plans').get())
        .toEqual({ source_revision_id: first.plans[0].revisionId });
      expect(db.prepare('SELECT source_revision_id, revision_week_key FROM training_weeks').get())
        .toMatchObject({ source_revision_id: first.plans[0].revisionId, revision_week_key: expect.stringMatching(/^legacy-week:/) });
      expect(db.prepare('SELECT source_revision_id, revision_session_key FROM training_sessions').get())
        .toMatchObject({ source_revision_id: first.plans[0].revisionId, revision_session_key: expect.stringMatching(/^legacy-session:/) });

      const replay = runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: first.digest,
      });
      expect(replay).toMatchObject({ total: 1, applied: 0, alreadyApplied: 1 });
      expect(legacyRows()).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 1 });
    });
  });

  it('maps multiple active legacy plans exactly once without changing active counts', () => {
    withDatabaseForTest(db, () => {
      db.prepare(`
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, sport, duration_weeks, status, start_date, end_date
        ) VALUES (7, 9, 'Second active plan', 'mobility', 2, 'active', '2026-08-01', '2026-08-14')
      `).run();
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      const result = runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: rehearsal.digest,
      });
      expect(result).toMatchObject({ total: 2, applied: 2, alreadyApplied: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM fitness_training_plans WHERE status = 'active'").get())
        .toEqual({ count: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get())
        .toEqual({ count: 2 });
      expect(db.prepare('SELECT COUNT(DISTINCT source_revision_id) AS count FROM fitness_training_plans').get())
        .toEqual({ count: 2 });
    });
  });

  it('replays as already applied after ordinary completion, calendar verification and adaptation activity', () => {
    withDatabaseForTest(db, () => {
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      const first = runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: rehearsal.digest,
      });
      const baselineRevisionId = first.plans[0].revisionId;
      const baselineContentHash = first.plans[0].contentHash;

      db.prepare(`
        INSERT INTO training_completions (
          session_id, plan_id, actual_exercises_json, rpe_overall, notes
        ) VALUES (1, 1, '[{"name":"Bodyweight Squat"}]', 6, 'Later completion')
      `).run();
      db.prepare("UPDATE training_sessions SET status = 'completed', updated_at = datetime('now', '+1 minute') WHERE id = 1").run();
      db.prepare("UPDATE training_agenda_event_ownership SET last_verified_at = datetime('now') WHERE plan_id = 1").run();
      db.prepare(`
        INSERT INTO training_plan_adaptations (
          plan_id, adaptation_revision, scope, trigger_type,
          trigger_payload_json, science_policy_version
        ) VALUES (1, 2, 'plan', 'later_activity', '{}', 'test-policy')
      `).run();
      db.prepare('UPDATE fitness_training_plans SET adaptation_revision = 2').run();

      const replayRehearsal = runLegacyActivePlanBackfill({
        mode: 'dry_run', scope: { userId: 7, tenantId: 9 },
      });
      expect(replayRehearsal).toMatchObject({ alreadyApplied: 1, wouldApply: 0 });
      expect(replayRehearsal.plans[0]).toMatchObject({
        revisionId: baselineRevisionId,
        contentHash: baselineContentHash,
      });
      const replay = runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: replayRehearsal.digest,
      });
      expect(replay).toMatchObject({ applied: 0, alreadyApplied: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_active_plan_references').get()).toEqual({ count: 1 });
    });
  });

  it('rejects replay when the immutable legacy prescription changes', () => {
    withDatabaseForTest(db, () => {
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: rehearsal.digest,
      });
      db.prepare("UPDATE training_sessions SET title = 'Mutated prescription title'").run();
      expect(() => runLegacyActivePlanBackfill({
        mode: 'dry_run', scope: { userId: 7, tenantId: 9 },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_LEGACY_BACKFILL_BASELINE_DRIFT' }));
    });
  });

  it('rejects a same-row legacy plan-version change without minting a second identity', () => {
    withDatabaseForTest(db, () => {
      const rehearsal = runLegacyActivePlanBackfill({ mode: 'dry_run', scope: { userId: 7, tenantId: 9 } });
      runLegacyActivePlanBackfill({
        mode: 'apply', scope: { userId: 7, tenantId: 9 }, env,
        expectedDigest: rehearsal.digest,
      });
      db.prepare('UPDATE fitness_training_plans SET plan_version = 2').run();
      expect(() => runLegacyActivePlanBackfill({
        mode: 'dry_run', scope: { userId: 7, tenantId: 9 },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_LEGACY_BACKFILL_BASELINE_DRIFT' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 1 });
    });
  });

  it('rejects a session whose tenant does not match its owning plan', () => {
    withDatabaseForTest(db, () => {
      db.prepare('UPDATE training_sessions SET tenant_id = 10').run();
      expect(() => runLegacyActivePlanBackfill({
        mode: 'dry_run', scope: { userId: 7, tenantId: 9 },
      })).toThrowError(expect.objectContaining({
        code: 'TRAINING_LEGACY_BACKFILL_ORPHAN_DETECTED',
      }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get())
        .toEqual({ count: 0 });
    });
  });

  function legacyRows() {
    const strip = (row: Record<string, any>) => {
      const { source_revision_id: _sourceRevisionId, revision_week_key: _weekKey, revision_session_key: _sessionKey, ...rest } = row;
      return rest;
    };
    return {
      plans: (db.prepare('SELECT * FROM fitness_training_plans ORDER BY id').all() as Array<Record<string, any>>).map(strip),
      weeks: (db.prepare('SELECT * FROM training_weeks ORDER BY id').all() as Array<Record<string, any>>).map(strip),
      sessions: (db.prepare('SELECT * FROM training_sessions ORDER BY id').all() as Array<Record<string, any>>).map(strip),
      completions: db.prepare('SELECT * FROM training_completions ORDER BY id').all(),
      calendarOwnership: db.prepare('SELECT * FROM training_agenda_event_ownership ORDER BY id').all(),
      adaptations: db.prepare('SELECT * FROM training_plan_adaptations ORDER BY id').all(),
    };
  }
});
