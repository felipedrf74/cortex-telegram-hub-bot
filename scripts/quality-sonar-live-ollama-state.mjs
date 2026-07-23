#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';

const RETAINED_TAG = 'qwen2.5:3b-instruct-q4_K_M';
const DIGEST_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const EXPECTED = Object.freeze({
  memoryHigh: 4 * 1024 * 1024 * 1024,
  memoryMax: 6 * 1024 * 1024 * 1024,
  allowedSwap: new Set([0, 512 * 1024 * 1024]),
  cpuQuota: 2_000_000,
  environment: Object.freeze({
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_CONTEXT_LENGTH: '4096',
    OLLAMA_MAX_QUEUE: '4',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_MAX_LOADED_MODELS: '1',
  }),
});

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function usage() {
  process.stdout.write(
    'Usage: quality-sonar-live-ollama-state.mjs'
    + ' --cleanup-result <mode-0600.json>'
    + ' --systemd-state <mode-0600.txt>'
    + ' --tags <mode-0600.json>'
    + ' --loaded <mode-0600.json>\n',
  );
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (!['--cleanup-result', '--systemd-state', '--tags', '--loaded'].includes(arg)) {
      fail(`unknown argument: ${arg}`, 64);
    }
    index += 1;
    if (index >= argv.length || argv[index].startsWith('--')) {
      fail(`missing value for ${arg}`, 64);
    }
    options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[index];
  }
  for (const key of ['cleanupResult', 'systemdState', 'tags', 'loaded']) {
    if (!options[key]) fail(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`, 64);
  }
  return options;
}

function readSecureFile(path, label) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') {
    fail(`${label} path must be a safe absolute path`);
  }
  let info;
  try {
    info = lstatSync(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the account running the live verifier`);
  }
  if ((info.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`);
  if (info.size <= 0 || info.size > MAX_FILE_BYTES) fail(`${label} has an invalid size`);
  if (realpathSync(path) !== path) fail(`${label} path must be canonical`);
  return readFileSync(path, 'utf8');
}

function parseJson(path, label) {
  try {
    return JSON.parse(readSecureFile(path, label));
  } catch (error) {
    if (error?.exitCode) throw error;
    fail(`${label} is not valid JSON`);
  }
}

function normalizeDigest(value, label) {
  const match = DIGEST_PATTERN.exec(value || '');
  if (!match) fail(`${label} must be a full lowercase sha256 digest`);
  return `sha256:${match[1]}`;
}

function modelIdentity(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${label} is invalid`);
  const names = [entry.name, entry.model, entry.tag]
    .filter((value) => typeof value === 'string' && value.length > 0);
  if (names.length === 0 || new Set(names).size !== 1) fail(`${label} has a missing or ambiguous tag`);
  return names[0];
}

function validateCleanup(value) {
  if (value?.schema !== 'nexus.ollama-large-model-cleanup-result.v1'
      || value.status !== 'complete'
      || value.host !== 'serverdominguez'
      || value.retainedDigestVerifiedBeforeAndAfter !== true) {
    fail('cleanup result is not a completed ServerDominguez cleanup record');
  }
  const retained = value.plan?.retained;
  if (retained?.tag !== RETAINED_TAG) fail('cleanup result does not retain the approved 3B tag');
  const digest = normalizeDigest(retained.digest, 'cleanup retained digest');
  if (!Array.isArray(value.finalInventory) || value.finalInventory.length !== 1
      || value.finalInventory[0]?.tag !== RETAINED_TAG
      || normalizeDigest(value.finalInventory[0]?.digest, 'cleanup final digest') !== digest) {
    fail('cleanup result final inventory does not match its retained digest');
  }
  return digest;
}

function parseProperties(raw) {
  const properties = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) fail('systemd state contains a malformed property');
    const key = line.slice(0, separator);
    if (properties.has(key)) fail(`systemd state contains duplicate ${key}`);
    properties.set(key, line.slice(separator + 1));
  }
  for (const key of [
    'ActiveState',
    'Environment',
    'MemoryHigh',
    'MemoryMax',
    'MemorySwapMax',
    'CPUQuotaPerSecUSec',
  ]) {
    if (!properties.has(key)) fail(`systemd state omitted ${key}`);
  }
  return properties;
}

