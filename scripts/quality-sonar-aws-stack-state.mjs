#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVIDENCE_SCHEMA = 'nexus.sonarqube-aws-stack-live-verification.v3';
const AUTHORIZATION_SCHEMA = 'nexus.sonarqube-aws-stack-transition-proof.v1';
const MAX_AWS_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 100;
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SHA256 = /^[0-9a-f]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u;
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROFILE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):profile\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u;
const RECEIPT_HELPER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'quality-sonar-stack-receipt.mjs',
);
const READ_ONLY_COMMANDS = new Set([
  'cloudformation describe-change-set',
  'cloudformation describe-stacks',
  'cloudformation get-template',
  'cloudformation list-stack-resources',
  'cloudwatch describe-alarms',
  'iam get-role',
  'iam get-role-policy',
  'iam list-attached-role-policies',
  'iam list-role-policies',
  'iam list-role-tags',
  'rolesanywhere get-profile',
  'rolesanywhere get-crl',
  'rolesanywhere get-trust-anchor',
  'rolesanywhere list-tags-for-resource',
  's3api get-bucket-encryption',
  's3api get-bucket-lifecycle-configuration',
  's3api get-bucket-ownership-controls',
  's3api get-bucket-policy',
  's3api get-bucket-tagging',
  's3api get-bucket-versioning',
  's3api get-public-access-block',
  's3api list-objects-v2',
  'sts get-caller-identity',
  'cloudtrail lookup-events',
]);
const TEST_HOOKS = [
  'FAKE_AWS_RESPONSES',
  'FAKE_AWS_REVOKED_DIAGNOSTIC',
  'FAKE_OPENSSL_CERT_SERIAL',
  'FAKE_OPENSSL_CRL_SERIALS',
  'NEXUS_SONAR_RECEIPT_NOW',
  'NEXUS_SONAR_STACK_AWS_BIN',
  'NEXUS_SONAR_STACK_TEST_MODE',
];

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO-8601 timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return parsed;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} keys are invalid`);
  }
}

function parseArgs(argv) {
  const command = argv.shift();
  if (command !== 'verify') fail('first argument must be verify', 64);
  const options = { command, awsBin: 'aws' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      fail(`invalid argument: ${argument}`, 64);
    }
    const value = argv[++index];
    if (value.startsWith('--')) fail(`missing value for ${argument}`, 64);
    const name = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, name)) fail(`duplicate argument: ${argument}`, 64);
    options[name] = value;
  }
  if (!REGION.test(options.region || '')) fail('--region is invalid', 64);
  if (!STACK_NAME.test(options.stackName || '')) fail('--stack-name is invalid', 64);
  if (!PROFILE.test(options.awsProfile || '')) {
    fail('--aws-profile is invalid', 64);
  }
  if (!PROFILE.test(options.backupProbeProfile || '')
      || !PROFILE.test(options.revokedProbeProfile || '')
      || options.backupProbeProfile === options.revokedProbeProfile) {
    fail('distinct --backup-probe-profile and --revoked-probe-profile are required', 64);
  }
  if (!['activation-transition', 'lifecycle-transition', 'steady'].includes(
    options.mode,
  )) {
    fail('--mode must be activation-transition, lifecycle-transition, or steady', 64);
  }
  for (const name of [
    'activationReceipt',
    'activationTransitionReceipt',
    'publicKey',
    'template',
  ]) {
    if (!options[name]) fail(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`, 64);
  }
  if (!options.keyId) fail('--key-id is required', 64);
  if (options.lifecycleReceipt && !options.backupSuccessReceipt) {
    fail('--backup-success-receipt is required with --lifecycle-receipt', 64);
  }
  if (Boolean(options.lifecycleReceipt)
      !== Boolean(options.lifecycleTransitionReceipt)) {
    fail('lifecycle receipt and lifecycle transition receipt must be supplied together', 64);
  }
  if (options.mode === 'activation-transition'
      && (options.lifecycleReceipt
        || options.activationTransitionRecord
        || options.lifecycleTransitionRecord)) {
    fail('activation-transition accepts no lifecycle receipt or transition record', 64);
  }
  if (options.mode === 'lifecycle-transition'
      && (!options.lifecycleReceipt
        || !options.activationTransitionRecord
        || options.lifecycleTransitionRecord)) {
    fail('lifecycle-transition requires the lifecycle receipt and activation record only', 64);
  }
  if (options.mode === 'steady'
      && (!options.activationTransitionRecord
        || Boolean(options.lifecycleReceipt) !== Boolean(options.lifecycleTransitionRecord))) {
    fail('steady mode requires the activation record and a matching lifecycle record', 64);
  }
  if (process.env.NODE_ENV === 'test'
      && process.env.NEXUS_SONAR_STACK_TEST_MODE === '1'
      && process.env.NEXUS_SONAR_STACK_AWS_BIN) {
    options.awsBin = process.env.NEXUS_SONAR_STACK_AWS_BIN;
  }
  const isolatedTestMode = testFilesystemMode();
  const activeTestHooks = TEST_HOOKS.filter((name) => process.env[name] != null);
  if (!isolatedTestMode && activeTestHooks.length > 0) {
    fail(
      `Sonar stack test hooks require explicit isolated test mode: ${activeTestHooks.join(',')}`,
      64,
    );
  }
  const allowed = new Set([
    'activationReceipt',
    'activationTransitionReceipt',
    'activationTransitionRecord',
    'awsConfig',
    'awsBin',
    'awsProfile',
    'backupProbeProfile',
    'backupSuccessReceipt',
    'command',
    'evidenceOut',
    'keyId',
    'lifecycleReceipt',
    'lifecycleTransitionReceipt',
    'lifecycleTransitionRecord',
    'mode',
    'opensslBin',
    'publicKey',
    'region',
    'revokedProbeProfile',
    'stackName',
    'template',
  ]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`unknown option --${name}`, 64);
  }
  if (!options.evidenceOut) fail('--evidence-out is required', 64);
  if (!options.awsConfig) fail('--aws-config is required', 64);
  if (!options.opensslBin) fail('--openssl-bin is required', 64);
  return options;
}

function testFilesystemMode() {
  return process.env.NODE_ENV === 'test'
    && process.env.NEXUS_SONAR_STACK_TEST_MODE === '1';
}

function readRegularFile(
  file,
  label,
  maximumBytes,
  {
    privateFile = false,
    ownerUid,
    rejectGroupWorldWrite = false,
  } = {},
) {
  const absolute = resolve(file || '');
  const before = lstatSync(absolute);
  const unsafe = (stat) => !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || stat.size < 1
    || stat.size > maximumBytes
    || (privateFile && (stat.mode & 0o077) !== 0)
    || (rejectGroupWorldWrite && (stat.mode & 0o022) !== 0)
    || (ownerUid != null && stat.uid !== ownerUid);
  if (unsafe(before)) {
    fail(`${label} is unsafe`);
  }
  let descriptor;
  try {
    descriptor = openSync(absolute, 'r');
    const opened = fstatSync(descriptor);
    if (unsafe(opened)
        || before.dev !== opened.dev
        || before.ino !== opened.ino
        || before.size !== opened.size
        || before.mtimeMs !== opened.mtimeMs) {
      fail(`${label} changed before it was opened`);
    }
    const body = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (opened.dev !== afterRead.dev
        || opened.ino !== afterRead.ino
        || opened.size !== afterRead.size
        || opened.mtimeMs !== afterRead.mtimeMs
        || opened.dev !== afterPath.dev
        || opened.ino !== afterPath.ino
        || opened.size !== afterPath.size
        || opened.mtimeMs !== afterPath.mtimeMs) {
      fail(`${label} changed while it was read`);
    }
    return { absolute, body };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateTrustedExecutable(file, label, expectedOwnerUid) {
  if (!isAbsolute(file || '') || resolve(file) !== file) {
    fail(`${label} must be a canonical absolute path`, 64);
  }
  let canonical;
  let stat;
  try {
    canonical = realpathSync.native(file);
    stat = lstatSync(file);
  } catch {
    fail(`${label} is unavailable`);
  }
  if (canonical !== file
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.nlink !== 1
      || stat.uid !== expectedOwnerUid
      || (stat.mode & 0o111) === 0
      || (stat.mode & 0o022) !== 0) {
    fail(`${label} is not a trusted executable`);
  }
  validateTrustedParentPath(file, label, expectedOwnerUid);
}

function validateTrustedParentPath(file, label, expectedOwnerUid) {
  let current = dirname(file);
  const stopAt = testFilesystemMode() ? current : '/';
  while (true) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      fail(`${label} parent path is unavailable`);
    }
    if (!stat.isDirectory()
        || stat.isSymbolicLink()
        || realpathSync.native(current) !== current
        || stat.uid !== expectedOwnerUid
        || (stat.mode & 0o022) !== 0) {
      fail(`${label} parent path is untrusted`);
    }
    if (current === stopAt) break;
    current = dirname(current);
  }
}

function parseAwsConfig(body) {
  const text = body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(body) || text.includes('\0')) {
    fail('Sonar AWS profile config is not valid UTF-8 text');
  }
  const sections = new Map();
  let current = null;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[profile ([A-Za-z0-9][A-Za-z0-9_.@+-]{0,127})\]$/u);
    if (section) {
      if (sections.has(section[1])) {
        fail(`Sonar AWS profile config repeats profile ${section[1]}`);
      }
      current = new Map();
      sections.set(section[1], current);
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const setting = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/u);
    if (!setting || !setting[2]) {
      fail('Sonar AWS profile config contains an invalid profile setting');
    }
    const key = setting[1].toLowerCase();
    if (current.has(key)) {
      fail(`Sonar AWS profile config repeats setting ${key}`);
    }
    current.set(key, setting[2]);
  }
  return sections;
}

