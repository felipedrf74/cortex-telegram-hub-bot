// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training plan calendar-sync worker (Phase 1B).
 *
 * Provider calendar effects for freshly generated training plans no longer
 * run inline in `persistGeneratedTrainingPlan`. Persistence emits a
 * `training.plan_calendar_sync.requested.v1` outbox event inside the
 * plan-graph transaction; the event backbone's `'*'` router enqueues a
 * durable `training_plan_calendar_sync` background job; this worker drains
 * that job OUTSIDE the event lease and performs the provider work.
 *
 * Invariants owned here:
 *   - No provider call for a plan that is not currently `active` at the
 *     requested plan_version. `pending_activation` retries (activation races
 *     the queue by design); every other mismatch is a terminal no-op.
 *   - Provider work runs under the same Training calendar operation lock the
 *     inline phase held, so generation/cancel/sync mutual exclusion survives
 *     the move to a background job.
 *   - `findExistingOwnership` + the unique index on
 *     (plan_id, plan_version, event_id, source) remain the double-execution
 *     guards; the job lease is NOT lock-owner fenced and must not be trusted
 *     as one.
 *   - Retryable provider failures THROW after compensations so the queue
 *     applies backoff (the inline phase swallowed every failure into a
 *     counter, permanently unscheduling sessions on transient errors).
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';
import {
  BackgroundJobTerminalError,
  processPendingJobs,
  type JobHandler,
  type JobRecord,
} from './background-job-queue';
import { assertAgentQueuedJobHandlerRuntimeParity } from './agent-job-manifest';
import * as trainingPlans from './training-plans';
import {
  findExistingOwnership,
  getAdaptationRevision,
  getPlanVersion,
  updateCalendarOwnershipSyncVersion,
  type AgendaEventOwnership,
} from './training-plan-lifecycle';
import {
  markSecretaryAgendaProviderCleanupRequired,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
} from './secretary-scheduling-arbitrator';
import {
  loadLiveCalendarBusyWindowsForRange,
  type SecretaryLiveCalendarBusyWindowsResult,
} from './secretary-live-calendar-busy';
import { emojiForTrainingSession } from './training-calendar-format';
import { appendTrainingIdentityMarker } from './training-session-identity';
import {
  isTrainingOperationLockError,
  isTrainingOperationLockUnavailableError,
  type TrainingOperationLockLease,
  withTrainingCalendarOperationLock,
} from './training-operation-locks';
import {
  invalidateCalendarCaches,
  invalidateTrainingDerivedCaches,
} from './cache-coherence-registry';
import {
  getEventsForSources,
  type CalendarSource,
} from './unified-calendar';
import { resolveCalendarWritePreference } from './provider-preferences';
import { syncTrainingSecretaryCalendarHandoff } from './training-secretary-calendar-handoff';
import {
  commitTrainingCalendarSessionMapping,
  retireTrainingCalendarSessionMapping,
} from './training-calendar-link-commit';

export const TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE = 'training_plan_calendar_sync';
export const TRAINING_PLAN_CALENDAR_SYNC_REQUESTED_EVENT_TYPE =
  'training.plan_calendar_sync.requested.v1';
export const TRAINING_PLAN_CALENDAR_SYNC_RUNTIME_GROUP = 'training-plan-calendar-sync';

/** Session statuses eligible for a provider calendar event. */
const SYNCABLE_SESSION_STATUSES = ['scheduled', 'reflowed', 'compressed', 'capped'] as const;

/**
 * Retryable drain failure: thrown AFTER per-session compensations so
 * `markJobFailed` applies bounded backoff and a later attempt can finish the
 * remaining sessions. Terminal outcomes (plan missing / superseded / not
 * active) return without throwing so the job completes as a no-op.
 */
export class TrainingPlanCalendarSyncRetryableError extends Error {
  constructor(readonly code: string) {
    super(`TRAINING_PLAN_CALENDAR_SYNC_RETRYABLE: ${code}`);
    this.name = 'TrainingPlanCalendarSyncRetryableError';
  }
}

/**
 * Durable non-retryable reconciliation failure. The queue records this typed
 * outcome and dead-letters it on the first attempt instead of acknowledging
 * corrupt or forged scope as a successful no-op. Manual repair/replay is required.
 */
export class TrainingPlanCalendarSyncTerminalError extends BackgroundJobTerminalError {
  constructor(code: string) {
    super(code, `TRAINING_PLAN_CALENDAR_SYNC_TERMINAL: ${code}`);
    this.name = 'TrainingPlanCalendarSyncTerminalError';
  }
}

export interface TrainingPlanCalendarSyncJobPayload {
  eventId: string | null;
  planId: number;
  planVersion: number;
  sessionIds: number[] | null;
  /**
   * 'auto' means no explicit provider preference existed at emit time — the
   * provider writer receives `undefined` and unified-calendar resolves the
   * user's provider at write time (the released auto-target behaviour).
   */
  syncTarget: CalendarSource | 'auto' | 'none' | 'apple' | null;
  operation: 'plan_create' | 'week_reflow';
  adaptationRevision: number | null;
  weekId: number | null;
  reflowScope: 'week' | 'plan';
}

export interface TrainingPlanCalendarSyncSummary {
  schemaVersion: 1;
  /**
   * Migration 244 `provider_sync_state` vocabulary — shared with Content so
   * Training and Content consistency states stay legible to the same
   * operator. Only the subset this worker can produce is used; 'synced' is
   * recorded ONLY when every eligible session has a provider event confirmed
   * by the ownership read-back.
   */
  state: 'not_synced' | 'synced' | 'create_failed';
  pending: boolean;
  provider: CalendarSource | null;
  requestedSessions: number;
  eventsCreated: number;
  eventsAttached: number;
  eventsUpdated: number;
  eventsAlreadyOwned: number;
  eventsFailed: number;
  eventsSkipped: number;
  lastErrorCode: string | null;
  updatedAt: string;
}

export function normalizeTrainingPlanCalendarSyncPayload(
  payload: Record<string, unknown>,
): TrainingPlanCalendarSyncJobPayload | null {
  const planId = Number(payload.planId);
  const planVersion = Number(payload.planVersion);
  if (!Number.isSafeInteger(planId) || planId <= 0) return null;
  if (!Number.isSafeInteger(planVersion) || planVersion <= 0) return null;
  let sessionIds: number[] | null = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'sessionIds')) {
    if (!Array.isArray(payload.sessionIds)) return null;
    if (payload.sessionIds.some(
      (value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0,
    )) return null;
    sessionIds = [...new Set(payload.sessionIds as number[])];
  }
  const syncTarget = payload.syncTarget === 'google'
    || payload.syncTarget === 'outlook'
    || payload.syncTarget === 'auto'
    || payload.syncTarget === 'none'
    || payload.syncTarget === 'apple'
    ? payload.syncTarget
    : null;
  const adaptationRevision = Number(payload.adaptationRevision);
  const weekId = Number(payload.weekId);
  if (payload.operation != null
      && payload.operation !== 'plan_create'
      && payload.operation !== 'week_reflow') return null;
  if (payload.reflowScope != null
      && payload.reflowScope !== 'week'
      && payload.reflowScope !== 'plan') return null;
  return {
    eventId: typeof payload.eventId === 'string' && payload.eventId.trim() ? payload.eventId : null,
    planId,
    planVersion,
    sessionIds,
    syncTarget,
    operation: payload.operation === 'week_reflow' ? 'week_reflow' : 'plan_create',
    adaptationRevision: Number.isSafeInteger(adaptationRevision) && adaptationRevision > 0
      ? adaptationRevision
      : null,
    weekId: Number.isSafeInteger(weekId) && weekId > 0 ? weekId : null,
    reflowScope: payload.reflowScope === 'plan' ? 'plan' : 'week',
  };
}

interface SyncableSessionRow {
  id: number;
  week_id?: number;
  plan_id: number;
  session_type: string;
  title: string;
  description: string | null;
  duration_minutes: number | null;
  status: string;
  session_identity_key: string | null;
  session_shape_hash: string | null;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  calendar_event_id: string | null;
  calendar_source?: string | null;
  schedule_status?: string | null;
  schedule_reason_code?: string | null;
}

