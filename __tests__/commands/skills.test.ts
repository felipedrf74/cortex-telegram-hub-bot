/**
 * Tests for src/commands/skills.ts
 *
 * Tests the /skills list formatter, /skill detail formatter,
 * empty-state onboarding message, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { SkillStatus, SubSkillStatus } from '../../src/skills/skill-manager';

// ── Test helpers ───────────────────────────────────────────────────

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
import { formatSkillsList, formatSkillDetail } from '../../src/commands/skills';
import { seedDefaultSkills, getAllSkillStatuses, getSkillStatus, disableSkill, disableSubSkill } from '../../src/skills/skill-manager';

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  seedDefaultSkills();
});

afterEach(() => {
  testDb.close();
});

// ── Tests ─────────────────────────────────────────────────────────

describe('formatSkillsList', () => {
  it('returns onboarding message when no skills are installed', () => {
    const result = formatSkillsList([]);
    expect(result).toContain('No skills installed');
    expect(result).toContain('modular capabilities');
  });

  it('lists all default skills with status', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    expect(result).toContain('Installed Skills');
    expect(result).toContain('secretary');
    expect(result).toContain('triathlon');
    expect(result).toContain('content');
    expect(result).toContain('finance');
    expect(result).toContain('cooking');
  });

  it('shows correct module counts', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    // Secretary has 7 sub-skills, all enabled by default
    expect(result).toContain('7/7 active');
  });

  it('shows enabled toggle for active skills', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    // All default skills start enabled
    expect(result).toContain('✅');
  });

  it('shows disabled toggle after disabling a skill', () => {
    disableSkill('cooking' as any);
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    // cooking should now show ❌
    expect(result).toContain('❌');
  });

  it('shows tool count per skill', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    // All skills have tools > 0
    expect(result).toMatch(/\d+ tools/);
  });

  it('includes hint for detail view', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    expect(result).toContain('/skill name');
  });

  it('shows correct icon per skill', () => {
    const skills = getAllSkillStatuses();
    const result = formatSkillsList(skills);

    expect(result).toContain('📋'); // secretary
    expect(result).toContain('🏋️'); // triathlon
    expect(result).toContain('📹'); // content
    expect(result).toContain('💰'); // finance
    expect(result).toContain('🍳'); // cooking
  });
});

describe('formatSkillDetail', () => {
  it('shows skill name and description', () => {
    const skill = getSkillStatus('secretary' as any)!;
    const result = formatSkillDetail(skill);

    expect(result).toContain('secretary');
    expect(result).toContain('Personal assistant');
    expect(result).toContain('✅ Enabled');
  });

  it('lists all sub-modules with toggle status', () => {
    const skill = getSkillStatus('secretary' as any)!;
    const result = formatSkillDetail(skill);

    expect(result).toContain('tasks');
    expect(result).toContain('calendar');
    expect(result).toContain('email');
    expect(result).toContain('reminders');
    expect(result).toContain('notes');
    expect(result).toContain('shared-memory');
    expect(result).toContain('Sub-modules (7)');
  });

  it('shows tool count per sub-module', () => {
    const skill = getSkillStatus('secretary' as any)!;
    const result = formatSkillDetail(skill);

    // tasks sub-skill has 14 tools
    expect(result).toContain('14 tools');
  });

  it('shows disabled status for disabled skill', () => {
    disableSkill('finance' as any);
    const skill = getSkillStatus('finance' as any)!;
    const result = formatSkillDetail(skill);

    expect(result).toContain('❌ Disabled');
  });

  it('shows disabled toggle for disabled sub-module', () => {
    disableSubSkill('secretary' as any, 'email');
    const skill = getSkillStatus('secretary' as any)!;
    const result = formatSkillDetail(skill);

    // email sub-module should show ❌
    const lines = result.split('\n');
    const emailLine = lines.find(l => l.includes('email') && l.includes('Outlook'));
    expect(emailLine).toContain('❌');
  });

  it('handles skill with no sub-modules gracefully', () => {
    const emptySkill: SkillStatus = {
      name: 'test-skill',
      description: 'A test skill',
      enabled: true,
      subSkills: [],
    };
    const result = formatSkillDetail(emptySkill);

    expect(result).toContain('test-skill');
    expect(result).toContain('No sub-modules configured');
  });

  it('escapes HTML in skill name and description', () => {
    const xssSkill: SkillStatus = {
      name: '<script>alert(1)</script>',
      description: 'Test <b>bold</b> & "quotes"',
      enabled: true,
      subSkills: [],
    };
    const result = formatSkillDetail(xssSkill);

    expect(result).toContain('&lt;script&gt;');
    expect(result).not.toContain('<script>alert');
    expect(result).toContain('&amp;');
  });

  it('shows cooking skill detail with all sub-modules', () => {
    const skill = getSkillStatus('cooking' as any)!;
    const result = formatSkillDetail(skill);

    expect(result).toContain('recipes');
    expect(result).toContain('meal-planning');
    expect(result).toContain('shopping');
    expect(result).toContain('Sub-modules (5)');
  });
});
