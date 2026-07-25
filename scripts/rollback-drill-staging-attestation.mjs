#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(valueOf('--root', process.cwd()));
const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowTestKey = has('--allow-test-key') && process.env.NODE_ENV === 'test';

const REQUEST_SCHEMA = 'nexus.rollback-drill-staging-signing-request.v1';
const RECORD_SCHEMA = 'nexus.rollback-drill-staging-bundle.v1';
const RECORD_PAYLOAD_SCHEMA = 'nexus.rollback-drill-staging-bundle-payload.v1';
const MANIFEST_SCHEMA = 'nexus.release-manifest.v2';
const STAGING_REQUEST_SCHEMA = 'nexus.staging-attestation-request.v1';
const STAGING_SCHEMA = 'nexus.staging-attestation.v1';
const ORDINARY_KEY_ID = 'github-environment-release-signing-2026-07';
const RECORD_KEY_ID = 'github-environment-rollback-drill-staging-signing-2026-07';
const SIGNING_WORKFLOW = '.github/workflows/sign-staging-attestation.yml';
const SIGNING_KIND = 'rollback_drill_staging';
const SCOPE = 'isolated-kvm-first-drill';
const PRODUCTION_PUBLIC_KEY = 'docs/release/evidence/release-evidence-public-key.pem';
const MAX_STAGING_REQUEST_BYTES = 24 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FULL_SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[1-9][0-9]*$/u;

const REQUEST_KEYS = [
  'artifactDigest',
  'expiresAt',
  'installedRuntimeDigest',
  'manifestSigningRunId',
  'recoveryRuntimeDigest',
  'releaseManifestPayloadSha256',
  'releaseManifestSha256',
  'requestId',
  'runtimeSha',
  'schema',
  'stagingRequestBase64',
  'stagingRequestSha256',
  'verifiedAt',
].sort();

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== expected.join(',')) {
    throw new Error(`${label} schema contains missing or unknown fields`);
  }
}

function resolveFile(name, fallback = '') {
  const value = valueOf(name, fallback);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(root, value);
}

function readBounded(file, maximum, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size <= 0 || stat.size > maximum) {
    throw new Error(`${label} is not a bounded single-link regular file`);
  }
  return fs.readFileSync(file);
}

function readPem(name, envName, fallback = '') {
  const explicit = valueOf(name);
  if (explicit) return fs.readFileSync(path.resolve(root, explicit), 'utf8');
  if (process.env[envName]) return process.env[envName];
  const fallbackPath = fallback ? path.resolve(toolingRoot, fallback) : '';
  return fallbackPath && fs.existsSync(fallbackPath)
    ? fs.readFileSync(fallbackPath, 'utf8')
    : '';
}

