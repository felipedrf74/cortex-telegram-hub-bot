#!/usr/bin/env node
import {
  createHash,
  createPublicKey,
  verify,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TRANSACTION_REQUEST_SCHEMA =
  'nexus.rollback-drill-legacy-staging-transaction-request.v1';
const BROKER_INSPECTION_SCHEMA =
  'nexus.rollback-drill-legacy-staging-broker-inspection.v1';
const BROKER_EVIDENCE_SCHEMA =
  'nexus.rollback-drill-legacy-staging-evidence.v1';
const OPERATOR_CHECKPOINT_SCHEMA =
  'nexus.rollback-drill-legacy-staging-operator-checkpoint.v1';
const BOOTSTRAP_SCHEMA =
  'nexus.rollback-drill-legacy-staging-bootstrap.v1';
const STAGING_REQUEST_SCHEMA = 'nexus.staging-attestation-request.v1';
const RELEASE_MANIFEST_SCHEMA = 'nexus.release-manifest.v2';
const RELEASE_MANIFEST_PAYLOAD_SCHEMA = 'nexus.release-manifest-payload.v2';
const RELEASE_KEY_ID = 'github-environment-release-signing-2026-07';
const CONTROL_VERSION = 'nexus-release-promotion-control.v2';
const BROKER_VERSION = 'nexus-rollback-drill-legacy-staging-broker.v1';
const PROFILE = 'isolated-kvm-first-drill';
const LEGACY_BASE = process.env.NODE_ENV === 'test'
    && path.isAbsolute(process.env.NEXUS_LEGACY_DRILL_BASE ?? '')
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_BASE)
  : '/home/dominguez/telegram-hub-bot-staging';
const EXPECTED_CONTROL_SHA256 =
  process.env.NODE_ENV === 'test'
    && /^[a-f0-9]{64}$/u.test(
      process.env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256 ?? '',
    )
    ? process.env.NEXUS_LEGACY_DRILL_EXPECTED_CONTROL_SHA256
    : 'fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1';
const DATABASE_TRANSACTION_ROOT = process.env.NODE_ENV === 'test'
    && path.isAbsolute(
      process.env.NEXUS_LEGACY_DRILL_DATABASE_TRANSACTION_ROOT ?? '',
    )
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_DATABASE_TRANSACTION_ROOT)
  : '/var/lib/nexus-rollback-drill-legacy-staging/transactions';
const SQLITE_HELPER = process.env.NODE_ENV === 'test'
    && path.isAbsolute(process.env.NEXUS_LEGACY_DRILL_SQLITE_HELPER ?? '')
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_SQLITE_HELPER)
  : '/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py';
const EXPECTED_SQLITE_HELPER_SHA256 =
  process.env.NODE_ENV === 'test'
    && /^[a-f0-9]{64}$/u.test(
      process.env.NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256 ?? '',
    )
    ? process.env.NEXUS_LEGACY_DRILL_EXPECTED_SQLITE_HELPER_SHA256
    : 'e1f1a92d4dc49bd6fe6c1d8c1a3573ec2db61f6374a1831b2765a5541943708d';
const PYTHON_BIN = process.env.NODE_ENV === 'test'
    && path.isAbsolute(process.env.NEXUS_LEGACY_DRILL_PYTHON_BIN ?? '')
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_PYTHON_BIN)
  : '/usr/bin/python3';
const FUSER_BIN = process.env.NODE_ENV === 'test'
    && path.isAbsolute(process.env.NEXUS_LEGACY_DRILL_FUSER_BIN ?? '')
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_FUSER_BIN)
  : '/usr/bin/fuser';
const FILESYSTEM_HELPER = process.env.NODE_ENV === 'test'
    && path.isAbsolute(
      process.env.NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER ?? '',
    )
  ? path.resolve(process.env.NEXUS_LEGACY_DRILL_FILESYSTEM_HELPER)
  : '/usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS = 5_000;
const MAX_TRANSACTION_LIFETIME_MS = 30 * 60 * 1000;
const MAX_STAGING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FULL_SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const toolingRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const TRANSACTION_REQUEST_FIELDS = Object.freeze([
  'artifactDigest',
  'base',
  'broker',
  'control',
  'expiresAt',
  'issuedAt',
  'promotionAllowed',
  'purpose',
  'releaseDir',
  'releaseManifestBase64',
  'releaseManifestPayloadSha256',
  'releaseManifestSha256',
  'releaseManifestSignatureSha256',
  'releaseManifestSigningRunId',
  'releaseManifestSigningRunSha256',
  'requestId',
  'runtimeSha',
  'schema',
]);
const BROKER_IDENTITY_FIELDS = Object.freeze([
  'adapterSha256',
  'sha256',
  'version',
]);
const CONTROL_IDENTITY_FIELDS = Object.freeze(['sha256', 'version']);
const SELECTOR_FIELDS = Object.freeze([
  'dev',
  'gid',
  'ino',
  'mode',
  'path',
  'target',
  'uid',
]);
const PREDECESSOR_FIELDS = Object.freeze([
  'artifactDigest',
  'installedAttestationSha256',
  'markerSha256',
  'metadataSha256',
  'recoveryAttestationSha256',
  'runtime',
  'runtimeIdentity',
  'runtimeSha',
  'selector',
]);
const RUNTIME_IDENTITY_FIELDS = Object.freeze([
  'dev',
  'gid',
  'ino',
  'mode',
  'uid',
]);
const SOURCE_PROVENANCE_FIELDS = Object.freeze([
  'releaseManifestPayloadSha256',
  'releaseManifestSha256',
  'releaseManifestSignatureSha256',
  'releaseManifestSigningRunId',
  'releaseManifestSigningRunSha256',
  'rootRequestSha256',
]);
const TRANSACTION_FIELDS = Object.freeze([
  'databaseBackupSha256',
  'databaseBackupSizeBytes',
  'journalSha256',
  'preparedAt',
  'publishedAt',
  'readinessCompletedAt',
  'recoveryTargetSeconds',
  'selectorSwitchedAt',
  'stabilitySeconds',
]);
const BOOTSTRAP_FIELDS = Object.freeze([
  'base',
  'broker',
  'brokerReceiptSha256',
  'control',
  'currentSelector',
  'predecessor',
  'profile',
  'promotionAllowed',
  'schema',
  'sourceProvenance',
  'transaction',
  'transactionId',
]);
const STAGING_REQUEST_FIELDS = Object.freeze([
  'artifactDigest',
  'drillBootstrap',
  'expiresAt',
  'installedRuntimeDigest',
  'recoveryRuntimeDigest',
  'releaseDir',
  'releaseManifestSha256',
  'remoteIdentity',
  'remoteReadiness',
  'requestId',
  'runtimeSha',
  'schema',
  'smoke',
  'verifiedAt',
]);
const DATABASE_BACKUP_SCHEMA =
  'nexus.rollback-drill-legacy-staging-database-backup.v1';
const DATABASE_BACKUP_FIELDS = Object.freeze([
  'createdAt',
  'gid',
  'mode',
  'parentDev',
  'parentIno',
  'schema',
  'sha256',
  'sizeBytes',
  'sourceDev',
  'sourceIno',
  'uid',
]);
const OPERATOR_CHECKPOINT_FIELDS = Object.freeze([
  'artifactDigest',
  'base',
  'broker',
  'createdAt',
  'evidence',
  'evidenceBase',
  'releaseDir',
  'releaseManifestSha256',
  'requestId',
  'runtimeSha',
  'schema',
  'server',
]);
const OPERATOR_EVIDENCE_FIELDS = Object.freeze([
  'brokerInspection',
  'rootEvidence',
  'signedBundle',
  'stagingRequest',
  'transactionRequest',
]);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',')
        !== [...fields].sort().join(',')) {
    fail(`${label} fields do not match the governed schema`);
  }
  return value;
}

