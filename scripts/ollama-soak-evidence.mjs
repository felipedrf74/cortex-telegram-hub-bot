#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const OLLAMA_COLLECTOR_RESULT_SCHEMA = 'nexus.ollama-observation-collector-result.v1';
export const OLLAMA_COLLECTOR_SAMPLE_SCHEMA = 'nexus.ollama-observation-sample.v1';
export const OLLAMA_COLLECTOR_REQUEST_SCHEMA = 'nexus.ollama-observation-requests.v1';
export const OLLAMA_CLEANUP_EVIDENCE_SCHEMA = OLLAMA_COLLECTOR_RESULT_SCHEMA;
export const OLLAMA_RETAINED_TAG = 'qwen2.5:3b-instruct-q4_K_M';
export const OLLAMA_DELETE_TAGS = Object.freeze([
  'gemma2:2b-instruct-q4_K_M',
  'qwen3.6:27b-q4_K_M',
  'qwen3.6:35b-a3b-q4_K_M',
]);
export const OLLAMA_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RUN_ID = /^(?:staging|production|zero_swap)-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u;
const MIN_OBSERVATION_SECONDS = 24 * 60 * 60;
const PRODUCTION_INTERVAL_SECONDS = 300;
const MAX_SAMPLE_GAP_SECONDS = 315;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const MAX_SAMPLES = 400;
const REQUIRED_API_USAGE_COLUMNS = Object.freeze([
  'id', 'ts', 'provider', 'model', 'pricing_status', 'local_request_units',
]);
const PRODUCTION_COLLECTOR = '/usr/local/sbin/nexus-ollama-observation-collector.mjs';

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function testMode() {
  return process.env.NEXUS_OLLAMA_COLLECTOR_TEST_MODE === '1';
}

function secureOwner(info, label) {
  if (typeof process.getuid !== 'function') return;
  const expected = testMode() ? process.getuid() : 0;
  if (info.uid !== expected) fail(`${label} must be owned by ${testMode() ? 'the test account' : 'root'}`);
}

function secureDirectory(path, label, mode = 0o700) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) fail(`${label} path must be canonical and absolute`);
  let canonical;
  try { canonical = realpathSync.native(path); } catch { fail(`${label} is missing or inaccessible`); }
  if (canonical !== path) fail(`${label} path must not contain symlinks`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a non-symlink directory`);
  secureOwner(info, label);
  if ((info.mode & 0o777) !== mode) fail(`${label} must have mode ${mode.toString(8).padStart(4, '0')}`);
  return path;
}

export function readSecureJsonEvidence(filePath, label = 'evidence') {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath === '/' || resolve(filePath) !== filePath) {
    fail(`${label} path must be a safe canonical absolute path`);
  }
  let canonical;
  try { canonical = realpathSync.native(filePath); } catch { fail(`${label} file is missing or inaccessible`); }
  if (canonical !== filePath) fail(`${label} path must not contain symlinks`);
  const info = lstatSync(filePath);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  secureOwner(info, label);
  if ((info.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`);
  if (info.size > MAX_EVIDENCE_BYTES) fail(`${label} is unexpectedly large`);
  const raw = readFileSync(filePath);
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { fail(`${label} is not valid JSON`); }
  return { path: filePath, raw, value, digest: digest(raw) };
}

function reference(value, label) {
  exactKeys(value, ['path', 'sha256'], `${label} reference`);
  if (!OLLAMA_DIGEST_PATTERN.test(value.sha256 || '')) fail(`${label} reference digest is invalid`);
  const file = readSecureJsonEvidence(value.path, label);
  if (file.digest !== value.sha256) fail(`${label} digest mismatch`);
  return file;
}

function model(value, label) {
  exactKeys(value, ['tag', 'digest'], label);
  if (typeof value.tag !== 'string' || !OLLAMA_DIGEST_PATTERN.test(value.digest || '')) {
    fail(`${label} must contain an exact tag and full lowercase sha256 digest`);
  }
  return { tag: value.tag, digest: value.digest };
}

