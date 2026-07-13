// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTest } from '../../src/services/database';
import {
  buildTrainingPlanRevisionCandidate,
  type TrainingPlanCandidateRequest,
} from '../../src/services/training-plan-revision-candidate-builder';
import { validateTrainingM4PlanRevisionDocument } from '../../src/services/training-typed-plan-generator';
import { createTrainingPlanCandidateRevision } from '../../src/services/training-plan-revisions';
import {
  getTrainingM4Allowlist,
  isTrainingM4PlanCombinationAllowed,
} from '../../src/services/runtime-flags';
import { selectTrainingM4SessionTypes } from '../../src/services/training-m4-plan-strategies';

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
    db = new Database(':memory:');
    runMigrationsForTest(db);
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

  it('accepts only fresh authoritative capacity and narrowing-only client windows', () => {
    const authoritative = {
      source: 'AUTHORITATIVE' as const,
      contextVersion: 'calendar-authority-v2',
      windows: eventRequest.capacity!.windows.map((window) => ({
        ...window, startTime: '05:00', endTime: '09:00',
      })),
      observedAt: '2026-07-13T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
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
});
