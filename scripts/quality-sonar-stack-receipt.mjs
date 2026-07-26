#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const ENVELOPE_SCHEMA = 'nexus.sonarqube-owner-receipt-envelope.v1';
const ACTIVATION_SCHEMA = 'nexus.sonarqube-roles-anywhere-activation.v2';
const LIFECYCLE_SCHEMA = 'nexus.sonarqube-lifecycle-bootstrap.v1';
const TRANSITION_SCHEMA = 'nexus.sonarqube-stack-transition-authorization.v1';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PRIOR_STATE_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACCOUNT_ID = /^[0-9]{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u;
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const BUCKET_NAME =
  /^(?![0-9]{1,3}(?:\.[0-9]{1,3}){3}$)(?!xn--)(?!sthree-)(?!amzn-s3-demo-)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)(?!.*--table-s3$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX =
  /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$/u;
const COMMON_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/+ -]{0,63}$/u;
const ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9+=,.@_/-]{1,512})$/u;
const PROFILE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):profile\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u;
const TRUST_ANCHOR_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):rolesanywhere:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):trust-anchor\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/u;
const CHANGE_SET_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):cloudformation:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):changeSet\/([A-Za-z0-9][-A-Za-z0-9_.]{0,127})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const STACK_ID_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):cloudformation:([a-z]{2}(?:-gov)?-[a-z0-9-]+-\d):([0-9]{12}):stack\/([A-Za-z][A-Za-z0-9-]{0,127})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function digestBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestCanonical(value) {
  return digestBytes(Buffer.from(canonicalJson(value), 'utf8'));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const governed = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(governed)) {
    fail(`${label} keys are invalid`);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO-8601 timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO-8601 timestamp`);
  }
  return parsed;
}

function currentTime() {
  if (process.env.NODE_ENV === 'test' && process.env.NEXUS_SONAR_RECEIPT_NOW) {
    return canonicalTimestamp(process.env.NEXUS_SONAR_RECEIPT_NOW, 'test clock');
  }
  return Date.now();
}

function validateAuthorizationWindow(payload, { allowExpired = false } = {}) {
  const issuedAt = canonicalTimestamp(payload.issuedAt, 'issuedAt');
  const expiresAt = canonicalTimestamp(payload.expiresAt, 'expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_AUTHORIZATION_WINDOW_MS) {
    fail('receipt authorization window must be positive and at most 24 hours');
  }
  const now = currentTime();
  if (issuedAt > now + CLOCK_SKEW_MS) fail('receipt is not yet valid');
  if (!allowExpired && now >= expiresAt) fail('receipt authorization expired');
  return { issuedAt, expiresAt };
}

function parseStack(value) {
  exactKeys(value, [
    'accountId',
    'bucketArn',
    'bucketName',
    'name',
    'region',
    'sonarPrefix',
    'templateSha256',
    'trustAnchorArn',
  ], 'stack');
  if (!STACK_NAME.test(value.name || '')) fail('stack.name is invalid');
  if (!REGION.test(value.region || '')) fail('stack.region is invalid');
  if (!ACCOUNT_ID.test(value.accountId || '')) fail('stack.accountId is invalid');
  if (!SHA256.test(value.templateSha256 || '')) {
    fail('stack.templateSha256 is invalid');
  }
  if (!BUCKET_NAME.test(value.bucketName || '')) fail('stack.bucketName is invalid');
  const expectedBucketArn = `arn:${value.trustAnchorArn?.split(':')[1]}:s3:::${value.bucketName}`;
  if (value.bucketArn !== expectedBucketArn) fail('stack.bucketArn is invalid');
  if (!PREFIX.test(value.sonarPrefix || '') || value.sonarPrefix.length > 128) {
    fail('stack.sonarPrefix is invalid');
  }
  const trustAnchor = (value.trustAnchorArn || '').match(TRUST_ANCHOR_ARN);
  if (!trustAnchor
      || trustAnchor[2] !== value.region
      || trustAnchor[3] !== value.accountId) {
    fail('stack.trustAnchorArn is outside the exact stack account or region');
  }
  return {
    partition: trustAnchor[1],
    region: trustAnchor[2],
    accountId: trustAnchor[3],
  };
}

function parseIdentity(value, label, stackIdentity) {
  exactKeys(value, ['profileArn', 'roleArn', 'subjectCommonName'], label);
  const role = (value.roleArn || '').match(ROLE_ARN);
  const profile = (value.profileArn || '').match(PROFILE_ARN);
  if (!role
      || role[1] !== stackIdentity.partition
      || role[2] !== stackIdentity.accountId) {
    fail(`${label}.roleArn is outside the exact stack account`);
  }
  if (!profile
      || profile[1] !== stackIdentity.partition
      || profile[2] !== stackIdentity.region
      || profile[3] !== stackIdentity.accountId) {
    fail(`${label}.profileArn is outside the exact stack account or region`);
  }
  if (!COMMON_NAME.test(value.subjectCommonName || '')) {
    fail(`${label}.subjectCommonName is invalid`);
  }
}

function validateSharedPayload(payload, schema, options) {
  const shared = [
    'expiresAt',
    'issuedAt',
    'ownerAuthorization',
    'schema',
    'signingKeyId',
    'signingPublicKeySha256',
    'stack',
  ];
  exactKeys(payload, [...shared, ...options.extraKeys], `${schema} payload`);
  if (payload.schema !== schema) fail('receipt payload schema is invalid');
  if (payload.ownerAuthorization !== 'explicit') {
    fail('explicit owner authorization is missing');
  }
  if (!KEY_ID.test(payload.signingKeyId || '')
      || (options.keyId && payload.signingKeyId !== options.keyId)) {
    fail('signingKeyId is invalid or mismatched');
  }
  if (!SHA256.test(payload.signingPublicKeySha256 || '')) {
    fail('signingPublicKeySha256 is invalid');
  }
  validateAuthorizationWindow(payload, options);
  return parseStack(payload.stack);
}

function validateTransition(payload, kind, stackIdentity, basePayload) {
  exactKeys(payload.transition, [
    'changeSetId',
    'executorArnSha256',
    'executorUserIdSha256',
    'priorStack',
  ], 'transition');
  const changeSet = (payload.transition.changeSetId || '').match(CHANGE_SET_ARN);
  if (!changeSet
      || changeSet[1] !== stackIdentity.partition
      || changeSet[2] !== stackIdentity.region
      || changeSet[3] !== stackIdentity.accountId) {
    fail('transition.changeSetId is outside the exact stack account or region');
  }
  for (const name of ['executorArnSha256', 'executorUserIdSha256']) {
    if (!SHA256.test(payload.transition[name] || '')) {
      fail(`transition.${name} is invalid`);
    }
  }
  const prior = payload.transition.priorStack;
  exactKeys(prior, [
    'capturedAt',
    'lifecycleActivation',
    'lifecycleBootstrapReceiptSha256',
    'ownerReceiptKeyId',
    'ownerReceiptPublicKeySha256',
    'protectedMainTemplateSha256',
    'rolesAnywhereActivation',
    'rolesAnywhereActivationReceiptSha256',
    'stackId',
    'stackStatus',
  ], 'transition.priorStack');
  const priorStack = (prior.stackId || '').match(STACK_ID_ARN);
  if (!priorStack
      || priorStack[1] !== stackIdentity.partition
      || priorStack[2] !== stackIdentity.region
      || priorStack[3] !== stackIdentity.accountId
      || priorStack[4] !== payload.stack.name
      || !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(prior.stackStatus)) {
    fail('transition prior stack identity or status is invalid');
  }
  const capturedAt = canonicalTimestamp(
    prior.capturedAt,
    'transition.priorStack.capturedAt',
  );
  const issuedAt = canonicalTimestamp(payload.issuedAt, 'issuedAt');
  if (capturedAt > issuedAt
      || issuedAt - capturedAt > MAX_PRIOR_STATE_AGE_MS) {
    fail('transition prior stack state is stale or was captured after authorization');
  }
  if (prior.ownerReceiptKeyId !== payload.signingKeyId
      || prior.ownerReceiptPublicKeySha256 !== payload.signingPublicKeySha256
      || prior.protectedMainTemplateSha256 !== payload.stack.templateSha256) {
    fail('transition prior stack state does not bind the owner key and template');
  }
  const expected = kind === 'activation'
    ? {
      rolesAnywhereActivation: 'DISABLED',
      rolesAnywhereActivationReceiptSha256: '',
      lifecycleActivation: 'DISABLED',
      lifecycleBootstrapReceiptSha256: '',
    }
    : {
      rolesAnywhereActivation: 'ENABLED',
      rolesAnywhereActivationReceiptSha256: basePayload.activationReceiptSha256,
      lifecycleActivation: 'DISABLED',
      lifecycleBootstrapReceiptSha256: '',
    };
  for (const [name, value] of Object.entries(expected)) {
    if (prior[name] !== value) {
      fail(`transition prior stack state ${name} is invalid for ${kind}`);
    }
  }
  return payload.transition;
}

function validateTransitionPayload(payload, options = {}) {
  const baseEnvelope = options.baseEnvelope;
  const kind = options.transitionKind;
  if (!baseEnvelope || !['activation', 'lifecycle'].includes(kind)) {
    fail('transition authorization requires an exact base receipt');
  }
  const stackIdentity = validateSharedPayload(payload, TRANSITION_SCHEMA, {
    ...options,
    extraKeys: ['kind', 'receiptSha256', 'transition'],
  });
  if (payload.kind !== kind
      || payload.receiptSha256 !== digestCanonical(baseEnvelope)
      || canonicalJson(payload.stack) !== canonicalJson(baseEnvelope.payload.stack)
      || payload.signingPublicKeySha256
        !== baseEnvelope.payload.signingPublicKeySha256) {
    fail('transition authorization does not bind the exact base receipt');
  }
  validateTransition(payload, kind, stackIdentity, baseEnvelope.payload);
  return payload;
}

function validateActivationPayload(payload, options = {}) {
  const stackIdentity = validateSharedPayload(payload, ACTIVATION_SCHEMA, {
    ...options,
    extraKeys: [
      'controls',
      'evidence',
      'identities',
      'issuerCommonName',
      'material',
    ],
  });
  if (!COMMON_NAME.test(payload.issuerCommonName || '')) {
    fail('issuerCommonName is invalid');
  }
  exactKeys(payload.identities, ['backup', 'restore'], 'identities');
  parseIdentity(payload.identities.backup, 'identities.backup', stackIdentity);
  parseIdentity(payload.identities.restore, 'identities.restore', stackIdentity);
  if (payload.identities.backup.roleArn === payload.identities.restore.roleArn
      || payload.identities.backup.profileArn === payload.identities.restore.profileArn
      || payload.identities.backup.subjectCommonName
        === payload.identities.restore.subjectCommonName) {
    fail('writer and restore identities must be distinct');
  }
  exactKeys(payload.evidence, [
    'backupCertificateSha256',
    'caCertificateSha256',
    'certificateIssuanceSha256',
    'credentialBoundarySha256',
    'keyCustodySha256',
    'restoreCertificateSha256',
    'revocationMaterialSha256',
  ], 'activation evidence');
  for (const [name, value] of Object.entries(payload.evidence)) {
    if (!SHA256.test(value || '')) fail(`activation evidence ${name} is invalid`);
  }
  exactKeys(payload.material, [
    'caCertificatePem',
    'crlData',
    'crlId',
  ], 'activation material');
  const caCertificate = Buffer.from(payload.material.caCertificatePem || '', 'utf8');
  if (caCertificate.length < 1
      || caCertificate.length > 4096
      || !payload.material.caCertificatePem.startsWith('-----BEGIN CERTIFICATE-----\n')
      || !payload.material.caCertificatePem.endsWith('-----END CERTIFICATE-----\n')
      || digestBytes(caCertificate) !== payload.evidence.caCertificateSha256) {
    fail('activation CA certificate material is invalid or mismatched');
  }
  if (typeof payload.material.crlData !== 'string'
      || payload.material.crlData.length < 4
      || payload.material.crlData.length > 4096
      || !UUID.test(payload.material.crlId || '')) {
    fail('activation CRL material identity is invalid');
  }
  const crl = Buffer.from(payload.material.crlData, 'base64');
  if (crl.length < 1
      || crl.toString('base64') !== payload.material.crlData
      || digestBytes(crl) !== payload.evidence.revocationMaterialSha256) {
    fail('activation CRL material is not canonical or digest-bound');
  }
  exactKeys(payload.controls, [
    'certificateIssuancePrepared',
    'credentialBoundaryPrepared',
    'expectedLifecycleActivation',
    'expectedRolesAnywhereActivation',
    'livePositiveCredentialProbeExpected',
    'liveRevokedCertificateDenialExpected',
    'privateKeyCustodyPrepared',
    'revocationMaterialPrepared',
  ], 'activation controls');
  if (payload.controls.certificateIssuancePrepared !== true
      || payload.controls.credentialBoundaryPrepared !== true
      || payload.controls.privateKeyCustodyPrepared !== true
      || payload.controls.revocationMaterialPrepared !== true
      || payload.controls.livePositiveCredentialProbeExpected !== true
      || payload.controls.liveRevokedCertificateDenialExpected !== true
      || payload.controls.expectedRolesAnywhereActivation !== 'ENABLED'
      || payload.controls.expectedLifecycleActivation !== 'DISABLED') {
    fail('activation preparation does not authorize the disabled-lifecycle transition');
  }
  return payload;
}

function opaqueVersionId(value, label) {
  if (typeof value !== 'string' || value === 'null') fail(`${label} is invalid`);
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length < 1
      || encoded.length > 1024
      || encoded.toString('utf8') !== value
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} is invalid`);
  }
}

