import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  publicKeyIdentity,
  textKeyIdentity,
} from '../../../scripts/lib/rollback-drill-kvm-evidence.mjs';

const digest = (label: string) => createHash('sha256').update(label).digest('hex');
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();

function compatibility(label: string) {
  return {
    schemaVersion: 'NexusApplicationRestoreCompatibilityV1',
    status: 'passed',
    databaseMaxMigration: 253,
    runtimeMaxMigration: 253,
    terminalLineageVerified: true,
    appliedMigrationCount: 253,
    appliedMigrationSetSha256: digest(`${label}-applied`),
    runtimeMigrationCount: 253,
    runtimeMigrationSetSha256: digest(`${label}-runtime`),
    canonicalAppliedMigrationCount: 253,
    migrationLineageId: 'canonical',
    retiredMigrationCount: 0,
    retiredMigrationSetSha256: digest(`${label}-retired`),
    retiredMigrationPolicySha256: digest(`${label}-retired-policy`),
    identitySha256: digest(`${label}-identity`),
  };
}

function outcome(
  fixtureNow: number,
  plan: any,
  isolation: any,
  drill: 'ssh-loss' | 'failed-health' | 'guest-reboot',
  sequence: number,
  startOffsetMinutes: number,
) {
  const events: Record<typeof drill, string[]> = {
    'ssh-loss': [
      'launch_accepted',
      'recovery_armed',
      'predecessor_stopped',
      'controller_disconnected',
      'controller_reconnected',
      'service_healthy',
      'terminal_observed',
    ],
    'failed-health': [
      'launch_accepted',
      'recovery_armed',
      'predecessor_stopped',
      'candidate_mutated',
      'candidate_health_fault_injected',
      'recovery_started',
      'service_healthy',
      'terminal_observed',
    ],
    'guest-reboot': [
      'launch_accepted',
      'recovery_armed',
      'predecessor_stopped',
      'guest_power_cut',
      'guest_booted',
      'recovery_service_completed',
      'pm2_started',
      'service_healthy',
      'terminal_observed',
    ],
  };
  const isolationOverlay = isolation.overlays.find(
    (entry: any) => entry.drill === drill,
  );
  const initialGuestBoot = isolationOverlay.readinessBootIdSha256;
  const rebootedGuestBoot = digest(`${drill}-guest-boot-after-fault-reboot`);
  const postTerminalGuestBoot = digest(`${drill}-guest-boot-after-clean-reboot`);
  const start = fixtureNow - startOffsetMinutes * 60 * 1000;
  const timeline = events[drill].map((event, index) => ({
    event,
    observedAt: iso(start + index * 5_000),
    observerMonotonicMs: 1_000_000 + sequence * 100_000 + index * 5_000,
    observerBootIdSha256: plan.controller.bootIdSha256,
    guestBootIdSha256: drill === 'guest-reboot' && index >= events[drill].indexOf('guest_booted')
      ? rebootedGuestBoot
      : initialGuestBoot,
  }));
  const completes = drill === 'ssh-loss';
  return {
    schema: 'nexus.rollback-drill-kvm-outcome.v1',
    planId: plan.planId,
    drill,
    overlayId: plan.overlays.find((entry: any) => entry.drill === drill).overlayId,
    transactionId: `20260724T12000${sequence}Z-${sequence}-${String(sequence).repeat(12)}`,
    requestSha256: digest(`${drill}-request`),
    controlVersion: 'nexus-release-promotion-control.v3',
    terminalStatus: completes ? 'completed' : 'recovered',
    secondLaunchObserved: false,
    productionEvidenceEmitted: false,
    exactTargetHealthy: completes,
    exactPredecessorRestored: !completes,
    databaseBackupRestored: !completes,
    journalSha256: digest(`${drill}-journal`),
    recoveryResultSha256: digest(`${drill}-recovery-result`),
    postTerminalReboot: drill === 'guest-reboot'
      ? {
          beforeGuestBootIdSha256: rebootedGuestBoot,
          afterGuestBootIdSha256: postTerminalGuestBoot,
          journalSha256: digest(`${drill}-journal`),
          controlVersion: 'nexus-release-promotion-control.v3',
          recoveryUnitResult: 'success',
          assertRootPm2Ready: true,
          assertIdle: true,
          exactRuntimeHealthy: true,
        }
      : null,
    timeline,
  };
}

