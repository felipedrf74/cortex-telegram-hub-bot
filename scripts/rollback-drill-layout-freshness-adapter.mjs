#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 'nexus-rollback-drill-layout-freshness-adapter.v1';
const MACHINE_EVIDENCE_SCHEMA =
  'nexus.rollback-drill-layout-machine-evidence.v1';
const RECOVERY_SET_SCHEMA =
  'nexus.rollback-drill-layout-recovery-set.v1';
const TARGET_BACKUP_SCHEMA =
  'nexus.release-layout-guest-target-backup.v1';
const ROLLBACK_PAYLOAD_SCHEMA = 'nexus.rollback-drill-payload.v1';
const LAYOUT_ENVELOPE_SCHEMA =
  'nexus.release-layout-fault-drill-envelope.v1';
const LAYOUT_OWNER_KEY_ID = 'nexus-owner-promotion-2026';
const PROTECTED_OWNER_PUBLIC_KEY_PATH =
  '/etc/nexus-release/owner-promotion-public-key.pem';
const RELEASE_MANIFEST_SCHEMA = 'nexus.release-manifest.v2';
const RELEASE_PAYLOAD_SCHEMA = 'nexus.release-manifest-payload.v2';
const RELEASE_KEY_ID = 'github-environment-release-signing-2026-07';
const RELEASE_ARTIFACT_SCHEMA = 'nexus.release-artifact-manifest.v1';
const DEEP_PROOF_SCHEMA = 'nexus.release-layout-kvm-proof.v1';
const GUEST_EVIDENCE_SCHEMA =
  'nexus.release-layout-guest-execution-evidence.v2';
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/u;
const OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u;
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DATABASE_BACKUP_BYTES = 32 * 1024;
const MAX_TARGET_BACKUP_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
const SCENARIOS = Object.freeze([
  'failed_health_check',
  'host_reboot_during_migration',
  'ssh_disconnect_after_pm2_stop',
]);
const toolingRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function fail(message) {
  throw new Error(`rollback drill layout freshness adapter: ${message}`);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function outputBytes(value) {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(canonicalJson(value), 'utf8');
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',')
        !== [...fields].sort().join(',')) {
    fail(`${label} fields are invalid`);
  }
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    fail(`missing ${name}`);
  }
  return args[index + 1];
}

function requiredOption(args, name) {
  const value = option(args, name);
  if (!value) fail(`missing ${name}`);
  return value;
}

