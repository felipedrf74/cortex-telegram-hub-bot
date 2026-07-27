import { spawnSync } from 'node:child_process';

export const OLLAMA_ENVELOPE = Object.freeze({
  contextLength: '4096',
  maxQueue: '4',
  numParallel: '1',
  maxLoadedModels: '1',
  memoryHighBytes: 4 * 1024 * 1024 * 1024,
  memoryMaxBytes: 6 * 1024 * 1024 * 1024,
  memorySwapBaselineBytes: 512 * 1024 * 1024,
  cpuQuotaUsecPerSec: 2_000_000,
});

const REQUIRED_ENVIRONMENT = Object.freeze({
  OLLAMA_CONTEXT_LENGTH: OLLAMA_ENVELOPE.contextLength,
  OLLAMA_MAX_QUEUE: OLLAMA_ENVELOPE.maxQueue,
  OLLAMA_NUM_PARALLEL: OLLAMA_ENVELOPE.numParallel,
  OLLAMA_MAX_LOADED_MODELS: OLLAMA_ENVELOPE.maxLoadedModels,
});

function fail(message) {
  throw new Error(message);
}

function parseProperties(stdout) {
  const properties = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) fail('systemctl show returned a malformed property line');
    const key = line.slice(0, separator);
    if (properties.has(key)) fail(`systemctl show returned duplicate ${key}`);
    properties.set(key, line.slice(separator + 1));
  }
  for (const key of ['Environment', 'MemoryHigh', 'MemoryMax', 'MemorySwapMax', 'CPUQuotaPerSecUSec']) {
    if (!properties.has(key)) fail(`systemctl show omitted ${key}`);
  }
  return properties;
}

function environmentValue(environment, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...environment.matchAll(new RegExp(`(?:^|\\s)"?${escaped}=([^"\\s]+)"?(?=\\s|$)`, 'g'))];
  if (matches.length !== 1) fail(`effective systemd environment must contain exactly one ${name}`);
  return matches[0][1];
}

function exactNonnegativeInteger(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail(`${label} is not an exact byte count`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail(`${label} is outside the safe integer range`);
  return number;
}

function durationToUsec(value) {
  const match = /^(\d+)(us|ms|s|min)?$/.exec(value);
  if (!match) fail('CPUQuotaPerSecUSec is not a finite duration');
  const amount = Number(match[1]);
  const multiplier = { us: 1, ms: 1_000, s: 1_000_000, min: 60_000_000 }[match[2] || 'us'];
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result)) fail('CPUQuotaPerSecUSec is outside the safe integer range');
  return result;
}

export function parseAndValidateOllamaEnvelope(stdout, expectedSwapBytes) {
  if (![0, OLLAMA_ENVELOPE.memorySwapBaselineBytes].includes(expectedSwapBytes)) {
    fail('expected swap must be either the 512 MiB baseline or zero');
  }
  const properties = parseProperties(stdout);
  const environment = properties.get('Environment');
  for (const [name, expected] of Object.entries(REQUIRED_ENVIRONMENT)) {
    const actual = environmentValue(environment, name);
    if (actual !== expected) fail(`effective ${name} must be exactly ${expected}`);
  }

  const observed = {
    contextLength: Number(OLLAMA_ENVELOPE.contextLength),
    maxQueue: Number(OLLAMA_ENVELOPE.maxQueue),
    numParallel: Number(OLLAMA_ENVELOPE.numParallel),
    maxLoadedModels: Number(OLLAMA_ENVELOPE.maxLoadedModels),
    memoryHighBytes: exactNonnegativeInteger(properties.get('MemoryHigh'), 'MemoryHigh'),
    memoryMaxBytes: exactNonnegativeInteger(properties.get('MemoryMax'), 'MemoryMax'),
    memorySwapMaxBytes: exactNonnegativeInteger(properties.get('MemorySwapMax'), 'MemorySwapMax'),
    cpuQuotaUsecPerSec: durationToUsec(properties.get('CPUQuotaPerSecUSec')),
  };

  if (observed.memoryHighBytes !== OLLAMA_ENVELOPE.memoryHighBytes) fail('effective MemoryHigh must be exactly 4 GiB');
  if (observed.memoryMaxBytes !== OLLAMA_ENVELOPE.memoryMaxBytes) fail('effective MemoryMax must be exactly 6 GiB');
  if (observed.memorySwapMaxBytes !== expectedSwapBytes) {
    fail(`effective MemorySwapMax must be exactly ${expectedSwapBytes} bytes`);
  }
  if (observed.cpuQuotaUsecPerSec !== OLLAMA_ENVELOPE.cpuQuotaUsecPerSec) {
    fail('effective CPUQuota must be exactly 200%');
  }

  return observed;
}

export function readAndValidateOllamaEnvelope({
  systemctlBin = 'systemctl',
  expectedSwapBytes = OLLAMA_ENVELOPE.memorySwapBaselineBytes,
} = {}) {
  const result = spawnSync(systemctlBin, [
    'show',
    'ollama.service',
    '--no-pager',
    '--property=Environment',
    '--property=MemoryHigh',
    '--property=MemoryMax',
    '--property=MemorySwapMax',
    '--property=CPUQuotaPerSecUSec',
  ], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || result.signal) fail('systemctl could not read the effective Ollama envelope');
  return parseAndValidateOllamaEnvelope(result.stdout, expectedSwapBytes);
}
