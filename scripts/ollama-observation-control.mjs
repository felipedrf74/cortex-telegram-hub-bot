#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALLED_CONTROL = '/usr/local/sbin/nexus-ollama-observation-control.mjs';
const STATE_ROOT = '/var/lib/nexus-release/ollama-observation-control';
const OBSERVATION_ROOT = '/var/lib/nexus-release/ollama-observations';
const SHARED_MUTEX = '/run/lock/nexus-release-sonar.lock';
const COLLECTOR = '/usr/local/sbin/nexus-ollama-observation-collector.mjs';
const SYSTEMCTL = '/usr/bin/systemctl';
const RUNUSER = '/usr/sbin/runuser';
const PM2 = '/home/dominguez/.npm-global/bin/pm2';
const SONAR_STATE = '/usr/local/sbin/quality-sonar-release-state';
const REBOOT_REQUIRED = '/var/run/reboot-required';
const RELEASE_LOCKS = Object.freeze([
  '/home/dominguez/telegram-hub-bot/.local/release/locks/prod-deploy.lock',
  '/home/dominguez/telegram-hub-bot-staging/.local/release/locks/staging-deploy.lock',
]);
const PM2_NAMES = Object.freeze({
  staging: ['content-engine-staging', 'nexus-hub-staging'],
  production: ['content-engine', 'nexus-hub'],
  zero_swap: ['content-engine', 'nexus-hub'],
});
const REQUEST_SCHEMA = 'nexus.ollama-observation-launch-request.v1';
const JOURNAL_SCHEMA = 'nexus.ollama-observation-systemd-journal.v1';
const MAX_BYTES = 4 * 1024 * 1024;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function testMode() {
  return process.env.NEXUS_OLLAMA_OBSERVATION_CONTROL_TEST_MODE === '1';
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function fsyncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function expectedUid() {
  return testMode() ? process.getuid?.() : 0;
}

function expectedGid() {
  return testMode() ? process.getgid?.() : 0;
}

function secureDirectory(path, label, { create = false, mode = 0o700 } = {}) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) fail(`${label} path is unsafe`);
  if (create && !existsSync(path)) {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
    chownSync(path, expectedUid(), expectedGid());
  }
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path traverses a symlink`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a directory`);
  if (Number.isInteger(expectedUid()) && info.uid !== expectedUid()) fail(`${label} has the wrong owner`);
  if ((info.mode & 0o777) !== mode) fail(`${label} must have mode ${mode.toString(8)}`);
}

function secureFile(path, label, {
  mode = 0o600,
  owner = expectedUid(),
  maximum = MAX_BYTES,
} = {}) {
  if (!isAbsolute(path) || resolve(path) !== path) fail(`${label} path is not canonical`);
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path traverses a symlink`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (Number.isInteger(owner) && info.uid !== owner) fail(`${label} has the wrong owner`);
  if (mode !== null && (info.mode & 0o777) !== mode) fail(`${label} has the wrong mode`);
  if (info.size > maximum) fail(`${label} is too large`);
  return info;
}

function atomicWrite(path, value, { exclusive = false } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const parent = dirname(path);
  if (exclusive) {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600);
    chownSync(path, expectedUid(), expectedGid());
    fsyncPath(path);
    fsyncPath(parent);
    return sha256(bytes);
  }
  const temporary = join(parent, `.nexus-ollama-observation.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
  chmodSync(temporary, 0o600);
  chownSync(temporary, expectedUid(), expectedGid());
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(parent);
  return sha256(bytes);
}

