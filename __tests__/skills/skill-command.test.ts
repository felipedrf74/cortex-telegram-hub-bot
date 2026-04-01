/**
 * Tests for /skill command — sub-module toggles with dependency enforcement.
 *
 * Tests the skill-manager toggle API (enableSubSkill/disableSubSkill)
 * with dependency checking and cascade disable, and the skill-config
 * dependency helpers (getSubSkillDependencies, getSubSkillDependents).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  getSubSkillDependencies,
  getSubSkillDependents,
  DEFAULT_SKILLS,
} from '../../src/skills/skill-config';

// ── Mock database ─────────────────────────────────────────────────
let testDb: ReturnType<typeof Database>;

function createTestDb(): ReturnType<typeof Database> {
  return new Database(':memory:');
}

function applyMigrations(db: ReturnType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS installed_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      version TEXT DEFAULT '1.0.0',
      domain TEXT,
      enabled INTEGER DEFAULT 1,
      config_json TEXT,
      installed_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS skill_submodules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
      module_name TEXT NOT NULL,
      version TEXT DEFAULT '1.0.0',
      enabled INTEGER DEFAULT 1,
      config_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(skill_id, module_name)
    );
  `);
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY HELPERS — pure functions from skill-config
// ═══════════════════════════════════════════════════════════════════

describe('Skill dependencies — getSubSkillDependencies', () => {
  it('returns dependencies for coach-briefing (depends on garmin-sync)', () => {
    const deps = getSubSkillDependencies('triathlon', 'coach-briefing');
    expect(deps).toEqual(['garmin-sync']);
  });

  it('returns empty array for garmin-sync (no dependencies)', () => {
    const deps = getSubSkillDependencies('triathlon', 'garmin-sync');
    expect(deps).toEqual([]);
  });

  it('returns empty array for training-plans (no dependencies)', () => {
    const deps = getSubSkillDependencies('triathlon', 'training-plans');
    expect(deps).toEqual([]);
  });

  it('returns empty array for secretary sub-skills (no dependencies)', () => {
    const deps = getSubSkillDependencies('secretary', 'tasks');
    expect(deps).toEqual([]);
  });

  it('returns empty array for non-existent sub-skill', () => {
    const deps = getSubSkillDependencies('triathlon', 'nonexistent');
    expect(deps).toEqual([]);
  });
});

describe('Skill dependencies — getSubSkillDependents', () => {
  it('returns coach-briefing as dependent of garmin-sync', () => {
    const dependents = getSubSkillDependents('triathlon', 'garmin-sync');
    expect(dependents).toContain('coach-briefing');
  });

  it('returns empty array for coach-briefing (nothing depends on it)', () => {
    const dependents = getSubSkillDependents('triathlon', 'coach-briefing');
    expect(dependents).toEqual([]);
  });

  it('returns empty array for non-existent sub-skill', () => {
    const dependents = getSubSkillDependents('triathlon', 'nonexistent');
    expect(dependents).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TOGGLE API — dependency enforcement in skill-manager
// ═══════════════════════════════════════════════════════════════════

describe('Skill toggle — dependency enforcement', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('cannot enable coach-briefing when garmin-sync is disabled', async () => {
    const { seedDefaultSkills, disableSubSkill, enableSubSkill } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    // Disable garmin-sync first
    disableSubSkill('triathlon', 'garmin-sync');

    // Now try to enable coach-briefing — should fail
    const result = enableSubSkill('triathlon', 'coach-briefing');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('garmin-sync');
  });

  it('can enable coach-briefing when garmin-sync is enabled', async () => {
    const { seedDefaultSkills, disableSubSkill, enableSubSkill } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    // Disable then re-enable coach-briefing (garmin-sync stays enabled)
    disableSubSkill('triathlon', 'coach-briefing');
    const result = enableSubSkill('triathlon', 'coach-briefing');
    expect(result.ok).toBe(true);
  });

  it('disabling garmin-sync cascade-disables coach-briefing', async () => {
    const { seedDefaultSkills, disableSubSkill, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    // Both enabled initially
    expect(isCronJobEnabled('garmin_keepalive')).toBe(true);
    expect(isCronJobEnabled('garmin_coach')).toBe(true);

    // Disable garmin-sync — should cascade to coach-briefing
    const result = disableSubSkill('triathlon', 'garmin-sync');
    expect(result.ok).toBe(true);

    // Both cron jobs should now be disabled
    expect(isCronJobEnabled('garmin_keepalive')).toBe(false);
    expect(isCronJobEnabled('garmin_coach')).toBe(false);
  });

  it('sub-skills without dependencies can be toggled freely', async () => {
    const { seedDefaultSkills, disableSubSkill, enableSubSkill } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    // training-plans has no dependencies
    const disResult = disableSubSkill('triathlon', 'training-plans');
    expect(disResult.ok).toBe(true);

    const enResult = enableSubSkill('triathlon', 'training-plans');
    expect(enResult.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL-LEVEL TOGGLE
// ═══════════════════════════════════════════════════════════════════

describe('Skill toggle — enable/disable entire skill', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('can enable and disable an entire skill', async () => {
    const { seedDefaultSkills, enableSkill, disableSkill, getSkillStatus } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    expect(disableSkill('triathlon')).toBe(true);
    expect(getSkillStatus('triathlon').enabled).toBe(false);

    expect(enableSkill('triathlon')).toBe(true);
    expect(getSkillStatus('triathlon').enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SKILL STATUS QUERY
// ═══════════════════════════════════════════════════════════════════

describe('Skill status — getAllSkillStatuses', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns status for all 3 domains', async () => {
    const { seedDefaultSkills, getAllSkillStatuses } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    const statuses = getAllSkillStatuses();
    expect(statuses.length).toBe(3);
    const names = statuses.map(s => s.name);
    expect(names).toContain('secretary');
    expect(names).toContain('triathlon');
    expect(names).toContain('content');
  });

  it('triathlon has 9 sub-skills in status', async () => {
    const { seedDefaultSkills, getSkillStatus } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    const tri = getSkillStatus('triathlon');
    expect(tri.subSkills.length).toBe(9);
    expect(tri.subSkills.find(s => s.name === 'garmin-sync')).toBeDefined();
    expect(tri.subSkills.find(s => s.name === 'coach-briefing')).toBeDefined();
  });

  it('disabled sub-skills show enabled: false in status', async () => {
    const { seedDefaultSkills, getSkillStatus } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();

    const tri = getSkillStatus('triathlon');
    const cycling = tri.subSkills.find(s => s.name === 'cycling')!;
    expect(cycling.enabled).toBe(false);

    const swimming = tri.subSkills.find(s => s.name === 'swimming')!;
    expect(swimming.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ARCHITECTURE — depends field declaration
// ═══════════════════════════════════════════════════════════════════

describe('Skill config — depends field', () => {
  it('SubSkillDefinition supports optional depends field', () => {
    const tri = DEFAULT_SKILLS.triathlon;
    const coachBriefing = tri.subSkills.find(s => s.name === 'coach-briefing')!;
    expect(coachBriefing.depends).toEqual(['garmin-sync']);
  });

  it('sub-skills without depends have undefined or empty depends', () => {
    const tri = DEFAULT_SKILLS.triathlon;
    const garminSync = tri.subSkills.find(s => s.name === 'garmin-sync')!;
    expect(garminSync.depends ?? []).toEqual([]);
  });

  it('all dependency references point to valid sub-skill names', () => {
    for (const skill of Object.values(DEFAULT_SKILLS)) {
      const subNames = new Set(skill.subSkills.map(s => s.name));
      for (const sub of skill.subSkills) {
        for (const dep of sub.depends ?? []) {
          expect(subNames.has(dep)).toBe(true);
        }
      }
    }
  });
});
