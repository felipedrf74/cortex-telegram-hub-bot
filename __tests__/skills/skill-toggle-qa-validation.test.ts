/**
 * QA Validation Tests — Skill Enable/Disable + Sub-Module Toggle Commands
 *
 * Validates the /skill <name> enable|disable feature implemented by the backend agent.
 * Focus areas:
 * 1. handleSkillCommand correctly detects unknown skills (not-found vs detail view)
 * 2. Enable/disable flow updates registry and invalidates tool cache
 * 3. Dependency checking blocks enable when deps unmet, disable when dependents active
 * 4. Bot.ts wiring: /skill command delegates to handleSkillCommand
 * 5. parseSkillArgs covers all argument shapes
 * 6. formatters produce correct HTML with escaping
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const ROOT = path.resolve(__dirname, '../..');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (!applied) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
    }
  }
}

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  seedDefaultSkills,
  getSkillStatus,
  enableSkill, disableSkill,
  enableSubSkill, disableSubSkill,
  invalidateToolCache,
  getToolsForDomain,
} from '../../src/skills/skill-manager';
import {
  DEFAULT_SKILLS,
  getSkillDefinition,
  getSubSkillDependencies,
  getSubSkillDependents,
  registerSkill,
  _resetRegistry,
} from '../../src/skills/skill-config';
import type { SkillDefinition } from '../../src/skills/skill-config';
import {
  handleSkillCommand,
  parseSkillArgs,
  formatSkillDetail,
  formatToggleResult,
  checkEnableDependencies,
  checkDisableDependents,
  formatDependencyError,
} from '../../src/commands/skills';
import { install as installSkill, disableSubmodule, isSubmoduleEnabled } from '../../src/skills/registry';
import type { DefaultDomainName } from '../../src/domains/types';

beforeEach(() => {
  testDb = createTestDb();
  applyMigrations(testDb);
  invalidateToolCache();
  _resetRegistry();
  seedDefaultSkills();
});

afterEach(() => {
  testDb.close();
});

// ── Helper ──────────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════
// QA: UNKNOWN SKILL DETECTION (BUG FIX VALIDATION)
// ═══════════════════════════════════════════════════════════════════

describe('QA: unknown skill detection in handleSkillCommand', () => {
  it('BUG FIX: getSkillDefinition returns undefined for unknown skills', () => {
    // getSkillStatus always returns an object (never null), so handleSkillCommand
    // must use getSkillDefinition to detect unknown skills before calling getSkillStatus.
    const def = getSkillDefinition('totally-unknown');
    expect(def).toBeUndefined();
  });

  it('BUG FIX: handleSkillCommand replies "not found" for unknown skill', async () => {
    const { ctx, replies } = mockCtx('nonexistent-skill');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('not found');
    expect(replies[0].text).not.toContain('Sub-modules');
  });

  it('BUG FIX: handleSkillCommand does not show detail view for unknown skill', async () => {
    const { ctx, replies } = mockCtx('foobar');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).not.toContain('Enabled');
    expect(replies[0].text).not.toContain('Disabled');
    expect(replies[0].text).toContain('not found');
  });

  it('unknown skill with enable action still shows not found', async () => {
    const { ctx, replies } = mockCtx('fake-skill enable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('not found');
  });

  it('unknown skill with disable action still shows not found', async () => {
    const { ctx, replies } = mockCtx('fake-skill disable');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('not found');
  });

  it('unknown skill with modules action still shows not found', async () => {
    const { ctx, replies } = mockCtx('fake-skill modules');
    await handleSkillCommand(ctx as any);
    expect(replies[0].text).toContain('not found');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: ENABLE/DISABLE ROUND-TRIP FOR ALL DEFAULT SKILLS
// ═══════════════════════════════════════════════════════════════════

describe('QA: enable/disable round-trip for each default skill', () => {
  for (const domain of Object.keys(DEFAULT_SKILLS) as DefaultDomainName[]) {
    it(`${domain}: disable → verify disabled → re-enable → verify enabled`, () => {
      // Initially enabled
      expect(getSkillStatus(domain).enabled).toBe(true);

      // Disable
      const didDisable = disableSkill(domain);
      expect(didDisable).toBe(true);
      expect(getSkillStatus(domain).enabled).toBe(false);

      // Re-enable
      const didEnable = enableSkill(domain);
      expect(didEnable).toBe(true);
      expect(getSkillStatus(domain).enabled).toBe(true);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// QA: SUB-MODULE TOGGLE FOR EACH DOMAIN
// ═══════════════════════════════════════════════════════════════════

describe('QA: sub-module toggle works for every default sub-skill', () => {
  for (const domain of Object.keys(DEFAULT_SKILLS) as DefaultDomainName[]) {
    const def = DEFAULT_SKILLS[domain];
    const enabledByDefaultSubs = def.subSkills.filter(s => s.enabledByDefault);

    for (const sub of enabledByDefaultSubs) {
      it(`${domain}.${sub.name}: disable → verify disabled → re-enable → verify enabled`, () => {
        expect(isSubmoduleEnabled(domain, sub.name)).toBe(true);

        disableSubSkill(domain, sub.name);
        expect(isSubmoduleEnabled(domain, sub.name)).toBe(false);

        enableSubSkill(domain, sub.name);
        expect(isSubmoduleEnabled(domain, sub.name)).toBe(true);
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════
// QA: DEPENDENCY INFRASTRUCTURE VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('QA: dependency infrastructure', () => {
  it('SubSkillDefinition supports optional dependencies field', () => {
    const configSource = fs.readFileSync(
      path.join(ROOT, 'src', 'skills', 'skill-config.ts'), 'utf-8',
    );
    expect(configSource).toContain('dependencies?: string[]');
  });

  it('getSubSkillDependencies returns empty array for sub-skills without deps', () => {
    for (const domain of Object.keys(DEFAULT_SKILLS) as DefaultDomainName[]) {
      const def = DEFAULT_SKILLS[domain];
      for (const sub of def.subSkills) {
        if (!sub.dependencies || sub.dependencies.length === 0) {
          const deps = getSubSkillDependencies(domain, sub.name);
          expect(deps).toEqual([]);
        }
      }
    }
  });

  it('getSubSkillDependents returns empty array for unknown domains', () => {
    expect(getSubSkillDependents('nonexistent', 'foo')).toEqual([]);
  });

  it('checkEnableDependencies returns ok for module without dependencies', () => {
    const result = checkEnableDependencies('secretary', 'tasks');
    expect(result.ok).toBe(true);
  });

  it('checkDisableDependents returns ok for module without dependents', () => {
    const result = checkDisableDependents('secretary', 'tasks');
    expect(result.ok).toBe(true);
  });

  it('dependency checking works with custom skill that has dependencies', () => {
    const depSkill: SkillDefinition = {
      name: 'qa-dep-test',
      description: 'QA dependency test',
      version: '1.0.0',
      routing: {
        patternRoutes: [],
        keywordRoute: null,
        classificationHint: { label: 'qa-dep-test', description: 'test', examples: [] },
      },
      subSkills: [
        { name: 'garmin-sync', description: 'Garmin data sync', tools: [], enabledByDefault: true },
        { name: 'coach-briefing', description: 'Coach briefing', tools: [], enabledByDefault: false, dependencies: ['garmin-sync'] },
      ],
    };
    registerSkill(depSkill);
    installSkill({
      name: 'qa-dep-test',
      description: depSkill.description,
      version: depSkill.version,
      domain: 'qa-dep-test',
      submodules: depSkill.subSkills.map(s => ({ module_name: s.name, version: '1.0.0' })),
    });
    disableSubmodule('qa-dep-test', 'coach-briefing');

    // Can't enable coach-briefing with garmin-sync disabled
    disableSubmodule('qa-dep-test', 'garmin-sync');
    const enableCheck = checkEnableDependencies('qa-dep-test', 'coach-briefing');
    expect(enableCheck.ok).toBe(false);
    expect(enableCheck.missing).toContain('garmin-sync');

    // Can't disable garmin-sync when coach-briefing depends on it and is active
    // Re-enable both first
    enableSubSkill('qa-dep-test' as any, 'garmin-sync');
    enableSubSkill('qa-dep-test' as any, 'coach-briefing');
    const disableCheck = checkDisableDependents('qa-dep-test', 'garmin-sync');
    expect(disableCheck.ok).toBe(false);
    expect(disableCheck.dependents).toContain('coach-briefing');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: COMMAND WIRING IN BOT.TS
// ═══════════════════════════════════════════════════════════════════

describe('QA: bot.ts command wiring for skill toggles', () => {
  it('bot.ts imports handleSkillCommand from commands/skills', () => {
    const botSource = fs.readFileSync(path.join(ROOT, 'src', 'bot.ts'), 'utf-8');
    expect(botSource).toContain("handleSkillCommand");
    expect(botSource).toContain("from './commands/skills'");
  });

  it('bot.ts registers /skill command handler', () => {
    const botSource = fs.readFileSync(path.join(ROOT, 'src', 'bot.ts'), 'utf-8');
    expect(botSource).toContain("bot.command('skill'");
  });

  it('help text includes new skill toggle commands', () => {
    const botSource = fs.readFileSync(path.join(ROOT, 'src', 'bot.ts'), 'utf-8');
    expect(botSource).toContain('/skill [name] enable|disable');
    expect(botSource).toContain('/skill [name] modules');
    expect(botSource).toContain('/skill [name] module [sub] enable|disable');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: FORMATTER OUTPUT CORRECTNESS
// ═══════════════════════════════════════════════════════════════════

describe('QA: formatter output validation', () => {
  it('formatToggleResult includes correct icon for enable/disable', () => {
    const enableMsg = formatToggleResult('cooking', 'enabled', false);
    expect(enableMsg).toContain('✅');
    expect(enableMsg).not.toContain('❌');

    const disableMsg = formatToggleResult('cooking', 'disabled', false);
    expect(disableMsg).toContain('❌');
    expect(disableMsg).not.toContain('✅');
  });

  it('formatToggleResult differentiates Skill vs Module', () => {
    const skillMsg = formatToggleResult('cooking', 'enabled', false);
    expect(skillMsg).toContain('Skill');

    const moduleMsg = formatToggleResult('email', 'enabled', true, 'secretary');
    expect(moduleMsg).toContain('Module');
    expect(moduleMsg).toContain('secretary');
  });

  it('formatDependencyError includes all missing deps and correct instructions', () => {
    const enableErr = formatDependencyError('enable', 'top', {
      ok: false,
      missing: ['base', 'middle'],
    });
    expect(enableErr).toContain('Cannot enable');
    expect(enableErr).toContain('base');
    expect(enableErr).toContain('middle');
    expect(enableErr).toContain('Enable the required');

    const disableErr = formatDependencyError('disable', 'base', {
      ok: false,
      dependents: ['child'],
    });
    expect(disableErr).toContain('Cannot disable');
    expect(disableErr).toContain('child');
    expect(disableErr).toContain('Disable the dependent');
  });

  it('formatSkillDetail shows command hints for toggles', () => {
    const status = getSkillStatus('secretary');
    const output = formatSkillDetail(status);
    expect(output).toContain('/skill secretary enable');
    expect(output).toContain('/skill secretary modules');
    expect(output).toContain('module');
    expect(output).toContain('enable');
    expect(output).toContain('disable');
  });
});

// ═══════════════════════════════════════════════════════════════════
// QA: parseSkillArgs EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('QA: parseSkillArgs edge cases', () => {
  it('handles only whitespace', () => {
    expect(parseSkillArgs('   ')).toEqual({ skillName: '' });
  });

  it('handles tab characters', () => {
    expect(parseSkillArgs('cooking\tenable')).toEqual({ skillName: 'cooking', action: 'enable' });
  });

  it('normalizes mixed case to lowercase', () => {
    expect(parseSkillArgs('SECRETARY MODULES')).toEqual({ skillName: 'secretary', action: 'modules' });
  });

  it('handles module with extra trailing words (ignored)', () => {
    const result = parseSkillArgs('secretary module email enable extra-stuff');
    expect(result.skillName).toBe('secretary');
    expect(result.action).toBe('module');
    expect(result.subName).toBe('email');
    expect(result.subAction).toBe('enable');
  });
});