function readStableFile(file, maximum, label, { allowEmpty = false } = {}) {
  const resolved = path.resolve(file);
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (!allowEmpty && before.size <= 0) || before.size > maximum) {
    fail(`${label} is not a bounded single-link regular file`);
  }
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || after.dev !== opened.dev
        || after.ino !== opened.ino || after.size !== body.length
        || after.mtimeMs !== opened.mtimeMs) {
      fail(`${label} changed while it was read`);
    }
    return { body, resolved };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readStableJson(file, maximum, label) {
  const evidence = readStableFile(file, maximum, label);
  let value;
  try {
    value = JSON.parse(evidence.body.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { ...evidence, value };
}

function parseCanonicalBase64(value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const body = Buffer.from(value, 'base64');
  if (body.length === 0 || body.length > maximum
      || body.toString('base64') !== value) {
    fail(`${label} is invalid or exceeds its size limit`);
  }
  return body;
}

function canonicalTime(value, label) {
  const milliseconds = Date.parse(value ?? '');
  if (typeof value !== 'string' || !ISO_UTC.test(value)
      || !Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return milliseconds;
}

function resolvePublicKey(explicit = '') {
  const selected = explicit
    ? path.resolve(explicit)
    : path.join(
      toolingRoot,
      'docs/release/evidence/release-evidence-public-key.pem',
    );
  return readStableFile(selected, 128 * 1024, 'release evidence public key').body;
}

function validateManifestBody(body, publicKeyBody, expected = {}) {
  if (!Buffer.isBuffer(body) || body.length === 0
      || body.length > MAX_MANIFEST_BYTES) {
    fail('release manifest is empty or too large');
  }
  let envelope;
  try {
    envelope = JSON.parse(body.toString('utf8'));
  } catch {
    fail('release manifest is not valid JSON');
  }
  exactObject(
    envelope,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'],
    'release manifest envelope',
  );
  const payload = envelope.payload;
  if (envelope.schema !== RELEASE_MANIFEST_SCHEMA
      || envelope.keyId !== RELEASE_KEY_ID
      || envelope.signatureAlgorithm !== 'ed25519'
      || payload?.schema !== RELEASE_MANIFEST_PAYLOAD_SCHEMA
      || !FULL_SHA.test(payload.runtimeSha ?? '')
      || !DIGEST.test(payload.artifact?.digest ?? '')
      || payload.source?.dirty === true
      || !RUN_ID.test(String(payload.ci?.runId ?? ''))) {
    fail('release manifest identity is invalid');
  }
  let signature;
  try {
    signature = Buffer.from(envelope.signature ?? '', 'base64');
  } catch {
    fail('release manifest signature is invalid');
  }
  if (typeof envelope.signature !== 'string'
      || signature.length === 0
      || signature.toString('base64') !== envelope.signature
      || !verify(
    null,
    Buffer.from(canonicalJson(payload)),
    createPublicKey(publicKeyBody),
    signature,
  )) {
    fail('release manifest is not production-key-valid');
  }
  if (expected.runtimeSha && payload.runtimeSha !== expected.runtimeSha) {
    fail('release manifest runtime SHA mismatch');
  }
  if (expected.artifactDigest
      && payload.artifact.digest !== expected.artifactDigest) {
    fail('release manifest artifact digest mismatch');
  }
  const generatedAt = canonicalTime(
    payload.generatedAt,
    'release manifest generatedAt',
  );
  const expiresAt = canonicalTime(
    payload.expiresAt,
    'release manifest expiresAt',
  );
  if (expiresAt <= generatedAt || expiresAt <= Date.now()) {
    fail('release manifest is expired or has an invalid lifetime');
  }
  return envelope;
}

function expectedReleaseDir(runtimeSha, artifactDigest, base = LEGACY_BASE) {
  return `${base}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
}

function validateBrokerIdentity(value, label) {
  exactObject(value, BROKER_IDENTITY_FIELDS, label);
  if (value.version !== BROKER_VERSION || !DIGEST.test(value.sha256 ?? '')
      || !DIGEST.test(value.adapterSha256 ?? '')) {
    fail(`${label} is invalid`);
  }
  return value;
}

function validateControlIdentity(value, label) {
  exactObject(value, CONTROL_IDENTITY_FIELDS, label);
  if (value.version !== CONTROL_VERSION
      || value.sha256 !== EXPECTED_CONTROL_SHA256) {
    fail(`${label} is not the exact reviewed control v2 identity`);
  }
  return value;
}

function validateInspection(value) {
  exactObject(value, [
    'base',
    'broker',
    'control',
    'promotionAllowed',
    'schema',
    'workerUser',
  ], 'legacy staging broker inspection');
  if (value.schema !== BROKER_INSPECTION_SCHEMA
      || value.base !== LEGACY_BASE
      || value.workerUser !== 'dominguez'
      || value.promotionAllowed !== false) {
    fail('legacy staging broker inspection identity is invalid');
  }
  validateBrokerIdentity(value.broker, 'legacy staging broker identity');
  validateControlIdentity(value.control, 'legacy staging control identity');
  return value;
}

export function validateTransactionRequest(
  request,
  {
    publicKeyBody,
    expectedRequestId = '',
    expectedBrokerSha256 = '',
    expectedAdapterSha256 = '',
    allowExpired = false,
  } = {},
) {
  exactObject(
    request,
    TRANSACTION_REQUEST_FIELDS,
    'legacy staging transaction request',
  );
  if (request.schema !== TRANSACTION_REQUEST_SCHEMA
      || request.purpose !== PROFILE
      || request.promotionAllowed !== false
      || !UUID.test(request.requestId ?? '')
      || (expectedRequestId && request.requestId !== expectedRequestId)
      || !FULL_SHA.test(request.runtimeSha ?? '')
      || !DIGEST.test(request.artifactDigest ?? '')
      || request.base !== LEGACY_BASE
      || request.releaseDir !== expectedReleaseDir(
        request.runtimeSha,
        request.artifactDigest,
      )
      || !DIGEST.test(request.releaseManifestSha256 ?? '')
      || !DIGEST.test(request.releaseManifestPayloadSha256 ?? '')
      || !DIGEST.test(request.releaseManifestSignatureSha256 ?? '')
      || !RUN_ID.test(request.releaseManifestSigningRunId ?? '')
      || !DIGEST.test(request.releaseManifestSigningRunSha256 ?? '')) {
    fail('legacy staging transaction request identity is invalid');
  }
  validateBrokerIdentity(request.broker, 'legacy staging request broker');
  validateControlIdentity(request.control, 'legacy staging request control');
  if ((expectedBrokerSha256
      && request.broker.sha256 !== expectedBrokerSha256)
      || (expectedAdapterSha256
        && request.broker.adapterSha256 !== expectedAdapterSha256)) {
    fail('legacy staging request installed broker identity mismatch');
  }
  const issuedAt = canonicalTime(
    request.issuedAt,
    'legacy staging request issuedAt',
  );
  const expiresAt = canonicalTime(
    request.expiresAt,
    'legacy staging request expiresAt',
  );
  if (expiresAt <= issuedAt
      || expiresAt - issuedAt > MAX_TRANSACTION_LIFETIME_MS
      || issuedAt > Date.now() + CLOCK_SKEW_MS
      || (!allowExpired && expiresAt <= Date.now())) {
    fail('legacy staging transaction request lifetime is invalid or expired');
  }
  const manifestBody = parseCanonicalBase64(
    request.releaseManifestBase64,
    MAX_MANIFEST_BYTES,
    'legacy staging source manifest',
  );
  if (sha256(manifestBody) !== request.releaseManifestSha256) {
    fail('legacy staging source manifest digest mismatch');
  }
  const manifest = validateManifestBody(
    manifestBody,
    publicKeyBody ?? resolvePublicKey(),
    {
      runtimeSha: request.runtimeSha,
      artifactDigest: request.artifactDigest,
    },
  );
  if (sha256(canonicalJson(manifest.payload))
      !== request.releaseManifestPayloadSha256) {
    fail('legacy staging source manifest payload digest mismatch');
  }
  if (sha256(Buffer.from(manifest.signature, 'base64'))
      !== request.releaseManifestSignatureSha256
      || String(manifest.payload.ci?.runId ?? '')
        !== request.releaseManifestSigningRunId
      || sha256(canonicalJson(manifest.payload.ci))
        !== request.releaseManifestSigningRunSha256) {
    fail('legacy staging source manifest signing-run binding mismatch');
  }
  return { request, manifest, manifestBody };
}

function validateSelector(value, expectedPath, expectedTarget, label) {
  exactObject(value, SELECTOR_FIELDS, label);
  if (value.path !== expectedPath || value.target !== expectedTarget
      || !/^[0-9]+$/u.test(value.dev ?? '')
      || !/^[0-9]+$/u.test(value.ino ?? '')
      || !Number.isSafeInteger(value.uid) || value.uid < 0
      || !Number.isSafeInteger(value.gid) || value.gid < 0
      || !Number.isSafeInteger(value.mode) || value.mode !== 0o777) {
    fail(`${label} identity is invalid`);
  }
  return value;
}

function validateRuntimeIdentity(value, label) {
  exactObject(value, RUNTIME_IDENTITY_FIELDS, label);
  if (!/^[0-9]+$/u.test(value.dev ?? '')
      || !/^[0-9]+$/u.test(value.ino ?? '')
      || !Number.isSafeInteger(value.uid) || value.uid < 0
      || !Number.isSafeInteger(value.gid) || value.gid < 0
      || !Number.isSafeInteger(value.mode)
      || !new Set([0o700, 0o555]).has(value.mode)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function validateSourceProvenance(value, request = null) {
  exactObject(
    value,
    SOURCE_PROVENANCE_FIELDS,
    'legacy staging source provenance',
  );
  for (const field of [
    'releaseManifestPayloadSha256',
    'releaseManifestSha256',
    'releaseManifestSignatureSha256',
    'releaseManifestSigningRunSha256',
    'rootRequestSha256',
  ]) {
    if (!DIGEST.test(value[field] ?? '')) {
      fail(`legacy staging source provenance ${field} is invalid`);
    }
  }
  if (!RUN_ID.test(value.releaseManifestSigningRunId ?? '')) {
    fail('legacy staging source provenance signing run id is invalid');
  }
  if (request && (
    value.releaseManifestSha256 !== request.releaseManifestSha256
    || value.releaseManifestPayloadSha256
      !== request.releaseManifestPayloadSha256
    || value.releaseManifestSignatureSha256
      !== request.releaseManifestSignatureSha256
    || value.releaseManifestSigningRunId
      !== request.releaseManifestSigningRunId
    || value.releaseManifestSigningRunSha256
      !== request.releaseManifestSigningRunSha256
  )) {
    fail('legacy staging source provenance differs from its exact root request');
  }
  return value;
}

function validateRemoteIdentity(value, request) {
  exactObject(value, ['schema', 'services'], 'legacy staging PM2 identity');
  if (value.schema !== 'nexus.pm2-release-identity.v1'
      || !Array.isArray(value.services) || value.services.length !== 2) {
    fail('legacy staging PM2 identity is incomplete');
  }
  const expected = new Map([
    ['nexus-hub-staging', {
      cwd: request.releaseDir,
      executable: `${request.releaseDir}/dist/index.js`,
      interpreter: 'node',
    }],
    ['content-engine-staging', {
      cwd: `${request.releaseDir}/content-engine`,
      executable:
        `${request.releaseDir}/content-engine/.venv/bin/python3.12`,
      interpreter: 'none',
    }],
  ]);
  for (const [name, identity] of expected) {
    const matches = value.services.filter((entry) => entry?.name === name);
    const service = matches[0];
    if (matches.length !== 1 || service.status !== 'online'
        || service.cwd !== identity.cwd
        || service.executable !== identity.executable
        || service.interpreter !== identity.interpreter
        || service.releaseSha !== request.runtimeSha
        || service.sentryRelease !== request.runtimeSha) {
      fail(`legacy staging PM2 identity mismatch: ${name}`);
    }
  }
  return value;
}

function validateReadiness(value, request) {
  exactObject(value, [
    'checkedAt',
    'checks',
    'readinessAttempts',
    'role',
    'runtimeSha',
    'schema',
    'services',
    'soak',
    'stabilityCompletedAt',
    'stabilityObservedSeconds',
    'stabilitySeconds',
    'stabilityStartedAt',
  ], 'legacy staging readiness');
  if (value.schema !== 'nexus.release-readiness.v1'
      || value.role !== 'staging'
      || value.runtimeSha !== request.runtimeSha
      || value.stabilitySeconds !== 60
      || !Number.isSafeInteger(value.readinessAttempts)
      || value.readinessAttempts < 1 || value.readinessAttempts > 60
      || typeof value.stabilityObservedSeconds !== 'number'
      || !Number.isFinite(value.stabilityObservedSeconds)
      || value.stabilityObservedSeconds < 60
      || !Array.isArray(value.services)) {
    fail('legacy staging readiness identity is invalid');
  }
  const checks = [
    'nativeBinding',
    'sqliteIntegrity',
    'sqliteForeignKeys',
    'backendHealth',
    'authenticatedBackendSnapshot',
    'authenticatedContentEngine',
    'pm2ExactIdentity',
    'pm2RestartStable',
  ];
  exactObject(value.checks, checks, 'legacy staging readiness checks');
  for (const check of checks) {
    if (value.checks?.[check] !== true) {
      fail(`legacy staging readiness check failed: ${check}`);
    }
  }
  const soak = value.soak;
  exactObject(soak, [
    'clock',
    'completedMonotonicNs',
    'final',
    'initial',
    'observedNanoseconds',
    'requiredSeconds',
    'schema',
    'startedMonotonicNs',
  ], 'legacy staging readiness soak');
  if (soak.schema !== 'nexus.release-readiness-soak.v1'
      || soak.clock !== 'monotonic' || soak.requiredSeconds !== 60
      || !/^[0-9]+$/u.test(soak.startedMonotonicNs ?? '')
      || !/^[0-9]+$/u.test(soak.completedMonotonicNs ?? '')
      || !/^[0-9]+$/u.test(soak.observedNanoseconds ?? '')) {
    fail('legacy staging readiness monotonic soak is invalid');
  }
  const started = BigInt(soak.startedMonotonicNs);
  const completed = BigInt(soak.completedMonotonicNs);
  const observed = BigInt(soak.observedNanoseconds);
  if (completed < started || completed - started !== observed
      || observed < 60_000_000_000n) {
    fail('legacy staging readiness did not prove the exact 60-second soak');
  }
  const endpoints = [];
  for (const [name, endpoint] of [
    ['initial', soak.initial],
    ['final', soak.final],
  ]) {
    exactObject(endpoint, [
      'backendSnapshotSha256',
      'backendUptime',
      'backendVersion',
      'contentReadySha256',
      'contentStatus',
      'internalAuthConfigured',
    ], `legacy staging readiness ${name} endpoints`);
    if (!DIGEST.test(endpoint.backendSnapshotSha256 ?? '')
        || !DIGEST.test(endpoint.contentReadySha256 ?? '')
        || typeof endpoint.backendVersion !== 'string'
        || endpoint.backendVersion.length === 0
        || typeof endpoint.backendUptime !== 'number'
        || !Number.isFinite(endpoint.backendUptime)
        || endpoint.backendUptime < 0
        || endpoint.contentStatus !== 'ready'
        || endpoint.internalAuthConfigured !== true) {
      fail(`legacy staging readiness ${name} endpoint evidence is invalid`);
    }
    endpoints.push(endpoint);
  }
  if (endpoints[1].backendVersion !== endpoints[0].backendVersion
      || endpoints[1].backendUptime < endpoints[0].backendUptime) {
    fail('legacy staging authenticated backend changed during the soak');
  }
  const wallStarted = canonicalTime(
    value.stabilityStartedAt,
    'legacy staging readiness stabilityStartedAt',
  );
  const wallCompleted = canonicalTime(
    value.stabilityCompletedAt,
    'legacy staging readiness stabilityCompletedAt',
  );
  const checkedAt = canonicalTime(
    value.checkedAt,
    'legacy staging readiness checkedAt',
  );
  if (wallCompleted < wallStarted || checkedAt < wallCompleted) {
    fail('legacy staging readiness wall-clock diagnostics are inconsistent');
  }
  validateRemoteIdentity({
    schema: 'nexus.pm2-release-identity.v1',
    services: value.services,
  }, request);
  return value;
}

function validateAttestations(installed, recovery, request) {
  if (installed?.schema !== 'nexus.installed-runtime-attestation.v1'
      || installed.identity?.schema !== 'nexus.installed-runtime-identity.v1'
      || installed.identity.runtimeSha !== request.runtimeSha
      || installed.identity.artifactDigest !== request.artifactDigest
      || !DIGEST.test(installed.aggregateDigest ?? '')
      || installed.aggregateDigest !== sha256(canonicalJson(installed.identity))) {
    fail('legacy staging installed runtime attestation is invalid');
  }
  if (recovery?.schema !== 'nexus.recovery-runtime-attestation.v1'
      || recovery.identity?.schema
        !== 'nexus.recovery-installed-runtime-identity.v1'
      || recovery.identity.runtimeSha !== request.runtimeSha
      || recovery.identity.artifactDigest !== request.artifactDigest
      || recovery.aggregateDigest !== sha256(canonicalJson(recovery.identity))) {
    fail('legacy staging recovery runtime attestation is invalid');
  }
}

function validateTransactionChronology(transaction) {
  exactObject(
    transaction,
    TRANSACTION_FIELDS,
    'legacy staging evidence transaction',
  );
  if (!DIGEST.test(transaction.databaseBackupSha256 ?? '')
      || !Number.isSafeInteger(transaction.databaseBackupSizeBytes)
      || transaction.databaseBackupSizeBytes <= 0
      || transaction.databaseBackupSizeBytes > MAX_DATABASE_BYTES
      || !DIGEST.test(transaction.journalSha256 ?? '')
      || transaction.stabilitySeconds !== 60
      || transaction.recoveryTargetSeconds !== 120) {
    fail('legacy staging evidence transaction policy is invalid');
  }
  const preparedAt = canonicalTime(
    transaction.preparedAt,
    'legacy staging preparedAt',
  );
  const switchedAt = canonicalTime(
    transaction.selectorSwitchedAt,
    'legacy staging selectorSwitchedAt',
  );
  const readinessAt = canonicalTime(
    transaction.readinessCompletedAt,
    'legacy staging readinessCompletedAt',
  );
  const publishedAt = canonicalTime(
    transaction.publishedAt,
    'legacy staging publishedAt',
  );
  if (!(preparedAt <= switchedAt && switchedAt <= readinessAt
      && readinessAt <= publishedAt)
      || publishedAt > Date.now() + CLOCK_SKEW_MS
      || Date.now() - publishedAt > MAX_STAGING_LIFETIME_MS) {
    fail('legacy staging evidence chronology is invalid or stale');
  }
}

export function validateBrokerEvidence(evidence, evidenceBody = null) {
  exactObject(evidence, [
    'artifactDigest',
    'base',
    'broker',
    'control',
    'currentSelector',
    'installedRuntimeAttestation',
    'predecessor',
    'promotionAllowed',
    'recoveryRuntimeAttestation',
    'releaseDir',
    'remoteIdentity',
    'remoteReadiness',
    'requestId',
    'runtimeSha',
    'schema',
    'sourceProvenance',
    'status',
    'transaction',
  ], 'legacy staging broker evidence');
  const request = {
    requestId: evidence.requestId,
    runtimeSha: evidence.runtimeSha,
    artifactDigest: evidence.artifactDigest,
    releaseDir: evidence.releaseDir,
  };
  if (evidence.schema !== BROKER_EVIDENCE_SCHEMA
      || evidence.status !== 'completed'
      || evidence.promotionAllowed !== false
      || !UUID.test(evidence.requestId ?? '')
      || !FULL_SHA.test(evidence.runtimeSha ?? '')
      || !DIGEST.test(evidence.artifactDigest ?? '')
      || evidence.base !== LEGACY_BASE
      || evidence.releaseDir !== expectedReleaseDir(
        evidence.runtimeSha,
        evidence.artifactDigest,
      )) {
    fail('legacy staging broker evidence identity is invalid');
  }
  validateBrokerIdentity(evidence.broker, 'legacy staging evidence broker');
  validateControlIdentity(evidence.control, 'legacy staging evidence control');
  validateSourceProvenance(evidence.sourceProvenance);
  exactObject(evidence.predecessor, PREDECESSOR_FIELDS, 'legacy staging predecessor');
  if (!FULL_SHA.test(evidence.predecessor.runtimeSha ?? '')
      || !DIGEST.test(evidence.predecessor.artifactDigest ?? '')
      || !DIGEST.test(evidence.predecessor.markerSha256 ?? '')
      || !DIGEST.test(
        evidence.predecessor.installedAttestationSha256 ?? '',
      )
      || !DIGEST.test(
        evidence.predecessor.recoveryAttestationSha256 ?? '',
      )
      || !DIGEST.test(evidence.predecessor.metadataSha256 ?? '')
      || !evidence.predecessor.runtime.startsWith(`${LEGACY_BASE}/releases/`)
      || evidence.predecessor.runtime === evidence.releaseDir) {
    fail('legacy staging predecessor identity is invalid');
  }
  validateRuntimeIdentity(
    evidence.predecessor.runtimeIdentity,
    'legacy staging predecessor runtime identity',
  );
  validateSelector(
    evidence.predecessor.selector,
    `${LEGACY_BASE}/current`,
    evidence.predecessor.runtime,
    'legacy staging predecessor selector',
  );
  validateSelector(
    evidence.currentSelector,
    `${LEGACY_BASE}/current`,
    evidence.releaseDir,
    'legacy staging current selector',
  );
  validateAttestations(
    evidence.installedRuntimeAttestation,
    evidence.recoveryRuntimeAttestation,
    request,
  );
  validateRemoteIdentity(evidence.remoteIdentity, request);
  validateReadiness(evidence.remoteReadiness, request);
  validateTransactionChronology(evidence.transaction);
  if (evidenceBody && sha256(evidenceBody) === evidence.transaction.journalSha256) {
    fail('legacy staging evidence incorrectly aliases its journal digest');
  }
  return evidence;
}

function validateProtectedSigning(signing, verifiedAt) {
  exactObject(signing, [
    'requestedAt',
    'runAttempt',
    'runId',
    'signedAt',
    'workflow',
  ], 'drill staging protected signing');
  const requestedAt = canonicalTime(
    signing.requestedAt,
    'drill staging signing requestedAt',
  );
  const signedAt = canonicalTime(
    signing.signedAt,
    'drill staging signing signedAt',
  );
  if (signing.workflow !== '.github/workflows/sign-staging-attestation.yml'
      || !RUN_ID.test(signing.runId ?? '')
      || !RUN_ID.test(signing.runAttempt ?? '')
      || requestedAt + GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS
        < Date.parse(verifiedAt)
      || requestedAt > signedAt
      || signedAt < Date.parse(verifiedAt)
      || signedAt > Date.now() + CLOCK_SKEW_MS) {
    fail('drill staging protected signing identity is invalid');
  }
}

export function validateLegacyStagingRequest(
  request,
  expectedRuntimeSha = '',
  { allowProtectedSigning = true } = {},
) {
  const fields = request?.protectedSigning === undefined
    ? STAGING_REQUEST_FIELDS
    : [...STAGING_REQUEST_FIELDS, 'protectedSigning'];
  exactObject(request, fields, 'legacy drill staging request');
  if (request.schema !== STAGING_REQUEST_SCHEMA
      || !UUID.test(request.requestId ?? '')
      || !FULL_SHA.test(request.runtimeSha ?? '')
      || (expectedRuntimeSha && request.runtimeSha !== expectedRuntimeSha)
      || !DIGEST.test(request.artifactDigest ?? '')
      || !DIGEST.test(request.releaseManifestSha256 ?? '')
      || !DIGEST.test(request.installedRuntimeDigest ?? '')
      || !DIGEST.test(request.recoveryRuntimeDigest ?? '')
      || request.releaseDir !== expectedReleaseDir(
        request.runtimeSha,
        request.artifactDigest,
      )) {
    fail('legacy drill staging request identity is invalid');
  }
  if (request.protectedSigning !== undefined) {
    if (!allowProtectedSigning) {
      fail('unsigned legacy drill staging request contains protected signing');
    }
    validateProtectedSigning(request.protectedSigning, request.verifiedAt);
  }
  if (request.smoke?.status !== 'passed'
      || request.smoke?.command !== 'scripts/remote-release-readiness.sh'
      || !DIGEST.test(request.smoke?.logSha256 ?? '')) {
    fail('legacy drill staging smoke evidence is invalid');
  }
  const verifiedAt = canonicalTime(
    request.verifiedAt,
    'legacy drill staging verifiedAt',
  );
  const expiresAt = canonicalTime(
    request.expiresAt,
    'legacy drill staging expiresAt',
  );
  if (expiresAt <= verifiedAt
      || expiresAt - verifiedAt > MAX_STAGING_LIFETIME_MS
      || expiresAt <= Date.now()) {
    fail('legacy drill staging request lifetime is invalid or expired');
  }
  validateRemoteIdentity(request.remoteIdentity, request);
  validateReadiness(request.remoteReadiness, request);
  const bootstrap = request.drillBootstrap;
  exactObject(bootstrap, BOOTSTRAP_FIELDS, 'legacy drill bootstrap');
  if (bootstrap.schema !== BOOTSTRAP_SCHEMA
      || bootstrap.profile !== PROFILE
      || bootstrap.promotionAllowed !== false
      || bootstrap.base !== LEGACY_BASE
      || bootstrap.transactionId !== request.requestId
      || !DIGEST.test(bootstrap.brokerReceiptSha256 ?? '')) {
    fail('legacy drill bootstrap identity is invalid');
  }
  validateBrokerIdentity(bootstrap.broker, 'legacy drill bootstrap broker');
  validateControlIdentity(bootstrap.control, 'legacy drill bootstrap control');
  exactObject(
    bootstrap.predecessor,
    PREDECESSOR_FIELDS,
    'legacy drill bootstrap predecessor',
  );
  if (!FULL_SHA.test(bootstrap.predecessor.runtimeSha ?? '')
      || !DIGEST.test(bootstrap.predecessor.artifactDigest ?? '')
      || !DIGEST.test(bootstrap.predecessor.markerSha256 ?? '')
      || !DIGEST.test(
        bootstrap.predecessor.installedAttestationSha256 ?? '',
      )
      || !DIGEST.test(
        bootstrap.predecessor.recoveryAttestationSha256 ?? '',
      )
      || !DIGEST.test(bootstrap.predecessor.metadataSha256 ?? '')
      || !bootstrap.predecessor.runtime.startsWith(`${LEGACY_BASE}/releases/`)
      || bootstrap.predecessor.runtime === request.releaseDir) {
    fail('legacy drill bootstrap predecessor is invalid');
  }
  validateRuntimeIdentity(
    bootstrap.predecessor.runtimeIdentity,
    'legacy drill bootstrap predecessor runtime identity',
  );
  validateSourceProvenance(bootstrap.sourceProvenance);
  validateSelector(
    bootstrap.predecessor.selector,
    `${LEGACY_BASE}/current`,
    bootstrap.predecessor.runtime,
    'legacy drill bootstrap predecessor selector',
  );
  validateSelector(
    bootstrap.currentSelector,
    `${LEGACY_BASE}/current`,
    request.releaseDir,
    'legacy drill bootstrap current selector',
  );
  validateTransactionChronology(bootstrap.transaction);
  return request;
}

function atomicWrite(output, body) {
  const resolved = path.resolve(output);
  const parent = path.dirname(resolved);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.lstatSync(resolved, { throwIfNoEntry: false })) {
    fail('legacy staging adapter output path is unsafe or already exists');
  }
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.next.${process.pid}.${Date.now()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, resolved);
    const directory = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function operatorCheckpointIdentity(values) {
  const requestId = required(values, '--request-id');
  const runtimeSha = required(values, '--runtime-sha');
  const artifactDigest = required(values, '--artifact-digest');
  const base = required(values, '--base');
  const broker = required(values, '--broker');
  const server = required(values, '--server');
  if (!UUID.test(requestId) || !FULL_SHA.test(runtimeSha)
      || !DIGEST.test(artifactDigest)) {
    fail('legacy staging operator checkpoint release identity is invalid');
  }
  if (base !== LEGACY_BASE
      || broker !== '/usr/local/sbin/nexus-rollback-drill-legacy-staging-broker'
      || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$/u.test(server)) {
    fail('legacy staging operator checkpoint remote identity is invalid');
  }
  const releaseDir = required(values, '--release-dir');
  if (releaseDir !== expectedReleaseDir(runtimeSha, artifactDigest, base)) {
    fail('legacy staging operator checkpoint release directory differs');
  }
  const manifest = readStableFile(
    required(values, '--manifest'),
    MAX_MANIFEST_BYTES,
    'operator checkpoint release manifest',
  );
  const evidenceBase = path.resolve(required(values, '--evidence-base'));
  const evidenceParent = path.dirname(evidenceBase);
  const expectedName = `${runtimeSha}-${artifactDigest}-${requestId}`;
  const parentStat = fs.lstatSync(evidenceParent);
  if (path.basename(evidenceBase) !== expectedName
      || !parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.realpathSync.native(evidenceParent) !== evidenceParent
      || (parentStat.mode & 0o7777) !== 0o700
      || (process.getuid && parentStat.uid !== process.getuid())) {
    fail('legacy staging operator checkpoint directory is unsafe');
  }
  return {
    schema: OPERATOR_CHECKPOINT_SCHEMA,
    requestId,
    runtimeSha,
    artifactDigest,
    releaseManifestSha256: sha256(manifest.body),
    releaseDir,
    server,
    base,
    broker,
    evidenceBase,
    evidence: {
      brokerInspection: `${evidenceBase}.broker-inspection.json`,
      transactionRequest: `${evidenceBase}.transaction-request.json`,
      rootEvidence: `${evidenceBase}.root-evidence.json`,
      stagingRequest: `${evidenceBase}.request.json`,
      signedBundle: `${evidenceBase}.bundle`,
    },
  };
}

function validateOperatorCheckpoint(value, expected) {
  exactObject(value, OPERATOR_CHECKPOINT_FIELDS, 'operator checkpoint');
  exactObject(
    value.evidence,
    OPERATOR_EVIDENCE_FIELDS,
    'operator checkpoint evidence',
  );
  canonicalTime(value.createdAt, 'operator checkpoint createdAt');
  for (const field of [
    'schema',
    'requestId',
    'runtimeSha',
    'artifactDigest',
    'releaseManifestSha256',
    'releaseDir',
    'server',
    'base',
    'broker',
    'evidenceBase',
  ]) {
    const expectedValue = field === 'schema'
      ? OPERATOR_CHECKPOINT_SCHEMA
      : expected[field];
    if (value[field] !== expectedValue) {
      fail(`operator checkpoint ${field} differs`);
    }
  }
  for (const field of OPERATOR_EVIDENCE_FIELDS) {
    if (value.evidence[field] !== expected.evidence[field]) {
      fail(`operator checkpoint evidence ${field} differs`);
    }
  }
  return value;
}

function ensureOperatorCheckpoint(values) {
  const expected = operatorCheckpointIdentity(values);
  const output = path.resolve(required(values, '--output'));
  if (output !== `${expected.evidenceBase}.checkpoint.json`) {
    fail('operator checkpoint path differs from its exact request identity');
  }
  const existing = fs.lstatSync(output, { throwIfNoEntry: false });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()
        || existing.nlink !== 1 || (existing.mode & 0o7777) !== 0o600
        || (process.getuid && existing.uid !== process.getuid())) {
      fail('operator checkpoint is not a private owner regular file');
    }
    const evidence = readStableJson(
      output,
      128 * 1024,
      'legacy staging operator checkpoint',
    );
    validateOperatorCheckpoint(evidence.value, expected);
    return {
      ...evidence.value,
      checkpoint: output,
      checkpointSha256: sha256(evidence.body),
      resumed: true,
    };
  }
  const value = {
    ...expected,
    createdAt: new Date().toISOString(),
  };
  atomicWrite(output, `${JSON.stringify(value, null, 2)}\n`);
  const evidence = readStableFile(
    output,
    128 * 1024,
    'legacy staging operator checkpoint',
  );
  return {
    ...value,
    checkpoint: output,
    checkpointSha256: sha256(evidence.body),
    resumed: false,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--') || index + 1 >= argv.length) {
      fail(`invalid argument: ${key}`);
    }
    if (values.has(key)) fail(`duplicate argument: ${key}`);
    values.set(key, argv[index + 1]);
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values.get(name) ?? '';
  if (!value) fail(`${name} is required`);
  return value;
}

function verifyBundle(rootInput, runtimeSha, artifactDigest) {
  if (!FULL_SHA.test(runtimeSha) || !DIGEST.test(artifactDigest)) {
    fail('bundle expected identity is invalid');
  }
  const root = path.resolve(rootInput);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || fs.realpathSync.native(root) !== root) {
    fail('release bundle root is not a canonical directory');
  }
  const metadata = (name) => {
    const evidence = readStableJson(
      path.join(root, name),
      MAX_MANIFEST_BYTES,
      `release bundle ${name}`,
    );
    return evidence.value;
  };
  const declared = metadata('artifact-manifest.json');
  const marker = metadata('.complete.json');
  if (declared?.schema !== 'nexus.release-artifact-manifest.v1'
      || !Array.isArray(declared.files)
      || declared.git?.sha !== runtimeSha) {
    fail('release artifact manifest identity is invalid');
  }
  const safeRelative = (value) => typeof value === 'string'
    && value.length > 0 && value.length <= 4096
    && !path.posix.isAbsolute(value) && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && path.posix.normalize(value) === value
    && value.split('/').every((part) => (
      part !== '' && part !== '.' && part !== '..'
    ));
  const files = [];
  const seen = new Set();
  let previous = '';
  for (const entry of declared.files) {
    const relative = entry?.path;
    if (!safeRelative(relative) || seen.has(relative)
        || (previous && previous >= relative)
        || !Number.isSafeInteger(entry?.size) || entry.size < 0
        || !DIGEST.test(entry?.sha256 ?? '')) {
      fail('release artifact file declaration is invalid');
    }
    seen.add(relative);
    previous = relative;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`)) {
      fail('release artifact escapes its root');
    }
    const evidence = readStableFile(
      absolute,
      Math.max(entry.size, 1) + 1,
      `release artifact ${relative}`,
      { allowEmpty: true },
    );
    if (evidence.body.length !== entry.size
        || sha256(evidence.body) !== entry.sha256) {
      fail(`release artifact byte identity mismatch: ${relative}`);
    }
    files.push({
      path: relative,
      size: evidence.body.length,
      sha256: entry.sha256,
    });
  }
  const aggregate = sha256(Buffer.from(JSON.stringify({
    schema: 'nexus.release-artifact-manifest.v1',
    files,
  })));
  if (declared.digest !== aggregate || aggregate !== artifactDigest
      || declared.fileCount !== files.length
      || marker?.schema !== 'nexus.release-bundle.v1'
      || marker.runtimeSha !== runtimeSha
      || marker.artifactDigest !== artifactDigest
      || marker.fileCount !== files.length) {
    fail('release bundle aggregate identity is invalid');
  }
  const actual = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`release bundle contains a symlink: ${relative}`);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) actual.push(relative);
      else fail(`release bundle contains an unsupported entry: ${relative}`);
    }
  };
  walk(root);
  const expected = [
    ...files.map((entry) => entry.path),
    '.complete.json',
    'artifact-manifest.json',
  ].sort();
  if (actual.sort().join('\n') !== expected.join('\n')) {
    fail('release bundle contains undeclared or missing entries');
  }
  return { runtimeSha, artifactDigest, fileCount: files.length };
}

