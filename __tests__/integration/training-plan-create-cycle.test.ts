import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calendarMocks,
  createTrainingE2EHarness,
  type TrainingE2EHarness,
} from './training-e2e-harness';
import {
  inferTrainingSessionIsLongRun,
  inferTrainingSessionIsLowerHeavy,
} from '../../src/services/training-session-classification';
import { getQuestionnaire } from '../../src/services/onboarding';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';
import { processPendingEvents } from '../../src/services/event-outbox';
import { processTrainingPlanCalendarSyncJobs } from '../../src/services/training-plan-calendar-sync-worker';
import { scoreTrainingPlanQuality } from '../../src/services/training-plan-creation-validation';

let harness: TrainingE2EHarness | null = null;

// Phase 1B: provider calendar events are created by the dedicated background
// worker after activation, not inline in the route. Integration tests drain
// the real durable chain (outbox '*' router → training_plan_calendar_sync job
// → worker) exactly the way the scheduler crons do in production.
async function drainTrainingCalendarSync(): Promise<void> {
  await processPendingEvents(defaultEventHandlers, { limit: 25, lockOwner: 'training-e2e-router' });
  await processTrainingPlanCalendarSyncJobs({ limit: 10, lockOwner: 'training-e2e-drain' });
}

function countLinkedSessions(planId: number): number {
  if (!harness) return 0;
  const row = harness.db.prepare(`
    SELECT COUNT(*) AS count
      FROM training_sessions
     WHERE plan_id = ?
       AND calendar_event_id IS NOT NULL
  `).get(planId) as { count: number };
  return Number(row.count);
}

const dayBefore: Record<string, string> = {
  monday: 'sunday',
  tuesday: 'monday',
  wednesday: 'tuesday',
  thursday: 'wednesday',
  friday: 'thursday',
  saturday: 'friday',
  sunday: 'saturday',
};

const bugReproducerBody = {
  objective: 'Lisbon Marathon October 2026',
  durationWeeks: 2,
  preferredTime: '07:00',
  preferredCardioTime: '07:00',
  preferredStrengthTime: '18:00',
  sessionsPerWeek: 5,
  runSessionsPerWeek: 5,
  strengthSessionsPerWeek: 5,
  startPolicy: 'today',
  longWorkoutDay: 'Saturday',
  goalMode: 'event_based',
  trainingPriority: 'running',
  raceDate: '2026-10-18',
  twoADayPreference: 'preferred',
  calendarSource: 'outlook',
};

const weeklyTargetCases = [
  {
    id: 'no-explicit-run-strength-budget',
    body: {
      objective: '10K running plan',
      durationWeeks: 1,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 6,
      trainingPriority: 'running',
      startPolicy: 'today',
    },
    requested: { strengthSessionsPerWeek: 6 },
  },
  {
    id: 'genuine-two-a-day-distinct-days',
    body: {
      ...bugReproducerBody,
      durationWeeks: 1,
      sessionsPerWeek: 5,
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      twoADayPreference: 'preferred',
      startPolicy: 'today',
    },
    requested: { sessionsPerWeek: 5, runSessionsPerWeek: 5, strengthSessionsPerWeek: 5 },
    expectedDistinctTrainingDays: 5,
  },
  {
    id: 'explicit-run-strength-budget',
    body: {
      objective: 'Running plan with gym support',
      durationWeeks: 1,
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'running',
      startPolicy: 'today',
    },
    requested: { runSessionsPerWeek: 2, strengthSessionsPerWeek: 5 },
  },
  {
    id: 'triathlon-zero-bike-swim-floor',
    body: {
      objective: 'Olympic triathlon',
      durationWeeks: 1,
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
      startPolicy: 'today',
    },
    requested: { bikeSessionsPerWeek: 0, swimSessionsPerWeek: 0, strengthSessionsPerWeek: 1 },
  },
  {
    id: 'cycling-nonzero-bike-passthrough',
    body: {
      objective: 'Cycling gran fondo',
      durationWeeks: 1,
      sessionsPerWeek: 5,
      bikeSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'cycling',
      startPolicy: 'today',
    },
    requested: { bikeSessionsPerWeek: 3, strengthSessionsPerWeek: 1 },
  },
] as const;

