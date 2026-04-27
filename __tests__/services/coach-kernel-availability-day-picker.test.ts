import { describe, expect, it } from 'vitest';

import {
  isDayAvailableForSport,
  pickAvailableDay,
  pickAvailableDays,
  pickKeyDay,
} from '../../src/services/coach-kernel/availability-day-picker';
import type { AthleteState, AvailabilityWindow, DayOfWeek } from '../../src/services/coach-kernel/types';

/**
 * Slice 4.F — availability-aware day picker pin tests.
 *
 * Closes Phase 0 audit Layer-3 finding (High): the running, cycling,
 * and swimming engines hardcoded day slots without checking the
 * user's availability. These tests pin:
 *   - empty weeklyWindows → every day available (legacy default)
 *   - sport-agnostic windows → match any sport
 *   - sport-specific windows → only that sport matches
 *   - pickAvailableDay returns first preferred day with a window
 *   - pickAvailableDay falls back to preferences[0] when no match
 *   - pickAvailableDays preserves preference order
 *   - pickAvailableDays falls back to full preference list if
 *     filtering would drop below minimumCount
 *   - pickKeyDay defers to pickAvailableDay
 */

function athleteWithWindows(windows: AvailabilityWindow[]): AthleteState {
  return {
    profile: {
      athleteId: 1,
      name: 'Test',
      experienceLevel: 'intermediate',
    },
    goals: {
      primaryFocus: 'running',
      weeklySessionsTarget: { running: 4 },
      raceCalendar: [],
      priorityOrder: ['running'],
      strengthGoal: 'athletic',
    },
    constraints: [],
    availability: {
      weeklyWindows: windows,
      maxSessionsPerDay: 2,
    },
    equipment: {
      hasGym: false,
      hasBarbell: false,
      hasDumbbells: false,
      hasKettlebells: false,
      hasBands: false,
      hasBikeTrainer: false,
      hasPool: false,
      hasTrack: false,
    },
    trainingHistory: {
      lastWeekMinutesBySport: {},
      trailing4WeekMinutesBySport: {},
    },
    currentBlock: {
      discipline: 'running',
      phase: 'base',
      weekIndex: 1,
      totalWeeks: 12,
      volumeProgressionPct: 6,
    },
    recentSessions: [],
    readiness: {
      level: 'green',
      score: 75,
      sleepHoursLast: 8,
      sleepQualityLast: 'good',
      hrvTrend: 'stable',
      energy: 7,
      painFlags: [],
      notes: [],
    },
    compliance: {
      trailing14DayCompliance: 0.85,
      bySport: {},
      missedKeySessions: 0,
      consecutiveMisses: 0,
    },
  } as AthleteState;
}

describe('availability-day-picker — isDayAvailableForSport', () => {
  it('returns true for every day when weeklyWindows is empty (legacy default)', () => {
    const athlete = athleteWithWindows([]);
    const days: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of days) {
      expect(isDayAvailableForSport(athlete, day, 'running')).toBe(true);
    }
  });

  it('returns true when a sport-agnostic window covers the day', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'tuesday', start: '07:00', end: '09:00' },
    ]);
    expect(isDayAvailableForSport(athlete, 'tuesday', 'running')).toBe(true);
    expect(isDayAvailableForSport(athlete, 'tuesday', 'cycling')).toBe(true);
  });

  it('returns false when only a sport-specific window covers the day and the sport doesn\'t match', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'tuesday', start: '07:00', end: '09:00', sports: ['cycling'] },
    ]);
    expect(isDayAvailableForSport(athlete, 'tuesday', 'cycling')).toBe(true);
    expect(isDayAvailableForSport(athlete, 'tuesday', 'running')).toBe(false);
  });

  it('returns false for days with no matching window when other days do match', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'tuesday', start: '07:00', end: '09:00' },
      { dayOfWeek: 'thursday', start: '07:00', end: '09:00' },
    ]);
    expect(isDayAvailableForSport(athlete, 'tuesday', 'running')).toBe(true);
    expect(isDayAvailableForSport(athlete, 'wednesday', 'running')).toBe(false);
  });
});

