import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const control = path.resolve('scripts/remote-promotion-control.sh');
const broker = path.resolve('scripts/remote-promotion-worker-control.sh');
const runner = path.resolve('scripts/remote-promotion-transaction.sh');
const authorization = path.resolve('scripts/promotion-authorization.mjs');
const promotion = path.resolve('scripts/promote-exact-release.sh');
const installer = path.resolve('scripts/remote-promotion-systemd-install.sh');
const trustedAttestor = path.resolve('scripts/trusted-release-runtime-attestation.mjs');
const unit = path.resolve('scripts/systemd/nexus-release-promotion@.service');
const recoveryUnit = path.resolve('scripts/systemd/nexus-release-promotion-recovery.service');
const migrationGate = path.resolve('scripts/complete-promotion-migration-gate.mjs');
const layoutAuthorization = path.resolve('scripts/release-layout-authorization.mjs');

const canonicalJson = (input: unknown): string => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  const value = input as Record<string, unknown>;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};

function layoutDrillPayloadFixture(
  source: Record<string, unknown>,
  migrationId: string,
  now: number,
) {
  const scenarioIds = [
    'failed_health_check',
    'host_reboot_during_migration',
    'ssh_disconnect_after_pm2_stop',
  ] as const;
  const hypervisor = generateKeyPairSync('ed25519');
  const guests = scenarioIds.map(() => generateKeyPairSync('ed25519'));
  const publicPem = (key: KeyObject) => (
    key.export({ format: 'pem', type: 'spki' }).toString()
  );
  const digest = (value: Buffer | string) => (
    createHash('sha256').update(value).digest('hex')
  );
  const completedAt = new Date(now - 60_000).toISOString();
  const hypervisorProducer = {
    controllerPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/'
      + 'release-layout-fault-controller',
    controllerSha256: '7'.repeat(64),
    controllerRecoveryUnitPath:
      '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service',
    controllerRecoveryUnitSha256: '6'.repeat(64),
    controllerUnitPath:
      '/etc/systemd/system/nexus-release-layout-fault-drill@.service',
    controllerUnitSha256: '8'.repeat(64),
    verifierPath:
      '/usr/local/libexec/nexus-rollback-drill-vm/'
      + 'release-layout-fault-drill.mjs',
    verifierSha256: '9'.repeat(64),
  };
  const guestProducer = {
    executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
    executorSha256: 'a'.repeat(64),
    recoveryUnitPath:
      '/etc/systemd/system/'
      + 'nexus-release-layout-fault-guest-recovery.service',
    recoveryUnitSha256: 'b'.repeat(64),
  };
  const guestHostKeyDigests = [
    '3'.repeat(64),
    '1'.repeat(64),
    '2'.repeat(64),
  ];
  const provisionReceipt = {
    schema: 'nexus.rollback-drill-vm-provision.v2',
    setId: 'e'.repeat(64),
    image: {
      filename: 'noble-server-cloudimg-amd64.img',
      sha256: 'c'.repeat(64),
    },
    sshPublicKeySha256: 'd'.repeat(64),
    guestSshHostPublicKeySha256s: guestHostKeyDigests,
    ports: [2221, 2222, 2223],
    setDirectory: `/var/lib/nexus-rollback-drill-vm/sets/${'e'.repeat(64)}`,
    runtimeReadiness: {
      status: 'ready',
      drillReady: true,
    },
    hypervisor: {
      qemuSha256: 'f'.repeat(64),
      runnerSha256: 'd'.repeat(64),
      faultDrillControllerSha256: hypervisorProducer.controllerSha256,
      faultDrillControllerUnitSha256:
        hypervisorProducer.controllerUnitSha256,
      faultDrillControllerRecoveryUnitSha256:
        hypervisorProducer.controllerRecoveryUnitSha256,
      faultDrillVerifierSha256: hypervisorProducer.verifierSha256,
      faultDrillGuestExecutorSha256: guestProducer.executorSha256,
      faultDrillGuestRecoveryUnitSha256:
        guestProducer.recoveryUnitSha256,
    },
    guests: guestHostKeyDigests.map((hostPublicKeySha256, index) => ({
      name: `guest-${index + 1}`,
      hostPublicKeySha256,
    })),
    createdAt: completedAt,
  };
  const provisionReceiptBody = Buffer.from(
    `${JSON.stringify(provisionReceipt, null, 2)}\n`,
  );
  const guestIds = {
    failed_health_check: 'guest-2',
    host_reboot_during_migration: 'guest-3',
    ssh_disconnect_after_pm2_stop: 'guest-1',
  } as const;
  const trustManifest = {
    schema: 'nexus.release-layout-kvm-trust.v1',
    provision: {
      schema: provisionReceipt.schema,
      setId: provisionReceipt.setId,
      receiptSha256: digest(provisionReceiptBody),
    },
    hypervisor: {
      publicKeyPem: publicPem(hypervisor.publicKey),
      publicKeySha256: digest(publicPem(hypervisor.publicKey)),
      qemuSha256: 'f'.repeat(64),
      runnerSha256: 'd'.repeat(64),
      ...hypervisorProducer,
    },
    guests: Object.fromEntries(scenarioIds.map((scenarioId, index) => [
      scenarioId,
      {
        guestId: guestIds[scenarioId],
        publicKeyPem: publicPem(guests[index].publicKey),
        publicKeySha256: digest(publicPem(guests[index].publicKey)),
        sshHostPublicKeySha256: String(index + 1).repeat(64),
        ...guestProducer,
      },
    ])),
    createdAt: completedAt,
  };
  const trustManifestBody = Buffer.from(
    `${JSON.stringify(trustManifest, null, 2)}\n`,
  );
  const plan = {
    schema: 'nexus.release-layout-fault-drill-plan.v1',
    planId: 'fedcba98-7654-4321-8fed-cba987654321',
    migrationId,
    challengeNonce: '0'.repeat(64),
    source,
    trust: {
      trustManifestSha256: digest(trustManifestBody),
      provisionSetId: provisionReceipt.setId,
      provisionReceiptSha256: digest(provisionReceiptBody),
      hypervisorEd25519PublicKey: publicPem(hypervisor.publicKey),
      guestEd25519PublicKeys: Object.fromEntries(
        scenarioIds.map((scenarioId, index) => [
          scenarioId,
          publicPem(guests[index].publicKey),
        ]),
      ),
      guestIds,
      producers: {
        hypervisor: hypervisorProducer,
        guests: Object.fromEntries(
          scenarioIds.map((scenarioId) => [scenarioId, guestProducer]),
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
    scenarios: scenarioIds.map((scenarioId, index) => ({
      id: scenarioId,
      order: index + 1,
      fault: scenarioId,
      expectedTerminalStatus: 'recovered',
      productionEvidenceAllowed: false,
    })),
    promotionAllowed: false,
    createdAt: new Date(now - 120_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  };
  const planSha256 = digest(canonicalJson(plan));
  const sourceSha256 = digest(canonicalJson(source));
  const scenarios = scenarioIds.map((scenarioId, index) => {
    const digit = String(index + 1);
    const bootBefore = `${digit.repeat(8)}-${digit.repeat(4)}-`
      + `${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}`;
    const bootAfter = scenarioId === 'host_reboot_during_migration'
      ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      : bootBefore;
    const durationMilliseconds = 1000 + index;
    const execution = {
      schema: 'nexus.release-layout-guest-execution-evidence.v1',
      planId: plan.planId,
      planSha256,
      challengeNonce: plan.challengeNonce,
      migrationId,
      scenarioId,
      controlVersion: 'nexus-release-layout-fault-guest.v1',
      executionMode: 'strictly-sequential',
      testMode: false,
      productionEvidenceEmitted: false,
      promotionControlInvoked: false,
      faultInjected: scenarioId,
      terminalStatus: 'recovered',
      exactPredecessorRestored: true,
      databaseRecoveryVerified: true,
      healthRestored: true,
      connectionDropped: scenarioId !== 'failed_health_check',
      observer: {
        bootId: '11111111-2222-3333-4444-555555555555',
        startMonotonicMilliseconds: 10000,
        endMonotonicMilliseconds: 10000 + durationMilliseconds,
        durationMilliseconds,
        targetMilliseconds: 120000,
      },
      guest: {
        bootIdBefore: bootBefore,
        bootIdAfter: bootAfter,
      },
      producer: plan.trust.producers.guests[scenarioId],
      faultObservation: {
        journalSha256: digit.repeat(64),
        predecessorSha256: 'c'.repeat(64),
        restoredSha256: 'c'.repeat(64),
        databaseBeforeSha256: 'd'.repeat(64),
        databaseAfterSha256: 'd'.repeat(64),
        candidateHealthFailureObserved:
          scenarioId === 'failed_health_check',
        processStoppedObserved: true,
        durableRecoveryArmed: true,
      },
      completedAt,
    };
    const executionBody = Buffer.from(`${JSON.stringify(execution, null, 2)}\n`);
    const isolation = {
      schema: 'nexus.release-layout-hypervisor-isolation-evidence.v1',
      planId: plan.planId,
      planSha256,
      challengeNonce: plan.challengeNonce,
      scenarioId,
      guestId: guestIds[scenarioId],
      hypervisor: 'qemu-kvm',
      kvmAcceleration: true,
      independentOverlay: true,
      loopbackSshOnly: true,
      productionDataMounted: false,
      productionSecretsPresent: false,
      productionNetworkReachable: false,
      executionEvidenceSha256: digest(executionBody),
      observer: execution.observer,
      guest: execution.guest,
      producer: plan.trust.producers.hypervisor,
      faultObservation: {
        systemdUnit:
          `nexus-rollback-drill-vm@${guestIds[scenarioId]}.service`,
        qemuMainPid: 1000 + index,
        qemuCommandLineSha256: digit.repeat(64),
        guestSshHostPublicKeySha256: digit.repeat(64),
        sshDisconnectObserved:
          scenarioId === 'ssh_disconnect_after_pm2_stop',
        guestRebootObserved:
          scenarioId === 'host_reboot_during_migration',
      },
      createdAt: completedAt,
    };
    const isolationBody = Buffer.from(`${JSON.stringify(isolation, null, 2)}\n`);
    const result = {
      schema: 'nexus.release-layout-fault-scenario-result.v2',
      producerVersion: 'nexus-release-layout-fault-drill.v1',
      planId: plan.planId,
      planSha256,
      migrationId,
      scenarioId,
      status: 'passed',
      sourceSha256,
      proof: {
        schema: 'nexus.release-layout-kvm-proof.v1',
        challengeNonce: plan.challengeNonce,
        hypervisorPublicKeySha256: digest(publicPem(hypervisor.publicKey)),
        guestPublicKeySha256: digest(publicPem(guests[index].publicKey)),
        isolationEvidenceBase64: isolationBody.toString('base64'),
        isolationSignatureBase64: cryptoSign(
          null,
          isolationBody,
          hypervisor.privateKey,
        ).toString('base64'),
        executionEvidenceBase64: executionBody.toString('base64'),
        executionSignatureBase64: cryptoSign(
          null,
          executionBody,
          guests[index].privateKey,
        ).toString('base64'),
      },
      isolation: {
        hypervisor: 'qemu-kvm',
        kvmAcceleration: true,
        independentOverlay: true,
        loopbackSshOnly: true,
        guestId: isolation.guestId,
      },
      recovery: {
        observerBootId: execution.observer.bootId,
        durationMilliseconds,
        targetMilliseconds: 120000,
        terminalStatus: 'recovered',
        guestBootIdBefore: bootBefore,
        guestBootIdAfter: bootAfter,
        exactPredecessorRestored: true,
        databaseRecoveryVerified: true,
        healthRestored: true,
        connectionDropped: execution.connectionDropped,
      },
      producerTrust: {
        controllerSha256: hypervisorProducer.controllerSha256,
        controllerRecoveryUnitSha256:
          hypervisorProducer.controllerRecoveryUnitSha256,
        controllerUnitSha256:
          hypervisorProducer.controllerUnitSha256,
        guestExecutorSha256: guestProducer.executorSha256,
        guestRecoveryUnitSha256: guestProducer.recoveryUnitSha256,
      },
      isolationEvidenceSha256: digest(isolationBody),
      executionEvidenceSha256: digest(executionBody),
      completedAt,
      recordedAt: new Date(now - 30_000).toISOString(),
    };
    return {
      id: scenarioId,
      status: 'passed',
      resultSha256: digest(canonicalJson(result)),
      result,
    };
  });
  return {
    payload: {
      schema: 'nexus.release-layout-fault-drill.v1',
      proofSchema: 'nexus.release-layout-kvm-proof.v1',
      migrationId,
      source,
      plan,
      planSha256,
      scenarios,
      maximumRecoverySeconds: 2,
      completedAt,
    },
    provisionReceiptBody,
    trustManifestBody,
  };
}

describe('persistent systemd promotion transaction v2', () => {
  let root: string;
  let stateRoot: string;
  let requestPath: string;
  let envelopePath: string;
  let publicKeyPath: string;
  let privateKeyPath: string;
  let authWrapper: string;
  let systemctlLog: string;
  let systemctlActive: string;
  let drBackupBin: string;
  let drConfig: string;
  let drBackupLock: string;
  let drSystemctlBin: string;
  let v3ControlFixtureEnv: NodeJS.ProcessEnv;
  let cleanupV3ControlFixtures: () => void = () => {};
  let selectorFixtureRuntimes: string[] = [];
  const id = '20260722T120000Z-1234-abcdef123456';
  const releaseManifestBody = Buffer.from('{"schema":"nexus.release-manifest.v2"}\n');
  const stagingAttestationBody = Buffer.from('{"schema":"nexus.staging-attestation.v1"}\n');
  const preMutationRecoveryConfirmedAt = '2026-07-22T11:59:58.000Z';
  const preMutationDatabaseConfirmedAt = '2026-07-22T11:59:59.000Z';

  function recoveryProof(
    runtime: string,
    escrowId = id,
    overrides: Record<string, unknown> = {},
  ) {
    const plaintextSha256 = '8'.repeat(64);
    return {
      path: runtime,
      plaintextSha256,
      encryptedSha256: '5'.repeat(64),
      encryptedSizeBytes: 3584,
      objectKey: `nexus/releases/v4.14.231+current-${'b'.repeat(40)}`
        + `+escrow-${escrowId}+phase-pre-mutation.tar.gz.${plaintextSha256}.age`,
      runtimeSha: 'b'.repeat(40),
      artifactDigest: 'c'.repeat(64),
      installedRuntimeDigest: 'd'.repeat(64),
      recoveryRuntimeDigest: '9'.repeat(64),
      releaseManifestSha256: createHash('sha256').update(releaseManifestBody).digest('hex'),
      stagingAttestationSha256: createHash('sha256').update(stagingAttestationBody).digest('hex'),
      escrowId,
      escrowPhase: 'pre-mutation',
      confirmedAt: preMutationRecoveryConfirmedAt,
      retainUntil: new Date(
        Date.parse(preMutationRecoveryConfirmedAt) + 91 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      objectVersionId: '--opaque-recovery-pre-✓|1',
      retentionVariance: null,
      approvedUnversionedVariance: false,
      confirmed: true,
      ...overrides,
    };
  }

  function writePreflightRecoveryFixture(
    runtime: string,
    requestSha256: string,
    overrides: Record<string, unknown> = {},
  ) {
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const output = path.join(authoritative, 'preflight-current-recovery.json');
    fs.writeFileSync(output, `${JSON.stringify({
      schema: 'nexus.pre-mutation-current-recovery-escrow.v2',
      status: 'passed',
      transactionId: id,
      requestSha256,
      capturedAt: '2026-07-22T12:02:01.000Z',
      storageControls: {
        provider: 'aws-s3',
        controlMode: 'versioned-s3',
        releasePrefixLockVerified: true,
      },
      currentRecoveryRuntime: recoveryProof(runtime, id, overrides),
      databaseRecoveryPoint: {
        objectKey: 'nexus/database/hourly/fixture.sqlite.age',
        plaintextSha256: '7'.repeat(64),
        encryptedSha256: '2'.repeat(64),
        encryptedSizeBytes: 1024,
        objectVersionId: '--opaque-database-pre-✓|2',
        confirmedAt: preMutationDatabaseConfirmedAt,
        retentionVariance: null,
        approvedUnversionedVariance: false,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  }

  function writeRootRecoveryIntent(
    authoritative: string,
    requestSha256: string,
    phase: 'pre_candidate' | 'candidate_authorized',
    backup?: {
      file: string;
      sha256: string;
      sizeBytes: number;
      databaseSha256: string;
    },
  ) {
    const output = path.join(authoritative, 'recovery-armed');
    fs.writeFileSync(output, `${JSON.stringify({
      schema: 'nexus.promotion-root-recovery-intent.v2',
      transactionId: id,
      requestSha256,
      phase,
      armedAt: '2026-07-22T12:00:00.000Z',
      ...(phase === 'candidate_authorized'
        ? {
            candidateAuthorizedAt: '2026-07-22T12:00:01.000Z',
            backup,
          }
        : { backup: null }),
    }, null, 2)}\n`, { mode: 0o600 });
  }

  function writeAwsDrFixture(file: string) {
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --verify-config "* ]]; then
  printf '%s\\n' 'application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=aws-s3 storageControlMode=versioned-s3 lifecyclePhase=enabled bootstrapReceipt=not-applicable releasePrefixLock=verified databaseRetentionPolicy=24-hourly,7-daily,4-weekly,6-monthly releaseRetentionPolicy=90-days'
  exit 0
fi
required=""
runtime=""
escrow_id=""
escrow_phase=""
descriptor=""
manifest=""
staging=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift 2 ;;
    --require-release) required="$2"; shift 2 ;;
    --require-recovery-runtime) runtime="$2"; shift 2 ;;
    --recovery-escrow-id) escrow_id="$2"; shift 2 ;;
    --recovery-escrow-phase) escrow_phase="$2"; shift 2 ;;
    --recovery-descriptor) descriptor="$2"; shift 2 ;;
    --recovery-release-manifest) manifest="$2"; shift 2 ;;
    --recovery-staging-attestation) staging="$2"; shift 2 ;;
    --recovery-runtime-sha|--recovery-artifact-digest|--recovery-installed-runtime-digest|--recovery-runtime-digest) shift 2 ;;
    --json) shift ;;
    *) printf 'unexpected DR fixture argument: %s\\n' "$1" >&2; exit 64 ;;
  esac
done
[ "$escrow_id" = ${JSON.stringify(id)} ] || {
  printf 'unexpected recovery escrow ID: %s\\n' "$escrow_id" >&2
  exit 65
}
case "$escrow_phase" in pre-mutation|post-soak) ;; *) exit 65 ;; esac
if [ "$escrow_phase" = post-soak ] && [ -n "\${DR_ATTEMPT_LOG:-}" ]; then
  printf 'attempt\\n' >> "$DR_ATTEMPT_LOG"
  attempt_count="$(wc -l < "$DR_ATTEMPT_LOG" | tr -d ' ')"
  if [[ "\${DR_FAIL_ATTEMPTS:-0}" =~ ^[0-9]+$ ]] \
      && [ "$attempt_count" -le "\${DR_FAIL_ATTEMPTS:-0}" ]; then
    if [ -n "\${DR_DEGRADE_ON_FAILURE_MARKER:-}" ]; then
      : > "$DR_DEGRADE_ON_FAILURE_MARKER"
    fi
    printf 'simulated post-soak escrow transport failure\\n' >&2
    exit 74
  fi
fi
case "$descriptor" in
  */transactions/${id}/state/recovery-runtime-descriptor.json) ;;
  *) printf 'unexpected recovery descriptor: %s\\n' "$descriptor" >&2; exit 65 ;;
esac
[ -n "$runtime" ] && [ -f "$manifest" ] && [ -f "$staging" ] || exit 65
node - "$required" "$runtime" "$escrow_id" "$escrow_phase" "$manifest" "$staging" <<'NODE'
const crypto=require('crypto'),fs=require('fs');
const [required,runtime,escrowId,escrowPhase,manifest,staging]=process.argv.slice(2);
const digest=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plaintextSha256=process.env.DR_RUNTIME_PLAINTEXT_SHA256_OVERRIDE||'8'.repeat(64);
const postMutation=escrowPhase==='post-soak';
if(postMutation!==(required!==''))process.exit(65);
const effectiveEscrowId=process.env.DR_ESCROW_ID_OVERRIDE||escrowId;
const confirmedAt=postMutation
  ? new Date(Math.floor(Date.now()/1000)*1000).toISOString()
  : '2026-07-22T11:59:58.000Z';
const databaseConfirmedAt=postMutation
  ? confirmedAt
  : '2026-07-22T11:59:59.000Z';
const retainDays=Number(process.env.DR_RETAIN_DAYS||'91');
const retainUntil=new Date(Date.parse(confirmedAt)+retainDays*24*60*60*1000).toISOString();
const runtimeVersion=process.env.DR_OBJECT_VERSION_ID_OVERRIDE==='null'
  ? null
  : process.env.DR_OBJECT_VERSION_ID_OVERRIDE
    ||(postMutation
      ? '--opaque-recovery-current-✓|3'
      : '--opaque-recovery-pre-✓|1');
const runtimeEncryptedSha256=process.env.DR_RUNTIME_ENCRYPTED_SHA256_OVERRIDE==='invalid'
  ? null
  : (postMutation?'4':'5').repeat(64);
const runtimeEncryptedSizeBytes=Number(
  process.env.DR_RUNTIME_ENCRYPTED_SIZE_BYTES_OVERRIDE||(postMutation?'4096':'3584'),
);
const releaseProof=required ? {
  path:required,
  plaintextSha256:digest(required),
  encryptedSha256:'3'.repeat(64),
  encryptedSizeBytes:2048,
  objectKey:'nexus/releases/'+required.split('/').pop()+'.'+digest(required)+'.age',
  confirmedAt,
  retainUntil,
  objectVersionId:'--opaque-release-✓|4',
  retentionVariance:null,
  approvedUnversionedVariance:false,
  confirmed:true,
} : null;
const recoveryProof={
  path:runtime,
  plaintextSha256,
  encryptedSha256:runtimeEncryptedSha256,
  encryptedSizeBytes:runtimeEncryptedSizeBytes,
  objectKey:'nexus/releases/v4.14.231+current-'+'b'.repeat(40)
    +'+escrow-'+effectiveEscrowId+'+phase-'+escrowPhase+'.tar.gz.'
    +plaintextSha256+'.age',
  runtimeSha:'b'.repeat(40),
  artifactDigest:'c'.repeat(64),
  installedRuntimeDigest:'d'.repeat(64),
  recoveryRuntimeDigest:'9'.repeat(64),
  releaseManifestSha256:digest(manifest),
  stagingAttestationSha256:digest(staging),
  escrowId:effectiveEscrowId,
  escrowPhase,
  confirmedAt,
  retainUntil,
  objectVersionId:runtimeVersion,
  retentionVariance:null,
  approvedUnversionedVariance:false,
  confirmed:true,
};
const result={
  schema:'nexus.application-dr-backup-result.v1',
  status:'passed',
  encrypted:true,
  storageProvider:'aws-s3',
  storageControlMode:'versioned-s3',
  releasePrefixLockVerified:true,
  databaseKey:'nexus/database/hourly/fixture.sqlite.age',
  databaseSha256:'7'.repeat(64),
  databaseEncryptedSha256:postMutation?'1'.repeat(64):'2'.repeat(64),
  databaseEncryptedSizeBytes:postMutation?1536:1024,
  databaseObjectVersionId:postMutation
    ? '--opaque-database-current-✓|5'
    : '--opaque-database-pre-✓|2',
  databaseConfirmedAt,
  databaseRetentionVariance:null,
  databaseApprovedUnversionedVariance:false,
  requiredRelease:releaseProof,
  requiredRecoveryRuntime:recoveryProof,
};
if(process.env.DR_INVALID_STORAGE_CONTROLS==='1'){
  delete result.storageProvider;
  delete result.storageControlMode;
  delete result.releasePrefixLockVerified;
}
process.stdout.write(JSON.stringify(result)+'\\n');
NODE
if [ -n "\${DR_COMPLETED_MARKER:-}" ]; then
  : > "$DR_COMPLETED_MARKER"
fi
`, { mode: 0o755 });
  }

  function writeDrLeaseFlockFixture(file: string) {
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -u ]; then exit 0; fi
[ -f "$NEXUS_PROMOTION_STATE_ROOT/active.json" ] || {
  printf 'promotion active marker was not durable before DR lease probe\\n' >&2
  exit 90
}
[[ " $* " == *" -E 75 "* ]] || {
  printf 'DR lease probe did not reserve conflict status 75\\n' >&2
  exit 91
}
printf 'probe\\n' >> "$DR_LEASE_PROBE_LOG"
probe_count="$(wc -l < "$DR_LEASE_PROBE_LOG" | tr -d ' ')"
if [ "$probe_count" -le "\${DR_BUSY_PROBES:-0}" ]; then exit 75; fi
exit 0
`, { mode: 0o755 });
  }

  function writeDrLeaseSystemctlFixture(file: string) {
    fs.writeFileSync(file, `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = is-active ] \
  && [ "\${2:-}" = nexus-application-dr-backup.service ] || exit 64
printf 'state-probe\\n' >> "$DR_SERVICE_PROBE_LOG"
probe_count="$(wc -l < "$DR_SERVICE_PROBE_LOG" | tr -d ' ')"
if [ "$probe_count" -le "\${DR_ACTIVE_PROBES:-0}" ]; then
  printf 'activating\\n'
  exit 3
fi
printf 'inactive\\n'
exit 3
`, { mode: 0o755 });
  }

  function writeV3ControlFixtures() {
    const digest = (value: Buffer | string) =>
      createHash('sha256').update(value).digest('hex');
    const writeJson = (file: string, value: unknown, mode = 0o600) => {
      const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      fs.writeFileSync(file, body, { mode });
      return body;
    };
    const privateKey = fs.readFileSync(privateKeyPath);
    const envelope = (
      kind: 'request' | 'fault-drill',
      payload: Record<string, unknown>,
    ) => ({
      schema: `nexus.release-layout-${kind}-envelope.v1`,
      keyId: 'nexus-owner-promotion-2026',
      signatureAlgorithm: 'ed25519',
      payload,
      signature: cryptoSign(
        null,
        Buffer.from(canonicalJson(payload)),
        privateKey,
      ).toString('base64'),
    });

    // GitHub's hosted toolcache may be owned by a provisioning UID that is
    // neither root nor the runner. Keep the ownership assertion deterministic
    // by attesting a fixture-owned launcher that delegates to the exact Node
    // binary used by the test process.
    const systemNode = path.join(root, 'bin', 'node-root-fixture');
    fs.writeFileSync(
      systemNode,
      `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o755 },
    );
    const trustedLock = path.join(root, 'pm2-package-lock.json');
    const trustedLockBody = writeJson(trustedLock, {
      name: 'nexus-pm2-root-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {},
    }, 0o644);
    const closureRoot = path.join(root, 'pm2-closure');
    const pm2PackageRoot = path.join(closureRoot, 'node_modules', 'pm2');
    const entrypoint = path.join(pm2PackageRoot, 'bin', 'pm2');
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o755 });
    for (const directory of [
      closureRoot,
      path.join(closureRoot, 'node_modules'),
      pm2PackageRoot,
      path.dirname(entrypoint),
    ]) fs.chmodSync(directory, 0o755);
    fs.writeFileSync(
      path.join(pm2PackageRoot, 'package.json'),
      '{"name":"pm2","version":"6.0.14"}\n',
      { mode: 0o644 },
    );
    fs.writeFileSync(
      entrypoint,
      '#!/usr/bin/env node\nprocess.stdout.write("fixture");\n',
      { mode: 0o755 },
    );
    const closureFiles = () => {
      const files: Array<{
        path: string;
        size: number;
        mode: number;
        sha256: string;
      }> = [];
      const walk = (directory: string) => {
        for (const name of fs.readdirSync(directory).sort()) {
          const absolute = path.join(directory, name);
          const stat = fs.lstatSync(absolute);
          if (stat.isDirectory()) walk(absolute);
          else if (stat.isFile()) {
            const body = fs.readFileSync(absolute);
            files.push({
              path: path.relative(closureRoot, absolute).split(path.sep).join('/'),
              size: body.length,
              mode: stat.mode & 0o7777,
              sha256: digest(body),
            });
          }
        }
      };
      walk(closureRoot);
      return files.sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    };
    const payloadFiles = closureFiles();
    const payloadDigest = digest(canonicalJson({
      schema: 'nexus.pm2-root-closure-payload.v1',
      files: payloadFiles,
    }));
    writeJson(path.join(closureRoot, 'closure-manifest.json'), {
      schema: 'nexus.pm2-root-closure-manifest.v1',
      pm2Version: '6.0.14',
      nodeVersion: 'v22.23.1',
      npmVersion: '10.9.8',
      packageLockSha256: digest(trustedLockBody),
      packageLockPackages: [],
      installedPackages: [],
      files: payloadFiles,
      fileCount: payloadFiles.length,
      payloadDigest,
    }, 0o644);
    const files = closureFiles();
    const closureDigest = digest(canonicalJson({
      schema: 'nexus.pm2-root-closure.v1',
      files,
    }));
    const launcher = path.join(root, 'bin', 'pm2-root');
    const launcherBody = Buffer.from(
      `#!/usr/bin/bash\nexec ${JSON.stringify(systemNode)} `
      + `${JSON.stringify(entrypoint)} "$@"\n`,
    );
    fs.writeFileSync(launcher, launcherBody, { mode: 0o755 });
    const pm2Attestation = path.join(root, 'pm2-root-install.v1.json');
    const pm2AttestationBody = writeJson(pm2Attestation, {
      schema: 'nexus.pm2-root-install.v1',
      version: '6.0.14',
      sourceArchiveSha256: '0'.repeat(64),
      closureRoot,
      closureDigest,
      payloadDigest,
      packageLockSha256: digest(trustedLockBody),
      launcher,
      launcherSha256: digest(launcherBody),
      entrypoint,
      node: {
        path: systemNode,
        version: 'v22.23.1',
        sha256: digest(fs.readFileSync(systemNode)),
      },
      fileCount: files.length,
      installedAt: new Date().toISOString(),
    });

    const releaseRoot = path.join(root, 'release-root');
    const productionBase = path.join(releaseRoot, 'production');
    const stagingBase = path.join(releaseRoot, 'staging');
    const productionRuntime = path.join(
      productionBase,
      'releases',
      `previous-${'a'.repeat(12)}`,
    );
    const stagingRuntime = path.join(
      stagingBase,
      'releases',
      `staging-${'b'.repeat(12)}`,
    );
    fs.mkdirSync(productionRuntime, { recursive: true, mode: 0o755 });
    fs.mkdirSync(stagingRuntime, { recursive: true, mode: 0o755 });
    fs.chmodSync(releaseRoot, 0o755);
    for (const base of [productionBase, stagingBase]) {
      fs.chmodSync(base, 0o1770);
      fs.chmodSync(path.join(base, 'releases'), 0o750);
    }
    const compatibilityHome = path.join(root, 'compat-home');
    const compatibilityProduction = path.join(compatibilityHome, 'production');
    const compatibilityStaging = path.join(compatibilityHome, 'staging');
    fs.mkdirSync(compatibilityHome, { mode: 0o755 });
    fs.chmodSync(compatibilityHome, 0o755);
    fs.symlinkSync(productionBase, compatibilityProduction);
    fs.symlinkSync(stagingBase, compatibilityStaging);
    const runtimeIdentities = {
      production: {
        runtimeSha: 'a'.repeat(40),
        artifactDigest: 'e'.repeat(64),
        installedRuntimeDigest: 'f'.repeat(64),
      },
      staging: {
        runtimeSha: 'b'.repeat(40),
        artifactDigest: 'c'.repeat(64),
        installedRuntimeDigest: 'd'.repeat(64),
      },
    };
    for (const [role, base, runtime] of [
      ['production', productionBase, productionRuntime],
      ['staging', stagingBase, stagingRuntime],
    ] as const) {
      writeJson(path.join(runtime, '.complete.json'), {
        runtimeSha: runtimeIdentities[role].runtimeSha,
        artifactDigest: runtimeIdentities[role].artifactDigest,
      }, 0o440);
      writeJson(path.join(runtime, '.nexus-installed-runtime.json'), {
        aggregateDigest: runtimeIdentities[role].installedRuntimeDigest,
      }, 0o440);
      fs.chmodSync(runtime, 0o550);
      fs.symlinkSync(runtime, path.join(base, 'current'));
    }
    const directoryIdentity = (directory: string) => {
      const stat = fs.lstatSync(directory, { bigint: true });
      return {
        path: directory,
        dev: String(stat.dev),
        ino: String(stat.ino),
      };
    };
    const releaseRootIdentity = directoryIdentity(releaseRoot);
    const filesystem = {
      production: {
        releaseRoot: releaseRootIdentity,
        base: directoryIdentity(productionBase),
        releases: directoryIdentity(path.join(productionBase, 'releases')),
      },
      staging: {
        releaseRoot: releaseRootIdentity,
        base: directoryIdentity(stagingBase),
        releases: directoryIdentity(path.join(stagingBase, 'releases')),
      },
    };
    const source = {
      production: {
        base: '/home/dominguez/telegram-hub-bot',
        ...runtimeIdentities.production,
      },
      staging: {
        base: '/home/dominguez/telegram-hub-bot-staging',
        ...runtimeIdentities.staging,
      },
    };
    const runtime = {
      production: productionRuntime,
      staging: stagingRuntime,
    };
    const readinessSha256 = {
      production: '1'.repeat(64),
      staging: '2'.repeat(64),
    };
    const unavailability = {
      schema: 'nexus.release-layout-unavailability.v1',
      targetMilliseconds: 120000,
      targetMet: true,
      timingBasis: 'same_boot_monotonic',
      start: {
        epochMs: 1_800_000_000_000,
        monotonicMs: 10_000,
        bootId: '11111111-1111-4111-8111-111111111111',
      },
      end: {
        epochMs: 1_800_000_001_000,
        monotonicMs: 11_000,
        bootId: '11111111-1111-4111-8111-111111111111',
      },
      durationMilliseconds: 1000,
    };
    const databaseRecovery = {
      recoveryPointSha256: '7'.repeat(64),
      recoveryPointSizeBytes: 4096,
      snapshotEvidenceSha256: '8'.repeat(64),
      stoppedBoundarySha256: '9'.repeat(64),
      stoppedBoundarySizeBytes: 4096,
      stoppedBoundaryEvidenceSha256: 'a'.repeat(64),
      stoppedBoundaryCopyEvidenceSha256: 'b'.repeat(64),
      restoredFromRecoveryPoint: false,
      integrityCheck: 'ok',
      foreignKeyCheck: 'ok',
    };
    const compatibilityStat = fs.lstatSync(compatibilityHome, { bigint: true });
    const compatibilityMountEquivalent = (link: string, target: string) => {
      const targetStat = fs.lstatSync(target, { bigint: true });
      const record = {
        kind: 'test-symlink-equivalent',
        path: link,
        target,
        findmnt: {
          source: 'test-equivalent',
          target: link,
          options: ['bind'],
        },
        mountIdentity: {
          dev: String(targetStat.dev),
          ino: String(targetStat.ino),
        },
        targetIdentity: {
          dev: String(targetStat.dev),
          ino: String(targetStat.ino),
        },
      };
      return {
        ...record,
        identitySha256: createHash('sha256').update(canonicalJson(record)).digest('hex'),
      };
    };
    const compatibility = {
      home: {
        path: compatibilityHome,
        dev: String(compatibilityStat.dev),
        ino: String(compatibilityStat.ino),
        uid: Number(compatibilityStat.uid),
        gid: Number(compatibilityStat.gid),
        mode: 0o755,
      },
      production: compatibilityMountEquivalent(compatibilityProduction, productionBase),
      staging: compatibilityMountEquivalent(compatibilityStaging, stagingBase),
    };
    const migrationId = '12345678-1234-4123-8123-123456789abc';
    const now = Date.now();
    const drillFixture = layoutDrillPayloadFixture(source, migrationId, now);
    const drillPayload = drillFixture.payload;
    const layoutKvmTrustManifest = path.join(
      root,
      'release-layout-evidence-trust.v1.json',
    );
    const layoutKvmProvisionReceipt = path.join(
      root,
      'rollback-drill-vm-active.json',
    );
    fs.writeFileSync(
      layoutKvmTrustManifest,
      drillFixture.trustManifestBody,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      layoutKvmProvisionReceipt,
      drillFixture.provisionReceiptBody,
      { mode: 0o640 },
    );
    const layoutDrill = path.join(root, 'layout-migration-fault-drill-envelope.v1.json');
    const layoutDrillBody = writeJson(
      layoutDrill,
      envelope('fault-drill', drillPayload),
    );
    const requestPayload = {
      schema: 'nexus.release-layout-migration-request.v1',
      migrationId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      ownerAuthorization: 'explicit',
      source,
      destination: {
        releaseRoot: '/srv/nexus-release',
        production: '/srv/nexus-release/production',
        staging: '/srv/nexus-release/staging',
      },
      pm2AttestationSha256: digest(pm2AttestationBody),
      faultDrillEnvelopeSha256: digest(layoutDrillBody),
    };
    const layoutRequest = path.join(root, 'layout-migration-request-envelope.v1.json');
    const layoutRequestBody = writeJson(
      layoutRequest,
      envelope('request', requestPayload),
    );
    const common = {
      migrationId,
      requestEnvelopeSha256: digest(layoutRequestBody),
      faultDrillEnvelopeSha256: digest(layoutDrillBody),
      pm2AttestationSha256: digest(pm2AttestationBody),
      source,
      runtime,
      filesystem,
      pm2DumpSha256: '6'.repeat(64),
      readinessSha256,
      unavailability,
      databaseRecovery,
      compatibility,
    };
    const layoutTerminal = path.join(root, 'layout-migration-terminal.v1.json');
    const layoutTerminalBody = writeJson(layoutTerminal, {
      schema: 'nexus.release-layout-migration-terminal-journal.v1',
      phase: 'completed',
      ...common,
    });
    const layoutResult = path.join(root, 'layout-migration-result.v1.json');
    const layoutResultBody = writeJson(layoutResult, {
      schema: 'nexus.release-layout-migration-result.v1',
      phase: 'passed',
      ...common,
      terminalJournalSha256: digest(layoutTerminalBody),
    });
    const layoutAttestation = path.join(root, 'layout-migration.v1.json');
    writeJson(layoutAttestation, {
      schema: 'nexus.release-layout-migration.v1',
      phase: 'passed',
      releaseRoot,
      productionBase,
      stagingBase,
      previous: {
        production: '/home/dominguez/telegram-hub-bot',
        staging: '/home/dominguez/telegram-hub-bot-staging',
      },
      soakSeconds: 60,
      requestEnvelopeSha256: digest(layoutRequestBody),
      faultDrillEnvelopeSha256: digest(layoutDrillBody),
      pm2AttestationSha256: digest(pm2AttestationBody),
      terminalJournalSha256: digest(layoutTerminalBody),
      resultSha256: digest(layoutResultBody),
      pm2DumpSha256: '6'.repeat(64),
      production: {
        currentRuntime: productionRuntime,
        ...runtimeIdentities.production,
        filesystem: filesystem.production,
      },
      staging: {
        currentRuntime: stagingRuntime,
        ...runtimeIdentities.staging,
        filesystem: filesystem.staging,
      },
      readinessSha256,
      unavailability,
      databaseRecovery,
      compatibility,
      completedAt: new Date(now).toISOString(),
    });
    const stagingBroker = path.join(root, 'bin', 'staging-attestation-broker');
    fs.writeFileSync(stagingBroker, `#!/usr/bin/env bash
set -euo pipefail
[ "$#" -eq 1 ] && [ "$1" = recover-all ] || {
  printf 'unexpected staging broker fixture invocation: %s\\n' "$*" >&2
  exit 64
}
`, { mode: 0o755 });
    cleanupV3ControlFixtures = () => {
      for (const runtimePath of [productionRuntime, stagingRuntime]) {
        if (fs.existsSync(runtimePath)) fs.chmodSync(runtimePath, 0o750);
      }
    };

    return {
      NEXUS_PROMOTION_WORKER_USER: os.userInfo().username,
      NEXUS_PROMOTION_RELEASE_ROOT: releaseRoot,
      NEXUS_PROMOTION_PRODUCTION_BASE: productionBase,
      NEXUS_PROMOTION_STAGING_BASE: stagingBase,
      NEXUS_PROMOTION_COMPAT_HOME: compatibilityHome,
      NEXUS_PROMOTION_COMPAT_PRODUCTION: compatibilityProduction,
      NEXUS_PROMOTION_COMPAT_STAGING: compatibilityStaging,
      NEXUS_PROMOTION_LAYOUT_ATTESTATION: layoutAttestation,
      NEXUS_PROMOTION_LAYOUT_RESULT: layoutResult,
      NEXUS_PROMOTION_LAYOUT_TERMINAL_JOURNAL: layoutTerminal,
      NEXUS_PROMOTION_LAYOUT_REQUEST: layoutRequest,
      NEXUS_PROMOTION_LAYOUT_DRILL: layoutDrill,
      NEXUS_PROMOTION_LAYOUT_AUTH_BIN: path.resolve(
        'scripts/release-layout-authorization.mjs',
      ),
      NEXUS_PROMOTION_LAYOUT_DRILL_VERIFY_BIN: path.resolve(
        'scripts/release-layout-fault-drill.mjs',
      ),
      NEXUS_PROMOTION_LAYOUT_KVM_TRUST_MANIFEST: layoutKvmTrustManifest,
      NEXUS_PROMOTION_LAYOUT_KVM_PROVISION_RECEIPT:
        layoutKvmProvisionReceipt,
      NEXUS_PROMOTION_LAYOUT_KVM_PROVISION_JOURNAL: path.join(
        root,
        'no-kvm-provision-journal',
      ),
      NEXUS_PROMOTION_PM2_ATTESTATION: pm2Attestation,
      NEXUS_PROMOTION_PM2_BIN: launcher,
      NEXUS_PROMOTION_NODE_BIN: systemNode,
      NEXUS_PROMOTION_PM2_TRUSTED_LOCK: trustedLock,
      NEXUS_PROMOTION_PM2_INSTALL_JOURNAL: path.join(
        root,
        'pm2-install-in-progress.absent',
      ),
      NEXUS_PROMOTION_STAGING_BROKER: stagingBroker,
      NEXUS_PROMOTION_SELECTOR_SWITCH: path.resolve(
        'scripts/remote-release-selector-switch.py',
      ),
    };
  }

  function hardenSelectorFixture(
    fixtureRoot: string,
    runtimes: string[],
  ) {
    const productionBase = path.join(fixtureRoot, 'production');
    fs.chmodSync(fixtureRoot, 0o755);
    fs.chmodSync(productionBase, 0o1770);
    fs.chmodSync(path.join(productionBase, 'releases'), 0o750);
    for (const runtimePath of runtimes) {
      fs.chmodSync(runtimePath, 0o550);
      selectorFixtureRuntimes.push(runtimePath);
    }
  }

  function runGovernedTerminalRetryFixture(options: {
    outcome: 'failed_before_stop' | 'recovered' | 'recovery_failed';
    recoverySeconds?: number;
    targetMet?: boolean;
    tamperPredecessorSha?: boolean;
    currentRuntimeDrift?: boolean;
    failLivePredecessorProof?: boolean;
    artifactIdentityDrift?: boolean;
    installedIdentityDrift?: boolean;
    partialTerminalArchive?: boolean;
  }) {
    const clientRoot = path.join(root, `governed-retry-${options.outcome}-${Date.now()}`);
    const scriptsDir = path.join(clientRoot, 'scripts');
    const bin = path.join(clientRoot, 'bin');
    const checkpointDir = path.join(clientRoot, '.local', 'release', 'transactions');
    fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(checkpointDir, { recursive: true });
    for (const directory of [
      path.join(clientRoot, '.local'),
      path.join(clientRoot, '.local', 'release'),
      checkpointDir,
    ]) fs.chmodSync(directory, 0o700);

    const clientPromotion = path.join(scriptsDir, 'promote-exact-release.sh');
    fs.copyFileSync(promotion, clientPromotion);
    fs.chmodSync(clientPromotion, 0o755);
    fs.writeFileSync(path.join(scriptsDir, 'lib', 'release-gates.sh'), `#!/usr/bin/env bash
release_require_git_worktree(){ return 0; }
release_require_clean_tree(){ return 0; }
release_cleanup_all_locks(){ return 0; }
release_acquire_local_lock(){ return 0; }
release_acquire_remote_lock(){ return 0; }
`, { mode: 0o755 });
    fs.writeFileSync(path.join(scriptsDir, 'rollback-drill-check.mjs'), 'process.exit(0);\n');
    fs.writeFileSync(path.join(scriptsDir, 'migration-safety-check.mjs'), `
process.stdout.write(JSON.stringify({irreversibleChangedMigrations:[],reviewEvidence:null}));
`);
    fs.writeFileSync(path.join(scriptsDir, 'env-parity-check.sh'), '#!/usr/bin/env bash\nexit 0\n', {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(scriptsDir, 'remote-release-capacity.sh'), '# fixture capacity\n');

    const targetSha = 'b'.repeat(40);
    const artifactDigest = 'c'.repeat(64);
    const installedRuntimeDigest = 'd'.repeat(64);
    const recoveryRuntimeDigest = '9'.repeat(64);
    const predecessorSha = 'a'.repeat(40);
    const predecessorArtifactDigest = 'e'.repeat(64);
    const predecessorInstalledRuntimeDigest = 'f'.repeat(64);
    const server = 'ServerDominguez';
    const stagingBase = '/srv/nexus-release/staging';
    const productionBase = '/srv/nexus-release/production';
    const targetVersion = '4.14.231';
    const targetRuntime = `${productionBase}/releases/${targetSha}-${artifactDigest.slice(0, 12)}`;
    const predecessorRuntime = `${productionBase}/releases/previous-${predecessorSha.slice(0, 12)}`;
    const oldTransactionId = '20260721T120000Z-1111-abcdef123456';
    const terminalCompletedAt = '2026-07-23T18:00:00.000Z';

    const manifestBody = Buffer.from(`${JSON.stringify({
      schema: 'nexus.release-manifest.v2',
      payload: { runtimeSha: targetSha, artifact: { digest: artifactDigest } },
    })}\n`);
    const manifestPath = path.join(clientRoot, 'release-manifest.json');
    fs.writeFileSync(manifestPath, manifestBody, { mode: 0o600 });
    const manifestSha256 = createHash('sha256').update(manifestBody).digest('hex');
    const stagingBody = Buffer.from(`${JSON.stringify({
      schema: 'nexus.staging-attestation.v1',
      payload: {
        runtimeSha: targetSha,
        artifactDigest,
        installedRuntimeDigest,
        recoveryRuntimeDigest,
        releaseManifestSha256: manifestSha256,
      },
    })}\n`);
    const stagingPath = path.join(clientRoot, 'staging-attestation.json');
    fs.writeFileSync(stagingPath, stagingBody, { mode: 0o600 });
    const stagingSha256 = createHash('sha256').update(stagingBody).digest('hex');

    const checkpoint = {
      schema: 'nexus.promotion-client-checkpoint.v1',
      transactionId: oldTransactionId,
      startedAt: '2026-07-23T17:55:00.000Z',
      runtimeSha: targetSha,
      artifactDigest,
      installedRuntimeDigest,
      recoveryRuntimeDigest,
      releaseManifestSha256: manifestSha256,
      stagingAttestationSha256: stagingSha256,
      targetVersion,
      server,
      productionBase,
    };
    const checkpointBody = Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`);
    const checkpointPath = path.join(
      checkpointDir,
      `${targetSha}-${artifactDigest}.checkpoint.json`,
    );
    fs.writeFileSync(checkpointPath, checkpointBody, { mode: 0o600 });

    const requestPayload = {
      schema: 'nexus.promotion-transaction-request.v1',
      transactionId: oldTransactionId,
      createdAt: '2026-07-23T17:55:00.000Z',
      expiresAt: '2026-07-23T18:25:00.000Z',
      ownerAuthorization: 'explicit',
      productionBase,
      predecessor: {
        runtime: predecessorRuntime,
        sha: predecessorSha,
        artifactDigest: predecessorArtifactDigest,
        installedRuntimeDigest: predecessorInstalledRuntimeDigest,
      },
      target: {
        runtime: targetRuntime,
        sha: targetSha,
        sentryRelease: targetSha,
        artifactDigest,
        installedRuntimeDigest,
        recoveryRuntimeDigest,
        version: targetVersion,
      },
      releaseEvidence: {
        releaseManifestBase64: manifestBody.toString('base64'),
        releaseManifestSha256: manifestSha256,
        stagingAttestationBase64: stagingBody.toString('base64'),
        stagingAttestationSha256: stagingSha256,
      },
      backupDir: '/home/dominguez/backups/nexushub',
      preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-Fixture',
      pm2Bin: '/fake/pm2',
      publicBaseUrl: 'https://api.nexushub.test',
      stabilitySeconds: 60,
      gateTimeoutSeconds: 60,
      migration: { required: false },
    };
    const requestBody = Buffer.from(`${JSON.stringify(requestPayload, null, 2)}\n`);
    const requestPath = path.join(checkpointDir, `${oldTransactionId}.request.json`);
    fs.writeFileSync(requestPath, requestBody, { mode: 0o600 });
    const envelope = {
      schema: 'nexus.promotion-transaction-request-envelope.v1',
      keyId: 'nexus-owner-promotion-2026',
      signatureAlgorithm: 'ed25519',
      payload: requestPayload,
      signature: cryptoSign(
        null,
        Buffer.from(canonicalJson(requestPayload)),
        fs.readFileSync(privateKeyPath),
      ).toString('base64'),
    };
    const envelopePath = path.join(
      checkpointDir,
      `${oldTransactionId}.request.envelope.json`,
    );
    fs.writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    const requestSha256 = createHash('sha256')
      .update(canonicalJson(requestPayload))
      .digest('hex');

    const statusPredecessorSha = options.tamperPredecessorSha ? '6'.repeat(40) : predecessorSha;
    const terminalStatus = {
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: oldTransactionId,
      requestSha256,
      phase: options.outcome === 'failed_before_stop' ? 'preflight'
        : options.outcome === 'recovered' ? 'recovery_complete' : 'recovery_failed',
      status: options.outcome,
      completedAt: terminalCompletedAt,
      predecessor: {
        runtime: predecessorRuntime,
        sha: statusPredecessorSha,
        artifactDigest: predecessorArtifactDigest,
        installedRuntimeDigest: predecessorInstalledRuntimeDigest,
      },
      target: {
        runtime: targetRuntime,
        sha: targetSha,
        artifactDigest,
        installedRuntimeDigest,
        recoveryRuntimeDigest,
      },
      recoveryArmed: options.outcome !== 'failed_before_stop',
      escrowConfirmed: false,
      recovery: options.outcome === 'recovered' ? {
        schema: 'nexus.promotion-recovery-result.v1',
        targetMet: options.targetMet ?? true,
        outageToHealthySeconds: options.recoverySeconds ?? 120,
      } : null,
    };

    fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" rev-parse HEAD "*) printf '%s\\n' "$FIXTURE_TARGET_SHA" ;;
  *" rev-parse --verify --quiet "*) exit 0 ;;
  *" merge-base --is-ancestor "*) exit 0 ;;
  *" ls-files migrations/"*)
    pattern="\${!#}"; migration="\${pattern#migrations/}"; migration="\${migration%%_*}"
    printf 'migrations/%s_fixture.sql\\n' "$migration"
    ;;
  *" diff --quiet "*) exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const sshLog = path.join(clientRoot, 'ssh.log');
    const livePredecessorProof = path.join(clientRoot, 'live-predecessor-proof');
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE_SSH_LOG"
args="$*"
if [[ "$args" == *"sudo -n $FIXTURE_CONTROL version"* ]]; then
  printf '%s\\n' nexus-release-promotion-control.v4
  exit 0
fi
if [[ "$args" == *"sudo -n $FIXTURE_CONTROL status $FIXTURE_OLD_ID"* ]]; then
  printf '%s\\n' "$FIXTURE_STATUS_JSON"
  exit 0
fi
if [[ "$args" == *"sudo -n $FIXTURE_CONTROL prepare-runtime-target"* ]]; then
  exit 91
fi
if [[ "$args" == *"for p in "* ]]; then
  printf '%s' /fake/pm2
  exit 0
fi
if [[ "$args" == *"bash -s --"* ]]; then
  body="$(cat)"
  if [[ "$body" == *"terminal transaction predecessor is no longer current"* ]]; then
    : > "$FIXTURE_LIVE_PREDECESSOR_PROOF"
    argc=$#
    expected_sha="\${@:$((argc-2)):1}"
    expected_artifact="\${@:$((argc-1)):1}"
    expected_installed="\${@:$argc:1}"
    [ "$expected_sha" = "$FIXTURE_PREDECESSOR_SHA" ] || exit 1
    [ "$expected_artifact" = "$FIXTURE_PREDECESSOR_ARTIFACT" ] || exit 1
    [ "$expected_installed" = "$FIXTURE_PREDECESSOR_INSTALLED" ] || exit 1
    [ "$FIXTURE_LIVE_ARTIFACT" = "$expected_artifact" ] || {
      printf '%s\\n' 'terminal predecessor live artifact identity changed' >&2
      exit 1
    }
    [ "$FIXTURE_LIVE_INSTALLED" = "$expected_installed" ] || {
      printf '%s\\n' 'terminal predecessor live installed identity changed' >&2
      exit 1
    }
    [ "$FIXTURE_FAIL_LIVE_PREDECESSOR_PROOF" != 1 ] || exit 1
    exit 0
  fi
  if [[ "$body" == *'if [ -L "$base_dir/current" ]; then readlink -f'* ]]; then
    printf '%s\\n' "$FIXTURE_CURRENT_RUNTIME"
    exit 0
  fi
  if [[ "$body" == *"active PM2/current identity mismatch"* ]]; then exit 0; fi
  if [[ "$body" == *"marker.runtimeSha"* && "$body" == *"installed.aggregateDigest"* ]]; then
    printf '%s %s %s\\n' "$FIXTURE_PREDECESSOR_SHA" \
      "$FIXTURE_PREDECESSOR_ARTIFACT" "$FIXTURE_PREDECESSOR_INSTALLED"
    exit 0
  fi
  exit 0
fi
exit 0
`, { mode: 0o755 });

    const partialArchivePath = path.join(
      checkpointDir,
      'terminal-retries',
      `${oldTransactionId}.json`,
    );
    if (options.partialTerminalArchive) {
      fs.mkdirSync(path.dirname(partialArchivePath), { mode: 0o700 });
      fs.writeFileSync(partialArchivePath, '{"schema":"partial', { mode: 0o600 });
    }

    const result = spawnSync('bash', [
      clientPromotion,
      server,
      stagingBase,
      productionBase,
      targetSha,
      artifactDigest,
      targetVersion,
      installedRuntimeDigest,
      recoveryRuntimeDigest,
      fs.realpathSync(manifestPath),
      fs.realpathSync(stagingPath),
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXUS_RELEASE_OWNER_AUTHORIZED: '1',
        NEXUS_RELEASE_OWNER_PRIVATE_KEY_PATH: privateKeyPath,
        NEXUS_RELEASE_SYSTEMD_CONTROL: '/fake/control',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FIXTURE_CONTROL: '/fake/control',
        FIXTURE_CURRENT_RUNTIME: options.currentRuntimeDrift
          ? `${productionBase}/releases/drifted-${'7'.repeat(12)}`
          : predecessorRuntime,
        FIXTURE_FAIL_LIVE_PREDECESSOR_PROOF: options.failLivePredecessorProof ? '1' : '0',
        FIXTURE_LIVE_PREDECESSOR_PROOF: livePredecessorProof,
        FIXTURE_OLD_ID: oldTransactionId,
        FIXTURE_PREDECESSOR_ARTIFACT: predecessorArtifactDigest,
        FIXTURE_PREDECESSOR_INSTALLED: predecessorInstalledRuntimeDigest,
        FIXTURE_PREDECESSOR_SHA: predecessorSha,
        FIXTURE_LIVE_ARTIFACT: options.artifactIdentityDrift
          ? '1'.repeat(64)
          : predecessorArtifactDigest,
        FIXTURE_LIVE_INSTALLED: options.installedIdentityDrift
          ? '2'.repeat(64)
          : predecessorInstalledRuntimeDigest,
        FIXTURE_SSH_LOG: sshLog,
        FIXTURE_STATUS_JSON: JSON.stringify(terminalStatus),
        FIXTURE_TARGET_SHA: targetSha,
      },
      maxBuffer: 2 * 1024 * 1024,
    });

    return {
      artifactDigest,
      checkpoint,
      checkpointBody,
      checkpointDir,
      checkpointPath,
      envelopePath,
      livePredecessorProof,
      oldTransactionId,
      partialArchivePath,
      requestPath,
      requestSha256,
      result,
      sshLog,
      terminalCompletedAt,
      terminalStatus,
    };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-promotion-control-')));
    stateRoot = path.join(root, 'state');
    requestPath = path.join(root, 'request.json');
    envelopePath = path.join(root, 'request.envelope.json');
    publicKeyPath = path.join(root, 'owner-public.pem');
    privateKeyPath = path.join(root, 'owner-private.pem');
    systemctlLog = path.join(root, 'systemctl.log');
    systemctlActive = path.join(root, 'systemctl.active');
    selectorFixtureRuntimes = [];
    fs.writeFileSync(path.join(root, 'release-sonar.lock'), '', { mode: 0o660 });
    const pair = generateKeyPairSync('ed25519');
    fs.writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
if /usr/bin/stat --version >/dev/null 2>&1; then exec /usr/bin/stat "$@"; fi
if [ "\${1:-}" != -c ]; then exec /usr/bin/stat "$@"; fi
format="\${2:-}"; file="\${3:-}"
case "$format" in
  %h) native=%l ;;
  %a) native=%Lp ;;
  %u) native=%u ;;
  %g) native=%g ;;
  %s) native=%z ;;
  %U:%G) native=%Su:%Sg ;;
  %a:%h) native=%Lp:%l ;;
  %u:%g:%a) native=%u:%g:%Lp ;;
  %U:%G:%a) native=%Su:%Sg:%Lp ;;
  %U:%G:%a:%h) native=%Su:%Sg:%Lp:%l ;;
  *) printf 'unsupported GNU stat fixture format: %s\\n' "$format" >&2; exit 64 ;;