function durableRemove(path) {
  rmSync(path, { force: true });
  fsyncPath(dirname(path));
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${label} has an unexpected schema`);
  }
}

function readJson(path, label) {
  secureFile(path, label);
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    fail(`${label} is malformed`);
  }
  return { value, bytes, digest: sha256(bytes) };
}

function command(executable, args, label, {
  accepted = [0],
  env = process.env,
  timeout = 30_000,
} = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer: MAX_BYTES,
    env,
  });
  if (result.error || result.signal || !accepted.includes(result.status)) {
    fail(`${label} failed`);
  }
  return (result.stdout || '').trim();
}

function paths() {
  const stateRoot = testMode() && process.env.NEXUS_OLLAMA_OBSERVATION_STATE_ROOT
    ? resolve(process.env.NEXUS_OLLAMA_OBSERVATION_STATE_ROOT)
    : STATE_ROOT;
  const observationRoot = testMode() && process.env.NEXUS_OLLAMA_OBSERVATION_ROOT
    ? resolve(process.env.NEXUS_OLLAMA_OBSERVATION_ROOT)
    : OBSERVATION_ROOT;
  const mutex = testMode() && process.env.NEXUS_OLLAMA_SHARED_MUTEX
    ? resolve(process.env.NEXUS_OLLAMA_SHARED_MUTEX)
    : SHARED_MUTEX;
  const rebootRequired = testMode() && process.env.NEXUS_OLLAMA_REBOOT_REQUIRED_PATH
    ? resolve(process.env.NEXUS_OLLAMA_REBOOT_REQUIRED_PATH)
    : REBOOT_REQUIRED;
  secureDirectory(stateRoot, 'observation control state root', { create: true });
  secureDirectory(observationRoot, 'observation evidence root');
  const resolved = {
    stateRoot,
    requests: join(stateRoot, 'requests'),
    active: join(stateRoot, 'active.json'),
    observationRoot,
    mutex,
    rebootRequired,
    systemctl: testMode() && process.env.NEXUS_OLLAMA_SYSTEMCTL_BIN
      ? resolve(process.env.NEXUS_OLLAMA_SYSTEMCTL_BIN)
      : SYSTEMCTL,
    runuser: testMode() && process.env.NEXUS_OLLAMA_RUNUSER_BIN
      ? resolve(process.env.NEXUS_OLLAMA_RUNUSER_BIN)
      : RUNUSER,
    pm2: testMode() && process.env.NEXUS_OLLAMA_PM2_BIN
      ? resolve(process.env.NEXUS_OLLAMA_PM2_BIN)
      : PM2,
    collector: testMode() && process.env.NEXUS_OLLAMA_COLLECTOR_BIN
      ? resolve(process.env.NEXUS_OLLAMA_COLLECTOR_BIN)
      : COLLECTOR,
    flock: testMode() && process.env.NEXUS_OLLAMA_FLOCK_BIN
      ? resolve(process.env.NEXUS_OLLAMA_FLOCK_BIN)
      : '/usr/bin/flock',
    sonarState: testMode() && process.env.NEXUS_OLLAMA_SONAR_STATE_BIN
      ? resolve(process.env.NEXUS_OLLAMA_SONAR_STATE_BIN)
      : SONAR_STATE,
  };
  secureFile(resolved.systemctl, 'systemctl executable', { mode: null, owner: null });
  secureFile(resolved.pm2, 'PM2 executable', { mode: null, owner: null });
  secureFile(resolved.collector, 'Ollama collector executable', {
    mode: testMode() ? null : 0o700,
    owner: expectedUid(),
  });
  secureFile(resolved.flock, 'flock executable', { mode: null, owner: null });
  if (!testMode()) secureFile(resolved.runuser, 'runuser executable', { mode: null, owner: 0 });
  return resolved;
}

function requestDirectory(options, requestId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId)) {
    fail('observation request ID is invalid', 64);
  }
  return join(options.requests, requestId);
}

function readRequest(options, requestId) {
  const directory = requestDirectory(options, requestId);
  secureDirectory(directory, 'observation request directory');
  const file = readJson(join(directory, 'request.json'), 'observation request');
  exactKeys(file.value, [
    'schema',
    'requestId',
    'phase',
    'runtimeSha',
    'previousEvidence',
    'requestedAt',
  ], 'observation request');
  if (file.value.schema !== REQUEST_SCHEMA || file.value.requestId !== requestId
      || !['staging', 'production', 'zero_swap'].includes(file.value.phase)
      || !/^[0-9a-f]{40}$/u.test(file.value.runtimeSha || '')) {
    fail('observation request identity is invalid');
  }
  validatePreviousEvidence(options, file.value.phase, file.value.previousEvidence);
  return { ...file, directory };
}

function journalPath(options, requestId) {
  return join(requestDirectory(options, requestId), 'journal.json');
}

function writeJournal(options, request, status, phase, extra = {}) {
  const journal = {
    schema: JOURNAL_SCHEMA,
    requestId: request.value.requestId,
    requestSha256: request.digest,
    observationPhase: request.value.phase,
    runtimeSha: request.value.runtimeSha,
    status,
    phase,
    updatedAt: new Date().toISOString(),
    bootId: extra.bootId ?? null,
    result: extra.result ?? null,
    failureReason: extra.failureReason ?? null,
  };
  atomicWrite(journalPath(options, request.value.requestId), journal);
  return journal;
}

function readJournal(options, requestId) {
  const request = readRequest(options, requestId);
  const file = readJson(journalPath(options, requestId), 'observation systemd journal');
  exactKeys(file.value, [
    'schema',
    'requestId',
    'requestSha256',
    'observationPhase',
    'runtimeSha',
    'status',
    'phase',
    'updatedAt',
    'bootId',
    'result',
    'failureReason',
  ], 'observation systemd journal');
  if (file.value.schema !== JOURNAL_SCHEMA
      || file.value.requestId !== requestId
      || file.value.requestSha256 !== request.digest
      || file.value.observationPhase !== request.value.phase
      || file.value.runtimeSha !== request.value.runtimeSha
      || !['pending', 'running', 'completed', 'failed'].includes(file.value.status)) {
    fail('observation systemd journal identity is invalid');
  }
  return { request, journal: file.value };
}

function controlRequestBinding(value, label) {
  exactKeys(value, ['requestId', 'requestSha256', 'runtimeSha'], label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    .test(value.requestId || '')
      || !/^sha256:[0-9a-f]{64}$/u.test(value.requestSha256 || '')
      || !/^[0-9a-f]{40}$/u.test(value.runtimeSha || '')) {
    fail(`${label} identity is invalid`);
  }
  return {
    requestId: value.requestId,
    requestSha256: value.requestSha256,
    runtimeSha: value.runtimeSha,
  };
}

function previousControlRequestFromFile(phase, file) {
  if (phase === 'production') {
    if (file.value?.schema !== 'nexus.ollama-observation-collector-result.v1'
        || file.value.status !== 'complete'
        || file.value.phase !== 'staging') {
      fail('production observation previous evidence is not a completed staging result');
    }
    return controlRequestBinding(
      file.value.controlRequest,
      'staging observation control request',
    );
  }
  if (file.value?.schema !== 'nexus.ollama-large-model-cleanup-result.v1'
      || file.value.status !== 'complete') {
    fail('zero-swap previous evidence is not a completed cleanup result');
  }
  const observationControl = file.value.plan?.observationControl;
  exactKeys(observationControl, ['staging', 'production'], 'cleanup observation control');
  const staging = controlRequestBinding(
    observationControl.staging,
    'cleanup staging control request',
  );
  const production = controlRequestBinding(
    observationControl.production,
    'cleanup production control request',
  );
  if (staging.runtimeSha !== production.runtimeSha) {
    fail('cleanup control requests do not bind one exact runtime SHA');
  }
  return production;
}

function validatePreviousEvidence(options, phase, value) {
  if (phase === 'staging') {
    if (value !== null) fail('staging observation must not declare previous evidence');
    return null;
  }
  exactKeys(value, ['path', 'sha256', 'controlRequest'], 'previous observation evidence');
  if (!isAbsolute(value.path) || resolve(value.path) !== value.path
      || !/^sha256:[0-9a-f]{64}$/u.test(value.sha256 || '')) {
    fail('previous observation evidence identity is invalid');
  }
  const file = readJson(value.path, 'previous observation evidence');
  if (file.digest !== value.sha256) fail('previous observation evidence digest changed');
  const sourceControlRequest = previousControlRequestFromFile(phase, file);
  const declaredControlRequest = controlRequestBinding(
    value.controlRequest,
    'previous observation control request',
  );
  if (JSON.stringify(sourceControlRequest) !== JSON.stringify(declaredControlRequest)) {
    fail('previous observation control request binding changed');
  }
  if (phase === 'production') {
    const expectedPrefix = `${options.observationRoot}/staging-`;
    if (!value.path.startsWith(expectedPrefix) || !value.path.endsWith('/result.json')) {
      fail('production observation must reference a canonical staging result');
    }
  } else if (!testMode() && !value.path.startsWith('/var/lib/nexus-release/ollama-cleanup-')) {
    fail('zero-swap observation must reference a canonical cleanup result');
  }
  return { file, controlRequest: sourceControlRequest };
}

function readBootId() {
  const path = testMode() && process.env.NEXUS_OLLAMA_BOOT_ID_PATH
    ? resolve(process.env.NEXUS_OLLAMA_BOOT_ID_PATH)
    : '/proc/sys/kernel/random/boot_id';
  const value = readFileSync(path, 'utf8').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    fail('Linux boot ID is malformed');
  }
  return value;
}

function assertNoRelease(options) {
  if (testMode()) return;
  for (const path of RELEASE_LOCKS) {
    if (existsSync(path)) {
      const info = lstatSync(path);
      if (info.isDirectory()) fail('a staging or production release is active', 75);
      fail('release lock path has an unexpected type');
    }
  }
}

function assertNoRestartCondition(options) {
  if (existsSync(options.rebootRequired)) {
    const info = lstatSync(options.rebootRequired);
    if (info.isSymbolicLink()) fail('pending-reboot marker is a symlink');
    fail('host has a pending maintenance reboot; complete it before a 24-hour observation', 75);
  }
  const jobs = command(options.systemctl, ['list-jobs', '--no-legend', '--plain'], 'systemd job query');
  for (const line of jobs.split(/\r?\n/u).filter(Boolean)) {
    const fields = line.trim().split(/\s+/u);
    const unit = fields[1] || '';
    const operation = fields[2] || '';
    if (/^(?:ollama|pm2-.+|nexus-sonarqube|nexus-release-promotion@.+)\.service$/u.test(unit)
        && /^(?:start|stop|restart|reload)$/u.test(operation)) {
      fail(`a governed service transition is already queued: ${unit}`, 75);
    }
  }
}

function assertSonarIdle(options) {
  if (existsSync(options.sonarState)) {
    secureFile(options.sonarState, 'Sonar release-state helper', { mode: 0o755, owner: expectedUid() });
    const raw = command(
      options.sonarState,
      ['--project', 'nexus-hub-backend', '--json'],
      'Sonar Compute Engine state',
    );
    let state;
    try { state = JSON.parse(raw); } catch { fail('Sonar Compute Engine state is malformed'); }
    if (state?.schema !== 'nexus.sonarqube-release-state.v1'
        || state.status !== 'passed' || state.projectKey !== 'nexus-hub-backend'
        || state.activeTasks !== 0) {
      fail('Sonar Compute Engine is active or ambiguous', 75);
    }
  } else {
    const sonarState = command(
      options.systemctl,
      ['show', 'nexus-sonarqube.service', '--property=ActiveState', '--value', '--no-pager'],
      'Sonar service state',
      { accepted: [0, 1, 4] },
    );
    if (['active', 'activating', 'reloading', 'deactivating'].includes(sonarState)) {
      fail('Sonar is active without the reviewed project-state helper', 75);
    }
  }
}

function assertExactPm2Sha(options, phase, runtimeSha) {
  const args = testMode()
    ? ['jlist']
    : ['-u', 'dominguez', '--', options.pm2, 'jlist'];
  const executable = testMode() ? options.pm2 : options.runuser;
  const raw = command(executable, args, 'PM2 exact release state');
  let rows;
  try { rows = JSON.parse(raw); } catch { fail('PM2 exact release state is malformed'); }
  if (!Array.isArray(rows)) fail('PM2 exact release state is not an array');
  for (const name of PM2_NAMES[phase]) {
    const matches = rows.filter((row) => row?.name === name);
    const env = matches[0]?.pm2_env || {};
    if (matches.length !== 1 || env.status !== 'online'
        || (env.NEXUS_RELEASE_SHA || env.GIT_COMMIT) !== runtimeSha) {
      fail(`PM2 ${name} does not match the requested exact runtime SHA`);
    }
  }
}

function assertSharedMutex(options) {
  secureFile(options.mutex, 'shared release/Sonar/observation mutex', {
    mode: 0o660,
    owner: expectedUid(),
    maximum: 1024,
  });
  if (!testMode()) {
    const identity = command('/usr/bin/stat', ['-c', '%U:%G:%a', '--', options.mutex], 'shared mutex identity');
    if (identity !== 'root:dominguez:660') fail('shared mutex ownership is invalid');
  }
  if (process.env.NEXUS_OLLAMA_SHARED_LOCK_HELD !== '1') {
    fail('observation worker is not holding the shared host mutex', 75);
  }
}

function launch(options, parsed) {
  const phase = parsed.values.get('--phase');
  const runtimeSha = parsed.values.get('--runtime-sha');
  const previousPath = parsed.values.get('--previous-evidence');
  const previousSha = parsed.values.get('--previous-evidence-sha256');
  if (!['staging', 'production', 'zero_swap'].includes(phase || '')) {
    fail('--phase must be staging, production, or zero_swap', 64);
  }
  if (!/^[0-9a-f]{40}$/u.test(runtimeSha || '')) fail('--runtime-sha is invalid', 64);
  if (phase === 'staging' && (previousPath || previousSha)) {
    fail('staging observation does not accept previous evidence', 64);
  }
  if (phase !== 'staging' && (!previousPath || !previousSha)) {
    fail('production and zero_swap require exact previous evidence', 64);
  }
  assertNoRelease(options);
  assertNoRestartCondition(options);
  if (existsSync(options.active)) {
    const active = readJson(options.active, 'active observation marker').value;
    fail(`observation ${active?.requestId || 'unknown'} is already active`, 75);
  }
  const requestId = randomUUID();
  const directory = requestDirectory(options, requestId);
  secureDirectory(options.requests, 'observation requests root', { create: true });
  secureDirectory(directory, 'observation request directory', { create: true });
  const request = {
    schema: REQUEST_SCHEMA,
    requestId,
    phase,
    runtimeSha,
    previousEvidence: null,
    requestedAt: new Date().toISOString(),
  };
  if (phase !== 'staging') {
    const sourcePath = resolve(previousPath);
    const source = readJson(sourcePath, 'previous observation evidence');
    if (source.digest !== previousSha) fail('previous observation evidence digest changed');
    request.previousEvidence = {
      path: sourcePath,
      sha256: previousSha,
      controlRequest: previousControlRequestFromFile(phase, source),
    };
  }
  validatePreviousEvidence(options, phase, request.previousEvidence);
  const requestDigest = atomicWrite(join(directory, 'request.json'), request, { exclusive: true });
  const requestFile = { value: request, digest: requestDigest, directory };
  writeJournal(options, requestFile, 'pending', 'submitted');
  atomicWrite(options.active, { schema: 'nexus.ollama-observation-active.v1', requestId }, { exclusive: true });
  const unit = `nexus-ollama-observation@${requestId}.service`;
  try {
    command(options.systemctl, ['start', '--no-block', unit], 'durable Ollama observation start');
  } catch (error) {
    writeJournal(options, requestFile, 'failed', 'start_failed', {
      failureReason: 'systemd_start_failed',
    });
    durableRemove(options.active);
    throw error;
  }
  return { status: 'submitted', requestId, unit, requestSha256: requestDigest };
}

function runLocked(options, requestId) {
  if (process.env.NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID !== requestId) {
    fail('systemd observation request identity is missing or mismatched', 75);
  }
  assertSharedMutex(options);
  const request = readRequest(options, requestId);
  const active = readJson(options.active, 'active observation marker').value;
  if (active?.schema !== 'nexus.ollama-observation-active.v1' || active.requestId !== requestId) {
    fail('active observation marker does not match this request');
  }
  const bootId = readBootId();
  try {
    assertNoRelease(options);
    assertNoRestartCondition(options);
    assertSonarIdle(options);
    assertExactPm2Sha(options, request.value.phase, request.value.runtimeSha);
    validatePreviousEvidence(options, request.value.phase, request.value.previousEvidence);
    writeJournal(options, request, 'running', 'collecting', { bootId });
    const args = [
      '--phase', request.value.phase,
      '--output-directory', options.observationRoot,
      '--expected-runtime-sha', request.value.runtimeSha,
      '--control-request-id', request.value.requestId,
      '--control-request-sha256', request.digest,
    ];
    if (request.value.phase === 'production') {
      args.push('--previous-observation', request.value.previousEvidence.path);
    } else if (request.value.phase === 'zero_swap') {
      args.push('--cleanup-result', request.value.previousEvidence.path);
    }
    const raw = command(options.collector, args, 'root Ollama observation collector', {
      timeout: testMode() ? 30_000 : (25 * 60 * 60 * 1000),
    });
    let summary;
    try { summary = JSON.parse(raw); } catch { fail('collector completion summary is malformed'); }
    if (summary?.status !== 'complete' || summary.phase !== request.value.phase
        || typeof summary.result !== 'string'
        || !/^sha256:[0-9a-f]{64}$/u.test(summary.sha256 || '')) {
      fail('collector completion summary is invalid');
    }
    const result = readJson(resolve(summary.result), 'collector result');
    if (!result.value || result.value.status !== 'complete'
        || result.value.phase !== request.value.phase
        || JSON.stringify(result.value.controlRequest) !== JSON.stringify({
          requestId: request.value.requestId,
          requestSha256: request.digest,
          runtimeSha: request.value.runtimeSha,
        })
        || JSON.stringify(result.value.previousControlRequest)
          !== JSON.stringify(request.value.previousEvidence?.controlRequest ?? null)
        || result.digest !== summary.sha256
        || !resolve(summary.result).startsWith(`${options.observationRoot}/`)) {
      fail('collector result does not match its exact completion summary');
    }
    const resultReference = { path: resolve(summary.result), sha256: summary.sha256 };
    writeJournal(options, request, 'completed', 'complete', { bootId, result: resultReference });
    durableRemove(options.active);
    return { status: 'complete', requestId, runtimeSha: request.value.runtimeSha, result: resultReference };
  } catch (error) {
    try {
      writeJournal(options, request, 'failed', 'failed', {
        bootId,
        failureReason: String(error?.message || 'unknown error').slice(0, 256),
      });
      durableRemove(options.active);
    } catch {
      // The original fail-closed error remains authoritative. A retained
      // active marker prevents another observation from overlapping it.
    }
    throw error;
  }
}

function run(options, requestId) {
  const request = readRequest(options, requestId);
  secureFile(options.mutex, 'shared release/Sonar/observation mutex', {
    mode: 0o660,
    owner: expectedUid(),
    maximum: 1024,
  });
  const executable = realpathSync.native(fileURLToPath(import.meta.url));
  const child = spawnSync(options.flock, [
    '-n',
    options.mutex,
    '/usr/bin/env',
    'NEXUS_OLLAMA_SHARED_LOCK_HELD=1',
    `NEXUS_OLLAMA_OBSERVATION_SYSTEMD_REQUEST_ID=${requestId}`,
    process.execPath,
    executable,
    'run-locked',
    requestId,
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: testMode() ? 30_000 : (25 * 60 * 60 * 1000),
    maxBuffer: MAX_BYTES,
    env: process.env,
  });
  if (child.status === 0 && !child.error && !child.signal) {
    let result;
    try { result = JSON.parse((child.stdout || '').trim()); } catch { fail('observation worker completion is malformed'); }
    return result;
  }
  // If flock could not start the child there is no child-side catch block.
  // Seal the request failed here so an unavailable shared mutex cannot strand
  // a pending active marker after the launching SSH session has gone away.
  try {
    const current = readJournal(options, requestId).journal;
    if (!['completed', 'failed'].includes(current.status)) {
      writeJournal(options, request, 'failed', 'failed', {
        failureReason: child.status === 1
          ? 'shared_release_sonar_mutex_unavailable'
          : 'systemd_observation_worker_failed',
      });
      if (existsSync(options.active)) durableRemove(options.active);
    }
  } catch {
    // Retaining an unverified active marker is the fail-closed fallback.
  }
  const detail = String(child.stderr || '').trim().split(/\r?\n/u)[0];
  fail(detail || (child.status === 1
    ? 'shared release/Sonar/observation mutex is unavailable'
    : 'durable observation worker failed'), child.status === 1 ? 75 : 1);
}

function status(options, requestId) {
  return readJournal(options, requestId).journal;
}

function parse(argv) {
  const commandName = argv.shift();
  const values = new Map();
  const positional = [];
  while (argv.length > 0) {
    const arg = argv.shift();
    if (arg?.startsWith('--')) {
      if (![
        '--phase',
        '--runtime-sha',
        '--previous-evidence',
        '--previous-evidence-sha256',
      ].includes(arg) || values.has(arg)) {
        fail(`unknown or repeated argument: ${arg}`, 64);
      }
      const value = argv.shift();
      if (!value || value.startsWith('--')) fail(`missing value for ${arg}`, 64);
      values.set(arg, value);
    } else {
      positional.push(arg);
    }
  }
  if (!['launch', 'run', 'run-locked', 'status'].includes(commandName || '')) {
    fail('command must be launch, run, or status', 64);
  }
  if (commandName === 'launch' && positional.length !== 0) fail('launch accepts only named arguments', 64);
  if (commandName !== 'launch' && positional.length !== 1) fail(`${commandName} requires one request ID`, 64);
  return { commandName, values, positional };
}

try {
  if (!testMode() && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
    fail('Ollama observation control must run as root', 77);
  }
  const executable = realpathSync.native(fileURLToPath(import.meta.url));
  if (!testMode() && executable !== INSTALLED_CONTROL) {
    fail(`Ollama observation control must execute from ${INSTALLED_CONTROL}`, 77);
  }
  const executableInfo = secureFile(executable, 'Ollama observation control executable', {
    mode: testMode() ? null : 0o700,
    owner: expectedUid(),
  });
  if (testMode() && (executableInfo.mode & 0o022) !== 0) {
    fail('test observation control source is writable by another account');
  }
  const parsed = parse(process.argv.slice(2));
  const options = paths();
  let result;
  if (parsed.commandName === 'launch') result = launch(options, parsed);
  else if (parsed.commandName === 'run') result = run(options, parsed.positional[0]);
  else if (parsed.commandName === 'run-locked') result = runLocked(options, parsed.positional[0]);
  else result = status(options, parsed.positional[0]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`ollama_observation_control_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
