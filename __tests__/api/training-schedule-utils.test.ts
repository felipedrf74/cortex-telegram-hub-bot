// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  buildBusyWindows,
  candidateTimesForPreferredTime,
  canonicalTrainingDay,
  minutesFromTimeString,
  normalizePreferredTime,
  preferredTimeForSessionType,
  scheduleSessionWindow,
  timeStringFromMinutes,
  type BusyWindow,
} from '../../src/api/routes/training-schedule-utils';

const APP_ZONE = 'Europe/Lisbon';

function lisbonDay(date: string): Date {
  return DateTime.fromISO(`${date}T00:00:00`, { zone: APP_ZONE }).toUTC().toJSDate();
}

function lisbonTime(localDateTime: string): Date {
  return DateTime.fromISO(localDateTime, { zone: APP_ZONE }).toUTC().toJSDate();
}

function lisbonHour(date: Date): number {
  return DateTime.fromJSDate(date).setZone(APP_ZONE).hour;
}

function lisbonMinute(date: Date): number {
  return DateTime.fromJSDate(date).setZone(APP_ZONE).minute;
}

describe('training schedule route utilities', () => {
  it('normalizes preferred times without accepting malformed values', () => {
    expect(normalizePreferredTime('07:30', '12:00')).toBe('07:30');
    expect(normalizePreferredTime(' 07:30 ', '12:00')).toBe('07:30');
    expect(normalizePreferredTime('7:30', '12:00')).toBe('12:00');
    expect(normalizePreferredTime(null, '12:00')).toBe('12:00');
  });

  it('canonicalizes English weekday names and preserves unknown labels', () => {
    expect(canonicalTrainingDay(' monday ')).toBe('Monday');
    expect(canonicalTrainingDay('SUNDAY')).toBe('Sunday');
    expect(canonicalTrainingDay('sexta')).toBe('sexta');
  });

  it('builds sorted busy windows and drops invalid calendar events', () => {
    const windows = buildBusyWindows([
      {
        title: 'Later',
        start: '2026-04-20T15:00:00Z',
        end: '2026-04-20T16:00:00Z',
      },
      {
        subject: 'Earlier',
        start: { dateTime: '2026-04-20T08:00:00Z' },
        end: { dateTime: '2026-04-20T09:00:00Z' },
      },
      {
        title: 'Invalid',
        start: 'bad',
        end: '2026-04-20T10:00:00Z',
      },
    ]);

    expect(windows.map((window) => window.title)).toEqual(['Earlier', 'Later']);
  });

  it('normalizes all-day busy windows in the app timezone', () => {
    const windows = buildBusyWindows([
      {
        title: 'Travel day',
        isAllDay: true,
        start: '2026-04-25',
        end: '2026-04-26',
      },
    ]);

    expect(windows).toEqual([
      {
        title: 'Travel day',
        startMs: DateTime.fromISO('2026-04-25', { zone: 'Europe/Lisbon' }).startOf('day').toUTC().toMillis(),
        endMs: DateTime.fromISO('2026-04-26', { zone: 'Europe/Lisbon' }).startOf('day').toUTC().toMillis(),
      },
    ]);
  });

  it('chooses preferred times by session type', () => {
    expect(preferredTimeForSessionType('gym', '12:00', '07:00', '18:00')).toBe('18:00');
    expect(preferredTimeForSessionType('run', '12:00', '07:00', '18:00')).toBe('07:00');
    expect(preferredTimeForSessionType('swim', '12:00', '07:00', '18:00')).toBe('07:00');
    expect(preferredTimeForSessionType('mobility', '12:00', '07:00', '18:00')).toBe('12:00');
  });

  it('creates bounded candidate times around the preferred time', () => {
    expect(minutesFromTimeString('07:30')).toBe(450);
    expect(timeStringFromMinutes(3 * 60)).toBe('05:00');
    expect(timeStringFromMinutes(22 * 60)).toBe('21:00');
    expect(candidateTimesForPreferredTime('07:00').slice(0, 3)).toEqual(['07:00', '06:00', '08:00']);
  });

  it('schedules the first non-overlapping candidate window and flags exact preference misses', () => {
    const day = lisbonDay('2026-04-20');
    const busyStart = lisbonTime('2026-04-20T07:00:00');
    const busyEnd = lisbonTime('2026-04-20T08:00:00');
    const busyWindows: BusyWindow[] = [{
      startMs: busyStart.getTime(),
      endMs: busyEnd.getTime(),
      title: 'Busy',
    }];

    const scheduled = scheduleSessionWindow(day, 60, '07:00', busyWindows, []);

    expect(lisbonHour(scheduled.start)).toBe(6);
    expect(lisbonHour(scheduled.end)).toBe(7);
    expect(scheduled.preferredTimeUnavailable).toBe(true);
  });

  it('returns preferredTimeUnavailable=false when the exact preferred time is free', () => {
    const day = lisbonDay('2026-04-20');
    const scheduled = scheduleSessionWindow(day, 60, '12:00', [], []);

    expect(lisbonHour(scheduled.start)).toBe(12);
    expect(scheduled.preferredTimeUnavailable).toBe(false);
  });

  it('walks the day for ANY free 60-min window when the friendly band is fully booked', () => {
    // Slice 1.B regression net: previously, when the symmetric ±2.5h band
    // around the preferred time was fully booked, the planner would
    // silently fall back to the literal preferred time — landing the
    // session ON TOP of an existing meeting. The new behavior walks the
    // day and either finds a free 60-min window OR signals
    // preferredTimeUnavailable=true.
    //
    // Friendly-band candidates for `preferredTime: '12:00'` cover 09:30
    // through 14:30 (±150-min), with session ends up to 15:30. Block
    // 09:00–15:30 to force every candidate to overlap.
    const day = lisbonDay('2026-04-20');
    const blockStart = lisbonTime('2026-04-20T09:00:00');
    const blockEnd = lisbonTime('2026-04-20T15:30:00');
    const busyWindows: BusyWindow[] = [{
      startMs: blockStart.getTime(),
      endMs: blockEnd.getTime(),
      title: 'Long meeting',
    }];

    const scheduled = scheduleSessionWindow(day, 60, '12:00', busyWindows, []);

    expect(scheduled.preferredTimeUnavailable).toBe(true);
    // Day-walk should land at the earliest free slot — 05:00–06:00.
    expect(lisbonHour(scheduled.start)).toBe(5);
    expect(lisbonHour(scheduled.end)).toBe(6);
    // Sanity: rendered slot must not overlap the busy window.
    const slotStart = scheduled.start.getTime();
    const slotEnd = scheduled.end.getTime();
    expect(slotStart >= blockEnd.getTime() || slotEnd <= blockStart.getTime()).toBe(true);
  });

  it('returns an explicit noAvailableSlot marker when the entire 05:00-21:00 window is booked', () => {
    const day = lisbonDay('2026-04-20');
    // Block the whole working day. The planner should NOT silently land
    // a session on top of any of these — it should mark the slot
    // unavailable and drop to a deterministic safe time so iOS can show
    // a ⚠️ chip.
    const blockStart = lisbonTime('2026-04-20T05:00:00');
    const blockEnd = lisbonTime('2026-04-20T21:00:00');
    const busyWindows: BusyWindow[] = [{
      startMs: blockStart.getTime(),
      endMs: blockEnd.getTime(),
      title: 'All day',
    }];

    const scheduled = scheduleSessionWindow(day, 60, '12:00', busyWindows, []);

    expect(scheduled.preferredTimeUnavailable).toBe(true);
    expect(scheduled.noAvailableSlot).toBe(true);
    expect(scheduled.unavailableReason).toMatch(/No valid free calendar window/);
    expect(lisbonHour(scheduled.start)).toBe(6);
    expect(lisbonMinute(scheduled.start)).toBe(30);
  });

  it('treats already-scheduled siblings as busy (no two sessions on top of each other)', () => {
    const day = lisbonDay('2026-04-20');
    const sib1Start = lisbonTime('2026-04-20T07:00:00');
    const sib1End = lisbonTime('2026-04-20T08:00:00');
    const scheduledWindows: BusyWindow[] = [{
      startMs: sib1Start.getTime(),
      endMs: sib1End.getTime(),
      title: 'AM run',
    }];

    const scheduled = scheduleSessionWindow(day, 60, '07:00', [], scheduledWindows);

    expect(scheduled.preferredTimeUnavailable).toBe(true);
    // 07:00 is taken by sibling, planner walks to 06:00 or 08:00
    const hour = lisbonHour(scheduled.start);
    expect([6, 8]).toContain(hour);
  });

  it('does not schedule a same-day session before the notBefore floor', () => {
    const day = lisbonDay('2026-04-22');
    const notBefore = lisbonTime('2026-04-22T14:15:00');

    const scheduled = scheduleSessionWindow(day, 60, '07:00', [], [], { notBefore });

    expect(scheduled.start.getTime()).toBeGreaterThanOrEqual(notBefore.getTime());
    expect(scheduled.preferredTimeUnavailable).toBe(true);
    // Day-walk should choose the first 30-minute slot after the floor.
    expect(lisbonHour(scheduled.start)).toBe(14);
    expect(lisbonMinute(scheduled.start)).toBe(30);
  });

  it('returns noAvailableSlot when every remaining same-day slot is behind the notBefore floor', () => {
    const day = lisbonDay('2026-04-22');
    const notBefore = lisbonTime('2026-04-22T21:30:00');

    const scheduled = scheduleSessionWindow(day, 60, '07:00', [], [], { notBefore });

    expect(scheduled.noAvailableSlot).toBe(true);
    expect(scheduled.preferredTimeUnavailable).toBe(true);
  });
});
