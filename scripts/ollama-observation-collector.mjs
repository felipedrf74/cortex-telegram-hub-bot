#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OLLAMA_COLLECTOR_REQUEST_SCHEMA,
  OLLAMA_COLLECTOR_RESULT_SCHEMA,
  OLLAMA_COLLECTOR_SAMPLE_SCHEMA,
  OLLAMA_DELETE_TAGS,
  OLLAMA_DIGEST_PATTERN,
  OLLAMA_RETAINED_TAG,
  readSecureJsonEvidence,
  validateOllamaObservationEvidence,
} from './ollama-soak-evidence.mjs';

const EXPECTED_HOST = 'serverdominguez';
const OBSERVATION_ROOT = '/var/lib/nexus-release/ollama-observations';
const INSTALLED_EXECUTABLE = '/usr/local/sbin/nexus-ollama-observation-collector.mjs';
const SERVERDOMINGUEZ_PM2 = '/home/dominguez/.npm-global/bin/pm2';
const RELEASE_LOCK_DIRECTORIES = Object.freeze([
  '/home/dominguez/telegram-hub-bot/.local/release/locks/prod-deploy.lock',
  '/home/dominguez/telegram-hub-bot-staging/.local/release/locks/staging-deploy.lock',
]);
const REBOOT_REQUIRED_PATH = '/var/run/reboot-required';
const DATABASES = Object.freeze({
  staging: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
  production: '/home/dominguez/telegram-hub-bot/data/bot.db',
  zero_swap: '/home/dominguez/telegram-hub-bot/data/bot.db',
});
const PORTS = Object.freeze({
  staging: { backend: 8201, content: 8101 },
  production: { backend: 8200, content: 8100 },
  zero_swap: { backend: 8200, content: 8100 },
});
const PM2_NAMES = Object.freeze({
  staging: ['content-engine-staging', 'nexus-hub-staging'],
  production: ['content-engine', 'nexus-hub'],
  zero_swap: ['content-engine', 'nexus-hub'],
});
const REQUIRED_API_USAGE_COLUMNS = Object.freeze([
  'id', 'ts', 'provider', 'model', 'pricing_status', 'local_request_units',
]);
const DURATION_SECONDS = 24 * 60 * 60;
const INTERVAL_SECONDS = 300;
const MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const PYTHON_QUERY = String.raw`
import json
import sqlite3
import sys
import urllib.parse

path, started_at, completed_at = sys.argv[1:4]
uri = "file:" + urllib.parse.quote(path, safe="/") + "?mode=ro"
connection = sqlite3.connect(uri, uri=True, timeout=5)
try:
    connection.execute("PRAGMA query_only = ON")
    quick = [row[0] for row in connection.execute("PRAGMA quick_check")]
    columns = [row[1] for row in connection.execute("PRAGMA table_info(api_usage)")]
    required = ["id", "ts", "provider", "model", "pricing_status", "local_request_units"]
    if any(column not in columns for column in required):
        raise RuntimeError("api_usage is missing required provenance columns")
    rows = [
        {
            "provider": row[0],
            "model": row[1],
            "requests": row[2],
            "localRequestUnits": row[3],
        }
        for row in connection.execute(
            """
            SELECT provider, model, COUNT(*), COALESCE(SUM(local_request_units), 0)
              FROM api_usage
             WHERE provider = 'ollama'
               AND julianday(ts) >= julianday(?)
               AND julianday(ts) <= julianday(?)
             GROUP BY provider, model
             ORDER BY model COLLATE BINARY
            """,
            (started_at, completed_at),
        )
    ]
    invalid = connection.execute(
        """
        SELECT COUNT(*)
          FROM api_usage
         WHERE provider = 'ollama'
           AND (
             julianday(ts) IS NULL
             OR (
               julianday(ts) >= julianday(?)
               AND julianday(ts) <= julianday(?)
               AND (
                 model IS NULL
                 OR trim(model) = ''
                 OR typeof(local_request_units) != 'integer'
                 OR local_request_units != 1
                 OR pricing_status IS NULL
                 OR pricing_status != 'zero-cost'
               )
             )
           )
        """,
        (started_at, completed_at),
    ).fetchone()[0]
    print(json.dumps({
        "quickCheck": quick,
        "columns": required,
        "invalidPersistenceRows": invalid,
        "rows": rows,
    }, separators=(",", ":")))
finally:
    connection.close()
`;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function testMode() {
  return process.env.NEXUS_OLLAMA_COLLECTOR_TEST_MODE === '1';
}

