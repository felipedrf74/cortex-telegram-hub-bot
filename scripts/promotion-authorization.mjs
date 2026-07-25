#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() || '';
const value = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const canonicalJson = (input) => {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
};
const sha256 = (input) => createHash('sha256').update(canonicalJson(input)).digest('hex');
const rawSha256 = (input) => createHash('sha256').update(input).digest('hex');
const readJson = (name) => JSON.parse(fs.readFileSync(path.resolve(value(name)), 'utf8'));
const lstatOrNull = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const fsyncDirectory = (directory) => {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};
const reconcileExactPublication = (output, body) => {
  const parent = path.dirname(output);
  const prefix = `.${path.basename(output)}.next.`;
  let stat = lstatOrNull(output);
  if (stat === null) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || !fs.readFileSync(output).equals(body)) {
    throw new Error('promotion envelope output is unsafe or differs from the signed authority');
  }
  if (stat.nlink > 1) {
    let removed = false;
    for (const name of fs.readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const candidate = path.join(parent, name);
      const candidateStat = lstatOrNull(candidate);
      if (candidateStat === null || !candidateStat.isFile() || candidateStat.isSymbolicLink()
          || candidateStat.dev !== stat.dev || candidateStat.ino !== stat.ino
          || !fs.readFileSync(candidate).equals(body)) continue;
      fs.unlinkSync(candidate);
      removed = true;
    }
    if (removed) fsyncDirectory(parent);
    stat = fs.lstatSync(output);
  }
  if (stat.nlink !== 1) {
    throw new Error('promotion envelope output has an unexplained hard link');
  }
  return true;
};
const publishExactFile = (output, body) => {
  const parent = path.dirname(output);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || path.dirname(path.resolve(output)) !== path.resolve(parent)) {
    throw new Error('promotion envelope output directory is unsafe');
  }
  if (reconcileExactPublication(output, body)) return;
  const temporary = path.join(
    parent,
    `.${path.basename(output)}.next.${process.pid}.${randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, output);
      fsyncDirectory(parent);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      reconcileExactPublication(output, body);
    }
    fs.unlinkSync(temporary);
    fsyncDirectory(parent);
    reconcileExactPublication(output, body);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};
const fullSha = /^[a-f0-9]{40}$/u;
const digest = /^[a-f0-9]{64}$/u;
const transactionId = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;

function validateRequestPayload(payload, { allowExpired = false } = {}) {
  if (payload?.schema !== 'nexus.promotion-transaction-request.v1') throw new Error('invalid request payload schema');
  if (!transactionId.test(payload.transactionId || '')) throw new Error('invalid transaction id');
  if (payload.ownerAuthorization !== 'explicit') throw new Error('explicit owner authorization is missing');
  if (!fullSha.test(payload.predecessor?.sha || '') || !fullSha.test(payload.target?.sha || '')) throw new Error('invalid runtime identity');
  if (!digest.test(payload.predecessor?.artifactDigest || '')
      || !digest.test(payload.predecessor?.installedRuntimeDigest || '')) {
    throw new Error('invalid predecessor artifact identity');
  }
  if (payload.target?.sentryRelease !== payload.target?.sha) throw new Error('Sentry release must equal the exact runtime SHA');
  if (!digest.test(payload.target?.artifactDigest || '') || !digest.test(payload.target?.installedRuntimeDigest || '')) throw new Error('invalid artifact identity');
  if (!digest.test(payload.target?.recoveryRuntimeDigest || '')) {
    throw new Error('invalid relocatable recovery runtime identity');
  }
  const releaseEvidence = payload.releaseEvidence;
  const evidenceKeys = [
    'releaseManifestBase64',
    'releaseManifestSha256',
    'stagingAttestationBase64',
    'stagingAttestationSha256',
  ];
  if (!releaseEvidence || typeof releaseEvidence !== 'object' || Array.isArray(releaseEvidence)
      || Object.keys(releaseEvidence).length !== evidenceKeys.length
      || evidenceKeys.some((key) => !Object.prototype.hasOwnProperty.call(releaseEvidence, key))) {
    throw new Error('signed release recovery evidence schema is invalid');
  }
  const decodedEvidence = {};
  for (const [base64Key, digestKey] of [
    ['releaseManifestBase64', 'releaseManifestSha256'],
    ['stagingAttestationBase64', 'stagingAttestationSha256'],
  ]) {
    if (typeof releaseEvidence[base64Key] !== 'string'
        || !digest.test(releaseEvidence[digestKey] || '')
        || releaseEvidence[base64Key].length > 24 * 1024 * 1024) {
      throw new Error(`signed release recovery evidence is invalid: ${base64Key}`);
    }
    const decoded = Buffer.from(releaseEvidence[base64Key], 'base64');
    if (decoded.length === 0 || decoded.length > 16 * 1024 * 1024
        || decoded.toString('base64') !== releaseEvidence[base64Key]
        || rawSha256(decoded) !== releaseEvidence[digestKey]) {
      throw new Error(`signed release recovery evidence digest is invalid: ${base64Key}`);
    }
    decodedEvidence[base64Key] = decoded;
  }
  let stagingAttestation;
  try {
    stagingAttestation = JSON.parse(
      decodedEvidence.stagingAttestationBase64.toString('utf8'),
    );
  } catch {
    throw new Error('signed staging attestation evidence is not valid JSON');
  }
  if (stagingAttestation?.schema !== 'nexus.staging-attestation.v1') {
    throw new Error('production promotion requires an ordinary signed staging attestation');
  }
  const releasePath = /^\/srv\/nexus-release\/production\/releases\/[A-Za-z0-9._-]+$/u;
  const basePath = /^\/srv\/nexus-release\/production$/u;
  if (!basePath.test(payload.productionBase || '') || !releasePath.test(payload.target?.runtime || '')) {
    throw new Error('unsafe production path');
  }
  if (!releasePath.test(payload.predecessor?.runtime || '')) {
    throw new Error('unsafe predecessor path');
  }
  if (payload.backupDir !== '/home/dominguez/backups/nexushub'
      || !/^\/home\/dominguez\/backups\/nexushub\/\.runtime-stage-[A-Za-z0-9]+$/u.test(payload.preparedRuntimeDir || '')) {
    throw new Error('unsafe backup path');
  }
  if (!/^\/(?:[^\s/]+\/)+pm2$/u.test(payload.pm2Bin || '')) throw new Error('unsafe PM2 path');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/u.test(payload.publicBaseUrl || '')) throw new Error('invalid public URL');
  if (!/^[0-9A-Za-z.+-]+$/u.test(payload.target?.version || '')) throw new Error('invalid target version');
  if (payload.stabilitySeconds !== 60) throw new Error('production stability soak must be exactly 60 seconds');
  if (!Number.isInteger(payload.gateTimeoutSeconds) || payload.gateTimeoutSeconds < 30 || payload.gateTimeoutSeconds > 60) {
    throw new Error('local gate timeout must be between 30 and 60 seconds');
  }
  const created = Date.parse(payload.createdAt || '');
  const expires = Date.parse(payload.expiresAt || '');
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > 30 * 60 * 1000) {
    throw new Error('request lifetime is invalid');
  }
  if (created > Date.now() + 5 * 60 * 1000) throw new Error('promotion request is not yet valid');
  if (!allowExpired && Date.now() > expires) throw new Error('promotion request expired');
  if (payload.migration?.required === true) {
    for (const key of ['reviewEvidenceSha256', 'policySubjectSha256', 'onlineEvidenceSha256',
      'onlineCloneSha256', 'onlineMigratedCloneSha256', 'onlinePendingSetSha256',
      'onlineSourceDatabaseSha256']) {
      if (!digest.test(payload.migration[key] || '')) throw new Error(`invalid migration identity: ${key}`);
    }
  } else if (payload.migration?.required !== false) {
    throw new Error('invalid migration requirement');
  }
}

function validateDecisionPayload(payload, expectedId = '', expectedRequestSha = '') {
  if (payload?.schema !== 'nexus.promotion-transaction-decision.v1') throw new Error('invalid decision payload schema');
  if (!transactionId.test(payload.transactionId || '') || (expectedId && payload.transactionId !== expectedId)) {
    throw new Error('decision transaction mismatch');
  }
  if (payload.decision !== 'continue') throw new Error('unsupported promotion decision');
  if (!digest.test(payload.requestSha256 || '') || (expectedRequestSha && payload.requestSha256 !== expectedRequestSha)) {
    throw new Error('decision request digest mismatch');
  }
  for (const key of ['finalEvidenceSha256', 'backupEvidenceSha256']) {
    if (!digest.test(payload[key] || '')) throw new Error(`decision ${key} is invalid`);
  }
  const decided = Date.parse(payload.decidedAt || '');
  const expires = Date.parse(payload.expiresAt || '');
  if (!Number.isFinite(decided) || !Number.isFinite(expires) || expires <= decided || expires - decided > 5 * 60 * 1000) {
    throw new Error('decision lifetime is invalid');
  }
  if (decided > Date.now() + 60 * 1000) throw new Error('promotion decision is not yet valid');
  if (Date.now() > expires) throw new Error('promotion decision expired');
}

function sign(kind) {
  const payload = readJson('--input');
  if (kind === 'request') validateRequestPayload(payload);
  else validateDecisionPayload(payload);
  const privateKey = fs.readFileSync(path.resolve(value('--private-key')), 'utf8');
  const envelope = {
    schema: `nexus.promotion-transaction-${kind}-envelope.v1`,
    keyId: value('--key-id', 'nexus-owner-promotion-2026'),
    signatureAlgorithm: 'ed25519',
    payload,
    signature: cryptoSign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(privateKey)).toString('base64'),
  };
  const output = path.resolve(value('--output'));
  const parent = path.dirname(output);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('promotion envelope output directory is unsafe');
  }
  publishExactFile(output, Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`));
  process.stdout.write(`${JSON.stringify({ ok: true, kind, envelopeSha256: sha256(envelope), payloadSha256: sha256(payload) })}\n`);
}

