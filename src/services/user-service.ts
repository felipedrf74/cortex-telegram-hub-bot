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
import { hashEmail } from '../utils/identity';
import { getStoredDailyCostLimitUsdForTier } from './plan-quotas';

// ─── Types ──────────────────────────────────────────────────────────

export interface User {
  id: number;
  telegram_id: number | null;
  email: string | null;
  password_hash: string | null;
  apple_user_id: string | null;
  google_user_id: string | null;
  email_verified: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  language: Lang;
  timezone: string;
  tier: 'free' | 'pro' | 'max' | 'owner';
  status: 'active' | 'suspended' | 'banned';
  auth_provider: 'telegram' | 'apple' | 'google' | 'email';
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

export interface UserTarget {
  tenantId: number;
  telegramId: number | null;
}

export type IosInviteResolution =
  | { kind: 'owner'; user: User }
  | { kind: 'sandbox'; user: User; inviteExpiresAt?: string | null }
  | { kind: 'owner_unavailable' }
  | { kind: 'invalid' };

export type ClosedBetaInviteStatus = 'valid' | 'missing' | 'invalid';

export class ClosedBetaInviteRequiredError extends Error {
  readonly code: 'INVITE_REQUIRED' | 'INVALID_INVITE';

  constructor(code: 'INVITE_REQUIRED' | 'INVALID_INVITE') {
    super(code === 'INVITE_REQUIRED' ? 'Invite code is required' : 'Invalid invite code');
    this.name = 'ClosedBetaInviteRequiredError';
    this.code = code;
  }
}

export function getClosedBetaInviteStatus(inviteCode: unknown): ClosedBetaInviteStatus {
  const rawCode = String(inviteCode ?? '').trim();
  const normalized = rawCode.toLowerCase();
  if (!normalized) return 'missing';

  const validCodes = [
    (config as any).ios?.inviteCode,
    (config as any).ios?.ownerCode,
  ]
    .map((code) => String(code ?? '').trim().toLowerCase())
    .filter(Boolean);

  if (validCodes.includes(normalized)) return 'valid';
  try {
    return peekInviteCode(rawCode).valid ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function assertClosedBetaInviteForNewUser(inviteCode: unknown): void {
  const status = getClosedBetaInviteStatus(inviteCode);
  if (status === 'valid') return;
  throw new ClosedBetaInviteRequiredError(status === 'missing' ? 'INVITE_REQUIRED' : 'INVALID_INVITE');
}

export function assertOptionalInviteForNewUser(inviteCode: unknown): void {
  const status = getClosedBetaInviteStatus(inviteCode);
  if (status === 'missing' || status === 'valid') return;
  throw new ClosedBetaInviteRequiredError('INVALID_INVITE');
}

export function resolveCurrentTenantIdForUser(userId: number): number {
  // Current production model is one canonical tenant per iOS user.
  // Keep this centralized so future tenant-enrollment tables can replace
  // the implementation without each delivery surface inferring userId.
  return userId;
}

// ─── User CRUD ──────────────────────────────────────────────────────

export function getUserByTelegramId(telegramId: number): User | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) as User | undefined;
  return row ?? null;
}

function getPersistedOwnerBootstrapTelegramId(): number | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT telegram_id
      FROM users
      WHERE tier = 'owner' AND telegram_id IS NOT NULL
      ORDER BY id ASC
      LIMIT 1
    `).get() as { telegram_id: number | null } | undefined;
    return row?.telegram_id ?? null;
  } catch {
    return null;
  }
}

function getConfiguredOwnerBootstrapTelegramId(): number | null {
  const envOwnerTelegramId = parseInt(process.env.OWNER_TELEGRAM_ID || '', 10);
  return Number.isFinite(envOwnerTelegramId) && envOwnerTelegramId > 0
    ? envOwnerTelegramId
    : null;
}

export function getOwnerBootstrapTelegramId(): number | null {
  const envOwnerTelegramId = getConfiguredOwnerBootstrapTelegramId();
  if (envOwnerTelegramId) {
    return envOwnerTelegramId;
  }
  const persistedOwnerTelegramId = getPersistedOwnerBootstrapTelegramId();
  if (persistedOwnerTelegramId) {
    return persistedOwnerTelegramId;
  }
  return null;
}

function isStrictOwnerBootstrapRuntime(): boolean {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return false;
  }
  return process.env.NODE_ENV === 'production' && !config.isStaging;
}

export function assertOwnerBootstrapReadyForRuntime(): void {
  const configuredOwnerTelegramId = getConfiguredOwnerBootstrapTelegramId();
  const persistedOwnerTelegramId = getPersistedOwnerBootstrapTelegramId();

  if (
    configuredOwnerTelegramId
    && persistedOwnerTelegramId
    && configuredOwnerTelegramId !== persistedOwnerTelegramId
  ) {
    const err = new Error(
      `Owner bootstrap mismatch: OWNER_TELEGRAM_ID=${configuredOwnerTelegramId} but persisted owner telegram_id=${persistedOwnerTelegramId}. Align bootstrap configuration before starting Nexus Hub.`,
    );
    if (isStrictOwnerBootstrapRuntime()) {
      throw err;
    }
    logger.warn(
      {
        configuredOwnerTelegramId,
        persistedOwnerTelegramId,
      },
      err.message,
    );
    return;
  }

  if (configuredOwnerTelegramId || persistedOwnerTelegramId) {
    return;
  }

  const err = new Error(
    'Owner bootstrap unavailable. Set OWNER_TELEGRAM_ID or persist an owner-tier user row before starting Nexus Hub.',
  );
  if (isStrictOwnerBootstrapRuntime()) {
    throw err;
  }
  logger.warn(err.message);
}

/**
 * Narrow Telegram-era bootstrap bypass to the single configured owner
 * bootstrap identity. This is intentionally stricter than isOwnerUserRef():
 * it is for pre-registration / pre-database ingress only, not for generic
 * owner-tier checks once a user record already exists.
 */
export function isOwnerBootstrapTelegramId(telegramId: number): boolean {
  const ownerTelegramId = getOwnerBootstrapTelegramId();
  return ownerTelegramId != null && telegramId === ownerTelegramId;
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
    VALUES (?, ?, ?, ?, ?, 'pro', 200, 500000, ?)
  `).run(
    telegramId,
    profile.username || null,
    profile.firstName || null,
    profile.lastName || null,
    profile.inviteCode || null,
    getStoredDailyCostLimitUsdForTier('pro'),
  );

  logger.info(
    { telegramId, username: profile.username, inviteCode: profile.inviteCode, tier: 'pro' },
    'New user registered',
  );
  return getUserByTelegramId(telegramId)!;
}