function usage() {
  process.stdout.write(`Usage:
  sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \\
    --phase staging --output-directory ${OBSERVATION_ROOT} \\
    --expected-runtime-sha <40-hex> --control-request-id <uuid> \\
    --control-request-sha256 <sha256:...>
  sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \\
    --phase production --output-directory ${OBSERVATION_ROOT} \\
    --previous-observation <staging-result.json>
  sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \\
    --phase zero_swap --output-directory ${OBSERVATION_ROOT} \\
    --cleanup-result <cleanup-result.json>

The collector is a foreground, root-owned, one-shot command. It samples
sequentially for 24 hours on one boot and never starts a daemon or a release.
`);
}

function parseArgs(argv) {
  const options = {
    durationSeconds: DURATION_SECONDS,
    intervalSeconds: INTERVAL_SECONDS,
    outputDirectory: OBSERVATION_ROOT,
    ollamaUrl: 'http://127.0.0.1:11434',
    systemctlBin: '/usr/bin/systemctl',
    runuserBin: '/usr/sbin/runuser',
    pm2Bin: SERVERDOMINGUEZ_PM2,
    journalctlBin: '/usr/bin/journalctl',
    pythonBin: '/usr/bin/python3',
    procRoot: '/proc',
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    const field = {
      '--phase': 'phase',
      '--output-directory': 'outputDirectory',
      '--previous-observation': 'previousObservation',
      '--cleanup-result': 'cleanupResult',
      '--duration-seconds': 'durationSeconds',
      '--interval-seconds': 'intervalSeconds',
      '--database': 'database',
      '--ollama-url': 'ollamaUrl',
      '--backend-url': 'backendUrl',
      '--content-url': 'contentUrl',
      '--systemctl-bin': 'systemctlBin',
      '--runuser-bin': 'runuserBin',
      '--pm2-bin': 'pm2Bin',
      '--journalctl-bin': 'journalctlBin',
      '--python-bin': 'pythonBin',
      '--proc-root': 'procRoot',
      '--expected-runtime-sha': 'expectedRuntimeSha',
      '--control-request-id': 'controlRequestId',
      '--control-request-sha256': 'controlRequestSha256',
    }[arg];
    if (!field || seen.has(field)) fail(`unknown or repeated argument: ${arg}`, 64);
    index += 1;
    if (index >= argv.length || argv[index].startsWith('--')) fail(`missing value for ${arg}`, 64);
    options[field] = ['durationSeconds', 'intervalSeconds'].includes(field)
      ? Number(argv[index])
      : argv[index];
    seen.add(field);
  }
  if (!['staging', 'production', 'zero_swap'].includes(options.phase)) {
    fail('--phase must be staging, production, or zero_swap', 64);
  }
  if (options.phase === 'production' && !options.previousObservation) {
    fail('--previous-observation is required for production', 64);
  }
  if (options.phase !== 'production' && options.previousObservation) {
    fail('--previous-observation is production-only', 64);
  }
  if (options.phase === 'zero_swap' && !options.cleanupResult) {
    fail('--cleanup-result is required for zero_swap', 64);
  }
  if (options.phase !== 'zero_swap' && options.cleanupResult) {
    fail('--cleanup-result is zero_swap-only', 64);
  }
  if (!/^[0-9a-f]{40}$/u.test(options.expectedRuntimeSha || '')) {
    fail('--expected-runtime-sha must be an exact 40-hex SHA', 64);
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    .test(options.controlRequestId || '')) {
    fail('--control-request-id must be a lowercase UUID', 64);
  }
  if (!OLLAMA_DIGEST_PATTERN.test(options.controlRequestSha256 || '')) {
    fail('--control-request-sha256 must be an exact sha256 digest', 64);
  }

  const testOnlyChanged = options.durationSeconds !== DURATION_SECONDS
    || options.intervalSeconds !== INTERVAL_SECONDS
    || options.database !== undefined
    || options.ollamaUrl !== 'http://127.0.0.1:11434'
    || options.backendUrl !== undefined
    || options.contentUrl !== undefined
    || options.systemctlBin !== '/usr/bin/systemctl'
    || options.runuserBin !== '/usr/sbin/runuser'
    || options.pm2Bin !== SERVERDOMINGUEZ_PM2
    || options.journalctlBin !== '/usr/bin/journalctl'
    || options.pythonBin !== '/usr/bin/python3'
    || options.procRoot !== '/proc';
  if (!testMode() && testOnlyChanged) fail('collector runtime overrides are test-only', 64);
  if (!testMode() && options.outputDirectory !== OBSERVATION_ROOT) {
    fail(`production observations must be written under ${OBSERVATION_ROOT}`, 64);
  }
  if (!Number.isSafeInteger(options.durationSeconds) || options.durationSeconds < 1
      || options.durationSeconds > DURATION_SECONDS
      || !Number.isSafeInteger(options.intervalSeconds) || options.intervalSeconds < 1
      || options.intervalSeconds > options.durationSeconds
      || options.durationSeconds % options.intervalSeconds !== 0
      || options.durationSeconds / options.intervalSeconds + 1 > 400) {
    fail('duration and interval must be bounded positive integers with an exact cadence', 64);
  }
  for (const field of ['outputDirectory', 'systemctlBin', 'runuserBin', 'pm2Bin', 'journalctlBin', 'pythonBin', 'procRoot']) {
    if (!isAbsolute(options[field] || '') || resolve(options[field]) !== options[field]) {
      fail(`${field} must be a canonical absolute path`, 64);
    }
  }
  options.database ||= DATABASES[options.phase];
  if (!isAbsolute(options.database) || resolve(options.database) !== options.database) {
    fail('database must be a canonical absolute path', 64);
  }
  if (!testMode() && options.database !== DATABASES[options.phase]) {
    fail('database override is test-only', 64);
  }
  const ports = PORTS[options.phase];
  options.backendUrl ||= `http://127.0.0.1:${ports.backend}/health`;
  options.contentUrl ||= `http://127.0.0.1:${ports.content}/health`;
  options.ollamaUrl = loopbackOrigin(options.ollamaUrl, '--ollama-url');
  options.backendUrl = loopbackHealthUrl(options.backendUrl, '--backend-url');
  options.contentUrl = loopbackHealthUrl(options.contentUrl, '--content-url');
  options.controlRequest = {
    requestId: options.controlRequestId,
    requestSha256: options.controlRequestSha256,
    runtimeSha: options.expectedRuntimeSha,
  };
  return options;
}

