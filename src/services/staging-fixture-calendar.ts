// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import {
  isProductionRuntime,
  isStagingFixtureUserId,
} from './staging-fixture-safety';
import type { UnifiedCalendarEvent } from './unified-calendar';

const TABLE_NAME = 'staging_fixture_calendar_events';

function tableExists(): boolean {
  try {
    return Boolean(getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(TABLE_NAME));
  } catch {
    return false;
  }
}

function fixtureCalendarEnabledForUser(userId?: number): userId is number {
  return isStagingFixtureUserId(userId) && !isProductionRuntime();
}

export function hasStagingFixtureCalendarEventsForUser(userId?: number): boolean {
  if (!fixtureCalendarEnabledForUser(userId) || !tableExists()) return false;
  try {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAME} WHERE user_id = ?`)
      .get(userId) as { count?: number } | undefined;
    return Number(row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

export function getStagingFixtureCalendarEvents(
  startDate: string,
  endDate: string,
  userId?: number,
): UnifiedCalendarEvent[] {
  if (!fixtureCalendarEnabledForUser(userId) || !tableExists()) return [];
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const rows = getDb().prepare(`
    SELECT
      event_id,
      title,
      start_at,
      end_at,
      description,
      location,
      categories_json,
      color,
      is_all_day
    FROM ${TABLE_NAME}
    WHERE user_id = ?
      AND start_at < ?
      AND end_at > ?
    ORDER BY start_at ASC, event_id ASC
  `).all(userId, new Date(endMs).toISOString(), new Date(startMs).toISOString()) as Array<{
    event_id: string;
    title: string;
    start_at: string;
    end_at: string;
    description?: string | null;
    location?: string | null;
    categories_json?: string | null;
    color?: string | null;
    is_all_day?: number | null;
  }>;

  return rows.map((row) => {
    let categories: string[] | undefined;
    try {
      const parsed = JSON.parse(row.categories_json || '[]');
      categories = Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : undefined;
    } catch {
      categories = undefined;
    }

    return {
      id: row.event_id,
      summary: row.title || 'Fixture calendar event',
      start: row.start_at,
      end: row.end_at,
      description: row.description || undefined,
      location: row.location || undefined,
      categories,
      color: row.color || undefined,
      isAllDay: row.is_all_day === 1,
      source: 'outlook',
    };
  });
}