// ─── Multi-auth user lookups ────────────────────────────────────────

export function getUserById(id: number): User | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User) ?? null;
}

function getUserByAnyIdentifier(userRef: number): User | null {
  // Identity-safety (May 2026 audit): resolve users.id FIRST, then fall back
  // to telegram_id. iOS API requests carry the canonical users.id in JWTs;
  // resolving users.id first means an iOS-derived id can never accidentally
  // match a foreign user's telegram_id (defense-in-depth against the
  // documented id-collision surface). Telegram traffic carries large numeric
  // telegram_id values that won't collide with the small autoincrement
  // users.id range, so this reorder is safe for legacy Telegram callers too.
  // New callers that know their input shape should prefer the strict
  // getUserById / getUserByTelegramId / *ById helpers instead of this
  // dual-lookup helper.
  return getUserById(userRef) ?? getUserByTelegramId(userRef);
}

/**
 * Resolve any known user reference to the canonical users.id tenant key.
 * Accepts either users.id or telegram_id and always returns users.id.
 */
export function resolveCanonicalUserId(userRef: number): number | null {
  const user = getUserByAnyIdentifier(userRef);
  return user?.id ?? null;
}

export function getOwnerBootstrapUser(): User | null {
  const ownerTelegramId = getOwnerBootstrapTelegramId();
  if (!ownerTelegramId) return null;
  seedOwnerUser();
  return getUserByTelegramId(ownerTelegramId);
}

/**
 * Resolve the canonical owner bootstrap target used by legacy admin and cron
 * bridges. This keeps fallback behavior explicit: one owner bootstrap user,
 * not an open-ended fanout over every allowed Telegram id in config.
 */
export function getOwnerBootstrapTarget(): UserTarget | null {
  const owner = getOwnerBootstrapUser();
  if (owner?.id && owner.telegram_id) {
    return {
      tenantId: owner.id,
      telegramId: owner.telegram_id,
    };
  }

  const ownerTelegramId = owner?.telegram_id ?? getOwnerBootstrapTelegramId();
  if (!ownerTelegramId) return null;

  const tenantId = resolveCanonicalUserId(ownerTelegramId);
  if (!tenantId) return null;

  return {
    tenantId,
    telegramId: ownerTelegramId,
  };
}

