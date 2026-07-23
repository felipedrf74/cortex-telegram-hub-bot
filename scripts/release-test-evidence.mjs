#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTestPolicy,
  partitionTestFiles,
  root,
  walkTestFiles,
} from './lib/test-policy.mjs';
import {
  compareProtectedMainToRelease,
  validateProtectedMainCiEvidence,
  validateReleaseShadowComparison,
} from './protected-main-ci-evidence.mjs';

export const NIGHTLY_EVIDENCE_SCHEMA = 'nexus.nightly-full-suite-evidence.v1';
export const RELEASE_SELECTION_SCHEMA = 'nexus.release-test-selection.v1';
export const RELEASE_RESULTS_SCHEMA = 'nexus.release-test-results.v3';
export const DEFAULT_RELEASE_TIER = 'changed-critical-cannot-skip';
export const FULL_RELEASE_TIER = 'full-sharded';
export const FULL_REQUIRED_REASONS = Object.freeze([
  'explicit_force',
  'full_suite_trigger',
  'test_topology_change',
  'unresolved_impact',
  'qualifying_nightly_evidence_stale',
  'qualifying_nightly_evidence_missing',
]);

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};

function booleanOption(name) {
  const indexes = args.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length === 0) return false;
  if (indexes.length !== 1) fail(`${name} may be provided only once`);
  const next = args[indexes[0] + 1];
  if (!next || next.startsWith('--')) return true;
  if (next === 'true') return true;
  if (next === 'false') return false;
  fail(`${name} must be true or false`);
}

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

function currentPolicyDigest() {
  return sha256(fs.readFileSync(path.join(root, 'config/test-policy.json')));
}

function releaseLockfileDigests() {
  return {
    packageLockSha256: sha256(fs.readFileSync(path.join(root, 'package-lock.json'))),
    pythonRequirementsSha256: sha256(fs.readFileSync(path.join(root, 'content-engine/requirements.txt'))),
  };
}

function cleanGitEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return { ...env, ...overrides };
}

function sortedUniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    fail(`${label} must be a non-empty-string array`);
  }
  const normalized = [...new Set(value)].sort();
  if (canonicalJson(value) !== canonicalJson(normalized)) fail(`${label} must be sorted and unique`);
  return normalized;
}

function assertTestFiles(files, label) {
  for (const file of files) {
    if (!/^__tests__\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file) || file.includes('..')) {
      fail(`${label} contains an invalid test path: ${file}`);
    }
  }
}

function normalizeReportTestPath(file) {
  const normalized = String(file).split(path.sep).join('/');
  if (normalized.startsWith('__tests__/')) return normalized;
  const marker = normalized.lastIndexOf('/__tests__/');
  if (marker !== -1) return normalized.slice(marker + 1);
  fail(`Vitest result does not identify a repository test file: ${file}`);
}

export function countVitestTests(value) {
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

export function vitestTestFiles(value) {
  if (!Array.isArray(value?.testResults)) return [];
  return [...new Set(value.testResults.map((entry) => normalizeReportTestPath(entry?.name ?? '')))].sort();
}

export function validateReleaseEvidencePolicy(policy = loadTestPolicy()) {
  const config = policy.releaseEvidence;
  exactKeys(config, ['defaultTier', 'fullTier', 'qualifyingNightly'], 'release evidence policy');
  if (config.defaultTier !== DEFAULT_RELEASE_TIER || config.fullTier !== FULL_RELEASE_TIER) {
    fail('release evidence tiers do not match the governed implementation');
  }
  exactKeys(
    config.qualifyingNightly,
    ['artifactPrefix', 'maxAgeHours', 'workflowName', 'workflowPath'],
    'qualifying nightly policy',
  );
  if (!Number.isSafeInteger(config.qualifyingNightly.maxAgeHours)
      || config.qualifyingNightly.maxAgeHours < 24
      || config.qualifyingNightly.maxAgeHours > 72) {
    fail('qualifying nightly max age is outside the governed range');
  }
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(config.qualifyingNightly.workflowPath)
      || typeof config.qualifyingNightly.workflowName !== 'string'
      || config.qualifyingNightly.workflowName.length < 3
      || config.qualifyingNightly.workflowName.length > 100
      || !/^[A-Za-z0-9_.-]+-$/.test(config.qualifyingNightly.artifactPrefix)) {
    fail('qualifying nightly workflow or artifact identity is invalid');
  }
  return config;
}