function assertRootExecution() {
  if (process.env.NODE_ENV !== 'test' && process.getuid?.() !== 0) {
    fail('SQLite recovery operations require root');
  }
}

function assertPrivateDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync.native(resolved) !== resolved
      || (stat.mode & 0o7777) !== 0o700
      || (process.env.NODE_ENV !== 'test'
        && (stat.uid !== 0 || stat.gid !== 0))) {
    fail(`${label} is not a canonical private root directory`);
  }
  return resolved;
}

function assertExecutable(file, expected, label) {
  const resolved = path.resolve(file);
  if (process.env.NODE_ENV !== 'test' && resolved !== expected) {
    fail(`${label} path differs from the reviewed production path`);
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || (stat.mode & 0o111) === 0
      || (process.env.NODE_ENV !== 'test'
        && (stat.uid !== 0 || stat.gid !== 0))) {
    fail(`${label} is not a trusted executable`);
  }
}

function validateSqliteRuntime() {
  if (!fs.lstatSync(SQLITE_HELPER, { throwIfNoEntry: false })) {
    fail('trusted SQLite recovery helper is unavailable');
  }
  const helper = readStableFile(
    SQLITE_HELPER,
    1024 * 1024,
    'trusted SQLite recovery helper',
  );
  const stat = fs.lstatSync(helper.resolved);
  if (sha256(helper.body) !== EXPECTED_SQLITE_HELPER_SHA256
      || (process.env.NODE_ENV !== 'test'
        && (helper.resolved
          !== '/usr/local/libexec/nexus-application-dr/application-dr-sqlite.py'
          || stat.uid !== 0 || stat.gid !== 0
          || (stat.mode & 0o7777) !== 0o644))) {
    fail('trusted SQLite recovery helper identity mismatch');
  }
  assertExecutable(PYTHON_BIN, '/usr/bin/python3', 'trusted Python');
  assertExecutable(FUSER_BIN, '/usr/bin/fuser', 'trusted fuser');
  const filesystemHelper = readStableFile(
    FILESYSTEM_HELPER,
    2 * 1024 * 1024,
    'descriptor-bound filesystem helper',
  );
  const filesystemStat = fs.lstatSync(filesystemHelper.resolved);
  if (process.env.NODE_ENV !== 'test'
      && (filesystemHelper.resolved
        !== '/usr/local/libexec/nexus-rollback-drill-legacy-staging-fs.py'
        || filesystemStat.uid !== 0 || filesystemStat.gid !== 0
        || (filesystemStat.mode & 0o7777) !== 0o700)) {
    fail('descriptor-bound filesystem helper identity mismatch');
  }
}

