#!/usr/bin/node
// Root-owned, strictly sequential controller for release-layout KVM drills.
// It is the only production producer of scenario-result files. The controller
// starts the fixed guest, observes QEMU and the SSH/boot fault boundary, asks
// the guest root executor to sign its measured recovery, then signs the
// independent hypervisor observation with the set-bound root-only key.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'nexus-release-layout-fault-controller.v1';
const PLAN_VERIFICATION_SCHEMA =
  'nexus.release-layout-fault-plan-verification.v1';
const STATE_ROOT = '/var/lib/nexus-rollback-drill-vm/release-layout-fault-drills';
const ACTIVE_RECEIPT = '/var/lib/nexus-rollback-drill-vm/active.json';
const TRUST_MANIFEST =
  '/var/lib/nexus-rollback-drill-vm/release-layout-evidence-trust.v1.json';
const SELF_PATH =
  '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller';
const UNIT_PATH =
  '/etc/systemd/system/nexus-release-layout-fault-drill@.service';
const RECOVERY_UNIT_PATH =
  '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service';
const DRILL_TOOL =
  '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs';
const SYSTEMCTL = '/usr/bin/systemctl';
const FLOCK = '/usr/bin/flock';
const SSH = '/usr/bin/ssh';
const SCP = '/usr/bin/scp';
const CONTROLLER_LOCK =
  '/run/nexus-rollback-drill-vm/release-layout-fault-controller.lock';
