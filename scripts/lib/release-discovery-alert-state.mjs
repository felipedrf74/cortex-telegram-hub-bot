import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELEASE_DISCOVERY_ALERT_STATE_SCHEMA =
  'nexus.release-discovery-alert-state.v1';
export const RELEASE_DISCOVERY_ALERT_SOURCE = 'nexus-release-poller.service';
export const RELEASE_DISCOVERY_ALERT_RETRY_DELAYS_MS = Object.freeze([
  60 * 1000,
  120 * 1000,
]);

export const RELEASE_DISCOVERY_FAILURE_CODES = Object.freeze({
  CONTROLLER_SCHEMA_INCOMPATIBLE: 'controller_schema_incompatible',
  DISCOVERY_FAILED: 'release_discovery_failed',
});

const RUNBOOK_URL =
  'file:///opt/nexus-release/checkout/ops/nexus-release/README.md#9-notifications';
const STATE_FILE_NAME = 'release-discovery-alert.json';
const STATE_FIELDS = Object.freeze(['schema', 'condition', 'events']);
const CONDITION_FIELDS = Object.freeze(['status', 'observedAt']);
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
const EVENT_LIFECYCLES = Object.freeze([
  'open',
  'delivered',
  'dead_letter',
  'recovered',
]);
const MAX_STATE_BYTES = 16 * 1024;
const MAX_EVENTS = 1;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u;
const TEMPORARY_FILE =
  /^release-discovery-alert\.json\.next-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const FAILURE_CONTRACTS = Object.freeze({
  [RELEASE_DISCOVERY_FAILURE_CODES.CONTROLLER_SCHEMA_INCOMPATIBLE]: Object.freeze({
    actionRequired: 'upgrade_installed_release_controller',
  }),
  [RELEASE_DISCOVERY_FAILURE_CODES.DISCOVERY_FAILED]: Object.freeze({
    actionRequired: 'inspect_release_controller',
  }),
});

function refuse(message) {
  throw new Error(`release discovery alert state invalid: ${message}`);
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

function contractFor(failureCode) {
  const contract = FAILURE_CONTRACTS[failureCode];
  if (!contract) refuse('failure code is not governed');
  return contract;
}

function eventFor({ failureCode, nowMs }) {
  const contract = contractFor(failureCode);
  const observedAt = timestamp(nowMs);
  return {
    source: RELEASE_DISCOVERY_ALERT_SOURCE,
    phase: 'discovery_verification',
    outcome: 'poll_failed',
    failureCode,
    actionRequired: contract.actionRequired,
    severity: 'error',
    runbookUrl: RUNBOOK_URL,
    dedupeKey: 'release_discovery:poll_failed',
    lifecycle: 'open',
    deliveryAttempts: 0,
    openedAt: observedAt,
    updatedAt: observedAt,
    nextAttemptAt: observedAt,
  };
}

function assertEvent(event, nowMs) {
  if (!exactKeys(event, EVENT_FIELDS)) refuse('event fields are not closed');
  const contract = contractFor(event.failureCode);
  if (event.source !== RELEASE_DISCOVERY_ALERT_SOURCE
      || event.phase !== 'discovery_verification'
      || event.outcome !== 'poll_failed'
      || event.actionRequired !== contract.actionRequired
      || event.severity !== 'error'
      || event.runbookUrl !== RUNBOOK_URL
      || event.dedupeKey !== 'release_discovery:poll_failed'
      || !EVENT_LIFECYCLES.includes(event.lifecycle)
      || !Number.isInteger(event.deliveryAttempts)
      || event.deliveryAttempts < 0
      || event.deliveryAttempts > 3
      || !canonicalTimestamp(event.openedAt)
      || !canonicalTimestamp(event.updatedAt)
      || Date.parse(event.openedAt) > Date.parse(event.updatedAt)
      || Date.parse(event.updatedAt) > nowMs) {
    refuse('event does not match its governed alert contract');
  }
  const expectedOpenDelay = event.deliveryAttempts === 0
    ? 0
    : RELEASE_DISCOVERY_ALERT_RETRY_DELAYS_MS[event.deliveryAttempts - 1];
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

function assertState(state, nowMs) {
  if (!exactKeys(state, STATE_FIELDS)
      || state.schema !== RELEASE_DISCOVERY_ALERT_STATE_SCHEMA
      || (state.condition !== null && !exactKeys(state.condition, CONDITION_FIELDS))
      || !Array.isArray(state.events)
      || state.events.length > MAX_EVENTS) {
    refuse('state fields are not closed');
  }
  if (state.condition !== null
      && (!['healthy', 'failed'].includes(state.condition.status)
        || !canonicalTimestamp(state.condition.observedAt)
        || Date.parse(state.condition.observedAt) > nowMs)) {
    refuse('condition state is invalid');
  }
  if (state.events.length > 0 && state.condition === null) {
    refuse('event state has no condition');
  }
  const keys = [];
  for (const event of state.events) {
    assertEvent(event, nowMs);
    if (state.condition?.status === 'healthy'
        && ['delivered', 'dead_letter'].includes(event.lifecycle)) {
      refuse('resolved condition retains a suppressing event lifecycle');
    }
    keys.push(event.dedupeKey);
  }
  if (new Set(keys).size !== keys.length
      || JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    refuse('event dedupe keys must be unique and sorted');
  }
  return state;
}

function defaultState() {
  return {
    schema: RELEASE_DISCOVERY_ALERT_STATE_SCHEMA,
    condition: null,
    events: [],
  };
}

function assertPrivateDirectory(metadata, expectedUid, expectedGid) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o700) {
    refuse('state directory metadata is unsafe');
  }
}

