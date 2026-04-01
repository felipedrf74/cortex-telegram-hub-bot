/**
 * QA Validation Tests — SkillRegistry + SkillLoader Integration
 *
 * Covers gaps not addressed by existing test files:
 *   1. SkillLoader module loading: factory functions, ESM default exports,
 *      modules missing NexusSkill interface (duck-type check)
 *   2. loadAll() cycle path: loads healthy skills while skipping cycled ones
 *   3. Sub-module dependency scenarios across install/uninstall lifecycle
 *   4. Registry _resetStmts() re-preparation path
 *   5. installFromManifest() with complex subModules
 *   6. SkillLoader full lifecycle with real filesystem + require() integration
 *   7. Additional edge cases for enable/disable dependency guards
 *
 * QA agent: agent/qa
 * Validating: src/skills/registry.ts, src/skills/loader.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { SkillManifest, NexusSkill } from '../../src/skills/types';

// ─── Import loader utilities (no DB mock needed) ──────────────────

import {
  parseSemVer,
  satisfiesSemVer,
  resolveDependencies,
  validateManifest,
  SkillLoader,
} from '../../src/skills/loader';

// ─── DB Test Helpers ──────────────────────────────────────────────

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
  }

  return db;
}

// ─── Mock getDb for registry ──────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  install,
  installFromManifest,
  uninstall,
  enable,
  disable,
  getEnabled,
  getByName,
  getByDomain,
  getAll,
  getSubmodules,
  enableSubmodule,
  disableSubmodule,
  updateConfig,
  _resetStmts,
} from '../../src/skills/registry';

// ─── Manifest + Skill Factories ───────────────────────────────────

function createManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    description: 'A test skill',
    author: 'Test Author',
    license: 'MIT',
    hubVersion: '>=1.0.0',
    platforms: ['telegram'],
    category: 'productivity',
    tier: 'private',
    ...overrides,
  };
}

function createMockSkill(manifest?: SkillManifest): NexusSkill {
  const m = manifest ?? createManifest();
  return {
    manifest: m,
    install: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    getPatternRoutes: vi.fn().mockReturnValue([]),
    getKeywordRoutes: vi.fn().mockReturnValue([]),
    getClassificationHints: vi.fn().mockReturnValue({
      label: m.id,
      description: m.description,
      examples: ['test message'],
    }),
    handle: vi.fn().mockResolvedValue({ text: 'ok', skillId: m.id }),
    getTools: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue({}),
    getSubModules: vi.fn().mockReturnValue([]),
    enableSubModule: vi.fn().mockResolvedValue(undefined),
    disableSubModule: vi.fn().mockResolvedValue(undefined),
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. REGISTRY: _resetStmts() re-preparation
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillRegistry — _resetStmts re-preparation', () => {
  beforeEach(() => {
    testDb = createTestDb();
    _resetStmts();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should work correctly after _resetStmts (re-prepares statements)', () => {
    // Install with original DB
    install({ name: 'before-reset' });
    expect(getByName('before-reset')).toBeDefined();

    // Reset statements and switch to fresh DB
    testDb.close();
    testDb = createTestDb();
    _resetStmts();

    // Operations should work on the new DB
    install({ name: 'after-reset' });
    expect(getByName('after-reset')).toBeDefined();
    // 'before-reset' should not exist in new DB
    expect(getByName('before-reset')).toBeUndefined();
  });

  it('should allow multiple _resetStmts calls without error', () => {
    _resetStmts();
    _resetStmts();
    _resetStmts();
    install({ name: 'multi-reset' });
    expect(getByName('multi-reset')).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. REGISTRY: installFromManifest with complex subModules
// ═══════════════════════════════════════════════════════════════════

describe('QA: installFromManifest — complex subModule scenarios', () => {
  beforeEach(() => {
    testDb = createTestDb();
    _resetStmts();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should install manifest with no subModules', () => {
    const manifest = createManifest({ id: 'no-subs' });
    const row = installFromManifest(manifest);
    expect(row.name).toBe('no-subs');
    expect(getSubmodules(row.id)).toHaveLength(0);
  });

  it('should install manifest with multiple subModules having dependencies', () => {
    const manifest = createManifest({
      id: 'complex-subs',
      subModules: [
        { id: 'base', name: 'Base', description: 'Core features', default: true },
        {
          id: 'advanced',
          name: 'Advanced',
          description: 'Advanced features',
          default: false,
          dependencies: ['base'],
        },
        {
          id: 'premium',
          name: 'Premium',
          description: 'Premium features',
          default: false,
          dependencies: ['base', 'advanced'],
          requiredEnvVars: ['PREMIUM_KEY'],
        },
      ],
    });

    const row = installFromManifest(manifest);
    const subs = getSubmodules(row.id);

    expect(subs).toHaveLength(3);
    expect(subs.map(s => s.module_name).sort()).toEqual(['advanced', 'base', 'premium']);
    // All submodules should inherit the manifest version
    expect(subs.every(s => s.version === '1.0.0')).toBe(true);
  });

  it('should upsert submodules on reinstall', () => {
    const manifest1 = createManifest({
      id: 'upsert-subs',
      version: '1.0.0',
      subModules: [
        { id: 'mod-a', name: 'A', description: 'Mod A', default: true },
      ],
    });

    const row1 = installFromManifest(manifest1);
    expect(getSubmodules(row1.id)).toHaveLength(1);

    // Reinstall with updated version — same submodule name, should upsert
    const manifest2 = createManifest({
      id: 'upsert-subs',
      version: '2.0.0',
      subModules: [
        { id: 'mod-a', name: 'A', description: 'Mod A Updated', default: true },
        { id: 'mod-b', name: 'B', description: 'Mod B', default: false },
      ],
    });

    const row2 = installFromManifest(manifest2);
    const subs = getSubmodules(row2.id);

    expect(subs).toHaveLength(2);
    expect(row2.version).toBe('2.0.0');
  });

  it('should pass domain and config through installFromManifest', () => {
    const manifest = createManifest({ id: 'with-opts' });
    const row = installFromManifest(manifest, {
      domain: 'triathlon',
      config: { apiEndpoint: 'https://example.com' },
    });

    expect(row.domain).toBe('triathlon');
    const parsed = JSON.parse(row.config_json!);
    expect(parsed.apiEndpoint).toBe('https://example.com');
  });

  it('should handle manifest with empty subModules array', () => {
    const manifest = createManifest({ id: 'empty-subs', subModules: [] });
    const row = installFromManifest(manifest);
    expect(getSubmodules(row.id)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. REGISTRY: install/uninstall lifecycle with submodule state
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillRegistry — submodule lifecycle', () => {
  beforeEach(() => {
    testDb = createTestDb();
    _resetStmts();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should enable/disable individual submodules independently', () => {
    const row = install({
      name: 'sub-lifecycle',
      submodules: [
        { module_name: 'auth' },
        { module_name: 'logging' },
        { module_name: 'metrics' },
      ],
    });

    // All start enabled by default (SQLite default)
    const initial = getSubmodules(row.id);
    expect(initial.every(s => s.enabled === 1)).toBe(true);

    // Disable 'logging' only
    disableSubmodule(row.id, 'logging');
    const afterDisable = getSubmodules(row.id);
    expect(afterDisable.find(s => s.module_name === 'auth')!.enabled).toBe(1);
    expect(afterDisable.find(s => s.module_name === 'logging')!.enabled).toBe(0);
    expect(afterDisable.find(s => s.module_name === 'metrics')!.enabled).toBe(1);

    // Re-enable 'logging'
    enableSubmodule(row.id, 'logging');
    const afterEnable = getSubmodules(row.id);
    expect(afterEnable.find(s => s.module_name === 'logging')!.enabled).toBe(1);
  });

  it('should preserve submodule state across skill disable/enable', () => {
    const row = install({
      name: 'preserve-sub-state',
      submodules: [
        { module_name: 'mod-a' },
        { module_name: 'mod-b' },
      ],
    });

    // Disable one submodule
    disableSubmodule(row.id, 'mod-b');

    // Disable and re-enable the parent skill
    disable('preserve-sub-state');
    enable('preserve-sub-state');

    // Submodule state should be preserved
    const subs = getSubmodules(row.id);
    expect(subs.find(s => s.module_name === 'mod-a')!.enabled).toBe(1);
    expect(subs.find(s => s.module_name === 'mod-b')!.enabled).toBe(0);
  });

  it('should handle submodule upsert with config', () => {
    const row = install({
      name: 'sub-config',
      submodules: [
        { module_name: 'configurable', version: '1.0.0', config: { setting: 'initial' } },
      ],
    });

    const initial = getSubmodules(row.id);
    expect(initial[0].config_json).toBe('{"setting":"initial"}');

    // Reinstall with updated config — upsert should update config
    install({
      name: 'sub-config',
      submodules: [
        { module_name: 'configurable', version: '2.0.0', config: { setting: 'updated' } },
      ],
    });

    const updated = getSubmodules(row.id);
    expect(updated[0].version).toBe('2.0.0');
    expect(JSON.parse(updated[0].config_json!).setting).toBe('updated');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. REGISTRY: getByDomain filtering with mixed states
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillRegistry — domain filtering edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    _resetStmts();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should not return disabled skills for domain', () => {
    install({ name: 'tri-active', domain: 'triathlon' });
    install({ name: 'tri-inactive', domain: 'triathlon' });
    disable('tri-inactive');

    const result = getByDomain('triathlon');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('tri-active');
  });

  it('should return skills with null domain only via getAll/getByName', () => {
    install({ name: 'no-domain' }); // domain = null
    expect(getByDomain('triathlon')).toHaveLength(0);
    expect(getByName('no-domain')).toBeDefined();
  });

  it('should handle multiple domains correctly', () => {
    install({ name: 'tri-1', domain: 'triathlon' });
    install({ name: 'sec-1', domain: 'secretary' });
    install({ name: 'con-1', domain: 'content' });
    install({ name: 'sec-2', domain: 'secretary' });

    expect(getByDomain('triathlon')).toHaveLength(1);
    expect(getByDomain('secretary')).toHaveLength(2);
    expect(getByDomain('content')).toHaveLength(1);
    expect(getAll()).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. LOADER: Module loading branches (factory, default, duck-type)
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — module export formats', () => {
  const skillsDir = path.join(__dirname, '.tmp-qa-loader-exports');

  function writeManifest(id: string, manifest: Record<string, unknown>): string {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  }

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    // Clear require cache
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
    delete (globalThis as Record<string, unknown>).__qaTestSkills;
  });

  it('should load skill exported as direct module.exports object', async () => {
    const manifest = createManifest({ id: 'direct-export', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    const dir = writeManifest('direct-export', manifest);

    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['direct-export'] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['direct-export'];`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual(['direct-export']);
    expect(loader.getSkill('direct-export')).toBeDefined();
  });

  it('should load skill exported as factory function', async () => {
    const manifest = createManifest({ id: 'factory-export', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    const dir = writeManifest('factory-export', manifest);

    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['factory-export'] = () => skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['factory-export'];`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual(['factory-export']);
  });

  it('should load skill exported as module.exports.default', async () => {
    const manifest = createManifest({ id: 'default-export', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    const dir = writeManifest('default-export', manifest);

    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['default-export'] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = { default: globalThis.__qaTestSkills['default-export'] };`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual(['default-export']);
  });

  it('should load skill exported as module.exports.default factory', async () => {
    const manifest = createManifest({ id: 'default-factory', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    const dir = writeManifest('default-factory', manifest);

    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['default-factory'] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = { default: () => globalThis.__qaTestSkills['default-factory'] };`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual(['default-factory']);
  });

  it('should skip module that does not implement NexusSkill interface', async () => {
    const manifest = createManifest({ id: 'bad-interface', hubVersion: '>=1.0.0' });
    const dir = writeManifest('bad-interface', manifest);

    // Module exports an object without handle() or install()
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = { name: 'not a skill', version: '1.0.0' };`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('does not implement NexusSkill');
  });

  it('should skip module that throws on require()', async () => {
    const manifest = createManifest({ id: 'throw-on-load', hubVersion: '>=1.0.0' });
    const dir = writeManifest('throw-on-load', manifest);

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `throw new Error('Module initialization failed');`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('load error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. LOADER: loadAll() with cycles — loads healthy, skips cycled
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — loadAll with circular dependencies', () => {
  const skillsDir = path.join(__dirname, '.tmp-qa-loader-cycles');

  function setupSkill(id: string, manifest: SkillManifest): void {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const skill = createMockSkill(manifest);
    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)[id] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['${id}'];`,
    );
  }

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
    delete (globalThis as Record<string, unknown>).__qaTestSkills;
  });

  it('should load healthy skills while skipping those in a cycle', async () => {
    // 'healthy' has no deps — should load
    setupSkill('healthy', createManifest({ id: 'healthy', hubVersion: '>=1.0.0' }));

    // 'cycle-a' and 'cycle-b' depend on each other — should be skipped
    setupSkill('cycle-a', createManifest({
      id: 'cycle-a',
      hubVersion: '>=1.0.0',
      dependencies: ['cycle-b'],
    }));
    setupSkill('cycle-b', createManifest({
      id: 'cycle-b',
      hubVersion: '>=1.0.0',
      dependencies: ['cycle-a'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toContain('healthy');
    expect(result.loaded).not.toContain('cycle-a');
    expect(result.loaded).not.toContain('cycle-b');

    const cycleSkipped = result.skipped.filter(s =>
      s.id === 'cycle-a' || s.id === 'cycle-b',
    );
    expect(cycleSkipped).toHaveLength(2);
    expect(cycleSkipped.every(s => s.reason.includes('circular dependency'))).toBe(true);
  });

  it('should load skills with missing deps and load others', async () => {
    // 'good' has no deps — should load
    setupSkill('good', createManifest({ id: 'good', hubVersion: '>=1.0.0' }));

    // 'needy' depends on 'nonexistent' — should be skipped
    setupSkill('needy', createManifest({
      id: 'needy',
      hubVersion: '>=1.0.0',
      dependencies: ['nonexistent'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toContain('good');
    expect(result.loaded).not.toContain('needy');
    expect(result.skipped.find(s => s.id === 'needy')?.reason).toContain('missing dependencies');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. LOADER: Dependency guards — advanced scenarios
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — advanced dependency guard scenarios', () => {
  const skillsDir = path.join(__dirname, '.tmp-qa-loader-depguards');

  function setupSkill(id: string, manifest: SkillManifest): NexusSkill {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const skill = createMockSkill(manifest);
    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)[id] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['${id}'];`,
    );

    return skill;
  }

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
    delete (globalThis as Record<string, unknown>).__qaTestSkills;
  });

  it('should enforce dependency chain: A → B → C (must enable in order)', async () => {
    setupSkill('chain-a', createManifest({ id: 'chain-a', hubVersion: '>=1.0.0' }));
    setupSkill('chain-b', createManifest({
      id: 'chain-b',
      hubVersion: '>=1.0.0',
      dependencies: ['chain-a'],
    }));
    setupSkill('chain-c', createManifest({
      id: 'chain-c',
      hubVersion: '>=1.0.0',
      dependencies: ['chain-b'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    // Cannot enable C without B
    await expect(loader.enableSkill('chain-c')).rejects.toThrow('dependency "chain-b" is not enabled');

    // Cannot enable B without A
    await expect(loader.enableSkill('chain-b')).rejects.toThrow('dependency "chain-a" is not enabled');

    // Enable in correct order
    await loader.enableSkill('chain-a');
    await loader.enableSkill('chain-b');
    await loader.enableSkill('chain-c');

    expect(loader.getEnabledSkillIds().sort()).toEqual(['chain-a', 'chain-b', 'chain-c']);
  });

  it('should prevent disabling middle of chain when leaf depends on it', async () => {
    setupSkill('base', createManifest({ id: 'base', hubVersion: '>=1.0.0' }));
    setupSkill('middle', createManifest({
      id: 'middle',
      hubVersion: '>=1.0.0',
      dependencies: ['base'],
    }));
    setupSkill('leaf', createManifest({
      id: 'leaf',
      hubVersion: '>=1.0.0',
      dependencies: ['middle'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('base');
    await loader.enableSkill('middle');
    await loader.enableSkill('leaf');

    // Cannot disable middle — leaf depends on it
    await expect(loader.disableSkill('middle')).rejects.toThrow('skill "leaf" depends on it');

    // Cannot disable base — middle depends on it
    await expect(loader.disableSkill('base')).rejects.toThrow('skill "middle" depends on it');

    // Must disable in reverse order
    await loader.disableSkill('leaf');
    await loader.disableSkill('middle');
    await loader.disableSkill('base');

    expect(loader.getEnabledSkillIds()).toEqual([]);
  });

  it('should allow disabling skill when dependent is already disabled', async () => {
    setupSkill('provider', createManifest({ id: 'provider', hubVersion: '>=1.0.0' }));
    const consumerSkill = setupSkill('consumer', createManifest({
      id: 'consumer',
      hubVersion: '>=1.0.0',
      dependencies: ['provider'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('provider');
    await loader.enableSkill('consumer');
    await loader.disableSkill('consumer');

    // Now provider can be disabled since consumer is off
    await loader.disableSkill('provider');
    expect(loader.getEnabledSkillIds()).toEqual([]);
  });

  it('should call lifecycle methods in correct order during uninstall', async () => {
    const callOrder: string[] = [];
    const skill = setupSkill('lifecycle-order', createManifest({
      id: 'lifecycle-order',
      hubVersion: '>=1.0.0',
    }));

    (skill.install as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('install'); });
    (skill.enable as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('enable'); });
    (skill.disable as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('disable'); });
    (skill.uninstall as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('uninstall'); });

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('lifecycle-order');
    await loader.uninstallSkill('lifecycle-order');

    expect(callOrder).toEqual(['install', 'enable', 'disable', 'uninstall']);
    expect(loader.size).toBe(0);
  });

  it('should handle diamond dependency: D depends on B and C, both depend on A', async () => {
    setupSkill('diamond-a', createManifest({ id: 'diamond-a', hubVersion: '>=1.0.0' }));
    setupSkill('diamond-b', createManifest({
      id: 'diamond-b',
      hubVersion: '>=1.0.0',
      dependencies: ['diamond-a'],
    }));
    setupSkill('diamond-c', createManifest({
      id: 'diamond-c',
      hubVersion: '>=1.0.0',
      dependencies: ['diamond-a'],
    }));
    setupSkill('diamond-d', createManifest({
      id: 'diamond-d',
      hubVersion: '>=1.0.0',
      dependencies: ['diamond-b', 'diamond-c'],
    }));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    // All should load successfully
    expect(result.loaded).toHaveLength(4);

    // Enable in dependency order
    await loader.enableSkill('diamond-a');
    await loader.enableSkill('diamond-b');
    await loader.enableSkill('diamond-c');
    await loader.enableSkill('diamond-d');

    // Cannot disable A — B and C depend on it
    await expect(loader.disableSkill('diamond-a')).rejects.toThrow();

    // Disable D first, then B and C, then A
    await loader.disableSkill('diamond-d');
    await loader.disableSkill('diamond-b');
    await loader.disableSkill('diamond-c');
    await loader.disableSkill('diamond-a');

    expect(loader.getEnabledSkillIds()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. LOADER: Registration queries with multiple enabled/disabled
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — registration queries with mixed states', () => {
  const skillsDir = path.join(__dirname, '.tmp-qa-loader-queries');

  function setupSkill(id: string, manifest: SkillManifest, skillOverrides?: Partial<NexusSkill>): void {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const skill = createMockSkill(manifest);
    if (skillOverrides) {
      Object.assign(skill, skillOverrides);
    }

    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)[id] = skill;

    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['${id}'];`,
    );
  }

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
    delete (globalThis as Record<string, unknown>).__qaTestSkills;
  });

  it('should aggregate tools from multiple enabled skills', async () => {
    setupSkill('tool-a', createManifest({ id: 'tool-a', hubVersion: '>=1.0.0' }), {
      getTools: vi.fn().mockReturnValue([
        { name: 'tool_a_action', description: 'A action', inputSchema: {} },
      ]),
    });
    setupSkill('tool-b', createManifest({ id: 'tool-b', hubVersion: '>=1.0.0' }), {
      getTools: vi.fn().mockReturnValue([
        { name: 'tool_b_action1', description: 'B action 1', inputSchema: {} },
        { name: 'tool_b_action2', description: 'B action 2', inputSchema: {} },
      ]),
    });

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    await loader.enableSkill('tool-a');
    await loader.enableSkill('tool-b');

    const tools = loader.getAllTools();
    expect(tools).toHaveLength(3);
    expect(tools.map(t => t.name).sort()).toEqual([
      'tool_a_action',
      'tool_b_action1',
      'tool_b_action2',
    ]);
  });

  it('should not include routes from skills with empty route arrays', async () => {
    setupSkill('no-routes', createManifest({ id: 'no-routes', hubVersion: '>=1.0.0' }), {
      getPatternRoutes: vi.fn().mockReturnValue([]),
      getKeywordRoutes: vi.fn().mockReturnValue([]),
    });

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    await loader.enableSkill('no-routes');

    expect(loader.getAllPatternRoutes()).toEqual([]);
    expect(loader.getAllKeywordRoutes()).toEqual([]);
    // Classification hints are always returned for enabled skills
    expect(loader.getAllClassificationHints()).toHaveLength(1);
  });

  it('should route tool execution to correct skill among multiple', async () => {
    setupSkill('exec-a', createManifest({ id: 'exec-a', hubVersion: '>=1.0.0' }), {
      getTools: vi.fn().mockReturnValue([
        { name: 'exec_a_do', description: 'Do A', inputSchema: {} },
      ]),
      executeTool: vi.fn().mockResolvedValue({ result: 'from-a' }),
    });
    setupSkill('exec-b', createManifest({ id: 'exec-b', hubVersion: '>=1.0.0' }), {
      getTools: vi.fn().mockReturnValue([
        { name: 'exec_b_do', description: 'Do B', inputSchema: {} },
      ]),
      executeTool: vi.fn().mockResolvedValue({ result: 'from-b' }),
    });

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    await loader.enableSkill('exec-a');
    await loader.enableSkill('exec-b');

    const resultA = await loader.executeTool('exec_a_do', { x: 1 });
    expect(resultA?.skillId).toBe('exec-a');
    expect(resultA?.result).toEqual({ result: 'from-a' });

    const resultB = await loader.executeTool('exec_b_do', { y: 2 });
    expect(resultB?.skillId).toBe('exec-b');
    expect(resultB?.result).toEqual({ result: 'from-b' });
  });

  it('should return null for tool on disabled skill', async () => {
    setupSkill('disabled-tools', createManifest({ id: 'disabled-tools', hubVersion: '>=1.0.0' }), {
      getTools: vi.fn().mockReturnValue([
        { name: 'disabled_tool', description: 'X', inputSchema: {} },
      ]),
    });

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    // Skill is loaded but NOT enabled

    const result = await loader.executeTool('disabled_tool', {});
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. LOADER: Sub-module default initialization
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — sub-module default initialization', () => {
  const skillsDir = path.join(__dirname, '.tmp-qa-loader-submods');

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
    delete (globalThis as Record<string, unknown>).__qaTestSkills;
  });

  it('should only enable sub-modules marked as default: true', async () => {
    const manifest = createManifest({
      id: 'sub-defaults',
      hubVersion: '>=1.0.0',
      subModules: [
        { id: 'always-on', name: 'Always On', description: 'Enabled by default', default: true },
        { id: 'opt-in', name: 'Opt In', description: 'Must be enabled manually', default: false },
        { id: 'also-on', name: 'Also On', description: 'Also default', default: true },
      ],
    });

    const dir = path.join(skillsDir, 'sub-defaults');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const skill = createMockSkill(manifest);
    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['sub-defaults'] = skill;
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['sub-defaults'];`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    const config = loader.getConfig('sub-defaults');
    expect(config?.enabledSubModules).toHaveLength(2);
    expect(config?.enabledSubModules).toContain('always-on');
    expect(config?.enabledSubModules).toContain('also-on');
    expect(config?.enabledSubModules).not.toContain('opt-in');
  });

  it('should handle manifest with no sub-modules', async () => {
    const manifest = createManifest({ id: 'no-submods', hubVersion: '>=1.0.0' });

    const dir = path.join(skillsDir, 'no-submods');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const skill = createMockSkill(manifest);
    (globalThis as Record<string, unknown>).__qaTestSkills =
      (globalThis as Record<string, unknown>).__qaTestSkills ?? {};
    ((globalThis as Record<string, unknown>).__qaTestSkills as Record<string, unknown>)['no-submods'] = skill;
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__qaTestSkills['no-submods'];`,
    );

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    const config = loader.getConfig('no-submods');
    expect(config?.enabledSubModules).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. SEMVER: Additional edge cases
// ═══════════════════════════════════════════════════════════════════

describe('QA: satisfiesSemVer — additional edge cases', () => {
  it('should handle major version boundary correctly', () => {
    expect(satisfiesSemVer('1.9.9', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemVer('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('should handle minor version comparison', () => {
    expect(satisfiesSemVer('1.1.0', '>1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.1', '>1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '>1.0.0')).toBe(false);
  });

  it('should handle patch version comparison', () => {
    expect(satisfiesSemVer('1.0.1', '>=1.0.1')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '>=1.0.1')).toBe(false);
  });

  it('should handle triple constraint range', () => {
    expect(satisfiesSemVer('1.5.3', '>=1.0.0 <2.0.0 >=1.5.0')).toBe(true);
    expect(satisfiesSemVer('1.4.9', '>=1.0.0 <2.0.0 >=1.5.0')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. DEPENDENCY RESOLUTION: additional edge cases
// ═══════════════════════════════════════════════════════════════════

describe('QA: resolveDependencies — additional edge cases', () => {
  function makeManifest(id: string, deps?: string[]): [string, SkillManifest] {
    return [id, createManifest({ id, dependencies: deps })];
  }

  it('should resolve self-dependency as cycle', () => {
    const manifests = new Map<string, SkillManifest>([
      makeManifest('self-ref', ['self-ref']),
    ]);

    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
    }
  });

  it('should resolve wide fan-out (A depended on by B, C, D, E)', () => {
    const manifests = new Map<string, SkillManifest>([
      makeManifest('root'),
      makeManifest('b', ['root']),
      makeManifest('c', ['root']),
      makeManifest('d', ['root']),
      makeManifest('e', ['root']),
    ]);

    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order[0]).toBe('root');
      expect(result.order).toHaveLength(5);
    }
  });

  it('should detect multiple missing deps on single skill', () => {
    const manifests = new Map<string, SkillManifest>([
      makeManifest('broken', ['missing-1', 'missing-2', 'missing-3']),
    ]);

    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'missing') {
      expect(result.errors[0].missingDeps).toHaveLength(3);
    }
  });

  it('should handle skill with empty dependencies array (no deps)', () => {
    const manifests = new Map<string, SkillManifest>([
      makeManifest('no-deps'),
      [
        'empty-deps',
        createManifest({ id: 'empty-deps', dependencies: [] }),
      ],
    ]);

    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toHaveLength(2);
    }
  });
});
