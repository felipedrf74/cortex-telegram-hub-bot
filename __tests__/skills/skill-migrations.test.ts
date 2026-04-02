/**
 * Skill Migrations Tests
 *
 * Tests the namespaced migration runner: applying SQL files from a skill's
 * migrations/ directory, tracking in skill_migrations table, idempotent
 * re-runs, error handling, and table cleanup on uninstall.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

// ── Test helpers ───────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

/** Create a temporary skill directory with migration SQL files. */
function createSkillDir(migrations: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  const migrationsDir = path.join(tmpDir, 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });

  for (const [filename, sql] of Object.entries(migrations)) {
    fs.writeFileSync(path.join(migrationsDir, filename), sql);
  }

  return tmpDir;
}

// ── Mock getDb + logger ───────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER mocks
import {
  runSkillMigrations,
  getAppliedMigrations,
  getSkillTables,
  dropSkillTables,
} from '../../src/skills/skill-migrations';

import {
  install,
  uninstall,
  listSkillTables,
  listSkillMigrations,
} from '../../src/skills/registry';

/** Helper: ensure a skill exists in installed_skills so FK constraints pass. */
function ensureSkillInstalled(db: Database.Database, name: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO installed_skills (name, version) VALUES (?, '1.0.0')
  `).run(name);
}

// ═══════════════════════════════════════════════════════════════════
// CORE MIGRATION RUNNER
// ═══════════════════════════════════════════════════════════════════

describe('Skill Migrations — runSkillMigrations()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
    testDb = db;
  });
  afterEach(() => { db.close(); });

  it('applies all pending migrations in order', () => {
    ensureSkillInstalled(db, 'weather');
    const skillDir = createSkillDir({
      '001_create_cache.sql': `
        CREATE TABLE IF NOT EXISTS skill_weather_cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          city TEXT NOT NULL,
          temp_c REAL,
          fetched_at TEXT DEFAULT (datetime('now'))
        );`,
      '002_add_humidity.sql': `
        ALTER TABLE skill_weather_cache ADD COLUMN humidity REAL;`,
    });

    const result = runSkillMigrations(db, 'weather', path.join(skillDir, 'migrations'));

    expect(result.applied).toEqual(['001_create_cache.sql', '002_add_humidity.sql']);
    expect(result.alreadyApplied).toEqual([]);
    expect(result.errors).toEqual([]);

    // Verify table exists with both columns
    const info = db.prepare("PRAGMA table_info('skill_weather_cache')").all() as any[];
    const colNames = info.map(c => c.name);
    expect(colNames).toContain('city');
    expect(colNames).toContain('humidity');
  });

  it('skips already-applied migrations on re-run', () => {
    ensureSkillInstalled(db, 'notes');
    const skillDir = createSkillDir({
      '001_create_table.sql': `
        CREATE TABLE IF NOT EXISTS skill_notes_data (
          id INTEGER PRIMARY KEY, content TEXT
        );`,
    });

    const migrationsDir = path.join(skillDir, 'migrations');

    // First run
    const first = runSkillMigrations(db, 'notes', migrationsDir);
    expect(first.applied).toHaveLength(1);

    // Second run — idempotent
    const second = runSkillMigrations(db, 'notes', migrationsDir);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toEqual(['001_create_table.sql']);
  });

  it('stops on first error and reports it', () => {
    ensureSkillInstalled(db, 'bad-skill');
    const skillDir = createSkillDir({
      '001_ok.sql': 'CREATE TABLE IF NOT EXISTS skill_bad_first (id INTEGER PRIMARY KEY);',
      '002_broken.sql': 'THIS IS NOT VALID SQL;',
      '003_never_reached.sql': 'CREATE TABLE IF NOT EXISTS skill_bad_third (id INTEGER PRIMARY KEY);',
    });

    const result = runSkillMigrations(db, 'bad-skill', path.join(skillDir, 'migrations'));

    expect(result.applied).toEqual(['001_ok.sql']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('002_broken.sql');
    expect(result.errors[0].error).toBeTruthy();

    // Third migration was NOT applied
    const applied = getAppliedMigrations(db, 'bad-skill');
    expect(applied).toEqual(['001_ok.sql']);
  });

  it('returns empty result when migrations dir does not exist', () => {
    const result = runSkillMigrations(db, 'ghost', '/nonexistent/path');

    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns empty result when migrations dir is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-empty-'));
    const migrationsDir = path.join(tmpDir, 'migrations');
    fs.mkdirSync(migrationsDir);

    const result = runSkillMigrations(db, 'empty-skill', migrationsDir);
    expect(result.applied).toEqual([]);
  });

  it('only processes .sql files (ignores others)', () => {
    ensureSkillInstalled(db, 'filter');
    const skillDir = createSkillDir({
      '001_create.sql': 'CREATE TABLE IF NOT EXISTS skill_filter_test (id INTEGER PRIMARY KEY);',
    });
    // Add a non-SQL file
    fs.writeFileSync(path.join(skillDir, 'migrations', 'README.md'), '# Notes');

    const result = runSkillMigrations(db, 'filter', path.join(skillDir, 'migrations'));
    expect(result.applied).toEqual(['001_create.sql']);
  });

  it('isolates migrations between different skills', () => {
    ensureSkillInstalled(db, 'alpha');
    ensureSkillInstalled(db, 'beta');
    const skillA = createSkillDir({
      '001_init.sql': 'CREATE TABLE IF NOT EXISTS skill_alpha_data (id INTEGER PRIMARY KEY);',
    });
    const skillB = createSkillDir({
      '001_init.sql': 'CREATE TABLE IF NOT EXISTS skill_beta_data (id INTEGER PRIMARY KEY);',
    });

    runSkillMigrations(db, 'alpha', path.join(skillA, 'migrations'));
    runSkillMigrations(db, 'beta', path.join(skillB, 'migrations'));

    expect(getAppliedMigrations(db, 'alpha')).toEqual(['001_init.sql']);
    expect(getAppliedMigrations(db, 'beta')).toEqual(['001_init.sql']);

    // Both tables exist independently
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_%_data'"
    ).all() as any[];
    expect(tables).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TABLE DISCOVERY AND CLEANUP
// ═══════════════════════════════════════════════════════════════════

describe('Skill Migrations — table discovery and cleanup', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
    testDb = db;
  });
  afterEach(() => { db.close(); });

  it('getSkillTables() finds tables matching skill prefix', () => {
    db.exec('CREATE TABLE skill_weather_cache (id INTEGER PRIMARY KEY);');
    db.exec('CREATE TABLE skill_weather_forecast (id INTEGER PRIMARY KEY);');
    db.exec('CREATE TABLE skill_other_data (id INTEGER PRIMARY KEY);');

    const tables = getSkillTables(db, 'weather');

    expect(tables).toHaveLength(2);
    expect(tables.map(t => t.tableName).sort()).toEqual([
      'skill_weather_cache', 'skill_weather_forecast',
    ]);
  });

  it('getSkillTables() returns row counts', () => {
    db.exec('CREATE TABLE skill_counter_data (id INTEGER PRIMARY KEY, val TEXT);');
    db.prepare('INSERT INTO skill_counter_data (val) VALUES (?)').run('a');
    db.prepare('INSERT INTO skill_counter_data (val) VALUES (?)').run('b');

    const tables = getSkillTables(db, 'counter');
    expect(tables).toHaveLength(1);
    expect(tables[0].rowCount).toBe(2);
  });

  it('getSkillTables() normalizes hyphens to underscores', () => {
    db.exec('CREATE TABLE skill_my_cool_data (id INTEGER PRIMARY KEY);');

    const tables = getSkillTables(db, 'my-cool');
    expect(tables).toHaveLength(1);
    expect(tables[0].tableName).toBe('skill_my_cool_data');
  });

  it('dropSkillTables() drops all skill-owned tables', () => {
    ensureSkillInstalled(db, 'doomed');
    db.exec('CREATE TABLE skill_doomed_cache (id INTEGER PRIMARY KEY);');
    db.exec('CREATE TABLE skill_doomed_log (id INTEGER PRIMARY KEY);');

    // Add migration tracking (use integer id from installed_skills)
    const skill = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get('doomed') as any;
    db.prepare('INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, ?)').run(String(skill.id), '001_init.sql');

    const dropped = dropSkillTables(db, 'doomed');

    expect(dropped.sort()).toEqual(['skill_doomed_cache', 'skill_doomed_log']);

    // Tables no longer exist
    const remaining = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'skill_doomed_%'"
    ).all();
    expect(remaining).toHaveLength(0);

    // Migration history cleared
    const migrations = getAppliedMigrations(db, 'doomed');
    expect(migrations).toEqual([]);
  });

  it('dropSkillTables() does nothing when no tables match', () => {
    const dropped = dropSkillTables(db, 'nonexistent');
    expect(dropped).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// REGISTRY INTEGRATION
// ═══════════════════════════════════════════════════════════════════

describe('Skill Migrations — registry integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
    testDb = db;
  });
  afterEach(() => { db.close(); });

  it('install() runs skill migrations when skillDir is provided', () => {
    const skillDir = createSkillDir({
      '001_init.sql': `
        CREATE TABLE IF NOT EXISTS skill_integrated_data (
          id INTEGER PRIMARY KEY, payload TEXT
        );`,
    });

    install({
      name: 'integrated',
      version: '1.0.0',
      skillDir,
    });

    // Table was created by migration
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_integrated_data'"
    ).get();
    expect(table).toBeTruthy();

    // Migration tracked
    const applied = listSkillMigrations('integrated');
    expect(applied).toEqual(['001_init.sql']);
  });

  it('install() skips migrations when no skillDir provided', () => {
    install({ name: 'no-migrations', version: '1.0.0' });

    const applied = listSkillMigrations('no-migrations');
    expect(applied).toEqual([]);
  });

  it('uninstall() with dropTables removes skill-owned tables', () => {
    const skillDir = createSkillDir({
      '001_init.sql': 'CREATE TABLE IF NOT EXISTS skill_removable_cache (id INTEGER PRIMARY KEY, data TEXT);',
    });

    install({ name: 'removable', version: '1.0.0', skillDir });

    // Verify table exists
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_removable_cache'").get()).toBeTruthy();

    uninstall('removable', { dropTables: true });

    // Table is gone
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_removable_cache'").get()).toBeFalsy();
  });

  it('uninstall() without dropTables preserves skill-owned tables', () => {
    const skillDir = createSkillDir({
      '001_init.sql': 'CREATE TABLE IF NOT EXISTS skill_preserved_data (id INTEGER PRIMARY KEY);',
    });

    install({ name: 'preserved', version: '1.0.0', skillDir });
    uninstall('preserved');

    // Table still exists
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'skill_preserved_data'").get()).toBeTruthy();
  });

  it('listSkillTables() returns table info through registry', () => {
    db.exec('CREATE TABLE skill_query_test_items (id INTEGER PRIMARY KEY);');
    db.prepare('INSERT INTO skill_query_test_items (id) VALUES (?)').run(1);

    install({ name: 'query-test', version: '1.0.0' });

    const tables = listSkillTables('query-test');
    expect(tables).toHaveLength(1);
    expect(tables[0].tableName).toBe('skill_query_test_items');
    expect(tables[0].rowCount).toBe(1);
  });

  it('update (re-install) runs only new migrations', () => {
    const skillDir = createSkillDir({
      '001_init.sql': 'CREATE TABLE IF NOT EXISTS skill_evolving_data (id INTEGER PRIMARY KEY);',
    });

    // Initial install
    install({ name: 'evolving', version: '1.0.0', skillDir });
    expect(listSkillMigrations('evolving')).toEqual(['001_init.sql']);

    // Add a second migration
    fs.writeFileSync(
      path.join(skillDir, 'migrations', '002_add_column.sql'),
      'ALTER TABLE skill_evolving_data ADD COLUMN extra TEXT;'
    );

    // Re-install (update)
    install({ name: 'evolving', version: '1.1.0', skillDir });
    expect(listSkillMigrations('evolving')).toEqual(['001_init.sql', '002_add_column.sql']);

    // Column exists
    const info = db.prepare("PRAGMA table_info('skill_evolving_data')").all() as any[];
    expect(info.map(c => c.name)).toContain('extra');
  });
});