function validateBackupSuccessReceipt(body, expected) {
  if (body.length < 2 || body.length > MAX_FILE_BYTES) {
    fail('first-backup success receipt size is invalid');
  }
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    fail('first-backup success receipt is not valid JSON');
  }
  if (value?.schemaVersion !== 'SonarBackupSuccessV2'
      || value.encrypted !== true
      || value.remoteObjectVerified !== true
      || value.remoteVerification?.daily !== true
      || value.remoteVerification?.method
        !== 'version-pinned-head-content-length-metadata-and-s3-sha256'
      || !SHA256.test(value.encryptedSha256 || '')
      || !Number.isSafeInteger(value.encryptedSizeBytes)
      || value.encryptedSizeBytes <= 0
      || value.retention?.daily !== 7
      || value.retention?.weekly !== 4
      || value.retention?.basis !== 'distinct-utc-days-and-iso-weeks') {
    fail('first-backup success receipt contract is invalid');
  }
  const exactDailyKey = new RegExp(
    `^${expected.stack.sonarPrefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`
      + '/daily/nexus-sonarqube-[0-9]{8}T[0-9]{6}Z\\.dump\\.age$',
    'u',
  );
  if (!exactDailyKey.test(value.dailyKey || '')) {
    fail('first-backup daily key is outside the exact Sonar prefix');
  }
  opaqueVersionId(value.dailyObjectVersionId, 'first-backup daily object VersionId');
  opaqueVersionId(value.dailyChecksumVersionId, 'first-backup daily checksum VersionId');
  const completedAt = canonicalTimestamp(value.completedAt, 'first-backup completedAt');
  const backupTimestamp = /nexus-sonarqube-([0-9]{8})T([0-9]{6})Z/u.exec(
    value.dailyKey,
  );
  const startedAt = backupTimestamp
    ? Date.parse(
      `${backupTimestamp[1].slice(0, 4)}-${backupTimestamp[1].slice(4, 6)}-`
      + `${backupTimestamp[1].slice(6, 8)}T${backupTimestamp[2].slice(0, 2)}:`
      + `${backupTimestamp[2].slice(2, 4)}:${backupTimestamp[2].slice(4, 6)}Z`,
    )
    : Number.NaN;
  if (!Number.isFinite(startedAt) || startedAt > completedAt) {
    fail('first-backup key timestamp is after completion');
  }
  const expectedFirstBackup = expected.firstBackup;
  if (expectedFirstBackup.successReceiptSha256 !== digestBytes(body)
      || expectedFirstBackup.completedAt !== value.completedAt
      || expectedFirstBackup.dailyKey !== value.dailyKey
      || expectedFirstBackup.dailyObjectVersionId !== value.dailyObjectVersionId
      || expectedFirstBackup.dailyChecksumVersionId !== value.dailyChecksumVersionId
      || expectedFirstBackup.encryptedSha256 !== value.encryptedSha256
      || expectedFirstBackup.encryptedSizeBytes !== value.encryptedSizeBytes
      || expectedFirstBackup.remoteObjectVerified !== true
      || expectedFirstBackup.dailyRetentionEvidenceSha256
        !== digestCanonical(value.retentionEvidence?.daily)
      || expectedFirstBackup.weeklyRetentionEvidenceSha256
        !== digestCanonical(value.retentionEvidence?.weekly)) {
    fail('lifecycle receipt does not bind the exact first-backup success receipt');
  }
}

