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
import { resolveMaxAge } from './lib/freshness.mjs';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('--') ? args[0] : 'validate';

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const root = path.resolve(readArg('--root', process.cwd()));
const evidencePath = path.resolve(
  root,
  readArg(
    '--evidence',
    process.env.NEXUS_ROLLBACK_DRILL_EVIDENCE_PATH || '.local/release/rollback-drill-latest.json',
  ),
);
const DEFAULT_MAX_AGE_DAYS = 30;
const MAX_AGE_CEILING_DAYS = 90;
const ENVELOPE_SCHEMA = 'nexus.rollback-drill.v1';
const PAYLOAD_SCHEMA = 'nexus.rollback-drill-payload.v1';
const CURRENT_SIGNING_KEY_ID = 'github-environment-release-signing-2026-07';
const ENVELOPE_FIELDS = new Set([
  'schema',
  'keyId',
  'signatureAlgorithm',
  'payload',
  'signature',
]);
const PAYLOAD_FIELDS = new Set([
  'schema',
  'drilledAt',
  'result',
  'restoreMode',
  'dryRun',
  'sourceVersion',
  'targetVersion',
  'sourceSha',
  'targetSha',
  'targetBackup',
  'targetBackupSha256',
  'machineEvidenceSha256',
  'operator',
  'databaseIntegrity',
  'backupContainsDatabase',
  'healthCheck',
]);
const releaseGate = hasArg('--release-gate');
const resolvedMaxAgeDays = resolveMaxAge(
  readArg('--max-age-days', process.env.NEXUS_ROLLBACK_DRILL_MAX_AGE_DAYS || String(DEFAULT_MAX_AGE_DAYS)),
  DEFAULT_MAX_AGE_DAYS,
  MAX_AGE_CEILING_DAYS,
  { root, flag: 'NEXUS_ROLLBACK_DRILL_MAX_AGE_DAYS' },
);
// A release caller may choose a tighter window, but can never relax the
// canonical 30-day gate through an environment variable or CLI argument.
const maxAgeDays = releaseGate ? Math.min(resolvedMaxAgeDays, DEFAULT_MAX_AGE_DAYS) : resolvedMaxAgeDays;
const outputJson = hasArg('--json');

function emit(payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    process.stdout.write(`rollback drill evidence OK: ${payload.evidencePath}\n`);
  } else {
    process.stderr.write(`rollback drill evidence invalid: ${payload.reasons.join('; ')}\n`);
  }
  process.exit(exitCode);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function pemFromPathOrDefault(argName, defaultPath = '') {
  const directPath = readArg(argName, '');
  if (directPath) return fs.readFileSync(path.resolve(root, directPath), 'utf8');
  if (defaultPath) {
    const resolved = path.resolve(root, defaultPath);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, 'utf8');
  }
  return '';
}

function privateKeyPem() {
  const directPath = readArg('--private-key', '');
  if (directPath) return fs.readFileSync(path.resolve(root, directPath), 'utf8');
  if (process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM) {
    return process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM;
  }
  if (process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH) {
    return fs.readFileSync(path.resolve(root, process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH), 'utf8');
  }
  return '';
}

function publicKeyPem() {
  return pemFromPathOrDefault('--public-key', 'docs/release/evidence/release-evidence-public-key.pem');
}

function signPayload(payload, pem = privateKeyPem()) {
  if (!pem) return '';
  return cryptoSign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(pem)).toString('base64');
}

function canonicalSignature(signature) {
  if (typeof signature !== 'string'
      || signature.length !== 88
      || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    return { ok: false, reason: signature ? 'signature_encoding_invalid' : 'signature_missing' };
  }
  try {
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signature) {
      return { ok: false, reason: 'signature_encoding_invalid' };
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: 'signature_encoding_invalid' };
  }
}

function verifyPayload(payload, signature, pem = publicKeyPem()) {
  if (!pem) return { ok: false, reason: 'public_key_missing' };
  const decoded = canonicalSignature(signature);
  if (!decoded.ok) return decoded;
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      createPublicKey(pem),
      decoded.bytes,
    );
    return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
  } catch (error) {
    return { ok: false, reason: `signature_verify_error:${error instanceof Error ? error.message : String(error)}` };
  }
}

function envelopeForPayload(payload, keyId) {
  const signature = signPayload(payload);
  if (!signature) {
    emit({ ok: false, evidencePath, reasons: ['private_key_missing'] }, 1);
  }
  return {
    schema: ENVELOPE_SCHEMA,
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature,
  };
}

