#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTestPolicy,
  partitionTestFiles,
  root,
  walkTestFiles,
} from './lib/test-policy.mjs';

export const PROTECTED_MAIN_CI_SCHEMA = 'nexus.protected-main-ci-evidence.v1';
export const RELEASE_SHADOW_COMPARISON_SCHEMA = 'nexus.release-evidence-shadow-comparison.v1';
export const PROTECTED_MAIN_WORKFLOW = 'CI — Risk-based parallel matrix';
export const PROTECTED_MAIN_REUSE_SCOPE = 'vitest-and-exact-runtime-bundle-shadow';
export const RELEASE_SHADOW_CHECKS = Object.freeze([
  'exactRuntimeSha',
  'testPolicyMatch',
  'packageLockMatch',
  'pythonRequirementsMatch',
  'nodeToolchainMatch',
  'pythonToolchainMatch',
  'mainSelectionCoversRelease',
  'protectedJobsPassed',
  'runtimeArtifactMatch',
]);

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fileSha(relativePath) {
  return sha256(fs.readFileSync(path.join(root, relativePath)));
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
  ]) delete env[key];
  return env;
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: root,
    env: cleanGitEnv(),
    encoding: 'utf8',
  }).trim();
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      env: cleanGitEnv(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeTestPath(file) {
  const normalized = String(file).split(path.sep).join('/');
  if (normalized.startsWith('__tests__/')) return normalized;
  const marker = normalized.lastIndexOf('/__tests__/');
  if (marker !== -1) return normalized.slice(marker + 1);
  fail(`Vitest result does not identify a repository test file: ${file}`);
}

function countVitestTests(value) {
  if (!value || typeof value !== 'object') return 0;
  if (typeof value.numTotalTests === 'number') return value.numTotalTests;
  if (typeof value.totalTestCount === 'number') return value.totalTestCount;
  if (Array.isArray(value.assertionResults)) return value.assertionResults.length;
  let total = 0;
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) total += child.reduce((sum, item) => sum + countVitestTests(item), 0);
    else if (child && typeof child === 'object') total += countVitestTests(child);
  }
  return total;
}

function reportedTestFiles(report) {
  if (!Array.isArray(report?.testResults)) return [];
  return [...new Set(report.testResults.map((entry) => normalizeTestPath(entry?.name ?? '')))].sort();
}

function expectedTestFiles(mode, baseSha) {
  if (mode === 'full') {
    return partitionTestFiles(walkTestFiles(), loadTestPolicy()).deterministic;
  }
  if (!['focused', 'changed-only'].includes(mode)) fail(`protected-main Vitest mode is not reusable: ${mode}`);
  const classifier = JSON.parse(execFileSync('bash', [
    'scripts/changed-area-classifier.sh', '--base', baseSha, '--format', 'json',
  ], { cwd: root, env: cleanGitEnv(), encoding: 'utf8' }));
  const classifierPath = path.join(root, '.local/ci-evidence/protected-main-classifier.json');
  writeJson(classifierPath, classifier);
  const selection = JSON.parse(execFileSync(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', baseSha, '--classifier', classifierPath, '--json',
  ], { cwd: root, env: cleanGitEnv(), encoding: 'utf8' }));
  if (selection.impactResolved !== true || (selection.removed ?? []).length > 0) {
    fail('protected-main focused selection is unresolved or removes test topology');
  }
  return selection.selected;
}

function normalizedJobs(raw) {
  const resultOf = (name) => raw?.[name]?.result ?? null;
  const jobs = {
    classify: resultOf('classify'),
    tests: resultOf('test'),
    lint: resultOf('lint'),
    build: resultOf('build'),
    sciencePolicy: resultOf('science_policy'),
    python: resultOf('python-test'),
    migrations: resultOf('migrations'),
  };
  for (const name of ['classify', 'tests', 'lint', 'build', 'sciencePolicy']) {
    if (jobs[name] !== 'success') fail(`protected-main required job did not pass: ${name}`);
  }
  for (const name of ['python', 'migrations']) {
    if (!['success', 'skipped'].includes(jobs[name])) {
      fail(`protected-main conditional job has an invalid result: ${name}`);
    }
  }
  return jobs;
}

