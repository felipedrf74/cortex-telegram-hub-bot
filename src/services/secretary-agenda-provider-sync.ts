// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  getSecretaryAgendaItemById,
  listSecretaryAgendaItems,
  type SecretaryAgendaItem,
  type SecretaryAgendaLifecycleState,
  type SecretaryProviderSyncState,
} from './secretary-scheduling-arbitrator';
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
}

export interface SecretaryAgendaProviderSyncScope {
  ownerUserId: number;
  tenantId: string | number;
  includeInactive?: boolean;
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
    updateProviderMapping(agendaItem.agendaItemId, {
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

  return upsertProviderEvent(agendaItem, adapter);
}

export async function syncSecretaryAgendaItemsToProvider(
  scope: SecretaryAgendaProviderSyncScope,
  adapter: SecretaryAgendaProviderAdapter,
): Promise<SecretaryAgendaProviderSyncResult[]> {
  const items = listSecretaryAgendaItems({
    ownerUserId: scope.ownerUserId,
    tenantId: scope.tenantId,
    includeInactive: scope.includeInactive ?? true,
  });
  const results: SecretaryAgendaProviderSyncResult[] = [];
  for (const item of items) {
    results.push(await syncSecretaryAgendaItemToProvider({
      agendaItemId: item.agendaItemId,
      ownerUserId: scope.ownerUserId,
      tenantId: scope.tenantId,
    }, adapter));
  }
  return results;
}

async function upsertProviderEvent(
  agendaItem: SecretaryAgendaItem,
  adapter: SecretaryAgendaProviderAdapter,
): Promise<SecretaryAgendaProviderSyncResult> {
  const input = toProviderEventInput(agendaItem);
  const duplicates = await findProviderEventsForAgendaItem(agendaItem, adapter, input);
  const canonical = chooseCanonicalProviderEvent(agendaItem, duplicates);
  const deletedDuplicateEventIds = await deleteDuplicateProviderEvents(canonical, duplicates, adapter, input);

  try {
    if (agendaItem.providerEventId) {
      const current = await readProviderEvent(agendaItem, adapter, input);
      if (current) {
        const updated = await adapter.updateEvent(agendaItem.providerEventId, input);
        updateProviderMapping(agendaItem.agendaItemId, {
          providerEventId: updated.eventId,
          providerSource: updated.source,
          providerSyncState: 'synced',
        });
        return result(agendaItem, 'updated', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_updated');
      }

      if (canonical) {
        const updated = await adapter.updateEvent(canonical.eventId, input);
        updateProviderMapping(agendaItem.agendaItemId, {
          providerEventId: updated.eventId,
          providerSource: updated.source,
          providerSyncState: 'synced',
        });
        return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'provider_event_reattached');
      }

      const recreated = await adapter.createEvent(input);
      updateProviderMapping(agendaItem.agendaItemId, {
        providerEventId: recreated.eventId,
        providerSource: recreated.source,
        providerSyncState: 'synced',
      });
      return result(agendaItem, 'recreated', recreated.eventId, recreated.source, 'synced', deletedDuplicateEventIds, 'missing_provider_event_recreated');
    }

    if (canonical) {
      const updated = await adapter.updateEvent(canonical.eventId, input);
      updateProviderMapping(agendaItem.agendaItemId, {
        providerEventId: updated.eventId,
        providerSource: updated.source,
        providerSyncState: 'synced',
      });
      return result(agendaItem, 'attached', updated.eventId, updated.source, 'synced', deletedDuplicateEventIds, 'existing_provider_event_attached');
    }

    const created = await adapter.createEvent(input);
    updateProviderMapping(agendaItem.agendaItemId, {
      providerEventId: created.eventId,
      providerSource: created.source,
      providerSyncState: 'synced',
    });
    return result(agendaItem, 'created', created.eventId, created.source, 'synced', deletedDuplicateEventIds, 'provider_event_created');
  } catch (error) {
    const providerSyncState: SecretaryProviderSyncState = agendaItem.providerEventId || canonical
      ? 'update_failed'
      : 'create_failed';
    updateProviderMapping(agendaItem.agendaItemId, { providerSyncState });
    logger.warn({
      err: error instanceof Error ? error.message : String(error),
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
      providerSyncState,
    }, 'Secretary agenda provider sync failed');
    return result(agendaItem, 'failed', agendaItem.providerEventId ?? canonical?.eventId ?? null, adapter.source, providerSyncState, deletedDuplicateEventIds, 'provider_sync_failed');
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
      await adapter.deleteEvent(eventId, input);
      if (eventId !== agendaItem.providerEventId) deletedDuplicateEventIds.push(eventId);
    }
    updateProviderMapping(agendaItem.agendaItemId, {
      providerSyncState: 'deleted',
    });
    return result(agendaItem, idsToDelete.length > 0 ? 'deleted' : 'skipped', agendaItem.providerEventId, adapter.source, 'deleted', deletedDuplicateEventIds, idsToDelete.length > 0 ? 'provider_event_deleted' : 'no_provider_event_to_delete');
  } catch (error) {
    updateProviderMapping(agendaItem.agendaItemId, { providerSyncState: 'delete_failed' });
    logger.warn({
      err: error instanceof Error ? error.message : String(error),
      agendaItemId: agendaItem.agendaItemId,
      providerSource: adapter.source,
    }, 'Secretary agenda provider cleanup failed');
    return result(agendaItem, 'failed', agendaItem.providerEventId, adapter.source, 'delete_failed', deletedDuplicateEventIds, 'provider_delete_failed');
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
  if (agendaItem.providerEventId) {
    const current = events.find((event) => event.eventId === agendaItem.providerEventId);
    if (current) return current;
  }
  return [...events].sort((left, right) => left.eventId.localeCompare(right.eventId))[0] ?? null;
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
  agendaItemId: string,
  patch: {
    providerEventId?: string | null;
    providerSource?: SecretaryCalendarProviderSource | null;
    providerSyncState: SecretaryProviderSyncState;
    lifecycleState?: SecretaryAgendaLifecycleState;
  },
): void {
  const lifecycleState = patch.lifecycleState
    ?? (patch.providerSyncState === 'synced'
      ? 'synced'
      : FAILED_PROVIDER_SYNC_STATES.has(patch.providerSyncState)
        ? 'failed_sync'
        : null);
  getDb().prepare(`
    UPDATE secretary_agenda_items
    SET provider_event_id = COALESCE(?, provider_event_id),
        provider_source = COALESCE(?, provider_source),
        provider_sync_state = ?,
        lifecycle_state = COALESCE(?, lifecycle_state),
        updated_at = ?
    WHERE agenda_item_id = ?
  `).run(
    patch.providerEventId ?? null,
    patch.providerSource ?? null,
    patch.providerSyncState,
    lifecycleState,
    new Date().toISOString(),
    agendaItemId,
  );
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
