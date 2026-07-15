#!/usr/bin/env node
import { randomUUID, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args[0] ?? 'validate';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(valueOf('--root', process.cwd()));

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resolveFile(name, fallback = '') {
  const value = valueOf(name, fallback);
  if (!value) throw new Error(`${name} is required`);
  return path.resolve(root, value);
}

function readPem(name, envName, fallback = '') {
  const explicit = valueOf(name);
  if (explicit) return fs.readFileSync(path.resolve(root, explicit), 'utf8');
  if (process.env[envName]) return process.env[envName];
  if (fallback && fs.existsSync(path.resolve(root, fallback))) {
    return fs.readFileSync(path.resolve(root, fallback), 'utf8');
  }
  return '';
}

function validateRequest(request, expectedRuntime = '') {
  if (request.schema !== 'nexus.staging-attestation-request.v1') throw new Error('staging request schema is invalid');
  if (!/^[0-9a-f]{40}$/.test(request.runtimeSha ?? '')) throw new Error('staging request runtime SHA is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.artifactDigest ?? '')) throw new Error('staging request artifact digest is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.releaseManifestSha256 ?? '')) throw new Error('release manifest digest is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.installedRuntimeDigest ?? '')) throw new Error('installed runtime digest is invalid');
  if (!/^[0-9a-f]{64}$/.test(request.smoke?.logSha256 ?? '') || request.smoke?.status !== 'passed') {
    throw new Error('domain smoke evidence is invalid');
  }
  if (expectedRuntime && request.runtimeSha !== expectedRuntime) throw new Error('staging request runtime SHA mismatch');
  if (!request.requestId || !request.verifiedAt || !request.expiresAt
      || Date.parse(request.expiresAt) <= Date.parse(request.verifiedAt)
      || Date.parse(request.expiresAt) <= Date.now()) {
    throw new Error('staging request lifetime is invalid or expired');
  }
  if (!request.releaseDir?.startsWith('/home/dominguez/telegram-hub-bot-staging/releases/')) {
    throw new Error('staging release directory is outside the governed root');
  }
  const services = request.remoteIdentity?.services;
  if (!Array.isArray(services) || services.length !== 2) throw new Error('PM2 identity evidence is incomplete');
  const expected = new Map([
    ['nexus-hub-staging', request.releaseDir],
    ['content-engine-staging', `${request.releaseDir}/content-engine`],
  ]);
  for (const [name, cwd] of expected) {
    const service = services.find((entry) => entry?.name === name);
    if (!service || service.status !== 'online' || service.cwd !== cwd || service.releaseSha !== request.runtimeSha) {
      throw new Error(`PM2 identity mismatch: ${name}`);
    }
  }
  return request;
}

if (command === 'request') {
  const manifestFile = resolveFile('--manifest');
  const installedFile = resolveFile('--installed-attestation');
  const identityFile = resolveFile('--identity-evidence');
  const smokeFile = resolveFile('--smoke-log');
  const output = resolveFile('--output');
  const manifestBody = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBody);
  const installed = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
  const remoteIdentity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  const smokeBody = fs.readFileSync(smokeFile);
  const now = new Date();
  const request = {
    schema: 'nexus.staging-attestation-request.v1',
    requestId: valueOf('--request-id', randomUUID()),
    runtimeSha: manifest.payload?.runtimeSha,
    artifactDigest: manifest.payload?.artifact?.digest,
    releaseManifestSha256: sha256(manifestBody),
    installedRuntimeDigest: installed.aggregateDigest,
    releaseDir: valueOf('--release-dir'),
    remoteIdentity,
    smoke: {
      status: 'passed',
      command: 'scripts/staging-smoke.sh',
      logSha256: sha256(smokeBody),
    },
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + Number(valueOf('--expires-hours', '24')) * 3_600_000).toISOString(),
  };
  validateRequest(request);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, request: output, requestId: request.requestId, payload: request }, null, 2)}\n`);
} else if (command === 'validate-request') {
  const requestFile = resolveFile('--request');
  const request = validateRequest(
    JSON.parse(fs.readFileSync(requestFile, 'utf8')),
    valueOf('--expect-runtime-sha'),
  );
  process.stdout.write(`${JSON.stringify({ ok: true, requestId: request.requestId, runtimeSha: request.runtimeSha }, null, 2)}\n`);
} else if (command === 'sign') {
  const requestFile = resolveFile('--request');
  const output = resolveFile('--output');
  const request = validateRequest(JSON.parse(fs.readFileSync(requestFile, 'utf8')), valueOf('--expect-runtime-sha'));
  const privatePem = readPem('--private-key', 'NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM');
  if (!privatePem) throw new Error('CI staging-attestation signing key is required');
  const envelope = {
    schema: 'nexus.staging-attestation.v1',
    keyId: valueOf('--key-id', process.env.NEXUS_RELEASE_MANIFEST_KEY_ID ?? 'unknown'),
    signatureAlgorithm: 'ed25519',
    payload: request,
    signature: sign(null, Buffer.from(canonicalJson(request)), createPrivateKey(privatePem)).toString('base64'),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, attestation: output, requestId: request.requestId }, null, 2)}\n`);
} else if (command === 'validate') {
  const attestationFile = resolveFile('--attestation');
  const manifestFile = resolveFile('--manifest');
  const envelope = JSON.parse(fs.readFileSync(attestationFile, 'utf8'));
  if (envelope.schema !== 'nexus.staging-attestation.v1' || envelope.signatureAlgorithm !== 'ed25519') {
    throw new Error('signed staging attestation schema is invalid');
  }
  const request = validateRequest(envelope.payload ?? {}, valueOf('--expect-runtime-sha'));
  const publicPem = readPem(
    '--public-key',
    'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
    'docs/release/evidence/release-evidence-public-key.pem',
  );
  if (!publicPem) throw new Error('staging attestation public key is required');
  if (!verify(
    null,
    Buffer.from(canonicalJson(request)),
    createPublicKey(publicPem),
    Buffer.from(envelope.signature ?? '', 'base64'),
  )) throw new Error('staging attestation signature is invalid');
  const manifestBody = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBody);
  if (has('--validate-release-manifest')) {
    execFileSync(process.execPath, [
      path.join(root, 'scripts/release-manifest-v2.mjs'),
      'validate', '--manifest', manifestFile,
    ], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  }
  if (sha256(manifestBody) !== request.releaseManifestSha256
      || manifest.payload?.runtimeSha !== request.runtimeSha
      || manifest.payload?.artifact?.digest !== request.artifactDigest) {
    throw new Error('staging attestation is not bound to the release manifest');
  }
  const expectedInstalled = valueOf('--expect-installed-runtime-digest');
  if (expectedInstalled && request.installedRuntimeDigest !== expectedInstalled) {
    throw new Error('signed installed runtime digest mismatch');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    promotable: true,
    requestId: request.requestId,
    runtimeSha: request.runtimeSha,
    artifactDigest: request.artifactDigest,
    installedRuntimeDigest: request.installedRuntimeDigest,
    releaseDir: request.releaseDir,
  }, null, 2)}\n`);
} else {
  throw new Error('Usage: release-staging-attestation.mjs <request|validate-request|sign|validate>');
}