export function validateProtectedMainCiEvidence(evidence, {
  expectedHeadSha = '',
  expectedPolicyDigest = '',
} = {}) {
  exactKeys(evidence, [
    'schema', 'status', 'reuseScope', 'headSha', 'baseSha', 'completedAt',
    'testPolicyDigest', 'lockfiles', 'toolchain', 'vitest', 'build', 'ci', 'jobs',
  ], 'protected-main CI evidence');
  exactKeys(evidence.lockfiles, ['packageLockSha256', 'pythonRequirementsSha256'], 'protected-main lockfiles');
  exactKeys(evidence.toolchain, ['node', 'python'], 'protected-main toolchain');
  exactKeys(evidence.vitest, ['mode', 'files', 'filesDigest', 'tests'], 'protected-main Vitest evidence');
  exactKeys(evidence.build, ['artifactName', 'artifactDigest'], 'protected-main build evidence');
  exactKeys(evidence.ci, [
    'repository', 'workflow', 'runId', 'runAttempt', 'event', 'ref',
  ], 'protected-main CI identity');
  exactKeys(evidence.jobs, [
    'classify', 'tests', 'lint', 'build', 'sciencePolicy', 'python', 'migrations',
  ], 'protected-main job results');
  if (evidence.schema !== PROTECTED_MAIN_CI_SCHEMA || evidence.status !== 'passed'
      || evidence.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE) fail('protected-main CI evidence schema or status is invalid');
  if (!/^[0-9a-f]{40}$/.test(evidence.headSha ?? '')
      || !/^[0-9a-f]{40}$/.test(evidence.baseSha ?? '')) fail('protected-main CI SHA identity is invalid');
  if (expectedHeadSha && evidence.headSha !== expectedHeadSha) fail('protected-main CI head SHA mismatch');
  if (!/^[0-9a-f]{64}$/.test(evidence.testPolicyDigest ?? '')
      || (expectedPolicyDigest && evidence.testPolicyDigest !== expectedPolicyDigest)) {
    fail('protected-main CI test-policy digest mismatch');
  }
  for (const digest of Object.values(evidence.lockfiles)) {
    if (!/^[0-9a-f]{64}$/.test(digest ?? '')) fail('protected-main lockfile digest is invalid');
  }
  if (evidence.toolchain.node !== 'v22.23.1'
      || !/^Python 3\.12\.\d+$/.test(evidence.toolchain.python ?? '')) {
    fail('protected-main toolchain is outside policy');
  }
  if (!['full', 'focused', 'changed-only'].includes(evidence.vitest.mode)) fail('protected-main Vitest mode is invalid');
  if (!Array.isArray(evidence.vitest.files) || evidence.vitest.files.length === 0
      || evidence.vitest.files.some((file) => !/^__tests__\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file))) {
    fail('protected-main Vitest file identity is invalid');
  }
  const sortedFiles = [...new Set(evidence.vitest.files)].sort();
  if (canonicalJson(sortedFiles) !== canonicalJson(evidence.vitest.files)
      || evidence.vitest.filesDigest !== sha256(canonicalJson(sortedFiles))) {
    fail('protected-main Vitest file digest mismatch');
  }
  if (!Number.isSafeInteger(evidence.vitest.tests) || evidence.vitest.tests <= 0) {
    fail('protected-main Vitest test count is invalid');
  }
  if (!/^release-bundle-[0-9a-f]{40}-[0-9a-f]{64}$/.test(evidence.build.artifactName ?? '')
      || !/^[0-9a-f]{64}$/.test(evidence.build.artifactDigest ?? '')) {
    fail('protected-main build artifact identity is invalid');
  }
  if (evidence.build.artifactName !== `release-bundle-${evidence.headSha}-${evidence.build.artifactDigest}`) {
    fail('protected-main build artifact name is not bound to its exact SHA and digest');
  }
  if (evidence.ci.workflow !== PROTECTED_MAIN_WORKFLOW || evidence.ci.event !== 'push'
      || evidence.ci.ref !== 'refs/heads/main' || !/^\d+$/.test(String(evidence.ci.runId))
      || !/^\d+$/.test(String(evidence.ci.runAttempt)) || !evidence.ci.repository) {
    fail('protected-main GitHub identity is invalid');
  }
  const completedAt = Date.parse(evidence.completedAt);
  if (!Number.isFinite(completedAt) || completedAt > Date.now() + 5 * 60_000) {
    fail('protected-main completion timestamp is invalid');
  }
  for (const name of ['classify', 'tests', 'lint', 'build', 'sciencePolicy']) {
    if (evidence.jobs[name] !== 'success') fail(`protected-main job evidence did not pass: ${name}`);
  }
  for (const name of ['python', 'migrations']) {
    if (!['success', 'skipped'].includes(evidence.jobs[name])) fail(`protected-main conditional job is invalid: ${name}`);
  }
  return evidence;
}

