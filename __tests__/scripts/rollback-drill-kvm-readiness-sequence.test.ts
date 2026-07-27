import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  publicKeyIdentity,
  textKeyIdentity,
  validateProvisionReceipt,
} from '../../scripts/lib/rollback-drill-kvm-evidence.mjs';
import {
  makeKvmDrillFixture,
} from './helpers/rollback-drill-kvm-fixture';

const script = path.resolve(
  'scripts/rollback-drill-kvm-readiness-sequence.mjs',
);
const NOW = Date.parse('2026-07-25T12:00:00Z');
const STATE_ROOT_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_TEST_STATE_ROOT';
const NOW_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_TEST_NOW';
const BOOT_ID_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_TEST_BOOT_ID';
const UPTIME_ENV =
  'NEXUS_KVM_READINESS_SEQUENCE_TEST_UPTIME_SECONDS';
const INTERRUPT_ENV =
  'NEXUS_KVM_READINESS_SEQUENCE_TEST_INTERRUPT_AFTER_RECEIPT';
const LOCK_HELD_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_LOCK_HELD';
const MEASUREMENT_NAMESPACE =
  'nexus-rollback-drill-vm-runtime-measurement';
const bindings = [
  {
    drill: 'ssh-loss',
    runtimeDrill: 'ssh-disconnect-after-pm2-stop',
    guest: 'guest-1',
  },
  {
    drill: 'failed-health',
    runtimeDrill: 'failed-health-check',
    guest: 'guest-2',
  },
  {
    drill: 'guest-reboot',
    runtimeDrill: 'host-reboot-during-promotion',
    guest: 'guest-3',
  },
] as const;
const temporaryRoots: string[] = [];

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const iso = (milliseconds: number) =>
  new Date(milliseconds).toISOString().replace('.000Z', 'Z');

function privateDirectory(parent: string, name: string) {
  const directory = path.join(parent, name);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function privateFile(file: string, body: string | Buffer) {
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function parseResult(result: ReturnType<typeof spawnSync>) {
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  if (result.status === 0) return JSON.parse(stdout);
  const line = stderr.split('\n').filter(Boolean).at(-1) || '{}';
  return JSON.parse(line);
}

type Fixture = ReturnType<typeof createFixture>;

function run(
  fixture: Fixture,
  argv: string[],
  {
    now = NOW,
    interruptAfterReceipt = false,
    extraEnv = {},
  }: {
    now?: number;
    interruptAfterReceipt?: boolean;
    extraEnv?: Record<string, string>;
  } = {},
) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      [STATE_ROOT_ENV]: fixture.stateRoot,
      [NOW_ENV]: String(now),
      [BOOT_ID_ENV]: fixture.controllerBootId,
      [UPTIME_ENV]: String(
        fixture.controllerUptimeSeconds
          + Math.floor((now - NOW) / 1000),
      ),
      ...(interruptAfterReceipt ? { [INTERRUPT_ENV]: '1' } : {}),
      ...extraEnv,
    },
  });
  return { result, body: parseResult(result) };
}

