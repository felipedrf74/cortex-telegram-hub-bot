import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticTestDependencyImpact } from '../../scripts/lib/static-test-dependency-map.mjs';

const roots: string[] = [];

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return env;
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-static-test-map-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, '__tests__'), { recursive: true });
  fs.mkdirSync(path.join(root, '__tests__/misc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 1;\n');
  fs.writeFileSync(path.join(root, 'src/middle.ts'), `import {
  leaf,
} from './leaf';
export const middle = leaf;
`);
  fs.writeFileSync(path.join(root, '__tests__/leaf.test.ts'), `import {
  middle,
} from '../src/middle';
export { leaf } from '../src/leaf';
void import('../src/leaf');
require.resolve('../src/leaf');
void middle;
`);
  fs.writeFileSync(path.join(root, '__tests__/misc/unrelated.test.ts'), 'export {};\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('static release test dependency mapping', () => {
  it('cannot redirect a foreign fixture into the repository exported by a Git hook', () => {
    const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hook-git-sentinel-'));
    roots.push(sentinel);
    fs.writeFileSync(path.join(sentinel, 'sentinel.txt'), 'sentinel\n');
    git(sentinel, 'init', '-q');
    git(sentinel, 'config', 'user.email', 'sentinel@example.com');
    git(sentinel, 'config', 'user.name', 'Sentinel');
    git(sentinel, 'add', '.');
    git(sentinel, 'commit', '-qm', 'sentinel');

    const sentinelGitDir = path.join(sentinel, '.git');
    const sentinelConfig = path.join(sentinelGitDir, 'config');
    const sentinelIndex = path.join(sentinelGitDir, 'index');
    const configBefore = fs.readFileSync(sentinelConfig);
    const indexBefore = fs.readFileSync(sentinelIndex);
    const headBefore = git(sentinel, 'rev-parse', 'HEAD');
    const localKeys = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'] as const;
    const previous = Object.fromEntries(localKeys.map((key) => [key, process.env[key]]));

    try {
      process.env.GIT_DIR = sentinelGitDir;
      process.env.GIT_INDEX_FILE = sentinelIndex;
      process.env.GIT_PREFIX = '';
      const { root, base } = fixture();
      fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 2;\n');
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'change leaf');
      expect(staticTestDependencyImpact(root, base)).toMatchObject({
        tests: ['__tests__/leaf.test.ts'],
        unresolvedProductionFiles: [],
      });
    } finally {
      for (const key of localKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(fs.readFileSync(sentinelConfig)).toEqual(configBefore);
    expect(fs.readFileSync(sentinelIndex)).toEqual(indexBefore);
    expect(git(sentinel, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(sentinel, 'config', '--bool', 'core.bare')).toBe('false');
  });

  it('maps transitive multiline imports, exports, literal dynamic imports, and require.resolve without executing code', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'throw new Error("must never execute");\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change leaf');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: ['__tests__/leaf.test.ts'],
      unresolvedProductionFiles: [],
    });
  });

  it('reports an unmapped production module so release planning can fail closed to full', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/unmapped.ts'), 'export const unmapped = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'unmapped production module');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: [],
      unresolvedProductionFiles: ['src/unmapped.ts'],
    });
  });

  it('reports changed production modules with non-literal module loading', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/middle.ts'), `import { leaf } from './leaf';
export const middle = (name: string) => require(name) ?? leaf;
`);
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'dynamic load');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: ['__tests__/leaf.test.ts'],
      unresolvedProductionFiles: ['src/middle.ts'],
      nonLiteralImporters: expect.arrayContaining(['src/middle.ts']),
    });
  });

  it('never omits a separate test that uses a computed module load', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, '__tests__/dynamic.test.ts'), `import { expect, it } from 'vitest';
it('loads the selected module', async () => {
  const target = '../src/leaf';
  expect((await import(target)).leaf).toBeDefined();
});
`);
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 2;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'change leaf with dynamic coverage');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: ['__tests__/dynamic.test.ts', '__tests__/leaf.test.ts'],
      unresolvedProductionFiles: [],
      nonLiteralImporters: expect.arrayContaining(['__tests__/dynamic.test.ts']),
    });
  });

  it('does not let one focused domain mask an unrelated unmapped production file', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 2;\n');
    fs.writeFileSync(path.join(root, 'src/unmapped.ts'), 'export const unmapped = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'mixed mapped and unmapped changes');
    const classifierPath = path.join(root, 'classifier.json');
    fs.writeFileSync(classifierPath, JSON.stringify({
      vitest: { mode: 'focused', globs: ['__tests__/leaf.test.ts'] },
      flags: { impactResolved: true, fullSuiteTrigger: false },
    }));
    const result = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
      '--json',
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      changed: ['__tests__/leaf.test.ts'],
      focused: ['__tests__/leaf.test.ts'],
      unresolved: ['src/unmapped.ts'],
      impactResolved: false,
    });
    const plain = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.trim().split('\n').sort()).toEqual([
      '__tests__/leaf.test.ts',
      '__tests__/misc/unrelated.test.ts',
    ]);
  });

  it('separates a deleted test from the runnable changed-test selection and fails closed to all remaining tests', () => {
    const { root, base } = fixture();
    fs.rmSync(path.join(root, '__tests__/leaf.test.ts'));
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'delete retired test');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: [],
      removedTestFiles: ['__tests__/leaf.test.ts'],
    });

    const classifierPath = path.join(root, 'classifier.json');
    fs.writeFileSync(classifierPath, JSON.stringify({
      vitest: { mode: 'changed-only', globs: [] },
      flags: { impactResolved: true, fullSuiteTrigger: false },
    }));
    const json = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
      '--json',
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      changed: [],
      removed: ['__tests__/leaf.test.ts'],
      impactResolved: false,
      selected: [],
    });

    const plain = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.trim()).toBe('__tests__/misc/unrelated.test.ts');
  });

  it('treats a test rename as a removal plus a runnable new test and still fails closed to all remaining tests', () => {
    const { root, base } = fixture();
    fs.renameSync(
      path.join(root, '__tests__/leaf.test.ts'),
      path.join(root, '__tests__/leaf-renamed.test.ts'),
    );
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'rename test');

    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: ['__tests__/leaf-renamed.test.ts'],
      removedTestFiles: ['__tests__/leaf.test.ts'],
    });

    const classifierPath = path.join(root, 'classifier.json');
    fs.writeFileSync(classifierPath, JSON.stringify({
      vitest: { mode: 'changed-only', globs: [] },
      flags: { impactResolved: true, fullSuiteTrigger: false },
    }));
    const json = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
      '--json',
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      changed: ['__tests__/leaf-renamed.test.ts'],
      removed: ['__tests__/leaf.test.ts'],
      impactResolved: false,
      selected: ['__tests__/leaf-renamed.test.ts'],
    });

    const plain = spawnSync(process.execPath, [
      'scripts/select-vitest-files.mjs',
      '--base', base,
      '--classifier', classifierPath,
      '--source-root', root,
    ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stdout.trim().split('\n').sort()).toEqual([
      '__tests__/leaf-renamed.test.ts',
      '__tests__/misc/unrelated.test.ts',
    ]);
  });
});
