#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMaxAge } from './lib/freshness.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'validate';

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

const root = path.resolve(readArg('--root', process.cwd()));
const evidencePath = readArg('--evidence', process.env.NEXUS_RELEASE_EVIDENCE_PATH || 'docs/release/evidence/latest-release-evidence.json');
const DEFAULT_MAX_AGE_SECONDS = 72 * 60 * 60;
const MAX_AGE_CEILING_SECONDS = 7 * 24 * 60 * 60;
const maxAgeSeconds = resolveMaxAge(
  readArg('--max-age-seconds', process.env.NEXUS_RELEASE_EVIDENCE_MAX_AGE_S || String(DEFAULT_MAX_AGE_SECONDS)),
  DEFAULT_MAX_AGE_SECONDS,
  MAX_AGE_CEILING_SECONDS,
  { root, flag: 'NEXUS_RELEASE_EVIDENCE_MAX_AGE_S' },
);
const outputJson = hasArg('--json');
const allowUnsigned = hasArg('--allow-unsigned') || process.env.NEXUS_RELEASE_EVIDENCE_ALLOW_UNSIGNED === '1';

const REQUIRED_COMMANDS = [
  'typecheck',
  'build',
  'vitest',
  'pytest',
  'sciencePolicy',
  'migrations',
  'cannotSkipDashboard',
  'smoke',
];

function emit(payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    process.stdout.write(`release evidence OK: ${payload.evidencePath || ''}\n`);
  } else {
    process.stderr.write(`release evidence invalid: ${(payload.reasons || ['unknown']).join('; ')}\n`);
  }
  process.exit(exitCode);
}

