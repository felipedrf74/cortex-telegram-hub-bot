// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  computeSecretaryAgendaProviderSyncFingerprint,
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  type SecretaryAgendaItem,
  type SecretaryAgendaLifecycleState,
  type SecretaryProviderSyncState,
} from './secretary-scheduling-arbitrator';
import { isProviderEventNotFoundError } from './training-calendar-errors';
import { logger } from '../utils/logger';

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

export interface SecretaryAgendaProviderAdapter {
  source: SecretaryCalendarProviderSource;
  createEvent(input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent>;
  updateEvent(eventId: string, input: SecretaryProviderEventInput): Promise<SecretaryProviderEvent>;
  deleteEvent(eventId: string, input: SecretaryProviderEventInput | null): Promise<void>;
  getEvent?(eventId: string, input: SecretaryProviderEventInput | null): Promise<SecretaryProviderEvent | null>;
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

export interface SecretaryAgendaProviderSyncOptions {
  retryBudget?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const DEFAULT_PROVIDER_RETRY_BUDGET = 2;
const DEFAULT_PROVIDER_RETRY_BASE_MS = 250;
const DEFAULT_PROVIDER_RETRY_MAX_MS = 2_000;

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

function recordSyncedFingerprint(
  agendaItem: Pick<SecretaryAgendaItem, 'agendaItemId' | 'ownerUserId' | 'tenantId'>,
  fingerprint: string,
): void {
  const db = getDb();
  if (!tableHasColumn(db, 'secretary_agenda_items', 'last_synced_fingerprint')) return;
  db.prepare(`
    UPDATE secretary_agenda_items
       SET last_synced_fingerprint = ?,
           last_synced_verified_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
  `).run(
    fingerprint,
    new Date().toISOString(),
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
  );
}

export function markCompletedSecretaryAgendaItems(now: Date = new Date()): number {
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'completed',
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
     WHERE end_at IS NOT NULL
       AND datetime(end_at) < datetime(?)
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed')
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
): Promise<SecretaryAgendaProviderSyncResult> {
  const agendaItem = getSecretaryAgendaItemById(scope);
  if (!agendaItem) {
    throw new Error('Secretary agenda item not found for provider sync scope');
  }

  if (agendaItem.providerSource && agendaItem.providerSource !== adapter.source) {
    return {
      agendaItemId: agendaItem.agendaItemId,
      action: 'skipped',
      providerEventId: agendaItem.providerEventId,
      providerSource: adapter.source,
      providerSyncState: agendaItem.providerSyncState,
      deletedDuplicateEventIds: [],
      reasonCode: 'provider_source_mismatch',
    };
  }

  if (isTerminalDeletedCleanupRow(agendaItem)) {
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
    const canceled = markCancellationReasonedItemCanceled(agendaItem);
    return cleanupProviderEvent(canceled, adapter);
  }

  const trainingBackedCleanup = markUnschedulableTrainingAgendaItemForCleanup(agendaItem);
  if (trainingBackedCleanup) {
    return cleanupProviderEvent(trainingBackedCleanup, adapter);
  }

  if (CLEANUP_PROVIDER_STATES.has(agendaItem.lifecycleState)) {
    return cleanupProviderEvent(agendaItem, adapter);
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
    });
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

  // Short-circuit: the item is already synced and nothing we would push has
  // changed since the last successful sync — skip the duplicate-window
  // readback, the direct readback, and the unconditional update PATCH that
  // otherwise fire every 5-minute tick. The fingerprint goes stale after
  // SECRETARY_SYNC_VERIFY_INTERVAL_MINUTES so externally deleted/moved
  // provider events are still detected and healed on the next full pass.
  const fingerprint = computeProviderSyncFingerprint(agendaItem, adapter.source);
  if (
    agendaItem.providerSyncState === 'synced'
    && agendaItem.providerEventId
    && isProviderSyncFingerprintFresh(agendaItem, fingerprint)
  ) {
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

  return upsertProviderEvent(agendaItem, adapter, fingerprint);
}

export async function syncSecretaryAgendaItemsToProvider(
  scope: SecretaryAgendaProviderSyncScope,
  adapter: SecretaryAgendaProviderAdapter,
  options: SecretaryAgendaProviderSyncOptions = {},
): Promise<SecretaryAgendaProviderSyncResult[]> {
  const includeInactive = scope.includeInactive ?? true;
  const items = listSecretaryAgendaItems({
    ownerUserId: scope.ownerUserId,
    tenantId: scope.tenantId,
    includeInactive: true,
  }).filter((item) => shouldSyncAgendaItem(item, includeInactive));
  const results: SecretaryAgendaProviderSyncResult[] = [];
  for (const item of items) {
    results.push(await syncSecretaryAgendaItemToProviderWithRetry({
      agendaItemId: item.agendaItemId,
      ownerUserId: scope.ownerUserId,
      tenantId: scope.tenantId,
    }, adapter, options));
  }
  return results;
}

function shouldSyncAgendaItem(item: SecretaryAgendaItem, includeInactive: boolean): boolean {
  if (isTerminalDeletedCleanupRow(item)) return false;
  if (includeInactive) return true;
  if (!['canceled', 'superseded', 'completed'].includes(item.lifecycleState)) return true;
  return ['canceled', 'superseded'].includes(item.lifecycleState)
    && !!item.providerEventId
    && item.providerSyncState !== 'deleted';
}

function isTerminalDeletedCleanupRow(item: SecretaryAgendaItem): boolean {
  return CLEANUP_PROVIDER_STATES.has(item.lifecycleState)
    && item.providerSyncState === 'deleted'
    && !item.providerEventId;
}

async function syncSecretaryAgendaItemToProviderWithRetry(
  scope: {
    agendaItemId: string;
    ownerUserId: number;
    tenantId: string | number;
  },
  adapter: SecretaryAgendaProviderAdapter,
  options: SecretaryAgendaProviderSyncOptions,
): Promise<SecretaryAgendaProviderSyncResult> {
  const retryBudget = Math.max(0, options.retryBudget ?? DEFAULT_PROVIDER_RETRY_BUDGET);
  let attempt = 0;
  let latest = await syncSecretaryAgendaItemToProvider(scope, adapter);
  while (isRetryableProviderSyncResult(latest) && attempt < retryBudget) {
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
    latest = await syncSecretaryAgendaItemToProvider(scope, adapter);
    attempt += 1;
  }
  return latest;
}

async function upsertProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  fingerprint?: string,
): Promise<SecretaryAgendaProviderSyncResult> {
  const syncedFingerprint = fingerprint ?? computeProviderSyncFingerprint(agendaItem, adapter.source);
  const input = toProviderEventInput(agendaItem);
  const duplicates = await findProviderEventsForAgendaItem(agendaItem, adapter, input);
  const canonical = chooseCanonicalProviderEvent(agendaItem, duplicates);
  const deletedDuplicateEventIds = await deleteDuplicateProviderEvents(canonical, duplicates, adapter, input);

  try {
    if (agendaItem.providerEventId) {
      const current = await readProviderEvent(agendaItem, adapter, input);
      if (current) {
        const updated = await adapter.updateEvent(agendaItem.providerEventId, input);
        updateProviderMapping(agendaItem, {
          providerEventId: updated.eventId,
          providerSource: updated.source,
          providerSyncState: 'synced',
        });
        recordSyncedFingerprint(agendaItem, syncedFingerprint);
        return result(agendaItem, 'updated', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_updated');
      }

      if (canonical) {
        const updated = await adapter.updateEvent(canonical.eventId, input);
        updateProviderMapping(agendaItem, {
          providerEventId: updated.eventId,
          providerSource: updated.source,
          providerSyncState: 'synced',
        });
        recordSyncedFingerprint(agendaItem, syncedFingerprint);
        return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_reattached');
      }

      const recreated = await adapter.createEvent(input);
      updateProviderMapping(agendaItem, {
        providerEventId: recreated.eventId,
        providerSource: recreated.source,
        providerSyncState: 'synced',
      });
      recordSyncedFingerprint(agendaItem, syncedFingerprint);
      return result(agendaItem, 'recreated', recreated.eventId, recreated.source, 'synced', deletedDuplicateEventIds, 'missing_provider_event_recreated');
    }

    if (canonical) {
      const updated = await adapter.updateEvent(canonical.eventId, input);
      updateProviderMapping(agendaItem, {
        providerEventId: updated.eventId,
        providerSource: updated.source,
        providerSyncState: 'synced',
      });
      recordSyncedFingerprint(agendaItem, syncedFingerprint);
      return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'existing_provider_event_attached');
    }

    const created = await adapter.createEvent(input);
    updateProviderMapping(agendaItem, {
      providerEventId: created.eventId,
      providerSource: created.source,
      providerSyncState: 'synced',
    });
    recordSyncedFingerprint(agendaItem, syncedFingerprint);
    return result(agendaItem, 'created', created.eventId, created.source, 'synced', deletedDuplicateEventIds, 'provider_event_created');
  } catch (error) {
    const providerSyncState: SecretaryProviderSyncState = agendaItem.providerEventId || canonical
      ? 'update_failed'
      : 'create_failed';
    updateProviderMapping(agendaItem, { providerSyncState });
    logger.warn({
      err: error instanceof Error ? error.message : String(error),
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
      providerSyncState,
    }, 'Secretary agenda provider sync failed');
    return {
      ...result(agendaItem, 'failed', agendaItem.providerEventId ?? canonical?.eventId ?? null, adapter.source, providerSyncState, deletedDuplicateEventIds, 'provider_sync_failed'),
      retryAfterMs: retryAfterMs(error),
    };
  }
}

async function cleanupProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
): Promise<SecretaryAgendaProviderSyncResult> {
  const input = agendaItem.startAt && agendaItem.endAt ? toProviderEventInput(agendaItem) : null;
  const duplicates = await findProviderEventsForAgendaItem(agendaItem, adapter, input);
  const idsToDelete = unique([
    ...(agendaItem.providerEventId && agendaItem.providerSyncState !== 'deleted' ? [agendaItem.providerEventId] : []),
    ...duplicates.map((event) => event.eventId),
  ]);
  const deletedDuplicateEventIds: string[] = [];

  try {
    for (const eventId of idsToDelete) {
      try {
        await adapter.deleteEvent(eventId, input);
      } catch (err) {
        if (!isProviderEventNotFoundError(err)) throw err;
      }
      if (eventId !== agendaItem.providerEventId) deletedDuplicateEventIds.push(eventId);
    }
    updateProviderMapping(agendaItem, {
      providerSyncState: 'deleted',
      clearProviderLink: true,
    });
    return result(agendaItem, idsToDelete.length > 0 ? 'deleted' : 'skipped', null, adapter.source, 'deleted', deletedDuplicateEventIds, idsToDelete.length > 0 ? 'provider_event_deleted' : 'no_provider_event_to_delete');
  } catch (error) {
    updateProviderMapping(agendaItem, { providerSyncState: 'delete_failed' });
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

async function findProviderEventsForAgendaItem(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput | null,
): Promise<SecretaryProviderEvent[]> {
  if (!adapter.findEventsByAgendaItemId) return [];
  const events = await adapter.findEventsByAgendaItemId(agendaItem.agendaItemId, input);
  return events.filter((event) => event.source === adapter.source && event.agendaItemId === agendaItem.agendaItemId);
}

async function readProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
): Promise<SecretaryProviderEvent | null> {
  if (!agendaItem.providerEventId || !adapter.getEvent) return null;
  const event = await adapter.getEvent(agendaItem.providerEventId, input);
  if (!event) return null;
  if (event.source !== adapter.source || event.agendaItemId !== agendaItem.agendaItemId) return null;
  return event;
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
  canonical: SecretaryProviderEvent | null,
  events: SecretaryProviderEvent[],
  adapter: SecretaryAgendaProviderAdapter,
  input: SecretaryProviderEventInput,
): Promise<string[]> {
  const duplicateIds = unique(events
    .map((event) => event.eventId)
    .filter((eventId) => eventId !== canonical?.eventId));
  for (const eventId of duplicateIds) {
    await adapter.deleteEvent(eventId, input);
  }
  return duplicateIds;
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

function updateProviderMapping(
  agendaItem: Pick<SecretaryAgendaItem, 'agendaItemId' | 'ownerUserId' | 'tenantId'>,
  patch: {
    providerEventId?: string | null;
    providerSource?: SecretaryCalendarProviderSource | null;
    providerSyncState: SecretaryProviderSyncState;
    lifecycleState?: SecretaryAgendaLifecycleState;
    clearProviderLink?: boolean;
  },
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
  const result = getDb().prepare(`
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
        updated_at = ?
    WHERE agenda_item_id = ?
      AND owner_user_id = ?
      AND tenant_id = ?
  `).run(
    clearProviderLink,
    patch.providerEventId ?? null,
    clearProviderLink,
    patch.providerSource ?? null,
    patch.providerSyncState,
    requestedLifecycleIsActive ? 1 : 0,
    lifecycleState,
    new Date().toISOString(),
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
  );
  if (result.changes === 0) {
    throw new Error(`SECRETARY_PROVIDER_MAPPING_UPDATE_MISSED: ${agendaItem.agendaItemId}`);
  }

  // Migration 220: track consecutive failures for the dead-letter skip.
  // Guarded by a column check so pre-migration databases stay functional.
  const isFailedTransition = FAILED_PROVIDER_SYNC_STATES.has(patch.providerSyncState);
  const isSettledTransition = patch.providerSyncState === 'synced' || patch.providerSyncState === 'deleted';
  if (
    (isFailedTransition || isSettledTransition)
    && tableHasColumn(getDb(), 'secretary_agenda_items', 'provider_sync_failure_count')
  ) {
    getDb().prepare(`
      UPDATE secretary_agenda_items
         SET provider_sync_failure_count = CASE WHEN ? THEN provider_sync_failure_count + 1 ELSE 0 END
       WHERE agenda_item_id = ?
         AND owner_user_id = ?
         AND tenant_id = ?
    `).run(
      isFailedTransition ? 1 : 0,
      agendaItem.agendaItemId,
      agendaItem.ownerUserId,
      String(agendaItem.tenantId),
    );
  }
}

function markCancellationReasonedItemCanceled(agendaItem: SecretaryAgendaItem): SecretaryAgendaItem {
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'canceled',
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND cancellation_reason IS NOT NULL
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
  `).run(
    new Date().toISOString(),
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
  );

  if (result.changes === 0) return agendaItem;
  return {
    ...agendaItem,
    lifecycleState: 'canceled',
    updatedAt: new Date().toISOString(),
  };
}

function markUnschedulableTrainingAgendaItemForCleanup(agendaItem: SecretaryAgendaItem): SecretaryAgendaItem | null {
  if (!ACTIVE_PROVIDER_STATES.has(agendaItem.lifecycleState)) return null;
  if (agendaItem.sourceSkill !== 'training' || agendaItem.sourceEntityType !== 'training_session') return null;
  if (!trainingSessionRequiresProviderCleanup(agendaItem)) return null;

  const nowIso = new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE secretary_agenda_items
       SET lifecycle_state = 'unscheduled',
           cancellation_reason = COALESCE(cancellation_reason, 'training_session_unscheduled'),
           updated_at = ?
     WHERE agenda_item_id = ?
       AND owner_user_id = ?
       AND tenant_id = ?
       AND lifecycle_state IN ('scheduled', 'synced', 'reflowed', 'compressed', 'failed_sync')
  `).run(
    nowIso,
    agendaItem.agendaItemId,
    agendaItem.ownerUserId,
    String(agendaItem.tenantId),
  );
  if (result.changes === 0) return null;
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
    if (scoped?.status) return scoped.status;
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

function isRetryableProviderSyncResult(result: SecretaryAgendaProviderSyncResult): boolean {
  return result.action === 'failed'
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