function tokenizeCredentialProcess(command, label) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = '';
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped || quote) fail(`${label} credential_process quoting is invalid`);
  if (started) tokens.push(token);
  if (tokens.length < 2 || tokens.some((value) => value.length === 0)) {
    fail(`${label} credential_process is invalid`);
  }
  return tokens;
}

function parseCredentialProcess(profile, profileName, options) {
  if (!profile) fail(`Sonar AWS profile ${profileName} is missing`);
  const keys = [...profile.keys()].sort();
  if (canonicalJson(keys) !== canonicalJson(['credential_process', 'region'])) {
    fail(`Sonar AWS profile ${profileName} has unexpected settings`);
  }
  if (profile.get('region') !== options.region) {
    fail(`Sonar AWS profile ${profileName} region is mismatched`);
  }
  const tokens = tokenizeCredentialProcess(
    profile.get('credential_process'),
    `Sonar AWS profile ${profileName}`,
  );
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(tokens[0])
      || tokens[0].includes('//')
      || resolve(tokens[0]) !== tokens[0]
      || tokens[1] !== 'credential-process') {
    fail(`Sonar AWS profile ${profileName} must invoke a canonical credential helper`);
  }
  const allowed = new Set([
    '--certificate',
    '--intermediates',
    '--private-key',
    '--profile-arn',
    '--region',
    '--role-arn',
    '--session-duration',
    '--trust-anchor-arn',
  ]);
  const values = new Map();
  for (let index = 2; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(flag) || value == null || value.startsWith('--') || values.has(flag)) {
      fail(`Sonar AWS profile ${profileName} credential_process options are invalid`);
    }
    values.set(flag, value);
  }
  for (const flag of [
    '--certificate',
    '--private-key',
    '--profile-arn',
    '--role-arn',
    '--session-duration',
    '--trust-anchor-arn',
  ]) {
    if (!values.has(flag)) {
      fail(`Sonar AWS profile ${profileName} credential_process is missing ${flag}`);
    }
  }
  if (values.get('--session-duration') !== '900'
      || (values.has('--region') && values.get('--region') !== options.region)) {
    fail(`Sonar AWS profile ${profileName} credential_process duration or region is invalid`);
  }
  for (const flag of ['--certificate', '--private-key', '--intermediates']) {
    if (!values.has(flag)) continue;
    const path = values.get(flag);
    if (!/^\/[A-Za-z0-9._/-]+$/u.test(path)
        || path === '/'
        || path.includes('//')
        || resolve(path) !== path) {
      fail(`Sonar AWS profile ${profileName} ${flag} path is invalid`);
    }
  }
  return values;
}

function validateProbeProfileBindings(options, outputs, awsConfigBody) {
  const profiles = parseAwsConfig(awsConfigBody);
  const backup = parseCredentialProcess(
    profiles.get(options.backupProbeProfile),
    options.backupProbeProfile,
    options,
  );
  const revoked = parseCredentialProcess(
    profiles.get(options.revokedProbeProfile),
    options.revokedProbeProfile,
    options,
  );
  const expected = {
    '--profile-arn': outputs.get('BackupRolesAnywhereProfileArn'),
    '--role-arn': outputs.get('BackupPrincipalArn'),
    '--trust-anchor-arn': outputs.get('RolesAnywhereTrustAnchorArn'),
  };
  for (const [flag, value] of Object.entries(expected)) {
    if (backup.get(flag) !== value || revoked.get(flag) !== value) {
      fail(`Sonar credential probe ${flag} differs from the exact stack output`);
    }
  }
  if (backup.get('--certificate') === revoked.get('--certificate')
      || backup.get('--private-key') === revoked.get('--private-key')) {
    fail('positive and revoked Sonar credential probes must use distinct leaf material');
  }
  return { backup, revoked };
}

