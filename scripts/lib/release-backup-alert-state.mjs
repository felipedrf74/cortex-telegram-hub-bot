import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_BACKUP_ALERT_STATE_SCHEMA = 'nexus.release-backup-alert-state.v1';
export const RELEASE_BACKUP_ALERT_STATE_DIRECTORY =
  '/var/lib/nexus-release/operational-alerts';
export const RELEASE_BACKUP_ALERT_STATE_FILE =
  `${RELEASE_BACKUP_ALERT_STATE_DIRECTORY}/state.json`;
export const RELEASE_BACKUP_ALERT_LOCK_FILE =
  `${RELEASE_BACKUP_ALERT_STATE_DIRECTORY}/alert.lock`;
export const RELEASE_BACKUP_LIVENESS_INTERVAL_MS = 60 * 60 * 1000;
export const RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  120 * 1000,
]);

export const RELEASE_BACKUP_ALERT_SOURCES = Object.freeze({
  LOCAL_BACKUP: 'nexus-local-backup.service',
  RESTORE_VERIFICATION: 'nexus-local-backup-restore-verify.service',
  BACKUP_LIVENESS: 'nexus-release-backup-liveness.service',
});

const RUNBOOK_URL =
  'file:///opt/nexus-release/checkout/ops/local-backup/README.md';
const EVENT_LIFECYCLES = Object.freeze([
  'open',
  'delivered',
  'dead_letter',
  'recovered',
]);
const EVENT_FIELDS = Object.freeze([
  'source',
  'phase',
  'outcome',
  'failureCode',
  'actionRequired',
  'severity',
  'runbookUrl',
  'dedupeKey',
  'lifecycle',
  'deliveryAttempts',
  'openedAt',
  'updatedAt',
  'nextAttemptAt',
]);
const STATE_FIELDS = Object.freeze([
  'schema',
  'nextLivenessCheckAt',
  'conditions',
  'events',
]);
const CONDITION_FIELDS = Object.freeze(['source', 'status', 'observedAt']);
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const MAX_STATE_BYTES = 32 * 1024;
const MAX_EVENTS = 6;

const SOURCE_CONTRACTS = Object.freeze({
  [RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP]: Object.freeze({
    phase: 'local_backup',
    outcome: 'systemd_unit_failed',
    failureCodes: Object.freeze(['local_backup_failed']),
    actionRequired: 'inspect_local_backup_unit',
  }),
  [RELEASE_BACKUP_ALERT_SOURCES.RESTORE_VERIFICATION]: Object.freeze({
    phase: 'restore_verification',
    outcome: 'systemd_unit_failed',
    failureCodes: Object.freeze(['restore_verification_failed']),
    actionRequired: 'inspect_restore_verification_unit',
  }),
  [RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS]: Object.freeze({
    phase: 'backup_liveness',
    outcome: 'heartbeat_failed',
    failureCodes: Object.freeze([
      'backup_policy_invalid',
      'backup_evidence_invalid',
      'backup_receipt_stale',
      'restore_verification_stale',
    ]),
    actionRequired: 'inspect_backup_evidence',
  }),
});

function refuse(message) {
  throw new Error(`release backup alert state invalid: ${message}`);
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const observed = new Date(parsed);
  const expected = match.slice(1, 7).map(Number);
  const actual = [
    observed.getUTCFullYear(),
    observed.getUTCMonth() + 1,
    observed.getUTCDate(),
    observed.getUTCHours(),
    observed.getUTCMinutes(),
    observed.getUTCSeconds(),
  ];
  return actual.every((part, index) => part === expected[index]);
}

function timestamp(nowMs) {
  if (!Number.isFinite(nowMs)) refuse('clock is invalid');
  return new Date(nowMs).toISOString();
}

function contractFor(source, failureCode) {
  const contract = SOURCE_CONTRACTS[source];
  if (!contract || !contract.failureCodes.includes(failureCode)) {
    refuse('alert source or failure code is not governed');
  }
  return contract;
}

function eventFor({ source, failureCode, nowMs }) {
  const contract = contractFor(source, failureCode);
  const observedAt = timestamp(nowMs);
  return {
    source,
    phase: contract.phase,
    outcome: contract.outcome,
    failureCode,
    actionRequired: contract.actionRequired,
    severity: 'critical',
    runbookUrl: RUNBOOK_URL,
    dedupeKey: `${contract.phase}:${failureCode}`,
    lifecycle: 'open',
    deliveryAttempts: 0,
    openedAt: observedAt,
    updatedAt: observedAt,
    nextAttemptAt: observedAt,
  };
}

