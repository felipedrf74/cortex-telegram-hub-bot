/**
 * QA Validation Tests — Skill Database Migrations
 *
 * Validates the schema created by migrations 019+020:
 * - installed_skills table with correct columns and constraints
 * - skill_submodules table with FK to installed_skills
 * - skill_credentials table with encrypted_value column
 * - skill_migrations tracking table
 * - Indexes exist
 * - CASCADE delete behavior
 * - IF NOT EXISTS safety (migrations 019 and 020 overlap safely)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

describe('Skill Database Migrations QA Validation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── Table existence ──────────────────────────────────────────────

  describe('table existence', () => {
    it('installed_skills table exists', () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='installed_skills'"
      ).get() as any;
      expect(row).toBeDefined();
      expect(row.name).toBe('installed_skills');
    });

    it('skill_submodules table exists', () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_submodules'"
      ).get() as any;
      expect(row).toBeDefined();
    });

    it('skill_credentials table exists', () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_credentials'"
      ).get() as any;
      expect(row).toBeDefined();
    });

    it('skill_migrations table exists', () => {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_migrations'"
      ).get() as any;
      expect(row).toBeDefined();
    });
  });

  // ── installed_skills schema ──────────────────────────────────────

  describe('installed_skills schema', () => {
    it('has required columns', () => {
      const cols = db.prepare("PRAGMA table_info('installed_skills')").all() as any[];
      const colNames = cols.map(c => c.name);
      expect(colNames).toContain('id');
      expect(colNames).toContain('version');
      expect(colNames).toContain('enabled');
    });

    it('enabled column defaults to 1', () => {
      db.prepare("INSERT INTO installed_skills (name, version) VALUES ('test_skill', '1.0.0')").run();
      const row = db.prepare("SELECT enabled FROM installed_skills WHERE name = 'test_skill'").get() as any;
      expect(row.enabled).toBe(1);
    });

    it('name must be unique', () => {
      db.prepare("INSERT INTO installed_skills (name, version) VALUES ('unique_skill', '1.0.0')").run();
      expect(() => {
        db.prepare("INSERT INTO installed_skills (name, version) VALUES ('unique_skill', '2.0.0')").run();
      }).toThrow();
    });

    it('installed_at defaults to current datetime', () => {
      db.prepare("INSERT INTO installed_skills (name, version) VALUES ('ts_skill', '1.0.0')").run();
      const row = db.prepare("SELECT installed_at FROM installed_skills WHERE name = 'ts_skill'").get() as any;
      expect(row.installed_at).toBeTruthy();
      // Should be ISO-ish date string
      expect(row.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });
  });

  // ── skill_submodules FK ────────────────────────────────────────

  describe('skill_submodules foreign key', () => {
    it('can insert submodule for existing skill', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('fk_skill', '1.0.0')").run();
      const skillId = info.lastInsertRowid;
      expect(() => {
        db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub1', '1.0.0')").run(skillId);
      }).not.toThrow();
    });

    it('submodule enabled defaults to 1', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('def_skill', '1.0.0')").run();
      db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub1', '1.0.0')").run(info.lastInsertRowid);
      const row = db.prepare("SELECT enabled FROM skill_submodules WHERE module_name = 'sub1'").get() as any;
      expect(row.enabled).toBe(1);
    });

    it('unique constraint on (skill_id, module_name)', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('dup_skill', '1.0.0')").run();
      const sid = info.lastInsertRowid;
      db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub1', '1.0.0')").run(sid);
      expect(() => {
        db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub1', '2.0.0')").run(sid);
      }).toThrow();
    });
  });

  // ── CASCADE delete ──────────────────────────────────────────────

  describe('CASCADE delete behavior', () => {
    it('deleting a skill cascades to submodules', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('cascade_skill', '1.0.0')").run();
      const sid = info.lastInsertRowid;
      db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub_a', '1.0.0')").run(sid);
      db.prepare("INSERT INTO skill_submodules (skill_id, module_name, version) VALUES (?, 'sub_b', '1.0.0')").run(sid);

      // Verify submodules exist
      const before = db.prepare("SELECT COUNT(*) as cnt FROM skill_submodules WHERE skill_id = ?").get(sid) as any;
      expect(before.cnt).toBe(2);

      // Delete parent
      db.prepare("DELETE FROM installed_skills WHERE id = ?").run(sid);

      // Submodules should be gone
      const after = db.prepare("SELECT COUNT(*) as cnt FROM skill_submodules WHERE skill_id = ?").get(sid) as any;
      expect(after.cnt).toBe(0);
    });
  });

  // ── skill_credentials ─────────────────────────────────────────

  describe('skill_credentials table', () => {
    it('can store encrypted credentials', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('cred_skill', '1.0.0')").run();
      const skillId = String(info.lastInsertRowid);
      expect(() => {
        db.prepare(
          "INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, 'api_key', 'enc_abc123')"
        ).run(skillId);
      }).not.toThrow();

      const row = db.prepare(
        "SELECT encrypted_value FROM skill_credentials WHERE skill_id = ? AND key_name = 'api_key'"
      ).get(skillId) as any;
      expect(row.encrypted_value).toBe('enc_abc123');
    });

    it('primary key is (skill_id, key_name)', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('dup_cred', '1.0.0')").run();
      const skillId = String(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, 'key1', 'val1')"
      ).run(skillId);
      expect(() => {
        db.prepare(
          "INSERT INTO skill_credentials (skill_id, key_name, encrypted_value) VALUES (?, 'key1', 'val2')"
        ).run(skillId);
      }).toThrow();
    });
  });

  // ── skill_migrations tracking ────────────────────────────────

  describe('skill_migrations tracking', () => {
    it('can track skill-level migrations', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('mig_skill', '1.0.0')").run();
      const skillId = String(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, '001_initial')"
      ).run(skillId);

      const row = db.prepare(
        "SELECT migration_name, applied_at FROM skill_migrations WHERE skill_id = ?"
      ).get(skillId) as any;
      expect(row.migration_name).toBe('001_initial');
      expect(row.applied_at).toBeTruthy();
    });

    it('primary key is (skill_id, migration_name)', () => {
      const info = db.prepare("INSERT INTO installed_skills (name, version) VALUES ('mig_dup', '1.0.0')").run();
      const skillId = String(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, '001_init')"
      ).run(skillId);
      expect(() => {
        db.prepare(
          "INSERT INTO skill_migrations (skill_id, migration_name) VALUES (?, '001_init')"
        ).run(skillId);
      }).toThrow();
    });
  });

  // ── Index existence ──────────────────────────────────────────────

  describe('indexes', () => {
    it('has index on installed_skills.enabled', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='installed_skills'"
      ).all() as any[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames.some(n => n.includes('enabled'))).toBe(true);
    });

    it('has index on skill_submodules.skill_id', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='skill_submodules'"
      ).all() as any[];
      const indexNames = indexes.map(i => i.name);
      expect(indexNames.some(n => n.includes('skill'))).toBe(true);
    });
  });

  // ── Migration files exist ────────────────────────────────────────

  describe('migration files on disk', () => {
    it('019_installed_skills.sql exists', () => {
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, '019_installed_skills.sql'))).toBe(true);
    });

    it('020_skill_tables.sql exists', () => {
      expect(fs.existsSync(path.join(MIGRATIONS_DIR, '020_skill_tables.sql'))).toBe(true);
    });

    it('all migrations apply without errors', () => {
      // This is implicitly tested by applyMigrations in beforeEach,
      // but let's be explicit with a fresh db
      const freshDb = createTestDb();
      expect(() => applyMigrations(freshDb)).not.toThrow();
      freshDb.close();
    });
  });
});
