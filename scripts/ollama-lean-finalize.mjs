#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
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
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OLLAMA_ENVELOPE,
  parseAndValidateOllamaEnvelope,
} from './lib/ollama-service-envelope.mjs';

export const OLLAMA_RETAINED_MODEL = Object.freeze({
  tag: 'qwen2.5:3b-instruct-q4_K_M',
  digest: '357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
});

export const OLLAMA_DELETE_MODELS = Object.freeze([
  Object.freeze({
    tag: 'gemma2:2b-instruct-q4_K_M',
    digest: 'cb2d06dce81356b9799c814de8dab1f2dd265084d16ea22f88e1bff70206fabd',
  }),
  Object.freeze({
    tag: 'qwen3.6:27b-q4_K_M',
    digest: 'a50eda8ed977ab48a12431878896b27ffd5cef552c17af3317d9623b939a7f1e',
  }),
  Object.freeze({
    tag: 'qwen3.6:35b-a3b-q4_K_M',
    digest: '07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522',
  }),
]);

export const OLLAMA_DROP_IN = `[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_MODELS=/var/lib/ollama/models"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_QUEUE=4"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KEEP_ALIVE=-1"
Environment="OLLAMA_LOAD_TIMEOUT=5m"
Environment="OLLAMA_NO_CLOUD=1"
Environment="OLLAMA_DEBUG_LOG_REQUESTS=0"
MemoryHigh=18G
MemoryMax=20G
MemorySwapMax=0
Nice=10
CPUWeight=25
CPUQuota=800%
Restart=on-failure
RestartSec=10
`;

const INSTALLED_EXECUTABLE = '/usr/local/sbin/nexus-ollama-lean-finalize.mjs';
const DEPLOY_HOME = process.env.NEXUS_RELEASE_DEPLOY_HOME ?? homedir();
const USER_RELEASE_LOCK = join(DEPLOY_HOME, '.local/state/nexus-release/.release.lock');
const ROOT_SONAR_LOCK = '/run/lock/nexus-release-sonar.lock';
const STATE_ROOT = join(DEPLOY_HOME, '.local/state/nexus-release');
const RECEIPT_ROOT = '/var/lib/nexus-release/ollama-finalize';
const DROP_IN_PATH = '/etc/systemd/system/ollama.service.d/override.conf';
const LEGACY_ZERO_SWAP_PATH = '/etc/systemd/system/ollama.service.d/zz-nexus-zero-swap.conf';
const LEGACY_ZERO_SWAP_BYTES = Buffer.from('[Service]\nMemorySwapMax=0\n');
const OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
const MAX_BYTES = 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ACK_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RELEASES = Object.freeze({
  staging: Object.freeze({
    base: join(DEPLOY_HOME, 'telegram-hub-bot-staging'),
    state: `${STATE_ROOT}/staging.json`,
    names: Object.freeze(['nexus-hub-staging', 'content-engine-staging']),
    minimumSoakSeconds: 1,
  }),
  production: Object.freeze({
    base: join(DEPLOY_HOME, 'telegram-hub-bot'),
    state: `${STATE_ROOT}/production.json`,
    names: Object.freeze(['nexus-hub', 'content-engine']),
    minimumSoakSeconds: 60,
  }),
});

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function timestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !value.endsWith('Z')) fail(`${label} is not an ISO-8601 UTC timestamp`);
  return parsed;
}

function normalizeDigest(value, label) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^sha256:/u, '');
  if (!DIGEST_PATTERN.test(normalized)) fail(`${label} is not a full lowercase SHA-256 digest`);
  return normalized;
}

function modelTag(row, label) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`${label} is malformed`);
  const names = [row.name, row.model].filter((value) => typeof value === 'string' && value.length > 0);
  if (names.length === 0 || new Set(names).size !== 1) fail(`${label} has an ambiguous tag`);
  return names[0];
}

function requiredCheck(checks, name, role) {
  if (checks?.[name] !== 'passed') fail(`${role} release state did not pass ${name}`);
}

