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

    const sessions = persistedSessions(Number(res.body.data.planId));
    const longRun = sessions.find((session) => inferTrainingSessionIsLongRun(session));
    expect(longRun?.dayOfWeek.toLowerCase()).toBe('saturday');

    const protectedDay = dayBefore[String(longRun?.dayOfWeek ?? '').toLowerCase()];
    expect(protectedDay).toBe('friday');
    expect(sessions.filter((session) => session.dayOfWeek.toLowerCase() === protectedDay)
      .some((session) => inferTrainingSessionIsLowerHeavy(session))).toBe(false);
    expect(calendarMocks.createEvent).toHaveBeenCalled();
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
    expect(res.body.data.calendarSource).toBeNull();
    expect(calendarMocks.getEvents).toHaveBeenCalledWith('2026-05-25', '2026-06-08', 12);
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

function parseExercises(value: string | null): Array<Record<string, any>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
