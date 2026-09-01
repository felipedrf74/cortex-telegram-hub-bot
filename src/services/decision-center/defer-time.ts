// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

export interface ResolveDecisionDeferInput {
  timezone: string;
  now?: Date;
  deferUntil?: string | null;
  minutes?: number | null;
  followUp?: string | null;
}

export type DecisionDeferResolution =
  | {
      ok: true;
      deferUntil: string;
      source: 'absolute' | 'minutes' | 'next_monday';
      localDate: string;
    }
  | {
      ok: false;
      code: 'INVALID_TIMEZONE' | 'INVALID_DEFER_UNTIL' | 'DEFER_UNTIL_NOT_FUTURE' | 'INVALID_MINUTES';
    };

const NEXT_WEEK_PATTERNS = [
  /\bnext\s+week\b/i,
  /\bsemana\s+que\s+vem\b/i,
  /\bpr[oó]xima\s+semana\b/i,
];

function validZone(timezone: string, now: Date): DateTime | null {
  const zoned = DateTime.fromJSDate(now, { zone: timezone });
  return zoned.isValid ? zoned : null;
}

function isNextWeek(value: string | null | undefined): boolean {
  if (!value) return false;
  return NEXT_WEEK_PATTERNS.some((pattern) => pattern.test(value));
}

function success(value: DateTime, source: 'absolute' | 'minutes' | 'next_monday'): DecisionDeferResolution {
  return {
    ok: true,
    deferUntil: value.toUTC().toISO({ suppressMilliseconds: true })!,
    source,
    localDate: value.toISODate()!,
  };
}

/**
 * Resolve a revisit/snooze time with one injected clock and the user's IANA
 * timezone. A generic "next week" is exactly next Monday at 09:00 local time;
 * explicit ISO timestamps retain their exact instant.
 */
export function resolveDecisionDeferUntil(input: ResolveDecisionDeferInput): DecisionDeferResolution {
  const nowDate = input.now ?? new Date();
  const now = validZone(input.timezone, nowDate);
  if (!now) return { ok: false, code: 'INVALID_TIMEZONE' };

  const rawAbsolute = input.deferUntil?.trim() ?? '';
  if (rawAbsolute && !isNextWeek(rawAbsolute)) {
    const hasExplicitOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(rawAbsolute);
    const absolute = hasExplicitOffset
      ? DateTime.fromISO(rawAbsolute, { setZone: true })
      : DateTime.fromISO(rawAbsolute, { zone: input.timezone });
    if (!absolute.isValid || !rawAbsolute.includes('T')) {
      return { ok: false, code: 'INVALID_DEFER_UNTIL' };
    }
    if (absolute.toMillis() <= now.toMillis()) return { ok: false, code: 'DEFER_UNTIL_NOT_FUTURE' };
    return success(absolute, 'absolute');
  }

  if (isNextWeek(rawAbsolute) || isNextWeek(input.followUp)) {
    const daysUntilNextMonday = ((8 - now.weekday) % 7) || 7;
    const nextMonday = now.plus({ days: daysUntilNextMonday }).startOf('day').set({ hour: 9 });
    return success(nextMonday, 'next_monday');
  }

  const minutes = input.minutes ?? 60;
  if (!Number.isSafeInteger(minutes) || minutes <= 0 || minutes > 525_600) {
    return { ok: false, code: 'INVALID_MINUTES' };
  }
  return success(now.plus({ minutes }), 'minutes');
}
