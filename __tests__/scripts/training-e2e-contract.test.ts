import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  assertTrainingE2EEvidenceComplete,
  buildLiveCalendarComposeOverride,
  buildRunScopedImageNames,
  resolveTrainingE2EStatePolicy,
  resolveTrainingE2EStatePath,
  TRAINING_E2E_REQUIRED_LIFECYCLE_STEP_IDS,
} from '../../scripts/lib/training-e2e-contract.mjs';
import {
  assertCrossTenantIsolationEvidence,
  assertCalendarCapacityEvidence,
  assertPersonaDeviceSessionBound,
  assertTrainingE2ECleanupResult,
  buildTrainingE2EPersonaScenarios,
  buildTrainingE2EPersonaProfiles,
  buildTrainingE2EPersonaFixtureSpec,
  classifyTrainingE2ESessionSport,
  comparePersistedSessionsToReadModel,
  ensurePersonaDevice,
  ensurePersonaUser,
  resolveQualityReadinessState,
  runTrainingE2EPersonaScenario,
  trainingE2EPersonaUserId,
  validateTrainingE2EPersonaProfiles,
} from '../../scripts/training-e2e-quality';
import {
  TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS,
} from '../../src/services/training-plan-creation-validation';
import { withDatabaseForTest } from '../../src/services/database';
import { getEffectiveEntitlement } from '../../src/services/entitlement';
import { QUESTIONNAIRES } from '../../src/services/onboarding';

const canonicalPersonaIds = TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((scenario) => scenario.id);
const requiredLifecycleStepIds = [
  'first_run_profile_blocker',
  'no_plan_home',
  'plan_preview',
  'plan_generate_activate',
  'today_plan_progress_read_models',
  'feedback_variants_and_repeated_skips',
  'proposal_first_fixture_reflow_activation',
  'stale_readiness_degraded',
  'calendar_sync_provider_safe',
  'cancel_cleanup_and_no_plan_recovery',
] as const;

