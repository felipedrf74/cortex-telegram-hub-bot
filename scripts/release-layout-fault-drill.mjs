#!/usr/bin/env node
// Produce and collect layout-specific KVM drill evidence. Promotion drill
// outcomes are deliberately unsupported: every scenario record must bind an
// isolated-KVM identity to a layout-activation execution trace and a monotonic
// observer clock before it can become owner-signable drill evidence.
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 'nexus-release-layout-fault-drill.v1';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SCENARIOS = Object.freeze([
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
]);
const EXPECTED_BASE = Object.freeze({
  production: '/home/dominguez/telegram-hub-bot',
  staging: '/home/dominguez/telegram-hub-bot-staging',
});
const PROOF_SCHEMA = 'nexus.release-layout-kvm-proof.v1';
const RESULT_SCHEMA = 'nexus.release-layout-fault-scenario-result.v2';
const HYPERVISOR_EVIDENCE_SCHEMA =
  'nexus.release-layout-hypervisor-isolation-evidence.v1';
const LEGACY_GUEST_EVIDENCE_SCHEMA =
  'nexus.release-layout-guest-execution-evidence.v1';
const GUEST_EVIDENCE_SCHEMA =
  'nexus.release-layout-guest-execution-evidence.v2';
const TRUST_SCHEMA = 'nexus.release-layout-kvm-trust.v1';
const PROVISION_SCHEMA = 'nexus.rollback-drill-vm-provision.v2';
const PLAN_VERIFICATION_SCHEMA =
  'nexus.release-layout-fault-plan-verification.v1';
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
const SCENARIO_GUEST_IDS = Object.freeze({
  failed_health_check: 'guest-2',
  host_reboot_during_migration: 'guest-3',
  ssh_disconnect_after_pm2_stop: 'guest-1',
});
const MAX_EVIDENCE_BYTES = 128 * 1024;
const MAX_DATABASE_BACKUP_BYTES = 32 * 1024;
const MAX_TARGET_BACKUP_BYTES = 64 * 1024;
const TARGET_BACKUP_SCHEMA =
  'nexus.release-layout-guest-target-backup.v1';

function nowMs() {
  const injected = process.env.NODE_ENV === 'test'
    ? process.env.NEXUS_RELEASE_LAYOUT_TEST_NOW
    : undefined;
  if (injected === undefined) return Date.now();
  const parsed = Date.parse(injected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== injected) {
    fail('test clock is invalid');
  }
  return parsed;
}

