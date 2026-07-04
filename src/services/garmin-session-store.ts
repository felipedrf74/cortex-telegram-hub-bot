// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import { createNotificationIntent } from './notification-orchestrator';
import { config } from '../config';
import { decryptValue, encryptValue } from '../utils/encryption';
import { getCurrentContext } from '../utils/request-context';
import { getOwnerBootstrapUser, getUserById, getUserByTelegramId } from './user-service';
import { invalidateTrainingDerivedCaches } from './cache-coherence-registry';

export interface GarminSessionRecord {
  userId: number;
  oauth1TokenJson: string | null;
  oauth2TokenJson: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GarminConnectionRecord {
  garminEmail: string | null;
  status: string | null;
  lastRefresh: string | null;
  lastUsed: string | null;
  updatedAt: string | null;
}

type LegacyTokenBlob = {
  oauth1?: unknown;
  oauth2?: unknown;
};

function parseJson(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getGarminEncryptionKey(): string {
  return process.env.GARMIN_ENCRYPTION_KEY
    || process.env.OAUTH_ENCRYPTION_KEY
    || config.financeEncryption?.masterKey
    || process.env.FINANCE_ENCRYPTION_KEY
    || '';
}

function looksEncrypted(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.length >= 56 && /^[0-9a-f]+$/i.test(value);
}

function encryptGarminValue(value: string | null | undefined, userId: number): string | null {
  if (value == null) return null;
  const key = getGarminEncryptionKey();
  if (!key) return value;
  return encryptValue(value, key, userId);
}

function decryptGarminValue(value: string | null | undefined, userId: number): string | null {
  if (value == null) return null;
  const key = getGarminEncryptionKey();
  if (!key) return value;
  try {
    return decryptValue(value, key, userId);
  } catch {
    return value;
  }
}

export function assertGarminEncryptionConfigured(): void {
  if (process.env.NODE_ENV === 'production' && !getGarminEncryptionKey()) {
    throw new Error(
      'GARMIN_ENCRYPTION_KEY, OAUTH_ENCRYPTION_KEY, or FINANCE_ENCRYPTION_KEY is required in production before Garmin tokens can be stored.',
    );
  }
}

export function getGarminConnectionRecord(userId: number): GarminConnectionRecord | null {
  const row = getDb().prepare(`
    SELECT garmin_email, status, last_refresh, last_used, updated_at
    FROM garmin_user_tokens
    WHERE user_id = ?
  `).get(userId) as {
    garmin_email?: string | null;
    status?: string | null;
    last_refresh?: string | null;
    last_used?: string | null;
    updated_at?: string | null;
  } | undefined;

  if (!row) return null;
  return {
    garminEmail: decryptGarminValue(row.garmin_email, userId),
    status: row.status ?? null,
    lastRefresh: row.last_refresh ?? null,
    lastUsed: row.last_used ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function encryptPlaintextGarminTokens(): {
  scannedSessions: number;
  encryptedSessions: number;
  scannedUserTokens: number;
  encryptedUserTokens: number;
} {
  assertGarminEncryptionConfigured();
  const key = getGarminEncryptionKey();
  if (!key) {
    return {
      scannedSessions: 0,
      encryptedSessions: 0,
      scannedUserTokens: 0,
      encryptedUserTokens: 0,
    };
  }

  const db = getDb();
  let encryptedSessions = 0;
  let encryptedUserTokens = 0;

  const sessionRows = db.prepare(`
    SELECT user_id, oauth1_token_json, oauth2_token_json
    FROM garmin_sessions
  `).all() as Array<{
    user_id: number;
    oauth1_token_json: string | null;
    oauth2_token_json: string | null;
  }>;

  const updateSession = db.prepare(`
    UPDATE garmin_sessions
    SET oauth1_token_json = ?,
        oauth2_token_json = ?,
        updated_at = datetime('now')
    WHERE user_id = ?
  `);

  for (const row of sessionRows) {
    const oauth1 = row.oauth1_token_json && !looksEncrypted(row.oauth1_token_json)
      ? encryptValue(row.oauth1_token_json, key, row.user_id)
      : row.oauth1_token_json;
    const oauth2 = row.oauth2_token_json && !looksEncrypted(row.oauth2_token_json)
      ? encryptValue(row.oauth2_token_json, key, row.user_id)
      : row.oauth2_token_json;
    if (oauth1 !== row.oauth1_token_json || oauth2 !== row.oauth2_token_json) {
      updateSession.run(oauth1, oauth2, row.user_id);
      encryptedSessions++;
    }
  }

  const userTokenRows = db.prepare(`
    SELECT user_id, garmin_email, tokens_json
    FROM garmin_user_tokens
  `).all() as Array<{
    user_id: number;
    garmin_email: string | null;
    tokens_json: string | null;
  }>;

  const updateUserToken = db.prepare(`
    UPDATE garmin_user_tokens
    SET garmin_email = ?,
        tokens_json = ?,
        updated_at = datetime('now')
    WHERE user_id = ?
  `);

  for (const row of userTokenRows) {
    const garminEmail = row.garmin_email && !looksEncrypted(row.garmin_email)
      ? encryptValue(row.garmin_email, key, row.user_id)
      : row.garmin_email;
    const tokensJson = row.tokens_json && !looksEncrypted(row.tokens_json)
      ? encryptValue(row.tokens_json, key, row.user_id)
      : row.tokens_json;
    if (garminEmail !== row.garmin_email || tokensJson !== row.tokens_json) {
      updateUserToken.run(garminEmail, tokensJson, row.user_id);
      encryptedUserTokens++;
    }
  }

  return {
    scannedSessions: sessionRows.length,
    encryptedSessions,
    scannedUserTokens: userTokenRows.length,
    encryptedUserTokens,
  };
}

export function resolveGarminUserId(explicitUserId?: number): number | null {
  const candidate = explicitUserId ?? getCurrentContext()?.userId;
  if (candidate && candidate > 0) {
    const byId = getUserById(candidate);
    if (byId) return byId.id;

    const byTelegram = getUserByTelegramId(candidate);
    if (byTelegram) return byTelegram.id;

    return candidate;
  }

  const owner = getOwnerBootstrapUser();
  return owner?.id ?? null;
}

export function getGarminSession(userId: number): GarminSessionRecord | null {
  const row = getDb().prepare(`
    SELECT user_id, oauth1_token_json, oauth2_token_json, last_refreshed_at, created_at, updated_at
    FROM garmin_sessions
    WHERE user_id = ?
  `).get(userId) as {
    user_id: number;
    oauth1_token_json: string | null;
    oauth2_token_json: string | null;
    last_refreshed_at: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;

  if (!row) return null;

  return {
    userId: row.user_id,
    oauth1TokenJson: decryptGarminValue(row.oauth1_token_json, row.user_id),
    oauth2TokenJson: decryptGarminValue(row.oauth2_token_json, row.user_id),
    lastRefreshedAt: row.last_refreshed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function hasActiveGarminConnection(userId: number): boolean {
  const tokenRow = getDb().prepare(`
    SELECT status
    FROM garmin_user_tokens
    WHERE user_id = ?
  `).get(userId) as { status?: string | null } | undefined;

  if (tokenRow?.status === 'active') {
    return hasGarminSessionMaterial(userId);
  }

  if (tokenRow) {
    return false;
  }

  // The owner account predates the per-user Garmin session tables in some
  // environments. Keep that compatibility only for the canonical owner so a
  // stale/non-owner row cannot make another user look Garmin-connected.
  const owner = getOwnerBootstrapUser();
  return owner?.id === userId && hasGarminSessionMaterial(userId);
}

export function isOwnerGarminUserId(userId: number | null | undefined): boolean {
  if (!userId) return false;
  const owner = getOwnerBootstrapUser();
  return owner?.id === userId;
}

export function getLegacyGarminTokenBlob(userId: number): LegacyTokenBlob | null {
  const row = getDb().prepare(`
    SELECT tokens_json
    FROM garmin_user_tokens
    WHERE user_id = ?
  `).get(userId) as { tokens_json?: string | null } | undefined;

  const decryptedTokensJson = decryptGarminValue(row?.tokens_json, userId);
  if (!decryptedTokensJson || decryptedTokensJson === '{}') return null;
  const parsed = parseJson(decryptedTokensJson) as LegacyTokenBlob | null;
  if (!parsed) return null;
  return {
    oauth1: parsed.oauth1 ?? null,
    oauth2: parsed.oauth2 ?? null,
  };
}

function hasGarminSessionMaterial(userId: number): boolean {
  const session = getGarminSession(userId);
  if (session?.oauth1TokenJson && session.oauth2TokenJson) {
    return true;
  }

  const legacy = getLegacyGarminTokenBlob(userId);
  return Boolean(legacy?.oauth1 && legacy?.oauth2);
}

function invalidateGarminDerivedCaches(userId: number): void {
  invalidateTrainingDerivedCaches(userId);
}

export function upsertGarminSession(
  userId: number,
  tokens: { oauth1: unknown; oauth2: unknown },
  refreshedAt: string = new Date().toISOString(),
): void {
  getDb().prepare(`
    INSERT INTO garmin_sessions (
      user_id, oauth1_token_json, oauth2_token_json, last_refreshed_at, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      oauth1_token_json = excluded.oauth1_token_json,
      oauth2_token_json = excluded.oauth2_token_json,
      last_refreshed_at = excluded.last_refreshed_at,
      updated_at = datetime('now')
  `).run(
    userId,
    encryptGarminValue(JSON.stringify(tokens.oauth1 ?? null), userId),
    encryptGarminValue(JSON.stringify(tokens.oauth2 ?? null), userId),
    refreshedAt,
  );
}

export function migrateLegacyGarminTokensToSession(userId: number): boolean {
  const legacy = getLegacyGarminTokenBlob(userId);
  if (!legacy?.oauth1 || !legacy?.oauth2) return false;
  upsertGarminSession(userId, { oauth1: legacy.oauth1, oauth2: legacy.oauth2 });
  return true;
}

export function markGarminConnectionActive(userId: number, garminEmail?: string | null): void {
  getDb().prepare(`
    INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status, last_refresh, last_used, updated_at)
    VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      garmin_email = COALESCE(excluded.garmin_email, garmin_user_tokens.garmin_email),
      tokens_json = CASE
        WHEN garmin_user_tokens.tokens_json IS NULL OR garmin_user_tokens.tokens_json = '{}' THEN excluded.tokens_json
        ELSE garmin_user_tokens.tokens_json
      END,
      status = 'active',
      last_refresh = datetime('now'),
      last_used = datetime('now'),
      updated_at = datetime('now')
  `).run(
    userId,
    encryptGarminValue(garminEmail ?? null, userId),
    encryptGarminValue('{}', userId),
  );
  invalidateGarminDerivedCaches(userId);
}

export function markGarminConnectionMfaPending(userId: number, garminEmail: string): void {
  getDb().prepare(`
    INSERT INTO garmin_user_tokens (user_id, garmin_email, tokens_json, status)
    VALUES (?, ?, ?, 'mfa_pending')
    ON CONFLICT(user_id) DO UPDATE SET
      garmin_email = excluded.garmin_email,
      tokens_json = excluded.tokens_json,
      status = 'mfa_pending',
      updated_at = datetime('now')
  `).run(
    userId,
    encryptGarminValue(garminEmail, userId),
    encryptGarminValue('{}', userId),
  );
  invalidateGarminDerivedCaches(userId);
}

export function touchGarminConnection(userId: number): void {
  getDb().prepare(`
    UPDATE garmin_user_tokens
    SET last_used = datetime('now'), updated_at = datetime('now')
    WHERE user_id = ?
  `).run(userId);
}

export async function markGarminNeedsReauth(userId: number, reason: string): Promise<void> {
  getDb().prepare(`
    INSERT INTO garmin_user_tokens (user_id, tokens_json, status, updated_at)
    VALUES (?, ?, 'needs_reauth', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      status = 'needs_reauth',
      updated_at = datetime('now')
  `).run(userId, encryptGarminValue('{}', userId));
  invalidateGarminDerivedCaches(userId);

  // 2026-07-04 legacy-store retirement: Garmin reauth was the LAST writer of
  // the legacy content_notifications table (via the bridge). It now emits a
  // first-class orchestrator intent — entity-stable dedupe means repeated
  // session expiries collapse into one active item instead of re-pushing.
  try {
    await createNotificationIntent({
      userId,
      tenantId: userId,
      sourceSkill: 'training',
      type: 'sync_failure',
      priority: 'active',
      relatedEntityId: `garmin_reauth:${userId}`,
      relatedEntityType: 'garmin_session',
      title: 'Garmin needs re-authentication',
      body: 'Your Garmin session expired. Reconnect Garmin to restore training data in Nexus Hub.',
      actionButtons: [{ id: 'open_detail', label: 'Reconnect', style: 'primary' }],
      // Must be an allowlisted deeplink host (isSupportedNotificationDeeplink):
      // 'settings' is rejected and would silently downgrade to the inbox
      // fallback. 'connections/garmin/reauth' is the route iOS ships and the
      // same one garmin-mfa-notifier already uses.
      deeplink: 'nexus://connections/garmin/reauth',
      dedupeKey: `training:garmin_reauth:${userId}`,
      privacyPolicy: 'standard',
    });
  } catch (err) {
    logger.debug({ err, userId, reason }, 'Garmin re-auth notification creation skipped');
  }
}

export function clearGarminSession(userId: number): void {
  getDb().prepare('DELETE FROM garmin_sessions WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM garmin_user_tokens WHERE user_id = ?').run(userId);
  invalidateGarminDerivedCaches(userId);
}
