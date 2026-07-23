import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const CURRENT_SIGNING_KEY_ID = 'github-environment-release-signing-2026-07';
const TRACKED_PUBLIC_KEY = path.resolve(
  import.meta.dirname,
  '../../docs/release/evidence/release-evidence-public-key.pem',
);
const CANONICAL_PROMOTION_ROOT = '/var/lib/nexus-release-promotion';

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

function validateManifest(record, manifest, manifestDigest, publicKey, label) {
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
  requireIdentity(payload.generatedAt, record.timing.automatedStages[2].completedAt,
    `${label}.timing.protected_signing.completedAt`);
  const protectedMain = payload.testPolicy.results.protectedMainShadow?.evidence ?? null;
  let protectedMainCompletedAt = null;
  if (protectedMain !== null) {
    if (protectedMain.schema !== 'nexus.protected-main-ci-evidence.v1'
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
  };
}

function validateStaging(record, staging, manifestIdentity, publicKey, label) {
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
  const expiresAt = canonicalTimestamp(payload.expiresAt, `${label}.stagingAttestation.payload.expiresAt`);
  const promotionStartedAt = canonicalTimestamp(
    record.timing.automatedStages[4].startedAt,
    `${label}.timing.automatedStages[4].startedAt`,
  );
  if (verifiedAt < manifestIdentity.generatedAt || verifiedAt > manifestIdentity.expiresAt
      || expiresAt <= verifiedAt || promotionStartedAt > expiresAt) {
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
  requireIdentity(payload.verifiedAt, record.timing.automatedStages[3].completedAt,
    `${label}.timing.staging_validation.completedAt`);
  requireIdentity(payload.verifiedAt, record.timing.automatedReadinessCompletedAt,
    `${label}.timing.automatedReadinessCompletedAt`);
  return { ...payload, verifiedAtMs: verifiedAt };
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
  exactKeys(record.authoritativeEvidence, [
    'releaseManifest',
    'stagingAttestation',
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
    || record.authoritativeEvidence.releaseManifest.sha256, publicKey, label);
  const stagingPayload = validateStaging(record, staging.value, manifestIdentity, publicKey, label);
  const journalValue = validateJournal(record, journal.value, stagingPayload, label);
  requireIdentity(journalValue.transactionId, journalPathMatch[1], `${label}.promotionJournal.transactionId`);
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
    automatedReadinessStartExplicit: false,
    handoffsExplicit: false,
    stageDurationsExplicit: {
      protected_main_ci: false,
      release_candidate: false,
      protected_signing: false,
      staging_validation: false,
      promotion: promotionAuthority?.promotionTimingExplicit === true,
    },
    actualUnavailabilityExplicit: promotionAuthority?.actualUnavailabilityExplicit === true,
    totalCutoverExplicit: promotionAuthority?.totalCutoverExplicit === true,
    soakExplicit: record.promotion.outcome !== 'passed'
      || promotionAuthority?.soakExplicit === true,
    actualUnavailabilityMs: promotionAuthority?.actualUnavailabilityMs ?? null,
    soakObservedMs: promotionAuthority?.soakObservedMs ?? null,
    rollbackRecoveryMs: promotionAuthority?.rollbackRecoveryMs ?? null,
  };
}