function assertEvent(event, nowMs) {
  if (!exactKeys(event, EVENT_FIELDS)) refuse('event fields are not closed');
  const contract = contractFor(event.source, event.failureCode);
  if (event.phase !== contract.phase || event.outcome !== contract.outcome
      || event.actionRequired !== contract.actionRequired
      || event.severity !== 'critical' || event.runbookUrl !== RUNBOOK_URL
      || event.dedupeKey !== `${contract.phase}:${event.failureCode}`
      || !EVENT_LIFECYCLES.includes(event.lifecycle)
      || !Number.isInteger(event.deliveryAttempts)
      || event.deliveryAttempts < 0 || event.deliveryAttempts > 3
      || !canonicalTimestamp(event.openedAt) || !canonicalTimestamp(event.updatedAt)
      || Date.parse(event.openedAt) > Date.parse(event.updatedAt)
      || Date.parse(event.updatedAt) > nowMs) {
    refuse('event does not match its governed alert contract');
  }
  const expectedOpenDelay = event.deliveryAttempts === 0
    ? 0
    : RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[event.deliveryAttempts - 1];
  const expectedNext = event.lifecycle === 'open'
    ? timestamp((event.deliveryAttempts === 0
      ? Date.parse(event.openedAt)
      : Date.parse(event.updatedAt)) + expectedOpenDelay)
    : null;
  if ((event.lifecycle === 'open'
        && (event.deliveryAttempts > 2 || event.nextAttemptAt !== expectedNext))
      || (event.lifecycle !== 'open' && event.nextAttemptAt !== null)
      || (['delivered', 'recovered'].includes(event.lifecycle)
        && event.deliveryAttempts < 1)
      || (event.lifecycle === 'dead_letter' && event.deliveryAttempts !== 3)) {
    refuse('event lifecycle is inconsistent');
  }
  return event;
}

function defaultState() {
  return {
    schema: RELEASE_BACKUP_ALERT_STATE_SCHEMA,
    nextLivenessCheckAt: null,
    conditions: [],
    events: [],
  };
}

function assertState(state, nowMs) {
  if (!exactKeys(state, STATE_FIELDS)
      || state.schema !== RELEASE_BACKUP_ALERT_STATE_SCHEMA
      || (state.nextLivenessCheckAt !== null
        && !canonicalTimestamp(state.nextLivenessCheckAt))
      || !Array.isArray(state.conditions)
      || !Array.isArray(state.events)
      || state.events.length > MAX_EVENTS) {
    refuse('state fields are not closed');
  }
  if (state.nextLivenessCheckAt !== null
      && Date.parse(state.nextLivenessCheckAt) > nowMs + RELEASE_BACKUP_LIVENESS_INTERVAL_MS) {
    refuse('next liveness check is implausibly far in the future');
  }
  const conditionSources = [];
  for (const condition of state.conditions) {
    if (!exactKeys(condition, CONDITION_FIELDS)
        || !Object.hasOwn(SOURCE_CONTRACTS, condition.source)
        || !['healthy', 'failed'].includes(condition.status)
        || !canonicalTimestamp(condition.observedAt)
        || Date.parse(condition.observedAt) > nowMs) {
      refuse('condition state is invalid');
    }
    conditionSources.push(condition.source);
  }
  if (new Set(conditionSources).size !== conditionSources.length
      || JSON.stringify(conditionSources) !== JSON.stringify([...conditionSources].sort())) {
    refuse('condition sources must be unique and sorted');
  }
  const sources = [];
  const conditionBySource = new Map(
    state.conditions.map((condition) => [condition.source, condition]),
  );
  for (const event of state.events) {
    assertEvent(event, nowMs);
    const condition = conditionBySource.get(event.source);
    if (!condition) refuse('event source has no condition state');
    if (condition.status === 'healthy'
        && ['delivered', 'dead_letter'].includes(event.lifecycle)) {
      refuse('resolved condition retains a suppressing event lifecycle');
    }
    sources.push(event.dedupeKey);
  }
  if (new Set(sources).size !== sources.length
      || JSON.stringify(sources) !== JSON.stringify([...sources].sort())) {
    refuse('event dedupe keys must be unique and sorted');
  }
  return state;
}

