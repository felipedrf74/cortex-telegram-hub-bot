// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skill Tier Service — Phase 1 foundation.
 *
 * The skill gate answers one question: "Can user X use skill Y?"
 *
 * Canonical access resolution order (first match wins):
 *   1. Owner tier bypass
 *   2. Global installed skill/submodule disabled → deny
 *   3. User explicit deny in user_skill_overrides → deny
 *   4. User explicit grant in user_skill_tier_overrides → allow
 *   5. Tier comparison from skill_tiers / skill-config.ts / default pro
 *
 * Runtime callers should use `checkSkillAccess`. `checkTierAccess` remains
 * as a deprecated compatibility helper for tests and catalog views that need
 * the tier-only answer.
 *
 * Signals DB table `skill_tiers` was created in migration 045.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';
import { DEFAULT_SKILLS } from '../skills/skill-config';
import { TIER_RANK, type SkillTier } from '../skills/skill-config';
import type { User } from './user-service';

// ─── Types ──────────────────────────────────────────────────────────

export interface SkillTierRow {
  skill_id: string;
  required_tier: SkillTier;
  description: string | null;
  updated_at: string;
}

export interface UserSkillTierOverrideRow {
  id: number;
  user_id: number;
  skill_id: string;
  unlocked: number;         // 1 = grant, 0 = explicit deny
  reason: string | null;
  granted_by: number | null;
  granted_at: string;
  expires_at: string | null;
}

export interface TierAccessResult {
  allowed: boolean;
  reason: 'catalog' | 'override' | 'default' | 'denied';
  userTier: SkillTier;
  requiredTier: SkillTier;
  skillId: string;
}

export type SkillAccessReason =
  | 'owner_bypass'
  | 'global_disabled'
  | 'user_denied'
  | 'user_grant'
  | TierAccessResult['reason']
  | 'db_error';

export interface SkillAccessResult {
  allowed: boolean;
  reason: SkillAccessReason;
  userTier: SkillTier;
  requiredTier: SkillTier;
  skillId: string;
  parentSkill: string;
  subSkill: string | null;
  globalEnabled: boolean;
  tierReason: TierAccessResult['reason'] | null;
}

// ─── Catalog Reads ──────────────────────────────────────────────────

/** Fetch the tier required for a skill ID. Returns null if not in catalog. */
export function getSkillTier(skillId: string): SkillTier | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT required_tier FROM skill_tiers WHERE skill_id = ?'
  ).get(skillId) as { required_tier: SkillTier } | undefined;
  return row?.required_tier ?? null;
}

/** Fetch the entire catalog. Used by the iOS Skills tab endpoint. */
export function listSkillTiers(): SkillTierRow[] {
  const db = getDb();
  return db.prepare(
    'SELECT skill_id, required_tier, description, updated_at FROM skill_tiers ORDER BY skill_id'
  ).all() as SkillTierRow[];
}

/**
 * Fall back to skill-config.ts when the DB catalog doesn't have an entry.
 * This lets code ship new skills without requiring a migration — the
 * SkillDefinition acts as a code-level default that the DB can override.
 */
function getTierFromConfig(skillId: string): SkillTier | null {
  const [skillName, subSkillName] = skillId.split('.');
  const def = DEFAULT_SKILLS[skillName as keyof typeof DEFAULT_SKILLS];
  if (!def) return null;

  // Sub-skill lookup
  if (subSkillName) {
    const sub = def.subSkills.find((s) => s.name === subSkillName);
    if (sub?.requiredTier) return sub.requiredTier;
    // Sub-skill exists but no explicit tier → inherit from parent
    if (sub) return def.requiredTier ?? 'pro';
    return null;
  }

  // Parent-skill lookup
  return def.requiredTier ?? null;
}

function normalizeSkillId(skillId: string): string {
  return String(skillId ?? '').trim();
}

function splitSkillId(skillId: string): { parentSkill: string; subSkill: string | null } {
  const normalized = normalizeSkillId(skillId);
  const dot = normalized.indexOf('.');
  if (dot === -1) return { parentSkill: normalized, subSkill: null };
  return {
    parentSkill: normalized.slice(0, dot),
    subSkill: normalized.slice(dot + 1) || null,
  };
}

function configuredRequiredTier(skillId: string): SkillTier {
  return getTierFromConfig(skillId) ?? 'pro';
}

function installedSkillGate(skillId: string): {
  allowed: boolean;
  parentSkill: string;
  subSkill: string | null;
  globalEnabled: boolean;
} {
  const db = getDb();
  const { parentSkill, subSkill } = splitSkillId(skillId);
  const parent = db.prepare(
    'SELECT id, enabled FROM installed_skills WHERE name = ?'
  ).get(parentSkill) as { id: number; enabled: number } | undefined;

  if (parent && parent.enabled !== 1) {
    return { allowed: false, parentSkill, subSkill, globalEnabled: false };
  }

  if (parent && subSkill) {
    const sub = db.prepare(
      'SELECT enabled FROM skill_submodules WHERE skill_id = ? AND module_name = ?'
    ).get(parent.id, subSkill) as { enabled: number } | undefined;
    if (sub && sub.enabled !== 1) {
      return { allowed: false, parentSkill, subSkill, globalEnabled: false };
    }
  }

  return { allowed: true, parentSkill, subSkill, globalEnabled: true };
}