function prepareRootEvidenceOutput(file) {
  const testMode = testFilesystemMode();
  if (process.getuid() !== 0 && !testMode) {
    fail('live Sonar stack evidence must be produced as root');
  }
  if (!file || !isAbsolute(file)) {
    fail('--evidence-out must be a new absolute path', 64);
  }
  const absolute = resolve(file);
  if (testMode && !isIsolatedTestEvidencePath(absolute)) {
    fail('isolated test mode may write evidence only below an OS temporary directory');
  }
  const parent = dirname(absolute);
  if (realpathSync.native(parent) !== parent) {
    fail('evidence parent must be canonical');
  }
  if (testMode) {
    const parentStat = lstatSync(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || parentStat.uid !== process.getuid()
        || (parentStat.mode & 0o077) !== 0) {
      fail('test evidence parent must be caller-owned mode 0700');
    }
  }
  let current = parent;
  while (!testMode) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0
        || (stat.mode & 0o022) !== 0) {
      fail('evidence path chain must be root-owned and not group/world writable');
    }
    if (current === '/') break;
    current = dirname(current);
  }
  const parentStat = lstatSync(parent);
  if ((parentStat.mode & 0o777) !== 0o700) {
    fail('evidence parent must be root-owned mode 0700');
  }
  try {
    lstatSync(absolute);
    fail('evidence output must be a new path');
  } catch (error) {
    if (error?.message === 'evidence output must be a new path') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function isIsolatedTestEvidencePath(absolute) {
  return absolute.startsWith('/tmp/')
    || absolute.startsWith('/private/tmp/')
    || /^\/private\/var\/folders\/[^/]+\/[^/]+\/T\/.+/u.test(absolute);
}

function writeNewRootEvidence(output, value) {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const temporary = `${output}.next.${process.pid}.${randomBytes(12).toString('hex')}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, body);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, output);
    unlinkSync(temporary);
    const directoryDescriptor = openSync(dirname(output), 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function childEnvironment() {
  const environment = { ...process.env, PATH: SAFE_PATH };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  if (!testFilesystemMode()) {
    for (const variable of TEST_HOOKS) {
      delete environment[variable];
    }
    if (environment.NODE_ENV === 'test') delete environment.NODE_ENV;
  }
  return environment;
}

function commandEnvironment(options) {
  const environment = {
    ...childEnvironment(),
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_CONFIG_FILE: options.awsConfig,
    AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_PAGER: '',
  };
  for (const variable of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_DEFAULT_PROFILE',
    'AWS_PROFILE',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  ]) {
    delete environment[variable];
  }
  for (const variable of Object.keys(environment)) {
    if (variable.startsWith('AWS_ENDPOINT_URL')) delete environment[variable];
  }
  return environment;
}

function runCommand(
  command,
  args,
  label,
  maximumBytes = MAX_AWS_OUTPUT_BYTES,
  options = {},
) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: maximumBytes,
    env: options.awsConfig ? commandEnvironment(options) : childEnvironment(),
    input: options.input,
    timeout: 25_000,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim().slice(0, 1000);
    fail(`${label} failed${detail ? `: ${detail}` : ''}`);
  }
  if (Buffer.byteLength(result.stdout, 'utf8') > maximumBytes) {
    fail(`${label} exceeded the bounded output limit`);
  }
  return result.stdout;
}

function runAws(options, serviceArgs, label, { profile = options.awsProfile } = {}) {
  const identity = serviceArgs.slice(0, 2).join(' ');
  if (!READ_ONLY_COMMANDS.has(identity)) {
    fail(`refusing non-read-only AWS command: ${identity}`);
  }
  const global = [
    '--no-cli-pager',
    '--region',
    options.region,
    '--profile',
    profile,
  ];
  const output = runCommand(
    options.awsBin,
    [...global, ...serviceArgs, '--output', 'json'],
    label,
    MAX_AWS_OUTPUT_BYTES,
    options,
  );
  try {
    return JSON.parse(output);
  } catch {
    fail(`${label} returned invalid JSON`);
  }
}

function runReceiptVerifier(options, kind, { allowExpired = false } = {}) {
  const args = [
    RECEIPT_HELPER,
    `verify-${kind}`,
    '--input',
    kind === 'activation' ? options.activationReceipt : options.lifecycleReceipt,
    '--public-key',
    options.publicKey,
    '--key-id',
    options.keyId,
    ...(allowExpired ? ['--allow-expired'] : []),
    ...(kind === 'lifecycle'
      ? ['--backup-success-receipt', options.backupSuccessReceipt]
      : []),
  ];
  const output = runCommand(process.execPath, args, `${kind} receipt verification`);
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    fail(`${kind} receipt verifier returned invalid JSON`);
  }
  if (value?.ok !== true || value.kind !== kind || !SHA256.test(value.receiptSha256 || '')) {
    fail(`${kind} receipt verifier returned invalid evidence`);
  }
  return value;
}

function runTransitionVerifier(options, kind, { allowExpired = false } = {}) {
  const args = [
    RECEIPT_HELPER,
    'verify-transition',
    '--kind',
    kind,
    '--input',
    kind === 'activation'
      ? options.activationTransitionReceipt
      : options.lifecycleTransitionReceipt,
    '--receipt',
    kind === 'activation' ? options.activationReceipt : options.lifecycleReceipt,
    '--public-key',
    options.publicKey,
    '--key-id',
    options.keyId,
    ...(allowExpired ? ['--allow-expired'] : []),
    ...(kind === 'lifecycle'
      ? ['--backup-success-receipt', options.backupSuccessReceipt]
      : []),
  ];
  const output = runCommand(
    process.execPath,
    args,
    `${kind} transition receipt verification`,
  );
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    fail(`${kind} transition receipt verifier returned invalid JSON`);
  }
  if (value?.ok !== true
      || value.kind !== 'transition'
      || value.transitionKind !== kind
      || !SHA256.test(value.receiptSha256 || '')) {
    fail(`${kind} transition receipt verifier returned invalid evidence`);
  }
  return value;
}

const TRANSITION_ENTRY_KEYS = [
  'changeSetCreationTime',
  'changeSetExecutionStatus',
  'changeSetId',
  'cloudTrailEventId',
  'cloudTrailLookupVerified',
  'currentCallerMatchesExecutor',
  'executedAt',
  'executionWithinAuthorizationWindow',
  'executorArnSha256',
  'executorUserIdSha256',
  'kind',
  'liveStackStatus',
  'payloadSha256',
  'priorStackSha256',
  'receiptSha256',
  'stackLastUpdatedAt',
  'successfulTransition',
  'transitionPayloadSha256',
  'transitionReceiptSha256',
];

function transitionDigest(transitionReceipt) {
  return sha256(Buffer.from(
    canonicalJson(transitionReceipt.payload.transition.priorStack),
    'utf8',
  ));
}

function validateTransitionEntry(entry, kind, receipt, transitionReceipt) {
  exactKeys(entry, TRANSITION_ENTRY_KEYS, `${kind} transition proof`);
  const transition = transitionReceipt.payload.transition;
  const issuedAt = canonicalTimestamp(
    transitionReceipt.payload.issuedAt,
    `${kind} transition issuedAt`,
  );
  const expiresAt = canonicalTimestamp(
    transitionReceipt.payload.expiresAt,
    `${kind} transition expiresAt`,
  );
  const executedAt = canonicalTimestamp(entry.executedAt, `${kind} executedAt`);
  const stackLastUpdatedAt = canonicalTimestamp(
    entry.stackLastUpdatedAt,
    `${kind} stackLastUpdatedAt`,
  );
  const creationTime = canonicalTimestamp(
    entry.changeSetCreationTime,
    `${kind} change-set creation time`,
  );
  if (entry.kind !== kind
      || entry.receiptSha256 !== receipt.receiptSha256
      || entry.payloadSha256 !== receipt.payloadSha256
      || entry.transitionReceiptSha256 !== transitionReceipt.receiptSha256
      || entry.transitionPayloadSha256 !== transitionReceipt.payloadSha256
      || entry.changeSetId !== transition.changeSetId
      || entry.priorStackSha256 !== transitionDigest(transitionReceipt)
      || entry.executorArnSha256 !== transition.executorArnSha256
      || entry.executorUserIdSha256 !== transition.executorUserIdSha256
      || !UUID.test(entry.cloudTrailEventId || '')
      || entry.changeSetExecutionStatus !== 'EXECUTE_COMPLETE'
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(entry.liveStackStatus)
      || entry.cloudTrailLookupVerified !== true
      || entry.currentCallerMatchesExecutor !== true
      || entry.executionWithinAuthorizationWindow !== true
      || entry.successfulTransition !== true
      || executedAt < issuedAt
      || executedAt > expiresAt
      || stackLastUpdatedAt < issuedAt
      || stackLastUpdatedAt > expiresAt
      || creationTime < canonicalTimestamp(
        transition.priorStack.capturedAt,
        `${kind} prior stack capturedAt`,
      )
      || creationTime > executedAt) {
    fail(`${kind} transition proof does not bind a successful authorized execution`);
  }
  return entry;
}

function readTransitionRecord(
  file,
  kind,
  receipt,
  transitionReceipt,
  expectedActivation,
) {
  const ownerUid = testFilesystemMode() ? process.getuid() : 0;
  const recordFile = readRegularFile(
    file,
    `${kind} transition record`,
    256 * 1024,
    { privateFile: true, ownerUid },
  );
  let record;
  try {
    record = JSON.parse(recordFile.body.toString('utf8'));
  } catch {
    fail(`${kind} transition record is not valid JSON`);
  }
  if (!recordFile.body.equals(
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'),
  )) {
    fail(`${kind} transition record is not canonical durable evidence`);
  }
  exactKeys(record.authorization, ['activation', 'lifecycle', 'mode', 'schema'],
    'transition authorization');
  const expectedMode = `${kind}-transition`;
  if (record.schema !== EVIDENCE_SCHEMA
      || record.authorization.schema !== AUTHORIZATION_SCHEMA
      || record.authorization.mode !== expectedMode
      || record.stackName !== receipt.payload.stack.name
      || record.stackId !== transitionReceipt.payload.transition.priorStack.stackId
      || record.region !== receipt.payload.stack.region
      || record.accountId !== receipt.payload.stack.accountId
      || record.protectedMainTemplateSha256 !== receipt.payload.stack.templateSha256
      || record.ownerReceiptKeyId !== receipt.keyId
      || record.ownerReceiptPublicKeySha256
        !== receipt.payload.signingPublicKeySha256
      || record.stackStatus !== 'UPDATE_COMPLETE'
      || record.exactTemplateVerified !== true
      || record.exactStackParametersVerified !== true
      || record.exactStackOutputsVerified !== true
      || record.completeResourceInventoryVerified !== true) {
    fail(`${kind} transition record is outside the exact receipt stack boundary`);
  }
  if (kind === 'activation') {
    if (record.authorization.lifecycle !== null
        || record.rolesAnywhereActivation !== 'ENABLED'
        || record.rolesAnywhereActivationReceiptSha256 !== receipt.receiptSha256
        || record.lifecycleActivation !== 'DISABLED'
        || record.lifecycleBootstrapReceiptSha256 !== '') {
      fail('activation transition record unexpectedly contains lifecycle authority');
    }
    return validateTransitionEntry(
      record.authorization.activation,
      'activation',
      receipt,
      transitionReceipt,
    );
  }
  if (!expectedActivation
      || canonicalJson(record.authorization.activation)
        !== canonicalJson(expectedActivation)
      || record.rolesAnywhereActivation !== 'ENABLED'
      || record.rolesAnywhereActivationReceiptSha256
        !== receipt.payload.activationReceiptSha256
      || record.lifecycleActivation !== 'ENABLED'
      || record.lifecycleBootstrapReceiptSha256 !== receipt.receiptSha256) {
    fail('lifecycle transition record does not carry the exact activation proof');
  }
  return validateTransitionEntry(
    record.authorization.lifecycle,
    'lifecycle',
    receipt,
    transitionReceipt,
  );
}

function mapNamed(values, keyName, valueName, label) {
  if (!Array.isArray(values)) fail(`${label} is malformed`);
  const result = new Map();
  for (const value of values) {
    const key = value?.[keyName];
    if (typeof key !== 'string' || result.has(key)
        || typeof value?.[valueName] !== 'string') {
      fail(`${label} contains duplicate or invalid entries`);
    }
    result.set(key, value[valueName]);
  }
  return result;
}

function requireMapValue(map, key, expected, label) {
  if (map.get(key) !== expected) fail(`${label} ${key} is mismatched`);
}

function manualTokenPages(options, baseArgs, arrayName, label) {
  const results = [];
  const seenTokens = new Set();
  let token = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = runAws(
      options,
      [
        ...baseArgs,
        '--max-items',
        '100',
        ...(token ? ['--starting-token', token] : []),
      ],
      `${label} page ${page + 1}`,
    );
    if (!Array.isArray(response[arrayName])) fail(`${label} page is malformed`);
    results.push(...response[arrayName]);
    const next = response.NextToken;
    if (next == null) return results;
    if (typeof next !== 'string' || next.length < 1 || next.length > 4096
        || seenTokens.has(next)) {
      fail(`${label} pagination token is invalid or repeated`);
    }
    seenTokens.add(next);
    token = next;
  }
  fail(`${label} exceeded ${MAX_PAGES} pages`);
}

function awsTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} is not an AWS timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} is not an AWS timestamp`);
  return new Date(parsed).toISOString();
}

function assertTransitionExecutor(kind, transitionReceipt, identity) {
  const executorArnSha256 = sha256(Buffer.from(identity.Arn, 'utf8'));
  const executorUserIdSha256 = sha256(Buffer.from(identity.UserId, 'utf8'));
  if (executorArnSha256
        !== transitionReceipt.payload.transition.executorArnSha256
      || executorUserIdSha256
        !== transitionReceipt.payload.transition.executorUserIdSha256) {
    fail(`${kind} transition verifier is not running as the authorized executor`);
  }
  return { executorArnSha256, executorUserIdSha256 };
}

