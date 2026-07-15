/**
 * Portal Skill Management API Tests
 *
 * Tests the skill management endpoints used by the portal UI:
 * GET /api/skills, POST /api/skills/:name/enable|disable,
 * POST /api/skills/:name/subskills/:sub/enable|disable.
 *
 * Uses in-memory SQLite + the actual skill-manager and registry modules.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

// Mock getDb to return our in-memory database
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
  withDatabaseForTestAsync: vi.fn(),
}));

// Mock logger
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
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
  getSkillStatus,
} from '../../src/skills/skill-manager';

describe('Portal Skill Management', () => {
  beforeAll(() => {
    testDb = createMigratedTestDatabase();
  });

  beforeEach(() => {
    testDb.exec('SAVEPOINT portal_skill_management_test');
    seedDefaultSkills();
    invalidateToolCache();
  });

  afterEach(() => {
    testDb.exec('ROLLBACK TO portal_skill_management_test');
    testDb.exec('RELEASE portal_skill_management_test');
  });

  afterAll(() => {
    testDb.close();
  });

  describe('GET /api/skills — getAllSkillStatuses()', () => {
    it('returns all eight domain skills', () => {
      const skills = getAllSkillStatuses();
      expect(skills).toHaveLength(8);
      const names = skills.map(s => s.name);
      expect(names).toContain('secretary');
      expect(names).toContain('triathlon');
      expect(names).toContain('content');
      expect(names).toContain('finance');
      expect(names).toContain('cooking');
      expect(names).toContain('connections');
      expect(names).toContain('notifications');
      expect(names).toContain('decision_center');
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
      expect(result).toBe(true);

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

    it('returns false for non-existent sub-skill', () => {
      const result = disableSubSkill('secretary', 'nonexistent');
      expect(result).toBe(false);
    });

    it('returns false for non-existent parent skill', () => {
      const result = disableSubSkill('nonexistent' as any, 'tasks');
      expect(result).toBe(false);
    });
  });

  describe('POST /api/skills/:name/subskills/:sub/enable — enableSubSkill()', () => {
    it('re-enables a disabled sub-skill', () => {
      disableSubSkill('secretary', 'notes');
      const result = enableSubSkill('secretary', 'notes');
      expect(result).toBe(true);

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

  describe('toggle and seed boundaries', () => {
    it('treats repeated skill and sub-skill toggles as idempotent', () => {
      expect(enableSkill('secretary')).toBe(true);
      expect(enableSkill('secretary')).toBe(true);
      expect(disableSkill('secretary')).toBe(true);
      expect(disableSkill('secretary')).toBe(true);

      expect(enableSubSkill('secretary', 'email')).toBe(true);
      expect(enableSubSkill('secretary', 'email')).toBe(true);
      expect(disableSubSkill('secretary', 'email')).toBe(true);
      expect(disableSubSkill('secretary', 'email')).toBe(true);
    });

    it('reports the final state after rapid skill and sub-skill toggles', () => {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const toggle = iteration % 2 === 0 ? disableSkill : enableSkill;
        expect(toggle('triathlon')).toBe(true);
      }

      disableSubSkill('secretary', 'calendar');
      enableSubSkill('secretary', 'calendar');
      disableSubSkill('secretary', 'calendar');

      expect(getSkillStatus('triathlon').enabled).toBe(true);
      expect(
        getSkillStatus('secretary').subSkills.find(subSkill => subSkill.name === 'calendar')?.enabled,
      ).toBe(false);
    });

    it('preserves explicitly disabled sub-skills across a parent toggle', () => {
      disableSubSkill('secretary', 'email');
      disableSubSkill('secretary', 'notes');
      disableSkill('secretary');
      enableSkill('secretary');

      const enabledByName = new Map(
        getSkillStatus('secretary').subSkills.map(subSkill => [subSkill.name, subSkill.enabled]),
      );
      expect(enabledByName.get('email')).toBe(false);
      expect(enabledByName.get('notes')).toBe(false);
      expect(enabledByName.get('tasks')).toBe(true);
    });

    it('can disable and restore every installed skill without cross-skill leakage', () => {
      const names = getAllSkillStatuses().map(skill => skill.name);
      for (const name of names) {
        expect(disableSkill(name)).toBe(true);
      }
      expect(getAllSkillStatuses().every(skill => !skill.enabled)).toBe(true);

      for (const name of names) {
        expect(enableSkill(name)).toBe(true);
      }
      expect(getAllSkillStatuses().every(skill => skill.enabled)).toBe(true);
    });

    it('keeps the parent enabled when all sub-skills are disabled and restores only the selected sub-skill', () => {
      const initial = getSkillStatus('secretary');
      for (const subSkill of initial.subSkills) {
        expect(disableSubSkill('secretary', subSkill.name)).toBe(true);
      }

      expect(enableSubSkill('secretary', 'tasks')).toBe(true);
      const status = getSkillStatus('secretary');
      expect(status.enabled).toBe(true);
      expect(status.subSkills.find(subSkill => subSkill.name === 'tasks')?.enabled).toBe(true);
      expect(
        status.subSkills
          .filter(subSkill => subSkill.name !== 'tasks')
          .every(subSkill => !subSkill.enabled),
      ).toBe(true);
    });

    it('keeps seed operations idempotent without resetting disabled state', () => {
      disableSkill('content');
      disableSubSkill('secretary', 'email');
      const installedNamesBefore = registry.getAll().map(skill => skill.name).sort();

      seedDefaultSkills();
      seedDefaultSkills();

      const installedNamesAfter = registry.getAll().map(skill => skill.name).sort();
      expect(installedNamesAfter).toEqual(installedNamesBefore);
      expect(new Set(installedNamesAfter).size).toBe(installedNamesAfter.length);
      expect(getSkillStatus('content').enabled).toBe(false);
      expect(
        getSkillStatus('secretary').subSkills.find(subSkill => subSkill.name === 'email')?.enabled,
      ).toBe(false);
    });
  });
});
