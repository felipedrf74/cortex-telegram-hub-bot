import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMAS = Object.freeze({
  plan: 'nexus.rollback-drill-kvm-plan.v2',
  authorizationEnvelope: 'nexus.rollback-drill-kvm-owner-authorization.v1',
  authorizationPayload: 'nexus.rollback-drill-kvm-owner-authorization-payload.v1',
  isolation: 'nexus.rollback-drill-kvm-isolation.v1',
  readinessLedger: 'nexus.rollback-drill-kvm-readiness-ledger.v1',
  drill: 'nexus.rollback-drill-kvm-outcome.v1',
  execution: 'nexus.rollback-drill-kvm-execution.v1',
  manifest: 'nexus.rollback-drill-kvm-machine-evidence.v1',
  rollbackRequest: 'nexus.rollback-drill-payload.v1',
  restore: 'NexusApplicationRestoreDrillV1',
  compatibility: 'NexusApplicationRestoreCompatibilityV1',
});

export const DRILL_NAMES = Object.freeze([
  'ssh-loss',
  'failed-health',
  'guest-reboot',
]);

const DIGEST = /^[0-9a-f]{64}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/u;
const PLAN_ID = /^kvm-drill-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u;
const OVERLAY_ID = /^overlay-(?:ssh-loss|failed-health|guest-reboot)-[0-9a-f]{12}$/u;
const TRANSACTION_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const SAFE_BACKUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SAFE_OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVISION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVISION_MAC = /^52:54:00(?::[0-9a-f]{2}){3}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SAFE_PACKAGE =
  /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/u;
const SAFE_PACKAGE_VERSION = /^[A-Za-z0-9.+:~_-]+$/u;
const SAFE_PACKAGE_ARCH = /^[a-z0-9][a-z0-9-]*$/u;
const LOOPBACKS = new Set(['127.0.0.1', '::1']);
const GUEST_USER = 'dominguez';
const MAX_JSON_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_PLAN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RECOVERY_MS = 120 * 1000;

const REQUIRED_PM2_APPS = Object.freeze([
  'nexus-hub',
  'content-engine',
  'nexus-hub-staging',
  'content-engine-staging',
]);

const REQUIRED_LISTENERS = Object.freeze([
  { process: 'nexus-hub', port: 8200 },
  { process: 'content-engine', port: 8100 },
  { process: 'nexus-hub-staging', port: 8201 },
  { process: 'content-engine-staging', port: 8101 },
]);

const INTERFACE_VALUES = Object.freeze({
  promotionControl: '/usr/local/sbin/nexus-release-promotion-control',
  restoreDrill: '/usr/local/libexec/nexus-application-dr/application-dr-restore-drill.sh',
  promotionAuthorization: '/usr/local/libexec/nexus-promotion-authorization.mjs',
  controlVersion: 'nexus-release-promotion-control.v4',
  recoveryUnit: 'nexus-release-promotion-recovery.service',
});
const EXECUTION_MODE = 'strictly-sequential';

const PLAN_FIELDS = Object.freeze([
  'schema',
  'planId',
  'createdAt',
  'expiresAt',
  'mode',
  'sourceRootSha',
  'controller',
  'release',
  'guest',
  'trust',
  'labStorage',
  'syntheticDatabase',
  'overlays',
  'interfaces',
]);
const CONTROLLER_FIELDS = Object.freeze(['machineIdSha256', 'bootIdSha256']);
const RELEASE_FIELDS = Object.freeze([
  'sourceSha',
  'targetSha',
  'sourceVersion',
  'targetVersion',
  'targetBackup',
  'productionBase',
  'stateRoot',
  'backupDir',
  'preparedRuntimeDir',
  'pm2Bin',
  'publicBaseUrl',
]);
const GUEST_FIELDS = Object.freeze([
  'virtualization',
  'osId',
  'osVersionId',
  'architecture',
  'minimumMemoryAvailableBytes',
  'minimumDiskAvailableBytes',
  'requiredPm2Apps',
]);
const TRUST_FIELDS = Object.freeze([
  'guestOwnerPublicKeySha256',
  'productionOwnerPublicKeySha256',
  'guestSshClientPublicKeySha256',
  'productionSshClientPublicKeySha256',
  'guestSshHostPublicKeySha256s',
  'productionSshHostPublicKeySha256',
  'releaseEvidencePublicKeySha256',
]);
const PROVISION_FIELDS = Object.freeze([
  'schema',
  'setId',
  'image',
  'sshPublicKeySha256',
  'guestSshHostPublicKeySha256s',
  'ports',
  'setDirectory',
  'runtimeReadiness',
  'hypervisor',
  'guests',
  'createdAt',
]);
const PROVISION_IMAGE_FIELDS = Object.freeze([
  'filename',
  'sha256',
  'basePath',
]);
const PROVISION_RUNTIME_READINESS_FIELDS = Object.freeze([
  'status',
  'drillReady',
  'requirements',
]);
const PROVISION_HYPERVISOR_FIELDS = Object.freeze([
  'manager',
  'qemuBinary',
  'qemuSha256',
  'qemuVersion',
  'qemuPackage',
  'qemuPackageVersion',
  'qemuPackageArchitecture',
  'runnerPath',
  'runnerSha256',
  'hostPreflightPath',
  'hostPreflightSha256',
  'runtimeManifestPath',
  'runtimeManifestSha256',
  'runtimeControlSourcePath',
  'runtimeControlSha256',
  'runtimeReadinessPath',
  'runtimeReadinessSha256',
  'runtimeRecoveryUnitSourcePath',
  'runtimeRecoveryUnitSha256',
  'faultDrillControllerPath',
  'faultDrillControllerSha256',
  'faultDrillControllerUnitPath',
  'faultDrillControllerUnitSha256',
  'faultDrillControllerRecoveryUnitPath',
  'faultDrillControllerRecoveryUnitSha256',
  'faultDrillGuestExecutorSourcePath',
  'faultDrillGuestExecutorSha256',
  'faultDrillGuestRecoveryUnitSourcePath',
  'faultDrillGuestRecoveryUnitSha256',
  'faultDrillVerifierPath',
  'faultDrillVerifierSha256',
  'sharedMutexPath',
  'guestAdmissionLockPath',
  'hostAvailableMemoryFloorGiB',
  'hostLoad15CeilingExclusive',
  'unitTemplate',
  'unitPath',
  'unitSha256',
  'vcpus',
  'memoryMiB',
  'memorySwapMaxMiB',
  'diskBytes',
  'networkMode',
  'loopbackHost',
  'singleActiveGuest',
  'bridgeAttached',
  'tapAttached',
  'sharedFilesystemAttached',
  'hostBlockDeviceAttached',
  'productionDataAttached',
]);
const PROVISION_GUEST_FIELDS = Object.freeze([
  'name',
  'port',
  'unit',
  'uuid',
  'mac',
  'instanceId',
  'overlayPath',
  'overlayInitialSha256',
  'seedPath',
  'seedSha256',
  'hostPublicKey',
  'hostPublicKeySha256',
  'hostKeyFingerprint',
]);
const PROVISION_REQUIREMENTS = Object.freeze([
  'node-22.23.1',
  'python-3.12.x',
  'pm2-6.0.14-root-closure-at-/opt/nexus-release/pm2/6.0.14-via-/usr/local/bin/pm2',
  'digest-bound-offline-toolchain-evidence',
]);
const EXPECTED_PROVISION_HYPERVISOR = Object.freeze({
  manager: 'qemu-systemd',
  qemuBinary: '/usr/bin/qemu-system-x86_64',
  runnerPath: '/usr/local/libexec/nexus-rollback-drill-vm/run',
  hostPreflightPath:
    '/usr/local/libexec/nexus-rollback-drill-vm/host-preflight',
  runtimeManifestPath:
    '/usr/local/libexec/nexus-rollback-drill-vm/runtime-manifest',
  runtimeControlSourcePath:
    '/usr/local/libexec/nexus-rollback-drill-vm/runtime-control-guest',
  runtimeReadinessPath:
    '/usr/local/libexec/nexus-rollback-drill-vm/runtime-readiness',
  runtimeRecoveryUnitSourcePath:
    '/usr/local/libexec/nexus-rollback-drill-vm/runtime-recovery.service',
  faultDrillControllerPath:
    '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller',
  faultDrillControllerUnitPath:
    '/etc/systemd/system/nexus-release-layout-fault-drill@.service',
  faultDrillControllerRecoveryUnitPath:
    '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service',
  faultDrillGuestExecutorSourcePath:
    '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest',
  faultDrillGuestRecoveryUnitSourcePath:
    '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-guest-recovery.service',
  faultDrillVerifierPath:
    '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs',
  sharedMutexPath: '/run/lock/nexus-release-sonar.lock',
  guestAdmissionLockPath: '/run/nexus-rollback-drill-vm/admission.lock',
  hostAvailableMemoryFloorGiB: 25,
  hostLoad15CeilingExclusive: 6,
  unitTemplate: 'nexus-rollback-drill-vm@.service',
  unitPath: '/etc/systemd/system/nexus-rollback-drill-vm@.service',
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
});
const STORAGE_FIELDS = Object.freeze([
  'provider',
  'isolation',
  'endpoint',
  'bucket',
  'prefix',
  'credentialsScope',
  'syntheticOnly',
  'productionObjectsAccessible',
  'versioningEnabled',
  'encryptionRequired',
]);
const DATABASE_FIELDS = Object.freeze([
  'path',
  'marker',
  'seedSha256',
  'origin',
  'syntheticOnly',
  'productionRowsPresent',
]);
const OVERLAY_FIELDS = Object.freeze([
  'drill',
  'overlayId',
  'overlayInitialSha256',
  'baselineSnapshotSha256',
  'machineUuid',
  'ssh',
]);
const SSH_FIELDS = Object.freeze([
  'host',
  'port',
  'user',
  'hostPublicKeySha256',
]);
const INTERFACE_FIELDS = Object.freeze(Object.keys(INTERFACE_VALUES));

const AUTH_ENVELOPE_FIELDS = Object.freeze([
  'schema',
  'keyId',
  'signatureAlgorithm',
  'payload',
  'signature',
]);
const AUTH_PAYLOAD_FIELDS = Object.freeze([
  'schema',
  'action',
  'planId',
  'planSha256',
  'targetSha',
  'targetVersion',
  'guestOwnerPublicKeySha256',
  'controllerBootIdSha256',
  'approvedMonotonicSeconds',
  'expiresMonotonicSeconds',
  'readinessLedger',
  'isolationSha256',
  'endpoints',
  'approvedAt',
  'expiresAt',
]);
const AUTH_ENDPOINT_FIELDS = Object.freeze(['drill', 'host', 'port', 'hostPublicKeySha256']);

const ISOLATION_FIELDS = Object.freeze([
  'schema',
  'planId',
  'capturedAt',
  'readinessLedger',
  'hypervisor',
  'guest',
  'overlays',
]);
const READINESS_LEDGER_FIELDS = Object.freeze([
  'schema',
  'status',
  'sequenceId',
  'planId',
  'planSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'guestOwnerPublicKeySha256',
  'controllerBootIdSha256',
  'monotonicStartedSeconds',
  'monotonicDeadlineSeconds',
  'monotonicCompletedSeconds',
  'completedAt',
  'orderedReadiness',
  'stateSha256',
]);
const READINESS_LEDGER_ENTRY_FIELDS = Object.freeze([
  'drill',
  'runtimeDrill',
  'guest',
  'requestSha256',
  'readinessSha256',
  'completedAt',
]);
const HYPERVISOR_FIELDS = Object.freeze([
  'machineIdSha256',
  'bootIdSha256',
  'virtualization',
  'manager',
  'devices',
]);
const DEVICE_FIELDS = Object.freeze(['type', 'source', 'target', 'mode']);
const ISOLATION_GUEST_FIELDS = Object.freeze([
  'machineIdSha256',
  'bootIdSha256',
  'virtualization',
  'osId',
  'osVersionId',
  'architecture',
  'memoryAvailableBytes',
  'diskAvailableBytes',
  'kernelLogReadable',
  'mounts',
  'listeners',
  'pm2Apps',
  'canonicalPaths',
  'keyIdentities',
  'syntheticDatabase',
  'productionDataMatches',
]);
const MOUNT_FIELDS = Object.freeze(['target', 'source', 'fileSystemType', 'options']);
const LISTENER_FIELDS = Object.freeze(['host', 'port', 'process']);
const PM2_FIELDS = Object.freeze(['name', 'status', 'restartCount']);
const CANONICAL_PATH_FIELDS = Object.freeze([
  'productionBase',
  'stateRoot',
  'backupDir',
  'preparedRuntimeDir',
  'pm2Bin',
]);
const KEY_IDENTITY_FIELDS = Object.freeze([
  'ownerPublicKeySha256',
  'sshClientPublicKeySha256',
  'sshHostPublicKeySha256',
  'releaseEvidencePublicKeySha256',
]);
const ISOLATION_DATABASE_FIELDS = Object.freeze([
  'path',
  'marker',
  'seedSha256',
  'syntheticOnly',
  'productionRowsPresent',
]);
const ISOLATION_OVERLAY_FIELDS = Object.freeze([
  'drill',
  'overlayId',
  'overlayInitialSha256',
  'baselineSnapshotSha256',
  'machineUuid',
  'sshHostPublicKeySha256',
  'guestMachineIdSha256',
  'readinessBootIdSha256',
]);