function validateTransitionExecution(
  options,
  kind,
  receipt,
  transitionReceipt,
  identity,
  liveStack,
  liveParameters,
) {
  const transition = transitionReceipt.payload.transition;
  const { executorArnSha256, executorUserIdSha256 } =
    assertTransitionExecutor(kind, transitionReceipt, identity);
  if (liveStack.StackId !== transition.priorStack.stackId
      || liveStack.StackStatus !== 'UPDATE_COMPLETE') {
    fail(`${kind} transition did not complete on the exact prior stack`);
  }
  const changeSet = runAws(
    options,
    [
      'cloudformation',
      'describe-change-set',
      '--change-set-name',
      transition.changeSetId,
      '--stack-name',
      transition.priorStack.stackId,
    ],
    `${kind} CloudFormation change set`,
  );
  if (changeSet.NextToken != null
      || changeSet.ChangeSetId !== transition.changeSetId
      || changeSet.StackId !== transition.priorStack.stackId
      || changeSet.StackName !== receipt.payload.stack.name
      || changeSet.ChangeSetType !== 'UPDATE'
      || changeSet.Status !== 'CREATE_COMPLETE'
      || changeSet.ExecutionStatus !== 'EXECUTE_COMPLETE') {
    fail(`${kind} CloudFormation change set is not the exact completed transition`);
  }
  const alarmArn = `arn:${receipt.payload.stack.trustAnchorArn.split(':')[1]}:`
    + `cloudwatch:${receipt.payload.stack.region}:${receipt.payload.stack.accountId}:`
    + `alarm:${receipt.payload.stack.name}-roles-anywhere-activation-rollback`;
  const expectedRollback = kind === 'activation'
    ? {
      RollbackTriggers: [{ Arn: alarmArn, Type: 'AWS::CloudWatch::Alarm' }],
      MonitoringTimeInMinutes: 15,
    }
    : { RollbackTriggers: [], MonitoringTimeInMinutes: 0 };
  const actualRollback = {
    RollbackTriggers: changeSet.RollbackConfiguration?.RollbackTriggers ?? [],
    MonitoringTimeInMinutes:
      changeSet.RollbackConfiguration?.MonitoringTimeInMinutes ?? 0,
  };
  if (canonicalJson(actualRollback) !== canonicalJson(expectedRollback)) {
    fail(`${kind} change set did not use the exact rollback-trigger contract`);
  }
  const changeSetParameters = mapNamed(
    changeSet.Parameters,
    'ParameterKey',
    'ParameterValue',
    `${kind} change-set parameters`,
  );
  if (canonicalJson([...changeSetParameters.entries()].sort())
      !== canonicalJson([...liveParameters.entries()].sort())) {
    fail(`${kind} change-set parameters differ from the exact live stack`);
  }
  const creationTime = awsTimestamp(
    changeSet.CreationTime,
    `${kind} change-set creation time`,
  );
  const stackLastUpdatedAt = awsTimestamp(
    liveStack.LastUpdatedTime,
    `${kind} stack last-updated time`,
  );
  const events = manualTokenPages(
    options,
    [
      'cloudtrail',
      'lookup-events',
      '--lookup-attributes',
      'AttributeKey=EventName,AttributeValue=ExecuteChangeSet',
      '--start-time',
      transitionReceipt.payload.issuedAt,
      '--end-time',
      transitionReceipt.payload.expiresAt,
    ],
    'Events',
    `${kind} ExecuteChangeSet CloudTrail events`,
  );
  const matches = [];
  for (const event of events) {
    let detail;
    try {
      detail = JSON.parse(event.CloudTrailEvent);
    } catch {
      fail(`${kind} CloudTrail event contains invalid detail JSON`);
    }
    const eventTime = awsTimestamp(event.EventTime, `${kind} CloudTrail event time`);
    const detailTime = awsTimestamp(
      detail.eventTime,
      `${kind} CloudTrail detail time`,
    );
    if (event.EventName === 'ExecuteChangeSet'
        && detail.eventSource === 'cloudformation.amazonaws.com'
        && detail.eventName === 'ExecuteChangeSet'
        && detail.awsRegion === receipt.payload.stack.region
        && detail.recipientAccountId === receipt.payload.stack.accountId
        && detail.userIdentity?.accountId === receipt.payload.stack.accountId
        && detail.userIdentity?.arn === identity.Arn
        && detail.userIdentity?.principalId === identity.UserId
        && detail.requestParameters?.changeSetName === transition.changeSetId
        && [receipt.payload.stack.name, transition.priorStack.stackId].includes(
          detail.requestParameters?.stackName,
        )
        && detail.errorCode == null
        && detail.errorMessage == null
        && detail.readOnly === false
        && event.EventId === detail.eventID
        && UUID.test(event.EventId || '')
        && eventTime === detailTime) {
      matches.push({ eventId: event.EventId, executedAt: eventTime });
    }
  }
  if (matches.length !== 1) {
    fail(`${kind} transition requires one exact successful CloudTrail execution event`);
  }
  const proof = {
    kind,
    receiptSha256: receipt.receiptSha256,
    payloadSha256: receipt.payloadSha256,
    transitionReceiptSha256: transitionReceipt.receiptSha256,
    transitionPayloadSha256: transitionReceipt.payloadSha256,
    changeSetId: transition.changeSetId,
    priorStackSha256: transitionDigest(transitionReceipt),
    executorArnSha256,
    executorUserIdSha256,
    changeSetCreationTime: creationTime,
    executedAt: matches[0].executedAt,
    stackLastUpdatedAt,
    cloudTrailEventId: matches[0].eventId,
    changeSetExecutionStatus: changeSet.ExecutionStatus,
    liveStackStatus: liveStack.StackStatus,
    cloudTrailLookupVerified: true,
    currentCallerMatchesExecutor: true,
    executionWithinAuthorizationWindow: true,
    successfulTransition: true,
  };
  return validateTransitionEntry(proof, kind, receipt, transitionReceipt);
}

function validateRollbackAlarm(options, stack, alarmArn) {
  const alarmName = `${options.stackName}-roles-anywhere-activation-rollback`;
  const response = runAws(
    options,
    ['cloudwatch', 'describe-alarms', '--alarm-names', alarmName],
    'Sonar activation rollback alarm',
  );
  const alarms = response.MetricAlarms;
  const alarm = Array.isArray(alarms) && alarms.length === 1 ? alarms[0] : null;
  if (!alarm
      || alarm.AlarmArn !== alarmArn
      || alarm.AlarmName !== alarmName
      || alarm.ComparisonOperator !== 'LessThanThreshold'
      || alarm.DatapointsToAlarm !== 4
      || alarm.EvaluationPeriods !== 4
      || alarm.MetricName !== 'ActivationLease'
      || alarm.Namespace !== 'Nexus/SonarQube'
      || alarm.Period !== 30
      || alarm.Statistic !== 'Minimum'
      || alarm.Threshold !== 1
      || alarm.TreatMissingData !== 'breaching'
      || alarm.Unit !== 'Count'
      || canonicalJson(alarm.Dimensions)
        !== canonicalJson([{ Name: 'StackName', Value: options.stackName }])
      || !['ALARM', 'OK'].includes(alarm.StateValue)) {
    fail('Sonar activation rollback alarm differs from the protected template');
  }
  const expectedPrefix = `arn:${stack.trustAnchorArn.split(':')[1]}:cloudwatch:`
    + `${stack.region}:${stack.accountId}:alarm:`;
  if (!alarmArn.startsWith(expectedPrefix)) {
    fail('Sonar activation rollback alarm is outside the exact stack account');
  }
}

function normalizePolicy(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizePolicy);
    if (normalized.every((entry) => typeof entry === 'string')) {
      return normalized.sort();
    }
    if (normalized.every(
      (entry) => entry && typeof entry === 'object' && typeof entry.Sid === 'string',
    )) {
      return normalized.sort((left, right) => left.Sid.localeCompare(right.Sid));
    }
    return normalized;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, normalizePolicy(value[key])]),
  );
}

function exactPolicy(actual, expected, label) {
  if (canonicalJson(normalizePolicy(actual)) !== canonicalJson(normalizePolicy(expected))) {
    fail(`${label} differs from the governed policy`);
  }
}

function expectedTrustPolicy(
  trustAnchorArn,
  accountId,
  issuerCommonName,
  subjectCommonName,
) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Service: 'rolesanywhere.amazonaws.com' },
      Action: ['sts:AssumeRole', 'sts:SetSourceIdentity', 'sts:TagSession'],
      Condition: {
        ArnEquals: { 'aws:SourceArn': trustAnchorArn },
        StringEquals: {
          'aws:SourceAccount': accountId,
          'aws:PrincipalTag/x509Issuer/CN': issuerCommonName,
          'aws:PrincipalTag/x509Subject/CN': subjectCommonName,
        },
      },
    }],
  };
}

function expectedWriterPolicy(bucketArn, prefix) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'InspectBucketVersioning',
        Effect: 'Allow',
        Action: ['s3:GetBucketVersioning'],
        Resource: bucketArn,
      },
      {
        Sid: 'ListExactSonarPrefix',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
      },
      {
        Sid: 'SonarBackupObjectIO',
        Effect: 'Allow',
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        Resource: [
          `${bucketArn}/${prefix}/daily/*`,
          `${bucketArn}/${prefix}/weekly/*`,
        ],
      },
    ],
  };
}

function expectedRestorePolicy(bucketArn, prefix) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'ReadExactSonarVersions',
      Effect: 'Allow',
      Action: ['s3:GetObjectVersion'],
      Resource: [
        `${bucketArn}/${prefix}/daily/*`,
        `${bucketArn}/${prefix}/weekly/*`,
      ],
    }],
  };
}

