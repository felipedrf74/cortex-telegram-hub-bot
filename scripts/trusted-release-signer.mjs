#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  sha256,
  verifyReleaseBundle,
} from './lib/release-artifact-manifest.mjs';
import {
  DEFAULT_RELEASE_TIER,
  FULL_RELEASE_TIER,
  RELEASE_RESULTS_SCHEMA,
  validateReleaseEvidencePolicy,
  validateNightlyEvidence,
  validateReleaseSelection,
  vitestTestFiles,
} from './release-test-evidence.mjs';
import {
  compareProtectedMainToRelease,
  validateProtectedMainCiEvidence,
  validateReleaseShadowComparison,
} from './protected-main-ci-evidence.mjs';
import { loadTestPolicy, partitionTestFiles, walkTestFiles } from './lib/test-policy.mjs';
import {
  BACKEND_IOS_CONTRACT_FIXTURE_PATH,
  BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA,
  backendIosContractDigest,
  backendIosContractFixtureIdentity,
} from './lib/backend-ios-contract-fixture.mjs';
import {
  IOS_DISTRIBUTION_ATTESTATION_FILE,
  validateIosDistributionAttestation,
} from './lib/ios-distribution-attestation.mjs';
import { validateRuntimeDependencyLock } from './release-runtime-dependencies.mjs';

export { backendIosContractDigest } from './lib/backend-ios-contract-fixture.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'verify-candidate';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const TRUSTED_KEY_ID = 'github-environment-release-signing-2026-07';
const TRUSTED_WORKFLOW_PATH = '.github/workflows/release-candidate-evidence.yml';
const TRUSTED_WORKFLOW_NAME = 'RC — Release Evidence';
const CANDIDATE_ARTIFACT_PREFIX = 'release-candidate-v2-';
const IOS_REPOSITORY = 'felipedrf74/nexus-hub-ios';
const IOS_WORKFLOW_PATH = '.github/workflows/ios-contract-evidence.yml';
const IOS_WORKFLOW_NAME = 'iOS Contract Evidence';
const IOS_ATTESTATION_FILE = 'ios-contract-attestation.json';
const IOS_ATTESTATION_KEY_ID = 'ios-release-signing-2026-07';
const IOS_ATTESTATION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const IOS_ATTESTATION_PUBLIC_KEY_PATH = 'docs/release/evidence/ios-contract-evidence-public-key.pem';
const IOS_CONTRACT_SUITE_NAME = 'Nexus Hub contract decoder suite';
export const IOS_CONTRACT_TEST_SELECTORS = Object.freeze([
  'Nexus HubTests/BackendCandidateContractFixtureTests',
  'Nexus HubTests/ContractDecoderResilienceTests',
  'Nexus HubTests/HomeViewStateContractDecodingTests',
  'Nexus HubTests/TrainingHomeViewStateContractDecodingTests',
  'Nexus HubTests/ContentHomeContractDecodingTests',
  'Nexus HubTests/PlanGenerateResponseRaceDateTests',
  'Nexus HubTests/PlanGenerateResponseExpertCoachTests',
  'Nexus HubTests/PlanGenerateResponsePrimaryFocusTests',
]);
const RELEASE_RESULT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const MANIFEST_LIFETIME_MS = 72 * 60 * 60 * 1_000;
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

function resolveRequired(name) {
  const value = valueOf(name);
  if (!value) fail(`${name} is required`);
  return path.resolve(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) fail(`${label} fields do not match the trusted schema`);
}

function validateContractScopeInputs({
  contractScope,
  hasIosEvidence = false,
  hasIosDistributionEvidence = false,
}) {
  if (contractScope === 'backend_only') {
    if (hasIosEvidence || hasIosDistributionEvidence) {
      fail('backend-only release must not include iOS evidence');
    }
    return false;
  }
  if (contractScope !== 'shared_backend_ios') fail('release contract scope is invalid');
  if (!hasIosEvidence) fail('shared backend/iOS release requires signed iOS evidence');
  if (!hasIosDistributionEvidence) {
    fail('shared backend/iOS release requires signed iOS distribution evidence');
  }
  return true;
}

export function validateIosContractAttestation({
  attestation,
  runtimeSha,
  artifactDigest,
  fixtureIdentity,
  trustedRoot = scriptRoot,
  nowMs = Date.now(),
}) {
  exactKeys(attestation, [
    'schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature',
  ], 'iOS contract attestation envelope');
  if (attestation.schema !== 'nexus.ios-contract-attestation.v2'
      || attestation.keyId !== IOS_ATTESTATION_KEY_ID
      || attestation.signatureAlgorithm !== 'ed25519'
      || typeof attestation.signature !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(attestation.signature)) {
    fail('iOS contract attestation envelope identity is invalid');
  }
  const payload = attestation.payload;
  exactKeys(payload, [
    'schema', 'generatedAt', 'expiresAt', 'ios', 'backend', 'contractSuite', 'ci',
  ], 'iOS contract attestation payload');
  if (payload.schema !== 'nexus.ios-contract-attestation-payload.v2') {
    fail('iOS contract attestation payload schema is invalid');
  }
  exactKeys(payload.ios, ['repository', 'sha', 'buildNumber'], 'iOS contract source identity');
  if (payload.ios.repository !== IOS_REPOSITORY
      || !/^[0-9a-f]{40}$/.test(payload.ios.sha ?? '')
      || !/^[1-9][0-9]*$/.test(String(payload.ios.buildNumber ?? ''))) {
    fail('iOS contract source identity is invalid or mismatched');
  }
  const buildNumber = Number(payload.ios.buildNumber);
  if (!Number.isSafeInteger(buildNumber)) fail('iOS contract build number is invalid');

  const expectedContractDigest = backendIosContractDigest({
    runtimeSha,
    artifactDigest,
    fixtureDigest: fixtureIdentity.digest,
  });
  exactKeys(payload.backend, [
    'repository', 'runtimeSha', 'artifactDigest', 'contractDigest', 'fixture',
  ], 'iOS contract backend identity');
  exactKeys(payload.backend.fixture, ['schema', 'path', 'digest'], 'iOS contract fixture identity');
  if (payload.backend.repository !== 'felipedrf74/cortex-telegram-hub-bot'
      || payload.backend.runtimeSha !== runtimeSha
      || payload.backend.artifactDigest !== artifactDigest
      || payload.backend.contractDigest !== expectedContractDigest
      || payload.backend.fixture.schema !== BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA
      || payload.backend.fixture.path !== BACKEND_IOS_CONTRACT_FIXTURE_PATH
      || payload.backend.fixture.digest !== fixtureIdentity.digest) {
    fail('iOS contract backend release identity is invalid or mismatched');
  }
  exactKeys(payload.contractSuite, [
    'name', 'result', 'testCount', 'passedCount', 'failedCount', 'skippedCount',
    'testSelectors', 'selectionDigest',
  ], 'iOS contract suite');
  const expectedSelectionDigest = sha256(canonicalJson(IOS_CONTRACT_TEST_SELECTORS));
  if (payload.contractSuite.name !== IOS_CONTRACT_SUITE_NAME
      || payload.contractSuite.result !== 'passed'
      || !Number.isSafeInteger(payload.contractSuite.testCount)
      || payload.contractSuite.testCount <= 0
      || payload.contractSuite.passedCount !== payload.contractSuite.testCount
      || payload.contractSuite.failedCount !== 0
      || payload.contractSuite.skippedCount !== 0
      || canonicalJson(payload.contractSuite.testSelectors) !== canonicalJson(IOS_CONTRACT_TEST_SELECTORS)
      || payload.contractSuite.selectionDigest !== expectedSelectionDigest) {
    fail('iOS contract suite evidence is invalid');
  }
  exactKeys(payload.ci, ['provider', 'workflow', 'runId', 'runAttempt'], 'iOS contract CI identity');
  if (payload.ci.provider !== 'github-actions'
      || payload.ci.workflow !== IOS_WORKFLOW_NAME
      || !/^[1-9][0-9]*$/.test(String(payload.ci.runId ?? ''))
      || !/^[1-9][0-9]*$/.test(String(payload.ci.runAttempt ?? ''))) {
    fail('iOS contract CI identity is invalid or mismatched');
  }

  const generatedAtMs = Date.parse(payload.generatedAt ?? '');
  const expiresAtMs = Date.parse(payload.expiresAt ?? '');
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(expiresAtMs)
      || generatedAtMs > nowMs + 5 * 60_000
      || expiresAtMs <= nowMs
      || expiresAtMs <= generatedAtMs
      || expiresAtMs - generatedAtMs !== IOS_ATTESTATION_MAX_LIFETIME_MS) {
    fail('iOS contract attestation timing is invalid');
  }

  const publicKeyPath = path.join(trustedRoot, IOS_ATTESTATION_PUBLIC_KEY_PATH);
  const publicKeyStat = fs.lstatSync(publicKeyPath);
  if (!publicKeyStat.isFile() || publicKeyStat.isSymbolicLink()) {
    fail('trusted iOS contract public key is not a regular file');
  }
  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      createPublicKey(fs.readFileSync(publicKeyPath, 'utf8')),
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) fail('iOS contract attestation signature is invalid');
  return {
    binding: {
      sha: payload.ios.sha,
      buildNumber,
      contractTestResult: 'passed',
      fixtureDigest: fixtureIdentity.digest,
      contractDigest: expectedContractDigest,
    },
    payload,
    contractDigest: expectedContractDigest,
  };
}

