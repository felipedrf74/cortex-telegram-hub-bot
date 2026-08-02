import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RELEASE_RUNTIME_FILES,
  buildReleaseArtifactManifest,
  verifyInstalledReleaseSource,
  verifyReleaseBundle,
} from '../../scripts/lib/release-artifact-manifest.mjs';

const roots: string[] = [];

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-artifact-'));
  roots.push(root);
  for (const directory of [
    'dist',
    'catalog',
    'migrations',
    'prompts',
    'config',
    'content-engine/models',
  ]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'dist/index.js'), 'console.log("runtime");\n');
  fs.writeFileSync(path.join(root, 'migrations/001_init.sql'), 'SELECT 1;\n');
  fs.writeFileSync(path.join(root, 'prompts/base.md'), 'prompt\n');
  fs.writeFileSync(path.join(root, 'config/capability-manifest.json'), '{"schemaReferences":{}}\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('release artifact manifest', () => {
  it('ships only the lean server transaction and offline verification controls', () => {
    expect(RELEASE_RUNTIME_FILES).toEqual(expect.arrayContaining([
      'scripts/release-artifact-manifest.mjs',
      'scripts/lib/release-artifact-manifest.mjs',
      'scripts/lib/chat-capability-flag-transaction.mjs',
      'scripts/release-runtime-dependencies.mjs',
      'scripts/chat-capability-flag-operator.sh',
      'scripts/remote-chat-capability-flag-transaction.sh',
      'scripts/remote-user-release-transaction.sh',
      'scripts/routing-divergence-report.mjs',
      'scripts/staging-smoke-ollama.sh',
      'scripts/training-cross-skill-staging-smoke.sh',
      'scripts/with-smoke-evidence.sh',
    ]));
    expect(RELEASE_RUNTIME_FILES).not.toEqual(expect.arrayContaining([
      'scripts/promote-exact-release.sh',
      'scripts/release-manifest-v2.mjs',
      'scripts/remote-promotion-transaction.sh',
    ]));
  });

  it('changes the digest when runtime bytes change and excludes declarations', () => {
    const root = fixtureRoot();
    fs.writeFileSync(path.join(root, 'dist/index.d.ts'), 'export {};\n');
    const before = buildReleaseArtifactManifest(root);
    fs.appendFileSync(path.join(root, 'dist/index.js'), 'changed\n');
    const after = buildReleaseArtifactManifest(root);

    expect(after.digest).not.toBe(before.digest);
    expect(after.files.map((entry) => entry.path)).not.toContain('dist/index.d.ts');
  });

  it('rejects symlinks in runtime roots', () => {
    const root = fixtureRoot();
    fs.symlinkSync('/etc/passwd', path.join(root, 'dist/escape'));
    expect(() => buildReleaseArtifactManifest(root)).toThrow(
      'release artifact cannot contain a symbolic link',
    );
  });

  it('verifies a sealed bundle and rejects undeclared bytes', () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, 'dist/tools'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'dist/tools/training-cross-skill-staging-smoke.js'),
      'console.log("cross-skill-smoke");\n',
    );
    const manifest = buildReleaseArtifactManifest(root);
    const bundle = path.join(root, 'bundle');
    fs.mkdirSync(bundle);
    for (const entry of manifest.files) {
      const destination = path.join(bundle, entry.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, entry.path), destination);
    }
    fs.writeFileSync(
      path.join(bundle, 'artifact-manifest.json'),
      `${JSON.stringify({ ...manifest, root: '.' }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(bundle, '.complete.json'), `${JSON.stringify({
      schema: 'nexus.release-bundle.v1',
      runtimeSha: 'a'.repeat(40),
      packageVersion: '1.0.0',
      artifactDigest: manifest.digest,
      fileCount: manifest.fileCount,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);

    expect(verifyReleaseBundle(bundle, 'a'.repeat(40)).digest).toBe(manifest.digest);
    const verifiedCandidate = spawnSync(process.execPath, [
      path.resolve('scripts/release-artifact-manifest.mjs'),
      '--verify-installed-source', bundle,
      '--require-declared-file', 'dist/tools/training-cross-skill-staging-smoke.js',
    ], { encoding: 'utf8' });
    expect(verifiedCandidate.status).toBe(0);
    expect(JSON.parse(verifiedCandidate.stdout)).toEqual(expect.objectContaining({
      schema: 'nexus.release-installed-source-verification.v1',
      status: 'passed',
      runtimeSha: 'a'.repeat(40),
      artifactDigest: manifest.digest,
      releaseRoot: path.resolve(bundle),
    }));
    fs.writeFileSync(path.join(bundle, 'undeclared.txt'), 'unexpected\n');
    expect(() => verifyReleaseBundle(bundle, 'a'.repeat(40))).toThrow(
      'undeclared or missing files',
    );
    expect(verifyInstalledReleaseSource(bundle, 'a'.repeat(40)).digest)
      .toBe(manifest.digest);
    const undeclaredCompatibilityScript = spawnSync(process.execPath, [
      path.resolve('scripts/release-artifact-manifest.mjs'),
      '--verify-installed-source', bundle,
      '--expected-runtime-sha', 'a'.repeat(40),
      '--expected-digest', manifest.digest,
      '--require-declared-file', 'scripts/release-installed-tree-attestation.mjs',
    ], { encoding: 'utf8' });
    expect(undeclaredCompatibilityScript.status).toBe(1);
    expect(undeclaredCompatibilityScript.stderr).toContain(
      'required installed release file is not declared by artifact manifest',
    );
    fs.appendFileSync(path.join(bundle, 'dist/index.js'), 'tampered\n');
    expect(() => verifyInstalledReleaseSource(bundle, 'a'.repeat(40))).toThrow(
      'artifact byte identity mismatch',
    );
  });

  it('fails closed when a declared lean script dependency is missing', () => {
    const root = fixtureRoot();
    fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'scripts/release-artifact-manifest.mjs'),
      "import './lib/release-artifact-manifest.mjs';\n",
    );
    const failed = spawnSync(process.execPath, [
      path.resolve('scripts/release-artifact-manifest.mjs'),
      '--root', root,
      '--format', 'json',
    ], { encoding: 'utf8' });

    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('release runtime dependency is missing');
  });
});
