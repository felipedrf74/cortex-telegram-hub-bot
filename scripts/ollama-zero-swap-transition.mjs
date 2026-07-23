#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  OLLAMA_ENVELOPE,
  readAndValidateOllamaEnvelope,
} from './lib/ollama-service-envelope.mjs';
import {
  readSecureJsonEvidence,
  validateOllamaObservationEvidence,
} from './ollama-soak-evidence.mjs';

const CLEANUP_RESULT_SCHEMA = 'nexus.ollama-large-model-cleanup-result.v1';
const RESULT_SCHEMA = 'nexus.ollama-zero-swap-transition-result.v1';
const RETAINED_TAG = 'qwen2.5:3b-instruct-q4_K_M';
const CLEANUP_TARGETS = [
  'gemma2:2b-instruct-q4_K_M',
  'qwen3.6:27b-q4_K_M',
  'qwen3.6:35b-a3b-q4_K_M',
];
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
// `override.conf` is the installer-owned 512 MiB baseline. This filename must
// sort after it in systemd's lexical drop-in merge order.
const PRODUCTION_DROP_IN = '/etc/systemd/system/ollama.service.d/zz-nexus-zero-swap.conf';
const DROP_IN_CONTENT = `[Service]\nMemorySwapMax=0\n`;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function parseArgs(argv) {
  const testMode = process.env.NEXUS_OLLAMA_SYSTEMD_TEST_MODE === '1';
  const options = {
    mode: 'dry-run',
    expectedHost: 'serverdominguez',
    maxEvidenceAgeHours: 24,
    ownerAuthorized: false,
    systemctlBin: 'systemctl',
    dropInPath: PRODUCTION_DROP_IN,
    testMode,
  };
  let explicitMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith('--')) fail(`missing value for ${arg}`, 64);
      return argv[index];
    };
    switch (arg) {
      case '--evidence': options.evidencePath = next(); break;
      case '--cleanup-result': options.cleanupResultPath = next(); break;
      case '--expected-host': options.expectedHost = next(); break;
      case '--max-evidence-age-hours': options.maxEvidenceAgeHours = Number(next()); break;
      case '--ack-plan': options.ackPlan = next(); break;
      case '--result': options.resultPath = next(); break;
      case '--owner-authorized': options.ownerAuthorized = true; break;
      case '--systemctl-bin': options.systemctlBin = next(); break;
      case '--drop-in-path': options.dropInPath = next(); break;
      case '--dry-run':
        if (explicitMode && options.mode !== 'dry-run') fail('--dry-run and --apply are mutually exclusive', 64);
        options.mode = 'dry-run';
        explicitMode = true;
        break;
      case '--apply':
        if (explicitMode && options.mode !== 'apply') fail('--dry-run and --apply are mutually exclusive', 64);
        options.mode = 'apply';
        explicitMode = true;
        break;
      case '--help': case '-h':
        process.stdout.write('Usage: ollama-zero-swap-transition.mjs --evidence <json> --cleanup-result <json> [--dry-run | --apply --owner-authorized --ack-plan <sha256> --result <absolute-path>]\n');
        process.exit(0);
        break;
      default: fail(`unknown argument: ${arg}`, 64);
    }
  }
  if (!options.evidencePath || !options.cleanupResultPath) fail('--evidence and --cleanup-result are required', 64);
  if (!Number.isInteger(options.maxEvidenceAgeHours)
      || options.maxEvidenceAgeHours < 1
      || options.maxEvidenceAgeHours > 72) {
    fail('--max-evidence-age-hours must be an integer from 1 through 72', 64);
  }
  if (!options.expectedHost || /[\r\n]/.test(options.expectedHost)) fail('--expected-host is invalid', 64);
  if (!testMode && (options.systemctlBin !== 'systemctl' || options.dropInPath !== PRODUCTION_DROP_IN)) {
    fail('systemctl and drop-in path overrides are test-only', 64);
  }
  if (!isAbsolute(options.dropInPath)) fail('drop-in path must be absolute', 64);
  if (options.mode === 'dry-run') {
    if (options.ownerAuthorized || options.ackPlan || options.resultPath) fail('authorization arguments are apply-only', 64);
  } else {
    if (!options.ownerAuthorized) fail('--owner-authorized is required for apply', 64);
    if (!DIGEST_PATTERN.test(options.ackPlan || '')) fail('--ack-plan must match a fresh dry-run', 64);
    if (!options.resultPath || !isAbsolute(options.resultPath)) fail('--result must be a new absolute path', 64);
    if (!testMode && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
      fail('apply must run as root', 77);
    }
  }
  return options;
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has missing or unexpected fields`);
  }
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) fail(`${label} is invalid`);
  return millis;
}

function validateCleanupResult(file, expectedHost) {
  const value = file.value;
  assertExactKeys(value, [
    'schema', 'host', 'status', 'startedAt', 'completedAt', 'plan',
    'finalInventory', 'retainedDigestVerifiedBeforeAndAfter',
  ], 'cleanup result');
  if (value.schema !== CLEANUP_RESULT_SCHEMA || value.status !== 'complete') fail('cleanup result must be complete');
  if (value.host !== expectedHost) fail('cleanup result host mismatch');
  const startedAt = timestamp(value.startedAt, 'cleanup result startedAt');
  const completedAt = timestamp(value.completedAt, 'cleanup result completedAt');
  if (completedAt < startedAt) fail('cleanup result completion predates its start');
  if (value.retainedDigestVerifiedBeforeAndAfter !== true) fail('cleanup result did not verify the retained digest');
  if (!Array.isArray(value.finalInventory) || value.finalInventory.length !== 1) fail('cleanup result final inventory is invalid');
  assertExactKeys(value.finalInventory[0], ['tag', 'digest'], 'cleanup result retained model');
  const retained = value.finalInventory[0];
  if (retained.tag !== RETAINED_TAG || !DIGEST_PATTERN.test(retained.digest)) {
    fail('cleanup result retained model is invalid');
  }
  if (!value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)
      || value.plan.schema !== 'nexus.ollama-large-model-cleanup-plan.v1'
      || value.plan.host !== expectedHost
      || !DIGEST_PATTERN.test(value.plan.ackPlan || '')
      || value.plan.retained?.tag !== retained.tag
      || value.plan.retained?.digest !== retained.digest
      || !Array.isArray(value.plan.delete)
      || value.plan.delete.length !== CLEANUP_TARGETS.length
      || value.plan.delete.some((entry, index) => entry?.tag !== CLEANUP_TARGETS[index]
        || !DIGEST_PATTERN.test(entry?.digest || ''))) {
    fail('cleanup result plan is invalid or does not match its retained inventory');
  }
  return { completedAt, retained };
}

function validateEvidence(file, cleanupFile, cleanup, options) {
  const observation = validateOllamaObservationEvidence(file, {
    expectedHost: options.expectedHost,
    expectedPhase: 'zero_swap',
    expectedSubjectDigest: cleanupFile.digest,
    expectedSubjectPath: cleanupFile.path,
    maxEvidenceAgeHours: options.maxEvidenceAgeHours,
  });
  if (observation.startedMs < cleanup.completedAt) {
    fail('zero-swap collector observation must start after cleanup completion');
  }
  if (observation.retained.tag !== cleanup.retained.tag
      || observation.retained.digest !== cleanup.retained.digest) {
    fail('zero-swap collector retained model does not match cleanup result');
  }
  return { generatedAt: observation.completedAt, retained: observation.retained };
}

function dropInParent(path) {
  const parent = dirname(path);
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('drop-in parent must be a non-symlink directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('drop-in parent must be owned by the running account');
  if ((info.mode & 0o022) !== 0) fail('drop-in parent must not be group- or world-writable');
  try {
    lstatSync(path);
    fail('zero-swap drop-in already exists; refusing to overwrite it');
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return parent;
}

function prepareResultPath(path) {
  const parent = dirname(path);
  const info = lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('result parent must be a non-symlink directory');
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('result parent must be owned by the running account');
  if ((info.mode & 0o022) !== 0) fail('result parent must not be group- or world-writable');
  try {
    lstatSync(path);
    fail('result path already exists');
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

function writeResult(path, value, initial = false) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (initial) {
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return;
  }
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents, { mode: 0o600, flag: 'wx' });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function systemctl(options, args) {
  const result = spawnSync(options.systemctlBin, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0 || result.signal) fail(`systemctl ${args[0]} failed`);
}

function makePlan(evidenceFile, cleanupFile, evidence, envelope, options) {
  const core = {
    schema: 'nexus.ollama-zero-swap-transition-plan.v1',
    host: options.expectedHost,
    executionMode: options.testMode ? 'test' : 'production',
    dropInPath: options.dropInPath,
    evidenceDigest: evidenceFile.digest,
    cleanupResultDigest: cleanupFile.digest,
    retained: evidence.retained,
    currentEnvelope: envelope,
    transition: { memorySwapMaxBytes: { from: OLLAMA_ENVELOPE.memorySwapBaselineBytes, to: 0 } },
  };
  return {
    ...core,
    ackPlan: `sha256:${createHash('sha256').update(JSON.stringify(core)).digest('hex')}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidenceFile = readSecureJsonEvidence(resolve(options.evidencePath), 'zero-swap collector evidence');
  const cleanupFile = readSecureJsonEvidence(resolve(options.cleanupResultPath), 'cleanup result');
  const cleanup = validateCleanupResult(cleanupFile, options.expectedHost);
  const evidence = validateEvidence(evidenceFile, cleanupFile, cleanup, options);
  dropInParent(options.dropInPath);
  const baseline = readAndValidateOllamaEnvelope({
    systemctlBin: options.systemctlBin,
    expectedSwapBytes: OLLAMA_ENVELOPE.memorySwapBaselineBytes,
  });
  const plan = makePlan(evidenceFile, cleanupFile, evidence, baseline, options);

  if (options.mode === 'dry-run') {
    process.stdout.write(`${JSON.stringify({ mode: 'dry-run', mutationAttempted: false, ...plan }, null, 2)}\n`);
    return;
  }
  if (options.ackPlan !== plan.ackPlan) fail('acknowledgment does not match the fresh zero-swap plan');
  prepareResultPath(options.resultPath);

  const immediateBaseline = readAndValidateOllamaEnvelope({
    systemctlBin: options.systemctlBin,
    expectedSwapBytes: OLLAMA_ENVELOPE.memorySwapBaselineBytes,
  });
  const immediatePlan = makePlan(evidenceFile, cleanupFile, evidence, immediateBaseline, options);
  if (immediatePlan.ackPlan !== options.ackPlan) fail('effective envelope changed; run a new dry-run');

  const started = {
    schema: RESULT_SCHEMA,
    host: options.expectedHost,
    status: 'started',
    startedAt: new Date().toISOString(),
    completedAt: null,
    plan,
  };
  writeResult(options.resultPath, started, true);

  let dropInCreated = false;
  try {
    writeFileSync(options.dropInPath, DROP_IN_CONTENT, { mode: 0o644, flag: 'wx' });
    chmodSync(options.dropInPath, 0o644);
    dropInCreated = true;
    systemctl(options, ['daemon-reload']);
    systemctl(options, ['restart', 'ollama.service']);
    systemctl(options, ['is-active', '--quiet', 'ollama.service']);
    const finalEnvelope = readAndValidateOllamaEnvelope({
      systemctlBin: options.systemctlBin,
      expectedSwapBytes: 0,
    });
    const complete = {
      ...started,
      status: 'complete',
      completedAt: new Date().toISOString(),
      finalEnvelope,
      rollbackRequired: false,
    };
    writeResult(options.resultPath, complete);
    process.stdout.write(`${JSON.stringify(complete, null, 2)}\n`);
  } catch (transitionError) {
    let rollbackSucceeded = !dropInCreated;
    let rollbackFailure = null;
    if (dropInCreated) {
      try {
        unlinkSync(options.dropInPath);
        systemctl(options, ['daemon-reload']);
        systemctl(options, ['restart', 'ollama.service']);
        systemctl(options, ['is-active', '--quiet', 'ollama.service']);
        readAndValidateOllamaEnvelope({
          systemctlBin: options.systemctlBin,
          expectedSwapBytes: OLLAMA_ENVELOPE.memorySwapBaselineBytes,
        });
        rollbackSucceeded = true;
      } catch {
        rollbackFailure = 'baseline_restore_failed';
      }
    }
    writeResult(options.resultPath, {
      ...started,
      status: 'failed',
      completedAt: new Date().toISOString(),
      failure: 'zero_swap_transition_failed',
      rollbackSucceeded,
      rollbackFailure,
    });
    if (!rollbackSucceeded) fail('zero-swap transition failed and baseline restoration requires owner intervention');
    fail('zero-swap transition failed; the 512 MiB baseline was restored');
  }
}

main().catch((error) => {
  process.stderr.write(`ollama_zero_swap_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
