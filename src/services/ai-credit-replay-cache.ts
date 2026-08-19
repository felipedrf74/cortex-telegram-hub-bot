// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Bounded per-reservation result cache behind the credit replay identity
 * (QA3 P3-17 / NH-0040).
 *
 * A genuine post-network-drop retry carries the same client operation id and
 * content hash, resolves to the already-captured reservation, and must get
 * its answer back instead of `AI_CREDIT_REPLAY_SETTLED`. The cache is
 * in-memory only and short-lived by design: it serves the reconnect window
 * without persisting private chat content anywhere durable.
 */

const MAX_ENTRIES = 256;
const TTL_MS = 15 * 60_000;

const entries = new Map<number, { at: number; payload: string }>();

export function _resetAiCreditReplayCacheForTests(): void {
  entries.clear();
}

export function rememberAiCreditReplayResult(reservationId: number, payload: string): void {
  if (!Number.isSafeInteger(reservationId) || reservationId <= 0 || !payload) return;
  entries.delete(reservationId);
  entries.set(reservationId, { at: Date.now(), payload });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/**
 * Non-destructive read: a client may retry more than once inside the window
 * and every retry resolves to the same settled reservation.
 */
export function getAiCreditReplayResult(reservationId: number): string | null {
  const entry = entries.get(reservationId);
  if (!entry) return null;
  if (Date.now() - entry.at > TTL_MS) {
    entries.delete(reservationId);
    return null;
  }
  return entry.payload;
}