function publicKeyDer(pem, label) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${label} is not an Ed25519 public key`);
  }
  return key.export({ type: 'spki', format: 'der' });
}

function assertDistinctKeys(drillPem, productionPem) {
  if (publicKeyDer(drillPem, 'rollback-drill staging public key')
    .equals(publicKeyDer(productionPem, 'production release public key'))) {
    throw new Error('rollback-drill staging key must be distinct from the production release key');
  }
}

function parseCanonicalBase64(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const body = Buffer.from(value, 'base64');
  if (body.length === 0 || body.length > maximum || body.toString('base64') !== value) {
    throw new Error(`${label} is invalid or exceeds its size limit`);
  }
  return body;
}

function validateOrdinaryStagingRequest(body, expectedRuntimeSha = '') {
  if (!Buffer.isBuffer(body) || body.length === 0
      || body.length > MAX_STAGING_REQUEST_BYTES) {
    throw new Error('ordinary staging request is empty or too large');
  }
  let request;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('ordinary staging request is not valid JSON');
  }
  if (request?.schema !== STAGING_REQUEST_SCHEMA) {
    throw new Error('ordinary staging request schema is invalid');
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-rollback-drill-staging-request-'),
  );
  fs.chmodSync(temporaryRoot, 0o700);
  const requestPath = path.join(temporaryRoot, 'staging-request.json');
  try {
    fs.writeFileSync(requestPath, body, { mode: 0o600, flag: 'wx' });
    const validationArgs = [
      path.join(toolingRoot, 'scripts/release-staging-attestation.mjs'),
      'validate-request',
      '--root', root,
      '--request', requestPath,
    ];
    if (expectedRuntimeSha) validationArgs.push('--expect-runtime-sha', expectedRuntimeSha);
    execFileSync(process.execPath, validationArgs, {
      cwd: toolingRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return request;
}

function canonicalGithubTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? '');
  if (typeof value !== 'string' || !/Z$/u.test(value)
      || !Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== value
      || milliseconds > Date.now() + 5 * 60_000) {
    throw new Error(`${label} is not a canonical UTC GitHub timestamp`);
  }
  return milliseconds;
}

function validateRequest(request, expectedRuntimeSha = '') {
  assertExactKeys(request, REQUEST_KEYS, 'rollback-drill staging signing request');
  if (request.schema !== REQUEST_SCHEMA || !UUID.test(request.requestId ?? '')
      || !RUN_ID.test(request.manifestSigningRunId ?? '')) {
    throw new Error('rollback-drill staging signing request identity is invalid');
  }
  if (!FULL_SHA.test(request.runtimeSha ?? '')
      || (expectedRuntimeSha && request.runtimeSha !== expectedRuntimeSha)) {
    throw new Error('rollback-drill staging runtime SHA is invalid or mismatched');
  }
  for (const field of [
    'artifactDigest',
    'installedRuntimeDigest',
    'recoveryRuntimeDigest',
    'releaseManifestSha256',
    'releaseManifestPayloadSha256',
    'stagingRequestSha256',
  ]) {
    if (!DIGEST.test(request[field] ?? '')) {
      throw new Error(`rollback-drill staging ${field} is invalid`);
    }
  }
  const stagingBody = parseCanonicalBase64(
    request.stagingRequestBase64,
    'ordinary staging request',
    MAX_STAGING_REQUEST_BYTES,
  );
  if (sha256(stagingBody) !== request.stagingRequestSha256) {
    throw new Error('ordinary staging request digest mismatch');
  }
  const staging = validateOrdinaryStagingRequest(stagingBody, request.runtimeSha);
  for (const field of [
    'requestId',
    'runtimeSha',
    'artifactDigest',
    'releaseManifestSha256',
    'installedRuntimeDigest',
    'recoveryRuntimeDigest',
    'verifiedAt',
    'expiresAt',
  ]) {
    if (request[field] !== staging[field]) {
      throw new Error(`rollback-drill staging source binding mismatch: ${field}`);
    }
  }
  return { request, staging, stagingBody };
}

function validateProductionManifest(body, request, productionPem) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_MANIFEST_BYTES) {
    throw new Error('source release manifest is empty or too large');
  }
  const envelope = JSON.parse(body.toString('utf8'));
  assertExactKeys(
    envelope,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'].sort(),
    'source release manifest',
  );
  if (envelope.schema !== MANIFEST_SCHEMA
      || envelope.keyId !== ORDINARY_KEY_ID
      || envelope.signatureAlgorithm !== 'ed25519') {
    throw new Error('source release manifest identity is invalid');
  }
  const signature = parseCanonicalBase64(envelope.signature, 'source manifest signature', 512);
  if (!verify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    createPublicKey(productionPem),
    signature,
  )) {
    throw new Error('source release manifest is not production-key-valid');
  }
  if (sha256(body) !== request.releaseManifestSha256
      || sha256(canonicalJson(envelope.payload)) !== request.releaseManifestPayloadSha256
      || envelope.payload?.runtimeSha !== request.runtimeSha
      || envelope.payload?.artifact?.digest !== request.artifactDigest) {
    throw new Error('source release manifest binding is invalid');
  }
  return envelope;
}

function validateInputs(requestFile, manifestFile, expectedRuntimeSha = '') {
  const { request, staging } = validateRequest(
    JSON.parse(readBounded(requestFile, 64 * 1024, 'signing request')),
    expectedRuntimeSha,
  );
  const productionPem = readPem(
    '--production-public-key',
    'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
    PRODUCTION_PUBLIC_KEY,
  );
  if (!productionPem) throw new Error('production release public key is required');
  const manifestBody = readBounded(manifestFile, MAX_MANIFEST_BYTES, 'source release manifest');
  const manifest = validateProductionManifest(manifestBody, request, productionPem);
  if (staging.releaseManifestSha256 !== sha256(manifestBody)
      || staging.runtimeSha !== manifest.payload.runtimeSha
      || staging.artifactDigest !== manifest.payload.artifact.digest) {
    throw new Error('ordinary staging request is not bound to the source manifest');
  }
  return {
    request,
    staging,
    manifest,
    manifestBody,
    productionPem,
  };
}

function validateSigningRunMetadata(run, request, requestBody) {
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const headSha = process.env.GITHUB_SHA ?? '';
  const expectedTitle = `Sign ${SIGNING_KIND} ${request.requestId} digest ${sha256(requestBody)}`;
  const toolingHead = execFileSync(
    'git',
    ['-C', toolingRoot, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).trim();
  if (!RUN_ID.test(runId) || !RUN_ID.test(runAttempt)
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      || !FULL_SHA.test(headSha)
      || String(run?.id) !== runId || String(run?.run_attempt) !== runAttempt
      || run.path !== SIGNING_WORKFLOW || run.event !== 'workflow_dispatch'
      || run.head_branch !== 'main' || run.head_sha !== headSha
      || toolingHead !== run.head_sha
      || !['in_progress', 'completed'].includes(run.status)
      || (run.status === 'completed' && run.conclusion !== 'success')
      || run.repository?.full_name !== repository
      || run.head_repository?.full_name !== repository
      || run.display_title !== expectedTitle) {
    throw new Error('rollback-drill staging signing GitHub run identity is invalid');
  }
  const requestedAtMs = canonicalGithubTimestamp(
    run.created_at,
    'rollback-drill staging signing GitHub run.createdAt',
  );
  if (run.run_started_at !== null && run.run_started_at !== undefined
      && canonicalGithubTimestamp(
        run.run_started_at,
        'rollback-drill staging signing GitHub run.startedAt',
      ) < requestedAtMs) {
    throw new Error('rollback-drill staging signing GitHub chronology is invalid');
  }
  if (requestedAtMs + GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS
      < Date.parse(request.verifiedAt)) {
    throw new Error('rollback-drill staging signing run predates verified staging smoke');
  }
  return {
    workflow: SIGNING_WORKFLOW,
    runId,
    runAttempt,
    requestedAt: new Date(requestedAtMs).toISOString(),
  };
}

function safeBundleDirectory(output) {
  const parent = path.dirname(output);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0) {
    throw new Error('rollback-drill staging bundle parent is unsafe');
  }
  if (fs.existsSync(output) || fs.lstatSync(output, { throwIfNoEntry: false })) {
    throw new Error('rollback-drill staging bundle output already exists');
  }
  const temporary = path.join(
    parent,
    `.${path.basename(output)}.next.${process.pid}.${randomBytes(8).toString('hex')}`,
  );
  fs.mkdirSync(temporary, { mode: 0o700 });
  return temporary;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeBundle(output, files) {
  const temporary = safeBundleDirectory(output);
  try {
    for (const [name, body] of Object.entries(files)) {
      const descriptor = fs.openSync(path.join(temporary, name), 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, body);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    fsyncDirectory(temporary);
    fs.renameSync(temporary, output);
    fsyncDirectory(path.dirname(output));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function ordinaryEnvelope(schema, payload, privateKey) {
  return {
    schema,
    keyId: ORDINARY_KEY_ID,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString('base64'),
  };
}

function verifyOrdinaryEnvelope(envelope, schema, publicPem, label) {
  assertExactKeys(
    envelope,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'].sort(),
    label,
  );
  if (envelope.schema !== schema || envelope.keyId !== ORDINARY_KEY_ID
      || envelope.signatureAlgorithm !== 'ed25519') {
    throw new Error(`${label} identity is invalid`);
  }
  const signature = parseCanonicalBase64(envelope.signature, `${label} signature`, 512);
  if (!verify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    createPublicKey(publicPem),
    signature,
  )) throw new Error(`${label} signature is invalid`);
  return signature;
}

function readBundle(bundleDirectory) {
  const stat = fs.lstatSync(bundleDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('rollback-drill staging bundle directory is unsafe');
  }
  const names = fs.readdirSync(bundleDirectory).sort();
  const expected = ['drill-binding.json', 'release-manifest.json', 'staging-attestation.json'];
  if (names.join(',') !== expected.join(',')) {
    throw new Error('rollback-drill staging bundle files are incomplete or ambiguous');
  }
  const read = (name) => readBounded(
    path.join(bundleDirectory, name),
    MAX_MANIFEST_BYTES,
    `rollback-drill staging ${name}`,
  );
  return {
    bindingBody: read('drill-binding.json'),
    manifestBody: read('release-manifest.json'),
    stagingBody: read('staging-attestation.json'),
  };
}

function validateSignedBundle(bundleDirectory) {
  const drillPem = readPem(
    '--drill-public-key',
    'NEXUS_ROLLBACK_DRILL_STAGING_PUBLIC_KEY_PEM',
  );
  const productionPem = readPem(
    '--production-public-key',
    'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
    PRODUCTION_PUBLIC_KEY,
  );
  if (!drillPem || !productionPem) {
    throw new Error('drill and production release public keys are required');
  }
  if (!allowTestKey) assertDistinctKeys(drillPem, productionPem);
  const bodies = readBundle(bundleDirectory);
  const manifest = JSON.parse(bodies.manifestBody);
  const staging = JSON.parse(bodies.stagingBody);
  const binding = JSON.parse(bodies.bindingBody);
  const manifestSignature = verifyOrdinaryEnvelope(
    manifest,
    MANIFEST_SCHEMA,
    drillPem,
    'drill release manifest',
  );
  const stagingSignature = verifyOrdinaryEnvelope(
    staging,
    STAGING_SCHEMA,
    drillPem,
    'drill staging attestation',
  );
  if (verify(
    null,
    Buffer.from(canonicalJson(manifest.payload)),
    createPublicKey(productionPem),
    manifestSignature,
  ) || verify(
    null,
    Buffer.from(canonicalJson(staging.payload)),
    createPublicKey(productionPem),
    stagingSignature,
  )) {
    throw new Error('drill evidence is unexpectedly production-key-valid');
  }
  assertExactKeys(
    binding,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'].sort(),
    'rollback-drill staging binding',
  );
  if (binding.schema !== RECORD_SCHEMA || binding.keyId !== RECORD_KEY_ID
      || binding.signatureAlgorithm !== 'ed25519') {
    throw new Error('rollback-drill staging binding identity is invalid');
  }
  const bindingSignature = parseCanonicalBase64(
    binding.signature,
    'rollback-drill staging binding signature',
    512,
  );
  if (!verify(
    null,
    Buffer.from(canonicalJson(binding.payload)),
    createPublicKey(drillPem),
    bindingSignature,
  )) throw new Error('rollback-drill staging binding signature is invalid');
  const payload = binding.payload;
  assertExactKeys(payload, [
    'artifactDigest',
    'drillEvidence',
    'promotionAllowed',
    'protectedSigning',
    'requestId',
    'runtimeSha',
    'schema',
    'scope',
    'source',
  ].sort(), 'rollback-drill staging binding payload');
  if (payload.schema !== RECORD_PAYLOAD_SCHEMA || payload.scope !== SCOPE
      || payload.promotionAllowed !== false || !UUID.test(payload.requestId ?? '')
      || !FULL_SHA.test(payload.runtimeSha ?? '')
      || !DIGEST.test(payload.artifactDigest ?? '')) {
    throw new Error('rollback-drill staging binding payload is invalid');
  }
  assertExactKeys(payload.source, [
    'manifestSigningRunId',
    'releaseManifestPayloadSha256',
    'releaseManifestSha256',
    'stagingRequestSha256',
  ].sort(), 'rollback-drill staging source');
  assertExactKeys(payload.drillEvidence, [
    'releaseManifestPayloadSha256',
    'releaseManifestSha256',
    'stagingAttestationPayloadSha256',
    'stagingAttestationSha256',
  ].sort(), 'rollback-drill staging evidence');
  if (payload.drillEvidence.releaseManifestSha256 !== sha256(bodies.manifestBody)
      || payload.drillEvidence.releaseManifestPayloadSha256
        !== sha256(canonicalJson(manifest.payload))
      || payload.drillEvidence.stagingAttestationSha256 !== sha256(bodies.stagingBody)
      || payload.drillEvidence.stagingAttestationPayloadSha256
        !== sha256(canonicalJson(staging.payload))
      || staging.payload?.releaseManifestSha256 !== sha256(bodies.manifestBody)
      || staging.payload?.runtimeSha !== manifest.payload?.runtimeSha
      || staging.payload?.artifactDigest !== manifest.payload?.artifact?.digest
      || payload.requestId !== staging.payload?.requestId
      || payload.runtimeSha !== manifest.payload?.runtimeSha
      || payload.artifactDigest !== manifest.payload?.artifact?.digest) {
    throw new Error('rollback-drill staging inner evidence binding is invalid');
  }
  return { bodies, binding, manifest, staging };
}

if (command === 'request') {
  const stagingRequestFile = resolveFile('--staging-request');
  const manifestFile = resolveFile('--manifest');
  const output = resolveFile('--output');
  const stagingBody = readBounded(
    stagingRequestFile,
    MAX_STAGING_REQUEST_BYTES,
    'ordinary staging request',
  );
  const staging = validateOrdinaryStagingRequest(stagingBody, valueOf('--expect-runtime-sha'));
  const manifestSigningRunId = valueOf('--manifest-signing-run-id');
  if (!RUN_ID.test(manifestSigningRunId)) {
    throw new Error('exact release-manifest signing run id is required');
  }
  const productionPem = readPem(
    '--production-public-key',
    'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
    PRODUCTION_PUBLIC_KEY,
  );
  if (!productionPem) throw new Error('production release public key is required');
  const manifestBody = readBounded(manifestFile, MAX_MANIFEST_BYTES, 'source release manifest');
  const provisional = {
    schema: REQUEST_SCHEMA,
    requestId: staging.requestId,
    runtimeSha: staging.runtimeSha,
    artifactDigest: staging.artifactDigest,
    installedRuntimeDigest: staging.installedRuntimeDigest,
    recoveryRuntimeDigest: staging.recoveryRuntimeDigest,
    manifestSigningRunId,
    releaseManifestSha256: sha256(manifestBody),
    releaseManifestPayloadSha256: sha256(canonicalJson(JSON.parse(manifestBody).payload)),
    stagingRequestSha256: sha256(stagingBody),
    stagingRequestBase64: stagingBody.toString('base64'),
    verifiedAt: staging.verifiedAt,
    expiresAt: staging.expiresAt,
  };
  validateProductionManifest(manifestBody, provisional, productionPem);
  validateRequest(provisional, valueOf('--expect-runtime-sha'));
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(provisional, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: false,
    request: output,
    requestId: provisional.requestId,
    runtimeSha: provisional.runtimeSha,
  }, null, 2)}\n`);
} else if (command === 'validate-request') {
  const requestFile = resolveFile('--request');
  const { request } = validateRequest(
    JSON.parse(readBounded(requestFile, 64 * 1024, 'signing request')),
    valueOf('--expect-runtime-sha'),
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: false,
    requestId: request.requestId,
    runtimeSha: request.runtimeSha,
    manifestSigningRunId: request.manifestSigningRunId,
  }, null, 2)}\n`);
} else if (command === 'validate-inputs') {
  const validated = validateInputs(
    resolveFile('--request'),
    resolveFile('--manifest'),
    valueOf('--expect-runtime-sha'),
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: false,
    requestId: validated.request.requestId,
    runtimeSha: validated.request.runtimeSha,
  }, null, 2)}\n`);
} else if (command === 'sign') {
  const requestFile = resolveFile('--request');
  const manifestFile = resolveFile('--manifest');
  const requestBody = readBounded(requestFile, 64 * 1024, 'signing request');
  const validated = validateInputs(
    requestFile,
    manifestFile,
    valueOf('--expect-runtime-sha'),
  );
  const privatePem = readPem(
    '--private-key',
    'NEXUS_ROLLBACK_DRILL_STAGING_PRIVATE_KEY_PEM',
  );
  const drillPem = readPem(
    '--drill-public-key',
    'NEXUS_ROLLBACK_DRILL_STAGING_PUBLIC_KEY_PEM',
  );
  if (!privatePem || !drillPem) {
    throw new Error('protected rollback-drill staging key pair is required');
  }
  const privateKey = createPrivateKey(privatePem);
  const derivedPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (!derivedPublic.equals(publicKeyDer(drillPem, 'rollback-drill staging public key'))) {
    throw new Error('rollback-drill staging private/public key pair is mismatched');
  }
  if (!allowTestKey) assertDistinctKeys(drillPem, validated.productionPem);
  const signingRunMetadata = resolveFile('--signing-run-metadata');
  const protectedSigning = {
    ...validateSigningRunMetadata(
      JSON.parse(readBounded(signingRunMetadata, 1024 * 1024, 'signing run metadata')),
      validated.request,
      requestBody,
    ),
    signedAt: new Date().toISOString(),
  };
  const drillManifest = ordinaryEnvelope(
    MANIFEST_SCHEMA,
    validated.manifest.payload,
    privateKey,
  );
  const drillManifestBody = Buffer.from(`${JSON.stringify(drillManifest, null, 2)}\n`);
  const stagingPayload = {
    ...validated.staging,
    releaseManifestSha256: sha256(drillManifestBody),
    protectedSigning,
  };
  const drillStaging = ordinaryEnvelope(STAGING_SCHEMA, stagingPayload, privateKey);
  const drillStagingBody = Buffer.from(`${JSON.stringify(drillStaging, null, 2)}\n`);
  const bindingPayload = {
    schema: RECORD_PAYLOAD_SCHEMA,
    scope: SCOPE,
    promotionAllowed: false,
    requestId: validated.request.requestId,
    runtimeSha: validated.request.runtimeSha,
    artifactDigest: validated.request.artifactDigest,
    source: {
      manifestSigningRunId: validated.request.manifestSigningRunId,
      releaseManifestSha256: validated.request.releaseManifestSha256,
      releaseManifestPayloadSha256: validated.request.releaseManifestPayloadSha256,
      stagingRequestSha256: validated.request.stagingRequestSha256,
    },
    drillEvidence: {
      releaseManifestSha256: sha256(drillManifestBody),
      releaseManifestPayloadSha256: sha256(canonicalJson(drillManifest.payload)),
      stagingAttestationSha256: sha256(drillStagingBody),
      stagingAttestationPayloadSha256: sha256(canonicalJson(drillStaging.payload)),
    },
    protectedSigning,
  };
  const binding = {
    schema: RECORD_SCHEMA,
    keyId: RECORD_KEY_ID,
    signatureAlgorithm: 'ed25519',
    payload: bindingPayload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(bindingPayload)),
      privateKey,
    ).toString('base64'),
  };
  const outputDirectory = path.resolve(root, valueOf('--output-dir'));
  if (!valueOf('--output-dir')) throw new Error('--output-dir is required');
  writeBundle(outputDirectory, {
    'release-manifest.json': drillManifestBody,
    'staging-attestation.json': drillStagingBody,
    'drill-binding.json': Buffer.from(`${JSON.stringify(binding, null, 2)}\n`),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: false,
    rollbackDrillEligible: true,
    bundle: outputDirectory,
    requestId: validated.request.requestId,
  }, null, 2)}\n`);
} else if (command === 'validate-signed' || command === 'validate') {
  const bundleDirectory = path.resolve(root, valueOf('--bundle'));
  if (!valueOf('--bundle')) throw new Error('--bundle is required');
  const validated = validateSignedBundle(bundleDirectory);
  if (command === 'validate') {
    const inputs = validateInputs(
      resolveFile('--request'),
      resolveFile('--source-manifest'),
      valueOf('--expect-runtime-sha'),
    );
    const source = validated.binding.payload.source;
    if (source.releaseManifestSha256 !== inputs.request.releaseManifestSha256
        || source.releaseManifestPayloadSha256
          !== inputs.request.releaseManifestPayloadSha256
        || source.stagingRequestSha256 !== inputs.request.stagingRequestSha256
        || source.manifestSigningRunId !== inputs.request.manifestSigningRunId
        || canonicalJson(validated.manifest.payload)
          !== canonicalJson(inputs.manifest.payload)) {
      throw new Error('rollback-drill staging source/output binding is invalid');
    }
    const { protectedSigning: _protectedSigning, ...stagingWithoutSigning } =
      validated.staging.payload;
    const expectedStaging = {
      ...inputs.staging,
      releaseManifestSha256: sha256(validated.bodies.manifestBody),
    };
    if (canonicalJson(stagingWithoutSigning) !== canonicalJson(expectedStaging)) {
      throw new Error('drill staging payload contains an unauthorized source mutation');
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: false,
    rollbackDrillEligible: true,
    reason: 'isolated_kvm_first_drill_only',
    scope: validated.binding.payload.scope,
    requestId: validated.binding.payload.requestId,
    runtimeSha: validated.binding.payload.runtimeSha,
    artifactDigest: validated.binding.payload.artifactDigest,
    releaseManifest: path.join(bundleDirectory, 'release-manifest.json'),
    stagingAttestation: path.join(bundleDirectory, 'staging-attestation.json'),
  }, null, 2)}\n`);
} else {
  throw new Error(
    'Usage: rollback-drill-staging-attestation.mjs '
      + '<request|validate-request|validate-inputs|sign|validate-signed|validate>',
  );
}
