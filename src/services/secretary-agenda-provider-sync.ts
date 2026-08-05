// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import { getDb } from './database';
import {
  computeSecretaryAgendaProviderSyncFingerprint,
  getSecretaryAgendaItemById,
  type SecretaryAgendaItem,
  type SecretaryAgendaLifecycleState,
  type SecretaryProviderSyncState,
} from './secretary-scheduling-arbitrator';
import { isProviderEventNotFoundError } from './training-calendar-errors';
import { logger } from '../utils/logger';
import { emitDomainEvent } from './event-outbox';
import { COOKING_MEAL_PREP_PROVIDER_SYNC_COMPLETED_EVENT_TYPE } from './cooking-calendar-sync-completion';
import {
  expireUnsyncedSecretaryPreemptionWinners,
  finalizeSecretaryPreemptionCancellationsAfterAgendaCleanup,
  hasUnresolvedSecretaryPreemptionDependencies,
  markSecretaryPreemptionWinnerProviderFailed,
  markSecretaryPreemptionWinnerProviderSucceeded,
  processSecretaryPreemptionDependencies,
} from './secretary-agenda-preemption-worker';
import { secretaryAgendaPreemptionSchemaReady } from './secretary-agenda-preemption';
import {
  assertTrainingCalendarSourceWritesEnabled,
  TrainingOperationDisabledError,
} from './training-operational-switches';

export type SecretaryCalendarProviderSource = 'google' | 'outlook';

export interface SecretaryProviderEventInput {
  agendaItemId: string;
  sourceIntentId: string;
  sourceSkill: string;
  sourceEntityId: string | null;
  sourceEntityType: string | null;
  ownerUserId: number;
  tenantId: string;
  version: number;
  title: string;
  startAt: string;
  endAt: string;
  durationMinutes: number | null;
  lifecycleState: string;
  decisionReasonCodes: string[];
  sourceShapeHash: string;
}

export interface SecretaryProviderEvent {
  eventId: string;
  source: SecretaryCalendarProviderSource;
  agendaItemId: string;
  title?: string;
  startAt?: string;
  endAt?: string;
  version?: number;
  /**
   * Set by adapters when the provider event carries the Training identity
   * marker for this agenda item's source session. Canonical-event selection
   * prefers these so duplicate cleanup never deletes the event that
   * `training_sessions.calendar_event_id` links to.
   */
  trainingOwned?: boolean;
}

export type SecretaryProviderEventReadResult =
  | { status: 'found'; event: SecretaryProviderEvent }
  | { status: 'not_found' }
  | { status: 'unknown'; reasonCode: string };

export interface SecretaryAgendaProviderAdapter {
  source: SecretaryCalendarProviderSource;
  createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent>;
  updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent>;
  deleteEvent(eventId: string, input: SecretaryProviderEventInput | null): Promise<void>;
  getEvent?(eventId: string, input: SecretaryProviderEventInput | null): Promise<SecretaryProviderEventReadResult>;
  findEventsByAgendaItemId?(agendaItemId: string, input: SecretaryProviderEventInput | null): Promise<SecretaryProviderEvent[]>;
}

export type SecretaryAgendaProviderSyncAction =
  | 'created'
  | 'updated'
  | 'attached'
  | 'recreated'
  | 'deleted'
  | 'duplicate_deleted'
  | 'skipped'
  | 'failed';

export interface SecretaryAgendaProviderSyncResult {
  agendaItemId: string;
  action: SecretaryAgendaProviderSyncAction;
  providerEventId: string | null;
  providerSource: SecretaryCalendarProviderSource;
  providerSyncState: SecretaryProviderSyncState;
  deletedDuplicateEventIds: string[];
  reasonCode: string;
  retryAfterMs?: number | null;
}

export interface SecretaryAgendaProviderSyncScope {
  ownerUserId: number;
  tenantId: string | number;
  includeInactive?: boolean;
}

export interface PendingSecretaryAgendaProviderScope {
  ownerUserId: number;
  tenantId: string;
  providerSource: SecretaryCalendarProviderSource;
}

/**
 * Enumerate durable provider work by its exact owner + tenant + pinned target.
 * The scheduler must never reconstruct tenant scope as `tenantId = userId` or
 * fan one provider-agnostic row across every connected calendar.
 */
export function listPendingSecretaryAgendaProviderScopes(): PendingSecretaryAgendaProviderScope[] {
  const db = getDb();
  const dependencyScopes = secretaryAgendaPreemptionSchemaReady(db) ? `
    UNION
    SELECT dependency.owner_user_id, dependency.tenant_id,
           dependency.loser_provider_source AS provider_target
      FROM secretary_agenda_preemption_dependencies AS dependency
      JOIN secretary_agenda_preemption_operations AS operation
        ON operation.operation_id = dependency.operation_id
       AND operation.owner_user_id = dependency.owner_user_id
       AND operation.tenant_id = dependency.tenant_id
     WHERE dependency.loser_provider_source IN ('google', 'outlook')
       AND dependency.state IN ('pending', 'in_progress', 'retryable', 'reconcile')
       AND operation.state IN ('cleanup_pending', 'cleanup_blocked')
  ` : '';
  const rows = db.prepare(`
    SELECT DISTINCT owner_user_id, tenant_id, provider_target
      FROM secretary_agenda_items AS agenda
     WHERE provider_target IN ('google', 'outlook')
       AND COALESCE(provider_sync_failure_disposition, '') <> 'terminal'
       AND (
         provider_sync_retry_after_at IS NULL
         OR datetime(provider_sync_retry_after_at) <= datetime('now')
       )
       AND (
         lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
         OR (provider_event_id IS NOT NULL AND provider_sync_state <> 'deleted')
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_create_reconciliation AS attempt
            WHERE attempt.owner_user_id = agenda.owner_user_id
              AND attempt.tenant_id = agenda.tenant_id
              AND attempt.provider_source = agenda.provider_target
              AND attempt.source_skill = agenda.source_skill
              AND attempt.source_intent_id = agenda.source_intent_id
              AND attempt.resolution_state IN ('in_flight', 'unknown', 'known')
         )
         OR EXISTS (
           SELECT 1 FROM secretary_agenda_provider_effect_recovery AS recovery
            WHERE recovery.owner_user_id = agenda.owner_user_id
              AND recovery.tenant_id = agenda.tenant_id
              AND recovery.provider_source = agenda.provider_target
              AND recovery.source_skill = agenda.source_skill
              AND recovery.source_intent_id = agenda.source_intent_id
              AND recovery.resolution_state = 'pending'
         )
       )
    ${dependencyScopes}
     ORDER BY owner_user_id, tenant_id, provider_target
  `).all() as Array<{
    owner_user_id: number;
    tenant_id: string;
    provider_target: SecretaryCalendarProviderSource;
  }>;
  return rows.map((row) => ({
    ownerUserId: Number(row.owner_user_id),
    tenantId: String(row.tenant_id),
    providerSource: row.provider_target,
  }));
}

export interface SecretaryAgendaProviderSyncOptions {
  retryBudget?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Hard total adapter-call budget for one batch. Discovery, read, create,
   * update, and delete calls all consume the same budget.
   */
  maxItems?: number;
  /** Durable per-item claim lifetime. */
  leaseDurationMs?: number;
  /** Claim renewal cadence while provider work is in flight. */
  heartbeatIntervalMs?: number;
  /**
   * Restrict acquisition to one authoritative agenda row. Skill-owned
   * synchronous routes use this so they cannot drain unrelated Secretary
   * backlog while still receiving the same durable claim/create fencing as
   * the background worker.
   */
  agendaItemId?: string;
}

const DEFAULT_PROVIDER_RETRY_BUDGET = 2;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 250;
const DEFAULT_PROVIDER_RETRY_MAX_MS = 2_000;
const DEFAULT_PROVIDER_SYNC_MAX_ITEMS = 50;
const DEFAULT_PROVIDER_SYNC_LEASE_MS = 15 * 60_000;
const DEFAULT_PROVIDER_SYNC_HEARTBEAT_MS = 60_000;

interface SecretaryAgendaProviderSyncClaim {
  agendaItemId: string;
  ownerUserId: number;
  tenantId: string;
  providerSource: SecretaryCalendarProviderSource;
  sourceSkill: string;
  sourceIntentId: string;
  agendaVersion: number;
  desiredFingerprint: string;
  leaseToken: string;
  leaseDurationMs: number;
  cleanupOnly: boolean;
  lost: boolean;
}

interface SecretaryAgendaProviderSyncExecution {
  claim: SecretaryAgendaProviderSyncClaim;
  callBudget: SecretaryAgendaProviderCallBudget;
  assertActive(): void;
}

interface SecretaryAgendaProviderCallBudget {
  limit: number;
  used: number;
}

interface SecretaryAgendaProviderEffectRecovery {
  recoveryId: string;
  agendaItemId: string;
  agendaVersion: number;
  desiredFingerprint: string;
  providerEventId: string;
  effectKind: 'create' | 'update' | 'adopt';
}

type SecretaryAgendaProviderCreateAttemptState =
  | 'in_flight'
  | 'unknown'
  | 'known'
  | 'attached'
  | 'deleted'
  | 'superseded'
  | 'no_effect';

interface SecretaryAgendaProviderCreateAttempt {
  attemptId: string;
  agendaItemId: string;
  agendaVersion: number;
  desiredFingerprint: string;
  providerEventId: string | null;
  resolutionState: SecretaryAgendaProviderCreateAttemptState;
}

interface SecretaryAgendaProviderCreateAttemptObservation {
  attempt: SecretaryAgendaProviderCreateAttempt;
  events: SecretaryProviderEvent[];
}

export interface SecretaryAgendaProviderSyncMetricsSnapshot {
  batches: number;
  attempted: number;
  succeeded: number;
  failed: number;
  deadLetter: number;
  backlogEligible: number;
  backlogOldestAgeMs: number;
}

const providerSyncMetrics: SecretaryAgendaProviderSyncMetricsSnapshot = {
  batches: 0,
  attempted: 0,
  succeeded: 0,
  failed: 0,
  deadLetter: 0,
  backlogEligible: 0,
  backlogOldestAgeMs: 0,
};

export function getSecretaryAgendaProviderSyncMetricsSnapshot(): SecretaryAgendaProviderSyncMetricsSnapshot {
  return { ...providerSyncMetrics };
}

export function _resetSecretaryAgendaProviderSyncMetricsForTests(): void {
  providerSyncMetrics.batches = 0;
  providerSyncMetrics.attempted = 0;
  providerSyncMetrics.succeeded = 0;
  providerSyncMetrics.failed = 0;
  providerSyncMetrics.deadLetter = 0;
  providerSyncMetrics.backlogEligible = 0;
  providerSyncMetrics.backlogOldestAgeMs = 0;
}

const ACTIVE_PROVIDER_STATES = new Set([
  'scheduled',
  'synced',
  'reflowed',
  'compressed',
  'failed_sync',
]);

const CLEANUP_PROVIDER_STATES = new Set([
  'canceled',
  'superseded',
  'unscheduled',
  'deferred',
]);

const FAILED_PROVIDER_SYNC_STATES = new Set<SecretaryProviderSyncState>([
  'create_failed',
  'update_failed',
  'delete_failed',
  'readback_failed',
]);

// Consecutive delete failures after which cleanup stops retrying every
// sync cycle. Scoped to 'delete_failed' only — dead-lettering create/update
// failures would silently strand an item the user still expects to sync.
const PROVIDER_SYNC_DEAD_LETTER_THRESHOLD = 5;

// Provider-sync short-circuit (migration 224). Unchanged 'synced' items skip
// all provider round-trips until the re-verification window elapses, so
// external calendar drift still heals. 0 disables the short-circuit entirely.
const DEFAULT_SYNC_VERIFY_INTERVAL_MINUTES = 360;

function syncVerifyIntervalMinutes(): number {
  const raw = process.env.SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES;
  if (raw == null || raw.trim() === '') return DEFAULT_SYNC_VERIFY_INTERVAL_MINUTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SYNC_VERIFY_INTERVAL_MINUTES;
  return parsed;
}

// Single source of truth lives in the arbitrator so the fingerprint written
// by markSecretaryAgendaProviderSyncSatisfied can never drift from the one
// this module computes for the short-circuit comparison.
function computeProviderSyncFingerprint(
  agendaItem: SecretaryAgendaItem,
  source: SecretaryCalendarProviderSource,
): string {
  return computeSecretaryAgendaProviderSyncFingerprint(agendaItem, source);
}

function isProviderSyncFingerprintFresh(
  agendaItem: SecretaryAgendaItem,
  fingerprint: string,
): boolean {
  const intervalMinutes = syncVerifyIntervalMinutes();
  if (intervalMinutes === 0) return false;
  if (agendaItem.lastSyncedFingerprint !== fingerprint) return false;
  if (!agendaItem.lastSyncedVerifiedAt) return false;
  const verifiedAtMs = Date.parse(agendaItem.lastSyncedVerifiedAt);
  if (!Number.isFinite(verifiedAtMs)) return false;
  return Date.now() - verifiedAtMs < intervalMinutes * 60_000;
}

