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
const mockUpdateEvent = vi.fn();
const mockGetEventsForSources = vi.fn();
const mockSubmitSecretarySchedulingIntent = vi.fn();
const mockMarkSecretaryAgendaProviderSyncSatisfied = vi.fn();
const mockMarkSecretaryAgendaProviderCleanupRequired = vi.fn();
const mockSyncTrainingSecretaryCalendarHandoff = vi.fn();
const mockLoadLiveCalendarBusyWindowsForSecretaryIntent = vi.fn();
const mockRecordCalendarOwnership = vi.fn();
const mockMarkCalendarOwnershipDeleted = vi.fn();
const mockInvalidateCalendarCaches = vi.fn();
const mockInvalidateTrainingDerivedCaches = vi.fn();
const mockWithTrainingCalendarOperationLock = vi.fn();

vi.mock('../../src/services/unified-calendar', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/unified-calendar')>(
    '../../src/services/unified-calendar',
  );
  return {
    ...actual,
    createEvent: (...args: unknown[]) => mockCreateEvent(...args),
    deleteEvent: (...args: unknown[]) => mockDeleteEvent(...args),
    updateEvent: (...args: unknown[]) => mockUpdateEvent(...args),
    getEventsForSources: (...args: unknown[]) => mockGetEventsForSources(...args),
  };
});

vi.mock('../../src/services/cache-coherence-registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/cache-coherence-registry')>(
    '../../src/services/cache-coherence-registry',
  );
  return {
    ...actual,
    invalidateCalendarCaches: (...args: unknown[]) => mockInvalidateCalendarCaches(...args),
    invalidateTrainingDerivedCaches: (...args: unknown[]) => mockInvalidateTrainingDerivedCaches(...args),
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
  // F29: the worker fetches once per drain through the range entry point;
  // both exports share one mock so call-count assertions cover either path.
  loadLiveCalendarBusyWindowsForRange: (...args: unknown[]) =>
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent(...args),
}));

vi.mock('../../src/services/provider-preferences', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/provider-preferences')>(
    '../../src/services/provider-preferences',
  );
  return {
    ...actual,
    resolveCalendarWritePreference: () => ({
      source: 'google',
      requested: 'auto',
      warningCode: null,
      warning: null,
      availability: { google: true, outlook: false },
    }),
  };
});

