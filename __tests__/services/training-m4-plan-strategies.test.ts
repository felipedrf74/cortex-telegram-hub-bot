// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import {
  buildTrainingPlanRevisionCandidate as buildTrainingPlanRevisionCandidateAtRuntime,
  type TrainingPlanCandidateRequest,
} from '../../src/services/training-plan-revision-candidate-builder';
import { validateTrainingM4PlanRevisionDocument } from '../../src/services/training-typed-plan-generator';
import { createTrainingPlanCandidateRevision as createTrainingPlanCandidateRevisionAtRuntime } from '../../src/services/training-plan-revisions';
import {
  getTrainingM4Allowlist,
  isTrainingM4PlanCombinationAllowed,
  TRAINING_M4_PUBLIC_BETA_COMBINATIONS,
} from '../../src/services/runtime-flags';
import {
  trainingM4ConflictSetHashForDocument,
  selectTrainingM4CapacityWindow,
  selectTrainingM4SessionTypes,
  validateTrainingM4CapacityWindowShapes,
  validateTrainingM4InitialScheduleFreshness,
} from '../../src/services/training-m4-plan-strategies';

it('skips a nominally large pre-gap window that cannot schedule on the DST date', () => {
  const workout = {
    dayOfWeek: 'sunday' as const,
    sessionType: 'easy_run',
    plannedDurationMinutes: 60,
  };
  const selected = selectTrainingM4CapacityWindow('running', [
    { dayOfWeek: 'sunday', startTime: '00:00', endTime: '01:00', timezone: 'Europe/Lisbon' },
    { dayOfWeek: 'sunday', startTime: '02:00', endTime: '03:00', timezone: 'Europe/Lisbon' },
  ], workout, '2026-03-29');

  expect(selected).toMatchObject({ startTime: '02:00', endTime: '03:00' });
});

const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');

function buildTrainingPlanRevisionCandidate(
  request: Parameters<typeof buildTrainingPlanRevisionCandidateAtRuntime>[0],
  options: Parameters<typeof buildTrainingPlanRevisionCandidateAtRuntime>[1] = {},
) {
  return buildTrainingPlanRevisionCandidateAtRuntime(request, {
    ...options,
    env: {
      TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED: 'true',
      ...options.env,
    },
    referenceTime: options.referenceTime ?? FIXED_NOW,
  });
}

function createTrainingPlanCandidateRevision(
  input: Parameters<typeof createTrainingPlanCandidateRevisionAtRuntime>[0],
) {
  return createTrainingPlanCandidateRevisionAtRuntime({
    ...input,
    env: {
      TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED: 'true',
      ...input.env,
    },
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

const eventRequest: TrainingPlanCandidateRequest = {
  planMode: 'event_based',
  goal: 'event_performance',
  discipline: 'triathlon',
  planStartDate: '2026-08-17',
  horizonWeeks: 12,
  event: {
    name: 'Reviewed A-priority triathlon',
    date: '2026-11-08',
    priority: 'A',
    subtype: 'triathlon',
  },
  resourceAccess: {
    pool: true,
    bicycle: true,
    indoorTrainer: true,
    safeRunEnvironment: true,
    outdoorRideEnvironment: true,
  },
  capacity: {
    source: 'EXPLICIT_USER',
    windows: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'].map((dayOfWeek) => ({
      dayOfWeek: dayOfWeek as 'monday',
      startTime: '06:00',
      endTime: '08:00',
      timezone: 'Europe/Lisbon',
      allowedDisciplines: dayOfWeek === 'monday'
        ? ['running' as const]
        : dayOfWeek === 'tuesday'
          ? ['cycling' as const]
          : dayOfWeek === 'thursday'
            ? ['swimming' as const]
            : dayOfWeek === 'saturday'
              ? ['strength' as const]
              : ['swimming' as const, 'cycling' as const, 'running' as const],
    })),
  },
  goalPriority: {
    primaryDiscipline: 'running',
    secondaryDisciplines: ['cycling', 'swimming'],
  },
  profile: {
    experienceLevel: 'intermediate',
    sessionsPerWeek: 5,
    sessionDurationMinutes: 60,
    availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
    equipmentIds: [],
    location: 'home',
    preferences: [],
    exclusions: [],
  },
};

