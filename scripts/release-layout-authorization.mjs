#!/usr/bin/env node
// Sign and verify the one-time /home -> /srv release layout migration.
// The private key is used only by the owner-side `sign-*` commands. Production
// installs this same file as a root-owned verifier and supplies only the public
// key to `verify`.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() ?? '';
const option = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
};
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MIGRATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OLD_BASES = Object.freeze({
  production: '/home/dominguez/telegram-hub-bot',
  staging: '/home/dominguez/telegram-hub-bot-staging',
});
const NEW_BASES = Object.freeze({
  production: '/srv/nexus-release/production',
  staging: '/srv/nexus-release/staging',
});
const DRILL_SCENARIOS = Object.freeze([
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
]);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function rawSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readSafeBytes(file, maximum = 128 * 1024) {
  const resolved = path.resolve(file);
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum) {
      throw new Error('layout authority input is not a bounded single-link regular file');
    }
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs) {
      throw new Error('layout authority input changed while it was read');
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSafeJson(file, maximum = 128 * 1024) {
  const body = readSafeBytes(file, maximum);
  return { body, value: JSON.parse(body.toString('utf8')) };
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} fields are invalid`);
  }
}

function validateIdentity(identity, role, expectedBase) {
  assertExactKeys(
    identity,
    ['artifactDigest', 'base', 'installedRuntimeDigest', 'runtimeSha'],
    `${role} source identity`,
  );
  if (identity.base !== expectedBase || !SHA.test(identity.runtimeSha)
      || !DIGEST.test(identity.artifactDigest)
      || !DIGEST.test(identity.installedRuntimeDigest)) {
    throw new Error(`${role} source identity is invalid`);
  }
}

function validateRequest(payload, { allowExpired = false } = {}) {
  assertExactKeys(payload, [
    'createdAt',
    'destination',
    'expiresAt',
    'faultDrillEnvelopeSha256',
    'migrationId',
    'ownerAuthorization',
    'pm2AttestationSha256',
    'schema',
    'source',
  ], 'layout migration request');
  if (payload.schema !== 'nexus.release-layout-migration-request.v1'
      || payload.ownerAuthorization !== 'explicit'
      || !MIGRATION_ID.test(payload.migrationId ?? '')
      || !DIGEST.test(payload.pm2AttestationSha256 ?? '')
      || !DIGEST.test(payload.faultDrillEnvelopeSha256 ?? '')) {
    throw new Error('layout migration request identity is invalid');
  }
  assertExactKeys(payload.source, ['production', 'staging'], 'layout migration source');
  assertExactKeys(payload.destination, ['production', 'releaseRoot', 'staging'], 'layout migration destination');
  validateIdentity(payload.source.production, 'production', OLD_BASES.production);
  validateIdentity(payload.source.staging, 'staging', OLD_BASES.staging);
  if (payload.destination.releaseRoot !== '/srv/nexus-release'
      || payload.destination.production !== NEW_BASES.production
      || payload.destination.staging !== NEW_BASES.staging) {
    throw new Error('layout migration destination is invalid');
  }
  const created = Date.parse(payload.createdAt ?? '');
  const expires = Date.parse(payload.expiresAt ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(expires)
      || expires <= created || expires - created > 2 * 60 * 60 * 1000
      || created > Date.now() + 60 * 1000
      || (!allowExpired && Date.now() > expires)) {
    throw new Error('layout migration request lifetime is invalid');
  }
}

function validateDrill(payload, { allowStale = false } = {}) {
  assertExactKeys(payload, [
    'completedAt',
    'maximumRecoverySeconds',
    'migrationId',
    'scenarios',
    'schema',
    'source',
  ], 'layout migration fault drill');
  const completed = Date.parse(payload.completedAt ?? '');
  if (payload.schema !== 'nexus.release-layout-fault-drill.v1'
      || !MIGRATION_ID.test(payload.migrationId ?? '')
      || !Number.isSafeInteger(payload.maximumRecoverySeconds)
      || payload.maximumRecoverySeconds < 0
      || payload.maximumRecoverySeconds > 120
      || !Number.isFinite(completed)
      || completed > Date.now() + 60 * 1000
      || (!allowStale && Date.now() - completed > 30 * 24 * 60 * 60 * 1000)) {
    throw new Error('layout migration fault drill identity is invalid');
  }
  assertExactKeys(payload.source, ['production', 'staging'], 'layout fault-drill source');
  validateIdentity(payload.source.production, 'production', OLD_BASES.production);
  validateIdentity(payload.source.staging, 'staging', OLD_BASES.staging);
  if (!Array.isArray(payload.scenarios) || payload.scenarios.length !== DRILL_SCENARIOS.length) {
    throw new Error('layout migration fault-drill scenarios are invalid');
  }
  const ids = [];
  for (const scenario of payload.scenarios) {
    assertExactKeys(scenario, ['id', 'resultSha256', 'status'], 'layout fault-drill scenario');
    if (!DRILL_SCENARIOS.includes(scenario.id) || scenario.status !== 'passed'
        || !DIGEST.test(scenario.resultSha256 ?? '')) {
      throw new Error('layout migration fault-drill scenario is invalid');
    }
    ids.push(scenario.id);
  }
  if (ids.sort().join(',') !== [...DRILL_SCENARIOS].sort().join(',')) {
    throw new Error('layout migration fault-drill scenario set is invalid');
  }
}

function envelope(kind, payload, privateKeyFile) {
  if (kind === 'request') validateRequest(payload, { allowExpired: true });
  else validateDrill(payload);
  const privateKey = createPrivateKey(readSafeBytes(privateKeyFile, 32 * 1024));
  return {
    schema: `nexus.release-layout-${kind}-envelope.v1`,
    keyId: 'nexus-owner-promotion-2026',
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64'),
  };
}

function verifyEnvelope(input, kind, publicKey, { allowExpired = false } = {}) {
  const expectedKeys = ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'];
  assertExactKeys(input, expectedKeys, `layout ${kind} envelope`);
  if (input.schema !== `nexus.release-layout-${kind}-envelope.v1`
      || input.keyId !== 'nexus-owner-promotion-2026'
      || input.signatureAlgorithm !== 'ed25519'
      || typeof input.signature !== 'string'
      || Buffer.from(input.signature, 'base64').toString('base64') !== input.signature
      || !cryptoVerify(
        null,
        Buffer.from(canonicalJson(input.payload)),
        publicKey,
        Buffer.from(input.signature, 'base64'),
      )) {
    throw new Error(`layout ${kind} envelope signature is invalid`);
  }
  if (kind === 'request') validateRequest(input.payload, { allowExpired });
  else validateDrill(input.payload, { allowStale: allowExpired });
  return input.payload;
}

function writeExclusive(file, value) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.existsSync(resolved)) {
    throw new Error('layout authority output is unsafe or already exists');
  }
  const descriptor = fs.openSync(resolved, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

if (command === 'sign-request' || command === 'sign-drill') {
  const kind = command === 'sign-request' ? 'request' : 'fault-drill';
  const input = readSafeJson(option('--input')).value;
  const signed = envelope(kind, input, option('--private-key'));
  writeExclusive(option('--output'), signed);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: signed.schema,
    output: path.resolve(option('--output')),
  })}\n`);
} else if (command === 'verify') {
  const requestInput = readSafeJson(option('--request-envelope'));
  const drillInput = readSafeJson(option('--fault-drill-envelope'));
  const publicKey = createPublicKey(readSafeBytes(option('--public-key'), 32 * 1024));
  const request = verifyEnvelope(
    requestInput.value,
    'request',
    publicKey,
    { allowExpired: args.includes('--allow-expired') },
  );
  const drill = verifyEnvelope(
    drillInput.value,
    'fault-drill',
    publicKey,
    { allowExpired: args.includes('--allow-expired') },
  );
  if (request.migrationId !== drill.migrationId
      || canonicalJson(request.source) !== canonicalJson(drill.source)
      || request.faultDrillEnvelopeSha256 !== rawSha256(drillInput.body)
      || Date.parse(drill.completedAt) > Date.parse(request.createdAt)) {
    throw new Error('layout request is not bound to the exact signed fault-drill evidence');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: 'nexus.release-layout-authority-verification.v1',
    requestEnvelopeSha256: rawSha256(requestInput.body),
    faultDrillEnvelopeSha256: rawSha256(drillInput.body),
    request,
    faultDrill: drill,
  })}\n`);
} else {
  throw new Error('usage: release-layout-authorization.mjs sign-request|sign-drill|verify ...');
}