export function getActiveUserTargets(): UserTarget[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, telegram_id FROM users WHERE status = 'active' ORDER BY id ASC",
    ).all() as { id: number; telegram_id: number | null }[];
    if (rows.length > 0) {
      return rows.map((row) => ({
        tenantId: row.id,
        telegramId: row.telegram_id ?? null,
      }));
    }
  } catch (err) {
    logger.warn({ err }, 'Active user target query failed; falling back to owner bootstrap target');
  }

  const ownerTarget = getOwnerBootstrapTarget();
  return ownerTarget ? [ownerTarget] : [];
}

/**
 * Owner bootstrap references in priority order.
 *
 * During the legacy Telegram era, some owner-bound records were keyed by the
 * raw Telegram id. Newer app-facing code should prefer the canonical users.id.
 * Returning both lets legacy owner bridges read old rows while new boot-time
 * migrations can converge on the canonical tenant key.
 */
export function getOwnerBootstrapUserRefs(): number[] {
  const refs: number[] = [];
  const owner = getOwnerBootstrapUser();
  if (owner?.id && !refs.includes(owner.id)) {
    refs.push(owner.id);
  }

  const ownerTelegramId = owner?.telegram_id ?? getOwnerBootstrapTelegramId();
  if (ownerTelegramId && !refs.includes(ownerTelegramId)) {
    refs.push(ownerTelegramId);
  }

  return refs;
}

export function getOrCreateInviteSandboxUser(deviceId: string): User {
  const db = getDb();
  const existingDevice = db.prepare(
    'SELECT user_id FROM ios_devices WHERE device_id = ?',
  ).get(deviceId) as { user_id: number } | undefined;

  if (existingDevice) {
    const existingUser = getUserById(existingDevice.user_id);
    if (existingUser) return existingUser;
  }

  const result = db.prepare(
    "INSERT INTO users (first_name, auth_provider, status) VALUES (?, 'invite_code', 'active')",
  ).run(`Beta-${deviceId.slice(0, 8)}`);
  const userId = result.lastInsertRowid as number;
  logger.info({ userId, deviceId: deviceId.slice(0, 8) }, 'Created sandbox user for beta tester');
  return getUserById(userId)!;
}

export function resolveIosInviteRegistrationTarget(inviteCode: string, deviceId: string): IosInviteResolution {
  const rawInviteCode = String(inviteCode).trim();
  const normalizedInviteCode = rawInviteCode.toLowerCase();
  const ownerCode = ((config as any).ios?.ownerCode || '').trim().toLowerCase();
  const betaCode = ((config as any).ios?.inviteCode || '').trim().toLowerCase();

  if (ownerCode && normalizedInviteCode === ownerCode) {
    const user = getOwnerBootstrapUser();
    return user ? { kind: 'owner', user } : { kind: 'owner_unavailable' };
  }

  if (betaCode && normalizedInviteCode === betaCode) {
    const days = (config as any).ios?.staticInviteExpiresDays ?? 365;
    return {
      kind: 'sandbox',
      user: getOrCreateInviteSandboxUser(deviceId),
      inviteExpiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    };
  }

  const consumed = validateAndConsumeInviteCode(rawInviteCode);
  if (consumed.valid) {
    return {
      kind: 'sandbox',
      user: getOrCreateInviteSandboxUser(deviceId),
      inviteExpiresAt: consumed.expiresAt ?? null,
    };
  }

  return { kind: 'invalid' };
}

export function isOwnerUserRef(userRef: number): boolean {
  const user = getUserByAnyIdentifier(userRef);
  if (user?.tier === 'owner') return true;

  const ownerTelegramId = getOwnerBootstrapTelegramId();
  if (!ownerTelegramId) return false;
  if (userRef === ownerTelegramId) return true;
  return user?.telegram_id === ownerTelegramId;
}