export function markCompletedSecretaryAgendaItems(now: Date = new Date()): number {
  expireUnsyncedSecretaryPreemptionWinners(now);
  const preemptionFence = secretaryAgendaPreemptionSchemaReady() ? `
    AND NOT EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_operations AS operation
       WHERE operation.owner_user_id = secretary_agenda_items.owner_user_id
         AND operation.tenant_id = secretary_agenda_items.tenant_id
         AND operation.winner_agenda_item_id = secretary_agenda_items.agenda_item_id
         AND operation.winner_agenda_version = secretary_agenda_items.version
         AND operation.state IN (
           'cleanup_pending', 'cleanup_blocked', 'winner_ready',
           'winner_reconcile', 'terminal_failure'
         )
    )
  ` : '';
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'completed',
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
     WHERE end_at IS NOT NULL
       AND datetime(end_at) < datetime(?)
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed')
       ${preemptionFence}
  `).run(now.toISOString(), now.toISOString(), now.toISOString());
  return Number(result.changes ?? 0);
}

export async function syncSecretaryAgendaItemToProvider(
  scope: {
    agendaItemId: string;
    ownerUserId: number;
    tenantId: string | number;
  },
  adapter: SecretaryAgendaProviderAdapter,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryAgendaProviderSyncResult> {
  execution?.assertActive();
  const agendaItem = getSecretaryAgendaItemById(scope);
  if (!agendaItem) {
    throw new Error('Secretary agenda item not found for provider sync scope');
  }
  if (execution && agendaItem.version !== execution.claim.agendaVersion) {
    throw providerSyncLeaseLostError(execution.claim);
  }

  // Stage 3: the winner is locally reserved but provider-ineligible until
  // every exact loser-delete edge is durably satisfied. Keep this runtime
  // fence even though migration 282 also blocks raw claim/create/mapping
  // writes; direct single-item callers do not always carry a worker claim.
  if (hasUnresolvedSecretaryPreemptionDependencies({
    agendaItemId: agendaItem.agendaItemId,
    agendaVersion: agendaItem.version,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
  })) {
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'skipped',
      providerEventId: agendaItem.providerEventId,
      providerSource: (agendaItem.providerTarget ?? adapter.source) as SecretaryCalendarProviderSource,
      providerSyncState: agendaItem.providerSyncState,
      deletedDuplicateEventIds: [],
      reasonCode: 'priority_preemption_dependencies_pending',
    };
  }

  if (agendaItem.providerTarget !== adapter.source) {
    const durableSource = agendaItem.providerSource ?? agendaItem.providerTarget ?? adapter.source;
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'skipped',
      providerEventId: agendaItem.providerEventId,
      providerSource: durableSource as SecretaryCalendarProviderSource,
      providerSyncState: agendaItem.providerSyncState,
      deletedDuplicateEventIds: [],
      reasonCode: agendaItem.providerTarget
        ? 'provider_target_mismatch'
        : 'provider_target_not_pinned',
    };
  }

  if (agendaItem.providerSource && agendaItem.providerSource !== adapter.source) {
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'skipped',
      providerEventId: agendaItem.providerEventId,
      providerSource: agendaItem.providerSource as SecretaryCalendarProviderSource,
      providerSyncState: agendaItem.providerSyncState,
      deletedDuplicateEventIds: [],
      reasonCode: 'provider_source_mismatch',
    };
  }

  // The agenda worker is a generic drain, so route-time switches are not an
  // effect fence. Wrap only outbound mutations after the durable Training row
  // is known; exact reads and local reconciliation remain available while a
  // Training kill switch is active.
  if (agendaItem.sourceSkill === 'training') {
    adapter = trainingEffectGuardedAdapter(adapter);
  }

  const unresolvedCreateAttempts = readUnresolvedProviderCreateAttempts(agendaItem, adapter.source);
  const hasPendingKnownEffects = hasPendingKnownProviderCreateEffects(agendaItem, adapter.source);

  if (
    isTerminalDeletedCleanupRow(agendaItem)
    && unresolvedCreateAttempts.length === 0
    && !hasPendingKnownEffects
  ) {
    return result(
      agendaItem,
      'skipped',
      null,
      adapter.source,
      'deleted',
      [],
      'terminal_cleanup_no_provider_event',
    );
  }

  if (
    agendaItem.providerSyncState === 'delete_failed'
    && agendaItem.providerSyncFailureCount >= PROVIDER_SYNC_DEAD_LETTER_THRESHOLD
  ) {
    logger.debug({
      agendaItemId: agendaItem.agendaItemId,
      providerSyncFailureCount: agendaItem.providerSyncFailureCount,
      providerSource: adapter.source,
    }, 'Secretary agenda provider cleanup dead-lettered — skipping automatic retries until the failure count is reset');
    return result(
      agendaItem,
      'skipped',
      agendaItem.providerEventId,
      adapter.source,
      agendaItem.providerSyncState,
      [],
      'provider_sync_dead_letter',
    );
  }

  if (agendaItem.cancellationReason && ACTIVE_PROVIDER_STATES.has(agendaItem.lifecycleState)) {
    const canceled = markCancellationReasonedItemCanceled(agendaItem, execution);
    return cleanupProviderEvent(canceled, adapter, execution, unresolvedCreateAttempts);
  }

  const trainingBackedCleanup = markUnschedulableTrainingAgendaItemForCleanup(agendaItem, execution);
  if (trainingBackedCleanup) {
    return cleanupProviderEvent(trainingBackedCleanup, adapter, execution, unresolvedCreateAttempts);
  }

  if (CLEANUP_PROVIDER_STATES.has(agendaItem.lifecycleState)) {
    return cleanupProviderEvent(agendaItem, adapter, execution, unresolvedCreateAttempts);
  }

  if (!ACTIVE_PROVIDER_STATES.has(agendaItem.lifecycleState)) {
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'skipped',
      providerEventId: agendaItem.providerEventId,
      providerSource: adapter.source,
      providerSyncState: agendaItem.providerSyncState,
      deletedDuplicateEventIds: [],
      reasonCode: 'lifecycle_not_provider_backed',
    };
  }

  if (!agendaItem.startAt || !agendaItem.endAt) {
    updateProviderMapping(agendaItem, {
      providerSyncState: 'create_failed',
    }, execution);
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'failed',
      providerEventId: agendaItem.providerEventId,
      providerSource: adapter.source,
      providerSyncState: 'create_failed',
      deletedDuplicateEventIds: [],
      reasonCode: 'missing_scheduled_time',
    };
  }

  const fingerprint = computeProviderSyncFingerprint(agendaItem, adapter.source);

  if (unresolvedCreateAttempts.length > 0) {
    return reconcileProviderCreateAttempts(
      agendaItem,
      adapter,
      fingerprint,
      unresolvedCreateAttempts,
      execution,
    );
  }

  // A known successful create whose local mapping did not commit is handled
  // before ordinary discovery. The exact returned id is either adopted by
  // the current logical version or deleted when a newer mapping already won.
  const recovered = await reconcileKnownProviderCreateEffects(
    agendaItem,
    adapter,
    fingerprint,
    execution,
  );
  if (recovered) return recovered;

  // Short-circuit: the item is already synced and nothing we would push has
  // changed since the last successful sync. A fresh fingerprint performs no
  // provider operation at all; marker discovery, readback, and drift repair
  // resume after SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES so externally
  // deleted/moved provider events are healed on the next full pass.
  if (
    agendaItem.providerSyncState === 'synced'
    && agendaItem.providerEventId
    && isProviderSyncFingerprintFresh(agendaItem, fingerprint)
  ) {
    // A fresh fingerprint is the explicit zero-provider-call fast path. Drift
    // and duplicate discovery resume after the bounded verification window.
    return result(
      agendaItem,
      'skipped',
      agendaItem.providerEventId,
      adapter.source,
      'synced',
      [],
      'unchanged_since_last_sync',
    );
  }

  return upsertProviderEvent(agendaItem, adapter, fingerprint, execution);
}

function trainingEffectGuardedAdapter(
  adapter: SecretaryAgendaProviderAdapter,
): SecretaryAgendaProviderAdapter {
  const assertEnabled = () => assertTrainingCalendarSourceWritesEnabled(adapter.source);
  return {
    source: adapter.source,
    createEvent: async (input) => {
      assertEnabled();
      return adapter.createEvent(input);
    },
    updateEvent: async (eventId, input) => {
      assertEnabled();
      return adapter.updateEvent(eventId, input);
    },
    deleteEvent: async (eventId, input) => {
      assertEnabled();
      return adapter.deleteEvent(eventId, input);
    },
    ...(adapter.getEvent ? {
      getEvent: (eventId: string, input: SecretaryProviderEventInput | null) =>
        adapter.getEvent!(eventId, input),
    } : {}),
    ...(adapter.findEventsByAgendaItemId ? {
      findEventsByAgendaItemId: (agendaItemId: string, input: SecretaryProviderEventInput | null) =>
        adapter.findEventsByAgendaItemId!(agendaItemId, input),
    } : {}),
  };
}

export async function syncSecretaryAgendaItemsToProvider(
  scope: SecretaryAgendaProviderSyncScope,
  adapter: SecretaryAgendaProviderAdapter,
  options: SecretaryAgendaProviderSyncOptions = {},
): Promise<SecretaryAgendaProviderSyncResult[]> {
  const includeInactive = scope.includeInactive ?? true;
  const maxItems = normalizeProviderSyncMaxItems(options.maxItems);
  const backlog = readProviderSyncBacklogStats(
    scope,
    adapter.source,
    includeInactive,
    options.agendaItemId,
  );
  providerSyncMetrics.batches += 1;
  providerSyncMetrics.backlogEligible = backlog.eligible;
  providerSyncMetrics.backlogOldestAgeMs = backlog.oldestAgeMs;
  providerSyncMetrics.deadLetter = backlog.deadLetter;
  if (maxItems === 0) return [];

  // Exact preemption edges own the first share of the one batch-wide provider
  // call budget. Skill-owned single-item sync stays narrowly scoped and never
  // drains unrelated arbitration work.
  const dependencyBatch = await processSecretaryPreemptionDependencies({
    ownerUserId: scope.ownerUserId,
    tenantId: scope.tenantId,
    providerSource: adapter.source,
    adapter,
    maxCalls: maxItems,
    winnerAgendaItemId: options.agendaItemId,
    leaseDurationMs: options.leaseDurationMs,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
  });
  const remainingCallBudget = Math.max(0, maxItems - dependencyBatch.callsUsed);
  for (const entry of dependencyBatch.results) {
    providerSyncMetrics.attempted += 1;
    if (entry.action === 'failed') providerSyncMetrics.failed += 1;
    else providerSyncMetrics.succeeded += 1;
  }

  const claims = claimSecretaryAgendaProviderSyncBatch(
    scope,
    adapter.source,
    includeInactive,
    remainingCallBudget,
    { ...options, maxItems: remainingCallBudget },
  );
  const callBudget: SecretaryAgendaProviderCallBudget = { limit: remainingCallBudget, used: 0 };
  // Claims are acquired as one bounded, ordered batch before provider work.
  // Heartbeat every claimed row immediately so a slow first adapter call
  // cannot let a queued row expire and be executed by a competing worker.
  const heartbeatStops = new Map(
    claims.map((claim) => [
      claim.leaseToken,
      startProviderSyncClaimHeartbeat(claim, options),
    ]),
  );
  const results: SecretaryAgendaProviderSyncResult[] = [...dependencyBatch.results];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    try {
      const synced = await withSecretaryAgendaProviderSyncClaim(
        claim,
        callBudget,
        heartbeatStops.get(claim.leaseToken),
        (execution) => syncSecretaryAgendaItemToProviderWithRetry({
          agendaItemId: claim.agendaItemId,
          ownerUserId: claim.ownerUserId,
          tenantId: claim.tenantId,
        }, adapter, options, execution),
      );
      results.push(synced);
      providerSyncMetrics.attempted += 1;
      if (synced.action === 'failed') providerSyncMetrics.failed += 1;
      else providerSyncMetrics.succeeded += 1;
    } catch (error) {
      if (isProviderCallBudgetExhaustedError(error)) {
        heartbeatStops.get(claim.leaseToken)?.();
        releaseProviderSyncClaim(claim);
        const deferred = providerCallBudgetDeferredResult(claim, adapter.source);
        results.push(deferred);
        providerSyncMetrics.attempted += 1;
        providerSyncMetrics.failed += 1;
        if (callBudget.used >= callBudget.limit) {
          for (const unprocessed of claims.slice(index + 1)) {
            heartbeatStops.get(unprocessed.leaseToken)?.();
            releaseProviderSyncClaim(unprocessed);
          }
          break;
        }
        // This row needs more effect capacity than remains (for example a
        // large legacy duplicate set). Its explicit deferred result keeps the
        // job truthful while later independent claims can still make progress.
        continue;
      }
      providerSyncMetrics.failed += 1;
      for (const unprocessed of claims.slice(index + 1)) {
        heartbeatStops.get(unprocessed.leaseToken)?.();
        releaseProviderSyncClaim(unprocessed);
      }
      throw error;
    }
  }
  logger.info({
    event: 'secretary_agenda_provider_sync.batch',
    providerSource: adapter.source,
    attempted: dependencyBatch.results.length + claims.length,
    adapterCalls: dependencyBatch.callsUsed + callBudget.used,
    succeeded: results.filter((entry) => entry.action !== 'failed').length,
    failed: results.filter((entry) => entry.action === 'failed').length,
    deadLetter: backlog.deadLetter,
    backlogEligible: backlog.eligible,
    backlogOldestAgeMs: backlog.oldestAgeMs,
  }, 'Secretary agenda provider sync bounded batch completed');
  if (backlog.deadLetter > 0) {
    throw providerSyncDeadLetterBacklogError(backlog.deadLetter);
  }
  return results;
}

function normalizeProviderSyncMaxItems(value: number | undefined): number {
  if (value == null) return DEFAULT_PROVIDER_SYNC_MAX_ITEMS;
  if (!Number.isFinite(value)) return DEFAULT_PROVIDER_SYNC_MAX_ITEMS;
  return Math.max(0, Math.min(DEFAULT_PROVIDER_SYNC_MAX_ITEMS, Math.floor(value)));
}

function isTerminalDeletedCleanupRow(item: SecretaryAgendaItem): boolean {
  return CLEANUP_PROVIDER_STATES.has(item.lifecycleState)
    && item.providerSyncState === 'deleted'
    && !item.providerEventId;
}

function providerSyncEligibilitySql(includeInactive: boolean): string {
  const preemptionFenceClause = secretaryAgendaPreemptionSchemaReady() ? `
    AND NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_preemption_operations AS operation
       WHERE operation.owner_user_id = agenda.owner_user_id
         AND operation.tenant_id = agenda.tenant_id
         AND operation.winner_agenda_item_id = agenda.agenda_item_id
         AND operation.winner_agenda_version = agenda.version
         AND (
           operation.state NOT IN ('winner_ready', 'winner_reconcile', 'completed')
           OR EXISTS (
             SELECT 1
               FROM secretary_agenda_preemption_dependencies AS dependency
              WHERE dependency.operation_id = operation.operation_id
                AND dependency.state <> 'satisfied'
           )
         )
    )
  ` : '';
  const pendingEffectClause = `(
    EXISTS (
      SELECT 1
        FROM secretary_agenda_provider_create_reconciliation AS attempt
       WHERE attempt.owner_user_id = agenda.owner_user_id
         AND attempt.tenant_id = agenda.tenant_id
         AND attempt.provider_source = @providerSource
         AND attempt.source_skill = agenda.source_skill
         AND attempt.source_intent_id = agenda.source_intent_id
         AND attempt.resolution_state IN ('in_flight', 'unknown', 'known')
    )
    OR EXISTS (
      SELECT 1
        FROM secretary_agenda_provider_effect_recovery AS recovery
       WHERE recovery.owner_user_id = agenda.owner_user_id
         AND recovery.tenant_id = agenda.tenant_id
         AND recovery.provider_source = @providerSource
         AND recovery.source_skill = agenda.source_skill
         AND recovery.source_intent_id = agenda.source_intent_id
         AND recovery.resolution_state = 'pending'
    )
  )`;
  const inactiveClause = includeInactive
    ? '1 = 1'
    : `(
        agenda.lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
        OR (
          agenda.lifecycle_state IN ('canceled', 'superseded')
          AND agenda.provider_event_id IS NOT NULL
          AND agenda.provider_sync_state <> 'deleted'
        )
        OR ${pendingEffectClause}
      )`;
  const intervalMinutes = syncVerifyIntervalMinutes();
  const freshClause = intervalMinutes === 0
    ? '1 = 1'
    : `NOT (
      agenda.provider_sync_state = 'synced'
      AND agenda.provider_event_id IS NOT NULL
      AND agenda.lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
        AND agenda.last_synced_fingerprint = (
          @providerSource || '|' || agenda.source_shape_hash || '|'
          || COALESCE(agenda.start_at, '') || '|' || COALESCE(agenda.end_at, '')
          || '|' || CAST(agenda.version AS TEXT)
        )
        AND datetime(agenda.last_synced_verified_at) > datetime(@freshCutoff)
      )`;
  return `
    agenda.owner_user_id = @ownerUserId
    AND agenda.tenant_id = @tenantId
    AND (@agendaItemId IS NULL OR agenda.agenda_item_id = @agendaItemId)
    AND agenda.provider_target = @providerSource
    AND (agenda.provider_source IS NULL OR agenda.provider_source = @providerSource)
    AND COALESCE(agenda.provider_sync_failure_disposition, '') <> 'terminal'
    ${preemptionFenceClause}
    AND (
      agenda.provider_sync_retry_after_at IS NULL
      OR datetime(agenda.provider_sync_retry_after_at) <= datetime(@now)
    )
    AND ${inactiveClause}
    AND NOT (
      agenda.lifecycle_state IN ('canceled', 'superseded', 'unscheduled', 'deferred')
      AND agenda.provider_sync_state = 'deleted'
      AND agenda.provider_event_id IS NULL
      AND NOT ${pendingEffectClause}
    )
    AND (${pendingEffectClause} OR ${freshClause})
  `;
}

function providerSyncQueryParams(
  scope: SecretaryAgendaProviderSyncScope,
  providerSource: SecretaryCalendarProviderSource,
  now: Date,
  agendaItemId?: string,
): Record<string, string | number | null> {
  return {
    ownerUserId: scope.ownerUserId,
    tenantId: String(scope.tenantId),
    providerSource,
    agendaItemId: agendaItemId?.trim() || null,
    now: now.toISOString(),
    freshCutoff: new Date(now.getTime() - syncVerifyIntervalMinutes() * 60_000).toISOString(),
  };
}

function readProviderSyncBacklogStats(
  scope: SecretaryAgendaProviderSyncScope,
  providerSource: SecretaryCalendarProviderSource,
  includeInactive: boolean,
  agendaItemId?: string,
): { eligible: number; deadLetter: number; oldestAgeMs: number } {
  const now = new Date();
  const row = getDb().prepare(`
    SELECT
      SUM(CASE
        WHEN NOT (
          agenda.provider_sync_state = 'delete_failed'
          AND COALESCE(agenda.provider_sync_failure_count, 0) >= ${PROVIDER_SYNC_DEAD_LETTER_THRESHOLD}
        ) THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE
        WHEN agenda.provider_sync_state = 'delete_failed'
         AND COALESCE(agenda.provider_sync_failure_count, 0) >= ${PROVIDER_SYNC_DEAD_LETTER_THRESHOLD}
        THEN 1 ELSE 0 END) AS dead_letter,
      MIN(COALESCE(agenda.created_at, agenda.updated_at)) AS oldest_at
    FROM secretary_agenda_items AS agenda
    WHERE ${providerSyncEligibilitySql(includeInactive)}
  `).get(providerSyncQueryParams(scope, providerSource, now, agendaItemId)) as {
    eligible?: number | null;
    dead_letter?: number | null;
    oldest_at?: string | null;
  } | undefined;
  const oldestAtMs = row?.oldest_at ? Date.parse(row.oldest_at) : NaN;
  const preemptionTerminal = secretaryAgendaPreemptionSchemaReady() ? getDb().prepare(`
    SELECT COUNT(*) AS count, MIN(dependency.updated_at) AS oldest_at
      FROM secretary_agenda_preemption_dependencies AS dependency
      JOIN secretary_agenda_preemption_operations AS operation
        ON operation.operation_id = dependency.operation_id
       AND operation.owner_user_id = dependency.owner_user_id
       AND operation.tenant_id = dependency.tenant_id
     WHERE dependency.owner_user_id = ? AND dependency.tenant_id = ?
       AND dependency.loser_provider_source = ?
       AND dependency.state = 'terminal'
       AND operation.state = 'terminal_failure'
  `).get(
    scope.ownerUserId,
    String(scope.tenantId),
    providerSource,
  ) as { count?: number | null; oldest_at?: string | null } : null;
  const preemptionOldestMs = preemptionTerminal?.oldest_at
    ? Date.parse(preemptionTerminal.oldest_at)
    : NaN;
  const oldestCandidates = [oldestAtMs, preemptionOldestMs].filter(Number.isFinite);
  return {
    eligible: Math.max(0, Number(row?.eligible ?? 0)),
    deadLetter: Math.max(0, Number(row?.dead_letter ?? 0))
      + Math.max(0, Number(preemptionTerminal?.count ?? 0)),
    oldestAgeMs: oldestCandidates.length > 0
      ? Math.max(0, now.getTime() - Math.min(...oldestCandidates))
      : 0,
  };
}

function claimSecretaryAgendaProviderSyncBatch(
  scope: SecretaryAgendaProviderSyncScope,
  providerSource: SecretaryCalendarProviderSource,
  includeInactive: boolean,
  maxItems: number,
  options: SecretaryAgendaProviderSyncOptions,
): SecretaryAgendaProviderSyncClaim[] {
  const db = getDb();
  const leaseDurationMs = normalizeProviderSyncLeaseMs(options.leaseDurationMs);
  const cleanupOnlySelect = secretaryAgendaPreemptionSchemaReady(db) ? `
    CASE WHEN EXISTS (
      SELECT 1 FROM secretary_agenda_preemption_operations AS operation
       WHERE operation.owner_user_id = agenda.owner_user_id
         AND operation.tenant_id = agenda.tenant_id
         AND operation.cancel_requested_at IS NOT NULL
         AND (
           (
             operation.winner_agenda_item_id = agenda.agenda_item_id
             AND operation.winner_agenda_version = agenda.version
             AND operation.state IN ('winner_ready', 'winner_reconcile')
             AND agenda.lifecycle_state = 'canceled'
           )
           OR (
             operation.prior_winner_agenda_item_id = agenda.agenda_item_id
             AND operation.prior_winner_agenda_version = agenda.version
             AND operation.prior_winner_provider_source = agenda.provider_source
             AND operation.prior_winner_provider_event_id = agenda.provider_event_id
             AND operation.state IN ('cleanup_pending', 'cleanup_blocked', 'winner_ready', 'winner_reconcile')
             AND agenda.lifecycle_state = 'superseded'
             AND NOT EXISTS (
               SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
                WHERE dependency.operation_id = operation.operation_id
                  AND dependency.state <> 'satisfied'
             )
           )
         )
    ) THEN 1 ELSE 0 END
  ` : '0';
  const claimBatch = db.transaction(() => {
    const now = new Date();
    const params = providerSyncQueryParams(scope, providerSource, now, options.agendaItemId);
    const candidates = db.prepare(`
      SELECT agenda.agenda_item_id AS agenda_item_id,
             agenda.version AS agenda_version,
             agenda.source_skill AS source_skill,
             agenda.source_intent_id AS source_intent_id,
             ${cleanupOnlySelect} AS cleanup_only,
             (@providerSource || '|' || agenda.source_shape_hash || '|'
               || COALESCE(agenda.start_at, '') || '|' || COALESCE(agenda.end_at, '')
               || '|' || CAST(agenda.version AS TEXT)) AS desired_fingerprint
      FROM secretary_agenda_items AS agenda
      WHERE ${providerSyncEligibilitySql(includeInactive)}
        AND (
          (${cleanupOnlySelect}) = 1
          OR NOT EXISTS (
          SELECT 1
            FROM secretary_agenda_items AS newer
           WHERE newer.owner_user_id = agenda.owner_user_id
             AND newer.tenant_id = agenda.tenant_id
             AND newer.source_skill = agenda.source_skill
             AND newer.source_intent_id = agenda.source_intent_id
             AND newer.version > agenda.version
          )
        )
        AND NOT (
          agenda.provider_sync_state = 'delete_failed'
          AND COALESCE(agenda.provider_sync_failure_count, 0) >= ${PROVIDER_SYNC_DEAD_LETTER_THRESHOLD}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM secretary_agenda_provider_sync_claims AS claim
          WHERE claim.owner_user_id = agenda.owner_user_id
            AND claim.tenant_id = agenda.tenant_id
            AND claim.provider_source = @providerSource
            AND claim.source_skill = agenda.source_skill
            AND claim.source_intent_id = agenda.source_intent_id
            AND claim.lease_expires_at > @now
        )
      ORDER BY CASE
                 WHEN (${cleanupOnlySelect}) = 1 AND agenda.provider_event_id IS NOT NULL THEN 0
                 WHEN (${cleanupOnlySelect}) = 1 THEN 1
                 ELSE 2
               END ASC,
               CASE
                 WHEN agenda.provider_sync_state IN (
                   'create_failed', 'update_failed', 'delete_failed', 'readback_failed'
                 ) THEN 1 ELSE 0
               END ASC,
               CASE
                 WHEN agenda.provider_sync_state IN (
                   'create_failed', 'update_failed', 'delete_failed', 'readback_failed'
                 ) THEN COALESCE(agenda.updated_at, agenda.created_at)
                 ELSE COALESCE(agenda.start_at, agenda.updated_at, agenda.created_at)
               END ASC,
               agenda.version ASC,
               agenda.agenda_item_id ASC
      LIMIT @maxItems
    `).all({ ...params, maxItems }) as Array<{
      agenda_item_id: string;
      agenda_version: number;
      source_skill: string;
      source_intent_id: string;
      cleanup_only: number;
      desired_fingerprint: string;
    }>;
    const claims: SecretaryAgendaProviderSyncClaim[] = [];
    for (const candidate of candidates) {
      const leaseToken = randomUUID();
      const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
      const write = db.prepare(`
        INSERT INTO secretary_agenda_provider_sync_claims (
          owner_user_id, tenant_id, provider_source, source_skill,
          source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
          lease_token, lease_expires_at, heartbeat_at,
          attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(
          owner_user_id, tenant_id, provider_source, source_skill, source_intent_id
        ) DO UPDATE SET
          agenda_item_id = excluded.agenda_item_id,
          agenda_version = excluded.agenda_version,
          desired_fingerprint = excluded.desired_fingerprint,
          lease_token = excluded.lease_token,
          lease_expires_at = excluded.lease_expires_at,
          heartbeat_at = excluded.heartbeat_at,
          attempt_count = secretary_agenda_provider_sync_claims.attempt_count + 1,
          updated_at = excluded.updated_at
        WHERE secretary_agenda_provider_sync_claims.lease_expires_at <= excluded.updated_at
      `).run(
        scope.ownerUserId,
        String(scope.tenantId),
        providerSource,
        candidate.source_skill,
        candidate.source_intent_id,
        candidate.agenda_item_id,
        candidate.agenda_version,
        candidate.desired_fingerprint,
        leaseToken,
        expiresAt,
        now.toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
      if (write.changes !== 1) continue;
      claims.push({
        agendaItemId: candidate.agenda_item_id,
        ownerUserId: scope.ownerUserId,
        tenantId: String(scope.tenantId),
        providerSource,
        sourceSkill: candidate.source_skill,
        sourceIntentId: candidate.source_intent_id,
        agendaVersion: Number(candidate.agenda_version),
        desiredFingerprint: candidate.desired_fingerprint,
        leaseToken,
        leaseDurationMs,
        cleanupOnly: Number(candidate.cleanup_only) === 1,
        lost: false,
      });
    }
    return claims;
  });
  return claimBatch();
}

function normalizeProviderSyncLeaseMs(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_PROVIDER_SYNC_LEASE_MS;
  return Math.max(25, Math.min(60 * 60_000, Math.floor(value)));
}

function normalizeProviderSyncHeartbeatMs(
  value: number | undefined,
  leaseDurationMs: number,
): number {
  const fallback = Math.min(DEFAULT_PROVIDER_SYNC_HEARTBEAT_MS, Math.max(5, Math.floor(leaseDurationMs / 3)));
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(5, Math.min(Math.max(5, leaseDurationMs - 5), Math.floor(value)));
}

async function withSecretaryAgendaProviderSyncClaim<T>(
  claim: SecretaryAgendaProviderSyncClaim,
  callBudget: SecretaryAgendaProviderCallBudget,
  stopHeartbeat: (() => void) | undefined,
  operation: (execution: SecretaryAgendaProviderSyncExecution) => Promise<T>,
): Promise<T> {
  const execution: SecretaryAgendaProviderSyncExecution = {
    claim,
    callBudget,
    assertActive: () => assertProviderSyncClaimActive(claim),
  };
  execution.assertActive();
  try {
    return await operation(execution);
  } finally {
    stopHeartbeat?.();
    releaseProviderSyncClaim(claim);
    finalizeSecretaryPreemptionCancellationsAfterAgendaCleanup({
      agendaItemId: claim.agendaItemId,
      agendaVersion: claim.agendaVersion,
      ownerUserId: claim.ownerUserId,
      tenantId: claim.tenantId,
    });
  }
}

function startProviderSyncClaimHeartbeat(
  claim: SecretaryAgendaProviderSyncClaim,
  options: SecretaryAgendaProviderSyncOptions,
): () => void {
  const heartbeatMs = normalizeProviderSyncHeartbeatMs(options.heartbeatIntervalMs, claim.leaseDurationMs);
  const heartbeat = setInterval(() => {
    try {
      if (!renewProviderSyncClaim(claim)) claim.lost = true;
    } catch {
      claim.lost = true;
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

function renewProviderSyncClaim(claim: SecretaryAgendaProviderSyncClaim): boolean {
  if (claim.lost) return false;
  const now = new Date();
  const nowIso = now.toISOString();
  const result = getDb().prepare(`
    UPDATE secretary_agenda_provider_sync_claims
       SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND provider_source = ?
       AND source_skill = ?
       AND source_intent_id = ?
       AND agenda_item_id = ?
       AND agenda_version = ?
       AND desired_fingerprint = ?
       AND lease_token = ?
       AND lease_expires_at > ?
  `).run(
    nowIso,
    new Date(now.getTime() + claim.leaseDurationMs).toISOString(),
    nowIso,
    claim.ownerUserId,
    claim.tenantId,
    claim.providerSource,
    claim.sourceSkill,
    claim.sourceIntentId,
    claim.agendaItemId,
    claim.agendaVersion,
    claim.desiredFingerprint,
    claim.leaseToken,
    nowIso,
  );
  return result.changes === 1;
}

function assertProviderSyncClaimActive(claim: SecretaryAgendaProviderSyncClaim): void {
  if (claim.lost) throw providerSyncLeaseLostError(claim);
  const row = getDb().prepare(`
    SELECT 1
    FROM secretary_agenda_provider_sync_claims AS claim
    JOIN secretary_agenda_items AS agenda
      ON agenda.agenda_item_id = claim.agenda_item_id
     AND agenda.owner_user_id = claim.owner_user_id
     AND agenda.tenant_id = claim.tenant_id
     AND agenda.version = claim.agenda_version
     AND agenda.source_skill = claim.source_skill
     AND agenda.source_intent_id = claim.source_intent_id
     AND agenda.provider_target = claim.provider_source
    WHERE claim.owner_user_id = ?
      AND claim.tenant_id = ?
      AND claim.provider_source = ?
      AND claim.source_skill = ?
      AND claim.source_intent_id = ?
      AND claim.agenda_item_id = ?
      AND claim.agenda_version = ?
      AND claim.desired_fingerprint = ?
      AND claim.lease_token = ?
      AND claim.lease_expires_at > ?
      AND claim.desired_fingerprint = (
        claim.provider_source || '|' || agenda.source_shape_hash || '|'
        || COALESCE(agenda.start_at, '') || '|' || COALESCE(agenda.end_at, '')
        || '|' || CAST(agenda.version AS TEXT)
      )
      AND (? = 1 OR NOT EXISTS (
        SELECT 1
          FROM secretary_agenda_items AS newer
         WHERE newer.owner_user_id = agenda.owner_user_id
           AND newer.tenant_id = agenda.tenant_id
           AND newer.source_skill = agenda.source_skill
           AND newer.source_intent_id = agenda.source_intent_id
           AND newer.version > agenda.version
      ))
  `).get(
    claim.ownerUserId,
    claim.tenantId,
    claim.providerSource,
    claim.sourceSkill,
    claim.sourceIntentId,
    claim.agendaItemId,
    claim.agendaVersion,
    claim.desiredFingerprint,
    claim.leaseToken,
    new Date().toISOString(),
    claim.cleanupOnly ? 1 : 0,
  );
  const cancellation = secretaryAgendaPreemptionSchemaReady() ? getDb().prepare(`
    SELECT 1 AS cancel_requested, agenda.lifecycle_state AS lifecycle_state
      FROM secretary_agenda_preemption_operations AS operation
      JOIN secretary_agenda_items AS agenda
        ON agenda.owner_user_id = operation.owner_user_id
       AND agenda.tenant_id = operation.tenant_id
       AND (
         (agenda.agenda_item_id = operation.winner_agenda_item_id
          AND agenda.version = operation.winner_agenda_version)
         OR (agenda.agenda_item_id = operation.prior_winner_agenda_item_id
          AND agenda.version = operation.prior_winner_agenda_version)
       )
     WHERE operation.owner_user_id = ? AND operation.tenant_id = ?
       AND operation.cancel_requested_at IS NOT NULL
       AND agenda.agenda_item_id = ? AND agenda.version = ?
       AND (
         (
           operation.winner_agenda_item_id = agenda.agenda_item_id
           AND operation.winner_agenda_version = agenda.version
           AND operation.state IN ('winner_ready', 'winner_reconcile')
           AND agenda.lifecycle_state = 'canceled'
         )
         OR (
           operation.prior_winner_agenda_item_id = agenda.agenda_item_id
           AND operation.prior_winner_agenda_version = agenda.version
           AND operation.prior_winner_provider_source = agenda.provider_source
           AND operation.prior_winner_provider_event_id = agenda.provider_event_id
           AND operation.state IN ('cleanup_pending', 'cleanup_blocked', 'winner_ready', 'winner_reconcile')
           AND agenda.lifecycle_state = 'superseded'
           AND NOT EXISTS (
             SELECT 1 FROM secretary_agenda_preemption_dependencies AS dependency
              WHERE dependency.operation_id = operation.operation_id
                AND dependency.state <> 'satisfied'
           )
         )
       )
  `).get(
    claim.ownerUserId,
    claim.tenantId,
    claim.agendaItemId,
    claim.agendaVersion,
  ) as { cancel_requested: number; lifecycle_state: string } | undefined : undefined;
  const cancellationModeMatches = !cancellation
    ? !claim.cleanupOnly
    : (claim.cleanupOnly
      ? Boolean(cancellation.cancel_requested)
        && (cancellation.lifecycle_state === 'canceled' || cancellation.lifecycle_state === 'superseded')
      : !Boolean(cancellation.cancel_requested));
  if (!row || !cancellationModeMatches || hasUnresolvedSecretaryPreemptionDependencies({
    agendaItemId: claim.agendaItemId,
    agendaVersion: claim.agendaVersion,
    ownerUserId: claim.ownerUserId,
    tenantId: claim.tenantId,
  })) {
    claim.lost = true;
    throw providerSyncLeaseLostError(claim);
  }
}

function releaseProviderSyncClaim(claim: SecretaryAgendaProviderSyncClaim): void {
  try {
    getDb().prepare(`
      DELETE FROM secretary_agenda_provider_sync_claims
      WHERE owner_user_id = ?
        AND tenant_id = ?
        AND provider_source = ?
        AND source_skill = ?
        AND source_intent_id = ?
        AND lease_token = ?
    `).run(
      claim.ownerUserId,
      claim.tenantId,
      claim.providerSource,
      claim.sourceSkill,
      claim.sourceIntentId,
      claim.leaseToken,
    );
  } catch {
    // Lease expiry is the recovery path if shutdown races cleanup.
  }
}

function providerSyncLeaseLostError(_claim: SecretaryAgendaProviderSyncClaim): Error {
  const error = new Error('SECRETARY_PROVIDER_SYNC_LEASE_LOST');
  return Object.assign(error, { code: 'SECRETARY_PROVIDER_SYNC_LEASE_LOST' });
}

function providerSyncDeadLetterBacklogError(deadLetterCount: number): Error {
  const error = new Error('SECRETARY_PROVIDER_SYNC_DEAD_LETTER_BACKLOG');
  return Object.assign(error, {
    code: 'SECRETARY_PROVIDER_SYNC_DEAD_LETTER_BACKLOG',
    deadLetterCount,
  });
}

function isProviderSyncLeaseLostError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SECRETARY_PROVIDER_SYNC_LEASE_LOST'
    || (error instanceof Error && error.message === 'SECRETARY_PROVIDER_SYNC_LEASE_LOST');
}

async function syncSecretaryAgendaItemToProviderWithRetry(
  scope: {
    agendaItemId: string;
    ownerUserId: number;
    tenantId: string | number;
  },
  adapter: SecretaryAgendaProviderAdapter,
  options: SecretaryAgendaProviderSyncOptions,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryAgendaProviderSyncResult> {
  const retryBudget = Math.max(0, options.retryBudget ?? DEFAULT_PROVIDER_RETRY_BUDGET);
  let attempt = 0;
  let latest = await syncSecretaryAgendaItemToProvider(scope, adapter, execution);
  while (isRetryableProviderSyncResult(latest) && attempt < retryBudget) {
    // Preserve the last truthful failed result when this batch has no call
    // capacity left. Starting another pass would throw before discovery and
    // make the already-attempted item disappear from the batch outcome.
    if (execution && execution.callBudget.used >= execution.callBudget.limit) break;
    execution?.assertActive();
    const delayMs = providerRetryDelayMs(latest.retryAfterMs, attempt, options);
    logger.warn({
      agendaItemId: latest.agendaItemId,
      providerSource: latest.providerSource,
      providerSyncState: latest.providerSyncState,
      attempt: attempt + 1,
      retryBudget,
      delayMs,
    }, 'Secretary agenda provider sync retrying after transient failure');
    await sleep(delayMs);
    execution?.assertActive();
    try {
      latest = await syncSecretaryAgendaItemToProvider(scope, adapter, execution);
    } catch (error) {
      // The previous attempt already produced a truthful durable failure. If
      // the remaining batch capacity cannot fund a complete retry, preserve
      // that result instead of making it disappear from scheduler accounting.
      if (isProviderCallBudgetExhaustedError(error)) return latest;
      throw error;
    }
    attempt += 1;
  }
  return latest;
}

async function createProviderEventWithRecovery(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  desiredFingerprint: string,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<{
  event: SecretaryProviderEvent;
  recovery: SecretaryAgendaProviderEffectRecovery;
  attemptId: string;
}> {
  execution?.assertActive();
  ensureProviderCallCapacity(execution, 1);
  const attemptId = persistProviderCreateAttempt(
    agendaItem,
    adapter.source,
    desiredFingerprint,
    execution,
  );
  try {
    // The INSERT above closes the assert-to-write race. Re-check before the
    // external call as well: if ownership changes after the durable fence is
    // visible, this worker performs no effect and resolves its own attempt.
    execution?.assertActive();
  } catch (error) {
    tryMarkProviderCreateAttemptState(attemptId, 'no_effect');
    throw error;
  }
  reserveProviderCallCapacity(execution, 1);
  let event: SecretaryProviderEvent;
  try {
    event = await adapter.createEvent(input);
  } catch (error) {
    if (isUnknownProviderCreateOutcome(error)) {
      tryMarkProviderCreateAttemptState(attemptId, 'unknown');
      throw unknownProviderCreateOutcomeError();
    }
    tryMarkProviderCreateAttemptState(attemptId, 'no_effect');
    execution?.assertActive();
    throw error;
  }

  // Persist the exact known external id before any post-effect authority
  // check or mapping write. This row survives an injected local transaction
  // failure and gives the next owner deterministic adoption/deletion work.
  let recovery: SecretaryAgendaProviderEffectRecovery;
  try {
    recovery = persistKnownProviderCreate(
      agendaItem,
      adapter.source,
      desiredFingerprint,
      event.eventId,
      attemptId,
    );
  } catch (error) {
    // The pre-effect row deliberately remains `in_flight`. Even if SQLite
    // rejects the exact-id handoff after the provider accepted the create, a
    // replacement worker is forced into marker reconciliation and cannot
    // issue another create.
    logger.warn({
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
    }, 'Secretary provider create exact-id handoff failed; pre-effect fence retained');
    throw unknownProviderCreateOutcomeError();
  }
  try {
    execution?.assertActive();
  } catch (error) {
    await compensateKnownProviderCreate(agendaItem, adapter, input, recovery, execution, attemptId);
    throw error;
  }
  return { event, recovery, attemptId };
}

function persistProviderCreateAttempt(
  agendaItem: SecretaryAgendaItem,
  providerSource: SecretaryCalendarProviderSource,
  desiredFingerprint: string,
  execution?: SecretaryAgendaProviderSyncExecution,
): string {
  const attemptId = randomUUID();
  const nowIso = new Date().toISOString();
  // This durable write is intentionally before the external create. A failed
  // insert aborts the operation before any provider call can escape.
  if (!execution) {
    getDb().prepare(`
      INSERT INTO secretary_agenda_provider_create_reconciliation (
        attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, resolution_state, first_observed_at,
        last_checked_at, resolved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'in_flight', ?, NULL, NULL, ?)
    `).run(
      attemptId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      providerSource,
      agendaItem.sourceSkill,
      agendaItem.sourceIntentId,
      agendaItem.agendaItemId,
      agendaItem.version,
      desiredFingerprint,
      nowIso,
      nowIso,
    );
    return attemptId;
  }

  const claim = execution.claim;
  const write = getDb().prepare(`
    INSERT INTO secretary_agenda_provider_create_reconciliation (
      attempt_id, owner_user_id, tenant_id, provider_source, source_skill,
      source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
      provider_event_id, resolution_state, first_observed_at,
      last_checked_at, resolved_at, updated_at
    )
    SELECT @attemptId, claim.owner_user_id, claim.tenant_id,
           claim.provider_source, claim.source_skill, claim.source_intent_id,
           claim.agenda_item_id, claim.agenda_version, claim.desired_fingerprint,
           NULL, 'in_flight', @now, NULL, NULL, @now
      FROM secretary_agenda_provider_sync_claims AS claim
      JOIN secretary_agenda_items AS agenda
        ON agenda.agenda_item_id = claim.agenda_item_id
       AND agenda.owner_user_id = claim.owner_user_id
       AND agenda.tenant_id = claim.tenant_id
       AND agenda.version = claim.agenda_version
       AND agenda.source_skill = claim.source_skill
       AND agenda.source_intent_id = claim.source_intent_id
       AND agenda.provider_target = claim.provider_source
     WHERE claim.owner_user_id = @ownerUserId
       AND claim.tenant_id = @tenantId
       AND claim.provider_source = @providerSource
       AND claim.source_skill = @sourceSkill
       AND claim.source_intent_id = @sourceIntentId
       AND claim.agenda_item_id = @agendaItemId
       AND claim.agenda_version = @agendaVersion
       AND claim.desired_fingerprint = @desiredFingerprint
       AND claim.lease_token = @leaseToken
       AND claim.lease_expires_at > @now
      AND claim.desired_fingerprint = (
         claim.provider_source || '|' || agenda.source_shape_hash || '|'
         || COALESCE(agenda.start_at, '') || '|' || COALESCE(agenda.end_at, '')
         || '|' || CAST(agenda.version AS TEXT)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM secretary_agenda_items AS newer
          WHERE newer.owner_user_id = agenda.owner_user_id
            AND newer.tenant_id = agenda.tenant_id
            AND newer.source_skill = agenda.source_skill
            AND newer.source_intent_id = agenda.source_intent_id
            AND newer.version > agenda.version
       )
  `).run({
    attemptId,
    ownerUserId: claim.ownerUserId,
    tenantId: claim.tenantId,
    providerSource: claim.providerSource,
    sourceSkill: claim.sourceSkill,
    sourceIntentId: claim.sourceIntentId,
    agendaItemId: claim.agendaItemId,
    agendaVersion: claim.agendaVersion,
    desiredFingerprint: claim.desiredFingerprint,
    leaseToken: claim.leaseToken,
    now: nowIso,
  });
  if (write.changes !== 1) {
    claim.lost = true;
    throw providerSyncLeaseLostError(claim);
  }
  return attemptId;
}

function tryMarkProviderCreateAttemptState(
  attemptId: string,
  resolutionState: 'unknown' | 'no_effect',
): void {
  try {
    const nowIso = new Date().toISOString();
    getDb().prepare(`
      UPDATE secretary_agenda_provider_create_reconciliation
         SET resolution_state = ?,
             resolved_at = CASE WHEN ? = 'no_effect' THEN ? ELSE NULL END,
             updated_at = ?
       WHERE attempt_id = ?
         AND resolution_state = 'in_flight'
    `).run(resolutionState, resolutionState, nowIso, nowIso, attemptId);
  } catch {
    // `in_flight` is already the conservative no-create state. A follow-up
    // metadata write failure must never erase that pre-effect safety fence.
  }
}

function persistKnownProviderCreate(
  agendaItem: SecretaryAgendaItem,
  providerSource: SecretaryCalendarProviderSource,
  desiredFingerprint: string,
  providerEventId: string,
  attemptId: string,
): SecretaryAgendaProviderEffectRecovery {
  const recoveryId = randomUUID();
  const nowIso = new Date().toISOString();
  const db = getDb();
  const attach = db.transaction(() => {
    const attemptWrite = db.prepare(`
      UPDATE secretary_agenda_provider_create_reconciliation
         SET provider_event_id = ?, resolution_state = 'known', updated_at = ?
       WHERE attempt_id = ?
         AND owner_user_id = ? AND tenant_id = ? AND provider_source = ?
         AND resolution_state IN ('in_flight', 'unknown')
    `).run(
      providerEventId,
      nowIso,
      attemptId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      providerSource,
    );
    if (attemptWrite.changes !== 1) throw new Error('SECRETARY_PROVIDER_CREATE_ATTEMPT_HANDOFF_MISSED');
    db.prepare(`
      INSERT OR IGNORE INTO secretary_agenda_provider_effect_recovery (
        recovery_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, effect_kind, resolution_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'create', 'pending', ?, ?)
    `).run(
      recoveryId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      providerSource,
      agendaItem.sourceSkill,
      agendaItem.sourceIntentId,
      agendaItem.agendaItemId,
      agendaItem.version,
      desiredFingerprint,
      providerEventId,
      nowIso,
      nowIso,
    );
  });
  attach();
  const row = db.prepare(`
    SELECT recovery_id AS recovery_id
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ? AND tenant_id = ?
       AND provider_source = ? AND provider_event_id = ?
       AND agenda_item_id = ? AND agenda_version = ?
       AND effect_kind = 'create' AND resolution_state = 'pending'
  `).get(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    providerSource,
    providerEventId,
    agendaItem.agendaItemId,
    agendaItem.version,
  ) as { recovery_id: string } | undefined;
  if (!row) throw new Error('SECRETARY_PROVIDER_CREATE_RECOVERY_HANDOFF_MISSED');
  return {
    recoveryId: row.recovery_id,
    agendaItemId: agendaItem.agendaItemId,
    agendaVersion: agendaItem.version,
    desiredFingerprint,
    providerEventId,
    effectKind: 'create',
  };
}

function persistPendingProviderMutation(
  agendaItem: SecretaryAgendaItem,
  providerSource: SecretaryCalendarProviderSource,
  desiredFingerprint: string,
  providerEventId: string,
  effectKind: 'update' | 'adopt',
  execution?: SecretaryAgendaProviderSyncExecution,
): SecretaryAgendaProviderEffectRecovery {
  execution?.assertActive();
  const recoveryId = randomUUID();
  const nowIso = new Date().toISOString();
  const db = getDb();
  if (!execution) {
    db.prepare(`
      INSERT OR IGNORE INTO secretary_agenda_provider_effect_recovery (
        recovery_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, effect_kind, resolution_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      recoveryId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      providerSource,
      agendaItem.sourceSkill,
      agendaItem.sourceIntentId,
      agendaItem.agendaItemId,
      agendaItem.version,
      desiredFingerprint,
      providerEventId,
      effectKind,
      nowIso,
      nowIso,
    );
  } else {
    const claim = execution.claim;
    db.prepare(`
      INSERT OR IGNORE INTO secretary_agenda_provider_effect_recovery (
        recovery_id, owner_user_id, tenant_id, provider_source, source_skill,
        source_intent_id, agenda_item_id, agenda_version, desired_fingerprint,
        provider_event_id, effect_kind, resolution_state, created_at, updated_at
      )
      SELECT @recoveryId, claim.owner_user_id, claim.tenant_id,
             claim.provider_source, claim.source_skill, claim.source_intent_id,
             claim.agenda_item_id, claim.agenda_version, claim.desired_fingerprint,
             @providerEventId, @effectKind, 'pending', @now, @now
        FROM secretary_agenda_provider_sync_claims AS claim
        JOIN secretary_agenda_items AS agenda
          ON agenda.agenda_item_id = claim.agenda_item_id
         AND agenda.owner_user_id = claim.owner_user_id
         AND agenda.tenant_id = claim.tenant_id
         AND agenda.version = claim.agenda_version
         AND agenda.source_skill = claim.source_skill
         AND agenda.source_intent_id = claim.source_intent_id
         AND agenda.provider_target = claim.provider_source
       WHERE claim.owner_user_id = @ownerUserId
         AND claim.tenant_id = @tenantId
         AND claim.provider_source = @providerSource
         AND claim.source_skill = @sourceSkill
         AND claim.source_intent_id = @sourceIntentId
         AND claim.agenda_item_id = @agendaItemId
         AND claim.agenda_version = @agendaVersion
         AND claim.desired_fingerprint = @desiredFingerprint
         AND claim.lease_token = @leaseToken
         AND claim.lease_expires_at > @now
         AND claim.desired_fingerprint = (
           claim.provider_source || '|' || agenda.source_shape_hash || '|'
           || COALESCE(agenda.start_at, '') || '|' || COALESCE(agenda.end_at, '')
           || '|' || CAST(agenda.version AS TEXT)
         )
         AND NOT EXISTS (
           SELECT 1 FROM secretary_agenda_items AS newer
            WHERE newer.owner_user_id = agenda.owner_user_id
              AND newer.tenant_id = agenda.tenant_id
              AND newer.source_skill = agenda.source_skill
              AND newer.source_intent_id = agenda.source_intent_id
              AND newer.version > agenda.version
         )
    `).run({
      recoveryId,
      providerEventId,
      effectKind,
      now: nowIso,
      ownerUserId: claim.ownerUserId,
      tenantId: claim.tenantId,
      providerSource: claim.providerSource,
      sourceSkill: claim.sourceSkill,
      sourceIntentId: claim.sourceIntentId,
      agendaItemId: claim.agendaItemId,
      agendaVersion: claim.agendaVersion,
      desiredFingerprint: claim.desiredFingerprint,
      leaseToken: claim.leaseToken,
    });
  }
  const row = db.prepare(`
    SELECT recovery_id
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
       AND source_skill = ? AND source_intent_id = ?
       AND agenda_item_id = ? AND agenda_version = ?
       AND desired_fingerprint = ? AND provider_event_id = ?
       AND effect_kind = ? AND resolution_state = 'pending'
     ORDER BY created_at ASC, recovery_id ASC
     LIMIT 1
  `).get(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    providerSource,
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
    agendaItem.agendaItemId,
    agendaItem.version,
    desiredFingerprint,
    providerEventId,
    effectKind,
  ) as { recovery_id: string } | undefined;
  if (!row) {
    if (execution) execution.claim.lost = true;
    throw execution
      ? providerSyncLeaseLostError(execution.claim)
      : new Error('SECRETARY_PROVIDER_MUTATION_RECOVERY_HANDOFF_MISSED');
  }
  return {
    recoveryId: row.recovery_id,
    agendaItemId: agendaItem.agendaItemId,
    agendaVersion: agendaItem.version,
    desiredFingerprint,
    providerEventId,
    effectKind,
  };
}