const DRILL_FIELDS = Object.freeze([
  'schema',
  'planId',
  'executionMode',
  'testMode',
  'executionReceiptSha256',
  'drill',
  'overlayId',
  'transactionId',
  'requestSha256',
  'controlVersion',
  'terminalStatus',
  'secondLaunchObserved',
  'productionEvidenceEmitted',
  'exactTargetHealthy',
  'exactPredecessorRestored',
  'databaseBackupRestored',
  'journalSha256',
  'recoveryResultSha256',
  'postTerminalReboot',
  'timeline',
]);
const EXECUTION_FIELDS = Object.freeze([
  'schema',
  'planId',
  'planSha256',
  'readinessLedgerSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'orderedReadinessSha256s',
  'guestSshClientPublicKeySha256',
  'executionMode',
  'maximumActiveGuests',
  'testMode',
  'outcomes',
  'completedAt',
]);
const EXECUTION_OUTCOME_FIELDS = Object.freeze([
  'drill',
  'path',
  'payloadSha256',
]);
const POST_TERMINAL_REBOOT_FIELDS = Object.freeze([
  'beforeGuestBootIdSha256',
  'afterGuestBootIdSha256',
  'journalSha256',
  'controlVersion',
  'recoveryUnitResult',
  'assertRootPm2Ready',
  'assertIdle',
  'exactRuntimeHealthy',
]);
const TIMELINE_FIELDS = Object.freeze([
  'event',
  'observedAt',
  'observerMonotonicMs',
  'observerBootIdSha256',
  'guestBootIdSha256',
]);

const MANIFEST_FIELDS = Object.freeze([
  'schema',
  'planId',
  'collectedAt',
  'sourceRootSha',
  'targetSha',
  'targetVersion',
  'planSha256',
  'authorizationSha256',
  'isolationSha256',
  'readiness',
  'execution',
  'restore',
  'drills',
  'files',
]);
const MANIFEST_READINESS_FIELDS = Object.freeze([
  'schema',
  'sequenceId',
  'ledgerSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'orderedReadinessSha256s',
]);
const MANIFEST_EXECUTION_FIELDS = Object.freeze([
  'schema',
  'executionMode',
  'maximumActiveGuests',
  'testMode',
  'guestSshClientPublicKeySha256',
  'readinessLedgerSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'orderedReadinessSha256s',
  'receiptSha256',
  'completedAt',
]);
const MANIFEST_RESTORE_FIELDS = Object.freeze([
  'schemaVersion',
  'targetBackup',
  'targetBackupSha256',
  'databaseSha256',
  'postMigrationDatabaseSha256',
  'databaseIntegrity',
  'backupContainsDatabase',
  'healthCheck',
  'rpoSeconds',
  'technicalRestoreSeconds',
  'completedAt',
]);
const MANIFEST_DRILL_FIELDS = Object.freeze([
  'drill',
  'overlayId',
  'terminalStatus',
  'recoveryMilliseconds',
  'completedAt',
  'outcomeSha256',
]);
const FILE_RECORD_FIELDS = Object.freeze(['path', 'bytes', 'sha256']);

const ROLLBACK_REQUEST_FIELDS = Object.freeze([
  'schema',
  'drilledAt',
  'result',
  'restoreMode',
  'dryRun',
  'sourceVersion',
  'targetVersion',
  'sourceSha',
  'targetSha',
  'targetBackup',
  'targetBackupSha256',
  'machineEvidenceSha256',
  'operator',
  'databaseIntegrity',
  'backupContainsDatabase',
  'healthCheck',
]);

const RESTORE_FIELDS = Object.freeze([
  'schemaVersion',
  'databaseKey',
  'releaseKey',
  'databaseSha256',
  'releaseSha256',
  'sqliteIntegrityVerified',
  'exactReleaseBundleVerified',
  'exactSignedRecoveryArtifactVerified',
  'releaseManifestSha256',
  'stagingAttestationSha256',
  'runtimeSha',
  'artifactDigest',
  'installedRuntimeDigest',
  'recoveryRuntimeDigest',
  'relocatableInstalledTreeVerified',
  'networkIndependentDependenciesVerified',
  'dependencyInstallNetworkNamespaceVerified',
  'recoveryRuntimeVerificationUnprivileged',
  'recoveryRuntimeVerificationNetworkNamespaceVerified',
  'preMigrationReleaseDatabaseCompatibility',
  'postMigrationReleaseDatabaseCompatibility',
  'releaseDatabaseCompatibility',
  'postMigrationSqliteIntegrityVerified',
  'postMigrationWalStateCapturedByOnlineBackup',
  'postMigrationDatabaseSha256',
  'isolatedBootVerified',
  'isolatedNetworkNamespaceVerified',
  'invalidCredentialRejected',
  'representativeRestoredDatabaseReadVerified',
  'nodeBackendBootVerified',
  'contentEngineBootVerified',
  'contentEngineHealthVerified',
  'processIdentities',
  'applicationSmokeHarnessVerified',
  'rpoSeconds',
  'rpoTargetSeconds',
  'rpoEvidenceScope',
  'rpoEvidenceBasis',
  'rpoSignedProvenanceVerified',
  'databaseTimestampEvidence',
  'objectVersionEvidence',
  'technicalRestoreSeconds',
  'technicalRestoreTargetSeconds',
  'technicalRestoreScope',
  'completedAt',
]);
const COMPATIBILITY_FIELDS = Object.freeze([
  'schemaVersion',
  'status',
  'databaseMaxMigration',
  'runtimeMaxMigration',
  'terminalLineageVerified',
  'appliedMigrationCount',
  'appliedMigrationSetSha256',
  'runtimeMigrationCount',
  'runtimeMigrationSetSha256',
  'canonicalAppliedMigrationCount',
  'migrationLineageId',
  'retiredMigrationCount',
  'retiredMigrationSetSha256',
  'retiredMigrationPolicySha256',
  'identitySha256',
]);
const PROCESS_IDENTITIES_FIELDS = Object.freeze(['nodeBackend', 'contentEngine']);
const PROCESS_IDENTITY_FIELDS = Object.freeze([
  'pidNamespaceProcessId',
  'runtimePath',
  'runtimeSha256',
]);
const TIMESTAMP_EVIDENCE_FIELDS = Object.freeze([
  'metadataCreatedEpoch',
  'keyTimestampEpoch',
  's3LastModifiedEpoch',
  'conservativeEpoch',
]);
const OBJECT_VERSION_FIELDS = Object.freeze([
  'provider',
  'databaseVersionId',
  'releaseVersionId',
  'exactVersionDownloadVerified',
  'approvedUnversionedVariance',
]);

const TIMELINE_EVENTS = Object.freeze({
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
});

export class EvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EvidenceError';
    this.code = code;
  }
}

