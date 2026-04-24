// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
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

  it('schedules the first non-overlapping candidate window', () => {
    const day = new Date(2026, 3, 20);
    const busyStart = new Date(day);
    busyStart.setHours(7, 0, 0, 0);
    const busyEnd = new Date(day);
    busyEnd.setHours(8, 0, 0, 0);
    const busyWindows: BusyWindow[] = [{
      startMs: busyStart.getTime(),
      endMs: busyEnd.getTime(),
      title: 'Busy',
    }];

    const scheduled = scheduleSessionWindow(day, 60, '07:00', busyWindows, []);

    expect(scheduled.start.getHours()).toBe(6);
    expect(scheduled.end.getHours()).toBe(7);
  });
});
