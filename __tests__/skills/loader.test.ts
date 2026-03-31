import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  parseSemVer,
  satisfiesSemVer,
  resolveDependencies,
  validateManifest,
  loadSkillPrompt,
  clearSkillPromptCache,
  SkillLoader,
} from '../../src/skills/loader';
import type { SkillManifest, NexusSkill, SkillConfig } from '../../src/skills/types';

// ─── Mock Skill Factory ───────────────────────────────────────────────

function createMockManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    author: 'Test Author',
    license: 'MIT',
    description: 'A test skill',
    hubVersion: '>=1.0.0',
    platforms: ['telegram'],
    category: 'productivity',
    tier: 'private',
    ...overrides,
  };
}

function createMockSkill(manifest?: SkillManifest): NexusSkill {
  const m = manifest ?? createMockManifest();
  return {
    manifest: m,
    install: vi.fn().mockResolvedValue(undefined),
    enable: vi.fn().mockResolvedValue(undefined),
    disable: vi.fn().mockResolvedValue(undefined),
    uninstall: vi.fn().mockResolvedValue(undefined),
    getPatternRoutes: vi.fn().mockReturnValue([]),
    getKeywordRoutes: vi.fn().mockReturnValue([]),
    getClassificationHints: vi.fn().mockReturnValue({
      label: 'test',
      description: 'Test skill',
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

// ─── parseSemVer ──────────────────────────────────────────────────────

describe('parseSemVer', () => {
  it('parses a standard version string', () => {
    expect(parseSemVer('4.4.1')).toEqual({ major: 4, minor: 4, patch: 1 });
  });

  it('parses version with leading/trailing whitespace', () => {
    expect(parseSemVer('  1.2.3  ')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('parses version with pre-release suffix', () => {
    expect(parseSemVer('1.0.0-beta.1')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('returns null for invalid strings', () => {
    expect(parseSemVer('abc')).toBeNull();
    expect(parseSemVer('')).toBeNull();
    expect(parseSemVer('1.2')).toBeNull();
    expect(parseSemVer('v1.2.3')).toBeNull();
  });
});

// ─── satisfiesSemVer ──────────────────────────────────────────────────

describe('satisfiesSemVer', () => {
  it('matches exact version', () => {
    expect(satisfiesSemVer('4.4.1', '4.4.1')).toBe(true);
    expect(satisfiesSemVer('4.4.1', '4.4.0')).toBe(false);
  });

  it('matches >= constraint', () => {
    expect(satisfiesSemVer('4.4.1', '>=4.0.0')).toBe(true);
    expect(satisfiesSemVer('4.4.1', '>=4.4.1')).toBe(true);
    expect(satisfiesSemVer('4.4.1', '>=5.0.0')).toBe(false);
  });

  it('matches < constraint', () => {
    expect(satisfiesSemVer('4.4.1', '<5.0.0')).toBe(true);
    expect(satisfiesSemVer('4.4.1', '<4.4.1')).toBe(false);
    expect(satisfiesSemVer('4.4.1', '<4.5.0')).toBe(true);
  });

  it('matches combined range (>=X <Y)', () => {
    expect(satisfiesSemVer('4.4.1', '>=4.0.0 <5.0.0')).toBe(true);
    expect(satisfiesSemVer('5.0.0', '>=4.0.0 <5.0.0')).toBe(false);
    expect(satisfiesSemVer('3.9.9', '>=4.0.0 <5.0.0')).toBe(false);
  });

  it('matches > and <= constraints', () => {
    expect(satisfiesSemVer('2.0.0', '>1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '>1.0.0')).toBe(false);
    expect(satisfiesSemVer('1.0.0', '<=1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.1', '<=1.0.0')).toBe(false);
  });

  it('returns false for invalid version', () => {
    expect(satisfiesSemVer('not-a-version', '>=1.0.0')).toBe(false);
  });

  it('returns false for invalid constraint', () => {
    expect(satisfiesSemVer('1.0.0', 'invalid')).toBe(false);
  });
});

// ─── resolveDependencies ──────────────────────────────────────────────

describe('resolveDependencies', () => {
  it('resolves skills with no dependencies', () => {
    const manifests = new Map<string, SkillManifest>([
      ['a', createMockManifest({ id: 'a' })],
      ['b', createMockManifest({ id: 'b' })],
    ]);
    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toHaveLength(2);
      expect(result.order).toContain('a');
      expect(result.order).toContain('b');
    }
  });

  it('resolves skills in dependency order', () => {
    const manifests = new Map<string, SkillManifest>([
      ['b', createMockManifest({ id: 'b', dependencies: ['a'] })],
      ['a', createMockManifest({ id: 'a' })],
    ]);
    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'));
    }
  });

  it('resolves a chain: a → b → c', () => {
    const manifests = new Map<string, SkillManifest>([
      ['c', createMockManifest({ id: 'c', dependencies: ['b'] })],
      ['a', createMockManifest({ id: 'a' })],
      ['b', createMockManifest({ id: 'b', dependencies: ['a'] })],
    ]);
    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'));
      expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('c'));
    }
  });

  it('detects missing dependencies', () => {
    const manifests = new Map<string, SkillManifest>([
      ['a', createMockManifest({ id: 'a', dependencies: ['missing'] })],
    ]);
    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'missing') {
      expect(result.errors[0].skillId).toBe('a');
      expect(result.errors[0].missingDeps).toEqual(['missing']);
    }
  });

  it('detects circular dependencies', () => {
    const manifests = new Map<string, SkillManifest>([
      ['a', createMockManifest({ id: 'a', dependencies: ['b'] })],
      ['b', createMockManifest({ id: 'b', dependencies: ['a'] })],
    ]);
    const result = resolveDependencies(manifests);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'cycle') {
      expect(result.error.cycle).toContain('a');
      expect(result.error.cycle).toContain('b');
    }
  });

  it('handles empty map', () => {
    const result = resolveDependencies(new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual([]);
    }
  });
});

// ─── validateManifest ─────────────────────────────────────────────────

describe('validateManifest', () => {
  it('validates a correct manifest', () => {
    const raw = {
      id: 'test-skill',
      name: 'Test',
      version: '1.0.0',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: ['telegram'],
      category: 'productivity',
      tier: 'private',
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('test-skill');
    }
  });

  it('rejects manifest with missing required fields', () => {
    const result = validateManifest({ id: 'partial' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain('name');
      expect(fields).toContain('version');
    }
  });

  it('rejects manifest with empty id', () => {
    const raw = {
      id: '',
      name: 'Test',
      version: '1.0.0',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: ['telegram'],
      category: 'productivity',
      tier: 'private',
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects manifest with invalid version', () => {
    const raw = {
      id: 'test',
      name: 'Test',
      version: 'bad',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: ['telegram'],
      category: 'productivity',
      tier: 'private',
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
  });

  it('rejects manifest with non-array platforms', () => {
    const raw = {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: 'telegram',
      category: 'productivity',
      tier: 'private',
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
  });

  it('accepts manifest with optional dependencies array', () => {
    const raw = {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: ['telegram'],
      category: 'productivity',
      tier: 'private',
      dependencies: ['other-skill'],
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(true);
  });

  it('rejects manifest with non-array dependencies', () => {
    const raw = {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      author: 'Author',
      license: 'MIT',
      description: 'Test',
      hubVersion: '>=1.0.0',
      platforms: ['telegram'],
      category: 'productivity',
      tier: 'private',
      dependencies: 'bad',
    };
    const result = validateManifest(raw);
    expect(result.ok).toBe(false);
  });
});

// ─── loadSkillPrompt ──────────────────────────────────────────────────

describe('loadSkillPrompt', () => {
  const skillDir = '/tmp/test-skill-prompts';
  const promptsDir = path.join(skillDir, 'prompts');

  beforeEach(() => {
    clearSkillPromptCache(skillDir);
    fs.mkdirSync(promptsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillDir, { recursive: true, force: true });
  });

  it('loads a prompt file from skill directory', () => {
    const promptPath = path.join(promptsDir, 'system.md');
    fs.writeFileSync(promptPath, '# System Prompt\nHello world');
    const content = loadSkillPrompt(skillDir, 'system');
    expect(content).toBe('# System Prompt\nHello world');
  });

  it('returns null for non-existent prompt', () => {
    const content = loadSkillPrompt(skillDir, 'nonexistent');
    expect(content).toBeNull();
  });

  it('caches prompt and returns cached version on second call', () => {
    const promptPath = path.join(promptsDir, 'cached.md');
    fs.writeFileSync(promptPath, 'original content');

    const first = loadSkillPrompt(skillDir, 'cached');
    expect(first).toBe('original content');

    // Overwrite without changing mtime (same content write within same second)
    // The cache uses mtime, so we read again — should be cached
    const second = loadSkillPrompt(skillDir, 'cached');
    expect(second).toBe('original content');
  });

  it('reloads prompt when mtime changes', async () => {
    const promptPath = path.join(promptsDir, 'hot.md');
    fs.writeFileSync(promptPath, 'v1');

    const first = loadSkillPrompt(skillDir, 'hot');
    expect(first).toBe('v1');

    // Change the file with a different mtime
    // We need to wait a tiny bit for mtime to differ on some filesystems
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(promptPath, 'v2');

    // Force mtime to be different
    const futureTime = Date.now() + 10000;
    fs.utimesSync(promptPath, futureTime / 1000, futureTime / 1000);

    const second = loadSkillPrompt(skillDir, 'hot');
    expect(second).toBe('v2');
  });
});

// ─── SkillLoader class ────────────────────────────────────────────────

describe('SkillLoader', () => {
  const skillsDir = '/tmp/test-skillloader-skills';

  function setupSkillDir(
    id: string,
    manifest: Record<string, unknown>,
    moduleExport: NexusSkill | (() => NexusSkill),
  ): string {
    const dir = path.join(skillsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    // Write a JS module that exports the skill
    // We use a global registry to inject mock skills into require()
    (globalThis as Record<string, unknown>).__testSkills =
      (globalThis as Record<string, unknown>).__testSkills ?? {};
    (
      (globalThis as Record<string, unknown>).__testSkills as Record<
        string,
        NexusSkill | (() => NexusSkill)
      >
    )[id] = moduleExport;

    // The index.js will look up from the global registry
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      `module.exports = globalThis.__testSkills['${id}'];`,
    );
    return dir;
  }

  beforeEach(() => {
    fs.mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(skillsDir, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__testSkills;
    // Clear require cache for test skill modules
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(skillsDir)) {
        delete require.cache[key];
      }
    }
  });

  it('creates skills directory if it does not exist', async () => {
    const nonExistent = path.join(skillsDir, 'subdir', 'skills');
    const loader = new SkillLoader(nonExistent, '4.4.1');
    const result = await loader.loadAll();
    expect(result.loaded).toEqual([]);
    expect(fs.existsSync(nonExistent)).toBe(true);
  });

  it('loads a valid skill', async () => {
    const manifest = createMockManifest({ id: 'my-skill', hubVersion: '>=4.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('my-skill', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual(['my-skill']);
    expect(result.skipped).toEqual([]);
    expect(loader.size).toBe(1);
    expect(loader.getLoadedSkillIds()).toEqual(['my-skill']);
  });

  it('skips skill with incompatible hubVersion', async () => {
    const manifest = createMockManifest({ id: 'future-skill', hubVersion: '>=10.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('future-skill', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('incompatible hubVersion');
  });

  it('skips skill with invalid manifest', async () => {
    const dir = path.join(skillsDir, 'bad-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{ not valid json }}}');

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('failed to parse');
  });

  it('skips skill with missing index.js', async () => {
    const dir = path.join(skillsDir, 'no-entry');
    fs.mkdirSync(dir, { recursive: true });
    const manifest = createMockManifest({ id: 'no-entry', hubVersion: '>=1.0.0' });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('missing entry point');
  });

  it('enables and disables a skill', async () => {
    const manifest = createMockManifest({ id: 'lifecycle', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('lifecycle', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('lifecycle');
    expect(loader.getEnabledSkillIds()).toEqual(['lifecycle']);
    expect(skill.install).toHaveBeenCalledOnce();
    expect(skill.enable).toHaveBeenCalledOnce();

    await loader.disableSkill('lifecycle');
    expect(loader.getEnabledSkillIds()).toEqual([]);
    expect(skill.disable).toHaveBeenCalledOnce();
  });

  it('does not double-enable a skill', async () => {
    const manifest = createMockManifest({ id: 'idempotent', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('idempotent', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('idempotent');
    await loader.enableSkill('idempotent'); // second call is a no-op
    expect(skill.install).toHaveBeenCalledOnce();
  });

  it('throws when enabling skill with unmet dependency', async () => {
    const depManifest = createMockManifest({ id: 'dep', hubVersion: '>=1.0.0' });
    const depSkill = createMockSkill(depManifest);
    setupSkillDir('dep', depManifest, depSkill);

    const childManifest = createMockManifest({
      id: 'child',
      hubVersion: '>=1.0.0',
      dependencies: ['dep'],
    });
    const childSkill = createMockSkill(childManifest);
    setupSkillDir('child', childManifest, childSkill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    // Try to enable child without enabling dep first
    await expect(loader.enableSkill('child')).rejects.toThrow('dependency "dep" is not enabled');
  });

  it('throws when disabling skill that others depend on', async () => {
    const depManifest = createMockManifest({ id: 'base', hubVersion: '>=1.0.0' });
    const depSkill = createMockSkill(depManifest);
    setupSkillDir('base', depManifest, depSkill);

    const childManifest = createMockManifest({
      id: 'dependent',
      hubVersion: '>=1.0.0',
      dependencies: ['base'],
    });
    const childSkill = createMockSkill(childManifest);
    setupSkillDir('dependent', childManifest, childSkill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    await loader.enableSkill('base');
    await loader.enableSkill('dependent');

    await expect(loader.disableSkill('base')).rejects.toThrow('skill "dependent" depends on it');
  });

  it('uninstalls a skill completely', async () => {
    const manifest = createMockManifest({ id: 'removable', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('removable', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    await loader.enableSkill('removable');

    await loader.uninstallSkill('removable');
    expect(loader.size).toBe(0);
    expect(loader.getSkill('removable')).toBeUndefined();
    expect(skill.disable).toHaveBeenCalled();
    expect(skill.uninstall).toHaveBeenCalled();
  });

  it('returns routes only from enabled skills', async () => {
    const manifest = createMockManifest({ id: 'router', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    (skill.getPatternRoutes as ReturnType<typeof vi.fn>).mockReturnValue([
      { pattern: /^\/test/, description: 'test command' },
    ]);
    (skill.getKeywordRoutes as ReturnType<typeof vi.fn>).mockReturnValue([
      { pattern: /test/i, description: 'test keyword' },
    ]);
    setupSkillDir('router', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    // Not enabled yet — should return nothing
    expect(loader.getAllPatternRoutes()).toEqual([]);
    expect(loader.getAllKeywordRoutes()).toEqual([]);
    expect(loader.getAllClassificationHints()).toEqual([]);

    await loader.enableSkill('router');

    expect(loader.getAllPatternRoutes()).toHaveLength(1);
    expect(loader.getAllPatternRoutes()[0].skillId).toBe('router');
    expect(loader.getAllKeywordRoutes()).toHaveLength(1);
    expect(loader.getAllClassificationHints()).toHaveLength(1);
  });

  it('returns tools from enabled skills and executes them', async () => {
    const manifest = createMockManifest({ id: 'tooled', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    (skill.getTools as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: 'tooled_action', description: 'Do something', inputSchema: {} },
    ]);
    (skill.executeTool as ReturnType<typeof vi.fn>).mockResolvedValue({ done: true });
    setupSkillDir('tooled', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    await loader.enableSkill('tooled');

    const tools = loader.getAllTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tooled_action');

    const result = await loader.executeTool('tooled_action', { foo: 'bar' });
    expect(result).toEqual({ skillId: 'tooled', result: { done: true } });
    expect(skill.executeTool).toHaveBeenCalledWith('tooled_action', { foo: 'bar' });
  });

  it('returns null when executing unknown tool', async () => {
    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();
    const result = await loader.executeTool('nonexistent_tool', {});
    expect(result).toBeNull();
  });

  it('throws when enabling non-existent skill', async () => {
    const loader = new SkillLoader(skillsDir, '4.4.1');
    await expect(loader.enableSkill('ghost')).rejects.toThrow('Skill not found: ghost');
  });

  it('loads skill prompt via getSkillPrompt', async () => {
    const manifest = createMockManifest({ id: 'prompted', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    const dir = setupSkillDir('prompted', manifest, skill);

    // Create a prompts directory with a prompt file
    const promptsDir = path.join(dir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'system.md'), 'You are a helpful assistant');

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    const prompt = loader.getSkillPrompt('prompted', 'system');
    expect(prompt).toBe('You are a helpful assistant');

    // Non-existent prompt
    expect(loader.getSkillPrompt('prompted', 'nope')).toBeNull();

    // Non-existent skill
    expect(loader.getSkillPrompt('ghost', 'system')).toBeNull();
  });

  it('accessor methods return correct values', async () => {
    const manifest = createMockManifest({ id: 'accessor', hubVersion: '>=1.0.0' });
    const skill = createMockSkill(manifest);
    setupSkillDir('accessor', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    expect(loader.getManifest('accessor')).toEqual(manifest);
    expect(loader.getConfig('accessor')).toMatchObject({ skillId: 'accessor', enabled: false });
    expect(loader.getSkillDirectory('accessor')).toBe(path.join(skillsDir, 'accessor'));
    expect(loader.getHubVersion()).toBe('4.4.1');
  });

  it('loads skills in dependency order', async () => {
    const enableOrder: string[] = [];

    const aManifest = createMockManifest({ id: 'a', hubVersion: '>=1.0.0' });
    const aSkill = createMockSkill(aManifest);

    const bManifest = createMockManifest({ id: 'b', hubVersion: '>=1.0.0', dependencies: ['a'] });
    const bSkill = createMockSkill(bManifest);

    // Setup b first to ensure order comes from dependency resolution, not filesystem order
    setupSkillDir('b', bManifest, bSkill);
    setupSkillDir('a', aManifest, aSkill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    // Both should be loaded
    expect(result.loaded).toContain('a');
    expect(result.loaded).toContain('b');
    // a should be loaded before b (dependency order)
    expect(result.loaded.indexOf('a')).toBeLessThan(result.loaded.indexOf('b'));
  });

  it('skips skills with missing dependencies and loads others', async () => {
    const goodManifest = createMockManifest({ id: 'good', hubVersion: '>=1.0.0' });
    const goodSkill = createMockSkill(goodManifest);
    setupSkillDir('good', goodManifest, goodSkill);

    const badManifest = createMockManifest({
      id: 'bad',
      hubVersion: '>=1.0.0',
      dependencies: ['nonexistent'],
    });
    const badSkill = createMockSkill(badManifest);
    setupSkillDir('bad', badManifest, badSkill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    const result = await loader.loadAll();

    expect(result.loaded).toContain('good');
    expect(result.skipped.find((s) => s.id === 'bad')?.reason).toContain('missing dependencies');
  });

  it('initializes default sub-modules from manifest', async () => {
    const manifest = createMockManifest({
      id: 'with-subs',
      hubVersion: '>=1.0.0',
      subModules: [
        { id: 'mod-a', name: 'Mod A', description: 'First module', default: true },
        { id: 'mod-b', name: 'Mod B', description: 'Second module', default: false },
      ],
    });
    const skill = createMockSkill(manifest);
    setupSkillDir('with-subs', manifest, skill);

    const loader = new SkillLoader(skillsDir, '4.4.1');
    await loader.loadAll();

    const config = loader.getConfig('with-subs');
    expect(config?.enabledSubModules).toEqual(['mod-a']);
  });
});
