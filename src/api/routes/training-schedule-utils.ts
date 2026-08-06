// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { resolveTrainingTimezone } from '../../services/training-date-utils';

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

export function buildBusyWindows(events: any[], schedulingTimezone?: string | null): BusyWindow[] {
  const timezone = resolveTrainingTimezone(schedulingTimezone);
  return (events || []).flatMap((event: any) => {
    const startRaw = event.start?.dateTime || event.startDateTime || event.start;
    const endRaw = event.end?.dateTime || event.endDateTime || event.end;
    const parsed = parseBusyWindowBounds(startRaw, endRaw, !!event.isAllDay, timezone);
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
  timezone: string,
): { startMs: number; endMs: number } | null {
  const startText = stringValue(startRaw);
  const endText = stringValue(endRaw);
  const dateOnlyStart = dateOnlyValue(startText);
  const dateOnlyEnd = dateOnlyValue(endText);

  if (isAllDay || dateOnlyStart || dateOnlyEnd) {
    const startDay = dateOnlyStart || dateOnlyValue(startText?.slice(0, 10));
    if (!startDay) return null;
    const endDay = dateOnlyEnd || dateOnlyValue(endText?.slice(0, 10));
    const start = DateTime.fromISO(startDay, { zone: timezone }).startOf('day');
    let end = endDay
      ? DateTime.fromISO(endDay, { zone: timezone }).startOf('day')
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

/**
 * Result of attempting to schedule a session into a day's free time.
 *
 * `preferredTimeUnavailable: true` means the exact user-requested time
 * could not be used. Nearby candidates may still produce a useful slot,
 * but callers should surface the conflict instead of silently shifting a
 * 12:00 preference to 12:30/13:00 and claiming the preference was
 * honored. If even the day-walk failed, `noAvailableSlot` is true.
 * Callers must not create a calendar event from that fallback marker;
 * they should persist an explicit unscheduled/deferred state instead.
 */
export interface ScheduleSessionResult {
  start: Date;
  end: Date;
  preferredTimeUnavailable: boolean;
  noAvailableSlot?: boolean;
  unavailableReason?: string;
}

const DAY_WALK_START_MINUTES = 5 * 60;     // 05:00 — earliest the planner is willing to go
const DAY_WALK_END_MINUTES = 21 * 60;      // 21:00 — latest the planner is willing to go
const DAY_WALK_STEP_MINUTES = 30;
const SAFE_FALLBACK_TIME_MINUTES = 6 * 60 + 30;  // 06:30 — a "you owe me a real time" marker

function tryWindowAt(
  sessionDate: Date,
  startMinutes: number,
  durationMinutes: number,
  busyWindows: BusyWindow[],
  scheduledWindows: BusyWindow[],
  timezone: string,
  notBefore?: Date,
): { start: Date; end: Date } | null {
  const sessionDay = DateTime.fromJSDate(sessionDate).setZone(timezone);
  if (!sessionDay.isValid) return null;
  const startDateTime = DateTime.fromObject(
    {
      year: sessionDay.year,
      month: sessionDay.month,
      day: sessionDay.day,
      hour: Math.floor(startMinutes / 60),
      minute: startMinutes % 60,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone },
  );
  if (!startDateTime.isValid) return null;
  const start = startDateTime.toUTC().toJSDate();
  const end = startDateTime.plus({ minutes: durationMinutes }).toUTC().toJSDate();
  if (notBefore && start.getTime() < notBefore.getTime()) return null;
  if (overlapsRange(start.getTime(), end.getTime(), busyWindows)) return null;
  if (overlapsRange(start.getTime(), end.getTime(), scheduledWindows)) return null;
  return { start, end };
}

export function scheduleSessionWindow(
  sessionDate: Date,
  durationMinutes: number,
  preferredTime: string,
  busyWindows: BusyWindow[],
  scheduledWindows: BusyWindow[],
  options: { notBefore?: Date; timezone?: string | null } = {},
): ScheduleSessionResult {
  const timezone = resolveTrainingTimezone(options.timezone);
  // Stage 1: try the preferred time + symmetric ±1/±1.5/±2/±2.5 candidates.
  // Exact preferred time is the only path that counts as "preference
  // respected"; nearby fits are useful but must be reported as a shift.
  const candidates = candidateTimesForPreferredTime(preferredTime);
  for (const candidate of candidates) {
    const candidateMinutes = minutesFromTimeString(candidate);
    const slot = tryWindowAt(
      sessionDate,
      candidateMinutes,
      durationMinutes,
      busyWindows,
      scheduledWindows,
      timezone,
      options.notBefore,
    );
    if (slot) return { ...slot, preferredTimeUnavailable: candidate !== preferredTime };
  }

  // Stage 2: nothing in the friendly band is free. Walk the whole day in
  // 30-min increments looking for ANY free 60-min window. This protects
  // the user from the historical bug where the planner would land a
  // session on top of an existing meeting because the fallback path
  // ignored busy windows entirely.
  for (let m = DAY_WALK_START_MINUTES; m + durationMinutes <= DAY_WALK_END_MINUTES; m += DAY_WALK_STEP_MINUTES) {
    const slot = tryWindowAt(
      sessionDate,
      m,
      durationMinutes,
      busyWindows,
      scheduledWindows,
      timezone,
      options.notBefore,
    );
    if (slot) return { ...slot, preferredTimeUnavailable: true };
  }

  // Stage 3: the day is fully booked from 05:00–21:00. Return a
  // deterministic fallback marker for legacy callers, but explicitly
  // flag it as not schedulable. Training persistence and calendar sync
  // must treat this as an unscheduled session, never as an event to
  // create at 06:30.
  const sessionDay = DateTime.fromJSDate(sessionDate).setZone(timezone);
  const fallbackDateTime = sessionDay.isValid
    ? DateTime.fromObject(
      {
        year: sessionDay.year,
        month: sessionDay.month,
        day: sessionDay.day,
        hour: Math.floor(SAFE_FALLBACK_TIME_MINUTES / 60),
        minute: SAFE_FALLBACK_TIME_MINUTES % 60,
        second: 0,
        millisecond: 0,
      },
      { zone: timezone },
    )
    : DateTime.fromJSDate(sessionDate).toUTC();
  const fallback = fallbackDateTime.toUTC().toJSDate();
  return {
    start: fallback,
    end: new Date(fallback.getTime() + durationMinutes * 60 * 1000),
    preferredTimeUnavailable: true,
    noAvailableSlot: true,
    unavailableReason: 'No valid free calendar window remained between 05:00 and 21:00.',
  };
}
