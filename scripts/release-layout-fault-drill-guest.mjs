#!/usr/bin/node
// Root-only executor for the three release-layout fault scenarios inside an
// isolated KVM guest. The SSH user can ask this fixed program to run or fetch a
// result, but cannot read the guest Ed25519 key or author evidence bytes.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 'nexus-release-layout-fault-guest.v1';
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_MODE === '1';
const STATE_ROOT = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_STATE_ROOT
  : '/var/lib/nexus-release-layout-fault-guest';
const PRIVATE_KEY = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_PRIVATE_KEY
  : '/etc/nexus-release/release-layout-evidence-private.pem';
const SELF_PATH = TEST_MODE
  ? path.resolve(process.argv[1])
  : '/usr/local/sbin/nexus-release-layout-fault-guest';
const RECOVERY_UNIT_PATH = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_RECOVERY_UNIT
  : '/etc/systemd/system/nexus-release-layout-fault-guest-recovery.service';
const SYSTEMCTL = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_SYSTEMCTL
  : '/usr/bin/systemctl';
const SYSTEMD_RUN = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_SYSTEMD_RUN
  : '/usr/bin/systemd-run';
const FLOCK = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_FLOCK
  : '/usr/bin/flock';
const HOSTNAME = TEST_MODE
  ? process.env.NEXUS_RELEASE_FAULT_GUEST_ID
  : os.hostname();
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
const MUTATION_LOCK = STATE_ROOT
  ? path.join(STATE_ROOT, 'mutation.lock')
  : '';
const FIXTURE_PROCESS_PROGRAM = 'setInterval(()=>{},1000)';

function fail(message) {
  throw new Error(`release layout fault guest: ${message}`);
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

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function safeFile(file, label, {
  maximum = 1024 * 1024,
  mode,
  rootOwned = false,
} = {}) {
  const resolved = path.resolve(file);
  const identity = fs.lstatSync(resolved);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || identity.size < 1 || identity.size > maximum
      || (mode !== undefined && (identity.mode & 0o7777) !== mode)
      || (!TEST_MODE && rootOwned && (identity.uid !== 0 || identity.gid !== 0))) {
    fail(`${label} identity is unsafe`);
  }
  return resolved;
}