function databasePaths(requestId) {
  if (!UUID.test(requestId)) fail('database recovery request id is invalid');
  const transactionRoot = assertPrivateDirectory(
    DATABASE_TRANSACTION_ROOT,
    'database transaction root',
  );
  const transactionDirectory = assertPrivateDirectory(
    path.join(transactionRoot, requestId),
    'database transaction directory',
  );
  if (path.dirname(transactionDirectory) !== transactionRoot) {
    fail('database transaction directory escapes its root');
  }
  return {
    transactionDirectory,
    source: path.join(LEGACY_BASE, 'data', 'bot.db'),
    journal: path.join(transactionDirectory, 'journal.json'),
  };
}

function backupIdentity(value, label) {
  exactObject(value, DATABASE_BACKUP_FIELDS, label);
  if (value.schema !== DATABASE_BACKUP_SCHEMA
      || !DIGEST.test(value.sha256 ?? '')
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes <= 0 || value.sizeBytes > MAX_DATABASE_BYTES
      || !Number.isSafeInteger(value.uid) || value.uid < 0
      || !Number.isSafeInteger(value.gid) || value.gid < 0
      || !Number.isSafeInteger(value.mode) || value.mode < 0
      || value.mode > 0o7777
      || !/^[1-9][0-9]*$/u.test(value.parentDev ?? '')
      || !/^[1-9][0-9]*$/u.test(value.parentIno ?? '')
      || !/^[1-9][0-9]*$/u.test(value.sourceDev ?? '')
      || !/^[1-9][0-9]*$/u.test(value.sourceIno ?? '')) {
    fail(`${label} identity is invalid`);
  }
  canonicalTime(value.createdAt, `${label} createdAt`);
  return value;
}