function validateLifecyclePayload(payload, options = {}) {
  const stackIdentity = validateSharedPayload(payload, LIFECYCLE_SCHEMA, {
    ...options,
    extraKeys: [
      'activationReceiptSha256',
      'controls',
      'firstBackup',
    ],
  });
  if (!SHA256.test(payload.activationReceiptSha256 || '')) {
    fail('activationReceiptSha256 is invalid');
  }
  exactKeys(payload.controls, [
    'dailyNoncurrentDays',
    'expectedLifecycleActivation',
    'expectedRolesAnywhereActivation',
    'visibleDailyPoints',
    'visibleWeeklyPoints',
    'weeklyNoncurrentDays',
  ], 'lifecycle controls');
  if (payload.controls.expectedRolesAnywhereActivation !== 'ENABLED'
      || payload.controls.expectedLifecycleActivation !== 'ENABLED'
      || payload.controls.dailyNoncurrentDays !== 35
      || payload.controls.weeklyNoncurrentDays !== 120
      || payload.controls.visibleDailyPoints !== 7
      || payload.controls.visibleWeeklyPoints !== 4) {
    fail('lifecycle controls are invalid');
  }
  exactKeys(payload.firstBackup, [
    'completedAt',
    'dailyChecksumVersionId',
    'dailyKey',
    'dailyObjectVersionId',
    'dailyRetentionEvidenceSha256',
    'encryptedSha256',
    'encryptedSizeBytes',
    'remoteObjectVerified',
    'successReceiptSha256',
    'weeklyRetentionEvidenceSha256',
  ], 'firstBackup');
  for (const name of [
    'dailyRetentionEvidenceSha256',
    'encryptedSha256',
    'successReceiptSha256',
    'weeklyRetentionEvidenceSha256',
  ]) {
    if (!SHA256.test(payload.firstBackup[name] || '')) {
      fail(`firstBackup.${name} is invalid`);
    }
  }
  opaqueVersionId(
    payload.firstBackup.dailyObjectVersionId,
    'firstBackup.dailyObjectVersionId',
  );
  opaqueVersionId(
    payload.firstBackup.dailyChecksumVersionId,
    'firstBackup.dailyChecksumVersionId',
  );
  if (payload.firstBackup.remoteObjectVerified !== true
      || !Number.isSafeInteger(payload.firstBackup.encryptedSizeBytes)
      || payload.firstBackup.encryptedSizeBytes <= 0) {
    fail('firstBackup remote identity is invalid');
  }
  const completedAt = canonicalTimestamp(
    payload.firstBackup.completedAt,
    'firstBackup.completedAt',
  );
  const { issuedAt } = validateAuthorizationWindow(payload, options);
  if (completedAt > issuedAt) {
    fail('lifecycle receipt was issued before the first backup completed');
  }
  const backupReceiptPath = options.backupSuccessReceiptPath;
  if (!backupReceiptPath) fail('--backup-success-receipt is required');
  validateBackupSuccessReceipt(readGovernedFile(
    backupReceiptPath,
    'first-backup success receipt',
    MAX_FILE_BYTES,
    { requirePrivate: true },
  ), payload);
  return payload;
}

