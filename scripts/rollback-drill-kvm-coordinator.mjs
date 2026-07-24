#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  EvidenceError,
  bindExecutionReceipt,
  buildExecutionReceipt,
  buildLocalExecutionPlan,
  buildRollbackRequest,
  canonicalJsonBuffer,
  collectBundle,
  publicKeyIdentity,
  readBoundedJson,
  readBoundedText,
  sha256Json,
  textKeyIdentity,
  validateIsolationEvidence,
  validateKeySet,
  validateDrillOutcome,
  validateExecutionReceipt,
  validateOwnerAuthorization,
  validatePlan,
  verifyBundle,
} from './lib/rollback-drill-kvm-evidence.mjs';

const rawArgs = process.argv.slice(2);
const knownCommands = new Set([
  'plan',
  'validate-isolation',
  'collect',
  'verify',
  'request',
  'execute',
]);
let command = rawArgs[0] && !rawArgs[0].startsWith('--') ? rawArgs.shift() : '';
if (!command && rawArgs.includes('--plan')) command = 'plan';

const FLAGS = Object.freeze({
  plan: new Set(['--input', '--plan']),
  'validate-isolation': new Set(['--plan', '--isolation']),
  collect: new Set([
    '--plan',
    '--authorization',
    '--isolation',
    '--execution',
    '--restore',
    '--ssh-loss',
    '--failed-health',
    '--guest-reboot',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
    '--output-dir',
  ]),
  verify: new Set([
    '--bundle',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
  ]),
  request: new Set([
    '--bundle',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
    '--operator',
    '--output',
  ]),
  execute: new Set([
    '--plan',
    '--authorization',
    '--isolation',
    '--guest-owner-public-key',
    '--production-owner-public-key',
    '--guest-ssh-client-public-key',
    '--production-ssh-client-public-key',
    '--guest-ssh-host-public-key',
    '--production-ssh-host-public-key',
    '--release-evidence-public-key',
    '--guest-ssh-private-key',
    '--request-dir',
    '--output-dir',
  ]),
});

function fail(code) {
  throw new EvidenceError(code);
}

function usage() {
  process.stderr.write(
    'Usage: rollback-drill-kvm-coordinator.mjs '
      + '<plan|validate-isolation|collect|verify|request|execute> [exact options]\n',
  );
}

function parseFlags() {
  if (!knownCommands.has(command)) fail('command_unsupported');
  const allowed = FLAGS[command];
  const values = new Map();
  for (let index = 0; index < rawArgs.length; index += 2) {
    const flag = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!allowed.has(flag)) fail(`flag_unsupported:${flag || 'missing'}`);
    if (!value || value.startsWith('--')) fail(`flag_value_missing:${flag}`);
    if (values.has(flag)) fail(`flag_duplicate:${flag}`);
    values.set(flag, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) fail(`flag_required:${name}`);
  return value;
}

function planPath(values) {
  const input = values.get('--input');
  const plan = values.get('--plan');
  if (input && plan) fail('plan_input_ambiguous');
  return required(values, input ? '--input' : '--plan');
}

function readPlan(values) {
  return readBoundedJson(planPath(values), 'plan');
}

function readKeys(values) {
  return {
    guestOwnerPublicKeyPem: readBoundedText(
      required(values, '--guest-owner-public-key'),
      'guest_owner_public_key',
      16 * 1024,
    ),
    productionOwnerPublicKeyPem: readBoundedText(
      required(values, '--production-owner-public-key'),
      'production_owner_public_key',
      16 * 1024,
    ),
    guestSshClientPublicKey: readBoundedText(
      required(values, '--guest-ssh-client-public-key'),
      'guest_ssh_client_public_key',
      16 * 1024,
    ),
    productionSshClientPublicKey: readBoundedText(
      required(values, '--production-ssh-client-public-key'),
      'production_ssh_client_public_key',
      16 * 1024,
    ),
    guestSshHostPublicKey: readBoundedText(
      required(values, '--guest-ssh-host-public-key'),
      'guest_ssh_host_public_key',
      16 * 1024,
    ),
    productionSshHostPublicKey: readBoundedText(
      required(values, '--production-ssh-host-public-key'),
      'production_ssh_host_public_key',
      16 * 1024,
    ),
    releaseEvidencePublicKeyPem: readBoundedText(
      required(values, '--release-evidence-public-key'),
      'release_evidence_public_key',
      16 * 1024,
    ),
  };
}

function publishRequest(output, payload) {
  const requested = path.resolve(output);
  const requestedParent = path.dirname(requested);
  const stat = fs.lstatSync(requestedParent, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    fail('request_output_parent_unsafe');
  }
  const parent = fs.realpathSync(requestedParent);
  const resolved = path.join(parent, path.basename(requested));
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJsonBuffer(payload));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(resolved, 0o600);
  const parentDescriptor = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
  return resolved;
}

