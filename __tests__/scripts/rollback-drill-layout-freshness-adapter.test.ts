import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const adapter = path.resolve(
  'scripts/rollback-drill-layout-freshness-adapter.mjs',
);
const rollbackCheck = path.resolve('scripts/rollback-drill-check.mjs');
const scenarios = [
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
] as const;
type Scenario = (typeof scenarios)[number];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sqliteBackup(root: string): Buffer {
  const file = path.join(root, 'fixture.sqlite');
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = DELETE');
  database.exec(
    'CREATE TABLE release_state (name TEXT PRIMARY KEY, value TEXT NOT NULL);'
      + "INSERT INTO release_state VALUES "
      + "('active_release', 'synthetic-predecessor');",
  );
  database.close();
  const body = fs.readFileSync(file);
  fs.unlinkSync(file);
  return body;
}

function backupEntry(pathname: string, body: Buffer) {
  return {
    path: pathname,
    bytes: body.length,
    sha256: sha256(body),
    contentEncoding: 'base64',
    contentBase64: body.toString('base64'),
  };
}

function writeJson(
  file: string,
  value: unknown,
  mode = 0o600,
): Buffer {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return body;
}

function publicPem(
  key: ReturnType<typeof generateKeyPairSync>['publicKey'],
): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function signedEnvelope(
  schema: string,
  keyId: string,
  payload: unknown,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
) {
  return {
    schema,
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      privateKey,
    ).toString('base64'),
  };
}