export function validateReleasePair(releases) {
  const normalized = {};
  for (const [role, policy] of Object.entries(RELEASES)) {
    const record = releases?.[role];
    const state = record?.state;
    if (!record || !state || typeof state !== 'object' || Array.isArray(state)) {
      fail(`${role} release state is missing`);
    }
    if (record.statePath !== policy.state || !DIGEST_PATTERN.test(record.stateSha256 || '')) {
      fail(`${role} release-state file identity is invalid`);
    }
    if (state.schema !== 'nexus.lean-release-transaction.v1'
        || state.role !== role
        || state.phase !== 'completed'
        || state.status !== 'passed'
        || state.healthResult !== 'passed'
        || state.rollbackResult !== 'not_required') {
      fail(`${role} is not an exact passing lean release transaction`);
    }
    if (!SHA_PATTERN.test(state.runtimeSha || '') || !DIGEST_PATTERN.test(state.artifactDigest || '')) {
      fail(`${role} release SHA or artifact digest is invalid`);
    }
    const expectedRelease = `${policy.base}/releases/${state.runtimeSha}-${state.artifactDigest.slice(0, 12)}`;
    if (state.releaseDir !== expectedRelease || record.currentTarget !== expectedRelease) {
      fail(`${role} current symlink is not the completed release directory`);
    }
    if (typeof state.predecessor !== 'string'
        || !state.predecessor.startsWith(`${policy.base}/releases/`)
        || state.predecessor === state.releaseDir) {
      fail(`${role} predecessor is not rollback-ready`);
    }
    if (!Number.isInteger(state.stabilitySeconds)
        || state.stabilitySeconds < policy.minimumSoakSeconds
        || timestamp(state.soakCompletedAt, `${role} soakCompletedAt`)
          < timestamp(state.soakStartedAt, `${role} soakStartedAt`)
        || timestamp(state.completedAt, `${role} completedAt`)
          < timestamp(state.soakCompletedAt, `${role} soakCompletedAt`)) {
      fail(`${role} release soak evidence is invalid`);
    }
    for (const check of [
      'artifactParity',
      'migrationStartup',
      'authenticatedSmoke',
      'databaseIntegrity',
      'rollbackReadiness',
    ]) {
      requiredCheck(state.checks, check, role);
    }
    if (role === 'production') requiredCheck(state.checks, 'prePromotionBackup', role);
    normalized[role] = {
      role,
      transactionId: state.transactionId,
      runtimeSha: state.runtimeSha,
      artifactDigest: state.artifactDigest,
      releaseDir: state.releaseDir,
      predecessor: state.predecessor,
      statePath: record.statePath,
      stateSha256: record.stateSha256,
      currentLink: `${policy.base}/current`,
      currentTarget: record.currentTarget,
      stabilitySeconds: state.stabilitySeconds,
      soakCompletedAt: state.soakCompletedAt,
    };
  }
  if (normalized.staging.runtimeSha !== normalized.production.runtimeSha
      || normalized.staging.artifactDigest !== normalized.production.artifactDigest) {
    fail('staging and production do not bind the same exact release');
  }
  return normalized;
}

