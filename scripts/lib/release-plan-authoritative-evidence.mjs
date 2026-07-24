import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareProtectedMainToRelease,
  validateProtectedMainCiEvidence,
  validateReleaseShadowComparison,
} from '../protected-main-ci-evidence.mjs';

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_FILES = 2_000;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CURRENT_SIGNING_KEY_ID = 'github-environment-release-signing-2026-07';
const GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS = 5_000;
const TRACKED_PUBLIC_KEY = path.resolve(
  import.meta.dirname,
  '../../docs/release/evidence/release-evidence-public-key.pem',
);
const CANONICAL_PROMOTION_ROOT = '/var/lib/nexus-release-promotion';
const TERMINAL_PROMOTION_STATUSES = new Set([
  'completed',
  'recovered',
  'failed_before_stop',
  'recovery_failed',
]);

export const RELEASE_QUALITY_EVIDENCE_SCHEMA = 'nexus.release-quality-evidence.v1';
export const RELEASE_QUALITY_EVIDENCE_PAYLOAD_SCHEMA =
  'nexus.release-quality-evidence-payload.v1';
export const RELEASE_PROTECTED_TIMING_SCHEMA = 'nexus.release-protected-timing.v1';
export const RELEASE_PROTECTED_TIMING_PAYLOAD_SCHEMA =
  'nexus.release-protected-timing-payload.v1';

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
  if (actual.length !== governed.length || actual.some((key, index) => key !== governed[index])) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a canonical UTC timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function requireDigest(value, label, pattern = DIGEST_PATTERN) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} is invalid`);
  return value;
}

function resolveEvidenceRoot(options) {
  if (!options?.evidenceRoot) fail('authoritative evidence root is required');
  const root = path.resolve(options.evidenceRoot);
  let stat;
  try { stat = fs.lstatSync(root); } catch { fail('authoritative evidence root cannot be read'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    fail('authoritative evidence root must be a real non-symlink directory');
  }
  return root;
}

function resolvePromotionRoot(options) {
  if (!options?.promotionEvidenceRoot) fail('root-owned promotion evidence root is required');
  const root = path.resolve(options.promotionEvidenceRoot);
  if (options.allowTestPromotionRoot !== true && root !== CANONICAL_PROMOTION_ROOT) {
    fail(`promotion evidence must be evaluated on ServerDominguez at ${CANONICAL_PROMOTION_ROOT}`);
  }
  let stat;
  try { stat = fs.lstatSync(root); } catch { fail('root-owned promotion evidence root cannot be read'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(root) !== root) {
    fail('root-owned promotion evidence root must be a real non-symlink directory');
  }
  if (options.allowTestPromotionRoot !== true && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
    fail('promotion evidence root is not protected by root ownership and mode');
  }
  return root;
}

function trustedPublicKey(options) {
  const requested = options?.trustedPublicKeyPath
    ? path.resolve(options.trustedPublicKeyPath)
    : TRACKED_PUBLIC_KEY;
  if (requested !== TRACKED_PUBLIC_KEY && options?.allowTestKey !== true) {
    fail('an alternate release evidence key is allowed only in test mode');
  }
  let stat;
  try { stat = fs.lstatSync(requested); } catch { fail('trusted release evidence public key cannot be read'); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(requested) !== requested) {
    fail('trusted release evidence public key must be a real non-symlink file');
  }
  try { return createPublicKey(fs.readFileSync(requested, 'utf8')); } catch {
    fail('trusted release evidence public key is invalid');
  }
}

function readReference(root, reference, label, {
  requireJson = true,
  requireRootOwnership = false,
  allowTestRootOwnership = false,
} = {}) {
  exactKeys(reference, ['path', 'sha256'], label);
  if (typeof reference.path !== 'string' || reference.path.length === 0
      || path.isAbsolute(reference.path) || reference.path.includes('\0')) {
    fail(`${label}.path must be a relative local evidence path`);
  }
  requireDigest(reference.sha256, `${label}.sha256`);
  const resolved = path.resolve(root, reference.path);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label}.path escapes the authoritative evidence root`);
  }
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail(`${label} cannot be read`); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    fail(`${label} must reference a real non-symlink file`);
  }
  if (requireRootOwnership && !allowTestRootOwnership) {
    let cursor = resolved;
    while (true) {
      const cursorStat = fs.lstatSync(cursor);
      if (cursorStat.isSymbolicLink() || cursorStat.uid !== 0 || (cursorStat.mode & 0o022) !== 0) {
        fail(`${label} is not protected by root ownership and mode`);
      }
      if (cursor === root) break;
      const parent = path.dirname(cursor);
      if (parent === cursor || !parent.startsWith(`${root}${path.sep}`) && parent !== root) {
        fail(`${label} ancestry escapes the root-owned promotion evidence root`);
      }
      cursor = parent;
    }
  }
  if (stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES) {
    fail(`${label} size is outside the governed range`);
  }
  const bytes = fs.readFileSync(resolved);
  if (sha256(bytes) !== reference.sha256) fail(`${label} SHA-256 does not match its reference`);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')) }; } catch {
    if (requireJson) fail(`${label} is not valid JSON`);
    return { bytes, value: null };
  }
}

function verifySignedEnvelope(envelope, schema, publicKey, label) {
  if (!isObject(envelope)
      || envelope.schema !== schema
      || envelope.keyId !== CURRENT_SIGNING_KEY_ID
      || envelope.signatureAlgorithm !== 'ed25519'
      || !isObject(envelope.payload)
      || typeof envelope.signature !== 'string') {
    fail(`${label} signed envelope is invalid or uses an untrusted key`);
  }
  let signature;
  try { signature = Buffer.from(envelope.signature, 'base64'); } catch {
    fail(`${label} signature is malformed`);
  }
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature
      || !cryptoVerify(null, Buffer.from(canonicalJson(envelope.payload)), publicKey, signature)) {
    fail(`${label} signature is invalid`);
  }
  return envelope.payload;
}

function requireIdentity(value, expected, label) {
  if (value !== expected) fail(`${label} does not match the authoritative evidence`);
}

function withinWallClockTolerance(wallMilliseconds, monotonicMilliseconds) {
  return Math.abs(wallMilliseconds - monotonicMilliseconds) <= 1_000;
}

function validateManifest(
  record,
  manifest,
  manifestDigest,
  publicKey,
  label,
  { requireTimingEvidence = false } = {},
) {
  const payload = verifySignedEnvelope(manifest, 'nexus.release-manifest.v2', publicKey, `${label}.releaseManifest`);
  if (payload.schema !== 'nexus.release-manifest-payload.v2'
      || payload.source?.dirty !== false
      || !SHA_PATTERN.test(payload.runtimeSha || '')
      || !DIGEST_PATTERN.test(payload.artifact?.digest || '')
      || payload.testPolicy?.results?.schema !== 'nexus.release-test-results.v3'
      || payload.testPolicy.results.status !== 'passed'
      || !SHA_PATTERN.test(payload.testPolicy.results.runtimeSha || '')
      || !DIGEST_PATTERN.test(payload.testPolicy.results.artifactDigest || '')
      || typeof payload.testPolicy.results.completedAt !== 'string') {
    fail(`${label}.releaseManifest payload is invalid`);
  }
  const generatedAt = canonicalTimestamp(payload.generatedAt, `${label}.releaseManifest.payload.generatedAt`);
  const expiresAt = canonicalTimestamp(payload.expiresAt, `${label}.releaseManifest.payload.expiresAt`);
  if (expiresAt <= generatedAt) fail(`${label}.releaseManifest lifetime is invalid`);
  requireIdentity(payload.runtimeSha, record.identity.manifestRuntimeSha, `${label}.identity.manifestRuntimeSha`);
  requireIdentity(payload.artifact.digest, record.identity.manifestArtifactDigest, `${label}.identity.manifestArtifactDigest`);
  requireIdentity(payload.testPolicy.results.runtimeSha, record.identity.evidenceRuntimeSha,
    `${label}.identity.evidenceRuntimeSha`);
  requireIdentity(payload.testPolicy.results.artifactDigest, record.identity.evidenceArtifactDigest,
    `${label}.identity.evidenceArtifactDigest`);
  requireIdentity(`v${payload.packageVersion}`, record.releaseId, `${label}.releaseId`);
  const releaseCandidateCompletedAt = canonicalTimestamp(
    payload.testPolicy.results.completedAt,
    `${label}.releaseManifest.payload.testPolicy.results.completedAt`,
  );
  requireIdentity(payload.testPolicy.results.completedAt, record.timing.automatedStages[1].completedAt,
    `${label}.timing.release_candidate.completedAt`);
  if (!requireTimingEvidence) {
    requireIdentity(payload.generatedAt, record.timing.automatedStages[2].completedAt,
      `${label}.timing.protected_signing.completedAt`);
  }
  const protectedMain = payload.testPolicy.results.protectedMainShadow?.evidence ?? null;
  const shadowBinding = payload.testPolicy.results.protectedMainShadow;
  let comparison = null;
  const completeShadowBinding = isObject(shadowBinding)
    && shadowBinding.mode === 'shadow'
    && isObject(shadowBinding.comparison);
  if (completeShadowBinding) {
    comparison = validateReleaseShadowComparison(shadowBinding.comparison, {
      expectedRuntimeSha: payload.runtimeSha,
    });
  }
  let protectedMainCompletedAt = null;
  if (protectedMain !== null) {
    if (completeShadowBinding) {
      const evidence = validateProtectedMainCiEvidence(protectedMain, {
        expectedHeadSha: payload.runtimeSha,
        expectedPolicyDigest: payload.testPolicy.digest,
      });
      const recomputed = compareProtectedMainToRelease(
        evidence,
        payload.testPolicy.results,
      );
      recomputed.comparedAt = comparison.comparedAt;
      if (canonicalJson(recomputed) !== canonicalJson(comparison)
          || evidence.build.artifactDigest !== payload.artifact.digest) {
        fail(`${label}.releaseManifest protected-main evidence identity is invalid`);
      }
    } else if (protectedMain.schema !== 'nexus.protected-main-ci-evidence.v1'
        || protectedMain.status !== 'passed'
        || protectedMain.headSha !== payload.runtimeSha
        || protectedMain.build?.artifactDigest !== payload.artifact.digest) {
      fail(`${label}.releaseManifest protected-main evidence identity is invalid`);
    }
    protectedMainCompletedAt = canonicalTimestamp(
      protectedMain.completedAt,
      `${label}.releaseManifest.payload.testPolicy.results.protectedMainShadow.evidence.completedAt`,
    );
    requireIdentity(protectedMain.completedAt, record.timing.automatedStages[0].completedAt,
      `${label}.timing.protected_main_ci.completedAt`);
  }
  if (protectedMainCompletedAt !== null && protectedMainCompletedAt > releaseCandidateCompletedAt) {
    fail(`${label}.releaseManifest protected-main and RC chronology is invalid`);
  }
  if (releaseCandidateCompletedAt > generatedAt) {
    fail(`${label}.releaseManifest RC and signing chronology is invalid`);
  }
  return {
    payload,
    manifestDigest,
    generatedAt,
    expiresAt,
    releaseCandidateCompletedAt,
    protectedMainCompletedAt,
    protectedMainShadow: {
      comparison,
      evidence: protectedMain,
    },
  };
}

