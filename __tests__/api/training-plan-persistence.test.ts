// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DateTime, Settings } from 'luxon';

const originalDefaultZone = Settings.defaultZone;

const mockCreatePlan = vi.fn();
const mockCreateWeek = vi.fn();
const mockCreateSession = vi.fn();
const mockLinkSessionToCalendar = vi.fn();
const mockUpdateSession = vi.fn();
const mockUpdatePlanPreferences = vi.fn();
const mockCreateEvent = vi.fn();
const mockDeleteEvent = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLintPlan = vi.fn();
// Slice 4.D — the lifecycle module hits the real DB. Mocked here so
// the existing persistence-layer unit test can keep its in-memory
// stub shape. The pure logic of the lifecycle module is exercised by
// __tests__/services/training-plan-lifecycle.test.ts.
const mockGetPlanVersion = vi.fn();
const mockFindExistingOwnership = vi.fn();
const mockRecordCalendarOwnership = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockMarkSecretaryAgendaProviderSyncSatisfied = vi.fn();
const mockMarkSecretaryAgendaProviderCleanupRequired = vi.fn();
const mockLoadLiveCalendarBusyWindowsForSecretaryIntent = vi.fn();

// F4 (Phase 1B): plan + weeks + sessions now commit inside one
// `db.transaction(...)`, so persistence needs a real database handle even
// though the individual writers below are mocked. An in-memory handle is
// enough — `transaction()` just wraps the (mocked) calls, and using a real
// one keeps the atomicity guarantee honest rather than letting the code
// silently degrade to non-transactional when no database is present.
const transactionTestDb = new (require('better-sqlite3'))(':memory:');
vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  return { ...actual, getDb: () => transactionTestDb };
});

vi.mock('../../src/services/training-plans', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-plans')>(
    '../../src/services/training-plans',
  );
  return {
    ...actual,
    createPlan: (...args: unknown[]) => mockCreatePlan(...args),
    createWeek: (...args: unknown[]) => mockCreateWeek(...args),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    linkSessionToCalendar: (...args: unknown[]) => mockLinkSessionToCalendar(...args),
    updateSession: (...args: unknown[]) => mockUpdateSession(...args),
    updatePlanPreferences: (...args: unknown[]) => mockUpdatePlanPreferences(...args),
  };
});

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

vi.mock('../../src/services/training-plan-lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-plan-lifecycle')>(
    '../../src/services/training-plan-lifecycle',
  );
  return {
    ...actual,
    getPlanVersion: (...args: unknown[]) => mockGetPlanVersion(...args),
    findExistingOwnership: (...args: unknown[]) => mockFindExistingOwnership(...args),
    recordCalendarOwnership: (...args: unknown[]) => mockRecordCalendarOwnership(...args),
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

vi.mock('../../src/services/secretary-live-calendar-busy', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/secretary-live-calendar-busy')>(
    '../../src/services/secretary-live-calendar-busy'
  )),
  loadLiveCalendarBusyWindowsForSecretaryIntent: (...args: unknown[]) =>
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/coach-kernel/plan-linter', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/coach-kernel/plan-linter')>(
    '../../src/services/coach-kernel/plan-linter',
  );
  return {
    ...actual,
    lintPlan: (...args: unknown[]) => {
      const implementation = mockLintPlan.getMockImplementation();
      return implementation ? mockLintPlan(...args) : actual.lintPlan(...(args as [any]));
    },
  };
});

import {
  lintGeneratedTrainingPlanPreflight,
  persistGeneratedTrainingPlan,
} from '../../src/api/routes/training-plan-persistence';
import { _resetTrainingOperationLocksForTests } from '../../src/services/training-operation-locks';

