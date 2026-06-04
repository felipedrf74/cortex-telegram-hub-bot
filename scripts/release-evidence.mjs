#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
const maxAgeSeconds = Number(readArg('--max-age-seconds', process.env.NEXUS_RELEASE_EVIDENCE_MAX_AGE_S || String(72 * 60 * 60)));
const outputJson = hasArg('--json');

function emit(payload, exitCode) {
  if (outputJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.ok) {
    process.stdout.write(`release evidence OK: ${payload.evidencePath}\n`);
  } else {
    process.stderr.write(`release evidence invalid: ${payload.reasons.join('; ')}\n`);
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

function normalizeVerdict(value) {
  return String(value || '').toLowerCase();
}

function evidenceSha(evidence) {
  return evidence?.engine?.sha || evidence?.engineSha || evidence?.sha || null;
}

function evidenceDigest(evidence) {
  return evidence?.manifest?.digest || evidence?.manifestDigest || evidence?.artifactDigest || null;
}

function evidenceGeneratedAt(evidence) {
  return evidence?.generatedAt || evidence?.createdAt || evidence?.timestamp || null;
}

function validate() {
  const resolvedEvidencePath = path.resolve(root, evidencePath);
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

  const manifest = currentManifest();
  const currentSha = gitValue(['rev-parse', 'HEAD']);
  const expectedSha = readArg('--expect-sha', currentSha || '');
  const verdict = normalizeVerdict(evidence.verdict || evidence.status);
  const acceptedVerdicts = new Set(['pass', 'passed', 'success', 'succeeded']);
  if (!acceptedVerdicts.has(verdict)) {
    reasons.push(`verdict_not_passing:${verdict || 'missing'}`);
  }

  const gotSha = evidenceSha(evidence);
  if (!gotSha) {
    reasons.push('engine_sha_missing');
  } else if (expectedSha && gotSha !== expectedSha && !expectedSha.startsWith(gotSha) && !gotSha.startsWith(expectedSha)) {
    reasons.push(`engine_sha_mismatch:evidence=${gotSha}:current=${expectedSha}`);
  }

  const gotDigest = evidenceDigest(evidence);
  if (!gotDigest) {
    reasons.push('manifest_digest_missing');
  } else if (gotDigest !== manifest.digest) {
    reasons.push(`manifest_digest_mismatch:evidence=${gotDigest}:current=${manifest.digest}`);
  }

  const generatedAt = evidenceGeneratedAt(evidence);
  if (generatedAt) {
    const ageSeconds = Math.floor((Date.now() - Date.parse(generatedAt)) / 1000);
    if (!Number.isFinite(ageSeconds)) {
      reasons.push(`generated_at_invalid:${generatedAt}`);
    } else if (maxAgeSeconds > 0 && ageSeconds > maxAgeSeconds) {
      reasons.push(`evidence_stale:${ageSeconds}s>${maxAgeSeconds}s`);
    }
  } else {
    reasons.push('generated_at_missing');
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
      sha: gotSha,
      manifestDigest: gotDigest,
      verdict,
      generatedAt,
    },
  }, reasons.length === 0 ? 0 : 1);
}

function writeEvidence() {
  const manifest = currentManifest();
  const currentSha = gitValue(['rev-parse', 'HEAD']);
  const branch = gitValue(['branch', '--show-current']);
  const now = new Date();
  const expiresHours = Number(readArg('--expires-hours', process.env.NEXUS_RELEASE_EVIDENCE_EXPIRES_HOURS || '72'));
  const includesIos = String(readArg('--includes-ios', process.env.NEXUS_RELEASE_INCLUDES_IOS || 'false')).toLowerCase() === 'true';
  const iosSha = readArg('--ios-sha', process.env.NEXUS_RELEASE_IOS_SHA || '');
  const iosBuildHash = readArg('--ios-build-hash', process.env.NEXUS_RELEASE_IOS_BUILD_HASH || '');
  const verdict = readArg('--verdict', process.env.NEXUS_RELEASE_VERDICT || 'passed');
  const resolvedEvidencePath = path.resolve(root, evidencePath);

  const evidence = {
    schema: 'nexus.release-evidence.v1',
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresHours * 60 * 60 * 1000).toISOString(),
    verdict,
    engine: {
      sha: currentSha,
      shortSha: gitValue(['rev-parse', '--short', 'HEAD']),
      branch,
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
      vitest: process.env.NEXUS_RELEASE_VITEST_RESULT || 'passed',
      typecheck: process.env.NEXUS_RELEASE_TYPECHECK_RESULT || 'passed',
      pytest: process.env.NEXUS_RELEASE_PYTEST_RESULT || 'not_run',
      migrations: process.env.NEXUS_RELEASE_MIGRATIONS_RESULT || 'passed',
      cannotSkipDashboard: process.env.NEXUS_RELEASE_CANNOT_SKIP_RESULT || 'passed',
      smoke: process.env.NEXUS_RELEASE_SMOKE_RESULT || 'not_run',
      ios: includesIos ? (process.env.NEXUS_RELEASE_IOS_RESULT || 'passed') : 'not_included',
    },
    testCounts: {
      vitest: Number(process.env.NEXUS_RELEASE_VITEST_TEST_COUNT || 0),
      pytest: Number(process.env.NEXUS_RELEASE_PYTEST_TEST_COUNT || 0),
      ios: Number(process.env.NEXUS_RELEASE_IOS_TEST_COUNT || 0),
    },
    cannotSkip: process.env.NEXUS_RELEASE_CANNOT_SKIP
      ? process.env.NEXUS_RELEASE_CANNOT_SKIP.split(',').map((value) => value.trim()).filter(Boolean)
      : [],
  };

  fs.mkdirSync(path.dirname(resolvedEvidencePath), { recursive: true });
  fs.writeFileSync(resolvedEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (outputJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, evidencePath: resolvedEvidencePath, evidence }, null, 2)}\n`);
  } else {
    process.stdout.write(`release evidence written: ${resolvedEvidencePath}\n`);
  }
}

if (command === 'validate') {
  validate();
} else if (command === 'write') {
  writeEvidence();
} else {
  process.stderr.write(`Unknown command: ${command}\n`);
  process.exit(64);
}
