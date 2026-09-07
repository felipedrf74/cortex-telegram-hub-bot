import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  assertAuthorizationScopeIsolationEvidence,
  assertPersonaSignalEvidence,
  assertTrainingE2EPersonaFixtureCleanupProof,
  classifyTrainingE2ESessionIntensity,
  comparePersistedSessionsToReadModel,
  hasPublicProfessionalGuidanceEvidence,
  persistedPlanEndOvershootsRaceDate,
  publicSessionAdaptationReason,
  readPersonaAuthBindingFromFreshConnection,
  readPersonaUserFromFreshConnection,
  sessionExerciseMetadata,
} from '../../scripts/training-e2e-quality';
import { scoreTrainingPlanQuality } from '../../src/services/training-plan-creation-validation';

const persistedSession = {
  id: 41,
  planId: 9,
  weekNumber: 1,
  lifecycleState: 'pending',
  sessionIdentityKey: 'plan:9:week:1:monday:easy_run',
  sessionShapeHash: 'shape-41',
  dayOfWeek: 'Monday',
  title: 'Easy aerobic run',
  sessionType: 'easy_run',
  intensityText: 'Zone 2 / RPE 3',
  scheduledStartAt: '2026-08-03T06:00:00.000Z',
  scheduledEndAt: '2026-08-03T06:45:00.000Z',
  scheduleTimeZone: 'Europe/Lisbon',
  durationMinutes: 45,
  preferredTimeUnavailable: false,
  exercises: [{ name: 'Easy run', durationMinutes: 45 }],
};

const readModel = {
  data: {
    plan: { id: 9, schedulingTimezone: 'Europe/Lisbon' },
    weeks: [{
      weekNumber: 1,
      sessions: [{
        id: '41',
        planId: '9',
        lifecycleState: 'pending',
        sessionIdentityKey: persistedSession.sessionIdentityKey,
        sessionShapeHash: persistedSession.sessionShapeHash,
        day: 'Monday',
        title: 'Easy aerobic run',
        sessionType: 'easy_run',
        intensityText: persistedSession.intensityText,
        scheduledStartAt: persistedSession.scheduledStartAt,
        scheduledEndAt: persistedSession.scheduledEndAt,
        duration: 45,
        preferredTimeUnavailable: false,
        exercises: persistedSession.exercises,
      }],
    }],
  },
};