function writeEvidence() {
  const headSha = valueOf('--head', process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD'));
  const baseSha = valueOf('--base');
  const mode = valueOf('--mode');
  const resultRoot = path.resolve(root, valueOf('--vitest-results-dir'));
  const out = path.resolve(root, valueOf('--out', '.local/ci-evidence/protected-main-ci-evidence.json'));
  if (git('rev-parse', 'HEAD') !== headSha || !/^[0-9a-f]{40}$/.test(baseSha)
      || !isAncestor(baseSha, headSha)) {
    fail('protected-main evidence requires an exact checkout and ancestor base');
  }
  const expectedFiles = expectedTestFiles(mode, baseSha);
  const resultNames = fs.readdirSync(resultRoot).filter((name) => /^vitest-results-(?:[1-4]|selected)\.json$/.test(name)).sort();
  const expectedNames = mode === 'full'
    ? ['vitest-results-1.json', 'vitest-results-2.json', 'vitest-results-3.json', 'vitest-results-4.json']
    : ['vitest-results-selected.json'];
  if (canonicalJson(resultNames) !== canonicalJson(expectedNames)) fail('protected-main Vitest result set does not match its mode');
  const observedFiles = new Set();
  let tests = 0;
  for (const name of resultNames) {
    const report = readJson(path.join(resultRoot, name));
    if (report.success !== true) fail(`protected-main Vitest report did not pass: ${name}`);
    tests += countVitestTests(report);
    for (const file of reportedTestFiles(report)) observedFiles.add(file);
  }
  if (canonicalJson([...observedFiles].sort()) !== canonicalJson(expectedFiles)) {
    fail('protected-main Vitest reports do not match the governed selection');
  }
  const jobs = normalizedJobs(JSON.parse(process.env.NEXUS_CI_NEEDS_JSON ?? '{}'));
  const evidence = {
    schema: PROTECTED_MAIN_CI_SCHEMA,
    status: 'passed',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    headSha,
    baseSha,
    completedAt: new Date().toISOString(),
    testPolicyDigest: fileSha('config/test-policy.json'),
    lockfiles: {
      packageLockSha256: fileSha('package-lock.json'),
      pythonRequirementsSha256: fileSha('content-engine/requirements.txt'),
    },
    toolchain: {
      node: process.version,
      python: valueOf('--python-version', process.env.NEXUS_RELEASE_PYTHON_VERSION ?? ''),
    },
    vitest: {
      mode,
      files: expectedFiles,
      filesDigest: sha256(canonicalJson(expectedFiles)),
      tests,
    },
    build: {
      artifactName: valueOf('--build-artifact-name'),
      artifactDigest: valueOf('--build-artifact-digest'),
    },
    ci: {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      workflow: process.env.GITHUB_WORKFLOW ?? '',
      runId: String(process.env.GITHUB_RUN_ID ?? ''),
      runAttempt: String(process.env.GITHUB_RUN_ATTEMPT ?? ''),
      event: process.env.GITHUB_EVENT_NAME ?? '',
      ref: process.env.GITHUB_REF ?? '',
    },
    jobs,
  };
  validateProtectedMainCiEvidence(evidence, {
    expectedHeadSha: headSha,
    expectedPolicyDigest: fileSha('config/test-policy.json'),
  });
  writeJson(out, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

export function compareProtectedMainToRelease(mainEvidence, releaseResults) {
  validateProtectedMainCiEvidence(mainEvidence, {
    expectedHeadSha: releaseResults?.runtimeSha ?? '',
    expectedPolicyDigest: releaseResults?.testPolicyDigest ?? '',
  });
  const releaseFiles = releaseResults?.selection?.selected?.files;
  if (!Array.isArray(releaseFiles) || releaseFiles.length === 0) fail('release result selection is missing');
  if (!releaseResults?.lockfiles || !/^[0-9a-f]{64}$/.test(releaseResults.lockfiles.packageLockSha256 ?? '')
      || !/^[0-9a-f]{64}$/.test(releaseResults.lockfiles.pythonRequirementsSha256 ?? '')) {
    fail('release result lockfile identity is missing');
  }
  if (!/^[0-9a-f]{64}$/.test(releaseResults?.artifactDigest ?? '')) {
    fail('release result artifact digest is missing');
  }
  const mainFiles = new Set(mainEvidence.vitest.files);
  const checks = {
    exactRuntimeSha: mainEvidence.headSha === releaseResults.runtimeSha,
    testPolicyMatch: mainEvidence.testPolicyDigest === releaseResults.testPolicyDigest,
    packageLockMatch: mainEvidence.lockfiles.packageLockSha256
      === releaseResults.lockfiles.packageLockSha256,
    pythonRequirementsMatch: mainEvidence.lockfiles.pythonRequirementsSha256
      === releaseResults.lockfiles.pythonRequirementsSha256,
    nodeToolchainMatch: mainEvidence.toolchain.node === releaseResults?.toolchain?.node,
    pythonToolchainMatch: mainEvidence.toolchain.python === releaseResults?.toolchain?.python,
    mainSelectionCoversRelease: releaseFiles.every((file) => mainFiles.has(file)),
    protectedJobsPassed: mainEvidence.status === 'passed',
    runtimeArtifactMatch: mainEvidence.build.artifactDigest === releaseResults.artifactDigest,
  };
  const eligible = Object.values(checks).every(Boolean);
  return {
    schema: RELEASE_SHADOW_COMPARISON_SCHEMA,
    status: eligible ? 'eligible' : 'ineligible',
    reason: eligible ? null : 'protected_main_evidence_mismatch',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    runtimeSha: releaseResults.runtimeSha,
    comparedAt: new Date().toISOString(),
    mainCi: {
      runId: mainEvidence.ci.runId,
      runAttempt: mainEvidence.ci.runAttempt,
      artifactDigest: mainEvidence.build.artifactDigest,
    },
    releaseCi: {
      runId: String(releaseResults?.ci?.runId ?? ''),
      runAttempt: String(releaseResults?.ci?.runAttempt ?? ''),
    },
    checks,
  };
}

export function validateReleaseShadowComparison(comparison, { expectedRuntimeSha = '' } = {}) {
  exactKeys(comparison, [
    'schema', 'status', 'reason', 'reuseScope', 'runtimeSha', 'comparedAt',
    'mainCi', 'releaseCi', 'checks',
  ], 'release shadow comparison');
  exactKeys(comparison.releaseCi, ['runId', 'runAttempt'], 'release shadow CI identity');
  exactKeys(comparison.checks, RELEASE_SHADOW_CHECKS, 'release shadow checks');
  if (comparison.schema !== RELEASE_SHADOW_COMPARISON_SCHEMA
      || comparison.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE
      || !['eligible', 'ineligible'].includes(comparison.status)) {
    fail('release shadow comparison schema or status is invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(comparison.runtimeSha ?? '')
      || (expectedRuntimeSha && comparison.runtimeSha !== expectedRuntimeSha)) {
    fail('release shadow comparison runtime SHA is invalid');
  }
  if (!Number.isFinite(Date.parse(comparison.comparedAt))
      || Date.parse(comparison.comparedAt) > Date.now() + 5 * 60_000) {
    fail('release shadow comparison timestamp is invalid');
  }
  if (Object.values(comparison.checks).some((value) => typeof value !== 'boolean')) {
    fail('release shadow comparison checks are invalid');
  }
  const eligible = Object.values(comparison.checks).every(Boolean);
  if ((comparison.status === 'eligible') !== eligible
      || (eligible && comparison.reason !== null)
      || (!eligible && typeof comparison.reason !== 'string')) {
    fail('release shadow comparison verdict is inconsistent');
  }
  if (comparison.mainCi !== null) {
    exactKeys(comparison.mainCi, ['runId', 'runAttempt', 'artifactDigest'], 'protected-main shadow identity');
    if (!/^\d+$/.test(String(comparison.mainCi.runId))
        || !/^\d+$/.test(String(comparison.mainCi.runAttempt))
        || !/^[0-9a-f]{64}$/.test(comparison.mainCi.artifactDigest ?? '')) {
      fail('protected-main shadow identity is invalid');
    }
  }
  if (!/^\d+$/.test(String(comparison.releaseCi.runId))
      || !/^\d+$/.test(String(comparison.releaseCi.runAttempt))) {
    fail('release shadow CI identity is invalid');
  }
  return comparison;
}

function writeMissingComparison() {
  const releaseResults = readJson(path.resolve(root, valueOf('--release-results')));
  const out = path.resolve(root, valueOf('--out', '.local/release/protected-main-shadow-comparison.json'));
  const comparison = {
    schema: RELEASE_SHADOW_COMPARISON_SCHEMA,
    status: 'ineligible',
    reason: valueOf('--reason', 'protected_main_evidence_missing'),
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    runtimeSha: releaseResults.runtimeSha,
    comparedAt: new Date().toISOString(),
    mainCi: null,
    releaseCi: {
      runId: String(releaseResults?.ci?.runId ?? ''),
      runAttempt: String(releaseResults?.ci?.runAttempt ?? ''),
    },
    checks: Object.fromEntries(RELEASE_SHADOW_CHECKS.map((name) => [name, false])),
  };
  validateReleaseShadowComparison(comparison, { expectedRuntimeSha: releaseResults.runtimeSha });
  writeJson(out, comparison);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

function compareEvidence() {
  const mainEvidence = readJson(path.resolve(root, valueOf('--main-evidence')));
  const releaseResults = readJson(path.resolve(root, valueOf('--release-results')));
  const out = path.resolve(root, valueOf('--out', '.local/release/protected-main-shadow-comparison.json'));
  const comparison = compareProtectedMainToRelease(mainEvidence, releaseResults);
  validateReleaseShadowComparison(comparison, { expectedRuntimeSha: releaseResults.runtimeSha });
  writeJson(out, comparison);
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (command === 'write') writeEvidence();
  else if (command === 'compare') compareEvidence();
  else if (command === 'missing') writeMissingComparison();
  else fail('Usage: protected-main-ci-evidence.mjs <write|compare|missing> [options]');
}