function assertPrivateDirectory(metadata, expectedUid, expectedGid) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o700) {
    refuse('state directory metadata is unsafe');
  }
}

function assertPrivateFile(metadata, expectedUid, expectedGid, { empty = false } = {}) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o600
      || (empty && metadata.size !== 0)
      || (!empty && (metadata.size <= 0 || metadata.size > MAX_STATE_BYTES))) {
    refuse('state file metadata is unsafe');
  }
}

function inspectAuthority({
  fileSystem,
  stateDirectory,
  lockFile,
  expectedUid,
  expectedGid,
  lockDescriptor,
}) {
  const directory = fileSystem.lstatSync(stateDirectory);
  assertPrivateDirectory(directory, expectedUid, expectedGid);
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      lockFile,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fileSystem.fstatSync(descriptor);
    const named = fileSystem.lstatSync(lockFile);
    const held = fileSystem.fstatSync(lockDescriptor);
    assertPrivateFile(opened, expectedUid, expectedGid, { empty: true });
    assertPrivateFile(named, expectedUid, expectedGid, { empty: true });
    assertPrivateFile(held, expectedUid, expectedGid, { empty: true });
    if (!sameSnapshot(opened, named) || !sameSnapshot(opened, held)) {
      refuse('held lock descriptor and path disagree');
    }
    return { directory, lock: opened };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('release backup alert state invalid:')) {
      throw error;
    }
    return refuse('kernel lock file could not be descriptor-bound');
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function reassertAuthority(binding, options) {
  const currentDirectory = options.fileSystem.lstatSync(options.stateDirectory);
  const currentLock = options.fileSystem.lstatSync(options.lockFile);
  const heldLock = options.fileSystem.fstatSync(options.lockDescriptor);
  assertPrivateDirectory(currentDirectory, options.expectedUid, options.expectedGid);
  assertPrivateFile(currentLock, options.expectedUid, options.expectedGid, { empty: true });
  assertPrivateFile(heldLock, options.expectedUid, options.expectedGid, { empty: true });
  if (!sameIdentity(binding.directory, currentDirectory)
      || !sameSnapshot(binding.lock, currentLock)
      || !sameSnapshot(binding.lock, heldLock)) {
    refuse('state authority changed during operation');
  }
}

function readStateFile(options, nowMs) {
  const binding = inspectAuthority(options);
  let descriptor;
  try {
    descriptor = options.fileSystem.openSync(
      options.stateFile,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      reassertAuthority(binding, options);
      return defaultState();
    }
    return refuse('state file could not be opened safely');
  }
  try {
    const opened = options.fileSystem.fstatSync(descriptor);
    const named = options.fileSystem.lstatSync(options.stateFile);
    assertPrivateFile(opened, options.expectedUid, options.expectedGid);
    assertPrivateFile(named, options.expectedUid, options.expectedGid);
    if (!sameSnapshot(opened, named)) refuse('state descriptor and path disagree');
    const body = options.fileSystem.readFileSync(descriptor, 'utf8');
    const after = options.fileSystem.lstatSync(options.stateFile);
    assertPrivateFile(after, options.expectedUid, options.expectedGid);
    if (!sameSnapshot(opened, after)) refuse('state changed during read');
    let state;
    try {
      state = JSON.parse(body);
    } catch {
      return refuse('state JSON is malformed');
    }
    reassertAuthority(binding, options);
    return assertState(state, nowMs);
  } finally {
    options.fileSystem.closeSync(descriptor);
  }
}

function writeStateFile(options, state, nowMs) {
  assertState(state, nowMs);
  const binding = inspectAuthority(options);
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const temporary = `${options.stateFile}.next-${process.pid}-${nowMs}`;
  let descriptor;
  try {
    descriptor = options.fileSystem.openSync(temporary, 'wx', 0o600);
    options.fileSystem.writeFileSync(descriptor, body);
    options.fileSystem.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) options.fileSystem.closeSync(descriptor);
  }
  const temporaryMetadata = options.fileSystem.lstatSync(temporary);
  assertPrivateFile(temporaryMetadata, options.expectedUid, options.expectedGid);
  reassertAuthority(binding, options);
  options.fileSystem.renameSync(temporary, options.stateFile);
  const directoryDescriptor = options.fileSystem.openSync(options.stateDirectory, 'r');
  try {
    options.fileSystem.fsyncSync(directoryDescriptor);
  } finally {
    options.fileSystem.closeSync(directoryDescriptor);
  }
  const installed = options.fileSystem.lstatSync(options.stateFile);
  assertPrivateFile(installed, options.expectedUid, options.expectedGid);
  reassertAuthority(binding, options);
}