function fail(code) {
  throw new EvidenceError(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, code) {
  if (!isObject(value)) fail(code);
}

function assertExactFields(value, fields, code) {
  assertObject(value, `${code}_not_object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    fail(`${code}_fields_invalid`);
  }
}

function assertString(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
}

function assertDigest(value, code) {
  assertString(value, DIGEST, code);
}

function assertFullSha(value, code) {
  assertString(value, FULL_SHA, code);
}

function assertInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
}

function assertBoolean(value, expected, code) {
  if (typeof value !== 'boolean' || (expected !== undefined && value !== expected)) fail(code);
}

function parseIso(value, code) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function assertArray(value, minimum, maximum, code) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(code);
}

function unique(values, code) {
  if (new Set(values).size !== values.length) fail(code);
}

function startsAtPath(candidate, base) {
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

export function canonicalJsonBuffer(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Json(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

export function publicKeyIdentity(pem) {
  try {
    const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
    return sha256Bytes(der);
  } catch {
    fail('public_key_invalid');
  }
}

export function normalizeSshEd25519PublicKey(value) {
  if (typeof value !== 'string' || value.trim().length < 16 || value.length > 16 * 1024) {
    fail('text_public_key_invalid');
  }
  const trimmed = value.trim();
  if (/[\r\n]/u.test(trimmed)) fail('text_public_key_invalid');
  const fields = trimmed.split(/[ \t]+/u);
  if (fields.length < 2 || fields[0] !== 'ssh-ed25519'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(fields[1])) {
    fail('text_public_key_invalid');
  }
  const material = Buffer.from(fields[1], 'base64');
  const canonicalBase64 = material.toString('base64').replace(/=+$/u, '');
  if (fields[1].replace(/=+$/u, '') !== canonicalBase64
      || material.length !== 51
      || material.readUInt32BE(0) !== 11
      || material.subarray(4, 15).toString('ascii') !== 'ssh-ed25519'
      || material.readUInt32BE(15) !== 32) {
    fail('text_public_key_invalid');
  }
  return `ssh-ed25519 ${canonicalBase64}`;
}

export function textKeyIdentity(value) {
  return sha256Bytes(Buffer.from(normalizeSshEd25519PublicKey(value), 'utf8'));
}

function sshEd25519Fingerprint(value) {
  let canonical;
  try {
    canonical = normalizeSshEd25519PublicKey(value);
  } catch {
    fail('provision_guest_binding_invalid');
  }
  if (canonical !== value) fail('provision_guest_binding_invalid');
  const keyBlob = Buffer.from(canonical.split(' ')[1], 'base64');
  return `SHA256:${createHash('sha256')
    .update(keyBlob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

export function validateProvisionReceipt(receipt) {
  assertExactFields(receipt, PROVISION_FIELDS, 'provision');
  if (receipt.schema !== 'nexus.rollback-drill-vm-provision.v2') {
    fail('provision_schema_unsupported');
  }
  assertDigest(receipt.setId, 'provision_set_id_invalid');
  assertArray(receipt.ports, 3, 3, 'provision_ports_invalid');
  unique(receipt.ports, 'provision_ports_reused');
  assertArray(
    receipt.guestSshHostPublicKeySha256s,
    3,
    3,
    'provision_ssh_host_digests_invalid',
  );
  unique(
    receipt.guestSshHostPublicKeySha256s,
    'provision_guest_host_key_reused',
  );
  assertArray(receipt.guests, 3, 3, 'provision_guests_invalid');

  assertExactFields(receipt.image, PROVISION_IMAGE_FIELDS, 'provision_image');
  assertDigest(receipt.image.sha256, 'provision_image_digest_invalid');
  if (receipt.image.filename !== 'noble-server-cloudimg-amd64.img'
      || receipt.image.basePath
        !== `/var/lib/nexus-rollback-drill-vm/base/${receipt.image.sha256}.qcow2`
      || receipt.setDirectory
        !== `/var/lib/nexus-rollback-drill-vm/sets/${receipt.setId}`) {
    fail('provision_image_or_set_binding_invalid');
  }
  assertDigest(
    receipt.sshPublicKeySha256,
    'provision_ssh_client_digest_invalid',
  );
  receipt.guestSshHostPublicKeySha256s.forEach((identity) => {
    assertDigest(identity, 'provision_ssh_host_digest_invalid');
    if (identity === receipt.sshPublicKeySha256) {
      fail('provision_client_host_key_reuse');
    }
  });
  receipt.ports.forEach((port) => {
    assertInteger(port, 1024, 65535, 'provision_guest_port_invalid');
  });

  assertExactFields(
    receipt.runtimeReadiness,
    PROVISION_RUNTIME_READINESS_FIELDS,
    'provision_runtime_readiness',
  );
  if (receipt.runtimeReadiness.status
        !== 'ssh_only_bootstrap_required'
      || receipt.runtimeReadiness.drillReady !== false
      || canonicalJson(receipt.runtimeReadiness.requirements)
        !== canonicalJson(PROVISION_REQUIREMENTS)) {
    fail('provision_runtime_readiness_invalid');
  }

  assertExactFields(
    receipt.hypervisor,
    PROVISION_HYPERVISOR_FIELDS,
    'provision_hypervisor',
  );
  for (const [field, expected] of Object.entries(
    EXPECTED_PROVISION_HYPERVISOR,
  )) {
    if (receipt.hypervisor[field] !== expected) {
      fail(`provision_hypervisor_binding_invalid:${field}`);
    }
  }
  for (const field of [
    'qemuSha256',
    'runnerSha256',
    'hostPreflightSha256',
    'runtimeManifestSha256',
    'runtimeControlSha256',
    'runtimeReadinessSha256',
    'runtimeRecoveryUnitSha256',
    'faultDrillControllerSha256',
    'faultDrillControllerUnitSha256',
    'faultDrillControllerRecoveryUnitSha256',
    'faultDrillGuestExecutorSha256',
    'faultDrillGuestRecoveryUnitSha256',
    'faultDrillVerifierSha256',
    'unitSha256',
  ]) {
    assertDigest(
      receipt.hypervisor[field],
      `provision_hypervisor_digest_invalid:${field}`,
    );
  }
  if (!/^QEMU emulator version [ -~]{1,230}$/u.test(
    receipt.hypervisor.qemuVersion,
  ) || !SAFE_PACKAGE.test(receipt.hypervisor.qemuPackage)
      || !SAFE_PACKAGE_VERSION.test(receipt.hypervisor.qemuPackageVersion)
      || !SAFE_PACKAGE_ARCH.test(
        receipt.hypervisor.qemuPackageArchitecture,
      )) {
    fail('provision_qemu_package_identity_invalid');
  }
  parseIso(receipt.createdAt, 'provision_created_at_invalid');

  const observed = {
    uuids: [],
    macs: [],
    overlays: [],
    seeds: [],
    hostKeys: [],
    fingerprints: [],
  };
  receipt.guests.forEach((guest, index) => {
    assertExactFields(
      guest,
      PROVISION_GUEST_FIELDS,
      `provision_guest_${index + 1}`,
    );
    const expectedName = `guest-${index + 1}`;
    const expectedRoot = `${receipt.setDirectory}/${expectedName}`;
    assertString(guest.uuid, PROVISION_UUID, 'provision_guest_uuid_invalid');
    assertString(guest.mac, PROVISION_MAC, 'provision_guest_mac_invalid');
    assertString(
      guest.hostKeyFingerprint,
      SSH_FINGERPRINT,
      'provision_guest_host_fingerprint_invalid',
    );
    assertDigest(
      guest.hostPublicKeySha256,
      'provision_guest_host_key_digest_invalid',
    );
    if (guest.name !== expectedName
        || guest.port !== receipt.ports[index]
        || guest.unit !== `nexus-rollback-drill-vm@${expectedName}.service`
        || guest.instanceId
          !== `nexus-rollback-drill-${expectedName}-${receipt.setId.slice(0, 16)}`
        || guest.overlayPath !== `${expectedRoot}/root.qcow2`
        || guest.seedPath !== `${expectedRoot}/seed.img`
        || textKeyIdentity(guest.hostPublicKey)
          !== guest.hostPublicKeySha256
        || guest.hostPublicKeySha256
          !== receipt.guestSshHostPublicKeySha256s[index]
        || sshEd25519Fingerprint(guest.hostPublicKey)
          !== guest.hostKeyFingerprint) {
      fail('provision_guest_binding_invalid');
    }
    assertDigest(
      guest.overlayInitialSha256,
      'provision_overlay_initial_digest_invalid',
    );
    assertDigest(guest.seedSha256, 'provision_seed_digest_invalid');
    observed.uuids.push(guest.uuid);
    observed.macs.push(guest.mac);
    observed.overlays.push(guest.overlayInitialSha256);
    observed.seeds.push(guest.seedSha256);
    observed.hostKeys.push(guest.hostPublicKeySha256);
    observed.fingerprints.push(guest.hostKeyFingerprint);
  });
  if (Object.values(observed).some(
    (identities) => new Set(identities).size !== 3,
  )) {
    fail('provision_guest_identity_reused');
  }

  const setMaterial = [
    'schema=nexus.rollback-drill-vm-provision.v2',
    `image=${receipt.image.sha256}`,
    `key=${receipt.sshPublicKeySha256}`,
    `hostKeys=${receipt.guestSshHostPublicKeySha256s.join(',')}`,
    `ports=${receipt.ports.join(',')}`,
    `runner=${receipt.hypervisor.runnerSha256}`,
    `hostPreflight=${receipt.hypervisor.hostPreflightSha256}`,
    `runtimeManifest=${receipt.hypervisor.runtimeManifestSha256}`,
    `runtimeControl=${receipt.hypervisor.runtimeControlSha256}`,
    `runtimeReadiness=${receipt.hypervisor.runtimeReadinessSha256}`,
    `runtimeRecoveryUnit=${receipt.hypervisor.runtimeRecoveryUnitSha256}`,
    `faultDrillController=${receipt.hypervisor.faultDrillControllerSha256}`,
    `faultDrillControllerUnit=${receipt.hypervisor.faultDrillControllerUnitSha256}`,
    `faultDrillControllerRecoveryUnit=${receipt.hypervisor.faultDrillControllerRecoveryUnitSha256}`,
    `faultDrillGuest=${receipt.hypervisor.faultDrillGuestExecutorSha256}`,
    `faultDrillGuestRecoveryUnit=${receipt.hypervisor.faultDrillGuestRecoveryUnitSha256}`,
    `faultDrillVerifier=${receipt.hypervisor.faultDrillVerifierSha256}`,
    `unit=${receipt.hypervisor.unitSha256}`,
    `qemu=${receipt.hypervisor.qemuSha256}`,
    `qemuVersion=${receipt.hypervisor.qemuVersion}`,
    `qemuPackage=${receipt.hypervisor.qemuPackage}`,
    `qemuPackageVersion=${receipt.hypervisor.qemuPackageVersion}`,
    `qemuPackageArchitecture=${receipt.hypervisor.qemuPackageArchitecture}`,
    '',
  ].join('\n');
  if (sha256Bytes(Buffer.from(setMaterial, 'utf8')) !== receipt.setId) {
    fail('provision_set_identity_invalid');
  }
  return receipt;
}

function validateCanonicalReleasePaths(release) {
  if (release.productionBase !== '/srv/nexus-release/production') {
    fail('production_base_invalid');
  }
  if (release.stateRoot !== '/var/lib/nexus-release-promotion') fail('state_root_invalid');
  if (release.backupDir !== '/home/dominguez/backups/nexushub') fail('backup_dir_invalid');
  if (!/^\/home\/dominguez\/backups\/nexushub\/\.runtime-stage-[A-Za-z0-9]+$/u.test(
    release.preparedRuntimeDir,
  )) {
    fail('prepared_runtime_dir_invalid');
  }
  if (release.pm2Bin !== '/usr/local/bin/pm2') fail('pm2_path_invalid');
  let publicUrl;
  try {
    publicUrl = new URL(release.publicBaseUrl);
  } catch {
    fail('public_base_url_invalid');
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash
      || LOOPBACKS.has(publicUrl.hostname) || publicUrl.hostname === 'localhost') {
    fail('public_base_url_invalid');
  }
}

export function validatePlan(plan, { nowMs = Date.now(), allowExpired = false } = {}) {
  assertExactFields(plan, PLAN_FIELDS, 'plan');
  if (plan.schema !== SCHEMAS.plan) fail('plan_schema_unsupported');
  assertString(plan.planId, PLAN_ID, 'plan_id_invalid');
  if (plan.mode !== 'isolated-kvm-first-drill') fail('plan_mode_invalid');
  assertFullSha(plan.sourceRootSha, 'source_root_sha_invalid');
  const created = parseIso(plan.createdAt, 'plan_created_at_invalid');
  const expires = parseIso(plan.expiresAt, 'plan_expires_at_invalid');
  if (expires <= created || expires - created > MAX_PLAN_LIFETIME_MS) fail('plan_lifetime_invalid');
  if (created > nowMs + CLOCK_SKEW_MS) fail('plan_not_yet_valid');
  if (!allowExpired && expires < nowMs) fail('plan_expired');

  assertExactFields(plan.controller, CONTROLLER_FIELDS, 'controller');
  assertDigest(plan.controller.machineIdSha256, 'controller_machine_id_invalid');
  assertDigest(plan.controller.bootIdSha256, 'controller_boot_id_invalid');
  if (plan.controller.machineIdSha256 === plan.controller.bootIdSha256) {
    fail('controller_identity_collapsed');
  }

  assertExactFields(plan.release, RELEASE_FIELDS, 'release');
  assertFullSha(plan.release.sourceSha, 'source_sha_invalid');
  assertFullSha(plan.release.targetSha, 'target_sha_invalid');
  assertString(plan.release.sourceVersion, VERSION, 'source_version_invalid');
  assertString(plan.release.targetVersion, VERSION, 'target_version_invalid');
  assertString(plan.release.targetBackup, SAFE_BACKUP, 'target_backup_invalid');
  if (plan.sourceRootSha !== plan.release.targetSha) fail('source_root_target_sha_mismatch');
  if (plan.release.sourceSha === plan.release.targetSha) fail('release_sha_not_distinct');
  validateCanonicalReleasePaths(plan.release);

  assertExactFields(plan.guest, GUEST_FIELDS, 'guest');
  if (plan.guest.virtualization !== 'kvm'
      || plan.guest.osId !== 'ubuntu'
      || plan.guest.osVersionId !== '24.04'
      || plan.guest.architecture !== 'x86_64') {
    fail('guest_platform_invalid');
  }
  assertInteger(
    plan.guest.minimumMemoryAvailableBytes,
    12 * 1024 ** 3,
    128 * 1024 ** 3,
    'guest_memory_threshold_invalid',
  );
  assertInteger(
    plan.guest.minimumDiskAvailableBytes,
    20 * 1024 ** 3,
    10 * 1024 ** 4,
    'guest_disk_threshold_invalid',
  );
  assertArray(plan.guest.requiredPm2Apps, 4, 4, 'required_pm2_apps_invalid');
  if (plan.guest.requiredPm2Apps.some((name, index) => name !== REQUIRED_PM2_APPS[index])) {
    fail('required_pm2_apps_invalid');
  }

  assertExactFields(plan.trust, TRUST_FIELDS, 'trust');
  for (const field of TRUST_FIELDS.filter(
    (field) => field !== 'guestSshHostPublicKeySha256s',
  )) {
    assertDigest(plan.trust[field], `trust_${field}_invalid`);
  }
  assertArray(
    plan.trust.guestSshHostPublicKeySha256s,
    3,
    3,
    'trust_guest_ssh_host_keys_invalid',
  );
  plan.trust.guestSshHostPublicKeySha256s.forEach((digest) => {
    assertDigest(digest, 'trust_guest_ssh_host_key_invalid');
  });
  unique(
    plan.trust.guestSshHostPublicKeySha256s,
    'trust_guest_ssh_host_key_reuse',
  );
  for (const [guestField, productionField, code] of [
    ['guestOwnerPublicKeySha256', 'productionOwnerPublicKeySha256', 'production_owner_key_reuse'],
    ['guestSshClientPublicKeySha256', 'productionSshClientPublicKeySha256', 'production_ssh_client_key_reuse'],
  ]) {
    if (plan.trust[guestField] === plan.trust[productionField]) fail(code);
  }
  if (plan.trust.guestSshHostPublicKeySha256s.includes(
    plan.trust.productionSshHostPublicKeySha256,
  )) {
    fail('production_ssh_host_key_reuse');
  }

  assertExactFields(plan.labStorage, STORAGE_FIELDS, 'lab_storage');
  if (!['cloudflare-r2', 'aws-s3-lab'].includes(plan.labStorage.provider)
      || plan.labStorage.isolation !== 'guest-drill-only'
      || plan.labStorage.credentialsScope !== 'guest-drill-only') {
    fail('lab_storage_scope_invalid');
  }
  let storageUrl;
  try {
    storageUrl = new URL(plan.labStorage.endpoint);
  } catch {
    fail('lab_storage_endpoint_invalid');
  }
  if (storageUrl.protocol !== 'https:' || storageUrl.username || storageUrl.password
      || storageUrl.search || storageUrl.hash) {
    fail('lab_storage_endpoint_invalid');
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/u.test(plan.labStorage.bucket)) {
    fail('lab_storage_bucket_invalid');
  }
  if (plan.labStorage.prefix !== `nexus-rollback-drill/${plan.planId}`) {
    fail('lab_storage_prefix_invalid');
  }
  assertBoolean(plan.labStorage.syntheticOnly, true, 'lab_storage_not_synthetic');
  assertBoolean(
    plan.labStorage.productionObjectsAccessible,
    false,
    'lab_storage_production_access',
  );
  assertBoolean(plan.labStorage.versioningEnabled, true, 'lab_storage_versioning_missing');
  assertBoolean(plan.labStorage.encryptionRequired, true, 'lab_storage_encryption_missing');

  assertExactFields(plan.syntheticDatabase, DATABASE_FIELDS, 'synthetic_database');
  if (!/^\/srv\/nexus-drill-lab\/[A-Za-z0-9._/-]+\.db$/u.test(plan.syntheticDatabase.path)
      || startsAtPath(plan.syntheticDatabase.path, plan.release.productionBase)
      || startsAtPath(plan.syntheticDatabase.path, plan.release.backupDir)) {
    fail('synthetic_database_path_invalid');
  }
  if (plan.syntheticDatabase.marker !== `NEXUS_SYNTHETIC_DRILL:${plan.planId}`) {
    fail('synthetic_database_marker_invalid');
  }
  assertDigest(plan.syntheticDatabase.seedSha256, 'synthetic_database_seed_invalid');
  if (plan.syntheticDatabase.origin !== 'generated-in-guest') fail('synthetic_database_origin_invalid');
  assertBoolean(plan.syntheticDatabase.syntheticOnly, true, 'synthetic_database_not_synthetic');
  assertBoolean(
    plan.syntheticDatabase.productionRowsPresent,
    false,
    'synthetic_database_contains_production_rows',
  );

  assertArray(plan.overlays, 3, 3, 'overlays_invalid');
  const overlayIds = [];
  const overlayImages = [];
  const machineUuids = [];
  const ports = [];
  const snapshots = [];
  plan.overlays.forEach((overlay, index) => {
    assertExactFields(overlay, OVERLAY_FIELDS, `overlay_${index}`);
    if (overlay.drill !== DRILL_NAMES[index]) fail('overlay_order_invalid');
    assertString(overlay.overlayId, OVERLAY_ID, 'overlay_id_invalid');
    if (!overlay.overlayId.startsWith(`overlay-${overlay.drill}-`)) fail('overlay_id_drill_mismatch');
    assertDigest(overlay.overlayInitialSha256, 'overlay_initial_sha_invalid');
    assertDigest(overlay.baselineSnapshotSha256, 'baseline_snapshot_sha_invalid');
    assertString(overlay.machineUuid, UUID, 'overlay_machine_uuid_invalid');
    assertExactFields(overlay.ssh, SSH_FIELDS, 'overlay_ssh');
    if (!LOOPBACKS.has(overlay.ssh.host)) fail('ssh_target_not_loopback');
    assertInteger(overlay.ssh.port, 1024, 65535, 'ssh_forwarded_port_invalid');
    if (overlay.ssh.user !== GUEST_USER) fail('ssh_guest_user_invalid');
    assertDigest(overlay.ssh.hostPublicKeySha256, 'ssh_host_key_invalid');
    if (overlay.ssh.hostPublicKeySha256
        !== plan.trust.guestSshHostPublicKeySha256s[index]) {
      fail('ssh_host_key_not_guest');
    }
    overlayIds.push(overlay.overlayId);
    overlayImages.push(overlay.overlayInitialSha256);
    machineUuids.push(overlay.machineUuid);
    ports.push(`${overlay.ssh.host}:${overlay.ssh.port}`);
    snapshots.push(overlay.baselineSnapshotSha256);
  });
  unique(overlayIds, 'overlay_id_reuse');
  unique(overlayImages, 'overlay_image_reuse');
  unique(machineUuids, 'overlay_machine_uuid_reuse');
  unique(ports, 'ssh_forward_reuse');
  if (new Set(snapshots).size !== 1) fail('baseline_snapshot_mismatch');

  assertExactFields(plan.interfaces, INTERFACE_FIELDS, 'interfaces');
  for (const [field, expected] of Object.entries(INTERFACE_VALUES)) {
    if (plan.interfaces[field] !== expected) fail(`interface_${field}_invalid`);
  }

  return plan;
}

function canonicalSignature(signature) {
  if (typeof signature !== 'string'
      || signature.length !== 88
      || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) {
    fail('owner_authorization_signature_encoding_invalid');
  }
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) {
    fail('owner_authorization_signature_encoding_invalid');
  }
  return bytes;
}

export function validateReadinessLedger(ledger, plan) {
  assertExactFields(ledger, READINESS_LEDGER_FIELDS, 'readiness_ledger');
  if (ledger.schema !== SCHEMAS.readinessLedger
      || ledger.status !== 'all_runtime_readiness_complete'
      || ledger.planId !== plan.planId
      || ledger.planSha256 !== sha256Json(plan)
      || ledger.guestOwnerPublicKeySha256
        !== plan.trust.guestOwnerPublicKeySha256
      || ledger.controllerBootIdSha256
        !== plan.controller.bootIdSha256) {
    fail('readiness_ledger_binding_invalid');
  }
  for (const field of [
    'sequenceId',
    'generationManifestSha256',
    'provisionReceiptSha256',
    'stateSha256',
  ]) {
    assertDigest(ledger[field], `readiness_ledger_${field}_invalid`);
  }
  assertInteger(
    ledger.monotonicStartedSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'readiness_ledger_monotonic_start_invalid',
  );
  assertInteger(
    ledger.monotonicDeadlineSeconds,
    1,
    Number.MAX_SAFE_INTEGER,
    'readiness_ledger_monotonic_deadline_invalid',
  );
  assertInteger(
    ledger.monotonicCompletedSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'readiness_ledger_monotonic_completion_invalid',
  );
  if (ledger.monotonicDeadlineSeconds <= ledger.monotonicStartedSeconds
      || ledger.monotonicDeadlineSeconds - ledger.monotonicStartedSeconds
        > 24 * 60 * 60
      || ledger.monotonicCompletedSeconds < ledger.monotonicStartedSeconds
      || ledger.monotonicCompletedSeconds > ledger.monotonicDeadlineSeconds) {
    fail('readiness_ledger_monotonic_window_invalid');
  }
  const completedAt = parseIso(
    ledger.completedAt,
    'readiness_ledger_completed_at_invalid',
  );
  if (completedAt < Date.parse(plan.createdAt) - CLOCK_SKEW_MS
      || completedAt > Date.parse(plan.expiresAt)) {
    fail('readiness_ledger_completed_at_binding_invalid');
  }
  assertArray(
    ledger.orderedReadiness,
    DRILL_NAMES.length,
    DRILL_NAMES.length,
    'readiness_ledger_entries_invalid',
  );
  let previousCompletion = 0;
  const requestDigests = [];
  const readinessDigests = [];
  ledger.orderedReadiness.forEach((entry, index) => {
    assertExactFields(
      entry,
      READINESS_LEDGER_ENTRY_FIELDS,
      'readiness_ledger_entry',
    );
    const expectedDrill = DRILL_NAMES[index];
    const expectedRuntimeDrill = [
      'ssh-disconnect-after-pm2-stop',
      'failed-health-check',
      'host-reboot-during-promotion',
    ][index];
    if (entry.drill !== expectedDrill
        || entry.runtimeDrill !== expectedRuntimeDrill
        || entry.guest !== `guest-${index + 1}`) {
      fail('readiness_ledger_order_invalid');
    }
    assertDigest(
      entry.requestSha256,
      'readiness_ledger_request_digest_invalid',
    );
    assertDigest(
      entry.readinessSha256,
      'readiness_ledger_readiness_digest_invalid',
    );
    const entryCompleted = parseIso(
      entry.completedAt,
      'readiness_ledger_entry_completed_at_invalid',
    );
    if (entryCompleted < previousCompletion || entryCompleted > completedAt) {
      fail('readiness_ledger_entry_chronology_invalid');
    }
    previousCompletion = entryCompleted;
    requestDigests.push(entry.requestSha256);
    readinessDigests.push(entry.readinessSha256);
  });
  unique(requestDigests, 'readiness_ledger_request_reuse');
  unique(readinessDigests, 'readiness_ledger_readiness_reuse');
  return ledger;
}

export function validateOwnerAuthorization(
  envelope,
  plan,
  guestOwnerPublicKeyPem,
  {
    nowMs = Date.now(),
    allowExpired = false,
    isolation = null,
    currentBootIdSha256 = null,
    currentMonotonicSeconds = null,
  } = {},
) {
  validatePlan(plan, { nowMs, allowExpired });
  assertExactFields(envelope, AUTH_ENVELOPE_FIELDS, 'owner_authorization');
  if (envelope.schema !== SCHEMAS.authorizationEnvelope) {
    fail('owner_authorization_schema_unsupported');
  }
  if (envelope.signatureAlgorithm !== 'ed25519') {
    fail('owner_authorization_algorithm_invalid');
  }
  const guestOwnerKeyIdentity = publicKeyIdentity(guestOwnerPublicKeyPem);
  if (guestOwnerKeyIdentity !== plan.trust.guestOwnerPublicKeySha256) {
    fail('guest_owner_public_key_identity_mismatch');
  }
  if (envelope.keyId !== `sha256:${guestOwnerKeyIdentity}`) {
    fail('owner_authorization_key_id_invalid');
  }

  const payload = envelope.payload;
  assertExactFields(payload, AUTH_PAYLOAD_FIELDS, 'owner_authorization_payload');
  if (payload.schema !== SCHEMAS.authorizationPayload) {
    fail('owner_authorization_payload_schema_unsupported');
  }
  if (payload.action !== 'run-isolated-kvm-rollback-drills') {
    fail('owner_authorization_action_invalid');
  }
  if (payload.planId !== plan.planId) fail('owner_authorization_plan_id_mismatch');
  if (payload.planSha256 !== sha256Json(plan)) fail('owner_authorization_plan_digest_mismatch');
  if (payload.targetSha !== plan.release.targetSha
      || payload.targetVersion !== plan.release.targetVersion) {
    fail('owner_authorization_target_mismatch');
  }
  if (payload.guestOwnerPublicKeySha256 !== guestOwnerKeyIdentity) {
    fail('owner_authorization_guest_key_mismatch');
  }
  if (payload.controllerBootIdSha256 !== plan.controller.bootIdSha256) {
    fail('owner_authorization_boot_id_mismatch');
  }
  assertInteger(
    payload.approvedMonotonicSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'owner_authorization_monotonic_start_invalid',
  );
  assertInteger(
    payload.expiresMonotonicSeconds,
    1,
    Number.MAX_SAFE_INTEGER,
    'owner_authorization_monotonic_deadline_invalid',
  );
  validateReadinessLedger(payload.readinessLedger, plan);
  assertDigest(
    payload.isolationSha256,
    'owner_authorization_isolation_digest_invalid',
  );
  if (isolation
      && (canonicalJson(payload.readinessLedger)
        !== canonicalJson(isolation.readinessLedger)
        || payload.isolationSha256 !== sha256Json(isolation))) {
    fail('owner_authorization_isolation_mismatch');
  }
  assertArray(payload.endpoints, 3, 3, 'owner_authorization_endpoints_invalid');
  payload.endpoints.forEach((endpoint, index) => {
    assertExactFields(endpoint, AUTH_ENDPOINT_FIELDS, 'owner_authorization_endpoint');
    const expected = plan.overlays[index];
    if (endpoint.drill !== expected.drill
        || endpoint.host !== expected.ssh.host
        || endpoint.port !== expected.ssh.port
        || endpoint.hostPublicKeySha256 !== expected.ssh.hostPublicKeySha256) {
      fail('owner_authorization_endpoint_mismatch');
    }
  });
  const approved = parseIso(payload.approvedAt, 'owner_authorization_approved_at_invalid');
  const expires = parseIso(payload.expiresAt, 'owner_authorization_expires_at_invalid');
  if (approved < Date.parse(plan.createdAt) - CLOCK_SKEW_MS
      || approved > nowMs + CLOCK_SKEW_MS
      || expires <= approved
      || expires > Date.parse(plan.expiresAt)
      || expires - approved > 24 * 60 * 60 * 1000) {
    fail('owner_authorization_lifetime_invalid');
  }
  const wallLifetimeSeconds = (expires - approved) / 1000;
  if (!Number.isSafeInteger(wallLifetimeSeconds)
      || payload.expiresMonotonicSeconds
        - payload.approvedMonotonicSeconds !== wallLifetimeSeconds
      || payload.expiresMonotonicSeconds
        <= payload.approvedMonotonicSeconds) {
    fail('owner_authorization_monotonic_window_invalid');
  }
  if (currentBootIdSha256 !== null
      && currentBootIdSha256 !== payload.controllerBootIdSha256) {
    fail('owner_authorization_boot_changed');
  }
  if (currentMonotonicSeconds !== null) {
    assertInteger(
      currentMonotonicSeconds,
      0,
      Number.MAX_SAFE_INTEGER,
      'owner_authorization_current_monotonic_invalid',
    );
    if (currentMonotonicSeconds < payload.approvedMonotonicSeconds
        || (!allowExpired
          && currentMonotonicSeconds >= payload.expiresMonotonicSeconds)) {
      fail('owner_authorization_monotonic_expired');
    }
  }
  if (!allowExpired && expires < nowMs) fail('owner_authorization_expired');

  const signature = canonicalSignature(envelope.signature);
  let verified = false;
  try {
    verified = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      createPublicKey(guestOwnerPublicKeyPem),
      signature,
    );
  } catch {
    fail('owner_authorization_signature_verify_error');
  }
  if (!verified) fail('owner_authorization_signature_invalid');
  return envelope;
}

function validateMount(mount, index) {
  assertExactFields(mount, MOUNT_FIELDS, `mount_${index}`);
  if (typeof mount.target !== 'string' || !mount.target.startsWith('/')) fail('mount_target_invalid');
  if (typeof mount.source !== 'string' || mount.source.length === 0 || mount.source.length > 1024) {
    fail('mount_source_invalid');
  }
  if (typeof mount.fileSystemType !== 'string' || mount.fileSystemType.length === 0) {
    fail('mount_type_invalid');
  }
  assertArray(mount.options, 1, 64, 'mount_options_invalid');
  if (mount.options.some((option) => typeof option !== 'string' || option.length > 128)) {
    fail('mount_options_invalid');
  }
  const sharedTypes = new Set([
    '9p',
    'virtiofs',
    'nfs',
    'nfs4',
    'cifs',
    'smb3',
    'sshfs',
    'fuse.sshfs',
  ]);
  const source = mount.source.toLowerCase();
  if (sharedTypes.has(mount.fileSystemType.toLowerCase())
      || mount.options.some((option) => [
        'shared',
        'rshared',
        'slave',
        'rslave',
        'bind',
        'rbind',
      ].includes(option.toLowerCase()))
      || source.startsWith('host:')
      || source.includes('serverdominguez')
      || source.includes('/home/dominguez/telegram-hub-bot')
      || source.includes('/srv/nexus-release')) {
    fail('shared_or_production_mount_detected');
  }
}

function validateHypervisorDevice(device, index) {
  assertExactFields(device, DEVICE_FIELDS, `hypervisor_device_${index}`);
  if (!['disk', 'network', 'console'].includes(device.type)) {
    fail('hypervisor_shared_or_passthrough_device');
  }
  for (const field of ['source', 'target', 'mode']) {
    if (typeof device[field] !== 'string' || device[field].length > 1024) {
      fail('hypervisor_device_value_invalid');
    }
  }
  if (device.type === 'network' && !['nat', 'user'].includes(device.mode)) {
    fail('hypervisor_network_not_isolated');
  }
  if (device.type === 'disk'
      && (device.mode !== 'overlay'
        || !device.target.startsWith('vd')
        || device.source.includes('/home/dominguez/telegram-hub-bot')
        || device.source.includes('/home/dominguez/nexus-hub')
        || device.source.includes('/srv/nexus-release'))) {
    fail('hypervisor_disk_not_isolated_overlay');
  }
}

export function validateIsolationEvidence(evidence, plan, { nowMs = Date.now() } = {}) {
  validatePlan(plan, { nowMs, allowExpired: true });
  assertExactFields(evidence, ISOLATION_FIELDS, 'isolation');
  if (evidence.schema !== SCHEMAS.isolation) fail('isolation_schema_unsupported');
  if (evidence.planId !== plan.planId) fail('isolation_plan_id_mismatch');
  const captured = parseIso(evidence.capturedAt, 'isolation_captured_at_invalid');
  if (captured < Date.parse(plan.createdAt) - CLOCK_SKEW_MS
      || captured > nowMs + CLOCK_SKEW_MS) {
    fail('isolation_capture_time_invalid');
  }
  validateReadinessLedger(evidence.readinessLedger, plan);
  if (Date.parse(evidence.readinessLedger.completedAt) > captured) {
    fail('isolation_readiness_ledger_chronology_invalid');
  }

  assertExactFields(evidence.hypervisor, HYPERVISOR_FIELDS, 'hypervisor');
  if (evidence.hypervisor.machineIdSha256 !== plan.controller.machineIdSha256
      || evidence.hypervisor.bootIdSha256 !== plan.controller.bootIdSha256) {
    fail('hypervisor_controller_identity_mismatch');
  }
  if (evidence.hypervisor.virtualization !== 'qemu-kvm'
      || !['libvirt', 'qemu-systemd'].includes(evidence.hypervisor.manager)) {
    fail('qemu_kvm_manager_evidence_missing');
  }
  assertArray(evidence.hypervisor.devices, 2, 32, 'hypervisor_devices_invalid');
  evidence.hypervisor.devices.forEach(validateHypervisorDevice);
  if (!evidence.hypervisor.devices.some((device) => device.type === 'disk')
      || !evidence.hypervisor.devices.some(
        (device) => device.type === 'network' && ['nat', 'user'].includes(device.mode),
      )) {
    fail('hypervisor_required_devices_missing');
  }

  const guest = evidence.guest;
  assertExactFields(guest, ISOLATION_GUEST_FIELDS, 'isolation_guest');
  assertDigest(guest.machineIdSha256, 'guest_machine_id_invalid');
  assertDigest(guest.bootIdSha256, 'guest_boot_id_invalid');
  if (guest.machineIdSha256 === plan.controller.machineIdSha256) fail('host_machine_id_target_rejected');
  if (guest.bootIdSha256 === plan.controller.bootIdSha256) fail('host_boot_id_target_rejected');
  if (guest.machineIdSha256 === guest.bootIdSha256) fail('guest_identity_collapsed');
  if (guest.virtualization !== 'kvm'
      || guest.osId !== plan.guest.osId
      || guest.osVersionId !== plan.guest.osVersionId
      || guest.architecture !== plan.guest.architecture) {
    fail('guest_kvm_platform_evidence_missing');
  }
  assertInteger(
    guest.memoryAvailableBytes,
    plan.guest.minimumMemoryAvailableBytes,
    1024 * 1024 ** 3,
    'guest_memory_below_threshold',
  );
  assertInteger(
    guest.diskAvailableBytes,
    plan.guest.minimumDiskAvailableBytes,
    100 * 1024 ** 4,
    'guest_disk_below_threshold',
  );
  assertBoolean(guest.kernelLogReadable, true, 'guest_kernel_log_unreadable');

  assertArray(guest.mounts, 1, 256, 'guest_mounts_invalid');
  guest.mounts.forEach(validateMount);
  const rootMount = guest.mounts.find((mount) => mount.target === '/');
  if (!rootMount
      || !/^(?:\/dev\/(?:vd|sd|nvme)|\/dev\/mapper\/)/u.test(rootMount.source)
      || !['ext4', 'xfs'].includes(rootMount.fileSystemType)) {
    fail('guest_local_root_mount_missing');
  }

  assertArray(guest.listeners, 4, 64, 'guest_listeners_invalid');
  guest.listeners.forEach((listener) => {
    assertExactFields(listener, LISTENER_FIELDS, 'guest_listener');
    if (!LOOPBACKS.has(listener.host)) fail('guest_application_listener_not_loopback');
    assertInteger(listener.port, 1, 65535, 'guest_listener_port_invalid');
    if (typeof listener.process !== 'string' || listener.process.length > 64) {
      fail('guest_listener_process_invalid');
    }
  });
  for (const required of REQUIRED_LISTENERS) {
    if (!guest.listeners.some(
      (listener) => listener.process === required.process && listener.port === required.port,
    )) {
      fail(`guest_listener_missing:${required.process}`);
    }
  }

  assertArray(guest.pm2Apps, 4, 4, 'guest_pm2_apps_invalid');
  guest.pm2Apps.forEach((app, index) => {
    assertExactFields(app, PM2_FIELDS, 'guest_pm2_app');
    if (app.name !== REQUIRED_PM2_APPS[index] || app.status !== 'online') {
      fail('guest_pm2_app_not_online');
    }
    assertInteger(app.restartCount, 0, 1_000_000, 'guest_pm2_restart_count_invalid');
  });

  assertExactFields(guest.canonicalPaths, CANONICAL_PATH_FIELDS, 'guest_canonical_paths');
  for (const field of CANONICAL_PATH_FIELDS) {
    if (guest.canonicalPaths[field] !== plan.release[field]) {
      fail(`guest_canonical_path_mismatch:${field}`);
    }
  }
  assertExactFields(guest.keyIdentities, KEY_IDENTITY_FIELDS, 'guest_key_identities');
  const expectedKeyIdentities = {
    ownerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    sshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
    sshHostPublicKeySha256: plan.trust.guestSshHostPublicKeySha256s[0],
    releaseEvidencePublicKeySha256: plan.trust.releaseEvidencePublicKeySha256,
  };
  for (const [field, expected] of Object.entries(expectedKeyIdentities)) {
    if (guest.keyIdentities[field] !== expected) fail(`guest_key_identity_mismatch:${field}`);
  }

  assertExactFields(guest.syntheticDatabase, ISOLATION_DATABASE_FIELDS, 'isolation_database');
  for (const field of ['path', 'marker', 'seedSha256']) {
    if (guest.syntheticDatabase[field] !== plan.syntheticDatabase[field]) {
      fail(`synthetic_database_evidence_mismatch:${field}`);
    }
  }
  assertBoolean(guest.syntheticDatabase.syntheticOnly, true, 'isolation_database_not_synthetic');
  assertBoolean(
    guest.syntheticDatabase.productionRowsPresent,
    false,
    'isolation_database_contains_production_rows',
  );
  assertArray(guest.productionDataMatches, 0, 0, 'production_data_detected');

  assertArray(evidence.overlays, 3, 3, 'isolation_overlays_invalid');
  const overlayGuestMachineIds = [];
  const overlayGuestBootIds = [];
  evidence.overlays.forEach((overlay, index) => {
    assertExactFields(overlay, ISOLATION_OVERLAY_FIELDS, 'isolation_overlay');
    const expected = plan.overlays[index];
    for (const [actualField, expectedField] of [
      ['drill', 'drill'],
      ['overlayId', 'overlayId'],
      ['overlayInitialSha256', 'overlayInitialSha256'],
      ['baselineSnapshotSha256', 'baselineSnapshotSha256'],
      ['machineUuid', 'machineUuid'],
    ]) {
      if (overlay[actualField] !== expected[expectedField]) {
        fail(`isolation_overlay_mismatch:${actualField}`);
      }
    }
    if (overlay.sshHostPublicKeySha256 !== expected.ssh.hostPublicKeySha256) {
      fail('isolation_overlay_ssh_host_key_mismatch');
    }
    assertDigest(
      overlay.guestMachineIdSha256,
      'isolation_overlay_guest_machine_id_invalid',
    );
    assertDigest(
      overlay.readinessBootIdSha256,
      'isolation_overlay_readiness_boot_id_invalid',
    );
    if (overlay.guestMachineIdSha256 === plan.controller.machineIdSha256
        || overlay.readinessBootIdSha256 === plan.controller.bootIdSha256
        || overlay.guestMachineIdSha256 === overlay.readinessBootIdSha256) {
      fail('isolation_overlay_guest_identity_invalid');
    }
    overlayGuestMachineIds.push(overlay.guestMachineIdSha256);
    overlayGuestBootIds.push(overlay.readinessBootIdSha256);
  });
  unique(overlayGuestMachineIds, 'isolation_overlay_guest_machine_id_reuse');
  unique(overlayGuestBootIds, 'isolation_overlay_readiness_boot_id_reuse');
  if (evidence.guest.machineIdSha256 !== evidence.overlays[0].guestMachineIdSha256
      || evidence.guest.bootIdSha256 !== evidence.overlays[0].readinessBootIdSha256) {
    fail('isolation_representative_guest_identity_mismatch');
  }
  return evidence;
}

export function validateKeySet(plan, keys) {
  const expectedFields = [
    'guestOwnerPublicKeyPem',
    'productionOwnerPublicKeyPem',
    'guestSshClientPublicKey',
    'productionSshClientPublicKey',
    'guestSshHostPublicKeys',
    'productionSshHostPublicKey',
    'releaseEvidencePublicKeyPem',
  ];
  assertExactFields(keys, expectedFields, 'key_set');
  assertArray(
    keys.guestSshHostPublicKeys,
    3,
    3,
    'guest_ssh_host_public_keys_invalid',
  );
  const identities = {
    guestOwnerPublicKeySha256: publicKeyIdentity(keys.guestOwnerPublicKeyPem),
    productionOwnerPublicKeySha256: publicKeyIdentity(keys.productionOwnerPublicKeyPem),
    guestSshClientPublicKeySha256: textKeyIdentity(keys.guestSshClientPublicKey),
    productionSshClientPublicKeySha256: textKeyIdentity(keys.productionSshClientPublicKey),
    guestSshHostPublicKeySha256s:
      keys.guestSshHostPublicKeys.map((key) => textKeyIdentity(key)),
    productionSshHostPublicKeySha256: textKeyIdentity(keys.productionSshHostPublicKey),
    releaseEvidencePublicKeySha256: publicKeyIdentity(keys.releaseEvidencePublicKeyPem),
  };
  for (const [field, actual] of Object.entries(identities)) {
    if (canonicalJson(actual) !== canonicalJson(plan.trust[field])) {
      fail(`key_file_identity_mismatch:${field}`);
    }
  }
  if (keys.guestOwnerPublicKeyPem.trim() === keys.productionOwnerPublicKeyPem.trim()) {
    fail('production_owner_key_reuse');
  }
  if (normalizeSshEd25519PublicKey(keys.guestSshClientPublicKey)
      === normalizeSshEd25519PublicKey(keys.productionSshClientPublicKey)) {
    fail('production_ssh_client_key_reuse');
  }
  const normalizedGuestHostKeys = keys.guestSshHostPublicKeys.map(
    (key) => normalizeSshEd25519PublicKey(key),
  );
  unique(normalizedGuestHostKeys, 'guest_ssh_host_key_reuse');
  if (normalizedGuestHostKeys.includes(
    normalizeSshEd25519PublicKey(keys.productionSshHostPublicKey),
  )) {
    fail('production_ssh_host_key_reuse');
  }
  return identities;
}

function validateCompatibility(value, label, { requireTerminal = false } = {}) {
  assertExactFields(value, COMPATIBILITY_FIELDS, `${label}_compatibility`);
  if (value.schemaVersion !== SCHEMAS.compatibility || value.status !== 'passed') {
    fail(`${label}_compatibility_not_passing`);
  }
  assertBoolean(value.terminalLineageVerified, undefined, `${label}_terminal_lineage_invalid`);
  if (requireTerminal && value.terminalLineageVerified !== true) {
    fail(`${label}_terminal_lineage_not_verified`);
  }
  for (const field of [
    'appliedMigrationSetSha256',
    'runtimeMigrationSetSha256',
    'retiredMigrationSetSha256',
    'retiredMigrationPolicySha256',
    'identitySha256',
  ]) {
    assertDigest(value[field], `${label}_${field}_invalid`);
  }
  for (const field of [
    'databaseMaxMigration',
    'runtimeMaxMigration',
    'appliedMigrationCount',
    'runtimeMigrationCount',
    'canonicalAppliedMigrationCount',
    'retiredMigrationCount',
  ]) {
    assertInteger(value[field], 0, 100_000, `${label}_${field}_invalid`);
  }
  if (typeof value.migrationLineageId !== 'string'
      || value.migrationLineageId.length === 0
      || value.migrationLineageId.length > 256) {
    fail(`${label}_migrationLineageId_invalid`);
  }
  if (value.databaseMaxMigration > value.runtimeMaxMigration
      || value.canonicalAppliedMigrationCount > value.runtimeMigrationCount
      || (requireTerminal
        && value.canonicalAppliedMigrationCount !== value.runtimeMigrationCount)) {
    fail(`${label}_migration_counts_invalid`);
  }
}

function validateProcessIdentities(processIdentities, plan) {
  assertExactFields(processIdentities, PROCESS_IDENTITIES_FIELDS, 'process_identities');
  for (const name of PROCESS_IDENTITIES_FIELDS) {
    const identity = processIdentities[name];
    assertExactFields(identity, PROCESS_IDENTITY_FIELDS, `process_identity_${name}`);
    assertInteger(identity.pidNamespaceProcessId, 1, Number.MAX_SAFE_INTEGER, 'process_pid_invalid');
    const expectedRuntimePath = name === 'nodeBackend'
      ? 'dist/index.js'
      : 'content-engine/main.py';
    if (identity.runtimePath !== expectedRuntimePath) {
      fail('restore_process_runtime_path_not_isolated');
    }
    assertDigest(identity.runtimeSha256, 'restore_process_runtime_digest_invalid');
  }
}

export function validateRestoreEvidence(restore, plan, { nowMs = Date.now() } = {}) {
  validatePlan(plan, { nowMs, allowExpired: true });
  assertExactFields(restore, RESTORE_FIELDS, 'restore');
  if (restore.schemaVersion !== SCHEMAS.restore) fail('restore_schema_unsupported');
  for (const field of [
    'databaseKey',
    'releaseKey',
    'rpoEvidenceScope',
    'rpoEvidenceBasis',
    'technicalRestoreScope',
  ]) {
    if (typeof restore[field] !== 'string' || restore[field].length === 0
        || restore[field].length > 2048) {
      fail(`restore_${field}_invalid`);
    }
  }
  if (!restore.databaseKey.startsWith(`${plan.labStorage.prefix}/`)
      || !restore.releaseKey.startsWith(`${plan.labStorage.prefix}/`)) {
    fail('restore_object_outside_lab_prefix');
  }
  for (const field of [
    'databaseSha256',
    'releaseSha256',
    'releaseManifestSha256',
    'stagingAttestationSha256',
    'artifactDigest',
    'installedRuntimeDigest',
    'recoveryRuntimeDigest',
    'postMigrationDatabaseSha256',
  ]) {
    assertDigest(restore[field], `restore_${field}_invalid`);
  }
  assertFullSha(restore.runtimeSha, 'restore_runtime_sha_invalid');
  if (restore.runtimeSha !== plan.release.targetSha) fail('restore_target_sha_mismatch');
  for (const field of [
    'sqliteIntegrityVerified',
    'exactReleaseBundleVerified',
    'exactSignedRecoveryArtifactVerified',
    'relocatableInstalledTreeVerified',
    'networkIndependentDependenciesVerified',
    'dependencyInstallNetworkNamespaceVerified',
    'recoveryRuntimeVerificationUnprivileged',
    'recoveryRuntimeVerificationNetworkNamespaceVerified',
    'postMigrationSqliteIntegrityVerified',
    'postMigrationWalStateCapturedByOnlineBackup',
    'isolatedBootVerified',
    'isolatedNetworkNamespaceVerified',
    'invalidCredentialRejected',
    'representativeRestoredDatabaseReadVerified',
    'nodeBackendBootVerified',
    'contentEngineBootVerified',
    'contentEngineHealthVerified',
    'applicationSmokeHarnessVerified',
  ]) {
    assertBoolean(restore[field], true, `restore_proof_missing:${field}`);
  }
  assertBoolean(
    restore.rpoSignedProvenanceVerified,
    false,
    'restore_rpo_provenance_contract_changed',
  );
  validateCompatibility(restore.preMigrationReleaseDatabaseCompatibility, 'pre_migration');
  validateCompatibility(
    restore.postMigrationReleaseDatabaseCompatibility,
    'post_migration',
    { requireTerminal: true },
  );
  validateCompatibility(
    restore.releaseDatabaseCompatibility,
    'release_database',
    { requireTerminal: true },
  );
  if (canonicalJson(restore.releaseDatabaseCompatibility)
      !== canonicalJson(restore.postMigrationReleaseDatabaseCompatibility)) {
    fail('restore_release_compatibility_mismatch');
  }
  validateProcessIdentities(restore.processIdentities, plan);
  assertInteger(restore.rpoSeconds, 0, 3600, 'restore_rpo_target_missed');
  if (restore.rpoTargetSeconds !== 3600) fail('restore_rpo_target_invalid');
  assertInteger(
    restore.technicalRestoreSeconds,
    0,
    1800,
    'restore_technical_recovery_target_missed',
  );
  if (restore.technicalRestoreTargetSeconds !== 1800) {
    fail('restore_technical_recovery_target_invalid');
  }
  if (restore.rpoEvidenceScope
      !== 'selected-database-object-storage-timestamp-consistency'
      || restore.rpoEvidenceBasis !== 'oldest-of-key-created-epoch-and-s3-last-modified'
      || restore.technicalRestoreScope
        !== 'selected-object-download-through-isolated-application-smoke') {
    fail('restore_measurement_scope_invalid');
  }

  assertExactFields(
    restore.databaseTimestampEvidence,
    TIMESTAMP_EVIDENCE_FIELDS,
    'restore_database_timestamp_evidence',
  );
  for (const field of TIMESTAMP_EVIDENCE_FIELDS) {
    assertInteger(
      restore.databaseTimestampEvidence[field],
      1,
      Number.MAX_SAFE_INTEGER,
      `restore_timestamp_invalid:${field}`,
    );
  }
  const conservative = Math.min(
    restore.databaseTimestampEvidence.metadataCreatedEpoch,
    restore.databaseTimestampEvidence.keyTimestampEpoch,
    restore.databaseTimestampEvidence.s3LastModifiedEpoch,
  );
  if (restore.databaseTimestampEvidence.conservativeEpoch !== conservative) {
    fail('restore_conservative_timestamp_invalid');
  }

  assertExactFields(
    restore.objectVersionEvidence,
    OBJECT_VERSION_FIELDS,
    'restore_object_version_evidence',
  );
  const expectedStorageProvider = plan.labStorage.provider === 'aws-s3-lab'
    ? 'aws-s3'
    : plan.labStorage.provider;
  if (restore.objectVersionEvidence.provider !== expectedStorageProvider) {
    fail('restore_storage_provider_mismatch');
  }
  const awsVersioned = plan.labStorage.provider === 'aws-s3-lab';
  assertBoolean(
    restore.objectVersionEvidence.exactVersionDownloadVerified,
    awsVersioned,
    'restore_exact_version_proof_invalid',
  );
  assertBoolean(
    restore.objectVersionEvidence.approvedUnversionedVariance,
    !awsVersioned,
    'restore_unversioned_variance_invalid',
  );
  for (const field of ['databaseVersionId', 'releaseVersionId']) {
    const value = restore.objectVersionEvidence[field];
    if (awsVersioned) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
        fail(`restore_${field}_invalid`);
      }
    } else if (value !== null) {
      fail(`restore_${field}_invalid`);
    }
  }

  const completed = parseIso(restore.completedAt, 'restore_completed_at_invalid');
  if (completed < Date.parse(plan.createdAt) - CLOCK_SKEW_MS
      || completed > nowMs + CLOCK_SKEW_MS) {
    fail('restore_completion_time_invalid');
  }
  return restore;
}

function timelineIndex(outcome, event) {
  return outcome.timeline.findIndex((entry) => entry.event === event);
}

export function validateDrillOutcome(
  outcome,
  plan,
  isolation,
  { nowMs = Date.now(), allowUnboundExecution = false } = {},
) {
  validatePlan(plan, { nowMs, allowExpired: true });
  validateIsolationEvidence(isolation, plan, { nowMs });
  assertExactFields(outcome, DRILL_FIELDS, 'drill_outcome');
  if (outcome.schema !== SCHEMAS.drill) fail('drill_outcome_schema_unsupported');
  if (outcome.planId !== plan.planId) fail('drill_outcome_plan_id_mismatch');
  if (outcome.executionMode !== EXECUTION_MODE) fail('drill_execution_mode_invalid');
  assertBoolean(outcome.testMode, undefined, 'drill_test_mode_invalid');
  if (allowUnboundExecution && outcome.executionReceiptSha256 === null) {
    // The coordinator validates the measured outcome before it has enough
    // information to build the ordered execution receipt. Collection never
    // permits this provisional state.
  } else {
    assertDigest(outcome.executionReceiptSha256, 'drill_execution_receipt_digest_invalid');
  }
  if (!DRILL_NAMES.includes(outcome.drill)) fail('drill_name_invalid');
  const overlay = plan.overlays.find((entry) => entry.drill === outcome.drill);
  if (!overlay || outcome.overlayId !== overlay.overlayId) fail('drill_overlay_mismatch');
  assertString(outcome.transactionId, TRANSACTION_ID, 'drill_transaction_id_invalid');
  assertDigest(outcome.requestSha256, 'drill_request_digest_invalid');
  if (outcome.controlVersion !== INTERFACE_VALUES.controlVersion) {
    fail('drill_control_version_invalid');
  }
  if (!['completed', 'recovered'].includes(outcome.terminalStatus)) {
    fail('drill_terminal_status_invalid');
  }
  assertBoolean(outcome.secondLaunchObserved, false, 'drill_second_launch_observed');
  assertBoolean(
    outcome.productionEvidenceEmitted,
    false,
    'drill_production_evidence_emitted',
  );
  assertBoolean(outcome.exactTargetHealthy, undefined, 'drill_target_health_invalid');
  assertBoolean(
    outcome.exactPredecessorRestored,
    undefined,
    'drill_predecessor_restore_invalid',
  );
  assertBoolean(
    outcome.databaseBackupRestored,
    undefined,
    'drill_database_restore_invalid',
  );
  assertDigest(outcome.journalSha256, 'drill_journal_digest_invalid');
  assertDigest(outcome.recoveryResultSha256, 'drill_recovery_result_digest_invalid');
  if (outcome.drill === 'guest-reboot') {
    assertExactFields(
      outcome.postTerminalReboot,
      POST_TERMINAL_REBOOT_FIELDS,
      'post_terminal_reboot',
    );
    assertDigest(
      outcome.postTerminalReboot.beforeGuestBootIdSha256,
      'post_terminal_reboot_before_boot_id_invalid',
    );
    assertDigest(
      outcome.postTerminalReboot.afterGuestBootIdSha256,
      'post_terminal_reboot_after_boot_id_invalid',
    );
    assertDigest(
      outcome.postTerminalReboot.journalSha256,
      'post_terminal_reboot_journal_digest_invalid',
    );
    if (outcome.postTerminalReboot.beforeGuestBootIdSha256
          === outcome.postTerminalReboot.afterGuestBootIdSha256) {
      fail('post_terminal_reboot_boot_id_unchanged');
    }
    if (outcome.postTerminalReboot.journalSha256 !== outcome.journalSha256) {
      fail('post_terminal_reboot_journal_changed');
    }
    if (outcome.postTerminalReboot.controlVersion !== INTERFACE_VALUES.controlVersion
        || outcome.postTerminalReboot.recoveryUnitResult !== 'success') {
      fail('post_terminal_reboot_control_invalid');
    }
    assertBoolean(
      outcome.postTerminalReboot.assertRootPm2Ready,
      true,
      'post_terminal_reboot_root_pm2_not_ready',
    );
    assertBoolean(
      outcome.postTerminalReboot.assertIdle,
      true,
      'post_terminal_reboot_not_idle',
    );
    assertBoolean(
      outcome.postTerminalReboot.exactRuntimeHealthy,
      true,
      'post_terminal_reboot_runtime_unhealthy',
    );
  } else if (outcome.postTerminalReboot !== null) {
    fail('unexpected_post_terminal_reboot');
  }

  if (outcome.drill === 'ssh-loss') {
    const targetCompleted = outcome.terminalStatus === 'completed'
      && outcome.exactTargetHealthy === true
      && outcome.exactPredecessorRestored === false
      && outcome.databaseBackupRestored === false;
    const predecessorRecovered = outcome.terminalStatus === 'recovered'
      && outcome.exactTargetHealthy === false
      && outcome.exactPredecessorRestored === true
      && outcome.databaseBackupRestored === true;
    if (!targetCompleted && !predecessorRecovered) fail('ssh_loss_terminal_contract_invalid');
  } else if (outcome.terminalStatus !== 'recovered'
      || outcome.exactTargetHealthy !== false
      || outcome.exactPredecessorRestored !== true
      || outcome.databaseBackupRestored !== true) {
    fail('rollback_terminal_contract_invalid');
  }

  const expectedEvents = TIMELINE_EVENTS[outcome.drill];
  const isolationOverlay = isolation.overlays.find(
    (entry) => entry.overlayId === outcome.overlayId,
  );
  if (!isolationOverlay) fail('drill_isolation_overlay_missing');
  assertArray(outcome.timeline, expectedEvents.length, expectedEvents.length, 'drill_timeline_invalid');
  let priorObserved = 0;
  let priorMonotonic = -1;
  let observerBootId = '';
  let guestBootId = '';
  outcome.timeline.forEach((entry, index) => {
    assertExactFields(entry, TIMELINE_FIELDS, 'drill_timeline_entry');
    if (entry.event !== expectedEvents[index]) fail('drill_timeline_sequence_invalid');
    const observed = parseIso(entry.observedAt, 'drill_timeline_timestamp_invalid');
    assertInteger(
      entry.observerMonotonicMs,
      0,
      Number.MAX_SAFE_INTEGER,
      'drill_observer_monotonic_invalid',
    );
    assertDigest(entry.observerBootIdSha256, 'drill_observer_boot_id_invalid');
    assertDigest(entry.guestBootIdSha256, 'drill_guest_boot_id_invalid');
    if (observed < priorObserved || entry.observerMonotonicMs <= priorMonotonic) {
      fail('drill_timeline_not_monotonic');
    }
    if (observed > nowMs + CLOCK_SKEW_MS) fail('drill_timeline_in_future');
    if (index === 0) {
      observerBootId = entry.observerBootIdSha256;
      guestBootId = entry.guestBootIdSha256;
      if (observerBootId !== plan.controller.bootIdSha256
          || guestBootId === plan.controller.bootIdSha256
          || guestBootId === isolationOverlay.guestMachineIdSha256) {
        fail('drill_initial_boot_identity_mismatch');
      }
    } else if (entry.observerBootIdSha256 !== observerBootId) {
      fail('drill_observer_rebooted');
    }
    priorObserved = observed;
    priorMonotonic = entry.observerMonotonicMs;
  });

  if (outcome.drill === 'guest-reboot') {
    const bootedIndex = timelineIndex(outcome, 'guest_booted');
    const newBootId = outcome.timeline[bootedIndex].guestBootIdSha256;
    if (newBootId === guestBootId) fail('guest_reboot_boot_id_unchanged');
    for (let index = 0; index < outcome.timeline.length; index += 1) {
      const expectedBoot = index < bootedIndex ? guestBootId : newBootId;
      if (outcome.timeline[index].guestBootIdSha256 !== expectedBoot) {
        fail('guest_reboot_boot_id_transition_invalid');
      }
    }
    if (outcome.postTerminalReboot.beforeGuestBootIdSha256 !== newBootId
        || outcome.postTerminalReboot.afterGuestBootIdSha256 === newBootId
        || outcome.postTerminalReboot.afterGuestBootIdSha256 === guestBootId) {
      fail('post_terminal_reboot_boot_id_transition_invalid');
    }
  } else if (outcome.timeline.some((entry) => entry.guestBootIdSha256 !== guestBootId)) {
    fail('unexpected_guest_boot_id_change');
  }

  const stopped = outcome.timeline[timelineIndex(outcome, 'predecessor_stopped')];
  const healthy = outcome.timeline[timelineIndex(outcome, 'service_healthy')];
  const recoveryMilliseconds = healthy.observerMonotonicMs - stopped.observerMonotonicMs;
  if (recoveryMilliseconds < 0 || recoveryMilliseconds > MAX_RECOVERY_MS) {
    fail('drill_recovery_time_target_missed');
  }
  return {
    outcome,
    recoveryMilliseconds,
    completedAt: outcome.timeline.at(-1).observedAt,
  };
}

function safeParentForNewOutput(outputDir) {
  const requested = path.resolve(outputDir);
  const requestedParent = path.dirname(requested);
  let stat;
  try {
    stat = fs.lstatSync(requestedParent);
  } catch {
    fail('bundle_output_parent_missing');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('bundle_output_parent_unsafe');
  }
  const parent = fs.realpathSync(requestedParent);
  const resolved = path.join(parent, path.basename(requested));
  if (fs.existsSync(requested) || fs.existsSync(resolved)) {
    fail('bundle_output_exists');
  }
  return { resolved, parent };
}

function readBoundedFile(file, label, maximum = MAX_JSON_BYTES) {
  const resolved = path.resolve(file);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label}_missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`${label}_unsafe`);
  }
  if (stat.size <= 0 || stat.size > maximum) fail(`${label}_size_invalid`);
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== stat.size) fail(`${label}_changed_during_read`);
  return bytes;
}