function validateStaging(
  record,
  staging,
  manifestIdentity,
  publicKey,
  label,
  { requireTimingEvidence = false } = {},
) {
  const payload = verifySignedEnvelope(
    staging,
    'nexus.staging-attestation.v1',
    publicKey,
    `${label}.stagingAttestation`,
  );
  if (payload.schema !== 'nexus.staging-attestation-request.v1'
      || !SHA_PATTERN.test(payload.runtimeSha || '')
      || !DIGEST_PATTERN.test(payload.artifactDigest || '')
      || !DIGEST_PATTERN.test(payload.installedRuntimeDigest || '')
      || payload.smoke?.status !== 'passed') {
    fail(`${label}.stagingAttestation payload is invalid`);
  }
  const verifiedAt = canonicalTimestamp(payload.verifiedAt, `${label}.stagingAttestation.payload.verifiedAt`);
  const requestedAt = payload.protectedSigning?.requestedAt === undefined
    ? null
    : canonicalTimestamp(
      payload.protectedSigning.requestedAt,
      `${label}.stagingAttestation.payload.protectedSigning.requestedAt`,
    );
  const expiresAt = canonicalTimestamp(payload.expiresAt, `${label}.stagingAttestation.payload.expiresAt`);
  const promotionStartedAt = canonicalTimestamp(
    record.timing.automatedStages[4].startedAt,
    `${label}.timing.automatedStages[4].startedAt`,
  );
  if (verifiedAt < manifestIdentity.generatedAt || verifiedAt > manifestIdentity.expiresAt
      || expiresAt <= verifiedAt || promotionStartedAt > expiresAt
      || (requestedAt !== null
        && requestedAt + GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS < verifiedAt)) {
    fail(`${label}.stagingAttestation was not valid for this release interval`);
  }
  requireIdentity(payload.releaseManifestSha256, manifestIdentity.manifestDigest,
    `${label}.stagingAttestation.payload.releaseManifestSha256`);
  requireIdentity(payload.runtimeSha, manifestIdentity.payload.runtimeSha,
    `${label}.stagingAttestation.payload.runtimeSha`);
  requireIdentity(payload.artifactDigest, manifestIdentity.payload.artifact.digest,
    `${label}.stagingAttestation.payload.artifactDigest`);
  requireIdentity(payload.runtimeSha, record.identity.stagingRuntimeSha, `${label}.identity.stagingRuntimeSha`);
  requireIdentity(payload.artifactDigest, record.identity.stagingArtifactDigest,
    `${label}.identity.stagingArtifactDigest`);
  requireIdentity(payload.installedRuntimeDigest, record.identity.stagingInstalledRuntimeDigest,
    `${label}.identity.stagingInstalledRuntimeDigest`);
  if (!requireTimingEvidence) {
    const compatibilityBoundary = payload.protectedSigning?.requestedAt ?? payload.verifiedAt;
    requireIdentity(compatibilityBoundary, record.timing.automatedStages[3].completedAt,
      `${label}.timing.staging_validation.completedAt`);
    requireIdentity(compatibilityBoundary, record.timing.automatedReadinessCompletedAt,
      `${label}.timing.automatedReadinessCompletedAt`);
  }
  return {
    ...payload,
    verifiedAtMs: verifiedAt,
    requestedAtMs: requestedAt,
  };
}

function validateProtectedTiming(record, timingEnvelope, manifestIdentity, publicKey, label) {
  const payload = verifySignedEnvelope(
    timingEnvelope,
    RELEASE_PROTECTED_TIMING_SCHEMA,
    publicKey,
    `${label}.protectedTiming`,
  );
  exactKeys(payload, [
    'schema',
    'repository',
    'runtimeSha',
    'releaseManifestSha256',
    'generatedAt',
    'stages',
  ], `${label}.protectedTiming.payload`);
  if (payload.schema !== RELEASE_PROTECTED_TIMING_PAYLOAD_SCHEMA
      || payload.runtimeSha !== manifestIdentity.payload.runtimeSha
      || payload.releaseManifestSha256 !== manifestIdentity.manifestDigest
      || payload.repository
        !== manifestIdentity.protectedMainShadow.evidence?.ci?.repository) {
    fail(`${label}.protectedTiming payload identity is invalid`);
  }
  exactKeys(payload.stages, [
    'protectedMainCi',
    'releaseCandidate',
    'protectedSigning',
  ], `${label}.protectedTiming.payload.stages`);
  const expected = [
    {
      key: 'protectedMainCi',
      workflow: '.github/workflows/ci.yml',
      runId: manifestIdentity.protectedMainShadow.evidence?.ci?.runId,
      runAttempt: manifestIdentity.protectedMainShadow.evidence?.ci?.runAttempt,
      completedAt: manifestIdentity.protectedMainShadow.evidence?.completedAt,
      recordStage: record.timing.automatedStages[0],
    },
    {
      key: 'releaseCandidate',
      workflow: '.github/workflows/release-candidate-evidence.yml',
      runId: manifestIdentity.payload.testPolicy.results.ci?.runId,
      runAttempt: manifestIdentity.payload.testPolicy.results.ci?.runAttempt,
      completedAt: manifestIdentity.payload.testPolicy.results.completedAt,
      recordStage: record.timing.automatedStages[1],
    },
    {
      key: 'protectedSigning',
      workflow: '.github/workflows/sign-release-manifest.yml',
      runId: null,
      runAttempt: null,
      completedAt: payload.generatedAt,
      recordStage: record.timing.automatedStages[2],
    },
  ];
  let previousCompletedAt = null;
  for (const item of expected) {
    const stage = payload.stages[item.key];
    const stageLabel = `${label}.protectedTiming.payload.stages.${item.key}`;
    exactKeys(stage, [
      'workflow',
      'runId',
      'runAttempt',
      'startedAt',
      'completedAt',
      'githubCompletedAt',
    ], stageLabel);
    if (stage.workflow !== item.workflow
        || !/^[1-9][0-9]*$/u.test(stage.runId ?? '')
        || !/^[1-9][0-9]*$/u.test(stage.runAttempt ?? '')
        || (item.runId !== null && String(item.runId) !== stage.runId)
        || (item.runAttempt !== null && String(item.runAttempt) !== stage.runAttempt)
        || stage.completedAt !== item.completedAt
        || stage.startedAt !== item.recordStage.startedAt
        || stage.completedAt !== item.recordStage.completedAt) {
      fail(`${stageLabel} identity does not match signed release evidence`);
    }
    const startedAt = canonicalTimestamp(stage.startedAt, `${stageLabel}.startedAt`);
    const completedAt = canonicalTimestamp(stage.completedAt, `${stageLabel}.completedAt`);
    const githubCompletedAt = canonicalTimestamp(
      stage.githubCompletedAt,
      `${stageLabel}.githubCompletedAt`,
    );
    if (startedAt >= completedAt || completedAt > githubCompletedAt
        || (previousCompletedAt !== null && startedAt < previousCompletedAt)) {
      fail(`${stageLabel} chronology is invalid`);
    }
    previousCompletedAt = completedAt;
  }
  if (canonicalTimestamp(payload.generatedAt, `${label}.protectedTiming.payload.generatedAt`)
      !== canonicalTimestamp(
        payload.stages.protectedSigning.completedAt,
        `${label}.protectedTiming.payload.stages.protectedSigning.completedAt`,
      )) {
    fail(`${label}.protectedTiming generation identity is invalid`);
  }
  return payload;
}

