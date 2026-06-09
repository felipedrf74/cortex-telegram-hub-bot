// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import { requireTenantIdParam } from './tenant-scope';

type CalendarSource = 'google' | 'outlook';

type CalendarEventLike = {
  id?: string | null;
  source?: string | null;
};

export interface TrainingCalendarEventOwner {
  eventId: string;
  source: string | null;
  sessionId: number;
  planId: number;
  tenantId: number;
  userId: number;
  planStatus: string;
}

export function getTrainingCalendarEventOwners(
  eventId: string | null | undefined,
  source?: string | null,
  tenantId?: number,
): TrainingCalendarEventOwner[] {
  const normalizedEventId = normalizeEventId(eventId);
  if (!normalizedEventId) return [];
  const scopedTenantId = requireTenantIdParam(tenantId, 'getTrainingCalendarEventOwners');

  try {
    const db = getDb();
    const normalizedSource = normalizeCalendarSource(source);
    const sessionRows = normalizedSource
      ? db.prepare(`
          SELECT
            ts.calendar_event_id AS eventId,
            ts.calendar_source AS source,
            ts.id AS sessionId,
            ts.plan_id AS planId,
            ftp.tenant_id AS tenantId,
            ftp.user_id AS userId,
            ftp.status AS planStatus
          FROM training_sessions ts
          JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
          WHERE ts.calendar_event_id = ?
            AND (ts.calendar_source = ? OR ts.calendar_source IS NULL)
        `).all(normalizedEventId, normalizedSource)
      : db.prepare(`
          SELECT
            ts.calendar_event_id AS eventId,
            ts.calendar_source AS source,
            ts.id AS sessionId,
            ts.plan_id AS planId,
            ftp.tenant_id AS tenantId,
            ftp.user_id AS userId,
            ftp.status AS planStatus
          FROM training_sessions ts
          JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
          WHERE ts.calendar_event_id = ?
        `).all(normalizedEventId);
    const ownershipRows = normalizedSource
      ? db.prepare(`
          SELECT
            o.calendar_event_id AS eventId,
            o.calendar_source AS source,
            COALESCE(o.session_id, 0) AS sessionId,
            o.plan_id AS planId,
            o.tenant_id AS tenantId,
            o.user_id AS userId,
            COALESCE(ftp.status, 'missing') AS planStatus
          FROM training_agenda_event_ownership o
          LEFT JOIN fitness_training_plans ftp
            ON ftp.id = o.plan_id
           AND ftp.user_id = o.user_id
          WHERE o.calendar_event_id = ?
            AND o.calendar_source = ?
            AND o.status IN ('active', 'orphaned')
        `).all(normalizedEventId, normalizedSource)
      : db.prepare(`
          SELECT
            o.calendar_event_id AS eventId,
            o.calendar_source AS source,
            COALESCE(o.session_id, 0) AS sessionId,
            o.plan_id AS planId,
            o.tenant_id AS tenantId,
            o.user_id AS userId,
            COALESCE(ftp.status, 'missing') AS planStatus
          FROM training_agenda_event_ownership o
          LEFT JOIN fitness_training_plans ftp
            ON ftp.id = o.plan_id
           AND ftp.user_id = o.user_id
          WHERE o.calendar_event_id = ?
            AND o.status IN ('active', 'orphaned')
        `).all(normalizedEventId);

    return dedupeOwners(
      [...sessionRows, ...ownershipRows].map(normalizeOwnerRow).filter(Boolean) as TrainingCalendarEventOwner[],
    );
  } catch (err) {
    logger.debug({ err, eventId: normalizedEventId, source, tenantId: scopedTenantId }, 'Training calendar scope lookup failed');
    return [];
  }
}

export function isTrainingCalendarEventUnclaimed(
  eventId: string | null | undefined,
  source?: string | null,
  tenantId?: number,
): boolean {
  return getTrainingCalendarEventOwners(eventId, source, tenantId).length === 0;
}