function environmentValue(environment, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...environment.matchAll(new RegExp(`(?:^|\\s)"?${escaped}=([^"\\s]+)"?(?=\\s|$)`, 'g'))];
  if (matches.length !== 1) fail(`effective systemd environment must contain exactly one ${name}`);
  return matches[0][1];
}

function exactInteger(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value || '')) fail(`${label} is not an exact byte count`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} is outside the safe integer range`);
  return parsed;
}

function durationToUsec(value) {
  const match = /^(\d+)(us|ms|s|min)?$/.exec(value || '');
  if (!match) fail('CPUQuotaPerSecUSec is not a finite duration');
  const multiplier = { us: 1, ms: 1_000, s: 1_000_000, min: 60_000_000 }[match[2] || 'us'];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result)) fail('CPUQuotaPerSecUSec is outside the safe integer range');
  return result;
}

function validateEnvelope(raw) {
  const properties = parseProperties(raw);
  if (properties.get('ActiveState') !== 'active') fail('ollama.service is not active');
  const environment = properties.get('Environment');
  for (const [name, expected] of Object.entries(EXPECTED.environment)) {
    if (environmentValue(environment, name) !== expected) fail(`effective ${name} must be exactly ${expected}`);
  }
  const observed = {
    memoryHighBytes: exactInteger(properties.get('MemoryHigh'), 'MemoryHigh'),
    memoryMaxBytes: exactInteger(properties.get('MemoryMax'), 'MemoryMax'),
    memorySwapMaxBytes: exactInteger(properties.get('MemorySwapMax'), 'MemorySwapMax'),
    cpuQuotaUsecPerSec: durationToUsec(properties.get('CPUQuotaPerSecUSec')),
  };
  if (observed.memoryHighBytes !== EXPECTED.memoryHigh) fail('effective MemoryHigh must be exactly 4 GiB');
  if (observed.memoryMaxBytes !== EXPECTED.memoryMax) fail('effective MemoryMax must be exactly 6 GiB');
  if (!EXPECTED.allowedSwap.has(observed.memorySwapMaxBytes)) {
    fail('effective MemorySwapMax must be exactly 512 MiB or zero');
  }
  if (observed.cpuQuotaUsecPerSec !== EXPECTED.cpuQuota) fail('effective CPUQuota must be exactly 200%');
  return observed;
}

function validateLiveModels(tags, loaded, retainedDigest) {
  if (!Array.isArray(tags?.models) || tags.models.length !== 1) {
    fail('live Ollama inventory must contain exactly one model');
  }
  const inventory = tags.models[0];
  if (modelIdentity(inventory, 'live inventory model') !== RETAINED_TAG) {
    fail('live Ollama inventory does not contain only the approved 3B tag');
  }
  if (normalizeDigest(inventory.digest, 'live inventory digest') !== retainedDigest) {
    fail('live retained-model digest does not match cleanup evidence');
  }
  if (!Array.isArray(loaded?.models) || loaded.models.length > 1) {
    fail('live Ollama loaded-model state is malformed or exceeds one model');
  }
  for (const entry of loaded.models) {
    if (modelIdentity(entry, 'live loaded model') !== RETAINED_TAG) {
      fail('a non-approved Ollama model is loaded');
    }
    if (entry.digest !== undefined
        && normalizeDigest(entry.digest, 'live loaded digest') !== retainedDigest) {
      fail('loaded retained-model digest does not match cleanup evidence');
    }
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  const cleanup = parseJson(options.cleanupResult, 'cleanup result');
  const retainedDigest = validateCleanup(cleanup);
  const envelope = validateEnvelope(readSecureFile(options.systemdState, 'systemd state'));
  validateLiveModels(
    parseJson(options.tags, 'Ollama tags response'),
    parseJson(options.loaded, 'Ollama loaded response'),
    retainedDigest,
  );
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.sonarqube-live-ollama-state.v1',
    status: 'passed',
    retained: { tag: RETAINED_TAG, digest: retainedDigest },
    envelope,
  })}\n`);
} catch (error) {
  process.stderr.write(`sonar_live_ollama_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
