#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const PARAMETER_EVIDENCE_SCHEMA = 'nexus.application-dr-crl-parameters.v1';
const LIVE_EVIDENCE_SCHEMA = 'nexus.application-dr-crl-live-verification.v1';
const CRL_CHUNK_COUNT = 74;
const FULL_CHUNK_BYTES = 4096;
const FINAL_CHUNK_BYTES = 992;
const MAX_CRL_BYTES = 300_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CRL_ID_PATTERN = /^[0-9a-f]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}$/;
const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;
const NAME_PATTERN = /^[ A-Za-z0-9_-]{1,255}$/;
const TRUST_ANCHOR_ARN_PATTERN =
  /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):trust-anchor\/([0-9a-f]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12})$/;
const PROFILE_ARN_PATTERN =
  /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):profile\/([0-9a-f]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12})$/;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function usage() {
  process.stdout.write(`Usage:
  application-dr-crl-parameters.mjs generate \\
    --operation <bootstrap|rotate> \\
    --issuer-cn <exact-private-ca-cn> \\
    --ca-certificate <absolute-pem-path> \\
    --crl <absolute-pem-path> \\
    [--prior-crl <absolute-pem-path>] \\
    --parameters-out <new-absolute-json-path> \\
    --evidence-out <new-absolute-json-path>

  application-dr-crl-parameters.mjs verify \\
    --region <aws-region> \\
    --trust-anchor-arn <exact-arn> \\
    --backup-profile-arn <exact-arn> \\
    --restore-profile-arn <exact-arn> \\
    --crl-id <exact-id> \\
    --name <exact-crl-name> \\
    --expected-enabled <true|false> \\
    --issuer-cn <exact-private-ca-cn> \\
    --ca-certificate <absolute-pem-path> \\
    --crl <absolute-pem-path> \\
    --parameter-evidence <absolute-mode-0600-json-path> \\
    [--aws-profile <owner-profile>] \\
    --evidence-out <new-absolute-json-path>

Generate emits all 74 ordered CRL chunks plus the exact SHA-256 parameter.
Verify is read-only and confirms the live CloudFormation-managed CRL byte for
byte. This helper never imports, updates, enables, disables, or deletes a CRL.
`);
}

function valueAfter(argv, index, arg) {
  const next = index + 1;
  if (next >= argv.length || argv[next].startsWith('--')) {
    fail(`missing value for ${arg}`, 64);
  }
  return [argv[next], next];
}