function replaceEvent(state, event) {
  return {
    ...state,
    events: [
      ...state.events.filter((candidate) => candidate.dedupeKey !== event.dedupeKey),
      event,
    ].sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey)),
  };
}

function replaceCondition(state, condition) {
  return {
    ...state,
    conditions: [
      ...state.conditions.filter((candidate) => candidate.source !== condition.source),
      condition,
    ].sort((left, right) => left.source.localeCompare(right.source)),
  };
}

export function createReleaseBackupAlertStore({
  fileSystem = fs,
  stateDirectory = RELEASE_BACKUP_ALERT_STATE_DIRECTORY,
  stateFile = path.join(stateDirectory, 'state.json'),
  lockFile = path.join(stateDirectory, 'alert.lock'),
  expectedUid = 0,
  expectedGid = 0,
  now = () => Date.now(),
  lockHeld = process.env.NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD === '1',
  lockDescriptor = Number(process.env.NEXUS_RELEASE_BACKUP_ALERT_LOCK_FD),
} = {}) {
  if (!path.isAbsolute(stateDirectory) || path.dirname(stateFile) !== stateDirectory
      || path.dirname(lockFile) !== stateDirectory) {
    refuse('state paths are not fixed beneath one authority directory');
  }
  if (!lockHeld) refuse('kernel serialization marker is absent');
  if (!Number.isSafeInteger(lockDescriptor) || lockDescriptor < 3) {
    refuse('held kernel lock descriptor is absent');
  }
  const options = {
    fileSystem,
    stateDirectory,
    stateFile,
    lockFile,
    expectedUid,
    expectedGid,
    lockDescriptor,
  };
  const read = () => {
    const nowMs = now();
    return { state: readStateFile(options, nowMs), nowMs };
  };
  const write = (state, nowMs) => writeStateFile(options, state, nowMs);

  return {
    readState() {
      return read().state;
    },
    openFailure({ source, failureCode }) {
      const { state, nowMs } = read();
      const proposed = eventFor({ source, failureCode, nowMs });
      const current = state.events.find((event) => event.dedupeKey === proposed.dedupeKey);
      const failedState = replaceCondition(state, {
        source,
        status: 'failed',
        observedAt: timestamp(nowMs),
      });
      if (current?.dedupeKey === proposed.dedupeKey
          && ['open', 'delivered', 'dead_letter'].includes(current.lifecycle)) {
        write(failedState, nowMs);
        return {
          event: current,
          deduped: current.lifecycle === 'delivered',
          due: current.lifecycle === 'open' && Date.parse(current.nextAttemptAt) <= nowMs,
        };
      }
      const next = replaceEvent(failedState, proposed);
      write(next, nowMs);
      return { event: proposed, deduped: false, due: true };
    },
    dueEvents() {
      const { state, nowMs } = read();
      return state.events.filter(
        (event) => event.lifecycle === 'open' && Date.parse(event.nextAttemptAt) <= nowMs,
      );
    },
    recordDeliveryAttempt({ dedupeKey, delivered }) {
      const { state, nowMs } = read();
      const current = state.events.find((event) => event.dedupeKey === dedupeKey);
      if (!current || current.lifecycle !== 'open'
          || Date.parse(current.nextAttemptAt) > nowMs
          || current.deliveryAttempts >= 3) {
        refuse('delivery attempt is not due');
      }
      const deliveryAttempts = current.deliveryAttempts + 1;
      let lifecycle = delivered ? 'delivered' : 'open';
      let nextAttemptAt = null;
      if (!delivered && deliveryAttempts < 3) {
        const delay = RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[deliveryAttempts - 1];
        nextAttemptAt = timestamp(nowMs + delay);
      } else if (!delivered) {
        lifecycle = 'dead_letter';
      }
      const condition = state.conditions.find((candidate) => candidate.source === current.source);
      const event = {
        ...current,
        lifecycle: condition?.status === 'healthy'
          && (delivered || deliveryAttempts === 3)
          ? 'recovered'
          : lifecycle,
        deliveryAttempts,
        updatedAt: timestamp(nowMs),
        nextAttemptAt,
      };
      const next = replaceEvent(state, event);
      write(next, nowMs);
      return event;
    },
    resolveSource(source) {
      if (!Object.hasOwn(SOURCE_CONTRACTS, source)) refuse('source is not governed');
      const { state, nowMs } = read();
      const current = state.events.filter((event) => event.source === source);
      let next = replaceCondition(state, {
        source,
        status: 'healthy',
        observedAt: timestamp(nowMs),
      });
      const recovered = [];
      for (const existing of current) {
        if (!['delivered', 'dead_letter'].includes(existing.lifecycle)) continue;
        const event = {
          ...existing,
          lifecycle: 'recovered',
          updatedAt: timestamp(nowMs),
          nextAttemptAt: null,
        };
        next = replaceEvent(next, event);
        recovered.push(event);
      }
      write(next, nowMs);
      return recovered;
    },
    requeueDeadLetter(dedupeKey) {
      const { state, nowMs } = read();
      const current = state.events.find((event) => event.dedupeKey === dedupeKey);
      if (!current || current.lifecycle !== 'dead_letter') {
        refuse('only a dead-letter event may be manually requeued');
      }
      const event = {
        ...current,
        lifecycle: 'open',
        deliveryAttempts: 0,
        openedAt: timestamp(nowMs),
        updatedAt: timestamp(nowMs),
        nextAttemptAt: timestamp(nowMs),
      };
      write(replaceEvent(state, event), nowMs);
      return event;
    },
    livenessDue() {
      const { state, nowMs } = read();
      return state.nextLivenessCheckAt === null
        || Date.parse(state.nextLivenessCheckAt) <= nowMs;
    },
    markLivenessChecked() {
      const { state, nowMs } = read();
      const hourStart = Math.floor(nowMs / RELEASE_BACKUP_LIVENESS_INTERVAL_MS)
        * RELEASE_BACKUP_LIVENESS_INTERVAL_MS;
      const thisHourTwenty = hourStart + (20 * 60 * 1000);
      const nextCheckMs = thisHourTwenty > nowMs
        ? thisHourTwenty
        : thisHourTwenty + RELEASE_BACKUP_LIVENESS_INTERVAL_MS;
      const next = {
        ...state,
        nextLivenessCheckAt: timestamp(nextCheckMs),
      };
      write(next, nowMs);
      return next.nextLivenessCheckAt;
    },
  };
}