describe('Training E2E quality evidence hardening', () => {
  it('treats exclusive plan end on the day after race as on-time, not an overshoot', () => {
    expect(persistedPlanEndOvershootsRaceDate('2026-11-30', '2026-11-29')).toBe(false);
    expect(persistedPlanEndOvershootsRaceDate('2026-11-29', '2026-11-29')).toBe(false);
    expect(persistedPlanEndOvershootsRaceDate('2026-12-07', '2026-11-29')).toBe(true);
    expect(persistedPlanEndOvershootsRaceDate('', '2026-11-29')).toBe(true);
  });

  it('scores the public structured intensity target instead of inventing a hard ratio from titles', () => {
    const publicRows = [
      ['Tempo Progression Run', '15min tempo with warmup and cooldown.'],
      ['Long Run', '70min aerobic continuous work.'],
      ['Tempo Progression Run', '15min tempo with warmup and cooldown.'],
      ['Long Run', '70min aerobic continuous work.'],
      ['Hill Repeats', '3x 4min vo2 with warmup and cooldown.'],
      ['Long Run', '70min aerobic continuous work.'],
      ['Reduced Interval Run', '3x 4min vo2 with warmup and cooldown.'],
      ['Reduced Long Run', '70min aerobic continuous work.'],
    ].map(([title, value]) => ({
      title,
      intensityText: 'RPE 70%',
      descriptionSections: {
        coachInsights: [{
          presentationLevel: 'user_facing',
          label: 'Intensity target',
          value,
          reasonCode: 'intensity_summary',
        }],
      },
    }));

    const intensities = publicRows.map(classifyTrainingE2ESessionIntensity);
    expect(intensities).toEqual([
      'moderate', 'easy',
      'moderate', 'easy',
      'hard', 'easy',
      'hard', 'easy',
    ]);

    const candidate = {
      objective: 'RPE-led training without a wearable',
      goalMode: 'continuous',
      readinessState: 'no_data',
      weeks: [0, 1, 2, 3].map((weekIndex) => ({
        weekNumber: weekIndex + 1,
        phase: weekIndex === 3 ? 'deload' : weekIndex === 2 ? 'build' : 'base',
        sessions: publicRows.slice(weekIndex * 2, weekIndex * 2 + 2).map((row, rowIndex) => ({
          id: `w${weekIndex + 1}-run-${rowIndex + 1}`,
          weekNumber: weekIndex + 1,
          dayOfWeek: rowIndex === 0 ? 'Tuesday' : 'Saturday',
          sport: 'running' as const,
          title: row.title,
          sessionType: rowIndex === 0 ? 'run' : 'long_run',
          durationMinutes: rowIndex === 0 ? 45 : 70,
          intensity: intensities[weekIndex * 2 + rowIndex],
        })),
      })),
    };
    const intensityDimension = scoreTrainingPlanQuality(candidate).dimensions
      .find((dimension) => dimension.dimension === 'intensity_distribution');
    expect(intensityDimension?.blockers).toEqual([]);
    expect(intensityDimension?.observations).toContain('Hard endurance ratio 25%.');
  });

  it('accepts only explicit public session copy as readiness-adaptation evidence', () => {
    expect(publicSessionAdaptationReason({
      description: 'Feedback loop: reduce load today because readiness and fatigue signals are constrained.',
    })).toContain('reduce load');
    expect(publicSessionAdaptationReason({
      description: 'Complete the prescribed session with controlled technique.',
    })).toBeNull();
    expect(publicSessionAdaptationReason({
      description: 'Stop every set well before fatigue accumulates.',
    })).toBeNull();
    expect(publicSessionAdaptationReason({
      scheduleReason: 'private scheduler detail',
    })).toBeNull();
  });

  it('uses a cache-neutral route for auth visibility before readiness fixtures are seeded', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../scripts/training-e2e-quality.ts'),
      'utf8',
    );
    const start = source.indexOf('const USER_VISIBILITY_TIMEOUT_MS');
    const end = source.indexOf('const preparePersona', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const visibilityProbe = source.slice(start, end);

    expect(visibilityProbe).toContain("'/api/v1/settings/status'");
    expect(visibilityProbe).not.toContain("'/api/v1/training/readiness'");
  });

  it('requires injury professional-guidance proof from a public API response', () => {
    expect(hasPublicProfessionalGuidanceEvidence(
      { data: { decisionReasons: [] } },
      { data: { weeks: [] } },
    )).toBe(false);

    expect(hasPublicProfessionalGuidanceEvidence(
      {
        data: {
          decisionReasons: [{
            code: 'pain_flag',
            text: 'Keep work pain-free, stop if symptoms worsen, and consult a qualified medical professional.',
          }],
        },
      },
      { data: { weeks: [] } },
    )).toBe(true);
  });

  it('resolves persisted exercise ids through the canonical coach catalog', () => {
    expect(sessionExerciseMetadata({
      exercises: [
        { exerciseId: 'bodyweight_squat', name: 'Bodyweight Squat' },
        { exerciseId: 'hip_hinge_band', name: 'Banded Hip Hinge' },
        { exerciseId: 'dumbbell_floor_press', name: 'Dumbbell Floor Press' },
        { exerciseId: 'band_row', name: 'Band Row' },
        { exerciseId: 'pallof_press', name: 'Pallof Press' },
      ],
    })).toEqual({
      equipment: ['bodyweight', 'dumbbells'],
      movementPatterns: ['squat', 'hinge', 'push', 'pull', 'core'],
    });
    // Unknown persisted identities stay fail-closed; the E2E lane must not
    // infer quality evidence from a display name alone.
    expect(sessionExerciseMetadata({
      exercises: [{ exerciseId: 'unknown_exercise', name: 'Mystery Squat' }],
    })).toEqual({ equipment: [], movementPatterns: [] });
  });

  it('records known equipment-free catalog exercises as bodyweight evidence', () => {
    expect(sessionExerciseMetadata({
      exercises: [{ exerciseId: 'push_up', name: 'Push-Up' }],
    })).toEqual({
      equipment: ['bodyweight'],
      movementPatterns: ['push'],
    });

    // Unknown ids remain fail-closed; only a catalog hit can establish that
    // an empty equipment array means intentional bodyweight execution.
    expect(sessionExerciseMetadata({
      exercises: [{ exerciseId: 'unknown_push', name: 'Push-Up' }],
    })).toEqual({ equipment: [], movementPatterns: [] });
  });

  it('reopens the persona database for each host-visibility discriminator read', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'training-persona-visibility-'));
    const dbPath = path.join(tempDir, 'training.db');
    const writer = new Database(dbPath);
    try {
      writer.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT NOT NULL)');
      writer.exec('CREATE TABLE ios_devices (user_id INTEGER NOT NULL, device_id TEXT NOT NULL)');
      writer.prepare('INSERT INTO users (id, status) VALUES (?, ?)').run(44, 'active');
      writer.prepare('INSERT INTO ios_devices (user_id, device_id) VALUES (?, ?)').run(44, 'persona-device-44');

      expect(readPersonaUserFromFreshConnection(dbPath, 44)).toEqual({
        id: 44,
        status: 'active',
      });
      expect(readPersonaUserFromFreshConnection(dbPath, 45)).toBeNull();
      expect(readPersonaAuthBindingFromFreshConnection(dbPath, 44, 'persona-device-44')).toEqual({
        user: { id: 44, status: 'active' },
        device: { userId: 44, deviceId: 'persona-device-44' },
      });
      expect(readPersonaAuthBindingFromFreshConnection(dbPath, 44, 'missing-device')).toEqual({
        user: { id: 44, status: 'active' },
        device: null,
      });
    } finally {
      writer.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('compares every durable session identity and schedule field exposed by the read model', () => {
    expect(comparePersistedSessionsToReadModel([persistedSession], readModel)).toMatchObject({
      matches: true,
      mismatches: [],
    });

    const mutations: Array<[string, (payload: any) => void]> = [
      ['sessionIdentityKey', (payload) => { payload.data.weeks[0].sessions[0].sessionIdentityKey = 'wrong'; }],
      ['sessionShapeHash', (payload) => { payload.data.weeks[0].sessions[0].sessionShapeHash = 'wrong'; }],
      ['dayOfWeek', (payload) => { payload.data.weeks[0].sessions[0].day = 'Tuesday'; }],
      ['title', (payload) => { payload.data.weeks[0].sessions[0].title = 'Generic workout'; }],
      ['sessionType', (payload) => { payload.data.weeks[0].sessions[0].sessionType = 'workout'; }],
      ['intensityText', (payload) => { payload.data.weeks[0].sessions[0].intensityText = 'Max effort'; }],
      ['preferredTimeUnavailable', (payload) => { payload.data.weeks[0].sessions[0].preferredTimeUnavailable = true; }],
      ['exercises', (payload) => { payload.data.weeks[0].sessions[0].exercises = []; }],
      ['scheduleTimeZone', (payload) => { payload.data.plan.schedulingTimezone = 'America/New_York'; }],
    ];
    for (const [field, mutate] of mutations) {
      const payload = structuredClone(readModel);
      mutate(payload);
      const comparison = comparePersistedSessionsToReadModel([persistedSession], payload);
      expect(comparison.matches, field).toBe(false);
      expect(comparison.mismatches.join(' '), field).toContain(field);
    }
  });

  it('requires independent user and tenant authorization probes', () => {
    const valid = {
      probes: [
        {
          boundary: 'foreign_user_same_tenant',
          foreignPlanId: 81,
          responseStatus: 200,
          responseCancelled: false,
          expectedOwnerUserId: 22,
          expectedOwnerTenantId: 11,
          remainedOwnedByExpectedScope: true,
          remainedActive: true,
        },
        {
          boundary: 'same_user_foreign_tenant',
          foreignPlanId: 82,
          responseStatus: 404,
          responseCancelled: null,
          expectedOwnerUserId: 11,
          expectedOwnerTenantId: 33,
          remainedOwnedByExpectedScope: true,
          remainedActive: true,
        },
      ],
    } as const;
    expect(() => assertAuthorizationScopeIsolationEvidence(valid)).not.toThrow();
    expect(() => assertAuthorizationScopeIsolationEvidence({ probes: [valid.probes[0]] } as any))
      .toThrow(/both user and tenant/i);
    expect(() => assertAuthorizationScopeIsolationEvidence({
      probes: [...valid.probes, valid.probes[0]],
    } as any)).toThrow(/exactly both|both user and tenant/i);
  });

  it('fails cleanup when any persona-owned durable fixture remains', () => {
    const clean = {
      clean: true,
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
    expect(() => assertTrainingE2EPersonaFixtureCleanupProof(clean)).not.toThrow();
    expect(() => assertTrainingE2EPersonaFixtureCleanupProof({ ...clean, deviceRows: 1 }))
      .toThrow(/deviceRows=1/);
    const { outboxRows: _omitted, ...incomplete } = clean;
    expect(() => assertTrainingE2EPersonaFixtureCleanupProof(incomplete as any))
      .toThrow(/outboxRows.*missing|missing.*outboxRows/i);
  });

  it('requires concrete evidence for every expected persona signal', () => {
    expect(() => assertPersonaSignalEvidence(
      ['novice_safe_strength', 'equipment_fit'],
      {
        novice_safe_strength: ['3 strength sessions; no advanced-lift tokens'],
        equipment_fit: ['all prescribed equipment belongs to full_gym'],
      },
    )).not.toThrow();
    expect(() => assertPersonaSignalEvidence(
      ['novice_safe_strength', 'equipment_fit'],
      { novice_safe_strength: ['proved'] },
    )).toThrow(/equipment_fit/);
    expect(() => assertPersonaSignalEvidence(
      ['novice_safe_strength'],
      { novice_safe_strength: [] },
    )).toThrow(/novice_safe_strength/);
  });
});
