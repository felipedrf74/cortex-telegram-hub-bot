#!/usr/bin/env node
/**
 * Offline admission ledger for the three KVM runtime-readiness collections.
 *
 * This control intentionally performs no systemctl, SSH, network, collector,
 * promotion, or production operation. It snapshots one exact plan and its
 * three owner-signed runtime authorizations, derives an immutable request for
 * each fixed guest, admits only the next request, and advances only after the
 * collector's owner signature, guest host-key signature, journal nonce, and
 * readiness tuple all verify. A later runtime/bootstrap phase may consume the
 * admitted request; this phase cannot start a guest by itself.
 */
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeSync,
} from 'node:fs';
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DRILL_NAMES,
  canonicalJson,
  normalizeSshEd25519PublicKey,
  publicKeyIdentity,
  sha256Bytes,
  sha256Json,
  textKeyIdentity,
  validatePlan,
} from './lib/rollback-drill-kvm-evidence.mjs';

const STATE_SCHEMA = 'nexus.rollback-drill-kvm-readiness-sequence.v1';
const REQUEST_SCHEMA = 'nexus.rollback-drill-kvm-readiness-request.v1';
const GENERATION_SCHEMA = 'nexus.rollback-drill-kvm-input-generation.v1';
const RUNTIME_AUTHORIZATION_SCHEMA =
  'nexus.rollback-drill-vm-runtime-authorization.v1';
const RUNTIME_READINESS_SCHEMA =
  'nexus.rollback-drill-vm-runtime-readiness.v2';
const MEASUREMENT_SCHEMA =
  'nexus.rollback-drill-vm-runtime-measurement.v1';
const COLLECTION_JOURNAL_SCHEMA =
  'nexus.rollback-drill-vm-runtime-collection-journal.v1';
const MEASUREMENT_NAMESPACE =
  'nexus-rollback-drill-vm-runtime-measurement';
const EXECUTION_MODE = 'strictly-sequential';
const DEFAULT_STATE_ROOT =
  '/var/lib/nexus-rollback-drill-vm/readiness-sequences';
const LOCK_HELD_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_LOCK_HELD';
const LOCK_FD_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_LOCK_FD';
const TEST_STATE_ROOT_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_TEST_STATE_ROOT';
const TEST_NOW_ENV = 'NEXUS_KVM_READINESS_SEQUENCE_TEST_NOW';
const TEST_BOOT_ID_ENV =
  'NEXUS_KVM_READINESS_SEQUENCE_TEST_BOOT_ID';
const TEST_UPTIME_ENV =
  'NEXUS_KVM_READINESS_SEQUENCE_TEST_UPTIME_SECONDS';
const TEST_INTERRUPT_AFTER_RECEIPT_ENV =
  'NEXUS_KVM_READINESS_SEQUENCE_TEST_INTERRUPT_AFTER_RECEIPT';
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 64 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DIGEST = /^[0-9a-f]{64}$/u;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAC = /^52:54:00(?::[0-9a-f]{2}){3}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SAFE_PACKAGE =
  /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/u;
const SAFE_PACKAGE_VERSION = /^[A-Za-z0-9.+:~_-]+$/u;
const SAFE_PACKAGE_ARCH = /^[a-z0-9][a-z0-9-]*$/u;
const SSH_KEYGEN = '/usr/bin/ssh-keygen';
const PYTHON = '/usr/bin/python3';
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const BINDINGS = Object.freeze([
  Object.freeze({
    drill: 'ssh-loss',
    runtimeDrill: 'ssh-disconnect-after-pm2-stop',
    guest: 'guest-1',
  }),
  Object.freeze({
    drill: 'failed-health',
    runtimeDrill: 'failed-health-check',
    guest: 'guest-2',
  }),
  Object.freeze({
    drill: 'guest-reboot',
    runtimeDrill: 'host-reboot-during-promotion',
    guest: 'guest-3',
  }),
]);

