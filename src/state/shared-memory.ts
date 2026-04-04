// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';

export interface SharedMemoryEntry {
  id: number;
  key: string;
  value: string;
  source_domain: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  user_id: number;
}

/** Upsert a cross-domain fact. Optional expires_at (ISO 8601) for auto-cleanup. */
export function setSharedMemory(
  userId: number,
  key: string,
  value: string,
  sourceDomain: string,
  expiresAt?: string
): SharedMemoryEntry {
  const db = getDb();
  db.prepare(`
    INSERT INTO shared_memory (user_id, key, value, source_domain, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value = excluded.value,
      source_domain = excluded.source_domain,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(userId, key, value, sourceDomain, expiresAt || null);
  return db.prepare('SELECT * FROM shared_memory WHERE user_id = ? AND key = ?').get(userId, key) as SharedMemoryEntry;
}

// Rate-limit expired entry cleanup — at most once per 5 minutes
let lastCleanup = 0;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Get all active (non-expired) shared memory entries for a user, or a single key. */
export function getSharedMemory(userId: number, key?: string): SharedMemoryEntry[] {
  const db = getDb();
  const now = Date.now();
  if (now - lastCleanup > CLEANUP_INTERVAL_MS) {
    db.prepare(`DELETE FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
    lastCleanup = now;
  }

  if (key) {
    const row = db.prepare('SELECT * FROM shared_memory WHERE user_id = ? AND key = ?').get(userId, key);
    return row ? [row as SharedMemoryEntry] : [];
  }
  return db.prepare('SELECT * FROM shared_memory WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as SharedMemoryEntry[];
}

/** Remove a shared memory entry by key. Returns true if deleted. */
export function removeSharedMemory(userId: number, key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM shared_memory WHERE user_id = ? AND key = ?').run(userId, key);
  return result.changes > 0;
}

/** Build a compact summary of shared memory for injection into domain state context. */
export function getSharedMemorySummary(userId: number): string {
  const entries = getSharedMemory(userId);
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.key}: ${e.value} (from ${e.source_domain})`);
  return `\nShared context:\n${lines.join('\n')}`;
}
