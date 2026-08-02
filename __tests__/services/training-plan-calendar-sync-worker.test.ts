// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Phase 1B — training plan calendar-sync worker.
 *
 * Provider calendar effects moved here from the inline persistence loop.
 * These tests exercise the full durable chain against a real migrated
 * database: outbox event → '*' router enqueue → dedicated worker drain →
 * provider write + session linkage + ownership + plan-level consistency
 * state. Only the provider boundary (unified-calendar) and the Secretary
 * arbitration surface are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockMarkSecretaryAgendaProviderSyncSatisfied = vi.fn();
const mockMarkSecretaryAgendaProviderCleanupRequired = vi.fn();
const mockLoadLiveCalendarBusyWindowsForSecretaryIntent = vi.fn();
const mockRecordCalendarOwnership = vi.fn();

vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  );
  return {
    ...actual,
    createEvent: (...args: unknown[]) => mockCreateEvent(...args),
    deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
  };
});

vi.mock('../../src/services/secretary-scheduling-arbitrator', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/secretary-scheduling-arbitrator')>(
    '../../src/services/secretary-scheduling-arbitrator',
  );
  return {
    ...actual,
    submitSecretarySchedulingIntent: (...args: unknown[]) => mockSubmitSecretarySchedulingIntent(...args),
    markSecretaryAgendaProviderSyncSatisfied: (...args: unknown[]) => mockMarkSecretaryAgendaProviderSyncSatisfied(...args),
    markSecretaryAgendaProviderCleanupRequired: (...args: unknown[]) => mockMarkSecretaryAgendaProviderCleanupRequired(...args),
  };
});

vi.mock('../../src/services/secretary-live-calendar-busy', () => ({
  loadLiveCalendarBusyWindowsForSecretaryIntent: (...args: unknown[]) =>
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent(...args),
}));

// Ownership recording delegates to the real implementation unless a test
// installs an implementation — the ownership-failure compensation path needs
// a forced failure that the real recorder cannot produce on a healthy DB.
vi.mock('../../src/services/training-plan-lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-plan-lifecycle')>(
    '../../src/services/training-plan-lifecycle',
  );
  return {
    ...actual,
    recordCalendarOwnership: (...args: unknown[]) => {
      const implementation = mockRecordCalendarOwnership.getMockImplementation();
      return implementation
        ? mockRecordCalendarOwnership(...args)
        : actual.recordCalendarOwnership(...(args as [any]));
    },
  };
});

// Same delegating pattern for the local linkage write: the
// created-provider-event compensation path needs a link failure the real
// implementation cannot produce on a healthy database.
const mockLinkSessionToCalendar = vi.fn();
vi.mock('../../src/services/training-plans', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-plans')>(
    '../../src/services/training-plans',
  );
  return {
    ...actual,
    linkSessionToCalendar: (...args: unknown[]) => {
      const implementation = mockLinkSessionToCalendar.getMockImplementation();
      return implementation
        ? mockLinkSessionToCalendar(...args)
        : actual.linkSessionToCalendar(...(args as [number, string, string]));
    },
  };
});

import type Database from 'better-sqlite3';
import { withDatabaseForTestAsync } from '../../src/services/database';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';
import { emitDomainEvent, processPendingEvents } from '../../src/services/event-outbox';
import { enqueueJob } from '../../src/services/background-job-queue';
import * as trainingPlans from '../../src/services/training-plans';
import { incrementPlanVersion } from '../../src/services/training-plan-lifecycle';
import { acquireTrainingCalendarOperationLock, _resetTrainingOperationLocksForTests } from '../../src/services/training-operation-locks';
import {
  TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
  TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
  processTrainingPlanCalendarSyncJobs,
  trainingCalendarCreateBatchSize,
} from '../../src/services/training-plan-calendar-sync-worker';

const USER_ID = 7;
const TENANT_ID = 7;

function futureIso(hoursFromNow: number): string {
  return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
}