function loadReflowSessions(
  planId: number,
  sessionIds: number[],
  db: Database.Database,
): SyncableSessionRow[] {
  if (sessionIds.length === 0) return [];
  return db.prepare(`
    SELECT id, week_id, plan_id, session_type, title, description, duration_minutes,
           status, session_identity_key, session_shape_hash,
           scheduled_start_at, scheduled_end_at, calendar_event_id,
           calendar_source, schedule_status, schedule_reason_code
      FROM training_sessions
     WHERE plan_id = ?
       AND id IN (${sessionIds.map(() => '?').join(', ')})
     ORDER BY id ASC
  `).all(planId, ...sessionIds) as SyncableSessionRow[];
}

function loadPersistedTrainingSiblingWindows(
  planId: number,
  db: Database.Database,
): Array<{ sessionId: number; window: { start: string; end: string; label: string } }> {
  const rows = db.prepare(`
    SELECT id, scheduled_start_at, scheduled_end_at
      FROM training_sessions
     WHERE plan_id = ?
       AND scheduled_start_at IS NOT NULL
       AND scheduled_end_at IS NOT NULL
       AND status NOT IN ('completed', 'skipped', 'moved')
       AND COALESCE(schedule_status, 'scheduled') NOT IN ('dropped', 'unscheduled')
     ORDER BY scheduled_start_at ASC, id ASC
  `).all(planId) as Array<{
    id: number;
    scheduled_start_at: string;
    scheduled_end_at: string;
  }>;
  return rows.flatMap((row) => {
    const start = Date.parse(row.scheduled_start_at);
    const end = Date.parse(row.scheduled_end_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    return [{
      sessionId: row.id,
      window: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        label: 'existing training session',
      },
    }];
  });
}

/**
 * Re-read eligible sessions from the database instead of trusting the event
 * payload: outbox payloads are privacy-sanitized (depth 4 / 500 chars) and
 * the rows may have changed between emit and drain. Payload sessionIds, when
 * present, narrow the scan; eligibility is always re-derived from row state.
 */
function loadSyncableSessions(
  planId: number,
  sessionIds: number[] | null,
  db: Database.Database,
): SyncableSessionRow[] {
  if (sessionIds !== null && sessionIds.length === 0) return [];
  const statusPlaceholders = SYNCABLE_SESSION_STATUSES.map(() => '?').join(', ');
  const idFilter = sessionIds && sessionIds.length > 0
    ? `AND id IN (${sessionIds.map(() => '?').join(', ')})`
    : '';
  return db.prepare(`
    SELECT id, plan_id, session_type, title, description, duration_minutes,
           status, session_identity_key, session_shape_hash,
           scheduled_start_at, scheduled_end_at, calendar_event_id
      FROM training_sessions
     WHERE plan_id = ?
       AND status IN (${statusPlaceholders})
       AND calendar_event_id IS NULL
       AND scheduled_start_at IS NOT NULL
       AND scheduled_end_at IS NOT NULL
       ${idFilter}
     ORDER BY scheduled_start_at ASC, id ASC
  `).all(
    planId,
    ...SYNCABLE_SESSION_STATUSES,
    ...(sessionIds && sessionIds.length > 0 ? sessionIds : []),
  ) as SyncableSessionRow[];
}

interface SessionEventPayload {
  sessionId: number;
  sessionIdentityKey: string;
  sessionShapeHash: string;
  title: string;
  start: string;
  end: string;
  description: string;
}

