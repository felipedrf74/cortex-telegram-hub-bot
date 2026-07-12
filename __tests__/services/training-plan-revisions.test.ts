// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';
import {
  createTrainingPlanCandidateRevision,
  editTrainingPlanRevisionPreview,
  getScopedTrainingPlanRevision,
  getScopedTrainingProfileSnapshot,
  TrainingPlanRevisionError,
} from '../../src/services/training-plan-revisions';

const request: TrainingPlanCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice',
    sessionsPerWeek: 3,
    sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: [],
    location: 'home',
    preferences: [],
    exclusions: [],
  },
};

const activeEnv = {
  TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
  DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
  TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
};

describe('training-plan-revisions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrationsForTest(db);
  });

  it('creates one immutable candidate graph for an idempotent request', () => {
    withDatabaseForTest(db, () => {
      const first = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'candidate-1',
        request,
        env: activeEnv,
      });
      const replay = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'candidate-1',
        request,
        env: activeEnv,
      });

      expect(replay).toEqual(first);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_profile_snapshots').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_families').get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT family_key AS familyKey FROM training_plan_families').get())
        .toEqual({ familyKey: 'continuous:general_fitness' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 1 });
      expect(first.candidates[0]).toMatchObject({
        lifecycleState: 'CANDIDATE',
        approvalState: 'UNREVIEWED',
        document: { planMode: 'continuous', goal: 'general_fitness' },
      });
    });
  });

  it('encrypts the canonical snapshot and keeps plaintext indexes display-safe', () => {
    withDatabaseForTest(db, () => {
      const sensitiveRequest: TrainingPlanCandidateRequest = {
        ...request,
        profile: {
          ...request.profile,
          equipmentIds: ['rack'],
          preferences: ['secret-medical-note-sentinel'],
          exclusions: ['back_squat'],
        },
      };
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'encrypted-snapshot',
        request: sensitiveRequest, env: activeEnv,
      });
      const row = db.prepare(`
        SELECT encrypted_snapshot_body, snapshot_body_key_version,
               normalized_constraints_json, factor_evidence_json,
               display_factor_index_json
          FROM training_profile_snapshots
      `).get() as Record<string, string>;
      expect(row.encrypted_snapshot_body).not.toContain('secret-medical-note-sentinel');
      expect(JSON.stringify(row)).not.toContain('secret-medical-note-sentinel');
      expect(row.snapshot_body_key_version).toMatch(/^training-profile-snapshot-aes256gcm\.v1:[a-f0-9]{16}$/);
      const snapshot = getScopedTrainingProfileSnapshot(
        { userId: 7, tenantId: 7 }, created.profileSnapshotId, activeEnv,
      );
      expect(snapshot?.body.request).toEqual(sensitiveRequest);
      expect(JSON.parse(row.display_factor_index_json)).toEqual(expect.arrayContaining([
        expect.objectContaining({ inputKey: 'profile.equipmentIds', state: 'provided' }),
      ]));
      const plaintextSurface = JSON.stringify({
        revision: db.prepare(`
          SELECT revision_document_json, quality_report_json FROM training_plan_revisions
        `).get(),
        operation: db.prepare(`
          SELECT request_hash, response_json FROM training_plan_revision_operations
        `).get(),
        snapshotIndexes: {
          normalizedConstraints: row.normalized_constraints_json,
          factorEvidence: row.factor_evidence_json,
          displayFactors: row.display_factor_index_json,
        },
      });
      expect(plaintextSurface).not.toContain('secret-medical-note-sentinel');
      expect(plaintextSurface).not.toContain('back_squat');
      expect(created.candidates[0].causalFactors).toEqual(expect.arrayContaining([
        expect.objectContaining({ inputKey: 'profile.exclusions', inputValue: 1 }),
      ]));
    });
  });

  it('rejects arbitrary equipment and exclusion text before persistence', () => {
    withDatabaseForTest(db, () => {
      for (const profile of [
        { ...request.profile, equipmentIds: ['private-secret-equipment'] },
        { ...request.profile, exclusions: ['private-secret-exclusion'] },
      ]) {
        expect(() => createTrainingPlanCandidateRevision({
          scope: { userId: 7, tenantId: 7 }, idempotencyKey: `invalid-${Math.random()}`,
          request: { ...request, profile }, env: activeEnv,
        })).toThrow(/TRAINING_REVISION_(EQUIPMENT|EXCLUSION)_UNKNOWN/);
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_profile_snapshots').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_operations').get()).toEqual({ count: 0 });
    });
  });

  it('requires the dedicated snapshot key and binds ciphertext to its key fingerprint', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'fallback-key-rejected', request,
        env: {
          TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
          DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
          HEALTH_DATA_ENCRYPTION_KEY: 'legacy-health-fallback-key-that-is-long-enough',
        },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_UNAVAILABLE' }));

      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'dedicated-key', request,
        env: activeEnv,
      });
      expect(() => getScopedTrainingProfileSnapshot(
        { userId: 7, tenantId: 7 },
        created.profileSnapshotId,
        { ...activeEnv, TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'different-training-revision-key-000000000000' },
      )).toThrowError(expect.objectContaining({ code: 'TRAINING_PROFILE_SNAPSHOT_KEY_VERSION_UNSUPPORTED' }));
    });
  });

  it('rejects an idempotency key reused with different content', () => {
    withDatabaseForTest(db, () => {
      createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'same-key', request,
        env: activeEnv,
      });
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'same-key',
        request: { ...request, planMode: 'event_based' },
        env: activeEnv,
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_IDEMPOTENCY_KEY_REUSED' }));
    });
  });

  it('fails closed outside active mode and never writes in shadow', () => {
    withDatabaseForTest(db, () => {
      for (const value of [undefined, 'off', 'shadow', 'true']) {
        expect(() => createTrainingPlanCandidateRevision({
          scope: { userId: 7, tenantId: 7 }, idempotencyKey: `key-${value}`, request,
          env: value ? { TRAINING_PLAN_REVISION_V1_MODE: value } : {},
        })).toThrowError(TrainingPlanRevisionError);
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('enforces tenant and user scope on revision reads', () => {
    withDatabaseForTest(db, () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'scope-key', request,
        env: activeEnv,
      });
      const revisionId = created.candidates[0].revisionId;
      expect(getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, revisionId)).not.toBeNull();
      expect(getScopedTrainingPlanRevision({ userId: 7, tenantId: 10 }, revisionId)).toBeNull();
      expect(getScopedTrainingPlanRevision({ userId: 8, tenantId: 9 }, revisionId)).toBeNull();
    });
  });

  it('edits by minting a child revision and exact before/after differences', () => {
    withDatabaseForTest(db, () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'base', request,
        env: activeEnv,
      });
      const base = created.candidates[0];
      const preview = editTrainingPlanRevisionPreview({
        scope: { userId: 7, tenantId: 7 },
        revisionId: base.revisionId,
        expectedContentHash: base.contentHash,
        idempotencyKey: 'edit-1',
        edits: {
          sessionDurationMinutes: 45,
          availableDays: ['monday', 'wednesday', 'friday'],
        },
        rationale: 'More time is now available.',
        env: activeEnv,
      });

      expect(preview.currentRevision.revisionId).toBe(base.revisionId);
      expect(preview.proposedRevision.revisionId).not.toBe(base.revisionId);
      expect(preview.proposedRevision.parentRevisionId).toBe(base.revisionId);
      expect(preview.proposedRevision.revisionSequence).toBe(2);
      expect(preview.differences).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: 'weeklyStructure.sessionDurationMinutes', before: 30, after: 45 }),
      ]));
      expect(getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, base.revisionId)?.contentHash)
        .toBe(base.contentHash);
    });
  });

  it('mints a new snapshot and revision when explicit context changes without changing plan content', () => {
    withDatabaseForTest(db, () => {
      const first = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'context-home', request,
        env: activeEnv,
      }).candidates[0];
      const second = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'context-gym',
        request: { ...request, profile: { ...request.profile, location: 'gym' } },
        env: activeEnv,
      }).candidates[0];

      expect(second.contentHash).toBe(first.contentHash);
      expect(second.creationContextVersion).not.toBe(first.creationContextVersion);
      expect(second.profileSnapshotId).not.toBe(first.profileSnapshotId);
      expect(second.revisionId).not.toBe(first.revisionId);
      expect(second.revisionSequence).toBe(2);
      expect(db.prepare(`
        SELECT current_revision_id AS revisionId,
               current_profile_snapshot_id AS snapshotId,
               current_context_version AS contextVersion,
               pointer_version AS pointerVersion
          FROM training_plan_current_contexts
      `).get()).toEqual({
        revisionId: second.revisionId,
        snapshotId: second.profileSnapshotId,
        contextVersion: second.creationContextVersion,
        pointerVersion: 2,
      });
    });
  });

  it('fails closed for shared tenant scope before any revision write', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 9 }, idempotencyKey: 'shared-scope', request, env: activeEnv,
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_PLAN_REVISION_PERSONAL_SCOPE_REQUIRED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('does not treat a global active value as production enrollment', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'global-not-enrolled', request,
        env: {
          TRAINING_PLAN_REVISION_V1_MODE: 'active',
          DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
          TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
        },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_PLAN_REVISION_V1_NOT_ENROLLED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('does not generate a replacement candidate while any plan is active', () => {
    withDatabaseForTest(db, () => {
      db.prepare(`
        INSERT INTO fitness_training_plans (
          user_id, tenant_id, name, duration_weeks, start_date, end_date, status
        ) VALUES (7, 7, 'Existing plan', 4, '2026-07-01', '2026-07-28', 'active')
      `).run();
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'replacement-not-in-m1', request, env: activeEnv,
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_ACTIVE_PLAN_REPLACEMENT_NOT_IN_M1' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });
});
