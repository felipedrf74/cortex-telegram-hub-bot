#!/usr/bin/env node
// Resumable local coordinator for the canonical exact-artifact release path.
// It never grants production authorization and never promotes without two
// explicit, contemporaneous owner signals.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const value = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(value('--root', path.join(import.meta.dirname, '..')));
const internalLockHeld = has('--internal-lock-held');
const coordinatorLockFd = 9;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const withValue = new Set([
    '--root', '--checkpoint', '--rc-run', '--manifest', '--staging-attestation',
    '--ios-attestation', '--ios-distribution-attestation', '--protected-reuse-activation',
  ]);
  const flags = new Set([
    '--backend-only', '--includes-ios', '--owner-authorized', '--promote', '--status',
    '--internal-lock-held',
  ]);
  if (withValue.has(argument)) {
    if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`missing value for ${argument}`, 64);
    index += 1;
  } else if (!flags.has(argument)) {
    fail(`unknown release resume argument: ${argument}`, 64);
  }
}

function run(command, commandArgs, options = {}) {
  const lockStdio = internalLockHeld
    ? ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore',
      coordinatorLockFd]
    : undefined;
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...(lockStdio ? { stdio: lockStdio } : {}),
    ...options,
  });
}

function required(command, commandArgs, label) {
  const result = run(command, commandArgs);
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    fail(`${label} failed`, result.status || 1);
  }
  return result.stdout.trim();
}

const runtimeSha = required('git', ['rev-parse', 'HEAD'], 'release worktree identity');
if (!/^[a-f0-9]{40}$/u.test(runtimeSha)) fail('release resume runtime SHA is invalid', 1);
const branch = required('git', ['branch', '--show-current'], 'release branch identity');
if (branch !== 'main') fail('release resume requires the checked-out protected main branch');
const dirty = required('git', ['status', '--porcelain=v1', '--untracked-files=all'], 'release clean-tree check');
if (dirty) fail('release resume requires a clean exact origin/main checkout');
required('git', ['fetch', '--quiet', 'origin', 'main'], 'origin/main fetch');
const originMainSha = required('git', ['rev-parse', 'origin/main^{commit}'], 'origin/main identity');
if (originMainSha !== runtimeSha) fail('release resume HEAD must equal the freshly fetched origin/main');

let packageJson;
try { packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {
  fail('release resume package.json is missing or invalid');
}
const packageVersion = String(packageJson.version || '');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  fail('release resume package version is invalid');
}
const originPackage = JSON.parse(required('git', ['show', 'origin/main:package.json'], 'origin/main package identity'));
if (originPackage.version !== packageVersion) fail('release resume package version differs from origin/main');

const localRoot = path.join(root, '.local', 'release');
const checkpointPath = path.resolve(value(
  '--checkpoint',
  path.join(localRoot, 'checkpoints', `${runtimeSha}.json`),
));
const checkpointRelative = path.relative(localRoot, checkpointPath);
if (checkpointRelative.startsWith('..') || path.isAbsolute(checkpointRelative)) {
  fail('release checkpoint must stay under .local/release', 64);
}
const checkpointDirectory = path.dirname(checkpointPath);
fs.mkdirSync(checkpointDirectory, { recursive: true, mode: 0o700 });
function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
let durableDirectory = checkpointDirectory;
while (true) {
  fsyncDirectory(durableDirectory);
  if (durableDirectory === root) break;
  const parent = path.dirname(durableDirectory);
  const parentRelative = path.relative(root, parent);
  if (parent === durableDirectory || parentRelative.startsWith('..')
    || path.isAbsolute(parentRelative)) {
    fail('release checkpoint directory ancestry is invalid', 64);
  }
  durableDirectory = parent;
}

const lockPath = `${checkpointPath}.lock`;
let lockIdentity = null;
let activeChild = null;
let requestedTerminationSignal = null;
let terminationEscalationTimer = null;

function openCoordinatorLockFile() {
  let existing = null;
  try {
    existing = fs.lstatSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    fail('release checkpoint lock is a legacy or unsafe entry; owner cleanup is required', 73);
  }
  const descriptor = fs.openSync(
    lockPath,
    fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(lockPath);
    if (!opened.isFile() || opened.uid !== process.getuid()
        || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1
        || !current.isFile() || current.isSymbolicLink()
        || current.dev !== opened.dev || current.ino !== opened.ino) {
      fail('release checkpoint lock is not a private owner regular file', 73);
    }
    return { descriptor, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function lockCommandForInheritedFd() {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/lockf')) {
    return {
      command: '/usr/bin/lockf',
      args: ['-s', '-t', '0', String(coordinatorLockFd)],
    };
  }
  const flock = ['/usr/bin/flock', '/bin/flock'].find((candidate) => fs.existsSync(candidate));
  if (flock) {
    return {
      command: flock,
      args: ['-n', String(coordinatorLockFd)],
    };
  }
  fail('an OS-backed release checkpoint lock implementation is unavailable', 69);
}

function inheritedLockStdio(stdout = 'ignore', stderr = 'ignore', sourceFd = coordinatorLockFd) {
  return [
    'ignore', stdout, stderr, 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore',
    sourceFd,
  ];
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143;
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function requestTermination(signal) {
  if (requestedTerminationSignal) return;
  requestedTerminationSignal = signal;
  if (!activeChild) process.exit(signalExitCode(signal));
  killProcessGroup(activeChild, signal);
  terminationEscalationTimer = setTimeout(() => {
    killProcessGroup(activeChild, 'SIGKILL');
  }, 10_000);
  terminationEscalationTimer.unref();
}

process.on('SIGINT', () => requestTermination('SIGINT'));
process.on('SIGTERM', () => requestTermination('SIGTERM'));

async function launchLockedCoordinator(openedLock) {
  const childArgs = [
    path.resolve(process.argv[1]),
    ...args,
    '--internal-lock-held',
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: root,
    env: process.env,
    detached: true,
    stdio: inheritedLockStdio('inherit', 'inherit', openedLock.descriptor),
  });
  fs.closeSync(openedLock.descriptor);
  activeChild = child;
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, status: null, signal: null }));
    child.once('close', (status, signal) => resolve({ error: null, status, signal }));
  });
  activeChild = null;
  if (terminationEscalationTimer) clearTimeout(terminationEscalationTimer);
  if (requestedTerminationSignal) return signalExitCode(requestedTerminationSignal);
  if (outcome.error) {
    process.stderr.write(`release coordinator lock child failed: ${outcome.error.message}\n`);
    return 70;
  }
  if (outcome.signal) return 128 + (outcome.signal === 'SIGKILL' ? 9 : 15);
  return outcome.status ?? 70;
}

function acquireInheritedCoordinatorLock() {
  let inherited;
  try {
    inherited = fs.fstatSync(coordinatorLockFd);
  } catch {
    fail('release coordinator inherited lock descriptor is unavailable', 73);
  }
  const current = fs.lstatSync(lockPath);
  if (!inherited.isFile() || inherited.uid !== process.getuid()
      || (inherited.mode & 0o777) !== 0o600 || inherited.nlink !== 1
      || !current.isFile() || current.isSymbolicLink() || current.uid !== process.getuid()
      || (current.mode & 0o777) !== 0o600 || current.nlink !== 1
      || current.dev !== inherited.dev || current.ino !== inherited.ino) {
    fail('release checkpoint inherited lock identity is unsafe', 73);
  }
  const invocation = lockCommandForInheritedFd();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: 'utf8',
    stdio: inheritedLockStdio('pipe', 'pipe'),
  });
  if (result.error) {
    fail(`release checkpoint OS lock acquisition failed: ${result.error.message}`, 69);
  }
  if (result.status !== 0) {
    fail('another release resume process owns this checkpoint', 73);
  }
  const after = fs.lstatSync(lockPath);
  if (!after.isFile() || after.isSymbolicLink() || after.uid !== process.getuid()
      || (after.mode & 0o777) !== 0o600 || after.nlink !== 1
      || after.dev !== inherited.dev || after.ino !== inherited.ino) {
    fail('release checkpoint lock identity changed during acquisition', 73);
  }
  lockIdentity = { dev: inherited.dev, ino: inherited.ino };
}

if (!internalLockHeld) {
  const openedLock = openCoordinatorLockFile();
  const exitCode = await launchLockedCoordinator(openedLock);
  process.exit(exitCode);
}
acquireInheritedCoordinatorLock();

function assertCoordinatorLockIdentity() {
  let inherited;
  let current;
  try {
    inherited = fs.fstatSync(coordinatorLockFd);
    current = fs.lstatSync(lockPath);
  } catch {
    fail('release checkpoint lock identity is unavailable', 73);
  }
  if (!lockIdentity || !inherited.isFile()
      || !current.isFile() || current.isSymbolicLink()
      || inherited.uid !== process.getuid() || current.uid !== process.getuid()
      || (inherited.mode & 0o777) !== 0o600 || (current.mode & 0o777) !== 0o600
      || inherited.nlink !== 1 || current.nlink !== 1
      || inherited.dev !== lockIdentity.dev || inherited.ino !== lockIdentity.ino
      || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) {
    fail('release checkpoint lock identity drifted while held', 73);
  }
}

function readCheckpoint() {
  if (!fs.existsSync(checkpointPath)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { fail('release checkpoint is invalid JSON'); }
  if (parsed?.schema !== 'nexus.release-sequence-checkpoint.v1') fail('release checkpoint schema is invalid');
  if (parsed.runtimeSha !== runtimeSha) fail('release checkpoint runtime identity mismatch');
  return parsed;
}

function writeCheckpoint(state) {
  assertCoordinatorLockIdentity();
  const temporary = `${checkpointPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    const descriptor = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, checkpointPath);
    fsyncDirectory(checkpointDirectory);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return next;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Buffer(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function readPrivateBoundedJson(file, maximumBytes, label) {
  const resolved = path.resolve(root, file);
  let before;
  try {
    before = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${label} is missing`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid()
      || (before.mode & 0o077) !== 0 || before.nlink !== 1
      || before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`${label} is not a bounded private owner regular file`);
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  let body;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} changed while it was opened`);
    }
    body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== body.length) {
      throw new Error(`${label} changed while it was read`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} JSON root is invalid`);
  }
  return { body, parsed, resolved, mode: before.mode & 0o777 };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o077) !== 0) {
    fail(`release private directory is unsafe: ${directory}`, 64);
  }
}

function publishPrivateSnapshot(destination, body) {
  const directory = path.dirname(destination);
  ensurePrivateDirectory(directory);
  let existing = null;
  try {
    existing = fs.lstatSync(destination);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid()
        || (existing.mode & 0o777) !== 0o600 || existing.nlink !== 1
        || !fs.readFileSync(destination).equals(body)) {
      fail('protected-main reuse activation checkpoint snapshot is unsafe or differs', 64);
    }
    return;
  }
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.next.${process.pid}.${crypto.randomBytes(8).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, destination);
    fsyncDirectory(directory);
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function initialProtectedReuseActivation(inputPath) {
  if (!inputPath) {
    return {
      schema: 'nexus.protected-main-reuse-coordinator-input.v1',
      status: 'fallback',
      reason: 'not_supplied',
    };
  }
  try {
    const input = readPrivateBoundedJson(inputPath, 45_000, 'protected-main reuse activation');
    const digest = sha256Buffer(input.body);
    const snapshots = path.join(localRoot, 'sequence-inputs');
    const snapshotPath = path.join(snapshots, `${runtimeSha}-${digest}.protected-main-reuse-activation.json`);
    publishPrivateSnapshot(snapshotPath, input.body);
    return {
      schema: 'nexus.protected-main-reuse-coordinator-input.v1',
      status: 'forwarded',
      reason: null,
      snapshotPath,
      sha256: digest,
      sizeBytes: input.body.length,
      mode: '0600',
    };
  } catch (error) {
    process.stderr.write(`protected-main reuse activation unavailable; retaining full RC fallback: ${error.message}\n`);
    return {
      schema: 'nexus.protected-main-reuse-coordinator-input.v1',
      status: 'fallback',
      reason: 'unsafe_invalid_or_oversize',
    };
  }
}

