#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_40 = /^[0-9a-f]{40}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u;
const CANONICAL_REPOSITORY =
  'https://github.com/felipedrf74/cortex-telegram-hub-bot.git';
const NODE_MARKER = '/usr/bin/node:v22.23.1';
const TRANSACTION_SCHEMA = 'nexus.control-plane-transaction.v1';
const RECOVERY_SCHEMA = 'nexus.control-plane-abort-recovery.v1';

export const RECOVERY_PHASES = Object.freeze([
  'prepared',
  'services_settled',
  'selectors_restored',
  'capabilities_restored',
  'backup_interface_restored',
  'units_restored',
  'timers_prepared',
  'recovery_complete',
  'gate_retired',
  'complete',
]);

const TRANSACTION_KEYS = Object.freeze([
  'backupTimerWasActive', 'backupTimerWasEnabled', 'candidateDigest',
  'controlPlaneDigest', 'controlPlaneSchema', 'createdAt', 'expectedMarker',
  'heartbeatTimerWasActive', 'heartbeatTimerWasEnabled',
  'livenessTimerDesiredActive', 'livenessTimerDesiredEnabled',
  'livenessTimerWasActive', 'livenessTimerWasEnabled', 'mode', 'operation',
  'originalActivePath', 'originalPreviousPath', 'phase',
  'pollerTimerDesiredActive', 'pollerTimerDesiredEnabled',
  'pollerTimerWasActive', 'pollerTimerWasEnabled',
  'restoreVerifyTimerWasActive', 'restoreVerifyTimerWasEnabled', 'schema',
  'sourceRepository', 'stageIdentity', 'stagePath', 'targetPath', 'targetSha',
  'updatedAt',
]);

const RECOVERY_KEYS = Object.freeze([
  'application', 'archivePath', 'createdAt', 'originalDigest',
  'originalPath', 'originalPreviousDigest', 'originalPreviousPath', 'originalSha',
  'phase', 'recoveryId', 'recoverySource', 'schema', 'sourceRepository',
  'sourceTransactionSha256', 'targetDigest', 'targetPath', 'targetSha',
  'terminalPath', 'timerIntent', 'updatedAt',
]);

export const CORE_UNITS = Object.freeze([
  'nexus-release-bootstrap.service',
  'nexus-release-poller.service',
  'nexus-release-poller.timer',
  'nexus-release-heartbeat.service',
  'nexus-release-heartbeat.timer',
]);

export const LIVENESS_UNITS = Object.freeze([
  'nexus-release-backup-liveness-force.service',
  'nexus-release-backup-liveness.service',
  'nexus-release-backup-liveness.timer',
]);

export const BACKUP_ASSETS = Object.freeze([
  ['scripts/local-backup.py',
    '/usr/local/libexec/nexus-local-backup/local-backup.py', 0o755],
  ['ops/local-backup/systemd/nexus-local-backup.service',
    '/etc/systemd/system/nexus-local-backup.service', 0o644],
  ['ops/local-backup/systemd/nexus-local-backup.timer',
    '/etc/systemd/system/nexus-local-backup.timer', 0o644],
  ['ops/local-backup/systemd/nexus-local-backup-pre-promotion.service',
    '/etc/systemd/system/nexus-local-backup-pre-promotion.service', 0o644],
  ['ops/local-backup/systemd/nexus-local-backup-restore-verify.service',
    '/etc/systemd/system/nexus-local-backup-restore-verify.service', 0o644],
  ['ops/local-backup/systemd/nexus-local-backup-restore-verify.timer',
    '/etc/systemd/system/nexus-local-backup-restore-verify.timer', 0o644],
  ['ops/local-backup/nexus-local-backup.sudoers',
    '/etc/sudoers.d/nexus-local-backup', 0o440],
]);

const CAPABILITY_ASSETS = Object.freeze([
  ['ops/nexus-release/nexus-release-state-view',
    '/usr/local/sbin/nexus-release-state-view', 0o755],
  ['ops/nexus-release/nexus-release-state-view.sudoers',
    '/etc/sudoers.d/nexus-release-state-view', 0o440],
]);

const TIMER_UNITS = Object.freeze([
  'nexus-release-poller.timer',
  'nexus-release-heartbeat.timer',
  'nexus-release-backup-liveness.timer',
  'nexus-local-backup.timer',
  'nexus-local-backup-restore-verify.timer',
]);

const SERVICE_UNITS = Object.freeze([
  'nexus-release-bootstrap.service',
  'nexus-release-poller.service',
  'nexus-release-heartbeat.service',
  'nexus-release-backup-liveness-force.service',
  'nexus-release-backup-liveness.service',
  'nexus-local-backup.service',
  'nexus-local-backup-pre-promotion.service',
  'nexus-local-backup-restore-verify.service',
]);

function refuse(message) {
  const error = new Error(`CONTROL-PLANE ABORT RECOVERY REFUSED: ${message}`);
  error.code = 'NEXUS_CONTROL_PLANE_ABORT_REFUSED';
  throw error;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${label} is not an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse(`${label} keys are not exact`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function timestamp(now) {
  const milliseconds = Math.floor(Number(now()) / 1000) * 1000;
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z');
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readStable(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) refuse(`unsafe regular file: ${file}`);
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (!sameStat(before, after)) refuse(`file changed while read: ${file}`);
  return { bytes, stat: after };
}

function parseJson(bytes, label) {
  try {
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n')) refuse(`${label} is not newline terminated`);
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'NEXUS_CONTROL_PLANE_ABORT_REFUSED') throw error;
    return refuse(`${label} is not valid JSON`);
  }
}

function boolBit(value, label) {
  if (value !== 0 && value !== 1) refuse(`${label} is not a durable 0/1 bit`);
  return value;
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)
      || Number.isNaN(Date.parse(value))) refuse(`${label} timestamp is invalid`);
}

export function computeImmutableTreeDigest(root, { expectedUid = 0, expectedGid = 0 } = {}) {
  const normalized = path.resolve(root);
  const rootBefore = fs.lstatSync(normalized);
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    refuse(`immutable tree root is unsafe: ${normalized}`);
  }
  const digest = crypto.createHash('sha256');
  const visit = (relative = '') => {
    const absolute = relative ? path.join(normalized, ...relative.split('/')) : normalized;
    const before = fs.lstatSync(absolute);
    const type = before.isDirectory() ? 'directory'
      : before.isFile() ? 'file' : before.isSymbolicLink() ? 'symlink' : '';
    if (!type || before.uid !== expectedUid || before.gid !== expectedGid
        || (type !== 'symlink' && (before.mode & 0o222) !== 0)) {
      refuse(`immutable tree entry is mutable, unowned, or unsupported: ${relative || '.'}`);
    }
    if (relative !== '.nexus-control-plane-tree.sha256') {
      const value = type === 'file' ? sha256(fs.readFileSync(absolute))
        : type === 'symlink' ? fs.readlinkSync(absolute) : '';
      digest.update(`${JSON.stringify({
        path: relative || '.', type, mode: before.mode & 0o7777, value,
      })}\n`);
    }
    if (type === 'directory') {
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(relative ? `${relative}/${name}` : name);
      }
    }
    if (!sameStat(before, fs.lstatSync(absolute))) {
      refuse(`immutable tree changed while inspected: ${relative || '.'}`);
    }
  };
  visit();
  if (!sameStat(rootBefore, fs.lstatSync(normalized))) {
    refuse(`immutable tree root changed while inspected: ${normalized}`);
  }
  return digest.digest('hex');
}