function fixture({
  completedAt = new Date(Date.now() - 60_000).toISOString(),
}: { completedAt?: string } = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-layout-freshness-adapter-'),
  );
  roots.push(root);
  const ownerKey = generateKeyPairSync('ed25519');
  const releaseKey = generateKeyPairSync('ed25519');
  const hypervisorKey = generateKeyPairSync('ed25519');
  const guestKeys = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      generateKeyPairSync('ed25519'),
    ]),
  ) as Record<Scenario, ReturnType<typeof generateKeyPairSync>>;
  const guestIds: Record<Scenario, string> = {
    failed_health_check: 'guest-2',
    host_reboot_during_migration: 'guest-3',
    ssh_disconnect_after_pm2_stop: 'guest-1',
  };
  const createdMs = Date.parse(completedAt) - 60_000;
  const createdAt = new Date(createdMs).toISOString();
  const expiresAt = new Date(createdMs + 7 * 24 * 60 * 60 * 1000)
    .toISOString();
  const producerDigests = {
    controller: '1'.repeat(64),
    controllerRecovery: '2'.repeat(64),
    controllerUnit: '3'.repeat(64),
    verifier: '4'.repeat(64),
    guest: '5'.repeat(64),
    guestRecovery: '6'.repeat(64),
    qemu: '7'.repeat(64),
    runner: '8'.repeat(64),
  };
  const hypervisorProducer = {
    controllerPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/'
      + 'release-layout-fault-controller',
    controllerRecoveryUnitPath:
      '/etc/systemd/system/'
      + 'nexus-release-layout-fault-drill-recovery.service',
    controllerRecoveryUnitSha256: producerDigests.controllerRecovery,
    controllerSha256: producerDigests.controller,
    controllerUnitPath:
      '/etc/systemd/system/'
      + 'nexus-release-layout-fault-drill@.service',
    controllerUnitSha256: producerDigests.controllerUnit,
    verifierPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/'
      + 'release-layout-fault-drill.mjs',
    verifierSha256: producerDigests.verifier,
  };
  const guestProducer = {
    executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
    executorSha256: producerDigests.guest,
    recoveryUnitPath:
      '/etc/systemd/system/'
      + 'nexus-release-layout-fault-guest-recovery.service',
    recoveryUnitSha256: producerDigests.guestRecovery,
  };
  const hostKeys = {
    'guest-1': 'a'.repeat(64),
    'guest-2': 'b'.repeat(64),
    'guest-3': 'c'.repeat(64),
  };
  const provision = {
    schema: 'nexus.rollback-drill-vm-provision.v2',
    setId: 'd'.repeat(64),
    image: {},
    sshPublicKeySha256: 'e'.repeat(64),
    guestSshHostPublicKeySha256s: [
      hostKeys['guest-1'],
      hostKeys['guest-2'],
      hostKeys['guest-3'],
    ],
    ports: [2201, 2202, 2203],
    setDirectory: '/var/lib/nexus-rollback-drill-vm/sets/test',
    runtimeReadiness: {},
    hypervisor: {
      qemuSha256: producerDigests.qemu,
      runnerSha256: producerDigests.runner,
      faultDrillControllerSha256: producerDigests.controller,
      faultDrillControllerRecoveryUnitSha256:
        producerDigests.controllerRecovery,
      faultDrillControllerUnitSha256: producerDigests.controllerUnit,
      faultDrillVerifierSha256: producerDigests.verifier,
      faultDrillGuestExecutorSha256: producerDigests.guest,
      faultDrillGuestRecoveryUnitSha256: producerDigests.guestRecovery,
    },
    guests: [1, 2, 3].map((index) => ({
      name: `guest-${index}`,
      hostPublicKeySha256: hostKeys[
        `guest-${index}` as keyof typeof hostKeys
      ],
    })),
    createdAt,
  };
  const provisionFile = path.join(root, 'provision.json');
  const provisionBody = writeJson(provisionFile, provision, 0o640);
  const trust = {
    schema: 'nexus.release-layout-kvm-trust.v1',
    provision: {
      schema: provision.schema,
      setId: provision.setId,
      receiptSha256: sha256(provisionBody),
    },
    hypervisor: {
      ...hypervisorProducer,
      publicKeyPem: publicPem(hypervisorKey.publicKey),
      publicKeySha256: sha256(
        Buffer.from(publicPem(hypervisorKey.publicKey), 'utf8'),
      ),
      qemuSha256: producerDigests.qemu,
      runnerSha256: producerDigests.runner,
    },
    guests: Object.fromEntries(scenarios.map((scenario) => [
      scenario,
      {
        guestId: guestIds[scenario],
        publicKeyPem: publicPem(guestKeys[scenario].publicKey),
        publicKeySha256: sha256(
          Buffer.from(publicPem(guestKeys[scenario].publicKey), 'utf8'),
        ),
        sshHostPublicKeySha256: hostKeys[
          guestIds[scenario] as keyof typeof hostKeys
        ],
        ...guestProducer,
      },
    ])),
    createdAt,
  };
  const trustFile = path.join(root, 'trust.json');
  const trustBody = writeJson(trustFile, trust);
  const source = {
    production: {
      base: '/home/dominguez/telegram-hub-bot',
      runtimeSha: '1'.repeat(40),
      artifactDigest: '2'.repeat(64),
      installedRuntimeDigest: '3'.repeat(64),
    },
    staging: {
      base: '/home/dominguez/telegram-hub-bot-staging',
      runtimeSha: '4'.repeat(40),
      artifactDigest: '5'.repeat(64),
      installedRuntimeDigest: '6'.repeat(64),
    },
  };
  const plan = {
    schema: 'nexus.release-layout-fault-drill-plan.v1',
    planId: randomUUID(),
    migrationId: randomUUID(),
    challengeNonce: 'f'.repeat(64),
    source,
    trust: {
      trustManifestSha256: sha256(trustBody),
      provisionSetId: provision.setId,
      provisionReceiptSha256: sha256(provisionBody),
      hypervisorEd25519PublicKey: publicPem(hypervisorKey.publicKey),
      guestEd25519PublicKeys: Object.fromEntries(
        scenarios.map((scenario) => [
          scenario,
          publicPem(guestKeys[scenario].publicKey),
        ]),
      ),
      guestIds,
      producers: {
        hypervisor: hypervisorProducer,
        guests: Object.fromEntries(
          scenarios.map((scenario) => [scenario, guestProducer]),
        ),
      },
    },
    execution: {
      mode: 'strictly-sequential',
      maximumActiveGuests: 1,
      isolatedKvmRequired: true,
      independentOverlayRequired: true,
      productionDataForbidden: true,
      productionKeysForbidden: true,
      automaticProtectedApproval: false,
    },
    scenarios: scenarios.map((scenario, index) => ({
      id: scenario,
      order: index + 1,
      fault: scenario,
      expectedTerminalStatus: 'recovered',
      productionEvidenceAllowed: false,
    })),
    promotionAllowed: false,
    createdAt,
    expiresAt,
  };
  const planSha256 = sha256(
    Buffer.from(canonicalJson(plan), 'utf8'),
  );
  const releaseBackup = Buffer.from(`${canonicalJson(source)}\n`, 'utf8');
  const healthBackup = Buffer.from('ok\n', 'utf8');
  const databaseBackup = sqliteBackup(root);
  const databaseBackupSha256 = sha256(databaseBackup);
  const targetBackupValue = {
    schema: 'nexus.release-layout-guest-target-backup.v1',
    sourceSha256: sha256(
      Buffer.from(canonicalJson(source), 'utf8'),
    ),
    release: backupEntry('release.json', releaseBackup),
    health: backupEntry('health', healthBackup),
    database: backupEntry('database.sqlite', databaseBackup),
  };
  const targetBackup = Buffer.from(
    canonicalJson(targetBackupValue),
    'utf8',
  );
  const targetBackupSha256 = sha256(targetBackup);
  const results = scenarios.map((scenario, index) => {
    const reboot = scenario === 'host_reboot_during_migration';
    const disconnect = reboot
      || scenario === 'ssh_disconnect_after_pm2_stop';
    const guest = {
      bootIdBefore: '11111111-2222-3333-4444-555555555555',
      bootIdAfter: reboot
        ? '66666666-7777-8888-9999-aaaaaaaaaaaa'
        : '11111111-2222-3333-4444-555555555555',
    };
    const observer = {
      bootId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      startMonotonicMilliseconds: 10_000 + index * 1_000,
      endMonotonicMilliseconds: 10_100 + index * 1_000,
      durationMilliseconds: 100,
      targetMilliseconds: 120_000,
    };
    const execution = {
      schema: 'nexus.release-layout-guest-execution-evidence.v2',
      planId: plan.planId,
      migrationId: plan.migrationId,
      planSha256,
      challengeNonce: plan.challengeNonce,
      scenarioId: scenario,
      producer: guestProducer,
      controlVersion: 'nexus-release-layout-fault-guest.v2',
      executionMode: 'strictly-sequential',
      testMode: false,
      productionEvidenceEmitted: false,
      promotionControlInvoked: false,
      faultInjected: scenario,
      terminalStatus: 'recovered',
      exactPredecessorRestored: true,
      databaseRecoveryVerified: true,
      healthRestored: true,
      connectionDropped: disconnect,
      faultObservation: {
        candidateHealthFailureObserved:
          scenario === 'failed_health_check',
        databaseAfterSha256: databaseBackupSha256,
        databaseBeforeSha256: databaseBackupSha256,
        durableRecoveryArmed: true,
        journalSha256: `${index + 1}`.repeat(64),
        predecessorSha256: sha256(releaseBackup),
        processStoppedObserved: true,
        restoredSha256: sha256(releaseBackup),
        targetBackupSha256,
        targetBackupBytes: targetBackup.length,
        targetBackupBase64: targetBackup.toString('base64'),
      },
      observer,
      guest,
      completedAt,
    };
    const executionBody = Buffer.from(canonicalJson(execution), 'utf8');
    const isolation = {
      schema: 'nexus.release-layout-hypervisor-isolation-evidence.v1',
      planId: plan.planId,
      planSha256,
      challengeNonce: plan.challengeNonce,
      scenarioId: scenario,
      guestId: guestIds[scenario],
      hypervisor: 'qemu-kvm',
      kvmAcceleration: true,
      independentOverlay: true,
      loopbackSshOnly: true,
      productionDataMounted: false,
      productionSecretsPresent: false,
      productionNetworkReachable: false,
      producer: hypervisorProducer,
      executionEvidenceSha256: sha256(executionBody),
      observer,
      guest,
      faultObservation: {
        guestRebootObserved: reboot,
        guestSshHostPublicKeySha256:
          hostKeys[guestIds[scenario] as keyof typeof hostKeys],
        qemuCommandLineSha256: `${index + 1}`.repeat(64),
        qemuMainPid: 4000 + index,
        sshDisconnectObserved:
          scenario === 'ssh_disconnect_after_pm2_stop',
        systemdUnit:
          `nexus-rollback-drill-vm@${guestIds[scenario]}.service`,
      },
      createdAt: completedAt,
    };
    const isolationBody = Buffer.from(canonicalJson(isolation), 'utf8');
    const result = {
      schema: 'nexus.release-layout-fault-scenario-result.v2',
      producerVersion: 'nexus-release-layout-fault-drill.v1',
      planId: plan.planId,
      planSha256,
      migrationId: plan.migrationId,
      scenarioId: scenario,
      status: 'passed',
      sourceSha256: sha256(
        Buffer.from(canonicalJson(source), 'utf8'),
      ),
      isolationEvidenceSha256: sha256(isolationBody),
      executionEvidenceSha256: sha256(executionBody),
      producerTrust: {
        controllerRecoveryUnitSha256:
          producerDigests.controllerRecovery,
        controllerSha256: producerDigests.controller,
        controllerUnitSha256: producerDigests.controllerUnit,
        guestExecutorSha256: producerDigests.guest,
        guestRecoveryUnitSha256: producerDigests.guestRecovery,
      },
      proof: {
        schema: 'nexus.release-layout-kvm-proof.v1',
        challengeNonce: plan.challengeNonce,
        executionEvidenceBase64: executionBody.toString('base64'),
        executionSignatureBase64: sign(
          null,
          executionBody,
          guestKeys[scenario].privateKey,
        ).toString('base64'),
        guestPublicKeySha256: sha256(
          Buffer.from(publicPem(guestKeys[scenario].publicKey), 'utf8'),
        ),
        hypervisorPublicKeySha256: sha256(
          Buffer.from(publicPem(hypervisorKey.publicKey), 'utf8'),
        ),
        isolationEvidenceBase64: isolationBody.toString('base64'),
        isolationSignatureBase64: sign(
          null,
          isolationBody,
          hypervisorKey.privateKey,
        ).toString('base64'),
      },
      isolation: {
        guestId: guestIds[scenario],
        hypervisor: 'qemu-kvm',
        independentOverlay: true,
        kvmAcceleration: true,
        loopbackSshOnly: true,
      },
      recovery: {
        connectionDropped: disconnect,
        databaseRecoveryVerified: true,
        durationMilliseconds: observer.durationMilliseconds,
        exactPredecessorRestored: true,
        guestBootIdAfter: guest.bootIdAfter,
        guestBootIdBefore: guest.bootIdBefore,
        healthRestored: true,
        observerBootId: observer.bootId,
        targetMilliseconds: observer.targetMilliseconds,
        terminalStatus: 'recovered',
      },
      completedAt,
      recordedAt: completedAt,
    };
    return {
      id: scenario,
      status: 'passed',
      resultSha256: sha256(
        Buffer.from(canonicalJson(result), 'utf8'),
      ),
      result,
    };
  });
  const drill = {
    schema: 'nexus.release-layout-fault-drill.v1',
    proofSchema: 'nexus.release-layout-kvm-proof.v1',
    migrationId: plan.migrationId,
    source,
    plan,
    planSha256,
    scenarios: results,
    maximumRecoverySeconds: 1,
    completedAt,
  };
  const faultEnvelope = signedEnvelope(
    'nexus.release-layout-fault-drill-envelope.v1',
    'nexus-owner-promotion-2026',
    drill,
    ownerKey.privateKey,
  );
  const faultFile = path.join(root, 'fault-drill-envelope.json');
  writeJson(faultFile, faultEnvelope);
  const ownerPublicKeyFile = path.join(root, 'owner-public.pem');
  fs.writeFileSync(ownerPublicKeyFile, publicPem(ownerKey.publicKey), {
    mode: 0o644,
  });
  const releasePublicKeyFile = path.join(root, 'release-public.pem');
  fs.writeFileSync(releasePublicKeyFile, publicPem(releaseKey.publicKey), {
    mode: 0o644,
  });
  const preloadFile = path.join(root, 'root-policy-preload.cjs');
  fs.writeFileSync(preloadFile, `
const fs = require('node:fs');
const ownerPath = '/etc/nexus-release/owner-promotion-public-key.pem';
const originalOpenSync = fs.openSync.bind(fs);
const originalCloseSync = fs.closeSync.bind(fs);
let faultEnvelopeDescriptor = null;
let faultEnvelopeSwapped = false;
fs.openSync = (file, ...args) => {
  const pathname = typeof file === 'string' ? file : String(file);
  if (pathname === ownerPath) {
    return originalOpenSync(process.env.NEXUS_TEST_OWNER_KEY, ...args);
  }
  if (pathname === process.env.NEXUS_TEST_TRACKED_RELEASE_KEY_PATH) {
    return originalOpenSync(process.env.NEXUS_TEST_RELEASE_KEY, ...args);
  }
  const descriptor = originalOpenSync(file, ...args);
  if (pathname === process.env.NEXUS_TEST_FAULT_SWAP_PATH) {
    faultEnvelopeDescriptor = descriptor;
  }
  return descriptor;
};
fs.closeSync = (descriptor) => {
  const result = originalCloseSync(descriptor);
  if (!faultEnvelopeSwapped
      && descriptor === faultEnvelopeDescriptor
      && process.env.NEXUS_TEST_FAULT_SWAP_REPLACEMENT) {
    fs.renameSync(
      process.env.NEXUS_TEST_FAULT_SWAP_REPLACEMENT,
      process.env.NEXUS_TEST_FAULT_SWAP_PATH,
    );
    faultEnvelopeSwapped = true;
  }
  return result;
};
const rootIdentity = (identity) => {
  if (!identity) return identity;
  return new Proxy(identity, {
    get(target, property) {
      if (property === 'uid' || property === 'gid') return 0;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};
const originalFstatSync = fs.fstatSync.bind(fs);
const originalLstatSync = fs.lstatSync.bind(fs);
const originalStatSync = fs.statSync.bind(fs);
fs.fstatSync = (...args) => rootIdentity(originalFstatSync(...args));
fs.lstatSync = (...args) => rootIdentity(originalLstatSync(...args));
fs.statSync = (...args) => rootIdentity(originalStatSync(...args));
`, { mode: 0o600 });
  const releaseManifest = (
    runtimeSha: string,
    artifactDigest: string,
    packageVersion: string,
  ) => signedEnvelope(
    'nexus.release-manifest.v2',
    'github-environment-release-signing-2026-07',
    {
      schema: 'nexus.release-manifest-payload.v2',
      runtimeSha,
      packageVersion,
      source: { dirty: false },
      artifact: {
        schema: 'nexus.release-artifact-manifest.v1',
        digest: artifactDigest,
      },
      generatedAt: createdAt,
      expiresAt,
    },
    releaseKey.privateKey,
  );
  const sourceManifestFile = path.join(root, 'source-manifest.json');
  writeJson(
    sourceManifestFile,
    releaseManifest(
      source.production.runtimeSha,
      source.production.artifactDigest,
      '4.14.230',
    ),
  );
  const targetManifestFile = path.join(root, 'target-manifest.json');
  writeJson(
    targetManifestFile,
    releaseManifest(
      source.staging.runtimeSha,
      source.staging.artifactDigest,
      '4.14.231',
    ),
  );
  return {
    root,
    ownerKey,
    releaseKey,
    guestKeys,
    hypervisorKey,
    faultFile,
    faultEnvelope,
    trustFile,
    provisionFile,
    ownerPublicKeyFile,
    releasePublicKeyFile,
    preloadFile,
    sourceManifestFile,
    targetManifestFile,
    output: path.join(root, 'rollback-request.json'),
    machineOutput: path.join(root, 'machine-evidence.json'),
    backupOutput: path.join(
      root,
      `layout-fault-${plan.migrationId}.target-backup.v1.json`,
    ),
    targetBackup,
  };
}

