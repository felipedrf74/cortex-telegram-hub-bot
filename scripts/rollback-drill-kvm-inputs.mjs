#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DRILL_NAMES,
  SCHEMAS,
  canonicalJson,
  canonicalJsonBuffer,
  publicKeyIdentity,
  readBoundedJson,
  readBoundedText,
  sha256Bytes,
  sha256Json,
  textKeyIdentity,
  validateIsolationEvidence,
  validateOwnerAuthorization,
  validatePlan,
} from './lib/rollback-drill-kvm-evidence.mjs';

const SPEC_SCHEMA = 'nexus.rollback-drill-kvm-input-spec.v1';
const OBSERVATION_SCHEMA = 'nexus.rollback-drill-kvm-isolation-observation.v1';
const GENERATION_SCHEMA = 'nexus.rollback-drill-kvm-input-generation.v1';
const AUTHORIZATION_MANIFEST_SCHEMA =
  'nexus.rollback-drill-kvm-authorization-generation.v1';
const RUNTIME_AUTHORIZATION_SCHEMA =
  'nexus.rollback-drill-vm-runtime-authorization.v1';
const RUNTIME_READINESS_SCHEMA =
  'nexus.rollback-drill-vm-runtime-readiness.v2';
const PROMOTION_REQUEST_SCHEMA = 'nexus.promotion-transaction-request.v1';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/u;
const SAFE_BACKUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9]{1,64}$/u;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRANSACTION_ID =
  /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9a-f]{12}$/u;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_PLAN_LIFETIME_HOURS = 7 * 24;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const DRILL_BINDINGS = Object.freeze([
  {
    drill: 'ssh-loss',
    guest: 'guest-1',
    runtimeDrill: 'ssh-disconnect-after-pm2-stop',
  },
  {
    drill: 'failed-health',
    guest: 'guest-2',
    runtimeDrill: 'failed-health-check',
  },
  {
    drill: 'guest-reboot',
    guest: 'guest-3',
    runtimeDrill: 'host-reboot-during-promotion',
  },
]);

const REQUIRED_PM2_APPS = Object.freeze([
  'nexus-hub',
  'content-engine',
  'nexus-hub-staging',
  'content-engine-staging',
]);

const REQUIRED_LISTENERS = Object.freeze([
  { host: '127.0.0.1', port: 8200, process: 'nexus-hub' },
  { host: '127.0.0.1', port: 8100, process: 'content-engine' },
  { host: '127.0.0.1', port: 8201, process: 'nexus-hub-staging' },
  { host: '127.0.0.1', port: 8101, process: 'content-engine-staging' },
]);

const INTERFACES = Object.freeze({
  promotionControl: '/usr/local/sbin/nexus-release-promotion-control',
  restoreDrill:
    '/usr/local/libexec/nexus-application-dr/application-dr-restore-drill.sh',
  promotionAuthorization:
    '/usr/local/libexec/nexus-promotion-authorization.mjs',
  controlVersion: 'nexus-release-promotion-control.v3',
  recoveryUnit: 'nexus-release-promotion-recovery.service',
});

class InputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new InputError(code);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_object_invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
      || actual.some((field, index) => field !== expected[index])) {
    fail(`${label}_fields_invalid`);
  }
  return value;
}

function requireString(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}

function requireDigest(value, code) {
  return requireString(value, DIGEST, code);
}

function requireInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function requireBoolean(value, expected, code) {
  if (typeof value !== 'boolean'
      || (expected !== undefined && value !== expected)) {
    fail(code);
  }
  return value;
}

function requireArray(value, minimum, maximum, code) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(code);
  }
  return value;
}

function parseIso(value, code) {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) fail(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(code);
  return parsed;
}

function nowMs() {
  const override = process.env.NEXUS_ROLLBACK_DRILL_INPUTS_TEST_NOW;
  if (override && process.env.NODE_ENV === 'test') {
    const parsed = Number(override);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) fail('test_now_invalid');
    return parsed;
  }
  return Date.now();
}

function isoSeconds(milliseconds) {
  return new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace('.000Z', 'Z');
}

function compactTimestamp(milliseconds) {
  return isoSeconds(milliseconds).replace(/[-:]/gu, '');
}

function rawFileSha256(file) {
  return sha256Bytes(readRegularFile(file, 'digest_input'));
}

function readRegularFile(file, label, maximum = MAX_INPUT_BYTES) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.size <= 0 || stat.size > maximum) {
    fail(`${label}_file_invalid`);
  }
  return fs.readFileSync(resolved);
}

function resolveSpecPath(specPath, candidate, label) {
  if (typeof candidate !== 'string' || candidate.length === 0
      || candidate.includes('__REQUIRED__')) {
    fail(`${label}_path_invalid`);
  }
  return path.resolve(path.dirname(path.resolve(specPath)), candidate);
}

function parentForNewPath(requested, label) {
  const resolved = path.resolve(requested);
  const parentRequested = path.dirname(resolved);
  const parentStat = fs.lstatSync(parentRequested, { throwIfNoEntry: false });
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail(`${label}_parent_invalid`);
  }
  const parent = fs.realpathSync(parentRequested);
  if (path.dirname(resolved) !== parent) fail(`${label}_parent_not_canonical`);
  return { parent, resolved };
}