function git(...gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
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

function walkJsonFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
    }
  };
  walk(directory);
  return files.sort();
}

export function validateNightlyEvidence(evidence, {
  expectedPolicyDigest,
  expectedWorkflowName,
  nowMs,
  maxAgeHours,
  headSha,
  requireFresh = true,
  ancestorCheck = () => true,
} = {}) {
  exactKeys(evidence, [
    'schema', 'status', 'tier', 'headSha', 'completedAt', 'testPolicyDigest',
    'counts', 'testFiles', 'ci',
  ], 'nightly full-suite evidence');
  exactKeys(evidence.counts, ['vitest'], 'nightly full-suite counts');
  exactKeys(evidence.testFiles, ['count', 'digest'], 'nightly full-suite test files');
  exactKeys(evidence.ci, ['runId', 'runAttempt', 'workflow'], 'nightly full-suite CI identity');
  if (evidence.schema !== NIGHTLY_EVIDENCE_SCHEMA || evidence.status !== 'passed'
      || evidence.tier !== FULL_RELEASE_TIER) fail('nightly full-suite evidence status or schema is invalid');
  if (!/^[0-9a-f]{40}$/.test(evidence.headSha ?? '')) fail('nightly full-suite head SHA is invalid');
  if (headSha && !ancestorCheck(evidence.headSha, headSha)) fail('nightly full-suite SHA is not an RC ancestor');
  if (evidence.testPolicyDigest !== expectedPolicyDigest) fail('nightly full-suite policy digest mismatch');
  if (!Number.isSafeInteger(evidence.counts.vitest) || evidence.counts.vitest <= 0) {
    fail('nightly full-suite test count is invalid');
  }
  if (!Number.isSafeInteger(evidence.testFiles.count) || evidence.testFiles.count <= 0
      || !/^[0-9a-f]{64}$/.test(evidence.testFiles.digest ?? '')) {
    fail('nightly full-suite test file identity is invalid');
  }
  if (!/^\d+$/.test(String(evidence.ci.runId)) || !/^\d+$/.test(String(evidence.ci.runAttempt))) {
    fail('nightly full-suite CI identity is invalid');
  }
  if (evidence.ci.workflow !== expectedWorkflowName) fail('nightly full-suite workflow identity mismatch');
  const completedAtMs = Date.parse(evidence.completedAt);
  if (!Number.isFinite(completedAtMs) || completedAtMs > nowMs + 5 * 60_000) {
    fail('nightly full-suite timestamp is invalid or future-dated');
  }
  if (requireFresh && completedAtMs < nowMs - maxAgeHours * 3_600_000) {
    fail('nightly full-suite evidence is stale');
  }
  return evidence;
}