function expectedBucketPolicy(bucketArn, prefix, backupRoleArn, restoreRoleArn) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyPlaintextTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: {
          Bool: {
            'aws:SecureTransport': 'false',
            'aws:PrincipalIsAWSService': 'false',
          },
        },
      },
      {
        Sid: 'DenyLegacyTls',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: {
          NumericLessThan: { 's3:TlsVersion': 1.2 },
          Bool: { 'aws:PrincipalIsAWSService': 'false' },
        },
      },
      {
        Sid: 'DenyDirectVersionDeletion',
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:DeleteObjectVersion'],
        Resource: `${bucketArn}/${prefix}/*`,
      },
      {
        Sid: 'DenyWriterBucketControlMutation',
        Effect: 'Deny',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteBucketPolicy',
          's3:PutBucketPublicAccessBlock',
          's3:PutBucketPolicy',
          's3:PutBucketVersioning',
          's3:PutEncryptionConfiguration',
          's3:PutLifecycleConfiguration',
        ],
        Resource: bucketArn,
      },
      {
        Sid: 'DenyWriterObjectIOOutsideSonarPrefix',
        Effect: 'Deny',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        NotResource: `${bucketArn}/${prefix}/*`,
      },
      {
        Sid: 'AllowWriterBucketInspection',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: ['s3:GetBucketVersioning'],
        Resource: bucketArn,
      },
      {
        Sid: 'AllowWriterExactPrefixListing',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: ['s3:ListBucket'],
        Resource: bucketArn,
        Condition: { StringLike: { 's3:prefix': [`${prefix}/*`] } },
      },
      {
        Sid: 'AllowWriterExactPrefixObjects',
        Effect: 'Allow',
        Principal: { AWS: backupRoleArn },
        Action: [
          's3:DeleteObject',
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
        ],
        Resource: [
          `${bucketArn}/${prefix}/daily/*`,
          `${bucketArn}/${prefix}/weekly/*`,
        ],
      },
      {
        Sid: 'AllowRestoreExactPrefixVersions',
        Effect: 'Allow',
        Principal: { AWS: restoreRoleArn },
        Action: ['s3:GetObjectVersion'],
        Resource: [
          `${bucketArn}/${prefix}/daily/*`,
          `${bucketArn}/${prefix}/weekly/*`,
        ],
      },
    ],
  };
}

function validateRequiredTags(values, expected, label) {
  if (!Array.isArray(values)) fail(`${label} tags are malformed`);
  const tags = new Map();
  for (const value of values) {
    const key = value?.Key ?? value?.key;
    const tagValue = value?.Value ?? value?.value;
    if (typeof key !== 'string' || typeof tagValue !== 'string' || tags.has(key)) {
      fail(`${label} tags are malformed or duplicated`);
    }
    tags.set(key, tagValue);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (tags.get(key) !== value) fail(`${label} tag ${key} is mismatched`);
  }
  if (tags.size !== Object.keys(expected).length) {
    fail(`${label} has unexpected tags`);
  }
}

function validateRole(options, identity, kind, expectedTags, stack) {
  const roleName = basename(identity.roleArn);
  const roleResponse = runAws(
    options,
    ['iam', 'get-role', '--role-name', roleName],
    `${kind} IAM role`,
  );
  const role = roleResponse.Role;
  if (!role
      || role.Arn !== identity.roleArn
      || role.RoleName !== roleName
      || role.Path !== '/nexus/sonarqube/'
      || role.MaxSessionDuration !== 3600
      || role.PermissionsBoundary != null) {
    fail(`${kind} IAM role identity is mismatched`);
  }
  exactPolicy(
    role.AssumeRolePolicyDocument,
    expectedTrustPolicy(
      stack.trustAnchorArn,
      stack.accountId,
      identity.issuerCommonName,
      identity.subjectCommonName,
    ),
    `${kind} IAM trust policy`,
  );
  const policyNames = manualTokenPages(
    options,
    ['iam', 'list-role-policies', '--role-name', roleName],
    'PolicyNames',
    `${kind} inline role policies`,
  );
  const expectedName = kind === 'backup'
    ? 'NexusSonarBackupWriter'
    : 'NexusSonarBackupRestore';
  if (canonicalJson(policyNames) !== canonicalJson([expectedName])) {
    fail(`${kind} IAM role has unexpected inline policies`);
  }
  const attached = manualTokenPages(
    options,
    ['iam', 'list-attached-role-policies', '--role-name', roleName],
    'AttachedPolicies',
    `${kind} attached role policies`,
  );
  if (attached.length !== 0) fail(`${kind} IAM role has attached policies`);
  const policy = runAws(
    options,
    [
      'iam',
      'get-role-policy',
      '--role-name',
      roleName,
      '--policy-name',
      expectedName,
    ],
    `${kind} inline IAM policy`,
  );
  exactPolicy(
    policy.PolicyDocument,
    kind === 'backup'
      ? expectedWriterPolicy(stack.bucketArn, stack.sonarPrefix)
      : expectedRestorePolicy(stack.bucketArn, stack.sonarPrefix),
    `${kind} inline IAM policy`,
  );
  const tags = manualTokenPages(
    options,
    ['iam', 'list-role-tags', '--role-name', roleName],
    'Tags',
    `${kind} IAM role tags`,
  );
  validateRequiredTags(tags, expectedTags, `${kind} IAM role`);
}

function validateProfile(options, identity, kind, expectedTags, expectedPolicy) {
  const match = identity.profileArn.match(PROFILE_ARN);
  if (!match) fail(`${kind} profile ARN is invalid`);
  const profileResponse = runAws(
    options,
    ['rolesanywhere', 'get-profile', '--profile-id', match[4]],
    `${kind} Roles Anywhere profile`,
  );
  const profile = profileResponse.profile;
  const expectedMappings = [
    { certificateField: 'x509Issuer', mappingRules: [{ specifier: 'CN' }] },
    { certificateField: 'x509Subject', mappingRules: [{ specifier: 'CN' }] },
  ];
  if (!profile
      || profile.profileArn !== identity.profileArn
      || profile.profileId !== match[4]
      || profile.name !== `${options.stackName}-${kind}`
      || profile.enabled !== true
      || profile.durationSeconds !== 900
      || profile.acceptRoleSessionName !== false
      || (profile.managedPolicyArns != null
        && canonicalJson(profile.managedPolicyArns) !== '[]')
      || (profile.requireInstanceProperties != null
        && profile.requireInstanceProperties !== false)
      || canonicalJson(profile.roleArns) !== canonicalJson([identity.roleArn])
      || canonicalJson(profile.attributeMappings) !== canonicalJson(expectedMappings)) {
    fail(`${kind} Roles Anywhere profile state is mismatched`);
  }
  let sessionPolicy;
  try {
    sessionPolicy = JSON.parse(profile.sessionPolicy);
  } catch {
    fail(`${kind} Roles Anywhere session policy is invalid JSON`);
  }
  exactPolicy(sessionPolicy, expectedPolicy, `${kind} Roles Anywhere session policy`);
  const tagResponse = runAws(
    options,
    [
      'rolesanywhere',
      'list-tags-for-resource',
      '--resource-arn',
      identity.profileArn,
    ],
    `${kind} Roles Anywhere profile tags`,
  );
  if (tagResponse.nextToken != null || tagResponse.NextToken != null) {
    fail(`${kind} profile tag response was incomplete`);
  }
  validateRequiredTags(tagResponse.tags, expectedTags, `${kind} profile`);
}

function canonicalBase64(value, label) {
  if (typeof value !== 'string' || value.length < 4) fail(`${label} is invalid`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < 1 || decoded.toString('base64') !== value) {
    fail(`${label} is not canonical base64`);
  }
  return decoded;
}

function pemCrlFromDerBase64(value, label) {
  const der = canonicalBase64(value, label);
  const encoded = der.toString('base64');
  const lines = encoded.match(/.{1,64}/gu);
  if (!lines || lines.join('') !== encoded) {
    fail(`${label} could not be encoded as canonical PEM`);
  }
  return `-----BEGIN X509 CRL-----\n${lines.join('\n')}\n-----END X509 CRL-----\n`;
}

function normalizeCertificateSerial(value, label) {
  const compact = String(value || '').replace(/[:\s]/gu, '').toUpperCase();
  if (!/^[0-9A-F]+$/u.test(compact)) fail(`${label} is invalid`);
  return compact.replace(/^0+(?=[0-9A-F])/u, '');
}

function revokedCertificateSerial(
  options,
  certificatePath,
  expectedOwnerUid,
) {
  if (!isAbsolute(certificatePath || '') || resolve(certificatePath) !== certificatePath) {
    fail('revoked Sonar certificate path must be a canonical absolute path');
  }
  validateTrustedParentPath(
    certificatePath,
    'revoked Sonar certificate',
    expectedOwnerUid,
  );
  const certificate = readRegularFile(
    certificatePath,
    'revoked Sonar certificate',
    256 * 1024,
    {
      ownerUid: expectedOwnerUid,
      rejectGroupWorldWrite: true,
    },
  );
  const output = runCommand(
    options.opensslBin,
    ['x509', '-inform', 'PEM', '-noout', '-serial'],
    'revoked Sonar certificate serial inspection',
    64 * 1024,
    { input: certificate.body },
  );
  const match = output.trim().match(/^serial=([0-9A-Fa-f:]+)$/u);
  if (!match) fail('revoked Sonar certificate serial output is invalid');
  return normalizeCertificateSerial(match[1], 'revoked Sonar certificate serial');
}

function liveCrlRevokedSerials(options, liveCrl) {
  const output = runCommand(
    options.opensslBin,
    ['crl', '-inform', 'DER', '-noout', '-text'],
    'live Sonar CRL revoked-certificate inspection',
    1024 * 1024,
    { input: liveCrl },
  );
  const serials = new Set();
  for (const match of output.matchAll(/Serial Number:\s*([0-9A-Fa-f:]+)/gu)) {
    serials.add(normalizeCertificateSerial(match[1], 'live Sonar CRL serial'));
  }
  return serials;
}

