import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalJson,
  sha256Bytes,
  validateIsolationEvidence,
  validateOwnerAuthorization,
  validatePlan,
} from '../../scripts/lib/rollback-drill-kvm-evidence.mjs';

const generator = path.resolve('scripts/rollback-drill-kvm-inputs.mjs');
const readinessSequence = path.resolve(
  'scripts/rollback-drill-kvm-readiness-sequence.mjs',
);
const promotionAuthorization = path.resolve('scripts/promotion-authorization.mjs');
const digest = (value: string | Buffer) => (
  createHash('sha256').update(value).digest('hex')
);

function deterministicSshEd25519PublicKey(label: string, comment: string) {
  const algorithm = Buffer.from('ssh-ed25519', 'ascii');
  const key = createHash('sha256').update(label).digest();
  const material = Buffer.alloc(4 + algorithm.length + 4 + key.length);
  material.writeUInt32BE(algorithm.length, 0);
  algorithm.copy(material, 4);
  material.writeUInt32BE(key.length, 4 + algorithm.length);
  key.copy(material, 8 + algorithm.length);
  return `ssh-ed25519 ${material.toString('base64')} ${comment}`;
}

function sshFingerprint(publicKey: string) {
  const encoded = publicKey.split(' ')[1];
  return `SHA256:${createHash('sha256')
    .update(Buffer.from(encoded, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function runGenerator(
  args: string[],
  nowMs: number,
) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEXUS_ROLLBACK_DRILL_INPUTS_TEST_NOW: String(nowMs),
    },
  });
}

function runReadinessSequence(
  args: string[],
  stateRoot: string,
  nowMs: number,
  {
    bootId = 'serverdominguez-boot-id',
    uptimeSeconds = 100_000,
  } = {},
) {
  return spawnSync(process.execPath, [readinessSequence, ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEXUS_KVM_READINESS_SEQUENCE_TEST_STATE_ROOT: stateRoot,
      NEXUS_KVM_READINESS_SEQUENCE_TEST_NOW: String(nowMs),
      NEXUS_KVM_READINESS_SEQUENCE_TEST_BOOT_ID: bootId,
      NEXUS_KVM_READINESS_SEQUENCE_TEST_UPTIME_SECONDS:
        String(uptimeSeconds),
    },
  });
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

function writeText(file: string, value: string | Buffer) {
  fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
}

function makeInputs(root: string, nowMs: number) {
  const guestOwner = generateKeyPairSync('ed25519');
  const productionOwner = generateKeyPairSync('ed25519');
  const releaseEvidence = generateKeyPairSync('ed25519');
  const guestOwnerPublic = guestOwner.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const productionOwnerPublic = productionOwner.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const releaseEvidencePublic = releaseEvidence.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const guestSshClient = deterministicSshEd25519PublicKey(
    'drill-client',
    'drill@guest',
  );
  const productionSshClient = deterministicSshEd25519PublicKey(
    'production-client',
    'prod@server',
  );
  const guestSshHosts = [1, 2, 3].map((index) => (
    deterministicSshEd25519PublicKey(
      `drill-host-${index}`,
      `root@guest-${index}`,
    )
  ));
  const productionSshHost = deterministicSshEd25519PublicKey(
    'production-host',
    'root@server',
  );
  const files: Record<string, string | Buffer> = {
    'guest-owner.pem': guestOwnerPublic,
    'production-owner.pem': productionOwnerPublic,
    'release-evidence.pem': releaseEvidencePublic,
    'guest-ssh-client.pub': guestSshClient,
    'production-ssh-client.pub': productionSshClient,
    'guest-1-ssh-host.pub': guestSshHosts[0],
    'guest-2-ssh-host.pub': guestSshHosts[1],
    'guest-3-ssh-host.pub': guestSshHosts[2],
    'production-ssh-host.pub': productionSshHost,
    'controller-machine-id': 'serverdominguez-machine-id\n',
    'controller-boot-id': 'serverdominguez-boot-id\n',
    'controller-uptime': '100000.00 200000.00\n',
    'synthetic.seed': 'synthetic-only-seed\n',
    'ssh-loss.runtime-manifest.json': '{"bundle":"ssh-loss"}\n',
    'failed-health.runtime-manifest.json': '{"bundle":"failed-health"}\n',
    'guest-reboot.runtime-manifest.json': '{"bundle":"guest-reboot"}\n',
  };
  for (const [name, body] of Object.entries(files)) {
    writeText(path.join(root, name), body);
  }

  const ports = [22991, 22992, 22993];
  const overlayDigests = [
    digest('ssh-loss-overlay'),
    digest('failed-health-overlay'),
    digest('guest-reboot-overlay'),
  ];
  const uuids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];
  const normalizedGuestHosts = guestSshHosts.map(
    (key) => key.split(/\s+/u).slice(0, 2).join(' '),
  );
  const imageSha256 = digest('noble-base');
  const sshPublicKeySha256 = sha256Bytes(Buffer.from(
    guestSshClient.split(/\s+/u).slice(0, 2).join(' '),
    'utf8',
  ));
  const guestSshHostPublicKeySha256s = normalizedGuestHosts.map(
    (key) => sha256Bytes(Buffer.from(key, 'utf8')),
  );
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
    `image=${imageSha256}`,
    `key=${sshPublicKeySha256}`,
    `hostKeys=${guestSshHostPublicKeySha256s.join(',')}`,
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
  const setDirectory = `/var/lib/nexus-rollback-drill-vm/sets/${setId}`;
  const provision = {
    schema: 'nexus.rollback-drill-vm-provision.v2',
    setId,
    image: {
      filename: 'noble-server-cloudimg-amd64.img',
      sha256: imageSha256,
      basePath:
        `/var/lib/nexus-rollback-drill-vm/base/${imageSha256}.qcow2`,
    },
    sshPublicKeySha256,
    guestSshHostPublicKeySha256s,
    ports,
    setDirectory,
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
    guests: ports.map((port, index) => ({
      name: `guest-${index + 1}`,
      port,
      unit: `nexus-rollback-drill-vm@guest-${index + 1}.service`,
      uuid: uuids[index],
      mac: `52:54:00:00:00:0${index + 1}`,
      instanceId:
        `nexus-rollback-drill-guest-${index + 1}-${setId.slice(0, 16)}`,
      overlayPath:
        `${setDirectory}/guest-${index + 1}/root.qcow2`,
      overlayInitialSha256: overlayDigests[index],
      seedPath:
        `${setDirectory}/guest-${index + 1}/seed.img`,
      seedSha256: digest(`seed-${index + 1}`),
      hostPublicKey: normalizedGuestHosts[index],
      hostPublicKeySha256:
        guestSshHostPublicKeySha256s[index],
      hostKeyFingerprint: sshFingerprint(normalizedGuestHosts[index]),
    })),
    createdAt: new Date(nowMs - 60_000).toISOString(),
  };
  const provisionPath = path.join(root, 'provision.json');
  writeJson(provisionPath, provision);
  const sourceSha = '36b96fab8d0987696ccd7e2ca35a343bca32da2f';
  const targetSha = '3a49f86564f5e9f9523397debb1cf54cecab391c';
  const spec = {
    schema: 'nexus.rollback-drill-kvm-input-spec.v2',
    planLifetimeHours: 24,
    provisionReceipt: 'provision.json',
    controller: {
      machineIdFile: 'controller-machine-id',
      bootIdFile: 'controller-boot-id',
      uptimeFile: 'controller-uptime',
    },
    release: {
      sourceSha,
      targetSha,
      sourceVersion: '4.14.230',
      targetVersion: '4.14.231',
      targetBackup: 'nexus-release-4.14.231.tar.zst',
      preparedRuntimeToken: 'kvmdrill',
      publicBaseUrl: 'https://rollback-drill.invalid',
      predecessor: {
        runtime: '/srv/nexus-release/production/releases/4.14.230-source',
        artifactDigest: digest('predecessor-artifact'),
        installedRuntimeDigest: digest('predecessor-installed'),
      },
      target: {
        runtime: '/srv/nexus-release/production/releases/4.14.231-target',
        artifactDigest: digest('target-artifact'),
        installedRuntimeDigest: digest('target-installed'),
        recoveryRuntimeDigest: digest('target-recovery'),
      },
    },
    keys: {
      guestOwnerPublicKey: 'guest-owner.pem',
      productionOwnerPublicKey: 'production-owner.pem',
      guestSshClientPublicKey: 'guest-ssh-client.pub',
      productionSshClientPublicKey: 'production-ssh-client.pub',
      guestSshHostPublicKeys: {
        'guest-1': 'guest-1-ssh-host.pub',
        'guest-2': 'guest-2-ssh-host.pub',
        'guest-3': 'guest-3-ssh-host.pub',
      },
      productionSshHostPublicKey: 'production-ssh-host.pub',
      releaseEvidencePublicKey: 'release-evidence.pem',
    },
    labStorage: {
      provider: 'aws-s3-lab',
      endpoint: 'https://nexus-drill-lab.s3.eu-west-1.amazonaws.com',
      bucket: 'nexus-drill-lab',
    },
    syntheticDatabase: {
      path: '/srv/nexus-drill-lab/data/synthetic.db',
      seedFile: 'synthetic.seed',
    },
    runtimeBundleManifests: {
      'ssh-loss': 'ssh-loss.runtime-manifest.json',
      'failed-health': 'failed-health.runtime-manifest.json',
      'guest-reboot': 'guest-reboot.runtime-manifest.json',
    },
    releaseEvidence: {
      releaseManifest: 'release-manifest.envelope.json',
      stagingAttestation: 'staging-attestation.envelope.json',
    },
    migration: {
      required: false,
      reviewEvidenceSha256: null,
      policySubjectSha256: null,
      onlineEvidenceSha256: null,
      onlineCloneSha256: null,
      onlineMigratedCloneSha256: null,
      onlinePendingSetSha256: null,
      onlineSourceDatabaseSha256: null,
    },
  };
  const manifestPayload = {
    runtimeSha: targetSha,
    artifact: { digest: spec.release.target.artifactDigest },
  };
  const manifestEnvelope = {
    schema: 'nexus.release-manifest.v2',
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload: manifestPayload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(manifestPayload)),
      releaseEvidence.privateKey,
    ).toString('base64'),
  };
  const manifestBody = `${JSON.stringify(manifestEnvelope, null, 2)}\n`;
  writeText(path.join(root, 'release-manifest.envelope.json'), manifestBody);
  const stagingPayload = {
    requestId: '11111111-1111-4111-8111-111111111111',
    runtimeSha: targetSha,
    artifactDigest: spec.release.target.artifactDigest,
    releaseManifestSha256: digest(manifestBody),
    installedRuntimeDigest: spec.release.target.installedRuntimeDigest,
    recoveryRuntimeDigest: spec.release.target.recoveryRuntimeDigest,
  };
  writeJson(path.join(root, 'staging-attestation.envelope.json'), {
    schema: 'nexus.staging-attestation.v1',
    keyId: 'github-environment-release-signing-2026-07',
    signatureAlgorithm: 'ed25519',
    payload: stagingPayload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(stagingPayload)),
      releaseEvidence.privateKey,
    ).toString('base64'),
  });
  const specPath = path.join(root, 'spec.json');
  writeJson(specPath, spec);
  return {
    guestOwner,
    guestOwnerPublic,
    provision,
    provisionPath,
    spec,
    specPath,
  };
}

function makeReadiness(
  root: string,
  plan: any,
  provision: any,
  generation: any,
  nowMs: number,
) {
  const runtimeDrills = [
    'ssh-disconnect-after-pm2-stop',
    'failed-health-check',
    'host-reboot-during-promotion',
  ];
  return generation.runtimeAuthorizations.map((authorization: any, index: number) => {
    const guest = provision.guests[index];
    const readiness = {
      schema: 'nexus.rollback-drill-vm-runtime-readiness.v2',
      status: 'ready',
      drillReady: true,
      sealedAt: new Date(nowMs + 60_000 + index * 1000).toISOString(),
      setId: provision.setId,
      guest: guest.name,
      port: guest.port,
      provisionReceiptSha256: generation.provisionReceiptSha256,
      bundleManifestSha256: authorization.bundleManifestSha256,
      ownerAuthorization: { drill: runtimeDrills[index] },
      guestMeasurement: {},
      machine: {
        uuid: guest.uuid,
        instanceId: guest.instanceId,
        mac: guest.mac,
        sshHostPublicKeySha256: guest.hostPublicKeySha256,
      },
      qemu: {},
      stoppedGuestProof: {
        qemuExited: true,
        overlayProcessAbsent: true,
      },
      overlay: {
        path: guest.overlayPath,
        initialSha256: guest.overlayInitialSha256,
        currentSha256: digest(`current-overlay-${index + 1}`),
        stableDescriptor: true,
      },
      runtime: {},
      control: {},
      pm2DryHealth: {},
      networkInstallAttempted: false,
    };
    const file = path.join(root, `${plan.overlays[index].drill}.readiness.json`);
    writeJson(file, readiness);
    return file;
  });
}

function makeCompletedReadinessLedger(
  root: string,
  plan: any,
  generationPath: string,
  provisionPath: string,
  readinessFiles: string[],
  nowMs: number,
) {
  const runtimeDrills = [
    'ssh-disconnect-after-pm2-stop',
    'failed-health-check',
    'host-reboot-during-promotion',
  ];
  const completedAt = new Date(nowMs + 90_000).toISOString();
  const ledger = {
    schema: 'nexus.rollback-drill-kvm-readiness-ledger.v1',
    status: 'all_runtime_readiness_complete',
    sequenceId: digest('completed-readiness-sequence'),
    planId: plan.planId,
    planSha256: digest(fs.readFileSync(
      path.join(path.dirname(generationPath), 'plan.json'),
    )),
    generationManifestSha256:
      digest(fs.readFileSync(generationPath)),
    provisionReceiptSha256: digest(fs.readFileSync(provisionPath)),
    guestOwnerPublicKeySha256:
      plan.trust.guestOwnerPublicKeySha256,
    controllerBootIdSha256: plan.controller.bootIdSha256,
    monotonicStartedSeconds: 99_000,
    monotonicDeadlineSeconds: 185_400,
    monotonicCompletedSeconds: 99_900,
    completedAt,
    orderedReadiness: readinessFiles.map((file, index) => ({
      drill: ['ssh-loss', 'failed-health', 'guest-reboot'][index],
      runtimeDrill: runtimeDrills[index],
      guest: `guest-${index + 1}`,
      requestSha256: digest(`readiness-request-${index + 1}`),
      readinessSha256: digest(fs.readFileSync(file)),
      completedAt: new Date(
        nowMs + 30_000 + index * 30_000,
      ).toISOString(),
    })),
    stateSha256: digest('completed-readiness-state'),
  };
  const file = path.join(root, 'completed-readiness-ledger.json');
  writeText(file, canonicalJson(ledger));
  return file;
}

describe('rollback-drill KVM input generator', () => {
  let root: string;
  let nowMs: number;

  beforeEach(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-kvm-inputs-')),
    );
    nowMs = Math.floor(Date.now() / 1000) * 1000;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('generates only unsigned, sequential inputs and seals an independently signed plan authorization', () => {
    const fixture = makeInputs(root, nowMs);
    const prepared = path.join(root, 'prepared');
    const prepare = runGenerator([
      'prepare',
      '--spec', fixture.specPath,
      '--output-dir', prepared,
    ], nowMs);
    expect(prepare.status, prepare.stderr).toBe(0);
    expect(fs.existsSync(path.join(prepared, 'authorization.json'))).toBe(false);
    expect(fs.existsSync(path.join(prepared, 'promotion-requests'))).toBe(false);

    const plan = JSON.parse(fs.readFileSync(
      path.join(prepared, 'plan.json'),
      'utf8',
    ));
    expect(fs.readFileSync(
      path.join(prepared, 'plan.json'),
      'utf8',
    )).toBe(canonicalJson(plan));
    expect(validatePlan(plan, { nowMs })).toBe(plan);
    const generation = JSON.parse(fs.readFileSync(
      path.join(prepared, 'generation-manifest.json'),
      'utf8',
    ));
    expect(fs.readFileSync(
      path.join(prepared, 'generation-manifest.json'),
      'utf8',
    )).toBe(canonicalJson(generation));
    expect(generation.executionMode).toBe('strictly-sequential');
    expect(generation.orderedDrills).toEqual([
      'ssh-loss',
      'failed-health',
      'guest-reboot',
    ]);
    for (const drill of generation.orderedDrills) {
      const body = fs.readFileSync(
        path.join(prepared, 'runtime-authorizations', `${drill}.json`),
        'utf8',
      );
      expect(body.endsWith('\n')).toBe(false);
      expect(JSON.parse(body).operation).toBe('collect-runtime-readiness');
      writeText(
        path.join(
          prepared,
          'runtime-authorizations',
          `${drill}.sig`,
        ),
        cryptoSign(
          null,
          Buffer.from(body),
          fixture.guestOwner.privateKey,
        ),
      );
    }
    const sequenceStateRoot = path.join(root, 'readiness-state');
    const initialized = runReadinessSequence([
      'init',
      '--plan', path.join(prepared, 'plan.json'),
      '--generation-manifest',
      path.join(prepared, 'generation-manifest.json'),
      '--provision-receipt', fixture.provisionPath,
      '--runtime-authorization-dir',
      path.join(prepared, 'runtime-authorizations'),
      '--guest-owner-public-key', path.join(root, 'guest-owner.pem'),
    ], sequenceStateRoot, nowMs);
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      status: 'initialized_inactive',
      planId: plan.planId,
      actionsPerformed: [],
    });

    const readinessFiles = makeReadiness(
      root,
      plan,
      fixture.provision,
      generation,
      nowMs,
    );
    const readinessLedgerPath = makeCompletedReadinessLedger(
      root,
      plan,
      path.join(prepared, 'generation-manifest.json'),
      fixture.provisionPath,
      readinessFiles,
      nowMs,
    );
    const observationPath = path.join(root, 'observation.json');
    const observation = JSON.parse(fs.readFileSync(
      path.join(prepared, 'isolation-observation.template.json'),
      'utf8',
    ));
    observation.capturedAt = new Date(nowMs + 100_000).toISOString();
    observation.guests.forEach((guest: any, index: number) => {
      guest.readinessReceiptSha256 = digest(fs.readFileSync(readinessFiles[index]));
      guest.machineIdSha256 = digest(`guest-${index + 1}-machine-id`);
      guest.readinessBootIdSha256 = digest(`guest-${index + 1}-boot-id`);
    });
    observation.representativeGuest.memoryAvailableBytes = 16 * 1024 ** 3;
    observation.representativeGuest.diskAvailableBytes = 64 * 1024 ** 3;
    observation.representativeGuest.kernelLogReadable = true;
    observation.representativeGuest.mounts = [{
      target: '/',
      source: '/dev/vda2',
      fileSystemType: 'ext4',
      options: ['rw', 'relatime'],
    }];
    observation.representativeGuest.listeners = [
      { host: '127.0.0.1', port: 8200, process: 'nexus-hub' },
      { host: '127.0.0.1', port: 8100, process: 'content-engine' },
      { host: '127.0.0.1', port: 8201, process: 'nexus-hub-staging' },
      { host: '127.0.0.1', port: 8101, process: 'content-engine-staging' },
    ];
    observation.representativeGuest.pm2Apps = [
      'nexus-hub',
      'content-engine',
      'nexus-hub-staging',
      'content-engine-staging',
    ].map((name) => ({ name, status: 'online', restartCount: 0 }));
    observation.representativeGuest.syntheticDatabase.syntheticOnly = true;
    observation.representativeGuest.syntheticDatabase.productionRowsPresent = false;
    observation.representativeGuest.productionDataMatches = [];
    writeJson(observationPath, observation);

    const isolationPath = path.join(root, 'isolation.json');
    const finalized = runGenerator([
      'finalize-isolation',
      '--plan', path.join(prepared, 'plan.json'),
      '--generation-manifest', path.join(prepared, 'generation-manifest.json'),
      '--provision-receipt', fixture.provisionPath,
      '--readiness-ledger', readinessLedgerPath,
      '--observation', observationPath,
      '--ssh-loss-readiness', readinessFiles[0],
      '--failed-health-readiness', readinessFiles[1],
      '--guest-reboot-readiness', readinessFiles[2],
      '--output', isolationPath,
    ], nowMs + 120_000);
    expect(finalized.status, finalized.stderr).toBe(0);
    const isolation = JSON.parse(fs.readFileSync(isolationPath, 'utf8'));
    expect(validateIsolationEvidence(
      isolation,
      plan,
      { nowMs: nowMs + 120_000 },
    )).toBe(isolation);

    const authorizationDirectory = path.join(root, 'authorization-inputs');
    const authorized = runGenerator([
      'authorize',
      '--spec', fixture.specPath,
      '--plan', path.join(prepared, 'plan.json'),
      '--isolation', isolationPath,
      '--output-dir', authorizationDirectory,
    ], nowMs + 120_000);
    expect(authorized.status, authorized.stderr).toBe(0);
    const authorizationManifest = JSON.parse(fs.readFileSync(
      path.join(authorizationDirectory, 'authorization-manifest.json'),
      'utf8',
    ));
    expect(authorizationManifest.executionMode).toBe('strictly-sequential');
    expect(authorizationManifest.promotionRequests.map(
      (entry: any) => entry.drill,
    )).toEqual(['ssh-loss', 'failed-health', 'guest-reboot']);
    for (const drill of authorizationManifest.orderedDrills) {
      const request = path.join(
        authorizationDirectory,
        'promotion-requests',
        `${drill}.request.json`,
      );
      const checked = spawnSync(process.execPath, [
        promotionAuthorization,
        'digest-request',
        '--input',
        request,
      ], { encoding: 'utf8' });
      expect(checked.status, checked.stderr).toBe(0);
      const generatedRequest = JSON.parse(fs.readFileSync(request, 'utf8'));
      const embeddedManifest = JSON.parse(Buffer.from(
        generatedRequest.releaseEvidence.releaseManifestBase64,
        'base64',
      ).toString('utf8'));
      const embeddedStaging = JSON.parse(Buffer.from(
        generatedRequest.releaseEvidence.stagingAttestationBase64,
        'base64',
      ).toString('utf8'));
      expect(embeddedManifest).toMatchObject({
        schema: 'nexus.release-manifest.v2',
        keyId: 'github-environment-release-signing-2026-07',
      });
      expect(embeddedStaging).toMatchObject({
        schema: 'nexus.staging-attestation.v1',
        keyId: 'github-environment-release-signing-2026-07',
        payload: {
          releaseManifestSha256:
            generatedRequest.releaseEvidence.releaseManifestSha256,
        },
      });
    }

    const payloadPath = path.join(
      authorizationDirectory,
      'plan-owner-authorization.payload.json',
    );
    const payloadBytes = fs.readFileSync(payloadPath);
    expect(payloadBytes.toString('utf8')).toBe(
      canonicalJson(JSON.parse(payloadBytes.toString('utf8'))),
    );
    const signaturePath = path.join(root, 'plan-authorization.sig');
    writeText(
      signaturePath,
      cryptoSign(null, payloadBytes, fixture.guestOwner.privateKey),
    );
    const envelopePath = path.join(root, 'plan-authorization.envelope.json');
    const sealed = runGenerator([
      'seal-plan-authorization',
      '--plan', path.join(prepared, 'plan.json'),
      '--isolation', isolationPath,
      '--payload', payloadPath,
      '--signature', signaturePath,
      '--guest-owner-public-key', path.join(root, 'guest-owner.pem'),
      '--output', envelopePath,
    ], nowMs + 120_000);
    expect(sealed.status, sealed.stderr).toBe(0);
    const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    expect(validateOwnerAuthorization(
      envelope,
      plan,
      fixture.guestOwnerPublic,
      {
        nowMs: nowMs + 120_000,
        isolation,
        currentBootIdSha256: plan.controller.bootIdSha256,
        currentMonotonicSeconds: 100_000,
      },
    )).toBe(envelope);
  });

  it('keeps templates and incomplete isolation observations fail closed', () => {
    const templateDirectory = path.join(root, 'template');
    const template = runGenerator([
      'template',
      '--output-dir', templateDirectory,
    ], nowMs);
    expect(template.status, template.stderr).toBe(0);
    const unresolved = JSON.parse(fs.readFileSync(
      path.join(templateDirectory, 'input-spec.template.json'),
      'utf8',
    ));
    expect(JSON.stringify(unresolved)).toContain('__REQUIRED__');

    const fixture = makeInputs(root, nowMs);
    const prepared = path.join(root, 'prepared');
    expect(runGenerator([
      'prepare',
      '--spec', fixture.specPath,
      '--output-dir', prepared,
    ], nowMs).status).toBe(0);
    const plan = JSON.parse(fs.readFileSync(
      path.join(prepared, 'plan.json'),
      'utf8',
    ));
    const generation = JSON.parse(fs.readFileSync(
      path.join(prepared, 'generation-manifest.json'),
      'utf8',
    ));
    const readiness = makeReadiness(
      root,
      plan,
      fixture.provision,
      generation,
      nowMs,
    );
    const readinessLedgerPath = makeCompletedReadinessLedger(
      root,
      plan,
      path.join(prepared, 'generation-manifest.json'),
      fixture.provisionPath,
      readiness,
      nowMs,
    );
    const output = path.join(root, 'must-not-exist.json');
    const failed = runGenerator([
      'finalize-isolation',
      '--plan', path.join(prepared, 'plan.json'),
      '--generation-manifest', path.join(prepared, 'generation-manifest.json'),
      '--provision-receipt', fixture.provisionPath,
      '--readiness-ledger', readinessLedgerPath,
      '--observation',
      path.join(prepared, 'isolation-observation.template.json'),
      '--ssh-loss-readiness', readiness[0],
      '--failed-health-readiness', readiness[1],
      '--guest-reboot-readiness', readiness[2],
      '--output', output,
    ], nowMs + 120_000);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('observation_captured_at_invalid');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('rejects malformed nested provision contracts before creating owner-signable inputs', () => {
    const cases = [
      {
        name: 'reused-host-key',
        expected: 'provision_guest_host_key_reused',
        mutate: (provision: any) => {
          provision.guestSshHostPublicKeySha256s[1] =
            provision.guestSshHostPublicKeySha256s[0];
          provision.guests[1].hostPublicKey =
            provision.guests[0].hostPublicKey;
          provision.guests[1].hostPublicKeySha256 =
            provision.guests[0].hostPublicKeySha256;
          provision.guests[1].hostKeyFingerprint =
            provision.guests[0].hostKeyFingerprint;
        },
      },
      {
        name: 'unknown-hypervisor-field',
        expected: 'provision_hypervisor_fields_invalid',
        mutate: (provision: any) => {
          provision.hypervisor.unreviewed = true;
        },
      },
      {
        name: 'set-identity-drift',
        expected: 'provision_set_identity_invalid',
        mutate: (provision: any) => {
          provision.hypervisor.qemuSha256 = digest('unreviewed-qemu');
        },
      },
      {
        name: 'future-provision',
        expected: 'provision_plan_timestamp_binding_invalid',
        mutate: (provision: any) => {
          provision.createdAt =
            new Date(nowMs + 1_000).toISOString();
        },
      },
    ];
    for (const scenario of cases) {
      const caseRoot = path.join(root, scenario.name);
      fs.mkdirSync(caseRoot, { mode: 0o700 });
      const fixture = makeInputs(caseRoot, nowMs);
      scenario.mutate(fixture.provision);
      fs.writeFileSync(
        fixture.provisionPath,
        `${JSON.stringify(fixture.provision, null, 2)}\n`,
        { mode: 0o600 },
      );
      const output = path.join(caseRoot, 'must-not-exist');
      const rejected = runGenerator([
        'prepare',
        '--spec', fixture.specPath,
        '--output-dir', output,
      ], nowMs);
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stderr).toContain(scenario.expected);
      expect(fs.existsSync(output)).toBe(false);
    }
  });
});
