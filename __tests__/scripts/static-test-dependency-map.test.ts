import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staticTestDependencyImpact } from '../../scripts/lib/static-test-dependency-map.mjs';

const roots: string[] = [];

function cleanGitEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
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
  fs.mkdirSync(path.join(root, '__tests__/misc'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 1;\n');
  fs.writeFileSync(path.join(root, 'src/middle.ts'), `
    import { leaf } from './leaf';
    export const middle = leaf;
  `);
  fs.writeFileSync(path.join(root, '__tests__/leaf.test.ts'), `
    import { leaf } from '../src/leaf';
    void leaf;
  `);
  fs.writeFileSync(path.join(root, '__tests__/misc/core.test.ts'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'config/test-groups.json'), JSON.stringify({
    version: 'fixture-v1',
    core: { targetSeconds: 30, tests: ['__tests__/misc/core.test.ts'] },
    groups: {
      fixture: {
        paths: ['src/**'],
        tests: ['__tests__/misc/**/*.test.ts'],
        contracts: ['__tests__/misc/core.test.ts'],
      },
    },
  }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function select(root: string, base: string, changedFiles: string[]) {
  const classifierPath = path.join(root, 'classifier.json');
  fs.writeFileSync(classifierPath, JSON.stringify({
    baseRef: base,
    changedFiles,
    vitest: { mode: 'focused', groups: ['fixture'] },
    flags: { docsOnly: false, impactResolved: true },
  }));
  const result = spawnSync(process.execPath, [
    'scripts/select-vitest-files.mjs',
    '--base', base,
    '--classifier', classifierPath,
    '--source-root', root,
    '--json',
  ], { cwd: process.cwd(), encoding: 'utf8', env: cleanGitEnv() });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('static selected-test dependency mapping', () => {
  it('ignores inherited Git hook variables instead of redirecting repository reads', () => {
    const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hook-git-sentinel-'));
    roots.push(sentinel);
    fs.writeFileSync(path.join(sentinel, 'sentinel.txt'), 'sentinel\n');
    git(sentinel, 'init', '-q');
    git(sentinel, 'config', 'user.email', 'sentinel@example.com');
    git(sentinel, 'config', 'user.name', 'Sentinel');
    git(sentinel, 'add', '.');
    git(sentinel, 'commit', '-qm', 'sentinel');
    const sentinelHead = git(sentinel, 'rev-parse', 'HEAD');
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_PREFIX: process.env.GIT_PREFIX,
    };
    try {
      process.env.GIT_DIR = path.join(sentinel, '.git');
      process.env.GIT_INDEX_FILE = path.join(sentinel, '.git/index');
      process.env.GIT_PREFIX = '';
      const { root, base } = fixture();
      fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 2;\n');
      expect(staticTestDependencyImpact(root, base, ['src/leaf.ts'])).toMatchObject({
        tests: ['__tests__/leaf.test.ts'],
        unresolvedProductionFiles: [],
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(git(sentinel, 'rev-parse', 'HEAD')).toBe(sentinelHead);
  });

  it('maps direct static test dependents without executing application code', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, '__tests__/leaf.test.ts'), `
      import { middle } from '../src/middle';
      export { leaf } from '../src/leaf';
      void import('../src/leaf');
      require.resolve('../src/leaf');
      void middle;
    `);
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'throw new Error("never execute");\n');
    git(root, 'add', 'src/leaf.ts');
    git(root, 'commit', '-qm', 'change leaf');
    expect(staticTestDependencyImpact(root, base)).toMatchObject({
      tests: ['__tests__/leaf.test.ts'],
      unresolvedProductionFiles: [],
    });
  });

  it('does not turn unrelated dynamic imports into a repository-wide dependent union', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, '__tests__/dynamic.test.ts'), `
      const target = '../src/other';
      void import(target);
    `);
    git(root, 'add', '__tests__/dynamic.test.ts');
    git(root, 'commit', '-qm', 'add dynamic test');
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 3;\n');
    expect(staticTestDependencyImpact(root, base, ['src/leaf.ts']).tests).toEqual([
      '__tests__/leaf.test.ts',
    ]);
  });

  it('reports changed production files that use non-literal module loading', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/loader.ts'), `
      export async function load(name) {
        return import('./' + name);
      }
    `);
    git(root, 'add', 'src/loader.ts');
    git(root, 'commit', '-qm', 'add loader');
    fs.writeFileSync(path.join(root, 'src/loader.ts'), `
      export async function load(name) {
        return import('./' + name + '.js');
      }
    `);
    expect(staticTestDependencyImpact(root, base, ['src/loader.ts'])).toMatchObject({
      tests: [],
      unresolvedProductionFiles: ['src/loader.ts'],
    });
  });

  it('does not traverse production cycles into unrelated transitive tests', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/cycle-a.ts'), `
      import { cycleB } from './cycle-b';
      export const cycleA = cycleB + 1;
    `);
    fs.writeFileSync(path.join(root, 'src/cycle-b.ts'), `
      import { cycleA } from './cycle-a';
      export const cycleB = cycleA + 1;
    `);
    fs.writeFileSync(path.join(root, '__tests__/cycle-a-direct.test.ts'), `
      import { cycleA } from '../src/cycle-a';
      void cycleA;
    `);
    fs.writeFileSync(path.join(root, '__tests__/cycle-b-transitive.test.ts'), `
      import { cycleB } from '../src/cycle-b';
      void cycleB;
    `);
    git(root, 'add', 'src/cycle-a.ts', 'src/cycle-b.ts',
      '__tests__/cycle-a-direct.test.ts', '__tests__/cycle-b-transitive.test.ts');
    git(root, 'commit', '-qm', 'add production cycle');
    fs.writeFileSync(path.join(root, 'src/cycle-a.ts'), `
      import { cycleB } from './cycle-b';
      export const cycleA = cycleB + 2;
    `);
    expect(staticTestDependencyImpact(root, base, ['src/cycle-a.ts']).tests).toEqual([
      '__tests__/cycle-a-direct.test.ts',
    ]);
  });

  it('uses the classifier changed-file inventory identically for dirty, staged, and committed changes', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/leaf.ts'), 'export const leaf = 2;\n');

    const dirty = select(root, base, ['src/leaf.ts']);
    expect(dirty.dependents).toEqual(['__tests__/leaf.test.ts']);
    expect(dirty.selected).toEqual([
      '__tests__/leaf.test.ts',
      '__tests__/misc/core.test.ts',
    ]);

    git(root, 'add', 'src/leaf.ts');
    const staged = select(root, base, ['src/leaf.ts']);
    expect(staged.dependents).toEqual(dirty.dependents);
    expect(staged.selected).toEqual(dirty.selected);

    git(root, 'commit', '-qm', 'change leaf');
    const committed = select(root, base, ['src/leaf.ts']);
    expect(committed.dependents).toEqual(dirty.dependents);
    expect(committed.selected).toEqual(dirty.selected);
  });

  it('selects a changed test itself even when it is outside the owning group pack', () => {
    const { root, base } = fixture();
    const test = '__tests__/new-contract.test.ts';
    fs.writeFileSync(path.join(root, test), 'export {};\n');
    const selection = select(root, base, [test]);
    expect(selection.changedTests).toEqual([test]);
    expect(selection.selected).toContain(test);
  });

  it('records a removed test without silently adding a full-suite fallback', () => {
    const { root, base } = fixture();
    fs.rmSync(path.join(root, '__tests__/leaf.test.ts'));
    const selection = select(root, base, ['__tests__/leaf.test.ts']);
    expect(selection.removed).toEqual(['__tests__/leaf.test.ts']);
    expect(selection.changedTests).toEqual([]);
    expect(selection.selected).toEqual(['__tests__/misc/core.test.ts']);
  });

  it('treats a rename as one removed test and one runnable changed test', () => {
    const { root, base } = fixture();
    fs.renameSync(
      path.join(root, '__tests__/leaf.test.ts'),
      path.join(root, '__tests__/leaf-renamed.test.ts'),
    );
    const selection = select(root, base, [
      '__tests__/leaf.test.ts',
      '__tests__/leaf-renamed.test.ts',
    ]);
    expect(selection.removed).toEqual(['__tests__/leaf.test.ts']);
    expect(selection.changedTests).toEqual(['__tests__/leaf-renamed.test.ts']);
    expect(selection.selected).toContain('__tests__/leaf-renamed.test.ts');
    expect(selection.selected).toContain('__tests__/misc/core.test.ts');
  });

  it('reports an unmapped production topology while group classification remains independently fail-closed', () => {
    const { root, base } = fixture();
    fs.writeFileSync(path.join(root, 'src/unmapped.ts'), 'export const value = true;\n');
    expect(staticTestDependencyImpact(root, base, ['src/unmapped.ts'])).toMatchObject({
      tests: [],
      unresolvedProductionFiles: ['src/unmapped.ts'],
    });
  });
});