function validateProtectedReuseActivation(binding, suppliedPath = '') {
  if (binding?.schema !== 'nexus.protected-main-reuse-coordinator-input.v1'
      || !['forwarded', 'fallback'].includes(binding.status)) {
    fail('protected-main reuse activation checkpoint binding is invalid', 64);
  }
  if (binding.status === 'fallback') {
    if (suppliedPath) {
      fail('protected-main reuse activation cannot be added after RC dispatch intent', 64);
    }
    return null;
  }
  const expectedDirectory = path.join(localRoot, 'sequence-inputs');
  const expectedPath = path.join(
    expectedDirectory,
    `${runtimeSha}-${binding.sha256}.protected-main-reuse-activation.json`,
  );
  if (binding.snapshotPath !== expectedPath || binding.mode !== '0600'
      || !/^[a-f0-9]{64}$/u.test(binding.sha256 || '')
      || !Number.isSafeInteger(binding.sizeBytes)
      || binding.sizeBytes <= 0 || binding.sizeBytes > 45_000) {
    fail('protected-main reuse activation snapshot identity is invalid', 64);
  }
  let snapshot;
  try {
    snapshot = readPrivateBoundedJson(binding.snapshotPath, 45_000, 'checkpointed protected-main reuse activation');
  } catch (error) {
    fail(error.message, 64);
  }
  if (snapshot.resolved !== expectedPath || snapshot.mode !== 0o600
      || snapshot.body.length !== binding.sizeBytes
      || sha256Buffer(snapshot.body) !== binding.sha256) {
    fail('protected-main reuse activation snapshot drifted after RC intent', 64);
  }
  if (suppliedPath) {
    let supplied;
    try {
      supplied = readPrivateBoundedJson(suppliedPath, 45_000, 'supplied protected-main reuse activation');
    } catch (error) {
      fail(error.message, 64);
    }
    if (supplied.body.length !== binding.sizeBytes
        || sha256Buffer(supplied.body) !== binding.sha256) {
      fail('supplied protected-main reuse activation differs from the checkpoint binding', 64);
    }
  }
  return snapshot.body;
}

function deterministicUuid(input) {
  const bytes = crypto.createHash('sha256').update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function productionEvidenceMatches(production, expected) {
  const digest = (input) => /^[a-f0-9]{64}$/u.test(input || '');
  const timestamp = (input) => Number.isFinite(Date.parse(input || ''));
  const safeKey = (input) => typeof input === 'string' && input.length > 0
    && input.length <= 1024 && !input.includes('..') && !input.includes('//');
  const controls = production?.drStorageControls;
  const aws = controls?.provider === 'aws-s3' && controls?.controlMode === 'versioned-s3';
  const r2 = controls?.provider === 'cloudflare-r2'
    && controls?.controlMode === 'r2-approved-variance';
  if (!aws && !r2) return false;
  if (controls?.releasePrefixLockVerified !== true) return false;

  const version = (input) => {
    if (typeof input !== 'string' || input === 'null') return false;
    const encoded = Buffer.from(input, 'utf8');
    return encoded.length >= 1 && encoded.length <= 1024
      && encoded.toString('utf8') === input
      && !/[\u0000-\u001f\u007f]/u.test(input);
  };
  const retainedObject = (item) => {
    const confirmed = Date.parse(item?.confirmedAt || '');
    if (!Number.isFinite(confirmed) || item?.provider !== controls.provider
        || !safeKey(item?.objectKey) || !digest(item?.encryptedSha256)
        || !Number.isSafeInteger(item?.encryptedSizeBytes) || item.encryptedSizeBytes <= 0) {
      return false;
    }
    if (aws) {
      const retained = Date.parse(item?.retainUntil || '');
      return version(item?.objectVersionId)
        && Number.isFinite(retained) && retained >= confirmed + 90 * 86_400_000;
    }
    return item?.objectVersionId === null && item?.retainUntil === null;
  };
  const databaseObject = (item) => {
    if (item?.status !== 'passed' || item?.provider !== controls.provider
        || !safeKey(item?.objectKey)
        || !/\/database\/hourly\/nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/u.test(item.objectKey)
        || !digest(item?.plaintextSha256) || !digest(item?.encryptedSha256)
        || !Number.isSafeInteger(item?.encryptedSizeBytes) || item.encryptedSizeBytes <= 0
        || !timestamp(item?.confirmedAt)) return false;
    return aws
      ? version(item?.objectVersionId)
        && item?.retentionVariance === null
        && item?.approvedUnversionedVariance === false
      : item?.objectVersionId === null
        && item?.retentionVariance === 'r2-approved-variance'
        && item?.approvedUnversionedVariance === true;
  };
  const recoveryObject = (item, phase) => item?.status === 'passed'
    && item?.escrowId === production.transactionId
    && item?.escrowPhase === phase
    && item?.runtimeSha === expected.runtimeSha
    && item?.artifactDigest === expected.artifactDigest
    && item?.installedRuntimeDigest === expected.installedRuntimeDigest
    && item?.recoveryRuntimeDigest === expected.recoveryRuntimeDigest
    && digest(item?.plaintextSha256)
    && safeKey(item?.objectKey)
    && item.objectKey.endsWith(
      `+escrow-${production.transactionId}+phase-${phase}.tar.gz.${item.plaintextSha256}.age`,
    )
    && item?.evidenceSha256 === production.rollbackEscrow?.evidenceSha256
    && retainedObject(item);
  const readiness = (item) => item?.schema === 'nexus.candidate-readiness-refresh.v1'
    && item?.status === 'passed'
    && item?.transactionId === production.transactionId
    && item?.runtimeSha === expected.runtimeSha
    && item?.packageVersion === expected.packageVersion
    && timestamp(item?.verifiedAt)
    && Object.keys(item?.checks || {}).sort().join(',')
      === 'authenticatedSnapshot,contentEngine,loopbackBackend,pm2Identity,publicHealth'
    && Object.values(item.checks).every((check) => check === true);

  const rollback = production?.rollbackEscrow;
  const beforeRecovery = production?.preMutationCurrentRecoveryEscrow;
  const currentRecovery = production?.currentRecoveryEscrow;
  const beforeDatabase = production?.preMutationDatabaseRecoveryPoint;
  const currentDatabase = production?.currentDatabaseRecoveryPoint;
  const beforeReadiness = production?.candidateReadinessRefresh?.beforeEscrow;
  const afterReadiness = production?.candidateReadinessRefresh?.afterEscrow;
  if (production?.schema !== 'nexus.production-promotion-evidence.v1'
      || production?.status !== 'passed'
      || production?.runtimeSha !== expected.runtimeSha
      || production?.artifactDigest !== expected.artifactDigest
      || production?.installedRuntimeDigest !== expected.installedRuntimeDigest
      || production?.recoveryRuntimeDigest !== expected.recoveryRuntimeDigest
      || production?.releaseManifestSha256 !== expected.releaseManifestSha256
      || production?.stagingAttestationSha256 !== expected.stagingAttestationSha256
      || production?.packageVersion !== expected.packageVersion
      || production?.sentryRelease !== expected.runtimeSha
      || production?.transactionMode !== 'systemd_oneshot'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(production?.transactionId || '')
      || !digest(production?.backupSha256)
      || typeof production?.exactBackup !== 'string'
      || !production.exactBackup.endsWith('.tar.gz')
      || rollback?.status !== 'passed'
      || rollback?.provider !== controls.provider
      || rollback?.objectKey?.endsWith(`.${production.backupSha256}.age`) !== true
      || !digest(rollback?.evidenceSha256)
      || !retainedObject(rollback)
      || !recoveryObject(beforeRecovery, 'pre-mutation')
      || !recoveryObject(currentRecovery, 'post-soak')
      || beforeRecovery.plaintextSha256 !== currentRecovery.plaintextSha256
      || beforeRecovery.objectKey === currentRecovery.objectKey
      || beforeRecovery.encryptedSha256 === currentRecovery.encryptedSha256
      || (aws && beforeRecovery.objectVersionId === currentRecovery.objectVersionId)
      || !databaseObject(beforeDatabase) || !databaseObject(currentDatabase)
      || beforeDatabase.encryptedSha256 === currentDatabase.encryptedSha256
      || (aws && beforeDatabase.objectKey === currentDatabase.objectKey
        && beforeDatabase.objectVersionId === currentDatabase.objectVersionId)
      || !readiness(beforeReadiness) || !readiness(afterReadiness)) {
    return false;
  }

  const times = {
    started: Date.parse(production.startedAt),
    unavailable: Date.parse(production.serviceUnavailableStartedAt),
    soak: Date.parse(production.soakCompletedAt),
    beforeRecovery: Date.parse(beforeRecovery.confirmedAt),
    currentRecovery: Date.parse(currentRecovery.confirmedAt),
    beforeDatabase: Date.parse(beforeDatabase.confirmedAt),
    currentDatabase: Date.parse(currentDatabase.confirmedAt),
    rollback: Date.parse(rollback.confirmedAt),
    beforeReadiness: Date.parse(beforeReadiness.verifiedAt),
    afterReadiness: Date.parse(afterReadiness.verifiedAt),
    dr: Date.parse(production.drEscrowConfirmedAt),
    completed: Date.parse(production.completedAt),
  };
  if (!Object.values(times).every(Number.isFinite)
      || times.beforeRecovery > times.started || times.beforeRecovery > times.unavailable
      || times.beforeDatabase > times.started || times.beforeDatabase > times.unavailable
      || times.currentRecovery < times.soak || times.currentDatabase < times.soak
      || times.beforeReadiness < times.soak
      || times.rollback < times.beforeReadiness
      || times.currentRecovery < times.beforeReadiness
      || times.currentDatabase < times.beforeReadiness
      || times.afterReadiness < Math.max(
        times.beforeReadiness, times.rollback, times.currentRecovery, times.currentDatabase,
      )
      || times.dr !== Math.max(times.rollback, times.currentRecovery, times.currentDatabase)
      || production.completedAt !== afterReadiness.verifiedAt
      || times.completed !== times.afterReadiness) return false;

  const afterChecks = afterReadiness.checks;
  return production?.verification?.loopbackBackend === afterChecks.loopbackBackend
    && production?.verification?.contentEngineHealth === afterChecks.contentEngine
    && production?.verification?.authenticatedContentEngine === afterChecks.authenticatedSnapshot
    && production?.verification?.pm2AndCurrentIdentity === afterChecks.pm2Identity
    && production?.verification?.publicHealth?.status
      === (afterChecks.publicHealth ? 'healthy' : 'failed')
    && production?.verification?.publicHealth?.database
      === (afterChecks.publicHealth ? 'connected' : 'unknown')
    && production?.verification?.publicSnapshotVersion
      === (afterChecks.authenticatedSnapshot ? expected.packageVersion : null);
}

function ghJson(commandArgs, label) {
  const raw = required('gh', commandArgs, label);
  try { return JSON.parse(raw); } catch { fail(`${label} returned invalid JSON`); }
}

function validateProtectedRepository() {
  const repository = ghJson(['repo', 'view', '--json', 'nameWithOwner'], 'GitHub repository identity');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository.nameWithOwner || '')) {
    fail('GitHub repository identity is invalid');
  }
  const protection = ghJson(['api', `repos/${repository.nameWithOwner}/branches/main`], 'protected main lookup');
  if (protection.protected !== true || protection.name !== 'main') {
    fail('origin/main is not protected according to GitHub');
  }
  return repository.nameWithOwner;
}