function verify(kind) {
  const envelope = readJson('--input');
  if (envelope?.schema !== `nexus.promotion-transaction-${kind}-envelope.v1`
      || envelope?.signatureAlgorithm !== 'ed25519'
      || envelope?.keyId !== value('--key-id', 'nexus-owner-promotion-2026')) {
    throw new Error(`invalid ${kind} envelope identity`);
  }
  if (kind === 'request') validateRequestPayload(envelope.payload, { allowExpired: args.includes('--allow-expired') });
  else validateDecisionPayload(envelope.payload, value('--expect-id'), value('--expect-request-sha256'));
  const publicKey = fs.readFileSync(path.resolve(value('--public-key')), 'utf8');
  const valid = cryptoVerify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    createPublicKey(publicKey),
    Buffer.from(envelope.signature || '', 'base64'),
  );
  if (!valid) throw new Error(`${kind} signature is invalid`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind,
    transactionId: envelope.payload.transactionId,
    envelopeSha256: sha256(envelope),
    payloadSha256: sha256(envelope.payload),
    payload: envelope.payload,
  })}\n`);
}

function digestRequest() {
  const payload = readJson('--input');
  validateRequestPayload(payload, { allowExpired: args.includes('--allow-expired') });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    transactionId: payload.transactionId,
    payloadSha256: sha256(payload),
  })}\n`);
}

try {
  if (command === 'sign-request') sign('request');
  else if (command === 'verify-request') verify('request');
  else if (command === 'sign-decision') sign('decision');
  else if (command === 'verify-decision') verify('decision');
  else if (command === 'digest-request') digestRequest();
  else throw new Error('unknown promotion authorization command');
} catch (error) {
  process.stderr.write(`promotion_authorization_failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