esac
exec /usr/bin/stat -f "$native" "$file"
`, { mode: 0o755 });
    authWrapper = path.join(bin, 'promotion-auth');
    fs.writeFileSync(authWrapper, `#!/usr/bin/env bash\nexec node ${JSON.stringify(authorization)} "$@"\n`, { mode: 0o755 });
    drBackupBin = path.join(bin, 'application-dr-backup');
    drConfig = path.join(root, 'application-dr.env');
    drBackupLock = path.join(root, 'application-dr-backup.lock');
    drSystemctlBin = path.join(bin, 'application-dr-systemctl');
    fs.writeFileSync(drConfig, 'fixture=true\n', { mode: 0o600 });
    fs.writeFileSync(drBackupLock, '', { mode: 0o600 });
    fs.writeFileSync(
      drSystemctlBin,
      '#!/usr/bin/env bash\nprintf \'inactive\\n\'\nexit 3\n',
      { mode: 0o755 },
    );
    writeAwsDrFixture(drBackupBin);
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
if [ "\${1:-}" = is-active ]; then [ -f "$SYSTEMCTL_ACTIVE" ] && exit 0 || exit 3; fi
if [ "\${1:-}" = start ]; then
  : > "$SYSTEMCTL_ACTIVE"
  if [[ " $* " != *" --no-block "* ]]; then
    unit="\${!#}"; transaction="\${unit#nexus-release-promotion@}"; transaction="\${transaction%.service}"
    journal="$NEXUS_PROMOTION_STATE_ROOT/transactions/$transaction/state/journal.json"
    authority="$NEXUS_PROMOTION_STATE_ROOT/transactions/$transaction/authority.json"
    request_sha="$(node -e 'const x=require(process.argv[1]);process.stdout.write(x.requestSha256)' "$authority")"
    mkdir -p "\${journal%/*}"
    printf '{"schema":"nexus.promotion-transaction-journal.v1","transactionId":"%s","requestSha256":"%s","phase":"recovery_complete","status":"recovered"}\n' "$transaction" "$request_sha" > "$journal"
  fi
fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'timeout'), `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac; done
exec "$@"
`, { mode: 0o755 });
    v3ControlFixtureEnv = writeV3ControlFixtures();
    writeRequest();
    signRequest();
  });

  afterEach(() => {
    for (const runtimePath of selectorFixtureRuntimes) {
      if (fs.existsSync(runtimePath)) fs.chmodSync(runtimePath, 0o750);
    }
    cleanupV3ControlFixtures();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function request(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date();
    return {
      schema: 'nexus.promotion-transaction-request.v1',
      transactionId: id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30 * 60_000).toISOString(),
      ownerAuthorization: 'explicit',
      productionBase: '/srv/nexus-release/production',
      predecessor: {
        runtime: '/srv/nexus-release/production/releases/previous-aaaaaaaaaaaa',
        sha: 'a'.repeat(40),
        artifactDigest: 'e'.repeat(64),
        installedRuntimeDigest: 'f'.repeat(64),
      },
      target: {
        runtime: '/srv/nexus-release/production/releases/target-bbbbbbbbbbbb',
        sha: 'b'.repeat(40),
        sentryRelease: 'b'.repeat(40),
        artifactDigest: 'c'.repeat(64),
        installedRuntimeDigest: 'd'.repeat(64),
        recoveryRuntimeDigest: '9'.repeat(64),
        version: '4.14.231',
      },
      releaseEvidence: {
        releaseManifestBase64: releaseManifestBody.toString('base64'),
        releaseManifestSha256: createHash('sha256').update(releaseManifestBody).digest('hex'),
        stagingAttestationBase64: stagingAttestationBody.toString('base64'),
        stagingAttestationSha256: createHash('sha256').update(stagingAttestationBody).digest('hex'),
      },
      backupDir: '/home/dominguez/backups/nexushub',
      preparedRuntimeDir: '/home/dominguez/backups/nexushub/.runtime-stage-Ab12',
      pm2Bin: '/usr/local/bin/pm2',
      publicBaseUrl: 'https://api.nexushub.me',
      stabilitySeconds: 60,
      gateTimeoutSeconds: 60,
      migration: { required: false },
      ...overrides,
    };
  }

  function writeRequest(overrides: Record<string, unknown> = {}) {
    fs.writeFileSync(requestPath, `${JSON.stringify(request(overrides), null, 2)}\n`, { mode: 0o600 });
  }

  function signRequest() {
    fs.rmSync(envelopePath, { force: true });
    const result = spawnSync('node', [authorization, 'sign-request', '--input', requestPath,
      '--private-key', privateKeyPath, '--output', envelopePath], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  }

  function writeRawEnvelope(payload: Record<string, unknown>) {
    const privateKey = fs.readFileSync(privateKeyPath);
    const envelope = {
      schema: 'nexus.promotion-transaction-request-envelope.v1',
      keyId: 'nexus-owner-promotion-2026',
      signatureAlgorithm: 'ed25519',
      payload,
      signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
    };
    fs.writeFileSync(envelopePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  }

  function env(extra: NodeJS.ProcessEnv = {}) {
    return {
      ...process.env,
      ...v3ControlFixtureEnv,
      NEXUS_RELEASE_TEST_MODE: '1',
      NEXUS_PROMOTION_STATE_ROOT: stateRoot,
      NEXUS_PROMOTION_SYSTEMCTL_BIN: path.join(root, 'bin', 'systemctl'),
      NEXUS_PROMOTION_AUTH_BIN: authWrapper,
      NEXUS_PROMOTION_OWNER_PUBLIC_KEY: publicKeyPath,
      NEXUS_PROMOTION_FLOCK_BIN: path.join(root, 'bin', 'flock'),
      NEXUS_PROMOTION_TIMEOUT_BIN: path.join(root, 'bin', 'timeout'),
      NEXUS_PROMOTION_RELEASE_SONAR_LOCK: path.join(root, 'release-sonar.lock'),
      NEXUS_PROMOTION_DR_BACKUP_BIN: drBackupBin,
      NEXUS_PROMOTION_DR_CONFIG: drConfig,
      NEXUS_PROMOTION_DR_BACKUP_LOCK: drBackupLock,
      NEXUS_PROMOTION_DR_SYSTEMCTL_BIN: drSystemctlBin,
      SYSTEMCTL_LOG: systemctlLog,
      SYSTEMCTL_ACTIVE: systemctlActive,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      ...extra,
    };
  }

  function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [control, ...args], { encoding: 'utf8', env: env(extra) });
  }

  it('adopts a crash-linked signed envelope without replacing its exact authority', () => {
    const original = fs.readFileSync(envelopePath);
    const crashTemporary = path.join(
      path.dirname(envelopePath),
      `.${path.basename(envelopePath)}.next.fixture`,
    );
    fs.linkSync(envelopePath, crashTemporary);
    expect(fs.statSync(envelopePath).nlink).toBe(2);

    const resumed = spawnSync('node', [
      authorization,
      'sign-request',
      '--input',
      requestPath,
      '--private-key',
      privateKeyPath,
      '--output',
      envelopePath,
    ], { encoding: 'utf8' });

    expect(resumed.status, resumed.stderr).toBe(0);
    expect(fs.existsSync(crashTemporary)).toBe(false);
    expect(fs.statSync(envelopePath).nlink).toBe(1);
    expect(fs.statSync(envelopePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envelopePath)).toEqual(original);
  });

  it('launches one signed immutable request atomically and reconciles an identical retry', () => {
    const pm2Ready = run(['assert-root-pm2-ready']);
    expect(pm2Ready.status, pm2Ready.stderr).toBe(0);
    const layoutReady = run(['assert-layout-ready']);
    expect(layoutReady.status, `${root}\n${layoutReady.stderr}`).toBe(0);
    const first = run(['launch', envelopePath]);
    expect(first.status, first.stderr).toBe(0);
    const firstBody = JSON.parse(first.stdout);
    expect(firstBody.transactionId).toBe(id);
    expect(firstBody.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fs.statSync(path.join(stateRoot, 'requests', `${id}.json`)).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(stateRoot, 'active.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(stateRoot, 'transactions', id)).mode & 0o777).toBe(0o711);
    expect(fs.statSync(path.join(stateRoot, 'transactions', id, 'state')).mode & 0o777).toBe(0o700);

    const second = run(['launch', envelopePath]);
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).requestSha256).toBe(firstBody.requestSha256);
    const starts = fs.readFileSync(systemctlLog, 'utf8').split('\n').filter((line) => line.includes('start --no-block'));
    expect(starts).toEqual([`start --no-block nexus-release-promotion@${id}.service`]);
    expect(run(['assert-idle']).status).toBe(73);
  });

  it('reports the authoritative transaction unit activity with status', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);

    const activeStatus = run(['status', id]);
    expect(activeStatus.status, activeStatus.stderr).toBe(0);
    expect(JSON.parse(activeStatus.stdout)).toMatchObject({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      status: 'pending',
      unitActive: true,
    });

    fs.rmSync(systemctlActive);
    const inactiveStatus = run(['status', id]);
    expect(inactiveStatus.status, inactiveStatus.stderr).toBe(0);
    expect(JSON.parse(inactiveStatus.stdout).unitActive).toBe(false);
  });

  it('reconciles synchronously after reboot before recovery intent is armed', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const staleTiming = {
      schema: 'nexus.promotion-cutover-timing.v1',
      startedAt: '2026-07-22T11:58:00Z',
      startedMonotonicSeconds: 1,
      preRecoveryDeadlineMonotonicSeconds: 61,
      outageDeadlineMonotonicSeconds: 121,
      bootId: 'stale-pre-mutation-boot',
    };
    const timingPath = path.join(authoritative, 'cutover-timing.json');
    fs.writeFileSync(timingPath, `${JSON.stringify(staleTiming)}\n`, { mode: 0o600 });
    fs.rmSync(systemctlActive, { force: true });

    const recovered = run(['recover-all']);
    expect(recovered.status, recovered.stderr).toBe(0);
    const unitName = `nexus-release-promotion@${id}.service`;
    const lines = fs.readFileSync(systemctlLog, 'utf8').trim().split('\n');
    expect(lines.filter((line) => line === `start --no-block ${unitName}`)).toHaveLength(1);
    expect(lines).toContain(`start ${unitName}`);
    expect(fs.existsSync(path.join(stateRoot, 'transactions', id, 'control', 'recover')))
      .toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(timingPath, 'utf8'))).toEqual(staleTiming);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')).status)
      .toBe('recovered');
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'boot-recovery-in-progress.v1.json')))
      .toBe(true);
  });

  it('relaunches only the same authoritative transaction when DR escrow is pending', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'awaiting_dr_escrow',
      status: 'escrow_pending',
    })}\n`, { mode: 0o600 });
    fs.rmSync(systemctlActive, { force: true });

    const retry = run(['retry-escrow', id]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(JSON.parse(retry.stdout)).toMatchObject({
      transactionId: id,
      state: 'relaunched',
      retry: 'rollback-escrow',
    });
    const lines = fs.readFileSync(systemctlLog, 'utf8').trim().split('\n');
    expect(lines).toContain(`reset-failed nexus-release-promotion@${id}.service`);
    expect(lines.filter((line) => line === `start --no-block nexus-release-promotion@${id}.service`))
      .toHaveLength(2);

    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'executing',
      status: 'running',
    })}\n`, { mode: 0o600 });
    expect(run(['retry-escrow', id]).status).toBe(75);
  });

  it('resumes only pending DR escrow after a host reboot', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'awaiting_dr_escrow',
      status: 'escrow_pending',
    })}\n`, { mode: 0o600 });
    fs.rmSync(systemctlActive, { force: true });

    const recovered = run(['recover-all']);
    expect(recovered.status, recovered.stderr).toBe(0);
    const lines = fs.readFileSync(systemctlLog, 'utf8').trim().split('\n');
    expect(lines).toContain(`reset-failed nexus-release-promotion@${id}.service`);
    expect(lines.filter((line) => line === `start --no-block nexus-release-promotion@${id}.service`))
      .toHaveLength(1);
    expect(lines).toContain(`start nexus-release-promotion@${id}.service`);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')).status)
      .toBe('recovered');
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateRoot, 'boot-recovery-in-progress.v1.json')))
      .toBe(true);
  });

  it('rejects forged, expired, unsigned, and non-exact-soak owner authority', () => {
    const forged = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
    forged.payload.target.version = '9.9.9';
    fs.writeFileSync(envelopePath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    expect(run(['launch', envelopePath]).status).toBe(77);

    const expired = request({
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    writeRawEnvelope(expired);
    const expiredResult = run(['launch', envelopePath]);
    expect(expiredResult.status).toBe(77);
    expect(expiredResult.stderr).toContain('verification failed');

    writeRequest({ stabilitySeconds: 59 });
    writeRawEnvelope(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
    expect(run(['launch', envelopePath]).status).toBe(77);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'boot-recovery-in-progress.v1.json')))
      .toBe(false);

    const missingPredecessorIdentity = request();
    delete (missingPredecessorIdentity.predecessor as { artifactDigest?: string }).artifactDigest;
    writeRawEnvelope(missingPredecessorIdentity);
    const missingIdentity = run(['launch', envelopePath]);
    expect(missingIdentity.status).toBe(77);
    expect(missingIdentity.stderr).toContain('verification failed');

    const legacyProduction = request();
    legacyProduction.productionBase = '/home/dominguez/telegram-hub-bot';
    (legacyProduction.predecessor as { runtime: string }).runtime =
      '/home/dominguez/telegram-hub-bot/releases/previous-aaaaaaaaaaaa';
    (legacyProduction.target as { runtime: string }).runtime =
      '/home/dominguez/telegram-hub-bot/releases/target-bbbbbbbbbbbb';
    writeRawEnvelope(legacyProduction);
    const legacyPath = run(['launch', envelopePath]);
    expect(legacyPath.status).toBe(77);
    expect(legacyPath.stderr).toContain('verification failed');
  });

  it('rejects a signed envelope for request A when the stored request is replaced with request B', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const storedRequest = path.join(stateRoot, 'requests', `${id}.json`);
    const requestB = JSON.parse(fs.readFileSync(storedRequest, 'utf8'));
    requestB.target.version = '4.14.999';
    fs.writeFileSync(storedRequest, `${JSON.stringify(requestB, null, 2)}\n`, { mode: 0o644 });

    const workerCalled = path.join(root, 'worker-called');
    const workerSentinel = path.join(root, 'bin', 'unexpected-worker');
    fs.writeFileSync(workerSentinel, `#!/usr/bin/env bash
: > "$WORKER_CALLED"
exit 99
`, { mode: 0o755 });
    const drCalled = path.join(root, 'dr-called');
    const drSentinel = path.join(root, 'bin', 'unexpected-dr');
    fs.writeFileSync(drSentinel, `#!/usr/bin/env bash
