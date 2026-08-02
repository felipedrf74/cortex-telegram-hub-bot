import { describe, expect, it } from 'vitest';

import {
  buildAvailabilityInsufficiencyDecisionReason,
  isDayAvailableForSport,
  pickAvailableDay,
  pickAvailableDays,
  pickAvailableDaysDetailed,
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
  // ── F9 (Phase 3): missing ≠ insufficient ─────────────────────────────────
  // The legacy fallback silently scheduled weekday sessions for a
  // weekend-only athlete. The detailed variant keeps the fallback DAYS
  // byte-identical (no placement change) but returns a typed outcome so
  // callers can surface an honest capacity conflict.
  describe('pickAvailableDaysDetailed (F9)', () => {
    const weekendWindows: AvailabilityWindow[] = [
      { dayOfWeek: 'saturday' as DayOfWeek, start: '08:00', end: '12:00' },
      { dayOfWeek: 'sunday' as DayOfWeek, start: '08:00', end: '12:00' },
    ];

    it('classifies undeclared availability as the legacy every-day default, not a conflict', () => {
      const outcome = pickAvailableDaysDetailed(
        athleteWithWindows([]),
        'running',
        ['tuesday', 'thursday', 'saturday'],
        3,
      );
      expect(outcome.kind).toBe('no_availability_declared');
      expect(outcome.days).toEqual(['tuesday', 'thursday', 'saturday']);
    });

    it('classifies covered asks as available with the filtered days', () => {
      const outcome = pickAvailableDaysDetailed(
        athleteWithWindows(weekendWindows),
        'running',
        ['tuesday', 'saturday', 'sunday'],
        2,
      );
      expect(outcome.kind).toBe('available');
      expect(outcome.days).toEqual(['saturday', 'sunday']);
    });

    it('returns a typed conflict for the weekend-only athlete asked for three weekday-heavy sessions', () => {
      const outcome = pickAvailableDaysDetailed(
        athleteWithWindows(weekendWindows),
        'running',
        ['tuesday', 'thursday', 'saturday'],
        3,
      );
      expect(outcome.kind).toBe('insufficient_availability');
      // Placement behaviour is unchanged: the legacy fallback days survive.
      expect(outcome.days).toEqual(['tuesday', 'thursday', 'saturday']);
      if (outcome.kind === 'insufficient_availability') {
        expect(outcome.conflict).toMatchObject({
          code: 'TRAINING_AVAILABILITY_INSUFFICIENT_FOR_FREQUENCY',
          sport: 'running',
          requiredCount: 3,
          availableCount: 1,
          availableDays: ['saturday'],
        });
        expect(outcome.unavailableDays).toEqual(['tuesday', 'thursday']);
      }
    });

    it('keeps the legacy pickAvailableDays behaviour byte-identical', () => {
      const athlete = athleteWithWindows(weekendWindows);
      const preferences: DayOfWeek[] = ['tuesday', 'thursday', 'saturday'];
      expect(pickAvailableDays(athlete, 'running', preferences, 3)).toEqual(
        pickAvailableDaysDetailed(athlete, 'running', preferences, 3).days,
      );
      expect(pickAvailableDays(athlete, 'running', preferences, 1)).toEqual(
        pickAvailableDaysDetailed(athlete, 'running', preferences, 1).days,
      );
    });

    it('builds a warning decision reason engines can attach to affected sessions', () => {
      const outcome = pickAvailableDaysDetailed(
        athleteWithWindows(weekendWindows),
        'running',
        ['tuesday', 'thursday', 'saturday'],
        3,
      );
      expect(outcome.kind).toBe('insufficient_availability');
      if (outcome.kind !== 'insufficient_availability') return;
      const reason = buildAvailabilityInsufficiencyDecisionReason(outcome.conflict, 'tuesday' as DayOfWeek);
      expect(reason).toMatchObject({
        code: 'availability_insufficient_for_frequency',
        severity: 'warning',
        affectedEntity: { type: 'session', dayOfWeek: 'tuesday' },
        sourceConstraint: { type: 'capacity' },
      });
      expect(reason.text).toMatch(/availab/i);
    });
  });
});