function validateJournal(record, journal, stagingPayload, label) {
  if (journal?.schema !== 'nexus.promotion-transaction-journal.v1'
      || typeof journal.transactionId !== 'string'
      || journal.transactionId.length === 0
      || !DIGEST_PATTERN.test(journal.requestSha256 || '')
      || !isObject(journal.target)) {
    fail(`${label}.promotionJournal is invalid`);
  }
  requireIdentity(journal.target.sha, stagingPayload.runtimeSha, `${label}.promotionJournal.target.sha`);
  requireIdentity(journal.target.artifactDigest, stagingPayload.artifactDigest,
    `${label}.promotionJournal.target.artifactDigest`);
  requireIdentity(journal.target.installedRuntimeDigest, stagingPayload.installedRuntimeDigest,
    `${label}.promotionJournal.target.installedRuntimeDigest`);
  requireIdentity(journal.target.sentryRelease, stagingPayload.runtimeSha,
    `${label}.promotionJournal.target.sentryRelease`);
  requireIdentity(journal.sentryRelease, stagingPayload.runtimeSha, `${label}.promotionJournal.sentryRelease`);
  const expectedStatus = {
    passed: 'completed',
    recovered: 'recovered',
    failed_before_stop: 'failed_before_stop',
    recovery_failed: 'recovery_failed',
  }[record.promotion.outcome];
  requireIdentity(journal.status, expectedStatus, `${label}.promotionJournal.status`);
  canonicalTimestamp(journal.startedAt, `${label}.promotionJournal.startedAt`);
  canonicalTimestamp(journal.completedAt, `${label}.promotionJournal.completedAt`);
  requireIdentity(journal.completedAt, record.completedAt, `${label.replace('.authoritativeEvidence', '')}.completedAt`);
  requireIdentity(journal.startedAt, record.timing.automatedStages[4].startedAt,
    `${label}.timing.promotion.startedAt`);
  if (record.timing.cutover !== null) {
    requireIdentity(journal.completedAt, record.timing.automatedStages[4].completedAt,
      `${label}.timing.promotion.completedAt`);
    requireIdentity(journal.completedAt, record.timing.cutover.completedAt,
      `${label}.timing.cutover.completedAt`);
  }
  return journal;
}

function validateRootStagingTiming(record, evidence, stagingPayload, label) {
  if (evidence?.schema !== 'nexus.root-staging-attestation-evidence.v1'
      || evidence.requestId !== stagingPayload.requestId
      || evidence.runtimeSha !== stagingPayload.runtimeSha
      || evidence.artifactDigest !== stagingPayload.artifactDigest) {
    fail(`${label}.rootStagingEvidence identity is invalid`);
  }
  const startedAt = canonicalTimestamp(
    evidence.transaction?.startedAt,
    `${label}.rootStagingEvidence.transaction.startedAt`,
  );
  const readinessCompletedAt = canonicalTimestamp(
    evidence.transaction?.readinessCompletedAt,
    `${label}.rootStagingEvidence.transaction.readinessCompletedAt`,
  );
  const publishedAt = canonicalTimestamp(
    evidence.transaction?.publishedAt,
    `${label}.rootStagingEvidence.transaction.publishedAt`,
  );
  const stagingSignedAt = canonicalTimestamp(
    stagingPayload.protectedSigning?.signedAt,
    `${label}.stagingAttestation.payload.protectedSigning.signedAt`,
  );
  const completedAt = stagingPayload.requestedAtMs === null
    ? stagingPayload.verifiedAtMs
    : stagingPayload.requestedAtMs;
  const completedAtValue = stagingPayload.requestedAtMs === null
    ? stagingPayload.verifiedAt
    : stagingPayload.protectedSigning.requestedAt;
  if (startedAt >= readinessCompletedAt || readinessCompletedAt > publishedAt
      || publishedAt > stagingPayload.verifiedAtMs
      || completedAt + GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS
        < stagingPayload.verifiedAtMs
      || completedAt > stagingSignedAt
      || record.timing.automatedStages[3].startedAt !== evidence.transaction.startedAt
      || record.timing.automatedStages[3].completedAt !== completedAtValue) {
    fail(`${label}.rootStagingEvidence timing is invalid`);
  }
  return {
    startedAt: evidence.transaction.startedAt,
    readinessPublishedAt: evidence.transaction.publishedAt,
    completedAt: completedAtValue,
    requestedAtExplicit: stagingPayload.requestedAtMs !== null,
  };
}

function validatePromotionRequestTiming(record, request, journal, stagingPayload, label) {
  if (request?.schema !== 'nexus.promotion-transaction-request.v1'
      || request.transactionId !== journal.transactionId
      || request.ownerAuthorization !== 'explicit'
      || request.target?.sha !== journal.target.sha
      || request.target?.artifactDigest !== journal.target.artifactDigest
      || request.target?.installedRuntimeDigest !== journal.target.installedRuntimeDigest
      || request.releaseEvidence?.releaseManifestSha256
        !== record.authoritativeEvidence.releaseManifest.sha256
      || request.releaseEvidence?.stagingAttestationSha256
        !== record.authoritativeEvidence.stagingAttestation.sha256) {
    fail(`${label}.promotionRequest identity is invalid`);
  }
  if (sha256(canonicalJson(request)) !== journal.requestSha256) {
    fail(`${label}.promotionRequest canonical digest does not match the root journal`);
  }
  const protectedSigningKeys = [
    'workflow',
    'runId',
    'runAttempt',
    'signedAt',
  ];
  if (stagingPayload.protectedSigning?.requestedAt !== undefined) {
    protectedSigningKeys.push('requestedAt');
  }
  exactKeys(
    stagingPayload.protectedSigning,
    protectedSigningKeys,
    `${label}.stagingAttestation.payload.protectedSigning`,
  );
  if (stagingPayload.protectedSigning.workflow
        !== '.github/workflows/sign-staging-attestation.yml'
      || !/^[1-9][0-9]*$/u.test(stagingPayload.protectedSigning.runId ?? '')
      || !/^[1-9][0-9]*$/u.test(stagingPayload.protectedSigning.runAttempt ?? '')) {
    fail(`${label}.stagingAttestation protected signing identity is invalid`);
  }
  const createdAt = canonicalTimestamp(
    request.createdAt,
    `${label}.promotionRequest.createdAt`,
  );
  const stagingSignedAt = canonicalTimestamp(
    stagingPayload.protectedSigning?.signedAt,
    `${label}.stagingAttestation.payload.protectedSigning.signedAt`,
  );
  const stagingRequestedAt = stagingPayload.protectedSigning?.requestedAt === undefined
    ? null
    : canonicalTimestamp(
      stagingPayload.protectedSigning.requestedAt,
      `${label}.stagingAttestation.payload.protectedSigning.requestedAt`,
    );
  const promotionStartedAt = canonicalTimestamp(
    journal.startedAt,
    `${label}.promotionJournal.startedAt`,
  );
  if ((stagingRequestedAt !== null && stagingRequestedAt > stagingSignedAt)
      || stagingSignedAt > createdAt
      || createdAt > promotionStartedAt) {
    fail(`${label}.promotionRequest chronology is invalid`);
  }
  return {
    stagingRequestedAt: stagingPayload.protectedSigning.requestedAt ?? null,
    stagingSignedAt: stagingPayload.protectedSigning.signedAt,
    createdAt: request.createdAt,
  };
}