: > "$DR_CALLED"
exit 99
`, { mode: 0o755 });

    const rejected = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: workerSentinel,
        NEXUS_PROMOTION_DR_BACKUP_BIN: drSentinel,
        WORKER_CALLED: workerCalled,
        DR_CALLED: drCalled,
      }),
    });

    expect(rejected.status).not.toBe(0);
    expect(fs.existsSync(workerCalled)).toBe(false);
    expect(fs.existsSync(drCalled)).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'transactions', id, 'state', 'journal.json')))
      .toBe(false);
  });

  it('does not let deploy-writable artifacts forge terminal authority or clear the active transaction', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    // Simulate everything the dominguez application account can mutate.
    fs.writeFileSync(path.join(worker, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id,
      phase: 'completed', status: 'completed',
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'worker-progress.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id,
      phase: 'completed', status: 'completed',
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'result.env'), `NEXUS_TRANSACTION_ID=${id}\n`, { mode: 0o600 });

    const status = run(['status', id]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).status).toBe('pending');
    expect(run(['assert-idle']).status).toBe(73);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(true);
    expect(run(['fetch', id, 'result']).status).toBe(75);
    expect(run(['launch', envelopePath]).status).toBe(0);
  });

  it('recovers only the authoritative active ID synchronously before PM2 boot ordering', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256;
    const stray = '20260722T120001Z-1235-fedcba654321';
    fs.writeFileSync(path.join(stateRoot, 'requests', `${stray}.json`), '{}\n');
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    fs.writeFileSync(path.join(authoritative, 'recovery-armed'), 'armed\n', { mode: 0o600 });
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'recovery_required',
      status: 'recovery_required',
    })}\n`, { mode: 0o600 });

    const recovered = run(['recover-all']);
    expect(recovered.status, recovered.stderr).toBe(0);
    const lines = fs.readFileSync(systemctlLog, 'utf8').trim().split('\n');
    expect(lines).toContain(`start nexus-release-promotion@${id}.service`);
    expect(lines.some((line) => line.includes(stray))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'active.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateRoot, 'boot-recovery-in-progress.v1.json')))
      .toBe(true);
  });

  it('fails closed before worker execution when the durable release/Sonar flock is unavailable', () => {
    expect(run(['launch', envelopePath]).status).toBe(0);
    const deniedFlock = path.join(root, 'bin', 'flock-denied');
    fs.writeFileSync(deniedFlock, '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({ NEXUS_PROMOTION_FLOCK_BIN: deniedFlock }),
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('shared release/Sonar mutex is unavailable');
    expect(fs.existsSync(path.join(stateRoot, 'transactions', id, 'worker', 'journal.json'))).toBe(false);
  });

  it('waits for an existing hourly DR backup lease and then enters preflight', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'dr-lease-wait-fixture');
    const previous = path.join(
      fixture,
      'production',
      'releases',
      'previous-runtime',
    );
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'dr-lease-mutation-sentinel');
    const leaseFlock = path.join(root, 'bin', 'dr-lease-flock');
    const leaseSystemctl = path.join(root, 'bin', 'dr-lease-systemctl');
    const leaseProbeLog = path.join(fixture, 'lease-probes.log');
    const serviceProbeLog = path.join(fixture, 'service-probes.log');
    const scheduledLeaseCapture = path.join(fixture, 'scheduled-lease.json');
    const sleep = path.join(root, 'bin', 'dr-lease-sleep');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(
      mutationScript,
      '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    writeDrLeaseFlockFixture(leaseFlock);
    writeDrLeaseSystemctlFixture(leaseSystemctl);
    fs.writeFileSync(sleep, `#!/usr/bin/env bash
set -euo pipefail
if [ ! -f "$DR_LEASE_SCHEDULE_CAPTURE" ]; then
  cp "$DR_LEASE_JOURNAL" "$DR_LEASE_SCHEDULE_CAPTURE"
fi
`, { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_FLOCK_BIN: leaseFlock,
        NEXUS_PROMOTION_DR_SYSTEMCTL_BIN: leaseSystemctl,
        NEXUS_PROMOTION_SLEEP_BIN: sleep,
        NEXUS_PROMOTION_DR_CONFIG: path.join(root, 'missing-after-lease.env'),
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        NEXUS_PROMOTION_TEST_BOOT_ID: 'lease-wait-boot',
        NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS: '100',
        DR_ACTIVE_PROBES: '1',
        DR_BUSY_PROBES: '1',
        DR_LEASE_PROBE_LOG: leaseProbeLog,
        DR_LEASE_JOURNAL: path.join(
          stateRoot,
          'transactions',
          id,
          'state',
          'journal.json',
        ),
        DR_LEASE_SCHEDULE_CAPTURE: scheduledLeaseCapture,
        DR_SERVICE_PROBE_LOG: serviceProbeLog,
        MUTATION_MARKER: mutationMarker,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('application DR configuration is unavailable');
    expect(fs.readFileSync(leaseProbeLog, 'utf8').trim().split('\n'))
      .toHaveLength(2);
    expect(fs.readFileSync(serviceProbeLog, 'utf8').trim().split('\n'))
      .toHaveLength(4);
    expect(JSON.parse(fs.readFileSync(scheduledLeaseCapture, 'utf8')))
      .toMatchObject({
        phase: 'waiting_for_dr_lease',
        status: 'running',
        drLease: {
          probeAttempt: 1,
          nextProbeAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
          nextProbeMonotonicSeconds: 102,
          errorClass: 'dr_backup_service_active',
          bootId: 'lease-wait-boot',
        },
      });
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const journal = JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    );
    expect(journal).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'application_dr_provisioning_or_config_invalid',
      drLease: {
        probeAttempt: 3,
        waitBudgetSeconds: 120,
        pollSeconds: 2,
        maxProbes: 61,
        waitStartedMonotonicSeconds: 100,
        deadlineMonotonicSeconds: 220,
        nextProbeAt: null,
        acquiredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        errorClass: null,
        bootId: 'lease-wait-boot',
      },
    });
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
  });

  it('times out a resumed DR backup lease before PM2 or cutover mutation', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const fixture = path.join(root, 'dr-lease-timeout-fixture');
    const previous = path.join(
      fixture,
      'production',
      'releases',
      'previous-runtime',
    );
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'dr-lease-timeout-sentinel');
    const leaseFlock = path.join(root, 'bin', 'dr-lease-timeout-flock');
    const leaseProbeLog = path.join(fixture, 'lease-probes.log');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(
      mutationScript,
      '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    writeDrLeaseFlockFixture(leaseFlock);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'waiting_for_dr_lease',
      status: 'running',
      drLease: {
        probeAttempt: 1,
        waitBudgetSeconds: 120,
        pollSeconds: 2,
        maxProbes: 61,
        waitStartedAt: '2026-07-22T12:00:00.000Z',
        waitStartedMonotonicSeconds: 100,
        deadlineMonotonicSeconds: 220,
        nextProbeAt: null,
        nextProbeMonotonicSeconds: null,
        lastProbeAt: '2026-07-22T12:00:01.000Z',
        lastProbeMonotonicSeconds: 100,
        acquiredAt: null,
        errorClass: 'dr_backup_lease_busy',
        bootId: 'lease-timeout-boot',
        cycleInvocationId: 'lease-timeout-prior',
      },
    }, null, 2)}\n`, { mode: 0o600 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_FLOCK_BIN: leaseFlock,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        NEXUS_PROMOTION_TEST_BOOT_ID: 'lease-timeout-boot',
        NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS: '220',
        DR_BUSY_PROBES: '99',
        DR_LEASE_PROBE_LOG: leaseProbeLog,
        MUTATION_MARKER: mutationMarker,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'application DR backup lease wait timed out before cutover',
    );
    expect(fs.readFileSync(leaseProbeLog, 'utf8').trim().split('\n'))
      .toHaveLength(1);
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const journal = JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    );
    expect(journal).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'dr_backup_lease_timeout_before_cutover',
      drLease: {
        probeAttempt: 2,
        deadlineMonotonicSeconds: 220,
        acquiredAt: null,
        errorClass: 'dr_backup_lease_timeout',
        bootId: 'lease-timeout-boot',
      },
    });
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
  });

  it('resumes a pre-cutover DR lease wait across reboot without forcing recovery', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const writeWaitingJournal = () => fs.writeFileSync(
      path.join(authoritative, 'journal.json'),
      `${JSON.stringify({
        schema: 'nexus.promotion-transaction-journal.v1',
        transactionId: id,
        requestSha256,
        phase: 'waiting_for_dr_lease',
        status: 'running',
        drLease: {
          probeAttempt: 2,
          waitBudgetSeconds: 120,
          pollSeconds: 2,
          maxProbes: 61,
          waitStartedAt: '2026-07-22T12:00:00.000Z',
          waitStartedMonotonicSeconds: 100,
          deadlineMonotonicSeconds: 220,
          nextProbeAt: '2026-07-22T12:00:04.000Z',
          nextProbeMonotonicSeconds: 104,
          lastProbeAt: '2026-07-22T12:00:02.000Z',
          lastProbeMonotonicSeconds: 102,
          acquiredAt: null,
          errorClass: 'dr_backup_lease_busy',
          bootId: 'lease-old-boot',
          cycleInvocationId: 'lease-old-invocation',
        },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    writeWaitingJournal();
    fs.rmSync(systemctlActive, { force: true });
    const bootReconcile = run(['recover-all']);
    expect(bootReconcile.status, bootReconcile.stderr).toBe(0);
    expect(fs.existsSync(path.join(
      stateRoot,
      'transactions',
      id,
      'control',
      'recover',
    ))).toBe(false);

    writeWaitingJournal();
    const fixture = path.join(root, 'dr-lease-reboot-fixture');
    const previous = path.join(
      fixture,
      'production',
      'releases',
      'previous-runtime',
    );
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'dr-lease-reboot-sentinel');
    const leaseFlock = path.join(root, 'bin', 'dr-lease-reboot-flock');
    const leaseProbeLog = path.join(fixture, 'lease-probes.log');
    const sleep = path.join(root, 'bin', 'dr-lease-reboot-sleep');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(
      mutationScript,
      '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    writeDrLeaseFlockFixture(leaseFlock);
    fs.writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_FLOCK_BIN: leaseFlock,
        NEXUS_PROMOTION_SLEEP_BIN: sleep,
        NEXUS_PROMOTION_DR_CONFIG: path.join(root, 'missing-after-reboot.env'),
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        NEXUS_PROMOTION_TEST_BOOT_ID: 'lease-new-boot',
        NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS: '10',
        DR_BUSY_PROBES: '1',
        DR_LEASE_PROBE_LOG: leaseProbeLog,
        MUTATION_MARKER: mutationMarker,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('application DR configuration is unavailable');
    expect(fs.readFileSync(leaseProbeLog, 'utf8').trim().split('\n'))
      .toHaveLength(2);
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const journal = JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    );
    expect(journal).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      drLease: {
        probeAttempt: 2,
        waitStartedMonotonicSeconds: 10,
        deadlineMonotonicSeconds: 130,
        acquiredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        errorClass: null,
        bootId: 'lease-new-boot',
      },
    });
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
  });

  it('fails staging mutex acquisition closed before its capacity gate', () => {
    const deniedBin = path.join(root, 'denied-bin');
    fs.mkdirSync(deniedBin);
    fs.writeFileSync(path.join(deniedBin, 'ssh'), '#!/usr/bin/env bash\nexit 75\n', { mode: 0o755 });
    const gates = path.resolve('scripts/lib/release-gates.sh');

    const result = spawnSync('/bin/bash', ['-s', '--', gates], {
      input: 'set -euo pipefail\nsource "$1"\nrelease_acquire_remote_sonar_lock fixture-host\n',
      encoding: 'utf8',
      env: { ...process.env, PATH: `${deniedBin}:${process.env.PATH ?? ''}`, TMPDIR: root },
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('shared remote release/Sonar mutex is unavailable');
  });

  it('fails terminally before current or worker mutation when application DR configuration is missing', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'missing-dr-fixture');
    const previous = path.join(fixture, 'production', 'releases', 'previous-runtime');
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'mutation-sentinel');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(mutationScript, '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n', { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_CONFIG: path.join(root, 'missing-application-dr.env'),
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        MUTATION_MARKER: mutationMarker,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('application DR configuration is unavailable');
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'))).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'application_dr_provisioning_or_config_invalid',
    });
  });

  it('runs application DR verify-config and fails before current or worker mutation when configuration validation fails', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'invalid-dr-fixture');
    const previous = path.join(fixture, 'production', 'releases', 'previous-runtime');
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'mutation-sentinel');
    const invalidDr = path.join(root, 'bin', 'invalid-application-dr-backup');
    const drInvocation = path.join(fixture, 'dr-invocation.log');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(mutationScript, '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n', { mode: 0o755 });
    fs.writeFileSync(invalidDr, `#!/usr/bin/env bash
printf '%s\\n' "$*" > "$DR_INVOCATION"
printf '%s\\n' 'application_dr_backup_config_ok encryption=age transport=s3-compatible databaseRetentionPolicy=24-hourly,7-daily,4-weekly,6-monthly releaseRetentionPolicy=90-days'
`, { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_BACKUP_BIN: invalidDr,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        MUTATION_MARKER: mutationMarker,
        DR_INVOCATION: drInvocation,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('application DR provisioning/config preflight returned invalid evidence');
    expect(fs.readFileSync(drInvocation, 'utf8')).toContain(`--config ${drConfig} --verify-config`);
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'))).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'application_dr_provisioning_or_config_invalid',
    });
  });

  it('rejects owner-valid drill-key release evidence before application-runtime mutation', () => {
    const productionEvidence = generateKeyPairSync('ed25519');
    const drillEvidence = generateKeyPairSync('ed25519');
    const signedInnerEvidence = (
      schema: string,
      payload: Record<string, unknown>,
    ) => ({
      schema,
      keyId: 'github-environment-release-signing-2026-07',
      signatureAlgorithm: 'ed25519',
      payload,
      signature: cryptoSign(
        null,
        Buffer.from(canonicalJson(payload)),
        drillEvidence.privateKey,
      ).toString('base64'),
    });
    const manifestPayload = {
      runtimeSha: 'b'.repeat(40),
      packageVersion: '4.14.231',
      artifact: {
        digest: 'c'.repeat(64),
        fileCount: 0,
        files: [],
      },
    };
    const drillManifestBody = Buffer.from(`${JSON.stringify(signedInnerEvidence(
      'nexus.release-manifest.v2',
      manifestPayload,
    ), null, 2)}\n`);
    const stagingPayload = {
      requestId: '11111111-1111-4111-8111-111111111111',
      runtimeSha: 'b'.repeat(40),
      artifactDigest: 'c'.repeat(64),
      releaseManifestSha256:
        createHash('sha256').update(drillManifestBody).digest('hex'),
      installedRuntimeDigest: 'd'.repeat(64),
      recoveryRuntimeDigest: '9'.repeat(64),
    };
    const drillStagingBody = Buffer.from(`${JSON.stringify(signedInnerEvidence(
      'nexus.staging-attestation.v1',
      stagingPayload,
    ), null, 2)}\n`);
    writeRequest({
      releaseEvidence: {
        releaseManifestBase64: drillManifestBody.toString('base64'),
        releaseManifestSha256:
          createHash('sha256').update(drillManifestBody).digest('hex'),
        stagingAttestationBase64: drillStagingBody.toString('base64'),
        stagingAttestationSha256:
          createHash('sha256').update(drillStagingBody).digest('hex'),
      },
    });
    signRequest();
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);

    const fixture = path.join(root, 'drill-evidence-production-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const current = path.join(production, 'current');
    const fixtureBin = path.join(fixture, 'bin');
    const fixtureTmp = path.join(fixture, 'tmp');
    fs.mkdirSync(previous, { recursive: true, mode: 0o750 });
    fs.mkdirSync(target, { recursive: true, mode: 0o750 });
    fs.mkdirSync(fixtureBin, { mode: 0o700 });
    fs.mkdirSync(fixtureTmp, { mode: 0o700 });
    const runtimeMetadata = [
      path.join(previous, '.complete.json'),
      path.join(previous, '.nexus-installed-runtime.json'),
      path.join(target, '.complete.json'),
      path.join(target, '.nexus-installed-runtime.json'),
    ];
    runtimeMetadata.forEach((file, index) => {
      fs.writeFileSync(file, `fixture-runtime-metadata-${index}\n`, { mode: 0o640 });
    });
    fs.chmodSync(previous, 0o750);
    fs.chmodSync(target, 0o750);
    fs.symlinkSync(previous, current);
    const before = {
      current: fs.realpathSync(current),
      runtimeModes: [previous, target].map((directory) =>
        fs.statSync(directory).mode & 0o777),
      metadata: runtimeMetadata.map((file) => ({
        body: fs.readFileSync(file),
        mode: fs.statSync(file).mode & 0o777,
      })),
    };

    const mutationLog = path.join(fixture, 'application-runtime-mutation.log');
    const attestor = path.join(fixtureBin, 'trusted-attestor.cjs');
    fs.writeFileSync(attestor, `const fs=require('node:fs');
const args=process.argv.slice(2),mode=args[0],rootIndex=args.indexOf('--root');
const runtime=args[rootIndex+1];
fs.appendFileSync(process.env.MUTATION_LOG,\`trusted_attest \${mode} \${runtime}\\n\`);
fs.chmodSync(runtime,0o700);
fs.writeFileSync(runtime+'/.complete.json','mutated\\n');
`, { mode: 0o700 });
    const pm2 = path.join(fixtureBin, 'pm2');
    fs.writeFileSync(pm2, `#!/usr/bin/env bash
printf 'pm2 %s\\n' "$*" >> "$MUTATION_LOG"
exit 99
`, { mode: 0o700 });
    const selector = path.join(fixtureBin, 'selector.py');
    fs.writeFileSync(selector, `#!/usr/bin/env python3
import os
with open(os.environ["MUTATION_LOG"], "a", encoding="utf-8") as handle:
    handle.write("selector\\n")
raise SystemExit(99)
`, { mode: 0o700 });
    const worker = path.join(fixtureBin, 'worker');
    fs.writeFileSync(worker, `#!/usr/bin/env bash
printf 'worker %s\\n' "$*" >> "$MUTATION_LOG"
exit 99
`, { mode: 0o700 });
    const unshare = path.join(fixtureBin, 'unshare');
    fs.writeFileSync(unshare, `#!/usr/bin/env bash
while [ $# -gt 0 ] && [[ "$1" == --* ]]; do shift; done
exec "$@"
`, { mode: 0o700 });
    const isolatedBash = path.join(fixtureBin, 'isolated-bash');
    fs.writeFileSync(isolatedBash, `#!/usr/bin/env bash
[ "\${1:-}" = -c ] || exit 64
shift 6
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/nonexistent \
  TMPDIR=${JSON.stringify(fixtureTmp)} "$@"
`, { mode: 0o700 });
    const productionPublicKey = path.join(fixture, 'production-release-public.pem');
    fs.writeFileSync(
      productionPublicKey,
      productionEvidence.publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o600 },
    );
    const workerUser = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
    expect(workerUser).not.toBe('');
    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        NEXUS_PROMOTION_TEST_EXERCISE_RELEASE_EVIDENCE_PREFLIGHT: '1',
        NEXUS_PROMOTION_TEST_EXERCISE_TRUSTED_ATTESTOR: '1',
        NEXUS_PROMOTION_WORKER_USER: workerUser,
        NEXUS_PROMOTION_UNSHARE_BIN: unshare,
        NEXUS_PROMOTION_BASH_BIN: isolatedBash,
        NEXUS_PROMOTION_SETPRIV_BIN: '/usr/bin/true',
        NEXUS_PROMOTION_RECOVERY_RUNTIME_BIN:
          path.resolve('scripts/application-dr-recovery-runtime.mjs'),
        NEXUS_PROMOTION_RECOVERY_IDENTITY_BIN:
          path.resolve('scripts/release-recovery-runtime-identity.mjs'),
        NEXUS_PROMOTION_RELEASE_EVIDENCE_PUBLIC_KEY: productionPublicKey,
        NEXUS_PROMOTION_TRUSTED_ATTESTOR: attestor,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: worker,
        NEXUS_PROMOTION_SELECTOR_SWITCH: selector,
        MUTATION_LOG: mutationLog,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('release manifest signature is invalid');
    expect(fs.existsSync(mutationLog)).toBe(false);
    expect(fs.realpathSync(current)).toBe(before.current);
    expect([previous, target].map((directory) =>
      fs.statSync(directory).mode & 0o777)).toEqual(before.runtimeModes);
    runtimeMetadata.forEach((file, index) => {
      expect(fs.readFileSync(file)).toEqual(before.metadata[index].body);
      expect(fs.statSync(file).mode & 0o777).toBe(before.metadata[index].mode);
    });
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'recovery-runtime-descriptor.json')))
      .toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')))
      .toMatchObject({
        phase: 'preflight',
        status: 'failed_before_stop',
        message: 'exact_runtime_preparation_or_preflight_failed',
      });
  });

  it('rejects single-use disabled-bootstrap evidence before any promotion mutation', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'bootstrap-dr-fixture');
    const previous = path.join(fixture, 'production', 'releases', 'previous-runtime');
    const current = path.join(fixture, 'production', 'current');
    const mutationMarker = path.join(fixture, 'worker-mutated');
    const mutationScript = path.join(root, 'bin', 'bootstrap-mutation-sentinel');
    const bootstrapDr = path.join(root, 'bin', 'bootstrap-application-dr-backup');
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, current);
    fs.writeFileSync(
      mutationScript,
      '#!/usr/bin/env bash\n: > "$MUTATION_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(bootstrapDr, `#!/usr/bin/env bash
printf '%s\\n' 'application_dr_backup_config_ok encryption=age transport=s3-compatible storageProvider=aws-s3 storageControlMode=versioned-s3 lifecyclePhase=disabled-bootstrap bootstrapReceipt=absent releasePrefixLock=verified databaseRetentionPolicy=24-hourly,7-daily,4-weekly,6-monthly releaseRetentionPolicy=90-days'
`, { mode: 0o755 });

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_DR_BACKUP_BIN: bootstrapDr,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: mutationScript,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        MUTATION_MARKER: mutationMarker,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(
      'application DR provisioning/config preflight returned invalid evidence',
    );
    expect(fs.existsSync(mutationMarker)).toBe(false);
    expect(fs.realpathSync(current)).toBe(previous);
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    )).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'application_dr_provisioning_or_config_invalid',
    });
  });

  it('keeps the producer and promotion DR readiness contracts exactly synchronized', () => {
    const brokerSource = fs.readFileSync(broker, 'utf8');
    const producerSource = fs.readFileSync(
      path.resolve('scripts/application-dr-backup.sh'),
      'utf8',
    );
    const templateMatch = producerSource.match(
      /echo "(application_dr_backup_config_ok[^"\n]+)"/u,
    );
    expect(templateMatch).not.toBeNull();
    const materialize = (
      provider: string,
      controlMode: string,
      phase: string,
      receipt: string,
    ) => templateMatch![1]
      .replace('$NEXUS_DR_STORAGE_PROVIDER', provider)
      .replace('$NEXUS_DR_STORAGE_CONTROL_MODE', controlMode)
      .replace('$lifecycle_phase', phase)
      .replace('$bootstrap_receipt_state', receipt);
    const awsReady = materialize(
      'aws-s3',
      'versioned-s3',
      'enabled',
      'not-applicable',
    );
    const r2Ready = materialize(
      'cloudflare-r2',
      'r2-approved-variance',
      'approved-r2-variance',
      'not-applicable',
    );
    const disabledBootstrap = materialize(
      'aws-s3',
      'versioned-s3',
      'disabled-bootstrap',
      'absent',
    );
    const preflightStart = brokerSource.indexOf('preflight_application_dr() {');
    const preflightEnd = brokerSource.indexOf(
      '\n}\n\nwrite_cutover_timing()',
      preflightStart,
    );
    expect(preflightStart).toBeGreaterThan(-1);
    expect(preflightEnd).toBeGreaterThan(preflightStart);
    const preflight = brokerSource.slice(preflightStart, preflightEnd + 2);
    const accepted = [...preflight.matchAll(
      /'(application_dr_backup_config_ok[^']+)'\) ;;/gu,
    )].map((match) => match[1]);
    expect(accepted).toEqual([awsReady, r2Ready]);
    expect(accepted).not.toContain(disabledBootstrap);

    const dr = path.join(root, 'bin', 'contract-application-dr-backup');
    fs.writeFileSync(
      dr,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$DR_OUTPUT"\n',
      { mode: 0o755 },
    );
    const runPreflight = (output: string) => spawnSync('/bin/bash', ['-s', '--'], {
      encoding: 'utf8',
      input: [
        'set -u',
        'TIMEOUT_BIN=timeout_fixture',
        `DR_BACKUP_BIN=${JSON.stringify(dr)}`,
        `DR_CONFIG=${JSON.stringify(drConfig)}`,
        'timeout_fixture() { shift 3; "$@"; }',
        preflight,
        'preflight_application_dr',
      ].join('\n'),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        DR_OUTPUT: output,
      },
    });

    expect(runPreflight(awsReady).status).toBe(0);
    expect(runPreflight(r2Ready).status).toBe(0);
    const oldCompleteAws = awsReady.replace(
      ' lifecyclePhase=enabled bootstrapReceipt=not-applicable',
      '',
    );
    expect(runPreflight(oldCompleteAws).stderr).toContain(
      'application DR provisioning/config preflight returned invalid evidence',
    );
    expect(runPreflight(disabledBootstrap).stderr).toContain(
      'application DR provisioning/config preflight returned invalid evidence',
    );
  });

  it.each([
    ['a different transaction escrow ID', {
      DR_ESCROW_ID_OVERRIDE: '20260722T120001Z-1235-fedcba654321',
    }],
    ['a missing AWS object version', {
      DR_OBJECT_VERSION_ID_OVERRIDE: 'null',
    }],
    ['less than 90 days of AWS retention', {
      DR_RETAIN_DAYS: '89',
    }],
    ['a missing encrypted-object digest', {
      DR_RUNTIME_ENCRYPTED_SHA256_OVERRIDE: 'invalid',
    }],
    ['a zero-byte encrypted object', {
      DR_RUNTIME_ENCRYPTED_SIZE_BYTES_OVERRIDE: '0',
    }],
  ])('fails before cutover when current recovery escrow returns %s', (_label, proofEnv) => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        ...proofEnv,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: runner,
      }),
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('pre-mutation current recovery runtime escrow evidence is invalid');
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    expect(fs.existsSync(path.join(authoritative, 'preflight-current-recovery.json'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'recovery-armed'))).toBe(false);
    expect(fs.existsSync(path.join(authoritative, 'cutover-timing.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'))).toMatchObject({
      phase: 'preflight',
      status: 'failed_before_stop',
      message: 'current_recovery_runtime_not_escrowed_before_mutation',
    });
  });

  it('blocks local rollback pruning until the exact encrypted off-host escrow is confirmed', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'escrow-fixture');
    const backupDir = path.join(fixture, 'backups');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'bin'), { recursive: true });
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(production, '.env'), 'PORTAL_TOKEN=fixture-token\n', { mode: 0o600 });
    fs.symlinkSync(target, path.join(production, 'current'));
    fs.writeFileSync(path.join(fixture, 'bin', 'pm2'), `#!/usr/bin/env bash
if [ -n "\${RECOVERY_CALLED:-}" ] && [ -f "$RECOVERY_CALLED" ]; then
  if [ "\${1:-}" = jlist ]; then printf '%s\n' '${JSON.stringify([
    { name: 'nexus-hub', pid: 1, pm2_env: { status: 'online', pm_cwd: previous, pm_exec_path: `${previous}/dist/index.js`, exec_interpreter: 'node', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
    { name: 'content-engine', pid: 2, pm2_env: { status: 'online', pm_cwd: `${previous}/content-engine`, pm_exec_path: `${previous}/content-engine/.venv/bin/python3.12`, exec_interpreter: 'none', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
  ])}'; fi
  exit 0
fi
if [ -n "\${CANDIDATE_DEGRADE_MARKER:-}" ] && [ -f "$CANDIDATE_DEGRADE_MARKER" ]; then
  printf '[]\\n'
  exit 0
fi
if [ "\${1:-}" = jlist ]; then printf '%s\n' '${JSON.stringify([
  { name: 'nexus-hub', pid: 3, pm2_env: { status: 'online', pm_cwd: target, pm_exec_path: `${target}/dist/index.js`, exec_interpreter: 'node', NEXUS_RELEASE_SHA: 'b'.repeat(40), SENTRY_RELEASE: 'b'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
  { name: 'content-engine', pid: 4, pm2_env: { status: 'online', pm_cwd: `${target}/content-engine`, pm_exec_path: `${target}/content-engine/.venv/bin/python3.12`, exec_interpreter: 'none', NEXUS_RELEASE_SHA: 'b'.repeat(40), SENTRY_RELEASE: 'b'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
])}'; fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fixture, 'bin', 'curl'), `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */api/snapshot) printf '{"version":"4.14.231"}\\n' ;;
  *health*) printf '{"status":"healthy","server":{"status":"online"},"database":"connected"}\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(
      path.join(fixture, 'bin', 'sleep'),
      '#!/usr/bin/env bash\nexit 0\n',
      { mode: 0o755 },
    );
    const backups: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const file = path.join(backupDir, `v4.14.${200 + index}.tar.gz`);
      fs.writeFileSync(file, `rollback-${index}\n`, { mode: 0o600 });
      fs.utimesSync(file, new Date(1_700_000_000_000 + index * 1000), new Date(1_700_000_000_000 + index * 1000));
      backups.push(file);
    }
    const exact = backups.at(-1)!;
    const exactSha = spawnSync('node', ['-e',
      'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))', exact],
    { encoding: 'utf8' }).stdout;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const requestSha256 = JSON.parse(launch.stdout).requestSha256;
    fs.writeFileSync(path.join(authoritative, 'result.env'), [
      `NEXUS_TRANSACTION_ID=${id}`,
      `NEXUS_RUNTIME_SHA=${'b'.repeat(40)}`,
      `NEXUS_SENTRY_RELEASE=${'b'.repeat(40)}`,
      `NEXUS_ARTIFACT_DIGEST=${'c'.repeat(64)}`,
      `NEXUS_INSTALLED_RUNTIME_DIGEST=${'d'.repeat(64)}`,
      'NEXUS_TARGET_VERSION=4.14.231',
      'NEXUS_CUTOVER_STARTED_AT=2026-07-22T12:00:00Z',
      'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT=2026-07-22T12:00:01Z',
      'NEXUS_CANDIDATE_AVAILABLE_AT=2026-07-22T12:00:08Z',
      'NEXUS_CUTOVER_SECONDS=68',
      'NEXUS_BACKUP_WINDOW_SECONDS=4',
      'NEXUS_BACKUP_OUTAGE_SECONDS=4',
      'NEXUS_FINAL_UNAVAILABILITY_SECONDS=8',
      'NEXUS_TOTAL_UNAVAILABILITY_SECONDS=8',
      'NEXUS_VERIFICATION_SOAK_SECONDS=60',
      'NEXUS_SOAK_STARTED_AT=2026-07-22T12:00:08Z',
      'NEXUS_SOAK_COMPLETED_AT=2026-07-22T12:01:08Z',
      'NEXUS_SOAK_OBSERVED_SECONDS=60',
      `NEXUS_BACKUP_FILE=${exact}`,
      `NEXUS_BACKUP_SHA256=${exactSha}`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1', transactionId: id, requestSha256,
      phase: 'awaiting_dr_escrow', status: 'escrow_pending',
    })}\n`, { mode: 0o600 });
    writeRootRecoveryIntent(authoritative, requestSha256, 'candidate_authorized', {
      file: exact,
      sha256: exactSha,
      sizeBytes: fs.statSync(exact).size,
      databaseSha256: '7'.repeat(64),
    });
    const recoveryIntent = path.join(authoritative, 'recovery-armed');
    writeRootRecoveryIntent(authoritative, requestSha256, 'candidate_authorized', {
      file: exact,
      sha256: exactSha,
      sizeBytes: fs.statSync(exact).size,
      databaseSha256: '7'.repeat(64),
    });
    writePreflightRecoveryFixture(target, requestSha256);
    const drConfig = path.join(root, 'dr.env');
    fs.writeFileSync(drConfig, 'fixture=true\n', { mode: 0o600 });
    const dr = path.join(root, 'bin', 'dr-backup');
    writeAwsDrFixture(dr);
    const escrowAttemptLog = path.join(root, 'escrow-attempts.log');
    const escrowEnv = {
      NEXUS_PROMOTION_DR_BACKUP_BIN: dr,
      NEXUS_PROMOTION_DR_CONFIG: drConfig,
      NEXUS_PROMOTION_TRANSACTION_SCRIPT: runner,
      NEXUS_PROMOTION_TEST_ROOT: fixture,
      NEXUS_PROMOTION_SLEEP_BIN: path.join(fixture, 'bin', 'sleep'),
      DR_ATTEMPT_LOG: escrowAttemptLog,
      PATH: `${path.join(fixture, 'bin')}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    };

    const uptimePath = '/proc/uptime';
    const bootIdPath = '/proc/sys/kernel/random/boot_id';
    const nowMonotonic = fs.existsSync(uptimePath)
      ? Math.floor(Number(fs.readFileSync(uptimePath, 'utf8').split(/\s+/u)[0]))
      : Math.floor(Date.now() / 1000);
    const bootId = fs.existsSync(bootIdPath)
      ? fs.readFileSync(bootIdPath, 'utf8').trim()
      : 'test-boot';
    fs.writeFileSync(path.join(authoritative, 'cutover-timing.json'), `${JSON.stringify({
      schema: 'nexus.promotion-cutover-timing.v1',
      startedAt: '2026-07-22T12:00:00Z',
      startedMonotonicSeconds: nowMonotonic,
      preRecoveryDeadlineMonotonicSeconds: nowMonotonic + 60,
      outageDeadlineMonotonicSeconds: nowMonotonic + 120,
      bootId,
    })}\n`, { mode: 0o600 });
    const degradeMarker = path.join(root, 'candidate-degraded-during-escrow');
    const recoveryCalled = path.join(root, 'degraded-candidate-recovery-called');
    const degradationWorker = path.join(root, 'bin', 'degradation-worker');
    fs.writeFileSync(degradationWorker, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = worker-recover ]; then
  : > "$RECOVERY_CALLED"
  rm -f "$RECOVERY_PRODUCTION/current"
  ln -s "$RECOVERY_PREDECESSOR" "$RECOVERY_PRODUCTION/current"
  exit 0
