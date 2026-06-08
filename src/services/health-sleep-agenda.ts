// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { getDb } from './database';
import { appleHealthJsonSelectColumns, parseAppleHealthDataJson } from './apple-health-encryption';

export interface AppleHealthSleepSegment {
  stage: string | null;
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

const SLEEP_WINDOW_GAP_MINUTES = 45;

type AppleHealthAgendaRow = {
  date: string;
  data_type: string;
  data_json: string;
  encrypted_data_json?: string | null;
};

export function getAppleHealthSleepAgendaEvents(input: {
  userId: number;
  start: string;
  end: string;
  timezone: string;
}): AppleHealthSleepAgendaEvent[] {
  return getAppleHealthSleepSegments(input).map((segment) => ({
    id: `apple-health-sleep:${input.userId}:${segment.start}:${segment.end}`,
    title: 'Sleep',
    summary: 'Sleep',
    start: segment.start,
    end: segment.end,
    source: 'apple_health',
    category: 'sleep',
    categories: ['sleep'],
    color: '#5E5CE6',
    isAllDay: false,
  }));
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
    const db = getDb();
    const healthJsonColumns = appleHealthJsonSelectColumns(db);
    const rows = db.prepare(`
      SELECT date, data_type, ${healthJsonColumns}
        FROM apple_health_data
       WHERE user_id = ?
         AND data_type IN ('sleep', 'daily_summary')
         AND date BETWEEN ? AND ?
       ORDER BY date ASC,
                CASE data_type WHEN 'sleep' THEN 0 ELSE 1 END ASC
    `).all(
      input.userId,
      rangeStart.setZone(input.timezone).minus({ days: 1 }).toISODate(),
      rangeEnd.setZone(input.timezone).plus({ days: 1 }).toISODate(),
    ) as AppleHealthAgendaRow[];

    const segments: AppleHealthSleepSegment[] = [];
    const seen = new Set<string>();
    const datesWithSleepSegments = new Set<string>();
    for (const row of rows) {
      const parsed = safeAppleHealthJson(row, input.userId);
      const intervals = Array.isArray(parsed?.intervals) ? parsed.intervals : [];
      const segmentCountBeforeRow = segments.length;
      for (const interval of intervals) {
        const stage = String(interval?.stage || '').trim();
        if (!isAsleepStage(stage)) continue;
        const clipped = clipToRange(interval?.start, interval?.end, rangeStart, rangeEnd, input.timezone);
        if (!clipped) continue;
        const appended = appendSegment(segments, seen, {
          stage: stage || null,
          start: clipped.start.toUTC().toISO()!,
          end: clipped.end.toUTC().toISO()!,
          minutes: Math.round(clipped.end.diff(clipped.start, 'minutes').minutes),
        });
        if (appended) datesWithSleepSegments.add(row.date);
      }

      const totalMinutes = readSleepTotalMinutes(parsed);
      if (segments.length === segmentCountBeforeRow && totalMinutes > 0 && !datesWithSleepSegments.has(row.date)) {
        const fallbackEnd = DateTime.fromISO(row.date, { zone: input.timezone }).plus({ hours: 7 });
        const fallbackStart = fallbackEnd.minus({ minutes: totalMinutes });
        const clipped = clipToRange(fallbackStart.toISO(), fallbackEnd.toISO(), rangeStart, rangeEnd, input.timezone);
        if (clipped) {
          const appended = appendSegment(segments, seen, {
            stage: null,
            start: clipped.start.toUTC().toISO()!,
            end: clipped.end.toUTC().toISO()!,
            minutes: Math.round(clipped.end.diff(clipped.start, 'minutes').minutes),
          });
          if (appended) datesWithSleepSegments.add(row.date);
        }
      }
    }

    return mergeSleepSegments(segments);
  } catch {
    return [];
  }
}

function readSleepTotalMinutes(value: any): number {
  const directMinutes = numericMetric(value?.totalMinutes)
    ?? numericMetric(value?.totalSleepMinutes)
    ?? numericMetric(value?.sleepMinutes)
    ?? numericMetric(value?.durationMinutes);
  if (directMinutes != null) return Math.max(0, directMinutes);
  const totalSeconds = numericMetric(value?.totalSleepSeconds)
    ?? numericMetric(value?.sleepSeconds)
    ?? numericMetric(value?.durationSeconds);
  return totalSeconds != null ? Math.max(0, totalSeconds / 60) : 0;
}

function numericMetric(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function appendSegment(segments: AppleHealthSleepSegment[], seen: Set<string>, segment: AppleHealthSleepSegment): boolean {
  if (segment.minutes <= 0) return false;
  const key = `${segment.start}|${segment.end}|${segment.stage || ''}`;
  if (seen.has(key)) return false;
  seen.add(key);
  segments.push(segment);
  return true;
}

function mergeSleepSegments(segments: AppleHealthSleepSegment[]): AppleHealthSleepSegment[] {
  const sorted = segments
    .map((segment) => ({
      ...segment,
      startDt: DateTime.fromISO(segment.start, { setZone: true }).toUTC(),
      endDt: DateTime.fromISO(segment.end, { setZone: true }).toUTC(),
    }))
    .filter((segment) => segment.startDt.isValid && segment.endDt.isValid && segment.endDt > segment.startDt)
    .sort((a, b) => a.startDt.toMillis() - b.startDt.toMillis() || a.endDt.toMillis() - b.endDt.toMillis());

  const merged: Array<{
    startDt: DateTime;
    endDt: DateTime;
    minutes: number;
    stages: Set<string>;
  }> = [];

  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({
        startDt: segment.startDt,
        endDt: segment.endDt,
        minutes: Math.round(segment.endDt.diff(segment.startDt, 'minutes').minutes),
        stages: new Set(segment.stage ? [segment.stage] : []),
      });
      continue;
    }

    const gapMinutes = segment.startDt.diff(last.endDt, 'minutes').minutes;
    if (gapMinutes <= SLEEP_WINDOW_GAP_MINUTES) {
      const additionalStart = segment.startDt > last.endDt ? segment.startDt : last.endDt;
      const additionalMinutes = segment.endDt > additionalStart
        ? segment.endDt.diff(additionalStart, 'minutes').minutes
        : 0;
      last.minutes += Math.max(0, Math.round(additionalMinutes));
      if (segment.endDt > last.endDt) last.endDt = segment.endDt;
      if (segment.stage) last.stages.add(segment.stage);
      continue;
    }

    merged.push({
      startDt: segment.startDt,
      endDt: segment.endDt,
      minutes: Math.round(segment.endDt.diff(segment.startDt, 'minutes').minutes),
      stages: new Set(segment.stage ? [segment.stage] : []),
    });
  }

  return merged
    .map((segment) => ({
      stage: segment.stages.size === 1 ? [...segment.stages][0] ?? null : null,
      start: segment.startDt.toISO()!,
      end: segment.endDt.toISO()!,
      minutes: Math.max(0, Math.min(1440, Math.round(segment.minutes))),
    }))
    .filter((segment) => segment.minutes > 0);
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

function safeAppleHealthJson(row: AppleHealthAgendaRow, userId: number): any {
  try {
    return parseAppleHealthDataJson(row, userId);
  } catch {
    return null;
  }
}
