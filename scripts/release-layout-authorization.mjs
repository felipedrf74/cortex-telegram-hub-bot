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
const CONTROLLER_PATH =
  '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-controller';
const CONTROLLER_UNIT_PATH =
  '/etc/systemd/system/nexus-release-layout-fault-drill@.service';
const CONTROLLER_RECOVERY_UNIT_PATH =
  '/etc/systemd/system/nexus-release-layout-fault-drill-recovery.service';
const VERIFIER_PATH =
  '/usr/local/libexec/nexus-rollback-drill-vm/release-layout-fault-drill.mjs';
const GUEST_EXECUTOR_PATH =
  '/usr/local/sbin/nexus-release-layout-fault-guest';
const GUEST_RECOVERY_UNIT_PATH =
  '/etc/systemd/system/nexus-release-layout-fault-guest-recovery.service';

function nowMs() {
  const injected = process.env.NODE_ENV === 'test'
    ? process.env.NEXUS_RELEASE_LAYOUT_TEST_NOW
    : undefined;
  if (injected === undefined) return Date.now();
  const parsed = Date.parse(injected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== injected) {
    throw new Error('layout authority test clock is invalid');
  }
  return parsed;
}

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

function validateProducerTrust(value) {
  assertExactKeys(value, ['guests', 'hypervisor'], 'layout fault-drill producers');
  assertExactKeys(value.hypervisor, [
    'controllerPath',
    'controllerRecoveryUnitPath',
    'controllerRecoveryUnitSha256',
    'controllerSha256',
    'controllerUnitPath',
    'controllerUnitSha256',
    'verifierPath',
    'verifierSha256',
  ], 'layout fault-drill hypervisor producer');
  if (value.hypervisor.controllerPath !== CONTROLLER_PATH
      || value.hypervisor.controllerRecoveryUnitPath
        !== CONTROLLER_RECOVERY_UNIT_PATH
      || value.hypervisor.controllerUnitPath !== CONTROLLER_UNIT_PATH
      || value.hypervisor.verifierPath !== VERIFIER_PATH
      || !DIGEST.test(value.hypervisor.controllerSha256 ?? '')
      || !DIGEST.test(
        value.hypervisor.controllerRecoveryUnitSha256 ?? '',
      )
      || !DIGEST.test(value.hypervisor.controllerUnitSha256 ?? '')
      || !DIGEST.test(value.hypervisor.verifierSha256 ?? '')) {
    throw new Error('layout fault-drill hypervisor producer identity is invalid');
  }
  assertExactKeys(value.guests, DRILL_SCENARIOS, 'layout fault-drill guest producers');
  for (const scenario of DRILL_SCENARIOS) {
    const producer = value.guests[scenario];
    assertExactKeys(producer, [
      'executorPath',
      'executorSha256',
      'recoveryUnitPath',
      'recoveryUnitSha256',
    ], `layout ${scenario} guest producer`);
    if (producer.executorPath !== GUEST_EXECUTOR_PATH
        || producer.recoveryUnitPath !== GUEST_RECOVERY_UNIT_PATH
        || !DIGEST.test(producer.executorSha256 ?? '')
        || !DIGEST.test(producer.recoveryUnitSha256 ?? '')) {
      throw new Error(`layout ${scenario} guest producer identity is invalid`);
    }
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
      || created > nowMs() + 60 * 1000
      || (!allowExpired && nowMs() > expires)) {
    throw new Error('layout migration request lifetime is invalid');
  }
}