export function readBoundedText(file, label = 'input', maximum = MAX_JSON_BYTES) {
  const bytes = readBoundedFile(file, label, maximum);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label}_utf8_invalid`);
  }
  return text;
}

export function readBoundedJson(file, label = 'input') {
  const text = readBoundedText(file, label);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label}_json_invalid`);
  }
}

function executionOutcomePayload(outcome) {
  const payload = { ...outcome };
  delete payload.executionReceiptSha256;
  return payload;
}

export function buildExecutionReceipt(
  plan,
  isolation,
  outcomes,
  {
    testMode,
    completedAt,
  },
) {
  assertExactFields(outcomes, DRILL_NAMES, 'execution_outcomes');
  validateIsolationEvidence(isolation, plan, {
    nowMs: Math.max(Date.now(), Date.parse(isolation.capturedAt)),
  });
  const readinessLedger = isolation.readinessLedger;
  const receipt = {
    schema: SCHEMAS.execution,
    planId: plan.planId,
    planSha256: sha256Json(plan),
    readinessLedgerSha256: sha256Json(readinessLedger),
    generationManifestSha256:
      readinessLedger.generationManifestSha256,
    provisionReceiptSha256:
      readinessLedger.provisionReceiptSha256,
    orderedReadinessSha256s:
      readinessLedger.orderedReadiness.map((entry) => entry.readinessSha256),
    guestSshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
    executionMode: EXECUTION_MODE,
    maximumActiveGuests: 1,
    testMode,
    outcomes: DRILL_NAMES.map((drill) => ({
      drill,
      path: `${drill}.json`,
      payloadSha256: sha256Json(executionOutcomePayload(outcomes[drill])),
    })),
    completedAt,
  };
  return receipt;
}