function runFilesystemDatabase(operation, paths, identity = null) {
  const arguments_ = [
    FILESYSTEM_HELPER,
    operation,
    '--base', LEGACY_BASE,
    '--database', paths.source,
    '--transaction-directory', paths.transactionDirectory,
    '--fuser', FUSER_BIN,
  ];
  if (process.env.NODE_ENV === 'test') {
    arguments_.push('--test-mode');
    const marker =
      process.env.NEXUS_LEGACY_DRILL_TEST_DATABASE_FD_OPEN_MARKER;
    const resume =
      process.env.NEXUS_LEGACY_DRILL_TEST_DATABASE_FD_RESUME_MARKER;
    if (marker && resume && path.isAbsolute(marker) && path.isAbsolute(resume)) {
      arguments_.push(
        '--database-marker', path.resolve(marker),
        '--database-resume', path.resolve(resume),
      );
    }
  }
  if (identity) {
    arguments_.push('--database-identity', JSON.stringify(identity));
  }
  const result = spawnSync(PYTHON_BIN, arguments_, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = String(result.stderr ?? '').trim();
    fail(message || `descriptor-bound database ${operation} failed`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`descriptor-bound database ${operation} result is invalid JSON`);
  }
}

function snapshotDatabase(requestId) {
  assertRootExecution();
  validateSqliteRuntime();
  const paths = databasePaths(requestId);
  const result = runFilesystemDatabase('snapshot-database', paths);
  exactObject(result, ['databaseBackup'], 'database snapshot result');
  return backupIdentity(
    result.databaseBackup,
    'database recovery point',
  );
}

