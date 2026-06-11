// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-day "keep original" adaptation opt-out (Training redesign Phase 0).
 *
 * When the user taps "keep the original session" on the Today screen, we
 * persist a (userId, local date) flag in the SQLite-backed cache store so
 * BOTH adaptation read paths — the today read model
 * (`training-read-models.getTodaySession`) and the Home kernel context
 * (`training-home-payload.resolveKernelTodayContext`) — render the
 * prescription exactly as written for the rest of that local day.
 *
 * Lives in its own tiny module (not training.ts) so both read paths can
 * import the check without creating a route-module import cycle.
 */

import { getCached, setCache } from './cache-store';
import { resolveTrainingDay } from './training-date-utils';

/** ~30h: covers the full local day plus timezone drift around midnight,
 *  then self-expires from api_cache — no cleanup job needed. */
const KEEP_ORIGINAL_TTL_SECONDS = 30 * 60 * 60;

function keepOriginalCacheKey(userId: number, dateString: string): string {
  return `training:keep-original:${userId}:${dateString}`;
}

/** Today's date (YYYY-MM-DD) in the Training timezone — the same local-day
 *  resolution the Training read models use for "today". */
export function resolveKeepOriginalToday(): string {
  return resolveTrainingDay().date;
}

/**
 * Persist the opt-out flag for the user's current local day. Idempotent —
 * re-marking the same day simply refreshes the row (INSERT OR REPLACE in
 * the cache store). Returns the date string the flag was stored under.
 */
export function markKeepOriginalForToday(userId: number): string {
  const dateString = resolveKeepOriginalToday();
  setCache(keepOriginalCacheKey(userId, dateString), { kept: true }, KEEP_ORIGINAL_TTL_SECONDS);
  return dateString;
}

/** True when the user opted out of adaptation for the given local date. */
export function isKeepOriginalSet(userId: number, dateString: string): boolean {
  const flag = getCached<{ kept?: boolean }>(keepOriginalCacheKey(userId, dateString));
  return flag?.kept === true;
}

/** Convenience for the read paths: check the flag for today's local date. */
export function isKeepOriginalSetForToday(userId: number): boolean {
  return isKeepOriginalSet(userId, resolveKeepOriginalToday());
}
