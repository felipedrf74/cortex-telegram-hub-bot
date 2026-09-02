#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Credential-free production data-key rotation postcheck.
 *
 * Install this tracked script as:
 *   <production-root>/.local/ops/production-data-key-rotation-postcheck.mjs
 * with mode 0700. The owner-only runtime inputs stay outside Git:
 *
 *   production-data-key-rotation-postcheck.config.json (mode 0600)
 *   production-data-key-rotation-alert-evidence.json  (mode 0600)
 *
 * The rotation wrapper launches this process through env -i. No credential,
 * response body, or private value is written to stdout or stderr.
 */

import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const POSTCHECK_CONTRACT_VERSION = 2;
export const EXPECTED_ROTATOR_SHA256 =
  '27ef7e16b77454222fc7f831e72e77728e8e7e11547990012530e9ca49fbc170';

const EDGE_HEALTH_URL = 'https://api.nexushub.me/health';
const PRODUCTION_LOCAL_BASE_URL = 'http://127.0.0.1:8200';
const STAGING_LOCAL_BASE_URL = 'http://127.0.0.1:8201';
const MAX_JSON_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MIN_STABLE_UPTIME_MS = 5_000;
const MAX_ALERT_WINDOW_MS = 15 * 60 * 1000;

const CONFIG_NAME = 'production-data-key-rotation-postcheck.config.json';
const ALERT_EVIDENCE_NAME = 'production-data-key-rotation-alert-evidence.json';
const PHASE_MARKER_RELATIVE = join(
  '.local',
  'rotation-state',
  'production-data-keys.phase.json',
);
const ROTATOR_RELATIVE = join('dist', 'tools', 'rotate-data-encryption-keys.js');

function fail(message) {
  throw new Error(message);
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(value, expected, label) {
  const keys = Object.keys(assertRecord(value, label)).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(`${label} has an invalid schema`);
  }
}

