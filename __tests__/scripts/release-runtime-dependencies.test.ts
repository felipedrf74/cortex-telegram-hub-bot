import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LEGACY_RUNTIME_DEPENDENCY_SCHEMA,
  RUNTIME_DEPENDENCY_SCHEMA,
  buildRuntimeDependencyLock,
  canonicalJson,
  expandedRuntimeTreeIdentity,
  extractRuntimeArchive,
  validateExpandedRuntimeReceipt,
  validateRuntimeDependencyLock,
} from '../../scripts/release-runtime-dependencies.mjs';
import {
  assertHermeticUvEnvironment,
  verifyCommittedPythonLocks,
} from '../../scripts/generate-python-release-lock.mjs';

const roots: string[] = [];

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-deps-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'content-engine'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime-dependencies'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'content-engine/requirements.txt'), 'fastapi==0.136.1\n');
  fs.writeFileSync(
    path.join(root, 'content-engine/requirements-release.txt'),
    'fastapi==0.136.1 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
  );
  fs.writeFileSync(path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'), 'node-archive');
  fs.writeFileSync(
    path.join(root, 'dist/runtime-dependencies/python-site-packages.tar.gz'),
    'python-archive',
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
  it('binds the lockfiles, exact target, and both prebuilt dependency archives', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);

    expect(validateRuntimeDependencyLock(lock, root)).toEqual(lock);
    expect(lock).toMatchObject({
      schema: RUNTIME_DEPENDENCY_SCHEMA,
      target,
      nodeArchive: { path: 'dist/runtime-dependencies/node_modules.tar.gz' },
      pythonArchive: { path: 'dist/runtime-dependencies/python-site-packages.tar.gz' },
    });
    expect(lock.inputs.packageLockSha256).toBe(createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex'));
    expect(lock.inputs.pythonReleaseRequirementsSha256).toBe(createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'content-engine/requirements-release.txt')))
      .digest('hex'));
  });

  it('rejects dependency-byte drift and a non-governed build platform', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);
    fs.appendFileSync(path.join(root, lock.pythonArchive.path), 'tampered');
    expect(() => validateRuntimeDependencyLock(lock, root)).toThrow('digest mismatch');

    const wrong = buildRuntimeDependencyLock(root, { ...target, architecture: 'arm64' });
    expect(() => validateRuntimeDependencyLock(wrong, root)).toThrow('outside release policy');
  });

  it('rejects the retired wheel-install lock shape', () => {
    const root = fixtureRoot();
    const lock = buildRuntimeDependencyLock(root, target);
    const legacy = {
      ...lock,
      pythonWheels: [lock.pythonArchive],
    } as Record<string, unknown>;
    delete legacy.pythonArchive;

    expect(() => validateRuntimeDependencyLock(legacy, root))
      .toThrow('fields do not match the governed schema');
  });

  it('accepts only an exact v2/v1 pair through predecessor verification', () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, 'node_modules/example'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content-engine/vendor/example'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/example/index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(
      path.join(root, 'content-engine/vendor/example/__init__.py'),
      'VALUE = 1\n',
    );
    const current = buildRuntimeDependencyLock(root, target);
    const legacy = {
      ...current,
      schema: LEGACY_RUNTIME_DEPENDENCY_SCHEMA,
      inputs: {
        packageLockSha256: current.inputs.packageLockSha256,
        pythonRequirementsSha256: current.inputs.pythonRequirementsSha256,
      },
    };
    const receipt = {
      schema: 'nexus.network-independent-runtime-extraction.v1',
      status: 'passed',
      dependencyLockDigest: createHash('sha256')
        .update(canonicalJson(legacy)).digest('hex'),
      packageLockSha256: legacy.inputs.packageLockSha256,
      pythonRequirementsSha256: legacy.inputs.pythonRequirementsSha256,
      expandedTree: expandedRuntimeTreeIdentity(root),
      extractedAt: '2026-08-10T00:00:00.000Z',
    };

    expect(() => validateRuntimeDependencyLock(legacy, root))
      .toThrow('fields do not match the governed schema');
    expect(validateRuntimeDependencyLock(legacy, root, { allowLegacyV2: true }))
      .toEqual(legacy);
    expect(validateExpandedRuntimeReceipt(
      receipt,
      legacy,
      root,
      { allowLegacyV2: true },
    )).toEqual(receipt);
    expect(() => validateExpandedRuntimeReceipt(
      { ...receipt, schema: 'nexus.network-independent-runtime-extraction.v2' },
      legacy,
      root,
      { allowLegacyV2: true },
    )).toThrow('does not match the extracted dependency tree');
    expect(() => validateExpandedRuntimeReceipt(
      { ...receipt, pythonReleaseRequirementsSha256: 'a'.repeat(64) },
      legacy,
      root,
      { allowLegacyV2: true },
    )).toThrow('fields do not match the governed schema');
  });

  it('builds dependencies in CI and only verifies/extracts them on the server', () => {
    const extractor = fs.readFileSync('scripts/release-runtime-dependencies.mjs', 'utf8');
    const builder = fs.readFileSync('scripts/build-release-runtime-dependencies.sh', 'utf8');
    const workflow = fs.readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
    const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    const transaction = fs.readFileSync('scripts/remote-user-release-transaction.sh', 'utf8');
    const cutoverRunbook = fs.readFileSync('ops/nexus-release/README.md', 'utf8');

    expect(extractor).toContain("handle.extractall(destination, filter='data')");
    expect(extractor).toContain("command === 'extract-runtime'");
    expect(extractor).toContain('assertRuntimePlatform(lock, pythonBin)');
    expect(extractor).toContain('extractRuntimeDependencies(lock, root, pythonBin)');
    expect(extractor).toContain('fs.lstatSync(target)');
    expect(extractor).not.toMatch(/\b(?:pip|venv|npm)\b/);
    expect(builder).toContain("--only-binary=:all:");
    expect(builder).toContain('--require-hashes');
    expect(builder).toContain('--requirement content-engine/requirements-release.txt');
    expect(builder).toContain('--target "$python_stage/content-engine/vendor"');
    expect(builder).toContain('python-site-packages.tar.gz');
    expect(builder).toContain("gzip -n -6");
    expect(builder).toContain('nexus.release-optimization-telemetry.v1');
    expect(builder).toContain('"metric":"node-archive"');
    expect(builder).toContain("stat -c '%s' dist/runtime-dependencies/node_modules.tar.gz");
    expect(builder).not.toContain('release-runtime-dependencies.mjs verify --root');
    // The 2026-08-07 continuous-deployment refactor moved artifact production out
    // of ordinary CI: the deployable artifact is a container image pinned by
    // digest. The owner-dispatched checkpoint alone builds this legacy payload
    // for the PM2 fallback during cutover.
    expect(ciWorkflow).not.toContain('scripts/build-release-runtime-dependencies.sh');
    expect(ciWorkflow).not.toContain('release-bundle.mjs');
    expect(ciWorkflow).not.toContain('release-artifact-manifest.mjs');
    expect(workflow).toContain('scripts/build-release-runtime-dependencies.sh');
    expect(workflow).toContain('node scripts/release-bundle.mjs');
    expect(workflow).toContain('--output .local/release/checkpoint/bundle');
    expect(workflow).toContain('name: ${{ steps.fallback_bundle.outputs.artifact_name }}');
    expect(workflow).toContain('retention-days: 30');
    expect(workflow).not.toContain('release-runtime-dependencies.mjs extract-runtime');
    expect(transaction).toContain('release-runtime-dependencies.mjs extract-runtime');
    expect(transaction).toContain('verify-predecessor-extracted --root "$runtime"');
    expect(transaction).not.toContain('verify-extracted --allow-legacy-v2');
    expect(transaction.indexOf('verify-predecessor-extracted --root "$runtime"'))
      .toBeLessThan(transaction.indexOf('start_runtime "$RELEASE_DIR"'));
    expect(cutoverRunbook.match(
      /verify-predecessor-extracted --root "\$runtime"/g,
    )).toHaveLength(4);
    expect(cutoverRunbook).not.toContain('verify-extracted --root "$runtime"');
    expect(transaction).not.toMatch(/\b(?:npm|pip|venv)\b/);
    expect(transaction).not.toContain('release-runtime-dependencies.mjs install');
    expect(workflow).toContain("PYTHON_VERSION: '3.12.3'");
    // One remaining pin, in the content-engine test job. The second occurrence
    // belonged to the removed bundle-producing build job.
    expect(ciWorkflow.match(/python-version: '3\.12\.3'/g)).toHaveLength(1);
  });

  it('keeps every release dependency exact and hash-locked', () => {
    const sourceBytes = fs.readFileSync('content-engine/requirements.txt');
    const source = sourceBytes.toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const release = fs.readFileSync('content-engine/requirements-release.txt', 'utf8');
    const sourceDigest = createHash('sha256').update(sourceBytes).digest('hex');
    const blocks = release
      .split(/(?=^[a-z0-9_.-]+==)/gim)
      .filter((block) => /^[a-z0-9_.-]+==/i.test(block));
    const locked = new Map<string, string>();

    for (const block of blocks) {
      const match = block.match(/^([a-z0-9_.-]+)==([^\\\s]+)/i);
      expect(match).not.toBeNull();
      expect(block).toMatch(/--hash=sha256:[a-f0-9]{64}/);
      locked.set(match![1].toLowerCase(), match![2]);
    }

    expect(locked.size).toBeGreaterThan(source.length);
    expect(release).toContain('# generator: uv 0.10.9');
    expect(release).toContain(`# source-sha256: ${sourceDigest}`);
    expect(release).toContain('# target: CPython 3.12 on x86_64 glibc 2.36 or newer');
    expect(release).toContain('# index: https://pypi.org/simple');
    expect(release).toContain(
      '# resolution: highest; prerelease: disallow; fork-strategy: requires-python',
    );
    expect(release).toContain('# exclude-newer: 2026-08-10T00:00:00Z');
    const requirementLines = release
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(requirementLines).not.toMatch(/(?:git\+|https?:\/\/|--(?:extra-)?index-url)/i);
    for (const requirement of source) {
      const match = requirement.match(/^([a-z0-9_.-]+)(?:\[[^\]]+\])?==([^\s]+)$/i);
      expect(match, `source requirement must be exact: ${requirement}`).not.toBeNull();
      expect(locked.get(match![1].toLowerCase())).toBe(match![2]);
    }
  });

  it('verifies both committed lock closures without invoking the resolver', () => {
    expect(verifyCommittedPythonLocks()).toMatchObject({
      release: { packageCount: 44 },
      auditTool: { packageCount: 29 },
    });
  });

  it('refuses ambient package-manager policy during lock generation', () => {
    expect(() => assertHermeticUvEnvironment({ UV_RESOLUTION: 'lowest' })).toThrow(
      'release lock generation refuses ambient package policy: UV_RESOLUTION',
    );
    expect(() => assertHermeticUvEnvironment({ PIP_INDEX_URL: 'https://mirror.invalid/simple' }))
      .toThrow('release lock generation refuses ambient package policy: PIP_INDEX_URL');
    expect(() => assertHermeticUvEnvironment({
      PATH: process.env.PATH,
      PIP_CACHE_DIR: '/tmp/cache-only',
      UV_CACHE_DIR: '/tmp/cache-only',
    })).not.toThrow();
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
    extractRuntimeArchive(
      path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'),
      root,
      'node_modules',
      'python3',
    );

    expect(fs.readFileSync(
      path.join(root, 'node_modules/example/package.json'),
      'utf8',
    )).toContain('"name":"example"');
  });

  it('rejects a dangling dependency-tree symlink before extraction', () => {
    const root = fixtureRoot();
    fs.symlinkSync('missing-node-modules-target', path.join(root, 'node_modules'));

    expect(() => extractRuntimeArchive(
      path.join(root, 'dist/runtime-dependencies/node_modules.tar.gz'),
      root,
      'node_modules',
      'python3',
    )).toThrow('requires an absent target');
  });

  it.each(['traversal', 'device', 'escaping-link'])(
    'rejects an unsafe %s archive entry',
    (kind) => {
      const root = fixtureRoot();
      const archive = path.join(root, `unsafe-${kind}.tar.gz`);
      execFileSync('python3', ['-c', String.raw`
import io, sys, tarfile
archive, kind = sys.argv[1:]
with tarfile.open(archive, 'w:gz') as handle:
    member = tarfile.TarInfo()
    if kind == 'traversal':
        member.name = '../escape'
        member.size = 1
        handle.addfile(member, io.BytesIO(b'x'))
    elif kind == 'device':
        member.name = 'node_modules/device'
        member.type = tarfile.CHRTYPE
        member.devmajor = 1
        member.devminor = 3
        handle.addfile(member)
    else:
        member.name = 'node_modules/escape-link'
        member.type = tarfile.SYMTYPE
        member.linkname = '../../escape'
        handle.addfile(member)
`, archive, kind]);

      expect(() => extractRuntimeArchive(archive, root, 'node_modules', 'python3'))
        .toThrow();
    },
  );

  it('changes the expanded-tree identity when extracted bytes drift', () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, 'node_modules/example'), { recursive: true });
    fs.mkdirSync(path.join(root, 'content-engine/vendor/example'), { recursive: true });
    const targetFile = path.join(root, 'node_modules/example/index.js');
    fs.writeFileSync(targetFile, 'module.exports = 1;\n');
    fs.writeFileSync(
      path.join(root, 'content-engine/vendor/example/__init__.py'),
      'VALUE = 1\n',
    );
    const before = expandedRuntimeTreeIdentity(root);
    fs.appendFileSync(targetFile, 'module.exports = 2;\n');

    expect(expandedRuntimeTreeIdentity(root).sha256).not.toBe(before.sha256);
  });
});