function readJson(file, label, maximum) {
  const resolved = safeFile(file, label, { maximum });
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function durableWrite(file, bytes, mode = 0o600) {
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
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function writeJson(file, value) {
  durableWrite(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function fsyncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureStateRoot() {
  if (!fs.existsSync(STATE_ROOT)) {
    fs.mkdirSync(STATE_ROOT, { mode: 0o700 });
    fsyncDirectory(path.dirname(STATE_ROOT));
  }
  const identity = fs.lstatSync(STATE_ROOT);
  if (!identity.isDirectory() || identity.isSymbolicLink()
      || (identity.mode & 0o7777) !== 0o700
      || (!TEST_MODE && (
        fs.realpathSync(STATE_ROOT) !== path.resolve(STATE_ROOT)
        || identity.uid !== 0 || identity.gid !== 0
      ))) {
    fail('guest state root identity is unsafe');
  }
}

function acquireMutationLock() {
  ensureStateRoot();
  const descriptor = fs.openSync(
    MUTATION_LOCK,
    fs.constants.O_RDWR | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const identity = fs.fstatSync(descriptor);
    const named = fs.lstatSync(MUTATION_LOCK);
    if (!identity.isFile() || identity.nlink !== 1
        || identity.dev !== named.dev || identity.ino !== named.ino
        || named.isSymbolicLink() || (identity.mode & 0o7777) !== 0o600
        || (!TEST_MODE && (identity.uid !== 0 || identity.gid !== 0))) {
      fail('guest mutation lock identity is unsafe');
    }
    const result = spawnSync(FLOCK, ['--nonblock', '3'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
      timeout: 10_000,
    });
    if (result.status !== 0) {
      fail('another guest mutation or recovery transaction holds the lock');
    }
    const signal = TEST_MODE
      ? process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_LOCK_SIGNAL
      : undefined;
    if (signal) durableWrite(signal, Buffer.from('locked\n'));
    const holdMilliseconds = TEST_MODE
      ? Number(process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_HOLD_LOCK_MS ?? 0)
      : 0;
    if (!Number.isSafeInteger(holdMilliseconds)
        || holdMilliseconds < 0 || holdMilliseconds > 10_000) {
      fail('test lock hold duration is invalid');
    }
    if (holdMilliseconds > 0) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        holdMilliseconds,
      );
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function releaseMutationLock(descriptor) {
  fs.closeSync(descriptor);
}

function durableRemove(file) {
  if (!fs.existsSync(file)) return;
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function durableSymlink(target, link) {
  const parent = path.dirname(link);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(link)}.${randomUUID()}`);
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
  fsyncDirectory(parent);
}

function durableAppend(file, bytes) {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
}

function durableCopy(source, destination) {
  durableWrite(destination, fs.readFileSync(source));
}

function nowMilliseconds() {
  if (TEST_MODE && process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS) {
    const value = Number(process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_NOW_MS);
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('test wall clock is invalid');
    }
    return value;
  }
  return Date.now();
}

function maybeCrash(point) {
  if (TEST_MODE
      && process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_CRASH_POINT === point) {
    process.exit(96);
  }
}

function bootId() {
  const value = TEST_MODE
    ? process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_BOOT_ID
    : fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!BOOT_ID.test(value)) fail('guest boot identity is invalid');
  return value;
}

function monotonicMilliseconds() {
  const value = TEST_MODE
    ? Number(process.hrtime.bigint() / 1_000_000n)
    : Math.floor(Number.parseFloat(
      fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/u)[0],
    ) * 1000);
  if (!Number.isSafeInteger(value) || value < 0) fail('guest monotonic clock is invalid');
  return value;
}

function transactionRoot(planId, scenarioId) {
  if (!UUID.test(planId) || !SCENARIOS.includes(scenarioId)) {
    fail('transaction identity is invalid');
  }
  return path.join(STATE_ROOT, planId, scenarioId);
}

function journalPath(planId, scenarioId) {
  return path.join(transactionRoot(planId, scenarioId), 'journal.v1.json');
}

function validateProducer(producer, scenarioId) {
  exactKeys(producer, [
    'executorPath',
    'executorSha256',
    'recoveryUnitPath',
    'recoveryUnitSha256',
  ], 'guest producer');
  const expected = {
    executorPath: '/usr/local/sbin/nexus-release-layout-fault-guest',
    recoveryUnitPath:
      '/etc/systemd/system/nexus-release-layout-fault-guest-recovery.service',
  };
  if (producer.executorPath !== expected.executorPath
      || producer.recoveryUnitPath !== expected.recoveryUnitPath
      || !DIGEST.test(producer.executorSha256 ?? '')
      || !DIGEST.test(producer.recoveryUnitSha256 ?? '')) {
    fail(`${scenarioId} guest producer identity is invalid`);
  }
  if (fileSha256(SELF_PATH) !== producer.executorSha256
      || fileSha256(safeFile(
        RECOVERY_UNIT_PATH,
        'guest recovery unit',
        { maximum: 64 * 1024, mode: 0o644, rootOwned: true },
      )) !== producer.recoveryUnitSha256) {
    fail(`${scenarioId} installed guest producer digest drifted`);
  }
}

function validatePlan(plan, scenarioId, { requireActiveLifetime = true } = {}) {
  exactKeys(plan, [
    'challengeNonce',
    'createdAt',
    'execution',
    'expiresAt',
    'migrationId',
    'planId',
    'promotionAllowed',
    'scenarios',
    'schema',
    'source',
    'trust',
  ], 'drill plan');
  if (plan.schema !== 'nexus.release-layout-fault-drill-plan.v1'
      || !UUID.test(plan.planId ?? '') || !UUID.test(plan.migrationId ?? '')
      || !DIGEST.test(plan.challengeNonce ?? '') || plan.promotionAllowed !== false
      || !SCENARIOS.includes(scenarioId)
      || SCENARIO_GUESTS[scenarioId] !== HOSTNAME) {
    fail('drill plan identity or guest mapping is invalid');
  }
  const created = Date.parse(plan.createdAt ?? '');
  const expires = Date.parse(plan.expiresAt ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(expires)
      || expires <= created || expires - created > 7 * 24 * 60 * 60 * 1000) {
    fail('drill plan lifetime is invalid');
  }
  const now = nowMilliseconds();
  if (requireActiveLifetime
      && (created > now + 60_000 || expires < now)) {
    fail('drill plan lifetime is invalid');
  }
  exactKeys(plan.execution, [
    'automaticProtectedApproval',
    'independentOverlayRequired',
    'isolatedKvmRequired',
    'maximumActiveGuests',
    'mode',
    'productionDataForbidden',
    'productionKeysForbidden',
  ], 'drill execution policy');
  if (plan.execution.mode !== 'strictly-sequential'
      || plan.execution.maximumActiveGuests !== 1
      || plan.execution.isolatedKvmRequired !== true
      || plan.execution.independentOverlayRequired !== true
      || plan.execution.productionDataForbidden !== true
      || plan.execution.productionKeysForbidden !== true
      || plan.execution.automaticProtectedApproval !== false) {
    fail('drill execution policy is unsafe');
  }
  exactKeys(plan.trust, [
    'guestEd25519PublicKeys',
    'guestIds',
    'hypervisorEd25519PublicKey',
    'producers',
    'provisionReceiptSha256',
    'provisionSetId',
    'trustManifestSha256',
  ], 'drill trust');
  exactKeys(plan.trust.producers, ['guests', 'hypervisor'], 'drill producer trust');
  exactKeys(plan.trust.producers.guests, SCENARIOS, 'drill guest producer trust');
  if (plan.trust.guestIds?.[scenarioId] !== HOSTNAME) {
    fail('drill guest identity differs from the plan');
  }
  validateProducer(plan.trust.producers.guests[scenarioId], scenarioId);
  const keyFile = safeFile(PRIVATE_KEY, 'guest evidence private key', {
    maximum: 32 * 1024,
    mode: 0o600,
    rootOwned: true,
  });
  const privateKey = createPrivateKey(fs.readFileSync(keyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('guest evidence private key must be Ed25519');
  }
  const publicPem = createPublicKey(privateKey)
    .export({ format: 'pem', type: 'spki' }).toString();
  if (publicPem !== plan.trust.guestEd25519PublicKeys?.[scenarioId]) {
    fail('guest evidence private key differs from the plan');
  }
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length !== SCENARIOS.length
      || plan.scenarios.some((scenario, index) => (
        scenario?.id !== SCENARIOS[index] || scenario.order !== index + 1
        || scenario.fault !== SCENARIOS[index]
        || scenario.expectedTerminalStatus !== 'recovered'
        || scenario.productionEvidenceAllowed !== false
      ))) {
    fail('drill scenario order is invalid');
  }
  return { privateKey, publicPem };
}

function loadStagedPlan(
  planId,
  scenarioId,
  { requireActiveLifetime = true } = {},
) {
  const planFile = safeFile(
    path.join(transactionRoot(planId, scenarioId), 'plan.json'),
    'staged drill plan',
    { maximum: 512 * 1024, mode: 0o600, rootOwned: true },
  );
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const key = validatePlan(plan, scenarioId, { requireActiveLifetime });
  return { plan, planFile, ...key };
}

function sourceDigest(plan) {
  return sha256(Buffer.from(canonicalJson(plan.source), 'utf8'));
}

function planDigest(plan) {
  return sha256(Buffer.from(canonicalJson(plan), 'utf8'));
}

function serviceAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    const linuxStat = `/proc/${pid}/stat`;
    if (fs.existsSync(linuxStat)) {
      const fields = fs.readFileSync(linuxStat, 'utf8').split(/\s+/u);
      if (fields[2] === 'Z') return false;
    } else if (TEST_MODE) {
      const status = spawnSync('/bin/ps', [
        '-o',
        'stat=',
        '-p',
        String(pid),
      ], { encoding: 'utf8' });
      if (status.error?.code === 'EPERM') return true;
      if (status.status !== 0 || status.stdout.trim().startsWith('Z')) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function fixtureProcessMarker(root) {
  return `nexus-release-layout-fixture-${sha256(path.resolve(root))}`;
}

function discoverFixtureProcessIds(root) {
  const marker = fixtureProcessMarker(root);
  const discovered = [];
  if (process.platform === 'linux' && fs.existsSync('/proc')) {
    const expectedExecutable = fs.realpathSync(process.execPath);
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^[1-9][0-9]*$/u.test(entry)) continue;
      const pid = Number(entry);
      let fields;
      let executable;
      try {
        fields = fs.readFileSync(`/proc/${entry}/cmdline`)
          .toString('utf8').split('\0').filter(Boolean);
        executable = fs.realpathSync(`/proc/${entry}/exe`);
      } catch {
        continue;
      }
      if (executable === expectedExecutable && fields.includes(marker)) {
        discovered.push(pid);
      }
    }
  } else if (TEST_MODE) {
    const processes = spawnSync('/bin/ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
    });
    if (processes.status !== 0) return [];
    for (const line of processes.stdout.split('\n')) {
      const match = line.match(/^\s*([1-9][0-9]*)\s+(.*)$/u);
      if (match && match[2].split(/\s+/u).includes(marker)) {
        discovered.push(Number(match[1]));
      }
    }
  }
  return [...new Set(discovered)];
}

function startFixtureService(root, { afterSpawn } = {}) {
  const processFile = path.join(root, 'fixture.pid');
  if (fs.existsSync(processFile)) {
    const existing = Number.parseInt(fs.readFileSync(processFile, 'utf8').trim(), 10);
    if (serviceAlive(existing)
        && (TEST_MODE || discoverFixtureProcessIds(root).includes(existing))) {
      return existing;
    }
    durableRemove(processFile);
  }
  const discovered = discoverFixtureProcessIds(root);
  if (discovered.length > 1) fail('multiple fixture processes are active');
  if (discovered.length === 1) {
    durableWrite(processFile, Buffer.from(`${discovered[0]}\n`));
    return discovered[0];
  }
  const marker = fixtureProcessMarker(root);
  const child = spawn(
    process.execPath,
    ['-e', FIXTURE_PROCESS_PROGRAM, marker],
    {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    },
  );
  child.unref();
  if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
    fail('fixture process identity is invalid');
  }
  if (afterSpawn) afterSpawn(child.pid);
  durableWrite(processFile, Buffer.from(`${child.pid}\n`));
  return child.pid;
}

function stopFixtureService(root, additionalPids = []) {
  const processFile = path.join(root, 'fixture.pid');
  const recorded = fs.existsSync(processFile)
    ? Number.parseInt(fs.readFileSync(processFile, 'utf8').trim(), 10)
    : null;
  if (recorded !== null
      && (!Number.isSafeInteger(recorded) || recorded <= 1)) {
    fail('fixture pid identity is invalid');
  }
  const pids = new Set(discoverFixtureProcessIds(root));
  for (const pid of additionalPids) {
    if (Number.isSafeInteger(pid) && pid > 1 && serviceAlive(pid)) pids.add(pid);
  }
  if (recorded !== null && serviceAlive(recorded)) pids.add(recorded);
  for (const pid of pids) {
    if (serviceAlive(pid)) process.kill(pid, 'SIGTERM');
  }
  const deadline = Date.now() + 5000;
  while ([...pids].some(serviceAlive) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  for (const pid of pids) {
    if (serviceAlive(pid)) process.kill(pid, 'SIGKILL');
  }
  if ([...pids].some(serviceAlive)) {
    fail('fixture process did not stop cleanly');
  }
  if (fs.existsSync(processFile)) durableRemove(processFile);
  return pids.size > 0 || recorded !== null;
}

function health(root) {
  const current = path.join(root, 'current');
  const processFile = path.join(root, 'fixture.pid');
  if (!fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()
      || !fs.existsSync(processFile)) return false;
  const pid = Number.parseInt(fs.readFileSync(processFile, 'utf8').trim(), 10);
  if (!serviceAlive(pid)
      || (!TEST_MODE && !discoverFixtureProcessIds(root).includes(pid))) {
    return false;
  }
  try {
    return fs.readFileSync(path.join(current, 'health'), 'utf8') === 'ok\n';
  } catch {
    return false;
  }
}

function fixtureIntent(plan, scenarioId) {
  const root = transactionRoot(plan.planId, scenarioId);
  const fixture = path.join(root, 'fixture');
  const predecessor = path.join(fixture, 'predecessor');
  const candidate = path.join(fixture, 'candidate');
  const current = path.join(fixture, 'current');
  const database = path.join(fixture, 'database.sqlite');
  const databaseBackup = path.join(fixture, 'database.pre-fault.sqlite');
  return {
    root,
    fixture,
    predecessor,
    candidate,
    current,
    database,
    databaseBackup,
    predecessorSha256: sha256(Buffer.from(`${canonicalJson(plan.source)}\n`)),
  };
}

function ensureFixtureDirectory(directory, parent) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(parent);
  }
  const identity = fs.lstatSync(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()
      || (identity.mode & 0o7777) !== 0o700
      || (!TEST_MODE && (
        fs.realpathSync(directory) !== path.resolve(directory)
        || identity.uid !== 0 || identity.gid !== 0
      ))) {
    fail('fixture directory identity is unsafe');
  }
}

function removeFixtureRegularFile(file, label) {
  const identity = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!identity) return;
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || (!TEST_MODE && (identity.uid !== 0 || identity.gid !== 0))) {
    fail(`${label} identity is unsafe`);
  }
  durableRemove(file);
}

function initializeFixture(plan, scenarioId, fixture = fixtureIntent(
  plan,
  scenarioId,
)) {
  ensureFixtureDirectory(fixture.fixture, fixture.root);
  maybeCrash('after_fixture_directory_create');
  ensureFixtureDirectory(fixture.predecessor, fixture.fixture);
  ensureFixtureDirectory(fixture.candidate, fixture.fixture);
  stopFixtureService(fixture.fixture);
  removeFixtureRegularFile(fixture.database, 'fixture database');
  removeFixtureRegularFile(fixture.databaseBackup, 'fixture database backup');
  durableWrite(
    path.join(fixture.predecessor, 'release.json'),
    Buffer.from(`${canonicalJson(plan.source)}\n`),
  );
  durableWrite(path.join(fixture.predecessor, 'health'), Buffer.from('ok\n'));
  durableWrite(
    path.join(fixture.candidate, 'release.json'),
    Buffer.from(`${canonicalJson({ scenarioId, candidate: true })}\n`),
  );
  durableWrite(
    path.join(fixture.candidate, 'health'),
    Buffer.from(scenarioId === 'failed_health_check' ? 'fail\n' : 'ok\n'),
  );
  maybeCrash('after_fixture_release_write');
  const currentIdentity = fs.lstatSync(
    fixture.current,
    { throwIfNoEntry: false },
  );
  if (currentIdentity && !currentIdentity.isSymbolicLink()) {
    fail('fixture selector identity is unsafe');
  }
  durableSymlink(fixture.predecessor, fixture.current);
  const python = spawnSync('/usr/bin/python3', [
    '-c',
    [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1])',
      'db.execute("CREATE TABLE release_state (marker TEXT NOT NULL)")',
      'db.execute("INSERT INTO release_state(marker) VALUES (?)",(sys.argv[2],))',
      'db.commit()',
      'db.close()',
    ].join(';'),
    fixture.database,
    sourceDigest(plan),
  ], { encoding: 'utf8' });
  if (python.status !== 0) fail('cannot create the isolated SQLite recovery fixture');
  fsyncFile(fixture.database);
  fsyncDirectory(fixture.fixture);
  maybeCrash('after_fixture_database_create');
  durableWrite(fixture.databaseBackup, fs.readFileSync(fixture.database));
  maybeCrash('after_fixture_backup_write');
  return {
    ...fixture,
    predecessorSha256:
      fileSha256(path.join(fixture.predecessor, 'release.json')),
    databaseBeforeSha256: fileSha256(fixture.database),
  };
}

function checkpointJournal(file, journal, {
  status = journal.status,
  phase,
  observations = {},
} = {}) {
  const next = {
    ...journal,
    status,
    phase,
    observations: {
      ...journal.observations,
      ...observations,
    },
    updatedAt: new Date(nowMilliseconds()).toISOString(),
  };
  writeJson(file, next);
  return next;
}

function armFault(plan, scenarioId) {
  const journalFile = journalPath(plan.planId, scenarioId);
  if (fs.existsSync(journalFile)) fail('scenario transaction was already used');
  const fixture = fixtureIntent(plan, scenarioId);
  const bootIdBefore = bootId();
  const startedMonotonicMilliseconds = monotonicMilliseconds();
  const authenticatedAt = new Date(nowMilliseconds()).toISOString();
  let journal = {
    schema: 'nexus.release-layout-fault-guest-journal.v2',
    status: 'prepared',
    phase: 'fixture_initialization_intent',
    authentication: {
      authenticatedAt,
      expiresAt: plan.expiresAt,
      planSha256: planDigest(plan),
    },
    planId: plan.planId,
    planSha256: planDigest(plan),
    migrationId: plan.migrationId,
    scenarioId,
    challengeNonce: plan.challengeNonce,
    executionMode: 'strictly-sequential',
    testMode: TEST_MODE,
    fixture: {
      root: fixture.fixture,
      predecessor: fixture.predecessor,
      candidate: fixture.candidate,
      current: fixture.current,
      database: fixture.database,
      databaseBackup: fixture.databaseBackup,
    },
    observations: {
      bootIdBefore,
      bootIdAfter: null,
      startMonotonicMilliseconds: startedMonotonicMilliseconds,
      endMonotonicMilliseconds: null,
      predecessorSha256: fixture.predecessorSha256,
      restoredSha256: null,
      databaseBeforeSha256: null,
      databaseAfterSha256: null,
      fixtureProcessPid: null,
      candidateHealthFailureObserved: false,
      processStoppedObserved: false,
      durableRecoveryArmed: false,
      healthRestored: false,
    },
    producer: plan.trust.producers.guests[scenarioId],
    createdAt: authenticatedAt,
    updatedAt: authenticatedAt,
    completedAt: null,
  };
  // This is the write-ahead recovery record. It is stable before the fixture
  // directory, selector, database, or process is created.
  writeJson(journalFile, journal);
  maybeCrash('after_prepared_journal');
  maybeCrash('after_wal_before_fixture');

  journal = checkpointJournal(journalFile, journal, {
    status: 'prepared',
    phase: 'initializing_fixture',
  });
  const initializedFixture = initializeFixture(plan, scenarioId, fixture);
  journal = checkpointJournal(journalFile, journal, {
    status: 'prepared',
    phase: 'fixture_initialized',
    observations: {
      predecessorSha256: initializedFixture.predecessorSha256,
      databaseBeforeSha256: initializedFixture.databaseBeforeSha256,
    },
  });
  maybeCrash('after_fixture_initialized');

  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'starting_predecessor',
  });
  const fixturePid = startFixtureService(fixture.fixture, {
    afterSpawn(pid) {
      maybeCrash('after_predecessor_spawn_before_journal');
      journal = checkpointJournal(journalFile, journal, {
        status: 'faulting',
        phase: 'predecessor_spawned',
        observations: { fixtureProcessPid: pid },
      });
      maybeCrash('after_predecessor_spawn_journal_before_pid');
    },
  });
  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'predecessor_pid_persisted',
    observations: { fixtureProcessPid: fixturePid },
  });
  maybeCrash('after_predecessor_pid_write');
  maybeCrash('after_predecessor_start');
  if (!health(fixture.fixture)) fail('fixture predecessor did not become healthy');
  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'predecessor_healthy',
  });

  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'stopping_predecessor',
  });
  stopFixtureService(fixture.fixture);
  maybeCrash('after_process_stop');
  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'process_stopped',
    observations: { processStoppedObserved: true },
  });

  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'switching_selector',
  });
  durableSymlink(fixture.candidate, fixture.current);
  maybeCrash('after_selector_switch');
  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'selector_switched',
  });

  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'mutating_database',
  });
  durableAppend(fixture.database, Buffer.from(`fault:${scenarioId}\n`));
  maybeCrash('after_database_mutation');
  journal = checkpointJournal(journalFile, journal, {
    status: 'faulting',
    phase: 'database_faulted',
  });

  let candidateHealthFailureObserved = false;
  if (scenarioId === 'failed_health_check') {
    journal = checkpointJournal(journalFile, journal, {
      status: 'faulting',
      phase: 'observing_candidate_health',
    });
    startFixtureService(fixture.fixture);
    candidateHealthFailureObserved = !health(fixture.fixture);
    stopFixtureService(fixture.fixture);
    if (!candidateHealthFailureObserved) {
      fail('failed-health scenario did not observe a failing candidate');
    }
    journal = checkpointJournal(journalFile, journal, {
      status: 'faulting',
      phase: 'candidate_health_observed',
      observations: { candidateHealthFailureObserved: true },
    });
  }
  journal = checkpointJournal(journalFile, journal, {
    status: 'recovery_armed',
    phase: 'recovery_armed',
    observations: {
      candidateHealthFailureObserved,
      durableRecoveryArmed: true,
    },
  });
  return journal;
}

function validateJournal(journal, plan, scenarioId) {
  exactKeys(journal, [
    'authentication',
    'challengeNonce',
    'completedAt',
    'createdAt',
    'executionMode',
    'fixture',
    'migrationId',
    'observations',
    'planId',
    'planSha256',
    'phase',
    'producer',
    'scenarioId',
    'schema',
    'status',
    'testMode',
    'updatedAt',
  ], 'guest journal');
  exactKeys(journal.authentication, [
    'authenticatedAt',
    'expiresAt',
    'planSha256',
  ], 'guest journal authentication');
  exactKeys(journal.fixture, [
    'candidate',
    'current',
    'database',
    'databaseBackup',
    'predecessor',
    'root',
  ], 'guest journal fixture');
  exactKeys(journal.observations, [
    'bootIdAfter',
    'bootIdBefore',
    'candidateHealthFailureObserved',
    'databaseAfterSha256',
    'databaseBeforeSha256',
    'durableRecoveryArmed',
    'endMonotonicMilliseconds',
    'fixtureProcessPid',
    'healthRestored',
    'predecessorSha256',
    'processStoppedObserved',
    'restoredSha256',
    'startMonotonicMilliseconds',
  ], 'guest journal observations');
  const authenticatedAt = Date.parse(journal.authentication.authenticatedAt ?? '');
  const planCreatedAt = Date.parse(plan.createdAt ?? '');
  const planExpiresAt = Date.parse(plan.expiresAt ?? '');
  const statusValues = [
    'prepared',
    'faulting',
    'recovery_armed',
    'recovering',
    'recovered',
  ];
  const phaseValues = [
    'fixture_initialization_intent',
    'initializing_fixture',
    'fixture_initialized',
    'starting_predecessor',
    'predecessor_spawned',
    'predecessor_pid_persisted',
    'predecessor_healthy',
    'stopping_predecessor',
    'process_stopped',
    'switching_selector',
    'selector_switched',
    'mutating_database',
    'database_faulted',
    'observing_candidate_health',
    'candidate_health_observed',
    'recovery_armed',
    'stopping_for_recovery',
    'reinitializing_fixture',
    'fixture_reinitialized',
    'restoring_selector',
    'selector_restored',
    'restoring_database',
    'database_restored',
    'starting_recovered_predecessor',
    'recovered',
  ];
  if (journal.schema !== 'nexus.release-layout-fault-guest-journal.v2'
      || journal.planId !== plan.planId || journal.planSha256 !== planDigest(plan)
      || journal.migrationId !== plan.migrationId
      || journal.scenarioId !== scenarioId
      || journal.challengeNonce !== plan.challengeNonce
      || journal.executionMode !== 'strictly-sequential'
      || journal.testMode !== TEST_MODE
      || !statusValues.includes(journal.status)
      || !phaseValues.includes(journal.phase)
      || !Number.isFinite(authenticatedAt)
      || authenticatedAt < planCreatedAt - 60_000
      || authenticatedAt > planExpiresAt
      || journal.authentication.expiresAt !== plan.expiresAt
      || journal.authentication.planSha256 !== planDigest(plan)
      || canonicalJson(journal.producer)
        !== canonicalJson(plan.trust.producers.guests[scenarioId])) {
    fail('guest journal identity is invalid');
  }
  const expectedFixture = fixtureIntent(plan, scenarioId);
  if (canonicalJson(journal.fixture) !== canonicalJson({
    root: expectedFixture.fixture,
    predecessor: expectedFixture.predecessor,
    candidate: expectedFixture.candidate,
    current: expectedFixture.current,
    database: expectedFixture.database,
    databaseBackup: expectedFixture.databaseBackup,
  })) {
    fail('guest journal fixture identity is invalid');
  }
  const statusPhases = {
    prepared: [
      'fixture_initialization_intent',
      'initializing_fixture',
      'fixture_initialized',
    ],
    faulting: [
      'starting_predecessor',
      'predecessor_spawned',
      'predecessor_pid_persisted',
      'predecessor_healthy',
      'stopping_predecessor',
      'process_stopped',
      'switching_selector',
      'selector_switched',
      'mutating_database',
      'database_faulted',
      'observing_candidate_health',
      'candidate_health_observed',
    ],
    recovery_armed: ['recovery_armed'],
    recovering: [
      'stopping_for_recovery',
      'reinitializing_fixture',
      'fixture_reinitialized',
      'restoring_selector',
      'selector_restored',
      'restoring_database',
      'database_restored',
      'starting_recovered_predecessor',
    ],
    recovered: ['recovered'],
  };
  const createdAt = Date.parse(journal.createdAt ?? '');
  const updatedAt = Date.parse(journal.updatedAt ?? '');
  const completedAt = journal.completedAt === null
    ? null
    : Date.parse(journal.completedAt ?? '');
  if (!statusPhases[journal.status]?.includes(journal.phase)
      || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)
      || updatedAt < createdAt
      || (completedAt !== null
        && (!Number.isFinite(completedAt) || completedAt < updatedAt))
      || (journal.status === 'recovered') !== (completedAt !== null)
      || !DIGEST.test(journal.observations.predecessorSha256 ?? '')
      || (journal.observations.databaseBeforeSha256 !== null
        && !DIGEST.test(journal.observations.databaseBeforeSha256 ?? ''))
      || (journal.observations.restoredSha256 !== null
        && !DIGEST.test(journal.observations.restoredSha256 ?? ''))
      || (journal.observations.databaseAfterSha256 !== null
        && !DIGEST.test(journal.observations.databaseAfterSha256 ?? ''))
      || (journal.observations.fixtureProcessPid !== null
        && (!Number.isSafeInteger(journal.observations.fixtureProcessPid)
          || journal.observations.fixtureProcessPid <= 1))
      || !Number.isSafeInteger(
        journal.observations.startMonotonicMilliseconds,
      )
      || journal.observations.startMonotonicMilliseconds < 0
      || (journal.observations.endMonotonicMilliseconds !== null
        && (!Number.isSafeInteger(
          journal.observations.endMonotonicMilliseconds,
        )
          || journal.observations.endMonotonicMilliseconds
            < journal.observations.startMonotonicMilliseconds))
      || [
        'candidateHealthFailureObserved',
        'durableRecoveryArmed',
        'healthRestored',
        'processStoppedObserved',
      ].some((field) => typeof journal.observations[field] !== 'boolean')) {
    fail('guest journal state is invalid');
  }
  const initializationMayBeIncomplete = [
    'fixture_initialization_intent',
    'initializing_fixture',
    'stopping_for_recovery',
    'reinitializing_fixture',
  ].includes(journal.phase);
  if ((journal.observations.databaseBeforeSha256 === null)
        !== initializationMayBeIncomplete
      && journal.phase !== 'stopping_for_recovery') {
    fail('guest journal fixture checkpoint is invalid');
  }
  if (journal.status === 'recovered'
      && (journal.observations.healthRestored !== true
        || journal.observations.restoredSha256
          !== journal.observations.predecessorSha256
        || journal.observations.databaseAfterSha256
          !== journal.observations.databaseBeforeSha256
        || journal.observations.endMonotonicMilliseconds === null)) {
    fail('guest journal recovered state is invalid');
  }
  return journal;
}

function recover(planId, scenarioId) {
  const file = journalPath(planId, scenarioId);
  if (!fs.existsSync(file)) fail('no authenticated recovery journal exists');
  const { plan } = loadStagedPlan(
    planId,
    scenarioId,
    { requireActiveLifetime: false },
  );
  let journal = validateJournal(
    readJson(file, 'guest journal', 256 * 1024),
    plan,
    scenarioId,
  );
  if (journal.status === 'recovered') return journal;
  if (!['prepared', 'faulting', 'recovery_armed', 'recovering'].includes(
    journal.status,
  )) {
    fail('scenario is not recoverable');
  }
  const fixture = journal.fixture;
  const fixtureInitializationIncomplete =
    journal.observations.databaseBeforeSha256 === null;
  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'stopping_for_recovery',
  });
  stopFixtureService(
    fixture.root,
    [journal.observations.fixtureProcessPid],
  );
  maybeCrash('after_recovery_process_stop');

  if (fixtureInitializationIncomplete) {
    journal = checkpointJournal(file, journal, {
      status: 'recovering',
      phase: 'reinitializing_fixture',
    });
    const initialized = initializeFixture(plan, scenarioId);
    journal = checkpointJournal(file, journal, {
      status: 'recovering',
      phase: 'fixture_reinitialized',
      observations: {
        predecessorSha256: initialized.predecessorSha256,
        databaseBeforeSha256: initialized.databaseBeforeSha256,
      },
    });
  }

  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'restoring_selector',
  });
  const current = fs.lstatSync(fixture.current, { throwIfNoEntry: false });
  if (current && !current.isSymbolicLink()) {
    fail('release selector is not a symbolic link');
  }
  if (current) {
    const selected = fs.realpathSync(fixture.current);
    const predecessor = fs.realpathSync(fixture.predecessor);
    const candidate = fs.realpathSync(fixture.candidate);
    if (selected !== predecessor && selected !== candidate) {
      fail('release selector points outside the recovery fixture');
    }
  }
  durableSymlink(fixture.predecessor, fixture.current);
  maybeCrash('after_recovery_selector_restore');
  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'selector_restored',
  });

  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'restoring_database',
  });
  durableCopy(fixture.databaseBackup, fixture.database);
  maybeCrash('after_recovery_database_restore');
  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'database_restored',
  });

  journal = checkpointJournal(file, journal, {
    status: 'recovering',
    phase: 'starting_recovered_predecessor',
  });
  const recoveredPid = startFixtureService(fixture.root);
  maybeCrash('after_recovery_process_start');
  const restoredSha256 = fileSha256(path.join(fixture.current, 'release.json'));
  const databaseAfterSha256 = fileSha256(fixture.database);
  if (restoredSha256 !== journal.observations.predecessorSha256
      || databaseAfterSha256 !== journal.observations.databaseBeforeSha256
      || !health(fixture.root)) {
    fail('exact predecessor or SQLite recovery verification failed');
  }
  // The selector, database, pid identity, and their containing directories
  // reach stable storage before the journal can advertise a recovered state.
  fsyncFile(fixture.database);
  fsyncFile(path.join(fixture.root, 'fixture.pid'));
  fsyncDirectory(path.dirname(fixture.current));
  fsyncDirectory(path.dirname(fixture.database));
  maybeCrash('before_recovered_journal');
  const recoveredAt = new Date(nowMilliseconds()).toISOString();
  const recovered = {
    ...journal,
    status: 'recovered',
    phase: 'recovered',
    observations: {
      ...journal.observations,
      bootIdAfter: bootId(),
      endMonotonicMilliseconds: monotonicMilliseconds(),
      restoredSha256,
      databaseAfterSha256,
      fixtureProcessPid: recoveredPid,
      healthRestored: true,
    },
    completedAt: recoveredAt,
    updatedAt: recoveredAt,
  };
  writeJson(file, recovered);
  return recovered;
}

function recoverIfPresent(planId, scenarioId) {
  transactionRoot(planId, scenarioId);
  const file = journalPath(planId, scenarioId);
  if (!fs.existsSync(file)) {
    loadStagedPlan(
      planId,
      scenarioId,
      { requireActiveLifetime: false },
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: 'not_armed',
      planId,
      scenarioId,
    })}\n`);
    return;
  }
  const journal = recover(planId, scenarioId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    status: journal.status,
    planId,
    scenarioId,
  })}\n`);
}

function scheduleRecovery(planId, scenarioId) {
  if (TEST_MODE && process.env.NEXUS_RELEASE_FAULT_GUEST_TEST_DEFER === '1') return;
  const unit = `nexus-layout-fault-${sha256(`${planId}:${scenarioId}`).slice(0, 16)}`;
  const result = spawnSync(SYSTEMD_RUN, [
    '--quiet',
    '--collect',
    `--unit=${unit}`,
    SELF_PATH,
    'resume',
    planId,
    scenarioId,
  ], { encoding: 'utf8' });
  if (result.status !== 0) fail('cannot schedule durable guest recovery');
}

function validateObserver(value, journal) {
  exactKeys(value, [
    'bootId',
    'durationMilliseconds',
    'endMonotonicMilliseconds',
    'startMonotonicMilliseconds',
    'targetMilliseconds',
  ], 'hypervisor observer');
  if (!BOOT_ID.test(value.bootId ?? '')
      || !Number.isSafeInteger(value.startMonotonicMilliseconds)
      || !Number.isSafeInteger(value.endMonotonicMilliseconds)
      || !Number.isSafeInteger(value.durationMilliseconds)
      || value.endMonotonicMilliseconds < value.startMonotonicMilliseconds
      || value.durationMilliseconds
        !== value.endMonotonicMilliseconds - value.startMonotonicMilliseconds
      || value.targetMilliseconds !== 120000
      || value.durationMilliseconds > 120000
      || Date.parse(journal.completedAt) > Date.now() + 60_000) {
    fail('hypervisor observer is invalid');
  }
  return value;
}

function seal(planId, scenarioId, observerFile) {
  const { plan, privateKey } = loadStagedPlan(planId, scenarioId);
  const file = journalPath(planId, scenarioId);
  const journalBody = fs.readFileSync(safeFile(
    file,
    'guest journal',
    { maximum: 256 * 1024, mode: 0o600, rootOwned: true },
  ));
  const journal = validateJournal(JSON.parse(journalBody), plan, scenarioId);
  if (journal.status !== 'recovered' || journal.testMode !== false
      || journal.observations.durableRecoveryArmed !== true
      || journal.observations.processStoppedObserved !== true
      || journal.observations.healthRestored !== true
      || journal.observations.restoredSha256
        !== journal.observations.predecessorSha256
      || journal.observations.databaseAfterSha256
        !== journal.observations.databaseBeforeSha256) {
    fail('only a real recovered production-mode guest transaction can be sealed');
  }
  const root = transactionRoot(planId, scenarioId);
  const executionFile = path.join(root, 'execution.json');
  const signatureFile = path.join(root, 'execution.sig');
  if (fs.existsSync(executionFile) || fs.existsSync(signatureFile)) {
    if (!fs.existsSync(executionFile) || !fs.existsSync(signatureFile)) {
      fail('sealed guest evidence is incomplete');
    }
    const body = fs.readFileSync(safeFile(
      executionFile,
      'guest execution evidence',
      { maximum: 256 * 1024, mode: 0o600, rootOwned: true },
    ));
    const signature = fs.readFileSync(safeFile(
      signatureFile,
      'guest execution signature',
      { maximum: 1024, mode: 0o600, rootOwned: true },
    ));
    const existing = JSON.parse(body.toString('utf8'));
    if (signature.length !== 64
        || !cryptoVerify(null, body, createPublicKey(privateKey), signature)
        || existing.planId !== planId || existing.scenarioId !== scenarioId
        || existing.planSha256 !== planDigest(plan)
        || existing.terminalStatus !== 'recovered') {
      fail('existing sealed guest evidence is invalid');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: 'sealed',
      planId,
      scenarioId,
      executionSha256: sha256(body),
    })}\n`);
    return;
  }
  const observer = validateObserver(
    readJson(observerFile, 'hypervisor observer', 64 * 1024),
    journal,
  );
  const rebooted = journal.observations.bootIdBefore
    !== journal.observations.bootIdAfter;
  if ((scenarioId === 'host_reboot_during_migration') !== rebooted) {
    fail('guest boot boundary differs from the requested fault');
  }
  const execution = {
    schema: 'nexus.release-layout-guest-execution-evidence.v1',
    planId: plan.planId,
    planSha256: planDigest(plan),
    challengeNonce: plan.challengeNonce,
    migrationId: plan.migrationId,
    scenarioId,
    controlVersion: VERSION,
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
    observer,
    guest: {
      bootIdBefore: journal.observations.bootIdBefore,
      bootIdAfter: journal.observations.bootIdAfter,
    },
    producer: journal.producer,
    faultObservation: {
      journalSha256: sha256(journalBody),
      predecessorSha256: journal.observations.predecessorSha256,
      restoredSha256: journal.observations.restoredSha256,
      databaseBeforeSha256: journal.observations.databaseBeforeSha256,
      databaseAfterSha256: journal.observations.databaseAfterSha256,
      candidateHealthFailureObserved:
        journal.observations.candidateHealthFailureObserved,
      processStoppedObserved: journal.observations.processStoppedObserved,
      durableRecoveryArmed: journal.observations.durableRecoveryArmed,
    },
    completedAt: journal.completedAt,
  };
  const body = Buffer.from(`${JSON.stringify(execution, null, 2)}\n`);
  const signature = cryptoSign(null, body, privateKey);
  if (signature.length !== 64) fail('guest evidence signature length is invalid');
  durableWrite(executionFile, body);
  durableWrite(signatureFile, signature);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    status: 'sealed',
    planId,
    scenarioId,
    executionSha256: sha256(body),
  })}\n`);
}

function stage(planFile, scenarioId) {
  const plan = readJson(planFile, 'unstaged drill plan', 512 * 1024);
  validatePlan(plan, scenarioId);
  const root = transactionRoot(plan.planId, scenarioId);
  const staged = path.join(root, 'plan.json');
  if (fs.existsSync(root)) {
    const existing = readJson(staged, 'staged drill plan', 512 * 1024);
    if (canonicalJson(existing) !== canonicalJson(plan)) {
      fail('scenario transaction identity was already used by another plan');
    }
  } else {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeJson(staged, plan);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    status: 'staged',
    planId: plan.planId,
    scenarioId,
    planSha256: planDigest(plan),
  })}\n`);
}