function payloadFromRaw(raw) {
  if (raw?.schema === ENVELOPE_SCHEMA && raw?.payload) return raw.payload;
  const { keyId: _keyId, signatureAlgorithm: _signatureAlgorithm, signature: _signature, ...rest } = raw || {};
  return {
    ...rest,
    schema: PAYLOAD_SCHEMA,
  };
}

function validateEnvelope(raw) {
  const reasons = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reasons: ['envelope_not_an_object'], payload: {} };
  }
  if (Object.keys(raw).some((field) => !ENVELOPE_FIELDS.has(field))
      || Object.keys(raw).length !== ENVELOPE_FIELDS.size) {
    reasons.push('envelope_fields_invalid');
  }
  if (raw?.schema !== ENVELOPE_SCHEMA) {
    reasons.push(`schema_unsupported:${raw?.schema || 'missing'}`);
  }
  const payload = raw?.payload || {};
  if (payload?.schema !== PAYLOAD_SCHEMA) {
    reasons.push(`payload_schema_unsupported:${payload?.schema || 'missing'}`);
  }
  if (raw?.keyId !== CURRENT_SIGNING_KEY_ID) {
    reasons.push(`key_id_unsupported:${raw?.keyId || 'missing'}`);
  }
  if (raw?.signatureAlgorithm !== 'ed25519') {
    reasons.push(`signature_algorithm_unsupported:${raw?.signatureAlgorithm || 'missing'}`);
  }
  const signatureCheck = verifyPayload(payload, raw?.signature);
  if (!signatureCheck.ok) reasons.push(signatureCheck.reason);
  return { reasons, payload };
}

function validatePayload(evidence) {
  const reasons = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return ['payload_not_an_object'];
  }
  if (Object.keys(evidence).some((field) => !PAYLOAD_FIELDS.has(field))
      || Object.keys(evidence).length !== PAYLOAD_FIELDS.size) {
    reasons.push('payload_fields_invalid');
  }
  if (evidence?.schema !== PAYLOAD_SCHEMA) {
    reasons.push(`payload_schema_unsupported:${evidence?.schema || 'missing'}`);
  }
  if (evidence?.result !== 'passed') {
    reasons.push('result_not_passing');
  }

  if (evidence?.restoreMode !== 'dry-run' || evidence?.dryRun !== true) {
    reasons.push('dry_run_restore_missing');
  }

  for (const key of [
    'sourceVersion',
    'targetVersion',
    'sourceSha',
    'targetSha',
    'targetBackup',
    'targetBackupSha256',
    'machineEvidenceSha256',
    'operator',
  ]) {
    if (!evidence?.[key] || typeof evidence[key] !== 'string') {
      reasons.push(`${key}_missing`);
    }
  }

  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?$/;
  for (const key of ['sourceVersion', 'targetVersion']) {
    if (typeof evidence?.[key] === 'string' && !versionPattern.test(evidence[key])) {
      reasons.push(`${key}_invalid`);
    }
  }
  const fullShaPattern = /^[0-9a-f]{40}$/;
  if (evidence?.targetSha && !fullShaPattern.test(evidence.targetSha)) {
    reasons.push('targetSha_invalid');
  }
  if (evidence?.sourceSha && !fullShaPattern.test(evidence.sourceSha)) {
    reasons.push('sourceSha_invalid');
  }
  const digestPattern = /^[0-9a-f]{64}$/;
  for (const key of ['targetBackupSha256', 'machineEvidenceSha256']) {
    if (typeof evidence?.[key] === 'string' && !digestPattern.test(evidence[key])) {
      reasons.push(`${key}_invalid`);
    }
  }
  if (typeof evidence?.targetBackup === 'string'
      && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(evidence.targetBackup)) {
    reasons.push('targetBackup_invalid');
  }
  if (typeof evidence?.operator === 'string'
      && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/.test(evidence.operator)) {
    reasons.push('operator_invalid');
  }

  const expectedSha = readArg('--expect-sha', '');
  if (expectedSha && evidence?.targetSha !== expectedSha) {
    reasons.push('targetSha_mismatch');
  }
  const expectedTargetVersion = readArg('--expect-target-version', '').replace(/^v/, '');
  if (expectedTargetVersion && String(evidence?.targetVersion || '').replace(/^v/, '') !== expectedTargetVersion) {
    reasons.push('targetVersion_mismatch');
  }

  if (evidence?.databaseIntegrity !== 'ok') {
    reasons.push('database_integrity_not_ok');
  }
  if (evidence?.backupContainsDatabase !== true) {
    reasons.push('backup_database_proof_missing');
  }
  if (evidence?.healthCheck !== 'passed') {
    reasons.push('health_check_not_passing');
  }

  const drilledAt = evidence?.drilledAt || null;
  if (!drilledAt) {
    reasons.push('drilled_at_missing');
  } else if (typeof drilledAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(drilledAt)) {
    reasons.push('drilled_at_invalid');
  } else {
    const drilledMs = Date.parse(drilledAt);
    if (!Number.isFinite(drilledMs)) {
      reasons.push('drilled_at_invalid');
    } else {
      const ageMs = Date.now() - drilledMs;
      if (ageMs < -5 * 60 * 1000) {
        reasons.push('drilled_at_in_future');
      }
      if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
        reasons.push(`drill_stale:${Math.floor(ageMs / 86400000)}d>${maxAgeDays}d`);
      }
    }
  }

  return reasons;
}

