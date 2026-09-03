// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import { logger } from '../utils/logger';
import type { InstalledSkill, SkillSubmodule } from '../domains/types';
import { getSkillDefinition } from './skill-config';

function canonicalInstalledSkillName(name: string): string {
  const normalized = name.trim();
  return normalized === 'training' ? 'triathlon' : normalized;
}

// ── Install / Uninstall ────────────────────────────────────────────

export interface InstallSkillOptions {
  name: string;
  description?: string;
  version?: string;
  domain?: string;
  config?: Record<string, unknown>;
  submodules?: Array<{ module_name: string; version?: string; config?: Record<string, unknown> }>;
}

/** Install a skill (or update if already installed). Returns the installed skill row. */
export function install(opts: InstallSkillOptions): InstalledSkill {
  const db = getDb();
  const configJson = opts.config ? JSON.stringify(opts.config) : null;

  db.prepare(`
    INSERT INTO installed_skills (name, description, version, domain, config_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      version = excluded.version,
      domain = excluded.domain,
      config_json = excluded.config_json,
      updated_at = datetime('now')
  `).run(
    opts.name,
    opts.description || null,
    opts.version || '1.0.0',
    opts.domain || null,
    configJson,
  );

  const skill = db.prepare('SELECT * FROM installed_skills WHERE name = ?').get(opts.name) as InstalledSkill;

  // Install submodules if provided
  if (opts.submodules?.length) {
    for (const sub of opts.submodules) {
      const subConfig = sub.config ? JSON.stringify(sub.config) : null;
      db.prepare(`
        INSERT INTO skill_submodules (skill_id, module_name, version, config_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(skill_id, module_name) DO UPDATE SET
          version = excluded.version,
          config_json = excluded.config_json
      `).run(skill.id, sub.module_name, sub.version || '1.0.0', subConfig);
    }
  }

  logger.info({ skill: opts.name, version: skill.version }, 'Skill installed');
  return skill;
}

/** Uninstall a skill by name. Cascade-deletes submodules. Returns true if removed. */
export function uninstall(name: string): boolean {
  const db = getDb();
  const skillName = canonicalInstalledSkillName(name);
  const result = db.prepare('DELETE FROM installed_skills WHERE name = ?').run(skillName);
  if (result.changes > 0) {
    logger.info({ skill: skillName }, 'Skill uninstalled');
  }
  return result.changes > 0;
}

// ── Enable / Disable ───────────────────────────────────────────────

/** Enable a skill by name. Returns true if the skill was found and updated. */
export function enable(name: string): boolean {
  const db = getDb();
  const skillName = canonicalInstalledSkillName(name);
  const result = db.prepare(
    "UPDATE installed_skills SET enabled = 1, updated_at = datetime('now') WHERE name = ?"
  ).run(skillName);
  return result.changes > 0;
}

/** Disable a skill by name. Returns true if the skill was found and updated. */
export function disable(name: string): boolean {
  const db = getDb();
  const skillName = canonicalInstalledSkillName(name);
  const result = db.prepare(
    "UPDATE installed_skills SET enabled = 0, updated_at = datetime('now') WHERE name = ?"
  ).run(skillName);
  return result.changes > 0;
}

// ── Submodule Enable / Disable ─────────────────────────────────────

/** Enable a submodule by skill name and module name. Returns true if found and updated. */
export function enableSubmodule(skillName: string, moduleName: string): boolean {
  const db = getDb();
  const canonicalSkillName = canonicalInstalledSkillName(skillName);
  const skill = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get(canonicalSkillName) as { id: number } | undefined;
  if (!skill) return false;
  const result = db.prepare(
    'UPDATE skill_submodules SET enabled = 1 WHERE skill_id = ? AND module_name = ?'
  ).run(skill.id, moduleName);
  return result.changes > 0;
}