function validateDrill(payload, { allowStale = false } = {}) {
  assertExactKeys(payload, [
    'completedAt',
    'maximumRecoverySeconds',
    'migrationId',
    'plan',
    'planSha256',
    'proofSchema',
    'scenarios',
    'schema',
    'source',
  ], 'layout migration fault drill');
  const completed = Date.parse(payload.completedAt ?? '');
  if (payload.schema !== 'nexus.release-layout-fault-drill.v1'
      || payload.proofSchema !== 'nexus.release-layout-kvm-proof.v1'
      || !MIGRATION_ID.test(payload.migrationId ?? '')
      || !DIGEST.test(payload.planSha256 ?? '')
      || !Number.isSafeInteger(payload.maximumRecoverySeconds)
      || payload.maximumRecoverySeconds < 0
      || payload.maximumRecoverySeconds > 120
      || !Number.isFinite(completed)
      || completed > nowMs() + 60 * 1000
      || (!allowStale && nowMs() - completed > 30 * 24 * 60 * 60 * 1000)) {
    throw new Error('layout migration fault drill identity is invalid');
  }
  assertExactKeys(payload.source, ['production', 'staging'], 'layout fault-drill source');
  validateIdentity(payload.source.production, 'production', OLD_BASES.production);
  validateIdentity(payload.source.staging, 'staging', OLD_BASES.staging);
  assertExactKeys(payload.plan, [
    'challengeNonce',
    'createdAt',
    'execution',
    'expiresAt',
    'migrationId',
    'planId',
    'promotionAllowed',
    'scenarios',
    'schema',
    'source',
    'trust',
  ], 'layout fault-drill plan');
  if (payload.plan.schema !== 'nexus.release-layout-fault-drill-plan.v1'
      || payload.plan.migrationId !== payload.migrationId
      || !MIGRATION_ID.test(payload.plan.planId ?? '')
      || !DIGEST.test(payload.plan.challengeNonce ?? '')
      || payload.plan.promotionAllowed !== false
      || payload.planSha256
        !== rawSha256(Buffer.from(canonicalJson(payload.plan), 'utf8'))
      || canonicalJson(payload.plan.source) !== canonicalJson(payload.source)) {
    throw new Error('layout migration fault-drill plan identity is invalid');
  }
  assertExactKeys(
    payload.plan.trust,
    [
      'guestEd25519PublicKeys',
      'guestIds',
      'hypervisorEd25519PublicKey',
      'producers',
      'provisionReceiptSha256',
      'provisionSetId',
      'trustManifestSha256',
    ],
    'layout fault-drill trust',
  );
  assertExactKeys(
    payload.plan.trust.guestEd25519PublicKeys,
    DRILL_SCENARIOS,
    'layout fault-drill guest trust',
  );
  validateProducerTrust(payload.plan.trust.producers);
  assertExactKeys(
    payload.plan.trust.guestIds,
    DRILL_SCENARIOS,
    'layout fault-drill guest identity map',
  );
  const expectedGuests = {
    failed_health_check: 'guest-2',
    host_reboot_during_migration: 'guest-3',
    ssh_disconnect_after_pm2_stop: 'guest-1',
  };
  if (!DIGEST.test(payload.plan.trust.trustManifestSha256 ?? '')
      || !DIGEST.test(payload.plan.trust.provisionReceiptSha256 ?? '')
      || !DIGEST.test(payload.plan.trust.provisionSetId ?? '')
      || DRILL_SCENARIOS.some((scenario) => (
        payload.plan.trust.guestIds[scenario] !== expectedGuests[scenario]
      ))) {
    throw new Error('layout fault-drill root trust identity is invalid');
  }
  const keyDigests = new Set();
  for (const [label, key] of [
    ['hypervisor', payload.plan.trust.hypervisorEd25519PublicKey],
    ...DRILL_SCENARIOS.map((scenario) => [
      scenario,
      payload.plan.trust.guestEd25519PublicKeys[scenario],
    ]),
  ]) {
    let publicKey;
    try {
      publicKey = createPublicKey(key);
    } catch {
      throw new Error(`layout ${label} evidence public key is invalid`);
    }
    const canonicalKey = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    if (publicKey.asymmetricKeyType !== 'ed25519' || canonicalKey !== key) {
      throw new Error(`layout ${label} evidence public key is invalid`);
    }
    keyDigests.add(rawSha256(Buffer.from(canonicalKey, 'utf8')));
  }
  if (keyDigests.size !== DRILL_SCENARIOS.length + 1) {
    throw new Error('layout evidence signer keys must be pairwise distinct');
  }
  if (!Array.isArray(payload.scenarios) || payload.scenarios.length !== DRILL_SCENARIOS.length) {
    throw new Error('layout migration fault-drill scenarios are invalid');
  }
  const ids = [];
  for (const scenario of payload.scenarios) {
    assertExactKeys(
      scenario,
      ['id', 'result', 'resultSha256', 'status'],
      'layout fault-drill scenario',
    );
    if (!DRILL_SCENARIOS.includes(scenario.id) || scenario.status !== 'passed'
        || !DIGEST.test(scenario.resultSha256 ?? '')
        || scenario.resultSha256
          !== rawSha256(Buffer.from(canonicalJson(scenario.result), 'utf8'))
        || scenario.result?.schema !== 'nexus.release-layout-fault-scenario-result.v2'
        || scenario.result?.planSha256 !== payload.planSha256
        || scenario.result?.migrationId !== payload.migrationId
        || scenario.result?.scenarioId !== scenario.id
        || scenario.result?.status !== 'passed') {
      throw new Error('layout migration fault-drill scenario is invalid');
    }
    assertExactKeys(scenario.result.producerTrust, [
      'controllerRecoveryUnitSha256',
      'controllerSha256',
      'controllerUnitSha256',
      'guestExecutorSha256',
      'guestRecoveryUnitSha256',
    ], 'layout fault-drill result producer trust');
    if (scenario.result.producerTrust.controllerSha256
          !== payload.plan.trust.producers.hypervisor.controllerSha256
        || scenario.result.producerTrust.controllerRecoveryUnitSha256
          !== payload.plan.trust.producers.hypervisor
            .controllerRecoveryUnitSha256
        || scenario.result.producerTrust.controllerUnitSha256
          !== payload.plan.trust.producers.hypervisor.controllerUnitSha256
        || scenario.result.producerTrust.guestExecutorSha256
          !== payload.plan.trust.producers.guests[scenario.id].executorSha256
        || scenario.result.producerTrust.guestRecoveryUnitSha256
          !== payload.plan.trust.producers.guests[scenario.id].recoveryUnitSha256) {
      throw new Error('layout fault-drill result producer identity is invalid');
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

function validateAcceptedRecovery(journalFile, requestInput, drillInput) {
  const resolved = path.resolve(journalFile);
  const identity = fs.lstatSync(resolved);
  if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
      || (identity.mode & 0o7777) !== 0o600
      || (process.env.NEXUS_RELEASE_TEST_MODE !== '1'
        && (identity.uid !== 0 || identity.gid !== 0))) {
    throw new Error('accepted layout recovery journal identity is unsafe');
  }
  const journal = readSafeJson(resolved, 32 * 1024).value;
  assertExactKeys(journal, [
    'authorityVerificationSha256',
    'drillProofVerificationSha256',
    'faultDrillEnvelopeSha256',
    'phase',
    'phaseAReceiptSha256',
    'pm2ProofSha256',
    'requestEnvelopeSha256',
    'schema',
    'submittedAt',
    'transactionId',
  ], 'accepted layout recovery journal');
  const request = requestInput.value.payload;
  const drill = drillInput.value.payload;
  const submitted = Date.parse(journal.submittedAt ?? '');
  const requestCreated = Date.parse(request.createdAt ?? '');
  const requestExpires = Date.parse(request.expiresAt ?? '');
  const planCreated = Date.parse(drill.plan?.createdAt ?? '');
  const planExpires = Date.parse(drill.plan?.expiresAt ?? '');
  if (journal.schema !== 'nexus.release-layout-activation-transaction.v1'
      || journal.phase !== 'submitted'
      || journal.transactionId !== request.migrationId
      || journal.transactionId !== drill.migrationId
      || journal.requestEnvelopeSha256 !== rawSha256(requestInput.body)
      || journal.faultDrillEnvelopeSha256 !== rawSha256(drillInput.body)
      || request.faultDrillEnvelopeSha256 !== journal.faultDrillEnvelopeSha256
      || !DIGEST.test(journal.authorityVerificationSha256 ?? '')
      || !DIGEST.test(journal.drillProofVerificationSha256 ?? '')
      || !DIGEST.test(journal.pm2ProofSha256 ?? '')
      || !DIGEST.test(journal.phaseAReceiptSha256 ?? '')
      || !Number.isFinite(submitted)
      || new Date(submitted).toISOString() !== journal.submittedAt
      || !Number.isFinite(requestCreated)
      || !Number.isFinite(requestExpires)
      || !Number.isFinite(planCreated)
      || !Number.isFinite(planExpires)
      || submitted < requestCreated
      || submitted > requestExpires
      || submitted < planCreated
      || submitted > planExpires) {
    throw new Error('accepted layout recovery journal is outside signed authority');
  }
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
  const acceptedRecovery = args.includes('--accepted-recovery-journal')
    ? option('--accepted-recovery-journal')
    : null;
  if (acceptedRecovery !== null && args.includes('--allow-expired')) {
    throw new Error('accepted recovery and general expiry modes are mutually exclusive');
  }
  const request = verifyEnvelope(
    requestInput.value,
    'request',
    publicKey,
    { allowExpired: acceptedRecovery !== null || args.includes('--allow-expired') },
  );
  const drill = verifyEnvelope(
    drillInput.value,
    'fault-drill',
    publicKey,
    { allowExpired: acceptedRecovery !== null || args.includes('--allow-expired') },
  );
  if (request.migrationId !== drill.migrationId
      || canonicalJson(request.source) !== canonicalJson(drill.source)
      || request.faultDrillEnvelopeSha256 !== rawSha256(drillInput.body)
      || Date.parse(drill.completedAt) > Date.parse(request.createdAt)) {
    throw new Error('layout request is not bound to the exact signed fault-drill evidence');
  }
  if (acceptedRecovery !== null) {
    validateAcceptedRecovery(acceptedRecovery, requestInput, drillInput);
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
