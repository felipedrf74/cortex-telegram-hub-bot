/**
 * QA Validation Tests — SkillLoader (v2 — develop API)
 *
 * Validates the SkillLoader service after the develop merge.
 * The loader API changed:
 *   - validateManifest(Record<string, unknown>) → {ok, manifest|errors}
 *   - resolveDependencies(Map<string, SkillManifest>) → ResolveResult
 *   - SkillLoader class with lifecycle, prompt hot-reload, and tool routing
 *   - parseSemVer / satisfiesSemVer exported utilities
 *
 * QA agent: agent/qa
 * Validating: src/skills/loader.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SkillManifest } from '../../src/skills/types';

// ── Mocks ─────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  validateManifest,
  resolveDependencies,
  parseSemVer,
  satisfiesSemVer,
  loadSkillPrompt,
  clearSkillPromptCache,
  SkillLoader,
} from '../../src/skills/loader';

// ── Helper: minimal valid manifest ────────────────────────────────

function validManifest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    author: 'QA',
    license: 'MIT',
    description: 'A test skill',
    hubVersion: '>=1.0.0',
    platforms: ['telegram'],
    category: 'other',
    tier: 'private',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. validateManifest — required fields
// ═══════════════════════════════════════════════════════════════════

describe('QA: validateManifest — required fields', () => {
  it('passes with all required fields present', () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
  });

  const requiredFields = [
    'id', 'name', 'version', 'author', 'license',
    'description', 'hubVersion', 'platforms', 'category', 'tier',
  ];

  for (const field of requiredFields) {
    it(`rejects when "${field}" is missing`, () => {
      const m = validManifest();
      delete m[field];
      const result = validateManifest(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some(e => e.field === field)).toBe(true);
      }
    });

    it(`rejects when "${field}" is null`, () => {
      const result = validateManifest(validManifest({ [field]: null }));
      expect(result.ok).toBe(false);
    });
  }

  it('collects all missing-field errors at once', () => {
    const result = validateManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBe(requiredFields.length);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. validateManifest — type validation
// ═══════════════════════════════════════════════════════════════════

describe('QA: validateManifest — type validation', () => {
  it('rejects empty string for id', () => {
    const result = validateManifest(validManifest({ id: '' }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-semver version', () => {
    const result = validateManifest(validManifest({ version: 'not.a.version' }));
    expect(result.ok).toBe(false);
  });

  it('accepts valid semver version', () => {
    const result = validateManifest(validManifest({ version: '2.3.4' }));
    expect(result.ok).toBe(true);
  });

  it('rejects non-string hubVersion', () => {
    const result = validateManifest(validManifest({ hubVersion: 42 }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-array platforms', () => {
    const result = validateManifest(validManifest({ platforms: 'telegram' }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-array dependencies when present', () => {
    const result = validateManifest(validManifest({ dependencies: 'not-array' }));
    expect(result.ok).toBe(false);
  });

  it('accepts missing dependencies (optional)', () => {
    const m = validManifest();
    delete m.dependencies;
    const result = validateManifest(m);
    expect(result.ok).toBe(true);
  });

  it('accepts extra unknown fields without error', () => {
    const result = validateManifest(validManifest({ extraField: 'ignored', nested: { x: 1 } }));
    expect(result.ok).toBe(true);
  });

  it('returns manifest object on success', () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('test-skill');
      expect(result.manifest.version).toBe('1.0.0');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. parseSemVer
// ═══════════════════════════════════════════════════════════════════

describe('QA: parseSemVer', () => {
  it('parses standard semver', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('parses 0.0.0', () => {
    expect(parseSemVer('0.0.0')).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it('parses large numbers', () => {
    expect(parseSemVer('100.200.300')).toEqual({ major: 100, minor: 200, patch: 300 });
  });

  it('handles leading/trailing whitespace', () => {
    expect(parseSemVer('  1.2.3  ')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('returns null for non-semver string', () => {
    expect(parseSemVer('not-a-version')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSemVer('')).toBeNull();
  });

  it('returns null for partial version like "1.2"', () => {
    expect(parseSemVer('1.2')).toBeNull();
  });

  it('parses version with pre-release suffix (extracts numeric part)', () => {
    const result = parseSemVer('1.0.0-beta');
    // The regex captures digits after the core version
    expect(result).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. satisfiesSemVer
// ═══════════════════════════════════════════════════════════════════

describe('QA: satisfiesSemVer', () => {
  it('matches exact version', () => {
    expect(satisfiesSemVer('1.0.0', '1.0.0')).toBe(true);
  });

  it('rejects non-matching exact version', () => {
    expect(satisfiesSemVer('1.0.1', '1.0.0')).toBe(false);
  });

  it('handles >= operator', () => {
    expect(satisfiesSemVer('2.0.0', '>=1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '>=1.0.0')).toBe(true);
    expect(satisfiesSemVer('0.9.9', '>=1.0.0')).toBe(false);
  });

  it('handles < operator', () => {
    expect(satisfiesSemVer('0.9.0', '<1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '<1.0.0')).toBe(false);
  });

  it('handles compound range (AND logic)', () => {
    expect(satisfiesSemVer('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesSemVer('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesSemVer('0.9.0', '>=1.0.0 <2.0.0')).toBe(false);
  });

  it('returns false for invalid version string', () => {
    expect(satisfiesSemVer('abc', '>=1.0.0')).toBe(false);
  });

  it('returns false for invalid range string', () => {
    expect(satisfiesSemVer('1.0.0', 'invalid')).toBe(false);
  });

  it('handles <= operator', () => {
    expect(satisfiesSemVer('1.0.0', '<=1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.1', '<=1.0.0')).toBe(false);
  });

  it('handles > operator', () => {
    expect(satisfiesSemVer('1.0.1', '>1.0.0')).toBe(true);
    expect(satisfiesSemVer('1.0.0', '>1.0.0')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. resolveDependencies — topological sort
// ═══════════════════════════════════════════════════════════════════

describe('QA: resolveDependencies — topological sort', () => {
  function makeManifests(entries: Array<{ id: string; deps?: string[] }>): Map<string, SkillManifest> {
    const map = new Map<string, SkillManifest>();
    for (const entry of entries) {
      map.set(entry.id, {
        id: entry.id,
        name: entry.id,
        version: '1.0.0',
        author: 'QA',
        license: 'MIT',
        description: '',
        hubVersion: '>=1.0.0',
        platforms: ['telegram'],
        category: 'other',
        tier: 'private',
        dependencies: entry.deps,
      });
    }
    return map;
  }

  it('resolves independent skills in any order', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toHaveLength(3);
      expect(new Set(result.order)).toEqual(new Set(['a', 'b', 'c']));
    }
  });

  it('resolves linear dependency chain in correct order', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'a' },
      { id: 'b', deps: ['a'] },
      { id: 'c', deps: ['b'] },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'));
      expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('c'));
    }
  });

  it('detects missing dependencies', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'a', deps: ['missing-dep'] },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'missing') {
      expect(result.errors[0].skillId).toBe('a');
      expect(result.errors[0].missingDeps).toContain('missing-dep');
    }
  });

  it('detects circular dependency (A→B→A)', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'a', deps: ['b'] },
      { id: 'b', deps: ['a'] },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cycle');
    }
  });

  it('detects circular in larger graph', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'safe' },
      { id: 'x', deps: ['y'] },
      { id: 'y', deps: ['z'] },
      { id: 'z', deps: ['x'] },
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'cycle') {
      expect(result.error.cycle).toContain('x');
      expect(result.error.cycle).toContain('y');
      expect(result.error.cycle).toContain('z');
      expect(result.error.cycle).not.toContain('safe');
    }
  });

  it('resolves wide fan-in (A depends on B,C,D,E)', () => {
    const result = resolveDependencies(makeManifests([
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
      { id: 'a', deps: ['b', 'c', 'd', 'e'] },
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.indexOf('a')).toBe(result.order.length - 1);
    }
  });

  it('resolves deep chain (depth 10)', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `level-${i}`,
      deps: i > 0 ? [`level-${i - 1}`] : undefined,
    }));
    const result = resolveDependencies(makeManifests(entries));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toHaveLength(10);
      for (let i = 1; i < 10; i++) {
        expect(result.order.indexOf(`level-${i - 1}`)).toBeLessThan(
          result.order.indexOf(`level-${i}`),
        );
      }
    }
  });

  it('handles empty manifests map', () => {
    const result = resolveDependencies(new Map());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual([]);
    }
  });

  it('handles single skill with no deps', () => {
    const result = resolveDependencies(makeManifests([{ id: 'solo' }]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order).toEqual(['solo']);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. loadSkillPrompt — hot-reload cache
// ═══════════════════════════════════════════════════════════════════

describe('QA: loadSkillPrompt — hot-reload caching', () => {
  const tmpDir = path.join(__dirname, '.tmp-qa-prompts');

  beforeEach(() => {
    fs.mkdirSync(path.join(tmpDir, 'prompts'), { recursive: true });
    clearSkillPromptCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads a prompt file from skill prompts/ directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'prompts', 'system.md'), '# System prompt');
    const content = loadSkillPrompt(tmpDir, 'system');
    expect(content).toBe('# System prompt');
  });

  it('returns null for nonexistent prompt file', () => {
    const content = loadSkillPrompt(tmpDir, 'nonexistent');
    expect(content).toBeNull();
  });

  it('returns cached content on second read (same mtime)', () => {
    fs.writeFileSync(path.join(tmpDir, 'prompts', 'cached.md'), 'original');
    const first = loadSkillPrompt(tmpDir, 'cached');
    const second = loadSkillPrompt(tmpDir, 'cached');
    expect(first).toBe(second);
  });

  it('clearSkillPromptCache invalidates cache', () => {
    fs.writeFileSync(path.join(tmpDir, 'prompts', 'clear-me.md'), 'v1');
    loadSkillPrompt(tmpDir, 'clear-me');
    clearSkillPromptCache(tmpDir);
    // After clearing, it reads from disk again
    fs.writeFileSync(path.join(tmpDir, 'prompts', 'clear-me.md'), 'v2');
    const content = loadSkillPrompt(tmpDir, 'clear-me');
    expect(content).toBe('v2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. SkillLoader class — discovery and lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('QA: SkillLoader — class behavior', () => {
  const tmpDir = path.join(__dirname, '.tmp-qa-skillloader');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates skills directory if it does not exist', async () => {
    const nonexistent = path.join(tmpDir, 'skills-new');
    const loader = new SkillLoader(nonexistent, '1.0.0');
    const result = await loader.loadAll();
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(fs.existsSync(nonexistent)).toBe(true);
  });

  it('returns empty when skills directory is empty', async () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    const result = await loader.loadAll();
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('skips directories without manifest.json', async () => {
    fs.mkdirSync(path.join(tmpDir, 'no-manifest'));
    const loader = new SkillLoader(tmpDir, '1.0.0');
    const result = await loader.loadAll();
    expect(result.loaded).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('skips skills with invalid manifest', async () => {
    const skillDir = path.join(tmpDir, 'bad-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({ id: 'bad' }));

    const loader = new SkillLoader(tmpDir, '1.0.0');
    const result = await loader.loadAll();
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0].reason).toContain('invalid manifest');
  });

  it('skips skills with incompatible hubVersion', async () => {
    const skillDir = path.join(tmpDir, 'future-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify(
      validManifest({ id: 'future-skill', hubVersion: '>=99.0.0' }),
    ));

    const loader = new SkillLoader(tmpDir, '1.0.0');
    const result = await loader.loadAll();
    expect(result.skipped.some(s => s.reason.includes('incompatible hubVersion'))).toBe(true);
  });

  it('reports hub version via getHubVersion()', () => {
    const loader = new SkillLoader(tmpDir, '4.5.0');
    expect(loader.getHubVersion()).toBe('4.5.0');
  });

  it('starts with size 0', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.size).toBe(0);
  });

  it('getSkill returns undefined for unknown skill', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.getSkill('nonexistent')).toBeUndefined();
  });

  it('getManifest returns undefined for unknown skill', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.getManifest('nonexistent')).toBeUndefined();
  });

  it('getConfig returns undefined for unknown skill', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.getConfig('nonexistent')).toBeUndefined();
  });

  it('enableSkill throws for unknown skill', async () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    await expect(loader.enableSkill('ghost')).rejects.toThrow('Skill not found');
  });

  it('disableSkill throws for unknown skill', async () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    await expect(loader.disableSkill('ghost')).rejects.toThrow('Skill not found');
  });

  it('uninstallSkill throws for unknown skill', async () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    await expect(loader.uninstallSkill('ghost')).rejects.toThrow('Skill not found');
  });

  it('getLoadedSkillIds returns empty array initially', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.getLoadedSkillIds()).toEqual([]);
  });

  it('getEnabledSkillIds returns empty array initially', () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    expect(loader.getEnabledSkillIds()).toEqual([]);
  });

  it('executeTool returns null when no skills loaded', async () => {
    const loader = new SkillLoader(tmpDir, '1.0.0');
    const result = await loader.executeTool('some-tool', {});
    expect(result).toBeNull();
  });
});