function validateUnsignedPayload(raw) {
  const reasons = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return ['payload_not_an_object'];
  }
  if (raw.schema === ENVELOPE_SCHEMA || raw.payload !== undefined) {
    reasons.push('unsigned_payload_required');
  }
  for (const field of ['keyId', 'signatureAlgorithm', 'signature']) {
    if (Object.prototype.hasOwnProperty.call(raw, field)) {
      reasons.push(`payload_contains_envelope_field:${field}`);
    }
  }
  return [...reasons, ...validatePayload(raw)];
}

function readEvidence() {
  if (!fs.existsSync(evidencePath)) {
    emit({ ok: false, evidencePath, reasons: ['rollback_drill_evidence_missing'] }, 1);
  }
  try {
    return JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    emit({
      ok: false,
      evidencePath,
      reasons: [`rollback_drill_evidence_invalid_json:${error instanceof Error ? error.message : String(error)}`],
    }, 1);
  }
}

function validatePayloadCommand() {
  const raw = readEvidence();
  const reasons = validateUnsignedPayload(raw);
  emit({
    ok: reasons.length === 0,
    evidencePath,
    evidenceSha256: createHash('sha256').update(canonicalJson(raw)).digest('hex'),
    releaseGate,
    maxAgeDays,
    reasons,
    evidence: {
      schema: raw?.schema,
      drilledAt: raw?.drilledAt || null,
      sourceVersion: raw?.sourceVersion || null,
      targetVersion: raw?.targetVersion || null,
      sourceSha: raw?.sourceSha || null,
      targetSha: raw?.targetSha || null,
      targetBackup: raw?.targetBackup || null,
      result: raw?.result || null,
    },
  }, reasons.length === 0 ? 0 : 1);
}

function validate() {
  const raw = readEvidence();
  const evidenceSha256 = createHash('sha256').update(canonicalJson(raw)).digest('hex');
  const envelopeCheck = validateEnvelope(raw);
  const reasons = [...envelopeCheck.reasons, ...validatePayload(envelopeCheck.payload)];
  const evidence = envelopeCheck.payload || {};
  emit({
    ok: reasons.length === 0,
    evidencePath,
    evidenceSha256,
    releaseGate,
    maxAgeDays,
    reasons,
    evidence: {
      schema: evidence?.schema,
      drilledAt: evidence?.drilledAt || null,
      sourceVersion: evidence?.sourceVersion || null,
      targetVersion: evidence?.targetVersion || null,
      sourceSha: evidence?.sourceSha || null,
      targetSha: evidence?.targetSha || null,
      targetBackup: evidence?.targetBackup || null,
      result: evidence?.result || null,
    },
  }, reasons.length === 0 ? 0 : 1);
}

function sign() {
  const raw = readEvidence();
  const reasons = validateUnsignedPayload(raw);
  if (reasons.length > 0) {
    emit({ ok: false, evidencePath, reasons }, 1);
  }
  const keyId = readArg(
    '--key-id',
    process.env.NEXUS_RELEASE_EVIDENCE_KEY_ID || CURRENT_SIGNING_KEY_ID,
  );
  if (keyId !== CURRENT_SIGNING_KEY_ID) {
    emit({ ok: false, evidencePath, reasons: [`key_id_unsupported:${keyId || 'missing'}`] }, 1);
  }
  const payload = payloadFromRaw(raw);
  const signed = envelopeForPayload(payload, keyId);
  const outputPath = path.resolve(root, readArg('--output', evidencePath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(signed, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, outputPath);
  fs.chmodSync(outputPath, 0o600);
  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: outputPath, evidence: signed }, null, 2)}\n`);
  } else {
    process.stdout.write(`rollback drill evidence signed: ${outputPath}\n`);
  }
}

if (command === 'validate' || command === 'verify') {
  validate();
} else if (command === 'validate-payload') {
  validatePayloadCommand();
} else if (command === 'sign') {
  sign();
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(64);
}
