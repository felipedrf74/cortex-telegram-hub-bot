import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGING_SMOKE_PROFILE = 'nexus.staging-smoke.canonical.token-zero-locale.v2';
export const STAGING_SMOKE_VALIDATION_SCHEMA = 'nexus.staging-smoke-evidence-validation.v1';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TRANSACTION_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/u;
const REQUIRED_CANONICAL_CHECKS = Object.freeze([
  'content-engine /health',
  'nexus-hub /api/snapshot',
  'snapshot.uptime',
  'snapshot.bot',
  'snapshot.integrations',
  'snapshot.apiUsage',
  'cost-by-domain.totalCost',
  'cost-by-domain.detailed',
  'cost-by-domain.providerSplit',
  'cost-by-domain.dailySeries',
  'provider-stats.providers',
  'iOS /api/v1/dashboard',
  'iOS /api/v1/tasks/lists',
  'iOS /api/v1/training/today',
  'iOS /api/v1/plan/today',
  'iOS chat-message route boundary',
  'pm2 nexus-hub online',
  'pm2 content-engine online',
  'pm2 nexus-hub restarts == 0',
  'training plan preview e2e',
  'locale fidelity chat smoke',
  'Staging DB integrity',
  'Ollama release policy',
  'immutable staging selector',
]);
const DOMAIN_PROBE_CHECKS = Object.freeze({
  training: 'domain training /api/v1/training/today',
  coachKernel: 'domain coach /api/v1/training/coach/briefing',
  calendar: 'domain calendar /api/v1/training/calendar',
  cooking: 'domain cooking /api/v1/cooking/recipes',
  content: 'domain content /api/v1/content/ideas',
  secretary: 'domain secretary /api/v1/plan/today',
  migration: 'domain migration count',
});

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readPrivateJson(filename, label) {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600
      || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
    fail(`${label} must be one private owner-controlled ordinary file`);
  }
  const bytes = fs.readFileSync(resolved);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  if (!isPlainObject(value)) fail(`${label} must contain one JSON object`);
  return {
    path: resolved,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    value,
  };
}

function strictTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
      || new Date(Date.parse(value)).toISOString() !== value) {
    fail(`${label} must be one canonical ISO timestamp`);
  }
  return Date.parse(value);
}

function requiredDomainProbes(classifier) {
  if (classifier.version !== '2' || !SHA_PATTERN.test(classifier.baseRef ?? '')
      || !SHA_PATTERN.test(classifier.head ?? '') || !isPlainObject(classifier.flags)
      || !isPlainObject(classifier.stagingSmoke)
      || classifier.stagingSmoke.generic !== true
      || !Array.isArray(classifier.stagingSmoke.domains)) {
    fail('staging smoke classifier result is invalid');
  }
  for (const domain of Object.keys(DOMAIN_PROBE_CHECKS)) {
    if (typeof classifier.flags[domain] !== 'boolean') {
      fail(`staging smoke classifier flag ${domain} is not boolean`);
    }
  }
  return Object.keys(DOMAIN_PROBE_CHECKS)
    .filter((domain) => classifier.flags[domain] === true)
    .sort();
}

function validateChecks(evidence, expectedDomains) {
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0) {
    fail('staging smoke checks are missing');
  }
  const seen = new Set();
  for (const [index, check] of evidence.checks.entries()) {
    if (!isPlainObject(check) || typeof check.name !== 'string' || !check.name.trim()
        || check.status !== 'passed'
        || !(check.detail === null || typeof check.detail === 'string')) {
      fail(`staging smoke check ${index} did not pass the strict contract`);
    }
    if (seen.has(check.name)) fail('staging smoke check names must be unique');
    seen.add(check.name);
  }

  const expectedNames = expectedDomains.map((domain) => DOMAIN_PROBE_CHECKS[domain]);
  const knownDomainNames = new Map(
    Object.entries(DOMAIN_PROBE_CHECKS).map(([domain, name]) => [name, domain]),
  );
  const actualDomainNames = evidence.checks
    .map((check) => check.name)
    .filter((name) => name.startsWith('domain '));
  if (actualDomainNames.some((name) => !knownDomainNames.has(name))) {
    fail('staging smoke evidence contains an unknown domain probe');
  }
  if (JSON.stringify([...actualDomainNames].sort()) !== JSON.stringify([...expectedNames].sort())) {
    fail('staging smoke domain probes do not match the exact classifier result');
  }
  const missingCanonical = REQUIRED_CANONICAL_CHECKS.filter((name) => !seen.has(name));
  if (missingCanonical.length > 0) {
    fail(`staging smoke canonical checks are missing: ${missingCanonical.join(', ')}`);
  }
  return evidence.checks.map((check) => ({
    name: check.name,
    status: check.status,
    detail: check.detail,
  }));
}