function parseArgs(argv) {
  const allowed = new Set([
    '--target-sha', '--original-sha', '--application-release-id',
    '--application-source-sha', '--application-receipt-sha256',
    '--recovery-source-sha', '--recovery-source-tree-digest',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--')) {
      refuse('usage requires seven exact owner-reviewed identity arguments');
    }
    if (Object.hasOwn(values, name)) refuse(`duplicate argument: ${name}`);
    values[name] = value;
  }
  if (Object.keys(values).length !== allowed.size) {
    refuse('usage requires seven exact owner-reviewed identity arguments');
  }
  const expected = {
    targetSha: values['--target-sha'],
    originalSha: values['--original-sha'],
    applicationReleaseId: values['--application-release-id'],
    applicationSourceSha: values['--application-source-sha'],
    applicationReceiptSha256: values['--application-receipt-sha256'],
    recoverySourceSha: values['--recovery-source-sha'],
    recoverySourceTreeDigest: values['--recovery-source-tree-digest'],
  };
  if (!HEX_40.test(expected.targetSha) || !HEX_40.test(expected.originalSha)
      || expected.targetSha === expected.originalSha
      || !HEX_32.test(expected.applicationReleaseId)
      || !HEX_40.test(expected.applicationSourceSha)
      || !HEX_64.test(expected.applicationReceiptSha256)
      || !HEX_40.test(expected.recoverySourceSha)
      || !HEX_64.test(expected.recoverySourceTreeDigest)
      || [expected.targetSha, expected.originalSha].includes(expected.recoverySourceSha)) {
    refuse('one or more owner-reviewed identities are malformed');
  }
  if (expected.originalSha !== expected.applicationSourceSha) {
    refuse('this scoped recovery requires the recorded controller original to equal the active application source');
  }
  return expected;
}

function defaultExec(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: '/var/lib/nexus-release/home',
      NODE_ENV: 'production',
    },
  });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? String(result.error ?? ''),
  };
}

function makePaths(hostRoot, targetSha, recoverySourceSha) {
  const live = {
    controlRoot: '/opt/nexus-release',
    versionRoot: '/opt/nexus-release/control-plane',
    active: '/opt/nexus-release/checkout',
    previous: '/opt/nexus-release/checkout.previous',
    stateRoot: '/var/lib/nexus-release/state',
    transaction: '/var/lib/nexus-release/state/control-plane-transaction.json',
    transactionStage: '/var/lib/nexus-release/state/control-plane-transaction.json.next',
    postGate: '/var/lib/nexus-release/state/control-plane-post-gate.json',
    finalization: '/var/lib/nexus-release/state/control-plane-finalization.json',
    recovery: '/var/lib/nexus-release/state/control-plane-abort-recovery.json',
    recoveryStage: '/var/lib/nexus-release/state/control-plane-abort-recovery.json.next',
    archive: `/var/lib/nexus-release/state/control-plane-aborted-${targetSha}.json`,
    terminal: `/var/lib/nexus-release/state/control-plane-abort-recovery-${targetSha}.json`,
    appState: '/var/lib/nexus-release/state/release-state.json',
    receiptRoot: '/var/lib/nexus-release/receipts',
    recoverySourceRoot:
      `/opt/nexus-release/recovery-tools/control-plane/${recoverySourceSha}`,
  };
  const host = (absolute) => hostRoot === '/' ? absolute
    : path.join(hostRoot, ...absolute.split('/').filter(Boolean));
  return { live, host, hostRoot };
}

function assertSafeFile(file, { expectedUid, expectedGid, mode = null, label }) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid
      || stat.gid !== expectedGid || stat.nlink !== 1
      || (mode === null ? Boolean(stat.mode & 0o022) : (stat.mode & 0o7777) !== mode)) {
    refuse(`${label} metadata is unsafe`);
  }
  return stat;
}

function assertSafeDirectory(directory, { expectedUid, expectedGid, label, exactMode = null }) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid
      || stat.gid !== expectedGid || (stat.mode & 0o022)
      || (exactMode !== null && (stat.mode & 0o7777) !== exactMode)) {
    refuse(`${label} directory metadata is unsafe`);
  }
}

export function assertRuntimeLockDirectoryMetadata(
  stat,
  { expectedUid = 0, expectedGid = 0 } = {},
) {
  if (!stat?.isDirectory?.() || stat.isSymbolicLink?.()
      || stat.uid !== expectedUid || stat.gid !== expectedGid
      || (stat.mode & 0o7777) !== 0o1777) {
    refuse('runtime lock directory is not the exact trusted sticky root');
  }
}

function captureTrustedAncestors(paths, liveTargets, owner) {
  const snapshot = new Map();
  for (const liveTarget of liveTargets) {
    if (!path.isAbsolute(liveTarget) || path.normalize(liveTarget) !== liveTarget) {
      refuse(`trusted ancestor target is not a normalized absolute path: ${liveTarget}`);
    }
    let current = path.dirname(paths.host(liveTarget));
    for (;;) {
      const relative = path.relative(paths.hostRoot, current);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        refuse(`trusted ancestor escaped its host boundary: ${liveTarget}`);
      }
      const stat = fs.lstatSync(current);
      if (current === paths.host('/run/lock')) {
        assertRuntimeLockDirectoryMetadata(stat, owner);
      } else if (!stat.isDirectory() || stat.isSymbolicLink()
          || stat.uid !== owner.expectedUid || stat.gid !== owner.expectedGid
          || (stat.mode & 0o022) !== 0) {
        refuse(`trusted ancestor is symbolic, unowned, or writable: ${current}`);
      }
      const identity = {
        dev: stat.dev,
        ino: stat.ino,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
      };
      const prior = snapshot.get(current);
      if (prior && JSON.stringify(prior) !== JSON.stringify(identity)) {
        refuse(`trusted ancestor identity conflicted: ${current}`);
      }
      snapshot.set(current, identity);
      if (current === paths.hostRoot) break;
      current = path.dirname(current);
    }
  }
  return snapshot;
}

function reassertTrustedAncestors(snapshot) {
  for (const [directory, expected] of snapshot) {
    const stat = fs.lstatSync(directory);
    const actual = {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
    };
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || JSON.stringify(actual) !== JSON.stringify(expected)) {
      refuse(`trusted ancestor changed during recovery: ${directory}`);
    }
  }
}

function recoveryAuthorityTargets(paths, expected, record = null) {
  const targets = [
    paths.live.active,
    paths.live.previous,
    paths.live.transaction,
    paths.live.transactionStage,
    paths.live.postGate,
    paths.live.finalization,
    paths.live.recovery,
    paths.live.recoveryStage,
    paths.live.archive,
    paths.live.terminal,
    paths.live.appState,
    `${paths.live.receiptRoot}/${expected.applicationReleaseId}.json`,
    `/opt/nexus-release/control-plane/${expected.targetSha}/.nexus-control-plane-ready`,
    `/opt/nexus-release/control-plane/${expected.originalSha}/.nexus-control-plane-ready`,
    `${paths.live.recoverySourceRoot}/.nexus-control-plane-ready`,
    '/var/lib/nexus-release/locks/control-plane.lock',
    '/var/lib/nexus-release/locks/release.lock',
    '/run/lock/nexus-release-sonar.lock',
    ...CAPABILITY_ASSETS.map(([, destination]) => destination),
    ...BACKUP_ASSETS.map(([, destination]) => destination),
    ...CORE_UNITS.map((unit) => `/etc/systemd/system/${unit}`),
    ...LIVENESS_UNITS.map((unit) => `/etc/systemd/system/${unit}`),
  ];
  if (record) {
    targets.push(`${record.originalPreviousPath}/.nexus-control-plane-ready`);
  }
  return targets;
}