async function updateProviderEventWithRecovery(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  desiredFingerprint: string,
  providerEventId: string,
  effectKind: 'update' | 'adopt',
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<{ event: SecretaryProviderEvent; recovery: SecretaryAgendaProviderEffectRecovery }> {
  const recovery = persistPendingProviderMutation(
    agendaItem,
    adapter.source,
    desiredFingerprint,
    providerEventId,
    effectKind,
    execution,
  );
  try {
    const event = await providerCall(execution, () => adapter.updateEvent(providerEventId, input));
    return { event, recovery };
  } catch (error) {
    if (isKnownNoEffectCreateFailure(error) || isProviderEventNotFoundError(error)) {
      markProviderEffectRecoveryResolved(recovery.recoveryId, 'no_effect');
    }
    throw error;
  }
}

async function compensateKnownProviderCreate(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  recovery: SecretaryAgendaProviderEffectRecovery,
  execution?: SecretaryAgendaProviderSyncExecution,
  attemptId?: string,
): Promise<boolean> {
  try {
    reserveProviderCallCapacity(execution, 1);
    await adapter.deleteEvent(recovery.providerEventId, input);
    markProviderEffectRecoveryResolved(recovery.recoveryId, 'deleted');
    if (attemptId) markProviderCreateAttemptsResolved([{ attemptId, resolutionState: 'deleted' }]);
    return true;
  } catch (error) {
    if (isProviderEventNotFoundError(error)) {
      markProviderEffectRecoveryResolved(recovery.recoveryId, 'deleted');
      if (attemptId) markProviderCreateAttemptsResolved([{ attemptId, resolutionState: 'deleted' }]);
      return true;
    }
    logger.warn({
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
    }, 'Secretary provider create compensation deferred to durable recovery');
    return false;
  }
}

function markProviderEffectRecoveryResolved(
  recoveryId: string,
  resolutionState: 'adopted' | 'deleted' | 'no_effect',
  db: ReturnType<typeof getDb> = getDb(),
): void {
  db.prepare(`
    UPDATE secretary_agenda_provider_effect_recovery
       SET resolution_state = ?, updated_at = ?
     WHERE recovery_id = ? AND resolution_state = 'pending'
  `).run(resolutionState, new Date().toISOString(), recoveryId);
}

async function reconcileKnownProviderCreateEffects(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  desiredFingerprint: string,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryAgendaProviderSyncResult | null> {
  const rows = getDb().prepare(`
    SELECT recovery_id, agenda_item_id, agenda_version, desired_fingerprint,
           provider_event_id, effect_kind
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND provider_source = ?
       AND source_skill = ?
       AND source_intent_id = ?
       AND resolution_state = 'pending'
     ORDER BY created_at ASC, recovery_id ASC
  `).all(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    adapter.source,
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
  ) as Array<{
    recovery_id: string;
    agenda_item_id: string;
    agenda_version: number;
    desired_fingerprint: string;
    provider_event_id: string;
    effect_kind: 'create' | 'update' | 'adopt';
  }>;
  if (rows.length === 0) return null;
  const input = toProviderEventInput(agendaItem);
  for (const row of rows) {
    const recovery: SecretaryAgendaProviderEffectRecovery = {
      recoveryId: row.recovery_id,
      agendaItemId: row.agenda_item_id,
      agendaVersion: Number(row.agenda_version),
      desiredFingerprint: row.desired_fingerprint,
      providerEventId: row.provider_event_id,
      effectKind: row.effect_kind,
    };
    if (agendaItem.providerEventId && agendaItem.providerEventId !== recovery.providerEventId) {
      const deleted = await compensateKnownProviderCreate(agendaItem, adapter, input, recovery, execution);
      if (!deleted) {
        updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
        return result(agendaItem, 'failed', recovery.providerEventId, adapter.source, 'readback_failed', [], 'provider_create_recovery_pending');
      }
      continue;
    }
    // Even when the desired fingerprint still matches, re-apply the exact
    // known event id before adopting it. A previous compensation may have
    // reached the provider but failed before its local recovery write.
    ensureProviderCallCapacity(execution, 1);
    try {
      const updated = await providerCall(execution, () => adapter.updateEvent(recovery.providerEventId, input));
      markProviderSyncSuccess(agendaItem, updated, desiredFingerprint, execution, {
        recoveryId: recovery.recoveryId,
        adoptedProviderEventId: updated.eventId,
      });
      return result(
        agendaItem,
        'attached',
        updated.eventId,
        updated.source,
        'synced',
        [],
        recovery.desiredFingerprint === desiredFingerprint
          ? 'known_provider_create_adopted'
          : 'known_provider_create_updated_and_adopted',
      );
    } catch (error) {
      if (isProviderSyncLeaseLostError(error) || isProviderCallBudgetExhaustedError(error)) throw error;
      if (isProviderEventNotFoundError(error)) {
        markProviderEffectRecoveryResolved(recovery.recoveryId, 'deleted');
        continue;
      }
      throw error;
    }
  }
  return null;
}

function readUnresolvedProviderCreateAttempts(
  agendaItem: SecretaryAgendaItem,
  providerSource: SecretaryCalendarProviderSource,
): SecretaryAgendaProviderCreateAttempt[] {
  const rows = getDb().prepare(`
    SELECT attempt_id, agenda_item_id, agenda_version, desired_fingerprint,
           provider_event_id, resolution_state
      FROM secretary_agenda_provider_create_reconciliation
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND provider_source = ?
       AND source_skill = ?
       AND source_intent_id = ?
       AND resolution_state IN ('in_flight', 'unknown', 'known')
     ORDER BY first_observed_at ASC, attempt_id ASC
  `).all(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    providerSource,
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
  ) as Array<{
    attempt_id: string;
    agenda_item_id: string;
    agenda_version: number;
    desired_fingerprint: string;
    provider_event_id: string | null;
    resolution_state: SecretaryAgendaProviderCreateAttemptState;
  }>;
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    agendaItemId: row.agenda_item_id,
    agendaVersion: Number(row.agenda_version),
    desiredFingerprint: row.desired_fingerprint,
    providerEventId: row.provider_event_id,
    resolutionState: row.resolution_state,
  }));
}