function createFixture() {
  const root = realpathSync(mkdtempSync(
    path.join(os.tmpdir(), 'nexus-kvm-readiness-sequence-'),
  ));
  temporaryRoots.push(root);
  chmodSync(root, 0o700);
  const prepared = privateDirectory(root, 'prepared');
  const runtimeDirectory = privateDirectory(
    prepared,
    'runtime-authorizations',
  );
  const stateRoot = path.join(root, 'state');
  const guestOwner = generateKeyPairSync('ed25519');
  const guestOwnerPublicKey = guestOwner.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const guestOwnerPublicKeyPath = path.join(root, 'guest-owner.pem');
  privateFile(guestOwnerPublicKeyPath, guestOwnerPublicKey);

  const hostPrivateKeys = bindings.map((binding) => {
    const privateKey = path.join(root, `${binding.guest}-host-key`);
    const keyResult = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-f', privateKey],
      { encoding: 'utf8' },
    );
    expect(keyResult.status, keyResult.stderr).toBe(0);
    chmodSync(privateKey, 0o600);
    chmodSync(`${privateKey}.pub`, 0o600);
    const publicKey = readFileSync(`${privateKey}.pub`, 'utf8')
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .join(' ');
    const fingerprintResult = spawnSync(
      '/usr/bin/ssh-keygen',
      ['-l', '-E', 'sha256', '-f', `${privateKey}.pub`],
      { encoding: 'utf8' },
    );
    expect(fingerprintResult.status, fingerprintResult.stderr).toBe(0);
    return {
      privateKey,
      publicKey,
      publicKeySha256: textKeyIdentity(publicKey),
      fingerprint: fingerprintResult.stdout.trim().split(/\s+/u)[1],
    };
  });

  const base = makeKvmDrillFixture(NOW);
  const plan = structuredClone(base.plan);
  const controllerBootId = 'serverdominguez-boot-id';
  const controllerUptimeSeconds = 100_000;
  plan.controller.bootIdSha256 = digest(controllerBootId);
  plan.createdAt = iso(NOW - 60_000);
  plan.expiresAt = iso(NOW + 6 * 60 * 60 * 1000);
  plan.trust.guestOwnerPublicKeySha256 =
    publicKeyIdentity(guestOwnerPublicKey);
  plan.trust.guestSshHostPublicKeySha256s =
    hostPrivateKeys.map((key) => key.publicKeySha256);
  plan.overlays.forEach((overlay: any, index: number) => {
    overlay.ssh.hostPublicKeySha256 =
      hostPrivateKeys[index].publicKeySha256;
  });

  const ports = plan.overlays.map((overlay: any) => overlay.ssh.port);
  const hypervisor = {
    manager: 'qemu-systemd',
    qemuBinary: '/usr/bin/qemu-system-x86_64',
    qemuSha256: digest('qemu-binary'),
    qemuVersion: 'QEMU emulator version 8.2.2',
    qemuPackage: 'qemu-system-x86',
    qemuPackageVersion: '1:8.2.2+ds-0ubuntu1.7',
    qemuPackageArchitecture: 'amd64',
    runnerPath: '/usr/local/libexec/nexus-rollback-drill-vm/run',
    runnerSha256: digest('runner'),
    hostPreflightPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/host-preflight',
    hostPreflightSha256: digest('host-preflight'),
    runtimeManifestPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest',
    runtimeManifestSha256: digest('runtime-manifest'),
    runtimeControlSourcePath:
      '/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest',
    runtimeControlSha256: digest('runtime-control'),
    runtimeReadinessPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness',
    runtimeReadinessSha256: digest('runtime-readiness'),
    runtimeRecoveryUnitSourcePath:
      '/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service',
    runtimeRecoveryUnitSha256: digest('runtime-recovery'),
    faultDrillControllerPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller',
    faultDrillControllerSha256: digest('fault-drill-controller'),
    faultDrillControllerUnitPath:
      '/etc/systemd/system/nexus-release-layout-fault-drill@.service',
    faultDrillControllerUnitSha256: digest('fault-drill-controller-unit'),
    faultDrillControllerRecoveryUnitPath:
      '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service',
    faultDrillControllerRecoveryUnitSha256:
      digest('fault-drill-controller-recovery-unit'),
    faultDrillGuestExecutorSourcePath:
      '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest',
    faultDrillGuestExecutorSha256: digest('fault-drill-guest'),
    faultDrillGuestRecoveryUnitSourcePath:
      '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service',
    faultDrillGuestRecoveryUnitSha256:
      digest('fault-drill-guest-recovery-unit'),
    faultDrillVerifierPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs',
    faultDrillVerifierSha256: digest('fault-drill-verifier'),
    sharedMutexPath: '/run/lock/nexus-release-sonar.lock',
    guestAdmissionLockPath: '/run/nexus-rollback-drill-vm/admission.lock',
    hostAvailableMemoryFloorGiB: 25,
    hostLoad15CeilingExclusive: 6,
    unitTemplate: 'nexus-rollback-drill-vm@.service',
    unitPath: '/etc/systemd/system/nexus-rollback-drill-vm@.service',
    unitSha256: digest('unit-template'),
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
  const setMaterial = [
    'schema=nexus.rollback-drill-vm-provision.v2',
    `image=${plan.overlays[0].baselineSnapshotSha256}`,
    `key=${plan.trust.guestSshClientPublicKeySha256}`,
    `hostKeys=${hostPrivateKeys.map((key) => key.publicKeySha256).join(',')}`,
    `ports=${ports.join(',')}`,
    `runner=${hypervisor.runnerSha256}`,
    `hostPreflight=${hypervisor.hostPreflightSha256}`,
    `runtimeManifest=${hypervisor.runtimeManifestSha256}`,
    `runtimeControl=${hypervisor.runtimeControlSha256}`,
    `runtimeReadiness=${hypervisor.runtimeReadinessSha256}`,
    `runtimeRecoveryUnit=${hypervisor.runtimeRecoveryUnitSha256}`,
    `faultDrillController=${hypervisor.faultDrillControllerSha256}`,
    `faultDrillControllerUnit=${hypervisor.faultDrillControllerUnitSha256}`,
    `faultDrillControllerRecoveryUnit=${hypervisor.faultDrillControllerRecoveryUnitSha256}`,
    `faultDrillGuest=${hypervisor.faultDrillGuestExecutorSha256}`,
    `faultDrillGuestRecoveryUnit=${hypervisor.faultDrillGuestRecoveryUnitSha256}`,
    `faultDrillVerifier=${hypervisor.faultDrillVerifierSha256}`,
    `unit=${hypervisor.unitSha256}`,
    `qemu=${hypervisor.qemuSha256}`,
    `qemuVersion=${hypervisor.qemuVersion}`,
    `qemuPackage=${hypervisor.qemuPackage}`,
    `qemuPackageVersion=${hypervisor.qemuPackageVersion}`,
    `qemuPackageArchitecture=${hypervisor.qemuPackageArchitecture}`,
    '',
  ].join('\n');
  const setId = digest(setMaterial);
  const provision = {
    schema: 'nexus.rollback-drill-vm-provision.v2',
    setId,
    image: {
      filename: 'noble-server-cloudimg-amd64.img',
      sha256: plan.overlays[0].baselineSnapshotSha256,
      basePath:
        `/var/lib/nexus-rollback-drill-vm/base/` +
        `${plan.overlays[0].baselineSnapshotSha256}.qcow2`,
    },
    sshPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
    guestSshHostPublicKeySha256s:
      hostPrivateKeys.map((key) => key.publicKeySha256),
    ports,
    setDirectory: `/var/lib/nexus-rollback-drill-vm/sets/${setId}`,
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
    guests: bindings.map((binding, index) => ({
      name: binding.guest,
      port: ports[index],
      unit: `nexus-rollback-drill-vm@${binding.guest}.service`,
      uuid: plan.overlays[index].machineUuid,
      mac: `52:54:00:12:34:0${index + 1}`,
      instanceId:
        `nexus-rollback-drill-${binding.guest}-${setId.slice(0, 16)}`,
      overlayPath:
        `/var/lib/nexus-rollback-drill-vm/sets/` +
        `${setId}/${binding.guest}/root.qcow2`,
      overlayInitialSha256: plan.overlays[index].overlayInitialSha256,
      seedPath:
        `/var/lib/nexus-rollback-drill-vm/sets/` +
        `${setId}/${binding.guest}/seed.img`,
      seedSha256: digest(`${binding.guest}-seed`),
      hostPublicKey: hostPrivateKeys[index].publicKey,
      hostPublicKeySha256: hostPrivateKeys[index].publicKeySha256,
      hostKeyFingerprint: hostPrivateKeys[index].fingerprint,
    })),
    createdAt: iso(NOW - 2 * 60 * 1000),
  };
  const planBody = Buffer.from(canonicalJson(plan));
  const planPath = path.join(prepared, 'plan.json');
  privateFile(planPath, planBody);
  const provisionBody = Buffer.from(canonicalJson(provision));
  const provisionPath = path.join(prepared, 'provision.json');
  privateFile(provisionPath, provisionBody);
  const provisionSha256 = digest(provisionBody);

  const runtime: Record<string, {
    payload: any;
    body: Buffer;
    signature: Buffer;
  }> = {};
  const sharedBundleManifestSha256 = digest(
    'shared-provision-set-runtime-bundle',
  );
  const runtimeAuthorizations = bindings.map((binding, index) => {
    const bundleManifestSha256 = sharedBundleManifestSha256;
    const payload = {
      schema: 'nexus.rollback-drill-vm-runtime-authorization.v1',
      authorizationId: digest(
        `${plan.planId}:${binding.guest}:${bundleManifestSha256}:` +
          `${NOW - 30_000}`,
      ),
      issuedAt: iso(NOW - 30_000),
      expiresAt: iso(NOW + 3 * 60 * 60 * 1000),
      controllerBootIdSha256: plan.controller.bootIdSha256,
      issuedMonotonicSeconds: controllerUptimeSeconds - 30,
      expiresMonotonicSeconds:
        controllerUptimeSeconds + 3 * 60 * 60,
      operation: 'collect-runtime-readiness',
      drill: binding.runtimeDrill,
      setId: provision.setId,
      guest: binding.guest,
      port: provision.guests[index].port,
      provisionReceiptSha256: provisionSha256,
      bundleManifestSha256,
      guestSshHostPublicKeySha256:
        hostPrivateKeys[index].publicKeySha256,
      ownerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    };
    const body = Buffer.from(canonicalJson(payload));
    const signature = cryptoSign(null, body, guestOwner.privateKey);
    privateFile(path.join(runtimeDirectory, `${binding.drill}.json`), body);
    privateFile(path.join(runtimeDirectory, `${binding.drill}.sig`), signature);
    runtime[binding.drill] = { payload, body, signature };
    return {
      drill: binding.drill,
      guest: binding.guest,
      runtimeDrill: binding.runtimeDrill,
      file: `runtime-authorizations/${binding.drill}.json`,
      payloadSha256: digest(body),
      bundleManifestSha256,
    };
  });
  const generation = {
    schema: 'nexus.rollback-drill-kvm-input-generation.v1',
    generatedAt: iso(NOW - 30_000),
    executionMode: 'strictly-sequential',
    orderedDrills: bindings.map((binding) => binding.drill),
    specSha256: digest('input-spec'),
    provisionReceiptSha256: provisionSha256,
    planSha256: digest(planBody),
    runtimeAuthorizations,
    nextRequiredAction:
      'owner-sign-runtime-authorizations-and-collect-readiness',
  };
  const generationPath = path.join(prepared, 'generation-manifest.json');
  privateFile(generationPath, canonicalJson(generation));

  return {
    root,
    prepared,
    stateRoot,
    plan,
    planBody,
    planPath,
    generation,
    generationPath,
    provision,
    provisionBody,
    provisionPath,
    runtime,
    runtimeDirectory,
    guestOwner,
    guestOwnerPublicKeyPath,
    hostPrivateKeys,
    controllerBootId,
    controllerUptimeSeconds,
  };
}