function loopbackOrigin(raw, label) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail(`${label} must be a valid URL`, 64); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    fail(`${label} must be an unauthenticated loopback HTTP origin`, 64);
  }
  return parsed.origin;
}

function loopbackHealthUrl(raw, label) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail(`${label} must be a valid URL`, 64); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/health') {
    fail(`${label} must be an unauthenticated loopback /health URL`, 64);
  }
  return parsed.toString();
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function secureDirectory(path, label, { create = false } = {}) {
  if (!isAbsolute(path) || path === '/' || resolve(path) !== path) fail(`${label} path is unsafe`);
  if (create) mkdirSync(path, { mode: 0o700 });
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path must not contain symlinks`);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a non-symlink directory`);
  const expectedUid = testMode() ? process.getuid?.() : 0;
  if (typeof expectedUid === 'number' && info.uid !== expectedUid) fail(`${label} has the wrong owner`);
  if ((info.mode & 0o777) !== 0o700) fail(`${label} must have mode 0700`);
  return path;
}

function secureRegularFile(path, label) {
  const canonical = realpathSync.native(path);
  if (canonical !== path) fail(`${label} path must not contain symlinks`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  return info;
}

function writeProtectedJson(path, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, bytes, digest: sha256(bytes) };
}

function command(options, executable, args, label, { acceptStatusOne = false } = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: MAX_COMMAND_BYTES,
  });
  if (result.error || result.signal || (result.status !== 0 && !(acceptStatusOne && result.status === 1))) {
    fail(`${label} failed`);
  }
  if (Buffer.byteLength(result.stdout || '', 'utf8') > MAX_COMMAND_BYTES) fail(`${label} output is too large`);
  return result.stdout || '';
}

