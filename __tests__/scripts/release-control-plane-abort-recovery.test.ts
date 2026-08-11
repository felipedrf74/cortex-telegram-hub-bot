import crypto from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKUP_ASSETS,
  CORE_UNITS,
  LIVENESS_UNITS,
  RECOVERY_PHASES,
  assertRuntimeLockDirectoryMetadata,
  computeImmutableTreeDigest,
  runControlPlaneAbortRecovery,
} from '../../scripts/release-control-plane-abort-recovery.mjs';

const TARGET_SHA = 'b439fa86631e10be76e75615f47eda1b995b29a3';
const ORIGINAL_SHA = '852116a7ee17562418779ee396095de2cd05e699';
const PREVIOUS_SHA = '48f13df000000000000000000000000000000000';
const HOTFIX_SHA = 'c1234567890abcdef1234567890abcdef1234567';
const RELEASE_ID = '575649ec000000000000000000000000';
const REPOSITORY = 'https://github.com/felipedrf74/cortex-telegram-hub-bot.git';
const uid = process.getuid?.() ?? 0;
const gid = process.getgid?.() ?? 0;
const workspaces: string[] = [];

const capabilities = [
  ['ops/nexus-release/nexus-release-state-view', '/usr/local/sbin/nexus-release-state-view', 0o755],
  ['ops/nexus-release/nexus-release-state-view.sudoers',
    '/etc/sudoers.d/nexus-release-state-view', 0o440],
] as const;

function sha256(value: string | Buffer) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function host(root: string, absolute: string) {
  return join(root, ...absolute.split('/').filter(Boolean));
}

function write(root: string, absolute: string, value: string, mode = 0o644) {
  const destination = host(root, absolute);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  writeFileSync(destination, value, { mode });
  chmodSync(destination, mode);
  return destination;
}

function freezeTree(directory: string) {
  const visit = (current: string) => {
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) visit(join(current, name));
      chmodSync(current, 0o555);
    } else if (stat.isFile()) {
      chmodSync(current, stat.mode & 0o111 ? 0o555 : 0o444);
    }
  };
  visit(directory);
}

function thawTree(directory: string) {
  const visit = (current: string) => {
    const stat = lstatSync(current);
    if (stat.isDirectory()) {
      chmodSync(current, 0o755);
      for (const name of readdirSync(current)) visit(join(current, name));
    } else if (stat.isFile()) chmodSync(current, 0o644);
  };
  visit(directory);
}

function tree(root: string, sha: string, {
  full = false,
  liveness = false,
  recovery = false,
  base = '/opt/nexus-release/control-plane',
} = {}) {
  const live = `${base}/${sha}`;
  const directory = host(root, live);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  write(root, `${live}/.nexus-control-plane-ready`,
    `${sha} ${REPOSITORY} /usr/bin/node:v22.23.1\n`);
  write(root, `${live}/.nexus-control-plane-tree.sha256`, `${'0'.repeat(64)}\n`);
  if (full) {
    write(root, `${live}/scripts/release-state-view.mjs`,
      '#!/usr/bin/env node\nprocess.stdout.write("{}\\n");\n', 0o755);
    for (const [relative] of capabilities) {
      write(root, `${live}/${relative}`, `${sha}:${relative}\n`, relative.endsWith('state-view') ? 0o755 : 0o644);
    }
    for (const unit of CORE_UNITS) {
      write(root, `${live}/ops/nexus-release/${unit}`, `${sha}:${unit}\n`);
    }
    for (const [relative] of BACKUP_ASSETS) {
      write(root, `${live}/${relative}`, `${sha}:${relative}\n`, relative.endsWith('.py') ? 0o755 : 0o644);
    }
    if (liveness) {
      for (const unit of LIVENESS_UNITS) {
        write(root, `${live}/ops/nexus-release/${unit}`, `${sha}:${unit}\n`);
      }
    }
  }
  if (recovery) {
    write(root, `${live}/scripts/release-control-plane-abort-recovery.sh`,
      '#!/bin/bash -p\nexit 0\n', 0o755);
    write(root, `${live}/scripts/release-control-plane-abort-recovery.mjs`,
      '#!/usr/bin/env node\n', 0o644);
    write(root, `${live}/ops/nexus-release/release-control-plane-inputs.json`,
      `${JSON.stringify({
        schema: 'nexus.release-control-plane-inputs.v1',
        staticFiles: [
          'scripts/release-control-plane-abort-recovery.mjs',
          'scripts/release-control-plane-abort-recovery.sh',
        ],
      })}\n`);
  }
  freezeTree(directory);
  const digest = computeImmutableTreeDigest(directory, { expectedUid: uid, expectedGid: gid });
  chmodSync(join(directory, '.nexus-control-plane-tree.sha256'), 0o644);
  writeFileSync(join(directory, '.nexus-control-plane-tree.sha256'), `${digest}\n`);
  chmodSync(join(directory, '.nexus-control-plane-tree.sha256'), 0o444);
  expect(computeImmutableTreeDigest(directory, { expectedUid: uid, expectedGid: gid }))
    .toBe(digest);
  return { live, directory, digest };
}

