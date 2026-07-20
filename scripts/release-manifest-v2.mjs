#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseArtifactManifest,
  verifyReleaseBundle,
} from './lib/release-artifact-manifest.mjs';
import {
  RELEASE_RESULTS_SCHEMA,
  validateReleaseSelection,
} from './release-test-evidence.mjs';
import {
  backendIosContractDigest,
  backendIosContractFixtureIdentity,
} from './lib/backend-ios-contract-fixture.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'validate';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(valueOf('--root', process.cwd()));
const toolingRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowUnsigned = has('--allow-unsigned');
const allowDirtyForTest = has('--allow-dirty') && process.env.NODE_ENV === 'test';
const allowTestKey = has('--allow-test-key') && process.env.NODE_ENV === 'test';
const verifyBundle = has('--verify-bundle');
const CURRENT_SIGNING_KEY_ID = 'github-environment-release-signing-2026-07';
const LEGACY_SIGNING_KEY_ID = 'github-actions-release-manifest-2026-07';
const RELEASE_RESULT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const GOVERNED_LOCAL_RELEASE_COMMANDS = Object.freeze([
  'typecheck',
  'build',
  'migration-rehearsal',
  'changed-critical-union',
  'content-engine-pytest',
  'artifact-validation',
]);
const IOS_CONTRACT_RESULT = 'passed';
const IOS_CONTRACT_FIELDS = Object.freeze([
  'sha', 'buildNumber', 'contractTestResult', 'contractDigest', 'fixtureDigest', 'distribution',
]);
const IOS_DISTRIBUTION_FIELDS = Object.freeze([
  'result', 'attestationDigest', 'payloadDigest', 'sourceCommit', 'sourceTree',
  'release', 'archive', 'exportedArtifact', 'toolchain', 'ci',
]);

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
function fileSha(relative) {
  return sha256(fs.readFileSync(path.join(root, relative)));
}
function cleanGitEnv() {
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
  return env;
}
function git(...gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim();
}
function toolVersion(commandName, commandArgs) {
  try {
    return execFileSync(commandName, commandArgs, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
function artifactManifest(expectedRuntimeSha = '') {
  if (verifyBundle) {
    if (!/^[0-9a-f]{40}$/.test(expectedRuntimeSha)) {
      throw new Error('release bundle expected runtime SHA is invalid');
    }
    const verified = verifyReleaseBundle(root, expectedRuntimeSha);
    if (expectedRuntimeSha && verified.manifest.git?.sha !== expectedRuntimeSha) {
      throw new Error('release bundle source SHA mismatch');
    }
    return verified.manifest;
  }
  return buildReleaseArtifactManifest(root);
}
function digestForPrefix(artifact, prefix) {
  const files = artifact.files.filter((entry) => entry.path.startsWith(prefix));
  return sha256(canonicalJson(files.map(({ path: filePath, size, sha256: digest }) => ({
    path: filePath, size, sha256: digest,
  }))));
}
function migrationIdentity(artifact) {
  const files = artifact.files.filter((entry) => entry.path.startsWith('migrations/') && entry.path.endsWith('.sql'));
  return {
    latestId: files.map((entry) => path.basename(entry.path)).sort().at(-1) ?? null,
    schemaDigest: sha256(canonicalJson(files.map(({ path: filePath, sha256: digest }) => ({
      path: filePath, sha256: digest,
    })) )),
  };
}
function trainingIdentity(artifact) {
  const attestation = JSON.parse(fs.readFileSync(
    path.join(root, 'catalog/training/exercise-media/v1/materialization-attestation.json'),
    'utf8',
  ));
  const policy = JSON.parse(fs.readFileSync(
    path.join(root, 'catalog/training/exercise-media/v1/authored-content/materialization-policy.json'),
    'utf8',
  ));
  return {
    packageDigest: digestForPrefix(artifact, 'catalog/training/'),
    releaseSubjectDigest: attestation.releaseSubjectHash,
    approvedOrigin: policy.approvedOrigin,
    activationState: policy.activationState ?? attestation.status ?? 'unknown',
  };
}
function readJsonIfPresent(file) {
  return file && fs.existsSync(path.resolve(root, file))
    ? JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
    : null;
}
function pem(name, envName, defaultPath = '') {
  const explicit = valueOf(name, '');
  if (explicit) return fs.readFileSync(path.resolve(root, explicit), 'utf8');
  if (process.env[envName]) return process.env[envName];
  if (defaultPath && fs.existsSync(path.resolve(root, defaultPath))) {
    return fs.readFileSync(path.resolve(root, defaultPath), 'utf8');
  }
  return '';
}
function matchesTrackedPublicKey(publicPem, relativePath) {
  try {
    const supplied = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
    const tracked = createPublicKey(
      fs.readFileSync(path.join(toolingRoot, relativePath), 'utf8'),
    ).export({ type: 'spki', format: 'der' });
    return supplied.equals(tracked);
  } catch {
    return false;
  }
}
function manifestPath(runtimeSha = '') {
  const explicit = valueOf('--manifest', '');
  if (explicit) return path.resolve(root, explicit);
  const resolvedRuntimeSha = runtimeSha || git('rev-parse', 'HEAD');
  return path.resolve(root, `.local/release/manifests/${resolvedRuntimeSha}.json`);
}
function releaseTestResultReasons(results, binding, options = {}) {
  const {
    requireBinding = false,
    referenceTimeMs = null,
    verifyCiContext = false,
  } = options;
  const reasons = [];
  const legacyLocal = results?.schema === 'nexus.release-test-results.v1'
    && results?.ci === undefined
    && results?.commands !== undefined;
  if (!results || (results.schema !== RELEASE_RESULTS_SCHEMA && !legacyLocal)) {
    reasons.push('release_test_schema_invalid');
    return reasons;
  }
  if (results.status !== 'passed') reasons.push('release_test_status_not_passed');
  if (!/^[0-9a-f]{40}$/.test(results.runtimeSha ?? '')
      || results.runtimeSha !== binding.runtimeSha) reasons.push('release_test_runtime_sha_mismatch');
  const completedAtMs = Date.parse(results.completedAt ?? '');
  if (!Number.isFinite(completedAtMs)) reasons.push('release_test_completed_at_invalid');
  else if (Number.isFinite(referenceTimeMs)) {
    if (completedAtMs > referenceTimeMs) reasons.push('release_test_completed_at_future');
    if (completedAtMs < referenceTimeMs - RELEASE_RESULT_MAX_AGE_MS) {
      reasons.push('release_test_completed_at_stale');
    }
  }
  if (typeof results.toolchain?.node !== 'string' || !results.toolchain.node.trim()
      || typeof results.toolchain?.python !== 'string' || !results.toolchain.python.trim()) {
    reasons.push('release_test_toolchain_missing');
  }
  const hasCiEvidence = results.ci !== undefined && results.ci !== null;
  const hasLocalCommandEvidence = results.commands !== undefined;
  if (!hasCiEvidence && !hasLocalCommandEvidence) reasons.push('release_test_evidence_missing');
  if (verifyCiContext && process.env.GITHUB_ACTIONS === 'true' && !hasCiEvidence) {
    reasons.push('release_test_ci_evidence_required');
  }
  if (hasCiEvidence) {
    const runId = typeof results.ci?.runId === 'string' ? results.ci.runId.trim() : '';
    const runAttempt = typeof results.ci?.runAttempt === 'string' ? results.ci.runAttempt.trim() : '';
    if (!runId || !runAttempt) reasons.push('release_test_ci_identity_invalid');
    if (!Number.isSafeInteger(results.counts?.vitest) || results.counts.vitest <= 0) {
      reasons.push('release_test_vitest_count_invalid');
    }
    if (!Number.isSafeInteger(results.counts?.pytest) || results.counts.pytest <= 0) {
      reasons.push('release_test_pytest_count_invalid');
    }
    if (results.schema !== RELEASE_RESULTS_SCHEMA) reasons.push('release_test_ci_schema_invalid');
    if (results.testPolicyDigest !== binding.testPolicyDigest) {
      reasons.push('release_test_policy_digest_mismatch');
    }
    try {
      const selection = validateReleaseSelection(results.selection, {
        expectedHeadSha: binding.runtimeSha,
        expectedPolicyDigest: binding.testPolicyDigest,
      });
      if (results.tier !== selection.tier) reasons.push('release_test_tier_mismatch');
    } catch {
      reasons.push('release_test_selection_invalid');
    }
    if (verifyCiContext) {
      const currentRunId = process.env.GITHUB_RUN_ID?.trim() ?? '';
      const currentRunAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim() ?? '';
      if (!currentRunId || !currentRunAttempt) reasons.push('release_test_ci_context_missing');
      else if (runId !== currentRunId || runAttempt !== currentRunAttempt) {
        reasons.push('release_test_ci_identity_mismatch');
      }
    }
  }
  if (hasLocalCommandEvidence) {
    const exactLocalCommands = Array.isArray(results.commands)
      && results.commands.length === GOVERNED_LOCAL_RELEASE_COMMANDS.length
      && results.commands.every((entry, index) => entry === GOVERNED_LOCAL_RELEASE_COMMANDS[index]);
    if (!exactLocalCommands) reasons.push('release_test_local_commands_mismatch');
  }
  if ((requireBinding || results.artifactDigest !== undefined)
      && results.artifactDigest !== binding.artifactDigest) {
    reasons.push('release_test_artifact_digest_mismatch');
  }
  if ((requireBinding || results.testPolicyDigest !== undefined)
      && results.testPolicyDigest !== binding.testPolicyDigest) {
    if (!reasons.includes('release_test_policy_digest_mismatch')) {
      reasons.push('release_test_policy_digest_mismatch');
    }
  }
  return reasons;
}
function resolveIosContractBinding(artifact) {
  const backendOnly = has('--backend-only');
  const includesIos = has('--includes-ios');
  const iosArgumentsSupplied = ['--ios-sha', '--ios-build-number', '--ios-contract-result'].some(has);
  if (backendOnly === includesIos) {
    throw new Error('release contract scope must be explicit: choose exactly one of --backend-only or --includes-ios');
  }
  if (backendOnly) {
    if (iosArgumentsSupplied) {
      throw new Error('backend-only release must not include iOS contract fields');
    }
    return null;
  }

  const sha = valueOf('--ios-sha', '');
  const buildNumberRaw = valueOf('--ios-build-number', '');
  const contractTestResult = valueOf('--ios-contract-result', '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('iOS contract SHA must be an exact lowercase Git SHA');
  if (!/^[1-9][0-9]*$/.test(buildNumberRaw)) throw new Error('iOS build number must be a positive integer');
  const buildNumber = Number(buildNumberRaw);
  if (!Number.isSafeInteger(buildNumber)) throw new Error('iOS build number must be a safe positive integer');
  if (contractTestResult !== IOS_CONTRACT_RESULT) {
    throw new Error(`iOS contract result must be ${IOS_CONTRACT_RESULT}`);
  }
  const fixture = backendIosContractFixtureIdentity({ bundleRoot: root, artifact });
  return {
    sha,
    buildNumber,
    contractTestResult,
    fixtureDigest: fixture.digest,
    contractDigest: backendIosContractDigest({
      runtimeSha: valueOf('--runtime-sha', git('rev-parse', 'HEAD')),
      artifactDigest: artifact.digest,
      fixtureDigest: fixture.digest,
    }),
    // The protected signer enriches this only after independently verifying a
    // second, Xcode Cloud-signed proof for the exact App Store artifact.
    distribution: null,
  };
}
function iosDistributionBindingReasons(distribution, binding, { required = true } = {}) {
  if (distribution === null) return required ? ['ios_distribution_evidence_missing'] : [];
  if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) {
    return ['ios_distribution_binding_invalid'];
  }
  const reasons = [];
  if (canonicalJson(Object.keys(distribution).sort())
      !== canonicalJson([...IOS_DISTRIBUTION_FIELDS].sort())) {
    reasons.push('ios_distribution_binding_invalid');
    return reasons;
  }
  if (distribution.result !== 'passed') reasons.push('ios_distribution_result_not_passed');
  for (const field of ['attestationDigest', 'payloadDigest']) {
    if (!/^[0-9a-f]{64}$/.test(distribution[field] ?? '')) {
      reasons.push(`ios_distribution_${field.replace(/[A-Z]/g, (value) => `_${value.toLowerCase()}`)}_invalid`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(distribution.sourceTree ?? '')) {
    reasons.push('ios_distribution_source_tree_invalid');
  }
  if (distribution.sourceCommit !== binding.sha) reasons.push('ios_distribution_sha_mismatch');
  const release = distribution.release;
  if (!release || typeof release !== 'object' || Array.isArray(release)
      || canonicalJson(Object.keys(release).sort()) !== canonicalJson([
        'bundleId', 'configuration', 'distributedBuildNumber', 'marketingVersion',
        'sourceBuildNumber', 'teamId',
      ])) {
    reasons.push('ios_distribution_release_identity_invalid');
  } else if (release.bundleId !== 'me.nexushub.app'
      || release.teamId !== 'B6885R8NWM'
      || release.configuration !== 'Release'
      || release.sourceBuildNumber !== String(binding.buildNumber)
      || !/^[1-9][0-9]*$/.test(release.distributedBuildNumber ?? '')
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.marketingVersion ?? '')) {
    reasons.push('ios_distribution_release_identity_mismatch');
  }
  const digestBlock = (value, fields, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
      reasons.push(`${label}_invalid`);
      return;
    }
    for (const field of fields.filter((name) => name.endsWith('Digest'))) {
      if (!/^[0-9a-f]{64}$/.test(value[field] ?? '')) reasons.push(`${label}_invalid`);
    }
  };
  digestBlock(distribution.archive, ['artifactDigest', 'appDigest'], 'ios_distribution_archive_binding');
  digestBlock(
    distribution.exportedArtifact,
    ['artifactDigest', 'artifactSemantics', 'appDigest'],
    'ios_distribution_export_binding',
  );
  if (distribution.exportedArtifact
      && !['nexus.canonical-tree.v1', 'nexus.raw-file.v1']
        .includes(distribution.exportedArtifact.artifactSemantics)) {
    reasons.push('ios_distribution_export_binding_invalid');
  }
  const toolchain = distribution.toolchain;
  if (!toolchain || typeof toolchain !== 'object' || Array.isArray(toolchain)
      || canonicalJson(Object.keys(toolchain).sort())
        !== canonicalJson(['sdkName', 'xcodeBuild', 'xcodeVersion'])
      || Object.values(toolchain).some((value) => typeof value !== 'string' || !value)) {
    reasons.push('ios_distribution_toolchain_invalid');
  }
  const ci = distribution.ci;
  if (!ci || typeof ci !== 'object' || Array.isArray(ci)
      || canonicalJson(Object.keys(ci).sort())
        !== canonicalJson(['buildId', 'buildNumber', 'workflow', 'workflowId'])
      || typeof ci.buildId !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ci.buildId)
      || typeof ci.buildNumber !== 'string' || !/^[1-9][0-9]*$/.test(ci.buildNumber)
      || ci.buildNumber !== release?.distributedBuildNumber
      || ci.workflow !== 'App Store Release'
      || ci.workflowId !== '20e0adf7-2854-4207-98eb-8f3b5afcac60') {
    reasons.push('ios_distribution_ci_identity_invalid');
  }
  return [...new Set(reasons)];
}
function iosContractBindingReasons(
  binding,
  artifact = null,
  runtimeSha = '',
  { requireDistribution = true } = {},
) {
  if (binding === undefined) return ['ios_contract_binding_missing'];
  if (binding === null) return [];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    return ['ios_contract_binding_invalid'];
  }
  const reasons = [];
  const keys = Object.keys(binding).sort();
  if (canonicalJson(keys) !== canonicalJson([...IOS_CONTRACT_FIELDS].sort())) {
    reasons.push('ios_contract_binding_invalid');
  }
  if (!/^[0-9a-f]{40}$/.test(binding.sha ?? '')) reasons.push('ios_contract_sha_invalid');
  if (!Number.isSafeInteger(binding.buildNumber) || binding.buildNumber <= 0) {
    reasons.push('ios_contract_build_number_invalid');
  }
  if (binding.contractTestResult !== IOS_CONTRACT_RESULT) {
    reasons.push('ios_contract_result_not_passed');
  }
  if (!/^[0-9a-f]{64}$/.test(binding.fixtureDigest ?? '')) {
    reasons.push('ios_contract_fixture_digest_invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(binding.contractDigest ?? '')) {
    reasons.push('ios_contract_digest_invalid');
  }
  reasons.push(...iosDistributionBindingReasons(binding.distribution, binding, {
    required: requireDistribution,
  }));
  if (artifact && reasons.length === 0) {
    try {
      const fixture = backendIosContractFixtureIdentity({ bundleRoot: root, artifact });
      if (binding.fixtureDigest !== fixture.digest) {
        reasons.push('ios_contract_fixture_digest_mismatch');
      }
      const expectedContractDigest = backendIosContractDigest({
        runtimeSha,
        artifactDigest: artifact.digest,
        fixtureDigest: fixture.digest,
      });
      if (binding.contractDigest !== expectedContractDigest) {
        reasons.push('ios_contract_digest_mismatch');
      }
    } catch {
      reasons.push('ios_contract_fixture_invalid');
    }
  }
  return reasons;
}
function iosContractExpectationReasons(binding) {
  const expectBackendOnly = has('--expect-backend-only');
  const requireIos = has('--require-ios-contract');
  const expectedFieldsSupplied = [
    '--expect-ios-sha',
    '--expect-ios-build-number',
    '--expect-ios-contract-result',
  ].some(has);
  const reasons = [];
  if (expectBackendOnly && requireIos) return ['ios_contract_expectation_invalid'];
  if (!requireIos && expectedFieldsSupplied) reasons.push('ios_contract_expectation_invalid');
  if (expectBackendOnly && binding !== null) reasons.push('ios_contract_scope_mismatch');
  if (requireIos && (!binding || typeof binding !== 'object' || Array.isArray(binding))) {
    reasons.push('ios_contract_scope_mismatch');
    return reasons;
  }
  if (requireIos && expectedFieldsSupplied) {
    const expectedSha = valueOf('--expect-ios-sha', '');
    const expectedBuild = valueOf('--expect-ios-build-number', '');
    const expectedResult = valueOf('--expect-ios-contract-result', '');
    if (!expectedSha || !expectedBuild || !expectedResult) {
      reasons.push('ios_contract_expectation_missing');
    } else {
      if (binding.sha !== expectedSha) reasons.push('ios_contract_sha_mismatch');
      if (String(binding.buildNumber) !== expectedBuild) reasons.push('ios_contract_build_number_mismatch');
      if (binding.contractTestResult !== expectedResult) reasons.push('ios_contract_result_mismatch');
    }
  }
  return reasons;
}
function buildPayload() {
  const artifact = artifactManifest();
  const now = new Date();
  const runtimeSha = valueOf('--runtime-sha', git('rev-parse', 'HEAD'));
  const docsHead = valueOf('--docs-head', git('rev-parse', 'HEAD'));
  const testResultsPath = valueOf('--test-results', '.local/release/test-results.json');
  const testResultsInput = readJsonIfPresent(testResultsPath);
  const testPolicyDigest = fileSha('config/test-policy.json');
  const testBinding = {
    runtimeSha,
    artifactDigest: artifact.digest,
    testPolicyDigest,
  };
  const testResultErrors = releaseTestResultReasons(testResultsInput, testBinding, {
    referenceTimeMs: now.getTime(),
    verifyCiContext: true,
  });
  if (testResultErrors.length > 0) {
    throw new Error(`release test result is not reusable: ${testResultErrors.join(',')}`);
  }
  const ios = resolveIosContractBinding(artifact);
  const testResults = { ...testResultsInput, ...testBinding };
  const stagingEvidencePath = valueOf('--staging-evidence', '');
  const expiresHours = Number(valueOf('--expires-hours', '72'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return {
    schema: 'nexus.release-manifest-payload.v2',
    runtimeSha,
    docsHead,
    source: {
      dirty: git('status', '--porcelain=v1', '--untracked-files=normal').length > 0,
    },
    packageVersion: packageJson.version,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresHours * 3_600_000).toISOString(),
    toolchain: {
      node: process.version,
      npm: toolVersion('npm', ['--version']),
      python: testResults?.toolchain?.python
        ?? process.env.NEXUS_RELEASE_PYTHON_VERSION
        ?? toolVersion(process.env.NEXUS_RELEASE_PYTHON_BIN || 'python3', ['--version']),
    },
    artifact: {
      schema: artifact.schema,
      digest: artifact.digest,
      fileCount: artifact.fileCount,
      files: artifact.files.map(({ path: filePath, size, sha256: digest }) => ({
        path: filePath, size, sha256: digest,
      })),
    },
    migration: migrationIdentity(artifact),
    trainingCatalog: trainingIdentity(artifact),
    testPolicy: {
      digest: testPolicyDigest,
      results: testResults,
    },
    ci: {
      provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
    },
    staging: stagingEvidencePath ? readJsonIfPresent(stagingEvidencePath) : null,
    ios,
  };
}
function writeManifest() {
  const payload = buildPayload();
  const privatePem = pem('--private-key', 'NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM');
  if (!privatePem && !allowUnsigned) throw new Error('release manifest private key is required');
  const signature = privatePem
    ? cryptoSign(null, Buffer.from(canonicalJson(payload)), createPrivateKey(privatePem)).toString('base64')
    : null;
  const envelope = {
    schema: 'nexus.release-manifest.v2',
    keyId: valueOf('--key-id', process.env.NEXUS_RELEASE_MANIFEST_KEY_ID ?? 'local-unsigned'),
    signatureAlgorithm: 'ed25519',
    payload,
    signature,
  };
  const output = manifestPath(payload.runtimeSha);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, promotable: Boolean(signature), manifest: output, payload }, null, 2)}\n`);
}
function validateManifest() {
  const payloadOnly = command === 'validate-payload';
  const input = manifestPath();
  const envelope = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (envelope.schema !== 'nexus.release-manifest.v2') {
    process.stdout.write(`${JSON.stringify({ ok: false, promotable: false, legacyReadable: true, schema: envelope.schema }, null, 2)}\n`);
    process.exit(1);
  }
  const reasons = [];
  const payload = envelope.payload ?? {};
  const legacyKey = envelope.keyId === LEGACY_SIGNING_KEY_ID;
  const trackedPublicKeyPath = legacyKey
    ? 'docs/release/evidence/release-evidence-public-key-2026-06.pem'
    : 'docs/release/evidence/release-evidence-public-key.pem';
  if (payloadOnly) {
    if (envelope.keyId !== 'unsigned-release-candidate' || envelope.signature !== null) {
      reasons.push('unsigned_candidate_envelope_invalid');
    }
  } else {
    const publicPem = pem(
      '--public-key',
      'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
      trackedPublicKeyPath,
    );
    if (envelope.keyId !== CURRENT_SIGNING_KEY_ID && !legacyKey && !allowTestKey) {
      reasons.push('signing_key_id_untrusted');
    }
    if (publicPem && !allowTestKey && !matchesTrackedPublicKey(publicPem, trackedPublicKeyPath)) {
      reasons.push('public_key_identity_mismatch');
    }
    if (!publicPem) reasons.push('public_key_missing');
    else if (!envelope.signature) reasons.push('signature_missing');
    else if (!cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      createPublicKey(publicPem),
      Buffer.from(envelope.signature, 'base64'),
    )) reasons.push('signature_invalid');
    if (legacyKey) reasons.push('legacy_signing_key_non_reusable');
  }

  const expectedRuntimeSha = valueOf(
    '--expect-runtime-sha',
    verifyBundle ? payload.runtimeSha : git('rev-parse', 'HEAD'),
  );
  if (!/^[0-9a-f]{40}$/.test(expectedRuntimeSha ?? '')) reasons.push('runtime_sha_invalid');
  if (payload.runtimeSha !== expectedRuntimeSha) reasons.push('runtime_sha_mismatch');
  if (payload.source?.dirty && !allowDirtyForTest) reasons.push('source_worktree_dirty');
  const generatedAt = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAt)) reasons.push('manifest_generated_at_invalid');
  const expiry = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiry)) reasons.push('manifest_expiry_invalid');
  else if (expiry <= Date.now()) reasons.push('manifest_expired');
  const artifact = artifactManifest(expectedRuntimeSha);
  if (payload.artifact?.digest !== artifact.digest) reasons.push('artifact_digest_mismatch');
  if (payload.testPolicy?.digest !== fileSha('config/test-policy.json')) reasons.push('test_policy_digest_mismatch');
  const results = payload.testPolicy?.results;
  reasons.push(...releaseTestResultReasons(results, {
    runtimeSha: payload.runtimeSha,
    artifactDigest: payload.artifact?.digest,
    testPolicyDigest: payload.testPolicy?.digest,
  }, {
    requireBinding: true,
    referenceTimeMs: generatedAt,
  }));
  const stagingRequired = has('--require-staging');
  if (stagingRequired && (!payload.staging || payload.staging.status !== 'passed'
    || payload.staging.artifactDigest !== payload.artifact.digest)) reasons.push('staging_evidence_missing_or_mismatched');
  const iosBindingErrors = iosContractBindingReasons(payload.ios, artifact, payload.runtimeSha, {
    requireDistribution: !payloadOnly,
  });
  reasons.push(...iosBindingErrors);
  reasons.push(...iosContractExpectationReasons(payload.ios));
  process.stdout.write(`${JSON.stringify({
    ok: reasons.length === 0,
    promotable: !payloadOnly && reasons.length === 0,
    unsignedCandidate: payloadOnly,
    manifest: input,
    runtimeSha: payload.runtimeSha,
    docsHead: payload.docsHead,
    artifactDigest: payload.artifact?.digest,
    contractScope: payload.ios === null
      ? 'backend_only'
      : (iosBindingErrors.length === 0 ? 'shared_backend_ios' : 'invalid'),
    ios: payload.ios ?? null,
    legacyReadable: legacyKey || reasons.some((reason) => (
      reason.startsWith('release_test_')
      || reason.startsWith('ios_contract_')
      || reason.startsWith('ios_distribution_')
    )),
    reasons,
  }, null, 2)}\n`);
  process.exit(reasons.length === 0 ? 0 : 1);
}

if (verifyBundle && !['validate', 'status', 'validate-payload'].includes(command)) {
  throw new Error('--verify-bundle is valid only for manifest validation');
}
if (command === 'write') writeManifest();
else if (command === 'validate' || command === 'status' || command === 'validate-payload') validateManifest();
else throw new Error(`Usage: release-manifest-v2.mjs <write|validate|validate-payload|status> [options]`);