function completeEvidence() {
  const runId = 'contract-test-run';
  const backendBaseUrl = 'http://127.0.0.1:18231';
  const generatedAt = '2026-08-03T12:00:00.000Z';
  const backendGit = {
    commit: 'a'.repeat(40),
    baseCommit: 'b'.repeat(40),
    dirtyTreeDiffSha256: 'c'.repeat(64),
  };
  const images = {
    backend: {
      name: `nexus-hub-node:training-e2e-${runId}`,
      builtImageId: `sha256:${'d'.repeat(64)}`,
      actualContainerImageId: `sha256:${'d'.repeat(64)}`,
    },
    contentEngine: {
      name: `nexus-hub-content-engine:training-e2e-${runId}`,
      builtImageId: `sha256:${'e'.repeat(64)}`,
      actualContainerImageId: `sha256:${'e'.repeat(64)}`,
    },
  };
  return {
    schemaVersion: 'training_e2e_contract.v3',
    runId,
    qualifying: true,
    backendBaseUrl,
    generatedAt,
    backendGit,
    images,
    lifecycleEvidence: {
      schemaVersion: 'training_e2e_flow.v2',
      runId,
      flowAttemptId: 'contract-flow-attempt-1',
      baseUrl: backendBaseUrl,
      backendBaseUrl,
      backendProvenance: {
        schemaVersion: 'training_e2e_backend_provenance.v1',
        environmentSchemaVersion: 'training_e2e_environment.v2',
        git: backendGit,
        images,
        verifiedAt: '2026-08-03T11:59:00.000Z',
      },
      steps: TRAINING_E2E_REQUIRED_LIFECYCLE_STEP_IDS.map((stepId) => ({
        step: stepId,
        status: 'pass' as const,
      })),
    },
    personas: TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.map((canonical, index) => ({
      personaId: canonical.id,
      planId: 80_000 + index,
      totalSessions: 4,
      qualityScore: 92,
      qualityVerdict: 'pass' as const,
      expectedSignals: canonical.requiredSignals,
      forbiddenConditions: canonical.failureConditions,
      signalEvidence: Object.fromEntries(canonical.requiredSignals.map((signal) => [
        signal,
        [`Concrete observed fact for ${signal}`],
      ])),
      status: 'pass' as const,
      previewStatus: 'preview',
      createStatus: 'created',
      cleanupStatus: 'cancelled',
      planReadModelMatch: true,
      providerFreeAgendaIsolation: true,
      providerOAuthRows: 0,
      providerEventMappings: 0,
      providerOwnershipRows: 0,
      authorizationScopeIsolation: {
        probes: [
          {
            boundary: 'foreign_user_same_tenant',
            foreignPlanId: 90_000 + index * 2,
            responseStatus: 200,
            responseCancelled: false,
            expectedOwnerUserId: 1_099_999,
            expectedOwnerTenantId: 1_000_010 + index,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
          {
            boundary: 'same_user_foreign_tenant',
            foreignPlanId: 90_001 + index * 2,
            responseStatus: 404,
            responseCancelled: null,
            expectedOwnerUserId: 1_000_010 + index,
            expectedOwnerTenantId: 1_099_999,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
        ],
      },
      cleanupProof: {
        clean: true,
        planRows: 0,
        weekRows: 0,
        sessionRows: 0,
        completionRows: 0,
        agendaRows: 0,
        ownershipRows: 0,
      },
      fixtureCleanupProof: completePersonaFixtureCleanupProof(),
      blockers: [],
      persistedPlanSessions: 4,
      readModelSessions: 4,
      secretaryAgendaRows: 0,
      preferredTimeUnavailableCount: canonical.id === 'calendar_conflicted' ? 1 : 0,
      busyWindowOverlapCount: 0,
      identityMismatches: [],
      weekNotes: [],
      scheduleReasonCodes: canonical.id === 'calendar_conflicted' ? ['calendar_busy_window'] : [],
      scheduleStatuses: canonical.id === 'calendar_conflicted'
        ? ['reflowed', 'scheduled', 'scheduled', 'scheduled']
        : ['scheduled', 'scheduled', 'scheduled', 'scheduled'],
      fixtureEvidence: {
        ...baselinePersonaFixtureEvidence(),
        userId: 1_000_010 + index,
        readiness: {
          ...baselinePersonaFixtureEvidence().readiness,
          fixture: canonical.id === 'fatigue_plateau'
            ? 'low_apple_health'
            : canonical.id === 'stale_wearable'
              ? 'stale_apple_health'
              : 'none',
          source: canonical.id === 'fatigue_plateau' || canonical.id === 'stale_wearable'
            ? 'apple_health'
            : 'estimated',
          dataAsOf: canonical.id === 'stale_wearable'
            ? '2026-08-01T10:00:00.000Z'
            : canonical.id === 'fatigue_plateau'
              ? '2026-08-03T11:30:00.000Z'
              : null,
          isStale: canonical.id === 'stale_wearable',
          healthRows: canonical.id === 'fatigue_plateau' || canonical.id === 'stale_wearable' ? 3 : 0,
        },
        adherence: {
          ...baselinePersonaFixtureEvidence().adherence,
          fixture: canonical.id === 'poor_adherence'
            ? 'repeated_skips'
            : canonical.id === 'fatigue_plateau'
              ? 'fatigue_overreach'
              : 'none',
          historyRows: canonical.id === 'poor_adherence' || canonical.id === 'fatigue_plateau' ? 3 : 0,
          skippedRows: canonical.id === 'poor_adherence' ? 3 : 0,
          completionRows: canonical.id === 'fatigue_plateau' ? 3 : 0,
        },
        calendar: {
          fixture: canonical.id === 'calendar_conflicted' ? 'busy_windows' : 'none',
          eventRows: canonical.id === 'calendar_conflicted' ? 14 : 0,
        },
      },
    })),
  };
}

function baselinePersonaFixtureEvidence() {
  return {
    userId: 1_000_010,
    profileTypes: ['fitness', 'triathlon-gym', 'triathlon-running', 'triathlon-cycling', 'triathlon-swim'],
    readiness: {
      fixture: 'none' as const,
      source: 'estimated',
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      recommendation: 'full_intensity',
      reasoning: 'Fixture readiness baseline.',
      score: 70,
      dataAsOf: null,
      isStale: false,
      healthRows: 0,
    },
    adherence: {
      fixture: 'none' as const,
      historyRows: 0,
      skippedRows: 0,
      completionRows: 0,
    },
    calendar: {
      fixture: 'none' as const,
      eventRows: 0,
    },
  };
}

function completePersonaFixtureCleanupProof() {
  return {
    clean: true as const,
    planRows: 0,
    weekRows: 0,
    sessionRows: 0,
    completionRows: 0,
    agendaRows: 0,
    ownershipRows: 0,
    profileRows: 0,
    healthRows: 0,
    calendarFixtureRows: 0,
    deviceRows: 0,
    subscriptionRows: 0,
    idempotencyRows: 0,
    oauthRows: 0,
    operationLockRows: 0,
    outboxRows: 0,
    apiCacheRows: 0,
    userRows: 0,
  };
}

function assertCompleteEvidence(evidence: ReturnType<typeof completeEvidence>): void {
  assertTrainingE2EEvidenceComplete(evidence, { personaIds: canonicalPersonaIds });
}

describe('Training E2E executable contract', () => {
  it('pins the complete §13 fixture-safe lifecycle vocabulary', () => {
    expect(TRAINING_E2E_REQUIRED_LIFECYCLE_STEP_IDS).toEqual(requiredLifecycleStepIds);
  });

  it('accepts an isolated IPv6 loopback backend URL', () => {
    const complete = completeEvidence();
    const backendBaseUrl = 'http://[::1]:18231';
    expect(() => assertCompleteEvidence({
      ...complete,
      backendBaseUrl,
      lifecycleEvidence: {
        ...complete.lifecycleEvidence,
        baseUrl: backendBaseUrl,
        backendBaseUrl,
      },
    })).not.toThrow();
  });

  it('builds the executable matrix from every canonical persona object', () => {
    const scenarios = buildTrainingE2EPersonaScenarios();

    expect(scenarios.map((scenario) => scenario.canonical.id)).toEqual(canonicalPersonaIds);
    expect(scenarios).toHaveLength(14);
    for (const scenario of scenarios) {
      expect(scenario.canonical).toBe(
        TRAINING_PLAN_QUALITY_PERSONA_SCENARIOS.find((candidate) => candidate.id === scenario.canonical.id),
      );
      expect(scenario.request.calendarSource).toBeNull();
    }
  });

  it('starts quality personas on a full week so frequency checks are weekday-stable', () => {
    const scenarios = buildTrainingE2EPersonaScenarios();

    // Stronger guarantee: `today` can leave fewer legal week-one days than a
    // six-day, no-two-a-day request. Partial-week shortfalls are covered by
    // the volume suite; this matrix must compare complete persona weeks.
    expect(scenarios.every((scenario) => scenario.request.startPolicy === 'next_full_week')).toBe(true);
  });

  it('declares the travel duration ceiling on the generic request contract', () => {
    const scenarios = new Map(buildTrainingE2EPersonaScenarios().map((scenario) => [
      scenario.canonical.id,
      scenario,
    ]));

    // The gym questionnaire duration is strength-specific. The request note
    // is the onboarding-reachable generic source consumed by endurance too.
    expect(scenarios.get('travel_week')?.request.notes).toMatch(/35-minute window/i);
    expect(scenarios.get('limited_time_week')?.request.notes).toMatch(/35-minute window/i);
  });

  it('classifies the canonical persisted ride type as cycling before title heuristics', () => {
    expect(classifyTrainingE2ESessionSport({
      sessionType: 'ride',
      title: 'Threshold Ride',
    })).toBe('cycling');
    expect(classifyTrainingE2ESessionSport({
      sessionType: 'ride',
      title: 'Tempo / Sweet Spot Ride',
    })).toBe('cycling');
    expect(classifyTrainingE2ESessionSport({
      sessionType: 'run',
      title: 'Tempo Run',
    })).toBe('running');
  });

  it('prepares onboarding-reachable string profiles and preserves beginner persona semantics', () => {
    const scenarios = buildTrainingE2EPersonaScenarios();
    const beginner = scenarios.find((scenario) => scenario.canonical.id === 'beginner_gym')!;
    const cycling = scenarios.find((scenario) => scenario.canonical.id === 'cycling_gym')!;
    const swim = scenarios.find((scenario) => scenario.canonical.id === 'swim_triathlon')!;
    const travel = scenarios.find((scenario) => scenario.canonical.id === 'travel_week')!;

    const beginnerProfiles = new Map(
      buildTrainingE2EPersonaProfiles(beginner).map((profile) => [profile.profileType, profile.data]),
    );
    expect(beginnerProfiles.get('fitness')).toMatchObject({
      weekly_frequency: '2-3 days',
    });
    expect(beginnerProfiles.get('triathlon-gym')).toMatchObject({
      training_age: '< 1 year',
      current_split: 'Full body',
      primary_goal: 'General fitness',
      session_duration_minutes: '60',
    });

    const cyclingProfile = new Map(
      buildTrainingE2EPersonaProfiles(cycling).map((profile) => [profile.profileType, profile.data]),
    ).get('triathlon-cycling')!;
    for (const field of ['ftp_watts', 'weekly_hours', 'primary_discipline', 'weekly_availability_days']) {
      expect(cyclingProfile[field]).toBeTruthy();
    }

    const swimProfile = new Map(
      buildTrainingE2EPersonaProfiles(swim).map((profile) => [profile.profileType, profile.data]),
    ).get('triathlon-swim')!;
    for (const field of ['experience', 'primary_stroke', 'pool_access', 'sessions_per_week']) {
      expect(swimProfile[field]).toBeTruthy();
    }

    const travelProfiles = new Map(
      buildTrainingE2EPersonaProfiles(travel).map((profile) => [profile.profileType, profile.data]),
    );
    expect(travelProfiles.get('fitness')).toMatchObject({
      available_equipment: 'Resistance bands',
    });
    expect(travelProfiles.get('triathlon-gym')).toMatchObject({
      equipment_access: 'Bodyweight only',
      session_duration_minutes: '35',
    });

    for (const scenario of scenarios) {
      const profiles = buildTrainingE2EPersonaProfiles(scenario);
      expect(validateTrainingE2EPersonaProfiles(profiles)).toEqual([]);
      for (const profile of profiles) {
        const requiredKeys = QUESTIONNAIRES[profile.profileType].steps
          .filter((step) => (step as typeof step & { required?: boolean }).required !== false)
          .map((step) => step.key);
        expect(
          requiredKeys.filter((key) => !Object.prototype.hasOwnProperty.call(profile.data, key)),
          `${scenario.canonical.id}.${profile.profileType} missing questionnaire fields`,
        ).toEqual([]);
        expect(
          Object.entries(profile.data).filter(([, value]) => typeof value !== 'string'),
          `${scenario.canonical.id}.${profile.profileType} must mirror answerStep string storage`,
        ).toEqual([]);
      }
    }
  });

  it('uses isolated reserved users and real fixture modes for stateful personas', () => {
    const scenarios = buildTrainingE2EPersonaScenarios();
    const userIds = scenarios.map((scenario, index) => trainingE2EPersonaUserId(index));
    expect(new Set(userIds).size).toBe(scenarios.length);
    expect(userIds.every((userId) => userId >= 1_000_000 && userId <= 1_099_999)).toBe(true);

    const specs = new Map(scenarios.map((scenario) => [
      scenario.canonical.id,
      buildTrainingE2EPersonaFixtureSpec(scenario),
    ]));
    expect(specs.get('poor_adherence')).toMatchObject({
      adherence: 'repeated_skips',
    });
    expect(specs.get('fatigue_plateau')).toMatchObject({
      readiness: 'low_apple_health',
      adherence: 'fatigue_overreach',
    });
    expect(specs.get('stale_wearable')).toMatchObject({
      readiness: 'stale_apple_health',
    });
    expect(specs.get('no_wearable')).toMatchObject({
      readiness: 'none',
    });
    expect(specs.get('calendar_conflicted')).toMatchObject({
      calendar: 'busy_windows',
      calendarCapacityState: 'limited_capacity',
    });
    expect(specs.get('travel_week')).toMatchObject({ equipmentState: 'limited' });
  });

  it('seeds an actually effective active Max entitlement', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE,
        email_verified INTEGER,
        username TEXT,
        first_name TEXT,
        language TEXT,
        timezone TEXT,
        tier TEXT,
        status TEXT,
        auth_provider TEXT,
        daily_message_limit INTEGER,
        daily_token_limit INTEGER,
        daily_cost_limit_usd REAL,
        created_at TEXT,
        last_active_at TEXT
      );
      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        plan TEXT NOT NULL,
        period TEXT NOT NULL,
        status TEXT NOT NULL,
        provider TEXT NOT NULL,
        current_period_start TEXT,
        current_period_end TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
    try {
      ensurePersonaUser(db, 1_000_010, 'beginner_gym');
      expect(db.prepare('SELECT tier, status FROM users WHERE id = ?').get(1_000_010)).toEqual({
        tier: 'max',
        status: 'active',
      });
      expect(db.prepare('SELECT plan, status, provider FROM subscriptions WHERE user_id = ?').get(1_000_010)).toEqual({
        plan: 'max',
        status: 'active',
        provider: 'stripe',
      });
      const entitlement = withDatabaseForTest(db, () => getEffectiveEntitlement(1_000_010));
      expect(entitlement).toMatchObject({
        plan: 'max',
        status: 'active',
        source: 'stripe',
        aiAccessAllowed: true,
        automationAllowed: true,
      });
    } finally {
      db.close();
    }
  });

  it('binds persona JWT sessions to the correct durable device and fails revoked or mismatched bindings', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE ios_devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        device_id TEXT NOT NULL UNIQUE,
        device_name TEXT,
        refresh_token TEXT,
        refresh_token_hash TEXT,
        previous_refresh_token_hash TEXT,
        last_active_at TEXT,
        created_at TEXT
      );
    `);
    try {
      const deviceId = ensurePersonaDevice(db, 1_000_010, 'beginner_gym');
      expect(() => assertPersonaDeviceSessionBound(db, 1_000_010, deviceId)).not.toThrow();

      db.prepare('DELETE FROM ios_devices WHERE device_id = ?').run(deviceId);
      expect(() => assertPersonaDeviceSessionBound(db, 1_000_010, deviceId)).toThrow(/revoked|missing/i);

      ensurePersonaDevice(db, 1_000_011, 'other_persona');
      const otherDeviceId = 'training-e2e-persona-other_persona-1000011';
      expect(() => assertPersonaDeviceSessionBound(db, 1_000_010, otherDeviceId)).toThrow(/mismatch|another user/i);
    } finally {
      db.close();
    }
  });

  it('compares exact persisted/read-model identity instead of accepting equal counts', () => {
    const persisted = [{
      id: 11,
      planId: 42,
      weekNumber: 1,
      lifecycleState: 'reflowed',
      sessionIdentityKey: 'session-key-11',
      sessionShapeHash: 'shape-hash-11',
      dayOfWeek: 'Tuesday',
      title: 'Tempo Run',
      sessionType: 'tempo_run',
      intensityText: null,
      scheduledStartAt: '2026-08-04T09:00:00.000Z',
      scheduledEndAt: '2026-08-04T09:35:00.000Z',
      scheduleTimeZone: 'Europe/Lisbon',
      durationMinutes: 35,
      preferredTimeUnavailable: true,
      exercises: [{ name: 'Tempo intervals', sets: 4 }],
    }];
    const exactPayload = {
      data: {
        plan: { id: 42, schedulingTimezone: 'Europe/Lisbon' },
        weeks: [{
          weekNumber: 1,
          sessions: [{
            id: '11',
            planId: '42',
            lifecycleState: 'reflowed',
            sessionIdentityKey: 'session-key-11',
            sessionShapeHash: 'shape-hash-11',
            day: 'Tuesday',
            title: 'Tempo Run',
            sessionType: 'tempo_run',
            intensityText: null,
            scheduledStartAt: '2026-08-04T09:00:00.000Z',
            scheduledEndAt: '2026-08-04T09:35:00.000Z',
            duration: 35,
            preferredTimeUnavailable: true,
            exercises: [{ sets: 4, name: 'Tempo intervals' }],
          }],
        }],
      },
    };
    expect(comparePersistedSessionsToReadModel(persisted, exactPayload)).toMatchObject({
      matches: true,
      mismatches: [],
      readModelSessions: 1,
    });

    const driftedPayload = structuredClone(exactPayload);
    driftedPayload.data.weeks[0].sessions[0] = {
      ...driftedPayload.data.weeks[0].sessions[0],
      id: '12',
      scheduledEndAt: '2026-08-04T10:35:00.000Z',
      duration: 95,
    };
    const drift = comparePersistedSessionsToReadModel(persisted, driftedPayload);
    expect(drift.matches).toBe(false);
    expect(drift.mismatches.join(' ')).toMatch(/session id|missing persisted|unexpected read-model|duration|end/i);
  });

  it('requires a real canonical displacement and rejects every fixture busy-window overlap', () => {
    expect(() => assertCalendarCapacityEvidence({
      preferredTimeUnavailableCount: 1,
      scheduleStatuses: ['reflowed'],
      busyWindowOverlapCount: 0,
    })).not.toThrow();
    expect(() => assertCalendarCapacityEvidence({
      preferredTimeUnavailableCount: 0,
      scheduleStatuses: ['scheduled'],
      busyWindowOverlapCount: 0,
    })).toThrow(/displacement|capacity/i);
    expect(() => assertCalendarCapacityEvidence({
      preferredTimeUnavailableCount: 1,
      scheduleStatuses: ['reflowed'],
      busyWindowOverlapCount: 1,
    })).toThrow(/overlap/i);
  });

  it('derives readiness quality state from the API evidence, not the persona label', () => {
    expect(resolveQualityReadinessState({
      source: 'apple_health',
      score: 32,
      isStale: false,
      reasonCode: null,
      recommendation: 'active_recovery',
    })).toBe('low_readiness');
    expect(resolveQualityReadinessState({
      source: 'apple_health',
      score: 91,
      isStale: true,
      reasonCode: null,
      recommendation: 'full_intensity',
    })).toBe('no_data');
    expect(resolveQualityReadinessState({
      source: 'estimated',
      score: 70,
      isStale: false,
      reasonCode: 'WEARABLE_INTEGRATION_MISSING',
      recommendation: 'full_intensity',
    })).toBe('no_data');
  });

  it('requires durable cleanup proof and never treats a bare 404 as cancellation success', () => {
    const clean = {
      clean: true,
      planRows: 0,
      weekRows: 0,
      sessionRows: 0,
      completionRows: 0,
      agendaRows: 0,
      ownershipRows: 0,
    };
    expect(() => assertTrainingE2ECleanupResult(
      { status: 200, payload: { data: { cancelled: true } } },
      clean,
    )).not.toThrow();
    expect(() => assertTrainingE2ECleanupResult(
      { status: 404, payload: { error: { code: 'NOT_FOUND' } } },
      { ...clean, clean: false, planRows: 1 },
    )).toThrow(/cleanup|planRows/i);
    expect(() => assertTrainingE2ECleanupResult(
      { status: 404, payload: { error: { code: 'NOT_FOUND' } } },
      clean,
    )).not.toThrow();
  });

  it('requires a denied cross-tenant mutation and durable foreign-plan preservation', () => {
    expect(() => assertCrossTenantIsolationEvidence({
      foreignPlanId: 99,
      responseStatus: 200,
      responseCancelled: false,
      ownerUserId: 1_099_999,
      ownerTenantId: 1_099_999,
      remainedOwnedByForeignUser: true,
      remainedActive: true,
    })).not.toThrow();
    expect(() => assertCrossTenantIsolationEvidence({
      foreignPlanId: 99,
      responseStatus: 200,
      responseCancelled: true,
      ownerUserId: 1_099_999,
      ownerTenantId: 1_099_999,
      remainedOwnedByForeignUser: false,
      remainedActive: false,
    })).toThrow(/cross-tenant|foreign/i);
  });

  it('rejects evidence missing any required lifecycle step or persona', () => {
    const complete = completeEvidence();
    expect(() => assertCompleteEvidence(complete)).not.toThrow();

    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: {
        ...complete.lifecycleEvidence,
        steps: complete.lifecycleEvidence.steps.filter((step) => step.step !== 'proposal_first_fixture_reflow_activation'),
      },
    })).toThrow(/proposal_first_fixture_reflow_activation/);

    expect(() => assertCompleteEvidence({
      ...complete,
      personas: complete.personas.filter((persona) => persona.personaId !== 'race_prep'),
    })).toThrow(/race_prep/);

    expect(() => assertCompleteEvidence({
      ...complete,
      qualifying: false,
    })).toThrow(/non-qualifying|resume/i);

    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: {
        ...complete.lifecycleEvidence,
        steps: complete.lifecycleEvidence.steps.map((step) => step.step === 'plan_preview'
          ? { ...step, status: 200 as any }
          : step),
      },
    })).toThrow(/plan_preview did not pass/);
  });

  it('binds lifecycle evidence to the exact run, URL, source digest, and image identities', () => {
    const complete = completeEvidence();
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: undefined as any,
    })).toThrow(/lifecycle.*missing|flow.*missing/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: { ...complete.lifecycleEvidence, runId: 'another-run' },
    })).toThrow(/lifecycle.*run|run.*mismatch/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: { ...complete.lifecycleEvidence, backendBaseUrl: 'http://127.0.0.1:18999' },
    })).toThrow(/lifecycle.*url|url.*mismatch/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: { ...complete.lifecycleEvidence, baseUrl: 'http://127.0.0.1:18998' },
    })).toThrow(/lifecycle.*url|url.*mismatch/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: {
        ...complete.lifecycleEvidence,
        backendProvenance: {
          ...complete.lifecycleEvidence.backendProvenance,
          git: {
            ...complete.lifecycleEvidence.backendProvenance.git,
            dirtyTreeDiffSha256: 'f'.repeat(64),
          },
        },
      },
    })).toThrow(/lifecycle.*source|dirty|digest|provenance/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      lifecycleEvidence: {
        ...complete.lifecycleEvidence,
        backendProvenance: {
          ...complete.lifecycleEvidence.backendProvenance,
          images: {
            ...complete.lifecycleEvidence.backendProvenance.images,
            backend: {
              ...complete.lifecycleEvidence.backendProvenance.images.backend,
              actualContainerImageId: `sha256:${'f'.repeat(64)}`,
            },
          },
        },
      },
    })).toThrow(/lifecycle.*image|image.*mismatch|provenance/i);
  });

  it('fails closed when required plan, count, quality, blocker, identity, or schedule proof is stripped', () => {
    const complete = completeEvidence();
    const first = complete.personas[0];
    const rest = complete.personas.slice(1);
    for (const field of [
      'planId',
      'totalSessions',
      'qualityScore',
      'qualityVerdict',
      'expectedSignals',
      'forbiddenConditions',
      'signalEvidence',
      'blockers',
      'persistedPlanSessions',
      'readModelSessions',
      'secretaryAgendaRows',
      'preferredTimeUnavailableCount',
      'busyWindowOverlapCount',
      'identityMismatches',
      'weekNotes',
      'scheduleReasonCodes',
      'scheduleStatuses',
    ] as const) {
      expect(() => assertCompleteEvidence({
        ...complete,
        personas: [{ ...first, [field]: undefined as any }, ...rest],
      }), field).toThrow();
    }

    for (const override of [
      { totalSessions: 5 },
      { qualityVerdict: 'fail' },
      { qualityScore: 101 },
      { blockers: ['unsafe output'] },
      { identityMismatches: ['title drift'] },
      { secretaryAgendaRows: 1 },
      { busyWindowOverlapCount: 1 },
      { scheduleStatuses: ['scheduled'] },
    ]) {
      expect(() => assertCompleteEvidence({
        ...complete,
        personas: [{ ...first, ...override } as typeof first, ...rest],
      })).toThrow();
    }
  });

  it('requires concrete signal facts with exact expected-signal key coverage', () => {
    const complete = completeEvidence();
    const first = complete.personas[0];
    const rest = complete.personas.slice(1);
    const [firstSignal] = first.expectedSignals;
    const missing = { ...first.signalEvidence };
    delete missing[firstSignal];
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{ ...first, signalEvidence: missing }, ...rest],
    })).toThrow(/signal.*evidence|coverage|missing/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        signalEvidence: { ...first.signalEvidence, [firstSignal]: [] },
      }, ...rest],
    })).toThrow(/signal.*fact|signal.*evidence|non-empty/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        signalEvidence: { ...first.signalEvidence, fabricated_extra: ['not expected'] },
      }, ...rest],
    })).toThrow(/signal.*coverage|unexpected|exact/i);
  });

  it('recomputes readiness freshness from generatedAt and dataAsOf', () => {
    const complete = completeEvidence();
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: complete.personas.map((persona) => persona.personaId === 'stale_wearable'
        ? {
            ...persona,
            fixtureEvidence: {
              ...persona.fixtureEvidence,
              readiness: {
                ...persona.fixtureEvidence.readiness,
                dataAsOf: '2026-08-03T11:30:00.000Z',
                isStale: true,
              },
            },
          }
        : persona),
    })).toThrow(/stale|freshness|dataAsOf/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: complete.personas.map((persona) => persona.personaId === 'fatigue_plateau'
        ? {
            ...persona,
            fixtureEvidence: {
              ...persona.fixtureEvidence,
              readiness: {
                ...persona.fixtureEvidence.readiness,
                dataAsOf: '2026-08-01T10:00:00.000Z',
                isStale: false,
              },
            },
          }
        : persona),
    })).toThrow(/stale|freshness|dataAsOf/i);
  });

  it('fails evidence on unsafe output, plan-agenda drift, provider state, or incomplete cleanup', () => {
    const complete = completeEvidence();
    const first = complete.personas[0];

    for (const override of [
      { blockers: ['generic plan'] },
      { planReadModelMatch: false },
      { providerFreeAgendaIsolation: false },
      { providerOAuthRows: 1 },
      { providerEventMappings: 1 },
      { providerOwnershipRows: 1 },
      { cleanupStatus: 'failed' },
    ]) {
      expect(() => assertCompleteEvidence({
        ...complete,
        personas: [{ ...first, ...override }, ...complete.personas.slice(1)],
      })).toThrow();
    }
  });

  it('fails closed when per-persona cross-tenant or durable cleanup proof is missing or dirty', () => {
    const complete = completeEvidence();
    const first = complete.personas[0];
    const rest = complete.personas.slice(1);

    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{ ...first, authorizationScopeIsolation: undefined as any }, ...rest],
    })).toThrow(/cross-tenant|isolation/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        authorizationScopeIsolation: {
          probes: first.authorizationScopeIsolation.probes.map((probe, index) => index === 0
            ? { ...probe, responseCancelled: undefined as any }
            : probe),
        },
      }, ...rest],
    })).toThrow(/isolation|shape|responseCancelled/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        authorizationScopeIsolation: {
          probes: first.authorizationScopeIsolation.probes.map((probe, index) => index === 0
            ? { ...probe, legacyOwnerUserId: probe.expectedOwnerUserId }
            : probe),
        },
      }, ...rest],
    })).toThrow(/isolation|shape|unexpected/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        authorizationScopeIsolation: {
          probes: first.authorizationScopeIsolation.probes.map((probe, index) => index === 0
            ? { ...probe, responseStatus: 200, responseCancelled: true }
            : probe),
        },
      }, ...rest],
    })).toThrow(/cross-tenant|isolation|cancelled/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{ ...first, cleanupProof: undefined as any }, ...rest],
    })).toThrow(/cleanup/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{ ...first, fixtureCleanupProof: undefined as any }, ...rest],
    })).toThrow(/fixture.*cleanup|cleanup.*fixture/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        fixtureCleanupProof: { ...first.fixtureCleanupProof, outboxRows: 1 },
      }, ...rest],
    })).toThrow(/fixture.*cleanup|outboxRows/i);
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: [{
        ...first,
        cleanupProof: { ...first.cleanupProof, clean: false, sessionRows: 1 },
      }, ...rest],
    })).toThrow(/cleanup|sessionRows/i);
  });

  it('rejects persona evidence that reuses a user or replaces durable fixture proof with labels', () => {
    const complete = completeEvidence();
    expect(() => assertCompleteEvidence({
      ...complete,
      personas: complete.personas.map((persona) => ({
        ...persona,
        fixtureEvidence: {
          ...persona.fixtureEvidence,
          userId: 1_000_010,
        },
      })),
    })).toThrow(/distinct|isolated|fixture user/i);

    expect(() => assertCompleteEvidence({
      ...complete,
      personas: complete.personas.map((persona) => persona.personaId === 'poor_adherence'
        ? {
            ...persona,
            fixtureEvidence: {
              ...persona.fixtureEvidence,
              adherence: { fixture: 'none', historyRows: 0, skippedRows: 0, completionRows: 0 },
            },
          }
        : persona),
    })).toThrow(/poor_adherence.*repeated_skips|skipped/i);
  });

  it('rejects pre-isolation v2 evidence even when its labels otherwise look complete', () => {
    expect(() => assertCompleteEvidence({
      ...completeEvidence(),
      schemaVersion: 'training_e2e_contract.v2',
    })).toThrow(/schema.*v3/i);
  });

  it('always cancels a generated persona plan when readback or scoring fails', async () => {
    const scenario = buildTrainingE2EPersonaScenarios()[0];
    const api = vi.fn(async (method: string, route: string) => {
      if (method === 'POST' && route === '/api/v1/training/plan/preview') {
        return { status: 200, payload: { data: { status: 'preview', blockers: [] } } };
      }
      if (method === 'POST' && route === '/api/v1/training/plan/generate') {
        return { status: 201, payload: { data: { planId: 42 } } };
      }
      if (method === 'GET' && route === '/api/v1/training/plan/weeks') {
        throw new Error('readback failed');
      }
      if (method === 'POST' && route === '/api/v1/training/plan/cancel') {
        return { status: 200, payload: { data: { cancelled: true } } };
      }
      throw new Error(`unexpected request ${method} ${route}`);
    });

    await expect(runTrainingE2EPersonaScenario({
      scenario,
      api,
      preparePersona: vi.fn(async () => baselinePersonaFixtureEvidence()),
      inspectIsolation: vi.fn(async () => ({
        providerOAuthRows: 0,
        providerEventMappings: 0,
        providerOwnershipRows: 0,
      })),
      inspectPlanAgenda: vi.fn(async () => ({
        matches: true,
        persistedPlanSessions: 1,
        readModelSessions: 1,
        secretaryAgendaRows: 0,
        preferredTimeUnavailableCount: 0,
        busyWindowOverlapCount: 0,
        identityMismatches: [],
        sessionIds: [11],
        weekNotes: [],
        scheduleReasonCodes: [],
        scheduleStatuses: [],
      })),
      inspectCleanup: vi.fn(async () => ({
        clean: true,
        planRows: 0,
        weekRows: 0,
        sessionRows: 0,
        completionRows: 0,
        agendaRows: 0,
        ownershipRows: 0,
      })),
      probeAuthorizationScopeIsolation: vi.fn(async () => ({
        probes: [
          {
            boundary: 'foreign_user_same_tenant' as const,
            foreignPlanId: 99,
            responseStatus: 404,
            responseCancelled: null,
            expectedOwnerUserId: 1_099_999,
            expectedOwnerTenantId: 1_000_010,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
          {
            boundary: 'same_user_foreign_tenant' as const,
            foreignPlanId: 100,
            responseStatus: 404,
            responseCancelled: null,
            expectedOwnerUserId: 1_000_010,
            expectedOwnerTenantId: 1_099_999,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
        ],
      })),
      cleanupPersonaFixtures: vi.fn(async () => completePersonaFixtureCleanupProof()),
    })).rejects.toThrow('readback failed');

    expect(api).toHaveBeenCalledWith(
      'POST',
      '/api/v1/training/plan/cancel',
      { planId: 42 },
      [200, 404, 409],
    );
  });

  it('reports the exact missing questionnaire when a quality persona profile is incomplete', async () => {
    const scenario = buildTrainingE2EPersonaScenarios().find(
      (candidate) => candidate.canonical.id === 'cycling_gym',
    )!;

    await expect(runTrainingE2EPersonaScenario({
      scenario,
      api: vi.fn(async () => ({
        status: 200,
        payload: {
          data: {
            needsProfile: true,
            requiredQuestionnaireId: 'triathlon-cycling',
            missingFields: [{ key: 'ftp_watts' }, { key: 'weekly_hours' }],
          },
        },
      })),
      preparePersona: vi.fn(async () => baselinePersonaFixtureEvidence()),
      inspectIsolation: vi.fn(async () => ({
        providerOAuthRows: 0,
        providerEventMappings: 0,
        providerOwnershipRows: 0,
      })),
      inspectPlanAgenda: vi.fn(async () => ({
        matches: true,
        persistedPlanSessions: 0,
        readModelSessions: 0,
        secretaryAgendaRows: 0,
        preferredTimeUnavailableCount: 0,
        busyWindowOverlapCount: 0,
        identityMismatches: [],
        sessionIds: [],
        weekNotes: [],
        scheduleReasonCodes: [],
        scheduleStatuses: [],
      })),
      inspectCleanup: vi.fn(async () => ({
        clean: true,
        planRows: 0,
        weekRows: 0,
        sessionRows: 0,
        completionRows: 0,
        agendaRows: 0,
        ownershipRows: 0,
      })),
      probeAuthorizationScopeIsolation: vi.fn(async () => ({
        probes: [
          {
            boundary: 'foreign_user_same_tenant' as const,
            foreignPlanId: 99,
            responseStatus: 404,
            responseCancelled: null,
            expectedOwnerUserId: 1_099_999,
            expectedOwnerTenantId: 1_000_010,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
          {
            boundary: 'same_user_foreign_tenant' as const,
            foreignPlanId: 100,
            responseStatus: 404,
            responseCancelled: null,
            expectedOwnerUserId: 1_000_010,
            expectedOwnerTenantId: 1_099_999,
            remainedOwnedByExpectedScope: true,
            remainedActive: true,
          },
        ],
      })),
      cleanupPersonaFixtures: vi.fn(async () => completePersonaFixtureCleanupProof()),
    })).rejects.toThrow(/triathlon-cycling.*ftp_watts.*weekly_hours/);
  });
});

describe('Training E2E environment isolation contract', () => {
  it('rejects an existing run directory unless resume is explicit and marks resume non-qualifying', () => {
    expect(() => resolveTrainingE2EStatePolicy({ exists: true, resume: false })).toThrow(/already exists/);
    expect(resolveTrainingE2EStatePolicy({ exists: false, resume: false })).toEqual({
      mode: 'fresh',
      qualifying: true,
    });
    expect(resolveTrainingE2EStatePolicy({ exists: true, resume: true })).toEqual({
      mode: 'resume',
      qualifying: false,
    });
  });

  it('requires resolved state paths to remain under the repository Training E2E root', () => {
    const root = path.resolve('/repo/.local/training-e2e');
    expect(resolveTrainingE2EStatePath(root, 'run-1')).toBe(path.join(root, 'run-1'));
    expect(() => resolveTrainingE2EStatePath(root, '../escape')).toThrow(/outside/);
    expect(() => resolveTrainingE2EStatePath(root, '/tmp/.local/training-e2e/run')).toThrow(/outside/);
  });

  it('derives run-scoped image names and never reuses the mutable default tags', () => {
    expect(buildRunScopedImageNames('training-e2e-run-42')).toEqual({
      backend: 'nexus-hub-node:training-e2e-training-e2e-run-42',
      contentEngine: 'nexus-hub-content-engine:training-e2e-training-e2e-run-42',
    });
  });

  it.each([
    {
      providers: ['google'] as const,
      present: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      absent: ['OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_TENANT_ID'],
    },
    {
      providers: ['outlook'] as const,
      present: ['OUTLOOK_CLIENT_ID', 'OUTLOOK_CLIENT_SECRET', 'OUTLOOK_TENANT_ID'],
      absent: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    },
  ])('emits only $providers live provider credentials', ({ providers, present, absent }) => {
    const override = buildLiveCalendarComposeOverride([...providers]);
    for (const name of present) expect(override).toContain(`${name}:`);
    for (const name of absent) expect(override).not.toContain(`${name}:`);
    expect(override).toContain('TRAINING_CALENDAR_WRITES_ENABLED: "true"');
    expect(override).toContain('TRAINING_CALENDAR_SYNC_ENABLED: "true"');
  });
});
