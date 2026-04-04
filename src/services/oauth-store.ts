// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * OAuth Token Store — encrypted per-user token storage in SQLite.
 *
 * Tokens are encrypted at rest using AES-256-GCM with per-user key derivation.
 * Uses the existing encryption utilities from src/utils/encryption.ts.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { encryptValue, decryptValue } from '../utils/encryption';

// ─── Types ──────────────────────────────────────────────────────────

export type OAuthProvider = 'google' | 'outlook' | 'strava' | 'whoop' | 'fitbit';

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

function getEncryptionKey(): string {
  const key = process.env.OAUTH_ENCRYPTION_KEY || config.financeEncryption?.masterKey || process.env.FINANCE_ENCRYPTION_KEY || '';
  if (!key) {
    logger.warn('No OAuth encryption key configured — tokens will be stored in plaintext');
  }
  return key;
}

function encrypt(value: string, userId: number): string {
  const key = getEncryptionKey();
  if (!key) return value; // No encryption configured — store plaintext
  return encryptValue(value, key, userId);
}

function decrypt(value: string, userId: number): string {
  const key = getEncryptionKey();
  if (!key) return value;
  try {
    return decryptValue(value, key, userId);
  } catch {
    // May be plaintext from before encryption was configured
    return value;
  }
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
  logger.info({ userId, provider }, 'OAuth tokens stored');
}

/**
 * Retrieve decrypted tokens for a user+provider. Returns null if not connected.
 */
export function getTokens(userId: number, provider: OAuthProvider): OAuthTokens | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM user_oauth_tokens WHERE user_id = ? AND provider = ?'
  ).get(userId, provider) as any | undefined;

  if (!row) return null;

  return {
    accessToken: decrypt(row.access_token, userId),
    refreshToken: decrypt(row.refresh_token, userId),
    tokenType: row.token_type,
    expiresAt: row.expires_at,
    scopes: JSON.parse(row.scopes || '[]'),
  };
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
  logger.info({ userId, provider }, 'OAuth tokens removed');
}

/**
 * Get all connected providers for a user.
 */
export function getUserConnections(userId: number): Array<{
  provider: string;
  connectedAt: string;
  scopes: string[];
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT provider, created_at, scopes FROM user_oauth_tokens WHERE user_id = ?'
  ).all(userId) as any[];

  return rows.map(r => ({
    provider: r.provider,
    connectedAt: r.created_at,
    scopes: JSON.parse(r.scopes || '[]'),
  }));
}

/**
 * Update the access token (after refresh). Keeps refresh token unchanged.
 */
export function updateAccessToken(userId: number, provider: OAuthProvider, accessToken: string, expiresAt: string | null): void {
  const db = getDb();
  db.prepare(`
    UPDATE user_oauth_tokens
    SET access_token = ?, expires_at = ?, updated_at = datetime('now')
    WHERE user_id = ? AND provider = ?
  `).run(encrypt(accessToken, userId), expiresAt, userId, provider);
}

// ─── Owner Token Migration ──────────────────────────────────────────

/**
 * Migrate owner's tokens from .env to per-user storage on first boot.
 * Idempotent — skips if already migrated.
 */
export function migrateOwnerTokens(): void {
  try {
    const ownerTelegramId = parseInt(process.env.OWNER_TELEGRAM_ID || '', 10)
      || config.telegram.allowedUserIds[0];
    if (!ownerTelegramId) return;

    // Migrate Google tokens
    if (config.google.refreshToken && !isConnected(ownerTelegramId, 'google')) {
      storeTokens(ownerTelegramId, 'google', {
        accessToken: '',
        refreshToken: config.google.refreshToken,
        tokenType: 'Bearer',
        expiresAt: null,
        scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/gmail.readonly'],
      });
      logger.info('Migrated owner Google tokens from .env to per-user storage');
    }

    // Migrate Outlook tokens
    if (config.outlook.refreshToken && !isConnected(ownerTelegramId, 'outlook')) {
      storeTokens(ownerTelegramId, 'outlook', {
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
