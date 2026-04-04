/**
 * Tests for skill-gated onboarding — connecting the onboarding system
 * with the user skill access system.
 *
 * Uses real DB state (not mocks) for user-service and user-skill-access
 * because those modules use dynamic require() which vitest can't intercept
 * in CommonJS mode.
 *
 * Validates:
 * - SKILL_ONBOARDING_MAP / QUESTIONNAIRE_SKILL_MAP mappings
 * - getEnabledQuestionnaires filters by skill access
 * - getPendingOnboardings excludes completed profiles
 * - Owner bypass
 * - applySkillPreset from invite codes
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
      name TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      try {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon' },
  },
}));

import {
  getEnabledQuestionnaires,
  getPendingOnboardings,
  SKILL_ONBOARDING_MAP,
  QUESTIONNAIRE_SKILL_MAP,
  getProfile,
  startOrResume,
  answerStep,
  getQuestionnaire,
  getAvailableQuestionnaires,
} from '../../src/services/onboarding';

import { applySkillPreset, setSkillAccess } from '../../src/services/user-skill-access';

// Helper: create a user in the DB
function createUser(db: Database.Database, telegramId: number, tier: string = 'free'): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
    VALUES (?, 'Test', ?, 'active', 40, 100000, 0)
  `).run(telegramId, tier);
}

// Helper: complete a questionnaire fully
function completeQuestionnaire(userId: number, qId: string): void {
  startOrResume(userId, qId);
  const def = getQuestionnaire(qId)!;
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    if ((step.type === 'choice' || step.type === 'multi_choice') && step.options) {
      answerStep(userId, qId, step.options[0]);
    } else if (step.type === 'number') {
      answerStep(userId, qId, '75');
    } else {
      answerStep(userId, qId, 'test answer');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

describe('skill-gated onboarding', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // ── Mapping constants ──

  describe('SKILL_ONBOARDING_MAP', () => {
    it('maps triathlon to fitness', () => {
      expect(SKILL_ONBOARDING_MAP.triathlon).toBe('fitness');
    });

    it('maps cooking to diet', () => {
      expect(SKILL_ONBOARDING_MAP.cooking).toBe('diet');
    });

    it('secretary has no onboarding', () => {
      expect(SKILL_ONBOARDING_MAP.secretary).toBeNull();
    });

    it('content has no onboarding', () => {
      expect(SKILL_ONBOARDING_MAP.content).toBeNull();
    });

    it('finance has no onboarding', () => {
      expect(SKILL_ONBOARDING_MAP.finance).toBeNull();
    });
  });

  describe('QUESTIONNAIRE_SKILL_MAP', () => {
    it('reverse maps fitness to triathlon', () => {
      expect(QUESTIONNAIRE_SKILL_MAP.fitness).toBe('triathlon');
    });

    it('reverse maps diet to cooking', () => {
      expect(QUESTIONNAIRE_SKILL_MAP.diet).toBe('cooking');
    });
  });

  // ── getEnabledQuestionnaires ──

  describe('getEnabledQuestionnaires', () => {
    it('returns fitness and diet when all skills enabled (default)', () => {
      createUser(testDb, 100);
      const result = getEnabledQuestionnaires(100);
      // Default: all skills enabled, so both skill-linked questionnaires returned
      expect(result).toContain('fitness');
      expect(result).toContain('diet');
      // Should NOT include homeschool (no skill mapping)
      expect(result).not.toContain('homeschool');
    });

    it('excludes fitness when triathlon skill is disabled', () => {
      createUser(testDb, 101);
      setSkillAccess(101, 'triathlon', false);
      const result = getEnabledQuestionnaires(101);
      expect(result).not.toContain('fitness');
      expect(result).toContain('diet'); // cooking still enabled
    });

    it('excludes diet when cooking skill is disabled', () => {
      createUser(testDb, 102);
      setSkillAccess(102, 'cooking', false);
      const result = getEnabledQuestionnaires(102);
      expect(result).toContain('fitness'); // triathlon still enabled
      expect(result).not.toContain('diet');
    });

    it('returns empty when all skill-linked skills are disabled', () => {
      createUser(testDb, 103);
      setSkillAccess(103, 'triathlon', false);
      setSkillAccess(103, 'cooking', false);
      const result = getEnabledQuestionnaires(103);
      expect(result).toHaveLength(0);
    });

    it('owner gets all questionnaires regardless of skill overrides', () => {
      createUser(testDb, 104, 'owner');
      setSkillAccess(104, 'triathlon', false);
      setSkillAccess(104, 'cooking', false);
      const result = getEnabledQuestionnaires(104);
      // Owner bypasses skill restrictions and gets all available
      const allAvailable = getAvailableQuestionnaires();
      expect(result).toEqual(allAvailable);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // ── getPendingOnboardings ──

  describe('getPendingOnboardings', () => {
    it('returns all enabled questionnaires when none completed', () => {
      createUser(testDb, 200);
      const pending = getPendingOnboardings(200);
      expect(pending).toContain('fitness');
      expect(pending).toContain('diet');
    });

    it('excludes already-completed profiles', () => {
      createUser(testDb, 201);
      completeQuestionnaire(201, 'fitness');

      const pending = getPendingOnboardings(201);
      expect(pending).not.toContain('fitness');
      expect(pending).toContain('diet');
    });

    it('returns empty when all enabled questionnaires are completed', () => {
      createUser(testDb, 202);
      completeQuestionnaire(202, 'fitness');
      completeQuestionnaire(202, 'diet');

      const pending = getPendingOnboardings(202);
      expect(pending).toHaveLength(0);
    });

    it('returns empty when all skills are disabled', () => {
      createUser(testDb, 203);
      setSkillAccess(203, 'triathlon', false);
      setSkillAccess(203, 'cooking', false);

      const pending = getPendingOnboardings(203);
      expect(pending).toHaveLength(0);
    });

    it('only shows pending for enabled skills', () => {
      createUser(testDb, 204);
      setSkillAccess(204, 'triathlon', false);
      // cooking still enabled, diet not completed
      const pending = getPendingOnboardings(204);
      expect(pending).toEqual(['diet']);
    });
  });

  // ── applySkillPreset ──

  describe('applySkillPreset', () => {
    it('disables skills marked false in preset', () => {
      createUser(testDb, 300);
      applySkillPreset(300, { triathlon: true, cooking: false, finance: false });

      // Check the overrides in the DB
      const overrides = testDb.prepare(
        'SELECT skill, enabled FROM user_skill_overrides WHERE user_id = ?'
      ).all(300) as { skill: string; enabled: number }[];

      // Only disabled skills should have overrides (applySkillPreset only writes disabled)
      expect(overrides).toHaveLength(2);
      expect(overrides.find(o => o.skill === 'cooking')?.enabled).toBe(0);
      expect(overrides.find(o => o.skill === 'finance')?.enabled).toBe(0);
      // triathlon was true — no override created
      expect(overrides.find(o => o.skill === 'triathlon')).toBeUndefined();
    });

    it('affects getEnabledQuestionnaires', () => {
      createUser(testDb, 301);
      applySkillPreset(301, { cooking: false });

      const result = getEnabledQuestionnaires(301);
      expect(result).toContain('fitness'); // triathlon not disabled
      expect(result).not.toContain('diet'); // cooking disabled
    });
  });

  // ── invite code skill_preset column ──

  describe('invite code skill_preset', () => {
    it('migration adds skill_preset column to invite_codes', () => {
      // The column should exist after migrations
      const info = testDb.prepare("PRAGMA table_info('invite_codes')").all() as { name: string }[];
      const hasColumn = info.some(col => col.name === 'skill_preset');
      expect(hasColumn).toBe(true);
    });

    it('skill_preset defaults to null', () => {
      testDb.prepare("INSERT INTO invite_codes (code, created_by, max_uses) VALUES ('TEST1234', 1, 1)").run();
      const row = testDb.prepare("SELECT skill_preset FROM invite_codes WHERE code = 'TEST1234'").get() as any;
      expect(row.skill_preset).toBeNull();
    });

    it('can store and retrieve a JSON skill preset', () => {
      const preset = JSON.stringify({ triathlon: true, cooking: false });
      testDb.prepare("INSERT INTO invite_codes (code, created_by, max_uses, skill_preset) VALUES ('PRES1234', 1, 1, ?)").run(preset);
      const row = testDb.prepare("SELECT skill_preset FROM invite_codes WHERE code = 'PRES1234'").get() as any;
      expect(JSON.parse(row.skill_preset)).toEqual({ triathlon: true, cooking: false });
    });
  });
});
