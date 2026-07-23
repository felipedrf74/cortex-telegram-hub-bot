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
import { fileURLToPath } from 'node:url';
import {
  PROTECTED_MAIN_REUSE_SCOPE,
  PROTECTED_MAIN_WORKFLOW,
  canonicalJson,
  sha256,
  validateProtectedMainCiEvidence,
} from './protected-main-ci-evidence.mjs';
import { validateReleaseSelection } from './release-test-evidence.mjs';
import { root } from './lib/test-policy.mjs';

export const SERVER_ACTIVATION_REQUEST_SCHEMA =
  'nexus.serverdominguez-protected-main-reuse-request.v1';
export const SERVER_ACTIVATION_PAYLOAD_SCHEMA =
  'nexus.serverdominguez-protected-main-reuse-payload.v1';
export const PROTECTED_MAIN_REUSE_ACTIVATION_SCHEMA =
  'nexus.protected-main-reuse-activation.v1';
export const PROTECTED_MAIN_REUSE_ACTIVATION_PAYLOAD_SCHEMA =
  'nexus.protected-main-reuse-activation-payload.v1';
export const SERVER_PROVENANCE_KEY_ID =
  'serverdominguez-release-provenance-2026-07';
export const RELEASE_EVIDENCE_KEY_ID =
  'github-environment-release-signing-2026-07';
export const REQUIRED_PRODUCTION_COMPARISONS = 5;
export const SERVER_REQUEST_LIFETIME_MS = 15 * 60 * 1_000;
export const ACTIVATION_LIFETIME_MS = 180 * 24 * 60 * 60 * 1_000;

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/u;
const TRANSACTION_ID_PATTERN =
  /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAIN_WORKFLOW_PATH = '.github/workflows/ci.yml';
