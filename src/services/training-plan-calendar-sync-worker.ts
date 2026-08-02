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
  processPendingJobs,
  type JobHandler,
  type JobRecord,
} from './background-job-queue';
import { assertAgentQueuedJobHandlerRuntimeParity } from './agent-job-manifest';
import * as trainingPlans from './training-plans';
import {
  findExistingOwnership,
  getPlanVersion,
  recordCalendarOwnership,
} from './training-plan-lifecycle';
import {
  markSecretaryAgendaProviderCleanupRequired,
  markSecretaryAgendaProviderSyncSatisfied,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretarySchedulingIntent,
} from './secretary-scheduling-arbitrator';
import { loadLiveCalendarBusyWindowsForSecretaryIntent } from './secretary-live-calendar-busy';
import { emojiForTrainingSession } from './training-calendar-format';
import { appendTrainingIdentityMarker } from './training-session-identity';
import {
  isTrainingOperationLockError,
  withTrainingCalendarOperationLock,
} from './training-operation-locks';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { deleteEvent, type CalendarSource } from './unified-calendar';
import { createTrainingCalendarEvent } from '../api/routes/training-calendar-event-writer';

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
  syncTarget: CalendarSource | 'auto' | null;
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
  const sessionIds = Array.isArray(payload.sessionIds)
    ? payload.sessionIds
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
    : null;
  const syncTarget = payload.syncTarget === 'google'
    || payload.syncTarget === 'outlook'
    || payload.syncTarget === 'auto'
    ? payload.syncTarget
    : null;
  return {
    eventId: typeof payload.eventId === 'string' && payload.eventId.trim() ? payload.eventId : null,
    planId,
    planVersion,
    sessionIds,
    syncTarget,
  };
}

interface SyncableSessionRow {
  id: number;
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

async function deleteCreatedTrainingProviderEventForCompensation(input: {
  eventId: string;
  source: CalendarSource;
  userId: number;
}): Promise<boolean> {
  try {
    await withTrainingCalendarSyncTimeout(
      deleteEvent(input.eventId, input.source, input.userId),
      'provider_event_delete_after_ownership_failure',
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        err,
        userId: input.userId,
        providerEventId: input.eventId,
        providerSource: input.source,
      },
      'Failed to delete Training calendar event during compensation; agenda cleanup will retry provider deletion',
    );
    return false;
  }
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
): void {
  try {
    const plan = trainingPlans.getPlanById(planId);
    if (!plan) return;
    const parsed = plan.preferences_json ? JSON.parse(plan.preferences_json) as unknown : {};
    const preferences = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    preferences.calendarSync = summary;
    trainingPlans.updatePlanPreferences(planId, JSON.stringify(preferences));
  } catch (err) {
    logger.warn(
      { err, planId },
      'training-plan-calendar-sync: failed to persist calendar sync summary',
    );
  }
}

type SessionSyncOutcome = 'created' | 'already_owned' | 'skipped' | 'failed_retryable' | 'failed_terminal';