export function bindExecutionReceipt(execution, outcomes) {
  const executionReceiptSha256 = sha256Bytes(canonicalJsonBuffer(execution));
  return Object.fromEntries(DRILL_NAMES.map((drill) => [
    drill,
    {
      ...outcomes[drill],
      executionReceiptSha256,
    },
  ]));
}

export function validateExecutionReceipt(
  execution,
  plan,
  isolation,
  outcomes,
  {
    nowMs = Date.now(),
    allowTestMode = false,
  } = {},
) {
  assertExactFields(execution, EXECUTION_FIELDS, 'execution_receipt');
  if (execution.schema !== SCHEMAS.execution) fail('execution_receipt_schema_unsupported');
  if (execution.planId !== plan.planId || execution.planSha256 !== sha256Json(plan)) {
    fail('execution_receipt_plan_mismatch');
  }
  validateReadinessLedger(isolation.readinessLedger, plan);
  if (execution.readinessLedgerSha256
        !== sha256Json(isolation.readinessLedger)
      || execution.generationManifestSha256
        !== isolation.readinessLedger.generationManifestSha256
      || execution.provisionReceiptSha256
        !== isolation.readinessLedger.provisionReceiptSha256
      || canonicalJson(execution.orderedReadinessSha256s)
        !== canonicalJson(
          isolation.readinessLedger.orderedReadiness.map(
            (entry) => entry.readinessSha256,
          ),
        )) {
    fail('execution_receipt_readiness_ledger_mismatch');
  }
  for (const field of [
    'readinessLedgerSha256',
    'generationManifestSha256',
    'provisionReceiptSha256',
  ]) {
    assertDigest(
      execution[field],
      `execution_receipt_${field}_invalid`,
    );
  }
  if (execution.guestSshClientPublicKeySha256
      !== plan.trust.guestSshClientPublicKeySha256) {
    fail('execution_receipt_ssh_client_key_mismatch');
  }
  if (execution.executionMode !== EXECUTION_MODE || execution.maximumActiveGuests !== 1) {
    fail('execution_receipt_mode_invalid');
  }
  assertBoolean(execution.testMode, undefined, 'execution_receipt_test_mode_invalid');
  if (!allowTestMode && execution.testMode !== false) {
    fail('execution_receipt_test_mode_rejected');
  }
  assertArray(
    execution.outcomes,
    DRILL_NAMES.length,
    DRILL_NAMES.length,
    'execution_receipt_outcomes_invalid',
  );
  assertExactFields(outcomes, DRILL_NAMES, 'execution_outcomes');
  const receiptSha256 = sha256Bytes(canonicalJsonBuffer(execution));
  let latestOutcome = 0;
  execution.outcomes.forEach((record, index) => {
    assertExactFields(record, EXECUTION_OUTCOME_FIELDS, 'execution_receipt_outcome');
    const drill = DRILL_NAMES[index];
    if (record.drill !== drill || record.path !== `${drill}.json`) {
      fail('execution_receipt_outcome_order_invalid');
    }
    assertDigest(record.payloadSha256, 'execution_receipt_outcome_digest_invalid');
    const outcome = outcomes[drill];
    if (record.payloadSha256 !== sha256Json(executionOutcomePayload(outcome))) {
      fail(`execution_receipt_outcome_mismatch:${drill}`);
    }
    if (outcome.executionMode !== execution.executionMode
        || outcome.testMode !== execution.testMode
        || outcome.executionReceiptSha256 !== receiptSha256) {
      fail(`execution_receipt_binding_mismatch:${drill}`);
    }
    latestOutcome = Math.max(
      latestOutcome,
      parseIso(outcome.timeline.at(-1)?.observedAt, 'execution_outcome_completed_at_invalid'),
    );
  });
  const completed = parseIso(execution.completedAt, 'execution_receipt_completed_at_invalid');
  if (completed < latestOutcome || completed > nowMs + CLOCK_SKEW_MS) {
    fail('execution_receipt_completion_time_invalid');
  }
  return execution;
}

