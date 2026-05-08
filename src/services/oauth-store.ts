// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Token Store — encrypted per-user token storage in SQLite.
 *
 * Tokens are encrypted at rest using AES-256-GCM with per-user key derivation.
 * Uses the existing encryption utilities from src/utils/encryption.ts.
 *
 * In-memory cache: decrypted tokens are cached per (userId, provider) pair
 * for DECRYPT_CACHE_TTL_MS to prevent the audit-trail bomb discovered in
 * April 2026. Without this cache, every Google/Outlook API call triggered
 * a fresh SELECT + decrypt + audit_trail INSERT, producing ~11,000 rows/day
 * for a single user. With the cache, we decrypt at most once per TTL window
 * and write exactly one audit row per actual decryption. The cache is
 * invalidated on storeTokens() and disconnectProvider() so re-auth is
 * immediately visible. See Phase 0.C in the product roadmap.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { encryptValue, decryptValue } from '../utils/encryption';
import { LRUMap } from '../utils/lru-map';
import { getOwnerBootstrapUserRefs } from './user-service';
import { notifyOAuthTokenMutation } from './oauth-token-cache-events';

// ─── Types ──────────────────────────────────────────────────────────

export type OAuthProvider =
  | 'google'
  | 'outlook'
  | 'strava'
  | 'whoop'
  | 'fitbit'
  | 'todoist'   // TASK-16b — task provider with webhooks + Sync API cursors
  | 'notion';   // TASK-16b — task provider, polling-only, per-database mapping

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: string | null;
  scopes: string[];
}

export class ProviderNotConnectedError extends Error {
  constructor(public provider: string) {
    super(`${provider} is not connected. Use /connect ${provider} to set up.`);
    this.name = 'ProviderNotConnectedError';
  }
}

// ─── Encryption key ─────────────────────────────────────────────────
//
// OAuth refresh tokens are valuable credentials — they grant ongoing access
// to a user's Google/Outlook/Notion/Todoist account without re-auth. They
// MUST be encrypted at rest because the SQLite DB is included in the
// weekly backup tarball, and the tarball is unencrypted on disk + may be
// shipped off-site (S3, rsync). A leaked backup must not equal account
// takeover for every connected user. See audit P0-7.
//
// Resolution order:
//   1. OAUTH_ENCRYPTION_KEY (preferred — dedicated key for OAuth tokens)
//   2. config.financeEncryption.masterKey (shared with finance encryption)
//   3. FINANCE_ENCRYPTION_KEY (legacy fallback)
//
// At least one MUST be set or the process refuses to start (enforced in
// `assertOAuthEncryptionConfigured()` called from boot). The empty-string
// fallback that silently stored plaintext has been removed.

function getEncryptionKey(): string {
  return process.env.OAUTH_ENCRYPTION_KEY
    || config.financeEncryption?.masterKey
    || process.env.FINANCE_ENCRYPTION_KEY
    || '';
}

/**
 * Boot-time assertion: refuse to start if no encryption key is configured.
 * Called from src/services/database.ts during initDatabase().
 */
export function assertOAuthEncryptionConfigured(): void {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      'OAUTH_ENCRYPTION_KEY is not configured. OAuth refresh tokens cannot ' +
      'be stored safely without encryption. Set OAUTH_ENCRYPTION_KEY (or ' +
      'FINANCE_ENCRYPTION_KEY) in .env to a high-entropy 32+ character ' +
      'value. Generate one with: openssl rand -hex 32',
    );
  }
}

function encrypt(value: string, userId: number): string {
  const key = getEncryptionKey();
  if (!key) {
    // Should never happen at runtime — assertOAuthEncryptionConfigured runs
    // at boot. This is a defensive last-line check.
    throw new Error('OAuth encryption key missing at write time');
  }
  return encryptValue(value, key, userId);
}

function decrypt(value: string, userId: number): string {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('OAuth encryption key missing at read time');
  }
  try {
    return decryptValue(value, key, userId);
  } catch {
    // Legacy plaintext from before encryption was enforced. We return as-is
    // so existing rows still work, but the boot-time migration
    // (`encryptPlaintextOAuthTokens`) should have already encrypted them.
    return value;
  }
}