function run(planId, scenarioId) {
  const { plan } = loadStagedPlan(planId, scenarioId);
  const file = journalPath(planId, scenarioId);
  if (fs.existsSync(file)) {
    const journal = recover(planId, scenarioId);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: journal.status,
      planId,
      scenarioId,
      resumed: true,
    })}\n`);
    return;
  }
  armFault(plan, scenarioId);
  if (scenarioId === 'failed_health_check') {
    recover(planId, scenarioId);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: 'recovered',
      planId,
      scenarioId,
    })}\n`);
    return;
  }
  if (scenarioId === 'ssh_disconnect_after_pm2_stop') {
    scheduleRecovery(planId, scenarioId);
    process.stdout.write(`NEXUS_RELEASE_LAYOUT_FAULT_ARMED ${planId} ${scenarioId}\n`);
    if (!TEST_MODE) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return;
  }
  process.stdout.write(`NEXUS_RELEASE_LAYOUT_FAULT_ARMED ${planId} ${scenarioId}\n`);
  const reboot = spawnSync(SYSTEMCTL, ['reboot'], { encoding: 'utf8' });
  if (TEST_MODE) {
    if (reboot.status !== 0) fail('test reboot command failed');
    return;
  }
  fail('guest reboot command unexpectedly returned');
}

