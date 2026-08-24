#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parseAndValidateOllamaEnvelope } from './lib/ollama-service-envelope.mjs';
import {
  normalizeOllamaModelDigest,
  ollamaModelDigestsEqual,
} from './lib/ollama-model-digest.mjs';

const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url));
const MANIFEST_PATH = '/usr/local/sbin/nexus-local-model-manifest.json';
// This must sort after the permanent override.conf so the attended benchmark
// limits are effective. Rollback removes it and proves the production envelope.
const DROP_IN_PATH = '/etc/systemd/system/ollama.service.d/zz-nexus-benchmark-envelope.conf';
const RECEIPT_ROOT = '/var/lib/nexus-release/local-model-benchmark-envelope';
const MAINTENANCE_LOCK = '/run/lock/nexus-release-sonar.lock';
const RELEASE_VIEW = '/usr/local/sbin/nexus-release-state-view';
const PRODUCTION_ENVELOPE_CHECK = '/usr/local/sbin/nexus-ollama-service-envelope-check.mjs';
const SYSTEMCTL = '/usr/bin/systemctl';
const GATEWAY_SOCKETS = [
  '/run/nexus-inference/staging/ollama.sock',
  '/run/nexus-inference/production/ollama.sock',
];

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function command(binary, args, label, timeout = 30_000) {
  const result = spawnSync(binary, args, { encoding: 'utf8', shell: false, timeout });
  if (result.error || result.signal || result.status !== 0) fail(`${label} failed`, result.status || 1);
  return result.stdout.trim();
}

function secureRegularFile(path, label, expectedMode = null) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
      || (stat.mode & 0o022) !== 0
      || (expectedMode !== null && (stat.mode & 0o777) !== expectedMode)) {
    fail(`${label} is not a trusted root-owned regular file`);
  }
  return stat;
}

function secureRootDirectory(path, label) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
      || (stat.mode & 0o022) !== 0 || realpathSync(path) !== path) {
    fail(`${label} is not a trusted root-owned directory`);
  }
}

function readManifest(candidateId) {
  secureRegularFile(MANIFEST_PATH, 'installed signed local-model manifest', 0o644);
  let manifest;
  try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
  catch { fail('installed signed local-model manifest is malformed'); }
  const active = Array.isArray(manifest?.models)
    ? manifest.models.find((model) => model?.id === manifest.activeModelId)
    : null;
  const candidate = Array.isArray(manifest?.models)
    ? manifest.models.find((model) => model?.id === candidateId)
    : null;
  const winners = Array.isArray(manifest?.models)
    ? manifest.models.filter((model) => model?.role === 'winner')
    : [];
  const envelope = manifest?.benchmarkEnvelope;
  if (manifest?.schemaVersion !== 'nexus.local-model-manifest.v1'
      || typeof manifest.manifestVersion !== 'string'
      || manifest.selectionStatus !== 'control_only'
      || manifest.selectionEvidence !== null
      || winners.length !== 0
      || !active?.productionEligible
      || typeof active?.commercialUseApproved !== 'boolean'
      || active.evidenceStatus !== 'verified'
      || !/^sha256:[0-9a-f]{64}$/u.test(active.digest || '')
      || !candidate
      || typeof candidate.commercialUseApproved !== 'boolean'
      || !['control', 'candidate'].includes(candidate.role)
      || typeof candidate.ollamaTag !== 'string'
      || candidate.ollamaTag.trim().length === 0
      || (candidate.digest !== null && !/^sha256:[0-9a-f]{64}$/u.test(candidate.digest || ''))
      || !envelope || envelope.memoryHighBytes !== 22 * 1024 ** 3
      || envelope.memoryMaxBytes !== 24 * 1024 ** 3
      || envelope.memorySwapMaxBytes !== 0
      || envelope.cpuQuotaPercent !== 800
      || envelope.minimumHostAvailableBytes !== 6 * 1024 ** 3
      || envelope.maxLoadedModels !== 1
      || envelope.parallelGenerations !== 1
      || envelope.waitingQueueDepth !== 4
      || envelope.maxContextTokens !== 16_384
      || envelope.nice !== 10) {
    fail('signed local-model manifest has no approved benchmark envelope');
  }
  return {
    manifestVersion: manifest.manifestVersion,
    candidateModelId: candidate.id,
    candidateModelTag: candidate.ollamaTag,
    candidateDeclaredDigest: candidate.digest,
    envelope,
  };
}

