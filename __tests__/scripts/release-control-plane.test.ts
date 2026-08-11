import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RELEASE_CONTROL_PLANE_SCHEMA,
  assertReleaseControlPlaneNativeRuntime,
  computeImmutableControlPlaneTreeDigest,
  computeReleaseControlPlaneIdentity,
  releaseControlPlaneFingerprint,
} from '../../scripts/lib/release-control-plane.mjs';
import {
  RELEASE_INSTALLED_BACKUP_FILES,
  verifyInstalledReleaseBackupInterface,
} from '../../scripts/lib/release-installed-backup-interface.mjs';

const repoRoot = resolve(process.cwd());
const workspaces: string[] = [];

function write(root: string, relative: string, value: string | Record<string, unknown>) {
  const target = join(root, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    { mode: relative.endsWith('.mjs') ? 0o755 : 0o644 },
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-release-control-plane-'));
  workspaces.push(root);
  write(root, 'ops/nexus-release/release-control-plane-inputs.json', {
    schema: 'nexus.release-control-plane-inputs.v1',
    nodeVersion: '22.23.1',
    entrypoints: ['scripts/controller.mjs'],
    staticFiles: ['config/policy.json', 'ops/controller.service'],
    npmDependencies: ['better-sqlite3'],
  });
  write(root, 'scripts/controller.mjs', [
    "import Database from 'better-sqlite3';",
    "import { value } from './helper.mjs';",
    'export default { Database, value };',
    '',
  ].join('\n'));
  write(root, 'scripts/helper.mjs', 'export const value = 1;\n');
  write(root, 'config/policy.json', '{"safe":true}\n');
  write(root, 'ops/controller.service', '[Service]\nExecStart=/usr/bin/node controller.mjs\n');
  write(root, 'package.json', {
    engines: { node: '>=22.23.0 <22.24.0', npm: '>=10' },
    dependencies: { 'better-sqlite3': '^12.6.2', express: '^5.2.1' },
  });
  write(root, 'package-lock.json', {
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: { 'better-sqlite3': '^12.6.2', express: '^5.2.1' },
      },
      'node_modules/better-sqlite3': {
        version: '12.6.2',
        resolved: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.6.2.tgz',
        integrity: 'sha512-controller',
        dependencies: { bindings: '^1.5.0' },
      },
      'node_modules/bindings': {
        version: '1.5.0',
        resolved: 'https://registry.npmjs.org/bindings/-/bindings-1.5.0.tgz',
        integrity: 'sha512-bindings',
      },
      'node_modules/express': {
        version: '5.2.1',
        resolved: 'https://registry.npmjs.org/express/-/express-5.2.1.tgz',
        integrity: 'sha512-application-only',
      },
    },
  });
  return root;
}

function installedInterfaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-installed-backup-interface-'));
  workspaces.push(root);
  const producerDestination = join(root, 'installed', 'local-backup.py');
  const unitDestination = join(root, 'installed', 'fixture-backup.service');
  const sudoersDestination = join(root, 'installed', 'fixture-backup.sudoers');
  write(root, 'scripts/local-backup.py', '#!/usr/bin/env python3\nprint("backup")\n');
  write(root, 'ops/fixture-backup.service', '[Service]\nType=oneshot\n');
  write(root, 'ops/fixture-backup.sudoers', 'operator ALL=(root) NOPASSWD: /bin/true\n');
  write(root, 'installed/local-backup.py', '#!/usr/bin/env python3\nprint("backup")\n');
  write(root, 'installed/fixture-backup.service', '[Service]\nType=oneshot\n');
  write(root, 'installed/fixture-backup.sudoers', 'operator ALL=(root) NOPASSWD: /bin/true\n');
  for (const file of [
    join(root, 'scripts/local-backup.py'),
    producerDestination,
  ]) chmodSync(file, 0o755);
  chmodSync(sudoersDestination, 0o440);
  const files = [{
    source: 'scripts/local-backup.py',
    destination: producerDestination,
    sourceMode: 0o755,
    destinationMode: 0o755,
  }, {
    source: 'ops/fixture-backup.service',
    destination: unitDestination,
    sourceMode: 0o644,
    destinationMode: 0o644,
  }, {
    source: 'ops/fixture-backup.sudoers',
    destination: sudoersDestination,
    sourceMode: 0o644,
    destinationMode: 0o440,
  }];
  const units = ['fixture-backup.service'];
  const effective = {
    LoadState: 'loaded',
    FragmentPath: '/etc/systemd/system/fixture-backup.service',
    DropInPaths: '',
    NeedDaemonReload: 'no',
  };
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args[0] === '-cf') return { status: 0, stdout: '', stderr: '' };
    const property = args.find((argument) => argument.startsWith('--property='))
      ?.replace('--property=', '') as keyof typeof effective;
    return { status: 0, stdout: `${effective[property]}\n`, stderr: '' };
  };
  return {
    root,
    destinationAncestorRoot: join(root, 'installed'),
    files,
    units,
    effective,
    calls,
    exec,
    expectedUid: process.getuid?.() ?? 0,
    expectedGid: process.getgid?.() ?? 0,
    producerDestination,
    unitDestination,
  };
}

afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('signed release control-plane identity', () => {
  it('recomputes the complete immutable tree and executes its native runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-immutable-control-plane-'));
    workspaces.push(root);
    const nativeRoot = join(root, 'node_modules');
    const nativeFile = join(nativeRoot, 'binding.node');
    const policyFile = join(root, 'policy.json');
    const marker = join(root, '.nexus-control-plane-tree.sha256');
    mkdirSync(nativeRoot, { mode: 0o755 });
    writeFileSync(nativeFile, 'native-v1\n', { mode: 0o644 });
    writeFileSync(policyFile, '{"safe":true}\n', { mode: 0o644 });
    writeFileSync(marker, `${'0'.repeat(64)}\n`, { mode: 0o644 });
    for (const file of [nativeFile, policyFile, marker]) chmodSync(file, 0o444);
    chmodSync(nativeRoot, 0o555);
    chmodSync(root, 0o555);
    const expectedUid = process.getuid?.() ?? 0;
    const expectedGid = process.getgid?.() ?? 0;
    const digestOptions = { expectedUid, expectedGid };

    try {
      const expected = computeImmutableControlPlaneTreeDigest(root, digestOptions);
      expect(expected).toMatch(/^[0-9a-f]{64}$/u);

      chmodSync(nativeFile, 0o666);
      expect(() => computeImmutableControlPlaneTreeDigest(root, digestOptions))
        .toThrow(/mutable or unowned/u);
      chmodSync(nativeFile, 0o444);

      chmodSync(nativeFile, 0o644);
      writeFileSync(nativeFile, 'native-v2\n');
      chmodSync(nativeFile, 0o444);
      expect(computeImmutableControlPlaneTreeDigest(root, digestOptions))
        .not.toBe(expected);
    } finally {
      chmodSync(nativeRoot, 0o755);
      chmodSync(root, 0o755);
    }

    expect(assertReleaseControlPlaneNativeRuntime(repoRoot)).toBe(true);
    expect(() => assertReleaseControlPlaneNativeRuntime(repoRoot, {
      load: () => { throw new Error('native runtime unavailable'); },
    })).toThrow('native runtime unavailable');
  });

  it('covers the real runtime closure, policy, units, and selected dependency closure', () => {
    const fingerprint = releaseControlPlaneFingerprint(repoRoot);
    const identity = computeReleaseControlPlaneIdentity(repoRoot);
    const files = fingerprint.files.map((entry) => entry.path);
    const packages = fingerprint.dependencies.packageLock.packages.map((entry) => entry.path);

    expect(identity).toEqual({
      schema: RELEASE_CONTROL_PLANE_SCHEMA,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(files).toEqual(expect.arrayContaining([
      'config/continuous-deployment.json',
      'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service',
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.service',
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer',
      'ops/local-backup/systemd/nexus-local-backup.service',
      'ops/local-backup/systemd/nexus-local-backup.timer',
      'ops/nexus-release/nexus-release-backup-liveness-force.service',
      'ops/nexus-release/nexus-release-backup-liveness.service',
      'ops/nexus-release/nexus-release-backup-liveness.timer',
      'ops/nexus-release/nexus-release-heartbeat.service',
      'ops/nexus-release/nexus-release-heartbeat.timer',
      'ops/nexus-release/nexus-release-poller.service',
      'scripts/lib/pm2-fallback-retirement.mjs',
      'scripts/lib/release-backup-liveness.mjs',
      'scripts/lib/release-control-plane.mjs',
      'scripts/lib/release-deployment.mjs',
      'scripts/lib/release-discovery-alert-state.mjs',
      'scripts/lib/release-installed-backup-interface.mjs',
      'scripts/release-artifact-manifest.mjs',
      'scripts/local-backup-retry-launcher.sh',
      'scripts/release-backup-liveness-launcher.sh',
      'scripts/release-bound-lock-runner.py',
      'scripts/release-installed-backup-interface-check.mjs',
      'scripts/release-operational-alert-launcher.sh',
      'scripts/release-operational-alert.mjs',
      'scripts/release-poll.sh',
      'scripts/release-runtime-dependencies.mjs',
      'scripts/remote-pm2-root-install.sh',
      'scripts/remote-start-sanitized-pm2.sh',
      'scripts/remote-user-release-transaction.sh',
      'scripts/retire-pm2-fallback.mjs',
    ]));
    expect(fingerprint.descriptor.entrypoints)
      .toEqual([...fingerprint.descriptor.entrypoints].sort());
    expect(new Set(fingerprint.descriptor.entrypoints).size)
      .toBe(fingerprint.descriptor.entrypoints.length);
    expect(fingerprint.descriptor.staticFiles)
      .toEqual([...fingerprint.descriptor.staticFiles].sort());
    expect(new Set(fingerprint.descriptor.staticFiles).size)
      .toBe(fingerprint.descriptor.staticFiles.length);
    expect(packages).toEqual(expect.arrayContaining([
      'node_modules/better-sqlite3',
      'node_modules/bindings',
    ]));
    expect(packages).toEqual([...packages].sort());
  });

  it('binds every repository helper executed by the governed remote user transaction', () => {
    const remote = readFileSync(
      join(repoRoot, 'scripts/remote-user-release-transaction.sh'),
      'utf8',
    ).replace(/\\\n\s*/gu, ' ');
    const helpers = [...remote.matchAll(
      /"\$NODE_BIN"\s+(?:"\$(?:SOURCE_BUNDLE|TEMP_RELEASE)\/(scripts\/[a-z0-9-]+\.mjs)"|"(scripts\/[a-z0-9-]+\.mjs)"|(scripts\/[a-z0-9-]+\.mjs))/gu,
    )].map((match) => match[1] ?? match[2] ?? match[3]);
    const uniqueHelpers = [...new Set(helpers)].sort();
    const entrypoints = releaseControlPlaneFingerprint(repoRoot).descriptor.entrypoints;

    expect(uniqueHelpers).toEqual([
      'scripts/release-artifact-manifest.mjs',
      'scripts/release-runtime-dependencies.mjs',
    ]);
    for (const helper of uniqueHelpers) expect(entrypoints).toContain(helper);
  });

  it('binds repository executables referenced by every governed shell and unit file', () => {
    const fingerprint = releaseControlPlaneFingerprint(repoRoot);
    const governed = new Set(fingerprint.files.map((entry) => entry.path));
    const references = new Map<string, Set<string>>();
    const record = (helper: string, source: string) => {
      const sources = references.get(helper) ?? new Set<string>();
      sources.add(source);
      references.set(helper, sources);
    };
    const helperPattern = String.raw`scripts\/[A-Za-z0-9._/-]+\.(?:mjs|js|sh|py)`;
    const absolute = new RegExp(
      String.raw`\/opt\/nexus-release\/checkout\/(${helperPattern})`,
      'gu',
    );
    const variable = new RegExp(
      String.raw`\$(?:\{[A-Z][A-Z0-9_]*\}|[A-Z][A-Z0-9_]*)\/(${helperPattern})`,
      'gu',
    );
    for (const source of fingerprint.descriptor.staticFiles) {
      if (!/(?:\.service|\.timer|\.sh|nexus-release-state-view)$/u.test(source)) continue;
      const bytes = readFileSync(join(repoRoot, source), 'utf8');
      for (const pattern of [absolute, variable]) {
        pattern.lastIndex = 0;
        for (let match = pattern.exec(bytes); match; match = pattern.exec(bytes)) {
          record(match[1], source);
        }
      }
    }

    expect([...references].map(([helper]) => helper).sort()).toContain(
      'scripts/release-bound-lock-runner.py',
    );
    for (const [helper, sources] of references) {
      expect(governed.has(helper), `${helper} executed by ${[...sources].sort().join(', ')}`)
        .toBe(true);
    }
  });

  it('stays stable for app-only bytes and unrelated packages but changes for governed inputs', () => {
    const root = fixture();
    const first = computeReleaseControlPlaneIdentity(root);

    write(root, 'src/application-only.mjs', 'export const app = 2;\n');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    lock.packages['node_modules/express'].version = '5.2.2';
    write(root, 'package-lock.json', lock);
    expect(computeReleaseControlPlaneIdentity(root)).toEqual(first);

    write(root, 'scripts/helper.mjs', 'export const value = 2;\n');
    const runtimeChanged = computeReleaseControlPlaneIdentity(root);
    expect(runtimeChanged.digest).not.toBe(first.digest);

    write(root, 'scripts/helper.mjs', 'export const value = 1;\n');
    write(root, 'ops/controller.service', '[Service]\nExecStart=/usr/bin/node changed.mjs\n');
    expect(computeReleaseControlPlaneIdentity(root).digest).not.toBe(first.digest);
  });

  it('fails closed when a runtime import is absent from the governed dependency declaration', () => {
    const root = fixture();
    write(root, 'scripts/controller.mjs', [
      "import Database from 'better-sqlite3';",
      "import runtime from 'undeclared-runtime';",
      'export default { Database, runtime };',
      '',
    ].join('\n'));
    expect(() => computeReleaseControlPlaneIdentity(root))
      .toThrow(/dependency declaration does not match runtime imports/i);
  });

  it('fails closed when the executing Node runtime differs from the descriptor', () => {
    const root = fixture();
    expect(() => computeReleaseControlPlaneIdentity(root, { runtimeVersion: '22.23.2' }))
      .toThrow(/runtime Node version 22\.23\.2.*governed 22\.23\.1/i);
  });

  it('proves installed backup bytes, metadata, sudoers, and effective systemd authority', () => {
    expect(RELEASE_INSTALLED_BACKUP_FILES.map((entry) => ({
      source: entry.source,
      sourceMode: entry.sourceMode,
      destinationMode: entry.destinationMode,
    }))).toEqual([
      expect.objectContaining({ source: 'scripts/local-backup.py', sourceMode: 0o555,
        destinationMode: 0o755 }),
      expect.objectContaining({ source: 'scripts/local-backup-retry-launcher.sh',
        sourceMode: 0o555, destinationMode: 0o755 }),
      ...Array.from({ length: 5 }, () => expect.objectContaining({
        sourceMode: 0o444,
        destinationMode: 0o644,
      })),
      expect.objectContaining({
        source: 'ops/local-backup/nexus-local-backup.sudoers',
        sourceMode: 0o444,
        destinationMode: 0o440,
      }),
    ]);
    const fixture = installedInterfaceFixture();
    expect(verifyInstalledReleaseBackupInterface(fixture)).toEqual({
      schema: 'nexus.release-installed-backup-interface.v1',
      passed: true,
      fileCount: 3,
      unitCount: 1,
    });
    expect(fixture.calls.map((call) => call.args)).toEqual(expect.arrayContaining([
      ['-cf', fixture.files[2].destination],
      ['show', fixture.units[0], '--property=LoadState', '--value'],
      ['show', fixture.units[0], '--property=FragmentPath', '--value'],
      ['show', fixture.units[0], '--property=DropInPaths', '--value'],
      ['show', fixture.units[0], '--property=NeedDaemonReload', '--value'],
    ]));
    expect(fixture.calls.filter((call) => call.args[0] === 'show')
      .every((call) => call.command === '/usr/bin/systemctl')).toBe(true);
    expect(readFileSync(
      join(repoRoot, 'scripts/lib/release-installed-backup-interface.mjs'),
      'utf8',
    )).not.toContain('NEXUS_RELEASE_SYSTEMCTL_BIN');
  });

  it('fails installed backup proof on byte or metadata drift', () => {
    const bytes = installedInterfaceFixture();
    writeFileSync(bytes.producerDestination, '#!/usr/bin/env python3\nprint("drift")\n');
    expect(() => verifyInstalledReleaseBackupInterface(bytes))
      .toThrow(/differs from governed source/i);

    const metadata = installedInterfaceFixture();
    chmodSync(metadata.unitDestination, 0o600);
    expect(() => verifyInstalledReleaseBackupInterface(metadata))
      .toThrow(/metadata does not match/i);
  });

  it('refuses symlinked or group/world-writable destination ancestors', () => {
    const symlinked = installedInterfaceFixture();
    const moved = `${symlinked.destinationAncestorRoot}-moved`;
    renameSync(symlinked.destinationAncestorRoot, moved);
    symlinkSync(moved, symlinked.destinationAncestorRoot);
    expect(() => verifyInstalledReleaseBackupInterface(symlinked))
      .toThrow(/destination ancestor is unsafe/i);

    const writable = installedInterfaceFixture();
    chmodSync(writable.destinationAncestorRoot, 0o777);
    expect(() => verifyInstalledReleaseBackupInterface(writable))
      .toThrow(/destination ancestor is unsafe/i);
  });

  it('refuses a destination ancestor identity swap during effective-unit proof', () => {
    const fixture = installedInterfaceFixture();
    const originalExec = fixture.exec;
    let swapped = false;
    fixture.exec = (command: string, args: string[]) => {
      if (!swapped) {
        swapped = true;
        const moved = `${fixture.destinationAncestorRoot}-before-swap`;
        renameSync(fixture.destinationAncestorRoot, moved);
        cpSync(moved, fixture.destinationAncestorRoot, { recursive: true });
      }
      return originalExec(command, args);
    };
    expect(() => verifyInstalledReleaseBackupInterface(fixture))
      .toThrow(/destination ancestor identity changed/i);
  });

  it.each([
    ['LoadState', 'not-found'],
    ['FragmentPath', '/usr/lib/systemd/system/fixture-backup.service'],
    ['DropInPaths', '/etc/systemd/system/fixture-backup.service.d/override.conf'],
    ['NeedDaemonReload', 'yes'],
  ] as const)('fails installed backup proof when effective %s drifts', (property, value) => {
    const fixture = installedInterfaceFixture();
    fixture.effective[property] = value;
    expect(() => verifyInstalledReleaseBackupInterface(fixture))
      .toThrow(/effective definition differs/i);
  });

  it('makes signed publication assert the v3 envelope carries the computed controller digest', () => {
    const workflow = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain("envelope.schema !== 'nexus.release-manifest.v3'");
    expect(workflow).toContain('envelope.payload?.controlPlane?.digest !== build.controlPlaneDigest');
    expect(workflow).toContain('control_plane_digest=$CONTROL_PLANE_DIGEST');
  });
});
