#!/usr/bin/env node
// @ts-nocheck
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SHA256_VALUE = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[0-9a-f]{32}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v2';
const TEN_SCRIPT_ACCEPTANCE_SCHEMA = 'nexus.content-ten-script-acceptance.v3';
const TEN_SCRIPT_ACCEPTANCE_REVISION = '2026-08-24-v3';
const MAX_RELEASE_VIEW_BYTES = 1024 * 1024;
const MAX_ACCEPTANCE_TOOL_BYTES = 1024 * 1024;
const MAX_ACCEPTANCE_STATE_BYTES = 1024 * 1024;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const RELEASE_VIEW_COMMAND = '/usr/local/sbin/nexus-release-state-view';
const SUDO = '/usr/bin/sudo';
const NODE = '/usr/bin/node';
const FLOCK = '/usr/bin/flock';
const PRODUCTION_API_ORIGIN = 'https://api.nexushub.me';
const CHILD_TOOL_FD = 3;
const CHILD_RELEASE_VIEW_FD = 4;
const CHILD_AUTH_FD = 5;
export const EXPECTED_PRODUCTION_SOURCE_SHA = 'bc129db7db35c669692d9916d0007cb90288a490';
export const EXPECTED_ACCEPTANCE_TOOL_SHA256 = 'a31483d0ba43cf2d3c8e8ed208a30504f9cdddff88a8eaa054723c08e7c1154f';
const REVIEWED_ACCEPTANCE_TOOL_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'content-ten-script-acceptance.mjs',
);
const EXPECTED_SCENARIOS = Object.freeze([
  ['std-en-01', 'pre-release', 'standard', 'en', 'sha256:ed5399d5aff66253bc95bd25e6313a5114353844110fe7904b1b6cde9ee8108b'],
  ['std-ptbr-01', 'pre-release', 'standard', 'pt-BR', 'sha256:a685d55bfde9868a86bac02012969e33b225552cd6305321f932613417bbdd11'],
  ['std-en-02', 'pre-release', 'standard', 'en', 'sha256:2f907bc24211150ab41771efe972721afa5ebfef5b321c4e8b42f9c2278c87e3'],
  ['std-ptbr-02', 'pre-release', 'standard', 'pt-BR', 'sha256:0bec4b23d064183a1182a0b2778707d085d82890d62115d92860e6c60eb8891f'],
  ['sched-en-01', 'pre-release', 'scheduled', 'en', 'sha256:6b9eb37c179d6739c6c531d31bcf073000beb67292bba1c9256ec63c4dd486e1'],
  ['sched-ptbr-01', 'pre-release', 'scheduled', 'pt-BR', 'sha256:0691cff2a2d5713853f81012990a025f66f503b4d28f3983e1b90b91ddc0f90b'],
  ['sched-en-02', 'pre-release', 'scheduled', 'en', 'sha256:efe95d2ab441a0bfd565a8e918e8fd6073f04802363806dd0db1982dfcb90ae9'],
  ['prio-ptbr-01', 'pre-release', 'priority', 'pt-BR', 'sha256:1c9d42bee2ab24be5d95b9ed3798ab90e9656fa2926f2919a45d247eeda19b57'],
  ['prio-en-01', 'pre-release', 'priority', 'en', 'sha256:71643a722d76444c252edc5df325c546666cd20126ee61086059a36563eda1fa'],
  ['prio-ptbr-smoke', 'production-smoke', 'priority', 'pt-BR', 'sha256:a7f45f76b06a42a8549b4a8ec1f52a569b2f2f0eb9f9f17fd08f3916430910f0'],
]);
export const VERIFIED_TOOL_LOADER = [
  "import fs from 'node:fs';",
  `const bytes=fs.readFileSync(${CHILD_TOOL_FD});`,
  "const tool=await import(`data:text/javascript;base64,${bytes.toString('base64')}`);",
  "if(typeof tool.runCliUnderStateLock!=='function')throw new Error('reviewed acceptance tool entrypoint is missing');",
  'await tool.runCliUnderStateLock();',
].join('');

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function safeProductionSmokeCliFailureMessage(error) {
  if (Number.isInteger(error?.exitCode) && typeof error?.message === 'string') {
    return error.message;
  }
  return error instanceof Error ? error.name : typeof error;
}