function seedPlan(options: {
  status?: 'active' | 'pending_activation';
  sessionCount?: number;
  sessionOverrides?: Array<Partial<Parameters<typeof trainingPlans.createSession>[0]>>;
} = {}): { plan: trainingPlans.TrainingPlan; sessionIds: number[] } {
  const plan = trainingPlans.createPlan({
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    name: 'Phase 1B Plan',
    sport: 'running',
    goal: 'Marathon build',
    duration_weeks: 1,
    periodization: 'block',
    start_date: '2026-08-03',
    end_date: '2026-08-10',
    preferences_json: '{"preferredTime":"07:00"}',
    status: options.status ?? 'active',
  });
  const week = trainingPlans.createWeek({
    plan_id: plan.id,
    week_number: 1,
    focus: 'base',
    intensity_pct: 70,
    volume_sessions: options.sessionCount ?? 2,
  });
  const sessionIds: number[] = [];
  const count = options.sessionCount ?? 2;
  for (let index = 0; index < count; index += 1) {
    const session = trainingPlans.createSession({
      week_id: week.id,
      plan_id: plan.id,
      day_of_week: 'Monday',
      session_type: index % 2 === 0 ? 'run' : 'gym',
      title: `Session ${index + 1}`,
      description: `Session ${index + 1} description.`,
      duration_minutes: 50,
      intensity_text: 'RPE 70%',
      session_identity_key: `plan:${plan.id}|week:1|day:monday|type:t${index}|slot:1`,
      session_shape_hash: `hash-${index + 1}`,
      status: 'scheduled',
      scheduled_start_at: futureIso(3 + index),
      scheduled_end_at: futureIso(3 + index + 1),
      ...(options.sessionOverrides?.[index] ?? {}),
    });
    sessionIds.push(session.id);
  }
  return { plan, sessionIds };
}

function emitSyncRequest(plan: trainingPlans.TrainingPlan, sessionIds: number[], overrides: Record<string, unknown> = {}) {
  return emitDomainEvent({
    tenantId: TENANT_ID,
    userId: USER_ID,
    sourceSkill: 'training',
    eventType: TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
    entityType: 'training_plan',
    entityId: plan.id,
    schemaVersion: 'training-plan-calendar-sync.v1',
    payload: {
      planId: plan.id,
      planVersion: 1,
      sessionIds,
      syncTarget: 'google',
      requestedSessions: sessionIds.length,
      ...overrides,
    },
    privacyClassification: 'health',
    idempotencyKey: `training.plan_calendar_sync.requested:${plan.id}:1`,
  });
}

function jobRow(db: Database.Database, jobType = TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE) {
  return db.prepare(
    'SELECT * FROM background_jobs WHERE job_type = ? ORDER BY created_at ASC, job_id ASC',
  ).all(jobType) as Array<Record<string, any>>;
}

function makeJobDue(db: Database.Database): void {
  db.prepare(
    "UPDATE background_jobs SET not_before = datetime('now', '-1 minute') WHERE job_type = ?",
  ).run(TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE);
}

function planCalendarSyncSummary(planId: number): Record<string, any> | null {
  const plan = trainingPlans.getPlanById(planId);
  if (!plan?.preferences_json) return null;
  return (JSON.parse(plan.preferences_json) as Record<string, any>).calendarSync ?? null;
}

