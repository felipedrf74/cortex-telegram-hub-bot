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
import { getStoredDailyCostLimitUsdForTier } from './plan-quotas';
// OI-WELCOME-201d (2026-04-24): eager import (was lazy-require
// before). welcome-email-service does NOT import user-service back
// — confirmed via grep — so there's no dependency cycle. Eager
// import makes the welcome-email hook testable under vitest's
// vi.mock (require() would bypass mock intercept).
import { fireWelcomeEmailInBackground } from './welcome-email-service';

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
  telegramId: number;
}

export type IosInviteResolution =
  | { kind: 'owner'; user: User }
  | { kind: 'sandbox'; user: User }
  | { kind: 'owner_unavailable' }
  | { kind: 'invalid' };

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
  // Telegram traffic still uses telegram_id, while iOS API requests carry
  // the canonical users.id in JWTs. Resolve both so shared helpers like
  // getUserLanguage() behave consistently across platforms.
  return getUserByTelegramId(userRef) ?? getUserById(userRef);
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
  const normalizedInviteCode = String(inviteCode).trim().toLowerCase();
  const ownerCode = (config.ios.ownerCode || '').trim().toLowerCase();
  const betaCode = (config.ios.inviteCode || '').trim().toLowerCase();

  if (ownerCode && normalizedInviteCode === ownerCode) {
    const user = getOwnerBootstrapUser();
    return user ? { kind: 'owner', user } : { kind: 'owner_unavailable' };
  }

  if (betaCode && normalizedInviteCode === betaCode) {
    return { kind: 'sandbox', user: getOrCreateInviteSandboxUser(deviceId) };
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
}): User {
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
  logger.info({ appleUserId, email: profile.email }, 'New Apple user registered');
  return getUserByAppleId(appleUserId)!;
}

export function createGoogleUser(googleUserId: string, profile: {
  email: string; name?: string; picture?: string;
}): User {
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
  logger.info({ googleUserId, email: profile.email }, 'New Google user registered');
  return getUserByGoogleId(googleUserId)!;
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
  logger.info({ email }, 'New email user registered');
  return getUserByEmail(email)!;
}

/**
 * OI-NAV-203c (2026-04-24): passwordless email user creation for the
 * magic-link cold-invitee flow. No password hash, no username — just
 * an email + first_name derived from the local-part. Marks
 * email_verified=1 because possession of the magic link IS the
 * verification (the email only ever reached the address owner).
 *
 * If a user with this email already exists, returns that user without
 * modification — magic-link consume is idempotent on the user side.
 *
 * Throws if the email is empty or malformed. Caller is expected to
 * have already validated via invite metadata.
 */
export function createPasswordlessEmailUser(email: string): User {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new Error('createPasswordlessEmailUser: invalid email');
  }
  const existing = getUserByEmail(normalized);
  if (existing) return existing;

  const db = getDb();
  // Derive a display name from the local-part — nothing fancy, the
  // user can rename in Profile later. Replaces dots/underscores with
  // spaces for a half-reasonable first-pass.
  const localPart = normalized.split('@')[0] || '';
  const firstName = localPart.replace(/[._-]+/g, ' ').trim() || 'Friend';

  // email_verified=1 because the magic-link arrived at THIS email.
  db.prepare(`
    INSERT INTO users (email, first_name, email_verified,
      auth_provider, tier, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, ?, 1, 'email', 'free', 40, 100000, ?)
  `).run(normalized, firstName, getStoredDailyCostLimitUsdForTier('free'));
  logger.info({ email: normalized, via: 'magic-link' }, 'New passwordless email user registered');
  return getUserByEmail(normalized)!;
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

/**
 * Canonical tier-update path — writes tier + daily limits on the
 * users row (keyed by internal `users.id`) and fires the welcome
 * email hook (idempotent) on paid-tier transitions.
 *
 * OI-WELCOME-201d (2026-04-24): extracted from `setUserTier(telegramId)`
 * so the Stripe + Apple purchase handlers can call tier-update
 * without depending on `telegram_id`. Telegram is being
 * decommissioned; tenant + user IDs are the single source of
 * truth going forward.
 *
 * Idempotency contract:
 *   - The UPDATE is unconditional — callers that only want a
 *     "change if different" can check users.tier first.
 *   - The welcome-email hook is internally guarded by an
 *     audit-trail idempotency check (see welcome-email-service).
 *     Calling this 10 times with tier='pro' triggers 10 UPDATEs
 *     but AT MOST ONE welcome email per (user, template) pair.
 */