export function makeKvmDrillFixture(nowMs = Date.now()) {
  const guestOwner = generateKeyPairSync('ed25519');
  const productionOwner = generateKeyPairSync('ed25519');
  const releaseEvidence = generateKeyPairSync('ed25519');
  const guestOwnerPublicKeyPem = guestOwner.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const productionOwnerPublicKeyPem = productionOwner.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const releaseEvidencePublicKeyPem = releaseEvidence.publicKey.export({
    type: 'spki',
    format: 'pem',
  }).toString();
  const guestSshClientPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuestClientOnly drill@guest';
  const productionSshClientPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProductionClient prod@server';
  const guestSshHostPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuestHostOnly root@guest';
  const productionSshHostPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProductionHost root@server';
  const planId = 'kvm-drill-20260724T120000Z-abcdef123456';
  const baselineSnapshotSha256 = digest('canonical-ubuntu-baseline');
  const targetSha = '3a49f86564f5e9f9523397debb1cf54cecab391c';
  const plan = {
    schema: 'nexus.rollback-drill-kvm-plan.v1',
    planId,
    createdAt: iso(nowMs - 60 * 60 * 1000),
    expiresAt: iso(nowMs + 6 * 60 * 60 * 1000),
    mode: 'isolated-kvm-first-drill',
    sourceRootSha: targetSha,
    controller: {
      machineIdSha256: digest('serverdominguez-machine-id'),
      bootIdSha256: digest('serverdominguez-boot-id'),
    },
    release: {
      sourceSha: '36b96fab8d0987696ccd7e2ca35a343bca32da2f',
      targetSha,
      sourceVersion: '4.14.230',
      targetVersion: '4.14.231',
      targetBackup: 'nexus-release-4.14.231.tar.zst',
      productionBase: '/srv/nexus-release/production',
      stateRoot: '/var/lib/nexus-release-promotion',
      backupDir: '/home/dominguez/backups/nexushub',
      preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-kvmdrill',
      pm2Bin: '/usr/local/bin/pm2',
      publicBaseUrl: 'https://rollback-drill.invalid',
    },
    guest: {
      virtualization: 'kvm',
      osId: 'ubuntu',
      osVersionId: '24.04',
      architecture: 'x86_64',
      minimumMemoryAvailableBytes: 12 * 1024 ** 3,
      minimumDiskAvailableBytes: 20 * 1024 ** 3,
      requiredPm2Apps: [
        'nexus-hub',
        'content-engine',
        'nexus-hub-staging',
        'content-engine-staging',
      ],
    },
    trust: {
      guestOwnerPublicKeySha256: publicKeyIdentity(guestOwnerPublicKeyPem),
      productionOwnerPublicKeySha256: publicKeyIdentity(productionOwnerPublicKeyPem),
      guestSshClientPublicKeySha256: textKeyIdentity(guestSshClientPublicKey),
      productionSshClientPublicKeySha256: textKeyIdentity(productionSshClientPublicKey),
      guestSshHostPublicKeySha256: textKeyIdentity(guestSshHostPublicKey),
      productionSshHostPublicKeySha256: textKeyIdentity(productionSshHostPublicKey),
      releaseEvidencePublicKeySha256: publicKeyIdentity(releaseEvidencePublicKeyPem),
    },
    labStorage: {
      provider: 'cloudflare-r2',
      isolation: 'guest-drill-only',
      endpoint: 'https://lab-storage.example.invalid',
      bucket: 'nexus-drill-lab',
      prefix: `nexus-rollback-drill/${planId}`,
      credentialsScope: 'guest-drill-only',
      syntheticOnly: true,
      productionObjectsAccessible: false,
      versioningEnabled: true,
      encryptionRequired: true,
    },
    syntheticDatabase: {
      path: '/srv/nexus-drill-lab/data/synthetic.db',
      marker: `NEXUS_SYNTHETIC_DRILL:${planId}`,
      seedSha256: digest('synthetic-database-seed'),
      origin: 'generated-in-guest',
      syntheticOnly: true,
      productionRowsPresent: false,
    },
    overlays: [
      {
        drill: 'ssh-loss',
        overlayId: 'overlay-ssh-loss-111111111111',
        overlayInitialSha256: digest('ssh-loss-overlay'),
        baselineSnapshotSha256,
        machineUuid: '11111111-1111-4111-8111-111111111111',
        ssh: {
          host: '127.0.0.1',
          port: 22221,
          user: 'dominguez',
          hostPublicKeySha256: textKeyIdentity(guestSshHostPublicKey),
        },
      },
      {
        drill: 'failed-health',
        overlayId: 'overlay-failed-health-222222222222',
        overlayInitialSha256: digest('failed-health-overlay'),
        baselineSnapshotSha256,
        machineUuid: '22222222-2222-4222-8222-222222222222',
        ssh: {
          host: '127.0.0.1',
          port: 22222,
          user: 'dominguez',
          hostPublicKeySha256: textKeyIdentity(guestSshHostPublicKey),
        },
      },
      {
        drill: 'guest-reboot',
        overlayId: 'overlay-guest-reboot-333333333333',
        overlayInitialSha256: digest('guest-reboot-overlay'),
        baselineSnapshotSha256,
        machineUuid: '33333333-3333-4333-8333-333333333333',
        ssh: {
          host: '127.0.0.1',
          port: 22223,
          user: 'dominguez',
          hostPublicKeySha256: textKeyIdentity(guestSshHostPublicKey),
        },
      },
    ],
    interfaces: {
      promotionControl: '/usr/local/sbin/nexus-release-promotion-control',
      restoreDrill: '/usr/local/libexec/nexus-application-dr/application-dr-restore-drill.sh',
      promotionAuthorization: '/usr/local/libexec/nexus-promotion-authorization.mjs',
      controlVersion: 'nexus-release-promotion-control.v3',
      recoveryUnit: 'nexus-release-promotion-recovery.service',
    },
  };

  const authorizationPayload = {
    schema: 'nexus.rollback-drill-kvm-owner-authorization-payload.v1',
    action: 'run-isolated-kvm-rollback-drills',
    planId,
    planSha256: digest(canonicalJson(plan)),
    targetSha: plan.release.targetSha,
    targetVersion: plan.release.targetVersion,
    guestOwnerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    endpoints: plan.overlays.map((overlay) => ({
      drill: overlay.drill,
      host: overlay.ssh.host,
      port: overlay.ssh.port,
      hostPublicKeySha256: overlay.ssh.hostPublicKeySha256,
    })),
    approvedAt: iso(nowMs - 50 * 60 * 1000),
    expiresAt: iso(nowMs + 5 * 60 * 60 * 1000),
  };
  const authorization = {
    schema: 'nexus.rollback-drill-kvm-owner-authorization.v1',
    keyId: `sha256:${plan.trust.guestOwnerPublicKeySha256}`,
    signatureAlgorithm: 'ed25519',
    payload: authorizationPayload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(authorizationPayload)),
      guestOwner.privateKey,
    ).toString('base64'),
  };

  const isolation = {
    schema: 'nexus.rollback-drill-kvm-isolation.v1',
    planId,
    capturedAt: iso(nowMs - 40 * 60 * 1000),
    hypervisor: {
      machineIdSha256: plan.controller.machineIdSha256,
      bootIdSha256: plan.controller.bootIdSha256,
      virtualization: 'qemu-kvm',
      manager: 'qemu-systemd',
      devices: [
        {
          type: 'disk',
          source: '/var/lib/nexus-rollback-drill-vm/sets/fixture/guest-1/root.qcow2',
          target: 'vda',
          mode: 'overlay',
        },
        {
          type: 'network',
          source: 'qemu-user-restrict',
          target: 'virtio',
          mode: 'nat',
        },
      ],
    },
    guest: {
      machineIdSha256: digest('guest-1-machine-id'),
      bootIdSha256: digest('guest-1-initial-boot-id'),
      virtualization: 'kvm',
      osId: 'ubuntu',
      osVersionId: '24.04',
      architecture: 'x86_64',
      memoryAvailableBytes: 16 * 1024 ** 3,
      diskAvailableBytes: 64 * 1024 ** 3,
      kernelLogReadable: true,
      mounts: [
        {
          target: '/',
          source: '/dev/vda2',
          fileSystemType: 'ext4',
          options: ['rw', 'relatime'],
        },
      ],
      listeners: [
        { host: '127.0.0.1', port: 8200, process: 'nexus-hub' },
        { host: '127.0.0.1', port: 8100, process: 'content-engine' },
        { host: '127.0.0.1', port: 8201, process: 'nexus-hub-staging' },
        { host: '127.0.0.1', port: 8101, process: 'content-engine-staging' },
      ],
      pm2Apps: plan.guest.requiredPm2Apps.map((name) => ({
        name,
        status: 'online',
        restartCount: 0,
      })),
      canonicalPaths: {
        productionBase: plan.release.productionBase,
        stateRoot: plan.release.stateRoot,
        backupDir: plan.release.backupDir,
        preparedRuntimeDir: plan.release.preparedRuntimeDir,
        pm2Bin: plan.release.pm2Bin,
      },
      keyIdentities: {
        ownerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
        sshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
        sshHostPublicKeySha256: plan.trust.guestSshHostPublicKeySha256,
        releaseEvidencePublicKeySha256: plan.trust.releaseEvidencePublicKeySha256,
      },
      syntheticDatabase: {
        path: plan.syntheticDatabase.path,
        marker: plan.syntheticDatabase.marker,
        seedSha256: plan.syntheticDatabase.seedSha256,
        syntheticOnly: true,
        productionRowsPresent: false,
      },
      productionDataMatches: [],
    },
    overlays: plan.overlays.map((overlay, index) => ({
      drill: overlay.drill,
      overlayId: overlay.overlayId,
      overlayInitialSha256: overlay.overlayInitialSha256,
      baselineSnapshotSha256: overlay.baselineSnapshotSha256,
      machineUuid: overlay.machineUuid,
      sshHostPublicKeySha256: overlay.ssh.hostPublicKeySha256,
      guestMachineIdSha256: digest(`guest-${index + 1}-machine-id`),
      readinessBootIdSha256: digest(`guest-${index + 1}-initial-boot-id`),
    })),
  };

  const pre = compatibility('pre');
  const post = compatibility('post');
  const epoch = Math.floor((nowMs - 31 * 60 * 1000) / 1000);
  const restore = {
    schemaVersion: 'NexusApplicationRestoreDrillV1',
    databaseKey: `${plan.labStorage.prefix}/database/hourly/synthetic.db.gz`,
    releaseKey: `${plan.labStorage.prefix}/releases/${plan.release.targetBackup}`,
    databaseSha256: digest('restored-database-backup'),
    releaseSha256: digest('restored-release-backup'),
    sqliteIntegrityVerified: true,
    exactReleaseBundleVerified: true,
    exactSignedRecoveryArtifactVerified: true,
    releaseManifestSha256: digest('release-manifest'),
    stagingAttestationSha256: digest('staging-attestation'),
    runtimeSha: plan.release.targetSha,
    artifactDigest: digest('release-artifact'),
    installedRuntimeDigest: digest('installed-runtime'),
    recoveryRuntimeDigest: digest('recovery-runtime'),
    relocatableInstalledTreeVerified: true,
    networkIndependentDependenciesVerified: true,
    dependencyInstallNetworkNamespaceVerified: true,
    recoveryRuntimeVerificationUnprivileged: true,
    recoveryRuntimeVerificationNetworkNamespaceVerified: true,
    preMigrationReleaseDatabaseCompatibility: pre,
    postMigrationReleaseDatabaseCompatibility: post,
    releaseDatabaseCompatibility: structuredClone(post),
    postMigrationSqliteIntegrityVerified: true,
    postMigrationWalStateCapturedByOnlineBackup: true,
    postMigrationDatabaseSha256: digest('post-migration-database'),
    isolatedBootVerified: true,
    isolatedNetworkNamespaceVerified: true,
    invalidCredentialRejected: true,
    representativeRestoredDatabaseReadVerified: true,
    nodeBackendBootVerified: true,
    contentEngineBootVerified: true,
    contentEngineHealthVerified: true,
    processIdentities: {
      nodeBackend: {
        pidNamespaceProcessId: 101,
        runtimePath: 'dist/index.js',
        runtimeSha256: digest('node-runtime'),
      },
      contentEngine: {
        pidNamespaceProcessId: 102,
        runtimePath: 'content-engine/main.py',
        runtimeSha256: digest('content-runtime'),
      },
    },
    applicationSmokeHarnessVerified: true,
    rpoSeconds: 600,
    rpoTargetSeconds: 3600,
    rpoEvidenceScope: 'selected-database-object-storage-timestamp-consistency',
    rpoEvidenceBasis: 'oldest-of-key-created-epoch-and-s3-last-modified',
    rpoSignedProvenanceVerified: false,
    databaseTimestampEvidence: {
      metadataCreatedEpoch: epoch + 10,
      keyTimestampEpoch: epoch,
      s3LastModifiedEpoch: epoch + 5,
      conservativeEpoch: epoch,
    },
    objectVersionEvidence: {
      provider: 'cloudflare-r2',
      databaseVersionId: null,
      releaseVersionId: null,
      exactVersionDownloadVerified: false,
      approvedUnversionedVariance: true,
    },
    technicalRestoreSeconds: 300,
    technicalRestoreTargetSeconds: 1800,
    technicalRestoreScope: 'selected-object-download-through-isolated-application-smoke',
    completedAt: iso(nowMs - 30 * 60 * 1000),
  };
  const outcomes = {
    'ssh-loss': outcome(nowMs, plan, isolation, 'ssh-loss', 1, 20),
    'failed-health': outcome(nowMs, plan, isolation, 'failed-health', 2, 15),
    'guest-reboot': outcome(nowMs, plan, isolation, 'guest-reboot', 3, 10),
  };
  const keys = {
    guestOwnerPublicKeyPem,
    productionOwnerPublicKeyPem,
    guestSshClientPublicKey,
    productionSshClientPublicKey,
    guestSshHostPublicKey,
    productionSshHostPublicKey,
    releaseEvidencePublicKeyPem,
  };
  return {
    nowMs,
    plan,
    authorization,
    isolation,
    restore,
    outcomes,
    keys,
  };
}

