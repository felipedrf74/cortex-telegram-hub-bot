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
import { isValidTenantUserId } from './tenant-scope-observability';

export interface CacheStoreStats {
  initCalls: number;
  initFailures: number;
  readCount: number;
  swrReadCount: number;
  hitCount: number;
  missCount: number;
  staleHitCount: number;
  writeCount: number;
  clearCount: number;
  clearByPrefixCount: number;
  expireSweepCount: number;
  expiredEntriesCleared: number;
  readErrors: number;
  writeErrors: number;
  parseErrors: number;
  lastErrorAt: string | null;
  lastErrorOperation: string | null;
  lastErrorKey: string | null;
}

const cacheStoreStats: CacheStoreStats = {
  initCalls: 0,
  initFailures: 0,
  readCount: 0,
  swrReadCount: 0,
  hitCount: 0,
  missCount: 0,
  staleHitCount: 0,
  writeCount: 0,
  clearCount: 0,
  clearByPrefixCount: 0,
  expireSweepCount: 0,
  expiredEntriesCleared: 0,
  readErrors: 0,
  writeErrors: 0,
  parseErrors: 0,
  lastErrorAt: null,
  lastErrorOperation: null,
  lastErrorKey: null,
};

function recordCacheError(kind: 'read' | 'write' | 'parse', operation: string, key?: string): void {
  if (kind === 'read') cacheStoreStats.readErrors += 1;
  if (kind === 'write') cacheStoreStats.writeErrors += 1;
  if (kind === 'parse') cacheStoreStats.parseErrors += 1;
  cacheStoreStats.lastErrorAt = new Date().toISOString();
  cacheStoreStats.lastErrorOperation = operation;
  cacheStoreStats.lastErrorKey = key ?? null;
}

export function getCacheStoreStats(): CacheStoreStats {
  return { ...cacheStoreStats };
}

export function _resetCacheStoreStatsForTests(): void {
  cacheStoreStats.initCalls = 0;
  cacheStoreStats.initFailures = 0;
  cacheStoreStats.readCount = 0;
  cacheStoreStats.swrReadCount = 0;
  cacheStoreStats.hitCount = 0;
  cacheStoreStats.missCount = 0;
  cacheStoreStats.staleHitCount = 0;
  cacheStoreStats.writeCount = 0;
  cacheStoreStats.clearCount = 0;
  cacheStoreStats.clearByPrefixCount = 0;
  cacheStoreStats.expireSweepCount = 0;
  cacheStoreStats.expiredEntriesCleared = 0;
  cacheStoreStats.readErrors = 0;
  cacheStoreStats.writeErrors = 0;
  cacheStoreStats.parseErrors = 0;
  cacheStoreStats.lastErrorAt = null;
  cacheStoreStats.lastErrorOperation = null;
  cacheStoreStats.lastErrorKey = null;
}