fi
exec bash ${JSON.stringify(runner)} "$@"
`, { mode: 0o755 });
    hardenSelectorFixture(fixture, [previous, target]);
    const resetEscrowPendingState = () => {
      fs.rmSync(degradeMarker, { force: true });
      fs.rmSync(recoveryCalled, { force: true });
      fs.rmSync(path.join(authoritative, 'recovery-attempt-timing.json'), { force: true });
      fs.rmSync(path.join(authoritative, 'recovery-result.json'), { force: true });
      fs.rmSync(path.join(authoritative, 'escrow-confirmation.json'), { force: true });
      fs.rmSync(path.join(production, 'current'), { force: true });
      fs.symlinkSync(target, path.join(production, 'current'));
      fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
        schema: 'nexus.promotion-transaction-journal.v1', transactionId: id, requestSha256,
        phase: 'awaiting_dr_escrow', status: 'escrow_pending',
      })}\n`, { mode: 0o600 });
      writeRootRecoveryIntent(authoritative, requestSha256, 'candidate_authorized', {
        file: exact,
        sha256: exactSha,
        sizeBytes: fs.statSync(exact).size,
        databaseSha256: '7'.repeat(64),
      });
    };

    const degraded = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        ...escrowEnv,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: degradationWorker,
        DR_COMPLETED_MARKER: degradeMarker,
        CANDIDATE_DEGRADE_MARKER: degradeMarker,
        RECOVERY_CALLED: recoveryCalled,
        RECOVERY_PREDECESSOR: previous,
        RECOVERY_PRODUCTION: production,
      }),
    });
    expect(degraded.status, degraded.stderr).toBe(0);
    expect(degraded.stderr).toContain(
      'candidate degraded while encrypted off-host escrow was running',
    );
    expect(fs.existsSync(recoveryCalled)).toBe(true);
    expect(fs.readdirSync(backupDir)).toHaveLength(11);
    expect(fs.existsSync(path.join(authoritative, 'escrow-confirmation.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')))
      .toMatchObject({
        phase: 'recovery_complete',
        status: 'recovered',
        message: 'escrow_candidate_degradation_recovered',
      });
    expect(JSON.parse(fs.readFileSync(
      path.join(authoritative, 'recovery-result.json'),
      'utf8',
    ))).toMatchObject({
      schema: 'nexus.promotion-recovery-result.v1',
      timingScope: 'post_availability_detection',
      originalCutoverStartedAt: '2026-07-22T12:00:00Z',
      targetSeconds: 120,
    });

    resetEscrowPendingState();
    fs.rmSync(escrowAttemptLog, { force: true });
    const degradedBeforeRetry = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        ...escrowEnv,
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: degradationWorker,
        DR_FAIL_ATTEMPTS: '1',
        DR_DEGRADE_ON_FAILURE_MARKER: degradeMarker,
        CANDIDATE_DEGRADE_MARKER: degradeMarker,
        RECOVERY_CALLED: recoveryCalled,
        RECOVERY_PREDECESSOR: previous,
        RECOVERY_PRODUCTION: production,
      }),
    });
    expect(degradedBeforeRetry.status, degradedBeforeRetry.stderr).toBe(0);
    expect(degradedBeforeRetry.stderr).toContain(
      'candidate PM2 exact identity or restart stability failed',
    );
    expect(fs.existsSync(recoveryCalled)).toBe(true);
    expect(fs.readFileSync(escrowAttemptLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')))
      .toMatchObject({
        phase: 'recovery_complete',
        status: 'recovered',
        message: 'escrow_retry_candidate_recovered',
        escrowRetry: {
          attempt: 1,
          errorClass: 'candidate_invalid_before_escrow_retry',
        },
      });

    resetEscrowPendingState();
    fs.rmSync(escrowAttemptLog, { force: true });
    const blocked = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({ ...escrowEnv, DR_INVALID_STORAGE_CONTROLS: '1' }),
    });
    expect(blocked.status, blocked.stderr).toBe(75);
    expect(fs.existsSync(recoveryIntent)).toBe(true);
    expect(fs.readdirSync(backupDir)).toHaveLength(11);
    expect(fs.readFileSync(escrowAttemptLog, 'utf8').trim().split('\n')).toHaveLength(8);
    const blockedJournal = JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    );
    expect(blockedJournal).toMatchObject({
      phase: 'awaiting_dr_escrow',
      status: 'escrow_pending',
      message: 'rollback_escrow_retry_exhausted',
      phaseTiming: {
        sequence: 1,
        bootId,
        timingSource: 'monotonic',
      },
      invocation: {
        bootId,
      },
      escrowRetry: {
        attempt: 8,
        maxAttempts: 8,
        budgetSeconds: 1200,
        nextAttemptAt: null,
        nextAttemptMonotonicSeconds: null,
        errorClass: 'dr_escrow_evidence_invalid',
        bootId,
        exhaustionReason: 'attempt_limit',
      },
    });
    expect(Date.parse(blockedJournal.escrowRetry.exhaustedAt)).not.toBeNaN();
    expect(blockedJournal.invocation.id).toMatch(/^[A-Za-z0-9._:-]+$/u);
    expect(blockedJournal.invocation.pid).toBeGreaterThan(0);
    fs.rmSync(escrowAttemptLog, { force: true });
    const exhaustedRelaunch = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env(escrowEnv),
    });
    expect(exhaustedRelaunch.status, exhaustedRelaunch.stderr).toBe(75);
    expect(fs.existsSync(escrowAttemptLog)).toBe(false);
    expect(JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    ).escrowRetry.attempt).toBe(8);

    const budgetStart = blockedJournal.phaseTiming.updatedMonotonicSeconds + 1;
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      ...blockedJournal,
      message: 'rollback_escrow_retry_scheduled',
      escrowRetry: {
        ...blockedJournal.escrowRetry,
        attempt: 1,
        cycleStartedAt: new Date().toISOString(),
        cycleStartedMonotonicSeconds: budgetStart,
        deadlineMonotonicSeconds: budgetStart + 1,
        nextAttemptAt: null,
        nextAttemptMonotonicSeconds: null,
        exhaustedAt: null,
        exhaustionReason: null,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    const budgetExhausted = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        ...escrowEnv,
        NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS: String(budgetStart + 1),
      }),
    });
    expect(budgetExhausted.status, budgetExhausted.stderr).toBe(75);
    expect(fs.existsSync(escrowAttemptLog)).toBe(false);
    expect(JSON.parse(
      fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8'),
    )).toMatchObject({
      escrowRetry: {
        attempt: 1,
        errorClass: 'retry_time_budget_exhausted',
        exhaustionReason: 'time_budget',
      },
    });

    // Resume from a crash after seven consumed attempts so this distinct
    // evidence-drift case proves persisted attempt accounting without paying
    // for a second redundant eight-attempt fixture cycle.
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      ...blockedJournal,
      message: 'rollback_escrow_attempt_started',
      escrowRetry: {
        ...blockedJournal.escrowRetry,
        attempt: 7,
        exhaustedAt: null,
        exhaustionReason: null,
      },
    }, null, 2)}\n`, { mode: 0o600 });
    fs.rmSync(escrowAttemptLog, { force: true });
    const drifted = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        ...escrowEnv,
        DR_RUNTIME_PLAINTEXT_SHA256_OVERRIDE: 'a'.repeat(64),
      }),
    });
    expect(drifted.status, drifted.stderr).toBe(75);
    expect(drifted.stderr).toContain('invalid storage-control evidence');
    expect(fs.readdirSync(backupDir)).toHaveLength(11);
    expect(fs.readFileSync(escrowAttemptLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')).status)
      .toBe('escrow_pending');

    // Start a distinct clean fixture state for the transient-success case.
    // Production relaunches must retain, rather than reset, an exhausted
    // transaction's eight-attempt ceiling.
    resetEscrowPendingState();
    fs.rmSync(escrowAttemptLog, { force: true });
    const confirmed = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({ ...escrowEnv, DR_FAIL_ATTEMPTS: '2' }),
    });
    expect(confirmed.status, confirmed.stderr).toBe(0);
    expect(fs.readFileSync(escrowAttemptLog, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(fs.readdirSync(backupDir)).toHaveLength(10);
    expect(fs.existsSync(exact)).toBe(true);
    const confirmationPath = path.join(authoritative, 'escrow-confirmation.json');
    expect(fs.existsSync(confirmationPath)).toBe(true);
    const confirmation = JSON.parse(fs.readFileSync(confirmationPath, 'utf8'));
    expect(confirmation).toMatchObject({
      schema: 'nexus.promotion-dr-escrow.v3',
      status: 'passed',
      transactionId: id,
      storageControls: {
        provider: 'aws-s3',
        controlMode: 'versioned-s3',
        releasePrefixLockVerified: true,
      },
      requiredRelease: {
        path: exact,
        plaintextSha256: exactSha,
        encryptedSha256: '3'.repeat(64),
        encryptedSizeBytes: 2048,
        objectVersionId: '--opaque-release-✓|4',
        retentionVariance: null,
        approvedUnversionedVariance: false,
        confirmed: true,
      },
      currentRecoveryRuntime: {
        path: target,
        encryptedSha256: '4'.repeat(64),
        encryptedSizeBytes: 4096,
        escrowId: id,
        escrowPhase: 'post-soak',
        objectVersionId: '--opaque-recovery-current-✓|3',
        retentionVariance: null,
        approvedUnversionedVariance: false,
        confirmed: true,
      },
      preMutationCurrentRecovery: {
        path: target,
        encryptedSha256: '5'.repeat(64),
        encryptedSizeBytes: 3584,
        escrowId: id,
        escrowPhase: 'pre-mutation',
        objectVersionId: '--opaque-recovery-pre-✓|1',
        confirmedAt: preMutationRecoveryConfirmedAt,
        retentionVariance: null,
        approvedUnversionedVariance: false,
        confirmed: true,
      },
      preMutationDatabaseRecoveryPoint: {
        plaintextSha256: '7'.repeat(64),
        encryptedSha256: '2'.repeat(64),
        encryptedSizeBytes: 1024,
        objectVersionId: '--opaque-database-pre-✓|2',
        confirmedAt: preMutationDatabaseConfirmedAt,
      },
      currentDatabaseRecoveryPoint: {
        plaintextSha256: '7'.repeat(64),
        encryptedSha256: '1'.repeat(64),
        encryptedSizeBytes: 1536,
        objectVersionId: '--opaque-database-current-✓|5',
      },
      promotionTimeline: {
        cutoverStartedAt: '2026-07-22T12:00:00Z',
        serviceUnavailableStartedAt: '2026-07-22T12:00:01Z',
        soakCompletedAt: '2026-07-22T12:01:08Z',
      },
      candidateReadinessRefresh: {
        beforeEscrow: {
          schema: 'nexus.candidate-readiness-refresh.v1',
          status: 'passed',
          transactionId: id,
          runtimeSha: 'b'.repeat(40),
          packageVersion: '4.14.231',
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
          transactionId: id,
          runtimeSha: 'b'.repeat(40),
          packageVersion: '4.14.231',
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
    expect(confirmation.currentRecoveryRuntime.objectKey)
      .toContain(`+escrow-${id}+phase-post-soak.tar.gz.`);
    expect(confirmation.preMutationCurrentRecovery.objectKey)
      .toContain(`+escrow-${id}+phase-pre-mutation.tar.gz.`);
    for (const proof of [confirmation.requiredRelease, confirmation.currentRecoveryRuntime]) {
      expect(Date.parse(proof.retainUntil) - Date.parse(proof.confirmedAt))
        .toBeGreaterThanOrEqual(90 * 24 * 60 * 60 * 1000);
    }
    for (const field of [
      'path',
      'plaintextSha256',
      'runtimeSha',
      'artifactDigest',
      'installedRuntimeDigest',
      'recoveryRuntimeDigest',
      'releaseManifestSha256',
      'stagingAttestationSha256',
      'escrowId',
    ]) {
      expect(confirmation.preMutationCurrentRecovery[field])
        .toBe(confirmation.currentRecoveryRuntime[field]);
    }
    expect(confirmation.preMutationCurrentRecovery.objectKey)
      .not.toBe(confirmation.currentRecoveryRuntime.objectKey);
    expect(confirmation.preMutationCurrentRecovery.encryptedSha256)
      .not.toBe(confirmation.currentRecoveryRuntime.encryptedSha256);
    expect(confirmation.preMutationCurrentRecovery.encryptedSizeBytes)
      .not.toBe(confirmation.currentRecoveryRuntime.encryptedSizeBytes);
    expect(confirmation.preMutationCurrentRecovery.objectVersionId)
      .not.toBe(confirmation.currentRecoveryRuntime.objectVersionId);
    expect(Date.parse(confirmation.preMutationCurrentRecovery.confirmedAt))
      .toBeLessThanOrEqual(Date.parse(confirmation.promotionTimeline.cutoverStartedAt));
    expect(Date.parse(confirmation.currentRecoveryRuntime.confirmedAt))
      .toBeGreaterThanOrEqual(Date.parse(confirmation.promotionTimeline.soakCompletedAt));
    expect(Date.parse(confirmation.candidateReadinessRefresh.beforeEscrow.verifiedAt))
      .toBeGreaterThanOrEqual(Date.parse(confirmation.promotionTimeline.soakCompletedAt));
    expect(Date.parse(confirmation.currentRecoveryRuntime.confirmedAt))
      .toBeGreaterThanOrEqual(
        Date.parse(confirmation.candidateReadinessRefresh.beforeEscrow.verifiedAt),
      );
    expect(Date.parse(confirmation.currentDatabaseRecoveryPoint.confirmedAt))
      .toBeGreaterThanOrEqual(
        Date.parse(confirmation.candidateReadinessRefresh.beforeEscrow.verifiedAt),
      );
    expect(Date.parse(confirmation.candidateReadinessRefresh.afterEscrow.verifiedAt))
      .toBeGreaterThanOrEqual(Date.parse(confirmation.currentRecoveryRuntime.confirmedAt));
    expect(Date.parse(confirmation.candidateReadinessRefresh.afterEscrow.verifiedAt))
      .toBeGreaterThanOrEqual(
        Date.parse(confirmation.currentDatabaseRecoveryPoint.confirmedAt),
      );
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')))
      .toMatchObject({
        status: 'completed',
        escrowRetry: {
          attempt: 3,
          maxAttempts: 8,
          nextAttemptAt: null,
          errorClass: null,
          exhaustedAt: null,
        },
      });
    expect(fs.existsSync(recoveryIntent)).toBe(false);
  }, 45_000);

  it('recovers immediately on restart when authoritative recovery intent exists', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const authoritative = path.join(stateRoot, 'transactions', id, 'state');
    const recoveryIntent = path.join(authoritative, 'recovery-armed');
    const recoveryDescriptor = path.join(authoritative, 'recovery-runtime-descriptor.json');
    const descriptorBody = '{"schema":"fixture.pre-mutation-recovery-descriptor"}\n';
    writeRootRecoveryIntent(authoritative, requestSha256, 'pre_candidate');
    fs.writeFileSync(recoveryDescriptor, descriptorBody, { mode: 0o600 });

    const uptimePath = '/proc/uptime';
    const bootIdPath = '/proc/sys/kernel/random/boot_id';
    const nowMonotonic = fs.existsSync(uptimePath)
      ? Math.floor(Number(fs.readFileSync(uptimePath, 'utf8').split(/\s+/u)[0]))
      : Math.floor(Date.now() / 1000);
    const bootId = fs.existsSync(bootIdPath)
      ? fs.readFileSync(bootIdPath, 'utf8').trim()
      : 'test-boot';
    const cutoverStartedAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(path.join(authoritative, 'cutover-timing.json'), `${JSON.stringify({
      schema: 'nexus.promotion-cutover-timing.v1',
      startedAt: cutoverStartedAt,
      startedMonotonicSeconds: nowMonotonic,
      preRecoveryDeadlineMonotonicSeconds: nowMonotonic + 60,
      outageDeadlineMonotonicSeconds: nowMonotonic + 120,
      bootId,
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(authoritative, 'journal.json'), `${JSON.stringify({
      schema: 'nexus.promotion-transaction-journal.v1',
      transactionId: id,
      requestSha256,
      phase: 'executing',
      status: 'running',
      startedAt: cutoverStartedAt,
    })}\n`, { mode: 0o600 });

    const recoveryModeLog = path.join(root, 'recovery-mode.log');
    const recoveryScript = path.join(root, 'bin', 'recovery-only-transaction');
    fs.writeFileSync(recoveryScript, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${1:-}" > "$RECOVERY_MODE_LOG"
[ "\${1:-}" = worker-recover ]
`, { mode: 0o755 });
    const drCalled = path.join(root, 'dr-preflight-called');
    const drSentinel = path.join(root, 'bin', 'unexpected-dr-preflight');
    fs.writeFileSync(drSentinel, `#!/usr/bin/env bash
: > "$DR_CALLED"
exit 99
`, { mode: 0o755 });
    const liveFixture = path.join(root, 'restart-recovery-live');
    const liveProduction = path.join(liveFixture, 'production');
    const livePredecessor = path.join(liveProduction, 'releases', 'previous-runtime');
    const liveBin = path.join(liveFixture, 'bin');
    fs.mkdirSync(path.join(livePredecessor, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(liveProduction, 'releases', 'target-runtime'), { recursive: true });
    fs.mkdirSync(path.join(liveFixture, 'backups'), { recursive: true });
    fs.mkdirSync(liveBin, { recursive: true });
    fs.symlinkSync(livePredecessor, path.join(liveProduction, 'current'));
    fs.writeFileSync(path.join(liveBin, 'pm2'), `#!/usr/bin/env bash
if [ "\${1:-}" = jlist ]; then printf '%s\\n' '${JSON.stringify([
  { name: 'nexus-hub', pid: 1, pm2_env: { status: 'online', pm_cwd: livePredecessor, pm_exec_path: `${livePredecessor}/dist/index.js`, exec_interpreter: 'node', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
  { name: 'content-engine', pid: 2, pm2_env: { status: 'online', pm_cwd: `${livePredecessor}/content-engine`, pm_exec_path: `${livePredecessor}/content-engine/.venv/bin/python3.12`, exec_interpreter: 'none', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
])}'; fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(liveBin, 'curl'), `#!/usr/bin/env bash
if [[ "\${!#}" == *"8200/health"* ]]; then
  printf '{"status":"healthy","server":{"status":"online"},"database":"connected"}\\n'
fi
`, { mode: 0o755 });
    hardenSelectorFixture(liveFixture, [
      livePredecessor,
      path.join(liveProduction, 'releases', 'target-runtime'),
    ]);

    const recovered = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: recoveryScript,
        NEXUS_PROMOTION_DR_BACKUP_BIN: drSentinel,
        NEXUS_PROMOTION_TEST_ROOT: liveFixture,
        NEXUS_PROMOTION_TEST_MONOTONIC_SECONDS: String(nowMonotonic + 121),
        RECOVERY_MODE_LOG: recoveryModeLog,
        DR_CALLED: drCalled,
        PATH: `${liveBin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      }),
    });

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(fs.readFileSync(recoveryModeLog, 'utf8').trim()).toBe('worker-recover');
    expect(fs.existsSync(drCalled)).toBe(false);
    expect(fs.existsSync(recoveryIntent)).toBe(false);
    expect(fs.readFileSync(recoveryDescriptor, 'utf8')).toBe(descriptorBody);
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'journal.json'), 'utf8')))
      .toMatchObject({
        phase: 'recovery_complete',
        status: 'recovered',
        message: 'explicit_or_boot_recovery_completed',
      });
    expect(JSON.parse(fs.readFileSync(path.join(authoritative, 'recovery-result.json'), 'utf8')))
      .toMatchObject({
        schema: 'nexus.promotion-recovery-result.v1',
        timingScope: 'original_cutover',
        originalCutoverStartedAt: cutoverStartedAt,
        outageStartedAt: cutoverStartedAt,
        outageToHealthySeconds: 121,
        targetSeconds: 120,
        targetMet: false,
      });
    expect(JSON.parse(
      fs.readFileSync(path.join(authoritative, 'recovery-attempt-timing.json'), 'utf8'),
    )).toMatchObject({
      schema: 'nexus.promotion-recovery-attempt-timing.v1',
      scope: 'original_cutover',
      originalCutoverStartedAt: cutoverStartedAt,
      measurementStartedAt: cutoverStartedAt,
      startedMonotonicSeconds: nowMonotonic,
      deadlineMonotonicSeconds: nowMonotonic + 120,
      bootId,
    });
  });

  it('persists recovery intent before the first PM2 stop and automatically restores after an injected stop failure', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const fixture = path.join(root, 'worker-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(path.join(production, 'data'), { recursive: true });
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'backups'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(previous, '.complete.json'), `${JSON.stringify({ runtimeSha: 'a'.repeat(40) })}\n`);
    fs.writeFileSync(path.join(previous, 'ecosystem.release.config.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(target, 'scripts', 'remote-release-capacity.sh'), '#!/usr/bin/env bash\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
    fs.symlinkSync(previous, path.join(production, 'current'));
    const armed = path.join(stateRoot, 'transactions', id, 'worker', 'recovery-armed');
    const authoritativeArmed = path.join(stateRoot, 'transactions', id, 'state', 'recovery-armed');
    const pm2Log = path.join(fixture, 'pm2.log');
    const pm2Rows = JSON.stringify([
      { name: 'nexus-hub', pid: 1, pm2_env: { status: 'online', pm_cwd: previous, pm_exec_path: `${previous}/dist/index.js`, exec_interpreter: 'node', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
      { name: 'content-engine', pid: 2, pm2_env: { status: 'online', pm_cwd: `${previous}/content-engine`, pm_exec_path: `${previous}/content-engine/.venv/bin/python3.12`, exec_interpreter: 'none', NEXUS_RELEASE_SHA: 'a'.repeat(40), SENTRY_RELEASE: 'a'.repeat(40), restart_time: 0, unstable_restarts: 0 } },
    ]);
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> ${JSON.stringify(pm2Log)}
case "\${1:-}" in
  jlist) printf '%s\n' ${JSON.stringify(pm2Rows)} ;;
  describe) exit 0 ;;
  stop) [ -f ${JSON.stringify(armed)} ] || exit 99; exit 42 ;;
  save)
    mkdir -p "$NEXUS_PROMOTION_PM2_STATE_DIR"
    printf '[]\\n' > "$NEXUS_PROMOTION_PM2_STATE_DIR/dump.pm2"
    ;;
  delete|start) exit 0 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
