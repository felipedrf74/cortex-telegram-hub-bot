// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import http from 'node:http';
import express, { Router } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import {
  registerTrainingPlanRevisionRoutes,
  trainingPlanRevisionCapabilitiesForScope,
} from '../../src/api/routes/training-plan-revision-routes';
import { registerTrainingM4CapacityContextProvider } from '../../src/services/training-m4-capacity-context';

describe('Training plan revision API contracts', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;
  const priorMode = process.env.TRAINING_PLAN_REVISION_V1_MODE;
  const priorEnrollment = process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7;
  const priorFlow = process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
  const priorSnapshotKey = process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
  const priorTypedWorkout = process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7;
  const priorM4Allowlist = process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrationsForTest(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).userId = Number(req.header('x-test-user') ?? 7);
      (req as any).tenantId = Number(req.header('x-test-tenant') ?? 7);
      next();
    });
    const router = Router();
    registerTrainingPlanRevisionRoutes(router);
    app.use(router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    if (priorMode === undefined) delete process.env.TRAINING_PLAN_REVISION_V1_MODE;
    else process.env.TRAINING_PLAN_REVISION_V1_MODE = priorMode;
    if (priorEnrollment === undefined) delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7;
    else process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = priorEnrollment;
    if (priorFlow === undefined) delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    else process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = priorFlow;
    if (priorSnapshotKey === undefined) delete process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
    else process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = priorSnapshotKey;
    if (priorTypedWorkout === undefined) delete process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7;
    else process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = priorTypedWorkout;
    if (priorM4Allowlist === undefined) delete process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7;
    else process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = priorM4Allowlist;
  });

  it('exposes typed capabilities and a phase-aware revision read model only for an explicitly enabled scope', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:running';
      process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-revision-test-encryption-key-0001';

      const capabilities = await (await fetch(`${baseUrl}/plan/revision-capabilities`)).json() as any;
      expect(capabilities.data).toMatchObject({
        typedWorkoutGenerationEnabled: true,
        typedGenerationSessionTypes: expect.arrayContaining(['easy_run', 'brick', 'rest']),
        typedGenerationPlanModes: ['event_based', 'continuous', 'maintenance', 'return_to_training'],
      });
      expect(capabilities.data.typedGenerationSessionTypes).toHaveLength(21);

      const today = new Date();
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7));
      start.setUTCDate(start.getUTCDate() + ((8 - start.getUTCDay()) % 7));
      const eventDate = new Date(start.getTime() + 55 * 86_400_000);
      const planStartDate = start.toISOString().slice(0, 10);
      const targetEventDate = eventDate.toISOString().slice(0, 10);

      const response = await fetch(`${baseUrl}/plan/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'typed-event-api' },
        body: JSON.stringify({
          planMode: 'event_based', goal: 'event_performance', discipline: 'running', horizonWeeks: 8,
          planStartDate,
          event: { name: 'Target 10K', date: targetEventDate, priority: 'A', subtype: 'running_race' },
          resourceAccess: {
            pool: false, bicycle: false, indoorTrainer: false,
            safeRunEnvironment: true, outdoorRideEnvironment: false,
          },
          capacity: {
            source: 'EXPLICIT_USER',
            windows: ['monday', 'wednesday', 'friday', 'sunday'].map((dayOfWeek) => ({
              dayOfWeek, startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
              allowedDisciplines: ['running'],
            })),
          },
          goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: [] },
          profile: {
            experienceLevel: 'intermediate', sessionsPerWeek: 4, sessionDurationMinutes: 45,
            availableDays: ['monday', 'wednesday', 'friday', 'sunday'], equipmentIds: [], location: 'home',
          },
        }),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as any;
      const revision = body.data.candidateSet.candidates[0];
      expect(revision.documentSchemaVersion).toBe('training-plan-revision.v2');

      const read = await (await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}`)).json() as any;
      expect(read.data.reviewModel).toMatchObject({
        schemaVersion: 'training-plan-review-read-model.v1',
        revisionId: revision.revisionId,
        presentationMode: 'TYPED',
        phases: [
          { phaseType: 'BASE' }, { phaseType: 'BUILD' }, { phaseType: 'PEAK' },
          { phaseType: 'TAPER' }, { phaseType: 'RACE' },
        ],
      });
      expect(read.data.reviewModel.weeks[0].workouts.every((workout: any) =>
        workout.sessionTypeClassification === 'CANONICAL' && workout.fallbackUsed === false)).toBe(true);
    });
  });

  it('stays dark by default and in shadow mode', async () => {
    await withDatabaseForTestAsync(db, async () => {
      for (const mode of [undefined, 'shadow']) {
        if (mode === undefined) delete process.env.TRAINING_PLAN_REVISION_V1_MODE;
        else process.env.TRAINING_PLAN_REVISION_V1_MODE = mode;
        process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
        const response = await fetch(`${baseUrl}/plan/revision-capabilities`);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {})).toBeNull();
    });
  });

  it('exposes only the effective strict scoped M4 mode/discipline combinations', () => {
    const base = {
      TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
      DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
    };
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, base))
      .toMatchObject({ m4AllowedPlanCombinations: [] });
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_PLAN_M4_ALLOWLIST_TENANT_7: 'maintenance:running,event_based:marathon',
    })?.m4AllowedPlanCombinations).toEqual([
      { planMode: 'event_based', discipline: 'marathon' },
      { planMode: 'maintenance', discipline: 'running' },
    ]);
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_PLAN_M4_ALLOWLIST_TENANT_7: 'maintenance:running',
      TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
    })?.m4AllowedPlanCombinations).toEqual([
      { planMode: 'event_based', discipline: 'triathlon' },
    ]);
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon,unknown:*',
    })?.m4AllowedPlanCombinations).toEqual([]);
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 9 }, {
      ...base,
      TRAINING_PLAN_REVISION_V1_MODE_TENANT_9: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED_TENANT_9: 'true',
      TRAINING_PLAN_M4_ALLOWLIST_TENANT_9: 'maintenance:running',
    })).toBeNull();
  });

  it('exposes fresh authoritative capacity only to its exact personal scope', () => {
    const env = {
      TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
      TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:marathon',
      DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
    };
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityContext)
      .toBeUndefined();
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityPolicy)
      .toEqual({
        authoritativeContextAvailable: false,
        authoritativeClientModification: 'NARROW_ONLY',
        explicitUserEntrySupported: true,
        explicitUserEntryProvisional: true,
        explicitUserCalendarConflictCoverage: 'UNAVAILABLE',
      });
    const unregister = registerTrainingM4CapacityContextProvider((scope) => scope.userId === 7 && scope.tenantId === 7
      ? {
        source: 'AUTHORITATIVE',
        contextVersion: 'server-capacity-v1',
        windows: [{
          dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
          allowedDisciplines: ['running'],
        }],
        observedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      }
      : null);
    try {
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityContext)
        .toEqual({
          source: 'AUTHORITATIVE',
          contextVersion: 'server-capacity-v1',
          windows: [{
            dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
            allowedDisciplines: ['running'],
          }],
          observedAt: '2026-07-13T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityPolicy)
        .toMatchObject({ authoritativeContextAvailable: true });
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 8, tenantId: 8 }, {
        TRAINING_PLAN_REVISION_V1_MODE_USER_8: 'active',
        TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8: 'true',
        DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
      })?.m4CapacityContext).toBeUndefined();
    } finally {
      unregister();
    }
    const unregisterExpired = registerTrainingM4CapacityContextProvider(() => ({
      source: 'AUTHORITATIVE', contextVersion: 'expired-capacity-v1',
      windows: [{ dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon' }],
      observedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-02T00:00:00.000Z',
    }));
    try {
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityContext)
        .toBeUndefined();
    } finally {
      unregisterExpired();
    }
  });

  it('distinguishes active enrollment with a disabled Decision dependency from an absent rollout', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'false';

      for (const path of ['/plan/revision-capabilities', '/capabilities']) {
        const response = await fetch(`${baseUrl}${path}`);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          ok: false,
          error: {
            code: 'TRAINING_REVISION_EXECUTION_DEPENDENCY_DISABLED',
          },
        });
      }

      const mutation = await fetch(`${baseUrl}/plan/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'mixed-rollout-blocked' },
        body: JSON.stringify({}),
      });
      expect(mutation.status).toBe(404);
      expect(await mutation.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('serves explicit capabilities and versioned candidate/revision/edit envelopes in active mode', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-revision-test-encryption-key-0001';

      const capabilitiesResponse = await fetch(`${baseUrl}/plan/revision-capabilities`);
      expect(capabilitiesResponse.status).toBe(200);
      const capabilities = await capabilitiesResponse.json() as any;
      expect(capabilities).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 'training_plan_revision_api.v1',
          mode: 'active',
          registryVersion: 'training-workout-capabilities.v1',
          unknownFallback: { presentationFamily: 'unknown', preservesRawIdentifier: true },
        },
      });
      expect(capabilities.data.canonicalSessionTypes).toHaveLength(21);
      expect(capabilities.data.milestone1GenerationSessionTypes).toEqual([
        'strength_hypertrophy', 'strength_maintenance', 'mobility', 'rest',
      ]);
      expect((await fetch(`${baseUrl}/capabilities`)).status).toBe(200);
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }))
        .toMatchObject({ registryVersion: 'training-workout-capabilities.v1', mode: 'active' });

      const invalidCandidate = await fetch(`${baseUrl}/plan/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-invalid-candidate' },
        body: JSON.stringify({ planMode: 'event_based' }),
      });
      expect(invalidCandidate.status).toBe(400);

      const candidateResponse = await fetch(`${baseUrl}/plan/candidates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-candidate-1' },
        body: JSON.stringify({
          planMode: 'continuous', goal: 'general_fitness', discipline: 'strength', horizonWeeks: 4,
          profile: {
            experienceLevel: 'novice', sessionsPerWeek: 3, sessionDurationMinutes: 30,
            availableDays: ['monday', 'wednesday', 'friday'], equipmentIds: [], location: 'home',
          },
        }),
      });
      expect(candidateResponse.status).toBe(201);
      const candidate = await candidateResponse.json() as any;
      expect(candidate).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 'training_plan_revision_api.v1', mode: 'active',
          candidateSet: {
            candidateSetId: expect.any(String),
            profileSnapshotId: expect.any(String),
            comparison: { kind: 'SINGLE_CANDIDATE' },
            candidates: [expect.objectContaining({
              origin: 'GENERATED', lifecycleState: 'PENDING_REVIEW', approvalState: 'PENDING',
              decisionId: expect.any(String), documentSchemaVersion: 'training-plan-revision.v1',
            })],
          },
        },
      });
      const revision = candidate.data.candidateSet.candidates[0];

      const revisionResponse = await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}`);
      expect(revisionResponse.status).toBe(200);
      expect(revisionResponse.headers.get('etag')).toBe(`"${revision.contentHash}"`);
      expect(await revisionResponse.json()).toMatchObject({
        data: { schemaVersion: 'training_plan_revision_api.v1', revision: { revisionId: revision.revisionId } },
      });

      const wrongScope = await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}`, {
        headers: { 'x-test-user': '8', 'x-test-tenant': '8' },
      });
      expect(wrongScope.status).toBe(404);

      const editResponse = await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}/edit-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-edit-1' },
        body: JSON.stringify({
          expectedContentHash: revision.contentHash,
          edits: { sessionDurationMinutes: 45 },
          rationale: 'Availability changed.',
        }),
      });
      expect(editResponse.status).toBe(201);
      const editPayload = await editResponse.json() as any;
      expect(editPayload).toMatchObject({
        data: {
          schemaVersion: 'training_plan_revision_api.v1',
          editPreview: {
            approvalRequired: true,
            currentRevision: { revisionId: revision.revisionId },
            proposedRevision: {
              parentRevisionId: revision.revisionId,
              revisionSequence: 2,
              lifecycleState: 'PENDING_REVIEW',
              approvalState: 'PENDING',
              decisionId: expect.any(String),
            },
            differences: expect.arrayContaining([
              expect.objectContaining({ path: 'weeklyStructure.sessionDurationMinutes', before: 30, after: 45 }),
            ]),
          },
        },
      });
      expect(db.prepare(`
        SELECT lifecycle_state, approval_state FROM training_plan_revisions WHERE revision_id = ?
      `).get(revision.revisionId)).toEqual({ lifecycle_state: 'SUPERSEDED', approval_state: 'EXPIRED' });
      expect(db.prepare('SELECT status FROM notification_center_items WHERE item_id = ?').get(revision.decisionId))
        .toEqual({ status: 'superseded' });

      const editReplayResponse = await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}/edit-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-edit-1' },
        body: JSON.stringify({
          expectedContentHash: revision.contentHash,
          edits: { sessionDurationMinutes: 45 },
          rationale: 'Availability changed.',
        }),
      });
      expect(editReplayResponse.status).toBe(201);
      const editReplayPayload = await editReplayResponse.json() as any;
      expect(editReplayPayload.data.editPreview.proposedRevision.revisionId)
        .toBe(editPayload.data.editPreview.proposedRevision.revisionId);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 2 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 2 });

      const missingExpected = await fetch(`${baseUrl}/plan/revisions/${revision.revisionId}/edit-preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'api-edit-missing-version' },
        body: JSON.stringify({ edits: { sessionDurationMinutes: 60 }, rationale: 'Missing version.' }),
      });
      expect(missingExpected.status).toBe(428);
      expect(await missingExpected.json()).toMatchObject({
        ok: false, error: { code: 'TRAINING_EXPECTED_CONTENT_HASH_REQUIRED' },
      });

      const activeResponse = await fetch(`${baseUrl}/plan/active-revision`);
      expect(activeResponse.status).toBe(200);
      expect(await activeResponse.json()).toMatchObject({
        data: { schemaVersion: 'training_plan_revision_api.v1', activeReference: null },
      });
    });
  });
});