function readGovernedFile(file, label, maximumBytes, { requirePrivate = false } = {}) {
  const absolute = resolve(file || '');
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size < 1 || stat.size > maximumBytes
      || (requirePrivate
        && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) {
    fail(`${label} path is unsafe`);
  }
  const descriptor = openSync(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1
        || before.size < 1 || before.size > maximumBytes
        || (requirePrivate
          && ((before.mode & 0o077) !== 0
            || before.uid !== process.getuid()))
        || before.dev !== stat.dev || before.ino !== stat.ino) {
      fail(`${label} path changed before it was opened`);
    }
    const body = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail(`${label} changed while it was read`);
    }
    return body;
  } finally {
    closeSync(descriptor);
  }
}

function parseJsonFile(file, label, options = {}) {
  const body = readGovernedFile(file, label, MAX_FILE_BYTES, options);
  try {
    return { body, value: JSON.parse(body.toString('utf8')) };
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function validatePublicKey(body) {
  let key;
  try {
    key = createPublicKey(body);
  } catch {
    fail('receipt public key is invalid');
  }
  const der = key.export({ type: 'spki', format: 'der' });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (key.asymmetricKeyType !== 'ed25519'
      || der.length !== prefix.length + 32
      || !der.subarray(0, prefix.length).equals(prefix)) {
    fail('receipt public key must be Ed25519');
  }
  return { key, sha256: digestBytes(der) };
}

function validatePrivateKey(body) {
  let privateKey;
  try {
    privateKey = createPrivateKey(body);
  } catch {
    fail('receipt private key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('receipt private key must be Ed25519');
  }
  return {
    privateKey,
    public: validatePublicKey(
      createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    ),
  };
}

function validateEnvelope(envelope, kind, options = {}) {
  exactKeys(
    envelope,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'],
    'receipt envelope',
  );
  if (envelope.schema !== ENVELOPE_SCHEMA
      || envelope.signatureAlgorithm !== 'ed25519'
      || !KEY_ID.test(envelope.keyId || '')
      || (options.keyId && envelope.keyId !== options.keyId)) {
    fail('receipt envelope identity is invalid');
  }
  if (typeof envelope.signature !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature)) {
    fail('receipt signature encoding is invalid');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64
      || signature.toString('base64') !== envelope.signature) {
    fail('receipt signature is not canonical Ed25519');
  }
  if (kind === 'activation') validateActivationPayload(envelope.payload, options);
  else if (kind === 'lifecycle') validateLifecyclePayload(envelope.payload, options);
  else validateTransitionPayload(envelope.payload, options);
  if (envelope.payload.signingKeyId !== envelope.keyId) {
    fail('receipt payload does not bind the envelope key identifier');
  }
  return envelope;
}

function readVerifiedBaseEnvelope(options, publicKey, { allowExpired = false } = {}) {
  const parsed = parseJsonFile(options.receipt, 'base signed receipt', {
    requirePrivate: true,
  });
  if (!parsed.body.equals(
    Buffer.from(`${canonicalJson(parsed.value)}\n`, 'utf8'),
  )) {
    fail('base signed receipt is not canonical JSON');
  }
  const kind = options.kind;
  const validationOptions = {
    allowExpired,
    backupSuccessReceiptPath: options.backupSuccessReceipt,
    keyId: options.keyId,
  };
  validateEnvelope(parsed.value, kind, validationOptions);
  if (parsed.value.payload.signingPublicKeySha256 !== publicKey.sha256
      || !verify(
        null,
        Buffer.from(canonicalJson(parsed.value.payload), 'utf8'),
        publicKey.key,
        Buffer.from(parsed.value.signature, 'base64'),
      )) {
    fail('base receipt signature or public-key binding is invalid');
  }
  return parsed.value;
}

function prepareOutput(file) {
  if (!file || !isAbsolute(file)) fail('--output must be a new absolute path', 64);
  const absolute = resolve(file);
  const parent = dirname(absolute);
  if (realpathSync.native(parent) !== parent) fail('output parent is noncanonical');
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || parentStat.uid !== process.getuid() || (parentStat.mode & 0o077) !== 0) {
    fail('output parent must be caller-owned and mode 0700');
  }
  try {
    lstatSync(absolute);
    fail('output must not already exist');
  } catch (error) {
    if (error?.message === 'output must not already exist') throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return absolute;
}

function writeNewPrivateFile(output, body) {
  const parent = dirname(output);
  const temporary = `${output}.next.${process.pid}.${randomBytes(12).toString('hex')}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, body);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, output);
    const parentDescriptor = openSync(parent, 'r');
    try {
      fsyncSync(parentDescriptor);
    } finally {
      closeSync(parentDescriptor);
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

function parseArgs(argv) {
  const command = argv.shift();
  const options = { command };
  const booleanFlags = new Set(['--allow-expired']);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (booleanFlags.has(argument)) {
      if (options.allowExpired === true) {
        fail(`duplicate argument: ${argument}`, 64);
      }
      options.allowExpired = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      fail(`invalid argument: ${argument}`, 64);
    }
    const value = argv[++index];
    if (value.startsWith('--')) fail(`missing value for ${argument}`, 64);
    const name = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, name)) fail(`duplicate argument: ${argument}`, 64);
    options[name] = value;
  }
  if (![
    'sign-activation',
    'sign-lifecycle',
    'sign-transition',
    'verify-activation',
    'verify-lifecycle',
    'verify-transition',
  ].includes(command)) {
    fail('unknown receipt command', 64);
  }
  const commandOptions = {
    'sign-activation': ['input', 'keyId', 'output', 'privateKey'],
    'sign-lifecycle': [
      'backupSuccessReceipt',
      'input',
      'keyId',
      'output',
      'privateKey',
    ],
    'sign-transition': [
      'backupSuccessReceipt',
      'input',
      'keyId',
      'kind',
      'output',
      'privateKey',
      'receipt',
    ],
    'verify-activation': ['allowExpired', 'input', 'keyId', 'publicKey'],
    'verify-lifecycle': [
      'allowExpired',
      'backupSuccessReceipt',
      'input',
      'keyId',
      'publicKey',
    ],
    'verify-transition': [
      'allowExpired',
      'backupSuccessReceipt',
      'input',
      'keyId',
      'kind',
      'publicKey',
      'receipt',
    ],
  };
  const allowed = new Set(['command', ...commandOptions[command]]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) fail(`option --${name} is not valid for ${command}`, 64);
  }
  const required = commandOptions[command].filter((name) => name !== 'allowExpired');
  for (const name of required) {
    if (name === 'backupSuccessReceipt'
        && options.kind === 'activation'
        && ['sign-transition', 'verify-transition'].includes(command)) {
      continue;
    }
    if (!options[name]) {
      fail(
        `--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`,
        64,
      );
    }
  }
  if (['sign-transition', 'verify-transition'].includes(command)
      && !['activation', 'lifecycle'].includes(options.kind)) {
    fail('--kind must be activation or lifecycle', 64);
  }
  return options;
}

function signReceipt(kind, options) {
  const payload = parseJsonFile(options.input, 'receipt payload', {
    requirePrivate: true,
  }).value;
  const privateKeyFile = readGovernedFile(
    options.privateKey,
    'receipt private key',
    32 * 1024,
    { requirePrivate: true },
  );
  const key = validatePrivateKey(privateKeyFile);
  if (payload.signingPublicKeySha256 !== key.public.sha256) {
    fail('payload does not bind the signing public key');
  }
  if (!KEY_ID.test(options.keyId || '')) fail('--key-id is invalid', 64);
  const validationOptions = {
    backupSuccessReceiptPath: options.backupSuccessReceipt,
    keyId: options.keyId,
  };
  if (kind === 'transition') {
    validationOptions.transitionKind = options.kind;
    validationOptions.baseEnvelope = readVerifiedBaseEnvelope(
      options,
      key.public,
    );
  }
  if (kind === 'activation') validateActivationPayload(payload, validationOptions);
  else if (kind === 'lifecycle') {
    validateLifecyclePayload(payload, validationOptions);
  } else {
    validateTransitionPayload(payload, validationOptions);
  }
  const envelope = {
    schema: ENVELOPE_SCHEMA,
    keyId: options.keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalJson(payload), 'utf8'),
      key.privateKey,
    ).toString('base64'),
  };
  validateEnvelope(envelope, kind, validationOptions);
  const output = prepareOutput(options.output);
  writeNewPrivateFile(output, Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8'));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind,
    ...(kind === 'transition' ? { transitionKind: options.kind } : {}),
    receiptSha256: digestCanonical(envelope),
    payloadSha256: digestCanonical(payload),
    signingPublicKeySha256: key.public.sha256,
  })}\n`);
}

function verifyReceipt(kind, options) {
  const parsed = parseJsonFile(options.input, 'signed receipt', {
    requirePrivate: true,
  });
  const envelope = parsed.value;
  if (!parsed.body.equals(
    Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8'),
  )) {
    fail('signed receipt is not canonical JSON');
  }
  const publicKey = validatePublicKey(readGovernedFile(
    options.publicKey,
    'receipt public key',
    32 * 1024,
  ));
  const validationOptions = {
    allowExpired: options.allowExpired === true,
    backupSuccessReceiptPath: options.backupSuccessReceipt,
    keyId: options.keyId,
  };
  if (kind === 'transition') {
    validationOptions.transitionKind = options.kind;
    validationOptions.baseEnvelope = readVerifiedBaseEnvelope(
      options,
      publicKey,
      { allowExpired: options.allowExpired === true },
    );
  }
  validateEnvelope(envelope, kind, validationOptions);
  if (envelope.payload.signingPublicKeySha256 !== publicKey.sha256) {
    fail('receipt does not bind the selected public key');
  }
  if (!verify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey.key,
    Buffer.from(envelope.signature, 'base64'),
  )) {
    fail('receipt signature is invalid');
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind,
    ...(kind === 'transition' ? { transitionKind: options.kind } : {}),
    keyId: envelope.keyId,
    receiptSha256: digestCanonical(envelope),
    payloadSha256: digestCanonical(envelope.payload),
    signingPublicKeySha256: publicKey.sha256,
    payload: envelope.payload,
  })}\n`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'sign-activation') signReceipt('activation', options);
  else if (options.command === 'sign-lifecycle') signReceipt('lifecycle', options);
  else if (options.command === 'sign-transition') {
    signReceipt('transition', options);
  }
  else if (options.command === 'verify-activation') {
    verifyReceipt('activation', options);
  } else if (options.command === 'verify-lifecycle') {
    verifyReceipt('lifecycle', options);
  } else if (options.command === 'verify-transition') {
    verifyReceipt('transition', options);
  }
} catch (error) {
  process.stderr.write(
    `quality_sonar_stack_receipt_failed:${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(error?.exitCode || 1);
}
