// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { getDb } from './database';
import type { AuthSessionPayload } from './ios-auth-session';

const PENDING_TTL_MS = 10 * 60 * 1000;
const COMPLETION_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 1000;

const pendingInMemory = new Map<string, { deviceId: string; deviceName: string | null; createdAt: number }>();
const completionInMemory = new Map<string, { payload: AuthSessionPayload; createdAt: number }>();

let tablesEnsured = false;

function now(): number {
  return Date.now();
}

function getDbOrNull() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

function ensureTables(): boolean {
  const db = getDbOrNull();
  if (!db) return false;
  if (tablesEnsured) return true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS google_auth_pending_sessions (
      nonce TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      device_name TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_auth_pending_sessions_created_at
      ON google_auth_pending_sessions(created_at_ms);

    CREATE TABLE IF NOT EXISTS google_auth_completion_sessions (
      auth_code TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_google_auth_completion_sessions_created_at
      ON google_auth_completion_sessions(created_at_ms);
  `);
  tablesEnsured = true;
  return true;
}

function evictExpiredInMemory(): void {
  const pendingCutoff = now() - PENDING_TTL_MS;
  const completionCutoff = now() - COMPLETION_TTL_MS;

  for (const [nonce, entry] of pendingInMemory.entries()) {
    if (entry.createdAt < pendingCutoff) pendingInMemory.delete(nonce);
  }
  for (const [authCode, entry] of completionInMemory.entries()) {
    if (entry.createdAt < completionCutoff) completionInMemory.delete(authCode);
  }
}

function evictOverflowInMemory<T>(store: Map<string, T>): void {
  if (store.size < MAX_RECORDS) return;
  const oldestKeys = [...store.keys()].slice(0, Math.max(1, Math.floor(MAX_RECORDS * 0.1)));
  for (const key of oldestKeys) {
    store.delete(key);
  }
}

function evictExpiredPersistent(): void {
  if (!ensureTables()) return;
  const db = getDbOrNull();
  if (!db) return;

  db.prepare('DELETE FROM google_auth_pending_sessions WHERE created_at_ms < ?').run(now() - PENDING_TTL_MS);
  db.prepare('DELETE FROM google_auth_completion_sessions WHERE created_at_ms < ?').run(now() - COMPLETION_TTL_MS);
}

function evictOverflowPersistent(table: 'google_auth_pending_sessions' | 'google_auth_completion_sessions', keyColumn: 'nonce' | 'auth_code'): void {
  if (!ensureTables()) return;
  const db = getDbOrNull();
  if (!db) return;

  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  if (row.count < MAX_RECORDS) return;

  db.prepare(`
    DELETE FROM ${table}
    WHERE ${keyColumn} IN (
      SELECT ${keyColumn}
      FROM ${table}
      ORDER BY created_at_ms ASC
      LIMIT ?
    )
  `).run(Math.max(1, Math.floor(MAX_RECORDS * 0.1)));
}

export function createGoogleAuthPendingSession(
  deviceId: string,
  deviceName: string | null,
  nonce = crypto.randomBytes(16).toString('hex'),
): string {
  const createdAt = now();

  if (ensureTables()) {
    evictExpiredPersistent();
    evictOverflowPersistent('google_auth_pending_sessions', 'nonce');
    const db = getDbOrNull();
    if (db) {
      db.prepare(`
        INSERT INTO google_auth_pending_sessions (nonce, device_id, device_name, created_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(nonce, deviceId, deviceName, createdAt);
      return nonce;
    }
  }

  evictExpiredInMemory();
  evictOverflowInMemory(pendingInMemory);
  pendingInMemory.set(nonce, { deviceId, deviceName, createdAt });
  return nonce;
}

export function consumeGoogleAuthPendingSession(
  nonce: string,
): { deviceId: string; deviceName: string | null } | null {
  if (ensureTables()) {
    evictExpiredPersistent();
    const db = getDbOrNull();
    if (db) {
      const row = db.prepare(`
        SELECT device_id, device_name
        FROM google_auth_pending_sessions
        WHERE nonce = ?
      `).get(nonce) as { device_id: string; device_name: string | null } | undefined;
      if (!row) return null;
      db.prepare('DELETE FROM google_auth_pending_sessions WHERE nonce = ?').run(nonce);
      return { deviceId: row.device_id, deviceName: row.device_name };
    }
  }

  evictExpiredInMemory();
  const entry = pendingInMemory.get(nonce);
  if (!entry) return null;
  pendingInMemory.delete(nonce);
  return { deviceId: entry.deviceId, deviceName: entry.deviceName };
}

export function storeGoogleAuthCompletion(
  payload: AuthSessionPayload,
  authCode = crypto.randomBytes(20).toString('hex'),
): string {
  const createdAt = now();

  if (ensureTables()) {
    evictExpiredPersistent();
    evictOverflowPersistent('google_auth_completion_sessions', 'auth_code');
    const db = getDbOrNull();
    if (db) {
      db.prepare(`
        INSERT INTO google_auth_completion_sessions (auth_code, payload_json, created_at_ms)
        VALUES (?, ?, ?)
      `).run(authCode, JSON.stringify(payload), createdAt);
      return authCode;
    }
  }

  evictExpiredInMemory();
  evictOverflowInMemory(completionInMemory);
  completionInMemory.set(authCode, { payload, createdAt });
  return authCode;
}

export function consumeGoogleAuthCompletion(authCode: string): AuthSessionPayload | null {
  if (ensureTables()) {
    evictExpiredPersistent();
    const db = getDbOrNull();
    if (db) {
      const row = db.prepare(`
        SELECT payload_json
        FROM google_auth_completion_sessions
        WHERE auth_code = ?
      `).get(authCode) as { payload_json: string } | undefined;
      if (!row) return null;
      db.prepare('DELETE FROM google_auth_completion_sessions WHERE auth_code = ?').run(authCode);
      return JSON.parse(row.payload_json) as AuthSessionPayload;
    }
  }

  evictExpiredInMemory();
  const entry = completionInMemory.get(authCode);
  if (!entry) return null;
  completionInMemory.delete(authCode);
  return entry.payload;
}

export function isIOSGoogleAuthState(state: string): boolean {
  return state.startsWith('ios-auth:');
}

export function parseIOSGoogleAuthState(state: string): { nonce: string } | null {
  const parts = state.split(':');
  if (parts.length !== 2 || parts[0] !== 'ios-auth' || !parts[1]) return null;
  return { nonce: parts[1] };
}

export function _resetGoogleAuthSessionStoreForTests(): void {
  pendingInMemory.clear();
  completionInMemory.clear();
  tablesEnsured = false;
  const db = getDbOrNull();
  if (!db) return;
  db.exec(`
    DROP TABLE IF EXISTS google_auth_pending_sessions;
    DROP TABLE IF EXISTS google_auth_completion_sessions;
  `);
}