async function waitForMockCallCount(mock: { mock: { calls: unknown[] } }, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('training-plan-persistence', () => {
  beforeEach(() => {
    // Stronger guarantee: the calendar-constrained timezone owner must
    // observe removal of the explicit plan zone on every developer host and
    // CI runner, rather than inheriting whichever system zone runs Vitest.
    Settings.defaultZone = 'UTC';
    _resetTrainingOperationLocksForTests();
    // Phase 1B: the outbox emit joins the plan-graph transaction on this
    // shared in-memory handle; reset the table so per-test event assertions
    // never see a previous test's rows.
    transactionTestDb.exec('DROP TABLE IF EXISTS event_outbox');
    delete process.env.TRAINING_ENGINE_ENABLED;
    delete process.env.TRAINING_ENGINE_DISABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_ENABLED;
    delete process.env.TRAINING_CALENDAR_WRITES_DISABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_ENABLED;
    delete process.env.TRAINING_CALENDAR_SYNC_DISABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_ENABLED;
    delete process.env.TRAINING_CALENDAR_OUTLOOK_DISABLED;
    delete process.env.TRAINING_CALENDAR_CREATE_BATCH_SIZE;

    mockCreatePlan.mockReset();
    mockCreateWeek.mockReset();
    mockCreateSession.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockUpdateSession.mockReset();
    mockUpdatePlanPreferences.mockReset();
    mockCreateEvent.mockReset();
    mockDeleteEvent.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerInfo.mockReset();
    mockLintPlan.mockReset();
    mockGetPlanVersion.mockReset();
    mockFindExistingOwnership.mockReset();
    mockRecordCalendarOwnership.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockMarkSecretaryAgendaProviderSyncSatisfied.mockReset();
    mockMarkSecretaryAgendaProviderCleanupRequired.mockReset();
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent.mockReset();

    mockCreatePlan.mockReturnValue({ id: 901 });
    mockCreateWeek.mockImplementation(({ week_number }: any) => ({ id: 1000 + Number(week_number || 1) }));
    let sessionId = 2000;
    mockCreateSession.mockImplementation(() => ({ id: ++sessionId }));
    mockUpdatePlanPreferences.mockReturnValue(true);
    mockCreateEvent.mockResolvedValue({ id: 'evt-1', source: 'google' });
    mockDeleteEvent.mockResolvedValue(undefined);
    // Slice 4.D defaults: fresh plan_version=1, no prior ownership rows,
    // ownership recorder reports clean inserts.
    mockGetPlanVersion.mockReturnValue(1);
    mockFindExistingOwnership.mockReturnValue(null);
    mockRecordCalendarOwnership.mockReturnValue({ ok: true, created: true, ownershipId: 1 });
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
    Settings.defaultZone = originalDefaultZone;
    _resetTrainingOperationLocksForTests();
  });

  // Phase 1B red test — calendar effects must route through the outbox.
  // Provider work inside persistence ran while the plan was still
  // `pending_activation` and could not retry transient failures; the
  // outbox + dedicated worker gives durability, backoff, and the
  // "no provider work for a non-active plan" invariant.
  it('emits one calendar-sync outbox event inside the plan-graph transaction and performs no provider work', async () => {
    // A missing lifecycle row is represented as null. The durable envelope
    // must use version 1, not leak null into its entity/idempotency contract.
    mockGetPlanVersion.mockReturnValueOnce(null);
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Marathon build',
      durationWeeks: 4,
      startDate: '2026-04-19',
      endDate: '2026-05-17',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{"preferredTime":"12:00"}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      calendarSource: 'google',
      planData: {
        planName: 'Marathon Plan',
        sport: 'running',
        periodization: 'block',
        weeks: [
          {
            weekNumber: 1,
            focus: 'base',
            intensityPct: 72,
            notes: [
              'Readiness confidence: provider data is stale; use a manual check-in.',
              'Adherence decision: reset week after 3 consecutive misses.',
            ],
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Base Run',
                durationMinutes: 50,
                description: 'Easy aerobic work.',
                exercises: [{ name: 'Warm-up', distance_km: 1 }],
              },
              {
                dayOfWeek: 'Tuesday',
                sessionType: 'gym',
                title: 'Runner Strength',
                durationMinutes: 40,
                description: 'Strength work.',
                exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, rpe: '7', restSec: 90 }],
              },
            ],
          },
        ],
      },
    });

    // No provider or Secretary work happens inline anymore — the
    // training_plan_calendar_sync worker owns it after activation.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();

    const events = transactionTestDb.prepare(
      "SELECT * FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{
      payload_json: string;
      idempotency_key: string;
      source_skill: string;
      event_type: string;
      entity_type: string;
      entity_id: string;
      entity_version: number;
      schema_version: string;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0].source_skill).toBe('training');
    expect(events[0].event_type).toBe('training.plan_calendar_sync.requested.v1');
    expect(events[0].entity_type).toBe('training_plan');
    expect(events[0].entity_id).toBe('901');
    expect(events[0].entity_version).toBe(1);
    expect(events[0].schema_version).toBe('training-plan-calendar-sync.v1');
    expect(events[0].idempotency_key).toBe('training.plan_calendar_sync.requested:901:1');
    const payload = JSON.parse(events[0].payload_json);
    expect(payload).toMatchObject({ planId: 901, planVersion: 1, syncTarget: 'google' });
    expect(payload.sessionIds).toHaveLength(2);

    // The finalized schedule window is now durable on the session row so the
    // worker can rebuild provider event times after the fact.
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Base Run',
      scheduled_start_at: expect.any(String),
      scheduled_end_at: expect.any(String),
    }));
    // Stronger durability guarantee: coach-kernel week explanations must be
    // stored as a parseable array for later read/evidence paths; they are not
    // flattened into, or substituted for, structured decisionReasons.
    expect(mockCreateWeek).toHaveBeenCalledWith(expect.objectContaining({
      notes: JSON.stringify([
        'Readiness confidence: provider data is stale; use a manual check-in.',
        'Adherence decision: reset week after 3 consecutive misses.',
      ]),
    }));

    expect(result.eventsCreated).toBe(0);
    expect(result.sessionsLinked).toBe(0);
    expect(result.calendarSyncQueued).toBe(true);
    expect(result.syncableSessions).toBe(2);

    // A calendar provider alone is not enough to enqueue work: without a
    // finalized syncable session, there is nothing the worker may write.
    mockCreatePlan.mockReturnValueOnce({ id: 902 });
    const emptyResult = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Recovery-only week',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      calendarSource: 'google',
      planData: {
        planName: 'Recovery Week',
        weeks: [{
          weekNumber: 1,
          sessions: [{
            dayOfWeek: 'Monday',
            sessionType: 'rest',
            title: 'Rest',
            durationMinutes: 30,
          }],
        }],
      },
    });

    expect(emptyResult.syncableSessions).toBe(0);
    expect(emptyResult.calendarSyncQueued).toBe(false);
    expect(transactionTestDb.prepare(
      "SELECT COUNT(*) AS count FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).get()).toEqual({ count: 1 });
  });

  it('persists generated weeks and sessions, schedules events, and links created calendar events', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Marathon build',
      durationWeeks: 4,
      startDate: '2026-04-19',
      endDate: '2026-05-17',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{"preferredTime":"12:00"}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        planName: 'Marathon Plan',
        sport: 'running',
        periodization: 'block',
        weeks: [
          {
            weekNumber: 1,
            focus: 'base',
            intensityPct: 72,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Base Run',
                durationMinutes: 50,
                description: 'Easy aerobic work.',
                exercises: [{ name: 'Warm-up', distance_km: 1 }],
              },
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Runner Strength',
                durationMinutes: 40,
                description: 'Strength work.',
                exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, rpe: '7', restSec: 90 }],
              },
              {
                dayOfWeek: 'Tuesday',
                sessionType: 'rest',
                title: 'Rest',
                durationMinutes: 30,
              },
            ],
          },
        ],
      },
    });

    expect(result).toEqual({
      planId: 901,
      totalSessions: 2,
      // Phase 1B: provider calendar work moved behind the outbox, so
      // persistence reports 0 created/linked and flags the queued sync
      // instead — the prior non-zero counts encoded inline provider writes
      // that ran while the plan was still pending activation and could not
      // retry transient failures.
      eventsCreated: 0,
      sessionsLinked: 0,
      calendarSyncQueued: true,
      syncableSessions: 2,
      weekSummaries: [{ weekNumber: 1, focus: 'base', sessionCount: 2 }],
      // training-expert-coach-knowledge-engine (2026-05-03):
      // The persister now runs the deterministic plan-linter in advisor
      // mode. Healthy plans return `pass` with empty findings.
      lint: {
        status: 'pass',
        blockers: [],
        warnings: [],
        suggestedFixes: [],
      },
    });
    expect(mockCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 12,
      name: 'Marathon Plan',
      sport: 'running',
      preferences_json: '{"preferredTime":"12:00"}',
    }));
    expect(mockCreateWeek).toHaveBeenCalledWith(expect.objectContaining({
      plan_id: 901,
      week_number: 1,
      volume_sessions: 2,
    }));
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Base Run',
      session_type: 'run',
      duration_minutes: 50,
      intensity_text: 'RPE 72%',
      status: 'scheduled',
      session_identity_key: expect.stringContaining('plan:901|week:1|day:monday|type:run|slot:1'),
      session_shape_hash: expect.any(String),
    }));
    // Phase 1B: Secretary arbitration and provider event creation now happen
    // in the training_plan_calendar_sync worker (see its suite for the
    // provider-side assertions that used to live here). Persistence emits the
    // durable request and records the finalized windows on session rows.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockDeleteEvent).not.toHaveBeenCalled();
    expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();
    const emitted = transactionTestDb.prepare(
      "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{ payload_json: string }>;
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0].payload_json)).toMatchObject({
      planId: 901,
      planVersion: 1,
      // No explicit calendarSource in this setup → the worker lets
      // unified-calendar resolve the user's provider ('auto').
      syncTarget: 'auto',
      requestedSessions: 2,
    });
    expect(mockUpdatePlanPreferences).toHaveBeenCalledWith(
      901,
      expect.stringContaining('"finalValidationResult"'),
    );
    // Initial plan-level consistency state uses migration 244 vocabulary and
    // is written in the same preferences pass as the lint summary.
    expect(mockUpdatePlanPreferences).toHaveBeenCalledWith(
      901,
      expect.stringContaining('"calendarSync"'),
    );
    const preferencesWrite = JSON.parse(mockUpdatePlanPreferences.mock.calls[0][1] as string);
    expect(preferencesWrite.calendarSync).toMatchObject({
      state: 'not_synced',
      pending: true,
      requestedSessions: 2,
      eventsCreated: 0,
    });
  });

  // Phase 1B: the provider used to be asserted on Secretary availability and
  // provider-write calls made inline; those now happen in the worker, so the
  // resolved provider must instead travel durably in the outbox payload.
  it('passes the resolved Training calendar provider into the outbox syncTarget', async () => {
    mockCreateEvent.mockResolvedValueOnce({ id: 'evt-outlook', source: 'outlook' });

    await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Strength block',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      calendarSource: 'outlook',
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Upper Strength',
                durationMinutes: 45,
                exercises: [{ name: 'Dumbbell Bench Press', sets: 3, reps: '8-10', rpe: '7', restSec: 90 }],
              },
            ],
          },
        ],
      },
    });

    expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).not.toHaveBeenCalled();
    expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const emitted = transactionTestDb.prepare(
      "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{ payload_json: string }>;
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0].payload_json)).toMatchObject({
      syncTarget: 'outlook',
      requestedSessions: 1,
    });
  });







  // Phase 1B: the provider-batching half of the old SLA test moved to the
  // worker suite; persistence keeps the persist-side SLA plus a guard that a
  // realistic 96-session id array survives the outbox payload sanitizer
  // (arrays are recursed, not truncated — this pins that assumption).
  it('persists a mocked 16-week calendar plan under the persistence SLA with a full outbox payload', async () => {
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weeks = Array.from({ length: 16 }, (_, weekIndex) => ({
      weekNumber: weekIndex + 1,
      sessions: dayNames.map((dayOfWeek, sessionIndex) => ({
        dayOfWeek,
        sessionType: sessionIndex % 3 === 2 ? 'gym' : 'run',
        title: `W${weekIndex + 1} Session ${sessionIndex + 1}`,
        durationMinutes: sessionIndex === 5 ? 60 : 40,
      })),
    }));

    const startedAt = performance.now();
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: '16-week batching SLA',
      durationWeeks: 16,
      startDate: '2026-04-19',
      endDate: '2026-08-09',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: { weeks },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.totalSessions).toBe(96);
    expect(result.eventsCreated).toBe(0);
    expect(result.syncableSessions).toBe(96);
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const emitted = transactionTestDb.prepare(
      "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{ payload_json: string }>;
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0].payload_json).sessionIds).toHaveLength(96);
    expect(elapsedMs).toBeLessThan(8_000);
  });

  it('does not persist standalone mobility sessions as calendar workouts', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Hybrid block',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Lift', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
              { dayOfWeek: 'Tuesday', sessionType: 'mobility', title: 'Mobility + Recovery', durationMinutes: 30, exercises: [] },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'Mobility Reset', durationMinutes: 25, exercises: [] },
            ],
          },
        ],
      },
    });

    expect(result.totalSessions).toBe(1);
    // Phase 1B: one syncable session is queued for the worker, not created inline.
    expect(result.eventsCreated).toBe(0);
    expect(result.syncableSessions).toBe(1);
    expect(result.weekSummaries).toEqual([{ weekNumber: 1, focus: undefined, sessionCount: 1 }]);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('persists deferred and unscheduled capacity-reconciliation sessions as inactive rows without calendar events', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Constrained week',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Scheduled Lift',
                durationMinutes: 35,
                scheduleState: 'compressed',
                scheduleReason: 'Compressed from 45 to 35 minutes because only a short hotel-gym window was available.',
                exercises: [{ name: 'Goblet Squat' }],
              },
              { dayOfWeek: 'Tuesday', sessionType: 'rest', title: 'Unscheduled Lift', durationMinutes: 45, scheduleState: 'unscheduled', scheduleReason: 'No feasible slot remained.' },
              { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Deferred Run', durationMinutes: 0, scheduleState: 'deferred', scheduleReason: 'Deferred by capacity reconciliation.' },
            ],
          },
        ],
      },
    });

    expect(result.totalSessions).toBe(1);
    // Phase 1B: the single compressed session is queued for the worker.
    expect(result.eventsCreated).toBe(0);
    expect(result.syncableSessions).toBe(1);
    expect(result.weekSummaries).toEqual([{ weekNumber: 1, focus: undefined, sessionCount: 1 }]);
    expect(mockCreateSession).toHaveBeenCalledTimes(3);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Scheduled Lift',
      status: 'compressed',
      description: expect.stringContaining('Compressed from 45 to 35 minutes'),
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Unscheduled Lift',
      status: 'unscheduled',
      duration_minutes: 45,
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Deferred Run',
      status: 'deferred',
    }));
    // Phase 1B: the calendar description is rebuilt by the worker from the
    // persisted session row, so the schedule reason must live on the row —
    // asserted through createSession above — and only the compressed session
    // id may appear in the outbox request.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const emitted = transactionTestDb.prepare(
      "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{ payload_json: string }>;
    expect(emitted).toHaveLength(1);
    expect(JSON.parse(emitted[0].payload_json).sessionIds).toHaveLength(1);
  });

  it('persists reflowed/capped schedule adjustments as rich lifecycle states for iOS read models', async () => {
    await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Travel week',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [
          {
            weekNumber: 1,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Reflowed Run',
                durationMinutes: 30,
                scheduleAdjustments: ['reflowed', 'compressed'],
                scheduleReason: 'Moved around travel and compressed to fit the available window.',
              },
              {
                dayOfWeek: 'Thursday',
                sessionType: 'gym',
                title: 'Capped Lift',
                durationMinutes: 25,
                scheduleAdjustments: ['capped'],
                scheduleReason: 'Capped to the available hotel-gym window.',
              },
            ],
          },
        ],
      },
    });

    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Reflowed Run',
      status: 'reflowed',
      description: expect.stringContaining('Moved around travel'),
    }));
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Capped Lift',
      status: 'capped',
      description: expect.stringContaining('Capped to the available hotel-gym window'),
    }));
    // Phase 1B: reflowed/capped states remain calendar-eligible; both are
    // requested through the outbox instead of created inline.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    const emitted = transactionTestDb.prepare(
      "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
    ).all() as Array<{ payload_json: string }>;
    expect(JSON.parse(emitted[0].payload_json).sessionIds).toHaveLength(2);
  });

  it('uses the plan timezone for the week-one past-day floor at UTC midnight when real calendar busy windows leave no valid slot', async () => {
    const day = new Date('2026-04-20T00:00:00.000Z');
    const blockStart = DateTime.fromISO('2026-04-20T05:00:00', { zone: 'Europe/Lisbon' }).toUTC().toJSDate();
    const blockEnd = DateTime.fromISO('2026-04-20T21:00:00', { zone: 'Europe/Lisbon' }).toUTC().toJSDate();

    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Calendar constrained week',
      durationWeeks: 1,
      startDate: '2026-04-20',
      endDate: '2026-04-27',
      now: day,
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [{ startMs: blockStart.getTime(), endMs: blockEnd.getTime(), title: 'Fully booked day' }],
      planData: {
        weeks: [{
          weekNumber: 1,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Lift', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
          ],
        }],
      },
    });

    expect(result.totalSessions).toBe(0);
    expect(result.eventsCreated).toBe(0);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Lift',
      status: 'unscheduled',
      duration_minutes: 45,
      preferred_time_unavailable: true,
      description: expect.stringContaining('No valid free calendar window remained'),
    }));
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();
  });

  it('marks alternate kernel-selected gym times as preferred-time unavailable', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Calendar constrained strength block',
      durationWeeks: 1,
      startDate: '2026-04-20',
      endDate: '2026-04-27',
      now: new Date('2026-04-20T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:00',
      busyWindows: [],
      planData: {
        weeks: [{
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'Monday',
              sessionType: 'gym',
              title: 'Lift before meetings',
              durationMinutes: 45,
              preferredStartTime: '05:00',
              exercises: [{ name: 'Squat' }],
            },
          ],
        }],
      },
    });

    expect(result.totalSessions).toBe(1);
    // Phase 1B: the kernel-selected alternate time is now proven through the
    // persisted schedule window (the worker rebuilds provider event times
    // from the row), not through an inline provider call.
    expect(result.eventsCreated).toBe(0);
    expect(result.syncableSessions).toBe(1);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Lift before meetings',
      status: 'scheduled',
      preferred_time_unavailable: true,
      scheduled_start_at: '2026-04-20T04:00:00.000Z',
    }));
    expect(mockCreateEvent).not.toHaveBeenCalled();
  });

  it('does not auto-create calendar events when the spec calendar preference is none', async () => {
    const result = await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Strength block',
      durationWeeks: 1,
      startDate: '2026-04-20',
      endDate: '2026-04-27',
      now: new Date('2026-04-20T00:00:00.000Z'),
      preferencesJson: '{}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:00',
      busyWindows: [],
      trainingPlanSpec: {
        userId: '12',
        planId: 'candidate',
        goal: 'hypertrophy',
        daysPerWeek: 2,
        startDate: '2026-04-20',
        weekModel: 'rolling_7_day_from_start',
        experienceLevel: 'novice',
        equipmentProfile: { label: 'full_gym', equipment: ['dumbbell'] },
        progressionModel: { type: 'double_progression', weekCount: 1 },
        calendarPreference: { provider: 'none' },
      },
      planData: {
        weeks: [{
          weekNumber: 1,
          sessions: [
            {
              dayOfWeek: 'Monday',
              sessionType: 'gym',
              title: 'Push Hypertrophy A',
              durationMinutes: 45,
              exercises: [{ name: 'Dumbbell Bench Press' }],
            },
          ],
        }],
      },
    });

    expect(result.totalSessions).toBe(1);
    expect(result.eventsCreated).toBe(0);
    expect(result.sessionsLinked).toBe(0);
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();
    expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    // Phase 1B: an explicit 'none' preference must not even queue a sync —
    // no outbox request means the worker can never touch a provider. The
    // table-existence guard matters: emitDomainEvent creates event_outbox on
    // demand, so "table absent" is itself proof that nothing was emitted.
    expect(result.calendarSyncQueued).toBe(false);
    const outboxTableExists = (transactionTestDb.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'event_outbox'",
    ).get() as { count: number }).count > 0;
    if (outboxTableExists) {
      expect(transactionTestDb.prepare(
        "SELECT COUNT(*) AS count FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
      ).get()).toEqual({ count: 0 });
    }
  });


  // training-expert-coach-knowledge-engine (2026-05-03):
  // mid-week-creation past-day floor. Before this fix, creating a plan on
  // Wednesday with a "week 1 Monday" session silently slid the session to
  // *next* Monday — users lost Mon/Tue of week 1 with no warning. The fix
  // marks past days as `unscheduled` with a clear `unavailableReason`
  // surfaced in the session description, leveraging the same plumbing as
  // the no-available-slot path.
  describe('mid-week creation past-day floor', () => {
    it('marks week 1 Monday as unscheduled when plan is generated on Wednesday', async () => {
      // 2026-04-22 is a Wednesday (UTC). A "week 1 Monday" session generated
      // on this day used to silently slide forward to the following Monday.
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Mid-week marathon block',
        durationWeeks: 1,
        startDate: '2026-04-22',
        endDate: '2026-04-29',
        now: new Date('2026-04-22T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                { dayOfWeek: 'Monday', sessionType: 'run', title: 'Easy Run', durationMinutes: 50 },
                { dayOfWeek: 'Tuesday', sessionType: 'gym', title: 'Lift A', durationMinutes: 45 },
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Wed Run', durationMinutes: 40 },
                { dayOfWeek: 'Friday', sessionType: 'run', title: 'Fri Run', durationMinutes: 45 },
                { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Long Run', durationMinutes: 90 },
              ],
            },
          ],
        },
      });

      // 5 sessions persisted total; 2 unscheduled (Mon, Tue), 3 active.
      expect(result.totalSessions).toBe(3);
      // Phase 1B: the 3 forward-looking sessions are queued for the worker.
      expect(result.eventsCreated).toBe(0);
      expect(result.syncableSessions).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledTimes(5);

      // Mon — past day, unscheduled, reason mentions Monday + Wednesday.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Easy Run',
        status: 'unscheduled',
        preferred_time_unavailable: true,
        description: expect.stringMatching(/Monday[\s\S]*has already passed[\s\S]*Wednesday/),
      }));
      // Tue — past day, unscheduled, reason mentions Tuesday + Wednesday.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Lift A',
        status: 'unscheduled',
        description: expect.stringMatching(/Tuesday[\s\S]*has already passed[\s\S]*Wednesday/),
      }));
      // Wed — today, scheduled.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Wed Run',
        status: 'scheduled',
      }));
      // Fri/Sat — forward-looking, scheduled.
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Fri Run',
        status: 'scheduled',
      }));
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Long Run',
        status: 'scheduled',
      }));

      // Calendar sync requested ONLY for the 3 forward-looking sessions —
      // the two past-day rejects never enter the outbox payload.
      expect(mockCreateEvent).not.toHaveBeenCalled();
      const emitted = transactionTestDb.prepare(
        "SELECT payload_json FROM event_outbox WHERE event_type = 'training.plan_calendar_sync.requested.v1'",
      ).all() as Array<{ payload_json: string }>;
      expect(JSON.parse(emitted[0].payload_json).sessionIds).toHaveLength(3);

      // No-available-slot warning telemetry emitted for both past-day rejects.
      const pastDayWarnings = mockLoggerWarn.mock.calls.filter(call =>
        String(call[1] || '').includes('no calendar slot was available'),
      );
      expect(pastDayWarnings.length).toBe(2);
    });

    it('keeps week 1 sessions on a Sunday-generated plan (no past-day rejects)', async () => {
      // 2026-04-19 is a Sunday — every weekday and Saturday/Sunday of week 1
      // are still in the future, so no past-day floor should fire.
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Sunday-start week',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                { dayOfWeek: 'Monday', sessionType: 'run', title: 'Mon Run', durationMinutes: 40 },
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Wed Run', durationMinutes: 40 },
                { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Sat Long', durationMinutes: 80 },
              ],
            },
          ],
        },
      });

      expect(result.totalSessions).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledTimes(3);
      // None of these should be `unscheduled` — all forward-looking.
      const calls = mockCreateSession.mock.calls.map(call => (call[0] as any).status);
      expect(calls).toEqual(['scheduled', 'scheduled', 'scheduled']);
    });

    it('does not schedule a same-day session earlier than the plan creation time', async () => {
      const now = new Date(2026, 3, 22, 15, 15, 0, 0); // Wednesday 15:15 local
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Same-day floor',
        durationWeeks: 1,
        startDate: '2026-04-22',
        endDate: '2026-04-29',
        now,
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Wednesday',
                  sessionType: 'run',
                  title: 'Today Run',
                  durationMinutes: 40,
                },
              ],
            },
          ],
        },
      });

      // Phase 1B: the same-day floor is proven on the persisted schedule
      // window instead of the inline provider call the worker now owns.
      expect(result.eventsCreated).toBe(0);
      expect(result.syncableSessions).toBe(1);
      const sessionCall = mockCreateSession.mock.calls.find(
        (call) => (call[0] as any).title === 'Today Run',
      )?.[0] as any;
      expect(sessionCall).toMatchObject({
        status: 'scheduled',
        preferred_time_unavailable: true,
      });
      const eventStart = new Date(sessionCall.scheduled_start_at);
      expect(eventStart.getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect(eventStart.getHours()).toBe(15);
      expect(eventStart.getMinutes()).toBe(30);
    });

    it('plan-linter strict preflight: catches equipment blockers without writing plan rows', () => {
      const lint = lintGeneratedTrainingPlanPreflight({
        userId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        equipmentProfile: 'bodyweight',
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'gym',
                  title: 'Lift A',
                  durationMinutes: 45,
                  exercises: [{ name: 'Barbell Back Squat' }],
                },
              ],
            },
          ],
        },
      });

      expect(lint.status).toBe('fail');
      expect(lint.blockers[0]?.ruleId).toBe('equipment_compatibility');
      expect(mockCreatePlan).not.toHaveBeenCalled();
      expect(mockCreateWeek).not.toHaveBeenCalled();
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.preflight_blocker_present',
          mode: 'strict_preflight',
          status: 'fail',
        }),
        'plan-linter: blocker(s) present before persistence; route must block writes',
      );
    });

    it.each([
      ['25m indoor', false],
      ['50m indoor', false],
      ['25m outdoor', false],
      ['50m outdoor', false],
      ['Open water', false],
      ['Limited/none', true],
    ] as const)(
      'plan-linter strict preflight: maps the onboarding pool-access answer %s',
      (poolAccess, expectedBlocked) => {
      const lint = lintGeneratedTrainingPlanPreflight({
        userId: 12,
        tenantId: 12,
        objective: 'Triathlon discipline balance',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        athleteProfiles: {
          swimProfile: { pool_access: poolAccess },
        },
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Sunday',
                  sessionType: 'swim',
                  title: 'Technique Swim',
                  durationMinutes: 40,
                },
              ],
            },
          ],
        },
      });

      expect(lint.blockers.map((blocker) => blocker.ruleId)
        .includes('swim_pool_access_required')).toBe(expectedBlocked);
      },
    );

    it('plan-linter strict preflight: fails closed when the linter throws', () => {
      mockLintPlan.mockImplementation(() => {
        throw new Error('synthetic lint failure');
      });

      const lint = lintGeneratedTrainingPlanPreflight({
        userId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'run',
                  title: 'Easy Run',
                  durationMinutes: 45,
                },
              ],
            },
          ],
        },
      });

      expect(lint.status).toBe('fail');
      expect(lint.blockers[0]?.ruleId).toBe('plan_linter_exception');
      expect(lint.suggestedFixes[0]?.findingRuleId).toBe('plan_linter_exception');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.threw',
          mode: 'strict_preflight',
        }),
        'plan-linter threw during strict preflight; blocking persistence until the plan can be verified',
      );
      expect(mockCreatePlan).not.toHaveBeenCalled();
    });

    it('plan-linter advisor: surfaces linter exceptions as warnings instead of silent pass', async () => {
      mockLintPlan.mockImplementation(() => {
        throw new Error('synthetic lint failure');
      });

      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'run',
                  title: 'Easy Run',
                  durationMinutes: 45,
                },
              ],
            },
          ],
        },
      });

      expect(result.lint.status).toBe('pass_with_warnings');
      expect(result.lint.warnings[0]?.ruleId).toBe('plan_linter_exception');
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.threw',
          mode: 'advisor',
        }),
        'plan-linter threw during advisor pass; surfacing warning instead of hiding the failure',
      );
    });

    it('plan-linter advisor: surfaces equipment-incompatibility on bodyweight profile + barbell session', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Beginner bodyweight',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        equipmentProfile: 'bodyweight',
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'gym',
                  title: 'Lift A',
                  durationMinutes: 45,
                  exercises: [
                    { name: 'Barbell Back Squat' }, // equipment violation
                  ],
                },
              ],
            },
          ],
        },
      });

      expect(result.lint.status).toBe('fail');
      expect(result.lint.blockers).toHaveLength(1);
      expect(result.lint.blockers[0]?.ruleId).toBe('equipment_compatibility');
      // Even with a blocker the plan still persisted (advisor mode).
      expect(result.totalSessions).toBe(1);
      // TR-EC-O13 (closed-beta-auth-hardening, 2026-05-04): the
      // dedicated `plan_linter.blocker_present` event fires for any
      // lint with `status === 'fail'`, separating fail-blockers from
      // non-blocking findings so operators can dashboard the rate.
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'plan_linter.blocker_present',
          mode: 'advisor',
          status: 'fail',
        }),
        'plan-linter: blocker(s) present (advisor mode; surfaced on response)',
      );
    });

    it('plan-linter advisor: uses persisted dates to catch heavy lower before next-week long run', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Week-boundary long-run protection',
        durationWeeks: 2,
        startDate: '2026-04-19',
        endDate: '2026-05-03',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            {
              weekNumber: 1,
              sessions: [
                {
                  dayOfWeek: 'Wednesday',
                  sessionType: 'run',
                  title: 'Bridge Run',
                  durationMinutes: 40,
                },
              ],
            },
            {
              weekNumber: 2,
              sessions: [
                {
                  dayOfWeek: 'Sunday',
                  sessionType: 'gym',
                  title: 'Lower Body Strength',
                  durationMinutes: 45,
                  exercises: [{ name: 'Barbell Back Squat' }],
                },
                {
                  dayOfWeek: 'Monday',
                  sessionType: 'long_run',
                  title: 'Long Run',
                  durationMinutes: 90,
                },
              ],
            },
          ],
        },
      });

      // Phase 1B: the lint pass still sees the 3 finalized windows through
      // the in-transaction calendarEvents list even though provider events
      // are only queued, not created.
      expect(result.eventsCreated).toBe(0);
      expect(result.syncableSessions).toBe(3);
      expect(result.lint.status).toBe('fail');
      expect(result.lint.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no_heavy_lower_before_long_run',
            affectedSessions: [
              expect.objectContaining({
                weekNumber: 2,
                dayOfWeek: 'sunday',
                title: 'Lower Body Strength',
              }),
            ],
          }),
        ]),
      );
    });

    it('plan-linter advisor: blocks event-based race-week label without race date', async () => {
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Plan with stale taper label',
        durationWeeks: 1,
        startDate: '2026-04-19',
        endDate: '2026-04-26',
        now: new Date('2026-04-19T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        // raceDate intentionally absent.
        goalMode: 'event_based',
        planData: {
          weeks: [
            {
              weekNumber: 1,
              focus: 'race week',
              sessions: [
                { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Easy Run', durationMinutes: 30 },
              ],
            },
          ],
        },
      });

      expect(result.lint.status).toBe('fail');
      expect(result.lint.blockers.some((w) => w.ruleId === 'no_fake_taper_without_event')).toBe(true);
      expect(result.lint.blockers.some((w) => w.ruleId === 'race_specific_plan_requires_race_date')).toBe(true);
    });

    it('does NOT apply the past-day floor to week 2+ (rolling 7-day envelope is correct)', async () => {
      // Plan generated Wed 2026-04-22; the same Mon target in week 2 should
      // schedule successfully (5 days from Wed = next Mon, which is the
      // legitimate week-2 Monday).
      const result = await persistGeneratedTrainingPlan({
        userId: 12,
        tenantId: 12,
        objective: 'Week 2 still gets Monday',
        durationWeeks: 2,
        startDate: '2026-04-22',
        endDate: '2026-05-06',
        now: new Date('2026-04-22T08:00:00.000Z'),
        preferencesJson: '{}',
        normalizedPreferredTime: '12:00',
        normalizedPreferredCardioTime: '07:00',
        normalizedPreferredStrengthTime: '12:30',
        busyWindows: [],
        planData: {
          weeks: [
            { weekNumber: 1, sessions: [
              { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'W1 Wed', durationMinutes: 40 },
            ] },
            { weekNumber: 2, sessions: [
              { dayOfWeek: 'Monday', sessionType: 'run', title: 'W2 Mon', durationMinutes: 50 },
              { dayOfWeek: 'Wednesday', sessionType: 'gym', title: 'W2 Wed', durationMinutes: 45 },
            ] },
          ],
        },
      });

      // Week 1 Wed is today → scheduled.
      // Week 2 Mon is 5 days from now → scheduled (NOT unscheduled).
      // Week 2 Wed is 7 days from now → scheduled.
      expect(result.totalSessions).toBe(3);
      expect(mockCreateSession).toHaveBeenCalledWith(expect.objectContaining({
        title: 'W2 Mon',
        status: 'scheduled',
      }));
    });
  });

  // F28 (Phase 3): support-debug traces must never COST the athlete their
  // payload. The old catch replaced a malformed preferences string with an
  // object containing ONLY the traces — silently discarding requestedTargets,
  // the spec, and the learning path. Low probability, unbounded blast radius.
  it('never replaces a malformed preferences payload with support-debug traces', async () => {
    const malformedPreferences = '{"requestedTargets":{"sessionsPerWeek":5}'; // truncated JSON
    await persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Strength block',
      durationWeeks: 1,
      startDate: '2026-04-19',
      endDate: '2026-04-26',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: malformedPreferences,
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        weeks: [{
          weekNumber: 1,
          sessions: [{
            dayOfWeek: 'Monday',
            sessionType: 'gym',
            title: 'Lift',
            durationMinutes: 45,
            // A selector trace forces the append path — without one the
            // function returns early and the catch never runs.
            exercises: [{ name: 'Squat', selectorTrace: { picked: 'squat' } }],
          }],
        }],
      },
    });

    expect(mockCreatePlan).toHaveBeenCalledWith(expect.objectContaining({
      preferences_json: malformedPreferences,
    }));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12 }),
      expect.stringContaining('malformed preferences'),
    );
  });

  // F4 (Phase 1B) failure injection: a throw partway through the plan graph
  // must leave NOTHING committed. Before the transaction, `createPlan` and the
  // completed `createWeek`/`createSession` calls were already durable, so a
  // failure here left a half-written plan that the athlete could see.
  it('rolls back the entire plan graph when a session insert throws', async () => {
    let sessionCalls = 0;
    mockCreateSession.mockImplementation(() => {
      sessionCalls += 1;
      // Throw on the SECOND session so the plan row and at least one session
      // are already written when the failure lands — exactly the half-written
      // state the pre-transaction code left behind.
      if (sessionCalls === 2) throw new Error('SQLITE_BUSY: database is locked');
      return { id: sessionCalls };
    });

    await expect(persistGeneratedTrainingPlan({
      userId: 12,
      tenantId: 12,
      objective: 'Marathon build',
      durationWeeks: 4,
      startDate: '2026-04-19',
      endDate: '2026-05-17',
      now: new Date('2026-04-19T00:00:00.000Z'),
      preferencesJson: '{"preferredTime":"12:00"}',
      normalizedPreferredTime: '12:00',
      normalizedPreferredCardioTime: '07:00',
      normalizedPreferredStrengthTime: '12:30',
      busyWindows: [],
      planData: {
        planName: 'Marathon Plan',
        sport: 'running',
        periodization: 'block',
        weeks: [
          {
            weekNumber: 1,
            focus: 'base',
            intensityPct: 72,
            sessions: [
              {
                dayOfWeek: 'Monday',
                sessionType: 'run',
                title: 'Base Run',
                durationMinutes: 50,
                description: 'Easy aerobic work.',
                exercises: [{ name: 'Warm-up', distance_km: 1 }],
              },
              {
                dayOfWeek: 'Monday',
                sessionType: 'gym',
                title: 'Runner Strength',
                durationMinutes: 40,
                description: 'Strength work.',
                exercises: [{ name: 'Goblet Squat', sets: 3, reps: 10, rpe: '7', restSec: 90 }],
              },
              {
                dayOfWeek: 'Tuesday',
                sessionType: 'rest',
                title: 'Rest',
                durationMinutes: 30,
              },
            ],
          },
        ],
      },
    })).rejects.toThrow('SQLITE_BUSY');

    // The throw escaped the transaction, so no provider work was attempted
    // either — calendar effects only run after a successful commit.
    expect(mockCreateEvent).not.toHaveBeenCalled();
    expect(mockLinkSessionToCalendar).not.toHaveBeenCalled();
    // Phase 1B same-transaction proof: the calendar-sync request is emitted
    // inside the plan-graph transaction, so a rolled-back graph must leave
    // ZERO outbox rows — a request for a plan that never committed would be
    // an orphaned provider write waiting to happen.
    const outboxCount = (transactionTestDb.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'event_outbox'",
    ).get() as { count: number }).count === 0
      ? 0
      : (transactionTestDb.prepare('SELECT COUNT(*) AS count FROM event_outbox').get() as { count: number }).count;
    expect(outboxCount).toBe(0);
  });
});