describe('training M4 deterministic strategies and conflict foundation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  it('keeps the exact mode/discipline allowlist default-off and scope-overridable', () => {
    expect(getTrainingM4Allowlist({})).toEqual([]);
    expect(getTrainingM4Allowlist({ TRAINING_PLAN_M4_ALLOWLIST: '*:*,event_based:triathlon,bad' }))
      .toEqual([]);
    expect(isTrainingM4PlanCombinationAllowed('event_based', 'triathlon', {
      TRAINING_PLAN_M4_ALLOWLIST: 'maintenance:running',
      TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
    }, { userId: 7, tenantId: 7 })).toBe(true);
    expect(isTrainingM4PlanCombinationAllowed('maintenance', 'running', {
      TRAINING_PLAN_M4_ALLOWLIST: 'maintenance:running',
      TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
    }, { userId: 7, tenantId: 7 })).toBe(false);
  });

  it('successfully generates every one of the 28 combinations advertised by the public-beta bundle', () => {
    const modes = ['event_based', 'continuous', 'maintenance', 'return_to_training'] as const;
    const disciplines = ['running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon'] as const;
    const goals = {
      event_based: 'event_performance',
      continuous: 'general_fitness',
      maintenance: 'maintenance',
      return_to_training: 'return_to_training',
    } as const;
    const eventSubtypes = {
      running: 'running_race',
      cycling: 'cycling_event',
      swimming: 'open_water_swim',
      strength: 'hybrid_event',
      triathlon: 'triathlon',
      hybrid: 'hybrid_event',
      marathon: 'marathon',
    } as const;
    const generated: string[] = [];

    for (const planMode of modes) {
      for (const discipline of disciplines) {
        const sessionsPerWeek = planMode === 'return_to_training' ? 3 : 4;
        const availableDays = (sessionsPerWeek === 3
          ? ['monday', 'wednesday', 'sunday']
          : ['monday', 'wednesday', 'friday', 'sunday']) as Array<'monday' | 'wednesday' | 'friday' | 'sunday'>;
        const goalPriority = discipline === 'triathlon'
          ? { primaryDiscipline: 'running' as const, secondaryDisciplines: ['cycling' as const, 'swimming' as const] }
          : discipline === 'hybrid'
            ? { primaryDiscipline: 'running' as const, secondaryDisciplines: ['strength' as const] }
            : { primaryDiscipline: discipline, secondaryDisciplines: [] };
        const request: TrainingPlanCandidateRequest = {
          planMode,
          goal: goals[planMode],
          discipline,
          planStartDate: '2026-08-03',
          horizonWeeks: planMode === 'event_based' ? 5 : 6,
          ...(planMode === 'event_based' ? {
            event: {
              name: `Reviewed ${discipline} event`,
              date: '2026-09-06',
              priority: 'A' as const,
              subtype: eventSubtypes[discipline],
            },
          } : {}),
          resourceAccess: {
            pool: true,
            bicycle: true,
            indoorTrainer: true,
            safeRunEnvironment: true,
            outdoorRideEnvironment: true,
          },
          capacity: {
            source: 'EXPLICIT_USER',
            windows: availableDays.map((dayOfWeek) => ({
              dayOfWeek,
              startTime: '06:00',
              endTime: '10:00',
              timezone: 'Europe/Lisbon',
              allowedDisciplines: [...disciplines],
            })),
          },
          goalPriority,
          profile: {
            experienceLevel: 'intermediate',
            sessionsPerWeek,
            sessionDurationMinutes: 60,
            availableDays,
            equipmentIds: [],
            location: 'home',
            preferences: [],
            exclusions: [],
          },
        };
        const candidate = buildTrainingPlanRevisionCandidate(request, {
          typedWorkoutValidationEnabled: true,
          m4StrategyEnabled: true,
          scope: { userId: 7, tenantId: 7 },
          referenceTime: new Date('2026-07-14T10:00:00.000Z'),
        });
        expect(candidate.document).toMatchObject({
          planMode,
          discipline,
          m4: { strategyVersion: 'training-m4-plan-strategy.v1' },
        });
        generated.push(`${planMode}:${discipline}`);
      }
    }

    expect(generated.sort()).toEqual([...TRAINING_M4_PUBLIC_BETA_COMBINATIONS].sort());
  });

  it('rejects provisional explicit-user capacity unless its independent scope flag is enabled', () => {
    expect(() => buildTrainingPlanRevisionCandidateAtRuntime(eventRequest, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      scope: { userId: 7, tenantId: 7 },
      env: {},
      referenceTime: FIXED_NOW,
    })).toThrow(/TRAINING_M4_EXPLICIT_USER_CAPACITY_DISABLED/);
  });

  it('derives event horizon and creates exactly one date-bound triathlon race workout', () => {
    const candidate = buildTrainingPlanRevisionCandidate(eventRequest, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
    });
    const document = candidate.document;
    const eventWorkouts = document.weeks.flatMap((week) => week.workouts)
      .filter((workout) => workout.eventRole === 'EVENT');
    expect(document).toMatchObject({
      horizonWeeks: 12,
      planStartDate: '2026-08-17',
      phases: expect.arrayContaining([
        expect.objectContaining({ phaseType: 'TAPER' }),
        expect.objectContaining({ phaseType: 'RACE', startWeek: 12, endWeek: 12 }),
      ]),
      m4: {
        strategyVersion: 'training-m4-plan-strategy.v1',
        conflictSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        validationScope: 'PLAN_CANDIDATE',
        eventPriorityTreatment: 'REVIEW_ONLY_NO_AUTOMATIC_LOAD_CHANGE',
      },
      capacityContext: {
        source: 'EXPLICIT_USER',
        contextVersion: expect.stringMatching(/^explicit_user_[a-f0-9]{64}$/),
        provisional: true,
        calendarConflictCoverage: 'UNAVAILABLE',
      },
    });
    expect(eventWorkouts).toHaveLength(1);
    expect(eventWorkouts[0]).toMatchObject({
      scheduledDate: '2026-11-08',
      dayOfWeek: 'sunday',
      sessionType: 'brick',
    });
    const primary = eventWorkouts[0].blocks.find((block) => block.blockType === 'PRIMARY_WORK');
    expect(primary?.prescription).toMatchObject({
      kind: 'mixed_session',
      segments: [
        { position: 1, modality: 'SWIMMING' },
        { position: 2, modality: 'CYCLING' },
        { position: 3, modality: 'RUNNING' },
      ],
    });
    expect(candidate.qualityReport.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TRAINING_M4_EVENT_TAPER_RACE_INVARIANTS' }),
      expect.objectContaining({ code: 'TRAINING_M4_RECOVERY_AND_INTERFERENCE' }),
    ]));
  });

  it('treats event priority as review metadata without silently changing load', () => {
    const aPriority = buildTrainingPlanRevisionCandidate(eventRequest, {
      typedWorkoutValidationEnabled: true, m4StrategyEnabled: true,
    }).document;
    const bPriority = buildTrainingPlanRevisionCandidate({
      ...eventRequest, event: { ...eventRequest.event!, priority: 'B' },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }).document;
    const loadShape = (document: typeof aPriority) => ({
      phases: document.phases.map((phase) => ({
        type: phase.phaseType, start: phase.startWeek, end: phase.endWeek,
        distribution: phase.targetWorkoutTypeDistribution,
      })),
      workouts: document.weeks.map((week) => week.workouts.map((workout) => ({
        type: workout.sessionType, duration: workout.plannedDurationMinutes, date: workout.scheduledDate,
      }))),
    });
    expect(loadShape(bPriority)).toEqual(loadShape(aPriority));
    expect(aPriority.event?.priority).toBe('A');
    expect(bPriority.event?.priority).toBe('B');
    expect(bPriority.m4?.eventPriorityTreatment).toBe('REVIEW_ONLY_NO_AUTOMATIC_LOAD_CHANGE');
  });

  it('accepts only fresh authoritative capacity and narrowing-only client windows', () => {
    const authoritative = {
      source: 'AUTHORITATIVE' as const,
      contextVersion: 'calendar-authority-v2',
      windows: eventRequest.capacity!.windows.map((window) => ({
        ...window, startTime: '05:00', endTime: '09:00',
      })),
      observedAt: '2026-07-13T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      profileSourceVersion: `m4profile_${'a'.repeat(64)}`,
      calendarEventSetHash: 'b'.repeat(64),
      calendarSources: ['google' as const],
      planStartDate: '2026-08-17',
      planEndDate: '2026-11-08',
      horizonWeeks: 12,
      conflictCount: 0,
    };
    const request = {
      ...eventRequest,
      capacity: {
        source: 'AUTHORITATIVE' as const,
        contextVersion: authoritative.contextVersion,
        windows: eventRequest.capacity!.windows,
      },
    };
    const candidate = buildTrainingPlanRevisionCandidate(request, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      authoritativeCapacityContext: authoritative,
    });
    expect(candidate.document.capacityContext).toEqual({
      source: 'AUTHORITATIVE',
      contextVersion: 'calendar-authority-v2',
      provisional: false,
      calendarConflictCoverage: 'AUTHORITATIVE',
    });
    expect(() => buildTrainingPlanRevisionCandidate({
      ...request,
      capacity: { ...request.capacity, contextVersion: 'client-invented-version' },
    }, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      authoritativeCapacityContext: authoritative,
    })).toThrow(/TRAINING_M4_AUTHORITATIVE_CAPACITY_STALE/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...request,
      capacity: {
        ...request.capacity,
        windows: request.capacity.windows.map((window) => window.dayOfWeek === 'monday'
          ? { ...window, startTime: '04:00' }
          : window),
      },
    }, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      authoritativeCapacityContext: authoritative,
    })).toThrow(/TRAINING_M4_CAPACITY_CLIENT_EXPANSION_FORBIDDEN/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      capacity: { ...eventRequest.capacity!, contextVersion: 'client-claims-authority' },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_CLIENT_AUTHORITY_VERSION_FORBIDDEN/);
  });

  it('rejects malformed, unbounded and duplicate capacity shapes before hashing or persistence', () => {
    const base = eventRequest.capacity!.windows[0];
    const invalid = [
      [{ ...base, dayOfWeek: 'funday' }],
      [{ ...base, allowedDisciplines: ['teleportation'] }],
      [{ ...base, allowedDisciplines: ['running', 'running'] }],
      [{ ...base, timezone: 'x'.repeat(101) }],
      [{ ...base, unexpected: true }],
      [base, { ...base }],
      Array.from({ length: 50 }, (_, index) => ({
        ...base,
        startTime: `${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
        endTime: '23:59',
      })),
    ];
    for (const windows of invalid) {
      expect(() => validateTrainingM4CapacityWindowShapes(windows as never)).toThrow(/TRAINING_M4_CAPACITY/);
    }
    const boundary = Array.from({ length: 49 }, (_, index) => ({
      dayOfWeek: 'monday' as const,
      startTime: `00:${String(index).padStart(2, '0')}`,
      endTime: `01:${String(index).padStart(2, '0')}`,
      timezone: 'UTC',
      allowedDisciplines: ['running' as const],
    }));
    expect(() => validateTrainingM4CapacityWindowShapes(boundary)).not.toThrow();
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      capacity: { ...eventRequest.capacity!, unexpected: true } as never,
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_CAPACITY_ENVELOPE_INVALID/);

    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-invalid-capacity-no-write',
        request: {
          ...eventRequest,
          capacity: {
            source: 'EXPLICIT_USER',
            windows: [{ ...base, dayOfWeek: 'funday' as never }],
          },
          profile: { ...eventRequest.profile, availableDays: ['funday' as never] },
        },
        env: {
          TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
          DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
          TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
        },
      })).toThrow(/TRAINING_REVISION_AVAILABILITY_INVALID/);
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_profile_snapshots').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revision_operations').get()).toEqual({ count: 0 });
    });
  });

  it('binds conflict identity to exact duration and schedule windows', () => {
    const document = buildTrainingPlanRevisionCandidate(eventRequest, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      referenceTime: new Date('2026-07-13T12:00:00.000Z'),
    }).document;
    const active = document.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.sessionType !== 'rest')!;

    const durationTamper = structuredClone(document);
    const durationWorkout = durationTamper.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.workoutKey === active.workoutKey)!;
    durationWorkout.plannedDurationMinutes -= 5;
    expect(() => validateTrainingM4PlanRevisionDocument(durationTamper))
      .toThrow(/TRAINING_M4_SCHEDULE_WINDOWS_REQUIRED/);

    const endTamper = structuredClone(document);
    const endWorkout = endTamper.weeks.flatMap((week) => week.workouts)
      .find((workout) => workout.workoutKey === active.workoutKey)!;
    endWorkout.scheduledEndAt = new Date(Date.parse(endWorkout.scheduledEndAt!) - 5 * 60_000).toISOString();
    endTamper.m4!.conflictSetHash = trainingM4ConflictSetHashForDocument(endTamper);
    expect(() => validateTrainingM4PlanRevisionDocument(endTamper))
      .toThrow(/TRAINING_M4_SCHEDULE_WINDOWS_REQUIRED/);

    const hashTamper = structuredClone(document);
    hashTamper.m4!.conflictSetHash = 'f'.repeat(64);
    expect(() => validateTrainingM4PlanRevisionDocument(hashTamper))
      .toThrow(/TRAINING_M4_STRATEGY_AND_CONFLICT_IDENTITY/);
  });

  it('fails closed when every initial M4 session is already in the past', () => {
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      planStartDate: '2020-01-06',
      event: { ...eventRequest.event!, date: '2020-03-29' },
    }, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      referenceTime: new Date('2026-07-13T12:00:00.000Z'),
    })).toThrow(/TRAINING_M4_INITIAL_SCHEDULE_STALE/);

    const document = buildTrainingPlanRevisionCandidate(eventRequest, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
      referenceTime: new Date('2026-07-13T12:00:00.000Z'),
    }).document;
    const firstStart = Math.min(...document.weeks.flatMap((week) => week.workouts)
      .filter((workout) => workout.sessionType !== 'rest')
      .map((workout) => Date.parse(workout.scheduledStartAt!)));
    expect(() => validateTrainingM4InitialScheduleFreshness(document, new Date(firstStart - 1))).not.toThrow();
    expect(() => validateTrainingM4InitialScheduleFreshness(document, new Date(firstStart + 1)))
      .toThrow(/TRAINING_M4_INITIAL_SCHEDULE_STALE/);
  });

  it('rejects mismatched event horizons, missing pool access and conflicting goals', () => {
    expect(() => buildTrainingPlanRevisionCandidate({ ...eventRequest, horizonWeeks: 11 }, {
      typedWorkoutValidationEnabled: true, m4StrategyEnabled: true,
    })).toThrow(/TRAINING_M4_EVENT_HORIZON_MISMATCH/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      resourceAccess: { ...eventRequest.resourceAccess!, pool: false },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true })).toThrow(/TRAINING_M4_RESOURCE_POOL_REQUIRED/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['running'] },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true })).toThrow(/TRAINING_M4_GOAL_PRIORITY_CONFLICT/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      capacity: {
        ...eventRequest.capacity!,
        windows: eventRequest.capacity!.windows.map((window) => ({
          ...window,
          allowedDisciplines: ['running'],
        })),
      },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true })).toThrow(/TRAINING_M4_CAPACITY_SWIMMING_REQUIRED/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      capacity: {
        ...eventRequest.capacity!,
        windows: eventRequest.capacity!.windows.map((window) => window.dayOfWeek === 'monday'
          ? { ...window, allowedDisciplines: ['swimming'] as const }
          : window),
      },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_SCHEDULE_CAPACITY_CONFLICT:monday:easy_run/);
  });

  it('rejects capacity windows shorter than the immutable workout duration', () => {
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      capacity: {
        ...eventRequest.capacity!,
        windows: eventRequest.capacity!.windows.map((window) => ({
          ...window, startTime: '06:00', endTime: '06:30',
        })),
      },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_SCHEDULE_CAPACITY_CONFLICT/);
  });

  it('requires usable cycling resources for cycling and hybrid plans', () => {
    const unusable = {
      ...eventRequest.resourceAccess!, bicycle: true, indoorTrainer: false, outdoorRideEnvironment: false,
    };
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest, discipline: 'cycling',
      event: { ...eventRequest.event!, subtype: 'cycling_event' },
      goalPriority: { primaryDiscipline: 'cycling', secondaryDisciplines: [] },
      resourceAccess: unusable,
      capacity: {
        ...eventRequest.capacity!,
        windows: eventRequest.capacity!.windows.map((window) => ({ ...window, allowedDisciplines: ['cycling'] })),
      },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_RESOURCE_BICYCLE_REQUIRED/);
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest, planMode: 'continuous', goal: 'general_fitness', discipline: 'hybrid',
      horizonWeeks: 6, event: undefined,
      goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['strength'] },
      resourceAccess: unusable,
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_M4_RESOURCE_HYBRID_BICYCLE_REQUIRED/);
  });

  it('does not generate active sessions after a non-Sunday event', () => {
    const saturday = buildTrainingPlanRevisionCandidate({
      ...eventRequest,
      event: { ...eventRequest.event!, date: '2026-11-07' },
      profile: {
        ...eventRequest.profile,
        availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
      },
      capacity: {
        ...eventRequest.capacity!,
        windows: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'].map((dayOfWeek) => ({
          dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
          allowedDisciplines: ['running' as const, 'cycling' as const, 'swimming' as const, 'strength' as const],
        })),
      },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }).document;
    const postEvent = saturday.weeks.flatMap((week) => week.workouts)
      .filter((workout) => workout.sessionType !== 'rest' && workout.scheduledDate! > '2026-11-07');
    expect(postEvent).toEqual([]);
  });

  it('blocks both hard-day recovery collisions and heavy-strength interference', () => {
    const hybridRequest: TrainingPlanCandidateRequest = {
      ...eventRequest,
      planMode: 'continuous',
      goal: 'general_fitness',
      discipline: 'hybrid',
      horizonWeeks: 6,
      event: undefined,
      goalPriority: { primaryDiscipline: 'strength', secondaryDisciplines: ['running'] },
      capacity: {
        source: 'EXPLICIT_USER',
        windows: eventRequest.profile.availableDays.map((dayOfWeek) => ({
          dayOfWeek, startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
          allowedDisciplines: ['running', 'strength', 'cycling'],
        })),
      },
    };
    const valid = buildTrainingPlanRevisionCandidate(hybridRequest, {
      typedWorkoutValidationEnabled: true,
      m4StrategyEnabled: true,
    }).document;
    expect(() => validateTrainingM4PlanRevisionDocument(valid)).not.toThrow();

    const hardCollision = structuredClone(valid);
    hardCollision.weeks[0].workouts[0].sessionType = 'threshold_run';
    hardCollision.weeks[0].workouts[1].sessionType = 'interval_run';
    expect(() => validateTrainingM4PlanRevisionDocument(hardCollision))
      .toThrow(/TRAINING_M4_HARD_DAY_RECOVERY_SPACING/);

    const interference = structuredClone(valid);
    interference.weeks[0].workouts[0].sessionType = 'strength_hypertrophy';
    interference.weeks[0].workouts[1].sessionType = 'threshold_run';
    expect(() => validateTrainingM4PlanRevisionDocument(interference))
      .toThrow(/TRAINING_M4_HYBRID_INTERFERENCE/);

    const reverseInterference = structuredClone(valid);
    reverseInterference.weeks[0].workouts[0].sessionType = 'threshold_run';
    reverseInterference.weeks[0].workouts[1].sessionType = 'strength_hypertrophy';
    expect(() => validateTrainingM4PlanRevisionDocument(reverseInterference))
      .toThrow(/TRAINING_M4_HYBRID_INTERFERENCE/);
  });

  it('uses hybrid goal priority to select materially different key-session mixes', () => {
    const runningPriority = selectTrainingM4SessionTypes({
      planMode: 'continuous', discipline: 'hybrid', sessionsPerWeek: 3,
      goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['strength'] },
    });
    const strengthPriority = selectTrainingM4SessionTypes({
      planMode: 'continuous', discipline: 'hybrid', sessionsPerWeek: 3,
      goalPriority: { primaryDiscipline: 'strength', secondaryDisciplines: ['running'] },
    });
    expect(runningPriority.filter((type) => type.endsWith('_run'))).toHaveLength(2);
    expect(strengthPriority.filter((type) => type.startsWith('strength_'))).toHaveLength(2);
    expect(strengthPriority).not.toEqual(runningPriority);
  });

  it('produces materially distinct maintenance and return-to-training strategies', () => {
    const base = {
      ...eventRequest,
      planStartDate: '2026-08-17',
      event: undefined,
      discipline: 'running' as const,
      resourceAccess: { ...eventRequest.resourceAccess! },
      goalPriority: { primaryDiscipline: 'running' as const, secondaryDisciplines: [] },
      profile: {
        ...eventRequest.profile,
        sessionsPerWeek: 3,
        availableDays: ['monday', 'wednesday', 'friday'] as const,
      },
      capacity: {
        source: 'EXPLICIT_USER',
        windows: ['monday', 'wednesday', 'friday'].map((dayOfWeek) => ({
          dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '07:00', timezone: 'Europe/Lisbon',
        })),
      },
    };
    const maintenance = buildTrainingPlanRevisionCandidate({
      ...base, planMode: 'maintenance', goal: 'maintenance', horizonWeeks: 4,
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true });
    const returning = buildTrainingPlanRevisionCandidate({
      ...base, planMode: 'return_to_training', goal: 'return_to_training', horizonWeeks: 4,
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true });
    expect(maintenance.document.phases.map((phase) => phase.phaseType)).toEqual(['MAINTENANCE', 'RECOVERY']);
    expect(returning.document.phases.map((phase) => phase.phaseType)).toEqual(['FOUNDATION', 'BASE', 'RECOVERY']);
    expect(maintenance.document.weeklyStructure.targetWorkoutTypeDistribution)
      .not.toEqual(returning.document.weeklyStructure.targetWorkoutTypeDistribution);
  });

  it('persists M4 only for an explicitly scoped enrolled combination', () => {
    withDatabaseForTest(db, () => {
      const env = {
        TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
        TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
        TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'event_based:triathlon',
        DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
        TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
      };
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-event',
        request: eventRequest,
        env,
      });
      expect(created.candidates[0].document).toMatchObject({
        m4: { strategyVersion: 'training-m4-plan-strategy.v1' },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 0 });
    });
  });

  it('denies M4 generation before persistence when the exact combination is not enrolled', () => {
    withDatabaseForTest(db, () => {
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-denied',
        request: eventRequest,
        env: {
          TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          TRAINING_PLAN_M4_ALLOWLIST_USER_7: 'maintenance:running',
          DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
          TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
        },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_M4_ALLOWLIST_REQUIRED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('cannot bypass the M4 allowlist by omitting optional M4 request fields', () => {
    withDatabaseForTest(db, () => {
      const legacyShapedEvent: TrainingPlanCandidateRequest = {
        planMode: 'event_based', goal: 'event_performance', discipline: 'triathlon', horizonWeeks: 8,
        event: { name: 'Legacy-shaped event', date: '2026-10-18', priority: 'A' },
        profile: {
          experienceLevel: 'intermediate', sessionsPerWeek: 4, sessionDurationMinutes: 45,
          availableDays: ['monday', 'wednesday', 'friday', 'sunday'], equipmentIds: [], location: 'home',
        },
      };
      expect(() => createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-legacy-shape-denied', request: legacyShapedEvent,
        env: {
          TRAINING_PLAN_REVISION_V1_MODE_USER_7: 'active',
          TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7: 'true',
          DECISION_FLOW_V1_ENFORCE_ENABLED: 'true',
          TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY: 'training-revision-test-encryption-key-0001',
        },
      })).toThrowError(expect.objectContaining({ code: 'TRAINING_M4_ALLOWLIST_REQUIRED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM training_plan_revisions').get()).toEqual({ count: 0 });
    });
  });

  it('constrains continuous M4 plans to the reviewed general-fitness goal', () => {
    expect(() => buildTrainingPlanRevisionCandidate({
      ...eventRequest, planMode: 'continuous', goal: 'maintenance', discipline: 'hybrid',
      horizonWeeks: 6, event: undefined,
      goalPriority: { primaryDiscipline: 'running', secondaryDisciplines: ['strength'] },
    }, { typedWorkoutValidationEnabled: true, m4StrategyEnabled: true }))
      .toThrow(/TRAINING_CONTINUOUS_PLAN_GOAL_MISMATCH/);
  });
});