export function filterCalendarEventsForTrainingScope<T extends CalendarEventLike>(
  events: T[],
  userId: number,
  tenantId?: number,
): T[] {
  if (!Array.isArray(events) || events.length === 0) return events;
  if (!Number.isFinite(userId) || userId <= 0) return events;
  const scopedTenantId = requireTenantIdParam(tenantId, 'filterCalendarEventsForTrainingScope');

  const eventIds = Array.from(new Set(events.map((event) => normalizeEventId(event.id)).filter(Boolean))) as string[];
  if (eventIds.length === 0) return events;

  try {
    const db = getDb();
    const placeholders = eventIds.map(() => '?').join(',');
    const sessionRows = db.prepare(`
      SELECT
        ts.calendar_event_id AS eventId,
        ts.calendar_source AS source,
        ts.id AS sessionId,
        ts.plan_id AS planId,
        ftp.tenant_id AS tenantId,
        ftp.user_id AS userId,
        ftp.status AS planStatus
      FROM training_sessions ts
      JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
      WHERE ts.calendar_event_id IN (${placeholders})
    `).all(...eventIds);
    const ownershipRows = db.prepare(`
      SELECT
        o.calendar_event_id AS eventId,
        o.calendar_source AS source,
        COALESCE(o.session_id, 0) AS sessionId,
        o.plan_id AS planId,
        o.tenant_id AS tenantId,
        o.user_id AS userId,
        COALESCE(ftp.status, 'missing') AS planStatus
      FROM training_agenda_event_ownership o
      LEFT JOIN fitness_training_plans ftp
        ON ftp.id = o.plan_id
       AND ftp.user_id = o.user_id
      WHERE o.calendar_event_id IN (${placeholders})
        AND o.status IN ('active', 'orphaned')
    `).all(...eventIds);

    const ownersById = new Map<string, TrainingCalendarEventOwner[]>();
    for (const rawRow of [...sessionRows, ...ownershipRows]) {
      const owner = normalizeOwnerRow(rawRow);
      if (!owner) continue;
      const list = ownersById.get(owner.eventId) ?? [];
      list.push(owner);
      ownersById.set(owner.eventId, list);
    }

    return events.filter((event) => {
      const eventId = normalizeEventId(event.id);
      if (!eventId) return true;
      const owners = ownersById.get(eventId) ?? [];
      if (owners.length === 0) return true;

      const source = normalizeCalendarSource(event.source);
      const scopedOwners = source
        ? owners.filter((owner) => owner.source === source || owner.source === null)
        : owners;
      if (scopedOwners.length === 0) return true;

      return scopedOwners.some((owner) =>
        owner.userId === userId
        && owner.tenantId === scopedTenantId
        && owner.planStatus === 'active'
      );
    });
  } catch (err) {
    logger.debug({ err, userId, tenantId: scopedTenantId }, 'Training calendar scope filtering failed');
    return events;
  }
}

function normalizeEventId(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

function normalizeCalendarSource(value: string | null | undefined): CalendarSource | null {
  return value === 'google' || value === 'outlook' ? value : null;
}

function normalizeOwnerRow(row: unknown): TrainingCalendarEventOwner | null {
  const candidate = row as Record<string, unknown>;
  const eventId = normalizeEventId(candidate.eventId as string | null | undefined);
  const sessionId = Number(candidate.sessionId);
  const planId = Number(candidate.planId);
  const tenantId = Number(candidate.tenantId);
  const userId = Number(candidate.userId);
  if (
    !eventId
    || !Number.isFinite(sessionId)
    || !Number.isFinite(planId)
    || !Number.isFinite(tenantId)
    || !Number.isFinite(userId)
  ) {
    return null;
  }

  return {
    eventId,
    source: normalizeCalendarSource(candidate.source as string | null | undefined),
    sessionId,
    planId,
    tenantId,
    userId,
    planStatus: String(candidate.planStatus || '').toLowerCase(),
  };
}

function dedupeOwners(owners: TrainingCalendarEventOwner[]): TrainingCalendarEventOwner[] {
  const seen = new Set<string>();
  const result: TrainingCalendarEventOwner[] = [];
  for (const owner of owners) {
    const key = [
      owner.eventId,
      owner.source ?? '',
      owner.sessionId,
      owner.planId,
      owner.tenantId,
      owner.userId,
      owner.planStatus,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(owner);
  }
  return result;
}
