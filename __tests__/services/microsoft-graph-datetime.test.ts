/**
 * Tests for src/services/microsoft-graph-datetime.ts (NEX-29).
 *
 * Graph's dateTimeTimeZone contract: `dateTime` is ZONE-NAIVE wall-clock in
 * the named `timeZone`. The matrix pins every serialization rule so the
 * create/update payload builders can never regress into shipping 'Z'-suffixed
 * instants next to a named zone again.
 */

import { describe, expect, it } from 'vitest';
import { toGraphDateTimeTimeZone } from '../../src/services/microsoft-graph-datetime';

describe('toGraphDateTimeTimeZone (NEX-29)', () => {
  it('pins date-only dues to T00:00:00 UTC so the calendar day is stable everywhere', () => {
    expect(toGraphDateTimeTimeZone('2026-07-19', 'Europe/Lisbon')).toEqual({
      dateTime: '2026-07-19T00:00:00',
      timeZone: 'UTC',
    });
  });

  it('converts Z-suffixed instants to wall-clock time in the named zone', () => {
    // 15:00Z in July is 16:00 wall-clock in Lisbon (WEST, UTC+1).
    expect(toGraphDateTimeTimeZone('2026-07-19T15:00:00Z', 'Europe/Lisbon')).toEqual({
      dateTime: '2026-07-19T16:00:00',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('keeps UTC instants as bare wall-clock when the named zone is UTC', () => {
    expect(toGraphDateTimeTimeZone('2026-05-12T09:00:00.000Z', 'UTC')).toEqual({
      dateTime: '2026-05-12T09:00:00',
      timeZone: 'UTC',
    });
  });

  it('converts explicit-offset datetimes into the named zone', () => {
    // 10:30+02:00 == 08:30Z == 09:30 Lisbon summer time.
    expect(toGraphDateTimeTimeZone('2026-07-19T10:30:00+02:00', 'Europe/Lisbon')).toEqual({
      dateTime: '2026-07-19T09:30:00',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('passes zone-naive wall-clock strings through with the named zone', () => {
    expect(toGraphDateTimeTimeZone('2026-07-19T15:00:00', 'Europe/Lisbon')).toEqual({
      dateTime: '2026-07-19T15:00:00',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('strips non-standard fractional seconds from zone-naive input', () => {
    expect(toGraphDateTimeTimeZone('2026-07-19T15:00:00.0000000', 'Europe/Lisbon')).toEqual({
      dateTime: '2026-07-19T15:00:00',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('falls back to UTC wall-clock when the named zone is unknown', () => {
    expect(toGraphDateTimeTimeZone('2026-07-19T15:00:00Z', 'Not/AZone')).toEqual({
      dateTime: '2026-07-19T15:00:00',
      timeZone: 'UTC',
    });
  });

  it('drops the designator defensively when a zoned-looking string does not parse', () => {
    expect(toGraphDateTimeTimeZone('9999-99-99T99:99:99Z', 'Europe/Lisbon')).toEqual({
      dateTime: '9999-99-99T99:99:99',
      timeZone: 'Europe/Lisbon',
    });
  });

  it('returns null for empty input so callers can clear provider dues', () => {
    expect(toGraphDateTimeTimeZone(null, 'Europe/Lisbon')).toBeNull();
    expect(toGraphDateTimeTimeZone(undefined, 'Europe/Lisbon')).toBeNull();
    expect(toGraphDateTimeTimeZone('   ', 'Europe/Lisbon')).toBeNull();
  });
});
