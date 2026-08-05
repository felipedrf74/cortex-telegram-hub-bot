// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWithTrainingCalendarOperationLock = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/training-operation-locks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/training-operation-locks')>()),
  withTrainingCalendarOperationLock: (...args: unknown[]) => (
    mockWithTrainingCalendarOperationLock(...args)
  ),
}));

import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import { bindTrainingPlanRevisionDecision } from '../../src/services/training-plan-revision-decision';
import { createTrainingPlanCandidateRevision as createTrainingPlanCandidateRevisionAtRuntime } from '../../src/services/training-plan-revisions';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';
import { revalidateNormalizedDecisionAction } from '../../src/services/decision-preexecution-revalidator';
import type { NormalizedDecisionAction } from '../../src/services/decision-action-contract';
import { performDecisionAction, reviewDecision } from '../../src/services/decision-center';
import {
  refreshTrainingM4AuthoritativeCapacityContext,
  registerTrainingM4CapacityCalendarReader,
} from '../../src/services/training-m4-capacity-snapshots';
import type {
  UnifiedCalendarEvent,
  UnifiedCalendarFetchStatus,
} from '../../src/services/unified-calendar';
import {
  _resetTrainingGenerationObservabilityForTests,
  getTrainingGenerationObservabilitySnapshot,
} from '../../src/services/training-generation-observability';
import * as trainingOperationLocksModule from '../../src/services/training-operation-locks';

const FIXED_NOW = new Date('2026-07-13T12:00:00.000Z');

function createTrainingPlanCandidateRevision(
  input: Parameters<typeof createTrainingPlanCandidateRevisionAtRuntime>[0],
) {
  return createTrainingPlanCandidateRevisionAtRuntime({
    ...input,
    referenceTime: input.referenceTime ?? FIXED_NOW,
  });
}

const request: TrainingPlanCandidateRequest = {
  planMode: 'event_based', goal: 'event_performance', discipline: 'marathon',
  planStartDate: '2026-08-17', horizonWeeks: 12,
  event: { name: 'Reviewed marathon', date: '2026-11-08', priority: 'A', subtype: 'marathon' },
  resourceAccess: {
    pool: false, bicycle: false, indoorTrainer: false,
    safeRunEnvironment: true, outdoorRideEnvironment: false,
  },
  capacity: {
    source: 'AUTHORITATIVE',
    contextVersion: 'pending-authoritative-refresh',
    windows: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'].map((dayOfWeek) => ({
      dayOfWeek: dayOfWeek as 'monday', startTime: '06:00', endTime: '08:00', timezone: 'Europe/Lisbon',
      allowedDisciplines: ['marathon' as const, 'strength' as const],
    })),
  },
  goalPriority: { primaryDiscipline: 'marathon', secondaryDisciplines: [] },
  profile: {
    experienceLevel: 'intermediate', sessionsPerWeek: 5, sessionDurationMinutes: 60,
    availableDays: ['monday', 'tuesday', 'thursday', 'saturday', 'sunday'],
    equipmentIds: [], location: 'home', preferences: [], exclusions: [],
  },
};

