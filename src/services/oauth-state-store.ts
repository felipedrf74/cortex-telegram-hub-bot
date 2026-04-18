// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import type { OAuthProvider } from './oauth-store';

const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_NONCES = 1000;
const inMemoryStore = new Map<string, { userId: number; provider: OAuthProvider; createdAt: number }>();

let tableEnsured = false;

function getNow(): number {
  return Date.now();
}

function getDbOrNull() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function ensureTable(): boolean {
  const db = getDbOrNull();
  if (!db) return false;
  if (tableEnsured) return true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_ios_nonce_sessions (
      nonce TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_ios_nonce_sessions_created_at
      ON oauth_ios_nonce_sessions(created_at_ms);
  `);
  tableEnsured = true;
  return true;
}

function cleanExpiredInMemory(): void {
  const cutoff = getNow() - NONCE_TTL_MS;
  for (const [nonce, entry] of inMemoryStore.entries()) {
    if (entry.createdAt < cutoff) inMemoryStore.delete(nonce);
  }
}

function evictOldestInMemory(): void {
  if (inMemoryStore.size < MAX_NONCES) return;
  const oldest = [...inMemoryStore.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, Math.max(1, Math.floor(MAX_NONCES * 0.1)));
  for (const [nonce] of oldest) {
    inMemoryStore.delete(nonce);
  }
}

function cleanExpiredPersistent(): void {
  if (!ensureTable()) return;
  const db = getDbOrNull();
  if (!db) return;
  db.prepare('DELETE FROM oauth_ios_nonce_sessions WHERE created_at_ms < ?').run(getNow() - NONCE_TTL_MS);
}

function evictOldestPersistent(): void {
  if (!ensureTable()) return;
  const db = getDbOrNull();
  if (!db) return;
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM oauth_ios_nonce_sessions').get() as { count: number };
  if (countRow.count < MAX_NONCES) return;
  db.prepare(`
    DELETE FROM oauth_ios_nonce_sessions
    WHERE nonce IN (
      SELECT nonce
      FROM oauth_ios_nonce_sessions
      ORDER BY created_at_ms ASC
      LIMIT ?
    )
  `).run(Math.max(1, Math.floor(MAX_NONCES * 0.1)));
}

export function createOAuthNonceSession(
  userId: number,
  provider: OAuthProvider,
  nonce = crypto.randomBytes(16).toString('hex'),
): string {
  const createdAt = getNow();

  if (ensureTable()) {
    cleanExpiredPersistent();
    evictOldestPersistent();
    const db = getDbOrNull();
    if (db) {
      db.prepare(`
        INSERT INTO oauth_ios_nonce_sessions (nonce, user_id, provider, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(nonce, userId, provider, createdAt);
      return nonce;
    }
  }

  cleanExpiredInMemory();
  evictOldestInMemory();
  inMemoryStore.set(nonce, { userId, provider, createdAt });
  return nonce;
}

export function consumeOAuthNonceSession(
  nonce: string,
): { userId: number; provider: OAuthProvider } | null {
  if (ensureTable()) {
    cleanExpiredPersistent();
    const db = getDbOrNull();
    if (db) {
      const row = db.prepare(`
        SELECT user_id, provider
        FROM oauth_ios_nonce_sessions
        WHERE nonce = ?
      `).get(nonce) as { user_id: number; provider: OAuthProvider } | undefined;
      if (!row) return null;
      db.prepare('DELETE FROM oauth_ios_nonce_sessions WHERE nonce = ?').run(nonce);
      return { userId: row.user_id, provider: row.provider };
    }
  }

  cleanExpiredInMemory();
  const entry = inMemoryStore.get(nonce);
  if (!entry) return null;
  inMemoryStore.delete(nonce);
  return { userId: entry.userId, provider: entry.provider };
}

export function _resetOAuthNonceStoreForTests(): void {
  inMemoryStore.clear();
  tableEnsured = false;
  const db = getDbOrNull();
  if (!db) return;
  db.exec('DROP TABLE IF EXISTS oauth_ios_nonce_sessions');
}