export function resolveTrustedIosBinding({
  contractScope,
  runtimeSha = '',
  artifactDigest = '',
  fixtureIdentity = null,
  evidenceRoot = '',
  distributionEvidenceRoot = '',
  trustedRoot = scriptRoot,
  nowMs = Date.now(),
}) {
  const shared = validateContractScopeInputs({
    contractScope,
    hasIosEvidence: Boolean(evidenceRoot),
    hasIosDistributionEvidence: Boolean(distributionEvidenceRoot),
  });
  if (!shared) {
    return { binding: null, evidence: null };
  }
  if (!evidenceRoot) fail('iOS evidence artifact root is required');
  if (!fixtureIdentity) fail('exact backend/iOS contract fixture identity is required');
  const files = regularFiles(evidenceRoot, 'iOS evidence');
  if (files.length !== 1 || path.basename(files[0]) !== IOS_ATTESTATION_FILE) {
    fail('iOS evidence artifact must contain exactly the governed attestation file');
  }
  const attestation = readJson(files[0]);
  const validated = validateIosContractAttestation({
    attestation,
    runtimeSha,
    artifactDigest,
    fixtureIdentity,
    trustedRoot,
    nowMs,
  });
  const distributionFiles = regularFiles(distributionEvidenceRoot, 'iOS distribution evidence');
  if (distributionFiles.length !== 1
      || path.basename(distributionFiles[0]) !== IOS_DISTRIBUTION_ATTESTATION_FILE) {
    fail('iOS distribution evidence artifact must contain exactly the governed attestation file');
  }
  const distributionAttestation = readJson(distributionFiles[0]);
  const distribution = validateIosDistributionAttestation({
    attestation: distributionAttestation,
    iosSha: validated.binding.sha,
    buildNumber: validated.binding.buildNumber,
    trustedRoot,
    nowMs,
  });
  return {
    binding: {
      ...validated.binding,
      distribution: distribution.binding,
    },
    evidence: {
      runId: String(validated.payload.ci.runId),
      runAttempt: String(validated.payload.ci.runAttempt),
      artifactPath: files[0],
      attestation,
      attestationDigest: sha256(fs.readFileSync(files[0])),
      contractDigest: validated.contractDigest,
      fixtureDigest: fixtureIdentity.digest,
      distributionArtifactPath: distributionFiles[0],
      distributionAttestationDigest: distribution.binding.attestationDigest,
      distributionPayloadDigest: distribution.binding.payloadDigest,
      distributionCiBuildId: distribution.binding.ci.buildId,
    },
  };
}

export function validateCandidateManifestTiming({
  generatedAtMs,
  expiresAtMs,
  runStartedAtMs,
  runUpdatedAtMs,
  nowMs = Date.now(),
}) {
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs + 5 * 60_000
      || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs
      || expiresAtMs - generatedAtMs !== MANIFEST_LIFETIME_MS) {
    fail('release candidate manifest lifetime is invalid');
  }
  if (generatedAtMs < runStartedAtMs - 5 * 60_000
      || generatedAtMs > runUpdatedAtMs + 5 * 60_000) {
    fail('release candidate manifest generatedAt is outside the trusted candidate GitHub run');
  }
  return runUpdatedAtMs;
}

function assertRegularTree(root) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      if (entry.isSymbolicLink()) fail(`candidate data contains a symbolic link: ${relativePath}`);
      if (entry.isDirectory()) walk(fullPath);
      else if (!entry.isFile()) fail(`candidate data contains an unsupported entry: ${relativePath}`);
    }
  };
  walk(root);
}