describe('training M4 single-Decision conflict and activation gates', () => {
  let db: Database.Database;
  let unregisterCalendarReader: (() => void) | null = null;
  let authoritativeCapacityVersion = '';
  let calendarEvents: UnifiedCalendarEvent[] = [];
  let calendarStatus: UnifiedCalendarFetchStatus = 'ready';
  const original: Record<string, string | undefined> = {};
  const keys = [
    'TRAINING_PLAN_REVISION_V1_MODE_USER_7',
    'TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7',
    'TRAINING_PLAN_M4_ALLOWLIST_USER_7',
    'DECISION_FLOW_V1_ENFORCE_ENABLED',
    'TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7',
    'TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY',
    'TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7',
  ];

  async function refreshCapacity(idempotencyKey: string) {
    return refreshTrainingM4AuthoritativeCapacityContext({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey,
      request: {
        planStartDate: request.planStartDate!,
        horizonWeeks: request.horizonWeeks!,
        profileWindows: request.capacity!.windows,
      },
      dependencies: { db, now: FIXED_NOW },
    });
  }

  async function createApprovedDecision(idempotencyPrefix: string) {
    const created = createTrainingPlanCandidateRevision({
      scope: { userId: 7, tenantId: 7 },
      idempotencyKey: `${idempotencyPrefix}-candidate`,
      request,
    });
    const bound = await bindTrainingPlanRevisionDecision({
      scope: { userId: 7, tenantId: 7 },
      revisionId: created.candidates[0].revisionId,
    });
    const stored = db.prepare(`
      SELECT record_version AS recordVersion
        FROM notification_center_items WHERE item_id = ?
    `).get(bound.decisionId) as { recordVersion: number };
    const approved = reviewDecision(bound.decisionId!, 7, 7, {
      outcome: 'approve',
      expectedVersion: stored.recordVersion,
      idempotencyKey: `${idempotencyPrefix}-approve`,
      strongConfirmationText: 'CONFIRM',
    });
    return { bound, approved };
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXED_NOW);
    _resetTrainingGenerationObservabilityForTests();
    authoritativeCapacityVersion = '';
    calendarEvents = [];
    calendarStatus = 'ready';
    mockWithTrainingCalendarOperationLock.mockReset();
    mockWithTrainingCalendarOperationLock.mockImplementation(
      async (_input: unknown, operation: (lease: unknown) => Promise<unknown>) => {
        // Activation now fences the pointer/projection/outbox transaction,
        // so the test lock seam must expose the same callable lease shape.
        const signal = new AbortController().signal;
        return operation(Object.assign(() => {}, { signal, assertActive: vi.fn() }));
      },
    );
    db = createMigratedTestDatabase();
    db.prepare(`
      INSERT INTO user_profiles (user_id, profile_type, data)
      VALUES (7, 'fitness', '{"weekly_frequency":5}')
    `).run();
    for (const key of keys) original[key] = process.env[key];
    process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_7 = 'active';
    process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_7 = 'true';
    process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7 = 'event_based:marathon';
    process.env.DECISION_FLOW_V1_ENFORCE_ENABLED = 'false';
    process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_7 = 'true';
    process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'training-revision-test-encryption-key-0001';
    process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED_USER_7 = 'true';
    unregisterCalendarReader = registerTrainingM4CapacityCalendarReader({
      configuredSources: (userId) => userId === 7 ? ['google'] : [],
      loadCalendar: async (_startDate, _endDate, userId) => ({
        events: userId === 7 ? structuredClone(calendarEvents) : [],
        status: userId === 7 ? calendarStatus : 'unavailable',
        warningCodes: calendarStatus === 'ready' ? [] : ['GOOGLE_CALENDAR_UNAVAILABLE'],
        warnings: calendarStatus === 'ready' ? [] : ['Calendar unavailable'],
        sources: {
          configured: userId === 7 ? ['google'] : [],
          fulfilled: userId === 7 && calendarStatus === 'ready' ? ['google'] : [],
          failed: userId === 7 && calendarStatus !== 'ready' ? ['google'] : [],
        },
      }),
    });
    const refreshed = await refreshCapacity('m4-initial-authoritative-refresh');
    authoritativeCapacityVersion = refreshed.contextVersion;
    request.capacity!.contextVersion = refreshed.contextVersion;
  });

  afterEach(() => {
    unregisterCalendarReader?.();
    unregisterCalendarReader = null;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    db.close();
    vi.useRealTimers();
  });

  it('uses one Decision and recovers after calendar and persisted-precondition drift are removed', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-decision', request,
      });
      const revision = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      expect(getTrainingGenerationObservabilitySnapshot().counters).toMatchObject({
        m4_candidate_valid_total: 1,
        m4_decision_routed_total: 1,
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 1 });
      const row = db.prepare(`
        SELECT normalized_action_json AS action
          FROM notification_intents WHERE related_entity_id = ?
      `).get(revision.revisionId) as { action: string };
      const action = JSON.parse(row.action) as NormalizedDecisionAction;
      expect(action.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'training_revision_conflict_set', required: true }),
        expect.objectContaining({ type: 'training_capacity_context', expectedVersion: authoritativeCapacityVersion }),
      ]));
      expect(action.affectedResources).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'training_schedule', id: revision.revisionId }),
        expect.objectContaining({ type: 'training_resource', id: 'safeRunEnvironment' }),
        expect.objectContaining({ type: 'calendar_timeline_overlap', id: 'primary' }),
      ]));
      expect(action.exclusivityKeys).toContain('calendar_timeline:primary');

      const initial = revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action });
      expect(initial.preconditions.every((precondition) => precondition.ok)).toBe(true);

      const firstScheduled = created.candidates[0].document.weeks
        .flatMap((week) => week.workouts)
        .find((workout) => workout.sessionType !== 'rest' && workout.scheduledStartAt && workout.scheduledEndAt)!;
      const overlapStart = new Date(Date.parse(firstScheduled.scheduledStartAt!) + 15 * 60_000).toISOString();
      const overlapEnd = new Date(Date.parse(firstScheduled.scheduledStartAt!) + 45 * 60_000).toISOString();
      db.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id, source_intent_id, source_skill, intent_action,
          owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
          version, title, start_at, end_at, duration_minutes, decision_action,
          decision_reason_codes_json, source_shape_hash, scheduled_segments_json,
          created_at, updated_at
        ) VALUES (?, ?, 'secretary', 'schedule_this', 7, '7', 'scheduled', 'not_synced',
          1, 'Private fixture', ?, ?,
          60, 'schedule', '[]', 'shape-v1', '[]', datetime('now'), datetime('now'))
      `).run('agenda-m4-drift', 'intent-m4-drift', overlapStart, overlapEnd);
      const calendarDrift = revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action });
      expect(calendarDrift.preconditions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'training_revision_context', ok: false }),
      ]));
      expect(calendarDrift.conflictEvaluation).toMatchObject({ disposition: 'block' });
      expect(calendarDrift.conflictEvaluation.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ class: 'time_overlap' }),
        expect.objectContaining({ class: 'approved_commitment' }),
      ]));
      expect(getTrainingGenerationObservabilitySnapshot().counters.m4_cross_domain_conflict_total)
        .toBeGreaterThanOrEqual(1);
      db.prepare('DELETE FROM secretary_agenda_items WHERE agenda_item_id = ?').run('agenda-m4-drift');
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action })
        .preconditions.every((precondition) => precondition.ok)).toBe(true);

      db.prepare(`
        INSERT INTO training_agenda_event_ownership (
          plan_id, plan_version, session_id, user_id, tenant_id,
          calendar_event_id, calendar_source, calendar_id, status,
          last_verified_at, sync_version
        ) VALUES (999, 1, NULL, 7, 7, 'partial-sync-event', 'google', 'primary',
          'active', NULL, 'training_calendar_sync_v1')
      `).run();
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action }).preconditions)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'training_revision_context', ok: false }),
        ]));
      expect(getTrainingGenerationObservabilitySnapshot().counters.m4_partial_sync_blocked_total)
        .toBeGreaterThanOrEqual(1);
      db.prepare("DELETE FROM training_agenda_event_ownership WHERE calendar_event_id = 'partial-sync-event'").run();
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action })
        .preconditions.every((precondition) => precondition.ok)).toBe(true);
      expect(getTrainingGenerationObservabilitySnapshot().counters.m4_partial_sync_recovery_total)
        .toBeGreaterThanOrEqual(1);

      calendarEvents = [{
        id: 'provider-drift', source: 'google', summary: 'Private',
        start: '2026-08-17T05:30:00.000Z', end: '2026-08-17T05:45:00.000Z',
      }];
      const changedCapacity = await refreshCapacity('m4-calendar-provider-drift');
      expect(changedCapacity.contextVersion).not.toBe(authoritativeCapacityVersion);
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action }).preconditions)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'training_capacity_context', ok: false }),
        ]));
      calendarEvents = [];
      const restoredCapacity = await refreshCapacity('m4-calendar-provider-restored');
      expect(restoredCapacity.contextVersion).toBe(authoritativeCapacityVersion);
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action })
        .preconditions.every((precondition) => precondition.ok)).toBe(true);

      const staleDecisionAction = structuredClone(action);
      staleDecisionAction.preconditions = staleDecisionAction.preconditions.map((precondition) =>
        precondition.type === 'training_revision_conflict_set'
          ? { ...precondition, expectedVersion: '0'.repeat(64) }
          : precondition);
      expect(revalidateNormalizedDecisionAction({
        scope: { userId: 7, tenantId: 7 }, action: staleDecisionAction,
      }).preconditions)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'training_revision_conflict_set', ok: false }),
        ]));
      expect(revalidateNormalizedDecisionAction({ scope: { userId: 7, tenantId: 7 }, action })
        .preconditions.every((precondition) => precondition.ok)).toBe(true);
    });
  });

  it('denies activation if the exact M4 allowlist is removed after approval', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-activation-denial', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const stored = db.prepare(`
        SELECT record_version AS recordVersion FROM notification_center_items WHERE item_id = ?
      `).get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve', expectedVersion: stored.recordVersion,
        idempotencyKey: 'approve-m4-denial', strongConfirmationText: 'CONFIRM',
      });
      delete process.env.TRAINING_PLAN_M4_ALLOWLIST_USER_7;
      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'activate-m4-denied',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({ code: 'TRAINING_M4_ALLOWLIST_REQUIRED' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
    });
  });

  it('freshly re-reads unchanged provider state and activates without a duplicate-context failure', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const { bound, approved } = await createApprovedDecision('m4-unchanged-live-state');
      const before = db.prepare('SELECT COUNT(*) AS count FROM training_m4_capacity_snapshots').get() as { count: number };
      const result = await performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'm4-unchanged-live-state-activate',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      );
      expect(result.status).toBe('succeeded');
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
      const snapshots = db.prepare(`
        SELECT context_version AS contextVersion
          FROM training_m4_capacity_snapshots ORDER BY rowid
      `).all() as Array<{ contextVersion: string }>;
      expect(snapshots).toHaveLength(before.count + 1);
      expect(new Set(snapshots.map((row) => row.contextVersion))).toEqual(new Set([authoritativeCapacityVersion]));
    });
  });

  it('keeps a contended Training activation approved and retryable with the same Decision attempt', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const { bound, approved } = await createApprovedDecision('m4-lock-contention');
      const lockError = new trainingOperationLocksModule.TrainingOperationLockError('plan_activate', 30);
      lockError.message = 'SQLite lock training-calendar:user:7:tenant:7 belongs to private-owner-token';
      Object.assign(lockError, {
        lockKey: 'training-calendar:user:7:tenant:7',
        ownerToken: 'private-owner-token',
        userId: 7,
        tenantId: 7,
      });
      mockWithTrainingCalendarOperationLock.mockRejectedValueOnce(lockError);
      const actionOptions = {
        idempotencyKey: 'm4-lock-contention-activate',
        expectedVersion: approved.recordVersion,
        contextVersion: approved.contextVersion,
      };

      let rejected: unknown;
      try {
        await performDecisionAction(
          bound.decisionId!,
          'activate_training_plan_revision',
          7,
          7,
          actionOptions,
        );
      } catch (error) {
        rejected = error;
      }

      expect(rejected).toMatchObject({
        code: 'TRAINING_OPERATION_LOCKED',
        status: 409,
        message: 'Another training operation is in progress. Please try again shortly.',
      });
      // Exact allowlisting is stronger than looking for one lock-key prefix:
      // it rejects every future scope/owner field regardless of its spelling.
      expect((rejected as { details?: unknown })?.details).toEqual({
        operation: 'plan_activate',
        retryAfterSeconds: 30,
      });
      expect(db.prepare(`
        SELECT status, decision_state AS decisionState, record_version AS recordVersion
          FROM notification_center_items
         WHERE item_id = ? AND user_id = 7 AND tenant_id = 7
      `).get(bound.decisionId)).toEqual({
        status: 'read',
        decisionState: 'approved',
        recordVersion: approved.recordVersion,
      });
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM fitness_training_plans
         WHERE user_id = 7 AND tenant_id = 7
      `).get()).toEqual({ count: 0 });

      // The same client payload and idempotency key must remain usable after
      // transient contention; requiring a fresh approval would make 409 a lie.
      const retry = await performDecisionAction(
        bound.decisionId!,
        'activate_training_plan_revision',
        7,
        7,
        actionOptions,
      );
      expect(retry.status).toBe('succeeded');
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
    });
  });

  it('reviews after the five-minute capacity cache TTL and activates after an unchanged provider reread', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-expired-cache-candidate',
        request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 },
        revisionId: created.candidates[0].revisionId,
      });

      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 13 * 60_000));
      const stored = db.prepare(`
        SELECT record_version AS recordVersion
          FROM notification_center_items WHERE item_id = ?
      `).get(bound.decisionId) as { recordVersion: number };
      const approved = reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve',
        expectedVersion: stored.recordVersion,
        idempotencyKey: 'm4-expired-cache-approve',
        strongConfirmationText: 'CONFIRM',
      });
      expect(approved.decisionState).toBe('approved');

      const result = await performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'm4-expired-cache-activate',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      );
      expect(result.status).toBe('succeeded');
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 1 });
      expect(db.prepare(`
        SELECT COUNT(DISTINCT context_version) AS count
          FROM training_m4_capacity_snapshots
      `).get()).toEqual({ count: 1 });
    });
  });

  it('blocks review when a newer retained capacity snapshot has a different version', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-newer-retained-capacity-candidate',
        request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 },
        revisionId: created.candidates[0].revisionId,
      });

      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 6 * 60_000));
      calendarEvents = [{
        id: 'newer-retained-drift', source: 'google', summary: 'Private',
        start: '2026-08-17T05:30:00.000Z', end: '2026-08-17T05:45:00.000Z',
      }];
      const newer = await refreshTrainingM4AuthoritativeCapacityContext({
        scope: { userId: 7, tenantId: 7 },
        idempotencyKey: 'm4-newer-retained-capacity-refresh',
        request: {
          planStartDate: request.planStartDate!,
          horizonWeeks: request.horizonWeeks!,
          profileWindows: request.capacity!.windows,
        },
        dependencies: { db, now: new Date() },
      });
      expect(newer.contextVersion).not.toBe(authoritativeCapacityVersion);
      vi.setSystemTime(new Date(FIXED_NOW.getTime() + 13 * 60_000));

      const stored = db.prepare(`
        SELECT record_version AS recordVersion
          FROM notification_center_items WHERE item_id = ?
      `).get(bound.decisionId) as { recordVersion: number };
      expect(() => reviewDecision(bound.decisionId!, 7, 7, {
        outcome: 'approve',
        expectedVersion: stored.recordVersion,
        idempotencyKey: 'm4-newer-retained-capacity-approve',
        strongConfirmationText: 'CONFIRM',
      })).toThrowError(expect.objectContaining({ code: 'DECISION_CONTEXT_CHANGED' }));
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
    });
  });

  it('blocks activation when a provider event changes after review', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const { bound, approved } = await createApprovedDecision('m4-provider-event-drift');
      calendarEvents = [{
        id: 'new-work-event', source: 'google', summary: 'Private',
        start: '2026-08-17T05:30:00.000Z', end: '2026-08-17T05:45:00.000Z',
      }];
      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'm4-provider-event-drift-activate',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({
        code: 'DECISION_CONTEXT_CHANGED',
        details: { reasonCode: 'TRAINING_M4_CAPACITY_CHANGED_AFTER_REVIEW' },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
    });
  });

  it('blocks activation when the connected provider degrades after review', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const { bound, approved } = await createApprovedDecision('m4-provider-degraded');
      calendarStatus = 'degraded';
      await expect(performDecisionAction(
        bound.decisionId!, 'activate_training_plan_revision', 7, 7,
        {
          idempotencyKey: 'm4-provider-degraded-activate',
          expectedVersion: approved.recordVersion,
          contextVersion: approved.contextVersion,
        },
      )).rejects.toMatchObject({
        code: 'DECISION_CONTEXT_CHANGED',
        details: { reasonCode: 'TRAINING_M4_CAPACITY_PROVIDER_DEGRADED' },
      });
      expect(db.prepare('SELECT COUNT(*) AS count FROM fitness_training_plans').get()).toEqual({ count: 0 });
    });
  });

  it('models an exact authoritative session overlap with review alternatives', async () => {
    await withDatabaseForTestAsync(db, async () => {
      db.prepare(`
        INSERT INTO secretary_agenda_items (
          agenda_item_id, source_intent_id, source_skill, intent_action,
          owner_user_id, tenant_id, lifecycle_state, provider_sync_state,
          version, title, start_at, end_at, duration_minutes, decision_action,
          decision_reason_codes_json, source_shape_hash, scheduled_segments_json,
          created_at, updated_at
        ) VALUES (?, ?, 'secretary', 'schedule_this', 7, '7', 'scheduled', 'not_synced',
          1, 'Private fixture', '2026-08-17T05:15:00.000Z', '2026-08-17T05:45:00.000Z',
          30, 'schedule', '[]', 'shape-exact', '[]', datetime('now'), datetime('now'))
      `).run('agenda-m4-exact', 'intent-m4-exact');
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-exact-overlap', request,
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const row = db.prepare(`
        SELECT normalized_action_json AS action
          FROM notification_intents WHERE related_entity_id = ?
      `).get(bound.revisionId) as { action: string };
      const action = JSON.parse(row.action) as NormalizedDecisionAction;
      const revalidated = revalidateNormalizedDecisionAction({
        scope: { userId: 7, tenantId: 7 }, action, decisionId: bound.decisionId ?? undefined,
      });
      expect(revalidated.preconditions.every((precondition) => precondition.ok)).toBe(true);
      expect(revalidated.conflictEvaluation).toMatchObject({ disposition: 'needs_confirmation' });
      expect(revalidated.conflictEvaluation.findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ class: 'time_overlap' }),
        expect.objectContaining({ class: 'approved_commitment' }),
      ]));
      expect(revalidated.conflictEvaluation.alternatives.length).toBeGreaterThanOrEqual(2);
      expect(getTrainingGenerationObservabilitySnapshot().counters.m4_soft_conflict_total)
        .toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps explicit-user capacity provisional and out of cross-domain preconditions', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const explicitRequest: TrainingPlanCandidateRequest = {
        ...request,
        capacity: {
          source: 'EXPLICIT_USER',
          windows: request.capacity!.windows.map((window) => ({ ...window })),
        },
      };
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-explicit-capacity', request: explicitRequest,
      });
      expect(created.candidates[0].document).toMatchObject({
        capacityContext: {
          source: 'EXPLICIT_USER', provisional: true, calendarConflictCoverage: 'UNAVAILABLE',
        },
      });
      const bound = await bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: created.candidates[0].revisionId,
      });
      const row = db.prepare(`
        SELECT normalized_action_json AS action
          FROM notification_intents WHERE related_entity_id = ?
      `).get(bound.revisionId) as { action: string };
      const action = JSON.parse(row.action) as NormalizedDecisionAction;
      expect(action.preconditions.some((precondition) => precondition.type === 'training_capacity_context')).toBe(false);
      expect(action.preconditions.some((precondition) => precondition.type === 'training_revision_conflict_set')).toBe(true);
      expect(action.affectedResources.some((resource) => resource.type === 'calendar_timeline_overlap')).toBe(false);
      expect(action.exclusivityKeys.some((key) => key.startsWith('calendar_timeline:'))).toBe(false);
    });
  });

  it('fails closed when persisted immutable revision JSON no longer matches its content hash', async () => {
    await withDatabaseForTestAsync(db, async () => {
      const created = createTrainingPlanCandidateRevision({
        scope: { userId: 7, tenantId: 7 }, idempotencyKey: 'm4-integrity-decision', request,
      });
      const revision = created.candidates[0];
      db.exec('DROP TRIGGER trg_training_plan_revisions_content_immutable');
      db.prepare(`
        UPDATE training_plan_revisions
           SET revision_document_json = json_set(revision_document_json, '$.title', 'tampered')
         WHERE revision_id = ?
      `).run(revision.revisionId);
      await expect(bindTrainingPlanRevisionDecision({
        scope: { userId: 7, tenantId: 7 }, revisionId: revision.revisionId,
      })).rejects.toMatchObject({ code: 'TRAINING_REVISION_DOCUMENT_HASH_MISMATCH' });
      expect(db.prepare('SELECT COUNT(*) AS count FROM notification_center_items').get()).toEqual({ count: 0 });
    });
  });
});
