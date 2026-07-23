#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const SAMPLE_SCHEMA = 'nexus.sonarqube-app-latency-sample.v1';
const RESULT_SCHEMA = 'nexus.sonarqube-app-latency-comparison.v1';
const DEFAULT_SAMPLES = 50;
const MIN_SAMPLES = 30;
const MAX_REGRESSION_PERCENT = 5;
const MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_COMPARISON_WINDOW_MS = 4 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function usage() {
  process.stdout.write(`Usage:
  quality-sonar-latency-gate.mjs capture --phase <before|after> \\
    --url <loopback-health-url> --runtime-sha <40-hex> --service <name> \\
    --output <private-json> [--samples 50] [--warmup 5] [--timeout-ms 5000]
  quality-sonar-latency-gate.mjs compare --before <private-json> \\
    --after <private-json> --sonar-scan-evidence <SonarAdvisoryScanV1-json> \\
    --output <private-json> [--max-regression-percent 5]
`);
}

function parseArgs(argv) {
  const command = argv.shift();
  if (command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }
  if (!['capture', 'compare'].includes(command)) fail('a valid command is required', 64);
  const options = { command, samples: DEFAULT_SAMPLES, warmup: 5, timeoutMs: 5000, maxRegressionPercent: 5 };
  while (argv.length > 0) {
    const key = argv.shift();
    const value = argv.shift();
    if (!key?.startsWith('--') || !value || value.startsWith('--')) fail(`invalid or missing value for ${key || 'argument'}`, 64);
    const field = {
      '--phase': 'phase',
      '--url': 'url',
      '--runtime-sha': 'runtimeSha',
      '--service': 'service',
      '--output': 'output',
      '--samples': 'samples',
      '--warmup': 'warmup',
      '--timeout-ms': 'timeoutMs',
      '--before': 'before',
      '--after': 'after',
      '--sonar-scan-evidence': 'sonarScanEvidence',
      '--max-regression-percent': 'maxRegressionPercent',
    }[key];
    if (!field) fail(`unknown argument: ${key}`, 64);
    options[field] = ['samples', 'warmup', 'timeoutMs', 'maxRegressionPercent'].includes(field) ? Number(value) : value;
  }
  return options;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`${label} fields are not exact`);
}

function validateOutput(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path === '/') fail('--output must be a safe absolute path', 64);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail('output parent must be a non-symlink directory');
  if (typeof process.getuid === 'function' && parent.uid !== process.getuid()) fail('output parent must be owned by the current account');
  if ((parent.mode & 0o022) !== 0) fail('output parent must not be group- or world-writable');
  try {
    lstatSync(path);
    fail('output already exists; refusing to overwrite rollout evidence');
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return resolve(path);
}

function writeEvidence(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
}

