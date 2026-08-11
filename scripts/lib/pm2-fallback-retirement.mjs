import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  CANONICAL_TIMESTAMP,
  canonicalJson,
  exactKeys,
  sha256,
} from './release-canonical.mjs';
import { assertReleaseBootstrapBaselineShape } from './release-bootstrap.mjs';
import {
  RELEASE_CONTROL_PLANE_SCHEMA,
  assertReleaseControlPlaneNativeRuntime,
  computeImmutableControlPlaneTreeDigest,
  computeReleaseControlPlaneIdentity,
} from './release-control-plane.mjs';
import {
  BACKUP_HEARTBEAT_MAX_AGE_SECONDS,
  RESTORE_HEARTBEAT_MAX_AGE_SECONDS,
  inspectBackupLiveness,
} from './release-backup-liveness.mjs';
import {
  RELEASE_RECEIPT_OUTCOMES,
  RELEASE_STATUSES,
  assertReleaseReceiptShape,
  assertReleaseStateShape,
  resolveEffectiveRelease,
} from './release-state-store.mjs';

export const PM2_FALLBACK_RETIREMENT_SCHEMA = 'nexus.pm2-fallback-retirement.v1';
export const PM2_FALLBACK_RETIRED_SCHEMA = 'nexus.pm2-fallback-retired.v1';
export const PM2_FALLBACK_RETIREMENT_RECEIPT_SCHEMA =
  'nexus.pm2-fallback-retirement-receipt.v1';
export const PM2_FALLBACK_STABLE_SECONDS = 14 * 24 * 60 * 60;

const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const CONFIRMATION = /^[0-9a-f]{32}:[0-9a-f]{64}:[0-9a-f]{32}:[0-9a-f]{64}$/u;
const PHASES = Object.freeze([
  'admitted',
  'fallback_barred',
  'systemd_retired',
  'closure_detached',
  'package_retired',
  'verified',
]);

const PM2_UNITS = Object.freeze([
  'pm2-dominguez.service',
  'nexus-release-pm2-recovery-daemon.service',
]);
const REQUIRED_TIMERS = Object.freeze([
  'nexus-release-poller.timer',
  'nexus-release-heartbeat.timer',
  'nexus-release-backup-liveness.timer',
  'nexus-local-backup.timer',
  'nexus-local-backup-restore-verify.timer',
]);
const RESUMABLE_SUCCESSFUL_SERVICES = Object.freeze([
  'nexus-local-backup.service',
  'nexus-local-backup-restore-verify.service',
]);
const REQUIRED_SUCCESSFUL_SERVICES = Object.freeze([
  'nexus-release-poller.service',
  ...RESUMABLE_SUCCESSFUL_SERVICES,
]);
const LEGACY_DATABASE_PATHS = Object.freeze([
  '/home/dominguez/telegram-hub-bot/data/bot.db',
  '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
]);

export const PM2_FALLBACK_PRESERVED_PATHS = Object.freeze([
  '/home/dominguez/telegram-hub-bot',
  '/home/dominguez/telegram-hub-bot-staging',
  '/home/dominguez/.pm2',
  '/var/lib/nexus-hub',
  '/etc/nexus-release',
  '/var/lib/nexus-release',
  '/srv/nexus-backups/application',
]);

export const DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS = Object.freeze({
  controlPlaneLock: '/var/lib/nexus-release/locks/control-plane.lock',
  userReleaseLock: '/home/dominguez/.local/state/nexus-release/.release.lock',
  maintenanceLock: '/run/lock/nexus-release-sonar.lock',
  baseline: '/var/lib/nexus-release/state/bootstrap-baseline.json',
  state: '/var/lib/nexus-release/state/release-state.json',
  receiptDir: '/var/lib/nexus-release/receipts',
  journal: '/var/lib/nexus-release/state/pm2-fallback-retirement.json',
  tombstone: '/var/lib/nexus-release/state/pm2-fallback-retired.json',
  retirementRoot: '/var/lib/nexus-release/retirements/pm2-fallback',
  recovery: '/var/lib/nexus-release/state/bootstrap-first-cutover-recovery.json',
  controlPlaneTransaction: '/var/lib/nexus-release/state/control-plane-transaction.json',
  controlPlanePostGate: '/var/lib/nexus-release/state/control-plane-post-gate.json',
  controlPlaneFinalization: '/var/lib/nexus-release/state/control-plane-finalization.json',
  pm2Attestation: '/var/lib/nexus-release-promotion/pm2-root-install.v1.json',
  pm2InstallJournal: '/var/lib/nexus-release-promotion/pm2-install-in-progress.v1.json',
  pm2Prefix: '/opt/nexus-release/pm2',
  pm2Launcher: '/usr/local/bin/pm2',
  pm2Lock: '/usr/local/share/nexus-release/pm2-package-lock.json',
  guardRoot: '/etc/systemd/system.control',
  unitRoot: '/etc/systemd/system',
});

export class Pm2FallbackRetirementRefusal extends Error {
  constructor(message, code = 'retirement_refused') {
    super(message);
    this.name = 'Pm2FallbackRetirementRefusal';
    this.code = code;
  }
}

function refuse(message, code) {
  throw new Pm2FallbackRetirementRefusal(message, code);
}

function exactObject(value, keys, label) {
  try {
    return exactKeys(value, keys, label);
  } catch {
    refuse(`${label} fields do not match the governed schema`, 'malformed_evidence');
  }
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(Date.parse(value))) {
    refuse(`${label} is not a canonical UTC timestamp`, 'malformed_evidence');
  }
  return value;
}

function assertHex(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    refuse(`${label} is malformed`, 'malformed_evidence');
  }
  return value;
}

function fileMode(stat) {
  return stat.mode & 0o777;
}

function pathExists(file, fsApi = fs) {
  try {
    fsApi.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fsyncDirectory(directory, fsApi = fs) {
  const descriptor = fsApi.openSync(directory, 'r');
  try {
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
}

function readBoundedFile(file, {
  fsApi = fs,
  label = file,
  maxBytes = 1024 * 1024,
  ownerUid = 0,
  ownerGid = 0,
  mode = 0o600,
} = {}) {
  let before;
  try {
    before = fsApi.lstatSync(file);
  } catch {
    refuse(`${label} is missing`, 'missing_evidence');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.uid !== ownerUid || before.gid !== ownerGid || fileMode(before) !== mode
      || before.size <= 0 || before.size > maxBytes) {
    refuse(`${label} metadata is unsafe`, 'unsafe_evidence');
  }
  const descriptor = fsApi.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fsApi.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      refuse(`${label} changed before it was opened`, 'evidence_changed');
    }
    const bytes = fsApi.readFileSync(descriptor);
    const afterDescriptor = fsApi.fstatSync(descriptor);
    const afterPath = fsApi.lstatSync(file);
    if (bytes.length !== opened.size || afterDescriptor.dev !== opened.dev
        || afterDescriptor.ino !== opened.ino || afterDescriptor.size !== opened.size
        || afterDescriptor.mtimeMs !== opened.mtimeMs || afterDescriptor.ctimeMs !== opened.ctimeMs
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
        || afterPath.nlink !== 1) {
      refuse(`${label} changed while it was read`, 'evidence_changed');
    }
    return bytes;
  } finally {
    fsApi.closeSync(descriptor);
  }
}

function parseBoundedJson(file, options = {}) {
  const bytes = readBoundedFile(file, options);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    refuse(`${options.label ?? file} is not valid JSON`, 'malformed_evidence');
  }
}

function atomicWriteJson(file, value, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  noReplace = false,
} = {}) {
  const directory = path.dirname(file);
  fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fsApi.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || directoryStat.uid !== ownerUid || directoryStat.gid !== ownerGid
      || (fileMode(directoryStat) & 0o077) !== 0) {
    refuse(`retirement evidence directory is unsafe: ${directory}`, 'unsafe_evidence');
  }
  const stage = path.join(directory, `.${path.basename(file)}.next-${process.pid}-${Date.now()}`);
  const descriptor = fsApi.openSync(stage, 'wx', 0o600);
  try {
    fsApi.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsApi.fsyncSync(descriptor);
  } finally {
    fsApi.closeSync(descriptor);
  }
  if (ownerUid === 0 && typeof fsApi.chownSync === 'function') fsApi.chownSync(stage, 0, 0);
  fsApi.chmodSync(stage, 0o600);
  try {
    if (noReplace) {
      try {
        fsApi.linkSync(stage, file);
      } catch (error) {
        if (error?.code === 'EEXIST') refuse(`refusing to replace ${file}`, 'immutable_exists');
        throw error;
      }
      fsApi.unlinkSync(stage);
    } else {
      fsApi.renameSync(stage, file);
    }
    fsyncDirectory(directory, fsApi);
  } catch (error) {
    try { fsApi.unlinkSync(stage); } catch { /* retain original failure */ }
    throw error;
  }
}

function unlinkDurably(file, fsApi = fs) {
  fsApi.unlinkSync(file);
  fsyncDirectory(path.dirname(file), fsApi);
}

function checkPair(checks, name, detail, label) {
  const matches = Array.isArray(checks)
    ? checks.filter((check) => check?.name === name)
    : [];
  if (matches.length !== 1 || matches[0].result !== 'passed' || matches[0].detail !== detail) {
    refuse(`${label} does not bind the exact bootstrap baseline`, 'bootstrap_receipt_mismatch');
  }
}

function assertUnitGuard(guard, unit) {
  if (!guard || guard.unit !== unit || guard.linkTarget !== '/dev/null'
      || guard.owner !== 'root:root' || guard.fragmentPath !== guard.path
      || guard.loadState !== 'masked' || guard.canStart !== 'no'
      || guard.activeState !== 'inactive' || guard.dropInPaths !== '') {
    refuse(`${unit} is not protected by its exact persistent guard`, 'pm2_guard_missing');
  }
}

function assertTimers(timers) {
  for (const unit of REQUIRED_TIMERS) {
    const observed = timers?.find((entry) => entry.unit === unit);
    if (!observed || observed.loadState !== 'loaded' || observed.activeState !== 'active'
        || observed.unitFileState !== 'enabled') {
      refuse(`${unit} is not loaded, enabled, and active`, 'timer_unhealthy');
    }
  }
}

function assertServices(services, { requirePoller = true } = {}) {
  const required = requirePoller
    ? REQUIRED_SUCCESSFUL_SERVICES
    : RESUMABLE_SUCCESSFUL_SERVICES;
  for (const unit of required) {
    const observed = services?.find((entry) => entry.unit === unit);
    if (!observed || observed.activeState !== 'inactive' || observed.result !== 'success'
        || observed.execMainStatus !== '0') {
      refuse(`${unit} has no settled successful result`, 'service_unhealthy');
    }
  }
}

function assertBackupLiveness(evidence) {
  exactObject(evidence, ['schema', 'backup', 'restoreVerification'], 'backup liveness');
  exactObject(
    evidence.backup,
    ['ageSeconds', 'completedAt', 'encryptedSha256'],
    'backup liveness backup',
  );
  exactObject(
    evidence.restoreVerification,
    ['ageSeconds', 'verifiedAt', 'encryptedSha256'],
    'backup liveness restore verification',
  );
  if (evidence.schema !== 'nexus.release-backup-liveness.v1'
      || !Number.isSafeInteger(evidence.backup.ageSeconds)
      || evidence.backup.ageSeconds < 0
      || evidence.backup.ageSeconds > BACKUP_HEARTBEAT_MAX_AGE_SECONDS
      || !Number.isSafeInteger(evidence.restoreVerification.ageSeconds)
      || evidence.restoreVerification.ageSeconds < 0
      || evidence.restoreVerification.ageSeconds > RESTORE_HEARTBEAT_MAX_AGE_SECONDS) {
    refuse('backup or restore-verification liveness is stale', 'backup_liveness_stale');
  }
  assertTimestamp(evidence.backup.completedAt, 'backup liveness completedAt');
  assertTimestamp(
    evidence.restoreVerification.verifiedAt,
    'backup liveness restore verifiedAt',
  );
  assertHex(evidence.backup.encryptedSha256, HEX_64, 'backup liveness digest');
  assertHex(
    evidence.restoreVerification.encryptedSha256,
    HEX_64,
    'restore verification digest',
  );
  return evidence;
}