function hasPendingKnownProviderCreateEffects(
  agendaItem: SecretaryAgendaItem,
  providerSource: SecretaryCalendarProviderSource,
): boolean {
  return Boolean(getDb().prepare(`
    SELECT 1
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
       AND source_skill = ? AND source_intent_id = ?
       AND resolution_state = 'pending'
     LIMIT 1
  `).get(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    providerSource,
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
  ));
}

async function reconcileProviderCreateAttempts(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  desiredFingerprint: string,
  attempts: SecretaryAgendaProviderCreateAttempt[],
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryAgendaProviderSyncResult> {
  const currentInput = toProviderEventInput(agendaItem);
  const observations: SecretaryAgendaProviderCreateAttemptObservation[] = [];
  for (const attempt of attempts) {
    observations.push({
      attempt,
      events: await discoverProviderCreateAttemptEvents(
        agendaItem,
        attempt,
        adapter,
        currentInput,
        execution,
      ),
    });
  }
  const nowIso = new Date().toISOString();
  const markChecked = getDb().prepare(`
    UPDATE secretary_agenda_provider_create_reconciliation
       SET last_checked_at = ?, updated_at = ?
     WHERE attempt_id = ?
       AND resolution_state IN ('in_flight', 'unknown', 'known')
  `);
  const markAllChecked = getDb().transaction(() => {
    for (const attempt of attempts) markChecked.run(nowIso, nowIso, attempt.attemptId);
  });
  markAllChecked();

  // A missing marker remains ambiguous: provider list/search can be
  // eventually consistent. Discover every attempt first and perform no
  // provider mutation until all external outcomes are observable.
  if (observations.some((observation) => (
    observation.events.length === 0 && !observation.attempt.providerEventId
  ))) {
    updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
    return result(agendaItem, 'failed', null, adapter.source, 'readback_failed', [], 'provider_create_reconciliation_required');
  }

  persistObservedProviderCreateAttemptIds(observations);
  const observedEvents = uniqueProviderEvents(observations.flatMap((observation) => observation.events));
  const canonical = chooseCanonicalProviderEventForAttempts(agendaItem, observedEvents);
  if (!canonical) {
    updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
    return result(agendaItem, 'failed', null, adapter.source, 'readback_failed', [], 'provider_create_reconciliation_required');
  }

  const duplicateIds = unique([
    ...observedEvents.map((event) => event.eventId),
    ...attempts.flatMap((attempt) => attempt.providerEventId ? [attempt.providerEventId] : []),
  ])
    .filter((eventId) => eventId !== canonical.eventId);
  ensureProviderCallCapacity(execution, duplicateIds.length + 1);
  const deletedIds: string[] = [];
  for (const eventId of duplicateIds) {
    try {
      await providerCall(execution, () => adapter.deleteEvent(eventId, currentInput));
    } catch (error) {
      if (isProviderSyncLeaseLostError(error)) throw error;
      if (!isProviderEventNotFoundError(error)) throw error;
    }
    deletedIds.push(eventId);
  }
  const mutation = await updateProviderEventWithRecovery(
    agendaItem,
    adapter,
    currentInput,
    desiredFingerprint,
    canonical.eventId,
    'adopt',
    execution,
  );
  const updated = mutation.event;
  const canonicalAttemptId = [...observations]
    .filter((observation) => observation.events.some((event) => event.eventId === canonical.eventId))
    .sort((left, right) => (
      right.attempt.agendaVersion - left.attempt.agendaVersion
      || left.attempt.attemptId.localeCompare(right.attempt.attemptId)
    ))[0]?.attempt.attemptId;
  markProviderSyncSuccess(agendaItem, updated, desiredFingerprint, execution, {
    recoveryId: mutation.recovery.recoveryId,
    attemptResolutions: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      resolutionState: attempt.attemptId === canonicalAttemptId ? 'attached' : 'superseded',
    })),
    adoptedProviderEventId: updated.eventId,
    deletedProviderEventIds: deletedIds,
  });
  return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedIds, 'unknown_provider_create_reconciled');
}

