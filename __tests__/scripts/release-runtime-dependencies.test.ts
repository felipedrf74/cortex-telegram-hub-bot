import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_DEPENDENCY_SCHEMA,
  buildRuntimeDependencyLock,
  extractNodeModules,
  validateRuntimeDependencyLock,
} from '../../scripts/release-runtime-dependencies.mjs';

const roots: string[] = [];

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-deps-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'content-engine'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime-dependencies/python-wheelhouse'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'content-engine/requirements.txt'), 'fastapi==0.136.1\n');
  fs.writeFileSync(path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'), 'node-archive');
  fs.writeFileSync(
    path.join(root, 'dist/runtime-dependencies/python-wheelhouse/fastapi-0.136.1-py3-none-any.whl'),
    'wheel-bytes',
  );
  return root;
}

const target = {
  os: 'ubuntu',
  osVersion: '24.04',
  architecture: 'x86_64',
  node: 'v22.23.1',
  python: 'Python 3.12.11',
};

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('network-independent release runtime dependencies', () => {
  it('binds the lockfiles, exact target, Node archive, and every Python wheel', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);

    expect(validateRuntimeDependencyLock(lock, root)).toEqual(lock);
    expect(lock).toMatchObject({
      schema: RUNTIME_DEPENDENCY_SCHEMA,
      target,
      nodeArchive: { path: 'dist/runtime-dependencies/node_modules.tar.gz' },
      pythonWheels: [{ path: expect.stringContaining('fastapi-0.136.1') }],
    });
    expect(lock.inputs.packageLockSha256).toBe(createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex'));
  });

  it('rejects dependency-byte drift and a non-governed build platform', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);
    fs.appendFileSync(path.join(root, lock.pythonWheels[0].path), 'tampered');
    expect(() => validateRuntimeDependencyLock(lock, root)).toThrow('digest mismatch');

    const wrong = buildRuntimeDependencyLock(root, { ...target, architecture: 'arm64' });
    expect(() => validateRuntimeDependencyLock(wrong, root)).toThrow('outside release policy');
  });

  it('uses locale-independent wheel ordering for hyphenated and underscored names', () => {
    const root = fixtureRoot();
    fs.writeFileSync(
      path.join(root, 'dist/runtime-dependencies/python-wheelhouse/fastapi_cli-0.0.32-py3-none-any.whl'),
      'cli-wheel-bytes',
    );

    const lock = buildRuntimeDependencyLock(root, target);

    expect(lock.pythonWheels.map(({ path: wheelPath }) => path.basename(wheelPath))).toEqual([
      'fastapi-0.136.1-py3-none-any.whl',
      'fastapi_cli-0.0.32-py3-none-any.whl',
    ]);
    expect(validateRuntimeDependencyLock(lock, root)).toEqual(lock);
  });

  it('uses an offline installer with traversal-safe extraction and no staging package download', () => {
    const installer = fs.readFileSync('scripts/release-runtime-dependencies.mjs', 'utf8');
    const builder = fs.readFileSync('scripts/build-release-runtime-dependencies.sh', 'utf8');
    const workflow = fs.readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
    const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(installer).toContain("handle.extractall(destination, filter='data')");
    expect(installer).toContain("command === 'extract-node'");
    expect(installer).toContain('assertNodeInstallPlatform(lock)');
    expect(installer).toContain('extractNodeModules(lock, root)');
    expect(installer).toContain('fs.lstatSync(target)');
    expect(installer).not.toContain('fs.existsSync(nodeModules)');
    expect(installer).toContain("PIP_NO_INDEX: '1'");
    expect(installer).toContain("'--no-index'");
    expect(installer).toContain("python !== lock.target.python");
    expect(builder).toContain("--only-binary=:all:");
    expect(builder).toContain("gzip -n -6");
    expect(builder).toContain('nexus.release-optimization-telemetry.v1');
    expect(builder).toContain('"metric":"node-archive"');
    expect(builder).toContain("stat -c '%s' dist/runtime-dependencies/node_modules.tar.gz");
    expect(builder).not.toContain('release-runtime-dependencies.mjs verify --root');
    expect(workflow).toContain('scripts/build-release-runtime-dependencies.sh');
    expect(workflow).toContain('release-runtime-dependencies.mjs extract-node');
    expect(workflow).toContain("PYTHON_VERSION: '3.12.3'");
    expect(ciWorkflow.match(/python-version: '3\.12\.3'/g)).toHaveLength(2);
  });

  it('extracts the verified Node archive without network access', () => {
    const root = fixtureRoot();
    const archiveSource = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-deps-archive-'));
    roots.push(archiveSource);
    fs.mkdirSync(path.join(archiveSource, 'node_modules/example'), { recursive: true });
    fs.writeFileSync(
      path.join(archiveSource, 'node_modules/example/package.json'),
      '{"name":"example","version":"1.0.0"}\n',
    );
    execFileSync('tar', [
      '-czf',
      path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'),
      '-C',
      archiveSource,
      'node_modules',
    ], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const lock = buildRuntimeDependencyLock(root, target);

    extractNodeModules(lock, root, 'python3');

    expect(fs.readFileSync(
      path.join(root, 'node_modules/example/package.json'),
      'utf8',
    )).toContain('"name":"example"');
  });

  it('rejects a dangling dependency-tree symlink before extraction', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);
    fs.symlinkSync('missing-node-modules-target', path.join(root, 'node_modules'));

    expect(() => extractNodeModules(lock, root, 'python3'))
      .toThrow('requires an absent dependency tree');
  });
});