function requestJson(path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: 11434,
      path,
      method: 'GET',
      timeout: 10_000,
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          request.destroy(new Error('Ollama candidate inventory exceeded the response limit'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          rejectRequest(new Error(`Ollama candidate inventory returned HTTP ${response.statusCode}`));
          return;
        }
        try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { rejectRequest(new Error('Ollama candidate inventory returned malformed JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Ollama candidate inventory timed out')));
    request.on('error', rejectRequest);
    request.end();
  });
}

export function resolveInstalledCandidateIdentity(candidate, inventory) {
  const matches = Array.isArray(inventory?.models)
    ? inventory.models.filter((model) => model?.name === candidate.candidateModelTag
      || model?.model === candidate.candidateModelTag)
    : [];
  const digest = matches.length === 1
    ? normalizeOllamaModelDigest(matches[0]?.digest)
    : null;
  if (!digest) {
    fail('the requested signed-manifest candidate is not installed with one exact digest', 75);
  }
  if (candidate.candidateDeclaredDigest !== null
      && !ollamaModelDigestsEqual(candidate.candidateDeclaredDigest, digest)) {
    fail('the installed candidate digest differs from its signed manifest digest', 75);
  }
  return {
    candidateModelId: candidate.candidateModelId,
    candidateModelTag: candidate.candidateModelTag,
    candidateModelDigest: digest,
  };
}

async function installedCandidateIdentity(candidate) {
  let inventory;
  try { inventory = await requestJson('/api/tags'); }
  catch (error) { fail(`could not inspect the local Ollama candidate: ${error.message}`, 75); }
  return resolveInstalledCandidateIdentity(candidate, inventory);
}

function expectedRuntimeEnvelope(envelope) {
  return {
    memoryHighBytes: envelope.memoryHighBytes,
    memoryMaxBytes: envelope.memoryMaxBytes,
    memorySwapBaselineBytes: envelope.memorySwapMaxBytes,
    cpuQuotaUsecPerSec: envelope.cpuQuotaPercent * 10_000,
    nice: envelope.nice,
  };
}

function benchmarkDropInBytes(envelope) {
  return Buffer.from([
    '[Service]',
    `MemoryHigh=${envelope.memoryHighBytes}`,
    `MemoryMax=${envelope.memoryMaxBytes}`,
    'MemorySwapMax=0',
    'CPUQuota=800%',
    'Nice=10',
    '',
  ].join('\n'));
}

function readEffectiveEnvelope(expected) {
  const stdout = command(SYSTEMCTL, [
    'show', 'ollama.service', '--no-pager',
    '--property=Environment',
    '--property=MemoryHigh',
    '--property=MemoryMax',
    '--property=MemorySwapMax',
    '--property=CPUQuotaPerSecUSec',
    '--property=Nice',
  ], 'effective benchmark envelope query');
  return parseAndValidateOllamaEnvelope(stdout, 0, expected);
}

function releaseEvidence() {
  secureRegularFile(RELEASE_VIEW, 'release-state view', 0o755);
  const view = JSON.parse(command(RELEASE_VIEW, [], 'release-state stability read'));
  if (view?.effective?.provable !== true || view.effective.source !== 'receipt'
      || view.effective.status !== 'completed' || view.activeReceipt?.outcome !== 'completed') {
    fail('the signed application release is not settled on an accepted receipt');
  }
  return {
    releaseId: view.effective.releaseId,
    sourceSha: view.activeReceipt.sourceSha,
    releasePayloadDigest: view.activeReceipt.releasePayloadDigest,
    completedAt: view.activeReceipt.completedAt,
  };
}

export function assertBenchmarkHostPressure(observation, envelope) {
  const availableBytes = observation?.availableBytes;
  const swapUsedBytes = observation?.swapUsedBytes;
  const minimumAvailableBytes = envelope?.minimumHostAvailableBytes;
  const maximumSwapUsedBytes = envelope?.memorySwapMaxBytes;
  if (!Number.isSafeInteger(minimumAvailableBytes) || minimumAvailableBytes < 0
      || !Number.isSafeInteger(maximumSwapUsedBytes) || maximumSwapUsedBytes < 0) {
    fail('signed benchmark host policy is invalid');
  }
  if (!Number.isSafeInteger(availableBytes) || availableBytes < minimumAvailableBytes) {
    fail('host has less than the signed minimum available memory');
  }
  if (!Number.isSafeInteger(swapUsedBytes) || swapUsedBytes < 0
      || swapUsedBytes > maximumSwapUsedBytes) {
    fail('host swap exceeds the signed benchmark limit');
  }
  return { availableBytes, swapUsedBytes };
}

