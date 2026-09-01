// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { resolveDecisionDeferUntil } from '../../src/services/decision-center/defer-time';

describe('Decision Center defer-time resolution', () => {
  it.each([
    ['Europe/Lisbon', '2026-03-27T22:30:00Z', '2026-03-30T08:00:00Z'],
    ['America/Sao_Paulo', '2026-10-30T22:30:00Z', '2026-11-02T12:00:00Z'],
    ['America/Los_Angeles', '2026-10-30T22:30:00Z', '2026-11-02T17:00:00Z'],
  ])('resolves next week to Monday 09:00 in %s across DST/local offsets', (timezone, now, expected) => {
    expect(resolveDecisionDeferUntil({
      timezone,
      now: new Date(now),
      followUp: 'next week',
    })).toMatchObject({ ok: true, source: 'next_monday', deferUntil: expected });
  });

  it('always chooses the following Monday when invoked on Monday', () => {
    expect(resolveDecisionDeferUntil({
      timezone: 'Europe/Lisbon',
      now: new Date('2026-08-31T08:30:00Z'),
      followUp: 'semana que vem',
    })).toMatchObject({
      ok: true,
      deferUntil: '2026-09-07T08:00:00Z',
      localDate: '2026-09-07',
    });
  });

  it('preserves the exact instant of an explicit offset timestamp', () => {
    expect(resolveDecisionDeferUntil({
      timezone: 'America/Sao_Paulo',
      now: new Date('2026-08-30T12:00:00Z'),
      deferUntil: '2026-09-02T15:45:00-03:00',
    })).toEqual({
      ok: true,
      deferUntil: '2026-09-02T18:45:00Z',
      source: 'absolute',
      localDate: '2026-09-02',
    });
  });

  it('retains legacy minutes with strict validation', () => {
    expect(resolveDecisionDeferUntil({
      timezone: 'Europe/Lisbon',
      now: new Date('2026-08-30T10:00:00Z'),
      minutes: 90,
    })).toMatchObject({ ok: true, deferUntil: '2026-08-30T11:30:00Z', source: 'minutes' });
    expect(resolveDecisionDeferUntil({ timezone: 'Europe/Lisbon', minutes: Number.NaN })).toEqual({
      ok: false,
      code: 'INVALID_MINUTES',
    });
  });

  it('rejects invalid zones, date-only values, and past timestamps', () => {
    expect(resolveDecisionDeferUntil({ timezone: 'Mars/Olympus', minutes: 60 })).toEqual({
      ok: false,
      code: 'INVALID_TIMEZONE',
    });
    expect(resolveDecisionDeferUntil({ timezone: 'Europe/Lisbon', deferUntil: '2026-09-02' })).toEqual({
      ok: false,
      code: 'INVALID_DEFER_UNTIL',
    });
    expect(resolveDecisionDeferUntil({
      timezone: 'Europe/Lisbon',
      now: new Date('2026-09-02T12:00:00Z'),
      deferUntil: '2026-09-02T10:00:00Z',
    })).toEqual({ ok: false, code: 'DEFER_UNTIL_NOT_FUTURE' });
  });
});
