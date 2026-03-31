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
import type { SkillManifest } from './types';

// ─── Row Types ──────────────────────────────────────────────────────

export interface InstalledSkillRow {
  id: number;
  name: string;
  description: string | null;
  version: string;
  domain: string | null;
  enabled: number; // SQLite boolean: 0 | 1
  config_json: string | null;
  installed_at: string;
  updated_at: string;
}

export interface SkillSubmoduleRow {
  id: number;
  skill_id: number;
  module_name: string;
  version: string;
  enabled: number;
  config_json: string | null;
  created_at: string;
}

// ─── Prepared Statements ────────────────────────────────────────────

let _stmts: Record<string, BetterSqlite3.Statement> | null = null;

function getStmts(): Record<string, BetterSqlite3.Statement> {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    upsertSkill: db.prepare(`
      INSERT INTO installed_skills (name, description, version, domain, config_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        version = excluded.version,
        domain = excluded.domain,
        config_json = excluded.config_json,
        updated_at = datetime('now')`),
    deleteSkill: db.prepare(`
      DELETE FROM installed_skills WHERE name = ?`),
    enable: db.prepare(`
      UPDATE installed_skills SET enabled = 1, updated_at = datetime('now')
      WHERE name = ?`),
    disable: db.prepare(`
      UPDATE installed_skills SET enabled = 0, updated_at = datetime('now')
      WHERE name = ?`),
    getByName: db.prepare(`
      SELECT * FROM installed_skills WHERE name = ?`),
    getEnabled: db.prepare(`
      SELECT * FROM installed_skills WHERE enabled = 1 ORDER BY name`),
    getByDomain: db.prepare(`
      SELECT * FROM installed_skills WHERE domain = ? AND enabled = 1 ORDER BY name`),
    getAll: db.prepare(`
      SELECT * FROM installed_skills ORDER BY name`),
    upsertSubmodule: db.prepare(`
      INSERT INTO skill_submodules (skill_id, module_name, version, config_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(skill_id, module_name) DO UPDATE SET
        version = excluded.version,
        config_json = excluded.config_json`),
    getSubmodules: db.prepare(`
      SELECT * FROM skill_submodules WHERE skill_id = ? ORDER BY module_name`),
    enableSubmodule: db.prepare(`
      UPDATE skill_submodules SET enabled = 1 WHERE skill_id = ? AND module_name = ?`),
    disableSubmodule: db.prepare(`
      UPDATE skill_submodules SET enabled = 0 WHERE skill_id = ? AND module_name = ?`),
    updateConfig: db.prepare(`
      UPDATE installed_skills SET config_json = ?, updated_at = datetime('now')
      WHERE name = ?`),
  };
  return _stmts;
}

// ─── Install Options ────────────────────────────────────────────────

export interface InstallSkillOptions {
  name: string;
  description?: string;
  version?: string;
  domain?: string;
  config?: Record<string, unknown>;
  submodules?: Array<{
    module_name: string;
    version?: string;
    config?: Record<string, unknown>;
  }>;
}

// ─── Registry API ───────────────────────────────────────────────────

/**
 * Install a skill (or update if already installed).
 * Also installs submodules if provided. Returns the installed skill row.
 */
export function install(opts: InstallSkillOptions): InstalledSkillRow {
  const stmts = getStmts();
  const configJson = opts.config ? JSON.stringify(opts.config) : null;

  stmts.upsertSkill.run(
    opts.name,
    opts.description || null,
    opts.version || '1.0.0',
    opts.domain || null,
    configJson,
  );

  const skill = stmts.getByName.get(opts.name) as InstalledSkillRow;

  if (opts.submodules?.length) {
    for (const sub of opts.submodules) {
      const subConfig = sub.config ? JSON.stringify(sub.config) : null;
      stmts.upsertSubmodule.run(
        skill.id,
        sub.module_name,
        sub.version || '1.0.0',
        subConfig,
      );
    }
  }

  logger.info({ skill: opts.name, version: skill.version }, 'Skill installed');
  return skill;
}

/**
 * Install a skill from its manifest. Convenience wrapper around install()
 * that extracts fields from a SkillManifest.
 */
export function installFromManifest(
  manifest: SkillManifest,
  options: { domain?: string; config?: Record<string, unknown> } = {},
): InstalledSkillRow {
  return install({
    name: manifest.id,
    description: manifest.description,
    version: manifest.version,
    domain: options.domain,
    config: options.config,
    submodules: manifest.subModules?.map(sub => ({
      module_name: sub.id,
      version: manifest.version,
      config: undefined,
    })),
  });
}

/**
 * Uninstall a skill by name. Cascade-deletes submodules.
 * Returns true if the skill was found and removed.
 */
export function uninstall(name: string): boolean {
  const stmts = getStmts();
  const result = stmts.deleteSkill.run(name);
  if (result.changes > 0) {
    logger.info({ skill: name }, 'Skill uninstalled');
    return true;
  }
  logger.warn({ skill: name }, 'Skill not found for uninstall');
  return false;
}

/**
 * Enable a skill by name. Returns true if the skill was found and updated.
 */
export function enable(name: string): boolean {
  const stmts = getStmts();
  const result = stmts.enable.run(name);
  if (result.changes > 0) {
    logger.info({ skill: name }, 'Skill enabled');
    return true;
  }
  return false;
}

/**
 * Disable a skill by name (without removing it).
 * Returns true if the skill was found and updated.
 */
export function disable(name: string): boolean {
  const stmts = getStmts();
  const result = stmts.disable.run(name);
  if (result.changes > 0) {
    logger.info({ skill: name }, 'Skill disabled');
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
 * Get a single skill by name (regardless of enabled state).
 */
export function getByName(name: string): InstalledSkillRow | undefined {
  return getStmts().getByName.get(name) as InstalledSkillRow | undefined;
}

/**
 * Get all installed skills (regardless of enabled state).
 */
export function getAll(): InstalledSkillRow[] {
  return getStmts().getAll.all() as InstalledSkillRow[];
}

/**
 * Get submodules for a skill by skill ID.
 */
export function getSubmodules(skillId: number): SkillSubmoduleRow[] {
  return getStmts().getSubmodules.all(skillId) as SkillSubmoduleRow[];
}

/**
 * Enable a specific submodule within a skill.
 */
export function enableSubmodule(skillId: number, moduleName: string): boolean {
  const result = getStmts().enableSubmodule.run(skillId, moduleName);
  return result.changes > 0;
}

/**
 * Disable a specific submodule within a skill.
 */
export function disableSubmodule(skillId: number, moduleName: string): boolean {
  const result = getStmts().disableSubmodule.run(skillId, moduleName);
  return result.changes > 0;
}

/**
 * Update a skill's config JSON.
 */
export function updateConfig(name: string, config: Record<string, unknown>): boolean {
  const result = getStmts().updateConfig.run(JSON.stringify(config), name);
  return result.changes > 0;
}

/**
 * Reset cached prepared statements.
 * Needed when the database connection changes (e.g., in tests).
 */
export function _resetStmts(): void {
  _stmts = null;
}