function fail(message) {
  throw new Error(`release layout fault drill: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`${label} fields are invalid`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicKeyPem(input, label) {
  let key;
  try {
    key = createPublicKey(input);
  } catch {
    fail(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail(`${label} must be an Ed25519 public key`);
  }
  return key.export({ format: 'pem', type: 'spki' }).toString();
}

function publicKeySha256(pem) {
  return sha256(Buffer.from(pem, 'utf8'));
}

function strictBase64(value, label, { exactBytes, maximumBytes } = {}) {
  if (typeof value !== 'string' || value.length < 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const body = Buffer.from(value, 'base64');
  if (body.toString('base64') !== value
      || (exactBytes !== undefined && body.length !== exactBytes)
      || (maximumBytes !== undefined && body.length > maximumBytes)) {
    fail(`${label} size or encoding is invalid`);
  }
  return body;
}

function validateSqliteBackup(body) {
  const header = Buffer.from('SQLite format 3\0', 'binary');
  if (body.length < 512
      || !body.subarray(0, header.length).equals(header)) {
    fail('layout guest signed database backup is not SQLite');
  }
  const encodedPageSize = body.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const pageCount = body.readUInt32BE(28);
  if (pageSize < 512 || pageSize > 65_536
      || (pageSize & (pageSize - 1)) !== 0
      || pageCount < 1 || pageCount * pageSize !== body.length) {
    fail('layout guest signed database backup SQLite layout is invalid');
  }
}

function validateTargetBackup(body, plan) {
  if (body.length < 2 || body.length > MAX_TARGET_BACKUP_BYTES) {
    fail('layout guest target backup size is invalid');
  }
  let backup;
  try {
    backup = JSON.parse(body.toString('utf8'));
  } catch {
    fail('layout guest target backup is not JSON');
  }
  exactKeys(
    backup,
    ['database', 'health', 'release', 'schema', 'sourceSha256'],
    'layout guest target backup',
  );
  if (backup.schema !== TARGET_BACKUP_SCHEMA
      || backup.sourceSha256 !== sourceSha256(plan.source)) {
    fail('layout guest target backup identity is invalid');
  }
  const definitions = [
    ['release', backup.release, 'release.json', 128 * 1024],
    ['health', backup.health, 'health', 1024],
    [
      'database',
      backup.database,
      'database.sqlite',
      MAX_DATABASE_BACKUP_BYTES,
    ],
  ];
  const decoded = {};
  for (const [label, entry, expectedPath, maximumBytes] of definitions) {
    exactKeys(
      entry,
      ['bytes', 'contentBase64', 'contentEncoding', 'path', 'sha256'],
      `layout guest target backup ${label}`,
    );
    const entryBody = strictBase64(
      entry.contentBase64,
      `layout guest target backup ${label}`,
      { maximumBytes },
    );
    if (entry.path !== expectedPath || entry.contentEncoding !== 'base64'
        || entry.bytes !== entryBody.length
        || !DIGEST.test(entry.sha256 ?? '')
        || sha256(entryBody) !== entry.sha256) {
      fail(`layout guest target backup ${label} identity is invalid`);
    }
    decoded[label] = entryBody;
  }
  if (!decoded.release.equals(
    Buffer.from(`${canonicalJson(plan.source)}\n`, 'utf8'),
  ) || !decoded.health.equals(Buffer.from('ok\n'))) {
    fail('layout guest target backup release identity is invalid');
  }
  validateSqliteBackup(decoded.database);
  if (!body.equals(Buffer.from(canonicalJson(backup), 'utf8'))) {
    fail('layout guest target backup bytes are not canonical');
  }
  return backup;
}

function parseEvidenceBody(value, label) {
  const body = strictBase64(value, `${label} body`, {
    maximumBytes: MAX_EVIDENCE_BYTES,
  });
  if (body.length < 2) fail(`${label} body is empty`);
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    fail(`${label} body is not JSON`);
  }
  return { body, value: parsed };
}

function verifyEvidenceSignature(body, signatureBase64, publicKey, label) {
  const signature = strictBase64(signatureBase64, `${label} signature`, {
    exactBytes: 64,
  });
  if (!cryptoVerify(null, body, createPublicKey(publicKey), signature)) {
    fail(`${label} signature is invalid`);
  }
}

function planSha256(plan) {
  return sha256(Buffer.from(canonicalJson(plan), 'utf8'));
}

function sourceSha256(source) {
  return sha256(Buffer.from(canonicalJson(source), 'utf8'));
}

function validateHypervisorProducer(value, label) {
  exactKeys(value, [
    'controllerPath',
    'controllerRecoveryUnitPath',
    'controllerRecoveryUnitSha256',
    'controllerSha256',
    'controllerUnitPath',
    'controllerUnitSha256',
    'verifierPath',
    'verifierSha256',
  ], label);
  if (value.controllerPath !== CONTROLLER_PATH
      || value.controllerRecoveryUnitPath !== CONTROLLER_RECOVERY_UNIT_PATH
      || value.controllerUnitPath !== CONTROLLER_UNIT_PATH
      || value.verifierPath !== VERIFIER_PATH
      || !DIGEST.test(value.controllerSha256 ?? '')
      || !DIGEST.test(value.controllerRecoveryUnitSha256 ?? '')
      || !DIGEST.test(value.controllerUnitSha256 ?? '')
      || !DIGEST.test(value.verifierSha256 ?? '')) {
    fail(`${label} identity is invalid`);
  }
}

function validateGuestProducer(value, label) {
  exactKeys(value, [
    'executorPath',
    'executorSha256',
    'recoveryUnitPath',
    'recoveryUnitSha256',
  ], label);
  if (value.executorPath !== GUEST_EXECUTOR_PATH
      || value.recoveryUnitPath !== GUEST_RECOVERY_UNIT_PATH
      || !DIGEST.test(value.executorSha256 ?? '')
      || !DIGEST.test(value.recoveryUnitSha256 ?? '')) {
    fail(`${label} identity is invalid`);
  }
}

function validatePlanProducers(value) {
  exactKeys(value, ['guests', 'hypervisor'], 'layout drill producer trust');
  validateHypervisorProducer(
    value.hypervisor,
    'layout drill hypervisor producer',
  );
  exactKeys(value.guests, SCENARIOS, 'layout drill guest producer trust');
  for (const scenarioId of SCENARIOS) {
    validateGuestProducer(
      value.guests[scenarioId],
      `layout drill ${scenarioId} guest producer`,
    );
  }
}

function validateTrustManifest(value) {
  exactKeys(value, [
    'createdAt',
    'guests',
    'hypervisor',
    'provision',
    'schema',
  ], 'layout KVM trust manifest');
  exactKeys(value.provision, [
    'receiptSha256',
    'schema',
    'setId',
  ], 'layout KVM trust provision');
  exactKeys(value.hypervisor, [
    'controllerPath',
    'controllerRecoveryUnitPath',
    'controllerRecoveryUnitSha256',
    'controllerSha256',
    'controllerUnitPath',
    'controllerUnitSha256',
    'publicKeyPem',
    'publicKeySha256',
    'qemuSha256',
    'runnerSha256',
    'verifierPath',
    'verifierSha256',
  ], 'layout KVM hypervisor trust');
  exactKeys(value.guests, SCENARIOS, 'layout KVM guest trust');
  if (value.schema !== TRUST_SCHEMA
      || value.provision.schema !== PROVISION_SCHEMA
      || !DIGEST.test(value.provision.setId ?? '')
      || !DIGEST.test(value.provision.receiptSha256 ?? '')
      || !DIGEST.test(value.hypervisor.qemuSha256 ?? '')
      || !DIGEST.test(value.hypervisor.runnerSha256 ?? '')
      || !Number.isFinite(Date.parse(value.createdAt ?? ''))) {
    fail('layout KVM trust manifest identity is invalid');
  }
  validateHypervisorProducer(
    {
      controllerPath: value.hypervisor.controllerPath,
      controllerRecoveryUnitPath:
        value.hypervisor.controllerRecoveryUnitPath,
      controllerRecoveryUnitSha256:
        value.hypervisor.controllerRecoveryUnitSha256,
      controllerSha256: value.hypervisor.controllerSha256,
      controllerUnitPath: value.hypervisor.controllerUnitPath,
      controllerUnitSha256: value.hypervisor.controllerUnitSha256,
      verifierPath: value.hypervisor.verifierPath,
      verifierSha256: value.hypervisor.verifierSha256,
    },
    'layout KVM hypervisor producer',
  );
  const hypervisorKey = publicKeyPem(
    value.hypervisor.publicKeyPem,
    'layout KVM trusted hypervisor key',
  );
  if (hypervisorKey !== value.hypervisor.publicKeyPem
      || publicKeySha256(hypervisorKey) !== value.hypervisor.publicKeySha256) {
    fail('layout KVM trusted hypervisor key identity is invalid');
  }
  const keyDigests = new Set([value.hypervisor.publicKeySha256]);
  for (const scenarioId of SCENARIOS) {
    const entry = value.guests[scenarioId];
    exactKeys(entry, [
      'executorPath',
      'executorSha256',
      'guestId',
      'publicKeyPem',
      'publicKeySha256',
      'recoveryUnitPath',
      'recoveryUnitSha256',
      'sshHostPublicKeySha256',
    ], `layout KVM ${scenarioId} guest trust`);
    validateGuestProducer(
      {
        executorPath: entry.executorPath,
        executorSha256: entry.executorSha256,
        recoveryUnitPath: entry.recoveryUnitPath,
        recoveryUnitSha256: entry.recoveryUnitSha256,
      },
      `layout KVM ${scenarioId} guest producer`,
    );
    const key = publicKeyPem(
      entry.publicKeyPem,
      `layout KVM ${scenarioId} trusted guest key`,
    );
    if (entry.guestId !== SCENARIO_GUEST_IDS[scenarioId]
        || key !== entry.publicKeyPem
        || publicKeySha256(key) !== entry.publicKeySha256
        || !DIGEST.test(entry.sshHostPublicKeySha256 ?? '')) {
      fail(`layout KVM ${scenarioId} trusted guest identity is invalid`);
    }
    keyDigests.add(entry.publicKeySha256);
  }
  if (keyDigests.size !== SCENARIOS.length + 1) {
    fail('layout KVM trusted signer keys must be pairwise distinct');
  }
}

function validateRootTrustIdentity(manifestFile, receiptFile, required) {
  if (!required) return;
  for (const [file, mode] of [[manifestFile, 0o600], [receiptFile, 0o640]]) {
    const identity = fs.lstatSync(path.resolve(file));
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
        || (identity.mode & 0o7777) !== mode
        || (process.env.NEXUS_RELEASE_TEST_MODE !== '1'
          && (identity.uid !== 0 || (file === manifestFile && identity.gid !== 0)))) {
      fail('root-pinned layout KVM trust identity is unsafe');
    }
  }
}

function validateTrustBinding(plan, manifestInput, receiptInput) {
  validateTrustManifest(manifestInput.value);
  const receipt = receiptInput.value;
  const expectedReceiptKeys = [
    'createdAt',
    'guestSshHostPublicKeySha256s',
    'guests',
    'hypervisor',
    'image',
    'ports',
    'runtimeReadiness',
    'schema',
    'setDirectory',
    'setId',
    'sshPublicKeySha256',
  ];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).sort().join(',')
        !== expectedReceiptKeys.sort().join(',')
      || receipt.schema !== PROVISION_SCHEMA
      || receipt.setId !== manifestInput.value.provision.setId
      || sha256(receiptInput.body) !== manifestInput.value.provision.receiptSha256
      || plan.trust.trustManifestSha256 !== sha256(manifestInput.body)
      || plan.trust.provisionReceiptSha256
        !== manifestInput.value.provision.receiptSha256
      || plan.trust.provisionSetId !== manifestInput.value.provision.setId
      || plan.trust.hypervisorEd25519PublicKey
        !== manifestInput.value.hypervisor.publicKeyPem
      || receipt.hypervisor?.qemuSha256
        !== manifestInput.value.hypervisor.qemuSha256
      || receipt.hypervisor?.runnerSha256
        !== manifestInput.value.hypervisor.runnerSha256
      || receipt.hypervisor?.faultDrillControllerSha256
        !== manifestInput.value.hypervisor.controllerSha256
      || receipt.hypervisor?.faultDrillControllerRecoveryUnitSha256
        !== manifestInput.value.hypervisor.controllerRecoveryUnitSha256
      || receipt.hypervisor?.faultDrillControllerUnitSha256
        !== manifestInput.value.hypervisor.controllerUnitSha256
      || receipt.hypervisor?.faultDrillVerifierSha256
        !== manifestInput.value.hypervisor.verifierSha256
      || receipt.hypervisor?.faultDrillGuestExecutorSha256
        !== manifestInput.value.guests.failed_health_check.executorSha256
      || receipt.hypervisor?.faultDrillGuestRecoveryUnitSha256
        !== manifestInput.value.guests.failed_health_check.recoveryUnitSha256
      || !Array.isArray(receipt.guests)
      || receipt.guests.length !== SCENARIOS.length
      || !Array.isArray(receipt.guestSshHostPublicKeySha256s)
      || receipt.guestSshHostPublicKeySha256s.length !== SCENARIOS.length) {
    fail('layout KVM plan differs from the root-pinned trust manifest');
  }
  const receiptGuests = new Map();
  for (const [index, guest] of receipt.guests.entries()) {
    if (!guest || typeof guest !== 'object' || Array.isArray(guest)
        || guest.name !== `guest-${index + 1}`
        || receiptGuests.has(guest.name)
        || !DIGEST.test(guest.hostPublicKeySha256 ?? '')
        || receipt.guestSshHostPublicKeySha256s[index]
          !== guest.hostPublicKeySha256) {
      fail('active KVM provision guest identity is invalid');
    }
    receiptGuests.set(guest.name, guest);
  }
  for (const scenarioId of SCENARIOS) {
    const trustedGuest = manifestInput.value.guests[scenarioId];
    const receiptGuest = receiptGuests.get(trustedGuest.guestId);
    if (plan.trust.guestEd25519PublicKeys[scenarioId]
          !== trustedGuest.publicKeyPem
        || plan.trust.guestIds[scenarioId]
          !== trustedGuest.guestId
        || !receiptGuest
        || receiptGuest.name !== trustedGuest.guestId
        || receiptGuest.hostPublicKeySha256
          !== trustedGuest.sshHostPublicKeySha256
        || receipt.hypervisor.faultDrillGuestExecutorSha256
          !== trustedGuest.executorSha256
        || receipt.hypervisor.faultDrillGuestRecoveryUnitSha256
          !== trustedGuest.recoveryUnitSha256
        || canonicalJson(plan.trust.producers.guests[scenarioId])
          !== canonicalJson({
            executorPath: trustedGuest.executorPath,
            executorSha256: trustedGuest.executorSha256,
            recoveryUnitPath: trustedGuest.recoveryUnitPath,
            recoveryUnitSha256: trustedGuest.recoveryUnitSha256,
          })) {
      fail('layout KVM guest plan differs from the root-pinned trust mapping');
    }
  }
  if (canonicalJson(plan.trust.producers.hypervisor) !== canonicalJson({
    controllerPath: manifestInput.value.hypervisor.controllerPath,
    controllerRecoveryUnitPath:
      manifestInput.value.hypervisor.controllerRecoveryUnitPath,
    controllerRecoveryUnitSha256:
      manifestInput.value.hypervisor.controllerRecoveryUnitSha256,
    controllerSha256: manifestInput.value.hypervisor.controllerSha256,
    controllerUnitPath: manifestInput.value.hypervisor.controllerUnitPath,
    controllerUnitSha256: manifestInput.value.hypervisor.controllerUnitSha256,
    verifierPath: manifestInput.value.hypervisor.verifierPath,
    verifierSha256: manifestInput.value.hypervisor.verifierSha256,
  })) {
    fail('layout KVM hypervisor producer differs from root-pinned trust');
  }
}

function readBytes(file, maximum = 256 * 1024) {
  const resolved = path.resolve(file);
  const descriptor = fs.openSync(
    resolved,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > maximum) {
      fail('input is not a bounded single-link regular file');
    }
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs) {
      fail('input changed while it was read');
    }
    return body;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readJson(file, maximum) {
  const body = readBytes(file, maximum);
  return { body, value: JSON.parse(body.toString('utf8')) };
}

function writeExclusive(file, value) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentIdentity = fs.lstatSync(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) {
    fail('output parent is unsafe');
  }
  const temporary = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, resolved);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (error?.code === 'EEXIST') fail('output already exists');
    throw error;
  }
  fs.rmSync(temporary);
  const directory = fs.openSync(parent, 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) {
    fail(`missing ${name}`);
  }
  return args[index + 1];
}

function validateIdentity(identity, role) {
  exactKeys(
    identity,
    ['artifactDigest', 'base', 'installedRuntimeDigest', 'runtimeSha'],
    `${role} source identity`,
  );
  if (identity.base !== EXPECTED_BASE[role] || !SHA.test(identity.runtimeSha ?? '')
      || !DIGEST.test(identity.artifactDigest ?? '')
      || !DIGEST.test(identity.installedRuntimeDigest ?? '')) {
    fail(`${role} source identity is invalid`);
  }
}

function validateSource(source) {
  exactKeys(source, ['production', 'staging'], 'layout source');
  validateIdentity(source.production, 'production');
  validateIdentity(source.staging, 'staging');
}

function validatePlan(plan, { allowExpired = false } = {}) {
  exactKeys(plan, [
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
  ], 'layout drill plan');
  if (plan.schema !== 'nexus.release-layout-fault-drill-plan.v1'
      || !UUID.test(plan.planId ?? '') || !UUID.test(plan.migrationId ?? '')
      || !DIGEST.test(plan.challengeNonce ?? '')
      || plan.promotionAllowed !== false) {
    fail('layout drill plan identity is invalid');
  }
  validateSource(plan.source);
  exactKeys(
    plan.trust,
    [
      'guestEd25519PublicKeys',
      'guestIds',
      'hypervisorEd25519PublicKey',
      'producers',
      'provisionReceiptSha256',
      'provisionSetId',
      'trustManifestSha256',
    ],
    'layout drill trust',
  );
  exactKeys(
    plan.trust.guestEd25519PublicKeys,
    SCENARIOS,
    'layout drill guest trust',
  );
  exactKeys(plan.trust.guestIds, SCENARIOS, 'layout drill guest identity map');
  validatePlanProducers(plan.trust.producers);
  const hypervisorKey = publicKeyPem(
    plan.trust.hypervisorEd25519PublicKey,
    'layout drill hypervisor key',
  );
  if (hypervisorKey !== plan.trust.hypervisorEd25519PublicKey) {
    fail('layout drill hypervisor key is not canonical');
  }
  const distinctKeys = new Set([publicKeySha256(hypervisorKey)]);
  for (const scenarioId of SCENARIOS) {
    const guestKey = publicKeyPem(
      plan.trust.guestEd25519PublicKeys[scenarioId],
      `layout drill ${scenarioId} guest key`,
    );
    if (guestKey !== plan.trust.guestEd25519PublicKeys[scenarioId]) {
      fail(`layout drill ${scenarioId} guest key is not canonical`);
    }
    if (plan.trust.guestIds[scenarioId] !== SCENARIO_GUEST_IDS[scenarioId]) {
      fail(`layout drill ${scenarioId} guest identity is invalid`);
    }
    distinctKeys.add(publicKeySha256(guestKey));
  }
  if (distinctKeys.size !== SCENARIOS.length + 1
      || !DIGEST.test(plan.trust.trustManifestSha256 ?? '')
      || !DIGEST.test(plan.trust.provisionReceiptSha256 ?? '')
      || !DIGEST.test(plan.trust.provisionSetId ?? '')) {
    fail('layout drill signer keys must be pairwise distinct');
  }
  exactKeys(plan.execution, [
    'automaticProtectedApproval',
    'independentOverlayRequired',
    'isolatedKvmRequired',
    'maximumActiveGuests',
    'mode',
    'productionDataForbidden',
    'productionKeysForbidden',
  ], 'layout drill execution policy');
  if (plan.execution.mode !== 'strictly-sequential'
      || plan.execution.maximumActiveGuests !== 1
      || plan.execution.isolatedKvmRequired !== true
      || plan.execution.independentOverlayRequired !== true
      || plan.execution.productionDataForbidden !== true
      || plan.execution.productionKeysForbidden !== true
      || plan.execution.automaticProtectedApproval !== false) {
    fail('layout drill execution policy is unsafe');
  }
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length !== SCENARIOS.length) {
    fail('layout drill scenario plan is incomplete');
  }
  for (const [index, scenario] of plan.scenarios.entries()) {
    exactKeys(scenario, [
      'expectedTerminalStatus',
      'fault',
      'id',
      'order',
      'productionEvidenceAllowed',
    ], 'layout drill planned scenario');
    if (scenario.id !== SCENARIOS[index] || scenario.order !== index + 1
        || scenario.fault !== SCENARIOS[index]
        || scenario.expectedTerminalStatus !== 'recovered'
        || scenario.productionEvidenceAllowed !== false) {
      fail('layout drill scenario order or policy is invalid');
    }
  }
  const created = Date.parse(plan.createdAt ?? '');
  const expires = Date.parse(plan.expiresAt ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created
      || expires - created > 7 * 24 * 60 * 60 * 1000
      || (!allowExpired
        && (created > nowMs() + 60 * 1000 || expires < nowMs()))) {
    fail('layout drill plan lifetime is invalid');
  }
}

function prepare(args) {
  const migrationId = option(args, '--migration-id');
  const sourceFile = option(args, '--source');
  const trustManifestFile = option(args, '--trust-manifest');
  const output = option(args, '--output');
  if (!UUID.test(migrationId)) fail('migration id is invalid');
  const source = readJson(sourceFile).value;
  const trustManifest = readJson(trustManifestFile);
  validateSource(source);
  validateTrustManifest(trustManifest.value);
  const now = new Date();
  const plan = {
    schema: 'nexus.release-layout-fault-drill-plan.v1',
    planId: randomUUID(),
    migrationId,
    challengeNonce: randomBytes(32).toString('hex'),
    source,
    trust: {
      trustManifestSha256: sha256(trustManifest.body),
      provisionSetId: trustManifest.value.provision.setId,
      provisionReceiptSha256: trustManifest.value.provision.receiptSha256,
      hypervisorEd25519PublicKey:
        trustManifest.value.hypervisor.publicKeyPem,
      guestEd25519PublicKeys: Object.fromEntries(SCENARIOS.map((scenarioId) => [
        scenarioId,
        trustManifest.value.guests[scenarioId].publicKeyPem,
      ])),
      guestIds: Object.fromEntries(SCENARIOS.map((scenarioId) => [
        scenarioId,
        trustManifest.value.guests[scenarioId].guestId,
      ])),
      producers: {
        hypervisor: {
          controllerPath: trustManifest.value.hypervisor.controllerPath,
          controllerRecoveryUnitPath:
            trustManifest.value.hypervisor.controllerRecoveryUnitPath,
          controllerRecoveryUnitSha256:
            trustManifest.value.hypervisor.controllerRecoveryUnitSha256,
          controllerSha256: trustManifest.value.hypervisor.controllerSha256,
          controllerUnitPath:
            trustManifest.value.hypervisor.controllerUnitPath,
          controllerUnitSha256:
            trustManifest.value.hypervisor.controllerUnitSha256,
          verifierPath: trustManifest.value.hypervisor.verifierPath,
          verifierSha256: trustManifest.value.hypervisor.verifierSha256,
        },
        guests: Object.fromEntries(SCENARIOS.map((scenarioId) => {
          const guest = trustManifest.value.guests[scenarioId];
          return [
            scenarioId,
            {
              executorPath: guest.executorPath,
              executorSha256: guest.executorSha256,
              recoveryUnitPath: guest.recoveryUnitPath,
              recoveryUnitSha256: guest.recoveryUnitSha256,
            },
          ];
        })),
      },
    },
    execution: {
      mode: 'strictly-sequential',
      maximumActiveGuests: 1,
      isolatedKvmRequired: true,
      independentOverlayRequired: true,
      productionDataForbidden: true,
      productionKeysForbidden: true,
      automaticProtectedApproval: false,
    },
    scenarios: SCENARIOS.map((id, index) => ({
      id,
      order: index + 1,
      fault: id,
      expectedTerminalStatus: 'recovered',
      productionEvidenceAllowed: false,
    })),
    promotionAllowed: false,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  writeExclusive(output, plan);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    command: 'prepare',
    status: 'ready_for_kvm_execution',
    activationEligible: false,
    planId: plan.planId,
    planSha256: planSha256(plan),
  })}\n`);
}