export function validatePm2Snapshot(rows, releases) {
  if (!Array.isArray(rows)) fail('PM2 snapshot is malformed');
  const normalized = [];
  for (const [role, policy] of Object.entries(RELEASES)) {
    const release = releases[role];
    for (const [index, name] of policy.names.entries()) {
      const matches = rows.filter((row) => row?.name === name);
      if (matches.length !== 1) fail(`PM2 must contain exactly one ${name}`);
      const environment = matches[0]?.pm2_env;
      const expectedCwd = index === 0 ? release.releaseDir : `${release.releaseDir}/content-engine`;
      const declaredShas = [
        environment?.NEXUS_RELEASE_SHA,
        environment?.GIT_COMMIT,
      ].filter((value) => value !== undefined);
      if (environment?.status !== 'online'
          || environment?.pm_cwd !== expectedCwd
          || declaredShas.length === 0
          || declaredShas.some((value) => value !== release.runtimeSha)) {
        fail(`PM2 ${name} is not the exact online release`);
      }
      normalized.push({
        name,
        role,
        cwd: expectedCwd,
        runtimeSha: release.runtimeSha,
        status: 'online',
      });
    }
  }
  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

export function validateOllamaInventory(ollama, phase = 'before') {
  if (!Array.isArray(ollama?.inventory) || !Array.isArray(ollama?.loaded)) {
    fail('Ollama inventory or loaded-model response is malformed');
  }
  const inventory = ollama.inventory.map((row, index) => {
    const tag = modelTag(row, `Ollama inventory row ${index}`);
    return { tag, digest: normalizeDigest(row.digest, `Ollama digest for ${tag}`) };
  }).sort((left, right) => left.tag.localeCompare(right.tag));
  const loaded = ollama.loaded.map((row, index) => {
    const tag = modelTag(row, `Ollama loaded row ${index}`);
    const digest = row.digest ? normalizeDigest(row.digest, `loaded Ollama digest for ${tag}`) : null;
    return { tag, digest };
  }).sort((left, right) => left.tag.localeCompare(right.tag));
  if (new Set(inventory.map(({ tag }) => tag)).size !== inventory.length
      || new Set(loaded.map(({ tag }) => tag)).size !== loaded.length) {
    fail('Ollama returned duplicate model tags');
  }

  const expected = phase === 'after'
    ? [OLLAMA_RETAINED_MODEL]
    : [OLLAMA_RETAINED_MODEL, ...OLLAMA_DELETE_MODELS];
  const expectedByTag = new Map(expected.map((entry) => [entry.tag, entry.digest]));
  if (inventory.length !== expected.length
      || inventory.some(({ tag, digest }) => expectedByTag.get(tag) !== digest)) {
    fail(phase === 'after'
      ? 'Ollama final inventory is not the sole retained 3B digest'
      : 'Ollama inventory is not the exact audited four-tag digest allowlist');
  }
  const auditedByTag = new Map(
    [OLLAMA_RETAINED_MODEL, ...OLLAMA_DELETE_MODELS].map((entry) => [entry.tag, entry.digest]),
  );
  for (const entry of loaded) {
    if (!auditedByTag.has(entry.tag)
        || (entry.digest !== null && entry.digest !== auditedByTag.get(entry.tag))) {
      fail(`unexpected loaded Ollama model: ${entry.tag}`);
    }
    if (OLLAMA_DELETE_MODELS.some(({ tag }) => tag === entry.tag)) {
      fail(`Ollama deletion target is still loaded: ${entry.tag}`);
    }
  }
  return { inventory, loaded };
}

// SonarQube is decommissioned (ADR-0012): `scripts/quality-sonar-*` and
// `ops/sonarqube/` are gone, and the Compute Engine coexistence gate it enforced
// no longer exists. The `sonar` snapshot field is removed with it rather than
// frozen to a placeholder, so drift detection compares only state this host still
// has: releases, PM2, Ollama, and the two drop-ins.
//
// The shared root maintenance mutex at ROOT_SONAR_LOCK is deliberately retained.
// Its name is historical; what it serializes is root maintenance transactions
// against each other, which is unrelated to SonarQube.

function validateDropIn(record, { required, expectedSha256 = null, legacy = false } = {}) {
  if (!record || typeof record !== 'object') fail('Ollama drop-in evidence is missing');
  if (record.exists !== true) {
    if (required) fail(`${record.path || 'Ollama drop-in'} is required`);
    return { path: record.path, exists: false, sha256: null };
  }
  if (!Buffer.isBuffer(record.bytes)
      || !DIGEST_PATTERN.test(record.sha256 || '')
      || sha256(record.bytes) !== record.sha256
      || record.mode !== 0o644
      || record.uid !== 0
      || record.gid !== 0) {
    fail(`${record.path} is not a trusted root-owned drop-in`);
  }
  if (expectedSha256 && record.sha256 !== expectedSha256) fail(`${record.path} changed`);
  if (legacy && !record.bytes.equals(LEGACY_ZERO_SWAP_BYTES)) {
    fail('legacy zero-swap drop-in has unexpected contents and will not be removed');
  }
  return { path: record.path, exists: true, sha256: record.sha256 };
}

export function validateFinalizationSnapshot(snapshot, {
  inventoryPhase = 'before',
  expectedDropInSha256 = null,
  requireLegacyAbsent = false,
} = {}) {
  const releases = validateReleasePair(snapshot?.releases);
  const pm2 = validatePm2Snapshot(snapshot?.pm2, releases);
  const ollama = validateOllamaInventory(snapshot?.ollama, inventoryPhase);
  const dropIn = validateDropIn(snapshot?.dropIn, {
    required: true,
    expectedSha256: expectedDropInSha256,
  });
  const legacyZeroSwap = validateDropIn(snapshot?.legacyZeroSwap, {
    required: false,
    legacy: true,
  });
  if (requireLegacyAbsent && legacyZeroSwap.exists) fail('legacy zero-swap drop-in remains installed');
  return { releases, pm2, ollama, dropIn, legacyZeroSwap };
}

export function buildFinalizationPlan(validated, receiptPaths) {
  const core = {
    schema: 'nexus.ollama-lean-finalize-plan.v1',
    release: {
      runtimeSha: validated.releases.production.runtimeSha,
      artifactDigest: validated.releases.production.artifactDigest,
      staging: validated.releases.staging,
      production: validated.releases.production,
    },
    pm2: validated.pm2,
    ollama: {
      inventoryBefore: validated.ollama.inventory,
      deletionTargetsLoaded: validated.ollama.loaded
        .filter(({ tag }) => OLLAMA_DELETE_MODELS.some((entry) => entry.tag === tag)),
      retain: OLLAMA_RETAINED_MODEL,
      remove: OLLAMA_DELETE_MODELS,
    },
    systemd: {
      dropInPath: DROP_IN_PATH,
      predecessorSha256: validated.dropIn.sha256,
      legacyZeroSwap: validated.legacyZeroSwap,
      candidateSha256: sha256(Buffer.from(OLLAMA_DROP_IN)),
      envelope: {
        host: '127.0.0.1:11434',
        maxLoadedModels: 1,
        numParallel: 1,
        maxQueue: 4,
        contextLength: Number(OLLAMA_ENVELOPE.contextLength),
        memoryHighBytes: OLLAMA_ENVELOPE.memoryHighBytes,
        memoryMaxBytes: OLLAMA_ENVELOPE.memoryMaxBytes,
        memorySwapMaxBytes: OLLAMA_ENVELOPE.memorySwapBaselineBytes,
        cpuQuotaUsecPerSec: OLLAMA_ENVELOPE.cpuQuotaUsecPerSec,
        nice: OLLAMA_ENVELOPE.nice,
      },
    },
    receipt: receiptPaths,
  };
  return {
    ...core,
    ackPlan: `sha256:${sha256(JSON.stringify(core))}`,
  };
}

function receiptPaths(releases) {
  const sha = releases.production.runtimeSha;
  const suffix = releases.production.artifactDigest.slice(0, 12);
  const stem = `${sha}-${suffix}`;
  return {
    result: `${RECEIPT_ROOT}/${stem}.json`,
    predecessorDropIn: `${RECEIPT_ROOT}/${stem}.override.predecessor`,
    legacyZeroSwap: `${RECEIPT_ROOT}/${stem}.legacy-zero-swap.predecessor`,
  };
}

export async function executeOllamaFinalization(options, platform) {
  const firstSnapshot = await platform.snapshot();
  const firstValidated = validateFinalizationSnapshot(firstSnapshot);
  const paths = receiptPaths(firstValidated.releases);
  const plan = buildFinalizationPlan(firstValidated, paths);

  if (options.mode === 'dry-run') {
    return { mode: 'dry-run', mutationAttempted: false, ...plan };
  }
  if (options.ownerAuthorized !== true) fail('--owner-authorized is required for apply', 64);
  if (options.ackPlan !== plan.ackPlan) fail('acknowledgment does not match the fresh finalization plan');

  const immediateSnapshot = await platform.snapshot();
  const immediateValidated = validateFinalizationSnapshot(immediateSnapshot);
  const immediatePlan = buildFinalizationPlan(immediateValidated, paths);
  if (immediatePlan.ackPlan !== options.ackPlan) {
    fail('release, model, PM2, or drop-in state changed; run a new dry-run');
  }

  const startedAt = new Date().toISOString();
  const receipt = {
    schema: 'nexus.ollama-lean-finalize-receipt.v1',
    status: 'started',
    startedAt,
    completedAt: null,
    plan,
    before: {
      releases: immediateValidated.releases,
      pm2: immediateValidated.pm2,
      ollama: immediateValidated.ollama,
      dropIn: immediateValidated.dropIn,
      legacyZeroSwap: immediateValidated.legacyZeroSwap,
    },
    after: null,
    rollback: null,
    failure: null,
  };
  await platform.prepareReceipt(paths, immediateSnapshot, receipt);

  let envelope;
  let firstSmoke;
  try {
    await platform.installEnvelope(OLLAMA_DROP_IN);
    envelope = await platform.restartAndValidateEnvelope();
    firstSmoke = await platform.smokeRetainedModel();
  } catch (error) {
    let rollback;
    try {
      rollback = await platform.restorePredecessor(immediateSnapshot);
    } catch (rollbackError) {
      rollback = {
        status: 'failed',
        reason: String(rollbackError?.message || 'predecessor restoration failed').slice(0, 256),
      };
    }
    const failed = {
      ...receipt,
      status: 'failed',
      completedAt: new Date().toISOString(),
      rollback,
      failure: String(error?.message || 'Ollama envelope activation failed').slice(0, 256),
    };
    await platform.writeReceipt(paths.result, failed);
    if (rollback.status !== 'restored') {
      fail('Ollama finalization failed and predecessor restoration requires owner intervention');
    }
    fail('Ollama finalization failed; the exact predecessor drop-in was restored');
  }

  try {
    const preDeleteSnapshot = await platform.snapshot();
    const preDelete = validateFinalizationSnapshot(preDeleteSnapshot, {
      expectedDropInSha256: sha256(Buffer.from(OLLAMA_DROP_IN)),
      requireLegacyAbsent: true,
    });
    if (buildFinalizationPlan({
      ...preDelete,
      dropIn: immediateValidated.dropIn,
      legacyZeroSwap: immediateValidated.legacyZeroSwap,
    }, paths).ackPlan !== options.ackPlan) {
      fail('release, PM2, or model state changed before removal');
    }

    const removal = await platform.removeModels(OLLAMA_DELETE_MODELS.map(({ tag }) => tag));
    const finalSnapshot = await platform.snapshot();
    const finalValidated = validateFinalizationSnapshot(finalSnapshot, {
      inventoryPhase: 'after',
      expectedDropInSha256: sha256(Buffer.from(OLLAMA_DROP_IN)),
      requireLegacyAbsent: true,
    });
    const finalEnvelope = await platform.readEffectiveEnvelope();
    const finalSmoke = await platform.smokeRetainedModel();
    const complete = {
      ...receipt,
      status: 'complete',
      completedAt: new Date().toISOString(),
      after: {
        releases: finalValidated.releases,
        pm2: finalValidated.pm2,
        ollama: finalValidated.ollama,
        dropIn: finalValidated.dropIn,
        legacyZeroSwap: finalValidated.legacyZeroSwap,
        envelope: finalEnvelope,
        smokeBeforeRemoval: firstSmoke,
        smokeAfterRemoval: finalSmoke,
        removedTags: removal.removedTags,
      },
      rollback: { status: 'not_required' },
    };
    await platform.writeReceipt(paths.result, complete);
    return complete;
  } catch (error) {
    const failed = {
      ...receipt,
      status: 'failed',
      completedAt: new Date().toISOString(),
      after: envelope ? { envelope, smokeBeforeRemoval: firstSmoke } : null,
      rollback: { status: 'not_applicable_after_verified_envelope' },
      failure: String(error?.message || 'verified model removal failed').slice(0, 256),
    };
    await platform.writeReceipt(paths.result, failed);
    throw error;
  }
}

function command(binary, args, label, {
  timeout = 30_000,
  accepted = [0],
  env = undefined,
  maxBuffer = MAX_BYTES,
} = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    shell: false,
    timeout,
    maxBuffer,
    env,
  });
  if (result.error || result.signal || !accepted.includes(result.status)) fail(`${label} failed`);
  return (result.stdout || '').trim();
}