function keySummary(plan) {
  return {
    guestOwnerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    guestSshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
    guestSshHostPublicKeySha256: plan.trust.guestSshHostPublicKeySha256,
    releaseEvidencePublicKeySha256: plan.trust.releaseEvidencePublicKeySha256,
  };
}

const DIGEST = /^[0-9a-f]{64}$/u;
const TRANSACTION_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const TERMINAL_STATUSES = new Set([
  'completed',
  'recovered',
  'failed_before_stop',
  'recovery_failed',
]);
const POST_STOP_PHASES = new Set([
  'predecessor_stopped',
  'creating_backup',
  'backup_created',
  'final_migration_rehearsal',
  'final_migration_verified',
  'candidate_authorization_required',
  'mutating_candidate',
  'candidate_available',
  'verifying_candidate',
  'awaiting_dr_escrow',
  'recovery_required',
  'recovering',
  'recovery_complete',
  'completed',
]);
const TEST_MODE = process.env.NEXUS_ROLLBACK_DRILL_COORDINATOR_TEST_MODE === '1';
const POLL_INTERVAL_MS = TEST_MODE ? 1 : 100;
const EXECUTION_TIMEOUT_MS = TEST_MODE ? 15_000 : 15 * 60 * 1000;
const BOOT_TIMEOUT_MS = TEST_MODE ? 5_000 : 120 * 1000;
const COMMAND_TIMEOUT_MS = TEST_MODE ? 5_000 : 30_000;
const MAX_PROMOTION_ENVELOPE_BYTES = 40 * 1024 * 1024;
const OWNER_PUBLIC_KEY = '/etc/nexus-release/owner-promotion-public-key.pem';

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sleep(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function executionBinaries() {
  if (!TEST_MODE) {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) {
      fail('execution_requires_root_controller');
    }
    return {
      ssh: '/usr/bin/ssh',
      scp: '/usr/bin/scp',
      systemctl: '/usr/bin/systemctl',
    };
  }
  const directory = process.env.NEXUS_ROLLBACK_DRILL_COORDINATOR_TEST_BIN_DIR;
  if (!directory || !path.isAbsolute(directory)) fail('test_binary_directory_invalid');
  return {
    ssh: path.join(directory, 'ssh'),
    scp: path.join(directory, 'scp'),
    systemctl: path.join(directory, 'systemctl'),
  };
}