function gitValue(commandArgs) {
  try {
    return execFileSync('git', commandArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function currentManifest() {
  return JSON.parse(execFileSync(
    process.execPath,
    [path.join(root, 'scripts/release-artifact-manifest.mjs'), '--root', root, '--format', 'json'],
    { cwd: root, encoding: 'utf8' },
  ));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function normalizeVerdict(value) {
  return String(value || '').toLowerCase();
}

function isPassed(value) {
  return new Set(['pass', 'passed', 'success', 'succeeded']).has(normalizeVerdict(value));
}

function resolvedPath(filePath) {
  return path.resolve(root, filePath);
}

function readPemFromArgOrEnv(argName, envValueName, envPathName, defaultPath = '') {
  const directPath = readArg(argName, '');
  if (directPath) return fs.readFileSync(path.resolve(root, directPath), 'utf8');
  if (process.env[envValueName]) return process.env[envValueName];
  if (process.env[envPathName]) return fs.readFileSync(path.resolve(root, process.env[envPathName]), 'utf8');
  if (defaultPath && fs.existsSync(path.resolve(root, defaultPath))) {
    return fs.readFileSync(path.resolve(root, defaultPath), 'utf8');
  }
  return '';
}

function privateKeyPem() {
  return readPemFromArgOrEnv(
    '--private-key',
    'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM',
    'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PATH',
  );
}

function publicKeyPem() {
  const directPath = readArg('--public-key', '');
  if (directPath) return fs.readFileSync(path.resolve(root, directPath), 'utf8');
  const defaultPath = path.resolve(root, 'docs/release/evidence/release-evidence-public-key.pem');
  if (fs.existsSync(defaultPath)) return fs.readFileSync(defaultPath, 'utf8');
  return '';
}

function signPayload(payload, pem = privateKeyPem()) {
  if (!pem) return '';
  const key = createPrivateKey(pem);
  return cryptoSign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
}

function verifyPayload(payload, signature, pem = publicKeyPem()) {
  if (!pem) return { ok: false, reason: 'public_key_missing' };
  if (!signature) return { ok: false, reason: 'signature_missing' };
  try {
    const key = createPublicKey(pem);
    const ok = cryptoVerify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' };
  } catch (error) {
    return {
      ok: false,
      reason: `signature_verify_error:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function commandResult(name, fallback = 'missing') {
  const envKey = `NEXUS_RELEASE_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}_RESULT`;
  return process.env[envKey] || fallback;
}

function countValue(name) {
  const envKey = `NEXUS_RELEASE_${name.toUpperCase()}_TEST_COUNT`;
  return Number(process.env[envKey] || 0);
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function minimumTestCount(name) {
  const upper = name.toUpperCase();
  const explicit = numericEnv(`NEXUS_RELEASE_${upper}_MIN_COUNT`, null);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }

  const defaultBaseline = name === 'vitest' ? 10000 : 7;
  const baseline = Math.max(1, numericEnv(`NEXUS_RELEASE_${upper}_BASELINE_COUNT`, defaultBaseline));
  const tolerancePct = Math.min(
    100,
    Math.max(0, numericEnv(`NEXUS_RELEASE_${upper}_COUNT_TOLERANCE_PCT`, numericEnv('NEXUS_RELEASE_TEST_COUNT_TOLERANCE_PCT', 10))),
  );
  return Math.max(1, Math.floor(baseline * (1 - tolerancePct / 100)));
}

function buildPayload() {
  const manifest = currentManifest();
  const currentSha = gitValue(['rev-parse', 'HEAD']);
  const branch = gitValue(['branch', '--show-current']);
  const now = new Date();
  const expiresHours = Number(readArg('--expires-hours', process.env.NEXUS_RELEASE_EVIDENCE_EXPIRES_HOURS || '72'));
  const includesIos = String(readArg('--includes-ios', process.env.NEXUS_RELEASE_INCLUDES_IOS || 'false')).toLowerCase() === 'true';
  const iosSha = readArg('--ios-sha', process.env.NEXUS_RELEASE_IOS_SHA || '');
  const iosBuildHash = readArg('--ios-build-hash', process.env.NEXUS_RELEASE_IOS_BUILD_HASH || '');
  const verdict = readArg('--verdict', process.env.NEXUS_RELEASE_VERDICT || 'passed');

  return {
    schema: 'nexus.release-evidence-payload.v2',
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresHours * 60 * 60 * 1000).toISOString(),
    verdict,
    engine: {
      sha: currentSha,
      shortSha: gitValue(['rev-parse', '--short', 'HEAD']),
      branch,
    },
    ci: {
      provider: process.env.NEXUS_RELEASE_CI_PROVIDER || (process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local'),
      workflow: process.env.GITHUB_WORKFLOW || null,
      runId: process.env.NEXUS_RELEASE_RUN_ID || process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.NEXUS_RELEASE_RUN_ATTEMPT || process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
    },
    ios: {
      includesIos,
      sha: iosSha || null,
      buildHash: iosBuildHash || null,
    },
    manifest: {
      schema: manifest.schema,
      digest: manifest.digest,
      fileCount: manifest.fileCount,
    },
    commands: {
      typecheck: commandResult('typecheck'),
      build: commandResult('build'),
      vitest: commandResult('vitest'),
      pytest: commandResult('pytest'),
      sciencePolicy: commandResult('sciencePolicy'),
      migrations: commandResult('migrations'),
      cannotSkipDashboard: commandResult('cannotSkipDashboard'),
      smoke: commandResult('smoke', 'not_run'),
      ios: includesIos ? commandResult('ios') : 'not_included',
    },
    testCounts: {
      vitest: countValue('vitest'),
      pytest: countValue('pytest'),
      ios: countValue('ios'),
    },
    cannotSkip: process.env.NEXUS_RELEASE_CANNOT_SKIP
      ? process.env.NEXUS_RELEASE_CANNOT_SKIP.split(',').map((value) => value.trim()).filter(Boolean)
      : [],
  };
}

function envelopeForPayload(payload) {
  const keyId = readArg('--key-id', process.env.NEXUS_RELEASE_EVIDENCE_KEY_ID || 'github-actions-release-evidence');
  const signature = signPayload(payload);
  if (!signature && !allowUnsigned) {
    emit({
      ok: false,
      reasons: ['private_key_missing'],
    }, 1);
  }
  return {
    schema: 'nexus.release-evidence.v2',
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: signature || null,
  };
}

function validateEvidenceObject(evidence) {
  const reasons = [];
  if (evidence?.schema !== 'nexus.release-evidence.v2') {
    reasons.push(`evidence_schema_unsupported:${evidence?.schema || 'missing'}`);
    return { reasons, payload: evidence?.payload || evidence };
  }

  const payload = evidence.payload;
  if (!payload || payload.schema !== 'nexus.release-evidence-payload.v2') {
    reasons.push(`payload_schema_unsupported:${payload?.schema || 'missing'}`);
    return { reasons, payload };
  }

  if (evidence.signatureAlgorithm !== 'ed25519') {
    reasons.push(`signature_algorithm_unsupported:${evidence.signatureAlgorithm || 'missing'}`);
  }
  const signatureCheck = verifyPayload(payload, evidence.signature);
  if (!signatureCheck.ok) reasons.push(signatureCheck.reason);

  return { reasons, payload };
}

function validate() {
  const resolvedEvidencePath = resolvedPath(evidencePath);
  const reasons = [];

  if (!fs.existsSync(resolvedEvidencePath)) {
    emit({
      ok: false,
      evidencePath: resolvedEvidencePath,
      reasons: ['evidence_file_missing'],
    }, 1);
  }

  let evidence = null;
  try {
    evidence = JSON.parse(fs.readFileSync(resolvedEvidencePath, 'utf8'));
  } catch (error) {
    emit({
      ok: false,
      evidencePath: resolvedEvidencePath,
      reasons: [`evidence_json_invalid:${error instanceof Error ? error.message : String(error)}`],
    }, 1);
  }

  const envelopeCheck = validateEvidenceObject(evidence);
  reasons.push(...envelopeCheck.reasons);
  const payload = envelopeCheck.payload || {};
  const manifest = currentManifest();
  const currentSha = gitValue(['rev-parse', 'HEAD']);
  const expectedSha = readArg('--expect-sha', currentSha || '');
  const fullShaPattern = /^[0-9a-f]{40}$/i;

  if (!expectedSha || !fullShaPattern.test(expectedSha)) {
    reasons.push(`engine_sha_unverifiable:${expectedSha || 'missing'}`);
  }

  if (!isPassed(payload.verdict)) {
    reasons.push(`verdict_not_passing:${payload.verdict || 'missing'}`);
  }

  const gotSha = payload?.engine?.sha || null;
  if (!gotSha) {
    reasons.push('engine_sha_missing');
  } else if (!fullShaPattern.test(gotSha)) {
    reasons.push(`engine_sha_invalid:${gotSha}`);
  } else if (expectedSha && gotSha !== expectedSha) {
    reasons.push(`engine_sha_mismatch:evidence=${gotSha}:current=${expectedSha}`);
  }

  const gotDigest = payload?.manifest?.digest || null;
  if (!gotDigest) {
    reasons.push('manifest_digest_missing');
  } else if (gotDigest !== manifest.digest) {
    reasons.push(`manifest_digest_mismatch:evidence=${gotDigest}:current=${manifest.digest}`);
  }

  const generatedAt = payload.generatedAt || null;
  if (generatedAt) {
    const ageSeconds = Math.floor((Date.now() - Date.parse(generatedAt)) / 1000);
    if (!Number.isFinite(ageSeconds)) {
      reasons.push(`generated_at_invalid:${generatedAt}`);
    } else if (ageSeconds < -300) {
      reasons.push(`generated_at_in_future:${generatedAt}`);
    } else if (maxAgeSeconds > 0 && ageSeconds > maxAgeSeconds) {
      reasons.push(`evidence_stale:${ageSeconds}s>${maxAgeSeconds}s`);
    }
  } else {
    reasons.push('generated_at_missing');
  }

  if (!payload.expiresAt) {
    reasons.push('expires_at_missing');
  } else if (!Number.isFinite(Date.parse(payload.expiresAt))) {
    reasons.push(`expires_at_invalid:${payload.expiresAt}`);
  } else if (Date.parse(payload.expiresAt) <= Date.now()) {
    reasons.push(`evidence_expired:${payload.expiresAt}`);
  }

  for (const commandName of REQUIRED_COMMANDS) {
    const result = payload?.commands?.[commandName];
    if (!isPassed(result)) {
      reasons.push(`command_not_passing:${commandName}:${result || 'missing'}`);
    }
  }

  for (const suiteName of ['vitest', 'pytest']) {
    const count = Number(payload?.testCounts?.[suiteName]);
    if (!Number.isFinite(count) || count <= 0) {
      reasons.push(`test_count_invalid:${suiteName}:${payload?.testCounts?.[suiteName] ?? 'missing'}`);
      continue;
    }
    const floor = minimumTestCount(suiteName);
    if (count < floor) {
      reasons.push(`test_count_below_floor:${suiteName}:${count}<${floor}`);
    }
  }

  emit({
    ok: reasons.length === 0,
    evidencePath: resolvedEvidencePath,
    reasons,
    current: {
      sha: currentSha,
      manifestDigest: manifest.digest,
    },
    evidence: {
      schema: evidence?.schema,
      keyId: evidence?.keyId,
      sha: gotSha,
      manifestDigest: gotDigest,
      verdict: payload.verdict || null,
      generatedAt,
      runId: payload?.ci?.runId || null,
      runAttempt: payload?.ci?.runAttempt || null,
      ci: payload.ci || {},
      commands: payload.commands || {},
      testCounts: payload.testCounts || {},
      testCountFloors: {
        vitest: minimumTestCount('vitest'),
        pytest: minimumTestCount('pytest'),
      },
    },
  }, reasons.length === 0 ? 0 : 1);
}

function writeEvidence() {
  const payload = buildPayload();
  const evidence = envelopeForPayload(payload);
  const resolvedEvidencePath = resolvedPath(evidencePath);

  fs.mkdirSync(path.dirname(resolvedEvidencePath), { recursive: true });
  fs.writeFileSync(resolvedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: resolvedEvidencePath, evidence }, null, 2)}\n`);
  } else {
    process.stdout.write(`release evidence written: ${resolvedEvidencePath}\n`);
  }
}

function signEvidence() {
  const inputPath = readArg('--input', evidencePath);
  const outputPath = readArg('--output', inputPath);
  const resolvedInput = resolvedPath(inputPath);
  const raw = JSON.parse(fs.readFileSync(resolvedInput, 'utf8'));
  const payload = raw.schema === 'nexus.release-evidence.v2' ? raw.payload : raw;
  const signed = envelopeForPayload(payload);
  const resolvedOutput = resolvedPath(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, `${JSON.stringify(signed, null, 2)}\n`);
  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: resolvedOutput, evidence: signed }, null, 2)}\n`);
  } else {
    process.stdout.write(`release evidence signed: ${resolvedOutput}\n`);
  }
}

if (command === 'validate' || command === 'verify') {
  validate();
} else if (command === 'write') {
  writeEvidence();
} else if (command === 'sign') {
  signEvidence();
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(64);
}