function parseArgs(argv) {
  const command = argv[0];
  if (!['generate', 'verify'].includes(command)) {
    if (['--help', '-h'].includes(command)) {
      usage();
      process.exit(0);
    }
    fail('first argument must be generate or verify', 64);
  }
  const options = {
    command,
    awsBin: 'aws',
    opensslBin: 'openssl',
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    let value;
    switch (arg) {
      case '--operation':
        [value, index] = valueAfter(argv, index, arg);
        options.operation = value;
        break;
      case '--issuer-cn':
        [value, index] = valueAfter(argv, index, arg);
        options.issuerCn = value;
        break;
      case '--ca-certificate':
        [value, index] = valueAfter(argv, index, arg);
        options.caCertificatePath = value;
        break;
      case '--crl':
        [value, index] = valueAfter(argv, index, arg);
        options.crlPath = value;
        break;
      case '--prior-crl':
        [value, index] = valueAfter(argv, index, arg);
        options.priorCrlPath = value;
        break;
      case '--parameters-out':
        [value, index] = valueAfter(argv, index, arg);
        options.parametersOut = value;
        break;
      case '--parameter-evidence':
        [value, index] = valueAfter(argv, index, arg);
        options.parameterEvidencePath = value;
        break;
      case '--evidence-out':
        [value, index] = valueAfter(argv, index, arg);
        options.evidenceOut = value;
        break;
      case '--region':
        [value, index] = valueAfter(argv, index, arg);
        options.region = value;
        break;
      case '--trust-anchor-arn':
        [value, index] = valueAfter(argv, index, arg);
        options.trustAnchorArn = value;
        break;
      case '--backup-profile-arn':
        [value, index] = valueAfter(argv, index, arg);
        options.backupProfileArn = value;
        break;
      case '--restore-profile-arn':
        [value, index] = valueAfter(argv, index, arg);
        options.restoreProfileArn = value;
        break;
      case '--crl-id':
        [value, index] = valueAfter(argv, index, arg);
        options.crlId = value;
        break;
      case '--name':
        [value, index] = valueAfter(argv, index, arg);
        options.name = value;
        break;
      case '--expected-enabled':
        [value, index] = valueAfter(argv, index, arg);
        if (!['true', 'false'].includes(value)) fail('--expected-enabled must be true or false', 64);
        options.expectedEnabled = value === 'true';
        break;
      case '--aws-profile':
        [value, index] = valueAfter(argv, index, arg);
        options.awsProfile = value;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`, 64);
    }
  }

  if (typeof options.issuerCn !== 'string'
      || options.issuerCn.length < 2
      || options.issuerCn.length > 64
      || /[\r\n,]/.test(options.issuerCn)) {
    fail('--issuer-cn is invalid', 64);
  }
  if (!options.caCertificatePath) fail('--ca-certificate is required', 64);
  if (!options.crlPath) fail('--crl is required', 64);
  if (!options.evidenceOut || !isAbsolute(options.evidenceOut)) {
    fail('--evidence-out must be a new absolute path', 64);
  }

  if (command === 'generate') {
    if (!['bootstrap', 'rotate'].includes(options.operation)) {
      fail('--operation must be bootstrap or rotate', 64);
    }
    if (options.operation === 'bootstrap' && options.priorCrlPath) {
      fail('--prior-crl is not accepted for bootstrap', 64);
    }
    if (options.operation === 'rotate' && !options.priorCrlPath) {
      fail('--prior-crl is required for rotate', 64);
    }
    if (!options.parametersOut || !isAbsolute(options.parametersOut)) {
      fail('--parameters-out must be a new absolute path', 64);
    }
    if (resolve(options.parametersOut) === resolve(options.evidenceOut)) {
      fail('--parameters-out and --evidence-out must be different paths', 64);
    }
  } else {
    if (!REGION_PATTERN.test(options.region || '')) fail('--region is invalid', 64);
    const anchor = (options.trustAnchorArn || '').match(TRUST_ANCHOR_ARN_PATTERN);
    if (!anchor || anchor[2] !== options.region) {
      fail('--trust-anchor-arn must be an exact trust-anchor ARN in --region', 64);
    }
    options.accountId = anchor[3];
    options.trustAnchorId = anchor[4];
    const backupProfile = (options.backupProfileArn || '').match(PROFILE_ARN_PATTERN);
    const restoreProfile = (options.restoreProfileArn || '').match(PROFILE_ARN_PATTERN);
    if (!backupProfile
        || backupProfile[1] !== anchor[1]
        || backupProfile[2] !== options.region
        || backupProfile[3] !== options.accountId) {
      fail('--backup-profile-arn must be an exact profile ARN in the trust-anchor account', 64);
    }
    if (!restoreProfile
        || restoreProfile[1] !== anchor[1]
        || restoreProfile[2] !== options.region
        || restoreProfile[3] !== options.accountId) {
      fail('--restore-profile-arn must be an exact profile ARN in the trust-anchor account', 64);
    }
    options.backupProfileId = backupProfile[4];
    options.restoreProfileId = restoreProfile[4];
    if (options.backupProfileId === options.restoreProfileId) {
      fail('backup and restore profile ARNs must be distinct', 64);
    }
    if (!CRL_ID_PATTERN.test(options.crlId || '')) fail('--crl-id is invalid', 64);
    if (!NAME_PATTERN.test(options.name || '')) fail('--name is invalid', 64);
    if (typeof options.expectedEnabled !== 'boolean') {
      fail('--expected-enabled is required', 64);
    }
    if (!options.parameterEvidencePath) fail('--parameter-evidence is required', 64);
    if (options.awsProfile && !PROFILE_PATTERN.test(options.awsProfile)) {
      fail('--aws-profile is invalid', 64);
    }
    if (['nexus-application-dr-backup', 'nexus-application-dr-restore'].includes(
      options.awsProfile,
    )) {
      fail('runtime backup and restore profiles are forbidden for owner verification', 64);
    }
  }

  const testMode = process.env.NEXUS_APPLICATION_DR_CRL_TEST_MODE === '1';
  if (testMode) {
    options.opensslBin =
      process.env.NEXUS_APPLICATION_DR_CRL_OPENSSL_BIN || options.opensslBin;
    options.awsBin = process.env.NEXUS_APPLICATION_DR_CRL_AWS_BIN || options.awsBin;
  } else if (process.env.NEXUS_APPLICATION_DR_CRL_OPENSSL_BIN
      || process.env.NEXUS_APPLICATION_DR_CRL_AWS_BIN) {
    fail('command overrides are test-only', 77);
  }
  return options;
}

function digestHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function governedFile(path, label, maxBytes, requiredMode0600 = false) {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`, 64);
  const absolute = resolve(path);
  let canonical;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    fail(`${label} path is not readable`);
  }
  if (canonical !== absolute) fail(`${label} path must be canonical and non-symlinked`);
  const before = lstatSync(canonical);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail(`${label} must be a single-link regular file`);
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    fail(`${label} must be owned by the account running this command`);
  }
  const mode = before.mode & 0o777;
  if (requiredMode0600 ? mode !== 0o600 : (mode & 0o022) !== 0) {
    fail(requiredMode0600
      ? `${label} must be mode 0600`
      : `${label} must not be group- or world-writable`);
  }
  if (before.size < 1 || before.size > maxBytes) {
    fail(`${label} size must be from 1 through ${maxBytes} bytes`);
  }
  const bytes = readFileSync(canonical);
  const after = lstatSync(canonical);
  if (bytes.length !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
    fail(`${label} changed while it was read`);
  }
  return {
    path: canonical,
    bytes,
    size: bytes.length,
    sha256: digestHex(bytes),
  };
}