if [[ " $* " == *"8200/health"* ]]; then printf '{"status":"healthy","server":{"status":"online"},"database":"connected"}\n'; else printf '{}\n'; fi
`, { mode: 0o755 });
    const timeoutShim = path.join(bin, 'timeout');
    fs.writeFileSync(timeoutShim, `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --signal=*|--kill-after=*|[0-9]*s) shift ;; *) break ;; esac; done
exec "$@"
`, { mode: 0o755 });
    hardenSelectorFixture(fixture, [previous, target]);

    const result = spawnSync('bash', [broker, 'run', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_TRANSACTION_SCRIPT: runner,
        NEXUS_PROMOTION_TIMEOUT_BIN: timeoutShim,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        PATH: `${bin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      }),
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = fs.existsSync(pm2Log) ? fs.readFileSync(pm2Log, 'utf8') : '<no-pm2-log>';
    const diagnosticJournal = fs.existsSync(path.join(stateRoot, 'transactions', id, 'worker', 'worker-progress.json'))
      ? fs.readFileSync(path.join(stateRoot, 'transactions', id, 'worker', 'worker-progress.json'), 'utf8') : '<no-journal>';
    expect(fs.existsSync(armed), `${result.stderr}\n${calls}\n${diagnosticJournal}`).toBe(true);
    expect(fs.existsSync(authoritativeArmed)).toBe(false);
    expect(calls).toContain('stop nexus-hub');
    expect(calls).toContain('start');
    const journal = JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', id, 'state', 'journal.json'), 'utf8'));
    expect(journal.status).toBe('recovered');
  });

  it('fails closed when root recovery phase is missing or conflicts with candidate state', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const fixture = path.join(root, 'ambiguous-recovery-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'backups'), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync(previous, path.join(production, 'current'));
    fs.writeFileSync(path.join(bin, 'pm2'), '#!/usr/bin/env bash\nexit 99\n', {
      mode: 0o755,
    });
    const baseEnv = env({
      NEXUS_PROMOTION_REQUEST_SHA256: requestSha256,
      NEXUS_PROMOTION_TEST_ROOT: fixture,
      PATH: `${bin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    });

    const missingPhase = spawnSync('bash', [runner, 'worker-recover', id], {
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(missingPhase.status).toBe(1);
    expect(missingPhase.stderr).toContain('authoritative recovery phase is missing or invalid');

    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    fs.writeFileSync(path.join(worker, 'candidate-mutated'), `${JSON.stringify({
      schema: 'nexus.promotion-worker-candidate-mutated.v1',
      phase: 'candidate_authorized',
      transactionId: id,
      requestSha256,
      recordedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const conflictingPhase = spawnSync('bash', [runner, 'worker-recover', id], {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        NEXUS_PROMOTION_RECOVERY_PHASE: 'pre_candidate',
      },
    });
    expect(conflictingPhase.status).toBe(1);
    expect(conflictingPhase.stderr)
      .toContain('authoritative pre-candidate recovery conflicts with candidate mutation state');
  });

  it('rejects an exact-digest archive containing a symlink instead of extracting it during recovery', () => {
    const launch = run(['launch', envelopePath]);
    expect(launch.status, launch.stderr).toBe(0);
    const requestSha256 = JSON.parse(launch.stdout).requestSha256 as string;
    const fixture = path.join(root, 'unsafe-archive-fixture');
    const production = path.join(fixture, 'production');
    const previous = path.join(production, 'releases', 'previous-runtime');
    const target = path.join(production, 'releases', 'target-runtime');
    const backupDir = path.join(fixture, 'backups');
    const archiveSource = path.join(fixture, 'archive-source');
    const bin = path.join(fixture, 'bin');
    fs.mkdirSync(path.join(production, 'data'), { recursive: true });
    fs.mkdirSync(path.join(previous, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(target, 'content-engine'), { recursive: true });
    fs.mkdirSync(path.join(archiveSource, 'data'), { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.symlinkSync('/etc/passwd', path.join(archiveSource, 'data', 'bot.db'));
    const backup = path.join(backupDir, 'v4.14.231.tar.gz');
    const packed = spawnSync('/usr/bin/tar', ['-czf', backup, '-C', archiveSource, 'data'], {
      encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    expect(packed.status, packed.stderr).toBe(0);
    const bytes = fs.readFileSync(backup);
    const worker = path.join(stateRoot, 'transactions', id, 'worker');
    fs.writeFileSync(path.join(worker, 'backup.env'), [
      `NEXUS_BACKUP_FILE=${backup}`,
      `NEXUS_BACKUP_SHA256=${createHash('sha256').update(bytes).digest('hex')}`,
      `NEXUS_BACKUP_SIZE_BYTES=${bytes.length}`,
      `NEXUS_BACKUP_DATABASE_SHA256=${'a'.repeat(64)}`,
      '',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'candidate-mutated'), `${JSON.stringify({
      schema: 'nexus.promotion-worker-candidate-mutated.v1',
      phase: 'candidate_authorized',
      transactionId: id,
      requestSha256,
      recordedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(worker, 'recovery-armed'), `${JSON.stringify({
      schema: 'nexus.promotion-worker-recovery-armed.v1',
      phase: 'pre_candidate',
      transactionId: id,
      requestSha256,
      recordedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(bin, 'pm2'), `#!/usr/bin/env bash
case "\${1:-}" in describe|stop|delete|start|save) exit 0 ;; jlist) printf '[]\\n' ;; esac
`, { mode: 0o755 });

    const recovered = spawnSync('bash', [runner, 'worker-recover', id], {
      encoding: 'utf8',
      env: env({
        NEXUS_PROMOTION_REQUEST_SHA256: requestSha256,
        NEXUS_PROMOTION_TEST_ROOT: fixture,
        NEXUS_PROMOTION_RECOVERY_PHASE: 'candidate_authorized',
        NEXUS_PROMOTION_AUTHORIZED_BACKUP_FILE: backup,
        NEXUS_PROMOTION_AUTHORIZED_BACKUP_SHA256: createHash('sha256')
          .update(bytes)
          .digest('hex'),
        NEXUS_PROMOTION_AUTHORIZED_BACKUP_SIZE_BYTES: String(bytes.length),
        NEXUS_PROMOTION_AUTHORIZED_BACKUP_DATABASE_SHA256: 'a'.repeat(64),
        PATH: `${bin}:${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      }),
    });
    expect(recovered.status, `${recovered.stderr}\n${recovered.stdout}`).toBe(1);
    expect(recovered.stderr).toContain('unsupported rollback archive entry');
    const journal = JSON.parse(fs.readFileSync(path.join(worker, 'worker-progress.json'), 'utf8'));
    expect(journal.status).toBe('recovery_failed');
  });

  it.each([
    ['failed-before-stop', 'failed_before_stop' as const],
    ['recovered-at-120-second-boundary', 'recovered' as const],
  ])('archives deterministic prior authority and allocates a fresh ID after %s', (_label, outcome) => {
    const fixture = runGovernedTerminalRetryFixture({
      outcome,
      recoverySeconds: outcome === 'recovered' ? 120 : undefined,
    });

    // The fixture intentionally stops at the first fresh target-preparation
    // mutation, after governed retry rotation and fresh-ID persistence.
    expect(fixture.result.status).toBe(91);
    expect(fs.existsSync(fixture.livePredecessorProof)).toBe(true);
    const archivePath = path.join(
      fixture.checkpointDir,
      'terminal-retries',
      `${fixture.oldTransactionId}.json`,
    );
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.statSync(archivePath).mode & 0o777).toBe(0o600);
    const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    expect(archive).toMatchObject({
      schema: 'nexus.terminal-promotion-client-archive.v1',
      transactionId: fixture.oldTransactionId,
      requestSha256: fixture.requestSha256,
      terminalStatus: fixture.terminalStatus,
      archivedAt: fixture.terminalCompletedAt,
      clientCheckpoint: {
        sha256: createHash('sha256').update(fixture.checkpointBody).digest('hex'),
        bodyBase64: fixture.checkpointBody.toString('base64'),
      },
      signedRequestEnvelope: {
        path: fixture.envelopePath,
        sha256: createHash('sha256')
          .update(fs.readFileSync(fixture.envelopePath))
          .digest('hex'),
      },
      rawRequest: {
        path: fixture.requestPath,
        sha256: createHash('sha256')
          .update(fs.readFileSync(fixture.requestPath))
          .digest('hex'),
      },
    });
    expect(Buffer.from(archive.clientCheckpoint.bodyBase64, 'base64'))
      .toEqual(fixture.checkpointBody);

    const freshCheckpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8'));
    expect(freshCheckpoint).toMatchObject({
      ...fixture.checkpoint,
      transactionId: expect.stringMatching(/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u),
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(freshCheckpoint.transactionId).not.toBe(fixture.oldTransactionId);
    expect(fs.statSync(fixture.checkpointPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(fixture.sshLog, 'utf8'))
      .toContain('sudo -n /fake/control prepare-runtime-target');
  });

  it('does not adopt or overwrite a partial terminal retry archive after a crash', () => {
    const fixture = runGovernedTerminalRetryFixture({
      outcome: 'failed_before_stop',
      partialTerminalArchive: true,
    });

    expect(fixture.result.status).not.toBe(0);
    expect(fs.readFileSync(fixture.partialArchivePath, 'utf8')).toBe('{"schema":"partial');
    expect(fs.readFileSync(fixture.checkpointPath)).toEqual(fixture.checkpointBody);
  });

  it.each([
    ['recovery-failed terminal state', {
      outcome: 'recovery_failed' as const,
    }],
    ['recovered outside the 120-second budget', {
      outcome: 'recovered' as const,
      recoverySeconds: 121,
    }],
  ])('does not rotate client authority for %s', (_label, options) => {
    const fixture = runGovernedTerminalRetryFixture(options);

    expect(fixture.result.status).not.toBe(0);
    expect(fs.readFileSync(fixture.checkpointPath)).toEqual(fixture.checkpointBody);
    expect(fs.existsSync(path.join(fixture.checkpointDir, 'terminal-retries'))).toBe(false);
    expect(fs.existsSync(fixture.livePredecessorProof)).toBe(false);
  });

  it('fails closed when terminal predecessor identity is tampered', () => {
    const fixture = runGovernedTerminalRetryFixture({
      outcome: 'failed_before_stop',
      tamperPredecessorSha: true,
    });

    expect(fixture.result.status).not.toBe(0);
    expect(fs.existsSync(fixture.livePredecessorProof)).toBe(true);
    expect(fs.readFileSync(fixture.checkpointPath)).toEqual(fixture.checkpointBody);
    expect(fs.existsSync(path.join(fixture.checkpointDir, 'terminal-retries'))).toBe(false);
  });

  it.each([
    ['artifact digest', { artifactIdentityDrift: true }],
    ['installed-runtime digest', { installedIdentityDrift: true }],
  ])('fails closed when the live terminal predecessor %s drifts', (_label, drift) => {
    const fixture = runGovernedTerminalRetryFixture({
      outcome: 'failed_before_stop',
      ...drift,
    });

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain('terminal predecessor live');
    expect(fs.existsSync(fixture.livePredecessorProof)).toBe(true);
    expect(fs.readFileSync(fixture.checkpointPath)).toEqual(fixture.checkpointBody);
    expect(fs.existsSync(path.join(fixture.checkpointDir, 'terminal-retries'))).toBe(false);
  });

  it('fails closed without a fresh ID when current drifts after terminal predecessor proof', () => {
    const fixture = runGovernedTerminalRetryFixture({
      outcome: 'recovered',
      recoverySeconds: 120,
      currentRuntimeDrift: true,
    });

    expect(fixture.result.status).toBe(75);
    expect(fixture.result.stderr).toContain(
      'terminal predecessor identity changed before fresh authorization',
    );
    expect(fs.existsSync(fixture.livePredecessorProof)).toBe(true);
    expect(JSON.parse(fs.readFileSync(fixture.checkpointPath, 'utf8')).transactionId)
      .toBe(fixture.oldTransactionId);
  });

  it('wires the dedicated identity, finite bounds, signed client, and strict migration approval', () => {
    const clientSource = fs.readFileSync(promotion, 'utf8');
    const runnerSource = fs.readFileSync(runner, 'utf8');
    const brokerSource = fs.readFileSync(broker, 'utf8');
    const controlSource = fs.readFileSync(control, 'utf8');
    const installSource = fs.readFileSync(installer, 'utf8');
    const attestorSource = fs.readFileSync(trustedAttestor, 'utf8');
    const service = fs.readFileSync(unit, 'utf8');
    const recovery = fs.readFileSync(recoveryUnit, 'utf8');
    const gate = fs.readFileSync(migrationGate, 'utf8');
    const selectorSource = fs.readFileSync(
      path.resolve('scripts/remote-release-selector-switch.py'),
      'utf8',
    );
    const backupSource = fs.readFileSync(
      path.resolve('scripts/remote-create-release-backup.sh'),
      'utf8',
    );
    const applicationDrBackupSource = fs.readFileSync(
      path.resolve('scripts/application-dr-backup.sh'),
      'utf8',
    );
    const applicationDrService = fs.readFileSync(
      path.resolve(
        'ops/application-dr/systemd/nexus-application-dr-backup.service',
      ),
      'utf8',
    );

    expect(clientSource).toContain('nexus-release-promotion-control.v4');
    expect(clientSource).toContain('sign-request');
    expect(clientSource).not.toContain('sign-decision');
    expect(clientSource).not.toContain('awaiting_local_gate');
    expect(clientSource).not.toContain('SYSTEMD_CONTROL" continue');
    expect(clientSource).toContain('transaction result identity does not match');
    expect(clientSource).toContain('NEXUS_INSTALLED_RUNTIME_DIGEST');
    expect(clientSource).toContain('release-installed-tree-attestation.mjs" validate');
    expect(clientSource.match(/remote-release-capacity\.sh/g)).toHaveLength(1);
    expect(brokerSource.match(/remote-release-capacity\.sh/g)).toHaveLength(1);
    expect(brokerSource).toContain('/run/lock/nexus-release-sonar.lock');
    const rollbackEscrowIndex = clientSource.indexOf('rollbackEscrow: {');
    expect(rollbackEscrowIndex).toBeGreaterThan(-1);
    expect(clientSource.slice(rollbackEscrowIndex, rollbackEscrowIndex + 100))
      .toContain("status: 'passed'");
    expect(clientSource).toContain("currentRecoveryEscrow: { status: 'passed'");
    const prepareTarget = clientSource.indexOf('prepare-runtime-target');
    const copyTarget = clientSource.indexOf('rsync -a --delete', prepareTarget);
    const sealTarget = clientSource.indexOf('seal-runtime', copyTarget);
    const candidatePreflight = clientSource.indexOf('remote-release-preflight.sh', sealTarget);
    expect(prepareTarget).toBeGreaterThan(-1);
    expect(copyTarget).toBeGreaterThan(prepareTarget);
    expect(sealTarget).toBeGreaterThan(copyTarget);
    expect(candidatePreflight).toBeGreaterThan(sealTarget);
    expect(clientSource.slice(prepareTarget, copyTarget)).toContain('[ ! -w "$base_dir/releases" ]');
    expect(clientSource).toContain('Tolerate bounded transient transport loss');
    expect(clientSource).not.toContain('retry-escrow "$PROMOTION_RUN_ID"');
    expect(clientSource).toContain('server-owned rollback escrow retries were exhausted');
    expect(clientSource).toContain('x.escrowRetry.exhaustedAt===null?"pending":"exhausted"');
    expect(clientSource).toContain('deadline=$((SECONDS + 2100))');
    expect(clientSource).toContain('ensure_started_interval_seconds=15');
    expect(clientSource).toContain(
      'const unitActivity=x.unitActive===true?"active":x.unitActive===false?"inactive":"unknown"',
    );
    const recoverableReconcileStart = clientSource.indexOf(
      'pending|recovery_required)',
      clientSource.indexOf('deadline=$((SECONDS + 2100))'),
    );
    const recoverableReconcileEnd = clientSource.indexOf(
      '\n        ;;',
      recoverableReconcileStart,
    );
    const recoverableReconcile = clientSource.slice(
      recoverableReconcileStart,
      recoverableReconcileEnd,
    );
    expect(recoverableReconcileStart).toBeGreaterThan(-1);
    expect(recoverableReconcileEnd).toBeGreaterThan(recoverableReconcileStart);
    expect(recoverableReconcile).toContain(
      '[ "$transaction_status" != "$last_reconciled_status" ]',
    );
    expect(recoverableReconcile).toContain(
      '[ "$unit_activity" = inactive ] && [ "$last_unit_activity" != inactive ]',
    );
    expect(recoverableReconcile).toContain(
      '[ "$((SECONDS - last_ensure_started_at))" -ge "$ensure_started_interval_seconds" ]',
    );
    expect(recoverableReconcile.indexOf('if [ "$should_ensure_started" = true ]'))
      .toBeLessThan(recoverableReconcile.indexOf('"$SYSTEMD_CONTROL" ensure-started'));
    const ordinaryRunningStart = clientSource.indexOf(
      '\n      running)',
      recoverableReconcileEnd,
    );
    const ordinaryRunningEnd = clientSource.indexOf(
      '\n        ;;',
      ordinaryRunningStart,
    );
    const ordinaryRunning = clientSource.slice(
      ordinaryRunningStart,
      ordinaryRunningEnd,
    );
    expect(ordinaryRunningStart).toBeGreaterThan(recoverableReconcileEnd);
    expect(ordinaryRunningEnd).toBeGreaterThan(ordinaryRunningStart);
    expect(ordinaryRunning).not.toContain('ensure-started');
    const candidateAvailabilityStart = runnerSource.indexOf(
      'availability_health="$(mktemp)"',
    );
    const candidateAvailabilityEnd = runnerSource.indexOf(
      '[ "$candidate_available" = true ]',
      candidateAvailabilityStart,
    );
    const candidateAvailability = runnerSource.slice(
      candidateAvailabilityStart,
      candidateAvailabilityEnd,
    );
    const identityAvailability = candidateAvailability.indexOf(
      'identity_available=true',
    );
    const localIdentityGuard = candidateAvailability.indexOf(
      'if [ "$local_available" = true ] && [ "$content_available" = true ]',
    );
    const publicAvailability = candidateAvailability.indexOf(
      '"$PUBLIC_BASE_URL/health"',
    );
    expect(candidateAvailabilityStart).toBeGreaterThan(-1);
    expect(candidateAvailabilityEnd).toBeGreaterThan(candidateAvailabilityStart);
    expect(identityAvailability).toBeGreaterThan(-1);
    expect(localIdentityGuard).toBeGreaterThan(identityAvailability);
    expect(publicAvailability).toBeGreaterThan(localIdentityGuard);
    expect(candidateAvailability.slice(localIdentityGuard, publicAvailability))
      .toContain('[ "$identity_available" = true ]');
    const candidateAvailableReport = clientSource.indexOf(
      'Exact candidate is serving customers; final soak and escrow verification continue.',
    );
    const completedTransactionExit = clientSource.indexOf(
      '[ "$transaction_status" = completed ]',
      candidateAvailableReport,
    );
    expect(clientSource).toContain('candidate_available_reported=false');
    expect(clientSource).toContain(
      'candidate_available:running|verifying_candidate:running',
    );
    expect(clientSource).toContain('awaiting_dr_escrow:escrow_pending)');
    expect(clientSource).toContain('completed:completed)');
    expect(clientSource).toContain(
      'stability soak and escrow verification are complete.',
    );
    expect(candidateAvailableReport).toBeGreaterThan(-1);
    expect(completedTransactionExit).toBeGreaterThan(candidateAvailableReport);
    const retryArchiveStart = clientSource.indexOf(
      'retry_archive="$retry_archive_dir/${PROMOTION_RUN_ID}.json"',
    );
    const retryArchiveEnd = clientSource.indexOf(
      'RETRY_TERMINAL_PREDECESSOR=true',
      retryArchiveStart,
    );
    expect(retryArchiveStart).toBeGreaterThan(-1);
    expect(retryArchiveEnd).toBeGreaterThan(retryArchiveStart);
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain("schema:'nexus.terminal-promotion-client-archive.v1'");
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain("fs.openSync(temporary,'wx',0o600)");
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain('fs.fsyncSync(descriptor)');
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain('fs.linkSync(temporary,output)');
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain('fsync_local_directory "$retry_archive_dir"');
    expect(clientSource.slice(retryArchiveStart, retryArchiveEnd))
      .toContain('fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"');
    const checkpointWriterStart = clientSource.indexOf(
      'checkpoint_temporary="$TRANSACTION_CHECKPOINT.',
    );
    const checkpointWriterEnd = clientSource.indexOf(
      '# Copy the already prepared staging runtime',
      checkpointWriterStart,
    );
    expect(checkpointWriterStart).toBeGreaterThan(-1);
    expect(checkpointWriterEnd).toBeGreaterThan(checkpointWriterStart);
    expect(clientSource.slice(checkpointWriterStart, checkpointWriterEnd))
      .toContain("fs.openSync(file,'wx',0o600)");
    expect(clientSource.slice(checkpointWriterStart, checkpointWriterEnd))
      .toContain('fs.fsyncSync(fd)');
    expect(clientSource.slice(checkpointWriterStart, checkpointWriterEnd))
      .toContain('mv "$checkpoint_temporary" "$TRANSACTION_CHECKPOINT"');
    expect(clientSource.slice(checkpointWriterStart, checkpointWriterEnd))
      .toContain('fsync_local_directory "$TRANSACTION_CHECKPOINT_DIR"');
    const requestWriterStart = clientSource.indexOf('if [ ! -f "$request_file" ]; then');
    const requestWriterEnd = clientSource.indexOf(
      '[ -f "$request_file" ] && [ ! -L "$request_file" ]',
      requestWriterStart,
    );
    expect(requestWriterStart).toBeGreaterThan(-1);
    expect(requestWriterEnd).toBeGreaterThan(requestWriterStart);
    expect(clientSource.slice(requestWriterStart, requestWriterEnd))
      .toContain("fs.openSync(temporary,'wx',0o600)");
    expect(clientSource.slice(requestWriterStart, requestWriterEnd))
      .toContain('fs.fsyncSync(descriptor)');
    expect(clientSource.slice(requestWriterStart, requestWriterEnd))
      .toContain('fs.linkSync(temporary,output)');
    expect(clientSource.slice(requestWriterStart, requestWriterEnd))
      .toContain('fs.unlinkSync(temporary)');
    expect(clientSource.slice(requestWriterStart, requestWriterEnd))
      .toContain('fsync_local_directory "$request_dir"');
    const requestSigningStart = clientSource.indexOf(
      'promotion-authorization.mjs" sign-request',
    );
    expect(requestSigningStart).toBeGreaterThan(-1);
    expect(clientSource.slice(requestSigningStart, requestSigningStart + 500))
      .toContain('fsync_local_directory "$request_dir"');
    const armIndex = runnerSource.indexOf(
      'durable_worker_marker "$RECOVERY_ARMED_MARKER"',
    );
    const stopIndex = runnerSource.indexOf('\n  stop_predecessor\n', armIndex);
    const backupPublishIndex = runnerSource.indexOf(
      'durable_publish_worker_file "$backup_temporary" "$BACKUP_ENV"',
      stopIndex,
    );
    const candidateMarkerIndex = runnerSource.indexOf(
      'durable_worker_marker "$CANDIDATE_MARKER"',
      backupPublishIndex,
    );
    const selectorMutationIndex = runnerSource.indexOf(
      'atomic_switch_current "$RELEASE_DIR"',
      candidateMarkerIndex,
    );
    expect(armIndex).toBeGreaterThan(-1);
    expect(armIndex).toBeLessThan(stopIndex);
    expect(backupPublishIndex).toBeGreaterThan(stopIndex);
    expect(candidateMarkerIndex).toBeGreaterThan(backupPublishIndex);
    expect(selectorMutationIndex).toBeGreaterThan(candidateMarkerIndex);
    const candidateStart = runnerSource.indexOf(
      '"$PM2_BIN" start "$RELEASE_DIR/ecosystem.release.config.js"',
      selectorMutationIndex,
    );
    const candidateWindow = runnerSource.slice(candidateMarkerIndex, candidateStart);
    expect(candidateStart).toBeGreaterThan(selectorMutationIndex);
    expect(candidateWindow).toContain('"$TIMEOUT_BIN" 5s "$PM2_BIN" describe "$app"');
    expect(candidateWindow).toContain('"$TIMEOUT_BIN" 10s "$PM2_BIN" delete "$app"');
    expect(candidateWindow.lastIndexOf('PHASE_TIMEOUT_SECONDS="$(pre_recovery_remaining)"'))
      .toBeGreaterThan(candidateWindow.indexOf('"$TIMEOUT_BIN" 10s "$PM2_BIN" delete "$app"'));
    const rootCandidateProofStart = brokerSource.indexOf('verify_candidate_live() {');
    const rootCandidateProofEnd = brokerSource.indexOf(
      '\n}\n\nprune_local_backups_as_application_user()',
      rootCandidateProofStart,
    );
    expect(brokerSource.slice(rootCandidateProofStart, rootCandidateProofEnd))
      .toContain('verify_exact_pm2_stable "$TARGET_RUNTIME" "$TARGET_SHA"');
    const pm2CaptureStart = brokerSource.indexOf('capture_pm2_jlist() {');
    const exactPm2ProofStart = brokerSource.indexOf('verify_exact_pm2_stable() {');
    const exactPm2ProofEnd = brokerSource.indexOf(
      '\n}\n\nverify_root_selector()',
      exactPm2ProofStart,
    );
    const pm2Capture = brokerSource.slice(pm2CaptureStart, exactPm2ProofStart);
    const exactPm2Proof = brokerSource.slice(exactPm2ProofStart, exactPm2ProofEnd);
    expect(pm2Capture)
      .toContain('"$TIMEOUT_BIN" "${timeout_seconds}s" "$PM2_BIN" jlist');
    expect(pm2Capture)
      .toContain(
        '"$TIMEOUT_BIN" "${timeout_seconds}s" "$RUNUSER_BIN" -u "$WORKER_USER" -- "$PM2_BIN" jlist',
      );
    expect(exactPm2Proof)
      .toContain("['nexus-hub',runtime,`${runtime}/dist/index.js`,'node']");
    expect(exactPm2Proof)
      .toContain("['content-engine',`${runtime}/content-engine`,");
    expect(exactPm2Proof)
      .toContain("`${runtime}/content-engine/.venv/bin/python3.12`,'none']");
    expect(exactPm2Proof)
      .toContain('env.pm_exec_path!==executable||env.exec_interpreter!==interpreter');
    expect(exactPm2Proof)
      .toContain("||(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha||env.SENTRY_RELEASE!==sha");
    expect(exactPm2Proof).toContain('remaining_before_deadline "$deadline"');
    expect(brokerSource).toContain(
      'escrow_exact_backup "$backup_file" "$backup_sha" \\\n'
      + '        "$ESCROW_RETRY_DEADLINE_MONOTONIC_SECONDS"',
    );
    expect(brokerSource)
      .toContain('timeout_seconds="$(remaining_before_deadline "$deadline" 300)"');
    expect(clientSource).not.toContain('nexus-release-promotion-control.v3');
    expect(controlSource).not.toContain('VERSION="nexus-release-promotion-control.v3"');
    const selectorWriterStart = runnerSource.indexOf('atomic_switch_current() {');
    const selectorWriterEnd = runnerSource.indexOf(
      '\n}\n\nstart_predecessor()',
      selectorWriterStart,
    );
    const selectorWriter = runnerSource.slice(selectorWriterStart, selectorWriterEnd);
    expect(selectorWriter)
      .toContain('"$PYTHON_BIN" "$SELECTOR_SWITCH" switch');
    expect(selectorWriter)
      .toContain('--role production --release-root "$(dirname -- "$PROD_BASE")"');
    expect(selectorWriter)
      .toContain('--expected "$expected" --target "$target" --allow-test-owner');
    expect(selectorSource).toContain('base_fd = os.open(base, open_flags)');
    expect(selectorSource).toContain('dst_dir_fd=base_fd');
    const pm2SaveStart = runnerSource.indexOf('pm2_save_durable() {');
    const pm2SaveEnd = runnerSource.indexOf(
      '\n}\n\nverify_candidate_readiness_snapshot()',
      pm2SaveStart,
    );
    expect(runnerSource.slice(pm2SaveStart, pm2SaveEnd))
      .toContain("descriptor = fs.openSync(dump, 'r')");
    expect(runnerSource.slice(pm2SaveStart, pm2SaveEnd))
      .toContain("descriptor = fs.openSync(directory, 'r')");
    expect(runnerSource)
      .toContain("for(const name of ['bot.db','bot.db-wal','bot.db-shm'])");
    expect(backupSource).toContain('fs.renameSync(temporary, archive)');
    expect(backupSource).toContain("descriptor = fs.openSync(archive, 'r')");
    expect(backupSource).toContain("descriptor = fs.openSync(backupDirectory, 'r')");
    expect(runnerSource).not.toContain('sleep "$STABILITY_SECONDS"');
    expect(runnerSource).not.toContain('soak_predecessor_identity');
    expect(runnerSource.match(/--stability-seconds "\$STABILITY_SECONDS"/gu)).toHaveLength(1);
    expect(runnerSource).toContain('signed_migration_identities_automatically_verified');
    expect(runnerSource).not.toContain('continue.envelope.json');
    expect(backupSource).not.toContain('tail -n +11');
    expect(brokerSource).toContain('OUTAGE_BUDGET_SECONDS=120');
    expect(brokerSource).toContain('PRE_RECOVERY_BUDGET_SECONDS=60');
    expect(brokerSource).toContain('NEXUS_PROMOTION_OUTAGE_DEADLINE_MONOTONIC');
    expect(brokerSource).toContain('"${timeout_seconds}s"');
    expect(brokerSource).toContain('/run/lock/nexus-release-sonar.lock');
    expect(brokerSource).toContain('exec 8<>"$RELEASE_SONAR_LOCK"');
    expect(brokerSource).not.toContain('exec 8>"$RELEASE_SONAR_LOCK"');
    expect(brokerSource).toContain('AUTHORITATIVE_DIR="$TRANSACTION_DIR/state"');
    expect(brokerSource).toContain(
      'PREDECESSOR_INSTALLED_RUNTIME_DIGEST TARGET_RUNTIME TARGET_SHA TARGET_VERSION',
    );
    expect(brokerSource).toContain('canonical(envelope?.payload)!==requestCanonical');
    expect(brokerSource)
      .toContain("crypto.createHash('sha256').update(requestCanonical).digest('hex')");
    const drPreflightIndex = brokerSource.indexOf('if ! preflight_application_dr; then');
    const recoveryIntentArmIndex = brokerSource.lastIndexOf(
      '\nwrite_recovery_intent_pre_candidate\n',
    );
    expect(drPreflightIndex).toBeGreaterThan(-1);
    expect(recoveryIntentArmIndex).toBeGreaterThan(-1);
    expect(drPreflightIndex).toBeLessThan(recoveryIntentArmIndex);
    const timingWriterStart = brokerSource.indexOf('write_cutover_timing() {');
    const timingWriterEnd = brokerSource.indexOf('\n}\n\nread_cutover_timing()', timingWriterStart);
    expect(timingWriterStart).toBeGreaterThan(-1);
    expect(timingWriterEnd).toBeGreaterThan(timingWriterStart);
    expect(brokerSource.slice(timingWriterStart, timingWriterEnd))
      .toContain('output="$(durable_staging_file "$CUTOVER_TIMING")"');
    expect(brokerSource.slice(timingWriterStart, timingWriterEnd))
      .toContain('durable_publish "$output" "$CUTOVER_TIMING"');
    expect(brokerSource.lastIndexOf('\nwrite_cutover_timing\n'))
      .toBeLessThan(recoveryIntentArmIndex);
    const activePublishIndex = controlSource.indexOf(
      'write_active "$transaction_id" "$request_sha" "$envelope_sha"',
    );
    const promotionStartIndex = controlSource.indexOf(
      '"$SYSTEMCTL_BIN" start --no-block "$(unit_name "$transaction_id")"',
      activePublishIndex,
    );
    const drLeaseWaitIndex = brokerSource.lastIndexOf(
      '\nif ! wait_for_dr_backup_lease; then\n',
    );
    const runtimePreparationIndex = brokerSource.lastIndexOf(
      '\nif ! prepare_exact_runtimes; then\n',
    );
    const cutoverTimingIndex = brokerSource.lastIndexOf(
      '\nwrite_cutover_timing\n',
    );
    expect(activePublishIndex).toBeGreaterThan(-1);
    expect(promotionStartIndex).toBeGreaterThan(activePublishIndex);
    expect(drLeaseWaitIndex).toBeGreaterThan(-1);
    expect(drLeaseWaitIndex).toBeLessThan(drPreflightIndex);
    expect(drLeaseWaitIndex).toBeLessThan(runtimePreparationIndex);
    expect(drLeaseWaitIndex).toBeLessThan(cutoverTimingIndex);
    expect(brokerSource).toContain('DR_LEASE_WAIT_SECONDS=120');
    expect(brokerSource).toContain('DR_LEASE_POLL_SECONDS=2');
    expect(brokerSource).toContain('DR_LEASE_MAX_PROBES=61');
    expect(brokerSource).toContain('exec 7<>"$DR_BACKUP_LOCK"');
    expect(brokerSource).toContain('"$DR_LEASE_FLOCK_BIN" -n -E 75 -x 7');
    expect(brokerSource).toContain(
      '"$DR_SYSTEMCTL_BIN" is-active "$DR_BACKUP_SERVICE"',
    );
    expect(brokerSource).toContain(
      'write_journal waiting_for_dr_lease running dr_backup_admission_wait_started',
    );
    expect(controlSource).toContain(
      '[ "$transaction_phase" != waiting_for_dr_lease ]',
    );
    expect(applicationDrService).toContain(
      'ConditionPathExists=!/var/lib/nexus-release-promotion/active.json',
    );
    expect(brokerSource).toContain('"$DR_BACKUP_BIN" --config "$DR_CONFIG" --verify-config');
    expect(applicationDrBackupSource).toContain(
      'lifecyclePhase=$lifecycle_phase bootstrapReceipt=$bootstrap_receipt_state',
    );
    expect(brokerSource).not.toContain('--bootstrap-first-backup');
    expect(brokerSource.match(/--recovery-escrow-id "\$TRANSACTION_ID"/gu)).toHaveLength(2);
    expect(brokerSource.match(/--recovery-descriptor "\$RECOVERY_DESCRIPTOR"/gu)).toHaveLength(2);
    expect(brokerSource.match(/--recovery-escrow-phase pre-mutation/gu)).toHaveLength(1);
    expect(brokerSource.match(/--recovery-escrow-phase post-soak/gu)).toHaveLength(1);
    expect(brokerSource).toContain("'nexus.pre-mutation-current-recovery-escrow.v2'");
    expect(brokerSource).toContain("c?.escrowPhase!=='post-soak'");
    expect(brokerSource).toContain("preCurrent?.escrowPhase!=='pre-mutation'");
    expect(brokerSource).toContain('encryptedSha256:dr.databaseEncryptedSha256');
    expect(brokerSource).toContain('encryptedSizeBytes:dr.databaseEncryptedSizeBytes');
    expect(brokerSource).toContain('preMutationDatabaseRecoveryPoint:preflight.databaseRecoveryPoint');
    expect(brokerSource).toContain('currentDatabaseRecoveryPoint:{objectKey:dr.databaseKey');
    expect(brokerSource).toContain('promotionTimeline:{cutoverStartedAt:result.get');
    expect(brokerSource).toContain('candidateReadinessRefresh:{');
    expect(brokerSource).toContain('beforeEscrow:beforeReadiness');
    expect(brokerSource).toContain('afterEscrow:afterReadiness');
    expect(brokerSource).toContain('invoke_worker worker-verify-candidate');
    expect(brokerSource).toContain('nexus.candidate-readiness-refresh.v1');
    expect(brokerSource).toContain('beforeReadinessVerified<soakCompleted');
    expect(brokerSource).toContain('currentDatabaseConfirmed<beforeReadinessVerified');
    expect(brokerSource).toContain('afterReadinessVerified<currentDatabaseConfirmed');
    expect(brokerSource).toContain('write_journal awaiting_dr_escrow escrow_pending');
    expect(brokerSource).toContain('recover_and_record post_availability_detection');
    expect(brokerSource).toContain('nexus.promotion-recovery-attempt-timing.v1');
    expect(brokerSource).toContain('candidate_degraded_during_escrow');
    expect(brokerSource).toContain('ESCROW_MAX_ATTEMPTS=8');
    expect(brokerSource).toContain('ESCROW_RETRY_BUDGET_SECONDS=1200');
    expect(brokerSource).toContain(
      'while [ "$ESCROW_RETRY_ATTEMPT" -lt "$ESCROW_MAX_ATTEMPTS" ]; do',
    );
    expect(brokerSource).toContain(
      'if ! verify_candidate_live "$ESCROW_RETRY_DEADLINE_MONOTONIC_SECONDS" \\\n'
      + '        || ! refresh_candidate_readiness "$ESCROW_RETRY_DEADLINE_MONOTONIC_SECONDS"; then',
    );
    expect(brokerSource).toContain('"$SLEEP_BIN" "$remaining"');
    expect(brokerSource).toContain('return 75');
    expect(brokerSource).toContain('rollback_escrow_retry_exhausted');
    expect(brokerSource).toContain('phaseTiming:{');
    expect(brokerSource).toContain('invocation:{');
    expect(brokerSource).toContain('escrowRetry:{');
    expect(brokerSource).toContain('nextAttemptAt:nullableString(retryNextAt)');
    expect(brokerSource).toContain('errorClass:nullableString(retryErrorClass)');
    expect(brokerSource).toContain('bootId:retryBootId');
    const workerPrepareIndex = brokerSource.lastIndexOf('invoke_worker worker-prepare');
    const rootAuthorizeIndex = brokerSource.indexOf(
      'authorize_candidate_from_worker_backup',
      workerPrepareIndex,
    );
    const workerPromoteIndex = brokerSource.indexOf(
      'invoke_worker worker-promote',
      rootAuthorizeIndex,
    );
    expect(workerPrepareIndex).toBeGreaterThan(recoveryIntentArmIndex);
    expect(rootAuthorizeIndex).toBeGreaterThan(workerPrepareIndex);
    expect(workerPromoteIndex).toBeGreaterThan(rootAuthorizeIndex);
    expect(brokerSource).toContain("'nexus.promotion-root-recovery-intent.v2'");
    const invokeRecoveryIndex = brokerSource.indexOf('invoke_recovery() {');
    const attestBeforeBudgetIndex = brokerSource.indexOf(
      'trusted_attest verify "$PREDECESSOR_RUNTIME"',
      invokeRecoveryIndex,
    );
    const refreshedBudgetIndex = brokerSource.indexOf(
      'current_mono="$(monotonic_seconds)"',
      attestBeforeBudgetIndex,
    );
    expect(attestBeforeBudgetIndex).toBeGreaterThan(invokeRecoveryIndex);
    expect(refreshedBudgetIndex).toBeGreaterThan(attestBeforeBudgetIndex);
    const recoveryRecordIndex = brokerSource.indexOf('recover_and_record() {');
    const verifyRecoveredIndex = brokerSource.indexOf(
      'verify_predecessor_live || return 1',
      recoveryRecordIndex,
    );
    const sealRecoveredIndex = brokerSource.indexOf(
      'seal_recovery_result',
      verifyRecoveredIndex,
    );
    expect(verifyRecoveredIndex).toBeGreaterThan(recoveryRecordIndex);
    expect(sealRecoveredIndex).toBeGreaterThan(verifyRecoveredIndex);
    const restartRecoveryIndex = brokerSource.indexOf(
      'if [ -f "$RECOVERY_INTENT" ] \\\n'
      + '    || { [ "$existing_status" = running ] '
      + '&& [ "$resume_dr_lease" != true ]; }',
    );
    expect(restartRecoveryIndex).toBeGreaterThan(-1);
    expect(restartRecoveryIndex).toBeLessThan(drPreflightIndex);
    const descriptorResumeIndex = brokerSource.indexOf(
      'if [ -e "$RECOVERY_DESCRIPTOR" ] || [ -L "$RECOVERY_DESCRIPTOR" ]; then',
    );
    const descriptorRebuildIndex = brokerSource.indexOf(
      'prepare_recovery_descriptor_unprivileged',
      descriptorResumeIndex,
    );
    const firstRuntimeSealIndex = brokerSource.indexOf(
      'trusted_attest seal "$PREDECESSOR_RUNTIME"',
      descriptorRebuildIndex,
    );
    expect(descriptorResumeIndex).toBeGreaterThan(-1);
    expect(descriptorRebuildIndex).toBeGreaterThan(descriptorResumeIndex);
    expect(firstRuntimeSealIndex).toBeGreaterThan(descriptorRebuildIndex);
    expect(brokerSource.slice(descriptorResumeIndex, descriptorRebuildIndex))
      .toContain('root:root:600:1');
    expect(brokerSource.slice(descriptorResumeIndex, descriptorRebuildIndex))
      .toContain('durable_remove "$RECOVERY_DESCRIPTOR"');
    const finishEscrowStart = brokerSource.indexOf('finish_escrow() {');
    const completedTransition = brokerSource.indexOf(
      'write_journal completed completed exact_candidate_and_recovery_runtime_escrowed',
      finishEscrowStart,
    );
    const finalIntentDisarm = brokerSource.indexOf(
      'durable_remove "$RECOVERY_INTENT"',
      completedTransition,
    );
    expect(completedTransition).toBeGreaterThan(finishEscrowStart);
    expect(finalIntentDisarm).toBeGreaterThan(completedTransition);
    expect(recoveryIntentArmIndex).toBeLessThan(workerPrepareIndex);
    expect(brokerSource.indexOf('verify_candidate_live')).toBeLessThan(brokerSource.indexOf('escrow_exact_backup'));
    expect(brokerSource).toContain('candidate_available_before_network_escrow');
    expect(brokerSource).toContain('explicit_recovery_from_escrow_pending');
    expect(brokerSource).toContain('if [ "$ACTION" = recover ] || [ -f "$CONTROL_DIR/recover" ]');
    expect(brokerSource).toContain('"$RUNUSER_BIN" -u "$WORKER_USER" -- "$SYSTEM_NODE_BIN" -e "$script" "$BACKUP_DIR"');
    expect(runnerSource).toContain('exact rollback backup size changed');
    expect(runnerSource).toContain('exact rollback backup digest changed');
    expect(runnerSource).toContain('rollback database digest does not match stopped-state evidence');
    expect(runnerSource).toContain('unsupported rollback archive entry');
    expect(attestorSource).toContain('installed dependency symlink escapes the runtime');
    expect(attestorSource).toContain('compareCodeUnits');
    expect(attestorSource).not.toContain('localeCompare');
    expect(attestorSource).not.toContain('execFileSync');
    expect(attestorSource).toContain("lock.target?.node !== process.version");
    expect(attestorSource).toContain("lock.target?.python ?? ''");
    expect(attestorSource).toContain('assertSealedPermissions');
    expect(attestorSource).toContain('fs.chmodSync(base, 0o1770)');
    expect(attestorSource).toContain("fs.chmodSync(path.join(base, 'releases'), 0o750)");
    expect(fs.readFileSync(control, 'utf8')).toContain('prepare-runtime-target)');
    expect(controlSource).toContain('VERSION="nexus-release-promotion-control.v4"');
    expect(controlSource).toContain('prepare-staging-runtime-target)');
    expect(controlSource).toContain('seal-staging-runtime)');
    expect(controlSource).toContain('verify-staging-runtime)');
    expect(controlSource).toContain("staging_binding_path()");
    expect(controlSource).toContain("staging_recovery_path()");
    expect(controlSource).toContain('nexus.trusted-staging-runtime-binding.v1');
    expect(controlSource).toContain('"$TRUSTED_ATTESTOR" seal');
    expect(controlSource).toContain('"$TRUSTED_ATTESTOR" verify');
    expect(controlSource).toContain('"$RECOVERY_ATTESTOR" compute');
    expect(fs.readFileSync(control, 'utf8')).toContain('chown root:"$worker_group" "$base" "$base/releases"');
    expect(fs.readFileSync(path.resolve('scripts/release-operator.sh'), 'utf8')).toContain('release_acquire_remote_sonar_lock "$SERVER"');
    const releaseOperator = fs.readFileSync(path.resolve('scripts/release-operator.sh'), 'utf8');
    expect(releaseOperator).toContain('nexus-release-promotion-control.v4');
    expect(releaseOperator).not.toContain('nexus-release-promotion-control.v3');
    expect(installSource)
      .toContain('"controlVersion":"nexus-release-promotion-control.v4"');
    expect(releaseOperator).toContain('release-runtime-dependencies.mjs install');
    expect(releaseOperator).not.toContain('/usr/bin/npm ci');
    expect(releaseOperator).not.toContain('pip install');
    expect(installSource).toContain('--shell /usr/sbin/nologin');
    expect(installSource).toContain('root root 700');
    expect(installSource).toContain('nexus-release-sonar-lock.conf');
    expect(installSource).toContain(
      'materialize_release_sonar_mutex',
    );
    expect(installSource).toContain(
      '= "0:$expected_gid:660:1"',
    );
    expect(installSource).toContain('nexus-release-promotion-control retry-escrow *');
    expect(installSource).toContain('nexus-release-promotion-control prepare-staging-runtime-target *');
    expect(installSource).toContain('nexus-release-promotion-control seal-staging-runtime *');
    expect(installSource).toContain('nexus-release-promotion-control verify-staging-runtime *');
    expect(installSource).toContain('/var/lib/nexus-release-promotion/staging');
    expect(installSource).toContain(
      'release-recovery-runtime-identity.mjs)" = root:root:644',
    );
    const bootstrapJournal = installSource.indexOf(
      'nexus.release-promotion-bootstrap-journal.v1',
    );
    const guardedBroker = installSource.indexOf(
      '/usr/local/sbin/nexus-release-promotion-control root root 755',
      bootstrapJournal,
    );
    const drInstall = installSource.indexOf(
      '"$SOURCE_ROOT/scripts/application-dr-systemd-install.sh" "$SOURCE_ROOT"',
      guardedBroker,
    );
    const sudoersRestore = installSource.lastIndexOf(
      'install_file_atomically "$sudoers_tmp" "$SUDOERS_TARGET" root root 440',
    );
    const journalDisarm = installSource.lastIndexOf(
      'durable_remove "$BOOTSTRAP_JOURNAL"',
    );
    const pm2PrerequisiteDefinition = installSource.indexOf(
      'verify_exact_root_pm2_prerequisite() {',
    );
    const pm2PrerequisiteBeforeJournal = installSource.indexOf(
      '\nverify_exact_root_pm2_prerequisite\n',
      pm2PrerequisiteDefinition,
    );
    const pm2UnitRewire = installSource.indexOf(
      'pm2_dropin=/etc/systemd/system/pm2-dominguez.service.d',
    );
    const pm2PrerequisiteBeforeDisarm = installSource.lastIndexOf(
      '\nverify_exact_root_pm2_prerequisite\n',
    );
    expect(bootstrapJournal).toBeGreaterThan(-1);
    expect(pm2PrerequisiteDefinition).toBeGreaterThan(-1);
    expect(pm2PrerequisiteBeforeJournal).toBeGreaterThan(pm2PrerequisiteDefinition);
    expect(pm2PrerequisiteBeforeJournal).toBeLessThan(bootstrapJournal);
    expect(pm2UnitRewire).toBeGreaterThan(bootstrapJournal);
    expect(pm2PrerequisiteBeforeJournal).toBeLessThan(pm2UnitRewire);
    expect(guardedBroker).toBeGreaterThan(bootstrapJournal);
    expect(drInstall).toBeGreaterThan(guardedBroker);
    expect(sudoersRestore).toBeGreaterThan(drInstall);
    expect(pm2PrerequisiteBeforeDisarm).toBeGreaterThan(pm2UnitRewire);
    expect(pm2PrerequisiteBeforeDisarm).toBeLessThan(journalDisarm);
    expect(journalDisarm).toBeGreaterThan(sudoersRestore);
    expect(installSource).toContain(
      'ROOT_PM2_CLOSURE="/opt/nexus-release/pm2/$ROOT_PM2_VERSION"',
    );
    expect(installSource).toContain(
      'the separately installed root PM2 lock is not the exact reviewed source lock',
    );
    expect(installSource).toContain(
      "record.schema!=='nexus.pm2-root-install.v1'||record.version!==expectedVersion",
    );
    expect(installSource).toContain(
      "manifest.schema!=='nexus.pm2-root-closure-manifest.v1'",
    );
    expect(installSource).toContain(
      "schema:'nexus.pm2-root-closure.v1',files",
    );
    expect(installSource).toContain(
      "schema:'nexus.pm2-root-closure-payload.v1',files:payloadFiles",
    );
    expect(installSource).toContain('fsync_path "$temporary"');
    expect(installSource).toContain('mv -fT -- "$temporary" "$target"');
    expect(controlSource).toContain(
      'promotion control-plane installation is incomplete; rerun the reviewed bootstrap',
    );
    expect(installSource).toContain('validate_root_trusted_path "$SOURCE_ROOT"');
    expect(installSource).toContain('scripts/application-dr-systemd-install.sh');
    expect(installSource).toContain(
      '"$SOURCE_ROOT/scripts/application-dr-systemd-install.sh" "$SOURCE_ROOT"',
    );
    expect(installSource).toContain(
      'configurationWritten,drillUser,healthTimerEnabled,installedAssets,ok,receipt,schema,timerEnabled',
    );
    expect(installSource).toContain(
      'value.schema!=="nexus.application-dr-install.v2"',
    );
    expect(installSource).toContain(
      'value.healthTimerEnabled!==value.timerEnabled',
    );
    expect(installSource).toContain(
      'value.receipt!=="/var/lib/nexus-application-dr/install-receipt.v2.json"',
    );
    expect(installSource).toContain(
      'APPLICATION_DR_INSTALL_RECEIPT=/var/lib/nexus-application-dr/install-receipt.v2.json',
    );
    expect(installSource).toContain(
      "receipt.schema!=='nexus.application-dr-install.v2'",
    );
    expect(installSource).toContain(
      "receipt.installedAssets!==result.installedAssets",
    );
    expect(installSource.indexOf(
      '"$SOURCE_ROOT/scripts/application-dr-systemd-install.sh" "$SOURCE_ROOT"',
    )).toBeLessThan(installSource.indexOf(
      '"$SOURCE_ROOT/scripts/remote-promotion-worker-control.sh"',
    ));
    expect(installSource).toContain(
      'validate_root_trusted_path "$OWNER_PUBLIC_KEY_SOURCE"',
    );
    expect(installSource).toContain(
      '"$SOURCE_ROOT/$required" \\\n    "promotion bootstrap source ($required)"',
    );
    expect(installSource).toContain('path component is not root-owned');
    expect(installSource).toContain('path component is group/world writable');
    expect(installSource).toContain(
      'promotion service UID must be nonzero and unambiguous',
    );
    expect(installSource).toContain(
      'promotion service identity must use the exact primary service group',
    );
    expect(installSource).toContain(
      'promotion service identity home must be /nonexistent',
    );
    expect(installSource).toContain(
      'promotion service identity must use nologin',
    );
    expect(installSource).toContain(
      'promotion service identity must not belong to supplementary groups',
    );
    expect(installSource).toContain('promotion service group is shared by');
    expect(installSource).not.toContain('promotion-control continue');
    expect(installSource).not.toContain('promotion-control escrow-inflight');
    expect(service).toContain('User=nexus-release');
    expect(service).toContain('TimeoutStartSec=28min');
    expect(service).toContain(
      'ConditionPathExists=!/var/lib/nexus-release-promotion/bootstrap-in-progress.v1',
    );
    expect(service).toContain('RestartPreventExitStatus=75 76');
    expect(service).not.toContain('network-online.target');
    expect(recovery).toContain(
      'Before=network.target network-online.target multi-user.target pm2-dominguez.service',
    );
    expect(recovery).not.toContain('pm2-root.service');
    expect(recovery).toContain('TimeoutStartSec=300s');
    expect(recovery).toContain(
      'ConditionPathExists=!/var/lib/nexus-release-promotion/bootstrap-in-progress.v1',
    );
    expect(installSource).toContain('systemctl mask pm2-root.service');
    expect(installSource).toContain(
      'pm2-root.service.${pm2_root_fragment_sha256}.retired',
    );
    expect(installSource).toContain(
      'install_file_atomically \\\n          "$pm2_root_fragment" "$pm2_root_retired" root root 600',
    );
    expect(installSource.indexOf(
      'install_file_atomically \\\n          "$pm2_root_fragment" "$pm2_root_retired" root root 600',
    )).toBeLessThan(installSource.indexOf(
      'systemctl mask pm2-root.service',
    ));
    expect(installSource).toContain('Environment=\nEnvironmentFile=\nPassEnvironment=');
    expect(installSource).toContain(
      'ExecCondition=\n'
      + 'ExecCondition=+/usr/local/sbin/nexus-release-layout-activation-control assert-boot-safe\n'
      + 'ExecStartPre=\nExecStart=',
    );
    expect(installSource).toContain(
      'ExecStartPost=\nExecStartPost=+/usr/local/sbin/nexus-release-promotion-control boot-postcheck',
    );
    expect(installSource).toContain('ExecStopPost=\nEOF');
    expect(installSource).toContain(
      'verify_effective_pm2_application_unit \\\n  "$pm2_dropin/nexus-release-recovery.conf"',
    );
    expect(installSource).toContain(
      'properties["DropInPaths"] != expected_dropin',
    );
    expect(installSource).toContain(
      'local expected_fragment=/etc/systemd/system/pm2-dominguez.service',
    );
    expect(installSource).toContain(
      'fragment is not the exact reviewed local unit',
    );
    expect(installSource).toContain(
      'properties["ExecStartPre"] != ""',
    );
    expect(installSource).toContain(
      'properties["EnvironmentFiles"] != ""',
    );
    expect(installSource).toContain(
      'require_one_exec("ExecStart", "/usr/local/bin/pm2", "/usr/local/bin/pm2 resurrect")',
    );
    expect(installSource).toContain(
      'require_one_exec(\n    "ExecStartPost",',
    );
    expect(installSource).toContain(
      'pm2-dominguez must be the one enabled PM2 boot authority',
    );
    expect(installSource).toContain(
      'Requires=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service',
    );
    expect(installSource).toContain(
      'After=nexus-release-layout-recovery.service nexus-release-promotion-recovery.service',
    );
    expect(gate).toContain("'--approval-mode', 'promotion'");
  });
});
describe('release layout authorization key handling', () => {
  const roots: string[] = [];
  const digest = (value: Buffer | string) =>
    createHash('sha256').update(value).digest('hex');

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  function writeJson(file: string, value: unknown) {
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    fs.writeFileSync(file, body, { mode: 0o600 });
    return body;
  }

  function runLayoutAuthorization(args: string[]) {
    return spawnSync(process.execPath, [layoutAuthorization, ...args], {
      encoding: 'utf8',
    });
  }

  function createLayoutAuthorityFixture() {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-layout-authority-')),
    );
    roots.push(root);
    const pair = generateKeyPairSync('ed25519');
    const privateKey = path.join(root, 'owner-private.pem');
    const publicKey = path.join(root, 'owner-public.pem');
    fs.writeFileSync(
      privateKey,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      publicKey,
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o600 },
    );
    const migrationId = 'abcdef12-3456-4789-8abc-def012345678';
    const source = {
      production: {
        base: '/home/dominguez/telegram-hub-bot',
        runtimeSha: 'a'.repeat(40),
        artifactDigest: 'b'.repeat(64),
        installedRuntimeDigest: 'c'.repeat(64),
      },
      staging: {
        base: '/home/dominguez/telegram-hub-bot-staging',
        runtimeSha: 'd'.repeat(40),
        artifactDigest: 'e'.repeat(64),
        installedRuntimeDigest: 'f'.repeat(64),
      },
    };
    const now = Date.now();
    const drillInput = path.join(root, 'drill.json');
    writeJson(
      drillInput,
      layoutDrillPayloadFixture(source, migrationId, now).payload,
    );
    const drillEnvelope = path.join(root, 'drill.envelope.json');
    const drillSigned = runLayoutAuthorization([
      'sign-drill',
      '--input',
      drillInput,
      '--private-key',
      privateKey,
      '--output',
      drillEnvelope,
    ]);
    expect(drillSigned.status, drillSigned.stderr).toBe(0);
    const requestInput = path.join(root, 'request.json');
    writeJson(requestInput, {
      schema: 'nexus.release-layout-migration-request.v1',
      migrationId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      ownerAuthorization: 'explicit',
      source,
      destination: {
        releaseRoot: '/srv/nexus-release',
        production: '/srv/nexus-release/production',
        staging: '/srv/nexus-release/staging',
      },
      pm2AttestationSha256: '9'.repeat(64),
      faultDrillEnvelopeSha256: digest(fs.readFileSync(drillEnvelope)),
    });
    const requestEnvelope = path.join(root, 'request.envelope.json');
    const requestSigned = runLayoutAuthorization([
      'sign-request',
      '--input',
      requestInput,
      '--private-key',
      privateKey,
      '--output',
      requestEnvelope,
    ]);
    expect(requestSigned.status, requestSigned.stderr).toBe(0);
    return {
      drillEnvelope,
      drillInput,
      privateKey,
      publicKey,
      requestEnvelope,
      requestInput,
      root,
    };
  }

  it('signs and verifies exact layout authority with real Ed25519 PEM keys', () => {
    const fixture = createLayoutAuthorityFixture();
    const verified = runLayoutAuthorization([
      'verify',
      '--request-envelope',
      fixture.requestEnvelope,
      '--fault-drill-envelope',
      fixture.drillEnvelope,
      '--public-key',
      fixture.publicKey,
    ]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      ok: true,
      schema: 'nexus.release-layout-authority-verification.v1',
    });

    const tampered = JSON.parse(
      fs.readFileSync(fixture.requestEnvelope, 'utf8'),
    );
    tampered.payload.destination.production = '/home/dominguez/telegram-hub-bot';
    fs.writeFileSync(
      fixture.requestEnvelope,
      `${JSON.stringify(tampered, null, 2)}\n`,
      { mode: 0o600 },
    );
    expect(runLayoutAuthorization([
      'verify',
      '--request-envelope',
      fixture.requestEnvelope,
      '--fault-drill-envelope',
      fixture.drillEnvelope,
      '--public-key',
      fixture.publicKey,
    ]).status).not.toBe(0);
  });

  it('rejects symlinked private and public key inputs', () => {
    const fixture = createLayoutAuthorityFixture();
    const privateLink = path.join(fixture.root, 'private-link.pem');
    const publicLink = path.join(fixture.root, 'public-link.pem');
    fs.symlinkSync(fixture.privateKey, privateLink);
    fs.symlinkSync(fixture.publicKey, publicLink);
    const output = path.join(fixture.root, 'symlinked-key-output.json');
    expect(runLayoutAuthorization([
      'sign-drill',
      '--input',
      fixture.drillInput,
      '--private-key',
      privateLink,
      '--output',
      output,
    ]).status).not.toBe(0);
    expect(fs.existsSync(output)).toBe(false);
    expect(runLayoutAuthorization([
      'verify',
      '--request-envelope',
      fixture.requestEnvelope,
      '--fault-drill-envelope',
      fixture.drillEnvelope,
      '--public-key',
      publicLink,
    ]).status).not.toBe(0);
  });

  it('rejects oversized private and public key inputs before parsing', () => {
    const fixture = createLayoutAuthorityFixture();
    const oversized = path.join(fixture.root, 'oversized.pem');
    fs.writeFileSync(oversized, Buffer.alloc(32 * 1024 + 1, 0x61), {
      mode: 0o600,
    });
    const output = path.join(fixture.root, 'oversized-key-output.json');
    const privateResult = runLayoutAuthorization([
      'sign-drill',
      '--input',
      fixture.drillInput,
      '--private-key',
      oversized,
      '--output',
      output,
    ]);
    expect(privateResult.status).not.toBe(0);
    expect(privateResult.stderr).toContain(
      'layout authority input is not a bounded single-link regular file',
    );
    expect(fs.existsSync(output)).toBe(false);
    const publicResult = runLayoutAuthorization([
      'verify',
      '--request-envelope',
      fixture.requestEnvelope,
      '--fault-drill-envelope',
      fixture.drillEnvelope,
      '--public-key',
      oversized,
    ]);
    expect(publicResult.status).not.toBe(0);
    expect(publicResult.stderr).toContain(
      'layout authority input is not a bounded single-link regular file',
    );
  });

  it('rejects malformed private and public key bytes', () => {
    const fixture = createLayoutAuthorityFixture();
    const malformed = path.join(fixture.root, 'malformed.pem');
    fs.writeFileSync(malformed, 'definitely-not-a-key\n', { mode: 0o600 });
    const output = path.join(fixture.root, 'malformed-key-output.json');
    expect(runLayoutAuthorization([
      'sign-drill',
      '--input',
      fixture.drillInput,
      '--private-key',
      malformed,
      '--output',
      output,
    ]).status).not.toBe(0);
    expect(fs.existsSync(output)).toBe(false);
    expect(runLayoutAuthorization([
      'verify',
      '--request-envelope',
      fixture.requestEnvelope,
      '--fault-drill-envelope',
      fixture.drillEnvelope,
      '--public-key',
      malformed,
    ]).status).not.toBe(0);
  });
});

describe('promotion bootstrap archive self-binding', () => {
  const installSource = fs.readFileSync(installer, 'utf8');
  const archiveVerifier = installSource.match(
    /# This proof completes before[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\nverify_exact_root_pm2_prerequisite\(\)/,
  )?.[1];
  const sourceSha = 'a'.repeat(40);

  function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  function createFixture() {
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-promotion-bootstrap-'),
    );
    const sourceRoot = path.join(temp, 'source');
    const scripts = path.join(sourceRoot, 'scripts');
    const drOps = path.join(sourceRoot, 'ops', 'application-dr');
    const archive = path.join(temp, 'source.tar.gz');
    const verifier = path.join(temp, 'verify.py');
    const layout = path.join(drOps, 'install-layout.tsv');
    const installerSource = path.join(
      scripts,
      'remote-promotion-systemd-install.sh',
    );
    const promotionInput = path.join(scripts, 'promotion-input.sh');
    const drInput = path.join(scripts, 'dr-input.sh');

    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(drOps, { recursive: true });
    fs.writeFileSync(
      layout,
      '# source<TAB>absolute target<TAB>owner<TAB>mode\n' +
        'scripts/dr-input.sh\t/usr/local/libexec/nexus-application-dr/dr-input.sh' +
        '\troot:root\t0755\n',
    );
    fs.writeFileSync(installerSource, '#!/usr/bin/env bash\nexit 0\n');
    fs.writeFileSync(promotionInput, '#!/usr/bin/env bash\necho promotion\n');
    fs.writeFileSync(drInput, '#!/usr/bin/env bash\necho dr\n');
    fs.writeFileSync(verifier, archiveVerifier!);

    const buildArchive = (
      options: {
        comment?: string;
        duplicate?: string;
        missing?: string;
        unsafeMember?: boolean;
      } = {},
    ) => {
      const result = spawnSync(
        'python3',
        [
          '-c',
          [
            'import io,pathlib,sys,tarfile',
            'archive,root,comment,duplicate,missing,unsafe=sys.argv[1:]',
            'root=pathlib.Path(root)',
            'with tarfile.open(archive,"w:gz",format=tarfile.PAX_FORMAT,pax_headers={"comment":comment}) as output:',
            '  for item in [root,*sorted(root.rglob("*"))]:',
            '    relative=item.relative_to(root).as_posix()',
            '    name="source" if relative=="." else "source/"+relative',
            '    if relative==missing: continue',
            '    output.add(item,arcname=name,recursive=False)',
            '  if duplicate:',
            '    output.add(root/duplicate,arcname="source/"+duplicate,recursive=False)',
            '  if unsafe=="1":',
            '    member=tarfile.TarInfo("source/../escape")',
            '    member.size=1',
            '    output.addfile(member,io.BytesIO(b"x"))',
          ].join('\n'),
          archive,
          sourceRoot,
          options.comment ?? sourceSha,
          options.duplicate ?? '',
          options.missing ?? '',
          options.unsafeMember ? '1' : '0',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      return sha256(archive);
    };

    const verify = (
      expectedArchiveSha256: string,
      declaredSourceSha = sourceSha,
    ) =>
      spawnSync(
        'python3',
        [
          verifier,
          archive,
          sourceRoot,
          declaredSourceSha,
          expectedArchiveSha256,
          layout,
          installerSource,
          'scripts/promotion-input.sh',
        ],
        { encoding: 'utf8' },
      );

    return {
      archive,
      buildArchive,
      drInput,
      remove: () => fs.rmSync(temp, { recursive: true, force: true }),
      verify,
    };
  }

  it('requires exact protected-main bootstrap arguments and verifies before mutation', () => {
    const verifierStart = installSource.indexOf(
      '# This proof completes before the bootstrap journal',
    );
    const journal = installSource.indexOf(
      'BOOTSTRAP_JOURNAL="/var/lib/nexus-release-promotion/bootstrap-in-progress.v1"',
    );
    const firstStateWrite = installSource.indexOf(
      'install -d -o root -g root -m 755',
    );

    expect(
      spawnSync('bash', ['-n', installer], { encoding: 'utf8' }).status,
    ).toBe(0);
    expect(installSource).toContain('[ "$#" -eq 5 ]');
    expect(installSource).toContain(
      'EXPECTED_BOOTSTRAP_ROOT="$BOOTSTRAP_BASE/$SOURCE_SHA"',
    );
    expect(installSource).toContain(
      '[ "$SOURCE_ROOT" = "$EXPECTED_BOOTSTRAP_ROOT/source" ]',
    );
    expect(installSource).toContain(
      '[ "$SOURCE_ARCHIVE" = "$EXPECTED_BOOTSTRAP_ROOT/source.tar.gz" ]',
    );
    expect(installSource).toContain(
      'installer must execute from the exact reviewed bootstrap source path',
    );
    expect(installSource).toContain(
      'archive.pax_headers.get("comment") != source_sha',
    );
    expect(installSource).toContain('ops/application-dr/install-layout.tsv');
    expect(installSource).toContain('duplicate archive member');
    expect(installSource).toContain('required member is not regular');
    expect(installSource).toContain('source/archive byte drift for');
    expect(verifierStart).toBeGreaterThan(-1);
    expect(journal).toBeGreaterThan(verifierStart);
    expect(firstStateWrite).toBeGreaterThan(verifierStart);
  });

  it('rejects an archive changed after owner digest approval', () => {
    expect(archiveVerifier).toBeTruthy();
    const fixture = createFixture();
    try {
      const approved = fixture.buildArchive();
      expect(fixture.verify(approved).status).toBe(0);
      fs.appendFileSync(fixture.archive, 'tamper');
      const result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'archive digest does not match the owner-approved digest',
      );
    } finally {
      fixture.remove();
    }
  });

  it('rejects a wrong declared SHA or wrong Git PAX commit', () => {
    const fixture = createFixture();
    try {
      const approved = fixture.buildArchive();
      const wrongSha = fixture.verify(approved, 'b'.repeat(40));
      expect(wrongSha.status).not.toBe(0);
      expect(wrongSha.stderr).toContain(
        'Git archive commit does not match protected-main source SHA',
      );

      const wrongPaxApproved = fixture.buildArchive({
        comment: 'c'.repeat(40),
      });
      const wrongPax = fixture.verify(wrongPaxApproved);
      expect(wrongPax.status).not.toBe(0);
      expect(wrongPax.stderr).toContain(
        'Git archive commit does not match protected-main source SHA',
      );
    } finally {
      fixture.remove();
    }
  });

  it('rejects missing, duplicate, unsafe, nonregular, and drifted privileged members', () => {
    const fixture = createFixture();
    try {
      let approved = fixture.buildArchive({ missing: 'scripts/dr-input.sh' });
      let result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'missing required member source/scripts/dr-input.sh',
      );

      approved = fixture.buildArchive({
        duplicate: 'scripts/promotion-input.sh',
      });
      result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'duplicate archive member source/scripts/promotion-input.sh',
      );

      approved = fixture.buildArchive({ unsafeMember: true });
      result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('unsafe archive member source/../escape');

      fs.unlinkSync(fixture.drInput);
      fs.symlinkSync('promotion-input.sh', fixture.drInput);
      approved = fixture.buildArchive();
      result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'required member is not regular: source/scripts/dr-input.sh',
      );

      fs.unlinkSync(fixture.drInput);
      fs.writeFileSync(fixture.drInput, '#!/usr/bin/env bash\necho dr\n');
      approved = fixture.buildArchive();
      fs.writeFileSync(fixture.drInput, '#!/usr/bin/env bash\necho drifted\n');
      result = fixture.verify(approved);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'source/archive byte drift for scripts/dr-input.sh',
      );
    } finally {
      fixture.remove();
    }
  });
});