function validateIsolation(
  value,
  plan,
  scenarioId,
  expectedPlanSha256,
  executionBody,
  execution,
) {
  exactKeys(value, [
    'challengeNonce',
    'createdAt',
    'executionEvidenceSha256',
    'guest',
    'guestId',
    'hypervisor',
    'independentOverlay',
    'kvmAcceleration',
    'loopbackSshOnly',
    'observer',
    'planId',
    'planSha256',
    'producer',
    'productionDataMounted',
    'productionNetworkReachable',
    'productionSecretsPresent',
    'scenarioId',
    'schema',
    'faultObservation',
  ], 'layout KVM isolation');
  validateHypervisorProducer(
    value.producer,
    'layout KVM isolation producer',
  );
  exactKeys(value.faultObservation, [
    'guestRebootObserved',
    'guestSshHostPublicKeySha256',
    'qemuCommandLineSha256',
    'qemuMainPid',
    'sshDisconnectObserved',
    'systemdUnit',
  ], 'layout KVM live fault observation');
  if (value.schema !== HYPERVISOR_EVIDENCE_SCHEMA
      || value.planId !== plan.planId
      || value.planSha256 !== expectedPlanSha256
      || value.challengeNonce !== plan.challengeNonce
      || value.scenarioId !== scenarioId
      || value.guestId !== plan.trust.guestIds[scenarioId]
      || value.hypervisor !== 'qemu-kvm' || value.kvmAcceleration !== true
      || value.independentOverlay !== true || value.loopbackSshOnly !== true
      || value.productionDataMounted !== false || value.productionSecretsPresent !== false
      || value.productionNetworkReachable !== false
      || canonicalJson(value.producer)
        !== canonicalJson(plan.trust.producers.hypervisor)
      || value.faultObservation.systemdUnit
        !== `nexus-rollback-drill-vm@${plan.trust.guestIds[scenarioId]}.service`
      || !Number.isSafeInteger(value.faultObservation.qemuMainPid)
      || value.faultObservation.qemuMainPid <= 1
      || !DIGEST.test(value.faultObservation.qemuCommandLineSha256 ?? '')
      || !DIGEST.test(
        value.faultObservation.guestSshHostPublicKeySha256 ?? '',
      )
      || value.faultObservation.guestRebootObserved
        !== (scenarioId === 'host_reboot_during_migration')
      || value.faultObservation.sshDisconnectObserved
        !== (scenarioId === 'ssh_disconnect_after_pm2_stop')
      || !Number.isFinite(Date.parse(value.createdAt ?? ''))) {
    fail('layout KVM isolation evidence is invalid');
  }
  if (value.executionEvidenceSha256 !== sha256(executionBody)
      || canonicalJson(value.observer) !== canonicalJson(execution.observer)
      || canonicalJson(value.guest) !== canonicalJson(execution.guest)
      || Date.parse(value.createdAt) < Date.parse(execution.completedAt)
      || Date.parse(value.createdAt) - Date.parse(execution.completedAt) > 60_000) {
    fail('layout KVM observer evidence is not bound to guest execution');
  }
}

