import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const INSTALLER = join(
  ROOT,
  'scripts',
  'remote-v2-normalization-attestor-install.sh',
);
const BRIDGE = join(
  ROOT,
  'scripts',
  'trusted-release-runtime-attestation-v2-bridge.mjs',
);
const DIGEST = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

function canonicalJson(input: unknown): string {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}

function writeJson(file: string, value: unknown, mode = 0o600) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(file, mode);
}

function executable(file: string, body: string) {
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
}

interface InstallerFixture {
  root: string;
  installer: string;
  sourceRoot: string;
  sourceSha: string;
  archive: string;
  archiveSha256: string;
  authorization: string;
  payload: Record<string, any>;
  stateRoot: string;
  bridgeState: string;
  base: string;
  target: string;
  strictSha256: string;
  bridgeSha256: string;
  env: NodeJS.ProcessEnv;
  installArgs: string[];
  recoverArgs: string[];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createPortableCommandShims(directory: string) {
  mkdirSync(directory, { recursive: true });
  executable(join(directory, 'node'), `#!/bin/bash
exec ${JSON.stringify(process.execPath)} "$@"
`);
  executable(join(directory, 'stat'), `#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2);
if(args[0]!=="-c"||args.length<3)process.exit(64);
const format=args[1];
const file=args.at(-1);
const value=fs.lstatSync(file);
const mode=(value.mode&0o7777).toString(8);
process.stdout.write(format
 .replaceAll("%u",String(value.uid))
 .replaceAll("%g",String(value.gid))
 .replaceAll("%a",mode)
 .replaceAll("%h",String(value.nlink))+"\\n");
`);
  executable(join(directory, 'realpath'), `#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2).filter((arg)=>arg!=="-e"&&arg!=="--");
if(args.length!==1)process.exit(64);
process.stdout.write(fs.realpathSync(args[0])+"\\n");
`);
  executable(join(directory, 'mv'), `#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2).filter((arg)=>!["-fT","--"].includes(arg));
if(args.length!==2)process.exit(64);
fs.renameSync(args[0],args[1]);
`);
  executable(join(directory, 'flock'), `#!/usr/bin/python3
import fcntl
import sys
nonblocking = "-n" in sys.argv[1:]
descriptor = int(sys.argv[-1])
operation = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
try:
    fcntl.flock(descriptor, operation)
except BlockingIOError:
    raise SystemExit(1)
`);
}

function createArchive(
  archive: string,
  sourceRoot: string,
  sourceSha: string,
) {
  const created = spawnSync('python3', [
    '-c',
    [
      'import pathlib,sys,tarfile',
      'archive,root,sha=sys.argv[1:]',
      'root=pathlib.Path(root)',
      'with tarfile.open(archive,"w:gz",pax_headers={"comment":sha}) as out:',
      '  for relative in (',
      '   "scripts/remote-v2-normalization-attestor-install.sh",',
      '   "scripts/trusted-release-runtime-attestation-v2-bridge.mjs"):',
      '    out.add(root/relative,arcname="source/"+relative,recursive=False)',
    ].join('\n'),
    archive,
    sourceRoot,
    sourceSha,
  ], { encoding: 'utf8' });
  expect(created.status, created.stderr).toBe(0);
  chmodSync(archive, 0o600);
}

function installerFixture(): InstallerFixture {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'nexus-v2-installer-')),
  );
  roots.push(root);
  const bootstrap = join(root, 'bootstrap');
  const sourceSha = 'd'.repeat(40);
  const sourceRoot = join(bootstrap, sourceSha, 'source');
  const scripts = join(sourceRoot, 'scripts');
  const archive = join(bootstrap, sourceSha, 'source.tar.gz');
  const stateRoot = join(root, 'state');
  const bridgeState = join(
    stateRoot,
    'v2-normalization-attestor-bridge',
  );
  const base = join(root, 'production');
  const target = join(root, 'installed-attestor.mjs');
  const control = join(root, 'promotion-control');
  const systemctl = join(root, 'systemctl');
  const ownerPublicKey = join(root, 'owner.pem');
  const releasePublicKey = join(root, 'release.pem');
  const machineId = join(root, 'machine-id');
  const authorization = join(root, 'authorization.json');
  const sonarLock = join(root, 'sonar.lock');
  const commandShims = join(root, 'bin');
  const workerUser = process.getuid() === 0 ? 'nobody' : userInfo().username;
  const workerUidResult = spawnSync('id', ['-u', workerUser], {
    encoding: 'utf8',
  });
  const workerGidResult = spawnSync('id', ['-g', workerUser], {
    encoding: 'utf8',
  });
  expect(workerUidResult.status, workerUidResult.stderr).toBe(0);
  expect(workerGidResult.status, workerGidResult.stderr).toBe(0);
  const workerUid = Number(workerUidResult.stdout.trim());
  const workerGid = Number(workerGidResult.stdout.trim());
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(base, 'releases'), { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  copyFileSync(INSTALLER, join(scripts, 'remote-v2-normalization-attestor-install.sh'));
  copyFileSync(BRIDGE, join(scripts, 'trusted-release-runtime-attestation-v2-bridge.mjs'));
  chmodSync(join(scripts, 'remote-v2-normalization-attestor-install.sh'), 0o755);
  chmodSync(join(scripts, 'trusted-release-runtime-attestation-v2-bridge.mjs'), 0o644);
  createPortableCommandShims(commandShims);
  executable(control, `#!/bin/bash
case "\${1:-}" in
  version) printf '%s\\n' nexus-release-promotion-control.v2 ;;
  assert-idle) printf '%s\\n' '{"ok":true,"idle":true}' ;;
  *) exit 64 ;;
esac
`);
  chmodSync(control, 0o700);
  executable(systemctl, `#!/bin/bash
if [ "\${1:-}" = show ]; then
  case " $* " in
    *" --property=LoadState "*) printf '%s\\n' loaded ;;
    *" --property=ActiveState "*) printf '%s\\n' inactive ;;
    *) exit 64 ;;
  esac
elif [ "\${1:-}" = list-units ]; then
  exit 0
else
  exit 64
fi
`);
  chmodSync(systemctl, 0o700);
  const strictBody = '#!/usr/bin/env node\nprocess.exit(0);\n';
  writeFileSync(target, strictBody, { mode: 0o700 });
  chmodSync(target, 0o700);
  const strictSha256 = DIGEST(readFileSync(target));
  const bridgeSha256 = DIGEST(readFileSync(join(
    scripts,
    'trusted-release-runtime-attestation-v2-bridge.mjs',
  )));
  const controlSha256 = DIGEST(readFileSync(control));
  const owner = generateKeyPairSync('ed25519');
  const release = generateKeyPairSync('ed25519');
  writeFileSync(
    ownerPublicKey,
    owner.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  chmodSync(ownerPublicKey, 0o600);
  writeFileSync(
    releasePublicKey,
    release.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  chmodSync(releasePublicKey, 0o600);
  writeFileSync(machineId, 'installer-machine\n', { mode: 0o644 });
  chmodSync(machineId, 0o644);
  writeFileSync(join(base, '.env'), 'FIXTURE_SECRET=value\n', { mode: 0o600 });
  chmodSync(join(base, '.env'), 0o600);
  if (process.getuid() === 0) {
    chownSync(join(base, '.env'), workerUid, workerGid);
  }
  writeFileSync(join(stateRoot, '.control.lock'), '', { mode: 0o600 });
  chmodSync(join(stateRoot, '.control.lock'), 0o600);
  writeFileSync(sonarLock, '', { mode: 0o660 });
  chmodSync(sonarLock, 0o660);
  if (process.getuid() === 0) {
    chownSync(sonarLock, process.getuid(), workerGid);
  }
  const transactionId = '20260725T140000Z-4321-fedcba654321';
  const requestSha256 = DIGEST('installer-request');
  const requestEnvelopeSha256 = DIGEST('installer-request-envelope');
  const predecessor = {
    runtime: join(base, 'releases', 'predecessor'),
    sha: 'a'.repeat(40),
    artifactDigest: DIGEST('predecessor-artifact'),
    installedRuntimeDigest: DIGEST('predecessor-installed'),
  };
  const runtimeTarget = {
    runtime: join(base, 'releases', 'target'),
    sha: 'b'.repeat(40),
    artifactDigest: DIGEST('target-artifact'),
    installedRuntimeDigest: DIGEST('target-installed'),
  };
  const now = Date.now();
  const payload = {
    schema: 'nexus.v2-normalization-attestor-bridge-request.v1',
    purpose: 'v2_layout_normalization',
    authorizationId: '784367aa-7158-49ae-9975-37131db73351',
    nonce: DIGEST('installer-nonce'),
    role: 'production',
    serverIdentity: {
      machineIdSha256: DIGEST(readFileSync(machineId)),
    },
    transaction: {
      transactionId,
      requestSha256,
      requestEnvelopeSha256,
    },
    control: {
      version: 'nexus-release-promotion-control.v2',
      sha256: controlSha256,
    },
    attestors: {
      bridgeSha256,
      replacedAttestorSha256: strictSha256,
      strictRestoreSha256: strictSha256,
    },
    runtime: { base, predecessor, target: runtimeTarget },
    environment: {
      legacy: {
        ownerUid: workerUid,
        groupId: workerGid,
        mode: '0600',
      },
      modern: {
        ownerUid: 0,
        groupId: workerGid,
        mode: '0440',
      },
    },
    mode: {
      legacyPredecessor: 'owner_signed_active_request_only',
      target: 'strict_network_independent',
      strictRestore: 'completed_escrowed_soaked',
      selectorAdoption: 'post_terminal_only',
    },
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
  };
  writeJson(authorization, {
    schema: 'nexus.v2-normalization-attestor-bridge-envelope.v1',
    keyId: 'nexus-owner-promotion-2026',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      owner.privateKey,
    ).toString('base64'),
  });
  createArchive(archive, sourceRoot, sourceSha);
  const archiveSha256 = DIGEST(readFileSync(archive));
  const env = {
    ...process.env,
    NEXUS_V2_NORMALIZATION_INSTALL_TEST_MODE: '1',
    NEXUS_V2_NORMALIZATION_TEST_BIN_DIR: commandShims,
    NEXUS_V2_NORMALIZATION_BOOTSTRAP_BASE: bootstrap,
    NEXUS_V2_NORMALIZATION_STATE_ROOT: stateRoot,
    NEXUS_V2_NORMALIZATION_CONTROL_MARKER: join(
      stateRoot,
      'bootstrap-in-progress.v1',
    ),
    NEXUS_V2_NORMALIZATION_SONAR_LOCK: sonarLock,
    NEXUS_V2_NORMALIZATION_ATTESTOR_TARGET: target,
    NEXUS_V2_NORMALIZATION_CONTROL_BIN: control,
    NEXUS_V2_NORMALIZATION_OWNER_PUBLIC_KEY: ownerPublicKey,
    NEXUS_V2_NORMALIZATION_RELEASE_EVIDENCE_PUBLIC_KEY: releasePublicKey,
    NEXUS_V2_NORMALIZATION_MACHINE_ID_FILE: machineId,
    NEXUS_V2_NORMALIZATION_WORKER_USER: workerUser,
    NEXUS_V2_NORMALIZATION_NODE_BIN: process.execPath,
    NEXUS_V2_NORMALIZATION_SYSTEMCTL_BIN: systemctl,
    NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256: controlSha256,
    NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256:
      strictSha256,
  };
  const installer = join(
    scripts,
    'remote-v2-normalization-attestor-install.sh',
  );
  return {
    root,
    installer,
    sourceRoot,
    sourceSha,
    archive,
    archiveSha256,
    authorization,
    payload,
    stateRoot,
    bridgeState,
    base,
    target,
    strictSha256,
    bridgeSha256,
    env,
    installArgs: [
      sourceRoot,
      sourceSha,
      archive,
      archiveSha256,
      authorization,
    ],
    recoverArgs: [sourceRoot, sourceSha, archive, archiveSha256],
  };
}

function runInstaller(
  fixture: InstallerFixture,
  command: 'install' | 'recover' | 'restore',
  overrides: NodeJS.ProcessEnv = {},
) {
  const args = command === 'install'
    ? fixture.installArgs
    : fixture.recoverArgs;
  return spawnSync(fixture.installer, [command, ...args], {
    encoding: 'utf8',
    env: { ...fixture.env, ...overrides },
    timeout: 15_000,
  });
}

function prepareCompletedPromotion(fixture: InstallerFixture) {
  const transaction = fixture.payload.transaction;
  const runtime = fixture.payload.runtime.target;
  const now = Date.now();
  const cutoverStarted = new Date(now - 120_000).toISOString();
  const serviceUnavailable = new Date(now - 119_000).toISOString();
  const candidateAvailable = new Date(now - 90_000).toISOString();
  const soakStart = new Date(now - 90_000).toISOString();
  const soakEnd = new Date(now - 20_000).toISOString();
  const beforeReadinessAt = new Date(now - 19_000).toISOString();
  const releaseConfirmedAt = new Date(now - 18_000).toISOString();
  const currentRecoveryConfirmedAt = new Date(now - 17_000).toISOString();
  const currentDatabaseConfirmedAt = new Date(now - 16_000).toISOString();
  const afterReadinessAt = new Date(now - 15_000).toISOString();
  const completedAt = new Date(now - 10_000).toISOString();
  const preRecoveryConfirmedAt = new Date(now - 125_000).toISOString();
  const preDatabaseConfirmedAt = new Date(now - 124_000).toISOString();
  const backupCreatedAt = new Date(now - 130_000).toISOString();
  const retainUntil = new Date(now + 100 * 86_400_000).toISOString();
  const targetVersion = '4.14.231';
  const backupDirectory = join(fixture.root, 'backups');
  const backup = join(
    backupDirectory,
    `v4.14.230_before-v${targetVersion}_20260725T140000Z.tar.gz`,
  );
  mkdirSync(backupDirectory, { recursive: true });
  writeFileSync(backup, 'exact completed promotion backup\n', {
    mode: 0o600,
  });
  const backupBody = readFileSync(backup);
  const backupSha256 = DIGEST(backupBody);
  const recoveryPlaintextSha256 = DIGEST('current recovery runtime');
  const recoveryRuntimeDigest = DIGEST('recovery runtime identity');
  const releaseManifestSha256 = DIGEST('release manifest evidence');
  const stagingAttestationSha256 = DIGEST('staging attestation evidence');
  const transactionState = join(
    fixture.stateRoot,
    'transactions',
    transaction.transactionId,
    'state',
  );
  mkdirSync(transactionState, { recursive: true });
  writeJson(join(transactionState, 'journal.json'), {
    schema: 'nexus.promotion-transaction-journal.v1',
    transactionId: transaction.transactionId,
    requestSha256: transaction.requestSha256,
    phase: 'completed',
    status: 'completed',
    escrowConfirmed: true,
    completedAt,
  });
  writeJson(join(transactionState, 'escrow-confirmation.json'), {
    schema: 'nexus.promotion-dr-escrow.v3',
    status: 'passed',
    transactionId: transaction.transactionId,
    requestSha256: transaction.requestSha256,
    confirmedAt: currentDatabaseConfirmedAt,
    storageControls: {
      provider: 'aws-s3',
      controlMode: 'versioned-s3',
      releasePrefixLockVerified: true,
    },
    requiredRelease: {
      path: backup,
      plaintextSha256: backupSha256,
      objectKey: `nexus/releases/${basename(backup)}.${backupSha256}.age`,
      encryptedSha256: DIGEST('encrypted release'),
      encryptedSizeBytes: 101,
      confirmedAt: releaseConfirmedAt,
      retainUntil,
      objectVersionId: 'release-version-id',
      retentionVariance: null,
      approvedUnversionedVariance: false,
      confirmed: true,
    },
    preMutationCurrentRecovery: {
      path: runtime.runtime,
      plaintextSha256: recoveryPlaintextSha256,
      objectKey: `nexus/releases/v${targetVersion}+current-${runtime.sha}`
        + `+escrow-${transaction.transactionId}+phase-pre-mutation.tar.gz.`
        + `${recoveryPlaintextSha256}.age`,
      encryptedSha256: DIGEST('encrypted pre-mutation recovery'),
      encryptedSizeBytes: 102,
      runtimeSha: runtime.sha,
      artifactDigest: runtime.artifactDigest,
      installedRuntimeDigest: runtime.installedRuntimeDigest,
      recoveryRuntimeDigest,
      releaseManifestSha256,
      stagingAttestationSha256,
      escrowId: transaction.transactionId,
      escrowPhase: 'pre-mutation',
      confirmedAt: preRecoveryConfirmedAt,
      retainUntil,
      objectVersionId: 'pre-recovery-version-id',
      retentionVariance: null,
      approvedUnversionedVariance: false,
      confirmed: true,
    },
    currentRecoveryRuntime: {
      path: runtime.runtime,
      plaintextSha256: recoveryPlaintextSha256,
      objectKey: `nexus/releases/v${targetVersion}+current-${runtime.sha}`
        + `+escrow-${transaction.transactionId}+phase-post-soak.tar.gz.`
        + `${recoveryPlaintextSha256}.age`,
      encryptedSha256: DIGEST('encrypted post-soak recovery'),
      encryptedSizeBytes: 103,
      runtimeSha: runtime.sha,
      artifactDigest: runtime.artifactDigest,
      installedRuntimeDigest: runtime.installedRuntimeDigest,
      recoveryRuntimeDigest,
      releaseManifestSha256,
      stagingAttestationSha256,
      escrowId: transaction.transactionId,
      escrowPhase: 'post-soak',
      confirmedAt: currentRecoveryConfirmedAt,
      retainUntil,
      objectVersionId: 'post-recovery-version-id',
      retentionVariance: null,
      approvedUnversionedVariance: false,
      confirmed: true,
    },
    preMutationDatabaseRecoveryPoint: {
      objectKey:
        'nexus/database/hourly/nexus-db-20260725T135800Z.sqlite.age',
      plaintextSha256: DIGEST('pre-mutation database'),
      encryptedSha256: DIGEST('encrypted pre-mutation database'),
      encryptedSizeBytes: 104,
      objectVersionId: 'pre-database-version-id',
      confirmedAt: preDatabaseConfirmedAt,
      retentionVariance: null,
      approvedUnversionedVariance: false,
    },
    currentDatabaseRecoveryPoint: {
      objectKey:
        'nexus/database/hourly/nexus-db-20260725T140200Z.sqlite.age',
      plaintextSha256: DIGEST('current database'),
      encryptedSha256: DIGEST('encrypted current database'),
      encryptedSizeBytes: 105,
      objectVersionId: 'current-database-version-id',
      confirmedAt: currentDatabaseConfirmedAt,
      retentionVariance: null,
      approvedUnversionedVariance: false,
    },
    promotionTimeline: {
      cutoverStartedAt: cutoverStarted,
      serviceUnavailableStartedAt: serviceUnavailable,
      soakCompletedAt: soakEnd,
    },
    candidateReadinessRefresh: {
      beforeEscrow: {
        schema: 'nexus.candidate-readiness-refresh.v1',
        status: 'passed',
        transactionId: transaction.transactionId,
        runtimeSha: runtime.sha,
        packageVersion: targetVersion,
        verifiedAt: beforeReadinessAt,
        checks: {
          loopbackBackend: true,
          contentEngine: true,
          pm2Identity: true,
          publicHealth: true,
          authenticatedSnapshot: true,
        },
      },
      afterEscrow: {
        schema: 'nexus.candidate-readiness-refresh.v1',
        status: 'passed',
        transactionId: transaction.transactionId,
        runtimeSha: runtime.sha,
        packageVersion: targetVersion,
        verifiedAt: afterReadinessAt,
        checks: {
          loopbackBackend: true,
          contentEngine: true,
          pm2Identity: true,
          publicHealth: true,
          authenticatedSnapshot: true,
        },
      },
    },
  });
  writeFileSync(join(transactionState, 'result.env'), [
    `NEXUS_TRANSACTION_ID=${transaction.transactionId}`,
    `NEXUS_RUNTIME_SHA=${runtime.sha}`,
    `NEXUS_ARTIFACT_DIGEST=${runtime.artifactDigest}`,
    `NEXUS_INSTALLED_RUNTIME_DIGEST=${runtime.installedRuntimeDigest}`,
    `NEXUS_TARGET_VERSION=${targetVersion}`,
    `NEXUS_SENTRY_RELEASE=${runtime.sha}`,
    `NEXUS_CUTOVER_STARTED_AT=${cutoverStarted}`,
    `NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=${serviceUnavailable}`,
    `NEXUS_CANDIDATE_AVAILABLE_AT=${candidateAvailable}`,
    'NEXUS_CUTOVER_SECONDS=70',
    'NEXUS_BACKUP_WINDOW_SECONDS=4',
    'NEXUS_BACKUP_OUTAGE_SECONDS=4',
    'NEXUS_FINAL_UNAVAILABILITY_SECONDS=8',
    'NEXUS_TOTAL_UNAVAILABILITY_SECONDS=8',
    'NEXUS_VERIFICATION_SOAK_SECONDS=60',
    'NEXUS_SOAK_OBSERVED_SECONDS=70',
    `NEXUS_SOAK_STARTED_AT=${soakStart}`,
    `NEXUS_SOAK_COMPLETED_AT=${soakEnd}`,
    `NEXUS_BACKUP_FILE=${backup}`,
    `NEXUS_BACKUP_SHA256=${backupSha256}`,
    `NEXUS_BACKUP_SIZE_BYTES=${backupBody.length}`,
    'NEXUS_BACKUP_ARCHIVED_VERSION=4.14.230',
    `NEXUS_BACKUP_TARGET_VERSION=${targetVersion}`,
    `NEXUS_BACKUP_CREATED_AT=${backupCreatedAt}`,
    `NEXUS_BACKUP_DATABASE_SHA256=${DIGEST('stopped database')}`,
    '',
  ].join('\n'), { mode: 0o600 });
  chmodSync(join(transactionState, 'result.env'), 0o600);
  writeJson(join(fixture.bridgeState, 'acceptance.v1.json'), {
    schema: 'nexus.v2-normalization-attestor-acceptance.v1',
    transactionId: transaction.transactionId,
    requestSha256: transaction.requestSha256,
    requestEnvelopeSha256: transaction.requestEnvelopeSha256,
    productionAuthorizationSha256: DIGEST(
      readFileSync(join(
        fixture.bridgeState,
        'production-authorization.envelope.json',
      )),
    ),
    productionAuthorizationId: fixture.payload.authorizationId,
    productionNonce: fixture.payload.nonce,
    acceptedAt: new Date(now - 120_000).toISOString(),
  });
  if (process.getuid() === 0) {
    chownSync(
      join(fixture.base, '.env'),
      process.getuid(),
      fixture.payload.environment.legacy.groupId,
    );
  }
  chmodSync(join(fixture.base, '.env'), 0o440);
}

describe('v2 normalization attestor installer transactions', () => {
  it('fails closed before mutation when systemd state cannot be proved', () => {
    const fixture = installerFixture();
    const unavailable = join(fixture.root, 'systemctl-unavailable');
    executable(unavailable, '#!/bin/bash\nexit 1\n');
    const rejected = runInstaller(fixture, 'install', {
      NEXUS_V2_NORMALIZATION_SYSTEMCTL_BIN: unavailable,
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain(
      'promotion recovery unit state cannot be proved',
    );
    expect(DIGEST(readFileSync(fixture.target))).toBe(fixture.strictSha256);
    expect(existsSync(join(
      fixture.bridgeState,
      'maintenance.v1.json',
    ))).toBe(false);
    expect(existsSync(join(
      fixture.stateRoot,
      'bootstrap-in-progress.v1',
    ))).toBe(false);
  }, 30_000);

  it.each([
    ['marker', 'pre_mutation_maintenance_recovered', 'strict'],
    ['journal', 'recovered', 'strict'],
    ['replaced', 'recovered', 'strict'],
    ['receipt', 'finished_install', 'bridge'],
    ['journal_removed', 'finished_install', 'bridge'],
  ])(
    'recovers an install SIGKILL at %s by exact %s disposition',
    (phase, expectedStatus, expectedTarget) => {
      const fixture = installerFixture();
      const crashed = runInstaller(fixture, 'install', {
        NEXUS_V2_NORMALIZATION_TEST_INSTALL_CRASH_PHASE: phase,
      });
      expect(crashed.status, crashed.stderr).toBeNull();
      expect(crashed.signal).toBe('SIGKILL');
      expect(statSync(join(
        fixture.bridgeState,
        'maintenance.v1.json',
      )).mode & 0o777).toBe(0o600);
      expect(statSync(join(
        fixture.stateRoot,
        'bootstrap-in-progress.v1',
      )).mode & 0o777).toBe(0o600);

      const recovered = runInstaller(fixture, 'recover');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        status: expectedStatus,
      });
      expect(DIGEST(readFileSync(fixture.target))).toBe(
        expectedTarget === 'bridge'
          ? fixture.bridgeSha256
          : fixture.strictSha256,
      );
      expect(existsSync(join(
        fixture.bridgeState,
        'install-in-progress.v1.json',
      ))).toBe(false);
      expect(existsSync(join(
        fixture.bridgeState,
        'maintenance.v1.json',
      ))).toBe(false);
      expect(existsSync(join(
        fixture.stateRoot,
        'bootstrap-in-progress.v1',
      ))).toBe(false);
    },
    30_000,
  );

  it('serializes concurrent installer launches under the maintenance locks', async () => {
    const fixture = installerFixture();
    const ready = join(fixture.root, 'installer-held.json');
    const first = spawn(
      fixture.installer,
      ['install', ...fixture.installArgs],
      {
        env: {
          ...fixture.env,
          NEXUS_V2_NORMALIZATION_TEST_HOLD_PHASE: 'marker',
          NEXUS_V2_NORMALIZATION_TEST_HOLD_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const deadline = Date.now() + 8_000;
    while (!existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(ready)).toBe(true);
    const second = runInstaller(fixture, 'install');
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(
      /another bridge installer is active|maintenance transaction requires explicit recover/u,
    );
    first.kill('SIGKILL');
    await new Promise<void>((resolve) => first.once('exit', () => resolve()));
    const recovered = runInstaller(fixture, 'recover');
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      ok: true,
      status: 'pre_mutation_maintenance_recovered',
    });
  }, 30_000);

  it.each([
    [
      'missing producer field',
      (escrow: Record<string, any>) => {
        delete escrow.requiredRelease;
      },
    ],
    [
      'unexpected producer field',
      (escrow: Record<string, any>) => {
        escrow.unreviewedRestoreAuthority = true;
      },
    ],
  ])('rejects an escrow-v3 receipt with an exact-shape %s', (_name, mutate) => {
    const fixture = installerFixture();
    const installed = runInstaller(fixture, 'install');
    expect(installed.status, installed.stderr).toBe(0);
    prepareCompletedPromotion(fixture);
    const escrowPath = join(
      fixture.stateRoot,
      'transactions',
      fixture.payload.transaction.transactionId,
      'state',
      'escrow-confirmation.json',
    );
    const escrow = JSON.parse(readFileSync(escrowPath, 'utf8'));
    mutate(escrow);
    writeJson(escrowPath, escrow);

    const rejected = runInstaller(fixture, 'restore');
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain(
      'completed promotion escrow-v3 evidence is invalid',
    );
    expect(DIGEST(readFileSync(fixture.target))).toBe(fixture.bridgeSha256);
    expect(existsSync(join(fixture.bridgeState, 'restored.v1.json')))
      .toBe(false);
  }, 30_000);

  it.each([
    ['prepared', 'restored_bridge', 'bridge'],
    ['swapped', 'restored_bridge', 'bridge'],
    ['receipt_published', 'finished', 'strict'],
    ['journal_removed', 'finished_restore', 'strict'],
  ])(
    'recovers strict restore SIGKILL at %s with %s',
    (phase, expectedStatus, expectedTarget) => {
      const fixture = installerFixture();
      const installed = runInstaller(fixture, 'install');
      expect(installed.status, installed.stderr).toBe(0);
      prepareCompletedPromotion(fixture);
      const crashed = runInstaller(fixture, 'restore', {
        NEXUS_V2_NORMALIZATION_TEST_RESTORE_CRASH_PHASE: phase,
      });
      expect(crashed.status, crashed.stderr).toBeNull();
      expect(crashed.signal).toBe('SIGKILL');
      const recovered = runInstaller(fixture, 'recover');
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout)).toMatchObject({
        ok: true,
        status: expectedStatus,
      });
      expect(DIGEST(readFileSync(fixture.target))).toBe(
        expectedTarget === 'bridge'
          ? fixture.bridgeSha256
          : fixture.strictSha256,
      );
      expect(existsSync(join(
        fixture.bridgeState,
        'strict-restore-in-progress.v1.json',
      ))).toBe(false);
      expect(existsSync(join(
        fixture.bridgeState,
        'maintenance.v1.json',
      ))).toBe(false);
      expect(existsSync(join(
        fixture.stateRoot,
        'bootstrap-in-progress.v1',
      ))).toBe(false);
    },
    30_000,
  );
});