vi.mock('../../src/services/training-secretary-calendar-handoff', () => ({
  syncTrainingSecretaryCalendarHandoff: (...args: unknown[]) =>
    mockSyncTrainingSecretaryCalendarHandoff(...args),
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
    markCalendarOwnershipDeleted: (...args: unknown[]) => {
      const implementation = mockMarkCalendarOwnershipDeleted.getMockImplementation();
      return implementation
        ? mockMarkCalendarOwnershipDeleted(...args)
        : actual.markCalendarOwnershipDeleted(...(args as [any]));
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

vi.mock('../../src/services/training-operation-locks', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/training-operation-locks')>(
    '../../src/services/training-operation-locks',
  );
  return {
    ...actual,
    withTrainingCalendarOperationLock: (...args: unknown[]) => {
      const implementation = mockWithTrainingCalendarOperationLock.getMockImplementation();
      return implementation
        ? mockWithTrainingCalendarOperationLock(...args)
        : actual.withTrainingCalendarOperationLock(...(args as Parameters<typeof actual.withTrainingCalendarOperationLock>));
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
import { incrementPlanVersion, recordCalendarOwnership } from '../../src/services/training-plan-lifecycle';
import {
  acquireTrainingCalendarOperationLock,
  _resetTrainingOperationLocksForTests,
  TrainingOperationLockError,
  type TrainingOperationLockLease,
  type TrainingOperationName,
} from '../../src/services/training-operation-locks';
import { executeWeekReflow } from '../../src/services/training-week-reflow';
import { executeWeekReflowWithPropagation } from '../../src/services/training-week-reflow-propagation';
import { executeCoachActions } from '../../src/services/coach-kernel/coach-action-executor';
import {
  TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
  TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE,
  processTrainingPlanCalendarSyncJobs,
  normalizeTrainingPlanCalendarSyncPayload,
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

function installInjectedOperationLease(operation: TrainingOperationName): {
  lose(): void;
  assertActive: ReturnType<typeof vi.fn>;
} {
  let lost = false;
  const controller = new AbortController();
  const assertActive = vi.fn(() => {
    if (lost) throw new TrainingOperationLockError(operation, 1);
  });
  const lease = vi.fn() as unknown as TrainingOperationLockLease;
  Object.defineProperties(lease, {
    signal: { value: controller.signal, enumerable: true },
    assertActive: { value: assertActive, enumerable: true },
  });
  mockWithTrainingCalendarOperationLock.mockImplementation(async (_input, callback) => {
    assertActive();
    try {
      const result = await callback(lease);
      assertActive();
      return result;
    } finally {
      lease();
    }
  });
  return {
    lose: () => {
      lost = true;
      controller.abort();
    },
    assertActive,
  };
}

function seedLinkedReflowTarget(
  db: Database.Database,
  options: {
    siblingOverlapsTarget?: boolean;
    calendarSource?: 'google' | 'outlook';
    calendarEventId?: string;
  } = {},
): {
  plan: trainingPlans.TrainingPlan;
  sessionId: number;
  weekId: number;
  desiredStart: string;
  desiredEnd: string;
  siblingSessionId: number;
  siblingStart: string;
  siblingEnd: string;
} {
  const calendarSource = options.calendarSource ?? 'google';
  const calendarEventId = options.calendarEventId ?? 'evt-linked-f24';
  const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
  const sessionId = sessionIds[0];
  const weekId = Number((db.prepare(
    'SELECT week_id FROM training_sessions WHERE id = ?',
  ).get(sessionId) as { week_id: number }).week_id);
  const desiredStart = futureIso(10);
  const desiredEnd = futureIso(11);
  const siblingStart = options.siblingOverlapsTarget ? desiredStart : futureIso(12);
  const siblingEnd = options.siblingOverlapsTarget ? desiredEnd : futureIso(13);
  const sibling = trainingPlans.createSession({
    week_id: weekId,
    plan_id: plan.id,
    day_of_week: 'Friday',
    session_type: 'strength',
    title: 'Unchanged sibling session',
    description: 'Canonical persisted schedule that must participate in reflow arbitration.',
    duration_minutes: 60,
    intensity_text: 'RPE 60%',
    session_identity_key: `plan:${plan.id}|week:1|day:friday|type:strength|slot:1`,
    session_shape_hash: 'sibling-shape-f24',
    status: 'scheduled',
    scheduled_start_at: siblingStart,
    scheduled_end_at: siblingEnd,
  });
  db.prepare(`
    UPDATE fitness_training_plans SET adaptation_revision = 1 WHERE id = ?
  `).run(plan.id);
  db.prepare(`
    UPDATE training_sessions
       SET day_of_week = 'Thursday', status = 'reflowed',
           schedule_status = 'reflowed',
           schedule_reason_code = 'f24_reflow',
           scheduled_start_at = ?, scheduled_end_at = ?,
           calendar_event_id = ?, calendar_source = ?
     WHERE id = ? AND plan_id = ?
  `).run(desiredStart, desiredEnd, calendarEventId, calendarSource, sessionId, plan.id);
  recordCalendarOwnership({
    planId: plan.id,
    planVersion: 1,
    sessionId,
    tenantId: TENANT_ID,
    userId: USER_ID,
    eventId: calendarEventId,
    source: calendarSource,
    syncVersion: 'training_calendar_sync_v1',
  });
  // Stronger provider-boundary guarantee: a synced mapping is valid only
  // when its immutable target is pinned to the same provider source.
  db.prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, provider_event_id, provider_source, provider_target,
      version, title, start_at, end_at, duration_minutes, decision_action,
      decision_reason_codes_json, source_shape_hash, scheduled_segments_json,
      created_at, updated_at
    ) VALUES (
      ?, ?, 'training', 'schedule_training_session', 'schedule_this',
      ?, 'training_session', ?, ?, 'synced', 'synced', ?, ?, ?,
      1, 'Tempo', ?, ?, 60, 'scheduled', '[]', 'legacy-shape', '[]',
      datetime('now'), datetime('now')
    )
  `).run(
    `sec-existing-${sessionId}`,
    `training:${plan.id}:1:${sessionId}`,
    String(sessionId),
    USER_ID,
    String(TENANT_ID),
    calendarEventId,
    calendarSource,
    calendarSource,
    futureIso(3),
    futureIso(4),
  );
  return {
    plan,
    sessionId,
    weekId,
    desiredStart,
    desiredEnd,
    siblingSessionId: sibling.id,
    siblingStart,
    siblingEnd,
  };
}

function enqueueReflowSync(input: {
  planId: number;
  weekId: number;
  sessionIds: number[];
  adaptationRevision?: number;
  reflowScope?: 'week' | 'plan';
  syncTarget?: 'google' | 'outlook' | 'auto' | 'none' | 'apple';
  key?: string;
}): void {
  enqueueJob({
    tenantId: TENANT_ID,
    userId: USER_ID,
    jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
    payload: {
      operation: 'week_reflow',
      planId: input.planId,
      planVersion: 1,
      adaptationRevision: input.adaptationRevision ?? 1,
      weekId: input.weekId,
      sessionIds: input.sessionIds,
      reflowScope: input.reflowScope ?? 'week',
      syncTarget: input.syncTarget ?? 'google',
    },
    idempotencyKey: input.key ?? `f24-reflow:${input.planId}:${input.adaptationRevision ?? 1}`,
    maxAttempts: 5,
  });
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
    mockUpdateEvent.mockReset();
    mockGetEventsForSources.mockReset();
    mockSubmitSecretarySchedulingIntent.mockReset();
    mockMarkSecretaryAgendaProviderSyncSatisfied.mockReset();
    mockMarkSecretaryAgendaProviderCleanupRequired.mockReset();
    mockSyncTrainingSecretaryCalendarHandoff.mockReset();
    mockLoadLiveCalendarBusyWindowsForSecretaryIntent.mockReset();
    mockRecordCalendarOwnership.mockReset();
    mockMarkCalendarOwnershipDeleted.mockReset();
    mockLinkSessionToCalendar.mockReset();
    mockInvalidateCalendarCaches.mockReset();
    mockInvalidateTrainingDerivedCaches.mockReset();
    mockWithTrainingCalendarOperationLock.mockReset();

    let eventCounter = 0;
    mockCreateEvent.mockImplementation(async () => {
      eventCounter += 1;
      return { id: `evt-${eventCounter}`, source: 'google' };
    });
    mockDeleteEvent.mockResolvedValue(undefined);
    mockUpdateEvent.mockImplementation(async (input: any, source: string) => ({
      id: input.event_id,
      source,
      title: input.new_title ?? 'Training session',
      start: input.new_start,
      end: input.new_end,
    }));
    mockGetEventsForSources.mockResolvedValue([]);
    mockMarkSecretaryAgendaProviderSyncSatisfied.mockReturnValue({ ok: true, updated: true });
    mockMarkSecretaryAgendaProviderCleanupRequired.mockImplementation((input: any) => ({
      agendaItemId: input.agendaItemId,
      providerEventId: input.clearProviderMapping ? null : input.providerEventId,
      providerSource: input.clearProviderMapping ? null : input.providerSource,
      providerSyncState: input.providerSyncState ?? 'deleted',
      lifecycleState: input.lifecycleState ?? 'unscheduled',
    }));
    mockSyncTrainingSecretaryCalendarHandoff.mockImplementation(async (input: any) => {
      const decision = mockSubmitSecretarySchedulingIntent.mock.results.at(-1)?.value as any;
      if (decision?.agendaItem?.lifecycleState === 'proposed') {
        return {
          outcome: 'pending',
          agendaItemId: input.agendaItemId,
          providerEventId: null,
          providerSource: null,
          startAt: null,
          endAt: null,
          reasonCode: 'priority_preemption_dependencies_pending',
          retryable: true,
          agendaItem: decision.agendaItem,
          syncResults: [],
        };
      }
      if (decision?.agendaItem?.lifecycleState === 'canceled'
          || decision?.agendaItem?.providerSyncFailureDisposition === 'terminal') {
        return {
          outcome: 'terminal',
          agendaItemId: input.agendaItemId,
          providerEventId: null,
          providerSource: null,
          startAt: null,
          endAt: null,
          reasonCode: 'priority_preemption_terminal_failure',
          retryable: false,
          agendaItem: decision.agendaItem,
          syncResults: [],
        };
      }
      const cleanupCalls = mockMarkSecretaryAgendaProviderCleanupRequired.mock.calls
        .map((call: any[]) => call[0]);
      const cleanup = [...cleanupCalls]
        .reverse()
        .find((call: any) => call?.agendaItemId === input.agendaItemId);
      if (cleanup?.providerEventId) {
        try {
          await mockDeleteEvent(cleanup.providerEventId, cleanup.providerSource, input.ownerUserId);
          return {
            outcome: 'cleanup_complete',
            agendaItemId: input.agendaItemId,
            providerEventId: null,
            providerSource: null,
            startAt: null,
            endAt: null,
            reasonCode: 'provider_event_deleted',
            retryable: false,
            agendaItem: null,
            syncResults: [],
          };
        } catch {
          return {
            outcome: 'pending',
            agendaItemId: input.agendaItemId,
            providerEventId: cleanup.providerEventId,
            providerSource: cleanup.providerSource,
            startAt: null,
            endAt: null,
            reasonCode: 'provider_delete_failed',
            retryable: true,
            agendaItem: null,
            syncResults: [],
          };
        }
      }
      const projection = input.trainingProjection;
      if (projection?.existingProviderEventId) {
        let updated: any;
        try {
          updated = await mockUpdateEvent({
            event_id: projection.existingProviderEventId,
            new_title: projection.title,
            new_start: projection.startAt,
            new_end: projection.endAt,
            new_description: projection.description,
          }, input.providerSource, input.ownerUserId, {});
        } catch (error) {
          // Mirror Secretary's production recovery contract: an unknown
          // update outcome is resolved by exact-id readback, never by a fresh
          // create. The worker only consumes the recovered durable mapping.
          const readback = await mockGetEventsForSources({
            sources: [input.providerSource],
            userId: input.ownerUserId,
            tenantId: input.tenantId,
          });
          updated = readback.find((event: any) => event.id === projection.existingProviderEventId);
          if (!updated) throw error;
        }
        return {
          outcome: 'ready',
          agendaItemId: input.agendaItemId,
          providerEventId: updated?.id ?? projection.existingProviderEventId,
          providerSource: updated?.source ?? input.providerSource,
          startAt: projection.startAt,
          endAt: projection.endAt,
          reasonCode: 'provider_event_updated',
          retryable: false,
          agendaItem: null,
          syncResults: [],
        };
      }
      const created = await mockCreateEvent({
        title: projection.title,
        start: projection.startAt,
        end: projection.endAt,
        description: projection.description,
      }, input.providerSource, input.ownerUserId, { tenantId: input.tenantId });
      return {
        outcome: 'ready',
        agendaItemId: input.agendaItemId,
        providerEventId: created.id,
        providerSource: created.source,
        startAt: projection.startAt,
        endAt: projection.endAt,
        reasonCode: 'provider_event_created',
        retryable: false,
        agendaItem: null,
        syncResults: [],
      };
    });
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
      // F29: one range-shaped fetch per drain replaces the per-intent call.
      expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).toHaveBeenCalledTimes(1);
      expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: USER_ID,
          tenantId: TENANT_ID,
          start: expect.any(String),
          end: expect.any(String),
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
      // Stronger boundary: Training no longer performs a second advisory
      // sync-satisfied write after Secretary's durable handoff reports ready.
      // The provider mapping has one owner and one state machine.
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
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

  it.each(['attached', 'updated'] as const)(
    'records Secretary %s outcomes truthfully instead of inflating eventsCreated',
    async (action) => {
      const db = createMigratedTestDatabase();
      await withDatabaseForTestAsync(db, async () => {
        const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
        emitSyncRequest(plan, sessionIds);
        await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: `route-${action}` });
        mockSyncTrainingSecretaryCalendarHandoff.mockResolvedValue({
          outcome: 'ready',
          agendaItemId: `sec-${sessionIds[0]}`,
          providerEventId: `evt-${action}`,
          providerSource: 'google',
          startAt: futureIso(3),
          endAt: futureIso(4),
          reasonCode: `provider_event_${action}`,
          retryable: false,
          agendaItem: null,
          syncResults: [{ action, reasonCode: `provider_event_${action}` }],
        });

        const drained = await processTrainingPlanCalendarSyncJobs({
          limit: 5,
          lockOwner: `drain-${action}`,
        });

        expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
        expect(mockCreateEvent).not.toHaveBeenCalled();
        expect(planCalendarSyncSummary(plan.id)).toMatchObject({
          state: 'synced',
          eventsCreated: 0,
          eventsAttached: action === 'attached' ? 1 : 0,
          eventsUpdated: action === 'updated' ? 1 : 0,
          eventsAlreadyOwned: 0,
        });
      });
      db.close();
    },
  );

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

  it('ends pending calendar-sync state when the operation-lock store is unavailable on the final attempt', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      db.prepare('UPDATE fitness_training_plans SET preferences_json = ? WHERE id = ?').run(
        JSON.stringify({
          preferredTime: '07:00',
          calendarSync: {
            schemaVersion: 1,
            state: 'not_synced',
            pending: true,
            requestedSessions: 1,
          },
        }),
        plan.id,
      );
      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: { planId: plan.id, planVersion: 1, sessionIds, syncTarget: 'google' },
        idempotencyKey: 'lock-store-unavailable-final-attempt',
        maxAttempts: 1,
      });
      db.exec(`
        CREATE TRIGGER reject_training_operation_lock_insert
        BEFORE INSERT ON training_operation_locks
        BEGIN
          SELECT RAISE(ABORT, 'training lock store unavailable');
        END;
      `);

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'lock-store-unavailable',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'create_failed',
        pending: false,
        lastErrorCode: 'TRAINING_OPERATION_LOCK_UNAVAILABLE',
      });
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
      // Stronger guarantee: a compensated split-brain is visible as a typed
      // first-attempt dead letter, never acknowledged as successful work.
      // Secretary retains the exact id until its cleanup state machine settles.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-1', 'google', USER_ID);
      expect(trainingPlans.getSessionById(sessionIds[0])?.status).toBe('unscheduled');
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith(expect.objectContaining({
        providerEventId: 'evt-1',
        providerSource: 'google',
        providerSyncState: 'delete_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_ownership_record_failed',
        clearProviderMapping: false,
      }));
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({ state: 'create_failed' });
    });
    db.close();
  });

  it('fetches live provider busy windows once per drain, not once per session (F29)', async () => {
    // §5/F29: the inline phase fetched the athlete's live calendar once PER
    // SESSION — a 96-session plan meant 96 provider reads. The drain now
    // performs one bounded fetch covering the whole plan window and shares
    // it across every Secretary arbitration.
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 6 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'drain-test' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(6);
      expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).toHaveBeenCalledTimes(1);
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
      // Stronger guarantee: a malformed payload cannot be acknowledged as a
      // successful no-op; it is first-attempt terminal with zero provider work.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
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

  it('does not call the provider directly while a preemptive agenda winner is still proposed', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
        status: 'scheduled',
        reasonCodes: ['priority_preemption_applied'],
        selectedSlot: intent.preferredWindows[0],
        agendaItem: {
          agendaItemId: `sec-preemptive-${intent.sourceEntityId}`,
          sourceIntentId: intent.intentId,
          lifecycleState: 'proposed',
          providerSyncState: 'not_synced',
        },
        explanation: 'exact loser cleanup is pending',
        alternativeSlots: [],
        conflicts: [],
        downstreamImplications: [],
        confidence: 'high',
        feedback: null,
      }));

      await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'preemption-fence-red' });

      // Stronger guarantee: Training never treats Secretary persistence as an
      // advisory pre-call check. Only the exact Secretary provider claim may
      // mutate after the dependency graph reaches provider-eligible state.
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(sessionIds[0])?.calendar_event_id).toBeNull();
    });
    db.close();
  });

  it('does not call the provider after Secretary terminalizes the preemption winner', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-test' });
      mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any) => ({
        status: 'scheduled',
        reasonCodes: ['priority_preemption_terminal_failure'],
        selectedSlot: intent.preferredWindows[0],
        agendaItem: {
          agendaItemId: `sec-terminal-${intent.sourceEntityId}`,
          sourceIntentId: intent.intentId,
          lifecycleState: 'canceled',
          providerSyncState: 'failed',
          providerFailureDisposition: 'terminal',
        },
        explanation: 'loser cleanup failed terminally; winner is canceled',
        alternativeSlots: [],
        conflicts: [],
        downstreamImplications: [],
        confidence: 'high',
        feedback: null,
      }));

      await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'preemption-terminal-red' });

      // Stronger guarantee: a terminalized winner cannot escape through the
      // Training writer after Secretary closes the exact dependency graph.
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(sessionIds[0])?.calendar_event_id).toBeNull();
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
      // Stronger boundary: auto is resolved once before Secretary intent
      // persistence, so the durable provider claim and provider write share
      // one exact immutable source.
      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.any(Object),
        'google',
        USER_ID,
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      expect(trainingPlans.getSessionById(sessionIds[0])?.calendar_event_id).toMatch(/^evt-/);
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'synced',
        pending: false,
        provider: 'google',
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
      // Stronger guarantee: an unknown cleanup outcome is terminal for the
      // create job; retrying it could duplicate the provider-side event.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
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
      // Stronger guarantee: terminal compensation dead-letters immediately;
      // it is not counted as a successful completed job.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
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
      // Unknown create outcome cannot be replayed safely. The typed terminal
      // queue contract records it as a first-attempt dead letter.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
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

  it('records an honest not_synced summary without provider work when every window is corrupt', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const zeroDuration = futureIso(3);
      const { plan, sessionIds } = seedPlan({
        sessionCount: 2,
        sessionOverrides: [
          { scheduled_start_at: zeroDuration, scheduled_end_at: zeroDuration },
          { scheduled_start_at: 'not-an-instant', scheduled_end_at: 'also-not-an-instant' },
        ],
      });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-all-corrupt' });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'drain-all-corrupt',
      });

      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockLoadLiveCalendarBusyWindowsForSecretaryIntent).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(planCalendarSyncSummary(plan.id)).toMatchObject({
        state: 'not_synced',
        pending: false,
        requestedSessions: 2,
        eventsCreated: 0,
        eventsAttached: 0,
        eventsUpdated: 0,
        eventsAlreadyOwned: 0,
        eventsFailed: 0,
        eventsSkipped: 2,
        lastErrorCode: null,
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

  it('F35 leaves a Secretary-owned provider mapping untouched and refuses local writes after lease loss', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-f35-create-loss' });
      const injected = installInjectedOperationLease('calendar_generate');
      mockCreateEvent.mockImplementationOnce(async () => {
        injected.lose();
        return { id: 'evt-stale-owner', source: 'google' };
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'drain-f35-create-loss',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      // Stronger lock guarantee: once the Training lease is lost, this stale
      // worker performs no new provider effect. Secretary's durable mapping
      // remains the authority for a later attach/cleanup reconciliation.
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(sessionIds[0])).toMatchObject({
        status: 'scheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(plan.id, sessionIds[0])).toEqual({ count: 0 });
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('F35 stops a create batch from starting more provider writes after lease loss', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 3 });
      emitSyncRequest(plan, sessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-f35-batch-loss' });
      const injected = installInjectedOperationLease('calendar_generate');
      mockCreateEvent.mockImplementationOnce(async () => {
        injected.lose();
        return { id: 'evt-stale-batch-owner', source: 'google' };
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'drain-f35-batch-loss',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM training_agenda_event_ownership
         WHERE plan_id = ?
      `).get(plan.id)).toEqual({ count: 0 });
    });
    db.close();
  });

  it('F35 refuses reflow success writes when the lease is lost during provider update', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      const injected = installInjectedOperationLease('calendar_reflow');
      mockUpdateEvent.mockImplementationOnce(async () => {
        injected.lose();
        return {
          id: 'evt-linked-f24',
          source: 'google',
          title: 'Tempo',
          start: target.desiredStart,
          end: target.desiredEnd,
        };
      });
      // Without an in-callback fence, read-back makes the stale update look
      // successful and the worker advances durable ownership before the outer
      // callback-exit assertion finally notices the lost lease.
      mockGetEventsForSources.mockResolvedValue([{
        id: 'evt-linked-f24',
        source: 'google',
        title: 'Tempo',
        start: target.desiredStart,
        end: target.desiredEnd,
      }]);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'drain-f35-reflow-update-loss',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockGetEventsForSources).not.toHaveBeenCalled();
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
      expect(db.prepare(`
        SELECT sync_version, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        sync_version: 'training_calendar_sync_v1',
        status: 'active',
      });
    });
    db.close();
  });

  it('F35 refuses reflow unlink writes when the lease is lost during provider delete', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE training_sessions
           SET status = 'skipped', schedule_status = 'dropped'
         WHERE id = ? AND plan_id = ?
      `).run(target.sessionId, target.plan.id);
      const injected = installInjectedOperationLease('calendar_reflow');
      mockDeleteEvent.mockImplementationOnce(async () => {
        injected.lose();
      });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'drain-f35-reflow-delete-loss',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
      });
      expect(db.prepare(`
        SELECT status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(target.plan.id, target.sessionId)).toEqual({ status: 'active' });
      // Marking delete_failed happened before the provider call. Lease loss
      // then prevents the tombstone and all local retirement writes.
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledTimes(1);
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).toHaveBeenCalledWith(
        expect.objectContaining({
          providerEventId: 'evt-linked-f24',
          providerSyncState: 'delete_failed',
          clearProviderMapping: false,
        }),
      );
    });
    db.close();
  });

  it('F24 routes sanitizer-safe reflow revision fields into the durable job', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      const weekId = Number((db.prepare(
        'SELECT week_id FROM training_sessions WHERE id = ?',
      ).get(sessionIds[0]) as { week_id: number }).week_id);
      emitSyncRequest(plan, sessionIds, {
        operation: 'week_reflow',
        adaptationRevision: 7,
        weekId,
      });

      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'route-f24' });
      const jobs = jobRow(db);
      expect(jobs).toHaveLength(1);
      expect(JSON.parse(String(jobs[0]?.payload_json))).toMatchObject({
        operation: 'week_reflow',
        planId: plan.id,
        planVersion: 1,
        adaptationRevision: 7,
        weekId,
        sessionIds,
        syncTarget: 'google',
      });
    });
    db.close();
  });

  it('F24 reconciles one linked session by id, reuses its provider id, versions Secretary, and invalidates both cache layers', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      mockGetEventsForSources.mockResolvedValue([{
        id: 'evt-linked-f24',
        source: 'google',
        title: 'Tempo',
        start: target.desiredStart,
        end: target.desiredEnd,
      }]);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'f24-fresh' });

      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
      expect(mockUpdateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_id: 'evt-linked-f24',
          new_start: target.desiredStart,
          new_end: target.desiredEnd,
        }),
        'google',
        USER_ID,
        expect.any(Object),
      );
      // Secretary owns provider verification. A clean exact update need not
      // force an extra Training-side provider read.
      expect(mockGetEventsForSources).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          intentId: `training:${target.plan.id}:1:${target.sessionId}`,
          preferredWindows: [expect.objectContaining({
            start: target.desiredStart,
            end: target.desiredEnd,
          })],
        }),
        expect.objectContaining({
          additionalBusyWindows: expect.arrayContaining([
            expect.objectContaining({
              start: target.siblingStart,
              end: target.siblingEnd,
              label: 'existing training session',
            }),
          ]),
          providerMappingTransfer: {
            providerEventId: 'evt-linked-f24',
            providerSource: 'google',
          },
        }),
      );
      // Stronger guarantee: only Secretary mutates its durable provider
      // mapping; Training consumes the handoff and records local ownership.
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
      expect(db.prepare(`
        SELECT sync_version FROM training_agenda_event_ownership
        WHERE plan_id = ? AND session_id = ? AND status = 'active'
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        sync_version: 'training_reflow_v1:p1:a1',
      });
      expect(trainingPlans.getSessionById(target.sessionId)?.calendar_event_id).toBe('evt-linked-f24');
      expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(USER_ID);
      expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(USER_ID);

      // A different queue id for the same business revision must hit the
      // ownership revision fence, not repeat provider or Secretary effects.
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-duplicate-lease',
      });
      const replay = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'f24-replay' });
      expect(replay).toMatchObject({ completed: 1, failed: 0 });
      expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledTimes(1);
    });
    db.close();
  });

  it.each([
    { from: 'google' as const, to: 'outlook' as const },
    { from: 'outlook' as const, to: 'google' as const },
  ])('F24 switches $from→$to by deleting the old exact mapping before one idempotent create', async ({ from, to }) => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const oldEventId = `evt-old-${from}`;
      const target = seedLinkedReflowTarget(db, {
        calendarSource: from,
        calendarEventId: oldEventId,
      });
      mockCreateEvent.mockImplementation(async (_input: any, source: string) => ({
        id: `evt-new-${source}`,
        source,
      }));
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        syncTarget: to,
        key: `f24-switch-${from}-${to}`,
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: `f24-switch-${from}-${to}`,
      });

      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledWith(oldEventId, from, USER_ID);
      expect(mockCreateEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateEvent).toHaveBeenCalledWith(
        expect.any(Object),
        to,
        USER_ID,
        expect.objectContaining({ tenantId: TENANT_ID }),
      );
      expect(mockDeleteEvent.mock.invocationCallOrder[0])
        .toBeLessThan(mockCreateEvent.mock.invocationCallOrder[0]!);
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: `evt-new-${to}`,
        calendar_source: to,
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND plan_version = 1 AND session_id = ?
         ORDER BY id ASC
      `).all(target.plan.id, target.sessionId)).toEqual([
        { calendar_event_id: oldEventId, calendar_source: from, status: 'deleted' },
        { calendar_event_id: `evt-new-${to}`, calendar_source: to, status: 'active' },
      ]);

      mockDeleteEvent.mockClear();
      mockCreateEvent.mockClear();
      mockUpdateEvent.mockClear();
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        syncTarget: to,
        key: `f24-switch-${from}-${to}-replay`,
      });
      const replay = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: `f24-switch-${from}-${to}-replay`,
      });
      expect(replay).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('F24 resumes a provider switch after target-create failure without deleting the old event twice', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db, {
        calendarSource: 'google',
        calendarEventId: 'evt-switch-retry-old',
      });
      mockCreateEvent
        .mockRejectedValueOnce(new Error('outlook create temporarily unavailable'))
        .mockResolvedValue({ id: 'evt-switch-retry-new', source: 'outlook' });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        syncTarget: 'outlook',
        key: 'f24-switch-create-retry',
      });

      const first = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-switch-create-retry-first',
      });
      expect(first).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-switch-retry-old', 'google', USER_ID);
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: null,
        calendar_source: null,
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).all(target.plan.id, target.sessionId)).toEqual([
        {
          calendar_event_id: 'evt-switch-retry-old',
          calendar_source: 'google',
          status: 'deleted',
        },
      ]);

      makeJobDue(db);
      const second = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-switch-create-retry-second',
      });
      expect(second).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateEvent).toHaveBeenCalledTimes(2);
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-switch-retry-new',
        calendar_source: 'outlook',
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
         ORDER BY id ASC
      `).all(target.plan.id, target.sessionId)).toEqual([
        {
          calendar_event_id: 'evt-switch-retry-old',
          calendar_source: 'google',
          status: 'deleted',
        },
        {
          calendar_event_id: 'evt-switch-retry-new',
          calendar_source: 'outlook',
          status: 'active',
        },
      ]);
      expect(jobRow(db)[0]).toMatchObject({ status: 'completed', last_error: null });
      expect(String(jobRow(db)[0]?.last_error ?? '')).not.toContain('authority_missing');
    });
    db.close();
  });

  it('F24 adopts a legacy exact provider link into Secretary before switching providers', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db, {
        calendarSource: 'google',
        calendarEventId: 'evt-legacy-no-agenda',
      });
      db.prepare(`
        DELETE FROM secretary_agenda_items
         WHERE source_intent_id = ? AND owner_user_id = ? AND tenant_id = ?
      `).run(`training:${target.plan.id}:1:${target.sessionId}`, USER_ID, String(TENANT_ID));
      mockCreateEvent.mockResolvedValue({ id: 'evt-legacy-switched', source: 'outlook' });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        syncTarget: 'outlook',
        key: 'f24-switch-legacy-no-agenda',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-switch-legacy-no-agenda',
      });

      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          intentId: `training:${target.plan.id}:1:${target.sessionId}`,
        }),
        expect.objectContaining({
          providerMappingTransfer: {
            providerEventId: 'evt-legacy-no-agenda',
            providerSource: 'google',
          },
        }),
      );
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-legacy-no-agenda', 'google', USER_ID);
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockDeleteEvent.mock.invocationCallOrder[0])
        .toBeLessThan(mockCreateEvent.mock.invocationCallOrder[0]!);
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-legacy-switched',
        calendar_source: 'outlook',
      });
    });
    db.close();
  });

  it('F24 completes a mixed linked/unlinked plan pause and deletes only owned provider state', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE fitness_training_plans SET status = 'paused' WHERE id = ?
      `).run(target.plan.id);
      db.prepare(`
        UPDATE training_sessions
           SET schedule_status = 'dropped', schedule_reason_code = 'medical_pause'
         WHERE id IN (?, ?)
      `).run(target.sessionId, target.siblingSessionId);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId, target.siblingSessionId],
        reflowScope: 'plan',
        key: 'f24-mixed-linked-unlinked-pause',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-mixed-linked-unlinked-pause',
      });

      // Stronger guarantee: an intentionally unlinked affected row is
      // already provider-reconciled, not a retryable REFLOW_LINK_MISSING.
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(jobRow(db)).toEqual([
        expect.objectContaining({
          status: 'completed',
          last_error: null,
        }),
      ]);
      expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
      expect(mockDeleteEvent).toHaveBeenCalledWith('evt-linked-f24', 'google', USER_ID);
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.siblingSessionId)).toMatchObject({
        schedule_status: 'dropped',
        calendar_event_id: null,
        calendar_source: null,
      });
    });
    db.close();
  });

  it.each(['none', 'apple'] as const)(
    'F24 preserves the deliberate %s no-provider target and performs zero provider writes',
    async (syncTarget) => {
      expect(normalizeTrainingPlanCalendarSyncPayload({
        operation: 'week_reflow',
        planId: 42,
        planVersion: 1,
        adaptationRevision: 1,
        weekId: 7,
        sessionIds: [8],
        syncTarget,
      })).toMatchObject({ syncTarget });

      const db = createMigratedTestDatabase();
      await withDatabaseForTestAsync(db, async () => {
        const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
        const weekId = Number((db.prepare(
          'SELECT week_id FROM training_sessions WHERE id = ?',
        ).get(sessionIds[0]) as { week_id: number }).week_id);
        db.prepare(`
          UPDATE fitness_training_plans SET adaptation_revision = 1 WHERE id = ?
        `).run(plan.id);
        db.prepare(`
          UPDATE training_sessions
             SET status = 'reflowed', schedule_status = 'reflowed'
           WHERE id = ?
        `).run(sessionIds[0]);
        enqueueReflowSync({
          planId: plan.id,
          weekId,
          sessionIds,
          syncTarget,
          key: `f24-no-provider-${syncTarget}`,
        });

        const drained = await processTrainingPlanCalendarSyncJobs({
          limit: 5,
          lockOwner: `f24-no-provider-${syncTarget}`,
        });
        expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
        expect(mockCreateEvent).not.toHaveBeenCalled();
        expect(mockUpdateEvent).not.toHaveBeenCalled();
        expect(mockDeleteEvent).not.toHaveBeenCalled();
        expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
      });
      db.close();
    },
  );

  it('rejects a partially malformed sessionIds array instead of broadening it to an unrestricted plan scan', async () => {
    expect(normalizeTrainingPlanCalendarSyncPayload({
      planId: 42,
      planVersion: 1,
      sessionIds: [8, 'not-a-session'],
      syncTarget: 'google',
    })).toBeNull();
    expect(normalizeTrainingPlanCalendarSyncPayload({
      planId: 42,
      planVersion: 1,
      sessionIds: [],
      syncTarget: 'google',
    })).toMatchObject({ sessionIds: [] });
  });

  it('treats an explicit empty plan-create session scope as empty, never as all sessions', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan } = seedPlan({ sessionCount: 2 });
      enqueueJob({
        tenantId: TENANT_ID,
        userId: USER_ID,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload: {
          operation: 'plan_create',
          planId: plan.id,
          planVersion: 1,
          sessionIds: [],
          syncTarget: 'google',
        },
        idempotencyKey: 'f24-explicit-empty-session-scope',
        maxAttempts: 5,
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-explicit-empty-session-scope',
      });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it.each([
    {
      name: 'malformed session ids',
      userId: USER_ID,
      payload: { planId: 1, planVersion: 1, sessionIds: [1, 'bad'], syncTarget: 'google' },
      code: 'MALFORMED_PAYLOAD',
    },
    {
      name: 'missing sync target',
      userId: USER_ID,
      payload: { planId: 1, planVersion: 1, sessionIds: [1] },
      code: 'SYNC_TARGET_MISSING',
    },
    {
      name: 'missing user scope',
      userId: null,
      payload: { planId: 1, planVersion: 1, sessionIds: [1], syncTarget: 'google' },
      code: 'INVALID_USER_SCOPE',
    },
    {
      name: 'missing reflow plan',
      userId: USER_ID,
      payload: {
        operation: 'week_reflow',
        planId: 999_999,
        planVersion: 1,
        adaptationRevision: 1,
        weekId: 1,
        sessionIds: [1],
        reflowScope: 'week',
        syncTarget: 'google',
      },
      code: 'REFLOW_PLAN_MISSING',
    },
  ])('dead-letters terminal $name once and never executes provider work', async ({ userId, payload, code }) => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      enqueueJob({
        tenantId: TENANT_ID,
        userId,
        jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
        payload,
        idempotencyKey: `f24-terminal-input-${code}`,
        maxAttempts: 5,
      });
      const first = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: `f24-terminal-input-${code}`,
      });
      expect(first).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]).toMatchObject({
        status: 'dead_letter',
        attempts: 1,
        last_error: expect.stringContaining(code),
      });
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockDeleteEvent).not.toHaveBeenCalled();

      makeJobDue(db);
      const second = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: `f24-terminal-input-${code}-replay`,
      });
      expect(second).toMatchObject({ completed: 0, failed: 0, deadLetter: 0 });
      expect(jobRow(db)[0]?.attempts).toBe(1);
    });
    db.close();
  });

  it('F24 propagates a plan-wide safety pause through the outbox and deletes every owned future event', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const { plan, sessionIds } = seedPlan({ sessionCount: 1 });
      const firstWeekId = Number((db.prepare(
        'SELECT week_id FROM training_sessions WHERE id = ?',
      ).get(sessionIds[0]) as { week_id: number }).week_id);
      const secondWeek = trainingPlans.createWeek({
        plan_id: plan.id,
        week_number: 2,
        focus: 'recovery',
        intensity_pct: 50,
        volume_sessions: 1,
      });
      const secondSession = trainingPlans.createSession({
        week_id: secondWeek.id,
        plan_id: plan.id,
        day_of_week: 'Wednesday',
        session_type: 'run',
        title: 'Future recovery run',
        description: 'A second-week owned event that a plan-wide safety pause must remove.',
        duration_minutes: 35,
        intensity_text: 'RPE 40%',
        session_identity_key: `plan:${plan.id}|week:2|day:wednesday|type:run|slot:1`,
        session_shape_hash: 'pause-future-week-two',
        status: 'scheduled',
        scheduled_start_at: futureIso(28),
        scheduled_end_at: futureIso(29),
      });
      const allSessionIds = [sessionIds[0], secondSession.id];

      // Establish the same provider/ownership state that production plan
      // creation hands to a later reflow. Provider boundaries stay mocked.
      emitSyncRequest(plan, allSessionIds);
      await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'f24-pause-create-route' });
      const initialDrain = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-pause-create-drain',
      });
      expect(initialDrain).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      const linkedBeforePause = allSessionIds.map((sessionId) =>
        trainingPlans.getSessionById(sessionId)?.calendar_event_id,
      );
      expect(linkedBeforePause).toEqual(['evt-1', 'evt-2']);
      expect(db.prepare(`
        SELECT COUNT(*) AS n
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND status = 'active'
      `).get(plan.id)).toMatchObject({ n: 2 });

      mockCreateEvent.mockClear();
      mockUpdateEvent.mockClear();
      mockDeleteEvent.mockClear();
      mockInvalidateCalendarCaches.mockClear();
      mockInvalidateTrainingDerivedCaches.mockClear();

      const paused = await executeWeekReflowWithPropagation({
        userId: USER_ID,
        tenantId: TENANT_ID,
        planId: plan.id,
        planVersion: 1,
        weekId: firstWeekId,
        mode: 'apply',
        trigger: 'safety_pause',
        idempotencyKey: 'f24-plan-wide-pause',
        sciencePolicyVersion: 'f24-pause-test',
        syncTarget: 'google',
        applyMutation: (tx) => executeCoachActions(tx, {
          planId: plan.id,
          actions: [{
            type: 'pause_training',
            reasonCode: 'acute_safety_pause',
            severity: 'pause',
          }],
        }),
      });

      expect(paused).toMatchObject({
        mutated: true,
        adaptationRevision: 1,
        affectedSessionIds: allSessionIds,
        propagation: { state: 'not_synced', pending: true },
      });
      expect(trainingPlans.getPlanById(plan.id)?.status).toBe('paused');
      expect(db.prepare(`
        SELECT id, status, schedule_status, schedule_reason_code
          FROM training_sessions
         WHERE plan_id = ?
         ORDER BY id ASC
      `).all(plan.id)).toEqual([
        {
          id: allSessionIds[0],
          status: 'scheduled',
          schedule_status: 'dropped',
          schedule_reason_code: 'acute_safety_pause',
        },
        {
          id: allSessionIds[1],
          status: 'scheduled',
          schedule_status: 'dropped',
          schedule_reason_code: 'acute_safety_pause',
        },
      ]);

      const pendingOutbox = db.prepare(`
        SELECT payload_json
          FROM event_outbox
         WHERE source_skill = 'training'
           AND event_type = 'training.plan_calendar_sync.requested.v1'
           AND processed_at IS NULL
      `).all() as Array<{ payload_json: string }>;
      expect(pendingOutbox).toHaveLength(1);
      expect(JSON.parse(pendingOutbox[0]!.payload_json)).toMatchObject({
        operation: 'week_reflow',
        planId: plan.id,
        planVersion: 1,
        adaptationRevision: 1,
        weekId: firstWeekId,
        sessionIds: allSessionIds,
        reflowScope: 'plan',
      });

      const routed = await processPendingEvents(defaultEventHandlers, {
        limit: 10,
        lockOwner: 'f24-pause-reflow-route',
      });
      expect(routed).toMatchObject({ processed: 1, failed: 0, deadLetter: 0 });
      const pausedDrain = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-pause-reflow-drain',
      });

      expect(pausedDrain).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent.mock.calls).toEqual([
        ['evt-1', 'google', USER_ID],
        ['evt-2', 'google', USER_ID],
      ]);
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(USER_ID);
      expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(USER_ID);
      for (const sessionId of allSessionIds) {
        expect(trainingPlans.getSessionById(sessionId)).toMatchObject({
          schedule_status: 'dropped',
          calendar_event_id: null,
          calendar_source: null,
        });
      }
      expect(db.prepare(`
        SELECT COUNT(*) AS n
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND status = 'deleted'
      `).get(plan.id)).toMatchObject({ n: 2 });
    });
    db.close();
  });

  it('F24 rejects a forged plan-scope reconciliation while the canonical plan is active', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        reflowScope: 'plan',
        key: 'f24-forged-plan-scope-active',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-forged-plan-scope-active',
      });

      // Stronger guarantee: a forged scope is a typed terminal job failure,
      // never a completed job that silently skipped its requested mutation.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]).toMatchObject({
        status: 'dead_letter',
        last_error: expect.stringContaining('REFLOW_PLAN_PAUSE_STATE_MISMATCH'),
      });
      expect(trainingPlans.getPlanById(target.plan.id)?.status).toBe('active');
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockGetEventsForSources).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        schedule_status: 'reflowed',
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND plan_version = 1 AND session_id = ?
           AND tenant_id = ? AND user_id = ?
      `).get(target.plan.id, target.sessionId, TENANT_ID, USER_ID)).toEqual({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
        status: 'active',
      });
    });
    db.close();
  });

  it('F24 rejects plan-scope deletion when any requested session is not canonically dropped', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE fitness_training_plans
           SET status = 'paused'
         WHERE id = ?
      `).run(target.plan.id);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        reflowScope: 'plan',
        key: 'f24-plan-scope-session-not-dropped',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-plan-scope-session-not-dropped',
      });

      // Stronger guarantee: malformed canonical pause state stays visible in
      // durable job failure rather than being acknowledged as completed.
      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]).toMatchObject({
        status: 'dead_letter',
        last_error: expect.stringContaining('REFLOW_PLAN_PAUSE_STATE_MISMATCH'),
      });
      expect(trainingPlans.getPlanById(target.plan.id)?.status).toBe('paused');
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockGetEventsForSources).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        schedule_status: 'reflowed',
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND plan_version = 1 AND session_id = ?
           AND tenant_id = ? AND user_id = ?
      `).get(target.plan.id, target.sessionId, TENANT_ID, USER_ID)).toEqual({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
        status: 'active',
      });
    });
    db.close();
  });

  it('F24 records a deleted requested session as a typed terminal job failure', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare('DELETE FROM training_sessions WHERE id = ? AND plan_id = ?')
        .run(target.sessionId, target.plan.id);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-deleted-session-terminal',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-deleted-session-terminal',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]).toMatchObject({
        status: 'dead_letter',
        last_error: expect.stringContaining(
          'TRAINING_PLAN_CALENDAR_SYNC_TERMINAL: REFLOW_SESSION_SCOPE_MISMATCH',
        ),
      });
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('F24 records a requested-week mismatch as a typed terminal job failure', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId + 999,
        sessionIds: [target.sessionId],
        key: 'f24-week-scope-terminal',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-week-scope-terminal',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]?.last_error).toContain(
        'TRAINING_PLAN_CALENDAR_SYNC_TERMINAL: REFLOW_SESSION_SCOPE_MISMATCH',
      );
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('F24 keeps the exact local link when ownership deletion affects zero rows', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE training_sessions
           SET status = 'skipped', schedule_status = 'dropped'
         WHERE id = ? AND plan_id = ?
      `).run(target.sessionId, target.plan.id);
      mockMarkCalendarOwnershipDeleted.mockReturnValue({ ok: true, rowsAffected: 0 });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-zero-row-ownership-delete',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-zero-row-ownership-delete',
      });

      // Provider cleanup is durably tombstoned, so this local row-count miss
      // remains safely retryable without another provider delete.
      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(jobRow(db)[0]?.last_error).toContain('REFLOW_LOCAL_CLEANUP_FENCE_FAILED');
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
      });
    });
    db.close();
  });

  it('F24 retries a post-delete local fence from the Secretary tombstone without a second provider delete', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE training_sessions
           SET status = 'skipped', schedule_status = 'dropped'
         WHERE id = ? AND plan_id = ?
      `).run(target.sessionId, target.plan.id);
      mockMarkSecretaryAgendaProviderCleanupRequired.mockImplementation((input: any) => {
        db.prepare(`
          UPDATE secretary_agenda_items
             SET provider_event_id = ?, provider_source = ?,
                 provider_sync_state = ?, lifecycle_state = ?, updated_at = datetime('now')
           WHERE agenda_item_id = ? AND owner_user_id = ? AND tenant_id = ?
        `).run(
          input.clearProviderMapping ? null : (input.providerEventId ?? null),
          input.clearProviderMapping ? null : (input.providerSource ?? null),
          input.providerSyncState ?? 'deleted',
          input.lifecycleState ?? 'unscheduled',
          input.agendaItemId,
          input.ownerUserId,
          String(input.tenantId),
        );
        const row = db.prepare(`
          SELECT agenda_item_id, provider_event_id, provider_source,
                 provider_sync_state, lifecycle_state
            FROM secretary_agenda_items
           WHERE agenda_item_id = ?
        `).get(input.agendaItemId) as any;
        return row ? {
          agendaItemId: row.agenda_item_id,
          providerEventId: row.provider_event_id,
          providerSource: row.provider_source,
          providerSyncState: row.provider_sync_state,
          lifecycleState: row.lifecycle_state,
        } : null;
      });
      mockMarkCalendarOwnershipDeleted.mockReturnValue({ ok: true, rowsAffected: 0 });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-local-fence-tombstone-retry',
      });

      const first = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-local-fence-tombstone-first',
      });
      expect(first).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
      expect(db.prepare(`
        SELECT provider_event_id, provider_source, provider_sync_state
          FROM secretary_agenda_items
         WHERE source_intent_id = ?
         ORDER BY version DESC LIMIT 1
      `).get(`training:${target.plan.id}:1:${target.sessionId}`)).toEqual({
        provider_event_id: 'evt-linked-f24',
        provider_source: 'google',
        provider_sync_state: 'deleted',
      });

      mockMarkCalendarOwnershipDeleted.mockReset();
      makeJobDue(db);
      const second = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-local-fence-tombstone-second',
      });
      expect(second).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: null,
        calendar_source: null,
      });
      expect(db.prepare(`
        SELECT status FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(target.plan.id, target.sessionId)).toEqual({ status: 'deleted' });
    });
    db.close();
  });

  it('F24 rolls ownership deletion back when the exact local unlink affects zero rows', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE training_sessions
           SET status = 'skipped', schedule_status = 'dropped'
         WHERE id = ? AND plan_id = ?
      `).run(target.sessionId, target.plan.id);
      db.exec(`
        CREATE TRIGGER f24_ignore_exact_unlink
        BEFORE UPDATE OF calendar_event_id, calendar_source ON training_sessions
        WHEN OLD.id = ${target.sessionId}
          AND OLD.calendar_event_id = 'evt-linked-f24'
          AND NEW.calendar_event_id IS NULL
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-zero-row-session-unlink',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-zero-row-session-unlink',
      });

      // The transaction rolls ownership back and retains the deleted-provider
      // tombstone; a later drain retries only the exact local retirement.
      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(jobRow(db)[0]?.last_error).toContain('REFLOW_LOCAL_CLEANUP_FENCE_FAILED');
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
      });
      expect(db.prepare(`
        SELECT status FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(target.plan.id, target.sessionId)).toEqual({ status: 'active' });
    });
    db.close();
  });

  it('F24 preserves a terminal Secretary reflow outcome instead of retryable collapse', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      mockSyncTrainingSecretaryCalendarHandoff.mockResolvedValue({
        outcome: 'terminal',
        agendaItemId: `sec-${target.sessionId}`,
        providerEventId: 'evt-linked-f24',
        providerSource: 'google',
        startAt: null,
        endAt: null,
        reasonCode: 'provider_refused_update',
        retryable: false,
        agendaItem: null,
        syncResults: [],
      });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        key: 'f24-terminal-handoff',
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-terminal-handoff',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(jobRow(db)[0]?.last_error).toContain(
        'TRAINING_PLAN_CALENDAR_SYNC_TERMINAL: REFLOW_UPDATE_TERMINAL:provider_refused_update',
      );
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)?.calendar_event_id)
        .toBe('evt-linked-f24');

      makeJobDue(db);
      const replay = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-terminal-handoff-replay',
      });
      expect(replay).toMatchObject({ completed: 0, failed: 0, deadLetter: 0 });
      expect(mockSyncTrainingSecretaryCalendarHandoff).toHaveBeenCalledTimes(1);
      expect(mockUpdateEvent).not.toHaveBeenCalled();
    });
    db.close();
  });

  it('F24 blocks a provider update when an unchanged persisted sibling occupies the target window', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db, { siblingOverlapsTarget: true });
      mockSubmitSecretarySchedulingIntent.mockImplementation((intent: any, options: any) => {
        const hasSiblingCollision = options.additionalBusyWindows.some((window: any) =>
          window.start === target.siblingStart && window.end === target.siblingEnd,
        );
        expect(hasSiblingCollision).toBe(true);
        return {
          status: 'unschedulable',
          reasonCodes: ['no_available_slot'],
          selectedSlot: null,
          agendaItem: {
            agendaItemId: `sec-${intent.sourceEntityId}`,
            sourceIntentId: intent.intentId,
            lifecycleState: 'unscheduled',
          },
          explanation: 'unchanged Training sibling occupies the requested slot',
          alternativeSlots: [],
          conflicts: [],
          downstreamImplications: [],
          confidence: 'high',
          feedback: {
            sourceSkill: 'training',
            sourceIntentId: intent.intentId,
            agendaItemId: `sec-${intent.sourceEntityId}`,
            status: 'unschedulable',
            reasonCodes: ['no_available_slot'],
            shouldRefreshSource: true,
            downstreamImplications: [],
          },
        };
      });
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'f24-sibling-collision' });

      expect(drained).toMatchObject({ completed: 0, failed: 1, deadLetter: 0 });
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledTimes(1);
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockGetEventsForSources).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)?.calendar_event_id).toBe('evt-linked-f24');
      expect(db.prepare(`
        SELECT sync_version FROM training_agenda_event_ownership
        WHERE plan_id = ? AND session_id = ? AND status = 'active'
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        sync_version: 'training_calendar_sync_v1',
      });
    });
    db.close();
  });

  it('F24 refuses to delete a dropped session event when its active ownership tuple does not match', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare(`
        UPDATE training_sessions
           SET status = 'skipped', schedule_status = 'dropped',
               calendar_event_id = 'evt-unowned-corrupt', calendar_source = 'google'
         WHERE id = ? AND plan_id = ?
      `).run(target.sessionId, target.plan.id);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-unowned-delete-guard',
      });

      expect(drained).toMatchObject({ completed: 0, failed: 0, deadLetter: 1 });
      expect(mockDeleteEvent).not.toHaveBeenCalled();
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockMarkSecretaryAgendaProviderCleanupRequired).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-unowned-corrupt',
        calendar_source: 'google',
      });
      expect(db.prepare(`
        SELECT calendar_event_id, calendar_source, status
          FROM training_agenda_event_ownership
         WHERE plan_id = ? AND session_id = ?
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        calendar_event_id: 'evt-linked-f24',
        calendar_source: 'google',
        status: 'active',
      });
    });
    db.close();
  });

  it('F24 reconciles a stale request against canonical state at the effective current revision', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      db.prepare('UPDATE fitness_training_plans SET adaptation_revision = 2 WHERE id = ?').run(target.plan.id);
      mockGetEventsForSources.mockResolvedValue([{
        id: 'evt-linked-f24',
        source: 'google',
        title: 'Tempo',
        start: target.desiredStart,
        end: target.desiredEnd,
      }]);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        adaptationRevision: 1,
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'f24-stale' });
      expect(drained).toMatchObject({ completed: 1, failed: 0 });
      expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(mockSubmitSecretarySchedulingIntent).toHaveBeenCalledTimes(1);
      expect(db.prepare(`
        SELECT sync_version FROM training_agenda_event_ownership
        WHERE plan_id = ? AND session_id = ? AND status = 'active'
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        sync_version: 'training_reflow_v1:p1:a2',
      });
      expect(mockInvalidateCalendarCaches).toHaveBeenCalledWith(USER_ID);
      expect(mockInvalidateTrainingDerivedCaches).toHaveBeenCalledWith(USER_ID);
    });
    db.close();
  });

  it('F24 does not let a later zero-mutation adaptation overtake an earlier real mutation request', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      const successor = executeWeekReflow({
        planId: target.plan.id,
        weekId: target.weekId,
        mode: 'apply',
        trigger: 'manual_reflow',
        idempotencyKey: 'f24-zero-mutation-successor',
        sciencePolicyVersion: 'f24-test',
        applyMutation: () => ({ mutatedRows: 0, affectedSessionIds: [] }),
      });
      expect(successor).toMatchObject({
        adaptationRevision: 2,
        mutated: false,
        affectedSessionIds: [],
      });
      mockGetEventsForSources.mockResolvedValue([{
        id: 'evt-linked-f24',
        source: 'google',
        title: 'Tempo',
        start: target.desiredStart,
        end: target.desiredEnd,
      }]);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
        adaptationRevision: 1,
      });

      const drained = await processTrainingPlanCalendarSyncJobs({
        limit: 5,
        lockOwner: 'f24-zero-mutation-overtake',
      });

      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(db.prepare(`
        SELECT sync_version FROM training_agenda_event_ownership
        WHERE plan_id = ? AND session_id = ? AND status = 'active'
      `).get(target.plan.id, target.sessionId)).toMatchObject({
        sync_version: 'training_reflow_v1:p1:a2',
      });
    });
    db.close();
  });

  it('F24 resolves an unknown update outcome by read-back and never blind-creates a replacement', async () => {
    const db = createMigratedTestDatabase();
    await withDatabaseForTestAsync(db, async () => {
      const target = seedLinkedReflowTarget(db);
      mockUpdateEvent.mockRejectedValueOnce(new Error('provider update timed out after write'));
      mockGetEventsForSources.mockResolvedValue([{
        id: 'evt-linked-f24',
        source: 'google',
        title: 'Tempo',
        start: target.desiredStart,
        end: target.desiredEnd,
      }]);
      enqueueReflowSync({
        planId: target.plan.id,
        weekId: target.weekId,
        sessionIds: [target.sessionId],
      });

      const drained = await processTrainingPlanCalendarSyncJobs({ limit: 5, lockOwner: 'f24-readback' });
      expect(drained).toMatchObject({ completed: 1, failed: 0, deadLetter: 0 });
      expect(mockUpdateEvent).toHaveBeenCalledTimes(1);
      expect(mockGetEventsForSources).toHaveBeenCalled();
      expect(mockCreateEvent).not.toHaveBeenCalled();
      expect(trainingPlans.getSessionById(target.sessionId)?.calendar_event_id).toBe('evt-linked-f24');
      // Secretary's handoff performs and persists the exact-id readback; the
      // Training worker must not issue a duplicate sync-satisfied mutation.
      expect(mockMarkSecretaryAgendaProviderSyncSatisfied).not.toHaveBeenCalled();
    });
    db.close();
  });
});