function parsePromotionResultEnv(bytes, label) {
  const values = new Map();
  for (const line of bytes.toString('utf8').split(/\r?\n/u)) {
    if (line === '') continue;
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
    if (!match || values.has(match[1])) fail(`${label} is not a canonical root promotion result`);
    values.set(match[1], match[2]);
  }
  const required = [
    'NEXUS_TRANSACTION_ID',
    'NEXUS_RUNTIME_SHA',
    'NEXUS_SENTRY_RELEASE',
    'NEXUS_ARTIFACT_DIGEST',
    'NEXUS_INSTALLED_RUNTIME_DIGEST',
    'NEXUS_CUTOVER_STARTED_AT',
    'NEXUS_SERVICE_UNAVAILABLE_STARTED_AT',
    'NEXUS_CANDIDATE_AVAILABLE_AT',
    'NEXUS_FINAL_UNAVAILABILITY_SECONDS',
    'NEXUS_VERIFICATION_SOAK_SECONDS',
    'NEXUS_SOAK_OBSERVED_SECONDS',
  ];
  if (required.some((name) => !values.has(name))) {
    fail(`${label} is missing required root promotion result fields`);
  }
  return values;
}

function resultInteger(values, name, label) {
  const raw = values.get(name) || '';
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) fail(`${label}.${name} is invalid`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) fail(`${label}.${name} is invalid`);
  return parsed;
}

function validatePassedResult(record, resultBytes, journal, stagingPayload, label) {
  const result = parsePromotionResultEnv(resultBytes, `${label}.promotionResult`);
  for (const [name, expected] of [
    ['NEXUS_RUNTIME_SHA', stagingPayload.runtimeSha],
    ['NEXUS_ARTIFACT_DIGEST', stagingPayload.artifactDigest],
    ['NEXUS_INSTALLED_RUNTIME_DIGEST', stagingPayload.installedRuntimeDigest],
    ['NEXUS_SENTRY_RELEASE', stagingPayload.runtimeSha],
    ['NEXUS_TRANSACTION_ID', journal.transactionId],
  ]) requireIdentity(result.get(name), expected, `${label}.promotionResult.${name}`);
  requireIdentity(result.get('NEXUS_RUNTIME_SHA'), record.identity.productionRuntimeSha,
    `${label}.identity.productionRuntimeSha`);
  requireIdentity(result.get('NEXUS_ARTIFACT_DIGEST'), record.identity.productionArtifactDigest,
    `${label}.identity.productionArtifactDigest`);
  requireIdentity(result.get('NEXUS_INSTALLED_RUNTIME_DIGEST'), record.identity.productionInstalledRuntimeDigest,
    `${label}.identity.productionInstalledRuntimeDigest`);
  requireIdentity(result.get('NEXUS_CUTOVER_STARTED_AT'), record.timing.cutover?.startedAt,
    `${label}.timing.cutover.startedAt`);
  requireIdentity(result.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT'), record.timing.cutover?.serviceUnavailableAt,
    `${label}.timing.cutover.serviceUnavailableAt`);
  requireIdentity(result.get('NEXUS_CANDIDATE_AVAILABLE_AT'), record.timing.cutover?.serviceAvailableAt,
    `${label}.timing.cutover.serviceAvailableAt`);
  const unavailableMs = canonicalTimestamp(result.get('NEXUS_CANDIDATE_AVAILABLE_AT'),
    `${label}.promotionResult.NEXUS_CANDIDATE_AVAILABLE_AT`)
    - canonicalTimestamp(result.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT'),
      `${label}.promotionResult.NEXUS_SERVICE_UNAVAILABLE_STARTED_AT`);
  const finalUnavailabilitySeconds = resultInteger(
    result,
    'NEXUS_FINAL_UNAVAILABILITY_SECONDS',
    `${label}.promotionResult`,
  );
  const verificationSoakSeconds = resultInteger(
    result,
    'NEXUS_VERIFICATION_SOAK_SECONDS',
    `${label}.promotionResult`,
  );
  const soakObservedSeconds = resultInteger(
    result,
    'NEXUS_SOAK_OBSERVED_SECONDS',
    `${label}.promotionResult`,
  );
  if (verificationSoakSeconds < 60 || soakObservedSeconds < verificationSoakSeconds) {
    fail(`${label}.promotionResult did not observe the configured minimum soak`);
  }
  if (!withinWallClockTolerance(unavailableMs, finalUnavailabilitySeconds * 1_000)) {
    fail(`${label}.promotionResult timing does not match the observed cutover`);
  }
  const soakStartedAt = result.get('NEXUS_SOAK_STARTED_AT') || '';
  const soakCompletedAt = result.get('NEXUS_SOAK_COMPLETED_AT') || '';
  if ((soakStartedAt === '') !== (soakCompletedAt === '')) {
    fail(`${label}.promotionResult explicit soak timestamps are incomplete`);
  }
  const soakExplicit = soakStartedAt !== '';
  if (soakExplicit) {
    const soakMs = canonicalTimestamp(soakCompletedAt, `${label}.promotionResult.NEXUS_SOAK_COMPLETED_AT`)
      - canonicalTimestamp(soakStartedAt, `${label}.promotionResult.NEXUS_SOAK_STARTED_AT`);
    if (!withinWallClockTolerance(soakMs, soakObservedSeconds * 1_000)) {
      fail(`${label}.promotionResult explicit soak timestamps contradict its duration`);
    }
    requireIdentity(soakStartedAt, record.timing.cutover?.soakStartedAt,
      `${label}.timing.cutover.soakStartedAt`);
    requireIdentity(soakCompletedAt, record.timing.cutover?.soakCompletedAt,
      `${label}.timing.cutover.soakCompletedAt`);
  }
  return {
    soakExplicit,
    promotionTimingExplicit: true,
    actualUnavailabilityExplicit: true,
    actualUnavailabilityMs: finalUnavailabilitySeconds * 1_000,
    soakObservedMs: soakObservedSeconds * 1_000,
    rollbackRecoveryMs: null,
    totalCutoverExplicit: true,
  };
}

function validateRecoveryResult(record, result, journal, label) {
  if (result?.schema !== 'nexus.promotion-recovery-result.v1'
      || !Number.isSafeInteger(result.outageToHealthySeconds)
      || result.outageToHealthySeconds < 0) {
    fail(`${label}.promotionResult recovery evidence is invalid`);
  }
  requireIdentity(result.outageStartedAt, record.timing.cutover?.serviceUnavailableAt,
    `${label}.timing.cutover.serviceUnavailableAt`);
  requireIdentity(result.predecessorHealthyAt, record.timing.cutover?.serviceAvailableAt,
    `${label}.timing.cutover.serviceAvailableAt`);
  const elapsedMs = canonicalTimestamp(result.predecessorHealthyAt,
    `${label}.promotionResult.predecessorHealthyAt`)
    - canonicalTimestamp(result.outageStartedAt, `${label}.promotionResult.outageStartedAt`);
  if (!withinWallClockTolerance(elapsedMs, result.outageToHealthySeconds * 1_000)
      || result.targetSeconds !== 120
      || result.targetMet !== (result.outageToHealthySeconds <= result.targetSeconds)) {
    fail(`${label}.promotionResult recovery timing or outcome is inconsistent`);
  }
  if (!isObject(journal.recovery)
      || canonicalJson(journal.recovery) !== canonicalJson(result)) {
    fail(`${label}.promotionResult is not the recovery result sealed in the root journal`);
  }
  return {
    soakExplicit: true,
    promotionTimingExplicit: true,
    actualUnavailabilityExplicit: true,
    actualUnavailabilityMs: result.outageToHealthySeconds * 1_000,
    soakObservedMs: null,
    rollbackRecoveryMs: result.outageToHealthySeconds * 1_000,
    totalCutoverExplicit: false,
  };
}