function collectBackupLiveness(policy) {
  try {
    return assertBackupLiveness(inspectBackupLiveness({ policy }));
  } catch (error) {
    if (error instanceof Pm2FallbackRetirementRefusal) throw error;
    refuse('backup and restore-verification liveness is unprovable',
      'backup_liveness_unprovable');
  }
}

function assertControlPlaneEvidence(evidence) {
  exactObject(evidence, [
    'schema', 'digest', 'sourceSha', 'treeSha256', 'transactionGatePresent',
  ], 'retirement control plane');
  if (evidence.schema !== RELEASE_CONTROL_PLANE_SCHEMA
      || evidence.transactionGatePresent !== false) {
    refuse('immutable control-plane identity is not settled', 'control_plane_unsettled');
  }
  assertHex(evidence.digest, HEX_64, 'control-plane policy digest');
  assertHex(evidence.sourceSha, HEX_40, 'control-plane source sha');
  assertHex(evidence.treeSha256, HEX_64, 'control-plane tree digest');
  return evidence;
}

function assertAttestation(attestation) {
  exactObject(attestation, [
    'schema', 'version', 'sourceArchiveSha256', 'closureDigest', 'payloadDigest',
    'packageLockSha256', 'fileCount', 'closureRoot', 'launcher', 'launcherSha256',
    'entrypoint', 'node', 'installedAt',
  ], 'PM2 root installation attestation');
  if (attestation.schema !== 'nexus.pm2-root-install.v1'
      || !/^\d+\.\d+\.\d+$/u.test(attestation.version ?? '')
      || !Number.isSafeInteger(attestation.fileCount) || attestation.fileCount < 2
      || attestation.closureRoot !== `/opt/nexus-release/pm2/${attestation.version}`
      || attestation.launcher !== '/usr/local/bin/pm2'
      || attestation.entrypoint !== `${attestation.closureRoot}/node_modules/pm2/bin/pm2`) {
    refuse('PM2 root installation attestation identity is invalid', 'pm2_attestation_mismatch');
  }
  for (const [key, value] of Object.entries({
    sourceArchiveSha256: attestation.sourceArchiveSha256,
    closureDigest: attestation.closureDigest,
    payloadDigest: attestation.payloadDigest,
    packageLockSha256: attestation.packageLockSha256,
    launcherSha256: attestation.launcherSha256,
  })) assertHex(value, HEX_64, `PM2 attestation ${key}`);
  exactObject(attestation.node, ['path', 'version', 'sha256'], 'PM2 attested Node runtime');
  if (attestation.node.path !== '/usr/bin/node' || attestation.node.version !== 'v22.23.1') {
    refuse('PM2 attested Node runtime identity is invalid', 'pm2_attestation_mismatch');
  }
  assertHex(attestation.node.sha256, HEX_64, 'PM2 attested Node runtime digest');
  assertTimestamp(attestation.installedAt, 'PM2 attestation installedAt');
  return attestation;
}

export function retirementConfirmation(plan) {
  return [
    plan.active.releaseId,
    plan.active.receiptSha256,
    plan.anchor.releaseId,
    plan.anchor.receiptSha256,
  ].join(':');
}

export function evaluatePm2FallbackRetirementAdmission({
  policy,
  state,
  effective,
  activeReceipt,
  activeReceiptSha256,
  baseline,
  baselineSha256,
  baselineAuthorizationDigest,
  anchorReceipt,
  anchorReceiptSha256,
  host,
  now = Date.now(),
  validateBaseline = assertReleaseBootstrapBaselineShape,
  validateReceipt = assertReleaseReceiptShape,
}) {
  try {
    validateBaseline(baseline, policy);
    validateReceipt(anchorReceipt);
    validateReceipt(activeReceipt);
  } catch (error) {
    refuse(`release evidence validation failed: ${error.message}`, 'malformed_evidence');
  }
  assertHex(baselineSha256, HEX_64, 'bootstrap baseline digest');
  assertHex(
    baselineAuthorizationDigest,
    HEX_64,
    'bootstrap baseline authorization digest',
  );
  assertHex(anchorReceiptSha256, HEX_64, 'anchor receipt digest');
  assertHex(activeReceiptSha256, HEX_64, 'active receipt digest');

  if (sha256(canonicalJson(baseline)) !== baselineAuthorizationDigest) {
    refuse('bootstrap baseline authorization digest is invalid',
      'bootstrap_receipt_mismatch');
  }

  if (baseline.target.releaseId !== anchorReceipt.releaseId
      || baseline.target.sourceSha !== anchorReceipt.sourceSha
      || baseline.target.releasePayloadDigest !== anchorReceipt.identity.releasePayloadDigest
      || baseline.target.manifestDigest !== anchorReceipt.identity.manifestDigest
      || anchorReceipt.outcome !== RELEASE_RECEIPT_OUTCOMES.COMPLETED) {
    refuse('bootstrap baseline and completed anchor receipt do not match', 'bootstrap_receipt_mismatch');
  }
  const baselineDetail = `sha256:${baselineAuthorizationDigest}`;
  checkPair(anchorReceipt.staging?.checks, 'owner_bootstrap_baseline', baselineDetail, 'staging');
  checkPair(
    anchorReceipt.production?.checks,
    'bootstrap_production_revalidation',
    baselineDetail,
    'production',
  );
  const completedAt = assertTimestamp(anchorReceipt.completedAt, 'anchor receipt completedAt');
  const notBeforeMs = Date.parse(completedAt) + PM2_FALLBACK_STABLE_SECONDS * 1000;
  if (!Number.isFinite(now) || now < notBeforeMs) {
    refuse(`PM2 fallback retirement is not eligible before ${new Date(notBeforeMs).toISOString()}`,
      'stable_window_open');
  }
  if (host.clockSynchronized !== true) {
    refuse('host clock synchronization is not proved', 'clock_untrusted');
  }
  if (host.conflictingState?.length > 0) {
    refuse(`retirement-conflicting state exists: ${host.conflictingState.join(',')}`,
      'conflicting_state');
  }
  if (state.blocked !== null || effective?.provable !== true
      || effective.status !== RELEASE_STATUSES.COMPLETED
      || effective.releaseId !== state.active?.releaseId
      || activeReceipt.releaseId !== state.active?.releaseId
      || activeReceipt.outcome !== RELEASE_RECEIPT_OUTCOMES.COMPLETED) {
    refuse('current active container release is not exactly completed and provable',
      'active_release_unprovable');
  }
  const controlPlane = assertControlPlaneEvidence(host.controlPlane);
  if (!activeReceipt.controlPlane
      || activeReceipt.controlPlane.schema !== controlPlane.schema
      || activeReceipt.controlPlane.digest !== controlPlane.digest) {
    refuse('active receipt does not bind the installed v3 control plane',
      'control_plane_receipt_mismatch');
  }
  for (const unit of PM2_UNITS) {
    assertUnitGuard(host.guards?.find((entry) => entry.unit === unit), unit);
  }
  if (host.pm2Quiescent !== true) {
    refuse('a PM2 process, socket, or open package handle remains', 'pm2_not_quiescent');
  }
  if (host.legacyDatabaseQuiescent !== true) {
    refuse('a legacy database or sidecar still has an open handle',
      'legacy_database_not_quiescent');
  }
  assertTimers(host.timers);
  assertServices(host.services);
  const backupLiveness = assertBackupLiveness(host.backupLiveness);
  if (host.health?.production !== true || host.health?.staging !== true
      || host.health?.exactImages !== true) {
    refuse('container health or running-image identity is not exact', 'container_unhealthy');
  }
  const attestation = assertAttestation(host.pm2Attestation);
  if (host.pm2LauncherSha256 !== attestation.launcherSha256
      || host.pm2LockSha256 !== attestation.packageLockSha256
      || host.pm2ClosureSha256 !== attestation.closureDigest
      || !Number.isSafeInteger(host.pm2ClosureDevice) || host.pm2ClosureDevice < 0) {
    refuse('installed PM2 closure differs from its root attestation', 'pm2_attestation_mismatch');
  }
  if (!Array.isArray(host.systemdArtifacts)
      || host.systemdArtifacts.some((entry) => entry.allowed !== true)) {
    refuse('systemd PM2 authority contains a non-allowlisted artifact', 'unknown_pm2_authority');
  }
  if (canonicalJson(host.preservedPaths) !== canonicalJson(PM2_FALLBACK_PRESERVED_PATHS)) {
    refuse('PM2 data/config preservation boundary is not exact', 'unsafe_removal');
  }

  const planCore = {
    schema: 'nexus.pm2-fallback-retirement-plan.v1',
    notBefore: new Date(notBeforeMs).toISOString(),
    anchor: {
      releaseId: anchorReceipt.releaseId,
      sourceSha: anchorReceipt.sourceSha,
      completedAt,
      receiptSha256: anchorReceiptSha256,
      baselineSha256,
      baselineAuthorizationDigest,
    },
    active: {
      releaseId: activeReceipt.releaseId,
      sourceSha: activeReceipt.sourceSha,
      receiptSha256: activeReceiptSha256,
      releasePayloadDigest: activeReceipt.identity.releasePayloadDigest,
    },
    controlPlane: { ...controlPlane },
    backupLiveness,
    pm2: {
      attestationSha256: host.pm2AttestationSha256,
      version: attestation.version,
      closureRoot: attestation.closureRoot,
      launcherSha256: attestation.launcherSha256,
      packageLockSha256: attestation.packageLockSha256,
      closureSha256: attestation.closureDigest,
      closureDevice: host.pm2ClosureDevice,
      systemdArtifacts: host.systemdArtifacts,
    },
    preservedPaths: host.preservedPaths,
  };
  const planDigest = sha256(canonicalJson(planCore));
  const transactionId = sha256(`${PM2_FALLBACK_RETIREMENT_SCHEMA}\0${planDigest}`).slice(0, 32);
  const plan = { ...planCore, planDigest, transactionId };
  return assertPlan({ ...plan, confirmation: retirementConfirmation(plan) });
}