export function sanitizeDisplayName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return '';

  const normalized = trimmed.replace(/_/g, '-');
  const lower = normalized.toLowerCase();
  const letters = Array.from(trimmed).filter((char) => /\p{L}/u.test(char)).length;
  if (letters === 0) return '';

  if (['beta-', 'user-', 'guest-', 'device-', 'test-'].some((prefix) => lower.startsWith(prefix))) {
    return '';
  }

  const parts = normalized.split('-');
  if (parts.length === 2) {
    const suffix = parts[1] ?? '';
    if (suffix.length >= 6 && /^[0-9a-f]+$/i.test(suffix)) {
      return '';
    }
  }

  const digitCount = Array.from(normalized).filter((char) => /\d/.test(char)).length;
  if (normalized.length >= 16 && digitCount >= 6 && normalized.includes('-')) {
    return '';
  }

  return trimmed;
}

export function getPreferredDisplayName(userRef: number): string {
  const user = getUserByAnyIdentifier(userRef);
  return getPreferredDisplayNameFromUser(user);
}

/**
 * Strict by-id resolver for the user's preferred display name. Use this
 * from any iOS API route or other path where the input is the canonical
 * users.id from authentication — it bypasses the Telegram-id-first lookup
 * in getUserByAnyIdentifier and removes the cross-user collision risk
 * surface flagged in the May 2026 identity audit.
 */
export function getPreferredDisplayNameById(userId: number): string {
  const user = getUserById(userId);
  return getPreferredDisplayNameFromUser(user);
}

function getPreferredDisplayNameFromUser(user: User | null): string {
  if (!user) return '';
  return (
    sanitizeDisplayName(user.first_name)
    || sanitizeDisplayName(user.username)
    || ''
  );
}

export function getUserByAppleId(appleUserId: string): User | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM users WHERE apple_user_id = ?').get(appleUserId) as User) ?? null;
}

export function getUserByGoogleId(googleUserId: string): User | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM users WHERE google_user_id = ?').get(googleUserId) as User) ?? null;
}

export function getUserByEmail(email: string): User | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as User) ?? null;
}

export function createAppleUser(appleUserId: string, profile: {
  email?: string; firstName?: string; lastName?: string;
}, inviteCode?: unknown): User {
  assertOptionalInviteForNewUser(inviteCode);
  const db = getDb();
  // Hardening 2026-04-21: new users default to `tier='free'` per
  // the business rule (users are privileged only if they have an
  // active Apple sub, Stripe sub, or portal-assigned founder
  // status). Prior code hardcoded 'pro' which meant every new
  // registrant implicitly got Pro quotas regardless of payment.
  // Invite-code flows (grantBetaSandboxAccess) + receipt verify
  // + founder sync all upgrade afterward.
  db.prepare(`
    INSERT INTO users (apple_user_id, email, first_name, last_name, email_verified,
      auth_provider, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, ?, ?, 1, 'apple', 'free', 40, 100000, ?)
  `).run(
    appleUserId,
    profile.email?.toLowerCase() || null,
    profile.firstName || null,
    profile.lastName || null,
    getStoredDailyCostLimitUsdForTier('free'),
  );
  const user = getUserByAppleId(appleUserId)!;
  logger.info({ appleUserId, emailHash: profile.email ? hashEmail(profile.email, 16) : null }, 'New Apple user registered');
  // AUTH-O6 (closed-beta-auth-hardening, 2026-05-04): emit auth.user_created
  // audit row so operators can dashboard registration volume + provider mix.
  emitUserCreatedAudit(user.id, 'apple', { appleUserId, emailHash: profile.email ? hashEmail(profile.email, 16) : null });
  return user;
}

export function createGoogleUser(googleUserId: string, profile: {
  email: string; name?: string; picture?: string;
}, inviteCode?: unknown): User {
  assertOptionalInviteForNewUser(inviteCode);
  const db = getDb();
  const [firstName, ...rest] = (profile.name || '').split(' ');
  // Hardening 2026-04-21: default tier='free' — see createAppleUser
  // note for the full rationale. Downstream flows (founder match by
  // email, invite-code beta sandbox, Stripe checkout) upgrade.
  db.prepare(`
    INSERT INTO users (google_user_id, email, first_name, last_name, avatar_url, email_verified,
      auth_provider, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, ?, ?, ?, 1, 'google', 'free', 40, 100000, ?)
  `).run(
    googleUserId,
    profile.email.toLowerCase(),
    firstName || null,
    rest.join(' ') || null,
    profile.picture || null,
    getStoredDailyCostLimitUsdForTier('free'),
  );
  const user = getUserByGoogleId(googleUserId)!;
  logger.info({ googleUserId, emailHash: hashEmail(profile.email, 16) }, 'New Google user registered');
  emitUserCreatedAudit(user.id, 'google', { googleUserId, emailHash: hashEmail(profile.email, 16) });
  return user;
}