function git(sourceRoot, ...gitArgs) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
    'NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM',
    'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM',
  ]) delete env[key];
  return execFileSync('git', gitArgs, {
    cwd: sourceRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

export function isGitAncestor(sourceRoot, ancestor, descendant = 'HEAD') {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
    'NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM',
    'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM',
  ]) delete env[key];
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: sourceRoot,
      env,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function trustedCommandJson(executable, commandArgs, { cwd, env = {} } = {}) {
  const commandEnv = { ...process.env, ...env };
  delete commandEnv.NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM;
  delete commandEnv.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM;
  const output = execFileSync(executable, commandArgs, {
    cwd,
    env: commandEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function validateRecomputedSelection({ selection, classifier, selected, allFiles }) {
  if (classifier?.baseRef !== selection.baseSha || selected?.base !== selection.baseSha) {
    fail('trusted release test recomputation base mismatch');
  }
  const expectedChanged = [...new Set(selected?.changed ?? [])].sort();
  const expectedCritical = [...new Set(selected?.critical ?? [])].sort();
  const expectedCannotSkip = [...new Set(selected?.cannotSkip ?? selected?.focused ?? [])].sort();
  const expectedRemoved = [...new Set(selected?.removed ?? [])].sort();
  const expectedUnresolved = [...new Set(selected?.unresolved ?? [])].sort();
  const expectedClassifierLabels = [...new Set(classifier?.cannotSkip ?? [])].sort();
  const expectedFiles = selection.fullRequired
    ? [...new Set(allFiles)].sort()
    : [...new Set(selected?.selected ?? [])].sort();
  const comparisons = [
    [selection.selected.changed, expectedChanged, 'changed tests'],
    [selection.selected.critical, expectedCritical, 'critical tests'],
    [selection.selected.cannotSkip, expectedCannotSkip, 'cannot-skip tests'],
    [selection.selected.removed, expectedRemoved, 'removed test files'],
    [selection.selected.unresolved, expectedUnresolved, 'unresolved dependency paths'],
    [selection.selected.files, expectedFiles, 'selected test files'],
    [selection.classifier.cannotSkip, expectedClassifierLabels, 'cannot-skip classifier labels'],
  ];
  for (const [actual, expected, label] of comparisons) {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      fail(`release test selection differs from trusted recomputation: ${label}`);
    }
  }
  if (selection.classifier.impactResolved !== selected?.impactResolved
      || selection.classifier.fullSuiteTrigger !== classifier?.flags?.fullSuiteTrigger) {
    fail('release test selection differs from trusted recomputation: classifier flags');
  }
  const recomputedDigest = sha256(canonicalJson(expectedFiles));
  const recomputedRemovedDigest = sha256(canonicalJson(expectedRemoved));
  const recomputedUnresolvedDigest = sha256(canonicalJson(expectedUnresolved));
  if (selection.selected.removedDigest !== recomputedRemovedDigest) {
    fail('release removed test digest differs from trusted recomputation');
  }
  if (selection.selected.unresolvedDigest !== recomputedUnresolvedDigest) {
    fail('release unresolved dependency digest differs from trusted recomputation');
  }
  if (selection.selected.filesDigest !== recomputedDigest) {
    fail('release selected test digest differs from trusted recomputation');
  }
  return {
    classifier,
    selected,
    filesDigest: recomputedDigest,
    removedDigest: recomputedRemovedDigest,
    unresolvedDigest: recomputedUnresolvedDigest,
  };
}

function recomputeReleaseSelection({ trustedRoot, candidateSourceRoot, selection }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-selection-'));
  try {
    const classifierPath = path.join(tempRoot, 'classifier.json');
    const classifier = trustedCommandJson('bash', [
      path.join(trustedRoot, 'scripts/changed-area-classifier.sh'),
      '--json',
      '--base',
      selection.baseSha,
    ], {
      cwd: candidateSourceRoot,
      env: {
        NEXUS_CLASSIFIER_REPO_ROOT: candidateSourceRoot,
        NEXUS_TEST_POLICY_PATH: path.join(trustedRoot, 'config/test-policy.json'),
      },
    });
    fs.writeFileSync(classifierPath, `${JSON.stringify(classifier)}\n`, { mode: 0o600 });
    const selected = trustedCommandJson(process.execPath, [
      path.join(trustedRoot, 'scripts/select-vitest-files.mjs'),
      '--base',
      selection.baseSha,
      '--classifier',
      classifierPath,
      '--source-root',
      candidateSourceRoot,
      '--json',
    ], { cwd: trustedRoot });
    return validateRecomputedSelection({
      selection,
      classifier,
      selected,
      allFiles: partitionTestFiles(walkTestFiles(candidateSourceRoot), loadTestPolicy()).deterministic,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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

function digestForPrefix(artifact, prefix) {
  const files = artifact.files.filter((entry) => entry.path.startsWith(prefix));
  return sha256(canonicalJson(files.map(({ path: filePath, size, sha256: digest }) => ({
    path: filePath,
    size,
    sha256: digest,
  }))));
}

function migrationIdentity(artifact) {
  const files = artifact.files.filter((entry) => entry.path.startsWith('migrations/') && entry.path.endsWith('.sql'));
  return {
    latestId: files.map((entry) => path.basename(entry.path)).sort().at(-1) ?? null,
    schemaDigest: sha256(canonicalJson(files.map(({ path: filePath, sha256: digest }) => ({
      path: filePath,
      sha256: digest,
    })) )),
  };
}

function trainingIdentity(bundleRoot, artifact) {
  const attestation = readJson(path.join(
    bundleRoot,
    'catalog/training/exercise-media/v1/materialization-attestation.json',
  ));
  const policy = readJson(path.join(
    bundleRoot,
    'catalog/training/exercise-media/v1/authored-content/materialization-policy.json',
  ));
  return {
    packageDigest: digestForPrefix(artifact, 'catalog/training/'),
    releaseSubjectDigest: attestation.releaseSubjectHash,
    approvedOrigin: policy.approvedOrigin,
    activationState: policy.activationState ?? attestation.status ?? 'unknown',
  };
}

export function validateGitHubIdentity({
  run,
  artifacts,
  jobs,
  runtimeSha,
  repository,
  candidateRunId,
  selection,
}) {
  const expectedRunId = String(candidateRunId ?? '');
  if (!/^\d+$/.test(expectedRunId)) fail('candidate run id is invalid');
  if (String(run.id) !== expectedRunId) fail('GitHub run id mismatch');
  if (run.run_attempt !== Number(run.run_attempt) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) {
    fail('GitHub run attempt is invalid');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') fail('candidate GitHub run did not succeed');
  if (run.head_sha !== runtimeSha) fail('candidate GitHub run head SHA mismatch');
  if (run.path !== TRUSTED_WORKFLOW_PATH) fail('candidate GitHub workflow path mismatch');
  if (run.event !== 'workflow_dispatch') fail('candidate GitHub run event is not allowed');
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) {
    fail('candidate GitHub repository identity mismatch');
  }
  const runStartedAtMs = Date.parse(run.run_started_at ?? run.created_at);
  const runUpdatedAtMs = Date.parse(run.updated_at);
  if (!Number.isFinite(runStartedAtMs) || !Number.isFinite(runUpdatedAtMs)
      || runUpdatedAtMs < runStartedAtMs
      || runUpdatedAtMs > Date.now() + 5 * 60_000) {
    fail('candidate GitHub run timestamps are invalid');
  }

  const expectedJobs = [
    '🔗 Validate release contract binding',
    '🧭 Resolve release test tier',
    '🐍 Content Engine full pytest',
    '📦 Write unsigned release candidate',
  ];
  if (selection?.tier === FULL_RELEASE_TIER && selection.fullRequired === true) {
    expectedJobs.push(
      '🧪 Full Vitest shard 1/4',
      '🧪 Full Vitest shard 2/4',
      '🧪 Full Vitest shard 3/4',
      '🧪 Full Vitest shard 4/4',
    );
  } else if (selection?.tier === DEFAULT_RELEASE_TIER && selection.fullRequired === false) {
    expectedJobs.push('🧪 Policy-selected Vitest');
  } else {
    fail('candidate release test tier is invalid');
  }
  if (!Array.isArray(jobs.jobs)) fail('candidate GitHub job evidence is missing');
  for (const name of expectedJobs) {
    const matches = jobs.jobs.filter((job) => job?.name === name);
    if (matches.length !== 1 || matches[0].conclusion !== 'success') {
      fail(`candidate GitHub job is missing, duplicated, or unsuccessful: ${name}`);
    }
  }
  const forbiddenSuccessfulJobs = selection.fullRequired
    ? ['🧪 Policy-selected Vitest']
    : [
      '🧪 Full Vitest shard 1/4',
      '🧪 Full Vitest shard 2/4',
      '🧪 Full Vitest shard 3/4',
      '🧪 Full Vitest shard 4/4',
    ];
  if (jobs.jobs.some((job) => forbiddenSuccessfulJobs.includes(job?.name)
      && job?.conclusion === 'success')) {
    fail('candidate GitHub jobs do not match the governed release test tier');
  }

  const expectedArtifactName = `${CANDIDATE_ARTIFACT_PREFIX}${runtimeSha}`;
  if (!Array.isArray(artifacts.artifacts)) fail('candidate GitHub artifact evidence is missing');
  const matches = artifacts.artifacts.filter((artifact) => artifact?.name === expectedArtifactName);
  if (matches.length !== 1) fail('exact candidate GitHub artifact is missing or duplicated');
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired || artifact.size_in_bytes <= 0) {
    fail('candidate GitHub artifact identity is invalid or expired');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) fail('candidate GitHub artifact digest is missing');
  if (String(artifact.workflow_run?.id) !== expectedRunId
      || artifact.workflow_run?.head_sha !== runtimeSha) {
    fail('candidate GitHub artifact is not bound to the requested run and head SHA');
  }
  return {
    runAttempt: String(run.run_attempt),
    runStartedAtMs,
    runUpdatedAtMs,
    artifact,
    expectedArtifactName,
  };
}

function regularFiles(rootDirectory, label = 'evidence') {
  if (!fs.existsSync(rootDirectory) || !fs.lstatSync(rootDirectory).isDirectory()) {
    fail(`${label} artifact root is missing`);
  }
  assertRegularTree(rootDirectory);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else files.push(fullPath);
    }
  };
  walk(rootDirectory);
  return files;
}

function testFilesAtCommit(sourceRoot, commitSha) {
  const files = git(sourceRoot, 'ls-tree', '-r', '--name-only', commitSha, '--', '__tests__')
    .split(/\r?\n/)
    .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file))
    .sort();
  const policy = JSON.parse(git(sourceRoot, 'show', `${commitSha}:config/test-policy.json`));
  return partitionTestFiles(files, policy).deterministic;
}

export function validateNightlyGitHubIdentity({
  selection,
  policy,
  policyDigest,
  run,
  artifacts,
  evidenceRoot,
  repository,
  runtimeSha,
  trustedReferenceTimeMs,
  candidateSourceRoot,
}) {
  const identity = selection.nightlyEvidence;
  if (!identity) fail('release test selection does not reference nightly evidence');
  if (String(run?.id) !== identity.runId
      || !Number.isSafeInteger(run?.run_attempt)
      || String(run.run_attempt) !== identity.runAttempt) {
    fail('nightly GitHub run identity or attempt mismatch');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    fail('referenced nightly GitHub run did not succeed');
  }
  if (run.path !== policy.workflowPath || run.name !== policy.workflowName) {
    fail('nightly GitHub workflow path or name mismatch');
  }
  if (!['schedule', 'workflow_dispatch'].includes(run.event) || run.head_branch !== 'main') {
    fail('nightly GitHub trigger or branch is not governed');
  }
  if (run.head_sha !== identity.headSha
      || run.repository?.full_name !== repository
      || run.head_repository?.full_name !== repository) {
    fail('nightly GitHub source or repository identity mismatch');
  }

  const expectedArtifactName = `${policy.artifactPrefix}${identity.runId}-${identity.runAttempt}`;
  if (!Array.isArray(artifacts?.artifacts)) fail('nightly GitHub artifact metadata is missing');
  const matches = artifacts.artifacts.filter((artifact) => artifact?.name === expectedArtifactName);
  if (matches.length !== 1) fail('exact nightly GitHub evidence artifact is missing or duplicated');
  const artifact = matches[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0
      || artifact.expired || !Number.isSafeInteger(artifact.size_in_bytes)
      || artifact.size_in_bytes <= 0
      || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '')) {
    fail('nightly GitHub evidence artifact is invalid or expired');
  }
  if (String(artifact.workflow_run?.id) !== identity.runId
      || artifact.workflow_run?.head_sha !== identity.headSha) {
    fail('nightly GitHub evidence artifact is not bound to the referenced run');
  }

  const files = regularFiles(evidenceRoot, 'nightly evidence');
  if (files.length !== 1 || path.basename(files[0]) !== 'nightly-full-suite-evidence.json') {
    fail('nightly evidence artifact must contain exactly the governed evidence file');
  }
  const evidence = readJson(files[0]);
  const maxAgeMs = policy.maxAgeHours * 3_600_000;
  const staleReason = selection.fullRequiredReason === 'qualifying_nightly_evidence_stale';
  validateNightlyEvidence(evidence, {
    expectedPolicyDigest: policyDigest,
    expectedWorkflowName: policy.workflowName,
    nowMs: trustedReferenceTimeMs,
    maxAgeHours: policy.maxAgeHours,
    headSha: runtimeSha,
    requireFresh: !staleReason,
    ancestorCheck: (ancestor, descendant) => isGitAncestor(candidateSourceRoot, ancestor, descendant),
  });
  const evidenceCompletedAtMs = Date.parse(evidence.completedAt);
  if (staleReason && evidenceCompletedAtMs >= trustedReferenceTimeMs - maxAgeMs) {
    fail('release selection claims stale nightly evidence that is still fresh');
  }
  if (evidence.headSha !== identity.headSha
      || evidence.completedAt !== identity.completedAt
      || String(evidence.ci.runId) !== identity.runId
      || String(evidence.ci.runAttempt) !== identity.runAttempt) {
    fail('release selection nightly identity differs from the downloaded evidence');
  }
  const nightlyTestFiles = testFilesAtCommit(candidateSourceRoot, identity.headSha);
  if (evidence.testFiles.count !== nightlyTestFiles.length
      || evidence.testFiles.digest !== sha256(canonicalJson(nightlyTestFiles))) {
    fail('nightly full-suite evidence does not cover the referenced Git test-file tree');
  }
  const runStartedAtMs = Date.parse(run.run_started_at ?? run.created_at);
  const runUpdatedAtMs = Date.parse(run.updated_at);
  if (!Number.isFinite(runStartedAtMs) || !Number.isFinite(runUpdatedAtMs)
      || evidenceCompletedAtMs < runStartedAtMs - 5 * 60_000
      || evidenceCompletedAtMs > runUpdatedAtMs + 5 * 60_000) {
    fail('nightly evidence timestamp is outside the referenced GitHub run');
  }
  return { run, artifact, evidence, expectedArtifactName };
}

function locateBundle(candidateArtifactRoot, runtimeSha) {
  const shaRoot = path.join(candidateArtifactRoot, '.local/release/bundles', runtimeSha);
  if (!fs.existsSync(shaRoot)) fail('candidate runtime bundle is missing');
  const entries = fs.readdirSync(shaRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name));
  if (entries.length !== 1) fail('candidate runtime bundle digest directory is missing or ambiguous');
  return path.join(shaRoot, entries[0].name);
}