function models(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) fail(`${label} must contain one through four exact models`);
  const output = value.map((entry, index) => model(entry, `${label}[${index}]`));
  if (new Set(output.map((entry) => entry.tag)).size !== output.length) fail(`${label} contains duplicate tags`);
  if (output.some((entry, index) => index > 0 && output[index - 1].tag.localeCompare(entry.tag) >= 0)) {
    fail(`${label} must be sorted by tag`);
  }
  return output;
}

function assertInventory(phase, inventory, retained) {
  const expected = phase === 'zero_swap'
    ? [OLLAMA_RETAINED_TAG]
    : [OLLAMA_RETAINED_TAG, ...OLLAMA_DELETE_TAGS].sort();
  if (inventory.length !== expected.length || expected.some((tag, index) => inventory[index].tag !== tag)) {
    fail(`${phase} collector inventory is not the exact governed model set`);
  }
  const observedRetained = inventory.find((entry) => entry.tag === OLLAMA_RETAINED_TAG);
  if (!observedRetained || observedRetained.digest !== retained.digest) fail('collector retained-model digest is inconsistent');
}

function validateCollectorIdentity(value, runDirectory) {
  exactKeys(value, ['executablePath', 'sourceSha256', 'executionUid'], 'collector identity');
  if (!OLLAMA_DIGEST_PATTERN.test(value.sourceSha256 || '')) fail('collector source digest is invalid');
  if (value.executionUid !== 0 && !testMode()) fail('collector did not execute as root');
  if (value.executionUid !== (typeof process.getuid === 'function' ? process.getuid() : value.executionUid) && testMode()) {
    fail('test collector execution UID mismatch');
  }
  const expectedPath = testMode() ? resolve(value.executablePath || '') : PRODUCTION_COLLECTOR;
  if (value.executablePath !== expectedPath || !isAbsolute(expectedPath)) fail('collector executable provenance path is invalid');
  let canonical;
  try { canonical = realpathSync.native(expectedPath); } catch { fail('installed collector executable is unavailable'); }
  if (canonical !== expectedPath) fail('collector executable must not be reached through a symlink');
  const sourceInfo = lstatSync(expectedPath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) fail('collector executable must be a regular file');
  secureOwner(sourceInfo, 'collector executable');
  if (!testMode() && (sourceInfo.mode & 0o777) !== 0o700) fail('installed collector executable must have mode 0700');
  if (testMode() && (sourceInfo.mode & 0o022) !== 0) fail('test collector source must not be group- or world-writable');
  if (digest(readFileSync(expectedPath)) !== value.sourceSha256) fail('collector executable digest does not match recorded provenance');
  secureDirectory(runDirectory, 'collector run directory');
}

function validateEnvelope(value, label) {
  exactKeys(value, [
    'contextLength', 'maxQueue', 'numParallel', 'maxLoadedModels', 'memoryHighBytes',
    'memoryMaxBytes', 'memorySwapMaxBytes', 'cpuQuotaUsecPerSec',
  ], label);
  const expected = {
    contextLength: 4096,
    maxQueue: 4,
    numParallel: 1,
    maxLoadedModels: 1,
    memoryHighBytes: 4 * 1024 * 1024 * 1024,
    memoryMaxBytes: 6 * 1024 * 1024 * 1024,
    memorySwapMaxBytes: 512 * 1024 * 1024,
    cpuQuotaUsecPerSec: 2_000_000,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail(`${label}.${key} does not match the fixed pre-transition envelope`);
  }
}