/** Disable a submodule by skill name and module name. Returns true if found and updated. */
export function disableSubmodule(skillName: string, moduleName: string): boolean {
  const db = getDb();
  const canonicalSkillName = canonicalInstalledSkillName(skillName);
  const skill = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get(canonicalSkillName) as { id: number } | undefined;
  if (!skill) return false;
  const result = db.prepare(
    'UPDATE skill_submodules SET enabled = 0 WHERE skill_id = ? AND module_name = ?'
  ).run(skill.id, moduleName);
  return result.changes > 0;
}

/** Get all enabled submodule names for a skill. */
export function getEnabledSubmodules(skillName: string): string[] {
  const db = getDb();
  const canonicalSkillName = canonicalInstalledSkillName(skillName);
  const skill = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get(canonicalSkillName) as { id: number } | undefined;
  if (!skill) {
    return configuredSubSkills(canonicalSkillName)
      .filter((sub) => sub.enabledByDefault)
      .map((sub) => sub.name);
  }
  const rows = db.prepare(
    'SELECT module_name, enabled FROM skill_submodules WHERE skill_id = ? ORDER BY module_name'
  ).all(skill.id) as Array<{ module_name: string; enabled: number }>;
  const persisted = new Map(rows.map((row) => [row.module_name, row.enabled === 1]));
  const enabled = new Set(rows.filter((row) => row.enabled === 1).map((row) => row.module_name));
  for (const sub of configuredSubSkills(canonicalSkillName)) {
    if (!persisted.has(sub.name) && sub.enabledByDefault) enabled.add(sub.name);
  }
  return [...enabled].sort();
}

/** Check if a specific submodule is enabled. */
export function isSubmoduleEnabled(skillName: string, moduleName: string): boolean {
  const db = getDb();
  const canonicalSkillName = canonicalInstalledSkillName(skillName);
  const row = db.prepare(`
    SELECT sm.enabled FROM skill_submodules sm
    JOIN installed_skills s ON s.id = sm.skill_id
    WHERE s.name = ? AND sm.module_name = ?
  `).get(canonicalSkillName, moduleName) as { enabled: number } | undefined;
  if (row) return row.enabled === 1;
  // A missing skill/submodule row is degraded registry state. Preserve the
  // declarative default instead of manufacturing an enabled capability.
  return configuredSubSkills(canonicalSkillName)
    .find((sub) => sub.name === moduleName)?.enabledByDefault ?? false;
}

function configuredSubSkills(skillName: string): Array<{ name: string; enabledByDefault: boolean }> {
  return getSkillDefinition(skillName)?.subSkills ?? [];
}

// ── Queries ────────────────────────────────────────────────────────

/** Get all enabled skills, optionally filtered by domain. */
export function getEnabled(domain?: string): InstalledSkill[] {
  const db = getDb();
  if (domain) {
    return db.prepare(
      'SELECT * FROM installed_skills WHERE enabled = 1 AND domain = ? ORDER BY name'
    ).all(domain) as InstalledSkill[];
  }
  return db.prepare(
    'SELECT * FROM installed_skills WHERE enabled = 1 ORDER BY name'
  ).all() as InstalledSkill[];
}

/** Get all skills for a specific domain (both enabled and disabled). */
export function getByDomain(domain: string): InstalledSkill[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM installed_skills WHERE domain = ? ORDER BY name'
  ).all(domain) as InstalledSkill[];
}

/** Get a single skill by name. Returns undefined if not found. */
export function getByName(name: string): InstalledSkill | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM installed_skills WHERE name = ?').get(canonicalInstalledSkillName(name)) as InstalledSkill | undefined;
}

/** Get all installed skills (enabled and disabled). */
export function getAll(): InstalledSkill[] {
  const db = getDb();
  return db.prepare('SELECT * FROM installed_skills ORDER BY name').all() as InstalledSkill[];
}

/** Get submodules for a skill by skill ID. */
export function getSubmodules(skillId: number): SkillSubmodule[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM skill_submodules WHERE skill_id = ? ORDER BY module_name'
  ).all(skillId) as SkillSubmodule[];
}