function hostPressure(envelope) {
  const text = readFileSync('/proc/meminfo', 'utf8');
  const values = new Map([...text.matchAll(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/gmu)]
    .map((match) => [match[1], Number(match[2]) * 1024]));
  const availableBytes = values.get('MemAvailable');
  const swapTotal = values.get('SwapTotal');
  const swapFree = values.get('SwapFree');
  const swapUsedBytes = Number.isSafeInteger(swapTotal) && Number.isSafeInteger(swapFree)
    ? swapTotal - swapFree
    : null;
  return assertBenchmarkHostPressure({ availableBytes, swapUsedBytes }, envelope);
}

function assertGatewaysStopped() {
  for (const socketPath of GATEWAY_SOCKETS) {
    if (existsSync(socketPath)) fail(`gateway must be stopped before benchmarking: ${socketPath}`, 75);
  }
}

export function buildBenchmarkEnvelopePlan(evidence) {
  const hostPolicy = {
    minimumAvailableBytes: evidence.manifest.benchmarkEnvelope.minimumHostAvailableBytes,
    maximumSwapUsedBytes: evidence.manifest.benchmarkEnvelope.memorySwapMaxBytes,
  };
  const core = {
    schema: 'nexus.local-model-benchmark-envelope-plan.v1',
    release: evidence.release,
    manifest: evidence.manifest,
    hostPolicy,
    dropIn: evidence.dropIn,
  };
  return {
    ...core,
    hostObservation: evidence.host,
    ackPlan: `sha256:${sha256(stableJson(core))}`,
  };
}

async function inspect(candidateId) {
  assertGatewaysStopped();
  if (existsSync(DROP_IN_PATH)) fail('benchmark envelope is already active; use receipt-bound rollback', 75);
  secureRootDirectory(dirname(DROP_IN_PATH), 'Ollama systemd drop-in directory');
  secureRegularFile(PRODUCTION_ENVELOPE_CHECK, 'production envelope checker', 0o700);
  command(PRODUCTION_ENVELOPE_CHECK, ['--expected-swap-bytes', '0'], 'production envelope preflight');
  command(SYSTEMCTL, ['is-active', '--quiet', 'ollama.service'], 'Ollama service state');
  const manifest = readManifest(candidateId);
  const candidate = await installedCandidateIdentity(manifest);
  const bytes = benchmarkDropInBytes(manifest.envelope);
  return buildBenchmarkEnvelopePlan({
    release: releaseEvidence(),
    manifest: {
      manifestVersion: manifest.manifestVersion,
      ...candidate,
      benchmarkEnvelope: manifest.envelope,
    },
    host: hostPressure(manifest.envelope),
    dropIn: { path: DROP_IN_PATH, state: 'absent', sha256: sha256(bytes), mode: 0o644 },
  });
}

function ensureReceiptRoot() {
  if (!existsSync(RECEIPT_ROOT)) mkdirSync(RECEIPT_ROOT, { mode: 0o700 });
  const stat = lstatSync(RECEIPT_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
      || (stat.mode & 0o777) !== 0o700) fail('benchmark receipt directory is unsafe');
}