function validateTrustAnchorAndCrl(
  options,
  stack,
  parameters,
  outputs,
  activationPayload,
) {
  const trustAnchor = stack.trustAnchorArn.match(
    /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:[^:]+:[0-9]{12}:trust-anchor\/([0-9a-f-]{36})$/u,
  );
  if (!trustAnchor) fail('Sonar trust anchor ARN is invalid');
  const anchor = runAws(
    options,
    ['rolesanywhere', 'get-trust-anchor', '--trust-anchor-id', trustAnchor[2]],
    'Sonar Roles Anywhere trust anchor',
  ).trustAnchor;
  const certificate = parameters.get('TrustAnchorCertificateData');
  if (!anchor
      || anchor.trustAnchorArn !== stack.trustAnchorArn
      || anchor.trustAnchorId !== trustAnchor[2]
      || anchor.name !== `${options.stackName}-ca`
      || anchor.enabled !== true
      || anchor.source?.sourceType !== 'CERTIFICATE_BUNDLE'
      || anchor.source?.sourceData?.x509CertificateData !== certificate
      || sha256(Buffer.from(certificate || '', 'utf8'))
        !== activationPayload.evidence.caCertificateSha256) {
    fail('Sonar trust anchor identity, state, or certificate is mismatched');
  }
  validateRequiredTags(
    runAws(
      options,
      ['rolesanywhere', 'list-tags-for-resource', '--resource-arn', stack.trustAnchorArn],
      'Sonar trust anchor tags',
    ).tags,
    {
      application: 'nexus-hub',
      purpose: 'sonarqube-backup-authentication',
      'isolation-boundary': 'separate-from-application-dr',
    },
    'Sonar trust anchor',
  );

  const crlId = outputs.get('RolesAnywhereCrlId');
  if (!UUID.test(crlId || '')) fail('Sonar CRL output is invalid');
  const crl = runAws(
    options,
    ['rolesanywhere', 'get-crl', '--crl-id', crlId],
    'Sonar Roles Anywhere CRL',
  ).crl;
  const liveCrlPem = canonicalBase64(crl?.crlData, 'live Sonar CRL');
  const expectedCrlPem = Buffer.from(
    parameters.get('CertificateRevocationListData') || '',
    'utf8',
  );
  const expectedCrl = canonicalBase64(
    activationPayload.material.crlData,
    'activation Sonar CRL',
  );
  const receiptCrlPem = Buffer.from(
    pemCrlFromDerBase64(
      activationPayload.material.crlData,
      'activation Sonar CRL',
    ),
    'utf8',
  );
  const expectedDigest = parameters.get('CertificateRevocationListSha256');
  if (!crl
      || crl.crlId !== crlId
      || crl.name !== `${options.stackName}-crl`
      || crl.trustAnchorArn !== stack.trustAnchorArn
      || crl.enabled !== true
      || !liveCrlPem.equals(expectedCrlPem)
      || !expectedCrlPem.equals(receiptCrlPem)
      || sha256(expectedCrl) !== expectedDigest
      || expectedDigest !== outputs.get('RolesAnywhereCrlSha256')
      || expectedDigest !== activationPayload.evidence.revocationMaterialSha256) {
    fail('Sonar CRL identity, state, or bytes are mismatched');
  }
  validateRequiredTags(
    runAws(
      options,
      ['rolesanywhere', 'list-tags-for-resource', '--resource-arn', crl.crlArn],
      'Sonar CRL tags',
    ).tags,
    {
      application: 'nexus-hub',
      purpose: 'sonarqube-backup-revocation',
      'isolation-boundary': 'separate-from-application-dr',
      'crl-sha256': expectedDigest,
    },
    'Sonar CRL',
  );
  return expectedCrl;
}

function runRevokedProbe(options) {
  const result = spawnSync(
    options.awsBin,
    [
      '--no-cli-pager',
      '--region',
      options.region,
      '--profile',
      options.revokedProbeProfile,
      'sts',
      'get-caller-identity',
      '--output',
      'json',
    ],
    {
      encoding: 'utf8',
      maxBuffer: MAX_AWS_OUTPUT_BYTES,
      env: commandEnvironment(options),
      timeout: 25_000,
    },
  );
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    fail('revoked-certificate probe did not produce a bounded denial status');
  }
  if (result.status === 0) {
    fail('revoked certificate unexpectedly obtained AWS credentials');
  }
  if (String(result.stdout || '').trim()) {
    fail('revoked-certificate probe returned credentials on its denial path');
  }
  if (!String(result.stderr || '').trim()) {
    fail('revoked-certificate probe returned no denial diagnostic');
  }
  const diagnostic = String(result.stderr);
  const accessDenied = /\b(?:AccessDeniedException|AccessDenied)\b/iu.test(diagnostic);
  const rolesAnywhere = /\b(?:IAM\s+Roles\s+Anywhere|Roles\s+Anywhere|rolesanywhere|CreateSession)\b/iu
    .test(diagnostic);
  const certificateRevoked =
    /(?:certificate|x509)[^\r\n]{0,160}\brevok(?:ed|ation)\b/iu.test(diagnostic)
    || /\brevok(?:ed|ation)\b[^\r\n]{0,160}(?:certificate|x509)/iu.test(diagnostic);
  if (!accessDenied || !rolesAnywhere || !certificateRevoked) {
    fail('revoked-certificate probe was not an IAM Roles Anywhere revocation denial');
  }
}