function assertPlan(plan) {
  exactObject(plan, [
    'schema', 'notBefore', 'anchor', 'active', 'controlPlane', 'backupLiveness',
    'pm2', 'preservedPaths', 'planDigest', 'transactionId', 'confirmation',
  ], 'PM2 fallback retirement plan');
  if (plan.schema !== 'nexus.pm2-fallback-retirement-plan.v1') {
    refuse('PM2 fallback retirement plan schema is unsupported', 'malformed_journal');
  }
  assertTimestamp(plan.notBefore, 'retirement plan notBefore');
  assertHex(plan.transactionId, HEX_32, 'retirement transaction id');
  assertHex(plan.planDigest, HEX_64, 'retirement plan digest');
  exactObject(plan.anchor, [
    'releaseId', 'sourceSha', 'completedAt', 'receiptSha256', 'baselineSha256',
    'baselineAuthorizationDigest',
  ], 'retirement anchor');
  exactObject(plan.active, [
    'releaseId', 'sourceSha', 'receiptSha256', 'releasePayloadDigest',
  ], 'retirement active release');
  assertControlPlaneEvidence(plan.controlPlane);
  assertBackupLiveness(plan.backupLiveness);
  exactObject(plan.pm2, [
    'attestationSha256', 'version', 'closureRoot', 'launcherSha256',
    'packageLockSha256', 'closureSha256', 'closureDevice', 'systemdArtifacts',
  ], 'retirement PM2 identity');
  for (const [value, pattern, label] of [
    [plan.anchor.releaseId, HEX_32, 'retirement anchor release id'],
    [plan.anchor.sourceSha, HEX_40, 'retirement anchor source sha'],
    [plan.anchor.receiptSha256, HEX_64, 'retirement anchor receipt digest'],
    [plan.anchor.baselineSha256, HEX_64, 'retirement baseline digest'],
    [plan.anchor.baselineAuthorizationDigest, HEX_64,
      'retirement baseline authorization digest'],
    [plan.active.releaseId, HEX_32, 'retirement active release id'],
    [plan.active.sourceSha, HEX_40, 'retirement active source sha'],
    [plan.active.receiptSha256, HEX_64, 'retirement active receipt digest'],
    [plan.pm2.attestationSha256, HEX_64, 'retirement PM2 attestation digest'],
    [plan.pm2.launcherSha256, HEX_64, 'retirement PM2 launcher digest'],
    [plan.pm2.packageLockSha256, HEX_64, 'retirement PM2 package-lock digest'],
    [plan.pm2.closureSha256, HEX_64, 'retirement PM2 closure digest'],
  ]) assertHex(value, pattern, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(plan.active.releasePayloadDigest ?? '')
      || plan.controlPlane.transactionGatePresent !== false
      || !Number.isSafeInteger(plan.pm2.closureDevice) || plan.pm2.closureDevice < 0
      || plan.pm2.closureRoot !== `/opt/nexus-release/pm2/${plan.pm2.version}`
      || !/^\d+\.\d+\.\d+$/u.test(plan.pm2.version ?? '')
      || canonicalJson(plan.preservedPaths) !== canonicalJson(PM2_FALLBACK_PRESERVED_PATHS)) {
    refuse('retirement plan mutation/preservation boundary is invalid', 'malformed_journal');
  }
  assertTimestamp(plan.anchor.completedAt, 'retirement anchor completedAt');
  if (Date.parse(plan.notBefore)
      !== Date.parse(plan.anchor.completedAt) + PM2_FALLBACK_STABLE_SECONDS * 1000) {
    refuse('retirement plan stable-window boundary is invalid', 'malformed_journal');
  }
  if (!Array.isArray(plan.pm2.systemdArtifacts) || plan.pm2.systemdArtifacts.length > 4) {
    refuse('retirement PM2 systemd allowlist is invalid', 'malformed_journal');
  }
  const allowedSystemd = PM2_UNITS.flatMap((unit) => [
    path.join(DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS.unitRoot, unit),
    path.join(DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS.unitRoot, 'multi-user.target.wants', unit),
  ]);
  const seenArtifacts = new Set();
  for (const artifact of plan.pm2.systemdArtifacts) {
    if (!artifact || artifact.allowed !== true || !allowedSystemd.includes(artifact.path)
        || seenArtifacts.has(artifact.path)) {
      refuse('retirement PM2 systemd allowlist is invalid', 'malformed_journal');
    }
    seenArtifacts.add(artifact.path);
    if (artifact.kind === 'unit') {
      exactObject(artifact, ['path', 'allowed', 'kind', 'sha256'], 'retirement PM2 unit');
      assertHex(artifact.sha256, HEX_64, 'retirement PM2 unit digest');
    } else if (artifact.kind === 'enable-link') {
      exactObject(
        artifact,
        ['path', 'allowed', 'kind', 'linkTarget'],
        'retirement PM2 enable link',
      );
      if (!allowedSystemd.includes(artifact.linkTarget)) {
        refuse('retirement PM2 enable link target is invalid', 'malformed_journal');
      }
    } else {
      refuse('retirement PM2 systemd artifact kind is invalid', 'malformed_journal');
    }
  }
  if (plan.confirmation !== retirementConfirmation(plan)
      || !CONFIRMATION.test(plan.confirmation)) {
    refuse('retirement plan confirmation is invalid', 'malformed_journal');
  }
  const core = { ...plan };
  delete core.planDigest;
  delete core.transactionId;
  delete core.confirmation;
  if (sha256(canonicalJson(core)) !== plan.planDigest
      || sha256(`${PM2_FALLBACK_RETIREMENT_SCHEMA}\0${plan.planDigest}`).slice(0, 32)
        !== plan.transactionId) {
    refuse('retirement plan digest is invalid', 'malformed_journal');
  }
  return plan;
}

function closureQuarantinePath(plan) {
  return path.join(
    path.dirname(path.dirname(plan.pm2.closureRoot)),
    `.pm2-fallback-retirement-${plan.transactionId}`,
  );
}

function closureManifestPath(plan, paths) {
  return path.join(paths.retirementRoot, `${plan.transactionId}.closure-manifest.json`);
}

function assertClosureEvidence(evidence, plan, {
  paths = null,
} = {}) {
  exactObject(evidence, [
    'quarantinePath', 'manifestPath', 'manifestSha256', 'device', 'entryCount',
  ], 'PM2 closure retirement evidence');
  if (evidence.quarantinePath !== closureQuarantinePath(plan)
      || !path.isAbsolute(evidence.manifestPath)
      || path.basename(evidence.manifestPath)
        !== `${plan.transactionId}.closure-manifest.json`
      || (paths && evidence.manifestPath !== closureManifestPath(plan, paths))
      || !HEX_64.test(evidence.manifestSha256 ?? '')
      || evidence.device !== plan.pm2.closureDevice
      || !Number.isSafeInteger(evidence.entryCount) || evidence.entryCount < 1) {
    refuse('PM2 closure retirement evidence is malformed', 'malformed_journal');
  }
  return evidence;
}

function assertJournal(journal) {
  exactObject(journal, [
    'schema', 'transactionId', 'createdAt', 'updatedAt', 'phase', 'plan',
    'closureEvidence',
  ], 'PM2 fallback retirement journal');
  if (journal.schema !== PM2_FALLBACK_RETIREMENT_SCHEMA || !PHASES.includes(journal.phase)) {
    refuse('PM2 fallback retirement journal is malformed', 'malformed_journal');
  }
  assertTimestamp(journal.createdAt, 'retirement journal createdAt');
  assertTimestamp(journal.updatedAt, 'retirement journal updatedAt');
  assertPlan(journal.plan);
  if (journal.transactionId !== journal.plan.transactionId) {
    refuse('retirement journal transaction does not match its plan', 'malformed_journal');
  }
  if (['closure_detached', 'package_retired', 'verified'].includes(journal.phase)) {
    assertClosureEvidence(journal.closureEvidence, journal.plan);
  } else if (journal.closureEvidence !== null) {
    refuse('retirement journal carries premature closure evidence', 'malformed_journal');
  }
  return journal;
}

function journalFor(plan, phase, createdAt, now, closureEvidence = null) {
  return {
    schema: PM2_FALLBACK_RETIREMENT_SCHEMA,
    transactionId: plan.transactionId,
    createdAt,
    updatedAt: new Date(now).toISOString(),
    phase,
    plan,
    closureEvidence,
  };
}

function tombstoneFor(plan, now) {
  return {
    schema: PM2_FALLBACK_RETIRED_SCHEMA,
    transactionId: plan.transactionId,
    createdAt: new Date(now).toISOString(),
    planDigest: plan.planDigest,
    anchorReleaseId: plan.anchor.releaseId,
    activeReleaseId: plan.active.releaseId,
  };
}

function assertTombstone(tombstone) {
  exactObject(tombstone, [
    'schema', 'transactionId', 'createdAt', 'planDigest', 'anchorReleaseId',
    'activeReleaseId',
  ], 'PM2 fallback retired tombstone');
  if (tombstone.schema !== PM2_FALLBACK_RETIRED_SCHEMA) {
    refuse('PM2 fallback retired tombstone schema is unsupported', 'malformed_tombstone');
  }
  assertHex(tombstone.transactionId, HEX_32, 'retired transaction id');
  assertHex(tombstone.planDigest, HEX_64, 'retired plan digest');
  assertHex(tombstone.anchorReleaseId, HEX_32, 'retired anchor release id');
  assertHex(tombstone.activeReleaseId, HEX_32, 'retired active release id');
  assertTimestamp(tombstone.createdAt, 'retired tombstone createdAt');
  return tombstone;
}

function assertTerminalReceipt(receipt, {
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
} = {}) {
  exactObject(receipt, [
    'schema', 'transactionId', 'createdAt', 'planDigest', 'confirmation', 'anchor',
    'active', 'controlPlane', 'plan', 'retired', 'preservedPaths', 'persistentGuards',
    'result', 'completedAt',
  ], 'PM2 fallback terminal retirement receipt');
  if (receipt.schema !== PM2_FALLBACK_RETIREMENT_RECEIPT_SCHEMA
      || receipt.result !== 'completed') {
    refuse('PM2 fallback terminal retirement receipt is unsupported',
      'malformed_terminal_receipt');
  }
  assertHex(receipt.transactionId, HEX_32, 'terminal retirement transaction id');
  assertHex(receipt.planDigest, HEX_64, 'terminal retirement plan digest');
  assertTimestamp(receipt.createdAt, 'terminal retirement receipt createdAt');
  assertTimestamp(receipt.completedAt, 'terminal retirement receipt completedAt');
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.createdAt)) {
    refuse('terminal retirement receipt completed before it was created',
      'malformed_terminal_receipt');
  }
  assertPlan(receipt.plan);
  exactObject(receipt.anchor, [
    'releaseId', 'sourceSha', 'completedAt', 'receiptSha256', 'baselineSha256',
    'baselineAuthorizationDigest',
  ], 'terminal retirement anchor');
  exactObject(receipt.active, [
    'releaseId', 'sourceSha', 'receiptSha256', 'releasePayloadDigest',
  ], 'terminal retirement active release');
  assertControlPlaneEvidence(receipt.controlPlane);
  exactObject(receipt.retired, [
    'units', 'systemdArtifacts', 'launcher', 'packageLock', 'attestation',
    'closure', 'prefix',
  ], 'terminal PM2 retirement set');
  for (const key of ['launcher', 'packageLock', 'attestation']) {
    exactObject(receipt.retired[key], ['path', 'sha256'], `terminal retired ${key}`);
    assertHex(receipt.retired[key].sha256, HEX_64, `terminal retired ${key} digest`);
  }
  exactObject(receipt.retired.closure, [
    'path', 'sha256', 'quarantinePath', 'manifestPath', 'manifestSha256',
    'device', 'entryCount',
  ], 'terminal retired closure');
  assertHex(receipt.retired.closure.sha256, HEX_64, 'terminal retired closure digest');
  const {
    path: _retiredClosurePath,
    sha256: _retiredClosureSha256,
    ...retiredClosureEvidence
  } = receipt.retired.closure;
  assertClosureEvidence(retiredClosureEvidence, receipt.plan, { paths });
  if (!CONFIRMATION.test(receipt.confirmation ?? '')
      || receipt.confirmation !== retirementConfirmation(receipt)
      || receipt.transactionId !== receipt.plan.transactionId
      || receipt.planDigest !== receipt.plan.planDigest
      || receipt.confirmation !== receipt.plan.confirmation
      || canonicalJson(receipt.anchor) !== canonicalJson(receipt.plan.anchor)
      || canonicalJson(receipt.active) !== canonicalJson(receipt.plan.active)
      || canonicalJson(receipt.controlPlane) !== canonicalJson(receipt.plan.controlPlane)
      || canonicalJson(receipt.retired.units) !== canonicalJson(PM2_UNITS)
      || canonicalJson(receipt.retired.systemdArtifacts)
        !== canonicalJson(receipt.plan.pm2.systemdArtifacts)
      || canonicalJson(receipt.retired.launcher) !== canonicalJson({
        path: paths.pm2Launcher,
        sha256: receipt.plan.pm2.launcherSha256,
      })
      || canonicalJson(receipt.retired.packageLock) !== canonicalJson({
        path: paths.pm2Lock,
        sha256: receipt.plan.pm2.packageLockSha256,
      })
      || canonicalJson(receipt.retired.attestation) !== canonicalJson({
        path: paths.pm2Attestation,
        sha256: receipt.plan.pm2.attestationSha256,
      })
      || canonicalJson(receipt.retired.closure) !== canonicalJson({
        path: receipt.plan.pm2.closureRoot,
        sha256: receipt.plan.pm2.closureSha256,
        quarantinePath: closureQuarantinePath(receipt.plan),
        manifestPath: closureManifestPath(receipt.plan, paths),
        manifestSha256: receipt.retired.closure.manifestSha256,
        device: receipt.plan.pm2.closureDevice,
        entryCount: receipt.retired.closure.entryCount,
      })
      || receipt.retired.prefix !== paths.pm2Prefix
      || canonicalJson(receipt.preservedPaths) !== canonicalJson(PM2_FALLBACK_PRESERVED_PATHS)
      || canonicalJson(receipt.preservedPaths) !== canonicalJson(receipt.plan.preservedPaths)
      || canonicalJson(receipt.persistentGuards) !== canonicalJson(
        PM2_UNITS.map((unit) => `${paths.guardRoot}/${unit}`),
      )) {
    refuse('PM2 fallback terminal retirement receipt boundary is invalid',
      'malformed_terminal_receipt');
  }
  return receipt;
}