function hasUserSkillDeny(userId: number, skillId: string): boolean {
  const db = getDb();
  const { parentSkill, subSkill } = splitSkillId(skillId);
  const parent = db.prepare(
    'SELECT enabled FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill IS NULL'
  ).get(userId, parentSkill) as { enabled: number } | undefined;
  if (parent?.enabled === 0) return true;

  if (subSkill) {
    const child = db.prepare(
      'SELECT enabled FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill = ?'
    ).get(userId, parentSkill, subSkill) as { enabled: number } | undefined;
    if (child?.enabled === 0) return true;
  }

  return false;
}

function buildSkillAccessResult(opts: {
  allowed: boolean;
  reason: SkillAccessReason;
  userTier: SkillTier;
  requiredTier: SkillTier;
  skillId: string;
  tierReason?: TierAccessResult['reason'] | null;
  globalEnabled?: boolean;
}): SkillAccessResult {
  const { parentSkill, subSkill } = splitSkillId(opts.skillId);
  return {
    allowed: opts.allowed,
    reason: opts.reason,
    userTier: opts.userTier,
    requiredTier: opts.requiredTier,
    skillId: opts.skillId,
    parentSkill,
    subSkill,
    globalEnabled: opts.globalEnabled ?? true,
    tierReason: opts.tierReason ?? null,
  };
}

// ─── Per-User Overrides ─────────────────────────────────────────────

/**
 * Get a user's active override for a specific skill (if any). Expired
 * overrides are filtered out at query time so callers never see them.
 */
export function getUserOverride(userId: number, skillId: string): UserSkillTierOverrideRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, user_id, skill_id, unlocked, reason, granted_by, granted_at, expires_at
    FROM user_skill_tier_overrides
    WHERE user_id = ?
      AND skill_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(userId, skillId) as UserSkillTierOverrideRow | undefined;
  return row ?? null;
}