describe('training plan create cycle integration', () => {
  afterEach(() => {
    vi.useRealTimers();
    harness?.close();
    harness = null;
  });

  it('previews the 5 run + 5 strength Saturday-long-run reproducer without the heavy-lower blocker', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const res = await harness.dispatch('POST', '/plan/preview', bugReproducerBody);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('preview');
    expect(ruleIds(res.body.data.planLint.blockers)).not.toContain('no_heavy_lower_before_long_run');
    expect(res.body.data.blockers.map((blocker: any) => blocker.code)).not.toContain('no_heavy_lower_before_long_run');
    expect(res.body.data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      // Stronger F8/F10 guarantee: athlete-facing targets describe the
      // finalized schedule, never the raw ask. Coordination now treats the
      // five-day target as DAYS, so all five authored runs survive alongside
      // five strength sessions instead of fabricating a shortfall.
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
    expect(res.body.data.volumeShortfalls ?? []).toEqual([]);
    expect(calendarMocks.getEventsForSources).toHaveBeenCalledWith(
      '2026-05-25',
      '2026-06-08',
      12,
      ['outlook'],
    );
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });

  it('generates the reproducer with HTTP 201 and persists no lower-heavy session before the long run', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const res = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      idempotencyKey: 'training-e2e-no-heavy-before-long-run',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.planId).toEqual(expect.any(Number));
    expect(ruleIds(res.body.data.planLint.blockers)).not.toContain('no_heavy_lower_before_long_run');
    expect(res.body.data.calendarSource).toBe('outlook');
    // Phase 1B: the creation response reports the queued (not-yet-synced)
    // state honestly; provider events only exist after the worker drain.
    expect(res.body.data.eventsCreated).toBe(0);
    expect(res.body.data.calendarSync).toMatchObject({ status: 'not_synced', pending: true });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();

    await drainTrainingCalendarSync();

    const sessions = persistedSessions(Number(res.body.data.planId));
    expect(countTwoADayTrainingDays(sessions)).toBeGreaterThanOrEqual(3);
    const longRun = sessions.find((session) => inferTrainingSessionIsLongRun(session));
    expect(longRun?.dayOfWeek.toLowerCase()).toBe('saturday');

    const protectedDay = dayBefore[String(longRun?.dayOfWeek ?? '').toLowerCase()];
    expect(protectedDay).toBe('friday');
    expect(sessions.filter((session) => session.dayOfWeek.toLowerCase() === protectedDay)
      .some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
    expect(calendarMocks.createEvent).toHaveBeenCalled();
    const linkedSessions = countLinkedSessions(Number(res.body.data.planId));
    expect(linkedSessions).toBeGreaterThan(0);
    expect(calendarMocks.createEvent.mock.calls.length).toBe(linkedSessions);
    expect(calendarMocks.createEvent.mock.calls.every(([payload]) =>
      hasWorkoutContentCalendarBody(payload?.description),
    )).toBe(true);
  });

  it('returns the iOS plan preview and create payload contract fields from the real route', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const preview = await harness.dispatch('POST', '/plan/preview', {
      ...bugReproducerBody,
      durationWeeks: 1,
      calendarSource: 'auto',
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.data).toMatchObject({
      status: 'preview',
      planName: expect.any(String),
      sport: expect.any(String),
      objective: bugReproducerBody.objective,
      durationWeeks: 1,
      resolvedStartDate: '2026-05-25',
      weeklyTargets: {
        sessionsPerWeek: 5,
        // Response truth is the finalized matrix; request truth is retained
        // separately in persisted `requestedTargets`.
        runSessionsPerWeek: 5,
        strengthSessionsPerWeek: 5,
      },
      totalSessions: expect.any(Number),
      calendarSource: 'outlook',
      fallbackTemplateUsed: expect.any(Boolean),
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
      calendarFetchDegraded: expect.any(Boolean),
    });
    expect(preview.body.data.phaseRoadmap[0]).toMatchObject({
      weekNumber: 1,
      phase: expect.any(String),
      sessionCount: expect.any(Number),
      keySessions: expect.any(Array),
    });
    expect(preview.body.data.planLint).toMatchObject({
      status: expect.stringMatching(/^(pass|pass_with_warnings|warn|fail)$/),
      blockers: expect.any(Array),
      warnings: expect.any(Array),
      suggestedFixes: expect.any(Array),
    });
    expect(preview.body.data.warnings).toEqual(expect.any(Array));
    expect(preview.body.data.blockers).toEqual(expect.any(Array));

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      durationWeeks: 1,
      idempotencyKey: 'training-e2e-ios-contract',
    });

    expect(created.statusCode).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.data).toMatchObject({
      planId: expect.any(Number),
      planName: expect.any(String),
      sport: expect.any(String),
      objective: bugReproducerBody.objective,
      durationWeeks: 1,
      resolvedStartDate: '2026-05-25',
      calendarSource: 'outlook',
      phaseRoadmap: expect.any(Array),
      totalSessions: expect.any(Number),
      eventsCreated: expect.any(Number),
      // Phase 1B contract: creation always reports the queued state — the
      // background worker owns provider outcomes and the plan-level durable
      // state lives in preferences_json.calendarSync.
      calendarSync: {
        provider: 'outlook',
        sessionsAttempted: expect.any(Number),
        eventsCreated: 0,
        sessionsLinked: 0,
        sessionsFailed: 0,
        unscheduled: 0,
        status: 'not_synced',
        pending: true,
      },
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      weeklyTargets: {
        sessionsPerWeek: 5,
        runSessionsPerWeek: 5,
        strengthSessionsPerWeek: 5,
      },
      weeks: expect.any(Array),
      decisionReasons: expect.any(Array),
      fallbackTemplateUsed: expect.any(Boolean),
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
      calendarFetchDegraded: expect.any(Boolean),
      planLint: {
        status: expect.stringMatching(/^(pass|pass_with_warnings|warn|fail)$/),
        blockers: expect.any(Array),
        warnings: expect.any(Array),
        suggestedFixes: expect.any(Array),
      },
      warnings: expect.any(Array),
      message: expect.any(String),
    });
    expect(created.body.data).toHaveProperty('profileQuality');
    // Phase 1B: linkage is proven post-drain against the database, not from
    // the creation response (which can no longer observe provider outcomes).
    await drainTrainingCalendarSync();
    const linkedSessions = countLinkedSessions(Number(created.body.data.planId));
    expect(linkedSessions).toBeGreaterThan(0);
    expect(calendarMocks.createEvent.mock.calls.length).toBe(linkedSessions);
    expect(created.body.data.weeks[0]).toMatchObject({
      weekNumber: 1,
      sessionCount: expect.any(Number),
    });
    const persistedPreferences = harness.db.prepare(`
      SELECT preferences_json
        FROM fitness_training_plans
       WHERE id = ?
    `).get(created.body.data.planId) as { preferences_json: string };
    expect(JSON.parse(persistedPreferences.preferences_json)).toMatchObject({
      twoADayPreference: 'preferred',
    });
    expect(ruleIds(created.body.data.planLint.blockers)).not.toContain('no_heavy_lower_before_long_run');
  });

  it('carries a fitted novice deload from preview through persistence and the plan-weeks read model', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const fitnessRow = harness.db.prepare(`
      SELECT data FROM user_profiles WHERE user_id = 12 AND profile_type = 'fitness'
    `).get() as { data: string };
    const fitnessProfile = JSON.parse(fitnessRow.data);
    fitnessProfile.experience_level = 'Beginner (< 1 year)';
    harness.db.prepare(`
      UPDATE user_profiles SET data = ? WHERE user_id = 12 AND profile_type = 'fitness'
    `).run(JSON.stringify(fitnessProfile));

    // The default integration fixture carries a future marathon date. Remove
    // it so this proves the continuous novice cadence rather than the separate
    // race-date/taper path.
    const runningRow = harness.db.prepare(`
      SELECT data FROM user_profiles WHERE user_id = 12 AND profile_type = 'triathlon-running'
    `).get() as { data: string };
    const runningProfile = JSON.parse(runningRow.data);
    runningProfile.target_race = 'None — general fitness';
    runningProfile.target_race_date = 'none';
    harness.db.prepare(`
      UPDATE user_profiles SET data = ? WHERE user_id = 12 AND profile_type = 'triathlon-running'
    `).run(JSON.stringify(runningProfile));

    const request = {
      objective: 'Beginner gym strength plan',
      durationWeeks: 4,
      preferredTime: '07:00',
      preferredStrengthTime: '18:00',
      sessionsPerWeek: 3,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 3,
      startPolicy: 'today',
      goalMode: 'continuous',
      trainingPriority: 'strength',
      twoADayPreference: 'never',
    };

    const preview = await harness.dispatch('POST', '/plan/preview', request);
    expect(preview.statusCode).toBe(200);
    expect(preview.body.data.phaseRoadmap.at(-1)).toMatchObject({ weekNumber: 4, phase: 'deload' });

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...request,
      idempotencyKey: 'training-e2e-novice-four-week-deload',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.phaseRoadmap.at(-1)).toMatchObject({ weekNumber: 4, phase: 'deload' });

    const persistedWeeks = harness.db.prepare(`
      SELECT week_number, focus, intensity_pct
        FROM training_weeks
       WHERE plan_id = ?
       ORDER BY week_number
    `).all(Number(created.body.data.planId)) as Array<{
      week_number: number;
      focus: string;
      intensity_pct: number;
    }>;
    expect(persistedWeeks.at(-1)).toMatchObject({
      week_number: 4,
      focus: 'deload',
      intensity_pct: expect.any(Number),
    });
    expect(Number(persistedWeeks.at(-1)?.intensity_pct)).toBeLessThanOrEqual(58);

    const readModel = await harness.dispatch('GET', '/plan/weeks');
    expect(readModel.statusCode).toBe(200);
    expect(readModel.body.data.weeks.at(-1)).toMatchObject({
      weekNumber: 4,
      phase: 'deload',
      intensityPct: expect.any(Number),
    });

    const quality = scoreTrainingPlanQuality({
      objective: request.objective,
      goalMode: request.goalMode,
      weeks: readModel.body.data.weeks.map((week: any) => ({
        weekNumber: Number(week.weekNumber),
        phase: String(week.phase),
        sessions: (week.sessions ?? []).map((session: any) => ({
          id: String(session.id),
          weekNumber: Number(week.weekNumber),
          dayOfWeek: String(session.dayOfWeek),
          sport: 'strength' as const,
          title: String(session.title),
          sessionType: String(session.sessionType),
          durationMinutes: Number(session.durationMinutes),
          intensity: 'moderate' as const,
        })),
      })),
    });
    expect(quality.dimensions.find((dimension) => dimension.dimension === 'deload_logic')?.blockers)
      .toEqual([]);
  });

  it('preserves the exact hybrid run-strength request and an easy/recovery session through the real route', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    upsertProfile('fitness', {
      experience_level: 'Intermediate (1-3 years)',
      weekly_frequency: '4-5 days',
      preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
      blocked_days: 'Friday',
      training_goals: 'Endurance, Strength',
      injuries: 'none',
      available_equipment: 'Full gym',
    });
    upsertProfile('triathlon-gym', {
      training_age: '3-5 years',
      current_split: 'No preference',
      primary_goal: 'Support other sports',
      squat_1rm_kg: '115',
      bench_1rm_kg: '82',
      deadlift_1rm_kg: '150',
      sessions_per_week: '1-2',
      preferred_training_days: 'Monday, Tuesday, Thursday, Saturday',
      blocked_days: 'Friday',
      equipment_access: 'Full commercial gym',
      session_duration_minutes: '60',
    });
    upsertProfile('triathlon-running', {
      weekly_mileage_km: '32',
      longest_recent_run_km: '14',
      easy_pace_min_per_km: '5:45',
      target_race: 'None — general fitness',
      target_race_date: 'none',
      preferred_workouts: 'Easy runs, Tempo, Long runs',
      injury_history: 'none',
      weekly_availability_days: '5',
      preferred_training_days: 'Tuesday, Thursday, Saturday, Sunday',
      blocked_days: 'Friday',
    });

    const request = {
      objective: 'Hybrid running and strength consistency',
      durationWeeks: 4,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 3,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 2,
      startPolicy: 'today',
      longWorkoutDay: 'Saturday',
      goalMode: 'continuous',
      trainingPriority: 'hybrid',
      twoADayPreference: 'never',
      calendarSource: null,
    };

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...request,
      idempotencyKey: 'training-e2e-hybrid-run-strength-contract',
    });
    expect(created.statusCode).toBe(201);

    const readModel = await harness.dispatch('GET', '/plan/weeks');
    expect(readModel.statusCode).toBe(200);
    const weeklyMix = readModel.body.data.weeks.map((week: any) => ({
      weekNumber: Number(week.weekNumber),
      running: week.sessions.filter((session: any) => /run/.test(String(session.sessionType).toLowerCase())).length,
      strength: week.sessions.filter((session: any) => /gym|strength|lift/.test(String(session.sessionType).toLowerCase())).length,
      distinctDays: new Set(week.sessions.map((session: any) => String(session.day).toLowerCase())).size,
      titles: week.sessions.map((session: any) => String(session.title)),
    }));

    expect(
      weeklyMix.map(({ weekNumber, running, strength }: any) => ({ weekNumber, running, strength })),
      JSON.stringify(weeklyMix),
    )
      .toEqual([
        { weekNumber: 1, running: 3, strength: 2 },
        { weekNumber: 2, running: 3, strength: 2 },
        { weekNumber: 3, running: 3, strength: 2 },
        { weekNumber: 4, running: 3, strength: 2 },
      ]);
    expect(
      weeklyMix.every((week: any) => week.distinctDays === 5),
      JSON.stringify(weeklyMix),
    ).toBe(true);
    expect(created.body.data.volumeShortfalls ?? []).toEqual([]);
    expect(weeklyMix.flatMap((week: any) => week.titles).some((title: string) => /easy|recover/i.test(title)))
      .toBe(true);
  });

  it('accepts a canonical 25m-indoor swim profile through preview, strict preflight, and persistence', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    upsertProfile('triathlon-running', {
      weekly_mileage_km: '32',
      longest_recent_run_km: '14',
      easy_pace_min_per_km: '5:45',
      target_race: 'None — general fitness',
      target_race_date: 'none',
      preferred_workouts: 'Easy runs, Tempo, Long runs',
      injury_history: 'none',
      weekly_availability_days: '5',
    });
    upsertProfile('triathlon-cycling', {
      ftp_watts: '245',
      weekly_hours: '3-6 hours',
      primary_discipline: 'Road',
      target_event: 'Triathlon bike leg',
      power_meter: 'Indoor only (smart trainer)',
      terrain_preference: 'Mixed',
      weekly_availability_days: '3',
    });
    upsertProfile('triathlon-swim', {
      experience: 'Fitness swimmer',
      primary_stroke: 'Freestyle',
      time_400m_freestyle_min: '8:00',
      pool_access: '25m indoor',
      goal: 'Triathlon swim leg',
      sessions_per_week: '2',
      equipment_access: 'Pull buoy, Fins, Kickboard',
    });

    const request = {
      objective: 'Triathlon discipline balance',
      durationWeeks: 4,
      preferredTime: '07:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '18:00',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      startPolicy: 'today',
      longWorkoutDay: 'Saturday',
      goalMode: 'continuous',
      trainingPriority: 'triathlon',
      twoADayPreference: 'never',
      calendarSource: null,
    };

    const preview = await harness.dispatch('POST', '/plan/preview', request);
    expect(preview.statusCode).toBe(200);
    // Stronger guarantee: an accepted pool answer must reach a schedulable,
    // intensity-safe multisport plan, not merely clear the pool preflight.
    expect(ruleIds(preview.body.data.planLint.blockers)).not.toEqual(expect.arrayContaining([
      'swim_pool_access_required',
      'endurance_hard_easy_balance',
      'endurance_interval_density',
    ]));

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...request,
      idempotencyKey: 'training-e2e-canonical-pool-access',
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(ruleIds(created.body.data.planLint.blockers)).not.toEqual(expect.arrayContaining([
      'swim_pool_access_required',
      'endurance_hard_easy_balance',
      'endurance_interval_density',
    ]));
    const planId = Number(created.body.data.planId);
    const sessions = persistedSessions(planId);
    expect(sessions.filter((session) => /swim/i.test(session.sessionType)), JSON.stringify({
      sessions,
      weeklyTargets: created.body.data.weeklyTargets,
      volumeShortfalls: created.body.data.volumeShortfalls,
      decisionReasons: created.body.data.decisionReasons,
      warnings: created.body.data.warnings,
    })).toHaveLength(8);
    const weeklyMix = [1, 2, 3, 4].map((weekNumber) => {
      const weekSessions = sessions.filter((session) => session.weekNumber === weekNumber);
      return Object.fromEntries(['running', 'cycling', 'swimming', 'strength'].map((modality) => [
        modality,
        weekSessions.filter((session) => sessionModality(session) === modality).length,
      ]));
    });
    expect(weeklyMix, JSON.stringify({
      sessions,
      weeklyTargets: created.body.data.weeklyTargets,
      volumeShortfalls: created.body.data.volumeShortfalls,
      decisionReasons: created.body.data.decisionReasons,
    })).toEqual([
      { running: 2, cycling: 1, swimming: 2, strength: 1 },
      { running: 2, cycling: 1, swimming: 2, strength: 1 },
      { running: 2, cycling: 1, swimming: 2, strength: 1 },
      { running: 2, cycling: 1, swimming: 2, strength: 1 },
    ]);
  });

  it.each(weeklyTargetCases)('$id: persists and reports weekly targets from the final scheduled plan matrix', async (planCase) => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();
    if (
      planCase.id === 'triathlon-zero-bike-swim-floor'
      || planCase.id === 'cycling-nonzero-bike-passthrough'
    ) {
      seedCompleteSportProfile('triathlon-cycling');
    }
    if (planCase.id === 'triathlon-zero-bike-swim-floor') {
      seedCompleteSportProfile('triathlon-swim');
    }

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...planCase.body,
      idempotencyKey: `training-e2e-targets-${planCase.id}`,
    });
    const planId = Number(created.body.data.planId);
    const preferences = persistedPreferences(planId);
    const scheduledTargets = scheduledWeeklyTargetsForPlan(planId);

    expect(created.statusCode, planCase.id).toBe(201);
    expect(created.body.ok).toBe(true);
    // Stronger F8/F10 guarantee: flat response/persistence targets are the
    // realized plan and are proven against session rows below. The original
    // request remains auditable under its explicitly named namespace.
    expect(preferences.requestedTargets).toMatchObject(planCase.requested);
    expectWeeklyTargetsToMatchScheduled(created.body.data.weeklyTargets, scheduledTargets);
    expectWeeklyTargetsToMatchScheduled(preferences, scheduledTargets);
    if ('expectedDistinctTrainingDays' in planCase) {
      const sessions = persistedSessions(planId);
      expect(created.body.data.weeklyTargets.sessionsPerWeek).toBe(planCase.expectedDistinctTrainingDays);
      expect(preferences.sessionsPerWeek).toBe(planCase.expectedDistinctTrainingDays);
      expect(scheduledTargets.sessionsPerWeek).toBe(planCase.expectedDistinctTrainingDays);
      expect(sessions.length).toBeGreaterThan(planCase.expectedDistinctTrainingDays);
    }
  });

  it('persists every supported two-a-day preference on create', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    const preferences = ['preferred', 'optional', 'never'] as const;

    for (const twoADayPreference of preferences) {
      harness = createTrainingE2EHarness();
      harness.seedTrainingUser();

      const created = await harness.dispatch('POST', '/plan/generate', {
        ...bugReproducerBody,
        runSessionsPerWeek: 3,
        strengthSessionsPerWeek: 2,
        twoADayPreference,
        durationWeeks: 1,
        idempotencyKey: `training-e2e-two-a-day-${twoADayPreference}`,
      });

      expect(created.statusCode).toBe(201);
      expect(created.body.ok).toBe(true);
      const persistedPreferences = harness.db.prepare(`
        SELECT preferences_json
          FROM fitness_training_plans
         WHERE id = ?
      `).get(created.body.data.planId) as { preferences_json: string };
      expect(JSON.parse(persistedPreferences.preferences_json)).toMatchObject({
        twoADayPreference,
      });

      harness.close();
      harness = null;
    }
  });

  it('accepts explicit auto calendar source and falls back to provider preference mode', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const res = await harness.dispatch('POST', '/plan/preview', {
      ...bugReproducerBody,
      calendarSource: 'auto',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.status).toBe('preview');
    expect(res.body.data.calendarSource).toBe('outlook');
    expect(calendarMocks.getEventsForSources).toHaveBeenCalledWith('2026-05-25', '2026-06-08', 12, ['outlook']);
  });

  it('can generate, cancel, and generate again without leaving an active plan behind', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      durationWeeks: 1,
      idempotencyKey: 'training-e2e-cycle-first',
    });
    expect(first.statusCode).toBe(201);
    const firstPlanId = Number(first.body.data.planId);
    expect(firstPlanId).toBeGreaterThan(0);
    expect(countActivePlans()).toBe(1);

    // Phase 1B: link the provider events through the background chain BEFORE
    // cancelling, so cancellation has real provider events to delete — the
    // deleteEvent assertion below still guards the cleanup invariant.
    await drainTrainingCalendarSync();
    expect(countLinkedSessions(firstPlanId)).toBeGreaterThan(0);

    const cancel = await harness.dispatch('POST', '/plan/cancel', { planId: firstPlanId });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.body.ok).toBe(true);
    expect(cancel.body.data).toMatchObject({
      cancelled: true,
      planId: firstPlanId,
      removedPlans: 1,
    });
    expect(countActivePlans()).toBe(0);
    expect(countLiveSecretaryAgendaItems()).toBe(0);
    expect(calendarMocks.deleteEvent).toHaveBeenCalled();

    const second = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      durationWeeks: 1,
      idempotencyKey: 'training-e2e-cycle-second',
    });
    expect(second.statusCode).toBe(201);
    expect(Number(second.body.data.planId)).not.toBe(firstPlanId);
    expect(countActivePlans()).toBe(1);
  });

  it('keeps preview and create weekly targets identical when time advances between the calls', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const preview = await harness.dispatch('POST', '/plan/preview', {
      ...bugReproducerBody,
      durationWeeks: 1,
    });
    expect(preview.statusCode).toBe(200);

    // The user reviews the preview for six minutes before confirming — the
    // historical "persisted != scheduled" defect class lived exactly in
    // this gap (readiness/deload signals shifting between the two calls).
    vi.setSystemTime(new Date('2026-05-25T10:06:00.000Z'));

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      durationWeeks: 1,
      idempotencyKey: 'training-e2e-preview-create-drift',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body.data.resolvedStartDate).toBe(preview.body.data.resolvedStartDate);
    expect(created.body.data.weeklyTargets).toEqual(preview.body.data.weeklyTargets);
    expect(created.body.data.volumeShortfalls).toEqual(preview.body.data.volumeShortfalls);
    expect(created.body.data.totalSessions).toBe(preview.body.data.totalSessions);
    expect(persistedPreferences(Number(created.body.data.planId)).volumeShortfalls)
      .toEqual(created.body.data.volumeShortfalls);
  });

  it('reports create-response weekly targets that match the persisted schedule', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const created = await harness.dispatch('POST', '/plan/generate', {
      ...bugReproducerBody,
      durationWeeks: 2,
      idempotencyKey: 'training-e2e-persisted-equals-scheduled',
    });
    expect(created.statusCode).toBe(201);

    const sessions = persistedSessions(Number(created.body.data.planId));
    const isRun = (type: string) => type === 'run' || type === 'long_run' || type.endsWith('_run');
    const isGym = (type: string) => type === 'gym' || type === 'lift' || type.startsWith('strength');
    // weeklyTargets are counted from the finalized plan with per-week MAX
    // semantics — mirror that here against what actually persisted.
    const weeks = harness.db.prepare(
      'SELECT id FROM training_weeks WHERE plan_id = ? ORDER BY week_number',
    ).all(Number(created.body.data.planId)) as Array<{ id: number }>;
    let maxRuns = 0;
    let maxGym = 0;
    for (const week of weeks) {
      const rows = harness.db.prepare(
        'SELECT session_type FROM training_sessions WHERE week_id = ?',
      ).all(week.id) as Array<{ session_type: string }>;
      maxRuns = Math.max(maxRuns, rows.filter((row) => isRun(String(row.session_type).toLowerCase())).length);
      maxGym = Math.max(maxGym, rows.filter((row) => isGym(String(row.session_type).toLowerCase())).length);
    }
    expect(sessions.length).toBeGreaterThan(0);
    expect(created.body.data.weeklyTargets.runSessionsPerWeek).toBe(maxRuns);
    expect(created.body.data.weeklyTargets.strengthSessionsPerWeek).toBe(maxGym);

    // B9: preferences carry BOTH the realized targets (flat keys, asserted
    // by the matrix test) and the original user ask for re-edit flows.
    const preferences = persistedPreferences(Number(created.body.data.planId));
    expect(preferences.requestedTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
    expect(preferences.volumeShortfalls).toEqual(created.body.data.volumeShortfalls);

    // getAllPlanWeeks renders the per-week learning focus FROM
    // preferences_json — generation must persist the attached learning
    // path or the Plan zone can never show it for fresh plans (isolated
    // Training E2E finding, 2026-07-02: the key was dropped in the
    // 4.14.210 mainline rebase).
    expect(preferences.trainingLearningPath).toBeTruthy();
    expect(Array.isArray(preferences.trainingLearningPath?.weeklyPath)).toBe(true);
    expect(preferences.trainingLearningPath.weeklyPath.length).toBeGreaterThan(0);
  });
});