function canonicalSources({
  plan,
  authorization,
  isolation,
  execution,
  restore,
  outcomes,
}) {
  const sources = new Map([
    ['plan.json', canonicalJsonBuffer(plan)],
    ['owner-authorization.json', canonicalJsonBuffer(authorization)],
    ['isolation.json', canonicalJsonBuffer(isolation)],
    [
      'readiness-ledger.json',
      canonicalJsonBuffer(isolation.readinessLedger),
    ],
    ['execution.json', canonicalJsonBuffer(execution)],
    ['restore.json', canonicalJsonBuffer(restore)],
  ]);
  for (const drill of DRILL_NAMES) {
    sources.set(`drills/${drill}.json`, canonicalJsonBuffer(outcomes[drill]));
  }
  return sources;
}

function fileRecords(sources) {
  return [...sources.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, bytes]) => ({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
    }));
}

function validatedComponents(
  {
    plan,
    authorization,
    isolation,
    execution,
    restore,
    outcomes,
    keys,
  },
  {
    nowMs = Date.now(),
    allowExpired = false,
  } = {},
) {
  validatePlan(plan, { nowMs, allowExpired });
  validateKeySet(plan, keys);
  validateOwnerAuthorization(
    authorization,
    plan,
    keys.guestOwnerPublicKeyPem,
    { nowMs, allowExpired, isolation },
  );
  validateIsolationEvidence(isolation, plan, { nowMs });
  validateRestoreEvidence(restore, plan, { nowMs });
  assertExactFields(outcomes, DRILL_NAMES, 'drill_outcomes');
  const validatedOutcomes = {};
  for (const drill of DRILL_NAMES) {
    if (outcomes[drill]?.drill !== drill) fail(`drill_outcome_slot_mismatch:${drill}`);
    validatedOutcomes[drill] = validateDrillOutcome(
      outcomes[drill],
      plan,
      isolation,
      { nowMs },
    );
  }
  unique(
    DRILL_NAMES.map((drill) => outcomes[drill].transactionId),
    'drill_transaction_reuse',
  );
  unique(
    DRILL_NAMES.map((drill) => outcomes[drill].requestSha256),
    'drill_request_reuse',
  );
  unique(
    DRILL_NAMES.map((drill) => outcomes[drill].timeline[0].guestBootIdSha256),
    'drill_initial_guest_boot_id_reuse',
  );
  validateExecutionReceipt(execution, plan, isolation, outcomes, { nowMs });
  return validatedOutcomes;
}

