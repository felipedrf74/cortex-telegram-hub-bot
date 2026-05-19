// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { getDb } from './database';

export interface AppleHealthSleepSegment {
  stage: string | null;
  start: string;
  end: string;
  minutes: number;
}

export interface AppleHealthSleepCycle {
  start: string;
  end: string;
  minutes: number;
}

export interface AppleHealthSleepAgendaEvent {
  id: string;
  title: string;
  summary: string;
  start: string;
  end: string;
  source: 'apple_health';
  category: 'sleep';
  categories: string[];
  color: string;
  isAllDay: false;
}

export function getAppleHealthSleepAgendaEvents(input: {
  userId: number;
  start: string;
  end: string;
  timezone: string;
}): AppleHealthSleepAgendaEvent[] {
  return getAppleHealthSleepCycles(input).map((cycle) => ({
    id: `apple-health-sleep:${input.userId}:${cycle.start}:${cycle.end}`,
    title: 'Sleep',
    summary: 'Sleep',
    start: cycle.start,
    end: cycle.end,
    source: 'apple_health',
    category: 'sleep',
    categories: ['sleep'],
    color: '#5E5CE6',
    isAllDay: false,
  }));
}

export function getAppleHealthSleepCycles(input: {
  userId: number;
  start: string;
  end: string;
  timezone: string;
}): AppleHealthSleepCycle[] {
  const segments = getAppleHealthSleepSegments(input)
    .map((segment) => ({
      start: DateTime.fromISO(segment.start, { setZone: true }),
      end: DateTime.fromISO(segment.end, { setZone: true }),
    }))
    .filter((segment) => segment.start.isValid && segment.end.isValid && segment.end > segment.start)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const cycles: Array<{ start: DateTime; end: DateTime }> = [];
  const maxStageGapMinutes = 6 * 60;

  for (const segment of segments) {
    const current = cycles[cycles.length - 1];
    if (!current) {
      cycles.push({ ...segment });
      continue;
    }

    const gapMinutes = segment.start.diff(current.end, 'minutes').minutes;
    if (gapMinutes <= maxStageGapMinutes) {
      if (segment.end > current.end) current.end = segment.end;
      continue;
    }

    cycles.push({ ...segment });
  }

  return cycles.map((cycle) => ({
    start: cycle.start.toUTC().toISO()!,
    end: cycle.end.toUTC().toISO()!,
    minutes: Math.round(cycle.end.diff(cycle.start, 'minutes').minutes),
  })).filter((cycle) => cycle.minutes > 0);
}

export function getAppleHealthSleepSegments(input: {
  userId: number;
  start: string;
  end: string;
  timezone: string;
}): AppleHealthSleepSegment[] {
  const rangeStart = parseBoundary(input.start, input.timezone);
  const rangeEnd = parseBoundary(input.end, input.timezone);
  if (!rangeStart?.isValid || !rangeEnd?.isValid || rangeEnd <= rangeStart) return [];

  try {
    const rows = getDb().prepare(`
      SELECT date, data_json
        FROM apple_health_data
       WHERE user_id = ?
         AND data_type = 'sleep'
         AND date BETWEEN ? AND ?
       ORDER BY date ASC
    `).all(
      input.userId,
      rangeStart.setZone(input.timezone).minus({ days: 1 }).toISODate(),
      rangeEnd.setZone(input.timezone).plus({ days: 1 }).toISODate(),
    ) as Array<{ date: string; data_json: string }>;

    const segments: AppleHealthSleepSegment[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const parsed = safeJson(row.data_json);
      const intervals = Array.isArray(parsed?.intervals) ? parsed.intervals : [];
      for (const interval of intervals) {
        const stage = String(interval?.stage || '').trim();
        if (!isAsleepStage(stage)) continue;
        const clipped = clipToRange(interval?.start, interval?.end, rangeStart, rangeEnd, input.timezone);
        if (!clipped) continue;
        appendSegment(segments, seen, {
          stage: stage || null,
          start: clipped.start.toUTC().toISO()!,
          end: clipped.end.toUTC().toISO()!,
          minutes: Math.round(clipped.end.diff(clipped.start, 'minutes').minutes),
        });
      }

      if (segments.length === 0 && typeof parsed?.totalMinutes === 'number' && parsed.totalMinutes > 0) {
        const fallbackEnd = DateTime.fromISO(row.date, { zone: input.timezone }).plus({ hours: 7 });
        const fallbackStart = fallbackEnd.minus({ minutes: parsed.totalMinutes });
        const clipped = clipToRange(fallbackStart.toISO(), fallbackEnd.toISO(), rangeStart, rangeEnd, input.timezone);
        if (clipped) {
          appendSegment(segments, seen, {
            stage: null,
            start: clipped.start.toUTC().toISO()!,
            end: clipped.end.toUTC().toISO()!,
            minutes: Math.round(clipped.end.diff(clipped.start, 'minutes').minutes),
          });
        }
      }
    }

    return segments.sort((a, b) => a.start.localeCompare(b.start));
  } catch {
    return [];
  }
}

function appendSegment(segments: AppleHealthSleepSegment[], seen: Set<string>, segment: AppleHealthSleepSegment) {
  if (segment.minutes <= 0) return;
  const key = `${segment.start}|${segment.end}|${segment.stage || ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  segments.push(segment);
}

function isAsleepStage(stage: string): boolean {
  const normalized = stage.toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('awake')) return false;
  if (normalized.includes('inbed') || normalized.includes('in_bed') || normalized.includes('in bed')) return false;
  return normalized.includes('sleep') || normalized.includes('asleep');
}

function clipToRange(
  startRaw: unknown,
  endRaw: unknown,
  rangeStart: DateTime,
  rangeEnd: DateTime,
  timezone: string,
): { start: DateTime; end: DateTime } | null {
  const start = parseBoundary(startRaw, timezone);
  const end = parseBoundary(endRaw, timezone);
  if (!start?.isValid || !end?.isValid || end <= start) return null;
  const clippedStart = start < rangeStart ? rangeStart : start;
  const clippedEnd = end > rangeEnd ? rangeEnd : end;
  if (clippedEnd <= clippedStart) return null;
  return { start: clippedStart, end: clippedEnd };
}

function parseBoundary(value: unknown, timezone: string): DateTime | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return DateTime.fromISO(raw, { zone: timezone }).startOf('day');
  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (parsed.isValid) return parsed.setZone(timezone);
  const local = DateTime.fromISO(raw, { zone: timezone });
  return local.isValid ? local : null;
}

function safeJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
