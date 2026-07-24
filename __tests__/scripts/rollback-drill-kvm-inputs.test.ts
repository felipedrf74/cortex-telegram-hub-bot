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
  const guestSshHost = deterministicSshEd25519PublicKey(
    'drill-host',
    'root@guest',
  );
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
    'guest-ssh-host.pub': guestSshHost,
    'production-ssh-host.pub': productionSshHost,
    'controller-machine-id': 'serverdominguez-machine-id\n',
    'controller-boot-id': 'serverdominguez-boot-id\n',
    'synthetic.seed': 'synthetic-only-seed\n',
    'release-manifest.envelope.json': '{"signed":"release-manifest"}\n',
    'staging-attestation.envelope.json': '{"signed":"staging"}\n',
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
  const normalizedGuestHost = guestSshHost.split(/\s+/u).slice(0, 2).join(' ');
  const provision = {
    schema: 'nexus.rollback-drill-vm-provision.v1',
    setId: 'fixture-provision-set',
    image: {
      filename: 'noble-server-cloudimg-amd64.img',
      sha256: digest('noble-base'),
      basePath: `/var/lib/nexus-rollback-drill-vm/base/${digest('noble-base')}.qcow2`,
    },
    sshPublicKeySha256: sha256Bytes(Buffer.from(
      guestSshClient.split(/\s+/u).slice(0, 2).join(' '),
      'utf8',
    )),
    guestSshHostPublicKeySha256: sha256Bytes(
      Buffer.from(normalizedGuestHost, 'utf8'),
    ),
    ports,
    setDirectory: '/var/lib/nexus-rollback-drill-vm/sets/fixture',
    runtimeReadiness: {
      status: 'ssh_only_bootstrap_required',
      drillReady: false,
      requirements: [],
    },
    hypervisor: {
      manager: 'qemu-systemd',
      qemuBinary: '/usr/bin/qemu-system-x86_64',
    },
    guests: ports.map((port, index) => ({
      name: `guest-${index + 1}`,
      port,
      unit: `nexus-rollback-drill-vm@guest-${index + 1}.service`,
      uuid: uuids[index],
      mac: `52:54:00:00:00:0${index + 1}`,
      instanceId: `nexus-drill-fixture-${index + 1}`,
      overlayPath:
        `/var/lib/nexus-rollback-drill-vm/sets/fixture/guest-${index + 1}/root.qcow2`,
      overlayInitialSha256: overlayDigests[index],
      seedPath:
        `/var/lib/nexus-rollback-drill-vm/sets/fixture/guest-${index + 1}/seed.img`,
      seedSha256: digest(`seed-${index + 1}`),
      hostPublicKey: normalizedGuestHost,
      hostKeyFingerprint: 'SHA256:fixturefixturefixturefixturefixturefixturef',
    })),
    createdAt: new Date(nowMs - 60_000).toISOString(),
  };
  const provisionPath = path.join(root, 'provision.json');
  writeJson(provisionPath, provision);
  const sourceSha = '36b96fab8d0987696ccd7e2ca35a343bca32da2f';
  const targetSha = '3a49f86564f5e9f9523397debb1cf54cecab391c';
  const spec = {
    schema: 'nexus.rollback-drill-kvm-input-spec.v1',
    planLifetimeHours: 24,
    provisionReceipt: 'provision.json',
    controller: {
      machineIdFile: 'controller-machine-id',
      bootIdFile: 'controller-boot-id',
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
      guestSshHostPublicKey: 'guest-ssh-host.pub',
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
        sshHostPublicKeySha256: provision.guestSshHostPublicKeySha256,
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
    expect(validatePlan(plan, { nowMs })).toBe(plan);
    const generation = JSON.parse(fs.readFileSync(
      path.join(prepared, 'generation-manifest.json'),
      'utf8',
    ));
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
    }

    const readinessFiles = makeReadiness(
      root,
      plan,
      fixture.provision,
      generation,
      nowMs,
    );
    const observationPath = path.join(root, 'observation.json');
    const observation = JSON.parse(fs.readFileSync(
      path.join(prepared, 'isolation-observation.template.json'),
      'utf8',
    ));
    observation.capturedAt = new Date(nowMs + 30_000).toISOString();
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
      { nowMs: nowMs + 120_000 },
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
    const output = path.join(root, 'must-not-exist.json');
    const failed = runGenerator([
      'finalize-isolation',
      '--plan', path.join(prepared, 'plan.json'),
      '--generation-manifest', path.join(prepared, 'generation-manifest.json'),
      '--provision-receipt', fixture.provisionPath,
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
});