function createOutputDirectory(requested) {
  const { parent, resolved } = parentForNewPath(requested, 'output_directory');
  if (fs.lstatSync(resolved, { throwIfNoEntry: false })) {
    fail('output_directory_exists');
  }
  fs.mkdirSync(resolved, { mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  fsyncDirectory(parent);
  return resolved;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeNewFile(file, body, mode = 0o600) {
  const descriptor = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, mode);
}

function publishSingleFile(requested, body) {
  const { parent, resolved } = parentForNewPath(requested, 'output_file');
  if (fs.lstatSync(resolved, { throwIfNoEntry: false })) fail('output_file_exists');
  writeNewFile(resolved, body);
  fsyncDirectory(parent);
  return resolved;
}

function jsonBody(value, { canonical = true, trailingNewline = true } = {}) {
  if (canonical) {
    const body = canonicalJson(value);
    return Buffer.from(trailingNewline ? `${body}\n` : body, 'utf8');
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validateSpec(spec, specPath) {
  exactObject(spec, [
    'schema',
    'planLifetimeHours',
    'provisionReceipt',
    'controller',
    'release',
    'keys',
    'labStorage',
    'syntheticDatabase',
    'runtimeBundleManifests',
    'releaseEvidence',
    'migration',
  ], 'spec');
  if (spec.schema !== SPEC_SCHEMA) fail('spec_schema_unsupported');
  requireInteger(
    spec.planLifetimeHours,
    1,
    MAX_PLAN_LIFETIME_HOURS,
    'spec_plan_lifetime_invalid',
  );
  resolveSpecPath(specPath, spec.provisionReceipt, 'provision_receipt');

  exactObject(spec.controller, ['machineIdFile', 'bootIdFile'], 'spec_controller');
  resolveSpecPath(specPath, spec.controller.machineIdFile, 'controller_machine_id');
  resolveSpecPath(specPath, spec.controller.bootIdFile, 'controller_boot_id');

  exactObject(spec.release, [
    'sourceSha',
    'targetSha',
    'sourceVersion',
    'targetVersion',
    'targetBackup',
    'preparedRuntimeToken',
    'publicBaseUrl',
    'predecessor',
    'target',
  ], 'spec_release');
  requireString(spec.release.sourceSha, FULL_SHA, 'spec_source_sha_invalid');
  requireString(spec.release.targetSha, FULL_SHA, 'spec_target_sha_invalid');
  if (spec.release.sourceSha === spec.release.targetSha) {
    fail('spec_release_sha_not_distinct');
  }
  requireString(spec.release.sourceVersion, VERSION, 'spec_source_version_invalid');
  requireString(spec.release.targetVersion, VERSION, 'spec_target_version_invalid');
  requireString(spec.release.targetBackup, SAFE_BACKUP, 'spec_target_backup_invalid');
  requireString(
    spec.release.preparedRuntimeToken,
    SAFE_TOKEN,
    'spec_prepared_runtime_token_invalid',
  );
  let publicUrl;
  try {
    publicUrl = new URL(spec.release.publicBaseUrl);
  } catch {
    fail('spec_public_url_invalid');
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    fail('spec_public_url_invalid');
  }
  exactObject(spec.release.predecessor, [
    'runtime',
    'artifactDigest',
    'installedRuntimeDigest',
  ], 'spec_predecessor');
  exactObject(spec.release.target, [
    'runtime',
    'artifactDigest',
    'installedRuntimeDigest',
    'recoveryRuntimeDigest',
  ], 'spec_target');
  for (const [label, runtime] of [
    ['predecessor', spec.release.predecessor],
    ['target', spec.release.target],
  ]) {
    if (!/^\/srv\/nexus-release\/production\/releases\/[A-Za-z0-9._-]+$/u.test(
      runtime.runtime,
    )) {
      fail(`spec_${label}_runtime_invalid`);
    }
    requireDigest(runtime.artifactDigest, `spec_${label}_artifact_invalid`);
    requireDigest(
      runtime.installedRuntimeDigest,
      `spec_${label}_installed_runtime_invalid`,
    );
  }
  requireDigest(
    spec.release.target.recoveryRuntimeDigest,
    'spec_target_recovery_runtime_invalid',
  );

  exactObject(spec.keys, [
    'guestOwnerPublicKey',
    'productionOwnerPublicKey',
    'guestSshClientPublicKey',
    'productionSshClientPublicKey',
    'guestSshHostPublicKey',
    'productionSshHostPublicKey',
    'releaseEvidencePublicKey',
  ], 'spec_keys');
  for (const [field, candidate] of Object.entries(spec.keys)) {
    resolveSpecPath(specPath, candidate, `key_${field}`);
  }

  exactObject(spec.labStorage, ['provider', 'endpoint', 'bucket'], 'spec_lab_storage');
  if (!['cloudflare-r2', 'aws-s3-lab'].includes(spec.labStorage.provider)) {
    fail('spec_lab_storage_provider_invalid');
  }
  let endpoint;
  try {
    endpoint = new URL(spec.labStorage.endpoint);
  } catch {
    fail('spec_lab_storage_endpoint_invalid');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    fail('spec_lab_storage_endpoint_invalid');
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/u.test(spec.labStorage.bucket)) {
    fail('spec_lab_storage_bucket_invalid');
  }

  exactObject(spec.syntheticDatabase, ['path', 'seedFile'], 'spec_synthetic_database');
  if (!/^\/srv\/nexus-drill-lab\/[A-Za-z0-9._/-]+\.db$/u.test(
    spec.syntheticDatabase.path,
  )) {
    fail('spec_synthetic_database_path_invalid');
  }
  resolveSpecPath(specPath, spec.syntheticDatabase.seedFile, 'synthetic_seed');

  exactObject(
    spec.runtimeBundleManifests,
    DRILL_NAMES,
    'spec_runtime_bundle_manifests',
  );
  for (const drill of DRILL_NAMES) {
    resolveSpecPath(
      specPath,
      spec.runtimeBundleManifests[drill],
      `runtime_bundle_${drill}`,
    );
  }

  exactObject(
    spec.releaseEvidence,
    ['releaseManifest', 'stagingAttestation'],
    'spec_release_evidence',
  );
  resolveSpecPath(
    specPath,
    spec.releaseEvidence.releaseManifest,
    'release_manifest',
  );
  resolveSpecPath(
    specPath,
    spec.releaseEvidence.stagingAttestation,
    'staging_attestation',
  );

  const migrationFields = [
    'required',
    'reviewEvidenceSha256',
    'policySubjectSha256',
    'onlineEvidenceSha256',
    'onlineCloneSha256',
    'onlineMigratedCloneSha256',
    'onlinePendingSetSha256',
    'onlineSourceDatabaseSha256',
  ];
  exactObject(spec.migration, migrationFields, 'spec_migration');
  requireBoolean(spec.migration.required, undefined, 'spec_migration_required_invalid');
  for (const field of migrationFields.slice(1)) {
    if (spec.migration.required) {
      requireDigest(spec.migration[field], `spec_migration_${field}_invalid`);
    } else if (spec.migration[field] !== null) {
      fail(`spec_migration_${field}_must_be_null`);
    }
  }
  return spec;
}

function readSpec(specPath) {
  return validateSpec(readBoundedJson(specPath, 'rollback_drill_input_spec'), specPath);
}

function validateProvision(receipt) {
  exactObject(receipt, [
    'schema',
    'setId',
    'image',
    'sshPublicKeySha256',
    'guestSshHostPublicKeySha256',
    'ports',
    'setDirectory',
    'runtimeReadiness',
    'hypervisor',
    'guests',
    'createdAt',
  ], 'provision');
  if (receipt.schema !== 'nexus.rollback-drill-vm-provision.v1') {
    fail('provision_schema_unsupported');
  }
  requireDigest(receipt.image?.sha256, 'provision_image_digest_invalid');
  requireDigest(receipt.sshPublicKeySha256, 'provision_ssh_client_digest_invalid');
  requireDigest(
    receipt.guestSshHostPublicKeySha256,
    'provision_ssh_host_digest_invalid',
  );
  requireArray(receipt.ports, 3, 3, 'provision_ports_invalid');
  requireArray(receipt.guests, 3, 3, 'provision_guests_invalid');
  if (new Set(receipt.ports).size !== 3) fail('provision_ports_reused');
  receipt.guests.forEach((guest, index) => {
    exactObject(guest, [
      'name',
      'port',
      'unit',
      'uuid',
      'mac',
      'instanceId',
      'overlayPath',
      'overlayInitialSha256',
      'seedPath',
      'seedSha256',
      'hostPublicKey',
      'hostKeyFingerprint',
    ], `provision_guest_${index + 1}`);
    const expectedName = `guest-${index + 1}`;
    if (guest.name !== expectedName
        || guest.port !== receipt.ports[index]
        || guest.unit !== `nexus-rollback-drill-vm@${expectedName}.service`) {
      fail('provision_guest_order_invalid');
    }
    requireInteger(guest.port, 1024, 65535, 'provision_guest_port_invalid');
    requireString(guest.uuid, UUID, 'provision_guest_uuid_invalid');
    requireDigest(
      guest.overlayInitialSha256,
      'provision_overlay_initial_digest_invalid',
    );
    requireDigest(guest.seedSha256, 'provision_seed_digest_invalid');
    if (textKeyIdentity(guest.hostPublicKey)
        !== receipt.guestSshHostPublicKeySha256) {
      fail('provision_guest_host_key_mismatch');
    }
  });
  if (new Set(receipt.guests.map((guest) => guest.overlayInitialSha256)).size !== 3
      || new Set(receipt.guests.map((guest) => guest.uuid)).size !== 3) {
    fail('provision_guest_identity_reused');
  }
  return receipt;
}

function loadKeys(spec, specPath) {
  return {
    guestOwnerPublicKeyPem: readBoundedText(
      resolveSpecPath(specPath, spec.keys.guestOwnerPublicKey, 'guest_owner_key'),
      'guest_owner_key',
      16 * 1024,
    ),
    productionOwnerPublicKeyPem: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.productionOwnerPublicKey,
        'production_owner_key',
      ),
      'production_owner_key',
      16 * 1024,
    ),
    guestSshClientPublicKey: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.guestSshClientPublicKey,
        'guest_ssh_client_key',
      ),
      'guest_ssh_client_key',
      16 * 1024,
    ),
    productionSshClientPublicKey: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.productionSshClientPublicKey,
        'production_ssh_client_key',
      ),
      'production_ssh_client_key',
      16 * 1024,
    ),
    guestSshHostPublicKey: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.guestSshHostPublicKey,
        'guest_ssh_host_key',
      ),
      'guest_ssh_host_key',
      16 * 1024,
    ),
    productionSshHostPublicKey: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.productionSshHostPublicKey,
        'production_ssh_host_key',
      ),
      'production_ssh_host_key',
      16 * 1024,
    ),
    releaseEvidencePublicKeyPem: readBoundedText(
      resolveSpecPath(
        specPath,
        spec.keys.releaseEvidencePublicKey,
        'release_evidence_key',
      ),
      'release_evidence_key',
      16 * 1024,
    ),
  };
}

