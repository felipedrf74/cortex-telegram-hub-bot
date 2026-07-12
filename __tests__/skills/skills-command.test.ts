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
    .filter(f => f.endsWith('.sql'))
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
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
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
  it('returns all eight skills after seeding (5 domain + 3 platform skills)', () => {
    const skills = getAllSkillStatuses();
    expect(skills).toHaveLength(8);
    const names = skills.map(s => s.name).sort();
    expect(names).toEqual([
      'connections', 'content', 'cooking', 'decision_center', 'finance',
      'notifications', 'secretary', 'triathlon',
    ]);
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

  it('triathlon has 10 sub-modules (4 sport personas + 6 shared capabilities after Phase 1 split)', () => {
    const skills = getAllSkillStatuses();
    const triathlon = skills.find(s => s.name === 'triathlon')!;
    expect(triathlon.subSkills).toHaveLength(10);
    const names = triathlon.subSkills.map(s => s.name).sort();
    expect(names).toEqual([
      'calendar', 'cycle', 'gym', 'notes', 'recovery',
      'reminders', 'running', 'shared-memory', 'swim', 'training-plans',
    ]);
  });

  it('content has 12 sub-modules (v2.0.0 with granular agent sub-skills + creator agency)', () => {
    const skills = getAllSkillStatuses();
    const content = skills.find(s => s.name === 'content')!;
    expect(content.subSkills).toHaveLength(12);
  });

  it('sub-skills have toolCount >= 0 (agent and persona sub-skills may have no tools)', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      for (const sub of skill.subSkills) {
        expect(sub.toolCount).toBeGreaterThanOrEqual(0);
      }
    }
    // Phase 1 adds 4 triathlon "persona" sub-skills (gym/running/cycle/swim)
    // that own a prompt file but NO tools (they depend on training-plans +
    // calendar + shared-memory for actual tools). Combined with the 7 content
    // agent sub-skills that also have no tools, the tools-per-sub-skill
    // ratio is lower — roughly 50%. The check is now "at least 40% of
    // sub-skills have tools" to keep the spirit of the original test
    // (most sub-skills should still carry real tools) while accepting
    // persona and agent shells.
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
    // v3.0.0 rebranded parent description to "Multisport" — covers 4 sports
    expect(skill.description.toLowerCase()).toContain('multisport');
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
  it('active sub-module count matches enabled count', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      const activeSubs = skill.subSkills.filter(s => s.enabled).length;
      if (skill.name === 'content') {
        // meme-scout is disabled by default → 10 of 11 enabled
        expect(activeSubs).toBe(skill.subSkills.length - 1);
      } else {
        // All other skills have all sub-skills enabled by default
        expect(activeSubs).toBe(skill.subSkills.length);
      }
    }
  });

  it('active/total tool count is computable from subSkills', () => {
    // Platform skills (connections, notifications, decision_center, promoted
    // 2026-05-15) intentionally ship with empty `tools: []` because their action
    // surface is owned by the chat-action registry (executor strings dispatched
    // server-side), not by the legacy Anthropic tool-call surface. Domain skills
    // still have non-empty tool arrays.
    const PLATFORM_SKILLS_WITHOUT_TOOLS = new Set(['connections', 'notifications', 'decision_center']);
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);
      const activeTools = skill.subSkills
        .filter(s => s.enabled)
        .reduce((sum, s) => sum + s.toolCount, 0);
      if (PLATFORM_SKILLS_WITHOUT_TOOLS.has(skill.name)) {
        expect(totalTools).toBe(0);
      } else {
        expect(totalTools).toBeGreaterThan(0);
      }
      expect(activeTools).toBe(totalTools); // all enabled by default
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

  it('empty database defaults all skills to ENABLED (fail-open)', () => {
    // Clear the skills table — skills should default to enabled, not disabled
    testDb.exec('DELETE FROM skill_submodules');
    testDb.exec('DELETE FROM installed_skills');

    const skills = getAllSkillStatuses();
    expect(skills).toHaveLength(8);
    for (const skill of skills) {
      expect(skill.enabled).toBe(true); // Default to enabled when not in DB
    }
  });
});
