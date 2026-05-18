// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Per-User Skill Access — admin-controlled enable/disable per skill and sub-skill.
 *
 * Default: ALL skills enabled. Admin disables via portal.
 * Owner tier bypasses all restrictions.
 * Only DISABLED overrides are stored in the DB.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ─── Skill Catalog ──────────────────────────────────────────────────

export interface SkillDefinition {
  skill: string;
  label: string;
  description: string;
  requiresOAuth: boolean;
  oauthProvider?: 'google' | 'outlook';
  subSkills: Array<{
    id: string;
    label: string;
    description: string;
  }>;
}

export const SKILL_CATALOG: SkillDefinition[] = [
  {
    skill: 'secretary',
    label: 'Secretary',
    description: 'Task management, reminders, calendar, email',
    requiresOAuth: true,
    oauthProvider: 'google',
    subSkills: [
      { id: 'todos', label: 'To-Do Management', description: 'Create, list, complete tasks' },
      { id: 'reminders', label: 'Reminders', description: 'Set and manage reminders' },
      { id: 'calendar', label: 'Calendar', description: 'View and create calendar events' },
      { id: 'email', label: 'Email', description: 'Read and send emails' },
      { id: 'notes', label: 'Notes', description: 'Quick notes and shared memory' },
    ],
  },
  {
    skill: 'triathlon',
    label: 'Triathlon Coach',
    description: 'Workout planning, Garmin integration, nutrition',
    requiresOAuth: false,
    subSkills: [
      { id: 'training', label: 'Training Plans', description: 'Gym, run, bike, swim programming' },
      { id: 'garmin', label: 'Garmin', description: 'Garmin device integration' },
      { id: 'nutrition', label: 'Nutrition', description: 'Meal planning and macros' },
    ],
  },
  {
    skill: 'content',
    label: 'Content Creator',
    description: 'Video ideas, scripts, SEO, social media',
    requiresOAuth: false,
    subSkills: [
      { id: 'ideas', label: 'Idea Generation', description: 'Video and reel ideas' },
      { id: 'scripts', label: 'Script Writing', description: 'Video scripts and hooks' },
      { id: 'seo', label: 'SEO', description: 'Keywords and optimization' },
      { id: 'discovery', label: 'Content Discovery', description: 'Trend research' },
    ],
  },
  {
    skill: 'cooking',
    label: 'Cooking Chef',
    description: 'Recipes, meal planning, shopping lists',
    requiresOAuth: false,
    subSkills: [],
  },
  {
    skill: 'finance',
    label: 'Finance Tracker',
    description: 'Expenses, tax calculation, budgeting',
    requiresOAuth: false,
    subSkills: [
      { id: 'expenses', label: 'Expense Tracking', description: 'Log and categorize expenses' },
      { id: 'tax', label: 'Tax Calculation', description: 'Portugal IRS / IVA estimates' },
      { id: 'invoices', label: 'Invoice Filing', description: 'Auto-file receipts and invoices' },
    ],
  },
];

// ─── Access Check ───────────────────────────────────────────────────

/**
 * Check if a user can use a specific skill (or sub-skill).
 * Returns true if no override exists OR override.enabled=1.
 * Owner always returns true.
 */
export function isSkillEnabled(userId: number, skill: string, subSkill?: string): boolean {
  // Owner bypasses all restrictions
  try {
    const { isOwner } = require('./user-service');
    if (isOwner(userId)) return true;
  } catch { /* user-service not loaded */ }

  try {
    const db = getDb();

    // Check parent skill first
    const parentRow = db.prepare(
      'SELECT enabled FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill IS NULL'
    ).get(userId, skill) as { enabled: number } | undefined;

    if (parentRow && parentRow.enabled === 0) return false;

    // Check sub-skill if specified
    if (subSkill) {
      const subRow = db.prepare(
        'SELECT enabled FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill = ?'
      ).get(userId, skill, subSkill) as { enabled: number } | undefined;

      if (subRow && subRow.enabled === 0) return false;
    }

    return true; // Default: enabled
  } catch (err) {
    // Hardening 2026-04-21: was `return true; // fail open`, which
    // meant a single DB lock would re-grant access to an admin-
    // disabled skill. Fail closed instead: on DB error, deny access
    // and log so operators can correlate with the underlying fault.
    // Callers that want permissive behavior must make the choice
    // explicit at the call site.
    logger.warn({ err, skill }, 'user-skill-access: DB lookup failed — failing closed');
    return false;
  }
}

// ─── Admin Actions ──────────────────────────────────────────────────

