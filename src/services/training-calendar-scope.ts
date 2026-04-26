// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';

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
  userId: number;
  planStatus: string;
}

export function getTrainingCalendarEventOwners(
  eventId: string | null | undefined,
  source?: string | null,
): TrainingCalendarEventOwner[] {
  const normalizedEventId = normalizeEventId(eventId);
  if (!normalizedEventId) return [];

  try {
    const db = getDb();
    const normalizedSource = normalizeCalendarSource(source);
    const rows = normalizedSource
      ? db.prepare(`
          SELECT
            ts.calendar_event_id AS eventId,
            ts.calendar_source AS source,
            ts.id AS sessionId,
            ts.plan_id AS planId,
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
            ftp.user_id AS userId,
            ftp.status AS planStatus
          FROM training_sessions ts
          JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
          WHERE ts.calendar_event_id = ?
        `).all(normalizedEventId);

    return rows.map(normalizeOwnerRow).filter(Boolean) as TrainingCalendarEventOwner[];
  } catch (err) {
    logger.debug({ err, eventId: normalizedEventId, source }, 'Training calendar scope lookup failed');
    return [];
  }
}

export function isTrainingCalendarEventUnclaimed(
  eventId: string | null | undefined,
  source?: string | null,
): boolean {
  return getTrainingCalendarEventOwners(eventId, source).length === 0;
}

export function filterCalendarEventsForTrainingScope<T extends CalendarEventLike>(
  events: T[],
  userId: number,
): T[] {
  if (!Array.isArray(events) || events.length === 0) return events;
  if (!Number.isFinite(userId) || userId <= 0) return events;

  const eventIds = Array.from(new Set(events.map((event) => normalizeEventId(event.id)).filter(Boolean))) as string[];
  if (eventIds.length === 0) return events;

  try {
    const db = getDb();
    const placeholders = eventIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        ts.calendar_event_id AS eventId,
        ts.calendar_source AS source,
        ts.id AS sessionId,
        ts.plan_id AS planId,
        ftp.user_id AS userId,
        ftp.status AS planStatus
      FROM training_sessions ts
      JOIN fitness_training_plans ftp ON ftp.id = ts.plan_id
      WHERE ts.calendar_event_id IN (${placeholders})
    `).all(...eventIds);

    const ownersById = new Map<string, TrainingCalendarEventOwner[]>();
    for (const rawRow of rows) {
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

      return scopedOwners.some((owner) => owner.userId === userId && owner.planStatus === 'active');
    });
  } catch (err) {
    logger.debug({ err, userId }, 'Training calendar scope filtering failed');
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
  const userId = Number(candidate.userId);
  if (!eventId || !Number.isFinite(sessionId) || !Number.isFinite(planId) || !Number.isFinite(userId)) {
    return null;
  }

  return {
    eventId,
    source: normalizeCalendarSource(candidate.source as string | null | undefined),
    sessionId,
    planId,
    userId,
    planStatus: String(candidate.planStatus || '').toLowerCase(),
  };
}