export function validateReleaseSelection(selection, {
  expectedHeadSha = '',
  expectedPolicyDigest = '',
} = {}) {
  exactKeys(selection, [
    'schema', 'tier', 'headSha', 'baseSha', 'policyDigest', 'fullRequired',
    'fullRequiredReason', 'selected', 'classifier', 'nightlyEvidence',
  ], 'release test selection');
  exactKeys(selection.selected, [
    'changed', 'critical', 'cannotSkip', 'removed', 'removedDigest',
    'unresolved', 'unresolvedDigest', 'files', 'filesDigest',
  ], 'release selected tests');
  exactKeys(selection.classifier, [
    'impactResolved', 'fullSuiteTrigger', 'cannotSkip',
  ], 'release selection classifier');
  if (selection.schema !== RELEASE_SELECTION_SCHEMA) fail('release test selection schema is invalid');
  if (!/^[0-9a-f]{40}$/.test(selection.headSha ?? '')
      || !/^[0-9a-f]{40}$/.test(selection.baseSha ?? '')) fail('release test selection SHA is invalid');
  if (expectedHeadSha && selection.headSha !== expectedHeadSha) fail('release test selection head SHA mismatch');
  if (!/^[0-9a-f]{64}$/.test(selection.policyDigest ?? '')) fail('release test selection policy digest is invalid');
  if (expectedPolicyDigest && selection.policyDigest !== expectedPolicyDigest) {
    fail('release test selection policy digest mismatch');
  }
  const changed = sortedUniqueStrings(selection.selected.changed, 'release changed tests');
  const critical = sortedUniqueStrings(selection.selected.critical, 'release critical tests');
  const cannotSkip = sortedUniqueStrings(selection.selected.cannotSkip, 'release cannot-skip tests');
  const removed = sortedUniqueStrings(selection.selected.removed, 'release removed test files');
  const unresolved = sortedUniqueStrings(selection.selected.unresolved, 'release unresolved dependency paths');
  const files = sortedUniqueStrings(selection.selected.files, 'release selected test files');
  assertTestFiles([...changed, ...critical, ...cannotSkip, ...removed, ...files], 'release test selection');
  if (unresolved.some((file) => !/^src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)
      || file.includes('..'))) {
    fail('release unresolved dependency paths contain an invalid production path');
  }
  if (selection.selected.unresolvedDigest !== sha256(canonicalJson(unresolved))) {
    fail('release unresolved dependency digest mismatch');
  }
  if (selection.selected.removedDigest !== sha256(canonicalJson(removed))) {
    fail('release removed test digest mismatch');
  }
  if (selection.selected.filesDigest !== sha256(canonicalJson(files))) {
    fail('release selected test digest mismatch');
  }
  const labels = sortedUniqueStrings(selection.classifier.cannotSkip, 'release cannot-skip labels');
  if (typeof selection.classifier.impactResolved !== 'boolean'
      || typeof selection.classifier.fullSuiteTrigger !== 'boolean') {
    fail('release classifier flags are invalid');
  }
  if (selection.fullRequired) {
    if (selection.tier !== FULL_RELEASE_TIER
        || !FULL_REQUIRED_REASONS.includes(selection.fullRequiredReason)) {
      fail('full release selection reason or tier is invalid');
    }
    if (selection.fullRequiredReason === 'full_suite_trigger'
        && !selection.classifier.fullSuiteTrigger) fail('full-suite trigger reason is not supported by classifier evidence');
    if (selection.fullRequiredReason === 'unresolved_impact'
        && selection.classifier.impactResolved) fail('unresolved-impact reason is not supported by classifier evidence');
    if (selection.fullRequiredReason === 'test_topology_change'
        && removed.length === 0) fail('test-topology reason is not supported by removed-test evidence');
  } else {
    if (selection.tier !== DEFAULT_RELEASE_TIER || selection.fullRequiredReason !== null) {
      fail('default release selection tier or reason is invalid');
    }
    if (!selection.classifier.impactResolved || selection.classifier.fullSuiteTrigger) {
      fail('default release selection contradicts classifier evidence');
    }
    if (unresolved.length > 0) fail('default release selection contains unresolved dependency impact');
    if (removed.length > 0) fail('default release selection contains removed test files');
    const union = [...new Set([...changed, ...critical, ...cannotSkip])].sort();
    if (canonicalJson(files) !== canonicalJson(union)) {
      fail('default release selection is not changed plus critical plus cannot-skip');
    }
  }
  if (selection.nightlyEvidence !== null) {
    exactKeys(selection.nightlyEvidence, [
      'headSha', 'completedAt', 'runId', 'runAttempt',
    ], 'release qualifying nightly identity');
    if (selection.baseSha !== selection.nightlyEvidence.headSha
        || !/^[0-9a-f]{40}$/.test(selection.nightlyEvidence.headSha)
        || !/^\d+$/.test(String(selection.nightlyEvidence.runId))
        || !/^\d+$/.test(String(selection.nightlyEvidence.runAttempt))
        || !Number.isFinite(Date.parse(selection.nightlyEvidence.completedAt))) {
      fail('release qualifying nightly identity is invalid');
    }
  }
  if ((!selection.fullRequired
      || selection.fullRequiredReason === 'full_suite_trigger'
      || selection.fullRequiredReason === 'unresolved_impact'
      || selection.fullRequiredReason === 'qualifying_nightly_evidence_stale')
      && selection.nightlyEvidence === null) {
    fail('release test selection reason requires nightly evidence identity');
  }
  if (selection.fullRequiredReason === 'qualifying_nightly_evidence_missing'
      && selection.nightlyEvidence !== null) {
    fail('missing-nightly release selection cannot claim nightly evidence identity');
  }
  return { ...selection, classifier: { ...selection.classifier, cannotSkip: labels } };
}