function runProgram(program, argv, label, { allowFailure = false } = {}) {
  const environment = TEST_MODE
    ? { ...process.env, LC_ALL: 'C', LANG: 'C' }
    : { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' };
  const result = spawnSync(program, argv, {
    encoding: 'utf8',
    env: environment,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_PROMOTION_ENVELOPE_BYTES + 1024 * 1024,
  });
  if (result.error) fail(`${label}_subprocess_error`);
  if (!allowFailure && result.status !== 0) fail(`${label}_failed`);
  return result;
}

function requireCanonicalRegularFile(
  input,
  label,
  { maxBytes, modes = null } = {},
) {
  const requested = path.resolve(input);
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch {
    fail(`${label}_missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size <= 0 || (maxBytes && stat.size > maxBytes)
      || (modes && !modes.includes(stat.mode & 0o777))) {
    fail(`${label}_unsafe`);
  }
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    fail(`${label}_unsafe`);
  }
  if (resolved !== requested) fail(`${label}_unsafe`);
  return requested;
}

function requireCanonicalDirectory(input, label) {
  const requested = path.resolve(input);
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch {
    fail(`${label}_missing`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label}_unsafe`);
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    fail(`${label}_unsafe`);
  }
  if (resolved !== requested) fail(`${label}_unsafe`);
  return requested;
}

function prepareExecutionOutput(input) {
  const requested = path.resolve(input);
  const parent = requireCanonicalDirectory(path.dirname(requested), 'execution_output_parent');
  const resolved = path.join(parent, path.basename(requested));
  if (fs.existsSync(requested) || fs.existsSync(resolved)) fail('execution_output_exists');
  fs.mkdirSync(resolved, { mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  const descriptor = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return resolved;
}

function publishCanonicalJson(directory, name, value) {
  const destination = path.join(directory, name);
  const descriptor = fs.openSync(destination, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, canonicalJsonBuffer(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(destination, 0o600);
  const parentDescriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(parentDescriptor);
  } finally {
    fs.closeSync(parentDescriptor);
  }
  return {
    path: destination,
    sha256: sha256Bytes(fs.readFileSync(destination)),
  };
}

function controllerIdentity(plan) {
  const rawMachineId = TEST_MODE
    ? process.env.NEXUS_ROLLBACK_DRILL_CONTROLLER_MACHINE_ID
    : fs.readFileSync('/etc/machine-id', 'utf8');
  const rawBootId = TEST_MODE
    ? process.env.NEXUS_ROLLBACK_DRILL_CONTROLLER_BOOT_ID
    : fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
  if (!rawMachineId || !rawBootId) fail('controller_identity_unavailable');
  const identity = {
    machineIdSha256: sha256Bytes(rawMachineId.trim()),
    bootIdSha256: sha256Bytes(rawBootId.trim()),
  };
  if (identity.machineIdSha256 !== plan.controller.machineIdSha256
      || identity.bootIdSha256 !== plan.controller.bootIdSha256) {
    fail('controller_identity_changed');
  }
  return identity;
}

function keyMaterial(guestSshHostPublicKey) {
  const parts = guestSshHostPublicKey.trim().split(/\s+/u);
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(parts[1])) {
    fail('guest_ssh_host_key_material_invalid');
  }
  return `${parts[0]} ${parts[1]}`;
}

function sshTarget(overlay) {
  const host = overlay.ssh.host.includes(':')
    ? `[${overlay.ssh.host}]`
    : overlay.ssh.host;
  return `${overlay.ssh.user}@${host}`;
}

function sshOptions(overlay, privateKey, knownHosts, { scp = false } = {}) {
  return [
    scp ? '-P' : '-p',
    String(overlay.ssh.port),
    '-F',
    '/dev/null',
    '-i',
    privateKey,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `HostKeyAlias=${overlay.overlayId}`,
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'CheckHostIP=no',
    '-o',
    'UpdateHostKeys=no',
    '-o',
    'VerifyHostKeyDNS=no',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'PreferredAuthentications=publickey',
    '-o',
    'ControlMaster=no',
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=5',
  ];
}

function remoteResult(context, remoteArgv, label, { allowFailure = false } = {}) {
  return runProgram(
    context.binaries.ssh,
    [
      ...sshOptions(context.overlay, context.privateKey, context.knownHosts),
      sshTarget(context.overlay),
      ...remoteArgv,
    ],
    label,
    { allowFailure },
  );
}

function remoteText(context, remoteArgv, label) {
  return remoteResult(context, remoteArgv, label).stdout;
}

function sudoControl(context, argv, label) {
  return remoteText(
    context,
    ['/usr/bin/sudo', '-n', context.plan.interfaces.promotionControl, ...argv],
    label,
  );
}

function parseJsonText(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    fail(`${label}_json_invalid`);
  }
}

function waitForSsh(context, label) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const result = remoteResult(
      context,
      ['/usr/bin/true'],
      label,
      { allowFailure: true },
    );
    if (result.status === 0) return;
    sleep(POLL_INTERVAL_MS);
  }
  fail(`${label}_timeout`);
}

function waitForSshDown(context, label) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const result = remoteResult(
      context,
      ['/usr/bin/true'],
      label,
      { allowFailure: true },
    );
    if (result.status !== 0) return;
    sleep(POLL_INTERVAL_MS);
  }
  fail(`${label}_timeout`);
}

function guestIdentity(context, label) {
  const machineId = remoteText(
    context,
    ['/usr/bin/cat', '/etc/machine-id'],
    `${label}_machine_id`,
  ).trim();
  const bootId = remoteText(
    context,
    ['/usr/bin/cat', '/proc/sys/kernel/random/boot_id'],
    `${label}_boot_id`,
  ).trim();
  if (!machineId || !bootId) fail(`${label}_identity_empty`);
  return {
    machineIdSha256: sha256Bytes(machineId),
    bootIdSha256: sha256Bytes(bootId),
  };
}

function validateInitialGuestIdentity(context, isolationOverlay) {
  const identity = guestIdentity(context, `${context.overlay.drill}_initial`);
  if (identity.machineIdSha256 !== isolationOverlay.guestMachineIdSha256
      || identity.bootIdSha256 === context.plan.controller.bootIdSha256
      || identity.bootIdSha256 === identity.machineIdSha256) {
    fail(`${context.overlay.drill}_guest_identity_mismatch`);
  }
  return identity;
}

function validatePromotionPayload(payload, plan) {
  if (!payload || payload.schema !== 'nexus.promotion-transaction-request.v1'
      || !TRANSACTION_ID.test(payload.transactionId || '')
      || payload.ownerAuthorization !== 'explicit'
      || payload.predecessor?.sha !== plan.release.sourceSha
      || payload.target?.sha !== plan.release.targetSha
      || payload.target?.version !== plan.release.targetVersion
      || payload.target?.sentryRelease !== plan.release.targetSha
      || payload.productionBase !== plan.release.productionBase
      || payload.backupDir !== plan.release.backupDir
      || payload.preparedRuntimeDir !== plan.release.preparedRuntimeDir
      || payload.pm2Bin !== plan.release.pm2Bin
      || payload.publicBaseUrl !== plan.release.publicBaseUrl
      || payload.stabilitySeconds !== 60) {
    fail('promotion_request_plan_binding_invalid');
  }
}

