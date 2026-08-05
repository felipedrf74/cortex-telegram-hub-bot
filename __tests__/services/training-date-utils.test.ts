// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  canonicalTrainingWeekdayKey,
  isFutureIsoDate,
  isPastIsoDate,
  isStrictIsoDate,
  resolveTrainingDay,
  trainingWeekdayMatches,
} from '../../src/services/training-date-utils';

describe('training-date-utils', () => {
  it('resolves day boundaries in the configured Training timezone', () => {
    const utcSundayLisbonMonday = new Date('2026-03-29T23:30:00.000Z');

    expect(resolveTrainingDay({ now: utcSundayLisbonMonday, timezone: 'UTC' })).toMatchObject({
      date: '2026-03-29',
      weekdayKey: 'sunday',
    });
    expect(resolveTrainingDay({ now: utcSundayLisbonMonday, timezone: 'Europe/Lisbon' })).toMatchObject({
      date: '2026-03-30',
      weekdayKey: 'monday',
    });
  });

  it('canonicalizes localized weekday labels for persisted plan rows', () => {
    expect(canonicalTrainingWeekdayKey('terça-feira')).toBe('tuesday');
    expect(canonicalTrainingWeekdayKey('Miércoles')).toBe('wednesday');
    expect(trainingWeekdayMatches('Quinta-feira', {
      date: '2026-04-02',
      weekdayName: 'Thursday',
      weekdayKey: 'thursday',
      timezone: 'Europe/Lisbon',
    })).toBe(true);
  });

  it('strictly validates real ISO calendar dates', () => {
    expect(isStrictIsoDate('2026-02-28')).toBe(true);
    expect(isStrictIsoDate('2026-02-30')).toBe(false);
    expect(isStrictIsoDate('2026-05-23T00:00:00Z')).toBe(false);
    expect(isStrictIsoDate(' 2026-05-23')).toBe(false);
    expect(isStrictIsoDate(20260523)).toBe(false);
  });

  it('detects past ISO dates at UTC day granularity', () => {
    const now = new Date('2026-06-03T23:30:00.000Z');
    expect(isPastIsoDate('2026-06-02', now, 'UTC')).toBe(true);
    expect(isPastIsoDate('2026-06-03', now, 'UTC')).toBe(false);
    expect(isPastIsoDate('2026-06-04', now, 'UTC')).toBe(false);
  });

  it('requires race dates to be strictly later than the user-local day', () => {
    const now = new Date('2026-06-03T23:30:00.000Z');

    // F12 stronger guarantee: "future" excludes both past and same-day
    // values; an event whose local calendar day is today cannot anchor a
    // newly generated multi-day plan.
    expect(isFutureIsoDate('2026-06-02', now, 'UTC')).toBe(false);
    expect(isFutureIsoDate('2026-06-03', now, 'UTC')).toBe(false);
    expect(isFutureIsoDate('2026-06-04', now, 'UTC')).toBe(true);
  });

  it('evaluates date-only deadlines in the authenticated user timezone', () => {
    const now = new Date('2026-06-03T00:30:00.000Z');

    // Stronger guarantee: the same instant can be a different calendar day
    // for two users, so race-date validation must compare plan-local dates.
    expect(isPastIsoDate('2026-06-02', now, 'America/Los_Angeles')).toBe(false);
    expect(isPastIsoDate('2026-06-02', now, 'Asia/Tokyo')).toBe(true);
  });
});