function invoke(
  value: ReturnType<typeof fixture>,
  extraArgs: string[] = [],
  {
    environmentOverrides = {},
  }: {
    environmentOverrides?: Record<string, string>;
  } = {},
) {
  return spawnSync(
    process.execPath,
    [
      adapter,
      'build-request',
      '--fault-drill-envelope',
      value.faultFile,
      '--trust-manifest',
      value.trustFile,
      '--provision-receipt',
      value.provisionFile,
      '--source-release-manifest',
      value.sourceManifestFile,
      '--target-release-manifest',
      value.targetManifestFile,
      '--operator',
      'felipe',
      '--backup-output',
      value.backupOutput,
      '--machine-evidence-output',
      value.machineOutput,
      '--output',
      value.output,
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXUS_RELEASE_TEST_MODE: '0',
        NODE_OPTIONS: `--require=${value.preloadFile}`,
        NEXUS_TEST_OWNER_KEY: value.ownerPublicKeyFile,
        NEXUS_TEST_RELEASE_KEY: value.releasePublicKeyFile,
        NEXUS_TEST_TRACKED_RELEASE_KEY_PATH: path.resolve(
          'docs/release/evidence/release-evidence-public-key.pem',
        ),
        ...environmentOverrides,
      },
    },
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('test fixture expected an object');
  }
  return value as Record<string, unknown>;
}

