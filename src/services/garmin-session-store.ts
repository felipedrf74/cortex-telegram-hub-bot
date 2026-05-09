// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import { getCurrentContext } from '../utils/request-context';
import { getOwnerBootstrapUser, getUserById, getUserByTelegramId } from './user-service';
import { createAndPushNotification } from './content-notification-store';
import { invalidateTrainingDerivedCaches } from './cache-coherence-registry';

export interface GarminSessionRecord {
  userId: number;
  oauth1TokenJson: string | null;
  oauth2TokenJson: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
    oauth1TokenJson: row.oauth1_token_json,
    oauth2TokenJson: row.oauth2_token_json,
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

  if (!row?.tokens_json || row.tokens_json === '{}') return null;
  const parsed = parseJson(row.tokens_json) as LegacyTokenBlob | null;
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
    JSON.stringify(tokens.oauth1 ?? null),
    JSON.stringify(tokens.oauth2 ?? null),
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
    VALUES (?, ?, '{}', 'active', datetime('now'), datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      garmin_email = COALESCE(excluded.garmin_email, garmin_user_tokens.garmin_email),
      status = 'active',
      last_refresh = datetime('now'),
      last_used = datetime('now'),
      updated_at = datetime('now')
  `).run(userId, garminEmail ?? null);
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
    VALUES (?, '{}', 'needs_reauth', datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      status = 'needs_reauth',
      updated_at = datetime('now')
  `).run(userId);
  invalidateGarminDerivedCaches(userId);

  try {
    await createAndPushNotification({
      userId,
      type: 'content_action_required',
      title: 'Garmin needs re-authentication',
      body: 'Your Garmin session expired. Reconnect Garmin to restore training data in Nexus Hub.',
      data: {
        kind: 'garmin_reauth_required',
        provider: 'garmin',
        reauthEndpoint: '/api/v1/garmin/reauth',
        reason,
      },
    });
  } catch (err) {
    logger.debug({ err, userId }, 'Garmin re-auth notification creation skipped');
  }
}

export function clearGarminSession(userId: number): void {
  getDb().prepare('DELETE FROM garmin_sessions WHERE user_id = ?').run(userId);
  getDb().prepare('DELETE FROM garmin_user_tokens WHERE user_id = ?').run(userId);
  invalidateGarminDerivedCaches(userId);
}