async function syncSessionCalendarEvent(input: {
  userId: number;
  tenantId: number;
  planId: number;
  planVersion: number;
  /** `undefined` = 'auto': unified-calendar resolves the user's provider. */
  calendarSource: CalendarSource | undefined;
  eventPayload: SessionEventPayload;
  now: Date;
  finalAttempt: boolean;
}): Promise<SessionSyncOutcome> {
  const { userId, tenantId, planId, planVersion, calendarSource, eventPayload, now } = input;
  const existing = findExistingOwnership({
    planId,
    planVersion,
    sessionId: eventPayload.sessionId,
    tenantId,
    userId,
  });
  if (existing) {
    // A previous drain (or the pre-Phase-1B inline phase) already created and
    // recorded the event for this session. Skip to avoid duplicates.
    return 'already_owned';
  }
  let secretaryDecision: SecretarySchedulingDecision | null = null;
  // Tracks a provider event created in THIS attempt so the catch can run the
  // compensating provider delete when a later local write throws — without
  // it, an automatic retry would create a duplicate provider event while the
  // first one stays orphaned in the user's calendar (the inline phase never
  // retried, so this window is new with the queue).
  let createdProviderEvent: { id: string; source: CalendarSource } | null = null;
  try {
    const secretaryIntent = buildTrainingSecretaryIntent({
      userId,
      tenantId,
      planId,
      planVersion,
      calendarSource: calendarSource ?? null,
      eventPayload,
    });
    const liveBusyWindows = await loadLiveCalendarBusyWindowsForSecretaryIntent(secretaryIntent);
    if (liveBusyWindows.degraded) {
      throw new Error('TRAINING_SECRETARY_LIVE_BUSY_WINDOWS_DEGRADED');
    }
    secretaryDecision = submitSecretarySchedulingIntent(
      secretaryIntent,
      {
        now: now.toISOString(),
        additionalBusyWindows: liveBusyWindows.windows,
      },
    );
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
    const event = await withTrainingCalendarSyncTimeout(
      createTrainingCalendarEvent(
        {
          title: eventPayload.title,
          start: selectedWindow.start,
          end: selectedWindow.end,
          description: eventPayload.description,
        },
        calendarSource,
        userId,
        {
          userId,
          tenantId,
          sessionId: eventPayload.sessionId,
          title: eventPayload.title,
        },
      ),
      'provider_event_create',
    );
    createdProviderEvent = { id: event.id, source: event.source };
    trainingPlans.linkSessionToCalendar(eventPayload.sessionId, event.id, event.source);
    // Record ownership AFTER the session linkage write so we never record an
    // audit row for an event whose local linkage failed. The recorder is
    // idempotent; concurrent races degrade to a safe no-op.
    const ownership = recordCalendarOwnership({
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
    });
    if (!ownership.ok) {
      trainingPlans.updateSession(eventPayload.sessionId, {
        status: 'unscheduled',
        calendar_event_id: null,
        calendar_source: null,
      });
      const providerDeleteSucceeded = await deleteCreatedTrainingProviderEventForCompensation({
        eventId: event.id,
        source: event.source,
        userId,
      });
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        providerEventId: providerDeleteSucceeded ? null : event.id,
        providerSource: providerDeleteSucceeded ? null : event.source,
        providerSyncState: providerDeleteSucceeded ? 'deleted' : 'delete_failed',
        lifecycleState: 'unscheduled',
        reason: 'training_provider_ownership_record_failed',
        clearProviderMapping: providerDeleteSucceeded,
        now: now.toISOString(),
      });
      logger.warn(
        {
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
    try {
      markSecretaryAgendaProviderSyncSatisfied({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        providerEventId: event.id,
        providerSource: event.source,
        now: now.toISOString(),
      });
    } catch (agendaErr) {
      // Advisory only: the provider event, local linkage, and ownership row
      // are all durable at this point. Letting this throw would reach the
      // outer catch and terminally unschedule a session whose live provider
      // event exists — a split-brain invisible to the orphan scans.
      logger.warn(
        { err: agendaErr, userId, planId, sessionId: eventPayload.sessionId },
        'training-plan-calendar-sync: agenda sync-satisfied marking failed after a durable link; continuing',
      );
    }
    return 'created';
  } catch (err) {
    // Retry-safety classification. A retry may only be attempted when the
    // provider write outcome is KNOWN to be "no event exists":
    //   - createdProviderEvent set → a later local write threw; delete the
    //     provider event (or hand its id to the agenda cleanup queue) so the
    //     retry cannot duplicate it.
    //   - provider-create timeout → outcome UNKNOWN; retrying blind could
    //     duplicate an event that actually landed. Terminal, like the inline
    //     phase treated every failure — the identity marker in the event
    //     description keeps a possible orphan reconcilable.
    //   - anything else (busy-window degraded, provider rejection/5xx before
    //     a create resolved) → retryable with backoff.
    const message = err instanceof Error ? err.message : String(err);
    const unknownProviderOutcome =
      message.startsWith('TRAINING_CALENDAR_SYNC_TIMEOUT:provider_event_create');
    let providerDeleteSucceeded: boolean | null = null;
    if (createdProviderEvent) {
      providerDeleteSucceeded = await deleteCreatedTrainingProviderEventForCompensation({
        eventId: createdProviderEvent.id,
        source: createdProviderEvent.source,
        userId,
      });
    }
    const terminal = unknownProviderOutcome || createdProviderEvent !== null;
    if (secretaryDecision?.agendaItem?.agendaItemId) {
      markSecretaryAgendaProviderCleanupRequired({
        agendaItemId: secretaryDecision.agendaItem.agendaItemId,
        ownerUserId: userId,
        tenantId,
        ...(createdProviderEvent && providerDeleteSucceeded === false
          ? {
            providerEventId: createdProviderEvent.id,
            providerSource: createdProviderEvent.source,
            providerSyncState: 'delete_failed' as const,
          }
          : { providerSyncState: 'create_failed' as const }),
        lifecycleState: 'unscheduled',
        reason: 'training_provider_event_create_failed',
        clearProviderMapping: !(createdProviderEvent && providerDeleteSucceeded === false),
        now: now.toISOString(),
      });
    }
    // Behaviour change vs. the inline phase (deliberate): a transient create
    // failure no longer permanently unschedules the session — the row stays
    // eligible so the job retry can finish it. Terminal classes and the
    // FINAL attempt still apply the compensation so a dead-lettered job (or
    // an unknown-outcome write) leaves honest, non-retryable state.
    if (terminal || input.finalAttempt) {
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
        terminal,
        unknownProviderOutcome,
      },
      'Failed to create calendar event for session',
    );
    return terminal ? 'failed_terminal' : 'failed_retryable';
  }
}