describe('training-plan-calendar-sync-worker', () => {
  beforeEach(() => {
    _resetTrainingOperationLocksForTests();
    delete process.env.TRAINING_ENGINE_ENABLED;
    delete process.env.TRAINING_ENGINE_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    delete process.env.TRAINING_CALENDAR_CREATE_BATCH_SIZE;
    delete process.env.TRAINING_PLAN_CALENDAR_SYNC_WORKER_DISABLED;

    mockCreateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockMarkSecretaryAgendaProviderSyncSatisfied.mockReset();
    mockMarkSecretaryAgendaProviderCleanupRequired.mockReset();
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent.mockReset();
    mockRecordCalendarOwnership.mockReset();
    mockLinkSessionToCalendar.mockReset();

    let eventCounter = 0;
    mockCreateEvent.mockImplementation(async () => {
      eventCounter += 1;
      return { id: `evt-${eventCounter}`, source: 'google' };
    });
    mockDeleteEvent.mockResolvedValue(undefined);
    mockMarkSecretaryAgendaProviderSyncSatisfied.mockReturnValue({ ok: true, updated: true });
    mockMarkSecretaryAgendaProviderCleanupRequired.mockReturnValue({ ok: true, updated: true });
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent.mockResolvedValue({
      windows: [],
      degraded: false,
      providerConfigured: false,
      warningCodes: [],
      warnings: [],
    });
    mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
      status: 'scheduled',
      reasonCodes: ['scheduled_in_available_window'],
      selectedSlot: intent.preferredWindows[0],
      agendaItem: {
        agendaItemId: `sec-${intent.sourceEntityId}`,
        sourceIntentId: intent.intentId,
        lifecycleState: 'scheduled',
      },
      explanation: 'scheduled',
      alternativeSlots: [],
      conflicts: [],
      downstreamImplications: [],
      confidence: 'high',
      feedback: {
        sourceSkill: 'training',
        sourceIntentId: intent.intentId,
        agendaItemId: `sec-${intent.sourceEntityId}`,
        status: 'scheduled',
        reasonCodes: ['scheduled_in_available_window'],
        scheduledStart: intent.preferredWindows[0].start,
        scheduledEnd: intent.preferredWindows[0].end,
        shouldRefreshSource: false,
        downstreamImplications: [],
      },
    }));
  });

  afterEach(() => {
    _resetTrainingOperationLocksForTests();
  });

  it('routes the sync-request event to a durable job and drains it into linked, owned provider events', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan();
      const event = emitSyncRequest(plan, sessionIds);

      const routed = await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      expect(routed).toMatchObject({ processed: 1, failed: 0, deadLetter: 0 });
      const jobs = jobRow(db);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        job_type: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        idempotency_key: `training_plan_calendar_sync:${event.eventId}`,
        max_attempts: 5,
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        causation_event_id: event.eventId,
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });

      expect(mockCreateEvent).toHaveBeenCalledTimes(2);
      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining('Session 1 (50min)'),
          description: expect.stringContaining('[NEXUS_TRAINING_IDENTITY'),
        }),
        'google',
        USER_ID,
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      // Secretary arbitration contract (moved from the inline-phase suite):
      // availability lookup and submission carry the training identity, a
      // hard preferred window, the 75%-floor minimum duration, and the
      // resolved provider as a soft preference.
      expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSkill: 'training',
          softPreferences: { calendarProvider: 'google' },
        }),
      );
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceSkill: 'training',
          sourceAction: 'schedule_training_session',
          sourceEntityType: 'training_session',
          ownerUserId: USER_ID,
          tenantId: TENANT_ID,
          softPreferences: { calendarProvider: 'google' },
          // Duration derives from the persisted window (60min), and the
          // minimum is the 75% floor: min(60, max(20, round(45))) = 45.
          requestedDurationMinutes: 60,
          minimumDurationMinutes: 45,
          preferredWindows: [expect.objectContaining({ hard: true })],
        }),
        expect.any(Object),
      );
      for (const sessionId of sessionIds) {
        const session = trainingPlans.getSessionById(sessionId);
        expect(session?.calendar_event_id).toMatch(/^evt-/);
        expect(session?.calendar_source).toBe('google');
      }
      const ownershipRows = db.prepare(
        'SELECT * FROM training_agenda_event_ownership WHERE plan_id = ? AND status = ?',
      ).all(plan.id, 'active');
      expect(ownershipRows).toHaveLength(2);
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).toHaveBeenCalledTimes(2);
      // Plan-level consistency state uses migration 244 vocabulary; 'synced'
      // is only recorded once every session's provider event is confirmed
      // through the ownership read-back.
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'synced',
        pending: false,
        provider: 'google',
        requestedSessions: 2,
        eventsCreated: 2,
        eventsFailed: 0,
      });
    });
    db.close();
  });

  it('retries while the plan is pending activation and drains after promotion', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ status: 'pending_activation' });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      const first = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      // Generation persists pending → cancels old → activates; the queue can
      // legitimately win that race, so pending is retryable — never terminal
      // and never a provider write.
      expect(first).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();

      expect(trainingPlans.activatePendingPlan(plan.id, USER_ID, TENANT_ID)).toBe(true);
      makeJobDue(db);
      const second = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(second).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    });
    db.close();
  });

  it('completes as a no-op when the plan no longer exists', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: { planId: 99_999, planVersion: 1, sessionIds: [1], syncTarget: 'google' },
        idempotencyKey: 'plan-missing-test',
        maxAttempts: 5,
      });
      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('completes as a no-op when the requested plan version was superseded', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan();
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      incrementPlanVersion(plan.id);

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('keeps transiently failed sessions eligible and finishes them on the retry attempt', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan();
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      let eventCounter = 100;
      mockCreateEvent
        .mockRejectedValueOnce(new Error('provider 503'))
        .mockImplementation(async () => {
          eventCounter += 1;
          return { id: `evt-${eventCounter}`, source: 'google' };
        });

      const first = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      // Behaviour change vs. the old inline loop (deliberate, stronger
      // guarantee): a transient create failure no longer permanently
      // unschedules the session. The job fails with backoff and the session
      // row stays claimable for the retry.
      expect(first).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      const failedSession = trainingPlans.getSessionById(sessionIds[0]);
      expect(failedSession?.status).toBe('scheduled');
      expect(failedSession?.calendar_event_id).toBeNull();
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'create_failed',
        pending: true,
        lastErrorCode: 'TRAINING_PLAN_CALENDAR_SYNC_PROVIDER_CREATE_FAILED',
      });

      makeJobDue(db);
      const second = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(second).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      // The session that succeeded on attempt 1 is already owned — the retry
      // must not create a duplicate provider event for it.
      expect(mockCreateEvent).toHaveBeenCalledTimes(3);
      for (const sessionId of sessionIds) {
        expect(trainingPlans.getSessionById(sessionId)?.calendar_event_id).toMatch(/^evt-/);
      }
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'synced', pending: false });
    });
    db.close();
  });

  it('applies the terminal compensation only on the final attempt, then dead-letters', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: { planId: plan.id, planVersion: 1, sessionIds, syncTarget: 'google' },
        idempotencyKey: 'final-attempt-test',
        maxAttempts: 1,
      });
      mockCreateEvent.mockRejectedValue(new Error('provider 503'));

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      // A dead-lettered job must leave honest session state: no phantom
      // "scheduled" rows that will never receive a calendar event.
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
    });
    db.close();
  });

  it('compensates ownership-recording failure with provider delete and terminal unschedule', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockRecordCalendarOwnership.mockReturnValue({ ok: false, created: false, ownershipId: null });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      // Ownership failure is a split-brain risk — blind retry could duplicate
      // the provider event, so the session is terminally unscheduled and the
      // job completes; the agenda cleanup queue owns provider-side recovery.
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-1', 'google', USER_ID);
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith(expect.objectContaining({
        providerSyncState: 'deleted',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_ownership_record_failed',
        clearProviderMapping: true,
      }));
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'create_failed' });
    });
    db.close();
  });

  it('creates provider events in bounded batches of five', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 6 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      let inFlight = 0;
      let maxInFlight = 0;
      let eventCounter = 0;
      mockCreateEvent.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        eventCounter += 1;
        return { id: `evt-${eventCounter}`, source: 'google' };
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(6);
      expect(maxInFlight).toBe(5);
    });
    db.close();
  });

  it('honours the ops override lowering the batch width to one', async () => {
    process.env.TRAINING_CALENDAR_CREATE_BATCH_SIZE = '1';
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 3 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      let inFlight = 0;
      let maxInFlight = 0;
      let eventCounter = 0;
      mockCreateEvent.mockImplementation(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        eventCounter += 1;
        return { id: `evt-${eventCounter}`, source: 'google' };
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(3);
      expect(maxInFlight).toBe(1);
    });
    db.close();
  });

  it('clamps invalid or overly large training calendar create batch sizes', () => {
    // Moved from the persistence suite with the batching implementation.
    expect(trainingCalendarCreateBatchSize({})).toBe(5);
    expect(trainingCalendarCreateBatchSize({ TRAINING_CALENDAR_CREATE_BATCH_SIZE: '0' })).toBe(1);
    expect(trainingCalendarCreateBatchSize({ TRAINING_CALENDAR_CREATE_BATCH_SIZE: '12' })).toBe(5);
    expect(trainingCalendarCreateBatchSize({ TRAINING_CALENDAR_CREATE_BATCH_SIZE: 'nope' })).toBe(5);
  });

  it('performs no provider work when the payload has no sync target', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: { planId: plan.id, planVersion: 1, sessionIds },
        idempotencyKey: 'no-target-test',
        maxAttempts: 5,
      });
      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('skips sessions the Secretary cannot place without failing the job', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
        status: 'unschedulable',
        reasonCodes: ['no_free_window'],
        selectedSlot: null,
        agendaItem: {
          agendaItemId: `sec-${intent.sourceEntityId}`,
          sourceIntentId: intent.intentId,
          lifecycleState: 'unscheduled',
        },
        explanation: 'no slot',
        alternativeSlots: [],
        conflicts: [],
        downstreamImplications: [],
        confidence: 'high',
        feedback: null,
      }));

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      // A skip is not a failure — the session keeps its schedule status and
      // the plan-level state stays not_synced with the skip counted.
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('scheduled');
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'not_synced',
        eventsSkipped: 1,
        eventsFailed: 0,
      });
    });
    db.close();
  });

  it('re-draining a completed job performs no additional provider work', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan();
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(mockCreateEvent).toHaveBeenCalledTimes(2);

      const second = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(second).toMatchObject({ completed: 0, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(2);
    });
    db.close();
  });

  it("drains an 'auto' sync target end-to-end by letting the provider writer resolve the provider", async () => {
    // Review finding (critical): 'auto' is the DEFAULT emit value whenever no
    // explicit provider preference exists — dropping it to a no-op would
    // strand every such plan at {not_synced, pending:true} forever.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds, { syncTarget: 'auto' });
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      // The provider writer receives `undefined` so unified-calendar resolves
      // the user's provider — the released auto-target behaviour.
      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.any(Object),
        undefined,
        USER_ID,
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      expect(trainingPlans.getSessionById(sessionIds[0])?.calendar_event_id).toMatch(/^evt-/);
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'synced',
        pending: false,
        provider: null,
      });
    });
    db.close();
  });

  it('treats reflowed, compressed, and capped sessions as calendar-eligible', async () => {
    // Review finding: removing any status from SYNCABLE_SESSION_STATUSES
    // previously kept every suite green — this pins the worker-side
    // eligibility re-derivation, not just the emit payload.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({
        sessionCount: 3,
        sessionOverrides: [
          { status: 'reflowed' },
          { status: 'compressed' },
          { status: 'capped' },
        ],
      });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(3);
      for (const sessionId of sessionIds) {
        expect(trainingPlans.getSessionById(sessionId)?.calendar_event_id).toMatch(/^evt-/);
      }
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'synced' });
    });
    db.close();
  });

  it('retains the provider event id for the cleanup queue when the compensating delete fails', async () => {
    // Review finding: the delete_failed branch (providerEventId retained,
    // clearProviderMapping false) had no assertion — a mutation collapsing it
    // to 'deleted' would silently orphan provider events.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockRecordCalendarOwnership.mockReturnValue({ ok: false, created: false, ownershipId: null });
      mockDeleteEvent.mockRejectedValue(new Error('provider delete timeout'));

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith(expect.objectContaining({
        providerEventId: 'evt-1',
        providerSource: 'google',
        providerSyncState: 'delete_failed',
        lifecycleState: 'unscheduled',
        clearProviderMapping: false,
      }));
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'create_failed' });
    });
    db.close();
  });

  it('deletes the created provider event and goes terminal when the local link write fails', async () => {
    // Review finding: a provider create followed by a local link failure used
    // to leave an untracked provider event AND a retryable session — the
    // retry would then create a DUPLICATE provider event. The compensation
    // must delete (or hand off) the created event and end the session
    // terminally.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockLinkSessionToCalendar.mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked');
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      // Terminal, not retryable: the job completes, the created provider
      // event was deleted, and no retry can duplicate it.
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-1', 'google', USER_ID);
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'create_failed' });
    });
    db.close();
  });

  it('classifies a provider-create timeout as terminal because the write outcome is unknown', async () => {
    // Review finding: a create that times out may have SUCCEEDED on the
    // provider — retrying blind would duplicate the event, and the unique
    // ownership index cannot catch it (the duplicate has a fresh event id).
    process.env.TRAINING_CALENDAR_SYNC_TIMEOUT_MS = '3000';
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockCreateEvent.mockImplementation(() => new Promise(() => {
        // Never resolves — the sync timeout fires first.
      }));

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'create_failed' });
    });
    db.close();
    delete process.env.TRAINING_CALENDAR_SYNC_TIMEOUT_MS;
  }, 20_000);

  it('leaves a synced summary untouched when a later drain finds nothing to sync', async () => {
    // Review finding: a second event draining an already-linked plan (e.g. a
    // backfill racing a manual sync) used to overwrite 'synced' with
    // 'not_synced' because the empty payload set failed the allLinked check.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan();
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'synced' });

      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: { planId: plan.id, planVersion: 1, sessionIds, syncTarget: 'google' },
        idempotencyKey: 'second-request-after-sync',
        maxAttempts: 5,
      });
      const second = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(second).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(2);
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'synced' });
    });
    db.close();
  });

  it('never reports synced while a corrupt-window session remains unlinked', async () => {
    // Review finding: sessions whose persisted window is corrupt were
    // silently dropped from the denominator, letting the plan claim
    // 'synced' with a scheduled-but-unlinked session left behind.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const zeroDuration = futureIso(3);
      const { plan, sessionIds } = seedPlan({
        sessionCount: 2,
        sessionOverrides: [
          {},
          { scheduled_start_at: zeroDuration, scheduled_end_at: zeroDuration },
        ],
      });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'not_synced',
        requestedSessions: 2,
        eventsCreated: 1,
        eventsSkipped: 1,
      });
    });
    db.close();
  });

  it('marks the agenda create_failed without leaking the event title into the failure log', async () => {
    // Review finding: two deleted inline-phase assertions are restored here —
    // the create_failed agenda compensation and the log-privacy invariant
    // that the failure warn payload never carries the provider title.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockCreateEvent.mockRejectedValue(new Error('provider 503'));
      const warnSpy = vi.spyOn(
        (await import('../../src/utils/logger')).logger,
        'warn',
      );

      await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith(expect.objectContaining({
        providerSyncState: 'create_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_event_create_failed',
        clearProviderMapping: true,
      }));
      const failureWarn = warnSpy.mock.calls.find(
        (call) => call[1] === 'Failed to create calendar event for session',
      );
      expect(failureWarn).toBeTruthy();
      expect(failureWarn?.[0]).not.toHaveProperty('title');
      warnSpy.mockRestore();
    });
    db.close();
  });

  it('waits for the training calendar operation lock before provider work', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });

      // Hold the same user/tenant lock a generation/cancel would hold. The
      // worker must not touch the provider until it is released — this is the
      // mutual exclusion the inline phase had by running under the lock.
      const release = await acquireTrainingCalendarOperationLock({
        userId: USER_ID,
        tenantId: TENANT_ID,
        planId: plan.id,
        operation: 'calendar_cancel',
      });
      const drainPromise = processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      // Wait until the job is actually CLAIMED (claim precedes the handler),
      // then give the handler time to reach the provider boundary — a fixed
      // sleep alone could pass vacuously on a slow runner that never got to
      // the claim.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const claimed = jobRow(db).some((row) => row.status === 'processing');
        if (claimed) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(jobRow(db).some((row) => row.status === 'processing')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockCreateEvent).not.toHaveBeenCalled();
      release();
      const drained = await drainPromise;
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
    });
    db.close();
  });
});