export function validateAuthoritativeReleaseEvidence(record, index, options = {}) {
  const label = `releases[${index}].authoritativeEvidence`;
  const requireTimingEvidence = options.requireTimingEvidence === true;
  exactKeys(record.authoritativeEvidence, [
    'releaseManifest',
    'stagingAttestation',
    ...(requireTimingEvidence ? [
      'protectedTiming',
      'rootStagingEvidence',
      'promotionRequest',
    ] : []),
    'promotionJournal',
    'promotionResult',
  ], label);
  const root = resolveEvidenceRoot(options);
  const promotionRoot = resolvePromotionRoot(options);
  const publicKey = trustedPublicKey(options);
  const manifest = readReference(root, record.authoritativeEvidence.releaseManifest,
    `${label}.releaseManifest`);
  const staging = readReference(root, record.authoritativeEvidence.stagingAttestation,
    `${label}.stagingAttestation`);
  const journalPathMatch = record.authoritativeEvidence.promotionJournal.path?.match(
    /^transactions\/([0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12})\/state\/journal\.json$/u,
  );
  if (!journalPathMatch) fail(`${label}.promotionJournal path is not canonical root transaction state`);
  const journal = readReference(promotionRoot, record.authoritativeEvidence.promotionJournal,
    `${label}.promotionJournal`, {
      requireRootOwnership: true,
      allowTestRootOwnership: options.allowTestPromotionRoot === true,
    });
  const expectedResultPath = record.promotion.outcome === 'passed'
    ? `transactions/${journalPathMatch[1]}/state/result.env`
    : record.promotion.outcome === 'recovered'
      ? `transactions/${journalPathMatch[1]}/state/recovery-result.json`
      : record.authoritativeEvidence.promotionJournal.path;
  if (record.authoritativeEvidence.promotionResult.path !== expectedResultPath) {
    fail(`${label}.promotionResult path is not canonical root transaction state`);
  }
  const result = readReference(promotionRoot, record.authoritativeEvidence.promotionResult,
    `${label}.promotionResult`, {
      requireJson: record.promotion.outcome !== 'passed',
      requireRootOwnership: true,
      allowTestRootOwnership: options.allowTestPromotionRoot === true,
    });

  const manifestIdentity = validateManifest(record, manifest.value, manifest.referenceSha256
    || record.authoritativeEvidence.releaseManifest.sha256, publicKey, label, {
    requireTimingEvidence,
  });
  const stagingPayload = validateStaging(
    record,
    staging.value,
    manifestIdentity,
    publicKey,
    label,
    { requireTimingEvidence },
  );
  const journalValue = validateJournal(record, journal.value, stagingPayload, label);
  requireIdentity(journalValue.transactionId, journalPathMatch[1], `${label}.promotionJournal.transactionId`);
  let timingAuthority = null;
  if (requireTimingEvidence) {
    const expectedTimingPath = `timing/${manifestIdentity.payload.runtimeSha}.json`;
    if (record.authoritativeEvidence.protectedTiming.path !== expectedTimingPath) {
      fail(`${label}.protectedTiming path is not canonical`);
    }
    const timing = readReference(
      root,
      record.authoritativeEvidence.protectedTiming,
      `${label}.protectedTiming`,
    );
    const expectedRootStagingPath = `staging/${stagingPayload.requestId}.evidence.json`;
    if (record.authoritativeEvidence.rootStagingEvidence.path !== expectedRootStagingPath) {
      fail(`${label}.rootStagingEvidence path is not canonical`);
    }
    const rootStaging = readReference(
      promotionRoot,
      record.authoritativeEvidence.rootStagingEvidence,
      `${label}.rootStagingEvidence`,
      {
        requireRootOwnership: true,
        allowTestRootOwnership: options.allowTestPromotionRoot === true,
      },
    );
    const expectedPromotionRequestPath = `requests/${journalValue.transactionId}.json`;
    if (record.authoritativeEvidence.promotionRequest.path !== expectedPromotionRequestPath) {
      fail(`${label}.promotionRequest path is not canonical`);
    }
    const promotionRequest = readReference(
      promotionRoot,
      record.authoritativeEvidence.promotionRequest,
      `${label}.promotionRequest`,
      {
        requireRootOwnership: true,
        allowTestRootOwnership: options.allowTestPromotionRoot === true,
      },
    );
    const protectedTiming = validateProtectedTiming(
      record,
      timing.value,
      manifestIdentity,
      publicKey,
      label,
    );
    requireIdentity(
      protectedTiming.stages.releaseCandidate.completedAt,
      record.timing.automatedReadinessCompletedAt,
      `${label}.timing.automatedReadinessCompletedAt`,
    );
    const rootStagingTiming = validateRootStagingTiming(
      record,
      rootStaging.value,
      stagingPayload,
      label,
    );
    const promotionRequestTiming = validatePromotionRequestTiming(
      record,
      promotionRequest.value,
      journalValue,
      stagingPayload,
      label,
    );
    const stagingTimingExplicit = rootStagingTiming.requestedAtExplicit
      && promotionRequestTiming.stagingRequestedAt !== null;
    if (stagingTimingExplicit) {
      const expectedHandoffs = [
        {
          phase: 'protected-main-to-rc',
          readyAt: protectedTiming.stages.protectedMainCi.completedAt,
          startedAt: protectedTiming.stages.releaseCandidate.startedAt,
          approvalKind: null,
        },
        {
          phase: 'release-signing-approval',
          readyAt: protectedTiming.stages.releaseCandidate.completedAt,
          startedAt: protectedTiming.stages.protectedSigning.startedAt,
          approvalKind: 'release_signing',
        },
        {
          phase: 'signing-to-staging',
          readyAt: protectedTiming.stages.protectedSigning.completedAt,
          startedAt: rootStagingTiming.startedAt,
          approvalKind: null,
        },
        {
          phase: 'staging-attestation-signing',
          readyAt: rootStagingTiming.completedAt,
          startedAt: promotionRequestTiming.stagingSignedAt,
          approvalKind: 'release_signing',
        },
        {
          phase: 'production-owner-approval',
          readyAt: promotionRequestTiming.stagingSignedAt,
          startedAt: promotionRequestTiming.createdAt,
          approvalKind: 'production_owner',
        },
        {
          phase: 'promotion-submit',
          readyAt: promotionRequestTiming.createdAt,
          startedAt: journalValue.startedAt,
          approvalKind: null,
        },
      ];
      if (canonicalJson(record.timing.handoffs) !== canonicalJson(expectedHandoffs)) {
        fail(`${label}.timing.handoffs do not match signed and root-owned transition evidence`);
      }
    }
    timingAuthority = {
      protectedTimingSha256: record.authoritativeEvidence.protectedTiming.sha256,
      rootStagingEvidenceSha256: record.authoritativeEvidence.rootStagingEvidence.sha256,
      promotionRequestSha256: record.authoritativeEvidence.promotionRequest.sha256,
      stagingTimingExplicit,
    };
  }
  let promotionAuthority;
  if (record.promotion.outcome === 'passed') {
    promotionAuthority = validatePassedResult(record, result.bytes, journalValue, stagingPayload, label);
  } else if (record.promotion.outcome === 'recovered') {
    promotionAuthority = validateRecoveryResult(record, result.value, journalValue, label);
  } else if (canonicalJson(result.value) !== canonicalJson(journalValue)) {
    fail(`${label}.promotionResult must be the terminal root journal before service mutation`);
  }
  return {
    protectedMainCompletionExplicit: manifestIdentity.protectedMainCompletedAt !== null,
    automatedReadinessStartExplicit: timingAuthority !== null,
    handoffsExplicit: timingAuthority?.stagingTimingExplicit === true,
    stageDurationsExplicit: {
      protected_main_ci: requireTimingEvidence,
      release_candidate: requireTimingEvidence,
      protected_signing: requireTimingEvidence,
      staging_validation: timingAuthority?.stagingTimingExplicit === true,
      promotion: promotionAuthority?.promotionTimingExplicit === true,
    },
    actualUnavailabilityExplicit: promotionAuthority?.actualUnavailabilityExplicit === true,
    totalCutoverExplicit: promotionAuthority?.totalCutoverExplicit === true,
    soakExplicit: record.promotion.outcome !== 'passed'
      || promotionAuthority?.soakExplicit === true,
    actualUnavailabilityMs: promotionAuthority?.actualUnavailabilityMs ?? null,
    soakObservedMs: promotionAuthority?.soakObservedMs ?? null,
    rollbackRecoveryMs: promotionAuthority?.rollbackRecoveryMs ?? null,
    reuseProvenance: {
      transactionId: journalValue.transactionId,
      productionCompletedAt: journalValue.completedAt,
      manifestSha256: record.authoritativeEvidence.releaseManifest.sha256,
      stagingAttestationSha256: record.authoritativeEvidence.stagingAttestation.sha256,
      promotionJournalSha256: record.authoritativeEvidence.promotionJournal.sha256,
      promotionResultSha256: record.authoritativeEvidence.promotionResult.sha256,
      protectedTimingSha256: timingAuthority?.protectedTimingSha256 ?? null,
      rootStagingEvidenceSha256: timingAuthority?.rootStagingEvidenceSha256 ?? null,
      promotionRequestSha256: timingAuthority?.promotionRequestSha256 ?? null,
      comparisonSha256: sha256(canonicalJson(manifestIdentity.protectedMainShadow.comparison)),
      comparison: manifestIdentity.protectedMainShadow.comparison,
    },
  };
}

function assertRootProtectedPath(file, promotionRoot, label, allowTestPromotionRoot) {
  let cursor = file;
  while (true) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()
        || (!allowTestPromotionRoot && (stat.uid !== 0 || (stat.mode & 0o022) !== 0))) {
      fail(`${label} is not protected by root ownership and mode`);
    }
    if (cursor === promotionRoot) break;
    const parent = path.dirname(cursor);
    if (parent === cursor
        || (!parent.startsWith(`${promotionRoot}${path.sep}`) && parent !== promotionRoot)) {
      fail(`${label} ancestry escapes the promotion evidence root`);
    }
    cursor = parent;
  }
}