async function discoverProviderCreateAttemptEvents(
  currentAgendaItem: SecretaryAgendaItem,
  attempt: SecretaryAgendaProviderCreateAttempt,
  adapter: SecretaryAgendaProviderAdapter,
  currentInput: SecretaryProviderEventInput,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryProviderEvent[]> {
  const attemptAgendaItem = getSecretaryAgendaItemById({
    agendaItemId: attempt.agendaItemId,
    ownerUserId: currentAgendaItem.ownerUserId,
    tenantId: currentAgendaItem.tenantId,
  });
  const attemptInput = attemptAgendaItem?.startAt && attemptAgendaItem.endAt
    ? toProviderEventInput(attemptAgendaItem)
    : { ...currentInput, agendaItemId: attempt.agendaItemId, version: attempt.agendaVersion };
  const discovered = adapter.findEventsByAgendaItemId
    ? await providerCall(
      execution,
      () => adapter.findEventsByAgendaItemId!(attempt.agendaItemId, attemptInput),
    )
    : [];
  const matching = discovered.filter((event) => (
    event.source === adapter.source
    && (event.agendaItemId === attempt.agendaItemId || event.eventId === attempt.providerEventId)
  ));
  if (
    attempt.providerEventId
    && adapter.getEvent
    && !matching.some((event) => event.eventId === attempt.providerEventId)
  ) {
    const exactRead = await providerCall(
      execution,
      () => adapter.getEvent!(attempt.providerEventId!, attemptInput),
    );
    if (exactRead.status === 'unknown') throw providerExactReadUnknownError();
    if (exactRead.status === 'found' && exactRead.event.source === adapter.source) {
      matching.push(exactRead.event);
    }
  }
  return uniqueProviderEvents(matching);
}

function persistObservedProviderCreateAttemptIds(
  observations: SecretaryAgendaProviderCreateAttemptObservation[],
): void {
  const db = getDb();
  const nowIso = new Date().toISOString();
  const update = db.prepare(`
    UPDATE secretary_agenda_provider_create_reconciliation
       SET provider_event_id = COALESCE(provider_event_id, ?), updated_at = ?
     WHERE attempt_id = ?
       AND resolution_state IN ('in_flight', 'unknown', 'known')
  `);
  const persist = db.transaction(() => {
    for (const observation of observations) {
      const observed = [...observation.events]
        .sort((left, right) => left.eventId.localeCompare(right.eventId))[0];
      if (observed) update.run(observed.eventId, nowIso, observation.attempt.attemptId);
    }
  });
  persist();
}

function chooseCanonicalProviderEventForAttempts(
  agendaItem: SecretaryAgendaItem,
  events: SecretaryProviderEvent[],
): SecretaryProviderEvent | null {
  if (events.length === 0) return null;
  const trainingPool = events.some((event) => event.trainingOwned)
    ? events.filter((event) => event.trainingOwned)
    : events;
  const currentMarkerPool = trainingPool.some((event) => event.agendaItemId === agendaItem.agendaItemId)
    ? trainingPool.filter((event) => event.agendaItemId === agendaItem.agendaItemId)
    : trainingPool;
  if (agendaItem.providerEventId) {
    const mapped = currentMarkerPool.find((event) => event.eventId === agendaItem.providerEventId);
    if (mapped) return mapped;
  }
  return [...currentMarkerPool]
    .sort((left, right) => left.eventId.localeCompare(right.eventId))[0] ?? null;
}

function uniqueProviderEvents(events: SecretaryProviderEvent[]): SecretaryProviderEvent[] {
  const byId = new Map<string, SecretaryProviderEvent>();
  for (const event of events) if (!byId.has(event.eventId)) byId.set(event.eventId, event);
  return [...byId.values()];
}

function markProviderCreateAttemptsResolved(
  resolutions: Array<{
    attemptId: string;
    resolutionState: 'attached' | 'deleted' | 'superseded' | 'no_effect';
  }>,
  db: ReturnType<typeof getDb> = getDb(),
): void {
  if (resolutions.length === 0) return;
  const nowIso = new Date().toISOString();
  const update = db.prepare(`
    UPDATE secretary_agenda_provider_create_reconciliation
       SET resolution_state = ?, resolved_at = ?, updated_at = ?
     WHERE attempt_id = ?
       AND resolution_state IN ('in_flight', 'unknown', 'known')
  `);
  for (const resolution of resolutions) {
    update.run(resolution.resolutionState, nowIso, nowIso, resolution.attemptId);
  }
}

function unknownProviderCreateOutcomeError(): Error {
  return Object.assign(new Error('SECRETARY_PROVIDER_CREATE_OUTCOME_UNKNOWN'), {
    code: 'SECRETARY_PROVIDER_CREATE_OUTCOME_UNKNOWN',
  });
}

function isUnknownProviderCreateOutcomeError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SECRETARY_PROVIDER_CREATE_OUTCOME_UNKNOWN';
}

