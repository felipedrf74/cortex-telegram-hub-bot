// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getDb } from './database';
import type { AuthSessionPayload } from './ios-auth-session';
import { getUserByAppleId, getUserByEmail, createAppleUser, type User } from './user-service';
import { logger } from '../utils/logger';

const PENDING_TTL_MS = 10 * 60 * 1000;
const COMPLETION_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDS = 1000;
const APPLE_JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const APPLE_JWKS_FORCE_REFRESH_MIN_GAP_MS = 60 * 1000;
export const APPLE_WEB_STATE_PREFIX = 'web-apple';

const pendingInMemory = new Map<string, { nonceHash: string; deviceId: string; deviceName: string | null; createdAt: number }>();
const completionInMemory = new Map<string, { payload: AuthSessionPayload; createdAt: number }>();

let tablesEnsured = false;
let appleJwksCache: { keys: any[]; fetchedAt: number } | null = null;
let appleJwksLastForceRefresh = 0;

export class AppleWebSignInNotConfiguredError extends Error {
  constructor() {
    super('Apple web sign-in is not configured');
    this.name = 'AppleWebSignInNotConfiguredError';
  }
}

export class AppleWebPrivateRelayLinkRefusedError extends Error {
  constructor() {
    super('Apple private relay cannot be linked to an existing non-Apple account');
    this.name = 'AppleWebPrivateRelayLinkRefusedError';
  }
}

export interface AppleWebPendingSession {
  state: string;
  nonceHash: string;
}

export interface AppleWebIdentityPayload {
  iss: string;
  aud: string;
  sub: string;
  nonce: string;
  email?: string;
  emailVerified?: boolean;
}