function readPromotionInventory(options = {}) {
  const promotionRoot = resolvePromotionRoot(options);
  const transactionsRoot = path.join(promotionRoot, 'transactions');
  let transactionEntries;
  try {
    transactionEntries = fs.readdirSync(transactionsRoot, { withFileTypes: true });
  } catch {
    fail('root-owned promotion transaction inventory cannot be read');
  }
  const terminal = [];
  for (const entry of transactionEntries) {
    if (!entry.isDirectory()
        || !/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(entry.name)) continue;
    const journalPath = path.join(transactionsRoot, entry.name, 'state', 'journal.json');
    if (!fs.existsSync(journalPath)) continue;
    const stat = fs.lstatSync(journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(journalPath) !== journalPath) {
      fail(`promotion journal inventory contains an unsafe path: ${entry.name}`);
    }
    assertRootProtectedPath(
      journalPath,
      promotionRoot,
      `promotion journal ${entry.name}`,
      options.allowTestPromotionRoot === true,
    );
    const bytes = fs.readFileSync(journalPath);
    let journal;
    try { journal = JSON.parse(bytes.toString('utf8')); } catch {
      fail(`promotion journal inventory contains invalid JSON: ${entry.name}`);
    }
    if (journal?.schema !== 'nexus.promotion-transaction-journal.v1'
        || journal.transactionId !== entry.name) {
      fail(`promotion journal inventory identity is invalid: ${entry.name}`);
    }
    if (!TERMINAL_PROMOTION_STATUSES.has(journal.status)) continue;
    if (!SHA_PATTERN.test(journal.target?.sha ?? '')) {
      fail(`promotion journal inventory target identity is invalid: ${entry.name}`);
    }
    terminal.push({
      transactionId: entry.name,
      status: journal.status,
      outcome: journal.status === 'completed' ? 'passed' : journal.status,
      runtimeSha: journal.target.sha,
      completedAt: journal.completedAt,
      completedAtMs: canonicalTimestamp(
        journal.completedAt,
        `promotion journal ${entry.name}.completedAt`,
      ),
      promotionJournalSha256: sha256(bytes),
      journal,
    });
  }
  terminal.sort((left, right) => (
    left.completedAtMs - right.completedAtMs
    || left.transactionId.localeCompare(right.transactionId)
  ));
  return { promotionRoot, terminal };
}

function evidenceReference(root, file, bytes) {
  return {
    path: path.relative(root, file).split(path.sep).join('/'),
    sha256: sha256(bytes),
  };
}

function readSignedReleaseCatalog(options = {}) {
  const root = resolveEvidenceRoot(options);
  const publicKey = trustedPublicKey(options);
  const manifests = [];
  const stagingAttestations = [];
  const protectedTimings = [];
  let visitedFiles = 0;

  const visit = (directory) => {
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
        || fs.realpathSync(directory) !== directory) {
      fail('signed release evidence catalog contains an unsafe directory');
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('signed release evidence catalog contains a symbolic link');
      }
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== '.json') continue;
      visitedFiles += 1;
      if (visitedFiles > MAX_CATALOG_FILES) {
        fail(`signed release evidence catalog exceeds ${MAX_CATALOG_FILES} JSON files`);
      }
      const stat = fs.lstatSync(file);
      if (stat.size <= 0 || stat.size > MAX_EVIDENCE_BYTES
          || fs.realpathSync(file) !== file) {
        fail('signed release evidence catalog contains an unsafe JSON file');
      }
      const bytes = fs.readFileSync(file);
      let envelope;
      try { envelope = JSON.parse(bytes.toString('utf8')); } catch { continue; }
      const reference = evidenceReference(root, file, bytes);
      if (envelope?.schema === 'nexus.release-manifest.v2') {
        manifests.push({
          reference,
          payload: verifySignedEnvelope(
            envelope,
            'nexus.release-manifest.v2',
            publicKey,
            `release manifest catalog entry ${reference.path}`,
          ),
        });
      } else if (envelope?.schema === 'nexus.staging-attestation.v1') {
        stagingAttestations.push({
          reference,
          payload: verifySignedEnvelope(
            envelope,
            'nexus.staging-attestation.v1',
            publicKey,
            `staging attestation catalog entry ${reference.path}`,
          ),
        });
      } else if (envelope?.schema === RELEASE_PROTECTED_TIMING_SCHEMA) {
        protectedTimings.push({
          reference,
          payload: verifySignedEnvelope(
            envelope,
            RELEASE_PROTECTED_TIMING_SCHEMA,
            publicKey,
            `protected timing catalog entry ${reference.path}`,
          ),
        });
      }
    }
  };
  visit(root);
  return {
    root,
    manifests,
    stagingAttestations,
    protectedTimings,
  };
}

function uniqueCatalogMatch(values, predicate, label) {
  const matches = values.filter(predicate);
  if (matches.length !== 1) {
    fail(`${label} must resolve to exactly one signed evidence file; found ${matches.length}`);
  }
  return matches[0];
}

function resultReferenceForPromotion(entry, promotionRoot) {
  const statePrefix = `transactions/${entry.transactionId}/state`;
  const relativePath = entry.status === 'completed'
    ? `${statePrefix}/result.env`
    : entry.status === 'recovered'
      ? `${statePrefix}/recovery-result.json`
      : `${statePrefix}/journal.json`;
  const file = path.join(promotionRoot, ...relativePath.split('/'));
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    fail(`promotion result ${entry.transactionId} cannot be read`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
    fail(`promotion result ${entry.transactionId} is not a safe regular file`);
  }
  const bytes = fs.readFileSync(file);
  const reference = evidenceReference(promotionRoot, file, bytes);
  readReference(
    promotionRoot,
    reference,
    `promotion result ${entry.transactionId}`,
    {
      requireJson: entry.status !== 'completed',
      requireRootOwnership: true,
      allowTestRootOwnership: entry.allowTestPromotionRoot,
    },
  );
  return { reference, bytes };
}