function fsyncPath(path) {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureRootDirectory(path, mode) {
  if (!existsSync(path)) {
    mkdirSync(path, { mode });
    chmodSync(path, mode);
    chownSync(path, 0, 0);
    fsyncPath(dirname(path));
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== mode || realpathSync.native(path) !== path) {
    fail(`${path} is not a trusted root-owned mode-${mode.toString(8)} directory`);
  }
}

function atomicWrite(path, bytes, mode = 0o600) {
  const temporary = join(dirname(path), `.nexus-ollama-${process.pid}-${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes, { flag: 'wx', mode });
  chmodSync(temporary, mode);
  chownSync(temporary, 0, 0);
  fsyncPath(temporary);
  renameSync(temporary, path);
  fsyncPath(dirname(path));
}

function readRootDropIn(path, required) {
  if (!existsSync(path)) {
    if (required) fail(`required Ollama drop-in is missing: ${path}`);
    return { path, exists: false, bytes: null, sha256: null, mode: null, uid: null, gid: null };
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
      || (info.mode & 0o777) !== 0o644 || info.size > MAX_BYTES
      || realpathSync.native(path) !== path) {
    fail(`unsafe Ollama drop-in: ${path}`);
  }
  const bytes = readFileSync(path);
  return {
    path,
    exists: true,
    bytes,
    sha256: sha256(bytes),
    mode: info.mode & 0o777,
    uid: info.uid,
    gid: info.gid,
  };
}

function readReleaseRecord(role, dominguezUid) {
  const policy = RELEASES[role];
  const info = lstatSync(policy.state);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== dominguezUid
      || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES) {
    fail(`${role} release-state file is unsafe`);
  }
  const bytes = readFileSync(policy.state);
  let state;
  try {
    state = JSON.parse(bytes);
  } catch {
    fail(`${role} release-state file is malformed`);
  }
  const link = `${policy.base}/current`;
  const linkInfo = lstatSync(link);
  if (!linkInfo.isSymbolicLink() || readlinkSync(link).length === 0) {
    fail(`${role} current selector is not a symlink`);
  }
  const currentTarget = realpathSync.native(link);
  const targetInfo = lstatSync(currentTarget);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    fail(`${role} current selector target is unsafe`);
  }
  return {
    statePath: policy.state,
    stateSha256: sha256(bytes),
    state,
    currentTarget,
  };
}

function readPm2Snapshot() {
  const raw = command('/usr/sbin/runuser', [
    '-u',
    'dominguez',
    '--',
    '/usr/bin/env',
    '-i',
    `HOME=${DEPLOY_HOME}`,
    'USER=dominguez',
    'LOGNAME=dominguez',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    `PM2_HOME=${join(DEPLOY_HOME, '.pm2')}`,
    '/usr/local/bin/pm2',
    'jlist',
  ], 'PM2 identity query', { timeout: 15_000, maxBuffer: 4 * MAX_BYTES });
  try {
    return JSON.parse(raw);
  } catch {
    fail('PM2 identity query returned malformed JSON');
  }
}

async function requestJson(path, {
  method = 'GET',
  body = null,
  timeoutMs = 10_000,
  maximumBytes = MAX_BYTES,
} = {}) {
  const url = new URL(path, OLLAMA_ORIGIN);
  if (url.origin !== OLLAMA_ORIGIN) fail('Ollama request escaped the reviewed loopback origin');
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(url, {
      method,
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': String(payload.length),
        } : {}),
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        rejectRequest(new Error(`Ollama ${url.pathname} returned HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maximumBytes) request.destroy(new Error('Ollama response exceeded its bound'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          rejectRequest(new Error(`Ollama ${url.pathname} returned malformed JSON`));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Ollama ${url.pathname} timed out`)));
    request.on('error', rejectRequest);
    if (payload) request.write(payload);
    request.end();
  });
}

async function readOllamaState() {
  const [tags, loaded] = await Promise.all([
    requestJson('/api/tags'),
    requestJson('/api/ps'),
  ]);
  return {
    inventory: tags?.models,
    loaded: loaded?.models,
  };
}

function readSystemdEnvelope() {
  const stdout = command('/usr/bin/systemctl', [
    'show',
    'ollama.service',
    '--no-pager',
    '--property=Environment',
    '--property=MemoryHigh',
    '--property=MemoryMax',
    '--property=MemorySwapMax',
    '--property=CPUQuotaPerSecUSec',
    '--property=Nice',
  ], 'effective Ollama envelope query');
  return parseAndValidateOllamaEnvelope(stdout, OLLAMA_ENVELOPE.memorySwapBaselineBytes);
}

function verifyLoopbackListener() {
  const stdout = command('/usr/bin/ss', ['-ltnH'], 'Ollama listener query');
  const listeners = stdout.split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u)[3])
    .filter((address) => address?.endsWith(':11434'));
  if (listeners.length === 0
      || listeners.some((address) => ![
        '127.0.0.1:11434',
        '[::1]:11434',
        '::1:11434',
      ].includes(address))) {
    fail('Ollama is not bound exclusively to loopback port 11434');
  }
  return listeners.sort();
}

function createRealPlatform() {
  const dominguezUid = Number(command('/usr/bin/id', ['-u', 'dominguez'], 'dominguez UID query'));
  const candidateSha256 = sha256(Buffer.from(OLLAMA_DROP_IN));
  return {
    async snapshot() {
      return {
        releases: {
          staging: readReleaseRecord('staging', dominguezUid),
          production: readReleaseRecord('production', dominguezUid),
        },
        pm2: readPm2Snapshot(),
        ollama: await readOllamaState(),
        dropIn: readRootDropIn(DROP_IN_PATH, true),
        legacyZeroSwap: readRootDropIn(LEGACY_ZERO_SWAP_PATH, false),
      };
    },
    async prepareReceipt(paths, snapshot, receipt) {
      ensureRootDirectory(RECEIPT_ROOT, 0o700);
      for (const path of [paths.result, paths.predecessorDropIn, paths.legacyZeroSwap]) {
        if (existsSync(path)) fail(`Ollama finalization evidence already exists: ${path}`);
      }
      writeFileSync(paths.predecessorDropIn, snapshot.dropIn.bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(paths.predecessorDropIn, 0o600);
      chownSync(paths.predecessorDropIn, 0, 0);
      fsyncPath(paths.predecessorDropIn);
      if (snapshot.legacyZeroSwap.exists) {
        writeFileSync(paths.legacyZeroSwap, snapshot.legacyZeroSwap.bytes, { flag: 'wx', mode: 0o600 });
        chmodSync(paths.legacyZeroSwap, 0o600);
        chownSync(paths.legacyZeroSwap, 0, 0);
        fsyncPath(paths.legacyZeroSwap);
      }
      fsyncPath(RECEIPT_ROOT);
      writeFileSync(paths.result, `${JSON.stringify(receipt, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      chmodSync(paths.result, 0o600);
      chownSync(paths.result, 0, 0);
      fsyncPath(paths.result);
      fsyncPath(RECEIPT_ROOT);
    },
    async writeReceipt(path, value) {
      atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`), 0o600);
    },
    async installEnvelope() {
      atomicWrite(DROP_IN_PATH, Buffer.from(OLLAMA_DROP_IN), 0o644);
      if (existsSync(LEGACY_ZERO_SWAP_PATH)) {
        const legacy = readRootDropIn(LEGACY_ZERO_SWAP_PATH, true);
        if (!legacy.bytes.equals(LEGACY_ZERO_SWAP_BYTES)) fail('legacy zero-swap drop-in changed');
        unlinkSync(LEGACY_ZERO_SWAP_PATH);
        fsyncPath(dirname(LEGACY_ZERO_SWAP_PATH));
      }
    },
    async restartAndValidateEnvelope() {
      command('/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload');
      command('/usr/bin/systemctl', ['restart', 'ollama.service'], 'Ollama restart', { timeout: 60_000 });
      command('/usr/bin/systemctl', ['is-active', '--quiet', 'ollama.service'], 'Ollama active-state check');
      const envelope = readSystemdEnvelope();
      const listeners = verifyLoopbackListener();
      return { ...envelope, listeners };
    },
    async readEffectiveEnvelope() {
      const envelope = readSystemdEnvelope();
      const listeners = verifyLoopbackListener();
      return { ...envelope, listeners };
    },
    async smokeRetainedModel() {
      const response = await requestJson('/api/chat', {
        method: 'POST',
        timeoutMs: 120_000,
        body: {
          model: OLLAMA_RETAINED_MODEL.tag,
          messages: [{ role: 'user', content: 'reply with the single word ok' }],
          stream: false,
          think: false,
          options: {
            num_ctx: 4096,
            num_predict: 16,
            temperature: 0,
          },
          keep_alive: -1,
        },
      });
      const text = response?.message?.content;
      if (response?.done !== true
          || typeof text !== 'string'
          || text.trim().length === 0
          || (response.model && response.model !== OLLAMA_RETAINED_MODEL.tag)) {
        fail('retained 3B Ollama smoke returned an invalid response');
      }
      return {
        model: OLLAMA_RETAINED_MODEL.tag,
        done: true,
        responsePresent: true,
      };
    },
    async restorePredecessor(snapshot) {
      atomicWrite(DROP_IN_PATH, snapshot.dropIn.bytes, 0o644);
      if (snapshot.legacyZeroSwap.exists) {
        atomicWrite(LEGACY_ZERO_SWAP_PATH, snapshot.legacyZeroSwap.bytes, 0o644);
      } else if (existsSync(LEGACY_ZERO_SWAP_PATH)) {
        const current = readRootDropIn(LEGACY_ZERO_SWAP_PATH, true);
        if (!current.bytes.equals(LEGACY_ZERO_SWAP_BYTES)) fail('unsafe legacy drop-in blocks rollback');
        unlinkSync(LEGACY_ZERO_SWAP_PATH);
        fsyncPath(dirname(LEGACY_ZERO_SWAP_PATH));
      }
      command('/usr/bin/systemctl', ['daemon-reload'], 'systemd daemon reload during rollback');
      command('/usr/bin/systemctl', ['restart', 'ollama.service'], 'Ollama predecessor restart', {
        timeout: 60_000,
      });
      command('/usr/bin/systemctl', ['is-active', '--quiet', 'ollama.service'], 'Ollama predecessor check');
      const restored = readRootDropIn(DROP_IN_PATH, true);
      if (restored.sha256 !== snapshot.dropIn.sha256) fail('Ollama predecessor drop-in was not restored');
      const restoredLegacy = readRootDropIn(LEGACY_ZERO_SWAP_PATH, false);
      if (restoredLegacy.exists !== snapshot.legacyZeroSwap.exists
          || (restoredLegacy.exists
            && restoredLegacy.sha256 !== snapshot.legacyZeroSwap.sha256)) {
        fail('legacy zero-swap predecessor was not restored');
      }
      verifyLoopbackListener();
      await this.smokeRetainedModel();
      return { status: 'restored', dropInSha256: restored.sha256 };
    },
    async removeModels(tags) {
      const expected = OLLAMA_DELETE_MODELS.map(({ tag }) => tag);
      if (JSON.stringify(tags) !== JSON.stringify(expected)) fail('model removal target list changed');
      command('/usr/local/bin/ollama', ['rm', ...expected], 'verified Ollama model removal', {
        timeout: 10 * 60_000,
        env: {
          HOME: '/var/lib/ollama',
          PATH: '/usr/local/bin:/usr/bin:/bin',
          OLLAMA_HOST: OLLAMA_ORIGIN,
        },
        maxBuffer: 4 * MAX_BYTES,
      });
      return { removedTags: expected };
    },
    candidateSha256,
  };
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    ownerAuthorized: false,
    ackPlan: null,
  };
  let explicitMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run' || arg === '--apply') {
      const mode = arg.slice(2);
      if (explicitMode && mode !== options.mode) fail('--dry-run and --apply are mutually exclusive', 64);
      explicitMode = true;
      options.mode = mode;
    } else if (arg === '--owner-authorized') {
      options.ownerAuthorized = true;
    } else if (arg === '--ack-plan') {
      index += 1;
      options.ackPlan = argv[index];
      if (!ACK_PATTERN.test(options.ackPlan || '')) fail('--ack-plan requires sha256:<64-hex>', 64);
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage:
  sudo ${INSTALLED_EXECUTABLE} --dry-run
  sudo ${INSTALLED_EXECUTABLE} --apply --owner-authorized --ack-plan sha256:<64-hex>
`);
      return null;
    } else {
      fail(`unknown argument: ${arg}`, 64);
    }
  }
  if (options.mode === 'dry-run' && (options.ownerAuthorized || options.ackPlan)) {
    fail('authorization arguments are apply-only', 64);
  }
  if (options.mode === 'apply'
      && (!options.ownerAuthorized || !ACK_PATTERN.test(options.ackPlan || ''))) {
    fail('apply requires --owner-authorized and a fresh --ack-plan', 64);
  }
  return options;
}

function assertInstalledExecutable() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    fail('Ollama lean finalization must execute as root', 77);
  }
  const executable = realpathSync.native(fileURLToPath(import.meta.url));
  const info = lstatSync(executable);
  if (executable !== INSTALLED_EXECUTABLE
      || !info.isFile()
      || info.isSymbolicLink()
      || info.uid !== 0
      || info.gid !== 0
      || (info.mode & 0o777) !== 0o700) {
    fail(`finalizer must be the root-owned mode-0700 ${INSTALLED_EXECUTABLE}`, 77);
  }
}