function validateWorkflowRun(runId, {
  workflowName,
  expectedTitle = '',
  requireCodeql = false,
  expectedEvent = requireCodeql ? 'push' : 'workflow_dispatch',
} = {}) {
  const runView = ghJson(['run', 'view', String(runId), '--json',
    'databaseId,displayTitle,headSha,headBranch,event,status,conclusion,workflowName,url,jobs'],
  `GitHub workflow run ${runId}`);
  if (String(runView.databaseId) !== String(runId) || runView.headSha !== runtimeSha
      || runView.headBranch !== 'main' || runView.event !== expectedEvent
      || runView.status !== 'completed' || runView.conclusion !== 'success'
      || runView.workflowName !== workflowName
      || (expectedTitle && runView.displayTitle !== expectedTitle)) {
    fail(`GitHub workflow run ${runId} is not a successful exact origin/main run`);
  }
  let codeqlJob = null;
  if (requireCodeql) {
    codeqlJob = (runView.jobs || []).find((job) => job.name === 'CodeQL JavaScript/TypeScript');
    if (!codeqlJob || codeqlJob.status !== 'completed' || codeqlJob.conclusion !== 'success') {
      fail('exact origin/main CodeQL job is missing or failed');
    }
    if (!/^\d+$/u.test(String(codeqlJob.databaseId || codeqlJob.id || ''))) {
      fail('exact origin/main CodeQL job identity is invalid');
    }
  }
  return { runView, codeqlJob };
}

const protectedWorkflowDefinitions = Object.freeze({
  protectedMainCi: Object.freeze({
    workflow: 'ci.yml',
    workflowName: 'CI — Risk-based parallel matrix',
    label: 'protected-main CI',
    requireCodeql: false,
  }),
  security: Object.freeze({
    workflow: 'security.yml',
    workflowName: 'Security — supply chain and static analysis',
    label: 'security.yml',
    requireCodeql: true,
  }),
});

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function pathScopedProtectedWorkflowDatabaseId(repository, definition) {
  const identity = ghJson([
    'api',
    `repos/${repository}/actions/workflows/${definition.workflow}`,
  ], `${definition.label} path-scoped workflow identity`);
  if (!positiveSafeInteger(identity?.id)
      || identity.name !== definition.workflowName
      || identity.path !== `.github/workflows/${definition.workflow}`
      || identity.state !== 'active') {
    fail(`${definition.label} path-scoped workflow identity is invalid`);
  }
  return identity.id;
}

function protectedWorkflowWaitMs() {
  if (process.env.NODE_ENV === 'test'
      && /^\d+$/.test(process.env.NEXUS_RELEASE_TEST_PROTECTED_TIMEOUT_MS || '')) {
    return Number(process.env.NEXUS_RELEASE_TEST_PROTECTED_TIMEOUT_MS);
  }
  return 45 * 60 * 1_000;
}

function protectedWorkflowTestPollLimit() {
  if (process.env.NODE_ENV !== 'test'
      || !/^[1-9]\d*$/.test(process.env.NEXUS_RELEASE_TEST_PROTECTED_POLL_LIMIT || '')) {
    return null;
  }
  return Number(process.env.NEXUS_RELEASE_TEST_PROTECTED_POLL_LIMIT);
}

function initialProtectedWorkflowState(
  definition,
  workflowDatabaseId,
  startedAt,
  deadlineAt,
) {
  return {
    schema: 'nexus.release-required-workflow.v1',
    status: 'awaiting_run',
    workflow: definition.workflow,
    workflowName: definition.workflowName,
    workflowDatabaseId,
    workflowSha256: sha256File(path.join(root, '.github', 'workflows', definition.workflow)),
    event: 'push',
    headBranch: 'main',
    headSha: runtimeSha,
    startedAt,
    deadlineAt,
    pollCount: 0,
    runId: null,
    attempt: null,
  };
}

function validateProtectedWorkflowBinding(record, definition) {
  const allowedStatuses = new Set([
    'awaiting_run', 'run_identified', 'pending', 'completed', 'terminal_failure', 'timed_out',
  ]);
  if (record?.schema !== 'nexus.release-required-workflow.v1'
      || !allowedStatuses.has(record.status)
      || record.workflow !== definition.workflow
      || record.workflowName !== definition.workflowName
      || !positiveSafeInteger(record.workflowDatabaseId)
      || record.workflowSha256
        !== sha256File(path.join(root, '.github', 'workflows', definition.workflow))
      || record.event !== 'push'
      || record.headBranch !== 'main'
      || record.headSha !== runtimeSha
      || !Number.isFinite(Date.parse(record.startedAt || ''))
      || !Number.isFinite(Date.parse(record.deadlineAt || ''))
      || Date.parse(record.deadlineAt) <= Date.parse(record.startedAt)
      || !Number.isSafeInteger(record.pollCount)
      || record.pollCount < 0
      || (record.runId !== null && !/^[0-9]+$/u.test(String(record.runId)))
      || (record.attempt !== null && !positiveSafeInteger(record.attempt))
      || ((record.runId === null) !== (record.attempt === null))) {
    fail(`release checkpoint ${definition.label} binding is invalid`, 64);
  }
  if (['run_identified', 'pending', 'completed', 'terminal_failure'].includes(record.status)
      && (!/^[0-9]+$/u.test(String(record.runId || ''))
        || !positiveSafeInteger(record.attempt))) {
    fail(`release checkpoint ${definition.label} run or attempt identity is invalid`, 64);
  }
}

function validateProtectedWorkflowSet(state) {
  const controls = state.protectedMainChecks;
  if (controls?.schema !== 'nexus.release-required-workflows.v1'
      || !['pending', 'completed'].includes(controls.status)
      || !Number.isFinite(Date.parse(controls.startedAt || ''))
      || !Number.isFinite(Date.parse(controls.deadlineAt || ''))
      || Date.parse(controls.deadlineAt) <= Date.parse(controls.startedAt)
      || controls.headSha !== runtimeSha) {
    fail('release checkpoint protected workflow controls are invalid', 64);
  }
  for (const [key, definition] of Object.entries(protectedWorkflowDefinitions)) {
    validateProtectedWorkflowBinding(state.workflows?.[key], definition);
    if (state.workflows[key].startedAt !== controls.startedAt
        || state.workflows[key].deadlineAt !== controls.deadlineAt) {
      fail(`release checkpoint ${definition.label} deadline binding is invalid`, 64);
    }
  }
  const completed = Object.keys(protectedWorkflowDefinitions)
    .every((key) => state.workflows[key].status === 'completed');
  if (controls.status === 'completed' && !completed) {
    fail('release checkpoint protected workflow completion is inconsistent', 64);
  }
  if (state.rcDispatch && controls.status !== 'completed') {
    fail('release-candidate intent predates required protected workflow success', 64);
  }
}

function listProtectedWorkflowRuns(definition) {
  const runs = ghJson([
    'run', 'list', '--workflow', definition.workflow, '--branch', 'main', '--event', 'push',
    '--commit', runtimeSha, '--limit', '50', '--json',
    'attempt,databaseId,headSha,headBranch,event,status,conclusion,createdAt,workflowDatabaseId,workflowName',
  ], `${definition.label} workflow lookup`);
  if (!Array.isArray(runs)) fail(`${definition.label} workflow lookup is not an array`);
  return runs;
}

function exactProtectedWorkflowCandidate(definition, expectedWorkflowDatabaseId) {
  const candidates = listProtectedWorkflowRuns(definition).filter((candidate) => (
    candidate.headSha === runtimeSha
      && candidate.headBranch === 'main'
      && candidate.event === 'push'
      && candidate.workflowName === definition.workflowName
      && /^[0-9]+$/u.test(String(candidate.databaseId || ''))
  ));
  const byRunId = new Map(candidates.map((candidate) => [String(candidate.databaseId), candidate]));
  if (byRunId.size > 1) {
    fail(`${definition.label} exact-SHA workflow lookup is ambiguous`);
  }
  const candidate = [...byRunId.values()][0] || null;
  if (candidate && (!positiveSafeInteger(candidate.attempt)
      || !positiveSafeInteger(candidate.workflowDatabaseId)
      || candidate.workflowDatabaseId !== expectedWorkflowDatabaseId
      || !Number.isFinite(Date.parse(candidate.createdAt || '')))) {
    fail(`${definition.label} path-scoped run attempt identity is invalid`);
  }
  return candidate;
}

function inspectProtectedWorkflowRun(runId, attempt, workflowDatabaseId, definition) {
  const runView = ghJson(['run', 'view', String(runId), '--attempt', String(attempt), '--json',
    'attempt,databaseId,displayTitle,headSha,headBranch,event,status,conclusion,workflowDatabaseId,workflowName,url,jobs'],
  `${definition.label} workflow run ${runId}`);
  if (String(runView.databaseId) !== String(runId)
      || runView.attempt !== attempt
      || runView.workflowDatabaseId !== workflowDatabaseId
      || runView.headSha !== runtimeSha
      || runView.headBranch !== 'main'
      || runView.event !== 'push'
      || runView.workflowName !== definition.workflowName
      || typeof runView.url !== 'string'
      || runView.url.length === 0) {
    fail(`${definition.label} workflow run ${runId} is not exact protected main`);
  }
  const pendingStatuses = new Set(['requested', 'waiting', 'pending', 'queued', 'in_progress']);
  if (pendingStatuses.has(runView.status)) {
    if (runView.conclusion !== null && runView.conclusion !== '') {
      fail(`${definition.label} pending workflow run has a terminal conclusion`);
    }
    return { outcome: 'pending', runView, codeqlJob: null };
  }
  if (runView.status !== 'completed' || typeof runView.conclusion !== 'string'
      || runView.conclusion.length === 0) {
    fail(`${definition.label} workflow run status is invalid`);
  }
  if (runView.conclusion !== 'success') {
    return { outcome: 'terminal_failure', runView, codeqlJob: null };
  }
  let codeqlJob = null;
  if (definition.requireCodeql) {
    codeqlJob = (runView.jobs || []).find((job) => job.name === 'CodeQL JavaScript/TypeScript');
    if (!codeqlJob || codeqlJob.status !== 'completed' || codeqlJob.conclusion !== 'success'
        || !/^[0-9]+$/u.test(String(codeqlJob.databaseId || codeqlJob.id || ''))) {
      fail('exact origin/main CodeQL job is missing, failed, or has no stable identity');
    }
  }
  return { outcome: 'success', runView, codeqlJob };
}

function persistProtectedWorkflowFailure(state, key, definition, reason, extra = {}) {
  const failed = writeCheckpoint({
    ...state,
    phase: 'protected_workflows_failed',
    nextAction: 'owner_review_required_protected_workflow',
    lastError: {
      step: `wait_${key}`,
      reason,
      failedAt: new Date().toISOString(),
      ...extra,
    },
    workflows: {
      ...state.workflows,
      [key]: {
        ...state.workflows[key],
        status: reason === 'timeout' ? 'timed_out' : 'terminal_failure',
        ...extra,
      },
    },
  });
  const conclusion = extra.observedConclusion ? ` (${extra.observedConclusion})` : '';
  fail(`${definition.label} did not reach exact-SHA terminal success${conclusion}`,
    reason === 'timeout' ? 124 : 1);
  return failed;
}

