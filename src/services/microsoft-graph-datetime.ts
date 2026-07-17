// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Microsoft Graph `dateTimeTimeZone` serialization (NEX-29 fix).
 *
 * Graph expects the `dateTime` member of a dateTimeTimeZone payload to be a
 * ZONE-NAIVE wall-clock string interpreted in the sibling `timeZone` field.
 * The legacy builders forwarded whatever the caller had — frequently a
 * 'Z'-suffixed UTC instant — while naming a non-UTC timeZone, which is a
 * Graph contract violation: Graph strips the zone designator and re-reads the
 * UTC wall-clock digits in the named zone, silently shifting the due date by
 * the zone offset.
 *
 * Rules implemented here:
 *   - date-only values ('2026-07-19') → { '2026-07-19T00:00:00', 'UTC' } so a
 *     bare date stays the same calendar day everywhere.
 *   - zoned values ('...Z' or '...±hh:mm') → convert the instant to wall-clock
 *     time IN the named timeZone and drop the designator.
 *   - zone-naive values ('2026-07-19T15:00:00') → already wall-clock; strip
 *     non-standard fractional seconds and pass through with the named zone.
 *   - unparseable input falls back to the raw string with the named zone
 *     (never throws — provider validation surfaces the real error).
 */

import { DateTime } from 'luxon';

export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_PATTERN = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;
const GRAPH_WALL_CLOCK_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

function stripFractionalSeconds(value: string): string {
  return value.replace(/\.\d+/, '');
}

/**
 * Serialize an ISO date/datetime string into a Graph dateTimeTimeZone object.
 * Returns null for empty input so callers can pass the null-clears-field
 * contract straight through.
 */
export function toGraphDateTimeTimeZone(
  value: string | null | undefined,
  timeZone: string,
): GraphDateTimeTimeZone | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  if (DATE_ONLY_PATTERN.test(raw)) {
    return { dateTime: `${raw}T00:00:00`, timeZone: 'UTC' };
  }

  const normalized = stripFractionalSeconds(raw);
  if (ZONED_PATTERN.test(normalized)) {
    const parsed = DateTime.fromISO(raw, { setZone: true });
    if (parsed.isValid) {
      const inZone = parsed.setZone(timeZone);
      if (inZone.isValid) {
        return { dateTime: inZone.toFormat(GRAPH_WALL_CLOCK_FORMAT), timeZone };
      }
      // Unknown IANA zone name — keep the instant, express it in UTC.
      return { dateTime: parsed.toUTC().toFormat(GRAPH_WALL_CLOCK_FORMAT), timeZone: 'UTC' };
    }
    // Looked zoned but did not parse — defensively drop the designator so we
    // never ship a zone suffix next to a named timeZone.
    return { dateTime: normalized.replace(ZONED_PATTERN, ''), timeZone };
  }

  return { dateTime: normalized, timeZone };
}
