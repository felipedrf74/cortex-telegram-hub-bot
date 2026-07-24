#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const PRODUCTION_JOURNAL = '/var/lib/nexus-release/ollama-install/install-in-progress.v1.json';
const PRODUCTION_DROP_IN = '/etc/systemd/system/ollama.service.d/override.conf';

function fail(message) {
  process.stderr.write(`ollama_install_state_blocked: ${message}\n`);
  process.exit(1);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${label} has an unexpected schema`);
  }
}

function expectedUid() {
  return process.env.NEXUS_OLLAMA_INSTALL_TEST_MODE === '1'
    ? process.getuid?.()
    : 0;
}

function secureRegularFile(path, label, expectedMode) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) {
    fail(`${label} path is not canonical`);
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} is not a regular file`);
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path traverses a symlink`);
  const owner = expectedUid();
  if (Number.isInteger(owner) && info.uid !== owner) {
    fail(`${label} has the wrong owner`);
  }
  if ((info.mode & 0o777) !== expectedMode) fail(`${label} has the wrong mode`);
  return info;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function fsyncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function secureDirectory(path, label, expectedMode) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) {
    fail(`${label} path is not canonical`);
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path) {
    fail(`${label} is not a secure directory`);
  }
  if (Number.isInteger(expectedUid()) && info.uid !== expectedUid()) {
    fail(`${label} has the wrong owner`);
  }
  if ((info.mode & 0o777) !== expectedMode) fail(`${label} has the wrong mode`);
}

function atomicWrite(path, value) {
  const parent = dirname(path);
  const temporary = join(parent, `.nexus-ollama-guard.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(temporary, 0o600);
  chownSync(
    temporary,
    Number.isInteger(expectedUid()) ? expectedUid() : process.getuid(),
    process.getgid(),
  );
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(parent);
}

function bootId(procRoot) {
  const value = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    fail('Linux boot ID is malformed');
  }
  return value;
}

function processStartTicks(procRoot, pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail('installer PID is invalid');
  let stat;
  try {
    stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  } catch (error) {
    if (process.env.NEXUS_OLLAMA_INSTALL_TEST_MODE !== '1' || error?.code !== 'ENOENT') {
      throw error;
    }
    const synthetic = process.env.NEXUS_OLLAMA_INSTALL_TEST_PROCESS_START_TICKS;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(synthetic || '')) throw error;
    try {
      process.kill(pid, 0);
    } catch {
      fail('installer process is not live');
    }
    return synthetic;
  }
  const close = stat.lastIndexOf(')');
  if (close < 1) fail('installer process identity is malformed');
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(startTicks || '')) {
    fail('installer process start ticks are malformed');
  }
  return startTicks;
}

const testMode = process.env.NEXUS_OLLAMA_INSTALL_TEST_MODE === '1';
const journal = testMode && process.env.NEXUS_OLLAMA_INSTALL_JOURNAL
  ? resolve(process.env.NEXUS_OLLAMA_INSTALL_JOURNAL)
  : PRODUCTION_JOURNAL;
const dropIn = testMode && process.env.NEXUS_OLLAMA_DROP_IN_PATH
  ? resolve(process.env.NEXUS_OLLAMA_DROP_IN_PATH)
  : PRODUCTION_DROP_IN;
const procRoot = testMode && process.env.NEXUS_OLLAMA_PROC_ROOT
  ? resolve(process.env.NEXUS_OLLAMA_PROC_ROOT)
  : '/proc';

try {
  secureRegularFile(journal, 'Ollama install journal', 0o600);
} catch (error) {
  if (error?.code === 'ENOENT') process.exit(0);
  throw error;
}