function atomicWrite(path, bytes, mode) {
  if (existsSync(path)) fail(`refusing to replace governed path: ${path}`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
    const parent = openSync(dirname(path), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function restartOllama(label) {
  command(SYSTEMCTL, ['daemon-reload'], `${label} daemon reload`);
  command(SYSTEMCTL, ['restart', 'ollama.service'], `${label} Ollama restart`, 120_000);
  command(SYSTEMCTL, ['is-active', '--quiet', 'ollama.service'], `${label} Ollama service state`);
}

function assertMaintenanceLockHeld() {
  const inheritedFd = Number(process.env.NEXUS_MAINTENANCE_LOCK_FD);
  try {
    const descriptor = fstatSync(inheritedFd);
    const lock = lstatSync(MAINTENANCE_LOCK);
    if (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3
        || descriptor.dev !== lock.dev || descriptor.ino !== lock.ino) {
      fail('shared maintenance lock descriptor is not inherited from the attended benchmark transaction', 75);
    }
  } catch {
    fail('shared maintenance lock descriptor is not inherited from the attended benchmark transaction', 75);
  }
}

export function assertBenchmarkDropInRollbackBytes(expectedDigest, bytes) {
  if (!/^[0-9a-f]{64}$/u.test(expectedDigest || '') || sha256(bytes) !== expectedDigest) {
    fail('benchmark envelope drop-in changed; refusing automatic removal', 75);
  }
  return true;
}

function removeExactDropIn(expectedDigest) {
  secureRegularFile(DROP_IN_PATH, 'benchmark envelope drop-in', 0o644);
  assertBenchmarkDropInRollbackBytes(expectedDigest, readFileSync(DROP_IN_PATH));
  unlinkSync(DROP_IN_PATH);
  const parent = openSync(dirname(DROP_IN_PATH), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

async function applyLocked(candidateId, ackPlan) {
  if (process.getuid?.() !== 0) fail('benchmark envelope apply requires root', 77);
  assertMaintenanceLockHeld();
  const before = await inspect(candidateId);
  if (ackPlan !== before.ackPlan) fail('owner acknowledgement does not match the current benchmark plan', 77);
  ensureReceiptRoot();
  const bytes = benchmarkDropInBytes(before.manifest.benchmarkEnvelope);
  try {
    const activationHostObservation = hostPressure(before.manifest.benchmarkEnvelope);
    atomicWrite(DROP_IN_PATH, bytes, 0o644);
    restartOllama('benchmark apply');
    const observed = readEffectiveEnvelope(expectedRuntimeEnvelope(before.manifest.benchmarkEnvelope));
    const transactionId = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID()}`;
    const receiptPath = `${RECEIPT_ROOT}/${transactionId}.json`;
    const receipt = {
      schema: 'nexus.local-model-benchmark-envelope-receipt.v1',
      transactionId,
      status: 'active',
      ackPlan,
      release: before.release,
      manifest: before.manifest,
      hostAdmission: {
        policy: before.hostPolicy,
        observed: activationHostObservation,
      },
      dropIn: before.dropIn,
      observed,
      activatedAt: new Date().toISOString(),
    };
    atomicWrite(receiptPath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600);
    return {
      ...receipt,
      receiptPath,
      receiptSha256: `sha256:${sha256(readFileSync(receiptPath))}`,
    };
  } catch (error) {
    if (existsSync(DROP_IN_PATH) && sha256(readFileSync(DROP_IN_PATH)) === before.dropIn.sha256) {
      removeExactDropIn(before.dropIn.sha256);
      try {
        restartOllama('benchmark apply rollback');
        command(PRODUCTION_ENVELOPE_CHECK, ['--expected-swap-bytes', '0'], 'restored production envelope');
      } catch (rollbackError) {
        fail(`benchmark apply failed and production rollback could not be verified: ${rollbackError.message}`, 75);
      }
    }
    throw error;
  }
}

function rollbackLocked(receiptPath, acknowledgement) {
  if (process.getuid?.() !== 0) fail('benchmark envelope rollback requires root', 77);
  assertMaintenanceLockHeld();
  assertGatewaysStopped();
  if (!receiptPath.startsWith(`${RECEIPT_ROOT}/`) || resolve(receiptPath) !== receiptPath) {
    fail('benchmark rollback receipt is outside the governed directory', 64);
  }
  secureRegularFile(receiptPath, 'benchmark envelope receipt', 0o600);
  const receiptBytes = readFileSync(receiptPath);
  if (acknowledgement !== `sha256:${sha256(receiptBytes)}`) {
    fail('rollback acknowledgement does not match the benchmark receipt', 77);
  }
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt?.schema !== 'nexus.local-model-benchmark-envelope-receipt.v1'
      || receipt.status !== 'active'
      || receipt.dropIn?.path !== DROP_IN_PATH
      || !/^[0-9a-f]{64}$/u.test(receipt.dropIn?.sha256 || '')) {
    fail('benchmark envelope receipt is not rollbackable');
  }
  const rollbackPath = `${receiptPath}.rollback.json`;
  if (existsSync(rollbackPath)) fail('benchmark rollback receipt already exists', 75);
  removeExactDropIn(receipt.dropIn.sha256);
  restartOllama('benchmark rollback');
  const restoredEnvelope = JSON.parse(command(
    PRODUCTION_ENVELOPE_CHECK,
    ['--expected-swap-bytes', '0'],
    'restored production envelope',
  ));
  const rollbackReceipt = {
    schema: 'nexus.local-model-benchmark-envelope-rollback.v1',
    transactionId: receipt.transactionId,
    status: 'restored',
    sourceReceipt: receiptPath,
    sourceReceiptSha256: acknowledgement,
    release: receipt.release,
    manifest: receipt.manifest,
    restoredEnvelope,
    completedAt: new Date().toISOString(),
  };
  atomicWrite(rollbackPath, Buffer.from(`${JSON.stringify(rollbackReceipt, null, 2)}\n`), 0o600);
  return {
    status: 'restored',
    rollbackPath,
    rollbackReceiptSha256: `sha256:${sha256(readFileSync(rollbackPath))}`,
  };
}

function lockedReexec(commandName, args) {
  const lockFd = openSync(MAINTENANCE_LOCK, 'a');
  let result;
  try {
    result = spawnSync('/usr/bin/flock', [
      '--exclusive', '--nonblock', '3',
      process.execPath, SCRIPT_PATH, `__${commandName}`, ...args,
    ], {
      encoding: 'utf8',
      shell: false,
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe', lockFd],
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        NEXUS_MAINTENANCE_LOCK_FD: '3',
      },
    });
  } finally {
    closeSync(lockFd);
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.signal || result.status !== 0) process.exit(result.status || 75);
}

function parseOptions(args, allowed) {
  if (args.length % 2 !== 0) fail('command options must be flag/value pairs', 64);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag) || values.has(flag)) fail(`unsupported or duplicate option: ${flag}`, 64);
    values.set(flag, args[index + 1]);
  }
  return values;
}

function validCandidateId(value) {
  return /^[a-z0-9][a-z0-9._-]{0,159}$/u.test(value || '');
}

async function main() {
  const [commandName, ...args] = process.argv.slice(2);
  if (commandName === 'plan' || commandName === 'verify') {
    const options = parseOptions(args, ['--candidate-id']);
    const candidateId = options.get('--candidate-id');
    if (!validCandidateId(candidateId)) fail(`${commandName} requires --candidate-id <signed-manifest-id>`, 64);
    process.stdout.write(`${JSON.stringify(await inspect(candidateId), null, 2)}\n`);
    return;
  }
  if (commandName === 'apply') {
    const options = parseOptions(args, ['--candidate-id', '--ack-plan']);
    const candidateId = options.get('--candidate-id');
    const acknowledgement = options.get('--ack-plan');
    if (!validCandidateId(candidateId) || !/^sha256:[0-9a-f]{64}$/u.test(acknowledgement || '')) {
      fail('apply requires --candidate-id <signed-manifest-id> --ack-plan sha256:<digest>', 64);
    }
    lockedReexec('apply', [candidateId, acknowledgement]);
    return;
  }
  if (commandName === '__apply') {
    process.stdout.write(`${JSON.stringify(await applyLocked(args[0], args[1]), null, 2)}\n`);
    return;
  }
  if (commandName === 'rollback') {
    const receiptIndex = args.indexOf('--receipt');
    const ackIndex = args.indexOf('--ack-receipt');
    if (receiptIndex < 0 || ackIndex < 0 || !/^sha256:[0-9a-f]{64}$/u.test(args[ackIndex + 1] || '')) {
      fail('rollback requires --receipt <absolute-path> --ack-receipt sha256:<digest>', 64);
    }
    lockedReexec('rollback', [args[receiptIndex + 1], args[ackIndex + 1]]);
    return;
  }
  if (commandName === '__rollback') {
    process.stdout.write(`${JSON.stringify(rollbackLocked(args[0], args[1]), null, 2)}\n`);
    return;
  }
  fail('usage: local-model-benchmark-envelope-transaction.mjs plan|verify --candidate-id <id>|apply --candidate-id <id> --ack-plan <digest>|rollback --receipt <path> --ack-receipt <digest>', 64);
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_PATH) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error?.exitCode || 1);
  }
}