function validateExecution(value, plan, scenarioId, expectedPlanSha256) {
  const hasSignedBackup = value?.schema === GUEST_EVIDENCE_SCHEMA;
  exactKeys(value, [
    'challengeNonce',
    'completedAt',
    'connectionDropped',
    'controlVersion',
    'databaseRecoveryVerified',
    'exactPredecessorRestored',
    'executionMode',
    'faultInjected',
    'guest',
    'healthRestored',
    'migrationId',
    'observer',
    'planId',
    'planSha256',
    'producer',
    'productionEvidenceEmitted',
    'promotionControlInvoked',
    'scenarioId',
    'schema',
    'terminalStatus',
    'testMode',
    'faultObservation',
  ], 'layout fault execution');
  validateGuestProducer(
    value.producer,
    `layout ${scenarioId} execution producer`,
  );
  const faultObservationFields = [
    'candidateHealthFailureObserved',
    'databaseAfterSha256',
    'databaseBeforeSha256',
    'durableRecoveryArmed',
    'journalSha256',
    'predecessorSha256',
    'processStoppedObserved',
    'restoredSha256',
  ];
  if (hasSignedBackup) {
    faultObservationFields.push(
      'targetBackupBase64',
      'targetBackupBytes',
      'targetBackupSha256',
    );
  }
  exactKeys(
    value.faultObservation,
    faultObservationFields,
    'layout guest fault observation',
  );
  if (![LEGACY_GUEST_EVIDENCE_SCHEMA, GUEST_EVIDENCE_SCHEMA].includes(
    value.schema,
  )
      || value.planId !== plan.planId || value.migrationId !== plan.migrationId
      || value.planSha256 !== expectedPlanSha256
      || value.challengeNonce !== plan.challengeNonce
      || value.scenarioId !== scenarioId
      || value.controlVersion !== (
        hasSignedBackup
          ? 'nexus-release-layout-fault-guest.v2'
          : 'nexus-release-layout-fault-guest.v1'
      )
      || value.executionMode !== 'strictly-sequential' || value.testMode !== false
      || value.productionEvidenceEmitted !== false || value.promotionControlInvoked !== false
      || value.faultInjected !== scenarioId || value.terminalStatus !== 'recovered'
      || value.exactPredecessorRestored !== true || value.databaseRecoveryVerified !== true
      || value.healthRestored !== true
      || canonicalJson(value.producer)
        !== canonicalJson(plan.trust.producers.guests[scenarioId])
      || !DIGEST.test(value.faultObservation.journalSha256 ?? '')
      || !DIGEST.test(value.faultObservation.predecessorSha256 ?? '')
      || !DIGEST.test(value.faultObservation.restoredSha256 ?? '')
      || !DIGEST.test(value.faultObservation.databaseBeforeSha256 ?? '')
      || !DIGEST.test(value.faultObservation.databaseAfterSha256 ?? '')
      || value.faultObservation.predecessorSha256
        !== value.faultObservation.restoredSha256
      || value.faultObservation.databaseBeforeSha256
        !== value.faultObservation.databaseAfterSha256
      || value.faultObservation.candidateHealthFailureObserved
        !== (scenarioId === 'failed_health_check')
      || value.faultObservation.processStoppedObserved !== true
      || value.faultObservation.durableRecoveryArmed !== true
      || !Number.isFinite(Date.parse(value.completedAt ?? ''))) {
    fail('layout fault execution identity is invalid');
  }
  if (hasSignedBackup) {
    const targetBackup = strictBase64(
      value.faultObservation.targetBackupBase64,
      'layout guest target backup',
      { maximumBytes: MAX_TARGET_BACKUP_BYTES },
    );
    if (targetBackup.length < 2
        || value.faultObservation.targetBackupBytes
          !== targetBackup.length
        || !DIGEST.test(
          value.faultObservation.targetBackupSha256 ?? '',
        )
        || sha256(targetBackup)
          !== value.faultObservation.targetBackupSha256) {
      fail('layout guest signed target backup is invalid');
    }
    const target = validateTargetBackup(targetBackup, plan);
    if (target.release.sha256
          !== value.faultObservation.predecessorSha256
        || target.database.sha256
          !== value.faultObservation.databaseBeforeSha256) {
      fail('layout guest target backup recovery identity is invalid');
    }
  }
  const completed = Date.parse(value.completedAt);
  if (completed < Date.parse(plan.createdAt) || completed > Date.parse(plan.expiresAt)) {
    fail('layout fault execution is outside the authorized plan lifetime');
  }
  exactKeys(value.observer, [
    'bootId',
    'durationMilliseconds',
    'endMonotonicMilliseconds',
    'startMonotonicMilliseconds',
    'targetMilliseconds',
  ], 'layout fault observer');
  const observer = value.observer;
  if (!BOOT_ID.test(observer.bootId ?? '')
      || !Number.isSafeInteger(observer.startMonotonicMilliseconds)
      || !Number.isSafeInteger(observer.endMonotonicMilliseconds)
      || !Number.isSafeInteger(observer.durationMilliseconds)
      || observer.endMonotonicMilliseconds < observer.startMonotonicMilliseconds
      || observer.durationMilliseconds
        !== observer.endMonotonicMilliseconds - observer.startMonotonicMilliseconds
      || observer.targetMilliseconds !== 120000 || observer.durationMilliseconds > 120000) {
    fail('layout fault monotonic observer evidence is invalid');
  }
  exactKeys(value.guest, ['bootIdAfter', 'bootIdBefore'], 'layout fault guest boot identity');
  if (!BOOT_ID.test(value.guest.bootIdBefore ?? '') || !BOOT_ID.test(value.guest.bootIdAfter ?? '')) {
    fail('layout fault guest boot identity is invalid');
  }
  if (scenarioId === 'host_reboot_during_migration') {
    if (value.guest.bootIdBefore === value.guest.bootIdAfter || value.connectionDropped !== true) {
      fail('host reboot scenario did not prove a guest boot boundary');
    }
  } else if (value.guest.bootIdBefore !== value.guest.bootIdAfter) {
    fail('non-reboot scenario crossed a guest boot boundary');
  } else if (scenarioId === 'ssh_disconnect_after_pm2_stop'
      ? value.connectionDropped !== true : value.connectionDropped !== false) {
    fail('scenario connection-drop evidence differs');
  }
}

