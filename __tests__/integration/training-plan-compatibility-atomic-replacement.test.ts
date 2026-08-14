import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calendarMocks,
  createTrainingE2EHarness,
  type TrainingE2EHarness,
} from './training-e2e-harness';

let harness: TrainingE2EHarness | null = null;

const replacementBody = {
  objective: 'Lisbon Marathon October 2026',
  durationWeeks: 1,
  preferredTime: '07:00',
  preferredCardioTime: '07:00',
  preferredStrengthTime: '18:00',
  sessionsPerWeek: 4,
  runSessionsPerWeek: 3,
  strengthSessionsPerWeek: 1,
  startPolicy: 'today',
  longWorkoutDay: 'Saturday',
  goalMode: 'event_based',
  trainingPriority: 'running',
  raceDate: '2026-10-18',
  twoADayPreference: 'never',
  calendarSource: 'outlook',
};

describe('compatibility Training plan atomic replacement', () => {
  afterEach(() => {
    vi.useRealTimers();
    harness?.close();
    harness = null;
  });

  it('retains the prior graph as superseded and commits exactly one active replacement with its outbox', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      idempotencyKey: 'compatibility-atomic-first',
    });
    expect(first.statusCode).toBe(201);
    const priorPlanId = Number(first.body.data.planId);
    const priorSessionCount = Number((harness.db.prepare(`
      SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?
    `).get(priorPlanId) as { count: number }).count);

    const second = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'replacement candidate',
      idempotencyKey: 'compatibility-atomic-second',
    });
    expect(second.statusCode).toBe(201);
    const replacementPlanId = Number(second.body.data.planId);

    // Stronger F6 guarantee: replacement is a single local commit. The old
    // graph remains auditable, while only the complete new graph is active.
    expect(harness.db.prepare(`
      SELECT id, status FROM fitness_training_plans
       WHERE id IN (?, ?) ORDER BY id
    `).all(priorPlanId, replacementPlanId)).toEqual([
      { id: priorPlanId, status: 'superseded' },
      { id: replacementPlanId, status: 'active' },
    ]);
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM training_sessions WHERE plan_id = ?
    `).get(priorPlanId)).toEqual({ count: priorSessionCount });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM fitness_training_plans
       WHERE user_id = 12 AND tenant_id = 12 AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM event_outbox
       WHERE event_type = 'training.plan_calendar_sync.requested.v1'
         AND entity_id = ?
    `).get(String(replacementPlanId))).toEqual({ count: 1 });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });

  it('rolls the complete replacement back when the old-to-superseded CAS fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      idempotencyKey: 'compatibility-cas-first',
    });
    expect(first.statusCode).toBe(201);
    const priorPlanId = Number(first.body.data.planId);
    const planCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get() as { count: number }).count);
    const outboxCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get() as { count: number }).count);
    calendarMocks.createEvent.mockClear();
    harness.db.exec(`
      CREATE TRIGGER inject_training_supersede_failure
      BEFORE UPDATE OF status ON fitness_training_plans
      WHEN OLD.status = 'active' AND NEW.status = 'superseded'
      BEGIN
        SELECT RAISE(ABORT, 'injected supersede failure');
      END;
    `);

    const failed = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'must roll back',
      idempotencyKey: 'compatibility-cas-second',
    });

    expect(failed.statusCode).toBe(500);
    expect(harness.db.prepare(`
      SELECT id, status FROM fitness_training_plans WHERE id = ?
    `).get(priorPlanId)).toEqual({ id: priorPlanId, status: 'active' });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get()).toEqual({ count: planCountBefore });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get()).toEqual({ count: outboxCountBefore });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });

  it('restores the prior active plan when calendar-outbox enqueue fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      idempotencyKey: 'compatibility-outbox-first',
    });
    expect(first.statusCode).toBe(201);
    const priorPlanId = Number(first.body.data.planId);
    const planCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get() as { count: number }).count);
    const outboxCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get() as { count: number }).count);
    calendarMocks.createEvent.mockClear();
    harness.db.exec(`
      CREATE TRIGGER inject_training_outbox_failure
      BEFORE INSERT ON event_outbox
      WHEN NEW.event_type = 'training.plan_calendar_sync.requested.v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected outbox failure');
      END;
    `);

    const failed = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'outbox must be atomic',
      idempotencyKey: 'compatibility-outbox-second',
    });

    expect(failed.statusCode).toBe(500);
    expect(harness.db.prepare(
      'SELECT id, status FROM fitness_training_plans WHERE id = ?',
    ).get(priorPlanId)).toEqual({ id: priorPlanId, status: 'active' });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get()).toEqual({ count: planCountBefore });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get()).toEqual({ count: outboxCountBefore });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });

  it('rolls activation back when committing the idempotent replay payload fails', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      idempotencyKey: 'compatibility-idempotency-first',
    });
    expect(first.statusCode).toBe(201);
    const priorPlanId = Number(first.body.data.planId);
    const planCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get() as { count: number }).count);
    const outboxCountBefore = Number((harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get() as { count: number }).count);
    harness.db.exec(`
      CREATE TRIGGER inject_training_idempotency_completion_failure
      BEFORE UPDATE OF status ON training_plan_generation_idempotency_scoped
      WHEN NEW.status = 'succeeded'
        AND NEW.idempotency_key = 'compatibility-idempotency-second'
      BEGIN
        SELECT RAISE(ABORT, 'injected idempotency completion failure');
      END;
    `);

    const failed = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'response replay state must be atomic',
      idempotencyKey: 'compatibility-idempotency-second',
    });

    expect(failed.statusCode).toBe(500);
    expect(harness.db.prepare(
      'SELECT id, status FROM fitness_training_plans WHERE id = ?',
    ).get(priorPlanId)).toEqual({ id: priorPlanId, status: 'active' });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM fitness_training_plans',
    ).get()).toEqual({ count: planCountBefore });
    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM event_outbox',
    ).get()).toEqual({ count: outboxCountBefore });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent replacement snapshots activate', async () => {
    vi.useFakeTimers({
      now: new Date('2026-05-25T10:00:00.000Z'),
      toFake: ['Date'],
    });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const firstPending = harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'concurrent candidate one',
      idempotencyKey: 'compatibility-concurrent-one',
    });
    await Promise.resolve();
    const secondPending = harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'concurrent candidate two',
      idempotencyKey: 'compatibility-concurrent-two',
    });

    const outcomes = await Promise.all([firstPending, secondPending]);
    expect(outcomes.map((outcome) => outcome.statusCode).sort()).toEqual([201, 409]);
    expect(outcomes.find((outcome) => outcome.statusCode === 409)?.body?.error?.code
      ?? outcomes.find((outcome) => outcome.statusCode === 409)?.body?.code)
      .toBe('TRAINING_PLAN_REPLACEMENT_CONFLICT');
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM fitness_training_plans
       WHERE user_id = 12 AND tenant_id = 12 AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM fitness_training_plans
       WHERE user_id = 12 AND tenant_id = 12
    `).get()).toEqual({ count: 1 });
  });

  it('rejects a worker whose idempotency ownership is stolen before the commit boundary', async () => {
    vi.useFakeTimers({ now: new Date('2026-05-25T10:00:00.000Z') });
    harness = createTrainingE2EHarness();
    harness.seedTrainingUser();

    const first = await harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      idempotencyKey: 'compatibility-fence-first',
    });
    expect(first.statusCode).toBe(201);
    const priorPlanId = Number(first.body.data.planId);
    calendarMocks.createEvent.mockClear();

    let releaseAvailability!: (events: never[]) => void;
    calendarMocks.getEventsForSources.mockImplementationOnce(() => new Promise((resolve) => {
      releaseAvailability = resolve;
    }));
    const pending = harness.dispatch('POST', '/plan/generate', {
      ...replacementBody,
      notes: 'stale owner must not activate',
      idempotencyKey: 'compatibility-fence-stale',
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const row = harness.db.prepare(`
        SELECT idempotency_key FROM training_plan_generation_idempotency_scoped
         WHERE idempotency_key = 'compatibility-fence-stale'
      `).get();
      if (row) break;
      await Promise.resolve();
    }
    harness.db.prepare(`
      UPDATE training_plan_generation_idempotency_scoped
         SET lease_owner = 'replacement-owner',
             fencing_token = 'replacement-token',
             lease_expires_at = '2026-05-25T11:00:00.000Z'
       WHERE user_id = 12 AND tenant_id = 12
         AND idempotency_key = 'compatibility-fence-stale'
    `).run();
    releaseAvailability([]);

    const failed = await pending;
    expect(failed.statusCode).toBe(409);
    expect(failed.body?.error?.code ?? failed.body?.code).toBe('TRAINING_PLAN_GENERATION_LEASE_LOST');
    expect(harness.db.prepare(`
      SELECT id, status FROM fitness_training_plans WHERE id = ?
    `).get(priorPlanId)).toEqual({ id: priorPlanId, status: 'active' });
    expect(harness.db.prepare(`
      SELECT COUNT(*) AS count FROM fitness_training_plans
       WHERE user_id = 12 AND tenant_id = 12 AND status = 'active'
    `).get()).toEqual({ count: 1 });
    expect(calendarMocks.createEvent).not.toHaveBeenCalled();
  });
});