function initArgs(fixture: Fixture) {
  return [
    'init',
    '--plan',
    fixture.planPath,
    '--generation-manifest',
    fixture.generationPath,
    '--provision-receipt',
    fixture.provisionPath,
    '--runtime-authorization-dir',
    fixture.runtimeDirectory,
    '--guest-owner-public-key',
    fixture.guestOwnerPublicKeyPath,
  ];
}

function sequenceRequest(fixture: Fixture, drill: string) {
  return path.join(
    fixture.stateRoot,
    digest(fixture.planBody),
    'requests',
    `${drill}.json`,
  );
}

function readinessFixture(fixture: Fixture, index: number) {
  const binding = bindings[index];
  const guest = fixture.provision.guests[index];
  const runtime = fixture.runtime[binding.drill];
  const root = privateDirectory(
    fixture.root,
    `readiness-${binding.drill}`,
  );
  const evidenceDirectory = privateDirectory(root, 'evidence');
  privateFile(
    path.join(evidenceDirectory, 'authorization.json'),
    runtime.body,
  );
  privateFile(
    path.join(evidenceDirectory, 'authorization.sig'),
    runtime.signature,
  );
  const challenge = digest(`${binding.drill}-challenge`);
  const runtimeMeasurement = {
    node: {
      version: 'v22.23.1',
      path: '/usr/bin/node',
      sha256: digest('node'),
      treeSha256: digest('node-tree'),
      owner: 'root:root',
      mode: '755',
      linkCount: 1,
    },
    python: {
      version: '3.12.3',
      path: '/usr/bin/python3.12',
      sha256: digest('python'),
      packageName: 'python3.12-minimal',
      packageVersion: '3.12.3-1ubuntu0.8',
      packageArchitecture: 'amd64',
    },
    pm2: {
      version: '6.0.14',
      path: '/usr/local/bin/pm2',
      sha256: digest('pm2'),
      entrypointPath:
        '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2',
      entrypointSha256: digest('pm2-entrypoint'),
      attestationPath:
        '/var/lib/nexus-release-promotion/pm2-root-install.v1.json',
      attestationSha256: digest('pm2-attestation'),
      treeSha256: digest('pm2-tree'),
      owner: 'root:root',
      mode: '755',
    },
  };
  const controlMeasurement = {
    version: 'nexus-release-promotion-control.v4',
    sourceCommit: fixture.plan.sourceRootSha,
    files: [],
    generatedFiles: [],
    serviceStates: [],
    assertIdle: true,
    runtimeRecovery: {
      sha256: fixture.provision.hypervisor.runtimeRecoveryUnitSha256,
    },
  };
  const pm2DryHealth = {
    status: 'passed',
    isolatedHome: true,
    daemonStopped: true,
    processCount: 0,
  };
  const measurement = {
    schema: 'nexus.rollback-drill-vm-runtime-measurement.v1',
    status: 'guest_checks_passed',
    drillReady: false,
    pendingHostOverlaySeal: true,
    setId: fixture.provision.setId,
    guest: binding.guest,
    capturedAt: iso(NOW + index * 60_000),
    provisionReceiptSha256: digest(fixture.provisionBody),
    bundleManifestSha256: runtime.payload.bundleManifestSha256,
    challenge,
    machine: {
      uuid: guest.uuid,
      instanceId: guest.instanceId,
      sshHostKeyFingerprint: guest.hostKeyFingerprint,
      sshHostPublicKeySha256: guest.hostPublicKeySha256,
    },
    runtime: runtimeMeasurement,
    control: controlMeasurement,
    pm2DryHealth,
    networkInstallAttempted: false,
  };
  const measurementPath = path.join(evidenceDirectory, 'measurement.json');
  privateFile(measurementPath, canonicalJson(measurement));
  const signResult = spawnSync(
    '/usr/bin/ssh-keygen',
    [
      '-Y',
      'sign',
      '-f',
      fixture.hostPrivateKeys[index].privateKey,
      '-n',
      MEASUREMENT_NAMESPACE,
      measurementPath,
    ],
    { encoding: 'utf8' },
  );
  expect(signResult.status, signResult.stderr).toBe(0);
  const measurementSignaturePath = path.join(
    evidenceDirectory,
    'measurement.sig',
  );
  renameSync(`${measurementPath}.sig`, measurementSignaturePath);
  chmodSync(measurementSignaturePath, 0o600);

  const supervisorPid = 10_000 + index * 10;
  const qemuPid = supervisorPid + 1;
  const supervisorStartTime = String(20_000 + index * 10);
  const qemuStartTime = String(20_001 + index * 10);
  const nonce = digest(`${binding.drill}-handoff-nonce`);
  const journal = {
    schema: 'nexus.rollback-drill-vm-runtime-collection-journal.v1',
    status: 'readiness_published',
    authorizationId: runtime.payload.authorizationId,
    authorizationSha256: digest(runtime.body),
    authorizationSignatureSha256: digest(runtime.signature),
    setId: fixture.provision.setId,
    guest: binding.guest,
    provisionReceiptSha256: digest(fixture.provisionBody),
    bundleManifestSha256: runtime.payload.bundleManifestSha256,
    challenge,
    nonce,
    measurementSha256: digest(readFileSync(measurementPath)),
    measurementSignatureSha256: digest(
      readFileSync(measurementSignaturePath),
    ),
    supervisorPid,
    supervisorStartTime,
    qemuPid,
    qemuStartTime,
  };
  privateFile(
    path.join(evidenceDirectory, 'journal.json'),
    canonicalJson(journal),
  );
  const liveQemu = {
    supervisorPid,
    supervisorStartTime,
    supervisorCmdlineSha256: digest(`${binding.drill}-supervisor`),
    qemuPid,
    qemuStartTime,
    qemuExecutable: fixture.provision.hypervisor.qemuBinary,
    qemuExecutableSha256: fixture.provision.hypervisor.qemuSha256,
    qemuCmdlineSha256: digest(`${binding.drill}-qemu-command`),
    loopbackPortSocketInode: String(30_000 + index),
  };
  const liveQemuPath = path.join(evidenceDirectory, 'live-qemu.json');
  privateFile(liveQemuPath, canonicalJson(liveQemu));
  const readiness = {
    schema: 'nexus.rollback-drill-vm-runtime-readiness.v2',
    status: 'ready',
    drillReady: true,
    sealedAt: iso(NOW + index * 60_000 + 30_000),
    setId: fixture.provision.setId,
    guest: binding.guest,
    port: guest.port,
    provisionReceiptSha256: digest(fixture.provisionBody),
    bundleManifestSha256: runtime.payload.bundleManifestSha256,
    ownerAuthorization: {
      authorizationId: runtime.payload.authorizationId,
      drill: runtime.payload.drill,
      issuedAt: runtime.payload.issuedAt,
      expiresAt: runtime.payload.expiresAt,
      controllerBootIdSha256:
        runtime.payload.controllerBootIdSha256,
      issuedMonotonicSeconds:
        runtime.payload.issuedMonotonicSeconds,
      expiresMonotonicSeconds:
        runtime.payload.expiresMonotonicSeconds,
      sha256: digest(runtime.body),
      signatureSha256: digest(runtime.signature),
      ownerPublicKeySha256: runtime.payload.ownerPublicKeySha256,
    },
    guestMeasurement: {
      sha256: journal.measurementSha256,
      signatureSha256: journal.measurementSignatureSha256,
      challenge,
      namespace: MEASUREMENT_NAMESPACE,
    },
    machine: {
      uuid: guest.uuid,
      instanceId: guest.instanceId,
      mac: guest.mac,
      sshHostKeyFingerprint: guest.hostKeyFingerprint,
      sshHostPublicKeySha256: guest.hostPublicKeySha256,
    },
    qemu: {
      unit: guest.unit,
      supervisorPid,
      supervisorStartTime,
      supervisorCmdlineSha256: liveQemu.supervisorCmdlineSha256,
      pid: qemuPid,
      startTime: qemuStartTime,
      executable: liveQemu.qemuExecutable,
      executableSha256: liveQemu.qemuExecutableSha256,
      cmdlineSha256: liveQemu.qemuCmdlineSha256,
      loopbackPortSocketInode: liveQemu.loopbackPortSocketInode,
    },
    stoppedGuestProof: {
      unit: guest.unit,
      systemdState: 'active-handoff-wait',
      admissionLockHeld: true,
      activeLockHolder: 'runner-supervisor',
      sharedReleaseSonarLockHolder: 'runner-supervisor',
      holderPid: supervisorPid,
      holderStartTime: supervisorStartTime,
      handoffNonce: nonce,
      qemuExited: true,
      overlayProcessAbsent: true,
    },
    overlay: {
      path: guest.overlayPath,
      initialSha256: guest.overlayInitialSha256,
      currentSha256: digest(`${binding.drill}-stopped-overlay`),
      size: 4096,
      device: 10 + index,
      inode: 20 + index,
      mtimeNs: 30 + index,
      ctimeNs: 40 + index,
      stableDescriptor: true,
    },
    runtime: runtimeMeasurement,
    control: controlMeasurement,
    pm2DryHealth,
    networkInstallAttempted: false,
  };
  const readinessPath = path.join(root, 'readiness.json');
  privateFile(readinessPath, canonicalJson(readiness));
  return {
    root,
    evidenceDirectory,
    readinessPath,
    readiness,
    measurement,
    measurementPath,
    measurementSignaturePath,
    journal,
    liveQemu,
    liveQemuPath,
  };
}