// ─── Decrypted-token cache ──────────────────────────────────────────
//
// Caches the DECRYPTED OAuthTokens object per (userId, provider) pair so
// repeated reads within a TTL window don't trigger fresh DB reads +
// decrypt + audit-log writes.
//
// The cache holds plaintext tokens in memory, which is already the case
// while the process is running — every API call holds them in closures
// for the duration of the request. Caching them for a bounded time does
// not expand the attack surface: if an attacker has code execution on
// the Node process, they can read request-scoped plaintext tokens just
// as easily as cached ones. The risk profile is identical.
//
// TTL: 10 minutes. The shortest typical OAuth access token lifetime is
// 1 hour (Google, Outlook), but the refresh token doesn't rotate on
// every refresh — it's stable across days. 10 minutes gives us a strong
// performance win while keeping the window small enough that a credential
// revoked in the portal is respected within ~10 minutes even without
// explicit invalidation. Store + disconnect operations invalidate the
// cache immediately so explicit re-auth is instantly visible.
//
// Max size: 256 entries. With N providers × M users, this supports
// 256/7 ≈ 36 fully-connected users before eviction starts. That's more
// than we'll have for a long while and costs ~100KB of memory.
const DECRYPT_CACHE_TTL_MS = 10 * 60 * 1000;
const DECRYPT_CACHE_SIZE = 256;

interface CachedEntry {
  tokens: OAuthTokens;
  cachedAt: number;
}

const _decryptedTokenCache = new LRUMap<string, CachedEntry>(DECRYPT_CACHE_SIZE);

function cacheKey(userId: number, provider: OAuthProvider): string {
  return `${userId}:${provider}`;
}

function invalidateTokenCache(userId: number, provider: OAuthProvider): void {
  _decryptedTokenCache.delete(cacheKey(userId, provider));
}

function invalidateProviderSurfaceCaches(userId: number, provider: OAuthProvider): void {
  try {
    // Lazy require avoids an oauth-store -> integration invalidator ->
    // planning/context/mail cycle during module initialization.
    const { invalidateIntegrationDerivedCaches } = require('./integration-cache-invalidator');
    invalidateIntegrationDerivedCaches(userId, provider);
  } catch (err) {
    logger.debug({ err, userId, provider }, 'OAuth provider surface cache invalidation failed');
  }
}

/**
 * Test-only: clear the entire decrypted-token cache. Exported so tests
 * can reset state between cases without touching the LRU internals.
 */
export function _resetDecryptCacheForTests(): void {
  _decryptedTokenCache.clear();
}

/**
 * Detect if a stored value looks like an encrypted blob from this module
 * (hex string of length ≥ 56 chars = 28 bytes = IV + tag + at least 0
 * bytes of ciphertext). Real Google/Outlook/Notion refresh tokens contain
 * non-hex characters (`/`, `_`, `.`, `-`) so they fail this test cleanly.
 */
function looksEncrypted(value: string): boolean {
  if (!value) return false;
  if (value.length < 56) return false;
  return /^[0-9a-f]+$/i.test(value);
}

/**
 * One-time migration: encrypts any plaintext rows in user_oauth_tokens
 * using the configured key. Idempotent — already-encrypted rows are left
 * alone. Called from initDatabase() after migrations + key assertion.
 *
 * Returns counts so the caller can log meaningful telemetry.
 */
