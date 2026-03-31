/**
 * Skill Registry Service
 *
 * Manages installed skills in SQLite. Provides CRUD operations
 * for the installed_skills and skill_submodules tables.
 *
 * All methods are synchronous (better-sqlite3 is sync by design).
 */
import { getDb } from '../services/database';
import { logger } from '../utils/logger';
import type BetterSqlite3 from 'better-sqlite3';
import type { SkillId, SkillManifest, SubModuleManifest } from './types';

// ─── Row Types ──────────────────────────────────────────────────────

export interface InstalledSkillRow {
  id: string;
  version: string;
  enabled: number; // SQLite boolean: 0 | 1
  config: string;  // JSON string
  domain: string | null;
  installed_at: string;
  updated_at: string;
}

export interface SkillSubmoduleRow {
  skill_id: string;
  submodule_id: string;
  enabled: number;
  config: string;
}

// ─── Prepared Statements ────────────────────────────────────────────

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;

function getStmts(): Record<string, BetterSqlite3.Statement> {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    insertSkill: db.prepare(`
      INSERT INTO installed_skills (id, version, enabled, config, domain)
      VALUES (?, ?, 1, ?, ?)`),
    deleteSkill: db.prepare(`
      DELETE FROM installed_skills WHERE id = ?`),
    enable: db.prepare(`
      UPDATE installed_skills SET enabled = 1, updated_at = datetime('now')
      WHERE id = ?`),
    disable: db.prepare(`
      UPDATE installed_skills SET enabled = 0, updated_at = datetime('now')
      WHERE id = ?`),
    getById: db.prepare(`
      SELECT * FROM installed_skills WHERE id = ?`),
    getEnabled: db.prepare(`
      SELECT * FROM installed_skills WHERE enabled = 1`),
    getByDomain: db.prepare(`
      SELECT * FROM installed_skills WHERE domain = ? AND enabled = 1`),
    getAll: db.prepare(`
      SELECT * FROM installed_skills`),
    insertSubmodule: db.prepare(`
      INSERT INTO skill_submodules (skill_id, submodule_id, enabled, config)
      VALUES (?, ?, ?, ?)`),
    getSubmodules: db.prepare(`
      SELECT * FROM skill_submodules WHERE skill_id = ?`),
    enableSubmodule: db.prepare(`
      UPDATE skill_submodules SET enabled = 1 WHERE skill_id = ? AND submodule_id = ?`),
    disableSubmodule: db.prepare(`
      UPDATE skill_submodules SET enabled = 0 WHERE skill_id = ? AND submodule_id = ?`),
    updateConfig: db.prepare(`
      UPDATE installed_skills SET config = ?, updated_at = datetime('now')
      WHERE id = ?`),
    updateVersion: db.prepare(`
      UPDATE installed_skills SET version = ?, updated_at = datetime('now')
      WHERE id = ?`),
  };
  return _stmts;
}

// ─── Registry API ───────────────────────────────────────────────────

/**
 * Install a skill from its manifest. Inserts the skill row and
 * creates submodule rows with their default enabled state.
 * No-op if the skill is already installed.
 */
export function install(
  manifest: SkillManifest,
  options: { domain?: string; config?: Record<string, unknown> } = {},
): InstalledSkillRow {
  const stmts = getStmts();
  const existing = stmts.getById.get(manifest.id) as InstalledSkillRow | undefined;
  if (existing) {
    logger.warn({ skillId: manifest.id }, 'Skill already installed, skipping');
    return existing;
  }

  const db = getDb();
  const configJson = JSON.stringify(options.config ?? {});

  const insertAll = db.transaction(() => {
    stmts.insertSkill.run(manifest.id, manifest.version, configJson, options.domain ?? null);

    if (manifest.subModules) {
      for (const sub of manifest.subModules) {
        stmts.insertSubmodule.run(
          manifest.id,
          sub.id,
          sub.enabledByDefault ? 1 : 0,
          '{}',
        );
      }
    }
  });

  insertAll();
  logger.info({ skillId: manifest.id, version: manifest.version }, 'Skill installed');

  return stmts.getById.get(manifest.id) as InstalledSkillRow;
}

/**
 * Uninstall a skill. Removes the skill and all related submodules
 * (CASCADE handles submodules, credentials, and migrations).
 * Returns true if the skill was found and removed.
 */
export function uninstall(skillId: SkillId): boolean {
  const stmts = getStmts();
  const result = stmts.deleteSkill.run(skillId);
  if (result.changes > 0) {
    logger.info({ skillId }, 'Skill uninstalled');
    return true;
  }
  logger.warn({ skillId }, 'Skill not found for uninstall');
  return false;
}

/**
 * Enable an installed skill. Returns true if the skill was found.
 */
export function enable(skillId: SkillId): boolean {
  const stmts = getStmts();
  const result = stmts.enable.run(skillId);
  if (result.changes > 0) {
    logger.info({ skillId }, 'Skill enabled');
    return true;
  }
  return false;
}

/**
 * Disable an installed skill (without removing it).
 * Returns true if the skill was found.
 */
export function disable(skillId: SkillId): boolean {
  const stmts = getStmts();
  const result = stmts.disable.run(skillId);
  if (result.changes > 0) {
    logger.info({ skillId }, 'Skill disabled');
    return true;
  }
  return false;
}

/**
 * Get all enabled skills.
 */
export function getEnabled(): InstalledSkillRow[] {
  return getStmts().getEnabled.all() as InstalledSkillRow[];
}

/**
 * Get all enabled skills for a specific domain.
 */
export function getByDomain(domain: string): InstalledSkillRow[] {
  return getStmts().getByDomain.all(domain) as InstalledSkillRow[];
}

/**
 * Get a single skill by ID (regardless of enabled state).
 */
export function getById(skillId: SkillId): InstalledSkillRow | undefined {
  return getStmts().getById.get(skillId) as InstalledSkillRow | undefined;
}

/**
 * Get all installed skills (regardless of enabled state).
 */
export function getAll(): InstalledSkillRow[] {
  return getStmts().getAll.all() as InstalledSkillRow[];
}

/**
 * Get submodules for a skill.
 */
export function getSubmodules(skillId: SkillId): SkillSubmoduleRow[] {
  return getStmts().getSubmodules.all(skillId) as SkillSubmoduleRow[];
}

/**
 * Enable a specific submodule within a skill.
 */
export function enableSubmodule(skillId: SkillId, submoduleId: string): boolean {
  const result = getStmts().enableSubmodule.run(skillId, submoduleId);
  return result.changes > 0;
}

/**
 * Disable a specific submodule within a skill.
 */
export function disableSubmodule(skillId: SkillId, submoduleId: string): boolean {
  const result = getStmts().disableSubmodule.run(skillId, submoduleId);
  return result.changes > 0;
}

/**
 * Update a skill's config JSON.
 */
export function updateConfig(skillId: SkillId, config: Record<string, unknown>): boolean {
  const result = getStmts().updateConfig.run(JSON.stringify(config), skillId);
  return result.changes > 0;
}

/**
 * Reset cached prepared statements.
 * Needed when the database connection changes (e.g., in tests).
 */
export function _resetStmts(): void {
  _stmts = null;
}