function ruleIds(findings: Array<{ ruleId?: string }> | undefined): string[] {
  return (findings ?? []).map((finding) => String(finding.ruleId ?? ''));
}

function persistedSessions(planId: number): Array<{
  weekNumber: number;
  dayOfWeek: string;
  sessionType: string;
  title: string;
  exercises: Array<Record<string, any>>;
}> {
  if (!harness) return [];
  const rows = harness.db.prepare(`
    SELECT w.week_number, s.day_of_week, s.session_type, s.title, s.exercises_json
      FROM training_sessions s
      JOIN training_weeks w ON w.id = s.week_id
     WHERE s.plan_id = ?
     ORDER BY s.id
  `).all(planId) as Array<{
    week_number: number;
    day_of_week: string;
    session_type: string;
    title: string;
    exercises_json: string | null;
  }>;

  return rows.map((row) => ({
    weekNumber: row.week_number,
    dayOfWeek: row.day_of_week,
    sessionType: row.session_type,
    title: row.title,
    exercises: parseExercises(row.exercises_json),
  }));
}

function seedCompleteSportProfile(profileType: string, userId = 12): void {
  if (!harness) return;
  const questionnaire = getQuestionnaire(profileType);
  if (!questionnaire) throw new Error(`Missing questionnaire fixture: ${profileType}`);
  const data = Object.fromEntries(questionnaire.steps.map((step) => [
    step.key,
    Array.isArray(step.options) && step.options.length > 0
      ? step.options[0]
      : step.type === 'number'
        ? 1
        : 'test',
  ]));
  harness.db.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET
      data = excluded.data,
      updated_at = datetime('now')
  `).run(userId, profileType, JSON.stringify(data));
}

function upsertProfile(profileType: string, data: Record<string, unknown>, userId = 12): void {
  if (!harness) return;
  harness.db.prepare(`
    INSERT INTO user_profiles (user_id, profile_type, data)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, profile_type) DO UPDATE SET
      data = excluded.data,
      updated_at = datetime('now')
  `).run(userId, profileType, JSON.stringify(data));
}

function persistedPreferences(planId: number): Record<string, any> {
  if (!harness) return {};
  const row = harness.db.prepare(`
    SELECT preferences_json
      FROM fitness_training_plans
     WHERE id = ?
  `).get(planId) as { preferences_json: string } | undefined;
  return row ? JSON.parse(row.preferences_json) : {};
}

function scheduledWeeklyTargetsForPlan(planId: number): {
  sessionsPerWeek: number;
  runSessionsPerWeek: number;
  bikeSessionsPerWeek: number;
  swimSessionsPerWeek: number;
  strengthSessionsPerWeek: number;
} {
  const trainingDays = new Set<string>();
  const counts = {
    sessionsPerWeek: 0,
    runSessionsPerWeek: 0,
    bikeSessionsPerWeek: 0,
    swimSessionsPerWeek: 0,
    strengthSessionsPerWeek: 0,
  };
  for (const session of persistedSessions(planId)) {
    trainingDays.add(String(session.dayOfWeek).toLowerCase());
    const modality = sessionModality(session);
    if (modality === 'running') counts.runSessionsPerWeek += 1;
    if (modality === 'cycling') counts.bikeSessionsPerWeek += 1;
    if (modality === 'swimming') counts.swimSessionsPerWeek += 1;
    if (modality === 'strength') counts.strengthSessionsPerWeek += 1;
  }
  counts.sessionsPerWeek = trainingDays.size;
  return counts;
}

function expectWeeklyTargetsToMatchScheduled(
  actual: Record<string, any>,
  scheduled: ReturnType<typeof scheduledWeeklyTargetsForPlan>,
): void {
  for (const field of [
    'sessionsPerWeek',
    'runSessionsPerWeek',
    'bikeSessionsPerWeek',
    'swimSessionsPerWeek',
    'strengthSessionsPerWeek',
  ] as const) {
    if (scheduled[field] > 0 || actual[field] != null) {
      expect(actual[field] ?? 0).toBe(scheduled[field]);
    }
  }
}

function sessionModality(session: { sessionType: string; title: string }): 'running' | 'cycling' | 'swimming' | 'strength' | null {
  const text = `${session.sessionType} ${session.title}`.toLowerCase();
  if (/\b(gym|strength|lift)\b/.test(text)) return 'strength';
  if (/\b(swim|swimming)\b/.test(text)) return 'swimming';
  if (/\b(ride|bike|cycling|cycle)\b/.test(text)) return 'cycling';
  if (/\b(run|running|jog)\b/.test(text)) return 'running';
  return null;
}

function countActivePlans(): number {
  if (!harness) return 0;
  const row = harness.db.prepare(`
    SELECT COUNT(*) AS count
      FROM fitness_training_plans
     WHERE status = 'active'
  `).get() as { count: number };
  return Number(row.count);
}

function countLiveSecretaryAgendaItems(): number {
  if (!harness) return 0;
  const row = harness.db.prepare(`
    SELECT COUNT(*) AS count
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'proposed')
  `).get(12) as { count: number };
  return Number(row.count);
}

function countTwoADayTrainingDays(sessions: Array<{ dayOfWeek: string }>): number {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const day = session.dayOfWeek.toLowerCase();
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count >= 2).length;
}

function hasWorkoutContentCalendarBody(description: unknown): boolean {
  const text = String(description ?? '').trim();
  if (text.length < 120) return false;
  if (text.startsWith('NEXUS_TRAINING_EVENT')) return false;

  const lower = text.toLowerCase();
  return (
    lower.includes('warm') ||
    lower.includes('main') ||
    lower.includes('cool') ||
    lower.includes('sets') ||
    lower.includes('reps') ||
    lower.includes('rpe') ||
    lower.includes('pace') ||
    lower.includes('zone')
  );
}

function parseExercises(value: string | null): Array<Record<string, any>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
