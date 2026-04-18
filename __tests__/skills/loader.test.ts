/**
 * SkillLoader Tests
 *
 * Tests manifest validation, dependency resolution, sub-module dependency
 * validation, circular dependency detection, and filesystem manifest loading.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { SkillManifest, DependencyNode } from '../../src/skills/types';

// ── Mocks ─────────────────────────────────────────────────────────

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { validateManifest, resolveDependencies, loadManifest } from '../../src/skills/loader';

// ── Helpers ───────────────────────────────────────────────────────

function validManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MANIFEST VALIDATION — REQUIRED FIELDS
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — validateManifest() required fields', () => {
  it('accepts a minimal valid manifest (name + version)', () => {
    const result = validateManifest({ name: 'hello', version: '1.0.0' });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts a full manifest with all optional fields', () => {
    const result = validateManifest({
      name: 'triathlon-coach',
      version: '2.1.0',
      description: 'Triathlon training and nutrition',
      author: 'Felipe Dominguez',
      domain: 'triathlon',
      dependencies: ['core-utils'],
      submodules: [
        { module_name: 'training-plans', enabled_by_default: true },
        { module_name: 'garmin-sync', enabled_by_default: false },
      ],
      requiredApiKeys: ['GARMIN_API_KEY'],
      config: { maxWorkoutsPerWeek: 7 },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts v2 manifests that declare subSkills', () => {
    const result = validateManifest({
      name: 'mesh-skill',
      version: '1.0.0',
      manifestVersion: 2,
      subSkills: [
        { module_name: 'alpha', enabled_by_default: true },
        { module_name: 'beta', enabled_by_default: false, dependencies: ['alpha'] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects null manifest', () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('manifest');
  });

  it('rejects non-object manifest', () => {
    const result = validateManifest('not-an-object');
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('non-null object');
  });

  it('rejects missing name', () => {
    const result = validateManifest({ version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects empty name', () => {
    const result = validateManifest({ name: '', version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'name')).toBe(true);
  });

  it('rejects missing version', () => {
    const result = validateManifest({ name: 'valid-name' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'version')).toBe(true);
  });

  it('rejects empty version', () => {
    const result = validateManifest({ name: 'valid-name', version: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.field === 'version')).toBe(true);
  });

  it('collects multiple errors at once', () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2); // name + version
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST VALIDATION — NAME FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — validateManifest() name format', () => {
  it('accepts lowercase with hyphens', () => {
    expect(validateManifest({ name: 'my-skill', version: '1.0.0' }).valid).toBe(true);
  });

  it('accepts lowercase with numbers', () => {
    expect(validateManifest({ name: 'skill2', version: '1.0.0' }).valid).toBe(true);
  });

  it('rejects uppercase letters', () => {
    const result = validateManifest({ name: 'MySkill', version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('lowercase');
  });

  it('rejects names starting with a number', () => {
    const result = validateManifest({ name: '2skill', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects names with underscores', () => {
    const result = validateManifest({ name: 'my_skill', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects names with spaces', () => {
    const result = validateManifest({ name: 'my skill', version: '1.0.0' });
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST VALIDATION — VERSION FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — validateManifest() version format', () => {
  it('accepts valid semver (1.0.0)', () => {
    expect(validateManifest({ name: 'a', version: '1.0.0' }).valid).toBe(true);
  });

  it('accepts semver with larger numbers (12.34.56)', () => {
    expect(validateManifest({ name: 'a', version: '12.34.56' }).valid).toBe(true);
  });

  it('rejects version without patch (1.0)', () => {
    const result = validateManifest({ name: 'a', version: '1.0' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('semver');
  });

  it('rejects version with prefix (v1.0.0)', () => {
    const result = validateManifest({ name: 'a', version: 'v1.0.0' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric version', () => {
    const result = validateManifest({ name: 'a', version: 'latest' });
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST VALIDATION — OPTIONAL FIELDS
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — validateManifest() optional fields', () => {
  it('rejects non-string description', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', description: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('description');
  });

  it('rejects non-string author', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', author: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('author');
  });

  it('rejects non-string domain', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', domain: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('domain');
  });

  it('rejects non-array dependencies', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', dependencies: 'core' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('dependencies');
  });

  it('rejects non-string items in dependencies', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', dependencies: [42] });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('dependencies[0]');
  });

  it('accepts empty dependencies array', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', dependencies: [] });
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MANIFEST VALIDATION — SUBMODULES
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — validateManifest() submodules', () => {
  it('accepts valid submodules array', () => {
    const result = validateManifest({
      name: 'a',
      version: '1.0.0',
      submodules: [
        { module_name: 'mod-a' },
        { module_name: 'mod-b', version: '2.0.0' },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-array submodules', () => {
    const result = validateManifest({ name: 'a', version: '1.0.0', submodules: 'mod-a' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('submodules');
  });

  it('rejects submodule without module_name', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [{ version: '1.0.0' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toContain('module_name');
  });

  it('rejects submodule with empty module_name', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [{ module_name: '' }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects duplicate submodule names', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [
        { module_name: 'mod-a' },
        { module_name: 'mod-a' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('duplicate'))).toBe(true);
  });

  it('rejects non-object submodule entry', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: ['not-an-object'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('object');
  });

  it('accepts submodule with dependencies on other submodules', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [
        { module_name: 'core' },
        { module_name: 'extended', dependencies: ['core'] },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects submodule dependency on unknown submodule', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [
        { module_name: 'extended', dependencies: ['nonexistent'] },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.message.includes('unknown submodule'))).toBe(true);
  });

  it('rejects non-array submodule dependencies', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0',
      submodules: [
        { module_name: 'mod-a', dependencies: 'core' },
      ],
    });
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY RESOLUTION — BASIC
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — resolveDependencies() basic', () => {
  it('resolves a single skill with no dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'standalone', dependencies: [] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual(['standalone']);
    expect(result.missing).toEqual([]);
    expect(result.circular).toEqual([]);
  });

  it('resolves two independent skills', () => {
    const nodes: DependencyNode[] = [
      { name: 'alpha', dependencies: [] },
      { name: 'beta', dependencies: [] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toHaveLength(2);
    expect(result.order).toContain('alpha');
    expect(result.order).toContain('beta');
  });

  it('resolves linear dependency chain (A → B → C)', () => {
    const nodes: DependencyNode[] = [
      { name: 'c', dependencies: [] },
      { name: 'b', dependencies: ['c'] },
      { name: 'a', dependencies: ['b'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    // C must come before B, B before A
    expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('b'));
    expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('a'));
  });

  it('resolves diamond dependency (A → B,C → D)', () => {
    const nodes: DependencyNode[] = [
      { name: 'd', dependencies: [] },
      { name: 'b', dependencies: ['d'] },
      { name: 'c', dependencies: ['d'] },
      { name: 'a', dependencies: ['b', 'c'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(true);
    expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('b'));
    expect(result.order.indexOf('d')).toBeLessThan(result.order.indexOf('c'));
    expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('a'));
    expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('a'));
  });

  it('resolves when dependency is already installed (in available set)', () => {
    const nodes: DependencyNode[] = [
      { name: 'plugin', dependencies: ['core-utils'] },
    ];
    const available = new Set(['core-utils']);
    const result = resolveDependencies(nodes, available);
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual(['plugin']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY RESOLUTION — MISSING DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — resolveDependencies() missing', () => {
  it('detects missing dependency', () => {
    const nodes: DependencyNode[] = [
      { name: 'orphan', dependencies: ['not-installed'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('not-installed');
  });

  it('detects multiple missing dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'needy', dependencies: ['dep-a', 'dep-b'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.missing).toContain('dep-a');
    expect(result.missing).toContain('dep-b');
  });

  it('deduplicates missing dependencies', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['shared'] },
      { name: 'b', dependencies: ['shared'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.missing.filter(d => d === 'shared')).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DEPENDENCY RESOLUTION — CIRCULAR DEPENDENCIES
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — resolveDependencies() circular', () => {
  it('detects simple circular dependency (A ↔ B)', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
    const cycle = result.circular[0];
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('detects three-node circular dependency (A → B → C → A)', () => {
    const nodes: DependencyNode[] = [
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['c'] },
      { name: 'c', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    expect(result.circular.length).toBeGreaterThan(0);
  });

  it('resolves non-circular nodes while flagging circular ones', () => {
    const nodes: DependencyNode[] = [
      { name: 'good', dependencies: [] },
      { name: 'a', dependencies: ['b'] },
      { name: 'b', dependencies: ['a'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    // 'good' should not be in circular list
    const circularNames = result.circular.flat();
    expect(circularNames).not.toContain('good');
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILESYSTEM LOADING — loadManifest()
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — loadManifest()', () => {
  const tmpDir = path.join(__dirname, '.tmp-test-skills');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManifest(content: unknown): string {
    const skillDir = path.join(tmpDir, `skill-${Date.now()}`);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(content, null, 2),
    );
    return skillDir;
  }

  it('loads a valid manifest from disk', () => {
    const dir = writeManifest({ name: 'disk-skill', version: '1.0.0' });
    const manifest = loadManifest(dir);
    expect(manifest.name).toBe('disk-skill');
    expect(manifest.version).toBe('1.0.0');
  });

  it('loads a manifest with all fields', () => {
    const dir = writeManifest({
      name: 'full-skill',
      version: '2.0.0',
      description: 'A fully specified skill',
      author: 'Test Author',
      domain: 'secretary',
      dependencies: ['core'],
      submodules: [{ module_name: 'alerts' }],
    });
    const manifest = loadManifest(dir);
    expect(manifest.description).toBe('A fully specified skill');
    expect(manifest.domain).toBe('secretary');
    expect(manifest.dependencies).toEqual(['core']);
    expect(manifest.submodules).toHaveLength(1);
  });

  it('normalizes subSkills to submodules when loading v2 manifests', () => {
    const dir = writeManifest({
      name: 'training',
      version: '1.0.0',
      manifestVersion: 2,
      subSkills: [{ module_name: 'load-forecast', enabled_by_default: true }],
    });
    const manifest = loadManifest(dir);
    expect(manifest.subSkills).toEqual([{ module_name: 'load-forecast', enabled_by_default: true }]);
    expect(manifest.submodules).toEqual([{ module_name: 'load-forecast', enabled_by_default: true }]);
  });

  it('throws when manifest.json is missing', () => {
    const emptyDir = path.join(tmpDir, 'empty-skill');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(() => loadManifest(emptyDir)).toThrow('Manifest not found');
  });

  it('throws on invalid JSON', () => {
    const skillDir = path.join(tmpDir, 'bad-json-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'manifest.json'), '{ invalid json }');
    expect(() => loadManifest(skillDir)).toThrow('Invalid JSON');
  });

  it('throws on valid JSON but invalid manifest (missing name)', () => {
    const dir = writeManifest({ version: '1.0.0' });
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
  });

  it('throws on valid JSON but invalid manifest (bad version)', () => {
    const dir = writeManifest({ name: 'a', version: 'latest' });
    expect(() => loadManifest(dir)).toThrow('Invalid manifest');
  });

  it('includes field-level errors in exception message', () => {
    const dir = writeManifest({});
    try {
      loadManifest(dir);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('name');
      expect(err.message).toContain('version');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('SkillLoader — edge cases', () => {
  it('validates manifest with undefined optional fields', () => {
    const result = validateManifest({
      name: 'minimal',
      version: '0.0.1',
      description: undefined,
      author: undefined,
      domain: undefined,
    });
    expect(result.valid).toBe(true);
  });

  it('handles empty nodes array in dependency resolution', () => {
    const result = resolveDependencies([], new Set());
    expect(result.resolved).toBe(true);
    expect(result.order).toEqual([]);
  });

  it('handles self-referencing dependency', () => {
    const nodes: DependencyNode[] = [
      { name: 'narcissist', dependencies: ['narcissist'] },
    ];
    const result = resolveDependencies(nodes, new Set());
    expect(result.resolved).toBe(false);
    // Self-reference creates a cycle
    expect(result.circular.length).toBeGreaterThan(0);
  });

  it('validates manifest with empty submodules array', () => {
    const result = validateManifest({
      name: 'a', version: '1.0.0', submodules: [],
    });
    expect(result.valid).toBe(true);
  });

  it('validates manifest where numeric name-like string passes typeof but fails regex', () => {
    const result = validateManifest({ name: '123', version: '1.0.0' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('name');
  });
});
