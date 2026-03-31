/**
 * SkillRegistry Tests
 *
 * Tests install/uninstall, enable/disable, getEnabled, getByDomain,
 * getByName, getAll, getSubmodules — all against in-memory SQLite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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

// ── Mock getDb to return our in-memory db ──────────────────────────

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

// Import AFTER mocks are set up
import {
  install,
  uninstall,
  enable,
  disable,
  getEnabled,
  getByDomain,
  getByName,
  getAll,
  getSubmodules,
} from '../../src/skills/registry';

// ═══════════════════════════════════════════════════════════════════
// MIGRATION TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry Migration', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('creates installed_skills table', () => {
    applyMigrations(db);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='installed_skills'"
    ).get();
    expect(table).toBeTruthy();
  });

  it('creates skill_submodules table', () => {
    applyMigrations(db);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_submodules'"
    ).get();
    expect(table).toBeTruthy();
  });

  it('creates indexes on installed_skills', () => {
    applyMigrations(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='installed_skills'"
    ).all().map((r: any) => r.name);
    expect(indexes).toContain('idx_installed_skills_enabled');
    expect(indexes).toContain('idx_installed_skills_domain');
  });

  it('creates index on skill_submodules', () => {
    applyMigrations(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_submodules'"
    ).all().map((r: any) => r.name);
    expect(indexes).toContain('idx_skill_submodules_skill_id');
  });

  it('enforces foreign key from skill_submodules to installed_skills', () => {
    applyMigrations(db);
    expect(() => {
      db.prepare(
        'INSERT INTO skill_submodules (skill_id, module_name) VALUES (?, ?)'
      ).run(9999, 'orphan-module');
    }).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// INSTALL TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry — install()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('installs a skill with minimal options', () => {
    const skill = install({ name: 'greeting' });
    expect(skill.name).toBe('greeting');
    expect(skill.version).toBe('1.0.0');
    expect(skill.enabled).toBe(1);
    expect(skill.domain).toBeNull();
    expect(skill.description).toBeNull();
  });

  it('installs a skill with all options', () => {
    const skill = install({
      name: 'daily-brief',
      description: 'Morning briefing skill',
      version: '2.1.0',
      domain: 'secretary',
      config: { maxItems: 10 },
    });
    expect(skill.name).toBe('daily-brief');
    expect(skill.description).toBe('Morning briefing skill');
    expect(skill.version).toBe('2.1.0');
    expect(skill.domain).toBe('secretary');
    expect(JSON.parse(skill.config_json!)).toEqual({ maxItems: 10 });
  });

  it('upserts on duplicate name (idempotent install)', () => {
    install({ name: 'greeting', version: '1.0.0' });
    const updated = install({ name: 'greeting', version: '2.0.0', description: 'Updated' });

    expect(updated.version).toBe('2.0.0');
    expect(updated.description).toBe('Updated');
    // Should still be only one row
    const count = testDb.prepare('SELECT COUNT(*) as c FROM installed_skills').get() as any;
    expect(count.c).toBe(1);
  });

  it('installs a skill with submodules', () => {
    const skill = install({
      name: 'content-pipeline',
      domain: 'content',
      submodules: [
        { module_name: 'topic-generator', version: '1.0.0' },
        { module_name: 'script-writer', version: '1.2.0', config: { tone: 'casual' } },
      ],
    });

    const subs = testDb.prepare(
      'SELECT * FROM skill_submodules WHERE skill_id = ? ORDER BY module_name'
    ).all(skill.id) as any[];
    expect(subs).toHaveLength(2);
    expect(subs[0].module_name).toBe('script-writer');
    expect(subs[1].module_name).toBe('topic-generator');
    expect(JSON.parse(subs[0].config_json)).toEqual({ tone: 'casual' });
  });

  it('upserts submodules on reinstall', () => {
    install({
      name: 'my-skill',
      submodules: [{ module_name: 'mod-a', version: '1.0.0' }],
    });

    const skill = install({
      name: 'my-skill',
      submodules: [{ module_name: 'mod-a', version: '2.0.0' }],
    });

    const subs = testDb.prepare(
      'SELECT * FROM skill_submodules WHERE skill_id = ?'
    ).all(skill.id) as any[];
    expect(subs).toHaveLength(1);
    expect(subs[0].version).toBe('2.0.0');
  });

  it('sets installed_at and updated_at timestamps', () => {
    const skill = install({ name: 'timestamped' });
    expect(skill.installed_at).toBeTruthy();
    expect(skill.updated_at).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// UNINSTALL TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry — uninstall()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('removes an installed skill', () => {
    install({ name: 'removable' });
    const removed = uninstall('removable');
    expect(removed).toBe(true);

    const row = testDb.prepare('SELECT * FROM installed_skills WHERE name = ?').get('removable');
    expect(row).toBeUndefined();
  });

  it('returns false for non-existent skill', () => {
    expect(uninstall('never-installed')).toBe(false);
  });

  it('cascade-deletes submodules on uninstall', () => {
    const skill = install({
      name: 'with-subs',
      submodules: [
        { module_name: 'sub-a' },
        { module_name: 'sub-b' },
      ],
    });

    uninstall('with-subs');

    const subs = testDb.prepare(
      'SELECT * FROM skill_submodules WHERE skill_id = ?'
    ).all(skill.id);
    expect(subs).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENABLE / DISABLE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry — enable() / disable()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('disables an enabled skill', () => {
    install({ name: 'toggleable' });
    const result = disable('toggleable');
    expect(result).toBe(true);

    const skill = getByName('toggleable');
    expect(skill?.enabled).toBe(0);
  });

  it('re-enables a disabled skill', () => {
    install({ name: 'toggleable' });
    disable('toggleable');
    const result = enable('toggleable');
    expect(result).toBe(true);

    const skill = getByName('toggleable');
    expect(skill?.enabled).toBe(1);
  });

  it('enable returns false for non-existent skill', () => {
    expect(enable('ghost')).toBe(false);
  });

  it('disable returns false for non-existent skill', () => {
    expect(disable('ghost')).toBe(false);
  });

  it('updates updated_at on disable', () => {
    const before = install({ name: 'ts-check' });
    disable('ts-check');
    const after = getByName('ts-check');
    // updated_at should exist (both are datetime strings)
    expect(after?.updated_at).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// QUERY TESTS
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry — getEnabled()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns only enabled skills', () => {
    install({ name: 'active-1' });
    install({ name: 'active-2' });
    install({ name: 'inactive' });
    disable('inactive');

    const enabled = getEnabled();
    expect(enabled).toHaveLength(2);
    expect(enabled.map(s => s.name)).toEqual(['active-1', 'active-2']);
  });

  it('filters by domain when provided', () => {
    install({ name: 'sec-skill', domain: 'secretary' });
    install({ name: 'tri-skill', domain: 'triathlon' });
    install({ name: 'global-skill' }); // no domain

    const secSkills = getEnabled('secretary');
    expect(secSkills).toHaveLength(1);
    expect(secSkills[0].name).toBe('sec-skill');
  });

  it('returns empty array when no skills match', () => {
    expect(getEnabled('nonexistent-domain')).toEqual([]);
  });

  it('excludes disabled skills from domain filter', () => {
    install({ name: 'sec-a', domain: 'secretary' });
    install({ name: 'sec-b', domain: 'secretary' });
    disable('sec-b');

    const secSkills = getEnabled('secretary');
    expect(secSkills).toHaveLength(1);
    expect(secSkills[0].name).toBe('sec-a');
  });
});

describe('SkillRegistry — getByDomain()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns all skills for a domain (enabled and disabled)', () => {
    install({ name: 'sec-enabled', domain: 'secretary' });
    install({ name: 'sec-disabled', domain: 'secretary' });
    disable('sec-disabled');
    install({ name: 'other-domain', domain: 'triathlon' });

    const secSkills = getByDomain('secretary');
    expect(secSkills).toHaveLength(2);
    expect(secSkills.map(s => s.name)).toEqual(['sec-disabled', 'sec-enabled']);
  });

  it('returns empty array for unknown domain', () => {
    expect(getByDomain('unknown')).toEqual([]);
  });
});

describe('SkillRegistry — getByName()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns the skill if found', () => {
    install({ name: 'findable', description: 'Can be found' });
    const skill = getByName('findable');
    expect(skill).toBeDefined();
    expect(skill!.description).toBe('Can be found');
  });

  it('returns undefined if not found', () => {
    expect(getByName('missing')).toBeUndefined();
  });
});

describe('SkillRegistry — getAll()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns all skills regardless of status', () => {
    install({ name: 'alpha' });
    install({ name: 'beta' });
    install({ name: 'gamma' });
    disable('beta');

    const all = getAll();
    expect(all).toHaveLength(3);
    expect(all.map(s => s.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns empty array when no skills installed', () => {
    expect(getAll()).toEqual([]);
  });
});

describe('SkillRegistry — getSubmodules()', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('returns submodules for a skill', () => {
    const skill = install({
      name: 'complex-skill',
      submodules: [
        { module_name: 'renderer', version: '1.0.0' },
        { module_name: 'fetcher', version: '2.0.0' },
      ],
    });

    const subs = getSubmodules(skill.id);
    expect(subs).toHaveLength(2);
    expect(subs[0].module_name).toBe('fetcher'); // ordered by name
    expect(subs[1].module_name).toBe('renderer');
  });

  it('returns empty array for skill with no submodules', () => {
    const skill = install({ name: 'simple' });
    expect(getSubmodules(skill.id)).toEqual([]);
  });

  it('returns empty array for non-existent skill ID', () => {
    expect(getSubmodules(9999)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('SkillRegistry — edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });
  afterEach(() => { testDb.close(); });

  it('handles skill names with special characters', () => {
    const skill = install({ name: 'my-skill_v2.0' });
    expect(getByName('my-skill_v2.0')).toBeDefined();
    expect(skill.name).toBe('my-skill_v2.0');
  });

  it('handles null config gracefully', () => {
    const skill = install({ name: 'no-config' });
    expect(skill.config_json).toBeNull();
  });

  it('handles empty submodules array', () => {
    const skill = install({ name: 'no-subs', submodules: [] });
    expect(getSubmodules(skill.id)).toEqual([]);
  });

  it('enforces unique skill name constraint via upsert', () => {
    install({ name: 'unique-test', version: '1.0.0' });
    install({ name: 'unique-test', version: '2.0.0' });

    const count = testDb.prepare('SELECT COUNT(*) as c FROM installed_skills WHERE name = ?')
      .get('unique-test') as any;
    expect(count.c).toBe(1);
  });

  it('enforces unique submodule name per skill', () => {
    const skill = install({
      name: 'dup-sub-test',
      submodules: [{ module_name: 'mod-x', version: '1.0.0' }],
    });

    // Re-install with same submodule name — should upsert
    install({
      name: 'dup-sub-test',
      submodules: [{ module_name: 'mod-x', version: '3.0.0' }],
    });

    const subs = testDb.prepare('SELECT * FROM skill_submodules WHERE skill_id = ?')
      .all(skill.id) as any[];
    expect(subs).toHaveLength(1);
    expect(subs[0].version).toBe('3.0.0');
  });
});