function validateResult(value, plan, scenarioId) {
  exactKeys(value, [
    'completedAt',
    'executionEvidenceSha256',
    'isolation',
    'isolationEvidenceSha256',
    'migrationId',
    'planId',
    'planSha256',
    'producerTrust',
    'producerVersion',
    'proof',
    'recordedAt',
    'recovery',
    'scenarioId',
    'schema',
    'sourceSha256',
    'status',
  ], 'layout fault scenario result');
  const expectedPlanSha256 = planSha256(plan.value);
  if (value.schema !== RESULT_SCHEMA
      || value.producerVersion !== VERSION || value.planId !== plan.value.planId
      || value.planSha256 !== expectedPlanSha256
      || value.migrationId !== plan.value.migrationId
      || value.scenarioId !== scenarioId || value.status !== 'passed'
      || value.sourceSha256 !== sourceSha256(plan.value.source)
      || !DIGEST.test(value.isolationEvidenceSha256 ?? '')
      || !DIGEST.test(value.executionEvidenceSha256 ?? '')
      || !Number.isFinite(Date.parse(value.completedAt ?? ''))
      || !Number.isFinite(Date.parse(value.recordedAt ?? ''))) {
    fail('layout fault scenario result identity is invalid');
  }
  if (Date.parse(value.recordedAt) < Date.parse(value.completedAt)
      || Date.parse(value.recordedAt) > Date.now() + 60_000) {
    fail('layout fault scenario result timestamp is invalid');
  }
  exactKeys(value.producerTrust, [
    'controllerRecoveryUnitSha256',
    'controllerSha256',
    'controllerUnitSha256',
    'guestExecutorSha256',
    'guestRecoveryUnitSha256',
  ], 'layout fault result producer trust');
  if (value.producerTrust.controllerSha256
        !== plan.value.trust.producers.hypervisor.controllerSha256
      || value.producerTrust.controllerRecoveryUnitSha256
        !== plan.value.trust.producers.hypervisor.controllerRecoveryUnitSha256
      || value.producerTrust.controllerUnitSha256
        !== plan.value.trust.producers.hypervisor.controllerUnitSha256
      || value.producerTrust.guestExecutorSha256
        !== plan.value.trust.producers.guests[scenarioId].executorSha256
      || value.producerTrust.guestRecoveryUnitSha256
        !== plan.value.trust.producers.guests[scenarioId].recoveryUnitSha256) {
    fail('layout fault result producer trust differs from the plan');
  }
  exactKeys(value.proof, [
    'challengeNonce',
    'executionEvidenceBase64',
    'executionSignatureBase64',
    'guestPublicKeySha256',
    'hypervisorPublicKeySha256',
    'isolationEvidenceBase64',
    'isolationSignatureBase64',
    'schema',
  ], 'layout fault scenario proof');
  const hypervisorKey = plan.value.trust.hypervisorEd25519PublicKey;
  const guestKey = plan.value.trust.guestEd25519PublicKeys[scenarioId];
  if (value.proof.schema !== PROOF_SCHEMA
      || value.proof.challengeNonce !== plan.value.challengeNonce
      || value.proof.hypervisorPublicKeySha256 !== publicKeySha256(hypervisorKey)
      || value.proof.guestPublicKeySha256 !== publicKeySha256(guestKey)) {
    fail('layout fault scenario proof identity is invalid');
  }
  const isolationInput = parseEvidenceBody(
    value.proof.isolationEvidenceBase64,
    'layout hypervisor isolation evidence',
  );
  const executionInput = parseEvidenceBody(
    value.proof.executionEvidenceBase64,
    'layout guest execution evidence',
  );
  if (sha256(isolationInput.body) !== value.isolationEvidenceSha256
      || sha256(executionInput.body) !== value.executionEvidenceSha256) {
    fail('layout fault scenario evidence digest is invalid');
  }
  validateExecution(
    executionInput.value,
    plan.value,
    scenarioId,
    expectedPlanSha256,
  );
  validateIsolation(
    isolationInput.value,
    plan.value,
    scenarioId,
    expectedPlanSha256,
    executionInput.body,
    executionInput.value,
  );
  verifyEvidenceSignature(
    isolationInput.body,
    value.proof.isolationSignatureBase64,
    hypervisorKey,
    'layout hypervisor isolation evidence',
  );
  verifyEvidenceSignature(
    executionInput.body,
    value.proof.executionSignatureBase64,
    guestKey,
    'layout guest execution evidence',
  );
  exactKeys(value.isolation, [
    'guestId',
    'hypervisor',
    'independentOverlay',
    'kvmAcceleration',
    'loopbackSshOnly',
  ], 'layout result isolation');
  if (value.isolation.hypervisor !== 'qemu-kvm' || value.isolation.kvmAcceleration !== true
      || value.isolation.independentOverlay !== true || value.isolation.loopbackSshOnly !== true
      || value.isolation.guestId !== plan.value.trust.guestIds[scenarioId]) {
    fail('layout result isolation is invalid');
  }
  exactKeys(value.recovery, [
    'connectionDropped',
    'databaseRecoveryVerified',
    'durationMilliseconds',
    'exactPredecessorRestored',
    'guestBootIdAfter',
    'guestBootIdBefore',
    'healthRestored',
    'observerBootId',
    'targetMilliseconds',
    'terminalStatus',
  ], 'layout result recovery');
  const recovery = value.recovery;
  if (!BOOT_ID.test(recovery.observerBootId ?? '')
      || !BOOT_ID.test(recovery.guestBootIdBefore ?? '')
      || !BOOT_ID.test(recovery.guestBootIdAfter ?? '')
      || !Number.isSafeInteger(recovery.durationMilliseconds)
      || recovery.durationMilliseconds < 0 || recovery.durationMilliseconds > 120000
      || recovery.targetMilliseconds !== 120000 || recovery.terminalStatus !== 'recovered'
      || recovery.exactPredecessorRestored !== true
      || recovery.databaseRecoveryVerified !== true || recovery.healthRestored !== true) {
    fail('layout result recovery proof is invalid');
  }
  if (scenarioId === 'host_reboot_during_migration') {
    if (recovery.guestBootIdBefore === recovery.guestBootIdAfter
        || recovery.connectionDropped !== true) {
      fail('layout reboot result does not cross a guest boot boundary');
    }
  } else if (recovery.guestBootIdBefore !== recovery.guestBootIdAfter
      || (scenarioId === 'ssh_disconnect_after_pm2_stop'
        ? recovery.connectionDropped !== true : recovery.connectionDropped !== false)) {
    fail('layout non-reboot result boot or disconnect proof differs');
  }
  return {
    id: scenarioId,
    status: 'passed',
    resultSha256: sha256(Buffer.from(canonicalJson(value), 'utf8')),
    result: value,
  };
}