function buildManifest(
  {
    plan,
    authorization,
    isolation,
    execution,
    restore,
    outcomes,
  },
  validatedOutcomes,
) {
  const sources = canonicalSources({
    plan,
    authorization,
    isolation,
    execution,
    restore,
    outcomes,
  });
  const candidateTimes = [
    isolation.capturedAt,
    restore.completedAt,
    ...DRILL_NAMES.map((drill) => validatedOutcomes[drill].completedAt),
  ];
  const collectedAt = candidateTimes
    .map((value) => ({ value, time: Date.parse(value) }))
    .sort((left, right) => left.time - right.time)
    .at(-1).value;
  const manifest = {
    schema: SCHEMAS.manifest,
    planId: plan.planId,
    collectedAt,
    sourceRootSha: plan.sourceRootSha,
    targetSha: plan.release.targetSha,
    targetVersion: plan.release.targetVersion,
    planSha256: sha256Json(plan),
    authorizationSha256: sha256Json(authorization),
    isolationSha256: sha256Json(isolation),
    readiness: {
      schema: isolation.readinessLedger.schema,
      sequenceId: isolation.readinessLedger.sequenceId,
      ledgerSha256: sha256Json(isolation.readinessLedger),
      generationManifestSha256:
        isolation.readinessLedger.generationManifestSha256,
      provisionReceiptSha256:
        isolation.readinessLedger.provisionReceiptSha256,
      orderedReadinessSha256s:
        isolation.readinessLedger.orderedReadiness.map(
          (entry) => entry.readinessSha256,
        ),
    },
    execution: {
      schema: execution.schema,
      executionMode: execution.executionMode,
      maximumActiveGuests: execution.maximumActiveGuests,
      testMode: execution.testMode,
      guestSshClientPublicKeySha256: execution.guestSshClientPublicKeySha256,
      readinessLedgerSha256: execution.readinessLedgerSha256,
      generationManifestSha256:
        execution.generationManifestSha256,
      provisionReceiptSha256: execution.provisionReceiptSha256,
      orderedReadinessSha256s:
        execution.orderedReadinessSha256s,
      receiptSha256: sha256Bytes(canonicalJsonBuffer(execution)),
      completedAt: execution.completedAt,
    },
    restore: {
      schemaVersion: restore.schemaVersion,
      targetBackup: plan.release.targetBackup,
      targetBackupSha256: restore.releaseSha256,
      databaseSha256: restore.databaseSha256,
      postMigrationDatabaseSha256: restore.postMigrationDatabaseSha256,
      databaseIntegrity: 'ok',
      backupContainsDatabase: true,
      healthCheck: 'passed',
      rpoSeconds: restore.rpoSeconds,
      technicalRestoreSeconds: restore.technicalRestoreSeconds,
      completedAt: restore.completedAt,
    },
    drills: DRILL_NAMES.map((drill) => ({
      drill,
      overlayId: outcomes[drill].overlayId,
      terminalStatus: outcomes[drill].terminalStatus,
      recoveryMilliseconds: validatedOutcomes[drill].recoveryMilliseconds,
      completedAt: validatedOutcomes[drill].completedAt,
      outcomeSha256: sha256Json(outcomes[drill]),
    })),
    files: fileRecords(sources),
  };
  validateManifestShape(manifest);
  return { manifest, sources };
}