function fetch(planId, scenarioId) {
  const { plan } = loadStagedPlan(
    planId,
    scenarioId,
    { requireActiveLifetime: false },
  );
  const root = transactionRoot(planId, scenarioId);
  const journal = validateJournal(
    readJson(
      journalPath(planId, scenarioId),
      'guest journal',
      256 * 1024,
    ),
    plan,
    scenarioId,
  );
  const executionFile = path.join(root, 'execution.json');
  const signatureFile = path.join(root, 'execution.sig');
  if (journal.status !== 'recovered') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: journal.status,
      planId,
      scenarioId,
    })}\n`);
    return;
  }
  if (!fs.existsSync(executionFile) || !fs.existsSync(signatureFile)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema: VERSION,
      status: 'recovered',
      planId,
      scenarioId,
    })}\n`);
    return;
  }
  const execution = fs.readFileSync(safeFile(
    executionFile,
    'guest execution evidence',
    { maximum: 256 * 1024, mode: 0o600, rootOwned: true },
  ));
  const signature = fs.readFileSync(safeFile(
    signatureFile,
    'guest execution signature',
    { maximum: 1024, mode: 0o600, rootOwned: true },
  ));
  if (signature.length !== 64) fail('guest execution signature is invalid');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    status: 'sealed',
    planId,
    scenarioId,
    executionEvidenceBase64: execution.toString('base64'),
    executionSignatureBase64: signature.toString('base64'),
  })}\n`);
}

function recoverAll() {
  if (!fs.existsSync(STATE_ROOT)) return;
  const pending = [];
  for (const planId of fs.readdirSync(STATE_ROOT).sort()) {
    if (planId === path.basename(MUTATION_LOCK)) continue;
    if (!UUID.test(planId)) fail('guest state contains an invalid plan identity');
    for (const scenarioId of fs.readdirSync(path.join(STATE_ROOT, planId)).sort()) {
      if (!SCENARIOS.includes(scenarioId)) fail('guest state contains an invalid scenario');
      const file = journalPath(planId, scenarioId);
      if (!fs.existsSync(file)) continue;
      const { plan } = loadStagedPlan(
        planId,
        scenarioId,
        { requireActiveLifetime: false },
      );
      const journal = validateJournal(
        readJson(file, 'guest recovery journal', 256 * 1024),
        plan,
        scenarioId,
      );
      if (['prepared', 'faulting', 'recovery_armed', 'recovering'].includes(
        journal.status,
      )) {
        pending.push([planId, scenarioId]);
      }
    }
  }
  if (pending.length > 1) fail('more than one guest recovery transaction is armed');
  if (pending.length === 1) recover(pending[0][0], pending[0][1]);
}

function cleanup(planId, scenarioId) {
  const { plan } = loadStagedPlan(
    planId,
    scenarioId,
    { requireActiveLifetime: false },
  );
  const journal = validateJournal(
    readJson(journalPath(planId, scenarioId), 'guest journal', 256 * 1024),
    plan,
    scenarioId,
  );
  if (journal.status !== 'recovered') fail('cannot clean a nonterminal scenario');
  const processFile = path.join(journal.fixture.root, 'fixture.pid');
  if (fs.existsSync(processFile)) stopFixtureService(journal.fixture.root);
}

let mutationLock = null;
try {
  if (!STATE_ROOT || !PRIVATE_KEY || !RECOVERY_UNIT_PATH || !SYSTEMCTL
      || !SYSTEMD_RUN || !FLOCK || !MUTATION_LOCK) {
    fail('required fixed runtime path is unavailable');
  }
  if (!TEST_MODE && process.getuid() !== 0) fail('must run as root inside the guest');
  const [command = '', ...args] = process.argv.slice(2);
  if (command !== 'version') mutationLock = acquireMutationLock();
  if (command === 'version' && args.length === 0) {
    process.stdout.write(`${VERSION}\n`);
  } else if (command === 'stage' && args.length === 2) {
    stage(args[0], args[1]);
  } else if (command === 'run' && args.length === 2) {
    run(args[0], args[1]);
  } else if (command === 'resume' && args.length === 2) {
    recover(args[0], args[1]);
  } else if (command === 'recover-if-present' && args.length === 2) {
    recoverIfPresent(args[0], args[1]);
  } else if (command === 'seal' && args.length === 3) {
    seal(args[0], args[1], args[2]);
  } else if (command === 'fetch' && args.length === 2) {
    fetch(args[0], args[1]);
  } else if (command === 'cleanup' && args.length === 2) {
    cleanup(args[0], args[1]);
  } else if (command === 'recover-all' && args.length === 0) {
    recoverAll();
  } else {
    fail(
      'expected version, stage, run, resume, recover-if-present, seal, '
      + 'fetch, cleanup, or recover-all',
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (mutationLock !== null) releaseMutationLock(mutationLock);
}
