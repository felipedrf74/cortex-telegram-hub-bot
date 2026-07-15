/**
 * QA Validation Tests — Skill Configuration
 *
 * Validates:
 * - Skill list completeness (all 5 domains represented)
 * - Sub-module counts match current config
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}


let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
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
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  seedDefaultSkills,
  getAllSkillStatuses,
  getSkillStatus,
  invalidateToolCache,
} from '../../src/skills/skill-manager';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';
import type { DefaultDomainName } from '../../src/domains/types';

beforeEach(() => {
  testDb = createMigratedTestDatabase();
  invalidateToolCache();
  seedDefaultSkills();
});

afterEach(() => {
  testDb.close();
});

// ── Skill completeness ────────────────────────────────────────────

describe('QA: /skills lists all domains', () => {
  it('getAllSkillStatuses returns all 8 default domains (5 domain skills + 3 platform skills promoted 2026-05-15)', () => {
    const skills = getAllSkillStatuses();
    expect(skills).toHaveLength(8);
    const names = skills.map(s => s.name).sort();
    expect(names).toEqual([
      'connections', 'content', 'cooking', 'decision_center', 'finance',
      'notifications', 'secretary', 'triathlon',
    ]);
  });

  it('DEFAULT_SKILLS has all 8 domains', () => {
    const keys = Object.keys(DEFAULT_SKILLS).sort();
    expect(keys).toEqual([
      'connections', 'content', 'cooking', 'decision_center', 'finance',
      'notifications', 'secretary', 'triathlon',
    ]);
  });

  it('each skill has a description', () => {
    const skills = getAllSkillStatuses();
    for (const skill of skills) {
      expect(skill.description.length).toBeGreaterThan(10);
    }
  });

  it('each domain has at least one sub-skill', () => {
    for (const domain of Object.keys(DEFAULT_SKILLS) as DefaultDomainName[]) {
      const skill = getSkillStatus(domain);
      expect(skill.subSkills.length).toBeGreaterThan(0);
    }
  });
});

// ── /skill <name> valid domains ───────────────────────────────────

describe('QA: skill lookup — dynamic domain resolution', () => {
  it('getSkillStatus supports every default domain dynamically', () => {
    for (const domain of Object.keys(DEFAULT_SKILLS) as DefaultDomainName[]) {
      const skill = getSkillStatus(domain);
      expect(skill, `${domain} should be resolvable via getSkillStatus`).toBeTruthy();
      expect(skill.name).toBe(domain);
    }
  });
});

// ── Sub-module counts per domain ──────────────────────────────────

describe('QA: Sub-module counts match skill-config', () => {
  const expectedCounts: Record<string, number> = {
    secretary: 7,  // tasks, calendar, email, reminders, notes, shared-memory, briefings
    // Phase 1: 4 sport persona sub-skills (gym/running/cycle/swim) + 6 shared capability sub-skills
    // (training-plans, calendar, reminders, notes, shared-memory, recovery)
    triathlon: 10,
    content: 12,   // notes, shared-memory, research-pipeline, script-generator, seo-tracker, reaction-radar, voice-evolution, performance-intel, pipeline-tracker, topic-scheduler, creator-agency, meme-scout
    finance: 4,    // expenses, tax, notes, shared-memory
    cooking: 7,    // recipes, meal-planning, shopping, pantry, preferences, notes, shared-memory
  };

  for (const [domain, count] of Object.entries(expectedCounts)) {
    it(`${domain} has ${count} sub-modules`, () => {
      const skill = getSkillStatus(domain as DefaultDomainName);
      expect(skill.subSkills).toHaveLength(count);
    });
  }
});

// ── Tool counts ───────────────────────────────────────────────────

describe('QA: Tool counts are accurate', () => {
  it('tool counts match skill-config definitions', () => {
    for (const [domain, def] of Object.entries(DEFAULT_SKILLS)) {
      const skill = getSkillStatus(domain as DefaultDomainName);
      for (const subDef of def.subSkills) {
        const subStatus = skill.subSkills.find(s => s.name === subDef.name);
        expect(subStatus, `${domain}.${subDef.name} should exist`).toBeTruthy();
        expect(subStatus!.toolCount).toBe(subDef.tools.length);
      }
    }
  });

  it('cooking has pantry-capable tools across sub-skills', () => {
    const skill = getSkillStatus('cooking');
    const totalTools = skill.subSkills.reduce((sum, s) => sum + s.toolCount, 0);
    // 3 (recipes) + 3 (meal-planning) + 2 (shopping) + 3 (pantry) + 2 (preferences) + shared tools.
    // But notes and shared-memory use shared tool names, toolCount counts per sub-skill
    expect(totalTools).toBeGreaterThanOrEqual(13);
  });

  it('finance has expense and tax tools', () => {
    const skill = getSkillStatus('finance');
    const expenses = skill.subSkills.find(s => s.name === 'expenses');
    const tax = skill.subSkills.find(s => s.name === 'tax');
    expect(expenses).toBeTruthy();
    expect(tax).toBeTruthy();
    expect(expenses!.toolCount).toBe(4);
    expect(tax!.toolCount).toBe(4);
  });
});

// ── Routing config ────────────────────────────────────────────────

describe('QA: Skill routing configuration', () => {
  it('every default skill has classification hints', () => {
    for (const def of Object.values(DEFAULT_SKILLS)) {
      expect(def.routing.classificationHint.label).toBeTruthy();
      expect(def.routing.classificationHint.description.length).toBeGreaterThan(10);
      expect(def.routing.classificationHint.examples.length).toBeGreaterThan(0);
    }
  });

  it('every default skill has at least one pattern route', () => {
    for (const def of Object.values(DEFAULT_SKILLS)) {
      expect(def.routing.patternRoutes.length).toBeGreaterThan(0);
    }
  });

  it('every default skill has a keyword route', () => {
    for (const def of Object.values(DEFAULT_SKILLS)) {
      expect(def.routing.keywordRoute).toBeInstanceOf(RegExp);
    }
  });

  it('cooking routing matches expected commands', () => {
    const cooking = DEFAULT_SKILLS.cooking;
    const testCommands = ['/cook', '/recipe', '/meal', '/mealplan', '/shopping'];
    for (const cmd of testCommands) {
      const matches = cooking.routing.patternRoutes.some(p => p.test(cmd));
      expect(matches, `"${cmd}" should match cooking patterns`).toBe(true);
    }
  });

  it('cooking keyword route matches natural language', () => {
    const cooking = DEFAULT_SKILLS.cooking;
    const phrases = ['find me a recipe', 'meal plan for the week', 'shopping list', 'cooking ideas'];
    for (const phrase of phrases) {
      expect(
        cooking.routing.keywordRoute!.test(phrase),
        `"${phrase}" should match cooking keywords`,
      ).toBe(true);
    }
  });
});
