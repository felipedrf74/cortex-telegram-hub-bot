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

const args = process.argv.slice(2);
const command = args[0] ?? 'validate';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const has = (name) => args.includes(name);
const root = path.resolve(valueOf('--root', process.cwd()));
const allowUnsigned = has('--allow-unsigned');
const allowDirtyForTest = has('--allow-dirty') && process.env.NODE_ENV === 'test';

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
function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim();
}
function toolVersion(commandName, commandArgs) {
  try {
    return execFileSync(commandName, commandArgs, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
function artifactManifest() {
  return JSON.parse(execFileSync(process.execPath, [
    path.join(root, 'scripts/release-artifact-manifest.mjs'), '--root', root, '--format', 'json',
  ], { cwd: root, encoding: 'utf8' }));
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
function manifestPath(runtimeSha = git('rev-parse', 'HEAD')) {
  return path.resolve(root, valueOf('--manifest', `.local/release/manifests/${runtimeSha}.json`));
}
function buildPayload() {
  const artifact = artifactManifest();
  const runtimeSha = valueOf('--runtime-sha', git('rev-parse', 'HEAD'));
  const docsHead = valueOf('--docs-head', git('rev-parse', 'HEAD'));
  const testResultsPath = valueOf('--test-results', '.local/release/test-results.json');
  const testResults = readJsonIfPresent(testResultsPath);
  const stagingEvidencePath = valueOf('--staging-evidence', '');
  const now = new Date();
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
      digest: fileSha('config/test-policy.json'),
      results: testResults,
    },
    ci: {
      provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      workflow: process.env.GITHUB_WORKFLOW ?? null,
    },
    staging: stagingEvidencePath ? readJsonIfPresent(stagingEvidencePath) : null,
    ios: has('--includes-ios') ? {
      sha: valueOf('--ios-sha', null),
      buildNumber: valueOf('--ios-build-number', null),
      contractTestResult: valueOf('--ios-contract-result', 'missing'),
    } : null,
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
  const input = manifestPath();
  const envelope = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (envelope.schema !== 'nexus.release-manifest.v2') {
    process.stdout.write(`${JSON.stringify({ ok: false, promotable: false, legacyReadable: true, schema: envelope.schema }, null, 2)}\n`);
    process.exit(1);
  }
  const reasons = [];
  const payload = envelope.payload ?? {};
  const publicPem = pem(
    '--public-key',
    'NEXUS_RELEASE_MANIFEST_PUBLIC_KEY_PEM',
    'docs/release/evidence/release-evidence-public-key.pem',
  );
  if (!publicPem) reasons.push('public_key_missing');
  else if (!envelope.signature) reasons.push('signature_missing');
  else if (!cryptoVerify(
    null,
    Buffer.from(canonicalJson(payload)),
    createPublicKey(publicPem),
    Buffer.from(envelope.signature, 'base64'),
  )) reasons.push('signature_invalid');

  const expectedRuntimeSha = valueOf('--expect-runtime-sha', git('rev-parse', 'HEAD'));
  if (payload.runtimeSha !== expectedRuntimeSha) reasons.push('runtime_sha_mismatch');
  if (payload.source?.dirty && !allowDirtyForTest) reasons.push('source_worktree_dirty');
  if (Date.parse(payload.expiresAt) <= Date.now()) reasons.push('manifest_expired');
  const artifact = artifactManifest();
  if (payload.artifact?.digest !== artifact.digest) reasons.push('artifact_digest_mismatch');
  if (payload.testPolicy?.digest !== fileSha('config/test-policy.json')) reasons.push('test_policy_digest_mismatch');
  const results = payload.testPolicy?.results;
  if (!results || results.status !== 'passed') reasons.push('release_tests_not_passed');
  const stagingRequired = has('--require-staging');
  if (stagingRequired && (!payload.staging || payload.staging.status !== 'passed'
    || payload.staging.artifactDigest !== payload.artifact.digest)) reasons.push('staging_evidence_missing_or_mismatched');
  process.stdout.write(`${JSON.stringify({
    ok: reasons.length === 0,
    promotable: reasons.length === 0,
    manifest: input,
    runtimeSha: payload.runtimeSha,
    docsHead: payload.docsHead,
    artifactDigest: payload.artifact?.digest,
    reasons,
  }, null, 2)}\n`);
  process.exit(reasons.length === 0 ? 0 : 1);
}

if (command === 'write') writeManifest();
else if (command === 'validate' || command === 'status') validateManifest();
else throw new Error(`Usage: release-manifest-v2.mjs <write|validate|status> [options]`);