export function readPm2FallbackRetirementStatus({
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  ownerUid = 0,
  ownerGid = 0,
  fsApi = fs,
} = {}) {
  const journalPresent = pathExists(paths.journal, fsApi);
  const tombstonePresent = pathExists(paths.tombstone, fsApi);
  if (journalPresent) {
    const journal = assertJournal(parseBoundedJson(paths.journal, {
      fsApi, label: 'PM2 fallback retirement journal', ownerUid, ownerGid,
    }).value);
    if (tombstonePresent) {
      const tombstone = assertTombstone(parseBoundedJson(paths.tombstone, {
        fsApi, label: 'PM2 fallback retired tombstone', ownerUid, ownerGid,
      }).value);
      if (tombstone.transactionId !== journal.transactionId
          || tombstone.planDigest !== journal.plan.planDigest) {
        refuse('PM2 fallback tombstone conflicts with the active journal',
          'tombstone_conflict');
      }
    }
    return { status: 'in_progress', journal };
  }
  if (!tombstonePresent) {
    if (pathExists(paths.retirementRoot, fsApi)) {
      const root = fsApi.lstatSync(paths.retirementRoot);
      if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== ownerUid
          || root.gid !== ownerGid || (fileMode(root) & 0o077) !== 0
          || fsApi.readdirSync(paths.retirementRoot).length > 0) {
        refuse('terminal retirement evidence exists without its tombstone',
          'retirement_evidence_incomplete');
      }
    }
    return { status: 'not_started' };
  }
  const tombstone = assertTombstone(parseBoundedJson(paths.tombstone, {
    fsApi, label: 'PM2 fallback retired tombstone', ownerUid, ownerGid,
  }).value);
  const receiptPath = path.join(paths.retirementRoot, `${tombstone.transactionId}.json`);
  if (!pathExists(receiptPath, fsApi)) {
    refuse('retired tombstone has neither an active journal nor terminal receipt',
      'retirement_evidence_incomplete');
  }
  const receipt = assertTerminalReceipt(parseBoundedJson(receiptPath, {
    fsApi, label: 'PM2 fallback terminal retirement receipt', ownerUid, ownerGid,
  }).value, { paths });
  const {
    path: _closurePath,
    sha256: _closureSha256,
    ...closureEvidence
  } = receipt.retired.closure;
  readClosureManifest(receipt.plan, paths, {
    fsApi,
    ownerUid,
    ownerGid,
    evidence: closureEvidence,
  });
  if (receipt.transactionId !== tombstone.transactionId
      || receipt.planDigest !== tombstone.planDigest
      || receipt.anchor.releaseId !== tombstone.anchorReleaseId
      || receipt.active.releaseId !== tombstone.activeReleaseId) {
    refuse('terminal receipt conflicts with the PM2 fallback tombstone',
      'terminal_receipt_conflict');
  }
  return { status: 'completed', tombstone, receipt, receiptPath };
}

export async function runPm2FallbackRetirementTransaction({
  plan: suppliedPlan,
  confirmation,
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  ownerUid = 0,
  ownerGid = 0,
  fsApi = fs,
  now = () => Date.now(),
  host,
  crashAfterPhase = null,
}) {
  if (!host || [
    'verifyResume', 'retireSystemd', 'detachPackageClosure', 'retirePackage',
    'verifyPost',
  ]
    .some((method) => typeof host[method] !== 'function')) {
    refuse('retirement host mutator contract is incomplete', 'malformed_evidence');
  }
  let journal;
  if (pathExists(paths.journal, fsApi)) {
    const parsed = parseBoundedJson(paths.journal, {
      fsApi, label: 'PM2 fallback retirement journal', ownerUid, ownerGid,
    });
    journal = assertJournal(parsed.value);
    if (suppliedPlan && canonicalJson(suppliedPlan) !== canonicalJson(journal.plan)) {
      refuse('durable retirement journal belongs to a different plan', 'journal_conflict');
    }
  } else {
    const plan = assertPlan(suppliedPlan);
    if (confirmation !== plan.confirmation || !CONFIRMATION.test(confirmation ?? '')) {
      refuse('apply confirmation does not match both active and anchor receipts',
        'confirmation_mismatch');
    }
    if (now() < Date.parse(plan.notBefore)) {
      refuse(`PM2 fallback retirement is not eligible before ${plan.notBefore}`,
        'stable_window_open');
    }
    const createdAt = new Date(now()).toISOString();
    journal = journalFor(plan, 'admitted', createdAt, now());
    atomicWriteJson(paths.journal, journal, { fsApi, ownerUid, ownerGid, noReplace: true });
    if (crashAfterPhase === 'admitted') throw new Error('simulated crash after admitted');
  }
  const { plan } = journal;
  if (confirmation !== plan.confirmation || !CONFIRMATION.test(confirmation ?? '')) {
    refuse('apply confirmation does not match both active and anchor receipts',
      'confirmation_mismatch');
  }
  if (now() < Date.parse(plan.notBefore)) {
    refuse(`PM2 fallback retirement is not eligible before ${plan.notBefore}`, 'stable_window_open');
  }
  await host.verifyResume(plan, journal.phase, journal.closureEvidence);

  const advance = (phase, closureEvidence = journal.closureEvidence) => {
    journal = journalFor(plan, phase, journal.createdAt, now(), closureEvidence);
    atomicWriteJson(paths.journal, journal, { fsApi, ownerUid, ownerGid });
    if (crashAfterPhase === phase) throw new Error(`simulated crash after ${phase}`);
  };

  if (journal.phase === 'admitted') {
    if (pathExists(paths.tombstone, fsApi)) {
      const parsed = assertTombstone(parseBoundedJson(paths.tombstone, {
        fsApi, label: 'PM2 fallback retired tombstone', ownerUid, ownerGid,
      }).value);
      if (parsed.transactionId !== plan.transactionId || parsed.planDigest !== plan.planDigest) {
        refuse('PM2 fallback tombstone belongs to another transaction', 'tombstone_conflict');
      }
    } else {
      atomicWriteJson(paths.tombstone, tombstoneFor(plan, now()), {
        fsApi, ownerUid, ownerGid, noReplace: true,
      });
    }
    advance('fallback_barred');
  }
  if (journal.phase === 'fallback_barred') {
    await host.retireSystemd(plan);
    advance('systemd_retired');
  }
  if (journal.phase === 'systemd_retired') {
    const closureEvidence = assertClosureEvidence(
      await host.detachPackageClosure(plan),
      plan,
      { paths },
    );
    advance('closure_detached', closureEvidence);
  }
  if (journal.phase === 'closure_detached') {
    await host.retirePackage(plan, journal.closureEvidence);
    advance('package_retired');
  }
  if (journal.phase === 'package_retired') {
    await host.verifyPost(plan, journal.closureEvidence);
    advance('verified');
  }
  if (journal.phase !== 'verified') refuse('retirement journal phase is incoherent', 'malformed_journal');

  const receiptCore = {
    schema: PM2_FALLBACK_RETIREMENT_RECEIPT_SCHEMA,
    transactionId: plan.transactionId,
    createdAt: journal.createdAt,
    planDigest: plan.planDigest,
    confirmation: plan.confirmation,
    anchor: plan.anchor,
    active: plan.active,
    controlPlane: plan.controlPlane,
    plan,
    retired: {
      units: PM2_UNITS,
      systemdArtifacts: plan.pm2.systemdArtifacts,
      launcher: { path: paths.pm2Launcher, sha256: plan.pm2.launcherSha256 },
      packageLock: { path: paths.pm2Lock, sha256: plan.pm2.packageLockSha256 },
      attestation: { path: paths.pm2Attestation, sha256: plan.pm2.attestationSha256 },
      closure: {
        path: plan.pm2.closureRoot,
        sha256: plan.pm2.closureSha256,
        ...assertClosureEvidence(journal.closureEvidence, plan, { paths }),
      },
      prefix: paths.pm2Prefix,
    },
    preservedPaths: plan.preservedPaths,
    persistentGuards: PM2_UNITS.map((unit) => `${paths.guardRoot}/${unit}`),
    result: 'completed',
  };
  const receiptPath = path.join(paths.retirementRoot, `${plan.transactionId}.json`);
  let receipt;
  if (pathExists(receiptPath, fsApi)) {
    const existing = assertTerminalReceipt(parseBoundedJson(receiptPath, {
      fsApi, label: 'PM2 fallback terminal retirement receipt', ownerUid, ownerGid,
    }).value, { paths });
    const { completedAt, ...existingCore } = existing;
    assertTimestamp(completedAt, 'PM2 fallback retirement receipt completedAt');
    if (canonicalJson(existingCore) !== canonicalJson(receiptCore)) {
      refuse('terminal retirement receipt differs from the resumed transaction',
        'terminal_receipt_conflict');
    }
    receipt = existing;
  } else {
    receipt = { ...receiptCore, completedAt: new Date(now()).toISOString() };
    atomicWriteJson(receiptPath, receipt, {
      fsApi, ownerUid, ownerGid, noReplace: true,
    });
  }
  if (crashAfterPhase === 'receipt_written') {
    throw new Error('simulated crash after receipt_written');
  }
  unlinkDurably(paths.journal, fsApi);
  return { outcome: 'completed', receiptPath, receipt };
}

function commandResult(binary, args, { timeout = 10_000 } = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.error || result.status !== 0) {
    refuse(`host probe failed: ${binary} ${args.join(' ')}`, 'host_probe_failed');
  }
  return result.stdout.trim();
}

function systemctlValue(unit, property) {
  return commandResult('/usr/bin/systemctl', [
    'show', unit, `--property=${property}`, '--value', '--no-pager',
  ]);
}

function hashRegularFile(file, {
  mode,
  ownerUid = 0,
  ownerGid = 0,
  maxBytes = 16 * 1024 * 1024,
  fsApi = fs,
} = {}) {
  return sha256(readBoundedFile(file, {
    fsApi, label: file, maxBytes, mode, ownerUid, ownerGid,
  }));
}

export function inspectPm2ClosureForRetirement(root, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  expectedDevice = null,
} = {}) {
  const files = [];
  const entries = [];
  const rootStat = fsApi.lstatSync(root);
  const rootDevice = rootStat.dev;
  if (expectedDevice !== null && rootDevice !== expectedDevice) {
    refuse('PM2 closure filesystem changed after admission', 'artifact_changed');
  }
  function walk(directory) {
    const directoryStat = fsApi.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || directoryStat.uid !== ownerUid || directoryStat.gid !== ownerGid
        || fileMode(directoryStat) !== 0o755 || directoryStat.dev !== rootDevice) {
      refuse('PM2 closure contains an unsafe directory', 'unsafe_pm2_closure');
    }
    for (const name of fsApi.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fsApi.lstatSync(absolute);
      if (stat.dev !== rootDevice) {
        refuse('PM2 closure crosses a filesystem or mount boundary',
          'unsafe_pm2_closure');
      }
      if (stat.isSymbolicLink()) refuse('PM2 closure contains a symbolic link', 'unsafe_pm2_closure');
      if (stat.isDirectory()) {
        entries.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          kind: 'directory',
          mode: 0o755,
        });
        walk(absolute);
      } else if (stat.isFile() && stat.nlink === 1
          && stat.uid === ownerUid && stat.gid === ownerGid
          && [0o644, 0o755].includes(fileMode(stat))) {
        const bytes = fsApi.readFileSync(absolute);
        const file = {
          path: path.relative(root, absolute).split(path.sep).join('/'),
          size: bytes.length,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
          sha256: sha256(bytes),
        };
        files.push(file);
        entries.push({ ...file, kind: 'file' });
      } else {
        refuse('PM2 closure contains a special or linked file', 'unsafe_pm2_closure');
      }
    }
  }
  walk(root);
  return {
    device: rootDevice,
    sha256: sha256(canonicalJson({ schema: 'nexus.pm2-root-closure.v1', files })),
    entries,
  };
}

