/**
 * Portal Skill Management API Tests
 *
 * Tests the skill management endpoints used by the portal UI:
 * GET /api/skills, POST /api/skills/:name/enable|disable,
 * POST /api/skills/:name/subskills/:sub/enable|disable.
 *
 * Uses in-memory SQLite + the actual skill-manager and registry modules.
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

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// Mock getDb to return our in-memory database
let testDb: Database.Database;
vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocking
import * as registry from '../../src/skills/registry';
import {
  seedDefaultSkills,
  getAllSkillStatuses,
  enableSkill,
  disableSkill,
  enableSubSkill,
  disableSubSkill,
  invalidateToolCache,
} from '../../src/skills/skill-manager';

describe('Portal Skill Management', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    seedDefaultSkills();
    invalidateToolCache();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('GET /api/skills — getAllSkillStatuses()', () => {
    it('returns all three domain skills', () => {
      const skills = getAllSkillStatuses();
      expect(skills).toHaveLength(3);
      const names = skills.map(s => s.name);
      expect(names).toContain('secretary');
      expect(names).toContain('triathlon');
      expect(names).toContain('content');
    });

    it('each skill has name, description, enabled flag, and subSkills', () => {
      const skills = getAllSkillStatuses();
      for (const skill of skills) {
        expect(skill).toHaveProperty('name');
        expect(skill).toHaveProperty('description');
        expect(typeof skill.enabled).toBe('boolean');
        expect(Array.isArray(skill.subSkills)).toBe(true);
        expect(skill.subSkills.length).toBeGreaterThan(0);
      }
    });

    it('sub-skills have name, description, enabled, and toolCount', () => {
      const skills = getAllSkillStatuses();
      for (const skill of skills) {
        for (const sub of skill.subSkills) {
          expect(sub).toHaveProperty('name');
          expect(sub).toHaveProperty('description');
          expect(typeof sub.enabled).toBe('boolean');
          expect(typeof sub.toolCount).toBe('number');
          expect(sub.toolCount).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('secretary has expected sub-skills', () => {
      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const subNames = secretary.subSkills.map(s => s.name);
      expect(subNames).toContain('tasks');
      expect(subNames).toContain('calendar');
      expect(subNames).toContain('email');
      expect(subNames).toContain('reminders');
      expect(subNames).toContain('notes');
    });

    it('all skills are enabled by default after seeding', () => {
      const skills = getAllSkillStatuses();
      for (const skill of skills) {
        expect(skill.enabled).toBe(true);
      }
    });
  });

  describe('POST /api/skills/:name/disable — disableSkill()', () => {
    it('disables a skill and reflects in status', () => {
      const result = disableSkill('secretary');
      expect(result).toBe(true);

      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      expect(secretary.enabled).toBe(false);
    });

    it('returns false for non-existent skill', () => {
      const result = disableSkill('nonexistent' as any);
      expect(result).toBe(false);
    });
  });

  describe('POST /api/skills/:name/enable — enableSkill()', () => {
    it('re-enables a disabled skill', () => {
      disableSkill('triathlon');
      const result = enableSkill('triathlon');
      expect(result).toBe(true);

      const skills = getAllSkillStatuses();
      const triathlon = skills.find(s => s.name === 'triathlon')!;
      expect(triathlon.enabled).toBe(true);
    });
  });

  describe('POST /api/skills/:name/subskills/:sub/disable — disableSubSkill()', () => {
    it('disables a sub-skill', () => {
      const result = disableSubSkill('secretary', 'email');
      expect(result).toEqual({ ok: true });

      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const email = secretary.subSkills.find(s => s.name === 'email')!;
      expect(email.enabled).toBe(false);
    });

    it('other sub-skills remain enabled when one is disabled', () => {
      disableSubSkill('secretary', 'email');

      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const tasks = secretary.subSkills.find(s => s.name === 'tasks')!;
      expect(tasks.enabled).toBe(true);
    });

    it('returns ok:false for non-existent sub-skill', () => {
      const result = disableSubSkill('secretary', 'nonexistent');
      expect(result.ok).toBe(false);
    });

    it('returns ok:false for non-existent parent skill', () => {
      const result = disableSubSkill('nonexistent' as any, 'tasks');
      expect(result.ok).toBe(false);
    });
  });

  describe('POST /api/skills/:name/subskills/:sub/enable — enableSubSkill()', () => {
    it('re-enables a disabled sub-skill', () => {
      disableSubSkill('secretary', 'notes');
      const result = enableSubSkill('secretary', 'notes');
      expect(result).toEqual({ ok: true });

      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const notes = secretary.subSkills.find(s => s.name === 'notes')!;
      expect(notes.enabled).toBe(true);
    });
  });

  describe('registry — enable/disable persistence', () => {
    it('disable persists across getAll calls', () => {
      registry.disable('content');
      const skill = registry.getByName('content');
      expect(skill?.enabled).toBe(0);
    });

    it('enable restores after disable', () => {
      registry.disable('content');
      registry.enable('content');
      const skill = registry.getByName('content');
      expect(skill?.enabled).toBe(1);
    });

    it('disableSubmodule persists', () => {
      registry.disableSubmodule('secretary', 'tasks');
      const enabled = registry.getEnabledSubmodules('secretary');
      expect(enabled).not.toContain('tasks');
    });

    it('enableSubmodule restores after disable', () => {
      registry.disableSubmodule('secretary', 'tasks');
      registry.enableSubmodule('secretary', 'tasks');
      const enabled = registry.getEnabledSubmodules('secretary');
      expect(enabled).toContain('tasks');
    });

    it('getAll returns all installed skills', () => {
      const all = registry.getAll();
      expect(all.length).toBeGreaterThanOrEqual(3);
    });

    it('getSubmodules returns correct submodules for secretary', () => {
      const skill = registry.getByName('secretary');
      expect(skill).toBeDefined();
      const subs = registry.getSubmodules(skill!.id);
      expect(subs.length).toBeGreaterThanOrEqual(5);
      const names = subs.map(s => s.module_name);
      expect(names).toContain('tasks');
      expect(names).toContain('calendar');
    });
  });

  describe('tool count accuracy', () => {
    it('secretary tasks sub-skill has correct tool count', () => {
      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const tasks = secretary.subSkills.find(s => s.name === 'tasks')!;
      // 14 To Do tools in skill-config.ts
      expect(tasks.toolCount).toBe(14);
    });

    it('content has fewer tools than secretary', () => {
      const skills = getAllSkillStatuses();
      const secretary = skills.find(s => s.name === 'secretary')!;
      const content = skills.find(s => s.name === 'content')!;
      const secTools = secretary.subSkills.reduce((s, sub) => s + sub.toolCount, 0);
      const conTools = content.subSkills.reduce((s, sub) => s + sub.toolCount, 0);
      expect(conTools).toBeLessThan(secTools);
    });
  });
});