function selectQualifyingNightly({ nightlyDirectory, headSha, nowMs, policyDigest, policy }) {
  const candidates = [];
  const staleCandidates = [];
  for (const file of walkJsonFiles(nightlyDirectory)) {
    let evidence;
    try {
      evidence = readJson(file);
      validateNightlyEvidence(evidence, {
        expectedPolicyDigest: policyDigest,
        expectedWorkflowName: policy.qualifyingNightly.workflowName,
        nowMs,
        maxAgeHours: policy.qualifyingNightly.maxAgeHours,
        headSha,
        requireFresh: false,
        ancestorCheck: isAncestor,
      });
    } catch {
      continue;
    }
    if (Date.parse(evidence.completedAt) < nowMs - policy.qualifyingNightly.maxAgeHours * 3_600_000) {
      staleCandidates.push(evidence);
      continue;
    }
    candidates.push(evidence);
  }
  candidates.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  staleCandidates.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  return { evidence: candidates[0] ?? null, staleEvidence: staleCandidates[0] ?? null };
}

function runJson(commandName, commandArgs) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
    // The exact selected-file evidence is already larger than Node's small
    // default sync-process buffer. Keep the bound explicit so growth fails
    // predictably instead of truncating otherwise valid JSON at 64 KiB.
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) fail(result.stderr || result.stdout || `${commandName} failed`);
  return JSON.parse(result.stdout);
}

function writePlan() {
  const headSha = valueOf('--head', git('rev-parse', 'HEAD'));
  if (!/^[0-9a-f]{40}$/.test(headSha) || git('rev-parse', 'HEAD') !== headSha) {
    fail('release selection head must be the exact checkout SHA');
  }
  const out = path.resolve(root, valueOf('--out', '.local/release/test-selection.json'));
  const nightlyDirectory = path.resolve(root, valueOf('--nightly-dir', '.local/release/nightly-evidence'));
  const nowMs = Date.parse(valueOf('--now', new Date().toISOString()));
  if (!Number.isFinite(nowMs)) fail('release selection reference time is invalid');
  const policy = validateReleaseEvidencePolicy();
  const policyDigest = currentPolicyDigest();
  const forceFull = booleanOption('--force-full');
  const qualifying = selectQualifyingNightly({
    nightlyDirectory, headSha, nowMs, policyDigest, policy,
  });

  let classifier = null;
  let selected = null;
  const planEvidence = qualifying.evidence ?? (forceFull ? null : qualifying.staleEvidence);
  const baseSha = planEvidence?.headSha ?? headSha;
  classifier = runJson('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', baseSha]);
  const classifierPath = path.join(path.dirname(out), 'test-selection-classifier.json');
  writeJson(classifierPath, classifier);
  selected = runJson(process.execPath, [
    'scripts/select-vitest-files.mjs', '--base', baseSha, '--classifier', classifierPath, '--json',
  ]);

  let fullRequiredReason = null;
  if (forceFull) fullRequiredReason = 'explicit_force';
  else if (!qualifying.evidence) {
    fullRequiredReason = qualifying.staleEvidence
      ? 'qualifying_nightly_evidence_stale'
      : 'qualifying_nightly_evidence_missing';
  } else if ((selected?.removed ?? []).length > 0) fullRequiredReason = 'test_topology_change';
  else if (classifier?.flags?.fullSuiteTrigger) fullRequiredReason = 'full_suite_trigger';
  else if (selected?.impactResolved !== true) fullRequiredReason = 'unresolved_impact';

  const fullRequired = fullRequiredReason !== null;
  const allFiles = partitionTestFiles(walkTestFiles(), loadTestPolicy()).deterministic;
  const files = (fullRequired ? allFiles : selected.selected).sort();
  const boundNightlyEvidence = qualifying.evidence
    ?? (fullRequiredReason === 'qualifying_nightly_evidence_stale' ? qualifying.staleEvidence : null);
  const selection = {
    schema: RELEASE_SELECTION_SCHEMA,
    tier: fullRequired ? policy.fullTier : policy.defaultTier,
    headSha,
    baseSha,
    policyDigest,
    fullRequired,
    fullRequiredReason,
    selected: {
      changed: [...(selected?.changed ?? [])].sort(),
      critical: [...(selected?.critical ?? [])].sort(),
      cannotSkip: [...(selected?.cannotSkip ?? selected?.focused ?? [])].sort(),
      removed: [...(selected?.removed ?? [])].sort(),
      removedDigest: sha256(canonicalJson([...(selected?.removed ?? [])].sort())),
      unresolved: [...(selected?.unresolved ?? [])].sort(),
      unresolvedDigest: sha256(canonicalJson([...(selected?.unresolved ?? [])].sort())),
      files,
      filesDigest: sha256(canonicalJson(files)),
    },
    classifier: {
      impactResolved: selected?.impactResolved ?? false,
      fullSuiteTrigger: classifier?.flags?.fullSuiteTrigger ?? false,
      cannotSkip: [...new Set(classifier?.cannotSkip ?? [])].sort(),
    },
    nightlyEvidence: boundNightlyEvidence ? {
      headSha: boundNightlyEvidence.headSha,
      completedAt: boundNightlyEvidence.completedAt,
      runId: String(boundNightlyEvidence.ci.runId),
      runAttempt: String(boundNightlyEvidence.ci.runAttempt),
    } : null,
  };
  validateReleaseSelection(selection, { expectedHeadSha: headSha, expectedPolicyDigest: policyDigest });
  writeJson(out, selection);
  process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
}