const PM2_CLOSURE_MANIFEST_SCHEMA = 'nexus.pm2-fallback-closure-manifest.v1';
const MAX_PM2_CLOSURE_MANIFEST_BYTES = 64 * 1024 * 1024;

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function assertRelativeClosurePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
      || value.includes('\\') || path.posix.isAbsolute(value)
      || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    refuse('PM2 closure manifest contains an unsafe path', 'malformed_evidence');
  }
}

function assertClosureManifest(manifest, plan) {
  exactObject(manifest, [
    'schema', 'transactionId', 'closureRoot', 'closureSha256', 'device', 'entries',
  ], 'PM2 closure retirement manifest');
  if (manifest.schema !== PM2_CLOSURE_MANIFEST_SCHEMA
      || manifest.transactionId !== plan.transactionId
      || manifest.closureRoot !== plan.pm2.closureRoot
      || manifest.closureSha256 !== plan.pm2.closureSha256
      || manifest.device !== plan.pm2.closureDevice
      || !Array.isArray(manifest.entries) || manifest.entries.length < 1
      || manifest.entries.length > 100_000) {
    refuse('PM2 closure retirement manifest is malformed', 'malformed_evidence');
  }
  const files = [];
  const seenPaths = new Set();
  for (const entry of manifest.entries) {
    assertRelativeClosurePath(entry?.path);
    if (seenPaths.has(entry.path)) {
      refuse('PM2 closure retirement manifest contains a duplicate path',
        'malformed_evidence');
    }
    seenPaths.add(entry.path);
    if (entry.kind === 'directory') {
      exactObject(entry, ['path', 'kind', 'mode'], 'PM2 closure manifest directory');
      if (entry.mode !== 0o755) {
        refuse('PM2 closure manifest directory mode is invalid', 'malformed_evidence');
      }
    } else if (entry.kind === 'file') {
      exactObject(entry, [
        'path', 'kind', 'size', 'mode', 'sha256',
      ], 'PM2 closure manifest file');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0
          || ![0o644, 0o755].includes(entry.mode)
          || !HEX_64.test(entry.sha256 ?? '')) {
        refuse('PM2 closure manifest file identity is invalid', 'malformed_evidence');
      }
      files.push({
        path: entry.path,
        size: entry.size,
        mode: entry.mode,
        sha256: entry.sha256,
      });
    } else {
      refuse('PM2 closure manifest entry kind is invalid', 'malformed_evidence');
    }
  }
  if (sha256(canonicalJson({ schema: 'nexus.pm2-root-closure.v1', files }))
      !== plan.pm2.closureSha256) {
    refuse('PM2 closure manifest does not authorize the admitted closure',
      'artifact_changed');
  }
  return manifest;
}

function closureManifestFor(plan, inspection) {
  return assertClosureManifest({
    schema: PM2_CLOSURE_MANIFEST_SCHEMA,
    transactionId: plan.transactionId,
    closureRoot: plan.pm2.closureRoot,
    closureSha256: plan.pm2.closureSha256,
    device: plan.pm2.closureDevice,
    entries: inspection.entries,
  }, plan);
}

function readClosureManifest(plan, paths, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  evidence = null,
} = {}) {
  const manifestPath = closureManifestPath(plan, paths);
  const parsed = parseBoundedJson(manifestPath, {
    fsApi,
    label: 'PM2 closure retirement manifest',
    maxBytes: MAX_PM2_CLOSURE_MANIFEST_BYTES,
    ownerUid,
    ownerGid,
    mode: 0o600,
  });
  const manifest = assertClosureManifest(parsed.value, plan);
  if (evidence && (sha256(parsed.bytes) !== evidence.manifestSha256
      || evidence.manifestPath !== manifestPath
      || evidence.entryCount !== manifest.entries.length
      || evidence.device !== manifest.device)) {
    refuse('PM2 closure retirement manifest changed after detachment',
      'artifact_changed');
  }
  return { ...parsed, manifest };
}

function assertTrustedClosureDirectory(stat, expectedDevice, ownerUid, ownerGid, label) {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expectedDevice
      || stat.uid !== ownerUid || stat.gid !== ownerGid || fileMode(stat) !== 0o755) {
    refuse(`${label} is not a trusted same-filesystem directory`, 'unsafe_removal');
  }
}

function assertSameDirectoryIdentity(before, after, label) {
  if (before.dev !== after.dev || before.ino !== after.ino
      || before.uid !== after.uid || before.gid !== after.gid
      || fileMode(before) !== fileMode(after)) {
    refuse(`${label} changed during PM2 closure detachment`, 'artifact_changed');
  }
}

export function detachPm2ClosureAtomically({
  source,
  quarantine,
  expectedSha256,
  expectedDevice,
  expectedEntries,
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  onDestructiveStep = () => {},
}) {
  const sourcePresent = pathExists(source, fsApi);
  const quarantinePresent = pathExists(quarantine, fsApi);
  if (sourcePresent === quarantinePresent) {
    refuse('PM2 closure detachment requires exactly one governed location',
      'artifact_changed');
  }
  const current = sourcePresent ? source : quarantine;
  const inspection = inspectPm2ClosureForRetirement(current, {
    fsApi, ownerUid, ownerGid, expectedDevice,
  });
  if (inspection.sha256 !== expectedSha256
      || canonicalJson(inspection.entries) !== canonicalJson(expectedEntries)) {
    refuse('PM2 closure changed before atomic detachment', 'artifact_changed');
  }
  if (!sourcePresent) return inspection;

  const sourceParent = path.dirname(source);
  const quarantineParent = path.dirname(quarantine);
  const sourceParentBefore = fsApi.lstatSync(sourceParent);
  const quarantineParentBefore = fsApi.lstatSync(quarantineParent);
  assertTrustedClosureDirectory(
    sourceParentBefore, expectedDevice, ownerUid, ownerGid, 'PM2 closure parent',
  );
  assertTrustedClosureDirectory(
    quarantineParentBefore, expectedDevice, ownerUid, ownerGid, 'PM2 quarantine parent',
  );
  if (pathExists(quarantine, fsApi)) {
    refuse('PM2 closure quarantine already exists', 'artifact_changed');
  }
  const rechecked = inspectPm2ClosureForRetirement(source, {
    fsApi, ownerUid, ownerGid, expectedDevice,
  });
  if (canonicalJson(rechecked) !== canonicalJson(inspection)) {
    refuse('PM2 closure changed during atomic detachment', 'artifact_changed');
  }
  assertSameDirectoryIdentity(
    sourceParentBefore, fsApi.lstatSync(sourceParent), 'PM2 closure parent',
  );
  assertSameDirectoryIdentity(
    quarantineParentBefore, fsApi.lstatSync(quarantineParent), 'PM2 quarantine parent',
  );
  fsApi.renameSync(source, quarantine);
  fsyncDirectory(sourceParent, fsApi);
  if (quarantineParent !== sourceParent) fsyncDirectory(quarantineParent, fsApi);
  onDestructiveStep('closure_detached');
  return inspection;
}

function assertRemainingClosureMatchesManifest(root, manifest, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
} = {}) {
  const allowed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const rootStat = fsApi.lstatSync(root);
  assertTrustedClosureDirectory(
    rootStat, manifest.device, ownerUid, ownerGid, 'PM2 closure quarantine',
  );
  function walk(directory) {
    for (const name of fsApi.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const expected = allowed.get(relative);
      if (!expected) {
        refuse(`PM2 closure quarantine contains an unallowlisted path: ${relative}`,
          'unsafe_removal');
      }
      const stat = fsApi.lstatSync(absolute);
      if (stat.dev !== manifest.device || stat.uid !== ownerUid || stat.gid !== ownerGid
          || stat.isSymbolicLink()) {
        refuse(`PM2 closure quarantine entry is unsafe: ${relative}`, 'unsafe_removal');
      }
      if (expected.kind === 'directory') {
        if (!stat.isDirectory() || fileMode(stat) !== expected.mode) {
          refuse(`PM2 closure quarantine directory changed: ${relative}`, 'artifact_changed');
        }
        walk(absolute);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || fileMode(stat) !== expected.mode
            || stat.size !== expected.size
            || sha256(readClosureFileWithoutFollowing(absolute, expected, {
              fsApi, ownerUid, ownerGid, expectedDevice: manifest.device,
            })) !== expected.sha256) {
          refuse(`PM2 closure quarantine file changed: ${relative}`, 'artifact_changed');
        }
      }
    }
  }
  walk(root);
}

function readClosureFileWithoutFollowing(file, expected, {
  fsApi,
  ownerUid,
  ownerGid,
  expectedDevice,
}) {
  const descriptor = fsApi.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fsApi.fstatSync(descriptor);
    const named = fsApi.lstatSync(file);
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1
        || opened.uid !== ownerUid || opened.gid !== ownerGid
        || opened.dev !== expectedDevice || fileMode(opened) !== expected.mode
        || opened.size !== expected.size || opened.dev !== named.dev
        || opened.ino !== named.ino) {
      refuse(`PM2 closure file cannot be read without following: ${file}`,
        'unsafe_removal');
    }
    const bytes = fsApi.readFileSync(descriptor);
    const after = fsApi.fstatSync(descriptor);
    const afterPath = fsApi.lstatSync(file);
    if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs || afterPath.dev !== opened.dev
        || afterPath.ino !== opened.ino || afterPath.nlink !== 1) {
      refuse(`PM2 closure file changed while it was read: ${file}`, 'artifact_changed');
    }
    return bytes;
  } finally {
    fsApi.closeSync(descriptor);
  }
}

export function purgeDetachedPm2Closure({
  quarantine,
  manifest,
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  onDestructiveStep = () => {},
}) {
  if (!pathExists(quarantine, fsApi)) return;
  assertRemainingClosureMatchesManifest(quarantine, manifest, {
    fsApi, ownerUid, ownerGid,
  });
  const allowed = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  function purge(directory) {
    for (const name of fsApi.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(quarantine, absolute).split(path.sep).join('/');
      const expected = allowed.get(relative);
      if (!expected) {
        refuse(`refusing to purge unallowlisted PM2 closure path: ${relative}`,
          'unsafe_removal');
      }
      const stat = fsApi.lstatSync(absolute);
      if (stat.dev !== manifest.device || stat.uid !== ownerUid || stat.gid !== ownerGid
          || stat.isSymbolicLink()) {
        refuse(`refusing to purge unsafe PM2 closure path: ${relative}`,
          'unsafe_removal');
      }
      if (expected.kind === 'directory') {
        if (!stat.isDirectory() || fileMode(stat) !== expected.mode) {
          refuse(`refusing to purge changed PM2 closure directory: ${relative}`,
            'artifact_changed');
        }
        purge(absolute);
        const afterChildren = fsApi.lstatSync(absolute);
        if (!afterChildren.isDirectory() || afterChildren.isSymbolicLink()
            || afterChildren.dev !== manifest.device || afterChildren.uid !== ownerUid
            || afterChildren.gid !== ownerGid || fileMode(afterChildren) !== expected.mode) {
          refuse(`PM2 closure directory changed before removal: ${relative}`,
            'artifact_changed');
        }
        fsApi.rmdirSync(absolute);
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || fileMode(stat) !== expected.mode
            || stat.size !== expected.size
            || sha256(readClosureFileWithoutFollowing(absolute, expected, {
              fsApi, ownerUid, ownerGid, expectedDevice: manifest.device,
            })) !== expected.sha256) {
          refuse(`refusing to purge changed PM2 closure file: ${relative}`,
            'artifact_changed');
        }
        fsApi.unlinkSync(absolute);
      }
      fsyncDirectory(path.dirname(absolute), fsApi);
      onDestructiveStep(`closure_purged:${relative}`);
    }
  }
  purge(quarantine);
  fsApi.rmdirSync(quarantine);
  fsyncDirectory(path.dirname(quarantine), fsApi);
  onDestructiveStep('closure_quarantine_purged');
}