function resignScenarioExecution(
  value: ReturnType<typeof fixture>,
  envelope: ReturnType<typeof fixture>['faultEnvelope'],
  index: number,
  mutate: (execution: Record<string, unknown>) => void,
) {
  const payload = record(envelope.payload);
  const scenario = record((payload.scenarios as unknown[])[index]);
  const result = record(scenario.result);
  const proof = record(result.proof);
  const execution = record(JSON.parse(
    Buffer.from(
      proof.executionEvidenceBase64 as string,
      'base64',
    ).toString('utf8'),
  ));
  mutate(execution);
  const executionBody = Buffer.from(canonicalJson(execution), 'utf8');
  const scenarioId = execution.scenarioId as Scenario;
  proof.executionEvidenceBase64 = executionBody.toString('base64');
  proof.executionSignatureBase64 = sign(
    null,
    executionBody,
    value.guestKeys[scenarioId].privateKey,
  ).toString('base64');

  const isolation = record(JSON.parse(
    Buffer.from(
      proof.isolationEvidenceBase64 as string,
      'base64',
    ).toString('utf8'),
  ));
  isolation.executionEvidenceSha256 = sha256(executionBody);
  const isolationBody = Buffer.from(canonicalJson(isolation), 'utf8');
  proof.isolationEvidenceBase64 = isolationBody.toString('base64');
  proof.isolationSignatureBase64 = sign(
    null,
    isolationBody,
    value.hypervisorKey.privateKey,
  ).toString('base64');
  result.executionEvidenceSha256 = sha256(executionBody);
  result.isolationEvidenceSha256 = sha256(isolationBody);
  scenario.resultSha256 = sha256(
    Buffer.from(canonicalJson(result), 'utf8'),
  );
}