function parseSystemdShow(stdout) {
  const properties = new Map();
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) fail('systemctl show returned a malformed property');
    const key = line.slice(0, separator);
    if (properties.has(key)) fail(`systemctl show returned duplicate ${key}`);
    properties.set(key, line.slice(separator + 1));
  }
  const required = [
    'ActiveState', 'NRestarts', 'Environment', 'MemoryHigh', 'MemoryMax',
    'MemorySwapMax', 'CPUQuotaPerSecUSec',
  ];
  for (const key of required) if (!properties.has(key)) fail(`systemctl show omitted ${key}`);
  const env = properties.get('Environment');
  const environmentValue = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const matches = [...env.matchAll(new RegExp(`(?:^|\\s)"?${escaped}=([^"\\s]+)"?(?=\\s|$)`, 'gu'))];
    if (matches.length !== 1) fail(`effective Ollama service must contain exactly one ${name}`);
    return matches[0][1];
  };
  const integer = (name) => {
    const raw = properties.get(name);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) fail(`${name} is not an exact non-negative integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) fail(`${name} is outside the safe integer range`);
    return value;
  };
  const quota = properties.get('CPUQuotaPerSecUSec');
  const quotaMatch = /^(\d+)(us|ms|s|min)?$/u.exec(quota);
  if (!quotaMatch) fail('CPUQuotaPerSecUSec is invalid');
  const multiplier = { us: 1, ms: 1_000, s: 1_000_000, min: 60_000_000 }[quotaMatch[2] || 'us'];
  return {
    activeState: properties.get('ActiveState'),
    restartCount: integer('NRestarts'),
    envelope: {
      contextLength: Number(environmentValue('OLLAMA_CONTEXT_LENGTH')),
      maxQueue: Number(environmentValue('OLLAMA_MAX_QUEUE')),
      numParallel: Number(environmentValue('OLLAMA_NUM_PARALLEL')),
      maxLoadedModels: Number(environmentValue('OLLAMA_MAX_LOADED_MODELS')),
      memoryHighBytes: integer('MemoryHigh'),
      memoryMaxBytes: integer('MemoryMax'),
      memorySwapMaxBytes: integer('MemorySwapMax'),
      cpuQuotaUsecPerSec: Number(quotaMatch[1]) * multiplier,
    },
  };
}

function readService(options) {
  const stdout = command(options, options.systemctlBin, [
    'show', 'ollama.service', '--no-pager',
    '--property=ActiveState', '--property=NRestarts', '--property=Environment',
    '--property=MemoryHigh', '--property=MemoryMax', '--property=MemorySwapMax',
    '--property=CPUQuotaPerSecUSec',
  ], 'systemctl Ollama state');
  return parseSystemdShow(stdout);
}

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) fail(`${label} returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_COMMAND_BYTES) fail(`${label} response is too large`);
    try { return JSON.parse(text); } catch { fail(`${label} did not return JSON`); }
  } catch (error) {
    if (error?.exitCode) throw error;
    fail(`${label} is unavailable`);
  } finally {
    clearTimeout(timeout);
  }
}

function modelTag(entry, label) {
  const names = [entry?.name, entry?.model].filter((value) => typeof value === 'string' && value.length > 0);
  if (names.length < 1 || new Set(names).size !== 1) fail(`${label} model identity is missing or ambiguous`);
  return names[0];
}

function modelDigest(value, label) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)) return `sha256:${value}`;
  if (!OLLAMA_DIGEST_PATTERN.test(value || '')) fail(`${label} digest is not a full lowercase sha256`);
  return value;
}

async function readOllama(options) {
  const tags = await fetchJson(`${options.ollamaUrl}/api/tags`, 'Ollama inventory');
  const loaded = await fetchJson(`${options.ollamaUrl}/api/ps`, 'Ollama loaded-model state');
  if (!Array.isArray(tags?.models) || !Array.isArray(loaded?.models)) fail('Ollama responses are malformed');
  const inventory = tags.models.map((entry, index) => ({
    tag: modelTag(entry, `inventory[${index}]`),
    digest: modelDigest(entry.digest, `inventory[${index}]`),
  })).sort((left, right) => left.tag.localeCompare(right.tag));
  const loadedTags = loaded.models.map((entry, index) => modelTag(entry, `loaded[${index}]`)).sort();
  if (new Set(inventory.map((entry) => entry.tag)).size !== inventory.length
      || new Set(loadedTags).size !== loadedTags.length) fail('Ollama returned duplicate model identities');
  return { healthy: true, inventory, loaded: loadedTags };
}

async function readApplicationHealth(options) {
  const backend = await fetchJson(options.backendUrl, 'Nexus Hub health');
  if (backend?.status !== 'healthy' || backend?.server?.status !== 'online'
      || backend?.server?.database !== 'connected' || backend?.database !== 'connected') {
    fail('Nexus Hub health did not prove online service and connected database');
  }
  const content = await fetchJson(options.contentUrl, 'content-engine health');
  if (content?.status !== 'ok') fail('content-engine health did not report ok');
  return { backendHealthy: true, contentHealthy: true };
}

function readPm2(options) {
  const stdout = testMode()
    ? command(options, options.pm2Bin, ['jlist'], 'PM2 state')
    : command(options, options.runuserBin, ['-u', 'dominguez', '--', options.pm2Bin, 'jlist'], 'PM2 state');
  let rows;
  try { rows = JSON.parse(stdout); } catch { fail('PM2 jlist did not return JSON'); }
  if (!Array.isArray(rows)) fail('PM2 jlist did not return an array');
  return PM2_NAMES[options.phase].map((name) => {
    const matches = rows.filter((row) => row?.name === name);
    if (matches.length !== 1) fail(`PM2 state must contain exactly one ${name}`);
    const env = matches[0].pm2_env || {};
    const releaseSha = env.NEXUS_RELEASE_SHA || env.GIT_COMMIT;
    const restartCount = env.restart_time;
    if (env.status !== 'online' || !Number.isSafeInteger(restartCount) || restartCount < 0
        || !/^[a-f0-9]{40}$/u.test(releaseSha || '')) fail(`PM2 state for ${name} is unhealthy or lacks exact release identity`);
    return { name, status: env.status, restartCount, releaseSha };
  });
}

