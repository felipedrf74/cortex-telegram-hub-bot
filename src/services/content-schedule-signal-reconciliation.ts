// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ContentWorkspaceScope } from './content-workspace';
import {
  dismissSignal,
  findActiveScopedSignalIdsByPayloadItemId,
  type IntelligenceBusDatabase,
} from './intelligence-bus';
import type { EventOutboxRecord } from './event-outbox';

export const CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_EVENT =
  'content.schedule_signal_reconciliation.requested.v1' as const;

export class ContentScheduleSignalReconciliationError extends Error {
  readonly code = 'CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_UNAVAILABLE';
  readonly status = 503;
  readonly details = {
    recovery: 'retry_cancellation',
    canonicalCancellationCommitted: true,
    durableReconciliationQueued: true,
    retryable: true,
  } as const;

  constructor() {
    super('The work block was cancelled, but its derived filming signal could not be reconciled. Retry cancellation safely.');
    this.name = 'ContentScheduleSignalReconciliationError';
  }
}

/**
 * Retire filming-lock signals as soon as Secretary confirms that a Content
 * work block no longer has current authority. Weekly mesh reconciliation is a
 * second line of defense, but cancellation must not leave Training or another
 * signal consumer trusting the old block until the next plan refresh.
 */
export function dismissContentFilmingSignalsForItem(
  scope: ContentWorkspaceScope,
  itemId: number,
  options: { database?: IntelligenceBusDatabase } = {},
): number {
  try {
    const signalIds = findActiveScopedSignalIdsByPayloadItemId({
      signalType: 'shoot_day_locked',
      sourceAgent: 'mesh.editorial-coordinator',
      itemId,
      userId: scope.userId,
      tenantId: scope.tenantId,
    }, { strict: true, database: options.database });

    return signalIds.reduce(
      (dismissed, signalId) => dismissed + dismissSignal(
        signalId,
        scope.userId,
        scope.tenantId,
        { strict: true, database: options.database },
      ),
      0,
    );
  } catch (error) {
    if (error instanceof ContentScheduleSignalReconciliationError) throw error;
    throw new ContentScheduleSignalReconciliationError();
  }
}

/** Durable event-outbox consumer for the post-cancellation derived signal. */
export function consumeContentScheduleSignalReconciliationEvent(
  event: EventOutboxRecord,
  database: IntelligenceBusDatabase,
): void {
  const userId = Number(event.userId);
  if (event.eventType !== CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_EVENT
    || event.sourceSkill !== 'content'
    || event.entityType !== 'content_schedule_binding'
    || !Number.isSafeInteger(userId)
    || userId <= 0) {
    throw new Error('content_schedule_signal_reconciliation_event_invalid');
  }
  const bindingId = Number(event.entityId);
  const itemId = Number(event.payload?.itemId);
  if (!Number.isSafeInteger(bindingId) || bindingId <= 0
    || !Number.isSafeInteger(itemId) || itemId <= 0) {
    throw new Error('content_schedule_signal_reconciliation_identity_invalid');
  }
  const binding = database.prepare(`
    SELECT item_id, state, cancellation_idempotency_key
      FROM content_schedule_bindings
     WHERE id = ? AND tenant_id = ? AND owner_user_id = ?
     LIMIT 1
  `).get(bindingId, event.tenantId, userId) as {
    item_id: number;
    state: string;
    cancellation_idempotency_key: string | null;
  } | undefined;
  if (!binding
    || Number(binding.item_id) !== itemId
    || (binding.cancellation_idempotency_key == null && binding.state !== 'cancelled')
    || !['cancel_pending', 'cancel_failed', 'cancelled'].includes(binding.state)) {
    throw new Error('content_schedule_signal_reconciliation_binding_invalid');
  }
  dismissContentFilmingSignalsForItem(
    { tenantId: event.tenantId, userId },
    itemId,
    { database },
  );
}