describe('availability-day-picker — pickAvailableDay', () => {
  it('returns the first preferred day that has a window', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'wednesday', start: '07:00', end: '09:00' },
    ]);
    const pick = pickAvailableDay(athlete, 'running', ['tuesday', 'wednesday', 'thursday']);
    expect(pick).toBe('wednesday');
  });

  it('falls back to preferences[0] when no preferred day has a window', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'sunday', start: '08:00', end: '10:00' },
    ]);
    const pick = pickAvailableDay(athlete, 'running', ['tuesday', 'wednesday', 'thursday']);
    expect(pick).toBe('tuesday');
  });

  it('returns "monday" when preferences is empty (defensive default)', () => {
    const athlete = athleteWithWindows([]);
    const pick = pickAvailableDay(athlete, 'running', []);
    expect(pick).toBe('monday');
  });

  it('preserves the legacy default for users with no availability data', () => {
    const athlete = athleteWithWindows([]);
    const pick = pickAvailableDay(athlete, 'running', ['tuesday', 'wednesday']);
    expect(pick).toBe('tuesday');
  });
});

describe('availability-day-picker — pickAvailableDays', () => {
  it('returns only days with windows in preference order', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'monday', start: '07:00', end: '09:00' },
      { dayOfWeek: 'wednesday', start: '07:00', end: '09:00' },
    ]);
    const picks = pickAvailableDays(
      athlete,
      'running',
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      2,
    );
    expect(picks).toEqual(['monday', 'wednesday']);
  });

  it('falls back to the full preference list when filtering drops below minimumCount', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'monday', start: '07:00', end: '09:00' },
    ]);
    const picks = pickAvailableDays(
      athlete,
      'running',
      ['monday', 'tuesday', 'wednesday'],
      3,
    );
    // Only monday has a window — that's below minimumCount=3, so
    // we get the full preference list back unchanged.
    expect(picks).toEqual(['monday', 'tuesday', 'wednesday']);
  });

  it('returns full preference order when no windows are declared', () => {
    const athlete = athleteWithWindows([]);
    const picks = pickAvailableDays(athlete, 'running', ['tuesday', 'wednesday', 'thursday']);
    expect(picks).toEqual(['tuesday', 'wednesday', 'thursday']);
  });

  it('respects sport-specific windows when minimumCount allows narrowing', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'monday', start: '07:00', end: '09:00', sports: ['cycling'] },
      { dayOfWeek: 'wednesday', start: '07:00', end: '09:00', sports: ['running'] },
    ]);
    // With minimumCount=1, the picker DOES narrow to sport-specific
    // matches because 1 >= 1.
    const runningPicks = pickAvailableDays(athlete, 'running', ['monday', 'wednesday'], 1);
    expect(runningPicks).toEqual(['wednesday']);
    const cyclingPicks = pickAvailableDays(athlete, 'cycling', ['monday', 'wednesday'], 1);
    expect(cyclingPicks).toEqual(['monday']);
  });

  it('falls back to full preference list when narrowing would drop below default minimumCount', () => {
    // Default minimumCount = preferences.length, so with 2 preferences
    // and only 1 window the picker keeps both days. This is the
    // intentional safety net: a partially-busy week still yields the
    // full intended session count, leaving the scheduler to handle
    // time slotting.
    const athlete = athleteWithWindows([
      { dayOfWeek: 'wednesday', start: '07:00', end: '09:00', sports: ['running'] },
    ]);
    const picks = pickAvailableDays(athlete, 'running', ['monday', 'wednesday']);
    expect(picks).toEqual(['monday', 'wednesday']);
  });
});

describe('availability-day-picker — pickKeyDay', () => {
  it('defers to pickAvailableDay', () => {
    const athlete = athleteWithWindows([
      { dayOfWeek: 'thursday', start: '07:00', end: '09:00' },
    ]);
    const pick = pickKeyDay(athlete, 'running', ['tuesday', 'wednesday', 'thursday']);
    expect(pick).toBe('thursday');
  });

  it('returns the legacy default when no windows are declared', () => {
    const athlete = athleteWithWindows([]);
    const pick = pickKeyDay(athlete, 'running', ['tuesday', 'wednesday']);
    expect(pick).toBe('tuesday');
  });
});
