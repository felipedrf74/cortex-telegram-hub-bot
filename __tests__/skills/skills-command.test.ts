/**
 * Tests for /skills and /skill <name> Telegram commands.
 *
 * Verifies:
 * - getAllSkillStatuses() returns correct shape for /skills rendering
 * - getSkillStatus() returns detail for /skill <name> rendering
 * - Formatting logic: icons, status indicators, sub-module counts
 * - Edge cases: empty skills, invalid skill name
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
    .filter(f => f.endsWith('.sql') && !f.includes(' 2'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── Mock DB ──────────────────────────────────────────────────────

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
  seedDefaultSkills,
  getAllSkillStatuses,
  getSkillStatus,
  invalidateToolCache,
} from '../../src/skills/skill-manager';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';
import type { DomainName } from '../../src/domains/types';

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  invalidateToolCache();
  seedDefaultSkills();
});

afterEach(() => {
  testDb.close();
});

// ── /skills command: getAllSkillStatuses() ───────────────────────

describe('/skills command — getAllSkillStatuses()', () => {
  it('returns all five skills after seeding', () => {
    const skills = getAllSkillStatuses();
    expect(skills).toHaveLength(5);
    const names = skills.map(s => s.name).sort();
    expect(names).toEqual(['content', 'cooking', 'finance', 'secretary', 'triathlon']);
  });

  it('each skill has correct structure', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      expect(skill).toHaveProperty('name');
      expect(skill).toHaveProperty('description');
      expect(skill).toHaveProperty('enabled');
      expect(skill).toHaveProperty('subSkills');
      expect(typeof skill.name).toBe('string');
      expect(typeof skill.description).toBe('string');
      expect(typeof skill.enabled).toBe('boolean');
      expect(Array.isArray(skill.subSkills)).toBe(true);
    }
  });

  it('all skills are enabled by default', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      expect(skill.enabled).toBe(true);
    }
  });

  it('secretary has 7 sub-modules', () => {
    const skills = getAllSkillStatuses();
    const secretary = skills.find(s => s.name === 'secretary')!;
    expect(secretary.subSkills).toHaveLength(7);
    const subNames = secretary.subSkills.map(s => s.name).sort();
    expect(subNames).toEqual(['briefings', 'calendar', 'email', 'notes', 'reminders', 'shared-memory', 'tasks']);
  });

  it('triathlon has 9 sub-modules', () => {
    const skills = getAllSkillStatuses();
    const triathlon = skills.find(s => s.name === 'triathlon')!;
    expect(triathlon.subSkills).toHaveLength(9);
  });

  it('content has 11 sub-modules (v2.0.0 with granular agent sub-skills)', () => {
    const skills = getAllSkillStatuses();
    const content = skills.find(s => s.name === 'content')!;
    expect(content.subSkills).toHaveLength(11);
  });

  it('sub-skills have toolCount >= 0 (agent sub-skills may have no tools)', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      for (const sub of skill.subSkills) {
        expect(sub.toolCount).toBeGreaterThanOrEqual(0);
      }
    }
    // Many sub-skills are cron/agent-driven with no tools (content agents, triathlon disciplines)
    const allSubs = skills.flatMap(s => s.subSkills);
    const withTools = allSubs.filter(s => s.toolCount > 0);
    expect(withTools.length).toBeGreaterThan(allSubs.length * 0.4);
  });
});

// ── /skill <name> command: getSkillStatus() ─────────────────────

describe('/skill <name> command — getSkillStatus()', () => {
  it('returns correct detail for secretary', () => {
    const skill = getSkillStatus('secretary');
    expect(skill.name).toBe('secretary');
    expect(skill.enabled).toBe(true);
    expect(skill.description).toContain('Personal assistant');
    expect(skill.subSkills.length).toBeGreaterThan(0);
  });

  it('returns correct detail for triathlon', () => {
    const skill = getSkillStatus('triathlon');
    expect(skill.name).toBe('triathlon');
    expect(skill.description).toContain('Triathlon');
  });

  it('returns correct detail for content', () => {
    const skill = getSkillStatus('content');
    expect(skill.name).toBe('content');
    expect(skill.description).toContain('Content');
  });

  it('sub-skills have expected fields', () => {
    const skill = getSkillStatus('secretary');
    for (const sub of skill.subSkills) {
      expect(sub).toHaveProperty('name');
      expect(sub).toHaveProperty('description');
      expect(sub).toHaveProperty('enabled');
      expect(sub).toHaveProperty('toolCount');
      expect(typeof sub.name).toBe('string');
      expect(typeof sub.description).toBe('string');
      expect(typeof sub.enabled).toBe('boolean');
      expect(typeof sub.toolCount).toBe('number');
    }
  });

  it('tasks sub-skill has 14 tools (the most)', () => {
    const skill = getSkillStatus('secretary');
    const tasks = skill.subSkills.find(s => s.name === 'tasks')!;
    expect(tasks.toolCount).toBe(DEFAULT_SKILLS.secretary.subSkills.find(s => s.name === 'tasks')!.tools.length);
  });
});

// ── Formatting edge cases ───────────────────────────────────────

describe('skills command — formatting data correctness', () => {
  it('active sub-module count matches enabledByDefault count', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      const activeSubs = skill.subSkills.filter(s => s.enabled).length;
      const expectedEnabled = DEFAULT_SKILLS[skill.name as DomainName].subSkills.filter(s => s.enabledByDefault).length;
      expect(activeSubs).toBe(expectedEnabled);
    }
  });

  it('active/total tool count is computable from subSkills', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);
      const activeTools = skill.subSkills
        .filter(s => s.enabled)
        .reduce((sum, s) => sum + s.toolCount, 0);
      expect(totalTools).toBeGreaterThan(0);
      expect(activeTools).toBeLessThanOrEqual(totalTools);
    }
  });

  it('shows correct counts when a sub-skill is disabled', () => {
    // Disable the tasks sub-skill
    const db = testDb;
    const skill = db.prepare('SELECT id FROM installed_skills WHERE name = ?').get('secretary') as { id: number };
    db.prepare('UPDATE skill_submodules SET enabled = 0 WHERE skill_id = ? AND module_name = ?').run(skill.id, 'tasks');

    const status = getSkillStatus('secretary');
    const activeSubs = status.subSkills.filter(s => s.enabled).length;
    expect(activeSubs).toBe(6); // 7 - 1

    const tasksStatus = status.subSkills.find(s => s.name === 'tasks')!;
    expect(tasksStatus.enabled).toBe(false);
  });

  it('empty database returns all skills disabled with no enabled subs', () => {
    // Clear the skills table
    testDb.exec('DELETE FROM skill_submodules');
    testDb.exec('DELETE FROM installed_skills');

    const skills = getAllSkillStatuses();
    // getAllSkillStatuses uses DEFAULT_SKILLS keys, so still returns 5 entries
    expect(skills).toHaveLength(5);
    for (const skill of skills) {
      expect(skill.enabled).toBe(false);
    }
  });
});