function assertExactPm2Prefix(paths, attestation) {
  const prefix = fs.lstatSync(paths.pm2Prefix);
  if (!prefix.isDirectory() || prefix.isSymbolicLink() || prefix.uid !== 0 || prefix.gid !== 0
      || fileMode(prefix) !== 0o755) {
    refuse('PM2 root package prefix is unsafe', 'unsafe_pm2_closure');
  }
  const entries = fs.readdirSync(paths.pm2Prefix).sort();
  if (canonicalJson(entries) !== canonicalJson([attestation.version])) {
    refuse('PM2 root package prefix contains an unallowlisted closure',
      'unknown_pm2_authority');
  }
}

function assertExactInstalledPm2Package(plan, paths) {
  const attestationRaw = safeJson(paths.pm2Attestation, {
    label: 'PM2 root installation attestation',
  });
  const attestation = assertAttestation(attestationRaw.value);
  if (sha256(attestationRaw.bytes) !== plan.pm2.attestationSha256
      || attestation.version !== plan.pm2.version
      || attestation.closureRoot !== plan.pm2.closureRoot
      || hashRegularFile(paths.pm2Launcher, { mode: 0o755 }) !== plan.pm2.launcherSha256
      || hashRegularFile(paths.pm2Lock, { mode: 0o644 }) !== plan.pm2.packageLockSha256
      || hashRegularFile(attestation.node.path, {
        mode: 0o755,
        maxBytes: 256 * 1024 * 1024,
      }) !== attestation.node.sha256) {
    refuse('PM2 root package changed after retirement admission', 'artifact_changed');
  }
  assertExactPm2Prefix(paths, attestation);
  if (inspectPm2ClosureForRetirement(plan.pm2.closureRoot, {
    expectedDevice: plan.pm2.closureDevice,
  }).sha256 !== plan.pm2.closureSha256) {
    refuse('PM2 closure changed after retirement admission', 'artifact_changed');
  }
}

function assertRemainingGovernedPackageFiles(plan, paths, {
  allowSubset = false,
  fsApi = fs,
} = {}) {
  const governedFiles = [
    [paths.pm2Launcher, 0o755, plan.pm2.launcherSha256],
    [paths.pm2Lock, 0o644, plan.pm2.packageLockSha256],
    [paths.pm2Attestation, 0o600, plan.pm2.attestationSha256],
  ];
  for (const [file, mode, expectedSha256] of governedFiles) {
    if (!pathExists(file, fsApi)) {
      if (!allowSubset) {
        refuse(`PM2 package artifact disappeared after admission: ${file}`,
          'artifact_changed');
      }
      continue;
    }
    if (hashRegularFile(file, { mode, fsApi }) !== expectedSha256) {
      refuse(`PM2 package artifact changed after admission: ${file}`, 'artifact_changed');
    }
  }
}

function assertEmptyOrAbsentPm2Prefix(paths, plan, {
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
} = {}) {
  if (!pathExists(paths.pm2Prefix, fsApi)) return;
  const stat = fsApi.lstatSync(paths.pm2Prefix);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid
      || stat.gid !== ownerGid || fileMode(stat) !== 0o755
      || fsApi.readdirSync(paths.pm2Prefix).length !== 0
      || path.dirname(plan.pm2.closureRoot) !== paths.pm2Prefix) {
    refuse('detached PM2 prefix contains unallowlisted authority', 'unknown_pm2_authority');
  }
}

function verifyDetachedClosureContinuity(plan, phase, paths, evidence) {
  const quarantine = closureQuarantinePath(plan);
  const sourcePresent = pathExists(plan.pm2.closureRoot);
  const quarantinePresent = pathExists(quarantine);
  const manifestPresent = pathExists(closureManifestPath(plan, paths));
  if (['admitted', 'fallback_barred'].includes(phase)) {
    if (quarantinePresent || manifestPresent) {
      refuse('premature PM2 closure retirement evidence exists', 'artifact_changed');
    }
    return;
  }
  if (phase === 'systemd_retired') {
    if (sourcePresent === quarantinePresent) {
      refuse('PM2 closure is not in exactly one resumable location', 'artifact_changed');
    }
    const current = sourcePresent ? plan.pm2.closureRoot : quarantine;
    const inspection = inspectPm2ClosureForRetirement(current, {
      expectedDevice: plan.pm2.closureDevice,
    });
    if (inspection.sha256 !== plan.pm2.closureSha256) {
      refuse('PM2 closure changed before detachment completed', 'artifact_changed');
    }
    if (sourcePresent) {
      assertExactPm2Prefix(paths, { version: plan.pm2.version });
    } else {
      assertEmptyOrAbsentPm2Prefix(paths, plan);
    }
    if (manifestPresent) {
      const { manifest } = readClosureManifest(plan, paths);
      if (canonicalJson(manifest.entries) !== canonicalJson(inspection.entries)) {
        refuse('PM2 closure manifest does not match the resumable closure',
          'artifact_changed');
      }
    }
    return;
  }
  const closureEvidence = assertClosureEvidence(evidence, plan, { paths });
  const { manifest } = readClosureManifest(plan, paths, { evidence: closureEvidence });
  if (sourcePresent) {
    refuse('detached PM2 closure reappeared at its active path', 'artifact_changed');
  }
  if (phase === 'closure_detached' && quarantinePresent) {
    assertRemainingClosureMatchesManifest(quarantine, manifest);
  } else if (phase !== 'closure_detached' && quarantinePresent) {
    refuse('retired PM2 closure quarantine remains', 'artifact_changed');
  }
}

function safeJson(file, options) {
  return parseBoundedJson(file, options);
}

function collectConflictingState(paths) {
  const conflicts = [];
  for (const file of [
    paths.recovery,
    paths.controlPlaneTransaction,
    paths.controlPlanePostGate,
    paths.controlPlaneFinalization,
    paths.pm2InstallJournal,
  ]) {
    if (pathExists(file)) conflicts.push(file);
  }
  const stateDir = path.dirname(paths.journal);
  for (const name of fs.readdirSync(stateDir)) {
    if (/^(?:bootstrap-rebaseline-|bootstrap-baseline\.json\.next-|bootstrap-(?:legacy-runtime|database-transition)\.json\.next-)/u.test(name)) {
      conflicts.push(path.join(stateDir, name));
    }
  }
  return conflicts.sort();
}

function collectSystemdArtifacts(paths) {
  const artifacts = [];
  const ownUnit = currentRetirementServiceUnit();
  const listedPm2Units = commandResult('/usr/bin/systemctl', [
    'list-unit-files', '--type=service', '--no-legend', '--no-pager',
  ]).split('\n').map((line) => line.trim().split(/\s+/u)[0]).filter((unit) => (
    unit && /pm2/iu.test(unit)
  ));
  for (const unit of listedPm2Units) {
    if (!PM2_UNITS.includes(unit) && unit !== ownUnit) {
      artifacts.push({
        path: `systemd-unit:${unit}`,
        allowed: false,
        kind: 'unknown-unit',
      });
    }
  }
  for (const unit of PM2_UNITS) {
    const canonical = path.join(paths.unitRoot, unit);
    if (pathExists(canonical)) {
      const stat = fs.lstatSync(canonical);
      artifacts.push({
        path: canonical,
        allowed: stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0
          && stat.gid === 0 && fileMode(stat) === 0o644 && stat.nlink === 1,
        kind: 'unit',
        sha256: stat.isFile() ? sha256(fs.readFileSync(canonical)) : null,
      });
    }
    const wanted = path.join(paths.unitRoot, 'multi-user.target.wants', unit);
    if (pathExists(wanted)) {
      const stat = fs.lstatSync(wanted);
      artifacts.push({
        path: wanted,
        allowed: stat.isSymbolicLink() && fs.readlinkSync(wanted) === canonical,
        kind: 'enable-link',
        linkTarget: stat.isSymbolicLink() ? fs.readlinkSync(wanted) : null,
      });
    }
  }
  return artifacts;
}

function collectGuards(paths) {
  const root = fs.lstatSync(paths.guardRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.gid !== 0
      || fileMode(root) !== 0o755) {
    refuse('PM2 persistent guard root is unsafe', 'pm2_guard_missing');
  }
  return PM2_UNITS.map((unit) => {
    const guard = path.join(paths.guardRoot, unit);
    const stat = fs.lstatSync(guard);
    return {
      unit,
      path: guard,
      owner: `${stat.uid === 0 ? 'root' : stat.uid}:${stat.gid === 0 ? 'root' : stat.gid}`,
      linkTarget: stat.isSymbolicLink() ? fs.readlinkSync(guard) : null,
      loadState: systemctlValue(unit, 'LoadState'),
      fragmentPath: systemctlValue(unit, 'FragmentPath'),
      canStart: systemctlValue(unit, 'CanStart'),
      activeState: systemctlValue(unit, 'ActiveState'),
      dropInPaths: systemctlValue(unit, 'DropInPaths'),
    };
  });
}

function collectTimers() {
  return REQUIRED_TIMERS.map((unit) => ({
    unit,
    loadState: systemctlValue(unit, 'LoadState'),
    activeState: systemctlValue(unit, 'ActiveState'),
    unitFileState: systemctlValue(unit, 'UnitFileState'),
  }));
}

function collectServices() {
  return REQUIRED_SUCCESSFUL_SERVICES.map((unit) => ({
    unit,
    activeState: systemctlValue(unit, 'ActiveState'),
    result: systemctlValue(unit, 'Result'),
    execMainStatus: systemctlValue(unit, 'ExecMainStatus'),
  }));
}

function exactContainerHealth(policy, state) {
  let exactImages = true;
  for (const [environment, project] of [['production', 'nexus-production'], ['staging', 'nexus-staging']]) {
    for (const [service, identity] of [
      ['backend', state.active.images.backend],
      ['content-engine', state.active.images.contentEngine],
    ]) {
      const ids = commandResult('/usr/bin/docker', [
        'ps', '--filter', `label=com.docker.compose.project=${project}`,
        '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}',
      ]).split('\n').filter(Boolean);
      if (ids.length !== 1) exactImages = false;
      else {
        const inspected = JSON.parse(commandResult('/usr/bin/docker', ['inspect', ids[0]]));
        const container = inspected[0];
        if (container?.State?.Running !== true || container?.State?.Health?.Status !== 'healthy'
            || container?.Config?.Image !== `${identity.repository}@${identity.digest}`) {
          exactImages = false;
        }
      }
    }
  }
  const health = {};
  for (const [environment, ports] of Object.entries({
    production: [policy.environments.production.backendPort, policy.environments.production.contentEnginePort],
    staging: [policy.environments.staging.backendPort, policy.environments.staging.contentEnginePort],
  })) {
    health[environment] = ports.every((port) => {
      try {
        commandResult('/usr/bin/curl', [
          '--fail', '--silent', '--show-error', '--max-time', '3',
          `http://127.0.0.1:${port}/health`,
        ], { timeout: 5_000 });
        return true;
      } catch { return false; }
    });
  }
  return { ...health, exactImages };
}

