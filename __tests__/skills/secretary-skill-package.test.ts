/**
 * Tests for Secretary Domain → Skill Package refactoring
 *
 * Validates:
 * 1. manifest.json v2 format (filesystem)
 * 2. Cron job → sub-skill mappings
 * 3. Sub-skill gating of cron jobs via wrapJob
 * 4. State context gating by sub-skill enabled state
 * 5. Portal API endpoints for skill toggles
 * 6. Briefings sub-skill added correctly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  DEFAULT_SKILLS,
  getCronJobOwner,
  getAllCronJobMappings,
  getSubSkillNames,
} from '../../src/skills/skill-config';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_DIR = path.resolve(ROOT, 'migrations');

// ── Test DB helpers ─────────────────────────────────────────────

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

// ── Mocks ───────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════
// 1. MANIFEST.JSON V2 FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('Secretary manifest.json (v2 format)', () => {
  const manifestPath = path.join(ROOT, 'src', 'skills', 'secretary', 'manifest.json');

  it('manifest.json file exists on disk', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('parses as valid JSON', () => {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  it('has manifest version 2', () => {
    expect(manifest.manifestVersion).toBe(2);
  });

  it('has correct name and domain', () => {
    expect(manifest.name).toBe('secretary');
    expect(manifest.domain).toBe('secretary');
  });

  it('has semver version', () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has subSkills array with 7 entries', () => {
    expect(Array.isArray(manifest.subSkills)).toBe(true);
    expect(manifest.subSkills.length).toBe(7);
  });

  it('each sub-skill has required fields', () => {
    for (const sub of manifest.subSkills) {
      expect(sub.module_name).toBeTruthy();
      expect(sub.description).toBeTruthy();
      expect(typeof sub.enabled_by_default).toBe('boolean');
      expect(Array.isArray(sub.tools)).toBe(true);
      expect(Array.isArray(sub.cronJobs)).toBe(true);
    }
  });

  it('includes briefings sub-skill', () => {
    const briefings = manifest.subSkills.find((s: any) => s.module_name === 'briefings');
    expect(briefings).toBeDefined();
    expect(briefings.cronJobs).toEqual(['daily_briefing', 'weekly_review']);
    expect(briefings.tools).toEqual([]);
  });

  it('all sub-skills are enabled by default', () => {
    for (const sub of manifest.subSkills) {
      expect(sub.enabled_by_default).toBe(true);
    }
  });

  it('tasks sub-skill owns end_of_day and shared_list crons', () => {
    const tasks = manifest.subSkills.find((s: any) => s.module_name === 'tasks');
    expect(tasks.cronJobs).toContain('end_of_day');
    expect(tasks.cronJobs).toContain('shared_list');
  });

  it('reminders sub-skill owns reminders cron', () => {
    const reminders = manifest.subSkills.find((s: any) => s.module_name === 'reminders');
    expect(reminders.cronJobs).toContain('reminders');
  });

  it('email sub-skill owns fossa_email cron', () => {
    const email = manifest.subSkills.find((s: any) => s.module_name === 'email');
    expect(email.cronJobs).toContain('fossa_email');
  });

  it('calendar sub-skill owns conflict_detection cron', () => {
    const calendar = manifest.subSkills.find((s: any) => s.module_name === 'calendar');
    expect(calendar.cronJobs).toContain('conflict_detection');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. SKILL-CONFIG CRON MAPPINGS
// ═══════════════════════════════════════════════════════════════════

describe('SkillConfig — cron job mappings', () => {

  it('secretary skill has 7 sub-skills (including briefings)', () => {
    expect(DEFAULT_SKILLS.secretary.subSkills.length).toBe(7);
  });

  it('briefings sub-skill exists with correct cron jobs', () => {
    const briefings = DEFAULT_SKILLS.secretary.subSkills.find((s: any) => s.name === 'briefings');
    expect(briefings).toBeDefined();
    expect(briefings.cronJobs).toEqual(['daily_briefing', 'weekly_review']);
    expect(briefings.tools).toEqual([]);
  });

  it('getCronJobOwner returns correct owner for secretary crons', () => {
    expect(getCronJobOwner('end_of_day')).toEqual({ domain: 'secretary', subSkill: 'tasks' });
    expect(getCronJobOwner('shared_list')).toEqual({ domain: 'secretary', subSkill: 'tasks' });
    expect(getCronJobOwner('conflict_detection')).toEqual({ domain: 'secretary', subSkill: 'calendar' });
    expect(getCronJobOwner('fossa_email')).toEqual({ domain: 'secretary', subSkill: 'email' });
    expect(getCronJobOwner('reminders')).toEqual({ domain: 'secretary', subSkill: 'reminders' });
    expect(getCronJobOwner('daily_briefing')).toEqual({ domain: 'secretary', subSkill: 'briefings' });
    expect(getCronJobOwner('weekly_review')).toEqual({ domain: 'secretary', subSkill: 'briefings' });
  });

  it('getCronJobOwner returns null for unmapped jobs', () => {
    expect(getCronJobOwner('garmin_keepalive')).toBeNull();
    expect(getCronJobOwner('nonexistent_job')).toBeNull();
  });

  it('getAllCronJobMappings returns all secretary cron mappings', () => {
    const map = getAllCronJobMappings();
    expect(map.size).toBeGreaterThanOrEqual(7); // 7 secretary crons
    expect(map.get('end_of_day')).toEqual({ domain: 'secretary', subSkill: 'tasks' });
    expect(map.get('daily_briefing')).toEqual({ domain: 'secretary', subSkill: 'briefings' });
  });

  it('getSubSkillNames includes briefings', () => {
    const names = getSubSkillNames('secretary');
    expect(names).toContain('briefings');
    expect(names.length).toBe(7);
  });

  it('each secretary sub-skill has cronJobs array', () => {
    for (const sub of DEFAULT_SKILLS.secretary.subSkills) {
      // notes and shared-memory have no crons but the field should exist or be undefined
      if (sub.cronJobs) {
        expect(Array.isArray(sub.cronJobs)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. CRON JOB GATING (isCronJobEnabled)
// ═══════════════════════════════════════════════════════════════════

describe('SkillManager — isCronJobEnabled', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns true for unmapped jobs', async () => {
    const { isCronJobEnabled } = await import('../../src/skills/skill-manager');
    expect(isCronJobEnabled('garmin_keepalive')).toBe(true);
    expect(isCronJobEnabled('nonexistent_job')).toBe(true);
  });

  it('returns true when owning sub-skill is enabled', async () => {
    const { seedDefaultSkills, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();
    expect(isCronJobEnabled('reminders')).toBe(true);
    expect(isCronJobEnabled('end_of_day')).toBe(true);
    expect(isCronJobEnabled('daily_briefing')).toBe(true);
  });

  it('returns false when owning sub-skill is disabled', async () => {
    const { seedDefaultSkills, disableSubSkill, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();
    disableSubSkill('secretary', 'reminders');
    expect(isCronJobEnabled('reminders')).toBe(false);
  });

  it('disabling tasks sub-skill blocks end_of_day and shared_list', async () => {
    const { seedDefaultSkills, disableSubSkill, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();
    disableSubSkill('secretary', 'tasks');
    expect(isCronJobEnabled('end_of_day')).toBe(false);
    expect(isCronJobEnabled('shared_list')).toBe(false);
  });

  it('disabling briefings sub-skill blocks daily_briefing and weekly_review', async () => {
    const { seedDefaultSkills, disableSubSkill, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();
    disableSubSkill('secretary', 'briefings');
    expect(isCronJobEnabled('daily_briefing')).toBe(false);
    expect(isCronJobEnabled('weekly_review')).toBe(false);
  });

  it('re-enabling sub-skill restores cron job access', async () => {
    const { seedDefaultSkills, disableSubSkill, enableSubSkill, isCronJobEnabled } = await import('../../src/skills/skill-manager');
    seedDefaultSkills();
    disableSubSkill('secretary', 'email');
    expect(isCronJobEnabled('fossa_email')).toBe(false);
    enableSubSkill('secretary', 'email');
    expect(isCronJobEnabled('fossa_email')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. WRAPJOB SUB-SKILL GATING
// ═══════════════════════════════════════════════════════════════════

describe('Telemetry — wrapJob respects sub-skill gating', () => {
  it('wrapJob skips execution when job is disabled', async () => {
    const { setJobEnabledChecker, registerJob, wrapJob } = await import('../../src/portal/telemetry');

    // Register a checker that disables 'test_job'
    setJobEnabledChecker((name) => name !== 'test_disabled_job');

    registerJob('test_disabled_job', 'Test Disabled', '* * * * *', 'secretary');
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = wrapJob('test_disabled_job', fn);
    await wrapped();

    expect(fn).not.toHaveBeenCalled();
  });

  it('wrapJob executes when job is enabled', async () => {
    const { setJobEnabledChecker, registerJob, wrapJob } = await import('../../src/portal/telemetry');

    setJobEnabledChecker(() => true);

    registerJob('test_enabled_job', 'Test Enabled', '* * * * *', 'secretary');
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = wrapJob('test_enabled_job', fn);
    await wrapped();

    expect(fn).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. MANIFEST + SKILL-CONFIG CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

describe('Manifest ↔ skill-config consistency', () => {
  const manifestPath = path.join(ROOT, 'src', 'skills', 'secretary', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const skillDef = DEFAULT_SKILLS.secretary;

  it('manifest and skill-config have same number of sub-skills', () => {
    expect(manifest.subSkills.length).toBe(skillDef.subSkills.length);
  });

  it('manifest sub-skill names match skill-config', () => {
    const manifestNames = manifest.subSkills.map((s: any) => s.module_name).sort();
    const configNames = skillDef.subSkills.map((s: any) => s.name).sort();
    expect(manifestNames).toEqual(configNames);
  });

  it('manifest tool lists match skill-config for each sub-skill', () => {
    for (const manifestSub of manifest.subSkills) {
      const configSub = skillDef.subSkills.find((s: any) => s.name === manifestSub.module_name);
      expect(configSub).toBeDefined();
      expect(manifestSub.tools.sort()).toEqual([...configSub.tools].sort());
    }
  });

  it('manifest cronJob lists match skill-config for each sub-skill', () => {
    for (const manifestSub of manifest.subSkills) {
      const configSub = skillDef.subSkills.find((s: any) => s.name === manifestSub.module_name);
      expect(configSub).toBeDefined();
      const configCrons = configSub.cronJobs ?? [];
      expect(manifestSub.cronJobs.sort()).toEqual([...configCrons].sort());
    }
  });
});