export function encryptPlaintextOAuthTokens(): {
  scanned: number;
  encryptedRows: number;
  alreadyEncrypted: number;
} {
  const db = getDb();
  const key = getEncryptionKey();
  if (!key) {
    // assertOAuthEncryptionConfigured should have caught this — defensive.
    throw new Error('encryptPlaintextOAuthTokens called without an encryption key');
  }

  const rows = db
    .prepare('SELECT id, user_id, access_token, refresh_token FROM user_oauth_tokens')
    .all() as Array<{
      id: number;
      user_id: number;
      access_token: string;
      refresh_token: string;
    }>;

  let encryptedRows = 0;
  let alreadyEncrypted = 0;

  for (const row of rows) {
    const accessNeedsEncryption = row.access_token !== '' && !looksEncrypted(row.access_token);
    const refreshNeedsEncryption = row.refresh_token !== '' && !looksEncrypted(row.refresh_token);

    if (!accessNeedsEncryption && !refreshNeedsEncryption) {
      alreadyEncrypted++;
      continue;
    }

    const newAccess = accessNeedsEncryption
      ? encryptValue(row.access_token, key, row.user_id)
      : row.access_token;
    const newRefresh = refreshNeedsEncryption
      ? encryptValue(row.refresh_token, key, row.user_id)
      : row.refresh_token;

    db.prepare(
      'UPDATE user_oauth_tokens SET access_token = ?, refresh_token = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ).run(newAccess, newRefresh, row.id);
    encryptedRows++;
  }

  return { scanned: rows.length, encryptedRows, alreadyEncrypted };
}

// ─── Token CRUD ─────────────────────────────────────────────────────

/**
 * Store OAuth tokens for a user+provider. Encrypts before saving.
 */
export function storeTokens(userId: number, provider: OAuthProvider, tokens: OAuthTokens): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, expires_at, scopes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      token_type = excluded.token_type,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes,
      updated_at = datetime('now')
  `).run(
    userId,
    provider,
    encrypt(tokens.accessToken, userId),
    encrypt(tokens.refreshToken, userId),
    tokens.tokenType,
    tokens.expiresAt,
    JSON.stringify(tokens.scopes),
  );
  // Fresh tokens from a new OAuth exchange — blow away any cached copy
  // of the old tokens so the next getTokens() immediately picks up the
  // new ones instead of waiting out the 10-minute TTL.
  invalidateTokenCache(userId, provider);
  notifyOAuthTokenMutation({ userId, provider });
  invalidateProviderSurfaceCaches(userId, provider);
  logger.info({ userId, provider }, 'OAuth tokens stored');
}

/**
 * Retrieve decrypted tokens for a user+provider. Returns null if not connected.
 *
 * Audit P0-10: token decryptions are logged because OAuth refresh tokens
 * grant ongoing access to a user's third-party account (Google/Outlook/...).
 * Knowing when each token was decrypted is the bare minimum forensic trail
 * for "did anything weird access my Google data?".
 *
 * Cache behavior (Phase 0.C — April 2026):
 *   - Hot path: in-memory cache hit → return cached tokens WITHOUT hitting
 *     the DB or writing an audit row. This is the normal case for every
 *     Google/Outlook API call within 10 minutes of the previous read.
 *   - Cold path: cache miss → DB read + decrypt + SINGLE audit row + cache.
 *
 * Before this cache, a single user generated ~11,000 audit rows/day
 * because every Graph API call fired a fresh decrypt. After: ~1 row per
 * 10-minute window per active provider ≈ 144 rows/day worst case. The
 * audit is still complete enough for forensic use — you can tell WHEN
 * the tokens were materialized into memory, which is what matters for
 * "was the refresh token exfiltrated". The in-memory cache does not
 * expand the attack surface: a code-execution attacker could read any
 * request-scoped plaintext token just as easily.
 */
export function getTokens(userId: number, provider: OAuthProvider): OAuthTokens | null {
  // ── Cache hit: return without touching DB or audit trail ──
  const key = cacheKey(userId, provider);
  const cached = _decryptedTokenCache.get(key);
  if (cached && Date.now() - cached.cachedAt < DECRYPT_CACHE_TTL_MS) {
    return cached.tokens;
  }

  // ── Cache miss: DB read + decrypt + ONE audit row + cache ──
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM user_oauth_tokens WHERE user_id = ? AND provider = ?'
  ).get(userId, provider) as any | undefined;

  if (!row) {
    // Expire stale cache entries for non-existent tokens (e.g. disconnected
    // in another process). Doesn't fix cross-process staleness but handles
    // the in-process case.
    _decryptedTokenCache.delete(key);
    return null;
  }

  // Lazy require to avoid a cycle (audit-trail → database → oauth-store).
  // This is the ONE audit row per actual decryption (not per getTokens call).
  try {
    const { logAudit } = require('./audit-trail');
    logAudit({
      userId,
      actorId: userId,
      action: 'decrypt',
      resource: `oauth.${provider}`,
    });
  } catch { /* audit-trail not available — non-critical */ }

  const tokens: OAuthTokens = {
    accessToken: decrypt(row.access_token, userId),
    refreshToken: decrypt(row.refresh_token, userId),
    tokenType: row.token_type,
    expiresAt: row.expires_at,
    scopes: JSON.parse(row.scopes || '[]'),
  };

  _decryptedTokenCache.set(key, { tokens, cachedAt: Date.now() });
  return tokens;
}

/**
 * Check if a user has connected a provider.
 */
export function isConnected(userId: number, provider: OAuthProvider): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM user_oauth_tokens WHERE user_id = ? AND provider = ?'
  ).get(userId, provider);
  return !!row;
}

/**
 * Delete tokens (disconnect a provider).
 */
export function disconnectProvider(userId: number, provider: OAuthProvider): void {
  const db = getDb();
  db.prepare('DELETE FROM user_oauth_tokens WHERE user_id = ? AND provider = ?').run(userId, provider);
  // Blow away the cached decrypted tokens so the next getTokens() returns
  // null immediately instead of serving stale data for up to 10 minutes.
  invalidateTokenCache(userId, provider);
  notifyOAuthTokenMutation({ userId, provider });
  invalidateProviderSurfaceCaches(userId, provider);
  logger.info({ userId, provider }, 'OAuth tokens removed');
}

/**
 * Get all connected providers for a user.
 *
 * `lastReauthedAt` is the latest token-write timestamp (`updated_at`). It
 * advances on every fresh OAuth exchange (and on successful background
 * refreshes). Probe-derived degradation gating uses it as a "since" cutoff
 * so probe failures recorded BEFORE the user's most recent reauth don't
 * keep the provider stuck in `degraded` after they've already recovered
 * the connection — see `probeDerivedState` in `integration-status.ts`.
 */
export function getUserConnections(userId: number): Array<{
  provider: string;
  connectedAt: string;
  lastReauthedAt: string;
  scopes: string[];
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT provider, created_at, updated_at, scopes FROM user_oauth_tokens WHERE user_id = ?'
  ).all(userId) as any[];

  return rows.map(r => ({
    provider: r.provider,
    connectedAt: r.created_at,
    lastReauthedAt: r.updated_at || r.created_at,
    scopes: JSON.parse(r.scopes || '[]'),
  }));
}

/**
 * Update the access token (after refresh). Keeps refresh token unchanged.
 *
 * Invalidates the decrypted-token cache so the next `getTokens()` picks up
 * the new access token immediately instead of serving the stale cached copy
 * for up to 10 minutes. This is the same invariant enforced by `storeTokens()`
 * and `disconnectProvider()`: any mutation of the underlying row must also
 * invalidate the cache, otherwise callers that only re-read via `getTokens()`
 * (e.g. wearable adapters, Gmail/Calendar clients) would keep hitting the
 * expired token and fail with 401s until the TTL expired.
 */
export function updateAccessToken(userId: number, provider: OAuthProvider, accessToken: string, expiresAt: string | null): void {
  const db = getDb();
  db.prepare(`
    UPDATE user_oauth_tokens
    SET access_token = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = ?
  `).run(encrypt(accessToken, userId), expiresAt, userId, provider);
  invalidateTokenCache(userId, provider);
  notifyOAuthTokenMutation({ userId, provider });
}

// ─── Owner Token Migration ──────────────────────────────────────────

/**
 * Migrate owner's tokens from .env to per-user storage on first boot.
 * Idempotent — skips if already migrated.
 */
export function migrateOwnerTokens(): void {
  try {
    const ownerRefs = getOwnerBootstrapUserRefs();
    const primaryOwnerRef = ownerRefs[0];
    if (!primaryOwnerRef) return;

    // Migrate Google tokens
    if (config.google.refreshToken && !ownerRefs.some((ref) => isConnected(ref, 'google'))) {
      storeTokens(primaryOwnerRef, 'google', {
        accessToken: '',
        refreshToken: config.google.refreshToken,
        tokenType: 'Bearer',
        expiresAt: null,
        scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'],
      });
      logger.info('Migrated owner Google tokens from .env to per-user storage');
    }

    // Migrate Outlook tokens
    if (config.outlook.refreshToken && !ownerRefs.some((ref) => isConnected(ref, 'outlook'))) {
      storeTokens(primaryOwnerRef, 'outlook', {
        accessToken: '',
        refreshToken: config.outlook.refreshToken,
        tokenType: 'Bearer',
        expiresAt: null,
        scopes: ['Calendars.ReadWrite', 'Mail.ReadWrite', 'Mail.Send', 'Tasks.ReadWrite', 'User.Read'],
      });
      logger.info('Migrated owner Outlook tokens from .env to per-user storage');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to migrate owner tokens');
  }
}