function validateSample(file, expected, previousDigest, baseline) {
  const value = file.value;
  exactKeys(value, [
    'schema', 'runId', 'phase', 'sequence', 'capturedAt', 'bootId', 'monotonicSeconds',
    'previousSampleSha256', 'ollama', 'application', 'service', 'host',
  ], `sample ${expected.sequence}`);
  if (value.schema !== OLLAMA_COLLECTOR_SAMPLE_SCHEMA || value.runId !== expected.runId
      || value.phase !== expected.phase || value.sequence !== expected.sequence || value.bootId !== expected.bootId) {
    fail(`sample ${expected.sequence} identity mismatch`);
  }
  timestamp(value.capturedAt, `sample ${expected.sequence}.capturedAt`);
  safeInteger(value.monotonicSeconds, `sample ${expected.sequence}.monotonicSeconds`);
  if (value.previousSampleSha256 !== previousDigest) fail(`sample ${expected.sequence} hash chain is broken`);

  exactKeys(value.ollama, ['healthy', 'inventory', 'loaded'], `sample ${expected.sequence}.ollama`);
  if (value.ollama.healthy !== true) fail(`sample ${expected.sequence} reports unhealthy Ollama`);
  const inventory = models(value.ollama.inventory, `sample ${expected.sequence}.ollama.inventory`);
  if (JSON.stringify(inventory) !== JSON.stringify(expected.inventory)) fail('collector inventory changed during the observation');
  if (!Array.isArray(value.ollama.loaded) || value.ollama.loaded.length > 1
      || value.ollama.loaded.some((tag) => tag !== OLLAMA_RETAINED_TAG)) {
    fail(`sample ${expected.sequence} loaded an unapproved Ollama model`);
  }

  exactKeys(value.application, ['backendHealthy', 'contentHealthy', 'pm2'], `sample ${expected.sequence}.application`);
  if (value.application.backendHealthy !== true || value.application.contentHealthy !== true) {
    fail(`sample ${expected.sequence} reports unhealthy application service`);
  }
  if (!Array.isArray(value.application.pm2) || value.application.pm2.length !== 2) fail('collector PM2 evidence is incomplete');
  for (const [index, row] of value.application.pm2.entries()) {
    exactKeys(row, ['name', 'status', 'restartCount', 'releaseSha'], `sample ${expected.sequence}.application.pm2[${index}]`);
    if (row.name !== expected.pm2Names[index] || row.status !== 'online'
        || !/^[a-f0-9]{40}$/u.test(row.releaseSha || '')) fail('collector PM2 identity is unhealthy or ambiguous');
    safeInteger(row.restartCount, 'PM2 restart count');
  }

  exactKeys(value.service, ['activeState', 'restartCount', 'envelope'], `sample ${expected.sequence}.service`);
  if (value.service.activeState !== 'active') fail('Ollama systemd service was not active for every sample');
  safeInteger(value.service.restartCount, 'Ollama restart count');
  validateEnvelope(value.service.envelope, `sample ${expected.sequence}.service.envelope`);

  exactKeys(value.host, [
    'load15Milli', 'memAvailableKiB', 'swapInPages', 'swapOutPages',
    'memoryPressureTotalMicros', 'kernelOomEventsSinceBoot',
  ], `sample ${expected.sequence}.host`);
  for (const key of Object.keys(value.host)) safeInteger(value.host[key], `sample ${expected.sequence}.host.${key}`);
  if (value.host.load15Milli >= 6000 || value.host.memAvailableKiB < 12 * 1024 * 1024) {
    fail(`sample ${expected.sequence} reports unsafe load or memory headroom`);
  }

  const counters = {
    serviceRestart: value.service.restartCount,
    pm2: value.application.pm2.map((row) => `${row.name}:${row.restartCount}:${row.releaseSha}`),
    swapIn: value.host.swapInPages,
    swapOut: value.host.swapOutPages,
    memoryPressure: value.host.memoryPressureTotalMicros,
    oom: value.host.kernelOomEventsSinceBoot,
  };
  if (baseline && JSON.stringify(counters) !== JSON.stringify(baseline)) {
    fail(`sample ${expected.sequence} reports restart, swap, pressure, OOM, or release-identity drift`);
  }
  return { value, counters };
}