function collect(args) {
  const plan = readJson(option(args, '--plan'));
  validatePlan(plan.value);
  const paths = new Map([
    ['failed_health_check', option(args, '--failed-health-result')],
    ['host_reboot_during_migration', option(args, '--host-reboot-result')],
    ['ssh_disconnect_after_pm2_stop', option(args, '--ssh-disconnect-result')],
  ]);
  const scenarios = [];
  let maximumRecoveryMilliseconds = 0;
  let completedAt = 0;
  for (const scenarioId of SCENARIOS) {
    const input = readJson(paths.get(scenarioId));
    scenarios.push(validateResult(input.value, plan, scenarioId));
    maximumRecoveryMilliseconds = Math.max(
      maximumRecoveryMilliseconds,
      input.value.recovery.durationMilliseconds,
    );
    completedAt = Math.max(completedAt, Date.parse(input.value.completedAt));
  }
  const drill = {
    schema: 'nexus.release-layout-fault-drill.v1',
    proofSchema: PROOF_SCHEMA,
    migrationId: plan.value.migrationId,
    source: plan.value.source,
    plan: plan.value,
    planSha256: planSha256(plan.value),
    scenarios,
    maximumRecoverySeconds: Math.ceil(maximumRecoveryMilliseconds / 1000),
    completedAt: new Date(completedAt).toISOString(),
  };
  writeExclusive(option(args, '--output'), drill);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    command: 'collect',
    planId: plan.value.planId,
    migrationId: plan.value.migrationId,
    maximumRecoverySeconds: drill.maximumRecoverySeconds,
  })}\n`);
}

function verifyResult(args) {
  const plan = readJson(option(args, '--plan'), 512 * 1024);
  validatePlan(plan.value);
  const scenarioId = option(args, '--scenario');
  if (!SCENARIOS.includes(scenarioId)) fail('result scenario is invalid');
  const input = readJson(option(args, '--input'), 512 * 1024);
  const verified = validateResult(input.value, plan, scenarioId);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    command: 'verify-result',
    planId: plan.value.planId,
    scenarioId,
    resultSha256: verified.resultSha256,
  })}\n`);
}