function assertNoPm2Process(paths) {
  const result = spawnSync('/usr/bin/pgrep', ['-u', 'dominguez', '-af', 'PM2|pm2'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status === 0 && result.stdout.trim()) return false;
  if (result.status !== 1) return false;
  if (!pathExists(paths.pm2Prefix)) return true;
  const lsof = spawnSync('/usr/bin/lsof', ['-t', '+D', paths.pm2Prefix], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return lsof.status === 1 && !lsof.stdout.trim() && !lsof.stderr.trim();
}

function collectInstalledControlPlaneEvidence(paths) {
  const checkout = '/opt/nexus-release/checkout';
  const selector = fs.lstatSync(checkout);
  if (!selector.isSymbolicLink() || selector.uid !== 0 || selector.gid !== 0) {
    refuse('active control-plane selector is unsafe', 'control_plane_unsettled');
  }
  const resolved = fs.realpathSync(checkout);
  const match = /^\/opt\/nexus-release\/control-plane\/([0-9a-f]{40})$/u.exec(resolved);
  const target = fs.lstatSync(resolved);
  if (!match || !target.isDirectory() || target.isSymbolicLink()
      || target.uid !== 0 || target.gid !== 0 || (fileMode(target) & 0o222) !== 0) {
    refuse('active control-plane target is not an immutable version',
      'control_plane_unsettled');
  }
  const sourceMarker = readBoundedFile(path.join(resolved, '.nexus-control-plane-ready'), {
    label: 'control-plane readiness marker',
    maxBytes: 512,
    mode: 0o444,
  }).toString('utf8').trim();
  const markerFields = sourceMarker.split(' ');
  if (markerFields.length !== 3 || markerFields[0] !== match[1]
      || markerFields[1] !== 'https://github.com/felipedrf74/cortex-telegram-hub-bot.git'
      || markerFields[2] !== '/usr/bin/node:v22.23.1') {
    refuse('control-plane readiness marker is invalid', 'control_plane_unsettled');
  }
  const treeSha256 = readBoundedFile(
    path.join(resolved, '.nexus-control-plane-tree.sha256'),
    { label: 'control-plane tree digest', maxBytes: 128, mode: 0o444 },
  ).toString('utf8').trim();
  assertHex(treeSha256, HEX_64, 'control-plane tree digest');
  let installed;
  try {
    const recomputedTreeSha256 = computeImmutableControlPlaneTreeDigest(resolved);
    if (recomputedTreeSha256 !== treeSha256) {
      refuse('installed control-plane tree differs from its immutable digest',
        'control_plane_unsettled');
    }
    installed = computeReleaseControlPlaneIdentity(checkout);
    assertReleaseControlPlaneNativeRuntime(resolved);
  } catch {
    refuse('installed v3 control-plane identity is unprovable',
      'control_plane_unsettled');
  }
  return assertControlPlaneEvidence({
    schema: installed.schema,
    digest: installed.digest,
    sourceSha: match[1],
    treeSha256,
    transactionGatePresent: pathExists(paths.controlPlaneTransaction),
  });
}

export function inspectLegacyDatabaseQuiescence({
  databasePaths = LEGACY_DATABASE_PATHS,
  fsApi = fs,
  spawn = spawnSync,
  expectedUid = Number(commandResult('/usr/bin/id', ['-u', 'dominguez'])),
  expectedGid = Number(commandResult('/usr/bin/id', ['-g', 'dominguez'])),
} = {}) {
  if (!Number.isSafeInteger(expectedUid) || expectedUid <= 0
      || !Number.isSafeInteger(expectedGid) || expectedGid <= 0) {
    refuse('legacy database owner identity is invalid', 'unsafe_evidence');
  }
  const candidates = databasePaths.flatMap((base) => [
    base, `${base}-wal`, `${base}-shm`, `${base}-journal`,
  ]);
  const existing = [];
  for (const candidate of candidates) {
    if (!pathExists(candidate, fsApi)) continue;
    const stat = fsApi.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.uid !== expectedUid || stat.gid !== expectedGid
        || fileMode(stat) !== 0o600) {
      refuse(`legacy database path is unsafe: ${candidate}`, 'unsafe_evidence');
    }
    existing.push(candidate);
  }
  if (existing.length === 0) return true;
  const result = spawn('/usr/bin/lsof', ['-t', '--', ...existing], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  });
  return result.status === 1 && !result.stdout.trim() && !result.stderr.trim();
}

export function inspectLinuxPm2FallbackRetirement({ policy, paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS }) {
  const stateRaw = safeJson(paths.state, { label: 'release host state' });
  const state = assertReleaseStateShape(stateRaw.value);
  if (!state.active) refuse('release host has no active container release', 'active_release_unprovable');
  const activePath = path.join(paths.receiptDir, `${state.active.releaseId}.json`);
  const activeRaw = safeJson(activePath, { label: 'active release receipt' });
  const activeReceipt = assertReleaseReceiptShape(activeRaw.value);
  const effective = resolveEffectiveRelease({ state, readReceipt: () => activeReceipt });
  const baselineRaw = safeJson(paths.baseline, { label: 'release bootstrap baseline' });
  const baseline = assertReleaseBootstrapBaselineShape(baselineRaw.value, policy);
  const anchorPath = path.join(paths.receiptDir, `${baseline.target.releaseId}.json`);
  const anchorRaw = anchorPath === activePath
    ? activeRaw
    : safeJson(anchorPath, { label: 'first container receipt' });
  const anchorReceipt = assertReleaseReceiptShape(anchorRaw.value);
  const attestationRaw = safeJson(paths.pm2Attestation, { label: 'PM2 root installation attestation' });
  const attestation = assertAttestation(attestationRaw.value);
  assertExactPm2Prefix(paths, attestation);
  if (hashRegularFile(attestation.node.path, {
    mode: 0o755,
    maxBytes: 256 * 1024 * 1024,
  }) !== attestation.node.sha256) {
    refuse('PM2 attested Node runtime changed', 'pm2_attestation_mismatch');
  }
  const controlPlane = collectInstalledControlPlaneEvidence(paths);
  const pm2Closure = inspectPm2ClosureForRetirement(attestation.closureRoot);
  const host = {
    clockSynchronized: commandResult('/usr/bin/timedatectl', [
      'show', '--property=NTPSynchronized', '--value',
    ]) === 'yes',
    conflictingState: collectConflictingState(paths),
    controlPlane,
    guards: collectGuards(paths),
    timers: collectTimers(),
    services: collectServices(),
    backupLiveness: collectBackupLiveness(policy),
    health: exactContainerHealth(policy, state),
    pm2Quiescent: assertNoPm2Process(paths),
    legacyDatabaseQuiescent: inspectLegacyDatabaseQuiescence(),
    pm2Attestation: attestation,
    pm2AttestationSha256: sha256(attestationRaw.bytes),
    pm2LauncherSha256: hashRegularFile(paths.pm2Launcher, { mode: 0o755 }),
    pm2LockSha256: hashRegularFile(paths.pm2Lock, { mode: 0o644 }),
    pm2ClosureSha256: pm2Closure.sha256,
    pm2ClosureDevice: pm2Closure.device,
    systemdArtifacts: collectSystemdArtifacts(paths),
    preservedPaths: [...PM2_FALLBACK_PRESERVED_PATHS],
  };
  return evaluatePm2FallbackRetirementAdmission({
    policy, state, effective, activeReceipt,
    activeReceiptSha256: sha256(activeRaw.bytes),
    baseline, baselineSha256: sha256(baselineRaw.bytes),
    baselineAuthorizationDigest: sha256(canonicalJson(baseline)),
    anchorReceipt, anchorReceiptSha256: sha256(anchorRaw.bytes),
    host,
  });
}

function requirePlanPath(plan, candidate, allowed, packagePaths = []) {
  if (!allowed.includes(candidate)) {
    refuse(`refusing non-allowlisted retirement path: ${candidate}`, 'unsafe_removal');
  }
  if (!plan.pm2.systemdArtifacts.some((entry) => entry.path === candidate)
      && !packagePaths.includes(candidate)) {
    refuse(`retirement path was not captured by the admitted plan: ${candidate}`, 'unsafe_removal');
  }
}

export function assertRemainingPlannedSystemdArtifacts({
  planned,
  observed,
  allowSubset = false,
}) {
  if (!Array.isArray(planned) || !Array.isArray(observed)) {
    refuse('PM2 systemd continuity evidence is malformed', 'artifact_changed');
  }
  const plannedByPath = new Map(planned.map((entry) => [entry.path, entry]));
  const seen = new Set();
  for (const artifact of observed) {
    const expected = plannedByPath.get(artifact?.path);
    if (!expected || seen.has(artifact.path)
        || canonicalJson(artifact) !== canonicalJson(expected)) {
      refuse('PM2 systemd authority changed after retirement admission',
        'artifact_changed');
    }
    seen.add(artifact.path);
  }
  if (!allowSubset && seen.size !== plannedByPath.size) {
    refuse('PM2 systemd authority changed after retirement admission',
      'artifact_changed');
  }
  return true;
}

function verifyLinuxPlanContinuity({ plan, phase, closureEvidence, policy, paths }) {
  if (!policy) refuse('retirement resume requires the governed policy', 'malformed_evidence');
  const state = assertReleaseStateShape(safeJson(paths.state, {
    label: 'release host state',
  }).value);
  if (!state.active || state.blocked !== null || state.active.releaseId !== plan.active.releaseId) {
    refuse('active release changed after retirement admission', 'active_release_unprovable');
  }
  const activeRaw = safeJson(
    path.join(paths.receiptDir, `${plan.active.releaseId}.json`),
    { label: 'active release receipt' },
  );
  const activeReceipt = assertReleaseReceiptShape(activeRaw.value);
  const effective = resolveEffectiveRelease({ state, readReceipt: () => activeReceipt });
  if (!effective.provable || effective.status !== RELEASE_STATUSES.COMPLETED
      || effective.releaseId !== plan.active.releaseId
      || sha256(activeRaw.bytes) !== plan.active.receiptSha256
      || activeReceipt.sourceSha !== plan.active.sourceSha
      || activeReceipt.identity.releasePayloadDigest !== plan.active.releasePayloadDigest
      || canonicalJson(activeReceipt.controlPlane) !== canonicalJson({
        schema: plan.controlPlane.schema,
        digest: plan.controlPlane.digest,
      })) {
    refuse('active completed receipt changed after retirement admission',
      'active_release_unprovable');
  }
  const baselineRaw = safeJson(paths.baseline, {
    label: 'release bootstrap baseline',
  });
  const baseline = assertReleaseBootstrapBaselineShape(baselineRaw.value, policy);
  const baselineSha256 = sha256(baselineRaw.bytes);
  const baselineAuthorizationDigest = sha256(canonicalJson(baseline));
  if (baselineSha256 !== plan.anchor.baselineSha256
      || baselineAuthorizationDigest !== plan.anchor.baselineAuthorizationDigest
      || baseline.target.releaseId !== plan.anchor.releaseId
      || baseline.target.sourceSha !== plan.anchor.sourceSha) {
    refuse('bootstrap baseline changed after retirement admission', 'bootstrap_receipt_mismatch');
  }
  const anchorRaw = plan.anchor.releaseId === plan.active.releaseId
    ? activeRaw
    : safeJson(path.join(paths.receiptDir, `${plan.anchor.releaseId}.json`), {
      label: 'first container receipt',
    });
  const anchorReceipt = assertReleaseReceiptShape(anchorRaw.value);
  if (anchorReceipt.outcome !== RELEASE_RECEIPT_OUTCOMES.COMPLETED
      || anchorReceipt.sourceSha !== plan.anchor.sourceSha
      || anchorReceipt.completedAt !== plan.anchor.completedAt
      || sha256(anchorRaw.bytes) !== plan.anchor.receiptSha256) {
    refuse('anchor completed receipt changed after retirement admission',
      'bootstrap_receipt_mismatch');
  }
  const baselineDetail = `sha256:${baselineAuthorizationDigest}`;
  checkPair(anchorReceipt.staging?.checks, 'owner_bootstrap_baseline', baselineDetail, 'staging');
  checkPair(
    anchorReceipt.production?.checks,
    'bootstrap_production_revalidation',
    baselineDetail,
    'production',
  );
  if (commandResult('/usr/bin/timedatectl', [
    'show', '--property=NTPSynchronized', '--value',
  ]) !== 'yes') {
    refuse('host clock synchronization is not proved', 'clock_untrusted');
  }
  const conflictingState = collectConflictingState(paths);
  if (conflictingState.length > 0) {
    refuse(`retirement-conflicting state exists: ${conflictingState.join(',')}`,
      'conflicting_state');
  }
  const controlPlane = collectInstalledControlPlaneEvidence(paths);
  if (canonicalJson(controlPlane) !== canonicalJson(plan.controlPlane)) {
    refuse('control-plane identity changed after retirement admission',
      'control_plane_unsettled');
  }
  for (const unit of PM2_UNITS) {
    assertUnitGuard(collectGuards(paths).find((entry) => entry.unit === unit), unit);
  }
  assertTimers(collectTimers());
  // The poller is proved immediately before admission. Once the durable journal
  // exists its systemd condition may intentionally skip a timer invocation, so
  // resume binds the admitted plan while retaining backup/restore health proof.
  assertServices(collectServices(), { requirePoller: false });
  collectBackupLiveness(policy);
  const health = exactContainerHealth(policy, state);
  if (!health.production || !health.staging || !health.exactImages) {
    refuse('container identity changed after retirement admission', 'container_unhealthy');
  }
  if (!assertNoPm2Process(paths)) {
    refuse('PM2 process or package handle appeared after retirement admission',
      'pm2_not_quiescent');
  }
  if (!inspectLegacyDatabaseQuiescence()) {
    refuse('legacy database or sidecar handle appeared after retirement admission',
      'legacy_database_not_quiescent');
  }
  const observedSystemd = collectSystemdArtifacts(paths);
  if (observedSystemd.some((entry) => entry.allowed !== true)) {
    refuse('unknown PM2 authority appeared after retirement admission',
      'unknown_pm2_authority');
  }
  if (phase === 'admitted') {
    assertRemainingPlannedSystemdArtifacts({
      planned: plan.pm2.systemdArtifacts,
      observed: observedSystemd,
    });
  } else if (phase === 'fallback_barred') {
    assertRemainingPlannedSystemdArtifacts({
      planned: plan.pm2.systemdArtifacts,
      observed: observedSystemd,
      allowSubset: true,
    });
  } else if (observedSystemd.length > 0) {
    refuse('retired PM2 systemd authority reappeared', 'artifact_changed');
  }
  verifyDetachedClosureContinuity(plan, phase, paths, closureEvidence);
  if (['admitted', 'fallback_barred'].includes(phase)) {
    assertExactInstalledPm2Package(plan, paths);
  } else if (phase === 'systemd_retired') {
    assertRemainingGovernedPackageFiles(plan, paths);
  } else if (phase === 'closure_detached') {
    assertRemainingGovernedPackageFiles(plan, paths, { allowSubset: true });
    assertEmptyOrAbsentPm2Prefix(paths, plan);
  }
  if (['package_retired', 'verified'].includes(phase)) {
    for (const candidate of [
      paths.pm2Launcher,
      paths.pm2Lock,
      paths.pm2Attestation,
      plan.pm2.closureRoot,
      closureQuarantinePath(plan),
      paths.pm2Prefix,
    ]) {
      if (pathExists(candidate)) {
        refuse(`retired PM2 package authority reappeared: ${candidate}`, 'artifact_changed');
      }
    }
  }
}