function stageAndVerifyRequest(context, requestFile) {
  const body = fs.readFileSync(requestFile);
  const rawSha256 = sha256Bytes(body);
  const remoteDirectory = `/home/dominguez/.nexus-rollback-drill/${context.plan.planId}`;
  const remotePath = `${remoteDirectory}/${context.overlay.drill}-${rawSha256}.envelope.json`;
  remoteText(
    context,
    ['/usr/bin/install', '-d', '-m', '0700', remoteDirectory],
    `${context.overlay.drill}_request_directory`,
  );
  const copied = runProgram(
    context.binaries.scp,
    [
      ...sshOptions(
        context.overlay,
        context.privateKey,
        context.knownHosts,
        { scp: true },
      ),
      requestFile,
      `${sshTarget(context.overlay)}:${remotePath}`,
    ],
    `${context.overlay.drill}_request_copy`,
  );
  if (copied.status !== 0) fail(`${context.overlay.drill}_request_copy_failed`);
  remoteText(
    context,
    ['/usr/bin/chmod', '0600', remotePath],
    `${context.overlay.drill}_request_mode`,
  );
  const remoteDigest = remoteText(
    context,
    ['/usr/bin/sha256sum', remotePath],
    `${context.overlay.drill}_request_digest`,
  ).trim().split(/\s+/u)[0];
  if (remoteDigest !== rawSha256) fail(`${context.overlay.drill}_request_copy_drift`);
  const verified = parseJsonText(
    remoteText(
      context,
      [
        '/usr/bin/node',
        context.plan.interfaces.promotionAuthorization,
        'verify-request',
        '--input',
        remotePath,
        '--public-key',
        OWNER_PUBLIC_KEY,
      ],
      `${context.overlay.drill}_request_verification`,
    ),
    `${context.overlay.drill}_request_verification`,
  );
  if (verified.ok !== true || verified.kind !== 'request'
      || !TRANSACTION_ID.test(verified.transactionId || '')
      || !DIGEST.test(verified.payloadSha256 || '')) {
    fail(`${context.overlay.drill}_request_verification_invalid`);
  }
  validatePromotionPayload(verified.payload, context.plan);
  if (verified.transactionId !== verified.payload.transactionId) {
    fail(`${context.overlay.drill}_request_transaction_mismatch`);
  }
  return {
    remotePath,
    transactionId: verified.transactionId,
    requestSha256: verified.payloadSha256,
  };
}

function parseJournal(raw, transactionId, requestSha256, label) {
  const journal = parseJsonText(raw, label);
  if (journal.schema !== 'nexus.promotion-transaction-journal.v1'
      || journal.transactionId !== transactionId
      || journal.requestSha256 !== requestSha256
      || typeof journal.phase !== 'string'
      || typeof journal.status !== 'string') {
    fail(`${label}_identity_invalid`);
  }
  return { journal, raw };
}

function readJournal(context, transactionId, requestSha256, label) {
  const raw = sudoControl(
    context,
    ['status', transactionId],
    label,
  );
  return parseJournal(raw, transactionId, requestSha256, label);
}

function waitForJournal(
  context,
  transactionId,
  requestSha256,
  label,
  predicate,
  { allowTerminal = false } = {},
) {
  const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const observed = readJournal(
      context,
      transactionId,
      requestSha256,
      label,
    );
    if (predicate(observed.journal)) return observed;
    if (!allowTerminal && TERMINAL_STATUSES.has(observed.journal.status)) {
      fail(`${label}_unexpected_terminal`);
    }
    sleep(POLL_INTERVAL_MS);
  }
  fail(`${label}_timeout`);
}

function validateTerminalJournal(observed, expectedStatus, label) {
  const { journal } = observed;
  if (journal.status !== expectedStatus || journal.phase === 'submitted') {
    fail(`${label}_terminal_status_invalid`);
  }
  if (expectedStatus === 'recovered') {
    const recovery = journal.recovery;
    if (!recovery || recovery.schema !== 'nexus.promotion-recovery-result.v1'
        || recovery.targetSeconds !== 120 || recovery.targetMet !== true
        || !Number.isInteger(recovery.outageToHealthySeconds)
        || recovery.outageToHealthySeconds < 0
        || recovery.outageToHealthySeconds > 120) {
      fail(`${label}_recovery_result_invalid`);
    }
  }
}