const SSH_KEY = '/etc/nexus-release/rollback-drill-vm-ssh-private.pem';
const GUEST_EXECUTOR = '/usr/local/sbin/nexus-release-layout-fault-guest';
const SCENARIOS = Object.freeze([
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
]);
const SCENARIO_GUESTS = Object.freeze({
  failed_health_check: 'guest-2',
  host_reboot_during_migration: 'guest-3',
  ssh_disconnect_after_pm2_stop: 'guest-1',
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(`release layout fault controller: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail(`${label} fields are invalid`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function planSha256(plan) {
  return sha256(Buffer.from(canonicalJson(plan), 'utf8'));
}

function sourceSha256(source) {
  return sha256(Buffer.from(canonicalJson(source), 'utf8'));
}

function boundedFile(file, label, {
  maximum = 1024 * 1024,
  mode,
  rootOwned = true,
} = {}) {
  const resolved = path.resolve(file);
  const identity = fs.lstatSync(resolved);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || identity.size < 1 || identity.size > maximum
      || (mode !== undefined && (identity.mode & 0o7777) !== mode)
      || (rootOwned && (identity.uid !== 0 || identity.gid !== 0))) {
    fail(`${label} identity is unsafe`);
  }
  return resolved;
}

function readJson(file, label, options) {
  const resolved = boundedFile(file, label, options);
  const body = fs.readFileSync(resolved);
  return { body, value: JSON.parse(body.toString('utf8')) };
}

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function durableWrite(file, body, mode = 0o600) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(file)}.${randomUUID()}`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.linkSync(temporary, file);
  fs.rmSync(temporary);
  fsyncDirectory(parent);
}

function replaceJson(file, value) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(file)}.${randomUUID()}`);
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(parent);
}

function program(executable, args, label, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    killSignal: 'SIGTERM',
    maxBuffer: 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0) {
    fail(`${label} failed`);
  }
  return result;
}

function acquireControllerLock() {
  const parent = path.dirname(CONTROLLER_LOCK);
  const parentIdentity = fs.lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()
      || parentIdentity.uid !== 0
      || (parentIdentity.mode & 0o7777) !== 0o750
      || fs.realpathSync(parent) !== parent) {
    fail('controller lock directory identity is unsafe');
  }
  const descriptor = fs.openSync(
    CONTROLLER_LOCK,
    fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const identity = fs.fstatSync(descriptor);
    if (!identity.isFile() || identity.nlink !== 1 || identity.uid !== 0
        || identity.gid !== 0 || (identity.mode & 0o7777) !== 0o600) {
      fail('controller lock identity is unsafe');
    }
    // flock(2) is attached to the inherited open-file description. The lock
    // therefore remains held by this process after /usr/bin/flock exits and
    // is released automatically on close, process failure, or host reboot.
    const lock = spawnSync(FLOCK, ['--nonblock', '3'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      timeout: 10_000,
    });
    if (lock.status !== 0) fail('another fault-drill controller holds the lock');
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function releaseControllerLock(descriptor) {
  fs.closeSync(descriptor);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function bootId() {
  const value = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!BOOT_ID.test(value)) fail('hypervisor boot identity is invalid');
  return value;
}

function monotonicMilliseconds() {
  const value = Math.floor(Number.parseFloat(
    fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/u)[0],
  ) * 1000);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('hypervisor monotonic clock is invalid');
  }
  return value;
}

function publicPem(privateKey) {
  return createPublicKey(privateKey)
    .export({ format: 'pem', type: 'spki' }).toString();
}

function validateFixedRuntime() {
  boundedFile(SELF_PATH, 'installed hypervisor controller', {
    maximum: 1024 * 1024,
    mode: 0o755,
  });
  boundedFile(UNIT_PATH, 'installed hypervisor controller unit', {
    maximum: 64 * 1024,
    mode: 0o644,
  });
  boundedFile(RECOVERY_UNIT_PATH, 'installed hypervisor recovery unit', {
    maximum: 64 * 1024,
    mode: 0o644,
  });
  boundedFile(DRILL_TOOL, 'installed release-layout drill verifier', {
    maximum: 1024 * 1024,
    mode: 0o755,
  });
  boundedFile(SSH_KEY, 'dedicated KVM SSH private key', {
    maximum: 64 * 1024,
    mode: 0o600,
  });
  for (const executable of [SYSTEMCTL, FLOCK, SSH, SCP]) {
    boundedFile(executable, 'fixed controller executable', {
      maximum: 16 * 1024 * 1024,
      rootOwned: true,
    });
  }
}

function validatePlanAndTrust(
  planInput,
  { allowExpiredRecovery = false } = {},
) {
  const trustInput = readJson(TRUST_MANIFEST, 'root KVM trust manifest', {
    maximum: 256 * 1024,
    mode: 0o600,
  });
  const receiptInput = readJson(ACTIVE_RECEIPT, 'active KVM provision receipt', {
    maximum: 256 * 1024,
    mode: 0o640,
    rootOwned: false,
  });
  if (fs.lstatSync(ACTIVE_RECEIPT).uid !== 0) {
    fail('active KVM provision receipt is not root-owned');
  }
  const verificationArgs = [
    DRILL_TOOL,
    'verify-plan',
    '--plan',
    planInput.file,
    '--trust-manifest',
    TRUST_MANIFEST,
    '--provision-receipt',
    ACTIVE_RECEIPT,
    '--require-root-trust',
  ];
  if (allowExpiredRecovery) verificationArgs.push('--allow-expired-recovery');
  const validation = program(
    process.execPath,
    verificationArgs,
    'deep plan and root trust verification',
  );
  const summary = JSON.parse(validation.stdout);
  if (summary.ok !== true || summary.schema !== PLAN_VERIFICATION_SCHEMA
      || summary.planId !== planInput.value.planId
      || summary.planSha256 !== planSha256(planInput.value)
      || typeof summary.lifetimeActive !== 'boolean') {
    fail('deep plan verification summary is invalid');
  }
  const producer = planInput.value.trust?.producers?.hypervisor;
  exactKeys(producer, [
    'controllerPath',
    'controllerSha256',
    'controllerRecoveryUnitPath',
    'controllerRecoveryUnitSha256',
    'controllerUnitPath',
    'controllerUnitSha256',
    'verifierPath',
    'verifierSha256',
  ], 'hypervisor producer');
  if (producer.controllerPath !== SELF_PATH
      || producer.controllerRecoveryUnitPath !== RECOVERY_UNIT_PATH
      || producer.controllerUnitPath !== UNIT_PATH
      || producer.verifierPath !== DRILL_TOOL
      || producer.controllerSha256 !== sha256(fs.readFileSync(SELF_PATH))
      || producer.controllerRecoveryUnitSha256
        !== sha256(fs.readFileSync(RECOVERY_UNIT_PATH))
      || producer.controllerUnitSha256 !== sha256(fs.readFileSync(UNIT_PATH))
      || producer.verifierSha256 !== sha256(fs.readFileSync(DRILL_TOOL))) {
    fail('installed hypervisor producer differs from the drill trust');
  }
  if (sha256(trustInput.body) !== planInput.value.trust.trustManifestSha256
      || sha256(receiptInput.body)
        !== planInput.value.trust.provisionReceiptSha256) {
    fail('plan differs from the active root trust chain');
  }
  return {
    trust: trustInput.value,
    receipt: receiptInput.value,
  };
}

function planRoot(planId) {
  if (!UUID.test(planId)) fail('plan id is invalid');
  return path.join(STATE_ROOT, planId);
}

function journalFile(planId) {
  return path.join(planRoot(planId), 'controller-journal.v1.json');
}

function stagedPlan(planId) {
  return path.join(planRoot(planId), 'plan.json');
}

function activePlanLifetime(plan) {
  const created = Date.parse(plan.createdAt ?? '');
  const expires = Date.parse(plan.expiresAt ?? '');
  const now = Date.now();
  return Number.isFinite(created) && Number.isFinite(expires)
    && created <= now + 60_000 && expires >= now;
}

function requireActivePlanLifetime(plan, operation) {
  if (!activePlanLifetime(plan)) {
    fail(`plan lifetime ended before ${operation}`);
  }
}

const CONTROLLER_STATUSES = Object.freeze([
  'submitted',
  'running',
  'collecting',
  'completed',
  'recovering_failure',
  'failed_recovered',
  'recovery_required',
  'expired_recovered',
]);
const CONTROLLER_PHASES = Object.freeze([
  'idle',
  'starting_guest',
  'guest_started',
  'staging_plan',
  'plan_staged',
  'arming_fault',
  'fault_armed',
  'waiting_recovery',
  'guest_recovered',
  'sealing',
  'sealed',
  'recording_result',
  'result_recorded',
  'cleaning_guest',
  'stopping_guest',
  'collecting',
  'completed',
  'failure_recovery',
  'failed_recovered',
  'expired_recovered',
  'recovery_required',
]);

export function validateControllerJournal(value, plan) {
  exactKeys(value, [
    'activeGuest',
    'authenticatedAt',
    'completedAt',
    'completedScenarios',
    'controllerBootId',
    'drillSha256',
    'executionMode',
    'expiresAt',
    'failure',
    'maximumActiveGuests',
    'phase',
    'planId',
    'planSha256',
    'provisionReceiptSha256',
    'scenarioState',
    'schema',
    'status',
    'submittedAt',
    'trustManifestSha256',
    'updatedAt',
  ], 'controller journal');
  if (value.schema !== 'nexus.release-layout-fault-controller-journal.v2'
      || value.planId !== plan.planId
      || value.planSha256 !== planSha256(plan)
      || value.executionMode !== 'strictly-sequential'
      || value.maximumActiveGuests !== 1
      || value.expiresAt !== plan.expiresAt
      || value.trustManifestSha256 !== plan.trust.trustManifestSha256
      || value.provisionReceiptSha256 !== plan.trust.provisionReceiptSha256
      || !BOOT_ID.test(value.controllerBootId ?? '')
      || !CONTROLLER_STATUSES.includes(value.status)
      || !CONTROLLER_PHASES.includes(value.phase)
      || !Array.isArray(value.completedScenarios)
      || value.completedScenarios.some(
        (scenarioId, index) => scenarioId !== SCENARIOS[index],
      )
      || !Number.isFinite(Date.parse(value.authenticatedAt ?? ''))
      || Date.parse(value.authenticatedAt) < Date.parse(plan.createdAt) - 60_000
      || Date.parse(value.authenticatedAt) > Date.parse(plan.expiresAt)
      || !Number.isFinite(Date.parse(value.submittedAt ?? ''))
      || !Number.isFinite(Date.parse(value.updatedAt ?? ''))) {
    fail('controller journal identity is invalid');
  }
  if (value.failure !== null) {
    exactKeys(value.failure, ['at', 'messageSha256'], 'controller failure');
    if (!Number.isFinite(Date.parse(value.failure.at ?? ''))
        || !DIGEST.test(value.failure.messageSha256 ?? '')) {
      fail('controller failure identity is invalid');
    }
  }
  if ((value.completedAt !== null
        && !Number.isFinite(Date.parse(value.completedAt ?? '')))
      || (value.drillSha256 !== null
        && !DIGEST.test(value.drillSha256 ?? ''))) {
    fail('controller completion identity is invalid');
  }
  if (value.activeGuest !== null) {
    exactKeys(value.activeGuest, ['name', 'port', 'unit'], 'active guest journal');
    if (!Object.values(SCENARIO_GUESTS).includes(value.activeGuest.name)
        || value.activeGuest.unit
          !== `nexus-rollback-drill-vm@${value.activeGuest.name}.service`
        || !Number.isSafeInteger(value.activeGuest.port)
        || value.activeGuest.port < 1024 || value.activeGuest.port > 65535) {
      fail('active guest journal identity is invalid');
    }
  }
  if (value.scenarioState !== null) {
    exactKeys(value.scenarioState, [
      'beforeGuestBootId',
      'connectionDropped',
      'observerBootId',
      'observerStartMonotonicMilliseconds',
      'scenarioId',
    ], 'controller scenario state');
    if (!SCENARIOS.includes(value.scenarioState.scenarioId)
        || !BOOT_ID.test(value.scenarioState.beforeGuestBootId ?? '')
        || !BOOT_ID.test(value.scenarioState.observerBootId ?? '')
        || !Number.isSafeInteger(
          value.scenarioState.observerStartMonotonicMilliseconds,
        )
        || typeof value.scenarioState.connectionDropped !== 'boolean') {
      fail('controller scenario state is invalid');
    }
  }
  const statusPhases = {
    submitted: ['idle'],
    running: [
      'idle',
      'starting_guest',
      'guest_started',
      'staging_plan',
      'plan_staged',
      'arming_fault',
      'fault_armed',
      'waiting_recovery',
      'guest_recovered',
      'sealing',
      'sealed',
      'recording_result',
      'result_recorded',
      'cleaning_guest',
      'stopping_guest',
    ],
    collecting: ['collecting'],
    completed: ['completed'],
    recovering_failure: ['failure_recovery'],
    failed_recovered: ['failed_recovered'],
    recovery_required: ['recovery_required'],
    expired_recovered: ['expired_recovered'],
  };
  const authenticatedAt = Date.parse(value.authenticatedAt);
  const submittedAt = Date.parse(value.submittedAt);
  const updatedAt = Date.parse(value.updatedAt);
  const completedAt = value.completedAt === null
    ? null
    : Date.parse(value.completedAt);
  const terminal = [
    'completed',
    'failed_recovered',
    'expired_recovered',
  ].includes(value.status);
  if (!statusPhases[value.status]?.includes(value.phase)
      || submittedAt < authenticatedAt || updatedAt < submittedAt
      || submittedAt > Date.parse(plan.expiresAt)
      || (completedAt !== null
        && (!Number.isFinite(completedAt)
          || completedAt < submittedAt || completedAt > updatedAt))
      || (value.failure !== null
        && (Date.parse(value.failure.at) < submittedAt
          || Date.parse(value.failure.at) > updatedAt))
      || terminal !== (completedAt !== null)
      || (value.status === 'completed') !== (value.drillSha256 !== null)
      || (['collecting', 'completed'].includes(value.status)
        && value.completedScenarios.length !== SCENARIOS.length)
      || (terminal && value.activeGuest !== null)
      || (terminal && value.scenarioState !== null)
      || (value.status === 'recovery_required' && value.activeGuest === null)
      || (['recovering_failure'].includes(value.status)
        && value.activeGuest === null)
      || (['submitted', 'running', 'collecting', 'completed'].includes(
        value.status,
      ) && value.failure !== null)
      || (['recovering_failure', 'failed_recovered', 'recovery_required',
        'expired_recovered']
        .includes(value.status) && value.failure === null)
      || (value.scenarioState !== null && value.activeGuest === null)
      || (value.scenarioState !== null && value.activeGuest !== null
        && SCENARIO_GUESTS[value.scenarioState.scenarioId]
          !== value.activeGuest.name)) {
    fail('controller journal state is invalid');
  }
  return value;
}

function loadControllerJournal(planId, plan) {
  return validateControllerJournal(readJson(
    journalFile(planId),
    'controller journal',
    { maximum: 128 * 1024, mode: 0o600 },
  ).value, plan);
}

function checkpointController(planId, plan, patch) {
  const current = loadControllerJournal(planId, plan);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  validateControllerJournal(next, plan);
  replaceJson(journalFile(planId), next);
  return next;
}

function failureIdentity(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    at: new Date().toISOString(),
    messageSha256: sha256(Buffer.from(message, 'utf8')),
  };
}

function sshOptions(guest, knownHosts) {
  return [
    '-i',
    SSH_KEY,
    '-p',
    String(guest.port),
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'PasswordAuthentication=no',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'ConnectionAttempts=1',
  ];
}

function sshTarget() {
  return 'dominguez@127.0.0.1';
}

function remote(guest, knownHosts, args, label, options = {}) {
  return program(
    SSH,
    [...sshOptions(guest, knownHosts), sshTarget(), ...args],
    label,
    options,
  );
}

function waitSsh(guest, knownHosts, expectedUp) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const result = remote(
      guest,
      knownHosts,
      ['/usr/bin/true'],
      'SSH readiness probe',
      { allowFailure: true, timeout: 10_000 },
    );
    if ((result.status === 0) === expectedUp) return;
    sleep(500);
  }
  fail(`guest SSH did not become ${expectedUp ? 'ready' : 'unavailable'}`);
}

function guestBootId(guest, knownHosts) {
  const result = remote(
    guest,
    knownHosts,
    ['/usr/bin/cat', '/proc/sys/kernel/random/boot_id'],
    'guest boot identity',
  );
  const value = result.stdout.trim();
  if (!BOOT_ID.test(value)) fail('guest returned an invalid boot identity');
  return value;
}

function guestEntry(receipt, guestName) {
  const entry = receipt.guests?.find((guest) => guest?.name === guestName);
  if (!entry || entry.unit !== `nexus-rollback-drill-vm@${guestName}.service`
      || !Number.isSafeInteger(entry.port)
      || entry.port < 1024 || entry.port > 65535
      || typeof entry.hostPublicKey !== 'string'
      || sha256(Buffer.from(entry.hostPublicKey.trim(), 'utf8'))
        !== entry.hostPublicKeySha256) {
    fail('active provision guest identity is invalid');
  }
  return entry;
}

function writeKnownHosts(root, guest) {
  const file = path.join(root, 'known_hosts');
  const body = Buffer.from(
    `[127.0.0.1]:${guest.port} ${guest.hostPublicKey.trim()}\n`,
  );
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(boundedFile(
      file,
      'scenario known-hosts file',
      { maximum: 64 * 1024, mode: 0o600 },
    ));
    if (!existing.equals(body)) fail('scenario known-hosts identity drifted');
  } else {
    durableWrite(file, body);
  }
  return file;
}

function stagePlanInGuest(planFile, plan, scenarioId, guest, knownHosts) {
  const remotePlan = `/tmp/nexus-release-layout-plan-${plan.planId}.json`;
  const copied = program(SCP, [
    ...sshOptions(guest, knownHosts),
    planFile,
    `${sshTarget()}:${remotePlan}`,
  ], 'copy immutable plan to guest');
  if (copied.status !== 0) fail('cannot stage the immutable plan in the guest');
  remote(
    guest,
    knownHosts,
    [
      '/usr/bin/sudo',
      '-n',
      GUEST_EXECUTOR,
      'stage',
      remotePlan,
      scenarioId,
    ],
    'stage guest scenario',
  );
  remote(
    guest,
    knownHosts,
    ['/usr/bin/rm', '-f', remotePlan],
    'remove unprivileged guest plan copy',
  );
}

function waitGuestRecovered(planId, scenarioId, guest, knownHosts) {
  const deadline = Date.now() + 120_000;
  while (Date.now() <= deadline) {
    const result = remote(
      guest,
      knownHosts,
      [
        '/usr/bin/sudo',
        '-n',
        GUEST_EXECUTOR,
        'fetch',
        planId,
        scenarioId,
      ],
      'fetch guest recovery status',
      { allowFailure: true, timeout: 10_000 },
    );
    if (result.status === 0) {
      const value = JSON.parse(result.stdout);
      if (value.ok === true && ['recovered', 'sealed'].includes(value.status)) {
        return value;
      }
    }
    sleep(500);
  }
  fail('guest did not recover within 120 seconds');
}

function observeQemu(guest, scenarioId, connectionDropped, guestRebootObserved) {
  const pidResult = program(SYSTEMCTL, [
    'show',
    '--property=MainPID',
    '--value',
    '--',
    guest.unit,
  ], 'read active guest MainPID');
  const pid = Number.parseInt(pidResult.stdout.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    fail('active guest QEMU pid is invalid');
  }
  const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`);
  const fields = commandLine.toString('utf8').split('\0').filter(Boolean);
  const joined = fields.join(' ');
  const expectedOverlay = guest.overlayPath;
  const expectedForward = `hostfwd=tcp:127.0.0.1:${guest.port}-:22`;
  if (fields[0] !== '/usr/bin/qemu-system-x86_64'
      || !fields.includes('-enable-kvm')
      || !joined.includes('-machine q35,accel=kvm')
      || !joined.includes(expectedOverlay)
      || !joined.includes(expectedForward)
      || !joined.includes('restrict=on')
      || /(?:^|\s)-(?:virtfs|fsdev|blockdev)\b/u.test(joined)
      || /\b(?:bridge|tap|smb|nfs)\b/iu.test(joined)
      || joined.includes('/home/dominguez/telegram-hub-bot')
      || joined.includes('/srv/nexus-release/production')) {
    fail('live QEMU isolation differs from the provisioned policy');
  }
  return {
    systemdUnit: guest.unit,
    qemuMainPid: pid,
    qemuCommandLineSha256: sha256(commandLine),
    guestSshHostPublicKeySha256: guest.hostPublicKeySha256,
    sshDisconnectObserved:
      scenarioId === 'ssh_disconnect_after_pm2_stop' ? connectionDropped : false,
    guestRebootObserved:
      scenarioId === 'host_reboot_during_migration' ? guestRebootObserved : false,
  };
}