function isUnknownProviderCreateOutcome(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    responseStatus?: unknown;
    response?: { status?: unknown };
  } | null;
  const code = String(candidate?.code ?? '').toUpperCase();
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return true;
  const status = providerFailureStatus(candidate);
  if (Number.isFinite(status)) return status >= 500;
  // Fail closed: absent an explicit known-no-effect refusal, a create error
  // may have occurred after the provider accepted the request.
  return !isKnownNoEffectCreateFailure(error);
}

function isKnownNoEffectCreateFailure(error: unknown): boolean {
  if (error instanceof TrainingOperationDisabledError) return true;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    responseStatus?: unknown;
    response?: { status?: unknown };
  } | null;
  const code = String(candidate?.code ?? '').toUpperCase();
  if (['VALIDATION_ERROR', 'PROVIDER_VALIDATION_FAILED', 'INVALID_ARGUMENT', 'RATE_LIMITED'].includes(code)) return true;
  const status = providerFailureStatus(candidate);
  return status === 400 || status === 409 || status === 422 || status === 429;
}

function providerFailureStatus(candidate: {
  status?: unknown;
  statusCode?: unknown;
  responseStatus?: unknown;
  response?: { status?: unknown };
} | null): number {
  return Number(
    candidate?.response?.status
    ?? candidate?.responseStatus
    ?? candidate?.statusCode
    ?? candidate?.status,
  );
}

function knownNoEffectCreateFailureDisposition(error: unknown): 'terminal' | 'retryable' | null {
  if (!isKnownNoEffectCreateFailure(error)) return null;
  if (error instanceof TrainingOperationDisabledError) return 'retryable';
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    responseStatus?: unknown;
    response?: { status?: unknown };
  } | null;
  const status = providerFailureStatus(candidate);
  return status === 429 || String(candidate?.code ?? '').toUpperCase() === 'RATE_LIMITED'
    ? 'retryable'
    : 'terminal';
}

async function upsertProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  fingerprint?: string,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryAgendaProviderSyncResult> {
  const syncedFingerprint = fingerprint ?? computeProviderSyncFingerprint(agendaItem, adapter.source);
  const input = toProviderEventInput(agendaItem);
  await cleanupSupersededLogicalProviderMappings(agendaItem, adapter, input, execution);
  const duplicates = await findProviderEventsForAgendaItem(agendaItem, adapter, input, execution);
  const canonical = chooseCanonicalProviderEvent(agendaItem, duplicates);
  const duplicateIds = providerDuplicateIds(canonical, duplicates);
  // After discovery, reserve the complete effect/readback phase before the
  // first mutation. Budget exhaustion therefore releases the claim without a
  // partial duplicate cleanup or a fabricated failed classification.
  ensureProviderCallCapacity(
    execution,
    duplicateIds.length + (agendaItem.providerEventId && adapter.getEvent ? 2 : 1),
  );
  const deletedDuplicateEventIds = await deleteDuplicateProviderEvents(
    duplicateIds, adapter, input, execution,
  );
  let knownCreated: SecretaryProviderEvent | null = null;
  let knownCreateRecovery: SecretaryAgendaProviderEffectRecovery | null = null;
  let knownCreateAttemptId: string | null = null;

  try {
    if (agendaItem.providerEventId) {
      const currentRead = await readProviderEvent(agendaItem, adapter, input, execution);
      if (currentRead.status === 'unknown') {
        updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
        return result(
          agendaItem,
          'failed',
          agendaItem.providerEventId,
          adapter.source,
          'readback_failed',
          deletedDuplicateEventIds,
          currentRead.reasonCode,
        );
      }
      if (currentRead.status === 'found') {
        const mutation = await updateProviderEventWithRecovery(
          agendaItem,
          adapter,
          input,
          syncedFingerprint,
          agendaItem.providerEventId,
          'update',
          execution,
        );
        const updated = mutation.event;
        markProviderSyncSuccess(agendaItem, updated, syncedFingerprint, execution, {
          recoveryId: mutation.recovery.recoveryId,
        });
        return result(agendaItem, 'updated', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_updated');
      }

      if (canonical) {
        const mutation = await updateProviderEventWithRecovery(
          agendaItem,
          adapter,
          input,
          syncedFingerprint,
          canonical.eventId,
          'adopt',
          execution,
        );
        const updated = mutation.event;
        markProviderSyncSuccess(agendaItem, updated, syncedFingerprint, execution, {
          recoveryId: mutation.recovery.recoveryId,
        });
        return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_reattached');
      }

      const recreated = await createProviderEventWithRecovery(agendaItem, adapter, input, syncedFingerprint, execution);
      knownCreated = recreated.event;
      knownCreateRecovery = recreated.recovery;
      knownCreateAttemptId = recreated.attemptId;
      markProviderSyncSuccess(agendaItem, recreated.event, syncedFingerprint, execution, {
        recoveryId: recreated.recovery.recoveryId,
        attemptResolutions: [{ attemptId: recreated.attemptId, resolutionState: 'attached' }],
        adoptedProviderEventId: recreated.event.eventId,
      });
      return result(agendaItem, 'recreated', recreated.event.eventId, recreated.event.source, 'synced', deletedDuplicateEventIds, 'missing_provider_event_recreated');
    }

    if (canonical) {
      const mutation = await updateProviderEventWithRecovery(
        agendaItem,
        adapter,
        input,
        syncedFingerprint,
        canonical.eventId,
        'adopt',
        execution,
      );
      const updated = mutation.event;
      markProviderSyncSuccess(agendaItem, updated, syncedFingerprint, execution, {
        recoveryId: mutation.recovery.recoveryId,
      });
      return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'existing_provider_event_attached');
    }

    const created = await createProviderEventWithRecovery(agendaItem, adapter, input, syncedFingerprint, execution);
    knownCreated = created.event;
    knownCreateRecovery = created.recovery;
    knownCreateAttemptId = created.attemptId;
    markProviderSyncSuccess(agendaItem, created.event, syncedFingerprint, execution, {
      recoveryId: created.recovery.recoveryId,
      attemptResolutions: [{ attemptId: created.attemptId, resolutionState: 'attached' }],
      adoptedProviderEventId: created.event.eventId,
    });
    return result(agendaItem, 'created', created.event.eventId, created.event.source, 'synced', deletedDuplicateEventIds, 'provider_event_created');
  } catch (error) {
    if (isProviderSyncLeaseLostError(error)) {
      if (knownCreated && knownCreateRecovery) {
        await compensateKnownProviderCreate(
          agendaItem,
          adapter,
          input,
          knownCreateRecovery,
          execution,
          knownCreateAttemptId ?? undefined,
        );
      }
      throw error;
    }
    if (isProviderCallBudgetExhaustedError(error)) throw error;
    if (isUnknownProviderCreateOutcomeError(error)) {
      if (isSecretaryPreemptionCancellationRequested(agendaItem)) {
        markSecretaryPreemptionWinnerProviderFailed({
          agendaItemId: agendaItem.agendaItemId,
          agendaVersion: agendaItem.version,
          ownerUserId: agendaItem.ownerUserId,
          tenantId: agendaItem.tenantId,
          disposition: 'reconcile',
          failureCode: 'PROVIDER_CREATE_OUTCOME_UNKNOWN_AFTER_CANCELLATION',
          retryAfterAt: null,
          nowIso: new Date().toISOString(),
        });
      } else {
        updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
      }
      return result(
        agendaItem,
        'failed',
        null,
        adapter.source,
        'readback_failed',
        deletedDuplicateEventIds,
        'provider_create_reconciliation_required',
      );
    }
    if (knownCreated && knownCreateRecovery) {
      const compensated = await compensateKnownProviderCreate(
        agendaItem,
        adapter,
        input,
        knownCreateRecovery,
        execution,
        knownCreateAttemptId ?? undefined,
      );
      updateProviderMapping(agendaItem, {
        providerSyncState: compensated ? 'create_failed' : 'readback_failed',
      }, execution);
      return result(
        agendaItem,
        'failed',
        compensated ? null : knownCreated.eventId,
        adapter.source,
        compensated ? 'create_failed' : 'readback_failed',
        deletedDuplicateEventIds,
        compensated ? 'provider_mapping_failed_create_compensated' : 'provider_create_recovery_pending',
      );
    }
    const providerSyncState: SecretaryProviderSyncState = agendaItem.providerEventId || canonical
      ? 'update_failed'
      : 'create_failed';
    const createFailureDisposition = providerSyncState === 'create_failed'
      ? knownNoEffectCreateFailureDisposition(error)
      : null;
    const retryDelay = retryAfterMs(error);
    updateProviderMapping(agendaItem, {
      providerSyncState,
      providerSyncFailureDisposition: createFailureDisposition,
      providerSyncRetryAfterAt: createFailureDisposition === 'retryable' && retryDelay != null
        ? new Date(Date.now() + retryDelay).toISOString()
        : null,
    }, execution);
    logger.warn({
      err: error instanceof Error ? error.message : String(error),
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
      providerSyncState,
    }, 'Secretary agenda provider sync failed');
    return {
      ...result(
        agendaItem,
        'failed',
        agendaItem.providerEventId ?? canonical?.eventId ?? null,
        adapter.source,
        providerSyncState,
        deletedDuplicateEventIds,
        createFailureDisposition === 'terminal'
          ? 'provider_create_terminal_rejection'
          : error instanceof TrainingOperationDisabledError
            ? 'training_calendar_writes_disabled'
          : 'provider_sync_failed',
      ),
      retryAfterMs: retryDelay,
    };
  }
}

function isSecretaryPreemptionCancellationRequested(
  agendaItem: Pick<SecretaryAgendaItem, 'agendaItemId' | 'version' | 'ownerUserId' | 'tenantId'>,
): boolean {
  if (!secretaryAgendaPreemptionSchemaReady()) return false;
  return Boolean(getDb().prepare(`
    SELECT 1 FROM secretary_agenda_preemption_operations
     WHERE owner_user_id = ? AND tenant_id = ?
       AND winner_agenda_item_id = ? AND winner_agenda_version = ?
       AND cancel_requested_at IS NOT NULL
       AND state IN ('winner_ready', 'winner_reconcile')
  `).get(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    agendaItem.agendaItemId,
    agendaItem.version,
  ));
}