function validateRequestEvidence(file, expected) {
  const value = file.value;
  exactKeys(value, [
    'schema', 'runId', 'phase', 'host', 'bootId', 'startedAt', 'completedAt',
    'collectorSourceSha256', 'lastSampleSha256', 'database', 'rows', 'totals',
  ], 'collector request evidence');
  if (value.schema !== OLLAMA_COLLECTOR_REQUEST_SCHEMA || value.runId !== expected.runId
      || value.phase !== expected.phase || value.host !== expected.host || value.bootId !== expected.bootId
      || value.startedAt !== expected.startedAt || value.completedAt !== expected.completedAt
      || value.collectorSourceSha256 !== expected.collectorSourceSha256
      || value.lastSampleSha256 !== expected.lastSampleSha256) fail('request evidence provenance or exact window mismatch');
  exactKeys(value.database, ['path', 'columns', 'quickCheck', 'invalidPersistenceRows'], 'request evidence database');
  if (!isAbsolute(value.database.path || '') || value.database.quickCheck !== 'ok'
      || value.database.invalidPersistenceRows !== 0
      || JSON.stringify(value.database.columns) !== JSON.stringify(REQUIRED_API_USAGE_COLUMNS)) {
    fail('request evidence does not prove the governed fail-closed api_usage persistence contract');
  }
  if (!testMode() && value.database.path !== (expected.phase === 'staging'
    ? '/home/dominguez/telegram-hub-bot-staging/data/bot.db'
    : '/home/dominguez/telegram-hub-bot/data/bot.db')) fail('request evidence database path is not canonical for its phase');
  if (!Array.isArray(value.rows)) fail('request evidence rows must be an array');
  let previousModel = null;
  let total = 0; let retained = 0; let large = 0; let other = 0;
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, ['provider', 'model', 'requests', 'localRequestUnits'], `request evidence rows[${index}]`);
    if (row.provider !== 'ollama' || typeof row.model !== 'string' || row.model.length < 1
        || (previousModel !== null && previousModel.localeCompare(row.model) >= 0)) fail('request evidence rows are ambiguous or unsorted');
    safeInteger(row.requests, 'request row count');
    safeInteger(row.localRequestUnits, 'request local units');
    if (row.localRequestUnits !== row.requests) fail('request row was not durably metered one-for-one');
    previousModel = row.model; total += row.requests;
    if (row.model === OLLAMA_RETAINED_TAG) retained += row.requests;
    else if (OLLAMA_DELETE_TAGS.includes(row.model)) large += row.requests;
    else other += row.requests;
  }
  exactKeys(value.totals, ['total', 'retainedModel', 'largeModels', 'otherModels'], 'request evidence totals');
  if (value.totals.total !== total || value.totals.retainedModel !== retained
      || value.totals.largeModels !== large || value.totals.otherModels !== other) fail('request evidence totals do not reconcile with SQLite rows');
  if (large !== 0 || other !== 0 || total !== retained) fail('collector does not prove zero large-model and unapproved-model requests');
  return value.totals;
}

