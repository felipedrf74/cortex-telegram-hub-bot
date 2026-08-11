import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const installer = path.join(ROOT, 'scripts', 'remote-pm2-root-install.sh');
const trustedLock = path.join(ROOT, 'ops', 'pm2', 'package-lock.json');
const roots: string[] = [];
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};
const closureFiles = (closure: string) => {
  const files: Array<{ path: string; size: number; mode: number; sha256: string }> = [];
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else {
        const body = fs.readFileSync(absolute);
        files.push({
          path: path.relative(closure, absolute).split(path.sep).join('/'),
          size: body.length,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
          sha256: sha256(body),
        });
      }
    }
  };
  walk(closure);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
};

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(options: { manifestLockDigest?: string } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pm2-root-')));
  roots.push(root);
  const closure = path.join(root, 'source', 'pm2-closure');
  fs.mkdirSync(path.join(closure, 'node_modules'), { recursive: true });
  const lockBody = fs.readFileSync(trustedLock);
  const lock = JSON.parse(lockBody.toString('utf8')) as {
    packages: Record<string, {
      integrity?: string;
      optional?: boolean;
      resolved?: string;
      version?: string;
    }>;
  };
  fs.copyFileSync(path.join(ROOT, 'ops', 'pm2', 'package.json'), path.join(closure, 'package.json'));
  fs.copyFileSync(trustedLock, path.join(closure, 'package-lock.json'));
  const lockPackages = Object.entries(lock.packages)
    .filter(([packagePath]) => packagePath !== '')
    .map(([packagePath, identity]) => ({
      path: packagePath,
      version: identity.version ?? null,
      resolved: identity.resolved ?? null,
      integrity: identity.integrity ?? null,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en-US'));
  const installedPackages: Array<{ path: string; version: string | null }> = [];
  for (const identity of lockPackages) {
    const packageRoot = path.join(closure, identity.path);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
      name: identity.path === 'node_modules/pm2' ? 'pm2' : path.basename(identity.path),
      version: identity.version,
    })}\n`);
    installedPackages.push({ path: identity.path, version: identity.version });
  }
  const pm2Bin = path.join(closure, 'node_modules', 'pm2', 'bin', 'pm2');
  fs.mkdirSync(path.dirname(pm2Bin), { recursive: true });
  fs.writeFileSync(pm2Bin, '#!/usr/bin/env node\nprocess.stdout.write("fixture");\n', { mode: 0o755 });
  const orderingDirectory = path.join(closure, 'node_modules', 'pm2', 'ordering', 'locale');
  fs.mkdirSync(orderingDirectory, { recursive: true });
  fs.writeFileSync(path.join(orderingDirectory, 'af.js'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(closure, 'node_modules', 'pm2', 'ordering', 'locale.json'),
    '{}\n',
  );

  const files = closureFiles(closure);
  const payload = { schema: 'nexus.pm2-root-closure-payload.v1', files };
  fs.writeFileSync(path.join(closure, 'closure-manifest.json'), `${JSON.stringify({
    schema: 'nexus.pm2-root-closure-manifest.v1',
    pm2Version: '6.0.14',
    nodeVersion: 'v22.23.1',
    npmVersion: '10.9.8',
    packageLockSha256: options.manifestLockDigest ?? sha256(lockBody),
    packageLockPackages: lockPackages,
    installedPackages,
    payloadDigest: sha256(canonical(payload)),
    fileCount: files.length,
    files,
  }, null, 2)}\n`);
  const expectedClosureDigest = sha256(canonical({
    schema: 'nexus.pm2-root-closure.v1',
    files: closureFiles(closure),
  }));
  const archive = path.join(root, 'pm2-closure.tar.gz');
  const packed = spawnSync('python3', ['-c', [
    'import pathlib,sys,tarfile',
    'source=pathlib.Path(sys.argv[1])',
    'with tarfile.open(sys.argv[2],"w:gz") as archive: archive.add(source,arcname="pm2-closure")',
  ].join('\n'), closure, archive], { encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const testRoot = path.join(root, 'target');
  const lockTarget = path.join(testRoot, 'usr', 'local', 'share', 'nexus-release');
  fs.mkdirSync(lockTarget, { recursive: true });
  fs.copyFileSync(trustedLock, path.join(lockTarget, 'pm2-package-lock.json'));
  return {
    root,
    testRoot,
    archive,
    archiveSha256: sha256(fs.readFileSync(archive)),
    expectedClosureDigest,
  };
}

function install(f: ReturnType<typeof fixture>, extraEnv: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [installer, f.archive, f.archiveSha256, '6.0.14'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PM2_TEST_ROOT: f.testRoot,
      NEXUS_PM2_NODE_BIN: process.execPath,
      ...extraEnv,
    },
  });
}

describe('offline root PM2 closure installation', () => {
  it.each([
    'pm2-fallback-retirement.json',
    'pm2-fallback-retired.json',
  ])('refuses %s before mutating root PM2 authority', (gate) => {
    const f = fixture();
    const stateRoot = path.join(f.testRoot, 'var/lib/nexus-release/state');
    fs.mkdirSync(stateRoot, { recursive: true });
    if (gate === 'pm2-fallback-retired.json') {
      fs.symlinkSync('missing-retired-evidence', path.join(stateRoot, gate));
    } else {
      fs.writeFileSync(path.join(stateRoot, gate), '{}\n');
    }

    const result = install(f);

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('barred by fallback retirement evidence');
    expect(fs.existsSync(path.join(f.testRoot, 'opt/nexus-release/pm2'))).toBe(false);
    expect(fs.existsSync(path.join(
      f.testRoot,
      'var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json',
    ))).toBe(false);
  });

  it('installs a regular immutable launcher and exact-lock attestation without npm', () => {
    expect(process.version).toBe('v22.23.1');
    const f = fixture();
    const result = install(f);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const launcher = path.join(f.testRoot, 'usr', 'local', 'bin', 'pm2');
    const launcherStat = fs.lstatSync(launcher);
    expect(launcherStat.isFile()).toBe(true);
    expect(launcherStat.isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(launcher, 'utf8')).toContain(JSON.stringify(process.execPath));
    expect(fs.readFileSync(launcher, 'utf8')).toContain(
      '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2',
    );
    const receipt = JSON.parse(fs.readFileSync(path.join(
      f.testRoot,
      'var/lib/nexus-release-promotion/pm2-root-install.v1.json',
    ), 'utf8'));
    expect(receipt).toMatchObject({
      schema: 'nexus.pm2-root-install.v1',
      version: '6.0.14',
      sourceArchiveSha256: f.archiveSha256,
      node: { path: process.execPath, version: 'v22.23.1' },
    });
    expect(receipt.closureDigest).toBe(f.expectedClosureDigest);
    expect(receipt.packageLockSha256).toBe(sha256(fs.readFileSync(trustedLock)));
  });

  it('rejects the archive before extraction when its approved digest differs', () => {
    const f = fixture();
    f.archiveSha256 = '0'.repeat(64);
    const result = install(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('archive digest mismatch');
    expect(fs.existsSync(path.join(f.testRoot, 'opt/nexus-release/pm2/6.0.14'))).toBe(false);
  });

  it('rejects a manifest that is not bound to the installed trusted lock', () => {
    const f = fixture({ manifestLockDigest: 'f'.repeat(64) });
    const result = install(f);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest does not match the trusted exact lock');
  });

  it('replays a SIGKILL journal and completes from the same approved archive', () => {
    const f = fixture();
    const interrupted = install(f, { NEXUS_PM2_TEST_CRASH_PHASE: 'launcher_moved' });
    expect(interrupted.signal).toBe('SIGKILL');
    expect(fs.existsSync(path.join(
      f.testRoot,
      'var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json',
    ))).toBe(true);
    const replayed = install(f);
    expect(replayed.status, `${replayed.stdout}\n${replayed.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(
      f.testRoot,
      'var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json',
    ))).toBe(false);
  });

  it('keeps the networked builder outside the server install path', () => {
    const source = fs.readFileSync(installer, 'utf8');
    expect(source).not.toMatch(/\bnpm (?:ci|install)\b/u);
    expect(source).not.toMatch(/\bcurl\b|\bwget\b/u);
    expect(source).toContain('root PM2 closure archive contains a link or special member');
    expect(source).toContain('root PM2 closure archive contains an unsafe or duplicate member');
  });
});