function validateDrillPayload(drill, { allowExpired = false } = {}) {
  exactKeys(drill, [
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
  validatePlan(drill.plan, { allowExpired });
  if (drill.schema !== 'nexus.release-layout-fault-drill.v1'
      || drill.proofSchema !== PROOF_SCHEMA
      || drill.migrationId !== drill.plan.migrationId
      || drill.planSha256 !== planSha256(drill.plan)
      || canonicalJson(drill.source) !== canonicalJson(drill.plan.source)
      || !Array.isArray(drill.scenarios)
      || drill.scenarios.length !== SCENARIOS.length
      || !Number.isSafeInteger(drill.maximumRecoverySeconds)
      || drill.maximumRecoverySeconds < 0
      || drill.maximumRecoverySeconds > 120) {
    fail('layout migration fault drill identity is invalid');
  }
  let maximumRecoveryMilliseconds = 0;
  let completedAt = 0;
  const plan = { value: drill.plan };
  for (const [index, scenario] of drill.scenarios.entries()) {
    exactKeys(
      scenario,
      ['id', 'result', 'resultSha256', 'status'],
      'layout migration fault drill scenario',
    );
    if (scenario.id !== SCENARIOS[index] || scenario.status !== 'passed'
        || !DIGEST.test(scenario.resultSha256 ?? '')) {
      fail('layout migration fault drill scenario identity is invalid');
    }
    const verified = validateResult(scenario.result, plan, scenario.id);
    if (verified.resultSha256 !== scenario.resultSha256) {
      fail('layout migration fault drill result digest is invalid');
    }
    maximumRecoveryMilliseconds = Math.max(
      maximumRecoveryMilliseconds,
      scenario.result.recovery.durationMilliseconds,
    );
    completedAt = Math.max(
      completedAt,
      Date.parse(scenario.result.completedAt),
    );
  }
  if (drill.maximumRecoverySeconds
        !== Math.ceil(maximumRecoveryMilliseconds / 1000)
      || Date.parse(drill.completedAt) !== completedAt) {
    fail('layout migration fault drill timing aggregate is invalid');
  }
  return drill;
}

function verifyDrill(args) {
  const input = readJson(option(args, '--input'), 2 * 1024 * 1024);
  const drill = validateDrillPayload(input.value);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    command: 'verify-drill',
    migrationId: drill.migrationId,
    planSha256: drill.planSha256,
    drillSha256: sha256(input.body),
  })}\n`);
}

function validateAcceptedRecovery(journalFile, requestFile, drillInput, drill) {
  for (const file of [journalFile, requestFile]) {
    const identity = fs.lstatSync(path.resolve(file));
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1
        || (identity.mode & 0o7777) !== 0o600
        || (process.env.NEXUS_RELEASE_TEST_MODE !== '1'
          && (identity.uid !== 0 || identity.gid !== 0))) {
      fail('accepted recovery transaction identity is unsafe');
    }
  }
  const journal = readJson(journalFile, 32 * 1024).value;
  const requestInput = readJson(requestFile, 256 * 1024);
  exactKeys(journal, [
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
  ], 'accepted recovery journal');
  exactKeys(
    requestInput.value,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'],
    'accepted recovery request envelope',
  );
  const request = requestInput.value.payload;
  exactKeys(request, [
    'createdAt',
    'destination',
    'expiresAt',
    'faultDrillEnvelopeSha256',
    'migrationId',
    'ownerAuthorization',
    'pm2AttestationSha256',
    'schema',
    'source',
  ], 'accepted recovery request');
  const submitted = Date.parse(journal.submittedAt ?? '');
  const requestCreated = Date.parse(request.createdAt ?? '');
  const requestExpires = Date.parse(request.expiresAt ?? '');
  const planCreated = Date.parse(drill.plan.createdAt ?? '');
  const planExpires = Date.parse(drill.plan.expiresAt ?? '');
  if (journal.schema !== 'nexus.release-layout-activation-transaction.v1'
      || journal.phase !== 'submitted'
      || journal.transactionId !== drill.migrationId
      || journal.transactionId !== request.migrationId
      || journal.requestEnvelopeSha256 !== sha256(requestInput.body)
      || journal.faultDrillEnvelopeSha256 !== sha256(drillInput.body)
      || requestInput.value.schema
        !== 'nexus.release-layout-request-envelope.v1'
      || requestInput.value.keyId !== 'nexus-owner-promotion-2026'
      || requestInput.value.signatureAlgorithm !== 'ed25519'
      || request.schema !== 'nexus.release-layout-migration-request.v1'
      || request.ownerAuthorization !== 'explicit'
      || request.faultDrillEnvelopeSha256 !== journal.faultDrillEnvelopeSha256
      || !DIGEST.test(request.pm2AttestationSha256 ?? '')
      || !DIGEST.test(journal.authorityVerificationSha256 ?? '')
      || !DIGEST.test(journal.drillProofVerificationSha256 ?? '')
      || !DIGEST.test(journal.pm2ProofSha256 ?? '')
      || !DIGEST.test(journal.phaseAReceiptSha256 ?? '')
      || !Number.isFinite(submitted)
      || new Date(submitted).toISOString() !== journal.submittedAt
      || !Number.isFinite(requestCreated)
      || !Number.isFinite(requestExpires)
      || requestExpires <= requestCreated
      || requestExpires - requestCreated > 2 * 60 * 60 * 1000
      || !Number.isFinite(planCreated)
      || !Number.isFinite(planExpires)
      || submitted < requestCreated
      || submitted > requestExpires
      || submitted < planCreated
      || submitted > planExpires) {
    fail('accepted recovery journal is outside signed authority');
  }
  strictBase64(
    requestInput.value.signature,
    'accepted recovery owner signature',
    { exactBytes: 64 },
  );
}

function verifyPlan(args) {
  const planFile = option(args, '--plan');
  const trustManifestFile = option(args, '--trust-manifest');
  const provisionReceiptFile = option(args, '--provision-receipt');
  const plan = readJson(planFile, 512 * 1024);
  const allowExpiredRecovery = args.includes('--allow-expired-recovery');
  if (allowExpiredRecovery && !args.includes('--require-root-trust')) {
    fail('expired plan verification is restricted to root-pinned recovery');
  }
  validatePlan(plan.value, { allowExpired: allowExpiredRecovery });
  validateRootTrustIdentity(
    trustManifestFile,
    provisionReceiptFile,
    args.includes('--require-root-trust'),
  );
  const trustManifest = readJson(trustManifestFile, 256 * 1024);
  const provisionReceipt = readJson(provisionReceiptFile, 256 * 1024);
  validateTrustBinding(plan.value, trustManifest, provisionReceipt);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: PLAN_VERIFICATION_SCHEMA,
    planId: plan.value.planId,
    planSha256: planSha256(plan.value),
    trustManifestSha256: plan.value.trust.trustManifestSha256,
    provisionReceiptSha256: plan.value.trust.provisionReceiptSha256,
    provisionSetId: plan.value.trust.provisionSetId,
    lifetimeActive:
      Date.parse(plan.value.createdAt) <= nowMs() + 60_000
      && Date.parse(plan.value.expiresAt) >= nowMs(),
  })}\n`);
}