/**
 * Enable or disable a skill (or sub-skill) for a user.
 */
export function setSkillAccess(userId: number, skill: string, enabled: boolean, options?: {
  subSkill?: string;
  reason?: string;
  adminId?: number;
}): void {
  const db = getDb();
  const subSkill = options?.subSkill || null;

  // SQLite treats NULL ≠ NULL for UNIQUE constraints, so we delete+insert instead of upsert
  if (subSkill) {
    db.prepare('DELETE FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill = ?').run(userId, skill, subSkill);
  } else {
    db.prepare('DELETE FROM user_skill_overrides WHERE user_id = ? AND skill = ? AND sub_skill IS NULL').run(userId, skill);
  }

  db.prepare(`
    INSERT INTO user_skill_overrides (user_id, skill, sub_skill, enabled, reason, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(userId, skill, subSkill, enabled ? 1 : 0, options?.reason || null, options?.adminId || null);

  logger.info({ userId, skill, subSkill, enabled, adminId: options?.adminId }, 'Skill access updated');
}

/**
 * Get all overrides for a user (for portal display).
 */
export function getUserSkillOverrides(userId: number): Array<{
  skill: string;
  subSkill: string | null;
  enabled: boolean;
  reason: string | null;
  updatedAt: string;
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT skill, sub_skill, enabled, reason, updated_at FROM user_skill_overrides WHERE user_id = ?'
  ).all(userId) as any[];

  return rows.map(r => ({
    skill: r.skill,
    subSkill: r.sub_skill,
    enabled: r.enabled === 1,
    reason: r.reason,
    updatedAt: r.updated_at,
  }));
}

/**
 * Get the full skill catalog (static definition).
 */
export function getSkillCatalog(): SkillDefinition[] {
  return SKILL_CATALOG;
}

/**
 * Get effective skill state for a user (catalog + overrides + OAuth status).
 * Used by the portal to render the toggle grid.
 */
export function getUserSkillState(userId: number): Array<{
  skill: string;
  label: string;
  description: string;
  enabled: boolean;
  source: 'default' | 'override';
  requiresOAuth: boolean;
  connected: boolean;
  subSkills: Array<{
    id: string;
    label: string;
    enabled: boolean;
    source: 'default' | 'override';
  }>;
}> {
  const overrides = getUserSkillOverrides(userId);
  const overrideMap = new Map<string, boolean>();
  for (const o of overrides) {
    const key = o.subSkill ? `${o.skill}:${o.subSkill}` : o.skill;
    overrideMap.set(key, o.enabled);
  }

  // Check OAuth connection status
  let isOAuthConnected: (provider: string) => boolean = () => false;
  try {
    const { isConnected } = require('./oauth-store');
    isOAuthConnected = (provider) => isConnected(userId, provider as any);
  } catch { /* oauth-store not loaded */ }

  return SKILL_CATALOG.map(def => {
    const parentOverride = overrideMap.get(def.skill);
    const parentEnabled = parentOverride !== undefined ? parentOverride : true;

    return {
      skill: def.skill,
      label: def.label,
      description: def.description,
      enabled: parentEnabled,
      source: (parentOverride !== undefined ? 'override' : 'default') as 'default' | 'override',
      requiresOAuth: def.requiresOAuth,
      connected: def.oauthProvider ? isOAuthConnected(def.oauthProvider) : true,
      subSkills: def.subSkills.map(sub => {
        const subOverride = overrideMap.get(`${def.skill}:${sub.id}`);
        const subEnabled = subOverride !== undefined ? subOverride : true;
        return {
          id: sub.id,
          label: sub.label,
          enabled: parentEnabled ? subEnabled : false, // Parent disabled → sub disabled
          source: (subOverride !== undefined ? 'override' : 'default') as 'default' | 'override',
        };
      }),
    };
  });
}

/**
 * Reset all skill overrides for a user (revert to defaults).
 */
export function resetUserSkillOverrides(userId: number): void {
  const db = getDb();
  db.prepare('DELETE FROM user_skill_overrides WHERE user_id = ?').run(userId);
  logger.info({ userId }, 'All skill overrides reset to default');
}

/**
 * Apply a skill preset from an invite code.
 * The preset is a JSON object mapping skill names to boolean (enabled/disabled).
 * Only creates override entries for DISABLED skills (default is enabled).
 */
export function applySkillPreset(userId: number, preset: Record<string, boolean>): void {
  for (const [skill, enabled] of Object.entries(preset)) {
    if (!enabled) {
      setSkillAccess(userId, skill, false);
    }
  }
}
