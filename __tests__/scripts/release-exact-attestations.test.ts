import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installedScript = path.resolve('scripts/release-installed-tree-attestation.mjs');
const stagingScript = path.resolve('scripts/release-staging-attestation.mjs');
const roots: string[] = [];
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-installed-runtime-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content-engine/.venv/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'content-engine/.venv/lib/python3.12/site-packages/pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist/runtime-dependencies'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '4.14.219' }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, 'content-engine/requirements.txt'), 'fastapi==1.0.0\n');
  const packageLock = fs.readFileSync(path.join(root, 'package-lock.json'));
  const requirements = fs.readFileSync(path.join(root, 'content-engine/requirements.txt'));
  const dependencyLock = {
    schema: 'nexus.release-runtime-dependencies.v1',
    fixture: true,
    target: { node: process.version, python: 'Python 3.12.0' },
  };
  fs.writeFileSync(
    path.join(root, 'dist/runtime-dependencies/lock.json'),
    `${JSON.stringify(dependencyLock, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(root, '.network-independent-install.json'), `${JSON.stringify({
    schema: 'nexus.network-independent-install.v1',
    status: 'passed',
    dependencyLockDigest: sha256(canonicalJson(dependencyLock)),
    packageLockSha256: sha256(packageLock),
    pythonRequirementsSha256: sha256(requirements),
    installedAt: '2026-07-22T00:00:00.000Z',
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'content-engine/.venv/lib/python3.12/site-packages/pkg/core.py'), 'VALUE = 1\n');
  fs.writeFileSync(path.join(root, 'content-engine/.venv/bin/python3.12'), '#!/bin/sh\necho Python 3.12.0\n');
  fs.chmodSync(path.join(root, 'content-engine/.venv/bin/python3.12'), 0o755);
  return root;
}

function writeInstalled(root: string) {
  execFileSync(process.execPath, [installedScript, 'write',
    '--root', root,
    '--runtime-sha', runtimeSha,
    '--artifact-digest', artifactDigest,
  ]);
  return JSON.parse(fs.readFileSync(path.join(root, '.nexus-installed-runtime.json'), 'utf8'));
}

describe('installed dependency tree attestation', () => {
  it('is root-independent and deterministic for identical installed bytes', () => {
    const first = runtimeFixture();
    const second = runtimeFixture();
    const a = writeInstalled(first);
    const b = writeInstalled(second);

    expect(a.aggregateDigest).toBe(b.aggregateDigest);
    expect(a.identity.trees.map((tree: { digest: string }) => tree.digest))
      .toEqual(b.identity.trees.map((tree: { digest: string }) => tree.digest));
  });

  it('uses locale-independent code-unit ordering for installed tree identities', () => {
    const root = runtimeFixture();
    const hyphenBody = Buffer.from('hyphen\n');
    const underscoreBody = Buffer.from('underscore\n');
    fs.writeFileSync(path.join(root, 'node_modules/pkg/fastapi_0.js'), underscoreBody);
    fs.writeFileSync(path.join(root, 'node_modules/pkg/fastapi-0.js'), hyphenBody);

    const attestation = writeInstalled(root);
    const indexBody = fs.readFileSync(path.join(root, 'node_modules/pkg/index.js'));
    const expectedEntries = [
      {
        path: 'pkg/fastapi-0.js',
        type: 'file',
        size: hyphenBody.length,
        executable: false,
        sha256: sha256(hyphenBody),
      },
      {
        path: 'pkg/fastapi_0.js',
        type: 'file',
        size: underscoreBody.length,
        executable: false,
        sha256: sha256(underscoreBody),
      },
      {
        path: 'pkg/index.js',
        type: 'file',
        size: indexBody.length,
        executable: false,
        sha256: sha256(indexBody),
      },
    ];

    expect(attestation.identity.trees[0].digest).toBe(sha256(canonicalJson(expectedEntries)));
  });

  it('rejects installed-tree drift before promotion', () => {
    const root = runtimeFixture();
    const attestation = writeInstalled(root);
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'tampered\n');

    const result = spawnSync(process.execPath, [installedScript, 'validate',
      '--root', root,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--expect-aggregate-digest', attestation.aggregateDigest,
    ], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('installed dependency tree attestation mismatch');
  });

  it('rejects network-independent install evidence drift before promotion', () => {
    const root = runtimeFixture();
    const attestation = writeInstalled(root);
    const evidencePath = path.join(root, '.network-independent-install.json');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    evidence.dependencyLockDigest = 'c'.repeat(64);
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);

    const result = spawnSync(process.execPath, [installedScript, 'validate',
      '--root', root,
      '--runtime-sha', runtimeSha,
      '--artifact-digest', artifactDigest,
      '--expect-aggregate-digest', attestation.aggregateDigest,
    ], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('network-independent install evidence is not bound');
  });
});

describe('detached staging attestation', () => {
  function fixture() {
    const root = runtimeFixture();
    const installed = writeInstalled(root);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const files = {
      manifest: path.join(root, 'manifest.json'),
      installed: path.join(root, '.nexus-installed-runtime.json'),
      recovery: path.join(root, 'recovery-runtime.json'),
      identity: path.join(root, 'identity.json'),
      readiness: path.join(root, 'readiness.json'),
      smoke: path.join(root, 'smoke.log'),
      request: path.join(root, 'request.json'),
      signed: path.join(root, 'signed.json'),
      privateKey: path.join(root, 'private.pem'),
      publicKey: path.join(root, 'public.pem'),
    };
    const releaseDir = `/home/dominguez/telegram-hub-bot-staging/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
    fs.writeFileSync(files.manifest, JSON.stringify({
      schema: 'nexus.release-manifest.v2',
      payload: { runtimeSha, packageVersion: '4.14.219', artifact: { digest: artifactDigest } },
    }));
    const recoveryIdentity = {
      schema: 'nexus.recovery-installed-runtime-identity.v1',
      runtimeSha,
      artifactDigest,
      packageVersion: '4.14.219',
    };
    fs.writeFileSync(files.recovery, JSON.stringify({
      schema: 'nexus.recovery-runtime-attestation.v1',
      identity: recoveryIdentity,
      aggregateDigest: sha256(canonicalJson(recoveryIdentity)),
    }));
    fs.writeFileSync(files.identity, JSON.stringify({
      schema: 'nexus.pm2-release-identity.v1',
      services: [
        { name: 'nexus-hub-staging', status: 'online', cwd: releaseDir, releaseSha: runtimeSha },
        { name: 'content-engine-staging', status: 'online', cwd: `${releaseDir}/content-engine`, releaseSha: runtimeSha },
      ],
    }));
    fs.writeFileSync(files.readiness, JSON.stringify({
      schema: 'nexus.release-readiness.v1',
      role: 'staging',
      runtimeSha,
      checks: {
        nativeBinding: true,
        sqliteIntegrity: true,
        sqliteForeignKeys: true,
        backendHealth: true,
        authenticatedContentEngine: true,
        pm2ExactIdentity: true,
        pm2RestartStable: true,
      },
      services: [
        { name: 'nexus-hub-staging', status: 'online', cwd: releaseDir, releaseSha: runtimeSha },
        { name: 'content-engine-staging', status: 'online', cwd: `${releaseDir}/content-engine`, releaseSha: runtimeSha },
      ],
    }));
    fs.writeFileSync(files.smoke, 'all domain smoke checks passed\n');
    fs.writeFileSync(files.privateKey, privateKey.export({ format: 'pem', type: 'pkcs8' }));
    fs.writeFileSync(files.publicKey, publicKey.export({ format: 'pem', type: 'spki' }));
    execFileSync(process.execPath, [stagingScript, 'request',
      '--root', root,
      '--manifest', files.manifest,
      '--installed-attestation', files.installed,
      '--recovery-runtime-attestation', files.recovery,
      '--identity-evidence', files.identity,
      '--readiness-evidence', files.readiness,
      '--smoke-log', files.smoke,
      '--release-dir', releaseDir,
      '--output', files.request,
    ]);
    execFileSync(process.execPath, [stagingScript, 'sign',
      '--root', root,
      '--request', files.request,
      '--output', files.signed,
      '--private-key', files.privateKey,
      '--expect-runtime-sha', runtimeSha,
    ]);
    return { root, files, installed };
  }

  it('binds owner-signed smoke and installed bytes to the exact source manifest', () => {
    const { root, files, installed } = fixture();
    const result = JSON.parse(execFileSync(process.execPath, [stagingScript, 'validate',
      '--root', root,
      '--attestation', files.signed,
      '--manifest', files.manifest,
      '--public-key', files.publicKey,
      '--expect-runtime-sha', runtimeSha,
      '--expect-installed-runtime-digest', installed.aggregateDigest,
      '--allow-test-key',
    ], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } }));

    expect(result).toMatchObject({
      ok: true,
      promotable: true,
      runtimeSha,
      artifactDigest,
      installedRuntimeDigest: installed.aggregateDigest,
    });
  });

  it('rejects a manifest changed after the staging request was signed', () => {
    const { root, files } = fixture();
    fs.appendFileSync(files.manifest, '\n');
    const result = spawnSync(process.execPath, [stagingScript, 'validate',
      '--root', root,
      '--attestation', files.signed,
      '--manifest', files.manifest,
      '--public-key', files.publicKey,
      '--allow-test-key',
    ], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('not bound to the release manifest');
  });

  it('rejects staging readiness evidence with a failed restart-stability check', () => {
    const root = runtimeFixture();
    const installed = writeInstalled(root);
    const releaseDir = `/home/dominguez/telegram-hub-bot-staging/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
    const files = {
      manifest: path.join(root, 'manifest.json'),
      installed: path.join(root, '.nexus-installed-runtime.json'),
      recovery: path.join(root, 'recovery-runtime.json'),
      identity: path.join(root, 'identity.json'),
      readiness: path.join(root, 'readiness.json'),
      smoke: path.join(root, 'smoke.log'),
      request: path.join(root, 'request.json'),
    };
    fs.writeFileSync(files.manifest, JSON.stringify({
      schema: 'nexus.release-manifest.v2',
      payload: { runtimeSha, packageVersion: '4.14.219', artifact: { digest: artifactDigest } },
    }));
    const recoveryIdentity = {
      schema: 'nexus.recovery-installed-runtime-identity.v1',
      runtimeSha,
      artifactDigest,
      packageVersion: '4.14.219',
    };
    fs.writeFileSync(files.recovery, JSON.stringify({
      schema: 'nexus.recovery-runtime-attestation.v1',
      identity: recoveryIdentity,
      aggregateDigest: sha256(canonicalJson(recoveryIdentity)),
    }));
    fs.writeFileSync(files.identity, JSON.stringify({
      services: [
        { name: 'nexus-hub-staging', status: 'online', cwd: releaseDir, releaseSha: runtimeSha },
        { name: 'content-engine-staging', status: 'online', cwd: `${releaseDir}/content-engine`, releaseSha: runtimeSha },
      ],
    }));
    fs.writeFileSync(files.readiness, JSON.stringify({
      schema: 'nexus.release-readiness.v1', role: 'staging', runtimeSha,
      checks: {
        nativeBinding: true, sqliteIntegrity: true, sqliteForeignKeys: true,
        backendHealth: true, authenticatedContentEngine: true, pm2ExactIdentity: true,
        pm2RestartStable: false,
      },
    }));
    fs.writeFileSync(files.smoke, 'passed\n');

    const result = spawnSync(process.execPath, [stagingScript, 'request',
      '--root', root,
      '--manifest', files.manifest,
      '--installed-attestation', files.installed,
      '--recovery-runtime-attestation', files.recovery,
      '--identity-evidence', files.identity,
      '--readiness-evidence', files.readiness,
      '--smoke-log', files.smoke,
      '--release-dir', releaseDir,
      '--output', files.request,
    ], { encoding: 'utf8' });
    expect(installed.aggregateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('staging readiness check failed: pm2RestartStable');
  });
});
