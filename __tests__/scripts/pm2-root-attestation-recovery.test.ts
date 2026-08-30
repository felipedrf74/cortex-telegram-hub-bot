import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256 } from '../../scripts/lib/release-canonical.mjs';
import { DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS }
  from '../../scripts/lib/pm2-fallback-retirement.mjs';
import {
  PM2_ROOT_RECOVERED_ATTESTATION_SCHEMA,
  Pm2RootAttestationRecoveryRefusal,
  inspectPm2RootAttestationRecovery,
  recoverPm2RootAttestation,
} from '../../scripts/lib/pm2-root-attestation-recovery.mjs';

const roots: string[] = [];

function write(file: string, body: string | Buffer, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

function payloadFiles(root: string) {
  const files: Array<{ path: string; size: number; mode: number; sha256: string }> = [];
  function walk(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const bytes = fs.readFileSync(absolute);
        files.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          size: bytes.length,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
          sha256: sha256(bytes),
        });
      }
    }
  }
  walk(root);
  return files.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm2-attestation-recovery-'));
  roots.push(root);
  const ownerUid = process.getuid!();
  const ownerGid = process.getgid!();
  const version = '6.0.14';
  const pm2Prefix = path.join(root, 'opt/nexus-release/pm2');
  const closureRoot = path.join(pm2Prefix, version);
  const promotionRoot = path.join(root, 'var/lib/nexus-release-promotion');
  const stateRoot = path.join(root, 'var/lib/nexus-release/state');
  const pm2Launcher = path.join(root, 'usr/local/bin/pm2');
  const pm2Lock = path.join(root, 'usr/local/share/nexus-release/pm2-package-lock.json');
  const pm2Attestation = path.join(promotionRoot, 'pm2-root-install.v1.json');
  const nodePath = path.join(root, 'usr/bin/node');
  for (const directory of [closureRoot, stateRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.chmodSync(directory, 0o755);
  }
  fs.mkdirSync(promotionRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(promotionRoot, 0o700);
  const lock = {
    name: 'nexus-root-pm2-closure',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'nexus-root-pm2-closure', version: '1.0.0' },
      'node_modules/pm2': { version },
    },
  };
  const lockBytes = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  write(pm2Lock, lockBytes);
  write(path.join(closureRoot, 'package-lock.json'), lockBytes);
  write(path.join(closureRoot, 'package.json'), `${JSON.stringify({
    name: 'nexus-root-pm2-closure', dependencies: { pm2: version },
  }, null, 2)}\n`);
  write(path.join(closureRoot, 'node_modules/pm2/package.json'), `${JSON.stringify({
    name: 'pm2', version,
  }, null, 2)}\n`);
  write(path.join(closureRoot, 'node_modules/pm2/bin/pm2'), '#!/usr/bin/env node\n', 0o755);
  // Preserve the archive builder's globally sorted sibling-file/directory
  // ordering case: `locale.json` precedes `locale/af.js` bytewise, while a
  // depth-first filesystem walk observes the directory first.
  write(path.join(closureRoot, 'node_modules/pm2/locale.json'), '{}\n');
  write(path.join(closureRoot, 'node_modules/pm2/locale/af.js'), 'module.exports = {};\n');
  const files = payloadFiles(closureRoot);
  expect(files.findIndex((entry) => entry.path.endsWith('/locale.json')))
    .toBeLessThan(files.findIndex((entry) => entry.path.endsWith('/locale/af.js')));
  const packageLockPackages = [{
    path: 'node_modules/pm2', version, resolved: null, integrity: null,
  }];
  const manifest = {
    schema: 'nexus.pm2-root-closure-manifest.v1',
    pm2Version: version,
    nodeVersion: 'v22.23.1',
    npmVersion: '10.9.8',
    packageLockSha256: sha256(lockBytes),
    packageLockPackages,
    installedPackages: [{ path: 'node_modules/pm2', version }],
    payloadDigest: sha256(canonicalJson({
      schema: 'nexus.pm2-root-closure-payload.v1', files,
    })),
    fileCount: files.length,
    files,
  };
  write(path.join(closureRoot, 'closure-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  write(nodePath, '#!/bin/sh\nprintf "v22.23.1\\n"\n', 0o755);
  write(pm2Launcher,
    `#!/usr/bin/bash\nexec ${JSON.stringify(nodePath)} ${JSON.stringify(
      `${closureRoot}/node_modules/pm2/bin/pm2`,
    )} "$@"\n`, 0o755);
  const paths = {
    ...DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
    pm2Prefix,
    pm2Launcher,
    pm2Lock,
    pm2Attestation,
    pm2InstallJournal: path.join(promotionRoot, 'pm2-install-in-progress.v1.json'),
    journal: path.join(stateRoot, 'pm2-fallback-retirement.json'),
    tombstone: path.join(stateRoot, 'pm2-fallback-retired.json'),
  };
  return {
    root,
    closureRoot,
    paths,
    nodePath,
    ownerUid,
    ownerGid,
    acquireLocks: () => () => {},
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PM2 root attestation recovery', () => {
  it('publishes one no-replace recovered attestation after exact-closure verification', () => {
    const f = fixture();
    const inspected = inspectPm2RootAttestationRecovery(f);
    const result = recoverPm2RootAttestation({
      ...f,
      confirm: inspected.confirmation,
      ownerAuthorized: true,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    expect(result.status).toBe('recovered');
    const attestation = JSON.parse(fs.readFileSync(f.paths.pm2Attestation, 'utf8'));
    expect(attestation).toMatchObject({
      schema: PM2_ROOT_RECOVERED_ATTESTATION_SCHEMA,
      recoveryMethod: 'exact-installed-closure',
      version: '6.0.14',
      attestedAt: '2026-08-30T00:00:00.000Z',
    });
    expect(attestation).not.toHaveProperty('sourceArchiveSha256');
    expect(fs.statSync(f.paths.pm2Attestation).mode & 0o777).toBe(0o600);
    expect(() => recoverPm2RootAttestation({
      ...f, confirm: inspected.confirmation, ownerAuthorized: true,
    })).toThrowError(expect.objectContaining({ code: 'conflicting_state' }));
  });

  it('creates an absent legacy attestation directory with exact root-only mode', () => {
    const f = fixture();
    const promotionRoot = path.dirname(f.paths.pm2Attestation);
    fs.rmSync(promotionRoot, { recursive: true });
    const inspected = inspectPm2RootAttestationRecovery(f);
    const result = recoverPm2RootAttestation({
      ...f,
      confirm: inspected.confirmation,
      ownerAuthorized: true,
      now: () => new Date('2026-08-30T00:00:00.000Z'),
    });
    expect(result.status).toBe('recovered');
    expect(fs.statSync(promotionRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(f.paths.pm2Attestation).mode & 0o777).toBe(0o600);
  });

  it('refuses an unsafe pre-existing attestation directory', () => {
    const f = fixture();
    const promotionRoot = path.dirname(f.paths.pm2Attestation);
    fs.chmodSync(promotionRoot, 0o777);
    const inspected = inspectPm2RootAttestationRecovery(f);
    expect(() => recoverPm2RootAttestation({
      ...f,
      confirm: inspected.confirmation,
      ownerAuthorized: true,
    })).toThrowError(expect.objectContaining({ code: 'unsafe_state' }));
  });

  it('preserves a target created immediately before no-replace publication', () => {
    const f = fixture();
    const inspected = inspectPm2RootAttestationRecovery(f);
    const racedBytes = 'concurrent evidence\n';
    const fsApi = new Proxy(fs, {
      get(target, key) {
        if (key === 'linkSync') {
          return (existingPath: fs.PathLike, targetPath: fs.PathLike) => {
            fs.writeFileSync(targetPath, racedBytes, { mode: 0o600 });
            return fs.linkSync(existingPath, targetPath);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => recoverPm2RootAttestation({
      ...f,
      fsApi,
      confirm: inspected.confirmation,
      ownerAuthorized: true,
    })).toThrowError(expect.objectContaining({ code: 'conflicting_state' }));
    expect(fs.readFileSync(f.paths.pm2Attestation, 'utf8')).toBe(racedBytes);
  });

  it('refuses apply when the exact closure changed after confirmation', () => {
    const f = fixture();
    const inspected = inspectPm2RootAttestationRecovery(f);
    fs.appendFileSync(path.join(f.closureRoot, 'package.json'), ' ');
    expect(() => recoverPm2RootAttestation({
      ...f, confirm: inspected.confirmation, ownerAuthorized: true,
    })).toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
  });

  it('refuses any existing retirement gate before inspecting the package', () => {
    const f = fixture();
    write(f.paths.journal, '{}\n', 0o600);
    expect(() => inspectPm2RootAttestationRecovery(f))
      .toThrowError(Pm2RootAttestationRecoveryRefusal);
  });

  it('binds evidence reads to the checked inode and refuses a path swap', () => {
    const f = fixture();
    let swapped = false;
    const fsApi = new Proxy(fs, {
      get(target, key) {
        if (key === 'lstatSync') {
          return (file: fs.PathLike) => {
            const stat = fs.lstatSync(file);
            if (!swapped && file === f.paths.pm2Lock) {
              swapped = true;
              const original = `${f.paths.pm2Lock}.original`;
              fs.renameSync(f.paths.pm2Lock, original);
              fs.symlinkSync(original, f.paths.pm2Lock);
            }
            return stat;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(() => inspectPm2RootAttestationRecovery({ ...f, fsApi }))
      .toThrowError(expect.objectContaining({ code: 'artifact_changed' }));
  });

  it('acquires the retirement locks before rechecking conflicting state', () => {
    const f = fixture();
    let released = false;
    const acquireLocks = () => {
      write(f.paths.journal, '{}\n', 0o600);
      return () => { released = true; };
    };
    expect(() => recoverPm2RootAttestation({
      ...f,
      confirm: '0'.repeat(64),
      ownerAuthorized: true,
      acquireLocks,
    })).toThrowError(expect.objectContaining({ code: 'conflicting_state' }));
    expect(released).toBe(true);
  });
});