function keyIdentities(keys) {
  const identities = {
    guestOwnerPublicKeySha256:
      publicKeyIdentity(keys.guestOwnerPublicKeyPem),
    productionOwnerPublicKeySha256:
      publicKeyIdentity(keys.productionOwnerPublicKeyPem),
    guestSshClientPublicKeySha256:
      textKeyIdentity(keys.guestSshClientPublicKey),
    productionSshClientPublicKeySha256:
      textKeyIdentity(keys.productionSshClientPublicKey),
    guestSshHostPublicKeySha256:
      textKeyIdentity(keys.guestSshHostPublicKey),
    productionSshHostPublicKeySha256:
      textKeyIdentity(keys.productionSshHostPublicKey),
    releaseEvidencePublicKeySha256:
      publicKeyIdentity(keys.releaseEvidencePublicKeyPem),
  };
  if (identities.guestOwnerPublicKeySha256
      === identities.productionOwnerPublicKeySha256) {
    fail('production_owner_key_reuse');
  }
  if (identities.guestSshClientPublicKeySha256
      === identities.productionSshClientPublicKeySha256) {
    fail('production_ssh_client_key_reuse');
  }
  if (identities.guestSshHostPublicKeySha256
      === identities.productionSshHostPublicKeySha256) {
    fail('production_ssh_host_key_reuse');
  }
  return identities;
}