function verifyRuntimeHealthy(context, expectedRuntimeSha, label) {
  sudoControl(context, ['assert-root-pm2-ready'], `${label}_root_pm2`);
  const processes = parseJsonText(
    remoteText(context, [context.plan.release.pm2Bin, 'jlist'], `${label}_pm2`),
    `${label}_pm2`,
  );
  if (!Array.isArray(processes)) fail(`${label}_pm2_invalid`);
  for (const name of context.plan.guest.requiredPm2Apps) {
    const row = processes.find((candidate) => candidate?.name === name);
    if (!row || row.pm2_env?.status !== 'online') fail(`${label}_pm2_not_online`);
    if (name === 'nexus-hub' || name === 'content-engine') {
      const runtimeSha = row.pm2_env.NEXUS_RELEASE_SHA || row.pm2_env.GIT_COMMIT;
      if (runtimeSha !== expectedRuntimeSha) fail(`${label}_runtime_sha_mismatch`);
    }
  }
  const backend = parseJsonText(
    remoteText(
      context,
      [
        '/usr/bin/curl',
        '--fail',
        '--silent',
        '--show-error',
        '--connect-timeout',
        '1',
        '--max-time',
        '5',
        'http://127.0.0.1:8200/health',
      ],
      `${label}_backend_health`,
    ),
    `${label}_backend_health`,
  );
  if (backend.status !== 'healthy'
      || backend.server?.status !== 'online'
      || backend.database !== 'connected') {
    fail(`${label}_backend_unhealthy`);
  }
  remoteText(
    context,
    [
      '/usr/bin/curl',
      '--fail',
      '--silent',
      '--show-error',
      '--connect-timeout',
      '1',
      '--max-time',
      '5',
      'http://127.0.0.1:8100/health',
    ],
    `${label}_content_health`,
  );
}

function hostUnit(context, action, label) {
  const result = runProgram(
    context.binaries.systemctl,
    [action, context.hostUnit],
    label,
  );
  if (result.status !== 0) fail(`${label}_failed`);
}

function rebootGuest(context, label) {
  hostUnit(context, 'stop', `${label}_stop`);
  waitForSshDown(context, `${label}_ssh_down`);
  hostUnit(context, 'start', `${label}_start`);
  waitForSsh(context, `${label}_ssh_up`);
  return guestIdentity(context, `${label}_identity`);
}

function createTimelineRecorder(controllerBootIdSha256) {
  let priorMonotonic = -1;
  return (event, guestBootIdSha256) => {
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    const observerMonotonicMs = Math.max(now, priorMonotonic + 1);
    priorMonotonic = observerMonotonicMs;
    return {
      event,
      observedAt: new Date().toISOString(),
      observerMonotonicMs,
      observerBootIdSha256: controllerBootIdSha256,
      guestBootIdSha256,
    };
  };
}

function postTerminalReboot(context, beforeBootId, journalSha256, expectedRuntimeSha) {
  const after = rebootGuest(context, `${context.overlay.drill}_clean_reboot`);
  if (after.machineIdSha256 !== context.isolationOverlay.guestMachineIdSha256
      || after.bootIdSha256 === beforeBootId
      || after.bootIdSha256 === context.isolationOverlay.readinessBootIdSha256) {
    fail('post_terminal_reboot_identity_invalid');
  }
  const version = sudoControl(context, ['version'], 'post_terminal_control_version').trim();
  if (version !== context.plan.interfaces.controlVersion) {
    fail('post_terminal_control_version_invalid');
  }
  sudoControl(context, ['assert-root-pm2-ready'], 'post_terminal_assert_root_pm2');
  sudoControl(context, ['assert-idle'], 'post_terminal_assert_idle');
  const result = remoteText(
    context,
    [
      '/usr/bin/systemctl',
      'show',
      context.plan.interfaces.recoveryUnit,
      '--property=Result',
      '--value',
    ],
    'post_terminal_recovery_unit',
  ).trim();
  if (result !== 'success') fail('post_terminal_recovery_unit_failed');
  const observed = readJournal(
    context,
    context.transactionId,
    context.requestSha256,
    'post_terminal_journal',
  );
  if (sha256Bytes(Buffer.from(observed.raw, 'utf8')) !== journalSha256
      || observed.journal.status !== 'recovered') {
    fail('post_terminal_journal_changed');
  }
  verifyRuntimeHealthy(context, expectedRuntimeSha, 'post_terminal_runtime');
  return {
    beforeGuestBootIdSha256: beforeBootId,
    afterGuestBootIdSha256: after.bootIdSha256,
    journalSha256,
    controlVersion: version,
    recoveryUnitResult: result,
    assertRootPm2Ready: true,
    assertIdle: true,
    exactRuntimeHealthy: true,
  };
}