secureDirectory(dirname(journal), 'Ollama install journal directory', 0o700);
let value;
try {
  value = JSON.parse(readFileSync(journal, 'utf8'));
} catch {
  fail('Ollama install journal is malformed');
}
exactKeys(value, [
  'schema',
  'status',
  'transactionId',
  'target',
  'candidateSha256',
  'sourceProvenance',
  'runtimeIdentity',
  'assets',
  'backup',
  'priorService',
  'priorReceipt',
  'startedAt',
  'restartAuthorization',
  'terminalResult',
], 'Ollama install journal');
exactKeys(
  value.sourceProvenance,
  ['sourceRoot', 'sourceSha', 'archiveSha256'],
  'Ollama source provenance',
);
exactKeys(value.runtimeIdentity, [
  'binaryPath',
  'binarySha256',
  'version',
  'serviceFragment',
  'serviceFragmentSha256',
  'retainedModel',
  'retainedModelDigest',
], 'Ollama runtime identity');
exactKeys(value.backup, ['existed', 'path', 'sha256', 'mode', 'uid', 'gid'], 'drop-in backup');
exactKeys(value.priorService, ['activeState', 'enabledState'], 'prior service state');
exactKeys(value.priorReceipt, ['existed', 'path', 'sha256'], 'prior receipt backup');
if (value.schema !== 'nexus.ollama-systemd-install-journal.v1'
    || ![
      'restart_authorized',
      'rollback_authorized',
      'rollback_absent_authorized',
      'rollback_absent_consumed',
      'commit_complete',
      'rollback_complete',
    ].includes(value.status)
    || !/^[0-9a-f-]{36}$/u.test(value.transactionId || '')
    || value.target !== dropIn
    || !/^[0-9a-f]{64}$/u.test(value.candidateSha256 || '')
    || !/^[0-9a-f]{40}$/u.test(value.sourceProvenance.sourceSha || '')
    || !/^[0-9a-f]{64}$/u.test(value.sourceProvenance.archiveSha256 || '')
    || !Array.isArray(value.assets)
    || !/^[0-9a-f]{64}$/u.test(value.runtimeIdentity.binarySha256 || '')
    || !/^[0-9a-f]{64}$/u.test(value.runtimeIdentity.serviceFragmentSha256 || '')
    || !/^[0-9a-f]{64}$/u.test(value.runtimeIdentity.retainedModelDigest || '')
    || (!testMode && value.sourceProvenance.sourceRoot
      !== `/var/lib/nexus-release-bootstrap/${value.sourceProvenance.sourceSha}/source`)) {
  fail('Ollama installation is incomplete or its candidate identity changed');
}
if (!testMode) {
  if (value.runtimeIdentity.binaryPath !== '/usr/local/bin/ollama'
      || value.runtimeIdentity.binarySha256
        !== 'b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9'
      || value.runtimeIdentity.version !== 'ollama version is 0.24.0'
      || value.runtimeIdentity.serviceFragment !== '/etc/systemd/system/ollama.service'
      || value.runtimeIdentity.serviceFragmentSha256
        !== '72b23db27bcd69aa9c05226285a928ae8520dac108736072a33cea35bbcccdda'
      || value.runtimeIdentity.retainedModel !== 'qwen2.5:3b-instruct-q4_K_M'
      || value.runtimeIdentity.retainedModelDigest
        !== '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b') {
    fail('Ollama runtime identity differs from the reviewed transition');
  }
  const binaryInfo = secureRegularFile(
    value.runtimeIdentity.binaryPath,
    'Ollama binary',
    0o755,
  );
  const fragmentInfo = secureRegularFile(
    value.runtimeIdentity.serviceFragment,
    'Ollama service fragment',
    0o644,
  );
  if (binaryInfo.gid !== 0 || fragmentInfo.gid !== 0
      || sha256(value.runtimeIdentity.binaryPath) !== value.runtimeIdentity.binarySha256
      || sha256(value.runtimeIdentity.serviceFragment)
        !== value.runtimeIdentity.serviceFragmentSha256) {
    fail('Ollama runtime binary or service fragment digest changed');
  }
}

// The target parent is checked after the journal so a replaced directory
// cannot turn a missing marker into implicit authorization.
const parent = dirname(dropIn);
const expectedParentMode = testMode ? 0o700 : 0o755;
secureDirectory(parent, 'Ollama systemd drop-in parent', expectedParentMode);

function validatePresentTarget(expectedSha256, expectedMode, label) {
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256 || '')
      || !Number.isSafeInteger(expectedMode)
      || expectedMode < 0
      || expectedMode > 0o777
      || (expectedMode & 0o022) !== 0) {
    fail(`${label} identity is invalid`);
  }
  secureRegularFile(dropIn, label, expectedMode);
  if (sha256(dropIn) !== expectedSha256) fail(`${label} digest changed`);
}

function validateAbsentTarget() {
  if (pathExists(dropIn)) fail('absent Ollama rollback predecessor unexpectedly exists');
}

