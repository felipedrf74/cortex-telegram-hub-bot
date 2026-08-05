// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import type { EventOutboxRecord } from './event-outbox';
import { getSecretaryAgendaItemById } from './secretary-scheduling-arbitrator';
import { createNotificationIntent } from './notification-orchestrator';
import { invalidateCookingDerivedCaches } from './cache-coherence-registry';

export const COOKING_MEAL_PREP_PROVIDER_SYNC_COMPLETED_EVENT_TYPE =
  'cooking.meal_prep_provider_sync.completed.v1' as const;

/**
 * Durable outbox completion effect for both synchronous route creates and
 * later cron reconciliation. Payload contains scoped IDs only; all user-facing
 * fields and provider ownership are re-read from the authoritative agenda row.
 */
export async function consumeCookingMealPrepProviderSyncCompleted(
  event: EventOutboxRecord,
  _db: Database.Database,
): Promise<void> {
  if (
    event.eventType !== COOKING_MEAL_PREP_PROVIDER_SYNC_COMPLETED_EVENT_TYPE
    || event.sourceSkill !== 'cooking'
    || event.entityType !== 'secretary_agenda_item'
    || !event.userId
  ) {
    throw new Error('COOKING_PROVIDER_SYNC_COMPLETION_EVENT_INVALID');
  }
  const agendaTenantId = String(event.payload?.agendaTenantId ?? '').trim();
  if (!agendaTenantId) throw new Error('COOKING_PROVIDER_SYNC_COMPLETION_TENANT_REQUIRED');
  const agenda = getSecretaryAgendaItemById({
    agendaItemId: event.entityId,
    ownerUserId: event.userId,
    tenantId: agendaTenantId,
  });
  if (
    !agenda
    || agenda.version !== event.entityVersion
    || agenda.sourceSkill !== 'cooking'
    || agenda.sourceEntityType !== 'meal_prep_block'
    || agenda.providerSyncState !== 'synced'
    || !agenda.providerEventId
    || !agenda.providerSource
    || agenda.providerTarget !== agenda.providerSource
  ) {
    throw new Error('COOKING_PROVIDER_SYNC_COMPLETION_AGENDA_MISMATCH');
  }
  const notificationTenantId = Number(agenda.tenantId);
  if (!Number.isSafeInteger(notificationTenantId) || notificationTenantId <= 0) {
    throw new Error('COOKING_PROVIDER_SYNC_COMPLETION_TENANT_INVALID');
  }

  await createNotificationIntent({
    userId: agenda.ownerUserId,
    tenantId: notificationTenantId,
    sourceSkill: 'cooking',
    type: 'reminder',
    priority: 'passive',
    deliveryPolicy: 'in_app_only',
    relatedEntityId: agenda.providerEventId,
    relatedEntityType: 'meal_prep_block',
    title: 'Meal prep scheduled',
    body: 'Your meal prep block was added to your calendar.',
    actionButtons: [
      { id: 'open_detail', label: 'Open', style: 'primary' },
      { id: 'dismiss', label: 'Not now', style: 'secondary' },
    ],
    deeplink: `nexus://cooking/meal-plan/${encodeURIComponent(agenda.sourceEntityId ?? '')}`,
    dedupeKey: `cooking:meal-prep-provider-sync:${agenda.agendaItemId}:${agenda.version}:${agenda.providerSource}:${agenda.providerEventId}`,
    privacyPolicy: 'standard',
  });
  // Cache invalidation is intentionally after the durable/deduped notification
  // write. If the event lease is replayed, both operations remain idempotent.
  invalidateCookingDerivedCaches(agenda.ownerUserId, { includeCalendarSurfaces: true });
}