export function createLinuxPm2FallbackRetirementMutator({
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  policy,
  fsApi = fs,
  ownerUid = 0,
  ownerGid = 0,
  onDestructiveStep = () => {},
} = {}) {
  const allowedSystemd = PM2_UNITS.flatMap((unit) => [
    path.join(paths.unitRoot, unit),
    path.join(paths.unitRoot, 'multi-user.target.wants', unit),
  ]);
  const allowedPackage = [
    paths.pm2Launcher, paths.pm2Lock, paths.pm2Attestation,
  ];
  return {
    async verifyResume(plan, phase, closureEvidence) {
      assertPlan(plan);
      verifyLinuxPlanContinuity({ plan, phase, closureEvidence, policy, paths });
    },
    async retireSystemd(plan) {
      for (const artifact of plan.pm2.systemdArtifacts) {
        requirePlanPath(plan, artifact.path, allowedSystemd);
        if (!pathExists(artifact.path, fsApi)) continue;
        const stat = fsApi.lstatSync(artifact.path);
        if (artifact.kind === 'unit') {
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
              || stat.uid !== 0 || stat.gid !== 0 || fileMode(stat) !== 0o644
              || sha256(fsApi.readFileSync(artifact.path)) !== artifact.sha256) {
            refuse(`PM2 unit changed after admission: ${artifact.path}`, 'artifact_changed');
          }
        } else if (!stat.isSymbolicLink()
            || fsApi.readlinkSync(artifact.path) !== artifact.linkTarget) {
          refuse(`PM2 enable link changed after admission: ${artifact.path}`, 'artifact_changed');
        }
        unlinkDurably(artifact.path, fsApi);
        onDestructiveStep(`systemd_retired:${artifact.path}`);
      }
      commandResult('/usr/bin/systemctl', ['daemon-reload']);
      for (const unit of PM2_UNITS) {
        assertUnitGuard(collectGuards(paths).find((entry) => entry.unit === unit), unit);
      }
    },
    async detachPackageClosure(plan) {
      const quarantine = closureQuarantinePath(plan);
      const current = pathExists(plan.pm2.closureRoot, fsApi)
        ? plan.pm2.closureRoot
        : quarantine;
      if (!pathExists(current, fsApi)) {
        refuse('PM2 closure is missing before detachment', 'artifact_changed');
      }
      const inspection = inspectPm2ClosureForRetirement(current, {
        fsApi, ownerUid, ownerGid, expectedDevice: plan.pm2.closureDevice,
      });
      if (inspection.sha256 !== plan.pm2.closureSha256) {
        refuse('PM2 closure changed after admission', 'artifact_changed');
      }
      const expectedManifest = closureManifestFor(plan, inspection);
      const manifestPath = closureManifestPath(plan, paths);
      if (!pathExists(manifestPath, fsApi)) {
        atomicWriteJson(manifestPath, expectedManifest, {
          fsApi, ownerUid, ownerGid, noReplace: true,
        });
      }
      const parsed = readClosureManifest(plan, paths, { fsApi, ownerUid, ownerGid });
      if (canonicalJson(parsed.manifest.entries)
          !== canonicalJson(expectedManifest.entries)) {
        refuse('PM2 closure manifest conflicts with the resumable closure',
          'artifact_changed');
      }
      detachPm2ClosureAtomically({
        source: plan.pm2.closureRoot,
        quarantine,
        expectedSha256: plan.pm2.closureSha256,
        expectedDevice: plan.pm2.closureDevice,
        expectedEntries: parsed.manifest.entries,
        fsApi,
        ownerUid,
        ownerGid,
        onDestructiveStep,
      });
      return {
        quarantinePath: quarantine,
        manifestPath,
        manifestSha256: sha256(parsed.bytes),
        device: plan.pm2.closureDevice,
        entryCount: parsed.manifest.entries.length,
      };
    },
    async retirePackage(plan, closureEvidence) {
      const evidence = assertClosureEvidence(closureEvidence, plan, { paths });
      const { manifest } = readClosureManifest(plan, paths, {
        fsApi, ownerUid, ownerGid, evidence,
      });
      const governedFiles = [
        [paths.pm2Launcher, 0o755, plan.pm2.launcherSha256],
        [paths.pm2Lock, 0o644, plan.pm2.packageLockSha256],
        [paths.pm2Attestation, 0o600, plan.pm2.attestationSha256],
      ];
      for (const [file, mode, expectedSha256] of governedFiles) {
        requirePlanPath(plan, file, allowedPackage, allowedPackage);
        if (!pathExists(file, fsApi)) continue;
        if (hashRegularFile(file, { mode, ownerUid, ownerGid, fsApi })
            !== expectedSha256) {
          refuse(`PM2 package artifact changed after admission: ${file}`, 'artifact_changed');
        }
        unlinkDurably(file, fsApi);
        onDestructiveStep(`package_retired:${file}`);
      }
      requirePlanPath(
        plan,
        plan.pm2.closureRoot,
        [plan.pm2.closureRoot],
        [plan.pm2.closureRoot],
      );
      if (pathExists(plan.pm2.closureRoot, fsApi)) {
        refuse('PM2 closure active path reappeared after detachment', 'artifact_changed');
      }
      purgeDetachedPm2Closure({
        quarantine: evidence.quarantinePath,
        manifest,
        fsApi,
        ownerUid,
        ownerGid,
        onDestructiveStep,
      });
      if (pathExists(paths.pm2Prefix, fsApi)
          && fsApi.readdirSync(paths.pm2Prefix).length === 0) {
        fsApi.rmdirSync(paths.pm2Prefix);
        fsyncDirectory(path.dirname(paths.pm2Prefix), fsApi);
        onDestructiveStep(`package_retired:${paths.pm2Prefix}`);
      }
    },
    async verifyPost(plan, closureEvidence) {
      const evidence = assertClosureEvidence(closureEvidence, plan, { paths });
      readClosureManifest(plan, paths, { fsApi, ownerUid, ownerGid, evidence });
      for (const file of [
        ...plan.pm2.systemdArtifacts.map((entry) => entry.path),
        paths.pm2Launcher, paths.pm2Lock, paths.pm2Attestation, plan.pm2.closureRoot,
        evidence.quarantinePath, paths.pm2Prefix,
      ]) {
        if (pathExists(file, fsApi)) {
          refuse(`retired PM2 artifact remains: ${file}`, 'retirement_incomplete');
        }
      }
      for (const unit of PM2_UNITS) {
        assertUnitGuard(collectGuards(paths).find((entry) => entry.unit === unit), unit);
      }
      assertTimers(collectTimers());
      if (!assertNoPm2Process(paths)) refuse('PM2 process remains after retirement', 'pm2_not_quiescent');
      if (!inspectLegacyDatabaseQuiescence()) {
        refuse('legacy database handle remains after retirement',
          'legacy_database_not_quiescent');
      }
    },
  };
}

export function acquirePm2FallbackRetirementLocks({
  paths = DEFAULT_PM2_FALLBACK_RETIREMENT_PATHS,
  flockBin = '/usr/bin/flock',
  dominguezUid = Number(commandResult('/usr/bin/id', ['-u', 'dominguez'])),
  dominguezGid = Number(commandResult('/usr/bin/id', ['-g', 'dominguez'])),
} = {}) {
  if (!Number.isSafeInteger(dominguezUid) || dominguezUid <= 0
      || !Number.isSafeInteger(dominguezGid) || dominguezGid <= 0) {
    refuse('dominguez lock owner identity is invalid', 'unsafe_lock');
  }
  const locks = [
    [paths.controlPlaneLock, 0, 0, 0o600],
    [paths.userReleaseLock, dominguezUid, dominguezGid, 0o600],
    [paths.maintenanceLock, 0, dominguezGid, 0o660],
  ];
  const descriptors = [];
  try {
    for (const [file, uid, gid, mode] of locks) {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
          || (uid !== null && before.uid !== uid) || (gid !== null && before.gid !== gid)
          || fileMode(before) !== mode) {
        refuse(`retirement lock metadata is unsafe: ${file}`, 'unsafe_lock');
      }
      const descriptor = fs.openSync(file, 'r+');
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        fs.closeSync(descriptor);
        refuse(`retirement lock changed before acquisition: ${file}`, 'unsafe_lock');
      }
      const locked = spawnSync(flockBin, ['--nonblock', '3'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', descriptor],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
      if (locked.status !== 0) {
        fs.closeSync(descriptor);
        refuse(`retirement lock is contended: ${file}`, 'lock_contended');
      }
      const after = fs.lstatSync(file);
      if (after.dev !== opened.dev || after.ino !== opened.ino) {
        fs.closeSync(descriptor);
        refuse(`retirement lock changed after acquisition: ${file}`, 'unsafe_lock');
      }
      descriptors.push(descriptor);
    }
    return () => {
      while (descriptors.length > 0) fs.closeSync(descriptors.pop());
    };
  } catch (error) {
    while (descriptors.length > 0) fs.closeSync(descriptors.pop());
    throw error;
  }
}

export function assertDetachedRetirementService() {
  if (!/^[0-9a-f]{32}$/u.test(process.env.INVOCATION_ID ?? '')
      || process.env.SYSTEMD_EXEC_PID !== String(process.pid)) {
    refuse('apply must run inside its detached systemd retirement service',
      'detached_service_required');
  }
  const unit = currentRetirementServiceUnit();
  if (!unit) {
    refuse('retirement service cgroup identity is invalid', 'detached_service_required');
  }
}

function currentRetirementServiceUnit() {
  let cgroups;
  try {
    cgroups = fs.readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return null;
  }
  const cgroup = cgroups.split('\n')
    .map((line) => line.split(':'))
    .find(([hierarchy, controllers]) => hierarchy === '0' && controllers === '')?.[2];
  const match = /^\/system\.slice\/(nexus-pm2-fallback-retirement-[A-Za-z0-9_.@-]+\.service)$/u
    .exec(cgroup ?? '');
  return match?.[1] ?? null;
}