function buildSessionEventPayload(
  session: SyncableSessionRow,
  scope: { planId: number; planVersion: number },
): SessionEventPayload | null {
  const startMs = Date.parse(String(session.scheduled_start_at || ''));
  const endMs = Date.parse(String(session.scheduled_end_at || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const durationMinutes = session.duration_minutes
    ?? Math.max(1, Math.round((endMs - startMs) / 60_000));
  const description = appendTrainingIdentityMarker(session.description ?? '', {
    planId: scope.planId,
    planVersion: scope.planVersion,
    sessionId: session.id,
    sessionIdentityKey: session.session_identity_key ?? '',
    sessionShapeHash: session.session_shape_hash ?? '',
  });
  return {
    sessionId: session.id,
    sessionIdentityKey: session.session_identity_key ?? '',
    sessionShapeHash: session.session_shape_hash ?? '',
    title: `${emojiForTrainingSession(session.session_type)} ${session.title || 'Training session'} (${durationMinutes}min)`,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    description,
  };
}

function buildTrainingSecretaryIntent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  calendarSource: CalendarSource | null;
  eventPayload: SessionEventPayload;
}): SecretarySchedulingIntent {
  const durationMinutes = Math.max(1, Math.round(
    (Date.parse(input.eventPayload.end) - Date.parse(input.eventPayload.start)) / 60_000,
  ));
  return {
    intentId: `training:${input.planId}:${input.planVersion}:${input.eventPayload.sessionId}`,
    sourceSkill: 'training',
    sourceAction: 'schedule_training_session',
    sourceEntityId: input.eventPayload.sessionId,
    sourceEntityType: 'training_session',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    title: input.eventPayload.title,
    requestedDurationMinutes: durationMinutes,
    minimumDurationMinutes: Math.min(durationMinutes, Math.max(20, Math.round(durationMinutes * 0.75))),
    preferredWindows: [{
      start: input.eventPayload.start,
      end: input.eventPayload.end,
      label: 'training plan slot',
      hard: true,
    }],
    priority: 'high',
    flexibility: 'fixed',
    providerTarget: input.calendarSource,
    softPreferences: input.calendarSource ? { calendarProvider: input.calendarSource } : undefined,
    reason: 'Training generated a scheduleable workout session.',
    context: `plan_id=${input.planId}; plan_version=${input.planVersion}; session_identity_key=${input.eventPayload.sessionIdentityKey}; session_shape_hash=${input.eventPayload.sessionShapeHash}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function selectedTrainingSecretaryWindow(
  decision: SecretarySchedulingDecision,
  options: { notBefore?: Date } = {},
): { start: string; end: string } | null {
  if (!['scheduled', 'reflowed', 'compressed'].includes(decision.status)) return null;
  if (!decision.selectedSlot?.start || !decision.selectedSlot?.end) return null;
  const start = Date.parse(decision.selectedSlot.start);
  const end = Date.parse(decision.selectedSlot.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (options.notBefore && start < options.notBefore.getTime()) return null;
  return { start: decision.selectedSlot.start, end: decision.selectedSlot.end };
}

export function trainingCalendarCreateBatchSize(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRAINING_CALENDAR_CREATE_BATCH_SIZE;
  if (raw == null || raw.trim() === '') return 5;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(5, Math.max(1, parsed));
}

function trainingCalendarSyncTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRAINING_CALENDAR_SYNC_TIMEOUT_MS;
  if (raw == null || raw.trim() === '') return 15_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 15_000;
  return Math.min(30_000, Math.max(3_000, parsed));
}

async function withTrainingCalendarSyncTimeout<T>(
  promise: Promise<T>,
  operation: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`TRAINING_CALENDAR_SYNC_TIMEOUT:${operation}`));
    }, trainingCalendarSyncTimeoutMs());
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    chunks.push(items.slice(index, index + safeSize));
  }
  return chunks;
}

/**
 * Persist the plan-level consistency summary into the plan's
 * `preferences_json` (the same additive channel `finalValidationResult`
 * uses). Merges into the CURRENT row so concurrent preference writers are
 * not clobbered by a stale snapshot.
 */
export function persistTrainingPlanCalendarSyncSummary(
  planId: number,
  summary: TrainingPlanCalendarSyncSummary,
  lease?: TrainingOperationLockLease,
): void {
  // Keep the ownership assertion outside the fail-soft persistence catch so
  // a stale worker can never have lease loss downgraded into an advisory log.
  lease?.assertActive();
  try {
    const plan = trainingPlans.getPlanById(planId);
    if (!plan) return;
    const parsed = plan.preferences_json ? JSON.parse(plan.preferences_json) as unknown : {};
    const preferences = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    preferences.calendarSync = summary;
    trainingPlans.updatePlanPreferences(planId, JSON.stringify(preferences));
    lease?.assertActive();
  } catch (err) {
    if (isTrainingOperationLockError(err) || isTrainingOperationLockUnavailableError(err)) {
      throw err;
    }
    logger.warn(
      { err, planId },
      'training-plan-calendar-sync: failed to persist calendar sync summary',
    );
  }
}

type SessionSyncOutcome =
  | 'created'
  | 'attached'
  | 'updated'
  | 'already_owned'
  | 'skipped'
  | 'failed_retryable'
  | 'failed_terminal';

async function syncSessionCalendarEvent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  /** Exact target pinned before Secretary persists the agenda item. */
  calendarSource: CalendarSource;
  eventPayload: SessionEventPayload;
  now: Date;
  finalAttempt: boolean;
  /** F29: fetched ONCE per drain for the whole plan window. */
  liveBusyWindows: SecretaryLiveCalendarBusyWindowsResult['windows'];
  db: Database.Database;
  lease: TrainingOperationLockLease;
  ownershipSyncVersion?: string;
}): Promise<SessionSyncOutcome> {
  const { userId, tenantId, planId, planVersion, calendarSource, eventPayload, now } = input;
  input.lease.assertActive();
  const existing = findExistingOwnership({
    planId,
    planVersion,
    sessionId: eventPayload.sessionId,
    tenantId,
    userId,
  });
  if (existing) {
    if (existing.calendar_source !== calendarSource) return 'failed_terminal';
    const local = input.db.prepare(`
      SELECT calendar_event_id AS calendarEventId, calendar_source AS calendarSource
        FROM training_sessions
       WHERE id = ? AND plan_id = ? AND tenant_id = ?
       LIMIT 1
    `).get(eventPayload.sessionId, planId, tenantId) as {
      calendarEventId: string | null;
      calendarSource: string | null;
    } | undefined;
    if (!local) return 'failed_terminal';
    if (
      local.calendarEventId === existing.calendar_event_id
      && local.calendarSource === existing.calendar_source
    ) {
      return 'already_owned';
    }
    if (local.calendarEventId != null || local.calendarSource != null) return 'failed_terminal';
    const relinked = input.db.prepare(`
      UPDATE training_sessions
         SET calendar_event_id = ?, calendar_source = ?, updated_at = datetime('now')
       WHERE id = ? AND plan_id = ? AND tenant_id = ?
         AND calendar_event_id IS NULL AND calendar_source IS NULL
    `).run(
      existing.calendar_event_id,
      existing.calendar_source,
      eventPayload.sessionId,
      planId,
      tenantId,
    );
    return relinked.changes === 1 ? 'attached' : 'failed_retryable';
  }
  let secretaryDecision: SecretarySchedulingDecision | null = null;
  try {
    const secretaryIntent = buildTrainingSecretaryIntent({
      userId,
      tenantId,
      planId,
      planVersion,
      calendarSource,
      eventPayload,
    });
    input.lease.assertActive();
    secretaryDecision = submitSecretarySchedulingIntent(
      secretaryIntent,
      {
        now: now.toISOString(),
        additionalBusyWindows: input.liveBusyWindows,
      },
    );
    input.lease.assertActive();
    const selectedWindow = selectedTrainingSecretaryWindow(secretaryDecision, { notBefore: now });
    if (!selectedWindow) {
      logger.warn(
        {
          userId,
          planId,
          planVersion,
          sessionId: eventPayload.sessionId,
          secretaryStatus: secretaryDecision.status,
          reasonCodes: secretaryDecision.reasonCodes,
        },
        'Secretary did not return a schedulable Training slot; skipping calendar event create',
      );
      return 'skipped';
    }
    input.lease.assertActive();
    const handoff = await withTrainingCalendarSyncTimeout(
      syncTrainingSecretaryCalendarHandoff({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        providerSource: calendarSource,
        trainingProjection: {
          title: eventPayload.title,
          startAt: selectedWindow.start,
          endAt: selectedWindow.end,
          description: eventPayload.description,
        },
      }),
      'secretary_provider_handoff',
    );
    input.lease.assertActive();
    if (handoff.outcome !== 'ready' || !handoff.providerEventId || !handoff.providerSource) {
      logger.warn(
        {
          userId,
          planId,
          planVersion,
          sessionId: eventPayload.sessionId,
          agendaItemId: secretaryDecision.agendaItem.agendaItemId,
          handoffOutcome: handoff.outcome,
          reasonCode: handoff.reasonCode,
        },
        'Secretary provider handoff did not produce a durable Training mapping',
      );
      if (handoff.outcome === 'terminal' || input.finalAttempt) {
        trainingPlans.updateSession(eventPayload.sessionId, {
          status: 'unscheduled',
          calendar_event_id: null,
          calendar_source: null,
        });
      }
      return handoff.outcome === 'terminal' ? 'failed_terminal' : 'failed_retryable';
    }
    if (handoff.providerSource !== calendarSource) {
      trainingPlans.updateSession(eventPayload.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      return 'failed_terminal';
    }
    const providerAction = classifyTrainingHandoffAction(handoff.syncResults, handoff.reasonCode);
    const event = {
      id: handoff.providerEventId,
      source: handoff.providerSource,
    };
    // Link + ownership are one exact scoped local transaction. The shared
    // helper validates the session/plan/tenant/user tuple and reads the
    // ownership row back before exposing either half of the mapping.
    try {
      input.lease.assertActive();
      commitTrainingCalendarSessionMapping({
        sessionId: eventPayload.sessionId,
        eventId: event.id,
        source: event.source,
        ownership: {
          planId,
          planVersion,
          sessionId: eventPayload.sessionId,
          tenantId,
          userId,
          eventId: event.id,
          source: event.source,
          calendarId: null,
          sessionIdentityKey: eventPayload.sessionIdentityKey,
          sessionShapeHash: eventPayload.sessionShapeHash,
          syncVersion: input.ownershipSyncVersion,
        },
      });
      input.lease.assertActive();
    } catch (localWriteError) {
      if (isTrainingOperationLockError(localWriteError)
          || isTrainingOperationLockUnavailableError(localWriteError)) {
        throw localWriteError;
      }
      // The Secretary mapping is durable and its provider outcome is known.
      // Convert it to cleanup work before touching the local session; only the
      // Secretary claim/recovery engine may perform the compensating delete.
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        providerEventId: event.id,
        providerSource: event.source,
        providerSyncState: 'delete_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_ownership_record_failed',
        clearProviderMapping: false,
        now: now.toISOString(),
      });
      input.lease.assertActive();
      try {
        await withTrainingCalendarSyncTimeout(
          syncTrainingSecretaryCalendarHandoff({
            agendaItemId: secretaryDecision.agendaItem.agendaItemId,
            ownerUserId: userId,
            tenantId,
            providerSource: event.source,
          }),
          'secretary_provider_compensation_handoff',
        );
      } catch (cleanupError) {
        if (isTrainingOperationLockError(cleanupError)
            || isTrainingOperationLockUnavailableError(cleanupError)) {
          throw cleanupError;
        }
        // The exact provider id remains in Secretary's delete_failed state;
        // its recovery worker owns the bounded retry. Never clear that id or
        // blind-create a replacement from this Training job.
        logger.warn(
          { err: cleanupError, userId, planId, sessionId: eventPayload.sessionId },
          'training-plan-calendar-sync: provider compensation remains pending in Secretary',
        );
      }
      input.lease.assertActive();
      trainingPlans.updateSession(eventPayload.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      input.lease.assertActive();
      logger.warn(
        {
          err: localWriteError,
          userId,
          planId,
          planVersion,
          sessionId: eventPayload.sessionId,
          providerEventId: event.id,
          providerSource: event.source,
        },
        'Failed to record Training calendar ownership after provider create; session marked unscheduled',
      );
      // Split-brain risk (provider event may or may not still exist) — the
      // agenda cleanup queue owns recovery. Retrying this session blindly
      // could duplicate the provider event, so the failure is terminal.
      return 'failed_terminal';
    }
    return providerAction;
  } catch (err) {
    const leaseLost = isTrainingOperationLockError(err)
      || isTrainingOperationLockUnavailableError(err);
    if (leaseLost) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const unknownProviderOutcome = message.startsWith(
      'TRAINING_CALENDAR_SYNC_TIMEOUT:secretary_provider_handoff',
    );
    if (secretaryDecision?.agendaItem?.agendaItemId) {
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        providerSyncState: 'create_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_event_create_failed',
        clearProviderMapping: true,
        now: now.toISOString(),
      });
    }
    if (unknownProviderOutcome || input.finalAttempt || err instanceof TrainingPlanCalendarSyncTerminalError) {
      trainingPlans.updateSession(eventPayload.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
    }
    logger.warn(
      {
        err,
        userId,
        planId,
        planVersion,
        sessionId: eventPayload.sessionId,
        finalAttempt: input.finalAttempt,
        unknownProviderOutcome,
      },
      'Failed to create calendar event for session',
    );
    return unknownProviderOutcome || err instanceof TrainingPlanCalendarSyncTerminalError
      ? 'failed_terminal'
      : 'failed_retryable';
  }
}

function classifyTrainingHandoffAction(
  syncResults: Array<{ action: string }>,
  reasonCode: string,
): Extract<SessionSyncOutcome, 'created' | 'attached' | 'updated' | 'already_owned'> {
  const actions = new Set(syncResults.map((result) => result.action));
  if (actions.has('created') || actions.has('recreated')) return 'created';
  if (actions.has('attached')) return 'attached';
  if (actions.has('updated')) return 'updated';
  if (reasonCode.includes('created') || reasonCode.includes('recreated')) return 'created';
  if (reasonCode.includes('attached')) return 'attached';
  if (reasonCode.includes('updated')) return 'updated';
  return 'already_owned';
}

type ReflowSyncOutcome =
  | 'created'
  | 'attached'
  | 'updated'
  | 'already_reconciled'
  | 'deleted';

function trainingReflowSyncVersion(planVersion: number, adaptationRevision: number): string {
  return `training_reflow_v1:p${planVersion}:a${adaptationRevision}`;
}

function latestSecretaryAgendaMapping(input: {
  db: Database.Database;
  ownerUserId: number;
  tenantId: number;
  sourceIntentId: string;
  providerEventId?: string;
  providerSource?: CalendarSource;
}): {
  agendaItemId: string;
  providerEventId: string | null;
  providerSource: string | null;
  providerSyncState: string;
  lifecycleState: string;
} | null {
  const exactProviderPredicate = input.providerEventId && input.providerSource
    ? 'AND provider_event_id = ? AND provider_source = ?'
    : '';
  const row = input.db.prepare(`
    SELECT agenda_item_id, provider_event_id, provider_source,
           provider_sync_state, lifecycle_state
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND source_skill = 'training'
       AND source_intent_id = ?
       ${exactProviderPredicate}
     ORDER BY version DESC
     LIMIT 1
  `).get(
    input.ownerUserId,
    String(input.tenantId),
    input.sourceIntentId,
    ...(exactProviderPredicate ? [input.providerEventId, input.providerSource] : []),
  ) as {
    agenda_item_id: string;
    provider_event_id: string | null;
    provider_source: string | null;
    provider_sync_state: string;
    lifecycle_state: string;
  } | undefined;
  return row
    ? {
        agendaItemId: row.agenda_item_id,
        providerEventId: row.provider_event_id,
        providerSource: row.provider_source,
        providerSyncState: row.provider_sync_state,
        lifecycleState: row.lifecycle_state,
      }
    : null;
}

function isDeletedProviderTombstone(mapping: ReturnType<typeof latestSecretaryAgendaMapping>): boolean {
  return Boolean(
    mapping
    && mapping.providerEventId
    && (mapping.providerSource === 'google' || mapping.providerSource === 'outlook')
    && mapping.providerSyncState === 'deleted'
    && ['canceled', 'superseded', 'unscheduled', 'deferred'].includes(mapping.lifecycleState),
  );
}

/**
 * Delete one exact, ownership-authorized provider mapping and atomically
 * retire its local link. A deleted Secretary tombstone is persisted before
 * the local transaction so a row-count retry is local-only and can never
 * issue the provider delete twice.
 */
async function cleanupLinkedReflowProviderState(input: {
  db: Database.Database;
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  session: SyncableSessionRow;
  eventId: string;
  source: CalendarSource;
  ownership: AgendaEventOwnership;
  now: Date;
  liveBusyWindows: SecretaryLiveCalendarBusyWindowsResult['windows'];
  lease: TrainingOperationLockLease;
  reason: string;
}): Promise<void> {
  const intentId = `training:${input.planId}:${input.planVersion}:${input.session.id}`;
  let agenda = latestSecretaryAgendaMapping({
    db: input.db,
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    sourceIntentId: intentId,
    providerEventId: input.eventId,
    providerSource: input.source,
  });

  if (!agenda) {
    const eventPayload = buildSessionEventPayload(input.session, {
      planId: input.planId,
      planVersion: input.planVersion,
    });
    if (!eventPayload) {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_DELETE_AGENDA_MISSING');
    }
    input.lease.assertActive();
    const adoptionDecision = submitSecretarySchedulingIntent(
      buildTrainingSecretaryIntent({
        userId: input.userId,
        tenantId: input.tenantId,
        planId: input.planId,
        planVersion: input.planVersion,
        calendarSource: input.source,
        eventPayload,
      }),
      {
        now: input.now.toISOString(),
        additionalBusyWindows: input.liveBusyWindows,
        providerMappingTransfer: {
          providerEventId: input.eventId,
          providerSource: input.source,
        },
      },
    );
    input.lease.assertActive();
    agenda = latestSecretaryAgendaMapping({
      db: input.db,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      sourceIntentId: intentId,
      providerEventId: input.eventId,
      providerSource: input.source,
    });
    if (!agenda) {
      // The next exact cleanup-mark readback is the authoritative fence. This
      // fallback keeps the handoff boundary testable with a mocked arbitrator;
      // in production a non-persisting submit makes that mark return null and
      // the worker terminates before any provider delete.
      agenda = {
        agendaItemId: adoptionDecision.agendaItem.agendaItemId,
        providerEventId: input.eventId,
        providerSource: input.source,
        providerSyncState: 'synced',
        lifecycleState: adoptionDecision.agendaItem.lifecycleState,
      };
    }
  }

  if (!isDeletedProviderTombstone(agenda)) {
    input.lease.assertActive();
    const cleanupRequested = markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: agenda.agendaItemId,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerEventId: input.eventId,
      providerSource: input.source,
      providerSyncState: 'delete_failed',
      lifecycleState: 'unscheduled',
      reason: input.reason,
      clearProviderMapping: false,
      now: input.now.toISOString(),
    });
    if (
      !cleanupRequested
      || cleanupRequested.providerEventId !== input.eventId
      || cleanupRequested.providerSource !== input.source
      || cleanupRequested.providerSyncState !== 'delete_failed'
    ) {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_DELETE_AGENDA_FENCE_FAILED');
    }
    input.lease.assertActive();
    const cleanup = await withTrainingCalendarSyncTimeout(
      syncTrainingSecretaryCalendarHandoff({
        agendaItemId: agenda.agendaItemId,
        ownerUserId: input.userId,
        tenantId: input.tenantId,
        providerSource: input.source,
      }),
      'secretary_provider_cleanup_handoff',
    );
    input.lease.assertActive();
    if (cleanup.outcome !== 'cleanup_complete') {
      const code = `REFLOW_DELETE_${cleanup.outcome === 'terminal' || !cleanup.retryable
        ? 'TERMINAL'
        : 'PENDING'}:${cleanup.reasonCode}`;
      if (cleanup.outcome === 'terminal' || !cleanup.retryable) {
        throw new TrainingPlanCalendarSyncTerminalError(code);
      }
      throw new TrainingPlanCalendarSyncRetryableError(code);
    }

    // Keep the deleted provider identity as a durable tombstone until the
    // exact local ownership/link transaction succeeds. On retry the worker
    // recognizes this state and skips the external delete completely.
    const tombstone = markSecretaryAgendaProviderCleanupRequired({
      agendaItemId: agenda.agendaItemId,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerEventId: input.eventId,
      providerSource: input.source,
      providerSyncState: 'deleted',
      lifecycleState: 'unscheduled',
      reason: `${input.reason}_provider_deleted_local_pending`,
      clearProviderMapping: false,
      now: input.now.toISOString(),
    });
    if (
      !tombstone
      || tombstone.providerEventId !== input.eventId
      || tombstone.providerSource !== input.source
      || tombstone.providerSyncState !== 'deleted'
    ) {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_DELETE_TOMBSTONE_FENCE_FAILED');
    }
    agenda = {
      agendaItemId: tombstone.agendaItemId,
      providerEventId: tombstone.providerEventId,
      providerSource: tombstone.providerSource,
      providerSyncState: tombstone.providerSyncState,
      lifecycleState: tombstone.lifecycleState,
    };
  }

  try {
    input.lease.assertActive();
    retireTrainingCalendarSessionMapping({
      sessionId: input.session.id,
      planId: input.planId,
      ownershipId: input.ownership.id,
      tenantId: input.tenantId,
      userId: input.userId,
      eventId: input.eventId,
      source: input.source,
      reason: input.reason,
      secretaryTombstone: {
        agendaItemId: agenda.agendaItemId,
        now: input.now.toISOString(),
      },
    });
    input.lease.assertActive();
  } catch (error) {
    if (isTrainingOperationLockError(error) || isTrainingOperationLockUnavailableError(error)) {
      throw error;
    }
    throw new TrainingPlanCalendarSyncRetryableError('REFLOW_LOCAL_CLEANUP_FENCE_FAILED');
  }
}

async function reconcileLinkedReflowSession(input: {
  db: Database.Database;
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  adaptationRevision: number;
  calendarSource: CalendarSource;
  session: SyncableSessionRow;
  now: Date;
  finalAttempt: boolean;
  liveBusyWindows: SecretaryLiveCalendarBusyWindowsResult['windows'];
  lease: TrainingOperationLockLease;
}): Promise<ReflowSyncOutcome> {
  const { session } = input;
  input.lease.assertActive();
  const eventId = String(session.calendar_event_id || '').trim();
  const source = session.calendar_source === 'google' || session.calendar_source === 'outlook'
    ? session.calendar_source
    : null;
  if (!eventId && !source) {
    if (session.schedule_status === 'dropped' || session.status === 'skipped') {
      // A deliberately unlinked dropped session already has the requested
      // provider state. Active unlinked rows continue below and are created
      // against the job's resolved target.
      return 'already_reconciled';
    }
    const eventPayload = buildSessionEventPayload(session, {
      planId: input.planId,
      planVersion: input.planVersion,
    });
    if (!eventPayload) {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_WINDOW_INVALID');
    }
    const created = await syncSessionCalendarEvent({
      userId: input.userId,
      tenantId: input.tenantId,
      planId: input.planId,
      planVersion: input.planVersion,
      calendarSource: input.calendarSource,
      eventPayload,
      now: input.now,
      finalAttempt: input.finalAttempt,
      liveBusyWindows: input.liveBusyWindows,
      db: input.db,
      lease: input.lease,
      ownershipSyncVersion: trainingReflowSyncVersion(
        input.planVersion,
        input.adaptationRevision,
      ),
    });
    if (created === 'created' || created === 'attached') return created;
    if (created === 'already_owned') return 'already_reconciled';
    if (created === 'failed_terminal') {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_CREATE_TERMINAL');
    }
    throw new TrainingPlanCalendarSyncRetryableError(
      created === 'skipped' ? 'REFLOW_CREATE_SKIPPED' : 'REFLOW_CREATE_PENDING',
    );
  }
  if (!eventId || !source) {
    // A partial link is corruption, not a deliberate no-provider state.
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_LINK_MISSING');
  }

  const ownership = findExistingOwnership({
    planId: input.planId,
    planVersion: input.planVersion,
    sessionId: session.id,
    tenantId: input.tenantId,
    userId: input.userId,
  });

  // Provider deletion is destructive and must be fenced by the same exact
  // active ownership tuple as updates. A stale/corrupt session link is not
  // authority to delete an external event, even when desired state is drop.
  if (!ownership || ownership.calendar_event_id !== eventId || ownership.calendar_source !== source) {
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_OWNERSHIP_MISSING');
  }

  if (session.schedule_status === 'dropped' || session.status === 'skipped') {
    await cleanupLinkedReflowProviderState({
      ...input,
      eventId,
      source,
      ownership,
      reason: 'training_week_reflow_dropped',
    });
    return 'deleted';
  }
  const targetSyncVersion = trainingReflowSyncVersion(
    input.planVersion,
    input.adaptationRevision,
  );
  if (ownership.sync_version === targetSyncVersion && source === input.calendarSource) {
    return 'already_reconciled';
  }

  if (source !== input.calendarSource) {
    await cleanupLinkedReflowProviderState({
      ...input,
      eventId,
      source,
      ownership,
      reason: 'training_week_reflow_provider_switch',
    });
    const eventPayload = buildSessionEventPayload(session, {
      planId: input.planId,
      planVersion: input.planVersion,
    });
    if (!eventPayload) {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_WINDOW_INVALID');
    }
    const switched = await syncSessionCalendarEvent({
      userId: input.userId,
      tenantId: input.tenantId,
      planId: input.planId,
      planVersion: input.planVersion,
      calendarSource: input.calendarSource,
      eventPayload,
      now: input.now,
      finalAttempt: input.finalAttempt,
      liveBusyWindows: input.liveBusyWindows,
      db: input.db,
      lease: input.lease,
      ownershipSyncVersion: targetSyncVersion,
    });
    if (switched === 'created' || switched === 'attached') return switched;
    if (switched === 'already_owned') return 'already_reconciled';
    if (switched === 'failed_terminal') {
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_PROVIDER_SWITCH_CREATE_TERMINAL');
    }
    throw new TrainingPlanCalendarSyncRetryableError(
      switched === 'skipped'
        ? 'REFLOW_PROVIDER_SWITCH_CREATE_SKIPPED'
        : 'REFLOW_PROVIDER_SWITCH_CREATE_PENDING',
    );
  }

  const eventPayload = buildSessionEventPayload(session, {
    planId: input.planId,
    planVersion: input.planVersion,
  });
  if (!eventPayload) {
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_WINDOW_INVALID');
  }
  input.lease.assertActive();
  const secretaryDecision = submitSecretarySchedulingIntent(
    buildTrainingSecretaryIntent({
      userId: input.userId,
      tenantId: input.tenantId,
      planId: input.planId,
      planVersion: input.planVersion,
      calendarSource: source,
      eventPayload,
    }),
    {
      now: input.now.toISOString(),
      additionalBusyWindows: input.liveBusyWindows,
      // Exact ownership is the authority. Passing the transfer on every
      // linked update lets legacy/pre-handoff rows adopt into Secretary; the
      // arbitrator rejects any wrong-session/version/collision transfer.
      providerMappingTransfer: { providerEventId: eventId, providerSource: source },
    },
  );
  input.lease.assertActive();
  const selectedWindow = selectedTrainingSecretaryWindow(secretaryDecision, { notBefore: input.now });
  if (!selectedWindow
      || Date.parse(selectedWindow.start) !== Date.parse(eventPayload.start)
      || Date.parse(selectedWindow.end) !== Date.parse(eventPayload.end)) {
    throw new TrainingPlanCalendarSyncRetryableError('REFLOW_SECRETARY_SLOT_MISMATCH');
  }

  const handoff = await withTrainingCalendarSyncTimeout(
    syncTrainingSecretaryCalendarHandoff({
      agendaItemId: secretaryDecision.agendaItem.agendaItemId,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: source,
      trainingProjection: {
        title: eventPayload.title,
        startAt: selectedWindow.start,
        endAt: selectedWindow.end,
        description: eventPayload.description,
        existingProviderEventId: eventId,
      },
    }),
    'secretary_provider_update_handoff',
  );
  input.lease.assertActive();
  if (
    handoff.outcome !== 'ready'
    || handoff.providerEventId !== eventId
    || handoff.providerSource !== source
  ) {
    const reason = handoff.reasonCode ? `:${handoff.reasonCode}` : '';
    if (handoff.outcome === 'terminal' || !handoff.retryable) {
      throw new TrainingPlanCalendarSyncTerminalError(`REFLOW_UPDATE_TERMINAL${reason}`);
    }
    throw new TrainingPlanCalendarSyncRetryableError(`REFLOW_UPDATE_PENDING${reason}`);
  }

  input.db.transaction(() => {
    input.lease.assertActive();
    const ownershipUpdated = updateCalendarOwnershipSyncVersion({
      planId: input.planId,
      planVersion: input.planVersion,
      sessionId: session.id,
      tenantId: input.tenantId,
      userId: input.userId,
      eventId,
      source,
      syncVersion: targetSyncVersion,
      sessionShapeHash: session.session_shape_hash,
      verifiedAt: input.now.toISOString(),
    });
    if (!ownershipUpdated.ok) {
      throw new TrainingPlanCalendarSyncRetryableError('REFLOW_OWNERSHIP_FENCE_FAILED');
    }
    input.lease.assertActive();
  })();
  return 'updated';
}

async function runTrainingWeekReflowReconciliation(input: {
  db: Database.Database;
  job: JobRecord;
  payload: TrainingPlanCalendarSyncJobPayload;
  userId: number;
  tenantId: number;
  calendarSource: CalendarSource;
  now: Date;
  finalAttempt: boolean;
  lease: TrainingOperationLockLease;
}): Promise<void> {
  input.lease.assertActive();
  const requestedRevision = input.payload.adaptationRevision;
  const requestedWeekId = input.payload.weekId;
  const requestedIds = [...new Set(input.payload.sessionIds ?? [])];
  if (!requestedRevision || !requestedWeekId || requestedIds.length === 0) {
    logger.warn(
      { jobId: input.job.jobId, planId: input.payload.planId, reasonCode: 'reflow_scope_missing' },
      'training-plan-calendar-sync: refusing unscoped reflow reconciliation',
    );
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_SCOPE_MISSING');
  }
  const currentRevision = getAdaptationRevision(input.payload.planId);
  if (currentRevision === null) {
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_ADAPTATION_REVISION_MISSING');
  }
  if (currentRevision > requestedRevision) {
    logger.info(
      {
        jobId: input.job.jobId,
        planId: input.payload.planId,
        requestedRevision,
        currentRevision,
        reasonCode: 'adaptation_revision_catch_up',
      },
      'training-plan-calendar-sync: reconciling stale request ids against current canonical schedule',
    );
  }
  if (currentRevision < requestedRevision) {
    throw new TrainingPlanCalendarSyncRetryableError('ADAPTATION_REVISION_PENDING');
  }
  // A later zero-mutation adaptation can legitimately advance the revision
  // without emitting a successor propagation event. Reconcile the original
  // exact ids from current DB truth and stamp the effective revision; a real
  // successor request then observes the ownership fence and becomes a replay.
  const effectiveRevision = currentRevision;

  const sessions = loadReflowSessions(input.payload.planId, requestedIds, input.db);
  if (sessions.length !== requestedIds.length) {
    logger.warn(
      { jobId: input.job.jobId, planId: input.payload.planId, reasonCode: 'reflow_session_scope_mismatch' },
      'training-plan-calendar-sync: reflow session scope changed; refusing provider work',
    );
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_SESSION_SCOPE_MISMATCH');
  }
  const planWidePause = input.payload.reflowScope === 'plan';
  if (planWidePause) {
    const plan = trainingPlans.getPlanById(input.payload.planId);
    // `reflowScope='plan'` is only emitted for an applied pause action. Re-read
    // canonical desired state before relaxing the week fence so a forged or
    // stale payload cannot broaden deletion authority. Per-session provider
    // deletion still requires the exact active ownership tuple below.
    if (plan?.status !== 'paused'
        || sessions.some((session) => session.schedule_status !== 'dropped')) {
      logger.warn(
        {
          jobId: input.job.jobId,
          planId: input.payload.planId,
          reasonCode: 'reflow_plan_pause_state_mismatch',
        },
        'training-plan-calendar-sync: plan-wide pause state changed; refusing provider work',
      );
      throw new TrainingPlanCalendarSyncTerminalError('REFLOW_PLAN_PAUSE_STATE_MISMATCH');
    }
  } else if (sessions.some(
    (session) => Number((session as SyncableSessionRow & { week_id?: number }).week_id) !== requestedWeekId,
  )) {
    logger.warn(
      { jobId: input.job.jobId, planId: input.payload.planId, reasonCode: 'reflow_session_scope_mismatch' },
      'training-plan-calendar-sync: reflow session scope changed; refusing provider work',
    );
    throw new TrainingPlanCalendarSyncTerminalError('REFLOW_SESSION_SCOPE_MISMATCH');
  }

  const activePayloads = sessions
    .filter((session) => session.schedule_status !== 'dropped' && session.status !== 'skipped')
    .map((session) => buildSessionEventPayload(session, {
      planId: input.payload.planId,
      planVersion: input.payload.planVersion,
    }))
    .filter((event): event is SessionEventPayload => event !== null);
  let liveBusyWindows: SecretaryLiveCalendarBusyWindowsResult['windows'] = [];
  if (activePayloads.length > 0) {
    const startMs = Math.min(...activePayloads.map((event) => Date.parse(event.start)));
    const endMs = Math.max(...activePayloads.map((event) => Date.parse(event.end)));
    input.lease.assertActive();
    const liveBusy = await withTrainingCalendarSyncTimeout(
      loadLiveCalendarBusyWindowsForRange({
        ownerUserId: input.userId,
        tenantId: input.tenantId,
        start: new Date(startMs - 86_400_000).toISOString(),
        end: new Date(endMs + 86_400_000).toISOString(),
        context: `training_week_reflow:${input.payload.planId}`,
      }),
      'reflow_live_busy_windows_fetch',
    );
    input.lease.assertActive();
    if (liveBusy.degraded) {
      throw new TrainingPlanCalendarSyncRetryableError('REFLOW_LIVE_BUSY_WINDOWS_DEGRADED');
    }
    liveBusyWindows = liveBusy.windows;
  }
  // The provider busy-window reader deliberately filters Training-owned
  // events to avoid self-collision during create. Reflow still needs the
  // canonical DB windows for unchanged sibling sessions, otherwise a moved
  // workout can land on top of another Training session invisibly.
  const siblingWindows = loadPersistedTrainingSiblingWindows(input.payload.planId, input.db);

  let transitioned = 0;
  for (const session of sessions) {
    input.lease.assertActive();
    const outcome = await reconcileLinkedReflowSession({
      db: input.db,
      userId: input.userId,
      tenantId: input.tenantId,
      planId: input.payload.planId,
      planVersion: input.payload.planVersion,
      adaptationRevision: effectiveRevision,
      calendarSource: input.calendarSource,
      session,
      now: input.now,
      finalAttempt: input.finalAttempt,
      liveBusyWindows: [
        ...liveBusyWindows,
        ...siblingWindows
          .filter((candidate) => candidate.sessionId !== session.id)
          .map((candidate) => candidate.window),
      ],
      lease: input.lease,
    });
    input.lease.assertActive();
    if (outcome === 'created'
        || outcome === 'attached'
        || outcome === 'updated'
        || outcome === 'deleted') {
      transitioned += 1;
    }
  }
  if (transitioned > 0) {
    input.lease.assertActive();
    invalidateCalendarCaches(input.userId);
    invalidateTrainingDerivedCaches(input.userId);
    input.lease.assertActive();
  }
  logger.info(
    {
      jobId: input.job.jobId,
      planId: input.payload.planId,
      requestedAdaptationRevision: requestedRevision,
      effectiveAdaptationRevision: effectiveRevision,
      requestedSessions: requestedIds.length,
      transitioned,
    },
    'training-plan-calendar-sync: week reflow reconciliation complete',
  );
}

export async function executeTrainingPlanCalendarSyncJob(job: JobRecord): Promise<void> {
  const normalizedPayload = normalizeTrainingPlanCalendarSyncPayload(job.payload);
  if (!normalizedPayload) {
    logger.warn(
      { jobId: job.jobId, tenantId: job.tenantId },
      'training-plan-calendar-sync: malformed job payload; nothing safe to sync',
    );
    throw new TrainingPlanCalendarSyncTerminalError('MALFORMED_PAYLOAD');
  }
  // Non-null rebinding so the nested drain function's closure keeps the
  // narrowing (TS does not flow guards into function bodies).
  const payload = normalizedPayload;
  if (!Number.isSafeInteger(job.tenantId) || job.tenantId <= 0) {
    throw new TrainingPlanCalendarSyncTerminalError('INVALID_TENANT_SCOPE');
  }
  const tenantId = requireTenantIdParam(job.tenantId, 'executeTrainingPlanCalendarSyncJob');
  const userId = Number(job.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    logger.warn(
      { jobId: job.jobId, tenantId, planId: payload.planId },
      'training-plan-calendar-sync: job has no user scope; nothing safe to sync',
    );
    throw new TrainingPlanCalendarSyncTerminalError('INVALID_USER_SCOPE');
  }

  const validatePlan = (): 'active' | 'pending_activation' | 'gone' => {
    const plan = trainingPlans.getPlanById(payload.planId);
    if (!plan) {
      logger.info(
        { jobId: job.jobId, planId: payload.planId, reasonCode: 'plan_missing' },
        'training-plan-calendar-sync: plan no longer exists; sync request is obsolete',
      );
      if (payload.operation === 'week_reflow') {
        throw new TrainingPlanCalendarSyncTerminalError('REFLOW_PLAN_MISSING');
      }
      return 'gone';
    }
    if (plan.user_id !== userId || (plan.tenant_id ?? plan.user_id) !== tenantId) {
      logger.warn(
        { jobId: job.jobId, planId: payload.planId, reasonCode: 'plan_scope_mismatch' },
        'training-plan-calendar-sync: plan scope does not match job scope; refusing provider work',
      );
      throw new TrainingPlanCalendarSyncTerminalError('PLAN_SCOPE_MISMATCH');
    }
    if (plan.status === 'pending_activation') return 'pending_activation';
    const reflowPausedPlan = payload.operation === 'week_reflow' && plan.status === 'paused';
    if (plan.status !== 'active' && !reflowPausedPlan) {
      logger.info(
        { jobId: job.jobId, planId: payload.planId, planStatus: plan.status, reasonCode: 'plan_not_active' },
        'training-plan-calendar-sync: plan is not active; sync request is obsolete',
      );
      if (payload.operation === 'week_reflow') {
        throw new TrainingPlanCalendarSyncTerminalError('REFLOW_PLAN_STATE_MISMATCH');
      }
      return 'gone';
    }
    const currentVersion = getPlanVersion(payload.planId) ?? 1;
    if (currentVersion !== payload.planVersion) {
      logger.info(
        {
          jobId: job.jobId,
          planId: payload.planId,
          requestedPlanVersion: payload.planVersion,
          currentPlanVersion: currentVersion,
          reasonCode: 'plan_version_superseded',
        },
        'training-plan-calendar-sync: plan version superseded; sync request is obsolete',
      );
      if (payload.operation === 'week_reflow') {
        throw new TrainingPlanCalendarSyncTerminalError('REFLOW_PLAN_VERSION_MISMATCH');
      }
      return 'gone';
    }
    return 'active';
  };

  if (!payload.syncTarget) {
    logger.warn(
      { jobId: job.jobId, planId: payload.planId, reasonCode: 'sync_target_missing' },
      'training-plan-calendar-sync: no provider write target in payload; nothing to sync',
    );
    throw new TrainingPlanCalendarSyncTerminalError('SYNC_TARGET_MISSING');
  }
  if (payload.syncTarget === 'none' || payload.syncTarget === 'apple') {
    const planState = validatePlan();
    if (planState === 'pending_activation') {
      throw new TrainingPlanCalendarSyncRetryableError('PLAN_PENDING_ACTIVATION');
    }
    logger.info(
      {
        jobId: job.jobId,
        planId: payload.planId,
        noProviderTarget: payload.syncTarget,
        reasonCode: 'provider_sync_deliberately_disabled',
      },
      'training-plan-calendar-sync: persisted plan choice requires no provider writes',
    );
    return;
  }
  // Secretary's durable provider claim is source-scoped, so even the public
  // `auto` choice must resolve to one exact writable provider before intent
  // persistence. The chosen target is then immutable for this agenda version.
  const resolvedCalendarSource: CalendarSource | null = payload.syncTarget === 'auto'
    ? resolveCalendarWritePreference(userId, tenantId).source
    : payload.syncTarget;
  if (!resolvedCalendarSource) {
    throw new TrainingPlanCalendarSyncRetryableError('PROVIDER_TARGET_UNAVAILABLE');
  }
  const calendarSource: CalendarSource = resolvedCalendarSource;
  const now = new Date();
  const finalAttempt = job.attempts >= job.maxAttempts;
  let enteredOperationLock = false;

  try {
    await runTrainingPlanCalendarSyncDrain();
  } catch (err) {
    // A job that dead-letters from a PRE-WORK failure (lock contention, an
    // activation that never happened) never reaches the in-loop summary
    // write, so without this the persist-time {state:'not_synced',
    // pending:true} would remain the last word forever on a dead job. The
    // in-loop PROVIDER_CREATE_FAILED throw already wrote truthful counters —
    // it must not be overwritten here.
    // PROVIDER_CREATE_FAILED is the only retryable thrown AFTER the in-loop
    // summary wrote truthful counters — every other retryable (pending
    // activation, lock contention, busy-window fetch) failed before any
    // work and left the persist-time {pending:true} as the last word.
    const preWorkErrorCode = err instanceof TrainingPlanCalendarSyncRetryableError
      && err.code !== 'PROVIDER_CREATE_FAILED'
      ? `TRAINING_PLAN_CALENDAR_SYNC_${err.code}`
      : isTrainingOperationLockError(err)
        ? 'TRAINING_OPERATION_LOCKED'
        : isTrainingOperationLockUnavailableError(err)
          ? 'TRAINING_OPERATION_LOCK_UNAVAILABLE'
          : null;
    if (finalAttempt && preWorkErrorCode && !enteredOperationLock) {
      persistTrainingPlanCalendarSyncSummary(payload.planId, {
        schemaVersion: 1,
        state: 'create_failed',
        pending: false,
        provider: calendarSource ?? null,
        requestedSessions: 0,
        eventsCreated: 0,
        eventsAttached: 0,
        eventsUpdated: 0,
        eventsAlreadyOwned: 0,
        eventsFailed: 0,
        eventsSkipped: 0,
        lastErrorCode: preWorkErrorCode,
        updatedAt: now.toISOString(),
      });
    }
    throw err;
  }

  async function runTrainingPlanCalendarSyncDrain(): Promise<void> {
  const preLockState = validatePlan();
  if (preLockState === 'gone') return;
  if (preLockState === 'pending_activation') {
    // Generation persists the replacement as pending, cancels the old plan,
    // THEN activates — the queue can legitimately observe the pending window.
    // Retry with backoff; if the pending row is later discarded the next
    // attempt sees plan_missing and completes as a no-op.
    throw new TrainingPlanCalendarSyncRetryableError('PLAN_PENDING_ACTIVATION');
  }

  await withTrainingCalendarOperationLock(
    {
      userId,
      tenantId,
      planId: payload.planId,
      operation: payload.operation === 'week_reflow' ? 'calendar_reflow' : 'calendar_generate',
    },
    async (lease) => {
      enteredOperationLock = true;
      lease.assertActive();
      // Re-validate under the lock: a cancel/regenerate may have won the lock
      // between the pre-check and acquisition.
      const lockedState = validatePlan();
      if (lockedState === 'gone') return;
      if (lockedState === 'pending_activation') {
        throw new TrainingPlanCalendarSyncRetryableError('PLAN_PENDING_ACTIVATION');
      }

      const db = getDb();
      if (payload.operation === 'week_reflow') {
        await runTrainingWeekReflowReconciliation({
          db,
          job,
          payload,
          userId,
          tenantId,
          calendarSource,
          now,
          finalAttempt,
          lease,
        });
        return;
      }
      const sessions = loadSyncableSessions(payload.planId, payload.sessionIds, db);
      if (sessions.length === 0) {
        // Nothing left to sync — e.g. a manual /plan/sync-calendar linked
        // every session before this drain, or a prior attempt finished the
        // work. Do NOT touch the persisted summary: overwriting it here
        // would flip an honest 'synced' back to 'not_synced'.
        logger.info(
          { jobId: job.jobId, planId: payload.planId, reasonCode: 'no_syncable_sessions' },
          'training-plan-calendar-sync: no syncable sessions remain; leaving persisted state untouched',
        );
        return;
      }
      const eventPayloads = sessions
        .map((session) => buildSessionEventPayload(session, {
          planId: payload.planId,
          planVersion: payload.planVersion,
        }))
        .filter((eventPayload): eventPayload is SessionEventPayload => eventPayload !== null);
      // Eligible sessions whose persisted window is corrupt (unparseable or
      // zero/negative duration) cannot be synced — count them so the summary
      // can never claim 'synced' while they remain, and log them for repair.
      const corruptWindows = sessions.length - eventPayloads.length;
      if (corruptWindows > 0) {
        logger.warn(
          {
            jobId: job.jobId,
            planId: payload.planId,
            corruptWindows,
            reasonCode: 'corrupt_schedule_window',
          },
          'training-plan-calendar-sync: sessions dropped for corrupt schedule windows; route to repair',
        );
      }
      if (eventPayloads.length === 0) {
        // Every requested session is still eligible but none has a safe
        // provider window. Persist the repair-visible truth and finish the
        // queue item without constructing an Infinity range or touching the
        // calendar/Secretary boundary.
        persistTrainingPlanCalendarSyncSummary(payload.planId, {
          schemaVersion: 1,
          state: 'not_synced',
          pending: false,
          provider: calendarSource ?? null,
          requestedSessions: sessions.length,
          eventsCreated: 0,
          eventsAttached: 0,
          eventsUpdated: 0,
          eventsAlreadyOwned: 0,
          eventsFailed: 0,
          eventsSkipped: corruptWindows,
          lastErrorCode: null,
          updatedAt: now.toISOString(),
        }, lease);
        logger.info(
          {
            jobId: job.jobId,
            planId: payload.planId,
            planVersion: payload.planVersion,
            eventsSkipped: corruptWindows,
            reasonCode: 'all_schedule_windows_corrupt',
          },
          'training-plan-calendar-sync: no safe provider windows; persisted repair-visible summary',
        );
        return;
      }

      // F29/F30: ONE bounded live busy-window fetch for the whole plan
      // window (±1 day, matching the per-intent resolver's padding) instead
      // of a provider read per session. Timeout and degraded reads are
      // known-outcome-safe (nothing was written) → retryable with backoff.
      const windowStartMs = Math.min(...eventPayloads.map((event) => Date.parse(event.start)));
      const windowEndMs = Math.max(...eventPayloads.map((event) => Date.parse(event.end)));
      let liveBusy: SecretaryLiveCalendarBusyWindowsResult;
      try {
        lease.assertActive();
        liveBusy = await withTrainingCalendarSyncTimeout(
          loadLiveCalendarBusyWindowsForRange({
            ownerUserId: userId,
            tenantId,
            start: new Date(windowStartMs - 86_400_000).toISOString(),
            end: new Date(windowEndMs + 86_400_000).toISOString(),
            context: `training_plan_calendar_sync:${payload.planId}`,
          }),
          'live_busy_windows_fetch',
        );
        lease.assertActive();
      } catch (err) {
        if (isTrainingOperationLockError(err) || isTrainingOperationLockUnavailableError(err)) {
          throw err;
        }
        throw new TrainingPlanCalendarSyncRetryableError('LIVE_BUSY_WINDOWS_TIMEOUT');
      }
      if (liveBusy.degraded) {
        throw new TrainingPlanCalendarSyncRetryableError('LIVE_BUSY_WINDOWS_DEGRADED');
      }

      let eventsCreated = 0;
      let eventsAttached = 0;
      let eventsUpdated = 0;
      let eventsAlreadyOwned = 0;
      let eventsSkipped = 0;
      let failedRetryable = 0;
      let failedTerminal = 0;

      const batches = chunkArray(eventPayloads, trainingCalendarCreateBatchSize());
      for (const batch of batches) {
        const settled = await Promise.allSettled(batch.map((eventPayload) => syncSessionCalendarEvent({
          userId,
          tenantId,
          planId: payload.planId,
          planVersion: payload.planVersion,
          calendarSource,
          eventPayload,
          now,
          finalAttempt,
          liveBusyWindows: liveBusy.windows,
          db,
          lease,
        })));
        for (const result of settled) {
          if (result.status === 'rejected') {
            if (isTrainingOperationLockError(result.reason)
                || isTrainingOperationLockUnavailableError(result.reason)) {
              throw result.reason;
            }
            failedRetryable += 1;
            logger.warn(
              {
                err: result.reason,
                userId,
                planId: payload.planId,
                planVersion: payload.planVersion,
              },
              'Unexpected failure while batching training calendar event creation',
            );
            continue;
          }
          if (result.value === 'created') eventsCreated += 1;
          if (result.value === 'attached') eventsAttached += 1;
          if (result.value === 'updated') eventsUpdated += 1;
          if (result.value === 'already_owned') eventsAlreadyOwned += 1;
          if (result.value === 'skipped') eventsSkipped += 1;
          if (result.value === 'failed_retryable') failedRetryable += 1;
          if (result.value === 'failed_terminal') failedTerminal += 1;
        }
      }

      const eventsFailed = failedRetryable + failedTerminal;
      if (eventsCreated > 0 || eventsAttached > 0 || eventsUpdated > 0 || eventsFailed > 0) {
        // The route invalidated calendar caches at creation time, but this
        // drain runs later and mutates session↔event linkage — readers must
        // not serve the pre-drain snapshot.
        lease.assertActive();
        invalidateCalendarCaches(userId);
        lease.assertActive();
      }
      // 'synced' denominator is ALL eligible sessions (including
      // corrupt-window drops), so a dropped session can never be papered
      // over by a clean-looking payload subset.
      const allLinked = sessions.length > 0
        && eventsCreated + eventsAttached + eventsUpdated + eventsAlreadyOwned === sessions.length;
      persistTrainingPlanCalendarSyncSummary(payload.planId, {
        schemaVersion: 1,
        state: eventsFailed > 0 ? 'create_failed' : allLinked ? 'synced' : 'not_synced',
        pending: failedTerminal === 0 && failedRetryable > 0 && !finalAttempt,
        provider: calendarSource ?? null,
        requestedSessions: sessions.length,
        eventsCreated,
        eventsAttached,
        eventsUpdated,
        eventsAlreadyOwned,
        eventsFailed,
        eventsSkipped: eventsSkipped + corruptWindows,
        lastErrorCode: failedTerminal > 0
          ? 'TRAINING_PLAN_CALENDAR_SYNC_PROVIDER_CREATE_TERMINAL'
          : failedRetryable > 0
            ? 'TRAINING_PLAN_CALENDAR_SYNC_PROVIDER_CREATE_FAILED'
            : null,
        updatedAt: now.toISOString(),
      }, lease);
      logger.info(
        {
          jobId: job.jobId,
          planId: payload.planId,
          planVersion: payload.planVersion,
          eventsCreated,
          eventsAttached,
          eventsUpdated,
          eventsAlreadyOwned,
          eventsSkipped,
          failedRetryable,
          failedTerminal,
          finalAttempt,
        },
        'training-plan-calendar-sync: drain complete',
      );
      if (failedTerminal > 0) {
        throw new TrainingPlanCalendarSyncTerminalError('PROVIDER_CREATE_TERMINAL');
      }
      if (failedRetryable > 0) {
        throw new TrainingPlanCalendarSyncRetryableError('PROVIDER_CREATE_FAILED');
      }
    },
  );
  }
}

export function buildTrainingPlanCalendarSyncJobHandler(): JobHandler {
  return {
    jobType: TRAINING_PLAN_CALENDAR_SYNC_JOB_TYPE,
    idempotent: true,
    handle(job: JobRecord) {
      return executeTrainingPlanCalendarSyncJob(job);
    },
  };
}

export async function processTrainingPlanCalendarSyncJobs(options: {
  limit?: number;
  lockOwner?: string;
  db?: Database.Database;
  disabled?: boolean;
  jobIds?: string[];
} = {}): Promise<{ completed: number; failed: number; deadLetter: number; skipped: number }> {
  const handlers = [buildTrainingPlanCalendarSyncJobHandler()];
  assertAgentQueuedJobHandlerRuntimeParity(handlers, TRAINING_PLAN_CALENDAR_SYNC_RUNTIME_GROUP);
  return processPendingJobs(handlers, {
    limit: options.limit ?? 5,
    lockOwner: options.lockOwner ?? `training-plan-calendar-sync:${process.pid}`,
    db: options.db,
    disabled: options.disabled || process.env.TRAINING_PLAN_CALENDAR_SYNC_WORKER_DISABLED === '1',
    jobIds: options.jobIds,
  });
}

export async function runScheduledTrainingPlanCalendarSyncJobs(options: {
  limit?: number;
  lockOwner?: string;
  disabled?: boolean;
} = {}): Promise<{ completed: number; failed: number; deadLetter: number; skipped: number }> {
  return processTrainingPlanCalendarSyncJobs(options);
}