function assertAsciiPem(bytes, label, begin, end) {
  for (const byte of bytes) {
    if (byte > 0x7f || byte === 0x00) fail(`${label} must contain only non-NUL ASCII bytes`);
  }
  const text = bytes.toString('ascii');
  if (text.includes('PRIVATE KEY')) fail(`${label} must never contain private key material`);
  if ((text.match(new RegExp(begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1
      || (text.match(new RegExp(end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1
      || !text.startsWith(`${begin}\n`) && !text.startsWith(`${begin}\r\n`)
      || !(text.endsWith(end)
        || text.endsWith(`${end}\n`)
        || text.endsWith(`${end}\r\n`))) {
    fail(`${label} must contain exactly one bounded PEM object`);
  }
  return text;
}

function runCommand(bin, args, label, input) {
  const result = spawnSync(bin, args, {
    encoding: null,
    env: process.env,
    input,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    timeout: 60_000,
  });
  if (result.error || result.signal || result.status !== 0) fail(`${label} failed`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '');
}

function normalizeCrlNumber(value, label) {
  if (!value || !/^0x[0-9A-Fa-f]+$/.test(value.trim())) {
    fail(`${label} must contain a CRL number`);
  }
  return `0x${BigInt(value.trim()).toString(16)}`;
}

function inspectCrl(options, caCertificate, crl, label) {
  assertAsciiPem(
    crl.bytes,
    label,
    '-----BEGIN X509 CRL-----',
    '-----END X509 CRL-----',
  );
  const metadata = runCommand(
    options.opensslBin,
    [
      'crl', '-inform', 'PEM', '-in', crl.path,
      '-CAfile', caCertificate.path, '-verify',
      '-issuer', '-lastupdate', '-nextupdate', '-crlnumber',
      '-nameopt', 'sep_multiline', '-noout',
    ],
    `${label} signature and metadata verification`,
  ).toString('utf8');
  const issuer = [...metadata.matchAll(/^\s*CN\s*=\s*(.+?)\s*$/gm)]
    .map((match) => match[1]);
  if (issuer.length !== 1 || issuer[0] !== options.issuerCn) {
    fail(`${label} issuer CN does not match --issuer-cn`);
  }
  const dateValue = (key) => {
    const match = metadata.match(new RegExp(`^${key}=(.+)$`, 'm'));
    const value = match ? Date.parse(match[1].trim()) : Number.NaN;
    if (!Number.isFinite(value)) fail(`${label} ${key} is invalid`);
    return value;
  };
  const lastUpdateMs = dateValue('lastUpdate');
  const nextUpdateMs = dateValue('nextUpdate');
  const now = Date.now();
  if (lastUpdateMs > now + CLOCK_SKEW_MS) fail(`${label} lastUpdate is in the future`);
  if (nextUpdateMs <= now || nextUpdateMs <= lastUpdateMs) {
    fail(`${label} nextUpdate is expired or not after lastUpdate`);
  }
  const crlNumber = normalizeCrlNumber(
    metadata.match(/^crlNumber=(.+)$/m)?.[1],
    label,
  );
  const detail = runCommand(
    options.opensslBin,
    ['crl', '-inform', 'PEM', '-in', crl.path, '-text', '-noout'],
    `${label} revoked-certificate inventory`,
  ).toString('utf8');
  const serials = [...detail.matchAll(/^\s*Serial Number:\s*([0-9A-Fa-f:]+)\s*$/gm)]
    .map((match) => match[1].replaceAll(':', '')
      .replace(/^0+(?=[0-9a-f])/i, '').toLowerCase())
    .sort();
  if (new Set(serials).size !== serials.length) {
    fail(`${label} contains duplicate revoked serials`);
  }
  return {
    sha256: crl.sha256,
    bytes: crl.size,
    issuerCn: options.issuerCn,
    lastUpdate: new Date(lastUpdateMs).toISOString(),
    nextUpdate: new Date(nextUpdateMs).toISOString(),
    crlNumber,
    revokedSerialCount: serials.length,
    revokedSerialSetSha256: digestHex(Buffer.from(`${serials.join('\n')}\n`, 'utf8')),
    serials,
  };
}

function validateRotation(target, prior) {
  if (BigInt(target.crlNumber) <= BigInt(prior.crlNumber)) {
    fail('rotation CRL number must increase');
  }
  if (Date.parse(target.lastUpdate) <= Date.parse(prior.lastUpdate)) {
    fail('rotation CRL lastUpdate must be newer');
  }
  const targetSerials = new Set(target.serials);
  for (const serial of prior.serials) {
    if (!targetSerials.has(serial)) {
      fail('rotation CRL must retain every previously revoked serial');
    }
  }
}

function parameterKey(index) {
  return `CertificateRevocationListData${String(index + 1).padStart(3, '0')}`;
}

function makeParameters(crl) {
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < CRL_CHUNK_COUNT; index += 1) {
    const limit = index === CRL_CHUNK_COUNT - 1 ? FINAL_CHUNK_BYTES : FULL_CHUNK_BYTES;
    const chunk = crl.bytes.subarray(offset, offset + limit);
    chunks.push(chunk.toString('ascii'));
    offset += chunk.length;
  }
  if (offset !== crl.bytes.length) fail('CRL could not be represented by the fixed chunk set');
  const reassembled = Buffer.from(chunks.join(''), 'ascii');
  if (!reassembled.equals(crl.bytes) || digestHex(reassembled) !== crl.sha256) {
    fail('CRL chunk reassembly changed the exact input bytes');
  }
  return [
    ...chunks.map((chunk, index) => ({
      ParameterKey: parameterKey(index),
      ParameterValue: chunk,
    })),
    {
      ParameterKey: 'CertificateRevocationListSha256',
      ParameterValue: crl.sha256,
    },
  ];
}

function prepareNewOutput(path, label) {
  if (!isAbsolute(path)) fail(`${label} must be absolute`, 64);
  const absolute = resolve(path);
  const parent = dirname(absolute);
  let canonicalParent;
  try {
    canonicalParent = realpathSync.native(parent);
  } catch {
    fail(`${label} parent is not readable`);
  }
  if (canonicalParent !== parent) fail(`${label} parent must be canonical and non-symlinked`);
  const parentInfo = lstatSync(parent);
  if (!parentInfo.isDirectory()
      || parentInfo.isSymbolicLink()
      || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())
      || (parentInfo.mode & 0o022) !== 0) {
    fail(`${label} parent must be an owned, non-writable, non-symlink directory`);
  }
  try {
    lstatSync(absolute);
    fail(`${label} already exists; refusing to overwrite evidence`);
  } catch (error) {
    if (error?.exitCode) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function writeNewJson(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function parseSecureParameterEvidence(path) {
  const file = governedFile(path, 'parameter evidence', 1024 * 1024, true);
  let value;
  try {
    value = JSON.parse(file.bytes.toString('utf8'));
  } catch {
    fail('parameter evidence is not valid JSON');
  }
  if (!value
      || value.schema !== PARAMETER_EVIDENCE_SCHEMA
      || !['bootstrap', 'rotate'].includes(value.operation)
      || !value.crl
      || !SHA256_PATTERN.test(value.crl.sha256 || '')
      || value.chunkCount !== CRL_CHUNK_COUNT
      || value.reassemblyVerified !== true
      || !SHA256_PATTERN.test(value.parametersFileSha256 || '')) {
    fail('parameter evidence contract is invalid');
  }
  return { file, value };
}

function runAws(options, args, label) {
  const fullArgs = [
    ...args,
    '--region', options.region,
    '--output', 'json',
    '--no-cli-pager',
  ];
  if (options.awsProfile) fullArgs.push('--profile', options.awsProfile);
  const result = spawnSync(options.awsBin, fullArgs, {
    encoding: null,
    env: { ...process.env, AWS_DEFAULT_REGION: options.region, AWS_PAGER: '' },
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    timeout: 60_000,
  });
  if (result.error || result.signal || result.status !== 0) fail(`${label} failed`);
  try {
    const value = JSON.parse(result.stdout.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label} response is malformed`);
    }
    return value;
  } catch (error) {
    if (error?.exitCode) throw error;
    fail(`${label} response is not valid JSON`);
  }
}

function decodeBlob(value) {
  if (typeof value !== 'string' || value.length === 0) fail('live CRL data is missing');
  if (value.startsWith('-----BEGIN X509 CRL-----')) return Buffer.from(value, 'ascii');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    fail('live CRL data is not canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('live CRL data is not canonical base64');
  return bytes;
}

function validateLiveProfile(response, options, kind) {
  const expectedArn = kind === 'backup'
    ? options.backupProfileArn
    : options.restoreProfileArn;
  const expectedId = kind === 'backup'
    ? options.backupProfileId
    : options.restoreProfileId;
  const profile = response.profile;
  if (!profile
      || profile.profileArn !== expectedArn
      || profile.profileId !== expectedId
      || profile.enabled !== options.expectedEnabled
      || typeof profile.name !== 'string'
      || profile.name.length < 1
      || typeof profile.updatedAt !== 'string') {
    fail(`live ${kind} profile identity or enabled state is mismatched`);
  }
  return profile;
}

function generate(options) {
  const caCertificate = governedFile(
    options.caCertificatePath,
    'CA certificate',
    64 * 1024,
  );
  assertAsciiPem(
    caCertificate.bytes,
    'CA certificate',
    '-----BEGIN CERTIFICATE-----',
    '-----END CERTIFICATE-----',
  );
  const crlFile = governedFile(options.crlPath, 'CRL', MAX_CRL_BYTES);
  const crl = inspectCrl(options, caCertificate, crlFile, 'CRL');
  let prior = null;
  if (options.priorCrlPath) {
    const priorFile = governedFile(options.priorCrlPath, 'prior CRL', MAX_CRL_BYTES);
    prior = inspectCrl(options, caCertificate, priorFile, 'prior CRL');
    validateRotation(crl, prior);
  }
  const parameters = makeParameters(crlFile);
  const parametersPath = prepareNewOutput(options.parametersOut, 'parameters output');
  const evidencePath = prepareNewOutput(options.evidenceOut, 'evidence output');
  const parameterBytes = Buffer.from(`${JSON.stringify(parameters, null, 2)}\n`, 'utf8');
  writeNewJson(parametersPath, parameters);
  writeNewJson(evidencePath, {
    schema: PARAMETER_EVIDENCE_SCHEMA,
    operation: options.operation,
    generatedAt: new Date().toISOString(),
    caCertificateSha256: caCertificate.sha256,
    crl: {
      ...crl,
      serials: undefined,
    },
    prior: prior && {
      ...prior,
      serials: undefined,
    },
    chunkCount: CRL_CHUNK_COUNT,
    fullChunkBytes: FULL_CHUNK_BYTES,
    finalChunkBytes: FINAL_CHUNK_BYTES,
    maximumCrlBytes: MAX_CRL_BYTES,
    parametersFileSha256: digestHex(parameterBytes),
    allChunkValuesExplicit: true,
    usePreviousValueForbidden: true,
    reassemblyVerified: true,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    operation: options.operation,
    crlSha256: crl.sha256,
    crlBytes: crl.bytes,
    chunkCount: CRL_CHUNK_COUNT,
    parametersFileSha256: digestHex(parameterBytes),
  })}\n`);
}

function verify(options) {
  const caCertificate = governedFile(
    options.caCertificatePath,
    'CA certificate',
    64 * 1024,
  );
  assertAsciiPem(
    caCertificate.bytes,
    'CA certificate',
    '-----BEGIN CERTIFICATE-----',
    '-----END CERTIFICATE-----',
  );
  const crlFile = governedFile(options.crlPath, 'CRL', MAX_CRL_BYTES);
  const crl = inspectCrl(options, caCertificate, crlFile, 'CRL');
  const parameterEvidence = parseSecureParameterEvidence(options.parameterEvidencePath);
  if (parameterEvidence.value.crl.sha256 !== crl.sha256
      || parameterEvidence.value.crl.bytes !== crl.bytes
      || parameterEvidence.value.caCertificateSha256 !== caCertificate.sha256) {
    fail('parameter evidence does not bind the selected CA certificate and CRL');
  }

  const identity = runAws(options, ['sts', 'get-caller-identity'], 'AWS caller identity');
  if (identity.Account !== options.accountId
      || typeof identity.Arn !== 'string'
      || typeof identity.UserId !== 'string') {
    fail('AWS caller identity does not match the trust-anchor account');
  }
  const anchorResponse = runAws(
    options,
    ['rolesanywhere', 'get-trust-anchor', '--trust-anchor-id', options.trustAnchorId],
    'Roles Anywhere trust anchor',
  );
  const anchor = anchorResponse.trustAnchor;
  if (!anchor
      || anchor.trustAnchorArn !== options.trustAnchorArn
      || anchor.trustAnchorId !== options.trustAnchorId
      || anchor.enabled !== options.expectedEnabled
      || anchor.source?.sourceType !== 'CERTIFICATE_BUNDLE'
      || typeof anchor.source?.sourceData?.x509CertificateData !== 'string') {
    fail('live trust anchor identity or enabled state is mismatched');
  }
  const localDer = runCommand(
    options.opensslBin,
    ['x509', '-inform', 'PEM', '-in', caCertificate.path, '-outform', 'DER'],
    'local CA certificate verification',
  );
  const remoteDer = runCommand(
    options.opensslBin,
    ['x509', '-inform', 'PEM', '-outform', 'DER'],
    'live trust-anchor certificate verification',
    Buffer.from(anchor.source.sourceData.x509CertificateData, 'ascii'),
  );
  if (digestHex(localDer) !== digestHex(remoteDer)) {
    fail('live trust anchor does not contain the exact selected CA certificate');
  }

  const backupProfile = validateLiveProfile(
    runAws(
      options,
      ['rolesanywhere', 'get-profile', '--profile-id', options.backupProfileId],
      'Roles Anywhere backup profile',
    ),
    options,
    'backup',
  );
  const restoreProfile = validateLiveProfile(
    runAws(
      options,
      ['rolesanywhere', 'get-profile', '--profile-id', options.restoreProfileId],
      'Roles Anywhere restore profile',
    ),
    options,
    'restore',
  );

  const response = runAws(
    options,
    ['rolesanywhere', 'get-crl', '--crl-id', options.crlId],
    'Roles Anywhere CRL',
  );
  const live = response.crl;
  if (!live
      || live.crlId !== options.crlId
      || live.name !== options.name
      || live.trustAnchorArn !== options.trustAnchorArn
      || live.enabled !== options.expectedEnabled
      || typeof live.crlArn !== 'string'
      || typeof live.updatedAt !== 'string') {
    fail('live CRL identity or enabled state is mismatched');
  }
  const liveBytes = decodeBlob(live.crlData);
  if (!liveBytes.equals(crlFile.bytes) || digestHex(liveBytes) !== crl.sha256) {
    fail('live CRL bytes do not match the exact generated CRL');
  }
  const tagsResponse = runAws(
    options,
    ['rolesanywhere', 'list-tags-for-resource', '--resource-arn', live.crlArn],
    'Roles Anywhere CRL tags',
  );
  if (!Array.isArray(tagsResponse.tags)) fail('live CRL tags are malformed');
  const digestTags = tagsResponse.tags.filter((tag) => tag?.key === 'crl-sha256');
  if (digestTags.length !== 1 || digestTags[0].value !== crl.sha256) {
    fail('live CRL digest tag does not match the exact generated CRL');
  }

  const evidencePath = prepareNewOutput(options.evidenceOut, 'evidence output');
  writeNewJson(evidencePath, {
    schema: LIVE_EVIDENCE_SCHEMA,
    verifiedAt: new Date().toISOString(),
    region: options.region,
    accountId: options.accountId,
    callerArnSha256: digestHex(Buffer.from(identity.Arn, 'utf8')),
    callerUserIdSha256: digestHex(Buffer.from(identity.UserId, 'utf8')),
    trustAnchorArn: options.trustAnchorArn,
    trustAnchorId: options.trustAnchorId,
    trustAnchorEnabled: anchor.enabled,
    caCertificateSha256: caCertificate.sha256,
    backupProfileArn: backupProfile.profileArn,
    backupProfileId: backupProfile.profileId,
    backupProfileName: backupProfile.name,
    backupProfileEnabled: backupProfile.enabled,
    restoreProfileArn: restoreProfile.profileArn,
    restoreProfileId: restoreProfile.profileId,
    restoreProfileName: restoreProfile.name,
    restoreProfileEnabled: restoreProfile.enabled,
    crlId: live.crlId,
    crlArn: live.crlArn,
    crlName: live.name,
    crlEnabled: live.enabled,
    crlSha256: crl.sha256,
    crlBytes: crl.bytes,
    crlNumber: crl.crlNumber,
    revokedSerialCount: crl.revokedSerialCount,
    revokedSerialSetSha256: crl.revokedSerialSetSha256,
    lastUpdate: crl.lastUpdate,
    nextUpdate: crl.nextUpdate,
    awsUpdatedAt: live.updatedAt,
    parameterEvidenceSha256: parameterEvidence.file.sha256,
    parametersFileSha256: parameterEvidence.value.parametersFileSha256,
    exactBytesVerified: true,
    digestTagVerified: true,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    crlId: live.crlId,
    crlEnabled: live.enabled,
    crlSha256: crl.sha256,
    exactBytesVerified: true,
  })}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'generate') generate(options);
  else verify(options);
} catch (error) {
  process.stderr.write(`${error?.message || 'CRL parameter control failed'}\n`);
  process.exit(error?.exitCode || 1);
}