export function validateTestEvidence({
  candidateArtifactRoot,
  runtimeSha,
  runId,
  runAttempt,
  trustedReferenceTimeMs,
  selection,
  trustedPolicy,
  trustedPolicyDigest,
  candidateSourceRoot,
  artifactDigest,
}) {
  const resultPath = path.join(candidateArtifactRoot, '.local/release/test-results.json');
  const results = readJson(resultPath);
  exactKeys(results, [
    'schema', 'status', 'runtimeSha', 'completedAt', 'tier', 'selection',
    'testPolicyDigest', 'artifactDigest', 'lockfiles', 'toolchain', 'counts',
    'ci', 'protectedMainShadow',
  ], 'release test results');
  exactKeys(results.lockfiles, [
    'packageLockSha256', 'pythonRequirementsSha256',
  ], 'release test lockfiles');
  exactKeys(results.toolchain, ['node', 'python'], 'release test toolchain');
  exactKeys(results.counts, ['vitest', 'pytest'], 'release test counts');
  exactKeys(results.ci, ['runId', 'runAttempt'], 'release test CI identity');
  if (results.schema !== RELEASE_RESULTS_SCHEMA || results.status !== 'passed') {
    fail('release test result schema or status is invalid');
  }
  if (results.runtimeSha !== runtimeSha
      || String(results.ci.runId) !== runId
      || String(results.ci.runAttempt) !== runAttempt) {
    fail('release test result is not bound to the exact runtime and CI run');
  }
  if (results.artifactDigest !== artifactDigest) {
    fail('release test result artifact digest does not match the candidate bundle');
  }
  const expectedLockfiles = {
    packageLockSha256: sha256(fs.readFileSync(path.join(candidateSourceRoot, 'package-lock.json'))),
    pythonRequirementsSha256: sha256(fs.readFileSync(path.join(
      candidateSourceRoot,
      'content-engine/requirements.txt',
    ))),
  };
  if (canonicalJson(results.lockfiles) !== canonicalJson(expectedLockfiles)) {
    fail('release test result lockfiles do not match the exact candidate source');
  }
  if (results.toolchain.node !== 'v22.23.1' || !/^Python 3\.12(?:\.|$)/.test(results.toolchain.python)) {
    fail('release test result toolchain is outside the governed versions');
  }
  if (results.tier !== selection.tier
      || results.testPolicyDigest !== trustedPolicyDigest
      || canonicalJson(results.selection) !== canonicalJson(selection)) {
    fail('release test result tier, policy, or selection binding is invalid');
  }
  validateReleaseSelection(results.selection, {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: trustedPolicyDigest,
  });
  if (!isGitAncestor(candidateSourceRoot, selection.baseSha, runtimeSha)) {
    fail('release test selection base is not an ancestor of the runtime SHA');
  }
  const nightly = selection.nightlyEvidence;
  if (nightly) {
    const nightlyCompletedAtMs = Date.parse(nightly.completedAt);
    const maxAgeMs = trustedPolicy.releaseEvidence.qualifyingNightly.maxAgeHours * 3_600_000;
    const staleReason = selection.fullRequiredReason === 'qualifying_nightly_evidence_stale';
    if (!Number.isFinite(nightlyCompletedAtMs) || nightlyCompletedAtMs > trustedReferenceTimeMs
        || (staleReason && nightlyCompletedAtMs >= trustedReferenceTimeMs - maxAgeMs)
        || (!staleReason && nightlyCompletedAtMs < trustedReferenceTimeMs - maxAgeMs)) {
      fail('release test selection nightly timestamp does not support its governed reason');
    }
  }
  const completedAtMs = Date.parse(results.completedAt);
  if (!Number.isFinite(completedAtMs)
      || completedAtMs > trustedReferenceTimeMs
      || completedAtMs < trustedReferenceTimeMs - RELEASE_RESULT_MAX_AGE_MS) {
    fail('release test result timestamp is invalid, future, or stale');
  }

  const resultsRoot = path.join(candidateArtifactRoot, '.local/release/rc-test-results');
  const vitestFiles = fs.readdirSync(resultsRoot)
    .filter((name) => /^vitest-results-(?:[1-4]|selected)\.json$/.test(name))
    .sort();
  const expectedVitestFiles = selection.fullRequired
    ? ['vitest-results-1.json', 'vitest-results-2.json', 'vitest-results-3.json', 'vitest-results-4.json']
    : ['vitest-results-selected.json'];
  if (canonicalJson(vitestFiles) !== canonicalJson(expectedVitestFiles)) {
    fail('release candidate Vitest result set does not match the selected tier');
  }
  let vitestCount = 0;
  const reportedTestFiles = new Set();
  for (const name of vitestFiles) {
    const report = readJson(path.join(resultsRoot, name));
    if (report.success !== true) fail(`release candidate Vitest result did not pass: ${name}`);
    vitestCount += countVitestTests(report);
    for (const file of vitestTestFiles(report)) reportedTestFiles.add(file);
  }
  const pytestLog = fs.readFileSync(path.join(resultsRoot, 'pytest-results.log'), 'utf8');
  const pytestMatch = pytestLog.match(/(\d+)\s+passed(?:,|\s|$)/);
  const pytestCount = pytestMatch ? Number(pytestMatch[1]) : 0;
  if (results.counts.vitest !== vitestCount || vitestCount <= 0
      || results.counts.pytest !== pytestCount || pytestCount <= 0) {
    fail('release test counts do not match the uploaded suite results');
  }
  if (canonicalJson([...reportedTestFiles].sort()) !== canonicalJson(selection.selected.files)) {
    fail('release candidate Vitest files do not match the signed selection');
  }
  const shadow = results.protectedMainShadow;
  exactKeys(shadow, ['mode', 'comparison', 'evidence'], 'protected-main release shadow binding');
  if (shadow.mode !== 'shadow') fail('protected-main release evidence is not in governed shadow mode');
  const comparison = validateReleaseShadowComparison(shadow.comparison, {
    expectedRuntimeSha: runtimeSha,
  });
  if (shadow.evidence === null) {
    if (comparison.status !== 'ineligible' || comparison.mainCi !== null) {
      fail('missing protected-main evidence has a reusable shadow verdict');
    }
  } else {
    const evidence = validateProtectedMainCiEvidence(shadow.evidence, {
      expectedHeadSha: runtimeSha,
      expectedPolicyDigest: trustedPolicyDigest,
    });
    const recomputed = compareProtectedMainToRelease(evidence, results);
    recomputed.comparedAt = comparison.comparedAt;
    if (canonicalJson(recomputed) !== canonicalJson(comparison)) {
      fail('protected-main shadow verdict does not match its signed evidence');
    }
  }
  return results;
}