function writeResignedFaultEnvelope(
  value: ReturnType<typeof fixture>,
  envelope: ReturnType<typeof fixture>['faultEnvelope'],
) {
  writeJson(
    value.faultFile,
    signedEnvelope(
      'nexus.release-layout-fault-drill-envelope.v1',
      'nexus-owner-promotion-2026',
      envelope.payload,
      value.ownerKey.privateKey,
    ),
  );
}

describe('rollback drill layout freshness adapter', () => {
  it('derives the ordinary signed-request schema from exact nested KVM proof', () => {
    const value = fixture();
    const result = invoke(value);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout);
    const request = JSON.parse(fs.readFileSync(value.output, 'utf8'));
    const machine = JSON.parse(
      fs.readFileSync(value.machineOutput, 'utf8'),
    );
    const backup = JSON.parse(
      fs.readFileSync(value.backupOutput, 'utf8'),
    );

    expect(summary).toMatchObject({
      ok: true,
      schema: 'nexus-rollback-drill-layout-freshness-adapter.v1',
      command: 'build-request',
      targetSha: '4'.repeat(40),
      targetVersion: '4.14.231',
    });
    expect(request).toMatchObject({
      schema: 'nexus.rollback-drill-payload.v1',
      result: 'passed',
      restoreMode: 'dry-run',
      dryRun: true,
      sourceVersion: '4.14.230',
      targetVersion: '4.14.231',
      sourceSha: '1'.repeat(40),
      targetSha: '4'.repeat(40),
      databaseIntegrity: 'ok',
      backupContainsDatabase: true,
      healthCheck: 'passed',
    });
    expect(machine.recoverySet.scenarios).toHaveLength(3);
    expect(machine.verification.maximumRecoverySeconds).toBe(1);
    expect(backup).toMatchObject({
      schema: 'nexus.release-layout-guest-target-backup.v1',
      release: {
        path: 'release.json',
      },
      database: {
        path: 'database.sqlite',
      },
    });
    expect(fs.readFileSync(value.backupOutput)).toEqual(value.targetBackup);
    expect(
      sha256(Buffer.from(backup.release.contentBase64, 'base64')),
    ).toBe(backup.release.sha256);
    expect(
      sha256(Buffer.from(backup.database.contentBase64, 'base64')),
    ).toBe(backup.database.sha256);
    expect(machine.backup).toMatchObject({
      bytes: value.targetBackup.length,
      scenarioCount: 3,
      releaseSha256: backup.release.sha256,
      databaseSha256: backup.database.sha256,
    });
    expect(request.targetBackupSha256).toBe(
      machine.backup.sha256,
    );
    expect(request.targetBackupSha256).toBe(
      sha256(fs.readFileSync(value.backupOutput)),
    );
    expect(request.machineEvidenceSha256).toBe(
      sha256(Buffer.from(canonicalJson(machine), 'utf8')),
    );
    expect(request.machineEvidenceSha256).toBe(
      sha256(fs.readFileSync(value.machineOutput)),
    );
    expect(fs.statSync(value.output).mode & 0o777).toBe(0o600);
    expect(fs.statSync(value.machineOutput).mode & 0o777).toBe(0o600);
    expect(fs.statSync(value.backupOutput).mode & 0o777).toBe(0o600);

    const canonicalConsumer = spawnSync(
      process.execPath,
      [
        rollbackCheck,
        'validate-payload',
        '--evidence',
        value.output,
        '--release-gate',
        '--max-age-days',
        '30',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    expect(canonicalConsumer.status, canonicalConsumer.stderr).toBe(0);
    expect(JSON.parse(canonicalConsumer.stdout).ok).toBe(true);
  });

  it('deep-verifies the exact owner-signed bytes captured before a path swap', () => {
    const value = fixture();
    const replacement = path.join(value.root, 'fault-envelope-replacement.json');
    fs.writeFileSync(replacement, '{}\n', { mode: 0o644 });

    const result = invoke(value, [], {
      environmentOverrides: {
        NEXUS_TEST_FAULT_SWAP_PATH: value.faultFile,
        NEXUS_TEST_FAULT_SWAP_REPLACEMENT: replacement,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(value.faultFile, 'utf8'))).toEqual({});
    expect(fs.existsSync(value.backupOutput)).toBe(true);
    expect(fs.existsSync(value.machineOutput)).toBe(true);
    expect(fs.existsSync(value.output)).toBe(true);
  });

  it('rejects an invalid owner signature before publishing evidence', () => {
    const value = fixture();
    const envelope = JSON.parse(fs.readFileSync(value.faultFile, 'utf8'));
    const replacement = envelope.signature[4] === 'A' ? 'B' : 'A';
    envelope.signature = `${envelope.signature.slice(0, 4)}${replacement}${
      envelope.signature.slice(5)
    }`;
    writeJson(value.faultFile, envelope);
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'signed layout fault-drill envelope signature is invalid',
    );
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.existsSync(value.machineOutput)).toBe(false);
    expect(fs.existsSync(value.backupOutput)).toBe(false);
  });

  it('does not expose a caller-key test-mode bypass', () => {
    const value = fixture();
    const result = invoke(value, [
      '--allow-test-key',
      '--owner-public-key',
      value.ownerPublicKeyFile,
    ], {
      environmentOverrides: {
        NODE_ENV: 'test',
        NEXUS_RELEASE_TEST_MODE: '1',
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'test signing-key bypass is not supported',
    );
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.existsSync(value.machineOutput)).toBe(false);
    expect(fs.existsSync(value.backupOutput)).toBe(false);
  });

  it('rejects nested guest-signature drift even when the owner resigns it', () => {
    const value = fixture();
    const envelope = structuredClone(value.faultEnvelope);
    const scenario = envelope.payload.scenarios[0];
    scenario.result.proof.executionSignatureBase64 =
      `${scenario.result.proof.executionSignatureBase64.slice(0, 4)}A${
        scenario.result.proof.executionSignatureBase64.slice(5)
      }`;
    scenario.resultSha256 = sha256(
      Buffer.from(canonicalJson(scenario.result), 'utf8'),
    );
    const resigned = signedEnvelope(
      'nexus.release-layout-fault-drill-envelope.v1',
      'nexus-owner-promotion-2026',
      envelope.payload,
      value.ownerKey.privateKey,
    );
    writeJson(value.faultFile, resigned);
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'nested KVM proof or root-pinned trust verification failed',
    );
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.existsSync(value.backupOutput)).toBe(false);
  });

  it('requires three signed target backups to be byte-identical', () => {
    const value = fixture();
    const envelope = structuredClone(value.faultEnvelope);
    resignScenarioExecution(value, envelope, 0, (execution) => {
      const observation = record(execution.faultObservation);
      const target = record(JSON.parse(
        Buffer.from(
          observation.targetBackupBase64 as string,
          'base64',
        ).toString('utf8'),
      ));
      const database = record(target.database);
      const databaseBody = Buffer.from(
        database.contentBase64 as string,
        'base64',
      );
      databaseBody[databaseBody.length - 1] ^= 1;
      database.contentBase64 = databaseBody.toString('base64');
      database.sha256 = sha256(databaseBody);
      const targetBody = Buffer.from(canonicalJson(target), 'utf8');
      observation.databaseBeforeSha256 = database.sha256;
      observation.databaseAfterSha256 = database.sha256;
      observation.targetBackupBase64 = targetBody.toString('base64');
      observation.targetBackupBytes = targetBody.length;
      observation.targetBackupSha256 = sha256(targetBody);
    });
    writeResignedFaultEnvelope(value, envelope);

    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'three layout target backups are not byte-identical',
    );
    expect(fs.existsSync(value.output)).toBe(false);
    expect(fs.existsSync(value.machineOutput)).toBe(false);
    expect(fs.existsSync(value.backupOutput)).toBe(false);
  });

  it('rejects a signed target backup whose bytes are not canonical', () => {
    const value = fixture();
    const envelope = structuredClone(value.faultEnvelope);
    resignScenarioExecution(value, envelope, 0, (execution) => {
      const observation = record(execution.faultObservation);
      const target = JSON.parse(
        Buffer.from(
          observation.targetBackupBase64 as string,
          'base64',
        ).toString('utf8'),
      );
      const noncanonical = Buffer.from(
        `${JSON.stringify(target, null, 2)}\n`,
        'utf8',
      );
      observation.targetBackupBase64 = noncanonical.toString('base64');
      observation.targetBackupBytes = noncanonical.length;
      observation.targetBackupSha256 = sha256(noncanonical);
    });
    writeResignedFaultEnvelope(value, envelope);

    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'nested KVM proof or root-pinned trust verification failed',
    );
    expect(fs.existsSync(value.output)).toBe(false);
  });

  it('keeps legacy v1 proof verifiable but rejects it for freshness', () => {
    const value = fixture();
    const envelope = structuredClone(value.faultEnvelope);
    scenarios.forEach((_, index) => {
      resignScenarioExecution(value, envelope, index, (execution) => {
        execution.schema =
          'nexus.release-layout-guest-execution-evidence.v1';
        execution.controlVersion = 'nexus-release-layout-fault-guest.v1';
        const observation = record(execution.faultObservation);
        delete observation.targetBackupBase64;
        delete observation.targetBackupBytes;
        delete observation.targetBackupSha256;
      });
    });
    writeResignedFaultEnvelope(value, envelope);

    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'evidence predates governed target backups',
    );
    expect(fs.existsSync(value.output)).toBe(false);
  });

  it('rejects a production-signed manifest for another SHA or artifact', () => {
    const value = fixture();
    const manifest = JSON.parse(
      fs.readFileSync(value.targetManifestFile, 'utf8'),
    );
    manifest.payload.runtimeSha = '9'.repeat(40);
    const resigned = signedEnvelope(
      'nexus.release-manifest.v2',
      'github-environment-release-signing-2026-07',
      manifest.payload,
      value.releaseKey.privateKey,
    );
    writeJson(value.targetManifestFile, resigned);
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'target release manifest does not bind the signed layout source identity',
    );
  });

  it('rejects terminal KVM evidence older than the ordinary 30-day gate', () => {
    const value = fixture({
      completedAt: new Date(
        Date.now() - 31 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'layout fault drill is older than the ordinary 30-day gate',
    );
  });

  it('requires separate owner, release, hypervisor, and guest keys', () => {
    const value = fixture();
    fs.writeFileSync(
      value.releasePublicKeyFile,
      publicPem(value.ownerKey.publicKey),
      { mode: 0o644 },
    );
    const manifest = JSON.parse(
      fs.readFileSync(value.sourceManifestFile, 'utf8'),
    );
    writeJson(
      value.sourceManifestFile,
      signedEnvelope(
        'nexus.release-manifest.v2',
        'github-environment-release-signing-2026-07',
        manifest.payload,
        value.ownerKey.privateKey,
      ),
    );
    const target = JSON.parse(
      fs.readFileSync(value.targetManifestFile, 'utf8'),
    );
    writeJson(
      value.targetManifestFile,
      signedEnvelope(
        'nexus.release-manifest.v2',
        'github-environment-release-signing-2026-07',
        target.payload,
        value.ownerKey.privateKey,
      ),
    );
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'signing authority is reused by owner and release',
    );
  });

  it('never overwrites an existing output or publishes its companion', () => {
    const value = fixture();
    fs.writeFileSync(value.output, 'owner-preserved\n', { mode: 0o600 });
    const result = invoke(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('published evidence set order is invalid');
    expect(fs.readFileSync(value.output, 'utf8')).toBe('owner-preserved\n');
    expect(fs.existsSync(value.machineOutput)).toBe(false);
    expect(fs.existsSync(value.backupOutput)).toBe(false);
  });

  it('resumes an exact request-last publication prefix idempotently', () => {
    const value = fixture();
    const first = invoke(value);
    expect(first.status, first.stderr).toBe(0);
    const backupBefore = fs.readFileSync(value.backupOutput);
    const machineBefore = fs.readFileSync(value.machineOutput);
    const requestBefore = fs.readFileSync(value.output);
    fs.unlinkSync(value.output);

    const resumed = invoke(value);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fs.readFileSync(value.backupOutput)).toEqual(backupBefore);
    expect(fs.readFileSync(value.machineOutput)).toEqual(machineBefore);
    expect(fs.readFileSync(value.output)).toEqual(requestBefore);
  });
});