function restoreDatabase(requestId, journalInput) {
  assertRootExecution();
  validateSqliteRuntime();
  const paths = databasePaths(requestId);
  if (path.resolve(journalInput) !== paths.journal) {
    fail('database recovery journal path is not request-bound');
  }
  if (!fs.lstatSync(paths.journal, { throwIfNoEntry: false })) {
    fail('database recovery journal is unavailable');
  }
  const journalEvidence = readStableJson(
    paths.journal,
    MAX_JOURNAL_BYTES,
    'database recovery journal',
  );
  const journalStat = fs.lstatSync(journalEvidence.resolved);
  if ((journalStat.mode & 0o7777) !== 0o600
      || (process.env.NODE_ENV !== 'test'
        && (journalStat.uid !== 0 || journalStat.gid !== 0))
      || journalEvidence.value?.schema
        !== 'nexus.rollback-drill-legacy-staging-journal.v1'
      || journalEvidence.value?.requestId !== requestId
      || !new Set([
        'outage_armed',
        'selector_switched',
        'candidate_started',
        'readiness_passed',
      ]).has(journalEvidence.value?.phase)) {
    fail('database recovery journal identity is invalid');
  }
  const expected = backupIdentity(
    journalEvidence.value.databaseBackup,
    'journaled database recovery point',
  );
  const restored = runFilesystemDatabase(
    'restore-database',
    paths,
    expected,
  );
  exactObject(restored, [
    'databaseBackupSha256',
    'databaseBackupSizeBytes',
    'ok',
  ], 'database restore result');
  if (restored.ok !== true
      || restored.databaseBackupSha256 !== expected.sha256
      || restored.databaseBackupSizeBytes !== expected.sizeBytes) {
    fail('restored staging database identity mismatch');
  }
  return expected;
}

