// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * SQLite-backed cache for expensive computations (coach briefing, readiness, etc.).
 * Survives process restarts, deploys, and PM2 reloads.
 *
 * Usage:
 *   import { getCached, setCache, clearExpired } from './cache-store';
 *   const data = getCached<MyType>('key');
 *   setCache('key', data, 3600); // 1 hour TTL
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

/** Ensure the api_cache table exists */
export function initCacheStore(): void {
  try {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_cache (
        cache_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache(expires_at)');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize api_cache table (may already exist)');
  }
}

/**
 * Build a per-user cache key. ALWAYS use this for user-facing data
 * to prevent cross-user cache collisions.
 *
 * Usage:
 *   const key = userCacheKey(userId, 'dashboard');
 *   setCache(key, data, 300);
 *
 * For system-wide caches (model config, global stats), use raw keys.
 */
export function userCacheKey(userId: number | undefined, base: string): string {
  if (userId == null) return base;
  return `u:${userId}:${base}`;
}

/**
 * Get a cached value by key. Returns null if not found or expired.
 */
export function getCached<T = unknown>(key: string): T | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const row = db.prepare(
      'SELECT value_json FROM api_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, now) as { value_json: string } | undefined;

    if (!row) return null;
    const parsed = JSON.parse(row.value_json);
    // SWR-wrapped values are envelopes — unwrap and ignore freshness for
    // legacy callers (they get whatever's currently stored).
    if (parsed && typeof parsed === 'object' && '__swr' in parsed) {
      return parsed.value as T;
    }
    return parsed as T;
  } catch (err) {
    logger.debug({ err, key }, 'Cache read failed');
    return null;
  }
}

/**
 * Set a cache value with TTL in seconds.
 */
export function setCache(key: string, value: unknown, ttlSeconds: number): void {
  try {
    const db = getDb();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO api_cache (cache_key, value_json, expires_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(value), expiresAt);
  } catch (err) {
    logger.debug({ err, key }, 'Cache write failed');
  }
}

// ─── Stale-While-Revalidate ─────────────────────────────────────────
//
// SWR wraps the value in an envelope `{ __swr: 1, value, freshUntil }` and
// uses a longer hard expiry. Reads return `{ value, fresh }` so the caller
// can decide whether to serve immediately and refresh in the background.
//
// Legacy `getCached` automatically unwraps the envelope, so old call sites
// keep working without modification.
//
// Why a JSON envelope instead of a new SQL column? Avoids schema migration
// — the existing api_cache table just stores JSON, and we can ship the
// feature without a deploy-time DB change.

interface SWREnvelope<T> {
  __swr: 1;
  value: T;
  freshUntil: number; // epoch ms
}

/**
 * Read a cache entry with stale-while-revalidate semantics.
 *
 * Returns `null` if the entry doesn't exist OR has hard-expired.
 * Otherwise returns `{ value, fresh }` where `fresh: false` means the entry
 * is past its freshness boundary but still within the hard expiry — the
 * caller should serve it AND trigger a background refresh.
 */
export function getCachedSWR<T = unknown>(key: string): { value: T; fresh: boolean } | null {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const row = db.prepare(
      'SELECT value_json FROM api_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, now) as { value_json: string } | undefined;

    if (!row) return null;
    const parsed = JSON.parse(row.value_json);

    // Legacy non-envelope row — treat as always fresh
    if (!parsed || typeof parsed !== 'object' || !('__swr' in parsed)) {
      return { value: parsed as T, fresh: true };
    }

    const env = parsed as SWREnvelope<T>;
    return { value: env.value, fresh: Date.now() < env.freshUntil };
  } catch (err) {
    logger.debug({ err, key }, 'SWR cache read failed');
    return null;
  }
}

/**
 * Write a cache entry with separate freshness and hard-expiry windows.
 *
 * @param key Cache key
 * @param value The value to cache
 * @param freshSeconds How long the entry counts as "fresh" — within this
 *                     window callers serve immediately with no refresh
 * @param staleSeconds How long the entry can be served as "stale" past the
 *                     fresh boundary. After this, the row is hard-expired
 *                     and `getCachedSWR` returns null. Defaults to 5x freshSec.
 */
export function setCacheSWR(
  key: string,
  value: unknown,
  freshSeconds: number,
  staleSeconds?: number,
): void {
  try {
    const db = getDb();
    const stale = staleSeconds ?? freshSeconds * 5;
    const freshUntil = Date.now() + freshSeconds * 1000;
    const expiresAt = new Date(Date.now() + stale * 1000).toISOString();
    const envelope: SWREnvelope<unknown> = {
      __swr: 1,
      value,
      freshUntil,
    };
    db.prepare(
      'INSERT OR REPLACE INTO api_cache (cache_key, value_json, expires_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(envelope), expiresAt);
  } catch (err) {
    logger.debug({ err, key }, 'SWR cache write failed');
  }
}

/**
 * Delete a specific cache entry.
 */
export function clearCache(key: string): void {
  try {
    getDb().prepare('DELETE FROM api_cache WHERE cache_key = ?').run(key);
  } catch {
    // Best-effort
  }
}

/**
 * Delete all expired cache entries. Call periodically (e.g., every hour).
 */
export function clearExpired(): void {
  try {
    const now = new Date().toISOString();
    const result = getDb().prepare('DELETE FROM api_cache WHERE expires_at < ?').run(now);
    if (result.changes > 0) {
      logger.debug({ cleared: result.changes }, 'Cleared expired cache entries');
    }
  } catch {
    // Best-effort
  }
}
