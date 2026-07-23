#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
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

function verifyPayload(payload, signature, pem = publicKeyPem()) {
  if (!pem) return { ok: false, reason: 'public_key_missing' };
  if (!signature) return { ok: false, reason: 'signature_missing' };
  try {
    const ok = cryptoVerify(null, Buffer.from(canonicalJson(payload)), createPublicKey(pem), Buffer.from(signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
  } catch (error) {
    return { ok: false, reason: `signature_verify_error:${error instanceof Error ? error.message : String(error)}` };
  }
}

function isPassing(value) {
  return new Set(['pass', 'passed', 'success', 'succeeded']).has(String(value || '').toLowerCase());
}

function envelopeForPayload(payload) {
  const signature = signPayload(payload);
  if (!signature) {
    emit({ ok: false, evidencePath, reasons: ['private_key_missing'] }, 1);
  }
  return {
    schema: 'nexus.rollback-drill.v1',
    keyId: readArg('--key-id', process.env.NEXUS_RELEASE_EVIDENCE_KEY_ID || 'github-actions-release-evidence'),
    signatureAlgorithm: 'ed25519',
    payload,
    signature,
  };
}

function payloadFromRaw(raw) {
  if (raw?.schema === 'nexus.rollback-drill.v1' && raw?.payload) return raw.payload;
  const { keyId: _keyId, signatureAlgorithm: _signatureAlgorithm, signature: _signature, ...rest } = raw || {};
  return {
    ...rest,
    schema: 'nexus.rollback-drill-payload.v1',
  };
}

function validateEnvelope(raw) {
  const reasons = [];
  if (raw?.schema !== 'nexus.rollback-drill.v1') {
    reasons.push(`schema_unsupported:${raw?.schema || 'missing'}`);
  }
  const payload = raw?.payload || {};
  if (payload?.schema !== 'nexus.rollback-drill-payload.v1') {
    reasons.push(`payload_schema_unsupported:${payload?.schema || 'missing'}`);
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
  if (!isPassing(evidence?.result || evidence?.verdict)) {
    reasons.push(`result_not_passing:${evidence?.result || evidence?.verdict || 'missing'}`);
  }

  if (evidence?.restoreMode !== 'dry-run' || evidence?.dryRun !== true) {
    reasons.push('dry_run_restore_missing');
  }

  for (const key of ['sourceVersion', 'targetVersion', 'sourceSha', 'targetSha', 'targetBackup', 'operator']) {
    if (!evidence?.[key] || typeof evidence[key] !== 'string') {
      reasons.push(`${key}_missing`);
    }
  }

  const fullShaPattern = /^[0-9a-f]{40}$/i;
  if (evidence?.targetSha && !fullShaPattern.test(evidence.targetSha)) {
    reasons.push(`targetSha_invalid:${evidence.targetSha}`);
  }
  if (evidence?.sourceSha && !fullShaPattern.test(evidence.sourceSha)) {
    reasons.push(`sourceSha_invalid:${evidence.sourceSha}`);
  }

  const expectedSha = readArg('--expect-sha', '');
  if (expectedSha && evidence?.targetSha !== expectedSha) {
    reasons.push(`targetSha_mismatch:evidence=${evidence?.targetSha || 'missing'}:expected=${expectedSha}`);
  }
  const expectedTargetVersion = readArg('--expect-target-version', '').replace(/^v/, '');
  if (expectedTargetVersion && String(evidence?.targetVersion || '').replace(/^v/, '') !== expectedTargetVersion) {
    reasons.push(`targetVersion_mismatch:evidence=${evidence?.targetVersion || 'missing'}:expected=${expectedTargetVersion}`);
  }

  if (evidence?.databaseIntegrity !== 'ok') {
    reasons.push(`database_integrity_not_ok:${evidence?.databaseIntegrity || 'missing'}`);
  }
  if (evidence?.backupContainsDatabase !== true) {
    reasons.push('backup_database_proof_missing');
  }
  if (!isPassing(evidence?.healthCheck)) {
    reasons.push(`health_check_not_passing:${evidence?.healthCheck || 'missing'}`);
  }

  const drilledAt = evidence?.drilledAt || evidence?.generatedAt || null;
  if (!drilledAt) {
    reasons.push('drilled_at_missing');
  } else {
    const drilledMs = Date.parse(drilledAt);
    if (!Number.isFinite(drilledMs)) {
      reasons.push(`drilled_at_invalid:${drilledAt}`);
    } else {
      const ageMs = Date.now() - drilledMs;
      if (ageMs < -5 * 60 * 1000) {
        reasons.push(`drilled_at_in_future:${drilledAt}`);
      }
      if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
        reasons.push(`drill_stale:${Math.floor(ageMs / 86400000)}d>${maxAgeDays}d`);
      }
    }
  }

  return reasons;
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
      drilledAt: evidence?.drilledAt || evidence?.generatedAt || null,
      sourceVersion: evidence?.sourceVersion || null,
      targetVersion: evidence?.targetVersion || null,
      sourceSha: evidence?.sourceSha || null,
      targetSha: evidence?.targetSha || null,
      targetBackup: evidence?.targetBackup || null,
      result: evidence?.result || evidence?.verdict || null,
    },
  }, reasons.length === 0 ? 0 : 1);
}

function sign() {
  const raw = readEvidence();
  const payload = payloadFromRaw(raw);
  const signed = envelopeForPayload(payload);
  const outputPath = path.resolve(root, readArg('--output', evidencePath));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(signed, null, 2)}\n`);
  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: outputPath, evidence: signed }, null, 2)}\n`);
  } else {
    process.stdout.write(`rollback drill evidence signed: ${outputPath}\n`);
  }
}

if (command === 'validate' || command === 'verify') {
  validate();
} else if (command === 'sign') {
  sign();
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(64);
}