function validateStagingRequestSources(
  request,
  manifestEvidence,
  manifest,
  evidenceInput,
  evidence,
) {
  if (evidence.runtimeSha !== manifest.payload.runtimeSha
      || evidence.artifactDigest !== manifest.payload.artifact.digest
      || evidence.sourceProvenance.releaseManifestSha256
        !== sha256(manifestEvidence.body)
      || evidence.sourceProvenance.releaseManifestPayloadSha256
        !== sha256(canonicalJson(manifest.payload))
      || evidence.sourceProvenance.releaseManifestSignatureSha256
        !== sha256(Buffer.from(manifest.signature, 'base64'))
      || evidence.sourceProvenance.releaseManifestSigningRunId
        !== String(manifest.payload.ci?.runId ?? '')
      || evidence.sourceProvenance.releaseManifestSigningRunSha256
        !== sha256(canonicalJson(manifest.payload.ci))) {
    fail('legacy staging broker evidence differs from the release manifest');
  }
  const validated = validateLegacyStagingRequest(
    request,
    manifest.payload.runtimeSha,
    { allowProtectedSigning: false },
  );
  const expected = {
    schema: STAGING_REQUEST_SCHEMA,
    requestId: evidence.requestId,
    runtimeSha: evidence.runtimeSha,
    artifactDigest: evidence.artifactDigest,
    releaseManifestSha256: sha256(manifestEvidence.body),
    installedRuntimeDigest:
      evidence.installedRuntimeAttestation.aggregateDigest,
    recoveryRuntimeDigest:
      evidence.recoveryRuntimeAttestation.aggregateDigest,
    releaseDir: evidence.releaseDir,
    remoteIdentity: evidence.remoteIdentity,
    remoteReadiness: evidence.remoteReadiness,
    smoke: {
      status: 'passed',
      command: 'scripts/remote-release-readiness.sh',
      logSha256: sha256(canonicalJson(evidence.remoteReadiness)),
    },
    drillBootstrap: {
      schema: BOOTSTRAP_SCHEMA,
      profile: PROFILE,
      promotionAllowed: false,
      transactionId: evidence.requestId,
      base: evidence.base,
      broker: evidence.broker,
      control: evidence.control,
      predecessor: evidence.predecessor,
      currentSelector: evidence.currentSelector,
      sourceProvenance: evidence.sourceProvenance,
      brokerReceiptSha256: sha256(evidenceInput.body),
      transaction: evidence.transaction,
    },
    verifiedAt: validated.verifiedAt,
    expiresAt: validated.expiresAt,
  };
  if (canonicalJson(validated) !== canonicalJson(expected)) {
    fail('legacy drill staging request differs from its exact source evidence');
  }
  return validated;
}