async function cleanupProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  execution?: SecretaryAgendaProviderSyncExecution,
  createAttempts: SecretaryAgendaProviderCreateAttempt[] = readUnresolvedProviderCreateAttempts(
    agendaItem,
    adapter.source,
  ),
): Promise<SecretaryAgendaProviderSyncResult> {
  const input = agendaItem.startAt && agendaItem.endAt ? toProviderEventInput(agendaItem) : null;
  const pendingRecoveries = getDb().prepare(`
    SELECT recovery_id, provider_event_id
      FROM secretary_agenda_provider_effect_recovery
     WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
       AND source_skill = ? AND source_intent_id = ?
       AND resolution_state = 'pending'
     ORDER BY created_at ASC, recovery_id ASC
  `).all(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    adapter.source,
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
  ) as Array<{ recovery_id: string; provider_event_id: string }>;
  const attemptObservations: SecretaryAgendaProviderCreateAttemptObservation[] = [];
  if (createAttempts.length > 0 && input) {
    for (const attempt of createAttempts) {
      attemptObservations.push({
        attempt,
        events: await discoverProviderCreateAttemptEvents(
          agendaItem,
          attempt,
          adapter,
          input,
          execution,
        ),
      });
    }
  }
  const hiddenAttempt = createAttempts.some((attempt) => {
    if (attempt.providerEventId) return false;
    return !attemptObservations.some((observation) => (
      observation.attempt.attemptId === attempt.attemptId && observation.events.length > 0
    ));
  });
  if (hiddenAttempt) {
    updateProviderMapping(agendaItem, { providerSyncState: 'readback_failed' }, execution);
    return result(
      agendaItem,
      'failed',
      agendaItem.providerEventId,
      adapter.source,
      'readback_failed',
      [],
      'provider_create_reconciliation_required',
    );
  }
  persistObservedProviderCreateAttemptIds(attemptObservations);
  const duplicates = await findProviderEventsForAgendaItem(agendaItem, adapter, input, execution);
  const idsToDelete = unique([
    ...(agendaItem.providerEventId && agendaItem.providerSyncState !== 'deleted' ? [agendaItem.providerEventId] : []),
    ...pendingRecoveries.map((entry) => entry.provider_event_id),
    ...createAttempts.flatMap((attempt) => attempt.providerEventId ? [attempt.providerEventId] : []),
    ...attemptObservations.flatMap((observation) => observation.events.map((event) => event.eventId)),
    ...duplicates.map((event) => event.eventId),
  ]);
  const deletedDuplicateEventIds: string[] = [];
  ensureProviderCallCapacity(execution, idsToDelete.length);

  try {
    for (const eventId of idsToDelete) {
      try {
        await providerCall(execution, () => adapter.deleteEvent(eventId, input));
      } catch (err) {
        if (isProviderSyncLeaseLostError(err)) throw err;
        if (!isProviderEventNotFoundError(err)) throw err;
      }
      if (eventId !== agendaItem.providerEventId) deletedDuplicateEventIds.push(eventId);
    }
    const persistCleanup = getDb().transaction(() => {
      updateProviderMapping(agendaItem, {
        providerSyncState: 'deleted',
        clearProviderLink: true,
      }, execution);
      markProviderCreateAttemptsResolved(createAttempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        resolutionState: 'deleted' as const,
      })), getDb());
      for (const recovery of pendingRecoveries) {
        markProviderEffectRecoveryResolved(recovery.recovery_id, 'deleted', getDb());
      }
    });
    persistCleanup();
    return result(agendaItem, idsToDelete.length > 0 ? 'deleted' : 'skipped', null, adapter.source, 'deleted', deletedDuplicateEventIds, idsToDelete.length > 0 ? 'provider_event_deleted' : 'no_provider_event_to_delete');
  } catch (error) {
    if (isProviderSyncLeaseLostError(error)) throw error;
    updateProviderMapping(agendaItem, { providerSyncState: 'delete_failed' }, execution);
    logger.warn({
      err: error instanceof Error ? error.message : String(error),
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
    }, 'Secretary agenda provider cleanup failed');
    const nextFailureCount = agendaItem.providerSyncFailureCount + 1;
    if (nextFailureCount === PROVIDER_SYNC_DEAD_LETTER_THRESHOLD) {
      logger.warn({
        agendaItemId: agendaItem.agendaItemId,
        providerEventId: agendaItem.providerEventId,
        providerSource: adapter.source,
        providerSyncFailureCount: nextFailureCount,
      }, 'Secretary agenda provider cleanup reached the dead-letter threshold — automatic retries stop; manual review required');
    }
    return {
      ...result(agendaItem, 'failed', agendaItem.providerEventId, adapter.source, 'delete_failed', deletedDuplicateEventIds, 'provider_delete_failed'),
      retryAfterMs: retryAfterMs(error),
    };
  }
}

async function cleanupSupersededLogicalProviderMappings(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<void> {
  const rows = getDb().prepare(`
    SELECT agenda_item_id, provider_event_id
      FROM secretary_agenda_items
     WHERE owner_user_id = ?
       AND tenant_id = ?
       AND source_skill = ?
       AND source_intent_id = ?
       AND version < ?
       AND provider_source = ?
       AND provider_event_id IS NOT NULL
       AND provider_sync_state <> 'deleted'
     ORDER BY version ASC, agenda_item_id ASC
  `).all(
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    agendaItem.sourceSkill,
    agendaItem.sourceIntentId,
    agendaItem.version,
    adapter.source,
  ) as Array<{ agenda_item_id: string; provider_event_id: string }>;
  const stale = rows.filter((row) => row.provider_event_id !== agendaItem.providerEventId);
  ensureProviderCallCapacity(execution, stale.length);
  for (const row of stale) {
    try {
      await providerCall(execution, () => adapter.deleteEvent(row.provider_event_id, input));
    } catch (error) {
      if (!isProviderEventNotFoundError(error)) throw error;
      execution?.assertActive();
    }
    execution?.assertActive();
    getDb().prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = NULL,
             provider_source = NULL,
             provider_sync_state = 'deleted',
             updated_at = ?
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
         AND source_skill = ?
         AND source_intent_id = ?
         AND version < ?
    `).run(
      new Date().toISOString(),
      row.agenda_item_id,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      agendaItem.sourceSkill,
      agendaItem.sourceIntentId,
      agendaItem.version,
    );
    execution?.assertActive();
  }
}

async function findProviderEventsForAgendaItem(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput | null,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryProviderEvent[]> {
  if (!adapter.findEventsByAgendaItemId) return [];
  const events = await providerCall(
    execution,
    () => adapter.findEventsByAgendaItemId!(agendaItem.agendaItemId, input),
  );
  return events.filter((event) => event.source === adapter.source && event.agendaItemId === agendaItem.agendaItemId);
}

async function readProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<SecretaryProviderEventReadResult> {
  if (!agendaItem.providerEventId || !adapter.getEvent) {
    return { status: 'unknown', reasonCode: 'provider_exact_read_unsupported' };
  }
  const exactRead = await providerCall(
    execution,
    () => adapter.getEvent!(agendaItem.providerEventId!, input),
  );
  if (exactRead.status !== 'found') return exactRead;
  if (
    exactRead.event.source !== adapter.source
    || exactRead.event.agendaItemId !== agendaItem.agendaItemId
  ) {
    return { status: 'unknown', reasonCode: 'provider_exact_read_identity_mismatch' };
  }
  return exactRead;
}

function providerExactReadUnknownError(): Error {
  return Object.assign(new Error('SECRETARY_PROVIDER_EXACT_READ_UNKNOWN'), {
    code: 'SECRETARY_PROVIDER_EXACT_READ_UNKNOWN',
  });
}

function chooseCanonicalProviderEvent(
  agendaItem: SecretaryAgendaItem,
  events: SecretaryProviderEvent[],
): SecretaryProviderEvent | null {
  if (events.length === 0) return null;
  // Training-owned events (identity marker for this item's source session)
  // outrank everything, including the stored provider_event_id: in the legacy
  // duplicate state the stored id points at the Secretary copy, and picking it
  // would delete the event Training links to out of the user's calendar.
  const pool = events.some((event) => event.trainingOwned)
    ? events.filter((event) => event.trainingOwned)
    : events;
  if (agendaItem.providerEventId) {
    const current = pool.find((event) => event.eventId === agendaItem.providerEventId);
    if (current) return current;
  }
  return [...pool].sort((left, right) => left.eventId.localeCompare(right.eventId))[0] ?? null;
}

async function deleteDuplicateProviderEvents(
  duplicateIds: string[],
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
  execution?: SecretaryAgendaProviderSyncExecution,
): Promise<string[]> {
  for (const eventId of duplicateIds) {
    await providerCall(execution, () => adapter.deleteEvent(eventId, input));
  }
  return duplicateIds;
}

function providerDuplicateIds(
  canonical: SecretaryProviderEvent | null,
  events: SecretaryProviderEvent[],
): string[] {
  return unique(events
    .map((event) => event.eventId)
    .filter((eventId) => eventId !== canonical?.eventId));
}

async function providerCall<T>(
  execution: SecretaryAgendaProviderSyncExecution | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  execution?.assertActive();
  reserveProviderCallCapacity(execution, 1);
  const value = await operation();
  execution?.assertActive();
  return value;
}

function reserveProviderCallCapacity(
  execution: SecretaryAgendaProviderSyncExecution | undefined,
  calls: number,
): void {
  if (!execution || calls <= 0) return;
  if (execution.callBudget.used + calls > execution.callBudget.limit) {
    const error = new Error('SECRETARY_PROVIDER_SYNC_CALL_BUDGET_EXHAUSTED');
    throw Object.assign(error, { code: 'SECRETARY_PROVIDER_SYNC_CALL_BUDGET_EXHAUSTED' });
  }
  execution.callBudget.used += calls;
}

function ensureProviderCallCapacity(
  execution: SecretaryAgendaProviderSyncExecution | undefined,
  calls: number,
): void {
  if (!execution || calls <= 0) return;
  if (execution.callBudget.used + calls > execution.callBudget.limit) {
    const error = new Error('SECRETARY_PROVIDER_SYNC_CALL_BUDGET_EXHAUSTED');
    throw Object.assign(error, { code: 'SECRETARY_PROVIDER_SYNC_CALL_BUDGET_EXHAUSTED' });
  }
}

function isProviderCallBudgetExhaustedError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'SECRETARY_PROVIDER_SYNC_CALL_BUDGET_EXHAUSTED';
}

function toProviderEventInput(agendaItem: SecretaryAgendaItem): SecretaryProviderEventInput {
  if (!agendaItem.startAt || !agendaItem.endAt) {
    throw new Error('Secretary agenda item cannot be provider-synced without start/end times');
  }
  return {
    agendaItemId: agendaItem.agendaItemId,
    sourceIntentId: agendaItem.sourceIntentId,
    sourceSkill: agendaItem.sourceSkill,
    sourceEntityId: agendaItem.sourceEntityId,
    sourceEntityType: agendaItem.sourceEntityType,
    ownerUserId: agendaItem.ownerUserId,
    tenantId: agendaItem.tenantId,
    version: agendaItem.version,
    title: agendaItem.title,
    startAt: agendaItem.startAt,
    endAt: agendaItem.endAt,
    durationMinutes: agendaItem.durationMinutes,
    lifecycleState: agendaItem.lifecycleState,
    decisionReasonCodes: agendaItem.decisionReasonCodes,
    sourceShapeHash: agendaItem.sourceShapeHash,
  };
}

interface SecretaryProviderSyncResolution {
  recoveryId?: string;
  attemptResolutions?: Array<{
    attemptId: string;
    resolutionState: 'attached' | 'deleted' | 'superseded' | 'no_effect';
  }>;
  adoptedProviderEventId?: string;
  deletedProviderEventIds?: string[];
}

function markProviderSyncSuccess(
  agendaItem: SecretaryAgendaItem,
  providerEvent: Pick<SecretaryProviderEvent, 'eventId' | 'source'>,
  fingerprint: string,
  execution?: SecretaryAgendaProviderSyncExecution,
  resolution?: SecretaryProviderSyncResolution,
): void {
  const db = getDb();
  execution?.assertActive();
  const nowIso = new Date().toISOString();
  const hasFingerprintColumns = tableHasColumn(db, 'secretary_agenda_items', 'last_synced_fingerprint')
    && tableHasColumn(db, 'secretary_agenda_items', 'last_synced_verified_at');
  const hasFailureCount = tableHasColumn(db, 'secretary_agenda_items', 'provider_sync_failure_count');
  const fingerprintAssignments = hasFingerprintColumns
    ? ', last_synced_fingerprint = ?, last_synced_verified_at = ?'
    : '';
  const failureAssignment = hasFailureCount ? ', provider_sync_failure_count = 0' : '';
  const fenceClause = execution ? `
    AND version = ?
    AND source_skill = ?
    AND source_intent_id = ?
    AND EXISTS (
      SELECT 1
        FROM secretary_agenda_provider_sync_claims AS claim
       WHERE claim.owner_user_id = secretary_agenda_items.owner_user_id
         AND claim.tenant_id = secretary_agenda_items.tenant_id
         AND claim.provider_source = ?
         AND claim.source_skill = secretary_agenda_items.source_skill
         AND claim.source_intent_id = secretary_agenda_items.source_intent_id
         AND claim.agenda_item_id = secretary_agenda_items.agenda_item_id
         AND claim.agenda_version = secretary_agenda_items.version
         AND claim.desired_fingerprint = ?
         AND claim.lease_token = ?
         AND claim.lease_expires_at > ?
         AND claim.desired_fingerprint = (
           claim.provider_source || '|' || secretary_agenda_items.source_shape_hash || '|'
           || COALESCE(secretary_agenda_items.start_at, '') || '|'
           || COALESCE(secretary_agenda_items.end_at, '') || '|'
           || CAST(secretary_agenda_items.version AS TEXT)
         )
    )
    AND NOT EXISTS (
      SELECT 1
        FROM secretary_agenda_items AS newer
       WHERE newer.owner_user_id = secretary_agenda_items.owner_user_id
         AND newer.tenant_id = secretary_agenda_items.tenant_id
         AND newer.source_skill = secretary_agenda_items.source_skill
         AND newer.source_intent_id = secretary_agenda_items.source_intent_id
         AND newer.version > secretary_agenda_items.version
    )
  ` : '';
  const persist = db.transaction(() => {
    // Mapping and fingerprint share this single UPDATE. A trigger/failure can
    // commit both or neither; no fresh fast-path can observe a missing map.
    const write = db.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?,
             provider_source = ?,
             provider_sync_state = 'synced',
             provider_sync_failure_disposition = NULL,
             provider_sync_retry_after_at = NULL,
             lifecycle_state = CASE
               WHEN lifecycle_state IN ('canceled', 'superseded', 'unscheduled', 'deferred', 'completed')
                 OR cancellation_reason IS NOT NULL
               THEN lifecycle_state
               ELSE 'synced'
             END,
             updated_at = ?
             ${fingerprintAssignments}
             ${failureAssignment}
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
         AND provider_target = ?
         ${fenceClause}
    `).run(
      providerEvent.eventId,
      providerEvent.source,
      nowIso,
      ...(hasFingerprintColumns ? [fingerprint, nowIso] : []),
      agendaItem.agendaItemId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      providerEvent.source,
      ...(execution ? [
        execution.claim.agendaVersion,
        execution.claim.sourceSkill,
        execution.claim.sourceIntentId,
        execution.claim.providerSource,
        execution.claim.desiredFingerprint,
        execution.claim.leaseToken,
        nowIso,
      ] : []),
    );
    if (write.changes !== 1) {
      if (execution) throw providerSyncLeaseLostError(execution.claim);
      throw new Error(`SECRETARY_PROVIDER_MAPPING_UPDATE_MISSED: ${agendaItem.agendaItemId}`);
    }
    if (resolution?.recoveryId) {
      markProviderEffectRecoveryResolved(resolution.recoveryId, 'adopted', db);
    }
    if (resolution?.attemptResolutions) {
      markProviderCreateAttemptsResolved(resolution.attemptResolutions, db);
    }
    if (resolution?.adoptedProviderEventId) {
      db.prepare(`
        UPDATE secretary_agenda_provider_effect_recovery
           SET resolution_state = 'adopted', updated_at = ?
         WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
           AND source_skill = ? AND source_intent_id = ?
           AND provider_event_id = ? AND resolution_state = 'pending'
      `).run(
        nowIso,
        agendaItem.ownerUserId,
        String(agendaItem.tenantId),
        providerEvent.source,
        agendaItem.sourceSkill,
        agendaItem.sourceIntentId,
        resolution.adoptedProviderEventId,
      );
    }
    const markDeletedRecovery = db.prepare(`
      UPDATE secretary_agenda_provider_effect_recovery
         SET resolution_state = 'deleted', updated_at = ?
       WHERE owner_user_id = ? AND tenant_id = ? AND provider_source = ?
         AND source_skill = ? AND source_intent_id = ?
         AND provider_event_id = ? AND resolution_state = 'pending'
    `);
    for (const eventId of resolution?.deletedProviderEventIds ?? []) {
      markDeletedRecovery.run(
        nowIso,
        agendaItem.ownerUserId,
        String(agendaItem.tenantId),
        providerEvent.source,
        agendaItem.sourceSkill,
        agendaItem.sourceIntentId,
        eventId,
      );
    }
    if (agendaItem.sourceSkill === 'cooking' && agendaItem.sourceEntityType === 'meal_prep_block') {
      emitDomainEvent({
        // event_outbox uses the authenticated numeric partition. The exact
        // Secretary tenant remains an ID-only payload field and is rechecked
        // by the completion consumer before any user-facing effect.
        tenantId: agendaItem.ownerUserId,
        userId: agendaItem.ownerUserId,
        sourceSkill: 'cooking',
        eventType: COOKING_MEAL_PREP_PROVIDER_SYNC_COMPLETED_EVENT_TYPE,
        entityType: 'secretary_agenda_item',
        entityId: agendaItem.agendaItemId,
        entityVersion: agendaItem.version,
        schemaVersion: 'cooking-meal-prep-provider-sync-v1',
        payload: { agendaTenantId: String(agendaItem.tenantId) },
        privacyClassification: 'internal',
        idempotencyKey: `secretary.cooking_provider_sync.completed:${agendaItem.agendaItemId}:${agendaItem.version}:${providerEvent.source}:${providerEvent.eventId}`,
      }, db);
    }
    // Mapping success is the second phase's terminal commit point. Migration
    // 282 verifies the winner row is now synced and every loser edge remains
    // satisfied before accepting `completed`.
    markSecretaryPreemptionWinnerProviderSucceeded({
      agendaItemId: agendaItem.agendaItemId,
      agendaVersion: agendaItem.version,
      ownerUserId: agendaItem.ownerUserId,
      tenantId: agendaItem.tenantId,
      nowIso,
    }, db);
  });
  persist();
}

