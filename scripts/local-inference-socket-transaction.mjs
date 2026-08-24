#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ollamaModelDigestsEqual } from './lib/ollama-model-digest.mjs';

const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const INSTALLED_MANIFEST = '/usr/local/sbin/nexus-local-model-manifest.json';
const SOURCE_MANIFEST = join(SOURCE_ROOT, 'config/local-model-manifest.json');
const TMPFILES_SOURCE = '/usr/local/sbin/nexus-local-inference-sockets.conf';
const TMPFILES_CONFIG = '/etc/tmpfiles.d/nexus-local-inference-sockets.conf';
const SOCKET_ROOT = '/run/nexus-inference';
const SOCKET_DIRS = Object.freeze([
  Object.freeze({ environment: 'staging', path: `${SOCKET_ROOT}/staging`, uid: 10001, gid: 10001, mode: 0o700 }),
  Object.freeze({ environment: 'production', path: `${SOCKET_ROOT}/production`, uid: 10001, gid: 10001, mode: 0o700 }),
]);
const RECEIPT_ROOT = '/var/lib/nexus-release/local-inference-sockets';
const BENCHMARK_RECEIPT_ROOT = '/var/lib/nexus-release/local-model-benchmark-envelope';
const MAINTENANCE_LOCK = '/run/lock/nexus-release-sonar.lock';
const RELEASE_VIEW = '/usr/local/sbin/nexus-release-state-view';
const ENVELOPE_CHECK = '/usr/local/sbin/nexus-ollama-service-envelope-check.mjs';
const SYSTEMD_TMPFILES = '/usr/bin/systemd-tmpfiles';
const MINIMUM_FREE_DISK_BYTES = 10 * 1024 ** 3;
const MINIMUM_AVAILABLE_MEMORY_BYTES = 6 * 1024 ** 3;

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

