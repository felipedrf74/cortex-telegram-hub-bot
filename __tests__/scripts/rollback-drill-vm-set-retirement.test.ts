import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repository = resolve('.');
const control = resolve('scripts/rollback-drill-vm-set-retirement.py');
const layout = resolve('ops/rollback-drill-vm/install-layout.tsv');
const sourceSha = 'a'.repeat(40);
const staleRuntimeManifestBody = 'installed-runtime-manifest';
const setId = 'c'.repeat(64);

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeMode(path: string, body: Buffer | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, mode);
}

function fixture(
  options: {
    activeManifestMatchesSource?: boolean;
    activeControlMatchesSource?: boolean;
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'nexus-kvm-retirement-')),
  );
  chmodSync(root, 0o700);
  const state = join(root, 'state');
  const runtime = join(root, 'run');
  const shared = join(root, 'release-sonar.lock');
  const bootstrap = join(root, 'bootstrap');
  const sourceRoot = join(bootstrap, sourceSha, 'source');
  const archive = join(bootstrap, sourceSha, 'source.tar.gz');
  const proc = join(root, 'proc');
  const guards = join(root, 'guards');
  for (const path of [
    state,
    join(state, 'base'),
    join(state, 'sets'),
    runtime,
    proc,
    guards,
    join(bootstrap, sourceSha),
    sourceRoot,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o750 });
  }
  chmodSync(state, 0o750);
  chmodSync(join(state, 'base'), 0o750);
  chmodSync(join(state, 'sets'), 0o750);
  chmodSync(sourceRoot, 0o700);
  chmodSync(join(bootstrap, sourceSha), 0o700);

  const rows = readFileSync(layout, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t')[0]);
  for (const relative of new Set([
    ...rows,
    'ops/rollback-drill-vm/install-layout.tsv',
    'scripts/rollback-drill-vm-systemd-install.sh',
  ])) {
    const destination = join(sourceRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repository, relative), destination);
    chmodSync(destination, statSync(join(repository, relative)).mode & 0o777);
  }
  const archiveResult = spawnSync('python3', ['-c', `
import sys,tarfile
source,archive,sha=sys.argv[1:]
with tarfile.open(
    archive, "w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": sha}
) as bundle:
    bundle.add(source, arcname="source", recursive=True)
`, sourceRoot, archive, sourceSha], { encoding: 'utf8' });
  expect(archiveResult.status, archiveResult.stderr).toBe(0);
  chmodSync(archive, 0o600);
  const archiveSha = sha256(readFileSync(archive));

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const setRoot = join(state, 'sets', setId);
  mkdirSync(setRoot, { mode: 0o750 });
  writeMode(
    join(setRoot, 'release-layout-hypervisor-evidence-private.pem'),
    privatePem,
    0o600,
  );
  writeMode(
    join(setRoot, 'release-layout-hypervisor-evidence-public.pem'),
    publicPem,
    0o644,
  );

  const digests = Object.fromEntries(
    [
      'runner',
      'unit',
      'preflight',
      'runtime-control',
      'runtime-readiness',
      'runtime-recovery',
      'controller',
      'controller-unit',
      'controller-recovery',
      'guest-executor',
      'guest-recovery',
      'verifier',
      'qemu',
    ].map((name) => [name, sha256(name)]),
  );
  const installedRoot = join(root, 'installed');
  mkdirSync(installedRoot, { mode: 0o700 });
  const activeRuntimeManifestBody = options.activeManifestMatchesSource
    ? readFileSync(
        join(repository, 'scripts/rollback-drill-vm-runtime-manifest.py'),
      )
    : Buffer.from(staleRuntimeManifestBody);
  const activeRuntimeManifest = sha256(activeRuntimeManifestBody);
  const activeRuntimeControlBody = options.activeControlMatchesSource
    ? readFileSync(
        join(repository, 'scripts/rollback-drill-vm-runtime-control.sh'),
      )
    : Buffer.from('installed-runtime-control');
  const installed = Object.fromEntries(
    [
      'runner',
      'unit',
      'preflight',
      'runtime-manifest',
      'runtime-control',
      'runtime-readiness',
      'runtime-recovery',
      'controller',
      'controller-unit',
      'controller-recovery',
      'guest-executor',
      'guest-recovery',
      'verifier',
    ].map((name) => {
      const path = join(installedRoot, name);
      const body = name === 'runtime-manifest'
        ? activeRuntimeManifestBody
        : name === 'runtime-control'
          ? activeRuntimeControlBody
          : Buffer.from(`installed-${name}`);
      writeMode(path, body, 0o600);
      return [name, { path, digest: sha256(body) }];
    }),
  );
  const hypervisor = {
    manager: 'qemu-systemd',
    qemuBinary: '/usr/bin/qemu-system-x86_64',
    qemuSha256: digests.qemu,
    qemuVersion: 'test',
    qemuPackage: 'qemu-system-x86',
    qemuPackageVersion: 'test',
    qemuPackageArchitecture: 'amd64',
    runnerPath: installed.runner.path,
    runnerSha256: installed.runner.digest,
    hostPreflightPath: installed.preflight.path,
    hostPreflightSha256: installed.preflight.digest,
    runtimeManifestPath: installed['runtime-manifest'].path,
    runtimeManifestSha256: activeRuntimeManifest,
    runtimeControlSourcePath: installed['runtime-control'].path,
    runtimeControlSha256: installed['runtime-control'].digest,
    runtimeReadinessPath: installed['runtime-readiness'].path,
    runtimeReadinessSha256: installed['runtime-readiness'].digest,
    runtimeRecoveryUnitSourcePath: installed['runtime-recovery'].path,
    runtimeRecoveryUnitSha256: installed['runtime-recovery'].digest,
    faultDrillControllerPath: installed.controller.path,
    faultDrillControllerSha256: installed.controller.digest,
    faultDrillControllerUnitPath: installed['controller-unit'].path,
    faultDrillControllerUnitSha256: installed['controller-unit'].digest,
    faultDrillControllerRecoveryUnitPath: installed['controller-recovery'].path,
    faultDrillControllerRecoveryUnitSha256: installed['controller-recovery'].digest,
    faultDrillGuestExecutorSourcePath: installed['guest-executor'].path,
    faultDrillGuestExecutorSha256: installed['guest-executor'].digest,
    faultDrillGuestRecoveryUnitSourcePath: installed['guest-recovery'].path,
    faultDrillGuestRecoveryUnitSha256: installed['guest-recovery'].digest,
    faultDrillVerifierPath: installed.verifier.path,
    faultDrillVerifierSha256: installed.verifier.digest,
    sharedMutexPath: '/run/lock/nexus-release-sonar.lock',
    guestAdmissionLockPath: '/run/nexus-rollback-drill-vm/admission.lock',
    hostAvailableMemoryFloorGiB: 25,
    hostLoad15CeilingExclusive: 6,
    unitTemplate: 'nexus-rollback-drill-vm@.service',
    unitPath: installed.unit.path,
    unitSha256: installed.unit.digest,
    vcpus: 4,
    memoryMiB: 14336,
    memorySwapMaxMiB: 512,
    diskBytes: 100 * 1024 * 1024 * 1024,
    networkMode: 'qemu-user-restrict',
    loopbackHost: '127.0.0.1',
    singleActiveGuest: true,
    bridgeAttached: false,
    tapAttached: false,
    sharedFilesystemAttached: false,
    hostBlockDeviceAttached: false,
    productionDataAttached: false,
  };
  const guests = ['guest-1', 'guest-2', 'guest-3'].map((name, index) => {
    const guestRoot = join(setRoot, name);
    mkdirSync(guestRoot, { mode: 0o750 });
    const overlay = Buffer.from(`overlay-${name}`);
    const seed = Buffer.from(`seed-${name}`);
    writeMode(join(guestRoot, 'root.qcow2'), overlay, 0o600);
    writeMode(join(guestRoot, 'seed.img'), seed, 0o640);
    const guestPublic = `${publicPem.trim()}\n`;
    writeMode(
      join(setRoot, `release-layout-${name}-evidence-public.pem`),
      guestPublic,
      0o644,
    );
    return {
      name,
      port: 22991 + index,
      unit: `nexus-rollback-drill-vm@${name}.service`,
      uuid: `00000000-0000-4000-8000-00000000000${index + 1}`,
      mac: `52:54:00:00:00:0${index + 1}`,
      instanceId: `test-${name}`,
      overlayPath: join(guestRoot, 'root.qcow2'),
      overlayInitialSha256: sha256(overlay),
      seedPath: join(guestRoot, 'seed.img'),
      seedSha256: sha256(seed),
      hostPublicKey: `ssh-ed25519 TEST${index}`,
      hostPublicKeySha256: sha256(`ssh-ed25519 TEST${index}`),
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
    };
  });
  const baseBody = Buffer.from('canonical-base-image');
  const baseSha = sha256(baseBody);
  writeMode(join(state, 'base', `${baseSha}.qcow2`), baseBody, 0o440);
  const active = {
    schema: 'nexus.rollback-drill-vm-provision.v2',
    setId,
    image: {
      filename: 'noble-server-cloudimg-amd64.img',
      sha256: baseSha,
      basePath: join(state, 'base', `${baseSha}.qcow2`),
    },
    sshPublicKeySha256: sha256('operator-key'),
    guestSshHostPublicKeySha256s: guests.map((guest) => guest.hostPublicKeySha256),
    ports: guests.map((guest) => guest.port),
    setDirectory: setRoot,
    runtimeReadiness: {
      status: 'ssh_only_bootstrap_required',
      drillReady: false,
      requirements: [
        'node-22.23.1',
        'python-3.12.x',
        'pm2-6.0.14-root-closure-at-/opt/nexus-release/pm2/6.0.14-via-/usr/local/bin/pm2',
        'digest-bound-offline-toolchain-evidence',
      ],
    },
    hypervisor,
    guests,
    createdAt: '2026-07-26T00:00:00Z',
  };
  const activeBody = `${JSON.stringify(active, null, 2)}\n`;
  const activeSha = sha256(activeBody);
  writeMode(join(state, 'active.json'), activeBody, 0o640);
  writeMode(join(setRoot, 'receipt.json'), activeBody, 0o640);
  const scenarios = {
    failed_health_check: 'guest-2',
    host_reboot_during_migration: 'guest-3',
    ssh_disconnect_after_pm2_stop: 'guest-1',
  };
  const trust = {
    schema: 'nexus.release-layout-kvm-trust.v1',
    provision: {
      schema: active.schema,
      setId,
      receiptSha256: activeSha,
    },
    hypervisor: {
      publicKeyPem: publicPem,
      publicKeySha256: sha256(publicPem),
      qemuSha256: hypervisor.qemuSha256,
      runnerSha256: hypervisor.runnerSha256,
      controllerPath: hypervisor.faultDrillControllerPath,
      controllerSha256: hypervisor.faultDrillControllerSha256,
      controllerRecoveryUnitPath: hypervisor.faultDrillControllerRecoveryUnitPath,
      controllerRecoveryUnitSha256: hypervisor.faultDrillControllerRecoveryUnitSha256,
      controllerUnitPath: hypervisor.faultDrillControllerUnitPath,
      controllerUnitSha256: hypervisor.faultDrillControllerUnitSha256,
      verifierPath: hypervisor.faultDrillVerifierPath,
      verifierSha256: hypervisor.faultDrillVerifierSha256,
    },
    guests: Object.fromEntries(Object.entries(scenarios).map(([scenario, name]) => {
      const guest = guests.find((candidate) => candidate.name === name)!;
      return [scenario, {
        guestId: name,
        publicKeyPem: publicPem,
        publicKeySha256: sha256(publicPem),
        sshHostPublicKeySha256: guest.hostPublicKeySha256,
        executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
        executorSha256: hypervisor.faultDrillGuestExecutorSha256,
        recoveryUnitPath: '/etc/systemd/system/nexus-release-layout-fault-guest-recovery.service',
        recoveryUnitSha256: hypervisor.faultDrillGuestRecoveryUnitSha256,
      }];
    })),
    createdAt: '2026-07-26T00:00:00Z',
  };
  const trustBody = `${JSON.stringify(trust, null, 2)}\n`;
  writeMode(join(state, 'release-layout-evidence-trust.v1.json'), trustBody, 0o600);
  writeMode(join(setRoot, 'release-layout-evidence-trust.v1.json'), trustBody, 0o600);

  for (const [path, mode] of [
    [join(state, 'control.lock'), 0o600],
    [join(runtime, 'release-layout-fault-controller.lock'), 0o600],
    [join(runtime, 'admission.lock'), 0o660],
    [join(runtime, 'active.lock'), 0o660],
    [shared, 0o660],
  ] as const) writeMode(path, '', mode);
  const fakeSystemctl = join(root, 'systemctl');
  writeMode(fakeSystemctl, `#!/bin/sh
if [ "$1" = show ]; then
  printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\nControlPID=0\\n'
fi
exit 0
`, 0o755);
  const fakeOpenSsl = join(root, 'openssl');
  writeMode(fakeOpenSsl, '#!/bin/sh\ncat "$NEXUS_TEST_HYPERVISOR_PUBLIC"\n', 0o755);
  const env = {
    ...process.env,
    NEXUS_KVM_SET_RETIREMENT_TEST_MODE: '1',
    NEXUS_KVM_SET_RETIREMENT_TEST_STATE_ROOT: state,
    NEXUS_KVM_SET_RETIREMENT_TEST_RUNTIME_ROOT: runtime,
    NEXUS_KVM_SET_RETIREMENT_TEST_SHARED_MUTEX: shared,
    NEXUS_KVM_SET_RETIREMENT_TEST_SYSTEMCTL: fakeSystemctl,
    NEXUS_KVM_SET_RETIREMENT_TEST_PROC_ROOT: proc,
    NEXUS_KVM_SET_RETIREMENT_TEST_BOOT_GUARD_ROOT: guards,
    NEXUS_KVM_SET_RETIREMENT_TEST_BOOTSTRAP_BASE: bootstrap,
    NEXUS_KVM_SET_RETIREMENT_TEST_OPENSSL: fakeOpenSsl,
    NEXUS_TEST_HYPERVISOR_PUBLIC: join(setRoot, 'release-layout-hypervisor-evidence-public.pem'),
  };
  const baseArgs = [sourceRoot, sourceSha, archive, archiveSha];
  const quarantineArgs = [
    'quarantine',
    ...baseArgs,
    '--expected-set-id', setId,
    '--expected-active-sha256', activeSha,
    '--expected-runtime-manifest-sha256', activeRuntimeManifest,
    '--expected-runtime-control-sha256', installed['runtime-control'].digest,
    '--acknowledge-incomplete-set-replacement',
  ];
  return { state, env, baseArgs, quarantineArgs, activeSha };
}