function validateCandidate() {
  const runtimeSha = valueOf('--runtime-sha');
  if (!/^[0-9a-f]{40}$/.test(runtimeSha)) fail('runtime SHA is invalid');
  const contractScope = valueOf('--contract-scope');
  const iosEvidenceRoot = valueOf('--ios-evidence-root');
  const iosDistributionEvidenceRoot = valueOf('--ios-distribution-evidence-root');
  const sharedIosRelease = validateContractScopeInputs({
    contractScope,
    hasIosEvidence: Boolean(iosEvidenceRoot),
    hasIosDistributionEvidence: Boolean(iosDistributionEvidenceRoot),
  });
  if (['--ios-sha', '--ios-build-number', '--ios-contract-result'].some((flag) => valueOf(flag))) {
    fail('direct iOS identity inputs are not accepted by the trusted signer');
  }
  if ([
    '--ios-evidence-run-id', '--ios-run-metadata', '--ios-jobs-metadata', '--ios-artifact-metadata',
  ].some((flag) => valueOf(flag))) {
    fail('legacy iOS GitHub metadata inputs are not accepted by the trusted signer');
  }
  const repository = valueOf('--repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository identity is invalid');
  const candidateArtifactRoot = resolveRequired('--candidate-artifact');
  const candidateSourceRoot = resolveRequired('--candidate-source');
  const trustedRoot = path.resolve(valueOf('--trusted-root', scriptRoot));
  assertRegularTree(candidateArtifactRoot);

  if (!isGitAncestor(trustedRoot, runtimeSha, 'HEAD')) {
    fail('candidate runtime SHA is not reachable from protected main');
  }

  const run = readJson(resolveRequired('--run-metadata'));
  const artifacts = readJson(resolveRequired('--artifact-metadata'));
  const jobs = readJson(resolveRequired('--jobs-metadata'));
  const trustedPolicyPath = path.join(trustedRoot, 'config/test-policy.json');
  const trustedPolicy = readJson(trustedPolicyPath);
  validateReleaseEvidencePolicy(trustedPolicy);
  const trustedPolicyDigest = sha256(fs.readFileSync(trustedPolicyPath));
  const selection = validateReleaseSelection(readJson(path.join(
    candidateArtifactRoot,
    '.local/release/test-selection.json',
  )), {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: trustedPolicyDigest,
  });
  const githubIdentity = validateGitHubIdentity({
    run,
    artifacts,
    jobs,
    runtimeSha,
    repository,
    candidateRunId: valueOf('--candidate-run-id'),
    selection,
  });

  if (git(candidateSourceRoot, 'rev-parse', 'HEAD') !== runtimeSha) fail('candidate source checkout SHA mismatch');
  if (git(candidateSourceRoot, 'status', '--porcelain=v1', '--untracked-files=normal')) {
    fail('candidate source checkout is dirty');
  }
  const trustedWorkflow = fs.readFileSync(path.join(trustedRoot, TRUSTED_WORKFLOW_PATH));
  const candidateWorkflowPath = path.join(candidateSourceRoot, TRUSTED_WORKFLOW_PATH);
  if (!fs.lstatSync(candidateWorkflowPath).isFile() || fs.lstatSync(candidateWorkflowPath).isSymbolicLink()) {
    fail('candidate RC workflow is not a regular inert data file');
  }
  const candidateWorkflow = fs.readFileSync(candidateWorkflowPath);
  if (!trustedWorkflow.equals(candidateWorkflow)) {
    fail('candidate RC workflow does not match protected main tooling');
  }
  recomputeReleaseSelection({
    trustedRoot,
    candidateSourceRoot,
    selection,
  });

  const bundleRoot = locateBundle(candidateArtifactRoot, runtimeSha);
  const verifiedBundle = verifyReleaseBundle(bundleRoot, runtimeSha);
  const artifact = verifiedBundle.manifest;
  if (artifact.git?.sha !== runtimeSha || path.basename(bundleRoot) !== artifact.digest) {
    fail('candidate bundle source SHA or digest directory mismatch');
  }
  validateRuntimeDependencyLock(
    readJson(path.join(bundleRoot, 'dist/runtime-dependencies/lock.json')),
    bundleRoot,
  );
  const fixtureIdentity = backendIosContractFixtureIdentity({ bundleRoot, artifact });
  for (const entry of artifact.files) {
    if (entry.path.startsWith('dist/')) continue;
    const sourcePath = path.join(candidateSourceRoot, entry.path);
    if (!fs.existsSync(sourcePath)
        || !fs.lstatSync(sourcePath).isFile()
        || fs.lstatSync(sourcePath).isSymbolicLink()
        || sha256(fs.readFileSync(sourcePath)) !== entry.sha256) {
      fail(`candidate bundle differs from exact source data: ${entry.path}`);
    }
  }

  const iosResolution = sharedIosRelease
    ? resolveTrustedIosBinding({
      contractScope,
      runtimeSha,
      artifactDigest: artifact.digest,
      fixtureIdentity,
      evidenceRoot: path.resolve(iosEvidenceRoot),
      distributionEvidenceRoot: path.resolve(iosDistributionEvidenceRoot),
      trustedRoot,
    })
    : resolveTrustedIosBinding({ contractScope });
  const ios = iosResolution.binding;

  const unsignedPath = path.join(
    candidateArtifactRoot,
    `.local/release/manifests/${runtimeSha}.unsigned.json`,
  );
  const unsigned = readJson(unsignedPath);
  exactKeys(unsigned, ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'], 'unsigned manifest envelope');
  if (unsigned.schema !== 'nexus.release-manifest.v2'
      || unsigned.keyId !== 'unsigned-release-candidate'
      || unsigned.signatureAlgorithm !== 'ed25519'
      || unsigned.signature !== null) {
    fail('release candidate manifest is not the required unsigned envelope');
  }
  const payload = unsigned.payload;
  exactKeys(payload, [
    'schema', 'runtimeSha', 'docsHead', 'source', 'packageVersion', 'generatedAt', 'expiresAt',
    'toolchain', 'artifact', 'migration', 'trainingCatalog', 'testPolicy', 'ci', 'staging', 'ios',
  ], 'release manifest payload');
  exactKeys(payload.toolchain, ['node', 'npm', 'python'], 'release manifest toolchain');
  const generatedAtMs = Date.parse(payload.generatedAt);
  const expiresAtMs = Date.parse(payload.expiresAt);
  const trustedReferenceTimeMs = validateCandidateManifestTiming({
    generatedAtMs,
    expiresAtMs,
    runStartedAtMs: githubIdentity.runStartedAtMs,
    runUpdatedAtMs: githubIdentity.runUpdatedAtMs,
  });

  let nightlyGitHubIdentity = null;
  if (selection.nightlyEvidence) {
    nightlyGitHubIdentity = validateNightlyGitHubIdentity({
      selection,
      policy: trustedPolicy.releaseEvidence.qualifyingNightly,
      policyDigest: trustedPolicyDigest,
      run: readJson(resolveRequired('--nightly-run-metadata')),
      artifacts: readJson(resolveRequired('--nightly-artifact-metadata')),
      evidenceRoot: resolveRequired('--nightly-evidence-root'),
      repository,
      runtimeSha,
      trustedReferenceTimeMs,
      candidateSourceRoot,
    });
  } else if (valueOf('--nightly-run-metadata')
      || valueOf('--nightly-artifact-metadata')
      || valueOf('--nightly-evidence-root')) {
    fail('nightly GitHub evidence was supplied without a governed selection identity');
  }

  const testResults = validateTestEvidence({
    candidateArtifactRoot,
    runtimeSha,
    runId: valueOf('--candidate-run-id'),
    runAttempt: githubIdentity.runAttempt,
    trustedReferenceTimeMs,
    selection,
    trustedPolicy,
    trustedPolicyDigest,
    candidateSourceRoot,
    artifactDigest: artifact.digest,
  });
  if (payload.toolchain.node !== testResults.toolchain.node
      || payload.toolchain.python !== testResults.toolchain.python
      || !/^\d+\.\d+(?:\.\d+)?$/.test(payload.toolchain.npm ?? '')) {
    fail('release candidate manifest toolchain does not match governed test evidence');
  }

  const packageJson = readJson(path.join(bundleRoot, 'package.json'));
  const testPolicyDigest = sha256(fs.readFileSync(path.join(bundleRoot, 'config/test-policy.json')));
  if (testPolicyDigest !== trustedPolicyDigest) {
    fail('candidate release test policy does not match protected-main policy');
  }
  const boundTestResults = {
    ...testResults,
    runtimeSha,
    artifactDigest: artifact.digest,
    testPolicyDigest,
  };
  const expectedCandidatePayload = {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha,
    docsHead: runtimeSha,
    source: { dirty: false },
    packageVersion: packageJson.version,
    generatedAt: payload.generatedAt,
    expiresAt: payload.expiresAt,
    toolchain: payload.toolchain,
    artifact: {
      schema: artifact.schema,
      digest: artifact.digest,
      fileCount: artifact.fileCount,
      files: artifact.files.map(({ path: filePath, size, sha256: digest }) => ({
        path: filePath,
        size,
        sha256: digest,
      })),
    },
    migration: migrationIdentity(artifact),
    trainingCatalog: trainingIdentity(bundleRoot, artifact),
    testPolicy: { digest: testPolicyDigest, results: boundTestResults },
    ci: {
      provider: 'github-actions',
      runId: valueOf('--candidate-run-id'),
      runAttempt: githubIdentity.runAttempt,
      workflow: TRUSTED_WORKFLOW_NAME,
    },
    staging: null,
    ios: ios ? { ...ios, distribution: null } : null,
  };
  if (canonicalJson(payload) !== canonicalJson(expectedCandidatePayload)) {
    fail('unsigned release manifest payload does not match independently reconstructed candidate data');
  }
  const expectedPayload = ios
    ? { ...expectedCandidatePayload, ios }
    : expectedCandidatePayload;
  return {
    runtimeSha,
    repository,
    candidateArtifactRoot,
    candidateSourceRoot,
    trustedRoot,
    bundleRoot,
    payload: expectedPayload,
    artifact: githubIdentity.artifact,
    nightlyGitHubIdentity,
    iosEvidence: iosResolution.evidence,
    candidateRunId: valueOf('--candidate-run-id'),
    candidateRunAttempt: githubIdentity.runAttempt,
  };
}

function writeNightlyRequest() {
  const runtimeSha = valueOf('--runtime-sha');
  if (!/^[0-9a-f]{40}$/.test(runtimeSha)) fail('runtime SHA is invalid');
  const candidateArtifactRoot = resolveRequired('--candidate-artifact');
  const trustedRoot = path.resolve(valueOf('--trusted-root', scriptRoot));
  assertRegularTree(candidateArtifactRoot);
  const policyPath = path.join(trustedRoot, 'config/test-policy.json');
  const policyDocument = readJson(policyPath);
  const policy = validateReleaseEvidencePolicy(policyDocument).qualifyingNightly;
  const selection = validateReleaseSelection(readJson(path.join(
    candidateArtifactRoot,
    '.local/release/test-selection.json',
  )), {
    expectedHeadSha: runtimeSha,
    expectedPolicyDigest: sha256(fs.readFileSync(policyPath)),
  });
  const identity = selection.nightlyEvidence;
  return identity ? {
    required: true,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    artifactName: `${policy.artifactPrefix}${identity.runId}-${identity.runAttempt}`,
  } : {
    required: false,
    runId: null,
    runAttempt: null,
    artifactName: null,
  };
}

function writeIosContractRequest() {
  const runtimeSha = valueOf('--runtime-sha');
  if (!/^[0-9a-f]{40}$/.test(runtimeSha)) fail('runtime SHA is invalid');
  const candidateArtifactRoot = resolveRequired('--candidate-artifact');
  assertRegularTree(candidateArtifactRoot);
  const bundleRoot = locateBundle(candidateArtifactRoot, runtimeSha);
  const verifiedBundle = verifyReleaseBundle(bundleRoot, runtimeSha);
  const artifactDigest = verifiedBundle.manifest.digest;
  const fixture = backendIosContractFixtureIdentity({
    bundleRoot,
    artifact: verifiedBundle.manifest,
  });
  return {
    schema: 'nexus.ios-contract-evidence-request.v2',
    iosRepository: IOS_REPOSITORY,
    workflow: IOS_WORKFLOW_PATH,
    backendRuntimeSha: runtimeSha,
    backendArtifactDigest: artifactDigest,
    backendContractFixturePath: fixture.relativePath,
    backendContractFixtureDigest: fixture.digest,
    backendContractFixtureBase64: fixture.base64,
    backendContractDigest: backendIosContractDigest({
      runtimeSha,
      artifactDigest,
      fixtureDigest: fixture.digest,
    }),
  };
}

function writeSignedOutput(candidate) {
  const privatePem = process.env.NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM?.trim() ?? '';
  if (!privatePem) fail('trusted release-signing environment private key is required');
  const privateKey = createPrivateKey(privatePem);
  const trackedPublicPath = path.join(
    candidate.trustedRoot,
    'docs/release/evidence/release-evidence-public-key.pem',
  );
  const trackedPublic = createPublicKey(fs.readFileSync(trackedPublicPath, 'utf8'));
  const derivedPublic = createPublicKey(privateKey);
  const trackedDer = trackedPublic.export({ type: 'spki', format: 'der' });
  const derivedDer = derivedPublic.export({ type: 'spki', format: 'der' });
  if (!trackedDer.equals(derivedDer)) fail('trusted private key does not match the tracked current public key');

  const outputRoot = resolveRequired('--output-root');
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) {
    fail('signed release artifact output directory must be empty');
  }
  const manifestPath = path.join(outputRoot, `.local/release/manifests/${candidate.runtimeSha}.json`);
  const destinationBundle = path.join(
    outputRoot,
    '.local/release/bundles',
    candidate.runtimeSha,
    candidate.payload.artifact.digest,
  );
  fs.mkdirSync(path.dirname(destinationBundle), { recursive: true, mode: 0o700 });
  fs.cpSync(candidate.bundleRoot, destinationBundle, { recursive: true, errorOnExist: true });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  const envelope = {
    schema: 'nexus.release-manifest.v2',
    keyId: TRUSTED_KEY_ID,
    signatureAlgorithm: 'ed25519',
    payload: candidate.payload,
    signature: cryptoSign(
      null,
      Buffer.from(canonicalJson(candidate.payload)),
      privateKey,
    ).toString('base64'),
  };
  if (!cryptoVerify(
    null,
    Buffer.from(canonicalJson(candidate.payload)),
    trackedPublic,
    Buffer.from(envelope.signature, 'base64'),
  )) fail('trusted release manifest self-verification failed');
  fs.writeFileSync(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });

  const evidenceFiles = [
    '.local/release/test-selection.json',
    '.local/release/test-results.json',
    '.local/release/cannot-skip-dashboard.json',
  ];
  for (const relativePath of evidenceFiles) {
    const source = path.join(candidate.candidateArtifactRoot, relativePath);
    if (!fs.existsSync(source)) fail(`candidate evidence is missing: ${relativePath}`);
    const destination = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination);
  }
  fs.cpSync(
    path.join(candidate.candidateArtifactRoot, '.local/release/rc-test-results'),
    path.join(outputRoot, '.local/release/rc-test-results'),
    { recursive: true, errorOnExist: true },
  );
  if (candidate.iosEvidence) {
    const destination = path.join(outputRoot, `.local/release/${IOS_ATTESTATION_FILE}`);
    fs.copyFileSync(candidate.iosEvidence.artifactPath, destination, fs.constants.COPYFILE_EXCL);
    const distributionDestination = path.join(
      outputRoot,
      `.local/release/${IOS_DISTRIBUTION_ATTESTATION_FILE}`,
    );
    fs.copyFileSync(
      candidate.iosEvidence.distributionArtifactPath,
      distributionDestination,
      fs.constants.COPYFILE_EXCL,
    );
  }
  const provenance = {
    schema: 'nexus.release-signing-provenance.v3',
    runtimeSha: candidate.runtimeSha,
    artifactDigest: candidate.payload.artifact.digest,
    candidateRunId: candidate.candidateRunId,
    candidateRunAttempt: candidate.candidateRunAttempt,
    candidateArtifactId: String(candidate.artifact.id),
    candidateArtifactDigest: candidate.artifact.digest,
    nightlyRunId: candidate.nightlyGitHubIdentity
      ? String(candidate.nightlyGitHubIdentity.run.id)
      : null,
    nightlyArtifactId: candidate.nightlyGitHubIdentity
      ? String(candidate.nightlyGitHubIdentity.artifact.id)
      : null,
    nightlyArtifactDigest: candidate.nightlyGitHubIdentity?.artifact.digest ?? null,
    iosEvidenceRunId: candidate.iosEvidence?.runId ?? null,
    iosEvidenceRunAttempt: candidate.iosEvidence?.runAttempt ?? null,
    iosAttestationDigest: candidate.iosEvidence?.attestationDigest ?? null,
    iosContractDigest: candidate.iosEvidence?.contractDigest ?? null,
    iosContractFixtureDigest: candidate.iosEvidence?.fixtureDigest ?? null,
    iosDistributionAttestationDigest:
      candidate.iosEvidence?.distributionAttestationDigest ?? null,
    iosDistributionPayloadDigest: candidate.iosEvidence?.distributionPayloadDigest ?? null,
    iosDistributionCiBuildId: candidate.iosEvidence?.distributionCiBuildId ?? null,
    signingRunId: process.env.GITHUB_RUN_ID ?? null,
    signingRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    trustedToolingSha: git(candidate.trustedRoot, 'rev-parse', 'HEAD'),
    keyId: TRUSTED_KEY_ID,
    signedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outputRoot, '.local/release/signing-provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { manifestPath, outputRoot, provenance };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (command === 'nightly-request') {
    process.stdout.write(`${JSON.stringify(writeNightlyRequest(), null, 2)}\n`);
  } else if (command === 'ios-contract-request') {
    process.stdout.write(`${JSON.stringify(writeIosContractRequest(), null, 2)}\n`);
  } else {
    const candidate = validateCandidate();
    if (command === 'verify-candidate') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      runtimeSha: candidate.runtimeSha,
      artifactDigest: candidate.payload.artifact.digest,
      candidateRunId: candidate.candidateRunId,
      candidateArtifactId: candidate.artifact.id,
      iosEvidenceRunId: candidate.iosEvidence?.runId ?? null,
      iosDistributionCiBuildId: candidate.iosEvidence?.distributionCiBuildId ?? null,
      iosSha: candidate.payload.ios?.sha ?? null,
      iosBuildNumber: candidate.payload.ios?.buildNumber ?? null,
    }, null, 2)}\n`);
    } else if (command === 'sign-manifest') {
      const result = writeSignedOutput(candidate);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        promotable: true,
        runtimeSha: candidate.runtimeSha,
        artifactDigest: candidate.payload.artifact.digest,
        manifest: result.manifestPath,
        outputRoot: result.outputRoot,
        keyId: TRUSTED_KEY_ID,
      }, null, 2)}\n`);
    } else {
      fail('Usage: trusted-release-signer.mjs <nightly-request|ios-contract-request|verify-candidate|sign-manifest> [options]');
    }
  }
}