const RC_WORKFLOW_PATH = '.github/workflows/release-candidate-evidence.yml';
const ACTIVATION_POLICY_FILES = Object.freeze([
  'scripts/protected-main-ci-evidence.mjs',
  'scripts/protected-main-reuse-activation.mjs',
  'scripts/release-plan-evaluator.mjs',
  'scripts/release-test-evidence.mjs',
  'scripts/release-manifest-v2.mjs',
  'scripts/trusted-release-signer.mjs',
  'scripts/lib/release-plan-authoritative-evidence.mjs',
  'scripts/lib/release-plan-evaluation.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/release-candidate-evidence.yml',
  '.github/workflows/sign-release-manifest.yml',
  '.github/workflows/sign-staging-attestation.yml',
]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const governed = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(governed)) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function requirePattern(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  return requirePattern(String(value ?? ''), POSITIVE_INTEGER_PATTERN, label);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function canonicalSignatureBytes(payload) {
  return Buffer.from(canonicalJson(payload));
}

function publicKey(value, label) {
  try {
    return createPublicKey(value);
  } catch {
    fail(`${label} is invalid`);
  }
}

function privateKey(value, label) {
  try {
    return createPrivateKey(value);
  } catch {
    fail(`${label} is invalid`);
  }
}

function verifyEnvelope(envelope, {
  schema,
  keyId,
  publicKeyPem,
  label,
}) {
  exactKeys(
    envelope,
    ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'],
    label,
  );
  if (envelope.schema !== schema || envelope.keyId !== keyId
      || envelope.signatureAlgorithm !== 'ed25519' || !isObject(envelope.payload)
      || typeof envelope.signature !== 'string') {
    fail(`${label} identity is invalid`);
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature
      || !cryptoVerify(
        null,
        canonicalSignatureBytes(envelope.payload),
        publicKey(publicKeyPem, `${label} public key`),
        signature,
      )) {
    fail(`${label} signature is invalid`);
  }
  return envelope.payload;
}

function signEnvelope(payload, {
  schema,
  keyId,
  privateKeyPem,
  label,
}) {
  const signature = cryptoSign(
    null,
    canonicalSignatureBytes(payload),
    privateKey(privateKeyPem, `${label} private key`),
  ).toString('base64');
  return {
    schema,
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature,
  };
}

export function protectedMainReusePolicyDigest(sourceRoot = root) {
  const files = ACTIVATION_POLICY_FILES.map((relativePath) => {
    const bytes = fs.readFileSync(path.join(sourceRoot, relativePath));
    return { path: relativePath, sha256: sha256(bytes) };
  });
  return sha256(canonicalJson(files));
}

function validateCompactComparison(entry, index) {
  const label = `server activation entries[${index}]`;
  exactKeys(entry, [
    'productionSequence',
    'productionReleaseId',
    'runtimeSha',
    'productionCompletedAt',
    'transactionId',
    'manifestSha256',
    'stagingAttestationSha256',
    'promotionJournalSha256',
    'promotionResultSha256',
    'comparisonSha256',
    'mainCi',
    'releaseCi',
    'exactAgreement',
  ], label);
  if (!Number.isSafeInteger(entry.productionSequence) || entry.productionSequence <= 0) {
    fail(`${label}.productionSequence is invalid`);
  }
  requirePattern(entry.productionReleaseId, SAFE_ID_PATTERN, `${label}.productionReleaseId`);
  requirePattern(entry.runtimeSha, SHA_PATTERN, `${label}.runtimeSha`);
  const completedAt = canonicalTimestamp(
    entry.productionCompletedAt,
    `${label}.productionCompletedAt`,
  );
  requirePattern(entry.transactionId, TRANSACTION_ID_PATTERN, `${label}.transactionId`);
  for (const name of [
    'manifestSha256',
    'stagingAttestationSha256',
    'promotionJournalSha256',
    'promotionResultSha256',
    'comparisonSha256',
  ]) requirePattern(entry[name], DIGEST_PATTERN, `${label}.${name}`);
  exactKeys(entry.mainCi, ['runId', 'runAttempt', 'artifactDigest'], `${label}.mainCi`);
  requirePositiveInteger(entry.mainCi.runId, `${label}.mainCi.runId`);
  requirePositiveInteger(entry.mainCi.runAttempt, `${label}.mainCi.runAttempt`);
  requirePattern(entry.mainCi.artifactDigest, DIGEST_PATTERN, `${label}.mainCi.artifactDigest`);
  exactKeys(entry.releaseCi, ['runId', 'runAttempt'], `${label}.releaseCi`);
  requirePositiveInteger(entry.releaseCi.runId, `${label}.releaseCi.runId`);
  requirePositiveInteger(entry.releaseCi.runAttempt, `${label}.releaseCi.runAttempt`);
  if (entry.exactAgreement !== true) fail(`${label}.exactAgreement must be true`);
  return { ...entry, completedAt };
}

function validateFiveEntries(entries, generatedAt, label = 'server activation payload') {
  if (!Array.isArray(entries) || entries.length !== REQUIRED_PRODUCTION_COMPARISONS) {
    fail(`${label} must contain exactly ${REQUIRED_PRODUCTION_COMPARISONS} production comparisons`);
  }
  const validated = entries.map(validateCompactComparison);
  for (const field of [
    'productionReleaseId',
    'runtimeSha',
    'transactionId',
    'manifestSha256',
    'comparisonSha256',
  ]) {
    if (new Set(validated.map((entry) => entry[field])).size !== validated.length) {
      fail(`${label} contains duplicate ${field}`);
    }
  }
  for (let index = 1; index < validated.length; index += 1) {
    if (validated[index].productionSequence !== validated[index - 1].productionSequence + 1) {
      fail(`${label} production sequence is not consecutive`);
    }
    if (validated[index].completedAt <= validated[index - 1].completedAt) {
      fail(`${label} production chronology is not strictly increasing`);
    }
  }
  if (generatedAt < validated.at(-1).completedAt) {
    fail(`${label} was generated before its final production completion`);
  }
  return validated;
}

export function validateServerActivationRequest(envelope, {
  serverPublicKeyPem,
  expectedPolicyDigest = '',
  nowMs = Date.now(),
} = {}) {
  if (!serverPublicKeyPem) fail('ServerDominguez provenance public key is required');
  const payload = verifyEnvelope(envelope, {
    schema: SERVER_ACTIVATION_REQUEST_SCHEMA,
    keyId: SERVER_PROVENANCE_KEY_ID,
    publicKeyPem: serverPublicKeyPem,
    label: 'ServerDominguez activation request',
  });
  exactKeys(payload, [
    'schema',
    'requestId',
    'generatedAt',
    'expiresAt',
    'reuseScope',
    'activationPolicyDigest',
    'entries',
  ], 'ServerDominguez activation request payload');
  if (payload.schema !== SERVER_ACTIVATION_PAYLOAD_SCHEMA
      || payload.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE) {
    fail('ServerDominguez activation request payload identity is invalid');
  }
  requirePattern(payload.requestId, SAFE_ID_PATTERN, 'activation request id');
  requirePattern(
    payload.activationPolicyDigest,
    DIGEST_PATTERN,
    'activation request policy digest',
  );
  if (expectedPolicyDigest && payload.activationPolicyDigest !== expectedPolicyDigest) {
    fail('activation request policy digest drifted');
  }
  const generatedAt = canonicalTimestamp(payload.generatedAt, 'activation request generatedAt');
  const expiresAt = canonicalTimestamp(payload.expiresAt, 'activation request expiresAt');
  if (generatedAt > nowMs + 5 * 60_000) fail('activation request timestamp is in the future');
  if (expiresAt <= generatedAt
      || expiresAt - generatedAt > SERVER_REQUEST_LIFETIME_MS
      || nowMs >= expiresAt) {
    fail('activation request lifetime is invalid or expired');
  }
  validateFiveEntries(payload.entries, generatedAt);
  return payload;
}

export function signServerActivationRequest(payload, privateKeyPem) {
  exactKeys(payload, [
    'schema',
    'requestId',
    'generatedAt',
    'expiresAt',
    'reuseScope',
    'activationPolicyDigest',
    'entries',
  ], 'ServerDominguez activation request payload');
  const generatedAt = canonicalTimestamp(payload.generatedAt, 'activation request generatedAt');
  const expiresAt = canonicalTimestamp(payload.expiresAt, 'activation request expiresAt');
  if (payload.schema !== SERVER_ACTIVATION_PAYLOAD_SCHEMA
      || payload.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE
      || !DIGEST_PATTERN.test(payload.activationPolicyDigest ?? '')
      || expiresAt <= generatedAt
      || expiresAt - generatedAt > SERVER_REQUEST_LIFETIME_MS) {
    fail('ServerDominguez activation request payload is invalid');
  }
  validateFiveEntries(payload.entries, generatedAt);
  return signEnvelope(payload, {
    schema: SERVER_ACTIVATION_REQUEST_SCHEMA,
    keyId: SERVER_PROVENANCE_KEY_ID,
    privateKeyPem,
    label: 'ServerDominguez activation request',
  });
}

function validateRun(raw, entry, kind, repository, index) {
  const expected = kind === 'main'
    ? {
      id: entry.mainCi.runId,
      attempt: entry.mainCi.runAttempt,
      path: MAIN_WORKFLOW_PATH,
      event: 'push',
      headBranch: 'main',
    }
    : {
      id: entry.releaseCi.runId,
      attempt: entry.releaseCi.runAttempt,
      path: RC_WORKFLOW_PATH,
      event: 'workflow_dispatch',
      headBranch: null,
    };
  const label = `GitHub provenance entries[${index}].${kind}`;
  if (!isObject(raw?.run)
      || String(raw.run.id) !== expected.id
      || String(raw.run.run_attempt) !== expected.attempt
      || raw.run.path !== expected.path
      || raw.run.event !== expected.event
      || raw.run.head_sha !== entry.runtimeSha
      || raw.run.status !== 'completed'
      || raw.run.conclusion !== 'success'
      || raw.run.repository?.full_name !== repository
      || raw.run.head_repository?.full_name !== repository
      || (expected.headBranch !== null && raw.run.head_branch !== expected.headBranch)) {
    fail(`${label} protected run identity is invalid`);
  }
  if (!Array.isArray(raw.artifacts?.artifacts)) fail(`${label} artifact inventory is missing`);
  const expectedName = kind === 'main'
    ? `protected-main-ci-evidence-${entry.mainCi.runId}-${entry.mainCi.runAttempt}`
    : `release-candidate-v2-${entry.runtimeSha}`;
  const matches = raw.artifacts.artifacts.filter((artifact) => artifact?.name === expectedName);
  if (matches.length !== 1
      || matches[0].expired === true
      || !Number.isSafeInteger(matches[0].id)
      || matches[0].id <= 0
      || !/^sha256:[0-9a-f]{64}$/u.test(matches[0].digest ?? '')
      || String(matches[0].workflow_run?.id) !== expected.id
      || matches[0].workflow_run?.head_sha !== entry.runtimeSha) {
    fail(`${label} protected artifact identity is missing or ambiguous`);
  }
  if (kind === 'main') {
    const runtimeName = `release-bundle-${entry.runtimeSha}-${entry.mainCi.artifactDigest}`;
    const runtimeMatches = raw.artifacts.artifacts.filter((artifact) => artifact?.name === runtimeName);
    if (runtimeMatches.length !== 1 || runtimeMatches[0].expired === true
        || !/^sha256:[0-9a-f]{64}$/u.test(runtimeMatches[0].digest ?? '')) {
      fail(`${label} exact runtime bundle identity is missing or ambiguous`);
    }
  }
  return {
    runId: expected.id,
    runAttempt: expected.attempt,
    evidenceArtifactId: String(matches[0].id),
    evidenceArtifactDigest: matches[0].digest,
  };
}

export function validateActivationGithubProvenance(githubEvidence, requestPayload, {
  repository,
} = {}) {
  exactKeys(githubEvidence, ['schema', 'repository', 'entries'], 'activation GitHub provenance');
  if (githubEvidence.schema !== 'nexus.protected-main-reuse-github-provenance.v1'
      || githubEvidence.repository !== repository || !repository) {
    fail('activation GitHub repository provenance is invalid');
  }
  if (!Array.isArray(githubEvidence.entries)
      || githubEvidence.entries.length !== REQUIRED_PRODUCTION_COMPARISONS) {
    fail('activation GitHub provenance must contain exactly five entries');
  }
  return githubEvidence.entries.map((raw, index) => {
    exactKeys(raw, ['runtimeSha', 'main', 'release'], `GitHub provenance entries[${index}]`);
    const requestEntry = requestPayload.entries[index];
    if (raw.runtimeSha !== requestEntry.runtimeSha) {
      fail(`GitHub provenance entries[${index}] runtime SHA is out of order`);
    }
    return {
      runtimeSha: raw.runtimeSha,
      main: validateRun(raw.main, requestEntry, 'main', repository, index),
      release: validateRun(raw.release, requestEntry, 'release', repository, index),
    };
  });
}

export function issueProtectedMainReuseActivation({
  serverRequest,
  serverPublicKeyPem,
  githubEvidence,
  repository,
  signingPrivateKeyPem,
  now = new Date(),
  sourceRoot = root,
}) {
  const issuedAtMs = now.getTime();
  if (!Number.isFinite(issuedAtMs)) fail('activation issue time is invalid');
  const policyDigest = protectedMainReusePolicyDigest(sourceRoot);
  const requestPayload = validateServerActivationRequest(serverRequest, {
    serverPublicKeyPem,
    expectedPolicyDigest: policyDigest,
    nowMs: issuedAtMs,
  });
  if (Date.parse(requestPayload.generatedAt) > issuedAtMs) {
    fail('activation request was generated after the protected issue time');
  }
  const github = validateActivationGithubProvenance(githubEvidence, requestPayload, { repository });
  const payload = {
    schema: PROTECTED_MAIN_REUSE_ACTIVATION_PAYLOAD_SCHEMA,
    status: 'active',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    activationPolicyDigest: policyDigest,
    issuedAt: now.toISOString(),
    expiresAt: new Date(issuedAtMs + ACTIVATION_LIFETIME_MS).toISOString(),
    sourceRequestSha256: sha256(canonicalJson(serverRequest)),
    serverProvenanceKeyId: SERVER_PROVENANCE_KEY_ID,
    repository,
    entries: requestPayload.entries,
    github,
  };
  return signEnvelope(payload, {
    schema: PROTECTED_MAIN_REUSE_ACTIVATION_SCHEMA,
    keyId: RELEASE_EVIDENCE_KEY_ID,
    privateKeyPem: signingPrivateKeyPem,
    label: 'protected-main reuse activation',
  });
}

export function validateProtectedMainReuseActivation(envelope, {
  releaseEvidencePublicKeyPem,
  expectedPolicyDigest = '',
  repository = '',
  nowMs = Date.now(),
} = {}) {
  if (!releaseEvidencePublicKeyPem) fail('release evidence public key is required');
  const payload = verifyEnvelope(envelope, {
    schema: PROTECTED_MAIN_REUSE_ACTIVATION_SCHEMA,
    keyId: RELEASE_EVIDENCE_KEY_ID,
    publicKeyPem: releaseEvidencePublicKeyPem,
    label: 'protected-main reuse activation',
  });
  exactKeys(payload, [
    'schema',
    'status',
    'reuseScope',
    'activationPolicyDigest',
    'issuedAt',
    'expiresAt',
    'sourceRequestSha256',
    'serverProvenanceKeyId',
    'repository',
    'entries',
    'github',
  ], 'protected-main reuse activation payload');
  if (payload.schema !== PROTECTED_MAIN_REUSE_ACTIVATION_PAYLOAD_SCHEMA
      || payload.status !== 'active'
      || payload.reuseScope !== PROTECTED_MAIN_REUSE_SCOPE
      || payload.serverProvenanceKeyId !== SERVER_PROVENANCE_KEY_ID) {
    fail('protected-main reuse activation payload identity is invalid');
  }
  requirePattern(payload.activationPolicyDigest, DIGEST_PATTERN, 'activation policy digest');
  requirePattern(payload.sourceRequestSha256, DIGEST_PATTERN, 'activation request digest');
  if (expectedPolicyDigest && payload.activationPolicyDigest !== expectedPolicyDigest) {
    fail('protected-main reuse activation policy drifted');
  }
  if (repository && payload.repository !== repository) {
    fail('protected-main reuse activation repository mismatch');
  }
  const issuedAt = canonicalTimestamp(payload.issuedAt, 'activation issuedAt');
  const expiresAt = canonicalTimestamp(payload.expiresAt, 'activation expiresAt');
  if (issuedAt > nowMs + 5 * 60_000 || expiresAt <= issuedAt || nowMs >= expiresAt) {
    fail('protected-main reuse activation is future-dated or expired');
  }
  validateFiveEntries(payload.entries, issuedAt, 'protected-main reuse activation');
  if (!Array.isArray(payload.github)
      || payload.github.length !== REQUIRED_PRODUCTION_COMPARISONS) {
    fail('protected-main reuse activation GitHub bindings are incomplete');
  }
  payload.github.forEach((entry, index) => {
    exactKeys(entry, ['runtimeSha', 'main', 'release'], `activation github[${index}]`);
    if (entry.runtimeSha !== payload.entries[index].runtimeSha) {
      fail(`activation github[${index}] runtime SHA mismatch`);
    }
    for (const kind of ['main', 'release']) {
      exactKeys(
        entry[kind],
        ['runId', 'runAttempt', 'evidenceArtifactId', 'evidenceArtifactDigest'],
        `activation github[${index}].${kind}`,
      );
      requirePositiveInteger(entry[kind].runId, `activation github[${index}].${kind}.runId`);
      requirePositiveInteger(
        entry[kind].runAttempt,
        `activation github[${index}].${kind}.runAttempt`,
      );
      requirePositiveInteger(
        entry[kind].evidenceArtifactId,
        `activation github[${index}].${kind}.evidenceArtifactId`,
      );
      if (!/^sha256:[0-9a-f]{64}$/u.test(entry[kind].evidenceArtifactDigest ?? '')) {
        fail(`activation github[${index}].${kind}.evidenceArtifactDigest is invalid`);
      }
    }
  });
  return payload;
}

export function decideProtectedMainReuse({
  activation,
  mainEvidence,
  selection,
  releaseEvidencePublicKeyPem,
  repository,
  nowMs = Date.now(),
  sourceRoot = root,
}) {
  try {
    const policyDigest = protectedMainReusePolicyDigest(sourceRoot);
    const activationPayload = validateProtectedMainReuseActivation(activation, {
      releaseEvidencePublicKeyPem,
      expectedPolicyDigest: policyDigest,
      repository,
      nowMs,
    });
    const validatedSelection = validateReleaseSelection(selection, {
      expectedHeadSha: mainEvidence?.headSha ?? '',
      expectedPolicyDigest: mainEvidence?.testPolicyDigest ?? '',
    });
    const evidence = validateProtectedMainCiEvidence(mainEvidence, {
      expectedHeadSha: validatedSelection.headSha,
      expectedPolicyDigest: validatedSelection.policyDigest,
    });
    if (activationPayload.entries.some((entry) => entry.runtimeSha === evidence.headSha)) {
      fail('activation cannot authorize a release from its own shadow window');
    }
    if (Date.parse(evidence.completedAt) <= Date.parse(activationPayload.issuedAt)) {
      fail('protected-main evidence predates reuse activation');
    }
    const expectedLockfiles = {
      packageLockSha256: sha256(fs.readFileSync(path.join(sourceRoot, 'package-lock.json'))),
      pythonRequirementsSha256: sha256(fs.readFileSync(path.join(
        sourceRoot,
        'content-engine/requirements.txt',
      ))),
    };
    if (canonicalJson(evidence.lockfiles) !== canonicalJson(expectedLockfiles)) {
      fail('protected-main evidence lockfiles drifted');
    }
    const selectedFiles = validatedSelection.selected.files;
    const mainFiles = new Set(evidence.vitest.files);
    if (!selectedFiles.every((file) => mainFiles.has(file))) {
      fail('protected-main evidence does not cover the release selection');
    }
    return {
      schema: 'nexus.protected-main-reuse-decision.v1',
      allowed: true,
      reason: null,
      runtimeSha: evidence.headSha,
      artifactName: evidence.build.artifactName,
      artifactDigest: evidence.build.artifactDigest,
      mainRunId: evidence.ci.runId,
      mainRunAttempt: evidence.ci.runAttempt,
      activationSha256: sha256(canonicalJson(activation)),
    };
  } catch (error) {
    return {
      schema: 'nexus.protected-main-reuse-decision.v1',
      allowed: false,
      reason: error instanceof Error ? error.message : String(error),
      runtimeSha: mainEvidence?.headSha ?? null,
      artifactName: null,
      artifactDigest: null,
      mainRunId: null,
      mainRunAttempt: null,
      activationSha256: null,
    };
  }
}

const args = process.argv.slice(2);
const command = args[0] ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};