function validateCredentialProbes(
  options,
  stack,
  backupRoleArn,
  outputs,
  awsConfigBody,
  liveCrl,
  expectedOwnerUid,
) {
  const probeProfiles = validateProbeProfileBindings(
    options,
    outputs,
    awsConfigBody,
  );
  const revokedSerial = revokedCertificateSerial(
    options,
    probeProfiles.revoked.get('--certificate'),
    expectedOwnerUid,
  );
  if (!liveCrlRevokedSerials(options, liveCrl).has(revokedSerial)) {
    fail('configured revoked Sonar certificate serial is absent from the exact live CRL');
  }
  const identity = runAws(
    options,
    ['sts', 'get-caller-identity'],
    'positive Sonar Roles Anywhere credential probe',
    { profile: options.backupProbeProfile },
  );
  const roleName = basename(backupRoleArn);
  const escapedRole = roleName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const assumedRole = new RegExp(
    `^arn:(aws|aws-us-gov|aws-cn):sts::${stack.accountId}:`
      + `assumed-role/${escapedRole}/[^/]+$`,
    'u',
  );
  if (identity.Account !== stack.accountId || !assumedRole.test(identity.Arn || '')) {
    fail('positive Sonar Roles Anywhere probe returned an unexpected principal');
  }
  const listing = runAws(
    options,
    [
      's3api',
      'list-objects-v2',
      '--bucket',
      stack.bucketName,
      '--prefix',
      `${stack.sonarPrefix}/`,
      '--max-keys',
      '1',
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'positive Sonar prefix-listing probe',
    { profile: options.backupProbeProfile },
  );
  if (!Number.isSafeInteger(listing.KeyCount)) {
    fail('positive Sonar prefix-listing probe returned invalid evidence');
  }
  runRevokedProbe(options);
  const postDenialIdentity = runAws(
    options,
    ['sts', 'get-caller-identity'],
    'post-denial positive Sonar Roles Anywhere credential probe',
    { profile: options.backupProbeProfile },
  );
  if (postDenialIdentity.Account !== stack.accountId
      || !assumedRole.test(postDenialIdentity.Arn || '')) {
    fail('post-denial positive Sonar probe returned an unexpected principal');
  }
  return {
    exactProbeProfileBindingsPassed: true,
    positiveCredentialsPassed: true,
    exactPrefixListingPassed: true,
    revokedCertificateSerialPresentInLiveCrl: true,
    revokedCertificateSerialSha256: sha256(Buffer.from(revokedSerial, 'utf8')),
    revokedCertificateDenied: true,
    revocationDenialClassified: true,
    revokedCredentialProcessFailed: true,
    postDenialPositiveCredentialsPassed: true,
    credentialsPersisted: false,
    rawAwsResponsesPersisted: false,
  };
}

function validateLifecycle(response, prefix, enabled) {
  if (response.NextToken != null || response.nextToken != null
      || !Array.isArray(response.Rules)
      || response.Rules.length !== 3) {
    fail('bucket lifecycle response is incomplete or malformed');
  }
  const rules = new Map(response.Rules.map((rule) => [rule.ID, rule]));
  if (rules.size !== 3) fail('bucket lifecycle rule IDs are duplicated');
  const hygiene = rules.get('SonarNamespaceHygiene');
  const daily = rules.get('SonarDailyNoncurrentVersionRetention');
  const weekly = rules.get('SonarWeeklyNoncurrentVersionRetention');
  if (!hygiene
      || hygiene.Prefix !== `${prefix}/`
      || hygiene.Status !== 'Enabled'
      || hygiene.AbortIncompleteMultipartUpload?.DaysAfterInitiation !== 7
      || Object.keys(hygiene).some(
        (key) => !['AbortIncompleteMultipartUpload', 'ID', 'Prefix', 'Status'].includes(key),
      )) {
    fail('Sonar lifecycle hygiene rule is mismatched');
  }
  for (const [rule, tier, days] of [
    [daily, 'daily', 35],
    [weekly, 'weekly', 120],
  ]) {
    if (!rule
        || rule.Prefix !== `${prefix}/${tier}/`
        || rule.Status !== (enabled ? 'Enabled' : 'Disabled')
        || rule.ExpiredObjectDeleteMarker !== true
        || rule.NoncurrentVersionExpiration?.NoncurrentDays !== days
        || Object.keys(rule).some(
          (key) => ![
            'ExpiredObjectDeleteMarker',
            'ID',
            'NoncurrentVersionExpiration',
            'Prefix',
            'Status',
          ].includes(key),
        )) {
      fail(`Sonar ${tier} lifecycle rule is mismatched`);
    }
  }
}

function validateBucket(options, stack, activationDigest, lifecycleDigest, lifecycleEnabled,
  backupRoleArn, restoreRoleArn, signingPublicKeySha256, templateSha256) {
  const bucket = stack.bucketName;
  const versioning = runAws(
    options,
    [
      's3api',
      'get-bucket-versioning',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket versioning',
  );
  if (versioning.Status !== 'Enabled' || versioning.MFADelete === 'Disabled') {
    fail('Sonar bucket versioning is not enabled');
  }
  const encryption = runAws(
    options,
    [
      's3api',
      'get-bucket-encryption',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket encryption',
  );
  const encryptionRules = encryption.ServerSideEncryptionConfiguration?.Rules;
  if (!Array.isArray(encryptionRules)
      || encryptionRules.length !== 1
      || encryptionRules[0].ApplyServerSideEncryptionByDefault?.SSEAlgorithm
        !== 'AES256'
      || encryptionRules[0].ApplyServerSideEncryptionByDefault?.KMSMasterKeyID != null) {
    fail('Sonar bucket encryption is mismatched');
  }
  const publicAccess = runAws(
    options,
    [
      's3api',
      'get-public-access-block',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket public-access block',
  ).PublicAccessBlockConfiguration;
  if (!publicAccess
      || ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets']
        .some((key) => publicAccess[key] !== true)) {
    fail('Sonar bucket public-access block is mismatched');
  }
  const ownership = runAws(
    options,
    [
      's3api',
      'get-bucket-ownership-controls',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket ownership controls',
  ).OwnershipControls;
  if (!ownership
      || canonicalJson(ownership.Rules)
        !== canonicalJson([{ ObjectOwnership: 'BucketOwnerEnforced' }])) {
    fail('Sonar bucket ownership controls are mismatched');
  }
  validateLifecycle(
    runAws(
      options,
      [
        's3api',
        'get-bucket-lifecycle-configuration',
        '--bucket',
        bucket,
        '--expected-bucket-owner',
        stack.accountId,
      ],
      'Sonar bucket lifecycle',
    ),
    stack.sonarPrefix,
    lifecycleEnabled,
  );
  const tags = runAws(
    options,
    [
      's3api',
      'get-bucket-tagging',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket tags',
  );
  validateRequiredTags(tags.TagSet, {
    application: 'nexus-hub',
    purpose: 'encrypted-sonarqube-backup',
    'isolation-boundary': 'separate-from-application-dr',
    'owner-activation-receipt-sha256': activationDigest,
    'first-backup-receipt-sha256': lifecycleDigest,
    'receipt-signing-public-key-sha256': signingPublicKeySha256,
    'protected-main-template-sha256': templateSha256,
  }, 'Sonar bucket');
  const policyResponse = runAws(
    options,
    [
      's3api',
      'get-bucket-policy',
      '--bucket',
      bucket,
      '--expected-bucket-owner',
      stack.accountId,
    ],
    'Sonar bucket policy',
  );
  let policy;
  try {
    policy = JSON.parse(policyResponse.Policy);
  } catch {
    fail('Sonar bucket policy is invalid JSON');
  }
  exactPolicy(
    policy,
    expectedBucketPolicy(
      stack.bucketArn,
      stack.sonarPrefix,
      backupRoleArn,
      restoreRoleArn,
    ),
    'Sonar bucket policy',
  );
}

function verifyLive(options) {
  const evidenceOutput = prepareRootEvidenceOutput(options.evidenceOut);
  const evidenceOwner = testFilesystemMode() ? process.getuid() : 0;
  validateTrustedExecutable(
    options.opensslBin,
    'OpenSSL binary',
    evidenceOwner,
  );
  const awsConfig = readRegularFile(
    options.awsConfig,
    'Sonar AWS profile config',
    256 * 1024,
    { privateFile: true, ownerUid: evidenceOwner },
  );
  const template = readRegularFile(
    options.template,
    'protected-main Sonar CloudFormation template',
    51_200,
  );
  const localTemplateSha256 = sha256(template.body);
  const activation = runReceiptVerifier(options, 'activation', {
    allowExpired: options.mode !== 'activation-transition',
  });
  const activationTransition = runTransitionVerifier(options, 'activation', {
    allowExpired: options.mode !== 'activation-transition',
  });
  const lifecycle = options.lifecycleReceipt
    ? runReceiptVerifier(options, 'lifecycle', {
      allowExpired: options.mode === 'steady',
    })
    : null;
  const lifecycleTransition = lifecycle
    ? runTransitionVerifier(options, 'lifecycle', {
      allowExpired: options.mode === 'steady',
    })
    : null;
  let activationProof = options.mode === 'activation-transition'
    ? null
    : readTransitionRecord(
      options.activationTransitionRecord,
      'activation',
      activation,
      activationTransition,
    );
  let lifecycleProof = options.mode === 'steady' && lifecycle
    ? readTransitionRecord(
      options.lifecycleTransitionRecord,
      'lifecycle',
      lifecycle,
      lifecycleTransition,
      activationProof,
    )
    : null;
  const activationPayload = activation.payload;
  const stack = activationPayload.stack;
  if (stack.name !== options.stackName
      || stack.region !== options.region
      || stack.templateSha256 !== localTemplateSha256) {
    fail('activation receipt is not bound to the selected stack/template');
  }
  if (lifecycle
      && (canonicalJson(lifecycle.payload.stack) !== canonicalJson(stack)
        || lifecycle.payload.activationReceiptSha256 !== activation.receiptSha256
        || lifecycle.payload.signingPublicKeySha256
          !== activationPayload.signingPublicKeySha256
        || lifecycleTransition.payload.transition.priorStack.stackId
          !== activationTransition.payload.transition.priorStack.stackId)) {
    fail('lifecycle receipt does not bind the exact activation receipt and stack');
  }

  const identity = runAws(
    options,
    ['sts', 'get-caller-identity'],
    'AWS caller identity',
  );
  if (identity.Account !== stack.accountId
      || typeof identity.Arn !== 'string'
      || typeof identity.UserId !== 'string') {
    fail('AWS caller identity is outside the receipt account');
  }
  if (options.mode === 'activation-transition') {
    assertTransitionExecutor('activation', activationTransition, identity);
  } else if (options.mode === 'lifecycle-transition') {
    assertTransitionExecutor('lifecycle', lifecycleTransition, identity);
  }
  const described = runAws(
    options,
    ['cloudformation', 'describe-stacks', '--stack-name', options.stackName],
    'Sonar CloudFormation stack',
  );
  if (described.NextToken != null
      || !Array.isArray(described.Stacks)
      || described.Stacks.length !== 1) {
    fail('CloudFormation stack response is incomplete or ambiguous');
  }
  const liveStack = described.Stacks[0];
  if (liveStack.StackName !== options.stackName
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(liveStack.StackStatus)
      || liveStack.EnableTerminationProtection !== true
      || liveStack.DisableRollback === true) {
    fail('CloudFormation stack is not in a complete state');
  }
  if (liveStack.StackId
      !== activationTransition.payload.transition.priorStack.stackId) {
    fail('CloudFormation stack ID differs from the owner-authorized transition');
  }
  const parameters = mapNamed(
    liveStack.Parameters,
    'ParameterKey',
    'ParameterValue',
    'CloudFormation parameters',
  );
  const outputs = mapNamed(
    liveStack.Outputs,
    'OutputKey',
    'OutputValue',
    'CloudFormation outputs',
  );
  const lifecycleDigest = lifecycle?.receiptSha256 ?? '';
  const lifecycleActivation = lifecycle ? 'ENABLED' : 'DISABLED';
  const expectedParameters = {
    BackupCertificateSubjectCommonName:
      activationPayload.identities.backup.subjectCommonName,
    CertificateRevocationListData: pemCrlFromDerBase64(
      activationPayload.material.crlData,
      'activation Sonar CRL',
    ),
    CertificateRevocationListSha256:
      activationPayload.evidence.revocationMaterialSha256,
    CertificateIssuerCommonName: activationPayload.issuerCommonName,
    LifecycleActivation: lifecycleActivation,
    LifecycleBootstrapReceiptSha256: lifecycleDigest,
    OwnerReceiptKeyId: activation.keyId,
    OwnerReceiptPublicKeySha256: activationPayload.signingPublicKeySha256,
    ProtectedMainTemplateSha256: localTemplateSha256,
    RestoreCertificateSubjectCommonName:
      activationPayload.identities.restore.subjectCommonName,
    RolesAnywhereActivation: 'ENABLED',
    RolesAnywhereActivationReceiptSha256: activation.receiptSha256,
    SonarPrefix: stack.sonarPrefix,
    TrustAnchorCertificateData: activationPayload.material.caCertificatePem,
  };
  if (parameters.size !== Object.keys(expectedParameters).length + 1) {
    fail('CloudFormation parameters contain unexpected or missing entries');
  }
  for (const [key, value] of Object.entries(expectedParameters)) {
    requireMapValue(parameters, key, value, 'CloudFormation parameter');
  }
  if (parameters.get('BucketName') !== '' && parameters.get('BucketName') !== stack.bucketName) {
    fail('CloudFormation BucketName parameter is mismatched');
  }
  if (options.mode === 'activation-transition') {
    activationProof = validateTransitionExecution(
      options,
      'activation',
      activation,
      activationTransition,
      identity,
      liveStack,
      parameters,
    );
  } else if (options.mode === 'lifecycle-transition') {
    lifecycleProof = validateTransitionExecution(
      options,
      'lifecycle',
      lifecycle,
      lifecycleTransition,
      identity,
      liveStack,
      parameters,
    );
  }
  const expectedOutputs = {
    BackupPrincipalArn: activationPayload.identities.backup.roleArn,
    BackupRolesAnywhereProfileArn: activationPayload.identities.backup.profileArn,
    BucketArn: stack.bucketArn,
    BucketName: stack.bucketName,
    LifecycleActivation: lifecycleActivation,
    LifecycleBootstrapReceiptSha256: lifecycleDigest,
    OwnerReceiptKeyId: activation.keyId,
    OwnerReceiptPublicKeySha256: activationPayload.signingPublicKeySha256,
    ProtectedMainTemplateSha256: localTemplateSha256,
    RestorePrincipalArn: activationPayload.identities.restore.roleArn,
    RestoreRolesAnywhereProfileArn: activationPayload.identities.restore.profileArn,
    RolesAnywhereActivationRollbackAlarmArn:
      `arn:${stack.trustAnchorArn.split(':')[1]}:cloudwatch:${options.region}:`
      + `${stack.accountId}:alarm:${options.stackName}-roles-anywhere-activation-rollback`,
    RolesAnywhereCrlId: activationPayload.material.crlId,
    RolesAnywhereCrlSha256: activationPayload.evidence.revocationMaterialSha256,
    RolesAnywhereActivation: 'ENABLED',
    RolesAnywhereActivationReceiptSha256: activation.receiptSha256,
    RolesAnywhereTrustAnchorArn: stack.trustAnchorArn,
    S3Endpoint:
      `https://s3.${options.region}.`
      + `${stack.trustAnchorArn.split(':')[1] === 'aws-cn'
        ? 'amazonaws.com.cn'
        : 'amazonaws.com'}`,
    SonarPrefix: stack.sonarPrefix,
  };
  if (outputs.size !== Object.keys(expectedOutputs).length) {
    fail('CloudFormation outputs contain unexpected or missing entries');
  }
  for (const [key, value] of Object.entries(expectedOutputs)) {
    requireMapValue(outputs, key, value, 'CloudFormation output');
  }
  validateRollbackAlarm(
    options,
    stack,
    expectedOutputs.RolesAnywhereActivationRollbackAlarmArn,
  );
  if (liveStack.Tags != null
      && (!Array.isArray(liveStack.Tags) || liveStack.Tags.length !== 0)) {
    fail('CloudFormation stack has unreviewed stack-level tags');
  }

  const remoteTemplate = runAws(
    options,
    [
      'cloudformation',
      'get-template',
      '--stack-name',
      options.stackName,
      '--template-stage',
      'Original',
    ],
    'deployed Sonar CloudFormation template',
  );
  if (typeof remoteTemplate.TemplateBody !== 'string'
      || sha256(Buffer.from(remoteTemplate.TemplateBody, 'utf8')) !== localTemplateSha256) {
    fail('deployed CloudFormation template bytes differ from protected main');
  }

  const resources = manualTokenPages(
    options,
    ['cloudformation', 'list-stack-resources', '--stack-name', options.stackName],
    'StackResourceSummaries',
    'Sonar CloudFormation resources',
  );
  const expectedResources = new Map([
    ['SonarBackupBucket', ['AWS::S3::Bucket', stack.bucketName]],
    ['SonarBackupBucketPolicy', ['AWS::S3::BucketPolicy', stack.bucketName]],
    ['SonarBackupRole', ['AWS::IAM::Role', basename(activationPayload.identities.backup.roleArn)]],
    ['SonarRestoreRole', ['AWS::IAM::Role', basename(activationPayload.identities.restore.roleArn)]],
    ['SonarBackupRolesAnywhereProfile', [
      'AWS::RolesAnywhere::Profile',
      activationPayload.identities.backup.profileArn.match(PROFILE_ARN)[4],
    ]],
    ['SonarRestoreRolesAnywhereProfile', [
      'AWS::RolesAnywhere::Profile',
      activationPayload.identities.restore.profileArn.match(PROFILE_ARN)[4],
    ]],
    ['SonarRolesAnywhereTrustAnchor', [
      'AWS::RolesAnywhere::TrustAnchor',
      stack.trustAnchorArn.match(
        /^arn:[^:]+:rolesanywhere:[^:]+:[0-9]{12}:trust-anchor\/([0-9a-f-]{36})$/u,
      )[1],
    ]],
    ['SonarRolesAnywhereCertificateRevocationList', [
      'AWS::RolesAnywhere::CRL',
      activationPayload.material.crlId,
    ]],
    ['SonarRolesAnywhereActivationRollbackAlarm', [
      'AWS::CloudWatch::Alarm',
      `${options.stackName}-roles-anywhere-activation-rollback`,
    ]],
  ]);
  if (resources.length !== expectedResources.size) {
    fail('CloudFormation stack contains unexpected resources');
  }
  for (const resource of resources) {
    const expected = expectedResources.get(resource.LogicalResourceId);
    if (!expected
        || resource.ResourceType !== expected[0]
        || resource.PhysicalResourceId !== expected[1]
        || !String(resource.ResourceStatus || '').endsWith('_COMPLETE')) {
      fail(`CloudFormation resource is mismatched: ${resource.LogicalResourceId || 'unknown'}`);
    }
  }

  const commonTags = {
    application: 'nexus-hub',
    'owner-activation-receipt-sha256': activation.receiptSha256,
    'receipt-signing-public-key-sha256': activationPayload.signingPublicKeySha256,
    'protected-main-template-sha256': localTemplateSha256,
  };
  const backupIdentity = {
    ...activationPayload.identities.backup,
    issuerCommonName: activationPayload.issuerCommonName,
  };
  const restoreIdentity = {
    ...activationPayload.identities.restore,
    issuerCommonName: activationPayload.issuerCommonName,
  };
  const liveCrl = validateTrustAnchorAndCrl(
    options,
    stack,
    parameters,
    outputs,
    activationPayload,
  );
  validateRole(
    options,
    backupIdentity,
    'backup',
    { ...commonTags, purpose: 'sonarqube-backup-writer' },
    stack,
  );
  validateRole(
    options,
    restoreIdentity,
    'restore',
    { ...commonTags, purpose: 'sonarqube-backup-restore' },
    stack,
  );
  validateProfile(
    options,
    backupIdentity,
    'backup',
    { ...commonTags, purpose: 'sonarqube-backup-writer' },
    expectedWriterPolicy(stack.bucketArn, stack.sonarPrefix),
  );
  validateProfile(
    options,
    restoreIdentity,
    'restore',
    { ...commonTags, purpose: 'sonarqube-backup-restore' },
    expectedRestorePolicy(stack.bucketArn, stack.sonarPrefix),
  );
  validateBucket(
    options,
    stack,
    activation.receiptSha256,
    lifecycleDigest,
    lifecycle !== null,
    backupIdentity.roleArn,
    restoreIdentity.roleArn,
    activationPayload.signingPublicKeySha256,
    localTemplateSha256,
  );
  const credentialProbes = validateCredentialProbes(
    options,
    stack,
    backupIdentity.roleArn,
    outputs,
    awsConfig.body,
    liveCrl,
    evidenceOwner,
  );

  writeNewRootEvidence(evidenceOutput, {
    schema: EVIDENCE_SCHEMA,
    verifiedAt: new Date().toISOString(),
    region: options.region,
    accountId: stack.accountId,
    callerArnSha256: sha256(Buffer.from(identity.Arn, 'utf8')),
    callerUserIdSha256: sha256(Buffer.from(identity.UserId, 'utf8')),
    stackName: options.stackName,
    stackId: liveStack.StackId,
    stackStatus: liveStack.StackStatus,
    protectedMainTemplateSha256: localTemplateSha256,
    bucketName: stack.bucketName,
    bucketArn: stack.bucketArn,
    sonarPrefix: stack.sonarPrefix,
    trustAnchorArn: stack.trustAnchorArn,
    backupRoleArn: backupIdentity.roleArn,
    restoreRoleArn: restoreIdentity.roleArn,
    backupProfileArn: backupIdentity.profileArn,
    restoreProfileArn: restoreIdentity.profileArn,
    ownerReceiptKeyId: activation.keyId,
    ownerReceiptPublicKeySha256: activationPayload.signingPublicKeySha256,
    rolesAnywhereActivation: 'ENABLED',
    rolesAnywhereActivationReceiptSha256: activation.receiptSha256,
    lifecycleActivation,
    lifecycleBootstrapReceiptSha256: lifecycleDigest,
    exactTemplateVerified: true,
    exactStackParametersVerified: true,
    exactStackOutputsVerified: true,
    completeResourceInventoryVerified: true,
    exactBucketStateVerified: true,
    exactRoleStateVerified: true,
    exactProfileStateVerified: true,
    exactTrustAnchorStateVerified: true,
    exactCrlStateVerified: true,
    postEnableCredentialProbes: credentialProbes,
    mutableCurrentRestoreAccessAbsent: true,
    awsCommandsReadOnly: true,
    authorization: {
      schema: AUTHORIZATION_SCHEMA,
      mode: options.mode,
      activation: activationProof,
      lifecycle: lifecycleProof,
    },
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: EVIDENCE_SCHEMA,
    mode: options.mode,
    stackName: options.stackName,
    rolesAnywhereActivation: 'ENABLED',
    lifecycleActivation,
    rolesAnywhereActivationReceiptSha256: activation.receiptSha256,
    lifecycleBootstrapReceiptSha256: lifecycleDigest,
  })}\n`);
}

try {
  verifyLive(parseArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `quality_sonar_aws_stack_state_failed:${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(error?.exitCode || 1);
}