function validateManifestShape(manifest) {
  assertExactFields(manifest, MANIFEST_FIELDS, 'manifest');
  if (manifest.schema !== SCHEMAS.manifest) fail('manifest_schema_unsupported');
  assertString(manifest.planId, PLAN_ID, 'manifest_plan_id_invalid');
  parseIso(manifest.collectedAt, 'manifest_collected_at_invalid');
  assertFullSha(manifest.sourceRootSha, 'manifest_source_root_sha_invalid');
  assertFullSha(manifest.targetSha, 'manifest_target_sha_invalid');
  assertString(manifest.targetVersion, VERSION, 'manifest_target_version_invalid');
  for (const field of ['planSha256', 'authorizationSha256', 'isolationSha256']) {
    assertDigest(manifest[field], `manifest_${field}_invalid`);
  }
  assertExactFields(
    manifest.readiness,
    MANIFEST_READINESS_FIELDS,
    'manifest_readiness',
  );
  if (manifest.readiness.schema !== SCHEMAS.readinessLedger) {
    fail('manifest_readiness_schema_invalid');
  }
  for (const field of [
    'sequenceId',
    'ledgerSha256',
    'generationManifestSha256',
    'provisionReceiptSha256',
  ]) {
    assertDigest(
      manifest.readiness[field],
      `manifest_readiness_${field}_invalid`,
    );
  }
  assertArray(
    manifest.readiness.orderedReadinessSha256s,
    DRILL_NAMES.length,
    DRILL_NAMES.length,
    'manifest_readiness_digests_invalid',
  );
  manifest.readiness.orderedReadinessSha256s.forEach((digest) => {
    assertDigest(digest, 'manifest_readiness_digest_invalid');
  });
  assertExactFields(manifest.execution, MANIFEST_EXECUTION_FIELDS, 'manifest_execution');
  if (manifest.execution.schema !== SCHEMAS.execution
      || manifest.execution.executionMode !== EXECUTION_MODE
      || manifest.execution.maximumActiveGuests !== 1
      || manifest.execution.testMode !== false) {
    fail('manifest_execution_invalid');
  }
  assertDigest(manifest.execution.receiptSha256, 'manifest_execution_receipt_digest_invalid');
  assertDigest(
    manifest.execution.guestSshClientPublicKeySha256,
    'manifest_execution_ssh_client_key_digest_invalid',
  );
  for (const field of [
    'readinessLedgerSha256',
    'generationManifestSha256',
    'provisionReceiptSha256',
  ]) {
    assertDigest(
      manifest.execution[field],
      `manifest_execution_${field}_invalid`,
    );
  }
  assertArray(
    manifest.execution.orderedReadinessSha256s,
    DRILL_NAMES.length,
    DRILL_NAMES.length,
    'manifest_execution_readiness_digests_invalid',
  );
  manifest.execution.orderedReadinessSha256s.forEach((digest) => {
    assertDigest(digest, 'manifest_execution_readiness_digest_invalid');
  });
  parseIso(manifest.execution.completedAt, 'manifest_execution_completed_at_invalid');
  assertExactFields(manifest.restore, MANIFEST_RESTORE_FIELDS, 'manifest_restore');
  if (manifest.restore.schemaVersion !== SCHEMAS.restore) fail('manifest_restore_schema_invalid');
  assertString(manifest.restore.targetBackup, SAFE_BACKUP, 'manifest_target_backup_invalid');
  for (const field of [
    'targetBackupSha256',
    'databaseSha256',
    'postMigrationDatabaseSha256',
  ]) {
    assertDigest(manifest.restore[field], `manifest_restore_${field}_invalid`);
  }
  if (manifest.restore.databaseIntegrity !== 'ok'
      || manifest.restore.backupContainsDatabase !== true
      || manifest.restore.healthCheck !== 'passed') {
    fail('manifest_restore_result_invalid');
  }
  assertInteger(manifest.restore.rpoSeconds, 0, 3600, 'manifest_rpo_invalid');
  assertInteger(
    manifest.restore.technicalRestoreSeconds,
    0,
    1800,
    'manifest_restore_seconds_invalid',
  );
  parseIso(manifest.restore.completedAt, 'manifest_restore_completed_at_invalid');

  assertArray(manifest.drills, 3, 3, 'manifest_drills_invalid');
  manifest.drills.forEach((drill, index) => {
    assertExactFields(drill, MANIFEST_DRILL_FIELDS, 'manifest_drill');
    if (drill.drill !== DRILL_NAMES[index]) fail('manifest_drill_order_invalid');
    assertString(drill.overlayId, OVERLAY_ID, 'manifest_overlay_id_invalid');
    if (!['completed', 'recovered'].includes(drill.terminalStatus)) {
      fail('manifest_terminal_status_invalid');
    }
    assertInteger(drill.recoveryMilliseconds, 0, MAX_RECOVERY_MS, 'manifest_recovery_time_invalid');
    parseIso(drill.completedAt, 'manifest_drill_completed_at_invalid');
    assertDigest(drill.outcomeSha256, 'manifest_outcome_digest_invalid');
  });
  assertArray(manifest.files, 9, 9, 'manifest_files_invalid');
  const paths = [];
  let total = 0;
  for (const record of manifest.files) {
    assertExactFields(record, FILE_RECORD_FIELDS, 'manifest_file');
    if (![
      'plan.json',
      'owner-authorization.json',
      'isolation.json',
      'readiness-ledger.json',
      'execution.json',
      'restore.json',
      ...DRILL_NAMES.map((drill) => `drills/${drill}.json`),
    ].includes(record.path)) {
      fail('manifest_file_path_invalid');
    }
    assertInteger(record.bytes, 1, MAX_JSON_BYTES, 'manifest_file_size_invalid');
    assertDigest(record.sha256, 'manifest_file_digest_invalid');
    paths.push(record.path);
    total += record.bytes;
  }
  unique(paths, 'manifest_file_path_duplicate');
  if (total > MAX_BUNDLE_BYTES) fail('manifest_bundle_too_large');
  return manifest;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeExclusiveFile(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function removeOwnedTemporaryBundle(directory) {
  if (!directory || !path.basename(directory).startsWith('.nexus-kvm-evidence.next.')) return;
  fs.rmSync(directory, { recursive: true, force: true });
}

export function collectBundle(
  inputs,
  outputDir,
  { nowMs = Date.now() } = {},
) {
  const validatedOutcomes = validatedComponents(inputs, { nowMs, allowExpired: false });
  const { manifest, sources } = buildManifest(inputs, validatedOutcomes);
  const { resolved, parent } = safeParentForNewOutput(outputDir);
  const temporary = fs.mkdtempSync(path.join(parent, '.nexus-kvm-evidence.next.'));
  fs.chmodSync(temporary, 0o700);
  try {
    const drillsDir = path.join(temporary, 'drills');
    fs.mkdirSync(drillsDir, { mode: 0o700 });
    for (const [relativePath, bytes] of sources.entries()) {
      writeExclusiveFile(path.join(temporary, relativePath), bytes);
    }
    writeExclusiveFile(path.join(temporary, 'manifest.json'), canonicalJsonBuffer(manifest));
    fsyncDirectory(drillsDir);
    fsyncDirectory(temporary);
    if (fs.existsSync(resolved)) fail('bundle_output_exists');
    fs.renameSync(temporary, resolved);
    fsyncDirectory(parent);
  } catch (error) {
    removeOwnedTemporaryBundle(temporary);
    throw error;
  }
  return {
    bundlePath: resolved,
    manifest,
    machineEvidenceSha256: sha256Json(manifest),
  };
}

function assertExactBundleLayout(bundleDir) {
  const requested = path.resolve(bundleDir);
  const stat = fs.lstatSync(requested, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('bundle_directory_unsafe');
  }
  const resolved = fs.realpathSync(requested);
  const rootEntries = fs.readdirSync(resolved).sort();
  const expectedRoot = [
    'drills',
    'execution.json',
    'isolation.json',
    'manifest.json',
    'owner-authorization.json',
    'plan.json',
    'readiness-ledger.json',
    'restore.json',
  ].sort();
  if (rootEntries.length !== expectedRoot.length
      || rootEntries.some((entry, index) => entry !== expectedRoot[index])) {
    fail('bundle_layout_invalid');
  }
  const drillsDir = path.join(resolved, 'drills');
  const drillsStat = fs.lstatSync(drillsDir);
  if (!drillsStat.isDirectory() || drillsStat.isSymbolicLink()) fail('bundle_drills_directory_unsafe');
  const drillEntries = fs.readdirSync(drillsDir).sort();
  const expectedDrills = DRILL_NAMES.map((drill) => `${drill}.json`).sort();
  if (drillEntries.length !== expectedDrills.length
      || drillEntries.some((entry, index) => entry !== expectedDrills[index])) {
    fail('bundle_drills_layout_invalid');
  }
  return resolved;
}

function readBundleComponents(bundleDir) {
  const resolved = assertExactBundleLayout(bundleDir);
  const plan = readBoundedJson(path.join(resolved, 'plan.json'), 'bundle_plan');
  const authorization = readBoundedJson(
    path.join(resolved, 'owner-authorization.json'),
    'bundle_authorization',
  );
  const isolation = readBoundedJson(path.join(resolved, 'isolation.json'), 'bundle_isolation');
  const readinessLedger = readBoundedJson(
    path.join(resolved, 'readiness-ledger.json'),
    'bundle_readiness_ledger',
  );
  if (canonicalJson(readinessLedger)
      !== canonicalJson(isolation.readinessLedger)) {
    fail('bundle_readiness_ledger_mismatch');
  }
  const execution = readBoundedJson(path.join(resolved, 'execution.json'), 'bundle_execution');
  const restore = readBoundedJson(path.join(resolved, 'restore.json'), 'bundle_restore');
  const outcomes = {};
  for (const drill of DRILL_NAMES) {
    outcomes[drill] = readBoundedJson(
      path.join(resolved, 'drills', `${drill}.json`),
      `bundle_drill_${drill}`,
    );
  }
  const manifest = readBoundedJson(path.join(resolved, 'manifest.json'), 'bundle_manifest');
  return {
    resolved,
    plan,
    authorization,
    isolation,
    readinessLedger,
    execution,
    restore,
    outcomes,
    manifest,
  };
}

export function verifyBundle(bundleDir, keys, { nowMs = Date.now() } = {}) {
  const components = readBundleComponents(bundleDir);
  const validatedOutcomes = validatedComponents(
    { ...components, keys },
    { nowMs, allowExpired: true },
  );
  const rebuilt = buildManifest(components, validatedOutcomes);
  validateManifestShape(components.manifest);
  if (canonicalJson(components.manifest) !== canonicalJson(rebuilt.manifest)) {
    fail('bundle_manifest_mismatch');
  }
  const expectedSources = rebuilt.sources;
  for (const [relativePath, expectedBytes] of expectedSources.entries()) {
    const actual = readBoundedFile(
      path.join(components.resolved, relativePath),
      `bundle_file_${relativePath.replaceAll('/', '_')}`,
    );
    if (!actual.equals(expectedBytes)) fail(`bundle_file_not_canonical:${relativePath}`);
  }
  const manifestBytes = readBoundedFile(
    path.join(components.resolved, 'manifest.json'),
    'bundle_manifest_file',
  );
  if (!manifestBytes.equals(canonicalJsonBuffer(rebuilt.manifest))) {
    fail('bundle_manifest_not_canonical');
  }
  return {
    bundlePath: components.resolved,
    plan: components.plan,
    manifest: components.manifest,
    machineEvidenceSha256: sha256Json(components.manifest),
  };
}

export function buildRollbackRequest(verifiedBundle, operator) {
  assertString(operator, SAFE_OPERATOR, 'rollback_request_operator_invalid');
  const { plan, manifest, machineEvidenceSha256 } = verifiedBundle;
  validateManifestShape(manifest);
  assertDigest(machineEvidenceSha256, 'machine_evidence_digest_invalid');
  if (machineEvidenceSha256 !== sha256Json(manifest)) fail('machine_evidence_digest_mismatch');
  const payload = {
    schema: SCHEMAS.rollbackRequest,
    drilledAt: manifest.collectedAt,
    result: 'passed',
    restoreMode: 'dry-run',
    dryRun: true,
    sourceVersion: plan.release.sourceVersion,
    targetVersion: plan.release.targetVersion,
    sourceSha: plan.release.sourceSha,
    targetSha: plan.release.targetSha,
    targetBackup: manifest.restore.targetBackup,
    targetBackupSha256: manifest.restore.targetBackupSha256,
    machineEvidenceSha256,
    operator,
    databaseIntegrity: manifest.restore.databaseIntegrity,
    backupContainsDatabase: manifest.restore.backupContainsDatabase,
    healthCheck: manifest.restore.healthCheck,
  };
  assertExactFields(payload, ROLLBACK_REQUEST_FIELDS, 'rollback_request');
  return payload;
}

function sshInvocation(overlay, remoteArgv) {
  return {
    program: 'ssh',
    argv: [
      '-p',
      String(overlay.ssh.port),
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `HostKeyAlias=${overlay.overlayId}`,
      '-o',
      `UserKnownHostsFile=<execution-output>/known-hosts/${overlay.overlayId}`,
      '-i',
      '<dedicated-lab-ssh-private-key>',
      `${overlay.ssh.user}@${overlay.ssh.host}`,
      ...remoteArgv,
    ],
  };
}

export function buildLocalExecutionPlan(plan, { nowMs = Date.now() } = {}) {
  validatePlan(plan, { nowMs, allowExpired: false });
  return {
    schema: 'nexus.rollback-drill-kvm-local-execution-plan.v1',
    planId: plan.planId,
    mode: plan.mode,
    executionSupported: true,
    executionMode: 'strictly-sequential',
    maximumActiveGuests: 1,
    guarantees: {
      loopbackSshOnly: true,
      independentOverlayRequired: true,
      productionKeysForbidden: true,
      productionDataForbidden: true,
      automaticProtectedApproval: false,
      productionGateMutation: false,
    },
    drills: plan.overlays.map((overlay, index) => ({
      drill: overlay.drill,
      overlayId: overlay.overlayId,
      guest: `guest-${index + 1}`,
      hostUnit: `nexus-rollback-drill-vm@guest-${index + 1}.service`,
      endpoint: `${overlay.ssh.host}:${overlay.ssh.port}`,
      requestFile: `${overlay.drill}.envelope.json`,
      requiredManualBoundary: overlay.drill === 'guest-reboot'
        ? 'hard-stop/start during promotion, followed by one clean post-terminal reboot of only this isolated QEMU guest'
        : overlay.drill === 'failed-health'
          ? 'guest-local candidate health fault after candidate_mutated'
          : 'controller connection drop after predecessor_stopped',
      guestInterfaceInvocations: [
        sshInvocation(overlay, [
          '/usr/bin/sudo',
          '-n',
          plan.interfaces.promotionControl,
          'version',
        ]),
        sshInvocation(overlay, [
          '/usr/bin/sudo',
          '-n',
          plan.interfaces.promotionControl,
          'assert-idle',
        ]),
        sshInvocation(overlay, [
          '/usr/bin/node',
          plan.interfaces.promotionAuthorization,
          'verify-request',
          '--input',
          '<guest-owner-signed-promotion-envelope>',
          '--public-key',
          '<guest-owner-public-key>',
        ]),
        sshInvocation(overlay, [
          '/usr/bin/sudo',
          '-n',
          plan.interfaces.promotionControl,
          'launch',
          '<guest-owner-signed-promotion-envelope>',
        ]),
        sshInvocation(overlay, [
          '/usr/bin/sudo',
          '-n',
          plan.interfaces.promotionControl,
          'status',
          '<transaction-id>',
        ]),
        sshInvocation(overlay, [
          '/usr/bin/sudo',
          '-n',
          plan.interfaces.promotionControl,
          'fetch',
          '<transaction-id>',
          'result',
        ]),
      ],
    })),
    restoreInterfaceInvocation: {
      program: plan.interfaces.restoreDrill,
      argv: ['<guest-lab-restore-arguments>'],
      executionLocation: 'inside-isolated-kvm-guest',
    },
  };
}
