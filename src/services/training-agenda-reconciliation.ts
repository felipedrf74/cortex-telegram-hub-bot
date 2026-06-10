// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  type CalendarSource,
  getEvents,
  type UnifiedCalendarEvent,
} from './unified-calendar';
import {
  findOrphanedOwnerships,
  findOwnershipsNeedingReconciliation,
  markCalendarOwnershipDeleted,
  type AgendaEventOwnership,
} from './training-plan-lifecycle';
import { getPlanById } from './training-plans';
import { isProviderEventNotFoundError } from './training-calendar-errors';
import { logger } from '../utils/logger';
import { deleteTrainingCalendarEventWithRetry } from './training-calendar-provider-retry';
import { getUserTimezoneById } from './user-service';
import { DateTime } from 'luxon';
import { requireTenantIdParam } from './tenant-scope';

export interface TrainingAgendaReconciliationResult {
  attempted: number;
  deleted: number;
  failed: number;
}

const LEGACY_MARKER_LOOKBACK_DAYS = 14;
const LEGACY_MARKER_LOOKAHEAD_DAYS = 90;

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
  tenantId: number,
): Promise<TrainingAgendaReconciliationResult> {
  const scopedTenantId = requireTenantIdParam(tenantId, 'reconcileOrphanedTrainingAgendaEvents');
  const ownerships = mergeOwnershipQueues([
    ...findOwnershipsNeedingReconciliation(userId, scopedTenantId),
    ...findOrphanedOwnerships(userId, scopedTenantId),
  ]);
  const ownershipKeys = new Set(ownerships.map((ownership) =>
    ownershipKey(ownership.calendar_event_id, ownership.calendar_source)));
  const legacyMarkerEvents = await findStaleLegacyMarkerEvents(userId, ownershipKeys);
  let deleted = 0;
  let failed = 0;

  for (const target of [
    ...ownerships.map((ownership) => ({ kind: 'ownership' as const, ownership })),
    ...legacyMarkerEvents.map((event) => ({ kind: 'legacy_marker' as const, event })),
  ]) {
    const eventId = target.kind === 'ownership' ? target.ownership.calendar_event_id : target.event.id;
    const source = target.kind === 'ownership' ? target.ownership.calendar_source : target.event.source;
    if (!eventId || !isCalendarSource(source)) {
      failed += 1;
      logger.warn(
        {
          userId,
          ownershipId: target.kind === 'ownership' ? target.ownership.id : undefined,
          source,
        },
        'Skipping training agenda orphan with unsupported calendar source',
      );
      continue;
    }

    try {
      await deleteTrainingCalendarEventWithRetry(
        eventId,
        source,
        userId,
        target.kind === 'ownership' ? {
          userId,
          tenantId: scopedTenantId,
          planId: target.ownership.plan_id,
          ownershipId: target.ownership.id,
          eventId,
          source,
        } : {
          userId,
          tenantId: scopedTenantId,
          planId: target.event.planId,
          eventId,
          source,
        },
      );
      if (target.kind === 'ownership') {
        const marked = markCalendarOwnershipDeleted({
          eventId,
          source,
          reason: 'orphan_reconciled',
          status: 'deleted',
          userId,
          tenantId: scopedTenantId,
          planId: target.ownership.plan_id,
          ownershipId: target.ownership.id,
        });
        if (marked.rowsAffected > 0) {
          deleted += 1;
        }
      } else {
        deleted += 1;
      }
    } catch (err) {
      if (isProviderEventNotFoundError(err)) {
        if (target.kind === 'ownership') {
          const marked = markCalendarOwnershipDeleted({
            eventId,
            source,
            reason: 'orphan_reconciled_event_gone_upstream',
            status: 'deleted',
            userId,
            tenantId: scopedTenantId,
            planId: target.ownership.plan_id,
            ownershipId: target.ownership.id,
          });
          if (marked.rowsAffected > 0) {
            deleted += 1;
          }
        } else {
          deleted += 1;
        }
        continue;
      }

      failed += 1;
      if (target.kind === 'ownership' && target.ownership.status === 'active') {
        markCalendarOwnershipDeleted({
          eventId,
          source,
          reason: 'orphan_reconcile_delete_failed',
          status: 'orphaned',
          userId,
          tenantId: scopedTenantId,
          planId: target.ownership.plan_id,
          ownershipId: target.ownership.id,
        });
      }
      logger.warn(
        {
          err,
          userId,
          ownershipId: target.kind === 'ownership' ? target.ownership.id : undefined,
          planId: target.kind === 'legacy_marker' ? target.event.planId : target.ownership.plan_id,
          eventId,
          source,
        },
        'Failed to reconcile orphaned training calendar event',
      );
    }
  }

  return {
    attempted: ownerships.length + legacyMarkerEvents.length,
    deleted,
    failed,
  };
}

type LegacyTrainingMarkerEvent = {
  id: string;
  source: CalendarSource;
  planId: number;
};

async function findStaleLegacyMarkerEvents(
  userId: number,
  ownershipKeys: Set<string>,
): Promise<LegacyTrainingMarkerEvent[]> {
  try {
    const timezone = getUserTimezoneById(userId);
    const now = DateTime.now().setZone(timezone);
    const start = now.startOf('day').minus({ days: LEGACY_MARKER_LOOKBACK_DAYS }).toUTC().toISO()!;
    const end = now.startOf('day').plus({ days: LEGACY_MARKER_LOOKAHEAD_DAYS }).toUTC().toISO()!;
    const events = await getEvents(start, end, userId);
    const results: LegacyTrainingMarkerEvent[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (!event.id || !isCalendarSource(event.source)) continue;
      const key = ownershipKey(event.id, event.source);
      if (ownershipKeys.has(key) || seen.has(key)) continue;
      const planId = extractLegacyTrainingPlanId(event);
      if (!planId || isActivePlanForUser(planId, userId)) continue;
      seen.add(key);
      results.push({ id: event.id, source: event.source, planId });
    }
    return results;
  } catch (err) {
    logger.debug(
      { err, userId },
      'Training agenda legacy-marker scan skipped',
    );
    return [];
  }
}

function extractLegacyTrainingPlanId(event: UnifiedCalendarEvent): number | null {
  const text = String(event.description || '');
  const secretary = text.match(/^NEXUS_SECRETARY_SOURCE_INTENT:training:(\d+):(\d+):(\d+)$/mi);
  if (secretary) return positiveInt(secretary[1]);
  const direct = text.match(/\[NEXUS_TRAINING_IDENTITY\s+([^\]]+)\]/i);
  if (!direct) return null;
  const plan = direct[1]?.match(/(?:^|;)plan=(\d+)(?:;|$)/i);
  return plan ? positiveInt(plan[1]) : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function isActivePlanForUser(planId: number, userId: number): boolean {
  const plan = getPlanById(planId);
  return Number(plan?.user_id) === userId && String(plan?.status || '').toLowerCase() === 'active';
}

function ownershipKey(eventId: string | null | undefined, source: string | null | undefined): string {
  return `${String(source || '').trim().toLowerCase()}|${String(eventId || '').trim()}`;
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
