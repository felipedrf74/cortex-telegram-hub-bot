// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';
import {
  createTrainingPlanCandidateRevision as createTrainingPlanCandidateRevisionAtRuntime,
  editTrainingPlanRevisionPreview as editTrainingPlanRevisionPreviewAtRuntime,
  getScopedTrainingPlanRevision,
  getScopedTrainingProfileSnapshot,
  TrainingPlanRevisionError,
} from '../../src/services/training-plan-revisions';

const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');

function createTrainingPlanCandidateRevision(
  input: Parameters<typeof createTrainingPlanCandidateRevisionAtRuntime>[0],
) {
  return createTrainingPlanCandidateRevisionAtRuntime({
    ...input,
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

function editTrainingPlanRevisionPreview(
  input: Parameters<typeof editTrainingPlanRevisionPreviewAtRuntime>[0],
) {
  return editTrainingPlanRevisionPreviewAtRuntime({
    ...input,
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

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
  TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7: 'true',
  DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
  TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
};

describe('training-plan-revisions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
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
      expect(first.candidates[0].qualityReport.checks.some((check) =>
        check.code.startsWith('TYPED_'))).toBe(false);
    });
  });

  it('keeps retired revision-operation lease columns null', () => {
    withDatabaseForTest(db, () => {
      // Stronger guarantee: revision creation is one synchronous transaction, so a
      // durable-looking lease must never imply crash recovery that does not exist.
      db.exec(`
        CREATE TEMP TRIGGER reject_revision_operation_leases
        BEFORE INSERT ON training_plan_revision_operations
        WHEN NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'revision operation leases are retired');
        END;
      `);

      createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'candidate-without-dormant-lease',
        request,
        env: activeEnv,
      });

      expect(db.prepare(`
        SELECT lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt
          FROM training_plan_revision_operations
         WHERE idempotency_key = 'candidate-without-dormant-lease'
      `).get()).toEqual({ leaseOwner: null, leaseExpiresAt: null });
    });
  });

  it('persists typed workout validation evidence only for the explicitly enabled scope', () => {
    withDatabaseForTest(db, () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'typed-workout-validation',
        request,
        env: {
          ...activeEnv,
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
        },
      });
      const revision = created.candidates[0];
      expect(revision.document).toMatchObject({ schemaVersion: 'training-plan-revision.v2' });
      expect(revision.qualityReport.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'TYPED_CANONICAL_SESSION_COVERAGE' }),
        expect.objectContaining({ code: 'TYPED_PHASE_AND_WEEK_CONTIGUITY' }),
        expect.objectContaining({ code: 'TYPED_BLOCK_AND_PRESCRIPTION_VALIDATION' }),
      ]));
      const stored = db.prepare('SELECT quality_report_json AS quality FROM training_plan_revisions').get() as {
        quality: string;
      };
      expect(JSON.parse(stored.quality).qualityReport.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'TYPED_UNKNOWN_FALLBACK' }),
      ]));
    });
  });

  it('enters strict M4 validation when an allowlisted continuous strength request adds M4 fields', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'partial-m4-continuous-strength',
        request: { ...request, planStartDate: '2026-07-20' },
        env: {
          ...activeEnv,
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'continuous:strength',
        },
      })).toThrow(/TRAINING_M4_RESOURCE_ACCESS_REQUIRED/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get())
        .toEqual({ count: 0 });
    });
  });

  it('keeps an allowlisted M4-owned combination on the strict M4 contract', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'owned-m4-continuous-hybrid',
        request: { ...request, discipline: 'hybrid' },
        env: {
          ...activeEnv,
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'continuous:hybrid',
        },
      })).toThrow(/TRAINING_M4_PLAN_START_DATE_REQUIRED/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get())
        .toEqual({ count: 0 });
    });
  });

  it('persists and reads a phase-aware event revision through the immutable M1 snapshot tables', () => {
    withDatabaseForTest(db, () => {
      const eventRequest: TrainingPlanCandidateRequest = {
        planMode: 'event_based', goal: 'event_performance', discipline: 'triathlon', horizonWeeks: 10,
        planStartDate: '2026-07-27',
        event: { name: 'A-priority triathlon', date: '2026-10-04', priority: 'A', subtype: 'triathlon' },
        resourceAccess: {
          pool: true, bicycle: true, indoorTrainer: true,
          safeRunEnvironment: true, outdoorRideEnvironment: true,
        },
        capacity: {
          source: 'EXPLICIT_USER',
          windows: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'].map((dayOfWeek) => ({
            dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
            allowedDisciplines: ['running' as const, 'cycling' as const, 'swimming' as const, 'strength' as const],
          })),
        },
        goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['cycling', 'swimming'] },
        profile: {
          experienceLevel: 'intermediate', sessionsPerWeek: 5, sessionDurationMinutes: 60,
          availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
          equipmentIds: [], location: 'home', preferences: [], exclusions: [],
        },
      };
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'typed-event-revision',
        request: eventRequest,
        env: {
          ...activeEnv,
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
        },
      });
      const revision = created.candidates[0];
      expect(revision.documentSchemaVersion).toBe('training-plan-revision.v2');
      expect(revision.document).toMatchObject({
        planMode: 'event_based', discipline: 'triathlon',
        phases: [
          { phaseType: 'BASE' }, { phaseType: 'BUILD' }, { phaseType: 'PEAK' },
          { phaseType: 'TAPER' }, { phaseType: 'RACE' },
        ],
      });
      expect(getScopedTrainingPlanRevision({ userId: 7, tenantId: 7 }, revision.revisionId))
        .toEqual(revision);
      expect(db.prepare(`
        SELECT document_schema_version AS schemaVersion, revision_document_json AS document
          FROM training_plan_revisions WHERE revision_id = ?
      `).get(revision.revisionId)).toMatchObject({ schemaVersion: 'training-plan-revision.v2' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_profile_snapshots').get()).toEqual({ count: 1 });
    });
  });

  it('keeps typed plan families separated by discipline while preserving the M1 family key', () => {
    withDatabaseForTest(db, () => {
      createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm1-family', request, env: activeEnv,
      });
      createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'hybrid-family',
        request: {
          ...request,
          discipline: 'hybrid',
          horizonWeeks: 6,
          planStartDate: '2026-08-17',
          resourceAccess: {
            pool: false, bicycle: false, indoorTrainer: true,
            safeRunEnvironment: true, outdoorRideEnvironment: false,
          },
          capacity: {
            source: 'EXPLICIT_USER',
            windows: ['monday', 'wednesday', 'friday'].map((dayOfWeek) => ({
              dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '07:00', timezone: 'Europe/Lisbon',
              allowedDisciplines: ['running' as const, 'strength' as const, 'cycling' as const],
            })),
          },
          goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['strength'] },
        },
        env: {
          ...activeEnv,
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'continuous:hybrid',
        },
      });
      expect(db.prepare('SELECT family_key AS familyKey FROM training_plan_families ORDER BY family_key').all())
        .toEqual([
          { familyKey: 'continuous:general_fitness' },
          { familyKey: 'continuous:general_fitness:hybrid' },
        ]);
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
        request: { ...request, horizonWeeks: 5 },
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