function executeOneDrill(context) {
  let launched = false;
  let terminalObserved = false;
  hostUnit(context, 'start', `${context.overlay.drill}_guest_start`);
  try {
    waitForSsh(context, `${context.overlay.drill}_initial_ssh`);
    const initialIdentity = validateInitialGuestIdentity(
      context,
      context.isolationOverlay,
    );
    const version = sudoControl(
      context,
      ['version'],
      `${context.overlay.drill}_control_version`,
    ).trim();
    if (version !== context.plan.interfaces.controlVersion) {
      fail(`${context.overlay.drill}_control_version_invalid`);
    }
    sudoControl(
      context,
      ['assert-root-pm2-ready'],
      `${context.overlay.drill}_assert_root_pm2`,
    );
    sudoControl(context, ['assert-idle'], `${context.overlay.drill}_assert_idle`);
    const request = stageAndVerifyRequest(context, context.requestFile);
    context.transactionId = request.transactionId;
    context.requestSha256 = request.requestSha256;
    const launch = parseJsonText(
      sudoControl(
        context,
        ['launch', request.remotePath],
        `${context.overlay.drill}_launch`,
      ),
      `${context.overlay.drill}_launch`,
    );
    if (launch.ok !== true || launch.transactionId !== request.transactionId
        || launch.requestSha256 !== request.requestSha256
        || !['launched', 'terminal'].includes(launch.state)) {
      fail(`${context.overlay.drill}_launch_invalid`);
    }
    launched = true;
    const record = createTimelineRecorder(context.controller.bootIdSha256);
    const timeline = [record('launch_accepted', initialIdentity.bootIdSha256)];

    waitForJournal(
      context,
      request.transactionId,
      request.requestSha256,
      `${context.overlay.drill}_recovery_armed`,
      (journal) => journal.recoveryArmed === true,
    );
    timeline.push(record('recovery_armed', initialIdentity.bootIdSha256));
    waitForJournal(
      context,
      request.transactionId,
      request.requestSha256,
      `${context.overlay.drill}_predecessor_stopped`,
      (journal) => POST_STOP_PHASES.has(journal.phase),
    );
    timeline.push(record('predecessor_stopped', initialIdentity.bootIdSha256));

    let terminal;
    let activeGuestBootId = initialIdentity.bootIdSha256;
    if (context.overlay.drill === 'ssh-loss') {
      timeline.push(record('controller_disconnected', activeGuestBootId));
      sleep(POLL_INTERVAL_MS);
      const reconnected = readJournal(
        context,
        request.transactionId,
        request.requestSha256,
        'ssh_loss_reconnect',
      );
      timeline.push(record('controller_reconnected', activeGuestBootId));
      terminal = TERMINAL_STATUSES.has(reconnected.journal.status)
        ? reconnected
        : waitForJournal(
            context,
            request.transactionId,
            request.requestSha256,
            'ssh_loss_terminal',
            (journal) => ['completed', 'recovered'].includes(journal.status),
            { allowTerminal: true },
          );
    } else if (context.overlay.drill === 'failed-health') {
      waitForJournal(
        context,
        request.transactionId,
        request.requestSha256,
        'failed_health_candidate_mutated',
        (journal) => ['mutating_candidate', 'recovery_required', 'recovering']
          .includes(journal.phase),
      );
      timeline.push(record('candidate_mutated', activeGuestBootId));
      waitForJournal(
        context,
        request.transactionId,
        request.requestSha256,
        'failed_health_fault',
        (journal) => journal.status === 'recovery_required'
          && journal.message === 'invalid_worker_completion',
      );
      timeline.push(record('candidate_health_fault_injected', activeGuestBootId));
      timeline.push(record('recovery_started', activeGuestBootId));
      terminal = waitForJournal(
        context,
        request.transactionId,
        request.requestSha256,
        'failed_health_terminal',
        (journal) => journal.status === 'recovered',
        { allowTerminal: true },
      );
    } else {
      timeline.push(record('guest_power_cut', activeGuestBootId));
      const rebooted = rebootGuest(context, 'guest_reboot_fault');
      if (rebooted.machineIdSha256 !== context.isolationOverlay.guestMachineIdSha256
          || rebooted.bootIdSha256 === activeGuestBootId) {
        fail('guest_reboot_identity_invalid');
      }
      activeGuestBootId = rebooted.bootIdSha256;
      timeline.push(record('guest_booted', activeGuestBootId));
      terminal = waitForJournal(
        context,
        request.transactionId,
        request.requestSha256,
        'guest_reboot_terminal',
        (journal) => journal.status === 'recovered',
        { allowTerminal: true },
      );
      timeline.push(record('recovery_service_completed', activeGuestBootId));
    }

    const expectedStatus = context.overlay.drill === 'ssh-loss'
      ? terminal.journal.status
      : 'recovered';
    if (!['completed', 'recovered'].includes(expectedStatus)) {
      fail(`${context.overlay.drill}_terminal_not_accepted`);
    }
    validateTerminalJournal(terminal, expectedStatus, context.overlay.drill);
    const expectedRuntimeSha = expectedStatus === 'completed'
      ? context.plan.release.targetSha
      : context.plan.release.sourceSha;
    verifyRuntimeHealthy(context, expectedRuntimeSha, `${context.overlay.drill}_terminal`);
    if (context.overlay.drill === 'guest-reboot') {
      timeline.push(record('pm2_started', activeGuestBootId));
    }
    timeline.push(record('service_healthy', activeGuestBootId));
    timeline.push(record('terminal_observed', activeGuestBootId));
    sudoControl(context, ['assert-idle'], `${context.overlay.drill}_terminal_idle`);
    const journalSha256 = sha256Bytes(Buffer.from(terminal.raw, 'utf8'));
    let recoveryResultSha256;
    if (expectedStatus === 'recovered') {
      recoveryResultSha256 = sha256Bytes(
        canonicalJsonBuffer(terminal.journal.recovery),
      );
    } else {
      recoveryResultSha256 = sha256Bytes(Buffer.from(
        sudoControl(
          context,
          ['fetch', request.transactionId, 'result'],
          'ssh_loss_result',
        ),
        'utf8',
      ));
    }
    const postReboot = context.overlay.drill === 'guest-reboot'
      ? postTerminalReboot(
          context,
          activeGuestBootId,
          journalSha256,
          expectedRuntimeSha,
        )
      : null;
    remoteResult(
      context,
      ['/usr/bin/rm', '-f', request.remotePath],
      `${context.overlay.drill}_request_cleanup`,
      { allowFailure: true },
    );
    terminalObserved = true;
    return {
      schema: 'nexus.rollback-drill-kvm-outcome.v1',
      planId: context.plan.planId,
      executionMode: 'strictly-sequential',
      testMode: TEST_MODE,
      executionReceiptSha256: null,
      drill: context.overlay.drill,
      overlayId: context.overlay.overlayId,
      transactionId: request.transactionId,
      requestSha256: request.requestSha256,
      controlVersion: version,
      terminalStatus: expectedStatus,
      secondLaunchObserved: false,
      productionEvidenceEmitted: false,
      exactTargetHealthy: expectedStatus === 'completed',
      exactPredecessorRestored: expectedStatus === 'recovered',
      databaseBackupRestored: expectedStatus === 'recovered',
      journalSha256,
      recoveryResultSha256,
      postTerminalReboot: postReboot,
      timeline,
    };
  } finally {
    if (!launched || terminalObserved) {
      runProgram(
        context.binaries.systemctl,
        ['stop', context.hostUnit],
        `${context.overlay.drill}_guest_stop`,
        { allowFailure: true },
      );
    }
  }
}