function sealGuestEvidence(
  root,
  plan,
  scenarioId,
  guest,
  knownHosts,
  observer,
) {
  const observerFile = path.join(root, `${scenarioId}.observer.json`);
  replaceJson(observerFile, observer);
  const remoteObserver = `/tmp/nexus-release-layout-observer-${plan.planId}.json`;
  program(SCP, [
    ...sshOptions(guest, knownHosts),
    observerFile,
    `${sshTarget()}:${remoteObserver}`,
  ], 'copy hypervisor observation to guest');
  remote(
    guest,
    knownHosts,
    [
      '/usr/bin/sudo',
      '-n',
      GUEST_EXECUTOR,
      'seal',
      plan.planId,
      scenarioId,
      remoteObserver,
    ],
    'seal guest execution evidence',
  );
  remote(
    guest,
    knownHosts,
    ['/usr/bin/rm', '-f', remoteObserver],
    'remove unprivileged observer copy',
  );
  const fetched = remote(
    guest,
    knownHosts,
    [
      '/usr/bin/sudo',
      '-n',
      GUEST_EXECUTOR,
      'fetch',
      plan.planId,
      scenarioId,
    ],
    'fetch sealed guest execution evidence',
  );
  const bundle = JSON.parse(fetched.stdout);
  if (bundle.ok !== true || bundle.status !== 'sealed'
      || bundle.planId !== plan.planId || bundle.scenarioId !== scenarioId
      || typeof bundle.executionEvidenceBase64 !== 'string'
      || typeof bundle.executionSignatureBase64 !== 'string') {
    fail('guest returned an invalid sealed evidence bundle');
  }
  const executionBody = Buffer.from(bundle.executionEvidenceBase64, 'base64');
  const signature = Buffer.from(bundle.executionSignatureBase64, 'base64');
  if (executionBody.toString('base64') !== bundle.executionEvidenceBase64
      || signature.toString('base64') !== bundle.executionSignatureBase64
      || signature.length !== 64
      || !cryptoVerify(
        null,
        executionBody,
        createPublicKey(plan.trust.guestEd25519PublicKeys[scenarioId]),
        signature,
      )) {
    fail('guest evidence signature or encoding is invalid');
  }
  return {
    body: executionBody,
    signature,
    value: JSON.parse(executionBody.toString('utf8')),
  };
}