function assertPrivateFile(metadata, expectedUid, expectedGid) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size <= 0 || metadata.size > MAX_STATE_BYTES) {
    refuse('state file metadata is unsafe');
  }
}

function assertPrivateLockFile(metadata, expectedUid, expectedGid) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o600 || metadata.size !== 0) {
    refuse('release lock metadata is unsafe');
  }
}

function assertPrivateTemporaryFile(metadata, expectedUid, expectedGid) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.uid !== expectedUid || metadata.gid !== expectedGid
      || (metadata.mode & 0o777) !== 0o600
      || metadata.size < 0 || metadata.size > MAX_STATE_BYTES) {
    refuse('temporary state file metadata is unsafe');
  }
}

function inspectAuthority(options) {
  const directory = options.fileSystem.lstatSync(options.stateDirectory);
  assertPrivateDirectory(directory, options.expectedUid, options.expectedGid);
  let descriptor;
  try {
    descriptor = options.fileSystem.openSync(
      options.lockFile,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = options.fileSystem.fstatSync(descriptor);
    const named = options.fileSystem.lstatSync(options.lockFile);
    const held = options.fileSystem.fstatSync(options.lockDescriptor);
    assertPrivateLockFile(opened, options.expectedUid, options.expectedGid);
    assertPrivateLockFile(named, options.expectedUid, options.expectedGid);
    assertPrivateLockFile(held, options.expectedUid, options.expectedGid);
    if (!sameSnapshot(opened, named) || !sameSnapshot(opened, held)) {
      refuse('held release lock descriptor and path disagree');
    }
    return { directory, lock: opened };
  } catch (error) {
    if (error instanceof Error
        && error.message.startsWith('release discovery alert state invalid:')) {
      throw error;
    }
    return refuse('release lock could not be descriptor-bound');
  } finally {
    if (descriptor !== undefined) options.fileSystem.closeSync(descriptor);
  }
}

function reassertAuthority(binding, options) {
  const currentDirectory = options.fileSystem.lstatSync(options.stateDirectory);
  const currentLock = options.fileSystem.lstatSync(options.lockFile);
  const heldLock = options.fileSystem.fstatSync(options.lockDescriptor);
  assertPrivateDirectory(currentDirectory, options.expectedUid, options.expectedGid);
  assertPrivateLockFile(currentLock, options.expectedUid, options.expectedGid);
  assertPrivateLockFile(heldLock, options.expectedUid, options.expectedGid);
  if (!sameIdentity(binding.directory, currentDirectory)
      || !sameSnapshot(binding.lock, currentLock)
      || !sameSnapshot(binding.lock, heldLock)) {
    refuse('release alert state authority changed during operation');
  }
}

function fsyncStateDirectory(options) {
  const descriptor = options.fileSystem.openSync(options.stateDirectory, 'r');
  try {
    options.fileSystem.fsyncSync(descriptor);
  } finally {
    options.fileSystem.closeSync(descriptor);
  }
}

function removeStaleTemporaryFiles(binding, options) {
  let removed = false;
  for (const name of options.fileSystem.readdirSync(options.stateDirectory).sort()) {
    if (!name.startsWith(`${STATE_FILE_NAME}.next-`)) continue;
    if (!TEMPORARY_FILE.test(name)) refuse('temporary state filename is unsafe');
    const temporary = path.join(options.stateDirectory, name);
    const before = options.fileSystem.lstatSync(temporary);
    assertPrivateTemporaryFile(before, options.expectedUid, options.expectedGid);
    reassertAuthority(binding, options);
    options.fileSystem.unlinkSync(temporary);
    removed = true;
  }
  if (removed) fsyncStateDirectory(options);
  reassertAuthority(binding, options);
}

function readStateFile(options, nowMs) {
  const authority = inspectAuthority(options);
  removeStaleTemporaryFiles(authority, options);
  let descriptor;
  try {
    descriptor = options.fileSystem.openSync(
      options.stateFile,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      reassertAuthority(authority, options);
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
    reassertAuthority(authority, options);
    return assertState(state, nowMs);
  } finally {
    options.fileSystem.closeSync(descriptor);
  }
}

function writeStateFile(options, state, nowMs) {
  assertState(state, nowMs);
  const authority = inspectAuthority(options);
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const temporary = `${options.stateFile}.next-${process.pid}-${randomUUID()}`;
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
  reassertAuthority(authority, options);
  options.fileSystem.renameSync(temporary, options.stateFile);
  fsyncStateDirectory(options);
  const installed = options.fileSystem.lstatSync(options.stateFile);
  assertPrivateFile(installed, options.expectedUid, options.expectedGid);
  reassertAuthority(authority, options);
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

export function classifyReleaseDiscoveryFailure(error) {
  if (error instanceof Error
      && error.message === 'release manifest envelope schema is invalid') {
    return RELEASE_DISCOVERY_FAILURE_CODES.CONTROLLER_SCHEMA_INCOMPATIBLE;
  }
  return RELEASE_DISCOVERY_FAILURE_CODES.DISCOVERY_FAILED;
}

export function releaseDiscoveryAlertContract(failureCode) {
  const contract = contractFor(failureCode);
  return Object.freeze({
    source: RELEASE_DISCOVERY_ALERT_SOURCE,
    phase: 'discovery_verification',
    outcome: 'poll_failed',
    failureCode,
    actionRequired: contract.actionRequired,
    severity: 'error',
    runbookUrl: RUNBOOK_URL,
    dedupeKey: 'release_discovery:poll_failed',
  });
}

const VERIFIED_NOOP_REASONS = Object.freeze([
  'already_completed',
  'already_completed_payload',
]);

export function releaseDeploymentResultProvesDiscovery(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !/^[0-9a-f]{32}$/u.test(String(result.releaseId ?? ''))) {
    return false;
  }
  if (result.outcome === 'noop' && VERIFIED_NOOP_REASONS.includes(result.reason)) {
    return true;
  }
  if (result.outcome === 'deferred' && result.reason === 'control_plane_mismatch') {
    return true;
  }
  if (result.outcome === 'refused'
      && (['previously_failed_digests', 'non_monotonic_source_order'].includes(result.reason)
        || /^already_settled_(completed|rolled_back|rollback_failed)$/u.test(
          String(result.reason ?? ''),
        ))) {
    return true;
  }
  // Crash recovery can write rollback receipts without inspecting the current
  // moving release payload. Those outcomes are deliberately excluded: only
  // ordinary post-discovery terminal receipts can rearm this source.
  return ['completed', 'blocked', 'staging_failed']
    .includes(result.outcome)
    && /^[0-9a-f]{64}$/u.test(String(result.receiptDigest ?? ''))
    && path.isAbsolute(String(result.receiptPath ?? ''));
}

export function createReleaseDiscoveryAlertStore({
  fileSystem = fs,
  stateDirectory,
  stateFile = path.join(stateDirectory ?? '', STATE_FILE_NAME),
  lockFile,
  expectedUid = 0,
  expectedGid = 0,
  now = () => Date.now(),
  lockHeld = process.env.NEXUS_RELEASE_LOCK_HELD === '1',
  lockDescriptor = Number(process.env.NEXUS_RELEASE_LOCK_FD),
} = {}) {
  if (!path.isAbsolute(stateDirectory ?? '')
      || stateFile !== path.join(stateDirectory, STATE_FILE_NAME)
      || !path.isAbsolute(lockFile ?? '')) {
    refuse('state path is not fixed beneath the release state directory');
  }
  if (!lockHeld) refuse('release serialization marker is absent');
  if (!Number.isSafeInteger(lockDescriptor) || lockDescriptor < 3) {
    refuse('held release lock descriptor is absent');
  }
  const options = {
    fileSystem,
    stateDirectory,
    stateFile,
    lockFile,
    lockDescriptor,
    expectedUid,
    expectedGid,
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
    openFailure({ failureCode }) {
      const { state, nowMs } = read();
      const proposed = eventFor({ failureCode, nowMs });
      const current = state.events.find((event) => event.dedupeKey === proposed.dedupeKey);
      const failedState = state.condition?.status === 'failed'
        ? state
        : {
          ...state,
          condition: { status: 'failed', observedAt: timestamp(nowMs) },
        };
      if (current && ['open', 'delivered', 'dead_letter'].includes(current.lifecycle)) {
        if (failedState !== state) write(failedState, nowMs);
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
        nextAttemptAt = timestamp(
          nowMs + RELEASE_DISCOVERY_ALERT_RETRY_DELAYS_MS[deliveryAttempts - 1],
        );
      } else if (!delivered) {
        lifecycle = 'dead_letter';
      }
      if (state.condition?.status === 'healthy'
          && (delivered || deliveryAttempts === 3)) {
        lifecycle = 'recovered';
      }
      const event = {
        ...current,
        lifecycle,
        deliveryAttempts,
        updatedAt: timestamp(nowMs),
        nextAttemptAt,
      };
      write(replaceEvent(state, event), nowMs);
      return event;
    },
    resolve() {
      const { state, nowMs } = read();
      if (state.events.length === 0) return state;
      let changed = state.condition?.status !== 'healthy';
      let next = {
        ...state,
        condition: changed
          ? { status: 'healthy', observedAt: timestamp(nowMs) }
          : state.condition,
      };
      for (const existing of state.events) {
        if (!['delivered', 'dead_letter'].includes(existing.lifecycle)) continue;
        changed = true;
        next = replaceEvent(next, {
          ...existing,
          lifecycle: 'recovered',
          updatedAt: timestamp(nowMs),
          nextAttemptAt: null,
        });
      }
      if (changed) write(next, nowMs);
      return next;
    },
  };
}

export async function drainDueReleaseDiscoveryAlerts({ store, notifier }) {
  const results = [];
  for (const event of store.dueEvents()) {
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
      // The durable open event remains authoritative. Provider errors and
      // provider bodies are never persisted or logged.
    }
    const updated = store.recordDeliveryAttempt({
      dedupeKey: event.dedupeKey,
      delivered,
    });
    results.push({ delivered, reason, event: updated });
  }
  return results;
}