describe('rollback-drill VM incomplete-set retirement', () => {
  it('pins one root-only installed control and blocks install/provision during recovery', () => {
    const installLayout = readFileSync(layout, 'utf8');
    const installer = readFileSync(
      resolve('scripts/rollback-drill-vm-systemd-install.sh'),
      'utf8',
    );
    const provisioner = readFileSync(
      resolve('scripts/rollback-drill-vm-provision.sh'),
      'utf8',
    );
    expect(installLayout).toContain(
      'scripts/rollback-drill-vm-set-retirement.py\t'
      + '/usr/local/libexec/nexus-rollback-drill-vm/retire-set\t'
      + 'root:root\t0700',
    );
    expect(installer).toContain(
      '[ "${#sources[@]}" -eq 17 ] || die "install layout asset count is invalid"',
    );
    expect(installer).toContain(
      'an interrupted set-retirement transaction requires exact-source recovery',
    );
    expect(provisioner).toContain(
      'set-retirement journal is present; run the exact-source recovery command',
    );
  });

  it('quarantines authority first without deleting bytes and preserves terminal evidence', () => {
    const value = fixture();
    const before = statSync(join(value.state, 'active.json')).ino;
    const result = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe('quarantined');
    expect(existsSync(join(value.state, 'active.json'))).toBe(false);
    expect(existsSync(join(value.state, 'release-layout-evidence-trust.v1.json'))).toBe(false);
    expect(readdirSync(join(value.state, 'base'))).toEqual([]);
    expect(readdirSync(join(value.state, 'sets'))).toEqual([]);
    const quarantine = join(value.state, 'quarantine', output.transactionId);
    expect(statSync(join(quarantine, 'payload', 'active.json')).ino).toBe(before);
    expect(
      readFileSync(join(quarantine, 'quarantine-receipt.v1.json')),
    ).toEqual(
      readFileSync(join(
        value.state,
        'set-retirement-receipts',
        `${output.transactionId}.quarantine.json`,
      )),
    );
  });

  it('accepts exact source drift bound only to runtime control', () => {
    const value = fixture({ activeManifestMatchesSource: true });
    const result = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('quarantined');
  });

  it('quarantines a same-source boot-mutated incomplete set for exact retry', () => {
    const value = fixture({
      activeManifestMatchesSource: true,
      activeControlMatchesSource: true,
    });
    const overlay = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    writeFileSync(overlay, 'boot-mutated-overlay');
    chmodSync(overlay, 0o600);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${sha256(readFileSync(overlay))}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('quarantined');
  });

  it('rejects a pristine same-source set without changed-overlay evidence', () => {
    const value = fixture({
      activeManifestMatchesSource: true,
      activeControlMatchesSource: true,
    });
    const result = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'same-source retry requires an explicitly bound changed overlay',
    );
  });

  it('rejects terminal fault-controller evidence for the active receipt', () => {
    const value = fixture();
    writeMode(
      join(
        value.state,
        'release-layout-fault-drills',
        '00000000-0000-4000-8000-000000000001',
        'controller-journal.v1.json',
      ),
      `${JSON.stringify({
        status: 'completed',
        provisionReceiptSha256: value.activeSha,
      })}\n`,
      0o600,
    );
    const result = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'fault-controller evidence exists for incomplete set',
    );
  });

  it('recovers forward after interruption immediately after authority withdrawal', () => {
    const value = fixture();
    const interrupted = spawnSync(control, value.quarantineArgs, {
      env: {
        ...value.env,
        NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER:
          'active_receipt_quarantined',
      },
      encoding: 'utf8',
    });
    expect(interrupted.status).toBe(198);
    expect(existsSync(join(value.state, 'set-retirement-in-progress.v1.json'))).toBe(true);
    const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe('quarantined');
    expect(existsSync(join(value.state, 'set-retirement-in-progress.v1.json'))).toBe(false);
    expect(readdirSync(join(value.state, 'base'))).toEqual([]);
    expect(readdirSync(join(value.state, 'sets'))).toEqual([]);
  });

  it.each([
    'prepared',
    'quarantine_root_prepared',
    'active_receipt_quarantined',
    'trust_manifest_quarantined',
    'guest_set_quarantined',
    'base_image_quarantined',
    'canonical_state_empty',
  ])('recovers every quarantine checkpoint: %s', (phase) => {
    const value = fixture();
    const interrupted = spawnSync(control, value.quarantineArgs, {
      env: {
        ...value.env,
        NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER: phase,
      },
      encoding: 'utf8',
    });
    expect(interrupted.status, interrupted.stderr).toBe(198);
    const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe('quarantined');
  });

  it.each([
    'prepared',
    'base_image_restored',
    'guest_set_restored',
    'trust_manifest_restored',
    'active_receipt_restored',
  ])('recovers every restore checkpoint: %s', (phase) => {
    const value = fixture();
    const quarantined = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(quarantined.status, quarantined.stderr).toBe(0);
    const transactionId = JSON.parse(quarantined.stdout).transactionId;
    const restoreArgs = [
      'restore',
      ...value.baseArgs,
      '--transaction-id', transactionId,
      '--expected-active-sha256', value.activeSha,
      '--acknowledge-restore-incomplete-set',
    ];
    const interrupted = spawnSync(control, restoreArgs, {
      env: {
        ...value.env,
        NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER: phase,
      },
      encoding: 'utf8',
    });
    expect(interrupted.status, interrupted.stderr).toBe(198);
    const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe('restored');
    expect(sha256(readFileSync(join(value.state, 'active.json')))).toBe(
      value.activeSha,
    );
  });

  it('rejects mutated guest bytes without arming a journal', () => {
    const value = fixture();
    writeFileSync(
      join(value.state, 'sets', setId, 'guest-1', 'root.qcow2'),
      'mutated-overlay',
    );
    chmodSync(
      join(value.state, 'sets', setId, 'guest-1', 'root.qcow2'),
      0o600,
    );
    const result = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'guest-1 bytes differ from the active provision receipt',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('quarantines an explicitly bound boot-mutated incomplete overlay', () => {
    const value = fixture();
    const overlay = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    writeFileSync(overlay, 'boot-mutated-overlay');
    chmodSync(overlay, 0o600);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${sha256(readFileSync(overlay))}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('quarantined');
  });

  it('requires booted-overlay acknowledgement and identities together', () => {
    const value = fixture();
    const overlay = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    writeFileSync(overlay, 'boot-mutated-overlay');
    chmodSync(overlay, 0o600);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${sha256(readFileSync(overlay))}`,
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'booted overlay acknowledgement and exact current overlay identities',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('rejects acknowledgement without an exact changed-overlay identity', () => {
    const value = fixture();
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'booted overlay acknowledgement and exact current overlay identities',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('rejects a wrong explicit stopped-overlay digest without a journal', () => {
    const value = fixture();
    const overlay = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    writeFileSync(overlay, 'boot-mutated-overlay');
    chmodSync(overlay, 0o600);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${'f'.repeat(64)}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'guest-1 bytes differ from the active provision receipt',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('rejects duplicate changed-overlay identities before arming a journal', () => {
    const value = fixture();
    const digest = 'f'.repeat(64);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${digest}`,
      '--expected-current-overlay-sha256',
      `guest-1=${digest}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'expected current overlay identity repeats guest-1',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('requires every changed overlay to have its own exact binding', () => {
    const value = fixture();
    const guest1 = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    const guest2 = join(
      value.state,
      'sets',
      setId,
      'guest-2',
      'root.qcow2',
    );
    writeFileSync(guest1, 'boot-mutated-overlay-1');
    writeFileSync(guest2, 'boot-mutated-overlay-2');
    chmodSync(guest1, 0o600);
    chmodSync(guest2, 0o600);
    const result = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${sha256(readFileSync(guest1))}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'guest-2 bytes differ from the active provision receipt',
    );
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('recovers a changed-overlay quarantine from its exact tree binding', () => {
    const value = fixture();
    const overlay = join(
      value.state,
      'sets',
      setId,
      'guest-1',
      'root.qcow2',
    );
    writeFileSync(overlay, 'boot-mutated-overlay');
    chmodSync(overlay, 0o600);
    const interrupted = spawnSync(control, [
      ...value.quarantineArgs,
      '--expected-current-overlay-sha256',
      `guest-1=${sha256(readFileSync(overlay))}`,
      '--acknowledge-booted-overlay-state',
    ], {
      env: {
        ...value.env,
        NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER:
          'active_receipt_quarantined',
      },
      encoding: 'utf8',
    });
    expect(interrupted.status, interrupted.stderr).toBe(198);
    const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout).status).toBe('quarantined');
  });

  it.each(['both', 'neither', 'mutated'])(
    'fails closed on %s authority after a crash',
    (fault) => {
      const value = fixture();
      const interrupted = spawnSync(control, value.quarantineArgs, {
        env: {
          ...value.env,
          NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER:
            'active_receipt_quarantined',
        },
        encoding: 'utf8',
      });
      expect(interrupted.status).toBe(198);
      const journal = JSON.parse(
        readFileSync(
          join(value.state, 'set-retirement-in-progress.v1.json'),
          'utf8',
        ),
      );
      const moved = join(
        journal.quarantineRoot,
        journal.bindings.active.quarantineRelative,
      );
      if (fault === 'both') {
        copyFileSync(moved, join(value.state, 'active.json'));
        chmodSync(join(value.state, 'active.json'), 0o640);
      } else if (fault === 'neither') {
        rmSync(moved);
      } else {
        writeFileSync(moved, '{"tampered":true}\n');
        chmodSync(moved, 0o640);
      }
      const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
        env: value.env,
        encoding: 'utf8',
      });
      expect(recovered.status).toBe(1);
      expect(
        existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
      ).toBe(true);
    },
  );

  it('does not arm restore when fresh canonical state is present', () => {
    const value = fixture();
    const quarantined = spawnSync(control, value.quarantineArgs, {
      env: value.env,
      encoding: 'utf8',
    });
    expect(quarantined.status, quarantined.stderr).toBe(0);
    const transactionId = JSON.parse(quarantined.stdout).transactionId;
    writeMode(join(value.state, 'base', 'fresh.qcow2'), 'fresh', 0o440);
    const restored = spawnSync(control, [
      'restore',
      ...value.baseArgs,
      '--transaction-id', transactionId,
      '--expected-active-sha256', value.activeSha,
      '--acknowledge-restore-incomplete-set',
    ], { env: value.env, encoding: 'utf8' });
    expect(restored.status).toBe(1);
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(false);
  });

  it('rejects conflicting terminal receipt collisions and retains recovery', () => {
    const value = fixture();
    const interrupted = spawnSync(control, value.quarantineArgs, {
      env: {
        ...value.env,
        NEXUS_KVM_SET_RETIREMENT_TEST_INTERRUPT_AFTER:
          'canonical_state_empty',
      },
      encoding: 'utf8',
    });
    expect(interrupted.status).toBe(198);
    const journal = JSON.parse(
      readFileSync(
        join(value.state, 'set-retirement-in-progress.v1.json'),
        'utf8',
      ),
    );
    writeMode(
      join(journal.quarantineRoot, 'quarantine-receipt.v1.json'),
      '{"collision":"local"}\n',
      0o600,
    );
    writeMode(
      join(
        value.state,
        'set-retirement-receipts',
        `${journal.transactionId}.quarantine.json`,
      ),
      '{"collision":"global"}\n',
      0o600,
    );
    const recovered = spawnSync(control, ['recover', ...value.baseArgs], {
      env: value.env,
      encoding: 'utf8',
    });
    expect(recovered.status).toBe(1);
    expect(
      existsSync(join(value.state, 'set-retirement-in-progress.v1.json')),
    ).toBe(true);
  });
});