export function setUserTierById(userId: number, tier: 'free' | 'pro' | 'max' | 'owner'): void {
  if (!Number.isFinite(userId) || userId <= 0) {
    logger.warn({ userId, tier }, 'setUserTierById: invalid userId; skipping');
    return;
  }

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
    WHERE id = ?
  `).run(tier, limits.messages, limits.tokens, limits.cost, userId);
  logger.info({ userId, tier }, 'User tier updated');

  // OI-WELCOME-201 (2026-04-24): fire welcome email on first
  // paid-tier transition. The service is idempotent — if the user
  // already got one, or has no email, or the mailer is down, it
  // silently no-ops. Never blocks the tier update.
  if (tier === 'pro' || tier === 'max') {
    try {
      fireWelcomeEmailInBackground(userId);
    } catch (hookErr) {
      logger.warn({ err: hookErr, userId, tier }, 'setUserTierById: welcome-email hook failed to fire (non-fatal)');
    }
  }
}

/**
 * OI-WELCOME-201d (2026-04-24): bridge purchase events → tier column.
 *
 * Reads the user's latest `subscriptions` row and writes the derived
 * tier onto `users.tier` if it differs, firing the welcome-email
 * hook as a side effect of the first-time paid transition. Safe to
 * call from every Stripe / Apple webhook handler — if the tier
 * already matches, it's a no-op (no UPDATE, no welcome email).
 *
 * Tier derivation rules (intentionally narrower than
 * getEffectiveEntitlement — env-configured owner + paywall-disabled
 * bypass belong at the entitlement layer, not here):
 *
 *   - status ∈ ('active', 'trialing') + plan ∈ ('pro','max')
 *         → that plan
 *   - anything else (canceled, past_due, expired, no row)
 *         → 'free'
 *
 * Renewals (DID_RENEW, Stripe invoice.paid firing
 * handleSubscriptionUpdated on a row already at tier='pro') are
 * naturally handled: the derived tier matches the current tier,
 * the diff check short-circuits, no welcome email is sent — which
 * is exactly the desired behavior (welcome once per onboarding,
 * not once per billing cycle).
 *
 * Returns the post-sync tier so callers can log it.
 */
export function syncUserTierFromSubscription(userId: number): 'free' | 'pro' | 'max' | 'owner' | null {
  if (!Number.isFinite(userId) || userId <= 0) return null;

  const db = getDb();

  // Read the current users.tier + the latest subscription row.
  const userRow = db.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as { tier: string } | undefined;
  if (!userRow) {
    logger.warn({ userId }, 'syncUserTierFromSubscription: user not found');
    return null;
  }
  // 'owner' is a sticky tier — an owner who buys a Pro subscription
  // (e.g. for testing) shouldn't be demoted. Matches
  // getEffectiveEntitlement's rule-1 precedence.
  if (userRow.tier === 'owner') return 'owner';

  const sub = db.prepare(
    'SELECT plan, status FROM subscriptions WHERE user_id = ?',
  ).get(userId) as { plan: string; status: string } | undefined;

  const isActive = sub?.status === 'active' || sub?.status === 'trialing';
  const derivedTier: 'free' | 'pro' | 'max' = isActive && (sub!.plan === 'pro' || sub!.plan === 'max')
    ? sub!.plan
    : 'free';

  // Short-circuit when tier already matches — keeps the welcome
  // email firing exactly once per onboarding (not on every
  // renewal), and avoids spurious UPDATEs that touch
  // daily_*_limit columns the admin may have tuned.
  if (userRow.tier === derivedTier) {
    logger.debug({ userId, tier: derivedTier }, 'syncUserTierFromSubscription: no change');
    return derivedTier;
  }

  setUserTierById(userId, derivedTier);
  return derivedTier;
}

/**
 * @deprecated Telegram is being decommissioned (2026-04-24).
 * Prefer `setUserTierById(userId, tier)` — tenant + user IDs are
 * the single source of truth.
 *
 * Kept as a thin Telegram→userId shim so legacy callers (Telegram
 * admin commands + their tests) still work during the transition.
 * Resolves telegram_id → users.id and delegates to setUserTierById.
 */
export function setUserTier(telegramId: number, tier: 'free' | 'pro' | 'max' | 'owner'): void {
  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(telegramId) as { id: number } | undefined;
  if (!user) {
    // Matches pre-refactor behavior: the UPDATE used to silently
    // no-op on a missing row. Log a diagnostic warning (not an
    // error — tests and the Telegram-flow admin commands rely on
    // this being a no-op for unseeded users).
    logger.warn({ telegramId, tier }, 'setUserTier(telegramId): no user found; call is a no-op');
    return;
  }
  setUserTierById(user.id, tier);
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
