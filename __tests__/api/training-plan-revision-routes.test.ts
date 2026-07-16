// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import http from 'node:http';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import express, { Router } from 'express';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import {
  consumeTrainingM4CapacityRefreshRateLimitForTests,
  registerTrainingPlanRevisionRoutes,
  resetTrainingM4CapacityRefreshRateLimitForTests,
  trainingPlanRevisionCapabilitiesForScope,
  type TrainingPlanRevisionRouteDependencies,
} from '../../src/api/routes/training-plan-revision-routes';
import {
  registerTrainingM4CapacityContextProvider,
  type TrainingM4AuthoritativeCapacityContext,
} from '../../src/services/training-m4-capacity-context';
import { refreshTrainingM4AuthoritativeCapacityContext } from '../../src/services/training-m4-capacity-snapshots';

const FULL_TRAINING_M4_ALLOWLIST = ['event_based', 'continuous', 'maintenance', 'return_to_training']
  .flatMap((mode) => ['running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon']
    .map((discipline) => `${mode}:${discipline}`))
  .join(',');

function authoritativeCapacityContext(
  overrides: Partial<TrainingM4AuthoritativeCapacityContext> = {},
): TrainingM4AuthoritativeCapacityContext {
  return {
    source: 'AUTHORITATIVE',
    contextVersion: `m4cap_${'1'.repeat(48)}`,
    windows: [{
      dayOfWeek: 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
      allowedDisciplines: ['running'],
    }],
    observedAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    profileSourceVersion: `m4profile_${'a'.repeat(64)}`,
    calendarEventSetHash: 'b'.repeat(64),
    calendarSources: ['google'],
    planStartDate: '2026-08-03',
    planEndDate: '2026-08-30',
    horizonWeeks: 4,
    conflictCount: 0,
    ...overrides,
  };
}