function parseIso(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    fail(`${label} must be an ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(`${label} must be a valid timestamp`);
  return timestamp;
}

function parseJwtPayload(token) {
  if (
    typeof token !== 'string'
    || token.length < 80
    || token.length > 8192
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    fail('ownerIosJwt must be a compact JWT');
  }
  try {
    return assertRecord(
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')),
      'ownerIosJwt payload',
    );
  } catch {
    fail('ownerIosJwt payload is invalid');
  }
}

export function validatePostcheckConfig(config, now = Date.now()) {
  assertExactKeys(config, ['version', 'ownerIosJwt', 'activeTenantId'], 'postcheck config');
  if (config.version !== 1) fail('postcheck config version is unsupported');
  if (!Number.isSafeInteger(config.activeTenantId) || config.activeTenantId <= 0) {
    fail('activeTenantId must be a positive integer');
  }
  const payload = parseJwtPayload(config.ownerIosJwt);
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now + 60_000) {
    fail('ownerIosJwt is expired or too close to expiry');
  }
  return {
    ownerIosJwt: config.ownerIosJwt,
    activeTenantId: config.activeTenantId,
  };
}

export function validatePhaseMarker(
  marker,
  { expectedSha256, expectedBackupDir },
) {
  assertExactKeys(
    marker,
    ['version', 'phase', 'backupDir', 'databasePath', 'expectedRotatorSha256', 'updatedAt'],
    'rotation phase marker',
  );
  if (marker.version !== 1 || marker.phase !== 'runtime_healthy') {
    fail('rotation phase marker is not at runtime_healthy');
  }
  if (marker.expectedRotatorSha256 !== expectedSha256) {
    fail('rotation phase marker artifact digest does not match');
  }
  if (marker.backupDir !== expectedBackupDir) {
    fail('rotation phase marker backup directory does not match');
  }
  if (typeof marker.databasePath !== 'string' || !marker.databasePath.startsWith('/')) {
    fail('rotation phase marker database path is invalid');
  }
  return { updatedAtMs: parseIso(marker.updatedAt, 'rotation phase marker updatedAt') };
}

export function validateAlertEvidence(
  evidence,
  {
    now = Date.now(),
    expectedSha256,
    expectedBackupDir,
    phaseUpdatedAtMs,
  },
) {
  assertExactKeys(
    evidence,
    [
      'version',
      'noNewAlerts',
      'observedAt',
      'expiresAt',
      'expectedRotatorSha256',
      'rotationBackupDir',
    ],
    'alert evidence',
  );
  if (evidence.version !== 1 || evidence.noNewAlerts !== true) {
    fail('alert evidence does not assert noNewAlerts');
  }
  if (evidence.expectedRotatorSha256 !== expectedSha256) {
    fail('alert evidence artifact digest does not match');
  }
  if (evidence.rotationBackupDir !== expectedBackupDir) {
    fail('alert evidence backup directory does not match');
  }
  const observedAt = parseIso(evidence.observedAt, 'alert evidence observedAt');
  const expiresAt = parseIso(evidence.expiresAt, 'alert evidence expiresAt');
  if (observedAt < phaseUpdatedAtMs || observedAt > now + 30_000) {
    fail('alert evidence was not observed after runtime health');
  }
  if (expiresAt <= now || expiresAt <= observedAt) {
    fail('alert evidence is expired');
  }
  if (expiresAt - observedAt > MAX_ALERT_WINDOW_MS) {
    fail('alert evidence validity window is too broad');
  }
  return true;
}

export function validateHealthPayload(payload, label) {
  const value = assertRecord(payload, label);
  if (
    value.status !== 'healthy'
    || value.database !== 'healthy'
    || assertRecord(value.server, `${label}.server`).database !== 'healthy'
  ) {
    fail(`${label} is not healthy`);
  }
  return true;
}

function validateSuccessEnvelope(payload, label) {
  const envelope = assertRecord(payload, label);
  if (envelope.ok !== true) fail(`${label} did not return a success envelope`);
  return assertRecord(envelope.data, `${label}.data`);
}

export function validateAuthenticatedPayloads({
  oauth,
  garmin,
  health,
  finance,
}) {
  const oauthData = validateSuccessEnvelope(oauth, 'OAuth read');
  if (
    !Array.isArray(oauthData.connections)
    || oauthData.connections.length < 1
    || oauthData.count !== oauthData.connections.length
    || oauthData.connections.some(
      (entry) => !entry || typeof entry.provider !== 'string' || entry.provider.length === 0,
    )
  ) {
    fail('OAuth read did not return a connected provider');
  }

  const garminData = validateSuccessEnvelope(garmin, 'Garmin read');
  if (
    garminData.connected !== true
    || garminData.status !== 'active'
    || typeof garminData.email !== 'string'
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(garminData.email)
  ) {
    fail('Garmin read did not return an active decrypted identity');
  }

  // Health data still uses its repository-supported legacy success shape
  // ({ ok: true, types: [...] }) rather than the shared { ok, data } envelope.
  const healthEnvelope = assertRecord(health, 'Health read');
  if (healthEnvelope.ok !== true) fail('Health read did not return a success envelope');
  const healthData = healthEnvelope.data === undefined
    ? healthEnvelope
    : assertRecord(healthEnvelope.data, 'Health read.data');
  if (
    !Array.isArray(healthData.types)
    || healthData.types.length < 1
    || healthData.types.some(
      (entry) => !entry
        || typeof entry.data_type !== 'string'
        || entry.data_type.length === 0
        || typeof entry.latest_date !== 'string'
        || entry.latest_date.length === 0,
    )
  ) {
    fail('Health read did not return an observed data type');
  }

  const financeData = validateSuccessEnvelope(finance, 'Finance read');
  if (
    !Array.isArray(financeData.transactions)
    || financeData.transactions.length < 1
    || financeData.count !== financeData.transactions.length
    || financeData.transactions.some(
      (entry) => !entry || !Number.isFinite(entry.amount),
    )
  ) {
    fail('Finance read did not return a decrypted transaction');
  }
  return true;
}

export function validatePm2Processes(processes, now = Date.now()) {
  if (!Array.isArray(processes)) fail('PM2 process list must be an array');
  for (const name of ['nexus-hub', 'content-engine']) {
    const matches = processes.filter((entry) => entry?.name === name);
    if (matches.length !== 1) fail(`PM2 process identity mismatch for ${name}`);
    const processEntry = matches[0];
    const environment = assertRecord(processEntry.pm2_env, `PM2 ${name} environment`);
    const uptime = Number(environment.pm_uptime);
    if (
      environment.status !== 'online'
      || !Number.isSafeInteger(processEntry.pid)
      || processEntry.pid <= 0
      || !Number.isFinite(uptime)
      || now - uptime < MIN_STABLE_UPTIME_MS
      || Number(environment.unstable_restarts ?? 0) !== 0
    ) {
      fail(`PM2 process is not stable: ${name}`);
    }
  }
  return true;
}

function assertPrivateDirectory(path, label) {
  const entry = lstatSync(path);
  const stat = statSync(path);
  if (
    entry.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(path) !== path
    || (stat.mode & 0o777) !== 0o700
    || stat.uid !== process.getuid()
  ) {
    fail(`${label} is not a private owner directory`);
  }
}

function readProtectedJson(path, label, maxBytes = 16 * 1024) {
  const entry = lstatSync(path);
  const stat = statSync(path);
  if (
    entry.isSymbolicLink()
    || !stat.isFile()
    || realpathSync(path) !== path
    || (stat.mode & 0o777) !== 0o600
    || stat.uid !== process.getuid()
    || stat.size < 2
    || stat.size > maxBytes
  ) {
    fail(`${label} is not a protected owner file`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function sha256File(path) {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || realpathSync(path) !== path) {
    fail('deployed rotator artifact is unsafe');
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertWithin(parent, child, label) {
  const rel = relative(parent, child);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    fail(`${label} is outside its protected parent`);
  }
}

function validateRuntimeInputs(env) {
  const productionRootInput = env.NEXUS_ROTATION_PRODUCTION_ROOT;
  const stagingRootInput = env.NEXUS_ROTATION_STAGING_ROOT;
  const backupInput = env.NEXUS_ROTATION_BACKUP_DIR;
  const digest = env.NEXUS_ROTATION_EXPECTED_ROTATOR_SHA256;
  for (const [value, label] of [
    [productionRootInput, 'production root'],
    [stagingRootInput, 'staging root'],
    [backupInput, 'backup directory'],
  ]) {
    if (typeof value !== 'string' || !value.startsWith('/') || resolve(value) !== value) {
      fail(`${label} must be an absolute normalized path`);
    }
  }
  if (digest !== EXPECTED_ROTATOR_SHA256) {
    fail('expected rotator digest is not the reviewed artifact digest');
  }
  const productionRoot = realpathSync(productionRootInput);
  const stagingRoot = realpathSync(stagingRootInput);
  const backupDir = realpathSync(backupInput);
  if (
    productionRoot !== productionRootInput
    || stagingRoot !== stagingRootInput
    || backupDir !== backupInput
    || productionRoot === stagingRoot
  ) {
    fail('rotation roots are not canonical and distinct');
  }
  const backupParent = join(productionRoot, '.local', 'rotation-backups');
  assertPrivateDirectory(join(productionRoot, '.local'), 'production .local directory');
  assertPrivateDirectory(backupParent, 'rotation backup parent');
  assertPrivateDirectory(backupDir, 'rotation backup directory');
  assertWithin(backupParent, backupDir, 'rotation backup directory');
  if (dirname(backupDir) !== backupParent) {
    fail('rotation backup directory must be a direct child of its protected parent');
  }
  if (!/^production-data-keys-\d{8}T\d{6}Z-[A-Za-z0-9]{8}$/.test(backupDir.split(sep).at(-1))) {
    fail('rotation backup directory identity is invalid');
  }
  return { productionRoot, stagingRoot, backupDir, digest };
}

async function fetchJson(url, { headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) fail(`HTTP check failed for ${new URL(url).pathname}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_JSON_BYTES) fail('HTTP response exceeded the size limit');
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) fail('HTTP response exceeded the size limit');
  try {
    return JSON.parse(body);
  } catch {
    fail(`HTTP check returned invalid JSON for ${new URL(url).pathname}`);
  }
}