function buildScenarioResult(
  plan,
  scenarioId,
  guest,
  execution,
  observer,
  qemuObservation,
  hypervisorPrivateKey,
) {
  requireActivePlanLifetime(plan, 'hypervisor evidence signing');
  const producer = plan.trust.producers.hypervisor;
  const isolation = {
    schema: 'nexus.release-layout-hypervisor-isolation-evidence.v1',
    planId: plan.planId,
    planSha256: planSha256(plan),
    challengeNonce: plan.challengeNonce,
    scenarioId,
    guestId: SCENARIO_GUESTS[scenarioId],
    hypervisor: 'qemu-kvm',
    kvmAcceleration: true,
    independentOverlay: true,
    loopbackSshOnly: true,
    productionDataMounted: false,
    productionSecretsPresent: false,
    productionNetworkReachable: false,
    executionEvidenceSha256: sha256(execution.body),
    observer,
    guest: execution.value.guest,
    producer,
    faultObservation: qemuObservation,
    createdAt: new Date().toISOString(),
  };
  const isolationBody = Buffer.from(`${JSON.stringify(isolation, null, 2)}\n`);
  const isolationSignature = cryptoSign(null, isolationBody, hypervisorPrivateKey);
  if (isolationSignature.length !== 64) fail('hypervisor signature length is invalid');
  const hypervisorKey = plan.trust.hypervisorEd25519PublicKey;
  const guestKey = plan.trust.guestEd25519PublicKeys[scenarioId];
  return {
    schema: 'nexus.release-layout-fault-scenario-result.v2',
    producerVersion: 'nexus-release-layout-fault-drill.v1',
    planId: plan.planId,
    planSha256: planSha256(plan),
    migrationId: plan.migrationId,
    scenarioId,
    status: 'passed',
    sourceSha256: sourceSha256(plan.source),
    proof: {
      schema: 'nexus.release-layout-kvm-proof.v1',
      challengeNonce: plan.challengeNonce,
      hypervisorPublicKeySha256: sha256(Buffer.from(hypervisorKey, 'utf8')),
      guestPublicKeySha256: sha256(Buffer.from(guestKey, 'utf8')),
      isolationEvidenceBase64: isolationBody.toString('base64'),
      isolationSignatureBase64: isolationSignature.toString('base64'),
      executionEvidenceBase64: execution.body.toString('base64'),
      executionSignatureBase64: execution.signature.toString('base64'),
    },
    isolation: {
      hypervisor: 'qemu-kvm',
      kvmAcceleration: true,
      independentOverlay: true,
      loopbackSshOnly: true,
      guestId: guest.name,
    },
    recovery: {
      observerBootId: observer.bootId,
      durationMilliseconds: observer.durationMilliseconds,
      targetMilliseconds: 120000,
      terminalStatus: 'recovered',
      guestBootIdBefore: execution.value.guest.bootIdBefore,
      guestBootIdAfter: execution.value.guest.bootIdAfter,
      exactPredecessorRestored: true,
      databaseRecoveryVerified: true,
      healthRestored: true,
      connectionDropped: scenarioId !== 'failed_health_check',
    },
    producerTrust: {
      controllerSha256: producer.controllerSha256,
      controllerRecoveryUnitSha256:
        producer.controllerRecoveryUnitSha256,
      controllerUnitSha256: producer.controllerUnitSha256,
      guestExecutorSha256:
        plan.trust.producers.guests[scenarioId].executorSha256,
      guestRecoveryUnitSha256:
        plan.trust.producers.guests[scenarioId].recoveryUnitSha256,
    },
    isolationEvidenceSha256: sha256(isolationBody),
    executionEvidenceSha256: sha256(execution.body),
    completedAt: execution.value.completedAt,
    recordedAt: new Date().toISOString(),
  };
}