function readIdentityFile(specPath, candidate, label) {
  const file = resolveSpecPath(specPath, candidate, label);
  const value = readBoundedText(file, label, 4096).trim();
  if (!value || /\s/u.test(value)) fail(`${label}_invalid`);
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

function buildPlan(spec, specPath, receipt, keys, issuedAt) {
  const identities = keyIdentities(keys);
  if (identities.guestSshClientPublicKeySha256
      !== receipt.sshPublicKeySha256) {
    fail('provision_guest_ssh_client_key_mismatch');
  }
  if (identities.guestSshHostPublicKeySha256
      !== receipt.guestSshHostPublicKeySha256) {
    fail('provision_guest_ssh_host_key_mismatch');
  }
  const provisionPath = resolveSpecPath(
    specPath,
    spec.provisionReceipt,
    'provision_receipt',
  );
  const provisionSha256 = rawFileSha256(provisionPath);
  const suffix = sha256Bytes(Buffer.from(
    `${provisionSha256}:${spec.release.targetSha}:${issuedAt}`,
    'utf8',
  )).slice(0, 12);
  const planId = `kvm-drill-${compactTimestamp(issuedAt)}-${suffix}`;
  const createdAt = isoSeconds(issuedAt);
  const expiresAt = isoSeconds(
    issuedAt + spec.planLifetimeHours * 60 * 60 * 1000,
  );
  const plan = {
    schema: SCHEMAS.plan,
    planId,
    createdAt,
    expiresAt,
    mode: 'isolated-kvm-first-drill',
    sourceRootSha: spec.release.targetSha,
    controller: {
      machineIdSha256: readIdentityFile(
        specPath,
        spec.controller.machineIdFile,
        'controller_machine_id',
      ),
      bootIdSha256: readIdentityFile(
        specPath,
        spec.controller.bootIdFile,
        'controller_boot_id',
      ),
    },
    release: {
      sourceSha: spec.release.sourceSha,
      targetSha: spec.release.targetSha,
      sourceVersion: spec.release.sourceVersion,
      targetVersion: spec.release.targetVersion,
      targetBackup: spec.release.targetBackup,
      productionBase: '/srv/nexus-release/production',
      stateRoot: '/var/lib/nexus-release-promotion',
      backupDir: '/home/dominguez/backups/nexushub',
      preparedRuntimeDir:
        `/home/dominguez/backups/nexushub/.runtime-stage-${spec.release.preparedRuntimeToken}`,
      pm2Bin: '/usr/local/bin/pm2',
      publicBaseUrl: spec.release.publicBaseUrl,
    },
    guest: {
      virtualization: 'kvm',
      osId: 'ubuntu',
      osVersionId: '24.04',
      architecture: 'x86_64',
      minimumMemoryAvailableBytes: 12 * 1024 ** 3,
      minimumDiskAvailableBytes: 20 * 1024 ** 3,
      requiredPm2Apps: [...REQUIRED_PM2_APPS],
    },
    trust: identities,
    labStorage: {
      provider: spec.labStorage.provider,
      isolation: 'guest-drill-only',
      endpoint: spec.labStorage.endpoint,
      bucket: spec.labStorage.bucket,
      prefix: `nexus-rollback-drill/${planId}`,
      credentialsScope: 'guest-drill-only',
      syntheticOnly: true,
      productionObjectsAccessible: false,
      versioningEnabled: true,
      encryptionRequired: true,
    },
    syntheticDatabase: {
      path: spec.syntheticDatabase.path,
      marker: `NEXUS_SYNTHETIC_DRILL:${planId}`,
      seedSha256: rawFileSha256(resolveSpecPath(
        specPath,
        spec.syntheticDatabase.seedFile,
        'synthetic_seed',
      )),
      origin: 'generated-in-guest',
      syntheticOnly: true,
      productionRowsPresent: false,
    },
    overlays: DRILL_BINDINGS.map((binding, index) => {
      const guest = receipt.guests[index];
      return {
        drill: binding.drill,
        overlayId: `overlay-${binding.drill}-${sha256Bytes(Buffer.from(
          `${receipt.setId}:${guest.name}:${binding.drill}`,
          'utf8',
        )).slice(0, 12)}`,
        overlayInitialSha256: guest.overlayInitialSha256,
        baselineSnapshotSha256: receipt.image.sha256,
        machineUuid: guest.uuid,
        ssh: {
          host: '127.0.0.1',
          port: guest.port,
          user: 'dominguez',
          hostPublicKeySha256: identities.guestSshHostPublicKeySha256,
        },
      };
    }),
    interfaces: { ...INTERFACES },
  };
  validatePlan(plan, { nowMs: issuedAt });
  return { plan, provisionSha256 };
}

function buildRuntimeAuthorizations(
  spec,
  specPath,
  plan,
  receipt,
  provisionSha256,
  issuedAt,
) {
  const expiresAt = isoSeconds(Math.min(
    issuedAt + 24 * 60 * 60 * 1000,
    Date.parse(plan.expiresAt),
  ));
  return DRILL_BINDINGS.map((binding, index) => {
    const guest = receipt.guests[index];
    const bundleManifestPath = resolveSpecPath(
      specPath,
      spec.runtimeBundleManifests[binding.drill],
      `runtime_bundle_${binding.drill}`,
    );
    const bundleManifestSha256 = rawFileSha256(bundleManifestPath);
    const payload = {
      schema: RUNTIME_AUTHORIZATION_SCHEMA,
      authorizationId: sha256Bytes(Buffer.from(
        `${plan.planId}:${binding.guest}:${bundleManifestSha256}:${issuedAt}`,
        'utf8',
      )),
      issuedAt: isoSeconds(issuedAt),
      expiresAt,
      operation: 'collect-runtime-readiness',
      drill: binding.runtimeDrill,
      setId: receipt.setId,
      guest: binding.guest,
      port: guest.port,
      provisionReceiptSha256: provisionSha256,
      bundleManifestSha256,
      guestSshHostPublicKeySha256:
        plan.trust.guestSshHostPublicKeySha256,
      ownerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    };
    return { ...binding, bundleManifestSha256, payload };
  });
}

function observationTemplate(plan) {
  return {
    schema: OBSERVATION_SCHEMA,
    planId: plan.planId,
    capturedAt: '__MEASUREMENT_REQUIRED_ISO_UTC__',
    guests: DRILL_BINDINGS.map((binding) => ({
      guest: binding.guest,
      drill: binding.drill,
      readinessReceiptSha256: '__MEASUREMENT_REQUIRED_64_HEX__',
      machineIdSha256: '__MEASUREMENT_REQUIRED_64_HEX__',
      readinessBootIdSha256: '__MEASUREMENT_REQUIRED_64_HEX__',
    })),
    representativeGuest: {
      guest: 'guest-1',
      memoryAvailableBytes: 0,
      diskAvailableBytes: 0,
      kernelLogReadable: null,
      mounts: [
        {
          target: '__MEASUREMENT_REQUIRED__',
          source: '__MEASUREMENT_REQUIRED__',
          fileSystemType: '__MEASUREMENT_REQUIRED__',
          options: [],
        },
      ],
      listeners: REQUIRED_LISTENERS.map((listener) => ({
        ...listener,
        process: `__MEASUREMENT_REQUIRED_${listener.process}__`,
      })),
      pm2Apps: REQUIRED_PM2_APPS.map((name) => ({
        name,
        status: '__MEASUREMENT_REQUIRED__',
        restartCount: -1,
      })),
      syntheticDatabase: {
        path: plan.syntheticDatabase.path,
        marker: plan.syntheticDatabase.marker,
        seedSha256: plan.syntheticDatabase.seedSha256,
        syntheticOnly: null,
        productionRowsPresent: null,
      },
      productionDataMatches: ['__MEASUREMENT_REQUIRED_MUST_BE_EMPTY__'],
    },
  };
}

function templateSpec() {
  const required = '__REQUIRED__';
  return {
    schema: SPEC_SCHEMA,
    planLifetimeHours: 24,
    provisionReceipt: required,
    controller: {
      machineIdFile: '/etc/machine-id',
      bootIdFile: '/proc/sys/kernel/random/boot_id',
    },
    release: {
      sourceSha: `${required}_40_HEX`,
      targetSha: `${required}_40_HEX`,
      sourceVersion: `${required}_SEMVER`,
      targetVersion: `${required}_SEMVER`,
      targetBackup: `${required}_SAFE_BACKUP_NAME`,
      preparedRuntimeToken: `${required}_ALPHANUMERIC`,
      publicBaseUrl: `https://${required}.invalid`,
      predecessor: {
        runtime: `/srv/nexus-release/production/releases/${required}`,
        artifactDigest: `${required}_64_HEX`,
        installedRuntimeDigest: `${required}_64_HEX`,
      },
      target: {
        runtime: `/srv/nexus-release/production/releases/${required}`,
        artifactDigest: `${required}_64_HEX`,
        installedRuntimeDigest: `${required}_64_HEX`,
        recoveryRuntimeDigest: `${required}_64_HEX`,
      },
    },
    keys: {
      guestOwnerPublicKey: required,
      productionOwnerPublicKey: required,
      guestSshClientPublicKey: required,
      productionSshClientPublicKey: required,
      guestSshHostPublicKey: required,
      productionSshHostPublicKey: required,
      releaseEvidencePublicKey: required,
    },
    labStorage: {
      provider: 'aws-s3-lab',
      endpoint: `https://${required}.invalid`,
      bucket: `${required}-lab-bucket`,
    },
    syntheticDatabase: {
      path: '/srv/nexus-drill-lab/data/synthetic.db',
      seedFile: required,
    },
    runtimeBundleManifests: {
      'ssh-loss': required,
      'failed-health': required,
      'guest-reboot': required,
    },
    releaseEvidence: {
      releaseManifest: required,
      stagingAttestation: required,
    },
    migration: {
      required: false,
      reviewEvidenceSha256: null,
      policySubjectSha256: null,
      onlineEvidenceSha256: null,
      onlineCloneSha256: null,
      onlineMigratedCloneSha256: null,
      onlinePendingSetSha256: null,
      onlineSourceDatabaseSha256: null,
    },
  };
}

function prepare(specPath, requestedOutputDirectory) {
  const issuedAt = nowMs();
  const spec = readSpec(specPath);
  const provisionPath = resolveSpecPath(
    specPath,
    spec.provisionReceipt,
    'provision_receipt',
  );
  const receipt = validateProvision(
    readBoundedJson(provisionPath, 'provision_receipt'),
  );
  const keys = loadKeys(spec, specPath);
  const { plan, provisionSha256 } = buildPlan(
    spec,
    specPath,
    receipt,
    keys,
    issuedAt,
  );
  const runtimeAuthorizations = buildRuntimeAuthorizations(
    spec,
    specPath,
    plan,
    receipt,
    provisionSha256,
    issuedAt,
  );
  const planBody = canonicalJsonBuffer(plan);
  const runtimeFiles = runtimeAuthorizations.map((entry) => ({
    drill: entry.drill,
    guest: entry.guest,
    runtimeDrill: entry.runtimeDrill,
    file: `runtime-authorizations/${entry.drill}.json`,
    payloadSha256: sha256Json(entry.payload),
    bundleManifestSha256: entry.bundleManifestSha256,
  }));
  const generation = {
    schema: GENERATION_SCHEMA,
    generatedAt: isoSeconds(issuedAt),
    executionMode: 'strictly-sequential',
    orderedDrills: [...DRILL_NAMES],
    specSha256: sha256Json(spec),
    provisionReceiptSha256: provisionSha256,
    planSha256: sha256Json(plan),
    runtimeAuthorizations: runtimeFiles,
    nextRequiredAction: 'owner-sign-runtime-authorizations-and-collect-readiness',
  };
  const output = createOutputDirectory(requestedOutputDirectory);
  const runtimeDirectory = path.join(output, 'runtime-authorizations');
  fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
  writeNewFile(path.join(output, 'plan.json'), planBody);
  for (const entry of runtimeAuthorizations) {
    writeNewFile(
      path.join(runtimeDirectory, `${entry.drill}.json`),
      jsonBody(entry.payload, { trailingNewline: false }),
    );
  }
  writeNewFile(
    path.join(output, 'isolation-observation.template.json'),
    jsonBody(observationTemplate(plan), { canonical: false }),
  );
  writeNewFile(
    path.join(output, 'generation-manifest.json'),
    canonicalJsonBuffer(generation),
  );
  fsyncDirectory(runtimeDirectory);
  fsyncDirectory(output);
  return {
    output,
    planId: plan.planId,
    planSha256: generation.planSha256,
    provisionReceiptSha256: provisionSha256,
    status: 'unsigned_runtime_authorizations_require_owner_signatures',
  };
}

function validateGenerationManifest(value, plan, provisionSha256) {
  exactObject(value, [
    'schema',
    'generatedAt',
    'executionMode',
    'orderedDrills',
    'specSha256',
    'provisionReceiptSha256',
    'planSha256',
    'runtimeAuthorizations',
    'nextRequiredAction',
  ], 'generation_manifest');
  if (value.schema !== GENERATION_SCHEMA
      || value.executionMode !== 'strictly-sequential'
      || value.nextRequiredAction
        !== 'owner-sign-runtime-authorizations-and-collect-readiness'
      || value.planSha256 !== sha256Json(plan)
      || value.provisionReceiptSha256 !== provisionSha256
      || JSON.stringify(value.orderedDrills) !== JSON.stringify(DRILL_NAMES)) {
    fail('generation_manifest_binding_invalid');
  }
  requireDigest(value.specSha256, 'generation_manifest_spec_digest_invalid');
  requireArray(
    value.runtimeAuthorizations,
    3,
    3,
    'generation_manifest_runtime_authorizations_invalid',
  );
  value.runtimeAuthorizations.forEach((entry, index) => {
    exactObject(entry, [
      'drill',
      'guest',
      'runtimeDrill',
      'file',
      'payloadSha256',
      'bundleManifestSha256',
    ], 'generation_manifest_runtime_authorization');
    const binding = DRILL_BINDINGS[index];
    if (entry.drill !== binding.drill || entry.guest !== binding.guest
        || entry.runtimeDrill !== binding.runtimeDrill) {
      fail('generation_manifest_runtime_authorization_order_invalid');
    }
    requireDigest(
      entry.payloadSha256,
      'generation_manifest_runtime_authorization_digest_invalid',
    );
    requireDigest(
      entry.bundleManifestSha256,
      'generation_manifest_bundle_digest_invalid',
    );
  });
  return value;
}

function validateReadiness(
  readiness,
  file,
  binding,
  receipt,
  provisionSha256,
  expectedBundleSha256,
) {
  if (readiness?.schema !== RUNTIME_READINESS_SCHEMA
      || readiness.status !== 'ready'
      || readiness.drillReady !== true
      || readiness.setId !== receipt.setId
      || readiness.guest !== binding.guest
      || readiness.port !== receipt.guests[DRILL_NAMES.indexOf(binding.drill)].port
      || readiness.provisionReceiptSha256 !== provisionSha256
      || readiness.bundleManifestSha256 !== expectedBundleSha256
      || readiness.networkInstallAttempted !== false) {
    fail(`readiness_binding_invalid:${binding.drill}`);
  }
  parseIso(readiness.sealedAt, `readiness_sealed_at_invalid:${binding.drill}`);
  const guest = receipt.guests[DRILL_NAMES.indexOf(binding.drill)];
  if (readiness.machine?.uuid !== guest.uuid
      || readiness.machine?.instanceId !== guest.instanceId
      || readiness.machine?.mac !== guest.mac
      || readiness.machine?.sshHostPublicKeySha256
        !== receipt.guestSshHostPublicKeySha256
      || readiness.overlay?.path !== guest.overlayPath
      || readiness.overlay?.initialSha256 !== guest.overlayInitialSha256
      || !DIGEST.test(readiness.overlay?.currentSha256 || '')
      || readiness.overlay?.stableDescriptor !== true
      || readiness.stoppedGuestProof?.qemuExited !== true
      || readiness.stoppedGuestProof?.overlayProcessAbsent !== true
      || readiness.ownerAuthorization?.drill !== binding.runtimeDrill) {
    fail(`readiness_identity_invalid:${binding.drill}`);
  }
  return rawFileSha256(file);
}

function validateObservation(value, plan, readinessDigests, currentTime) {
  exactObject(
    value,
    ['schema', 'planId', 'capturedAt', 'guests', 'representativeGuest'],
    'observation',
  );
  if (value.schema !== OBSERVATION_SCHEMA || value.planId !== plan.planId) {
    fail('observation_plan_binding_invalid');
  }
  const capturedAt = parseIso(value.capturedAt, 'observation_captured_at_invalid');
  if (capturedAt < Date.parse(plan.createdAt) - CLOCK_SKEW_MS
      || capturedAt > currentTime + CLOCK_SKEW_MS) {
    fail('observation_capture_time_invalid');
  }
  requireArray(value.guests, 3, 3, 'observation_guests_invalid');
  const machineIds = [];
  const bootIds = [];
  value.guests.forEach((guest, index) => {
    exactObject(guest, [
      'guest',
      'drill',
      'readinessReceiptSha256',
      'machineIdSha256',
      'readinessBootIdSha256',
    ], 'observation_guest');
    const binding = DRILL_BINDINGS[index];
    if (guest.guest !== binding.guest || guest.drill !== binding.drill
        || guest.readinessReceiptSha256 !== readinessDigests[index]) {
      fail('observation_guest_binding_invalid');
    }
    requireDigest(guest.machineIdSha256, 'observation_guest_machine_id_invalid');
    requireDigest(
      guest.readinessBootIdSha256,
      'observation_guest_boot_id_invalid',
    );
    if (guest.machineIdSha256 === plan.controller.machineIdSha256
        || guest.readinessBootIdSha256 === plan.controller.bootIdSha256
        || guest.machineIdSha256 === guest.readinessBootIdSha256) {
      fail('observation_guest_identity_invalid');
    }
    machineIds.push(guest.machineIdSha256);
    bootIds.push(guest.readinessBootIdSha256);
  });
  if (new Set(machineIds).size !== 3 || new Set(bootIds).size !== 3) {
    fail('observation_guest_identity_reused');
  }

  const guest = exactObject(value.representativeGuest, [
    'guest',
    'memoryAvailableBytes',
    'diskAvailableBytes',
    'kernelLogReadable',
    'mounts',
    'listeners',
    'pm2Apps',
    'syntheticDatabase',
    'productionDataMatches',
  ], 'observation_representative_guest');
  if (guest.guest !== 'guest-1') fail('observation_representative_guest_invalid');
  requireInteger(
    guest.memoryAvailableBytes,
    plan.guest.minimumMemoryAvailableBytes,
    1024 * 1024 ** 3,
    'observation_memory_below_threshold',
  );
  requireInteger(
    guest.diskAvailableBytes,
    plan.guest.minimumDiskAvailableBytes,
    100 * 1024 ** 4,
    'observation_disk_below_threshold',
  );
  requireBoolean(
    guest.kernelLogReadable,
    true,
    'observation_kernel_log_unreadable',
  );
  requireArray(guest.mounts, 1, 256, 'observation_mounts_invalid');
  requireArray(guest.listeners, 4, 64, 'observation_listeners_invalid');
  requireArray(guest.pm2Apps, 4, 4, 'observation_pm2_apps_invalid');
  requireArray(
    guest.productionDataMatches,
    0,
    0,
    'observation_production_data_detected',
  );
  exactObject(guest.syntheticDatabase, [
    'path',
    'marker',
    'seedSha256',
    'syntheticOnly',
    'productionRowsPresent',
  ], 'observation_synthetic_database');
  if (guest.syntheticDatabase.path !== plan.syntheticDatabase.path
      || guest.syntheticDatabase.marker !== plan.syntheticDatabase.marker
      || guest.syntheticDatabase.seedSha256 !== plan.syntheticDatabase.seedSha256
      || guest.syntheticDatabase.syntheticOnly !== true
      || guest.syntheticDatabase.productionRowsPresent !== false) {
    fail('observation_synthetic_database_invalid');
  }
  return value;
}

function buildIsolation(plan, receipt, observation) {
  const representative = observation.representativeGuest;
  const isolation = {
    schema: SCHEMAS.isolation,
    planId: plan.planId,
    capturedAt: observation.capturedAt,
    hypervisor: {
      machineIdSha256: plan.controller.machineIdSha256,
      bootIdSha256: plan.controller.bootIdSha256,
      virtualization: 'qemu-kvm',
      manager: 'qemu-systemd',
      devices: [
        {
          type: 'disk',
          source: receipt.guests[0].overlayPath,
          target: 'vda',
          mode: 'overlay',
        },
        {
          type: 'network',
          source: 'qemu-user-restrict',
          target: 'virtio',
          mode: 'user',
        },
      ],
    },
    guest: {
      machineIdSha256: observation.guests[0].machineIdSha256,
      bootIdSha256: observation.guests[0].readinessBootIdSha256,
      virtualization: 'kvm',
      osId: 'ubuntu',
      osVersionId: '24.04',
      architecture: 'x86_64',
      memoryAvailableBytes: representative.memoryAvailableBytes,
      diskAvailableBytes: representative.diskAvailableBytes,
      kernelLogReadable: representative.kernelLogReadable,
      mounts: representative.mounts,
      listeners: representative.listeners,
      pm2Apps: representative.pm2Apps,
      canonicalPaths: {
        productionBase: plan.release.productionBase,
        stateRoot: plan.release.stateRoot,
        backupDir: plan.release.backupDir,
        preparedRuntimeDir: plan.release.preparedRuntimeDir,
        pm2Bin: plan.release.pm2Bin,
      },
      keyIdentities: {
        ownerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
        sshClientPublicKeySha256: plan.trust.guestSshClientPublicKeySha256,
        sshHostPublicKeySha256: plan.trust.guestSshHostPublicKeySha256,
        releaseEvidencePublicKeySha256:
          plan.trust.releaseEvidencePublicKeySha256,
      },
      syntheticDatabase: representative.syntheticDatabase,
      productionDataMatches: representative.productionDataMatches,
    },
    overlays: plan.overlays.map((overlay, index) => ({
      drill: overlay.drill,
      overlayId: overlay.overlayId,
      overlayInitialSha256: overlay.overlayInitialSha256,
      baselineSnapshotSha256: overlay.baselineSnapshotSha256,
      machineUuid: overlay.machineUuid,
      sshHostPublicKeySha256: overlay.ssh.hostPublicKeySha256,
      guestMachineIdSha256: observation.guests[index].machineIdSha256,
      readinessBootIdSha256:
        observation.guests[index].readinessBootIdSha256,
    })),
  };
  validateIsolationEvidence(isolation, plan, {
    nowMs: Math.max(nowMs(), Date.parse(observation.capturedAt)),
  });
  return isolation;
}

function finalizeIsolation(flags) {
  const currentTime = nowMs();
  const plan = readBoundedJson(required(flags, '--plan'), 'plan');
  validatePlan(plan, { nowMs: currentTime, allowExpired: true });
  const provisionFile = required(flags, '--provision-receipt');
  const receipt = validateProvision(
    readBoundedJson(provisionFile, 'provision_receipt'),
  );
  const provisionSha256 = rawFileSha256(provisionFile);
  const generation = validateGenerationManifest(
    readBoundedJson(
      required(flags, '--generation-manifest'),
      'generation_manifest',
    ),
    plan,
    provisionSha256,
  );
  const readinessFiles = [
    required(flags, '--ssh-loss-readiness'),
    required(flags, '--failed-health-readiness'),
    required(flags, '--guest-reboot-readiness'),
  ];
  const readinessDigests = readinessFiles.map((file, index) => (
    validateReadiness(
      readBoundedJson(file, `readiness_${DRILL_NAMES[index]}`),
      file,
      DRILL_BINDINGS[index],
      receipt,
      provisionSha256,
      generation.runtimeAuthorizations[index].bundleManifestSha256,
    )
  ));
  const observation = validateObservation(
    readBoundedJson(required(flags, '--observation'), 'isolation_observation'),
    plan,
    readinessDigests,
    currentTime,
  );
  const isolation = buildIsolation(plan, receipt, observation);
  const output = publishSingleFile(
    required(flags, '--output'),
    canonicalJsonBuffer(isolation),
  );
  return {
    output,
    planId: plan.planId,
    isolationSha256: sha256Json(isolation),
    readinessReceiptSha256: readinessDigests,
  };
}

function assertPlanMatchesSpec(plan, spec) {
  validatePlan(plan);
  if (plan.release.sourceSha !== spec.release.sourceSha
      || plan.release.targetSha !== spec.release.targetSha
      || plan.release.sourceVersion !== spec.release.sourceVersion
      || plan.release.targetVersion !== spec.release.targetVersion
      || plan.release.targetBackup !== spec.release.targetBackup
      || plan.release.publicBaseUrl !== spec.release.publicBaseUrl
      || plan.release.preparedRuntimeDir
        !== `/home/dominguez/backups/nexushub/.runtime-stage-${spec.release.preparedRuntimeToken}`) {
    fail('authorization_spec_plan_mismatch');
  }
}

function buildPromotionRequest(spec, specPath, plan, issuedAt, index) {
  const binding = DRILL_BINDINGS[index];
  const timestamp = compactTimestamp(issuedAt);
  const transactionSuffix = sha256Bytes(Buffer.from(
    `${plan.planId}:${binding.drill}:${issuedAt}`,
    'utf8',
  )).slice(0, 12);
  const releaseManifest = readRegularFile(
    resolveSpecPath(
      specPath,
      spec.releaseEvidence.releaseManifest,
      'release_manifest',
    ),
    'release_manifest',
  );
  const stagingAttestation = readRegularFile(
    resolveSpecPath(
      specPath,
      spec.releaseEvidence.stagingAttestation,
      'staging_attestation',
    ),
    'staging_attestation',
  );
  const request = {
    schema: PROMOTION_REQUEST_SCHEMA,
    transactionId: `${timestamp}-${index + 1}-${transactionSuffix}`,
    createdAt: isoSeconds(issuedAt),
    expiresAt: isoSeconds(issuedAt + 30 * 60 * 1000),
    ownerAuthorization: 'explicit',
    productionBase: plan.release.productionBase,
    predecessor: {
      runtime: spec.release.predecessor.runtime,
      sha: plan.release.sourceSha,
      artifactDigest: spec.release.predecessor.artifactDigest,
      installedRuntimeDigest:
        spec.release.predecessor.installedRuntimeDigest,
    },
    target: {
      runtime: spec.release.target.runtime,
      sha: plan.release.targetSha,
      sentryRelease: plan.release.targetSha,
      artifactDigest: spec.release.target.artifactDigest,
      installedRuntimeDigest: spec.release.target.installedRuntimeDigest,
      recoveryRuntimeDigest: spec.release.target.recoveryRuntimeDigest,
      version: plan.release.targetVersion,
    },
    releaseEvidence: {
      releaseManifestBase64: releaseManifest.toString('base64'),
      releaseManifestSha256: sha256Bytes(releaseManifest),
      stagingAttestationBase64: stagingAttestation.toString('base64'),
      stagingAttestationSha256: sha256Bytes(stagingAttestation),
    },
    backupDir: plan.release.backupDir,
    preparedRuntimeDir: plan.release.preparedRuntimeDir,
    pm2Bin: plan.release.pm2Bin,
    publicBaseUrl: plan.release.publicBaseUrl,
    stabilitySeconds: 60,
    gateTimeoutSeconds: 60,
    migration: { ...spec.migration },
  };
  validatePromotionRequest(request, issuedAt);
  return request;
}

function validatePromotionRequest(request, currentTime) {
  if (request.schema !== PROMOTION_REQUEST_SCHEMA
      || !TRANSACTION_ID.test(request.transactionId)
      || request.ownerAuthorization !== 'explicit'
      || request.target.sentryRelease !== request.target.sha
      || request.stabilitySeconds !== 60
      || request.gateTimeoutSeconds !== 60) {
    fail('promotion_request_invalid');
  }
  const created = parseIso(request.createdAt, 'promotion_request_created_at_invalid');
  const expires = parseIso(request.expiresAt, 'promotion_request_expires_at_invalid');
  if (created > currentTime + CLOCK_SKEW_MS || expires <= created
      || expires - created > 30 * 60 * 1000) {
    fail('promotion_request_lifetime_invalid');
  }
  for (const [bytesField, digestField] of [
    ['releaseManifestBase64', 'releaseManifestSha256'],
    ['stagingAttestationBase64', 'stagingAttestationSha256'],
  ]) {
    const encoded = request.releaseEvidence[bytesField];
    const decoded = Buffer.from(encoded, 'base64');
    if (!encoded || decoded.toString('base64') !== encoded
        || sha256Bytes(decoded) !== request.releaseEvidence[digestField]) {
      fail('promotion_request_release_evidence_invalid');
    }
  }
}

function authorize(specPath, planPath, requestedOutputDirectory) {
  const issuedAt = nowMs();
  const spec = readSpec(specPath);
  const plan = readBoundedJson(planPath, 'plan');
  assertPlanMatchesSpec(plan, spec);
  const keys = loadKeys(spec, specPath);
  const identities = keyIdentities(keys);
  if (identities.guestOwnerPublicKeySha256
      !== plan.trust.guestOwnerPublicKeySha256) {
    fail('authorization_guest_owner_key_mismatch');
  }
  const authorizationExpiresAt = isoSeconds(Math.min(
    issuedAt + 24 * 60 * 60 * 1000,
    Date.parse(plan.expiresAt),
  ));
  if (Date.parse(authorizationExpiresAt) <= issuedAt) {
    fail('authorization_plan_expired');
  }
  const planAuthorization = {
    schema: SCHEMAS.authorizationPayload,
    action: 'run-isolated-kvm-rollback-drills',
    planId: plan.planId,
    planSha256: sha256Json(plan),
    targetSha: plan.release.targetSha,
    targetVersion: plan.release.targetVersion,
    guestOwnerPublicKeySha256: plan.trust.guestOwnerPublicKeySha256,
    endpoints: plan.overlays.map((overlay) => ({
      drill: overlay.drill,
      host: overlay.ssh.host,
      port: overlay.ssh.port,
      hostPublicKeySha256: overlay.ssh.hostPublicKeySha256,
    })),
    approvedAt: isoSeconds(issuedAt),
    expiresAt: authorizationExpiresAt,
  };
  const requests = DRILL_BINDINGS.map((_, index) => (
    buildPromotionRequest(spec, specPath, plan, issuedAt, index)
  ));
  const manifest = {
    schema: AUTHORIZATION_MANIFEST_SCHEMA,
    generatedAt: isoSeconds(issuedAt),
    executionMode: 'strictly-sequential',
    orderedDrills: [...DRILL_NAMES],
    planSha256: sha256Json(plan),
    planAuthorizationPayloadSha256: sha256Json(planAuthorization),
    promotionRequests: requests.map((request, index) => ({
      drill: DRILL_NAMES[index],
      file: `promotion-requests/${DRILL_NAMES[index]}.request.json`,
      transactionId: request.transactionId,
      payloadSha256: sha256Json(request),
    })),
    nextRequiredAction:
      'owner-sign-plan-authorization-and-each-promotion-request',
  };
  const output = createOutputDirectory(requestedOutputDirectory);
  const requestDirectory = path.join(output, 'promotion-requests');
  fs.mkdirSync(requestDirectory, { mode: 0o700 });
  writeNewFile(
    path.join(output, 'plan-owner-authorization.payload.json'),
    jsonBody(planAuthorization, { trailingNewline: false }),
  );
  requests.forEach((request, index) => {
    writeNewFile(
      path.join(
        requestDirectory,
        `${DRILL_NAMES[index]}.request.json`,
      ),
      jsonBody(request, { canonical: false }),
    );
  });
  writeNewFile(
    path.join(output, 'authorization-manifest.json'),
    canonicalJsonBuffer(manifest),
  );
  fsyncDirectory(requestDirectory);
  fsyncDirectory(output);
  return {
    output,
    planId: plan.planId,
    status: 'unsigned_authorizations_require_owner_signatures',
    requestExpiresAt: requests[0].expiresAt,
  };
}

function sealPlanAuthorization(flags) {
  const currentTime = nowMs();
  const plan = readBoundedJson(required(flags, '--plan'), 'plan');
  const payload = readBoundedJson(required(flags, '--payload'), 'plan_authorization_payload');
  const publicKey = readBoundedText(
    required(flags, '--guest-owner-public-key'),
    'guest_owner_public_key',
    16 * 1024,
  );
  const signature = readRegularFile(
    required(flags, '--signature'),
    'owner_authorization_signature',
    64,
  );
  if (signature.length !== 64) fail('owner_authorization_signature_length_invalid');
  const envelope = {
    schema: SCHEMAS.authorizationEnvelope,
    keyId: `sha256:${publicKeyIdentity(publicKey)}`,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: signature.toString('base64'),
  };
  validateOwnerAuthorization(envelope, plan, publicKey, { nowMs: currentTime });
  const output = publishSingleFile(
    required(flags, '--output'),
    canonicalJsonBuffer(envelope),
  );
  return {
    output,
    planId: plan.planId,
    envelopeSha256: sha256Json(envelope),
  };
}

const COMMAND_FLAGS = Object.freeze({
  template: new Set(['--output-dir']),
  prepare: new Set(['--spec', '--output-dir']),
  'finalize-isolation': new Set([
    '--plan',
    '--generation-manifest',
    '--provision-receipt',
    '--observation',
    '--ssh-loss-readiness',
    '--failed-health-readiness',
    '--guest-reboot-readiness',
    '--output',
  ]),
  authorize: new Set(['--spec', '--plan', '--output-dir']),
  'seal-plan-authorization': new Set([
    '--plan',
    '--payload',
    '--signature',
    '--guest-owner-public-key',
    '--output',
  ]),
});

function parseFlags(argv) {
  const command = argv.shift() || '';
  const allowed = COMMAND_FLAGS[command];
  if (!allowed) fail('command_unsupported');
  if (argv.length % 2 !== 0) fail('flag_value_missing');
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag)) fail(`flag_unsupported:${flag}`);
    if (!value || value.startsWith('--')) fail(`flag_value_missing:${flag}`);
    if (flags.has(flag)) fail(`flag_duplicate:${flag}`);
    flags.set(flag, value);
  }
  return { command, flags };
}

