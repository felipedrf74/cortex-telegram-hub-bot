/**
 * QA Validation Tests — SkillLoader
 *
 * Validates the SkillLoader service built by the backend agent.
 * Focuses on:
 *   1. Type safety gaps between validateManifest() and SkillManifest interface
 *   2. Dependency resolution boundary conditions
 *   3. loadManifest() integration and error path coverage
 *   4. Regression-style edge cases
 *
 * QA agent: agent/qa
 * Validating: src/skills/loader.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { DependencyNode, SkillManifest } from '../../src/skills/types';

// ── Mocks ─────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '../../src/utils/logger';
import { validateManifest, resolveDependencies, loadManifest } from '../../src/skills/loader';

// ═══════════════════════════════════════════════════════════════════
// 1. TYPE SAFETY — validateManifest vs SkillManifest interface
// ═══════════════════════════════════════════════════════════════════

describe('QA: validateManifest — type safety alignment with SkillManifest', () => {
  /**
   * SkillManifest requires: id, name, version, author, license, description,
   * hubVersion, platforms, category, tier.
   * But validateManifest() only enforces name + version.
   *
   * These tests document this gap so it can be addressed in a future iteration.
   */

  it('passes validation with only name+version despite SkillManifest requiring more fields', () => {
    // This validates that the current behavior is intentional (manifest.json
    // uses a subset schema during the loader phase; full SkillManifest is
    // populated later during registration).
    const result = validateManifest({ name: 'minimal', version: '1.0.0' });
    expect(result.valid).toBe(true);
  });

  it('does not validate id field (documents gap)', () => {
    // SkillManifest requires `id` but validateManifest doesn't check it
    const withoutId = { name: 'test', version: '1.0.0' };
    const withId = { name: 'test', version: '1.0.0', id: 'nexus-test' };
    expect(validateManifest(withoutId).valid).toBe(true);
    expect(validateManifest(withId).valid).toBe(true);
  });

  it('does not validate hubVersion field (documents gap)', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    // hubVersion is required in SkillManifest but not validated here
  });

  it('does not validate platforms field (documents gap)', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    // platforms[] is required in SkillManifest but not validated here
  });

  it('does not validate category field (documents gap)', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    // category is required in SkillManifest but not validated here
  });

  it('does not validate tier field (documents gap)', () => {
    const result = validateManifest({ name: 'test', version: '1.0.0' });
    expect(result.valid).toBe(true);
    // tier is required in SkillManifest but not validated here
  });

  it('accepts extra unknown fields without error', () => {
    const result = validateManifest({
      name: 'test',
      version: '1.0.0',
      randomField: 'should-be-ignored',
      nested: { deep: true },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. MANIFEST VALIDATION — ADDITIONAL BOUNDARY CONDITIONS
// ═══════════════════════════════════════════════════════════════════

describe('QA: validateManifest — boundary conditions', () => {
  it('rejects undefined manifest', () => {
    const result = validateManifest(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('manifest');
  });

  it('rejects boolean manifest', () => {
    const result = validateManifest(true);
    expect(result.valid).toBe(false);
  });

  it('rejects number manifest', () => {
    const result = validateManifest(42);
    expect(result.valid).toBe(false);
  });

  it('rejects array manifest (typeof array is object)', () => {
    const result = validateManifest([]);
    // Arrays are objects, so it should pass the object check
    // but fail name/version checks
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('accepts single-char name', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0' });
    expect(result.valid).toBe(true);
  });

  it('rejects name with special characters', () => {
    const result = validateManifest({ name: 'my@skill!', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects name with dots', () => {
    const result = validateManifest({ name: 'my.skill', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('accepts version 0.0.0', () => {
    const result = validateManifest({ name: 'a', version: '0.0.0' });
    expect(result.valid).toBe(true);
  });

  it('rejects semver with pre-release suffix (1.0.0-beta)', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0-beta' });
    expect(result.valid).toBe(false);
  });

  it('rejects semver with build metadata (1.0.0+build.123)', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0+build.123' });
    expect(result.valid).toBe(false);
  });

  it('rejects name that is only hyphens', () => {
    const result = validateManifest({ name: '---', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects name starting with a hyphen', () => {
    const result = validateManifest({ name: '-skill', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('accepts long valid name', () => {
    const result = validateManifest({ name: 'a-very-long-skill-name-that-is-valid', version: '1.0.0' });
    expect(result.valid).toBe(true);
  });

  it('rejects numeric-only name', () => {
    const result = validateManifest({ name: '999', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('collects errors from all sections simultaneously', () => {
    const result = validateManifest({
      name: '',
      version: 'bad',
      description: 123,
      author: false,
      domain: 42,
      dependencies: 'not-array',
      submodules: 'not-array',
    });
    expect(result.valid).toBe(false);
    // Should have errors for: name, version, description, author, domain, dependencies, submodules
    expect(result.errors.length).toBeGreaterThanOrEqual(7);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SUBMODULE VALIDATION — DEEPER EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('QA: validateManifest — submodule edge cases', () => {
  it('accepts submodule with empty dependencies array', () => {
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [
        { module_name: 'mod-a', dependencies: [] },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('validates self-referencing submodule dependency', () => {
    // A submodule depending on itself — should be caught as unknown
    // because the second-pass checks dependency names against the names set
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [
        { module_name: 'mod-a', dependencies: ['mod-a'] },
      ],
    });
    // Self-reference: mod-a IS in the names set, so it passes validation.
    // This is a potential gap — circular submodule deps aren't checked.
    expect(result.valid).toBe(true);
  });

  it('handles null submodule entry', () => {
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [null],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('object');
  });

  it('handles many submodules without performance issue', () => {
    const submodules = Array.from({ length: 100 }, (_, i) => ({
      module_name: `mod-${i}`,
    }));
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules,
    });
    expect(result.valid).toBe(true);
  });

  it('validates chain of submodule dependencies (A→B→C)', () => {
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [
        { module_name: 'c' },
        { module_name: 'b', dependencies: ['c'] },
        { module_name: 'a-mod', dependencies: ['b'] },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects submodule with multiple unknown dependencies', () => {
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [
        { module_name: 'lonely', dependencies: ['ghost-a', 'ghost-b'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.filter(e => e.message.includes('unknown submodule')).length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. DEPENDENCY RESOLUTION — COMPLEX GRAPHS
// ═══════════════════════════════════════════════════════════════════

describe('QA: resolveDependencies — complex graphs', () => {
  it('resolves wide dependency (A depends on B, C, D, E — all independent)', () => {
    const nodes: DependencyNode[] = [
      { name: 'b', dependencies: [] },
      { name: 'c', dependencies: [] },
      { name: 'd', dependencies: [] },
      { name: 'e', dependencies: [] },
      { name: 'a', dependencies: ['b', 'c', 'd', 'e'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order.indexOf('a')).toBe(result.order.length - 1);
  });

  it('resolves mixed: some deps in nodes, some in available set', () => {
    const nodes: DependencyNode[] = [
      { name: 'local-dep', dependencies: [] },
      { name: 'consumer', dependencies: ['local-dep', 'pre-installed'] },
    ];
    const available = new Set(['pre-installed']);
    const result = resolveDependencies(nodes, available);
    expect(result.resolved).toBe(true);
    expect(result.order.indexOf('local-dep')).toBeLessThan(result.order.indexOf('consumer'));
  });

  it('fails when one dep is available but another is missing', () => {
    const nodes: DependencyNode[] = [
      { name: 'half-satisfied', dependencies: ['exists', 'missing'] },
    ];
    const available = new Set(['exists']);
    const result = resolveDependencies(nodes, available);
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('missing');
    expect(result.missing).not.toContain('exists');
  });

  it('resolves deep chain (depth 10)', () => {
    const nodes: DependencyNode[] = [];
    for (let i = 0; i < 10; i++) {
      nodes.push({
        name: `level-${i}`,
        dependencies: i > 0 ? [`level-${i - 1}`] : [],
      });
    }
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toHaveLength(10);
    for (let i = 1; i < 10; i++) {
      expect(result.order.indexOf(`level-${i - 1}`)).toBeLessThan(
        result.order.indexOf(`level-${i}`),
      );
    }
  });

  it('detects circular in a larger graph with non-circular nodes', () => {
    const nodes: DependencyNode[] = [
      { name: 'safe-a', dependencies: [] },
      { name: 'safe-b', dependencies: ['safe-a'] },
      { name: 'cycle-x', dependencies: ['cycle-y'] },
      { name: 'cycle-y', dependencies: ['cycle-z'] },
      { name: 'cycle-z', dependencies: ['cycle-x'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
    const circularNames = result.circular.flat();
    expect(circularNames).not.toContain('safe-a');
    expect(circularNames).not.toContain('safe-b');
    expect(circularNames).toContain('cycle-x');
    expect(circularNames).toContain('cycle-y');
    expect(circularNames).toContain('cycle-z');
  });

  it('returns empty order when circular is detected (no partial results)', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.order).toEqual([]);
  });

  it('missing takes priority — returns missing without attempting resolution', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['missing-dep'] },
      { name: 'b', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('missing-dep');
    // When missing deps exist, circular detection is skipped
    expect(result.circular).toEqual([]);
  });

  it('handles duplicate dependencies in a single node gracefully', () => {
    const nodes: DependencyNode[] = [
      { name: 'base', dependencies: [] },
      { name: 'consumer', dependencies: ['base', 'base'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toContain('consumer');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. FILESYSTEM LOADING — loadManifest() INTEGRATION
// ═══════════════════════════════════════════════════════════════════

describe('QA: loadManifest — integration tests', () => {
  const tmpDir = path.join(__dirname, '.tmp-qa-loader');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content: unknown, dirName?: string): string {
    const skillDir = path.join(tmpDir, dirName || `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
    return skillDir;
  }

  it('calls logger.info on successful load', () => {
    const dir = writeManifest({ name: 'logged-skill', version: '1.0.0' });
    loadManifest(dir);
    expect(logger.info).toHaveBeenCalledWith(
      { skill: 'logged-skill' },
      'Manifest loaded',
    );
  });

  it('returns the parsed manifest object with correct field values', () => {
    const input = {
      name: 'precise-skill',
      version: '3.2.1',
      description: 'Testing exact return values',
      author: 'QA Agent',
      domain: 'testing',
    };
    const dir = writeManifest(input);
    const manifest = loadManifest(dir);
    expect(manifest.name).toBe('precise-skill');
    expect(manifest.version).toBe('3.2.1');
    expect(manifest.description).toBe('Testing exact return values');
    expect(manifest.author).toBe('QA Agent');
  });

  it('preserves submodules array through load cycle', () => {
    const dir = writeManifest({
      name: 'submod-skill',
      version: '1.0.0',
      submodules: [
        { module_name: 'alpha' },
        { module_name: 'beta', dependencies: ['alpha'] },
      ],
    });
    const manifest = loadManifest(dir);
    expect(manifest.submodules).toHaveLength(2);
    expect(manifest.submodules![1].module_name).toBe('beta');
  });

  it('preserves dependencies array through load cycle', () => {
    const dir = writeManifest({
      name: 'dep-skill',
      version: '1.0.0',
      dependencies: ['core-utils', 'shared-lib'],
    });
    const manifest = loadManifest(dir);
    expect(manifest.dependencies).toEqual(['core-utils', 'shared-lib']);
  });

  it('throws descriptive error for empty JSON object', () => {
    const dir = writeManifest({});
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
  });

  it('throws for manifest with only invalid fields', () => {
    const dir = writeManifest({ foo: 'bar', baz: 123 });
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
  });

  it('throws for manifest.json containing a JSON array', () => {
    const dir = writeManifest([{ name: 'a', version: '1.0.0' }]);
    // Array passes typeof === 'object' check but fails name/version
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
  });

  it('throws for manifest.json containing a JSON string', () => {
    const skillDir = path.join(tmpDir, 'string-json');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), '"just a string"');
    expect(() => loadManifest(skillDir)).toThrow();
  });

  it('throws for manifest.json containing JSON null', () => {
    const skillDir = path.join(tmpDir, 'null-json');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), 'null');
    expect(() => loadManifest(skillDir)).toThrow();
  });

  it('throws for completely empty file', () => {
    const skillDir = path.join(tmpDir, 'empty-file');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), '');
    expect(() => loadManifest(skillDir)).toThrow('Invalid JSON');
  });

  it('throws for nonexistent directory', () => {
    expect(() => loadManifest('/nonexistent/path/to/skill')).toThrow('Manifest not found');
  });

  it('error message includes the directory path for missing manifest', () => {
    const fakePath = path.join(tmpDir, 'ghost-skill');
    fs.mkdirSync(fakePath, { recursive: true });
    try {
      loadManifest(fakePath);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain(fakePath);
    }
  });

  it('error message includes field names for validation failures', () => {
    const dir = writeManifest({ name: 'INVALID', version: 'bad' });
    try {
      loadManifest(dir);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('name');
      expect(err.message).toContain('version');
    }
  });

  it('handles manifest.json with trailing whitespace/newlines', () => {
    const skillDir = path.join(tmpDir, 'whitespace-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      '  \n  {"name": "ws-skill", "version": "1.0.0"}  \n  ',
    );
    const manifest = loadManifest(skillDir);
    expect(manifest.name).toBe('ws-skill');
  });

  it('rejects manifest.json with BOM character (known limitation)', () => {
    const skillDir = path.join(tmpDir, 'bom-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    // UTF-8 BOM causes JSON.parse to fail in this environment
    const bom = '\uFEFF';
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      bom + '{"name": "bom-skill", "version": "1.0.0"}',
    );
    // Documents: loadManifest does NOT strip BOM before parsing
    expect(() => loadManifest(skillDir)).toThrow('Invalid JSON');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. FULL PIPELINE — validate → resolve → load
// ═══════════════════════════════════════════════════════════════════

describe('QA: full pipeline — validate, resolve, and load', () => {
  const tmpDir = path.join(__dirname, '.tmp-qa-pipeline');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content: unknown, dirName: string): string {
    const skillDir = path.join(tmpDir, dirName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(content, null, 2),
    );
    return skillDir;
  }

  it('validates, resolves deps, and loads a multi-skill setup', () => {
    // Step 1: Write manifests to disk
    const coreDir = writeManifest(
      { name: 'core-utils', version: '1.0.0' },
      'core-utils',
    );
    const pluginDir = writeManifest(
      { name: 'plugin-a', version: '1.0.0', dependencies: ['core-utils'] },
      'plugin-a',
    );

    // Step 2: Load and validate both manifests
    const coreManifest = loadManifest(coreDir);
    const pluginManifest = loadManifest(pluginDir);
    expect(coreManifest.name).toBe('core-utils');
    expect(pluginManifest.name).toBe('plugin-a');

    // Step 3: Resolve dependencies
    const nodes: DependencyNode[] = [
      { name: coreManifest.name, dependencies: [] },
      { name: pluginManifest.name, dependencies: pluginManifest.dependencies || [] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order[0]).toBe('core-utils');
    expect(result.order[1]).toBe('plugin-a');
  });

  it('full pipeline detects invalid manifest before reaching dependency resolution', () => {
    const dir = writeManifest({ name: 'BAD', version: 'x' }, 'bad-skill');
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
    // We never get to resolveDependencies — loader catches it early
  });

  it('full pipeline handles skill with all optional fields populated', () => {
    const dir = writeManifest(
      {
        name: 'full-skill',
        version: '2.5.0',
        description: 'Fully populated skill for QA',
        author: 'QA Bot',
        domain: 'testing',
        dependencies: [],
        submodules: [
          { module_name: 'core' },
          { module_name: 'extras', dependencies: ['core'] },
        ],
      },
      'full-skill',
    );

    const manifest = loadManifest(dir);
    expect(manifest.name).toBe('full-skill');
    expect(manifest.version).toBe('2.5.0');
    expect(manifest.submodules).toHaveLength(2);

    const validationResult = validateManifest(manifest);
    expect(validationResult.valid).toBe(true);
  });
});
