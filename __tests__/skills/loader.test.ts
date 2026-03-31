import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initSkillLoader,
  getLoadedSkills,
  getSkill,
  loadSkillPrompt,
  unloadAllSkills,
  isVersionCompatible,
} from '../../src/skills/loader';
import type { SkillManifest } from '../../src/skills/types';

// ── Test helpers ───────────────────────────────────────────────────

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
}

function writeSkill(baseDir: string, dirName: string, manifest: Partial<SkillManifest>, files?: Record<string, string>): string {
  const dir = path.join(baseDir, dirName);
  fs.mkdirSync(dir, { recursive: true });

  const fullManifest: SkillManifest = {
    name: manifest.name ?? dirName,
    version: manifest.version ?? '1.0.0',
    description: manifest.description ?? `Test skill: ${dirName}`,
    hubVersion: manifest.hubVersion ?? '*',
    ...manifest,
  };

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(fullManifest, null, 2));

  if (files) {
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }

  return dir;
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Tests ──────────────────────────────────────────────────────────

describe('SkillLoader', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
    unloadAllSkills();
  });

  afterEach(() => {
    unloadAllSkills();
    cleanupDir(tmpDir);
  });

  // ── initSkillLoader ────────────────────────────────────────────

  describe('initSkillLoader', () => {
    it('returns empty array when skills directory does not exist', () => {
      const results = initSkillLoader(path.join(tmpDir, 'nonexistent'));
      expect(results).toEqual([]);
      expect(getLoadedSkills().size).toBe(0);
    });

    it('returns empty array when skills directory is empty', () => {
      const results = initSkillLoader(tmpDir);
      expect(results).toEqual([]);
    });

    it('loads a single valid skill', () => {
      writeSkill(tmpDir, 'hello-skill', {
        name: 'hello-skill',
        version: '1.0.0',
        description: 'A hello skill',
        hubVersion: '*',
      });

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].skill?.manifest.name).toBe('hello-skill');
      expect(getLoadedSkills().size).toBe(1);
    });

    it('loads multiple skills', () => {
      writeSkill(tmpDir, 'skill-a', { name: 'skill-a' });
      writeSkill(tmpDir, 'skill-b', { name: 'skill-b' });
      writeSkill(tmpDir, 'skill-c', { name: 'skill-c' });

      const results = initSkillLoader(tmpDir);
      const successes = results.filter((r) => r.success);
      expect(successes).toHaveLength(3);
      expect(getLoadedSkills().size).toBe(3);
    });

    it('ignores non-directory entries', () => {
      writeSkill(tmpDir, 'real-skill', { name: 'real-skill' });
      fs.writeFileSync(path.join(tmpDir, 'not-a-skill.txt'), 'hello');

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
    });

    it('reports error for directory without manifest.json', () => {
      fs.mkdirSync(path.join(tmpDir, 'no-manifest'));

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('No manifest.json');
    });

    it('reports error for invalid JSON in manifest', () => {
      const dir = path.join(tmpDir, 'bad-json');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{ broken json');

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('Failed to parse');
    });
  });

  // ── Manifest validation ────────────────────────────────────────

  describe('manifest validation', () => {
    it('rejects manifest missing name', () => {
      const dir = path.join(tmpDir, 'no-name');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('missing required field: name');
    });

    it('rejects manifest missing version', () => {
      const dir = path.join(tmpDir, 'no-version');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        description: 'test',
        hubVersion: '*',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('missing required field: version');
    });

    it('rejects manifest missing hubVersion', () => {
      const dir = path.join(tmpDir, 'no-hub');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('missing required field: hubVersion');
    });

    it('rejects manifest with empty name', () => {
      const dir = path.join(tmpDir, 'empty-name');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: '  ',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('missing required field: name');
    });

    it('rejects non-array dependencies', () => {
      const dir = path.join(tmpDir, 'bad-deps');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
        dependencies: 'not-an-array',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('dependencies must be an array');
    });

    it('rejects non-array commands', () => {
      const dir = path.join(tmpDir, 'bad-cmds');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
        commands: 'oops',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('commands must be an array');
    });

    it('rejects non-array tools', () => {
      const dir = path.join(tmpDir, 'bad-tools');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
        tools: 'nope',
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('tools must be an array');
    });

    it('rejects non-array agents', () => {
      const dir = path.join(tmpDir, 'bad-agents');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
        agents: {},
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('agents must be an array');
    });

    it('rejects prompt with missing file', () => {
      const dir = path.join(tmpDir, 'missing-prompt');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        name: 'test',
        version: '1.0.0',
        description: 'test',
        hubVersion: '*',
        prompts: [{ name: 'greet', file: 'prompts/greet.md' }],
      }));

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('prompt file not found');
    });

    it('accepts valid manifest with all optional fields', () => {
      writeSkill(tmpDir, 'full-skill', {
        name: 'full-skill',
        version: '2.0.0',
        description: 'A fully specified skill',
        hubVersion: '*',
        commands: [{ command: 'greet', description: 'Say hello', handler: 'handlers/greet.js' }],
        tools: [{ name: 'greet_tool', description: 'Greeting tool', input_schema: { type: 'object' } }],
        agents: [{ name: 'greeter', description: 'Greeter agent', handler: 'agents/greeter.js' }],
        prompts: [{ name: 'greet-prompt', file: 'prompts/greet.md' }],
      }, {
        'prompts/greet.md': '# Hello\nYou are a greeting assistant.',
      });

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].skill?.manifest.commands).toHaveLength(1);
      expect(results[0].skill?.manifest.tools).toHaveLength(1);
      expect(results[0].skill?.manifest.agents).toHaveLength(1);
      expect(results[0].skill?.manifest.prompts).toHaveLength(1);
    });
  });

  // ── Hub version compatibility ──────────────────────────────────

  describe('isVersionCompatible', () => {
    it('wildcard always matches', () => {
      expect(isVersionCompatible('4.4.1', '*')).toBe(true);
      expect(isVersionCompatible('0.0.1', '*')).toBe(true);
    });

    it('exact version match', () => {
      expect(isVersionCompatible('4.4.1', '4.4.1')).toBe(true);
      expect(isVersionCompatible('4.4.1', '4.4.0')).toBe(false);
      expect(isVersionCompatible('4.4.1', '4.5.0')).toBe(false);
    });

    it('>= range', () => {
      expect(isVersionCompatible('4.4.1', '>=4.0.0')).toBe(true);
      expect(isVersionCompatible('4.4.1', '>=4.4.1')).toBe(true);
      expect(isVersionCompatible('4.4.1', '>=4.4.2')).toBe(false);
      expect(isVersionCompatible('5.0.0', '>=4.0.0')).toBe(true);
      expect(isVersionCompatible('3.9.9', '>=4.0.0')).toBe(false);
    });

    it('caret range (same major, >= minor.patch)', () => {
      expect(isVersionCompatible('4.4.1', '^4.0.0')).toBe(true);
      expect(isVersionCompatible('4.4.1', '^4.4.1')).toBe(true);
      expect(isVersionCompatible('4.4.1', '^4.5.0')).toBe(false);
      expect(isVersionCompatible('5.0.0', '^4.0.0')).toBe(false);  // major mismatch
    });

    it('rejects incompatible hub version during load', () => {
      writeSkill(tmpDir, 'future-skill', {
        name: 'future-skill',
        hubVersion: '>=99.0.0',
      });

      const results = initSkillLoader(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].error).toContain('requires hub >=99.0.0');
    });
  });

  // ── Dependency resolution ──────────────────────────────────────

  describe('dependency resolution', () => {
    it('loads skills with satisfied dependencies', () => {
      writeSkill(tmpDir, 'base', { name: 'base' });
      writeSkill(tmpDir, 'dependent', {
        name: 'dependent',
        dependencies: ['base'],
      });

      const results = initSkillLoader(tmpDir);
      const successes = results.filter((r) => r.success);
      expect(successes).toHaveLength(2);

      // base should be loaded before dependent
      const skills = Array.from(getLoadedSkills().keys());
      expect(skills.indexOf('base')).toBeLessThan(skills.indexOf('dependent'));
    });

    it('detects missing dependencies', () => {
      writeSkill(tmpDir, 'orphan', {
        name: 'orphan',
        dependencies: ['nonexistent'],
      });

      const results = initSkillLoader(tmpDir);
      expect(results.some((r) => !r.success && r.error?.includes('not installed'))).toBe(true);
    });

    it('detects circular dependencies', () => {
      writeSkill(tmpDir, 'alpha', {
        name: 'alpha',
        dependencies: ['beta'],
      });
      writeSkill(tmpDir, 'beta', {
        name: 'beta',
        dependencies: ['alpha'],
      });

      const results = initSkillLoader(tmpDir);
      expect(results.some((r) => !r.success && r.error?.includes('Circular dependency'))).toBe(true);
    });

    it('handles diamond dependencies (A→B, A→C, B→D, C→D)', () => {
      writeSkill(tmpDir, 'd-base', { name: 'd-base' });
      writeSkill(tmpDir, 'd-left', { name: 'd-left', dependencies: ['d-base'] });
      writeSkill(tmpDir, 'd-right', { name: 'd-right', dependencies: ['d-base'] });
      writeSkill(tmpDir, 'd-top', { name: 'd-top', dependencies: ['d-left', 'd-right'] });

      const results = initSkillLoader(tmpDir);
      const successes = results.filter((r) => r.success);
      expect(successes).toHaveLength(4);

      const order = Array.from(getLoadedSkills().keys());
      expect(order.indexOf('d-base')).toBeLessThan(order.indexOf('d-left'));
      expect(order.indexOf('d-base')).toBeLessThan(order.indexOf('d-right'));
      expect(order.indexOf('d-left')).toBeLessThan(order.indexOf('d-top'));
      expect(order.indexOf('d-right')).toBeLessThan(order.indexOf('d-top'));
    });

    it('skips skill when dependency failed to load', () => {
      writeSkill(tmpDir, 'bad-base', {
        name: 'bad-base',
        hubVersion: '>=99.0.0',  // will fail version check
      });
      writeSkill(tmpDir, 'child', {
        name: 'child',
        dependencies: ['bad-base'],
      });

      const results = initSkillLoader(tmpDir);
      expect(results.filter((r) => r.success)).toHaveLength(0);
      expect(results.some((r) => r.error?.includes('failed to load'))).toBe(true);
    });
  });

  // ── getSkill / getLoadedSkills ─────────────────────────────────

  describe('getSkill', () => {
    it('returns undefined for unknown skill', () => {
      expect(getSkill('nope')).toBeUndefined();
    });

    it('returns loaded skill by name', () => {
      writeSkill(tmpDir, 'finder', { name: 'finder', version: '3.2.1' });
      initSkillLoader(tmpDir);

      const skill = getSkill('finder');
      expect(skill).toBeDefined();
      expect(skill?.manifest.version).toBe('3.2.1');
      expect(skill?.directory).toContain('finder');
      expect(skill?.loadedAt).toBeInstanceOf(Date);
    });
  });

  // ── Prompt hot-reload ──────────────────────────────────────────

  describe('loadSkillPrompt', () => {
    it('returns null for unknown skill', () => {
      expect(loadSkillPrompt('nonexistent', 'greet')).toBeNull();
    });

    it('returns null for unknown prompt name', () => {
      writeSkill(tmpDir, 'prompt-skill', { name: 'prompt-skill' });
      initSkillLoader(tmpDir);
      expect(loadSkillPrompt('prompt-skill', 'no-such-prompt')).toBeNull();
    });

    it('reads prompt content from file', () => {
      writeSkill(tmpDir, 'prompt-skill', {
        name: 'prompt-skill',
        prompts: [{ name: 'greet', file: 'prompts/greet.md' }],
      }, {
        'prompts/greet.md': '# Hello\nYou are helpful.',
      });

      initSkillLoader(tmpDir);
      const content = loadSkillPrompt('prompt-skill', 'greet');
      expect(content).toBe('# Hello\nYou are helpful.');
    });

    it('hot-reloads when file changes on disk', () => {
      writeSkill(tmpDir, 'hot-skill', {
        name: 'hot-skill',
        prompts: [{ name: 'dynamic', file: 'prompts/dynamic.md' }],
      }, {
        'prompts/dynamic.md': 'Version 1',
      });

      initSkillLoader(tmpDir);
      expect(loadSkillPrompt('hot-skill', 'dynamic')).toBe('Version 1');

      // Modify the file — need to ensure mtime actually changes
      const filePath = path.join(tmpDir, 'hot-skill', 'prompts', 'dynamic.md');
      const stat = fs.statSync(filePath);
      // Force a different mtime by setting it 2 seconds in the future
      const newTime = new Date(stat.mtimeMs + 2000);
      fs.writeFileSync(filePath, 'Version 2');
      fs.utimesSync(filePath, newTime, newTime);

      expect(loadSkillPrompt('hot-skill', 'dynamic')).toBe('Version 2');
    });

    it('returns cached content when file has not changed', () => {
      writeSkill(tmpDir, 'cached-skill', {
        name: 'cached-skill',
        prompts: [{ name: 'stable', file: 'prompts/stable.md' }],
      }, {
        'prompts/stable.md': 'Stable content',
      });

      initSkillLoader(tmpDir);
      const first = loadSkillPrompt('cached-skill', 'stable');
      const second = loadSkillPrompt('cached-skill', 'stable');
      expect(first).toBe('Stable content');
      expect(second).toBe('Stable content');
    });
  });

  // ── unloadAllSkills ────────────────────────────────────────────

  describe('unloadAllSkills', () => {
    it('clears all loaded skills', () => {
      writeSkill(tmpDir, 'temp-skill', { name: 'temp-skill' });
      initSkillLoader(tmpDir);
      expect(getLoadedSkills().size).toBe(1);

      unloadAllSkills();
      expect(getLoadedSkills().size).toBe(0);
      expect(getSkill('temp-skill')).toBeUndefined();
    });

    it('allows re-initialization after unload', () => {
      writeSkill(tmpDir, 'reloadable', { name: 'reloadable' });
      initSkillLoader(tmpDir);
      unloadAllSkills();

      const results = initSkillLoader(tmpDir);
      expect(results[0].success).toBe(true);
      expect(getLoadedSkills().size).toBe(1);
    });
  });
});