export function createEmailUser(email: string, passwordHash: string, profile: {
  firstName: string;
}): User {
  const db = getDb();
  // Hardening 2026-04-21: default tier='free' — see createAppleUser
  // note for rationale. Email registrants start Free; upgrade paths
  // (Stripe checkout, invite-code beta, founder email sync) handle
  // privileged grants explicitly.
  db.prepare(`
    INSERT INTO users (email, password_hash, first_name, email_verified,
      auth_provider, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, ?, 0, 'email', 'free', 40, 100000, ?)
  `).run(email.toLowerCase(), passwordHash, profile.firstName, getStoredDailyCostLimitUsdForTier('free'));
  const user = getUserByEmail(email)!;
  logger.info({ emailHash: hashEmail(email, 16) }, 'New email user registered');
  emitUserCreatedAudit(user.id, 'email', { emailHash: hashEmail(email, 16) });
  return user;
}

// AUTH-O6 (closed-beta-auth-hardening, 2026-05-04): canonical helper for
// emitting `auth.user_created` audit rows. Keeps the event shape stable
// across the four creation paths (Apple, Google, email, invite). Audit
// emission failures must never block user creation — the user row is
// already committed at this point.
function emitUserCreatedAudit(
  userId: number,
  provider: 'apple' | 'google' | 'email' | 'invite',
  details: Record<string, unknown> = {},
): void {
  try {
    // Lazy require to avoid an import cycle (audit-trail → database →
    // user-service in some call paths).
    const { logAudit } = require('./audit-trail');
    logAudit({
      userId,
      tenantId: userId,
      actorId: userId,
      action: 'access',
      resource: 'auth.user_created',
      details: { provider, ...details },
    });
  } catch (err: any) {
    logger.warn({ err, userId, provider, event: 'auth.user_created.audit_failed' },
      'Failed to emit auth.user_created audit row');
  }
}

// AUTH-O6: emit on provider-link branches. Used by google-sign-in.ts when
// it merges a Google sub into an existing email-matched user, by future
// Apple-link branches, etc.
export function emitProviderLinkedAudit(
  userId: number,
  provider: 'apple' | 'google' | 'telegram',
  details: Record<string, unknown> = {},
): void {
  try {
    const { logAudit } = require('./audit-trail');
    logAudit({
      userId,
      tenantId: userId,
      actorId: userId,
      action: 'access',
      resource: 'auth.provider_linked',
      details: { provider, ...details },
    });
  } catch (err: any) {
    logger.warn({ err, userId, provider, event: 'auth.provider_linked.audit_failed' },
      'Failed to emit auth.provider_linked audit row');
  }
}

export function isUserAuthorized(telegramId: number): boolean {
  const user = getUserByTelegramId(telegramId);
  return !!user && user.status === 'active';
}

export function isOwner(telegramId: number): boolean {
  return isOwnerUserRef(telegramId);
}

export function touchUser(telegramId: number): void {
  try {
    const db = getDb();
    db.prepare("UPDATE users SET last_active_at = datetime('now') WHERE telegram_id = ?").run(telegramId);
  } catch { /* non-critical */ }
}

export function getUserLanguage(userRef: number): Lang {
  const user = getUserByAnyIdentifier(userRef);
  return (user?.language as Lang) || 'pt-BR';
}

/**
 * Strict by-id resolver for the user's saved language preference. Use
 * this from any iOS API route or other path where the input is the
 * canonical users.id from authentication — it bypasses the Telegram-id-
 * first lookup in getUserByAnyIdentifier and removes the cross-user
 * collision risk surface flagged in the May 2026 identity audit.
 */
export function getUserLanguageById(userId: number): Lang {
  const user = getUserById(userId);
  return (user?.language as Lang) || 'pt-BR';
}

export function getUserTimezone(userRef: number | null | undefined): string {
  const fallback = config.app.timezone || 'Europe/Lisbon';
  if (typeof userRef !== 'number' || !Number.isFinite(userRef) || userRef <= 0) {
    return fallback;
  }

  const candidate = getUserByAnyIdentifier(userRef)?.timezone || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    logger.warn({ userRef, timezone: candidate }, 'Invalid user timezone; falling back to app timezone');
    return fallback;
  }
}

