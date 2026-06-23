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

let harness: TrainingE2EHarness | null = null;

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
      runSessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
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
    expect(res.body.data.eventsCreated).toBeGreaterThan(0);
    expect(res.body.data.calendarSync.sessionsLinked).toBe(res.body.data.eventsCreated);

    const sessions = persistedSessions(Number(res.body.data.planId));
    expect(countTwoADayTrainingDays(sessions)).toBeGreaterThanOrEqual(3);
    const longRun = sessions.find((session) => inferTrainingSessionIsLongRun(session));
    expect(longRun?.dayOfWeek.toLowerCase()).toBe('saturday');

    const protectedDay = dayBefore[String(longRun?.dayOfWeek ?? '').toLowerCase()];
    expect(protectedDay).toBe('friday');
    expect(sessions.filter((session) => session.dayOfWeek.toLowerCase() === protectedDay)
      .some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
    expect(calendarMocks.createEvent).toHaveBeenCalled();
    expect(calendarMocks.createEvent.mock.calls.length).toBe(res.body.data.eventsCreated);
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
      calendarSync: {
        provider: 'outlook',
        sessionsAttempted: expect.any(Number),
        eventsCreated: expect.any(Number),
        sessionsLinked: expect.any(Number),
        sessionsFailed: expect.any(Number),
        unscheduled: expect.any(Number),
        status: expect.stringMatching(/^(synced|partial|not_synced)$/),
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
    expect(created.body.data.calendarSync.sessionsLinked).toBeGreaterThan(0);
    expect(created.body.data.calendarSync.sessionsLinked).toBe(created.body.data.eventsCreated);
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
});

function ruleIds(findings: Array<{ ruleId?: string }> | undefined): string[] {
  return (findings ?? []).map((finding) => String(finding.ruleId ?? ''));
}

function persistedSessions(planId: number): Array<{
  dayOfWeek: string;
  sessionType: string;
  title: string;
  exercises: Array<Record<string, any>>;
}> {
  if (!harness) return [];
  const rows = harness.db.prepare(`
    SELECT day_of_week, session_type, title, exercises_json
      FROM training_sessions
     WHERE plan_id = ?
     ORDER BY id
  `).all(planId) as Array<{
    day_of_week: string;
    session_type: string;
    title: string;
    exercises_json: string | null;
  }>;

  return rows.map((row) => ({
    dayOfWeek: row.day_of_week,
    sessionType: row.session_type,
    title: row.title,
    exercises: parseExercises(row.exercises_json),
  }));
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
