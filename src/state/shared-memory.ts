import { getDb } from '../services/database';

export interface SharedMemoryEntry {
  id: number;
  key: string;
  value: string;
  source_domain: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Upsert a cross-domain fact. Optional expires_at (ISO 8601) for auto-cleanup. */
export function setSharedMemory(
  key: string,
  value: string,
  sourceDomain: string,
  expiresAt?: string
): SharedMemoryEntry {
  const db = getDb();
  db.prepare(`
    INSERT INTO shared_memory (key, value, source_domain, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      source_domain = excluded.source_domain,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(key, value, sourceDomain, expiresAt || null);
  return db.prepare('SELECT * FROM shared_memory WHERE key = ?').get(key) as SharedMemoryEntry;
}

/** Get all active (non-expired) shared memory entries, or a single key. */
export function getSharedMemory(key?: string): SharedMemoryEntry[] {
  const db = getDb();
  // Clean up expired entries first
  db.prepare(`DELETE FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();

  if (key) {
    const row = db.prepare('SELECT * FROM shared_memory WHERE key = ?').get(key);
    return row ? [row as SharedMemoryEntry] : [];
  }
  return db.prepare('SELECT * FROM shared_memory ORDER BY updated_at DESC').all() as SharedMemoryEntry[];
}

/** Remove a shared memory entry by key. Returns true if deleted. */
export function removeSharedMemory(key: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM shared_memory WHERE key = ?').run(key);
  return result.changes > 0;
}

/** Build a compact summary of shared memory for injection into domain state context. */
export function getSharedMemorySummary(): string {
  const entries = getSharedMemory();
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.key}: ${e.value} (from ${e.source_domain})`);
  return `\nShared context:\n${lines.join('\n')}`;
}