/** Ensure the api_cache table exists */
export function initCacheStore(): void {
  cacheStoreStats.initCalls += 1;
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
    cacheStoreStats.initFailures += 1;
    recordCacheError('write', 'initCacheStore');
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
 * Build a per-user cache key for authenticated tenant data.
 *
 * Unlike `userCacheKey`, this rejects missing/invalid tenant scopes. Use it
 * on app-facing API paths where a cache collision could expose another
 * user's data.
 */
export function requireUserCacheKey(userId: number, base: string): string {
  if (!isValidTenantUserId(userId)) {
    throw new Error('Invalid tenant user id for user-scoped cache key');
  }
  return userCacheKey(userId, base);
}

/**
 * Get a cached value by key. Returns null if not found or expired.
 */
export function getCached<T = unknown>(key: string): T | null {
  cacheStoreStats.readCount += 1;
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const row = db.prepare(
      'SELECT value_json FROM api_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, now) as { value_json: string } | undefined;

    if (!row) {
      cacheStoreStats.missCount += 1;
      return null;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(row.value_json);
    } catch (err) {
      recordCacheError('parse', 'getCached', key);
      logger.debug({ err, key }, 'Cache read parse failed');
      return null;
    }
    cacheStoreStats.hitCount += 1;
    // SWR-wrapped values are envelopes — unwrap and ignore freshness for
    // legacy callers (they get whatever's currently stored).
    if (parsed && typeof parsed === 'object' && '__swr' in parsed) {
      return parsed.value as T;
    }
    return parsed as T;
  } catch (err) {
    recordCacheError('read', 'getCached', key);
    logger.debug({ err, key }, 'Cache read failed');
    return null;
  }
}

/**
 * Set a cache value with TTL in seconds.
 */
export function setCache(key: string, value: unknown, ttlSeconds: number): void {
  cacheStoreStats.writeCount += 1;
  try {
    const db = getDb();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(
      'INSERT OR REPLACE INTO api_cache (cache_key, value_json, expires_at) VALUES (?, ?, ?)',
    ).run(key, JSON.stringify(value), expiresAt);
  } catch (err) {
    recordCacheError('write', 'setCache', key);
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
  cacheStoreStats.swrReadCount += 1;
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const row = db.prepare(
      'SELECT value_json FROM api_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, now) as { value_json: string } | undefined;

    if (!row) {
      cacheStoreStats.missCount += 1;
      return null;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(row.value_json);
    } catch (err) {
      recordCacheError('parse', 'getCachedSWR', key);
      logger.debug({ err, key }, 'SWR cache read parse failed');
      return null;
    }
    cacheStoreStats.hitCount += 1;

    // Legacy non-envelope row — treat as always fresh
    if (!parsed || typeof parsed !== 'object' || !('__swr' in parsed)) {
      return { value: parsed as T, fresh: true };
    }

    const env = parsed as SWREnvelope<T>;
    const fresh = Date.now() < env.freshUntil;
    if (!fresh) cacheStoreStats.staleHitCount += 1;
    return { value: env.value, fresh };
  } catch (err) {
    recordCacheError('read', 'getCachedSWR', key);
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
  cacheStoreStats.writeCount += 1;
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
    recordCacheError('write', 'setCacheSWR', key);
    logger.debug({ err, key }, 'SWR cache write failed');
  }
}

/**
 * Delete a specific cache entry.
 */
export function clearCache(key: string): void {
  cacheStoreStats.clearCount += 1;
  try {
    getDb().prepare('DELETE FROM api_cache WHERE cache_key = ?').run(key);
  } catch (err) {
    recordCacheError('write', 'clearCache', key);
    logger.debug({ err, key }, 'Cache clear failed');
    // Best-effort
  }
}

/**
 * Delete all cache entries whose keys share a prefix.
 * Used by mesh-priority invalidation where one high-priority signal
 * should expire multiple derived planning views at once.
 */
export function clearCacheByPrefix(prefix: string): void {
  cacheStoreStats.clearByPrefixCount += 1;
  try {
    getDb().prepare('DELETE FROM api_cache WHERE cache_key LIKE ?').run(`${prefix}%`);
  } catch (err) {
    recordCacheError('write', 'clearCacheByPrefix', prefix);
    logger.debug({ err, prefix }, 'Cache clear by prefix failed');
    // Best-effort
  }
}

/**
 * Delete all expired cache entries. Call periodically (e.g., every hour).
 */
export function clearExpired(): void {
  cacheStoreStats.expireSweepCount += 1;
  try {
    const now = new Date().toISOString();
    const result = getDb().prepare('DELETE FROM api_cache WHERE expires_at < ?').run(now);
    cacheStoreStats.expiredEntriesCleared += Number(result.changes || 0);
    if (result.changes > 0) {
      logger.debug({ cleared: result.changes }, 'Cleared expired cache entries');
    }
  } catch (err) {
    recordCacheError('write', 'clearExpired');
    logger.debug({ err }, 'Cache expiry sweep failed');
    // Best-effort
  }
}
