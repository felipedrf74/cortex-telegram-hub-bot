// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * User Service — registration, invite codes, and access control.
 *
 * Manages the users table: creation via invite codes, tier-based limits,
 * owner auto-seeding, and status management.
 */

import { getDb } from './database';
import { config } from '../config';
import { logger } from '../utils/logger';
import crypto from 'crypto';
import type { Lang } from '../utils/i18n';

// ─── Types ──────────────────────────────────────────────────────────

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language: Lang;
  timezone: string;
  tier: 'free' | 'pro' | 'owner';
  status: 'active' | 'suspended' | 'banned';
  invite_code: string | null;
  daily_message_limit: number;
  daily_token_limit: number;
  daily_cost_limit_usd: number;
  created_at: string;
  last_active_at: string | null;
}

export interface InviteCode {
  code: string;
  created_by: number | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

// ─── User CRUD ──────────────────────────────────────────────────────

export function getUserByTelegramId(telegramId: number): User | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | undefined;
  return row ?? null;
}

export function getOrCreateUser(telegramId: number, profile: {
  username?: string;
  firstName?: string;
  lastName?: string;
  inviteCode?: string;
}): User {
  const existing = getUserByTelegramId(telegramId);
  if (existing) return existing;

  // Phase 1 default: new users start on 'pro' with full skill access.
  // Admin (owner) can manually downgrade via the portal Skills tab.
  // The SQL column default on users.tier is still 'free' as a safe
  // fallback — we explicitly INSERT the tier column here to override it.
  const db = getDb();
  db.prepare(`
    INSERT INTO users (
      telegram_id, username, first_name, last_name, invite_code,
      tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd
    )
    VALUES (?, ?, ?, ?, ?, 'pro', 200, 500000, 5.0)
  `).run(
    telegramId,
    profile.username || null,
    profile.firstName || null,
    profile.lastName || null,
    profile.inviteCode || null,
  );

  logger.info(
    { telegramId, username: profile.username, inviteCode: profile.inviteCode, tier: 'pro' },
    'New user registered',
  );
  return getUserByTelegramId(telegramId)!;
}

export function isUserAuthorized(telegramId: number): boolean {
  const user = getUserByTelegramId(telegramId);
  return !!user && user.status === 'active';
}

export function isOwner(telegramId: number): boolean {
  const user = getUserByTelegramId(telegramId);
  return !!user && user.tier === 'owner';
}

export function touchUser(telegramId: number): void {
  try {
    const db = getDb();
    db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE telegram_id = ?").run(telegramId);
  } catch { /* non-critical */ }
}

export function getUserLanguage(telegramId: number): Lang {
  const user = getUserByTelegramId(telegramId);
  return (user?.language as Lang) || 'pt-BR';
}

export function setUserLanguage(telegramId: number, language: Lang): void {
  const db = getDb();
  db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?').run(language, telegramId);
}

export function listUsers(): User[] {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as User[];
}

export function setUserStatus(telegramId: number, status: 'active' | 'suspended' | 'banned'): void {
  const db = getDb();
  db.prepare('UPDATE users SET status = ? WHERE telegram_id = ?').run(status, telegramId);
  logger.info({ telegramId, status }, 'User status updated');
}

export function setUserTier(telegramId: number, tier: 'free' | 'pro' | 'owner'): void {
  const db = getDb();
  const limits = tier === 'owner'
    ? { messages: 0, tokens: 0, cost: 0 }
    : tier === 'pro'
    ? { messages: 200, tokens: 500000, cost: 5.0 }
    : { messages: 40, tokens: 100000, cost: 0 };

  db.prepare(`
    UPDATE users SET tier = ?, daily_message_limit = ?, daily_token_limit = ?, daily_cost_limit_usd = ?
    WHERE telegram_id = ?
  `).run(tier, limits.messages, limits.tokens, limits.cost, telegramId);
  logger.info({ telegramId, tier }, 'User tier updated');
}