function readPm2Processes() {
  const result = spawnSync('pm2', ['jlist'], {
    encoding: 'utf8',
    timeout: FETCH_TIMEOUT_MS,
    maxBuffer: MAX_JSON_BYTES,
    env: process.env,
  });
  if (result.status !== 0 || result.error) fail('PM2 process query failed');
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail('PM2 process query returned invalid JSON');
  }
}

export async function runPostcheck({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  pm2Processes,
} = {}) {
  const { productionRoot, stagingRoot, backupDir, digest } = validateRuntimeInputs(env);
  const opsDirectory = join(productionRoot, '.local', 'ops');
  assertPrivateDirectory(opsDirectory, 'production ops directory');

  const scriptPath = realpathSync(process.argv[1]);
  if (dirname(scriptPath) !== opsDirectory) fail('postcheck script is not installed in production ops');

  for (const root of [productionRoot, stagingRoot]) {
    const artifact = join(root, ROTATOR_RELATIVE);
    if (sha256File(artifact) !== digest) fail('deployed rotator artifact digest does not match');
  }

  const phaseMarker = readProtectedJson(
    join(productionRoot, PHASE_MARKER_RELATIVE),
    'rotation phase marker',
  );
  const phase = validatePhaseMarker(phaseMarker, {
    expectedSha256: digest,
    expectedBackupDir: backupDir,
  });
  const config = validatePostcheckConfig(
    readProtectedJson(join(opsDirectory, CONFIG_NAME), 'postcheck config'),
    now,
  );
  const alertEvidence = readProtectedJson(
    join(opsDirectory, ALERT_EVIDENCE_NAME),
    'alert evidence',
  );
  validateAlertEvidence(alertEvidence, {
    now,
    expectedSha256: digest,
    expectedBackupDir: backupDir,
    phaseUpdatedAtMs: phase.updatedAtMs,
  });

  const authHeaders = {
    authorization: `Bearer ${config.ownerIosJwt}`,
    'x-nexus-active-tenant-id': String(config.activeTenantId),
  };
  const [
    edgeHealth,
    stagingHealth,
    oauth,
    garmin,
    health,
    finance,
  ] = await Promise.all([
    fetchJson(EDGE_HEALTH_URL, { fetchImpl }),
    fetchJson(`${STAGING_LOCAL_BASE_URL}/health`, { fetchImpl }),
    fetchJson(`${PRODUCTION_LOCAL_BASE_URL}/api/v1/connections`, {
      fetchImpl,
      headers: authHeaders,
    }),
    fetchJson(`${PRODUCTION_LOCAL_BASE_URL}/api/v1/garmin/status`, {
      fetchImpl,
      headers: authHeaders,
    }),
    fetchJson(`${PRODUCTION_LOCAL_BASE_URL}/api/v1/health-data/latest`, {
      fetchImpl,
      headers: authHeaders,
    }),
    fetchJson(`${PRODUCTION_LOCAL_BASE_URL}/api/v1/finance/transactions?limit=1`, {
      fetchImpl,
      headers: authHeaders,
    }),
  ]);

  validateHealthPayload(edgeHealth, 'production edge health');
  validateHealthPayload(stagingHealth, 'staging peer health');
  validateAuthenticatedPayloads({ oauth, garmin, health, finance });
  validatePm2Processes(pm2Processes ?? readPm2Processes(), now);

  return {
    version: POSTCHECK_CONTRACT_VERSION,
    productionEdgeHealth: true,
    stagingPeerHealth: true,
    authenticatedOAuthRead: true,
    authenticatedGarminRead: true,
    authenticatedHealthRead: true,
    authenticatedFinanceRead: true,
    pm2Stable: true,
    noNewAlerts: true,
  };
}

async function main() {
  try {
    const result = await runPostcheck();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown failure';
    process.stderr.write(`production data-key postcheck failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