/** Grant a user access to a skill regardless of tier. */
export function grantOverride(opts: {
  userId: number;
  skillId: string;
  reason?: string;
  grantedBy?: number;
  expiresAt?: string;        // ISO 8601 timestamp, or undefined for permanent
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO user_skill_tier_overrides (user_id, skill_id, unlocked, reason, granted_by, expires_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(user_id, skill_id) DO UPDATE SET
      unlocked   = 1,
      reason     = excluded.reason,
      granted_by = excluded.granted_by,
      granted_at = datetime('now'),
      expires_at = excluded.expires_at
  `).run(
    opts.userId,
    opts.skillId,
    opts.reason ?? null,
    opts.grantedBy ?? null,
    opts.expiresAt ?? null,
  );
  logger.info({ userId: opts.userId, skillId: opts.skillId, expiresAt: opts.expiresAt }, 'Skill tier override granted');
}

/** Revoke a user's override (delete row — soft-revoke via expiry is also supported via grantOverride). */
export function revokeOverride(userId: number, skillId: string): boolean {
  const db = getDb();
  const res = db.prepare(
    'DELETE FROM user_skill_tier_overrides WHERE user_id = ? AND skill_id = ?'
  ).run(userId, skillId);
  if (res.changes > 0) {
    logger.info({ userId, skillId }, 'Skill tier override revoked');
  }
  return res.changes > 0;
}

// ─── The Gate ───────────────────────────────────────────────────────

function evaluateTierAccess(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillId: string,
  opts: { respectUserOverride: boolean },
): TierAccessResult {
  const normalizedSkillId = normalizeSkillId(skillId);
  // Hard deny unknown user
  if (!user) {
    return {
      allowed: false,
      reason: 'denied',
      userTier: 'free',
      requiredTier: 'owner',
      skillId: normalizedSkillId,
    };
  }

  const userTier = user.tier as SkillTier;

  // 1. Per-user override beats everything
  const override = opts.respectUserOverride ? getUserOverride(user.id, normalizedSkillId) : null;
  if (override) {
    return {
      allowed: override.unlocked === 1,
      reason: 'override',
      userTier,
      requiredTier: userTier,  // effectively unlocked at user's own tier
      skillId: normalizedSkillId,
    };
  }

  // 2. Catalog lookup — DB is authoritative if present
  const catalogTier = getSkillTier(normalizedSkillId);
  if (catalogTier) {
    const allowed = TIER_RANK[userTier] >= TIER_RANK[catalogTier];
    return {
      allowed,
      reason: 'catalog',
      userTier,
      requiredTier: catalogTier,
      skillId: normalizedSkillId,
    };
  }

  // 3. Fall back to skill-config.ts (code-level default)
  const configTier = getTierFromConfig(normalizedSkillId);
  if (configTier) {
    const allowed = TIER_RANK[userTier] >= TIER_RANK[configTier];
    return {
      allowed,
      reason: 'default',
      userTier,
      requiredTier: configTier,
      skillId: normalizedSkillId,
    };
  }

  // 4. Global default: unknown skills require 'pro'
  const globalDefault: SkillTier = 'pro';
  return {
    allowed: TIER_RANK[userTier] >= TIER_RANK[globalDefault],
    reason: 'default',
    userTier,
    requiredTier: globalDefault,
    skillId: normalizedSkillId,
  };
}

/**
 * Deprecated tier-only helper. Runtime gates should use `checkSkillAccess`
 * so global install state, user explicit denies, owner bypass, and tier
 * overrides are resolved in one place.
 */
export function checkTierAccess(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillId: string,
): TierAccessResult {
  return evaluateTierAccess(user, skillId, { respectUserOverride: true });
}

/**
 * Canonical skill gate. Call this before exposing or executing any user-facing
 * skill capability.
 */
export function checkSkillAccess(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillId: string,
): SkillAccessResult {
  const normalizedSkillId = normalizeSkillId(skillId);
  if (!user) {
    return buildSkillAccessResult({
      allowed: false,
      reason: 'denied',
      userTier: 'free',
      requiredTier: 'owner',
      skillId: normalizedSkillId,
      tierReason: 'denied',
    });
  }

  const userTier = user.tier as SkillTier;
  if (userTier === 'owner') {
    return buildSkillAccessResult({
      allowed: true,
      reason: 'owner_bypass',
      userTier,
      requiredTier: userTier,
      skillId: normalizedSkillId,
      tierReason: null,
      globalEnabled: true,
    });
  }

  try {
    const globalGate = installedSkillGate(normalizedSkillId);
    if (!globalGate.allowed) {
      return buildSkillAccessResult({
        allowed: false,
        reason: 'global_disabled',
        userTier,
        requiredTier: configuredRequiredTier(normalizedSkillId),
        skillId: normalizedSkillId,
        globalEnabled: false,
      });
    }

    if (hasUserSkillDeny(user.id, normalizedSkillId)) {
      return buildSkillAccessResult({
        allowed: false,
        reason: 'user_denied',
        userTier,
        requiredTier: configuredRequiredTier(normalizedSkillId),
        skillId: normalizedSkillId,
        globalEnabled: true,
      });
    }

    const override = getUserOverride(user.id, normalizedSkillId);
    if (override) {
      return buildSkillAccessResult({
        allowed: override.unlocked === 1,
        reason: override.unlocked === 1 ? 'user_grant' : 'user_denied',
        userTier,
        requiredTier: userTier,
        skillId: normalizedSkillId,
        globalEnabled: true,
      });
    }

    const tier = evaluateTierAccess(user, normalizedSkillId, { respectUserOverride: false });
    return buildSkillAccessResult({
      ...tier,
      reason: tier.reason,
      tierReason: tier.reason,
      globalEnabled: true,
    });
  } catch (err) {
    logger.warn(
      { err, userId: user.id, skillId: normalizedSkillId },
      'Skill access lookup failed — failing closed',
    );
    return buildSkillAccessResult({
      allowed: false,
      reason: 'db_error',
      userTier,
      requiredTier: configuredRequiredTier(normalizedSkillId),
      skillId: normalizedSkillId,
      globalEnabled: false,
    });
  }
}

/**
 * Batch variant — evaluates all skill IDs in one pass. Useful for the
 * iOS Skills tab which needs to render a tree of skills with tier badges
 * in a single request.
 */
export function checkTierAccessBatch(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillIds: string[],
): Map<string, TierAccessResult> {
  const result = new Map<string, TierAccessResult>();
  for (const skillId of skillIds) {
    result.set(skillId, checkTierAccess(user, skillId));
  }
  return result;
}

export function checkSkillAccessBatch(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillIds: string[],
): Map<string, SkillAccessResult> {
  const result = new Map<string, SkillAccessResult>();
  for (const skillId of skillIds) {
    result.set(skillId, checkSkillAccess(user, skillId));
  }
  return result;
}

// ─── Catalog Mutation (admin-only in higher layers) ─────────────────

/** Set the required tier for a skill in the DB catalog. Creates row if missing. */
export function setSkillTier(skillId: string, requiredTier: SkillTier, description?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO skill_tiers (skill_id, required_tier, description)
    VALUES (?, ?, ?)
    ON CONFLICT(skill_id) DO UPDATE SET
      required_tier = excluded.required_tier,
      description   = COALESCE(excluded.description, skill_tiers.description),
      updated_at    = datetime('now')
  `).run(skillId, requiredTier, description ?? null);
  logger.info({ skillId, requiredTier }, 'Skill tier catalog updated');
}