export function setUserLimits(telegramId: number, limits: {
  daily_message_limit?: number;
  daily_token_limit?: number;
  daily_cost_limit_usd?: number;
}): void {
  const db = getDb();
  const user = getUserByTelegramId(telegramId);
  if (!user) return;

  db.prepare(`
    UPDATE users SET daily_message_limit = ?, daily_token_limit = ?, daily_cost_limit_usd = ?
    WHERE telegram_id = ?
  `).run(
    limits.daily_message_limit ?? user.daily_message_limit,
    limits.daily_token_limit ?? user.daily_token_limit,
    limits.daily_cost_limit_usd ?? user.daily_cost_limit_usd,
    telegramId
  );
}

// ─── Invite Codes ───────────────────────────────────────────────────

export function createInviteCode(createdBy: number, maxUses = 1, expiresInDays?: number): string {
  const db = getDb();
  const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char hex
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;

  db.prepare(`
    INSERT INTO invite_codes (code, created_by, max_uses, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(code, createdBy, maxUses, expiresAt);

  logger.info({ code, createdBy, maxUses, expiresAt }, 'Invite code created');
  return code;
}

export function validateAndConsumeInviteCode(code: string): { valid: boolean; skillPreset?: Record<string, boolean> } {
  const db = getDb();

  const result = db.prepare(`
    UPDATE invite_codes
    SET used_count = used_count + 1
    WHERE code = ?
      AND used_count < max_uses
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).run(code);

  if (result.changes === 0) return { valid: false };

  // Get the skill_preset from the consumed code
  const invite = db.prepare('SELECT skill_preset FROM invite_codes WHERE code = ?').get(code) as any;
  let skillPreset: Record<string, boolean> | undefined;
  if (invite?.skill_preset) {
    try { skillPreset = JSON.parse(invite.skill_preset); } catch { /* ignore */ }
  }

  return { valid: true, skillPreset };
}

export function listInviteCodes(): InviteCode[] {
  const db = getDb();
  return db.prepare('SELECT * FROM invite_codes ORDER BY created_at DESC').all() as InviteCode[];
}

export function deleteInviteCode(code: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
  return result.changes > 0;
}

// ─── Owner Seeding ──────────────────────────────────────────────────

/**
 * Auto-create the owner user from TELEGRAM_ALLOWED_USER_IDS[0] or OWNER_TELEGRAM_ID.
 * Call once at startup. Safe to call multiple times (idempotent).
 */
export function seedOwnerUser(): void {
  try {
    const db = getDb();

    // Ensure users table exists (in case migration hasn't run yet)
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL UNIQUE,
        username TEXT, first_name TEXT, last_name TEXT,
        language TEXT NOT NULL DEFAULT 'pt-BR',
        timezone TEXT NOT NULL DEFAULT 'Europe/Lisbon',
        tier TEXT NOT NULL DEFAULT 'free',
        status TEXT NOT NULL DEFAULT 'active',
        invite_code TEXT,
        daily_message_limit INTEGER NOT NULL DEFAULT 40,
        daily_token_limit INTEGER NOT NULL DEFAULT 100000,
        daily_cost_limit_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT
      )
    `);

    const ownerTelegramId = parseInt(process.env.OWNER_TELEGRAM_ID || '', 10)
      || config.telegram.allowedUserIds[0];

    if (!ownerTelegramId) {
      logger.warn('No owner Telegram ID found — skipping owner seed');
      return;
    }

    const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(ownerTelegramId);
    if (existing) return; // Already seeded

    db.prepare(`
      INSERT INTO users (telegram_id, first_name, language, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (?, 'Owner', 'pt-BR', 'owner', 'active', 0, 0, 0)
    `).run(ownerTelegramId);

    logger.info({ telegramId: ownerTelegramId }, 'Owner user seeded');
  } catch (err) {
    logger.warn({ err }, 'Failed to seed owner user');
  }
}