function required(flags, name) {
  const value = flags.get(name);
  if (!value) fail(`flag_required:${name}`);
  return value;
}

function main() {
  const { command, flags } = parseFlags(process.argv.slice(2));
  if (command === 'template') {
    const output = createOutputDirectory(required(flags, '--output-dir'));
    writeNewFile(
      path.join(output, 'input-spec.template.json'),
      jsonBody(templateSpec(), { canonical: false }),
    );
    fsyncDirectory(output);
    return { output, schema: SPEC_SCHEMA, status: 'required_values_unset' };
  }
  if (command === 'prepare') {
    return prepare(required(flags, '--spec'), required(flags, '--output-dir'));
  }
  if (command === 'finalize-isolation') return finalizeIsolation(flags);
  if (command === 'authorize') {
    return authorize(
      required(flags, '--spec'),
      required(flags, '--plan'),
      required(flags, '--output-dir'),
    );
  }
  if (command === 'seal-plan-authorization') {
    return sealPlanAuthorization(flags);
  }
  fail('command_unsupported');
}

try {
  process.stdout.write(`${JSON.stringify({ ok: true, ...main() }, null, 2)}\n`);
} catch (error) {
  const code = error instanceof InputError
    ? error.code
    : error?.constructor?.name === 'EvidenceError'
        ? error.code
        : error?.code && typeof error.code === 'string'
          ? `filesystem_${error.code.toLowerCase()}`
        : 'unexpected_error';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
}