interface AppleProfileHint {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

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
    CREATE TABLE IF NOT EXISTS apple_web_auth_pending_sessions (
      state_nonce TEXT PRIMARY KEY,
      nonce_hash TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apple_web_auth_pending_sessions_created_at
      ON apple_web_auth_pending_sessions(created_at_ms);

    CREATE TABLE IF NOT EXISTS apple_web_auth_completion_sessions (
      auth_code TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apple_web_auth_completion_sessions_created_at
      ON apple_web_auth_completion_sessions(created_at_ms);
  `);
  tablesEnsured = true;
  return true;
}

function evictExpiredInMemory(): void {
  const pendingCutoff = now() - PENDING_TTL_MS;
  const completionCutoff = now() - COMPLETION_TTL_MS;
  for (const [stateNonce, entry] of pendingInMemory.entries()) {
    if (entry.createdAt < pendingCutoff) pendingInMemory.delete(stateNonce);
  }
  for (const [authCode, entry] of completionInMemory.entries()) {
    if (entry.createdAt < completionCutoff) completionInMemory.delete(authCode);
  }
}

function evictOverflowInMemory<T>(store: Map<string, T>): void {
  if (store.size < MAX_RECORDS) return;
  const oldestKeys = [...store.keys()].slice(0, Math.max(1, Math.floor(MAX_RECORDS * 0.1)));
  for (const key of oldestKeys) store.delete(key);
}

function evictExpiredPersistent(): void {
  if (!ensureTables()) return;
  const db = getDbOrNull();
  if (!db) return;

  db.prepare('DELETE FROM apple_web_auth_pending_sessions WHERE created_at_ms < ?')
    .run(now() - PENDING_TTL_MS);
  db.prepare('DELETE FROM apple_web_auth_completion_sessions WHERE created_at_ms < ?')
    .run(now() - COMPLETION_TTL_MS);
}

function evictOverflowPersistent(
  table: 'apple_web_auth_pending_sessions' | 'apple_web_auth_completion_sessions',
  keyColumn: 'state_nonce' | 'auth_code',
): void {
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

export function hashAppleWebNonce(rawNonce: string): string {
  return crypto.createHash('sha256').update(rawNonce).digest('hex');
}

export function appleWebSignInConfigured(): boolean {
  return Boolean(config.appleWeb.clientId && config.appleWeb.redirectUri);
}

export function createAppleWebAuthPendingSession(
  deviceId: string,
  deviceName: string | null,
  stateNonce = crypto.randomBytes(16).toString('hex'),
  rawNonce = crypto.randomBytes(32).toString('hex'),
): AppleWebPendingSession {
  const createdAt = now();
  const nonceHash = hashAppleWebNonce(rawNonce);

  if (ensureTables()) {
    evictExpiredPersistent();
    evictOverflowPersistent('apple_web_auth_pending_sessions', 'state_nonce');
    const db = getDbOrNull();
    if (db) {
      db.prepare(`
        INSERT INTO apple_web_auth_pending_sessions (state_nonce, nonce_hash, device_id, device_name, created_at_ms)
        VALUES (?, ?, ?, ?, ?)
      `).run(stateNonce, nonceHash, deviceId, deviceName, createdAt);
      return { state: `${APPLE_WEB_STATE_PREFIX}:${stateNonce}`, nonceHash };
    }
  }

  evictExpiredInMemory();
  evictOverflowInMemory(pendingInMemory);
  pendingInMemory.set(stateNonce, { nonceHash, deviceId, deviceName, createdAt });
  return { state: `${APPLE_WEB_STATE_PREFIX}:${stateNonce}`, nonceHash };
}

export function consumeAppleWebAuthPendingSession(
  stateNonce: string,
): { nonceHash: string; deviceId: string; deviceName: string | null } | null {
  if (ensureTables()) {
    evictExpiredPersistent();
    const db = getDbOrNull();
    if (db) {
      const row = db.prepare(`
        SELECT nonce_hash, device_id, device_name
        FROM apple_web_auth_pending_sessions
        WHERE state_nonce = ?
      `).get(stateNonce) as
        | { nonce_hash: string; device_id: string; device_name: string | null }
        | undefined;
      if (!row) return null;
      db.prepare('DELETE FROM apple_web_auth_pending_sessions WHERE state_nonce = ?').run(stateNonce);
      return { nonceHash: row.nonce_hash, deviceId: row.device_id, deviceName: row.device_name };
    }
  }

  evictExpiredInMemory();
  const entry = pendingInMemory.get(stateNonce);
  if (!entry) return null;
  pendingInMemory.delete(stateNonce);
  return { nonceHash: entry.nonceHash, deviceId: entry.deviceId, deviceName: entry.deviceName };
}

export function storeAppleWebAuthCompletion(
  payload: AuthSessionPayload,
  authCode = crypto.randomBytes(20).toString('hex'),
): string {
  const createdAt = now();

  if (ensureTables()) {
    evictExpiredPersistent();
    evictOverflowPersistent('apple_web_auth_completion_sessions', 'auth_code');
    const db = getDbOrNull();
    if (db) {
      db.prepare(`
        INSERT INTO apple_web_auth_completion_sessions (auth_code, payload_json, created_at_ms)
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

export function consumeAppleWebAuthCompletion(authCode: string): AuthSessionPayload | null {
  if (ensureTables()) {
    evictExpiredPersistent();
    const db = getDbOrNull();
    if (db) {
      const row = db.prepare(`
        SELECT payload_json
        FROM apple_web_auth_completion_sessions
        WHERE auth_code = ?
      `).get(authCode) as { payload_json: string } | undefined;
      if (!row) return null;
      db.prepare('DELETE FROM apple_web_auth_completion_sessions WHERE auth_code = ?').run(authCode);
      return JSON.parse(row.payload_json) as AuthSessionPayload;
    }
  }

  evictExpiredInMemory();
  const entry = completionInMemory.get(authCode);
  if (!entry) return null;
  completionInMemory.delete(authCode);
  return entry.payload;
}

export function isWebAppleAuthState(state: string): boolean {
  return state.startsWith(`${APPLE_WEB_STATE_PREFIX}:`);
}

export function parseWebAppleAuthState(state: string): { nonce: string } | null {
  const parts = state.split(':');
  if (parts.length !== 2 || parts[0] !== APPLE_WEB_STATE_PREFIX || !parts[1]) return null;
  return { nonce: parts[1] };
}

export function buildAppleWebAuthorizeUrl(session: AppleWebPendingSession): string {
  if (!appleWebSignInConfigured()) {
    throw new AppleWebSignInNotConfiguredError();
  }

  const params = new URLSearchParams({
    client_id: config.appleWeb.clientId,
    redirect_uri: config.appleWeb.redirectUri,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state: session.state,
    nonce: session.nonceHash,
  });

  return `https://appleid.apple.com/auth/authorize?${params.toString()}`;
}

async function getAppleJwks(forceRefresh = false): Promise<any[]> {
  const current = now();
  if (
    !forceRefresh &&
    appleJwksCache &&
    current - appleJwksCache.fetchedAt < APPLE_JWKS_TTL_MS
  ) {
    return appleJwksCache.keys;
  }
  if (forceRefresh && current - appleJwksLastForceRefresh < APPLE_JWKS_FORCE_REFRESH_MIN_GAP_MS) {
    return appleJwksCache?.keys ?? [];
  }

  const res = await fetch('https://appleid.apple.com/auth/keys');
  const data = await res.json() as { keys: any[] };
  appleJwksCache = { keys: data.keys, fetchedAt: current };
  if (forceRefresh) appleJwksLastForceRefresh = current;
  return data.keys;
}

function normalizeEmailVerified(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

export async function verifyAppleWebIdentityToken(
  identityToken: string,
  expectedNonceHash: string,
): Promise<AppleWebIdentityPayload> {
  if (!appleWebSignInConfigured()) {
    throw new AppleWebSignInNotConfiguredError();
  }

  const header = JSON.parse(Buffer.from(identityToken.split('.')[0] ?? '', 'base64url').toString());
  let keys = await getAppleJwks();
  let key = keys.find((candidate: any) => candidate.kid === header.kid);
  if (!key) {
    keys = await getAppleJwks(true);
    key = keys.find((candidate: any) => candidate.kid === header.kid);
  }
  if (!key) {
    throw new Error('Apple key not found');
  }

  const jwkToPem = crypto.createPublicKey({ key, format: 'jwk' });
  const payload = jwt.verify(identityToken, jwkToPem, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience: config.appleWeb.clientId,
    maxAge: '5m',
    clockTolerance: 30,
  }) as any;

  if (!payload?.sub || typeof payload.sub !== 'string') {
    throw new Error('Apple identity payload is missing sub');
  }
  if (payload.nonce !== expectedNonceHash) {
    throw new Error('Apple identity nonce mismatch');
  }

  return {
    iss: payload.iss,
    aud: payload.aud,
    sub: payload.sub,
    nonce: payload.nonce,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    emailVerified: normalizeEmailVerified(payload.email_verified),
  };
}

export function parseAppleUserHint(rawUser: unknown): AppleProfileHint {
  if (typeof rawUser !== 'string' || !rawUser.trim()) return {};
  try {
    const parsed = JSON.parse(rawUser) as {
      email?: string;
      name?: { firstName?: string; lastName?: string };
    };
    return {
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      firstName: typeof parsed.name?.firstName === 'string' ? parsed.name.firstName : undefined,
      lastName: typeof parsed.name?.lastName === 'string' ? parsed.name.lastName : undefined,
    };
  } catch {
    return {};
  }
}

export function resolveAppleWebIdentityUser(
  payload: AppleWebIdentityPayload,
  profileHint: AppleProfileHint = {},
): User {
  const appleUserId = payload.sub;
  const email = payload.email || profileHint.email || undefined;
  const normalizedEmail = (email || '').toLowerCase();
  const isPrivateRelay = normalizedEmail.endsWith('@privaterelay.appleid.com');

  let user = getUserByAppleId(appleUserId);
  if (!user) {
    if (isPrivateRelay) {
      const existing = getUserByEmail(normalizedEmail);
      if (existing && !existing.apple_user_id) {
        logger.warn(
          {
            event: 'auth.apple_web_privaterelay_link_refused',
            appleUserId,
            existingUserId: existing.id,
          },
          'Apple web sign-in refused to link private relay email to an existing non-Apple user',
        );
        throw new AppleWebPrivateRelayLinkRefusedError();
      }
    }

    user = createAppleUser(appleUserId, {
      email,
      firstName: profileHint.firstName || undefined,
      lastName: profileHint.lastName || undefined,
    });
  }

  return user;
}

export function _resetAppleWebSignInForTests(): void {
  pendingInMemory.clear();
  completionInMemory.clear();
  tablesEnsured = false;
  appleJwksCache = null;
  appleJwksLastForceRefresh = 0;
  const db = getDbOrNull();
  if (!db) return;
  db.exec(`
    DROP TABLE IF EXISTS apple_web_auth_pending_sessions;
    DROP TABLE IF EXISTS apple_web_auth_completion_sessions;
  `);
}