function command(binary, args, label) {
  const result = spawnSync(binary, args, { encoding: 'utf8', shell: false, timeout: 30_000 });
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} failed`, result.status || 1);
  }
  return result.stdout.trim();
}

function secureRegularFile(path, label, expectedMode = null) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
      || (stat.mode & 0o022) !== 0 || (expectedMode !== null && (stat.mode & 0o777) !== expectedMode)) {
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
  return stat;
}

function manifestPath() {
  if (existsSync(INSTALLED_MANIFEST)) return INSTALLED_MANIFEST;
  return SOURCE_MANIFEST;
}

function verifiedBenchmarkRollbackReceipt(expectedDigest, activeModel) {
  secureRootDirectory(BENCHMARK_RECEIPT_ROOT, 'benchmark receipt directory');
  const entries = readdirSync(BENCHMARK_RECEIPT_ROOT, { withFileTypes: true });
  if (entries.length > 512) fail('benchmark receipt directory exceeds the bounded evidence inventory');
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.rollback.json')) continue;
    const receiptPath = join(BENCHMARK_RECEIPT_ROOT, entry.name);
    const stat = secureRegularFile(receiptPath, 'benchmark rollback receipt', 0o600);
    if (stat.size > 1024 * 1024) fail('benchmark rollback receipt exceeds the bounded size');
    const bytes = readFileSync(receiptPath);
    if (`sha256:${sha256(bytes)}` === expectedDigest) matches.push({ receiptPath, bytes });
  }
  if (matches.length !== 1) {
    fail('production selection does not resolve to exactly one trusted benchmark rollback receipt');
  }
  const { receiptPath, bytes } = matches[0];
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { fail('benchmark rollback receipt is malformed'); }
  const sourceReceipt = receipt?.sourceReceipt;
  if (typeof sourceReceipt !== 'string'
      || !sourceReceipt.startsWith(`${BENCHMARK_RECEIPT_ROOT}/`)
      || resolve(sourceReceipt) !== sourceReceipt) {
    fail('benchmark rollback receipt source path is outside the governed directory');
  }
  const sourceStat = secureRegularFile(sourceReceipt, 'benchmark source receipt', 0o600);
  if (sourceStat.size > 1024 * 1024) fail('benchmark source receipt exceeds the bounded size');
  const sourceBytes = readFileSync(sourceReceipt);
  const sourceDigest = `sha256:${sha256(sourceBytes)}`;
  let source;
  try { source = JSON.parse(sourceBytes.toString('utf8')); }
  catch { fail('benchmark source receipt is malformed'); }
  const observed = receipt?.restoredEnvelope?.observed;
  if (receipt?.schema !== 'nexus.local-model-benchmark-envelope-rollback.v1'
      || receipt.status !== 'restored'
      || receipt.sourceReceiptSha256 !== sourceDigest
      || source?.schema !== 'nexus.local-model-benchmark-envelope-receipt.v1'
      || source.status !== 'active'
      || source.transactionId !== receipt.transactionId
      || source.manifest?.candidateModelId !== activeModel.id
      || source.manifest?.candidateModelTag !== activeModel.tag
      || source.manifest?.candidateModelDigest !== activeModel.digest
      || receipt.manifest?.candidateModelId !== activeModel.id
      || receipt.manifest?.candidateModelTag !== activeModel.tag
      || receipt.manifest?.candidateModelDigest !== activeModel.digest
      || stableJson(receipt.release) !== stableJson(source.release)
      || receipt.restoredEnvelope?.schema !== 'nexus.ollama-service-envelope-check.v1'
      || receipt.restoredEnvelope?.ok !== true
      || observed?.memoryHighBytes !== 18 * 1024 ** 3
      || observed?.memoryMaxBytes !== 20 * 1024 ** 3
      || observed?.memorySwapMaxBytes !== 0
      || observed?.cpuQuotaUsecPerSec !== 8_000_000
      || observed?.nice !== 10
      || observed?.contextLength !== 16_384
      || observed?.maxQueue !== 4
      || observed?.numParallel !== 1
      || observed?.maxLoadedModels !== 1
      || typeof receipt.completedAt !== 'string'
      || Number.isNaN(Date.parse(receipt.completedAt))) {
    fail('benchmark rollback receipt does not prove the selected model and restored production envelope');
  }
  return {
    path: receiptPath,
    digest: expectedDigest,
    transactionId: receipt.transactionId,
    completedAt: receipt.completedAt,
  };
}

function selectedModel() {
  const path = manifestPath();
  secureRegularFile(path, 'signed local-model manifest');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const active = Array.isArray(manifest.models)
    ? manifest.models.find((model) => model?.id === manifest.activeModelId)
    : null;
  const winners = Array.isArray(manifest.models)
    ? manifest.models.filter((model) => model?.role === 'winner')
    : [];
  const evidence = manifest.selectionEvidence;
  const productionEvidenceValid = manifest.selectionStatus !== 'production_selected' || (
    evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    && evidence.winningCandidateId === manifest.activeModelId
    && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkReportDigest || '')
    && typeof evidence.benchmarkCompletedAt === 'string'
    && !Number.isNaN(Date.parse(evidence.benchmarkCompletedAt))
    && new Date(evidence.benchmarkCompletedAt).toISOString() === evidence.benchmarkCompletedAt
    && /^sha256:[0-9a-f]{64}$/u.test(evidence.benchmarkHostRollbackReceiptDigest || '')
    && [
      'corpusReference',
      'licenseReviewReference',
      'ownerApprovalReference',
    ]
      .every((field) => typeof evidence[field] === 'string'
        && evidence[field].trim().length > 0
        && evidence[field].trim().length <= 512)
  );
  if (manifest.schemaVersion !== 'nexus.local-model-manifest.v1'
      || !['control_only', 'production_selected'].includes(manifest.selectionStatus)
      || (manifest.selectionStatus === 'control_only' && manifest.selectionEvidence !== null)
      || (manifest.selectionStatus === 'control_only'
        ? winners.length !== 0
        : winners.length !== 1 || winners[0]?.id !== active?.id)
      || !productionEvidenceValid
      || typeof manifest.manifestVersion !== 'string'
      || !active?.productionEligible
      || typeof active?.commercialUseApproved !== 'boolean'
      || active.evidenceStatus !== 'verified'
      || typeof active.ollamaTag !== 'string'
      || (manifest.selectionStatus === 'production_selected'
        && (active.role !== 'winner' || active.commercialUseApproved !== true))
      || !/^sha256:[0-9a-f]{64}$/u.test(active.digest || '')) {
    fail('signed local-model manifest has no verified digest-pinned active model');
  }
  const model = {
    manifestVersion: manifest.manifestVersion,
    selectionStatus: manifest.selectionStatus,
    id: active.id,
    tag: active.ollamaTag,
    digest: active.digest,
  };
  return manifest.selectionStatus === 'production_selected'
    ? {
      ...model,
      benchmarkRollback: verifiedBenchmarkRollbackReceipt(
        evidence.benchmarkHostRollbackReceiptDigest,
        model,
      ),
    }
    : model;
}

function requestJson(path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: '127.0.0.1', port: 11434, path, method: 'GET', timeout: 10_000 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) request.destroy(new Error('Ollama preflight response exceeded limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          rejectRequest(new Error(`Ollama preflight returned HTTP ${response.statusCode}`));
          return;
        }
        try { resolveRequest(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { rejectRequest(new Error('Ollama preflight returned malformed JSON')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Ollama preflight timed out')));
    request.on('error', rejectRequest);
    request.end();
  });
}

function directorySnapshot(path, expected) {
  if (!existsSync(path)) return { path, state: 'absent' };
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== expected.uid || stat.gid !== expected.gid
      || (stat.mode & 0o777) !== expected.mode) {
    fail(`socket directory has unsafe ownership or mode: ${path}`);
  }
  return { path, state: 'exact', uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
}

function tmpfilesPolicySnapshot() {
  secureRegularFile(TMPFILES_SOURCE, 'local-inference tmpfiles source', 0o644);
  secureRootDirectory(dirname(TMPFILES_CONFIG), 'system tmpfiles directory');
  const sourceSha256 = sha256(readFileSync(TMPFILES_SOURCE));
  if (!existsSync(TMPFILES_CONFIG)) {
    return {
      sourcePath: TMPFILES_SOURCE,
      activePath: TMPFILES_CONFIG,
      sourceSha256,
      state: 'absent',
    };
  }
  secureRegularFile(TMPFILES_CONFIG, 'active local-inference tmpfiles config', 0o644);
  if (sha256(readFileSync(TMPFILES_CONFIG)) !== sourceSha256) {
    fail('active local-inference tmpfiles config differs from the reviewed source');
  }
  return {
    sourcePath: TMPFILES_SOURCE,
    activePath: TMPFILES_CONFIG,
    sourceSha256,
    state: 'exact',
  };
}

function memoryEvidence() {
  const text = readFileSync('/proc/meminfo', 'utf8');
  const values = new Map([...text.matchAll(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/gmu)]
    .map((match) => [match[1], Number(match[2]) * 1024]));
  const available = values.get('MemAvailable');
  const swapTotal = values.get('SwapTotal');
  const swapFree = values.get('SwapFree');
  if (!Number.isSafeInteger(available) || available < MINIMUM_AVAILABLE_MEMORY_BYTES) {
    fail('host has less than 6 GiB available memory');
  }
  if (!Number.isSafeInteger(swapTotal) || !Number.isSafeInteger(swapFree) || swapTotal - swapFree !== 0) {
    fail('host swap must be unused before local-inference socket admission');
  }
  return { availableBytes: available, swapUsedBytes: 0 };
}

function releaseEvidence() {
  secureRegularFile(RELEASE_VIEW, 'release-state view', 0o755);
  const view = JSON.parse(command(RELEASE_VIEW, [], 'release-state stability read'));
  if (view?.effective?.provable !== true
      || view.effective.source !== 'receipt'
      || view.effective.status !== 'completed'
      || !view.activeReceipt
      || view.activeReceipt.outcome !== 'completed') {
    fail('the signed application release is not settled on an accepted receipt');
  }
  return {
    releaseId: view.effective.releaseId,
    sourceSha: view.activeReceipt.sourceSha,
    releasePayloadDigest: view.activeReceipt.releasePayloadDigest,
    completedAt: view.activeReceipt.completedAt,
  };
}

function listenerEvidence() {
  const output = command('/usr/bin/ss', ['-ltn'], 'Ollama listener inspection');
  const listeners = output.split(/\r?\n/u).filter((line) => /:11434\b/u.test(line));
  if (listeners.length !== 1 || !/127\.0\.0\.1:11434\b/u.test(listeners[0])) {
    fail('Ollama must listen exactly once on 127.0.0.1:11434');
  }
  return '127.0.0.1:11434';
}

function versionAtLeast024(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/u);
  return Boolean(match) && (Number(match[1]) > 0 || Number(match[2]) >= 24);
}

export function buildSocketTransactionPlan(evidence) {
  const core = {
    schema: 'nexus.local-inference-socket-plan.v1',
    release: evidence.release,
    model: evidence.model,
    ollama: evidence.ollama,
    host: evidence.host,
    tmpfilesPolicy: evidence.tmpfilesPolicy,
    directories: evidence.directories,
  };
  return { ...core, ackPlan: `sha256:${sha256(stableJson(core))}` };
}

async function inspect() {
  const tmpfilesPolicy = tmpfilesPolicySnapshot();
  const model = selectedModel();
  const version = await requestJson('/api/version');
  if (!versionAtLeast024(version?.version)) fail('Ollama 0.24.0 or newer is required');
  const tags = await requestJson('/api/tags');
  const selected = Array.isArray(tags?.models)
    ? tags.models.filter((entry) => (entry?.name === model.tag || entry?.model === model.tag)
      && ollamaModelDigestsEqual(entry?.digest, model.digest))
    : [];
  if (selected.length !== 1) fail('active model tag and digest are not installed exactly once');
  command('/usr/bin/systemctl', ['is-active', '--quiet', 'ollama.service'], 'Ollama service state');
  command(ENVELOPE_CHECK, ['--expected-swap-bytes', '0'], 'Ollama production envelope');
  const disk = statfsSync('/var/lib/ollama/models');
  const freeDiskBytes = disk.bavail * disk.bsize;
  if (freeDiskBytes < MINIMUM_FREE_DISK_BYTES) fail('Ollama model storage has less than 10 GiB free');
  return buildSocketTransactionPlan({
    release: releaseEvidence(),
    model,
    ollama: { version: version.version, listener: listenerEvidence(), service: 'active' },
    host: { ...memoryEvidence(), freeDiskBytes },
    tmpfilesPolicy,
    directories: [
      directorySnapshot(SOCKET_ROOT, { uid: 0, gid: 0, mode: 0o755 }),
      ...SOCKET_DIRS.map((entry) => ({
        environment: entry.environment,
        ...directorySnapshot(entry.path, entry),
      })),
    ],
  });
}

function ensureReceiptRoot() {
  if (!existsSync(RECEIPT_ROOT)) mkdirSync(RECEIPT_ROOT, { mode: 0o700 });
  const stat = lstatSync(RECEIPT_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
      || (stat.mode & 0o777) !== 0o700) fail('socket receipt directory is unsafe');
}

function atomicWrite(path, value) {
  if (existsSync(path)) fail(`refusing to replace existing transaction evidence: ${path}`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const descriptor = openSync(temporary, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function atomicWriteBytes(path, value, mode) {
  if (existsSync(path)) fail(`refusing to replace existing governed file: ${path}`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    const descriptor = openSync(temporary, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function assertReceiptPolicyScope(policy) {
  if (!policy || policy.sourcePath !== TMPFILES_SOURCE || policy.activePath !== TMPFILES_CONFIG
      || !/^[0-9a-f]{64}$/u.test(policy.sourceSha256 || '')
      || (policy.state !== 'absent' && policy.state !== 'exact')) {
    fail('socket transaction receipt tmpfiles policy scope is invalid');
  }
}

function installTmpfilesPolicy(before) {
  assertReceiptPolicyScope(before);
  const current = tmpfilesPolicySnapshot();
  if (stableJson(current) !== stableJson(before)) fail('tmpfiles policy changed after owner acknowledgement');
  if (before.state === 'absent') {
    atomicWriteBytes(TMPFILES_CONFIG, readFileSync(TMPFILES_SOURCE), 0o644);
  }
}

function restoreTmpfilesPolicy(before) {
  assertReceiptPolicyScope(before);
  if (before.state === 'exact') {
    const current = tmpfilesPolicySnapshot();
    if (stableJson(current) !== stableJson(before)) fail('pre-existing tmpfiles policy changed during transaction');
    return;
  }
  if (!existsSync(TMPFILES_CONFIG)) return;
  secureRegularFile(TMPFILES_CONFIG, 'rollback local-inference tmpfiles config', 0o644);
  if (sha256(readFileSync(TMPFILES_CONFIG)) !== before.sourceSha256) {
    fail('refusing to remove a changed tmpfiles policy during rollback');
  }
  unlinkSync(TMPFILES_CONFIG);
  const directory = openSync(dirname(TMPFILES_CONFIG), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function applyLocked(ackPlan) {
  if (process.getuid?.() !== 0) fail('socket transaction apply requires root', 77);
  assertMaintenanceLockHeld();
  const before = await inspect();
  if (ackPlan !== before.ackPlan) fail('owner acknowledgement does not match the current preflight plan', 77);
  ensureReceiptRoot();
  try {
    installTmpfilesPolicy(before.tmpfilesPolicy);
    command(SYSTEMD_TMPFILES, ['--create', TMPFILES_CONFIG], 'local-inference socket directory creation');
    const after = await inspect();
    if (after.directories.some((entry) => entry.state !== 'exact')) fail('socket directories were not created exactly');
    const transactionId = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID()}`;
    const receiptPath = `${RECEIPT_ROOT}/${transactionId}.json`;
    const receipt = {
      schema: 'nexus.local-inference-socket-receipt.v1',
      transactionId,
      status: 'applied',
      ackPlan,
      before: { tmpfilesPolicy: before.tmpfilesPolicy, directories: before.directories },
      after: { tmpfilesPolicy: after.tmpfilesPolicy, directories: after.directories },
      release: after.release,
      model: after.model,
      completedAt: new Date().toISOString(),
    };
    atomicWrite(receiptPath, receipt);
    return { ...receipt, receiptPath, receiptSha256: sha256(readFileSync(receiptPath)) };
  } catch (error) {
    restoreTmpfilesPolicy(before.tmpfilesPolicy);
    restoreNewDirectories(before.directories);
    throw error;
  }
}