function readProc(path, label, maximum = 1024 * 1024) {
  const file = readFileSync(path, 'utf8');
  if (Buffer.byteLength(file, 'utf8') > maximum) fail(`${label} is unexpectedly large`);
  return file;
}

function exactCounter(raw, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) fail(`${label} is not an exact counter`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`${label} is outside the safe integer range`);
  return value;
}

function readBootId(options) {
  const value = readProc(join(options.procRoot, 'sys/kernel/random/boot_id'), 'boot ID', 128).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    fail('kernel boot ID is malformed');
  }
  return value;
}

function readMonotonic(options) {
  const raw = readProc(join(options.procRoot, 'uptime'), 'kernel uptime', 128).trim().split(/\s+/u)[0];
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) fail('kernel uptime is malformed');
  const value = Math.floor(Number(raw));
  if (!Number.isSafeInteger(value) || value < 0) fail('kernel uptime is outside the safe integer range');
  return value;
}

function readHost(options) {
  const loadFields = readProc(join(options.procRoot, 'loadavg'), 'load average', 256).trim().split(/\s+/u);
  const load15 = Number(loadFields[2]);
  if (!Number.isFinite(load15) || load15 < 0) fail('15-minute load average is invalid');
  const mem = readProc(join(options.procRoot, 'meminfo'), 'memory info');
  const memMatch = /^MemAvailable:\s+(\d+) kB$/mu.exec(mem);
  if (!memMatch) fail('MemAvailable is unavailable');
  const vmstat = new Map(readProc(join(options.procRoot, 'vmstat'), 'VM counters')
    .trim().split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)));
  const pressure = readProc(join(options.procRoot, 'pressure/memory'), 'memory pressure', 1024);
  const full = /^full\s+.*\btotal=(\d+)$/mu.exec(pressure);
  if (!full) fail('full memory-pressure counter is unavailable');
  const journal = command(options, options.journalctlBin, [
    '-k', '-b', '--no-pager', '-o', 'cat',
    '--grep=(?:oom-kill|Out of memory|Killed process)',
  ], 'kernel OOM journal', { acceptStatusOne: true });
  const oomEvents = journal.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
  return {
    load15Milli: Math.round(load15 * 1000),
    memAvailableKiB: exactCounter(memMatch[1], 'MemAvailable'),
    swapInPages: exactCounter(vmstat.get('pswpin') || '', 'pswpin'),
    swapOutPages: exactCounter(vmstat.get('pswpout') || '', 'pswpout'),
    memoryPressureTotalMicros: exactCounter(full[1], 'memory pressure total'),
    kernelOomEventsSinceBoot: oomEvents,
  };
}