function validateLocks() {
  const dominguezUid = Number(command('/usr/bin/id', ['-u', 'dominguez'], 'dominguez UID query'));
  const dominguezGid = Number(command('/usr/bin/id', ['-g', 'dominguez'], 'dominguez GID query'));
  for (const [path, uid, gid, mode] of [
    [USER_RELEASE_LOCK, dominguezUid, dominguezGid, 0o600],
    [ROOT_SONAR_LOCK, 0, dominguezGid, 0o660],
  ]) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid
        || (info.mode & 0o777) !== mode) {
      fail(`shared lock is missing or unsafe: ${path}`, 75);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  assertInstalledExecutable();
  validateLocks();
  if (process.env.NEXUS_OLLAMA_FINALIZE_LOCKED !== '1') {
    const result = spawnSync('/usr/bin/flock', [
      '-n',
      '-E',
      '75',
      USER_RELEASE_LOCK,
      '/usr/bin/flock',
      '-n',
      '-E',
      '75',
      ROOT_SONAR_LOCK,
      '/usr/bin/env',
      '-i',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'NEXUS_OLLAMA_FINALIZE_LOCKED=1',
      `NEXUS_RELEASE_DEPLOY_HOME=${DEPLOY_HOME}`,
      '/usr/bin/node',
      INSTALLED_EXECUTABLE,
      ...process.argv.slice(2),
    ], {
      stdio: 'inherit',
      shell: false,
      timeout: 20 * 60_000,
    });
    if (result.error || result.signal) fail('Ollama finalizer lock transaction failed');
    process.exitCode = result.status;
    return;
  }
  const result = await executeOllamaFinalization(options, createRealPlatform());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`ollama_lean_finalize_blocked: ${error?.message || 'unknown error'}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}