function requireAbsent(file, label) {
  try {
    fs.lstatSync(file);
    refuse(`${label} unexpectedly exists`);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fsyncFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function selectorValue(file, versionRoot) {
  const stat = fs.lstatSync(file);
  if (!stat.isSymbolicLink()) refuse(`selector is not symbolic: ${file}`);
  const resolved = fs.realpathSync(file);
  if (path.dirname(resolved) !== versionRoot || !HEX_40.test(path.basename(resolved))) {
    refuse(`selector escaped the immutable version root: ${file}`);
  }
  return resolved;
}

function markerFor(sha) {
  return `${sha} ${CANONICAL_REPOSITORY} ${NODE_MARKER}`;
}

function assertImmutableTree(hostPath, sha, expectedDigest, owner) {
  const markerPath = path.join(hostPath, '.nexus-control-plane-ready');
  const digestPath = path.join(hostPath, '.nexus-control-plane-tree.sha256');
  assertSafeFile(markerPath, { ...owner, mode: 0o444, label: `${sha} ready marker` });
  assertSafeFile(digestPath, { ...owner, mode: 0o444, label: `${sha} tree digest` });
  const marker = fs.readFileSync(markerPath, 'utf8').trimEnd();
  const recorded = fs.readFileSync(digestPath, 'utf8').trimEnd();
  if (marker !== markerFor(sha) || !HEX_64.test(recorded)
      || (expectedDigest && recorded !== expectedDigest)) {
    refuse(`immutable tree marker or recorded digest is wrong: ${sha}`);
  }
  const computed = computeImmutableTreeDigest(hostPath, owner);
  if (computed !== recorded) refuse(`immutable tree digest changed: ${sha}`);
  return computed;
}

function assertRecoverySource(paths, expected, owner, recorded = null) {
  const sourceRoot = paths.host(paths.live.recoverySourceRoot);
  const treeDigest = assertImmutableTree(
    sourceRoot, expected.recoverySourceSha, expected.recoverySourceTreeDigest, owner,
  );
  const descriptorPath = path.join(
    sourceRoot, 'ops/nexus-release/release-control-plane-inputs.json',
  );
  const wrapperPath = path.join(
    sourceRoot, 'scripts/release-control-plane-abort-recovery.sh',
  );
  const modulePath = path.join(
    sourceRoot, 'scripts/release-control-plane-abort-recovery.mjs',
  );
  assertSafeFile(descriptorPath, {
    ...owner, mode: 0o444, label: 'recovery source control-plane descriptor',
  });
  assertSafeFile(wrapperPath, {
    ...owner, mode: 0o555, label: 'recovery source wrapper',
  });
  assertSafeFile(modulePath, {
    ...owner, mode: 0o444, label: 'recovery source module',
  });
  const descriptor = parseJson(
    readStable(descriptorPath).bytes, 'recovery source control-plane descriptor',
  );
  if (descriptor.schema !== 'nexus.release-control-plane-inputs.v1'
      || !Array.isArray(descriptor.staticFiles)
      || !descriptor.staticFiles.includes('scripts/release-control-plane-abort-recovery.sh')
      || !descriptor.staticFiles.includes('scripts/release-control-plane-abort-recovery.mjs')
      || JSON.stringify(descriptor.staticFiles)
        !== JSON.stringify([...descriptor.staticFiles].sort())) {
    refuse('signed control-plane descriptor does not govern both recovery executables');
  }
  const evidence = {
    sha: expected.recoverySourceSha,
    path: paths.live.recoverySourceRoot,
    treeDigest,
    wrapperSha256: sha256(readStable(wrapperPath).bytes),
    moduleSha256: sha256(readStable(modulePath).bytes),
  };
  if (recorded && JSON.stringify(evidence) !== JSON.stringify(recorded)) {
    refuse('immutable recovery source changed during abort recovery');
  }
  return evidence;
}

function assertTransaction(record, expected) {
  exactKeys(record, TRANSACTION_KEYS, 'source control-plane transaction');
  if (record.schema !== TRANSACTION_SCHEMA || record.operation !== 'install'
      || record.mode !== 'upgrade' || record.phase !== 'capabilities_installed'
      || record.targetSha !== expected.targetSha
      || record.targetPath !== `/opt/nexus-release/control-plane/${expected.targetSha}`
      || record.originalActivePath !== `/opt/nexus-release/control-plane/${expected.originalSha}`
      || record.sourceRepository !== CANONICAL_REPOSITORY
      || record.expectedMarker !== markerFor(expected.targetSha)
      || record.controlPlaneSchema !== 'nexus.release-control-plane.v1'
      || !HEX_64.test(record.candidateDigest) || !HEX_64.test(record.controlPlaneDigest)
      || !/^\/opt\/nexus-release\/control-plane\/[0-9a-f]{40}$/u
        .test(record.originalPreviousPath)
      || (record.stagePath !== `/opt/nexus-release/staging/${expected.targetSha}.candidate`
        && record.stagePath !== '')
      || (record.stagePath === '' ? record.stageIdentity !== ''
        : !/^[0-9]+:[0-9]+$/u.test(record.stageIdentity))) {
    refuse('source control-plane transaction identity or phase is not the exact recoverable request');
  }
  assertCanonicalTimestamp(record.createdAt, 'source transaction createdAt');
  assertCanonicalTimestamp(record.updatedAt, 'source transaction updatedAt');
  for (const key of TRANSACTION_KEYS.filter((key) => key.endsWith('Active')
    || key.endsWith('Enabled'))) boolBit(record[key], `source transaction ${key}`);
  return record;
}

function assertApplicationEvidence(
  paths,
  expected,
  owner,
  recorded,
  originalPath,
  exec,
) {
  const statePath = paths.host(paths.live.appState);
  const receiptLive = `${paths.live.receiptRoot}/${expected.applicationReleaseId}.json`;
  const receiptPath = paths.host(receiptLive);
  assertSafeFile(statePath, { ...owner, label: 'application release state' });
  assertSafeFile(receiptPath, { ...owner, label: 'application release receipt' });
  const stateRead = readStable(statePath);
  const receiptRead = readStable(receiptPath);
  const stateDigest = sha256(stateRead.bytes);
  const receiptDigest = sha256(receiptRead.bytes);
  if (receiptDigest !== expected.applicationReceiptSha256) {
    refuse('application receipt differs from the owner-reviewed digest');
  }
  if (recorded && (recorded.stateSha256 !== stateDigest
      || recorded.receiptSha256 !== receiptDigest)) {
    refuse('application state or immutable receipt changed during recovery');
  }
  const state = parseJson(stateRead.bytes, 'application release state');
  const receipt = parseJson(receiptRead.bytes, 'application release receipt');
  if (state.schema !== 'nexus.release-host-state.v1' || !state.active
      || state.active.releaseId !== expected.applicationReleaseId
      || state.active.sourceSha !== expected.applicationSourceSha
      || state.active.status !== 'completed'
      || !['nexus.release-receipt.v2', 'nexus.release-receipt.v3'].includes(receipt.schema)
      || receipt.releaseId !== expected.applicationReleaseId
      || receipt.sourceSha !== expected.applicationSourceSha
      || receipt.outcome !== 'completed' || receipt.failureCode !== null
      || receipt.evidenceDigest !== state.active.evidenceDigest
      || receipt.identity?.releasePayloadDigest !== state.active.payload?.digest) {
    refuse('application state and receipt do not prove the exact completed active release');
  }
  if ((receipt.schema === 'nexus.release-receipt.v2'
      && Object.hasOwn(receipt, 'controlPlane'))
      || (receipt.schema === 'nexus.release-receipt.v3'
        && !Object.hasOwn(receipt, 'controlPlane'))) {
    refuse('application receipt schema/control-plane pairing is contradictory');
  }
  const validatedViewRaw = commandResult(exec, '/usr/bin/node', [
    paths.host(`${originalPath}/scripts/release-state-view.mjs`),
  ], 'recorded-original release state and receipt validation');
  let validatedView;
  try { validatedView = JSON.parse(validatedViewRaw); } catch {
    refuse('recorded-original release state validator returned malformed evidence');
  }
  if (validatedView.schema !== 'nexus.release-state-view.v2'
      || validatedView.sourceSchemas?.state !== 'nexus.release-host-state.v1'
      || validatedView.active?.releaseId !== expected.applicationReleaseId
      || validatedView.active?.sourceSha !== expected.applicationSourceSha
      || validatedView.active?.status !== 'completed'
      || validatedView.activeReceipt?.schema !== receipt.schema
      || validatedView.activeReceipt?.releaseId !== expected.applicationReleaseId
      || validatedView.activeReceipt?.sourceSha !== expected.applicationSourceSha
      || validatedView.activeReceipt?.outcome !== 'completed'
      || validatedView.effective?.releaseId !== expected.applicationReleaseId
      || validatedView.effective?.status !== 'completed'
      || validatedView.effective?.provable !== true) {
    refuse('recorded-original validator did not prove the exact completed application release');
  }
  return {
    releaseId: expected.applicationReleaseId,
    sourceSha: expected.applicationSourceSha,
    receiptPath: receiptLive,
    receiptSha256: receiptDigest,
    statePath: paths.live.appState,
    stateSha256: stateDigest,
  };
}

function assertRecoveryRecord(record, expected) {
  exactKeys(record, RECOVERY_KEYS, 'control-plane abort recovery journal');
  if (record.schema !== RECOVERY_SCHEMA || !RECOVERY_PHASES.includes(record.phase)
      || !HEX_64.test(record.recoveryId) || !HEX_64.test(record.sourceTransactionSha256)
      || record.targetSha !== expected.targetSha || record.originalSha !== expected.originalSha
      || record.targetPath !== `/opt/nexus-release/control-plane/${expected.targetSha}`
      || record.originalPath !== `/opt/nexus-release/control-plane/${expected.originalSha}`
      || record.sourceRepository !== CANONICAL_REPOSITORY
      || !HEX_64.test(record.targetDigest) || !HEX_64.test(record.originalDigest)
      || !HEX_64.test(record.originalPreviousDigest)
      || !/^\/opt\/nexus-release\/control-plane\/[0-9a-f]{40}$/u
        .test(record.originalPreviousPath)
      || record.archivePath !== `/var/lib/nexus-release/state/control-plane-aborted-${expected.targetSha}.json`
      || record.terminalPath !== `/var/lib/nexus-release/state/control-plane-abort-recovery-${expected.targetSha}.json`) {
    refuse('control-plane abort recovery journal is malformed or belongs to another request');
  }
  assertCanonicalTimestamp(record.createdAt, 'recovery createdAt');
  assertCanonicalTimestamp(record.updatedAt, 'recovery updatedAt');
  exactKeys(record.recoverySource, [
    'moduleSha256', 'path', 'sha', 'treeDigest', 'wrapperSha256',
  ], 'recovery immutable source');
  if (record.recoverySource.sha !== expected.recoverySourceSha
      || record.recoverySource.treeDigest !== expected.recoverySourceTreeDigest
      || record.recoverySource.path
        !== `/opt/nexus-release/recovery-tools/control-plane/${expected.recoverySourceSha}`
      || !HEX_64.test(record.recoverySource.wrapperSha256)
      || !HEX_64.test(record.recoverySource.moduleSha256)) {
    refuse('recovery immutable source differs from owner-reviewed identity');
  }
  exactKeys(record.application, [
    'receiptPath', 'receiptSha256', 'releaseId', 'sourceSha', 'statePath', 'stateSha256',
  ], 'recovery application evidence');
  if (record.application.releaseId !== expected.applicationReleaseId
      || record.application.sourceSha !== expected.applicationSourceSha
      || record.application.receiptSha256 !== expected.applicationReceiptSha256
      || !HEX_64.test(record.application.stateSha256)) {
    refuse('recovery application evidence differs from owner-reviewed identity');
  }
  exactKeys(record.timerIntent, ['backup', 'heartbeat', 'liveness', 'poller', 'restoreVerify'],
    'recovery timer intent');
  for (const [name, intent] of Object.entries(record.timerIntent)) {
    exactKeys(intent, name === 'poller'
      ? ['active', 'deferred', 'enabled', 'reason'] : ['active', 'enabled'],
    `recovery ${name} timer intent`);
    boolBit(intent.active, `${name} active`);
    boolBit(intent.enabled, `${name} enabled`);
  }
  if (record.timerIntent.poller.active !== 0 || record.timerIntent.poller.enabled !== 0
      || record.timerIntent.poller.deferred !== true
      || record.timerIntent.poller.reason !== 'legacy_v2_reader_rejects_active_v3_release_envelope'
      || record.timerIntent.liveness.active !== 0
      || record.timerIntent.liveness.enabled !== 0) {
    refuse('recovery does not durably defer incompatible poller and target-only liveness');
  }
  return record;
}

function commandResult(exec, command, args, label, { accepted = [0] } = {}) {
  const result = exec(command, args);
  if (!result || !accepted.includes(result.status)) {
    const detail = String(result?.stderr ?? '').trim().slice(0, 240);
    refuse(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout ?? '').trim();
}

function systemctl(exec, args, label, options) {
  return commandResult(exec, '/usr/bin/systemctl', args, label, options);
}

function show(exec, unit, property) {
  return systemctl(exec, ['show', unit, `--property=${property}`, '--value'],
    `systemd ${property} read for ${unit}`);
}

function timerBits(exec, unit) {
  const loadState = show(exec, unit, 'LoadState');
  const activeState = show(exec, unit, 'ActiveState');
  if (loadState === 'not-found') {
    if (activeState !== 'inactive' || show(exec, unit, 'FragmentPath') !== '') {
      refuse(`absent timer retains effective authority: ${unit}`);
    }
    return [0, 0];
  }
  if (loadState !== 'loaded') refuse(`timer is not loaded: ${unit} (${loadState})`);
  if (activeState !== 'active' && activeState !== 'inactive') {
    refuse(`timer has unsupported active state: ${unit} (${activeState})`);
  }
  const enabled = systemctl(exec, ['is-enabled', unit], `systemd enablement read for ${unit}`, {
    accepted: [0, 1],
  });
  if (enabled !== 'enabled' && enabled !== 'disabled') {
    refuse(`timer has unsupported enablement state: ${unit} (${enabled})`);
  }
  return [activeState === 'active' ? 1 : 0, enabled === 'enabled' ? 1 : 0];
}

function requireTimerBits(exec, unit, active, enabled) {
  const actual = timerBits(exec, unit);
  if (actual[0] !== active || actual[1] !== enabled) {
    refuse(`timer state differs from durable intent: ${unit} (${actual.join('/')})`);
  }
}

function disableAllTimers(exec) {
  const failures = [];
  for (const unit of TIMER_UNITS) {
    if (show(exec, unit, 'LoadState') === 'not-found') {
      if (show(exec, unit, 'ActiveState') !== 'inactive'
          || show(exec, unit, 'FragmentPath') !== '') failures.push(unit);
      continue;
    }
    const result = exec('/usr/bin/systemctl', ['disable', '--now', unit]);
    if (!result || result.status !== 0) failures.push(unit);
  }
  if (failures.length > 0) refuse(`timer fail-safe disable failed: ${failures.join(',')}`);
}

function requireServicesNotRunning(exec) {
  for (const unit of SERVICE_UNITS) {
    const active = show(exec, unit, 'ActiveState');
    if (active !== 'inactive' && active !== 'failed') {
      refuse(`service is not settled before recovery: ${unit} (${active})`);
    }
  }
}

function settleServices(exec) {
  for (const unit of SERVICE_UNITS) {
    const load = show(exec, unit, 'LoadState');
    const active = show(exec, unit, 'ActiveState');
    if (load === 'not-found') {
      if (active !== 'inactive' || show(exec, unit, 'FragmentPath') !== '') {
        refuse(`absent service retains effective authority: ${unit}`);
      }
      continue;
    }
    if (active === 'active' || active === 'activating' || active === 'deactivating') {
      systemctl(exec, ['stop', unit], `service stop for ${unit}`);
    }
    systemctl(exec, ['reset-failed', unit], `service failure reset for ${unit}`,
      { accepted: [0] });
    if (show(exec, unit, 'ActiveState') !== 'inactive') {
      refuse(`service did not settle inactive: ${unit}`);
    }
  }
}

function fileEquals(left, right) {
  const leftRead = readStable(left);
  const rightRead = readStable(right);
  return leftRead.bytes.equals(rightRead.bytes);
}

function assertInstalledMatches(destination, source, mode, owner, label) {
  assertSafeFile(destination, { ...owner, mode, label });
  if (!fileEquals(destination, source)) refuse(`${label} differs from immutable source`);
}

function assertInstalledMatchesOneOf(destination, candidates, mode, owner, label) {
  assertSafeFile(destination, { ...owner, mode, label });
  if (!candidates.some((candidate) => fileEquals(destination, candidate))) {
    refuse(`${label} differs from all admitted immutable versions`);
  }
}

function sourcePath(paths, rootLive, relative) {
  return paths.host(`${rootLive}/${relative}`);
}

function assertKnownInstalledMixture(paths, record, owner) {
  for (const [relative, destinationLive, mode] of CAPABILITY_ASSETS) {
    assertInstalledMatchesOneOf(paths.host(destinationLive), [
      sourcePath(paths, record.targetPath, relative),
      sourcePath(paths, record.originalPath, relative),
    ], mode, owner, `installed transition capability ${destinationLive}`);
  }
  for (const unit of CORE_UNITS) {
    const relative = `ops/nexus-release/${unit}`;
    assertInstalledMatchesOneOf(paths.host(`/etc/systemd/system/${unit}`), [
      sourcePath(paths, record.targetPath, relative),
      sourcePath(paths, record.originalPath, relative),
    ], 0o644, owner, `installed transition core unit ${unit}`);
  }
  for (const [relative, destinationLive, mode] of BACKUP_ASSETS) {
    assertInstalledMatchesOneOf(paths.host(destinationLive), [
      sourcePath(paths, record.targetPath, relative),
      sourcePath(paths, record.originalPath, relative),
    ], mode, owner, `installed transition backup asset ${destinationLive}`);
  }
  for (const unit of LIVENESS_UNITS) {
    const destination = paths.host(`/etc/systemd/system/${unit}`);
    if (exists(destination)) {
      assertInstalledMatches(destination,
        sourcePath(paths, record.targetPath, `ops/nexus-release/${unit}`),
        0o644, owner, `installed transition liveness unit ${unit}`);
    }
  }
}

function assertExactInitialPhaseMixture(paths, transaction, owner) {
  for (const [relative, destinationLive, mode] of CAPABILITY_ASSETS) {
    assertInstalledMatches(paths.host(destinationLive),
      sourcePath(paths, transaction.targetPath, relative), mode, owner,
      `installed target capability ${destinationLive}`);
  }
  for (const unit of CORE_UNITS) {
    assertInstalledMatches(paths.host(`/etc/systemd/system/${unit}`),
      sourcePath(paths, transaction.originalActivePath, `ops/nexus-release/${unit}`),
      0o644, owner, `installed recorded-original core unit ${unit}`);
  }
  for (const [relative, destinationLive, mode] of BACKUP_ASSETS) {
    assertInstalledMatches(paths.host(destinationLive),
      sourcePath(paths, transaction.targetPath, relative), mode, owner,
      `installed target backup asset ${destinationLive}`);
  }
  for (const unit of LIVENESS_UNITS) {
    const destination = paths.host(`/etc/systemd/system/${unit}`);
    if (exists(destination)) {
      assertInstalledMatches(destination,
        sourcePath(paths, transaction.targetPath, `ops/nexus-release/${unit}`),
        0o644, owner, `known target liveness unit ${unit}`);
    }
  }
}

function assertSelectorsKnown(paths, record) {
  const active = selectorValue(paths.host(paths.live.active), paths.host(paths.live.versionRoot));
  const previous = selectorValue(paths.host(paths.live.previous), paths.host(paths.live.versionRoot));
  const target = paths.host(record.targetPath);
  const original = paths.host(record.originalPath);
  const originalPrevious = paths.host(record.originalPreviousPath);
  if (![target, original].includes(active) || ![original, originalPrevious].includes(previous)) {
    refuse('selectors differ from all admitted pre/post recovery identities');
  }
}

function assertSelectorsExact(paths, activeLive, previousLive, label) {
  if (selectorValue(paths.host(paths.live.active), paths.host(paths.live.versionRoot))
      !== paths.host(activeLive)
      || selectorValue(paths.host(paths.live.previous), paths.host(paths.live.versionRoot))
      !== paths.host(previousLive)) {
    refuse(`${label} selectors are not exact`);
  }
}

function publishSelector(paths, linkLive, desiredLive) {
  const link = paths.host(linkLive);
  const desired = paths.host(desiredLive);
  const relative = `control-plane/${path.basename(desiredLive)}`;
  const stage = `${link}.next-control-plane-abort`;
  if (exists(stage)) {
    const stat = fs.lstatSync(stage);
    if (!stat.isSymbolicLink() || fs.readlinkSync(stage) !== relative
        || fs.realpathSync(stage) !== desired) refuse(`unsafe selector stage: ${stage}`);
  } else {
    fs.symlinkSync(relative, stage);
    fsyncDirectory(path.dirname(stage));
  }
  if (selectorValue(link, paths.host(paths.live.versionRoot)) === desired) {
    fs.unlinkSync(stage);
  } else {
    fs.renameSync(stage, link);
  }
  fsyncDirectory(path.dirname(link));
  if (selectorValue(link, paths.host(paths.live.versionRoot)) !== desired) {
    refuse(`selector publication failed: ${linkLive}`);
  }
}

function atomicInstall(paths, source, destinationLive, mode, owner) {
  const destination = paths.host(destinationLive);
  const stage = `${destination}.next-control-plane-abort`;
  assertSafeDirectory(path.dirname(destination), {
    ...owner, label: `destination parent for ${destinationLive}`,
  });
  if (exists(destination)) {
    assertSafeFile(destination, { ...owner, mode, label: `installed file ${destinationLive}` });
  }
  if (exists(stage)) {
    assertSafeFile(stage, { ...owner, mode, label: `staged file ${destinationLive}` });
    if (!fileEquals(stage, source)) refuse(`staged file differs from immutable source: ${destinationLive}`);
  } else {
    fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stage, mode);
    fs.chownSync(stage, owner.expectedUid, owner.expectedGid);
    fsyncFile(stage);
    fsyncDirectory(path.dirname(stage));
  }
  if (exists(destination) && fileEquals(destination, source)) {
    fs.unlinkSync(stage);
  } else {
    fs.renameSync(stage, destination);
  }
  fsyncFile(destination);
  fsyncDirectory(path.dirname(destination));
  assertInstalledMatches(destination, source, mode, owner, `installed file ${destinationLive}`);
}

function installAssets(paths, sourceRootLive, assets, owner) {
  for (const [relative, destinationLive, mode] of assets) {
    atomicInstall(paths, sourcePath(paths, sourceRootLive, relative), destinationLive, mode, owner);
  }
}

function coreAssets() {
  return CORE_UNITS.map((unit) => [
    `ops/nexus-release/${unit}`, `/etc/systemd/system/${unit}`, 0o644,
  ]);
}

function removeKnownTargetLiveness(paths, record, owner) {
  for (const unit of LIVENESS_UNITS) {
    const destinationLive = `/etc/systemd/system/${unit}`;
    const destination = paths.host(destinationLive);
    const stage = `${destination}.next-control-plane`;
    for (const installed of [destination, stage]) {
      if (!exists(installed)) continue;
      assertInstalledMatches(installed,
        sourcePath(paths, record.targetPath, `ops/nexus-release/${unit}`),
        0o644, owner, `liveness removal candidate ${installed}`);
      fs.unlinkSync(installed);
      fsyncDirectory(path.dirname(installed));
    }
  }
}

function proveInstalledOriginal(paths, record, owner, exec) {
  for (const [relative, destinationLive, mode] of [
    ...CAPABILITY_ASSETS, ...BACKUP_ASSETS, ...coreAssets(),
  ]) {
    assertInstalledMatches(paths.host(destinationLive),
      sourcePath(paths, record.originalPath, relative), mode, owner,
      `restored recorded-original asset ${destinationLive}`);
  }
  commandResult(exec, '/usr/sbin/visudo', ['-cf', '/etc/sudoers.d/nexus-release-state-view'],
    'state-view sudoers validation');
  commandResult(exec, '/usr/sbin/visudo', ['-cf', '/etc/sudoers.d/nexus-local-backup'],
    'local-backup sudoers validation');
  for (const unit of [...CORE_UNITS, ...BACKUP_ASSETS
    .filter(([, destination]) => destination.startsWith('/etc/systemd/system/'))
    .map(([, destination]) => path.basename(destination))]) {
    const load = show(exec, unit, 'LoadState');
    const fragment = show(exec, unit, 'FragmentPath');
    const dropins = show(exec, unit, 'DropInPaths');
    const needReload = show(exec, unit, 'NeedDaemonReload');
    if (load !== 'loaded' || fragment !== `/etc/systemd/system/${unit}`
        || dropins !== '' || needReload !== 'no') {
      refuse(`effective restored unit is not exact: ${unit}`);
    }
  }
  for (const unit of LIVENESS_UNITS) {
    if (exists(paths.host(`/etc/systemd/system/${unit}`))
        || show(exec, unit, 'LoadState') !== 'not-found'
        || show(exec, unit, 'FragmentPath') !== ''
        || show(exec, unit, 'DropInPaths') !== '') {
      refuse(`target-only liveness authority remains installed: ${unit}`);
    }
  }
}

function atomicWriteJournal(file, record, owner) {
  const stage = `${file}.next`;
  requireAbsent(stage, 'recovery journal stage');
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const descriptor = fs.openSync(stage,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fchmodSync(descriptor, 0o600);
    fs.fchownSync(descriptor, owner.expectedUid, owner.expectedGid);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
  fs.renameSync(stage, file);
  fsyncFile(file);
  fsyncDirectory(path.dirname(file));
}

function readRecoveryFile(file, expected, owner) {
  assertSafeFile(file, { ...owner, mode: 0o600, label: 'abort recovery journal' });
  return assertRecoveryRecord(parseJson(readStable(file).bytes, 'abort recovery journal'), expected);
}

function reconcileRecoveryStage(paths, expected, owner) {
  const journal = paths.host(paths.live.recovery);
  const stage = paths.host(paths.live.recoveryStage);
  if (!exists(stage)) return;
  const staged = readRecoveryFile(stage, expected, owner);
  if (exists(journal)) {
    const current = readRecoveryFile(journal, expected, owner);
    const currentIndex = RECOVERY_PHASES.indexOf(current.phase);
    const stagedIndex = RECOVERY_PHASES.indexOf(staged.phase);
    if (current.recoveryId !== staged.recoveryId || stagedIndex < currentIndex
        || stagedIndex > currentIndex + 1) {
      refuse('staged recovery journal is not the exact adjacent durable phase');
    }
  } else if (staged.phase !== 'prepared') {
    refuse('orphan recovery journal stage is not the prepared admission record');
  }
  fs.renameSync(stage, journal);
  fsyncFile(journal);
  fsyncDirectory(path.dirname(journal));
}

function sourceTransactionAt(paths, fileLive, expected, owner) {
  const file = paths.host(fileLive);
  assertSafeFile(file, { ...owner, mode: 0o600, label: 'source control-plane transaction' });
  const read = readStable(file);
  return {
    bytes: read.bytes,
    digest: sha256(read.bytes),
    record: assertTransaction(parseJson(read.bytes, 'source control-plane transaction'), expected),
  };
}

function publishPhase(paths, record, phase, owner, now, onPhase) {
  const currentIndex = RECOVERY_PHASES.indexOf(record.phase);
  const nextIndex = RECOVERY_PHASES.indexOf(phase);
  if (nextIndex !== currentIndex + 1) refuse(`invalid recovery phase advance: ${record.phase} -> ${phase}`);
  const next = { ...record, phase, updatedAt: timestamp(now) };
  atomicWriteJournal(paths.host(paths.live.recovery), next, owner);
  onPhase?.(phase, next);
  return next;
}

function assertSourceTransactionBinding(paths, record, expected, owner) {
  const gateExists = exists(paths.host(paths.live.transaction));
  const archiveExists = exists(paths.host(record.archivePath));
  const phaseIndex = RECOVERY_PHASES.indexOf(record.phase);
  const retirementIndex = RECOVERY_PHASES.indexOf('gate_retired');
  if (gateExists === archiveExists) {
    refuse('source transaction must exist at exactly one gating or archived name');
  }
  if (phaseIndex < retirementIndex && record.phase !== 'recovery_complete' && !gateExists) {
    refuse('source transaction gate retired before durable recovery completion');
  }
  if (phaseIndex >= retirementIndex && !archiveExists) {
    refuse('recovery claims gate retirement without the exact archived source transaction');
  }
  const live = gateExists ? paths.live.transaction : record.archivePath;
  const source = sourceTransactionAt(paths, live, expected, owner);
  if (source.digest !== record.sourceTransactionSha256) {
    refuse('source transaction bytes changed during abort recovery');
  }
  return source.record;
}

function prepareTimerIntent(exec, record) {
  disableAllTimers(exec);
  const enable = [
    ['nexus-release-heartbeat.timer', record.timerIntent.heartbeat.enabled],
    ['nexus-local-backup.timer', record.timerIntent.backup.enabled],
    ['nexus-local-backup-restore-verify.timer', record.timerIntent.restoreVerify.enabled],
  ];
  for (const [unit, desired] of enable) {
    if (desired === 1) systemctl(exec, ['enable', unit], `timer enable for ${unit}`);
  }
  requireTimerBits(exec, 'nexus-release-poller.timer', 0, 0);
  requireTimerBits(exec, 'nexus-release-backup-liveness.timer', 0, 0);
  requireTimerBits(exec, 'nexus-release-heartbeat.timer', 0,
    record.timerIntent.heartbeat.enabled);
  requireTimerBits(exec, 'nexus-local-backup.timer', 0, record.timerIntent.backup.enabled);
  requireTimerBits(exec, 'nexus-local-backup-restore-verify.timer', 0,
    record.timerIntent.restoreVerify.enabled);
}

function restoreFinalTimerActivity(exec, record) {
  // A killed retry can have triggered the fail-safe after the durable complete
  // phase but before terminal publication. Reconstruct enabled intent first.
  prepareTimerIntent(exec, record);
  const timers = [
    ['nexus-release-heartbeat.timer', record.timerIntent.heartbeat],
    ['nexus-local-backup.timer', record.timerIntent.backup],
    ['nexus-local-backup-restore-verify.timer', record.timerIntent.restoreVerify],
  ];
  for (const [unit, intent] of timers) {
    if (intent.active === 1) systemctl(exec, ['start', unit], `timer activation for ${unit}`);
  }
  requireTimerBits(exec, 'nexus-release-poller.timer', 0, 0);
  requireTimerBits(exec, 'nexus-release-backup-liveness.timer', 0, 0);
  for (const [unit, intent] of timers) {
    requireTimerBits(exec, unit, intent.active, intent.enabled);
  }
}

function retireSourceGate(paths, record, expected, owner) {
  const gate = paths.host(paths.live.transaction);
  const archive = paths.host(record.archivePath);
  if (exists(gate)) {
    requireAbsent(archive, 'aborted source transaction archive');
    const source = sourceTransactionAt(paths, paths.live.transaction, expected, owner);
    if (source.digest !== record.sourceTransactionSha256) {
      refuse('source transaction changed before gate retirement');
    }
    fs.renameSync(gate, archive);
    fsyncFile(archive);
    fsyncDirectory(path.dirname(archive));
  }
  const archived = sourceTransactionAt(paths, record.archivePath, expected, owner);
  if (archived.digest !== record.sourceTransactionSha256 || exists(gate)) {
    refuse('source transaction gate was not atomically retired to its exact archive');
  }
}

function assertTreeSet(paths, record, owner) {
  const targetDigest = assertImmutableTree(paths.host(record.targetPath), record.targetSha,
    record.targetDigest, owner);
  const originalDigest = assertImmutableTree(paths.host(record.originalPath), record.originalSha,
    record.originalDigest, owner);
  const previousSha = path.basename(record.originalPreviousPath);
  const previousDigest = assertImmutableTree(paths.host(record.originalPreviousPath), previousSha,
    record.originalPreviousDigest, owner);
  if (targetDigest !== record.targetDigest || originalDigest !== record.originalDigest
      || previousDigest !== record.originalPreviousDigest) {
    refuse('immutable tree set differs from recovery journal');
  }
}

function requireFinalProof(paths, record, expected, owner, exec) {
  assertRecoverySource(paths, expected, owner, record.recoverySource);
  assertSourceTransactionBinding(paths, record, expected, owner);
  assertTreeSet(paths, record, owner);
  assertApplicationEvidence(
    paths, expected, owner, record.application, record.originalPath, exec,
  );
  assertSelectorsExact(paths, record.originalPath, record.originalPreviousPath,
    'recorded-original recovery');
  proveInstalledOriginal(paths, record, owner, exec);
}

function createAdmissionRecord(paths, expected, owner, exec, now) {
  requireAbsent(paths.host(paths.live.transactionStage), 'source transaction stage');
  requireAbsent(paths.host(paths.live.postGate), 'source post-gate journal');
  requireAbsent(paths.host(paths.live.finalization), 'source finalization journal');
  requireAbsent(paths.host(paths.live.archive), 'aborted transaction archive');
  requireAbsent(paths.host(paths.live.terminal), 'abort recovery terminal receipt');
  const source = sourceTransactionAt(paths, paths.live.transaction, expected, owner);
  const transaction = source.record;
  const recoverySource = assertRecoverySource(paths, expected, owner);
  assertSelectorsExact(paths, transaction.targetPath, transaction.originalActivePath,
    'stuck capabilities-installed');
  const targetDigest = assertImmutableTree(paths.host(transaction.targetPath), expected.targetSha,
    transaction.candidateDigest, owner);
  const originalDigest = assertImmutableTree(paths.host(transaction.originalActivePath),
    expected.originalSha, null, owner);
  const originalPreviousSha = path.basename(transaction.originalPreviousPath);
  const originalPreviousDigest = assertImmutableTree(paths.host(transaction.originalPreviousPath),
    originalPreviousSha, null, owner);
  const application = assertApplicationEvidence(
    paths, expected, owner, null, transaction.originalActivePath, exec,
  );
  for (const unit of TIMER_UNITS) requireTimerBits(exec, unit, 0, 0);
  requireServicesNotRunning(exec);
  assertExactInitialPhaseMixture(paths, transaction, owner);
  const createdAt = timestamp(now);
  const recoveryId = sha256(Buffer.from([
    source.digest, expected.targetSha, expected.originalSha,
    application.releaseId, application.receiptSha256, application.stateSha256,
    recoverySource.sha, recoverySource.treeDigest,
  ].join('\n')));
  return assertRecoveryRecord({
    schema: RECOVERY_SCHEMA,
    recoveryId,
    phase: 'prepared',
    createdAt,
    updatedAt: createdAt,
    sourceRepository: CANONICAL_REPOSITORY,
    recoverySource,
    sourceTransactionSha256: source.digest,
    targetSha: expected.targetSha,
    targetPath: transaction.targetPath,
    targetDigest,
    originalSha: expected.originalSha,
    originalPath: transaction.originalActivePath,
    originalDigest,
    originalPreviousPath: transaction.originalPreviousPath,
    originalPreviousDigest,
    archivePath: paths.live.archive,
    terminalPath: paths.live.terminal,
    application,
    timerIntent: {
      poller: {
        active: 0,
        enabled: 0,
        deferred: true,
        reason: 'legacy_v2_reader_rejects_active_v3_release_envelope',
      },
      heartbeat: {
        active: transaction.heartbeatTimerWasActive,
        enabled: transaction.heartbeatTimerWasEnabled,
      },
      liveness: { active: 0, enabled: 0 },
      backup: {
        active: transaction.backupTimerWasActive,
        enabled: transaction.backupTimerWasEnabled,
      },
      restoreVerify: {
        active: transaction.restoreVerifyTimerWasActive,
        enabled: transaction.restoreVerifyTimerWasEnabled,
      },
    },
  }, expected);
}

function validateLockBinding(descriptor, lockPath, { expectedUid, expectedGid, mode }) {
  const opened = fs.fstatSync(descriptor);
  const named = fs.lstatSync(lockPath);
  if (!opened.isFile() || !named.isFile()
      || opened.uid !== expectedUid || opened.gid !== expectedGid
      || named.uid !== expectedUid || named.gid !== expectedGid
      || opened.nlink !== 1 || named.nlink !== 1
      || (opened.mode & 0o7777) !== mode || (named.mode & 0o7777) !== mode
      || opened.dev !== named.dev || opened.ino !== named.ino) {
    refuse(`inherited governed lock is not descriptor-bound: ${lockPath}`);
  }
}

function requireInheritedLocks(exec) {
  const rootLock = { expectedUid: 0, expectedGid: 0, mode: 0o600 };
  validateLockBinding(7, '/var/lib/nexus-release/locks/control-plane.lock', rootLock);
  validateLockBinding(9, '/var/lib/nexus-release/locks/release.lock', rootLock);
  const gidText = commandResult(exec, '/usr/bin/id', ['-g', 'dominguez'],
    'dominguez maintenance-lock group resolution');
  if (!/^[0-9]+$/u.test(gidText)) refuse('dominguez group identity is malformed');
  validateLockBinding(8, '/run/lock/nexus-release-sonar.lock', {
    expectedUid: 0, expectedGid: Number(gidText), mode: 0o660,
  });
}

export function runControlPlaneAbortRecovery({
  expected,
  hostRoot = '/',
  expectedUid = 0,
  expectedGid = 0,
  exec = defaultExec,
  now = () => Date.now(),
  onPhase = null,
  requireLocks = hostRoot === '/',
  requireSelfBinding = hostRoot === '/',
} = {}) {
  if (!expected) refuse('owner-reviewed recovery identities are required');
  if (requireLocks) requireInheritedLocks(exec);
  const owner = { expectedUid, expectedGid };
  const paths = makePaths(
    fs.realpathSync(path.resolve(hostRoot)), expected.targetSha, expected.recoverySourceSha,
  );
  if (requireSelfBinding) {
    const invokedModule = fs.realpathSync(fileURLToPath(import.meta.url));
    const expectedModule = path.join(paths.host(paths.live.recoverySourceRoot),
      'scripts/release-control-plane-abort-recovery.mjs');
    if (invokedModule !== expectedModule) {
      refuse('running module is not the exact immutable owner-reviewed recovery source');
    }
  }
  const baseAncestors = captureTrustedAncestors(
    paths, recoveryAuthorityTargets(paths, expected), owner,
  );
  assertSafeDirectory(paths.host(paths.live.stateRoot), {
    ...owner, exactMode: 0o700, label: 'control-plane state root',
  });
  reconcileRecoveryStage(paths, expected, owner);
  reassertTrustedAncestors(baseAncestors);

  const terminal = paths.host(paths.live.terminal);
  const recoveryFile = paths.host(paths.live.recovery);
  if (exists(terminal)) {
    requireAbsent(recoveryFile, 'non-terminal recovery journal beside terminal receipt');
    const record = readRecoveryFile(terminal, expected, owner);
    if (record.phase !== 'complete') refuse('terminal recovery receipt is not complete');
    reassertTrustedAncestors(baseAncestors);
    const trustedAncestors = captureTrustedAncestors(
      paths, recoveryAuthorityTargets(paths, expected, record), owner,
    );
    assertRecoverySource(paths, expected, owner, record.recoverySource);
    requireFinalProof(paths, record, expected, owner, exec);
    restoreFinalTimerActivity(exec, record);
    reassertTrustedAncestors(trustedAncestors);
    return record;
  }

  let record;
  let durable = false;
  let trustedAncestors = baseAncestors;
  try {
    if (exists(recoveryFile)) {
      record = readRecoveryFile(recoveryFile, expected, owner);
      durable = true;
    } else {
      record = createAdmissionRecord(paths, expected, owner, exec, now);
      atomicWriteJournal(recoveryFile, record, owner);
      onPhase?.('prepared', record);
      durable = true;
    }

    reassertTrustedAncestors(baseAncestors);
    trustedAncestors = captureTrustedAncestors(
      paths, recoveryAuthorityTargets(paths, expected, record), owner,
    );
    assertSourceTransactionBinding(paths, record, expected, owner);
    assertRecoverySource(paths, expected, owner, record.recoverySource);
    assertTreeSet(paths, record, owner);
    assertApplicationEvidence(
      paths, expected, owner, record.application, record.originalPath, exec,
    );
    assertSelectorsKnown(paths, record);
    assertKnownInstalledMixture(paths, record, owner);
    requireServicesNotRunning(exec);
    if (record.phase !== 'complete') disableAllTimers(exec);

    while (record.phase !== 'complete') {
      reassertTrustedAncestors(trustedAncestors);
      assertSourceTransactionBinding(paths, record, expected, owner);
      assertRecoverySource(paths, expected, owner, record.recoverySource);
      assertTreeSet(paths, record, owner);
      assertApplicationEvidence(
        paths, expected, owner, record.application, record.originalPath, exec,
      );
      assertSelectorsKnown(paths, record);
      assertKnownInstalledMixture(paths, record, owner);
      if (record.phase === 'prepared') {
        settleServices(exec);
        record = publishPhase(paths, record, 'services_settled', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'services_settled') {
        publishSelector(paths, paths.live.previous, record.originalPreviousPath);
        publishSelector(paths, paths.live.active, record.originalPath);
        assertSelectorsExact(paths, record.originalPath, record.originalPreviousPath,
          'restored recorded-original');
        record = publishPhase(paths, record, 'selectors_restored', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'selectors_restored') {
        installAssets(paths, record.originalPath, CAPABILITY_ASSETS, owner);
        commandResult(exec, '/usr/sbin/visudo',
          ['-cf', '/etc/sudoers.d/nexus-release-state-view'], 'state-view sudoers validation');
        commandResult(exec, '/usr/bin/sudo', [
          '-u', 'dominguez', '/usr/bin/sudo', '-n', '/usr/local/sbin/nexus-release-state-view',
        ], 'delegated recorded-original state-view proof');
        record = publishPhase(paths, record, 'capabilities_restored', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'capabilities_restored') {
        installAssets(paths, record.originalPath, BACKUP_ASSETS, owner);
        commandResult(exec, '/usr/sbin/visudo',
          ['-cf', '/etc/sudoers.d/nexus-local-backup'], 'local-backup sudoers validation');
        record = publishPhase(paths, record, 'backup_interface_restored', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'backup_interface_restored') {
        installAssets(paths, record.originalPath, coreAssets(), owner);
        removeKnownTargetLiveness(paths, record, owner);
        systemctl(exec, ['daemon-reload'], 'systemd daemon reload');
        proveInstalledOriginal(paths, record, owner, exec);
        settleServices(exec);
        record = publishPhase(paths, record, 'units_restored', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'units_restored') {
        prepareTimerIntent(exec, record);
        record = publishPhase(paths, record, 'timers_prepared', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'timers_prepared') {
        prepareTimerIntent(exec, record);
        requireFinalProof(paths, record, expected, owner, exec);
        requireServicesNotRunning(exec);
        record = publishPhase(paths, record, 'recovery_complete', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'recovery_complete') {
        prepareTimerIntent(exec, record);
        requireFinalProof(paths, record, expected, owner, exec);
        requireServicesNotRunning(exec);
        retireSourceGate(paths, record, expected, owner);
        record = publishPhase(paths, record, 'gate_retired', owner, now, onPhase);
        continue;
      }
      if (record.phase === 'gate_retired') {
        prepareTimerIntent(exec, record);
        requireFinalProof(paths, record, expected, owner, exec);
        restoreFinalTimerActivity(exec, record);
        record = publishPhase(paths, record, 'complete', owner, now, onPhase);
        continue;
      }
      refuse(`unsupported recovery phase: ${record.phase}`);
    }

    requireFinalProof(paths, record, expected, owner, exec);
    restoreFinalTimerActivity(exec, record);
    reassertTrustedAncestors(trustedAncestors);
    requireAbsent(terminal, 'abort recovery terminal receipt');
    fs.renameSync(recoveryFile, terminal);
    fsyncFile(terminal);
    fsyncDirectory(path.dirname(terminal));
    requireAbsent(recoveryFile, 'retired abort recovery journal');
    reassertTrustedAncestors(trustedAncestors);
    return readRecoveryFile(terminal, expected, owner);
  } catch (error) {
    if (durable) {
      try { disableAllTimers(exec); } catch (disableError) {
        error.message += `; fail-safe timer disable also failed: ${disableError.message}`;
      }
    }
    try { reassertTrustedAncestors(trustedAncestors); } catch (ancestorError) {
      error.message += `; trusted ancestor reproof also failed: ${ancestorError.message}`;
    }
    throw error;
  }
}

async function main() {
  if (process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    refuse('run only through the root lock-binding wrapper');
  }
  if (process.version !== 'v22.23.1') refuse('runtime must be exactly /usr/bin/node v22.23.1');
  const expected = parseArgs(process.argv.slice(2));
  const record = runControlPlaneAbortRecovery({ expected });
  process.stdout.write(`${JSON.stringify({
    schema: record.schema,
    recoveryId: record.recoveryId,
    phase: record.phase,
    targetSha: record.targetSha,
    restoredSha: record.originalSha,
    applicationReleaseId: record.application.releaseId,
    pollerRestartDeferred: true,
    terminalPath: record.terminalPath,
  })}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