function rollbackLocked(receiptPath, acknowledgement) {
  if (process.getuid?.() !== 0) fail('socket transaction rollback requires root', 77);
  assertMaintenanceLockHeld();
  if (!receiptPath.startsWith(`${RECEIPT_ROOT}/`) || resolve(receiptPath) !== receiptPath) {
    fail('rollback receipt path is outside the governed receipt directory', 64);
  }
  secureRegularFile(receiptPath, 'socket transaction receipt', 0o600);
  const receiptBytes = readFileSync(receiptPath);
  if (acknowledgement !== `sha256:${sha256(receiptBytes)}`) fail('rollback acknowledgement does not match the receipt', 77);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt?.schema !== 'nexus.local-inference-socket-receipt.v1' || receipt.status !== 'applied') {
    fail('socket transaction receipt is not rollbackable');
  }
  assertReceiptPolicyScope(receipt.before?.tmpfilesPolicy);
  assertReceiptDirectoryScope(receipt.before?.directories);
  restoreTmpfilesPolicy(receipt.before.tmpfilesPolicy);
  restoreNewDirectories(receipt.before.directories);
  const rollbackPath = `${receiptPath}.rollback.json`;
  atomicWrite(rollbackPath, {
    schema: 'nexus.local-inference-socket-rollback.v1',
    transactionId: receipt.transactionId,
    status: 'restored',
    sourceReceipt: receiptPath,
    completedAt: new Date().toISOString(),
  });
  return { status: 'restored', rollbackPath };
}