type UnitState = {
  active: string;
  enabled: boolean;
  fragment: string;
  load: string;
};

function fakeSystemd(root: string) {
  const units = new Map<string, UnitState>();
  let receiptSchema = 'nexus.release-receipt.v2';
  const allUnits = [
    ...CORE_UNITS,
    ...LIVENESS_UNITS,
    'nexus-local-backup.service',
    'nexus-local-backup.timer',
    'nexus-local-backup-pre-promotion.service',
    'nexus-local-backup-restore-verify.service',
    'nexus-local-backup-restore-verify.timer',
  ];
  const refresh = () => {
    for (const unit of allUnits) {
      const physical = host(root, `/etc/systemd/system/${unit}`);
      const prior = units.get(unit);
      units.set(unit, {
        active: prior?.active ?? 'inactive',
        enabled: prior?.enabled ?? false,
        fragment: lstatMaybe(physical) ? `/etc/systemd/system/${unit}` : '',
        load: lstatMaybe(physical) ? 'loaded' : 'not-found',
      });
    }
  };
  refresh();
  for (const unit of ['nexus-local-backup.service',
    'nexus-local-backup-restore-verify.service']) {
    units.get(unit)!.load = 'bad-setting';
  }
  const exec = (command: string, args: string[]) => {
    if (command === '/usr/bin/node') {
      return {
        status: 0,
        stdout: `${JSON.stringify({
          schema: 'nexus.release-state-view.v2',
          sourceSchemas: {
            state: 'nexus.release-host-state.v1',
            // Capability metadata describes the newest supported schema, not
            // the immutable active receipt's own authoritative schema.
            receipt: 'nexus.release-receipt.v3',
          },
          active: { releaseId: RELEASE_ID, sourceSha: ORIGINAL_SHA, status: 'completed' },
          activeReceipt: {
            schema: receiptSchema,
            releaseId: RELEASE_ID,
            sourceSha: ORIGINAL_SHA,
            outcome: 'completed',
          },
          effective: { releaseId: RELEASE_ID, status: 'completed', provable: true },
        })}\n`,
        stderr: '',
      };
    }
    if (command === '/usr/sbin/visudo' || command === '/usr/bin/sudo') {
      return { status: 0, stdout: '{}\n', stderr: '' };
    }
    if (command !== '/usr/bin/systemctl') {
      return { status: 127, stdout: '', stderr: `unexpected command ${command}` };
    }
    if (args[0] === 'daemon-reload') {
      refresh();
      return { status: 0, stdout: '', stderr: '' };
    }
    const unit = args[1] === '--now' ? args[2] : args[1];
    const state = units.get(unit);
    if (args[0] === 'show') {
      const property = args.find((value) => value.startsWith('--property='))
        ?.replace('--property=', '');
      const values: Record<string, string> = {
        ActiveState: state?.active ?? 'inactive',
        LoadState: state?.load ?? 'not-found',
        FragmentPath: state?.fragment ?? '',
        DropInPaths: '',
        NeedDaemonReload: 'no',
      };
      return { status: 0, stdout: `${values[property ?? ''] ?? ''}\n`, stderr: '' };
    }
    if (args[0] === 'is-enabled') {
      return { status: state?.enabled ? 0 : 1,
        stdout: `${state?.enabled ? 'enabled' : state?.load === 'not-found' ? 'not-found' : 'disabled'}\n`,
        stderr: '' };
    }
    if (!state) return { status: 1, stdout: '', stderr: 'unit absent' };
    if (args[0] === 'disable') {
      state.enabled = false;
      state.active = 'inactive';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'enable') {
      state.enabled = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'start') {
      state.active = 'active';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'stop' || args[0] === 'reset-failed') {
      state.active = 'inactive';
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected systemctl ${args.join(' ')}` };
  };
  return {
    exec,
    units,
    setReceiptSchema(value: string) { receiptSchema = value; },
  };
}

function lstatMaybe(file: string) {
  try { return lstatSync(file); } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function transaction(targetDigest: string) {
  return {
    schema: 'nexus.control-plane-transaction.v1',
    operation: 'install',
    mode: 'upgrade',
    targetSha: TARGET_SHA,
    sourceRepository: REPOSITORY,
    expectedMarker: `${TARGET_SHA} ${REPOSITORY} /usr/bin/node:v22.23.1`,
    stagePath: `/opt/nexus-release/staging/${TARGET_SHA}.candidate`,
    stageIdentity: '1:2',
    targetPath: `/opt/nexus-release/control-plane/${TARGET_SHA}`,
    candidateDigest: targetDigest,
    controlPlaneSchema: 'nexus.release-control-plane.v1',
    controlPlaneDigest: '1'.repeat(64),
    originalActivePath: `/opt/nexus-release/control-plane/${ORIGINAL_SHA}`,
    originalPreviousPath: `/opt/nexus-release/control-plane/${PREVIOUS_SHA}`,
    pollerTimerWasActive: 1,
    pollerTimerWasEnabled: 1,
    pollerTimerDesiredActive: 1,
    pollerTimerDesiredEnabled: 1,
    heartbeatTimerWasActive: 1,
    heartbeatTimerWasEnabled: 1,
    livenessTimerWasActive: 0,
    livenessTimerWasEnabled: 0,
    livenessTimerDesiredActive: 0,
    livenessTimerDesiredEnabled: 0,
    backupTimerWasActive: 1,
    backupTimerWasEnabled: 1,
    restoreVerifyTimerWasActive: 0,
    restoreVerifyTimerWasEnabled: 1,
    phase: 'capabilities_installed',
    createdAt: '2026-08-11T10:00:00Z',
    updatedAt: '2026-08-11T10:01:00Z',
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nexus-control-plane-abort-'));
  workspaces.push(root);
  chmodSync(root, 0o700);
  for (const directory of [
    '/opt/nexus-release/control-plane', '/var/lib/nexus-release/state',
    '/var/lib/nexus-release/receipts', '/var/lib/nexus-release/locks', '/usr/local/sbin',
    '/usr/local/libexec/nexus-local-backup', '/etc/sudoers.d', '/etc/systemd/system',
    '/run/lock',
  ]) mkdirSync(host(root, directory), { recursive: true, mode: directory.endsWith('/state') ? 0o700 : 0o755 });
  chmodSync(host(root, '/var/lib/nexus-release/state'), 0o700);
  chmodSync(host(root, '/run/lock'), 0o1777);
  const target = tree(root, TARGET_SHA, { full: true, liveness: true });
  const original = tree(root, ORIGINAL_SHA, { full: true });
  const previous = tree(root, PREVIOUS_SHA);
  const recoverySource = tree(root, HOTFIX_SHA, {
    recovery: true,
    base: '/opt/nexus-release/recovery-tools/control-plane',
  });
  const active = host(root, '/opt/nexus-release/checkout');
  const prior = host(root, '/opt/nexus-release/checkout.previous');
  symlinkSync(`control-plane/${TARGET_SHA}`, active);
  symlinkSync(`control-plane/${ORIGINAL_SHA}`, prior);

  for (const [relative, destination, mode] of capabilities) {
    write(root, destination, readFileSync(join(target.directory, relative), 'utf8'), mode);
  }
  for (const unit of CORE_UNITS) {
    write(root, `/etc/systemd/system/${unit}`,
      readFileSync(join(original.directory, 'ops/nexus-release', unit), 'utf8'));
  }
  for (const [relative, destination, mode] of BACKUP_ASSETS) {
    write(root, destination, readFileSync(join(target.directory, relative), 'utf8'), mode);
  }

  const evidenceDigest = '2'.repeat(64);
  const payloadDigest = `sha256:${'3'.repeat(64)}`;
  const state = {
    schema: 'nexus.release-host-state.v1',
    active: {
      releaseId: RELEASE_ID,
      sourceSha: ORIGINAL_SHA,
      status: 'completed',
      evidenceDigest,
      payload: { digest: payloadDigest },
    },
  };
  write(root, '/var/lib/nexus-release/state/release-state.json', `${JSON.stringify(state)}\n`, 0o600);
  const receipt = {
    schema: 'nexus.release-receipt.v2',
    releaseId: RELEASE_ID,
    sourceSha: ORIGINAL_SHA,
    outcome: 'completed',
    failureCode: null,
    evidenceDigest,
    identity: { releasePayloadDigest: payloadDigest },
  };
  const receiptBytes = `${JSON.stringify(receipt)}\n`;
  write(root, `/var/lib/nexus-release/receipts/${RELEASE_ID}.json`, receiptBytes, 0o600);
  write(root, '/var/lib/nexus-release/state/control-plane-transaction.json',
    `${JSON.stringify(transaction(target.digest))}\n`, 0o600);
  const systemd = fakeSystemd(root);
  const expected = {
    targetSha: TARGET_SHA,
    originalSha: ORIGINAL_SHA,
    applicationReleaseId: RELEASE_ID,
    applicationSourceSha: ORIGINAL_SHA,
    applicationReceiptSha256: sha256(receiptBytes),
    recoverySourceSha: HOTFIX_SHA,
    recoverySourceTreeDigest: recoverySource.digest,
  };
  return { root, target, original, previous, recoverySource, systemd, expected };
}

function replaceReceipt(input: ReturnType<typeof fixture>, receipt: Record<string, unknown>) {
  const bytes = `${JSON.stringify(receipt)}\n`;
  writeFileSync(host(input.root,
    `/var/lib/nexus-release/receipts/${RELEASE_ID}.json`), bytes);
  input.expected.applicationReceiptSha256 = sha256(bytes);
  input.systemd.setReceiptSchema(String(receipt.schema));
}

afterEach(() => {
  for (const root of workspaces.splice(0)) {
    for (const sha of [TARGET_SHA, ORIGINAL_SHA, PREVIOUS_SHA]) {
      const directory = host(root, `/opt/nexus-release/control-plane/${sha}`);
      if (lstatMaybe(directory)) thawTree(directory);
    }
    const recoveryDirectory = host(root,
      `/opt/nexus-release/recovery-tools/control-plane/${HOTFIX_SHA}`);
    if (lstatMaybe(recoveryDirectory)) thawTree(recoveryDirectory);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('control-plane abort-to-recorded-original recovery', () => {
  it('binds the three locks with the canonical maintenance-lock identity', () => {
    const wrapper = readFileSync(join(process.cwd(),
      'scripts/release-control-plane-abort-recovery.sh'), 'utf8');
    const module = readFileSync(join(process.cwd(),
      'scripts/release-control-plane-abort-recovery.mjs'), 'utf8');
    expect(wrapper).toContain('exec 7<>"$CONTROL_LOCK"');
    expect(wrapper).toContain('exec 9<>"$RELEASE_LOCK"');
    expect(wrapper).toContain('exec 8<>"$MAINTENANCE_LOCK"');
    expect(wrapper).toContain('"0:$DOMINGUEZ_GID:660:1"');
    expect(module).toContain('expectedUid: 0, expectedGid: Number(gidText), mode: 0o660');
  });

  it('accepts only the exact owner and sticky-1777 runtime lock directory', () => {
    const exact = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid,
      gid,
      mode: 0o41777,
    };
    expect(() => assertRuntimeLockDirectoryMetadata(exact, {
      expectedUid: uid, expectedGid: gid,
    })).not.toThrow();
    expect(() => assertRuntimeLockDirectoryMetadata({ ...exact, mode: 0o40777 }, {
      expectedUid: uid, expectedGid: gid,
    })).toThrow(/exact trusted sticky root/u);
    expect(() => assertRuntimeLockDirectoryMetadata(exact, {
      expectedUid: uid + 1, expectedGid: gid,
    })).toThrow(/exact trusted sticky root/u);
  });

  it('restores exact original authority and durably defers the incompatible poller', () => {
    const input = fixture();
    const result = runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      now: () => Date.parse('2026-08-11T11:00:00Z'),
      requireLocks: false,
    });

    expect(result.phase).toBe('complete');
    expect(readlinkSync(host(input.root, '/opt/nexus-release/checkout')))
      .toBe(`control-plane/${ORIGINAL_SHA}`);
    expect(readlinkSync(host(input.root, '/opt/nexus-release/checkout.previous')))
      .toBe(`control-plane/${PREVIOUS_SHA}`);
    expect(lstatMaybe(host(input.root,
      '/var/lib/nexus-release/state/control-plane-transaction.json'))).toBeNull();
    expect(lstatMaybe(host(input.root,
      `/var/lib/nexus-release/state/control-plane-aborted-${TARGET_SHA}.json`))).not.toBeNull();
    expect(lstatMaybe(host(input.root,
      `/var/lib/nexus-release/state/control-plane-abort-recovery-${TARGET_SHA}.json`))).not.toBeNull();
    expect(input.systemd.units.get('nexus-release-poller.timer'))
      .toMatchObject({ active: 'inactive', enabled: false });
    expect(input.systemd.units.get('nexus-release-heartbeat.timer'))
      .toMatchObject({ active: 'active', enabled: true });
    expect(input.systemd.units.get('nexus-local-backup.timer'))
      .toMatchObject({ active: 'active', enabled: true });
    expect(input.systemd.units.get('nexus-local-backup-restore-verify.timer'))
      .toMatchObject({ active: 'inactive', enabled: true });
    expect(readFileSync(host(input.root,
      '/etc/systemd/system/nexus-local-backup.service'), 'utf8'))
      .toBe(readFileSync(join(input.original.directory,
        'ops/local-backup/systemd/nexus-local-backup.service'), 'utf8'));
  });

  it.each(RECOVERY_PHASES)(
    'resumes after a simulated process death at durable phase %s', (faultPhase) => {
    const input = fixture();
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
      onPhase: (phase) => {
        if (phase === faultPhase) throw new Error('simulated process death');
      },
    })).toThrow('simulated process death');
    const durable = JSON.parse(readFileSync(host(input.root,
      '/var/lib/nexus-release/state/control-plane-abort-recovery.json'), 'utf8'));
    expect(durable.phase).toBe(faultPhase);

    const result = runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    });
    expect(result.phase).toBe('complete');
  });

  it('refuses unknown transition bytes before publishing recovery authority', () => {
    const input = fixture();
    writeFileSync(host(input.root, '/usr/local/sbin/nexus-release-state-view'), 'unknown\n');
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    })).toThrow(/differs from immutable source/u);
    expect(lstatMaybe(host(input.root,
      '/var/lib/nexus-release/state/control-plane-abort-recovery.json'))).toBeNull();
  });

  it('fails closed when application state changes after durable admission', () => {
    const input = fixture();
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
      onPhase: (phase) => {
        if (phase === 'services_settled') {
          writeFileSync(host(input.root, '/var/lib/nexus-release/state/release-state.json'),
            '{"schema":"changed"}\n');
        }
      },
    })).toThrow(/application state or immutable receipt changed/u);
    expect(lstatMaybe(host(input.root,
      '/var/lib/nexus-release/state/control-plane-transaction.json'))).not.toBeNull();
  });

  it.each([
    ['v2 with a controlPlane', 'nexus.release-receipt.v2', true],
    ['v3 without a controlPlane', 'nexus.release-receipt.v3', false],
  ])('rejects contradictory receipt pairing: %s', (_label, schema, includeControlPlane) => {
    const input = fixture();
    replaceReceipt(input, {
      schema,
      releaseId: RELEASE_ID,
      sourceSha: ORIGINAL_SHA,
      outcome: 'completed',
      failureCode: null,
      evidenceDigest: '2'.repeat(64),
      identity: { releasePayloadDigest: `sha256:${'3'.repeat(64)}` },
      ...(includeControlPlane ? {
        controlPlane: {
          schema: 'nexus.release-control-plane.v1', digest: '4'.repeat(64),
        },
      } : {}),
    });
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    })).toThrow(/schema\/control-plane pairing is contradictory/u);
  });

  it('admits a validator-proved v3 receipt with an explicit controlPlane pair', () => {
    const input = fixture();
    replaceReceipt(input, {
      schema: 'nexus.release-receipt.v3',
      releaseId: RELEASE_ID,
      sourceSha: ORIGINAL_SHA,
      outcome: 'completed',
      failureCode: null,
      evidenceDigest: '2'.repeat(64),
      identity: { releasePayloadDigest: `sha256:${'3'.repeat(64)}` },
      controlPlane: {
        schema: 'nexus.release-control-plane.v1', digest: '4'.repeat(64),
      },
    });
    const result = runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    });
    expect(result.phase).toBe('complete');
  });

  it('refuses a recovery executable changed after its owner-reviewed tree digest', () => {
    const input = fixture();
    const module = join(input.recoverySource.directory,
      'scripts/release-control-plane-abort-recovery.mjs');
    chmodSync(module, 0o644);
    writeFileSync(module, '#!/usr/bin/env node\n// changed\n');
    chmodSync(module, 0o444);
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    })).toThrow(/immutable tree digest changed/u);
  });

  it('requires the signed descriptor to govern both recovery executables', () => {
    const input = fixture();
    const descriptor = join(input.recoverySource.directory,
      'ops/nexus-release/release-control-plane-inputs.json');
    const digestFile = join(input.recoverySource.directory,
      '.nexus-control-plane-tree.sha256');
    chmodSync(descriptor, 0o644);
    writeFileSync(descriptor, `${JSON.stringify({
      schema: 'nexus.release-control-plane-inputs.v1',
      staticFiles: ['scripts/release-control-plane-abort-recovery.mjs'],
    })}\n`);
    chmodSync(descriptor, 0o444);
    const digest = computeImmutableTreeDigest(input.recoverySource.directory, {
      expectedUid: uid, expectedGid: gid,
    });
    chmodSync(digestFile, 0o644);
    writeFileSync(digestFile, `${digest}\n`);
    chmodSync(digestFile, 0o444);
    input.expected.recoverySourceTreeDigest = digest;
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    })).toThrow(/descriptor does not govern both recovery executables/u);
  });

  it('refuses a writable authority ancestor before durable admission', () => {
    const input = fixture();
    chmodSync(host(input.root, '/usr/local'), 0o775);
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
    })).toThrow(/trusted ancestor is symbolic, unowned, or writable/u);
    expect(lstatMaybe(host(input.root,
      '/var/lib/nexus-release/state/control-plane-abort-recovery.json'))).toBeNull();
  });

  it('refuses an authority ancestor inode swapped between durable phases', () => {
    const input = fixture();
    const systemdRoot = host(input.root, '/etc/systemd/system');
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
      onPhase: (phase) => {
        if (phase === 'services_settled') {
          renameSync(systemdRoot, `${systemdRoot}.replaced`);
          mkdirSync(systemdRoot, { mode: 0o755 });
        }
      },
    })).toThrow(/trusted ancestor changed during recovery/u);
    expect(lstatMaybe(host(input.root,
      '/var/lib/nexus-release/state/control-plane-transaction.json'))).not.toBeNull();
  });

  it('refuses an exact-mode runtime lock directory inode swapped between phases', () => {
    const input = fixture();
    const runtimeLock = host(input.root, '/run/lock');
    expect(() => runControlPlaneAbortRecovery({
      expected: input.expected,
      hostRoot: input.root,
      expectedUid: uid,
      expectedGid: gid,
      exec: input.systemd.exec,
      requireLocks: false,
      onPhase: (phase) => {
        if (phase === 'services_settled') {
          renameSync(runtimeLock, `${runtimeLock}.replaced`);
          mkdirSync(runtimeLock, { mode: 0o1777 });
          chmodSync(runtimeLock, 0o1777);
        }
      },
    })).toThrow(/trusted ancestor changed during recovery/u);
  });
});