function existingScenarioResult(root, plan, scenarioId) {
  const resultFile = path.join(root, `${scenarioId}.result.json`);
  if (!fs.existsSync(resultFile)) return null;
  const result = readJson(resultFile, 'existing scenario result', {
    maximum: 512 * 1024,
    mode: 0o600,
  }).value;
  if (result.schema !== 'nexus.release-layout-fault-scenario-result.v2'
      || result.planId !== plan.planId
      || result.planSha256 !== planSha256(plan)
      || result.scenarioId !== scenarioId
      || result.status !== 'passed') {
    fail('existing scenario result identity is invalid');
  }
  program(process.execPath, [
    DRILL_TOOL,
    'verify-result',
    '--plan',
    stagedPlan(plan.planId),
    '--scenario',
    scenarioId,
    '--input',
    resultFile,
  ], 'deeply verify existing scenario result');
  return resultFile;
}

function parseUnitState(result) {
  if (result.status !== 0) return null;
  const fields = Object.fromEntries(
    result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return separator < 1
        ? ['', '']
        : [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );
  const pid = Number(fields.MainPID);
  if (Object.keys(fields).sort().join(',')
      !== ['ActiveState', 'LoadState', 'MainPID', 'SubState'].sort().join(',')
      || !Number.isSafeInteger(pid) || pid < 0) {
    return null;
  }
  return { ...fields, pid };
}

export function stopGuest(guest, {
  invoke = program,
  pidExists = (pid) => fs.existsSync(`/proc/${pid}`),
} = {}) {
  const showArguments = [
    'show',
    '--property=LoadState',
    '--property=ActiveState',
    '--property=SubState',
    '--property=MainPID',
    '--',
    guest.unit,
  ];
  const before = parseUnitState(invoke(
    SYSTEMCTL,
    showArguments,
    'inspect isolated KVM guest before stop',
    { allowFailure: true },
  ));
  if (before === null || before.LoadState !== 'loaded') return false;
  invoke(
    SYSTEMCTL,
    ['stop', '--', guest.unit],
    'stop isolated KVM guest',
    { allowFailure: true },
  );
  const after = parseUnitState(invoke(
    SYSTEMCTL,
    showArguments,
    'verify isolated KVM guest stopped',
    { allowFailure: true },
  ));
  return after !== null
    && after.LoadState === 'loaded'
    && after.ActiveState === 'inactive'
    && after.SubState === 'dead'
    && after.pid === 0
    && (before.pid === 0 || !pidExists(before.pid));
}

function recoverGuestTransaction(plan, scenarioId, guest, knownHosts) {
  let recovered = false;
  let stopped = false;
  try {
    program(
      SYSTEMCTL,
      ['start', '--', guest.unit],
      'start guest for failure recovery',
    );
    waitSsh(guest, knownHosts, true);
    const recovery = remote(
      guest,
      knownHosts,
      [
        '/usr/bin/sudo',
        '-n',
        GUEST_EXECUTOR,
        'recover-if-present',
        plan.planId,
        scenarioId,
      ],
      'resume guest recovery after controller failure',
    );
    const response = JSON.parse(recovery.stdout);
    if (response.ok !== true
        || !['not_armed', 'recovered'].includes(response.status)) {
      fail('guest returned an invalid recovery response');
    }
    recovered = response.status === 'not_armed';
    if (!recovered) {
      const status = waitGuestRecovered(
        plan.planId,
        scenarioId,
        guest,
        knownHosts,
      );
      recovered = ['recovered', 'sealed'].includes(status.status);
    }
    if (recovered) {
      remote(
        guest,
        knownHosts,
        [
          '/usr/bin/sudo',
          '-n',
          GUEST_EXECUTOR,
          'cleanup',
          plan.planId,
          scenarioId,
        ],
        'clean recovered guest after controller failure',
        { allowFailure: true },
      );
    }
  } catch {
    recovered = false;
  } finally {
    stopped = stopGuest(guest);
  }
  return recovered && stopped;
}

function executeScenario(root, planFile, plan, receipt, scenarioId, privateKey) {
  const guestName = SCENARIO_GUESTS[scenarioId];
  const guest = guestEntry(receipt, guestName);
  const knownHosts = writeKnownHosts(
    path.join(root, `${scenarioId}.host-trust`),
    guest,
  );
  let existing;
  try {
    existing = existingScenarioResult(root, plan, scenarioId);
  } catch (error) {
    const recovered = recoverGuestTransaction(
      plan,
      scenarioId,
      guest,
      knownHosts,
    );
    checkpointController(plan.planId, plan, {
      status: recovered ? 'failed_recovered' : 'recovery_required',
      phase: recovered ? 'failed_recovered' : 'recovery_required',
      activeGuest: recovered ? null : {
        name: guest.name,
        port: guest.port,
        unit: guest.unit,
      },
      scenarioState: recovered
        ? null
        : loadControllerJournal(plan.planId, plan).scenarioState,
      failure: failureIdentity(error),
      completedAt: recovered ? new Date().toISOString() : null,
    });
    throw error;
  }
  if (existing) {
    const cleaned = recoverGuestTransaction(
      plan,
      scenarioId,
      guest,
      knownHosts,
    );
    if (!cleaned) {
      checkpointController(plan.planId, plan, {
        status: 'recovery_required',
        phase: 'recovery_required',
        activeGuest: {
          name: guest.name,
          port: guest.port,
          unit: guest.unit,
        },
        failure: failureIdentity(
          new Error('cannot clean guest for an existing scenario result'),
        ),
      });
      fail('cannot clean guest for an existing scenario result');
    }
    return existing;
  }
  const prior = loadControllerJournal(plan.planId, plan);
  checkpointController(plan.planId, plan, {
    status: 'running',
    phase: 'starting_guest',
    activeGuest: {
      name: guest.name,
      port: guest.port,
      unit: guest.unit,
    },
    scenarioState: prior.scenarioState?.scenarioId === scenarioId
      ? prior.scenarioState
      : null,
  });
  try {
    program(SYSTEMCTL, ['start', '--', guest.unit], 'start isolated KVM guest');
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'guest_started',
    });
    waitSsh(guest, knownHosts, true);
    let journal = loadControllerJournal(plan.planId, plan);
    let scenarioState = journal.scenarioState;
    if (scenarioState?.scenarioId !== scenarioId) {
      scenarioState = {
        scenarioId,
        beforeGuestBootId: guestBootId(guest, knownHosts),
        observerBootId: bootId(),
        observerStartMonotonicMilliseconds: monotonicMilliseconds(),
        connectionDropped: false,
      };
    }
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'staging_plan',
      scenarioState,
    });
    requireActivePlanLifetime(plan, 'guest plan staging');
    stagePlanInGuest(planFile, plan, scenarioId, guest, knownHosts);
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'plan_staged',
    });
    requireActivePlanLifetime(plan, 'fault arming');
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'arming_fault',
    });
    let connectionDropped = scenarioState.connectionDropped;
    if (scenarioId === 'failed_health_check') {
      const fault = remote(
        guest,
        knownHosts,
        [
          '/usr/bin/sudo',
          '-n',
          GUEST_EXECUTOR,
          'run',
          plan.planId,
          scenarioId,
        ],
        'execute failed-health guest scenario',
      );
      const response = JSON.parse(fault.stdout);
      if (response.ok !== true || response.status !== 'recovered') {
        fail('failed-health scenario did not recover');
      }
    } else {
      const fault = remote(
        guest,
        knownHosts,
        [
          '/usr/bin/sudo',
          '-n',
          GUEST_EXECUTOR,
          'run',
          plan.planId,
          scenarioId,
        ],
        'execute disconnecting guest scenario',
        {
          allowFailure: true,
          timeout: scenarioId === 'ssh_disconnect_after_pm2_stop'
            ? 2000 : 30_000,
        },
      );
      const armed = fault.stdout.includes(
        `NEXUS_RELEASE_LAYOUT_FAULT_ARMED ${plan.planId} ${scenarioId}`,
      );
      let resumed = false;
      if (!armed && fault.status === 0) {
        const response = JSON.parse(fault.stdout);
        resumed = response.ok === true && response.status === 'recovered'
          && response.resumed === true;
      }
      if (!armed && !resumed) fail('guest did not durably arm or resume the fault');
      connectionDropped = connectionDropped
        || (armed && (fault.status !== 0 || fault.signal === 'SIGTERM'));
      if (!connectionDropped) {
        fail('controller lacks a durable disconnect observation');
      }
      if (scenarioId === 'host_reboot_during_migration' && armed) {
        waitSsh(guest, knownHosts, false);
        waitSsh(guest, knownHosts, true);
      }
    }
    scenarioState = { ...scenarioState, connectionDropped };
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'fault_armed',
      scenarioState,
    });
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'waiting_recovery',
    });
    waitGuestRecovered(plan.planId, scenarioId, guest, knownHosts);
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'guest_recovered',
    });
    requireActivePlanLifetime(plan, 'guest evidence sealing');
    const afterGuestBootId = guestBootId(guest, knownHosts);
    const rebootObserved =
      scenarioState.beforeGuestBootId !== afterGuestBootId;
    if ((scenarioId === 'host_reboot_during_migration') !== rebootObserved) {
      fail('observed guest boot boundary differs from the requested scenario');
    }
    if (bootId() !== scenarioState.observerBootId) {
      fail('hypervisor rebooted during the guest fault observation');
    }
    const observerFile = path.join(root, `${scenarioId}.observer.json`);
    let observer;
    if (fs.existsSync(observerFile)) {
      observer = readJson(observerFile, 'durable hypervisor observer', {
        maximum: 64 * 1024,
        mode: 0o600,
      }).value;
    } else {
      const observerEnd = monotonicMilliseconds();
      observer = {
        bootId: scenarioState.observerBootId,
        startMonotonicMilliseconds:
          scenarioState.observerStartMonotonicMilliseconds,
        endMonotonicMilliseconds: observerEnd,
        durationMilliseconds: observerEnd
          - scenarioState.observerStartMonotonicMilliseconds,
        targetMilliseconds: 120000,
      };
      replaceJson(observerFile, observer);
    }
    if (observer.durationMilliseconds < 0
        || observer.durationMilliseconds > observer.targetMilliseconds) {
      fail('guest recovery exceeded the 120-second target');
    }
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'sealing',
    });
    const execution = sealGuestEvidence(
      root,
      plan,
      scenarioId,
      guest,
      knownHosts,
      observer,
    );
    const qemuObservation = observeQemu(
      guest,
      scenarioId,
      connectionDropped,
      rebootObserved,
    );
    if (execution.value.guest.bootIdBefore !== scenarioState.beforeGuestBootId
        || execution.value.guest.bootIdAfter !== afterGuestBootId
        || canonicalJson(execution.value.observer) !== canonicalJson(observer)) {
      fail('guest evidence differs from the live hypervisor observation');
    }
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'sealed',
    });
    requireActivePlanLifetime(plan, 'scenario evidence recording');
    const result = buildScenarioResult(
      plan,
      scenarioId,
      guest,
      execution,
      observer,
      qemuObservation,
      privateKey,
    );
    const resultFile = path.join(root, `${scenarioId}.result.json`);
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'recording_result',
    });
    durableWrite(resultFile, Buffer.from(`${JSON.stringify(result, null, 2)}\n`));
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'result_recorded',
    });
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'cleaning_guest',
    });
    remote(
      guest,
      knownHosts,
      [
        '/usr/bin/sudo',
        '-n',
        GUEST_EXECUTOR,
        'cleanup',
        plan.planId,
        scenarioId,
      ],
      'clean terminal guest fixture process',
    );
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'stopping_guest',
    });
    if (!stopGuest(guest)) fail('cannot stop terminal isolated KVM guest');
    checkpointController(plan.planId, plan, {
      status: 'running',
      phase: 'idle',
      activeGuest: null,
      scenarioState: null,
    });
    return resultFile;
  } catch (error) {
    try {
      checkpointController(plan.planId, plan, {
        status: 'recovering_failure',
        phase: 'failure_recovery',
        failure: failureIdentity(error),
      });
    } catch {
      // Recovery and guest shutdown remain mandatory even when the host
      // checkpoint itself cannot be advanced.
    }
    const recovered = recoverGuestTransaction(
      plan,
      scenarioId,
      guest,
      knownHosts,
    );
    try {
      checkpointController(plan.planId, plan, {
        status: recovered ? 'failed_recovered' : 'recovery_required',
        phase: recovered ? 'failed_recovered' : 'recovery_required',
        activeGuest: recovered ? null : {
          name: guest.name,
          port: guest.port,
          unit: guest.unit,
        },
        scenarioState: recovered
          ? null
          : loadControllerJournal(plan.planId, plan).scenarioState,
        failure: failureIdentity(error),
        completedAt: recovered ? new Date().toISOString() : null,
      });
    } catch {
      // The earlier durable phase remains enough for boot recovery to retry.
    }
    throw error;
  } finally {
    stopGuest(guest);
  }
}