function readSafeBytes(
  file,
  label,
  maximum = MAX_INPUT_BYTES,
  {
    exactMode,
    rootOwned = false,
  } = {},
) {
  const resolved = path.resolve(file);
  let descriptor;
  try {
    descriptor = fs.openSync(
      resolved,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    fail(`${label} is unavailable or unsafe`);
  }
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 2
        || before.size > maximum || (before.mode & 0o022) !== 0
        || (exactMode !== undefined
          && (before.mode & 0o7777) !== exactMode)
        || (rootOwned && (before.uid !== 0 || before.gid !== 0))) {
      fail(`${label} is not a bounded non-writable single-link regular file`);
    }
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || body.length !== after.size) {
      fail(`${label} changed while it was read`);
    }
    return { body, path: resolved };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readSafeJson(file, label, maximum = MAX_INPUT_BYTES) {
  const input = readSafeBytes(file, label, maximum);
  let value;
  try {
    value = JSON.parse(input.body.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { ...input, value };
}

function canonicalPublicKey(input, label) {
  let key;
  try {
    key = createPublicKey(input);
  } catch {
    fail(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail(`${label} must be an Ed25519 public key`);
  }
  return {
    key,
    der: key.export({ type: 'spki', format: 'der' }),
    pem: key.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function strictSignature(value, label) {
  if (typeof value !== 'string'
      || value.length !== 88
      || !/^[A-Za-z0-9+/]{86}==$/u.test(value)) {
    fail(`${label} is not canonical Ed25519 base64`);
  }
  const body = Buffer.from(value, 'base64');
  if (body.length !== 64 || body.toString('base64') !== value) {
    fail(`${label} is not canonical Ed25519 base64`);
  }
  return body;
}

function validateSqliteBackup(body, scenarioId) {
  const header = Buffer.from('SQLite format 3\0', 'binary');
  if (body.length < 512
      || !body.subarray(0, header.length).equals(header)) {
    fail(`layout ${scenarioId} database backup is not SQLite`);
  }
  const encodedPageSize = body.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  const pageCount = body.readUInt32BE(28);
  if (pageSize < 512 || pageSize > 65_536
      || (pageSize & (pageSize - 1)) !== 0
      || pageCount < 1 || pageCount * pageSize !== body.length) {
    fail(`layout ${scenarioId} database backup SQLite layout is invalid`);
  }
}

function canonicalBase64(value, label, maximum) {
  if (typeof value !== 'string' || value.length < 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    fail(`${label} is not canonical base64`);
  }
  const body = Buffer.from(value, 'base64');
  if (body.length < 1 || body.length > maximum
      || body.toString('base64') !== value) {
    fail(`${label} size or encoding is invalid`);
  }
  return body;
}

function validateTargetBackup(body, source, scenarioId) {
  if (body.length < 2 || body.length > MAX_TARGET_BACKUP_BYTES) {
    fail(`layout ${scenarioId} target backup size is invalid`);
  }
  let backup;
  try {
    backup = JSON.parse(body.toString('utf8'));
  } catch {
    fail(`layout ${scenarioId} target backup is not JSON`);
  }
  exactKeys(
    backup,
    ['database', 'health', 'release', 'schema', 'sourceSha256'],
    `layout ${scenarioId} target backup`,
  );
  if (backup.schema !== TARGET_BACKUP_SCHEMA
      || backup.sourceSha256 !== sha256(
        Buffer.from(canonicalJson(source), 'utf8'),
      )) {
    fail(`layout ${scenarioId} target backup identity is invalid`);
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
  for (const [label, entry, expectedPath, maximum] of definitions) {
    exactKeys(
      entry,
      ['bytes', 'contentBase64', 'contentEncoding', 'path', 'sha256'],
      `layout ${scenarioId} target backup ${label}`,
    );
    const entryBody = canonicalBase64(
      entry.contentBase64,
      `layout ${scenarioId} target backup ${label}`,
      maximum,
    );
    if (entry.path !== expectedPath || entry.contentEncoding !== 'base64'
        || entry.bytes !== entryBody.length
        || !DIGEST.test(entry.sha256 ?? '')
        || sha256(entryBody) !== entry.sha256) {
      fail(`layout ${scenarioId} target backup ${label} identity is invalid`);
    }
    decoded[label] = entryBody;
  }
  if (!decoded.release.equals(
    Buffer.from(`${canonicalJson(source)}\n`, 'utf8'),
  ) || !decoded.health.equals(Buffer.from('ok\n'))) {
    fail(`layout ${scenarioId} target backup release identity is invalid`);
  }
  validateSqliteBackup(decoded.database, scenarioId);
  if (!body.equals(Buffer.from(canonicalJson(backup), 'utf8'))) {
    fail(`layout ${scenarioId} target backup bytes are not canonical`);
  }
  return backup;
}

function verifyEnvelopeSignature(
  envelope,
  {
    schema,
    keyId,
    label,
    publicKey,
  },
) {
  exactKeys(
    envelope,
    ['keyId', 'payload', 'schema', 'signature', 'signatureAlgorithm'],
    label,
  );
  if (envelope.schema !== schema
      || envelope.keyId !== keyId
      || envelope.signatureAlgorithm !== 'ed25519') {
    fail(`${label} identity is invalid`);
  }
  const signature = strictSignature(envelope.signature, `${label} signature`);
  if (!cryptoVerify(
    null,
    Buffer.from(canonicalJson(envelope.payload), 'utf8'),
    publicKey,
    signature,
  )) {
    fail(`${label} signature is invalid`);
  }
  return envelope.payload;
}

function validateReleaseManifest(input, releaseKey, expected, label) {
  const payload = verifyEnvelopeSignature(input.value, {
    schema: RELEASE_MANIFEST_SCHEMA,
    keyId: RELEASE_KEY_ID,
    label,
    publicKey: releaseKey,
  });
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || payload.schema !== RELEASE_PAYLOAD_SCHEMA
      || !SHA.test(payload.runtimeSha ?? '')
      || !VERSION_PATTERN.test(payload.packageVersion ?? '')
      || payload.source?.dirty !== false
      || payload.artifact?.schema !== RELEASE_ARTIFACT_SCHEMA
      || !DIGEST.test(payload.artifact?.digest ?? '')
      || payload.runtimeSha !== expected.runtimeSha
      || payload.artifact.digest !== expected.artifactDigest) {
    fail(`${label} does not bind the signed layout source identity`);
  }
  const generatedAt = Date.parse(payload.generatedAt ?? '');
  const expiresAt = Date.parse(payload.expiresAt ?? '');
  if (!Number.isFinite(generatedAt) || !Number.isFinite(expiresAt)
      || expiresAt <= generatedAt) {
    fail(`${label} lifetime metadata is invalid`);
  }
  return {
    rawSha256: sha256(input.body),
    runtimeSha: payload.runtimeSha,
    packageVersion: payload.packageVersion,
    artifactDigest: payload.artifact.digest,
  };
}

function validateFaultFreshness(drill) {
  if (!ISO_UTC.test(drill.completedAt ?? '')) {
    fail('layout fault drill completion time is invalid');
  }
  const completedAt = Date.parse(drill.completedAt);
  const age = Date.now() - completedAt;
  if (!Number.isFinite(completedAt) || age < -MAX_CLOCK_SKEW_MS) {
    fail('layout fault drill completion time is in the future');
  }
  if (age > MAX_FRESHNESS_MS) {
    fail('layout fault drill is older than the ordinary 30-day gate');
  }
}

function verifyDeepProof({
  envelopeBody,
  temporaryParent,
  trustManifestPath,
  provisionReceiptPath,
}) {
  const verifier = path.join(
    toolingRoot,
    'scripts/release-layout-fault-drill.mjs',
  );
  let stdout;
  let envelopeTemporary;
  try {
    envelopeTemporary = writeTemporary(
      temporaryParent,
      'fault-drill-envelope.verify',
      envelopeBody,
    );
    const identity = fs.lstatSync(envelopeTemporary);
    if (!identity.isFile() || identity.isSymbolicLink()
        || identity.nlink !== 1 || identity.uid !== 0 || identity.gid !== 0
        || (identity.mode & 0o7777) !== 0o600) {
      fail('captured fault-drill envelope verification file is unsafe');
    }
    stdout = execFileSync(
      process.execPath,
      [
        verifier,
        'verify-envelope',
        '--input',
        envelopeTemporary,
        '--trust-manifest',
        trustManifestPath,
        '--provision-receipt',
        provisionReceiptPath,
        '--require-root-trust',
        '--allow-expired',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          NEXUS_RELEASE_TEST_MODE: '0',
        },
      },
    );
  } catch {
    fail('nested KVM proof or root-pinned trust verification failed');
  } finally {
    if (envelopeTemporary) {
      fs.rmSync(envelopeTemporary, { force: true });
      fsyncDirectory(temporaryParent);
    }
  }
  let proof;
  try {
    proof = JSON.parse(stdout);
  } catch {
    fail('nested KVM verifier returned malformed output');
  }
  exactKeys(proof, [
    'maximumRecoverySeconds',
    'migrationId',
    'ok',
    'planSha256',
    'provisionReceiptSha256',
    'provisionSetId',
    'schema',
    'signerKeyDigests',
    'trustManifestSha256',
  ], 'nested KVM proof verification');
  exactKeys(
    proof.signerKeyDigests,
    ['guests', 'hypervisor'],
    'nested KVM proof signer identities',
  );
  exactKeys(
    proof.signerKeyDigests.guests,
    SCENARIOS,
    'nested KVM guest signer identities',
  );
  if (proof.ok !== true || proof.schema !== DEEP_PROOF_SCHEMA
      || !DIGEST.test(proof.planSha256 ?? '')
      || !DIGEST.test(proof.trustManifestSha256 ?? '')
      || !DIGEST.test(proof.provisionReceiptSha256 ?? '')
      || !DIGEST.test(proof.provisionSetId ?? '')
      || !Number.isSafeInteger(proof.maximumRecoverySeconds)
      || proof.maximumRecoverySeconds < 0
      || proof.maximumRecoverySeconds > 120
      || !DIGEST.test(proof.signerKeyDigests.hypervisor ?? '')
      || SCENARIOS.some(
        (scenario) => !DIGEST.test(
          proof.signerKeyDigests.guests[scenario] ?? '',
        ),
      )) {
    fail('nested KVM proof verification output is invalid');
  }
  return proof;
}

function parseExecutionEvidence(scenario, drill) {
  const encoded = scenario?.result?.proof?.executionEvidenceBase64;
  if (typeof encoded !== 'string' || encoded.length < 4
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    fail(`layout ${scenario?.id ?? 'unknown'} execution evidence is invalid`);
  }
  const body = Buffer.from(encoded, 'base64');
  if (body.length < 2 || body.length > 128 * 1024
      || body.toString('base64') !== encoded) {
    fail(`layout ${scenario.id} execution evidence is invalid`);
  }
  let execution;
  try {
    execution = JSON.parse(body.toString('utf8'));
  } catch {
    fail(`layout ${scenario.id} execution evidence is invalid`);
  }
  const observation = execution.faultObservation;
  const targetBackupBase64 = observation?.targetBackupBase64;
  if (execution.schema !== GUEST_EVIDENCE_SCHEMA) {
    fail(
      `layout ${scenario.id} evidence predates governed target backups`,
    );
  }
  const targetBackup = canonicalBase64(
    targetBackupBase64,
    `layout ${scenario.id} target backup`,
    MAX_TARGET_BACKUP_BYTES,
  );
  const target = validateTargetBackup(
    targetBackup,
    drill.source,
    scenario.id,
  );
  if (!observation || typeof observation !== 'object'
      || !DIGEST.test(observation.journalSha256 ?? '')
      || !DIGEST.test(observation.predecessorSha256 ?? '')
      || !DIGEST.test(observation.restoredSha256 ?? '')
      || !DIGEST.test(observation.databaseBeforeSha256 ?? '')
      || !DIGEST.test(observation.databaseAfterSha256 ?? '')
      || !DIGEST.test(observation.targetBackupSha256 ?? '')
      || observation.targetBackupBytes !== targetBackup.length
      || sha256(targetBackup) !== observation.targetBackupSha256
      || target.release.sha256 !== observation.predecessorSha256
      || target.database.sha256 !== observation.databaseBeforeSha256
      || observation.predecessorSha256 !== observation.restoredSha256
      || observation.databaseBeforeSha256
        !== observation.databaseAfterSha256) {
    fail(`layout ${scenario.id} recovery identity is invalid`);
  }
  return {
    scenarioId: scenario.id,
    resultSha256: scenario.resultSha256,
    journalSha256: observation.journalSha256,
    predecessorSha256: observation.predecessorSha256,
    restoredSha256: observation.restoredSha256,
    databaseBeforeSha256: observation.databaseBeforeSha256,
    databaseAfterSha256: observation.databaseAfterSha256,
    targetBackupSha256: observation.targetBackupSha256,
    targetBackupBytes: observation.targetBackupBytes,
    targetBackupBase64,
    targetBackup,
    completedAt: scenario.result.completedAt,
    recoveryMilliseconds: scenario.result.recovery.durationMilliseconds,
  };
}

function recoverySet(drill, faultDrillEnvelopeSha256, executions) {
  const scenarios = executions.map((execution) => ({
    scenarioId: execution.scenarioId,
    resultSha256: execution.resultSha256,
    journalSha256: execution.journalSha256,
    predecessorSha256: execution.predecessorSha256,
    restoredSha256: execution.restoredSha256,
    databaseBeforeSha256: execution.databaseBeforeSha256,
    databaseAfterSha256: execution.databaseAfterSha256,
    targetBackupSha256: execution.targetBackupSha256,
    targetBackupBytes: execution.targetBackupBytes,
    completedAt: execution.completedAt,
    recoveryMilliseconds: execution.recoveryMilliseconds,
  }));
  if (scenarios.some((entry, index) => entry.scenarioId !== SCENARIOS[index])) {
    fail('layout recovery scenario order is invalid');
  }
  return {
    schema: RECOVERY_SET_SCHEMA,
    migrationId: drill.migrationId,
    planId: drill.plan.planId,
    planSha256: drill.planSha256,
    faultDrillEnvelopeSha256,
    sourceSha256: sha256(
      Buffer.from(canonicalJson(drill.source), 'utf8'),
    ),
    scenarios,
  };
}

function assertKeySeparation(owner, release, drill) {
  const identities = [
    ['owner', owner.der],
    ['release', release.der],
    [
      'hypervisor',
      canonicalPublicKey(
        drill.plan.trust.hypervisorEd25519PublicKey,
        'layout hypervisor evidence key',
      ).der,
    ],
    ...SCENARIOS.map((scenario) => [
      scenario,
      canonicalPublicKey(
        drill.plan.trust.guestEd25519PublicKeys[scenario],
        `layout ${scenario} evidence key`,
      ).der,
    ]),
  ];
  for (let left = 0; left < identities.length; left += 1) {
    for (let right = left + 1; right < identities.length; right += 1) {
      if (identities[left][1].equals(identities[right][1])) {
        fail(
          `signing authority is reused by ${identities[left][0]} `
          + `and ${identities[right][0]}`,
        );
      }
    }
  }
}

function safeOutputParent(file, label) {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  let identity;
  try {
    identity = fs.lstatSync(parent);
  } catch {
    fail(`${label} parent is unavailable`);
  }
  if (!identity.isDirectory() || identity.isSymbolicLink()
      || (identity.mode & 0o022) !== 0
      || identity.uid !== 0 || identity.gid !== 0) {
    fail(`${label} parent is unsafe`);
  }
  return { resolved, parent };
}

function writeTemporary(parent, basename, value) {
  const temporary = path.join(
    parent,
    `.${basename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, outputBytes(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

function validatePayloadWithCanonicalConsumer(temporary) {
  const checker = path.join(toolingRoot, 'scripts/rollback-drill-check.mjs');
  try {
    execFileSync(
      process.execPath,
      [
        checker,
        'validate-payload',
        '--root',
        toolingRoot,
        '--evidence',
        temporary,
        '--release-gate',
        '--max-age-days',
        '30',
        '--json',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
    );
  } catch {
    fail('derived rollback-drill payload failed the canonical release gate');
  }
}

function normalizePublishedLink(output) {
  let identity = fs.lstatSync(output);
  if (identity.nlink === 1) return identity;
  const parent = path.dirname(output);
  const prefix = `.${path.basename(output)}.`;
  for (const entry of fs.readdirSync(parent)) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    const candidate = path.join(parent, entry);
    const candidateIdentity = fs.lstatSync(
      candidate,
      { throwIfNoEntry: false },
    );
    if (candidateIdentity
        && candidateIdentity.dev === identity.dev
        && candidateIdentity.ino === identity.ino) {
      fs.unlinkSync(candidate);
    }
  }
  fsyncDirectory(parent);
  identity = fs.lstatSync(output);
  if (identity.nlink !== 1) {
    fail('published evidence retains an unknown hard-link identity');
  }
  return identity;
}

function verifyPublishedOutput(entry) {
  const identity = normalizePublishedLink(entry.resolved);
  if (!identity.isFile() || identity.isSymbolicLink()
      || (identity.mode & 0o7777) !== 0o600
      || identity.uid !== 0 || identity.gid !== 0) {
    fail(`${entry.label} published identity is unsafe`);
  }
  const input = readSafeBytes(
    entry.resolved,
    `${entry.label} published output`,
  );
  const expected = outputBytes(entry.value);
  if (!input.body.equals(expected)) {
    fail(`${entry.label} published output differs from this evidence`);
  }
  fsyncDirectory(entry.parent);
}

function publishOne(entry) {
  let temporary;
  try {
    temporary = writeTemporary(
      entry.parent,
      path.basename(entry.resolved),
      entry.value,
    );
    fs.linkSync(temporary, entry.resolved);
    fs.unlinkSync(temporary);
    temporary = undefined;
    fsyncDirectory(entry.parent);
  } catch (error) {
    if (temporary) fs.rmSync(temporary, { force: true });
    if (error instanceof Error
        && error.message.startsWith(
          'rollback drill layout freshness adapter:',
        )) {
      throw error;
    }
    fail(`${entry.label} durable publication failed`);
  }
}

function publishEvidenceSet(
  backupPath,
  backup,
  machinePath,
  machineEvidence,
  outputPath,
  payload,
) {
  const backupOutput = safeOutputParent(
    backupPath,
    'target backup output',
  );
  const machine = safeOutputParent(
    machinePath,
    'machine evidence output',
  );
  const output = safeOutputParent(
    outputPath,
    'rollback request output',
  );
  const outputs = [
    {
      ...backupOutput,
      label: 'target backup',
      value: backup,
    },
    {
      ...machine,
      label: 'machine evidence',
      value: machineEvidence,
    },
    {
      ...output,
      label: 'rollback request',
      value: payload,
    },
  ];
  if (new Set(outputs.map((entry) => entry.resolved)).size
      !== outputs.length) {
    fail('backup, machine evidence, and request outputs must be distinct');
  }
  let missingSeen = false;
  let firstMissing = outputs.length;
  for (const [index, entry] of outputs.entries()) {
    const identity = fs.lstatSync(
      entry.resolved,
      { throwIfNoEntry: false },
    );
    if (!identity) {
      if (!missingSeen) firstMissing = index;
      missingSeen = true;
      continue;
    }
    if (missingSeen) {
      fail('published evidence set order is invalid');
    }
    verifyPublishedOutput(entry);
  }
  let validationTemporary;
  try {
    validationTemporary = writeTemporary(
      output.parent,
      path.basename(output.resolved),
      payload,
    );
    validatePayloadWithCanonicalConsumer(validationTemporary);
  } finally {
    if (validationTemporary) {
      fs.rmSync(validationTemporary, { force: true });
    }
  }
  for (const entry of outputs.slice(firstMissing)) {
    publishOne(entry);
  }
  return {
    backupPath: backupOutput.resolved,
    machineEvidencePath: machine.resolved,
    outputPath: output.resolved,
  };
}

function buildRequest(args) {
  if (args.includes('--allow-test-key')) {
    fail('test signing-key bypass is not supported');
  }
  const faultInput = readSafeJson(
    requiredOption(args, '--fault-drill-envelope'),
    'signed layout fault-drill envelope',
  );
  const requestOutputPolicy = safeOutputParent(
    requiredOption(args, '--output'),
    'rollback request output',
  );
  const trustInput = readSafeBytes(
    requiredOption(args, '--trust-manifest'),
    'root-pinned layout trust manifest',
    256 * 1024,
  );
  const provisionInput = readSafeBytes(
    requiredOption(args, '--provision-receipt'),
    'root-pinned KVM provision receipt',
    256 * 1024,
  );
  const sourceManifestInput = readSafeJson(
    requiredOption(args, '--source-release-manifest'),
    'source release manifest',
  );
  const targetManifestInput = readSafeJson(
    requiredOption(args, '--target-release-manifest'),
    'target release manifest',
  );
  const ownerKeyPath = option(
    args,
    '--owner-public-key',
    PROTECTED_OWNER_PUBLIC_KEY_PATH,
  );
  if (path.resolve(ownerKeyPath) !== PROTECTED_OWNER_PUBLIC_KEY_PATH) {
    fail('layout owner public key differs from the protected server pin');
  }
  const ownerKeyInput = readSafeBytes(
    ownerKeyPath,
    'layout owner public key',
    32 * 1024,
    {
      exactMode: 0o644,
      rootOwned: true,
    },
  );
  const trackedReleaseKeyPath = path.join(
    toolingRoot,
    'docs/release/evidence/release-evidence-public-key.pem',
  );
  const suppliedReleaseKeyPath = option(
    args,
    '--release-public-key',
    trackedReleaseKeyPath,
  );
  const releaseKeyInput = readSafeBytes(
    suppliedReleaseKeyPath,
    'release evidence public key',
    32 * 1024,
  );
  const ownerKey = canonicalPublicKey(
    ownerKeyInput.body,
    'layout owner public key',
  );
  const releaseKey = canonicalPublicKey(
    releaseKeyInput.body,
    'release evidence public key',
  );
  if (path.resolve(suppliedReleaseKeyPath) !== trackedReleaseKeyPath) {
    fail('release evidence public key path differs from protected policy');
  }
  const drill = verifyEnvelopeSignature(faultInput.value, {
    schema: LAYOUT_ENVELOPE_SCHEMA,
    keyId: LAYOUT_OWNER_KEY_ID,
    label: 'signed layout fault-drill envelope',
    publicKey: ownerKey.key,
  });
  validateFaultFreshness(drill);
  const deepProof = verifyDeepProof({
    envelopeBody: faultInput.body,
    temporaryParent: requestOutputPolicy.parent,
    trustManifestPath: trustInput.path,
    provisionReceiptPath: provisionInput.path,
  });
  if (deepProof.migrationId !== drill.migrationId
      || deepProof.planSha256 !== drill.planSha256
      || deepProof.trustManifestSha256
        !== drill.plan.trust.trustManifestSha256
      || deepProof.trustManifestSha256 !== sha256(trustInput.body)
      || deepProof.provisionReceiptSha256
        !== drill.plan.trust.provisionReceiptSha256
      || deepProof.provisionReceiptSha256 !== sha256(provisionInput.body)
      || deepProof.provisionSetId !== drill.plan.trust.provisionSetId) {
    fail('nested KVM verification differs from the signed drill');
  }
  assertKeySeparation(ownerKey, releaseKey, drill);
  const sourceRelease = validateReleaseManifest(
    sourceManifestInput,
    releaseKey.key,
    drill.source.production,
    'source release manifest',
  );
  const targetRelease = validateReleaseManifest(
    targetManifestInput,
    releaseKey.key,
    drill.source.staging,
    'target release manifest',
  );
  const faultDrillEnvelopeSha256 = sha256(faultInput.body);
  const executions = drill.scenarios.map(
    (scenario) => parseExecutionEvidence(scenario, drill),
  );
  const derivedRecoverySet = recoverySet(
    drill,
    faultDrillEnvelopeSha256,
    executions,
  );
  if (executions.length !== SCENARIOS.length) {
    fail('layout target backup scenario count is invalid');
  }
  const targetBackupBytes = executions[0].targetBackup;
  if (executions.some(
    (execution) => execution.targetBackupBytes !== targetBackupBytes.length
      || execution.targetBackupSha256 !== executions[0].targetBackupSha256
      || !execution.targetBackup.equals(targetBackupBytes),
  )) {
    fail('three layout target backups are not byte-identical');
  }
  const parsedTargetBackup = validateTargetBackup(
    targetBackupBytes,
    drill.source,
    'published',
  );
  const backupOutputPath = requiredOption(args, '--backup-output');
  const targetBackup = path.basename(path.resolve(backupOutputPath));
  const targetBackupSha256 = sha256(targetBackupBytes);
  const machineEvidence = {
    schema: MACHINE_EVIDENCE_SCHEMA,
    drilledAt: drill.completedAt,
    inputs: {
      faultDrillEnvelopeSha256,
      faultDrillPayloadSha256: sha256(
        Buffer.from(canonicalJson(drill), 'utf8'),
      ),
      ownerPublicKeySha256: sha256(Buffer.from(ownerKey.pem, 'utf8')),
      releasePublicKeySha256: sha256(Buffer.from(releaseKey.pem, 'utf8')),
      trustManifestSha256: sha256(trustInput.body),
      provisionReceiptSha256: sha256(provisionInput.body),
      sourceReleaseManifestSha256: sourceRelease.rawSha256,
      targetReleaseManifestSha256: targetRelease.rawSha256,
    },
    release: {
      source: {
        runtimeSha: sourceRelease.runtimeSha,
        version: sourceRelease.packageVersion,
        artifactDigest: sourceRelease.artifactDigest,
        installedRuntimeDigest:
          drill.source.production.installedRuntimeDigest,
      },
      target: {
        runtimeSha: targetRelease.runtimeSha,
        version: targetRelease.packageVersion,
        artifactDigest: targetRelease.artifactDigest,
        installedRuntimeDigest:
          drill.source.staging.installedRuntimeDigest,
      },
    },
    verification: {
      schema: deepProof.schema,
      migrationId: deepProof.migrationId,
      planSha256: deepProof.planSha256,
      trustManifestSha256: deepProof.trustManifestSha256,
      provisionReceiptSha256: deepProof.provisionReceiptSha256,
      provisionSetId: deepProof.provisionSetId,
      maximumRecoverySeconds: deepProof.maximumRecoverySeconds,
      signerKeyDigests: deepProof.signerKeyDigests,
    },
    recoverySet: derivedRecoverySet,
    recoverySetSha256: sha256(
      Buffer.from(canonicalJson(derivedRecoverySet), 'utf8'),
    ),
    backup: {
      schema: TARGET_BACKUP_SCHEMA,
      name: targetBackup,
      sha256: targetBackupSha256,
      bytes: targetBackupBytes.length,
      scenarioCount: executions.length,
      releaseSha256: parsedTargetBackup.release.sha256,
      databaseSha256: parsedTargetBackup.database.sha256,
    },
  };
  const machineEvidenceSha256 = sha256(
    Buffer.from(canonicalJson(machineEvidence), 'utf8'),
  );
  const operator = requiredOption(args, '--operator');
  if (!OPERATOR.test(operator)) fail('operator identity is invalid');
  const payload = {
    schema: ROLLBACK_PAYLOAD_SCHEMA,
    drilledAt: drill.completedAt,
    result: 'passed',
    restoreMode: 'dry-run',
    dryRun: true,
    sourceVersion: sourceRelease.packageVersion,
    targetVersion: targetRelease.packageVersion,
    sourceSha: sourceRelease.runtimeSha,
    targetSha: targetRelease.runtimeSha,
    targetBackup,
    targetBackupSha256,
    machineEvidenceSha256,
    operator,
    databaseIntegrity: 'ok',
    backupContainsDatabase: true,
    healthCheck: 'passed',
  };
  const published = publishEvidenceSet(
    backupOutputPath,
    targetBackupBytes,
    requiredOption(args, '--machine-evidence-output'),
    machineEvidence,
    requiredOption(args, '--output'),
    payload,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: VERSION,
    command: 'build-request',
    ...published,
    targetSha: payload.targetSha,
    targetVersion: payload.targetVersion,
    targetBackupSha256,
    machineEvidenceSha256,
  })}\n`);
}

try {
  const args = process.argv.slice(2);
  const command = args.shift() ?? '';
  if (command === 'build-request') buildRequest(args);
  else if (command === 'version') process.stdout.write(`${VERSION}\n`);
  else {
    fail(
      'expected build-request or version',
    );
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