function assertNoRelease(options) {
  if (testMode()) return;
  for (const path of RELEASE_LOCK_DIRECTORIES) {
    try {
      const info = lstatSync(path);
      if (info.isDirectory()) fail(`release lock became active during ${options.phase} observation`);
      fail('release lock path exists in an unexpected form');
    } catch (error) {
      if (error?.exitCode) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  try {
    const info = lstatSync(REBOOT_REQUIRED_PATH);
    if (info.isSymbolicLink()) fail('pending-reboot marker is a symlink');
    fail(`host restart is pending at ${REBOOT_REQUIRED_PATH}`);
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function captureSample(options, identity, sequence, previousSampleSha256) {
  assertNoRelease(options);
  if (readBootId(options) !== identity.bootId) fail('host rebooted during the observation');
  const monotonicSeconds = readMonotonic(options);
  const ollama = await readOllama(options);
  const applicationHealth = await readApplicationHealth(options);
  const pm2 = readPm2(options);
  const service = readService(options);
  const host = readHost(options);
  return {
    schema: OLLAMA_COLLECTOR_SAMPLE_SCHEMA,
    runId: identity.runId,
    phase: options.phase,
    sequence,
    capturedAt: new Date().toISOString(),
    bootId: identity.bootId,
    monotonicSeconds,
    previousSampleSha256,
    controlRequest: identity.controlRequest,
    ollama,
    application: { ...applicationHealth, pm2 },
    service,
    host,
  };
}

function assertSamplePolicy(options, sample, baseline) {
  const expectedTags = options.phase === 'zero_swap'
    ? [OLLAMA_RETAINED_TAG]
    : [OLLAMA_RETAINED_TAG, ...OLLAMA_DELETE_TAGS].sort();
  if (JSON.stringify(sample.ollama.inventory.map((entry) => entry.tag)) !== JSON.stringify(expectedTags)) {
    fail(`${options.phase} inventory is not the exact governed model set`);
  }
  if (sample.ollama.loaded.some((tag) => tag !== OLLAMA_RETAINED_TAG)
      || sample.ollama.loaded.length > 1) {
    fail('an unapproved or excess Ollama model is loaded');
  }
  if (sample.application.pm2.some(
    (row) => row.releaseSha !== options.controlRequest.runtimeSha,
  )) {
    fail('every PM2 sample must equal the requested exact runtime SHA');
  }
  const envelope = sample.service.envelope;
  if (sample.service.activeState !== 'active'
      || envelope.contextLength !== 4096
      || envelope.maxQueue !== 4
      || envelope.numParallel !== 1
      || envelope.maxLoadedModels !== 1
      || envelope.memoryHighBytes !== 4 * 1024 * 1024 * 1024
      || envelope.memoryMaxBytes !== 6 * 1024 * 1024 * 1024
      || envelope.memorySwapMaxBytes !== 512 * 1024 * 1024
      || envelope.cpuQuotaUsecPerSec !== 2_000_000) {
    fail('Ollama systemd state does not match the fixed pre-transition envelope');
  }
  if (sample.host.load15Milli >= 6000 || sample.host.memAvailableKiB < 12 * 1024 * 1024) {
    fail('host load or available-memory headroom is unsafe');
  }
  const counters = {
    inventory: sample.ollama.inventory,
    serviceRestart: sample.service.restartCount,
    pm2: sample.application.pm2.map((row) => `${row.name}:${row.restartCount}:${row.releaseSha}`),
    swapIn: sample.host.swapInPages,
    swapOut: sample.host.swapOutPages,
    memoryPressure: sample.host.memoryPressureTotalMicros,
    oom: sample.host.kernelOomEventsSinceBoot,
  };
  if (baseline && JSON.stringify(counters) !== JSON.stringify(baseline)) {
    fail('restart, release identity, model identity, swap, pressure, or OOM state changed during the observation');
  }
  return counters;
}

function readRequestRows(options, identity, first, last, lastSampleSha256) {
  secureRegularFile(options.database, 'api_usage database');
  const stdout = command(options, options.pythonBin, [
    '-c', PYTHON_QUERY, options.database, first.capturedAt, last.capturedAt,
  ], 'read-only api_usage request query');
  let query;
  try { query = JSON.parse(stdout); } catch { fail('api_usage request query returned malformed JSON'); }
  if (JSON.stringify(query.quickCheck) !== JSON.stringify(['ok'])
      || JSON.stringify(query.columns) !== JSON.stringify(REQUIRED_API_USAGE_COLUMNS)
      || !Number.isSafeInteger(query.invalidPersistenceRows) || query.invalidPersistenceRows !== 0
      || !Array.isArray(query.rows) || query.rows.length > 64) {
    fail('api_usage did not satisfy the fail-closed request-persistence contract');
  }
  let total = 0; let retainedModel = 0; let largeModels = 0; let otherModels = 0;
  let previousModel = null;
  for (const row of query.rows) {
    if (row?.provider !== 'ollama' || typeof row.model !== 'string' || row.model.length < 1
        || (previousModel !== null && previousModel.localeCompare(row.model) >= 0)
        || !Number.isSafeInteger(row.requests) || row.requests < 0
        || !Number.isSafeInteger(row.localRequestUnits) || row.localRequestUnits !== row.requests) {
      fail('api_usage aggregate rows are ambiguous or not metered one-for-one');
    }
    previousModel = row.model;
    total += row.requests;
    if (row.model === OLLAMA_RETAINED_TAG) retainedModel += row.requests;
    else if (OLLAMA_DELETE_TAGS.includes(row.model)) largeModels += row.requests;
    else otherModels += row.requests;
  }
  if (largeModels !== 0 || otherModels !== 0 || total !== retainedModel) {
    fail('api_usage proves a large-model or unapproved-model request during the observation');
  }
  return {
    schema: OLLAMA_COLLECTOR_REQUEST_SCHEMA,
    runId: identity.runId,
    phase: options.phase,
    host: EXPECTED_HOST,
    bootId: identity.bootId,
    startedAt: first.capturedAt,
    completedAt: last.capturedAt,
    collectorSourceSha256: identity.sourceSha256,
    lastSampleSha256,
    controlRequest: identity.controlRequest,
    database: {
      path: options.database,
      columns: query.columns,
      quickCheck: 'ok',
      invalidPersistenceRows: query.invalidPersistenceRows,
    },
    rows: query.rows,
    totals: { total, retainedModel, largeModels, otherModels },
  };
}

function validateCleanupSubject(file) {
  const value = file.value;
  if (value?.schema !== 'nexus.ollama-large-model-cleanup-result.v1' || value.status !== 'complete'
      || value.host !== EXPECTED_HOST || value.retainedDigestVerifiedBeforeAndAfter !== true
      || !Array.isArray(value.finalInventory) || value.finalInventory.length !== 1
      || value.finalInventory[0]?.tag !== OLLAMA_RETAINED_TAG
      || !OLLAMA_DIGEST_PATTERN.test(value.finalInventory[0]?.digest || '')) {
    fail('zero-swap subject is not a complete, exact small-model cleanup result');
  }
  const observationControl = value.plan?.observationControl;
  const production = observationControl?.production;
  if (!observationControl || Object.keys(observationControl).sort().join(',') !== 'production,staging'
      || !production
      || Object.keys(production).sort().join(',') !== 'requestId,requestSha256,runtimeSha'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
        .test(production.requestId || '')
      || !OLLAMA_DIGEST_PATTERN.test(production.requestSha256 || '')
      || !/^[0-9a-f]{40}$/u.test(production.runtimeSha || '')) {
    fail('zero-swap subject lacks exact production observation control identity');
  }
  return { retained: value.finalInventory[0], previousControlRequest: production };
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function run(options) {
  if (!testMode() && (typeof process.getuid !== 'function' || process.getuid() !== 0)) {
    fail('collector must execute as root', 77);
  }
  const executablePath = realpathSync.native(fileURLToPath(import.meta.url));
  if (!testMode() && executablePath !== INSTALLED_EXECUTABLE) {
    fail(`collector must execute from ${INSTALLED_EXECUTABLE}`, 77);
  }
  const sourceInfo = secureRegularFile(executablePath, 'collector executable');
  if (!testMode() && (sourceInfo.uid !== 0 || (sourceInfo.mode & 0o777) !== 0o700)) {
    fail('installed collector executable must be root-owned mode 0700', 77);
  }
  if (testMode() && (sourceInfo.mode & 0o022) !== 0) fail('test collector source is writable by another account');
  const sourceSha256 = sha256(readFileSync(executablePath));

  secureDirectory(options.outputDirectory, 'observation output root');
  if (!testMode() && hostname().toLowerCase() !== EXPECTED_HOST) {
    fail(`collector is restricted to ${EXPECTED_HOST}`, 77);
  }

  let previousObservation = null;
  let previousControlRequest = null;
  if (options.previousObservation) {
    const previousFile = readSecureJsonEvidence(resolve(options.previousObservation), 'staging collector result');
    const validatedPrevious = validateOllamaObservationEvidence(previousFile, {
      expectedHost: EXPECTED_HOST,
      expectedPhase: 'staging',
      minimumDurationSeconds: options.durationSeconds,
    });
    previousObservation = { path: previousFile.path, sha256: previousFile.digest };
    previousControlRequest = validatedPrevious.controlRequest;
  }
  let subject = null; let subjectRetained = null;
  if (options.cleanupResult) {
    const subjectFile = readSecureJsonEvidence(resolve(options.cleanupResult), 'cleanup result');
    const validatedSubject = validateCleanupSubject(subjectFile);
    subjectRetained = validatedSubject.retained;
    previousControlRequest = validatedSubject.previousControlRequest;
    subject = { path: subjectFile.path, sha256: subjectFile.digest };
  }
  if (previousControlRequest
      && previousControlRequest.runtimeSha !== options.controlRequest.runtimeSha) {
    fail('observation runtime SHA differs from its prior control request binding');
  }

  assertNoRelease(options);
  const bootId = readBootId(options);
  const timestamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const runId = `${options.phase}-${timestamp}-${randomBytes(6).toString('hex')}`;
  const runDirectory = join(options.outputDirectory, runId);
  const samplesDirectory = join(runDirectory, 'samples');
  secureDirectory(runDirectory, 'collector run directory', { create: true });
  secureDirectory(samplesDirectory, 'collector samples directory', { create: true });
  const identity = {
    runId,
    bootId,
    sourceSha256,
    controlRequest: options.controlRequest,
  };

  let previousDigest = null; let first = null; let last = null; let firstFile = null; let baseline = null;
  let maximumGapSeconds = 0;
  const sampleCount = (options.durationSeconds / options.intervalSeconds) + 1;
  let candidatePath = null;
  try {
    for (let sequence = 0; sequence < sampleCount; sequence += 1) {
      if (sequence > 0) {
        const target = first.monotonicSeconds + (sequence * options.intervalSeconds);
        while (readMonotonic(options) < target) {
          const remaining = target - readMonotonic(options);
          await waitMilliseconds(Math.min(remaining * 1000, 30_000));
        }
      }
      const sample = await captureSample(options, identity, sequence, previousDigest);
      baseline = assertSamplePolicy(options, sample, baseline);
      if (last) {
        const gap = sample.monotonicSeconds - last.monotonicSeconds;
        if (gap < 1 || gap > options.intervalSeconds + 15) fail('collector missed its bounded sample cadence');
        maximumGapSeconds = Math.max(maximumGapSeconds, gap);
      }
      const file = writeProtectedJson(join(samplesDirectory, `${String(sequence).padStart(6, '0')}.json`), sample);
      first ||= sample;
      firstFile ||= file;
      last = sample;
      previousDigest = file.digest;
    }

    if (sha256(readFileSync(executablePath)) !== sourceSha256) fail('collector executable changed during the observation');
    if (last.monotonicSeconds - first.monotonicSeconds < options.durationSeconds) {
      fail('collector did not cover the requested same-boot monotonic duration');
    }
    const requestValue = readRequestRows(options, identity, first, last, previousDigest);
    const requestFile = writeProtectedJson(join(runDirectory, 'requests.json'), requestValue);
    const inventory = first.ollama.inventory;
    const retained = inventory.find((entry) => entry.tag === OLLAMA_RETAINED_TAG);
    if (!retained || (subjectRetained && retained.digest !== subjectRetained.digest)) {
      fail('retained-model identity does not match the collector subject');
    }
    const result = {
      schema: OLLAMA_COLLECTOR_RESULT_SCHEMA,
      status: 'complete',
      host: EXPECTED_HOST,
      phase: options.phase,
      runId,
      collector: {
        executablePath,
        sourceSha256,
        executionUid: typeof process.getuid === 'function' ? process.getuid() : 0,
      },
      bootId,
      startedAt: first.capturedAt,
      completedAt: last.capturedAt,
      startedMonotonicSeconds: first.monotonicSeconds,
      completedMonotonicSeconds: last.monotonicSeconds,
      sampling: { intervalSeconds: options.intervalSeconds, sampleCount, maximumGapSeconds },
      controlRequest: options.controlRequest,
      previousControlRequest,
      retainedModel: retained,
      inventory,
      samples: {
        directory: samplesDirectory,
        firstSha256: firstFile.digest,
        lastSha256: previousDigest,
      },
      requestEvidence: { path: requestFile.path, sha256: requestFile.digest },
      previousObservation,
      subject,
    };
    candidatePath = join(runDirectory, 'result.candidate.json');
    writeProtectedJson(candidatePath, result);
    const candidateFile = readSecureJsonEvidence(candidatePath, 'collector candidate result');
    validateOllamaObservationEvidence(candidateFile, {
      expectedHost: EXPECTED_HOST,
      expectedPhase: options.phase,
      minimumDurationSeconds: options.durationSeconds,
      expectedSubjectDigest: subject?.sha256 || null,
      expectedSubjectPath: subject?.path || null,
      allowCandidateResult: true,
    });
    unlinkSync(candidatePath);
    candidatePath = null;
    const resultFile = writeProtectedJson(join(runDirectory, 'result.json'), result);
    process.stdout.write(`${JSON.stringify({
      status: 'complete', phase: options.phase, runId, result: resultFile.path, sha256: resultFile.digest,
    })}\n`);
  } catch (error) {
    if (candidatePath) {
      try { unlinkSync(candidatePath); } catch { /* candidate is never authorization evidence */ }
    }
    try {
      writeProtectedJson(join(runDirectory, 'failure.json'), {
        schema: 'nexus.ollama-observation-collector-failure.v1',
        status: 'failed',
        phase: options.phase,
        runId,
        bootId,
        controlRequest: options.controlRequest,
        failedAt: new Date().toISOString(),
        reason: String(error?.message || 'unknown error').slice(0, 512),
      });
    } catch { /* the original failure remains authoritative */ }
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
run(options).catch((error) => {
  process.stderr.write(`ollama_observation_blocked: ${error?.message || 'unknown error'}\n`);
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
});