function main() {
  const [command = '', ...argv] = process.argv.slice(2);
  const values = parseArgs(argv);
  if (command === 'build-transaction-request') {
    const manifestEvidence = readStableFile(
      required(values, '--manifest'),
      MAX_MANIFEST_BYTES,
      'release manifest',
    );
    const publicKey = resolvePublicKey(values.get('--public-key'));
    const manifest = validateManifestBody(manifestEvidence.body, publicKey);
    const inspection = validateInspection(
      readStableJson(
        required(values, '--inspection'),
        128 * 1024,
        'legacy staging broker inspection',
      ).value,
    );
    const requestId = required(values, '--request-id');
    if (!UUID.test(requestId)) fail('legacy staging request id is invalid');
    const issuedAt = new Date();
    const request = {
      schema: TRANSACTION_REQUEST_SCHEMA,
      purpose: PROFILE,
      promotionAllowed: false,
      requestId,
      runtimeSha: manifest.payload.runtimeSha,
      artifactDigest: manifest.payload.artifact.digest,
      base: LEGACY_BASE,
      releaseDir: expectedReleaseDir(
        manifest.payload.runtimeSha,
        manifest.payload.artifact.digest,
      ),
      broker: inspection.broker,
      control: inspection.control,
      releaseManifestSha256: sha256(manifestEvidence.body),
      releaseManifestPayloadSha256: sha256(canonicalJson(manifest.payload)),
      releaseManifestSignatureSha256: sha256(
        Buffer.from(manifest.signature, 'base64'),
      ),
      releaseManifestSigningRunId: String(manifest.payload.ci.runId),
      releaseManifestSigningRunSha256: sha256(
        canonicalJson(manifest.payload.ci),
      ),
      releaseManifestBase64: manifestEvidence.body.toString('base64'),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        issuedAt.getTime() + MAX_TRANSACTION_LIFETIME_MS,
      ).toISOString(),
    };
    validateTransactionRequest(request, {
      publicKeyBody: publicKey,
      expectedRequestId: requestId,
      expectedBrokerSha256: inspection.broker.sha256,
      expectedAdapterSha256: inspection.broker.adapterSha256,
    });
    atomicWrite(
      required(values, '--output'),
      `${JSON.stringify(request, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      requestId,
      runtimeSha: request.runtimeSha,
      artifactDigest: request.artifactDigest,
      releaseDir: request.releaseDir,
    })}\n`);
  } else if (command === 'validate-transaction-request') {
    const request = readStableJson(
      required(values, '--request'),
      MAX_REQUEST_BYTES,
      'legacy staging transaction request',
    ).value;
    const validated = validateTransactionRequest(request, {
      publicKeyBody: resolvePublicKey(values.get('--public-key')),
      expectedRequestId: values.get('--expect-request-id') ?? '',
      expectedBrokerSha256: values.get('--expect-broker-sha256') ?? '',
      expectedAdapterSha256:
        values.get('--expect-adapter-sha256') ?? '',
      allowExpired: values.get('--allow-expired-resume') === 'true',
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      requestId: validated.request.requestId,
      runtimeSha: validated.request.runtimeSha,
      artifactDigest: validated.request.artifactDigest,
      releaseDir: validated.request.releaseDir,
    })}\n`);
  } else if (command === 'verify-bundle') {
    const result = verifyBundle(
      required(values, '--bundle'),
      required(values, '--runtime-sha'),
      required(values, '--artifact-digest'),
    );
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } else if (command === 'snapshot-database') {
    const identity = snapshotDatabase(required(values, '--request-id'));
    process.stdout.write(`${JSON.stringify({
      databaseBackup: identity,
    })}\n`);
  } else if (command === 'restore-database') {
    const identity = restoreDatabase(
      required(values, '--request-id'),
      required(values, '--journal'),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      databaseBackupSha256: identity.sha256,
      databaseBackupSizeBytes: identity.sizeBytes,
    })}\n`);
  } else if (command === 'validate-broker-evidence') {
    const evidence = readStableJson(
      required(values, '--evidence'),
      MAX_EVIDENCE_BYTES,
      'legacy staging broker evidence',
    );
    const validated = validateBrokerEvidence(evidence.value, evidence.body);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      requestId: validated.requestId,
      runtimeSha: validated.runtimeSha,
      artifactDigest: validated.artifactDigest,
    })}\n`);
  } else if (command === 'build-staging-request') {
    const manifestEvidence = readStableFile(
      required(values, '--manifest'),
      MAX_MANIFEST_BYTES,
      'release manifest',
    );
    const manifest = validateManifestBody(
      manifestEvidence.body,
      resolvePublicKey(values.get('--public-key')),
    );
    const evidenceInput = readStableJson(
      required(values, '--evidence'),
      MAX_EVIDENCE_BYTES,
      'legacy staging broker evidence',
    );
    const evidence = validateBrokerEvidence(
      evidenceInput.value,
      evidenceInput.body,
    );
    const verifiedAt = new Date();
    const request = {
      schema: STAGING_REQUEST_SCHEMA,
      requestId: evidence.requestId,
      runtimeSha: evidence.runtimeSha,
      artifactDigest: evidence.artifactDigest,
      releaseManifestSha256: sha256(manifestEvidence.body),
      installedRuntimeDigest:
        evidence.installedRuntimeAttestation.aggregateDigest,
      recoveryRuntimeDigest:
        evidence.recoveryRuntimeAttestation.aggregateDigest,
      releaseDir: evidence.releaseDir,
      remoteIdentity: evidence.remoteIdentity,
      remoteReadiness: evidence.remoteReadiness,
      smoke: {
        status: 'passed',
        command: 'scripts/remote-release-readiness.sh',
        logSha256: sha256(canonicalJson(evidence.remoteReadiness)),
      },
      drillBootstrap: {
        schema: BOOTSTRAP_SCHEMA,
        profile: PROFILE,
        promotionAllowed: false,
        transactionId: evidence.requestId,
        base: evidence.base,
        broker: evidence.broker,
        control: evidence.control,
        predecessor: evidence.predecessor,
        currentSelector: evidence.currentSelector,
        sourceProvenance: evidence.sourceProvenance,
        brokerReceiptSha256: sha256(evidenceInput.body),
        transaction: evidence.transaction,
      },
      verifiedAt: verifiedAt.toISOString(),
      expiresAt: new Date(
        verifiedAt.getTime() + MAX_STAGING_LIFETIME_MS,
      ).toISOString(),
    };
    validateStagingRequestSources(
      request,
      manifestEvidence,
      manifest,
      evidenceInput,
      evidence,
    );
    atomicWrite(
      required(values, '--output'),
      `${JSON.stringify(request, null, 2)}\n`,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      rollbackDrillEligible: false,
      reason: 'protected_drill_signature_required',
      requestId: request.requestId,
      runtimeSha: request.runtimeSha,
    })}\n`);
  } else if (command === 'validate-staging-request') {
    const requestEvidence = readStableJson(
      required(values, '--request'),
      MAX_EVIDENCE_BYTES,
      'legacy drill staging request',
    );
    let validated;
    if (values.get('--manifest') || values.get('--evidence')) {
      if (!values.get('--manifest') || !values.get('--evidence')) {
        fail('staging request source validation requires manifest and evidence');
      }
      const manifestEvidence = readStableFile(
        required(values, '--manifest'),
        MAX_MANIFEST_BYTES,
        'release manifest',
      );
      const manifest = validateManifestBody(
        manifestEvidence.body,
        resolvePublicKey(values.get('--public-key')),
      );
      const evidenceInput = readStableJson(
        required(values, '--evidence'),
        MAX_EVIDENCE_BYTES,
        'legacy staging broker evidence',
      );
      const evidence = validateBrokerEvidence(
        evidenceInput.value,
        evidenceInput.body,
      );
      validated = validateStagingRequestSources(
        requestEvidence.value,
        manifestEvidence,
        manifest,
        evidenceInput,
        evidence,
      );
    } else {
      validated = validateLegacyStagingRequest(
        requestEvidence.value,
        values.get('--expect-runtime-sha') ?? '',
      );
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      requestId: validated.requestId,
      runtimeSha: validated.runtimeSha,
      drillBootstrapSha256: sha256(canonicalJson(validated.drillBootstrap)),
    })}\n`);
  } else if (command === 'validate-inspection') {
    const inspection = validateInspection(
      readStableJson(
        required(values, '--inspection'),
        128 * 1024,
        'legacy staging broker inspection',
      ).value,
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      base: inspection.base,
      broker: inspection.broker,
      control: inspection.control,
    })}\n`);
  } else if (command === 'ensure-operator-checkpoint') {
    const checkpoint = ensureOperatorCheckpoint(values);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      promotable: false,
      requestId: checkpoint.requestId,
      runtimeSha: checkpoint.runtimeSha,
      artifactDigest: checkpoint.artifactDigest,
      checkpoint: checkpoint.checkpoint,
      checkpointSha256: checkpoint.checkpointSha256,
      resumed: checkpoint.resumed,
    })}\n`);
  } else {
    fail(
      'Usage: rollback-drill-legacy-staging-adapter.mjs '
        + '<build-transaction-request|validate-transaction-request|'
        + 'verify-bundle|snapshot-database|restore-database|'
        + 'validate-broker-evidence|build-staging-request|'
        + 'validate-staging-request|validate-inspection|'
        + 'ensure-operator-checkpoint>',
    );
  }
}

const mainUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === mainUrl) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `rollback_drill_legacy_staging_adapter_failed:${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }
}