function resignMeasurement(
  fixture: Fixture,
  index: number,
  receipt: ReturnType<typeof readinessFixture>,
  signerIndex = index,
) {
  privateFile(receipt.measurementPath, canonicalJson(receipt.measurement));
  rmSync(receipt.measurementSignaturePath, { force: true });
  const signResult = spawnSync(
    '/usr/bin/ssh-keygen',
    [
      '-Y',
      'sign',
      '-f',
      fixture.hostPrivateKeys[signerIndex].privateKey,
      '-n',
      MEASUREMENT_NAMESPACE,
      receipt.measurementPath,
    ],
    { encoding: 'utf8' },
  );
  expect(signResult.status, signResult.stderr).toBe(0);
  renameSync(
    `${receipt.measurementPath}.sig`,
    receipt.measurementSignaturePath,
  );
  chmodSync(receipt.measurementSignaturePath, 0o600);
  receipt.journal.measurementSha256 = digest(
    readFileSync(receipt.measurementPath),
  );
  receipt.journal.measurementSignatureSha256 = digest(
    readFileSync(receipt.measurementSignaturePath),
  );
  privateFile(
    path.join(receipt.evidenceDirectory, 'journal.json'),
    canonicalJson(receipt.journal),
  );
  receipt.readiness.guestMeasurement.sha256 =
    receipt.journal.measurementSha256;
  receipt.readiness.guestMeasurement.signatureSha256 =
    receipt.journal.measurementSignatureSha256;
  privateFile(receipt.readinessPath, canonicalJson(receipt.readiness));
}

function rewriteAuthorization(
  fixture: Fixture,
  index: number,
  {
    issuedAt,
    expiresAt,
  }: {
    issuedAt: number;
    expiresAt: number;
  },
) {
  const binding = bindings[index];
  const authorization = fixture.runtime[binding.drill].payload;
  authorization.issuedAt = iso(issuedAt);
  authorization.expiresAt = iso(expiresAt);
  authorization.issuedMonotonicSeconds =
    fixture.controllerUptimeSeconds
      + Math.floor((issuedAt - NOW) / 1000);
  authorization.expiresMonotonicSeconds =
    fixture.controllerUptimeSeconds
      + Math.floor((expiresAt - NOW) / 1000);
  authorization.authorizationId = digest(
    `${fixture.plan.planId}:${binding.guest}:` +
      `${authorization.bundleManifestSha256}:${issuedAt}`,
  );
  const body = Buffer.from(canonicalJson(authorization));
  const signature = cryptoSign(null, body, fixture.guestOwner.privateKey);
  fixture.runtime[binding.drill].body = body;
  fixture.runtime[binding.drill].signature = signature;
  privateFile(
    path.join(fixture.runtimeDirectory, `${binding.drill}.json`),
    body,
  );
  privateFile(
    path.join(fixture.runtimeDirectory, `${binding.drill}.sig`),
    signature,
  );
  fixture.generation.runtimeAuthorizations[index].payloadSha256 =
    digest(body);
  privateFile(
    fixture.generationPath,
    canonicalJson(fixture.generation),
  );
}

function claimArgs(fixture: Fixture, drill: string) {
  return [
    'claim',
    '--plan',
    fixture.planPath,
    '--request',
    sequenceRequest(fixture, drill),
  ];
}