function option(name, required = false, argv = process.argv) {
  const index = argv.indexOf(name);
  if (index < 0) {
    if (required) fail(`${name} is required`, 64);
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`, 64);
  return value;
}

function assertPrivateDirectory(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid()) {
    fail(`${label} must be an owner-controlled private directory`, 77);
  }
  return stat;
}

export function assertPrivateRegularFile(filename, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (stat.mode & 0o077) !== 0 || stat.uid !== process.geteuid()) {
    fail(`${label} must be a single-link owner-controlled private file`, 77);
  }
  return stat;
}

function readPrivateRegularFileSnapshot(filename, label, maximumBytes) {
  const resolved = path.resolve(filename);
  assertPrivateDirectory(path.dirname(resolved), `${label} directory`);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail(`${label} requires no-follow file support`, 77);
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor, { bigint: true });
    const currentUid = BigInt(process.geteuid());
    if (!stat.isFile() || stat.nlink !== 1n || Number(stat.mode & 0o777n) !== 0o600
        || stat.uid !== currentUid) {
      fail(`${label} must be a single-link owner-controlled mode-0600 file`, 77);
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumBytes) {
      fail(`${label} is missing or oversized`, 78);
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read < 1) fail(`${label} could not be read completely`, 78);
      offset += read;
    }
    return {
      bytes,
      identity: {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(filename, label) {
  const snapshot = readPrivateRegularFileSnapshot(filename, label, MAX_ACCEPTANCE_STATE_BYTES);
  try {
    return { value: JSON.parse(snapshot.bytes.toString('utf8')), identity: snapshot.identity };
  } catch {
    fail(`${label} is not valid JSON`, 65);
  }
}

function sha256Value(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function validateReadyAcceptanceState(input) {
  if (![LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA, TEN_SCRIPT_ACCEPTANCE_SCHEMA]
    .includes(input?.schemaVersion)
      || input.acceptanceRevision !== TEN_SCRIPT_ACCEPTANCE_REVISION
      || !Array.isArray(input.scenarios)
      || input.scenarios.length !== EXPECTED_SCENARIOS.length) {
    fail('acceptance state schema is not supported for production smoke', 78);
  }
  input.scenarios.forEach((row, index) => {
    const [id, phase, deliveryMode, language, topicSha256] = EXPECTED_SCENARIOS[index];
    if (!row || row.id !== id || row.phase !== phase || row.deliveryMode !== deliveryMode
        || row.language !== language || row.topicSha256 !== topicSha256) {
      fail('acceptance state does not match the immutable ten-scenario inventory', 78);
    }
  });
  const preRelease = input.scenarios.filter((row) => row.phase === 'pre-release');
  const smoke = input.scenarios.find((row) => row.phase === 'production-smoke');
  if (preRelease.length !== 9
      || preRelease.some((row) => row.status !== 'completed' || row.output?.contractPass !== true)) {
    return false;
  }
  if (!smoke) fail('production smoke scenario is missing', 78);
  const pristine = smoke.status === 'pending' && smoke.jobId === null && smoke.output === null;
  if (input.schemaVersion === LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA) {
    if (!pristine || Object.hasOwn(input, 'productionSmokeSource')
        || Object.hasOwn(input, 'productionSmokeSourceSha')) {
      fail('legacy acceptance state cannot contain a submitted or bound production smoke', 78);
    }
    return true;
  }
  if (!pristine) {
    if (!input.productionSmokeSource
        || input.productionSmokeSource.sourceSha !== EXPECTED_PRODUCTION_SOURCE_SHA) {
      fail('existing production smoke job is not bound to the reviewed source', 78);
    }
    if (!smoke.jobId || ![
      'queued', 'running', 'waiting_capacity', 'completed', 'failed', 'cancelled',
    ].includes(smoke.status)) {
      fail('existing production smoke job state cannot be resumed safely', 78);
    }
  } else if (input.productionSmokeSource
      && input.productionSmokeSource.sourceSha !== EXPECTED_PRODUCTION_SOURCE_SHA) {
    fail('pending production smoke is bound to a different source', 78);
  }
  return true;
}

export function validateBoundWorkloadReleaseView(state, releaseViewBytes, expectedSourceSha) {
  if (!state?.productionSmokeSource) return;
  const bytes = parseAndValidateReleaseView(releaseViewBytes, expectedSourceSha);
  const view = JSON.parse(bytes.toString('utf8'));
  const binding = state.productionSmokeSource;
  const expected = {
    schemaVersion: 'nexus.content-ten-script-workload-source.v1',
    sourceSha: expectedSourceSha,
    releaseViewSha256: sha256Value(bytes),
    releaseId: view.activeReceipt.releaseId,
    releasePayloadDigest: view.activeReceipt.releasePayloadDigest,
    receiptCompletedAt: view.activeReceipt.completedAt,
    viewCapturedAt: view.capturedAt,
  };
  if (Object.entries(expected).some(([key, value]) => binding[key] !== value)) {
    fail('production smoke workload binding does not match the exact reviewed release view', 78);
  }
  canonicalTimestamp(binding.boundAt, 'production smoke workload source boundAt');
  if (Date.parse(binding.viewCapturedAt) > Date.parse(binding.boundAt)) {
    fail('production smoke workload binding predates its release view', 78);
  }
}

function canonicalTimestamp(value, label) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  const normalized = typeof value === 'string' && !value.includes('.')
    ? value.replace(/Z$/u, '.000Z') : value;
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)
      || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    fail(`${label} must be a canonical UTC timestamp`, 78);
  }
  return value;
}

function validateCompletedReleaseView(view, expectedSourceSha) {
  const receipt = view?.activeReceipt;
  const effective = view?.effective;
  const active = view?.active;
  if (!FULL_SHA.test(expectedSourceSha ?? '')
      || view?.schema !== 'nexus.release-state-view.v2' || view.blocked !== null
      || active?.status !== 'completed' || active.sourceSha !== expectedSourceSha
      || effective?.source !== 'receipt' || effective.provable !== true
      || effective.status !== 'completed' || effective.stateStatus !== 'completed'
      || effective.staleProjection !== false
      || receipt?.schema !== 'nexus.release-receipt.v3'
      || receipt.outcome !== 'completed' || receipt.sourceSha !== expectedSourceSha
      || !RELEASE_ID.test(receipt.releaseId ?? '')
      || active.releaseId !== receipt.releaseId || effective.releaseId !== receipt.releaseId
      || !SHA256_VALUE.test(receipt.releasePayloadDigest ?? '')
      || active.releasePayloadDigest !== receipt.releasePayloadDigest
      || effective.releasePayloadDigest !== receipt.releasePayloadDigest) {
    fail('release view does not prove an unblocked completed v3 receipt for the expected source', 78);
  }
  canonicalTimestamp(view.capturedAt, 'release view capturedAt');
  canonicalTimestamp(receipt.completedAt, 'release receipt completedAt');
  if (Date.parse(receipt.completedAt) > Date.parse(view.capturedAt)) {
    fail('release receipt completion cannot be later than release view capture', 78);
  }
}

function parseAndValidateReleaseView(bytes, expectedSourceSha) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_RELEASE_VIEW_BYTES) {
    fail('release view bytes are missing or oversized', 78);
  }
  let view;
  try {
    view = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('release view is not valid JSON', 78);
  }
  validateCompletedReleaseView(view, expectedSourceSha);
  return bytes;
}

export function captureValidatedReleaseView(expectedSourceSha) {
  if (!FULL_SHA.test(expectedSourceSha ?? '')) fail('deployed SHA is invalid', 64);
  const result = spawnSync(SUDO, ['-n', RELEASE_VIEW_COMMAND], {
    encoding: null,
    maxBuffer: MAX_RELEASE_VIEW_BYTES,
    env: { PATH: '/usr/bin:/bin' },
  });
  if (result.error || result.signal || result.status !== 0) {
    fail('authoritative release-state viewer failed', 78);
  }
  return parseAndValidateReleaseView(result.stdout, expectedSourceSha);
}

export function writeOncePrivateFile(filename, bytes) {
  const resolved = path.resolve(filename);
  const directory = path.dirname(resolved);
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_RELEASE_VIEW_BYTES) {
    fail('workload release view bytes are missing or oversized', 78);
  }
  const directoryIdentity = assertPrivateDirectory(directory, 'release-view directory');
  const noFollow = fs.constants.O_NOFOLLOW;
  const directoryOnly = fs.constants.O_DIRECTORY;
  if (typeof noFollow !== 'number' || typeof directoryOnly !== 'number') {
    fail('no-follow file creation is unavailable', 77);
  }
  let descriptor = null;
  let directoryDescriptor = null;
  let created = false;
  try {
    try {
      descriptor = fs.openSync(
        resolved,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const persisted = readPrivateRegularFileSnapshot(
        resolved,
        'workload release view',
        MAX_RELEASE_VIEW_BYTES,
      ).bytes;
      if (!crypto.timingSafeEqual(
        crypto.createHash('sha256').update(persisted).digest(),
        crypto.createHash('sha256').update(bytes).digest(),
      )) {
        fail('existing workload release view differs from authoritative bytes', 78);
      }
      return persisted;
    }
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    const pathname = fs.lstatSync(resolved, { bigint: true });
    if (!written.isFile() || written.nlink !== 1n
        || Number(written.mode & 0o777n) !== 0o600
        || written.uid !== BigInt(process.geteuid())
        || written.size !== BigInt(bytes.length)
        || pathname.dev !== written.dev || pathname.ino !== written.ino) {
      fail('workload release view identity changed during persistence', 77);
    }
    directoryDescriptor = fs.openSync(
      directory,
      fs.constants.O_RDONLY | directoryOnly | noFollow,
    );
    const openedDirectory = fs.fstatSync(directoryDescriptor, { bigint: true });
    if (!openedDirectory.isDirectory()
        || openedDirectory.dev !== BigInt(directoryIdentity.dev)
        || openedDirectory.ino !== BigInt(directoryIdentity.ino)) {
      fail('release-view directory identity changed during persistence', 77);
    }
    fs.fsyncSync(directoryDescriptor);
    return Buffer.from(bytes);
  } catch (error) {
    if (created && descriptor !== null) {
      try {
        const opened = fs.fstatSync(descriptor, { bigint: true });
        const pathname = fs.lstatSync(resolved, { bigint: true });
        if (pathname.dev === opened.dev && pathname.ino === opened.ino) {
          fs.unlinkSync(resolved);
        }
      } catch {
        // Leave any path whose identity cannot be proven for operator review.
      }
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor);
  }
}

export function resolveWorkloadReleaseView(filename, expectedSourceSha, capture = captureValidatedReleaseView) {
  const resolved = path.resolve(filename);
  try {
    const bytes = readPrivateRegularFileSnapshot(
      resolved,
      'workload release view',
      MAX_RELEASE_VIEW_BYTES,
    ).bytes;
    return parseAndValidateReleaseView(bytes, expectedSourceSha);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const bytes = capture(expectedSourceSha);
  return parseAndValidateReleaseView(writeOncePrivateFile(resolved, bytes), expectedSourceSha);
}

export function validateProductionBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('base URL must be the canonical production API origin', 64);
  }
  if (parsed.origin !== PRODUCTION_API_ORIGIN
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) {
    fail('base URL must be the canonical production API origin', 64);
  }
  return PRODUCTION_API_ORIGIN;
}

function assertPrivateFileStat(stat, label) {
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || stat.uid !== process.geteuid()) {
    fail(`${label} must be a single-link owner-controlled private file`, 77);
  }
}

function readPrivateFileDescriptor(filename, label, maximumBytes) {
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail('no-follow file reads are unavailable', 77);
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0
        || stat.uid !== process.geteuid()) {
      fail(`${label} must be a single-link owner-controlled non-writable source file`, 77);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) {
      fail(`${label} is missing or oversized`, 78);
    }
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (read < 1) fail(`${label} could not be read completely`, 78);
      offset += read;
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function stagePrivateBytes(bytes, stagingDirectory, label, suffix) {
  const directory = path.resolve(stagingDirectory);
  assertPrivateDirectory(directory, `${label} staging directory`);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail('no-follow file creation is unavailable', 77);
  const stagedPath = path.join(
    directory,
    `.content-ten-script-${label}-${process.pid}-${crypto.randomBytes(16).toString('hex')}${suffix}`,
  );
  let writeDescriptor = null;
  let readDescriptor = null;
  let created = false;
  try {
    writeDescriptor = fs.openSync(
      stagedPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o400,
    );
    created = true;
    fs.writeFileSync(writeDescriptor, bytes);
    fs.fsyncSync(writeDescriptor);
    fs.closeSync(writeDescriptor);
    writeDescriptor = null;

    readDescriptor = fs.openSync(stagedPath, fs.constants.O_RDONLY | noFollow);
    const stagedStat = fs.fstatSync(readDescriptor);
    assertPrivateFileStat(stagedStat, `staged ${label}`);
    if (stagedStat.size !== bytes.length) fail(`staged ${label} size changed`, 78);
    fs.unlinkSync(stagedPath);
    created = false;
    return readDescriptor;
  } catch (error) {
    if (readDescriptor !== null) fs.closeSync(readDescriptor);
    throw error;
  } finally {
    if (writeDescriptor !== null) fs.closeSync(writeDescriptor);
    if (created) {
      try {
        fs.unlinkSync(stagedPath);
      } catch {
        // Best-effort cleanup of a private file created by this invocation.
      }
    }
  }
}

export function stageVerifiedAcceptanceTool(filename, expectedSha256, stagingDirectory) {
  const bytes = readPrivateFileDescriptor(
    path.resolve(filename),
    'receipt-bound acceptance tool',
    MAX_ACCEPTANCE_TOOL_BYTES,
  );
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    fail('receipt-bound acceptance tool bytes do not match the reviewed digest', 78);
  }
  return stagePrivateBytes(bytes, stagingDirectory, 'acceptance-tool', '.mjs');
}

function ensurePrivateLockFile(filename) {
  const directory = path.dirname(filename);
  assertPrivateDirectory(directory, 'acceptance state directory');
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== 'number') fail('no-follow lock creation is unavailable', 77);
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  assertPrivateRegularFile(filename, 'acceptance state lock');
}

export function runProductionSmoke({
  argv = process.argv,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  captureReleaseView = captureValidatedReleaseView,
  existsSyncImpl = fs.existsSync,
  acceptanceToolIdentityPath = REVIEWED_ACCEPTANCE_TOOL_PATH,
} = {}) {
  if (platform !== 'linux') fail('production smoke launcher requires Linux', 69);
  const statePath = path.resolve(option('--state', true, argv));
  const authPath = path.resolve(option('--auth-file', true, argv));
  const acceptanceTool = path.resolve(option('--acceptance-tool', true, argv));
  const expectedToolSha256 = option('--acceptance-tool-sha256', true, argv);
  const workloadReleaseView = path.resolve(option('--workload-release-view', true, argv));
  const baseUrl = validateProductionBaseUrl(option('--base-url', true, argv));
  const deployedSha = option('--deployed-sha', true, argv);
  if (!FULL_SHA.test(deployedSha ?? '') || !SHA256_HEX.test(expectedToolSha256 ?? '')) {
    fail('deployed SHA or acceptance-tool SHA-256 is invalid', 64);
  }
  if (deployedSha !== EXPECTED_PRODUCTION_SOURCE_SHA
      || expectedToolSha256 !== EXPECTED_ACCEPTANCE_TOOL_SHA256) {
    fail('production source or acceptance-tool digest is not the reviewed identity', 78);
  }
  if (acceptanceTool !== path.resolve(acceptanceToolIdentityPath)) {
    fail('acceptance-tool path is not the reviewed adjacent module', 78);
  }
  const { value: state, identity: stateIdentity } = readJson(statePath, 'acceptance state');
  if (!validateReadyAcceptanceState(state)) {
    fail('nine pre-release scenarios have not completed their contracts', 75);
  }
  const authSnapshot = readPrivateRegularFileSnapshot(
    authPath,
    'auth file',
    MAX_AUTH_FILE_BYTES,
  );
  const releaseViewBytes = resolveWorkloadReleaseView(
    workloadReleaseView,
    deployedSha,
    captureReleaseView,
  );
  validateBoundWorkloadReleaseView(state, releaseViewBytes, deployedSha);
  const stagingDirectory = path.dirname(workloadReleaseView);
  let toolDescriptor = null;
  let releaseViewDescriptor = null;
  let authDescriptor = null;
  try {
    toolDescriptor = stageVerifiedAcceptanceTool(
      acceptanceTool,
      expectedToolSha256,
      stagingDirectory,
    );
    releaseViewDescriptor = stagePrivateBytes(
      releaseViewBytes,
      stagingDirectory,
      'release-view',
      '.json',
    );
    authDescriptor = stagePrivateBytes(
      authSnapshot.bytes,
      stagingDirectory,
      'auth-file',
      '.token',
    );
    const lockPath = `${statePath}.lock`;
    ensurePrivateLockFile(lockPath);
    if (!existsSyncImpl(FLOCK)) fail('production acceptance requires /usr/bin/flock', 69);
    const result = spawnSyncImpl(FLOCK, [
      '-E', '75', '-n', '-x', '-F', lockPath,
      NODE,
      '--input-type=module',
      '--eval', VERIFIED_TOOL_LOADER,
      '--',
      '--phase', 'production-smoke',
      '--state', statePath,
      '--state-expected-dev', stateIdentity.dev,
      '--state-expected-ino', stateIdentity.ino,
      '--state-expected-sha256', stateIdentity.sha256,
      '--auth-file-fd', String(CHILD_AUTH_FD),
      '--workload-release-view-fd', String(CHILD_RELEASE_VIEW_FD),
      '--base-url', baseUrl,
      '--deployed-sha', deployedSha,
    ], {
      stdio: [
        'inherit',
        'inherit',
        'inherit',
        toolDescriptor,
        releaseViewDescriptor,
        authDescriptor,
      ],
      env: { PATH: '/usr/bin:/bin' },
    });
    if (result.error || result.signal || result.status !== 0) {
      fail('receipt-bound production smoke invocation failed', result.status || 78);
    }
  } finally {
    if (toolDescriptor !== null) fs.closeSync(toolDescriptor);
    if (releaseViewDescriptor !== null) fs.closeSync(releaseViewDescriptor);
    if (authDescriptor !== null) fs.closeSync(authDescriptor);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runProductionSmoke();
  } catch (error) {
    process.stderr.write(`${safeProductionSmokeCliFailureMessage(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