function updateProviderMapping(
  agendaItem: Pick<SecretaryAgendaItem, 'agendaItemId' | 'version' | 'ownerUserId' | 'tenantId' | 'providerTarget'>,
  patch: {
    providerEventId?: string | null;
    providerSource?: SecretaryCalendarProviderSource | null;
    providerSyncState: SecretaryProviderSyncState;
    lifecycleState?: SecretaryAgendaLifecycleState;
    clearProviderLink?: boolean;
    providerSyncFailureDisposition?: 'terminal' | 'retryable' | 'reconcile' | null;
    providerSyncRetryAfterAt?: string | null;
  },
  execution?: SecretaryAgendaProviderSyncExecution,
): void {
  const lifecycleState = patch.lifecycleState
    ?? (patch.providerSyncState === 'synced'
      ? 'synced'
      : FAILED_PROVIDER_SYNC_STATES.has(patch.providerSyncState)
        ? 'failed_sync'
        : null);
  const requestedLifecycleIsActive = lifecycleState != null
    && ACTIVE_PROVIDER_STATES.has(lifecycleState);
  const clearProviderLink = patch.clearProviderLink ? 1 : 0;
  const db = getDb();
  execution?.assertActive();
  const nowIso = new Date().toISOString();

  // Migration 220: track consecutive failures for the dead-letter skip. The
  // counter is written in the same statement as the provider mapping so a
  // reclaimed lease can never observe a half-applied local outcome.
  const isFailedTransition = FAILED_PROVIDER_SYNC_STATES.has(patch.providerSyncState);
  const isSettledTransition = patch.providerSyncState === 'synced' || patch.providerSyncState === 'deleted';
  const providerSyncFailureDisposition = patch.providerSyncFailureDisposition !== undefined
    ? patch.providerSyncFailureDisposition
    : isFailedTransition
      ? patch.providerSyncState === 'readback_failed' ? 'reconcile' : 'retryable'
      : null;
  const updateFailureCount = (isFailedTransition || isSettledTransition)
    && tableHasColumn(db, 'secretary_agenda_items', 'provider_sync_failure_count');
  const failureCountAssignment = updateFailureCount
    ? ', provider_sync_failure_count = CASE WHEN ? THEN provider_sync_failure_count + 1 ELSE 0 END'
    : '';
  const fenceClause = execution ? `
      AND version = ?
      AND EXISTS (
        SELECT 1
        FROM secretary_agenda_provider_sync_claims AS claim
        WHERE claim.agenda_item_id = secretary_agenda_items.agenda_item_id
          AND claim.owner_user_id = secretary_agenda_items.owner_user_id
          AND claim.tenant_id = secretary_agenda_items.tenant_id
          AND claim.provider_source = ?
          AND claim.agenda_version = secretary_agenda_items.version
          AND claim.lease_token = ?
          AND claim.lease_expires_at > ?
          AND claim.source_skill = secretary_agenda_items.source_skill
          AND claim.source_intent_id = secretary_agenda_items.source_intent_id
          AND claim.desired_fingerprint = (
            claim.provider_source || '|' || secretary_agenda_items.source_shape_hash || '|'
            || COALESCE(secretary_agenda_items.start_at, '') || '|'
            || COALESCE(secretary_agenda_items.end_at, '') || '|'
            || CAST(secretary_agenda_items.version AS TEXT)
          )
      )
  ` : '';
  const persist = db.transaction(() => {
    const result = db.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = CASE WHEN ? THEN NULL ELSE COALESCE(?, provider_event_id) END,
             provider_source = CASE WHEN ? THEN NULL ELSE COALESCE(?, provider_source) END,
             provider_sync_state = ?,
             lifecycle_state = CASE
               WHEN ?
                AND (
                  lifecycle_state IN ('canceled', 'superseded', 'unscheduled', 'deferred', 'completed')
                  OR cancellation_reason IS NOT NULL
                )
               THEN lifecycle_state
               ELSE COALESCE(?, lifecycle_state)
             END,
             updated_at = ?,
             provider_sync_failure_disposition = ?,
             provider_sync_retry_after_at = ?
             ${failureCountAssignment}
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
         AND provider_target = ?
         ${fenceClause}
    `).run(
      clearProviderLink,
      patch.providerEventId ?? null,
      clearProviderLink,
      patch.providerSource ?? null,
      patch.providerSyncState,
      requestedLifecycleIsActive ? 1 : 0,
      lifecycleState,
      nowIso,
      providerSyncFailureDisposition,
      patch.providerSyncRetryAfterAt ?? null,
      ...(updateFailureCount ? [isFailedTransition ? 1 : 0] : []),
      agendaItem.agendaItemId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
      agendaItem.providerTarget,
      ...(execution ? [
        execution.claim.agendaVersion,
        execution.claim.providerSource,
        execution.claim.leaseToken,
        nowIso,
      ] : []),
    );
    if (result.changes === 0) {
      if (execution) throw providerSyncLeaseLostError(execution.claim);
      throw new Error(`SECRETARY_PROVIDER_MAPPING_UPDATE_MISSED: ${agendaItem.agendaItemId}`);
    }
    if (isFailedTransition) {
      markSecretaryPreemptionWinnerProviderFailed({
        agendaItemId: agendaItem.agendaItemId,
        agendaVersion: agendaItem.version,
        ownerUserId: agendaItem.ownerUserId,
        tenantId: agendaItem.tenantId,
        disposition: providerSyncFailureDisposition ?? 'retryable',
        failureCode: patch.providerSyncState.toUpperCase(),
        retryAfterAt: patch.providerSyncRetryAfterAt ?? null,
        nowIso,
      }, db);
    }
  });
  persist();
}

function markCancellationReasonedItemCanceled(
  agendaItem: SecretaryAgendaItem,
  execution?: SecretaryAgendaProviderSyncExecution,
): SecretaryAgendaItem {
  execution?.assertActive();
  const nowIso = new Date().toISOString();
  const fenceClause = execution ? `
       AND version = ?
       AND EXISTS (
         SELECT 1
         FROM secretary_agenda_provider_sync_claims AS claim
         WHERE claim.agenda_item_id = secretary_agenda_items.agenda_item_id
           AND claim.owner_user_id = secretary_agenda_items.owner_user_id
           AND claim.tenant_id = secretary_agenda_items.tenant_id
           AND claim.provider_source = ?
           AND claim.agenda_version = secretary_agenda_items.version
           AND claim.lease_token = ?
           AND claim.lease_expires_at > ?
           AND claim.source_skill = secretary_agenda_items.source_skill
           AND claim.source_intent_id = secretary_agenda_items.source_intent_id
           AND claim.desired_fingerprint = (
             claim.provider_source || '|' || secretary_agenda_items.source_shape_hash || '|'
             || COALESCE(secretary_agenda_items.start_at, '') || '|'
             || COALESCE(secretary_agenda_items.end_at, '') || '|'
             || CAST(secretary_agenda_items.version AS TEXT)
           )
       )
  ` : '';
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'canceled',
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND cancellation_reason IS NOT NULL
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
       ${fenceClause}
  `).run(
    nowIso,
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    ...(execution ? [
      execution.claim.agendaVersion,
      execution.claim.providerSource,
      execution.claim.leaseToken,
      nowIso,
    ] : []),
  );

  if (result.changes === 0) {
    if (execution) throw providerSyncLeaseLostError(execution.claim);
    return agendaItem;
  }
  return {
    ...agendaItem,
    lifecycleState: 'canceled',
    updatedAt: nowIso,
  };
}

function markUnschedulableTrainingAgendaItemForCleanup(
  agendaItem: SecretaryAgendaItem,
  execution?: SecretaryAgendaProviderSyncExecution,
): SecretaryAgendaItem | null {
  if (!ACTIVE_PROVIDER_STATES.has(agendaItem.lifecycleState)) return null;
  if (agendaItem.sourceSkill !== 'training' || agendaItem.sourceEntityType !== 'training_session') return null;
  if (!trainingSessionRequiresProviderCleanup(agendaItem)) return null;

  const nowIso = new Date().toISOString();
  execution?.assertActive();
  const fenceClause = execution ? `
       AND version = ?
       AND EXISTS (
         SELECT 1
         FROM secretary_agenda_provider_sync_claims AS claim
         WHERE claim.agenda_item_id = secretary_agenda_items.agenda_item_id
           AND claim.owner_user_id = secretary_agenda_items.owner_user_id
           AND claim.tenant_id = secretary_agenda_items.tenant_id
           AND claim.provider_source = ?
           AND claim.agenda_version = secretary_agenda_items.version
           AND claim.lease_token = ?
           AND claim.lease_expires_at > ?
           AND claim.source_skill = secretary_agenda_items.source_skill
           AND claim.source_intent_id = secretary_agenda_items.source_intent_id
           AND claim.desired_fingerprint = (
             claim.provider_source || '|' || secretary_agenda_items.source_shape_hash || '|'
             || COALESCE(secretary_agenda_items.start_at, '') || '|'
             || COALESCE(secretary_agenda_items.end_at, '') || '|'
             || CAST(secretary_agenda_items.version AS TEXT)
           )
       )
  ` : '';
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'unscheduled',
           cancellation_reason = COALESCE(cancellation_reason, 'training_session_unscheduled'),
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
       ${fenceClause}
  `).run(
    nowIso,
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
    ...(execution ? [
      execution.claim.agendaVersion,
      execution.claim.providerSource,
      execution.claim.leaseToken,
      nowIso,
    ] : []),
  );
  if (result.changes === 0) {
    if (execution) throw providerSyncLeaseLostError(execution.claim);
    return null;
  }
  return {
    ...agendaItem,
    lifecycleState: 'unscheduled',
    cancellationReason: agendaItem.cancellationReason ?? 'training_session_unscheduled',
    updatedAt: nowIso,
  };
}

function trainingSessionRequiresProviderCleanup(agendaItem: SecretaryAgendaItem): boolean {
  const sessionId = Number(agendaItem.sourceEntityId);
  // Persisted Training-session agenda rows are keyed by numeric
  // `training_sessions.id`. Non-numeric source ids belong to legacy or
  // pending-intent rows and are intentionally left to normal lifecycle
  // cleanup instead of guessing across Training state.
  if (!Number.isFinite(sessionId) || sessionId <= 0) return false;
  const db = getDb();
  if (!tableExists(db, 'training_sessions')) return false;

  const status = readTrainingSessionStatus(db, sessionId, agendaItem);
  return status === 'unscheduled' || status === 'canceled' || status === 'cancelled';
}

function readTrainingSessionStatus(
  db: ReturnType<typeof getDb>,
  sessionId: number,
  agendaItem: SecretaryAgendaItem,
): string | null {
  if (tableExists(db, 'fitness_training_plans') && tableHasColumn(db, 'training_sessions', 'plan_id')) {
    const scoped = db.prepare(`
      SELECT LOWER(TRIM(s.status)) AS status
        FROM training_sessions s
        JOIN fitness_training_plans p ON p.id = s.plan_id
       WHERE s.id = ?
         AND p.user_id = ?
         AND CAST(p.tenant_id AS TEXT) = ?
       LIMIT 1
    `).get(sessionId, agendaItem.ownerUserId, String(agendaItem.tenantId)) as { status?: string | null } | undefined;
    // Once ownership tables exist, absence in the exact owner/tenant join is
    // authoritative. Falling back to a global session id can let a foreign
    // tenant's unscheduled status delete this tenant's calendar event.
    return scoped?.status ?? null;
  }

  const row = db.prepare(`
    SELECT LOWER(TRIM(status)) AS status
      FROM training_sessions
     WHERE id = ?
     LIMIT 1
  `).get(sessionId) as { status?: string | null } | undefined;
  return row?.status ?? null;
}

function tableExists(db: ReturnType<typeof getDb>, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
      FROM sqlite_master
     WHERE type = 'table'
       AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function tableHasColumn(db: ReturnType<typeof getDb>, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return columns.some((column) => column.name === columnName);
}

function result(
  agendaItem: SecretaryAgendaItem,
  action: SecretaryAgendaProviderSyncAction,
  providerEventId: string | null,
  providerSource: SecretaryCalendarProviderSource,
  providerSyncState: SecretaryProviderSyncState,
  deletedDuplicateEventIds: string[],
  reasonCode: string,
): SecretaryAgendaProviderSyncResult {
  return {
    agendaItemId: agendaItem.agendaItemId,
    action,
    providerEventId,
    providerSource,
    providerSyncState,
    deletedDuplicateEventIds,
    reasonCode,
  };
}

function providerCallBudgetDeferredResult(
  claim: SecretaryAgendaProviderSyncClaim,
  providerSource: SecretaryCalendarProviderSource,
): SecretaryAgendaProviderSyncResult {
  const agendaItem = getSecretaryAgendaItemById({
    agendaItemId: claim.agendaItemId,
    ownerUserId: claim.ownerUserId,
    tenantId: claim.tenantId,
  });
  return {
    agendaItemId: claim.agendaItemId,
    action: 'failed',
    providerEventId: agendaItem?.providerEventId ?? null,
    providerSource,
    providerSyncState: agendaItem?.providerSyncState ?? 'not_synced',
    deletedDuplicateEventIds: [],
    reasonCode: 'provider_call_budget_deferred',
  };
}

function isRetryableProviderSyncResult(result: SecretaryAgendaProviderSyncResult): boolean {
  return result.action === 'failed'
    && result.reasonCode !== 'provider_create_terminal_rejection'
    && (result.providerSyncState === 'create_failed'
      || result.providerSyncState === 'update_failed'
      || result.providerSyncState === 'delete_failed');
}

function providerRetryDelayMs(
  retryAfter: number | null | undefined,
  attempt: number,
  options: SecretaryAgendaProviderSyncOptions,
): number {
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }
  const base = Math.max(0, options.baseBackoffMs ?? DEFAULT_PROVIDER_RETRY_BASE_MS);
  const max = Math.max(base, options.maxBackoffMs ?? DEFAULT_PROVIDER_RETRY_MAX_MS);
  return Math.min(max, base * (2 ** attempt));
}

function retryAfterMs(error: unknown): number | null {
  const retryAfter = retryAfterHeader(error);
  if (!retryAfter) return null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(retryAfter);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function retryAfterHeader(error: unknown): string | null {
  const candidate = error as {
    retryAfter?: unknown;
    response?: { headers?: unknown };
    headers?: unknown;
  } | null;
  const direct = candidate?.retryAfter;
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);
  return headerValue(candidate?.response?.headers, 'retry-after')
    ?? headerValue(candidate?.headers, 'retry-after');
}

function headerValue(headers: unknown, key: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (name: string) => unknown }).get(key);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const value = record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
