import {
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BACKEND_IOS_CONTRACT_FIXTURE_PATH,
  BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA,
  backendIosContractDigest,
  canonicalJson,
  sha256,
} from './backend-ios-contract-fixture.mjs';

export const IOS_CONTRACT_PUBLIC_KEY_PATH =
  'docs/release/evidence/ios-contract-evidence-public-key.pem';
export const IOS_CONTRACT_TEST_SELECTORS = Object.freeze([
  'Nexus HubTests/BackendCandidateContractFixtureTests',
  'Nexus HubTests/ContractDecoderResilienceTests',
  'Nexus HubTests/HomeViewStateContractDecodingTests',
  'Nexus HubTests/TrainingHomeViewStateContractDecodingTests',
  'Nexus HubTests/ContentHomeContractDecodingTests',
  'Nexus HubTests/PlanGenerateResponseRaceDateTests',
  'Nexus HubTests/PlanGenerateResponseExpertCoachTests',
  'Nexus HubTests/PlanGenerateResponsePrimaryFocusTests',
  'Nexus HubTests/TrainingPlanClarificationResolutionTests',
]);

const ENVELOPE_SCHEMA = 'nexus.ios-contract-attestation.v2';
const PAYLOAD_SCHEMA = 'nexus.ios-contract-attestation-payload.v2';
const KEY_ID = 'ios-release-signing-2026-07';
const IOS_REPOSITORY = 'felipedrf74/nexus-hub-ios';
const BACKEND_REPOSITORY = 'felipedrf74/cortex-telegram-hub-bot';
const WORKFLOW = 'iOS Contract Evidence';
const SUITE_NAME = 'Nexus Hub contract decoder suite';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_PUBLIC_KEY_BYTES = 4 * 1024;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the trusted schema`);
  }
  return value;
}

function readPinnedPublicKey(trustedRoot) {
  const keyPath = path.join(trustedRoot, IOS_CONTRACT_PUBLIC_KEY_PATH);
  const stat = fs.lstatSync(keyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PUBLIC_KEY_BYTES) {
    fail('trusted iOS contract public key is not a bounded regular file');
  }
  try {
    const key = createPublicKey(fs.readFileSync(keyPath, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') fail('trusted iOS contract public key is not Ed25519');
    return key;
  } catch {
    fail('trusted iOS contract public key is malformed');
  }
}

/**
 * Verify the protected-main iOS decoder attestation against the exact backend
 * runtime artifact. This evidence is deliberately consumed only by the
 * post-promotion shared gate; it is not a field of the backend checkpoint
 * manifest, avoiding a circular dependency between the two repositories.
 */
export function validateIosContractAttestation({
  attestation,
  backendRuntimeSha,
  backendArtifactDigest,
  backendFixtureDigest,
  iosSha,
  buildNumber,
  trustedRoot,
  nowMs = Date.now(),
}) {
  exactKeys(attestation, [
    'schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature',
  ], 'iOS contract attestation envelope');
  if (attestation.schema !== ENVELOPE_SCHEMA
      || attestation.keyId !== KEY_ID
      || attestation.signatureAlgorithm !== 'ed25519'
      || typeof attestation.signature !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/.test(attestation.signature)) {
    fail('iOS contract attestation envelope identity is invalid');
  }
  const signature = Buffer.from(attestation.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== attestation.signature) {
    fail('iOS contract attestation signature is malformed');
  }

  const payload = exactKeys(attestation.payload, [
    'schema', 'generatedAt', 'expiresAt', 'ios', 'backend', 'contractSuite', 'ci',
  ], 'iOS contract attestation payload');
  if (payload.schema !== PAYLOAD_SCHEMA) fail('iOS contract attestation payload schema is invalid');

  const ios = exactKeys(payload.ios, ['repository', 'sha', 'buildNumber'], 'iOS contract source');
  if (ios.repository !== IOS_REPOSITORY
      || !/^[0-9a-f]{40}$/.test(ios.sha ?? '')
      || !/^[1-9][0-9]*$/.test(String(ios.buildNumber ?? ''))
      || ios.sha !== iosSha
      || String(ios.buildNumber) !== String(buildNumber)) {
    fail('iOS contract source identity is invalid or mismatched');
  }

  const backend = exactKeys(payload.backend, [
    'repository', 'runtimeSha', 'artifactDigest', 'contractDigest', 'fixture',
  ], 'iOS contract backend identity');
  const fixture = exactKeys(backend.fixture, [
    'schema', 'path', 'digest',
  ], 'iOS contract fixture identity');
  if (backend.repository !== BACKEND_REPOSITORY
      || backend.runtimeSha !== backendRuntimeSha
      || backend.artifactDigest !== backendArtifactDigest
      || fixture.schema !== BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA
      || fixture.path !== BACKEND_IOS_CONTRACT_FIXTURE_PATH
      || fixture.digest !== backendFixtureDigest
      || backend.contractDigest !== backendIosContractDigest({
        runtimeSha: backendRuntimeSha,
        artifactDigest: backendArtifactDigest,
        fixtureDigest: backendFixtureDigest,
      })) {
    fail('iOS contract backend release identity is invalid or mismatched');
  }

  const suite = exactKeys(payload.contractSuite, [
    'name', 'result', 'testCount', 'passedCount', 'failedCount', 'skippedCount',
    'testSelectors', 'selectionDigest',
  ], 'iOS contract suite');
  const expectedSelectionDigest = sha256(canonicalJson(IOS_CONTRACT_TEST_SELECTORS));
  if (suite.name !== SUITE_NAME
      || suite.result !== 'passed'
      || !Number.isSafeInteger(suite.testCount)
      || suite.testCount <= 0
      || suite.passedCount !== suite.testCount
      || suite.failedCount !== 0
      || suite.skippedCount !== 0
      || canonicalJson(suite.testSelectors) !== canonicalJson(IOS_CONTRACT_TEST_SELECTORS)
      || suite.selectionDigest !== expectedSelectionDigest) {
    fail('iOS contract suite evidence is invalid');
  }

  const ci = exactKeys(payload.ci, [
    'provider', 'workflow', 'runId', 'runAttempt',
  ], 'iOS contract CI identity');
  if (ci.provider !== 'github-actions'
      || ci.workflow !== WORKFLOW
      || !/^[1-9][0-9]*$/.test(String(ci.runId ?? ''))
      || !/^[1-9][0-9]*$/.test(String(ci.runAttempt ?? ''))) {
    fail('iOS contract CI identity is invalid');
  }

  const generatedAtMs = Date.parse(payload.generatedAt ?? '');
  const expiresAtMs = Date.parse(payload.expiresAt ?? '');
  // The protected iOS signer uses Date.toISOString() (three fractional
  // digits); retain second precision compatibility for already-issued v2
  // evidence while rejecting non-canonical offsets/variable precision.
  const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (!canonicalTimestamp.test(payload.generatedAt ?? '')
      || !canonicalTimestamp.test(payload.expiresAt ?? '')
      || !Number.isFinite(generatedAtMs)
      || !Number.isFinite(expiresAtMs)
      || generatedAtMs > nowMs + 5 * 60_000
      || expiresAtMs <= nowMs
      || expiresAtMs - generatedAtMs !== MAX_LIFETIME_MS) {
    fail('iOS contract attestation timing is invalid');
  }

  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      readPinnedPublicKey(trustedRoot),
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) fail('iOS contract attestation signature is invalid');

  return {
    binding: {
      result: 'passed',
      attestationDigest: sha256(canonicalJson(attestation)),
      payloadDigest: sha256(canonicalJson(payload)),
      iosSha: ios.sha,
      buildNumber: String(ios.buildNumber),
      backendRuntimeSha: backend.runtimeSha,
      backendArtifactDigest: backend.artifactDigest,
      backendFixtureDigest: fixture.digest,
      contractDigest: backend.contractDigest,
      selectionDigest: suite.selectionDigest,
      testCount: suite.testCount,
      generatedAt: payload.generatedAt,
      expiresAt: payload.expiresAt,
      ci: {
        runId: String(ci.runId),
        runAttempt: String(ci.runAttempt),
        workflow: ci.workflow,
      },
    },
    payload,
  };
}