function main() {
  if (command === 'validate-server-request') {
    const request = readJson(path.resolve(valueOf('--request')));
    const payload = validateServerActivationRequest(request, {
      serverPublicKeyPem: fs.readFileSync(path.resolve(valueOf('--server-public-key')), 'utf8'),
      expectedPolicyDigest: protectedMainReusePolicyDigest(path.resolve(valueOf('--source-root', root))),
    });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (command === 'issue') {
    const output = path.resolve(valueOf('--output'));
    const activation = issueProtectedMainReuseActivation({
      serverRequest: readJson(path.resolve(valueOf('--request'))),
      serverPublicKeyPem: fs.readFileSync(path.resolve(valueOf('--server-public-key')), 'utf8'),
      githubEvidence: readJson(path.resolve(valueOf('--github-evidence'))),
      repository: valueOf('--repository'),
      signingPrivateKeyPem: process.env.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM ?? '',
      sourceRoot: path.resolve(valueOf('--source-root', root)),
    });
    writeJson(output, activation);
    process.stdout.write(`${JSON.stringify(activation, null, 2)}\n`);
    return;
  }
  if (command === 'authorize') {
    const decision = decideProtectedMainReuse({
      activation: readJson(path.resolve(valueOf('--activation'))),
      mainEvidence: readJson(path.resolve(valueOf('--main-evidence'))),
      selection: readJson(path.resolve(valueOf('--selection'))),
      releaseEvidencePublicKeyPem: fs.readFileSync(path.resolve(valueOf(
        '--release-public-key',
        'docs/release/evidence/release-evidence-public-key.pem',
      )), 'utf8'),
      repository: valueOf('--repository', process.env.GITHUB_REPOSITORY ?? ''),
      sourceRoot: path.resolve(valueOf('--source-root', root)),
    });
    if (valueOf('--output')) writeJson(path.resolve(valueOf('--output')), decision);
    process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
    return;
  }
  if (command === 'validate-activation') {
    const payload = validateProtectedMainReuseActivation(
      readJson(path.resolve(valueOf('--activation'))),
      {
        releaseEvidencePublicKeyPem: fs.readFileSync(path.resolve(valueOf(
          '--release-public-key',
          'docs/release/evidence/release-evidence-public-key.pem',
        )), 'utf8'),
        expectedPolicyDigest: protectedMainReusePolicyDigest(
          path.resolve(valueOf('--source-root', root)),
        ),
        repository: valueOf('--repository', process.env.GITHUB_REPOSITORY ?? ''),
      },
    );
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  fail(
    'Usage: protected-main-reuse-activation.mjs '
    + '<validate-server-request|issue|validate-activation|authorize> [options]',
  );
}

if (process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
