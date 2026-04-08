// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Skill Tier Service — Phase 1 foundation.
 *
 * The tier gate answers one question: "Can user X use skill Y?"
 *
 * Resolution order (first match wins):
 *   1. Per-user override in user_skill_tier_overrides (if not expired)
 *   2. Catalog entry in skill_tiers          → compare user.tier ≥ required_tier
 *   3. Defaults from skill-config.ts         → fall back to SkillDefinition.requiredTier
 *   4. Global default: 'pro'
 *
 * This service is the SINGLE source of truth for tier enforcement. Every
 * caller (API middleware, chat domain router, iOS Skills tab endpoint)
 * should go through `checkTierAccess` — never inline the comparison.
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

/**
 * THE tier gate. Call this before letting a user access any skill.
 *
 * @param user - The resolved User row. If null/undefined, access is denied.
 * @param skillId - Dot-notation skill ID, e.g. 'triathlon.gym' or 'secretary'.
 * @returns Structured result with `allowed`, the reason, and tier breakdown.
 */
export function checkTierAccess(
  user: Pick<User, 'id' | 'tier'> | null | undefined,
  skillId: string,
): TierAccessResult {
  // Hard deny unknown user
  if (!user) {
    return {
      allowed: false,
      reason: 'denied',
      userTier: 'free',
      requiredTier: 'owner',
      skillId,
    };
  }

  const userTier = user.tier as SkillTier;

  // 1. Per-user override beats everything
  const override = getUserOverride(user.id, skillId);
  if (override) {
    return {
      allowed: override.unlocked === 1,
      reason: 'override',
      userTier,
      requiredTier: userTier,  // effectively unlocked at user's own tier
      skillId,
    };
  }

  // 2. Catalog lookup — DB is authoritative if present
  const catalogTier = getSkillTier(skillId);
  if (catalogTier) {
    const allowed = TIER_RANK[userTier] >= TIER_RANK[catalogTier];
    return {
      allowed,
      reason: 'catalog',
      userTier,
      requiredTier: catalogTier,
      skillId,
    };
  }

  // 3. Fall back to skill-config.ts (code-level default)
  const configTier = getTierFromConfig(skillId);
  if (configTier) {
    const allowed = TIER_RANK[userTier] >= TIER_RANK[configTier];
    return {
      allowed,
      reason: 'default',
      userTier,
      requiredTier: configTier,
      skillId,
    };
  }

  // 4. Global default: unknown skills require 'pro'
  const globalDefault: SkillTier = 'pro';
  return {
    allowed: TIER_RANK[userTier] >= TIER_RANK[globalDefault],
    reason: 'default',
    userTier,
    requiredTier: globalDefault,
    skillId,
  };
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