export async function executeTrainingPlanCalendarSyncJob(job: JobRecord): Promise<void> {
  const normalizedPayload = normalizeTrainingPlanCalendarSyncPayload(job.payload);
  if (!normalizedPayload) {
    logger.warn(
      { jobId: job.jobId, tenantId: job.tenantId },
      'training-plan-calendar-sync: malformed job payload; nothing safe to sync',
    );
    return;
  }
  // Non-null rebinding so the nested drain function's closure keeps the
  // narrowing (TS does not flow guards into function bodies).
  const payload = normalizedPayload;
  const tenantId = requireTenantIdParam(job.tenantId, 'executeTrainingPlanCalendarSyncJob');
  const userId = Number(job.userId);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    logger.warn(
      { jobId: job.jobId, tenantId, planId: payload.planId },
      'training-plan-calendar-sync: job has no user scope; nothing safe to sync',
    );
    return;
  }

  const validatePlan = (): 'active' | 'pending_activation' | 'gone' => {
    const plan = trainingPlans.getPlanById(payload.planId);
    if (!plan) {
      logger.info(
        { jobId: job.jobId, planId: payload.planId, reasonCode: 'plan_missing' },
        'training-plan-calendar-sync: plan no longer exists; sync request is obsolete',
      );
      return 'gone';
    }
    if (plan.user_id !== userId || (plan.tenant_id ?? plan.user_id) !== tenantId) {
      logger.warn(
        { jobId: job.jobId, planId: payload.planId, reasonCode: 'plan_scope_mismatch' },
        'training-plan-calendar-sync: plan scope does not match job scope; refusing provider work',
      );
      return 'gone';
    }
    if (plan.status === 'pending_activation') return 'pending_activation';
    if (plan.status !== 'active') {
      logger.info(
        { jobId: job.jobId, planId: payload.planId, planStatus: plan.status, reasonCode: 'plan_not_active' },
        'training-plan-calendar-sync: plan is not active; sync request is obsolete',
      );
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
      return 'gone';
    }
    return 'active';
  };

  if (!payload.syncTarget) {
    logger.warn(
      { jobId: job.jobId, planId: payload.planId, reasonCode: 'sync_target_missing' },
      'training-plan-calendar-sync: no provider write target in payload; nothing to sync',
    );
    return;
  }
  // 'auto' → undefined: the provider writer lets unified-calendar resolve
  // the user's provider at write time, exactly like the released auto path.
  const calendarSource: CalendarSource | undefined =
    payload.syncTarget === 'auto' ? undefined : payload.syncTarget;
  const now = new Date();
  const finalAttempt = job.attempts >= job.maxAttempts;

  try {
    await runTrainingPlanCalendarSyncDrain();
  } catch (err) {
    // A job that dead-letters from a PRE-WORK failure (lock contention, an
    // activation that never happened) never reaches the in-loop summary
    // write, so without this the persist-time {state:'not_synced',
    // pending:true} would remain the last word forever on a dead job. The
    // in-loop PROVIDER_CREATE_FAILED throw already wrote truthful counters —
    // it must not be overwritten here.
    const preWorkErrorCode = err instanceof TrainingPlanCalendarSyncRetryableError
      && err.code === 'PLAN_PENDING_ACTIVATION'
      ? 'TRAINING_PLAN_CALENDAR_SYNC_PLAN_PENDING_ACTIVATION'
      : isTrainingOperationLockError(err)
        ? 'TRAINING_OPERATION_LOCKED'
        : null;
    if (finalAttempt && preWorkErrorCode) {
      persistTrainingPlanCalendarSyncSummary(payload.planId, {
        schemaVersion: 1,
        state: 'create_failed',
        pending: false,
        provider: calendarSource ?? null,
        requestedSessions: 0,
        eventsCreated: 0,
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
      operation: 'calendar_generate',
    },
    async () => {
      // Re-validate under the lock: a cancel/regenerate may have won the lock
      // between the pre-check and acquisition.
      const lockedState = validatePlan();
      if (lockedState === 'gone') return;
      if (lockedState === 'pending_activation') {
        throw new TrainingPlanCalendarSyncRetryableError('PLAN_PENDING_ACTIVATION');
      }

      const db = getDb();
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

      let eventsCreated = 0;
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
        })));
        for (const result of settled) {
          if (result.status === 'rejected') {
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
          if (result.value === 'already_owned') eventsAlreadyOwned += 1;
          if (result.value === 'skipped') eventsSkipped += 1;
          if (result.value === 'failed_retryable') failedRetryable += 1;
          if (result.value === 'failed_terminal') failedTerminal += 1;
        }
      }

      const eventsFailed = failedRetryable + failedTerminal;
      if (eventsCreated > 0 || eventsFailed > 0) {
        // The route invalidated calendar caches at creation time, but this
        // drain runs later and mutates session↔event linkage — readers must
        // not serve the pre-drain snapshot.
        invalidateCalendarCaches(userId);
      }
      // 'synced' denominator is ALL eligible sessions (including
      // corrupt-window drops), so a dropped session can never be papered
      // over by a clean-looking payload subset.
      const allLinked = sessions.length > 0
        && eventsCreated + eventsAlreadyOwned === sessions.length;
      persistTrainingPlanCalendarSyncSummary(payload.planId, {
        schemaVersion: 1,
        state: eventsFailed > 0 ? 'create_failed' : allLinked ? 'synced' : 'not_synced',
        pending: failedRetryable > 0 && !finalAttempt,
        provider: calendarSource ?? null,
        requestedSessions: sessions.length,
        eventsCreated,
        eventsAlreadyOwned,
        eventsFailed,
        eventsSkipped: eventsSkipped + corruptWindows,
        lastErrorCode: eventsFailed > 0 ? 'TRAINING_PLAN_CALENDAR_SYNC_PROVIDER_CREATE_FAILED' : null,
        updatedAt: now.toISOString(),
      });
      logger.info(
        {
          jobId: job.jobId,
          planId: payload.planId,
          planVersion: payload.planVersion,
          eventsCreated,
          eventsAlreadyOwned,
          eventsSkipped,
          failedRetryable,
          failedTerminal,
          finalAttempt,
        },
        'training-plan-calendar-sync: drain complete',
      );
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