function writeKnownHosts(outputRoot, plan, guestSshHostPublicKey) {
  const directory = path.join(outputRoot, 'known-hosts');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const material = keyMaterial(guestSshHostPublicKey);
  const paths = new Map();
  for (const overlay of plan.overlays) {
    const destination = path.join(directory, overlay.overlayId);
    const descriptor = fs.openSync(destination, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${overlay.overlayId} ${material}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(destination, 0o600);
    paths.set(overlay.overlayId, destination);
  }
  return paths;
}

function executeSequentialDrills(plan, isolation, keys, values) {
  const binaries = executionBinaries();
  const controller = controllerIdentity(plan);
  const privateKey = requireCanonicalRegularFile(
    required(values, '--guest-ssh-private-key'),
    'guest_ssh_private_key',
    { maxBytes: 64 * 1024, modes: [0o400, 0o600] },
  );
  const requestDirectory = requireCanonicalDirectory(
    required(values, '--request-dir'),
    'promotion_request_directory',
  );
  const outputRoot = prepareExecutionOutput(required(values, '--output-dir'));
  const knownHosts = writeKnownHosts(
    outputRoot,
    plan,
    keys.guestSshHostPublicKey,
  );
  const provisionalOutcomes = {};
  const transactionIds = new Set();
  const requestDigests = new Set();
  for (let index = 0; index < plan.overlays.length; index += 1) {
    const overlay = plan.overlays[index];
    const isolationOverlay = isolation.overlays[index];
    const requestFile = requireCanonicalRegularFile(
      path.join(requestDirectory, `${overlay.drill}.envelope.json`),
      `${overlay.drill}_promotion_request`,
      { maxBytes: MAX_PROMOTION_ENVELOPE_BYTES, modes: [0o400, 0o600] },
    );
    const outcome = executeOneDrill({
      binaries,
      controller,
      plan,
      overlay,
      isolationOverlay,
      requestFile,
      privateKey,
      knownHosts: knownHosts.get(overlay.overlayId),
      hostUnit: `nexus-rollback-drill-vm@guest-${index + 1}.service`,
    });
    validateDrillOutcome(outcome, plan, isolation, { allowUnboundExecution: true });
    if (transactionIds.has(outcome.transactionId)) fail('execution_transaction_id_reuse');
    if (requestDigests.has(outcome.requestSha256)) fail('execution_request_digest_reuse');
    transactionIds.add(outcome.transactionId);
    requestDigests.add(outcome.requestSha256);
    provisionalOutcomes[overlay.drill] = outcome;
  }
  const receipt = buildExecutionReceipt(plan, provisionalOutcomes, {
    testMode: TEST_MODE,
    completedAt: new Date().toISOString(),
  });
  const outcomes = bindExecutionReceipt(receipt, provisionalOutcomes);
  validateExecutionReceipt(receipt, plan, outcomes, { allowTestMode: TEST_MODE });
  for (const overlay of plan.overlays) {
    validateDrillOutcome(outcomes[overlay.drill], plan, isolation);
    publishCanonicalJson(outputRoot, `${overlay.drill}.json`, outcomes[overlay.drill]);
  }
  const receiptFile = publishCanonicalJson(outputRoot, 'execution.json', receipt);
  return {
    outputDir: outputRoot,
    receiptSha256: receiptFile.sha256,
    outcomes: receipt.outcomes,
    testMode: TEST_MODE,
  };
}

function main() {
  const values = parseFlags();
  if (command === 'plan') {
    const plan = readPlan(values);
    validatePlan(plan);
    return {
      ok: true,
      command,
      planSha256: sha256Json(plan),
      keyIdentities: keySummary(plan),
      executionPlan: buildLocalExecutionPlan(plan),
    };
  }
  if (command === 'validate-isolation') {
    const plan = readPlan(values);
    const isolation = readBoundedJson(required(values, '--isolation'), 'isolation');
    validateIsolationEvidence(isolation, plan);
    return {
      ok: true,
      command,
      planId: plan.planId,
      planSha256: sha256Json(plan),
      isolationSha256: sha256Json(isolation),
    };
  }
  if (command === 'collect') {
    const plan = readPlan(values);
    const authorization = readBoundedJson(
      required(values, '--authorization'),
      'authorization',
    );
    const isolation = readBoundedJson(required(values, '--isolation'), 'isolation');
    const execution = readBoundedJson(required(values, '--execution'), 'execution');
    const restore = readBoundedJson(required(values, '--restore'), 'restore');
    const outcomes = {
      'ssh-loss': readBoundedJson(required(values, '--ssh-loss'), 'ssh_loss'),
      'failed-health': readBoundedJson(
        required(values, '--failed-health'),
        'failed_health',
      ),
      'guest-reboot': readBoundedJson(
        required(values, '--guest-reboot'),
        'guest_reboot',
      ),
    };
    return {
      ok: true,
      command,
      ...collectBundle(
        {
          plan,
          authorization,
          isolation,
          execution,
          restore,
          outcomes,
          keys: readKeys(values),
        },
        required(values, '--output-dir'),
      ),
    };
  }
  if (command === 'verify') {
    return {
      ok: true,
      command,
      ...verifyBundle(required(values, '--bundle'), readKeys(values)),
    };
  }
  if (command === 'request') {
    const verified = verifyBundle(required(values, '--bundle'), readKeys(values));
    const payload = buildRollbackRequest(verified, required(values, '--operator'));
    const output = publishRequest(required(values, '--output'), payload);
    return {
      ok: true,
      command,
      output,
      payloadSha256: sha256Json(payload),
      machineEvidenceSha256: payload.machineEvidenceSha256,
      targetBackupSha256: payload.targetBackupSha256,
    };
  }
  if (command === 'execute') {
    const plan = readPlan(values);
    const keys = readKeys(values);
    validateKeySet(plan, keys);
    validateOwnerAuthorization(
      readBoundedJson(required(values, '--authorization'), 'authorization'),
      plan,
      keys.guestOwnerPublicKeyPem,
    );
    const isolation = readBoundedJson(required(values, '--isolation'), 'isolation');
    validateIsolationEvidence(
      isolation,
      plan,
    );
    return {
      ok: true,
      command,
      planId: plan.planId,
      ...executeSequentialDrills(plan, isolation, keys, values),
    };
  }
  fail('command_unsupported');
}

try {
  const result = main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const code = error instanceof EvidenceError ? error.code : 'unexpected_error';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  if (code === 'command_unsupported') usage();
  process.exitCode = 1;
}

// Keep public-key identity helpers reachable for deterministic fixture tools
// without adding a second CLI or a signing surface.
export { publicKeyIdentity, textKeyIdentity };