function runSelected() {
  const selectionPath = path.resolve(root, valueOf('--selection'));
  const output = path.resolve(root, valueOf('--output', '.local/release/rc-test-results/vitest-results-selected.json'));
  const selection = validateReleaseSelection(readJson(selectionPath), {
    expectedHeadSha: git('rev-parse', 'HEAD'),
    expectedPolicyDigest: currentPolicyDigest(),
  });
  if (selection.fullRequired) fail('selected Vitest runner cannot execute a full-sharded plan');
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
  const result = spawnSync(process.execPath, [
    vitest, 'run', '--reporter=json', `--outputFile=${output}`, ...selection.selected.files,
  ], { cwd: root, stdio: 'inherit', env: cleanGitEnv({ NODE_ENV: 'test' }) });
  process.exit(result.status ?? 1);
}

function writeNightly() {
  const resultsPath = path.resolve(root, valueOf('--vitest-results'));
  const out = path.resolve(root, valueOf('--out'));
  const headSha = valueOf('--head', process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD'));
  const report = readJson(resultsPath);
  const count = countVitestTests(report);
  if (report.success !== true || count <= 0) fail('nightly full-suite Vitest result is not passing');
  const expectedTestFiles = partitionTestFiles(walkTestFiles(), loadTestPolicy()).deterministic;
  const reportedTestFiles = vitestTestFiles(report);
  if (canonicalJson(reportedTestFiles) !== canonicalJson(expectedTestFiles)) {
    fail('nightly full-suite report does not cover every deterministic Vitest file exactly once');
  }
  const policy = validateReleaseEvidencePolicy();
  const evidence = {
    schema: NIGHTLY_EVIDENCE_SCHEMA,
    status: 'passed',
    tier: FULL_RELEASE_TIER,
    headSha,
    completedAt: new Date().toISOString(),
    testPolicyDigest: currentPolicyDigest(),
    counts: { vitest: count },
    testFiles: {
      count: expectedTestFiles.length,
      digest: sha256(canonicalJson(expectedTestFiles)),
    },
    ci: {
      runId: String(process.env.GITHUB_RUN_ID ?? valueOf('--run-id')),
      runAttempt: String(process.env.GITHUB_RUN_ATTEMPT ?? valueOf('--run-attempt')),
      workflow: process.env.GITHUB_WORKFLOW ?? policy.qualifyingNightly.workflowName,
    },
  };
  validateNightlyEvidence(evidence, {
    expectedPolicyDigest: evidence.testPolicyDigest,
    expectedWorkflowName: policy.qualifyingNightly.workflowName,
    nowMs: Date.now(),
    maxAgeHours: policy.qualifyingNightly.maxAgeHours,
    headSha,
  });
  writeJson(out, evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

function writeResult() {
  const selectionPath = path.resolve(root, valueOf('--selection'));
  const resultsRoot = path.resolve(root, valueOf('--vitest-results-dir'));
  const pytestLogPath = path.resolve(root, valueOf('--pytest-log'));
  const out = path.resolve(root, valueOf('--out', '.local/release/test-results.json'));
  const runtimeSha = valueOf('--runtime-sha', process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD'));
  const artifactDigest = valueOf('--artifact-digest');
  if (!/^[0-9a-f]{64}$/.test(artifactDigest)) {
    fail('release result artifact digest is required');
  }
  const policyDigest = currentPolicyDigest();
  const selection = validateReleaseSelection(readJson(selectionPath), {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: policyDigest,
  });
  const expectedNames = selection.fullRequired
    ? [1, 2, 3, 4].map((shard) => `vitest-results-${shard}.json`)
    : ['vitest-results-selected.json'];
  const actualNames = fs.readdirSync(resultsRoot)
    .filter((name) => name.startsWith('vitest-results-') && name.endsWith('.json'))
    .sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    fail('release Vitest result files do not match the selected tier');
  }
  let vitestCount = 0;
  const reportedFiles = new Set();
  for (const name of actualNames) {
    const report = readJson(path.join(resultsRoot, name));
    if (report.success !== true) fail(`release Vitest result is not passing: ${name}`);
    vitestCount += countVitestTests(report);
    for (const file of vitestTestFiles(report)) reportedFiles.add(file);
  }
  if (vitestCount <= 0) fail('release Vitest count is invalid');
  if (canonicalJson([...reportedFiles].sort()) !== canonicalJson(selection.selected.files)) {
    fail('release Vitest reports do not match the exact selected files');
  }
  const pytestLog = fs.readFileSync(pytestLogPath, 'utf8');
  const pytestMatch = pytestLog.match(/(\d+)\s+passed(?:,|\s|$)/);
  const pytestCount = pytestMatch ? Number(pytestMatch[1]) : 0;
  if (!Number.isSafeInteger(pytestCount) || pytestCount <= 0) fail('release pytest count is invalid');
  const result = {
    schema: RELEASE_RESULTS_SCHEMA,
    status: valueOf('--status', 'passed'),
    runtimeSha,
    completedAt: new Date().toISOString(),
    tier: selection.tier,
    selection,
    testPolicyDigest: policyDigest,
    artifactDigest,
    lockfiles: releaseLockfileDigests(),
    toolchain: {
      node: process.version,
      python: valueOf('--python-version', process.env.NEXUS_RELEASE_PYTHON_VERSION ?? ''),
    },
    counts: { vitest: vitestCount, pytest: pytestCount },
    ci: {
      runId: String(valueOf('--run-id', process.env.GITHUB_RUN_ID ?? '')),
      runAttempt: String(valueOf('--run-attempt', process.env.GITHUB_RUN_ATTEMPT ?? '')),
    },
    protectedMainShadow: null,
  };
  if (result.status !== 'passed' || !/^\d+$/.test(result.ci.runId)
      || !/^\d+$/.test(result.ci.runAttempt) || !result.toolchain.python) {
    fail('release test result status, toolchain, or CI identity is invalid');
  }
  writeJson(out, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function validateReusedReleaseToolchain(mainEvidence, {
  nodeVersion = process.version,
  pythonVersion = '',
} = {}) {
  if (typeof pythonVersion !== 'string' || pythonVersion.length === 0
      || mainEvidence?.toolchain?.node !== nodeVersion
      || mainEvidence?.toolchain?.python !== pythonVersion) {
    fail('protected-main evidence toolchain does not match the release candidate');
  }
  return mainEvidence.toolchain;
}

async function writeReusedResult() {
  const selectionPath = path.resolve(root, valueOf('--selection'));
  const evidencePath = path.resolve(root, valueOf('--main-evidence'));
  const activationPath = path.resolve(root, valueOf('--activation'));
  const pytestLogPath = path.resolve(root, valueOf('--pytest-log'));
  const out = path.resolve(root, valueOf('--out', '.local/release/test-results.json'));
  const runtimeSha = valueOf('--runtime-sha', process.env.GITHUB_SHA ?? git('rev-parse', 'HEAD'));
  const selection = validateReleaseSelection(readJson(selectionPath), {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: currentPolicyDigest(),
  });
  const mainEvidence = validateProtectedMainCiEvidence(readJson(evidencePath), {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: currentPolicyDigest(),
  });
  const activation = readJson(activationPath);
  const { decideProtectedMainReuse } = await import('./protected-main-reuse-activation.mjs');
  const decision = decideProtectedMainReuse({
    activation,
    mainEvidence,
    selection,
    releaseEvidencePublicKeyPem: fs.readFileSync(path.join(
      root,
      'docs/release/evidence/release-evidence-public-key.pem',
    ), 'utf8'),
    repository: process.env.GITHUB_REPOSITORY ?? valueOf('--repository'),
    sourceRoot: root,
  });
  if (decision.allowed !== true) {
    fail(`protected-main reuse is not authorized: ${decision.reason}`);
  }
  const pytestLog = fs.readFileSync(pytestLogPath, 'utf8');
  const pytestMatch = pytestLog.match(/(\d+)\s+passed(?:,|\s|$)/);
  const pytestCount = pytestMatch ? Number(pytestMatch[1]) : 0;
  if (!Number.isSafeInteger(pytestCount) || pytestCount <= 0) {
    fail('release pytest count is invalid');
  }
  validateReusedReleaseToolchain(mainEvidence, {
    nodeVersion: process.version,
    pythonVersion: valueOf('--python-version', process.env.NEXUS_RELEASE_PYTHON_VERSION ?? ''),
  });
  const result = {
    schema: RELEASE_RESULTS_SCHEMA,
    status: valueOf('--status', 'passed'),
    runtimeSha,
    completedAt: new Date().toISOString(),
    tier: selection.tier,
    selection,
    testPolicyDigest: currentPolicyDigest(),
    artifactDigest: mainEvidence.build.artifactDigest,
    lockfiles: mainEvidence.lockfiles,
    toolchain: mainEvidence.toolchain,
    counts: { vitest: mainEvidence.vitest.tests, pytest: pytestCount },
    ci: {
      runId: String(valueOf('--run-id', process.env.GITHUB_RUN_ID ?? '')),
      runAttempt: String(valueOf('--run-attempt', process.env.GITHUB_RUN_ATTEMPT ?? '')),
    },
    protectedMainShadow: null,
  };
  if (result.status !== 'passed' || !/^\d+$/.test(result.ci.runId)
      || !/^\d+$/.test(result.ci.runAttempt)) {
    fail('reused release result status or CI identity is invalid');
  }
  const comparison = compareProtectedMainToRelease(mainEvidence, result);
  if (comparison.status !== 'eligible') {
    fail('protected-main evidence no longer exactly matches the release result');
  }
  result.protectedMainShadow = {
    mode: 'reuse',
    activation,
    comparison,
    evidence: mainEvidence,
  };
  writeJson(out, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function bindProtectedMainShadow() {
  const resultsPath = path.resolve(root, valueOf('--results', '.local/release/test-results.json'));
  const comparisonPath = path.resolve(root, valueOf('--comparison'));
  const evidenceArgument = valueOf('--main-evidence');
  const result = readJson(resultsPath);
  if (result.schema !== RELEASE_RESULTS_SCHEMA || result.status !== 'passed') {
    fail('only passing governed release results can bind protected-main shadow evidence');
  }
  if (result.protectedMainShadow !== null) fail('protected-main shadow evidence is already bound');
  const comparison = validateReleaseShadowComparison(readJson(comparisonPath), {
    expectedRuntimeSha: result.runtimeSha,
  });
  let evidence = null;
  if (evidenceArgument) {
    evidence = validateProtectedMainCiEvidence(readJson(path.resolve(root, evidenceArgument)), {
      expectedHeadSha: result.runtimeSha,
      expectedPolicyDigest: result.testPolicyDigest,
    });
    const recomputed = compareProtectedMainToRelease(evidence, result);
    const expected = { ...recomputed, comparedAt: comparison.comparedAt };
    if (canonicalJson(expected) !== canonicalJson(comparison)) {
      fail('release shadow comparison does not match the bound protected-main evidence');
    }
  } else if (comparison.mainCi !== null || comparison.status !== 'ineligible') {
    fail('missing protected-main evidence must produce an ineligible comparison without main CI identity');
  }
  result.protectedMainShadow = {
    mode: 'shadow',
    comparison,
    evidence,
  };
  writeJson(resultsPath, result);
  process.stdout.write(`${JSON.stringify(result.protectedMainShadow, null, 2)}\n`);
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (command === 'plan') writePlan();
  else if (command === 'run-selected') runSelected();
  else if (command === 'write-nightly') writeNightly();
  else if (command === 'write-result') writeResult();
  else if (command === 'write-reused-result') await writeReusedResult();
  else if (command === 'bind-protected-main-shadow') bindProtectedMainShadow();
  else fail('Usage: release-test-evidence.mjs <plan|run-selected|write-nightly|write-result|write-reused-result|bind-protected-main-shadow> [options]');
}
