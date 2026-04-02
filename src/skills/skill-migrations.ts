// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Namespaced Skill Migrations — run, track, and clean up per-skill schema changes.
 *
 * Each skill can own SQL migrations in `skills/<name>/migrations/` with prefixed
 * naming (e.g., `001_create_tables.sql`). The SkillLoader runs pending migrations
 * on install/update, tracking them in the `skill_migrations` table (created in
 * migration 020). On uninstall, tables owned by the skill can optionally be dropped.
 *
 * Migration file naming convention:
 *   <NNN>_<description>.sql   (e.g., 001_create_weather_cache.sql)
 *
 * Table naming convention for skills:
 *   skill_<skill-name>_<table>  (e.g., skill_weather_cache)
 *   This prefix is used to identify tables owned by a skill during uninstall.
 */

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { logger } from '../utils/logger';

// ── Types ────────────────────────────────────────────────────────────

export interface SkillMigrationResult {
  skillName: string;
  applied: string[];       // migration filenames applied this run
  alreadyApplied: string[];
  errors: Array<{ file: string; error: string }>;
}

export interface SkillTableInfo {
  tableName: string;
  rowCount: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the skill_id to use in skill_migrations table.
 * The skill_migrations FK references installed_skills(id). Migration 019
 * created installed_skills with INTEGER id + TEXT name, while 020 assumed
 * TEXT id. We resolve the name → integer id so the FK is satisfied.
 * Falls back to the name string if the skill isn't installed yet.
 */
function resolveSkillId(db: Database.Database, skillName: string): string {
  try {
    const row = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get(skillName) as { id: number } | undefined;
    return row ? String(row.id) : skillName;
  } catch {
    return skillName;
  }
}

// ── Migration Runner ─────────────────────────────────────────────────

/**
 * Run pending migrations for a skill. Reads SQL files from the skill's
 * migrations directory and applies any not yet tracked in skill_migrations.
 *
 * @param db       The database instance
 * @param skillName  The skill's name (looked up to get its integer id for FK safety)
 * @param migrationsDir  Absolute path to the skill's migrations directory
 * @returns Result object with applied/skipped/errored migrations
 */
export function runSkillMigrations(
  db: Database.Database,
  skillName: string,
  migrationsDir: string,
): SkillMigrationResult {
  const result: SkillMigrationResult = {
    skillName,
    applied: [],
    alreadyApplied: [],
    errors: [],
  };

  if (!fs.existsSync(migrationsDir)) {
    logger.debug({ skill: skillName }, 'No migrations directory — skipping');
    return result;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    return result;
  }

  const skillId = resolveSkillId(db, skillName);

  // Get already-applied migrations for this skill
  const applied = new Set<string>();
  try {
    const rows = db.prepare(
      'SELECT migration_name FROM skill_migrations WHERE skill_id = ?'
    ).all(skillId) as Array<{ migration_name: string }>;
    for (const row of rows) applied.add(row.migration_name);
  } catch {
    // Table may not exist yet — treat all as unapplied
  }

  for (const file of files) {
    if (applied.has(file)) {
      result.alreadyApplied.push(file);
      continue;
    }

    try {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      db.exec(sql);
      db.prepare(
        'INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, ?)'
      ).run(skillId, file);
      result.applied.push(file);
      logger.info({ skill: skillName, migration: file }, 'Skill migration applied');
    } catch (err: any) {
      result.errors.push({ file, error: err?.message ?? String(err) });
      logger.error({ skill: skillName, migration: file, err }, 'Skill migration failed');
      break; // Stop on first error — don't skip migrations
    }
  }

  return result;
}

// ── Applied Migrations Query ─────────────────────────────────────────

/** Get all applied migration names for a skill. */
export function getAppliedMigrations(db: Database.Database, skillName: string): string[] {
  try {
    const skillId = resolveSkillId(db, skillName);
    const rows = db.prepare(
      'SELECT migration_name FROM skill_migrations WHERE skill_id = ? ORDER BY migration_name'
    ).all(skillId) as Array<{ migration_name: string }>;
    return rows.map(r => r.migration_name);
  } catch {
    return [];
  }
}

// ── Table Discovery ──────────────────────────────────────────────────

/**
 * Find tables owned by a skill (matching the `skill_<name>_` prefix convention).
 * Returns table names and row counts for user confirmation before dropping.
 */
export function getSkillTables(db: Database.Database, skillName: string): SkillTableInfo[] {
  const prefix = `skill_${skillName.replace(/-/g, '_')}_`;
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? || '%'"
  ).all(prefix) as Array<{ name: string }>;

  return tables.map(t => {
    let rowCount = 0;
    try {
      const row = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as any;
      rowCount = row?.c ?? 0;
    } catch {
      // table might be in a bad state
    }
    return { tableName: t.name, rowCount };
  });
}

/**
 * Drop all tables owned by a skill and clear its migration history.
 * Should only be called after user confirmation (tables may contain data).
 *
 * @returns Names of tables that were dropped
 */
export function dropSkillTables(db: Database.Database, skillName: string): string[] {
  const tables = getSkillTables(db, skillName);
  const dropped: string[] = [];

  for (const t of tables) {
    try {
      db.exec(`DROP TABLE IF EXISTS "${t.tableName}"`);
      dropped.push(t.tableName);
      logger.info({ skill: skillName, table: t.tableName }, 'Skill table dropped');
    } catch (err: any) {
      logger.error({ skill: skillName, table: t.tableName, err }, 'Failed to drop skill table');
    }
  }

  // Clear migration history
  try {
    const skillId = resolveSkillId(db, skillName);
    db.prepare('DELETE FROM skill_migrations WHERE skill_id = ?').run(skillId);
  } catch {
    // non-critical
  }

  return dropped;
}