function readEvidence(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${label} path must be absolute`, 64);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a non-symlink file`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) fail(`${label} must be owned by the current account`);
  if ((info.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`);
  if (info.size > 2 * 1024 * 1024) fail(`${label} is unexpectedly large`);
  const raw = readFileSync(path);
  try {
    return { raw, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function normalizeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('latency probe URL is invalid', 64);
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail('latency probes must use a credential-free loopback HTTP URL with an explicit port', 64);
  }
  return parsed.toString();
}

function percentile(samples, percent) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percent * sorted.length) - 1)];
}

function round(value) {
  return Number(value.toFixed(3));
}

function createDigest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function summarize(samples) {
  return {
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    maxMs: round(Math.max(...samples)),
  };
}

async function probe(url, timeoutMs) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.arrayBuffer();
  const elapsed = performance.now() - startedAt;
  if (!response.ok) fail(`application latency probe returned HTTP ${response.status}`);
  if (body.byteLength > 1024 * 1024) fail('application latency probe returned an unexpectedly large body');
  return round(elapsed);
}

async function capture(options) {
  if (!['before', 'after'].includes(options.phase)) fail('--phase must be before or after', 64);
  if (!/^[0-9a-f]{40}$/.test(options.runtimeSha || '')) fail('--runtime-sha must be a full lowercase commit SHA', 64);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(options.service || '')) fail('--service is invalid', 64);
  if (!Number.isInteger(options.samples) || options.samples < MIN_SAMPLES || options.samples > 500) fail(`--samples must be ${MIN_SAMPLES}-500`, 64);
  if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 20) fail('--warmup must be 0-20', 64);
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) fail('--timeout-ms must be 100-30000', 64);
  const url = normalizeUrl(options.url);
  const output = validateOutput(options.output);
  for (let index = 0; index < options.warmup; index += 1) await probe(url, options.timeoutMs);
  const samplesMs = [];
  // Intentionally sequential: this rollout check measures one stable request
  // stream and does not add load-generating concurrency to the production host.
  for (let index = 0; index < options.samples; index += 1) samplesMs.push(await probe(url, options.timeoutMs));
  const evidence = {
    schema: SAMPLE_SCHEMA,
    phase: options.phase,
    runtimeSha: options.runtimeSha,
    service: options.service,
    url,
    sampleCount: samplesMs.length,
    warmupCount: options.warmup,
    timeoutMs: options.timeoutMs,
    ...summarize(samplesMs),
    samplesMs,
    capturedAt: new Date().toISOString(),
  };
  writeEvidence(output, evidence);
  process.stdout.write(`sonar_app_latency_captured phase=${options.phase} p50Ms=${evidence.p50Ms} p95Ms=${evidence.p95Ms} evidence=${output}\n`);
}

function validateSample(value, phase) {
  exactKeys(value, [
    'schema', 'phase', 'runtimeSha', 'service', 'url', 'sampleCount', 'warmupCount', 'timeoutMs',
    'p50Ms', 'p95Ms', 'maxMs', 'samplesMs', 'capturedAt',
  ], `${phase} sample`);
  if (value.schema !== SAMPLE_SCHEMA || value.phase !== phase) fail(`${phase} sample identity is invalid`);
  if (!/^[0-9a-f]{40}$/.test(value.runtimeSha || '') || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.service || '')) fail(`${phase} sample binding is invalid`);
  if (normalizeUrl(value.url) !== value.url) fail(`${phase} sample URL is not canonical`);
  if (!Array.isArray(value.samplesMs) || value.samplesMs.length < MIN_SAMPLES || value.sampleCount !== value.samplesMs.length) fail(`${phase} sample count is insufficient`);
  if (!Number.isSafeInteger(value.warmupCount) || value.warmupCount < 0 || value.warmupCount > 20
      || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30_000) {
    fail(`${phase} sample probe configuration is invalid`);
  }
  if (value.samplesMs.some((sample) => !Number.isFinite(sample) || sample <= 0)) fail(`${phase} latency samples are invalid`);
  const observed = summarize(value.samplesMs);
  for (const field of ['p50Ms', 'p95Ms', 'maxMs']) {
    if (value[field] !== observed[field]) fail(`${phase} ${field} does not match raw samples`);
  }
  const capturedAt = parseTime(value.capturedAt, `${phase} capturedAt`);
  const now = Date.now();
  if (capturedAt > now + CLOCK_SKEW_MS || now - capturedAt > MAX_SAMPLE_AGE_MS) fail(`${phase} latency sample is stale or from the future`);
  return value;
}

function validateScanEvidence(value, runtimeSha, beforeAt, afterAt) {
  exactKeys(value, [
    'schemaVersion', 'advisory', 'releaseGate', 'runtimeSha', 'ceTaskId', 'analysisId',
    'ceStatus', 'qualityGateStatus', 'coverageImported', 'completedAt',
  ], 'Sonar scan evidence');
  if (value.schemaVersion !== 'SonarAdvisoryScanV1'
      || value.advisory !== true
      || value.releaseGate !== false
      || value.runtimeSha !== runtimeSha
      || value.ceStatus !== 'SUCCESS') {
    fail('Sonar scan evidence is not a successful advisory analysis of the measured runtime');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value.ceTaskId || '') || !/^[A-Za-z0-9_-]+$/.test(value.analysisId || '')) {
    fail('Sonar scan task identity is invalid');
  }
  if (typeof value.qualityGateStatus !== 'string' || typeof value.coverageImported !== 'boolean') {
    fail('Sonar scan evidence fields are invalid');
  }
  const completedAt = parseTime(value.completedAt, 'Sonar scan completedAt');
  if (completedAt < beforeAt || completedAt > afterAt) {
    fail('successful Sonar scan must complete between the before and after application samples');
  }
  return value;
}

function parseTime(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is invalid`);
  return parsed;
}

