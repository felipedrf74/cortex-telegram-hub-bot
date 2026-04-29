// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  deleteEvent,
  type CalendarSource,
} from './unified-calendar';
import {
  findOrphanedOwnerships,
  findOwnershipsNeedingReconciliation,
  markCalendarOwnershipDeleted,
  type AgendaEventOwnership,
} from './training-plan-lifecycle';
import { logger } from '../utils/logger';

export interface TrainingAgendaReconciliationResult {
  attempted: number;
  deleted: number;
  failed: number;
}

function isCalendarSource(value: string): value is CalendarSource {
  return value === 'google' || value === 'outlook';
}

/**
 * Retry precise deletion of calendar events whose original plan
 * cancellation succeeded locally but failed at the provider. This is
 * deliberately ownership-table driven: no date-range sweeps, no broad
 * title matching, and no chance of deleting unrelated calendar items.
 */
export async function reconcileOrphanedTrainingAgendaEvents(
  userId: number,
  tenantId = userId,
): Promise<TrainingAgendaReconciliationResult> {
  const ownerships = mergeOwnershipQueues([
    ...findOwnershipsNeedingReconciliation(userId, tenantId),
    ...findOrphanedOwnerships(userId, tenantId),
  ]);
  let deleted = 0;
  let failed = 0;

  for (const ownership of ownerships) {
    if (!isCalendarSource(ownership.calendar_source)) {
      failed += 1;
      logger.warn(
        { userId, ownershipId: ownership.id, source: ownership.calendar_source },
        'Skipping training agenda orphan with unsupported calendar source',
      );
      continue;
    }

    try {
      await deleteEvent(ownership.calendar_event_id, ownership.calendar_source, userId);
      const marked = markCalendarOwnershipDeleted({
        eventId: ownership.calendar_event_id,
        source: ownership.calendar_source,
        reason: 'orphan_reconciled',
        status: 'deleted',
        userId,
        tenantId,
        planId: ownership.plan_id,
        ownershipId: ownership.id,
      });
      if (marked.rowsAffected > 0) {
        deleted += 1;
      }
    } catch (err) {
      failed += 1;
      if (ownership.status === 'active') {
        markCalendarOwnershipDeleted({
          eventId: ownership.calendar_event_id,
          source: ownership.calendar_source,
          reason: 'orphan_reconcile_delete_failed',
          status: 'orphaned',
          userId,
          tenantId,
          planId: ownership.plan_id,
          ownershipId: ownership.id,
        });
      }
      logger.warn(
        {
          err,
          userId,
          ownershipId: ownership.id,
          eventId: ownership.calendar_event_id,
          source: ownership.calendar_source,
        },
        'Failed to reconcile orphaned training calendar event',
      );
    }
  }

  return {
    attempted: ownerships.length,
    deleted,
    failed,
  };
}

function mergeOwnershipQueues(ownerships: AgendaEventOwnership[]): AgendaEventOwnership[] {
  const byId = new Map<number, AgendaEventOwnership>();
  for (const ownership of ownerships) {
    byId.set(ownership.id, ownership);
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.deleted_at ?? left.created_at);
    const rightTime = Date.parse(right.deleted_at ?? right.created_at);
    const safeLeft = Number.isFinite(leftTime) ? leftTime : 0;
    const safeRight = Number.isFinite(rightTime) ? rightTime : 0;
    return safeLeft - safeRight || left.id - right.id;
  });
}
