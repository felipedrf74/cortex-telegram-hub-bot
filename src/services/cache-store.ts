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
    return JSON.parse(row.value_json) as T;
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