function verifyEnvelope(args) {
  const input = readJson(option(args, '--input'), 1024 * 1024);
  const trustManifestFile = option(args, '--trust-manifest');
  const provisionReceiptFile = option(args, '--provision-receipt');
  const hasRecoveryJournal = args.includes('--accepted-recovery-journal');
  const hasRecoveryRequest = args.includes('--accepted-request-envelope');
  if (hasRecoveryJournal !== hasRecoveryRequest) {
    fail('accepted recovery requires the journal and exact request envelope');
  }
  if (hasRecoveryJournal && args.includes('--allow-expired')) {
    fail('accepted recovery and general expiry modes are mutually exclusive');
  }
  validateRootTrustIdentity(
    trustManifestFile,
    provisionReceiptFile,
    args.includes('--require-root-trust'),
  );
  const trustManifest = readJson(trustManifestFile);
  const provisionReceipt = readJson(provisionReceiptFile);
  exactKeys(
    input.value,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'],
    'layout fault drill envelope',
  );
  if (input.value.schema !== 'nexus.release-layout-fault-drill-envelope.v1') {
    fail('layout fault drill envelope schema is invalid');
  }
  const drill = validateDrillPayload(input.value.payload, {
    allowExpired: hasRecoveryJournal || args.includes('--allow-expired'),
  });
  if (hasRecoveryJournal) {
    validateAcceptedRecovery(
      option(args, '--accepted-recovery-journal'),
      option(args, '--accepted-request-envelope'),
      input,
      drill,
    );
  }
  validateTrustBinding(drill.plan, trustManifest, provisionReceipt);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: PROOF_SCHEMA,
    migrationId: drill.migrationId,
    planSha256: drill.planSha256,
    trustManifestSha256: drill.plan.trust.trustManifestSha256,
    provisionReceiptSha256: drill.plan.trust.provisionReceiptSha256,
    provisionSetId: drill.plan.trust.provisionSetId,
    maximumRecoverySeconds: drill.maximumRecoverySeconds,
    signerKeyDigests: {
      hypervisor: publicKeySha256(
        drill.plan.trust.hypervisorEd25519PublicKey,
      ),
      guests: Object.fromEntries(SCENARIOS.map((scenarioId) => [
        scenarioId,
        publicKeySha256(
          drill.plan.trust.guestEd25519PublicKeys[scenarioId],
        ),
      ])),
    },
  })}\n`);
}

try {
  const args = process.argv.slice(2);
  const command = args.shift() ?? '';
  if (command === 'prepare') prepare(args);
  else if (command === 'collect') collect(args);
  else if (command === 'verify-result') verifyResult(args);
  else if (command === 'verify-drill') verifyDrill(args);
  else if (command === 'verify-plan') verifyPlan(args);
  else if (command === 'verify-envelope') verifyEnvelope(args);
  else if (command === 'version') process.stdout.write(`${VERSION}\n`);
  else fail(
    'expected prepare, collect, verify-result, verify-drill, verify-plan, '
    + 'verify-envelope, or version',
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