function regression(before, after) {
  return round(((after - before) / before) * 100);
}

function compare(options) {
  if (!Number.isFinite(options.maxRegressionPercent)
      || options.maxRegressionPercent < 0
      || options.maxRegressionPercent > MAX_REGRESSION_PERCENT) {
    fail(`--max-regression-percent cannot exceed ${MAX_REGRESSION_PERCENT}`, 64);
  }
  const output = validateOutput(options.output);
  const beforeFile = readEvidence(options.before || '', 'before latency evidence');
  const afterFile = readEvidence(options.after || '', 'after latency evidence');
  const before = validateSample(beforeFile.value, 'before');
  const after = validateSample(afterFile.value, 'after');
  for (const field of ['runtimeSha', 'service', 'url', 'sampleCount']) {
    if (before[field] !== after[field]) fail(`before/after ${field} does not match`);
  }
  const beforeAt = parseTime(before.capturedAt, 'before capturedAt');
  const afterAt = parseTime(after.capturedAt, 'after capturedAt');
  if (afterAt <= beforeAt || afterAt - beforeAt > MAX_COMPARISON_WINDOW_MS) {
    fail('after sample must be captured after the baseline');
  }
  const scanPath = options.sonarScanEvidence || '';
  const scanFile = readEvidence(scanPath, 'Sonar scan evidence');
  const scan = validateScanEvidence(scanFile.value, before.runtimeSha, beforeAt, afterAt);
  const p50RegressionPercent = regression(before.p50Ms, after.p50Ms);
  const p95RegressionPercent = regression(before.p95Ms, after.p95Ms);
  const passed = p50RegressionPercent <= options.maxRegressionPercent
    && p95RegressionPercent <= options.maxRegressionPercent;
  const evidence = {
    schema: RESULT_SCHEMA,
    status: passed ? 'passed' : 'failed',
    releaseGate: false,
    rolloutGate: true,
    runtimeSha: before.runtimeSha,
    service: before.service,
    url: before.url,
    sampleCount: before.sampleCount,
    maximumRegressionPercent: options.maxRegressionPercent,
    before: { capturedAt: before.capturedAt, p50Ms: before.p50Ms, p95Ms: before.p95Ms, evidenceSha256: createDigest(beforeFile.raw) },
    after: { capturedAt: after.capturedAt, p50Ms: after.p50Ms, p95Ms: after.p95Ms, evidenceSha256: createDigest(afterFile.raw) },
    p50RegressionPercent,
    p95RegressionPercent,
    sonarScan: {
      ceTaskId: scan.ceTaskId,
      analysisId: scan.analysisId,
      completedAt: scan.completedAt,
      evidenceSha256: createDigest(scanFile.raw),
    },
    comparedAt: new Date().toISOString(),
  };
  writeEvidence(output, evidence);
  if (!passed) fail(`application latency regression exceeds ${options.maxRegressionPercent}% (p50=${p50RegressionPercent}%, p95=${p95RegressionPercent}%)`);
  process.stdout.write(`sonar_app_latency_gate_passed p50RegressionPercent=${p50RegressionPercent} p95RegressionPercent=${p95RegressionPercent} evidence=${output}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'capture') await capture(options);
  else compare(options);
} catch (error) {
  process.stderr.write(`sonar_latency_gate_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