export function validateOllamaObservationEvidence(file, {
  expectedHost = 'serverdominguez',
  expectedPhase = null,
  expectedSubjectDigest = null,
  expectedSubjectPath = null,
  maxEvidenceAgeHours = null,
  now = Date.now(),
  minimumDurationSeconds = MIN_OBSERVATION_SECONDS,
  allowCandidateResult = false,
} = {}) {
  if (!file?.path || !file?.value || !file?.digest) fail('collector evidence must be read through the secure evidence reader');
  const value = file.value;
  exactKeys(value, [
    'schema', 'status', 'host', 'phase', 'runId', 'collector', 'bootId', 'startedAt',
    'completedAt', 'startedMonotonicSeconds', 'completedMonotonicSeconds', 'sampling',
    'retainedModel', 'inventory', 'samples', 'requestEvidence', 'previousObservation', 'subject',
  ], 'collector result');
  if (value.schema !== OLLAMA_COLLECTOR_RESULT_SCHEMA || value.status !== 'complete') fail('collector result is not complete');
  if (value.host !== expectedHost || !['staging', 'production', 'zero_swap'].includes(value.phase)
      || (expectedPhase && value.phase !== expectedPhase) || !RUN_ID.test(value.runId || '')) fail('collector result host, phase, or run identity is invalid');
  if (!BOOT_ID.test(value.bootId || '')) fail('collector result boot identity is invalid');
  const runDirectory = dirname(file.path);
  const expectedBasename = allowCandidateResult ? 'result.candidate.json' : 'result.json';
  if (basename(file.path) !== expectedBasename) fail(`collector result must use its protected ${expectedBasename} path`);
  validateCollectorIdentity(value.collector, runDirectory);

  const startedMs = timestamp(value.startedAt, 'collector startedAt');
  const completedMs = timestamp(value.completedAt, 'collector completedAt');
  const startedMono = safeInteger(value.startedMonotonicSeconds, 'collector started monotonic time');
  const completedMono = safeInteger(value.completedMonotonicSeconds, 'collector completed monotonic time');
  const duration = completedMono - startedMono;
  if (duration < minimumDurationSeconds || completedMs < startedMs) fail('collector observation must cover at least 24 hours on one boot');
  if (completedMs > now + CLOCK_SKEW_MS) fail('collector completion is in the future');
  if (maxEvidenceAgeHours !== null) {
    const maxAge = maxEvidenceAgeHours * 60 * 60 * 1000;
    if (!Number.isInteger(maxEvidenceAgeHours) || maxEvidenceAgeHours < 1 || maxEvidenceAgeHours > 72
        || now - completedMs > maxAge) fail('collector evidence is stale');
  }

  exactKeys(value.sampling, ['intervalSeconds', 'sampleCount', 'maximumGapSeconds'], 'collector sampling');
  const interval = safeInteger(value.sampling.intervalSeconds, 'collector interval');
  const sampleCount = safeInteger(value.sampling.sampleCount, 'collector sample count');
  const maximumGap = safeInteger(value.sampling.maximumGapSeconds, 'collector maximum gap');
  if ((!testMode() && interval !== PRODUCTION_INTERVAL_SECONDS) || interval < 1
      || sampleCount < Math.floor(duration / interval) + 1 || sampleCount > MAX_SAMPLES
      || maximumGap > Math.max(MAX_SAMPLE_GAP_SECONDS, interval + 15)) fail('collector sample cadence does not cover the exact bounded window');

  const retained = model(value.retainedModel, 'collector retained model');
  if (retained.tag !== OLLAMA_RETAINED_TAG) fail('collector retained tag is not approved');
  const inventory = models(value.inventory, 'collector inventory');
  assertInventory(value.phase, inventory, retained);

  exactKeys(value.samples, ['directory', 'firstSha256', 'lastSha256'], 'collector samples');
  if (!OLLAMA_DIGEST_PATTERN.test(value.samples.firstSha256 || '')
      || !OLLAMA_DIGEST_PATTERN.test(value.samples.lastSha256 || '')) fail('collector sample endpoint digest is invalid');
  const sampleDirectory = secureDirectory(value.samples.directory, 'collector samples directory');
  if (dirname(sampleDirectory) !== runDirectory || basename(sampleDirectory) !== 'samples') fail('collector samples escaped their protected run directory');
  const names = readdirSync(sampleDirectory).sort();
  const expectedNames = Array.from({ length: sampleCount }, (_, index) => `${String(index).padStart(6, '0')}.json`);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail('collector sample set is incomplete or contains unexpected files');

  const pm2Names = value.phase === 'staging'
    ? ['content-engine-staging', 'nexus-hub-staging']
    : ['content-engine', 'nexus-hub'];
  let previous = null; let baseline = null; let first = null; let last = null; let maximumObservedGap = 0;
  for (let sequence = 0; sequence < sampleCount; sequence += 1) {
    const sample = readSecureJsonEvidence(join(sampleDirectory, expectedNames[sequence]), `collector sample ${sequence}`);
    const validated = validateSample(sample, {
      sequence, runId: value.runId, phase: value.phase, bootId: value.bootId, inventory, pm2Names,
    }, previous, baseline);
    if (!baseline) baseline = validated.counters;
    if (!first) first = validated.value;
    if (last) {
      const gap = validated.value.monotonicSeconds - last.monotonicSeconds;
      if (gap < 1 || gap > Math.max(MAX_SAMPLE_GAP_SECONDS, interval + 15)) fail('collector raw samples contain an unsafe same-boot gap');
      maximumObservedGap = Math.max(maximumObservedGap, gap);
    }
    last = validated.value;
    previous = sample.digest;
    if (sequence === 0 && sample.digest !== value.samples.firstSha256) fail('collector first-sample digest mismatch');
  }
  if (!first || !last || previous !== value.samples.lastSha256 || maximumObservedGap !== maximumGap
      || first.capturedAt !== value.startedAt || first.monotonicSeconds !== startedMono
      || last.capturedAt !== value.completedAt || last.monotonicSeconds !== completedMono) {
    fail('collector result does not bind the exact raw sample window');
  }

  exactKeys(value.requestEvidence, ['path', 'sha256'], 'collector request evidence reference');
  const requests = reference(value.requestEvidence, 'collector request evidence');
  if (dirname(requests.path) !== runDirectory || basename(requests.path) !== 'requests.json') {
    fail('collector request evidence escaped its protected run directory');
  }
  const totals = validateRequestEvidence(requests, {
    runId: value.runId, phase: value.phase, host: value.host, bootId: value.bootId,
    startedAt: value.startedAt, completedAt: value.completedAt,
    collectorSourceSha256: value.collector.sourceSha256, lastSampleSha256: value.samples.lastSha256,
  });

  let previousObservation = null;
  if (value.phase === 'production') {
    const previousFile = reference(value.previousObservation, 'staging collector result');
    previousObservation = validateOllamaObservationEvidence(previousFile, {
      expectedHost, expectedPhase: 'staging', now, minimumDurationSeconds,
    });
    if (startedMs < previousObservation.completedMs) fail('production collector window must start after staging completes');
    if (previousObservation.retained.digest !== retained.digest
        || JSON.stringify(previousObservation.inventory) !== JSON.stringify(inventory)) {
      fail('staging and production collector model identities differ');
    }
  } else if (value.previousObservation !== null) fail(`${value.phase} collector result must not declare a previous observation`);

  let subject = null;
  if (value.phase === 'zero_swap') {
    const subjectFile = reference(value.subject, 'zero-swap cleanup subject');
    if ((expectedSubjectDigest && subjectFile.digest !== expectedSubjectDigest)
        || (expectedSubjectPath && subjectFile.path !== expectedSubjectPath)) fail('zero-swap collector subject does not match the exact cleanup result');
    subject = { path: subjectFile.path, sha256: subjectFile.digest };
  } else if (value.subject !== null) fail(`${value.phase} collector result must not declare a subject`);

  return {
    path: file.path,
    digest: file.digest,
    phase: value.phase,
    retained,
    inventory,
    requests: totals,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    startedMs,
    completedMs,
    previousObservation,
    subject,
  };
}

export function validateOllamaSoakEvidence(file, {
  expectedHost = 'serverdominguez',
  maxEvidenceAgeHours = null,
  now = Date.now(),
} = {}) {
  const production = validateOllamaObservationEvidence(file, {
    expectedHost,
    expectedPhase: 'production',
    maxEvidenceAgeHours,
    now,
  });
  const staging = production.previousObservation;
  if (!staging) fail('production collector evidence is not chained to staging');
  const deleteModels = OLLAMA_DELETE_TAGS.map((tag) => production.inventory.find((entry) => entry.tag === tag));
  if (deleteModels.some((entry) => !entry)) fail('collector evidence is missing an exact deletion-model digest');
  return {
    retained: production.retained,
    deleteModels,
    generatedAt: production.completedAt,
    generatedAtMs: production.completedMs,
    soaks: { staging, production },
  };
}