async function continueProtectedWorkflow(state, key, definition) {
  let record = state.workflows[key];
  validateProtectedWorkflowBinding(record, definition);
  if (record.status === 'completed') return state;
  if (record.status === 'terminal_failure') {
    fail(`${definition.label} previously reached a non-success terminal conclusion`);
  }
  if (record.status === 'timed_out') {
    fail(`${definition.label} exact-SHA success wait previously timed out`, 124);
  }

  while (record.status !== 'completed') {
    const pollLimit = protectedWorkflowTestPollLimit();
    if (Date.now() >= Date.parse(record.deadlineAt)
        || (pollLimit !== null && record.pollCount >= pollLimit)) {
      return persistProtectedWorkflowFailure(state, key, definition, 'timeout', {
        observedStatus: record.observedStatus || null,
        observedConclusion: record.observedConclusion || null,
      });
    }
    if (!record.runId) {
      const candidate = exactProtectedWorkflowCandidate(
        definition,
        record.workflowDatabaseId,
      );
      if (!candidate) {
        state = writeCheckpoint({
          ...state,
          workflows: {
            ...state.workflows,
            [key]: {
              ...record,
              status: 'awaiting_run',
              pollCount: record.pollCount + 1,
              lastPolledAt: new Date().toISOString(),
            },
          },
        });
        record = state.workflows[key];
        await waitForDispatchPoll();
        continue;
      }
      state = writeCheckpoint({
        ...state,
        phase: 'protected_workflows_wait',
        nextAction: `poll_exact_sha_${key}`,
        workflows: {
          ...state.workflows,
          [key]: {
            ...record,
            status: 'run_identified',
            runId: String(candidate.databaseId),
            attempt: candidate.attempt,
            runCreatedAt: candidate.createdAt,
            identifiedAt: new Date().toISOString(),
          },
        },
      });
      record = state.workflows[key];
    }

    const observation = inspectProtectedWorkflowRun(
      record.runId,
      record.attempt,
      record.workflowDatabaseId,
      definition,
    );
    if (observation.outcome === 'terminal_failure') {
      return persistProtectedWorkflowFailure(state, key, definition, 'terminal_failure', {
        observedStatus: observation.runView.status,
        observedConclusion: observation.runView.conclusion,
        runUrl: observation.runView.url,
      });
    }
    if (observation.outcome === 'pending') {
      state = writeCheckpoint({
        ...state,
        phase: 'protected_workflows_wait',
        nextAction: `poll_exact_sha_${key}`,
        workflows: {
          ...state.workflows,
          [key]: {
            ...record,
            status: 'pending',
            pollCount: record.pollCount + 1,
            observedStatus: observation.runView.status,
            observedConclusion: null,
            runUrl: observation.runView.url,
            lastPolledAt: new Date().toISOString(),
          },
        },
      });
      record = state.workflows[key];
      await waitForDispatchPoll();
      continue;
    }

    const codeqlJobId = observation.codeqlJob
      ? String(observation.codeqlJob.databaseId || observation.codeqlJob.id || '')
      : null;
    state = writeCheckpoint({
      ...state,
      workflows: {
        ...state.workflows,
        [key]: {
          ...record,
          status: 'completed',
          pollCount: record.pollCount + 1,
          observedStatus: observation.runView.status,
          observedConclusion: observation.runView.conclusion,
          runUrl: observation.runView.url,
          completedAt: new Date().toISOString(),
          ...(definition.requireCodeql ? {
            codeqlJobId,
            codeqlConclusion: observation.codeqlJob.conclusion,
          } : {}),
        },
      },
    });
    record = state.workflows[key];
  }
  return state;
}

async function continueProtectedWorkflows(state) {
  validateProtectedWorkflowSet(state);
  if (state.protectedMainChecks.status === 'completed') {
    return state;
  }
  for (const [key, definition] of Object.entries(protectedWorkflowDefinitions)) {
    state = await continueProtectedWorkflow(state, key, definition);
  }
  return writeCheckpoint({
    ...state,
    phase: 'protected_workflows_complete',
    nextAction: 'persist_release_candidate_dispatch_intent',
    lastError: null,
    protectedMainChecks: {
      ...state.protectedMainChecks,
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
  });
}

function revalidateCompletedProtectedWorkflow(
  record,
  definition,
  repository,
  { requireLatestAttempt = true } = {},
) {
  validateProtectedWorkflowBinding(record, definition);
  const workflowDatabaseId = pathScopedProtectedWorkflowDatabaseId(repository, definition);
  if (workflowDatabaseId !== record.workflowDatabaseId) {
    fail(`release checkpoint ${definition.label} workflow database identity drifted`, 64);
  }
  let latest = {
    attempt: record.attempt,
    workflowDatabaseId: record.workflowDatabaseId,
  };
  if (requireLatestAttempt) {
    latest = exactProtectedWorkflowCandidate(definition, workflowDatabaseId);
    if (!latest
        || String(latest.databaseId) !== String(record.runId)
        || latest.attempt !== record.attempt
        || latest.workflowDatabaseId !== record.workflowDatabaseId) {
      fail(`release checkpoint ${definition.label} is not bound to its latest exact-SHA attempt`, 64);
    }
  }
  const observation = inspectProtectedWorkflowRun(
    record.runId,
    record.attempt,
    record.workflowDatabaseId,
    definition,
  );
  if (observation.outcome !== 'success') {
    const conclusion = observation.runView?.conclusion || observation.runView?.status || 'unknown';
    fail(`release checkpoint ${definition.label} latest attempt is not successful (${conclusion})`);
  }
  const { runView, codeqlJob } = observation;
  if (runView.url !== record.runUrl
      || runView.headSha !== record.headSha
      || runView.conclusion !== record.observedConclusion) {
    fail(`release checkpoint ${definition.label} evidence no longer matches its exact run`, 64);
  }
  if (definition.requireCodeql) {
    const codeqlJobId = String(codeqlJob.databaseId || codeqlJob.id || '');
    if (codeqlJobId !== String(record.codeqlJobId)
        || codeqlJob.conclusion !== record.codeqlConclusion) {
      fail('release checkpoint CodeQL evidence no longer matches the exact stored run and job', 64);
    }
  }
  return {
    attempt: latest.attempt,
    conclusion: runView.conclusion,
    headSha: runView.headSha,
    runId: String(runView.databaseId),
    runUrl: runView.url,
    workflowPath: `.github/workflows/${definition.workflow}`,
    workflowDatabaseId,
    verifiedAt: new Date().toISOString(),
  };
}

function revalidateAndCheckpointCompletedProtectedWorkflows(state) {
  for (const [key, definition] of Object.entries(protectedWorkflowDefinitions)) {
    if (state.protectedMainChecks.status === 'pending'
        && Date.now() >= Date.parse(state.protectedMainChecks.deadlineAt)) {
      fail('required protected workflow revalidation exceeded the global deadline', 124);
    }
    if (state.workflows?.[key]?.status !== 'completed') {
      fail(`cannot aggregate release readiness before ${definition.label} succeeds`, 64);
    }
    const latest = revalidateCompletedProtectedWorkflow(
      state.workflows[key],
      definition,
      state.repository,
    );
    state = writeCheckpoint({
      ...state,
      workflows: {
        ...state.workflows,
        [key]: {
          ...state.workflows[key],
          latestAttemptVerified: latest.attempt,
          latestWorkflowDatabaseIdVerified: latest.workflowDatabaseId,
          latestAttemptVerifiedAt: latest.verifiedAt,
          latestVerification: {
            schema: 'nexus.release-required-workflow-latest-verification.v1',
            attempt: latest.attempt,
            conclusion: latest.conclusion,
            headSha: latest.headSha,
            runId: latest.runId,
            runUrl: latest.runUrl,
            workflowPath: latest.workflowPath,
            workflowDatabaseId: latest.workflowDatabaseId,
            verifiedAt: latest.verifiedAt,
          },
        },
      },
    });
  }
  return state;
}

function protectedWorkflowVerificationFreshnessMs() {
  const override = process.env.NEXUS_RELEASE_TEST_PROTECTED_FRESHNESS_MS || '';
  if (process.env.NODE_ENV === 'test' && /^[1-9]\d*$/.test(override)) {
    const parsed = Number(override);
    if (Number.isSafeInteger(parsed) && parsed <= 60_000) return parsed;
  }
  return 60_000;
}

function assertFreshProtectedWorkflowVerification(state, label) {
  const now = Date.now();
  const maximumAgeMs = protectedWorkflowVerificationFreshnessMs();
  for (const [key, definition] of Object.entries(protectedWorkflowDefinitions)) {
    const workflow = state.workflows?.[key];
    const latest = workflow?.latestVerification;
    const verifiedAt = Date.parse(latest?.verifiedAt || '');
    if (workflow?.status !== 'completed'
        || latest?.schema !== 'nexus.release-required-workflow-latest-verification.v1'
        || latest.attempt !== workflow.attempt
        || latest.conclusion !== 'success'
        || latest.headSha !== runtimeSha
        || latest.runId !== String(workflow.runId)
        || latest.runUrl !== workflow.runUrl
        || latest.workflowPath !== `.github/workflows/${definition.workflow}`
        || latest.workflowDatabaseId !== workflow.workflowDatabaseId
        || workflow.latestAttemptVerified !== latest.attempt
        || workflow.latestWorkflowDatabaseIdVerified !== latest.workflowDatabaseId
        || workflow.latestAttemptVerifiedAt !== latest.verifiedAt
        || !Number.isFinite(verifiedAt)
        || now - verifiedAt < 0
        || now - verifiedAt > maximumAgeMs) {
      fail(`${definition.label} protected verification changed or expired before ${label}`, 64);
    }
  }
}

function protectedWorkflowDispatchBinding(state) {
  return {
    schema: 'nexus.release-candidate-protected-workflow-binding.v1',
    workflows: Object.fromEntries(
      Object.entries(protectedWorkflowDefinitions).map(([key]) => [
        key,
        state.workflows?.[key]?.latestVerification,
      ]),
    ),
  };
}

function validateProtectedWorkflowDispatchBinding(state) {
  if (canonicalJson(state.rcDispatch?.protectedWorkflowBinding)
      !== canonicalJson(protectedWorkflowDispatchBinding(state))) {
    fail('release-candidate protected workflow dispatch binding drifted', 64);
  }
}

async function waitForReleaseCandidateTestPause() {
  const delay = process.env.NEXUS_RELEASE_TEST_RC_PRESPAWN_DELAY_MS || '';
  if (process.env.NODE_ENV !== 'test' || !/^[1-9]\d*$/.test(delay)) return;
  const delayMs = Number(delay);
  if (!Number.isSafeInteger(delayMs) || delayMs > 5_000) {
    fail('release-candidate test pause is invalid', 64);
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function revalidateCheckpointTrust(state) {
  const repository = validateProtectedRepository();
  if (repository !== state.repository || repository !== state.sourceIntent?.repository) {
    fail('release checkpoint repository identity no longer matches protected main', 64);
  }

  validateProtectedWorkflowSet(state);
  const requireLatestAttempt = !state.rcDispatch
    || state.rcDispatch.status === 'intent_persisted';
  for (const [key, definition] of Object.entries(protectedWorkflowDefinitions)) {
    if (state.workflows[key].status === 'completed') {
      revalidateCompletedProtectedWorkflow(
        state.workflows[key],
        definition,
        state.repository,
        { requireLatestAttempt },
      );
    }
  }

  if (state.phase === 'promoted') {
    const identity = state.productionEvidenceIdentity;
    const expectedPath = path.join(
      root,
      '.local',
      'release',
      'production',
      `${runtimeSha}-${state.artifactDigest}.json`,
    );
    let production;
    try {
      if (path.resolve(identity?.path || '') !== expectedPath
          || !fs.lstatSync(expectedPath).isFile()
          || fs.lstatSync(expectedPath).isSymbolicLink()
          || sha256File(expectedPath) !== identity?.sha256) {
        fail('production promotion evidence identity drifted after it was checkpointed');
      }
      production = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    } catch {
      fail('production promotion evidence identity drifted after it was checkpointed');
    }
    if (!productionEvidenceMatches(production, {
      runtimeSha,
      artifactDigest: identity.artifactDigest,
      installedRuntimeDigest: identity.installedRuntimeDigest,
      recoveryRuntimeDigest: identity.recoveryRuntimeDigest,
      releaseManifestSha256: identity.releaseManifestSha256,
      stagingAttestationSha256: identity.stagingAttestationSha256,
      packageVersion: state.packageVersion,
    }) || identity.packageVersion !== state.packageVersion
      || identity.transactionId !== production.transactionId) {
      fail('production promotion evidence no longer proves the exact checkpoint identity');
    }
  }
}

function releaseCandidateDispatchArgs(
  scope,
  iosEvidence,
  protectedReuseActivation,
  correlationNonce,
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(correlationNonce || '')) {
    fail('release-candidate correlation nonce is invalid', 64);
  }
  const dispatchArgs = ['workflow', 'run', 'release-candidate-evidence.yml', '--ref', 'main',
    '-f', `correlation_nonce=${correlationNonce}`,
    '-f', `contract_scope=${scope}`, '-f', 'force_full=false'];
  const activationBody = validateProtectedReuseActivation(protectedReuseActivation);
  if (activationBody) {
    dispatchArgs.push('-f', `protected_reuse_activation_b64=${activationBody.toString('base64')}`);
  }
  if (scope === 'shared_backend_ios') {
    let attestation;
    try { attestation = JSON.parse(fs.readFileSync(iosEvidence.compatibilityPath, 'utf8')); } catch {
      fail('iOS compatibility attestation is missing or invalid');
    }
    const iosSha = attestation?.payload?.ios?.sha;
    const iosBuildNumber = String(attestation?.payload?.ios?.buildNumber || '');
    if (!/^[a-f0-9]{40}$/u.test(iosSha || '') || !/^[1-9][0-9]*$/u.test(iosBuildNumber)) {
      fail('iOS compatibility attestation source identity is invalid');
    }
    dispatchArgs.push('-f', `ios_sha=${iosSha}`, '-f', `ios_build_number=${iosBuildNumber}`, '-f', 'ios_contract_result=passed');
  }
  return dispatchArgs;
}

function releaseCandidateRuns() {
  return ghJson(['run', 'list', '--workflow', 'release-candidate-evidence.yml', '--branch', 'main',
    '--event', 'workflow_dispatch', '--limit', '50', '--json',
    'databaseId,displayTitle,headSha,status,conclusion,createdAt'], 'release-candidate workflow lookup');
}

function correlatedReleaseCandidate(intent) {
  const baseline = new Set((intent.baselineRunIds || []).map(String));
  const notBefore = Date.parse(intent.candidateNotBefore || '');
  if (!Number.isFinite(notBefore)) fail('release-candidate dispatch intent timestamp is invalid');
  const candidates = releaseCandidateRuns().filter((candidate) => {
    const createdAt = Date.parse(candidate.createdAt || '');
    return candidate.displayTitle === intent.expectedTitle
      && candidate.headSha === runtimeSha
      && !baseline.has(String(candidate.databaseId))
      && Number.isFinite(createdAt)
      && createdAt >= notBefore;
  });
  if (candidates.length > 1) {
    fail('release-candidate dispatch correlation is ambiguous; refusing to select a run');
  }
  return candidates[0] || null;
}

function publicState(state, extra = {}) {
  return {
    ok: state.phase === 'promoted',
    schema: state.schema,
    runtimeSha: state.runtimeSha,
    packageVersion: state.packageVersion,
    rcRunId: state.rcRunId,
    workflows: state.workflows,
    contractScope: state.contractScope,
    phase: state.phase,
    nextAction: state.nextAction,
    checkpoint: path.relative(root, checkpointPath),
    ...extra,
  };
}

function emit(state, extra = {}, code = 0) {
  process.stdout.write(`${JSON.stringify(publicState(state, extra), null, 2)}\n`);
  process.exit(code);
}

function childStatusFromSignal(signal) {
  const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
  return 128 + (signalNumbers[signal] || 1);
}

async function runSupervised(
  command,
  commandArgs,
  env = process.env,
  beforeSpawn = null,
) {
  if (activeChild) fail('release coordinator attempted overlapping external work', 70);
  assertCoordinatorLockIdentity();
  const maximumOutputBytes = 16 * 1024 * 1024;
  if (beforeSpawn) beforeSpawn();
  const child = spawn(command, commandArgs, {
    cwd: root,
    env,
    detached: true,
    stdio: inheritedLockStdio('pipe', 'pipe'),
  });
  activeChild = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  let outputError = null;
  const capture = (stream, chunk) => {
    const current = stream === 'stdout' ? stdout : stderr;
    if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > maximumOutputBytes) {
      outputError = new Error(`release child ${stream} exceeded the bounded output limit`);
      killProcessGroup(child, 'SIGKILL');
      return;
    }
    if (stream === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  child.stdout.on('data', (chunk) => capture('stdout', chunk));
  child.stderr.on('data', (chunk) => capture('stderr', chunk));
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error, status: null, signal: null }));
    child.once('close', (status, signal) => resolve({ error: null, status, signal }));
  });
  activeChild = null;
  if (terminationEscalationTimer) {
    clearTimeout(terminationEscalationTimer);
    terminationEscalationTimer = null;
  }
  if (requestedTerminationSignal) process.exit(signalExitCode(requestedTerminationSignal));
  return {
    stdout,
    stderr,
    error: outputError || outcome.error,
    status: outcome.status ?? (outcome.signal ? childStatusFromSignal(outcome.signal) : 1),
    signal: outcome.signal,
  };
}