export function releaseBackupAlertContract(source, failureCode) {
  const contract = contractFor(source, failureCode);
  return Object.freeze({
    source,
    phase: contract.phase,
    outcome: contract.outcome,
    failureCode,
    actionRequired: contract.actionRequired,
    severity: 'critical',
    runbookUrl: RUNBOOK_URL,
    dedupeKey: `${contract.phase}:${failureCode}`,
  });
}

export async function deliverDueReleaseBackupAlert({ store, event, notifier }) {
  let delivered = false;
  let reason = 'notification_failed';
  try {
    const result = await notifier.send({
      kind: 'failure',
      release: {
        releaseId: null,
        sourceSha: null,
        phase: event.phase,
        outcome: event.outcome,
        failureCode: event.failureCode,
        rollbackResult: 'not_applicable',
        actionRequired: event.actionRequired,
        alertSource: event.source,
        alertSeverity: event.severity,
        alertRunbookUrl: event.runbookUrl,
        alertDedupeKey: event.dedupeKey,
      },
    });
    delivered = result?.delivered === true;
    reason = typeof result?.reason === 'string' ? result.reason : reason;
  } catch {
    // The durable open event remains the authority. Provider errors and bodies
    // are neither persisted nor emitted.
  }
  const updated = store.recordDeliveryAttempt({ dedupeKey: event.dedupeKey, delivered });
  return { delivered, reason, event: updated };
}

export async function drainDueReleaseBackupAlerts({ store, notifier }) {
  const results = [];
  for (const event of store.dueEvents()) {
    results.push(await deliverDueReleaseBackupAlert({ store, event, notifier }));
  }
  return results;
}