const STATE_FIELDS = Object.freeze([
  'schema',
  'sequenceId',
  'createdAt',
  'updatedAt',
  'completedAt',
  'planId',
  'planSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'guestOwnerPublicKeySha256',
  'controllerBootIdSha256',
  'monotonicStartedSeconds',
  'monotonicDeadlineSeconds',
  'lastObservedMonotonicSeconds',
  'executionMode',
  'orderedDrills',
  'nextIndex',
  'active',
  'guests',
]);
const STATE_GUEST_FIELDS = Object.freeze([
  'drill',
  'runtimeDrill',
  'guest',
  'port',
  'unit',
  'status',
  'requestPath',
  'requestSha256',
  'bundleManifestSha256',
  'runtimeAuthorizationId',
  'runtimeAuthorizationSha256',
  'runtimeAuthorizationSignatureSha256',
  'readinessPath',
  'readinessSha256',
  'completedAt',
]);
const ACTIVE_FIELDS = Object.freeze([
  'drill',
  'guest',
  'requestSha256',
  'claimedAt',
  'claimedMonotonicSeconds',
]);
const REQUEST_FIELDS = Object.freeze([
  'schema',
  'sequenceId',
  'planId',
  'planSha256',
  'generationManifestSha256',
  'provisionReceiptSha256',
  'guestOwnerPublicKeySha256',
  'drill',
  'runtimeDrill',
  'guest',
  'port',
  'unit',
  'bundleManifestSha256',
  'runtimeAuthorizationId',
  'runtimeAuthorizationSha256',
  'runtimeAuthorizationSignatureSha256',
]);
const GENERATION_FIELDS = Object.freeze([
  'schema',
  'generatedAt',
  'executionMode',
  'orderedDrills',
  'specSha256',
  'provisionReceiptSha256',
  'planSha256',
  'runtimeAuthorizations',
  'nextRequiredAction',
]);
const GENERATION_RUNTIME_FIELDS = Object.freeze([
  'drill',
  'guest',
  'runtimeDrill',
  'file',
  'payloadSha256',
  'bundleManifestSha256',
]);
const RUNTIME_AUTHORIZATION_FIELDS = Object.freeze([
  'schema',
  'authorizationId',
  'issuedAt',
  'expiresAt',
  'controllerBootIdSha256',
  'issuedMonotonicSeconds',
  'expiresMonotonicSeconds',
  'operation',
  'drill',
  'setId',
  'guest',
  'port',
  'provisionReceiptSha256',
  'bundleManifestSha256',
  'guestSshHostPublicKeySha256',
  'ownerPublicKeySha256',
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
const EXPECTED_HYPERVISOR = Object.freeze({
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
const READINESS_FIELDS = Object.freeze([
  'schema',
  'status',
  'drillReady',
  'sealedAt',
  'setId',
  'guest',
  'port',
  'provisionReceiptSha256',
  'bundleManifestSha256',
  'ownerAuthorization',
  'guestMeasurement',
  'machine',
  'qemu',
  'stoppedGuestProof',
  'overlay',
  'runtime',
  'control',
  'pm2DryHealth',
  'networkInstallAttempted',
]);
const READINESS_AUTH_FIELDS = Object.freeze([
  'authorizationId',
  'drill',
  'issuedAt',
  'expiresAt',
  'controllerBootIdSha256',
  'issuedMonotonicSeconds',
  'expiresMonotonicSeconds',
  'sha256',
  'signatureSha256',
  'ownerPublicKeySha256',
]);
const READINESS_MEASUREMENT_FIELDS = Object.freeze([
  'sha256',
  'signatureSha256',
  'challenge',
  'namespace',
]);
const READINESS_MACHINE_FIELDS = Object.freeze([
  'uuid',
  'instanceId',
  'mac',
  'sshHostKeyFingerprint',
  'sshHostPublicKeySha256',
]);
const READINESS_QEMU_FIELDS = Object.freeze([
  'unit',
  'supervisorPid',
  'supervisorStartTime',
  'supervisorCmdlineSha256',
  'pid',
  'startTime',
  'executable',
  'executableSha256',
  'cmdlineSha256',
  'loopbackPortSocketInode',
]);
const READINESS_STOPPED_FIELDS = Object.freeze([
  'unit',
  'systemdState',
  'admissionLockHeld',
  'activeLockHolder',
  'sharedReleaseSonarLockHolder',
  'holderPid',
  'holderStartTime',
  'handoffNonce',
  'qemuExited',
  'overlayProcessAbsent',
]);
const READINESS_OVERLAY_FIELDS = Object.freeze([
  'path',
  'initialSha256',
  'currentSha256',
  'size',
  'device',
  'inode',
  'mtimeNs',
  'ctimeNs',
  'stableDescriptor',
]);
const MEASUREMENT_FIELDS = Object.freeze([
  'schema',
  'status',
  'drillReady',
  'pendingHostOverlaySeal',
  'setId',
  'guest',
  'capturedAt',
  'provisionReceiptSha256',
  'bundleManifestSha256',
  'challenge',
  'machine',
  'runtime',
  'control',
  'pm2DryHealth',
  'networkInstallAttempted',
]);
const MEASUREMENT_MACHINE_FIELDS = Object.freeze([
  'uuid',
  'instanceId',
  'sshHostKeyFingerprint',
  'sshHostPublicKeySha256',
]);
const MEASUREMENT_RUNTIME_FIELDS = Object.freeze([
  'node',
  'python',
  'pm2',
]);
const MEASUREMENT_NODE_FIELDS = Object.freeze([
  'version',
  'path',
  'sha256',
  'treeSha256',
  'owner',
  'mode',
  'linkCount',
]);
const MEASUREMENT_PYTHON_FIELDS = Object.freeze([
  'version',
  'path',
  'sha256',
  'packageName',
  'packageVersion',
  'packageArchitecture',
]);
const MEASUREMENT_PM2_FIELDS = Object.freeze([
  'version',
  'path',
  'sha256',
  'entrypointPath',
  'entrypointSha256',
  'attestationPath',
  'attestationSha256',
  'treeSha256',
  'owner',
  'mode',
]);
const MEASUREMENT_CONTROL_FIELDS = Object.freeze([
  'version',
  'sourceCommit',
  'files',
  'generatedFiles',
  'serviceStates',
  'assertIdle',
  'runtimeRecovery',
]);
const MEASUREMENT_PM2_HEALTH_FIELDS = Object.freeze([
  'status',
  'isolatedHome',
  'daemonStopped',
  'processCount',
]);
const JOURNAL_FIELDS = Object.freeze([
  'schema',
  'status',
  'authorizationId',
  'authorizationSha256',
  'authorizationSignatureSha256',
  'setId',
  'guest',
  'provisionReceiptSha256',
  'bundleManifestSha256',
  'challenge',
  'nonce',
  'measurementSha256',
  'measurementSignatureSha256',
  'supervisorPid',
  'supervisorStartTime',
  'qemuPid',
  'qemuStartTime',
]);
const LIVE_QEMU_FIELDS = Object.freeze([
  'supervisorPid',
  'supervisorStartTime',
  'supervisorCmdlineSha256',
  'qemuPid',
  'qemuStartTime',
  'qemuExecutable',
  'qemuExecutableSha256',
  'qemuCmdlineSha256',
  'loopbackPortSocketInode',
]);
const EVIDENCE_FILES = Object.freeze([
  'authorization.json',
  'authorization.sig',
  'measurement.json',
  'measurement.sig',
  'journal.json',
  'live-qemu.json',
]);
const COMPLETED_LEDGER_SCHEMA =
  'nexus.rollback-drill-kvm-readiness-ledger.v1';
const COMPLETED_LEDGER_FIELDS = Object.freeze([
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
const COMPLETED_LEDGER_ENTRY_FIELDS = Object.freeze([
  'drill',
  'runtimeDrill',
  'guest',
  'requestSha256',
  'readinessSha256',
  'completedAt',
]);

class SequenceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new SequenceError(code);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_object_invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    fail(`${label}_fields_invalid`);
  }
  return value;
}

function requireString(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function requireDigest(value, code) {
  return requireString(value, DIGEST, code);
}

function requireInteger(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code);
  }
  return value;
}

function requireBoolean(value, expected, code) {
  if (typeof value !== 'boolean'
      || (expected !== undefined && value !== expected)) {
    fail(code);
  }
  return value;
}

function parseIso(value, code) {
  requireString(value, ISO_UTC, code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function nowMs() {
  if (process.env.NODE_ENV === 'test' && process.env[TEST_NOW_ENV]) {
    const parsed = Number(process.env[TEST_NOW_ENV]);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('test_now_invalid');
    return parsed;
  }
  return Date.now();
}

function controllerClock(plan) {
  let bootId;
  let uptimeText;
  if (process.env.NODE_ENV === 'test') {
    bootId = process.env[TEST_BOOT_ID_ENV];
    uptimeText = process.env[TEST_UPTIME_ENV];
  } else {
    try {
      bootId = readFileSync(
        '/proc/sys/kernel/random/boot_id',
        'utf8',
      ).trim();
      uptimeText = readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/u)[0];
    } catch {
      fail('controller_clock_unavailable');
    }
  }
  if (!bootId || /\s/u.test(bootId)
      || !/^\d+(?:\.\d{1,9})?$/u.test(uptimeText || '')) {
    fail('controller_clock_invalid');
  }
  const monotonicSeconds = Math.floor(Number(uptimeText));
  if (!Number.isSafeInteger(monotonicSeconds) || monotonicSeconds < 0) {
    fail('controller_clock_invalid');
  }
  const bootIdSha256 = digestBytes(Buffer.from(bootId, 'utf8'));
  if (bootIdSha256 !== plan.controller.bootIdSha256) {
    fail('controller_boot_changed');
  }
  return { bootIdSha256, monotonicSeconds };
}

function isoSeconds(milliseconds) {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace('.000Z', 'Z');
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedOwnerUid() {
  return process.geteuid?.() ?? process.getuid();
}

function stateRoot() {
  const override = process.env[TEST_STATE_ROOT_ENV];
  if (override && process.env.NODE_ENV !== 'test') {
    fail('state_root_override_forbidden');
  }
  const candidate = override || DEFAULT_STATE_ROOT;
  if (!path.isAbsolute(candidate) || path.normalize(candidate) !== candidate) {
    fail('state_root_invalid');
  }
  return candidate;
}

function validateInheritedControlLock() {
  const rawDescriptor = process.env[LOCK_FD_ENV];
  if (!/^[3-9]\d*$/u.test(rawDescriptor || '')) {
    fail('control_lock_handoff_invalid');
  }
  const descriptor = Number(rawDescriptor);
  let descriptorStat;
  let pathStat;
  const lockPath = path.join(stateRoot(), 'control.lock');
  try {
    descriptorStat = fstatSync(descriptor);
    pathStat = lstatSync(lockPath);
  } catch {
    fail('control_lock_handoff_invalid');
  }
  if (!descriptorStat.isFile() || descriptorStat.nlink !== 1
      || descriptorStat.uid !== expectedOwnerUid()
      || (descriptorStat.mode & 0o777) !== 0o600
      || !pathStat.isFile() || pathStat.isSymbolicLink()
      || pathStat.nlink !== 1 || pathStat.uid !== expectedOwnerUid()
      || (pathStat.mode & 0o777) !== 0o600
      || descriptorStat.dev !== pathStat.dev
      || descriptorStat.ino !== pathStat.ino
      || realpathSync(lockPath) !== lockPath) {
    fail('control_lock_handoff_invalid');
  }
}

function validateDirectory(candidate, label, mode = null) {
  const resolved = path.resolve(candidate);
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    fail(`${label}_missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== expectedOwnerUid()
      || realpathSync(resolved) !== resolved
      || (stat.mode & 0o022) !== 0
      || (mode !== null && (stat.mode & 0o777) !== mode)) {
    fail(`${label}_unsafe`);
  }
  return resolved;
}

function readSafeFile(
  candidate,
  label,
  {
    maximum = MAX_JSON_BYTES,
    acceptedModes = [0o400, 0o600, 0o640],
  } = {},
) {
  const resolved = path.resolve(candidate);
  let pathStat;
  try {
    pathStat = lstatSync(resolved);
  } catch {
    fail(`${label}_missing`);
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1
      || pathStat.uid !== expectedOwnerUid()
      || !acceptedModes.includes(pathStat.mode & 0o777)
      || pathStat.size <= 0 || pathStat.size > maximum
      || realpathSync(resolved) !== resolved) {
    fail(`${label}_unsafe`);
  }
  let descriptor;
  try {
    descriptor = openSync(
      resolved,
      fsConstants.O_RDONLY | O_NOFOLLOW,
    );
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
        || before.dev !== pathStat.dev || before.ino !== pathStat.ino
        || before.size !== pathStat.size) {
      fail(`${label}_identity_changed`);
    }
    const body = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || body.length !== before.size) {
      fail(`${label}_changed_during_read`);
    }
    return { path: resolved, body, stat: before };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(bytes, label, { canonical = false } = {}) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label}_json_invalid`);
  }
  if (canonical
      && !Buffer.from(canonicalJson(value), 'utf8').equals(bytes)) {
    fail(`${label}_not_canonical`);
  }
  return value;
}

function fsyncDirectory(directory) {
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function makeDirectory(parent, basename, mode = 0o700) {
  validateDirectory(parent, 'directory_parent');
  const destination = path.join(parent, basename);
  if (path.dirname(destination) !== parent || existsSync(destination)) {
    fail('directory_target_exists');
  }
  try {
    mkdirSync(destination, { mode });
  } catch (error) {
    fail(error?.code === 'EEXIST'
      ? 'directory_target_exists'
      : 'directory_create_failed');
  }
  validateDirectory(destination, 'created_directory', mode);
  fsyncDirectory(parent);
  return destination;
}

function writeExclusive(destination, bytes, mode = 0o600) {
  const parent = validateDirectory(path.dirname(destination), 'write_parent');
  if (path.dirname(destination) !== parent) fail('write_path_invalid');
  let descriptor;
  try {
    descriptor = openSync(
      destination,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | O_NOFOLLOW,
      mode,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) fail('write_short');
      offset += written;
    }
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof SequenceError) throw error;
    fail(error?.code === 'EEXIST' ? 'write_target_exists' : 'write_failed');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const written = readSafeFile(
    destination,
    'written_file',
    { maximum: Math.max(bytes.length, 1), acceptedModes: [mode] },
  );
  if (!written.body.equals(bytes)) fail('written_file_mismatch');
  fsyncDirectory(parent);
}

function writeStateAtomic(sequenceDirectory, state) {
  const body = Buffer.from(canonicalJson(state), 'utf8');
  const stage = path.join(
    sequenceDirectory,
    `.state.${randomBytes(12).toString('hex')}.next`,
  );
  writeExclusive(stage, body);
  const destination = path.join(sequenceDirectory, 'state.json');
  if (existsSync(destination)) {
    readSafeFile(destination, 'prior_state', {
      maximum: MAX_JSON_BYTES,
      acceptedModes: [0o600],
    });
  }
  try {
    renameSync(stage, destination);
  } catch {
    fail('state_publish_failed');
  }
  fsyncDirectory(sequenceDirectory);
  const published = readSafeFile(destination, 'published_state', {
    maximum: MAX_JSON_BYTES,
    acceptedModes: [0o600],
  });
  if (!published.body.equals(body)) fail('published_state_mismatch');
}

function ensureSnapshot(destination, expected, label) {
  if (existsSync(destination)) {
    const current = readSafeFile(destination, label, {
      maximum: Math.max(expected.length, 1),
      acceptedModes: [0o600],
    });
    if (!current.body.equals(expected)) fail(`${label}_drifted`);
    return;
  }
  writeExclusive(destination, expected);
}

function sshHostFingerprint(publicKey, label) {
  let canonical;
  try {
    canonical = normalizeSshEd25519PublicKey(publicKey);
  } catch {
    fail(`${label}_invalid`);
  }
  if (canonical !== publicKey) fail(`${label}_not_canonical`);
  const encoded = canonical.split(' ')[1];
  const keyBlob = Buffer.from(encoded, 'base64');
  if (keyBlob.length === 0
      || keyBlob.toString('base64') !== encoded) {
    fail(`${label}_invalid`);
  }
  return `SHA256:${createHash('sha256')
    .update(keyBlob)
    .digest('base64')
    .replace(/=+$/u, '')}`;
}

function validateProvision(provision) {
  exactObject(provision, PROVISION_FIELDS, 'provision');
  if (provision.schema !== 'nexus.rollback-drill-vm-provision.v2'
      || !DIGEST.test(provision.setId)
      || !Array.isArray(provision.ports) || provision.ports.length !== 3
      || new Set(provision.ports).size !== 3
      || !Array.isArray(provision.guestSshHostPublicKeySha256s)
      || provision.guestSshHostPublicKeySha256s.length !== 3
      || new Set(provision.guestSshHostPublicKeySha256s).size !== 3
      || !Array.isArray(provision.guests) || provision.guests.length !== 3) {
    fail('provision_invalid');
  }
  exactObject(provision.image, PROVISION_IMAGE_FIELDS, 'provision_image');
  requireDigest(provision.image.sha256, 'provision_image_digest_invalid');
  if (provision.image.filename !== 'noble-server-cloudimg-amd64.img'
      || provision.image.basePath
        !== `/var/lib/nexus-rollback-drill-vm/base/${provision.image.sha256}.qcow2`
      || provision.setDirectory
        !== `/var/lib/nexus-rollback-drill-vm/sets/${provision.setId}`) {
    fail('provision_image_or_set_binding_invalid');
  }
  requireDigest(
    provision.sshPublicKeySha256,
    'provision_client_key_digest_invalid',
  );
  provision.guestSshHostPublicKeySha256s.forEach((identity) => {
    requireDigest(identity, 'provision_host_key_digest_invalid');
    if (identity === provision.sshPublicKeySha256) {
      fail('provision_client_host_key_reuse');
    }
  });
  provision.ports.forEach((port) => {
    requireInteger(port, 1024, 65535, 'provision_guest_port_invalid');
  });
  exactObject(
    provision.runtimeReadiness,
    PROVISION_RUNTIME_READINESS_FIELDS,
    'provision_runtime_readiness',
  );
  if (provision.runtimeReadiness.status
        !== 'ssh_only_bootstrap_required'
      || provision.runtimeReadiness.drillReady !== false
      || canonicalJson(provision.runtimeReadiness.requirements)
        !== canonicalJson(PROVISION_REQUIREMENTS)) {
    fail('provision_runtime_readiness_invalid');
  }
  exactObject(
    provision.hypervisor,
    PROVISION_HYPERVISOR_FIELDS,
    'provision_hypervisor',
  );
  for (const [field, expected] of Object.entries(EXPECTED_HYPERVISOR)) {
    if (provision.hypervisor[field] !== expected) {
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
    'unitSha256',
  ]) {
    requireDigest(
      provision.hypervisor[field],
      `provision_hypervisor_digest_invalid:${field}`,
    );
  }
  if (!/^QEMU emulator version [ -~]{1,230}$/u.test(
    provision.hypervisor.qemuVersion,
  ) || !SAFE_PACKAGE.test(provision.hypervisor.qemuPackage)
      || !SAFE_PACKAGE_VERSION.test(provision.hypervisor.qemuPackageVersion)
      || !SAFE_PACKAGE_ARCH.test(
        provision.hypervisor.qemuPackageArchitecture,
      )) {
    fail('provision_qemu_package_identity_invalid');
  }
  parseIso(provision.createdAt, 'provision_created_at_invalid');
  const observed = {
    uuids: new Set(),
    macs: new Set(),
    overlays: new Set(),
    seeds: new Set(),
    hostKeys: new Set(),
    fingerprints: new Set(),
  };
  provision.guests.forEach((guest, index) => {
    exactObject(guest, PROVISION_GUEST_FIELDS, `provision_guest_${index + 1}`);
    const binding = BINDINGS[index];
    const expectedRoot = `${provision.setDirectory}/${binding.guest}`;
    requireString(guest.uuid, UUID, 'provision_guest_uuid_invalid');
    requireString(guest.mac, MAC, 'provision_guest_mac_invalid');
    requireString(
      guest.hostKeyFingerprint,
      SSH_FINGERPRINT,
      'provision_guest_host_fingerprint_invalid',
    );
    requireDigest(
      guest.hostPublicKeySha256,
      'provision_guest_host_key_digest_invalid',
    );
    if (guest.name !== binding.guest
        || guest.port !== provision.ports[index]
        || guest.unit !== `nexus-rollback-drill-vm@${binding.guest}.service`
        || guest.instanceId
          !== `nexus-rollback-drill-${binding.guest}-${provision.setId.slice(0, 16)}`
        || guest.overlayPath !== `${expectedRoot}/root.qcow2`
        || guest.seedPath !== `${expectedRoot}/seed.img`
        || textKeyIdentity(guest.hostPublicKey) !== guest.hostPublicKeySha256
        || guest.hostPublicKeySha256
          !== provision.guestSshHostPublicKeySha256s[index]
        || sshHostFingerprint(
          guest.hostPublicKey,
          `provision_guest_${index + 1}_host_key`,
        ) !== guest.hostKeyFingerprint) {
      fail('provision_guest_binding_invalid');
    }
    requireDigest(
      guest.overlayInitialSha256,
      'provision_guest_overlay_digest_invalid',
    );
    requireDigest(guest.seedSha256, 'provision_guest_seed_digest_invalid');
    observed.uuids.add(guest.uuid);
    observed.macs.add(guest.mac);
    observed.overlays.add(guest.overlayInitialSha256);
    observed.seeds.add(guest.seedSha256);
    observed.hostKeys.add(guest.hostPublicKeySha256);
    observed.fingerprints.add(guest.hostKeyFingerprint);
  });
  if (Object.values(observed).some((identities) => identities.size !== 3)) {
    fail('provision_guest_identity_reused');
  }
  const setMaterial = [
    'schema=nexus.rollback-drill-vm-provision.v2',
    `image=${provision.image.sha256}`,
    `key=${provision.sshPublicKeySha256}`,
    `hostKeys=${provision.guestSshHostPublicKeySha256s.join(',')}`,
    `ports=${provision.ports.join(',')}`,
    `runner=${provision.hypervisor.runnerSha256}`,
    `hostPreflight=${provision.hypervisor.hostPreflightSha256}`,
    `runtimeManifest=${provision.hypervisor.runtimeManifestSha256}`,
    `runtimeControl=${provision.hypervisor.runtimeControlSha256}`,
    `runtimeReadiness=${provision.hypervisor.runtimeReadinessSha256}`,
    `runtimeRecoveryUnit=${provision.hypervisor.runtimeRecoveryUnitSha256}`,
    `unit=${provision.hypervisor.unitSha256}`,
    `qemu=${provision.hypervisor.qemuSha256}`,
    `qemuVersion=${provision.hypervisor.qemuVersion}`,
    `qemuPackage=${provision.hypervisor.qemuPackage}`,
    `qemuPackageVersion=${provision.hypervisor.qemuPackageVersion}`,
    `qemuPackageArchitecture=${provision.hypervisor.qemuPackageArchitecture}`,
    '',
  ].join('\n');
  if (digestBytes(Buffer.from(setMaterial, 'utf8')) !== provision.setId) {
    fail('provision_set_identity_invalid');
  }
  return provision;
}

function validateGeneration(
  generation,
  plan,
  provision,
  provisionDigest,
  currentTime,
) {
  exactObject(generation, GENERATION_FIELDS, 'generation');
  if (generation.schema !== GENERATION_SCHEMA
      || generation.executionMode !== EXECUTION_MODE
      || generation.nextRequiredAction
        !== 'owner-sign-runtime-authorizations-and-collect-readiness'
      || generation.planSha256 !== sha256Json(plan)
      || generation.provisionReceiptSha256 !== provisionDigest
      || JSON.stringify(generation.orderedDrills)
        !== JSON.stringify(DRILL_NAMES)
      || !Array.isArray(generation.runtimeAuthorizations)
      || generation.runtimeAuthorizations.length !== 3) {
    fail('generation_binding_invalid');
  }
  requireDigest(generation.specSha256, 'generation_spec_digest_invalid');
  const generatedAt = parseIso(
    generation.generatedAt,
    'generation_timestamp_invalid',
  );
  const planCreatedAt = parseIso(plan.createdAt, 'plan_created_at_invalid');
  const provisionCreatedAt = parseIso(
    provision.createdAt,
    'provision_created_at_invalid',
  );
  if (provisionCreatedAt > planCreatedAt
      || generatedAt < planCreatedAt
      || generatedAt < provisionCreatedAt
      || generatedAt > currentTime + CLOCK_SKEW_MS) {
    fail('generation_timestamp_binding_invalid');
  }
  generation.runtimeAuthorizations.forEach((entry, index) => {
    exactObject(entry, GENERATION_RUNTIME_FIELDS, 'generation_runtime');
    const binding = BINDINGS[index];
    if (entry.drill !== binding.drill || entry.guest !== binding.guest
        || entry.runtimeDrill !== binding.runtimeDrill
        || entry.file !== `runtime-authorizations/${binding.drill}.json`) {
      fail('generation_runtime_order_invalid');
    }
    requireDigest(entry.payloadSha256, 'generation_runtime_digest_invalid');
    requireDigest(
      entry.bundleManifestSha256,
      'generation_bundle_digest_invalid',
    );
  });
  return generation;
}

function validatePlanProvisionBindings(plan, provision) {
  if (canonicalJson(plan.trust.guestSshHostPublicKeySha256s)
      !== canonicalJson(provision.guestSshHostPublicKeySha256s)
      || plan.trust.guestSshClientPublicKeySha256
        !== provision.sshPublicKeySha256) {
    fail('plan_provision_trust_binding_invalid');
  }
  provision.guests.forEach((guest, index) => {
    const overlay = plan.overlays[index];
    if (overlay.drill !== BINDINGS[index].drill
        || overlay.baselineSnapshotSha256 !== provision.image.sha256
        || overlay.machineUuid !== guest.uuid
        || overlay.overlayInitialSha256 !== guest.overlayInitialSha256
        || overlay.ssh.port !== guest.port
        || overlay.ssh.hostPublicKeySha256 !== guest.hostPublicKeySha256
        || plan.trust.guestSshHostPublicKeySha256s[index]
          !== guest.hostPublicKeySha256) {
      fail('plan_provision_guest_binding_invalid');
    }
  });
}

function validateRuntimeAuthorization(
  authorization,
  binding,
  plan,
  provision,
  provisionDigest,
  generationEntry,
  generationTimestamp,
  ownerKeyDigest,
  currentTime,
  currentClock,
  { requireCurrent = true } = {},
) {
  exactObject(
    authorization,
    RUNTIME_AUTHORIZATION_FIELDS,
    'runtime_authorization',
  );
  const guest = provision.guests[BINDINGS.indexOf(binding)];
  const issued = parseIso(
    authorization.issuedAt,
    'runtime_authorization_issued_invalid',
  );
  const expires = parseIso(
    authorization.expiresAt,
    'runtime_authorization_expires_invalid',
  );
  const planCreated = parseIso(plan.createdAt, 'plan_created_at_invalid');
  const planExpires = parseIso(plan.expiresAt, 'plan_expires_at_invalid');
  const generated = parseIso(
    generationTimestamp,
    'generation_timestamp_invalid',
  );
  requireInteger(
    authorization.issuedMonotonicSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'runtime_authorization_monotonic_start_invalid',
  );
  requireInteger(
    authorization.expiresMonotonicSeconds,
    1,
    Number.MAX_SAFE_INTEGER,
    'runtime_authorization_monotonic_deadline_invalid',
  );
  const wallLifetimeSeconds = (expires - issued) / 1000;
  const expectedAuthorizationId = digestBytes(Buffer.from(
    `${plan.planId}:${binding.guest}:`
      + `${generationEntry.bundleManifestSha256}:${issued}`,
    'utf8',
  ));
  if (authorization.schema !== RUNTIME_AUTHORIZATION_SCHEMA
      || authorization.operation !== 'collect-runtime-readiness'
      || authorization.drill !== binding.runtimeDrill
      || authorization.setId !== provision.setId
      || authorization.guest !== binding.guest
      || authorization.port !== guest.port
      || authorization.provisionReceiptSha256 !== provisionDigest
      || authorization.bundleManifestSha256
        !== generationEntry.bundleManifestSha256
      || authorization.guestSshHostPublicKeySha256
        !== guest.hostPublicKeySha256
      || authorization.guestSshHostPublicKeySha256
        !== plan.overlays[BINDINGS.indexOf(binding)].ssh.hostPublicKeySha256
      || authorization.ownerPublicKeySha256 !== ownerKeyDigest
      || authorization.controllerBootIdSha256
        !== plan.controller.bootIdSha256
      || authorization.controllerBootIdSha256
        !== currentClock.bootIdSha256
      || !Number.isSafeInteger(wallLifetimeSeconds)
      || authorization.expiresMonotonicSeconds
        - authorization.issuedMonotonicSeconds !== wallLifetimeSeconds
      || authorization.expiresMonotonicSeconds
        <= authorization.issuedMonotonicSeconds
      || authorization.issuedMonotonicSeconds
        > currentClock.monotonicSeconds
      || (requireCurrent
        && authorization.expiresMonotonicSeconds
          <= currentClock.monotonicSeconds)
      || authorization.authorizationId !== expectedAuthorizationId
      || expires <= issued || expires - issued > 24 * 60 * 60 * 1000
      || issued < planCreated || issued < generated
      || issued > currentTime + CLOCK_SKEW_MS
      || expires > planExpires
      || (requireCurrent && expires <= currentTime)) {
    fail(`runtime_authorization_binding_invalid:${binding.drill}`);
  }
  return authorization;
}

function runtimePaths(sequenceDirectory, binding) {
  const root = path.join(sequenceDirectory, 'inputs', 'runtime-authorizations');
  return {
    authorization: path.join(root, `${binding.drill}.json`),
    signature: path.join(root, `${binding.drill}.sig`),
  };
}

function buildRequest(identity, binding, guest, generationEntry, authorization) {
  return {
    schema: REQUEST_SCHEMA,
    sequenceId: identity.sequenceId,
    planId: identity.planId,
    planSha256: identity.planSha256,
    generationManifestSha256: identity.generationManifestSha256,
    provisionReceiptSha256: identity.provisionReceiptSha256,
    guestOwnerPublicKeySha256: identity.guestOwnerPublicKeySha256,
    drill: binding.drill,
    runtimeDrill: binding.runtimeDrill,
    guest: binding.guest,
    port: guest.port,
    unit: guest.unit,
    bundleManifestSha256: generationEntry.bundleManifestSha256,
    runtimeAuthorizationId: authorization.authorizationId,
    runtimeAuthorizationSha256: generationEntry.payloadSha256,
    runtimeAuthorizationSignatureSha256:
      identity.runtimeSignatureDigests[binding.drill],
  };
}

function validateRequest(request, expected, label = 'request') {
  exactObject(request, REQUEST_FIELDS, label);
  if (canonicalJson(request) !== canonicalJson(expected)) {
    fail(`${label}_binding_invalid`);
  }
  return request;
}

function initialIdentity({
  plan,
  planDigest,
  generationDigest,
  provisionDigest,
  ownerKeyDigest,
  runtimeSignatureDigests,
}) {
  const sequenceId = sha256Json({
    schema: 'nexus.rollback-drill-kvm-readiness-sequence-identity.v1',
    planId: plan.planId,
    planSha256: planDigest,
    generationManifestSha256: generationDigest,
    provisionReceiptSha256: provisionDigest,
    guestOwnerPublicKeySha256: ownerKeyDigest,
    orderedRuntimeAuthorizationSignatureSha256: BINDINGS.map(
      (binding) => runtimeSignatureDigests[binding.drill],
    ),
  });
  return {
    sequenceId,
    planId: plan.planId,
    planSha256: planDigest,
    generationManifestSha256: generationDigest,
    provisionReceiptSha256: provisionDigest,
    guestOwnerPublicKeySha256: ownerKeyDigest,
    runtimeSignatureDigests,
  };
}

function initialize(flags) {
  if (process.geteuid?.() !== 0 && process.env.NODE_ENV !== 'test') {
    fail('root_required');
  }
  const currentTime = nowMs();
  const planSource = readSafeFile(required(flags, '--plan'), 'plan');
  const plan = parseJson(planSource.body, 'plan', { canonical: true });
  validatePlan(plan, { nowMs: currentTime });
  const currentClock = controllerClock(plan);
  const planDigest = sha256Bytes(planSource.body);
  if (planDigest !== sha256Json(plan)) fail('plan_digest_invalid');

  const generationSource = readSafeFile(
    required(flags, '--generation-manifest'),
    'generation_manifest',
  );
  const generation = parseJson(
    generationSource.body,
    'generation_manifest',
    { canonical: true },
  );
  const provisionSource = readSafeFile(
    required(flags, '--provision-receipt'),
    'provision_receipt',
  );
  const provision = validateProvision(
    parseJson(provisionSource.body, 'provision_receipt'),
  );
  const provisionDigest = sha256Bytes(provisionSource.body);
  validateGeneration(
    generation,
    plan,
    provision,
    provisionDigest,
    currentTime,
  );

  const ownerKeySource = readSafeFile(
    required(flags, '--guest-owner-public-key'),
    'guest_owner_public_key',
    { maximum: MAX_KEY_BYTES, acceptedModes: [0o400, 0o600] },
  );
  let ownerPublicKey;
  try {
    ownerPublicKey = createPublicKey(ownerKeySource.body);
  } catch {
    fail('guest_owner_public_key_invalid');
  }
  if (ownerPublicKey.asymmetricKeyType !== 'ed25519') {
    fail('guest_owner_public_key_not_ed25519');
  }
  const ownerKeyDigest = publicKeyIdentity(ownerKeySource.body.toString('utf8'));
  if (ownerKeyDigest !== plan.trust.guestOwnerPublicKeySha256) {
    fail('guest_owner_public_key_plan_mismatch');
  }

  const runtimeDirectory = validateDirectory(
    required(flags, '--runtime-authorization-dir'),
    'runtime_authorization_directory',
  );
  const observedRuntimeFiles = readdirSync(
    runtimeDirectory,
    { withFileTypes: true },
  ).map((entry) => entry.name).sort();
  const expectedRuntimeFiles = BINDINGS.flatMap((binding) => [
    `${binding.drill}.json`,
    `${binding.drill}.sig`,
  ]).sort();
  if (observedRuntimeFiles.length !== expectedRuntimeFiles.length
      || observedRuntimeFiles.some(
        (name, index) => name !== expectedRuntimeFiles[index],
      )) {
    fail('runtime_authorization_directory_layout_invalid');
  }
  const runtimeInputs = {};
  const runtimeSignatureDigests = {};
  const authorizationIds = new Set();
  BINDINGS.forEach((binding, index) => {
    const entry = generation.runtimeAuthorizations[index];
    const authorizationSource = readSafeFile(
      path.join(runtimeDirectory, `${binding.drill}.json`),
      `runtime_authorization_${binding.drill}`,
      { acceptedModes: [0o600] },
    );
    const signatureSource = readSafeFile(
      path.join(runtimeDirectory, `${binding.drill}.sig`),
      `runtime_authorization_signature_${binding.drill}`,
      {
        maximum: MAX_SIGNATURE_BYTES,
        acceptedModes: [0o600],
      },
    );
    if (signatureSource.body.length !== 64) {
      fail(`runtime_authorization_signature_size_invalid:${binding.drill}`);
    }
    const authorization = validateRuntimeAuthorization(
      parseJson(
        authorizationSource.body,
        `runtime_authorization_${binding.drill}`,
        { canonical: true },
      ),
      binding,
      plan,
      provision,
      provisionDigest,
      entry,
      generation.generatedAt,
      ownerKeyDigest,
      currentTime,
      currentClock,
    );
    if (sha256Bytes(authorizationSource.body) !== entry.payloadSha256) {
      fail(`runtime_authorization_digest_invalid:${binding.drill}`);
    }
    if (!verifySignature(
      null,
      authorizationSource.body,
      ownerPublicKey,
      signatureSource.body,
    )) {
      fail(`runtime_authorization_signature_invalid:${binding.drill}`);
    }
    if (authorizationIds.has(authorization.authorizationId)) {
      fail('runtime_authorization_replay');
    }
    authorizationIds.add(authorization.authorizationId);
    runtimeSignatureDigests[binding.drill] =
      sha256Bytes(signatureSource.body);
    runtimeInputs[binding.drill] = {
      authorization,
      authorizationBody: authorizationSource.body,
      signatureBody: signatureSource.body,
    };
  });

  validatePlanProvisionBindings(plan, provision);

  const root = validateDirectory(stateRoot(), 'state_root', 0o700);
  const sequenceDirectory = path.join(root, planDigest);
  if (existsSync(sequenceDirectory)) {
    fail('sequence_already_exists');
  }
  makeDirectory(root, planDigest);
  const inputs = makeDirectory(sequenceDirectory, 'inputs');
  const runtimeSnapshots = makeDirectory(inputs, 'runtime-authorizations');
  const requests = makeDirectory(sequenceDirectory, 'requests');
  makeDirectory(sequenceDirectory, 'receipts');

  writeExclusive(path.join(inputs, 'plan.json'), planSource.body);
  writeExclusive(
    path.join(inputs, 'generation-manifest.json'),
    generationSource.body,
  );
  writeExclusive(
    path.join(inputs, 'provision-receipt.json'),
    provisionSource.body,
  );
  writeExclusive(
    path.join(inputs, 'guest-owner-public-key.pem'),
    ownerKeySource.body,
  );
  const allowedSigners = Buffer.from(
    provision.guests
      .map((guest) => `${guest.name} ${guest.hostPublicKey.trim()}`)
      .join('\n') + '\n',
    'utf8',
  );
  writeExclusive(path.join(inputs, 'guest-host-allowed-signers'), allowedSigners);
  BINDINGS.forEach((binding) => {
    writeExclusive(
      path.join(runtimeSnapshots, `${binding.drill}.json`),
      runtimeInputs[binding.drill].authorizationBody,
    );
    writeExclusive(
      path.join(runtimeSnapshots, `${binding.drill}.sig`),
      runtimeInputs[binding.drill].signatureBody,
    );
  });

  const identity = initialIdentity({
    plan,
    planDigest,
    generationDigest: sha256Bytes(generationSource.body),
    provisionDigest,
    ownerKeyDigest,
    runtimeSignatureDigests,
  });
  const requestEntries = BINDINGS.map((binding, index) => {
    const request = buildRequest(
      identity,
      binding,
      provision.guests[index],
      generation.runtimeAuthorizations[index],
      runtimeInputs[binding.drill].authorization,
    );
    const body = Buffer.from(canonicalJson(request), 'utf8');
    const requestPath = path.join(requests, `${binding.drill}.json`);
    writeExclusive(requestPath, body);
    return { request, body, requestPath };
  });
  const timestamp = isoSeconds(currentTime);
  const monotonicDeadlineSeconds = Math.min(
    ...BINDINGS.map(
      (binding) => runtimeInputs[binding.drill]
        .authorization.expiresMonotonicSeconds,
    ),
  );
  if (monotonicDeadlineSeconds <= currentClock.monotonicSeconds) {
    fail('sequence_monotonic_deadline_expired');
  }
  const state = {
    schema: STATE_SCHEMA,
    sequenceId: identity.sequenceId,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    planId: plan.planId,
    planSha256: planDigest,
    generationManifestSha256: sha256Bytes(generationSource.body),
    provisionReceiptSha256: provisionDigest,
    guestOwnerPublicKeySha256: ownerKeyDigest,
    controllerBootIdSha256: currentClock.bootIdSha256,
    monotonicStartedSeconds: currentClock.monotonicSeconds,
    monotonicDeadlineSeconds,
    lastObservedMonotonicSeconds: currentClock.monotonicSeconds,
    executionMode: EXECUTION_MODE,
    orderedDrills: [...DRILL_NAMES],
    nextIndex: 0,
    active: null,
    guests: BINDINGS.map((binding, index) => {
      const entry = generation.runtimeAuthorizations[index];
      const authorization = runtimeInputs[binding.drill].authorization;
      return {
        drill: binding.drill,
        runtimeDrill: binding.runtimeDrill,
        guest: binding.guest,
        port: provision.guests[index].port,
        unit: provision.guests[index].unit,
        status: 'pending',
        requestPath: requestEntries[index].requestPath,
        requestSha256: sha256Bytes(requestEntries[index].body),
        bundleManifestSha256: entry.bundleManifestSha256,
        runtimeAuthorizationId: authorization.authorizationId,
        runtimeAuthorizationSha256: entry.payloadSha256,
        runtimeAuthorizationSignatureSha256:
          runtimeSignatureDigests[binding.drill],
        readinessPath: null,
        readinessSha256: null,
        completedAt: null,
      };
    }),
  };
  writeStateAtomic(sequenceDirectory, state);
  return {
    status: 'initialized_inactive',
    planId: plan.planId,
    planSha256: planDigest,
    sequenceId: identity.sequenceId,
    next: {
      drill: state.guests[0].drill,
      guest: state.guests[0].guest,
      request: state.guests[0].requestPath,
      requestSha256: state.guests[0].requestSha256,
    },
    actionsPerformed: [],
  };
}

function loadSnapshotContext(planPath) {
  const planSource = readSafeFile(planPath, 'plan');
  const plan = parseJson(planSource.body, 'plan', { canonical: true });
  validatePlan(plan, { nowMs: nowMs(), allowExpired: true });
  const currentClock = controllerClock(plan);
  const planDigest = sha256Bytes(planSource.body);
  const root = validateDirectory(stateRoot(), 'state_root', 0o700);
  const sequenceDirectory = validateDirectory(
    path.join(root, planDigest),
    'sequence_directory',
    0o700,
  );
  const inputs = validateDirectory(
    path.join(sequenceDirectory, 'inputs'),
    'sequence_inputs',
    0o700,
  );
  validateDirectory(
    path.join(inputs, 'runtime-authorizations'),
    'sequence_runtime_authorizations',
    0o700,
  );
  validateDirectory(
    path.join(sequenceDirectory, 'requests'),
    'sequence_requests',
    0o700,
  );
  validateDirectory(
    path.join(sequenceDirectory, 'receipts'),
    'sequence_receipts',
    0o700,
  );
  const snapshotPlan = readSafeFile(path.join(inputs, 'plan.json'), 'snapshot_plan', {
    acceptedModes: [0o600],
  });
  if (!snapshotPlan.body.equals(planSource.body)) fail('plan_snapshot_drifted');
  const generationSource = readSafeFile(
    path.join(inputs, 'generation-manifest.json'),
    'snapshot_generation',
    { acceptedModes: [0o600] },
  );
  const provisionSource = readSafeFile(
    path.join(inputs, 'provision-receipt.json'),
    'snapshot_provision',
    { acceptedModes: [0o600] },
  );
  const ownerKeySource = readSafeFile(
    path.join(inputs, 'guest-owner-public-key.pem'),
    'snapshot_owner_key',
    { maximum: MAX_KEY_BYTES, acceptedModes: [0o600] },
  );
  const allowedSignersSource = readSafeFile(
    path.join(inputs, 'guest-host-allowed-signers'),
    'snapshot_allowed_signers',
    { maximum: MAX_KEY_BYTES, acceptedModes: [0o600] },
  );
  const generation = parseJson(
    generationSource.body,
    'snapshot_generation',
    { canonical: true },
  );
  const provision = validateProvision(
    parseJson(provisionSource.body, 'snapshot_provision'),
  );
  const provisionDigest = sha256Bytes(provisionSource.body);
  validateGeneration(
    generation,
    plan,
    provision,
    provisionDigest,
    nowMs(),
  );
  validatePlanProvisionBindings(plan, provision);
  let ownerPublicKey;
  try {
    ownerPublicKey = createPublicKey(ownerKeySource.body);
  } catch {
    fail('snapshot_owner_key_invalid');
  }
  if (ownerPublicKey.asymmetricKeyType !== 'ed25519') {
    fail('snapshot_owner_key_not_ed25519');
  }
  const ownerKeyDigest = publicKeyIdentity(ownerKeySource.body.toString('utf8'));
  if (ownerKeyDigest !== plan.trust.guestOwnerPublicKeySha256) {
    fail('snapshot_owner_key_plan_mismatch');
  }
  const expectedAllowedSigners = Buffer.from(
    provision.guests
      .map((guest) => `${guest.name} ${guest.hostPublicKey.trim()}`)
      .join('\n') + '\n',
    'utf8',
  );
  if (!allowedSignersSource.body.equals(expectedAllowedSigners)) {
    fail('snapshot_allowed_signers_drifted');
  }

  const runtimeInputs = {};
  const runtimeSignatureDigests = {};
  BINDINGS.forEach((binding, index) => {
    const paths = runtimePaths(sequenceDirectory, binding);
    const authorizationSource = readSafeFile(
      paths.authorization,
      `snapshot_runtime_authorization_${binding.drill}`,
      { acceptedModes: [0o600] },
    );
    const signatureSource = readSafeFile(
      paths.signature,
      `snapshot_runtime_signature_${binding.drill}`,
      {
        maximum: MAX_SIGNATURE_BYTES,
        acceptedModes: [0o600],
      },
    );
    if (signatureSource.body.length !== 64) {
      fail(`snapshot_runtime_signature_size_invalid:${binding.drill}`);
    }
    const authorization = validateRuntimeAuthorization(
      parseJson(
        authorizationSource.body,
        `snapshot_runtime_authorization_${binding.drill}`,
        { canonical: true },
      ),
      binding,
      plan,
      provision,
      provisionDigest,
      generation.runtimeAuthorizations[index],
      generation.generatedAt,
      ownerKeyDigest,
      nowMs(),
      currentClock,
      { requireCurrent: false },
    );
    if (sha256Bytes(authorizationSource.body)
        !== generation.runtimeAuthorizations[index].payloadSha256
        || !verifySignature(
          null,
          authorizationSource.body,
          ownerPublicKey,
          signatureSource.body,
        )) {
      fail(`snapshot_runtime_signature_invalid:${binding.drill}`);
    }
    runtimeSignatureDigests[binding.drill] =
      sha256Bytes(signatureSource.body);
    runtimeInputs[binding.drill] = {
      authorization,
      authorizationBody: authorizationSource.body,
      signatureBody: signatureSource.body,
    };
  });
  const identity = initialIdentity({
    plan,
    planDigest,
    generationDigest: sha256Bytes(generationSource.body),
    provisionDigest,
    ownerKeyDigest,
    runtimeSignatureDigests,
  });
  const requests = BINDINGS.map((binding, index) => {
    const expected = buildRequest(
      identity,
      binding,
      provision.guests[index],
      generation.runtimeAuthorizations[index],
      runtimeInputs[binding.drill].authorization,
    );
    const requestPath = path.join(
      sequenceDirectory,
      'requests',
      `${binding.drill}.json`,
    );
    const source = readSafeFile(
      requestPath,
      `snapshot_request_${binding.drill}`,
      { acceptedModes: [0o600] },
    );
    const request = validateRequest(
      parseJson(source.body, `snapshot_request_${binding.drill}`, {
        canonical: true,
      }),
      expected,
      `snapshot_request_${binding.drill}`,
    );
    return { request, body: source.body, path: requestPath };
  });
  return {
    root,
    sequenceDirectory,
    inputs,
    plan,
    planDigest,
    generation,
    generationSource,
    provision,
    provisionSource,
    provisionDigest,
    ownerPublicKey,
    ownerKeyDigest,
    ownerKeySource,
    allowedSignersPath: allowedSignersSource.path,
    runtimeInputs,
    runtimeSignatureDigests,
    identity,
    requests,
    currentClock,
  };
}

function validateState(context) {
  const source = readSafeFile(
    path.join(context.sequenceDirectory, 'state.json'),
    'sequence_state',
    { acceptedModes: [0o600] },
  );
  const state = exactObject(
    parseJson(source.body, 'sequence_state', { canonical: true }),
    STATE_FIELDS,
    'sequence_state',
  );
  if (state.schema !== STATE_SCHEMA
      || state.sequenceId !== context.identity.sequenceId
      || state.planId !== context.plan.planId
      || state.planSha256 !== context.planDigest
      || state.generationManifestSha256
        !== sha256Bytes(context.generationSource.body)
      || state.provisionReceiptSha256 !== context.provisionDigest
      || state.guestOwnerPublicKeySha256 !== context.ownerKeyDigest
      || state.controllerBootIdSha256
        !== context.currentClock.bootIdSha256
      || state.executionMode !== EXECUTION_MODE
      || JSON.stringify(state.orderedDrills) !== JSON.stringify(DRILL_NAMES)
      || !Array.isArray(state.guests) || state.guests.length !== 3) {
    fail('sequence_state_binding_invalid');
  }
  requireInteger(
    state.monotonicStartedSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'sequence_state_monotonic_start_invalid',
  );
  requireInteger(
    state.monotonicDeadlineSeconds,
    1,
    Number.MAX_SAFE_INTEGER,
    'sequence_state_monotonic_deadline_invalid',
  );
  requireInteger(
    state.lastObservedMonotonicSeconds,
    0,
    Number.MAX_SAFE_INTEGER,
    'sequence_state_monotonic_observation_invalid',
  );
  const expectedMonotonicDeadline = Math.min(
    ...BINDINGS.map(
      (binding) => context.runtimeInputs[binding.drill]
        .authorization.expiresMonotonicSeconds,
    ),
  );
  if (state.monotonicDeadlineSeconds !== expectedMonotonicDeadline
      || state.monotonicDeadlineSeconds <= state.monotonicStartedSeconds
      || state.lastObservedMonotonicSeconds < state.monotonicStartedSeconds
      || state.lastObservedMonotonicSeconds
        > state.monotonicDeadlineSeconds
      || context.currentClock.monotonicSeconds
        < state.lastObservedMonotonicSeconds) {
    fail('sequence_state_monotonic_window_invalid');
  }
  const currentTime = nowMs();
  const createdAt = parseIso(
    state.createdAt,
    'sequence_state_created_invalid',
  );
  const updatedAt = parseIso(
    state.updatedAt,
    'sequence_state_updated_invalid',
  );
  if (createdAt > currentTime + CLOCK_SKEW_MS
      || updatedAt < createdAt
      || updatedAt > currentTime + CLOCK_SKEW_MS) {
    fail('sequence_state_timestamp_binding_invalid');
  }
  let completedAt = null;
  if (state.completedAt !== null) {
    completedAt = parseIso(
      state.completedAt,
      'sequence_state_completed_invalid',
    );
    if (completedAt !== updatedAt) {
      fail('sequence_state_completed_timestamp_binding_invalid');
    }
  }
  requireInteger(state.nextIndex, 0, 3, 'sequence_state_next_index_invalid');
  let activeCount = 0;
  let completedCount = 0;
  let latestTransitionAt = createdAt;
  state.guests.forEach((guestState, index) => {
    exactObject(guestState, STATE_GUEST_FIELDS, 'sequence_state_guest');
    const binding = BINDINGS[index];
    const provisionGuest = context.provision.guests[index];
    const generationEntry = context.generation.runtimeAuthorizations[index];
    const authorization = context.runtimeInputs[binding.drill].authorization;
    const request = context.requests[index];
    if (guestState.drill !== binding.drill
        || guestState.runtimeDrill !== binding.runtimeDrill
        || guestState.guest !== binding.guest
        || guestState.port !== provisionGuest.port
        || guestState.unit !== provisionGuest.unit
        || guestState.requestPath !== request.path
        || guestState.requestSha256 !== sha256Bytes(request.body)
        || guestState.bundleManifestSha256
          !== generationEntry.bundleManifestSha256
        || guestState.runtimeAuthorizationId !== authorization.authorizationId
        || guestState.runtimeAuthorizationSha256 !== generationEntry.payloadSha256
        || guestState.runtimeAuthorizationSignatureSha256
          !== context.runtimeSignatureDigests[binding.drill]
        || !['pending', 'active', 'complete'].includes(guestState.status)) {
      fail(`sequence_state_guest_binding_invalid:${binding.drill}`);
    }
    if (guestState.status === 'complete') {
      completedCount += 1;
      requireDigest(
        guestState.readinessSha256,
        `sequence_state_readiness_digest_invalid:${binding.drill}`,
      );
      const guestCompletedAt = parseIso(
        guestState.completedAt,
        `sequence_state_guest_completed_invalid:${binding.drill}`,
      );
      if (guestCompletedAt < latestTransitionAt
          || guestCompletedAt > updatedAt) {
        fail(`sequence_state_guest_timestamp_binding_invalid:${binding.drill}`);
      }
      latestTransitionAt = guestCompletedAt;
      const expectedReadinessPath = path.join(
        context.sequenceDirectory,
        'receipts',
        binding.drill,
        'readiness.json',
      );
      if (guestState.readinessPath !== expectedReadinessPath) {
        fail(`sequence_state_readiness_path_invalid:${binding.drill}`);
      }
      const verified = verifyReceiptDirectory(
        context,
        index,
        path.dirname(expectedReadinessPath),
      );
      if (verified.readinessSha256 !== guestState.readinessSha256) {
        fail(`sequence_state_readiness_drifted:${binding.drill}`);
      }
    } else if (guestState.readinessPath !== null
        || guestState.readinessSha256 !== null
        || guestState.completedAt !== null) {
      fail(`sequence_state_unfinished_receipt_invalid:${binding.drill}`);
    }
    if (guestState.status === 'active') activeCount += 1;
  });
  if (completedCount !== state.nextIndex || activeCount > 1
      || state.guests.some((entry, index) => (
        index < state.nextIndex
          ? entry.status !== 'complete'
          : index === state.nextIndex && state.active
              ? entry.status !== 'active'
              : entry.status !== 'pending'
      ))) {
    fail('sequence_state_transition_invalid');
  }
  if (state.active === null) {
    if (activeCount !== 0) fail('sequence_state_active_missing');
  } else {
    exactObject(state.active, ACTIVE_FIELDS, 'sequence_state_active');
    if (state.nextIndex >= 3) fail('sequence_state_active_after_completion');
    const expected = state.guests[state.nextIndex];
    if (state.active.drill !== expected.drill
        || state.active.guest !== expected.guest
        || state.active.requestSha256 !== expected.requestSha256
        || expected.status !== 'active') {
      fail('sequence_state_active_binding_invalid');
    }
    const claimedAt = parseIso(
      state.active.claimedAt,
      'sequence_state_claimed_at_invalid',
    );
    requireInteger(
      state.active.claimedMonotonicSeconds,
      state.monotonicStartedSeconds,
      state.monotonicDeadlineSeconds - 1,
      'sequence_state_claimed_monotonic_invalid',
    );
    if (claimedAt < latestTransitionAt || claimedAt !== updatedAt
        || claimedAt > currentTime + CLOCK_SKEW_MS
        || state.active.claimedMonotonicSeconds
          > state.lastObservedMonotonicSeconds) {
      fail('sequence_state_claimed_at_binding_invalid');
    }
    latestTransitionAt = claimedAt;
  }
  if ((state.nextIndex === 3) !== (state.completedAt !== null)
      || (state.nextIndex === 3 && state.active !== null)) {
    fail('sequence_state_completion_invalid');
  }
  if (state.active === null && state.nextIndex < 3
      && updatedAt !== latestTransitionAt) {
    fail('sequence_state_idle_timestamp_binding_invalid');
  }
  if (completedAt !== null && completedAt !== latestTransitionAt) {
    fail('sequence_state_final_timestamp_binding_invalid');
  }
  return state;
}

function expectedCompletedLedger(context, state) {
  if (state.nextIndex !== BINDINGS.length || state.completedAt === null
      || state.active !== null
      || state.guests.some((guest) => guest.status !== 'complete')) {
    fail('completed_ledger_sequence_incomplete');
  }
  return {
    schema: COMPLETED_LEDGER_SCHEMA,
    status: 'all_runtime_readiness_complete',
    sequenceId: state.sequenceId,
    planId: state.planId,
    planSha256: state.planSha256,
    generationManifestSha256: state.generationManifestSha256,
    provisionReceiptSha256: state.provisionReceiptSha256,
    guestOwnerPublicKeySha256: state.guestOwnerPublicKeySha256,
    controllerBootIdSha256: state.controllerBootIdSha256,
    monotonicStartedSeconds: state.monotonicStartedSeconds,
    monotonicDeadlineSeconds: state.monotonicDeadlineSeconds,
    monotonicCompletedSeconds: state.lastObservedMonotonicSeconds,
    completedAt: state.completedAt,
    orderedReadiness: state.guests.map((guest) => ({
      drill: guest.drill,
      runtimeDrill: guest.runtimeDrill,
      guest: guest.guest,
      requestSha256: guest.requestSha256,
      readinessSha256: guest.readinessSha256,
      completedAt: guest.completedAt,
    })),
    stateSha256: sha256Bytes(
      Buffer.from(canonicalJson(state), 'utf8'),
    ),
  };
}

function validateCompletedLedger(context, state, ledger) {
  exactObject(ledger, COMPLETED_LEDGER_FIELDS, 'completed_ledger');
  if (!Array.isArray(ledger.orderedReadiness)
      || ledger.orderedReadiness.length !== BINDINGS.length) {
    fail('completed_ledger_entries_invalid');
  }
  ledger.orderedReadiness.forEach((entry) => {
    exactObject(
      entry,
      COMPLETED_LEDGER_ENTRY_FIELDS,
      'completed_ledger_entry',
    );
  });
  const expected = expectedCompletedLedger(context, state);
  if (canonicalJson(ledger) !== canonicalJson(expected)) {
    fail('completed_ledger_binding_invalid');
  }
  return ledger;
}

function publishCompletedLedger(context, state) {
  const ledger = expectedCompletedLedger(context, state);
  const body = Buffer.from(canonicalJson(ledger), 'utf8');
  const ledgerPath = path.join(
    context.sequenceDirectory,
    'completed-ledger.json',
  );
  ensureSnapshot(
    ledgerPath,
    body,
    'completed_ledger',
  );
  const source = readSafeFile(ledgerPath, 'completed_ledger', {
    acceptedModes: [0o600],
  });
  const validated = validateCompletedLedger(
    context,
    state,
    parseJson(source.body, 'completed_ledger', { canonical: true }),
  );
  return {
    path: ledgerPath,
    sha256: sha256Bytes(source.body),
    attestation: validated,
  };
}

function readCompletedLedger(context, state) {
  const ledgerPath = path.join(
    context.sequenceDirectory,
    'completed-ledger.json',
  );
  const source = readSafeFile(ledgerPath, 'completed_ledger', {
    acceptedModes: [0o600],
  });
  return {
    path: ledgerPath,
    sha256: sha256Bytes(source.body),
    attestation: validateCompletedLedger(
      context,
      state,
      parseJson(source.body, 'completed_ledger', { canonical: true }),
    ),
  };
}

function verifyGuestSignature(
  allowedSignersPath,
  guest,
  signaturePath,
  measurementBody,
) {
  if (!existsSync(SSH_KEYGEN)) fail('ssh_keygen_missing');
  const result = spawnSync(
    SSH_KEYGEN,
    [
      '-Y',
      'verify',
      '-f',
      allowedSignersPath,
      '-I',
      guest,
      '-n',
      MEASUREMENT_NAMESPACE,
      '-s',
      signaturePath,
    ],
    {
      input: measurementBody,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (result.status !== 0) fail('guest_measurement_signature_invalid');
}

function validateMeasurementRuntime(context, measurement) {
  exactObject(
    measurement.runtime,
    MEASUREMENT_RUNTIME_FIELDS,
    'receipt_measurement_runtime',
  );
  const node = exactObject(
    measurement.runtime.node,
    MEASUREMENT_NODE_FIELDS,
    'receipt_measurement_node',
  );
  const python = exactObject(
    measurement.runtime.python,
    MEASUREMENT_PYTHON_FIELDS,
    'receipt_measurement_python',
  );
  const pm2 = exactObject(
    measurement.runtime.pm2,
    MEASUREMENT_PM2_FIELDS,
    'receipt_measurement_pm2',
  );
  for (const [value, fields, label] of [
    [node, ['sha256', 'treeSha256'], 'node'],
    [python, ['sha256'], 'python'],
    [
      pm2,
      [
        'sha256',
        'entrypointSha256',
        'attestationSha256',
        'treeSha256',
      ],
      'pm2',
    ],
  ]) {
    for (const field of fields) {
      requireDigest(
        value[field],
        `receipt_measurement_${label}_${field}_invalid`,
      );
    }
  }
  if (node.version !== 'v22.23.1'
      || node.path !== '/usr/bin/node'
      || node.owner !== 'root:root'
      || node.mode !== '755'
      || node.linkCount !== 1
      || !/^3\.12\.\d+(?:[A-Za-z0-9.+~-]*)?$/u.test(python.version)
      || python.path !== '/usr/bin/python3.12'
      || !SAFE_PACKAGE.test(python.packageName)
      || !SAFE_PACKAGE_VERSION.test(python.packageVersion)
      || python.packageArchitecture !== 'amd64'
      || pm2.version !== '6.0.14'
      || pm2.path !== '/usr/local/bin/pm2'
      || pm2.entrypointPath
        !== '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2'
      || pm2.attestationPath
        !== '/var/lib/nexus-release-promotion/pm2-root-install.v1.json'
      || pm2.owner !== 'root:root'
      || !/^[0-7]{3,4}$/u.test(pm2.mode)
      || (Number.parseInt(pm2.mode, 8) & 0o022) !== 0) {
    fail('receipt_measurement_runtime_policy_invalid');
  }
  const control = exactObject(
    measurement.control,
    MEASUREMENT_CONTROL_FIELDS,
    'receipt_measurement_control',
  );
  if (control.version !== 'nexus-release-promotion-control.v3'
      || control.sourceCommit !== context.plan.sourceRootSha
      || control.assertIdle !== true
      || !Array.isArray(control.files)
      || !Array.isArray(control.generatedFiles)
      || !Array.isArray(control.serviceStates)
      || !control.runtimeRecovery
      || typeof control.runtimeRecovery !== 'object'
      || control.runtimeRecovery.sha256
        !== context.provision.hypervisor.runtimeRecoveryUnitSha256) {
    fail('receipt_measurement_control_binding_invalid');
  }
  const pm2DryHealth = exactObject(
    measurement.pm2DryHealth,
    MEASUREMENT_PM2_HEALTH_FIELDS,
    'receipt_measurement_pm2_health',
  );
  if (canonicalJson(pm2DryHealth) !== canonicalJson({
    status: 'passed',
    isolatedHome: true,
    daemonStopped: true,
    processCount: 0,
  })) {
    fail('receipt_measurement_pm2_health_invalid');
  }
}

function validateReceiptEvidence(context, index, files) {
  const binding = BINDINGS[index];
  const request = context.requests[index].request;
  const guest = context.provision.guests[index];
  const authorization = parseJson(
    files['authorization.json'].body,
    'receipt_authorization',
    { canonical: true },
  );
  const currentTime = nowMs();
  validateRuntimeAuthorization(
    authorization,
    binding,
    context.plan,
    context.provision,
    context.provisionDigest,
    context.generation.runtimeAuthorizations[index],
    context.generation.generatedAt,
    context.ownerKeyDigest,
    currentTime,
    context.currentClock,
    { requireCurrent: false },
  );
  if (!files['authorization.json'].body.equals(
    context.runtimeInputs[binding.drill].authorizationBody,
  ) || !files['authorization.sig'].body.equals(
    context.runtimeInputs[binding.drill].signatureBody,
  ) || !verifySignature(
    null,
    files['authorization.json'].body,
    context.ownerPublicKey,
    files['authorization.sig'].body,
  )) {
    fail('receipt_owner_authorization_invalid');
  }

  const measurement = exactObject(
    parseJson(files['measurement.json'].body, 'receipt_measurement', {
      canonical: true,
    }),
    MEASUREMENT_FIELDS,
    'receipt_measurement',
  );
  exactObject(
    measurement.machine,
    MEASUREMENT_MACHINE_FIELDS,
    'receipt_measurement_machine',
  );
  if (measurement.schema !== MEASUREMENT_SCHEMA
      || measurement.status !== 'guest_checks_passed'
      || measurement.drillReady !== false
      || measurement.pendingHostOverlaySeal !== true
      || measurement.setId !== context.provision.setId
      || measurement.guest !== binding.guest
      || measurement.provisionReceiptSha256 !== context.provisionDigest
      || measurement.bundleManifestSha256 !== request.bundleManifestSha256
      || measurement.machine.uuid !== guest.uuid
      || measurement.machine.instanceId !== guest.instanceId
      || measurement.machine.sshHostKeyFingerprint
        !== guest.hostKeyFingerprint
      || measurement.machine.sshHostPublicKeySha256
        !== guest.hostPublicKeySha256
      || measurement.networkInstallAttempted !== false) {
    fail('receipt_measurement_binding_invalid');
  }
  requireDigest(measurement.challenge, 'receipt_measurement_challenge_invalid');
  validateMeasurementRuntime(context, measurement);
  const capturedAt = parseIso(
    measurement.capturedAt,
    'receipt_measurement_timestamp_invalid',
  );
  const authorizationIssuedAt = parseIso(
    authorization.issuedAt,
    'runtime_authorization_issued_invalid',
  );
  const authorizationExpiresAt = parseIso(
    authorization.expiresAt,
    'runtime_authorization_expires_invalid',
  );
  const earliestEvidenceTime = Math.max(
    authorizationIssuedAt,
    parseIso(context.plan.createdAt, 'plan_created_at_invalid'),
    parseIso(
      context.provision.createdAt,
      'provision_created_at_invalid',
    ),
    parseIso(
      context.generation.generatedAt,
      'generation_timestamp_invalid',
    ),
  );
  if (capturedAt < earliestEvidenceTime
      || capturedAt > authorizationExpiresAt
      || capturedAt > currentTime + CLOCK_SKEW_MS) {
    fail('receipt_measurement_timestamp_binding_invalid');
  }
  verifyGuestSignature(
    context.allowedSignersPath,
    binding.guest,
    files['measurement.sig'].path,
    files['measurement.json'].body,
  );

  const journal = exactObject(
    parseJson(files['journal.json'].body, 'receipt_journal', {
      canonical: true,
    }),
    JOURNAL_FIELDS,
    'receipt_journal',
  );
  if (journal.schema !== COLLECTION_JOURNAL_SCHEMA
      || journal.status !== 'readiness_published'
      || journal.authorizationId !== authorization.authorizationId
      || journal.authorizationSha256
        !== sha256Bytes(files['authorization.json'].body)
      || journal.authorizationSignatureSha256
        !== sha256Bytes(files['authorization.sig'].body)
      || journal.setId !== context.provision.setId
      || journal.guest !== binding.guest
      || journal.provisionReceiptSha256 !== context.provisionDigest
      || journal.bundleManifestSha256 !== request.bundleManifestSha256
      || journal.challenge !== measurement.challenge
      || journal.measurementSha256
        !== sha256Bytes(files['measurement.json'].body)
      || journal.measurementSignatureSha256
        !== sha256Bytes(files['measurement.sig'].body)) {
    fail('receipt_journal_binding_invalid');
  }
  requireDigest(journal.nonce, 'receipt_journal_nonce_invalid');
  requireInteger(journal.supervisorPid, 1, 2 ** 31 - 1, 'receipt_supervisor_invalid');
  requireInteger(journal.qemuPid, 1, 2 ** 31 - 1, 'receipt_qemu_invalid');

  const liveQemu = exactObject(
    parseJson(files['live-qemu.json'].body, 'receipt_live_qemu', {
      canonical: true,
    }),
    LIVE_QEMU_FIELDS,
    'receipt_live_qemu',
  );
  if (liveQemu.supervisorPid !== journal.supervisorPid
      || liveQemu.supervisorStartTime !== journal.supervisorStartTime
      || liveQemu.qemuPid !== journal.qemuPid
      || liveQemu.qemuStartTime !== journal.qemuStartTime
      || liveQemu.qemuExecutable
        !== context.provision.hypervisor.qemuBinary
      || liveQemu.qemuExecutableSha256
        !== context.provision.hypervisor.qemuSha256
      || !DIGEST.test(liveQemu.supervisorCmdlineSha256)
      || !DIGEST.test(liveQemu.qemuCmdlineSha256)
      || !/^\d+$/u.test(liveQemu.supervisorStartTime)
      || !/^\d+$/u.test(liveQemu.qemuStartTime)
      || !/^\d+$/u.test(liveQemu.loopbackPortSocketInode)) {
    fail('receipt_live_qemu_binding_invalid');
  }
  return {
    authorization,
    measurement,
    journal,
    liveQemu,
    capturedAt,
    authorizationExpiresAt,
  };
}

function validateReadiness(context, index, readiness, readinessBody, evidence) {
  const binding = BINDINGS[index];
  const request = context.requests[index].request;
  const guest = context.provision.guests[index];
  exactObject(readiness, READINESS_FIELDS, 'readiness');
  exactObject(
    readiness.ownerAuthorization,
    READINESS_AUTH_FIELDS,
    'readiness_owner_authorization',
  );
  exactObject(
    readiness.guestMeasurement,
    READINESS_MEASUREMENT_FIELDS,
    'readiness_guest_measurement',
  );
  exactObject(readiness.machine, READINESS_MACHINE_FIELDS, 'readiness_machine');
  exactObject(readiness.qemu, READINESS_QEMU_FIELDS, 'readiness_qemu');
  exactObject(
    readiness.stoppedGuestProof,
    READINESS_STOPPED_FIELDS,
    'readiness_stopped_guest',
  );
  exactObject(readiness.overlay, READINESS_OVERLAY_FIELDS, 'readiness_overlay');
  if (readiness.schema !== RUNTIME_READINESS_SCHEMA
      || readiness.status !== 'ready'
      || readiness.drillReady !== true
      || readiness.setId !== context.provision.setId
      || readiness.guest !== binding.guest
      || readiness.port !== guest.port
      || readiness.provisionReceiptSha256 !== context.provisionDigest
      || readiness.bundleManifestSha256 !== request.bundleManifestSha256
      || readiness.ownerAuthorization.authorizationId
        !== evidence.authorization.authorizationId
      || readiness.ownerAuthorization.drill !== binding.runtimeDrill
      || readiness.ownerAuthorization.issuedAt
        !== evidence.authorization.issuedAt
      || readiness.ownerAuthorization.expiresAt
        !== evidence.authorization.expiresAt
      || readiness.ownerAuthorization.controllerBootIdSha256
        !== evidence.authorization.controllerBootIdSha256
      || readiness.ownerAuthorization.issuedMonotonicSeconds
        !== evidence.authorization.issuedMonotonicSeconds
      || readiness.ownerAuthorization.expiresMonotonicSeconds
        !== evidence.authorization.expiresMonotonicSeconds
      || readiness.ownerAuthorization.sha256
        !== sha256Bytes(evidence.files['authorization.json'].body)
      || readiness.ownerAuthorization.signatureSha256
        !== sha256Bytes(evidence.files['authorization.sig'].body)
      || readiness.ownerAuthorization.ownerPublicKeySha256
        !== context.ownerKeyDigest
      || readiness.guestMeasurement.sha256
        !== sha256Bytes(evidence.files['measurement.json'].body)
      || readiness.guestMeasurement.signatureSha256
        !== sha256Bytes(evidence.files['measurement.sig'].body)
      || readiness.guestMeasurement.challenge
        !== evidence.measurement.challenge
      || readiness.guestMeasurement.namespace !== MEASUREMENT_NAMESPACE
      || readiness.machine.uuid !== guest.uuid
      || readiness.machine.instanceId !== guest.instanceId
      || readiness.machine.mac !== guest.mac
      || readiness.machine.sshHostKeyFingerprint !== guest.hostKeyFingerprint
      || readiness.machine.sshHostPublicKeySha256
        !== guest.hostPublicKeySha256
      || readiness.qemu.unit !== guest.unit
      || readiness.qemu.supervisorPid !== evidence.liveQemu.supervisorPid
      || readiness.qemu.supervisorStartTime
        !== evidence.liveQemu.supervisorStartTime
      || readiness.qemu.supervisorCmdlineSha256
        !== evidence.liveQemu.supervisorCmdlineSha256
      || readiness.qemu.pid !== evidence.liveQemu.qemuPid
      || readiness.qemu.startTime !== evidence.liveQemu.qemuStartTime
      || readiness.qemu.executable !== evidence.liveQemu.qemuExecutable
      || readiness.qemu.executableSha256
        !== evidence.liveQemu.qemuExecutableSha256
      || readiness.qemu.cmdlineSha256
        !== evidence.liveQemu.qemuCmdlineSha256
      || readiness.qemu.loopbackPortSocketInode
        !== evidence.liveQemu.loopbackPortSocketInode
      || readiness.stoppedGuestProof.unit !== guest.unit
      || readiness.stoppedGuestProof.admissionLockHeld !== true
      || !['runner-supervisor', 'root-collector'].includes(
        readiness.stoppedGuestProof.activeLockHolder,
      )
      || readiness.stoppedGuestProof.sharedReleaseSonarLockHolder
        !== readiness.stoppedGuestProof.activeLockHolder
      || readiness.stoppedGuestProof.handoffNonce !== evidence.journal.nonce
      || readiness.stoppedGuestProof.qemuExited !== true
      || readiness.stoppedGuestProof.overlayProcessAbsent !== true
      || readiness.overlay.path !== guest.overlayPath
      || readiness.overlay.initialSha256 !== guest.overlayInitialSha256
      || !DIGEST.test(readiness.overlay.currentSha256)
      || readiness.overlay.stableDescriptor !== true
      || canonicalJson(readiness.runtime)
        !== canonicalJson(evidence.measurement.runtime)
      || canonicalJson(readiness.control) !== canonicalJson(evidence.measurement.control)
      || canonicalJson(readiness.pm2DryHealth)
        !== canonicalJson(evidence.measurement.pm2DryHealth)
      || readiness.networkInstallAttempted !== false) {
    fail('readiness_binding_invalid');
  }
  const sealedAt = parseIso(
    readiness.sealedAt,
    'readiness_sealed_at_invalid',
  );
  if (sealedAt < evidence.capturedAt
      || sealedAt > evidence.authorizationExpiresAt
      || sealedAt > nowMs() + CLOCK_SKEW_MS) {
    fail('readiness_sealed_at_binding_invalid');
  }
  requireInteger(
    readiness.stoppedGuestProof.holderPid,
    1,
    2 ** 31 - 1,
    'readiness_holder_pid_invalid',
  );
  for (const field of ['size', 'device', 'inode', 'mtimeNs', 'ctimeNs']) {
    requireInteger(
      readiness.overlay[field],
      1,
      Number.MAX_SAFE_INTEGER,
      `readiness_overlay_${field}_invalid`,
    );
  }
  if (typeof readiness.stoppedGuestProof.holderStartTime !== 'string'
      || !/^\d+$/u.test(readiness.stoppedGuestProof.holderStartTime)) {
    fail('readiness_holder_start_time_invalid');
  }
  const stoppedProof = readiness.stoppedGuestProof;
  if (![
    'active-handoff-wait',
    'inactive-recovery',
  ].includes(stoppedProof.systemdState)
      || (stoppedProof.systemdState === 'active-handoff-wait'
        && (stoppedProof.activeLockHolder !== 'runner-supervisor'
          || stoppedProof.holderPid !== evidence.journal.supervisorPid
          || stoppedProof.holderStartTime
            !== evidence.journal.supervisorStartTime))
      || (stoppedProof.systemdState === 'inactive-recovery'
        && stoppedProof.activeLockHolder !== 'root-collector')) {
    fail('readiness_stopped_guest_binding_invalid');
  }
  if (readinessBody.length <= 0) fail('readiness_empty');
  return readiness;
}

function readEvidenceDirectory(directory, label = 'readiness_evidence') {
  const resolved = validateDirectory(directory, label);
  const observed = readdirSync(resolved, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const expected = [...EVIDENCE_FILES].sort();
  if (observed.length !== expected.length
      || observed.some((name, index) => name !== expected[index])) {
    fail(`${label}_layout_invalid`);
  }
  const files = {};
  for (const name of EVIDENCE_FILES) {
    files[name] = readSafeFile(
      path.join(resolved, name),
      `${label}_${name.replaceAll('.', '_')}`,
      {
        maximum: name.endsWith('.sig')
          ? MAX_SIGNATURE_BYTES
          : MAX_JSON_BYTES,
        acceptedModes: [0o600],
      },
    );
  }
  return { path: resolved, files };
}

function verifyReceiptInputs(context, index, readinessPath, evidenceDirectory) {
  const readinessSource = readSafeFile(
    readinessPath,
    'readiness_receipt',
    { acceptedModes: [0o600, 0o640] },
  );
  const evidenceInput = readEvidenceDirectory(evidenceDirectory);
  const evidenceValues = validateReceiptEvidence(
    context,
    index,
    evidenceInput.files,
  );
  const evidence = {
    ...evidenceValues,
    files: evidenceInput.files,
  };
  const readiness = validateReadiness(
    context,
    index,
    parseJson(readinessSource.body, 'readiness_receipt', { canonical: true }),
    readinessSource.body,
    evidence,
  );
  return {
    readiness,
    readinessBody: readinessSource.body,
    readinessSha256: sha256Bytes(readinessSource.body),
    evidenceFiles: evidenceInput.files,
    measurementCapturedAt: evidenceValues.capturedAt,
    readinessSealedAt: parseIso(
      readiness.sealedAt,
      'readiness_sealed_at_invalid',
    ),
  };
}

function verifyReceiptDirectory(context, index, directory) {
  const resolved = validateDirectory(directory, 'stored_receipt_directory', 0o700);
  const observed = readdirSync(resolved, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort();
  const expected = ['readiness.json', ...EVIDENCE_FILES].sort();
  if (observed.length !== expected.length
      || observed.some((name, position) => name !== expected[position])) {
    fail('stored_receipt_layout_invalid');
  }
  const readinessPath = path.join(resolved, 'readiness.json');
  const evidenceFiles = {};
  for (const name of EVIDENCE_FILES) {
    evidenceFiles[name] = readSafeFile(
      path.join(resolved, name),
      `stored_receipt_${name.replaceAll('.', '_')}`,
      {
        maximum: name.endsWith('.sig')
          ? MAX_SIGNATURE_BYTES
          : MAX_JSON_BYTES,
        acceptedModes: [0o600],
      },
    );
  }
  const readinessSource = readSafeFile(readinessPath, 'stored_readiness', {
    acceptedModes: [0o600],
  });
  const evidenceValues = validateReceiptEvidence(context, index, evidenceFiles);
  validateReadiness(
    context,
    index,
    parseJson(readinessSource.body, 'stored_readiness', { canonical: true }),
    readinessSource.body,
    { ...evidenceValues, files: evidenceFiles },
  );
  return {
    readinessPath,
    readinessSha256: sha256Bytes(readinessSource.body),
    readinessBody: readinessSource.body,
    evidenceFiles,
  };
}

function requestIndex(context, requestPath) {
  const resolved = path.resolve(requestPath);
  const index = context.requests.findIndex((entry) => entry.path === resolved);
  if (index < 0) fail('request_path_outside_sequence');
  const supplied = readSafeFile(resolved, 'sequence_request', {
    acceptedModes: [0o600],
  });
  if (!supplied.body.equals(context.requests[index].body)) {
    fail('sequence_request_drifted');
  }
  return index;
}

function claim(flags) {
  const context = loadSnapshotContext(required(flags, '--plan'));
  const state = validateState(context);
  const currentTime = nowMs();
  const index = requestIndex(context, required(flags, '--request'));
  const expected = state.nextIndex;
  if (index < expected) fail('request_replay_rejected');
  if (index > expected) {
    fail(state.active ? 'another_guest_active' : 'request_out_of_order');
  }
  if (state.nextIndex === 3) fail('sequence_already_complete');
  if (currentTime < Date.parse(state.updatedAt)) {
    fail('sequence_clock_rollback_detected');
  }
  if (currentTime >= Date.parse(context.plan.expiresAt)
      || currentTime >= Date.parse(
        context.runtimeInputs[BINDINGS[index].drill].authorization.expiresAt,
      )
      || context.currentClock.monotonicSeconds
        >= context.runtimeInputs[BINDINGS[index].drill]
          .authorization.expiresMonotonicSeconds) {
    fail('request_stale');
  }
  if (state.active) {
    if (state.active.requestSha256
        !== state.guests[index].requestSha256) {
      fail('another_guest_active');
    }
    return {
      status: 'active_resume_required',
      alreadyClaimed: true,
      planId: state.planId,
      sequenceId: state.sequenceId,
      active: state.active,
      request: state.guests[index].requestPath,
      actionsPerformed: [],
    };
  }
  const timestamp = isoSeconds(currentTime);
  state.guests[index].status = 'active';
  state.active = {
    drill: BINDINGS[index].drill,
    guest: BINDINGS[index].guest,
    requestSha256: state.guests[index].requestSha256,
    claimedAt: timestamp,
    claimedMonotonicSeconds: context.currentClock.monotonicSeconds,
  };
  state.updatedAt = timestamp;
  state.lastObservedMonotonicSeconds =
    context.currentClock.monotonicSeconds;
  writeStateAtomic(context.sequenceDirectory, state);
  return {
    status: 'active_request_checkpointed',
    alreadyClaimed: false,
    planId: state.planId,
    sequenceId: state.sequenceId,
    active: state.active,
    request: state.guests[index].requestPath,
    actionsPerformed: [],
  };
}

function publishReceiptSnapshots(context, index, verified) {
  const binding = BINDINGS[index];
  const receipts = path.join(context.sequenceDirectory, 'receipts');
  const finalDirectory = path.join(receipts, binding.drill);
  const stageBasename =
    `.receipt-${binding.drill}-${context.requests[index].request.runtimeAuthorizationId}.next`;
  const stageDirectory = path.join(receipts, stageBasename);
  if (existsSync(finalDirectory)) {
    const stored = verifyReceiptDirectory(context, index, finalDirectory);
    if (stored.readinessSha256 !== verified.readinessSha256
        || EVIDENCE_FILES.some((name) => (
          !stored.evidenceFiles[name].body.equals(
            verified.evidenceFiles[name].body,
          )
        ))) {
      fail('completed_receipt_replay_mismatch');
    }
    return stored;
  }
  if (!existsSync(stageDirectory)) {
    makeDirectory(receipts, stageBasename);
  } else {
    validateDirectory(stageDirectory, 'receipt_stage_directory', 0o700);
  }
  ensureSnapshot(
    path.join(stageDirectory, 'readiness.json'),
    verified.readinessBody,
    'receipt_stage_readiness',
  );
  for (const name of EVIDENCE_FILES) {
    ensureSnapshot(
      path.join(stageDirectory, name),
      verified.evidenceFiles[name].body,
      `receipt_stage_${name.replaceAll('.', '_')}`,
    );
  }
  fsyncDirectory(stageDirectory);
  const stageVerified = verifyReceiptDirectory(context, index, stageDirectory);
  if (stageVerified.readinessSha256 !== verified.readinessSha256) {
    fail('receipt_stage_binding_invalid');
  }
  try {
    renameSync(stageDirectory, finalDirectory);
  } catch {
    fail('receipt_publish_failed');
  }
  fsyncDirectory(receipts);
  return verifyReceiptDirectory(context, index, finalDirectory);
}

function complete(flags) {
  const context = loadSnapshotContext(required(flags, '--plan'));
  const state = validateState(context);
  const currentTime = nowMs();
  const index = requestIndex(context, required(flags, '--request'));
  if (index > state.nextIndex) {
    fail(state.active ? 'another_guest_active' : 'request_out_of_order');
  }
  if (index < state.nextIndex && state.guests[index].status !== 'complete') {
    fail('request_replay_rejected');
  }
  if (index === state.nextIndex
      && (!state.active
        || state.active.requestSha256 !== state.guests[index].requestSha256)) {
    fail('request_not_active');
  }
  if (context.currentClock.monotonicSeconds
      >= context.runtimeInputs[BINDINGS[index].drill]
        .authorization.expiresMonotonicSeconds) {
    fail('request_stale');
  }
  const verified = verifyReceiptInputs(
    context,
    index,
    required(flags, '--readiness'),
    required(flags, '--evidence-dir'),
  );
  if (index === state.nextIndex
      && (verified.measurementCapturedAt < Date.parse(state.active.claimedAt)
        || verified.readinessSealedAt < verified.measurementCapturedAt
        || verified.readinessSealedAt > currentTime)) {
    fail('receipt_active_claim_timestamp_binding_invalid');
  }
  const stored = publishReceiptSnapshots(context, index, verified);
  if (process.env.NODE_ENV === 'test'
      && process.env[TEST_INTERRUPT_AFTER_RECEIPT_ENV] === '1'
      && state.guests[index].status !== 'complete') {
    fail('test_interrupted_after_receipt_publish');
  }
  if (state.guests[index].status === 'complete') {
    if (state.guests[index].readinessSha256 !== stored.readinessSha256) {
      fail('completed_receipt_replay_mismatch');
    }
    const completedLedger = state.nextIndex === BINDINGS.length
      ? publishCompletedLedger(context, state)
      : null;
    return {
      status: 'readiness_already_complete',
      alreadyComplete: true,
      planId: state.planId,
      sequenceId: state.sequenceId,
      drill: BINDINGS[index].drill,
      guest: BINDINGS[index].guest,
      readinessSha256: stored.readinessSha256,
      completedLedger,
      actionsPerformed: [],
    };
  }
  if (currentTime < Date.parse(state.updatedAt)) {
    fail('sequence_clock_rollback_detected');
  }
  const timestamp = isoSeconds(currentTime);
  state.guests[index].status = 'complete';
  state.guests[index].readinessPath = stored.readinessPath;
  state.guests[index].readinessSha256 = stored.readinessSha256;
  state.guests[index].completedAt = timestamp;
  state.nextIndex += 1;
  state.active = null;
  state.updatedAt = timestamp;
  state.lastObservedMonotonicSeconds =
    context.currentClock.monotonicSeconds;
  if (state.nextIndex === 3) state.completedAt = timestamp;
  writeStateAtomic(context.sequenceDirectory, state);
  const completedLedger = state.nextIndex === BINDINGS.length
    ? publishCompletedLedger(context, state)
    : null;
  return {
    status: state.nextIndex === 3
      ? 'all_runtime_readiness_complete'
      : 'runtime_readiness_complete',
    alreadyComplete: false,
    planId: state.planId,
    sequenceId: state.sequenceId,
    drill: BINDINGS[index].drill,
    guest: BINDINGS[index].guest,
    readinessSha256: stored.readinessSha256,
    completedLedger,
    next: state.nextIndex === 3
      ? null
      : {
          drill: state.guests[state.nextIndex].drill,
          guest: state.guests[state.nextIndex].guest,
          request: state.guests[state.nextIndex].requestPath,
          requestSha256: state.guests[state.nextIndex].requestSha256,
        },
    actionsPerformed: [],
  };
}

function status(flags) {
  const context = loadSnapshotContext(required(flags, '--plan'));
  const state = validateState(context);
  const next = state.nextIndex === 3
    ? null
    : {
        drill: state.guests[state.nextIndex].drill,
        guest: state.guests[state.nextIndex].guest,
        request: state.guests[state.nextIndex].requestPath,
        requestSha256: state.guests[state.nextIndex].requestSha256,
      };
  const completedLedger = state.completedAt
    ? readCompletedLedger(context, state)
    : null;
  return {
    status: state.completedAt
      ? 'all_runtime_readiness_complete'
      : state.active
          ? 'active_resume_required'
          : 'next_request_ready',
    planId: state.planId,
    planSha256: state.planSha256,
    sequenceId: state.sequenceId,
    nextIndex: state.nextIndex,
    active: state.active,
    next,
    completedLedger,
    guests: state.guests.map((guest) => ({
      drill: guest.drill,
      guest: guest.guest,
      status: guest.status,
      requestSha256: guest.requestSha256,
      readinessSha256: guest.readinessSha256,
    })),
    actionsPerformed: [],
  };
}

const COMMAND_FLAGS = Object.freeze({
  init: new Set([
    '--plan',
    '--generation-manifest',
    '--provision-receipt',
    '--runtime-authorization-dir',
    '--guest-owner-public-key',
  ]),
  claim: new Set(['--plan', '--request']),
  complete: new Set([
    '--plan',
    '--request',
    '--readiness',
    '--evidence-dir',
  ]),
  status: new Set(['--plan']),
});

function parseFlags(argv) {
  const command = argv.shift() || '';
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) fail('command_unsupported');
  if (argv.length % 2 !== 0) fail('flag_value_missing');
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) fail(`flag_unsupported:${flag}`);
    if (!value || value.startsWith('--')) fail(`flag_value_missing:${flag}`);
    if (flags.has(flag)) fail(`flag_duplicate:${flag}`);
    flags.set(flag, value);
  }
  for (const expected of allowed) {
    if (!flags.has(expected)) fail(`flag_required:${expected}`);
  }
  return { command, flags };
}

function required(flags, name) {
  const value = flags.get(name);
  if (!value) fail(`flag_required:${name}`);
  return value;
}

function runCommand(command, flags) {
  if (command === 'init') return initialize(flags);
  if (command === 'claim') return claim(flags);
  if (command === 'complete') return complete(flags);
  if (command === 'status') return status(flags);
  fail('command_unsupported');
}

function runUnderFixedLock(argv) {
  if (!existsSync(PYTHON)) fail('python_missing');
  const root = stateRoot();
  const command = argv[0] || '';
  const python = String.raw`
import fcntl,json,os,stat,subprocess,sys
root,command,node,script,*arguments=sys.argv[1:]
try:
 if not os.path.isabs(root) or os.path.normpath(root)!=root:
  raise RuntimeError("state_root_invalid")
 if not os.path.exists(root):
  if command!="init":
   raise RuntimeError("state_root_missing")
  os.mkdir(root,0o700)
 parent=os.path.dirname(root)
 if os.path.realpath(root)!=root:
  raise RuntimeError("state_root_not_canonical")
 root_stat=os.lstat(root)
 if (
  not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode)
  or root_stat.st_uid!=os.geteuid()
  or stat.S_IMODE(root_stat.st_mode)!=0o700
 ):
  raise RuntimeError("state_root_unsafe")
 lock=os.path.join(root,"control.lock")
 existed=os.path.exists(lock)
 descriptor=os.open(
  lock,
  os.O_RDWR|os.O_CREAT|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),
  0o600,
 )
 try:
  identity=os.fstat(descriptor)
  path_identity=os.lstat(lock)
  if (
   not stat.S_ISREG(identity.st_mode) or identity.st_nlink!=1
   or identity.st_uid!=os.geteuid() or stat.S_IMODE(identity.st_mode)!=0o600
   or (identity.st_dev,identity.st_ino)!=(path_identity.st_dev,path_identity.st_ino)
  ):
   raise RuntimeError("control_lock_unsafe")
  try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise RuntimeError("control_lock_contended")
  environment=dict(os.environ)
  environment["NEXUS_KVM_READINESS_SEQUENCE_LOCK_HELD"]="1"
  environment["NEXUS_KVM_READINESS_SEQUENCE_LOCK_FD"]=str(descriptor)
  completed=subprocess.run(
   [node,script,*arguments],
   env=environment,
   pass_fds=(descriptor,),
  )
  raise SystemExit(completed.returncode)
 finally:
  os.close(descriptor)
except RuntimeError as error:
 print(json.dumps({"ok":False,"code":str(error)},separators=(",",":")),file=sys.stderr)
 raise SystemExit(1)
`;
  const result = spawnSync(
    PYTHON,
    ['-c', python, root, command, process.execPath, SCRIPT_PATH, ...argv],
    {
      stdio: 'inherit',
      env: process.env,
      timeout: 30_000,
    },
  );
  if (result.error) fail('control_lock_runner_failed');
  process.exitCode = result.status ?? 1;
}

function main() {
  const argv = process.argv.slice(2);
  if (process.env[LOCK_HELD_ENV] !== '1') {
    runUnderFixedLock(argv);
    return;
  }
  validateInheritedControlLock();
  if (process.geteuid?.() !== 0 && process.env.NODE_ENV !== 'test') {
    fail('root_required');
  }
  const { command, flags } = parseFlags(argv);
  const result = runCommand(command, flags);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const code = error instanceof SequenceError
    ? error.code
    : error?.constructor?.name === 'EvidenceError'
        ? error.code
        : error?.code && typeof error.code === 'string'
          ? `filesystem_${String(error.code).toLowerCase()}`
          : 'unexpected_error';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