function assertReceiptDirectoryScope(entries) {
  const expectedPaths = [SOCKET_ROOT, ...SOCKET_DIRS.map((entry) => entry.path)];
  if (!Array.isArray(entries) || entries.length !== expectedPaths.length
      || entries.some((entry, index) => entry?.path !== expectedPaths[index]
        || (entry.state !== 'absent' && entry.state !== 'exact'))) {
    fail('socket transaction receipt directory scope is invalid');
  }
}

export function resolveSocketRollbackDirectories(before, currentByPath) {
  assertReceiptDirectoryScope(before);
  const created = [...before].filter((entry) => entry.state === 'absent').reverse();
  for (const entry of created) {
    const current = currentByPath[entry.path];
    if (!current?.exists) continue;
    if (current.safeDirectory !== true
        || !Array.isArray(current.entries) || current.entries.length !== 0) {
      fail(`socket directory is not empty; stop gateway containers before rollback: ${entry.path}`, 75);
    }
  }
  return created.filter((entry) => currentByPath[entry.path]?.exists).map((entry) => entry.path);
}

function restoreNewDirectories(before) {
  const currentByPath = Object.fromEntries(before.map((entry) => {
    if (!existsSync(entry.path)) return [entry.path, { exists: false, safeDirectory: false, entries: [] }];
    const stat = lstatSync(entry.path);
    return [entry.path, {
      exists: true,
      safeDirectory: stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(entry.path) === entry.path,
      entries: stat.isDirectory() && !stat.isSymbolicLink() ? readdirSync(entry.path) : [],
    }];
  }));
  for (const directoryPath of resolveSocketRollbackDirectories(before, currentByPath)) {
    rmdirSync(directoryPath);
  }
}