async function runStep(state, label, command, commandArgs, env = process.env) {
  const attempt = {
    step: label,
    startedAt: new Date().toISOString(),
    commandSha256: crypto.createHash('sha256').update(JSON.stringify([command, commandArgs])).digest('hex'),
  };
  state = writeCheckpoint({
    ...state,
    inProgressStep: label,
    lastError: null,
    attempts: [...(state.attempts || []), attempt],
  });
  const result = await runSupervised(command, commandArgs, env);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    const attempts = [...state.attempts];
    attempts[attempts.length - 1] = {
      ...attempts.at(-1), completedAt: new Date().toISOString(), status: result.status ?? 1,
      stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
      stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
    };
    writeCheckpoint({
      ...state,
      attempts,
      inProgressStep: null,
      lastError: { step: label, status: result.status ?? 1, failedAt: new Date().toISOString() },
      nextAction: `retry_${label}`,
    });
    fail(`release resume step failed: ${label}`, result.status || 1);
  }
  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts.at(-1), completedAt: new Date().toISOString(), status: 0,
    stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
    stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
  };
  return writeCheckpoint({ ...state, attempts, inProgressStep: null, lastError: null });
}

function dispatchCommandDigest(commandArgs) {
  return crypto.createHash('sha256').update(JSON.stringify(['gh', commandArgs])).digest('hex');
}

async function waitForDispatchPoll() {
  const delayMs = process.env.NODE_ENV === 'test'
      && process.env.NEXUS_RELEASE_TEST_ZERO_POLL_DELAY === '1'
    ? 0
    : 2_000;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function runReleaseCandidateDispatch(state, commandArgs) {
  const label = 'dispatch_release_candidate';
  const attempt = {
    step: label,
    startedAt: new Date().toISOString(),
    commandSha256: dispatchCommandDigest(commandArgs),
  };
  state = writeCheckpoint({
    ...state,
    inProgressStep: label,
    lastError: null,
    attempts: [...(state.attempts || []), attempt],
  });
  const result = await runSupervised('gh', commandArgs, process.env);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts.at(-1),
    completedAt: new Date().toISOString(),
    status: result.status ?? 1,
    stdoutSha256: crypto.createHash('sha256').update(result.stdout || '').digest('hex'),
    stderrSha256: crypto.createHash('sha256').update(result.stderr || '').digest('hex'),
  };
  if (result.error || result.status !== 0) {
    writeCheckpoint({
      ...state,
      attempts,
      inProgressStep: null,
      lastError: { step: label, status: result.status ?? 1, failedAt: new Date().toISOString() },
      nextAction: 'reconcile_dispatched_rc_without_redispatch',
    });
    fail('release-candidate dispatch outcome is uncertain; resume will reconcile without redispatch', result.status || 1);
  }
  return writeCheckpoint({
    ...state,
    attempts,
    inProgressStep: null,
    lastError: null,
    nextAction: 'identify_dispatched_release_candidate',
    rcDispatch: {
      ...state.rcDispatch,
      status: 'dispatch_accepted',
      dispatchAcceptedAt: new Date().toISOString(),
    },
  });
}