if (value.status === 'commit_complete' || value.status === 'rollback_complete') {
  if (value.restartAuthorization !== null) {
    fail('terminal Ollama install journal retained live restart authorization');
  }
  exactKeys(
    value.terminalResult,
    ['kind', 'path', 'sha256', 'completedAt'],
    'terminal Ollama result',
  );
  const kind = value.status === 'commit_complete' ? 'commit' : 'rollback';
  const expectedResultPath = join(
    dirname(journal),
    kind === 'commit' ? 'install-receipt.v1.json' : 'last-rollback.v1.json',
  );
  if (value.terminalResult.kind !== kind
      || value.terminalResult.path !== expectedResultPath
      || !/^[0-9a-f]{64}$/u.test(value.terminalResult.sha256 || '')
      || !Number.isFinite(Date.parse(value.terminalResult.completedAt || ''))) {
    fail('terminal Ollama result identity is invalid');
  }
  secureRegularFile(expectedResultPath, `terminal Ollama ${kind} result`, 0o600);
  if (sha256(expectedResultPath) !== value.terminalResult.sha256) {
    fail(`terminal Ollama ${kind} result digest changed`);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(expectedResultPath, 'utf8'));
  } catch {
    fail(`terminal Ollama ${kind} result is malformed`);
  }
  if (kind === 'commit') {
    if (result?.schema !== 'nexus.ollama-systemd-install-receipt.v1'
        || result.status !== 'complete'
        || result.transactionId !== value.transactionId
        || result.candidateSha256 !== value.candidateSha256) {
      fail('terminal Ollama receipt does not match its transaction');
    }
    validatePresentTarget(value.candidateSha256, 0o644, 'terminal committed Ollama drop-in');
  } else {
    if (result?.schema !== 'nexus.ollama-systemd-install-rollback.v1'
        || result.status !== 'complete'
        || result.transactionId !== value.transactionId) {
      fail('terminal Ollama rollback result does not match its transaction');
    }
    if (value.backup.existed) {
      validatePresentTarget(
        value.backup.sha256,
        value.backup.mode,
        'terminal restored Ollama drop-in',
      );
    } else {
      validateAbsentTarget();
    }
  }
  process.exit(0);
}

if (value.terminalResult !== null) fail('non-terminal Ollama journal declares a terminal result');
exactKeys(value.restartAuthorization, [
  'purpose',
  'transactionId',
  'bootId',
  'installerPid',
  'installerStartTicks',
  'candidateSha256',
  'target',
  'consumptionPath',
  'authorizedAt',
  'consumedAt',
], 'restart authorization');
exactKeys(
  value.restartAuthorization.target,
  ['existed', 'sha256', 'mode'],
  'authorized restart target',
);
const authorization = value.restartAuthorization;
if (authorization.transactionId !== value.transactionId
    || authorization.candidateSha256 !== value.candidateSha256
    || authorization.bootId !== bootId(procRoot)
    || String(processStartTicks(procRoot, authorization.installerPid))
      !== String(authorization.installerStartTicks)) {
  fail('Ollama restart is not owned by the live installing process on this boot');
}

if (value.status === 'restart_authorized') {
  if (authorization.purpose !== 'install_candidate'
      || authorization.consumptionPath !== null
      || authorization.consumedAt !== null
      || authorization.target.existed !== true
      || authorization.target.sha256 !== value.candidateSha256
      || authorization.target.mode !== 0o644) {
    fail('candidate Ollama restart authorization is invalid');
  }
  validatePresentTarget(value.candidateSha256, 0o644, 'candidate Ollama systemd drop-in');
} else if (value.status === 'rollback_authorized') {
  if (authorization.purpose !== 'rollback_present_predecessor'
      || authorization.consumptionPath !== null
      || authorization.consumedAt !== null
      || value.backup.existed !== true
      || authorization.target.existed !== true
      || authorization.target.sha256 !== value.backup.sha256
      || authorization.target.mode !== value.backup.mode) {
    fail('Ollama rollback predecessor authorization is invalid');
  }
  validatePresentTarget(
    value.backup.sha256,
    value.backup.mode,
    'rollback predecessor Ollama systemd drop-in',
  );
} else if (value.status === 'rollback_absent_consumed') {
  fail('absent-predecessor rollback restart authorization was already consumed');
} else {
  const expectedConsumptionPath = join(
    dirname(journal),
    `${value.transactionId}.rollback-absent-restart-consumed.v1.json`,
  );
  if (authorization.purpose !== 'rollback_absent_predecessor'
      || value.backup.existed !== false
      || authorization.target.existed !== false
      || authorization.target.sha256 !== null
      || authorization.target.mode !== null
      || authorization.consumptionPath !== expectedConsumptionPath
      || authorization.consumedAt !== null) {
    fail('absent-predecessor rollback authorization is invalid');
  }
  validateAbsentTarget();
  const consumption = {
    schema: 'nexus.ollama-rollback-absent-restart-consumption.v1',
    transactionId: value.transactionId,
    candidateSha256: value.candidateSha256,
    bootId: authorization.bootId,
    installerPid: authorization.installerPid,
    installerStartTicks: String(authorization.installerStartTicks),
    consumedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(expectedConsumptionPath, `${JSON.stringify(consumption)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('absent-predecessor rollback restart authorization was already consumed');
    }
    throw error;
  }
  chmodSync(expectedConsumptionPath, 0o600);
  chownSync(
    expectedConsumptionPath,
    Number.isInteger(expectedUid()) ? expectedUid() : process.getuid(),
    process.getgid(),
  );
  fsyncPath(expectedConsumptionPath);
  fsyncPath(dirname(expectedConsumptionPath));
  value.status = 'rollback_absent_consumed';
  value.restartAuthorization.consumedAt = consumption.consumedAt;
  atomicWrite(journal, value);
}