export function validateStagingSmokeEvidenceFile({
  evidencePath,
  classifierPath,
  stagingStatePath,
  expectedRuntimeSha,
  expectedArtifactDigest,
  expectedClassifierBaseSha,
  expectedEvidenceSha256 = '',
  expectedClassifierSha256 = '',
  expectedBindingPath = '',
}) {
  if (!SHA_PATTERN.test(expectedRuntimeSha ?? '')) fail('expected runtime SHA is invalid');
  if (!DIGEST_PATTERN.test(expectedArtifactDigest ?? '')) {
    fail('expected artifact digest is invalid');
  }
  if (!SHA_PATTERN.test(expectedClassifierBaseSha ?? '')) {
    fail('expected classifier base SHA is invalid');
  }
  if (expectedEvidenceSha256 && !DIGEST_PATTERN.test(expectedEvidenceSha256)) {
    fail('expected staging smoke evidence digest is invalid');
  }
  if (expectedClassifierSha256 && !DIGEST_PATTERN.test(expectedClassifierSha256)) {
    fail('expected staging smoke classifier digest is invalid');
  }

  const evidenceFile = readPrivateJson(evidencePath, 'staging smoke evidence');
  const classifierFile = readPrivateJson(classifierPath, 'staging smoke classifier');
  const stagingStateFile = readPrivateJson(stagingStatePath, 'staging release transaction');
  const evidence = evidenceFile.value;
  const classifier = classifierFile.value;
  const stagingState = stagingStateFile.value;

  if (expectedEvidenceSha256 && evidenceFile.sha256 !== expectedEvidenceSha256) {
    fail('staging smoke evidence digest changed after preparation');
  }
  if (expectedClassifierSha256 && classifierFile.sha256 !== expectedClassifierSha256) {
    fail('staging smoke classifier digest changed after preparation');
  }
  if (stagingState.schema !== 'nexus.lean-release-transaction.v1'
      || stagingState.role !== 'staging' || stagingState.phase !== 'completed'
      || stagingState.status !== 'passed'
      || !TRANSACTION_ID_PATTERN.test(stagingState.transactionId ?? '')
      || stagingState.runtimeSha !== expectedRuntimeSha
      || stagingState.artifactDigest !== expectedArtifactDigest) {
    fail('staging release transaction is not completed for the expected release');
  }

  const expectedDomains = requiredDomainProbes(classifier);
  if (classifier.baseRef !== expectedClassifierBaseSha
      || classifier.head !== expectedRuntimeSha) {
    fail('staging smoke classifier identity does not match the release');
  }
  if (evidence.version !== '2' || evidence.profile !== STAGING_SMOKE_PROFILE
      || evidence.host !== 'staging' || evidence.verdict !== 'passed'
      || evidence.sha !== expectedRuntimeSha || evidence.runtimeSha !== expectedRuntimeSha
      || evidence.artifactDigest !== expectedArtifactDigest
      || evidence.classifierBaseSha !== expectedClassifierBaseSha
      || evidence.classifierHeadSha !== expectedRuntimeSha) {
    fail('staging smoke evidence identity or verdict is invalid');
  }
  const stagingCompletedMs = strictTimestamp(
    stagingState.completedAt,
    'staging transaction completedAt',
  );
  const startedMs = strictTimestamp(evidence.runStartedAt, 'staging smoke runStartedAt');
  const completedMs = strictTimestamp(evidence.runCompletedAt, 'staging smoke runCompletedAt');
  if (startedMs < stagingCompletedMs || completedMs < startedMs) {
    fail('staging smoke did not run after the completed staging transaction');
  }

  const checks = validateChecks(evidence, expectedDomains);
  if (!isPlainObject(evidence.totals)
      || !Number.isSafeInteger(evidence.totals.passed)
      || !Number.isSafeInteger(evidence.totals.failed)
      || !Number.isSafeInteger(evidence.totals.total)
      || evidence.totals.total !== checks.length
      || evidence.totals.passed !== checks.length
      || evidence.totals.failed !== 0) {
    fail('staging smoke totals are inconsistent with its passing checks');
  }

  const result = {
    schema: STAGING_SMOKE_VALIDATION_SCHEMA,
    evidencePath: evidenceFile.path,
    evidenceSha256: evidenceFile.sha256,
    classifierPath: classifierFile.path,
    classifierSha256: classifierFile.sha256,
    stagingStatePath: stagingStateFile.path,
    stagingStateSha256: stagingStateFile.sha256,
    stagingTransactionId: stagingState.transactionId,
    runtimeSha: expectedRuntimeSha,
    artifactDigest: expectedArtifactDigest,
    evidenceVersion: evidence.version,
    profile: STAGING_SMOKE_PROFILE,
    host: 'staging',
    verdict: 'passed',
    stagingCompletedAt: stagingState.completedAt,
    runStartedAt: evidence.runStartedAt,
    runCompletedAt: evidence.runCompletedAt,
    totals: {
      passed: evidence.totals.passed,
      failed: evidence.totals.failed,
      total: evidence.totals.total,
    },
    checks,
    classifierBaseSha: expectedClassifierBaseSha,
    classifierHeadSha: expectedRuntimeSha,
    classifierVersion: classifier.version,
    domainProbes: expectedDomains,
  };
  if (expectedBindingPath) {
    const binding = readPrivateJson(expectedBindingPath, 'prepared release state').value;
    if (binding.schema !== 'nexus.lean-release-state.v1'
        || JSON.stringify(binding.stagingSmoke) !== JSON.stringify(result)) {
      fail('prepared release state staging smoke binding changed after preparation');
    }
  }
  return result;
}

function valueOf(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) fail(`${name} is required`);
  return args[index + 1];
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== 'validate') fail('usage: staging-smoke-evidence.mjs validate [options]');
  const result = validateStagingSmokeEvidenceFile({
    evidencePath: valueOf(args, '--evidence'),
    classifierPath: valueOf(args, '--classifier'),
    stagingStatePath: valueOf(args, '--staging-state'),
    expectedRuntimeSha: valueOf(args, '--expect-runtime-sha'),
    expectedArtifactDigest: valueOf(args, '--expect-artifact-digest'),
    expectedClassifierBaseSha: valueOf(args, '--expect-classifier-base-sha'),
    expectedEvidenceSha256: args.includes('--expect-evidence-sha256')
      ? valueOf(args, '--expect-evidence-sha256')
      : '',
    expectedClassifierSha256: args.includes('--expect-classifier-sha256')
      ? valueOf(args, '--expect-classifier-sha256')
      : '',
    expectedBindingPath: args.includes('--expect-binding')
      ? valueOf(args, '--expect-binding')
      : '',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
