// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../../config';

export type BusyWindow = {
  startMs: number;
  endMs: number;
  title: string;
};

export function normalizePreferredTime(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : fallback;
}

export function canonicalTrainingDay(value: string): string {
  const normalized = value.trim().toLowerCase();
  const mapping: Record<string, string> = {
    monday: 'Monday',
    tuesday: 'Tuesday',
    wednesday: 'Wednesday',
    thursday: 'Thursday',
    friday: 'Friday',
    saturday: 'Saturday',
    sunday: 'Sunday',
  };
  return mapping[normalized] ?? value.trim();
}

export function buildBusyWindows(events: any[]): BusyWindow[] {
  return (events || []).flatMap((event: any) => {
    const startRaw = event.start?.dateTime || event.startDateTime || event.start;
    const endRaw = event.end?.dateTime || event.endDateTime || event.end;
    const parsed = parseBusyWindowBounds(startRaw, endRaw, !!event.isAllDay);
    if (!parsed || parsed.endMs <= parsed.startMs) return [];
    return [{
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      title: event.subject || event.summary || event.title || '',
    }];
  }).sort((a, b) => a.startMs - b.startMs);
}

function parseBusyWindowBounds(
  startRaw: unknown,
  endRaw: unknown,
  isAllDay: boolean,
): { startMs: number; endMs: number } | null {
  const startText = stringValue(startRaw);
  const endText = stringValue(endRaw);
  const dateOnlyStart = dateOnlyValue(startText);
  const dateOnlyEnd = dateOnlyValue(endText);

  if (isAllDay || dateOnlyStart || dateOnlyEnd) {
    const zone = config.app.timezone || 'Europe/Lisbon';
    const startDay = dateOnlyStart || dateOnlyValue(startText?.slice(0, 10));
    if (!startDay) return null;
    const endDay = dateOnlyEnd || dateOnlyValue(endText?.slice(0, 10));
    const start = DateTime.fromISO(startDay, { zone }).startOf('day');
    let end = endDay
      ? DateTime.fromISO(endDay, { zone }).startOf('day')
      : start.plus({ days: 1 });
    if (!start.isValid || !end.isValid) return null;
    if (end <= start) end = start.plus({ days: 1 });
    return {
      startMs: start.toUTC().toMillis(),
      endMs: end.toUTC().toMillis(),
    };
  }

  const start = new Date(startText || '');
  const end = new Date(endText || '');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dateOnlyValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function preferredTimeForSessionType(
  sessionType: string,
  fallbackPreferredTime: string,
  preferredCardioTime: string,
  preferredStrengthTime: string,
): string {
  switch ((sessionType || '').toLowerCase()) {
    case 'gym':
      return preferredStrengthTime;
    case 'run':
    case 'ride':
    case 'swim':
      return preferredCardioTime;
    default:
      return fallbackPreferredTime;
  }
}

export function minutesFromTimeString(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return Math.max(0, Math.min(23 * 60 + 59, (hours || 0) * 60 + (minutes || 0)));
}

export function timeStringFromMinutes(totalMinutes: number): string {
  const clamped = Math.max(5 * 60, Math.min(21 * 60, totalMinutes));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function candidateTimesForPreferredTime(preferredTime: string): string[] {
  const baseMinutes = minutesFromTimeString(preferredTime);
  const offsets = [0, -60, 60, -90, 90, 120, -120, 150, -150];
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const offset of offsets) {
    const candidate = timeStringFromMinutes(baseMinutes + offset);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function overlapsRange(startMs: number, endMs: number, windows: BusyWindow[]): boolean {
  return windows.some((window) => startMs < window.endMs && endMs > window.startMs);
}

export function scheduleSessionWindow(
  sessionDate: Date,
  durationMinutes: number,
  preferredTime: string,
  busyWindows: BusyWindow[],
  scheduledWindows: BusyWindow[],
): { start: Date; end: Date } {
  const candidates = candidateTimesForPreferredTime(preferredTime);

  for (const candidate of candidates) {
    const [hours, minutes] = candidate.split(':').map(Number);
    const start = new Date(sessionDate);
    start.setHours(hours, minutes, 0, 0);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    if (!overlapsRange(start.getTime(), end.getTime(), busyWindows) && !overlapsRange(start.getTime(), end.getTime(), scheduledWindows)) {
      return { start, end };
    }
  }

  const [fallbackHours, fallbackMinutes] = preferredTime.split(':').map(Number);
  const fallbackStart = new Date(sessionDate);
  fallbackStart.setHours(fallbackHours || 12, fallbackMinutes || 0, 0, 0);
  return {
    start: fallbackStart,
    end: new Date(fallbackStart.getTime() + durationMinutes * 60 * 1000),
  };
}