function readCanonicalRootEvidence(
  promotionRoot,
  relativePath,
  label,
  options,
) {
  const file = path.join(promotionRoot, ...relativePath.split('/'));
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} cannot be read`); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) {
    fail(`${label} is not a safe regular file`);
  }
  const bytes = fs.readFileSync(file);
  const reference = evidenceReference(promotionRoot, file, bytes);
  const verified = readReference(promotionRoot, reference, label, {
    requireRootOwnership: true,
    allowTestRootOwnership: options.allowTestPromotionRoot === true,
  });
  return { reference, value: verified.value };
}

function canonicalStageTimes(
  protectedTiming,
  rootStaging,
  stagingPayload,
  promotionRequest,
  journal,
  transactionId,
) {
  const stages = protectedTiming?.stages;
  const values = {
    protectedMainStartedAt: stages?.protectedMainCi?.startedAt,
    protectedMainCompletedAt: stages?.protectedMainCi?.completedAt,
    releaseCandidateStartedAt: stages?.releaseCandidate?.startedAt,
    releaseCandidateCompletedAt: stages?.releaseCandidate?.completedAt,
    signingStartedAt: stages?.protectedSigning?.startedAt,
    signingCompletedAt: stages?.protectedSigning?.completedAt,
    stagingStartedAt: rootStaging?.transaction?.startedAt,
    stagingReadinessPublishedAt: rootStaging?.transaction?.publishedAt,
    // verifiedAt is a local chronology claim created after the exact
    // candidate's authenticated/domain staging smoke. requestedAt is the
    // independently sourced GitHub workflow creation time after dispatch and
    // is therefore the authoritative staging-validation completion boundary.
    stagingVerifiedAt: stagingPayload?.verifiedAt,
    stagingCompletedAt:
      stagingPayload?.protectedSigning?.requestedAt ?? stagingPayload?.verifiedAt,
    stagingSignedAt: stagingPayload?.protectedSigning?.signedAt,
    promotionRequestCreatedAt: promotionRequest?.createdAt,
    promotionStartedAt: journal?.startedAt,
    promotionCompletedAt: journal?.completedAt,
  };
  const milliseconds = Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    canonicalTimestamp(value, `release ${transactionId} ${key}`),
  ]));
  if (!(milliseconds.protectedMainStartedAt < milliseconds.protectedMainCompletedAt
      && milliseconds.protectedMainCompletedAt <= milliseconds.releaseCandidateStartedAt
      && milliseconds.releaseCandidateStartedAt < milliseconds.releaseCandidateCompletedAt
      && milliseconds.releaseCandidateCompletedAt <= milliseconds.signingStartedAt
      && milliseconds.signingStartedAt < milliseconds.signingCompletedAt
      && milliseconds.signingCompletedAt <= milliseconds.stagingStartedAt
      && milliseconds.stagingStartedAt < milliseconds.stagingReadinessPublishedAt
      && milliseconds.stagingReadinessPublishedAt <= milliseconds.stagingVerifiedAt
      && milliseconds.stagingVerifiedAt
        <= milliseconds.stagingCompletedAt + GITHUB_REQUEST_CHRONOLOGY_TOLERANCE_MS
      && milliseconds.stagingCompletedAt <= milliseconds.stagingSignedAt
      && milliseconds.stagingSignedAt <= milliseconds.promotionRequestCreatedAt
      && milliseconds.promotionRequestCreatedAt <= milliseconds.promotionStartedAt
      && milliseconds.promotionStartedAt < milliseconds.promotionCompletedAt)) {
    fail(`release ${transactionId} cannot form the sequential observation stage contract`);
  }
  return values;
}

function passedCutover(resultBytes, journal, transactionId) {
  const result = parsePromotionResultEnv(resultBytes, `release ${transactionId} promotion result`);
  for (const name of [
    'NEXUS_SOAK_STARTED_AT',
    'NEXUS_SOAK_COMPLETED_AT',
  ]) {
    if (!result.has(name)) {
      fail(`release ${transactionId} lacks explicit root ${name} evidence`);
    }
  }
  return {
    startedAt: result.get('NEXUS_CUTOVER_STARTED_AT'),
    serviceUnavailableAt: result.get('NEXUS_SERVICE_UNAVAILABLE_STARTED_AT'),
    serviceAvailableAt: result.get('NEXUS_CANDIDATE_AVAILABLE_AT'),
    soakStartedAt: result.get('NEXUS_SOAK_STARTED_AT'),
    soakCompletedAt: result.get('NEXUS_SOAK_COMPLETED_AT'),
    completedAt: journal.completedAt,
  };
}

function recoveredCutover(resultValue, journal, transactionId) {
  if (resultValue?.schema !== 'nexus.promotion-recovery-result.v1') {
    fail(`release ${transactionId} recovery result is invalid`);
  }
  const startedAt = resultValue.originalCutoverStartedAt ?? resultValue.outageStartedAt;
  canonicalTimestamp(startedAt, `release ${transactionId} recovery cutover start`);
  canonicalTimestamp(resultValue.outageStartedAt, `release ${transactionId} outage start`);
  canonicalTimestamp(resultValue.predecessorHealthyAt, `release ${transactionId} recovery completion`);
  return {
    cutover: {
      startedAt,
      serviceUnavailableAt: resultValue.outageStartedAt,
      serviceAvailableAt: resultValue.predecessorHealthyAt,
      soakStartedAt: null,
      soakCompletedAt: null,
      completedAt: journal.completedAt,
    },
    rollback: {
      triggeredAt: resultValue.outageStartedAt,
      healthyAt: resultValue.predecessorHealthyAt,
      status: 'passed',
    },
  };
}

export function collectAuthoritativeReleaseRecords(options = {}, {
  count,
  completedOnly = false,
  requireTimingEvidence = true,
} = {}) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 20) {
    fail('release record collection count is invalid');
  }
  const inventory = readPromotionInventory(options);
  const candidates = completedOnly
    ? inventory.terminal.filter((entry) => entry.status === 'completed')
    : inventory.terminal;
  if (candidates.length < count) {
    fail(`promotion inventory contains fewer than ${count} eligible terminal records`);
  }
  const selected = candidates.slice(-count);
  const catalog = readSignedReleaseCatalog(options);
  return selected.map((entry) => {
    if (entry.status === 'recovery_failed') {
      fail(
        `release ${entry.transactionId} cannot be collected because failed recovery`
        + ' lacks a sealed healthy endpoint',
      );
    }
    const manifest = uniqueCatalogMatch(
      catalog.manifests,
      (candidate) => (
        candidate.payload?.schema === 'nexus.release-manifest-payload.v2'
        && typeof candidate.payload.packageVersion === 'string'
        && candidate.payload.runtimeSha === entry.runtimeSha
        && candidate.payload.artifact?.digest === entry.journal.target?.artifactDigest
        && candidate.payload.testPolicy?.results?.schema === 'nexus.release-test-results.v3'
        && candidate.payload.packageVersion === entry.journal.target?.version
      ),
      `release ${entry.transactionId} manifest`,
    );
    const staging = uniqueCatalogMatch(
      catalog.stagingAttestations,
      (candidate) => (
        candidate.payload?.schema === 'nexus.staging-attestation-request.v1'
        && candidate.payload.releaseManifestSha256 === manifest.reference.sha256
        && candidate.payload.runtimeSha === entry.runtimeSha
        && candidate.payload.artifactDigest === entry.journal.target?.artifactDigest
        && candidate.payload.installedRuntimeDigest === entry.journal.target?.installedRuntimeDigest
      ),
      `release ${entry.transactionId} staging attestation`,
    );
    if (!requireTimingEvidence) {
      fail(
        'authoritative collection no longer synthesizes timing; use a legacy operator window'
        + ' for manual timing evaluation',
      );
    }
    const protectedTiming = uniqueCatalogMatch(
      catalog.protectedTimings,
      (candidate) => (
        candidate.payload?.schema === RELEASE_PROTECTED_TIMING_PAYLOAD_SCHEMA
        && candidate.payload.runtimeSha === entry.runtimeSha
        && candidate.payload.releaseManifestSha256 === manifest.reference.sha256
      ),
      `release ${entry.transactionId} protected timing`,
    );
    const expectedTimingPath = `timing/${entry.runtimeSha}.json`;
    if (protectedTiming.reference.path !== expectedTimingPath) {
      fail(`release ${entry.transactionId} protected timing path is not canonical`);
    }
    const rootStaging = readCanonicalRootEvidence(
      inventory.promotionRoot,
      `staging/${staging.payload.requestId}.evidence.json`,
      `release ${entry.transactionId} root staging evidence`,
      options,
    );
    const promotionRequest = readCanonicalRootEvidence(
      inventory.promotionRoot,
      `requests/${entry.transactionId}.json`,
      `release ${entry.transactionId} promotion request`,
      options,
    );
    const times = canonicalStageTimes(
      protectedTiming.payload,
      rootStaging.value,
      staging.payload,
      promotionRequest.value,
      entry.journal,
      entry.transactionId,
    );
    const outcome = entry.outcome;
    const result = resultReferenceForPromotion({
      ...entry,
      allowTestPromotionRoot: options.allowTestPromotionRoot === true,
    }, inventory.promotionRoot);
    let cutover = null;
    let rollback = null;
    if (outcome === 'passed') {
      cutover = passedCutover(result.bytes, entry.journal, entry.transactionId);
    } else if (outcome === 'recovered') {
      let recoveryResult;
      try { recoveryResult = JSON.parse(result.bytes.toString('utf8')); } catch {
        fail(`release ${entry.transactionId} recovery result is not valid JSON`);
      }
      ({ cutover, rollback } = recoveredCutover(
        recoveryResult,
        entry.journal,
        entry.transactionId,
      ));
    }
    const reachedProduction = outcome === 'passed';
    return {
      transactionId: entry.transactionId,
      record: {
        releaseId: `v${manifest.payload.packageVersion}`,
        completedAt: entry.completedAt,
        identity: {
          evidenceRuntimeSha: manifest.payload.testPolicy.results.runtimeSha,
          manifestRuntimeSha: manifest.payload.runtimeSha,
          stagingRuntimeSha: staging.payload.runtimeSha,
          productionRuntimeSha: reachedProduction ? entry.journal.target.sha : null,
          evidenceArtifactDigest: manifest.payload.testPolicy.results.artifactDigest,
          manifestArtifactDigest: manifest.payload.artifact.digest,
          stagingArtifactDigest: staging.payload.artifactDigest,
          productionArtifactDigest: reachedProduction
            ? entry.journal.target.artifactDigest
            : null,
          stagingInstalledRuntimeDigest: staging.payload.installedRuntimeDigest,
          productionInstalledRuntimeDigest: reachedProduction
            ? entry.journal.target.installedRuntimeDigest
            : null,
        },
        timing: {
          automatedReadinessStartedAt: times.protectedMainStartedAt,
          automatedReadinessCompletedAt: times.releaseCandidateCompletedAt,
          automatedStages: [
            {
              phase: 'protected_main_ci',
              startedAt: times.protectedMainStartedAt,
              completedAt: times.protectedMainCompletedAt,
            },
            {
              phase: 'release_candidate',
              startedAt: times.releaseCandidateStartedAt,
              completedAt: times.releaseCandidateCompletedAt,
            },
            {
              phase: 'protected_signing',
              startedAt: times.signingStartedAt,
              completedAt: times.signingCompletedAt,
            },
            {
              phase: 'staging_validation',
              startedAt: times.stagingStartedAt,
              completedAt: times.stagingCompletedAt,
            },
            {
              phase: 'promotion',
              startedAt: times.promotionStartedAt,
              completedAt: times.promotionCompletedAt,
            },
          ],
          handoffs: [
            {
              phase: 'protected-main-to-rc',
              readyAt: times.protectedMainCompletedAt,
              startedAt: times.releaseCandidateStartedAt,
              approvalKind: null,
            },
            {
              phase: 'release-signing-approval',
              readyAt: times.releaseCandidateCompletedAt,
              startedAt: times.signingStartedAt,
              approvalKind: 'release_signing',
            },
            {
              phase: 'signing-to-staging',
              readyAt: times.signingCompletedAt,
              startedAt: times.stagingStartedAt,
              approvalKind: null,
            },
            {
              phase: 'staging-attestation-signing',
              readyAt: times.stagingCompletedAt,
              startedAt: times.stagingSignedAt,
              approvalKind: 'release_signing',
            },
            {
              phase: 'production-owner-approval',
              readyAt: times.stagingSignedAt,
              startedAt: times.promotionRequestCreatedAt,
              approvalKind: 'production_owner',
            },
            {
              phase: 'promotion-submit',
              readyAt: times.promotionRequestCreatedAt,
              startedAt: times.promotionStartedAt,
              approvalKind: null,
            },
          ],
          cutover,
        },
        promotion: { outcome, rollback },
        escapedReleaseDefects: 0,
        authoritativeEvidence: {
          releaseManifest: manifest.reference,
          stagingAttestation: staging.reference,
          protectedTiming: protectedTiming.reference,
          rootStagingEvidence: rootStaging.reference,
          promotionRequest: promotionRequest.reference,
          promotionJournal: {
            path: `transactions/${entry.transactionId}/state/journal.json`,
            sha256: entry.promotionJournalSha256,
          },
          promotionResult: result.reference,
        },
      },
    };
  });
}

export function referenceAuthoritativeEvidence(relativePath, options = {}) {
  const root = resolveEvidenceRoot(options);
  if (typeof relativePath !== 'string' || relativePath.length === 0
      || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    fail('authoritative evidence path must be relative');
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('authoritative evidence path escapes its root');
  }
  let stat;
  try { stat = fs.lstatSync(resolved); } catch {
    fail('authoritative evidence path cannot be read');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    fail('authoritative evidence path must be a real non-symlink file');
  }
  const bytes = fs.readFileSync(resolved);
  const reference = evidenceReference(root, resolved, bytes);
  readReference(root, reference, 'authoritative evidence reference');
  return reference;
}

export function requireAuthoritativePromotionWindows(
  currentTransactionIds,
  options = {},
  { baselineCount = 10 } = {},
) {
  if (!Array.isArray(currentTransactionIds) || currentTransactionIds.length === 0
      || currentTransactionIds.some((value) => (
        typeof value !== 'string'
        || !/^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u.test(value)
      ))) {
    fail('current promotion transaction window is invalid');
  }
  const { terminal } = readPromotionInventory(options);
  if (terminal.length < currentTransactionIds.length) {
    fail('promotion journal inventory has fewer terminal records than the current window');
  }
  const current = terminal.slice(-currentTransactionIds.length);
  if (canonicalJson(current.map((entry) => entry.transactionId))
      !== canonicalJson(currentTransactionIds)) {
    fail('observation window is not the latest consecutive terminal promotion sequence');
  }
  const baselineEnd = terminal.length - currentTransactionIds.length;
  const baselineStart = baselineEnd - baselineCount;
  return {
    current,
    baseline: baselineStart < 0 ? null : terminal.slice(baselineStart, baselineEnd),
  };
}

export function collectAuthoritativePromotionWindows(
  options = {},
  { baselineCount = 10, currentCount = 10 } = {},
) {
  if (!Number.isSafeInteger(baselineCount) || baselineCount <= 0
      || !Number.isSafeInteger(currentCount) || currentCount <= 0) {
    fail('authoritative promotion window sizes must be positive integers');
  }
  const { terminal } = readPromotionInventory(options);
  const required = baselineCount + currentCount;
  if (terminal.length < required) {
    fail(`promotion journal inventory requires at least ${required} terminal records`);
  }
  const compact = (entry) => ({
    transactionId: entry.transactionId,
    status: entry.status,
    runtimeSha: entry.runtimeSha,
    completedAt: entry.completedAt,
    completedAtMs: entry.completedAtMs,
    promotionJournalSha256: entry.promotionJournalSha256,
  });
  const selected = terminal.slice(-required);
  return {
    baseline: selected.slice(0, baselineCount).map(compact),
    current: selected.slice(baselineCount).map(compact),
  };
}

function validateQualityWindow(value, expected, label) {
  exactKeys(value, ['transactions'], label);
  if (!Array.isArray(value.transactions)
      || value.transactions.length !== expected.length) {
    fail(`${label} must contain exactly ${expected.length} transaction records`);
  }
  let total = 0;
  const transactions = value.transactions.map((entry, index) => {
    const entryLabel = `${label}.transactions[${index}]`;
    exactKeys(entry, [
      'transactionId',
      'promotionJournalSha256',
      'runtimeSha',
      'completedAt',
      'escapedReleaseDefects',
      'issueSetSha256',
    ], entryLabel);
    const authority = expected[index];
    requireIdentity(entry.transactionId, authority.transactionId, `${entryLabel}.transactionId`);
    requireIdentity(
      entry.promotionJournalSha256,
      authority.promotionJournalSha256,
      `${entryLabel}.promotionJournalSha256`,
    );
    requireIdentity(entry.runtimeSha, authority.runtimeSha, `${entryLabel}.runtimeSha`);
    requireIdentity(entry.completedAt, authority.completedAt, `${entryLabel}.completedAt`);
    requireDigest(entry.issueSetSha256, `${entryLabel}.issueSetSha256`);
    if (!Number.isSafeInteger(entry.escapedReleaseDefects)
        || entry.escapedReleaseDefects < 0
        || entry.escapedReleaseDefects > 1_000_000) {
      fail(`${entryLabel}.escapedReleaseDefects is invalid`);
    }
    total += entry.escapedReleaseDefects;
    if (!Number.isSafeInteger(total)) fail(`${label} escaped-defect total is invalid`);
    return {
      transactionId: entry.transactionId,
      escapedReleaseDefects: entry.escapedReleaseDefects,
    };
  });
  return { total, transactions };
}

export function validateAuthoritativeReleaseQualityEvidence(
  reference,
  promotionWindows,
  options = {},
) {
  if (!promotionWindows?.baseline || !Array.isArray(promotionWindows.current)) {
    fail('authoritative baseline and current promotion windows are required for quality evidence');
  }
  const root = resolveEvidenceRoot(options);
  const evidence = readReference(root, reference, 'release quality evidence');
  const payload = verifySignedEnvelope(
    evidence.value,
    RELEASE_QUALITY_EVIDENCE_SCHEMA,
    trustedPublicKey(options),
    'release quality evidence',
  );
  exactKeys(payload, [
    'schema',
    'provider',
    'query',
    'generatedAt',
    'sourceSnapshotSha256',
    'baseline',
    'current',
  ], 'release quality evidence payload');
  if (payload.schema !== RELEASE_QUALITY_EVIDENCE_PAYLOAD_SCHEMA
      || payload.provider !== 'sentry'
      || payload.query !== 'escaped-release-defects-by-release-v1') {
    fail('release quality evidence payload identity is invalid');
  }
  requireDigest(
    payload.sourceSnapshotSha256,
    'release quality evidence payload.sourceSnapshotSha256',
  );
  const generatedAt = canonicalTimestamp(
    payload.generatedAt,
    'release quality evidence payload.generatedAt',
  );
  if (generatedAt < promotionWindows.current.at(-1).completedAtMs
      || generatedAt > Date.now() + 5 * 60_000) {
    fail('release quality evidence was not generated after the current promotion window');
  }
  return {
    evidenceSha256: reference.sha256,
    generatedAt: payload.generatedAt,
    baseline: validateQualityWindow(
      payload.baseline,
      promotionWindows.baseline,
      'release quality evidence payload.baseline',
    ),
    current: validateQualityWindow(
      payload.current,
      promotionWindows.current,
      'release quality evidence payload.current',
    ),
  };
}

export function requireLatestCompletedPromotionSequence(provenances, options = {}) {
  if (!Array.isArray(provenances) || provenances.length === 0) {
    fail('completed promotion sequence is empty');
  }
  const completed = readPromotionInventory(options).terminal
    .filter((entry) => entry.status === 'completed')
    .map((entry) => ({
      transactionId: entry.transactionId,
      completedAt: entry.completedAtMs,
    }));
  completed.sort((left, right) => (
    left.completedAt - right.completedAt
    || left.transactionId.localeCompare(right.transactionId)
  ));
  if (completed.length < provenances.length) {
    fail('promotion journal inventory has fewer completed productions than the activation window');
  }
  const latest = completed.slice(-provenances.length);
  const requested = provenances.map((value) => value.transactionId);
  if (canonicalJson(latest.map((value) => value.transactionId)) !== canonicalJson(requested)) {
    fail('activation window is not the latest consecutive completed production sequence');
  }
  return latest.map((value) => ({
    ...value,
    productionSequence: completed.findIndex(
      (entry) => entry.transactionId === value.transactionId,
    ) + 1,
  }));
}