function submit(planFile) {
  validateFixedRuntime();
  const planPath = boundedFile(planFile, 'submitted drill plan', {
    maximum: 512 * 1024,
    mode: 0o600,
    rootOwned: false,
  });
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  if (!UUID.test(plan.planId ?? '')) fail('submitted plan id is invalid');
  const input = { file: planPath, value: plan };
  validatePlanAndTrust(input);
  const lock = acquireControllerLock();
  try {
    requireActivePlanLifetime(plan, 'controller submission');
    if (fs.existsSync(STATE_ROOT)) {
      for (const entry of fs.readdirSync(STATE_ROOT).sort()) {
        if (!UUID.test(entry)) fail('controller state contains an invalid plan id');
        const candidate = path.join(STATE_ROOT, entry, 'controller-journal.v1.json');
        if (!fs.existsSync(candidate)) continue;
        const existingPlan = readJson(
          stagedPlan(entry),
          'existing controller plan',
          { maximum: 512 * 1024, mode: 0o600 },
        ).value;
        const statusValue = validateControllerJournal(readJson(
          candidate,
          'existing controller journal',
          {
          maximum: 128 * 1024,
          mode: 0o600,
          },
        ).value, existingPlan).status;
        if (!['completed', 'failed_recovered', 'expired_recovered'].includes(
          statusValue,
        )) {
          fail('another sequential fault drill is not terminal');
        }
      }
    }
    const root = planRoot(plan.planId);
    if (fs.existsSync(root)) fail('drill plan identity was already submitted');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const staged = stagedPlan(plan.planId);
    durableWrite(staged, fs.readFileSync(planPath));
    const authenticatedAt = new Date().toISOString();
    replaceJson(journalFile(plan.planId), {
      schema: 'nexus.release-layout-fault-controller-journal.v2',
      status: 'submitted',
      phase: 'idle',
      planId: plan.planId,
      planSha256: planSha256(plan),
      authenticatedAt,
      expiresAt: plan.expiresAt,
      trustManifestSha256: plan.trust.trustManifestSha256,
      provisionReceiptSha256: plan.trust.provisionReceiptSha256,
      executionMode: 'strictly-sequential',
      maximumActiveGuests: 1,
      controllerBootId: bootId(),
      completedScenarios: [],
      activeGuest: null,
      scenarioState: null,
      failure: null,
      drillSha256: null,
      submittedAt: authenticatedAt,
      updatedAt: authenticatedAt,
      completedAt: null,
    });
    fsyncDirectory(root);
  } finally {
    releaseControllerLock(lock);
  }
  program(
    SYSTEMCTL,
    ['start', '--no-block', `nexus-release-layout-fault-drill@${plan.planId}.service`],
    'start durable fault-drill controller',
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    status: 'submitted',
    planId: plan.planId,
    planSha256: planSha256(plan),
  })}\n`);
}

function recoveryOnly(plan, receipt, journal, terminalStatus) {
  let recovered = true;
  if (journal.activeGuest !== null) {
    const scenarioId = journal.scenarioState?.scenarioId;
    const guest = guestEntry(receipt, journal.activeGuest.name);
    if (scenarioId && [
      'arming_fault',
      'fault_armed',
      'waiting_recovery',
      'guest_recovered',
      'sealing',
      'sealed',
      'recording_result',
      'result_recorded',
      'cleaning_guest',
      'stopping_guest',
      'failure_recovery',
      'recovery_required',
    ].includes(journal.phase)) {
      const knownHosts = writeKnownHosts(
        path.join(planRoot(plan.planId), `${scenarioId}.host-trust`),
        guest,
      );
      recovered = recoverGuestTransaction(
        plan,
        scenarioId,
        guest,
        knownHosts,
      );
    } else {
      recovered = stopGuest(guest);
    }
  }
  checkpointController(plan.planId, plan, {
    status: recovered ? terminalStatus : 'recovery_required',
    phase: recovered ? terminalStatus : 'recovery_required',
    activeGuest: recovered ? null : journal.activeGuest,
    scenarioState: recovered ? null : journal.scenarioState,
    failure: journal.failure ?? {
      at: new Date().toISOString(),
      messageSha256: sha256(Buffer.from(terminalStatus, 'utf8')),
    },
    completedAt: recovered ? new Date().toISOString() : null,
  });
  return recovered;
}

function run(planId) {
  validateFixedRuntime();
  const lock = acquireControllerLock();
  try {
    const root = planRoot(planId);
    const planFile = stagedPlan(planId);
    const planInput = readJson(planFile, 'staged drill plan', {
      maximum: 512 * 1024,
      mode: 0o600,
    });
    planInput.file = planFile;
    const { trust, receipt } = validatePlanAndTrust(
      planInput,
      { allowExpiredRecovery: true },
    );
    const plan = planInput.value;
    let journal = loadControllerJournal(planId, plan);
    if (['completed', 'failed_recovered', 'expired_recovered'].includes(
      journal.status,
    )) {
      return;
    }
    if (!activePlanLifetime(plan)) {
      recoveryOnly(plan, receipt, journal, 'expired_recovered');
      return;
    }
    if (['recovering_failure', 'recovery_required'].includes(journal.status)) {
      recoveryOnly(plan, receipt, journal, 'failed_recovered');
      return;
    }
    if (journal.scenarioState
        && journal.scenarioState.observerBootId !== bootId()) {
      checkpointController(planId, plan, {
        status: 'recovering_failure',
        phase: 'failure_recovery',
        failure: {
          at: new Date().toISOString(),
          messageSha256: sha256(Buffer.from('hypervisor reboot', 'utf8')),
        },
      });
      journal = loadControllerJournal(planId, plan);
      recoveryOnly(plan, receipt, journal, 'failed_recovered');
      return;
    }
    const hypervisorPrivatePath = path.join(
      receipt.setDirectory,
      'release-layout-hypervisor-evidence-private.pem',
    );
    const hypervisorPrivate = createPrivateKey(fs.readFileSync(boundedFile(
      hypervisorPrivatePath,
      'hypervisor evidence private key',
      { maximum: 32 * 1024, mode: 0o600 },
    )));
    if (hypervisorPrivate.asymmetricKeyType !== 'ed25519'
        || publicPem(hypervisorPrivate)
          !== plan.trust.hypervisorEd25519PublicKey
        || publicPem(hypervisorPrivate)
          !== trust.hypervisor.publicKeyPem) {
      fail('root-only hypervisor evidence key differs from the trust chain');
    }
    const completed = [...journal.completedScenarios];
    checkpointController(planId, plan, {
      status: 'running',
      phase: journal.phase,
      completedScenarios: completed,
    });
    for (const scenarioId of SCENARIOS.slice(completed.length)) {
      requireActivePlanLifetime(plan, 'scenario execution');
      executeScenario(
        root,
        planFile,
        plan,
        receipt,
        scenarioId,
        hypervisorPrivate,
      );
      completed.push(scenarioId);
      checkpointController(planId, plan, {
        status: 'running',
        phase: 'idle',
        completedScenarios: [...completed],
        activeGuest: null,
        scenarioState: null,
      });
    }
    requireActivePlanLifetime(plan, 'fault-drill collection');
    checkpointController(planId, plan, {
      status: 'collecting',
      phase: 'collecting',
    });
    const drillFile = path.join(root, 'fault-drill.json');
    if (!fs.existsSync(drillFile)) {
      program(process.execPath, [
        DRILL_TOOL,
        'collect',
        '--plan',
        planFile,
        '--failed-health-result',
        path.join(root, 'failed_health_check.result.json'),
        '--host-reboot-result',
        path.join(root, 'host_reboot_during_migration.result.json'),
        '--ssh-disconnect-result',
        path.join(root, 'ssh_disconnect_after_pm2_stop.result.json'),
        '--output',
        drillFile,
      ], 'collect trusted release-layout fault drill');
    } else {
      const existing = readJson(drillFile, 'existing collected fault drill', {
        maximum: 2 * 1024 * 1024,
        mode: 0o600,
      }).value;
      if (existing.schema !== 'nexus.release-layout-fault-drill.v1'
          || existing.planSha256 !== planSha256(plan)
          || existing.migrationId !== plan.migrationId) {
        fail('existing collected fault drill identity is invalid');
      }
      program(process.execPath, [
        DRILL_TOOL,
        'verify-drill',
        '--input',
        drillFile,
      ], 'deeply verify existing collected fault drill');
    }
    checkpointController(planId, plan, {
      status: 'completed',
      phase: 'completed',
      completedScenarios: completed,
      activeGuest: null,
      scenarioState: null,
      drillSha256: sha256(fs.readFileSync(drillFile)),
      completedAt: new Date().toISOString(),
    });
  } finally {
    releaseControllerLock(lock);
  }
}

function recoverAll() {
  validateFixedRuntime();
  if (!fs.existsSync(STATE_ROOT)) return;
  const pending = [];
  for (const planId of fs.readdirSync(STATE_ROOT).sort()) {
    if (!UUID.test(planId)) fail('controller state contains an invalid plan id');
    const file = journalFile(planId);
    if (!fs.existsSync(file)) continue;
    const plan = readJson(
      stagedPlan(planId),
      'controller recovery plan',
      { maximum: 512 * 1024, mode: 0o600 },
    ).value;
    const journal = validateControllerJournal(readJson(
      file,
      'controller recovery journal',
      {
      maximum: 128 * 1024,
      mode: 0o600,
      },
    ).value, plan);
    if (!['completed', 'failed_recovered', 'expired_recovered'].includes(
      journal.status,
    )) {
      pending.push(planId);
    }
  }
  if (pending.length > 1) {
    fail('more than one sequential controller transaction is nonterminal');
  }
  if (pending.length === 1) run(pending[0]);
}

function status(planId) {
  const plan = readJson(
    stagedPlan(planId),
    'controller status plan',
    { maximum: 512 * 1024, mode: 0o600 },
  ).value;
  const journal = validateControllerJournal(readJson(
    journalFile(planId),
    'controller journal',
    { maximum: 128 * 1024, mode: 0o600 },
  ).value, plan);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    planId,
    status: journal.status,
    completedScenarios: journal.completedScenarios,
    drillSha256: journal.drillSha256 ?? null,
  })}\n`);
}

const IS_MAIN = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  try {
    if (process.getuid() !== 0) fail('must run as root on the hypervisor');
    const [command = '', ...args] = process.argv.slice(2);
    if (command === 'version' && args.length === 0) {
      process.stdout.write(`${VERSION}\n`);
    } else if (command === 'submit' && args.length === 1) {
      submit(args[0]);
    } else if (command === 'run' && args.length === 1) {
      run(args[0]);
    } else if (command === 'status' && args.length === 1) {
      status(args[0]);
    } else if (command === 'recover-all' && args.length === 0) {
      recoverAll();
    } else {
      fail(
        'expected version, submit <plan>, run <plan-id>, status <plan-id>, '
        + 'or recover-all',
      );
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
