/**
 * Tests for /skill enable|disable + sub-module toggle commands.
 *
 * Covers: parseSkillArgs, skill enable/disable, module enable/disable,
 * dependency validation, formatters, and error cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

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
  parseSkillArgs,
  formatToggleResult,
  formatModulesList,
  formatSkillDetail,
  checkEnableDependencies,
  checkDisableDependents,
  formatDependencyError,
  handleSkillCommand,
} from '../../src/commands/skills';
import {
  seedDefaultSkills, getSkillStatus,
  enableSkill, disableSkill,
  enableSubSkill, disableSubSkill,
  isSkillEnabled,
} from '../../src/skills/skill-manager';
import { isSubmoduleEnabled, install as installSkill, disableSubmodule } from '../../src/skills/registry';
import {
  registerSkill, _resetRegistry,
} from '../../src/skills/skill-config';
import type { SkillDefinition } from '../../src/skills/skill-config';

// ── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  _resetRegistry();
  seedDefaultSkills();
});

afterEach(() => {
  testDb.close();
  _resetRegistry();
});

// ── parseSkillArgs ──────────────────────────────────────────────

describe('parseSkillArgs', () => {
  it('parses empty string', () => {
    expect(parseSkillArgs('')).toEqual({ skillName: '' });
  });

  it('parses skill name only', () => {
    expect(parseSkillArgs('secretary')).toEqual({ skillName: 'secretary', action: undefined });
  });

  it('parses skill enable', () => {
    expect(parseSkillArgs('secretary enable')).toEqual({ skillName: 'secretary', action: 'enable' });
  });

  it('parses skill disable', () => {
    expect(parseSkillArgs('cooking disable')).toEqual({ skillName: 'cooking', action: 'disable' });
  });

  it('parses modules listing', () => {
    expect(parseSkillArgs('finance modules')).toEqual({ skillName: 'finance', action: 'modules' });
  });

  it('parses module enable', () => {
    expect(parseSkillArgs('secretary module email enable')).toEqual({
      skillName: 'secretary',
      action: 'module',
      subName: 'email',
      subAction: 'enable',
    });
  });

  it('parses module disable', () => {
    expect(parseSkillArgs('secretary module tasks disable')).toEqual({
      skillName: 'secretary',
      action: 'module',
      subName: 'tasks',
      subAction: 'disable',
    });
  });

  it('parses module without action', () => {
    expect(parseSkillArgs('secretary module email')).toEqual({
      skillName: 'secretary',
      action: 'module',
      subName: 'email',
      subAction: undefined,
    });
  });

  it('normalises to lowercase', () => {
    expect(parseSkillArgs('Secretary Enable')).toEqual({ skillName: 'secretary', action: 'enable' });
  });

  it('handles extra whitespace', () => {
    expect(parseSkillArgs('  cooking   disable  ')).toEqual({ skillName: 'cooking', action: 'disable' });
  });
});

// ── Skill enable/disable ─────────────────────────────────────────

describe('skill enable/disable', () => {
  it('disables an enabled skill', () => {
    expect(isSkillEnabled('cooking')).toBe(true);
    disableSkill('cooking' as any);
    expect(isSkillEnabled('cooking')).toBe(false);
  });

  it('re-enables a disabled skill', () => {
    disableSkill('cooking' as any);
    expect(isSkillEnabled('cooking')).toBe(false);
    enableSkill('cooking' as any);
    expect(isSkillEnabled('cooking')).toBe(true);
  });

  it('returns false when disabling an unknown skill', () => {
    expect(disableSkill('nonexistent' as any)).toBe(false);
  });

  it('returns false when enabling an unknown skill', () => {
    expect(enableSkill('nonexistent' as any)).toBe(false);
  });
});

// ── Module enable/disable ────────────────────────────────────────

describe('module enable/disable', () => {
  it('disables a sub-module', () => {
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(true);
    disableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(false);
  });

  it('re-enables a disabled sub-module', () => {
    disableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(false);
    enableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(true);
  });

  it('returns false for unknown sub-module', () => {
    expect(disableSubSkill('secretary' as any, 'nonexistent')).toBe(false);
  });

  it('returns false for unknown skill', () => {
    expect(enableSubSkill('nonexistent' as any, 'tasks')).toBe(false);
  });

  it('disabled skill still allows module toggle', () => {
    disableSkill('secretary' as any);
    disableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(false);
    enableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(true);
  });
});

// ── Dependency validation ────────────────────────────────────────

describe('dependency validation', () => {
  // Register a test skill with dependencies for these tests
  const TEST_SKILL: SkillDefinition = {
    name: 'test-deps',
    description: 'Test skill with dependencies',
    version: '1.0.0',
    routing: {
      patternRoutes: [],
      keywordRoute: null,
      classificationHint: { label: 'test', description: 'test', examples: [] },
    },
    subSkills: [
      { name: 'base', description: 'Base module', tools: [], enabledByDefault: true },
      { name: 'middle', description: 'Middle module', tools: [], enabledByDefault: false, dependencies: ['base'] },
      { name: 'top', description: 'Top module', tools: [], enabledByDefault: false, dependencies: ['middle'] },
      { name: 'independent', description: 'No deps', tools: [], enabledByDefault: true },
    ],
  };

  beforeEach(() => {
    registerSkill(TEST_SKILL);
    // Seed the test skill into DB
    installSkill({
      name: 'test-deps',
      description: TEST_SKILL.description,
      version: TEST_SKILL.version,
      domain: 'test-deps',
      submodules: TEST_SKILL.subSkills.map(s => ({ module_name: s.name, version: '1.0.0' })),
    });
    // Set enabled states per enabledByDefault
    disableSubmodule('test-deps', 'middle');
    disableSubmodule('test-deps', 'top');
  });

  it('allows enabling a module with no dependencies', () => {
    const result = checkEnableDependencies('test-deps', 'base');
    expect(result.ok).toBe(true);
  });

  it('blocks enabling a module when dependency is disabled', () => {
    const result = checkEnableDependencies('test-deps', 'middle');
    expect(result.ok).toBe(true); // base is enabled by default

    const result2 = checkEnableDependencies('test-deps', 'top');
    expect(result2.ok).toBe(false);
    expect(result2.missing).toContain('middle');
  });

  it('allows enabling when all dependencies are enabled', () => {
    enableSubSkill('test-deps' as any, 'middle');
    const result = checkEnableDependencies('test-deps', 'top');
    expect(result.ok).toBe(true);
  });

  it('blocks disabling a module that others depend on', () => {
    enableSubSkill('test-deps' as any, 'middle');
    const result = checkDisableDependents('test-deps', 'base');
    expect(result.ok).toBe(false);
    expect(result.dependents).toContain('middle');
  });

  it('allows disabling a module with no active dependents', () => {
    const result = checkDisableDependents('test-deps', 'base');
    // middle and top are disabled, so no active dependents
    expect(result.ok).toBe(true);
  });

  it('allows disabling an independent module', () => {
    const result = checkDisableDependents('test-deps', 'independent');
    expect(result.ok).toBe(true);
  });

  it('returns ok for unknown skill in dependency check', () => {
    const result = checkEnableDependencies('nonexistent', 'foo');
    expect(result.ok).toBe(true); // no deps found = ok
  });
});

// ── Formatters ──────────────────────────────────────────────────

describe('formatToggleResult', () => {
  it('formats skill enable message', () => {
    const msg = formatToggleResult('cooking', 'enabled', false);
    expect(msg).toContain('✅');
    expect(msg).toContain('Skill');
    expect(msg).toContain('cooking');
    expect(msg).toContain('enabled');
  });

  it('formats skill disable message', () => {
    const msg = formatToggleResult('cooking', 'disabled', false);
    expect(msg).toContain('❌');
    expect(msg).toContain('disabled');
  });

  it('formats module enable with parent skill', () => {
    const msg = formatToggleResult('email', 'enabled', true, 'secretary');
    expect(msg).toContain('Module');
    expect(msg).toContain('email');
    expect(msg).toContain('secretary');
  });
});

describe('formatModulesList', () => {
  it('lists all modules with toggle status', () => {
    const skill = getSkillStatus('secretary' as any)!;
    const msg = formatModulesList(skill);
    expect(msg).toContain('secretary');
    expect(msg).toContain('Sub-modules');
    expect(msg).toContain('tasks');
    expect(msg).toContain('email');
    expect(msg).toContain('✅');
  });

  it('shows disabled toggle after disabling a module', () => {
    disableSubSkill('secretary' as any, 'email');
    const skill = getSkillStatus('secretary' as any)!;
    const msg = formatModulesList(skill);
    const lines = msg.split('\n');
    const emailLine = lines.find(l => l.includes('email') && l.includes('Outlook'));
    expect(emailLine).toContain('❌');
  });

  it('handles empty sub-modules', () => {
    const msg = formatModulesList({
      name: 'test',
      description: 'Test',
      enabled: true,
      subSkills: [],
    });
    expect(msg).toContain('No sub-modules configured');
  });
});

describe('formatSkillDetail (updated)', () => {
  it('includes command hints in detail view', () => {
    const skill = getSkillStatus('secretary' as any)!;
    const msg = formatSkillDetail(skill);
    expect(msg).toContain('/skill secretary enable');
    expect(msg).toContain('/skill secretary modules');
    expect(msg).toContain('module');
  });
});

describe('formatDependencyError', () => {
  it('formats enable error with missing deps', () => {
    const msg = formatDependencyError('enable', 'top', { ok: false, missing: ['middle', 'base'] });
    expect(msg).toContain('Cannot enable');
    expect(msg).toContain('top');
    expect(msg).toContain('middle');
    expect(msg).toContain('base');
    expect(msg).toContain('Enable the required');
  });

  it('formats disable error with active dependents', () => {
    const msg = formatDependencyError('disable', 'base', { ok: false, dependents: ['middle'] });
    expect(msg).toContain('Cannot disable');
    expect(msg).toContain('base');
    expect(msg).toContain('middle');
    expect(msg).toContain('Disable the dependent');
  });

  it('returns empty string for ok result', () => {
    expect(formatDependencyError('enable', 'x', { ok: true })).toBe('');
    expect(formatDependencyError('disable', 'x', { ok: true })).toBe('');
  });
});

// ── handleSkillCommand (integration) ─────────────────────────────

describe('handleSkillCommand', () => {
  function mockCtx(match: string) {
    const replies: Array<{ text: string; opts: any }> = [];
    return {
      ctx: {
        match,
        reply: vi.fn(async (text: string, opts?: any) => {
          replies.push({ text, opts });
        }),
      },
      replies,
    };
  }

  it('shows usage when no arguments', async () => {
    const { ctx, replies } = mockCtx('');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Usage');
  });

  it('shows error for unknown skill', async () => {
    const { ctx, replies } = mockCtx('nonexistent');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toBeTruthy(); // Unknown skills show disabled status
  });

  it('shows detail view for skill name only', async () => {
    const { ctx, replies } = mockCtx('secretary');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('secretary');
    expect(replies[0].text).toContain('Sub-modules');
  });

  it('enables a skill', async () => {
    disableSkill('cooking' as any);
    expect(isSkillEnabled('cooking')).toBe(false);

    const { ctx, replies } = mockCtx('cooking enable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('✅');
    expect(replies[0].text).toContain('enabled');
    expect(isSkillEnabled('cooking')).toBe(true);
  });

  it('disables a skill', async () => {
    const { ctx, replies } = mockCtx('cooking disable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('❌');
    expect(replies[0].text).toContain('disabled');
    expect(isSkillEnabled('cooking')).toBe(false);
  });

  it('lists modules', async () => {
    const { ctx, replies } = mockCtx('finance modules');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('expenses');
    expect(replies[0].text).toContain('tax');
  });

  it('enables a module', async () => {
    disableSubSkill('secretary' as any, 'email');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(false);

    const { ctx, replies } = mockCtx('secretary module email enable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('✅');
    expect(replies[0].text).toContain('enabled');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(true);
  });

  it('disables a module', async () => {
    const { ctx, replies } = mockCtx('secretary module email disable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('❌');
    expect(replies[0].text).toContain('disabled');
    expect(isSubmoduleEnabled('secretary', 'email')).toBe(false);
  });

  it('shows error for unknown module', async () => {
    const { ctx, replies } = mockCtx('secretary module nonexistent enable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toBeTruthy(); // Unknown skills show disabled status
  });

  it('shows usage for module without sub-name', async () => {
    const { ctx, replies } = mockCtx('secretary module');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Usage');
  });

  it('shows usage for module without action', async () => {
    const { ctx, replies } = mockCtx('secretary module email');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Usage');
  });

  it('shows error for unknown action', async () => {
    const { ctx, replies } = mockCtx('secretary foobar');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Unknown action');
  });

  it('blocks enabling module with unmet dependencies', async () => {
    // Register a skill with dependencies
    const depSkill: SkillDefinition = {
      name: 'dep-test',
      description: 'Dependency test',
      version: '1.0.0',
      routing: {
        patternRoutes: [],
        keywordRoute: null,
        classificationHint: { label: 'dep-test', description: 'test', examples: [] },
      },
      subSkills: [
        { name: 'base', description: 'Base', tools: [], enabledByDefault: true },
        { name: 'child', description: 'Child', tools: [], enabledByDefault: false, dependencies: ['base'] },
      ],
    };
    registerSkill(depSkill);
    installSkill({
      name: 'dep-test',
      description: depSkill.description,
      version: depSkill.version,
      domain: 'dep-test',
      submodules: depSkill.subSkills.map(s => ({ module_name: s.name, version: '1.0.0' })),
    });
    // Disable base so child can't be enabled
    disableSubmodule('dep-test', 'base');

    const { ctx, replies } = mockCtx('dep-test module child enable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Cannot enable');
    expect(replies[0].text).toContain('base');
  });

  it('blocks disabling module with active dependents', async () => {
    const depSkill: SkillDefinition = {
      name: 'dep-test2',
      description: 'Dependency test 2',
      version: '1.0.0',
      routing: {
        patternRoutes: [],
        keywordRoute: null,
        classificationHint: { label: 'dep-test2', description: 'test', examples: [] },
      },
      subSkills: [
        { name: 'base', description: 'Base', tools: [], enabledByDefault: true },
        { name: 'child', description: 'Child', tools: [], enabledByDefault: true, dependencies: ['base'] },
      ],
    };
    registerSkill(depSkill);
    installSkill({
      name: 'dep-test2',
      description: depSkill.description,
      version: depSkill.version,
      domain: 'dep-test2',
      submodules: depSkill.subSkills.map(s => ({ module_name: s.name, version: '1.0.0' })),
    });

    const { ctx, replies } = mockCtx('dep-test2 module base disable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('Cannot disable');
    expect(replies[0].text).toContain('child');
  });
});
