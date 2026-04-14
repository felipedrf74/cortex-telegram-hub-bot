// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from '../services/database';
import { logger } from './logger';

// ─── Inline Keyboard Callback Store ─────────────────────────────────

interface CallbackEntry {
  data: any;
  expires: number;
}

const callbackStore = new Map<string, CallbackEntry>();

interface CallbackRow {
  data_json: string;
  expires_at_ms: number;
}

function getDbSafe() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function deletePersistedCallback(ref: string): void {
  const db = getDbSafe();
  if (!db) return;
  db.prepare('DELETE FROM callback_entries WHERE ref = ?').run(ref);
}

function prunePersistedCallbacks(nowMs = Date.now()): void {
  const db = getDbSafe();
  if (!db) return;
  db.prepare('DELETE FROM callback_entries WHERE expires_at_ms <= ?').run(nowMs);
}

function persistCallback(ref: string, data: any, expires: number): void {
  const db = getDbSafe();
  if (!db) return;

  try {
    db.prepare(`
      INSERT INTO callback_entries (ref, data_json, created_at_ms, expires_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET
        data_json = excluded.data_json,
        created_at_ms = excluded.created_at_ms,
        expires_at_ms = excluded.expires_at_ms,
        updated_at = datetime('now')
    `).run(ref, JSON.stringify(data), Date.now(), expires);
  } catch (err) {
    logger.warn({ err, ref }, 'Failed to persist callback entry');
  }
}

function loadPersistedCallback(ref: string): CallbackEntry | null {
  const db = getDbSafe();
  if (!db) return null;

  const row = db.prepare(`
    SELECT data_json, expires_at_ms
    FROM callback_entries
    WHERE ref = ?
  `).get(ref) as CallbackRow | undefined;

  if (!row) return null;
  if (row.expires_at_ms <= Date.now()) {
    deletePersistedCallback(ref);
    return null;
  }

  try {
    return {
      data: JSON.parse(row.data_json),
      expires: row.expires_at_ms,
    };
  } catch (err) {
    logger.warn({ err, ref }, 'Persisted callback payload is invalid — dropping row');
    deletePersistedCallback(ref);
    return null;
  }
}

// Time-based cleanup every 10 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of callbackStore) {
    if (entry.expires < now) {
      callbackStore.delete(key);
      deletePersistedCallback(key);
    }
  }
  prunePersistedCallbacks(now);
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

/**
 * Store callback data with a short-lived TTL.
 * @param data   Arbitrary payload retrieved later via getCallback()
 * @param ttlMs  Time-to-live in ms (default 5 min; content workflow uses 24 h)
 */
export function storeCallback(data: any, ttlMs = 300_000): string {
  const expires = Date.now() + ttlMs;
  const ref = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  callbackStore.set(ref, { data, expires });
  persistCallback(ref, data, expires);
  return ref;
}

export function getCallback(ref: string): any | null {
  const entry = callbackStore.get(ref);
  if (entry) {
    if (entry.expires < Date.now()) {
      callbackStore.delete(ref);
      deletePersistedCallback(ref);
      return null;
    }
    return entry.data;
  }

  const persisted = loadPersistedCallback(ref);
  if (!persisted) return null;
  callbackStore.set(ref, persisted);
  return persisted.data;
}

export function __resetCallbackCacheForTests(): void {
  callbackStore.clear();
}
