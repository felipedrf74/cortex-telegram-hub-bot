// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';

// ─── Inline Keyboard Callback Store ─────────────────────────────────

interface CallbackEntry {
  data: any;
  expires: number;
}

const callbackStore = new Map<string, CallbackEntry>();

// Time-based cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of callbackStore) {
    if (entry.expires < now) callbackStore.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * Store callback data with a short-lived TTL.
 * @param data   Arbitrary payload retrieved later via getCallback()
 * @param ttlMs  Time-to-live in ms (default 5 min; content workflow uses 24 h)
 */
export function storeCallback(data: any, ttlMs = 300_000): string {
  const ref = crypto.randomUUID().slice(0, 8);
  callbackStore.set(ref, { data, expires: Date.now() + ttlMs });
  return ref;
}

export function getCallback(ref: string): any | null {
  const entry = callbackStore.get(ref);
  if (!entry || entry.expires < Date.now()) {
    callbackStore.delete(ref);
    return null;
  }
  return entry.data;
}