async function continueReleaseCandidate(state) {
  const intent = state.rcDispatch;
  const dispatchArgs = releaseCandidateDispatchArgs(
    state.contractScope,
    state.iosEvidence,
    state.protectedReuseActivation,
    intent.correlationNonce,
  );
  const workflowSha256 = sha256File(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml'));
  if (intent?.schema !== 'nexus.release-candidate-dispatch-intent.v1'
      || intent.workflow !== 'release-candidate-evidence.yml'
      || intent.workflowSha256 !== workflowSha256
      || intent.headSha !== runtimeSha
      || intent.contractScope !== state.contractScope
      || intent.commandSha256 !== dispatchCommandDigest(dispatchArgs)
      || !/^[0-9a-f-]{36}$/u.test(intent.correlationNonce || '')
      || intent.expectedTitle
        !== `RC evidence ${runtimeSha} request ${intent.correlationNonce}`
      || !Array.isArray(intent.baselineRunIds)) {
    fail('release-candidate dispatch intent identity mismatch', 64);
  }
  if (intent.status !== 'intent_persisted') {
    validateProtectedWorkflowDispatchBinding(state);
  }
  if (state.rcDispatch?.status === 'completed') {
    if (!/^[0-9]+$/u.test(state.rcRunId || '')
        || state.workflows?.releaseCandidate?.runId !== state.rcRunId
        || state.rcDispatch?.runId !== state.rcRunId) {
      fail('completed release-candidate checkpoint identity is invalid', 64);
    }
    return state;
  }

  if (!state.rcRunId) {
    if (intent.status === 'intent_persisted') {
      // Any laptop pause or other delay belongs before the final live
      // revalidation. A validation failure therefore leaves the durable
      // dispatch intent safely retryable; only persist dispatch_started once
      // every fail-closed check has passed and the next operation is spawn.
      await waitForReleaseCandidateTestPause();
      state = revalidateAndCheckpointCompletedProtectedWorkflows(state);
      assertFreshProtectedWorkflowVerification(state, 'release-candidate dispatch transition');
      state = writeCheckpoint({
        ...state,
        phase: 'rc_dispatch_started',
        nextAction: 'dispatch_release_candidate_once',
        rcDispatch: {
          ...intent,
          status: 'dispatch_started',
          dispatchStartedAt: new Date().toISOString(),
          protectedWorkflowBinding: protectedWorkflowDispatchBinding(state),
        },
      });
      state = await runReleaseCandidateDispatch(state, dispatchArgs);
    } else if (!['dispatch_started', 'dispatch_accepted'].includes(intent.status)) {
      fail('release-candidate dispatch state is invalid', 64);
    }

    let candidate = null;
    for (let attempt = 0; attempt < 30 && !candidate; attempt += 1) {
      candidate = correlatedReleaseCandidate(state.rcDispatch);
      if (!candidate && attempt < 29) {
        await waitForDispatchPoll();
      }
    }
    if (!candidate || !/^[0-9]+$/u.test(String(candidate.databaseId || ''))) {
      writeCheckpoint({
        ...state,
        nextAction: 'manual_rc_dispatch_reconciliation_required',
        lastError: {
          step: 'identify_dispatched_release_candidate',
          failedAt: new Date().toISOString(),
          reason: 'no_unique_correlated_run',
        },
      });
      fail('dispatched release-candidate workflow run was not uniquely found; refusing automatic redispatch');
    }
    const runId = String(candidate.databaseId);
    state = writeCheckpoint({
      ...state,
      rcRunId: runId,
      phase: 'rc_run_identified',
      nextAction: 'watch_identified_release_candidate',
      lastError: null,
      rcDispatch: {
        ...state.rcDispatch,
        status: 'run_identified',
        runId,
        runCreatedAt: candidate.createdAt,
        identifiedAt: new Date().toISOString(),
      },
      workflows: {
        ...state.workflows,
        releaseCandidate: {
          workflow: 'release-candidate-evidence.yml',
          workflowSha256,
          runId,
          headSha: runtimeSha,
          correlationNonce: state.rcDispatch.correlationNonce,
          runCreatedAt: candidate.createdAt,
        },
      },
    });
  } else if (state.rcDispatch?.runId !== state.rcRunId
      || state.workflows?.releaseCandidate?.runId !== state.rcRunId) {
    fail('release-candidate run identity differs from its persisted dispatch intent', 64);
  }

  state = await runStep(state, 'watch_release_candidate', 'gh', [
    'run', 'watch', state.rcRunId, '--exit-status',
  ]);
  const { runView } = validateWorkflowRun(state.rcRunId, {
    workflowName: 'RC — Release Evidence',
    expectedTitle: state.rcDispatch.expectedTitle,
  });
  return writeCheckpoint({
    ...state,
    phase: 'rc_complete',
    nextAction: 'request_trusted_signing',
    rcDispatch: {
      ...state.rcDispatch,
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
    workflows: {
      ...state.workflows,
      releaseCandidate: {
        ...state.workflows.releaseCandidate,
        runUrl: runView.url,
        headSha: runView.headSha,
        conclusion: runView.conclusion,
      },
    },
  });
}

function protectedWorkflowRuns(workflow) {
  return ghJson(['run', 'list', '--workflow', workflow, '--branch', 'main',
    '--event', 'workflow_dispatch', '--limit', '50', '--json',
    'databaseId,displayTitle,headSha,headBranch,event,status,conclusion,createdAt'],
  `${workflow} run lookup`);
}

function correlatedProtectedWorkflowRun(intent) {
  const baseline = new Set((intent.baselineRunIds || []).map(String));
  const notBefore = Date.parse(intent.candidateNotBefore || '');
  if (!Number.isFinite(notBefore)) fail(`${intent.workflow} dispatch intent timestamp is invalid`);
  const candidates = protectedWorkflowRuns(intent.workflow).filter((candidate) => {
    const createdAt = Date.parse(candidate.createdAt || '');
    return candidate.displayTitle === intent.expectedTitle
      && candidate.headSha === runtimeSha
      && candidate.headBranch === 'main'
      && candidate.event === 'workflow_dispatch'
      && !baseline.has(String(candidate.databaseId))
      && Number.isFinite(createdAt)
      && createdAt >= notBefore;
  });
  if (candidates.length > 1) {
    fail(`${intent.workflow} dispatch correlation is ambiguous; refusing to select a run`);
  }
  return candidates[0] || null;
}

function validateProtectedWorkflowRun(runId, intent, requireComplete = false) {
  const runView = ghJson(['run', 'view', String(runId), '--json',
    'databaseId,displayTitle,headSha,headBranch,event,status,conclusion,workflowName,url'],
  `${intent.workflow} run ${runId}`);
  if (String(runView.databaseId) !== String(runId)
      || runView.displayTitle !== intent.expectedTitle
      || runView.headSha !== runtimeSha
      || runView.headBranch !== 'main'
      || runView.event !== 'workflow_dispatch'
      || runView.workflowName !== intent.workflowName
      || typeof runView.url !== 'string'
      || runView.url.length === 0
      || (requireComplete && (runView.status !== 'completed' || runView.conclusion !== 'success'))) {
    fail(`${intent.workflow} run ${runId} does not match its persisted exact-main dispatch intent`);
  }
  return runView;
}

async function runProtectedWorkflowDispatch(state, stateKey, label, dispatchArgs) {
  const attempt = {
    step: label,
    startedAt: new Date().toISOString(),
    commandSha256: dispatchCommandDigest(dispatchArgs),
  };
  state = writeCheckpoint({
    ...state,
    inProgressStep: label,
    lastError: null,
    attempts: [...(state.attempts || []), attempt],
  });
  const result = await runSupervised('gh', dispatchArgs);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const attempts = [...state.attempts];
  attempts[attempts.length - 1] = {
    ...attempts.at(-1),
    completedAt: new Date().toISOString(),
    status: result.status ?? 1,
    stdoutSha256: sha256Buffer(Buffer.from(result.stdout || '')),
    stderrSha256: sha256Buffer(Buffer.from(result.stderr || '')),
  };
  if (result.error || result.status !== 0) {
    writeCheckpoint({
      ...state,
      attempts,
      inProgressStep: null,
      lastError: { step: label, status: result.status ?? 1, failedAt: new Date().toISOString() },
      nextAction: `reconcile_${stateKey}_without_redispatch`,
    });
    fail(`${label} outcome is uncertain; resume will reconcile without redispatch`, result.status || 1);
  }
  return writeCheckpoint({
    ...state,
    attempts,
    inProgressStep: null,
    lastError: null,
    nextAction: `identify_${stateKey}`,
    [stateKey]: {
      ...state[stateKey],
      status: 'dispatch_accepted',
      dispatchAcceptedAt: new Date().toISOString(),
    },
  });
}

async function continueProtectedWorkflowDispatch(state, {
  stateKey,
  workflowStateKey,
  label,
  dispatchArgs,
}) {
  const intent = state[stateKey];
  if (typeof intent?.workflow !== 'string'
      || !/^[A-Za-z0-9_.-]+\.ya?ml$/u.test(intent.workflow)) {
    fail(`${stateKey} workflow identity is invalid`, 64);
  }
  const workflowSha256 = sha256File(path.join(root, '.github', 'workflows', intent?.workflow || ''));
  if (intent?.schema !== 'nexus.protected-workflow-dispatch-intent.v1'
      || intent.workflowSha256 !== workflowSha256
      || intent.headSha !== runtimeSha
      || intent.commandSha256 !== dispatchCommandDigest(dispatchArgs)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(intent.requestId || '')
      || !Array.isArray(intent.baselineRunIds)
      || typeof intent.expectedTitle !== 'string'
      || typeof intent.workflowName !== 'string') {
    fail(`${stateKey} identity mismatch`, 64);
  }
  if (intent.status === 'completed') {
    if (!/^[1-9][0-9]*$/u.test(String(intent.runId || ''))
        || state.workflows?.[workflowStateKey]?.runId !== String(intent.runId)) {
      fail(`completed ${stateKey} checkpoint identity is invalid`, 64);
    }
    validateProtectedWorkflowRun(intent.runId, intent, true);
    return state;
  }
  if (!intent.runId) {
    if (intent.status === 'intent_persisted') {
      state = writeCheckpoint({
        ...state,
        nextAction: `dispatch_${stateKey}_once`,
        [stateKey]: {
          ...intent,
          status: 'dispatch_started',
          dispatchStartedAt: new Date().toISOString(),
        },
      });
      state = await runProtectedWorkflowDispatch(state, stateKey, label, dispatchArgs);
    } else if (!['dispatch_started', 'dispatch_accepted'].includes(intent.status)) {
      fail(`${stateKey} dispatch state is invalid`, 64);
    }
    let candidate = null;
    for (let attempt = 0; attempt < 30 && !candidate; attempt += 1) {
      candidate = correlatedProtectedWorkflowRun(state[stateKey]);
      if (!candidate && attempt < 29) {
        await waitForDispatchPoll();
      }
    }
    if (!candidate || !/^[1-9][0-9]*$/u.test(String(candidate.databaseId || ''))) {
      writeCheckpoint({
        ...state,
        nextAction: `manual_${stateKey}_reconciliation_required`,
        lastError: {
          step: `identify_${stateKey}`,
          failedAt: new Date().toISOString(),
          reason: 'no_unique_correlated_run',
        },
      });
      fail(`${state[stateKey].workflow} run was not uniquely found; refusing automatic redispatch`);
    }
    const runId = String(candidate.databaseId);
    state = writeCheckpoint({
      ...state,
      nextAction: `watch_${stateKey}`,
      lastError: null,
      [stateKey]: {
        ...state[stateKey],
        status: 'run_identified',
        runId,
        runCreatedAt: candidate.createdAt,
        identifiedAt: new Date().toISOString(),
      },
      workflows: {
        ...state.workflows,
        [workflowStateKey]: {
          workflow: state[stateKey].workflow,
          workflowSha256,
          runId,
          headSha: runtimeSha,
          requestId: state[stateKey].requestId,
          runCreatedAt: candidate.createdAt,
        },
      },
    });
  } else if (state.workflows?.[workflowStateKey]?.runId !== String(intent.runId)) {
    fail(`${stateKey} run identity differs from its persisted dispatch intent`, 64);
  }
  const runView = validateProtectedWorkflowRun(
    state[stateKey].runId,
    state[stateKey],
    false,
  );
  state = writeCheckpoint({
    ...state,
    [stateKey]: {
      ...state[stateKey],
      runUrl: runView.url,
      observedStatus: runView.status,
      observedConclusion: runView.conclusion,
    },
    workflows: {
      ...state.workflows,
      [workflowStateKey]: {
        ...state.workflows[workflowStateKey],
        runUrl: runView.url,
        observedStatus: runView.status,
        observedConclusion: runView.conclusion,
      },
    },
  });
  const noticeStatus = runView.status === 'waiting'
    ? 'approval_required'
    : runView.status === 'completed' && runView.conclusion === 'success'
      ? 'already_completed'
      : runView.status === 'completed'
        ? 'terminal_failure'
      : 'workflow_pending';
  process.stderr.write(`${JSON.stringify({
    schema: 'nexus.release-protected-workflow-notice.v1',
    status: noticeStatus,
    workflow: state[stateKey].workflowName,
    runId: String(state[stateKey].runId),
    url: runView.url,
  })}\n`);
  return state;
}

function newProtectedWorkflowIntent({
  workflow,
  workflowName,
  expectedTitle,
  requestId,
  dispatchArgs,
  extra = {},
}) {
  const createdAt = new Date();
  return {
    schema: 'nexus.protected-workflow-dispatch-intent.v1',
    status: 'intent_persisted',
    workflow,
    workflowName,
    workflowSha256: sha256File(path.join(root, '.github', 'workflows', workflow)),
    headSha: runtimeSha,
    requestId,
    expectedTitle,
    correlationMode: 'unique_request_id_baseline_and_created_at',
    baselineRunIds: protectedWorkflowRuns(workflow).map((candidate) => String(candidate.databaseId)),
    intentCreatedAt: createdAt.toISOString(),
    candidateNotBefore: new Date(createdAt.getTime() - 60_000).toISOString(),
    commandSha256: dispatchCommandDigest(dispatchArgs),
    ...extra,
  };
}

function releaseManifestSigningDispatchArgs(state, requestId) {
  const dispatchArgs = ['workflow', 'run', 'sign-release-manifest.yml', '--ref', 'main',
    '-f', `runtime_sha=${runtimeSha}`,
    '-f', `candidate_run_id=${state.rcRunId}`,
    '-f', `request_id=${requestId}`,
    '-f', `contract_scope=${state.contractScope}`];
  if (state.contractScope === 'shared_backend_ios') {
    const compatibilityPath = path.resolve(state.iosEvidence?.compatibilityPath || '');
    const distributionPath = path.resolve(state.iosEvidence?.distributionPath || '');
    const compatibility = fs.readFileSync(compatibilityPath).toString('base64');
    const distribution = fs.readFileSync(distributionPath).toString('base64');
    if (!compatibility || compatibility.length > 32_768
        || !distribution || distribution.length > 131_072) {
      fail('checkpointed iOS signing evidence is empty or too large', 64);
    }
    dispatchArgs.push(
      '-f', `ios_attestation_base64=${compatibility}`,
      '-f', `ios_distribution_attestation_base64=${distribution}`,
    );
  }
  return dispatchArgs;
}

function stagingRequestIdentity(requestPath, expected = null) {
  let input;
  try {
    input = readPrivateBoundedJson(requestPath, 45_000, 'staging attestation request');
  } catch (error) {
    fail(error.message, 64);
  }
  const request = input.parsed;
  const digest = sha256Buffer(input.body);
  if (input.mode !== 0o600 || request.schema !== 'nexus.staging-attestation-request.v1'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(request.requestId || '')
      || request.runtimeSha !== runtimeSha
      || request.artifactDigest !== expected?.artifactDigest
      || request.releaseManifestSha256 !== expected?.releaseManifestSha256
      || !/^[a-f0-9]{64}$/u.test(request.installedRuntimeDigest || '')
      || !/^[a-f0-9]{64}$/u.test(request.recoveryRuntimeDigest || '')
      || !Number.isFinite(Date.parse(request.verifiedAt || ''))
      || !Number.isFinite(Date.parse(request.expiresAt || ''))
      || Date.parse(request.expiresAt) <= Date.now()) {
    fail('staging attestation request identity is invalid or expired', 64);
  }
  if (expected?.requestId && request.requestId !== expected.requestId) {
    fail('staging attestation request id differs from the checkpoint', 64);
  }
  if (expected?.sha256 && (digest !== expected.sha256 || input.body.length !== expected.sizeBytes)) {
    fail('staging attestation request drifted after it was checkpointed', 64);
  }
  return {
    path: input.resolved,
    requestId: request.requestId,
    sha256: digest,
    sizeBytes: input.body.length,
    installedRuntimeDigest: request.installedRuntimeDigest,
    recoveryRuntimeDigest: request.recoveryRuntimeDigest,
    request,
    body: input.body,
  };
}

function stagingSigningDispatchArgs(requestIdentity) {
  return ['workflow', 'run', 'sign-staging-attestation.yml', '--ref', 'main',
    '-f', 'evidence_kind=staging_attestation',
    '-f', `request_id=${requestIdentity.requestId}`,
    '-f', `runtime_sha=${runtimeSha}`,
    '-f', `request_sha256=${requestIdentity.sha256}`,
    '-f', `request_b64=${requestIdentity.body.toString('base64')}`];
}

function ensureReleaseCandidateDispatchIntent(state) {
  if (state.rcDispatch) return state;
  if (state.protectedMainChecks?.status !== 'completed') {
    fail('release-candidate dispatch requires terminal success from all protected workflows', 64);
  }
  const correlationNonce = crypto.randomUUID();
  const baselineRunIds = releaseCandidateRuns().map((candidate) => String(candidate.databaseId));
  const intentCreatedAt = new Date();
  const dispatchArgs = releaseCandidateDispatchArgs(
    state.contractScope,
    state.iosEvidence,
    state.protectedReuseActivation,
    correlationNonce,
  );
  return writeCheckpoint({
    ...state,
    phase: 'rc_dispatch_intent',
    nextAction: 'dispatch_release_candidate_once',
    rcDispatch: {
      schema: 'nexus.release-candidate-dispatch-intent.v1',
      status: 'intent_persisted',
      workflow: 'release-candidate-evidence.yml',
      workflowSha256: sha256File(path.join(root, '.github', 'workflows', 'release-candidate-evidence.yml')),
      headSha: runtimeSha,
      contractScope: state.contractScope,
      correlationNonce,
      expectedTitle: `RC evidence ${runtimeSha} request ${correlationNonce}`,
      correlationMode: 'unique_run_name_nonce_baseline_and_created_at',
      baselineRunIds,
      intentCreatedAt: intentCreatedAt.toISOString(),
      candidateNotBefore: new Date(intentCreatedAt.getTime() - 60_000).toISOString(),
      commandSha256: dispatchCommandDigest(dispatchArgs),
    },
  });
}

const suppliedScope = has('--backend-only') ? 'backend_only' : has('--includes-ios') ? 'shared_backend_ios' : '';
if (has('--backend-only') && has('--includes-ios')) fail('release contract scope may be specified only once', 64);
const suppliedRcRun = value('--rc-run');
if (suppliedRcRun && !/^[0-9]+$/u.test(suppliedRcRun)) fail('release RC run id is invalid', 64);
const suppliedProtectedReuseActivation = value('--protected-reuse-activation');

let state = readCheckpoint();
const phaseAtProcessStart = state?.phase || null;
const ownerStopPersistedAtProcessStart = state !== null
  && ['owner_stop', 'owner_authorized_for_current_invocation'].includes(state.phase)
  && Number.isFinite(Date.parse(state.ownerStopReachedAt || ''));
if (!state) {
  if (suppliedRcRun) fail('a new release sequence dispatches its own RC; --rc-run is resume-only', 64);
  if (!suppliedScope) fail('first release resume requires --backend-only or --includes-ios', 64);
  const iosAttestation = value('--ios-attestation');
  const iosDistributionAttestation = value('--ios-distribution-attestation');
  if (suppliedScope === 'shared_backend_ios' && (!iosAttestation || !iosDistributionAttestation)) {
    fail('shared release resume requires both signed iOS attestations', 64);
  }
  if (suppliedScope === 'backend_only' && (iosAttestation || iosDistributionAttestation)) {
    fail('backend-only release resume must not include iOS evidence', 64);
  }
  const iosEvidence = suppliedScope === 'shared_backend_ios' ? {
    compatibilityPath: path.resolve(root, iosAttestation),
    distributionPath: path.resolve(root, iosDistributionAttestation),
  } : null;
  const repository = validateProtectedRepository();
  const protectedReuseActivation = initialProtectedReuseActivation(suppliedProtectedReuseActivation);
  const sequenceStartedAt = new Date();
  const deadlineAt = new Date(
    sequenceStartedAt.getTime() + protectedWorkflowWaitMs(),
  ).toISOString();
  const startedAt = sequenceStartedAt.toISOString();
  state = writeCheckpoint({
    schema: 'nexus.release-sequence-checkpoint.v1',
    runtimeSha,
    originMainSha,
    packageVersion,
    repository,
    sourceIntent: { runtimeSha, originMainSha, packageVersion, repository },
    rcRunId: null,
    contractScope: suppliedScope,
    phase: 'protected_workflows_wait',
    nextAction: 'poll_exact_sha_protectedMainCi',
    createdAt: startedAt,
    inProgressStep: null,
    lastError: null,
    attempts: [],
    iosEvidence,
    protectedReuseActivation,
    protectedMainChecks: {
      schema: 'nexus.release-required-workflows.v1',
      status: 'pending',
      headSha: runtimeSha,
      startedAt,
      deadlineAt,
    },
    workflows: Object.fromEntries(
      Object.entries(protectedWorkflowDefinitions).map(([key, definition]) => [
        key,
        initialProtectedWorkflowState(
          definition,
          pathScopedProtectedWorkflowDatabaseId(repository, definition),
          startedAt,
          deadlineAt,
        ),
      ]),
    ),
    rcDispatch: null,
  });
} else {
  if (!state.protectedReuseActivation) {
    state = writeCheckpoint({
      ...state,
      protectedReuseActivation: {
        schema: 'nexus.protected-main-reuse-coordinator-input.v1',
        status: 'fallback',
        reason: 'legacy_checkpoint_without_activation',
      },
    });
  }
  validateProtectedReuseActivation(
    state.protectedReuseActivation,
    suppliedProtectedReuseActivation,
  );
  if (state.originMainSha !== originMainSha || state.packageVersion !== packageVersion) {
    fail('release checkpoint source or package version identity mismatch', 64);
  }
  if (state.sourceIntent?.runtimeSha !== runtimeSha
      || state.sourceIntent?.originMainSha !== originMainSha
      || state.sourceIntent?.packageVersion !== packageVersion
      || state.sourceIntent?.repository !== state.repository) {
    fail('release checkpoint source intent identity mismatch', 64);
  }
  revalidateCheckpointTrust(state);
  if (suppliedRcRun && suppliedRcRun !== state.rcRunId) fail('release checkpoint RC run identity mismatch', 64);
  if (suppliedScope && suppliedScope !== state.contractScope) fail('release checkpoint contract scope mismatch', 64);
  if (phaseAtProcessStart === 'promoted') emit(state);
}

state = await continueProtectedWorkflows(state);
state = ensureReleaseCandidateDispatchIntent(state);
state = await continueReleaseCandidate(state);
if (has('--status')) emit(state);

const suppliedManifestPath = value('--manifest');
const recordedManifestIdentity = state.signedManifestIdentity || null;
const manifestPath = path.resolve(root, suppliedManifestPath
  || recordedManifestIdentity?.path
  || path.join('.local', 'release', 'manifests', `${runtimeSha}.json`));
if (recordedManifestIdentity && manifestPath !== path.resolve(recordedManifestIdentity.path)) {
  fail('signed release manifest path differs from the checkpoint identity', 64);
}
if (recordedManifestIdentity) {
  if (!fs.existsSync(manifestPath)
      || sha256File(manifestPath) !== recordedManifestIdentity.sha256
      || recordedManifestIdentity.artifactDigest !== state.artifactDigest
      || recordedManifestIdentity.sha256 !== state.signedManifestSha256) {
    fail('signed release manifest identity drifted after it was checkpointed');
  }
}

if (!state.manifestSigningDispatch && !fs.existsSync(manifestPath)) {
  const requestId = crypto.randomUUID();
  const dispatchArgs = releaseManifestSigningDispatchArgs(state, requestId);
  state = writeCheckpoint({
    ...state,
    phase: 'manifest_signing_dispatch_intent',
    nextAction: 'dispatch_manifest_signing_once',
    manifestSigningDispatch: newProtectedWorkflowIntent({
      workflow: 'sign-release-manifest.yml',
      workflowName: 'Release — Sign exact candidate',
      expectedTitle: `Sign release candidate ${runtimeSha} run ${state.rcRunId} request ${requestId}`,
      requestId,
      dispatchArgs,
      extra: {
        candidateRunId: state.rcRunId,
        contractScope: state.contractScope,
      },
    }),
  });
}
if (state.manifestSigningDispatch) {
  const dispatchArgs = releaseManifestSigningDispatchArgs(
    state,
    state.manifestSigningDispatch.requestId,
  );
  state = await continueProtectedWorkflowDispatch(state, {
    stateKey: 'manifestSigningDispatch',
    workflowStateKey: 'manifestSigning',
    label: 'dispatch_manifest_signing',
    dispatchArgs,
  });
  if (!fs.existsSync(manifestPath)) {
    const signArgs = [
      path.join(root, 'scripts', 'request-release-manifest-signature.sh'),
      runtimeSha,
      state.rcRunId,
      root,
    ];
    if (state.contractScope === 'backend_only') {
      signArgs.push('--backend-only');
    } else {
      const compatibilityPath = value('--ios-attestation', state.iosEvidence?.compatibilityPath || '');
      const distributionPath = value('--ios-distribution-attestation', state.iosEvidence?.distributionPath || '');
      if (!compatibilityPath || !distributionPath) fail('checkpoint iOS evidence paths are unavailable', 64);
      signArgs.push(
        '--includes-ios',
        '--ios-attestation', compatibilityPath,
        '--ios-distribution-attestation', distributionPath,
      );
    }
    signArgs.push(
      '--request-id', state.manifestSigningDispatch.requestId,
      '--run-id', state.manifestSigningDispatch.runId,
    );
    state = await runStep(state, 'trusted_signing', 'bash', signArgs);
  }
}

state = await runStep(state, 'validate_signed_manifest', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'status',
  '--manifest', manifestPath,
]);

let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { fail('signed release manifest is invalid JSON'); }
const artifactDigest = manifest?.payload?.artifact?.digest;
if (!/^[a-f0-9]{64}$/u.test(artifactDigest || '')) fail('signed release manifest artifact digest is invalid');
if (manifest?.payload?.runtimeSha !== runtimeSha || manifest?.payload?.packageVersion !== packageVersion) {
  fail('signed release manifest source or package version identity mismatch');
}
const signedManifestSha256 = sha256File(manifestPath);
if (recordedManifestIdentity
    && (recordedManifestIdentity.sha256 !== signedManifestSha256
      || recordedManifestIdentity.artifactDigest !== artifactDigest)) {
  fail('signed release manifest identity drifted after it was checkpointed');
}
if (state.manifestSigningDispatch) {
  const runView = validateProtectedWorkflowRun(
    state.manifestSigningDispatch.runId,
    state.manifestSigningDispatch,
    true,
  );
  state = writeCheckpoint({
    ...state,
    manifestSigningDispatch: {
      ...state.manifestSigningDispatch,
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
    workflows: {
      ...state.workflows,
      manifestSigning: {
        ...state.workflows.manifestSigning,
        runUrl: runView.url,
        conclusion: runView.conclusion,
      },
    },
  });
}
state = writeCheckpoint({
  ...state,
  phase: 'signed',
  nextAction: 'stage_exact_artifact',
  signedManifest: path.relative(root, manifestPath),
  signedManifestIdentity: recordedManifestIdentity || {
    path: manifestPath,
    sha256: signedManifestSha256,
    artifactDigest,
  },
  signedManifestSha256,
  artifactDigest,
});
const suppliedStagingAttestationPath = value('--staging-attestation');
const recordedStagingIdentity = state.stagingAttestationIdentity || null;
const stagingAttestationPath = path.resolve(root, suppliedStagingAttestationPath
  || recordedStagingIdentity?.path
  || path.join('.local', 'release', 'staging', `${runtimeSha}-${artifactDigest}.signed.json`));
if (recordedStagingIdentity && stagingAttestationPath !== path.resolve(recordedStagingIdentity.path)) {
  fail('staging attestation path differs from the checkpoint identity', 64);
}
if (recordedStagingIdentity) {
  if (!fs.existsSync(stagingAttestationPath)
      || sha256File(stagingAttestationPath) !== recordedStagingIdentity.sha256
      || recordedStagingIdentity.installedRuntimeDigest !== state.installedRuntimeDigest
      || recordedStagingIdentity.sha256 !== state.stagingAttestationSha256) {
    fail('staging attestation identity drifted after it was checkpointed');
  }
}

const stagingRequestPath = path.join(
  root,
  '.local',
  'release',
  'staging',
  `${runtimeSha}-${artifactDigest}.request.json`,
);
if (!fs.existsSync(stagingAttestationPath)) {
  if (!state.stagingAttempt) {
    const stagingRequestId = deterministicUuid(
      `nexus.staging-attestation-request.v1:${state.repository}:${runtimeSha}:${artifactDigest}:${signedManifestSha256}`,
    );
    state = writeCheckpoint({
      ...state,
      phase: 'staging_intent',
      nextAction: 'stage_exact_artifact_without_signing',
      stagingAttempt: {
        schema: 'nexus.staging-attempt.v1',
        status: 'intent_persisted',
        requestId: stagingRequestId,
        runtimeSha,
        artifactDigest,
        releaseManifestSha256: signedManifestSha256,
        requestPath: stagingRequestPath,
      },
    });
  }
  const attempt = state.stagingAttempt;
  if (attempt?.schema !== 'nexus.staging-attempt.v1'
      || attempt.runtimeSha !== runtimeSha
      || attempt.artifactDigest !== artifactDigest
      || attempt.releaseManifestSha256 !== signedManifestSha256
      || attempt.requestPath !== stagingRequestPath
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(attempt.requestId || '')
      || !['intent_persisted', 'deploy_started', 'request_ready'].includes(attempt.status)) {
    fail('staging attempt checkpoint identity is invalid', 64);
  }
  let requestIdentity = null;
  if (attempt.status === 'request_ready') {
    requestIdentity = stagingRequestIdentity(stagingRequestPath, {
      requestId: attempt.requestId,
      artifactDigest,
      releaseManifestSha256: signedManifestSha256,
      sha256: attempt.requestSha256,
      sizeBytes: attempt.requestSizeBytes,
    });
  } else {
    state = writeCheckpoint({
      ...state,
      phase: 'staging_deploy_started',
      nextAction: 'stage_exact_artifact_without_signing',
      stagingAttempt: {
        ...attempt,
        status: 'deploy_started',
        deployStartedAt: attempt.deployStartedAt || new Date().toISOString(),
      },
    });
    state = await runStep(state, 'stage_exact_artifact', 'bash', [
      path.join(root, 'scripts', 'release-operator.sh'),
      'staging',
      '--manifest', manifestPath,
      '--no-sign-request',
      '--request-id', state.stagingAttempt.requestId,
      '--coordinator-checkpoint', checkpointPath,
    ]);
    requestIdentity = stagingRequestIdentity(stagingRequestPath, {
      requestId: state.stagingAttempt.requestId,
      artifactDigest,
      releaseManifestSha256: signedManifestSha256,
    });
    state = writeCheckpoint({
      ...state,
      phase: 'staging_request_ready',
      nextAction: 'dispatch_staging_signing_once',
      stagingAttempt: {
        ...state.stagingAttempt,
        status: 'request_ready',
        requestSha256: requestIdentity.sha256,
        requestSizeBytes: requestIdentity.sizeBytes,
        installedRuntimeDigest: requestIdentity.installedRuntimeDigest,
        recoveryRuntimeDigest: requestIdentity.recoveryRuntimeDigest,
        requestReadyAt: new Date().toISOString(),
      },
    });
  }
  if (!state.stagingSigningDispatch) {
    const dispatchArgs = stagingSigningDispatchArgs(requestIdentity);
    state = writeCheckpoint({
      ...state,
      phase: 'staging_signing_dispatch_intent',
      nextAction: 'dispatch_staging_signing_once',
      stagingSigningDispatch: newProtectedWorkflowIntent({
        workflow: 'sign-staging-attestation.yml',
        workflowName: 'Release — Sign staging attestation',
        expectedTitle: `Sign staging_attestation ${requestIdentity.requestId} digest ${requestIdentity.sha256}`,
        requestId: requestIdentity.requestId,
        dispatchArgs,
        extra: {
          requestSha256: requestIdentity.sha256,
          artifactDigest,
          releaseManifestSha256: signedManifestSha256,
        },
      }),
    });
  }
  requestIdentity = stagingRequestIdentity(stagingRequestPath, {
    requestId: state.stagingSigningDispatch.requestId,
    artifactDigest,
    releaseManifestSha256: signedManifestSha256,
    sha256: state.stagingSigningDispatch.requestSha256,
    sizeBytes: state.stagingAttempt.requestSizeBytes,
  });
  const stagingDispatchArgs = stagingSigningDispatchArgs(requestIdentity);
  state = await continueProtectedWorkflowDispatch(state, {
    stateKey: 'stagingSigningDispatch',
    workflowStateKey: 'stagingSigning',
    label: 'dispatch_staging_signing',
    dispatchArgs: stagingDispatchArgs,
  });
  if (!fs.existsSync(stagingAttestationPath)) {
    state = await runStep(state, 'trusted_staging_signing', 'bash', [
      path.join(root, 'scripts', 'request-staging-attestation.sh'),
      stagingRequestPath,
      manifestPath,
      stagingAttestationPath,
      '--run-id', state.stagingSigningDispatch.runId,
    ]);
  }
}
state = await runStep(state, 'validate_staging_attestation', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'status',
  '--manifest', manifestPath,
  '--staging-attestation', stagingAttestationPath,
], { ...process.env, NEXUS_RELEASE_STATUS_REQUIRE_STAGING: '1' });
let stagingAttestation;
try { stagingAttestation = JSON.parse(fs.readFileSync(stagingAttestationPath, 'utf8')); } catch {
  fail('signed staging attestation is invalid JSON');
}
const finalStagingRequestIdentity = stagingRequestIdentity(stagingRequestPath, {
  requestId: state.stagingAttempt?.requestId,
  artifactDigest,
  releaseManifestSha256: signedManifestSha256,
  sha256: state.stagingAttempt?.requestSha256,
  sizeBytes: state.stagingAttempt?.requestSizeBytes,
});
const installedRuntimeDigest = stagingAttestation?.payload?.installedRuntimeDigest;
const recoveryRuntimeDigest = stagingAttestation?.payload?.recoveryRuntimeDigest;
if (!/^[a-f0-9]{64}$/u.test(installedRuntimeDigest || '')
    || !/^[a-f0-9]{64}$/u.test(recoveryRuntimeDigest || '')
    || stagingAttestation?.payload?.runtimeSha !== runtimeSha
    || stagingAttestation?.payload?.artifactDigest !== artifactDigest
    || stagingAttestation?.payload?.releaseManifestSha256 !== signedManifestSha256
    || stagingAttestation?.payload?.requestId !== state.stagingAttempt?.requestId
    || installedRuntimeDigest !== state.stagingAttempt?.installedRuntimeDigest
    || recoveryRuntimeDigest !== state.stagingAttempt?.recoveryRuntimeDigest
    || state.stagingSigningDispatch?.requestSha256 !== finalStagingRequestIdentity.sha256
    || canonicalJson(stagingAttestation?.payload)
      !== canonicalJson(finalStagingRequestIdentity.request)) {
  fail('signed staging attestation installed-tree identity is invalid');
}
const stagingAttestationSha256 = sha256File(stagingAttestationPath);
if (recordedStagingIdentity
    && (recordedStagingIdentity.sha256 !== stagingAttestationSha256
      || recordedStagingIdentity.installedRuntimeDigest !== installedRuntimeDigest
      || recordedStagingIdentity.recoveryRuntimeDigest !== recoveryRuntimeDigest)) {
  fail('staging attestation identity drifted after it was checkpointed');
}
if (state.stagingSigningDispatch) {
  const runView = validateProtectedWorkflowRun(
    state.stagingSigningDispatch.runId,
    state.stagingSigningDispatch,
    true,
  );
  state = writeCheckpoint({
    ...state,
    stagingSigningDispatch: {
      ...state.stagingSigningDispatch,
      status: 'completed',
      completedAt: new Date().toISOString(),
    },
    workflows: {
      ...state.workflows,
      stagingSigning: {
        ...state.workflows.stagingSigning,
        runUrl: runView.url,
        conclusion: runView.conclusion,
      },
    },
  });
}
state = writeCheckpoint({
  ...state,
  phase: 'owner_stop',
  nextAction: 'explicit_owner_authorization_required',
  stagingAttestation: path.relative(root, stagingAttestationPath),
  stagingAttestationIdentity: recordedStagingIdentity || {
    path: stagingAttestationPath,
    sha256: stagingAttestationSha256,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
  },
  stagingAttestationSha256,
  installedRuntimeDigest,
  recoveryRuntimeDigest,
  ownerStopReachedAt: state.ownerStopReachedAt || new Date().toISOString(),
});

if (!ownerStopPersistedAtProcessStart) {
  emit(state, { manualRequired: true, reason: 'owner_stop_requires_new_invocation' }, 3);
}
if (!has('--owner-authorized')) {
  emit(state, { manualRequired: true, reason: 'owner_authorization_not_automatic' }, 3);
}
if (process.env.NEXUS_RELEASE_OWNER_AUTHORIZED !== '1') {
  fail('--owner-authorized also requires NEXUS_RELEASE_OWNER_AUTHORIZED=1 in the current invocation');
}
state = writeCheckpoint({
  ...state,
  phase: 'owner_authorized_for_current_invocation',
  nextAction: 'explicit_promote_flag_required',
  ownerAuthorizationObservedAt: new Date().toISOString(),
});
if (!has('--promote')) {
  emit(state, { manualRequired: true, reason: 'promotion_not_requested' }, 3);
}

const productionEvidence = path.join(
  root,
  '.local',
  'release',
  'production',
  `${runtimeSha}-${artifactDigest}.json`,
);
state = await runStep(state, 'promote_exact_artifact', 'bash', [
  path.join(root, 'scripts', 'release-operator.sh'),
  'promote',
  '--manifest', manifestPath,
  '--staging-attestation', stagingAttestationPath,
], process.env);
let production;
try { production = JSON.parse(fs.readFileSync(productionEvidence, 'utf8')); } catch {
  fail('production promotion evidence is missing or invalid after promotion');
}
if (!productionEvidenceMatches(production, {
  runtimeSha,
  artifactDigest,
  installedRuntimeDigest,
  recoveryRuntimeDigest,
  releaseManifestSha256: signedManifestSha256,
  stagingAttestationSha256,
  packageVersion,
})) {
  fail('production promotion evidence does not match the checkpoint identity');
}
state = writeCheckpoint({
  ...state,
  phase: 'promoted',
  nextAction: null,
  productionEvidence: path.relative(root, productionEvidence),
  productionEvidenceIdentity: {
    path: productionEvidence,
    sha256: sha256File(productionEvidence),
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    recoveryRuntimeDigest,
    releaseManifestSha256: signedManifestSha256,
    stagingAttestationSha256,
    packageVersion,
    transactionId: production.transactionId,
    backupSha256: production.backupSha256,
    rollbackEscrowEvidenceSha256: production.rollbackEscrow.evidenceSha256,
  },
  promotedAt: production.completedAt || new Date().toISOString(),
});
emit(state);