function completeArgs(
  fixture: Fixture,
  drill: string,
  receipt: ReturnType<typeof readinessFixture>,
) {
  return [
    'complete',
    '--plan',
    fixture.planPath,
    '--request',
    sequenceRequest(fixture, drill),
    '--readiness',
    receipt.readinessPath,
    '--evidence-dir',
    receipt.evidenceDirectory,
  ];
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('rollback-drill KVM readiness sequence', () => {
  it('accepts the exact receipt emitted by the real provision producer in both consumers', () => {
    const fixture = createFixture();
    const producer = readFileSync(
      path.resolve('scripts/rollback-drill-vm-provision.sh'),
      'utf8',
    );
    const setHelperStart = producer.indexOf('derive_set_id() {');
    const setHelperEnd = producer.indexOf(
      '\n# END nexus.rollback-drill-vm-set-id.v2',
      setHelperStart,
    );
    const receiptBlock = producer.indexOf(
      'receipt="$set_stage/receipt.json"',
    );
    const pythonStart = producer.indexOf('import hashlib\n', receiptBlock);
    const pythonEnd = producer.indexOf('\nPY\nlayout_trust=', pythonStart);
    expect(receiptBlock).toBeGreaterThan(0);
    expect(setHelperStart).toBeGreaterThan(0);
    expect(setHelperEnd).toBeGreaterThan(setHelperStart);
    expect(pythonStart).toBeGreaterThan(receiptBlock);
    expect(pythonEnd).toBeGreaterThan(pythonStart);
    const setHelper = producer.slice(setHelperStart, setHelperEnd);
    const producerProgram = producer.slice(pythonStart, pythonEnd);
    const records = path.join(fixture.root, 'producer-guest-records.tsv');
    privateFile(
      records,
      `${fixture.provision.guests.map((guest: any) => [
        guest.name,
        guest.port,
        guest.uuid,
        guest.mac,
        guest.instanceId,
        guest.seedSha256,
        guest.overlayInitialSha256,
        guest.hostKeyFingerprint,
        guest.hostPublicKeySha256,
        guest.hostPublicKey,
      ].join('\t')).join('\n')}\n`,
    );
    const hypervisor = fixture.provision.hypervisor;
    const setIdentity = spawnSync(
      '/bin/bash',
      [
        '-c',
        `${setHelper}\nderive_set_id "$@"`,
        'nexus-rollback-drill-set-id',
        fixture.provision.image.sha256,
        fixture.provision.sshPublicKeySha256,
        fixture.provision.guestSshHostPublicKeySha256s.join(','),
        ...fixture.provision.ports.map(String),
        hypervisor.runnerSha256,
        hypervisor.hostPreflightSha256,
        hypervisor.runtimeManifestSha256,
        hypervisor.runtimeControlSha256,
        hypervisor.runtimeReadinessSha256,
        hypervisor.runtimeRecoveryUnitSha256,
        hypervisor.faultDrillControllerSha256,
        hypervisor.faultDrillControllerUnitSha256,
        hypervisor.faultDrillControllerRecoveryUnitSha256,
        hypervisor.faultDrillGuestExecutorSha256,
        hypervisor.faultDrillGuestRecoveryUnitSha256,
        hypervisor.faultDrillVerifierSha256,
        hypervisor.unitSha256,
        hypervisor.qemuSha256,
        hypervisor.qemuVersion,
        hypervisor.qemuPackage,
        hypervisor.qemuPackageVersion,
        hypervisor.qemuPackageArchitecture,
      ],
      { encoding: 'utf8' },
    );
    expect(setIdentity.status, setIdentity.stderr).toBe(0);
    const producerSetId = setIdentity.stdout.trim();
    expect(producerSetId).toMatch(/^[0-9a-f]{64}$/u);
    expect(producerSetId).toBe(fixture.provision.setId);
    const produced = spawnSync(
      '/usr/bin/python3',
      [
        '-c',
        producerProgram,
        fixture.provisionPath,
        producerSetId,
        fixture.provision.image.sha256,
        fixture.provision.sshPublicKeySha256,
        ...fixture.provision.ports.map(String),
        `/var/lib/nexus-rollback-drill-vm/sets/${producerSetId}`,
        records,
        fixture.provision.createdAt,
        hypervisor.runnerSha256,
        hypervisor.hostPreflightSha256,
        hypervisor.runtimeManifestSha256,
        hypervisor.runtimeControlSha256,
        hypervisor.runtimeReadinessSha256,
        hypervisor.runtimeRecoveryUnitSha256,
        hypervisor.faultDrillControllerSha256,
        hypervisor.faultDrillControllerUnitSha256,
        hypervisor.faultDrillControllerRecoveryUnitSha256,
        hypervisor.faultDrillGuestExecutorSha256,
        hypervisor.faultDrillGuestRecoveryUnitSha256,
        hypervisor.faultDrillVerifierSha256,
        hypervisor.unitSha256,
        hypervisor.qemuSha256,
        hypervisor.qemuVersion,
        hypervisor.qemuPackage,
        hypervisor.qemuPackageVersion,
        hypervisor.qemuPackageArchitecture,
      ],
      { encoding: 'utf8' },
    );
    expect(produced.status, produced.stderr).toBe(0);

    const producedBody = readFileSync(fixture.provisionPath);
    const producedReceipt = JSON.parse(producedBody.toString('utf8'));
    expect(() => validateProvisionReceipt(producedReceipt)).not.toThrow();
    fixture.provision = producedReceipt;
    fixture.provisionBody = producedBody;
    const provisionSha256 = digest(producedBody);
    for (const [index, binding] of bindings.entries()) {
      const authorization = fixture.runtime[binding.drill];
      authorization.payload.setId = producedReceipt.setId;
      authorization.payload.provisionReceiptSha256 = provisionSha256;
      authorization.body = Buffer.from(canonicalJson(authorization.payload));
      authorization.signature = cryptoSign(
        null,
        authorization.body,
        fixture.guestOwner.privateKey,
      );
      privateFile(
        path.join(fixture.runtimeDirectory, `${binding.drill}.json`),
        authorization.body,
      );
      privateFile(
        path.join(fixture.runtimeDirectory, `${binding.drill}.sig`),
        authorization.signature,
      );
      fixture.generation.runtimeAuthorizations[index].payloadSha256 =
        digest(authorization.body);
    }
    fixture.generation.provisionReceiptSha256 = provisionSha256;
    privateFile(
      fixture.generationPath,
      canonicalJson(fixture.generation),
    );

    const initialized = run(fixture, initArgs(fixture));
    expect(initialized.result.status, initialized.result.stderr).toBe(0);
    expect(initialized.body.status).toBe('initialized_inactive');
  });

  it('admits and completes only the fixed guest order with one active request', () => {
    const fixture = createFixture();
    expect(new Set(fixture.generation.runtimeAuthorizations.map(
      (entry: any) => entry.bundleManifestSha256,
    )).size).toBe(1);
    expect(new Set(Object.values(fixture.runtime).map(
      (entry) => entry.payload.authorizationId,
    )).size).toBe(3);
    const initialized = run(fixture, initArgs(fixture));
    expect(initialized.result.status, initialized.result.stderr).toBe(0);
    expect(initialized.body).toMatchObject({
      status: 'initialized_inactive',
      next: { drill: 'ssh-loss', guest: 'guest-1' },
      actionsPerformed: [],
    });

    const firstClaim = run(fixture, claimArgs(fixture, 'ssh-loss'));
    expect(firstClaim.result.status, firstClaim.result.stderr).toBe(0);
    expect(firstClaim.body).toMatchObject({
      status: 'active_request_checkpointed',
      active: { drill: 'ssh-loss', guest: 'guest-1' },
      actionsPerformed: [],
    });
    const resumedClaim = run(fixture, claimArgs(fixture, 'ssh-loss'));
    expect(resumedClaim.result.status, resumedClaim.result.stderr).toBe(0);
    expect(resumedClaim.body).toMatchObject({
      status: 'active_resume_required',
      alreadyClaimed: true,
    });

    const secondWhileActive = run(
      fixture,
      claimArgs(fixture, 'failed-health'),
    );
    expect(secondWhileActive.result.status).not.toBe(0);
    expect(secondWhileActive.body.code).toBe('another_guest_active');
    const activeStatus = run(fixture, ['status', '--plan', fixture.planPath]);
    expect(activeStatus.body).toMatchObject({
      status: 'active_resume_required',
      nextIndex: 0,
      active: { guest: 'guest-1' },
      guests: [
        { guest: 'guest-1', status: 'active' },
        { guest: 'guest-2', status: 'pending' },
        { guest: 'guest-3', status: 'pending' },
      ],
    });

    let finalReceipt: ReturnType<typeof readinessFixture> | null = null;
    for (const [index, binding] of bindings.entries()) {
      if (index > 0) {
        const claimed = run(
          fixture,
          claimArgs(fixture, binding.drill),
          { now: NOW + index * 60_000 },
        );
        expect(claimed.result.status, claimed.result.stderr).toBe(0);
      }
      const receipt = readinessFixture(fixture, index);
      if (index === bindings.length - 1) finalReceipt = receipt;
      const completed = run(
        fixture,
        completeArgs(fixture, binding.drill, receipt),
        { now: NOW + index * 60_000 + 30_000 },
      );
      expect(completed.result.status, completed.result.stderr).toBe(0);
      expect(completed.body).toMatchObject({
        drill: binding.drill,
        guest: binding.guest,
        alreadyComplete: false,
        actionsPerformed: [],
      });
    }
    const done = run(
      fixture,
      ['status', '--plan', fixture.planPath],
      { now: NOW + 150_000 },
    );
    expect(done.result.status, done.result.stderr).toBe(0);
    expect(done.body).toMatchObject({
      status: 'all_runtime_readiness_complete',
      nextIndex: 3,
      active: null,
      next: null,
      guests: bindings.map((binding) => ({
        drill: binding.drill,
        guest: binding.guest,
        status: 'complete',
      })),
      completedLedger: {
        attestation: {
          schema: 'nexus.rollback-drill-kvm-readiness-ledger.v1',
          status: 'all_runtime_readiness_complete',
          controllerBootIdSha256:
            fixture.plan.controller.bootIdSha256,
          generationManifestSha256:
            digest(readFileSync(fixture.generationPath)),
          provisionReceiptSha256:
            digest(readFileSync(fixture.provisionPath)),
          orderedReadiness: bindings.map((binding) => ({
            drill: binding.drill,
            runtimeDrill: binding.runtimeDrill,
            guest: binding.guest,
          })),
        },
      },
    });
    expect(readFileSync(
      done.body.completedLedger.path,
      'utf8',
    )).toBe(canonicalJson(done.body.completedLedger.attestation));

    rmSync(done.body.completedLedger.path);
    const repaired = run(
      fixture,
      completeArgs(
        fixture,
        bindings.at(-1)!.drill,
        finalReceipt!,
      ),
      { now: NOW + 150_000 },
    );
    expect(repaired.result.status, repaired.result.stderr).toBe(0);
    expect(repaired.body).toMatchObject({
      status: 'readiness_already_complete',
      alreadyComplete: true,
      completedLedger: {
        sha256: done.body.completedLedger.sha256,
      },
    });
    expect(readFileSync(
      repaired.body.completedLedger.path,
      'utf8',
    )).toBe(canonicalJson(repaired.body.completedLedger.attestation));

    const replay = run(
      fixture,
      claimArgs(fixture, 'ssh-loss'),
      { now: NOW + 150_000 },
    );
    expect(replay.result.status).not.toBe(0);
    expect(replay.body.code).toBe('request_replay_rejected');
  });

  it('resumes after interruption without clearing or duplicating the active guest', () => {
    const fixture = createFixture();
    expect(run(fixture, initArgs(fixture)).result.status).toBe(0);
    expect(run(fixture, claimArgs(fixture, 'ssh-loss')).result.status).toBe(0);
    const receipt = readinessFixture(fixture, 0);
    const interrupted = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', receipt),
      { now: NOW + 30_000, interruptAfterReceipt: true },
    );
    expect(interrupted.result.status).not.toBe(0);
    expect(interrupted.body.code).toBe(
      'test_interrupted_after_receipt_publish',
    );
    const afterInterruption = run(
      fixture,
      ['status', '--plan', fixture.planPath],
    );
    expect(afterInterruption.result.status, afterInterruption.result.stderr)
      .toBe(0);
    expect(afterInterruption.body).toMatchObject({
      status: 'active_resume_required',
      active: { guest: 'guest-1' },
      nextIndex: 0,
    });
    const resumed = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', receipt),
      { now: NOW + 30_000 },
    );
    expect(resumed.result.status, resumed.result.stderr).toBe(0);
    expect(resumed.body).toMatchObject({
      status: 'runtime_readiness_complete',
      next: { guest: 'guest-2' },
    });
    const idempotent = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', receipt),
      { now: NOW + 30_000 },
    );
    expect(idempotent.result.status, idempotent.result.stderr).toBe(0);
    expect(idempotent.body).toMatchObject({
      status: 'readiness_already_complete',
      alreadyComplete: true,
    });
  });

  it('rejects generation input with guest-specific runtime bundles', () => {
    const fixture = createFixture();
    fixture.generation.runtimeAuthorizations[1].bundleManifestSha256 =
      digest('guest-specific-runtime-bundle');
    privateFile(
      fixture.generationPath,
      canonicalJson(fixture.generation),
    );

    const rejected = run(fixture, initArgs(fixture));
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.body.code).toBe(
      'generation_bundle_manifests_must_share_provision_set',
    );
  });

  it('fails closed across controller reboot and wall-clock rollback', () => {
    const rebooted = createFixture();
    const changedBoot = run(
      rebooted,
      initArgs(rebooted),
      { extraEnv: { [BOOT_ID_ENV]: 'different-controller-boot' } },
    );
    expect(changedBoot.result.status).not.toBe(0);
    expect(changedBoot.body.code).toBe('controller_boot_changed');

    const rollback = createFixture();
    expect(run(rollback, initArgs(rollback)).result.status).toBe(0);
    expect(run(rollback, claimArgs(rollback, 'ssh-loss')).result.status)
      .toBe(0);
    const wallClockRollback = run(
      rollback,
      claimArgs(rollback, 'ssh-loss'),
      {
        now: NOW - 30_000,
        extraEnv: {
          [UPTIME_ENV]: String(
            rollback.controllerUptimeSeconds + 3 * 60 * 60,
          ),
        },
      },
    );
    expect(wallClockRollback.result.status).not.toBe(0);
    expect(wallClockRollback.body.code).toBe(
      'sequence_clock_rollback_detected',
    );

    const monotonicReplay = run(
      rollback,
      ['status', '--plan', rollback.planPath],
      {
        extraEnv: {
          [UPTIME_ENV]: String(
            rollback.controllerUptimeSeconds - 1,
          ),
        },
      },
    );
    expect(monotonicReplay.result.status).not.toBe(0);
    expect(monotonicReplay.body.code).toBe(
      'sequence_state_monotonic_window_invalid',
    );
  });

  it('rejects reinitialization, wrong order, cross-guest tuples, nonce drift, and bad signatures', () => {
    const fixture = createFixture();
    expect(run(fixture, initArgs(fixture)).result.status).toBe(0);
    const reinitialized = run(fixture, initArgs(fixture));
    expect(reinitialized.result.status).not.toBe(0);
    expect(reinitialized.body.code).toBe('sequence_already_exists');

    const outOfOrder = run(fixture, claimArgs(fixture, 'guest-reboot'));
    expect(outOfOrder.result.status).not.toBe(0);
    expect(outOfOrder.body.code).toBe('request_out_of_order');
    expect(run(fixture, claimArgs(fixture, 'ssh-loss')).result.status).toBe(0);
    const secondActive = run(fixture, claimArgs(fixture, 'failed-health'));
    expect(secondActive.result.status).not.toBe(0);
    expect(secondActive.body.code).toBe('another_guest_active');

    const crossGuest = readinessFixture(fixture, 0);
    crossGuest.readiness.guest = 'guest-2';
    privateFile(
      crossGuest.readinessPath,
      canonicalJson(crossGuest.readiness),
    );
    const rejectedCrossGuest = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', crossGuest),
    );
    expect(rejectedCrossGuest.result.status).not.toBe(0);
    expect(rejectedCrossGuest.body.code).toBe('readiness_binding_invalid');

    crossGuest.readiness.guest = 'guest-1';
    crossGuest.readiness.stoppedGuestProof.handoffNonce =
      digest('wrong-nonce');
    privateFile(
      crossGuest.readinessPath,
      canonicalJson(crossGuest.readiness),
    );
    const rejectedNonce = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', crossGuest),
    );
    expect(rejectedNonce.result.status).not.toBe(0);
    expect(rejectedNonce.body.code).toBe('readiness_binding_invalid');

    crossGuest.readiness.stoppedGuestProof.handoffNonce =
      crossGuest.journal.nonce;
    privateFile(
      crossGuest.readinessPath,
      canonicalJson(crossGuest.readiness),
    );
    const measurementSignature = path.join(
      crossGuest.evidenceDirectory,
      'measurement.sig',
    );
    const tamperedSignature = Buffer.from(readFileSync(measurementSignature));
    tamperedSignature[10] ^= 0xff;
    privateFile(measurementSignature, tamperedSignature);
    const rejectedSignature = run(
      fixture,
      completeArgs(fixture, 'ssh-loss', crossGuest),
    );
    expect(rejectedSignature.result.status).not.toBe(0);
    expect(rejectedSignature.body.code).toBe(
      'guest_measurement_signature_invalid',
    );
  });

  it('rejects an ambiguous authorization directory and a signed cross-guest authorization tuple', () => {
    const fixture = createFixture();
    const unexpected = path.join(fixture.runtimeDirectory, 'unexpected.json');
    privateFile(unexpected, '{}');
    const ambiguous = run(fixture, initArgs(fixture));
    expect(ambiguous.result.status).not.toBe(0);
    expect(ambiguous.body.code).toBe(
      'runtime_authorization_directory_layout_invalid',
    );
    rmSync(unexpected);

    privateFile(
      path.join(fixture.runtimeDirectory, 'ssh-loss.json'),
      fixture.runtime['failed-health'].body,
    );
    privateFile(
      path.join(fixture.runtimeDirectory, 'ssh-loss.sig'),
      fixture.runtime['failed-health'].signature,
    );
    const crossGuestAuthorization = run(fixture, initArgs(fixture));
    expect(crossGuestAuthorization.result.status).not.toBe(0);
    expect(crossGuestAuthorization.body.code).toBe(
      'runtime_authorization_binding_invalid:ssh-loss',
    );
  });

  it('rejects reused guest host keys and cross-slot host identities in the provision receipt', () => {
    const reused = createFixture();
    reused.provision.guestSshHostPublicKeySha256s[1] =
      reused.provision.guestSshHostPublicKeySha256s[0];
    reused.provision.guests[1].hostPublicKey =
      reused.provision.guests[0].hostPublicKey;
    reused.provision.guests[1].hostPublicKeySha256 =
      reused.provision.guests[0].hostPublicKeySha256;
    reused.provision.guests[1].hostKeyFingerprint =
      reused.provision.guests[0].hostKeyFingerprint;
    privateFile(reused.provisionPath, canonicalJson(reused.provision));
    const rejectedReuse = run(reused, initArgs(reused));
    expect(rejectedReuse.result.status).not.toBe(0);
    expect(rejectedReuse.body.code).toBe('provision_invalid');

    const crossSlot = createFixture();
    crossSlot.provision.guests[1].hostPublicKey =
      crossSlot.provision.guests[0].hostPublicKey;
    crossSlot.provision.guests[1].hostPublicKeySha256 =
      crossSlot.provision.guests[0].hostPublicKeySha256;
    crossSlot.provision.guests[1].hostKeyFingerprint =
      crossSlot.provision.guests[0].hostKeyFingerprint;
    privateFile(
      crossSlot.provisionPath,
      canonicalJson(crossSlot.provision),
    );
    const rejectedCrossSlot = run(crossSlot, initArgs(crossSlot));
    expect(rejectedCrossSlot.result.status).not.toBe(0);
    expect(rejectedCrossSlot.body.code).toBe(
      'provision_guest_binding_invalid',
    );
  });

  it('rejects unknown nested provision fields, QEMU policy drift, and set-identity drift', () => {
    const unknownField = createFixture();
    (unknownField.provision.hypervisor as any).unreviewed = true;
    privateFile(
      unknownField.provisionPath,
      canonicalJson(unknownField.provision),
    );
    const rejectedUnknown = run(unknownField, initArgs(unknownField));
    expect(rejectedUnknown.result.status).not.toBe(0);
    expect(rejectedUnknown.body.code).toBe(
      'provision_hypervisor_fields_invalid',
    );

    const qemuDrift = createFixture();
    qemuDrift.provision.hypervisor.qemuBinary = '/tmp/forged-qemu';
    privateFile(
      qemuDrift.provisionPath,
      canonicalJson(qemuDrift.provision),
    );
    const rejectedQemu = run(qemuDrift, initArgs(qemuDrift));
    expect(rejectedQemu.result.status).not.toBe(0);
    expect(rejectedQemu.body.code).toBe(
      'provision_hypervisor_binding_invalid:qemuBinary',
    );

    const setIdentityDrift = createFixture();
    setIdentityDrift.provision.hypervisor.qemuSha256 =
      digest('different-qemu-binary');
    privateFile(
      setIdentityDrift.provisionPath,
      canonicalJson(setIdentityDrift.provision),
    );
    const rejectedSetIdentity = run(
      setIdentityDrift,
      initArgs(setIdentityDrift),
    );
    expect(rejectedSetIdentity.result.status).not.toBe(0);
    expect(rejectedSetIdentity.body.code).toBe(
      'provision_set_identity_invalid',
    );
  });

  it('rejects future generation and signed authorization timestamps outside their monotonic window', () => {
    const futureGeneration = createFixture();
    futureGeneration.generation.generatedAt = iso(
      NOW + 5 * 60_000 + 1_000,
    );
    privateFile(
      futureGeneration.generationPath,
      canonicalJson(futureGeneration.generation),
    );
    const rejectedGeneration = run(
      futureGeneration,
      initArgs(futureGeneration),
    );
    expect(rejectedGeneration.result.status).not.toBe(0);
    expect(rejectedGeneration.body.code).toBe(
      'generation_timestamp_binding_invalid',
    );

    const beforeGeneration = createFixture();
    rewriteAuthorization(
      beforeGeneration,
      0,
      {
        issuedAt: NOW - 31_000,
        expiresAt: NOW + 60 * 60_000,
      },
    );
    const rejectedBeforeGeneration = run(
      beforeGeneration,
      initArgs(beforeGeneration),
    );
    expect(rejectedBeforeGeneration.result.status).not.toBe(0);
    expect(rejectedBeforeGeneration.body.code).toBe(
      'runtime_authorization_binding_invalid:ssh-loss',
    );

    const futureAuthorization = createFixture();
    rewriteAuthorization(
      futureAuthorization,
      0,
      {
        issuedAt: NOW + 5 * 60_000 + 1_000,
        expiresAt: NOW + 60 * 60_000,
      },
    );
    const rejectedFutureAuthorization = run(
      futureAuthorization,
      initArgs(futureAuthorization),
    );
    expect(rejectedFutureAuthorization.result.status).not.toBe(0);
    expect(rejectedFutureAuthorization.body.code).toBe(
      'runtime_authorization_binding_invalid:ssh-loss',
    );
  });

  it('rejects future or nonmonotonic readiness evidence and state timestamps', () => {
    const futureEvidence = createFixture();
    expect(run(futureEvidence, initArgs(futureEvidence)).result.status)
      .toBe(0);
    expect(
      run(futureEvidence, claimArgs(futureEvidence, 'ssh-loss')).result.status,
    ).toBe(0);
    const futureReceipt = readinessFixture(futureEvidence, 0);
    futureReceipt.measurement.capturedAt = iso(
      NOW + 5 * 60_000 + 1_000,
    );
    futureReceipt.readiness.sealedAt = iso(
      NOW + 5 * 60_000 + 2_000,
    );
    resignMeasurement(futureEvidence, 0, futureReceipt);
    const rejectedFutureEvidence = run(
      futureEvidence,
      completeArgs(futureEvidence, 'ssh-loss', futureReceipt),
    );
    expect(rejectedFutureEvidence.result.status).not.toBe(0);
    expect(rejectedFutureEvidence.body.code).toBe(
      'receipt_measurement_timestamp_binding_invalid',
    );

    const reverseSeal = createFixture();
    expect(run(reverseSeal, initArgs(reverseSeal)).result.status).toBe(0);
    expect(run(reverseSeal, claimArgs(reverseSeal, 'ssh-loss')).result.status)
      .toBe(0);
    const reverseReceipt = readinessFixture(reverseSeal, 0);
    reverseReceipt.readiness.sealedAt = iso(NOW - 1_000);
    privateFile(
      reverseReceipt.readinessPath,
      canonicalJson(reverseReceipt.readiness),
    );
    const rejectedReverseSeal = run(
      reverseSeal,
      completeArgs(reverseSeal, 'ssh-loss', reverseReceipt),
    );
    expect(rejectedReverseSeal.result.status).not.toBe(0);
    expect(rejectedReverseSeal.body.code).toBe(
      'readiness_sealed_at_binding_invalid',
    );

    const nonmonotonicState = createFixture();
    expect(run(nonmonotonicState, initArgs(nonmonotonicState)).result.status)
      .toBe(0);
    const statePath = path.join(
      nonmonotonicState.stateRoot,
      digest(nonmonotonicState.planBody),
      'state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.updatedAt = iso(Date.parse(state.createdAt) - 1_000);
    privateFile(statePath, canonicalJson(state));
    const rejectedState = run(
      nonmonotonicState,
      ['status', '--plan', nonmonotonicState.planPath],
    );
    expect(rejectedState.result.status).not.toBe(0);
    expect(rejectedState.body.code).toBe(
      'sequence_state_timestamp_binding_invalid',
    );
  });

  it('rejects mutually forged QEMU evidence and a measurement signed by the wrong guest key', () => {
    const forgedQemu = createFixture();
    expect(run(forgedQemu, initArgs(forgedQemu)).result.status).toBe(0);
    expect(run(forgedQemu, claimArgs(forgedQemu, 'ssh-loss')).result.status)
      .toBe(0);
    const forgedQemuReceipt = readinessFixture(forgedQemu, 0);
    const forgedQemuDigest = digest('unprovisioned-qemu-binary');
    forgedQemuReceipt.liveQemu.qemuExecutableSha256 = forgedQemuDigest;
    forgedQemuReceipt.readiness.qemu.executableSha256 = forgedQemuDigest;
    privateFile(
      forgedQemuReceipt.liveQemuPath,
      canonicalJson(forgedQemuReceipt.liveQemu),
    );
    privateFile(
      forgedQemuReceipt.readinessPath,
      canonicalJson(forgedQemuReceipt.readiness),
    );
    const rejectedQemu = run(
      forgedQemu,
      completeArgs(forgedQemu, 'ssh-loss', forgedQemuReceipt),
    );
    expect(rejectedQemu.result.status).not.toBe(0);
    expect(rejectedQemu.body.code).toBe(
      'receipt_live_qemu_binding_invalid',
    );

    const wrongGuestSigner = createFixture();
    expect(run(wrongGuestSigner, initArgs(wrongGuestSigner)).result.status)
      .toBe(0);
    expect(
      run(
        wrongGuestSigner,
        claimArgs(wrongGuestSigner, 'ssh-loss'),
      ).result.status,
    ).toBe(0);
    const wrongSignerReceipt = readinessFixture(wrongGuestSigner, 0);
    resignMeasurement(wrongGuestSigner, 0, wrongSignerReceipt, 1);
    const rejectedSigner = run(
      wrongGuestSigner,
      completeArgs(wrongGuestSigner, 'ssh-loss', wrongSignerReceipt),
    );
    expect(rejectedSigner.result.status).not.toBe(0);
    expect(rejectedSigner.body.code).toBe(
      'guest_measurement_signature_invalid',
    );
  });

  it('uses one fixed non-waiting lock and rejects a forged inner handoff', async () => {
    const fixture = createFixture();
    expect(run(fixture, initArgs(fixture)).result.status).toBe(0);
    const lockPath = path.join(fixture.stateRoot, 'control.lock');
    const holder = spawn(
      '/usr/bin/python3',
      [
        '-c',
        [
          'import fcntl,os,sys,time',
          'fd=os.open(sys.argv[1],os.O_RDWR)',
          'fcntl.flock(fd,fcntl.LOCK_EX)',
          'print("ready",flush=True)',
          'time.sleep(30)',
        ].join(';'),
        lockPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(holder.stdout!, 'data');
    try {
      const contended = run(
        fixture,
        ['status', '--plan', fixture.planPath],
      );
      expect(contended.result.status).not.toBe(0);
      expect(contended.body.code).toBe('control_lock_contended');
    } finally {
      holder.kill('SIGTERM');
      await once(holder, 'exit');
    }

    const forged = run(
      fixture,
      ['status', '--plan', fixture.planPath],
      { extraEnv: { [LOCK_HELD_ENV]: '1' } },
    );
    expect(forged.result.status).not.toBe(0);
    expect(forged.body.code).toBe('control_lock_handoff_invalid');
  });

  it('rejects stale new and active claims at the monotonic deadline', () => {
    const staleFixture = createFixture();
    expect(run(staleFixture, initArgs(staleFixture)).result.status).toBe(0);
    const afterExpiry = NOW + 7 * 60 * 60 * 1000;
    const stale = run(
      staleFixture,
      claimArgs(staleFixture, 'ssh-loss'),
      { now: afterExpiry },
    );
    expect(stale.result.status).not.toBe(0);
    expect(stale.body.code).toBe('request_stale');

    const activeFixture = createFixture();
    expect(run(activeFixture, initArgs(activeFixture)).result.status).toBe(0);
    expect(run(activeFixture, claimArgs(activeFixture, 'ssh-loss')).result.status)
      .toBe(0);
    const clockRollback = run(
      activeFixture,
      claimArgs(activeFixture, 'ssh-loss'),
      { now: NOW - 1_000 },
    );
    expect(clockRollback.result.status).not.toBe(0);
    expect(clockRollback.body.code).toBe(
      'sequence_state_monotonic_window_invalid',
    );
    const resumed = run(
      activeFixture,
      claimArgs(activeFixture, 'ssh-loss'),
      { now: afterExpiry },
    );
    expect(resumed.result.status).not.toBe(0);
    expect(resumed.body.code).toBe('request_stale');
  });
});