export function writeKvmDrillFixture(root: string, fixture: ReturnType<typeof makeKvmDrillFixture>) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const files: Record<string, string | object> = {
    'plan.json': fixture.plan,
    'authorization.json': fixture.authorization,
    'isolation.json': fixture.isolation,
    'restore.json': fixture.restore,
    'ssh-loss.json': fixture.outcomes['ssh-loss'],
    'failed-health.json': fixture.outcomes['failed-health'],
    'guest-reboot.json': fixture.outcomes['guest-reboot'],
    'guest-owner.pem': fixture.keys.guestOwnerPublicKeyPem,
    'production-owner.pem': fixture.keys.productionOwnerPublicKeyPem,
    'guest-ssh-client.pub': fixture.keys.guestSshClientPublicKey,
    'production-ssh-client.pub': fixture.keys.productionSshClientPublicKey,
    'guest-ssh-host.pub': fixture.keys.guestSshHostPublicKey,
    'production-ssh-host.pub': fixture.keys.productionSshHostPublicKey,
    'release-evidence.pem': fixture.keys.releaseEvidencePublicKeyPem,
  };
  for (const [name, body] of Object.entries(files)) {
    const value = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`;
    fs.writeFileSync(path.join(root, name), value, { mode: 0o600, flag: 'wx' });
  }
}
