// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  canonicalTrainingWeekdayKey,
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
    expect(isPastIsoDate('2026-06-02', now)).toBe(true);
    expect(isPastIsoDate('2026-06-03', now)).toBe(false);
    expect(isPastIsoDate('2026-06-04', now)).toBe(false);
  });
});
