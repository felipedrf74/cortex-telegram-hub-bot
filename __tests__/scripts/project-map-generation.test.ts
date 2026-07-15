import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { projectMapFreshnessProjection } from '../../scripts/lib/project-map-freshness.mjs';
import {
  normalizedGitMode,
  projectMapSourceDigest,
} from '../../scripts/lib/project-map-source-digest.mjs';

type ProjectMap = {
  schema: string;
  generatedFrom: {
    authoritativeFreshness: string;
    sourceDigestAlgorithm: string;
    sourceDigest: string;
    baseCommit: string;
    baseCommitTimestamp: string;
  };
  modules: Array<{ path: string; files: number }>;
  routes: Array<{
    method: string;
    path: string;
    localPath: string;
    mountPath: string | null;
    source: string;
  }>;
  migrations: { count: number; latest: string | null };
  tests: { files: number };
};

const generator = 'scripts/generate-project-map.mjs';

function proposedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((file) => file !== 'docs/project-map.json' && fs.existsSync(file))
    .sort();
}

function generatedMap(): { serialized: string; map: ProjectMap } {
  const serialized = execFileSync(process.execPath, [generator, '--stdout'], { encoding: 'utf8' });
  return { serialized, map: JSON.parse(serialized) as ProjectMap };
}

describe('project map generation', () => {
  it('is deterministic and binds freshness to the proposed-tree digest', () => {
    const first = generatedMap();
    const second = generatedMap();

    expect(second.serialized).toBe(first.serialized);
    expect(first.map.schema).toBe('nexus.project-map.v2');
    expect(first.map.generatedFrom.authoritativeFreshness).toBe('sourceDigest');
    expect(first.map.generatedFrom.sourceDigestAlgorithm).toBe('sha256-path-git-mode-content-v2');
    expect(first.map.generatedFrom.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.map.generatedFrom.baseCommit).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
    expect(first.map.generatedFrom.baseCommitTimestamp).toBe(
      execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf8' }).trim(),
    );
  });

  it('normalizes filesystem permissions to Git file and symlink modes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-map-mode-'));
    const file = path.join(directory, 'fixture.txt');
    const link = path.join(directory, 'fixture-link');
    fs.writeFileSync(file, 'stable bytes\n', { mode: 0o600 });
    fs.symlinkSync('fixture.txt', link);

    try {
      const nonExecutable = projectMapSourceDigest(directory, ['fixture-link', 'fixture.txt']);
      expect(normalizedGitMode(fs.lstatSync(file))).toBe('100644');
      expect(normalizedGitMode(fs.lstatSync(link))).toBe('120000');

      fs.chmodSync(file, 0o644);
      expect(projectMapSourceDigest(directory, ['fixture-link', 'fixture.txt'])).toBe(nonExecutable);

      fs.chmodSync(file, 0o755);
      expect(normalizedGitMode(fs.lstatSync(file))).toBe('100755');
      expect(projectMapSourceDigest(directory, ['fixture-link', 'fixture.txt'])).not.toBe(nonExecutable);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports current single-file modules, tests, and migrations', () => {
    const { map } = generatedMap();
    const files = proposedFiles();
    const tests = files.filter((file) => file.startsWith('__tests__/') && /\.test\.ts$/.test(file));
    const migrations = files.filter((file) => /^migrations\/\d{3}_.+\.sql$/.test(file)).sort();

    expect(map.modules.find((entry) => entry.path === 'src/index.ts')?.files).toBe(1);
    expect(map.modules.find((entry) => entry.path === 'src/config.ts')?.files).toBe(1);
    expect(map.modules.every((entry) => entry.files > 0)).toBe(true);
    expect(map.tests.files).toBe(tests.length);
    expect(map.migrations).toMatchObject({
      count: migrations.length,
      latest: migrations.at(-1),
    });
  });

  it('resolves router-local roots to their public mounted paths', () => {
    const { map } = generatedMap();

    expect(map.routes.filter((route) => route.mountPath === null)).toEqual([]);
    expect(map.routes).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/v1',
      localPath: '/',
      mountPath: '/api/v1',
      source: 'src/api/router.ts',
    }));
    expect(map.routes).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/v1/connections',
      localPath: '/',
      mountPath: '/api/v1/connections',
      source: 'src/api/routes/connections.ts',
    }));
    expect(map.routes).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/waitlist',
      localPath: '/',
      mountPath: '/waitlist',
      source: 'src/api/routes/waitlist.ts',
    }));
    expect(map.routes).toContainEqual(expect.objectContaining({
      method: 'POST',
      path: '/api/v1/training/plan/capacity-context/refresh',
      localPath: '/plan/capacity-context/refresh',
      mountPath: '/api/v1/training',
      source: 'src/api/routes/training-plan-revision-routes.ts',
    }));
  });

  it('does not drift when only non-authoritative commit provenance advances', () => {
    const generated = generatedMap();
    const advanced = structuredClone(generated.map);
    advanced.generatedFrom.baseCommit = '0'.repeat(40);
    advanced.generatedFrom.baseCommitTimestamp = '2000-01-01T00:00:00Z';

    expect(projectMapFreshnessProjection(advanced)).toBe(
      projectMapFreshnessProjection(generated.serialized),
    );
  });

  it('fails closed when the committed map is stale', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-project-map-'));
    const staleOutput = path.join(directory, 'project-map.json');
    fs.writeFileSync(staleOutput, '{}\n');

    try {
      const result = spawnSync(
        process.execPath,
        [generator, '--check', '--output', staleOutput],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Project map drift');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('is enforced by documentation audit and both CI change lanes', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const audit = fs.readFileSync('scripts/audit-docs.mjs', 'utf8');
    const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    const housekeeping = fs.readFileSync('.github/workflows/weekly-housekeeping.yml', 'utf8');
    const skill = fs.readFileSync('.agents/skills/test-audit/SKILL.md', 'utf8');

    expect(packageJson.scripts['project:map:check']).toBe(
      'node scripts/generate-project-map.mjs --check',
    );
    expect(audit).toContain("['scripts/generate-project-map.mjs', '--check']");
    expect(audit).toContain("add('project-map-drift'");
    expect(workflow).toContain('name: Project map freshness');
    expect(workflow).toContain('run: npm run project:map:check');
    expect(workflow).toMatch(/docs_and_secrets:[\s\S]*?- run: npm ci[\s\S]*?audit-docs\.mjs --strict/);
    expect(housekeeping).toMatch(/setup-node@[a-f0-9]+[\s\S]*?- run: npm ci[\s\S]*?audit-docs\.mjs/);
    expect(skill).not.toContain('929-file');
  });
});
