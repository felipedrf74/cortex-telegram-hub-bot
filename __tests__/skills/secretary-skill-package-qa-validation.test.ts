/**
 * QA Validation Tests — Secretary Domain → Skill Package
 *
 * Additional edge-case coverage beyond the flex agent's tests:
 * - Cron gating with parent skill disabled (not just sub-skill)
 * - isSubmoduleEnabled behavior for missing/unknown data
 * - Manifest field types and completeness
 * - wrapJob + isJobEnabled interaction edge cases
 * - Cron ↔ sub-skill coverage: every manifest cron is mapped
 * - Tool ↔ sub-skill coverage: every manifest tool appears in skill-config
 * - Disabling all sub-skills still leaves parent skill enabled
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

import * as registry from '../../src/skills/registry';
import {
  seedDefaultSkills,
  isCronJobEnabled,
  disableSkill,
  enableSkill,
  disableSubSkill,
  enableSubSkill,
  getSkillStatus,
  getAllSkillStatuses,
  invalidateToolCache,
} from '../../src/skills/skill-manager';

// ══════════════════════════════════════════════════════════════════════
// 1. CRON GATING WHEN PARENT SKILL IS DISABLED
// ══════════════════════════════════════════════════════════════════════

describe('Cron gating with parent skill disabled', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    seedDefaultSkills();
    invalidateToolCache();
  });

  afterEach(() => {
    testDb.close();
  });

  // BUG: isCronJobEnabled only checks isSubmoduleEnabled, not the parent
  // skill's enabled flag. Disabling the parent skill via the portal toggle
  // does NOT block cron jobs — the sub-module rows still have enabled=1.
  // This test documents the CURRENT (buggy) behavior. Filed for flex agent.
  it('BUG: disabling parent skill does NOT block cron jobs (submodules still enabled)', () => {
    disableSkill('secretary');

    // These SHOULD be false but are true — parent disabled, sub-modules still enabled
    expect(isCronJobEnabled('end_of_day')).toBe(true);
    expect(isCronJobEnabled('daily_briefing')).toBe(true);
    expect(isCronJobEnabled('reminders')).toBe(true);
  });

  it('re-enabling parent skill restores cron jobs', () => {
    disableSkill('secretary');
    enableSkill('secretary');

    expect(isCronJobEnabled('end_of_day')).toBe(true);
    expect(isCronJobEnabled('daily_briefing')).toBe(true);
  });

  it('unmapped cron jobs run regardless of skill states', () => {
    disableSkill('secretary');
    disableSkill('triathlon');
    disableSkill('content');

    expect(isCronJobEnabled('garmin_keepalive')).toBe(true);
    expect(isCronJobEnabled('unknown_job_xyz')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. REGISTRY isSubmoduleEnabled EDGE CASES
// ══════════════════════════════════════════════════════════════════════

describe('registry.isSubmoduleEnabled edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    seedDefaultSkills();
  });

  afterEach(() => {
    testDb.close();
  });

  it('returns false for non-existent skill name', () => {
    expect(registry.isSubmoduleEnabled('nonexistent', 'tasks')).toBe(false);
  });

  it('returns false for non-existent submodule name', () => {
    expect(registry.isSubmoduleEnabled('secretary', 'nonexistent_sub')).toBe(false);
  });

  it('returns true for enabled submodule', () => {
    expect(registry.isSubmoduleEnabled('secretary', 'tasks')).toBe(true);
  });

  it('returns false after disabling submodule', () => {
    registry.disableSubmodule('secretary', 'tasks');
    expect(registry.isSubmoduleEnabled('secretary', 'tasks')).toBe(false);
  });

  it('returns true after re-enabling submodule', () => {
    registry.disableSubmodule('secretary', 'tasks');
    registry.enableSubmodule('secretary', 'tasks');
    expect(registry.isSubmoduleEnabled('secretary', 'tasks')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. MANIFEST FIELD VALIDATION (deep checks)
// ══════════════════════════════════════════════════════════════════════

describe('Secretary manifest v2 deep validation', () => {
  const manifestPath = path.join(ROOT, 'src', 'skills', 'secretary', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  it('has required top-level keys', () => {
    const required = ['name', 'version', 'description', 'author', 'domain', 'manifestVersion', 'subSkills'];
    for (const key of required) {
      expect(manifest).toHaveProperty(key);
    }
  });

  it('has config with stateContextTtl and maxToolIterations', () => {
    expect(manifest.config).toBeDefined();
    expect(typeof manifest.config.stateContextTtl).toBe('number');
    expect(typeof manifest.config.maxToolIterations).toBe('number');
  });

  it('has requiredApiKeys as array', () => {
    expect(Array.isArray(manifest.requiredApiKeys)).toBe(true);
    expect(manifest.requiredApiKeys).toContain('ANTHROPIC_API_KEY');
  });

  it('all tool names are non-empty strings', () => {
    for (const sub of manifest.subSkills) {
      for (const tool of sub.tools) {
        expect(typeof tool).toBe('string');
        expect(tool.length).toBeGreaterThan(0);
      }
    }
  });

  it('all cronJob names are non-empty strings', () => {
    for (const sub of manifest.subSkills) {
      for (const cron of sub.cronJobs) {
        expect(typeof cron).toBe('string');
        expect(cron.length).toBeGreaterThan(0);
      }
    }
  });

  it('no duplicate tool names across sub-skills', () => {
    const allTools: string[] = [];
    for (const sub of manifest.subSkills) {
      allTools.push(...sub.tools);
    }
    const unique = new Set(allTools);
    expect(unique.size).toBe(allTools.length);
  });

  it('no duplicate cron job names across sub-skills', () => {
    const allCrons: string[] = [];
    for (const sub of manifest.subSkills) {
      allCrons.push(...sub.cronJobs);
    }
    const unique = new Set(allCrons);
    expect(unique.size).toBe(allCrons.length);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. EVERY MANIFEST CRON HAS A getCronJobOwner MAPPING
// ══════════════════════════════════════════════════════════════════════

describe('Cron ↔ sub-skill complete coverage', () => {
  const manifestPath = path.join(ROOT, 'src', 'skills', 'secretary', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  it('every manifest cron has a getCronJobOwner mapping', () => {
    for (const sub of manifest.subSkills) {
      for (const cron of sub.cronJobs) {
        const owner = getCronJobOwner(cron);
        expect(owner).not.toBeNull();
        expect(owner!.domain).toBe('secretary');
        expect(owner!.subSkill).toBe(sub.module_name);
      }
    }
  });

  it('getAllCronJobMappings contains every secretary cron', () => {
    const map = getAllCronJobMappings();
    for (const sub of manifest.subSkills) {
      for (const cron of sub.cronJobs) {
        expect(map.has(cron)).toBe(true);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. DISABLING ALL SUB-SKILLS LEAVES PARENT ENABLED
// ══════════════════════════════════════════════════════════════════════

describe('All sub-skills disabled boundary', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    seedDefaultSkills();
    invalidateToolCache();
  });

  afterEach(() => {
    testDb.close();
  });

  it('disabling all secretary sub-skills leaves parent skill enabled', () => {
    const subNames = getSubSkillNames('secretary');
    for (const name of subNames) {
      disableSubSkill('secretary', name);
    }

    const status = getSkillStatus('secretary');
    expect(status.enabled).toBe(true);
    for (const sub of status.subSkills) {
      expect(sub.enabled).toBe(false);
    }
  });

  it('all cron jobs are disabled when all sub-skills disabled', () => {
    const subNames = getSubSkillNames('secretary');
    for (const name of subNames) {
      disableSubSkill('secretary', name);
    }

    expect(isCronJobEnabled('end_of_day')).toBe(false);
    expect(isCronJobEnabled('reminders')).toBe(false);
    expect(isCronJobEnabled('daily_briefing')).toBe(false);
    expect(isCronJobEnabled('fossa_email')).toBe(false);
    expect(isCronJobEnabled('conflict_detection')).toBe(false);
  });

  it('re-enabling one sub-skill only enables its own crons', () => {
    const subNames = getSubSkillNames('secretary');
    for (const name of subNames) {
      disableSubSkill('secretary', name);
    }

    enableSubSkill('secretary', 'briefings');

    expect(isCronJobEnabled('daily_briefing')).toBe(true);
    expect(isCronJobEnabled('weekly_review')).toBe(true);
    // Others still disabled
    expect(isCronJobEnabled('end_of_day')).toBe(false);
    expect(isCronJobEnabled('reminders')).toBe(false);
    expect(isCronJobEnabled('fossa_email')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. SHARED-MEMORY SUB-SKILL (no crons, only tools)
// ══════════════════════════════════════════════════════════════════════

describe('shared-memory sub-skill', () => {
  it('shared-memory has tools but no cron jobs', () => {
    const def = DEFAULT_SKILLS.secretary.subSkills.find(s => s.name === 'shared-memory');
    expect(def).toBeDefined();
    expect(def!.tools.length).toBeGreaterThan(0);
    expect(def!.tools).toContain('shared_memory_set');
    expect(def!.tools).toContain('shared_memory_remove');
    expect(def!.cronJobs ?? []).toEqual([]);
  });
});