describe('Training plan revision API contracts', () => {
  let db: Database.Database;
  let server: http.Server;
  let baseUrl: string;
  let refreshCapacityContext: NonNullable<TrainingPlanRevisionRouteDependencies['refreshCapacityContext']>;
  const priorMode = process.env.TRAINING_PLAN_REVISION_V1_MODE;
  const priorEnrollment = process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7;
  const priorFlow = process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
  const priorSnapshotKey = process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
  const priorTypedWorkout = process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7;
  const priorM4Allowlist = process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7;
  const priorAdaptationMode = process.env.TRAINING_ADAPTATION_V1_MODE_USER_7;
  const priorExplicitCapacity = process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7;

  beforeEach(async () => {
    resetTrainingM4CapacityRefreshRateLimitForTests();
    db = createMigratedTestDatabase();
    refreshCapacityContext = refreshTrainingM4AuthoritativeCapacityContext;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).userId = Number(req.header('x-test-user') ?? 7);
      (req as any).tenantId = Number(req.header('x-test-tenant') ?? 7);
      next();
    });
    const router = Router();
    registerTrainingPlanRevisionRoutes(router, {
      refreshCapacityContext: (input) => refreshCapacityContext(input),
    });
    app.use(router);
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    resetTrainingM4CapacityRefreshRateLimitForTests();
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
    if (priorAdaptationMode === undefined) delete process.env.TRAINING_ADAPTATION_V1_MODE_USER_7;
    else process.env.TRAINING_ADAPTATION_V1_MODE_USER_7 = priorAdaptationMode;
    if (priorExplicitCapacity === undefined) delete process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7;
    else process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7 = priorExplicitCapacity;
  });

  it('exposes typed capabilities and a phase-aware revision read model only for an explicitly enabled scope', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
      process.env.TRAINING_ADAPTATION_V1_MODE_USER_7 = 'active';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:running';
      process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7 = 'true';
      process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-revision-test-encryption-key-0001';

      const capabilities = await (await fetch(`${baseUrl}/plan/revision-capabilities`)).json() as any;
      expect(capabilities.data).toMatchObject({
        typedWorkoutGenerationEnabled: true,
        typedGenerationSessionTypes: expect.arrayContaining(['easy_run', 'brick', 'rest']),
        typedGenerationPlanModes: ['event_based', 'continuous', 'maintenance', 'return_to_training'],
        adaptationMode: 'active',
        adaptationScopes: ['SESSION', 'WEEK', 'PHASE', 'FULL_PLAN'],
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

  it('exposes the complete public-beta bundle only to exact personal scopes and rolls back with the master', () => {
    const publicBeta = {
      TRAINING_PUBLIC_BETA_V1_ENABLED: 'true',
      TRAINING_PLAN_REVISION_V1_MODE: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED: 'true',
      TRAINING_ADAPTATION_V1_MODE: 'active',
      TRAINING_EXERCISE_IDENTITY_V1_MODE: 'active',
      TRAINING_EXERCISE_MEDIA_V1_ENABLED: 'true',
      TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
      DECISION_FLOW_V1_ENFORCE_ENABLED: 'false',
      TRAINING_PLAN_M4_ALLOWLIST: FULL_TRAINING_M4_ALLOWLIST,
      TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-public-beta-key-00000001',
      TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED: 'false',
    };

    const capabilities = trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, publicBeta);
    expect(capabilities).toMatchObject({
        mode: 'active',
        typedWorkoutGenerationEnabled: true,
        adaptationMode: 'active',
        m4CapacityPolicy: {
          authoritativeRefresh: { supported: true },
          activeM4CapacityRequirement: 'AUTHORITATIVE_ONLY',
          explicitUserEntrySupported: false,
        },
      });
    expect(capabilities?.m4AllowedPlanCombinations).toHaveLength(28);
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 9 }, publicBeta)).toBeNull();
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...publicBeta,
      TRAINING_PUBLIC_BETA_V1_ENABLED: 'false',
    })).toBeNull();
  });

  it('exposes only the effective strict scoped M4 mode/discipline combinations', () => {
    const base = {
      TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
      DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
    };
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, base))
      .toMatchObject({
        m4AllowedPlanCombinations: [],
        m4CapacityPolicy: {
          authoritativeRefresh: { supported: false },
          activeM4CapacityRequirement: 'AUTHORITATIVE_ONLY',
          explicitUserEntrySupported: false,
        },
      });
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7: 'true',
    })?.m4CapacityPolicy.explicitUserEntrySupported).toBe(false);
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

  it('advertises the effective adaptation mode and exposes scopes only when active', () => {
    const base = {
      TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
      DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7: 'true',
    };
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, base))
      .toMatchObject({ adaptationMode: 'off', adaptationScopes: [] });
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_ADAPTATION_V1_MODE_USER_7: 'shadow',
    })).toMatchObject({ adaptationMode: 'shadow', adaptationScopes: [] });
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_ADAPTATION_V1_MODE_USER_7: 'active',
    })).toMatchObject({ adaptationMode: 'off', adaptationScopes: [] });
    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...base,
      TRAINING_ADAPTATION_V1_MODE_USER_7: 'active',
      TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
    })).toMatchObject({
      adaptationMode: 'active',
      adaptationScopes: ['SESSION', 'WEEK', 'PHASE', 'FULL_PLAN'],
    });
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
        authoritativeRefresh: {
          supported: true,
          method: 'POST',
          path: '/plan/capacity-context/refresh',
          requiresIdempotencyKey: true,
          requiresAllConnectedProviders: true,
          providerWriteEffects: false,
          freshnessMinutes: 5,
          requestConstraints: {
            maxWindows: 7,
            uniqueWeekdays: true,
            singleTimezone: true,
          },
          rateLimit: {
            burstMaxRequests: 2,
            burstWindowSeconds: 60,
            totalMaxRequests: 6,
            totalWindowSeconds: 300,
          },
        },
        activeM4CapacityRequirement: 'AUTHORITATIVE_ONLY',
        explicitUserEntrySupported: false,
        explicitUserEntryProvisional: true,
        explicitUserCalendarConflictCoverage: 'UNAVAILABLE',
      });
    const unregister = registerTrainingM4CapacityContextProvider((scope) => scope.userId === 7 && scope.tenantId === 7
      ? authoritativeCapacityContext()
      : null);
    try {
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityContext)
        .toEqual(authoritativeCapacityContext());
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
    const unregisterExpired = registerTrainingM4CapacityContextProvider(() => authoritativeCapacityContext({
      contextVersion: `m4cap_${'2'.repeat(48)}`,
      observedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-02T00:00:00.000Z',
    }));
    try {
      expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, env)?.m4CapacityContext)
        .toBeUndefined();
    } finally {
      unregisterExpired();
    }

    expect(trainingPlanRevisionCapabilitiesForScope({ userId: 7, tenantId: 7 }, {
      ...env,
      TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7: 'true',
    })?.m4CapacityPolicy).toMatchObject({
      activeM4CapacityRequirement: 'AUTHORITATIVE_OR_EXPLICIT_USER',
      explicitUserEntrySupported: true,
    });
  });

  it('refreshes authoritative capacity only for an enabled exact personal M4 scope', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:running';
      const expected = authoritativeCapacityContext();
      let calls = 0;
      refreshCapacityContext = async (input) => {
        calls += 1;
        expect(input).toEqual({
          scope: { userId: 7, tenantId: 7 },
          idempotencyKey: 'capacity-refresh-api-1',
          request: {
            planStartDate: '2026-08-03',
            horizonWeeks: 4,
            profileWindows: expected.windows,
          },
        });
        return expected;
      };

      const response = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'capacity-refresh-api-1' },
        body: JSON.stringify({
          planStartDate: '2026-08-03',
          horizonWeeks: 4,
          profileWindows: expected.windows,
        }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        ok: true,
        data: {
          schemaVersion: 'training_m4_capacity_refresh.v1',
          mode: 'active',
          capacityContext: expected,
        },
      });
      expect(calls).toBe(1);

      const wrongScope = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'capacity-refresh-api-2',
          'x-test-user': '8',
          'x-test-tenant': '8',
        },
        body: JSON.stringify({
          planStartDate: '2026-08-03',
          horizonWeeks: 4,
          profileWindows: expected.windows,
        }),
      });
      expect(wrongScope.status).toBe(404);
      expect(calls).toBe(1);
    });
  });

  it('rate-limits expensive capacity refreshes per exact personal scope', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:running';
      const expected = authoritativeCapacityContext();
      let calls = 0;
      refreshCapacityContext = async () => {
        calls += 1;
        return expected;
      };
      const body = JSON.stringify({
        planStartDate: '2026-08-03',
        horizonWeeks: 4,
        profileWindows: expected.windows,
      });

      for (let index = 0; index < 2; index += 1) {
        const response = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': `capacity-limit-${index}` },
          body,
        });
        expect(response.status).toBe(201);
      }
      const limited = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'capacity-limit-2' },
        body,
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.json()).toMatchObject({
        ok: false,
        error: { code: 'TRAINING_M4_CAPACITY_REFRESH_RATE_LIMITED' },
      });
      expect(calls).toBe(2);

      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_8 = 'active';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8 = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_8 = 'event_based:running';
      try {
        const isolated = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'capacity-limit-user-8',
            'x-test-user': '8',
            'x-test-tenant': '8',
          },
          body,
        });
        expect(isolated.status).toBe(201);
        expect(calls).toBe(3);
      } finally {
        delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_8;
        delete process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8;
        delete process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_8;
      }

      resetTrainingM4CapacityRefreshRateLimitForTests();
      const afterReset = await fetch(`${baseUrl}/plan/capacity-context/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'capacity-limit-after-reset' },
        body,
      });
      expect(afterReset.status).toBe(201);
      expect(calls).toBe(4);
    });
  });

  it('enforces the six-per-five-minute refresh budget after allowing two-request JIT bursts', () => {
    const scope = { userId: 7, tenantId: 7 };
    const start = Date.parse('2026-07-14T10:00:00.000Z');
    for (const offsetMinutes of [0, 1, 2]) {
      expect(consumeTrainingM4CapacityRefreshRateLimitForTests(
        scope,
        start + offsetMinutes * 60_000,
      )).toEqual({ allowed: true });
      expect(consumeTrainingM4CapacityRefreshRateLimitForTests(
        scope,
        start + offsetMinutes * 60_000,
      )).toEqual({ allowed: true });
    }
    expect(consumeTrainingM4CapacityRefreshRateLimitForTests(scope, start + 3 * 60_000))
      .toEqual({ allowed: false, retryAfterSeconds: 120 });
    expect(consumeTrainingM4CapacityRefreshRateLimitForTests(scope, start + 5 * 60_000))
      .toEqual({ allowed: true });
  });

  it('coalesces an exact concurrent replay and rejects a different in-flight refresh without cross-tenant blocking', async () => {
    await withDatabaseForTestAsync(db, async () => {
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
      process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:running';
      process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_8 = 'active';
      process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8 = 'true';
      process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_8 = 'event_based:running';
      const expected = authoritativeCapacityContext();
      let calls = 0;
      let releaseUserSeven!: () => void;
      const userSevenRelease = new Promise<void>((resolve) => { releaseUserSeven = resolve; });
      let userSevenStarted!: () => void;
      const userSevenStart = new Promise<void>((resolve) => { userSevenStarted = resolve; });
      refreshCapacityContext = async (input) => {
        calls += 1;
        if (input.scope.userId === 7) {
          userSevenStarted();
          await userSevenRelease;
        }
        return expected;
      };
      const body = JSON.stringify({
        planStartDate: '2026-08-03', horizonWeeks: 4, profileWindows: expected.windows,
      });
      const request = (key: string, userId = 7, requestBody = body) => fetch(
        `${baseUrl}/plan/capacity-context/refresh`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': key,
            'x-test-user': String(userId),
            'x-test-tenant': String(userId),
          },
          body: requestBody,
        },
      );

      try {
        const first = request('capacity-concurrent-same');
        await userSevenStart;
        const same = request('capacity-concurrent-same');
        const differentKey = await request('capacity-concurrent-different');
        expect(differentKey.status).toBe(409);
        expect(await differentKey.json()).toMatchObject({
          ok: false,
          error: { code: 'TRAINING_M4_CAPACITY_REFRESH_IN_PROGRESS' },
        });
        const differentRequest = await request(
          'capacity-concurrent-same',
          7,
          JSON.stringify({
            planStartDate: '2026-08-03', horizonWeeks: 5, profileWindows: expected.windows,
          }),
        );
        expect(differentRequest.status).toBe(409);
        const isolated = await request('capacity-concurrent-user-8', 8);
        expect(isolated.status).toBe(201);
        expect(calls).toBe(2);
        releaseUserSeven();
        const [firstResponse, sameResponse] = await Promise.all([first, same]);
        expect(firstResponse.status).toBe(201);
        expect(sameResponse.status).toBe(201);
        expect(calls).toBe(2);
      } finally {
        releaseUserSeven();
        delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_8;
        delete process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_8;
        delete process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_8;
      }
    });
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
          adaptationMode: 'off',
          adaptationScopes: [],
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
      const correctionCases = db.prepare(`
        SELECT lifecycle, redacted_input_json AS redactedInput,
               evidence_references_json AS evidenceReferences
          FROM product_learning_cases
         WHERE tenant_id = 7 AND user_id = 7
         ORDER BY redacted_input_json
      `).all() as Array<{ lifecycle: string; redactedInput: string; evidenceReferences: string }>;
      expect(correctionCases).toHaveLength(2);
      expect(correctionCases.map((row) => JSON.parse(row.redactedInput))).toEqual([
        expect.objectContaining({ kind: 'capacity_conflict_accuracy', outcomeCode: 'corrected' }),
        expect.objectContaining({ kind: 'plan_correction', outcomeCode: 'user_corrected' }),
      ]);
      expect(correctionCases.every((row) => row.lifecycle === 'observed')).toBe(true);
      expect(JSON.stringify(correctionCases)).not.toContain('Availability changed.');
      expect(JSON.stringify(correctionCases)).not.toContain('sessionDurationMinutes');

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