/**
 * Strict by-id resolver for the user's timezone. Use this from any iOS API
 * route or other path where the input is the canonical users.id from
 * authentication — it bypasses the Telegram-id-first lookup in
 * getUserByAnyIdentifier and removes the cross-user collision risk
 * surface flagged in the May 2026 identity audit.
 */
export function getUserTimezoneById(userId: number | null | undefined): string {
  const fallback = config.app.timezone || 'Europe/Lisbon';
  if (typeof userId !== 'number' || !Number.isFinite(userId) || userId <= 0) {
    return fallback;
  }
  const candidate = getUserById(userId)?.timezone || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    logger.warn({ userId, timezone: candidate }, 'Invalid user timezone; falling back to app timezone');
    return fallback;
  }
}

export function setUserLanguage(userRef: number, language: Lang): void {
  const db = getDb();
  db.prepare('UPDATE users SET language = ? WHERE telegram_id = ? OR id = ?').run(language, userRef, userRef);
}

/** List users with safe fields only — never exposes password_hash, external IDs, or tokens. */
export function listUsers(): Partial<User>[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, telegram_id, username, first_name, last_name, email,
           language, status, auth_provider, email_verified, created_at,
           tier, daily_message_limit, last_active_at
    FROM users ORDER BY created_at DESC
  `).all() as Partial<User>[];
}

/** List users with ALL fields (super-admin only, never exposed via API). */
export function listUsersInternal(): User[] {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as User[];
}

export function setUserStatus(telegramId: number, status: 'active' | 'suspended' | 'banned'): void {
  const db = getDb();
  db.prepare('UPDATE users SET status = ? WHERE telegram_id = ?').run(status, telegramId);
  logger.info({ telegramId, status }, 'User status updated');
}

/** Set user status by users.id (canonical). */
export function setUserStatusById(userId: number, status: 'active' | 'suspended' | 'banned'): void {
  const db = getDb();
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  logger.info({ userId, status }, 'User status updated (by id)');
}

export function setUserTier(telegramId: number, tier: 'free' | 'pro' | 'max' | 'owner'): void {
  const db = getDb();
  const limits = tier === 'owner'
    ? { messages: 0, tokens: 0, cost: 0 }
    : tier === 'max'
    ? { messages: 200, tokens: 500000, cost: getStoredDailyCostLimitUsdForTier('max') }
    : tier === 'pro'
    ? { messages: 200, tokens: 500000, cost: getStoredDailyCostLimitUsdForTier('pro') }
    : { messages: 40, tokens: 100000, cost: getStoredDailyCostLimitUsdForTier('free') };

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
  const code = crypto.randomBytes(16).toString('base64url');
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;

  db.prepare(`
    INSERT INTO invite_codes (code, created_by, max_uses, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(code, createdBy, maxUses, expiresAt);

  logger.info({ codeSuffix: code.slice(-4), createdBy, maxUses, expiresAt }, 'Invite code created');
  return code;
}

export function peekInviteCode(code: string): {
  valid: boolean;
  expiresAt?: string | null;
  skillPreset?: Record<string, boolean>;
} {
  const trimmed = String(code ?? '').trim();
  if (!trimmed) return { valid: false };
  const db = getDb();
  const invite = db.prepare(`
    SELECT skill_preset, expires_at
    FROM invite_codes
    WHERE code = ?
      AND used_count < max_uses
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(trimmed) as any;
  if (!invite) return { valid: false };

  let skillPreset: Record<string, boolean> | undefined;
  if (invite.skill_preset) {
    try { skillPreset = JSON.parse(invite.skill_preset); } catch { /* ignore */ }
  }

  const result: { valid: true; expiresAt?: string | null; skillPreset?: Record<string, boolean> } = { valid: true };
  if (invite.expires_at) result.expiresAt = invite.expires_at;
  if (skillPreset) result.skillPreset = skillPreset;
  return result;
}

export function validateAndConsumeInviteCode(code: string): {
  valid: boolean;
  expiresAt?: string | null;
  skillPreset?: Record<string, boolean>;
} {
  const trimmed = String(code ?? '').trim();
  if (!trimmed) return { valid: false };
  const db = getDb();

  const result = db.prepare(`
    UPDATE invite_codes
    SET used_count = used_count + 1
    WHERE code = ?
      AND used_count < max_uses
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).run(trimmed);

  if (result.changes === 0) return { valid: false };

  // Get the skill_preset from the consumed code
  const invite = db.prepare('SELECT skill_preset, expires_at FROM invite_codes WHERE code = ?').get(trimmed) as any;
  try {
    db.prepare(`
      UPDATE waitlist
         SET status = 'signed_up',
             email_delivery_status = 'invite_redeemed'
       WHERE invite_code = ?
    `).run(trimmed);
  } catch { /* waitlist table may not exist in older local fixtures */ }
  let skillPreset: Record<string, boolean> | undefined;
  if (invite?.skill_preset) {
    try { skillPreset = JSON.parse(invite.skill_preset); } catch { /* ignore */ }
  }

  const response: { valid: true; expiresAt?: string | null; skillPreset?: Record<string, boolean> } = { valid: true };
  if (invite?.expires_at) response.expiresAt = invite.expires_at;
  if (skillPreset) response.skillPreset = skillPreset;
  return response;
}

export function consumeDatabaseInviteForUser(inviteCode: unknown): {
  consumed: boolean;
  expiresAt?: string | null;
  skillPreset?: Record<string, boolean>;
} {
  const rawCode = String(inviteCode ?? '').trim();
  if (!rawCode) return { consumed: false };

  const normalized = rawCode.toLowerCase();
  const staticCodes = [
    (config as any).ios?.inviteCode,
    (config as any).ios?.ownerCode,
  ].map((code) => String(code ?? '').trim().toLowerCase()).filter(Boolean);
  if (staticCodes.includes(normalized)) return { consumed: false };

  const result = validateAndConsumeInviteCode(rawCode);
  if (!result.valid) return { consumed: false };
  const consumed: { consumed: true; expiresAt?: string | null; skillPreset?: Record<string, boolean> } = { consumed: true };
  if (result.expiresAt) consumed.expiresAt = result.expiresAt;
  if (result.skillPreset) consumed.skillPreset = result.skillPreset;
  return consumed;
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
 * Auto-create or upgrade the owner user from explicit OWNER_TELEGRAM_ID when
 * no persisted owner record already exists.
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

    const configuredOwnerTelegramId = getConfiguredOwnerBootstrapTelegramId();

    const persistedOwner = db.prepare(`
      SELECT telegram_id
      FROM users
      WHERE tier = 'owner' AND telegram_id IS NOT NULL
      ORDER BY id ASC
      LIMIT 1
    `).get() as { telegram_id: number | null } | undefined;

    if (persistedOwner?.telegram_id) {
      if (
        configuredOwnerTelegramId
        && persistedOwner.telegram_id !== configuredOwnerTelegramId
      ) {
        logger.warn(
          {
            configuredOwnerTelegramId,
            persistedOwnerTelegramId: persistedOwner.telegram_id,
          },
          'OWNER_TELEGRAM_ID does not match the persisted owner row; keeping the existing owner record unchanged',
        );
      }
      return;
    }

    if (!configuredOwnerTelegramId) {
      logger.warn('No explicit OWNER_TELEGRAM_ID found — skipping owner seed');
      return;
    }

    const existing = db.prepare(`
      SELECT *
      FROM users
      WHERE telegram_id = ?
      LIMIT 1
    `).get(configuredOwnerTelegramId) as User | undefined;

    if (existing) {
      if (
        existing.tier !== 'owner'
        || existing.status !== 'active'
        || existing.daily_message_limit !== 0
        || existing.daily_token_limit !== 0
        || existing.daily_cost_limit_usd !== 0
      ) {
        db.prepare(`
          UPDATE users
          SET first_name = COALESCE(first_name, 'Owner'),
              tier = 'owner',
              status = 'active',
              daily_message_limit = 0,
              daily_token_limit = 0,
              daily_cost_limit_usd = 0
          WHERE telegram_id = ?
        `).run(configuredOwnerTelegramId);
        logger.info({ telegramId: configuredOwnerTelegramId }, 'Existing user upgraded to owner bootstrap user');
      }
      return;
    }

    db.prepare(`
      INSERT INTO users (telegram_id, first_name, language, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (?, 'Owner', 'pt-BR', 'owner', 'active', 0, 0, 0)
    `).run(configuredOwnerTelegramId);

    logger.info({ telegramId: configuredOwnerTelegramId }, 'Owner user seeded');
  } catch (err) {
    logger.warn({ err }, 'Failed to seed owner user');
  }
}