function assertMaintenanceLockHeld() {
  const inheritedFd = Number(process.env.NEXUS_MAINTENANCE_LOCK_FD);
  try {
    const descriptor = fstatSync(inheritedFd);
    const lock = lstatSync(MAINTENANCE_LOCK);
    if (!Number.isSafeInteger(inheritedFd) || inheritedFd < 3
        || descriptor.dev !== lock.dev || descriptor.ino !== lock.ino) {
      fail('shared maintenance lock descriptor is not inherited from the attended transaction', 75);
    }
  } catch {
    fail('shared maintenance lock descriptor is not inherited from the attended transaction', 75);
  }
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
      timeout: 120_000,
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

async function main() {
  const [commandName, ...args] = process.argv.slice(2);
  if (commandName === 'plan' || commandName === 'verify') {
    process.stdout.write(`${JSON.stringify(await inspect(), null, 2)}\n`);
    return;
  }
  if (commandName === 'apply') {
    const index = args.indexOf('--ack-plan');
    if (index < 0 || !/^sha256:[0-9a-f]{64}$/u.test(args[index + 1] || '')) fail('apply requires --ack-plan sha256:<digest>', 64);
    lockedReexec('apply', [args[index + 1]]);
    return;
  }
  if (commandName === '__apply') {
    process.stdout.write(`${JSON.stringify(await applyLocked(args[0]), null, 2)}\n`);
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
  fail('usage: local-inference-socket-transaction.mjs plan|verify|apply --ack-plan <digest>|rollback --receipt <path> --ack-receipt <digest>', 64);
}

if (process.argv[1] && realpathSync(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error?.exitCode || 1);
  });
}
