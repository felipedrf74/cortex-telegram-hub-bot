#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  OLLAMA_DELETE_TAGS,
  OLLAMA_DIGEST_PATTERN,
  OLLAMA_RETAINED_TAG,
  readSecureJsonEvidence,
  validateOllamaSoakEvidence,
} from './ollama-soak-evidence.mjs';

const PREFLIGHT_SCHEMA = 'nexus.sonarqube-host-preflight.v1';
const CLEANUP_RESULT_SCHEMA = 'nexus.ollama-large-model-cleanup-result.v1';
const CLEANUP_PLAN_SCHEMA = 'nexus.ollama-large-model-cleanup-plan.v1';
const EXPECTED_HOST = 'serverdominguez';
const RETAINED_TAG = OLLAMA_RETAINED_TAG;
const DELETE_TAGS = OLLAMA_DELETE_TAGS;
const PREFLIGHT_TTL_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const DIGEST = OLLAMA_DIGEST_PATTERN;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUIRED_SNAPSHOTS = new Set([
  'capacity.env',
  'cloudflare.txt',
  'docker.txt',
  'failures.txt',
  'firewall-iptables.txt',
  'firewall-nft.txt',
  'firewall-ufw.txt',
  'health.tsv',
  'listeners.txt',
  'pm2-after.json',
  'pm2-before.json',
  'routes.txt',
  'sysctl.txt',
  'tailscale.txt',
]);

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function usage() {
  process.stdout.write(`Usage:
  quality-sonar-start-evidence.mjs record-preflight \\
    --directory <private-preflight-directory> --host serverdominguez --boot-id <uuid>
  quality-sonar-start-evidence.mjs verify-start \\
    --preflight-directory <private-preflight-directory> \\
    --ollama-soak-evidence <mode-0600-json> \\
    --ollama-cleanup-result <mode-0600-json> --current-boot-id <uuid>
`);
}

function parseArgs(argv) {
  const mode = argv.shift();
  if (mode === '--help' || mode === '-h') {
    usage();
    process.exit(0);
  }
  if (!['record-preflight', 'verify-start'].includes(mode)) fail('a valid command is required', 64);
  const values = { mode };
  while (argv.length > 0) {
    const key = argv.shift();
    if (!key?.startsWith('--')) fail(`invalid argument: ${key || ''}`, 64);
    const value = argv.shift();
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`, 64);
    const field = {
      '--directory': 'directory',
      '--host': 'host',
      '--boot-id': 'bootId',
      '--preflight-directory': 'preflightDirectory',
      '--ollama-soak-evidence': 'ollamaSoakEvidence',
      '--ollama-cleanup-result': 'ollamaCleanupResult',
      '--current-boot-id': 'currentBootId',
    }[key];
    if (!field || values[field] !== undefined) fail(`unknown or repeated argument: ${key}`, 64);
    values[field] = value;
  }
  const required = mode === 'record-preflight'
    ? ['directory', 'host', 'bootId']
    : ['preflightDirectory', 'ollamaSoakEvidence', 'ollamaCleanupResult', 'currentBootId'];
  for (const field of required) if (typeof values[field] !== 'string') fail(`missing required ${field}`, 64);
  return values;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function secureDirectory(path, label) {
  if (!isAbsolute(path) || path === '/') fail(`${label} must be a safe absolute path`, 64);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a non-symlink directory`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the account running the verifier`);
  }
  if ((info.mode & 0o777) !== 0o700) fail(`${label} must have mode 0700`);
  return resolve(path);
}

function secureFile(path, label) {
  if (!isAbsolute(path)) fail(`${label} must be an absolute path`, 64);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a non-symlink regular file`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the account running the verifier`);
  }
  if ((info.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`);
  if (info.size > 4 * 1024 * 1024) fail(`${label} is unexpectedly large`);
  return readFileSync(path);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(path, label) {
  const raw = secureFile(resolve(path), label);
  try {
    return { raw, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function parseInteger(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value || '')) fail(`${label} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is outside the safe integer range`);
  return parsed;
}

function parseCapacity(raw) {
  const values = {};
  for (const line of raw.trim().split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=([0-9]+)$/.exec(line);
    if (!match || values[match[1]] !== undefined) fail('capacity.env is malformed');
    values[match[1]] = match[2];
  }
  const expected = [
    'DISK_FREE_PERCENT', 'FS_FILE_MAX', 'LOAD_15_MILLI', 'MEM_AVAILABLE_KIB', 'MIN_AVAILABLE_GIB',
    'MIN_DISK_FREE_PERCENT', 'OOM_EVENTS_LAST_24H', 'SAMPLE_SECONDS',
    'SWAP_IN_DELTA_PAGES', 'SWAP_OUT_DELTA_PAGES', 'VM_MAX_MAP_COUNT',
  ];
  exactKeys(values, expected, 'capacity.env');
  return Object.fromEntries(expected.map((key) => [key, parseInteger(values[key], key)]));
}

function verifySnapshots(directory, expectedListDigest = null) {
  const root = secureDirectory(directory, 'preflight directory');
  const listPath = resolve(root, 'checksums.sha256');
  const listRaw = secureFile(listPath, 'preflight checksum list');
  const listDigest = sha256(listRaw);
  if (expectedListDigest && listDigest !== expectedListDigest) fail('preflight checksum-list digest mismatch');
  const seen = new Set();
  for (const line of listRaw.toString('utf8').trim().split('\n')) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) fail('preflight checksum list is malformed');
    if (!isAbsolute(match[2])) fail('preflight checksum paths must be absolute');
    const candidate = resolve(match[2]);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      fail('preflight checksum entry escapes its private directory');
    }
    const name = basename(candidate);
    if (seen.has(name)) fail('preflight checksum list contains a duplicate basename');
    const raw = secureFile(candidate, `preflight snapshot ${name}`);
    if (sha256(raw) !== match[1]) fail(`preflight snapshot digest mismatch: ${name}`);
    seen.add(name);
  }
  for (const required of REQUIRED_SNAPSHOTS) {
    if (!seen.has(required)) fail(`required preflight snapshot is missing: ${required}`);
  }
  if (secureFile(resolve(root, 'failures.txt'), 'preflight failures').length !== 0) {
    fail('preflight contains recorded failures');
  }
  return {
    root,
    listDigest,
    capacity: parseCapacity(secureFile(resolve(root, 'capacity.env'), 'preflight capacity').toString('utf8')),
    dockerEngineCaptured: /^client=[0-9][0-9A-Za-z.+-]* server=[0-9][0-9A-Za-z.+-]*\n?$/.test(
      secureFile(resolve(root, 'docker.txt'), 'Docker version snapshot').toString('utf8'),
    ),
  };
}

function assertCapacity(capacity) {
  if (capacity.MIN_AVAILABLE_GIB < 16) fail('preflight memory floor is below 16 GiB');
  if (capacity.MEM_AVAILABLE_KIB < 16 * 1024 * 1024) fail('preflight observed less than 16 GiB available memory');
  if (capacity.SWAP_IN_DELTA_PAGES !== 0 || capacity.SWAP_OUT_DELTA_PAGES !== 0) {
    fail('preflight observed active swap pressure');
  }
  if (capacity.OOM_EVENTS_LAST_24H !== 0) fail('preflight observed a recent kernel OOM event');
  if (capacity.LOAD_15_MILLI >= 6000) fail('preflight observed 15-minute load at or above 6');
}

function assertSafeJsonInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function parseTime(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be an ISO timestamp`);
  return parsed;
}

function validateModel(value, label) {
  exactKeys(value, ['tag', 'digest'], label);
  if (typeof value.tag !== 'string' || !DIGEST.test(value.digest || '')) fail(`${label} identity is invalid`);
  return value;
}

function validateOllamaResult(result, evidenceRaw, evidence, now) {
  exactKeys(result, ['schema', 'host', 'status', 'startedAt', 'completedAt', 'plan', 'finalInventory', 'retainedDigestVerifiedBeforeAndAfter'], 'Ollama cleanup result');
  if (result.schema !== CLEANUP_RESULT_SCHEMA || result.host !== EXPECTED_HOST || result.status !== 'complete') fail('Ollama cleanup did not complete successfully');
  if (result.retainedDigestVerifiedBeforeAndAfter !== true) fail('retained Ollama digest was not verified before and after cleanup');
  const started = parseTime(result.startedAt, 'Ollama cleanup startedAt');
  const completed = parseTime(result.completedAt, 'Ollama cleanup completedAt');
  if (completed < started || started < evidence.generatedAtMs || completed > now + CLOCK_SKEW_MS) fail('Ollama cleanup timestamps are invalid');
  exactKeys(result.plan, [
    'schema',
    'host',
    'evidenceDigest',
    'inventoryFingerprint',
    'observationControl',
    'retained',
    'delete',
    'ackPlan',
  ], 'Ollama cleanup plan');
  if (result.plan.schema !== CLEANUP_PLAN_SCHEMA || result.plan.host !== EXPECTED_HOST) fail('Ollama cleanup plan identity is invalid');
  if (result.plan.evidenceDigest !== `sha256:${sha256(evidenceRaw)}`) fail('Ollama cleanup result is not bound to the supplied soak evidence');
  exactKeys(result.plan.observationControl, ['staging', 'production'], 'Ollama cleanup observation control');
  for (const phase of ['staging', 'production']) {
    exactKeys(
      result.plan.observationControl[phase],
      ['requestId', 'requestSha256', 'runtimeSha'],
      `Ollama cleanup observation control.${phase}`,
    );
  }
  if (JSON.stringify(result.plan.observationControl)
      !== JSON.stringify(evidence.observationControl)) {
    fail('Ollama cleanup result control requests do not match the exact soak evidence');
  }
  for (const field of ['inventoryFingerprint', 'ackPlan']) if (!DIGEST.test(result.plan[field] || '')) fail(`Ollama cleanup plan ${field} is invalid`);
  const retained = validateModel(result.plan.retained, 'Ollama cleanup retained model');
  if (retained.tag !== RETAINED_TAG || retained.digest !== evidence.retained.digest) fail('Ollama cleanup retained model does not match soak evidence');
  if (!Array.isArray(result.plan.delete) || result.plan.delete.length !== DELETE_TAGS.length) fail('Ollama cleanup plan deletion inventory is invalid');
  const resultDeleteTags = new Set(result.plan.delete.map((model) => model?.tag));
  if (resultDeleteTags.size !== DELETE_TAGS.length || DELETE_TAGS.some((tag) => !resultDeleteTags.has(tag))) {
    fail('Ollama cleanup plan deletion inventory is not exact');
  }
  for (const model of result.plan.delete) {
    const expected = evidence.deleteModels.find((entry) => entry.tag === model.tag);
    validateModel(model, 'Ollama cleanup deletion model');
    if (!expected || expected.digest !== model.digest) fail('Ollama cleanup plan deletion digest does not match soak evidence');
  }
  if (!Array.isArray(result.finalInventory) || result.finalInventory.length !== 1) fail('Ollama final inventory is not small-model-only');
  const finalModel = validateModel(result.finalInventory[0], 'Ollama final inventory model');
  if (finalModel.tag !== RETAINED_TAG || finalModel.digest !== retained.digest) fail('Ollama final inventory does not preserve the verified 3B model');
  return { retained, completedAt: result.completedAt };
}

function recordPreflight(options) {
  if (options.host !== EXPECTED_HOST || !BOOT_ID.test(options.bootId || '')) fail('record-preflight host or boot ID is invalid', 64);
  const snapshots = verifySnapshots(options.directory);
  assertCapacity(snapshots.capacity);
  const now = Date.now();
  const result = {
    schema: PREFLIGHT_SCHEMA,
    status: 'passed',
    host: EXPECTED_HOST,
    bootId: options.bootId,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREFLIGHT_TTL_MS).toISOString(),
    snapshotsSha256: snapshots.listDigest,
    minimumAvailableGiB: snapshots.capacity.MIN_AVAILABLE_GIB,
    observed: {
      memAvailableKiB: snapshots.capacity.MEM_AVAILABLE_KIB,
      swapInDeltaPages: snapshots.capacity.SWAP_IN_DELTA_PAGES,
      swapOutDeltaPages: snapshots.capacity.SWAP_OUT_DELTA_PAGES,
      oomEventsLast24h: snapshots.capacity.OOM_EVENTS_LAST_24H,
      load15Milli: snapshots.capacity.LOAD_15_MILLI,
      diskFreePercent: snapshots.capacity.DISK_FREE_PERCENT,
    },
    networkFirewallSnapshotsComplete: true,
    pm2AndApplicationHealthStable: true,
    dockerEngineCaptured: snapshots.dockerEngineCaptured,
  };
  const output = resolve(snapshots.root, 'result.json');
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(output, 0o600);
  process.stdout.write(`sonar_preflight_evidence_recorded result=${output} expiresAt=${result.expiresAt}\n`);
}

function verifyStart(options) {
  if (!BOOT_ID.test(options.currentBootId || '')) fail('--current-boot-id is invalid', 64);
  const preflightPath = resolve(options.preflightDirectory || '', 'result.json');
  const preflight = readJson(preflightPath, 'preflight result').value;
  exactKeys(preflight, [
    'schema', 'status', 'host', 'bootId', 'generatedAt', 'expiresAt', 'snapshotsSha256',
    'minimumAvailableGiB', 'observed', 'networkFirewallSnapshotsComplete', 'pm2AndApplicationHealthStable', 'dockerEngineCaptured',
  ], 'preflight result');
  if (preflight.schema !== PREFLIGHT_SCHEMA || preflight.status !== 'passed' || preflight.host !== EXPECTED_HOST) fail('preflight did not pass for ServerDominguez');
  if (preflight.bootId !== options.currentBootId) fail('preflight was captured during a different host boot');
  const generatedAt = parseTime(preflight.generatedAt, 'preflight generatedAt');
  const expiresAt = parseTime(preflight.expiresAt, 'preflight expiresAt');
  const now = Date.now();
  if (generatedAt > now + CLOCK_SKEW_MS || expiresAt - generatedAt !== PREFLIGHT_TTL_MS || now > expiresAt || now - generatedAt > PREFLIGHT_TTL_MS) {
    fail('preflight evidence is stale or has an invalid freshness window');
  }
  if (!HEX_DIGEST.test(preflight.snapshotsSha256 || '')) fail('preflight snapshot digest is invalid');
  exactKeys(preflight.observed, ['memAvailableKiB', 'swapInDeltaPages', 'swapOutDeltaPages', 'oomEventsLast24h', 'load15Milli', 'diskFreePercent'], 'preflight observations');
  const snapshots = verifySnapshots(options.preflightDirectory, preflight.snapshotsSha256);
  assertCapacity(snapshots.capacity);
  const observed = preflight.observed;
  for (const field of ['memAvailableKiB', 'swapInDeltaPages', 'swapOutDeltaPages', 'oomEventsLast24h', 'load15Milli', 'diskFreePercent']) {
    assertSafeJsonInteger(observed[field], `preflight observed.${field}`);
  }
  assertSafeJsonInteger(preflight.minimumAvailableGiB, 'preflight minimumAvailableGiB');
  if (preflight.minimumAvailableGiB !== snapshots.capacity.MIN_AVAILABLE_GIB
      || observed.memAvailableKiB !== snapshots.capacity.MEM_AVAILABLE_KIB
      || observed.swapInDeltaPages !== snapshots.capacity.SWAP_IN_DELTA_PAGES
      || observed.swapOutDeltaPages !== snapshots.capacity.SWAP_OUT_DELTA_PAGES
      || observed.oomEventsLast24h !== snapshots.capacity.OOM_EVENTS_LAST_24H
      || observed.load15Milli !== snapshots.capacity.LOAD_15_MILLI
      || observed.diskFreePercent !== snapshots.capacity.DISK_FREE_PERCENT) {
    fail('preflight result observations do not match the checksummed capacity snapshot');
  }
  if (preflight.minimumAvailableGiB < 16
      || observed.memAvailableKiB < 16 * 1024 * 1024
      || observed.swapInDeltaPages !== 0
      || observed.swapOutDeltaPages !== 0
      || observed.oomEventsLast24h !== 0
      || observed.load15Milli >= 6000
      || preflight.networkFirewallSnapshotsComplete !== true
      || preflight.pm2AndApplicationHealthStable !== true
      || preflight.dockerEngineCaptured !== true) {
    fail('preflight result does not prove post-Docker memory, stability, and no-pressure conditions');
  }
  const soak = readSecureJsonEvidence(options.ollamaSoakEvidence || '', 'Ollama soak evidence');
  const cleanup = readJson(options.ollamaCleanupResult || '', 'Ollama cleanup result');
  const evidence = validateOllamaSoakEvidence(soak, {
    expectedHost: EXPECTED_HOST,
    now,
  });
  const result = validateOllamaResult(cleanup.value, soak.raw, evidence, now);
  if (parseTime(result.completedAt, 'Ollama cleanup completedAt') > generatedAt) {
    fail('fresh host-capacity preflight must be captured after small-model cleanup completes');
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.sonarqube-start-authorization.v1',
    status: 'passed',
    host: EXPECTED_HOST,
    preflightGeneratedAt: preflight.generatedAt,
    preflightExpiresAt: preflight.expiresAt,
    ollamaCleanupCompletedAt: result.completedAt,
    ollamaSoakEvidenceDigest: soak.digest,
    observationControl: evidence.observationControl,
    retainedModel: result.retained,
  })}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'record-preflight') recordPreflight(options);
  else verifyStart(options);
} catch (error) {
  process.stderr.write(`sonar_start_evidence_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
